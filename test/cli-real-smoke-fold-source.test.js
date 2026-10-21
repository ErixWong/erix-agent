// 工单 261021-11（issue #344）：`scripts/cli-real-smoke.mjs` 的 C4/C5/C6 必须吃 `store.load()` 的
// **折叠输出**，不许再手写折叠。
//
// 被删掉的那版折叠（`collapseHistory`）按 `JSON.stringify(message).slice(0, 400)` 去重。它有牙，
// 但牙咬错了地方：**前 400 字符相同**的两条长消息会被判成同一条、静默吞掉一条。而 C4 的判据正是
// 「装后的 CLI 真跑了 ≥2 次工具」（`results.length >= 2`）——吞掉一条就少一次，红/绿取决于两条
// 消息的前缀长得像不像。工单 261021 把写侧改成「一条消息一成型就落盘」之后，同一个 run 的
// transcript 里是两种行（轮行 + 消息行），「拼回模型当时看到的历史」这件事已经有产品实现
// （`src/store/message-rows.js#foldMessageRows`，`store.load()` 的读侧，`src/loop/resume-manager.js`
// 重建上下文与宿主投影用的都是它）⇒ e2e 再手写一份就是第二份真源。
//
// 本用例两条牙，一条动态一条静态：
// 1. **夹具证明（动态）**：两条**前 400 字符完全相同**的长消息（各带一个 `tool_result` 块，身份键
//    与正文尾部不同）落成两条消息行，走装好的读侧口径（`createFileTranscriptStore({ dir }).load()`
//    + 文档口径的那一次摊平 `records.flatMap(record => record.messages ?? [])`）⇒ **两条都在**、
//    两个 `tool_result` 块都在。同时断言这两条的 400 字符指纹**确实相等**——那是夹具的区分力，
//    不是断言的数据源（指纹相等 ⇒ 任何按指纹去重的折叠都只能留一条）。
// 2. **数据源守卫（静态）**：脚本里不许再出现指纹折叠，`history` 必须摊平自折叠输出，且 C4/C5/C6
//    的既有断言一条都不许被删/被放宽（下面是针脚清单，加一条要同时改这里）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createFileTranscriptStore, safeRunId } from "../src/store/file.js";
import { MESSAGE_ROW_KIND } from "../src/store/message-rows.js";
import { makeTmp } from "./helpers/tmp.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "cli-real-smoke.mjs");

const RUN = "fold-source-r1";

/** 只从消息数组取内容块——与脚本里的 `blocksOf` 同形（断言打在块本体上，不在整段 JSON 上找子串）。 */
function blocksOf(messages, type) {
  return (messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === type);
}

/** 旧折叠的去重键：`JSON.stringify(message)` 的前 400 个字符。 */
const legacyFingerprint = (message) => JSON.stringify(message).slice(0, 400);

// 两条消息共用的长前缀：600 字符，远长于 400 ⇒ 指纹必然落在它里面。
const SHARED_PREFIX = `#344 fold-source fixture — 两条消息的前 400 字符必须逐字相同。${"长".repeat(520)}`;
const TOOL_IDS = ["tc_shared_prefix_a", "tc_shared_prefix_b"];

/** 一条带 `tool_result` 块的 user 消息：`content` 排在身份键**之前**，指纹才落在长正文里。 */
const toolResultMessage = (index) => ({
  role: "user",
  content: [{
    type: "tool_result",
    content: `${SHARED_PREFIX}#tail-${String(index)}`,
    tool_use_id: TOOL_IDS[index],
    is_error: false,
    erix: {
      toolCallKey: `tc_${String(index)}`,
      round: 1,
      durationMs: 4 + index,
      success: true,
    },
  }],
});

const roundRow = (round) => ({
  round,
  dedupKey: `${RUN}:engine:round:${String(round)}`,
  roundKey: `${RUN}:round:${String(round)}`,
  messages: [],
});

const messageRow = (round, seq, message) => ({
  round,
  seq,
  kind: MESSAGE_ROW_KIND,
  dedupKey: `${RUN}:msg:${String(round)}:${String(seq)}`,
  messages: [message],
});

