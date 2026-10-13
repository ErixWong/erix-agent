// erix_run 的**结果形状层**（issue #237）：把「runtime 的 outcome / 同步 payload →
// `AgentToolResult`」从 erix-run.ts 里抽出来，理由与 erix-run-core.js / erix-run-jobs.js 同一条：
// **本文件不 import pi**，所以 `node --test` 能直接加载它、逐条返回路径都能离线断言
// （#237 的缺陷在真进程 rpc 里才炸，就是因为这段形状代码当时只在 erix-run.ts 里，单测碰不到）。
//
// 本文件存在的**唯一主张**（#237）：`AgentToolResult.details` 必须是**可 JSON 序列化的纯数据**。
// 宿主（pi）会把 `details` 序列化进会话记录 / 转发给订阅者，序列化一抛就是
// `Converting circular structure to JSON` → pi 白烧一轮 auto-retry，可机读面在真进程里直接坏掉。
// 原始缺陷：`erix-run-jobs.js` 的 `start()` 返回 `{kind, handle, job}`，`job` 是活对象
// （AbortController / `setTimeout` 句柄 / 未结算 promise，内部还有循环引用），而旧代码把整个
// `outcome` 原样当 `details` 交了出去。
//
// 三条规矩：
//   1. **按 `kind` 组装**，只把该给的那几个字段放进 `details`（活对象 `job` 只留在 dispatch 内部）；
//   2. 交出去之前过一道 `detailsForHost` 守卫：混进活对象/循环引用时**退化成一个小对象**
//      （带 `detailsDropped` 与指名的 `dropReason`），绝不让宿主序列化时抛；
//   3. 文本面（`content[0].text`）照常组装，退化只影响可机读面。
//
// `AgentToolResult` 的字段出处见 erix-run.ts 头部注释（docs/extensions.md / dist 类型）。

import { formatPayloadForModel, toPiUsage } from "./erix-run-core.js";

/** 守卫兜底时 `details` 的判别键（宿主/模型看到它就该知道「这轮的可机读面被丢了」）。 */
export const DETAILS_DROPPED_KEY = "detailsDropped";

/**
 * `diagnostics` → 一行模型可读的自查摘要（#276）。
 *
 * 口径拄 `erix-run-core.js` 的 `formatPayloadForModel`（同步面本来就在打这一行），但只留
 * 「宿主能据此做决定」的那几项；`diagnostics` 不在场（未终局、或注入的 runJob 没给）时返回
 * `undefined`，调用方直接不拼这一行——不拿一行「全是问号」冒充信息。
 */
function diagnosticsLineOf(diagnostics) {
  if (diagnostics === null || typeof diagnostics !== "object") return undefined;
  return `[diagnostics] model=${diagnostics.model ?? "?"}`
    + ` strategy=${diagnostics.strategy ?? "engine default"}`
    + ` compaction=${diagnostics.compaction?.compactedRounds ?? 0}/${diagnostics.compaction?.events ?? 0}`
    + ` observerErrors=${diagnostics.observerErrors?.count ?? 0}`
    + ` persistenceErrors=${diagnostics.persistenceErrors?.count ?? 0}`
    + ` ledgerErrors=${diagnostics.ledgerErrors?.count ?? 0}`
    + ` modelMetadataMissing=${diagnostics.modelMetadataMissing ? "YES" : "no"}`
    + (diagnostics.errorCode ? ` errorCode=${diagnostics.errorCode}` : "")
    + (diagnostics.notesLifecycle
      ? ` notesClosed=${diagnostics.notesLifecycle.completed ?? 0}/errors=${diagnostics.notesLifecycle.errors?.length ?? 0}`
      : "");
}

function ctorNameOf(value) {
  try {
    return value?.constructor?.name ?? "?";
  } catch {
    return "?";
  }
}

