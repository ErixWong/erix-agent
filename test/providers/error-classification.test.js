// HTTP 状态码 → KitError.code 的分类面（issue #179 A12-A）。
// 这里钉三件事：
//   1) 既有映射逐条不动（408/429/401/403/5xx 的 code 与 retryable 原样）；
//   2) 新增的 400/422 → invalid_request、404 → not_found、409 → conflict 生效；
//   3) 未列出的状态码（含非数字/缺省 status）仍落 "unknown"——
//      新增分类没有把 else 分支吞掉。
// 另有两条「宿主后果」用例：新 code 不进重试路径（retryable 恒 false），
// 且它经 `termination.errorCode`（issue #176）上行到宿主，故宿主可见。

import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../../src/loop/orchestrator.js";
import { KitError, classifyHttpError } from "../../src/providers/errors.js";
import { createFakeProvider } from "../helpers/fake-provider.js";

// ── 1. 映射表 ────────────────────────────────────────────────────────────────
const CLASSIFICATION_TABLE = [
  // 既有映射：code 与 retryable 一个都不许动
  ["408 → timeout（retryable）", 408, "timeout", true],
  ["429 → rate_limited（retryable）", 429, "rate_limited", true],
  ["401 → auth", 401, "auth", false],
  ["403 → auth", 403, "auth", false],
  ["500 → server（retryable）", 500, "server", true],
  ["502 → server（5xx 区间内）", 502, "server", true],
  ["504 → server（5xx 区间内）", 504, "server", true],
  ["599 → server（5xx 上界）", 599, "server", true],
  // issue #179 A12-A 新增
  ["400 → invalid_request", 400, "invalid_request", false],
  ["422 → invalid_request", 422, "invalid_request", false],
  ["404 → not_found", 404, "not_found", false],
  ["409 → conflict", 409, "conflict", false],
  // 守门：else 分支仍在，未列出的状态码不得被新分类吞掉
  ["402 → unknown（未列出的 4xx）", 402, "unknown", false],
  ["405 → unknown（未列出的 4xx）", 405, "unknown", false],
  ["410 → unknown（未列出的 4xx）", 410, "unknown", false],
  ["413 → unknown（未列出的 4xx）", 413, "unknown", false],
  ["415 → unknown（未列出的 4xx）", 415, "unknown", false],
  ["418 → unknown（未列出的 4xx）", 418, "unknown", false],
  ["451 → unknown（未列出的 4xx）", 451, "unknown", false],
  ["499 → unknown（5xx 下界之外）", 499, "unknown", false],
  ["600 → unknown（5xx 上界之外）", 600, "unknown", false],
  ["200 → unknown（2xx 由调用侧另处理）", 200, "unknown", false],
  ["undefined → unknown（缺 status）", undefined, "unknown", false],
  ["null → unknown（缺 status）", null, "unknown", false],
  // 非数字 status：等值比较不猜（落 unknown），但 5xx 的**区间**比较会强转——
  // 这是 408/429/401/403/5xx 就有的既有行为，本轮一个字节没动。
  ['"400" → unknown（字符串不走等值匹配）', "400", "unknown", false],
  ['"500" → server（区间比较强转，既有行为）', "500", "server", true],
];

for (const [label, status, code, retryable] of CLASSIFICATION_TABLE) {
  test(`classifyHttpError：${label}`, () => {
    const error = classifyHttpError(status, "");
    assert.ok(error instanceof KitError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
  });
}

// ── 2. KitError 字段形状未动（issue #179 只扩 code 取值，不改结构） ──────────
test("classifyHttpError 的错误形状不变：可枚举字段与 message/status 透传口径原样", () => {
  const plain = classifyHttpError(400, JSON.stringify({ error: { message: "Invalid request" } }));
  assert.deepEqual(Object.keys(plain), ["name", "code", "retryable", "status"]);
  assert.equal(plain.name, "KitError");
  assert.equal(plain.code, "invalid_request");
  assert.equal(plain.message, "Invalid request", "上游 error.message 仍原样透传");
  assert.equal(plain.status, 400);
  assert.equal("phase" in plain, false, "未传 phase 时不写该字段");
  assert.equal("elapsedMs" in plain, false, "未传 elapsedMs 时不写该字段");

  const withMeta = classifyHttpError(409, "boom", { phase: "streamTotal", elapsedMs: 12 });
  assert.deepEqual(Object.keys(withMeta), ["name", "code", "retryable", "status", "phase", "elapsedMs"]);
  assert.equal(withMeta.code, "conflict");
  assert.equal(withMeta.message, "boom", "不可解析的原文仍原样作为 message");
  assert.equal(withMeta.phase, "streamTotal");
  assert.equal(withMeta.elapsedMs, 12);
});

// ── 3. 宿主后果 ──────────────────────────────────────────────────────────────
test("新 code 不进重试路径：retry:{attempts:2} 下 404 仍只调用一次 provider", async () => {
  const notFound = classifyHttpError(404, JSON.stringify({ error: { message: "Unknown model" } }));
  const provider = createFakeProvider([{ throw: notFound }, { throw: notFound }, { throw: notFound }]);

  await assert.rejects(
    runToolLoop({
      provider,
      retry: { attempts: 2 },
      initialUserMessage: "fail",
      executeTool: async () => "unused",
    }),
    (error) => {
      assert.equal(error, notFound, "原样重抛，不包一层");
      return true;
    },
  );
  assert.equal(provider.calls.length, 1, "invalid_request/not_found/conflict 都不是 retryable");
});

test("新 code 经 termination.errorCode 上行到宿主（issue #176 的透传面）", async () => {
  const conflict = classifyHttpError(409, JSON.stringify({ error: { message: "Already exists" } }));
  const provider = createFakeProvider([{ throw: conflict }]);

  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "fail",
      executeTool: async () => "unused",
    }),
    (error) => {
      assert.deepEqual(error.termination, {
        reason: "failed",
        detail: "Already exists",
        errorCode: "conflict",
      }, "宿主此前在这条路径上读到的是 errorCode: \"unknown\"");
      return true;
    },
  );
});
