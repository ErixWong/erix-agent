// @ts-check
/**
 * issue #617（P1b）——派生工具本体：`createDelegateTool`（**库不 fork / 不 spawn / 不 import
 * child_process**；子 run 怎么跑起来由宿主注入的 `runChild` 决定）。
 *
 * 一个工具、六个动作：`delegate` 的 `action ∈ run | status | result | list | cancel | tail`
 * （不做 pause / resume / retry；`resume` / `steer` 是 #626 的 C2/C3，不在本切片里）。
 *
 * `tail`（issue #626 C1）回答名册答不了的那半个问题：「子 run **现在**在干什么」。它读的是子 run
 * transcript 的**尾部**（有界：缺省 8 行、上限 20 行、每行 300 字符），投影交给
 * `delegation/tail.js`，本模块只负责「先读名册、再把记录里的 `transcriptPath` 交出去」。
 * **它与 `cancel` 的关键差别**：`cancel` 只认本进程 `owned` 表里登记过的 AbortController，`tail`
 * **完全不看 `owned`**——只要名册记录在、transcript 在盘上，**别的进程养的子 run 一样读得到**
 * （这正是「无人值守宿主看另一个进程的子」的场景；`owned` 只回答「我能掐死它吗」）。
 *
 * **`transcriptPath` 的登记归宿主**（#626 C1 真机实测的根因）：记录是库在派生时建的，库不知道宿主
 * 把子 run 的 transcript 写在哪，所以名册里那个字段**只能由宿主提供**——这就是工厂旋钮
 * `transcriptPathFor`。给了它，库在**创建记录的那一次写**里就把 `transcriptPath` 填上（不是
 * 「先建记录再补写第二遍」：补写会让父立刻 `tail` 时读到空字段，也多一个竞态窗口）；不给，
 * 字段照旧缺省（向后兼容，旧宿主不会因为没这个旋钮而破），代价是它的 `tail` 只能报
 * `no_transcript_path`。
 *
 * 模型能填的只有 `action / task / cwd / background /
 * model / deadlineMs`（外加 status / result / cancel / tail 要的子 `runId`，以及 tail 的 `limit`）；**父身份不是模型入参**——
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
import { TAIL_LIMIT_DEFAULT, TAIL_LIMIT_MAX, TAIL_TEXT_LIMIT_DEFAULT, tailChildTranscript } from "./tail.js";
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

/** 工具的六个动作（封闭清单；不做 pause / resume / retry）。 */
export const DELEGATE_ACTIONS = Object.freeze(["run", "status", "result", "list", "cancel", "tail"]);

/**
 * `result` 带回的子 run 终稿上限（字符，issue #630 S1）：超了截断到本值并带 `truncated: true`。
 * 为什么要上限：子 run 的终稿可能是一次完整的长报告，原样塞回父 run 的上下文等于把子那一轮的
 * token 账再付一遍；父要细节可以 `tail`（有界尾读）。
 */
export const RESULT_TEXT_LIMIT = 4000;

/** `result` 带回的子 run 错误文本上限（字符，issue #630 S1）：只留够看懂「为什么失败」。 */
export const ERROR_MESSAGE_LIMIT = 1000;

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
    + "result (terminal outcome, marks it consumed; carries the child's final text — capped at "
    + `${RESULT_TEXT_LIMIT} characters, with truncated:true when it was cut — and, when the child threw, `
    + `its error message capped at ${ERROR_MESSAGE_LIMIT} characters), `
    + "cancel (only child runs owned by this process), "
    + "tail (what the child is doing right now: a bounded read of its transcript tail — the last "
    + `${TAIL_LIMIT_DEFAULT} rows by default, at most ${TAIL_LIMIT_MAX} rows, ${TAIL_TEXT_LIMIT_DEFAULT} characters per row`
    + " — with the tool name and an args digest for tool calls; it reads any child on disk, not just this process's). "
    + "tail distinguishes two failures: reason=no_transcript_path means the roster record carries no transcriptPath "
    + "(the host never registered where the child writes — a configuration defect, not a missing child), while "
    + "reason=no_transcript means the path is recorded but the file is absent or unreadable (the child has not "
    + "written its first row yet, or the file was cleaned up). "
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
      runId: { type: "string", description: "action=status/result/cancel/tail: the child run identity." },
      limit: {
        type: "number",
        description: `action=tail: how many rows to return (default ${TAIL_LIMIT_DEFAULT}, capped at ${TAIL_LIMIT_MAX}).`,
      },
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
 * @param {(runId: string) => string} [options.transcriptPathFor] 宿主旋钮（issue #626 C1）：
 *   「子 run 的 transcript 落在哪个文件」。与 `runChild` 同一类边界——**布局归宿主，库不猜路径**。
 *   给了它，库在**创建名册记录的那一次原子写**里就把 `transcriptPath` 填上（父立刻 `tail` 也读得到，
 *   不存在「先建记录再补写」的窗口）；不给，字段照旧缺省（旧宿主不受影响，它的 `tail` 报
 *   `no_transcript_path`）。返回值必须是**非空字符串**：库不把「宿主给了一个空路径」静默吃掉——
 *   那是配置缺陷，当场抛（在任何租约 / 记录落盘之前）。
 * @param {(requested: string|undefined, runId: string) => string} [options.cwdFor] 宿主旋钮
 *   （issue #630 S1）：**子 run 实际跑在哪个目录**。模型请求里的 `cwd` 是「想要」，不是「生效」——
 *   库不猜宿主把相对路径解析到哪、也不猜缺省目录是谁，所以策略归宿主：给了它，库就用它的返回值
 *   **既写名册、又交给 `runChild`**（同一个值，不许记录一个执行另一个）；返回值必须是**非空字符串**，
 *   否则抛 `TypeError`（在任何租约 / 记录落盘之前）。
 *   **不给时保持旧行为**（名册只记模型给的原值，缺省时该字段缺省）——但这时名册的 `cwd`
 *   **不代表子 run 的实际工作目录**（子可能落在宿主自己的缺省树里），宿主应当提供 `cwdFor`。
 * @param {() => number} [options.clock] 宿主时钟（缺省 `Date.now`）；库内所有时间戳都走它。
 * @returns {{ definition: object, execute: (input: object, context: object) => Promise<object> }}
 */
