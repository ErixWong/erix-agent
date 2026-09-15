// ResourceStore 契约测试套件（ADR-014 指针不透明）

import test from "node:test";
import assert from "node:assert/strict";
import { validateResourceStore } from "../../src/store/resource.js";

export function resourceStoreContract(label, createStore) {
  test(`${label}: put/get 文本和字节往返保真`, async () => {
    const store = await createStore();
    const text = "opaque resource\n中文";
    const textRef = await store.put(text);
    assert.equal(typeof textRef.display, "string");
    assert.notEqual(textRef.display.length, 0);
    assert.match(textRef.digest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await store.get(textRef.locator), text);

    const bytes = new Uint8Array([0, 1, 2, 255]);
    const bytesRef = await store.put(bytes);
    assert.deepEqual(await store.get(bytesRef.locator), bytes);
  });

  test(`${label}: 相同内容 digest 相同、不同内容 digest 不同`, async () => {
    const store = await createStore();
    const first = await store.put("same content");
    const second = await store.put("same content");
    const different = await store.put("different content");
    assert.equal(first.digest, second.digest);
    assert.notEqual(first.digest, different.digest);
  });

  test(`${label}: put/get 失败向上抛出`, async () => {
    const putError = new Error("put failed");
    const getError = new Error("get failed");
    const failingStore = validateResourceStore({
      async put() {
        throw putError;
      },
      async get() {
        throw getError;
      },
    });
    await assert.rejects(failingStore.put("resource"), (error) => error === putError);
    await assert.rejects(
      failingStore.get({ id: "resource-aaaaaaaa" }),
      (error) => error === getError,
    );
  });

  test(`${label}: 不同 store 隔离资源`, async () => {
    const first = await createStore();
    const second = await createStore();
    const reference = await first.put("first store");
    await assert.rejects(
      second.get(reference.locator),
      (error) => error?.code === "RESOURCE_NOT_FOUND",
    );
  });

  test(`${label}: 未知 locator 明确失败`, async () => {
    const store = await createStore();
    for (const locator of [{ id: "unknown-resource" }, { id: "resource-00000000-0000-0000-0000-000000000000" }]) {
      await assert.rejects(
        store.get(locator),
        (error) => error?.code === "RESOURCE_NOT_FOUND",
      );
    }
  });

  test(`${label}: 非法资源输入不被静默接受`, async () => {
    const store = await createStore();
    await assert.rejects(
      store.put({ not: "a resource" }),
      (error) => error instanceof TypeError,
    );
  });

  test(`${label}: 返回坏指针的 store 被拒绝`, async () => {
    const badStore = validateResourceStore({
      async put() {
        return { digest: "missing-locator", display: "broken" };
      },
      async get() {
        return "unexpected";
      },
    });
    await assert.rejects(
      badStore.put("resource"),
      (error) => error instanceof TypeError && /locator/u.test(error.message),
    );
  });

  test(`${label}: get 返回非法资源形状时被拒绝`, async () => {
    const badStore = validateResourceStore({
      async put() {
        return { locator: { id: "resource-1" }, digest: "a".repeat(64), display: "memory:1" };
      },
      async get() {
        return { invalid: true };
      },
    });
    await assert.rejects(
      badStore.get({ id: "resource-1" }),
      (error) => error instanceof TypeError && /string or Uint8Array/u.test(error.message),
    );
  });
}
