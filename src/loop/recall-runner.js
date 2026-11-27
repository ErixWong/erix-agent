// @ts-check
// issue #896 §3-C：单发**回忆调用**单元（仿 judge-runner，但语义只加不减）。
//
// 六条纪律逐字照 `src/loop/judge-runner.js`：
//   · **单发**：一次 provider 调用，无工具、无轮次；
//   · `maxTokens` 硬顶（常量缺省 1024，与 judge 同量级）、`temperature: 0`；
//   · 超时错误码 `recall_timeout`；
//   · 用量 `trackLatest: false` + `account: "engine"`（回忆调用同 judge 是引擎自发起 ⇒ 只进
//     engine 桶、不进模型轮账）；
//   · **不反向 import orchestrator**：run 作用域的东西（`recallProviderPort` / `signal` /
//     `addUsage` / `awaitWithAbort`）全部由调用方**每次调用**经 `deps` 显式传入；
//   · **不是公共导出面**：不被 `src/index.js` 再导出，只被 orchestrator 内部 import。
//
// 与 judge 的唯一语义差异：回忆端口**没有主 provider 兜底**——宿主不提供 `recallProvider`
// ⇒ 该能力**不可用**（返回 `{available:false}`，不抛、不静默降级）。这是 §3-C 的设计点，
// 不是缺陷：回忆是可选增强，缺了它主流程照常跑，但绝不能悄悄拿主 provider 凑数。

import { createHash } from "node:crypto";
import { blocksFor, textFromBlocks } from "./messages.js";

/** `maxTokens` 硬顶：与 judge 同量级（只输出一段 JSON，过大纯浪费）。 */
export const RECALL_MAX_TOKENS = 1024;
/** 每条指纹切片的字节上限（≤2 KiB，§3-C）。 */
export const RECALL_MAX_EVIDENCE_BYTES = 2048;

/**
 * 取一折的**归档正文**（§3-C：只认 `foldedFacts.text` / `.increment`，不是 `compactionStats`——
 * `title`/`description` 只活在 `foldedFacts` 上，#931 实测）。
 * @param {any} fold
 * @returns {string}
 */
function archivedBody(fold) {
  if (typeof fold?.text === "string") return fold.text;
  const inc = fold?.increment;
  if (typeof inc === "string") return inc;
  if (typeof inc?.text === "string") return inc.text;
  return "";
}

/**
 * 把正文切成**不超过 `maxBytes` 字节**的前缀，切在 Unicode 码点边界（绝不切在半截多字节序列上，
 * 否则 UTF-8 重算字节会错）。返回切片与其字节数。
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{ slice: string, bytes: number }}
 */
function prefixWithinBytes(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { slice: text, bytes: Buffer.byteLength(text, "utf8") };
  let slice = "";
  let bytes = 0;
  for (const ch of text) {
    const next = Buffer.byteLength(ch, "utf8");
    if (bytes + next > maxBytes) break;
    slice += ch;
    bytes += next;
  }
  return { slice, bytes };
}

/**
 * 对**切片原文**（UTF-8 字节）算 sha256（§3-C 指纹口径：不是 hash JSON、不是 hash title）。
 * @param {string} slice
 * @returns {string}
 */
export function sha256Hex(slice) {
  return createHash("sha256").update(slice, "utf8").digest("hex");
}

/**
 * 组装单发回忆请求。`folds` 里每一折只贡献它的**归档正文**（截到 ≤2 KiB 的切片），拼成 user 文本；
 * 未被传进来的折（诱饵）不会出现在请求里。同时按「引擎实际读进请求的那段切片」算指纹。
 * 指纹的身份口径（PR #969 终验缺陷）：`rowSeq`（那条消息所在**账本行的 `seq`**）+ `messageIndex`
 * （**该行 `messages[]` 里**的下标）——两者都只追加，所以同轮追加消息行 / 把消息行折进轮载体
 * 只会改「轮内位置」而不会改它们；`round` 透传作冗余提示。`fold.rowSeq` 不是安全整数 ⇒ `null`
 * （调用方给不出稳定身份 ⇒ 验证侧判 invalid，不拿位置猜）。
 * @param {string} question
 * @param {any[]} folds
 * @returns {{ text: string, evidence: Array<{ rowSeq: number|null, round: number, messageIndex: number, charRange: [number, number], sha256: string, bytes: number }> }}
 */
export function buildRecallRequest(question, folds) {
  /** @type {Array<{ rowSeq: number|null, round: number, messageIndex: number, charRange: [number, number], sha256: string, bytes: number }>} */
  const evidence = [];
  const parts = [];
  for (const fold of folds ?? []) {
    const body = archivedBody(fold);
    const { slice, bytes } = prefixWithinBytes(body, RECALL_MAX_EVIDENCE_BYTES);
    const messageIndex = Number.isInteger(fold?.messageIndex) ? fold.messageIndex : 0;
    // 稳定身份：所在账本行的 `seq`（行只追加、永不变）。行没数值 seq ⇒ null（不猜）。
    const rowSeq = Number.isSafeInteger(fold?.rowSeq) ? fold.rowSeq : null;
    // charRange 单位是 UTF-16 下标（`slice` 是 `body` 的前缀）；recall_read 在同一
    // (rowSeq, 行内 messageIndex) 的原文上按同样的下标切片，两侧口径一致才能比对 sha256。
    const charRange = /** @type {[number, number]} */ ([0, slice.length]);
    parts.push(slice);
    evidence.push({
      rowSeq,
      round: Number.isInteger(fold?.round) ? fold.round : 0,
      messageIndex,
      charRange,
      sha256: sha256Hex(slice),
      bytes,
    });
  }
  const text = [
    "问题：",
    question ?? "",
    "",
    "以下是可回忆的归档正文（每段是一条折的原文切片，只许指不许说）：",
    parts.join("\n\n---\n\n"),
  ].join("\n");
  return { text, evidence };
}

