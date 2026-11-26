// issue #930：上下文超窗该有一次有界自恢复。
//
// 背景（票面事实，已复核）：`classifyHttpError` 把 400/422 一律归成不可重试的 `invalid_request`，
// 而真实「上下文超窗」在上游也是 400，只是 body 里写着 `context_length_exceeded` /
// `maximum context length` / `is longer than configured context length` 一类字样 ⇒ 一个本来压
// 一次就能继续的 run 被判成不可恢复失败。本文件钉三件事：① 分类 ② 一次有界自恢复 ③ 账本留痕。
//
// 子串清单来源：**不是凭记忆编**——照抄本仓既有同源正则 `src/compact/fold-llm.js:567`
// （`classifyFoldDegradeKind`），真机样本见 `docs/issue-469-470-fix-plan.md:165`。本文件第 ① 格
// 之外另钉「两处清单逐字同源」这条不变量（见文件末尾）。
import test from "node:test";
import assert from "node:assert/strict";

import { classifyHttpError, isContextWindowExceededBody, KitError } from "../src/providers/errors.js";
import { classifyFoldDegradeKind } from "../src/compact/fold-llm.js";
import { directError, runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { groupIntoRounds } from "../src/messages/rounds.js";
import { estimateMessageTokens } from "../src/tokens.js";
import {
  CONTEXT_WINDOW_EXCEEDED_RECOVERY_ATTEMPTS,
  CONTEXT_WINDOW_EXCEEDED_COMPACTION_TRIGGER,
} from "../src/loop/orchestrator.js";
import { normalizeCompactionStats } from "../src/compact/pipeline.js";

// —— 上游真机字样的样本（本地 relay / OpenAI / Anthropic 一族），逐条应判成超窗 ——
const CONTEXT_WINDOW_BODIES = [
  // OpenAI 一族（票面点名）。
  JSON.stringify({
    error: {
      message: "This model's maximum context length is 8191 tokens. However, your messages resulted in 9021 tokens.",
      type: "invalid_request_error",
      code: "context_length_exceeded",
    },
  }),
  // 本地 relay 真机样本（docs/issue-469-470-fix-plan.md:165 原样）。
  '400 message = input length `16584` is longer than configured context length `16384`',
  // 网关族 `context window` 措辞。
  JSON.stringify({ error: { message: "Input exceeds the model context window." } }),
];

// —— 普通 400：不得吞进超窗这条路（保持 invalid_request 不可重试）——
const PLAIN_BAD_REQUEST_BODIES = [
  JSON.stringify({ error: { message: "invalid json in request body" } }),
  JSON.stringify({ error: { message: "temperature must be between 0 and 2" } }),
];

// —— ① 分类：400/422 + 超窗字样 ⇒ context_window_exceeded / **同一个请求不可重试** ——
test("① classifyHttpError：400/422 命中超窗字样 ⇒ context_window_exceeded、retryable false（同一个请求不可原样重试）", () => {
  for (const body of CONTEXT_WINDOW_BODIES) {
    for (const status of [400, 422]) {
      const err = classifyHttpError(status, body);
      assert.equal(err.code, "context_window_exceeded", `code for status ${status}`);
      // P2：`context_window_exceeded` 不再被置成可重试——错的是这份请求的**大小**，不是网络抖动。
      // `RETRYABLE_CODES` 不含它 ⇒ `retryable: false`；原样重发只会把同一坨再撞一次窗口。
      // 可重试的是「压缩之后的新请求」，那是 orchestrator 自恢复分支按错误码负责的（另一格钉）。
      assert.equal(err.retryable, false, `retryable for status ${status}`);
      assert.equal(err.status, status);
      assert.ok(isContextWindowExceededBody(body));
    }
  }
});

// —— ④ 普通 400：仍是 invalid_request、不可重试、不吞 ——
test("④ classifyHttpError：普通 400（无超窗字样）仍是 invalid_request、retryable false", () => {
  for (const body of PLAIN_BAD_REQUEST_BODIES) {
    const err = classifyHttpError(400, body);
    assert.equal(err.code, "invalid_request");
    assert.equal(err.retryable, false);
    assert.equal(isContextWindowExceededBody(body), false);
  }
});

// —— 一次有界自恢复的公共夹具 ——

// 一次性配额的常量值：本单硬约束「只给一次」。
test("②/③ 前置：自恢复配额常量 = 1（写进常量而非散落魔法数）", () => {
  assert.equal(CONTEXT_WINDOW_EXCEEDED_RECOVERY_ATTEMPTS, 1);
});

// 「恰好一次压缩」的计数折叠策略（宿主自带的 LLM 折叠策略，走 capabilities.ports.strategy）。
// 它真的干活：`compact` 折走最老一轮，形状同 sliding-window / 参考
// test/compaction-strategy-fallback.test.js#createHostStrategy。#898：不许退回机械摘要 ⇒ 断言用的是这个策略。
function createCountingStrategy() {
  const tally = { shouldCompact: 0, compact: 0, compactedRounds: 0, lastBudgetTokens: null };
  return {
    name: "counting-llm-strategy",
    tally,
    async shouldCompact(_messages, budgetTokens) {
      tally.shouldCompact += 1;
      tally.lastBudgetTokens = budgetTokens;
      return false; // 预算轮不主动要求折（隔离出「只有超窗自恢复才折」这一条路径）
    },
    async compact(messages, options = {}) {
      tally.compact += 1;
      tally.lastBudgetTokens = options.budgetTokens ?? null;
      const tokensBefore = estimateMessageTokens(messages);
      const offset = Number.isSafeInteger(options.roundOffset) ? options.roundOffset : 0;
      const { head, rounds } = groupIntoRounds(messages);
      if (rounds.length === 0) {
        return {
          messages, compacted: false, foldedRounds: 0, foldedPayload: [],
          tokensBefore, tokensAfter: tokensBefore,
        };
      }
      const folded = rounds.slice(0, 1);
      const retained = rounds.slice(1);
      const foldedPayload = folded.flatMap((r) => r.messages).map((m) => ({ ...m }));
      const compactedMessages = [...head, ...retained.flatMap((r) => r.messages)];
      tally.compactedRounds += folded.length;
      return {
        messages: compactedMessages,
        compacted: true,
        foldedRounds: folded.length,
        foldedPayload,
        foldedRoundRange: { from: offset + 1, to: offset + folded.length },
        tokensBefore,
        tokensAfter: estimateMessageTokens(compactedMessages),
      };
    },
  };
}

// 播一轮完整历史（user→assistant[tool_use]→tool_result），让自恢复那一发有轮可折。
function seededRoundMessages() {
  return [
    { role: "user", content: [{ type: "text", text: `开工 ${"x".repeat(200)}` }] },
    { role: "assistant", content: [{ type: "tool_use", id: "seed-1", name: "work", input: { i: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "seed-1", content: `结果 ${"y".repeat(200)}` }] },
  ];
}

function cwError(status = 400) {
  // P2：超窗分类后 `retryable: false`——同一个超大请求不可原样重试（只有压缩后的新请求可）。
  // 自恢复分支按**错误码** catch，不依赖这个 flag，所以这里照抄分类器的真实形状。
  return new KitError("context_window_exceeded", "maximum context length is 8191 tokens", {
    retryable: false,
    status,
  });
}

function invalidRequestError() {
  return new KitError("invalid_request", "invalid json in request body", { retryable: false, status: 400 });
}

// `baseOptions` 把折叠策略与事件钩子都装进 `capabilities` 容器内部（`ports.strategy` /
// `hooks.onEvent`）——这是它们的 canonical 家，也顺带避开 `flat-count-inventory` 的扁平写点面
// （容器里的同名叶子是规位写法，不计数）。
function baseOptions(foldStrategy, eventSink) {
  return {
    provider: null,
    executeTool: async () => "done",
    config: {
      run: { maxRounds: 6, completion: false, reflection: false, stallDetection: false },
      input: { messages: seededRoundMessages() },
      metadata: { modelMetadata: { contextWindowTokens: 4096, maxOutputTokens: 512 } },
      folding: { context: { budgetTokens: 1200, keepRounds: 1 } },
    },
    capabilities: {
      ports: { strategy: foldStrategy },
      ...(eventSink === undefined ? {} : { hooks: { onEvent: eventSink } }),
    },
    store: createMemoryTranscriptStore(),
    runId: "930-run",
  };
}

// —— ② 第一次 400 超窗 ⇒ 恰好一次压缩 ⇒ 第二次请求成功 ⇒ run 正常收尾 ——
test("② 超窗自恢复：一发 400 ⇒ 恰好一次压缩 ⇒ 重试成功 ⇒ run 正常收尾", async () => {
  const strategy = createCountingStrategy();
  const provider = createFakeProvider([
    { throw: cwError(400) },
    { content: [{ type: "text", text: "收尾完成" }], stopReason: "end_turn" },
  ]);
  const events = [];
  const options = baseOptions(strategy, (e) => events.push(e));
  options.provider = provider;

  const result = await runDirect(options);

  // 恰好一次压缩（策略只被折一次）。
  assert.equal(strategy.tally.compact, 1, "strategy.compact 应恰好一次");
  // 那一发走的是已装配策略（LLM），不是机械兜底：策略名进账本。
  const compactions = (result.compactionStats ?? []).filter((s) => s?.trigger === CONTEXT_WINDOW_EXCEEDED_COMPACTION_TRIGGER);
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].strategyName, "counting-llm-strategy");
  // 两次 provider 调用（首发 400 + 重试成功），run 正常收尾（非 failed）。
  assert.equal(provider.requests.length, 2);
  assert.ok(result, "自恢复成功 ⇒ run 应正常返回（不抛错）");
  assert.notEqual(result?.termination?.reason, "failed", "收尾不得是 failed");
  assert.equal(compactions[0].compacted, true);
});

