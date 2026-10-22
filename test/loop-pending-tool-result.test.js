// issue #394：结清尾部悬空 `tool_use` 的**共享实现**（`src/loop/pending-tool-result.js`）。
//
// 本文件钉两类事实：
//   ① 结构判据（静态）：造「`is_error` 收尾 `tool_result`」的构造点全仓只有一处、配对判据只有
//      一份（R1 的 grep 判据 + R5 的「两个注入点共用同一实现」）；
//   ② 行为（R5）：兄弟洞正面、入账形状、默认关的退出码面。
// 三条注入点的行为锚在别处：#394 的强制收尾在 `test/loop-forced-final-pending-tool-use.test.js`，
// 中途扩轮 / guard 补跑桥在 `test/loop-guard-extend.test.js`。
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { PENDING_TOOL_RESULT_TEXT, runToolLoop } from "../src/loop/orchestrator.js";
import { pendingTrailingToolUses, validateMessages } from "../src/messages/rounds.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SHARED = "src/loop/pending-tool-result.js";

/** `src/` 下全部 `.js`（相对路径，正斜杠）。 */
function srcFiles(dir = "src", acc = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) srcFiles(rel, acc);
    else if (name.endsWith(".js")) acc.push(rel);
  }
  return acc;
}

const files = srcFiles().sort();
const textOf = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** 去掉注释后的源码（静态判据只看**代码**：注释里提到一个符号名不算「又写了一份实现」）。
 *  只剥整行 `//` 与 `/* … *\/` 块，行尾注释留着——多算一处只会让判据更严，不会假绿。 */
const codeOf = (rel) => textOf(rel)
  .replace(/\/\*[\s\S]*?\*\//gu, "")
  .replace(/^\s*\/\/.*$/gmu, "");

test("#394 R1 结构判据：造「is_error 收尾 tool_result」的构造点全仓只有一处（共享实现）", () => {
  // 正文常量的**定义**只有一处（`export const`，不是再导出）。
  const definitions = files.filter((rel) => (
    /export const PENDING_TOOL_RESULT_TEXT\s*=/u.test(textOf(rel))
  ));
  assert.deepEqual(definitions, [SHARED],
    "`PENDING_TOOL_RESULT_TEXT` 的定义点必须唯一（第二份正文就是第二份事实）");

  // 构造点：`buildToolResultFact({ … PENDING_TOOL_RESULT_TEXT … })`。块内没有嵌套花括号，
  // 所以这个正则正好圈住「用那条正文造结果块」的那一个调用，不会误伤普通结果构造。
  const construction = /buildToolResultFact\(\{(?:[^{}]*)PENDING_TOOL_RESULT_TEXT(?:[^{}]*)\}\)/gu;
  const sites = [];
  for (const rel of files) {
    const hits = [...textOf(rel).matchAll(construction)];
    for (let index = 0; index < hits.length; index += 1) sites.push(rel);
  }
  assert.deepEqual(sites, [SHARED],
    `「造 is_error 收尾 tool_result」的构造点必须全仓唯一，实测 ${JSON.stringify(sites)}`);
});

// ── R5-1 兄弟洞正面：`end_turn` + `tool_use` + guard 判 `revise` ⇒ 不再 reject，run 继续走 guard 流程 ──
// 形状：`stopReason:"end_turn"` 但 content 带 `tool_use`（`isEndTurn` 那条注释点名的非标准边界）
// ⇒ 不进工具执行 ⇒ 尾部悬空；reason 落到 `end_turn` ⇒ `forceFinalIfNeeded` 直接早退（不结清也不报错），
// run 正常返回。若挂了 `finalGuard` 且判 `revise`，那条续跑消息就是**下一个**注入点：修前**下一次**
// 请求在 `src/loop/provider-runner.js#callProvider`（`allowPendingToolUse:false`）以
// `invalid_messages` 崩（实测栈在 provider-runner 而不是 termination）。
const endTurnWithToolUse = (id) => ({
  content: [
    { type: "text", text: "我先看一眼目录结构，然后" },
    { type: "tool_use", id, name: "noop", input: {} },
  ],
  stopReason: "end_turn",
});

const textTurn = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });

