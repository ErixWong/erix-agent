// @ts-check
// issue #896 §3-C：单发回忆调用（仿 judge）——端口不可用 / 单发 / 只装指定折 / maxTokens 硬顶 /
// 超时码 / engine 桶 / 指纹形状+2KiB+sha256 / recall_read evidenceRef 三态 / uncertain 字段 /
// 现有 round·pattern 两模式逐字不变（既有 19 格由 recall-read/pattern-896.test.js 兜）。
//
// 全离线、假 provider，不跑真模型。

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  recallOnce,
  buildRecallRequest,
  sha256Hex,
  RECALL_MAX_TOKENS,
  RECALL_MAX_EVIDENCE_BYTES,
} from "../../src/loop/recall-runner.js";
import { createBuiltinRecallTools } from "../../src/tools/recall.js";

const awaitWithAbort = (/** @type {Promise<any>} */ p) => p;

/** 造一个假 provider：记调用次数、抓最后一次请求、返回一段可解析的 JSON 文本。 */
function makeFakeProvider(payload) {
  /** @type {number} */
  const state = { calls: 0, lastRequest: null };
  const provider = (/** @type {any} */ request) => {
    state.calls += 1;
    state.lastRequest = request;
    const text = typeof payload === "string"
      ? payload
      : JSON.stringify(payload ?? { answer: "A", pointers: [], uncertain: false });
    return Promise.resolve({
      content: [{ type: "text", text }],
      usage: { input_tokens: 11, output_tokens: 7 },
    });
  };
  return { provider, state };
}

/** 用量记账替身：按 opts.account 分进 engine / model 两个桶。 */
function makeUsageRecorder() {
  /** @type {any[]} */
  const engine = [];
  /** @type {any[]} */
  const model = [];
  const addUsage = (/** @type {any} */ response, /** @type {any} */ round, /** @type {any} */ opts) => {
    (opts && opts.account === "engine" ? engine : model).push({ response, round, opts });
  };
  return { addUsage, engine, model };
}

const baseDeps = (/** @type {any} */ extra = {}) => ({
  recallProviderPort: undefined,
  addUsage: () => {},
  awaitWithAbort,
  ...extra,
});

// ─── 格 1：端口不提供 ⇒ 不可用，不抛、不静默降级 ──────────────────────────────
test("#896C-1 端口不提供 ⇒ available:false，不抛不降级（无主 provider 兜底）", async () => {
  // 即便 deps 里塞了别的 provider 字段，回忆端口缺失也不该拿它凑数。
  const calls = { n: 0 };
  const decoyProvider = () => { calls.n += 1; return Promise.resolve({}); };
  const result = await recallOnce(
    baseDeps({ provider: decoyProvider, judgeProviderPort: decoyProvider }),
    { question: "q", folds: [{ round: 1, messageIndex: 0, text: "body" }] },
  );
  assert.equal(result.available, false, "端口缺失必须报不可用");
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.includes("不可用") || result.reason.includes("未提供"));
  assert.equal(calls.n, 0, "不许静默拿别的 provider 降级");
  assert.ok(!("answer" in result) || result.answer === undefined, "不可用时不返回答案");
});

// ─── 格 2：单发，只调一次 provider ─────────────────────────────────────────────
test("#896C-2 单发：一次调用只发一次 provider 请求", async () => {
  const { provider, state } = makeFakeProvider({ answer: "A", pointers: [], uncertain: false });
  const r = await recallOnce(
    baseDeps({ recallProviderPort: provider }),
    { question: "q", folds: [{ round: 2, messageIndex: 0, text: "one" }, { round: 2, messageIndex: 1, text: "two" }] },
  );
  assert.equal(state.calls, 1, "只许单发");
  assert.equal(r.available, true);
});

// ─── 格 3：请求里只有指定折的归档正文（诱饵折不许混进来）─────────────────────
test("#896C-3 请求只装指定折的归档正文，另一折（诱饵）正文不出现", async () => {
  const { provider, state } = makeFakeProvider({ answer: "A", pointers: [], uncertain: false });
  await recallOnce(baseDeps({ recallProviderPort: provider }), {
    question: "REAL_QUESTION",
    folds: [{ round: 3, messageIndex: 0, text: "REAL_BODY_MARK 这段属于指定折" }],
  });
  const sent = JSON.stringify(state.lastRequest);
  assert.ok(sent.includes("REAL_BODY_MARK"), "指定折的归档正文必须在请求里");
  assert.ok(!sent.includes("DECOY_BODY_MARK"), "未传进来的诱饵折正文不许出现");
});

