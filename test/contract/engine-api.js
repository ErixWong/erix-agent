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
