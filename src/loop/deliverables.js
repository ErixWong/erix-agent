// @ts-check
// issue #386 切片 2：宿主声明的交付物判据（`deliverables`）。
//
// 分工：**宿主**声明「什么算交付完成」（一个同步或异步的 `check`），**引擎**决定「何时核」
// （每次 guard 调用之前）与「核不过的后果」（不许盖 `verified` 章）。引擎不解释判据的语义、
// 不内置任何默认判据、不读盘——它只负责把「事实」递进去、把「结论」收回来并记进终局。
//
// 两条 fail-closed 纪律（契约写死，改之前先读 `docs/host-consumer-contract.md`）：
//   1. `check` 抛异常 ⇒ 该条 `ok:false` + `detail:"threw"`；
//   2. `check` 超时（复用 `finalGuardTimeoutMs`，不新增旋钮）⇒ `ok:false` + `detail:"timeout"`。
// 两条都是「宿主判据写错/卡住时宁可拦住」，不许把异常/超时当成通过——否则机器闸门会退化成
// 又一个橡皮章（那正是本单要杀的东西）。
//
// 返回值的判定口径（唯一一处）：
//   `true`            ⇒ `{ ok:true }`
//   `false`           ⇒ `{ ok:false }`
//   `{ ok:boolean, detail? }` ⇒ 原样搬（`detail` 缺席就不写该键）
//   其它任何值（字符串 / 数字 / `{ok:"yes"}` / `undefined` / `null`）⇒ `ok:false` + `detail:"invalid_result"`
// 「返回了字符串就当通过」是这类回调最常见的事故，所以它是显式禁止项，不是默认放行。
//
// 零运行时依赖：只用相对路径与语言内置。

/** `deliverables` 的条数上限（超出即 `TypeError`，与其它选项校验同一口径）。 */
export const DELIVERABLES_LIMIT = 20;

/**
 * 校验并规范化 `deliverables` 选项。
 *
 * 契约：可选数组、≤ 20 条、每项 `{ name: 非空 string, check: function }`、`name` 在同一 run 内唯一。
 * `undefined` 与**空数组**都规范化成 `undefined`（= 未声明）：声明了 0 条判据等于没有判据，
 * 于是「未声明 ⇒ 行为逐字不变」那条回归锚把两种写法一起覆盖。
 *
 * @param {unknown} value
 * @returns {{name:string, check:Function}[]|undefined}
 */
export function normalizeDeliverables(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("deliverables must be an array of { name, check }");
  }
  if (value.length > DELIVERABLES_LIMIT) {
    throw new TypeError(`deliverables must have at most ${DELIVERABLES_LIMIT} entries`);
  }
  const seen = new Set();
  const normalized = [];
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`deliverables[${index}] must be an object like { name, check }`);
    }
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      throw new TypeError(`deliverables[${index}].name must be a non-empty string`);
    }
    if (typeof entry.check !== "function") {
      throw new TypeError(`deliverables[${index}].check must be a function`);
    }
    if (seen.has(entry.name)) {
      throw new TypeError(`deliverables[${index}].name must be unique: ${JSON.stringify(entry.name)}`);
    }
    seen.add(entry.name);
    normalized.push({ name: entry.name, check: entry.check });
  }
  return normalized.length === 0 ? undefined : normalized;
}

/** `check` 超时/异常时用的哨兵（不是任何宿主能返回的值）。 */
const TIMED_OUT = Symbol("deliverables-timeout");

/**
 * 把一条判据的返回值翻译成 `{ ok, detail? }`（口径见文件头）。
 *
 * @param {unknown} value
 * @returns {{ok:boolean, detail?:any}}
 */
function normalizeCheckResult(value) {
  if (value === true) return { ok: true };
  if (value === false) return { ok: false };
  if (value !== null && typeof value === "object" && typeof (/** @type {any} */ (value).ok) === "boolean") {
    const raw = /** @type {{ok:boolean, detail?:any}} */ (value);
    return raw.detail === undefined ? { ok: raw.ok } : { ok: raw.ok, detail: raw.detail };
  }
  return { ok: false, detail: "invalid_result" };
}

/**
 * 跑一条判据：超时 ⇒ `timeout`，抛错 ⇒ `threw`，其它按返回值口径翻译。
 *
 * 超时用 `finalGuardTimeoutMs`（与 guard 本身同一个旋钮、同一个毫秒数），**逐条**计时：
 * 20 条判据不会共享一个总预算，因为每条判据的代价是宿主自己写的，共享预算会让「后面几条
 * 被判超时」变成前几条跑得慢的副作用——那是引擎替宿主做语义判断。
 *
 * @param {{name:string, check:Function}} entry
 * @param {object} facts
 * @param {number} timeoutMs
 * @returns {Promise<{name:string, ok:boolean, detail?:any}>}
 */
async function runOne(entry, facts, timeoutMs) {
  /** @type {NodeJS.Timeout|undefined} */
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      // 判据挂住时不要让定时器单独吊住进程（runToolLoop 自己还有 signal/deadline）。
      if (typeof timer.unref === "function") timer.unref();
    });
    const settled = await Promise.race([
      Promise.resolve().then(() => entry.check(facts)),
      timeout,
    ]);
    if (settled === TIMED_OUT) return { name: entry.name, ok: false, detail: "timeout" };
    return { name: entry.name, ...normalizeCheckResult(settled) };
  } catch {
    // fail-closed：宿主判据自己崩了不许算通过（也不把异常文本塞进 payload——那是宿主内部细节，
    // 且可能是任意对象；`detail:"threw"` 是可判定、可对账的固定分类）。
    return { name: entry.name, ok: false, detail: "threw" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 逐条核验宿主声明的交付物判据（**顺序执行**，结果顺序 = 声明顺序）。
 *
 * 顺序执行而不是并发：判据是宿主写的副作用代码（`stat()`、`readFile`、甚至子进程），并发会把
 * 「谁先谁后」变成不确定性；条数上限只有 20，串行的代价可控，可复现性更值钱。
 *
 * @param {{name:string, check:Function}[]} deliverables 已规范化的清单（非空）
 * @param {object} facts `buildFinalGuardPayload` 算出的那份事实
 * @param {{timeoutMs:number}} options
 * @returns {Promise<{
 *   results: {name:string, ok:boolean, detail?:any}[],
 *   checked: number,
 *   failed: number,
 *   allPassed: boolean,
 * }>}
 */
export async function runDeliverables(deliverables, facts, { timeoutMs }) {
  const results = [];
  let failed = 0;
  for (const entry of deliverables) {
    const result = await runOne(entry, facts, timeoutMs);
    if (!result.ok) failed += 1;
    results.push(result);
  }
  return {
    results,
    checked: results.length,
    failed,
    allPassed: failed === 0,
  };
}
