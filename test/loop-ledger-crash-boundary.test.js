// issue #736：**崩溃边界必须从账本推，不从快照推**——本文件先钉「边界」这条纯判据本身。
//
// 病根（#734 的后果放大器，中英契约里那条「快照写失败 ⇒ checkpoint_failed」的下游）：恢复侧
// `crashSiteRound` 的判据来自 run snapshot，而 #734 那次失败的写**正是快照本身**（latest-only 覆盖写，
// 被拒的那次没落）⇒ 探测器跟现场一起消失 ⇒ 既不裁锚点、也不结清尾部 ⇒ 账本里那条悬空 `tool_use`
// 落在**中段**，被 #421 的「同页合并」纪律跳过 ⇒ 每次请求在任何出网之前被本地 `validateMessages`
// 拒掉（真机一例：7 次同类 `run_end`，报错 index 从 685 漂到 693）。
//
// 所以边界必须与快照的新鲜度/存在性**无关**，只吃账本：
//   最大下标 `i`，使 `ledgerEntries[i]` 是带 `tool_use` 的 assistant、其 id 不在 `settledToolResultIds`
//   里，且 `i` 之后的每一行要么带 `tool_result`、要么是宿主预写行、要么是引擎控制行（#736 原文）。
//
// 本文件只做**纯函数**这一格（端到端夹具在 `test/loop-resume-ledger-crash-boundary.test.js`）：
//   ① 崩溃轮 assistant 行 + 其后一条宿主 `:input:` 预写行 ⇒ 返回那个下标；
//   ② 末轮是纯文本 `end_turn` + 其后宿主追问 ⇒ `null`（正常收口不得被误判成崩溃现场）；
//   ③ 其后还有一条**引擎的 toolResult 行**（那次调用其实结清了）⇒ `null`；
//   ④/⑤ 后缀里混进「崩溃之前就已存在的引擎正文行」⇒ `null`（边界只在崩溃行**紧贴**尾队列时成立）；
//   ⑥ 部分结清（`assistant[X,Y]` + `user[result X]`）⇒ `null`（那是 #421 的中段格子，裁切会造重复 id）。
import test from "node:test";
import assert from "node:assert/strict";

import { deriveLedgerCrashBoundary } from "../src/loop/resume-manager.js";
import { foldLedgerMessages } from "../src/store/message-rows.js";

const text = (value) => ({ type: "text", text: value });
const userText = (value, meta) => ({
  role: "user",
  ...(meta === undefined ? {} : { meta }),
  content: [text(value)],
});
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: {} });
const toolResult = (id) => ({ type: "tool_result", tool_use_id: id, content: `out-${id}` });

/** 宿主 `appendUserTurn` 的产出形状（`src/store/append-user-turn.js`）：没有 `kind` / `seq`。 */
const hostRow = (runId, value, round = 1) => ({
  round,
  roundKey: `${runId}:input:follow-up`,
  dedupKey: `${runId}:input:follow-up`,
  messages: [userText(value)],
  ts: "2026-11-06T00:00:00.000Z",
});
const seedRow = (runId) => ({
  round: 0,
  roundKey: `${runId}:round:0`,
  dedupKey: `${runId}:engine:round:0:seed`,
  messages: [userText("任务")],
});
const assistantRow = (runId, round, seq, content) => ({
  round,
  kind: "message",
  seq,
  dedupKey: `${runId}:msg:${String(round)}:${String(seq)}`,
  messages: [{ role: "assistant", content }],
});
const resultRow = (runId, round, seq, id) => ({
  round,
  kind: "message",
  seq,
  dedupKey: `${runId}:msg:${String(round)}:${String(seq)}`,
  messages: [{ role: "user", content: [toolResult(id)] }],
});

/** 与 `restoreResume` 同一口径：`foldLedgerMessages` + `#420` 的结果 id 集合。 */
function ledgerOf(rows) {
  const entries = foldLedgerMessages(rows);
  const settled = new Set(entries
    .flatMap((entry) => (Array.isArray(entry.message?.content) ? entry.message.content : []))
    .filter((block) => block?.type === "tool_result")
    .map((block) => block.tool_use_id));
  return { entries, settled };
}

