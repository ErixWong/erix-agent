// @ts-check
/**
 * issue #617（P1b）——派生工具本体：`createDelegateTool`（**库不 fork / 不 spawn / 不 import
 * child_process**；子 run 怎么跑起来由宿主注入的 `runChild` 决定）。
 *
 * 一个工具、五个动作：`delegate` 的 `action ∈ run | status | result | list | cancel`
 * （不做 pause / resume / retry）。模型能填的只有 `action / task / cwd / background /
 * model / deadlineMs`（外加 status / result / cancel 要的子 `runId`）；**父身份不是模型入参**——
 * `parentRunId` 由库从执行上下文的 `runId` 自取（P0 把 `config.run.runId` 递进
 * `baseToolContext.runId`，这里消费它），schema 里根本不存在这个键。这条照 pi-web 的判据：
 * 身份 / 归属类旋钮不做成模型可猜的入参。
 *
 * 组装关系（全部复用 P1a 簿记三件套，不另起一套）：
 *   - 配额：`capacity.acquire`（`<leaseDir>/<runId>.lock` 独占创建）+ 目录内租约计数实现
 *     `maxConcurrent`；抢不到 ⇒ 结构化失败并点名持有者，**不排队、不自旋**；
 *   - 名册：`roster.writeRecord` 写 `queued` 起、`running`、终态；`roster.reconcile` 在
 *     status / list 前先重算陈旧记录（本实例持有的 runId 报 ownedRunIds，不自我误伤）；
 *   - 通知：`notify.shouldNotify`（`(runId, endedAt)` 二元组去重，父 `result` 自取后不再唤醒）
 *     + `notify.notificationText`（固定前缀在代码里）。
 *
 * 终止词汇归库：`TERMINATION_TO_STATE`（导出常量，便于宿主审）——
 * `end_turn|judge_done → completed`；`aborted → aborted`；`timeout|timed_out → timeout`；
 * `max_rounds_cap|stall|failed` 与**未列出的一切 → failed**；`termination` 原样存进名册不解释。
 *
 * 子 runId 由库生成：复用仓库既有 ID 约定（`node:crypto` 的 `randomUUID`，与
 * `src/store/notes.js` / `src/loop/continuity-block.js` 同一套），不新造 ID 生成器。
 *
 * `cancel` 只对**本进程持有**（本工具实例登记了 AbortController）的 runId 生效；否则返回
 * `{ ok: false, reason: "not_owned" }`——不许谎称取消成功。
 *
 * 「不给的字段不写」沿用 P0/P1a 纪律：undefined / 空串一律不落盘、不进结果。
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { acquire, list as listLeases, release } from "./capacity.js";
import { markCollected, notificationText, shouldNotify } from "./notify.js";
import { ROSTER_LIVE_STATES, listRecords, readRecord, reconcile, writeRecord } from "./roster.js";

/**
 * 终止原因 → 名册终态的映射表（issue #617 P1b，**库定义的词汇**）。
 * 未列出的 termination 一律落 `DEFAULT_TERMINATION_STATE`；`termination` 本身原样进名册，库不解释。
 */
export const TERMINATION_TO_STATE = Object.freeze({
  end_turn: "completed",
  judge_done: "completed",
  aborted: "aborted",
  timeout: "timeout",
  timed_out: "timeout",
  max_rounds_cap: "failed",
  stall: "failed",
  failed: "failed",
});

/** 未列出的 termination 的兜底终态（映射表的门卫，导出给宿主审）。 */
export const DEFAULT_TERMINATION_STATE = "failed";

/** 工具的五个动作（封闭清单；不做 pause / resume / retry）。 */
export const DELEGATE_ACTIONS = Object.freeze(["run", "status", "result", "list", "cancel"]);

/** @param {*} termination @returns {string} 名册终态 */
function stateForTermination(termination) {
  const key = typeof termination === "string" ? termination : "";
  return TERMINATION_TO_STATE[key] ?? DEFAULT_TERMINATION_STATE;
}

