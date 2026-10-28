// issue #460：折叠归档（`record.foldedPayload`）必须是**有界差分**，且它对单条记录的定界宿主不可见即不致命。
//
// 三条判据来自工单原文：
//   A 折叠写出的那条记录字节数 ≤ 显式上限；
//   B `foldedPayload` 不得与「此前已归档的同一份正文」并存（防复制回潮 ⇒ O(n²) 写侧）；
//   C 宿主对超限记录回 400 时，run **不得**终局为 `persistence_failed`。
import test from "node:test";
import assert from "node:assert/strict";
import { runDirect } from "./../helpers/run-direct.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import {
  DEFAULT_FOLD_ARCHIVE_MAX_BYTES,
  FOLD_ARCHIVE_MAX_BYTES_ENV,
  buildFoldedRecordArchive,
  createFoldArchiveLedger,
  foldMessageFingerprint,
  payloadByteLength,
  resolveFoldArchiveMaxBytes,
} from "../../src/compact/fold-archive.js";

function bigArchive(count, size, label = "") {
  return Array.from({ length: count }, (unused, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `${label}round-${index}:` + "x".repeat(size) }],
  }));
}

test("#460 上限：归档按字节夹断，且保尾丢头 + 留痕（判据 A）", () => {
  const source = bigArchive(40, 900);
  const { payload, meta } = buildFoldedRecordArchive({
    foldedPayload: source,
    maxBytes: 12_000,
  });

  assert.ok(meta.bytes <= 12_000, `归档必须夹进上限，实测 ${meta.bytes}`);
  assert.equal(meta.capBytes, 12_000);
  assert.ok(payload.length < source.length);
  assert.equal(meta.messages, payload.length);
  assert.equal(meta.droppedMessages, source.length - payload.length);
  assert.ok(meta.droppedBytes > 0);
  // 保尾丢头：留下的必须是最近折走的那批，最老的正文在账本里各有一行。
  assert.deepEqual(payload.at(-1), source.at(-1));
  assert.ok(payloadByteLength(source) > 12_000);
});

test("#460 上限口径：显式配置 > 环境变量 > 默认值，且 0 是合法值", (t) => {
  t.after(() => { delete process.env[FOLD_ARCHIVE_MAX_BYTES_ENV]; });

  assert.equal(resolveFoldArchiveMaxBytes(undefined), DEFAULT_FOLD_ARCHIVE_MAX_BYTES);
  process.env[FOLD_ARCHIVE_MAX_BYTES_ENV] = "4096";
  assert.equal(resolveFoldArchiveMaxBytes(undefined), 4096);
  assert.equal(resolveFoldArchiveMaxBytes(8192), 8192);
  assert.equal(resolveFoldArchiveMaxBytes(0), 0);
  process.env[FOLD_ARCHIVE_MAX_BYTES_ENV] = "not-a-number";
  assert.equal(resolveFoldArchiveMaxBytes(undefined), DEFAULT_FOLD_ARCHIVE_MAX_BYTES);

  // `0` = 只留指针不写正文，记录仍然有界。
  const { payload, meta } = buildFoldedRecordArchive({
    foldedPayload: bigArchive(4, 100),
    maxBytes: 0,
  });
  assert.deepEqual(payload, []);
  assert.equal(meta.droppedMessages, 4);
});

test("#460 去重：同一份正文只归档一次，跨 run 从账本预入账（判据 B）", () => {
  const ledger = createFoldArchiveLedger();
  const source = bigArchive(6, 200);

  const first = buildFoldedRecordArchive({ foldedPayload: source, ledger, maxBytes: 1_000_000 });
  assert.equal(first.meta.messages, 6);
  assert.equal(first.meta.dedupedMessages, 0);

  // 第二次折叠把同一段历史重抄一遍（真机形状：每次折叠都从 round 1 重发）。
  const second = buildFoldedRecordArchive({ foldedPayload: source, ledger, maxBytes: 1_000_000 });
  assert.deepEqual(second.payload, []);
  assert.equal(second.meta.dedupedMessages, 6);
  assert.ok(second.meta.dedupedBytes > 0);

  // 指纹对键序不敏感（规范化 JSON），对内容敏感。
  assert.equal(
    foldMessageFingerprint({ role: "user", content: [{ type: "text", text: "a" }] }),
    foldMessageFingerprint({ content: [{ text: "a", type: "text" }], role: "user" }),
  );
  const resumed = createFoldArchiveLedger();
  resumed.seedFromRecords([{ foldedPayload: source }, { foldedPayload: [] }]);
  assert.equal(resumed.seenCount(), 6);
  const third = buildFoldedRecordArchive({ foldedPayload: source, ledger: resumed, maxBytes: 1_000_000 });
  assert.deepEqual(third.payload, []);
});