/**
 * `isEngineLedgerRow` 的镜像（`src/loop/resume-manager.js` 私有的归属判据在这里只按**键的命名空间**
 * 复现）：`:engine:` ⇒ 引擎；`:input:` ⇒ 宿主。纯函数用例只需要这一个二值归属，端到端那一格
 * （`#425` 的键+形状两级判据）由 `test/loop-resume-anchor.test.js` 钉。
 */
function attributionOf(rows, expected) {
  const flags = [];
  for (const row of rows) {
    const engine = !String(row.dedupKey ?? "").includes(":input:");
    for (let offset = 0; offset < (row.messages ?? []).length; offset += 1) flags.push(engine);
  }
  if (flags.length !== expected) throw new Error(`归属镜像条数对不上：${String(flags.length)} vs ${String(expected)}`);
  return (_entry, index) => flags[index];
}

const derive = (rows) => {
  const { entries, settled } = ledgerOf(rows);
  return deriveLedgerCrashBoundary(entries, settled, attributionOf(rows, entries.length));
};

test("#736 边界：崩溃轮 assistant 行 + 其后宿主 `:input:` 预写行 ⇒ 返回崩溃行的下标", () => {
  const RUN_ID = "b736-crash";
  const rows = [
    seedRow(RUN_ID),
    assistantRow(RUN_ID, 1, 0, [text("开工"), toolUse("t1")]),
    hostRow(RUN_ID, "怎么样了？"),
  ];
  assert.equal(derive(rows), 1,
    "崩溃轮 assistant 行已入账、其后只有宿主追问 ⇒ 边界 = 1（切片点 = 2，悬空块成为尾部）");

  // 宿主追问**多行**（用户每重发一次就再埋一层，真机一例 7 层）⇒ 边界仍是同一个下标。
  const twice = [...rows.slice(0, 2), hostRow(RUN_ID, "再问一次"), hostRow(RUN_ID, "还问")];
  assert.equal(derive(twice), 1, "尾队列多行不移动边界（这正是「每重发一次就再埋一层」的形状）");

  // 引擎控制行（#323 的 marker）夹在中间也仍放行：它是引擎自写的控制文本，不是崩溃前的正文。
  const withNotice = [...rows.slice(0, 2), {
    round: 1,
    dedupKey: `${RUN_ID}:engine:round:1:control:resume-notice:abc`,
    messages: [userText("【恢复运行】…", { source: "judge-control" })],
  }, hostRow(RUN_ID, "怎么样了？")];
  assert.equal(derive(withNotice), 1, "上一次恢复留下的告示行不阻断边界（宿主重发就是这种账本）");
});

test("#736 边界：末轮纯文本 `end_turn` + 其后宿主追问 ⇒ null（正常收口不得被误判）", () => {
  const RUN_ID = "b736-normal";
  const rows = [
    seedRow(RUN_ID),
    assistantRow(RUN_ID, 1, 0, [text("开工"), toolUse("t1")]),
    resultRow(RUN_ID, 1, 1, "t1"),
    assistantRow(RUN_ID, 2, 0, [text("做完了")]),
    hostRow(RUN_ID, "再帮我看看", 2),
  ];
  assert.equal(derive(rows), null,
    "末轮是纯文本、`t1` 早已结清 ⇒ 没有边界：不结清、不裁切、告示走 `RESUME_NOTICE_NO_PENDING` 那一支");
});

test("#736 边界：崩溃行之后有**引擎的 toolResult 行** ⇒ null（那次调用其实结清了）", () => {
  const RUN_ID = "b736-settled";
  const rows = [
    seedRow(RUN_ID),
    assistantRow(RUN_ID, 1, 0, [text("开工"), toolUse("t1")]),
    resultRow(RUN_ID, 1, 1, "t1"),
    hostRow(RUN_ID, "怎么样了？"),
  ];
  assert.equal(derive(rows), null,
    "`t1` 的结果行就在账本里（#420 的权威口径）⇒ 不存在未结清的崩溃现场");
});

