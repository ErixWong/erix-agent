// 确定性召回工具 recall_read 的契约测试套件（issue #896 C1）。
//
// 形状照 test/contract/tool-result-envelope.js / file-tools.js：导出一个
// `recallToolsContract(label, getEntry)` harness，宿主实现可
// `recallToolsContract("my-host", async () => await import("erix-agent"))` 跑同一组断言；
// 本仓底部用「reference」对内置实现自跑一遍（`node --test test/contract/recall-tools.js`）。
//
// 契约面：
//   1. 入口（`erix-agent` 的 src/index.js）必须导出 `createBuiltinRecallTools`，且是函数；
//   2. 产出的工具定义形状：name === "recall_read"、inputSchema.required 含 "round"、
//      additionalProperties === false；
//   3. executeTool 读账本行取回某轮：返回的 messages 与账本里那一轮**逐字相等**（真比字符串，
//      不是恒真）；账本没有该轮 ⇒ status "not_folded" 且**没有** messages 字段。

import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// 仓内消费者：从**包入口**静态引这个名字（opt-in 工具，仓内不自动挂载，故本套件即其消费者）。
import { createBuiltinRecallTools } from "../../src/index.js";

/**
 * @param {string} label 套件标签（宿主用自己的实现名）
 * @param {() => Promise<{ createBuiltinRecallTools: (o: any) => { definitions: any[], executeTool: (req: any) => Promise<string> } }>} getEntry
 *   返回包入口模块（含 `createBuiltinRecallTools`）。
 */
export function recallToolsContract(label, getEntry) {
  test(`${label} · createBuiltinRecallTools 从包入口可拿到，且是函数`, async () => {
    const entry = await getEntry();
    assert.equal(typeof entry.createBuiltinRecallTools, "function",
      "包入口必须导出 createBuiltinRecallTools（函数）");
  });

  test(`${label} · 工具定义形状：name/required/additionalProperties`, () => {
    const { definitions } = createBuiltinRecallTools({ readLedgerRows: () => [] });
    assert.equal(definitions.length, 1);
    const tool = definitions[0];
    assert.equal(tool.name, "recall_read");
    // issue #896 §3-B（PR #964 第二轮 P0）：`round` **不再是必填**。本工具的全部价值就是
    // 「记得写过、记不得第几轮」时用 `pattern` 检索，若 schema 仍强制 `round`，合规调用方
    // 根本调不通那条路。「至少给一个」这条约束在实现里校验（两个都没给 ⇒ status: invalid）。
    const required = tool.inputSchema.required;
    assert.ok(required === undefined || (Array.isArray(required) && !required.includes("round")),
      "inputSchema.required 不许强制 round（否则 pattern-only 的调用方调不通）");
    assert.equal(tool.inputSchema.additionalProperties, false);
  });

  test(`${label} · 账本直读：取回逐字相等；无该轮 ⇒ not_folded 且无 messages`, async () => {
    // 手搓两轮的行：round 2 = 一条消息行（崩溃轮，无载体），round 3 = 一条轮载体行。
    const userMsg = { role: "user", content: "RECALL_MSGROW_R2_" + "u".repeat(24) };
    const asstMsg = { role: "assistant", content: "RECALL_CARRIER_R3_" + "a".repeat(24) };
    const rows = [
      { kind: "message", round: 2, seq: 0, messages: [userMsg] },
      { round: 3, messages: [asstMsg] },
    ];
    const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => rows });

    // 消息行轮：逐字相等（真比字符串，不是恒真）
    const r2 = JSON.parse(await executeTool({ name: "recall_read", input: { round: 2 } }));
    assert.equal(r2.status, "found");
    assert.deepEqual(r2.messages, [userMsg]);
    assert.equal(JSON.stringify(r2.messages), JSON.stringify([userMsg]));

    // 载体行轮：同样逐字相等
    const r3 = JSON.parse(await executeTool({ name: "recall_read", input: { round: 3 } }));
    assert.equal(r3.status, "found");
    assert.equal(JSON.stringify(r3.messages), JSON.stringify([asstMsg]));

    // 账本没有该轮：not_folded，且响应里根本没有 messages 字段
    const missing = JSON.parse(await executeTool({ name: "recall_read", input: { round: 99 } }));
    assert.equal(missing.status, "not_folded");
    assert.ok(!("messages" in missing), "not_folded 不得带 messages 字段");
  });

  test(`${label} · grep 模式：pattern 命中 ⇒ 段形状完整、excerpt 是账本原文的逐字子串`, async () => {
    const marker = "GREP_MARKER_" + "z".repeat(18);
    const rows = [
      { round: 2, messages: [{ role: "user", content: `lead ${marker} tail` }] },
      { round: 5, messages: [{ role: "user", content: "nothing here" }] },
    ];
    const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => rows });
    const r = JSON.parse(await executeTool({ name: "recall_read", input: { pattern: marker, fromRound: 1, toRound: 3 } }));
    assert.equal(r.status, "found");
    assert.ok(["substring", "regex"].includes(r.matchedBy), "matchedBy 只能是 substring/regex");
    assert.equal(r.segments.length, 1, "toRound=3 时 round 5 不得进命中");
    const seg = r.segments[0];
    for (const key of ["round", "messageIndex", "excerpt", "bytes", "matchedBy"]) {
      assert.ok(key in seg, `段必须含字段 ${key}`);
    }
    assert.equal(seg.round, 2);
    // excerpt 必须是账本原文的逐字切片（真比子串，不是恒真）。
    assert.ok(rows[0].messages[0].content.includes(seg.excerpt), "excerpt 必须是账本原文的子串");
    assert.ok(seg.excerpt.includes(marker));
    assert.equal(seg.bytes, Buffer.byteLength(seg.excerpt, "utf8"));
  });
}

// 仓内参考跑法：对内置实现跑同一组断言（与宿主通过安装好的包跑的是同一份）。
// 仅在**直接执行本文件**时自跑；被 barrel（`test/contract/index.js` → `./contract-tests`）
// import 时不自跑，否则会把 3 条 TAP 测试塞进任何 import barrel 的宿主进程里。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  recallToolsContract("reference", async () => await import("../../src/index.js"));
}
