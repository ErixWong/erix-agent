// @ts-check
// runToolLoop 的「选项规范化」（issue #177 刀1）：从 src/loop/orchestrator.js 原样外提，
// 公共 API 与行为零变化。职责边界**只有**下面五件事，其余选项校验仍留在 orchestrator 里
// ——它们消费的是参数解构里的默认值（`maxRounds = 8` 之类），搬过来会把默认值复制成两份：
//   1. 选项对象形状检查（`options` 必须是非数组对象）；
//   2. 未知键白名单检查（`RUN_TOOL_LOOP_OPTION_NAMES`）；
//   3. 未知键的「did you mean」建议（编辑距离 + 阈值 `Math.max(2, ⌊len/3⌋)`）；
//   4. 把 `assemblyPortOptions(assemblyPort)` 的结果与显式选项合并成 `effectiveOptions`；
//   5. issue #496（S1）：合并之后的**语义相**校验（`assertSemanticOptionValues`，规则与文案
//      的唯一来源在 `src/assembly-validators.js`，装配口调的是同一个函数）；
//   6. issue #497（S2）：`config` 嵌套命名空间的展开（`expandConfigNamespace`，schema 与
//      别名表都在 `src/loop/config-namespace.js`）——它把 `config.<group>.<leaf>` 写回顶层
//      扁平键、让 config 赢过同名扁平键，并把冲突交给调用方发事件。
//      复审 R4: the two config sources (`policy.config` vs the call-level `config`) keep the
//      "last writer wins" merge, but their per-leaf conflicts go out through the same channel
//      (`collectConfigSourceConflicts` in `src/loop/config-namespace.js`).
//   7. issue #498（S4a）：`capabilities` 容器的展开（`expandCapabilitiesNamespace`，schema 在
//      `src/loop/capabilities-namespace.js`）——`capabilities.hooks.<name>` 写回顶层同名回调键，
//      与扁平键冲突时同样记一条（path 形如 `hooks.onEvent`，走**同一条**事件）。两个容器
//      **同等待遇**：同一道预检相位、同一套「容器赢扁平」优先级、同一条冲突出口。
//   8. issue #498 (S4c): the nine capability leaves that have **no top-level flat alias** (`ports.*`
//      and six `hooks.*`) are not written back as flat keys; they come back on the `capabilitySlots`
//      side channel — they are the **destination** of in-shell behaviour carriers, not a move (which
//      is why the top-level allowlist does not grow). The conflict comparison still runs, and its
//      `path` is the real destination (`ports.sleepImpl` / `hooks.onBeforeFold` /
//      `folding.context.protectedMessage`).
//   9. issue #498 (S3, first vertical slice = the `timing` group): `timeoutMs` / `deadlineMs` /
//      `retry` leave the top-level allowlist. They are **not** gone — they move to
//      `config.timing.*`, and the expansion phase writes them back to `effectiveOptions.<flat name>`,
//      which is exactly why the engine's read side (`effectiveOptions.timeoutMs` …) needs no change.
//      Writing the old flat spelling is now rejected at the name gate, and the message names the new
//      home (`configPathForOption`, `src/loop/config-namespace.js`) so a host upgrading from 0.26
//      is told where to put the value instead of just "unknown option".
//  10. issue #498 (S3, `tuning` group, segment A5): `maxTokens` / `temperature` / `topP` leave the
//      top-level allowlist as well. They are not gone — they move to `config.tuning.*`, and the
//      expansion phase writes them back onto `effectiveOptions.maxTokens` / `.temperature` / `.topP`,
//      which is exactly why the engine's read side (request assembly) needs no change. The other
//      planes that spell the same word (the config-file / model-slot field `slots.default.maxTokens`,
//      the provider request field, and the assembly `policy.maxTokens`) never went through this
//      allowlist and are untouched.
//  11. issue #498 (S3, `metadata` group, segment A8): `modelMetadata` / `requestId` / `toolContext` /
//      `expert` leave the top-level allowlist. They are **not** gone — they move to
//      `config.metadata.*`, and the expansion phase writes them back onto
//      `effectiveOptions.modelMetadata` / `.requestId` / `.toolContext` / `.expert`, which is exactly
//      why the engine's read side (`budget.js` `modelMetadataFor` / `toolContextFor`, and the
//      orchestrator destructuring that feeds them) needs no change. Writing the old flat spelling is
//      now rejected at the name gate, and the message names the new home. The other three members of
//      the `metadata` group (`user` / `task` / `session`) were **not** part of that slice; the next
//      entry retires three of them.
//  12. issue #498 (S3, `metadata` group, segment A9): `user` / `model` / `task` leave the top-level
//      allowlist as well, same mechanism (`config.metadata.*` → expansion writes back onto
//      `effectiveOptions.user` / `.model` / `.task`, read side untouched). Sized before it was
//      written: removing one key at a time reddened 6 / 5 / 13 cells (sum 24; all three together 15
//      ⇒ 9 overlap), far below the ~150-cell threshold that would have needed a #521-style fixture
//      translation point — so no write point was translated behind the host's back. `session` is
//      **deliberately returned**: the assembly port's `session` member and the top-level `session`
//      option are the *same value* (`assemblyPortOptions(port).session === port.session`), and the
//      repo's ruling says `config.metadata.session` is not a second home for that port — retiring
//      the flat spelling would have promoted the leaf into one.
//
// 顺序即语义，且被 test/loop-option-normalization.test.js 逐条钉住，所以本模块严格按
//   形状检查 → 未知键检查 → config 名称/形状预检 → capabilities 名称/形状预检 →
//   assemblyPortOptions → 显式值合并 → config 展开 → capabilities 展开 → 语义相校验
// 的次序执行；调用方（orchestrator）在此之后才做「解构默认值 → 能力缺失检查 →
// modelConfig.resolve」，能力缺失检查早于 resolve 的那条次序不受本模块影响。
//
// 两个容器的名称/形状预检刻意**早于** `assemblyPortOptions`：那是「读宿主端口之前」的相位
// （与顶层名称检查同相），配置/能力写错不该等到端口被解析完才说。展开本身必须在合并**之后**——
// 冲突与优先级都是「同一个键两种写法」的性质，只有合并后的表示才看得见两边。
//
// issue #496 的「两相」在这里是分开的两步，刻意**不**把全部校验推到合并之后：
// 预检相（形状 + 顶层名称）必须在任何宿主端口被读取之前抛（`test/loop-option-normalization.test.js`
// 的「次序①」用 `Proxy` 钉住「端口未被触碰、`modelConfig.resolve` 未被调用」），
// 语义相（取值 + 回调形状）需要的是**合并后**的表示（装配口给的值也要被同一套规则覆盖）。
//
// 两处「顺手就会改错」的写法，刻意保留原样，勿改：
//   · 合并条件必须是 `value !== undefined`：`false`/`null` 要能覆盖 assembled 值，
//     `undefined` 不能覆盖（改成 `??`/`!= null`/truthy 都会红）。
//   · 建议阈值必须是 `Math.max(2, Math.floor(len / 3))`，且平局用严格 `<` 比较，
//     于是**白名单顺序**就是平局优先级（不是字典序）。
//
// 本模块不发事件、不读 HOME/cwd、不需要任何事件发射回调，因此与 orchestrator 内部的
// 声明顺序依赖（`notifyCapabilitySkipped` 等 TDZ 陷阱）无关。
// 零运行时依赖：只用相对路径。

