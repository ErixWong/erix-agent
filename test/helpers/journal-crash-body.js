/** Write an explicit crash transcript as message rows. Callers include only settled results. */
export async function appendLedgerMessages(store, runId, { round, messages }) {
  for (const [seq, message] of messages.entries()) {
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
