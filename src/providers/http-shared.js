// src/providers/http-shared.js — openai/anthropic 两个 provider 共用的 HTTP helper。
//
// issue #175：以下 helper 原先在 `openai.js` 与 `anthropic.js` 中**逐字节完全相同**，
// 此处为纯移动 + 导出（零行为变化）。有意**不并**的是 `readResponseBody`：两侧实现有
// 差异（各自的流式/读体语义），按 issue 要求保留在各自文件内。
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
import { CORE_PAYLOAD_KEYS } from "./payload.js";

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

// ---------------------------------------------------------------------------
// issue #181：宿主注入口（defaultHeaders / extraBody）
// ---------------------------------------------------------------------------

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE_UNSAFE = /[\u0000\r\n]/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultWarn(message) {
  console.warn(message);
}

/**
 * Conflict warner for host-injected request fields: names only, never values,
 * and at most one message per provider instance per field (a misconfiguration
 * is stable across requests and would otherwise spam unattended logs).
 *
 * @param {(message:string)=>void} [warn]
 * @returns {(field:string)=>void}
 */
export function createInjectionWarner(warn = defaultWarn) {
  const warned = new Set();
  return (field) => {
    const marker = String(field);
    if (warned.has(marker)) return;
    warned.add(marker);
    warn(
      `Warning: extraBody field "${marker}" is engine-owned; `
      + "the engine value wins and the host value was ignored.",
    );
  };
}

function headerName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("defaultHeaders keys must be non-empty header names");
  }
  if (!HEADER_NAME_PATTERN.test(name)) {
    throw new TypeError(`defaultHeaders contains an invalid header name: ${name}`);
  }
  return name;
}

function headerValue(name, value) {
  if (typeof value === "string") {
    if (HEADER_VALUE_UNSAFE.test(value)) {
      // The value itself is host-supplied and may be secret: never interpolate it.
      throw new TypeError(`defaultHeaders value for "${name}" must not contain CR, LF, or NUL`);
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  throw new TypeError(`defaultHeaders value for "${name}" must be a string, number, or boolean`);
}

/**
 * Merge host-supplied headers onto the engine-owned request headers. Engine
 * headers are immutable: a host key that collides with one (case-insensitively)
 * throws instead of being silently dropped.
 *
 * @param {Record<string,string>} engineHeaders
 * @param {Record<string,unknown>} [defaultHeaders]
 * @returns {Record<string,string>}
 */
export function resolveRequestHeaders(engineHeaders = {}, defaultHeaders) {
  const headers = { ...engineHeaders };
  if (defaultHeaders === undefined || defaultHeaders === null) return headers;
  if (!isRecord(defaultHeaders)) {
    throw new TypeError("defaultHeaders must be a plain object of header name to value");
  }

  const engineOwned = new Map(
    Object.keys(headers).map((key) => [key.toLowerCase(), key]),
  );
  for (const [name, value] of Object.entries(defaultHeaders)) {
    headerName(name);
    const owner = engineOwned.get(name.toLowerCase());
    if (owner !== undefined) {
      throw new TypeError(
        `defaultHeaders may not override the engine-owned header "${owner}"`,
      );
    }
    if (value === undefined || value === null) continue;
    // defineProperty 而非直接赋值：名字为 `__proto__` 时 `headers[name] = v` 会命中
    // 原型 setter 静默丢弃（独立验收 #181 发现），必须建自有属性。
    Object.defineProperty(headers, name, {
      value: headerValue(name, value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return headers;
}

/**
 * Validate host-supplied extra request-body fields and surface reserved-key
 * conflicts eagerly (at provider construction), where the outcome does not
 * depend on which request fields the engine happens to set.
 *
 * @param {Record<string,unknown>|undefined|null} extraBody
 * @param {(field:string)=>void} [onConflict]
 * @returns {Record<string,unknown>|undefined}
 */
export function resolveExtraBody(extraBody, onConflict) {
  if (extraBody === undefined || extraBody === null) return undefined;
  if (!isRecord(extraBody)) {
    throw new TypeError("extraBody must be a plain object of request-body fields");
  }
  for (const key of Object.keys(extraBody)) {
    if (!CORE_PAYLOAD_KEYS.has(key) || extraBody[key] === undefined) continue;
    onConflict?.(key);
  }
  // 浅拷贝快照：构造后宿主改自己的对象不得改变线上行为。
  return { ...extraBody };
}

/**
 * Copy host body fields into an assembled payload without ever letting them
 * displace an engine-owned field: reserved keys and keys the engine already
 * wrote are dropped (and reported through `onConflict`).
 *
 * @param {object} payload
 * @param {Record<string,unknown>|undefined} extraBody
 * @param {(field:string)=>void} [onConflict]
 * @returns {object}
 */
export function applyExtraBody(payload, extraBody, onConflict) {
  if (extraBody === undefined) return payload;
  for (const [key, value] of Object.entries(extraBody)) {
    if (value === undefined) continue;
    if (CORE_PAYLOAD_KEYS.has(key) || hasOwn(payload, key)) {
      onConflict?.(key);
      continue;
    }
    payload[key] = value;
  }
  return payload;
}

/**
 * Provider-side request injection surface (issue #181): host headers and body
 * fields, validated once at construction and applied on every request.
 *
 * @param {{
 *   engineHeaders: Record<string,string>,
 *   defaultHeaders?: Record<string,unknown>,
 *   extraBody?: Record<string,unknown>,
 *   warn?: (message:string)=>void,
 * }} options
 * @returns {{requestHeaders: ()=>Record<string,string>, applyExtraBody: (payload:object)=>object}}
 */
export function createRequestInjection({
  engineHeaders,
  defaultHeaders,
  extraBody,
  warn = defaultWarn,
} = {}) {
  const headers = resolveRequestHeaders(engineHeaders, defaultHeaders);
  const onConflict = createInjectionWarner(warn);
  const body = resolveExtraBody(extraBody, onConflict);
  return {
    // 逐请求新副本：保持与旧内联字面量一致的行为（两个请求不共享同一个 header 对象），
    // 也避免宿主包装层改写 header 时污染后续请求。
    requestHeaders: () => ({ ...headers }),
    applyExtraBody: (payload) => applyExtraBody(payload, body, onConflict),
  };
}