/**
 * 工具定义（JSON schema）。**没有 `parentRunId` 键**——父身份从执行上下文自取，不给模型任何填它的缝。
 */
export const DELEGATE_DEFINITION = {
  name: "delegate",
  description: "Delegate a task to a child run: run (optionally in background), status / list (roster), "
    + "result (terminal outcome, marks it consumed), cancel (only child runs owned by this process). "
    + "Parent identity is taken from the execution context, not from model input.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...DELEGATE_ACTIONS],
        description: "Which delegate action to perform.",
      },
      task: { type: "string", description: "action=run: the task text handed to the child run." },
      cwd: { type: "string", description: "action=run: child working directory (optional)." },
      background: {
        type: "boolean",
        description: "action=run: true returns immediately with the child runId and wakes the parent "
          + "on completion; false (default) waits and returns the child text.",
      },
      model: { type: "string", description: "action=run: child model (optional, opaque)." },
      deadlineMs: { type: "number", description: "action=run: child time budget in ms (optional)." },
      runId: { type: "string", description: "action=status/result/cancel: the child run identity." },
    },
    required: ["action"],
  },
};

/** 从 input 里取非空 runId；拿不到返回 { ok:false } 形状的错误结果。 */
function requireChildRunId(input) {
  const runId = input?.runId;
  if (typeof runId !== "string" || runId === "") {
    return { error: { ok: false, reason: "invalid_input", detail: "action 需要非空字符串 runId" } };
  }
  return { runId };
}

/**
 * 工厂：装配一个 `delegate` 工具（**纯库内组装**，零子进程）。
 *
 * @param {Object} options
 * @param {(request: {task: string, cwd?: string, parentRunId?: string, runId: string,
 *                    model?: string, deadlineMs?: number, signal: AbortSignal})
 *        => Promise<{text: string, termination?: *, verification?: *}>} options.runChild
 *   宿主注入的「子 run 怎么跑」：库不 fork / 不 spawn。返回 `{ text, termination, verification }`，
 *   `termination` 的词汇以上面导出的映射表为准；宿主实现不许自行发明终止词。
 * @param {string} options.rosterDir 名册目录（每条记录一个 `<runId>.json`）。
 * @param {string} [options.leaseDir] 租约目录；缺省 `<rosterDir>/leases`。
 * @param {number} [options.maxConcurrent] 并发配额（缺省 2）：目录内活租约数到顶后 run 直接失败。
 * @param {(text: string) => void} [options.notifyParent] 后台子 run 完成时的父唤醒（收到
 *   `notificationText` 一行式文本）；`(runId, endedAt)` 已被父 result 自取过则不再唤醒。
 * @param {() => number} [options.clock] 宿主时钟（缺省 `Date.now`）；库内所有时间戳都走它。
 * @returns {{ definition: object, execute: (input: object, context: object) => Promise<object> }}
 */
