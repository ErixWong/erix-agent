// 引擎新 API 契约套件（issue #95/#97 收口）：锁定包入口（src/index.js，经
// package.json exports 对宿主暴露）必须导出 appendUserTurn 与
// projectTranscriptForDisplay，且 appendUserTurn 对一个最小 store stub 能完成
// 一次预写。用法：
//   import { engineApiContract } from "erix-agent/contract-tests";
//   engineApiContract("reference", () => import("erix-agent"));
// 同 dedupKey 的跨实例崩溃重跑属单测职责（test/store/append-user-turn.test.js），
// 不进本契约。

import test from "node:test";
import assert from "node:assert/strict";

/**
 * @param {string} label 实现名（测试标题前缀）
 * @param {() => object | Promise<object>} getEntry 返回包入口命名空间
 */
export function engineApiContract(label, getEntry) {
  test(`${label}: 包入口导出 appendUserTurn 与 projectTranscriptForDisplay 且均为 function`, async () => {
    const entry = await getEntry();
    assert.equal(typeof entry.appendUserTurn, "function");
    assert.equal(typeof entry.projectTranscriptForDisplay, "function");
  });

  test(`${label}: 包入口导出 parseReflectionDecision 且返回对象带 via 来源标记（issue #305）`, async () => {
    const entry = await getEntry();
    assert.equal(typeof entry.parseReflectionDecision, "function");
    const fromJson = entry.parseReflectionDecision('{"progress":3,"stalled":true,"continue":false}');
    assert.equal(fromJson.via, "json");
    assert.equal(fromJson.continueFlag, false);
    assert.equal(fromJson.progress, 3);
    assert.equal(entry.parseReflectionDecision("一直在打转，放弃吧").via, "prose_fallback");
  });

  test(`${label}: 包入口导出 parseModelJson，三态失败可分且失败不带 value（issue #307）`, async () => {
    const entry = await getEntry();
    assert.equal(typeof entry.parseModelJson, "function");

    const hit = entry.parseModelJson('前置散文 {"done":true,"reason":"完成"} 尾话');
    assert.equal(hit.ok, true);
    assert.equal(hit.via, "json");
    assert.deepEqual(hit.value, { done: true, reason: "完成" });
    assert.deepEqual(hit.candidates, ['{"done":true,"reason":"完成"}']);

    // 三态失败：一个候选都没有 / 有候选但全解析不了 / 解析成功却形状不合格。
    assert.equal(entry.parseModelJson("纯散文没有花括号").error, "no_candidate");
    assert.equal(entry.parseModelJson('{"a":,}').error, "unparsable");
    assert.equal(entry.parseModelJson('{"confidence":0.5}', { requireKeys: ["done"] }).error, "shape_mismatch");
    // 失败分支不带 value/via 键（宿主可以 `"value" in result` 收窄）。
    for (const miss of [
      entry.parseModelJson("纯散文没有花括号"),
      entry.parseModelJson('{"a":,}'),
      entry.parseModelJson('{"confidence":0.5}', { requireKeys: ["done"] }),
    ]) {
      assert.equal(miss.ok, false);
      assert.ok(!("value" in miss));
      assert.ok(!("via" in miss));
    }
    // 没有 repair：缺右花括不会被补一个 } 再解析。
    assert.equal(entry.parseModelJson('{"a":1').ok, false);
    // topOnly:false 复刻 every-start：外层未闭合时内层残片仍是候选。
    assert.deepEqual(
      entry.parseModelJson('{"outer":{"done":true}', { topOnly: false }).value,
      { done: true },
    );
  });

  test(`${label}: appendUserTurn 对最小 store stub 完成一次预写`, async () => {
    const entry = await getEntry();
    const records = [];
    const store = {
      async load() {
        return records.map((record) => structuredClone(record));
      },
      async appendRound(_key, record) {
        records.push(structuredClone(record));
      },
    };
    const result = await entry.appendUserTurn(store, {
      key: "contract-run",
      text: "contract pre-write",
      messageId: "msg-1",
    });
    assert.equal(result.key, "contract-run");
    assert.equal(result.dedupKey, "contract-run:input:msg-1");
    assert.equal(result.written, true);
    assert.equal(result.round, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0].round, 0);
    assert.equal(records[0].dedupKey, "contract-run:input:msg-1");
    assert.equal(records[0].roundKey, "contract-run:input:msg-1");
    assert.deepEqual(records[0].messages, [
      { role: "user", content: [{ type: "text", text: "contract pre-write" }] },
    ]);
    assert.equal(typeof records[0].ts, "string");

    // 预写行可被展示投影消费（两个新 API 的最小衔接）
    const turns = entry.projectTranscriptForDisplay(records);
    assert.deepEqual(turns.map((turn) => `${turn.role}:${turn.text}`), [
      "user:contract pre-write",
    ]);
  });
}