import { assemblyPortOptions } from "../assembly.js";
import { assertSemanticOptionValues } from "../assembly-validators.js";
import {
  assertCapabilitiesNamespace,
  capabilityDestinationsForShell,
  collectCapabilitiesSourceConflicts,
  expandCapabilitiesNamespace,
} from "./capabilities-namespace.js";
import {
  assertConfigNamespace,
  collectConfigSourceConflicts,
  configPathForOption,
  expandConfigNamespace,
} from "./config-namespace.js";

/**
 * `runToolLoop` 接受的选项名白名单。
 *
 * ⚠ 这份名单的**顺序**同时是未知键建议的平局优先级（`optionSuggestion` 用严格 `<`），
 * 所以它不是集合语义、不许排序、不许增删项而不同时确认建议行为。
 * 计数与顺序都由 `test/loop-option-normalization.test.js` 钉住；**条数不再手抄**——`test/` 里
 * 任何「顶层总数」都由符号派生（`RUN_TOOL_LOOP_OPTION_NAMES.length` 与三个面的并集对账）。
 * #498 S3（`timing` 组垂直切片）：`timeoutMs` / `deadlineMs` / `retry` 已从这里删掉，它们的家是
 * `config.timing.*`（展开相写回 `effectiveOptions`，引擎读侧不变）。
 * #498 S3 (`input` group, segment A): `cacheStablePrefix` and `initialMessages` leave together. Their
 * home is `config.input.cacheStablePrefix` / `config.input.messages` — the latter is the **only**
 * registered leaf alias (`CONFIG_LEAF_ALIASES`), and the expansion phase writes it back onto
 * `effectiveOptions.initialMessages`.
 * #498 S3 (segment A2b): `initialUserMessage` left as well. Its home is
 * `config.input.initialUserMessage`; the leaf stays in `CONFIG_NAMESPACE_SCHEMA.input` (a leaf may
 * exist without a top-level option — that is the S3 shape), and the expansion phase writes it back
 * onto `effectiveOptions.initialUserMessage`, so every engine-side reader is unchanged. Only the
 * *write* spelling moved: the flat key is now rejected at the name gate, and the error names the new
 * home. `test/helpers/run-direct.js` is the single translation point on the test side.
 *
 * @type {string[]}
 */
