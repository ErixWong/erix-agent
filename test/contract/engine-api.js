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

  test(`${label}: 包入口导出 parseModelJson 且失败三态可分、失败结果不带 value（issue #307）`, async () => {
    const entry = await getEntry();
    assert.equal(typeof entry.parseModelJson, "function");

    const miss = {
      no_candidate: entry.parseModelJson("纯散文，没有花括号"),
      unparsable: entry.parseModelJson('{"a":,}'),
      shape_mismatch: entry.parseModelJson('{"a":1}', { requireKeys: ["done"] }),
    };
    for (const [kind, result] of Object.entries(miss)) {
      assert.equal(result.ok, false, `${kind} 必须是失败`);
      assert.equal(result.error, kind, `三态必须可分辨，实测：${JSON.stringify(result)}`);
      assert.ok(Array.isArray(result.candidates), `${kind} 必须带 candidates 数组`);
      assert.ok(!("value" in result), `失败结果不许带 value 键：${JSON.stringify(result)}`);
    }

    assert.deepEqual(entry.parseModelJson('{"done":true}'), {
      ok: true,
      value: { done: true },
      via: "json",
      candidates: ['{"done":true}'],
    });
    // topOnly 两档：外层未闭合时，内层残片只在 false 档出现（judge 靠它保持原有语义，issue #309）
    assert.equal(entry.parseModelJson('{"outer":{"done":true}').ok, false);
    assert.equal(entry.parseModelJson('{"outer":{"done":true}').error, "no_candidate");
    assert.deepEqual(
      entry.parseModelJson('{"outer":{"done":true}', { topOnly: false }).value,
      { done: true },
    );
  });
}
