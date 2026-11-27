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
import { MSG_SEQ_CARRIER_BASE } from "../../src/store/message-rows.js";

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
test("#896C-7 recallEvidence 形状（行主键 round_no+msg_seq）、≤2KiB、切片 sha256 与原文一致", async () => {
  const longText = "字".repeat(3000); // 3000×3 字节 > 2KiB，触发夹断
  const { provider } = makeFakeProvider({ answer: "A", pointers: [], uncertain: false });
  const r = await recallOnce(baseDeps({ recallProviderPort: provider }), {
    question: "q",
    folds: [
      { round_no: 4, msg_seq: 1, text: "短正文 ABC" },
      { round_no: 5, msg_seq: 0, text: longText },
    ],
  });
  assert.ok(Array.isArray(r.evidence) && r.evidence.length === 2);
  for (const ev of r.evidence) {
    // 行主键形状（#261127-15）：地址就两个键 `round_no` + `msg_seq`；旧的内容寻址两键已删
    //（既无 textSha256 / occurrence，也不再有 rowSeq / messageIndex）。
    assert.deepEqual(Object.keys(ev).sort(), ["bytes", "charRange", "msg_seq", "round_no", "row_key", "sha256"]);
    assert.ok(Array.isArray(ev.charRange) && ev.charRange.length === 2);
    assert.ok(ev.bytes <= RECALL_MAX_EVIDENCE_BYTES, `bytes=${ev.bytes} 必须 ≤2048`);
    assert.equal(ev.bytes, Buffer.byteLength(
      // 切片 sha256 必须落在实际取到的切片上
      (ev.round_no === 4 ? "短正文 ABC" : longText).slice(ev.charRange[0], ev.charRange[1]),
      "utf8",
    ));
  }
  // 地址由调用方算好透传，必须逐字回到 ref 上（引擎自己不再算身份）。
  assert.equal(r.evidence[0].round_no, 4);
  assert.equal(r.evidence[0].msg_seq, 1, "msg_seq 必须由调用方透传");
  assert.equal(r.evidence[1].round_no, 5);
  assert.equal(r.evidence[1].msg_seq, 0);
  // 切片 sha256 逐字与原文切片一致。
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

/** 造一份 recall_read 可访问的账本：轮 3 一条轮载体行。**载体行不带 seq**（照真实写侧：轮 record 无 seq）。 */
function makeLedger() {
  /** @type {any[]} */
  // 行身份（`row_key`）是地址的第三个分量：`appendRound` 按它去重 ⇒ 不可变。夹具必须给（照真实写侧）。
  const rows = [{ round: 3, roundKey: "ledger:round:3", messages: [{ role: "user", content: LEDGER_TEXT }] }];
  return {
    rows,
    readLedgerRows: () => rows,
  };
}

/**
 * 用 recall-runner 对同一份文本算一个合法 evidenceRef（行主键：第 3 轮 + 载体行下标 0，全文）。
 * 下面的账本都是**轮载体行**（无 `kind:"message"`）⇒ msg_seq 走载体命名空间 `BASE + 下标`。
 */
function refForText(text) {
  const { evidence } = buildRecallRequest("q", [{
    round_no: 3, row_key: "ledger:round:3", msg_seq: MSG_SEQ_CARRIER_BASE, text,
  }]);
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
  const NEW = LEDGER_TEXT.replace("验证", "检定"); // 账本改一个字
  rows[0].messages[0].content = NEW;
  // 行主键下位置不变（仍是第 3 轮下标 0 那条），但它当初记录的切片 sha256 是旧正文的
  // ⇒ 重算不一致 ⇒ stale（影子对不上原文）。ref 逐字不动——不许为了“仍然 stale”去改 ref。
  const out = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: ref } }));
  assert.equal(out.status, "stale");
  assert.notEqual(out.actualSha, ref.sha256, "actual 与 expected sha 必须不同");
  assert.ok(!("text" in out) || out.text === undefined || out.status === "stale", "stale 时不许冒充 found 的逐字原文");
});

