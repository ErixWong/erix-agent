// issue #401 R3：**resume 侧的折叠免疫**。宿主自己的 `TranscriptStore` 折不折，引擎都给同一份时间线。
//
// 背景（工单 #401 已实测的四条事实）：折叠义务在宿主侧（`load()` 必须返回折叠形状），而 packed install
// 里宿主**拿不到** `foldMessageRows`，契约套件也**不测**折叠 ⇒ erix-station 那类自研 store 全绿却没折。
// R1 把折叠函数导成公共 API、R2 让契约套件能红；R3 是引擎自己的兜底：`restoreResume`
// （`src/loop/resume-manager.js`）对 `store.load()` 的返回值**再折一次**。
//
// 三种宿主形状各钉一条（三种不同的坏法，判据不能合并）：
//   ① 宿主没折（`load()` 原样返回落盘行）⇒ resume 必须自己折出来：该轮工具调用状态是 `[ok]` 而不是
//      `[pending]`（`tool_result` 与 `tool_use` 折回同一条记录才能配对），写过的文件不重复计。
//   ② 宿主折对了（内置 store）⇒ 与今天**逐字一致**（回归锚：正文序列、时间线、写过的文件三份字面量；
//      2026-10-23 在本树上用同一段脚本对 `52e7420` 的 `src/` 跑过一遍，除 `toolCallKey` 哈希与
//      `durationMs` 两个非确定位外逐字相同）。
//   ③ 宿主「两份都留」（折好的载体 + 原始消息行）⇒ 正文条数**不翻倍**（守卫：该轮载体已带这一轮的
//      正文 ⇒ 该轮跳过，见 `src/store/message-rows.js#foldMessageRows` 的 JSDoc「守卫」一段）。
//
// ①②③ 的正文必须**彼此逐字相同**——免疫不能靠「折得更多」，只能靠「折得一样」。
import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect } from "./helpers/run-direct.js";
import { RESUME_NOTICE_TAG } from "../src/loop/resume-notice.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { foldMessageRows } from "../src/store/message-rows.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// 写类工具的入参路径（工具本身是假的，不落盘）：刻意不用 `/tmp` 字面量，临时目录的规矩见
// `test/helpers/tmp.js`；这里只需要一个「像路径」的字符串进治理时间线。
const GOVERNED_WRITE_PATH = "ledger/governed.txt";

const WRITE_FILE_TOOL = {
  name: "writeFile",
  description: "write a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
  },
};

const judgeResponse = (payload) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  stopReason: "end_turn",
});

const promptTextOf = (provider) => provider.requests
  .map((request) => (request.messages ?? []).map((message) => (
    Array.isArray(message?.content)
      ? message.content.map((block) => block?.text ?? "").join("")
      : String(message?.content ?? "")
  )).join("\n"))
  .join("\n");

/** 把消息序列压成「角色:块」的可比字面量（不带 `toolCallKey` / `durationMs` 这些非确定位）。 */
const describeMessages = (messages) => messages.map((message) => {
  const blocks = Array.isArray(message?.content)
    ? message.content
    : [{ type: "text", text: String(message?.content ?? "") }];
  const rendered = blocks.map((block) => {
    if (block?.type === "text") return block.text;
    if (block?.type === "tool_use") return `tool_use(${block.name})`;
    if (block?.type === "tool_result") {
      return `tool_result(${typeof block.content === "string" ? block.content : JSON.stringify(block.content)})`;
    }
    return String(block?.type ?? "?");
  }).join("+");
  return `${message?.role}:${rendered}`;
});

// 账本正文的「今天」形状（三条路必须逐字相同）：round 0 种子 → R1 的 assistant（正文 + 工具调用）
// → R1 那条聚合 tool_result → R2 的 assistant（收尾）。
//
// issue #404（复活赛告示）：第 4 条从 `assistant:收尾+续接完成` 变成 `assistant:收尾`。**这不是内容变化，
// 是形状位移**：恢复运行会在「账本正文」与「续接轮的正文」之间注入一条 **user** 控制消息（告示），
// 于是原先「`收尾`(assistant) 与 `续接完成`(assistant) 相邻 ⇒ `normalizeMessages` 把两条并成一条」
// 这个纯形状效应不再成立，两段正文各自成条。位移前后的逐条对照（同一段脚本、同一份 fake provider）：
//   位移前（`eb158ad`）：7 条，`[3] assistant:收尾+续接完成`
//   位移后（本树）  ：9 条，`[3] assistant:收尾` / `[4] user:【恢复运行】…` / `[5] assistant:续接完成`
// 内容一条没少：下面 `assertResumedBody` 逐条点名这 6 条，并额外钉「告示恰一条」「`assistant:收尾` 恰一条」
// （既防丢也防翻倍）。告示自己的行为锚在 `test/loop-resume-notice.test.js`（8 格），这里只钉它在序列里的**位置**。
const EXPECTED_LEDGER_BODY = [
  "user:任务：写一个文件然后收尾",
  "assistant:先写文件+tool_use(writeFile)",
  "user:tool_result(wrote ledger/governed.txt)",
  "assistant:收尾",
];

