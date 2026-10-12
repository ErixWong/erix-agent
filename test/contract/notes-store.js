import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { assertNotesStore } from "../../src/store/notes.js";

const RECORD = {
  key: "answer",
  scope: "run",
  scopeRef: "contract-run",
  current: {
    content: "current",
    provenance: { source: "auto", verified: false },
    ts: "2026-09-15T00:00:00.000Z",
  },
  superseded: [{
    content: "old",
    invalid: true,
    provenance: { source: "agent" },
    ts: "2026-09-14T00:00:00.000Z",
  }],
  folded: 2,
  pinned: true,
  tags: ["value", "auto"],
  relevance: 0.8,
  state: "active",
  created_at: "2026-09-14T00:00:00.000Z",
  updated_at: "2026-09-15T00:00:00.000Z",
  extension: { preserved: true },
};

// ---------------------------------------------------------------------------
// NotesStore 契约套件（issue #183 裁决 2 / 3B / 5 落地）
//
// 本套件是「上游实现的漂移哨兵」（见契约文档「契约测试套件 → 套件能证明什么、
// 不能证明什么」节），不是宿主一致性测试。三个刻意的边界：
//   1. revoke（裁决 3B）：承诺的是**可观察地消失**——`read()` 返回
//      `state:"revoked"` 墓碑**或** `undefined`（物理删除）皆可。「墓碑永不复活」
//      从未是现行承诺，引擎也不消费 revoked 态，所以物理删除型宿主合法。
//   2. 并发（裁决 2）：通用套件**不再要求并发双写都成功**。一写者 LWW 是内置
//      文件适配器的属性，它的断言在 `test/store/notes.test.js`；比较-交换（CAS）
//      型宿主改跑下面的可选子套件 `notesStoreCasContract`。
//   3. limit（裁决 5 上游半边）：>200 条记录时断言「给了 limit 就钳到 200」，
//      并按 `src/store/notes.js` 的 `normalizeListRequest` 实际语义拒绝非法 limit。
//
// issue #265 补盲（只加端口 typedef 已承诺的行为）：filters.state 空数组/
// filters.source 非法值必须抛 TypeError；revoke 传 reason 时，墓碑形态必须能看到
// revoked_at 与 revoke_reason；purge 的 scanned 是 scope 数而非记录数，且 before
// 只能缩小删除窗口。⚠ 本套件是发布面（`./contract-tests`）：这四条会让语义更宽的
// 宿主 adapter 在升级后冒新失败——那是漂移哨兵该报的警，不是套件的误报。
// ---------------------------------------------------------------------------

/**
 * @param {string} label implementation name
 * @param {() => object | Promise<object>} createStore clean store factory
 */