export const RUN_TOOL_LOOP_OPTION_NAMES = [
  "assemblyPort",
  "provider",
  // #498 S3 (`input` group, segment A6): `system` left the allowlist. Its canonical home is
  // `config.input.system` (`CONFIG_NAMESPACE_SCHEMA.input` in `src/loop/config-namespace.js`), and the
  // expansion phase writes it back onto `effectiveOptions.system` — so the engine's read side (the
  // system-prompt assembly that folds in the wrap-up instruction, `src/loop/orchestrator.js`) is
  // unchanged. Only the *write* spelling moved, and the name gate now rejects the flat one while
  // naming the new home. The other `system` words are deliberately untouched: the provider request
  // field `system` (`src/messages/anthropic.js`), the message-conversion argument
  // (`canonicalToAnthropicRequest({ system })`) and the CLI/README wording are not runToolLoop options.
  // issue #527: `tools` stays here **permanently**. The #498 S3 A6 reachability check proved that a
  // tool declaration may carry function members (`handler` / `validate` / `execute` / a function inside
  // `inputSchema`); the config subtree holds data only, so `config.input.tools` was **flat-reachable,
  // nested-unreachable**. The ruling removed that leaf: `tools` is a **permanent top-level option**
  // (the third station, alongside `provider` / `executeTool` / `store`), and writing
  // `config.input.tools` is now rejected as an unknown leaf whose message points at the top level.
  // The engine's read side is unchanged: it still reads `effectiveOptions.tools`.
  // #498 S3 A18: `wrapup` retired (last flat twin of `input`; see slice a18 segment N).
  "tools",
  // #498 S3 (`run` slice, segment A11): `writeToolNames` / `writeToolPathKeys` / `replayPolicy` /
  // `invalidArguments` left the allowlist here. Their canonical home is `config.run.*`
  // (`CONFIG_NAMESPACE_SCHEMA.run` in `src/loop/config-namespace.js`), and the expansion phase writes
  // them back onto `effectiveOptions.writeToolNames` / `.writeToolPathKeys` / `.replayPolicy` /
  // `.invalidArguments` — so every engine-side reader is unchanged (`normalizeToolNameSet` in
  // `src/loop/budget.js`, the write-path key picker in `src/reflection/judge.js`, the resume replay
  // branch and the invalid-arguments verdict in `src/loop/orchestrator.js`). Only the *write*
  // spelling moved: the flat four are rejected at the name gate, and the message names the new home.
  //
  // The gate-2 reachability check ran all eight legal value shapes through the real `runToolLoop`
  // (two enum literals each for the two policy keys, one non-empty and one empty array for the two
  // name lists): every shape is **flat-accepted and nested-accepted** (exit 0 on both sides), so no
  // key was returned. The one delta it did find is *not* a legal shape: an array that carries a
  // function element is silently filtered flat (`normalizeToolNameSet` drops non-strings) and refused
  // nested (the config subtree holds data only) — the same intended narrowing the A8 slice pinned for
  // `metadata.*`, not a lost capability: the engine never calls those elements.
  //
  // Single-key red-cell measurement (one entry removed, full suite): `invalidArguments` 4,
  // `replayPolicy` 9, `writeToolNames` 6, `writeToolPathKeys` 5 (sum 24); all four removed together
  // is 14 ⇒ overlap 10. Every count is far below the ~150 fixture-level threshold, so this slice
  // needs no #521-style translation point.
  "executeTool",
  // #498 S3 (`run` slice, segment A12): `partialPersistence` left the allowlist. Its canonical home is
  // `config.run.partialPersistence` (`CONFIG_NAMESPACE_SCHEMA.run` in `src/loop/config-namespace.js`),
  // and the expansion phase writes it back onto `effectiveOptions.partialPersistence` — so every
  // engine-side reader (the interval timer branch in `orchestrator.js`, the snapshot sampling in
  // `src/loop/resume-manager.js`) is unchanged. Only the *write* spelling moved: the flat spelling is
  // rejected at the name gate, and the message names the new home.
  //
  // Gate-2 reachability (run before the deletion, real `runToolLoop` entry): the three legal shapes
  // (`false`, `{ intervalMs }`, `{ intervalMs, minBytes }`) are **flat-accepted and nested-accepted**
  // (exit 0 on both sides); the illegal shape `true` is rejected on both sides (exit 1). No divergence
  // ⇒ no return. Measured red cells for this key alone: 16; with the fixture translation point in
  // `test/helpers/run-direct.js` it drops to 4 hand-written sites.
  "maxRounds",
  // #498 S3 (`tuning` slice): `cacheCapable` left the allowlist. Its canonical home is
  // `config.tuning.cacheCapable` (`CONFIG_NAMESPACE_SCHEMA.tuning` in `src/loop/config-namespace.js`).
  // The expansion phase writes it back onto `effectiveOptions.cacheCapable`, so the engine's read side
  // (`orchestrator.js`: "no explicit toolResultTtl + cacheCapable === true ⇒ TTL folding off") is
  // unchanged; only the *write* spelling moved, and the name gate now rejects the flat one while
  // naming the new home.
  // #498 S3 (`timing` slice): `timeoutMs` / `deadlineMs` / `retry` used to sit here. Their canonical
  // home is now `config.timing.*` (`CONFIG_NAMESPACE_SCHEMA.timing` in `src/loop/config-namespace.js`).
  // The expansion phase writes them back to `effectiveOptions.timeoutMs` / `.deadlineMs` / `.retry`,
  // so every engine-side reader keeps working unchanged; only the *write* spelling moved.
  // #498 S3 (`tuning` slice, segment A5): `maxTokens` / `temperature` / `topP` used to sit between the
  // `cacheCapable` note above and this `timing` note. Their canonical home is `config.tuning.*`
  // (`CONFIG_NAMESPACE_SCHEMA.tuning` in `src/loop/config-namespace.js`), and the expansion phase
  // writes them back onto `effectiveOptions.maxTokens` / `.temperature` / `.topP` — so every
  // engine-side reader (request assembly in `src/loop/provider-runner.js` / `src/loop/termination.js`)
  // is unchanged. Only the *write* spelling moved, and the name gate now rejects the flat spellings
  // while naming the new home. The planes that carry the **same word** are deliberately untouched:
  // the model-slot / config-file field `slots.default.maxTokens` (`src/config/slot-provider.js`), the
  // config-file sampling defaults (`src/config/env.js`), the provider request field `maxTokens`
  // (`src/messages/anthropic.js`), and the assembly `policy.maxTokens` (`src/assembly.js`) — none of
  // them goes through this allowlist.
  "reflection",
  // #498 S3 A13: three data shells left this list.
  // `stallDetection` / `outputHygiene` / `persistence` now
  // live at `config.run.<key>`; expansion writes each one
  // back onto `effectiveOptions.<key>`, so every engine
  // reader is unchanged and the name gate names the home.
  // Gate-2 parity + red-cell counts: the A13 slice test.
  "completion",
  "finalGuard",
  // #498 S3 (`guard` slice): `finalGuardMaxRetries` / `finalGuardTimeoutMs` left the allowlist here.
  // Their canonical home is `config.guard.*` (`CONFIG_NAMESPACE_SCHEMA.guard` in
  // `src/loop/config-namespace.js`). The expansion phase writes them back onto
  // `effectiveOptions.finalGuardMaxRetries` / `.finalGuardTimeoutMs`, so the engine's read side is
  // unchanged; only the *write* spelling moved, and the name gate now rejects the flat ones while
  // naming the new home. `finalGuard` itself is **not** part of this slice: it is a hook whose value
  // must be a function, so it lives in `capabilities.hooks.finalGuard` and retires in S9.
  // #498 S3 A14: `maxTokenContinuations` left this list too.
  // Its canonical home is `config.run.maxTokenContinuations`;
  // expansion writes the value back onto
  // `effectiveOptions.maxTokenContinuations`, so the same-round
  // continuation budget reader in `src/loop/orchestrator.js` is
  // untouched. Red cells: 18 before the fixture, 8 after it, 0 once
  // migrated; gate-2 exit codes and the verbatim rejection text live in
  // `test/loop-run-slice-498s3a14.test.js`.
  "todoStateProvider",
  "semanticStateProvider",
  "modelConfig",
  // #498 S3 (`metadata` slice, segment A8): `modelMetadata` / `expert` / `requestId` / `toolContext`
  // used to sit here. Their canonical home is `config.metadata.*`
  // (`CONFIG_NAMESPACE_SCHEMA.metadata` in `src/loop/config-namespace.js`), and the expansion phase
  // writes them back onto `effectiveOptions.modelMetadata` / `.expert` / `.requestId` /
  // `.toolContext` — so every engine-side reader (`modelMetadataFor` / `toolContextFor` in
  // `src/loop/budget.js`, and the orchestrator destructuring that hands them over) is unchanged.
  // Only the *write* spelling moved: the flat ones are now rejected at the name gate, and the message
  // names the new home.
  // #498 S3 (`metadata` slice, segment A9): `user` leaves this list too — the measured red-cell count
  // was 6, far below the fixture-level threshold, so no #521-style translation point was needed.
  // `model` leaves it in the same segment (5 red cells): its canonical home is `config.metadata.model`,
  // and `budget.js`'s `modelMetadataFor` still reads it from the expanded option — read side untouched.
  // `task` is the last one of the three (13 red cells): home `config.metadata.task`; the judge brief
  // reads it from the expanded option (`task-brief.js` only string-checks it), unchanged.
  // `session` is deliberately **not** part of A9: the assembly port's `session` member and the
  // top-level `session` option are the *same value* (`assemblyPortOptions(port).session ===
  // port.session`), and the repo's ruling says `config.metadata.session` is not a second home for
  // the session port — so retiring the flat spelling would promote that leaf into one. Returned.
  "session",
  "store",
  "runId",
  // #498 S3 A19: `resume` left this list; home
  // `config.run.resume`. Expansion writes it back onto
  // `effectiveOptions.resume`, so the read side (the two
  // truthiness tests in `resume-manager.js`) is unchanged.
  // Gate 2: data shapes are nested-accepted and flat-rejected;
  // a function is rejected on **both** spellings — the engine
  // never calls it, only tests it (the `stream` / `metadata`
  // precedent: a narrowing, not a lost capability).
  "onRound",
  "onJudge",
  "onToolResult",
  "onPersistenceError",
  "diagnostics",
  "onObserverError",
  "signal",
  // #498 S3 A16: `stream` left this list; home `config.run.stream`.
  // A15 returned it (a function value was flat-reachable but rejected at
  // the canonical home) and the ruling retired it anyway: the config plane
  // holds data, and the engine only ever *tests* `stream` for truthiness
  // (`partialPersistence !== false && !stream`) — it never calls it, so a
  // function was never behaviour at this position. That accepts the
  // narrowing (a function value is now rejected on both spellings) instead
  // of adding a boolean validator first; the mixed read in
  // `src/loop/provider-runner.js` is issue #538, untouched here.
  "onDelta",
  "onReasoningDelta",
  "onToolCall",
  "onUsage",
  "onEvent",
  // #498 S3 A15: `cwd` left this list; home `config.run.cwd`.
  // Expansion writes it back onto `effectiveOptions.cwd`, so the type
  // check (issue #386: a non-string is `cwd must be a string` on both
  // sides) and the `finalGuard` payload path are unchanged. Cells: 29
  // single-delete, 0 after the fixture moved the spelling — see
  // `test/loop-run-slice-498s3a15.test.js`.
  // issue #386 切片 2：`deliverables` 是宿主声明的交付物判据（引擎在每次 guard 调用前核一遍，
  // 核不过就不许盖 `verified` 章）。同样追加在末尾，理由同上（旧未知键的建议结果一字不改）。
  "deliverables",
  // issue #386 切片 3：`finalGuardExtend` 是**预算类停机**上的补跑开关（默认 `false` = 今天的行为）。
  // 它**会改停机时的行为**（不是纯加法），所以默认关、只在宿主显式 opt-in 时生效。
  // #498 S3 (`guard` slice): it left the allowlist — its canonical home is `config.guard.finalGuardExtend`,
  // and the expansion phase writes it back onto `effectiveOptions.finalGuardExtend`.
  // issue #409 需求②：`invalidArguments` 决定「工具引数解析失败时要不要执行该工具」。
  // 默认 `"reject"`（不执行 + 把解析器原判词作为 `is_error` 的 `tool_result` 回给模型），
  // `"execute"` 是显式回退（行为逐字等于 #409 之前）。
  // #498 S3 (`run` slice A11): the flat spelling left the allowlist — its home is
  // `config.run.invalidArguments` (see the note where it used to sit, above `executeTool`).
  // issue #470-D：`onFoldSummary` 是折叠替代物（`record.foldedFacts`）的**强制投递出口**。
  // 纯加法（默认未传 = 今天的行为）。同样追加在末尾：旧未知键的「did you mean」建议逐字不变。
  "onFoldSummary",
  // issue #497（S2）：`config` 是嵌套命名空间（别名 = schema 路径，见 `src/loop/config-namespace.js`）。
  // 它**不进** `effectiveOptions`——展开后就地消失，下游看到的仍是扁平表示。同样追加在末尾：
  // 旧未知键的「did you mean」建议逐字不变（新名字只会影响离 `config` 更近的未知键）。
  "config",
  // issue #498（S4a）：`capabilities` 是**第二个容器**（`capabilities.hooks` = 12 个宿主回调、
  // `capabilities.checks` = 交付物判据的规范之家，见 `src/loop/capabilities-namespace.js`）。
  // 它同样追加在末尾，理由同上。
  // 为什么必须进这份名单：本品「被接受的选项」只有一个来源（#496 / #502 立的规矩），另开一条
  // 容器豁免路径就等于把「接受面 ≠ 白名单」那张第二张表请回来。代价是条数 66 → 67，
  // `test/loop-option-normalization.test.js` 的三处字面值与 A0 对账一并跟进。
  "capabilities",
];