/** 告示那一行的**前缀**：正文随账本事实变化（轮号 / 文件 / 工具），整段散文不进断言。 */
const NOTICE_LINE_PREFIX = `user:${RESUME_NOTICE_TAG}`;

/**
 * 恢复之后的正文序列（①②③ 三条宿主路径必须逐字相同）。
 *
 * 0–3 账本正文（崩溃那一刻的账本，与 `#401` 的回归锚逐字相同）· 4 复活赛告示（user 控制消息）
 * · 5 续接轮的第一段正文。
 *
 * 强度只增不减：原先只比 4 条（第 4 条还是被合并后的两段），现在 4 条照旧逐字比 + 告示那一行**点名**钉
 * （前缀 + 三件既有事实）+ 续接正文点名钉 + 「告示恰一条」「`assistant:收尾` 恰一条」两条唯一性判据。
 *
 * @param {string[]} body `describeMessages(result.messages)`
 * @param {string} label 哪一条宿主路径（失败信息里点名）
 */
function assertResumedBody(body, label) {
  assert.deepEqual(body.slice(0, 4), EXPECTED_LEDGER_BODY,
    `${label}：账本正文必须与今天逐字一致；实测前 6 条：${JSON.stringify(body.slice(0, 6))}`);
  const notice = body[4];
  assert.ok(notice !== undefined && notice.startsWith(NOTICE_LINE_PREFIX),
    `${label}：第 5 条必须是复活赛告示（user 控制消息），实测：${JSON.stringify(String(notice).slice(0, 120))}`);
  // 告示点名的是**既有事实**：停在哪个轮、写过哪个文件、最近调过哪个工具。
  assert.match(notice, /第 2 轮/u, `${label}：告示必须给出「上一段停在第 N 轮」`);
  assert.match(notice, /ledger\/governed\.txt/u, `${label}：告示必须带账本记过的写文件事实`);
  assert.match(notice, /writeFile\(ledger\/governed\.txt\)/u, `${label}：告示必须带最近调过的工具`);
  assert.equal(body[5], "assistant:续接完成",
    `${label}：告示之后必须紧跟续接轮的第一段正文（内容不丢）；实测：${JSON.stringify(body[5])}`);
  // 唯一性：告示恰一条（不重复注入）、`assistant:收尾` 恰一条（不丢也不翻倍）。
  assert.equal(body.filter((line) => line.startsWith(NOTICE_LINE_PREFIX)).length, 1,
    `${label}：一次恢复只许一条告示，实测：${JSON.stringify(body.filter((line) => line.startsWith(NOTICE_LINE_PREFIX)))}`);
  assert.equal(body.filter((line) => line === "assistant:收尾").length, 1,
    `${label}：崩溃轮那段「收尾」正文必须恰一条；实测：${JSON.stringify(body)}`);
}

/**
 * 造一个「宿主 store」：写入仍走内置 memory store（落盘行就是引擎真产出的形状），
 * 只替换 `load()` 的返回值形状——三种宿主坏法各一档。
 *
 * @param {"builtin"|"unfolded"|"both"|"both-legacy"} shape
 */
function createHostStore(shape) {
  const store = createMemoryTranscriptStore();
  const rawRows = [];
  const appendRound = store.appendRound.bind(store);
  store.appendRound = async (runId, record) => {
    rawRows.push(structuredClone(record));
    return appendRound(runId, record);
  };
  const foldedLoad = store.load.bind(store);
  store.load = async (runId) => {
    if (shape === "builtin") return foldedLoad(runId);
    // ① 宿主没折：`load()` 把落盘行原样交出来（erix-station 那种自研 store 的实测形状）
    if (shape === "unfolded") return structuredClone(rawRows);
    // ③ 两份都留：折好的载体行 + 原始消息行（宿主 materializer 自己折了一份，又没把原始行丢掉）
    if (shape === "both") {
      return [
        ...structuredClone(await foldedLoad(runId)),
        ...structuredClone(rawRows).filter((row) => row.kind === "message"),
      ];
    }
    // ③' 两份都留，但载体是**上一版折叠**的产物（issue #439 升级现场）：≤0.24.0 折出来的消息上
    // 没有逐条 `ts`，而原始消息行有 ⇒ 守卫若把信封字段算进「同一段正文」的判据就会判不等。
    const legacyFolded = (await foldedLoad(runId)).map((record) => ({
      ...record,
      messages: (record.messages ?? []).map((message) => {
        const { ts, ...rest } = message;
        return rest;
      }),
    }));
    return [
      ...structuredClone(legacyFolded),
      ...structuredClone(rawRows).filter((row) => row.kind === "message"),
    ];
  };
  return { store, rawRows };
}