export function createDelegateTool(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("delegate: options 必须是对象");
  }
  const { runChild, rosterDir, leaseDir, maxConcurrent, notifyParent, clock } = options;
  if (typeof runChild !== "function") {
    throw new TypeError("delegate: runChild 必须由宿主注入（库不 fork / 不 spawn / 不 import child_process）");
  }
  if (typeof rosterDir !== "string" || rosterDir === "") {
    throw new TypeError("delegate: rosterDir 必须是非空字符串");
  }
  const resolvedLeaseDir = leaseDir === undefined ? join(rosterDir, "leases") : leaseDir;
  if (typeof resolvedLeaseDir !== "string" || resolvedLeaseDir === "") {
    throw new TypeError("delegate: leaseDir 必须是非空字符串");
  }
  const resolvedMax = maxConcurrent === undefined ? 2 : maxConcurrent;
  if (!Number.isInteger(resolvedMax) || resolvedMax < 1) {
    throw new TypeError(`delegate: maxConcurrent 必须是 ≥1 的整数，收到 ${JSON.stringify(maxConcurrent)}`);
  }
  const resolvedClock = typeof clock === "function" ? clock : () => Date.now();
  const notify = typeof notifyParent === "function" ? notifyParent : undefined;

  /** 本进程持有的后台子 run：runId → { controller, pending }。cancel 只认这里登记过的。 */
  /** @type {Map<string, { controller: AbortController, pending: Promise<void> }>} */
  const owned = new Map();
  /** 父已自取过的完成标记二元组（notify.js 的 collected 账本，本工具实例持有，随进程消失）。 */
  const collected = new Set();

  const ownedRunIds = () => [...owned.keys()];

  /** status / list 前先重算陈旧记录：本实例持有的 runId 报进 ownedRunIds，不自我误伤。 */
  const reconcileFirst = () => reconcile(rosterDir, { ownedRunIds: ownedRunIds(), now: resolvedClock() });

  /**
   * run 动作收尾（同步与后台共用）：写名册终态、还租约、（后台且未自取过）唤醒父。
   * @param {string} runId
   * @param {{ ok: true, text: string, termination?: *, verification?: * }
   *        | { ok: false, error: * }} outcome
   * @param {boolean} background
   */
  const finishRun = (runId, outcome, background) => {
    const endedAt = resolvedClock();
    const state = outcome.ok ? stateForTermination(outcome.termination) : DEFAULT_TERMINATION_STATE;
    /** 终态写回必须保留 queued 记录里已有的 opaque 字段（cwd / model / pid / deadlineAt …）。 */
    const previous = readRecord(rosterDir, runId) ?? { runId, updatedAt: endedAt };
    /** @type {Record<string, *>} */
    const next = {
      ...previous,
      state,
      updatedAt: endedAt,
      endedAt,
    };
    if (outcome.ok && outcome.termination !== undefined) next.termination = outcome.termination;
    if (outcome.ok && outcome.verification !== undefined) next.verification = outcome.verification;
    const record = writeRecord(rosterDir, /** @type {import("./roster.js").RosterRecord} */ (next));
    release(resolvedLeaseDir, runId);
    if (background && notify !== undefined && shouldNotify(record, { collected })) {
      notify(notificationText(record));
    }
    return record;
  };

  /**
   * @param {Object} input
   * @param {Object} [context] 引擎执行上下文；`context.runId` 是父身份的唯一来源。
   */
  const runAction = async (input, context) => {
    const task = input?.task;
    if (typeof task !== "string" || task.trim() === "") {
      return { ok: false, reason: "invalid_input", detail: "action=run 需要非空字符串 task" };
    }
    const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
    const model = typeof input.model === "string" && input.model !== "" ? input.model : undefined;
    const background = input.background === true;
    const deadlineMs = typeof input.deadlineMs === "number"
      && Number.isFinite(input.deadlineMs) && input.deadlineMs > 0
      ? input.deadlineMs
      : undefined;
    /** 父身份自取：来自执行上下文（P0 的 baseToolContext.runId），模型无法填。 */
    const parentRunId = typeof context?.runId === "string" && context.runId !== "" ? context.runId : undefined;

    /** 库生成子 runId（仓库既有 ID 约定：randomUUID，与 src/store 同一套）。 */
    const runId = `sub-${randomUUID()}`;

    // 配额：活租约到顶 ⇒ 结构化失败、点名持有者，不排队、不自旋。
    const { leases } = listLeases(resolvedLeaseDir);
    if (leases.length >= resolvedMax) {
      return {
        ok: false,
        reason: "capacity_full",
        maxConcurrent: resolvedMax,
        holders: leases.map((lease) => ({
          runId: lease.runId,
          ...(typeof lease.pid === "number" ? { pid: lease.pid } : {}),
          acquiredAt: lease.acquiredAt,
        })),
      };
    }
    const acquired = acquire(resolvedLeaseDir, { runId, pid: process.pid, now: resolvedClock() });
    // 注意：`acquired.ok` 是布尔字面量判别式，tsc 对 `!acquired.ok` 不做联合收窄（实测），
    // 必须写成显式不等比较才能拿到 holder 那一支。
    if (acquired.ok !== true) {
      return { ok: false, reason: "capacity_full", maxConcurrent: resolvedMax, holder: acquired.holder };
    }

    const now = resolvedClock();
    writeRecord(rosterDir, {
      runId,
      state: "queued",
      ...(parentRunId === undefined ? {} : { parentRunId }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(model === undefined ? {} : { model }),
      createdAt: now,
      updatedAt: now,
      ...(deadlineMs === undefined ? {} : { deadlineAt: now + deadlineMs }),
      pid: process.pid,
    });

    const controller = new AbortController();
    /** 宿主注入的 runChild：库不知道也不关心子 run 怎么跑。 */
    const child = runChild({
      task,
      ...(cwd === undefined ? {} : { cwd }),
      ...(parentRunId === undefined ? {} : { parentRunId }),
      runId,
      ...(model === undefined ? {} : { model }),
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      signal: controller.signal,
    });

    if (!background) {
      // 前台：等完，把子 run 的 text 作为工具结果返回。
      try {
        const outcome = await child;
        const record = finishRun(runId, { ok: true, ...outcome }, false);
        return { ok: true, runId, state: record.state, termination: outcome.termination, text: outcome.text };
      } catch (error) {
        const record = finishRun(runId, { ok: false, error }, false);
        return {
          ok: false,
          runId,
          state: record.state,
          error: String(error?.message ?? error),
        };
      }
    }

    // 后台：立刻返回；完成时写名册终态 + 去重后唤醒父。
    const pending = Promise.resolve(child).then(
      (outcome) => { finishRun(runId, { ok: true, ...outcome }, true); },
      (error) => { finishRun(runId, { ok: false, error }, true); },
    );
    owned.set(runId, { controller, pending });
    pending.finally(() => { owned.delete(runId); }).catch(() => {});
    return { ok: true, runId, state: "queued", background: true };
  };

  const statusAction = (input) => {
    const { runId, error } = requireChildRunId(input);
    if (error) return error;
    reconcileFirst();
    const record = readRecord(rosterDir, runId);
    if (record === null) return { ok: false, reason: "not_found", runId };
    return { ok: true, record };
  };

  const resultAction = (input) => {
    const { runId, error } = requireChildRunId(input);
    if (error) return error;
    const record = readRecord(rosterDir, runId);
    if (record === null) return { ok: false, reason: "not_found", runId };
    if (ROSTER_LIVE_STATES.includes(record.state)) {
      return { ok: false, reason: "still_running", runId, state: record.state };
    }
    // 父自取终局：登记 (runId, endedAt) 二元组，之后完成通知不再唤醒父（notify.js 去重）。
    markCollected(collected, record);
    return {
      ok: true,
      runId,
      state: record.state,
      endedAt: record.endedAt,
      termination: record.termination,
      verification: record.verification,
    };
  };

  const listAction = () => {
    const stale = reconcileFirst();
    const { records, corrupt } = listRecords(rosterDir);
    return { ok: true, records, corrupt, interrupted: stale.interrupted };
  };

  const cancelAction = (input) => {
    const { runId, error } = requireChildRunId(input);
    if (error) return error;
    const entry = owned.get(runId);
    if (entry === undefined) {
      // 非本进程持有（别的实例 / 别的进程 / 已终态）：不许谎称取消成功。
      return { ok: false, reason: "not_owned", runId };
    }
    entry.controller.abort();
    return { ok: true, runId, aborted: true };
  };

  /**
   * 工具执行（erix 形状：`execute(input, context)`；宿主桥接引擎的
   * `executeTool({id, name, input, context, signal})` 时把 input / context 原样递进）。
   */
  const execute = async (input, context) => {
    const action = input?.action;
    if (action === "run") return runAction(input, context);
    if (action === "status") return statusAction(input);
    if (action === "result") return resultAction(input);
    if (action === "list") return listAction();
    if (action === "cancel") return cancelAction(input);
    return { ok: false, reason: "unknown_action", action: action ?? null };
  };

  return { definition: DELEGATE_DEFINITION, execute };
}
