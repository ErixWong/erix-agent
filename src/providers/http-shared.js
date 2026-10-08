// src/providers/http-shared.js — openai/anthropic 两个 provider 共用的 HTTP helper。
//
// issue #175：以下 helper 原先在 `openai.js` 与 `anthropic.js` 中**逐字节完全相同**，
// 此处为纯移动 + 导出（零行为变化、无 API 变化）。有意**不并**的是 `readResponseBody`：
// 两侧实现有差异（各自的读体/流式语义），按 issue 要求保留在各自文件内。
//
// issue #181：宿主注入口 `defaultHeaders` / `extraBody` 的共享实现，两个 provider 行为
// 完全一致。三条红线：
//   1. 受保护 header 不可覆盖：引擎自有的 header（openai 侧 `Authorization`/`Content-Type`，
//      anthropic 侧 `x-api-key`/`anthropic-version`/`content-type`）由引擎独占，宿主同名
//      （大小写不敏感）→ 抛 `TypeError`，不静默忽略。
//   2. header 值不得进日志与错误文案：所有新增文案只带 header **名字**，绝不带值
//      （与 key 脱敏同口径 —— 宿主可能把 per-FDE 虚拟 key 之类放进 header）。
//   3. `extraBody` 与引擎自有字段冲突时引擎字段优先，并显式 warn（宿主不能悄悄改
//      `stream`/`model`）；warn 只打印字段名，不打印值，且每个 provider 实例每个字段只说一次。

import { KitError } from "./errors.js";

export function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function truncateBody(bodyText) {
  return String(bodyText ?? "").slice(0, 500);
}

export function parseJson(bodyText) {
  try {
    return { parsed: true, value: JSON.parse(bodyText) };
  } catch {
    return { parsed: false, value: undefined };
  }
}

export function timeoutError(cause, { phase = "request", elapsedMs } = {}) {
  return new KitError("timeout", "Request timed out", {
    retryable: true,
    phase,
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(cause === undefined ? {} : { cause }),
  });
}

export function fetchOptionsWithTransport(options, transport) {
  if (transport === undefined) return options;
  if (typeof transport === "function") {
    const enhanced = transport(options);
    if (enhanced === undefined) return options;
    if (enhanced === null || typeof enhanced !== "object") {
      throw new TypeError("transport fetch-options enhancer must return an object");
    }
    return enhanced;
  }
  return { ...options, dispatcher: transport };
}
