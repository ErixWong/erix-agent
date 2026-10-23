#!/usr/bin/env node
// type-check-ratchet.mjs — `--checkJs` 错误数**棘轮**门禁（issue #214；零运行时依赖，仅 node: 内置 + 相对路径）
//
// 干什么：
//   跑 `tsc --noEmit --allowJs --checkJs …src/index.js`，统计**错误总数**与**涉及文件数**，与下面写死的
//   基线常量比较，然后：
//     · 超过基线 → **exit 1**（新增的 `--checkJs` 错误被拦下，这就是本门禁唯一的存在理由）
//     · 等于基线 → exit 0
//     · 低于基线 → **仍 exit 0**，并打印「基线可下调至 N」提示（改基线是一次独立的人工动作，见下）
//   本单**不追求清零**（issue #214 的非目标），只把 200+ 个存量错误从「没人知道的债」变成「只减不增的棘轮」。
//
// 与 #213 的两个门禁的分工（别混）：
//   · `types:build` / `check:types-build` = 「**还能不能产出随包 `.d.ts`**」（tsc exit 0 + 公共符号在不在），
//     它跑的是 `--declaration --emitDeclarationOnly`、**不带 `--checkJs`**，对类型质量零评判。
//   · `check:types`（本脚本）= 「**存量 `--checkJs` 错误有没有变多**」。它不产出任何东西，也不要求 0 错。
//
// 为什么基线是脚本里的常量而不是 tsconfig：本仓**没有 tsconfig.json**（CLI 显式给出输入文件时 tsc 根本
//   不读 tsconfig，见 `scripts/build-types.mjs` 里同款实测注释），而且基线必须随代码走、每次改动都可 review。
//   为什么**只卡总数**不卡「涉及文件数」：文件数会随「顺手清了某个文件的错」而**下降**，那是好事；把文件数
//   也设成门禁会挡住我们想要的方向，所以它只作为**报告信息**打印。
//
// 读输出前必读的三条口径，否则会把「没检查」当成「干净」：
//   1. 只编 `src/index.js` **并不能**限制范围——tsc 会顺着 import 把整张依赖图拉进来（issue #214 正文与本地
//      实测都是这件事）。所以准入规则里的 `// @ts-check` 只是**声明这份文件愿意被检查**，真正的范围是 import 图。
//   2. ⚠ **反过来，`src/index.js` 也不是全部**：`erix-agent/tools` 那条公共入口有**两个文件不在包根的 import
//      图里**（`src/tools/file-tools.js`、`src/skills/loader.js`），它们的新错默认**卡不住**。见下面的
//      `--with-tools` 与 `BASELINE_WITH_TOOLS`（实测两入口并集 = **152 个 / 30 文件**（2026-10-23 复测；再上一轮是 153、156、2026-10-21 那轮是 160、2026-10-15 是 162、2026-10-13 是 164），比单入口多 36 个：20 + 16）。
//   3. ⚠ **`src/**/*.d.ts` 生成物在场时，本检查会静默变成空跑**（实测，见下面的「陈旧声明守卫」）：#213 的
//      `types:build` 把声明**生成到 `src/` 里**，而 tsc 解析 `./x.js` 时**优先命中同目录的 `x.d.ts`**，于是
//      被检查的是声明而不是实现——当前树上（2026-10-23 复测：`npm run types:build` 产出 **75** 个 `.d.ts`）75 个 `.d.ts` 在场时同一条命令报 **0 个错**（`--skipLibCheck` 跳过声明文件；2026-10-21 那轮量到的 70 个、2026-10-15 的 65 个、2026-10-13 在 `39e96f1` 上量到的 63 个都是**历史值**），
//      去掉 `--skipLibCheck` 则报 **13 个错且全部落在 `.d.ts` 上**。两个都不是我们要量的数，而
//      「0 < 基线」在这里是**假绿**，所以守卫直接变红而不是放行。
//   · 另：未装 `@types/node` 时错误数会**变多**（`TS2580`/`TS2307` 一类「缺 node 类型」），不是变干净；本门禁
//     **必须在装了 devDependencies 的环境里跑**（`tsc` 取不到时下面直接给指路报错，不堆栈）。
//
// 用法：
//   npm run check:types                       # 默认：包根入口 src/index.js，基线 116
//   npm run check:types -- --with-tools       # 连 erix-agent/tools 入口一起卡，基线 152
//   node scripts/type-check-ratchet.mjs --verbose                   # 额外打印每文件、每错误码分布
//   node scripts/type-check-ratchet.mjs --show-errors 20            # 额外打印前 20 条错误定位（定位新错用）
//   node scripts/type-check-ratchet.mjs --baseline                  # 只打印基线常量与复现命令
//   node scripts/type-check-ratchet.mjs --print-count               # 只打印实测错误总数（脚本化下调基线用）
//   node scripts/type-check-ratchet.mjs --ignore-stale-declarations # 明知 src/ 下有 .d.ts 生成物仍强行跑
//   node scripts/type-check-ratchet.mjs --strict-report             # strict 观测点（issue #416）：同一张依赖图加 `--strict`，只打印分布
//
// ── strict 观测点（issue #416）：把「最宽松口径」那笔债变成每次都能看见 ──────────────
// 病根：上面那对基线（116 / 152）是**不带 `--strict`** 量出来的。同一棵树、同一条命令只加一个
//   `--strict`，总数就从三位数跳到四位数（构成：TS7006 隐式 any 参数最多、其次 TS2339、TS7005、TS7031、
//   TS7034、TS7053 ……）—— 这个数**从来没出现在任何门禁或 CI 日志里**。
//   后果可复证：`types:build` 生成的 75 个 `.d.ts` 在场时，同一条 `--strict` 命令报 **0 个错**（声明里的
//   `any` 把一切吞了，宿主侧 `tsc --strict` 因此能过）。
// ⚠ **strict 这个数不是门禁、不钉、会漂——命令输出是唯一真值。** 它随代码改动而变，也随**树**而变：
//   2026-10-23 在 #416 分支（`feat-261023-08-strict-report`）上实测 **1690 个错 / 65 个文件**，同一天
//   集成树上同一命令实测 **1687 个 / 65 个文件**（主 agent 实测；两者都是真值，差的是树不是命令）。所以：
//   · 任何文档 / 注释 / 测试里的字面量都只是「**某棵树某一天**」的快照，带日期与树名才有意义；
//   · 不同步这字面量（改了也没门禁验它，同步本身只会制造新的谎言）——要现值就跑命令；
//   · 不要在 CI 或测试里断言某个具体数字（那条断言一定会腐烂；本观测点存在的意义是「看得见」，不是「钉住」）。
// 本开关**只观测、不判定**：
//   · 用 `TSC_ARGS` + `--strict`（**同一张依赖图**：入口、module、target 一字不改）跑一次，打印
//     **总数 + 按文件 + 按错误码**的分布，外加口径说明（入口 / tsc 与 @types 版本 / 逐字复现命令）；
//   · **观测到的数不影响退出码**：无论 strict 报多少还是 0，只要这次测量本身成立就 exit 0。
//     ⚠ 但「只观测」不等于「exit 恒 0」：仍有**三条硬失败路径**——tsc 起不来、tsc 非 0 退出却一条错都
//     没解析出来、`src/**/*.d.ts` 残留（下面那条守卫）。实测：`npm run types:build` 之后直接跑本开关 ⇒
//     **exit 1**。所以 CI 那一步是 `continue-on-error: true`（红得对，但不阻塞流水线）。
//   · 棘轮那一侧（`TSC_ARGS` / 两个基线常量 / 判定与退出码）**一字不动**：本开关不新增、也不改动
//     `TSC_ARGS` 里的任何 flag，`--strict` 只出现在观测路径的数组副本里。
//   · 复用**陈旧声明守卫**：`src/**/*.d.ts` 在场时观测到的不是实现（实测就是 0），所以与棘轮同样
//     拒绝运行并报错——「strict 报 0」在那种情形下是假绿，不是好消息。
// 为什么不卡：strict 那笔（上记的实测值）是**待还的债**（issue #417），不是本轮能清零的东西；先把它摆到
//   日志里、让每一次 CI 都看得见，再谈还债。等 #417 把它降下来，是否升级成门禁是那一单的决定，不是这一单的。

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

