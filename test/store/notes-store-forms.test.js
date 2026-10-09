// NotesStore 契约套件的「形态兼容性」证据文件（issue #183 裁决 2 / 3B）。
//
// 放宽前后的对照必须能被机器复现，而不是只在文档里声明「两种形态都合法」：
//   * 通用 notesStoreContract 现在同时接住「墓碑」与「物理删除」两种 revoke 形态
//     ——这里用一个物理删除形态的 store 跑完整通用套件（墓碑形态由
//     test/store/notes.test.js 的文件适配器跑）；
//   * 通用套件不再要求并发双写都成功：一个真会拒冲突方的 CAS store 也能跑绿
//     （裁决落地前，LWW 断言会让这种 store 直接变红——本文件末尾两条负控制
//     断言把「旧断言为什么会红」钉住）。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFileNotesStore } from "../../src/store/notes.js";
import { notesStoreCasContract, notesStoreContract } from "../contract/notes-store.js";

const slot = (scopeRef, key) => `${scopeRef} ${key}`;

// 物理删除形态的 NotesStore：revoke 成功后记录从 read/list 上彻底消失。
// 底层复用文件适配器（保留 scope 规范化、时间兜底、purge 时钟等公共语义），
// 只在端口边界上把已撤销的记录遮成「不存在」。
function createPhysicalDeleteNotesStore(options) {
  const inner = createFileNotesStore(options);
  const gone = new Set();
  const hide = async (request) => {
    const record = await inner.read({ scope: request.scope, scopeRef: request.scopeRef, key: request.key });
    return { record, id: slot(record?.scopeRef ?? request.scopeRef, request.key) };
  };
  return {
    async write(request) {
      const record = request.record && typeof request.record === "object"
        ? { ...request.record }
        : request.record;
      // 未指定 scopeRef 的记录按适配器的规范化结果遮罩，这里用请求值先清一次，
      // 写完再按落盘结果确认（复活即续命：写一条已消失的 key = 重新可见）。
      gone.delete(slot(request.scopeRef, request.key));
      await inner.write({ ...request, record });
      const written = await inner.read({
        scope: request.scope, scopeRef: request.scopeRef, key: request.key,
      });
      if (written) gone.delete(slot(written.scopeRef, written.key));
    },
    async read(request) {
      const { record, id } = await hide(request);
      return gone.has(id) ? undefined : record;
    },
    async list(request) {
      const records = await inner.list(request);
      return records.filter((record) => !gone.has(slot(record.scopeRef, record.key)));
    },
    async complete(request) {
      // 只翻 active：被遮掉的记录在底层就是 revoked，complete 本来也不会碰它。
      return inner.complete(request);
    },
    async revoke(request) {
      const { record, id } = await hide(request);
      if (!record || gone.has(id)) return { status: "missing", revoked: 0 };
      if (request.expectedState !== undefined && record.state !== request.expectedState) {
        return { status: "unchanged", revoked: 0 };
      }
      if (
        request.expectedUpdatedAt !== undefined
        && record.updated_at !== request.expectedUpdatedAt
      ) {
        return { status: "unchanged", revoked: 0 };
      }
      const result = await inner.revoke({ ...request, scopeRef: record.scopeRef });
      if (result.status === "found") gone.add(id);
      return result;
    },
    purge: (request) => inner.purge(request),
  };
}

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "erix-notes-forms-"));
  return createPhysicalDeleteNotesStore({ dir });
}

// 墓碑形态之外的第二种合法形态：物理删除。通用套件必须在两种形态下都全绿。
notesStoreContract("physical-delete notes", makeStore);
notesStoreCasContract("physical-delete notes", makeStore);

// CAS 形态：并发写同一 key 时后到的一方被显式拒绝（touwaka 型乐观锁 store 的形状）。
function createCasConflictNotesStore(options) {
  const inner = createFileNotesStore(options);
  const inFlight = new Set();
  return {
    ...inner,
    async write(request) {
      const id = slot(request.scopeRef, request.key);
      if (inFlight.has(id)) {
        throw new TypeError("NotesStore write conflict: another writer holds this record");
      }
      inFlight.add(id);
      try {
        // 让出两个微任务，确保第二个并发写真的撞在同一个在写窗口上。
        await Promise.resolve();
        await Promise.resolve();
        return await inner.write(request);
      } finally {
        inFlight.delete(id);
      }
    },
  };
}

notesStoreCasContract("cas-conflict notes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "erix-notes-cas-"));
  return createCasConflictNotesStore({ dir });
});

// --- 负控制：把「放宽前为什么会红」钉成断言 -------------------------------

test("negative control: a physically deleted record reads as undefined (old tombstone assertion would be red)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "erix-notes-forms-neg-"));
  try {
    const store = createPhysicalDeleteNotesStore({ dir });
    await store.write({
      scope: "run", scopeRef: "form-run", key: "answer",
      record: {
        key: "answer", scope: "run", scopeRef: "form-run",
        current: { content: "v", provenance: { source: "auto" }, ts: "2026-09-15T00:00:00.000Z" },
        superseded: [], folded: 0, tags: [], state: "active",
        created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-15T00:00:00.000Z",
      },
    });
    assert.deepEqual(
      await store.revoke({ scope: "run", scopeRef: "form-run", key: "answer" }),
      { status: "found", revoked: 1 },
    );
    // 放宽前的断言是 `read().state === "revoked"`：这种 store 会在这里抛
    // 「Cannot read properties of undefined」。放宽后它必须恰好是 undefined。
    assert.equal(
      await store.read({ scope: "run", scopeRef: "form-run", key: "answer" }),
      undefined,
    );
    assert.deepEqual(
      await store.revoke({ scope: "run", scopeRef: "form-run", key: "answer" }),
      { status: "missing", revoked: 0 },
      "物理删除形态的重复 revoke 是 missing（放宽后允许 unchanged|missing）",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("negative control: a CAS store rejects the second concurrent writer (old LWW assertion would be red)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "erix-notes-cas-neg-"));
  try {
    const store = createCasConflictNotesStore({ dir });
    const record = {
      key: "answer", scope: "run", scopeRef: "cas-run",
      current: { content: "base", provenance: { source: "auto" }, ts: "2026-09-15T00:00:00.000Z" },
      superseded: [], folded: 0, tags: [], state: "active",
      created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-15T00:00:00.000Z",
    };
    await store.write({ scope: "run", scopeRef: "cas-run", key: "answer", record });
    const attempts = await Promise.allSettled(["left", "right"].map((content) => store.write({
      scope: "run",
      scopeRef: "cas-run",
      key: "answer",
      record: {
        ...record,
        current: { ...record.current, content },
        updated_at: `2026-09-15T00:00:0${content === "left" ? "1" : "2"}.000Z`,
      },
    }).then(() => content)));
    const rejected = attempts.filter((entry) => entry.status === "rejected");
    assert.equal(
      rejected.length,
      1,
      "这个 store 形态下必须恰好有一方被 CAS 拒掉——旧 LWW 断言用 Promise.all 会直接报错",
    );
    const winner = attempts.find((entry) => entry.status === "fulfilled");
    assert.equal(
      (await store.read({ scope: "run", scopeRef: "cas-run", key: "answer" })).current.content,
      winner.value,
      "胜者必须是活下来的那一方",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