test("#896C-3b buildRecallRequest 只拼传入 folds，多折用分隔符、诱饵不入", () => {
  const { text } = buildRecallRequest("Q", [{ round: 1, messageIndex: 0, text: "AAA" }]);
  assert.ok(text.includes("AAA"));
  assert.ok(!text.includes("BBB"));
});

// ─── 格 4：maxTokens 硬顶真的传下去 ────────────────────────────────────────────
test("#896C-4 maxTokens 硬顶 + temperature:0 真的传下去", async () => {
  const { provider, state } = makeFakeProvider();
  await recallOnce(baseDeps({ recallProviderPort: provider }), {
    question: "q", folds: [{ round: 1, messageIndex: 0, text: "b" }],
  });
  assert.equal(state.lastRequest.maxTokens, RECALL_MAX_TOKENS);
  assert.equal(state.lastRequest.maxTokens, 1024, "缺省硬顶 = 1024，与 judge 同量级");
  assert.equal(state.lastRequest.temperature, 0);
});

// ─── 格 5：超时 ⇒ 错误码 recall_timeout ────────────────────────────────────────
test("#896C-5 超时 ⇒ 抛错且 error.code = recall_timeout", async () => {
  const neverProvider = () => new Promise(() => {}); // 永不 resolve
  await assert.rejects(
    () => recallOnce(baseDeps({ recallProviderPort: neverProvider, timeoutMs: 15 }), {
      question: "q", folds: [{ round: 1, messageIndex: 0, text: "b" }],
    }),
    (/** @type {any} */ err) => {
      assert.equal(err.code, "recall_timeout", `期望 recall_timeout，实测 ${err && err.code}`);
      return true;
    },
  );
});

// ─── 格 6：用量进 engine 桶、不进模型轮账 ──────────────────────────────────────
test("#896C-6 用量只进 engine 桶、不进模型轮账（trackLatest:false + account:engine）", async () => {
  const { provider } = makeFakeProvider({ answer: "A", pointers: [], uncertain: false });
  const { addUsage, engine, model } = makeUsageRecorder();
  const r = await recallOnce(baseDeps({ recallProviderPort: provider, addUsage }), {
    question: "q", folds: [{ round: 1, messageIndex: 0, text: "b" }],
  });
  assert.equal(engine.length, 1, "engine 桶必须收到这一发的用量");
  assert.equal(model.length, 0, "模型轮账必须为空");
  assert.equal(engine[0].opts.trackLatest, false);
  assert.equal(engine[0].opts.account, "engine");
  assert.equal(engine[0].round, undefined, "不带轮号（引擎自发起）");
  assert.deepEqual(r.usage, { input_tokens: 11, output_tokens: 7 });
});

// ─── 格 7：recallEvidence 形状 + 每条 ≤2KiB + sha256 与原文一致 ────────────────
test("#896C-7 recallEvidence 形状、≤2KiB、sha256 与原文切片一致", async () => {
  const longText = "字".repeat(3000); // 3000×3 字节 > 2KiB，触发夹断
  const { provider } = makeFakeProvider({ answer: "A", pointers: [], uncertain: false });
  const r = await recallOnce(baseDeps({ recallProviderPort: provider }), {
    question: "q",
    folds: [
      { round: 4, messageIndex: 1, text: "短正文 ABC" },
      { round: 5, messageIndex: 0, text: longText },
    ],
  });
  assert.ok(Array.isArray(r.evidence) && r.evidence.length === 2);
  for (const ev of r.evidence) {
    assert.deepEqual(Object.keys(ev).sort(), ["bytes", "charRange", "messageIndex", "round", "sha256"]);
    assert.ok(Array.isArray(ev.charRange) && ev.charRange.length === 2);
    assert.ok(ev.bytes <= RECALL_MAX_EVIDENCE_BYTES, `bytes=${ev.bytes} 必须 ≤2048`);
    assert.equal(ev.bytes, Buffer.byteLength(
      // sha256 必须落在实际取到的切片上
      (ev.round === 4 ? "短正文 ABC" : longText).slice(ev.charRange[0], ev.charRange[1]),
      "utf8",
    ));
  }
  // sha256 逐字与原文切片一致。
  assert.equal(r.evidence[0].sha256, sha256Hex("短正文 ABC"));
  assert.equal(r.evidence[1].charRange[1] < longText.length, true, "长正文必须被夹断到 <全长");
  assert.equal(
    r.evidence[1].sha256,
    createHash("sha256").update(longText.slice(0, r.evidence[1].charRange[1]), "utf8").digest("hex"),
  );
});

