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
// 第二件事（issue #635 ① / #672）：它还把**本次实测的带错文件数**与两份指令面文档里「带错文件数」的现状声称
//   逐处对一遍（M 这一维从 #630 S2 起没人校：写 29 还是 99 都绿）。#635 ① 先堵了 `基线 **N** / M 个文件`
//   那一种形状；#672 补上另外四种（`N of them (M files)` / `**M of them carrying errors**` /
//   `N 个错（涉 M 个文件）` / `其中 **M 个带错**`）——四处的逐条裁决（哪些数字是现状声称、哪些是历史值）
//   写在下面 `DOC_FILE_COUNT_CLAIMS` 的头注释里。写错了 ⇒ **exit 1** 并点名那一行（文件:行、文档的 M、
//   实测的 M）；读不到声称句 / 读不到实测值 ⇒ **exit 2**。为什么不放进 `check:docs`：
//   那条门禁从不跑 tsc，而要判 M 就得 spawn 一次 tsc；棘轮本来就已经量出 M 了 ⇒ 这里是零额外 tsc 运行。
//   判据自己的反向证（#672 验收 (e)）是 `runDocClaimSelfTest()`，**无条件跑**（零 tsc 运行）。
//
// 与 #213 的两个门禁的分工（别混）：
//   · `types:build` / `check:types-build` = 「**还能不能产出随包 `.d.ts`**」（tsc exit 0 + 公共符号在不在），
//     它跑的是 `--declaration --emitDeclarationOnly`、**不带 `--checkJs`**，对类型质量零评判。
//   · `check:types`（本脚本）= 「**存量 `--checkJs` 错误有没有变多**」。它不产出任何东西，也不要求 0 错。
//
// 为什么基线是脚本里的常量而不是 tsconfig：本仓**没有 tsconfig.json**（CLI 显式给出输入文件时 tsc 根本
//   不读 tsconfig，见 `scripts/build-types.mjs` 里同款实测注释），而且基线必须随代码走、每次改动都可 review。
//   为什么**只卡总数**不卡「涉及文件数」：文件数会随「顺手清了某个文件的错」而**下降**，那是好事；把文件数
//   也设成棘轮会挡住我们想要的方向，所以它**不参与棘轮判定**，只作为**报告信息**打印。
//   但它会与指令面文档里的现状声称对账（#635 ① / #672）：那个数在文档里是**事实断言**，写错就是假话。
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
//   npm run check:types                        # 默认：包根入口 src/index.js，非 strict 基线 99
//   npm run check:types -- --with-tools        # 连 erix-agent/tools 入口一起卡，非 strict 基线 134
//   npm run check:types:strict                 # strict 棘轮（issue #417）：同一张依赖图加 `--strict`，基线 `BASELINE_STRICT_ROOT`
//   npm run check:types:strict -- --with-tools # strict 并集一档，基线 `BASELINE_STRICT_WITH_TOOLS`
//   node scripts/type-check-ratchet.mjs --verbose                   # 额外打印每文件、每错误码分布
//   node scripts/type-check-ratchet.mjs --show-errors 20            # 额外打印前 20 条错误定位（定位新错用）
//   node scripts/type-check-ratchet.mjs --baseline                  # 只打印四个基线常量与复现命令
//   node scripts/type-check-ratchet.mjs --print-count               # 只打印实测错误总数（脚本化下调基线用；加 --strict 打印 strict 那一档）
//   node scripts/type-check-ratchet.mjs --ignore-stale-declarations # 明知 src/ 下有 .d.ts 生成物仍强行跑
//   node scripts/type-check-ratchet.mjs --strict-report             # 旧名（issue #416 的观测点），现在与 --strict 同义，保留是为了不让既有脚本 / 文档一夜失效
//   node scripts/type-check-ratchet.mjs --self-test                 # 只跑文档对账判据自己的反向证（合成夹具，不跑 tsc；主路径上也会无条件跑一次）
//
// ── strict 棘轮（issue #417）：把「最宽松口径」那笔债也变成只减不增 ──────────────────
// 来历：issue #416 先把 strict 那一档**摆到日志里**（「只观测、不判定」：跑同一条 tsc 加 `--strict`、打印
//   总数 + 按文件 + 按错误码的分布，观测到的数不影响退出码）。#417 把同一件事升级成**门禁**：这个开关
//   现在**参与退出码**，理由很直接——只观测的债会自己长大：#416 记录的快照与 #417 开工时的实测之间
//   已经差了一大截（具体两个数都不抄在这里：一个在下面的基线常量里，另一个在 #416 的正文里）。
//
// 口径（与上面那对非 strict 基线**互不相干**，两条路各自独立判定）：
//   · 入口、target、module、`--skipLibCheck` 与 `TSC_ARGS` **逐字相同**，只在**数组副本**里多一个 `--strict`
//     ⇒ 「strict 比非 strict 多出来的错」这个差额是可比的，而两个总数**不可互相比**，更不许拿一档的数
//     去下调另一档的基线。
//   · 基线是**两个常量**：`BASELINE_STRICT_ROOT`（包根入口，默认档）与 `BASELINE_STRICT_WITH_TOOLS`
//     （加 `--with-tools` 的并集档）。两档必须**同一笔提交里一起测、一起降**——#214 的教训（退役的 261
//     曾悄悄背着 #177 已还掉的那 1 个），非 strict 那对常量也是这么被要求同步的。
//   · 判定与非 strict 那条路**同构**：超过基线 ⇒ exit 1（点名超出的文件）；等于 ⇒ exit 0；低于 ⇒ exit 0
//     + 打印「基线可下调至 N」（下调是独立的人工动作，别把收益丢掉）。
//   · ⚠ 本票**只加闸、不修债**（#417 的边界）：基线取的是本票落地那一刻的实测值，不是 0；清债是按文件
//     切片的后续动作（每片 PR 降这个常量）。所以「strict 有几千个错」在闸上了之后**照样是绿的**——红的是
//     **新增**，那才是这道门唯一的存在理由。
//   · 三条硬失败路径照旧（它们都不是「strict 报了多少」）：tsc 起不来、tsc 非 0 退出却一条错都没解析出来、
//     `src/**/*.d.ts` 残留（下面那条共用守卫）。加两条与非 strict 同口径的假绿防线：实测 0 而基线 > 0 ⇒
//     按**检查面失效**判红；`src/**/*.d.ts` 在场 ⇒ 拒绝运行（那种情形下 strict 报 0 是声明把实现遮住了）。
//   · 棘轮那侧的 `TSC_ARGS` / 两个非 strict 常量 / 那条判定链**一字不动**：`--strict` 只出现在
//     `STRICT_ONLY_ARGS` 这个副本里，删掉本开关 = 回到 #416 的行为，不会影响非 strict 棘轮。
//
// 基线是哪棵树量的（数字不许脱离这句话单独引用）：2026-10-31，基点 `4840004`（issue #417 的工作树，
//   `typescript@5.9.3` + `@types/node@22.20.5`，Node 22，`src/` 下 0 个 `.d.ts`）。同一对常量必须在
//   同一次测量里产出，否则两档会漂——这也是 #417 判据 ③ 的原话。
// 2026-11-01 在同一棵 main 树上重测并下调并集档：**包根 `BASELINE_STRICT_ROOT` 一字未动（1894）**，
//   并集 `BASELINE_STRICT_WITH_TOOLS` **2128 → 2124**。减掉的 4 个全部来自 `f55eb8f` 那一行
//   `@returns` 补 `facts`（#375 加事实集时漏了它，下游 4 处 `facts` 属性访问在 strict 档同样计数）；
//   对照实测：`f55eb8f^` = 2128、`f55eb8f` = 2124（两棵归档树各跑一次 `--strict --with-tools`，
//   临时把非 strict 并集基线抬 3 格好让脚本跑到 strict 档——归档树上那一档当时是 147 > 144）。

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
// 下调记录（最新一笔）：**110 → 108** 与 **146 → 144**（2026-10-31 同日第二笔，实测于 main `c92c8fa`；**两档同刀各降 2**，
//   两档减的 2 个**完全相同**，全部落在 `src/loop/orchestrator.js` **14 → 12**。来源是 #473 + #435 那次合并
//   （`src/loop/orchestrator.js` 重写 `deliverablesAllPassed` / `deliverablesFailures` 那一段时把两个内联表达式
//   提成了带类型的局部量，重构顺带消掉的，不是专门去修类型债）。改前对照树用 `git archive` 取到空目录、
//   同一对 `typescript@5.9.3` + `@types/node@22.20.5` 跑同两条命令：`3ee458d`（合 #257 后）、`af2d54e`（合 #586 后）、
//   `81541c5`（波次 1 后）**三棵都实测 110 个 / 27 文件、`orchestrator.js` 14**，与旧常量逐字相同；
//   改后逐文件对账：除 `src/loop/orchestrator.js` 外那 26 个带错文件计数一字未动，`src/tools/file-tools.js` 仍 20、
//   `src/skills/loader.js` 仍 16（⇒ 144 = 108 + 20 + 16 自洽），也没有文件进出错误集合（27 / 29 两个文件数未变）。
//   **两半分布同步重测**（不是减法推出来的）：宿主可及公共面 **81 → 79 个**（`orchestrator.js` 在公共面那半边），
//   宿主点不到名的纯实现内部文件 **29 个 / 9 个文件未动**（79 + 29 = 108）。
//   上一笔：**116 → 110** 与 **152 → 146**（issue #630 S2 / J，2026-10-31 实测于当时树；**两档同刀各降 6**，
//   两档减的 6 个**完全相同**，且都不是本单写出来的——本单（S2 的 D / F / G / I 四刀）在 `dfa4146` 与改后树上
//   两档实测都是 110 / 146，一个错都没动，所以这是一笔纯「还债到账」的下调）。逐文件对账（改前对照树
//   `git archive 56c16ca` 取到空目录、同一对 tsc/@types 跑同两条命令 = **116 个 / 28 文件** 与 **152 个 / 30 文件**，
//   与旧常量逐字相同）：
//   · `src/run-state.js` **10 → 4**（减 6）
//   · `src/loop/orchestrator.js` **17 → 14**（减 3）
//   · `src/reflection/wrapup.js` **3 → 0**（减 3，该文件退出错误集合 ⇒ 带错文件数 28 → 27 / 30 → 29）
//   · `src/compact/pipeline.js` **3 → 6**（增 3）
//   · `src/compact/fold-llm.js` **2 → 5**（增 3）
//   · 其余 **22 个带错文件一字未动**（`src/tools/file-tools.js` 仍 20、`src/skills/loader.js` 仍 16，所以
//     `146 = 110 + 20 + 16` 照旧成立），也没有别的文件进出错误集合；净额 −6 = −6 −3 −3 +3 +3。
//   来源：这 6 个单位是 56c16ca 之后那一串压缩/续跑单（#611 / #612 / #614 / #601 / #598 等）**重构顺带**掉的，
//   不是专门修类型；两个 +3 是同一批改动把折叠相关的几处形状写复杂了的代价（净额仍是 −6）。
//   **两档在同一笔提交里一起下调**（#214 的教训：退役的 261 曾悄悄背着 #177 已还掉的那 1 个）。
// 下调记录：**117 → 116** 与 **153 → 152**（issue #413，2026-10-23 实测于当前树；**两档同刀各降 1**）。
//   减掉的这 1 个**不在**基线时代的任何一个带错文件的账上——它是 issue #409（PR #410）**两笔**提交的净效果：
//   · `6b604e7` 把 `parseOpenAIToolArguments` 里那句 `JSON.parse(value)`（`value` 是 `unknown`）换成共享入口
//     `parseToolArguments(rawArguments).input` ⇒ `src/messages/openai-normalization.js` 的 `(60,23)` 那条
//     `TS2345 Argument of type 'unknown' is not assignable to parameter of type 'string'` 消失（**1 → 0，该文件
//     退出错误集合，−1 个带错文件**）；但同一笔新增的 `src/messages/tool-arguments.js` 自己带进 1 条
//     `TS2339 Property 'error' does not exist on type …`（`(69,70)`——`--checkJs` 不带 `strict`，布尔字面量判别
//     在那里不收窄），**+1 个带错文件**——一进一出，所以这一笔是**错误数净额 0、带错文件数 29 → 29 不变**
//     （⚠ 别把这笔记成 29 → 28：实测 `6b604e7^` 与 `6b604e7` 都是 **117 个 / 29 文件**，文件集合里只是
//     `openai-normalization.js` 换成了 `tool-arguments.js`）；
//   · `d9a0989`（同属 #409 的收尾刀）把 `src/text/repair-json.js` 里 `parseJsonWithRepair` 的 `@returns` 从判别联合
//     改成「单形状 + 可选字段」，`tool-arguments.js` 那条 `TS2339` 随之消失 ⇒ **错误数净 −1、带错文件数 29 → 28**
//     （实测 `6b604e7` = **117 / 29**、`d9a0989` = **116 / 28**）；
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
//   现在最集中的文件（2026-10-31 于 `c92c8fa` 重测，档一 108 个 / 27 文件）：`src/loop/orchestrator.js` 12、
//   `src/providers/anthropic.js` 9、`src/loop/run-snapshot-executor.js` 8、`src/tools/notes.js` 7、`src/providers/openai.js` 7、
//   `src/display/projection.js` 7、`src/tools/registry.js` 6、`src/store/notes.js` 6、`src/compact/pipeline.js` 6
//   （`--with-tools` 一档再加 `src/tools/file-tools.js` 20、`src/skills/loader.js` 16；历史值：2026-10-31 上一笔 17 / 10 / 9 / 8 / 7 / 7 / 7）。
// 下调记录：**108 → 107**（issue #177 刀4，2026-11-01）——减的那 1 个是
//   `error.code = "judge_intercept_timeout"` 的 TS2339（`Property 'code' does not exist on type 'Error'`）。
//   它原本在 `src/loop/orchestrator.js`，而那个文件没有 `// @ts-check`；`build-types` / `prepack` 的 tsc
//   **不带** `--checkJs`（`@ts-check` 是唯一开关），所以这条债在发布门禁上一直看不见。刀4 把 judge 调用单元
//   搬进首行带 `// @ts-check` 的新模块 `src/loop/judge-runner.js` 之后，它第一次进入 build-types 的检查面
//   （tsc exit 2）⇒ 补一行 `/** @type {Error & {code?: string}} */` 修掉（零行为变化）。
//   带错文件数仍是 **27 个**（`src/loop/judge-runner.js` 自身 0 个错），可及 78 / 宿主不可及 29 = 107。
// 下调记录：**107 → 103**（issue #661 收尾，2026-11-01）——减的 4 个**全部**在 `src/compact/fold-llm.js`
//   （5 → 1）：#661 删掉「摘要器失败 ⇒ 返回统计摘要替代物」那条路径之后，那四条指向旧失败形状
//   `{ degradeKind, degradeReason, … }` 联合类型的 TS2339（`.summary` / `.degradeReason` / `.degradeKind` /
//   `.budgetExhausted`）随写点一起消失；剩下的 1 个是该文件第 290 行的 TS2741（默认 summarizer 缺席），
//   与本刀无关。带错文件数仍是 **27 个**（`fold-llm.js` 没退出错误集合），可及 74 / 宿主不可及 29 = 103
//   （`src/compact/fold-llm.js` 在公共半边：`src/index.js` 直接 `export … from` 它）。两档同笔下调，
//   并集 142 → 138 是**同一次测量**里的同一个 −4。
// 下调记录：**103 → 96**（issue #753 C1，2026-11-07，本地 node v22.23.2；rebase 到 `origin/main 47b69bf` 之后在
//   **最终树**上重取，值不变仍是 **96**）。**这一档 −7 不是本片还的债，是陈旧登记值**：同一次测量里把
//   `origin/main` 用 `git archive` 摊到 /tmp/main746、单独跑同一把尺，逐字输出是
//     check:types: OK — 实测 96 个 --checkJs 错误 / 26 个文件（包根入口），比基线 103 **少 7 个**。
//   ⇒ 主干自己就量到 96（本片对非 strict 档**净增 0**），登记值 103 是 #661 时代留下、此后没人再测的数；
//   按「棘轮只减不增」对齐到现测。带错文件数 **26** 未变。
// 重新取值：**96 → 99**（issue #753 C1，2026-11-07，rebase 到 `origin/main b23f782`（#735 slice2 已合）之后的
//   **最终树**现测）。**常量抬 3 不是放宽棘轮，是现测抬了 3，而那 3 不是本片**：同一把尺在主干那一侧逐字输出
//     check:types: OK — 实测 99 个 --checkJs 错误 / 26 个文件（包根入口），比基线 103 **少 4 个**。
//   本支在同一棵树上同样是 **99 / 26 个文件** ⇒ 本片对非 strict 档**净增 0**；+3 落在 #735 slice2 的改动上
//   （旧记录那个 96 量于 `47b69bf`，主干自己往前走了）。常量取最终树现测 **99**：它仍比主干登记的 103 低 4，
//   棘轮方向没被松开。带错文件数 **26** 未变。
const BASELINE_ROOT = 102;

