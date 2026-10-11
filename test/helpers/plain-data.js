// 「可机读面必须是纯数据」的**测试侧**判据（issue #237）。
//
// 为什么自己写一份而不用 `erix-run-format.js` 的 `isPlainJsonData`：那条断言要防的就是
// 「生产代码的守卫自己判错了」。测试拿独立实现的扫描器判，才不会和生产码一起错在一起。
//
// 判据（与 `JSON.stringify` 的实际行为对齐）：
//   允许 —— string / number / boolean / null / undefined / plain object / array
//   拒绝 —— function / symbol / bigint（`JSON.stringify` 会 TypeError）、
//           非 plain 对象（类实例：Promise、AbortController、Timeout、Date…）、循环引用
// 「plain object」用**跨 realm 安全**的式子判（原型为 null，或原型是某个 realm 的
// Object.prototype），不用「原型的原型是 Object.prototype」那种宽松式——类实例正好满足后者。

import assert from "node:assert/strict";

/**
 * 递归找第一处「序列化不了 / 序列化出来是废话」的值。
 * @param {unknown} value
 * @param {string} [where]
 * @param {Set<object>} [stack]
 * @returns {string | undefined} 形如 `$.view.controller: 非 plain 对象（AbortController）`
 */
export function findLivePath(value, where = "$", stack = new Set()) {
  if (value === null || value === undefined) return undefined;
  const type = typeof value;
  if (type === "function" || type === "symbol" || type === "bigint") return `${where}: ${type}`;
  if (type === "string" || type === "number" || type === "boolean") return undefined;
  if (type !== "object") return `${where}: ${type}`;
  if (stack.has(value)) return `${where}: circular`;
  stack.add(value);
  let hit;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      hit = findLivePath(value[i], `${where}[${i}]`, stack);
      if (hit !== undefined) break;
    }
  } else {
    const proto = Object.getPrototypeOf(value);
    const plainProto = proto === null
      || (typeof proto === "object" && safeProtoOfProtoIsNull(proto) && protoNameIsObject(proto));
    if (!plainProto) {
      hit = `${where}: 非 plain 对象（${safeCtorName(value)}）`;
    } else {
      for (const key of Object.keys(value)) {
        hit = findLivePath(value[key], `${where}.${key}`, stack);
        if (hit !== undefined) break;
      }
    }
  }
  stack.delete(value);
  return hit;
}

function safeProtoOfProtoIsNull(proto) {
  try {
    return Object.getPrototypeOf(proto) === null;
  } catch {
    return false;
  }
}

function protoNameIsObject(proto) {
  try {
    return proto.constructor?.name === "Object";
  } catch {
    return false;
  }
}

function safeCtorName(value) {
  try {
    return value?.constructor?.name ?? "?";
  } catch {
    return "?";
  }
}

/**
 * 一条 `AgentToolResult` 是否「宿主可以安全落盘 / 转发」：
 *   1. `content[0].text` 非空（文本面不能因为组装而变空）；
 *   2. `JSON.stringify(details)` **不抛**（#237 的原始缺陷就是它抛
 *      `Converting circular structure to JSON`，白烧一轮 auto-retry）；
 *   3. `details` 递归扫描后只含 plain 数据（没有函数 / 定时器 / promise / 循环引用）；
 *   4. 整个结果对象与 `content` / `structuredContent` 同样可序列化。
 *
 * @param {any} result
 * @param {string} label 出错时点名是哪条返回路径
 */
export function assertMachineReadableResult(result, label) {
  assert.ok(result !== null && typeof result === "object", `${label}: 必须返回一个结果对象`);
  assert.ok(Array.isArray(result.content) && result.content[0]?.type === "text", `${label}: content[0] 必须是 text`);
  assert.equal(
    typeof result.content[0].text === "string" && result.content[0].text.trim() !== "",
    true,
    `${label}: 文本面不能是空的`,
  );
  const live = findLivePath(result.details);
  assert.equal(live, undefined, `${label}: details 里不许有活对象/循环引用，实测 ${live}`);
  assert.doesNotThrow(() => JSON.stringify(result.details), `${label}: JSON.stringify(details) 不能抛`);
  assert.doesNotThrow(() => JSON.stringify(result), `${label}: 整个 AgentToolResult 不能抛`);
  assert.doesNotThrow(() => JSON.stringify(result.content), `${label}: content 不能抛`);
  if (result.structuredContent !== undefined) {
    assert.equal(findLivePath(result.structuredContent), undefined, `${label}: structuredContent 里不许有活对象`);
    assert.doesNotThrow(
      () => JSON.stringify(result.structuredContent),
      `${label}: JSON.stringify(structuredContent) 不能抛`,
    );
  }
}