// ─── 格 9：返回必须有 uncertain 字段 ───────────────────────────────────────────
test("#896C-9 返回必含 uncertain 字段；provider 省略时保守回落 true", async () => {
  const withUnc = makeFakeProvider({ answer: "A", pointers: [{ round: 1, messageIndex: 0, charRange: [0, 3] }], uncertain: true });
  const r1 = await recallOnce(baseDeps({ recallProviderPort: withUnc.provider }), { question: "q", folds: [] });
  assert.equal("uncertain" in r1, true);
  assert.equal(r1.uncertain, true);
  assert.deepEqual(r1.pointers, [{ round: 1, messageIndex: 0, charRange: [0, 3] }]);

  // provider 不给 uncertain / 给非法 JSON ⇒ uncertain 仍在（保守 true）。
  const noUnc = makeFakeProvider({ answer: "A", pointers: [] });
  const r2 = await recallOnce(baseDeps({ recallProviderPort: noUnc.provider }), { question: "q", folds: [] });
  assert.equal("uncertain" in r2, true);
  assert.equal(r2.uncertain, true, "省略 uncertain 时保守为 true");

  const notJson = makeFakeProvider("这是一段不是 JSON 的话");
  const r3 = await recallOnce(baseDeps({ recallProviderPort: notJson.provider }), { question: "q", folds: [] });
  assert.equal("uncertain" in r3, true);
  assert.equal(r3.uncertain, true);
  assert.equal(r3.answer, "这是一段不是 JSON 的话");
  assert.deepEqual(r3.pointers, []);
});

// ─── 格 8：recall_read({evidenceRef}) 三态 ─────────────────────────────────────
const LEDGER_TEXT = "第3轮原文：MARKER_R3 逐字内容，用来验证影子。";

function makeLedger() {
  /** @type {any[]} */
  const rows = [{ round: 3, seq: 1, messages: [{ role: "user", content: LEDGER_TEXT }] }];
  return {
    rows,
    readLedgerRows: () => rows,
  };
}

/** 用 recall-runner 对同一份文本算一个合法 evidenceRef（round=3,index=0，全文）。 */
function refForText(text) {
  const { evidence } = buildRecallRequest("q", [{ round: 3, messageIndex: 0, text }]);
  return evidence[0];
}

test("#896C-8a evidenceRef 一致 ⇒ found + 逐字原文", async () => {
  const { readLedgerRows } = makeLedger();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  const ref = refForText(LEDGER_TEXT);
  const out = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: ref } }));
  assert.equal(out.status, "found");
  assert.equal(out.text, LEDGER_TEXT.slice(ref.charRange[0], ref.charRange[1]));
  assert.equal(out.bytes, Buffer.byteLength(LEDGER_TEXT, "utf8"));
});

test("#896C-8b 把账本原文改一个字 ⇒ stale（影子对不上，绝不回差不多的）", async () => {
  const { rows, readLedgerRows } = makeLedger();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  const ref = refForText(LEDGER_TEXT); // 指纹按原文算
  rows[0].messages[0].content = LEDGER_TEXT.replace("验证", "检定"); // 账本改一个字
  const out = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: ref } }));
  assert.equal(out.status, "stale");
  assert.notEqual(out.actualSha, ref.sha256, "actual 与 expected sha 必须不同");
  assert.ok(!("text" in out) || out.text === undefined || out.status === "stale", "stale 时不许冒充 found 的逐字原文");
});

test("#896C-8c ref 不存在于台账 ⇒ invalid", async () => {
  const { readLedgerRows } = makeLedger();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  const ref = refForText(LEDGER_TEXT);
  const missing = { ...ref, round: 999 }; // 账本里没有第 999 轮
  const out = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: missing } }));
  assert.equal(out.status, "invalid");
});

test("#896C-8d messageIndex 越界 / 形状非法 ⇒ invalid", async () => {
  const { readLedgerRows } = makeLedger();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  const ref = refForText(LEDGER_TEXT);
  const oob = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: { ...ref, messageIndex: 42 } } }));
  assert.equal(oob.status, "invalid", "越界 index = 台账里没有这个 ref");

  const badShape = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: { round: 3 } } }));
  assert.equal(badShape.status, "invalid", "形状非法 = invalid");
});

test("#896C-8e evidence 模式优先级高于 round/pattern（既有两模式不被触发）", async () => {
  const { readLedgerRows } = makeLedger();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  const ref = refForText(LEDGER_TEXT);
  // 同时给 round 与 evidenceRef：evidence 优先，走 found 分支（不是逐字整轮 found 的 messages 形状）。
  const out = JSON.parse(await executeTool({ name: "recall_read", input: { round: 3, evidenceRef: ref } }));
  assert.equal(out.status, "found");
  assert.ok("evidenceRef" in out && !("messages" in out), "evidence 分支返回 evidenceRef，不返回逐字模式的 messages");
});