/**
 * 跑两轮（第 1 轮含一次写类工具调用），再在同一 store / runId 上 resume，返回观测面。
 *
 * @param {string} runId
 * @param {"builtin"|"unfolded"|"both"|"both-legacy"} shape
 */
async function runTwoRoundsThenResume(runId, shape) {
  const { store, rawRows } = createHostStore(shape);

  await runDirect({
    provider: createFakeProvider([
      {
        content: [
          { type: "text", text: "先写文件" },
          { type: "tool_use", id: "w1", name: "writeFile", input: { path: GOVERNED_WRITE_PATH, content: "x" } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "任务：写一个文件然后收尾",
    executeTool: async ({ input }) => `wrote ${input?.path ?? ""}`,
    tools: [WRITE_FILE_TOOL],
    maxRounds: 4,
    completion: false,
    config: { input: { wrapup: false } },
    reflection: false,
    store,
    runId,
  });

  const continueJudge = judgeResponse({
    done: false, confidence: 0.5, reason: "继续", evidence: "有工具足迹",
    direction: "on_track", directionReason: "推进中",
  });
  const resumedJudge = createFakeProvider([continueJudge, continueJudge]);
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "续接完成" }], stopReason: "end_turn", times: 3 },
    ]),
    // #498 S3 A19：`resume` 退役扁平写法，并进**同一个** `config` 容器（家 `config.run.resume`）。
    executeTool: async () => "unused",
    tools: [WRITE_FILE_TOOL],
    maxRounds: 2,
    completion: false,
    config: { input: { wrapup: false }, run: { resume: true } },
    reflection: { enabled: true, judge: { provider: resumedJudge } },
    store,
    runId,
  });

  const judgePrompt = promptTextOf(resumedJudge);
  const timelineSection = judgePrompt.slice(
    judgePrompt.indexOf("时间线（最新在前）"),
    judgePrompt.indexOf("写过的文件"),
  );
  return {
    rawRows,
    judgePrompt,
    timelineSection,
    // resume 之后引擎手上的上下文（`result.messages` 就是 `ctx.messages` 本身）
    body: describeMessages(result.messages),
    filesWritten: result.runState?.deterministic?.filesWritten ?? [],
  };
}

// ── ① 宿主没折：引擎必须自己折出来 ─────────────────────────────────────────────
test("#401 R3① 宿主没折（load 原样返回落盘行）⇒ resume 自己折：该轮工具状态是 [ok] 不是 [pending]", async () => {
  const unfolded = await runTwoRoundsThenResume("issue-401-r3-unfolded", "unfolded");

  // 前提：这个宿主确实没折——落盘行里的轮载体行**没有** `messages` 键（0.23 写侧口径），
  // 而 `load()` 把它们原样交出来；正文只在 `kind:"message"` 行里。
  const rawRoundRow = unfolded.rawRows.find((row) => (row.dedupKey ?? "").endsWith(":engine:round:1"));
  assert.ok(rawRoundRow !== undefined, "第一轮必须有轮载体行");
  assert.equal(Object.hasOwn(rawRoundRow, "messages"), false,
    "0.23 写侧：轮行只留元数据（正文在 `…:msg:<round>:<seq>` 行里）——这一格就是「宿主拿到的是未折形状」的前提");
  assert.ok(unfolded.rawRows.some((row) => row.kind === "message" && row.round === 1),
    "未折形状下正文由 `kind:\"message\"` 行承载");

  // 判据①：时间线里那次写类调用是 `[ok]`（折回同一条记录才配得上 `tool_result`）
  assert.ok(unfolded.timelineSection.includes(`R1: writeFile ${GOVERNED_WRITE_PATH} [ok]`),
    `宿主没折时引擎必须自己折（工具状态 [ok] 说明 tool_result 折回了同一轮）；实测：${unfolded.timelineSection}`);
  assert.doesNotMatch(unfolded.timelineSection, /\[pending\]/u,
    "宿主没折而引擎没兜底时，`tool_use` 与 `tool_result` 落在不同记录里 ⇒ 时间线只能读到 [pending]");
  // 判据②：每轮一条时间线条目（未折时按消息行逐行重建会给同一轮重复条目）
  assert.equal((unfolded.timelineSection.match(/R1: writeFile/gu) ?? []).length, 1,
    "同一轮只能有一条时间线条目");
  // 判据③：写过的文件不重复计
  assert.deepEqual(unfolded.filesWritten, [GOVERNED_WRITE_PATH],
    `写过的文件必须恰好一条（不重复计）；实测：${JSON.stringify(unfolded.filesWritten)}`);
  assert.ok(unfolded.judgePrompt.includes(`写过的文件：${GOVERNED_WRITE_PATH}(R1)`),
    "写过的文件要带轮号 R1（来自账本重建，不是 run-state 那条只有路径的通道）");
  // 判据④：正文与「宿主折对了」那一条逐字相同（见 ②）
  assertResumedBody(unfolded.body, "① 宿主没折");
});

