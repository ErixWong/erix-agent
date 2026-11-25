// @ts-check
import { foldSummaryFingerprint } from "../compact/fold-summary-journal.js";
import { reconstructRoundsFromBoundary } from "../messages/rounds.js";
import { Buffer } from "node:buffer";

/**
 * @typedef {object} FoldEntry
 * @property {number} from - 该折覆盖的起始轮号（含）
 * @property {number} to - 该折覆盖的结束轮号（含）
 * @property {string|undefined} foldId - 该折的契约身份（可能缺失 ⇒ untrusted）
 * @property {object[]} payload - 被折掉的原始消息数组（整轮被删后按序拼接，从轮边界开始）
 */

/**
 * 提取一条消息里**模型会看到的文本**：text 块、tool_result 的内容、tool_use 的名字与入参。
 * 目的：让工具轮的原文也带可辨识内容（不再是空串），使逐字取回有真实判据。
 * @param {any} message
 * @returns {string}
 */
function extractText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "tool_result") {
      const inner = block.content;
      if (typeof inner === "string") parts.push(`[tool_result] ${inner}`);
      else if (Array.isArray(inner)) {
        const t = inner
          .filter((/** @type {any} */ b) => b?.type === "text" && typeof b.text === "string")
          .map((/** @type {any} */ b) => b.text)
          .join("\n");
        parts.push(`[tool_result] ${t}`);
      } else {
        parts.push("[tool_result]");
      }
    } else if (block.type === "tool_use") {
      parts.push(`[tool_use ${String(block.name ?? "")} id=${String(block.id ?? "")} ${JSON.stringify(block.input ?? {})}]`);
    }
  }
  return parts.join("\n");
}

/**
 * 计算 JSON 序列化后的 UTF-8 字节长度。
 * @param {any} value
 * @returns {number}
 */
function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * 从 store + runId 构建只读访问器（宿主接线用）。
 * 读取的正是落盘归档那一份，不新增任何轮记录键。
 *
 * @param {{ load: (runId: string) => Promise<any[]> }} store - 转录 store
 * @param {string} runId
 * @returns {() => Promise<FoldEntry[]>}
 */
export function createRecallAccessor(store, runId) {
  return async () => {
    const records = await store.load(runId);
    /** @type {FoldEntry[]} */
    const folds = [];
    for (const record of records) {
      if (record.folded && Array.isArray(record.foldedPayload) && record.foldedPayload.length > 0) {
        folds.push({
          from: record.foldedRoundRange?.from ?? 1,
          to: record.foldedRoundRange?.to ?? 1,
          foldId: record.foldedFacts?.foldId ?? undefined,
          payload: record.foldedPayload,
        });
      }
    }
    return folds;
  };
}

/**
 * 创建 `recall_read` 内置工具的工厂（issue #896 C1）。
 *
 * 默认不挂进任何既有默认工具列表——由宿主显式挂载。
 *
 * @param {{ readFoldedRounds: () => Promise<FoldEntry[]> | FoldEntry[] }} options
 *   只读访问器：返回该 run 已落盘的全部折叠归档。
 * @returns {{ definitions: object[], executeTool: (req: any) => Promise<string> }}
 */
