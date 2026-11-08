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
 *
 * 每条还带 `kind`（issue #772 R4 M-A）：`"code"` = 钉的是真代码行（写入位置 / 读取点），
 * `"comment"` = 钉的是**解释性注释**（只有 `toolUse` / `ts` 两格的「为什么已经没有写点」证据，
 * 以及 `persistedTranscriptLength` 读侧那条「不能信快照里的它」的注释）。
 * 判据在 `anchorKindError()` 这一份函数里（闸与测试共用，禁止两处各写一遍）：
 * `kind: "code"` 而唯一命中的那一行是注释行 ⇒ 红，`kind: "comment"` 而命中的不是注释行 ⇒ 红。
 * 它堵的是「锚点指到一条只是**提到**键名的注释、两份契约表的引文同步改口」——那种形状下
 * 行号等值对账是自洽的（表写的就是锚点算出的那一行），光比行号看不见（#772 R4 评审 M-A）。
 *
 * 覆盖面另有一份**与登记表无关的独立真值** `CELL_AXES_REQUIRED_CELLS`（#772 R4 M-B）：
 * 登记表的地板以前是手填的 `30 / 25`，于是「成对删掉登记条目 + 两份表里的对应引文」可以
 * 把 39 条削到 31 条而两道闸照绿（覆盖面无声削薄）。现在地板由那份清单算出来，
 * 且每一格都要在清单、登记、EN 表、CN 表四处各自在场（`checkCellAxesCoverage()`）。
 */

/** 本模块的仓库内路径（闸与测试都用它定位「登记表在场否」）。 */
export const CELL_AXES_ANCHOR_MODULE = "scripts/cell-axes-anchors.mjs";

/**
 * **必须存在的格子**（#772 R4 M-B，独立于登记表的第二份真值）：人审过的那份 `(key, axis)` 清单，
 * 就是这两份契约表**应当**覆盖的全部格子——每一条 = 一个必须存在的槽位（同 key+axis+codePath+row
 * 重复出现 N 次 = 这一格这一轴在这个文件上必须有 N 条引用/登记，例：`toolOutputs` 的 write 同时钉
 * 快照侧与轮记录侧两条）。它**不许**从 `CELL_AXES_ANCHORS` 现算出来（那就不是第二份真值了），
 * 只能人审手写；闸与测试共同 import 它。
 *
 * 判据在 `checkCellAxesCoverage()`：每一格都要在 ① 这份清单 ② `CELL_AXES_ANCHORS` 的登记
 * ③ EN 表 ④ CN 表四处各自在场，缺任一处 ⇒ 红，并点名「缺哪一格、缺在哪一份里」。
 * 为什么需要它：以前只有「删登记、**留**引文」会红（引文没有基准）；把登记条目和两份表里的
 * 引文**成对**删掉，剩下的那些仍然自洽 ⇒ 覆盖面可以无声削薄（#772 R4 评审 M-B：削到 31 条 / 27 组，
 * 手填地板 30 / 25 照过）。
 */
