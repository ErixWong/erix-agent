/**
 * `scripts/cell-axes-anchors.mjs` — 两轴载荷表（`docs/host-consumer-contract.md` /
 * `docs/host-consumer-contract_cn.md` 里 `<!-- erix:snapshot-cell-axes:begin/end -->` 之间那张表）
 * 的**锚点登记表**，14 格 × 两轴，是「表里每条 `path:line` 到底钉在哪一行」的唯一真值。
 *
 * 为什么住在 `scripts/` 而不是住在测试里（issue #772 R3）：
 *   R2 把登记表放在 `test/contract-snapshot-cell-axes-767.test.js`，闸（`docs-drift-check.mjs`）
 *   再用正则从测试文本里把它抽出来重算。结果是**豁免是闸发的，锚点却住在测试里**：只有
 *   `node --test` 会按锚点重算行号，`npm run check:docs` 看不见（评审实测：错引到注释行时
 *   `node --test` 红、`check:docs` 仍是 exit 0）。R3 把它抬成两边共同 import 的模块——
 *   **单一真值，禁止两处各存一份副本**：
 *     · `test/contract-snapshot-cell-axes-767.test.js` 直接 import 数组与判据函数；
 *     · `scripts/docs-drift-check.mjs` 也 import 本模块（判据函数 + 地板值 + 出厂数组），
 *       并且在 `--self-test` 里要能吃覆盖层的**文本**，所以它额外走 `parseCellAxesAnchorTable()`
 *       从覆盖层文本里抽同一份数组（覆盖层只改文本、改不动已加载的模块，见 #273/#279 同一课）。
 *
 * `anchor` 必须是**能区分这件事的源码字面/正则**（正则按整行 `test`），不是键名——
 * 键名词面匹配在注释行上同样成立，R2 之前的 fail-open 就长那样（#772 R2 评审第 4 节：
 * `orchestrator.js:3015` 是讲 `compactionStats` 的注释，键名判据照过）。
 * 命中 **0 行或 >1 行**都判红：歧义锚点不配当基准。
 * 每条带 `note`：说明这条锚钉的是哪一类事实（写入位置 / 停写证据）以及它命中的那一行长什么样，
 * 注意 note 是**给人读的说明**，不参与任何判据（判据只认 `anchor` 现算的命中行号）。
 */

/** 本模块的仓库内路径（闸与测试都用它定位「登记表在场否」）。 */
export const CELL_AXES_ANCHOR_MODULE = "scripts/cell-axes-anchors.mjs";

/** 登记表的地板（只许涨不许降）：表被削薄 = 不再逐格钉 ⇒ 豁免不能给。 */
export const CELL_AXES_ANCHOR_FLOORS = { entries: 30, groups: 25 };   // 建单时 39 条 / 27 组

