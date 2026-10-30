// @ts-check
/**
 * issue #617（P1a）——派生（子 run）完成通知的去重与归属（**纯簿记**）。
 *
 * 三条判据全部来自真实实现的踩坑记录，逐条钉死：
 *
 *   1. 完成标记必须点名 **`(runId, endedAt)` 二元组**，不能只点名 `runId`。续跑（resume）会复用
 *      同一个 runId——同一个 run 第一次跑完被消费掉之后，续跑再完成的那一次**是新的完成事件**；
 *      只点名 run 会让它被误判为「已消费过」，父永远收不到续跑的完成通知。
 *      （判据形态照 pi-web：完成标记要点名 runId + completedAt。）
 *   2. 已被父自取过（`collected`）⇒ 不再唤醒；**`interrupted` 必须仍然通知**——子凭空消失正是
 *      父最需要知道的事（pi-web 的 readSubagentRun 对「状态文件说活态但没有结果行」一律落
 *      interrupted，且这类记录照样上父的清单）。
 *   3. 通知文本必须带**固定前缀**（`NOTIFICATION_PREFIX`，导出的常量）。前缀必须在**代码里**，
 *      不能塞进提示词——否则上下文压缩会把它归档到用户的 Goal 下面，完成通知在压缩后失去
 *      归属，父侧的去重/记账跟着全错（pi-web 实测的坑）。前缀在代码里 = 压缩前后逐字不变 =
 *      父侧可靠可 grep。
 *
 * 本模块是**无状态纯函数 + 宿主持有的 Set**：`collected` 由宿主持有并持久化（存哪、活多久
 * 都是宿主语义），库只定义二元组的键形态与判定规则。opaque 字段（`termination` /
 * `verification` 等）在通知文本里只体现为状态名，**不展开内容**——展开既撑爆一行式文本，
 * 也把库拖进解释 opaque 字段的越界行为。
 */

/**
 * @typedef {Object} NotifyRecord
 * @property {string} runId
 * @property {string} [parentRunId]
 * @property {string} state
 * @property {number} [endedAt]
 * @property {*} [termination]   opaque：通知文本不展开
 * @property {*} [verification]  opaque：通知文本不展开
 */

/**
 * 完成通知的固定前缀。**必须保持在代码里**：塞进提示词的那一份会被上下文压缩归档到用户的
 * Goal 下面，压缩后完成通知失去归属；代码常量则在压缩前后逐字不变，父侧可靠可 grep。
 * 测试钉死这个常量本身，改前缀 = 改行为契约。
 */
export const NOTIFICATION_PREFIX = "【子run完成】";

/**
 * 完成标记的二元组键：`runId` + `endedAt` 拼成一个不可分字符串。宿主用它当 Set 元素 / 账本键
 * 持久化；**不要用 runId 当唯一键**（resume 会复用 runId，见文件头第 1 条）。
 *
 * issue #630 S2 / I：两个字段之间**必须有分隔符**（`:`）。无分隔符的 `${runId}${endedAt}` 靠
 * 「时间戳定长 13 位」才不碰撞——一个零风险硬化：`("a1", 23)` 与 `("a", 123)` 现在不同。
 * `:` 不会出现在 `runId` 里（`roster.assertSafeRunId` 只放行安全文件名，CLI 的 runId 是
 * `sub-<uuid>`），所以这个键可以反向切开。
 *
 * @param {NotifyRecord} record
 * @returns {string}
 */
export function completionMarkerKey(record) {
  if (record === null || typeof record !== "object" || typeof record.runId !== "string" || record.runId.length === 0) {
    throw new TypeError(`notify: completionMarkerKey 需要带 runId 的记录，收到 ${JSON.stringify(record)}`);
  }
  return `${record.runId}:${String(record.endedAt)}`;
}

/**
 * 登记「父已自取过这一次完成」。幂等：同一二元组重复登记无副作用。
 *
 * @param {Set<string>} collected 宿主持有的完成标记集合
 * @param {NotifyRecord} record
 * @returns {string} 登记的二元组键
 */
export function markCollected(collected, record) {
  if (!(collected instanceof Set)) {
    throw new TypeError("notify: markCollected 的 collected 必须是宿主持有的 Set<string>");
  }
  const key = completionMarkerKey(record);
  collected.add(key);
  return key;
}

/**
 * 这一次完成是否已被父自取过（二元组语义：同 runId 不同 endedAt = 未消费）。
 *
 * @param {Set<string>} collected
 * @param {NotifyRecord} record
 * @returns {boolean}
 */
export function isCollected(collected, record) {
  if (!(collected instanceof Set)) {
    throw new TypeError("notify: isCollected 的 collected 必须是宿主持有的 Set<string>");
  }
  return collected.has(completionMarkerKey(record));
}

/**
 * 要不要唤醒父。规则：已被父自取过 ⇒ 不唤醒；其余一律通知——**包括 `interrupted`**
 * （子凭空消失正是父最需要知道的；interrupted 的记录通常根本不在 collected 里）。
 *
 * @param {NotifyRecord} record
 * @param {Object} options
 * @param {Set<string>} options.collected 宿主持有的完成标记集合
 * @returns {boolean}
 */
export function shouldNotify(record, { collected }) {
  return !isCollected(collected, record);
}

/** 单行化：通知是**一行**，值里任何空白都压成空格（不压就会被换行劈成两条消息）。 */
function flatten(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * 一行式通知文本：固定前缀 + `runId` + `parentRunId`（有则带）+ `state` + `endedAt`（有则带）。
 * opaque 字段只体现为 `state` 这个状态名，**不展开内容**（文件头第 3 条边界）。
 *
 * @param {NotifyRecord} record
 * @returns {string}
 */
export function notificationText(record) {
  if (record === null || typeof record !== "object" || typeof record.runId !== "string" || record.runId.length === 0) {
    throw new TypeError(`notify: notificationText 需要带 runId 的记录，收到 ${JSON.stringify(record)}`);
  }
  const parts = [`runId=${flatten(record.runId)}`];
  if (record.parentRunId !== undefined && record.parentRunId !== "") {
    parts.push(`parentRunId=${flatten(record.parentRunId)}`);
  }
  parts.push(`state=${flatten(record.state)}`);
  if (record.endedAt !== undefined && record.endedAt !== null) {
    parts.push(`endedAt=${flatten(record.endedAt)}`);
  }
  return `${NOTIFICATION_PREFIX} ${parts.join(" ")}`;
}