/** 白名单的查询视图（与 `RUN_TOOL_LOOP_OPTION_NAMES` 同源，勿另行维护）。 */
export const RUN_TOOL_LOOP_OPTION_SET = new Set(RUN_TOOL_LOOP_OPTION_NAMES);

/**
 * 编辑距离（Levenshtein），滚动数组实现。
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      ));
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index];
  }
  return previous[right.length];
}

/**
 * 为未知选项键挑一个「did you mean」建议。
 *
 * 阈值 `Math.max(2, Math.floor(unknownName.length / 3))`；等距平局由
 * `RUN_TOOL_LOOP_OPTION_NAMES` 的顺序决定（严格 `<` ⇒ 名单在前者赢）。
 *
 * @param {string} unknownName
 * @returns {string|undefined} 距离超过阈值（含「名单为空」）时返回 undefined
 */
export function optionSuggestion(unknownName) {
  let best;
  for (const optionName of RUN_TOOL_LOOP_OPTION_NAMES) {
    const distance = levenshteinDistance(unknownName, optionName);
    if (best === undefined || distance < best.distance) {
      best = { name: optionName, distance };
    }
  }
  const threshold = Math.max(2, Math.floor(unknownName.length / 3));
  return best?.distance <= threshold ? best.name : undefined;
}