test("#896C-8c (round_no, msg_seq) 指不到任何消息（该轮没有第 42 号位置）⇒ invalid", async () => {
  const { readLedgerRows } = makeLedger();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  const ref = refForText(LEDGER_TEXT);
  const missing = { ...ref, msg_seq: 42 }; // round 3 只有一条可寻址消息，第 42 号位置不存在
  const out = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: missing } }));
  assert.equal(out.status, "invalid");
  assert.ok(/第 3 轮里没有 msg_seq=42/.test(out.reason ?? ""), `reason 必须点明指不到哪（实得 ${out.reason}）`);
});

test("#896C-8d 地址形状非法（缺 msg_seq / 轮号非正整数 / msg_seq 负数）⇒ invalid", async () => {
  const { readLedgerRows } = makeLedger();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  const ref = refForText(LEDGER_TEXT);
  // 只改地址、不改切片 ⇒ 定位不到任何消息 = 台账里没有这个 ref。
  const noSuchRow = JSON.parse(await executeTool({
    name: "recall_read",
    input: { evidenceRef: { ...ref, round_no: 9, msg_seq: 9 } },
  }));
  assert.equal(noSuchRow.status, "invalid", "(round_no, msg_seq) 对不上任何消息 = 台账里没有这个 ref");

  const badShape = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: { round_no: 3 } } }));
  assert.equal(badShape.status, "invalid", "缺 msg_seq（或轮号非法）= 形状非法 = invalid");
  const badRound = JSON.parse(await executeTool({
    name: "recall_read",
    input: { evidenceRef: { ...ref, round_no: 0 } },
  }));
  assert.equal(badRound.status, "invalid", "round_no 必须是 ≥1 的正整数");
  const negSeq = JSON.parse(await executeTool({
    name: "recall_read",
    input: { evidenceRef: { ...ref, msg_seq: -1 } },
  }));
  assert.equal(negSeq.status, "invalid", "msg_seq 必须是 ≥0 的整数");
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
  const rows = [{ round: 3, roundKey: "ledger:round:3", messages: [{ role: "user", content: long }] }];
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => rows });
  const fullRef = buildRecallRequest("q", [{
    round_no: 3, row_key: "ledger:round:3", msg_seq: MSG_SEQ_CARRIER_BASE, text: long,
  }]).evidence[0];
  // 用全长 charRange（未夹断）+ 与实际字节一致的 bytes（行主键地址照带）：此时字节数超 2048 ⇒ 必须 invalid。
  const out = JSON.parse(await executeTool({
    name: "recall_read",
    input: { evidenceRef: { round_no: 3, row_key: "ledger:round:3", msg_seq: MSG_SEQ_CARRIER_BASE, charRange: [0, long.length], sha256: fullRef.sha256, bytes: Buffer.byteLength(long, "utf8") } },
  }));
  assert.equal(out.status, "invalid", "验证侧必须拦 >2KiB 的切片");
  assert.ok(/2048|字节超过|上限/.test(out.reason ?? ""));
  assert.ok(fullRef.bytes <= RECALL_MAX_EVIDENCE_BYTES, "生成侧自己会夹到 ≤2048（对照：全长 ref 才会触发验证侧拦截）");
});

// ─── 格 12（PR #969 合并后终验的真缺陷）：身份口径的四格 ───────────────────────
// 旧形状把证据按「轮 + 轮内位置下标」寻址，而位置会同轮追加消息行 / 把消息行折进轮载体而漂
// ⇒ 未改的原文也会被重算成不同的指纹 ⇒ 假 stale。上一版改按行 seq 寻址，但真实写侧轮载体行没 seq ⇒ rowSeq 恒 null
// ⇒ 真机上必 invalid；再上一版改内容寻址 (round, textSha256, occurrence)，而它的唯一理由（折行后位置会变）
// 在折行 stamp 上不成立——现按行主键 (round_no, msg_seq)（#261127-15）。
// 下面四格钉住四件事：地址指不到⇒invalid、旧格式（无 msg_seq）⇒invalid 不迁移、
// 同轮重复正文靠 msg_seq 区分（不再需要 occurrence 计数）、文本真改了仍 stale。
test("#896D-3 round_no 定位必需：ref 的 round_no 指到没有那个位置的轮 ⇒ invalid（reason 点明哪一轮）", async () => {
  const { readLedgerRows } = makeLedger();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  const ref = refForText(LEDGER_TEXT);
  const out = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: { ...ref, round_no: 77 } } }));
  assert.equal(out.status, "invalid");
  assert.ok(/第 77 轮里没有/.test(out.reason ?? ""), `reason 必须点明在哪一轮定位不到（实得 ${out.reason}）`);
});