// —— ③ 连续两次 400 超窗 ⇒ 不再尝试第三次 ⇒ run failed 并点名超窗 ——
test("③ 连续两次 400 超窗 ⇒ 只自恢复一次、不再重试第三次 ⇒ failed 点名超窗", async () => {
  const strategy = createCountingStrategy();
  const provider = createFakeProvider([
    { throw: cwError(400) }, // 首发超窗
    { throw: cwError(400) }, // 压缩后重试仍超窗
    { content: [{ type: "text", text: "不该被请求到" }], stopReason: "end_turn" }, // 第三次不该发生
  ]);
  const options = baseOptions(strategy);
  options.provider = provider;

  const error = await directError(options);

  assert.ok(error, "run 应以抛错收尾");
  assert.equal(error.code, "context_window_exceeded", "终局错误码点名超窗");
  assert.equal(error.termination?.reason, "failed");
  assert.equal(error.termination?.errorCode, "context_window_exceeded");
  // 只自恢复一次：压缩恰好一次、provider 恰好两次（不再第三次）。
  assert.equal(strategy.tally.compact, 1, "只允许一次强制压缩");
  assert.equal(provider.requests.length, 2, "第二次还超 ⇒ 不再尝试第三次请求");
});

// —— P2：轮内 provider 重试不得对超窗请求生效 ——
// 开了轮内重试（`retry.attempts: 2`）也不得把同一个超大请求原样重发：
// `context_window_exceeded` 的 `retryable: false` 让 `provider-runner` 立即抛出（不在轮内重发），
// 错误才能递到 orchestrator 的自恢复分支去压缩。若错误被误标 `retryable: true`，provider-runner
// 会把同一个超大请求在轮内重发到成功那一格“碰运气”吸收掉 ⇒ 根本不会压缩（compact 会停在 0）。
test("P2 轮内 provider 重试不得对超窗请求生效（开了重试仍必须走自恢复压缩、不原样重发）", async () => {
  const strategy = createCountingStrategy();
  // 用真的分类器产物（而非手拼 KitError），它的 `retryable` 就是分类后的值（现在 false）。
  const realCw = classifyHttpError(400, CONTEXT_WINDOW_BODIES[0]);
  assert.equal(realCw.retryable, false, "前置：分类后的超窗错必须不可重试");
  const provider = createFakeProvider([
    { throw: realCw },
    { content: [{ type: "text", text: "压缩后重试成功" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "不该被请求到" }], stopReason: "end_turn" },
  ]);
  const options = baseOptions(strategy);
  options.provider = provider;
  // 显式开启轮内重试（它的家是 `config.timing.retry`，不是顶层扁平 `retry`）：attempts 2，backoff 置 0。
  // 若超窗错被误标可重试，同一个超大请求会被原样重发。
  options.config.timing = { retry: { attempts: 2, backoffBaseMs: 0, backoffMaxMs: 0 } };

  const result = await runDirect(options);

  // 自恢复那一发压缩**必须发生**：证明 provider-runner 没有在轮内把超窗错吸收掉。
  assert.equal(strategy.tally.compact, 1, "超窗请求必须递到自恢复压缩（轮内重试不得吸收）");
  // 超大请求只被发了一次（失败那一发）；重试那一发是压缩后的新请求。
  assert.equal(provider.requests.length, 2, "首发 + 压缩后重试一发；不得有轮内原样重发");
  assert.notEqual(result?.termination?.reason, "failed", "自恢复后应正常收尾");
  // 那一发压缩是超窗自恢复带来的（不是预算折叠）。
  const compactions = (result.compactionStats ?? []).filter((s) => s?.trigger === CONTEXT_WINDOW_EXCEEDED_COMPACTION_TRIGGER);
  assert.equal(compactions.length, 1, "账本上必须有且仅有一条超窗自恢复留痕");
});