// `--with-tools` 的基线：把第二个公共入口 `src/tools/index.js` 也喂给 tsc 后的并集。
// 复现命令（逐字）：
//   node node_modules/typescript/bin/tsc --noEmit --allowJs --checkJs --target es2023 \
//     --module nodenext --moduleResolution nodenext --skipLibCheck src/index.js src/tools/index.js
// 实测（2026-10-11，`59f3a72`）：**185 个错 / 31 个文件** = 单入口的 142 个，加上只有 `./tools` 才拉进来的
//   `src/tools/file-tools.js` 27 个与 `src/skills/loader.js` 16 个（两个都是宿主直接可见的导出实现，
//   `createFileTools` / `discoverSkills` 那一族）**当前值（2026-11-01 于 #177 刀4 的树上复测）= 142 个 / 29 个文件 = 107 + 19 + 16**；
//   历史值：143 个 = 108 + 19 + 16（2026-10-31 于 `c92c8fa`；旧注释把这一格写成「144 个 = 108 + 20 + 16」，
//   与当时的常量 143、与实测的 `src/tools/file-tools.js` 19 个都不符，本笔一并改正）、
//   146 个 = 110 + 20 + 16（2026-10-31 上一笔）、152 个 / 30 个文件 = 116 + 20 + 16（2026-10-23 复测）；
//   2026-10-22 那轮的 153 个 = 117 + 20 + 16、再上一轮的 156 个 = 117 + 23 + 16、2026-10-21 那轮的 160 个 = 117 + 27 + 16、2026-10-15 那轮的 162 个 = 119 + 27 + 16、2026-10-13 在同一棵 `39e96f1` 上复测的 164 个 = 121 + 27 + 16 都是**历史值**（与旧常量的差额逐个落在 `src/store/notes.js`、`src/display/projection.js`、`src/tools/file-tools.js` 与 `src/messages/openai-normalization.js`，同上面那些下调记录；
//   `loader.js` 16 这个计数自 #214 起一字未动，本次也逐个复核过）。
//   2026-11-01（#661 收尾）两档同笔各降 4：并集 **142 → 138**，与包根档同一个 −4（全在
//   `src/compact/fold-llm.js` 5 → 1）；`src/tools/file-tools.js` 仍 19、`src/skills/loader.js` 仍 16，
//   两个只有 `./tools` 才拉进来的文件一个错都没变。#214 时代入库的是 **261**，
//   而它**从来没跟着 #177 刀 1 复测过**：同一对 tsc/@types 在改前树 `8f83375` 实测这一档是 **260**，
//   于是 261 → 185 的 76 个 = #249 的 75 个 + #177 欠下的那 1 个（教训：下调基线要**两档一起复测**）。为什么默认不带它：#214 正文给的口径就是 `src/index.js`，
//   默认值必须与规格逐字一致；但它**是**真实盲区，所以这里留一条可随时收紧的通道（收紧=把默认入口加上并
//   把基线换成当前实测值，属 #214 之后的收紧动作，不要拿它当「反正卡不住」的理由）。
// 下调记录：**138 → 131**（issue #753 C1，2026-11-07，与 `BASELINE_ROOT` 同一次测量、同一笔提交；rebase 后在
//   最终树上重取，值不变仍是 **131**）。主干那一侧的逐字输出（同一把尺、同一台机器）：
//     check:types: OK — 实测 131 个 --checkJs 错误 / 28 个文件（含 ./tools 入口），比基线 138 **少 7 个**。
//   ⇒ 与包根档同一个 −7（陈旧登记值，本片净增 0），带错文件数 **28** 未变。
// 重新取值：**131 → 134**（issue #753 C1，2026-11-07，与 `BASELINE_ROOT` 同一次测量、同一笔提交；基点
//   `origin/main b23f782`）。主干那一侧逐字输出：
//     check:types: OK — 实测 134 个 --checkJs 错误 / 28 个文件（含 ./tools 入口），比基线 138 **少 4 个**。
//   本支在同一棵树上也是 **134 / 28**（本片净增 0，+3 同属 #735 slice2）。分解式仍成立：**134 = 99 + 19 + 16**
//   （`src/tools/file-tools.js` 19、`src/skills/loader.js` 16 两个计数逐个复核未动）。带错文件数 **28** 未变。
const BASELINE_WITH_TOOLS = 137;

