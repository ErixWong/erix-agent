// issue #326（wo-D）：**引擎事实行的测试夹具**。
//
// #326 第 1/3/4 步之后，`store.load()` 的账本里除了轮记录还多了三类「引擎事实行」：
//   - `<runId>:engine:round:<n>:control:<slot>` —— 引擎注入给模型的文本（`messages` 里是带
//     `meta.source === "judge-control"` 的普通消息，`forced-final` 槽位还会多带终稿 assistant）；
//   - `<runId>:engine:round:<n>:fold:<fp>` —— 实际喂给模型的折叠摘要，挂在 `foldedSummary`，
//     `messages` 是**空数组**；
//   - `<runId>:engine:round:<n>:ttl:<fp>` —— 工具结果的 TTL 降级事实，挂在 `ttlDegradations`，
//     `messages` 是**空数组**。
//
// 形状一律照抄引擎自己写的那两份（`src/loop/orchestrator.js` 的
// `appendEngineMessagesToTranscript` / `appendEngineFactToTranscript`），字段名以**真跑出来的
// transcript** 为准（TTL 那类挂在 **`ttlDegradations`**，不是工单里写的 `ttlFacts`）。
// CLI 侧的测试用它构造「三类混合 + 普通轮记录」的 JSONL。
import { writeFile } from "node:fs/promises";

export const FACT_TS = "2026-01-01T00:00:00.000Z";

export const textBlock = (text) => ({ type: "text", text });
export const userMessage = (text) => ({ role: "user", content: [textBlock(text)] });
export const assistantMessage = (text) => ({ role: "assistant", content: [textBlock(text)] });
export const engineNoteMessage = (text) => ({
  role: "user",
  content: [textBlock(text)],
  meta: { source: "judge-control" },
});

/** 普通轮记录（宿主/老 CLI 写的形状：只有 `roundKey`，没有 `dedupKey`）。 */
export const roundRow = (runId, round, messages) => ({
  round,
  roundKey: `${runId}:round:${String(round)}`,
  messages,
  ts: FACT_TS,
});

/** `:control:<slot>` 行：引擎自写的控制文本（默认 judge nudge）。 */
export const controlRow = (runId, round, slot = "judge-nudge", messages = [
  engineNoteMessage("【Judge 评审意见】方向不对，请回到交付物"),
]) => ({
  round,
  roundKey: `${runId}:round:${String(round)}`,
  dedupKey: `${runId}:engine:round:${String(round)}:control:${slot}`,
  messages,
  ts: FACT_TS,
});

/** `:fold:<fp>` 行：实际喂给模型的折叠摘要（`messages` 是空数组）。 */
export const foldRow = (runId, round) => ({
  round,
  roundKey: `${runId}:round:${String(round)}`,
  dedupKey: `${runId}:engine:round:${String(round)}:fold:aabbccddeeff0011`,
  messages: [],
  foldedSummary: {
    text: "## 阶段\n已完成的折叠摘要正文",
    fingerprint: "sha256:aabbccddeeff0011",
    strategy: "fold-llm",
    foldedRoundRange: { from: 1, to: round - 1 },
  },
  ts: FACT_TS,
});

/** `:ttl:<fp>` 行：工具结果的 TTL 降级事实（`messages` 是空数组）。 */
export const ttlRow = (runId, round) => ({
  round,
  roundKey: `${runId}:round:${String(round)}`,
  dedupKey: `${runId}:engine:round:${String(round)}:ttl:1122334455667788`,
  messages: [],
  ttlDegradations: [{
    toolUseId: "tu-1",
    toolName: "read_file",
    tokens: 1800,
    tokensAfter: 42,
    chars: 7200,
    createdRound: 1,
    contentFingerprint: "sha256:1122334455667788",
    placeholder: "（已折叠·TTL：原约 1800 tokens）",
  }],
  ts: FACT_TS,
});

/**
 * 三类事实行 + 普通轮记录混在一起的一份账本，顺序就是引擎的真实落盘顺序
 * （seed/轮记录在前，事实行跟在产生它的那一轮之后）。`firstIsFactRow: false` 时把一条
 * 控制行挪到第二行，用来钉「第一行不是正文」的另一种形状。
 */
export function mixedFactRows(runId) {
  return [
    roundRow(runId, 0, [userMessage("把三类事实行写进账本")]),
    // 工具结果按 canonical 形状成对出现：assistant 带 `tool_use`，下一条 user 带 `tool_result`
    // （`role: "tool"` 不是合法角色，缺配对会被 validateMessages 拒掉）
    roundRow(runId, 1, [
      { role: "assistant", content: [textBlock("先看一眼"), { type: "tool_use", id: "tu-1", name: "read_file", input: { path: "src/a.js" } }] },
      // canonical 的 tool_result 用 `tool_use_id`（snake_case），与 TTL 事实行里的 `toolUseId` 不同名
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "x".repeat(400) }] },
    ]),
    foldRow(runId, 2),
    roundRow(runId, 2, [assistantMessage("继续")]),
    ttlRow(runId, 2),
    controlRow(runId, 2),
    roundRow(runId, 3, [assistantMessage("收尾")]),
    controlRow(runId, 3, "forced-final", [
      engineNoteMessage("【强制收尾】轮数已用尽，请给出终稿"),
      assistantMessage("终稿正文"),
    ]),
  ];
}

/** 序列化成 JSONL 文本（每行一条记录，与内置 file store 的落盘格式一致）。 */
export function toJsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

export async function writeTranscript(path, rows) {
  await writeFile(path, toJsonl(rows), "utf8");
  return path;
}