test("261021-11 fold-source: 前 400 字符相同的两条长消息走 store.load() 折叠后两条都在（旧指纹折叠只留一条）", async () => {
  const first = toolResultMessage(0);
  const second = toolResultMessage(1);

  // 夹具的区分力：指纹相等 ⇒ 按指纹去重的折叠**必然**把它们并成一条（旧实现只剩 1 个块）。
  assert.equal(legacyFingerprint(first), legacyFingerprint(second),
    "夹具失效：两条消息的前 400 字符必须逐字相同，否则本用例证明不了旧折叠会吞一条");
  assert.equal(new Set([legacyFingerprint(first), legacyFingerprint(second)]).size, 1);
  // 但它们确实是两条不同的消息（身份键与正文尾部都不同）。
  assert.notDeepEqual(first, second);

  const dir = await makeTmp("cli-real-fold-source-");
  await writeFile(join(dir, `${safeRunId(RUN)}.jsonl`), [
    roundRow(1),
    messageRow(1, 0, first),
    messageRow(1, 1, second),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

  // 与脚本逐字同一条读法：`store.load(runId)` 的折叠输出，再按文档口径摊平。
  const folded = await createFileTranscriptStore({ dir }).load(RUN);
  const history = folded.flatMap((record) => record?.messages ?? []);
  const results = blocksOf(history, "tool_result");

  assert.equal(folded.length, 1, `折叠输出应只剩载体行，实际 ${folded.length} 条`);
  assert.equal(history.length, 2, `折叠输出摊平后应有 2 条消息，实际 ${history.length} 条`);
  assert.equal(results.length, 2,
    `C4 的判据（results.length >= 2）必须看得见两条：实际 ${results.length} 个 tool_result`
    + `（按指纹去重的旧折叠只留 1 条）`);
  assert.deepEqual(results.map((block) => block.tool_use_id), TOOL_IDS);
  // 折叠没有改写块本体：身份键与执行事实原样（C5/C6 查的就是这些）。
  assert.deepEqual(results.map((block) => block.erix.toolCallKey), ["tc_0", "tc_1"]);
  assert.deepEqual(results.map((block) => block.erix.durationMs), [4, 5]);
});

test("261021-11 fold-source: C4/C5/C6 的正文取自 store.load() 的折叠输出，脚本里不再有指纹折叠", async () => {
  const source = await readFile(SCRIPT, "utf8");

  // ① 手写折叠必须整体消失（不许留成备用路径：留着就还会有人喂它）。
  assert.ok(!source.includes("collapseHistory"), "scripts/cli-real-smoke.mjs 里不许再有 collapseHistory");
  assert.ok(!/slice\(\s*0\s*,\s*400\s*\)/.test(source),
    "scripts/cli-real-smoke.mjs 里不许再有 400 字符指纹折叠");
  assert.ok(!/JSON\.stringify\(\s*message\s*\)/.test(source),
    "scripts/cli-real-smoke.mjs 里不许再拿 JSON.stringify(message) 当去重键");

  // ② 正文来源必须是折叠输出（`folded` = 装好的包 `store.load(runId)`）。
  assert.match(source, /await store\.load\(runId\)/,
    "C4–C6 的正文必须来自装好的包的 store.load(runId)");
  assert.match(source, /const history = folded\.flatMap\(/,
    "history 必须摊平自折叠输出（folded），不是原始 JSONL 行");
  assert.match(source, /const results = blocksOf\(history, "tool_result"\)/,
    "results 必须从 history（折叠输出）取块");

  // ③ 既有断言强度：这些针脚一条都不许被删或放宽（删/改会让本条红）。
  const pins = [
    "results.length >= 2",
    "allowed.has(key)",
    "Object.hasOwn(block, name)",
    "顶层多出来的键",
    'block.erix.toolCallKey.startsWith("tc_")',
    "Number.isFinite(block?.erix?.durationMs) && block.erix.durationMs >= 0",
    'typeof block?.erix?.success === "boolean"',
    "durations.some((d) => d > 0)",
  ];
  for (const pin of pins) {
    assert.ok(source.includes(pin), `C4/C5/C6 的既有断言被改动/删除了：找不到 ${JSON.stringify(pin)}`);
  }
});