// ── strict 档基线（issue #417：把 #416 的「只观测」升级成棘轮）──────────────────────
// 这两个常量是 strict 那一档的**唯一真值**。同一条 tsc 命令（入口 / target / module / `--skipLibCheck` 与非
// strict 那条逐字相同）只多一个 `--strict`，总量就从三位数跳到四位数（构成：TS7006 隐式 any 参数最多，其次
// TS2339 / TS7005 / TS7031 / TS7034 / TS7053 …）——这笔债 #416 只摆到日志里，于是它自己长大了；#417 把它也
// 钉成「只减不增」。
//
// 测量口径（数字脱离这句话就没有意义）：
//   · 树：2026-10-31，基点 `4840004`（issue #417 的隔离工作树），`src/` 下 0 个 `.d.ts`（生成物在场会把两档都
//     遮成 0，那种 0 是假绿，脚本会直接拒绝运行而不是拿来当基线）；
//   · 工具：`typescript@5.9.3` + `@types/node@22.20.5`（devDependency，与非 strict 棘轮同一对），Node 22，Linux；
//   · **两档在同一次测量里产出**（#214 的教训：两档分两次测就会悄悄漂开一格）。
// 复现命令（逐字，在仓库根目录；`--print-count` 只打印总数，脚本化下调基线时用它）：
//   node scripts/type-check-ratchet.mjs --strict --print-count
//   node scripts/type-check-ratchet.mjs --strict --with-tools --print-count
//
// 下调规矩（与非 strict 那对完全一致，别发明第二套）：把常量改成命令打印的「可下调至 N」，**单独一次提交**，
// 提交信息里写清是哪个文件减了多少错；**两档要么一起降、要么都不动**，只降一档 = 把差额推给另一档。
// ⚠ 本票（#417）**只加闸、不修债**：下面的数就是本票落地那一刻的实测，不是 0。清债是按文件切片的后续动作，
//   每片 PR 降这个常量；在此之前「strict 有几千个错」是绿的，红的是**新增**。
// 2026-11-01（#177 刀4）两档同笔各降 1：包根 1894 → 1893、并集 2124 → 2123——同一条
// `error.code` TS2339（理由见上面 `BASELINE_ROOT` 那条下调记录），两档在**同一次测量里**产出。
// 2026-11-02（#661 审计 A3 收尾）两档同笔各降 1：包根 1893 → 1892、并集 2123 → 2122——`src/loop/orchestrator.js`
// 的折叠 catch 把 `unpersisted` 的两次访问合并成一次 `any` 视图读（`copyErrorCarrier` 载体化之后多出来的
// 那一次 `compactionError.unpersisted` 不再直接点属性），同一段里 `Property 'unpersisted' does not exist on
// type '{}'` 由 2 个减到 1 个；两档在**同一次测量里**产出（1892 / 2122）。
// 下调记录：**1892 → 1872**（issue #753 C1，2026-11-07，rebase 到 `origin/main 47b69bf` 之后的**最终树**现测；
//   四档同一次测量、同一笔提交）。**本片的账要说清**：主干那一侧同尺实测 **1868 / 72 文件**，本支
//   **1872 / 72** ⇒ 本片**净增 +4**（`src/loop/orchestrator.js` 里 `nextUserTurnHook` 注入闭包与 `finish` 包装的
//   隐式 any 参数，TS7006 一族），本轮不还、在这里点名；1872 仍比登记值 1892 低 **20**（那 24 个陈旧余量
//   里 4 个被本片吃掉），按棘轮方向降到现测。带错文件数 **72** 未变（本片没让新文件进错误集合）。
// 重新取值：**1872 → 1877**（issue #753 C1，2026-11-07，四档同一次测量、同一笔提交；基点 `origin/main b23f782`）。
//   主干那一侧逐字输出：
//     strict 实测：1873 个错误 / 72 个文件 ⇒ check:types:strict: OK，比基线 1892 少 19 个。
//   本支在同一棵树上 **1877 / 72**：+5 是 #735 slice2 落树带来的，**+4 是本片的账**（`src/loop/orchestrator.js`
//   里 `nextUserTurnHook` 注入闭包与 `finish` 包装的隐式 any 参数，TS7006 一族——与上面那条 1872 记录里的同一族，
//   本轮不还、在这里点名，收它要动宿主可见的 JSDoc，另开单更划算）。1877 仍比主干登记的 1892 低 **15**。
//   带错文件数 **72** 未变。
// 2026-11-09 抬档（issue #790 请求视图兜底）：
// 两档各 +3，取现报值 1890 / 2103（同一笔提交一起抬，口径同 #417 / #765）。
// 三处都是 TS7006 隐式 any 参数，与存量 962 条同一类，
// 属「已知债 + 本轮不还」；非 strict 两档没动（仍 102 / 137）。
const BASELINE_STRICT_ROOT = 1890;
// 2026-11-01 重测下调 2128 → 2124（−4 = `f55eb8f` 一行 `@returns` 补 `facts`；包根档同笔复测未动）
// 下调记录：**2122 → 2085**（issue #753 C1，2026-11-07，与上三档同一次测量、同一笔提交）：主干那一侧并集
//   档实测 **2081 / 78 文件**、本支 **2085 / 78**（同一个 +4，出处见 `BASELINE_STRICT_ROOT` 那条：TS7006 一族，
//   本轮不还）；登记值 2122 里的余量是陈旧量，一并对齐到现测。
// 重新取值：**2085 → 2090**（issue #753 C1，2026-11-07，与上三档同一次测量、同一笔提交；基点 `origin/main b23f782`）：
//   主干那一侧并集档逐字输出 `strict 实测：2086 个错误 / 78 个文件`（比基线 2122 少 36 个），本支在同一棵树上
//   **2090 / 78** —— 同一个 +4（出处见上面 `BASELINE_STRICT_ROOT` 那条：TS7006 一族，本轮不还），另 +5 属 #735 slice2。
//   两档仍在同一笔提交里一起测、一起取，2090 比主干登记的 2122 低 **32**。
const BASELINE_STRICT_WITH_TOOLS = 2103;