/**
 * 「plain object」的**跨 realm 安全**判据：
 *   - 原型是 `null`（`Object.create(null)`）→ plain；
 *   - 原型是**某个 realm 的 `Object.prototype`**（它的原型是 `null`、`constructor.name === "Object"`）→ plain；
 *   - 其余（类实例 / `Date` / `AbortController` / `Timeout` / `Promise`，以及 `Object.create(x)` 挂出来的链）
 *     → 不是 plain：`JSON.stringify` 会把它们掏成 `{}` 或干脆抛，交出去就是废话或事故。
 * 为什么不用「原型的原型是 `Object.prototype` 就算 plain」那种宽松式：类实例正好满足它，
 * 于是 `AbortController` 会被放过去——而 `AbortController` 就是这个单的原始缺陷。
 */
function isPlainObjectLike(value) {
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  if (typeof proto !== "object") return false;
  try {
    return Object.getPrototypeOf(proto) === null && proto.constructor?.name === "Object";
  } catch {
    return false;
  }
}

/**
 * 递归找出第一处「宿主序列化不了 / 序列化出来是废话」的值。
 * 允许：string / number / boolean / null / undefined / plain object / array。
 * 拒绝：function、symbol、bigint（`JSON.stringify` 直接 TypeError）、非 plain 对象（类实例：
 * Promise、AbortController、Timeout、Date…）、**循环引用**（`Converting circular structure to JSON`）。
 *
 * @param {unknown} value
 * @param {string} [where]
 * @param {Set<object>} [stack]
 * @returns {{path:string, reason:string} | undefined}
 */
export function findNonPlainData(value, where = "$", stack = new Set()) {
  if (value === null || value === undefined) return undefined;
  const type = typeof value;
  if (type === "function" || type === "symbol" || type === "bigint") {
    return { path: where, reason: `${type}：宿主序列化不了` };
  }
  if (type === "string" || type === "number" || type === "boolean") return undefined;
  if (type !== "object") return { path: where, reason: `${type}：不是可序列化类型` };
  if (stack.has(value)) {
    return { path: where, reason: "循环引用：JSON.stringify 会抛 Converting circular structure to JSON" };
  }
  stack.add(value);
  let hit;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      hit = findNonPlainData(value[i], `${where}[${i}]`, stack);
      if (hit !== undefined) break;
    }
  } else if (!isPlainObjectLike(value)) {
    hit = { path: where, reason: `非 plain 对象（${ctorNameOf(value)}）：活对象/类实例，交出去只是废话` };
  } else {
    for (const key of Object.keys(value)) {
      hit = findNonPlainData(value[key], `${where}.${key}`, stack);
      if (hit !== undefined) break;
    }
  }
  stack.delete(value);
  return hit;
}

/** 只含 plain JSON 数据？（`detailsForHost` 的快速判据，也是给测试用的公开谓词） */
export function isPlainJsonData(value) {
  return findNonPlainData(value) === undefined;
}

/**
 * `details` 的守卫：纯数据原样交出去（**不复制**，省内存也保住「details 就是那份载荷」的语义）；
 * 混进活对象/循环引用时退化成一个小对象，并指名丢在哪（宁可少给数据，绝不让宿主抛）。
 */
export function detailsForHost(details, kind) {
  const offending = findNonPlainData(details);
  if (offending === undefined) return details;
  const fallback = { detailsDropped: true, dropReason: `${offending.path}: ${offending.reason}` };
  if (kind !== undefined) fallback.kind = kind;
  return fallback;
}

/**
 * 同步终局面（#207 的形状，逐字不变）：`details` 与 `structuredContent` 是**同一个引用**，
 * 都是 core 组装的那份结构化载荷（载荷本身由 core 保证是纯数据，这里再拿守卫兜一道）。
 *
 * @param {any} payload
 * @returns {any}
 */