// 判据 C：宿主对**单条记录**定界（本站 1 MB）时，剥掉咨询性归档重试一次，run 继续。
test("#460 宿主拒超限记录：剥掉归档重试，run 不终局为 persistence_failed（判据 C）", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "complete" }], stopReason: "end_turn" },
  ]);
  const records = [];
  const diagnostics = [];
  const HOST_LIMIT = 30_000;
  const archive = bigArchive(60, 900);

  const strategy = {
    shouldCompact() {
      return strategy.calls++ === 1;
    },
    calls: 0,
    async compact() {
      return {
        messages: [{ role: "user", content: [{ type: "text", text: "compacted context" }] }],
        compacted: true,
        foldedRounds: 1,
        tokensBefore: 400_087,
        tokensAfter: 4_025,
        foldedPayload: archive,
      };
    },
  };

  const store = createMemoryTranscriptStore();
  const appendRound = store.appendRound.bind(store);
  let rejections = 0;
  store.appendRound = async (runId, record) => {
    const bytes = payloadByteLength(record);
    if (bytes > HOST_LIMIT) {
      rejections += 1;
      const error = new Error(`round 请求体超过上限（${bytes} > ${HOST_LIMIT}）`);
      error.status = 400;
      throw error;
    }
    records.push(structuredClone(record));
    return appendRound(runId, record);
  };

  const result = await runDirect({ capabilities: { ports: { strategy: strategy } },
    provider,
    initialUserMessage: "start",
    executeTool: async () => "worked",
    completion: false,
    // #498 S3 (`input` slice A): `cacheStablePrefix` moved into the config tree (same key, new home).
    config: { input: { cacheStablePrefix: false }, folding: { context: { budgetTokens: 99, keepRounds: 4, maxFoldedPayloadBytes: 1_000_000 } } },
    store,
    runId: "issue-460",
    diagnostics: { error: (event) => diagnostics.push(event) },
  });

  assert.equal(result.finalText, "complete", "超限归档只能降级，不能改写 run 终局");
  // `persist()` 自身带退避重试，所以宿主被拒的次数 >= 1（不是恰好 1）；
  // 真正要钉的是：剥归档那一次重试**成功**了，于是 run 继续。
  assert.ok(rejections >= 1);

  const roundRecord = records.find((record) => record.dedupKey === "issue-460:engine:round:2");
  assert.ok(roundRecord !== undefined, "剥掉归档后轮记录必须入库");
  assert.equal(roundRecord.folded, true);
  assert.equal(roundRecord.foldedPayload, undefined, "咨询性归档不得进这条记录");
  assert.equal(roundRecord.foldedPayloadMeta.rejectedByHost, true);
  assert.equal(roundRecord.foldedPayloadMeta.droppedMessages, archive.length);
  assert.ok(payloadByteLength(roundRecord) <= HOST_LIMIT);

  const degraded = diagnostics.filter((event) => event.operation === "appendRound");
  // 两条事实：① 带归档那次 persist 自身耗尽重试的 fatal:true；② 剥归档降级的 fatal:false。
  // 要钉的是：降级事实恰好一条，且 run 没有因此终局。
  assert.equal(
    degraded.filter((event) => event.fatal === false).length,
    1,
    `降级事实必须恰好一条 fatal:false，实测事件：${JSON.stringify(degraded.map((event) => event.fatal))}`,
  );
  assert.ok(
    degraded.every((event) => event.phase === "transcript"),
    "降级事实的 phase 仍是 transcript",
  );
});