test("#394 R5-1 兄弟洞：end_turn + 悬空 tool_use + guard 判 revise ⇒ 不再 reject，续跑请求真的发出去了", async () => {
  const provider = createFakeProvider([
    endTurnWithToolUse("t1"),
    textTurn("收尾"),
    textTurn("再收尾"),
    textTurn("还没收"),
  ]);
  let guardCalls = 0;
  const result = await runToolLoop({
    provider,
    initialUserMessage: "做点事",
    maxRounds: 3,
    executeTool: async () => "ok",
    finalGuard: async () => {
      guardCalls += 1;
      return guardCalls === 1
        ? { action: "revise", message: "请补做缺失的一步" }
        : { action: "accept" };
    },
  });

  // 核心：run 没有以 `failed / invalid_messages` 收场，而且 guard 真的走过 revise 那一格。
  assert.notEqual(result.termination.reason, "failed",
    `修前这里是 failed / invalid_messages，实得 ${JSON.stringify(result.termination)}`);
  assert.equal(result.verification.metrics.revised, 1, "guard 的第一轮裁决是 revise（前置：这一格真的走到了）");
  assert.ok(provider.requests.length >= 2,
    `revise 之后必须**真的**再发一次请求（修前它在发出去之前就崩了），实测 ${provider.requests.length}`);
  // 历史合法：悬空尾巴已结清，整份消息序通过严格配对（`allowPendingToolUse:false` 那一档）。
  assert.deepEqual(pendingTrailingToolUses(result.messages), []);
  validateMessages(result.messages);
  // 结清的那条结果紧跟它的 `tool_use`，revise 的控制文本排在它**之后**（顺序反了就是同一个洞）。
  const at = result.messages.findIndex((message) => Array.isArray(message.content)
    && message.content.some((block) => block?.type === "tool_use" && block.id === "t1"));
  assert.ok(at >= 0, "历史里必须有那条悬空的 tool_use");
  assert.equal(result.messages[at + 1]?.role, "user", "tool_use 后面必须紧跟 user 消息");
  assert.deepEqual(
    result.messages[at + 1].content.map((block) => block.tool_use_id),
    ["t1"],
    "紧跟的那条必须是补出来的 tool_result（不是 revise 的控制文本）",
  );
  assert.match(String(result.messages[at + 2]?.content?.[0]?.text ?? ""), /请补做缺失的一步/u,
    "revise 的控制文本必须排在 tool_result 之后");
});

// ── R5-2 入账形状：`:control:` 记录 + `load()` 回来仍在 `tool_use` 之后（防 resume 复发）──────────
const messagesOf = (records) => records.flatMap((record) => record.messages ?? []);
const toolResultIds = (messages) => messages.flatMap((message) => (
  Array.isArray(message?.content)
    ? message.content.filter((block) => block?.type === "tool_result").map((block) => block.tool_use_id)
    : []
));
const rowsCarrying = (records, needle) => records.filter((record) => (
  JSON.stringify(record.messages ?? []).includes(needle)
));

/** #394 的最小形状 + 一个真 store：强制收尾那一路结清，然后当场入账。 */
async function forcedFinalWithPendingTail(store, runId) {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }], stopReason: "max_tokens" },
    textTurn("收尾"),
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "做点事",
    maxRounds: 3,
    maxTokenContinuations: 0,
    executeTool: async () => "ok",
    store,
    runId,
  });
  return { result, provider };
}

test("#394 R5-2 入账形状：结清产生的 tool_result 落在 `:control:forced-final-tool-result` 行，且全档只有一条", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "394-pending-tail-row";
  const { result } = await forcedFinalWithPendingTail(store, runId);
  assert.deepEqual(result.termination, { reason: "continuation_exhausted", forcedFinal: true });

  const records = await store.load(runId);
  const carriers = rowsCarrying(records, PENDING_TOOL_RESULT_TEXT);
  assert.equal(carriers.length, 1,
    `带那条结清正文的行必须**恰好** 1 行（0 = 没入账，2 = 双喂；实测 ${JSON.stringify(records.map((record) => record.dedupKey))}）`);
  // `:control:` 行（不带 `seq` 的引擎控制行），**不是** `kind:"message"` 消息行：消息行会被
  // `foldMessageRows` 折回轮载体行，恢复时插到强制收尾那两条控制消息之前，把配对重新打散。
  assert.equal(carriers[0].kind, undefined, "结清行不许是 kind:\"message\" 消息行");
  assert.match(String(carriers[0].dedupKey),
    new RegExp(`^${runId}:engine:round:\\d+:control:forced-final-tool-result$`, "u"),
    "结清行必须是本轮 `:control:forced-final-tool-result` 行");
  // 双喂的**具体形态**是「同一条结果两行」：`forceFinalAndJournal` 的切片必须把它排除掉。
  assert.deepEqual(toolResultIds(messagesOf(records)), ["t1"],
    `全档只能有一条指向 t1 的 tool_result，实测 ${JSON.stringify(toolResultIds(messagesOf(records)))}`);
});