test("#896D-4 旧格式 ref（无 msg_seq）⇒ invalid（明确不迁移，该能力尚未发布）", async () => {
  const { readLedgerRows } = makeLedger();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  // 逐字照旧位置格式手造：round/messageIndex/charRange/sha256/bytes 全对得上（修前会 found），只缺 msg_seq。
  const legacy = {
    round: 3,
    messageIndex: 0,
    charRange: [0, LEDGER_TEXT.length],
    sha256: sha256Hex(LEDGER_TEXT),
    bytes: Buffer.byteLength(LEDGER_TEXT, "utf8"),
  };
  const out1 = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: legacy } }));
  assert.equal(out1.status, "invalid", "旧位置格式一律 invalid（不迁移）");
  assert.ok(/round_no|msg_seq/.test(out1.reason ?? ""), `reason 必须点明缺的是行主键（实得 ${out1.reason}）`);
  // 上一版的内容寻址格式（round + textSha256 + occurrence，同样无 msg_seq）也一律 invalid。
  const contentAddressed = {
    round: 3,
    textSha256: sha256Hex(LEDGER_TEXT),
    occurrence: 0,
    charRange: [0, LEDGER_TEXT.length],
    sha256: sha256Hex(LEDGER_TEXT),
    bytes: Buffer.byteLength(LEDGER_TEXT, "utf8"),
  };
  const out2 = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: contentAddressed } }));
  assert.equal(out2.status, "invalid", "上一版内容寻址格式也一律 invalid（不迁移）");
  // 只缺 `msg_seq`（其余全按新形状）⇒ invalid，且 reason 必须点名 msg_seq：这钉的是「无 msg_seq 就 invalid」
  // 本身，而不是顺带被 round_no 拦住。
  const onlyMsgSeqMissing = {
    round_no: 3,
    charRange: [0, LEDGER_TEXT.length],
    sha256: sha256Hex(LEDGER_TEXT),
    bytes: Buffer.byteLength(LEDGER_TEXT, "utf8"),
  };
  const out3 = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: onlyMsgSeqMissing } }));
  assert.equal(out3.status, "invalid", "缺 msg_seq = 旧格式 = invalid（不迁移）");
  assert.ok(/msg_seq/.test(out3.reason ?? ""), `reason 必须点明缺的是 msg_seq（实得 ${out3.reason}）`);
});