export function createDelegateTool(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("delegate: options 必须是对象");
  }
  const { runChild, rosterDir, leaseDir, maxConcurrent, notifyParent, transcriptPathFor, cwdFor, clock } = options;
  if (typeof runChild !== "function") {
    throw new TypeError("delegate: runChild 必须由宿主注入（库不 fork / 不 spawn / 不 import child_process）");
  }
  if (transcriptPathFor !== undefined && typeof transcriptPathFor !== "function") {
    throw new TypeError("delegate: transcriptPathFor 必须是函数（宿主决定 transcript 布局，库不猜路径）");
  }
  if (cwdFor !== undefined && typeof cwdFor !== "function") {
    throw new TypeError("delegate: cwdFor 必须是函数（宿主决定子 run 的实际工作目录，库不猜）");
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
   *
   * issue #630 S1：子 run 的**终稿**与**失败原因**必须在这一**次**终态写里落盘（不是事后补写）：
   * 后台分支以前把 `text` 丢掉了，父调 `result` 只能拿到 `state` / `termination`，答案是“看 tail 猜”。
   * 两个上限（`RESULT_TEXT_LIMIT` / `ERROR_MESSAGE_LIMIT`）在这里兑现：截了就带
   * `resultTruncated: true`，没截就不写那个键（「不给的字段不写」）。
   *
   * `outcome` 有两种形状：成功 `{ ok: true, text, termination?, verification? }`；失败
   * `{ ok: false, error }`。这里刻意写成「一个对象 + 可选成员」而不是可判别联合：`--checkJs` 下
   * 联合的否定收窄在 JSDoc 字面量类型上不生效（tsc 只认 `.text` 那一侧），写成可选成员既过闸又不用 cast。
   * @param {string} runId
   * @param {{ ok: boolean, text?: *, termination?: *, verification?: *, error?: * }} outcome
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
    if (outcome.ok) {
      // 宿主没给 text（不是字符串）就不写这个字段——绝不允许写成 "undefined"。
      const text = outcome.text;
      if (typeof text === "string" && text !== "") {
        if (text.length > RESULT_TEXT_LIMIT) {
          next.resultText = text.slice(0, RESULT_TEXT_LIMIT);
          next.resultTruncated = true;
        } else {
          next.resultText = text;
        }
      }
    } else {
      const message = String(outcome.error?.message ?? outcome.error ?? "");
      if (message !== "") next.errorMessage = message.slice(0, ERROR_MESSAGE_LIMIT);
    }
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

    /**
     * 宿主登记的 transcript 位置（issue #626 C1）。**在拿租约之前算**：宿主给的路径不合法时当场抛，
     * 不会留下一条「租约已拿、记录没建」的孤儿租约。
     * 它进的是**下面那次 `writeRecord`**（创建记录的唯一一次原子写）——不是事后补写第二遍。
     */
    let transcriptPath;
    if (typeof transcriptPathFor === "function") {
      const resolved = transcriptPathFor(runId);
      if (typeof resolved !== "string" || resolved === "") {
        throw new TypeError(
          `delegate: transcriptPathFor(${JSON.stringify(runId)}) 必须返回非空字符串，`
          + `收到 ${JSON.stringify(resolved)}（宿主没登记路径时应该根本不传这个旋钮）`,
        );
      }
      transcriptPath = resolved;
    }

    /**
     * 宿主解析的**实际**工作目录（issue #630 S1）。与 `transcriptPathFor` 同一个位置、同一个理由：
     * 在拿租约之前算（宿主给了非法值就当场抛，不留「租约已拿、记录没建」的孤儿租约）。
     * 解析出的值**既写名册、又交给 `runChild`**——同一个变量，不存在「记录一个、执行另一个」。
     * 不传 `cwdFor` 时保持旧行为：名册只记模型给的原值（缺省时该字段缺省），但那时名册的 `cwd`
     * **不代表实际工作目录**（见工厂参数的 `@param`）。
     */
    let effectiveCwd = cwd;
    if (typeof cwdFor === "function") {
      const resolvedCwd = cwdFor(cwd, runId);
      if (typeof resolvedCwd !== "string" || resolvedCwd === "") {
        throw new TypeError(
          `delegate: cwdFor(${JSON.stringify(cwd ?? null)}, ${JSON.stringify(runId)}) 必须返回非空字符串，`
          + `收到 ${JSON.stringify(resolvedCwd)}（宿主算不出实际工作目录时应该根本不传这个旋钮）`,
        );
      }
      effectiveCwd = resolvedCwd;
    }

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
      // 名册里的 `cwd` 必须是**实际生效**的那个值（issue #630 S1 的真机缺陷：不传 cwd 时名册
      // `cwd: null`，而子实际在父树里跑——记录与事实不符）。
      ...(effectiveCwd === undefined ? {} : { cwd: effectiveCwd }),
      ...(model === undefined ? {} : { model }),
      ...(transcriptPath === undefined ? {} : { transcriptPath }),
      createdAt: now,
      updatedAt: now,
      ...(deadlineMs === undefined ? {} : { deadlineAt: now + deadlineMs }),
      pid: process.pid,
    });

    const controller = new AbortController();
    /** 宿主注入的 runChild：库不知道也不关心子 run 怎么跑。 */
    const child = runChild({
      task,
      // 与上面写进名册的是**同一个值**（`effectiveCwd`），不是模型原值。
      ...(effectiveCwd === undefined ? {} : { cwd: effectiveCwd }),
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
    /** @type {Record<string, *>} */
    const result = {
      ok: true,
      runId,
      state: record.state,
      endedAt: record.endedAt,
      termination: record.termination,
      verification: record.verification,
    };
    // issue #630 S1：后台子 run 的终稿 / 截断标记 / 失败原因随 `result` 一起回去
    //（以前只回 state/termination，父拿不到答案只能猜）。没写进名册的字段照样不出现在结果里。
    if (typeof record.resultText === "string") result.text = record.resultText;
    if (record.resultTruncated === true) result.truncated = true;
    if (typeof record.errorMessage === "string") result.error = record.errorMessage;
    return result;
  };

  const listAction = () => {
    const stale = reconcileFirst();
    const { records, corrupt } = listRecords(rosterDir);
    return { ok: true, records, corrupt, interrupted: stale.interrupted };
  };

  /**
   * `tail`（issue #626 C1）：**先读名册**，再把记录里的 `transcriptPath` 交给 `tailChildTranscript`。
   * 三个失败理由必须分得开（见 `tail.js` 的头注释）：`not_found`（没这条记录）/ `no_transcript_path`
   * （记录里没有 `transcriptPath`——宿主没接 `transcriptPathFor`，配置缺陷）/ `no_transcript`
   * （路径在、文件不在或打不开——子还没落盘或档案已清理，正常时序）。
   *
   * 三条与别的动作不同的裁决：
   *   · **不 reconcile**：status / list 前会重算陈旧记录，`tail` 不重算——它是一次**读**，不该顺手
   *     改写别人的名册（尤其 `tail` 是设计来读**别的进程**的子的，替它判 `interrupted` 就是越权）；
   *   · **不看 `owned`**：跨进程可读是它存在的理由（见文件头）；
   *   · **恒带 `state` / `updatedAt`**：父要靠这两个字段判断这条尾还新不新（`updatedAt` 是名册的单调
   *     水位，`readAt` 是这次尾读的时刻——两个都在，父才能算出「我读到的东西落后了多久」）。
   * @param {Object} input
   */
  const tailAction = async (input) => {
    const { runId, error } = requireChildRunId(input);
    if (error) return error;
    const record = readRecord(rosterDir, runId);
    if (record === null) return { ok: false, reason: "not_found", runId };
    const tail = await tailChildTranscript({
      transcriptPath: record.transcriptPath,
      limit: input?.limit,
      clock: resolvedClock,
    });
    return { ...tail, runId, state: record.state, updatedAt: record.updatedAt };
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
    if (action === "tail") return tailAction(input);
    return { ok: false, reason: "unknown_action", action: action ?? null };
  };

  return { definition: DELEGATE_DEFINITION, execute };
}