// CELL-AXES-ANCHORS:BEGIN —— 哨兵之间必须是**数组字面量**（闸在 --self-test 里要能抽文本重算）
export const CELL_AXES_ANCHORS = [
  { key: "round", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}round,$", prev: "^ +return await persist\\(method, runId, \\{$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 round," },
  { key: "status", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}status,$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 status," },
  { key: "pendingToolUse", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}pendingToolUse: cloneState\\(snapshotPendingToolUse\\),$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 pendingToolUse: cloneState(snapshotPendingToolUse)," },
  { key: "pendingToolUses", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}pendingToolUses: cloneState\\(snapshotPendingToolUses\\),$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 pendingToolUses: cloneState(snapshotPendingToolUses)," },
  { key: "executedToolIds", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}executedToolIds: \\[\\.\\.\\.executedToolIds\\],$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 executedToolIds: [...executedToolIds]," },
  { key: "toolResults", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}toolResults: toolResults\\.map\\(\\(toolResult\\) => \\(\\{$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 toolResults: toolResults.map((toolResult) => ({" },
  { key: "toolOutputs", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}toolOutputs: cloneState\\(archivedOutputs\\.filter", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 toolOutputs: cloneState(archivedOutputs.filter((entry) => entry.round " },
  { key: "toolOutputs", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {10}toolOutputs: archivedOutputs$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 toolOutputs: archivedOutputs" },
  { key: "messages", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}messages: snapshotTranscriptResidue,$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 messages: snapshotTranscriptResidue," },
  { key: "persistedTranscriptLength", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}persistedTranscriptLength: runLoopState\\.persistedTranscriptLength,$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 persistedTranscriptLength: runLoopState.persistedTranscriptLength," },
  { key: "persistedTranscriptLength", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}persistedTranscriptLength: runLoopState\\.persistedTranscriptLength,$", row: 1, note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 persistedTranscriptLength: runLoopState.persistedTranscriptLength,（同名第 2 次出现）" },
  { key: "partialText", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}\\.\\.\\.\\(partialText === undefined \\? \\{\\} : \\{ partialText, partialRound \\}\\),$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 ...(partialText === undefined ? {} : { partialText, partialRound })," },
  { key: "partialRound", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}\\.\\.\\.\\(partialText === undefined \\? \\{\\} : \\{ partialText, partialRound \\}\\),$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 ...(partialText === undefined ? {} : { partialText, partialRound })," },
  { key: "toolUse", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "里面\\*\\*没有\\*\\* `toolUse` 也没有 `ts`", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 //   `pendingToolUses` / `round` / `toolOutputs` / `toolResults`，里面**没" },
  { key: "ts", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ +// - `ts`：同上口径，快照对象那一层没人读它", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 // - `ts`：同上口径，快照对象那一层没人读它；读侧确实处理的 `ts` 是**账本行 / 消息行**的 `ts`" },
  { key: "compactionStats", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}compactionStats: cloneState\\(compactionStats\\),$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 compactionStats: cloneState(compactionStats)," },
  { key: "compactionStats", axis: "write", codePath: "src/loop/orchestrator.js", anchor: "^ {8}\\? \\{ compactionStats: cloneState\\(compactionStats\\.slice\\(compactionStatsStart\\)\\) \\}$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 ? { compactionStats: cloneState(compactionStats.slice(compactionStatsS" },
  { key: "round", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "const crashRound = Number\\.isSafeInteger\\(snapshot\\.round\\)", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const crashRound = Number.isSafeInteger(snapshot.round)" },
  { key: "round", axis: "read", codePath: "src/loop/orchestrator.js", anchor: "const crashRound = runLoopState\\.resumeRunSnapshot\\?\\.round;$", note: "停写/读取证据锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 const crashRound = runLoopState.resumeRunSnapshot?.round;" },
  { key: "pendingToolUses", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "const crashToolUses = ctx\\.resumeRunSnapshot\\?\\.pendingToolUses$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const crashToolUses = ctx.resumeRunSnapshot?.pendingToolUses" },
  { key: "pendingToolUses", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "const pendingTools = snapshot\\.pendingToolUses$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const pendingTools = snapshot.pendingToolUses" },
  { key: "pendingToolUse", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "\\?\\? \\(ctx\\.resumeRunSnapshot\\?\\.pendingToolUse \\? \\[ctx\\.resumeRunSnapshot\\.pendingToolUse\\] : \\[\\]\\);$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 ?? (ctx.resumeRunSnapshot?.pendingToolUse ? [ctx.resumeRunSnapshot.pen" },
  { key: "pendingToolUse", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "^ +\\?\\? \\(snapshot\\.pendingToolUse$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 ?? (snapshot.pendingToolUse" },
  { key: "executedToolIds", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "for \\(const id of snapshot\\.executedToolIds \\?\\? \\[\\]\\) \\{$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 for (const id of snapshot.executedToolIds ?? []) {" },
  { key: "executedToolIds", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "!snapshot\\.executedToolIds\\?\\.includes\\(pendingTool\\.id\\)", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 !snapshot.executedToolIds?.includes(pendingTool.id)" },
  { key: "toolResults", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "\\|\\| \\(ctx\\.resumeRunSnapshot\\?\\.toolResults \\?\\? \\[\\]\\)\\.some\\(\\(entry\\) => \\($", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 || (ctx.resumeRunSnapshot?.toolResults ?? []).some((entry) => (" },
  { key: "toolResults", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "for \\(const entry of snapshot\\.toolResults \\?\\? \\[\\]\\) \\{$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 for (const entry of snapshot.toolResults ?? []) {" },
  { key: "toolOutputs", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "for \\(const output of snapshot\\.toolOutputs \\?\\? \\[\\]\\) \\{$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 for (const output of snapshot.toolOutputs ?? []) {" },
  { key: "toolOutputs", axis: "read", codePath: "bin/final-guard-support.js", anchor: "\\(Array\\.isArray\\(record\\?\\.toolOutputs\\) \\? record\\.toolOutputs : \\[\\]\\)$", note: "停写/读取证据锚点：在 bin/final-guard-support.js 里唯一命中的那一行是 (Array.isArray(record?.toolOutputs) ? record.toolOutputs : [])" },
  { key: "messages", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "const snapshotBody = Array\\.isArray\\(snapshot\\.messages\\)", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const snapshotBody = Array.isArray(snapshot.messages)" },
  { key: "persistedTranscriptLength", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "不能信快照里的 `persistedTranscriptLength`", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 // issue #425：**恢复锚点必须在恢复时现算**，不能信快照里的 `persistedTranscriptLength`——" },
  { key: "persistedTranscriptLength", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "^ +ctx\\.persistedTranscriptLength = ctx\\.messages\\.length;$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 ctx.persistedTranscriptLength = ctx.messages.length;" },
  { key: "persistedTranscriptLength", axis: "read", codePath: "src/loop/orchestrator.js", anchor: "^ +runLoopState\\.persistedTranscriptLength \\?\\? 0,$", row: 1, note: "停写/读取证据锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 runLoopState.persistedTranscriptLength ?? 0,（同名第 2 次出现）" },
  { key: "partialText", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "\\|\\| \\(typeof ctx\\.resumeRunSnapshot\\?\\.partialText === \"string\"$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 || (typeof ctx.resumeRunSnapshot?.partialText === \"string\"" },
  { key: "partialText", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "^ +const partialText = snapshot\\.partialText;$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const partialText = snapshot.partialText;" },
  { key: "partialRound", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "^ +const partialRound = snapshot\\.partialRound;$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const partialRound = snapshot.partialRound;" },
  { key: "toolUse", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "const unfinishedToolUses = crashToolUses\\.filter\\(\\(toolUse\\) => \\($", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const unfinishedToolUses = crashToolUses.filter((toolUse) => (" },
  { key: "ts", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "^ +record\\.ts,$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 record.ts," },
  { key: "compactionStats", axis: "read", codePath: "src/loop/resume-manager.js", anchor: "^ +ctx\\.compactionStats = deterministic\\.compactionStats;$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 ctx.compactionStats = deterministic.compactionStats;" },
];
// CELL-AXES-ANCHORS:END

/** 哨兵之间的数组字面量（`scripts/docs-drift-check.mjs` 抽覆盖层文本用）。 */
export const CELL_AXES_ANCHOR_BLOCK = /\/\/ CELL-AXES-ANCHORS:BEGIN[^\n]*\n[\s\S]*?export const CELL_AXES_ANCHORS = (\[[\s\S]*?\n\]);\n\/\/ CELL-AXES-ANCHORS:END/u;

/**
 * 锚点在目标文件里命中的行号（1 基）。两条约束都是判据的一部分：`anchor` 那一行必须命中，
 * 带了 `prev` 的还要邻行也命中（只靠本行消不了歧的那些，例：`round,`）。
 * 命中 0 次或多次都交给调用方判红——**歧义锚点不配当基准**。
 * 正则跑不通（被人改成非法正则）返回 `{ error }`，同样不许静默放行。
 */
export function anchorHitLines(fileLines, entry) {
  let hit;
  let prev = null;
  try {
    hit = new RegExp(entry.anchor, "u");
    if (entry.prev !== undefined && entry.prev !== null) prev = new RegExp(entry.prev, "u");
  } catch (error) {
    return { error: `锚点正则跑不通：${error.message}` };
  }
  const hits = [];
  fileLines.forEach((line, index) => {
    if (!hit.test(line)) return;
    if (prev !== null && !prev.test(fileLines[index - 1] ?? "")) return;
    hits.push(index + 1);
  });
  return { hits };
}

/** 一格的第几行 + 哪个轴 + 哪个文件 ⇒ 一组引用的基准键。 */
export const anchorGroupKey = (key, axis, rowIndex, codePath) => `${key}|${axis}|${rowIndex}|${codePath}`;

/** 等值对账：表里写的行号集合与锚点重算的行号集合是否**完全相等**（多 / 少 / 换一条都是 false）。 */
export const anchorLinesEqual = (citedLines, anchorLines) => {
  const sort = (list) => [...list].sort((a, b) => a - b).join(",");
  return [...citedLines].length === [...anchorLines].length && sort(citedLines) === sort(anchorLines);
};

/**
 * 把登记表算成「组键 → 行号集合」，并把**唯一命中**判据的破口作为错误文本返回（不抛，
 * 好让闸与反向证都拿合成数据问它）。
 * @param {object[]} anchors 登记表
 * @param {(rel: string) => string[]|null} linesOf 取文件按行（不在场返回 null）
 * @param {(rel: string) => boolean} [existsOf] 判文件在场（默认按 linesOf 返回 null 判不在场）
 * @returns {{groups: Map<string, Set<number>>, errors: string[]}}
 */
export function computeAnchorGroups(anchors, linesOf, existsOf) {
  const groups = new Map();
  const errors = [];
  for (const entry of anchors) {
    const where = `\`${entry.key}\` 的 ${entry.axis} 锚点（${entry.codePath}，正则 ${entry.anchor}）`;
    if (existsOf && !existsOf(entry.codePath)) {
      errors.push(`锚点指向的文件不在场：${entry.codePath}（${where}）`);
      continue;
    }
    const lines = linesOf(entry.codePath);
    if (lines === null || lines === undefined) {
      errors.push(`锚点指向的文件不在场：${entry.codePath}（${where}）`);
      continue;
    }
    const { hits, error } = anchorHitLines(lines, entry);
    if (error) { errors.push(`${where}：${error}`); continue; }
    if (hits.length !== 1) {
      errors.push(hits.length === 0
        ? `锚点 0 命中（${where}）⇒ 锚点已失效，表里那些行号没有基准`
        : `锚点歧义（${where}）命中 ${hits.length} 行：${hits.map((n) => `:${n}`).join(" ")}`
          + ` ⇒ 歧义锚点不配当基准`);
      continue;
    }
    const gk = anchorGroupKey(entry.key, entry.axis, entry.row ?? 0, entry.codePath);
    groups.set(gk, new Set([...(groups.get(gk) ?? []), ...hits]));
  }
  return { groups, errors };
}

/** 登记表的形状统计（闸与测试都用它报数，避免两处各写一份口径）。 */
export function anchorTableShape(anchors) {
  return {
    entries: anchors.length,
    groups: new Set(anchors.map((e) => `${e.key}|${e.axis}`)).size,
    cells: new Set(anchors.map((e) => e.key)).size,
  };
}

/**
 * 从**文本**里抽登记表（`--self-test` 的覆盖层只改文本，跑不到新版本的模块）。
 * @param {string|null|undefined} text 模块文本（null = 文件不在场）
 * @returns {{entries: object[]}|{why: string}} 抽不到时 `why` = 拿不到豁免的原因
 */
export function parseCellAxesAnchorTable(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { why: `${CELL_AXES_ANCHOR_MODULE} 不在场（被改名或删除 ⇒ 表里那些 file:line 没有登记锚点）` };
  }
  const m = CELL_AXES_ANCHOR_BLOCK.exec(text);
  if (!m) {
    return { why: "抽不到 `// CELL-AXES-ANCHORS:BEGIN … export const CELL_AXES_ANCHORS = [ … ]; … // CELL-AXES-ANCHORS:END`"
      + " 这段**数组字面量**（改成函数调用/删哨兵都算：闸必须能自己重算，不能只信运行时对象）" };
  }
  let entries;
  try {
    entries = new Function(`"use strict"; return ${m[1]};`)();   // eslint-disable-line no-new-func
  } catch (error) {
    return { why: `锚点表字面量跑不通：${error.message}` };
  }
  if (!Array.isArray(entries)) return { why: "锚点表不是数组" };
  const bad = entries.find((e) => !e || typeof e.key !== "string" || typeof e.axis !== "string"
    || typeof e.codePath !== "string" || typeof e.anchor !== "string");
  if (bad !== undefined) {
    return { why: "锚点表里有缺字段的条目：每条必须是 `{ key, axis, codePath, anchor, note }`"
      + `（codePath = 被钉的源码文件，anchor = 能区分这件事的源码字面/正则，不是键名）` };
  }
  const shape = anchorTableShape(entries);
  if (shape.entries < CELL_AXES_ANCHOR_FLOORS.entries) {
    return { why: `锚点登记表只剩 ${shape.entries} 条（下限 ${CELL_AXES_ANCHOR_FLOORS.entries}）⇒ 表不再逐格钉，豁免不能给` };
  }
  if (shape.groups < CELL_AXES_ANCHOR_FLOORS.groups) {
    return { why: `锚点登记表只剩 ${shape.groups} 组（下限 ${CELL_AXES_ANCHOR_FLOORS.groups}）⇒ 逐格钉不成立` };
  }
  return { entries };
}
