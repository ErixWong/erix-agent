// issue #409 需求②：工具引数解析失败 ⇒ **不执行**该工具，把解析器原判词（含位置与正确形状
// 示例）作为 `is_error` 的 `tool_result` 退给模型；`invalidArguments: "execute"` 是显式回退，
// 行为**逐字等于 #409 之前**（假对象照旧塞给工具、模型看到「缺 path 参数」那种二次错误）。
//
// 本文件的用例一律走**真 provider**（`createOpenAIProvider` + `createMockFetch`）：引数文本要
// 真的经过 `openAIResponseToCanonical` → `parseToolArguments` → `tool_use` 块 → 执行层这条链，
// 手搓 canonical 块只能证明执行层那一半。零网络、零真实上游。

import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect } from "./helpers/run-direct.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createMockFetch } from "./helpers/mock-fetch.js";

const READ_FILE_SCHEMA = {
  name: "readFile",
  description: "read a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, limit: { type: "integer" } },
    required: ["path"],
  },
};

/** 一轮「模型发了坏引数」+ 一轮「模型看到结果后收尾」。 */
function malformedArgumentsScript(rawArguments) {
  return [
    {
      json: {
        choices: [{
          message: {
            tool_calls: [{
              id: "call_bad",
              type: "function",
              function: { name: "readFile", arguments: rawArguments },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    },
    {
      json: {
        choices: [{ message: { content: "我改好再试" }, finish_reason: "stop" }],
      },
    },
  ];
}

function providerFor(script) {
  const fetchImpl = createMockFetch(script);
  return {
    fetchImpl,
    provider: createOpenAIProvider({
      endpoint: "https://api.example.test",
      apiKey: "test-key",
      model: "test-model",
      fetchImpl,
    }),
  };
}

async function runOnce({ rawArguments, options = {}, executeTool }) {
  const { provider, fetchImpl } = providerFor(malformedArgumentsScript(rawArguments));
  const events = [];
  const executed = [];
  const result = await runDirect({
    provider,
    initialUserMessage: "读一下 a.txt",
    tools: [READ_FILE_SCHEMA],
    executeTool: async (call) => {
      executed.push(call.input);
      return executeTool ? executeTool(call) : "文件内容";
    },
    maxRounds: 4,
    ...options,
    // #498 S3 A23a：`completion` 并进**同一个** `config` 容器（家 `config.run.completion`）。
    // 调用方可能经 `options.config` 带来自己的 config，所以合并必须写在 `...options` **之后**
    // （并列两个 `config` 键是后者静默胜，A21 在随包契约里踩过这个坑）。
    config: { ...(options.config ?? {}), run: { ...(options.config?.run ?? {}), completion: false } },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  return { result, events, executed, fetchImpl };
}

test("默认（reject）：引数修不出来 ⇒ 工具一次都不执行，判词带解析器原话 + 位置 + 正确形状", async () => {
  // 截断类：默认规则集不补（`truncation` 默认关），所以这一条必然落到判词那一档。
  const raw = '{"path": "a.txt"';
  const { events, executed, result, fetchImpl } = await runOnce({ rawArguments: raw });

  assert.deepEqual(executed, [], "引数解析不了 ⇒ executeTool 一次都不许被调用");
  assert.equal(fetchImpl.calls.length, 2, "模型拿到判词后还要能继续跑下一轮");

  const [toolUse] = events.filter((event) => event?.type === "tool_use").map((event) => event.toolUse);
  assert.equal(typeof toolUse.erix.argumentsParseError, "object",
    "判词必须挂在 tool_use 块的 erix.argumentsParseError 上（不塞进 input）");
  assert.deepEqual(toolUse.input, { _truncatedArguments: raw, _raw: raw },
    "input 形状逐字等于今天（那个假对象本单不删）");

  const rejected = events.filter((event) => event?.type === "tool_result").map((event) => event.toolResult)[0];
  assert.equal(rejected.is_error, true);
  assert.equal(rejected.erix.executionStatus, "rejected");
  assert.deepEqual(Object.keys(rejected.erix).sort(), ["executionStatus", "toolCallKey"],
    "被拒的调用只带身份键与状态（没跑过 ⇒ 没有 round / durationMs / success）");
  assert.equal(rejected.erix.round, undefined);
  assert.equal(rejected.erix.durationMs, undefined);
  assert.equal(rejected.erix.success, undefined);
  assert.match(rejected.content, /Expected ',' or '\}' after property value in JSON at position 16/u,
    "解析器原话逐字回给模型（连位置一起）");
  assert.match(rejected.content, /第 17 个字符/u, "位置来自原文（JSON.parse 的原话是 0 基 position 16）");
  assert.match(rejected.content, /\{"path": ""\}/u,
    "正确形状示例来自工具自己的 inputSchema（有 required 就只列 required：那是「照着写就能过」的最小形状）");
  assert.match(rejected.content, /没有执行/u);
  assert.equal(result.finalText, "我改好再试");
});

test("默认（reject）：模型看到的不是「缺 path 参数」那种二次错误", async () => {
  const { events } = await runOnce({ rawArguments: '{"path": ' });
  const rejected = events.filter((event) => event?.type === "tool_result").map((event) => event.toolResult)[0];
  assert.doesNotMatch(rejected.content, /缺少 path 参数|missing required/u,
    "二次错误（工具自己报缺参数）正是本单要消灭的那一格");
});

test("默认（reject）：能修好的引数照旧执行，且块上不带判词", async () => {
  // #406 语料里那条真实需求：单引号 + Python 字面量 + 尾逗号。
  const { events, executed } = await runOnce({
    rawArguments: "{'path': 'a.txt', 'limit': 3,}",
  });
  assert.deepEqual(executed, [{ path: "a.txt", limit: 3 }], "修好后解析出来的值必须逐字等于原文那一段");
  const [toolUse] = events.filter((event) => event?.type === "tool_use").map((event) => event.toolUse);
  assert.equal(Object.hasOwn(toolUse, "erix") ? toolUse.erix.argumentsParseError : undefined, undefined,
    "修好了就没有判词");
  const [result] = events.filter((event) => event?.type === "tool_result").map((event) => event.toolResult);
  assert.equal(result.is_error, undefined);
  assert.equal(result.erix.executionStatus, undefined);
  assert.equal(result.erix.success, true);
});

test("invalidArguments: \"execute\" ⇒ 行为逐字等于今天（假对象 + 工具自己报的二次错误）", async () => {
  const raw = '{"path": "a.txt"';
  const { events, executed } = await runOnce({
    rawArguments: raw,
    // #498 S3（`run` 片 A11）：扁平 `invalidArguments` 已退役，规位是 `config.run.invalidArguments`。
    options: { config: { run: { invalidArguments: "execute" } } },
    // 工具拿假对象必然报错——这正是今天模型看到的二次错误。
    executeTool: ({ input }) => `错误：readFile 缺少 path 参数（收到 ${JSON.stringify(input)}）`,
  });
  assert.equal(executed.length, 1, "回退档必须照旧执行工具");
  assert.deepEqual(executed[0], { _truncatedArguments: raw, _raw: raw },
    "回退档传给 executeTool 的 input 必须逐字等于今天那个假对象（deepEqual，不是「大概一样」）");
  const [result] = events.filter((event) => event?.type === "tool_result").map((event) => event.toolResult);
  assert.match(result.content, /缺少 path 参数/u, "回退档保留二次错误（工具自己报的那个错）");
  assert.equal(result.is_error, undefined,
    "回退档的 is_error 与今天一样是 undefined：本仓工具把「错误」当**字符串正文**返回，引擎不判它失败");
  assert.equal(result.erix.executionStatus, undefined, "回退档不写特殊状态（与今天一致）");
  assert.equal(result.erix.success, true, "回退档里这次调用「执行成功了，只是工具自己报了个错」——与今天逐字一致");
  assert.equal(typeof result.erix.durationMs, "number", "回退档走的是正常执行路径，耗时照写");
});

test("invalidArguments 只认两个字面量：错型当场 TypeError，不静默折成默认值", async () => {
  // #498 S3（`run` 片 A11）：这一格问的是**取值**校验，所以走规位 `config.run.invalidArguments`
  // ——扁平写法本片已退役，它现在撞的是名称闸口（那条由切片钉子文件的 P1 逐字钉住），
  // 留在这里会让「错型被拒」变成「拼写被拒」，判据静默降级。
  for (const bad of ["execute-if-possible", true, null, 0]) {
    await assert.rejects(
      () => runDirect({
        provider: { async chat() { throw new Error("must not be called"); } },
        initialUserMessage: "x",
        executeTool: async () => "ok",
        config: { run: { invalidArguments: bad } },
      }),
      (error) => error instanceof TypeError && /invalidArguments must be "reject" or "execute"/.test(error.message),
      `invalidArguments=${JSON.stringify(bad)} 必须被拒（且是取值校验，不是名称闸口）`,
    );
  }
});

test("默认（reject）：判词真的喂回了模型（下一个请求里就是那块 tool_result）", async () => {
  const { events, executed, fetchImpl } = await runOnce({ rawArguments: '{"path":' });
  assert.deepEqual(executed, []);
  const rejected = events.filter((event) => event?.type === "tool_result").map((event) => event.toolResult)[0];
  assert.equal(rejected.erix.executionStatus, "rejected");
  // 判词只有经 wire 回给模型才算数：第二个请求的 messages 里必须能逐字找到它
  // （OpenAI 协议的 tool_result 落在 `role: "tool"` 消息上，按 `tool_call_id` 配对）。
  const secondRequest = fetchImpl.calls[1].body;
  const fedBack = secondRequest.messages.filter(
    (message) => message.role === "tool" && message.tool_call_id === "call_bad",
  );
  assert.equal(fedBack.length, 1, "被拒的那次调用必须有一条配对的 tool_result");
  assert.equal(fedBack[0].content, rejected.content, "wire 上的正文与事件里的正文是同一份");
  assert.match(fedBack[0].content, /正确形状/u);
});

// ── 崩溃恢复：被拒的调用不是「被打断的调用」（issue #409 的 resume 面）──────────────
//
// 为什么要这一格：`rejected`（参数写坏了）与 `interrupted`（执行到一半进程没了）是**两件事**，
// 而 resume 路径对「崩溃现场那条没结清的 pending 调用」有一套自己的处置（`replayPolicy:
// "per-tool-declaration"` 时会被改写成 interrupted 的通用文案「上次执行被打断」）。
// 被拒的调用必须**既不补跑、也不被改写成 interrupted**：模型看到的仍是同一份判词。
//
// 现场不是手搓的：先真跑一次拿到**引擎自己写下**的 `status: "rejected"` 快照（含判词原文），
// 再把账本截到快照的 `persistedTranscriptLength`（= 结果已产出、还没落账的崩溃时刻），最后 resume。

/** 真跑一次「坏引数 ⇒ 被拒」，交回引擎自己写的 rejected 快照。 */
async function rejectedCrashSnapshot(rawArguments) {
  const store = createMemoryTranscriptStore();
  const snapshots = [];
  const saveRunSnapshot = store.saveRunSnapshot.bind(store);
  store.saveRunSnapshot = async (runId, snapshot) => {
    snapshots.push(structuredClone(snapshot));
    return saveRunSnapshot(runId, snapshot);
  };
  const { provider } = providerFor(malformedArgumentsScript(rawArguments));
  let executed = 0;
  await runDirect({
    provider,
    initialUserMessage: "读一下 a.txt",
    tools: [READ_FILE_SCHEMA],
    executeTool: async () => {
      executed += 1;
      return "不该跑";
    },
    maxRounds: 4,
    config: { run: { completion: false } },
    store,
    runId: "resume-rejected",
  });
  assert.equal(executed, 0, "第一段跑：被拒的调用一次都不许执行（这一格的前提）");
  const snapshot = snapshots.find((entry) => entry.status === "rejected");
  assert.ok(snapshot, `引擎必须写下 status: "rejected" 的 run snapshot，实际状态：${JSON.stringify(snapshots.map((entry) => entry.status))}`);
  assert.equal(snapshot.pendingToolUses[0].erix.argumentsParseError.reason, "unparsable",
    "快照里的 pending 调用必须带着判词（否则这一格测的不是崩溃现场）");
  assert.equal(snapshot.toolResults[0].toolResult.erix.executionStatus, "rejected");
  return snapshot;
}

/** 账本停在快照锚点（结果已产出、还没落账），快照领先一步 —— 崩溃时刻的真实形状。 */
async function seedCrashSite(snapshot) {
  const anchor = snapshot.persistedTranscriptLength;
  assert.ok(Number.isSafeInteger(anchor) && anchor >= 2,
    `快照锚点必须已含 seed 与 assistant 正文（实测 ${anchor}）`);
  const store = createMemoryTranscriptStore();
  await store.appendRound("resume-rejected", { round: 0, messages: snapshot.messages.slice(0, 1) });
  await store.appendRound("resume-rejected", {
    round: 1,
    messages: snapshot.messages.slice(1, anchor),
  });
  await store.saveRunSnapshot("resume-rejected", { ...snapshot, persistedTranscriptLength: anchor });
  return store;
}

test("resume：崩溃现场是一条被拒的调用 ⇒ 不补跑，模型看到同一份判词而不是 interrupted 文案", async () => {
  const snapshot = await rejectedCrashSnapshot('{"path": "a.txt"');
  const verdict = snapshot.toolResults[0].toolResult.content;
  assert.match(verdict, /正确形状/u, "判词原文取自快照（下面逐字比对的就是它）");

  // 两种 replayPolicy 都跑：默认档是「照旧重放」，per-tool-declaration 档才是会把 pending 调用
  // 改写成 interrupted 的那一条 —— 后者是这一格真正的判别面。
  for (const replayPolicy of ["always-replay", "per-tool-declaration"]) {
    const store = await seedCrashSite(snapshot);
    const fetchImpl = createMockFetch([{
      json: { choices: [{ message: { content: "我改好再试" }, finish_reason: "stop" }] },
    }]);
    const executed = [];
    const result = await runToolLoop({
      provider: createOpenAIProvider({
        endpoint: "https://api.example.test",
        apiKey: "test-key",
        model: "test-model",
        fetchImpl,
      }),
      store,
      tools: [READ_FILE_SCHEMA],
      executeTool: async ({ input }) => {
        executed.push(input);
        return "不该跑";
      },
      // #498 S3（`run` 片 A11）：扁平 `replayPolicy` 已退役，规位是 `config.run.replayPolicy`。
      // #498 S3 A19：`resume` 同样退役（家 `config.run.resume`），并进**同一个** `config` 容器。
      // #498 S3 A21：`maxRounds` 同理（家 `config.run.maxRounds`），并进同一棵 `run` 子树。
      config: { run: { replayPolicy, resume: true, runId: "resume-rejected", maxRounds: 4, completion: false } },
    });

    // ① 不补跑
    assert.deepEqual(executed, [], `[${replayPolicy}] 被拒的调用在恢复后仍一次都不许执行`);
    assert.equal(fetchImpl.calls.length, 1, `[${replayPolicy}] 恢复后应当只发一次请求（模型直接收尾）`);

    // ② 模型看到的是**同一份判词**，不是 interrupted 的通用文案
    const fedBack = fetchImpl.calls[0].body.messages.filter(
      (message) => message.role === "tool" && message.tool_call_id === "call_bad",
    );
    assert.equal(fedBack.length, 1, `[${replayPolicy}] 恢复后的请求里必须恰好一条配对的 tool_result`);
    assert.equal(fedBack[0].content, verdict,
      `[${replayPolicy}] 恢复后喂回模型的必须是快照里那份判词（逐字相同）`);
    assert.doesNotMatch(fedBack[0].content, /interrupted before its outcome/u,
      `[${replayPolicy}] 「上次执行被打断」是另一件事，不许顶掉判词`);
    assert.doesNotMatch(fedBack[0].content, /was not replayed/u,
      `[${replayPolicy}] 也不许退化成「未重放」的处置文案`);
    assert.match(fedBack[0].content, /参数不是合法 JSON/u);

    // 上下文里的那一块事实仍是 rejected（不是 interrupted），且整轮上下文里没有任何 interrupted
    const restored = result.messages
      .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
      .filter((block) => block?.type === "tool_result" && block.tool_use_id === "call_bad");
    assert.equal(restored.length, 1, `[${replayPolicy}] 上下文里这条调用只该有一条结果`);
    assert.equal(restored[0].erix.executionStatus, "rejected", `[${replayPolicy}] 事实仍是 rejected`);
    assert.equal(restored[0].is_error, true);
    const statuses = result.messages
      .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
      .filter((block) => block?.type === "tool_result")
      .map((block) => block.erix?.executionStatus);
    assert.equal(statuses.includes("interrupted"), false,
      `[${replayPolicy}] 恢复后的上下文里不该出现 interrupted：${JSON.stringify(statuses)}`);

    // 恢复运行照常收尾（判词没有把 run 卡住）
    assert.equal(result.finalText, "我改好再试");
    assert.equal(result.termination.reason, "end_turn");
  }
});
