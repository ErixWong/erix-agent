// @ts-check
import { foldSummaryFingerprint } from "../compact/fold-summary-journal.js";
import { Buffer } from "node:buffer";

/**
 * @typedef {object} FoldEntry
 * @property {number} from - 该折覆盖的起始轮号（含）
 * @property {number} to - 该折覆盖的结束轮号（含）
 * @property {string|undefined} foldId - 该折的契约身份（可能缺失 ⇒ untrusted）
 * @property {object[]} payload - 被折掉的原始消息数组
 */

/**
 * 判断一条消息是否为「真实用户轮」——role 是 user 且 content 不全是 tool_result。
 * 与 src/messages/rounds.js 的 isRealUser 口径一致，但不 import 那个模块（避免循环、保持零依赖）。
 * @param {any} message
 * @returns {boolean}
 */
function isRealUserMessage(message) {
  if (!message || message.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return true;
  if (content.length === 0) return true;
  return content.some((/** @type {any} */ block) => block?.type !== "tool_result");
}

/**
 * 把 payload 按真实用户轮切分成轮次组。
 * 每组 = [userMsg, ...后续消息(assistant/tool_result)] 直到下一条真实用户轮。
 * @param {object[]} payload
 * @returns {object[][]}
 */
function splitPayloadIntoRounds(payload) {
  const groups = [];
  let current = null;
  for (const msg of payload) {
    if (isRealUserMessage(msg)) {
      if (current) groups.push(current);
      current = [msg];
    } else if (current) {
      current.push(msg);
    }
  }
  if (current) groups.push(current);
  return groups;
}

/**
 * 提取消息的纯文本内容。
 * @param {any} message
 * @returns {string}
 */
function extractText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((/** @type {any} */ b) => b?.type === "text" && typeof b.text === "string")
      .map((/** @type {any} */ b) => b.text)
      .join("\n");
  }
  return "";
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
      "按轮号取回已被折掉的归档原文（逐字）；可核对身份。when-to-use：上下文被折叠后需要取回某轮的原始用户消息时调用；round 是轮号（1 起），不是数组下标；scope 仅支持 run",
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

    // 入参校验
    if (!Number.isSafeInteger(round) || round < 1) {
      return JSON.stringify({
        status: "invalid",
        reason: "round 必须是 ≥1 的正整数",
        round,
      });
    }

    // scope 校验
    const scope = input.scope ?? "run";
    if (scope !== "run") {
      return JSON.stringify({
        status: "invalid",
        reason: "scope 仅支持 run",
        round,
      });
    }

    // 读取归档
    let folds;
    try {
      folds = await accessor();
    } catch {
      return JSON.stringify({
        status: "error",
        reason: "无法读取折叠归档",
        round,
      });
    }

    if (!Array.isArray(folds)) folds = [];

    // 找到覆盖该轮的折
    const fold = folds.find((f) => f && Number.isSafeInteger(f.from) && Number.isSafeInteger(f.to) && round >= f.from && round <= f.to);

    if (!fold) {
      return JSON.stringify({
        status: "not_folded",
        round,
        message: "该轮未被折叠 / 不在归档内",
      });
    }

    const { payload, foldId, from, to } = fold;

    // 验证身份
    const recomputed = foldSummaryFingerprint({
      messages: payload,
      roundRange: { from, to },
      recoveryHint: null,
    });

    // P1 判定
    let trustStatus;
    if (!foldId) {
      trustStatus = "untrusted";
    } else if (foldId !== recomputed) {
      trustStatus = "stale";
    } else {
      trustStatus = "verified";
    }

    // stale 不给正文
    if (trustStatus === "stale") {
      return JSON.stringify({
        status: "stale",
        round,
        foldId,
        recomputed,
        message: "该折归档与身份不一致，请重读文件",
        content: null,
      });
    }

    // 定位该轮在 payload 中的位置
    const roundsInPayload = splitPayloadIntoRounds(payload);
    const roundIndex = round - from; // 0-based 在 fold 内的偏移

    if (roundIndex >= roundsInPayload.length) {
      return JSON.stringify({
        status: "not_folded",
        round,
        message: "该轮未被折叠 / 不在归档内",
      });
    }

    const roundMessages = roundsInPayload[roundIndex];
    // payload 中该轮第一条消息的序号（全局）
    let globalIndex = 0;
    for (let i = 0; i < roundIndex; i++) {
      globalIndex += roundsInPayload[i].length;
    }

    const content = roundMessages.map((m) => extractText(m)).join("\n");
    const bytes = byteLength(roundMessages);

    return JSON.stringify({
      status: "found",
      trust: trustStatus,
      round,
      foldRoundRange: { from, to },
      payloadIndex: globalIndex,
      byteLength: bytes,
      foldId: foldId ?? null,
      content,
    });
  }

  return {
    definitions: [TOOL_DEFINITION],
    executeTool,
  };
}
