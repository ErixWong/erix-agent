// issue #326（wo-B1）：**引擎自产文本的落账面**——用真引擎路径断言两类文本在产生后
// 必须出现在 `store.load()` 的原始记录里，且**恰有一条**（0 条 = 没入账，2 条 = 重复入账）。
//
// 探针实测（main `97bd957` + fake provider + 内置 store，零真实 LLM 调用，见
// `/home/eric/persist-truth-sandbox/persistence-truth-probe-261020.mjs` 与
// `/home/eric/persist-truth-sandbox/night326/baseline-probe-main-97bd957.txt`）：
//   - 正常轮里的 judge advisory：模型 1 / 返回 1 / journal 1  ⇒ **本来就对**，本文件只做「别改成 2」的守卫；
//   - **强制收尾（forced final）产生的终稿 assistant 消息**：模型/返回 1 / journal 0；
//   - **引擎注入的纯文本提示**（`meta.source === "judge-control"`：judge 评审意见 nudge、
//     扩轮续跑提示、finalGuard revise 意见、强制收尾指令）：模型 1 / 返回 1 / journal 0。
//
// 结构成因（读源码所得，不是猜测）：轮记录只在轮末写一次
// （`orchestrator.js` 的 `record.messages = messages.slice(roundStart)`），而
// `roundStart = messages.length` 是在**下一次进圈**时重新取值的 ⇒ 凡是在本轮 persist
// **之后**才 push 进 `messages` 的消息（judge nudge / extend / finalGuard revise /
// 强制收尾指令与终稿）永远落在「本轮记录已写完」与「下一轮 roundStart 已跳过它」之间，
// 谁都不包含它 ⇒ 模型看得见、档案里没有。
//
// 判据口径：一律数 `store.load()` 返回的**原始记录里的 message 文本**，不看事件流、不看返回值。
import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

const text = (value) => ({ type: "text", text: value });
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { step: id } });
const tools = [{ name: "work", replay: "unsafe", inputSchema: { type: "object" } }];
const judgeJson = (decision) => ({ content: [text(JSON.stringify(decision))], stopReason: "end_turn" });
const endTurn = (value) => ({ content: [text(value)], stopReason: "end_turn" });
const toolTurn = (id) => ({ content: [toolUse(id)], stopReason: "tool_use" });

const messagesOf = (records) => records.flatMap((record) => record.messages ?? []);
// 「恰有一条」的唯一口径：原始记录里含该子串的 text block 所在**消息**条数。
const countIn = (messages, needle) => messages.filter((message) => (
  Array.isArray(message?.content)
  && message.content.some((block) => block?.type === "text" && String(block.text ?? "").includes(needle))
)).length;
const fingerprints = (messages) => messages.map((message) => JSON.stringify(message));
// 反证用：journal 里出现两次以上的同一条消息（重复入账）。
const duplicated = (messages) => {
  const seen = new Map();
  for (const fingerprint of fingerprints(messages)) {
    seen.set(fingerprint, (seen.get(fingerprint) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, times]) => times > 1);
};

const baseOptions = {
  tools,
  completion: false,
  wrapup: false,
  stallDetection: false,
  executeTool: async () => "ok",
};

test("#326-B1 强制收尾终稿：产生后 store.load() 里恰有一条（memory store）", async () => {
  const marker = "PERSIST_TRUTH_326_FORCED_FINAL";
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([toolTurn("last"), endTurn(marker)]);
  const result = await runToolLoop({
    ...baseOptions, maxRounds: 1, store, runId: "326-ff",
    initialUserMessage: "local task", provider, reflection: false,
  });

  // 前置：这真的是一次强制收尾终稿（否则下面「恰有一条」是空断言）。
  assert.equal(result.termination.reason, "max_rounds_cap");
  assert.equal(result.termination.forcedFinal, true);
  assert.equal(countIn(result.messages, marker), 1, "终稿必须出现在返回消息里（探针已实测，别改坏）");
  assert.equal(countIn(provider.requests.at(-1).messages, "【强制收尾】"), 1,
    "强制收尾指令必须进过主模型上下文（探针实测模型 1）");

  const records = await store.load("326-ff");
  assert.equal(countIn(messagesOf(records), marker), 1,
    `强制收尾终稿必须在 journal 里恰有一条（实测 ${JSON.stringify(records.map((r) => r.dedupKey ?? r.roundKey))}）`);
  assert.deepEqual(duplicated(messagesOf(records)), [], "journal 不得因本次修复出现重复行");
});

test("#326-B1 强制收尾终稿：file store（真落盘 JSONL）里也恰有一条", async () => {
  const marker = "PERSIST_TRUTH_326_FORCED_FINAL_FILE";
  const dir = await makeTmp("erix-326-ff-file-");
  const store = createFileTranscriptStore({ dir });
  const provider = createFakeProvider([toolTurn("last"), endTurn(marker)]);
  const result = await runToolLoop({
    ...baseOptions, maxRounds: 1, store, runId: "326-ff-file",
    initialUserMessage: "local task", provider, reflection: false,
  });
  assert.equal(result.termination.forcedFinal, true);

  const records = await store.load("326-ff-file");
  assert.equal(countIn(messagesOf(records), marker), 1, "真落盘的 transcript 必须含且只含一条终稿");
  assert.deepEqual(duplicated(messagesOf(records)), [], "journal 不得出现重复行");
});