// —— ④ 普通 400 ⇒ 零压缩、零重试、直接失败 ——
test("④ 普通 400（无超窗字样）⇒ 零压缩、零重试、run 以 invalid_request 失败", async () => {
  const strategy = createCountingStrategy();
  const provider = createFakeProvider([
    { throw: invalidRequestError() },
    { content: [{ type: "text", text: "不该被请求到" }], stopReason: "end_turn" },
  ]);
  const options = baseOptions(strategy);
  options.provider = provider;

  const error = await directError(options);

  assert.ok(error);
  assert.equal(error.code, "invalid_request");
  assert.equal(error.termination?.reason, "failed");
  assert.equal(strategy.tally.compact, 0, "普通 400 不该触发压缩");
  assert.equal(provider.requests.length, 1, "普通 400 不该重试");
});

// —— ⑤ 账本上真的有那条留痕（不是只发事件）——
test("⑤ 账本留痕：compactionStats 里有 trigger=context_window_exceeded 的记录，且能过 state 重建", async () => {
  const strategy = createCountingStrategy();
  const provider = createFakeProvider([
    { throw: cwError(400) },
    { content: [{ type: "text", text: "收尾完成" }], stopReason: "end_turn" },
  ]);
  const events = [];
  const options = baseOptions(strategy, (e) => events.push(e));
  options.provider = provider;

  const result = await runDirect(options);

  // 内存态账本直读：顶层 trigger。
  const stat = (result.compactionStats ?? []).find((s) => s?.trigger === "context_window_exceeded");
  assert.ok(stat, "compactionStats 必须有带 trigger 的留痕记录");
  // 不是只发事件：账本那份与事件那份都在。
  assert.ok(events.some((e) => e.type === "compaction" && e.compaction?.trigger === "context_window_exceeded"),
    "compaction 事件也应带 trigger");
  // 过 `normalizeCompactionStats`（state.json 重读）仍可见：**同一个 trigger 键**自己就留得住
  // ——它是 `createCompactionStat` 的一等可选字段，`normalizeCompactionStats` 会把它透传重建。
  // （早期原型靠镜像进 `foldSummary.degradeReason` 绕道，那是在 trigger 还不是一等字段时的事；
  // 现在镜像已删，`degradeReason` 仍归机械降级原因，两件事不再混在一个键里。）
  const rebuilt = normalizeCompactionStats(result.compactionStats ?? []);
  assert.equal(
    rebuilt.find((s) => s?.trigger === "context_window_exceeded")?.trigger,
    "context_window_exceeded",
    "state.json 重建后 trigger 必须还在",
  );
  assert.equal(
    stat.foldSummary?.degradeReason,
    undefined,
    "degradeReason 只归机械降级原因，不再被超窗留痕借用",
  );
});

// —— 同源不变量：errors.js 与 fold-llm.js 的超窗清单逐字一致（改一处要同步另一处）——
test("同源不变量：errors.js 的子串判定与 fold-llm.js 的归因同一把尺子", () => {
  const probes = [
    ...CONTEXT_WINDOW_BODIES,
    "maximum context length exceeded",
    "context_length_exceeded",
    "this is over the ContextWindowExceeded limit",
    "is longer than configured context length",
    "too many tokens in input",
    "input length 123",
    ...PLAIN_BAD_REQUEST_BODIES,
    "some unrelated server hiccup",
  ];
  for (const probe of probes) {
    assert.equal(
      isContextWindowExceededBody(probe),
      classifyFoldDegradeKind(new Error(probe)) === "context_window_exceeded",
      `判定不一致：${probe.slice(0, 40)}`,
    );
  }
});