// ── 基线（棘轮的「只减不增」就钉在这两个数上）────────────────────────────────────
// 来源：issue #214（`--checkJs` 棘轮）。
// 实测日期：2026-10-10。首次实测在基点 `836aaa2`（#213 的 JSDoc 修复已在树上）；rebase 到 `origin/main` = `f6a8392`
// 之后**复测过**（#224/#225 只新增测试、`src/` 零改动）：同一条命令的输出与旧树 `diff` **逐字相同**，仍是 218 / 29。
// 实测环境：`typescript@5.9.3` + `@types/node@22.20.5`（都是 devDependency）、Node 22、Linux。
// 复现命令（逐字，在仓库根目录）：
//   node node_modules/typescript/bin/tsc --noEmit --allowJs --checkJs --target es2023 \
//     --module nodenext --moduleResolution nodenext --skipLibCheck src/index.js
// 实测：**218 个错 / 29 个文件**。分布 181×TS2339、14×TS2353、7×TS2345、5×TS2741、3×TS2322、2×TS2554、
//   2×TS2698、2×TS2739、1×TS2538、1×TS2722。最集中：src/providers/openai.js 46、src/providers/anthropic.js 45、
//   src/store/notes.js 27、src/loop/orchestrator.js 18、src/run-state.js 10。
// 其中**宿主可见公共面**（从 `src/index.d.ts` / `src/tools/index.d.ts` 沿类型引用可达的 40 个文件，
//   与「从两个入口沿 `export … from` 可达」的集合大小一致）里落了 **190 / 218 个**；余下 28 个在 9 个
//   纯实现内部文件里（`run-snapshot-executor` 8、`compact/pipeline` 5、`error-ledger` 3、`providers/timeout` 3、
//   `provider-runner` 2、`tool-result-ttl` 2、`http-shared` 2、`payload` 2、`termination` 1）——宿主点不到名，
//   还债优先级排在 190 那批之后。
// ⚠ **为什么不是抄 issue 正文里的 226**：226 已在本仓复现过——把 #213 之前的树（`bc3ad02`）用
//   `git archive bc3ad02 | tar -x -C <空目录>` 取出来（不动工作树），同一对 tsc/@types 跑同一条命令 =
//   **226 个 / 29 个文件**，与 issue 逐字一致；#213 的 JSDoc 修复把它带到 **218**（`orchestrator` 21→18、
//   3×TS1131 与 TS8024/TS1003 消失、TS2739 1→2）。所以下面的数是**当前树**的实测值，不是抄来的。
// 下调基线的规矩：把常量改成 `npm run check:types` 打印的「可下调至 N」，**单独一次提交**，提交信息里带上
//   是哪个文件减了多少错——棘轮的全部价值在「这个数只会变小」，别把它当噪声随手调回去。
// 下调记录：**218 → 217**（issue #177 刀 1，2026-10-10）——`src/loop/orchestrator.js` **18 → 17**（减 1）：
//   选项规范化外提后给 `resumeRunSnapshot` 补了一行 `@type`（纯注释），消除一处
//   `Property 'round' does not exist on type 'never'`（TS2339）——那个变量的值只经 setter 由
//   `restoreResume` 赋值，控制流分析看不见。新增的 `src/loop/option-normalization.js`（首行 `// @ts-check`）
//   自身贡献 **0** 个错。`--with-tools` 一档的 261 未重测，故不动（那一档因此悄悄多背了 1 个，见下面）。
// 下调记录：**217 → 142**（PR #249 = issue #213 的「两个 provider 工厂补全宿主参数类型」，2026-10-11 实测于 `59f3a72`）
//   ——这 75 个**全部**来自那两个工厂文件：`src/providers/openai.js` **46 → 7**（减 39）、
//   `src/providers/anthropic.js` **45 → 9**（减 36）。改前对照树 `8f83375` 用 `git archive` 取到空目录、同一对
//   tsc/@types 跑同一条命令 = **217 个 / 29 文件**（与常量逐字相同），改后逐文件对比：**其余 27 个文件的计数
//   一字未动**，也没有文件进出错误集合（29 个带错文件一个不多一个不少）。错误码分布随之从
//   TS2339×180/TS2322×3/TS2739×2 变成 TS2339×103/TS2322×4/TS2739×3：减掉的 77 个 TS2339 与新增的 2 个
//   （`openai.js` 一个 TS2739、`anthropic.js` 一个 TS2322）**全部落在这两个文件里**——42 键类型字面量把
//   「参数退化成 `any`」换成真类型之后，两处调用点**第一次真的被检查了**：这是补类型的代价，不是新债。
//   现在最集中的文件：`src/store/notes.js` 27、`src/loop/orchestrator.js` 17、`src/run-state.js` 10、
//   `src/display/projection.js` 9、`src/providers/anthropic.js` 9。**上面那段 218/190/28 的分布是 218 时代的
//   历史记录**；**142 时代（2026-10-11 实测）**的口径是：公共面 114 个 / 20 个文件、实现侧 28 个 / 9 个文件（当前口径见下面那条 2026-10-23 的下调记录）。
// 下调记录（最新一笔）：**117 → 116** 与 **153 → 152**（issue #413，2026-10-23 实测于当前树；**两档同刀各降 1**）。
//   减掉的这 1 个**不在**基线时代的任何一个带错文件的账上——它是 issue #409（PR #410）**两笔**提交的净效果：
//   · `6b604e7` 把 `parseOpenAIToolArguments` 里那句 `JSON.parse(value)`（`value` 是 `unknown`）换成共享入口
//     `parseToolArguments(rawArguments).input` ⇒ `src/messages/openai-normalization.js` 的 `(60,23)` 那条
//     `TS2345 Argument of type 'unknown' is not assignable to parameter of type 'string'` 消失（**1 → 0，该文件
//     退出错误集合，带错文件数 29 → 28**）；但同一笔新增的 `src/messages/tool-arguments.js` 自己带进 1 条
//     `TS2339 Property 'error' does not exist on type …`（`(69,70)`——`--checkJs` 不带 `strict`，布尔字面量判别
//     在那里不收窄），**净额 0**；
//   · `d9a0989`（同属 #409 的收尾刀）把 `src/text/repair-json.js` 里 `parseJsonWithRepair` 的 `@returns` 从判别联合
//     改成「单形状 + 可选字段」，那条 `TS2339` 随之消失 ⇒ 净 **−1**。
//   单提交对账：`git archive d9a0989^` 取到空目录、同一对 tsc/@types 跑同两条命令 = **117 个 / 29 文件** 与
//   **153 个 / 31 文件**（与两档旧常量逐字相同），`d9a0989` 之后 = **116 / 28** 与 **152 / 30**；逐文件对比：
//   **除上面那两个文件外其余 27 个带错文件的计数一字未动**，也没有别的文件进出错误集合。
//   ⚠ 归因纠正（本单实测，别采信旧线索）：这 −1 **不是** PR #370 系——PR #370 是 issue #358 的读侧诚实性，动的是
//   `src/tools/file-tools.js`（见下面 #376 那一笔），而本轮两档的 −1 全属 **issue #409 / PR #410**。
//   `src/tools/file-tools.js` 仍 **20**、`src/skills/loader.js` 仍 **16**，所以 152 = 116 + 20 + 16 仍成立。
//   **当前口径（2026-10-23 重算）**：宿主可达的公共面 **90 个 / 19 个文件**，宿主点不到名的纯实现内部文件
//   **26 个 / 9 个文件**（2026-10-21 那轮是 91 + 26 = 117；本轮少掉的这 1 条在 `src/messages/openai-normalization.js`，
//   而它**在公共面那半边**（`src/index.js` 直接 `export … from` 它）⇒ 可及份额自己从 91 掉到 90、可及文件 20 → 19，
//   不可及那一半的 26 个 / 9 个文件一个没动）。两半仍是**重测**出来的：tsc 输出按文件聚合 + 从两个入口的分类闭包。
//   上一笔：**156 → 153**（issue #376，2026-10-22 实测于当前树；**只动 `--with-tools` 一档**，
//   包根入口同刀重测仍 117、一个错都没变，故 `BASELINE_ROOT` 不动）。减的 **3** 个**全部**来自
//   `src/tools/file-tools.js` **23 → 20**：PR #370（issue #358 读侧诚实性——tree 非根首行可回放、readFile 参数
//   改写留痕、路径文案去 errno）把 `"readParamAdjusted" | "readEof" | "editDiffTruncated"` 并进了那个 cause 联合类型，
//   于是 `editDiffTruncated` 那 3 条（2×TS2345 + 1×TS2678）随之消失，是**重构顺带**掉的、不是专门修的；
//   `src/skills/loader.js` 仍 **16**，其余 29 个带错文件逐项复核一字未动（153 = 117 + 20 + 16，31 个文件不变）。
//   `file-tools.js` 剩下的 20 个按 #179 跟着下一次进该文件的 PR 走，本单不动（#376 非目标）。
//   上一笔：**160 → 156**（issue #362，2026-10-22 实测于当前树；**只动 `--with-tools` 一档**，
//   包根入口仍 117、一个错都没变）。减的 **4** 个**全部**来自 `src/tools/file-tools.js` **27 → 23**：PR #356
//   （issue #215 / #222）为 `toolMarker` 加的 `markerCount` 窄化点顺带消掉了 4 个 `--checkJs` 错，是**重构顺带**掉的、
//   不是专门修的；`src/skills/loader.js` 仍 **16**，其余 29 个带错文件逐项复核一字未动（156 = 117 + 23 + 16，31 个文件不变）。
//   `file-tools.js` 剩下的 23 个按 #179 跟着下一次进该文件的 PR 走，本单不动（#362 非目标）。
//   上一笔：**119 → 117** 与 **162 → 160**（issue #339，2026-10-21 实测于当前树；两档各降 **2**，
//   全部来自 `src/display/projection.js` **9 → 7**：`20b6935`（PR #338 = issue #335 第一步，投影不再读
//   `record.response.content`、改读折叠后的轮内消息）重写了那个 helper 的入参形状，原 `452,11` 与 `454,27`
//   两条 `TS2339 Property 'key' does not exist on type '{ … }'`（给 `entry.key` / `call.key` 赋值时）随形状变化消失——
//   是**重构顺带**掉的，不是专门修的；29 个带错文件、9 个纯实现内部文件、`file-tools.js` 27、`loader.js` 16 全部逐项复核未动）。
//   上一笔：**121 → 119** 与 **164 → 162**（issue #292，2026-10-15 实测于当前树；两档各降 **2**，
//   全部来自 `src/compact/pipeline.js`——给 `createCompactionStat`/`normalize` 补了 JSDoc 类型面）。
//   上一笔下调：**142 → 121** 与 **185 → 164**（issue #270，2026-10-13 实测于 `39e96f1`；同一对 `typescript@5.9.3` + `@types/node@22.20.5`，前置动作 `find src -name '*.d.ts' -delete`）
//   ——两档各降 **21**，全部来自 `7354fab`（= issue #265）对 `src/store/notes.js` 的重构：`src/store/notes.js`
//   **27 → 6**（减 21；逻辑抽进首行 `// @ts-check` 的 `src/store/notes-port.js` 与 `src/store/notes-memory.js`，
//   两个新模块自身各贡献 **0** 个错）。改前对照树 `7354fab^` 用 `git archive` 取到空目录、同一对 tsc/@types
//   跑同两条命令 = **142 个 / 29 文件** 与 **185 个 / 31 文件**（与两档旧常量逐字相同），改后逐文件对账：
//   **除 `src/store/notes.js` 外那 28 个带错文件的计数一字未动**，也没有文件进出错误集合。**两档在同一笔
//   提交里一起下调**（#214 的那条教训：退役的 261 曾悄悄背着 #177 已还掉的那 1 个）。
//   **那一轮的口径（2026-10-21 重算）**：宿主可达的公共面 **91 个 / 20 个文件**，宿主点不到名的纯实现内部文件
//   **26 个 / 9 个文件**（2026-10-15 那轮是 93 + 26 = 119：减掉的 2 个全在 `src/compact/pipeline.js`，而它在不可及那一半 ⇒ 可及份额仍是 93；本轮减掉的 2 个全在 `src/display/projection.js`，**它在公共面那半边** ⇒ 可及份额自己从 93 掉到 91，不可及那一半 26 个一个没动）。两半分布是**重测**而不是减法推出来的：tsc 输出
//   按文件聚合 + 从两个入口的分类闭包（见 `AGENTS.md` 里同一条），而那 21 个全落在公共面那半边（`notes.js` 本来就在闭包里）。
//   现在最集中的文件：`src/loop/orchestrator.js` 17、`src/run-state.js` 10、`src/providers/anthropic.js` 9、
//   `src/loop/run-snapshot-executor.js` 8、`src/display/projection.js` 7、`src/providers/openai.js` 7、`src/tools/notes.js` 7
//   （`--with-tools` 一档再加 `src/tools/file-tools.js` 20、`src/skills/loader.js` 16）。
const BASELINE_ROOT = 116;