const argv = process.argv.slice(2);
const WITH_TOOLS = argv.includes("--with-tools");
const VERBOSE = argv.includes("--verbose");
const PRINT_ONLY = argv.includes("--print-count");
const IGNORE_STALE = argv.includes("--ignore-stale-declarations");
const STRICT = argv.includes("--strict") || argv.includes("--strict-report");
const SELF_TEST = argv.includes("--self-test");
const SHOW_ERRORS = (() => {
  const i = argv.indexOf("--show-errors");
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : 0;
})();

// 与 issue #214 正文口径逐字一致的 tsc 参数（输入文件是唯一的入口；依赖图由它自己拉）。
const ENTRIES = WITH_TOOLS ? ["src/index.js", "src/tools/index.js"] : ["src/index.js"];
const BASELINE = WITH_TOOLS ? BASELINE_WITH_TOOLS : BASELINE_ROOT;
const STRICT_BASELINE = WITH_TOOLS ? BASELINE_STRICT_WITH_TOOLS : BASELINE_STRICT_ROOT;
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
    + `  复现命令：node node_modules/typescript/bin/tsc ${TSC_ARGS.join(" ")}\n`
    + `check:types:strict: 基线 = ${STRICT_BASELINE} 个 strict 错误（${MODE}；issue #417 棘轮，2026-10-31 实测于基点 4840004；2026-11-01 两档同笔复测：包根 1894 未动，并集 2128 → 2124（−4 = f55eb8f）\n`
    + `  两档基线：包根入口 ${BASELINE_STRICT_ROOT}（默认）/ 含 ./tools 入口 ${BASELINE_STRICT_WITH_TOOLS}（加 --with-tools）\n`
    + `  复现命令：node node_modules/typescript/bin/tsc ${[...TSC_ARGS, ...STRICT_ONLY_ARGS].join(" ")}\n`
    + `  （两档必须同一笔提交里一起测、一起降；strict 与非 strict 是两个互不相干的数，不许拿一档的数去下调另一档）`,
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

// ── 文档对账（issue #635 ①）：棘轮实测的**带错文件数** ↔ 指令面文档的声称句 ──────────────
// 这一维从 issue #630 S2 / J 起就没人校：`scripts/docs-drift-check.mjs` 的 `BASELINE_CLAIM_RULES` 只校
// 「基线 **N** / M 个文件」里那个 **N**，M 从写死的 `30 files` 改成 `\d+ files` 之后成了**哑弹**（文档写
// `29 files` 还是 `99 files` 都绿）。#635 ① 给的正解是**从实测往文档方向**对账，而那条对账天然属于这里：
// 棘轮本来就已经把每档的「错误总数 + 带错文件数」算出来了 ⇒ 这条是**零额外 tsc 运行**。
// 为什么不放进 `check:docs`：`docs-drift-check.mjs` 从不跑 tsc，要它判 M 就得 spawn 一次 tsc，而
// `check:docs` 是文档门禁里跑得最勤的一条（每次文档改动），为此把它变成十秒级不值得。分工是：
// N 的正本对账仍在 `docs-drift-check.mjs` 的 `BASELINE_CLAIM_RULES` 里，本文件只用 N 认领这句声称属于哪一档。
// 三条口径（都是本仓既有惯例，别放宽）：
//   · **逐处判**（per-occurrence），不是 existence-level：#210 的教训是 existence-level 的锚点把整句删掉都
//     不红。这里每抽到一处就单独比一次，中英两侧各判各的。
//   · **两档各自独立**：句子里那个 N 等于哪一档的基线，就按**哪一档**的实测文件数判。拿并集档的数去顶包根档
//     （或反过来）会红，而不是「反正差两个也算过」。
//   · 读不到（文档不在 / 抽不到声称句 / 抽不到实测值）⇒ **exit 2**；写错了 ⇒ **exit 1**。
//     「读不到真值」永远不等于「没问题」（#164 口径）。
// ⚠ strict 档不跑这条对账：文档里这两句说的是非 strict 棘轮，strict 的带错文件数是**另一个量**（#417 明令
//   禁止拿一档的数去顶另一档）。strict 那一步照样只判它自己的基线常量。
//
// ── #672：再补四处「M 个文件」形状的现状声称（此前六道门禁全绿也拦不住）───────────────────
// 补的四处在**包根档**的段落里：
//   · `AGENTS.md:105`  `(27 files) are accepted debt`          —— 承接同句前半的 `107 of them`；
//   · `AGENTS.md:132`  `**27 of them carrying errors**`        —— 承接上一段的 `--listFiles`（入口 `src/index.js`）；
//   · `AGENTS_cn.md:149` `107 个错（涉 27 个文件）`；
//   · `AGENTS_cn.md:153` `其中 **27 个带错**`。
// **逐条裁决**（哪些数字参与判定、哪些是历史值不参与）——本单最容易做错的就是这里，所以写死在代码里：
//   · 参与判定的只有这四处里的 M。同一批句子里还有一批**历史值**，一律不判：
//       EN 105–111：`the #214 measurement was 218`、`took 75 more`、`openai.js 46 → 7`、`anthropic.js 45 → 9`、
//         `the other 27 error-carrying files moved by zero`、`notes.js 27 → 6`、`the other 28 … moved by zero`、
//         `142 / 185`（PR #249 / issue #265 当时的对照树读数）；
//       EN 128–132：`the 65 recorded on 2026-10-21`、`the 58 on 2026-10-13`、`the 56 before #265`；
//       CN 149：`#214 首测是 218`、`75 个`、`46 → 7`、`45 → 9`、`其余 27 个带错文件一个没动`、`27 → 6`、
//         `其余 28 个带错文件一个没动`、`142 / 185`；
//       CN 153：`2026-10-21 记的 65`、`2026-10-13 记的 58`、`#265 之前的 56`。
//     判据靠**句式锚点**把现状声称钉住，而不是「抽一个两位数」：`(M files)` 必须紧跟在 `N of them` 之后；
//     `**M of them carrying errors**` 必须整段加粗（`the other 27 error-carrying files` 那种叙述没有这层壳）；
//     中文侧同理（`个错（涉 M 个文件）`、`其中 **M 个带错**`；`其余 27 个带错文件` 不带 `其中 **… **`）。
//     一刀切抽「两位数字」会把上面那批历史值全判红——它们讲的是**当时为真**的事实，不是现状声称。
//   · 这四处都写在包根档的段落里（`npm run check:types` 的默认档 / 入口 `src/index.js` 的 `--listFiles`），
//     所以它们的 `tier` 声明为 `"root"`：只有包根档那次运行判它们，`--with-tools` 那次把它们记成 deferred。
//     反过来说，拿 29（并集档的带错文件数）去填这四处必须红——那是「拿另一档的数顶本档」，不是「差两个也算过」。
//   · `tier: "root"` **不是**把 27 写死：它只声明「这句归哪一档」，期望值仍然从本次实测取（见
//     `reconcileDocFileCounts` 里 `measuredFiles` 的来源）。
const DOC_FILE_COUNT_CLAIMS = [
  // 分组用**命名组**：`n` = 句中的基线（只有 `tier: null` 的声称句有），`m` = 要判的带错文件数。
  // 带 `d` 标志是为了拿 `indices.groups.m`：报错要点名的是**那个数字所在的行**（`(27 files)` 在下一行，
  // 拿整段匹配的起点报行会错行——#672 的验收要求「各自点名那一行」）。
  // #635 ①：`基线 **N** / M 个文件` —— 句中带基线 N，按 N 认领档位（`tier: null`）。
  { rel: "AGENTS.md", form: "baseline **N** / M files", tier: null,
    re: /baseline\s+\*\*(?<n>\d+)\*\*\s*\/\s*(?<m>\d+)\s*files/gd },
  { rel: "AGENTS_cn.md", form: "基线 **N** / M 个文件", tier: null,
    re: /基线\s*\*\*(?<n>\d+)\*\*\s*\/\s*(?<m>\d+)\s*个文件/gd },

  // #672：四处「M 个文件」现状声称（都属包根档；裁决理由见本节头注释）。
  { rel: "AGENTS.md", form: "N of them (M files)", tier: "root",
    re: /\d+\s+of them\s*\((?<m>\d+)\s+files\)/gd },
  { rel: "AGENTS_cn.md", form: "N 个错（涉 M 个文件）", tier: "root",
    re: /\d+\s*个错（涉\s*(?<m>\d+)\s*个文件）/gd },
  { rel: "AGENTS.md", form: "**M of them carrying errors**", tier: "root",
    re: /\*\*(?<m>\d+) of them carrying errors\*\*/gd },
  { rel: "AGENTS_cn.md", form: "其中 **M 个带错**", tier: "root",
    re: /其中\s*\*\*(?<m>\d+)\s*个带错\*\*/gd },
];