test("#394 R5-2 load() 顺序（file store 真落盘）：tool_use 之后紧跟的就是那条结清结果，整份历史仍合法", async () => {
  const dir = await makeTmp("erix-394-pending-tail-");
  const store = createFileTranscriptStore({ dir });
  const runId = "394-pending-tail-file";
  const { result } = await forcedFinalWithPendingTail(store, runId);
  assert.equal(result.termination.forcedFinal, true);

  const folded = messagesOf(await store.load(runId));
  // 这一条才是「resume 不会复发」的判据：`load()` 折回来的顺序必须让 `validateMessages` 通过。
  validateMessages(folded);
  const at = folded.findIndex((message) => Array.isArray(message.content)
    && message.content.some((block) => block?.type === "tool_use" && block.id === "t1"));
  assert.ok(at >= 0, "折回来的历史里必须有那条 tool_use");
  assert.deepEqual(toolResultIds([folded[at + 1]]), ["t1"],
    "折回来之后紧跟 tool_use 的必须仍是那条结清结果（顺序被打散 = resume 时以同一句 invalid_messages 崩）");
});

// ── R5-3 结构判据：两个注入点共用同一实现（R1 那条 grep 判据的测试化）────────────────────
test("#394 R5-3 结构判据：结清动作只有一份实现，且两个注入点都调它", () => {
  // ① 配对判据只有一份消费者：`pendingTrailingToolUses` 在 src/ 里只被定义处与共享实现引用
  //    （任何别处再写一遍配对逻辑 = 第二个 #394）。
  const pairingConsumers = files.filter((rel) => (
    rel !== "src/messages/rounds.js" && codeOf(rel).includes("pendingTrailingToolUses")
  ));
  assert.deepEqual(pairingConsumers, [SHARED],
    `配对判据的消费者必须只有共享实现，实测 ${JSON.stringify(pairingConsumers)}`);

  // ② 结清动作的**实现**只有一处（`export async function`），调用点只有那两个注入点所在的两个文件。
  const implementations = files.filter((rel) => (
    /export async function answerPendingTailToolUses\s*\(/u.test(codeOf(rel))
  ));
  assert.deepEqual(implementations, [SHARED], "结清动作必须只有一份实现");
  const callers = files.filter((rel) => /await answerPendingTailToolUses\(/u.test(codeOf(rel)));
  assert.deepEqual(callers.sort(), ["src/loop/orchestrator.js", "src/loop/termination.js"],
    `调用点必须恰好是那两个注入点所在的文件，实测 ${JSON.stringify(callers)}`);

  // ③ 注入点一：强制收尾（termination.js）——结清必须发生在 push 指令**之前**。
  const terminationText = codeOf("src/loop/termination.js");
  const settleInTermination = terminationText.indexOf("await answerPendingTailToolUses(");
  const injectInTermination = terminationText.indexOf("ctx.messages.push(instruction)");
  assert.ok(settleInTermination >= 0, "强制收尾那一路必须调共享实现");
  assert.ok(injectInTermination >= 0, "锚点 ctx.messages.push(instruction) 必须还在（口径失效了）");
  assert.ok(settleInTermination < injectInTermination,
    "结清必须在【强制收尾】指令 push **之前**（放到之后就还是同一个非法消息序）");

  // ④ 注入点二：orchestrator 的两处（中途扩轮/补跑桥的共享闭包 + guard 判 revise 的续跑消息）。
  const orchestratorText = codeOf("src/loop/orchestrator.js");
  const calls = [...orchestratorText.matchAll(/await answerPendingTailToolUses\(/gu)]
    .map((match) => match.index);
  assert.ok(calls.length >= 2,
    `orchestrator 里必须有两处注入点调它（applyGovernorExtension + guard-revise），实测 ${calls.length}`);
  // 扩轮/补跑桥那一处：结清在「抬上限 + 注入续跑消息」之前。
  const extendAnchor = orchestratorText.indexOf("governorState.effectiveMaxRounds = Math.min(");
  assert.ok(extendAnchor >= 0, "锚点 governorState.effectiveMaxRounds = Math.min( 必须还在（口径失效了）");
  assert.ok(calls[0] < extendAnchor, "applyGovernorExtension 里的结清必须在扩轮落地之前");
  // guard-revise 那一处：结清在 push 那条续跑消息之前（锚点用那句唯一的控制文本）。
  const reviseAnchor = orchestratorText.indexOf("text: guardDecision.message");
  assert.ok(reviseAnchor >= 0, "锚点 text: guardDecision.message 必须还在（口径失效了）");
  assert.ok(calls.at(-1) < reviseAnchor, "guard-revise 那条续跑消息之前必须先结清");
});