// `--with-tools` 的基线：把第二个公共入口 `src/tools/index.js` 也喂给 tsc 后的并集。
// 复现命令（逐字）：
//   node node_modules/typescript/bin/tsc --noEmit --allowJs --checkJs --target es2023 \
//     --module nodenext --moduleResolution nodenext --skipLibCheck src/index.js src/tools/index.js
// 实测（2026-10-11，`59f3a72`）：**185 个错 / 31 个文件** = 单入口的 142 个，加上只有 `./tools` 才拉进来的
//   `src/tools/file-tools.js` 27 个与 `src/skills/loader.js` 16 个（两个都是宿主直接可见的导出实现，
//   `createFileTools` / `discoverSkills` 那一族）**当前值（2026-10-23 复测）= 152 个 / 30 个文件 = 116 + 20 + 16**；
//   2026-10-22 那轮的 153 个 = 117 + 20 + 16、再上一轮的 156 个 = 117 + 23 + 16、2026-10-21 那轮的 160 个 = 117 + 27 + 16、2026-10-15 那轮的 162 个 = 119 + 27 + 16、2026-10-13 在同一棵 `39e96f1` 上复测的 164 个 = 121 + 27 + 16 都是**历史值**（与旧常量的差额逐个落在 `src/store/notes.js`、`src/display/projection.js`、`src/tools/file-tools.js` 与 `src/messages/openai-normalization.js`，同上面那些下调记录；
//   `loader.js` 16 这个计数自 #214 起一字未动，本次也逐个复核过）。#214 时代入库的是 **261**，
//   而它**从来没跟着 #177 刀 1 复测过**：同一对 tsc/@types 在改前树 `8f83375` 实测这一档是 **260**，
//   于是 261 → 185 的 76 个 = #249 的 75 个 + #177 欠下的那 1 个（教训：下调基线要**两档一起复测**）。为什么默认不带它：#214 正文给的口径就是 `src/index.js`，
//   默认值必须与规格逐字一致；但它**是**真实盲区，所以这里留一条可随时收紧的通道（收紧=把默认入口加上并
//   把基线换成当前实测值，属 #214 之后的收紧动作，不要拿它当「反正卡不住」的理由）。
const BASELINE_WITH_TOOLS = 152;

