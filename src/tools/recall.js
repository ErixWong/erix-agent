// @ts-check
import { isMessageRow } from "../store/message-rows.js";
import { Buffer } from "node:buffer";

/**
 * 计算 JSON 序列化后的 UTF-8 字节长度。
 * @param {any} value
 * @returns {number}
 */
function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * 创建 `recall_read` 内置工具的工厂（issue #896 C1）。
 *
 * 默认不挂进任何既有默认工具列表——由宿主显式挂载。
 *
 * 数据源是**账本本身**（`store.load(runId)` 的行），不是折叠快照 `foldedPayload`：
 * `foldedPayload` 是有界去重后的快照、不是轮的完整切片，天生还原不出轮；而账本完整、
 * 且每条消息都记着自己的轮号。轮号直接取账本上记的 `record.round`，不重算、不按下标猜。
 *
 * @param {{ readLedgerRows: () => Promise<any[]> | any[] }} options
 *   只读访问器：返回该 run 的账本行（`store.load(runId)` 的输出）。
 * @returns {{ definitions: object[], executeTool: (req: any) => Promise<string> }}
 */
export function createBuiltinRecallTools(options = {}) {
  const accessor = options?.readLedgerRows;
  if (typeof accessor !== "function") {
    throw new TypeError("createBuiltinRecallTools requires options.readLedgerRows to be a function");
  }

  const TOOL_DEFINITION = {
    name: "recall_read",
    description:
      "按轮号从账本逐字取回某一轮的原始消息（不做任何改写、不截断）。when-to-use：需要取回某一轮落盘的原始消息时调用——无论该轮是否已被折叠，账本始终保留每轮正文；round 是账本记录的轮号（1 起），不是数组下标；scope 仅支持 run；账本里没有该轮正文时返回 not_folded，不猜测、不拿相近轮顶替",
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

    let rows;
    try {
      rows = await accessor();
    } catch {
      return JSON.stringify({ status: "error", reason: "无法读取账本", round });
    }
    if (!Array.isArray(rows)) rows = [];

    // 口径①：消息行（kind==="message"）里 round===N 的那些，按 seq 升序拼接其 messages
    //   （seq 相同保持落盘先后：V8 的 Array#sort 稳定，先按原序入桶再按 seq 排序即可）。
    //   正常轮的正文已被 store.load() 折进轮载体、消息行被吸走，所以这里只剩崩溃轮（无载体）。
    const fromMessageRows = rows
      .map((/** @type {any} */ row, /** @type {number} */ index) => ({ row, index }))
      .filter(({ row }) => isMessageRow(row) && row.round === round && Array.isArray(row.messages))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.row.seq - b.row.seq) || (a.index - b.index))
      .flatMap(({ row }) => row.messages);

    // 口径②：轮载体行（非消息行、自带 messages 的旧/正常格式）里 round===N 的，直接取其 messages。
    const fromCarrierRows = rows
      .filter((/** @type {any} */ row) => !isMessageRow(row) && row.round === round && Array.isArray(row.messages))
      .flatMap((/** @type {any} */ row) => row.messages);

    const messages = [...fromMessageRows, ...fromCarrierRows];

    if (messages.length === 0) {
      return JSON.stringify({
        status: "not_folded",
        round,
        message: `账本里没有第 ${round} 轮的正文（recall_read 读的是账本，不限于已折轮次）`,
      });
    }

    return JSON.stringify({
      status: "found",
      round,
      messageCount: messages.length,
      byteLength: byteLength(messages),
      messages,
    });
  }

  return {
    definitions: [TOOL_DEFINITION],
    executeTool,
  };
}
