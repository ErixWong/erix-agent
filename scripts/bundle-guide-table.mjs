#!/usr/bin/env node
// 破坏包逐名表的**唯一读法**（一个读法，两个消费者：`scripts/docs-drift-check.mjs` 与
// `scripts/host-consumer-probe.mjs`）。
//
// 为什么要单独一个模块而不是各读各的：那张表（`docs/host-upgrade-guide-<版本>.md` 里一行一个名字、
// 带迁移条款与入口列的 Markdown 表）有两个判据在看——
//   ① `docs-drift-check` 的 `bundle-table`：表的名字集合 ↔ 现算候选集**双向**对账、中英一致、条款照抄
//      `@deprecated` 标记、入口列现读 `src/index.js` / `src/tools/index.js`；
//   ② `host-consumer-probe` 的覆盖判据：宿主真的在 import 的名字，**必须**在这张表里有一行条目。
// 两个判据各自抄一份「表怎么读」，就是两条会各自漂移的真相（同一个病：抄一份名单 = 多一条漂移路径）。
// 所以表的形状（几格、第一格长什么样、入口列认哪几种写法、版本号从哪来）只写在这里，两边 import。
//
// 它**不判定**任何事：只把表读成结构（`name → {line, clause, entry}`）。裁决留在各自的判据里。
//
// 用法：
//   import { BUNDLE_GUIDE_DOCS, bundleRowsFromText } from "./bundle-guide-table.mjs";
//
// 这个文件没有 CLI 入口（`node scripts/bundle-guide-table.mjs` 什么都不做，exit 0）：它是库，不是门。

/** 破坏包对应的指南版本（`<NEXT_BREAKING_VERSION>.0`；`docs-drift-check` 会校它等于唯一合法移除边界）。 */
export const BUNDLE_GUIDE_VERSION = "0.30.0";
export const BUNDLE_GUIDE_EN = `docs/host-upgrade-guide-${BUNDLE_GUIDE_VERSION}.md`;
export const BUNDLE_GUIDE_CN = `docs/host-upgrade-guide-${BUNDLE_GUIDE_VERSION}_cn.md`;
/** 两份（中英成对）：名字集合必须相等，条款与入口列必须逐字相同。 */
export const BUNDLE_GUIDE_DOCS = [BUNDLE_GUIDE_EN, BUNDLE_GUIDE_CN];

/** 入口列的合法写法（逐字）：只 `.`、只 `./tools`、两者都有（用 `+` 连接）。 */
export const BUNDLE_ENTRY_TOKENS = new Map([
  ["`.`", "root"],
  ["`./tools`", "tools"],
]);

/** 一行的表格格（`| a | b |` → `["a", "b"]`）；不是表格行返 null。 */
export function tableCells(line) {
  const trimmed = line.trim();
  if (trimmed.length < 2 || !trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

/** 逐名表的一行：**恰好 5 格**且第一格是**恰好一个**反引号标识符（别的表格不会被误当成逐名行）。 */
export const BUNDLE_ROW_NAME_RE = /^`([A-Za-z_$][\w$]*)`$/;

/**
 * 一份指南**文本**里的逐名行与重复行。
 *
 * 纯函数（吃文本、不吃路径）：`host-consumer-probe --self-test` 因此能在内存夹具上反向证，
 * 不用往仓里写文件。
 *
 * @param {string} text 指南原文
 * @returns {{rows: Map<string, {name: string, line: number, clause: string, entry: string}>, dupes: string[]}}
 *   行号 1 起；`clause` 是迁移条款格，`entry` 是入口列格（**未**校验写法，校验在调用侧）。
 */
export function bundleRowsFromText(text) {
  const rows = new Map();
  const dupes = [];
  String(text ?? "").split("\n").forEach((line, i) => {
    const cells = tableCells(line);
    if (!cells || cells.length !== 5) return;
    const m = BUNDLE_ROW_NAME_RE.exec(cells[0]);
    if (!m) return;
    const row = { name: m[1], line: i + 1, clause: cells[2], entry: cells[3] };
    if (rows.has(m[1])) dupes.push(`\`${m[1]}\`（第 ${rows.get(m[1]).line} 行与第 ${i + 1} 行）`);
    else rows.set(m[1], row);
  });
  return { rows, dupes };
}

/** 入口列 → 声称的入口集合（写法不认识返 null，调用侧报红）。 */
export function bundleEntryClaim(cell) {
  const parts = String(cell ?? "").split("+").map((part) => part.trim()).filter(Boolean);
  const claimed = new Set();
  for (const part of parts) {
    const key = BUNDLE_ENTRY_TOKENS.get(part);
    if (!key) return null;
    claimed.add(key);
  }
  return claimed.size ? claimed : null;
}
