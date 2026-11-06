// issue #739：契约套件的可选性必须在**套件内**做实（选项 A）。
// 修前的事实：`test/contract/transcript-store.js` 的头注释说 run snapshot / run-state 是可选
// capability，`src/assembly-validators.js` 也把 `OPTIONAL_TRANSCRIPT_STORE_METHODS` 全列为可选，
// 而套件里那批用例**无条件**调用 `store.saveRunSnapshot` / `store.saveRunState` ⇒ 一个只实现
// 必需面（`appendRound` + `load`）的宿主 store **能过装配校验、过不了随包套件**，报的是
// `TypeError: store.saveRunSnapshot is not a function`（不是「缺能力」的口径，是崩溃口径）。
// 本文件就是那条「最小 store 必须整套通过」的用例：把三处口径钉成同一个答案。
//
// 最小 store 的口径（不是「空实现」）：必需面的语义一条都不许少——去重幂等/冲突与折叠义务
// 都是 `appendRound` / `load` 的契约内容（issue #326 / #401），所以本夹具照宿主的做法复用包内
// 共享实现（`src/store/message-rows.js` 与 `src/store/transcript-dedup.js`），只是**不提供**
// 任何可选方法。可选方法一个都不给，正是这条用例的全部要点。
import test from "node:test";
import assert from "node:assert/strict";

import { transcriptStoreContract } from "../contract/transcript-store.js";
import { foldMessageRows } from "../../src/store/message-rows.js";
import {
  dedupConflictError,
  payloadFingerprint,
  recordKey,
} from "../../src/store/transcript-dedup.js";
import {
  OPTIONAL_TRANSCRIPT_STORE_METHODS,
  TRANSCRIPT_STORE_METHODS,
  validateTranscriptStore,
} from "../../src/assembly-validators.js";

/** 只实现契约必需面的参考 store：自己的账本 + 包内共享的折叠层与去重判据。 */
function createMinimalTranscriptStore() {
  /** @type {Map<string, object[]>} */
  const rows = new Map();
  const rawRows = (runId) => (rows.get(runId) ?? []).map((record) => structuredClone(record));

  return {
    async appendRound(runId, record) {
      const list = rows.get(runId) ?? [];
      const key = recordKey(runId, record);
      const existing = list.find((item) => recordKey(runId, item) === key);
      if (existing !== undefined) {
        const incomingFingerprint = payloadFingerprint(record);
        const existingFingerprint = payloadFingerprint(existing);
        if (existingFingerprint !== incomingFingerprint) {
          throw dedupConflictError({
            runId, key, existing, incoming: record, existingFingerprint, incomingFingerprint,
          });
        }
        return;
      }
      list.push(structuredClone(record));
      rows.set(runId, list);
    },
    async load(runId) {
      return foldMessageRows(rawRows(runId));
    },
  };
}

// 整套通过：必需面全绿，可选面由套件内的守卫逐格记 `skipped`（收尾那条 `能力守卫成对`
// 用例核对「一个都没被偷偷当成已验证」）。不传 `optionalCapabilities`＝什么都不声明。
transcriptStoreContract("minimal", () => createMinimalTranscriptStore());

test("minimal store: 面只有必需两方法（可选面一格都不在场，且能过装配校验）", () => {
  const store = createMinimalTranscriptStore();

  assert.deepEqual(Object.keys(store).sort(), [...TRANSCRIPT_STORE_METHODS].sort(),
    `最小 store 暴露的面必须恰好是装配必需面 ${TRANSCRIPT_STORE_METHODS.join("/")}；实测：${Object.keys(store).join("/")}`);
  const leaked = OPTIONAL_TRANSCRIPT_STORE_METHODS.filter((method) => typeof store[method] === "function");
  assert.deepEqual(leaked, [],
    `最小 store 不该带任何可选方法（漏一个就等于本用例在测一个更大的面）：${leaked.join("/")}`);
  // 「能过装配、过不了套件」就是本单的病灶；修后两侧必须同时成立。
  assert.deepEqual(validateTranscriptStore(store), [],
    "最小 store 必须过装配校验（否则本用例证明的不是『必需面』而是『装配也过不了』）");
});

test("minimal store: 必需面的语义不空转（折叠与同 key 冲突都真的落在这两方法上）", async () => {
  const store = createMinimalTranscriptStore();
  await store.appendRound("semantics-run", {
    round: 1,
    ts: "2026-11-07T00:00:00.000Z",
    dedupKey: "semantics-run:engine:round:1",
    messages: [{ role: "assistant", content: [{ type: "text", text: "carrier" }] }],
  });
  await store.appendRound("semantics-run", {
    round: 1,
    kind: "message",
    seq: 0,
    ts: "2026-11-07T00:00:01.000Z",
    dedupKey: "semantics-run:msg:1:0",
    messages: [{ role: "user", content: [{ type: "text", text: "one message row" }] }],
  });
  const loaded = await store.load("semantics-run");
  assert.equal(loaded.length, 1, "消息行必须折回载体行（必需面的折叠义务）");
  assert.equal(loaded[0].messages.length, 2, "折叠后一条逻辑消息一项");

  await assert.rejects(
    store.appendRound("semantics-run", {
      round: 1,
      dedupKey: "semantics-run:engine:round:1",
      messages: [{ role: "assistant", content: [{ type: "text", text: "同 key 换了正文" }] }],
    }),
    (error) => error?.code === "dedup_payload_conflict" && typeof error.existingFingerprint === "string",
    "同 key 异 payload 必须报 dedup_payload_conflict（必需面的去重义务）",
  );
});