export function formatSyncResult(payload) {
  const details = detailsForHost(payload, "sync");
  /** @type {any} */
  const result = {
    content: [{ type: "text", text: formatPayloadForModel(payload) }],
    details,
    structuredContent: details,
  };
  // 用户主动取消不算工具失败（那是人的决定）；其余非采纳终局报成 isError，让模型看得见。
  if (payload?.ok !== true && payload?.aborted !== true) result.isError = true;
  const usage = toPiUsage(payload?.usage);
  if (usage !== undefined) result.usage = usage;
  return result;
}

/** 装配/派发链上的最后兜底（erix-run.ts 的 catch）：小对象、可序列化、报 isError。 */
export function formatCrashResult(message) {
  const text = message instanceof Error ? message.message : String(message ?? "");
  /** @type {any} */
  const result = {
    content: [{ type: "text", text: `erix_run 内部异常：${text}` }],
    details: { crashed: true, error: text },
    isError: true,
  };
  return result;
}

/**
 * `action` 查询结果与异步派工句柄 → `AgentToolResult`。
 * **按 `kind` 组装**：`details` 只放该 kind 的那几个字段（不是整个 `outcome`）——
 * `started` → `{kind, handle}`；`status`/`result` → `{kind, source, view}`；
 * `list` → `{kind, jobs, active}`；`cancel` → `{kind, cancelled, view[, message]}`；
 * `unknown-run` → `{kind, runId, message}`；`error` → `{kind, code, message}`；
 * `crashed` → 与 `formatCrashResult` 同一个小对象。
 *
 * @param {any} outcome erix-run-jobs.js 的 dispatch 返回值
 * @returns {any}
 */