// ─── 格 10：既有两模式逐字不变（evidenceRef 缺席时行为一致）───────────────────
test("#896C-10 不带 evidenceRef 时 round/pattern 两模式行为逐字不变", async () => {
  const { readLedgerRows } = makeLedger();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  // 逐字模式：仍返回 messages 形状，不含 evidenceRef。
  const roundOut = JSON.parse(await executeTool({ name: "recall_read", input: { round: 3 } }));
  assert.equal(roundOut.status, "found");
  assert.equal(roundOut.round, 3);
  assert.ok(Array.isArray(roundOut.messages));
  assert.ok(!("evidenceRef" in roundOut));
  // 两个都没给 ⇒ 仍 invalid（既有的“至少给一个”话术）。
  const noneOut = JSON.parse(await executeTool({ name: "recall_read", input: {} }));
  assert.equal(noneOut.status, "invalid");
  assert.ok(noneOut.reason.includes("round 与 pattern 至少给一个"));
});

// ─── PR #969 复审③：evidence 模式三条校验（缺一不可）──────────────────
// 旧 bug：空区间 [0,0] + 空串 sha256 ⇒ 恒 found，账本怎么改都是 found。现在三条各自 invalid。

test("#896C-11a 空切片 charRange [k,k] ⇒ invalid（旧 bug：[0,0] 恒 found）", async () => {
  const { readLedgerRows } = makeLedger();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  const ref = refForText(LEDGER_TEXT);
  for (const bad of [[0, 0], [2, 2], [ref.charRange[0], ref.charRange[0]]]) {
    const out = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: { ...ref, charRange: bad, bytes: 0 } } }));
    assert.equal(out.status, "invalid", `charRange ${JSON.stringify(bad)} 空切片必须 invalid`);
    assert.ok(/空切片|end 必须严格大于/.test(out.reason ?? ""), "话术含空切片理由");
  }
});

test("#896C-11b 越界 charRange end>原文长度 ⇒ invalid（JS slice 会夹成整段）", async () => {
  const { readLedgerRows } = makeLedger();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  const ref = refForText(LEDGER_TEXT);
  const out = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: { ...ref, charRange: [0, LEDGER_TEXT.length + 500], bytes: undefined } } }));
  assert.equal(out.status, "invalid", "end 超出原文长度必须 invalid（不得回退成整段 stale/found）");
  assert.ok(/越界|超出原文长度/.test(out.reason ?? ""));
});

test("#896C-11c bytes 对不上 ⇒ invalid（ref.bytes ≠ 账本原文切片实际字节）", async () => {
  const { readLedgerRows } = makeLedger();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  const ref = refForText(LEDGER_TEXT); // sha/charRange 均对得上（否则会是 stale）
  const out = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: { ...ref, bytes: ref.bytes + 100 } } }));
  assert.equal(out.status, "invalid", "bytes 对不上 ⇒ invalid（不是 stale）");
  assert.ok(/bytes 对不上/.test(out.reason ?? ""));
});

test("#896C-11d 2 KiB 上限在验证侧也拦（切片字节 > 2048 ⇒ invalid）", async () => {
  // 造一段 >2KiB 的账本原文，手造一个把整段都盖住的 ref（生成侧会夹到 2048，验证侧必须拦超界）。
  const long = "字".repeat(1000); // 1000×3 = 3000 字节 > 2048
  /** @type {any[]} */
  const rows = [{ round: 3, seq: 1, messages: [{ role: "user", content: long }] }];
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => rows });
  const fullRef = buildRecallRequest("q", [{ round: 3, messageIndex: 0, text: long }]).evidence[0];
  // 用全长 charRange（未夹断）+ 与实际字节一致的 bytes：此时字节数超 2048 ⇒ 必须 invalid。
  const out = JSON.parse(await executeTool({
    name: "recall_read",
    input: { evidenceRef: { round: 3, messageIndex: 0, charRange: [0, long.length], sha256: fullRef.sha256, bytes: Buffer.byteLength(long, "utf8") } },
  }));
  assert.equal(out.status, "invalid", "验证侧必须拦 >2KiB 的切片");
  assert.ok(/2048|字节超过|上限/.test(out.reason ?? ""));
  assert.ok(fullRef.bytes <= RECALL_MAX_EVIDENCE_BYTES, "生成侧自己会夹到 ≤2048（对照：全长 ref 才会触发验证侧拦截）");
});