/**
 * 把两份指令面文档里「带错文件数」的现状声称与**本次实测**逐处对账（issue #635 ①；#672 扩到四种形状）。
 *
 * @param {{errors: {file: string}[], tierBaseline: number, tierId: "root" | "withTools", tierName: string,
 *   otherBaseline: number, verboseCommand: string, sources?: Record<string, string>}} m
 *   `errors` = 本次 tsc 解析出来的错误。**实测两维都从它现算**：总数 = 条数，带错文件数 = 去重后的文件数。
 *     为什么在函数内部算而不由调用方传进来：#672 的验收 (e) 要求「判据里那处实测来源被换成常量字面量 ⇒
 *     自测必须红」，而自测喂的就是**合成的 errors 数组**（见 `runDocClaimSelfTest`）——把这里换成 `27` 这种
 *     字面量，自测里那份「41 个文件」的夹具当场就对不上。
 *   `tierBaseline` = 本档的基线常量值（`tier: null` 的声称句用它认领档位）；
 *   `tierId` = 本档的档位标识（`tier` 声明了档位的声称句只由对应的那一次运行判）；
 *   `otherBaseline` = 另一档的基线常量值（那几处不归本档判）；
 *   `verboseCommand` = 报错里给的「看分布」命令（两档的尾巴不同）；
 *   `sources` = 自测注入的文档正文（给了就**只用它**，缺哪份就算读不到；生产路径不传，走 readFileSync）。
 * @returns {{errors: {kind: "unreadable" | "mismatch", text: string}[], judged: number, deferred: number,
 *   measuredTotal: number, measuredFiles: number}}
 *   `errors` 为空才允许 exit 0；`judged` / `deferred` 只用于自述（判了几处、几处归另一档）。
 */
function reconcileDocFileCounts({ errors, tierBaseline, tierId, tierName, otherBaseline, verboseCommand, sources }) {
  const out = [];
  let judged = 0;
  let deferred = 0;
  const measuredTotal = Array.isArray(errors) ? errors.length : NaN;
  const measuredFiles = Array.isArray(errors) ? new Set(errors.map((e) => e.file)).size : NaN;
  const verdict = () => ({ errors: out, judged, deferred, measuredTotal, measuredFiles });
  // 「读不到实测值」也是读不到真值：没有 M 就没有对账的右半边。
  if (!Number.isFinite(measuredFiles) || measuredFiles <= 0) {
    out.push({ kind: "unreadable", text: `读不到本次实测的带错文件数（${measuredFiles}）——没有真值就无法对账。`
      + "先确认 tsc 真的跑起来了（上面的陈旧声明守卫、入口、tsc 输出形状）。" });
    return verdict();
  }
  for (const doc of DOC_FILE_COUNT_CLAIMS) {
    let src;
    if (sources) {
      // 自测夹具：只认注入的那份，缺了就是读不到（**不回退**去读真实文档，否则「文档不在」这条用例永远测不到）。
      if (typeof sources[doc.rel] === "string") src = sources[doc.rel];
      else {
        out.push({ kind: "unreadable", text: `${doc.rel} 读不到（自测夹具里没有这份文档）——`
          + `「${doc.form}」这条声称句没法对账；读不到真值不等于没问题。` });
        continue;
      }
    } else {
      try {
        src = readFileSync(path.join(ROOT, doc.rel), "utf8");
      } catch (err) {
        out.push({ kind: "unreadable", text: `${doc.rel} 读不到（${err?.code ?? err?.message ?? err}）——`
          + `「${doc.form}」这条声称句没法对账；读不到真值不等于没问题。` });
        continue;
      }
    }
    const hits = [...src.matchAll(new RegExp(doc.re.source, doc.re.flags))];
    if (!hits.length) {
      out.push({ kind: "unreadable", text: `${doc.rel} 里一处「${doc.form}」都抽不到——该声称句被整句删了或改了形，`
        + `这条对账在这个文件已经失效（真值：本次实测 ${measuredTotal} 个错 / ${measuredFiles} 个文件，${tierName}）。`
        + "\n      要改句式就同步本脚本的 `DOC_FILE_COUNT_CLAIMS`（与 `docs-drift-check.mjs` 的 `BASELINE_CLAIM_RULES` 一起改），"
        + "别让规则静默空转。" });
      continue;
    }
    for (const hit of hits) {
      // 报错点名的是**那个数字所在的行**（`(27 files)` 与 `107 of them` 常常不在同一行）。
      const mStart = hit.indices.groups.m[0];
      const at = `${doc.rel}:${src.slice(0, mStart).split("\n").length}`;
      const claimedM = Number(hit.groups.m);
      const sentence = hit[0].replace(/\s+/g, " ").trim();
      if (doc.tier !== null) {
        if (doc.tier !== tierId) {
          // 另一档的句子：本档没有那一档的实测值（那要多跑一次 tsc，本单的红线是「不新增 tsc 运行」），
          // 交给那一档自己那一步判——CI 上两档都有步骤，所以它不会被漏掉。
          deferred += 1;
          continue;
        }
      } else {
        const claimedN = Number(hit.groups.n);
        if (claimedN === otherBaseline) {
          deferred += 1;
          continue;
        }
        if (claimedN !== tierBaseline) {
          out.push({ kind: "mismatch", text: `${at} 声称基线 ${claimedN} / ${claimedM} 个文件，但 ${claimedN} 既不等于本档`
            + `（${tierName}）的基线 ${tierBaseline}，也不等于另一档的 ${otherBaseline}——认不出这句属于哪一档，`
            + `文件数也就无从判定（「${sentence}」）。` });
          continue;
        }
      }
      judged += 1;
      if (claimedM !== measuredFiles) {
        const tierOfClaim = doc.tier === null ? "按句中的基线 N 认档" : `文档里这句声明属${doc.tier === "root" ? "包根" : "并集"}档`;
        out.push({ kind: "mismatch", text: `${at} 声称 **${claimedM} 个带错文件**，本次实测 **${measuredFiles} 个**`
          + `（${tierName}：${measuredTotal} 个错；${tierOfClaim}；「${sentence}」）。\n`
          + `      正解：① 先跑 \`${verboseCommand}\` 看每文件分布，确认这个文件数是**真的**`
          + "（新增错落在新文件里 / 有文件归零退出了错误集合）；"
          + `\n        ② 是真的就把文档里那个数改成 ${measuredFiles}（中英两处同形句一起改，中英成对）；`
          + "\n        ③ **不要**为了让这里变绿去改判据 / 基线常量 / 放宽 `--checkJs` 或 `--strict`——"
          + "棘轮只减不增，改判据只是把这条谎换个地方藏。\n"
          + "        ④ 也**不要**拿另一档的带错文件数来填本档：两档是两个数（本仓既有教训，见 `BASELINE_WITH_TOOLS` 那条注释）。" });
      }
    }
  }
  return verdict();
}