// review 补钉：`droppedBytes` 是夹断量，不能把去重量再扣一次。
test("#460 review：夹断量与去重量各算各的（droppedBytes 不得双扣）", () => {
  const ledger = createFoldArchiveLedger();
  const source = bigArchive(20, 900);
  const first = buildFoldedRecordArchive({
    foldedPayload: source.slice(0, 5), ledger, maxBytes: 1_000_000,
  });
  assert.equal(first.meta.droppedBytes, 0);

  const second = buildFoldedRecordArchive({ foldedPayload: source, ledger, maxBytes: 6_000 });
  assert.equal(second.meta.dedupedMessages, 5);
  assert.ok(second.meta.droppedMessages > 0);
  // 夹断量 = 去重后那份的字节 − 留下的字节（而不是去重前的总量）。
  assert.equal(
    second.meta.droppedBytes,
    payloadByteLength(source.slice(5)) - second.meta.bytes,
    `夹断量算错了：${JSON.stringify(second.meta)}`,
  );
});

// review 补钉：去重集不得包含本轮自己上一次的尝试，否则崩溃重跑同 key 不同 payload
// ⇒ `src/store/transcript-dedup.js` 报 `dedup_payload_conflict`（契约：误判成冲突比漏判更糟）。
test("#460 review：ensureSeeded(beforeRound) 只算早于本轮的归档", async () => {
  // 两拨内容必须指纹不重叠（同 count 的前几条文本会逐字节相同 ⇒ 不加 label 就会互相遮住）。
  const older = bigArchive(2, 300, "older-");
  const mine = bigArchive(3, 300, "mine-");
  const store = {
    load: async () => [
      { round: 9, foldedPayload: older }, // 更早一轮：应当算进去重集
      { round: 12, foldedPayload: mine }, // 本轮上一次尝试写的：不得算进去
    ],
  };

  const scoped = createFoldArchiveLedger({ store, runId: "r" });
  await scoped.ensureSeeded(12);
  const rerun = buildFoldedRecordArchive({
    foldedPayload: mine, ledger: scoped, maxBytes: 1_000_000,
  });
  assert.deepEqual(rerun.payload, mine, "重跑必须选出与首次尝试相同的 payload");
  assert.equal(rerun.meta.dedupedMessages, 0);

  // 反证：不传 beforeRound 就会把本轮那份也算进去 ⇒ payload 从 `[...]` 变成 `[]`。
  const naive = createFoldArchiveLedger({ store, runId: "r" });
  await naive.ensureSeeded();
  assert.deepEqual(
    buildFoldedRecordArchive({ foldedPayload: mine, ledger: naive, maxBytes: 1_000_000 }).payload,
    [],
  );
});

// 判据 A（引擎侧默认值）：默认上限下写出的折叠记录必然有界。
test("#460 默认上限：折叠记录不带无界归档（判据 A，默认配置）", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "complete" }], stopReason: "end_turn" },
  ]);
  const records = [];
  const strategy = {
    shouldCompact() {
      return strategy.calls++ === 1;
    },
    calls: 0,
    async compact() {
      return {
        messages: [{ role: "user", content: [{ type: "text", text: "compacted context" }] }],
        compacted: true,
        foldedRounds: 1,
        tokensBefore: 400_087,
        tokensAfter: 4_025,
        foldedPayload: bigArchive(600, 900), // ≈ 560 KB 原文，超过默认 256 KiB
      };
    },
  };
  const store = createMemoryTranscriptStore();
  const appendRound = store.appendRound.bind(store);
  store.appendRound = async (runId, record) => {
    records.push(record);
    return appendRound(runId, record);
  };

  await runDirect({ capabilities: { ports: { strategy: strategy } },
    provider,
    initialUserMessage: "start",
    executeTool: async () => "worked",
    completion: false,
    config: { input: { cacheStablePrefix: false }, folding: { context: { budgetTokens: 99, keepRounds: 4 } } },
    store,
    runId: "issue-460-cap",
  });

  const roundRecord = records.find((record) => record.dedupKey === "issue-460-cap:engine:round:2");
  assert.ok(roundRecord !== undefined);
  assert.ok(
    payloadByteLength(roundRecord.foldedPayload) <= DEFAULT_FOLD_ARCHIVE_MAX_BYTES,
    `归档必须夹进默认上限，实测 ${payloadByteLength(roundRecord.foldedPayload)}`,
  );
  assert.ok(roundRecord.foldedPayloadMeta.droppedMessages > 0, "夹断必须留痕");
});
