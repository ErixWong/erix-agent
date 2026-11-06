// issue #739 独立评审必修 1：契约套件**不许写宿主对象**。
//
// 修前的做法是把计数器 wrapper 直接赋到宿主 store 的方法上（`store[method] = wrapped`），并在
// 赋值外面包了一层 try/catch 说「计数器不可用就继续跑」。那句注释与行为互相矛盾：模块是严格模式，
// 往 `Object.freeze` 过的对象上赋属性**抛 TypeError**，被 catch 吞掉 ⇒ 调用计数恒 0 ⇒ 收尾那条
// 「实现 ⇒ 每个方法调用计数 > 0」的核对把一具好实现判成红。评审实跑冻结 memory store = exit 1，
// 本片在同一棵树上复现到同样的两格红（`run snapshot/run-state 写失败向上抛出` 撞
// `Cannot assign to read only property 'saveRunSnapshot'`，收尾格停在 `pending`）。
//
// 选定的策略是**支持冻结 store**：计数与「写失败」临时桩都只落在套件自己造的浅壳上
// （`test/contract/transcript-store.js` 的 `countingView`），宿主对象一个字段也不写。
// 本文件就是钉住这条策略的用例——两个方向都钉：
//   · 冻结的 store 必须整套通过（把套件改回「往宿主身上写」⇒ 本文件立刻红）；
//   · 跑完之后宿主 store 的 own 属性面必须与跑之前逐字相同（写了 wrapper 就红）。
// 第二个方向是防「拔掉钉子」：有人为了变绿把 `Object.freeze` 删掉，也会在这里红。
//
// 另一个 label 用 **class 实现**（方法在原型上、不是 own 属性）并实现 `rawRows` 组，钉住
// 计数壳沿原型链镜像这一半：`countingView` 若退化成 `Object.assign(shell, host)`，
// 原型上的方法就全丢了，这个 label 会整套红。
import test from "node:test";
import assert from "node:assert/strict";

import { transcriptStoreContract } from "../contract/transcript-store.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { foldMessageRows } from "../../src/store/message-rows.js";
import {
  dedupConflictError,
  payloadFingerprint,
  recordKey,
} from "../../src/store/transcript-dedup.js";

/** 内置 memory store 的 own 属性面（跑套件之前取，用来证明跑完之后没被改写）。 */
const MEMORY_SURFACE = Object.freeze(Object.keys(createMemoryTranscriptStore()).sort());
/** 工厂被调用过几次、产出的每个 store 长什么样，收尾自证用例要看。 */
const capturedMemoryStores = [];

transcriptStoreContract("frozen-memory", () => {
  const store = Object.freeze(createMemoryTranscriptStore());
  capturedMemoryStores.push(store);
  return store;
}, {
  // 与内置注册同一份声明：冻结不改变「实现了哪些可选能力」这件事。
  optionalCapabilities: ["runSnapshot", "runState", "runStateStatus", "rawRows"],
});

/** 只有必需面 + `rawRows` 的 class 实现：方法挂在**原型**上，且实例被冻结。 */
class ClassStore {
  #rows = new Map();

  async appendRound(runId, record) {
    const list = this.#rows.get(runId) ?? [];
    const key = recordKey(runId, record);
    const existing = list.find((item) => recordKey(runId, item) === key);
    if (existing !== undefined) {
      const incoming = payloadFingerprint(record);
      const previous = payloadFingerprint(existing);
      if (previous !== incoming) {
        throw dedupConflictError({ runId, key, existing, incoming: record, existingFingerprint: previous, incomingFingerprint: incoming });
      }
      return;
    }
    list.push(structuredClone(record));
    this.#rows.set(runId, list); // 只改 Map 内容，不给冻结的实例赋新属性
  }

  async load(runId) {
    return foldMessageRows(this.#rawRows(runId));
  }

  async loadRawRows(runId) {
    return this.#rawRows(runId);
  }

  #rawRows(runId) {
    return (this.#rows.get(runId) ?? []).map((record) => structuredClone(record));
  }
}

const capturedClassStores = [];
transcriptStoreContract("frozen-class", () => {
  const store = Object.freeze(new ClassStore());
  capturedClassStores.push(store);
  return store;
}, {
  // 原型上的可选能力同样必须被镜像、被计数、被判成 exercised（否则这条钉子是空的）。
  optionalCapabilities: ["rawRows"],
});

test("frozen-memory: 套件跑完之后宿主 store 的 own 属性面一字未变（必修 1 的钉子）", () => {
  assert.ok(capturedMemoryStores.length > 0, "工厂一次都没被调用 ⇒ 上面那 28 格没跑（注册被删了？）");
  for (const [index, store] of capturedMemoryStores.entries()) {
    assert.ok(Object.isFrozen(store), `第 ${index} 个夹具不再生成冻结 store ⇒ 解冻等于把本单的钉子拔掉`);
    assert.deepEqual(Object.keys(store).sort(), [...MEMORY_SURFACE],
      `第 ${index} 个宿主 store 的 own 属性面被改写了（多半是又把计数器 wrapper 赋到宿主身上）`);
    // wrapper 落在宿主上时，方法自身会带计数闭包：原函数的源码里不含这些名字，逐个方法核对一遍。
    assert.doesNotMatch(String(store.saveRunSnapshot), /calls\.set/,
      "宿主方法被换成了计数器 wrapper：契约套件不许写宿主对象");
  }
});

test("frozen-class: 原型方法也被镜像并计数（rawRows 声明过就必须在账本里 exercised）", async () => {
  assert.ok(capturedClassStores.length > 0, "工厂一次都没被调用 ⇒ `frozen-class` 那 28 格没跑");
  for (const store of capturedClassStores) {
    assert.ok(Object.isFrozen(store), "class 夹具必须保持冻结");
    assert.equal(Object.hasOwn(store, "loadRawRows"), false,
      "class 实现的 `loadRawRows` 必须在**原型**上（own 属性版会绕掉本用例要钉的那一半）");
    assert.equal(typeof store.loadRawRows, "function", "原型方法必须还能取到");
  }
  // 账本那半边由上面那条 `frozen-class: 能力守卫成对` 用例核对：计数壳若丢了原型方法，
  // 它会以「声明提供 rawRows，但 store 上没有整组方法」红出来（不是这里重复的事）。
});