/**
 * 选项对象形状 + 未知键检查：必须在任何宿主端口被读取之前抛出。
 *
 * 抛错文案（`unknown runToolLoop option: "x" (did you mean "y"?)`）是宿主可见的，逐字保留。
 *
 * #498 S3 在它上面加了一条**升级救命索**：一个键被移出白名单之后，只说「未知 + 接受名单」
 * 等于让宿主自己猜它搬去了哪。所以当这个名字在配置树里有家时，报错**指向新家**
 * （`config.timing.timeoutMs`）——这是 0.26 → 0.28 升级时唯一能自己找到出路的线索。
 * 没有配置之家的未知键逐字维持旧文案（宿主与既有测试都依赖那句原文）。
 *
 * ⚠ 只指一站是**不够的**（#498 S3 收尾时实测到的缺陷，本片修）：`context` / `retry` 这类**壳**同时
 * 容得下数据成员与函数成员，而 `config` 只装数据（函数叶子 intake 当场拒）。宿主照着
 * 「canonical home is config.folding.context」把 `onBeforeFold` 写进去，会撞**第二次**，且只有第二次
 * 的文案才告诉他 `capabilities.hooks.onBeforeFold`。所以「壳有行为成员」时，一次就要把两站都点名
 * （数据 ⇒ `config.<home>.<leaf>`，函数 ⇒ `capabilities.<group>.<leaf>`）。
 * 两站由 `capabilityDestinationsForShell` 从 `CAPABILITY_SLOT_DESTINATIONS` 派生——不写死 `context`，
 * 于是将来任何一个混装壳都自动带上这条。
 *
 * @param {Record<string, any>|null|undefined} options
 * @returns {void}
 */