const argv = process.argv.slice(2);
const WITH_TOOLS = argv.includes("--with-tools");
const VERBOSE = argv.includes("--verbose");
const PRINT_ONLY = argv.includes("--print-count");
const IGNORE_STALE = argv.includes("--ignore-stale-declarations");
const STRICT_REPORT = argv.includes("--strict-report");
const SHOW_ERRORS = (() => {
  const i = argv.indexOf("--show-errors");
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : 0;
})();

// 与 issue #214 正文口径逐字一致的 tsc 参数（输入文件是唯一的入口；依赖图由它自己拉）。
const ENTRIES = WITH_TOOLS ? ["src/index.js", "src/tools/index.js"] : ["src/index.js"];
const BASELINE = WITH_TOOLS ? BASELINE_WITH_TOOLS : BASELINE_ROOT;
const TSC_ARGS = [
  "--noEmit",
  "--allowJs",
  "--checkJs",
  "--target",
  "es2023",
  "--module",
  "nodenext",
  "--moduleResolution",
  "nodenext",
  "--skipLibCheck",
  ...ENTRIES,
];
const MODE = WITH_TOOLS ? "含 ./tools 入口" : "包根入口";

// strict 观测路径专用：**追加**在 `TSC_ARGS` 之后的数组副本，绝不写进 `TSC_ARGS` 本身（issue #416 红线）。
// 单独一个常量而不是 `[...TSC_ARGS, "--strict"]` 内联，是为了让「棘轮那侧不带 strict」这件事在文本里可搜。
const STRICT_ONLY_ARGS = ["--strict"];