/**
 * 文档对账判据自己的反向证（issue #672 的验收 (e)：**实测来源被换成常量字面量 ⇒ 自测必须红**）。
 *
 * 为什么要有它：#672 之前这条对账只判「基线 **N** / M 个文件」一种形状，四处「M 个文件」声称写错也不红；
 * 而把 `measuredFiles` 换成字面量 `27` 会让判据在**今天**照样全绿（实测就是 27），直到 #669 把基线降下去
 * 的那天才突然红成一片。所以自测用**合成夹具**跑同一个 `reconcileDocFileCounts`：
 *   · 夹具的实测值是 **41 / 43 个文件**（不是真实树上的 27 / 29）——任何写死的 27 / 29 都会在第一条用例上红；
 *   · 两次运行用**不同的**实测值（41 / 43），证明 M 确实从 `errors` 现算，而不是从常量或某一份缓存里拿；
 *   · 历史值（218 / 75 / 46→7 / 45→9 / 其余 27 个带错文件 / 142 / 185 / 65 / 58 / 56）改成任意数仍必须绿。
 *
 * @returns {string[]} 失败用例（空数组 = 自测绿）
 */
function runDocClaimSelfTest() {
  const failures = [];
  const ok = (label, cond, detail) => {
    if (!cond) failures.push(`${label}${detail ? `（${detail}）` : ""}`);
  };

  /** 合成 errors：`n` 条错误分布在 `fileCount` 个文件上（两者分开，才能证明判的是文件数不是错误数）。 */
  const synthErrors = (n, fileCount) => Array.from({ length: n }, (_, i) => ({
    file: `src/f${i % fileCount}.js`, line: i + 1, col: 1, code: "TS2339", msg: "self-test",
  }));

  /**
   * 合成两份指令面文档：四处现状声称各一处 + 一批历史值（可逐项改数）。
   * 句式与真实文档**逐字同形**（只是把文件数换成 `enM` / `cnM`），否则自测证明不了生产正则还咬得住。
   */
  const synthDocs = ({ enM, cnM, history = {} }) => {
    const h = { was: 218, more: 75, first: 46, second: 45, other: 27, other2: 28, pair: "142 / 185", f65: 65, f58: 58, f56: 56, ...history };
    const en = [
      "- `--checkJs` ratchet rule (issue #214): `npm run check:types` does **not** aim for zero errors — 107 of them",
      `  (${enM} files) are accepted debt (the #214 measurement was ${h.was}; issue #177 knife 1 took one off`,
      "  `src/loop/orchestrator.js`; PR #249 took",
      `  ${h.more} more, **all of it in two files**: \`src/providers/openai.js\` ${h.first} → 7 and \`src/providers/anthropic.js\` ${h.second} → 9,`,
      `  the other ${h.other} error-carrying files moved by zero; issue #265's refactor took 21 more, again`,
      `  **all of it in one file**: \`src/store/notes.js\` 27 → 6, and the other ${h.other2} error-carrying files`,
      `  moving by zero — verified against the \`7354fab^\` tree exported with \`git archive\`, which reproduces`,
      `  ${h.pair} verbatim).`,
      "    `--checkJs` plus `src/index.js` already pulls the whole import graph — `--listFiles` prints how many files under",
      `    \`src/\` that one entry reaches (the number lives in that output; the ${h.f65} recorded on 2026-10-21, the ${h.f58} on`,
      `    2026-10-13 and the ${h.f56} before #265 are **historical values**),`,
      `    **${enM} of them carrying errors** — so picking "just the public entry" as`,
      // #635 ① 那一种形状（`基线 **N** / M files`）也放进夹具：并集档那一句在包根档那次运行里应当 deferred，
      // 在并集档那次运行里才是本档的声称句。不放进夹具的话，自测会因「一处都抽不到」而整片变红（那不是真问题）。
      `- the tools tier: baseline **142** / ${enM} files (two tiers are separate numbers).`,
    ].join("\n");
    const cn = [
      "- `--checkJs` 棘轮规则（issue #214）：`npm run check:types` **不追求清零**——107 个错（涉 " + cnM + " 个文件）是已接受的债（#214 首测是 " + h.was + "，issue #177 刀 1 给 `src/loop/orchestrator.js` 还掉 1 个；PR #249（即 #213 的两个 provider 工厂 JSDoc）又还掉 " + h.more + " 个，**全部落在那两个工厂文件**：`src/providers/openai.js` " + h.first + " → 7、`src/providers/anthropic.js` " + h.second + " → 9，其余 " + h.other + " 个带错文件一个没动；issue #265 把 `src/store/notes.js` 的端口语义抽进两个新模块后又还掉 21 个，**同样全部落在那一个文件**：`src/store/notes.js` 27 → 6，两个首行 `// @ts-check` 的新模块各自贡献 0 个，其余 " + h.other2 + " 个带错文件一个没动——逐文件对账用的是 `git archive` 取出的 `7354fab^` 对照树，它在同一条命令下逐字复现 " + h.pair + "）。",
      "    `src/index.js` 已经会把整张 import 图拉进来（`--listFiles` 打印单入口能到 `src/` 下多少个文件（这个数由那条命令打印、本文不抄；2026-10-21 记的 " + h.f65 + "、2026-10-13 记的 " + h.f58 + "、#265 之前的 " + h.f56 + " 都是**历史值**），其中 **" + cnM + " 个带错**），",
      "- 含 `./tools` 档：基线 **142** / " + cnM + " 个文件（两档是两个数）。",
    ].join("\n");
    return { "AGENTS.md": en, "AGENTS_cn.md": cn };
  };

  /** 生产口径的两档常量（只用于认档，**不是** M 的期望值；M 一律来自 `errors`）。 */
  const ROOT_BASELINE = 107;
  const WITH_TOOLS_BASELINE = 142;
  const run = ({ tier, errors, docs }) => reconcileDocFileCounts({
    errors,
    tierBaseline: tier === "root" ? ROOT_BASELINE : WITH_TOOLS_BASELINE,
    tierId: tier,
    tierName: tier === "root" ? "包根入口" : "含 ./tools 入口",
    otherBaseline: tier === "root" ? WITH_TOOLS_BASELINE : ROOT_BASELINE,
    verboseCommand: "node scripts/type-check-ratchet.mjs --verbose",
    sources: docs,
  });

  // ① 判据真的在判：41 个带错文件 + 四处都写 41 ⇒ 四处全判、0 错。
  const green41 = run({ tier: "root", errors: synthErrors(60, 41), docs: synthDocs({ enM: 41, cnM: 41 }) });
  ok("41 个文件 / 文档写 41 应当全绿", green41.errors.length === 0 && green41.judged === 4,
    `errors=${JSON.stringify(green41.errors)} judged=${green41.judged}`);
  ok("41 个文件 / 文档写 41 的实测值必须是现算的 41", green41.measuredFiles === 41, `measuredFiles=${green41.measuredFiles}`);

  // ② 防硬编码复活：换一个实测值（43 个文件），文档跟着写 43 也必须绿。
  //    任何把 measuredFiles 换成 27 / 29 这类字面量的改动，会让 ① 和 ② 至少一条红。
  const green43 = run({ tier: "root", errors: synthErrors(50, 43), docs: synthDocs({ enM: 43, cnM: 43 }) });
  ok("43 个文件 / 文档写 43 应当全绿（实测值换了，判据得跟着换）", green43.errors.length === 0 && green43.judged === 4,
    `errors=${JSON.stringify(green43.errors)}`);
  ok("43 个文件那次的实测值必须是 43", green43.measuredFiles === 43, `measuredFiles=${green43.measuredFiles}`);

  // ③ 判的是**带错文件数**，不是错误条数：60 条错分布在 3 个文件上 ⇒ 真值是 3。
  const fewFiles = run({ tier: "root", errors: synthErrors(60, 3), docs: synthDocs({ enM: 3, cnM: 3 }) });
  ok("60 条错 / 3 个文件时真值必须是 3（不是 60）", fewFiles.errors.length === 0 && fewFiles.measuredFiles === 3,
    `measuredFiles=${fewFiles.measuredFiles} errors=${JSON.stringify(fewFiles.errors)}`);

  // ④ 逐处判 + 中英各判各的：只改英文侧那两个数 ⇒ 恰好两条红（英文侧两处），且都不点名中文文档。
  const enOnly = run({ tier: "root", errors: synthErrors(60, 41), docs: synthDocs({ enM: 99, cnM: 41 }) });
  ok("只改英文侧 ⇒ 恰好两条红且都点名 AGENTS.md", enOnly.errors.length === 2
    && enOnly.errors.every((e) => e.text.includes("AGENTS.md:") && e.text.includes("99"))
    && !enOnly.errors.some((e) => e.text.includes("AGENTS_cn.md")), JSON.stringify(enOnly.errors));

  // ⑤ 反向：只改中文侧 ⇒ 恰好两条红，都点名 AGENTS_cn.md（中英独立判，不是「成对才红」）。
  const cnOnly = run({ tier: "root", errors: synthErrors(60, 41), docs: synthDocs({ enM: 41, cnM: 29 }) });
  ok("只改中文侧 ⇒ 恰好两条红且都点名 AGENTS_cn.md", cnOnly.errors.length === 2
    && cnOnly.errors.every((e) => e.text.includes("AGENTS_cn.md:") && e.text.includes("29"))
    && !cnOnly.errors.some((e) => e.text.includes("AGENTS.md:")), JSON.stringify(cnOnly.errors));

  // ⑥ 拿另一档的数顶本档：包根档写 29（并集档的带错文件数）⇒ 四处全红。
  const crossTier = run({ tier: "root", errors: synthErrors(60, 41), docs: synthDocs({ enM: 29, cnM: 29 }) });
  ok("包根档的句子写 29（另一档的数）⇒ 四处全红", crossTier.errors.length === 4, JSON.stringify(crossTier.errors));

  // ⑦ 两档分开判：并集档那次运行不判这四处（它们声明属包根档）⇒ 0 错、4 处 deferred；它只判自己那两句。
  const withToolsRun = run({ tier: "withTools", errors: synthErrors(50, 43), docs: synthDocs({ enM: 43, cnM: 43 }) });
  ok("并集档那次运行把这四处记成 deferred、不拿自己的 43 去判", withToolsRun.errors.length === 0
    && withToolsRun.judged === 2 && withToolsRun.deferred === 4, JSON.stringify(withToolsRun));

  // ⑧ 历史值改成任意数 ⇒ 仍绿（本单的放行证明：一刀切正则会在这里红）。
  const history = { was: 999, more: 999, first: 99, second: 99, other: 999, other2: 999, pair: "999 / 999", f65: 999, f58: 999, f56: 999 };
  const histGreen = run({ tier: "root", errors: synthErrors(60, 41), docs: synthDocs({ enM: 41, cnM: 41, history }) });
  ok("历史值（218 / 75 / 46→7 / 45→9 / 其余 27 / 142 / 185 / 65 / 58 / 56）改成任意数 ⇒ 仍绿",
    histGreen.errors.length === 0 && histGreen.judged === 4, JSON.stringify(histGreen.errors));

  // ⑨ 整句被删 ⇒ 读不到（exit 2 那一路），不是静默绿。
  const deleted = synthDocs({ enM: 41, cnM: 41 });
  deleted["AGENTS.md"] = deleted["AGENTS.md"].replace("(41 files)", "(files)");
  const deletedVerdict = run({ tier: "root", errors: synthErrors(60, 41), docs: deleted });
  ok("英文侧那句被删 ⇒ 一条 unreadable", deletedVerdict.errors.length === 1
    && deletedVerdict.errors[0].kind === "unreadable" && deletedVerdict.errors[0].text.includes("AGENTS.md"),
  JSON.stringify(deletedVerdict.errors));

  // ⑩ 文档不在 ⇒ 读不到（不因为「缺一份」而绿）。
  const missingCn = run({ tier: "root", errors: synthErrors(60, 41), docs: { "AGENTS.md": synthDocs({ enM: 41, cnM: 41 })["AGENTS.md"] } });
  ok("中文侧整份读不到 ⇒ 三条 unreadable 且都点名 AGENTS_cn.md", missingCn.errors.length === 3
    && missingCn.errors.every((e) => e.kind === "unreadable" && e.text.includes("AGENTS_cn.md")),
  JSON.stringify(missingCn.errors));

  // ⑪ 实测为空（没有带错文件）⇒ 读不到真值，不许当「文档也写 0 就绿」。
  const noMeasurement = run({ tier: "root", errors: [], docs: synthDocs({ enM: 0, cnM: 0 }) });
  ok("实测 0 个带错文件 ⇒ 一条 unreadable（读不到真值不等于没问题）", noMeasurement.errors.length === 1
    && noMeasurement.errors[0].kind === "unreadable", JSON.stringify(noMeasurement.errors));

  return failures;
}