export function assertRunToolLoopOptionNames(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("runToolLoop options must be an object");
  }
  for (const optionName of Object.keys(options)) {
    if (!RUN_TOOL_LOOP_OPTION_SET.has(optionName)) {
      const suggestion = optionSuggestion(optionName);
      const configHome = configPathForOption(optionName);
      throw new TypeError(
        `unknown runToolLoop option: ${JSON.stringify(optionName)}`
        + (suggestion ? ` (did you mean ${JSON.stringify(suggestion)}?)` : "")
        + (configHome === undefined
          ? ""
          : ` (its canonical home is config.${configHome}; the flat spelling is rejected)`)
        + (configHome === undefined ? "" : shellBehaviourStationHint(optionName, configHome)),
      );
    }
  }
}

/**
 * The second station of a **mixed shell** (data + behaviour members), or `""` when the shell has none.
 *
 * `context` → `data as config.folding.context.<leaf>, functions as capabilities.hooks.<name>
 * (onBeforeFold / onAfterFold / …) or capabilities.ports.strategy`.
 * `retry` → `… capabilities.ports.sleepImpl`.
 * Derived from `CAPABILITY_SLOT_DESTINATIONS`, so no shell name is hard-coded here.
 *
 * @param {string} optionName
 * @param {string} configHome `configPathForOption(optionName)`
 * @returns {string}
 */