// ── ② 宿主折对了：与今天逐字一致（回归锚） ─────────────────────────────────────
test("#401 R3② 宿主折对了（内置 store）⇒ 账本正文与今天逐字一致（正文 / 时间线 / 写过的文件）", async () => {
  const builtin = await runTwoRoundsThenResume("issue-401-r3-builtin", "builtin");

  // 回归锚：这三份字面量就是「今天」的样子。R3 的免疫只许**增加**「宿主没折也能救」这一格，
  // 不许挪动内置 store 这一条路上的任何一个字节。
  // issue #404：唯一允许的位移是那条**已文档化**的复活赛告示（它在**每一条**恢复路径上都一样地出现，
  // 因此不是「折叠免疫」引入的差异）——账本正文这 4 条照旧逐字比，见 `assertResumedBody`。
  assertResumedBody(builtin.body, "② 宿主折对了");
  assert.ok(builtin.timelineSection.includes(`R1: writeFile ${GOVERNED_WRITE_PATH} [ok]`),
    `内置 store 的今天就是这样；实测：${builtin.timelineSection}`);
  assert.equal((builtin.timelineSection.match(/R1: writeFile/gu) ?? []).length, 1);
  assert.deepEqual(builtin.filesWritten, [GOVERNED_WRITE_PATH]);
  assert.ok(builtin.judgePrompt.includes(`写过的文件：${GOVERNED_WRITE_PATH}(R1)`));
});

// ── ③ 两份都留：正文不翻倍 ────────────────────────────────────────────────────
test("#401 R3③ 宿主「两份都留」（折好的载体 + 原始消息行）⇒ 正文条数不翻倍", async () => {
  const both = await runTwoRoundsThenResume("issue-401-r3-both", "both");

  // 翻倍时的实测形状（工单事实④）：R1 会变成 assistant+user+assistant+user 四条。
  const r1Blocks = both.body.slice(0, 4).filter((line) => /tool_use|tool_result/u.test(line));
  assert.equal(r1Blocks.length, 2,
    `第 1 轮只该有 assistant（含 tool_use）与 user（含 tool_result）两条；翻倍时会变成 4 条。实测：${JSON.stringify(both.body)}`);
  assertResumedBody(both.body, "③ 两份都留");
  assert.equal((both.timelineSection.match(/R1: writeFile/gu) ?? []).length, 1,
    "同一轮的时间线条目也只能一条");
  assert.deepEqual(both.filesWritten, [GOVERNED_WRITE_PATH], "写过的文件同样不重复计");
});