export function notesStoreContract(label, createStore) {
  test(`${label}: rejects a port with missing methods`, () => {
    assert.throws(
      () => assertNotesStore({ write() {}, read() {}, list() {}, complete() {} }),
      /revoke/u,
    );
    assert.throws(
      () => assertNotesStore({
        write() {}, read() {}, list() {}, complete() {}, revoke() {},
      }),
      /purge/u,
    );
  });

  test(`${label}: rejects malformed records before persistence`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    await assert.rejects(
      store.write({
        scope: "run",
        scopeRef: "contract-run",
        key: "answer",
        record: { ...RECORD, current: "not-an-object" },
      }),
      /valid NoteRecord/u,
    );
  });

  test(`${label}: write/read preserves the complete record shape`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    await store.write({
      scope: "run",
      scopeRef: RECORD.scopeRef,
      key: RECORD.key,
      record: RECORD,
    });
    assert.deepEqual(
      await store.read({ scope: "run", scopeRef: RECORD.scopeRef, key: RECORD.key }),
      RECORD,
    );
    // 契约收窄（ADR-018 D3 决策反转）：list 返回朴素数组；不给 limit =
    // 全部匹配记录，给了 limit 钳制最大 200。
    const all = await store.list({ scope: "run", scopeRef: RECORD.scopeRef });
    assert.deepEqual(all, [RECORD]);
    assert.equal(Array.isArray(all), true);
    const limited = await store.list({ scope: "run", scopeRef: RECORD.scopeRef, limit: 5000 });
    assert.deepEqual(limited, [RECORD], "limit 超过 200 钳制后仍是全量结果");
  });

  test(`${label}: missing records are explicit and scopes are isolated`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    assert.equal(
      await store.read({ scope: "run", scopeRef: "contract-run", key: "missing" }),
      undefined,
    );
    const empty = await store.list({ scope: "run", scopeRef: "other-run" });
    assert.deepEqual(empty, []);
  });

  test(`${label}: unsafe scopes round-trip through canonical storage and lifecycle`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    const unsafeScopes = ["../escape", "/tmp/absolute", "a%2fb"];
    for (const [index, scopeRef] of unsafeScopes.entries()) {
      const canonicalScopeRef = `run-h-${createHash("sha256").update(scopeRef).digest("hex").slice(0, 24)}`;
      const record = { ...RECORD, key: `unsafe-${index}`, scopeRef };
      await store.write({
        scope: "run",
        scopeRef,
        key: record.key,
        record,
      });
      const read = await store.read({ scope: "run", scopeRef, key: record.key });
      assert.equal(read.scopeRef, canonicalScopeRef);
      assert.deepEqual(
        (await store.list({ scope: "run", scopeRef })).map((entry) => entry.scopeRef),
        [canonicalScopeRef],
      );
      assert.deepEqual(
        (await store.list({ scope: "run", scopeRef: canonicalScopeRef })).map((entry) => entry.scopeRef),
        [canonicalScopeRef],
      );
      assert.deepEqual(
        await store.complete({ scope: "run", scopeRef }),
        { status: "found", completed: 1 },
      );
      assert.equal(
        (await store.read({ scope: "run", scopeRef: canonicalScopeRef, key: record.key })).state,
        "done",
      );
    }

    // legacy done 记录（expires_at 久远过去）：expires_at 是历史遗留字段，
    // purge 不读它；scope 时钟（最新文件写入）仍在保留期内 → 记录保留。
    const legacyScopeRef = `run-h-${createHash("sha256").update("../legacy").digest("hex").slice(0, 24)}`;
    await store.write({
      scope: "run",
      scopeRef: legacyScopeRef,
      key: "legacy",
      record: {
        ...RECORD,
        key: "legacy",
        scopeRef: legacyScopeRef,
        state: "done",
        expires_at: "2020-01-01T00:00:00.000Z",
      },
    });
    assert.equal(
      (await store.list({ scope: "run", scopeRef: legacyScopeRef })).length,
      1,
    );
    // purge（ADR-018 D7 scope 时钟）：刚写入的 scope 全部豁免。
    const purged = await store.purge({ scope: "run", scopeRef: "live-scope" });
    assert.equal(purged.status, "found");
    assert.equal(purged.purged, 0, "保留期内的 scope 一条不删（含 legacy done）");
    assert.equal(
      (await store.read({ scope: "run", scopeRef: legacyScopeRef, key: "legacy" }))?.state,
      "done",
    );
    for (const [index] of unsafeScopes.entries()) {
      const read = await store.read({
        scope: "run", scopeRef: `run-h-${createHash("sha256").update(unsafeScopes[index]).digest("hex").slice(0, 24)}`, key: `unsafe-${index}`,
      });
      assert.equal(read.state, "done", "保留期内的 done 记录不被 purge 删除");
    }
    await assert.rejects(
      store.purge({ before: "not-a-date" }),
      /parseable date/u,
    );
  });

  // 裁决 5（上游半边）：单条记录证不了 200 上限——造 >200 条钉住钳制阈值，
  // 并按上游 normalizeListRequest 的真实语义拒绝非法 limit（0/负数/非 safe
  // integer 抛错；超过 200 是钳制而不是报错）。
  test(`${label}: list clamps a given limit to 200 and rejects an invalid limit`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    const scopeRef = "contract-bulk-run";
    const total = 205;
    for (let index = 0; index < total; index += 1) {
      const key = `note-${String(index).padStart(3, "0")}`;
      await store.write({
        scope: "run",
        scopeRef,
        key,
        record: { ...RECORD, key, scopeRef },
      });
    }

    const all = await store.list({ scope: "run", scopeRef });
    assert.equal(all.length, total, "不给 limit = 全部匹配记录（>200 也不截断）");
    assert.equal(Array.isArray(all), true);

    const clamped = await store.list({ scope: "run", scopeRef, limit: 5000 });
    assert.equal(clamped.length, 200, "给了 limit 且超过 200：钳制到 200，不是报错");
    const exact = await store.list({ scope: "run", scopeRef, limit: 200 });
    assert.deepEqual(
      exact.map((record) => record.key).sort(),
      clamped.map((record) => record.key).sort(),
      "limit=200 与 limit=5000 命中同一批记录",
    );
    const small = await store.list({ scope: "run", scopeRef, limit: 3 });
    assert.equal(small.length, 3, "小于阈值的 limit 按请求截断");

    // 非法 limit：以 src/store/notes.js:398-405 的实际行为为准——抛 TypeError，
    // 而不是静默归一化成 1。
    for (const limit of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "5"]) {
      await assert.rejects(
        store.list({ scope: "run", scopeRef, limit }),
        (error) => error instanceof TypeError && /positive safe integer/u.test(error.message),
        `limit=${String(limit)} 必须按上游语义抛 TypeError`,
      );
    }
  });

    // 裁决 3B：契约只承诺「可观察地消失」——墓碑形态与物理删除形态都算兑现。
    // expectedState / expectedUpdatedAt 并发护栏与 missing 哨兵语义原样保留。
    // （issue #265：若套件再往「必须墓碑」方向加断言，先重读上面第 1 条边界。）
  test(`${label}: revoke makes the record observably disappear (guards preserved)`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    await store.write({
      scope: "run",
      scopeRef: RECORD.scopeRef,
      key: RECORD.key,
      record: RECORD,
    });
    assert.deepEqual(
      await store.revoke({ scope: "run", scopeRef: RECORD.scopeRef, key: "missing" }),
      { status: "missing", revoked: 0 },
    );
    // expectedState 不匹配 → unchanged，不写入。
    assert.deepEqual(
      await store.revoke({
        scope: "run", scopeRef: RECORD.scopeRef, key: RECORD.key, expectedState: "done",
      }),
      { status: "unchanged", revoked: 0 },
    );
    // expectedUpdatedAt 不匹配（检查后被他人改写）→ unchanged，不写入。
    assert.deepEqual(
      await store.revoke({
        scope: "run",
        scopeRef: RECORD.scopeRef,
        key: RECORD.key,
        expectedState: "active",
        expectedUpdatedAt: "2099-01-01T00:00:00.000Z",
      }),
      { status: "unchanged", revoked: 0 },
    );
    assert.equal(
      (await store.read({ scope: "run", scopeRef: RECORD.scopeRef, key: RECORD.key })).state,
      "active",
    );
    const revoked = await store.revoke({
      scope: "run",
      scopeRef: RECORD.scopeRef,
      key: RECORD.key,
      reason: "test",
      expectedState: "active",
      expectedUpdatedAt: RECORD.updated_at,
    });
    assert.equal(revoked.status, "found");
    assert.equal(revoked.revoked, 1);
    // 裁决 3B：revoke 的可观察承诺 = 记录消失。墓碑与物理删除都算兑现：
    // read() 返回 state:"revoked" 的墓碑，或者干脆 undefined。
    const after = await store.read({
      scope: "run", scopeRef: RECORD.scopeRef, key: RECORD.key,
    });
    assert.ok(
      after === undefined || after.state === "revoked",
      `revoke 后记录必须可观察地消失：undefined 或 state:"revoked"，实际 state=${after?.state}`,
    );
    // 消失的另一种观察面：记录不得仍以 active 形态出现在全量 list 里。
    const stillActive = (await store.list({ scope: "run", scopeRef: RECORD.scopeRef }))
      .filter((record) => record.key === RECORD.key && record.state === "active");
    assert.deepEqual(stillActive, [], "revoke 成功后不得还能读到 active 记录");
    // 重复 revoke 的语义保留：不再多撤销一条。墓碑形态回 unchanged，
    // 物理删除形态记录已不存在 → missing；两者都不得再置 found/revoked:1。
    const repeated = await store.revoke({
      scope: "run", scopeRef: RECORD.scopeRef, key: RECORD.key,
    });
    assert.equal(repeated.revoked, 0, "重复 revoke 不得重复计数");
    assert.ok(
      repeated.status === "unchanged" || repeated.status === "missing",
      `重复 revoke 必须是 unchanged（墓碑）或 missing（物理删除），实际 ${repeated.status}`,
    );
    // issue #265 补盲：端口 typedef 写了 `reason?: string` 与 `revoked_at?`，
    // 墓碑形态下这两者必须可观察（物理删除形态 after===undefined，字段天然
    // 不可见，跳过）。手抄版曾丢 reason、不写 revoked_at，在这里变红。
    if (after !== undefined) {
      assert.ok(
        typeof after.revoked_at === "string" && Number.isFinite(Date.parse(after.revoked_at)),
        `revoke 成功的墓碑必须写可解析的 revoked_at，实际 ${String(after.revoked_at)}`,
      );
      assert.equal(after.revoke_reason, "test", "revoke 的 reason 必须落盘可见（revoke_reason）");
    }
  });

  // issue #265 补盲：typedef 写了 `filters?: {state?: ..., source?: "agent"|"auto", ...}`，
  // 非法值必须抛 TypeError 而不是静默不过滤/过滤成空——「空数组 = 全不过滤」与
  // 「过滤成空」是两个相反的语义，静默的适配器会把宿主的清理循环带沟里。
  test(`${label}: list rejects an empty state array and an unknown source filter`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    await assert.rejects(
      store.list({ scope: "run", scopeRef: "contract-filter-run", filters: { state: [] } }),
      (error) => error instanceof TypeError && /filters\.state/u.test(error.message),
      "空 filters.state 数组必须抛 TypeError（空数组既不是全不过滤也不是静默清空）",
    );
    await assert.rejects(
      store.list({ scope: "run", scopeRef: "contract-filter-run", filters: { source: "bogus" } }),
      (error) => error instanceof TypeError && /filters\.source/u.test(error.message),
      "filters.source 只认 agent/auto，非法值必须抛 TypeError",
    );
  });

  // issue #265 补盲：typedef 写了 `purge: ... => Promise<{status:"found", scanned, purged}>`
  // 且注释口径是 scanned = 扫描的 scope 数、purge 无视 scopeRef 全量清扫、保留期内
  // 刚写的 scope 整本豁免、before 只能缩小窗口。手抄版曾 scanned=记录数且把刚写的
  // 记录全清光，在这里变红。
  test(`${label}: purge scans scopes (not records), exempts fresh scopes, before only shrinks`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    const put = (scopeRef, key) => store.write({
      scope: "run", scopeRef, key, record: { ...RECORD, key, scopeRef },
    });
    await put("contract-purge-a", "a1");
    await put("contract-purge-a", "a2");
    await put("contract-purge-b", "b1");
    const swept = await store.purge({ scope: "run" });
    assert.equal(swept.status, "found");
    assert.equal(swept.scanned, 2, "scanned = 扫描的 scope 数，不是记录数");
    assert.equal(swept.purged, 0, "保留期内刚写入的 scope 整本豁免，一条不删");
    // before 只能缩小删除窗口（取更早的 cutoff），绝不放大：一个 10 年前的 before
    // 把一切都豁免，而不是「按 before 全清」。
    const tenYearsAgo = new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const narrowed = await store.purge({ before: tenYearsAgo });
    assert.equal(narrowed.purged, 0, "更早的 before 只能更保守，不得删得更多");
    assert.equal(
      (await store.list({ scope: "run", scopeRef: "contract-purge-a" })).length,
      2,
      "豁免的 scope 记录必须原样可读",
    );
    assert.equal(
      (await store.list({ scope: "run", scopeRef: "contract-purge-b" })).length,
      1,
    );
  });
}