function shellBehaviourStationHint(optionName, configHome) {
  const byGroup = new Map();
  for (const { group, leaf } of capabilityDestinationsForShell(optionName)) {
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(leaf);
  }
  if (byGroup.size === 0) return "";
  const stations = [...byGroup].map(([group, leaves]) => (leaves.length === 1
    ? `capabilities.${group}.${leaves[0]}`
    : `capabilities.${group}.<name> (${leaves.join(" / ")})`));
  return ` — this shell holds both data and functions: write data as config.${configHome}.<leaf>,`
    + ` and behaviour members as ${stations.join(" or ")}`;
}

/**
 * 规范化 `runToolLoop` 的入参：形状/未知键检查 → `assemblyPortOptions` → 显式值合并 → 语义相校验。
 *
 * 合并语义（`value !== undefined` 才覆盖）与调用顺序全部沿用外提前的实现，
 * 见文件头的两处「勿改」说明。
 *
 * issue #496（S1）：合并出 `effectiveOptions` **之后**再跑一次语义相校验。以前校验只绑在
 * **入口路线**上（`context` 子键只有装配口校），于是同一份配置走直连会静默按默认跑。
 * 现在两条路线共用同一个闸口（`collectSemanticOptionProblems`，在 `src/assembly-validators.js`），
 * 只差 `via` 标签：装配口 `"assembly"`、直连 `"direct"`。
 *
 * @param {Record<string, any>} options
 * @returns {Promise<{
 *   assemblyPort: import("../assembly.js").AssemblyPort | undefined,
 *   explicitOptions: Record<string, any>,
 *   effectiveOptions: Record<string, any>,
 *   configConflicts: Array<{path: string, key: string}>,
 *   capabilitySlots: Record<string, Record<string, any>>,
 * }>} `effectiveOptions` 是 assembled 值与显式值的合并结果（`config` / `capabilities` 已展开、已消失），
 *   由调用方继续做解构默认值与后续校验；`configConflicts` 是冲突清单（issue #497 / #498）：既含
 *   「同一个键既写了扁平又写了 `config.<path>`，且值不同」，也含「`policy.config` 与调用级
 *   `config` 里同一个叶子值不同」（复审 R4），又含「`capabilities.hooks.<name>` 与扁平同名键值不同」
 *   （S4a，path 形如 `hooks.onEvent`）；按 path 去重、只带路径与键名——调用方负责发事件，
 *   This module emits no events. `capabilitySlots` holds the values of the nine "nested slot" leaves
 *   from #498 S4c (`ports.*` and
 *   `hooks.{onReflection,onBeforeFold,onAfterFold,stubFor,protectedMessage,recoveryHint}`), grouped
 *   by group; it is `{}` when none were given.
 */
