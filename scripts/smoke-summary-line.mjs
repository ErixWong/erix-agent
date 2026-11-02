// 第 7 步 `cli-real-smoke` 的**机器可读汇总行**契约（issue #678）：生产者
// （`scripts/cli-real-smoke.mjs`）与消费者（`scripts/release-real-check.mjs`）共用这一份格式，
// 免得两边各写一遍正则、各有一个真相。
//
// 病根（#678 原话：只看 `tests=?` 会误判成「跑过但不知道证了什么」）：第 7 步跑的是
// `scripts/cli-real-smoke.mjs`，它打的**不是** `node --test` 的 TAP，于是清单里的
// `parseTapSummary()` 在它身上一个字段也取不到 ⇒ 汇总里只剩 `tests=? pass=? fail=? skip=?`。
// 那个 `?` 是对的（取不到不许写 0），但它把两件完全不同的事压成同一个符号：
// 「C1–C8 全跑了且全过」与「一条都没跑」。这一行补的就是那格空白——它把冒烟自己数出来的
// `checks / pass / fail`（外加 `dry` / 失败 id）交给清单。
//
// 本模块只做三件事：
//   1. `formatSmokeLine()`：生产者打印
//      `RELEASE-REAL-SMOKE id=cli-real checks=8 pass=8 fail=0 dry=false failed=- status=ok`；
//   2. `parseSmokeLine()`：消费者读回这一行；**取不到 ⇒ `undefined`，绝不补 0**（同 `parseTapSummary`
//      的口径：写 0 会把「没摘要」读成「零失败」）；
//   3. `checkCode()`：把 `C4 装后的 CLI 真跑了 ≥2 次工具（不是空转）` 这样的完整 id 压成 `C4`，
//      好让 `failed=` 一栏短到能塞进一行汇总（失败时仍点得名是哪条 C 红了）。
//
// 两条刻意的设计：
//   · `pass` **由 `checks - fail` 推**，不另传一个数：两处各传一个数迟早会印出
//     「checks=8 pass=8 fail=1」这种自相矛盾的行，而这一行正是拿来判读的东西。
//   · `checks` 是**生产者实际跑过的 `check()` 条数**（`cli-real-smoke.mjs` 里 `check()` 自己数），
//     不是任何地方写死的 8：`--dry` 只跑 C8 ⇒ `checks=1`，将来加 C9 ⇒ 全跑时 `checks=9`。
//     硬编码正是本票要防的第二件事（「8/8 全绿」可能只是抄来的字面量）。
//
// 零依赖：只用 ESM 语法本身（连 `node:` 内置都不需要），与仓内其余 `scripts/*.mjs` 同口径。

/** 固定前缀。消费者按它找行；`grep '^RELEASE-REAL-SMOKE'` 必须能直接命中（行首、无日志前缀）。 */
export const SMOKE_PREFIX = "RELEASE-REAL-SMOKE";

/** 汇总行里的固定 id（第 7 步只有一条生产者）。 */
export const SMOKE_STEP_ID = "cli-real";

/** `status` 的三档：`ok` = 全过；`fail` = 有断言红；`error` = 脚本自身抛了（可能一条断言都没跑到）。 */
export const SMOKE_STATUSES = Object.freeze(["ok", "fail", "error"]);

const STATUS_SET = new Set(SMOKE_STATUSES);

/**
 * 把一条检查的完整 id 压成短码（`C4 …` ⇒ `C4`）。不是 `C<n>` 形状的 id 原样返回
 * （宁可长一点，也不要把它吞成空串）。
 *
 * @param {unknown} id
 * @returns {string}
 */
export function checkCode(id) {
  const text = String(id ?? "").trim();
  const found = /^(C\d+)(?![\w])/u.exec(text);
  return found ? found[1] : text;
}

/**
 * 拼出机器可读汇总行（生产者用）。
 *
 * @param {{ id?: string, checks: number, fail?: number, dry?: boolean,
 *   failed?: string[], status?: "ok"|"fail"|"error" }} line
 *   `checks` = 实际跑过的 `check()` 条数；`fail` = 其中红的条数；`failed` = 红的那几条的 id；
 *   `dry` = `--dry` 真跑了没有（自报，不许把 C1–C7 未跑说成全过）。
 * @returns {string}
 */
export function formatSmokeLine({
  id = SMOKE_STEP_ID, checks, fail = 0, dry = false, failed = [], status = "ok",
} = {}) {
  const total = Number(checks);
  const red = Number(fail);
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`checks 必须是非负整数，实际 ${JSON.stringify(checks)}`);
  }
  if (!Number.isInteger(red) || red < 0) {
    throw new Error(`fail 必须是非负整数，实际 ${JSON.stringify(fail)}`);
  }
  if (red > total) {
    throw new Error(`fail=${red} 大于 checks=${total}：自相矛盾的汇总行不如不印（红数来自 check() 结果）`);
  }
  if (!STATUS_SET.has(status)) {
    throw new Error(`status 必须是 ${SMOKE_STATUSES.join(" / ")} 之一，实际 ${JSON.stringify(status)}`);
  }
  if (!Array.isArray(failed)) {
    throw new Error(`failed 必须是数组（红的那几条 check id），实际 ${typeof failed}`);
  }
  const codes = failed.map(checkCode).filter((code) => code !== "");
  if (codes.length !== red) {
    throw new Error(`failed 列表 ${codes.length} 条与 fail=${red} 对不上：失败 id 与失败数必须是同一份事实`);
  }
  return [
    SMOKE_PREFIX,
    `id=${id}`,
    `checks=${total}`,
    `pass=${total - red}`,
    `fail=${red}`,
    `dry=${dry === true ? "true" : "false"}`,
    `failed=${codes.length > 0 ? codes.join(",") : "-"}`,
    `status=${status}`,
  ].join(" ");
}

/**
 * 从子进程输出里读回汇总行（消费者用）。多条命中取**最后**一条（生产者只在收尾印一次，
 * 取最后一条是为了万一有中间态也不被它骗）。
 *
 * 判据：三个计数缺一个、或 `pass + fail !== checks`（自相矛盾）⇒ 返回 `undefined`——
 * 当「没读到」，**不许**降级成 0。
 *
 * @param {string} text
 * @returns {{ id: string, checks: number, pass: number, fail: number, dry: boolean,
 *   failed: string[], status: string } | undefined}
 */
export function parseSmokeLine(text) {
  if (typeof text !== "string" || text === "") return undefined;
  const line = text
    .split("\n")
    .map((raw) => raw.trim())
    .filter((raw) => raw.startsWith(SMOKE_PREFIX))
    .at(-1);
  if (line === undefined) return undefined;
  const fields = new Map();
  for (const token of line.slice(SMOKE_PREFIX.length).trim().split(/\s+/u)) {
    if (token === "") continue;
    const at = token.indexOf("=");
    if (at <= 0) continue;
    fields.set(token.slice(0, at), token.slice(at + 1));
  }
  const num = (key) => {
    const raw = fields.get(key);
    return raw !== undefined && /^\d+$/u.test(raw) ? Number(raw) : undefined;
  };
  const checks = num("checks");
  const pass = num("pass");
  const fail = num("fail");
  if (checks === undefined || pass === undefined || fail === undefined) return undefined;
  if (pass + fail !== checks) return undefined;
  const failed = (fields.get("failed") ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code !== "" && code !== "-");
  return {
    id: fields.get("id") ?? "",
    checks,
    pass,
    fail,
    dry: fields.get("dry") === "true",
    failed,
    status: fields.get("status") ?? "ok",
  };
}