export function formatAsyncResult(outcome) {
  const kind = outcome?.kind ?? "error";
  if (kind === "crashed") return formatCrashResult(outcome?.message ?? "");

  const view = outcome?.view;
  /** @type {string[]} */
  const lines = [];
  /** @type {Record<string, unknown>} */
  let details;
  let isError = false;

  if (kind === "started") {
    const handle = outcome?.handle ?? {};
    details = { kind, handle };
    lines.push(
      `已派工（async:true，主会话不阻塞）：runId=${handle.runId} status=${handle.status}`,
      `cwd=${handle.cwd} model=${handle.model ?? "（配置槽位的模型）"} maxRounds=${handle.maxRounds}`
      + ` timeoutMs=${handle.timeoutMs} quiet=${handle.quiet}`,
      handle.sessionDir === null || handle.sessionDir === undefined
        ? "sessionDir=（未落盘：查不到跨 /reload 的状态）"
        : `status.json=${handle.statusPath}`,
      "查进度/取终局：erix_run(action:\"status\"|\"result\", runId=…)；取消：action:\"cancel\"。"
      + "后台 run 与 pi 同进程，pi 退出或 /reload 会杀掉它。",
    );
  } else if (kind === "list") {
    const jobs = Array.isArray(outcome?.jobs) ? outcome.jobs : [];
    details = { kind, jobs, active: outcome?.active ?? jobs.filter((job) => job?.status === "queued" || job?.status === "running").length };
    lines.push(`erix_run 注册表：${jobs.length} 个 run（活跃 ${details.active} 个）`);
    for (const job of jobs) {
      lines.push(
        `- ${job.runId} ${job.status} rounds=${job.rounds}`
        + ` termination=${job.termination?.reason ?? "-"} cwd=${job.cwd ?? "?"}`,
      );
    }
    if (jobs.length === 0) lines.push("（本进程还没有派过工；内存注册表不跨进程重启）");
  } else if (kind === "cancel") {
    const cancelled = outcome?.cancelled === true;
    details = { kind, cancelled, view };
    if (typeof outcome?.message === "string" && outcome.message !== "") details.message = outcome.message;
    lines.push(cancelled
      ? `已请求取消 run ${view?.runId}：signal 已打进内层 run，终局记成 aborted。`
      : `run ${view?.runId} 无需取消（当前状态 ${view?.status}）。${outcome?.message ?? ""}`);
  } else if (kind === "unknown-run" || kind === "error") {
    isError = true;
    const runId = kind === "unknown-run" ? outcome?.runId : undefined;
    details = kind === "unknown-run"
      ? { kind, runId, message: outcome?.message ?? "" }
      : { kind, code: outcome?.code ?? "unknown", message: outcome?.message ?? "" };
    lines.push(`erix_run action 失败（${outcome?.code ?? (kind === "unknown-run" ? "unknown-run" : "error")}）：${outcome?.message ?? ""}`);
  } else {
    // status / result（以及将来新增的 kind：宁可给一份保守的视图，也不把 outcome 原样交出去）
    details = { kind, source: outcome?.source, view };
    lines.push(
      `run ${view?.runId} status=${view?.status} source=${outcome?.source}`,
      `termination=${view?.termination?.reason ?? "（还没终局）"}`
      + (view?.termination?.errorCode ? ` errorCode=${view.termination.errorCode}` : "")
      + ` ok=${view?.ok ?? "-"} rounds=${view?.rounds ?? 0} truncated=${view?.truncated === true}`
      + ` timeout=${view?.timeout === true} aborted=${view?.aborted === true}`
      + ` usage=↑${view?.usage?.input_tokens ?? 0}/↓${view?.usage?.output_tokens ?? 0}`,
      `artifacts transcript=${view?.artifacts?.transcriptPath ?? "none"}`
      + ` judgeLog=${view?.artifacts?.judgeLogPath ?? "none"}`
      + ` extensions=${view?.extensionCount ?? 0}/${view?.maxExtensions ?? 0} resumable=${view?.resumable === true}`,
      `cwd=${view?.cwd ?? "?"} sessionDir=${view?.sessionDir ?? "none"} statusPath=${view?.statusPath ?? "none"}`,
    );
    // #276：异步文本面也得把 diagnostics 的自查结论报出来。工具描述写着「ok:false 先读
    // termination.errorCode / diagnostics」，而模型读的是**文本**——视图里带上了但文本不报，
    // 对模型等于还是没给（同步面 `formatPayloadForModel` 本来就有这一行，口径照它）。
    const diagnosticsLine = diagnosticsLineOf(view?.diagnostics);
    if (diagnosticsLine !== undefined) lines.push(diagnosticsLine);
    for (const failure of view?.diagnostics?.notesLifecycle?.errors ?? []) {
      lines.push(`  ↳ notes 收尾失败（${failure?.operation ?? "?"}）：${failure?.message ?? ""}（不影响终局）`);
    }
    if (kind === "result") {
      // #261：终稿正文进 result 文本。视图层不截断（单一真值），**显示层 4000 字的口径保持不变**；
      // 终稿为空时**明说**「终稿为空」：只给几行状态会把「本来没正文」遮成「看起来像被截断了」。
      if (typeof view?.finalText === "string" && view.finalText !== "") {
        lines.push("", view.finalText.slice(0, 4_000));
      } else {
        lines.push("", "（终稿为空：内层 run 没交回任何正文 —— 不是被 4000 字截断，是本来就没有。）");
      }
    }
    if (Array.isArray(view?.progressTail) && view.progressTail.length > 0) {
      lines.push("", "…最近进度：", ...view.progressTail.slice(-6));
    }
    if (view?.error?.message) lines.push(`[error] ${view.error.message}`);
    if (view?.statusWriteError) lines.push(`[status.json 写入失败] ${view.statusWriteError}`);
    // 查一个「已结束的失败 run」是数据不是调用失败，但让模型看得见它没过：与同步面同口径。
    if (kind === "result" && view?.ok === false) isError = true;
  }

  /** @type {any} */
  const result = {
    content: [{ type: "text", text: lines.join("\n") }],
    details: detailsForHost(details, kind),
  };
  if (isError) result.isError = true;
  const usage = toPiUsage(view?.usage);
  if (usage !== undefined) result.usage = usage;
  return result;
}