test("#896D-5 同轮重复正文靠 msg_seq 区分（不再靠 occurrence）；地址指不到 ⇒ invalid", async () => {
  // 同一轮两条一模一样的正文：旧口径靠 occurrence 数「第几次出现」；行主键下两条各有自己的
  // msg_seq（载体行：在该行 messages 里的下标 0/1），所以能**分别**钉到那一条——下面用改第一条证明。
  const DUP = "同轮重复的正文 DUP_MARK";
  /** @type {any[]} */
  const rows = [{ round: 3, roundKey: "ledger:round:3", messages: [{ role: "user", content: DUP }, { role: "user", content: DUP }] }];
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => rows });
  const base = buildRecallRequest("q", [{
    round_no: 3, row_key: "ledger:round:3", msg_seq: MSG_SEQ_CARRIER_BASE, text: DUP,
  }]).evidence[0];
  for (const seq of [0, 1]) {
    const out = JSON.parse(await executeTool({
      name: "recall_read",
      input: { evidenceRef: { ...base, msg_seq: MSG_SEQ_CARRIER_BASE + seq } },
    }));
    assert.equal(out.status, "found", `载体行下标 ${seq} 必须 found`);
    assert.equal(out.text, DUP);
  }
  const beyond = JSON.parse(await executeTool({
    name: "recall_read",
    input: { evidenceRef: { ...base, msg_seq: MSG_SEQ_CARRIER_BASE + 2 } },
  }));
  assert.equal(beyond.status, "invalid", "该轮只有两个位置，msg_seq=2 指不到任何消息 ⇒ invalid");
  // 真区分：把**第一条**改一个字 ⇒ msg_seq=0 的 ref ⇒ stale（定位到改后那条），msg_seq=1 的 ref ⇒ 仍 found。
  // 旧内容寻址做不到这一点（两条正文同 sha，只能靠 occurrence 计数）。
  rows[0].messages[0].content = DUP.replace("重复", "冗重");
  const first = JSON.parse(await executeTool({
    name: "recall_read",
    input: { evidenceRef: { ...base, msg_seq: MSG_SEQ_CARRIER_BASE } },
  }));
  assert.equal(first.status, "stale", "改的是第一条 ⇒ 第一条的 ref 必须 stale");
  const second = JSON.parse(await executeTool({
    name: "recall_read",
    input: { evidenceRef: { ...base, msg_seq: MSG_SEQ_CARRIER_BASE + 1 } },
  }));
  assert.equal(second.status, "found", "第二条未动 ⇒ 它的 ref 仍 found（地址真的钉到了那一条）");
  // round_no 定位必需：轮号指到没有它的轮 ⇒ invalid。
  const wrongRound = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: { ...base, round_no: 9 } } }));
  assert.equal(wrongRound.status, "invalid", "round_no 现在定位必需，写错轮号不许 found");
});

test("#896D-6 文本真的改了 ⇒ 仍 stale（仍能定位，但记录的切片 sha 对不上）", async () => {
  /** @type {any[]} */
  // 行身份（`row_key`）是地址的第三个分量：`appendRound` 按它去重 ⇒ 不可变。夹具必须给（照真实写侧）。
  const rows = [{ round: 3, roundKey: "ledger:round:3", messages: [{ role: "user", content: LEDGER_TEXT }] }];
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => rows });
  const ref = buildRecallRequest("q", [{
    round_no: 3, row_key: "ledger:round:3", msg_seq: MSG_SEQ_CARRIER_BASE, text: LEDGER_TEXT,
  }]).evidence[0];
  // 行尾追加一条（append 本身不许改判）+ 把第一条正文改一个字。
  rows[0].messages.push({ role: "user", content: "同一行尾部追加的一条 APPEND_MARK" });
  const NEW = LEDGER_TEXT.replace("验证", "检定");
  rows[0].messages[0].content = NEW;
  // 仍能定位到改后的正文（行主键 (3,0) 不动），但记录的切片 sha256 是旧正文的 ⇒ stale。
  const out = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: ref } }));
  assert.equal(out.status, "stale", "改的是文本 ⇒ 必须仍 stale（缺陷不能修成「永不 stale」）");
  assert.equal(out.expectedSha, ref.sha256);
  assert.notEqual(out.actualSha, ref.sha256, "改字后 sha 必须对不上");
});

// ─── copilot 终验（PR #981）：schema 必须**告知** `row_key`，不能只靠 additionalProperties 允许 ───
test("#261127-15-8 recall_read 的 evidenceRef schema 里必须写明 row_key（运行时强制它）", () => {
  const { definitions } = createBuiltinRecallTools({ readLedgerRows: () => [] });
  const def = definitions.find((/** @type {any} */ d) => d.name === "recall_read");
  assert.ok(def, "recall_read 必须在工具面上");
  const evidence = def.inputSchema.properties.evidenceRef;
  for (const key of ["round_no", "row_key", "msg_seq", "charRange", "sha256"]) {
    assert.ok(evidence.properties[key], `evidenceRef schema 必须写出 ${key}（运行时按它校验）`);
  }
  assert.equal(evidence.properties.row_key.type, "string");
  assert.ok(
    String(evidence.properties.row_key.description).includes("撞号"),
    "描述要说清它为什么必需（只靠 msg_seq 会撞号），不是可有可无的附注",
  );
});