/**
 * 解析回忆响应：`{answer, pointers[], uncertain}`。解析不出合法 JSON 时保守回落
 * （`answer` 用原始文本、`pointers=[]`、`uncertain=true`——宁可说不确定，不许假装笃定）。
 * @param {string} rawText
 * @returns {{ answer: string, pointers: Array<{ round: number, messageIndex: number, charRange: [number, number] }>, uncertain: boolean }}
 */
export function parseRecallDecision(rawText) {
  /** @type {any} */
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return { answer: rawText, pointers: [], uncertain: true };
  }
  const answer = typeof parsed.answer === "string" ? parsed.answer : "";
  const pointers = Array.isArray(parsed.pointers)
    ? parsed.pointers
      .filter((/** @type {any} */ p) => p && typeof p === "object" && Array.isArray(p.charRange))
      .map((/** @type {any} */ p) => ({
        round: Number.isInteger(p.round) ? p.round : 0,
        messageIndex: Number.isInteger(p.messageIndex) ? p.messageIndex : 0,
        charRange: /** @type {[number, number]} */ ([p.charRange[0], p.charRange[1]]),
      }))
    : [];
  const uncertain = typeof parsed.uncertain === "boolean" ? parsed.uncertain : true;
  return { answer, pointers, uncertain };
}

/**
 * run 作用域依赖（全部在调用点读，同 judge）。
 * @param {{
 *   recallProviderPort: any,
 *   signal?: any,
 *   addUsage: (response: any, round: number | undefined, opts: { trackLatest: boolean, account: string }) => void,
 *   awaitWithAbort: (promise: Promise<any>) => Promise<any>,
 *   timeoutMs?: number,
 * }} deps
 * @param {{ question: string, folds: any[] }} input
 * @returns {Promise<any>}
 */
export async function recallOnce(deps, { question, folds }) {
  const { recallProviderPort, signal, addUsage, awaitWithAbort, timeoutMs } = deps;

  // 端口优先，且**没有主 provider 兜底**：不提供 ⇒ 不可用（不抛、不降级）。
  const evaluator = recallProviderPort;
  if (evaluator === undefined || evaluator === null) {
    return { available: false, reason: "recallProvider 未提供：回忆能力不可用（不是降级）" };
  }

  const { text, evidence } = buildRecallRequest(question, folds);
  const request = {
    system: "你是回忆检索器，只在给定归档正文里找证据。只输出 JSON。",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    maxTokens: RECALL_MAX_TOKENS,
    temperature: 0,
  };

  let timeoutController;
  let timeoutId;
  let removeParentAbort;
  if (timeoutMs !== undefined) {
    timeoutController = new AbortController();
    request.signal = timeoutController.signal;
    if (signal !== undefined) {
      const onParentAbort = () => timeoutController.abort(signal.reason);
      if (signal.aborted) onParentAbort();
      else signal.addEventListener("abort", onParentAbort, { once: true });
      removeParentAbort = () => signal.removeEventListener("abort", onParentAbort);
    }
  } else if (signal !== undefined) {
    request.signal = signal;
  }

  const responsePromise = Promise.resolve().then(() => (
    typeof evaluator === "function"
      ? evaluator(request)
      : evaluator.chat(request)
  ));

  let response;
  try {
    if (timeoutMs === undefined) {
      response = await awaitWithAbort(responsePromise);
    } else {
      response = await Promise.race([
        awaitWithAbort(responsePromise),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            timeoutController.abort(new Error("Recall timed out"));
            /** @type {Error & {code?: string}} */
            const error = new Error("Recall timed out");
            error.code = "recall_timeout";
            reject(error);
          }, timeoutMs);
        }),
      ]);
    }
  } finally {
    clearTimeout(timeoutId);
    removeParentAbort?.();
  }

  // 回忆调用是引擎自发起 ⇒ 只进 engine 桶（不进模型轮账），与 judge 逐字同款。
  addUsage(response, undefined, { trackLatest: false, account: "engine" });

  const inputTokens = response?.usage?.input_tokens;
  const outputTokens = response?.usage?.output_tokens;
  const usage = Number.isFinite(inputTokens) || Number.isFinite(outputTokens)
    ? {
      ...(Number.isFinite(inputTokens) ? { input_tokens: inputTokens } : {}),
      ...(Number.isFinite(outputTokens) ? { output_tokens: outputTokens } : {}),
    }
    : undefined;

  const rawText = textFromBlocks(blocksFor(response?.content));
  const parsed = parseRecallDecision(rawText);
  return {
    available: true,
    answer: parsed.answer,
    pointers: parsed.pointers,
    uncertain: parsed.uncertain,
    usage,
    raw: rawText,
    evidence,
  };
}