if (argv.includes("--baseline")) {
  console.log(
    `check:types: 基线 = ${BASELINE} 个 --checkJs 错误（${MODE}；issue #214 棘轮，2026-10-23 实测）\n`
    + `  两档基线：包根入口 ${BASELINE_ROOT}（默认）/ 含 ./tools 入口 ${BASELINE_WITH_TOOLS}（加 --with-tools）\n`
    + `  复现命令：node node_modules/typescript/bin/tsc ${TSC_ARGS.join(" ")}`,
  );
  process.exit(0);
}

function resolveTsc() {
  const candidates = [
    path.join(ROOT, "node_modules", "typescript", "bin", "tsc"),
    path.join(ROOT, "node_modules", "typescript", "tsc.js"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const tscPath = resolveTsc();
if (!tscPath) {
  // 清晰报错而不是堆栈：tsc 是 devDependency，没装（或 npm 跳过了 dev 安装）是这个门禁最常见的红法。
  // 口径与 scripts/build-types.mjs 一致（#213 实测：`NODE_ENV=production` 时 `npm install` 会静默跳过 devDependencies）。
  console.error(
    "check:types: 找不到 TypeScript 编译器（tsc），无法跑 --checkJs 棘轮。\n"
    + "  tsc 是 devDependency（运行时零依赖红线只约束 import，dev 工具链不进包，见 issue #213），\n"
    + "  先在本仓库根目录装依赖再重跑：\n"
    + `    ${npmCommand} install --include=dev\n`
    + "  ⚠ 环境里 `NODE_ENV=production` 时 `npm install` 会**默认跳过 devDependencies**（实测 npm 10.9.8：\n"
    + "    `npm install` 报「up to date, audited 1 package」而 tsc 并不存在），必须显式 `--include=dev`。\n"
    + `  期望路径：${path.join(ROOT, "node_modules", "typescript", "bin", "tsc")}`,
  );
  process.exit(1);
}

// ── 陈旧声明守卫：`src/**/*.d.ts` 在场时 `--checkJs` 量的不是实现 ──────────────────
// 仓库**提交了 0 个** `.d.ts`（`git ls-files '*.d.ts'` 为空），且 `.gitignore` 写了 `src/**/*.d.ts`，
// 所以在场的一定是 #213 生成器（`types:build` / `prepack`）的产物，不是人写的类型 —— 可以直接判定并清掉。
function declarationScan(dir, acc = { n: 0, sample: [] }) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) declarationScan(abs, acc);
    else if (name.endsWith(".d.ts")) {
      acc.n += 1;
      if (acc.sample.length < 3) acc.sample.push(path.relative(ROOT, abs).replaceAll("\\", "/"));
    }
  }
  return acc;
}

