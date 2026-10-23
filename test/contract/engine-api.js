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

import { makeTmp } from "../helpers/tmp.js";

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

  test(`${label}: 包入口导出 normalizeModelJson（异步、带兜底）且与同步 L0 的 parseModelJson 分工不混（issue #406）`, async () => {
    const entry = await getEntry();
    assert.equal(typeof entry.normalizeModelJson, "function");

    // 分工是**契约**，不是实现细节：`parseModelJson` 必须保持同步（#307 的面），
    // `normalizeModelJson` 必须返回 Promise（否则宿主 `await` 它拿到的是值、`await` 另一个拿到的是 Promise，
    // 同一份调用点代码在两条入口上行为不同）。
    assert.ok(!(entry.parseModelJson("{}") instanceof Promise), "parseModelJson 必须保持同步（issue #307 的契约面）");
    const pending = entry.normalizeModelJson("{}");
    assert.ok(pending instanceof Promise, "normalizeModelJson 必须返回 Promise（异步入口）");
    assert.deepEqual(await pending, { ok: true, value: {} });

    // 能解析就不修：`repaired` 只在真的改了文本时出现（没修过就没有这个键，不是 `repaired: null`）。
    assert.deepEqual(await entry.normalizeModelJson('{"done":true}'), { ok: true, value: { done: true } });

    // 失败三态与 #307 **同名同形**，且失败结果**不带 value 键**。
    // ⚠ 三态名一样不等于映射一样，这里逐档钉住两处**真实的**语义差（宿主要按它们分流，不能照搬 #307 的直觉）：
    //   · 纯散文：L0 报 `no_candidate`（一个候选都抽不到），本入口报 `unparsable`（整段原文就是候选、试过不行）；
    //   · 空输入 / 截断：本入口报 `no_candidate`（与 L0 一字不差，不偷偷补括号）。
    const miss = {
      no_candidate: await entry.normalizeModelJson(""),
      unparsable: await entry.normalizeModelJson('{"a":,}'),
      shape_mismatch: await entry.normalizeModelJson('{"a":1}', { validate: () => ({ ok: false }) }),
    };
    for (const [kind, result] of Object.entries(miss)) {
      assert.equal(result.ok, false, `${kind} 必须是失败`);
      assert.equal(result.error, kind, `三态必须可分辨，实测：${JSON.stringify(result)}`);
      assert.ok(!("value" in result), `失败结果不许带 value 键：${JSON.stringify(result)}`);
    }
    assert.equal((await entry.normalizeModelJson("纯散文，没有花括号")).error, "unparsable",
      "纯散文：整段原文就是候选 ⇒ unparsable（与 parseModelJson 的 no_candidate 不是同一档，这是设计稿 §10 的映射）");
    assert.equal(entry.parseModelJson("纯散文，没有花括号").error, "no_candidate");

    // provenance：真的修了才报，且引擎自带规则 ⇒ trusted，宿主注入 ⇒ 不是（D6：替不了宿主证明保字节）。
    assert.deepEqual(await entry.normalizeModelJson('{"done":true,}'), {
      ok: true,
      value: { done: true },
      repaired: { rule: "trailing-comma", trusted: true },
    });

    // 承重不变量：`validate` 的第二个参数是**该候选的原始字节**，不是修后文本。
    // 下面这条宿主注入规则会把 `a\.b` 改成 `a.b`；闸门要求「值能在原文里逐字找到」。
    // 若闸门判的是修后文本，这条会静默放行一个原文里根本不存在的值。
    const raw = '{"path":"a\\.b"}';
    const injected = { id: "host-unescape", apply: (text) => text.replace("a\\.b", "a.b") };
    const passThrough = await entry.normalizeModelJson(raw, { repair: { inject: [injected] } });
    assert.equal(passThrough.ok, true, "无闸门时注入的修复规则生效（对照组）");
    assert.equal(passThrough.value.path, "a.b");
    assert.deepEqual(passThrough.repaired, { rule: "host-unescape", trusted: false });
    const gated = await entry.normalizeModelJson(raw, {
      repair: { inject: [injected] },
      validate: (value, source) => ({ ok: source.includes(value.path) }),
    });
    assert.equal(gated.ok, false, "闸门判原始字节 ⇒ 原文里没有 `a.b`，必须判掉");
    assert.equal(gated.error, "shape_mismatch");

    // 截断输入：默认与 L0 一字不差（`no_candidate`，不偷偷补括号）；显式开补全才救得回来。
    assert.equal((await entry.normalizeModelJson('{"outer":{"done":true}')).error, "no_candidate");
    assert.deepEqual(
      await entry.normalizeModelJson('{"outer":{"done":true}', { repair: { truncateCompletion: true } }),
      { ok: true, value: { outer: { done: true } }, repaired: { rule: "truncation", trusted: true } },
    );
  });

  test(`${label}: 包入口导出 loadModelSlot 与 createProviderForSlot（issue #406 C-a，槽位 → provider 的构造件）`, async () => {
    const entry = await getEntry();
    assert.equal(typeof entry.loadModelSlot, "function");
    assert.equal(typeof entry.createProviderForSlot, "function");

    // `config_missing` 保留（宿主靠 code 分流，不靠文案）：指向一个不存在的配置路径。
    const missing = await entry.loadModelSlot({ configPath: "/nonexistent/erix/config.json" })
      .then(() => null, (err) => err);
    assert.ok(missing, "配置不存在时必须抛，不许返回空槽位");
    assert.equal(missing.code, "config_missing");

    // 必填校验：给了文件但缺 slots.default 的必填字段 ⇒ `config_invalid`，且文案点名缺了什么。
    // 临时目录一律走 `makeTmp`（#185/#199）：裸 `mkdtemp` 不建父目录、没有 TMPDIR 可写探针。
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = await makeTmp("erix-slot-contract-");
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ slots: { default: { endpoint: "https://example.invalid/v1" } } }), "utf8");
    const invalid = await entry.loadModelSlot({ configPath }).then(() => null, (err) => err);
    assert.ok(invalid, "缺必填字段时必须抛");
    assert.equal(invalid.code, "config_invalid");
    assert.match(invalid.message, /model/);

    // 摊平桥接：provider 从槽位来，`maxTokens` 回落到 `maxOutputTokens`，`warn` 一路接进注入守卫（M7）。
    // 槽位里没给 `maxOutputTokens` 时，引擎**不造默认值**（`maxOutputTokens` 键直接不出现，不是 0/undefined）。
    const slot = { endpoint: "https://example.invalid/v1", apiKey: "k", model: "m", maxOutputTokens: 1234, contextWindowTokens: 99999 };
    const provider = entry.createProviderForSlot(slot, { timeoutMs: 1000, warn: () => {} });
    assert.equal(typeof provider.chat, "function");
    assert.equal(provider.protocol, "openai");
    assert.equal(provider.model, "m");
    assert.equal(provider.maxOutputTokens, 1234);
    assert.equal(provider.contextWindowTokens, 99999);
    const bare = entry.createProviderForSlot({ endpoint: "https://example.invalid/v1", apiKey: "k", model: "m" });
    assert.ok(!("maxOutputTokens" in bare), "槽位没给预算元数据就不该凭空造一个");
    assert.throws(() => entry.createProviderForSlot(null), TypeError);
  });
}