export function createBuiltinRecallTools(options = {}) {
  const accessor = options?.readFoldedRounds;
  if (typeof accessor !== "function") {
    throw new TypeError("createBuiltinRecallTools requires options.readFoldedRounds to be a function");
  }

  const TOOL_DEFINITION = {
    name: "recall_read",
    description:
      "按轮号取回已被折掉的归档原文（逐字）；可核对身份。when-to-use：上下文被折叠后需要取回某轮的原始消息时调用；round 是轮号（1 起），不是数组下标；scope 仅支持 run；轮数与区间对不上时返回 unmappable 而非猜测",
    inputSchema: {
      type: "object",
      properties: {
        round: { type: "integer", minimum: 1 },
        scope: { type: "string", enum: ["run"], default: "run" },
      },
      required: ["round"],
      additionalProperties: false,
    },
  };

  async function executeTool(request) {
    const input = (request && typeof request === "object" && !Array.isArray(request) && typeof request.name === "string")
      ? request.input
      : request;
    return recallRead(input ?? {});
  }

  async function recallRead(input) {
    const { round } = input;

    if (!Number.isSafeInteger(round) || round < 1) {
      return JSON.stringify({ status: "invalid", reason: "round 必须是 ≥1 的正整数", round });
    }

    const scope = input.scope ?? "run";
    if (scope !== "run") {
      return JSON.stringify({ status: "invalid", reason: "scope 仅支持 run", round });
    }

    let folds;
    try {
      folds = await accessor();
    } catch {
      return JSON.stringify({ status: "error", reason: "无法读取折叠归档", round });
    }
    if (!Array.isArray(folds)) folds = [];

    // 找到覆盖该轮的折
    const fold = folds.find((f) => f && Number.isSafeInteger(f.from) && Number.isSafeInteger(f.to) && round >= f.from && round <= f.to);
    if (!fold) {
      return JSON.stringify({ status: "not_folded", round, message: "该轮未被折叠 / 不在归档内" });
    }

    const { payload, foldId, from, to } = fold;

    // 用引擎自己的轮规则还原被折的轮组（与 groupIntoRounds 同源，不另立口径）。
    // payload 由 selectFoldedRounds 选整轮后 flatMap 而来，天然从轮边界开始。
    const reconstructed = reconstructRoundsFromBoundary(payload);
    const reconstructedRounds = reconstructed.length;
    const expectedRounds = to - from + 1;

    // 验证身份：当场用 foldSummaryFingerprint 重算与记录上的 foldId 比对。
    const recomputed = foldSummaryFingerprint({
      messages: payload,
      roundRange: { from, to },
      recoveryHint: null,
    });

    /** @type {"verified"|"untrusted"|"stale"} */
    let trustStatus;
    if (!foldId) trustStatus = "untrusted";
    else if (foldId !== recomputed) trustStatus = "stale";
    else trustStatus = "verified";

    // stale：归档被改写，不给正文。
    if (trustStatus === "stale") {
      return JSON.stringify({
        status: "stale",
        round,
        foldId,
        recomputed,
        message: "该折归档与身份不一致，请重读文件",
        content: null,
        messages: null,
      });
    }

    // 轮数对不上 ⇒ 取回不可靠：明确 unmappable，报两个数，不猜、不按下标硬取、不给正文。
    if (reconstructedRounds !== expectedRounds) {
      return JSON.stringify({
        status: "unmappable",
        round,
        foldRoundRange: { from, to },
        reconstructedRounds,
        expectedRounds,
        trust: trustStatus,
        message: `还原轮数(${reconstructedRounds})与轮区间(to-from+1=${expectedRounds})对不上：归档可能是有界去重差分或被改写过，无法可靠定位该轮`,
        content: null,
        messages: null,
      });
    }

    const roundIndex = round - from; // 0-based，且因上面已保证在 [from,to] 且轮数==区间 ⇒ 必在范围内
    const roundMessages = reconstructed[roundIndex].messages;

    // 该轮第一条消息在 payload 里的序号（全局）
    let globalIndex = 0;
    for (let i = 0; i < roundIndex; i++) globalIndex += reconstructed[i].messages.length;

    const content = roundMessages.map((m) => extractText(m)).join("\n");

    return JSON.stringify({
      status: "found",
      trust: trustStatus,
      round,
      foldRoundRange: { from, to },
      payloadIndex: globalIndex,
      byteLength: byteLength(roundMessages),
      foldId: foldId ?? null,
      content,
      messages: roundMessages,
    });
  }

  return {
    definitions: [TOOL_DEFINITION],
    executeTool,
  };
}