const stale = declarationScan(path.join(ROOT, "src"));
if (stale.n > 0) {
  const msg =
    `发现 src/ 下有 ${stale.n} 个 .d.ts 生成物（例：${stale.sample.join("、")}）——它们是 #213 的 `
    + "`types:build`/`prepack` 产物（仓库提交了 0 个 `.d.ts`，所以存在即可判定为生成物）。\n"
    + "  它们会让本门禁**静默量错东西**：tsc 解析 `./x.js` 时优先命中同目录的 `x.d.ts`，于是被检查的是声明而不是实现。\n"
    + "  实测（2026-10-11 在 #249 之后的那棵树上复测，同一棵工作树、同一条命令）：`.d.ts` 不在场 = **142 个错**；那棵树上 61 个 `.d.ts` 在场 = **0 个错**\n"
    + "    （`--skipLibCheck` 直接跳过声明文件）；再把 `--skipLibCheck` 去掉 = **13 个错且全落在 `.d.ts` 上**——三种读法里只有第一种是要卡的数，「0 个错」是**假绿**。\n"
    + "  2026-10-23 在当前树（#409 之后；生成物数量是 **75** 个）上复测同一组对照：不在场 = **116 个错**；**75 个在场 = 0 个错**；"
    + "去掉 `--skipLibCheck` = **13 个错且全落在 `.d.ts` 上**（`run-state.d.ts` 7、`providers/errors.d.ts` 3、`reflection/wrapup.d.ts` 3）。"
    + "（2026-10-21 那轮是 70 个生成物 / 117 个错、2026-10-15 那轮是 65 个生成物 / 119 个错，都属**历史值**）\n"
    + "  清掉再生成（生成物不入库、随时可重建）：`find src -name '*.d.ts' -delete`\n"
    + "    （PowerShell：`Get-ChildItem src -Recurse -Filter *.d.ts | Remove-Item`）\n"
    + "  确需带着生成物跑（例如刚 `npm pack` 完的目录）：加 `--ignore-stale-declarations`，但那样的数字**不能**用来下调基线。\n"
    + "  （strict 观测点 `--strict-report` 同样被这道守卫拦下：2026-10-23 实测 75 个 `.d.ts` 在场时 strict 也报 **0 个错**、tsc exit 0——"
    + "同一个假绿，所以那里也拒绝运行，而不是把 0 当成「strict 已经干净了」。）";
  if (!IGNORE_STALE) {
    console.error(`check:types: 失败 — ${msg}`);
    process.exit(1);
  }
  console.error(`check:types: ⚠ ${msg}\n  （--ignore-stale-declarations 生效：继续跑）`);
}

// ── 两条路共用的 tsc 调用与输出解析（棘轮 + strict 观测）───────────────────────────
// 一行错误的形状固定：`<file>(<line>,<col>): error TS<code>: <message>`。
// 只有这一行**算一个错误**；缩进的续行（`  Type '…' is not assignable to …`）是同一条错误的说明，不能重复计数。
const ERROR_LINE = /^(?<file>[^\r\n]+?)\((?<line>\d+),(?<col>\d+)\): error TS(?<code>\d+): (?<msg>.*)$/;

/**
 * 把 tsc 的原始输出拆成「一行一个错误」的数组。棘轮与 strict 观测走**同一个**解析器：
 * 两条路各写一份正则的话，「按错误码/按文件」的分布迟早两边对不上，而这里正是拿分布当证据的地方。
 *
 * @param {string} output tsc 的 stdout+stderr 合并文本
 * @returns {{errors: {file: string, line: number, col: number, code: string, msg: string}[], unparsed: string[]}}
 */
function parseTscErrors(output) {
  const seen = new Set();
  const errors = [];
  const unparsed = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const m = ERROR_LINE.exec(line);
    if (!m) {
      // tsc 的自由文本（版本横幅、`Found N errors…` 汇总）留作「一条都没解析出来」时的兜底证据
      if (/error TS\d+:/.test(line)) unparsed.push(line.trim());
      continue;
    }
    const rel = m.groups.file.replaceAll("\\", "/").replace(/^\.\//, "");
    const key = `${rel}:${m.groups.line}:${m.groups.col}:${m.groups.code}`;
    if (seen.has(key)) continue; // stdout/stderr 交错时同一条错误可能重复出现
    seen.add(key);
    errors.push({ file: rel, line: Number(m.groups.line), col: Number(m.groups.col), code: m.groups.code, msg: m.groups.msg });
  }
  return { errors, unparsed };
}

/**
 * 跑一次 tsc：`TSC_ARGS`（棘轮口径，逐字不动）+ 调用方追加的参数。
 * strict 观测只通过 `extraArgs` 追加 `--strict`，**从不**改写 `TSC_ARGS` 本身（issue #416 红线）。
 *
 * @param {string[]} extraArgs 追加在棘轮参数之后的 flag（棘轮那条路传空数组）
 * @returns {{error?: Error, status: number|null, stdout?: string, stderr?: string}}
 */
