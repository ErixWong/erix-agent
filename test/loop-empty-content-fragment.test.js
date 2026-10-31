// 「空 content 片段」这一件事的**行为事实**（两张同族小单合并成一处契约，分开写会漂）。
//
// 病根（先复现，再钉住）：
//   · 契约从没写过 `content: []` 在引擎里算什么，而它两侧的答案**不同**：
//     user 侧它是「无文字片段」里唯一合法的那一种（`isRealUserTurn` 认它，纯 `tool_result`
//     载体不认）；assistant 侧它不是 user 轮，是一条**无进展轮**——引擎照常把这条空消息推进
//     模型上下文并落盘，治理层按 no-progress 记账（先有过真工具轮 ⇒ `no_tool`；一轮工具都
//     没有 ⇒ 跑满 `max_rounds_cap`）。
//   · 本文件把三件事钉成行为事实，全部用**实跑**证明，不靠读代码下结论：
//       T1 `content: []` 的落盘 + `load()` 折叠回同形状的往返（user 侧与 assistant 侧各一条）；
//       T2 `hasUserTurn` 对 `content: []` / 全空白字符串 / 空字符串 / 纯 `tool_result` 的判定；
//       T3 assistant 空 content 的实际终局：**不是** `stall`（那条要求重复的相同工具调用签名，
//          空数组产生不了签名），而是 no-progress 记账那两格。
//
// 零真实 LLM（脚本化 provider）、临时目录走 `makeTmp`、不碰 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { createFileTranscriptStore } from "../src/store/file.js";
import { hasUserTurn, isRealUserTurn } from "../src/loop/request-user-view.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { makeTmp } from "./helpers/tmp.js";

const RUN = "empty-content";

// ───────────────────────────── T1：`content: []` 的落盘 + 折叠往返