export const CELL_AXES_REQUIRED_CELLS = [
  // ── 写入侧（快照对象那一层 + 轮记录侧）──
  { key: "round", axis: "write", codePath: "src/loop/orchestrator.js" },
  { key: "status", axis: "write", kind: "comment", codePath: "src/loop/orchestrator.js", anchor: "^ {8}// ⇒ `status` 停写的理由：", note: "停写解释锚点：这里没有写点，钉解释「为什么这里没有写点」的那行注释（#770）" },
  { key: "pendingToolUse", axis: "write", codePath: "src/loop/orchestrator.js" },
  { key: "pendingToolUses", axis: "write", codePath: "src/loop/orchestrator.js" },
  { key: "executedToolIds", axis: "write", codePath: "src/loop/orchestrator.js" },
  { key: "toolResults", axis: "write", codePath: "src/loop/orchestrator.js" },
  { key: "toolOutputs", axis: "write", codePath: "src/loop/orchestrator.js" },
  { key: "toolOutputs", axis: "write", codePath: "src/loop/orchestrator.js" },        // 轮记录侧那一条
  { key: "messages", axis: "write", codePath: "src/loop/orchestrator.js" },
  { key: "persistedTranscriptLength", axis: "write", codePath: "src/loop/orchestrator.js" },      // 表里第 1 行（on-disk 格）
  { key: "persistedTranscriptLength", axis: "write", codePath: "src/loop/orchestrator.js", row: 1 },  // 表里第 2 行（in-process 格）
  { key: "partialText", axis: "write", codePath: "src/loop/orchestrator.js" },
  { key: "partialRound", axis: "write", codePath: "src/loop/orchestrator.js" },
  { key: "toolUse", axis: "write", codePath: "src/loop/orchestrator.js" },             // stopped：注释行（kind=comment）
  { key: "ts", axis: "write", codePath: "src/loop/orchestrator.js" },                  // stopped：注释行（kind=comment）
  { key: "compactionStats", axis: "write", codePath: "src/loop/orchestrator.js" },
  { key: "compactionStats", axis: "write", codePath: "src/loop/orchestrator.js" },      // 轮记录侧那一条
  // ── 读取侧 ──
  { key: "round", axis: "read", codePath: "src/loop/resume-manager.js" },
  { key: "round", axis: "read", codePath: "src/loop/orchestrator.js" },
  { key: "pendingToolUses", axis: "read", codePath: "src/loop/resume-manager.js" },
  { key: "pendingToolUses", axis: "read", codePath: "src/loop/resume-manager.js" },
  { key: "pendingToolUse", axis: "read", codePath: "src/loop/resume-manager.js" },
  { key: "pendingToolUse", axis: "read", codePath: "src/loop/resume-manager.js" },
  { key: "executedToolIds", axis: "read", codePath: "src/loop/resume-manager.js" },
  // issue #769：读轴的**账本来源**（`tool-executed` 恢复行）——快照那一格从此是兜底，读者多一个。
  { key: "toolResults", axis: "read", codePath: "src/loop/resume-manager.js" },
  { key: "toolResults", axis: "read", codePath: "src/loop/resume-manager.js" },
  { key: "toolOutputs", axis: "read", codePath: "src/loop/resume-manager.js" },         // 快照侧回填
  { key: "toolOutputs", axis: "read", codePath: "bin/final-guard-support.js" },         // 轮记录侧 final guard
  { key: "messages", axis: "read", codePath: "src/loop/resume-manager.js" },
  { key: "persistedTranscriptLength", axis: "read", codePath: "src/loop/resume-manager.js" },  // 注释「不能信它」那一条
  { key: "persistedTranscriptLength", axis: "read", codePath: "src/loop/resume-manager.js" },  // 现算覆盖那一条
  { key: "persistedTranscriptLength", axis: "read", codePath: "src/loop/orchestrator.js", row: 1 },  // in-process 格的读者
  { key: "partialText", axis: "read", codePath: "src/loop/resume-manager.js" },
  { key: "partialText", axis: "read", codePath: "src/loop/resume-manager.js" },
  // issue #769：半截正文的读轴多一个**账本来源**（`partial-text` 恢复行）；下面 `partialRound` 同理
  // （两格仍共用同一条写语句，读侧也共用同一行 `ledgerPartial`）。
  { key: "partialRound", axis: "read", codePath: "src/loop/resume-manager.js" },
  // issue #769：这三格的**账本来源**（`kind: "recovery"` 行）——契约读者列钉的是 src/store/recovery-rows.js 那一行格名注释。
  { key: "executedToolIds", axis: "read", codePath: "src/store/recovery-rows.js" },
  { key: "partialText", axis: "read", codePath: "src/store/recovery-rows.js" },
  { key: "partialRound", axis: "read", codePath: "src/store/recovery-rows.js" },
  { key: "toolUse", axis: "read", codePath: "src/loop/resume-manager.js" },
  { key: "ts", axis: "read", codePath: "src/loop/resume-manager.js" },
  { key: "compactionStats", axis: "read", codePath: "src/loop/resume-manager.js" },
];

/**
 * 登记表的地板：**由 `CELL_AXES_REQUIRED_CELLS` 算出来，这两个数不许手调**（#772 R4 M-B）。
 * 手填数（曾是 30 / 25，出厂表 39 / 27）留 9 条余量 ⇒ 「成对删登记 + 删引文」削到 31 条仍过地板，
 * 覆盖面无声削薄。现在条目下限就是清单条数、组数下限就是清单里的 `key|axis` 去重数：
 * 少一条 = 这一格不再被钉 ⇒ 豁免不能给（要削格子必须同批改这份人审清单）。
 */