// ── 守卫的边界：载体带的是**引擎控制正文**（不是本轮正文）⇒ 该轮必须照常折 ─────────
//
// 这是「该轮载体已有正文就跳过」这条规则的**精确度**问题，不是细节：崩溃轮的载体是
// `…:engine:round:<n>:resume`，它带的是方向提示/达成 advisory 那几条引擎控制正文，同轮的消息行装的
// 才是崩溃轮正文。按「载体非空就跳」写，崩溃轮的正文会被整轮丢掉（本单实测：同一组行，窄规则折出 3 条、
// 「非空就跳」只剩那条方向提示）。所以守卫只跳「载体已带**本轮折出来的那份正文**」。
test("#401 R3 守卫精度：载体带引擎控制正文（`:resume` 行）时，该轮照常折、正文不许丢", () => {
  const message = (role, text) => ({ role, content: [{ type: "text", text }] });
  const rows = [
    { round: 2, seq: 0, kind: "message", dedupKey: "r:msg:2:0", messages: [message("assistant", "崩溃轮的正文")] },
    { round: 2, seq: 1, kind: "message", dedupKey: "r:msg:2:1", messages: [message("user", "崩溃轮的工具结果")] },
    {
      round: 2,
      dedupKey: "r:engine:round:2:resume",
      messages: [{
        role: "user",
        meta: { source: "judge-control" },
        content: [{ type: "text", text: "【方向提示】换思路" }],
      }],
    },
  ];
  const folded = foldMessageRows(structuredClone(rows));
  assert.equal(folded.length, 1, "消息行折进载体行，只剩一行");
  assert.equal(folded[0].dedupKey, "r:engine:round:2:resume", "载体是那条 `:resume` 行（崩溃轮唯一落盘的轮行）");
  assert.deepEqual(folded[0].messages.map((item) => item.content[0].text), [
    "【方向提示】换思路",
    "崩溃轮的正文",
    "崩溃轮的工具结果",
  ], "载体原有的引擎控制正文在前、崩溃轮正文接在后——两者都不能丢");
});

// ── 折叠层单测：三种形状折出来必须一致（引擎侧免疫的最小判据） ────────────────────
test("#401 R3 折叠层：未折 / 已折 / 两份都留 三种形状折出来的正文逐字相同", () => {
  const message = (role, text) => ({ role, content: [{ type: "text", text }] });
  const carrier = { round: 1, dedupKey: "r:engine:round:1", messages: [] };
  const rows = [
    { round: 1, seq: 0, kind: "message", dedupKey: "r:msg:1:0", messages: [message("assistant", "a")] },
    { round: 1, seq: 1, kind: "message", dedupKey: "r:msg:1:1", messages: [message("user", "b")] },
  ];
  const bodyOf = (records) => records.map((record) => (record.messages ?? []).map((item) => item.content[0].text));

  const folded = foldMessageRows([carrier, ...structuredClone(rows)]);
  assert.deepEqual(bodyOf(folded), [["a", "b"]], "未折形状：正文按 seq 折回载体行");

  // 已折：再折一次是空跑（同一个引用、同一批对象）
  const refolded = foldMessageRows(folded);
  assert.equal(refolded, folded, "已折过的账本必须原样透传（同一个引用）");

  // 两份都留：载体已带正文 + 原始消息行 ⇒ 守卫跳过该轮，正文不翻倍
  const bothRows = [...structuredClone(folded), ...structuredClone(rows)];
  assert.deepEqual(bodyOf(foldMessageRows(bothRows)), [["a", "b"]],
    "「两份都留」再折一遍不得让同一轮正文出现两次（工单 #401 事实④：实测 r1 会变成 assistant+user+assistant+user）");
});

// ── ③' 升级现场：「两份都留」但载体是**上一版折叠**的产物（消息不带逐条 `ts`） ────────
//
// 为什么单列一格：③ 用的是**本库当前**的折叠产物，载体里带的戳与消息行完全一样 ⇒ 守卫靠
// 逐字段深比较就能过。而 #439 之前的折叠（≤0.24.0，或宿主自研折叠）产出的载体里消息**没有**
// `ts`，原始消息行有 ⇒ 把信封字段算进「同一段正文」的判据就会判不等，正文静默拼第二遍
// （实测 2 条变 4 条：`assistant+user+assistant+user`，正是 #401 R3 治过的坏形状），而且
// `restoreResume` 会对 `load()` **再折一次** ⇒ 翻倍序列直接进 `ctx.messages`。
// 判据与 ③ 相同（不翻倍 + 与 ② 逐字一致），只是换了载体的来源。
test("#439 升级现场：宿主「两份都留」且载体由旧版折叠产出（消息无 `ts`）⇒ 正文不翻倍", async () => {
  const legacy = await runTwoRoundsThenResume("issue-439-legacy-both", "both-legacy");

  const r1Blocks = legacy.body.slice(0, 4).filter((line) => /tool_use|tool_result/u.test(line));
  assert.equal(r1Blocks.length, 2,
    `第 1 轮只该有 assistant（含 tool_use）与 user（含 tool_result）两条；翻倍时会变成 4 条。实测：${JSON.stringify(legacy.body)}`);
  assertResumedBody(legacy.body, "③' 升级现场（旧版载体 + 消息行）");
  assert.equal((legacy.timelineSection.match(/R1: writeFile/gu) ?? []).length, 1,
    "同一轮的时间线条目也只能一条");
  assert.deepEqual(legacy.filesWritten, [GOVERNED_WRITE_PATH], "写过的文件同样不重复计");
});