/**
 * Optional CAS sub-suite (issue #183 裁决 2).
 *
 * A compare-and-swap store is allowed to reject one of two concurrent
 * same-key writers; the general suite therefore no longer asserts that both
 * writers succeed. Hosts whose store does compare-and-swap concurrency control
 * register this sub-suite instead: it asserts the weaker, still-testable
 * promise — the loser fails loudly, the winner's write is the one that stays
 * readable, and the record is never left in a mixed/corrupt shape.
 *
 * @param {string} label implementation name
 * @param {() => object | Promise<object>} createStore clean store factory
 */
export function notesStoreCasContract(label, createStore) {
  test(`${label}: concurrent same-key writers leave one readable winner`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    const scopeRef = "contract-cas-run";
    await store.write({
      scope: "run",
      scopeRef,
      key: RECORD.key,
      record: { ...RECORD, scopeRef },
    });
    const base = await store.read({ scope: "run", scopeRef, key: RECORD.key });
    const attempts = ["left", "right"].map((content) => ({
      ...base,
      current: { ...base.current, content },
      updated_at: `2026-09-15T00:00:0${content === "left" ? "1" : "2"}.000Z`,
    }));
    const settled = await Promise.allSettled(attempts.map((record) => store.write({
      scope: "run",
      scopeRef,
      key: RECORD.key,
      record,
    })));
    const failures = settled.filter((entry) => entry.status === "rejected");
    assert.ok(
      failures.length <= 1,
      `并发双写最多一方失败（另一方必须成功），实际失败 ${failures.length} 方`,
    );
    for (const failure of failures) {
      assert.ok(
        failure.reason instanceof Error,
        "CAS 冲突必须显式抛错，不得静默丢弃写入",
      );
    }
    const final = await store.read({ scope: "run", scopeRef, key: RECORD.key });
    assert.ok(final, "胜者的写入必须可读");
    assert.equal(final.key, RECORD.key);
    assert.ok(
      ["left", "right"].includes(final.current.content),
      "可读记录必须是两次尝试之一的完整形状，不得是混合/半截记录",
    );
    const winner = attempts.find((record) => record.current.content === final.current.content);
    assert.deepEqual(final.current, winner.current, "胜者记录不得被另一方改写掉字段");
    assert.deepEqual(final.superseded, base.superseded, "历史链不得被并发写搅乱");
  });
}