export const CELL_AXES_ANCHOR_FLOORS = {
  entries: CELL_AXES_REQUIRED_CELLS.length,
  groups: new Set(CELL_AXES_REQUIRED_CELLS.map((cell) => `${cell.key}|${cell.axis}`)).size,
};   // 现算：40 条 / 27 组（14 格），推导见上面的注释——只许随清单涨，不许手调

// CELL-AXES-ANCHORS:BEGIN —— 哨兵之间必须是**数组字面量**（闸在 --self-test 里要能抽文本重算）
export const CELL_AXES_ANCHORS = [
  { key: "round", axis: "write", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ {8}round,$", prev: "^ +return await persistClassified\\(method, status, runId, \\{$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 round," },
  { key: "status", axis: "write", kind: "comment", codePath: "src/loop/orchestrator.js", anchor: "^ {8}// ⇒ `status` 停写的理由：", note: "停写解释锚点：这里没有写点，钉解释「为什么这里没有写点」的那行注释（#770）" },
  { key: "pendingToolUse", axis: "write", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ {8}pendingToolUse: cloneState\\(snapshotPendingToolUse\\),$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 pendingToolUse: cloneState(snapshotPendingToolUse)," },
  { key: "pendingToolUses", axis: "write", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ {8}pendingToolUses: cloneState\\(snapshotPendingToolUses\\),$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 pendingToolUses: cloneState(snapshotPendingToolUses)," },
  { key: "executedToolIds", axis: "write", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ {8}executedToolIds: \\[\\.\\.\\.executedToolIds\\],$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 executedToolIds: [...executedToolIds]," },
  { key: "toolResults", axis: "write", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ {8}toolResults: toolResults\\.map\\(\\(toolResult\\) => \\(\\{$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 toolResults: toolResults.map((toolResult) => ({" },
  { key: "toolOutputs", axis: "write", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ {8}toolOutputs: cloneState\\(archivedOutputs\\.filter", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 toolOutputs: cloneState(archivedOutputs.filter((entry) => entry.round " },
  { key: "toolOutputs", axis: "write", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ {10}toolOutputs: archivedOutputs$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 toolOutputs: archivedOutputs" },
  { key: "messages", axis: "write", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ {8}messages: snapshotTranscriptResidue,$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 messages: snapshotTranscriptResidue," },
  { key: "persistedTranscriptLength", axis: "write", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ {8}persistedTranscriptLength: runLoopState\\.persistedTranscriptLength,$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 persistedTranscriptLength: runLoopState.persistedTranscriptLength," },
  { key: "persistedTranscriptLength", axis: "write", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ {8}persistedTranscriptLength: runLoopState\\.persistedTranscriptLength,$", row: 1, note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 persistedTranscriptLength: runLoopState.persistedTranscriptLength,（同名第 2 次出现）" },
  { key: "partialText", axis: "write", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ {8}\\.\\.\\.\\(partialText === undefined \\? \\{\\} : \\{ partialText, partialRound \\}\\),$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 ...(partialText === undefined ? {} : { partialText, partialRound })," },
  { key: "partialRound", axis: "write", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ {8}\\.\\.\\.\\(partialText === undefined \\? \\{\\} : \\{ partialText, partialRound \\}\\),$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 ...(partialText === undefined ? {} : { partialText, partialRound })," },
  { key: "toolUse", axis: "write", kind: "comment", codePath: "src/loop/orchestrator.js", anchor: "里面\\*\\*没有\\*\\* `toolUse` 也没有 `ts`", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 //   `pendingToolUses` / `round` / `toolOutputs` / `toolResults`，里面**没" },
  { key: "ts", axis: "write", kind: "comment", codePath: "src/loop/orchestrator.js", anchor: "^ +// - `ts`：同上口径，快照对象那一层没人读它", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 // - `ts`：同上口径，快照对象那一层没人读它；读侧确实处理的 `ts` 是**账本行 / 消息行**的 `ts`" },
  { key: "compactionStats", axis: "write", kind: "comment", codePath: "src/loop/orchestrator.js", anchor: "^ {8}// ⇒ `compactionStats` 停写的理由：", note: "停写解释锚点：快照这一格没有写点（钉解释注释）；同轴另一条登记的是轮记录那处真写点（#770）" },
  { key: "compactionStats", axis: "write", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ {8}\\? \\{ compactionStats: cloneState\\(compactionStats\\.slice\\(compactionStatsStart\\)\\) \\}$", note: "写入位置锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 ? { compactionStats: cloneState(compactionStats.slice(compactionStatsS" },
  { key: "round", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "const crashRound = Number\\.isSafeInteger\\(snapshot\\.round\\)", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const crashRound = Number.isSafeInteger(snapshot.round)" },
  { key: "round", axis: "read", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "const crashRound = runLoopState\\.resumeRunSnapshot\\?\\.round;$", note: "停写/读取证据锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 const crashRound = runLoopState.resumeRunSnapshot?.round;" },
  { key: "pendingToolUses", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "const crashToolUses = ctx\\.resumeRunSnapshot\\?\\.pendingToolUses$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const crashToolUses = ctx.resumeRunSnapshot?.pendingToolUses" },
  { key: "pendingToolUses", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "const pendingTools = snapshot\\.pendingToolUses$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const pendingTools = snapshot.pendingToolUses" },
  { key: "pendingToolUse", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "\\?\\? \\(ctx\\.resumeRunSnapshot\\?\\.pendingToolUse \\? \\[ctx\\.resumeRunSnapshot\\.pendingToolUse\\] : \\[\\]\\);$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 ?? (ctx.resumeRunSnapshot?.pendingToolUse ? [ctx.resumeRunSnapshot.pen" },
  { key: "pendingToolUse", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "^ +\\?\\? \\(snapshot\\.pendingToolUse$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 ?? (snapshot.pendingToolUse" },
  { key: "executedToolIds", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "for \\(const id of snapshot\\.executedToolIds \\?\\? \\[\\]\\) \\{$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 for (const id of snapshot.executedToolIds ?? []) {" },
  { key: "toolResults", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "\\|\\| \\(ctx\\.resumeRunSnapshot\\?\\.toolResults \\?\\? \\[\\]\\)\\.some\\(\\(entry\\) => \\($", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 || (ctx.resumeRunSnapshot?.toolResults ?? []).some((entry) => (" },
  { key: "toolResults", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "for \\(const entry of snapshot\\.toolResults \\?\\? \\[\\]\\) \\{$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 for (const entry of snapshot.toolResults ?? []) {" },
  { key: "toolOutputs", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "for \\(const output of snapshot\\.toolOutputs \\?\\? \\[\\]\\) \\{$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 for (const output of snapshot.toolOutputs ?? []) {" },
  { key: "toolOutputs", axis: "read", kind: "code", codePath: "bin/final-guard-support.js", anchor: "\\(Array\\.isArray\\(record\\?\\.toolOutputs\\) \\? record\\.toolOutputs : \\[\\]\\)$", note: "停写/读取证据锚点：在 bin/final-guard-support.js 里唯一命中的那一行是 (Array.isArray(record?.toolOutputs) ? record.toolOutputs : [])" },
  { key: "messages", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "const snapshotBody = Array\\.isArray\\(snapshot\\.messages\\)", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const snapshotBody = Array.isArray(snapshot.messages)" },
  { key: "persistedTranscriptLength", axis: "read", kind: "comment", codePath: "src/loop/resume-manager.js", anchor: "不能信快照里的 `persistedTranscriptLength`", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 // issue #425：**恢复锚点必须在恢复时现算**，不能信快照里的 `persistedTranscriptLength`——" },
  { key: "persistedTranscriptLength", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "^ +ctx\\.persistedTranscriptLength = ctx\\.messages\\.length;$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 ctx.persistedTranscriptLength = ctx.messages.length;" },
  { key: "persistedTranscriptLength", axis: "read", kind: "code", codePath: "src/loop/orchestrator.js", anchor: "^ +runLoopState\\.persistedTranscriptLength \\?\\? 0,$", row: 1, note: "停写/读取证据锚点：在 src/loop/orchestrator.js 里唯一命中的那一行是 runLoopState.persistedTranscriptLength ?? 0,（同名第 2 次出现）" },
  { key: "partialText", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "\\|\\| \\(typeof ctx\\.resumeRunSnapshot\\?\\.partialText === \"string\"$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 || (typeof ctx.resumeRunSnapshot?.partialText === \"string\"" },
  { key: "partialText", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "^ +const partialText = ledgerPartial !== undefined \\? ledgerPartial\\.text : snapshot\\.partialText;", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const partialText = ledgerPartial !== undefined ? ledgerPartial.text : snapshot.partialText;（账本优先、快照兜底）" },
  { key: "partialRound", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "^ +const partialRound = ledgerPartial !== undefined \\? ledgerPartial\\.round : snapshot\\.partialRound;", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const partialRound = ledgerPartial !== undefined ? ledgerPartial.round : snapshot.partialRound;（轮号跟正文走，不许拼盘）" },
  { key: "executedToolIds", axis: "read", kind: "comment", codePath: "src/store/recovery-rows.js", anchor: "快照侧对应的三格（", note: "账本来源锚点（issue #769）：钉的是 src/store/recovery-rows.js 里点名「快照侧 executedToolIds 这一格在恢复路径上退成兜底」的那行注释——账本恢复行（kind: recovery）才是这一格的首选来源，行形状与事件键就定义在这注释下面的模块里" },
  { key: "partialText", axis: "read", kind: "comment", codePath: "src/store/recovery-rows.js", anchor: "快照侧对应的三格（", note: "账本来源锚点（issue #769）：钉的是 src/store/recovery-rows.js 里点名「快照侧 partialText 这一格在恢复路径上退成兜底」的那行注释——账本恢复行（kind: recovery）才是这一格的首选来源，行形状与事件键就定义在这注释下面的模块里" },
  { key: "partialRound", axis: "read", kind: "comment", codePath: "src/store/recovery-rows.js", anchor: "快照侧对应的三格（", note: "账本来源锚点（issue #769）：钉的是 src/store/recovery-rows.js 里点名「快照侧 partialRound 这一格在恢复路径上退成兜底」的那行注释——账本恢复行（kind: recovery）才是这一格的首选来源，行形状与事件键就定义在这注释下面的模块里" },
  { key: "toolUse", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "const unfinishedToolUses = crashToolUses\\.filter\\(\\(toolUse\\) => \\($", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 const unfinishedToolUses = crashToolUses.filter((toolUse) => (" },
  { key: "ts", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "^ +record\\.ts,$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 record.ts," },
  { key: "compactionStats", axis: "read", kind: "code", codePath: "src/loop/resume-manager.js", anchor: "^ +ctx\\.compactionStats = deterministic\\.compactionStats;$", note: "停写/读取证据锚点：在 src/loop/resume-manager.js 里唯一命中的那一行是 ctx.compactionStats = deterministic.compactionStats;" },
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

/** 注释行判据（#772 R4 M-A）：行首只有 `//`、`/*` 或续行的 `*` ⇒ 那一行是注释，不是代码。 */
export const CELL_AXES_COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*)/u;

/** 一行是不是注释行（`anchorKindError()` 的唯一分类口径）。 */
export const anchorLineIsComment = (line) => CELL_AXES_COMMENT_LINE_RE.test(line ?? "");

/** 登记允许的「种类」（闸与测试共用；手写表写错一个字母也算形状不合法）。 */
export const CELL_AXES_ANCHOR_KINDS = ["code", "comment"];

/** 一条登记条目形状上是否带合法 `kind`（`parseCellAxesAnchorTable()` 用它把关）。 */
export const anchorKindIsLegal = (entry) => CELL_AXES_ANCHOR_KINDS.includes(entry?.kind);

const kindSlotLabel = (entry) => `\`${entry.key}\` 的 ${entry.axis} 轴（${entry.codePath}，同名第 ${Number(entry.row ?? 0) + 1} 行）`;

/**
 * 单条锚点的「种类」判据（#772 R4 M-A，**闸与测试共用的那一份函数**）：
 * `kind: "code"` 而唯一命中的那一行是注释行 ⇒ 违规；`kind: "comment"` 而命中的不是注释行 ⇒ 违规。
 * 报错点名「哪一格哪一轴 + 命中行号 + 那一行原文」。
 * @param {object} entry 登记条目（要带 `kind`）
 * @param {string[]} fileLines 锚点指向的文件按行
 * @param {number} hitLine 唯一命中的行号（1 基）
 * @returns {string|null} 错误文本（null = 过）
 */
export function anchorKindError(entry, fileLines, hitLine) {
  const text = fileLines?.[hitLine - 1];
  if (text === undefined) return `锚点种类判据：${kindSlotLabel(entry)} 命中行号 :${hitLine} 越界 ⇒ 无法验种类`;
  const raw = text.trim().slice(0, 120);
  const isComment = anchorLineIsComment(text);
  if (entry.kind === "comment" && !isComment) {
    return `锚点种类不符：${kindSlotLabel(entry)} 登记为 kind=comment（钉的是解释性注释），`
      + `但 ${entry.codePath}:${hitLine} 那一行**不是注释行**（原文：${raw}）`
      + ` ⇒ 这一格本来引的是「解释为什么没有写点/为什么不信它」的那句话，现在指到真代码上去了`;
  }
  if (entry.kind === "code" && isComment) {
    return `锚点种类不符：${kindSlotLabel(entry)} 登记为 kind=code（写入位置 / 读取点必须是真代码行），`
      + `但 ${entry.codePath}:${hitLine} 那一行**是注释行**（原文：${raw}）`
      + ` ⇒ 锚点指到一条只是**提到**键名的注释上（#772 R4 评审 M-A：两份契约表的引文同步改口后，`
      + `行号等值对账自洽、两道闸都照绿；种类是硬判据后这一条红）`;
  }
  return null;
}

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
    // #772 R4 M-A：种类判据与闸走**同一个** `anchorKindError()`（两边不许各写一份）。
    // 这里仍把这一格计入 groups：让调用方从 `errors` 拿到种类那句，而不是被「没有锚点」抢走。
    const kindError = anchorKindError(entry, lines, hits[0]);
    if (kindError !== null) errors.push(kindError);
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

/** 槽位键：覆盖面清单与锚点登记表用同一个形状对齐（与 `anchorGroupKey` 同形）。 */
export const cellAxesRequiredSlotKey = (cell) => anchorGroupKey(cell.key, cell.axis, cell.row ?? 0, cell.codePath);

const requiredSlotLabel = (slotKey) => {
  const [key, axis, rowIndex, codePath] = slotKey.split("|");
  return `\`${key}\` 的 ${axis} 轴（${codePath}，同名第 ${Number(rowIndex) + 1} 行）`;
};

/**
 * 覆盖面真值判据（#772 R4 M-B，**闸与测试共用的那一份函数**）：
 * `CELL_AXES_REQUIRED_CELLS` 里每一格都要在 ① 登记表的锚点条目 ② EN 表 ③ CN 表 三处各自在场，
 * 数量也要够（同槽位登记 N 条 ⇒ 两表都得引 N 条）。缺任一处 ⇒ 红，并点名「缺哪一格、缺在哪一份」。
 * 它不靠「登记表自己有多少条」：登记表与两份表可以被**成对**削薄而自洽（#772 R4 评审 M-B），
 * 只有拿一份与它们无关的清单去问才看得见。
 * @param {object} input
 * @param {object[]} [input.anchors] 当场解析出的锚点登记条目
 * @param {{side:string, doc:string, refs:Map<string,Set<number>>}[]} [input.refsByDoc]
 *        两份契约表的引用：组键（同 `anchorGroupKey`）→ 表里写的行号集合
 * @param {object[]} [input.required] 覆盖清单（默认 `CELL_AXES_REQUIRED_CELLS`）
 * @returns {{errors:string[], slots:number, required:number}}
 */
export function checkCellAxesCoverage({ anchors = [], refsByDoc = [], required = CELL_AXES_REQUIRED_CELLS } = {}) {
  const errors = [];
  const tally = (list, keyOf) => {
    const out = new Map();
    for (const item of list) {
      const k = keyOf(item);
      out.set(k, (out.get(k) ?? 0) + 1);
    }
    return out;
  };
  const want = tally(required, cellAxesRequiredSlotKey);
  const registered = tally(anchors, cellAxesRequiredSlotKey);
  for (const [slotKey, need] of want) {
    const gotRegister = registered.get(slotKey) ?? 0;
    if (gotRegister < need) {
      errors.push(`覆盖面真值：${requiredSlotLabel(slotKey)} 在 \`${CELL_AXES_ANCHOR_MODULE}\` 里只有 `
        + `${gotRegister} 条登记锚点，人审清单 \`CELL_AXES_REQUIRED_CELLS\` 要求 ${need} 条`
        + ` ⇒ 登记条目被删了（这一格这一轴不再被钳）（#772 R4 M-B）`);
    }
    for (const { side, doc, refs } of refsByDoc) {
      const gotCited = refs?.get(slotKey)?.size ?? 0;
      if (gotCited < need) {
        errors.push(`覆盖面真值：${requiredSlotLabel(slotKey)} 在 ${side} 表（${doc}）里只引了 ${gotCited} 处，`
          + `人审清单要求 ${need} 处 ⇒ 缺的那一格在**这一份**里没了（EN 与 CN 两份都必须覆盖；`
          + `成对删掉登记与引文时只有这条能看见，#772 R4 M-B）`);
      }
    }
  }
  for (const [slotKey, got] of registered) {
    if ((want.get(slotKey) ?? 0) >= got) continue;
    errors.push(`覆盖面真值：登记里出现人审清单里没有的槽位 ${requiredSlotLabel(slotKey)}（共 ${got} 条）`
      + ` ⇒ 加了格子却没同批改 \`CELL_AXES_REQUIRED_CELLS\`（清单是覆盖面真值，新格必须入册）`);
  }
  return { errors, slots: want.size, required: required.length };
}

/**
 * 从**文本**里抽登记表（`--self-test` 的覆盖层只改文本，跑不到新版本的模块）。
 * @param {string|null|undefined} text 模块文本（null = 文件不在场）
 * @returns {{entries: object[], floorWhy?: string}|{why: string}} 抽不到时 `why` = 拿不到豁免的原因；
 *   低于地板**不是**「抽不到」，而是带 `entries` 一起返回的 `floorWhy`——#772 R4 之后地板等于
 *   `CELL_AXES_REQUIRED_CELLS.length`，于是「删掉一条登记」必然踩地板；如果把它做成前提失败直接返回，
 *   「哪一格哪一轴没登记」那句就被抢走了（与闸里 parity 的处理同一个理由）。地板照旧是红。
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
    return { why: "锚点表里有缺字段的条目：每条必须是 `{ key, axis, kind, codePath, anchor, note }`"
      + `（codePath = 被钉的源码文件，anchor = 能区分这件事的源码字面/正则，不是键名）` };
  }
  // #772 R4 M-A：`kind` 是指定列——没登记种类就不知道这一格钉的是代码还是注释 ⇒ 无从判种类相符。
  const badKind = entries.find((e) => !anchorKindIsLegal(e));
  if (badKind !== undefined) {
    return { why: `锚点表里有 \`kind\` 不合法的条目（拿到 ${JSON.stringify(badKind?.kind ?? null)}）：`
      + `每条必须写 \`kind: "code"\`（真代码行：写入位置 / 读取点）或 \`kind: "comment"\``
      + `（解释性注释：只有「为什么没有写点」那一类），取值只许 ${CELL_AXES_ANCHOR_KINDS.join(" / ")}（#772 R4 M-A）` };
  }
  const shape = anchorTableShape(entries);
  if (shape.entries < CELL_AXES_ANCHOR_FLOORS.entries) {
    return { entries, floorWhy: `锚点登记表只剩 ${shape.entries} 条（下限 ${CELL_AXES_ANCHOR_FLOORS.entries}，由人审清单`
      + ` \`CELL_AXES_REQUIRED_CELLS\` 算出）⇒ 表不再逐格钉，豁免不能给` };
  }
  if (shape.groups < CELL_AXES_ANCHOR_FLOORS.groups) {
    return { entries, floorWhy: `锚点登记表只剩 ${shape.groups} 组（下限 ${CELL_AXES_ANCHOR_FLOORS.groups}，同一份清单算出）`
      + ` ⇒ 逐格钉不成立` };
  }
  return { entries };
}