/**
 * 把文档对账的结论落成退出码：**读不到真值 ⇒ exit 2**，**写错了 ⇒ exit 1**（#164 口径：读不到 ≠ 没问题）。
 *
 * @param {{errors: {kind: "unreadable" | "mismatch", text: string}[]}} verdict `reconcileDocFileCounts` 的返回值
 * @returns {void}
 */
function exitOnDocFileCountErrors(verdict) {
  const unreadable = verdict.errors.filter((e) => e.kind === "unreadable");
  const code = unreadable.length ? 2 : 1;
  console.error(
    "check:types: 失败 — 指令面文档的「带错文件数」声称与本次实测对不上"
    + "（issue #635 ① / #672：`基线 **N** / M 个文件`、`N of them (M files)`、`N 个错（涉 M 个文件）`、`**M of them carrying errors**`、`其中 **M 个带错**`；"
    + `${code === 2 ? "读不到真值" : "文档写错了"} ⇒ exit ${code}）：\n`
    + verdict.errors.map((e) => `  · ${e.text}`).join("\n"),
  );
  process.exit(code);
}

// ── 判据自己的反向证（#672 验收 (e)）：**无条件跑**，不靠「有人记得加 --self-test」────────
// 零 tsc 运行、毫秒级，所以直接搭在主路径上：自测红了就是判据自己坏了，先修它再看实测数。
// `--self-test` 只是把同一份自测单独跑一遍（不跑 tsc），方便反向证与排障。
const docClaimSelfTestFailures = runDocClaimSelfTest();
if (docClaimSelfTestFailures.length) {
  console.error(
    "check:types: 失败 — 文档对账判据的自测红了（判据自己坏了，先修它，别拿实测数去调）：\n"
    + docClaimSelfTestFailures.map((f) => `  · ${f}`).join("\n"),
  );
  process.exit(1);
}
if (SELF_TEST) {
  console.log("check:types: --self-test OK — 文档对账判据的反向证全绿（合成夹具：实测 41 / 43 个文件，未跑 tsc）");
  process.exit(0);
}