test("#736 边界：崩溃行之后混进崩溃**之前**的引擎正文行 ⇒ null（边界只在紧贴尾队列时成立）", () => {
  const RUN_ID = "b736-mid";
  // `t1` 悬空，但它后面还有一条**引擎归属的正文行**（宿主在该轮之后又写过一条引擎侧的 user 正文，
  // 或上一次恢复留下的追问被算成引擎行）⇒ 那一行不是尾队列 ⇒ 边界不成立。
  const danglingThenEngineBody = [
    seedRow(RUN_ID),
    assistantRow(RUN_ID, 1, 0, [text("第一段"), toolUse("t1")]),
    { round: 1, dedupKey: `${RUN_ID}:engine:round:1:resume`, messages: [userText("上一段的方向提示")] },
    hostRow(RUN_ID, "怎么样了？", 1),
  ];
  assert.equal(derive(danglingThenEngineBody), null,
    "崩溃行之后跟着一条**引擎归属**的正文行 ⇒ 不裁切（尾部结清会把这一行留在悬空块与它的结果之间）");

  // 同一账本把那行的键换成 `:input:`（宿主预写）⇒ 立刻成立：判据的另一半单独咬得住。
  assert.equal(derive([
    seedRow(RUN_ID),
    assistantRow(RUN_ID, 1, 0, [text("第一段"), toolUse("t1")]),
    hostRow(RUN_ID, "上一段的方向提示", 1),
    hostRow(RUN_ID, "怎么样了？", 1),
  ]), 1, "对照：同一行按宿主归属 ⇒ 尾队列成立 ⇒ 边界 = 崩溃行下标");

  // 「最大下标」这一半：多条未结清 assistant 时取**最后**那条（#421 标本 B 的形状：连续 N 条
  // assistant 只有最后一条被结清，边界必须是最后一条才把所有悬空块一并送到尾部）。
  assert.equal(derive([
    seedRow(RUN_ID),
    assistantRow(RUN_ID, 1, 0, [text("第一段"), toolUse("t1")]),
    resultRow(RUN_ID, 1, 1, "t1"),
    assistantRow(RUN_ID, 2, 0, [text("第二段"), toolUse("t2")]),
    hostRow(RUN_ID, "怎么样了？", 2),
  ]), 3, "崩溃行成为最后一条正文时边界成立，且返回的是它自己的下标");
});

test("#736 边界：部分结清（`assistant[X,Y]` + `user[result X]`）⇒ null（那是 #421 的中段格子）", () => {
  const RUN_ID = "b736-partial";
  const rows = [
    seedRow(RUN_ID),
    assistantRow(RUN_ID, 1, 0, [text("开工"), toolUse("t1"), toolUse("t2")]),
    resultRow(RUN_ID, 1, 1, "t1"),
    hostRow(RUN_ID, "怎么样了？"),
  ];
  assert.equal(derive(rows), null,
    "只要有一个 id 已结清就不裁切：按这条裁会把已落账的 `result X` 挤进尾队列，"
    + "尾部结清再补一张同 id 的桩 ⇒ 同一个 id 两份结果 ⇒ 把可恢复现场变成不可恢复");
});

test("#736 边界：形状与缺参的兜底（不抛、不误判）", () => {
  assert.equal(deriveLedgerCrashBoundary(undefined, undefined, undefined), null);
  assert.equal(deriveLedgerCrashBoundary([], new Set(), undefined), null);
  // 归属未知（没给 `isEngineRow`）时只放行「带 tool_result」与「judge-control 控制行」两支：
  // 宿主预写行因此不再被放行 ⇒ 宁可判成「边界不成立」（= 修复前的行为），也不误裁。
  const RUN_ID = "b736-unknown";
  const rows = [
    seedRow(RUN_ID),
    assistantRow(RUN_ID, 1, 0, [text("开工"), toolUse("t1")]),
    hostRow(RUN_ID, "怎么样了？"),
  ];
  const { entries, settled } = ledgerOf(rows);
  assert.equal(deriveLedgerCrashBoundary(entries, settled, undefined), null,
    "归属未知 ⇒ 宿主追问行放行不了 ⇒ null（宽松档只放开带 marker 的引擎控制行与结果行）");
  assert.equal(deriveLedgerCrashBoundary(entries, settled, () => false), 1,
    "全部行判宿主 ⇒ 崩溃行之后放行，边界仍在崩溃行（判据的另一半单独成立）");
});