export async function normalizeRunToolLoopOptions(options) {
  assertRunToolLoopOptionNames(options);

  const {
    assemblyPort,
    config: explicitConfig,
    capabilities: explicitCapabilities,
    ...explicitOptions
  } = options;
  // 路线标签取**入口形状**（宿主调的是哪条 API），不是「这个值来自哪一层」：
  // 显式选项与端口 policy 都会汇进同一份 `effectiveOptions`，按来源拆标签只会让宿主
  // 在同一个 run 里看到两种标签。
  const via = assemblyPort === undefined ? "direct" : "assembly";
  // issue #497：`config` 的名称/形状预检在**读任何宿主端口之前**抛（与顶层名称检查同相）。
  // 展开则必须在合并之后（见文件头）：优先级与冲突都是「同一个键两种写法」的性质。
  assertConfigNamespace(explicitConfig, { via });
  // #498 S4a：第二个容器走同一道相位与同一条规则（对称，不是复制一份逻辑）。
  assertCapabilitiesNamespace(explicitCapabilities, { via });
  const assembledOptions = assemblyPort === undefined
    ? {}
    : await assemblyPortOptions(
      assemblyPort,
      explicitOptions.modelConfig === undefined
        ? {}
        : { modelConfig: explicitOptions.modelConfig },
    );
  const mergedOptions = { ...assembledOptions };
  for (const [key, value] of Object.entries(explicitOptions)) {
    if (value !== undefined) mergedOptions[key] = value;
  }
  // The assembly port's `policy.config` and the call-level `config` are the same tree: the
  // explicit value overrides the policy one wholesale (the pre-existing merge rule), no new rule.
  // R4: the value semantics stay; the override is reported leaf by leaf (same event, same fields).
  const policyConfig = assembledOptions.config;
  const configSourceConflicts = [];
  if (explicitConfig !== undefined) {
    configSourceConflicts.push(...collectConfigSourceConflicts(policyConfig, explicitConfig));
    mergedOptions.config = explicitConfig;
  }
  // 同一个合并规则也适用于第二个容器：调用级 `capabilities` 整棵覆盖 `policy.capabilities`。
  // 覆盖同样**不许静默**（与 R4 的 config 那一侧逐条同构）：逐叶冲突走同一条事件。
  if (explicitCapabilities !== undefined) {
    configSourceConflicts.push(
      ...collectCapabilitiesSourceConflicts(assembledOptions.capabilities, explicitCapabilities),
    );
    mergedOptions.capabilities = explicitCapabilities;
  }
  const configExpansion = expandConfigNamespace(mergedOptions, { via });
  // #498 S4a：容器展开按 config → capabilities 的顺序跑（两个容器的叶子集不相交，顺序只为确定性）。
  // #498 S4c: `slots` holds the nine leaves that have **no top-level flat alias** (`ports.*` and six
  // `hooks.*`). They do not enter `effectiveOptions` (that would mean inventing flat keys for them);
  // they go to the orchestrator on a side channel, which resolves them against the shell's old slot
  // with a `??` chain — so "this slice only adds destinations, it invents no flat alias" is machine
  // checkable.
  const {
    options: effectiveOptions,
    conflicts: capabilityConflicts,
    slots: capabilitySlots,
  } = expandCapabilitiesNamespace(
    configExpansion.options,
    { via },
  );
  const expansionConflicts = [...configExpansion.conflicts, ...capabilityConflicts];
  // One leaf can be hit by both rules (flat vs config, policy vs call): the payload is only
  // `{ path, key }`, so duplicates carry no information — dedupe by path, keep first-seen order.
  const configConflicts = [];
  for (const conflict of [...configSourceConflicts, ...expansionConflicts]) {
    if (configConflicts.some((seen) => seen.path === conflict.path)) continue;
    configConflicts.push(conflict);
  }
  // ⚠ 这一行必须校**合并后**的表示。今天改校 `explicitOptions` 是可观察等价的，前提有两条：
  //   ① `assemblyPortOptions` 第一行无条件重跑 `createAssemblyPort`，policy 的坏值到不了这里；
  //   ② `assembledOptions` 的派生键（provider / tools / session / modelConfig / onEvent …）都不在语义相规则集内。
  // 任一前提变了（新增一条未经闸口的选项来源、或给派生键加进规则集里的字段），这条性质会**静默失效**——测试不红。
  assertSemanticOptionValues(effectiveOptions, { via });

  return { assemblyPort, explicitOptions, effectiveOptions, configConflicts, capabilitySlots };
}