// ── strict 棘轮（issue #417）：同一张依赖图 + `--strict`，**参与 exit code** ────────────
// 放在陈旧声明守卫**之后**、非 strict 棘轮那次 tsc 之前：守卫已经在上面把 `src/**/*.d.ts` 在场的情形拦成
// exit 1，于是「strict 报 0」在这里只有一种含义（真的 0），不会混进「声明把实现遮住了」那种假绿。
if (STRICT) {
  const strictArgs = [...TSC_ARGS, ...STRICT_ONLY_ARGS];
  const strictRun = runTsc(STRICT_ONLY_ARGS);
  if (strictRun.error) {
    console.error(`check:types:strict — 启动 tsc 失败：${strictRun.error.message}`);
    process.exit(1);
  }
  const strictOutput = `${strictRun.stdout ?? ""}\n${strictRun.stderr ?? ""}`;
  const strictParsed = parseTscErrors(strictOutput);

  // 与棘轮同一条口径：**没解析到错误 + tsc 非 0 退出 = 跑都没跑成**，不是「strict 已经干净了」。
  if (strictParsed.errors.length === 0 && strictRun.status !== 0) {
    console.error(
      `check:types:strict — 失败 — tsc 退出码 ${strictRun.status}，但没解析到任何 \`error TS…\` 行`
      + "（不是「0 个 strict 错误」，是跑都没跑成）。\n"
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

  // `--print-count` 在**任何报告之前**就返回：脚本化下调基线时只要那个数（与非 strict 那条路同口径），
  // 也让「拿到的 stdout 就是一个数」这件事对调用方成立（否则 `Number(stdout)` 会得到 NaN）。
  if (PRINT_ONLY) {
    console.log(String(strictTotal));
    process.exit(0);
  }

  console.log(
    "check:types:strict — strict 棘轮（issue #417；与 `npm run check:types` **同一张依赖图**只多一个 `--strict`，**实测数参与退出码**）\n"
    + `  入口：${ENTRIES.join(" + ")}（${MODE}；输入文件、target、module 一字不改）\n`
    + `  tsc：typescript@${depVersion("typescript")} + @types/node@${depVersion("@types/node")}（devDependencies；与非 strict 棘轮是同一对）\n`
    + `  参数：${strictArgs.join(" ")}\n`
    + `  复现：node node_modules/typescript/bin/tsc ${strictArgs.join(" ")}\n`
    + `  基线：${STRICT_BASELINE} 个 strict 错误（${MODE}；常量 ${WITH_TOOLS ? "BASELINE_STRICT_WITH_TOOLS" : "BASELINE_STRICT_ROOT"}，`
    + "issue #417，2026-10-31 实测于基点 4840004；2026-11-01 两档同笔复测：包根 1894 未动，并集 2128 → 2124（−4 = f55eb8f 那一行 @returns 补 facts）；两档必须同一笔提交里一起测、一起降）\n"
    + `  对照：**非 strict 那一档是另一道棘轮**——\`npm run check:types\` 的基线是 ${BASELINE} 个 --checkJs 错误（${MODE}）；`
    + "两个总数不可互相比，也不许拿一档的数去下调另一档的基线。",
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
    console.log("  （要完整分布：加 --verbose；要单条定位：加 --show-errors N）");
  }
  if (SHOW_ERRORS > 0) {
    console.log(strictParsed.errors.slice(0, SHOW_ERRORS).map((e) => `  ${e.file}(${e.line},${e.col}): TS${e.code}: ${e.msg}`).join("\n"));
  }

  const strictDetail = () =>
    `\n  每文件：\n${strictFiles.map(([f, n]) => `    ${String(n).padStart(4)}  ${f}`).join("\n")}`
    + `\n  每错误码：${strictCodes.map(([c, n]) => `TS${c}×${n}`).join("、")}`;
  const strictSummary = `${strictTotal} 个 strict 错误 / ${strictFiles.length} 个文件`;

  // ⚠ 与非 strict 同口径的假绿防线：0 个错而基线 > 0 ⇒ 先怀疑**检查面失效**，不是「债还完了」。
  if (strictTotal === 0 && STRICT_BASELINE > 0) {
    console.error(
      `check:types:strict — 失败 — 实测 0 个 strict 错误，但基线是 ${STRICT_BASELINE}：一步清零几乎不可能，`
      + "先怀疑**检查面失效**而不是「债还完了」。\n"
      + "  依次排查：① `src/` 下是否残留 `.d.ts` 生成物（上面的共用守卫会先拦）；② 入口文件是否还在（当前入口："
      + ENTRIES.join(", ") + "）；③ tsc 输出形状是否变了（看上面的告警）。\n"
      + "  确认真的清零了：把本脚本的 `BASELINE_STRICT_ROOT` / `BASELINE_STRICT_WITH_TOOLS` 一起改成 0（那时这条守卫自动解除）。",
    );
    process.exit(1);
  }

  if (strictTotal > STRICT_BASELINE) {
    // 棘轮变红：strict 那一档新增了错。点名「多在哪」，而不是只喊数字。
    const top = strictFiles.slice(0, 5).map(([f, n]) => `${f} ${n}`).join("、");
    console.error(
      `check:types:strict — 失败 — 实测 ${strictSummary}${strictDetail()}\n`
      + `  基线 ${STRICT_BASELINE}（issue #417 棘轮，${MODE}），**超出 ${strictTotal - STRICT_BASELINE} 个**。\n`
      + `  最多的文件：${top}\n`
      + "  怎么修：\n"
      + "    · 定位新错：`node scripts/type-check-ratchet.mjs --strict --show-errors 40`；或改动前后各跑一次 `--strict --verbose` 对比每文件计数；\n"
      + "    · 首选**减掉它**（补 JSDoc 类型；#213 R4 记录过两种会**静默**把参数退化成 `any` 的 JSDoc 形状）；\n"
      + "    · **不要**为了变绿去调高基线常量：strict 那笔存量债由 #417 按文件切片还，新增必须当场清；\n"
      + `    确需上调时把 ${STRICT_BASELINE} 改成 ${strictTotal}，并在提交信息里写清是谁的哪批改动、为什么本轮不还。`,
    );
    process.exit(1);
  }

  if (strictTotal < STRICT_BASELINE) {
    console.log(
      `check:types:strict: OK — 实测 ${strictSummary}（${MODE}），比基线 ${STRICT_BASELINE} **少 ${STRICT_BASELINE - strictTotal} 个**。\n`
      + `  基线可下调至 ${strictTotal}：改 scripts/type-check-ratchet.mjs 的 \`BASELINE_STRICT_ROOT\` / \`BASELINE_STRICT_WITH_TOOLS\`\n`
      + "  并单独提交（两档同一笔提交里一起测、一起降；棘轮只减不增，别把这次收益丢掉）。",
    );
    process.exit(0);
  }

  console.log(`check:types:strict: OK — 实测 ${strictSummary}（${MODE}），等于基线 ${STRICT_BASELINE}（issue #417 棘轮：只减不增）。`);
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

// ── 文档对账（issue #635 ①）：棘轮绿了之后，指令面文档里那句「基线 **N** / M 个文件」的 M 也得是真值 ──
// 放在棘轮判定**之后**、两条绿路之前：棘轮红时先报它自己那笔债（新增错，那条信息更能定位改动），
// 而文档那一维的谎**一例都不许过 exit 0**。放在 `--print-count` 之后是为了让那一步的 stdout 仍然只是一个数。
const otherTierCommand = WITH_TOOLS ? "npm run check:types" : "npm run check:types -- --with-tools";
const docVerdict = reconcileDocFileCounts({
  errors,
  tierBaseline: BASELINE,
  tierId: WITH_TOOLS ? "withTools" : "root",
  tierName: MODE,
  otherBaseline: WITH_TOOLS ? BASELINE_ROOT : BASELINE_WITH_TOOLS,
  verboseCommand: `node scripts/type-check-ratchet.mjs --verbose${WITH_TOOLS ? " --with-tools" : ""}`,
});
if (docVerdict.errors.length) exitOnDocFileCountErrors(docVerdict);
console.log(
  docVerdict.judged > 0
    ? `check:types: 文档对账 OK — ${docVerdict.judged} 处「带错文件数」声称句的 M 都等于本次实测的 `
      + `${docVerdict.measuredFiles} 个带错文件（${MODE}）`
      + (docVerdict.deferred > 0 ? `；另 ${docVerdict.deferred} 处属另一档，由 \`${otherTierCommand}\` 判` : "")
    : `check:types: 文档对账 — 本档（${MODE}）没有「带错文件数」声称句；`
      + `${docVerdict.deferred} 处属另一档，由 \`${otherTierCommand}\` 判`,
);

if (total < BASELINE) {
  console.log(
    `check:types: OK — 实测 ${summary}（${MODE}），比基线 ${BASELINE} **少 ${BASELINE - total} 个**。\n`
    + `  基线可下调至 ${total}：改 scripts/type-check-ratchet.mjs 的常量并单独提交（棘轮只减不增，别把这次收益丢掉）。`,
  );
  process.exit(0);
}

console.log(`check:types: OK — 实测 ${summary}（${MODE}），等于基线 ${BASELINE}（issue #214 棘轮：只减不增）。`);
