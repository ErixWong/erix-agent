// issue #386 切片 2（前置 #388）：`fileWrites` 原始写路径台账 + 宿主交付物判据 `deliverables`。
//
// 这一组用例的职责边界：
//   · R0（#388）：`fileWrites[].path` 是 `tool_use.input[pathKey]` 的**原始值**（逐字，可直接 stat），
//     与 `filesWritten[].path`（judge 提示用的 40 码点摘要）分工不同、不许混用；
//   · R1/R2/R3：`deliverables` 的校验、核验时机、以及**机器闸门**（判据失败 ⇒ guard 的 accept 不得
//     产生 verified）；
//   · R4：逐格钉住闸门真值表的四格 + fail-closed 两条 + 反向证。
//
// 三处刻意的写法，改之前请先读完：
//   1. 「未声明 deliverables ⇒ 与今天逐字一致」那一格（R4-1）是本单**唯一**的回归锚：它逐字比较
//      `verification` / `verification.metrics` / payload 的键集合，任何新键漏进未声明路径都会红。
//   2. 闸门四格都用**同一个**天真 guard（只看 finalText 非空就 accept），差别只在 `deliverables`
//      是否声明、以及判据看不看磁盘。这样「机器证据压过 guard 意见」才是唯一变量。
//   3. 判据一律读**磁盘事实**（`fs.existsSync`），不读 payload 里的自报文本——否则测的就是模型嘴。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { buildFinalGuardPayload, FILE_LEDGER_LIMIT } from "../src/loop/termination.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

const toolUse = (id, name, input) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});
const text = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
const wrapup = (object) => ({
  content: [{ type: "text", text: JSON.stringify(object) }],
  stopReason: "end_turn",
});

/** 真写盘：`executeTool` 把 `writeFile` 的 input 落到磁盘（否则「文件存在」不是磁盘事实）。 */
const diskWriteTool = async (call) => {
  mkdirSync(dirname(call.input.path), { recursive: true });
  writeFileSync(call.input.path, call.input.content ?? "");
  return "ok";
};

/** 天真 guard：只看终稿有没有字。它**永远** accept —— 橡皮章的原型。 */
const rubberStampGuard = async (payload) => (String(payload.finalText).length > 0
  ? { action: "accept" }
  : { action: "revise", message: "空终稿" });

// ── R0（issue #388）：原始写路径逐字正确 ──────────────────────────────────────────
test("#388 fileWrites[].path 是 input 原值（>40 码点长路径逐字相等），filesWritten 仍是 40 码点摘要", async () => {
  const dir = await makeTmp("erix-deliverables-fw-");
  // 故意造一条 > 40 码点的深路径：摘要会把它截成前 40 个字符（不带省略号、不带截断标记）。
  const deep = `${dir}/nested/deep/artifact-with-a-very-long-name.txt`;
  assert.ok(Array.from(deep).length > 40, `测试路径不够长（${Array.from(deep).length} 码点），造不出摘要截断`);

  let payload;
  const result = await runToolLoop({
    provider: createFakeProvider([
      toolUse("w1", "writeFile", { path: deep, content: "42" }),
      wrapup({ done: true, summary: "已写入", output: "done" }),
    ]),
    initialUserMessage: `把 42 写进 ${deep}`,
    cwd: dir,
    maxRounds: 4,
    executeTool: diskWriteTool,
    finalGuard: async (value) => {
      payload = value;
      return { action: "accept" };
    },
  });

  assert.equal(existsSync(deep), true, "真写工具没落到磁盘上（这个用例的判据就是磁盘事实）");
  assert.deepEqual(payload.fileWrites, [{ path: deep, round: 1, tool: "writeFile" }],
    `fileWrites[].path 必须逐字等于 input 原值（实测 ${JSON.stringify(payload.fileWrites)}）`);
  // 对照组：同一个 run 的摘要台账**确实**被截断了 —— 两个键的分工是这条用例的重点。
  assert.equal(payload.filesWritten.length, 1);
  assert.notEqual(payload.filesWritten[0].path, deep, "filesWritten 不该再是原值（它就是 40 码点摘要）");
  assert.equal(Array.from(payload.filesWritten[0].path).length, 40,
    `filesWritten[].path 应仍是 summarizeArgument 的 40 码点摘要，实测 ${payload.filesWritten[0].path}`);
  assert.ok(deep.startsWith(payload.filesWritten[0].path), "摘要必须是原值的前缀（否则不是同一个路径）");
  // 台账与 payload 的两个键都不许带截断标记（只有 1 条，远未到上限）。
  assert.equal("fileWritesTruncated" in payload, false);
  assert.equal("filesWrittenTruncated" in payload, false);
  assert.equal(result.verification.status, "verified");
});

test("#388 fileWrites 与 filesWritten 共用同一个上限常量，超限只留最后 N 条并带 fileWritesTruncated", () => {
  assert.equal(FILE_LEDGER_LIMIT, 50);
  const many = Array.from({ length: FILE_LEDGER_LIMIT + 10 }, (_unused, index) => ({
    path: `f-${index + 1}.txt`,
    round: index + 1,
    tool: "writeFile",
  }));
  const payload = buildFinalGuardPayload({ fileWrites: many }, "end_turn", undefined, 1);
  assert.equal(payload.fileWrites.length, FILE_LEDGER_LIMIT);
  assert.equal(payload.fileWrites[0].path, "f-11.txt", "留下的必须是**最后** N 条（= 最新）");
  assert.equal(payload.fileWrites.at(-1).path, `f-${FILE_LEDGER_LIMIT + 10}.txt`);
  assert.equal(payload.fileWritesTruncated, true);

  const exactly = buildFinalGuardPayload(
    { fileWrites: many.slice(10) },
    "end_turn",
    undefined,
    1,
  );
  assert.equal(exactly.fileWrites.length, FILE_LEDGER_LIMIT);
  assert.equal("fileWritesTruncated" in exactly, false, "恰好 N 条不该出现截断标记");

  // 探不到就不写该键（与 #386 切片 1 的纪律一致）。
  const none = buildFinalGuardPayload({}, "end_turn", undefined, 1);
  assert.equal("fileWrites" in none, false);
});

test("#388 非写工具不进 fileWrites；写工具但没带路径键也不进（不写空壳）", async () => {
  const dir = await makeTmp("erix-deliverables-fw2-");
  let payload;
  await runToolLoop({
    provider: createFakeProvider([
      toolUse("r1", "readFile", { path: `${dir}/whatever.txt` }),
      toolUse("w1", "writeFile", { content: "no path key here" }),
      toolUse("e1", "exec", { command: "echo hi" }),
      wrapup({ done: true, summary: "s", output: "o" }),
    ]),
    initialUserMessage: "x",
    cwd: dir,
    maxRounds: 6,
    executeTool: async () => "ok",
    finalGuard: async (value) => {
      payload = value;
      return { action: "accept" };
    },
  });

  assert.deepEqual(payload.fileWrites, [], `非写工具/无路径键都不许进台账，实测 ${JSON.stringify(payload.fileWrites)}`);
  assert.deepEqual(payload.filesWritten, []);
});
