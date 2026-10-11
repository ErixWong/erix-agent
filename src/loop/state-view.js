// @ts-check
// issue #246 step 0：状态视图工厂——按**显式字段清单**为一个共享可变 state 对象生成「活引用视图」，
// 用来替代 src/loop/orchestrator.js 里手写的 get/set 访问器。**本单不接线**（没有任何文件 import 它），
// 所以零运行时行为变化、公共 API 未变；测试见 test/state-view.test.js。
//
// 三条设计红线（同时是 test/state-view.test.js 五条反向证的靶子，改任何一条都会被打红）：
//   1. **活引用**：描述符里只写闭包 `() => state[key]`，构造时**不取值**。所以视图构造后整体替换
//      `state.x = v2`，经视图读 `x` 必须读到 `v2`；反向经视图写也必须落到 state。
//      禁止 `{ ...state }` / `{ ...view }` 这类构造时快照化。
//   2. **不冻结**：`getOnly` 只是「不定义 setter」（ESM 严格模式下对其赋值自然抛 `TypeError`），
//      绝不对返回的数组做 `Object.freeze` / `structuredClone`——调用方必须还能改数组**内容**。
//   3. **禁止 `Proxy`**：返回普通对象，字段面由清单穷尽（第 5 条测试钉住 `Object.keys(view)`）。
//
// spec 条目只有三类：
//   "key"                  → get/set 都转发到 state[key]
//   { key, getOnly: true } → 只定义 getter
//   { key, get } / { key, set } → 计算型 getter / 特殊 setter（例如 splice 保数组身份）

/**
 * 清单条目归一化后的形状（字符串条目等价于只有 key）。
 * @typedef {{ key: string, get?: () => any, set?: (value: any) => void, getOnly?: boolean }} StateViewField
 */

/**
 * 为共享可变 state 生成活引用视图：只定义清单里列出的字段，读写字段时实时穿透到 state。
 * @param {Record<string, any>} state 共享可变状态对象（视图持其**引用**，构造时不复制）
 * @param {ReadonlyArray<string | StateViewField>} spec 显式字段清单
 * @returns {Record<string, any>} 普通对象（`Object.defineProperties` 产出，enumerable + configurable）
 */
export function makeStateView(state, spec) {
  const descriptors = /** @type {Record<string, PropertyDescriptor>} */ ({});
  for (const entry of spec) {
    /** @type {StateViewField} */
    const field = typeof entry === "string" ? { key: entry } : entry;
    const { key, get, set, getOnly = false } = field;
    descriptors[key] = {
      enumerable: true,
      configurable: true,
      get: get ?? (() => state[key]),
      set: getOnly ? undefined : (set ?? ((value) => { state[key] = value; })),
    };
  }
  return Object.defineProperties({}, descriptors);
}