function runTsc(extraArgs) {
  return spawnSync(process.execPath, [tscPath, ...TSC_ARGS, ...extraArgs], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * 读 devDependency 的版本号，用于口径自述（读不到就写 `unknown`，不因此失败）。
 *
 * @param {string} rel `node_modules` 下的相对目录，如 `typescript` / `@types/node`
 * @returns {string}
 */
function depVersion(rel) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "node_modules", rel, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// ── strict 观测点（issue #416）：同一张依赖图 + `--strict`，只打印分布，**不参与 exit code** ──
// 放在陈旧声明守卫**之后**、棘轮那次 tsc 之前：守卫已经在上面把 `src/**/*.d.ts` 在场的情形拦成 exit 1，
// 于是「strict 报 0」在这里只有一种含义（真的 0），不会混进「声明把实现遮住了」那种假绿。
if (STRICT_REPORT) {
  const strictArgs = [...TSC_ARGS, ...STRICT_ONLY_ARGS];
  const strictRun = runTsc(STRICT_ONLY_ARGS);
  if (strictRun.error) {
    console.error(`check:types:strict — 启动 tsc 失败：${strictRun.error.message}`);
    process.exit(1);
  }
  const strictOutput = `${strictRun.stdout ?? ""}\n${strictRun.stderr ?? ""}`;
  const strictParsed = parseTscErrors(strictOutput);

  // 与棘轮同一条口径：**没解析到错误 + tsc 非 0 退出 = 跑都没跑成**，不是「strict 已经干净了」。
  // 这一格是「脚本自己出错」，所以它才允许非 0（观测的数本身永远不影响退出码）。
  if (strictParsed.errors.length === 0 && strictRun.status !== 0) {
    console.error(
      `check:types:strict — 失败 — tsc 退出码 ${strictRun.status}，但没解析到任何 \`error TS…\` 行`
      + "（不是「0 个 strict 错误」，是跑都没跑成；本命令只在**脚本自己出错**时才非 0）。\n"
      + `  tsc 命令：${process.execPath} ${[tscPath, ...strictArgs].join(" ")}\n`
      + "  tsc 原始输出（末尾 40 行）：\n"
      + strictOutput.trimEnd().split(/\r?\n/).slice(-40).map((l) => `    ${l}`).join("\n"),
    );
    process.exit(1);
  }
  if (strictParsed.unparsed.length) {
    // 形状变了就喊出来：正则失配等于观测静默失去检查面（与棘轮那侧的告警同一口径）。
    console.error(
      `check:types:strict — ⚠ 有 ${strictParsed.unparsed.length} 行含 \`error TS…\` 但没匹配预期的定位形状，`
      + "它们**没有计入下面的分布**（tsc 输出格式变了？请同步本脚本的 ERROR_LINE）：\n"
      + strictParsed.unparsed.slice(0, 10).map((l) => `    ${l}`).join("\n"),
    );
  }

  const strictByFile = new Map();
  const strictByCode = new Map();
  for (const e of strictParsed.errors) {
    strictByFile.set(e.file, (strictByFile.get(e.file) ?? 0) + 1);
    strictByCode.set(e.code, (strictByCode.get(e.code) ?? 0) + 1);
  }
  const strictFiles = [...strictByFile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const strictCodes = [...strictByCode.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const strictTotal = strictParsed.errors.length;
  const fileRows = VERBOSE ? strictFiles : strictFiles.slice(0, 10);
  const codeRows = VERBOSE ? strictCodes : strictCodes.slice(0, 8);

  console.log(
    "check:types:strict — strict 观测点（issue #416；**只观测、不判定**：观测到的数不影响退出码，不卡任何门禁；只有脚本自己跑不成时才非 0）\n"
    + `  入口：${ENTRIES.join(" + ")}（${MODE}；与 \`npm run check:types\` **同一张依赖图**——输入文件、target、module 一字不改，只多一个 \`--strict\`）\n`
    + `  tsc：typescript@${depVersion("typescript")} + @types/node@${depVersion("@types/node")}（devDependencies；与棘轮那条路是同一对）\n`
    + `  参数：${strictArgs.join(" ")}\n`
    + `  复现：node node_modules/typescript/bin/tsc ${strictArgs.join(" ")}\n`
    + `  对照：**非 strict 才是棘轮量的那个数**——\`npm run check:types\` 的基线是 ${BASELINE} 个 --checkJs 错误（${MODE}）；`
    + "strict 这一档没有基线、不参与判定，两个数不可互相比、也不许拿 strict 的数去下调基线。",
  );
  console.log(`strict 实测：${strictTotal} 个错误 / ${strictFiles.length} 个文件`);
  console.log(
    `  每文件${VERBOSE ? `（${strictFiles.length} 个）` : `（前 ${fileRows.length}，共 ${strictFiles.length} 个）`}：\n`
    + fileRows.map(([f, n]) => `    ${String(n).padStart(4)}  ${f}`).join("\n"),
  );
  console.log(
    `  每错误码${VERBOSE ? `（${strictCodes.length} 种）` : `（前 ${codeRows.length}，共 ${strictCodes.length} 种）`}：`
    + codeRows.map(([c, n]) => `TS${c}×${n}`).join("、"),
  );
  if (!VERBOSE && (strictFiles.length > fileRows.length || strictCodes.length > codeRows.length)) {
    console.log("  （要完整分布：加 --verbose；要单条定位：本命令目前只给聚合，逐条定位请直接跑上面的复现命令）");
  }
  // 观测路径到此结束：**观测到的数（多少都一样）不影响退出码**（issue #416：只观测，不改判定）。
  // 非 0 只发生在上面那三条「脚本自己跑不成」的路径上，与 strict 报多少无关。
  process.exit(0);
}

const tscRun = runTsc([]);

if (tscRun.error) {
  console.error(`check:types: 启动 tsc 失败：${tscRun.error.message}`);
  process.exit(1);
}

const tscOutput = `${tscRun.stdout ?? ""}\n${tscRun.stderr ?? ""}`;

const { errors, unparsed } = parseTscErrors(tscOutput);

// ⚠ 「没解析到错误」+「tsc 非 0 退出」= 跑都没跑成（参数写错、缺 lib、tsc 自己崩了），
//   此时「0 个错 < 基线」是假的干净，必须变红。
if (errors.length === 0 && tscRun.status !== 0) {
  console.error(
    `check:types: 失败 — tsc 退出码 ${tscRun.status}，但没解析到任何 \`error TS…\` 行（不是「0 个类型错误」，是跑都没跑成）。\n`
    + `  tsc 命令：${process.execPath} ${[tscPath, ...TSC_ARGS].join(" ")}\n`
    + "  tsc 原始输出（末尾 40 行）：\n"
    + tscOutput.trimEnd().split(/\r?\n/).slice(-40).map((l) => `    ${l}`).join("\n"),
  );
  process.exit(1);
}
// ⚠ 「0 个错」而基线 > 0 时同样按**检查面失效**处理：从 218 一步清零不是这一轮会发生的事，
//   而它更可能是「什么都没被检查」（入口没了、`src/` 被清、生成物遮蔽）。真要清零了就显式把基线改成 0，
//   这条守卫会随基线归零自动解除。
if (errors.length === 0 && BASELINE > 0) {
  console.error(
    `check:types: 失败 — 实测 0 个 --checkJs 错误，但基线是 ${BASELINE}：一步清零几乎不可能，`
    + "先怀疑**检查面失效**而不是「债还完了」。\n"
    + "  依次排查：① `src/` 下是否残留 `.d.ts` 生成物（本脚本上面的守卫会先拦，用 `--ignore-stale-declarations` 绕过时会留警告）；\n"
    + "  ② 入口文件是否还在（当前入口：" + ENTRIES.join(", ") + "）；③ tsc 是否被别的工具包了一层、输出形状变了（看下面的告警）。\n"
    + "  确认真的清零了：把本脚本的基线常量改成 0（那时这条守卫自动解除）。",
  );
  process.exit(1);
}
if (unparsed.length) {
  // 形状变了就喊出来：正则失配等于棘轮静默失去检查面（与 `docs-drift-check` 的「检查面失效本身就是漂移」同口径）
  console.error(
    `check:types: ⚠ 有 ${unparsed.length} 行含 \`error TS…\` 但没匹配预期的定位形状，`
    + `它们**没有计入基线比较**（tsc 输出格式变了？请同步本脚本的 ERROR_LINE）：\n`
    + unparsed.slice(0, 10).map((l) => `    ${l}`).join("\n"),
  );
}

const total = errors.length;
const byFile = new Map();
const byCode = new Map();
for (const e of errors) {
  byFile.set(e.file, (byFile.get(e.file) ?? 0) + 1);
  byCode.set(e.code, (byCode.get(e.code) ?? 0) + 1);
}
const files = [...byFile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const codes = [...byCode.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

if (PRINT_ONLY) {
  console.log(String(total));
  process.exit(0);
}

const summary = `${total} 个 --checkJs 错误 / ${files.length} 个文件`;
const detail = () =>
  `\n  每文件：\n${files.map(([f, n]) => `    ${String(n).padStart(4)}  ${f}`).join("\n")}`
  + `\n  每错误码：${codes.map(([c, n]) => `TS${c}×${n}`).join("、")}`;

if (VERBOSE) console.log(`check:types: 实测 ${summary}（${MODE}）${detail()}`);
if (SHOW_ERRORS > 0) {
  console.log(errors.slice(0, SHOW_ERRORS).map((e) => `  ${e.file}(${e.line},${e.col}): TS${e.code}: ${e.msg}`).join("\n"));
}

if (total > BASELINE) {
  // 棘轮变红：存量错误变多了。给「多在哪」而不是只喊数字。
  const top = files.slice(0, 5).map(([f, n]) => `${f} ${n}`).join("、");
  console.error(
    `check:types: 失败 — 实测 ${summary}${detail()}\n`
    + `  基线 ${BASELINE}（issue #214 棘轮，2026-10-23 实测，${MODE}），**超出 ${total - BASELINE} 个**。\n`
    + `  最多的文件：${top}\n`
    + "  怎么修：\n"
    + "    · 定位新错：`node scripts/type-check-ratchet.mjs --show-errors 40`；或改动前后各跑一次 `--verbose` 对比每文件计数；\n"
    + "    · 首选**减掉它**（补 JSDoc 类型；#213 R4 记录过两种会**静默**把参数退化成 `any` 的 JSDoc 形状）；\n"
    + "    · **不要**为了变绿去调高基线常量，除非这批新增确属「已知债 + 本轮不打算还」并在评审里点名——"
    + `确需上调时把 ${BASELINE} 改成 ${total}，并在提交信息里写清是谁的哪批改动、为什么本轮不还。`,
  );
  process.exit(1);
}

if (total < BASELINE) {
  console.log(
    `check:types: OK — 实测 ${summary}（${MODE}），比基线 ${BASELINE} **少 ${BASELINE - total} 个**。\n`
    + `  基线可下调至 ${total}：改 scripts/type-check-ratchet.mjs 的常量并单独提交（棘轮只减不增，别把这次收益丢掉）。`,
  );
  process.exit(0);
}

console.log(`check:types: OK — 实测 ${summary}（${MODE}），等于基线 ${BASELINE}（issue #214 棘轮：只减不增）。`);
