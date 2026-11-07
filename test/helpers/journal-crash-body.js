/**
 * issue #754（裁决 2）的**夹具垫片**：把「崩溃轮正文只在 run snapshot 里」的旧形状（pre-261021）
 * 转成 261021 之后写侧的真形状 —— 把快照里锚点之后的正文写成账本里的 `kind:"message"` 消息行。
 *
 * 为什么需要它：裁决 2 把恢复路径上最后一个读 `snapshot.messages` 补正文的地方关掉了
 * （`src/loop/resume-manager.js` 里那条 pre-261021 升级闸门）。于是这批夹具的处境是：夹具本身是旧形状，
 * 而**断言断的是活的机制**（按工具复放策略、#270 部分结果、#341 提示顺序、#261·#424 的 judge 计数、
 * #326 的方向提示 flush）。要动的是夹具，不是断言。
 *
 * `aggregates` 那一档是这批夹具里唯一需要分岔的地方：快照里那条**只含 `tool_result` 的聚合消息**
 * 代表「这一轮的结果没来得及入账」。把它写成账本行 = 这条 `tool_use` 已结清（`#421` 不再补桩、
 * 复放策略也不再标 `interrupted`）—— 那是**语义**变化，不是形状变化。所以：
 *   · `"rows"`（缺省）：连聚合消息一起写成行（断言把那份结果当已落盘正文的场合）；
 *   · `"drop"`：正文入账、结果留在快照里不落账（断言要「结果在上下文里、但不在账本里」的场合）。
 *
 * @param {object} store transcript store（要有 `loadLatestRunSnapshot` / `appendRound`）
 * @param {string} runId
 * @param {{aggregates?: "rows" | "drop"}} [options]
 */
export async function journalSnapshotBodyRows(store, runId, { aggregates = "rows" } = {}) {
  const snapshot = await store.loadLatestRunSnapshot(runId);
  const round = Number(snapshot?.round);
  for (const [seq, message] of (snapshot?.messages ?? []).slice(1).entries()) {
    if (message === null || message === undefined) continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const results = blocks.filter((block) => block?.type === "tool_result");
    if (aggregates === "drop" && results.length > 0 && blocks.length === results.length) continue;
    await store.appendRound(runId, {
      round,
      roundKey: `${runId}:round:${String(round)}`,
      dedupKey: `${runId}:msg:${String(round)}:${String(seq)}`,
      kind: "message",
      seq,
      messages: [message],
      ts: new Date().toISOString(),
    });
  }
}
