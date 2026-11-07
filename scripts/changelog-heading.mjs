// @ts-check
// changelog-heading.mjs — CHANGELOG **版本节标题 / 段首日期 / bullet** 三条口径的**唯一来源**（issue #731 N4 / N3）。
//
// 病根（#731 记的）：同一套「什么算一个版本节 / 段首算不算带日期 / 什么算一条 bullet」在仓库里有**四份**：
//   · `scripts/release-day.mjs`（preflight 第 2 步 `[Unreleased]` 漏搬格）
//   · `scripts/docs-drift-check.mjs` 的 `changelogSections()`（`check:docs` 的 §17 / §17b 一族都读它）
//   · `test/static-guards.test.js`（规则 8 的五条判据 + 中英配对地板，两处 bullet 判据实现）
// 日期正则两侧**字面相同**（是拷贝，不是 import），标题正则**已经分叉**：一侧 `^##\s*\[<版本>\]`（容忍多空格），
// 一侧 `/^## \[(\d+\.\d+\.\d+)\](.*)$/`（字面单空格）⇒ `##  [0.31.0]（未发布）`（两个空格）两个读者两个答案。
// 今天树里没有这种标题，所以没炸；但「两个读者对同一棵树两个答案」这件事本身就是等待发生的假绿/假红。
//
// ── 本模块选的口径（写在这里，不散落回注释）──────────────────────────────────────────
//   1. **标题行：`##` + 恰好一个空格 + `[`。** 与 `docs-drift-check.mjs` 现有那条一致，两侧收敛到它。
//      为什么取**严格**那一侧而不是放松的那一侧：
//        · `## [X.Y.Z] - <日期>` 是 `docs-drift-check --sync` 与 `4963293` 先例**实际写出来**的形状，
//          也是 Keep a Changelog 的形状；多一个空格是手写歪了，不是另一种合法方言。
//        · 放松会让 `release-day` 把 `##  [0.31.0] - 2026-11-04` 当成版本节并可能判**绿**，
//          而 `check:docs`（§17 发布态 / §17b 段首日期）与 `test/static-guards.test.js` 的规则 8
//          **看不见这一节**（它们都按单空格读）⇒ 一条「绿」的 preflight 压着一个从没被对账过的段，
//          那正是本仓最忌的**假绿**。严格那一侧最坏是把歪标题判成「还没切版」（未判定，且判词给出
//          「插入 `## [X.Y.Z]（未发布 / unpublished）`」的动作），**未判定不是绿**，方向是安全的。
//   2. **段首日期：`^\s*[-—]\s*(\d{4}-\d{2}-\d{2})`。** 两侧本来就是同一份字面，收敛零行为改动。
//   3. **bullet：行首 `- `。** 三处判据此前各自写字面（`*` 星号条目不算 bullet、围栏代码块里的 `- x`
//      算 bullet —— 这两个已知不对称**两侧一致**，所以今天不会分叉，只是没人钉）。本模块共享的是
//      **行级谓词**而不是整棵解析器：三处的**扫描面与小节语义本就不同**（`release-day` 扫 `[Unreleased]`
//      整节；规则 8 扫 `resolveChangelogScanSurface()` 选出的那一节并按 `### ` 切小节；配对地板按自己的
//      「条目 + 续行」单位配对），把它们压成一个函数会改动**判据实现**并连带挪 `CHANGELOG_PAIR_FLOOR`
//      的实测值。谓词同源 ⇒ 行级规则不可能再分叉；那两个不对称由 `test/static-guards.test.js` 里
//      「同一棵树，三个读者同一结论」那一格钉住（改任何一侧的口径都必须同时改另一侧与那条用例）。
//
// 纪律：要改这三条口径，**只改这个文件**，然后跑
//   `node scripts/release-day.mjs --self-test`、`node --test test/static-guards.test.js`、`npm run check:docs`。
// 在调用方重新写一条字面正则 = 重新开出 #731 那个洞；`release-day --self-test` ⑯e 会当场红（它 grep 两份
// 调用方的源码，见到字面拷贝就点名）。

/**
 * 版本节标题（严格：`##` + 恰好一个空格 + `[` + `X.Y.Z` + `]`）。
 * 捕获组 1 = 版本号，组 2 = `]` 之后的整段后缀（段首日期 / 「未发布」标记都住在它里面）。
 *
 * ⚠ **没有 `g`**：三处都走 `.test` / `.exec` / `.match`，共享 `lastIndex` 那个坑只要有人加 `g` 就会回来。
 * @type {RegExp}
 */
export const CHANGELOG_VERSION_HEADING_RE = /^## \[(\d+\.\d+\.\d+)\](.*)$/u;

/** `]` 之后的后缀里「带发布日期」的形状（`- 2026-11-04` / `— 2026-11-04`）。 */
export const CHANGELOG_DATED_HEADING_SUFFIX = /^\s*[-—]\s*(\d{4}-\d{2}-\d{2})/u;

/** 顶部那一个版本节的**标题字面**（`release-day.mjs` 的 `UNRELEASED_HEADING` 与 static-guards 的 `CHANGELOG_VERSION_HEADING` 同一字面）。 */
export const CHANGELOG_UNRELEASED_HEADING = "## [Unreleased]";

/** 一条 bullet 的行级谓词（**唯一来源**；已知不对称见文件头第 3 条）。 */
export const CHANGELOG_BULLET_PREFIX = "- ";

/**
 * 这一行是不是一个版本节的标题行。
 * @param {string} line
 * @returns {{version: string, suffix: string}|null} `null` = 不是版本节标题（含 `##  [x]` 这种歪缩进）
 */
export function matchChangelogVersionHeading(line) {
  const m = CHANGELOG_VERSION_HEADING_RE.exec(line);
  return m ? { version: m[1], suffix: m[2] ?? "" } : null;
}

/** 这一段的**后缀**里有没有发布日期（入参是 `matchChangelogVersionHeading().suffix`）。 */
export function changelogHeadingIsDated(suffix) {
  return CHANGELOG_DATED_HEADING_SUFFIX.test(String(suffix ?? ""));
}

/** 给定版本号的标题正则（`release-day` 找本版那一格用；与 `CHANGELOG_VERSION_HEADING_RE` 同一口径）。 */
export function changelogVersionHeadingRe(version) {
  return new RegExp(`^## \\[${String(version).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\]`, "u");
}

/** 这一行是不是一条 bullet 的**起始行**（不含缩进续行；口径见文件头第 3 条）。 */
export function isChangelogBulletLine(line) {
  return String(line).startsWith(CHANGELOG_BULLET_PREFIX);
}
