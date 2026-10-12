// erix_run 的「唤醒父会话」（issue #234）：**逐分支对照** pi-subagents `src/shared/parent-wake.js`
// （全文 46 行，含末尾 sourceMappingURL 行；逐行对照见 docs/research/2026-10-13-pi-subagents-async-attribution.md §2），
// 只改了单号、文本常量与 `Symbol.for` 键名，**分支结构一条没动**（上游没有的只有下面那个 `peekReservation`）。
//
// 为什么必须双分支（都是上游踩过的坑）：
//   - `pi.sendMessage(msg, {triggerTurn:true})` 只有在父会话 **idle** 时才真的触发一轮；
//     父会话正忙时硬触发会打断它，所以退化成「追加消息 + `deliverAs:"steer"` 排队」。
//   - reservation（`WAKE_PENDING_MS` pending 窗口）：被处理掉或失败的唤醒 prompt **不会发
//     `agent_start`**，超过这个窗口的 idle 唤醒只能算「那一轮丢了」——通知已经在会话里，
//     但没换来一轮。没有窗口就会无限等/或每次都重复排 steer。
//   - reservation 存 `Symbol.for(...)` 挂 globalThis 的 **WeakMap（按 `sessionManager` 键）**
//     → 扩展 `/reload` 之后不丢（reload 会重建扩展实例，但 sessionManager 是同一个）。
//   - `bindSession(ctx)` 由 `session_start` 调用，**不在扩展 factory 里**（生命周期规矩：
//     factory 不起定时器/进程/监听）。
//
// 本文件不 import pi：`pi` 与 `ctx` 都从外面注入，所以 `node --test` 能拿假对象直接测两条分支。

/** steer 排队的固定提示文本（照 pi-subagents 的 `PARENT_WAKE_TEXT`，指向「上面的通知」）。 */
export const PARENT_WAKE_TEXT = "erix_run updates above.";
/** idle 唤醒的 pending 窗口（照 pi-subagents 的 `WAKE_PENDING_MS = 10_000`，值逐字相同）。 */
export const WAKE_PENDING_MS = 10_000;
/** reservation 的 globalThis 键（`Symbol.for` ⇒ 同一进程内跨扩展实例共享，`/reload` 不丢）。 */
export const RESERVATIONS_SYMBOL = Symbol.for("erix-run.parent-wake-reservations.v1");

const wakeGlobal = globalThis;
/** @type {WeakMap<object, {sessionId:string, sentAt?:number}>} */
const reservations = wakeGlobal[RESERVATIONS_SYMBOL]
  ?? (wakeGlobal[RESERVATIONS_SYMBOL] = new WeakMap());

/**
 * @param {{sendMessage:(message:object, options?:object)=>unknown,
 *          sendUserMessage:(content:string, options?:object)=>unknown}} pi
 * @param {()=>number} [now]
 */
export function createParentWake(pi, now = Date.now) {
  let ctx;
  /** @type {{sessionId:string, sentAt?:number}} */
  let reservation = { sessionId: "" };
  const reserved = () => reservation.sentAt !== undefined && now() - reservation.sentAt < WAKE_PENDING_MS;
  return {
    /**
     * @param {object} message 自定义消息（`customType` / `content` / `display`）
     * @param {{triggerTurn?:boolean, deliverAs?:string}} [options]
     * @returns {boolean} 是否走了「idle 唤醒」分支（true = 建立/复用了 reservation）
     */
    sendMessage(message, options) {
      if (options?.triggerTurn !== true) {
        pi.sendMessage(message, options);
        return false;
      }
      if (!ctx.isIdle()) {
        // 父会话正忙：原样透传（pi 会按当前投递策略处理），**不排 steer**，不建 reservation。
        pi.sendMessage(message, options);
        return false;
      }
      // idle：消息只追加（triggerTurn:false），真正的「起一轮」交给 steer 用户消息。
      pi.sendMessage(message, { triggerTurn: false });
      if (!reserved()) {
        reservation.sentAt = now();
        // Steer queues the wake if another prompt starts the run first.（上游注释原意）
        pi.sendUserMessage(PARENT_WAKE_TEXT, { deliverAs: "steer" });
      }
      return true;
    },
    isPending: () => reservation.sentAt !== undefined && (reserved() || !ctx.isIdle()),
    /** 在 `session_start` 里调用：绑 ctx，并按 `sessionManager` 取回/新建 reservation。 */
    bindSession(context) {
      ctx = context;
      const sessionId = context.sessionManager.getSessionId();
      const retained = reservations.get(context.sessionManager);
      reservation = retained?.sessionId === sessionId ? retained : { sessionId };
      reservations.set(context.sessionManager, reservation);
    },
    /** 在 `agent_start` 里调用：唤醒已经换来一轮了，清掉 pending。 */
    agentStarted() {
      reservation.sentAt = undefined;
    },
    /** reload 不算「父会话真的跑过」，pending 要留着（照上游同一条判断）。 */
    sessionShutdown(reason) {
      if (reason !== "reload") reservation.sentAt = undefined;
    },
    /** 测试/诊断用：当前 reservation（不暴露内部引用）。 */
    peekReservation: () => ({ ...reservation }),
  };
}