test("T1: user 侧 content:[] 落盘是字面空数组，load() 折叠回同形状", async () => {
  const dir = await makeTmp("erix-empty-content-");
  try {
    const store = createFileTranscriptStore({ dir });
    // 载体行（轮行）+ 一条消息行：与引擎写侧的两种行形状一致（工单 261021）。
    const carrier = {
      round: 1,
      dedupKey: `${RUN}:engine:round:1`,
      roundKey: `${RUN}:round:1`,
      messages: [],
    };
    const emptyUser = { role: "user", content: [] };
    const messageRow = {
      round: 1,
      seq: 0,
      kind: "message",
      dedupKey: `${RUN}:msg:1:0`,
      messages: [emptyUser],
    };
    await store.appendRound(RUN, carrier);
    await store.appendRound(RUN, messageRow);

    // ① 落盘事实：盘上那一行就是 `"content":[]`，不是被补成 `[{type:"text",text:""}]`、
    //    也不是被丢掉 content 键。
    const onDisk = await readFile(join(dir, `${RUN}.jsonl`), "utf8");
    const persisted = onDisk.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(persisted[1].messages, [{ role: "user", content: [] }]);
    assert.equal(JSON.stringify(persisted[1]).includes('"content":[]'), true);

    // ② 读侧往返：load() 把消息行折回载体行，形状与写侧逐字段相等。
    const loaded = await store.load(RUN);
    assert.deepEqual(loaded, [{ ...carrier, messages: [{ role: "user", content: [] }] }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T1: assistant 侧 content:[] 同样落盘并折叠回同形状（两侧同一个往返口径）", async () => {
  const dir = await makeTmp("erix-empty-content-");
  try {
    const store = createFileTranscriptStore({ dir });
    const carrier = {
      round: 2,
      dedupKey: `${RUN}:engine:round:2`,
      roundKey: `${RUN}:round:2`,
      messages: [],
    };
    const emptyAssistant = { role: "assistant", content: [] };
    await store.appendRound(RUN, carrier);
    await store.appendRound(RUN, {
      round: 2,
      seq: 0,
      kind: "message",
      dedupKey: `${RUN}:msg:2:0`,
      messages: [emptyAssistant],
    });
    assert.deepEqual(await store.load(RUN), [
      { ...carrier, messages: [{ role: "assistant", content: [] }] },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────── T2：hasUserTurn 到底读什么

test("T2: hasUserTurn 认 content:[]、全空白与空字符串；只拒纯 tool_result 载体", () => {
  const cases = [
    // [名字, 消息, 期望]
    ["user content:[]", { role: "user", content: [] }, true],
    ["user content:''", { role: "user", content: "" }, true],
    ["user 全空白字符串", { role: "user", content: "   \n\t " }, true],
    ["user 只有空白 text 块", { role: "user", content: [{ type: "text", text: "   " }] }, true],
    ["user 纯 tool_result 载体", {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }],
    }, false],
    ["assistant content:[]", { role: "assistant", content: [] }, false],
    ["assistant content:''", { role: "assistant", content: "" }, false],
  ];
  for (const [name, message, expected] of cases) {
    assert.equal(isRealUserTurn(message), expected, `isRealUserTurn: ${name}`);
    assert.equal(hasUserTurn([message]), expected, `hasUserTurn: ${name}`);
  }
  // 空列表仍然不是「有 user 轮」——判据是「至少一条」，不是「非纯 tool_result」的补集。
  assert.equal(hasUserTurn([]), false);
  // 「只看角色」是错的口径：同一条 assistant 消息换成 user 角色才翻转。
  assert.equal(hasUserTurn([{ role: "assistant", content: [] }, { role: "user", content: [] }]), true);
});

// ───────────────────────────── T3：assistant 空 content 的实际终局

const PAD_TOOL = {
  name: "pad",
  description: "returns a fixed result",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const executeTool = async () => ({ content: [{ type: "text", text: "pad-result" }] });

/** 脚本化 provider：记下每一次请求视图；最后一个脚本步之后重复最后一步。 */
function scriptedProvider(steps) {
  const views = [];
  let index = 0;
  const handle = async (request) => {
    views.push(request.messages.map((message) => ({ role: message.role, content: message.content })));
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return step;
  };
  return {
    views,
    protocol: "fake",
    model: "fake-model",
    async chat(request) { return handle(request); },
    async chatStream(request) { return handle(request); },
  };
}

async function runScripted(steps, { maxRounds = 6 } = {}) {
  const events = [];
  const provider = scriptedProvider(steps);
  const result = await runToolLoop({
    provider,
    tools: [PAD_TOOL],
    executeTool,
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
    config: {
      run: {
        maxRounds,
        // stall 判据**是开着的**（窗口 2、连续模式）——下面每一格仍然不是 stall：
        // 空 content 里没有任何 tool_use 块，产生不了签名。
        stallDetection: { window: 2, mode: "consecutive" },
      },
      input: {
        system: "call pad each round, then answer",
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      },
    },
  });
  return { result, events, provider };
}

const emptyToolUse = { content: [], stopReason: "tool_use" };
const emptyEndTurn = { content: [], stopReason: "end_turn" };
const toolUseOnce = {
  content: [{ type: "tool_use", id: "call-1", name: "pad", input: {} }],
  stopReason: "tool_use",
};

test("T3: assistant 空 content 命中 no-progress 记账（先有真工具轮 ⇒ no_tool），不是 stall", async () => {
  const { result, provider } = await runScripted([toolUseOnce, emptyToolUse]);
  assert.equal(result.termination.reason, "no_tool");
  // 空消息确实进了模型上下文：后续某一发请求视图里躺着一条 `assistant` + `content: []`。
  const carried = provider.views.some((view) => view.some(
    (message) => message.role === "assistant"
      && Array.isArray(message.content) && message.content.length === 0,
  ));
  assert.equal(carried, true, "assistant content:[] 没有出现在任何一次请求视图里");
});

test("T3: 一轮工具都没有时，assistant 空 content 跑满轮数 ⇒ max_rounds_cap，仍不是 stall", async () => {
  const { result } = await runScripted([emptyToolUse], { maxRounds: 4 });
  assert.equal(result.termination.reason, "max_rounds_cap");
});

test("T3: 单轮 assistant 空 content + end_turn ⇒ end_turn（终稿为空），不是 stall", async () => {
  const { result } = await runScripted([emptyEndTurn]);
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(result.finalText, "");
});