test("#326-B1 强制收尾指令（引擎注入的纯文本 judge-control）：journal 里恰有一条", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([toolTurn("last"), endTurn("收尾终稿")]);
  const result = await runToolLoop({
    ...baseOptions, maxRounds: 1, store, runId: "326-ff-instruction",
    initialUserMessage: "local task", provider, reflection: false,
  });
  assert.equal(result.termination.forcedFinal, true);

  const records = await store.load("326-ff-instruction");
  assert.equal(countIn(messagesOf(records), "【强制收尾】"), 1,
    "强制收尾指令是引擎注入的纯文本 judge-control 消息，必须在产生的那一刻入账");
  assert.deepEqual(duplicated(messagesOf(records)), [], "journal 不得出现重复行");
});

test("#326-B1 judge 评审意见（nudge，纯文本 judge-control）：journal 里恰有一条", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    endTurn("第一轮中间结论"),
    endTurn("第二轮收尾结论"),
  ]);
  const judge = createFakeProvider([
    judgeJson({ done: false, confidence: 1, reason: "MARKER_326_NUDGE", evidence: "本地证据", direction: "on_track" }),
    judgeJson({ done: true, confidence: 0.95, reason: "已达成", evidence: "本地证据", direction: "on_track" }),
  ]);
  const result = await runToolLoop({
    ...baseOptions, maxRounds: 6, store, runId: "326-nudge",
    initialUserMessage: "local task", provider,
    reflection: { enabled: true, roundJudge: true, judgeIntercept: false, judge: { provider: judge } },
  });

  // 前置：判定语义没变（评审未达成 ⇒ nudge 续跑，达成 ⇒ judge_done 收尾）。
  assert.equal(result.termination.reason, "judge_done");
  assert.equal(countIn(provider.requests.at(-1).messages, "MARKER_326_NUDGE"), 1,
    "评审意见必须进主模型上下文（探针实测模型 1）");
  assert.equal(countIn(result.messages, "MARKER_326_NUDGE"), 1);

  const records = await store.load("326-nudge");
  assert.equal(countIn(messagesOf(records), "MARKER_326_NUDGE"), 1,
    "评审意见必须在产生的那一刻入账，且只有一条");
  assert.deepEqual(duplicated(messagesOf(records)), [], "journal 不得出现重复行");
});

test("#326-B1 扩轮续跑提示（extend，纯文本 judge-control）：journal 里恰有一条", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    endTurn("第一轮中间结论"),
    endTurn("扩轮后结论"),
  ]);
  const judge = createFakeProvider([
    judgeJson({
      done: false, confidence: 0.5, extend: true, extendReason: "MARKER_326_EXTEND",
      reason: "还在做", evidence: "证据", direction: "on_track",
    }),
    judgeJson({ done: true, confidence: 0.95, reason: "达成", evidence: "证据", direction: "on_track" }),
  ]);
  const result = await runToolLoop({
    ...baseOptions, maxRounds: 2, store, runId: "326-extend",
    initialUserMessage: "local task", provider,
    reflection: {
      enabled: true, roundJudge: true, judgeIntercept: false,
      extensionStep: 2, maxExtensions: 2, judge: { provider: judge },
    },
  });

  assert.equal(result.termination.reason, "judge_done", "扩轮后判定语义不变");
  assert.equal(countIn(provider.requests.at(-1).messages, "MARKER_326_EXTEND"), 1,
    "续跑提示必须进主模型上下文");

  const records = await store.load("326-extend");
  assert.equal(countIn(messagesOf(records), "MARKER_326_EXTEND"), 1,
    "续跑提示必须在产生的那一刻入账，且只有一条");
  assert.deepEqual(duplicated(messagesOf(records)), [], "journal 不得出现重复行");
});

test("#326-B1 finalGuard revise 意见（纯文本 judge-control）：journal 里恰有一条", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([endTurn("第一版结论"), endTurn("第二版结论")]);
  let guardCalls = 0;
  const result = await runToolLoop({
    ...baseOptions, maxRounds: 6, store, runId: "326-revise",
    initialUserMessage: "local task", provider,
    finalGuard: async () => {
      guardCalls += 1;
      return guardCalls === 1
        ? { action: "revise", message: "MARKER_326_REVISE 请补充证据" }
        : { action: "accept" };
    },
  });

  assert.equal(result.termination.reason, "end_turn", "revise 后终局仍是 end_turn（判定语义不变）");
  assert.equal(countIn(provider.requests.at(-1).messages, "MARKER_326_REVISE"), 1);

  const records = await store.load("326-revise");
  assert.equal(countIn(messagesOf(records), "MARKER_326_REVISE"), 1,
    "revise 意见必须在产生的那一刻入账，且只有一条");
  assert.deepEqual(duplicated(messagesOf(records)), [], "journal 不得出现重复行");
});

test("#326-B1 守卫：正常轮的 judge advisory 仍恰有一条（既不许 0 也不许被改成 2）", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    { content: [toolUse("a1"), toolUse("a2")], stopReason: "tool_use" },
    endTurn("结论"),
  ]);
  await runToolLoop({
    ...baseOptions, maxRounds: 6, store, runId: "326-advisory",
    initialUserMessage: "local task", provider,
    reflection: {
      enabled: true, roundJudge: false, judgeIntervalRound: 1, judgeDoneAdvisory: true,
      judge: { provider: createFakeProvider([
        judgeJson({ done: true, confidence: 1, reason: "MARKER_326_ADVISORY", evidence: "本地", direction: "on_track" }),
      ]) },
    },
  });

  const records = await store.load("326-advisory");
  assert.equal(countIn(messagesOf(records), "MARKER_326_ADVISORY"), 1,
    "advisory 在基线里已入账 1 条；本次修复不得把它变成 0 或 2");
  assert.deepEqual(duplicated(messagesOf(records)), [], "journal 不得出现重复行");
});
