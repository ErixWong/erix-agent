#!/usr/bin/env node
// docs-drift-check.mjs — 文档事实漂移检查（issue #164；零依赖，仅 node: 内置）
//
// 背景：独立审计（#164）证明 README/requirements 会点状腐坏——版本号停在 0.9.0、
// stallDetection 默认模式写成 appear、模块地图漏了 src/display/、requirements 的
// 「当前版本」停在 0.8.0。这类漂移不影响测试变红，却会直接把宿主引导到错误默认值上。
// 本脚本把「文档说的 == 代码/清单里真实的那份」钉成可执行检查。
//
// 检查面（issue #164 的「数值层」。判据层——升级指南里的参考 SQL/谓词 sketch 必须与运行时同
// 判据——本轮仍只纳入人工检查清单，中期归 #158 三层可执行验证扩面）：
//   1. version    中英 README 与 docs/requirements 的「当前版本」声明必须 == package.json；
//                 文中出现的任何版本号都不得高于 package.json（不得把没发布的东西写成事实）
//   2. defaults   关键默认值白名单（stall 窗口与模式、maxRounds、TTL 与折叠阈值、judge
//                 interval/timeout/failureLimit、退避、reflection 门槛、notes 保留期…）逐条从
//                 源码参数默认值里抽真值，再要求中英文档同口径
//   3. pkg-block  README 引用的 files/exports JSON 围栏必须与 package.json **双向对称**
//                 （issue #210：缺键/多键/改名/写重都红，并点名差在哪个键）；
//                 test/contract/index.js 再导出的套件必须真的在 npm files 白名单里
//   4. modulemap  src/ 下每个 .js 都必须出现在中英 README 的模块地图里
//   5. paths      中英 README + 中英契约 + `examples/pi-extension/README.md` + 中英 AGENTS 里引用的
//                 仓库内路径，以及 `node <file>` / `npm run <script>` 命令，必须存在（issue #273：
//                 覆盖面从「两个根 README」扩到「宿主/使用者真的会照着找文件的那批入口文档」）。
//                 解析按 仓库根 → 文档同目录 → 唯一同名文件 三级；解析不到的按**四类**裁决（见下方
//                 「引用裁决分类」），**没一个能整目录/整前缀豁免**
//   6. skeleton   中英 README 标题数量与层级骨架必须一致（做法参考 docs-sync-check.mjs，更轻）；
//                 `AGENTS.md` / `AGENTS_cn.md` 这一对同样纳入（issue #274 附带项）
//   7. anchors    「清单/枚举/单位」类锚点升级为**逐处一致 + 双向对称**（issue #210 R1）：
//                 文件工具清单、CLI 工具清单、vendor 跳过目录、formatSize 单位档位与它的
//                 示例映射、内置压缩策略名——每一处声明单独与源码真值比，另加中英声明点处数对账
//   8. markers    marker **字面量**同源（issue #272）：契约中英引用的 `toolMarker("readMoreLines")`
//                 输出串，必须逐字等于从 `src/tools/file-tools.js` 的模板 + `NEXT_STEP_CLAUSE` 渲染
//                 出来的那份（文档占位符 `N`/`M`/`K`/`<size>` 与插值表达式的对应表就写在规则里，
//                 模板里出现**未登记的插值**会直接红）；逐处比对，另加中英引用处数对账
//   9. baseline   `AGENTS*.md` 与冷层 command-reference 里声称的 `--checkJs` 棘轮**当前值**（issue #274）：与
//                 `scripts/type-check-ratchet.mjs` 的 `BASELINE_ROOT` / `BASELINE_WITH_TOOLS` 逐处比，
//                 额外核「`164 = 121 + 27 + 16`」这类分解式的算术闭合（首项必须 = 包根基线、
//                 总和必须 = 并集基线），中英句式处数成对
//  10. toolfact   工具事实契约面（工单 261014 T1，#284 / #285）：契约中英里声明 `erix` 字段
//                 归属的**五个声明面**（散文清单、字段归属表、「恰好 N 个字段」数量声明、
//                 存在性矩阵表头、legacy 别名表）逐面与 `src/tool-fact.js` 导出的
//                 `TOOL_RESULT_CONTRACT` **双向**比成员；命名空间名（engine.ns / host.ns）、
//                 协议必需/条件字段、别名的新归属同属真值；每面另加中英声明点处数对账。
//                 这一条就是「同一个事实第三处自说自话」的防线：字段改名/新增/退役不再
//                 只红契约测试，文档也会同时红
//  11. symbols    符号锚点（issue #286 T-a）：文档里「符号 + 文件」形态的引用（`` `SYM`（`src/x.js`） `` 与
//                 markdown 链接两种形态）必须能在被引文件里抽到该符号的**声明**。支持的声明形态：
//                 `function` / `class` / `const|let|var` 绑定 / 解构绑定 / 再导出 / 方法 / 对象键与类字段 /
//                 `process.env.X` 环境变量读取处。逐处校（每一处单独比），找不到就红并点名该文件里**实际存在的
//                 相近符号名**（前缀 / 子串 / 编辑距离 ≤2）；一个文件里连一条声明都抽不到同样算红
//                 （#164「抽不到真值就报错」）。**只认代码面**（issue #299）：抽取前先做一遍词法分类，注释与字符串
//                 字面量涂成空格（保换行 ⇒ 行号与原文对齐），所以只活在注释里或引号里的名字**不算**声明，
//                 注释里写一句 `// "judge_done"` 也不再给弱档供值。唯一的弱一档——「具名字面量成员」（终止原因 / provider 错误码
//                 这类**字符串值**）——只在 `SYMBOL_VALUE_MEMBERSHIP` 里逐份点名并写明理由的 5 个文件生效，
//                 不做全仓放行。本条**不做**中英处数对账，理由写在 §2.8 的节头。
//                 另带一条**只增不减的下限** `SYMBOL_ANCHOR_MIN_UNIQUE`（现值只住在下面那行常量里，
//                 本文不抄读数——历史上这里曾写过一个已作废的旧值，与常量对不上）：低于它就红（那是「锚点在退化」
//                 被抓，不是棘轮抬高），高于它会催你把下限抬上去。生效值从脚本自身文本读，自测靠调它证锁。
//                 每一次抬高下限的实测流水（哪次合并、在哪棵树上量的、多少组多少处）已整条搬到
//                 `docs/maintenance/symbol-anchor-ledger.md`（历史类文档）；本文不再复述任何历史读数，
//                 现值一律跑 `--verbose`。裸行号棘轮的唯一键不含文档自己的行号 ⇒ 「把符号锚点退化成裸行号」
//                 在棘轮那一侧一字不变，只有这条下限会红（#286 T-a 返工 R1）。
//  12. bare-lines 裸行号棘轮（issue #286 T-a）：`src/**.js:N` / `:N-M` 形态的引用按唯一
//                 (文档, 目标文件, 行区间) 计数，**只减不增**：基线 `BARE_LINE_REF_BASELINE = 6`（现值；
//                 80 / 130 / 142 / 232 / 244 是 #286 T-b2、PR #451、#326 B1 删区间、#286 T-b1a 与 T-a 落地时的
//                 旧值，别把历史数当现值），超了红
//                 （并提示「可以把基线降到 N」），低于基线算过但会催你降。**越界行号是 error**，不是观察项。
//                 覆盖面 = 宿主会读的那批文档（清单 = `SYMBOL_DOCS_STATIC` + 按目录实扫的指南；份数别在这里抄，
//                 跑 `--verbose` 看 note）。
//                 正则 `src\/[A-Za-z0-9_./-]+\.js:(\d+)(?:-(\d+))?`；#286 T-a 落地时该口径实测 248 唯一区间 /
//                 279 次出现，减去 `BARE_LINE_EXEMPTIONS` 的 4 处示例/外仓路径 ⇒ 当时基线 244（**历史值**；
//                 现值一律跑 `--verbose` 复核，别只信注释）。
//                 覆盖面本身有下限 `REF_SCAN_DOCS_MINIMUM`（现值见常量本身，别在注释里抄一份）：按目录实扫意味着
//                 「把某份指南改名到不匹配模式」会让脚本与测试侧一起少一份而数字仍相等 ⇒ 静默缩面，这条下限与
//                 测试侧硬编码的清单就是那道报警（#286 T-a R2）。文档里写着的「点名几份 + 实扫几份 = 下限」也
//                 由 `collectRefScanCountClaimErrors()` 逐格对账（#635 ①）：抄错一格就红并点名是哪份的哪个数。
//                 豁免是**三信号 AND**（① 表里点名这一条 ② 引用行含那个占位路径 ③ 同一行有就地声明词）：
//                 评审 R4 把从前的整行 OR 收紧——同一行只剩一句 `for example` 之类的附带措辞不算声明。
//                 条目自己还要过配置校 `bareLineExemptionEntryErrors()`：声明词若能匹配空串（这一侧恒真）
//                 或带 g/y 标志（`.test()` 有状态、判据不可复现）就是错误。同一家族口径沿用 #286 已落在
//                 `test/static-guards.test.js` 的 `LOCAL_ARCHIVE_DIRS` + `LOCAL_ARCHIVE_DECLARATION`，
//                 条目没被任何引用用到就红。
//                 越界之外还管**下界**（行号必须 ≥ 1：`path:0` 在越界判据里永远不算越界 = 免检口）与
//                 **目标文件不存在**（从前是 continue 静默跳过，现在一律红，只有上面 4 条登记过的示例/外仓
//                 路径例外）——评审 R3 的两条。
//                 `CHANGELOG.md` **不进棘轮面**：历史条目写的是**当时**那份代码的行号，改掉等于伪造历史
//                 （与 #278 对简称「只登记不改写」同口径）；那些行号仍由 `paths` 校文件存在性，只是不进这个数。
//
//  13. cli-flags CLI 旗标清单（issue #391 R4）：`bin/cli.js` 帮助文本里 `erix chat …` / `erix repl …`
//                 两条 usage 行的旗标集合，与 `README.md` / `README_cn.md` 的 usage 行**双向逐处**对账
//                 （README 少一个红、多一个红、改名红，错误点名旗标 + 文档 + 命令）。别名（`-c|--continue`、
//                 `-r`、`--no-final-guard`）一律计入。现场：`--require-deliverable` 进了帮助文本、契约、
//                 升级指南，两份 README 的 usage 行一个都没写，而所有门禁一路绿。放行口
//                 `CLI_FLAG_EXEMPTIONS` 现在为空，且条目空转即红（#210 R2 惯例）。
//  14. doc-version 指南自述版本（issue #511 判据 1 前半）：每份 `docs/host-upgrade-guide-<X.Y.Z>[_cn].md`
//                 的**第一行**必须是 `<!-- doc-version: X.Y.Z -->`，且与文件名同源；非 semver 命名的历史指南
//                 （`v030` 两份）在 `DOC_VERSION_EXEMPT` 里逐条登记并写理由，条目空转即红。
//                 为什么要有这一行：没有「这份文件记录的是哪个版本」这个真值，下面几条都无从判定。
//  15. version-attribution 版本归属句（判据 1 后半）：指南里「<verB> adds / removes / 删掉 / 新增」类句式
//                 里的 `verB` 若 **> 自述版本**（= 在讲**后面那个版本**的事），同一句必须带前向指针
//                 `see the <verB> upgrade guide` / 「见 <verB> 升级指南」，否则红并点名行号。
//                 只咬这一侧的理由（向后引用靠判据 2 的树作证、早期版本没有指南可指）写在 §15 节头。
//  16. guide-claim 指南里的「树 / CHANGELOG」声称（判据 2）：(a) 「没有/删掉了 `config.*`」⇒ 该路径必须
//                 确实不在 `CONFIG_NAMESPACE_SCHEMA` 里（删除是单调的，今天的树就是证人）；(b) 「`config.*`
//                 是 V 加的」⇒ 必须出现在 CHANGELOG 的 V 段（未发布版并入下一个已发布段）；
//                 (c) 「N 个分组 / N 个叶子」只在**自述版本 == package.json** 的那份指南上校（老指南的数是当时
//                 为真的历史）。
//  17. changelog-published CHANGELOG 版本段的发布态（判据 3）：带日期的版本段若**不在 registry 的
//                 `versions` 列表**里，必须在段首标「（未发布 / unpublished）」；反向也看守（已发布却自称未发布红）。
//  17b. changelog-date 段首日期是事实，不是占位（issue #697）：(a) **正在准备的那一段**（版本序最高的版本段）
//                 标了「未发布」就不许带发布日期——发布日期是「发布这件事」的产物（合法形状
//                 `## [X.Y.Z]（未发布 / unpublished）`）；历史段不受此限（0.24.0 / 0.21.0 / 0.12.0 / 0.8.0 是
//                 「带日期 + 正文标未发布」的历史记录，改它们等于改历史事实）。(b) **已发布段**的日期必须与
//                 `vX.Y.Z` tag 的日期同一天（UTC+8 本地日历日；附注 tag 取 tagger date，轻量 tag 取所指提交的
//                 author date），不一致 ⇒ 红并点名两个日期。**registry 说已发布但没有 tag ⇒ exit 2 未判定
//                 （`TAG_MISSING`）而不是红**：`release:day` 的 writeback 先翻标记（并写日期）、finalize 之后才
//                 打 tag，那一刻判红等于让它自己那次 `check:docs` 把 writeback 判死。`TAG_MISSING` 只咬 registry
//                 的 `latest`——本仓 31 个已发布版本里只有 11 个有 tag（打 tag 是 0.14.0 之后才零星开始的），
//                 对每个已发布段都要求 tag ⇒ 这条闸会永久 exit 2（= 没有闸）。更早的已发布段**有 tag 才判**。
//  18. published-claim 「本仓版本」与「发布行」两类声称句各对各自的真值（issue #511 评论）：前者对
//                 `package.json`，后者对 registry 的 `dist-tags.latest`；两类句子都不许带测量日期/「实测」
//                 （日期自己不会过期，留着它就是给「过期」留一个合法位置）。全文扫描还看守
//                 「`dist-tags.latest` 后面紧跟的版本号」与「X 从未发布」两形状。
//                 registry 取不到（离线 / 无缓存）⇒ **降级为告警**并打印原因与来源，不判红（与 `check:cli:model-e2e`
//                 的闸门分类同一口径：网络不可得不是文档漂移）；`--offline` 直接不读 registry；
//                 `--registry-json <file>`（issue #703）把这份事实换成一个**探针桩**（只给合成树用，读不出 = exit 2，
//                 CI 不传 ⇒ 生产口径不变）。
//  19. unchanged-surface 「不变」那一节 × 本版 CHANGELOG 的字段真值（issue #690）：本版 CHANGELOG 段里被
//                 声明**变更**（不是纯加法）的字段名落到六格（选项 / 默认值 / 观察者事件 / 诊断字段 /
//                 磁盘格式 / 终局载荷）中的哪一格，指南那一格就**不许**写「不变」，红时点名
//                 `文件:行 + 字段名 + 格名`；本版没有变更证据的格子写「不变」保持绿（反向不许逼文档造条目）。
//                 **中英各判一次**（一侧被整句删掉红在缺的那一侧）；六格的成员判据从源码现算、不抄名单。
//                 **读不出 = 红，且是 exit 2**（§4 找不到 / 本版 CHANGELOG 段读不到 / 段里有反引号字段名
//                 而解析为空）——与「文档与真值打架」的 exit 1 分开，别让「闸自己坏了」混进文档漂移里。
//                 与相邻闸的分工：**#687 管「指南称已删 ↔ 运行时导出」**（这个名字还在不在），
//                 **本条管「指南称不变 ↔ 本版真值」**（这一版字段动没动），既有 `defaults` / `files` /
//                 `exports` / 符号锚点是「文档字面量 ↔ 源码字面量」——三条互不重叠，别合并成一条模糊判据。
//
// 锚点粒度（issue #210 R3：**别把「存在性」锚点误当成「文档里删一处提及就会红」**）：
//   · 存在性（每档被检查文档至少命中一次即可；同一句里删掉额外一处提及不会红）：
//       defaults 的全部条目（`must` 是「文档里存在这个正则」，`mustNot` 才是逐处的）、
//       modulemap（只查 src→文档 方向：地图多写文件不会红）、paths（只查文档→仓库 方向）
//   · 逐处一致（每一处声明都单独比，缺/多/改名/写重都红）：
//       version 的「当前版本」声明与「不得高于 package.json」的全量版本号扫描、
//       pkg-block 的 files/exports（双向对称）、anchors 的清单/枚举/单位规则、
//       markers 的 marker 字面量（#272）、baseline 的棘轮当前值（#274）、
//       toolfact 的五个字段声明面（工单 261014，与 TOOL_RESULT_CONTRACT 双向对称）、
//       symbols 的「符号 + 文件」锚点（#286 T-a：每一处都要在被引文件里抽到该符号的声明）、
//       cli-flags 的旗标清单（#391 R4：帮助文本 ⇄ 两份 README 的 usage 行双向逐处，缺/多/改名都红）
//   · 只减不增的棘轮（比的是「还剩多少」：新增即红，变少则必须降基线并写理由）：
//       bare-lines 的裸行号引用数（#286 T-a 起，现基线 232，与 `check:types` 的 BASELINE_ROOT 同构）
//   · 中英对账（比的是处数与数量级）：skeleton 的标题数与层级序列（README **与** AGENTS 两对）、
//       anchors 的声明点处数、markers 的引用处数、baseline 的句式处数、
//       toolfact 每一面的声明点处数
//   未升级成逐处一致的条目，理由逐条写在对应规则的注释里（#210「不能机械化的写明为什么」）：
//   数值型 defaults 条目在文档里的句式是散文级的多种写法，强行套「声明句式正则」会把门禁
//   变成对措辞的绑架（改一次措辞就红，且红了也不知道是真漂移还是措辞漂移）；它们的
//   「文档必须与真值同口径」仍由 must/mustNot 钉住，只是「删掉一处额外提及」不红。

// 严重级与 #158 三层验证「先告警后阻塞」同口径：
//   - error（默认 exit 1）：会直接把宿主引导错的——当前版本声明、默认值、路径/命令、
//     files/exports 清单、模块地图、中英骨架、引用了高于 package.json 的版本。
//   - warn（默认 exit 0，`--strict` 升级为 error）：只表示「文档没跟上」的滞后信号——
//     版本历史最高条目落后于 package.json、requirements 阶段表 current 行落后、
//     `test/contract/index.js` 再导出的套件未进 npm `files`。
//
// 用法：
//   node scripts/docs-drift-check.mjs              # error 才阻塞
//   node scripts/docs-drift-check.mjs --strict     # warn 也阻塞
//   node scripts/docs-drift-check.mjs --verbose    # 打印每条规则的实测值与检查面
//   node scripts/docs-drift-check.mjs --self-test  # 把 #210 每条清单/单位锚点的反向证固化在脚本里：
//                                                  # 内存改文档一处 / 内存改源码一处 / 都不改，
//                                                  # 断言「改→红、不改→绿」；变异没落上去也算失败
//   node scripts/docs-drift-check.mjs --offline    # 不读 registry（#511 的发布态/发布行判据降级为跳过）：
//                                                  # 给「无网但要跑全量门禁」的场景用，会把降级原因打进输出
//   node scripts/docs-drift-check.mjs --registry-json <file>
//                                                  # issue #703：把 registry 事实换成一个**桩**（`{"latest":…, "versions":[…]}`），
//                                                  # 给合成树表达「这一版已发布」这种还没发生的态（`npm run check:version-states`）；
//                                                  # 桩读不出 / 形状不对 = exit 2（不是跳过）；CI 的 check:docs 不传它
//   node scripts/docs-drift-check.mjs --sync --published <x.y.z> [--version <x.y.z>]
//        [--published-date <YYYY-MM-DD>] [--root <dir>]
//                                                  # **发布态回写**（issue #689，本脚本唯一的写盘模式）：
//                                                  # 只改发布态那几句——README / requirements 的当前版本句、
//                                                  # 两份 AGENTS 的「本仓版本」与「发布行」、CHANGELOG 当前版本段
//                                                  # 段首那一行（「未发布」标记 **与日期**，issue #697：标记与日期
//                                                  # 是同一件事的两半，分开写就会一半新一半旧；`--published-date`
//                                                  # 缺省 = 当天 UTC+8）；其余字节一字不动。版本号取自
//                                                  # `package.json`，发布行由 `--published` 给（CI 上没有 registry，
//                                                  # 离线自测不许联网）；**不给 `--published` ⇒ exit 2 且 0 字节写入**。
//                                                  # `--root` 只给 `--sync` 用（合成树 / 自测）。

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 14b（0.30 破坏包逐名表）的真值来源：**不抄名单**，走与 `npm run check:exports:deprecated` 同一套函数。
// 那两个脚本都带 `process.argv[1] === 本文件` 的 main 守卫，import 它们不跑 CLI；清点逻辑（`computeInventory`）
// 与登记解析（`verify`）各只有一份，这正是 issue #429 修掉的口径漏洞（第二份名单 = 第二条漂移路径）。
import {
  NEXT_BREAKING_VERSION,
  adjacentDeclaration,
  deprecatedTagText,
  jsdocBlocks,
  verify as verifyDeprecatedExports,
} from "./deprecated-export-check.mjs";
import {
  buildRecords as buildExportRecords,
  computeInventory as computeExportInventory,
  hostContractNames,
  resolveEntries as resolveExportEntries,
} from "./export-consumer-check.mjs";
// issue #772 R3：两轴载荷表的锚点登记表（14 格 × 两轴，39 条）住在 `scripts/cell-axes-anchors.mjs`，
// 闸与 `test/contract-snapshot-cell-axes-767.test.js` **import 同一份**——豁免是闸发的，锚点也必须住在
// 闸够得着的地方（R2 把它放在测试里 ⇒ 只有 `node --test` 会重算行号、`npm run check:docs` 看不见）。
// issue #772 R4：同一份里还多了两条硬判据——`anchorKindError()`（锚点「种类」：代码行 vs 注释行，M-A）
// 与 `checkCellAxesCoverage()` + `CELL_AXES_REQUIRED_CELLS()`（与登记表无关的覆盖面人审清单，M-B）：
// 两边都只 import、不再自己写一遍口径。
import {
  CELL_AXES_ANCHORS as CELL_AXES_ANCHORS_SHIPPED,
  CELL_AXES_ANCHOR_MODULE,
  CELL_AXES_ANCHOR_FLOORS,
  CELL_AXES_REQUIRED_CELLS,
  anchorGroupKey as cellAxesAnchorGroupKey,
  anchorHitLines as cellAxesAnchorHitLines,
  anchorKindError as cellAxesAnchorKindError,
  anchorLineIsComment as cellAxesAnchorLineIsComment,
  anchorLinesEqual as cellAxesAnchorLinesEqual,
  anchorTableShape as cellAxesAnchorTableShape,
  checkCellAxesCoverage as cellAxesCheckCoverage,
  parseCellAxesAnchorTable as cellAxesParseAnchorTable,
} from "./cell-axes-anchors.mjs";
// 逐名表的**读法**（几格 / 第一格长什么样 / 入口列认哪几种写法 / 版本号从哪来）住在共享模块里：
// `scripts/host-consumer-probe.mjs` 的覆盖判据读的是同一张表，各读各的 = 两条会各自漂移的真相。
// issue #731 N4：CHANGELOG 的「版本节标题 / 段首日期」口径与 `scripts/release-day.mjs` **共享一份**
// （此前这里是 `^## \[(\d+\.\d+\.\d+)\](.*)$` + 日期正则的**字面拷贝**，而 release-day 那一侧容忍多空格
// ⇒ `##  [0.31.0]` 两个读者两个答案）。口径与「为什么取严格单空格」的理由住在 `scripts/changelog-heading.mjs`。
import { CHANGELOG_DATED_HEADING_SUFFIX, changelogHeadingIsDated, matchChangelogVersionHeading } from "./changelog-heading.mjs";
import {
  BUNDLE_GUIDE_CN,
  BUNDLE_GUIDE_DOCS,
  BUNDLE_GUIDE_EN,
  BUNDLE_GUIDE_VERSION,
  bundleEntryClaim,
  bundleRowsFromText,
} from "./bundle-guide-table.mjs";

/** `--sync`（issue #689）：**发布态回写**。它是本脚本唯一的写盘模式，且只写 `RELEASE_STATE_TARGETS`
 *  列出的那几处发布态句子（见下方那张表的节头）。判据模式一个字节都不写。 */
const SYNC = process.argv.includes("--sync");
/** `--root <dir>`：**只给 `--sync` 用**（合成树自测 / 回写到别的检出）。判据模式永远跑在本仓根上：
 *  让 `--root` 能改判据的检查面，等于给「换一棵树就能绿」留一个口子。 */
const ROOT_ARG = (() => {
  const i = process.argv.indexOf("--root");
  if (i >= 0) return process.argv[i + 1] ?? "";
  const eq = process.argv.find((a) => a.startsWith("--root="));
  return eq ? eq.slice("--root=".length) : null;
})();
if (ROOT_ARG !== null && !SYNC) {
  console.error("docs-drift-check: `--root` 只和 `--sync` 一起用（判据永远跑在本仓根上，不许指到别的树）");
  process.exit(2);
}
const ROOT = ROOT_ARG !== null ? path.resolve(ROOT_ARG) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");
const VERBOSE = process.argv.includes("--verbose");

const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const PKG_VERSION = PKG.version;
/** `--self-test` 要连 package.json 一侧的改动一起测，所以清单真值走这个口子（有内存副本就用副本）。 */
function pkgNow() {
  const overlay = OVERLAY.get("package.json");
  return overlay ? JSON.parse(overlay) : PKG;
}

const README_EN = "README.md";
const README_CN = "README_cn.md";
const REQ_EN = "docs/requirements.md";
const REQ_CN = "docs/requirements_cn.md";
const CONTRACT_EN = "docs/host-consumer-contract.md";
const CONTRACT_CN = "docs/host-consumer-contract_cn.md";
const AGENTS_EN = "AGENTS.md";
const AGENTS_CN = "AGENTS_cn.md";
const CMDREF_EN = "docs/maintenance/command-reference.md";
const CMDREF_CN = "docs/maintenance/command-reference_cn.md";
const PI_EXT_README = "examples/pi-extension/README.md";
const ARCH_EN = "docs/architecture.md";
const ARCH_CN = "docs/architecture_cn.md";
const CHARTS_EN = "docs/charts.md";
const CHARTS_CN = "docs/charts_cn.md";
/** issue #644 ③：符号锚点声称链的新家（历史类文档，`retired-spelling-scan.mjs` 按路径把它归成 history）。
 *  它同时在锚点面内（见 `SYMBOL_DOCS_STATIC`）：搬动不能让 (符号, 文件) 组数掉下去。 */
const LEDGER_EN = "docs/maintenance/symbol-anchor-ledger.md";
const LEDGER_CN = "docs/maintenance/symbol-anchor-ledger_cn.md";
const RATCHET_SRC = "scripts/type-check-ratchet.mjs";
/** 工具事实契约常量的真值出处（工单 261014 T1）。 */
const TOOL_FACT_SRC = "src/tool-fact.js";

function read(rel) {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

const errors = [];
const warnings = [];
const checked = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
const note = (msg) => checked.push(msg);

/** 行内代码形式的值（`8`）；数字里的 `_` 分隔符（30_000）会被归一。 */
const bt = (v) => {
  const s = String(v);
  const norm = /^[\d_]+$/.test(s) ? s.replace(/_/g, "") : s;
  return "`" + norm + "`";
};
/** 把文档需要引用的字面量转成正则片段。 */
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 语义化版本比较：a<b → -1，a==b → 0，a>b → 1。 */
function cmpSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** **退出码的唯一来源**（issue #697，沿用 #575 的纪律）：主路径与 `--self-test` 读同一份，
 *  所以「未判定 ⇒ exit 2、不是红（exit 1）」在自测里是可证的，而不是靠读代码相信。
 *  优先级：真值缺位 / 未判定（2）> 漂移（1）> 绿（0）——「闸自己没真值」不能长得和「文档写错了」一样。
 *
 * @param {{errors?: string[], warnings?: string[], readFailures?: string[], notJudged?: unknown[], strict?: boolean}} [facts]
 * @returns {0|1|2}
 */
function docsDriftExitCode({ errors = [], warnings = [], readFailures = [], notJudged = [], strict = false } = {}) {
  if (readFailures.length || notJudged.length) return 2;
  if (errors.length || (strict && warnings.length)) return 1;
  return 0;
}

// ── 1. 版本声明 ───────────────────────────────────────────────────────────────
// 「当前版本」的规范写法（新增/改写文档时请沿用，否则等于绕过检查）：
//   README.md     Current release: **vX.Y.Z**
//   README_cn.md  当前发布版本：**vX.Y.Z**
//   requirements  "…shipped in version X.Y.Z" / "package version X.Y.Z"
//                 「与 X.Y.Z 版本交付的实现」「package 版本 X.Y.Z」
const CURRENT_CLAIMS = [
  { file: README_EN, label: "README 当前发布行", re: /Current release:\s*\*\*v?(\d+\.\d+\.\d+)\*\*/ },
  { file: README_CN, label: "README_cn 当前发布行", re: /当前发布版本[：:]\s*\*\*v?(\d+\.\d+\.\d+)\*\*/ },
  { file: REQ_EN, label: "requirements 对照版本", re: /implementation shipped in version (\d+\.\d+\.\d+)/ },
  { file: REQ_EN, label: "requirements §4 对照版本", re: /exists in package version (\d+\.\d+\.\d+)/ },
  { file: REQ_CN, label: "requirements_cn 对照版本", re: /与\s*(\d+\.\d+\.\d+)\s*版本交付的实现/ },
  { file: REQ_CN, label: "requirements_cn §4 对照版本", re: /package 版本\s*(\d+\.\d+\.\d+)/ },
];

/** 两份「当前版本」声称句的规范写法（形状由本判据看守，改措辞要同步改这里）。
 *  **`--sync` 读的是同一张表**（issue #689）：回写改的就是这两条正则会命中的捕获组，所以
 *  「回写写对了」与「门禁读到了」是同一个事实，没有第二份措辞。 */
const VERSION_CLAIM_RULES = [
  { file: AGENTS_EN, label: "AGENTS.md「当前版本」句",
    repoRe: /Current version: `package\.json` says `(\d+\.\d+\.\d+)`/,
    pubRe: /`dist-tags\.latest`[^.;]{0,60}?`(\d+\.\d+\.\d+)`/ },
  { file: AGENTS_CN, label: "AGENTS_cn.md「当前版本」句",
    repoRe: /当前版本：`package\.json` 写 `(\d+\.\d+\.\d+)`/,
    pubRe: /`dist-tags\.latest`[^。；]{0,60}?`(\d+\.\d+\.\d+)`/ },
];

// ── 发布态回写（`--sync`，issue #689）─────────────────────────────────────────
// 病根（issue #686 复盘）：0.30.0 发布当天两件事都是**人工串步骤**漏掉的——①发布态没回写，文档里还写着
// 「未发布 / latest 0.29.0」（registry 已经是 0.30.0）；②指南写着「16 个导出已在 0.30 删除」而运行时全还在。
// ②由 #687 / #688 修；①的机器面就是这张表：**发布成功之后、打 tag 之前**必须先回写，回写完立刻重跑
// `check:docs` 证明回写自洽（`npm run release:day --stage writeback` 把这两步串起来）。
//
// 窄面纪律：**只准改下面这张表列出的捕获组，别的一个字节都不写**。每一行都是**门禁自己会读的那一处**
// （`CURRENT_CLAIMS` 的当前版本句 / `VERSION_CLAIM_RULES` 的本仓版本与发布行两句 / `changelog-published`
// 判据 3 的段首「未发布」标记），所以回写不可能写到判据看不见的地方去；反过来，只要回写后 `check:docs`
// 绿，就是「回写自洽」的机器证据。
//
// 真值：本仓版本取自 `package.json`（`--version` 只给合成树 / 自测用），**发布行由 `--published <x.y.z>` 给**
// （CI 上没有 registry，离线自测不许联网）。不给 `--published` ⇒ exit 2 且一个字节都不写：
// 「已发布与否」没有真值时，往哪一边写都是猜。
const CHANGELOG_FILE = "CHANGELOG.md";
/** requirements §4 阶段表里被标为 `current` 的那一行（issue #699 ④）：`**v0.9.0–v0.30.0 — current**`。
 *  它是**当前版本声称**（阶段表覆盖到哪一版），切版之后必须跟着 `package.json` 走；但不在
 *  `CURRENT_CLAIMS` 里就没人回写它，于是切版后它停在旧版，而 `--strict` 遇那条 warning 即红。
 *
 *  **为什么不直接塞进 `CURRENT_CLAIMS`**：那几条是「写错就 exit 1」的硬声称，而阶段表停在旧版在本仓的
 *  既定口径里是**滞后信号**（§1 末尾「版本历史 / 阶段表的最高条目落后于 package.json 只算滞后信号：
 *  先告警后阻塞」）——把它升级成 error 会改变那条政策。所以严重度维持 warning，只把它接进**写盘面**：
 *  回写之后那条 warning 自然不再发，`--strict` 也就绿了。
 *  窄面：正则**只命中那一行的上界版本号本身**（后顾锁定 `| **vX.Y.Z–v`、前瞻锁定 ` — current**`），
 *  于是 `--sync` 的替换面就是那 6 个字节：行首下界、行内其余字节、表里其它行、表外一切句子都动不了。
 *  （写成「整行匹配 + 捕获上界」也能对，但 `--sync` 的替换用 `whole.indexOf(captured)` 定位：上下界写成
 *  同一个版本号时（`v0.31.0–v0.31.0`）它会换掉**下界**——前瞻/后顾把这个坑也堵了，实测见交付报告） */
const STAGE_ROW_CLAIMS = [
  { file: REQ_EN, label: "requirements §4 阶段表 current 行",
    re: /(?<=^\|\s*\*\*v\d+\.\d+\.\d+–v)(\d+\.\d+\.\d+)(?=\s*—\s*current\*\*)/gmu },
  { file: REQ_CN, label: "requirements_cn §4 阶段表 current 行",
    re: /(?<=^\|\s*\*\*v\d+\.\d+\.\d+–v)(\d+\.\d+\.\d+)(?=\s*—\s*当前\*\*)/gmu },
];

/** `--sync` 的改写面：`fact` 指向真值（`version` = 本仓版本 / `published` = 发布行）。 */
const RELEASE_STATE_TARGETS = [
  ...CURRENT_CLAIMS.map((claim) => ({ file: claim.file, id: `「${claim.label}」`, fact: "version", re: claim.re })),
  ...STAGE_ROW_CLAIMS.map((claim) => ({ file: claim.file, id: `「${claim.label}」`, fact: "version", re: claim.re })),
  { file: AGENTS_EN, id: "AGENTS.md「本仓版本」句", fact: "version", re: VERSION_CLAIM_RULES[0].repoRe },
  { file: AGENTS_EN, id: "AGENTS.md「发布行」句", fact: "published", re: VERSION_CLAIM_RULES[0].pubRe },
  { file: AGENTS_CN, id: "AGENTS_cn.md「本仓版本」句", fact: "version", re: VERSION_CLAIM_RULES[1].repoRe },
  { file: AGENTS_CN, id: "AGENTS_cn.md「发布行」句", fact: "published", re: VERSION_CLAIM_RULES[1].pubRe },
];
/** CHANGELOG 段首的「未发布」标记（判据 3 / `changelog-published` 读的就是它）。 */
const UNPUBLISHED_HEADING_RE = /\s*（未发布[^）]*）|\s*\(unpublished\)/;

/** 一个 CLI 旗标的值（`--flag v` 与 `--flag=v` 两种写法都认）。 */
function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i >= 0) return argv[i + 1] ?? "";
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : null;
}

/**
 * **发布态回写**（`--sync`）：把 `RELEASE_STATE_TARGETS` 里那几处句子的版本字面量改成给定真值，
 * 再把 CHANGELOG 当前版本段的「未发布」标记与段首日期按发布态对齐。**先全部定位、再落盘**：任何一处声称句
 * 读不到 / 命中 0 处 ⇒ exit 2 且一个字节都不写（「读不出」永远不等于「没这句话」）。
 *
 * `publishedDate`（issue #697）：发布态那一半的日期，缺省 = 当天 UTC+8（发布日期是发布这件事的产物，
 * 不是从哪份旧文本里抄的常量）。标记与日期**同一步写**：分开写就会一半新一半旧。
 *
 * @param {{root?: string, version?: string, published?: string|null, publishedDate?: string|null,
 *          log?: (line: string) => void}} [options]
 * @returns {number} 0 = 写完（或本来就一致）/ 2 = 真值缺位或声称句读不出（未写盘）
 */
export function syncReleaseState({ root = ROOT, version, published = null, publishedDate = null, log = console.log } = {}) {
  const pkgText = (() => {
    try { return readFileSync(path.join(root, "package.json"), "utf8"); } catch { return null; }
  })();
  const pkgVersion = (() => {
    try { return JSON.parse(pkgText ?? "").version; } catch { return undefined; }
  })();
  if (!pkgVersion) {
    log(`docs-drift-check --sync: 读不出 ${path.join(root, "package.json")} 的 version——没有本仓版本真值就不回写`);
    return 2;
  }
  const nextVersion = version ?? pkgVersion;
  if (!/^\d+\.\d+\.\d+$/.test(nextVersion)) {
    log(`docs-drift-check --sync: 版本号 ${JSON.stringify(nextVersion)} 不是 x.y.z——真值形状不对就不回写`);
    return 2;
  }
  if (published === null || published === "") {
    log("docs-drift-check --sync: 缺 `--published <x.y.z>`——「已发布与否」没有真值（CI 上没有 registry，"
      + "离线自测不许联网），往哪一边写都是猜；**本次一个字节都没写**。发布成功之后回写请给 `--published <版本>`。");
    return 2;
  }
  if (!/^\d+\.\d+\.\d+$/.test(published)) {
    log(`docs-drift-check --sync: \`--published ${published}\` 不是 x.y.z——真值形状不对就不回写`);
    return 2;
  }
  if (cmpSemver(published, nextVersion) > 0) {
    log(`docs-drift-check --sync: 发布行 ${published} 高于本仓版本 ${nextVersion}——这个组合在 npm 上不成立，不回写`);
    return 2;
  }
  if (nextVersion !== pkgVersion) {
    log(`docs-drift-check --sync: ⚠ \`--version ${nextVersion}\` 覆盖了 package.json 的 ${pkgVersion}`
      + "（只给合成树 / 自测用；发版日回写不传它，版本号一律取自 package.json）");
  }
  // 段首日期（issue #697）：真值是「发布当天」。`--published-date` 只给「当天不是本机日历日」的情形
  // （跨零点的发版作业 / 补写）；不给就用当天 UTC+8（本仓发版时区）。形状不对 ⇒ exit 2 不写盘。
  const date = publishedDate === null || publishedDate === "" ? todayUtc8() : publishedDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    log(`docs-drift-check --sync: \`--published-date ${publishedDate}\` 不是 YYYY-MM-DD——日期真值形状不对就不回写`);
    return 2;
  }
  if (published !== nextVersion) {
    log(`docs-drift-check --sync: 段还没发布（发布行 ${published} ≠ 本仓版本 ${nextVersion}）——段首只写「未发布」标记，`
      + `不写日期${publishedDate ? "（`--published-date` 本次不用）" : ""}`);
  }
  const facts = { version: nextVersion, published };

  /** @type {Map<string, string>} */
  const before = new Map();
  /** @type {Map<string, string>} */
  const after = new Map();
  const edits = [];
  const notes = [];
  const problems = [];

  for (const target of RELEASE_STATE_TARGETS) {
    if (!before.has(target.file)) {
      try {
        before.set(target.file, readFileSync(path.join(root, target.file), "utf8"));
        after.set(target.file, before.get(target.file));
      } catch (err) {
        problems.push(`${target.file} 读不出（${/** @type {{code?: string}} */ (err)?.code ?? "unknown"}）——回写不许在真值缺位时动盘`);
        continue;
      }
    }
    const text = after.get(target.file);
    const value = facts[target.fact];
    const re = new RegExp(target.re.source, target.re.flags.includes("g") ? target.re.flags : `${target.re.flags}g`);
    let hits = 0;
    const next = text.replace(re, (whole, current, offset) => {
      hits += 1;
      if (current === value) return whole;
      const at = whole.indexOf(current);
      edits.push({
        file: target.file,
        id: target.id,
        line: text.slice(0, offset).split("\n").length,
        from: current,
        to: value,
      });
      return whole.slice(0, at) + value + whole.slice(at + current.length);
    });
    if (hits === 0) {
      problems.push(`${target.file} 里找不到${target.id}——声称句形状变了（规范写法见本文件顶部注释），`
        + "回写不许猜一句写上去");
      continue;
    }
    after.set(target.file, next);
  }

  // CHANGELOG：当前版本段段首那一行跟着发布态走（判据 3 读标记、判据 17b 读日期——两半同一步写）。
  let changelogText = null;
  try { changelogText = readFileSync(path.join(root, CHANGELOG_FILE), "utf8"); } catch {
    problems.push(`${CHANGELOG_FILE} 读不出——发布态没有落脚处（判据 3 的段首标记就在它里面）`);
  }
  if (changelogText !== null) {
    const lines = changelogText.split("\n");
    const at = lines.findIndex((line) => new RegExp(`^##\\s*\\[${esc(nextVersion)}\\]`).test(line));
    if (at < 0) {
      // 不是错误：`changelog-published`（判据 3）只对**已存在的**带日期段判发布态；「当前版本没有 CHANGELOG 段」
      // 由 `check:docs` 的 `guide-coverage` 判红（它要求 CHANGELOG 有 `package.json` 那一版），所以回写之后的
      // `check:docs` 会把这种缺位抓出来——这里只记一笔，不替门禁裁决，也不往 CHANGELOG 里造一段。
      notes.push(`${CHANGELOG_FILE} 里没有 ${nextVersion} 的版本段（\`## [${nextVersion}]\`）——发布态没有落脚处，`
        + "CHANGELOG 一个字节未动（缺段由 check:docs 的 guide-coverage 判红）");
    } else {
      const heading = lines[at];
      const isPublished = published === nextVersion;
      // 段首那一行的**规范形状**（issue #697）：
      //   已发布 ⇒ `## [X.Y.Z] - <发布日期>`；未发布 ⇒ `## [X.Y.Z]（未发布 / unpublished）`。
      // 两个方向都把整行重写成规范形状，于是「标记」与「日期」不可能一半新一半旧；行外的字节一字不动
      // （窄面由 `npm run release:day --self-test` 的逐字节比对看守）。
      const prefix = (new RegExp(`^##\\s*\\[${esc(nextVersion)}\\]`).exec(heading) ?? [heading])[0];
      const canonical = isPublished
        ? `${prefix.trimEnd()} - ${date}`
        : `${prefix.trimEnd()}（未发布 / unpublished）`;
      if (canonical !== heading) {
        lines[at] = canonical;
        edits.push({ file: CHANGELOG_FILE, id: `${nextVersion} 段首`, line: at + 1, from: heading, to: canonical });
      }
      before.set(CHANGELOG_FILE, changelogText);
      after.set(CHANGELOG_FILE, lines.join("\n"));
    }
  }

  if (problems.length) {
    log(`docs-drift-check --sync: 读不出真值 / 声称句缺位（${problems.length} 处）——**本次一个字节都没写**：`);
    for (const problem of problems) log(`  ✗ ${problem}`);
    return 2;
  }

  for (const note of notes) log(`  · ${note}`);
  const changed = [...after.keys()].filter((rel) => after.get(rel) !== before.get(rel));
  if (!changed.length) {
    log(`docs-drift-check --sync: 已经是发布态（本仓版本 ${nextVersion} / 发布行 ${published}）——没有可写的东西，0 字节写入`);
    return 0;
  }
  for (const rel of changed) writeFileSync(path.join(root, rel), /** @type {string} */ (after.get(rel)), "utf8");
  log(`docs-drift-check --sync: 回写 ${edits.length} 处发布态句子（${changed.length} 个文件）——`
    + `本仓版本 ${nextVersion} / 发布行 ${published}：`);
  for (const edit of edits) log(`  · ${edit.file}:${edit.line} ${edit.id} ${edit.from} → ${edit.to}`);
  log("  回写面只有这几处：其余字节逐字未动（--sync 的窄面由 `npm run release:day --self-test` 的反向证看守）");
  log("  下一步：`npm run check:docs` 必须绿（回写自洽的机器证据）——`npm run release:day --stage writeback` 会自动跑它");
  return 0;
}

if (SYNC) {
  process.exit(syncReleaseState({
    root: ROOT,
    version: flagValue(process.argv, "--version") ?? PKG_VERSION,
    published: flagValue(process.argv, "--published"),
    publishedDate: flagValue(process.argv, "--published-date"),
  }));
}

for (const claim of CURRENT_CLAIMS) {
  const text = read(claim.file);
  const matches = [...text.matchAll(claim.re.global ? claim.re : new RegExp(claim.re, "g"))];
  if (matches.length === 0) {
    err(`version: ${claim.file} 缺少「${claim.label}」声明（规范写法见 scripts/docs-drift-check.mjs 顶部注释），检查面失效本身就是漂移`);
    continue;
  }
  for (const m of matches) {
    if (m[1] !== PKG_VERSION) {
      err(`version: ${claim.file} 的「${claim.label}」写的是 ${m[1]}，package.json 是 ${PKG_VERSION}`);
    } else {
      note(`version: ${claim.file}「${claim.label}」= ${m[1]}（== package.json ${PKG_VERSION}）`);
    }
  }
}

// 文档里出现的任何版本号都不得高于当前发布版本（不得把未发布的东西写成事实）。
const FOUR_FILES = [README_EN, README_CN, REQ_EN, REQ_CN];
for (const rel of FOUR_FILES) {
  const text = read(rel);
  const seen = new Set();
  for (const m of text.matchAll(/(?<![\w./-])(?:v|V)?(\d+\.\d+\.\d+)(?![\w./-])/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    if (cmpSemver(m[1], PKG_VERSION) > 0) {
      err(`version: ${rel} 引用了高于 package.json（${PKG_VERSION}）的版本 ${m[1]}`);
    }
  }
}

// 「版本历史」/阶段表的最高条目落后于 package.json 只算滞后信号（先告警后阻塞）。
const HISTORY_MAX = { [README_EN]: /v(\d+\.\d+\.\d+)/g, [README_CN]: /v(\d+\.\d+\.\d+)/g };
for (const [rel, re] of Object.entries(HISTORY_MAX)) {
  const versions = [...read(rel).matchAll(re)].map((m) => m[1]);
  const max = versions.sort(cmpSemver).at(-1);
  if (max && cmpSemver(max, PKG_VERSION) < 0) {
    warn(`version: ${rel} 提到的最高版本是 ${max}，落后于 package.json 的 ${PKG_VERSION}（新版本条目/里程碑未补）`);
  } else if (max) {
    note(`version: ${rel} 提到的最高版本 ${max} == package.json ${PKG_VERSION}`);
  }
}

// requirements 阶段表里被标为 current 的那一行，必须覆盖当前版本。
for (const rel of [REQ_EN, REQ_CN]) {
  const row = read(rel)
    .split("\n")
    .find((line) => /^\|\s*\*\*v[\d.]+.*(?:—\s*(?:current|当前))/i.test(line));
  if (!row) {
    err(`version: ${rel} §4 阶段表找不到标为 current 的行，无法核对「当前版本」`);
    continue;
  }
  const versions = [...row.matchAll(/(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  const max = versions.sort(cmpSemver).at(-1);
  if (!max) {
    err(`version: ${rel} 的 current 行没有版本号：${row.slice(0, 60)}…`);
  } else if (cmpSemver(max, PKG_VERSION) < 0) {
    warn(`version: ${rel} 阶段表 current 行停在 ${max}，落后于 package.json 的 ${PKG_VERSION}`);
  } else {
    note(`version: ${rel} current 行覆盖到 ${max}（package.json ${PKG_VERSION}）`);
  }
}

// ── 2. 关键默认值白名单 ───────────────────────────────────────────────────────
// 每条规则：从源码里抽出**真值**（抽不到即规则失效 → error，逼着改代码的人同步改这里），
// 再用 must（正则模板）要求文档同口径、mustNot 拦住旧措辞复活。
const DEFAULT_RULES = [
  {
    id: "stallDetection 默认窗口与模式",
    src: "src/loop/orchestrator.js",
    srcRe: /stallDetection = \{ window: (\d+), mode: "(\w+)" \}/,
    docs: [README_EN, README_CN, REQ_EN, REQ_CN],
    must: ([w, mode]) => [new RegExp(`stallDetection[\\s\\S]{0,220}?window: ${w}, mode: "${mode}"`)],
    mustNot: [/default(?:se)? (?:mode|mode is)?\s*is\s*\n?\s*`?appear`?/, /默认模式是\s*`?appear`?/],
    hint: "orchestrator 的参数默认值是唯一真值（ERIX_STALL_MODE 只在运行时覆盖）",
  },
  {
    id: "maxRounds 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /\n\s+maxRounds = (\d+),/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`maxRounds[\\s\\S]{0,60}?(?:defaults to|默认为)\\s*${bt(v)}`)],
  },
  {
    id: "maxTokenContinuations 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /\n\s+maxTokenContinuations = (\d+),/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`maxTokenContinuations[\\s\\S]{0,40}?(?:defaults to|默认为)\\s*${bt(v)}`)],
  },
  {
    id: "tool-result TTL 默认轮数",
    src: "src/loop/tool-result-ttl.js",
    srcRe: /TOOL_RESULT_TTL_DEFAULT = (\d+)/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`toolResultTtl[\\s\\S]{0,40}?(?:defaults to|默认为)\\s*${bt(v)}`)],
  },
  {
    id: "toolResultFoldMinTokens 默认值",
    src: "src/loop/tool-result-ttl.js",
    srcRe: /TOOL_RESULT_FOLD_MIN_TOKENS_DEFAULT = (\d+)/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`toolResultFoldMinTokens[\\s\\S]{0,80}?(?:defaults to|默认为)[\\s\\S]{0,24}?${v}`)],
  },
  {
    id: "judgeIntervalRound 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /const judgeIntervalRound = [\s\S]{0,600}?: (\d+);/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`judgeIntervalRound[\\s\\S]{0,30}?(?:is|defaults to|为|默认为)\\s*${bt(v)}`)],
  },
  {
    id: "judgeInterceptTimeoutMs 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /const judgeInterceptTimeoutMs = [\s\S]{0,400}?: (\d[\d_]*);/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`judgeInterceptTimeoutMs[\\s\\S]{0,30}?(?:is|defaults to|为|默认为)\\s*${bt(v)}`)],
  },
  {
    id: "judgeFailureLimit 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /const roundJudgeFailureLimit = [\s\S]{0,300}?: (\d+);/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`judgeFailureLimit[\\s\\S]{0,40}?(?:defaults to|默认为)\\s*${bt(v)}`)],
  },
  {
    id: "reflection 自动启用门槛",
    src: "src/loop/reflection.js",
    srcRe: /DEFAULT_REFLECTION_MIN_ROUNDS = (\d+)/,
    docs: [README_EN, README_CN, REQ_EN, REQ_CN],
    must: ([v]) => [new RegExp(`maxRounds >= ${v}`)],
  },
  {
    id: "maxExtensions 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /const reflectionMaxExtensions = [\s\S]{0,300}?: (\d+);/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`maxExtensions[\\s\\S]{0,80}?${bt(v)}`)],
  },
  {
    id: "maxRoundsCap 兜底值",
    src: "src/loop/orchestrator.js",
    srcRe: /const reflectionMaxRoundsCap = [\s\S]{0,500}?: (\d+),/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`maxRoundsCap[\\s\\S]{0,160}?${bt(v)}`)],
  },
  {
    id: "retry 退避下限/上限",
    src: "src/loop/orchestrator.js",
    srcRe: /const backoffBaseMs = [\s\S]{0,200}?: (\d+);[\s\S]{0,200}?const backoffMaxMs = [\s\S]{0,200}?: (\d+);/,
    docs: [README_EN, README_CN],
    must: ([base, max]) => [
      // 允许「A defaults to X and B to Y」这类共用动词的句式，因此按出现顺序校两个真值。
      new RegExp(`backoffBaseMs[\\s\\S]{0,120}?${bt(base)}[\\s\\S]{0,120}?backoffMaxMs[\\s\\S]{0,120}?${bt(max)}`),
    ],
  },
  {
    // issue #191：`writeToolNames` 的默认值不再是 orchestrator 里的字面量（它与 judge timeline 的回退
    // 已归一为 src/reflection/judge.js 的共享常量），真值从常量定义处抽。
    id: "writeToolNames 默认值",
    src: "src/reflection/judge.js",
    srcRe: /export const DEFAULT_WRITE_TOOL_NAMES = (\[[^\]]+\]);/,
    docs: [README_EN, README_CN],
    must: ([names]) => [
      new RegExp(`writeToolNames[\\s\\S]{0,60}?${esc(names)}`),
    ],
    hint: "judge 的默认写工具集；orchestrator 的参数默认值与 normalizeToolNameSet 回退共用这个常量",
  },
  {
    id: "writeToolPathKeys 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /\n\s+writeToolPathKeys = (\[[^\]]+\]),/,
    docs: [README_EN, README_CN],
    must: ([keys]) => [
      new RegExp(`writeToolPathKeys[\\s\\S]{0,60}?${esc(keys)}`),
    ],
  },
  {
    id: "notes 统一保留期",
    src: "src/store/notes.js",
    srcRe: /const DEFAULT_RETENTION_MS = (\d+) \* 24/,
    docs: ["docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([days]) => [new RegExp(`(?:default|默认)\\s*${days}\\s*(?:days|天)`, "i")],
    hint: "契约里 ERIX_NOTES_RETENTION_MS 的默认天数",
  },
  {
    // issue #184：readFile 有界读的默认上限只在契约文档里写了一次，
    // 没机器校验时改源码默认值不会让 check:docs 变红。
    id: "readFile max_bytes 默认值",
    src: "src/tools/file-tools.js",
    srcRe: /FILE_READ_MAX_BYTES_DEFAULT = ([\d_]+)/,
    docs: ["docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([v]) => [new RegExp(`max_bytes[\\s\\S]{0,200}?${bt(v)}`)],
    hint: "契约里 readFile 单次返回字节上限（ERIX_FILE_READ_MAX_BYTES）的默认值",
  },
  {
    // #184 追加轮 A：rg 与 grep 共用同一个命中行宽上限，全库只有源码这一处定义。
    id: "搜索命中行宽上限",
    src: "src/tools/file-tools.js",
    srcRe: /const GREP_LINE_LIMIT = (\d+);/,
    docs: [README_EN, README_CN, "docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([v]) => [new RegExp(`(?:${v} characters|${v} 字符|\`${v}\`)`)],
    hint: "两个搜索工具共用的命中行截断上限（README 与契约中英都按源码真值写；历史上是 200，#184 提到 500）",
  },
  {
    // #184 追加轮 A：默认按正则（与真实 rg/grep 一致）。锚点取**行为**而不是描述文案：
    // 把默认翻回字面量会让这条抽不到真值 → check:docs 变红，逼着同步四处文档。
    // #195 起别名把 mode 映射抽成了 aliasSearchMode()（searchText 与两个别名共跑一份实现体），
    // 锚点跟着改成那个映射的**真值行**：把 `is_regex === false` 改成正向判定，这里立刻变红。
    id: "rg 默认搜索模式为正则",
    src: "src/tools/file-tools.js",
    srcRe: /function aliasSearchMode\(input\) \{[\s\S]{0,120}?input\?\.is_regex === (false) \? "(literal)" : "(regex)"/,
    docs: [README_EN, README_CN, "docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([, literalMode, regexMode]) => [
      new RegExp(`is_regex[\\s\\S]{0,300}(?:regular expression|regex|${esc(regexMode)}|正则)`, "i"),
      new RegExp(`is_regex[\\s\\S]{0,300}(?:literal|${esc(literalMode)}|字面量)`, "i"),
    ],
    hint: "rg 默认正则是真实命令的口径；`is_regex=false` 才是字面量（rg --fixed-strings / grep -F），两处都要写",
  },
  {
    // issue #195 R1：`searchText` 的 `mode` **必填且无默认值**。锚点取源码里的取值集合
    // （行为真值，不是描述文案）：加/删一个取值，或文档偷偷写「默认 literal」，都会变红。
    id: "searchText mode 必填且无默认值",
    src: "src/tools/file-tools.js",
    srcRe: /const SEARCH_MODES = new Set\(\["(literal)", "(regex)"\]\)/,
    docs: [README_EN, README_CN, "docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([literalMode, regexMode]) => [
      new RegExp(`mode[\\s\\S]{0,320}(?:required|必填)`, "i"),
      new RegExp(`mode[\\s\\S]{0,320}(?:no default|\\u65e0\\u9ed8\\u8ba4\\u503c)`, "i"),
      new RegExp(`mode[\\s\\S]{0,320}?${esc(literalMode)}`, "i"),
      new RegExp(`mode[\\s\\S]{0,320}?${esc(regexMode)}`, "i"),
    ],
    // 「mode 默认 literal」就是本轮要修的谎，不许在文档里复活
    mustNot: [/mode[`"']?\s*(?:defaults to|默认(?:为|是))\s*`?(?:literal|regex)/i],
    hint: "searchText 的 mode 必填、无默认值（取值字面量来自源码 SEARCH_MODES）；中英四处都要写「必填 + 无默认 + 两个取值」",
  },
  {
    // issue #195 R2：名称过滤参数只有「匹配 basename」这一子集能力，所以它叫 name_pattern。
    // 锚点取**匹配对象**（path.basename 的那一处调用）而不是文案：把过滤改成整路径匹配 → 变红，
    // 逼着同步「只匹配文件名、不跨 /」这条口径（否则参数名又开始撒谎）。
    id: "name_pattern 只匹配文件名（不跨 /）",
    src: "src/tools/file-tools.js",
    srcRe: /nameExpression\.test\(path\.(basename)\(filePath\)\)/,
    docs: [README_EN, README_CN, "docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([target]) => [
      new RegExp(`name_pattern[\\s\\S]{0,300}(?:${target}|file name|\\u6587\\u4ef6\\u540d)`, "i"),
      new RegExp(`name_pattern[\\s\\S]{0,300}(?:never crosses|\\u4e0d\\u8de8)`, "i"),
    ],
    mustNot: [/name_pattern[\s\S]{0,120}?(?:full glob|\\u5b8c\\u6574 glob|\*\*\/\*\.\w+\s*(?:works|\\u751f\\u6548))/i],
    hint: "name_pattern 只匹配 basename、不跨 `/`；`**/*.ts` 一类完整 glob 不工作（锚点 = path.basename 那一处）",
  },
  {
    // issue #196 R1：截断 marker 必须给得出「下一步」。锚点取源码里那个**统一子句前缀**
    // （`NEXT_STEP_CLAUSE`，措辞的唯一来源）而不是文档文案：改前缀 = 模型可见承诺变了 → 本检查变红，
    // 逼着同步中英两处；文档把出口偷偷写成 `exec`/`sed`（本库没有的工具）也接不住这条锚点。
    id: "截断 marker 的「下一步」子句与允许点名的工具",
    src: "src/tools/file-tools.js",
    srcRe: /const NEXT_STEP_CLAUSE = "([^"]+)";/,
    docs: ["docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([clause]) => [
      new RegExp(esc(clause)),
      // 收紧条款：出口只能点名本模块的两个工具，并且文档要写明 `exec` 属 CLI 装配层
      new RegExp(`readFile[\\s\\S]{0,200}?searchText`),
      new RegExp(`exec[\\s\\S]{0,200}(?:belongs to the CLI|属 CLI 装配层)`, "i"),
    ],
    hint: "marker 的「下一步」子句（真值 = 源码 NEXT_STEP_CLAUSE）、只许点名 readFile/searchText、以及「exec 属 CLI 装配层所以不得进 marker」这条收紧，中英两处都要写",
  },
  {
    // issue #196 R2：结果文本里的字节数走 formatSize。锚点取源码真值：默认上限 262144 经
    // `/ 1024` 推导出的可读值（当前 256KB）+ 单位字面量 KB/MB/GB/TB。改默认值或改单位 → 变红。
    // ⚠ 追加轮 R6 加了 GB/TB 两档，这里必须**逐档**抽字面量：只写死 KB/MB 的话，加档（或把
    //   新档写成 GB 以外的字面）文档与检查面都会静默失效——检查面漏掉一档等于那一档没有契约。
    id: "marker 字节数的可读单位（formatSize）",
    src: "src/tools/file-tools.js",
    srcRe: /export const FILE_READ_MAX_BYTES_DEFAULT = ([\d_]+);[\s\S]*?return `\$\{kb\}(KB)`;[\s\S]*?toFixed\(1\)\}(MB)`;[\s\S]*?toFixed\(1\)\}(GB)`;[\s\S]*?toFixed\(1\)\}(TB)`;/,
    docs: ["docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([raw, unitKB, unitMB, unitGB, unitTB]) => {
      const kb = Number(String(raw).replace(/_/g, "")) / 1024;
      return [
        new RegExp("formatSize"),
        new RegExp(`${kb}${esc(unitKB)}`),
        new RegExp(esc(unitMB)),
        new RegExp(esc(unitGB)),
        new RegExp(esc(unitTB)),
        new RegExp("1024 基数|1024 base"),
        new RegExp("裸字节数|raw byte count"),
      ];
    },
    hint: "契约里要写：导出名 formatSize、默认上限的可读形式（由源码 262144/1024 推导）、KB/MB/GB/TB 四档单位与 1024 基数、以及「可读值不与裸字节数并存」",
  },
];

for (const rule of DEFAULT_RULES) {
  const srcText = read(rule.src);
  const m = srcText.match(rule.srcRe);
  if (!m) {
    err(`defaults: 规则「${rule.id}」在 ${rule.src} 里抽不到真值——源码形状变了，请同步更新本脚本（否则检查面会静默失效）`);
    continue;
  }
  const values = m.slice(1);
  for (const rel of rule.docs) {
    const text = read(rel);
    for (const re of rule.must(values)) {
      if (!re.test(text)) {
        err(`defaults: ${rel} 没有按源码真值声明「${rule.id}」= ${JSON.stringify(values)}（${rule.src}；规则提示：${rule.hint ?? "文档需与参数默认值同口径"}）`);
      }
    }
    for (const re of rule.mustNot ?? []) {
      if (re.test(text)) {
        err(`defaults: ${rel} 仍含有害旧措辞 /${re}/（「${rule.id}」的真值是 ${JSON.stringify(values)}）`);
      }
    }
  }
  note(`defaults: 「${rule.id}」实测值 ${JSON.stringify(values)}（${rule.src}），已在 ${rule.docs.join(" / ")} 核对`);
}

// ── 2.5 「清单/枚举/单位」锚点：逐处一致 + 双向对称（issue #210 R1/R2/R3）─────────
//
// 为什么要有这一节：#164 留下的锚点绝大多数是**存在性**的（「文档里存在这个字符串吗」）。
// issue #210 把盲区摊开了：契约文档里 `TB` 出现 3 处，**删掉其中一处 → 检查面全绿**；README
// 引用的 `exports` 清单把 `"./tools"` 改名或整个删掉 → 也是全绿（块定位靠真值键，键没了就退化成
// warn）。存在性锚点管的是「有没有写」，管不住「写的每一处对不对」。
// 本节的口径（三件事，缺一条都算没修）：
//   ① **双向对称**（`assertSymmetric`）：文档声明的成员集合必须与源码真值集合**完全相等**——
//      缺、多、改名、写重都红，错误信息点名差在哪个成员；
//   ② **逐处**（`detectListClaims`）：声明点是一处一处比的，不是「全文抽到一次就算过」；
//   ③ **中英处数对账**（`assertPairCensus`）：同一条规则在中英两侧的声明点**处数**必须相等——
//      ②管不住「把某一侧的整句声明删掉」（剩下的那处仍然全等），③管得住。
// 「抽不到真值就报错」（#164 口径）保留：源码形状变了 → error；文档里一处声明都抽不到 → error
// （检查面失效本身就是漂移）。
//
// 下面这份「新增为什么值得升级到逐处」与紧接的「没升级」记录是对称的两份（#210 R3 的口径是
// 「没升级的必须写理由」，不是「升级了的不用写理由」）：
//   · markers（#272）：真值是源码里的**一个 template literal**，文档写的是它的占位符实例化形式
//     （`N`/`M`/`K`/`<size>`），两侧都是定长字符串，逐字比对不会变成措辞绑架（那正是数值型 defaults
//     不敢升级的理由，这里不存在）。实证代价：把 EN 契约里的 `（文件 <size>）` 段删掉后，`check:docs`
//     与 `check:docs:strict` 都还是 exit 0，只有 #267 加的**源码↔文档**测试会红——而文档是宿主
//     唯一读得到的面，那个测试又不进任何门禁。
//   · baseline（#274）：AGENTS 里那两个基线数是 `scripts/type-check-ratchet.mjs` 里两个常量的**复述**，
//     复述句式可枚举（`BASELINE_ROOT = N`、「基线常量 **N**」、「基线 **N** / M 个文件」、「= 110 + 20 + 16」），
//     分解式还能自证算术。实证代价：#265 的 CHANGELOG 条目把棘轮写成开发中途的 `142→138 / 185→181`
//     （落树终局是 121 / 164），当时随提交留下了；#270 手工改了中英共 11 处当前值，全靠人逐字读。
//   · paths（#273）：覆盖面本身就是检查面。同一条不存在的仓内路径写进根 README 会 exit 1，写进
//     `examples/pi-extension/README.md` 却 exit 0（那个文件里一整段「已验证」叙述引用的测试文件名
//     全部无人校）——规则有效而覆盖面漏了，是比「规则本身弱」更便宜的一种修。
//
// 「声明点」的判据（诚实的边界，别当成真值）：一处清单声明 = 反引号/双引号包住的 token，用 `/`、
// `|`、`,`、`;`、`、` 或 `与`/`和`/`and` 这类连接符连成的序列，**或**单个反引号里的 `a | b | c`
// 取值串；并且它命中的真值成员数 ≥ ⌈|真值|×0.75⌉。阈值是判据：它把「`rg` / `grep` / `tree` 顺带
// 并列」这种子集提及排除在清单声明之外。代价写进 R3 的残留清单：**一份清单同时删掉 ≥25% 的成员
// 会掉到阈值以下而静默放行**（删 1 处一定红）。3 值枚举用 `pipeOnly` 把判据换成「必须是 `a | b | c`
// 取值串」，于是策略名那种 3 值枚举删 1 个也一定红，而「两种轮次折叠策略（`fold-statistical` 与
// `fold-llm`）」这种合法的部分提及不会被误判。
//
// 本单**没有**升级成逐处一致的清单类锚点（理由写在这里，不为完成率造弱断言）：
//   · `SEARCH_MODES`（`literal`/`regex`）：中英四处的句式完全不同（EN 是「`literal` matches…, `regex`
//     as…」两个独立句子，CN 是「`"literal"`（字面量）与 `"regex"`（…）」一处并列），抽不出跨语言的
//     「声明句式」；现有 must[] 已经要求四写「必填 + 无默认 + 两个取值」、mustNot 拦住「mode 默认
//     literal」复活，缺一个取值就红；剩下「文档多写一个假取值」不红——已列入残留清单。
//   · README「内置 CLI 工具」那句的真值不是单一符号：CLI 另外还注册 `todo_*`/`note_*` 会话工具，
//     那句话刻意只列文件/搜索工具 + `exec`。所以这里用 `contains` 模式（真值必须全覆盖 + 额外成员
//     必须是源码里真存在的工具名），而不是硬造一个「CLI 工具全集」当真值。
//   · 数值型 defaults 条目：同 §检查面 的说明——散文句式多变，强行钉句式会得到一个措辞绑架器。
//
// ── #279 的病历（与上面同一份口径：谁有病、为什么不逐例重写）─────────────────────────
// 病：`--self-test` 若干用例的 overlay 是「在某文档里把一个文件名改个名」，写法是 JS 的
//   `t.replace("X.mjs", …)` —— **只换文本里第一次出现**。而「第一次出现在哪」取决于文档措辞：
//   任何人在同一文档更靠前的位置**用散文提一句同一个名字**（带反引号就会被提取成引用），那一枪
//   就打在未被裁决的那一处上。实证三次（#278 收尾 3 红、#280 收尾 2 红——两条形状不同：一条
//   「红了但没点该点的名」、一条「**改了但没红**」= 自测报出假 fail-open 警报），两次都得靠
//   「把那个名字从散文里去掉」才恢复——那正是让人放宽期望的溃败入口。
// 治（选定：按提取结果定点打靶）：`mutateRef(from, to)` 用**与主检查同一套提取逻辑**
//   （`extractRefOccurrences` 的 `spans`）定位「提取值 == from」的全部出现，逐处定点替换。
//   · 为什么不是「只改第一次出现」的定点版：主检查按**值去重**（`candidatePaths` 的 `out` 一个值只留
//     一条），改一处而别处还剩着同一个值 → 提取集没变 → 该红的不红（假 fail-open）。所以「那一处」
//     在本检查的语义下就是「该值的全部出现」，必须一次打全。
//   · 为什么不是裸 `replaceAll`：`"repro-circular-details.mjs"` 是 `docs/tasks/…/repro-circular-details.mjs`
//     这个**另一个引用值**的子串，裸替换会顺手打死不相干的登记，期望只能跟着改（措辞绑架）。
//   · 为什么不是注入提取结果集（issue 说的「最稳」）：注入会让**文本与提取结果对不上**——同一行写着
//     A、检查按 B 判，而「同行写了 `docs/tasks/`」「同地声明」这些判据读的就是行文本，那个状态任何真
//     文档都造不出来，验收时没人能重现。定点替换只改文本，不制造假状态。
//   · 防「空跑假绿」：一个 span 都没命中（靶串已从文档消失 / 本来就不是被提取的引用）就**原样返回**，
//     由 `runSelfTest` 既有的「变异没落到 X 上」判据报红；另加了期望强度校（能匹配空串的期望 = 永真）。
// 清单（本单前共 56 例，其中「在某文档里替换一个文件名/路径」的共 **15 例 / 18 个 overlay**，本轮全改成 `mutateRef`）：
//   ① examples/pi-extension/README 的 `erix-run-core.js` 改名（该值在本仓提取面里有 4 处，旧写法只打 1 处）
//   ② 根 README 引用的 docs/architecture.md 改名（提取值是 URL 尾段，旧写法靠人手工挑靶串）
//   ③ 白名单不是整目录豁免：CHANGELOG 里已登记的 `repro-circular-details.mjs` 改一个字（#278 首次现场）
//   ④ 同地声明就能放行（对照）：2026-09-26 那篇的 REPORT.md → PLAN.md
//   ⑤ 上面那例的反向证：把「（本地，不入库）」删掉（同一行里的文件名变异 + 散文变异两刀）
//   ⑥ 白名单条目变空转：`e2e-wake.mjs` 在三份文档里的同名提及全改掉
//   ⑦ #280：空树形下把已登记裸名改成未登记假名（`e2e-wake-cloneQ.mjs`）
//   ⑧ #278-P2：改坏**已登记**的裸名 `repro-circular-details.mjs`
//   ⑨ #278-P3：改坏**未登记**的裸名 `e2e-wake.mjs`
//   ⑩ 跳仓对照文档的裸名不被裁决（对照）：codex 篇的 `MEMORY.md` 改名（该值 5 处）
//   ⑪ #269 原型：`debug.routes.js` 改成凭空无近邻的 `zz-nonexistent-evidence.md`（唯一把**行号钉在
//      期望里**的一例：`（第 118 行）`——只要有人在那行上面加一句散文它就红，而那正是本单的病；
//      改成断言「必须点名一个行号」（`第 \d+ 行`）而不是某个固定地址，不是放宽：两者都要求报出行号）
//   ⑫ 跳仓点名清单不许烂着：harness-comparison/README 的 `MEMORY.md` 全改成实物名（原本就是 `replaceAll`，
//      仍是「按子串」而非「按提取值」，一并改成定点）
//   ⑬ 登记表反向校扩到裸名（#278 第 4 件）：CHANGELOG 与 research 篇的裸名全改成真实路径（#280 现场）
//   ⑭ 近邻判据不跟跳仓豁免一起免：02-touwaka 篇把 `README.md` 换成本仓实物名改坏尾缀
//   ⑮ 简称登记也要反向校（#278 第五类）：CHANGELOG 里的 `format.js` 简称改成实物路径（原本已是 `replaceAll`，
//      仍是按子串而非按提取值，一并改成定点）
//   没改的 41 例（README/package.json 的 exports・files 围栏、清单/单位/标记/默认值锚点、棘轮基线句式、
//   `.gitignore` 文本、#280 的树形口子那两例）：它们的靶不是「一个文件名」，不存在抢枪问题
//   （围栏/句式类靶的唯一性由各自的提取器保证；树形例根本不碰文本）。
// 另外新增两例把本单的病钉住（见 SELF_TEST_CASES 里标着「#279」那两条）：散文提一句已登记的裸名，
//   既要「门禁仍绿」，也要「变异仍打在真正被提取到的那一处」——前者单独存在时修前也是绿的，
//   所以本单的修前红证据靠后者（它在修前就是 #280 那条「改了但没红」的假 fail-open）。

/** `--self-test` 用：把某个文件的文本换成内存副本（不落盘、不动工作树）。 */
const OVERLAY = new Map();
const textOf = (rel) => OVERLAY.get(rel) ?? read(rel);

/** 双向对称的集合差：缺什么、多什么、写了重复成员。 */
function diffSets(truth, doc) {
  const uniq = (a) => [...new Set(a)];
  return {
    missing: uniq(truth).filter((x) => !doc.includes(x)),
    extra: uniq(doc).filter((x) => !truth.includes(x)),
    dup: doc.filter((x, i) => doc.indexOf(x) !== i),
  };
}

/**
 * 双向对称断言——#210 唯一的「文档清单 vs 源码真值」比较器，README 的 files/exports 与所有
 * 清单类锚点共用这一份（issue #210 追加评论要求的「可复用比较器」）。
 *   mode `exact`    两边集合必须完全相等（缺/多/改名/写重都红）
 *   mode `contains` 文档必须覆盖真值（缺 → 红）；允许额外成员，但额外成员必须出现在 `allowExtra`
 *                   里，否则算「文档凭空多写一个成员」→ 红
 * @returns {boolean} 该处声明是否与真值一致
 */
function assertSymmetric(out, { rule, where, truth, doc, mode = "exact", allowExtra = [], kind = "成员" }) {
  const { missing, extra, dup } = diffSets(truth, doc);
  const phantom = extra.filter((x) => !allowExtra.includes(x));
  const q = (a) => a.map((x) => JSON.stringify(x)).join("、");   // 成员带引号：`.` 这种键名不 quoting 就看不清
  if (missing.length) out.push(`${rule}: ${where} 缺 ${kind} ${q(missing)}（源码真值：${truth.join("、")}）`);
  if (mode === "exact" && extra.length) {
    out.push(`${rule}: ${where} 多出真值里没有的 ${kind} ${q(extra)}（源码真值：${truth.join("、")}）`);
  }
  if (mode === "contains" && phantom.length) {
    out.push(`${rule}: ${where} 多出真值与允许清单里都没有的 ${kind} ${q(phantom)}（文档写了源码里不存在的成员）`);
  }
  if (dup.length) out.push(`${rule}: ${where} 的 ${kind}清单里 ${q([...new Set(dup)])} 写了不止一次`);
  return !missing.length && !(mode === "exact" && extra.length) && !(mode === "contains" && phantom.length) && !dup.length;
}

/** 中英成对文档的声明点处数对账：删掉一侧的整句声明就在这里红（逐处一致管不到的那一路）。 */
function assertPairCensus(out, { rule, counts, docs }) {
  for (let i = 0; i + 1 < docs.length; i += 2) {
    const [en, cn] = [docs[i], docs[i + 1]];
    if (counts[en] === counts[cn]) continue;
    out.push(`${rule}: 声明点处数中英不齐：${en} ${counts[en]} 处 vs ${cn} ${counts[cn]} 处`
      + `（中英是成对译文，同一事实必须逐处对齐；只在一侧删掉整句声明就是这种形状）`);
  }
}

const LIST_TOKEN_RE = /[`"]([A-Za-z][A-Za-z0-9_.+-]*)[`"]/g;

/** 两个被引号包住的 token 之间是否构成「清单连接符」（仅空白不算：`a` `b` 是两个独立提及）。 */
function isListGap(gap, { pipeOnly = false } = {}) {
  const g = gap.trim();
  if (!g) return false;
  if (pipeOnly) return /^\|\s*$/.test(g) || /^\|\s*(?:(?:and|or|与|和)\s*)?$/.test(g);
  return /^(?:[/|,;，、；]\s*)+(?:(?:and|or|与|和|或|以及)\s*)?$/.test(g)
    || /^(?:and|or|与|和|或|以及)$/.test(g);
}

/** 连续的反引号/双引号 token 串（跨行允许，行内缩进算空白）。 */
function listRuns(src, opts = {}) {
  const toks = [...src.matchAll(LIST_TOKEN_RE)]
    .map((m) => ({ v: m[1], start: m.index, end: m.index + m[0].length }));
  const runs = [];
  let cur = null;
  for (const t of toks) {
    if (cur && isListGap(src.slice(cur.end, t.start), opts)) {
      cur.tokens.push(t.v);
      cur.end = t.end;
      continue;
    }
    if (cur) runs.push(cur);
    cur = { tokens: [t.v], start: t.start, end: t.end };
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.tokens.length >= 2);
}

/** 单个反引号里的 `a | b | c` 取值串（`listRuns` 看不见这种形状，不设这条就是静默盲区）。 */
function pipeSpans(src) {
  const out = [];
  for (const m of src.matchAll(/`([^`\n]+)`/g)) {
    if (!m[1].includes("|")) continue;
    const parts = m[1].split("|").map((s) => s.trim().replace(/^"|"$/g, ""));
    if (parts.length >= 2 && parts.every((s) => /^[A-Za-z][A-Za-z0-9_.+-]*$/.test(s))) {
      out.push({ tokens: parts, start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/** 同一段文字被两种抽法同时命中时只留一条（取覆盖更宽的那种）。 */
function dedupeRuns(runs) {
  const kept = [];
  for (const r of [...runs].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))) {
    const hit = kept.find((k) => r.start < k.end && k.start < r.end);
    if (!hit) { kept.push({ ...r }); continue; }
    if (r.end - r.start > hit.end - hit.start) Object.assign(hit, r);
  }
  return kept;
}

const lineOf = (src, i) => src.slice(0, i).split("\n").length;
const snippetOf = (src, i) => src.slice(0, i).split("\n").at(-1).trim().slice(0, 90);

/**
 * 抽出文档里**每一处**声明该清单的位置。
 * 判据：命中真值成员数 ≥ ⌈|真值|×0.75⌉（子集提及不算在声明这份清单）。
 */
function detectListClaims(src, { truth, pipeOnly = false, minShared }) {
  const need = minShared ?? (pipeOnly ? 2 : Math.max(2, Math.ceil(truth.length * 0.75)));
  return dedupeRuns([...listRuns(src, { pipeOnly }), ...pipeSpans(src)])
    .filter((r) => r.tokens.filter((t) => truth.includes(t)).length >= need)
    .map((r) => ({ ...r, line: lineOf(src, r.start), snippet: snippetOf(src, r.start) }));
}

/** `new Set(["a", "b"])` / `{ "a": … }` / `["a", "b"]` 字面量里的字符串成员。 */
function membersOf(src, blockRe, itemRe) {
  const block = src.match(blockRe)?.[1];
  if (!block) return null;
  const items = [...block.matchAll(itemRe)].map((m) => m[1]);
  return items.length ? items : null;
}

const truthVendors = (src) => membersOf(src,
  /const VENDOR_DIRECTORIES = new Set\(\[([^\]]+)\]\)/, /"([^"]+)"/g);
const truthFileTools = (src) => membersOf(src,
  /export const FILE_TOOL_DEFINITIONS = \[([\s\S]*?)\n\];/, /\n\s+name: "([^"]+)"/g);
const truthStrategyNames = (src) => membersOf(src,
  /export const BUILTIN_COMPACTION_STRATEGIES = Object\.freeze\(\{([\s\S]*?)\n\}\)/, /"([^"]+)":/g);

/** 源码里真实注册过的工具名（README 那句 CLI 工具清单的「不许凭空多写成员」白名单）。 */
function knownToolNames() {
  const names = new Set();
  for (const rel of [...walk("src"), ...walk("bin")]) {
    if (!rel.endsWith(".js")) continue;
    for (const m of read(rel).matchAll(/\bname: "([A-Za-z][\w-]*)"/g)) names.add(m[1]);
  }
  return [...names];
}

/**
 * `formatSize` 的真值：档位单位（低→高）、进位基数、每档小数位——全部从源码抽，抽不到就 null
 * （→ error，沿用 #164「抽不到真值就报错」）。
 */
function formatSizeTruth(src) {
  const body = src.match(/export function formatSize\(bytes\) \{([\s\S]*?)\n\}/)?.[1];
  if (!body) return null;
  const base = Number(body.match(/if \(value < (\d+)\) return/)?.[1]);
  if (!base) return null;
  const tiers = [];
  for (const m of body.matchAll(/return `\$\{([^}]*)\}([A-Z]{1,2})`;/g)) {
    const [, expr, unit] = m;
    const toFixed = expr.match(/\.toFixed\((\d+)\)$/);
    if (toFixed) { tiers.push({ unit, decimals: Number(toFixed[1]) }); continue; }
    if (!/^[A-Za-z_$][\w$]*$/.test(expr)) return null;   // 渲染表达式换了形状：显式报错
    const decl = body.match(new RegExp(`(?:const|let) ${expr} = ([^;]+);`));
    if (!decl || !/Math\.round/.test(decl[1])) return null;
    tiers.push({ unit, decimals: 0 });
  }
  return tiers.length >= 2 ? { base, tiers } : null;
}

const roundTo = (v, decimals) => (decimals === 0 ? String(Math.round(v)) : v.toFixed(decimals));

/** 照源码的晋级判据（「渲染后的值」到基数就晋级）复算一遍，用来验文档里每一条示例映射。 */
function renderFormatSize({ base, tiers }, rawBytes) {
  const value = Math.max(0, Math.round(rawBytes));
  let num = value;
  let rendered = `${roundTo(num, tiers[0].decimals)}${tiers[0].unit}`;
  for (let i = 1; i < tiers.length; i++) {
    num = value / base ** i;
    rendered = `${roundTo(num, tiers[i].decimals)}${tiers[i].unit}`;
    if (Number(roundTo(num, tiers[i].decimals)) < base) return rendered;   // 与源码同口径：比的是**渲染后**的数值
  }
  return rendered;
}

/** 文档里的示例映射声明：`` `262144` → `256KB` ``。 */
function arrowByteClaims(src) {
  return [...src.matchAll(/`(\d+)`\s*(?:→|->)\s*`(\d+(?:\.\d+)?)([A-Z]{1,2})`/g)]
    .map((m) => ({ raw: Number(m[1]), claimed: `${m[2]}${m[3]}`, line: lineOf(src, m.index), snippet: snippetOf(src, m.index) }));
}

// ── 2.5.2 工具事实契约面：契约文档的字段清单 ↔ `TOOL_RESULT_CONTRACT` 常量（工单 261014 T1）───
// 病根（#284 / #285）：同一个事实的「谁拥有哪个字段」在构造器、文档、契约测试三处各写一份。
// 修法是把它写成导出常量，本规则接上其中「文档 ↔ 常量」那条边：**双向**比成员。
// 真值从 `src/tool-fact.js` 的**源码文本**抽（不 import）：门禁要在没有生成物、没有
// node_modules 的树里能跑，且必须能吃 `--self-test` 的内存副本（OVERLAY）。
// 声明面有五个（都在中英两份契约里各自存一份，所以下面逐面做中英处数对账）：
//   ① 散文清单「以 `erix.<field>` 寻址：`a` / `b` / …」
//   ② 字段归属表（第一格是字段、第二格是 Owner）——含命名空间名本身
//   ③ 「exactly five fields / 恰好五个字段」这类数量声明
//   ④ 存在性矩阵的表头列名
//   ⑤ legacy 别名表（旧顶层键 → 新归属）
// ④ 的期望集是「引擎字段减去 `success`」：矩阵刻意不给 `success` 开列（契约里就写了理由：
// 它是输入/输出不对称的那个），所以下面写成显式常量而不是从常量推；新增一个引擎字段仍必须
// 同时多一列，否则就是「缺」红。

const CN_NUMERALS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 两: 2 };
const EN_NUMERALS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** 从 `src/tool-fact.js` 的源码抽 `TOOL_RESULT_CONTRACT` 的真值；抽不到就 null（→ error）。 */
function toolFactTruth(src) {
  const obj = src.match(/export const TOOL_RESULT_CONTRACT = deepFreeze\(\{([\s\S]*?)\n\}\)/)?.[1];
  if (!obj) return null;
  const engineBlock = obj.match(/\n  engine: \{([\s\S]*?)\n  \},/)?.[1];
  const hostBlock = obj.match(/\n  host: \{([\s\S]*?)\n  \},/)?.[1];
  const protocolBlock = obj.match(/\n  protocol: \{([\s\S]*?)\n  \},/)?.[1];
  const legacyBlock = obj.match(/\n  legacy: \{([\s\S]*?)\n  \},/)?.[1];
  if (!engineBlock || !hostBlock || !protocolBlock || !legacyBlock) return null;
  const fieldsBlock = engineBlock.match(/\n    fields: \{([\s\S]*)$/)?.[1];
  const engineFields = fieldsBlock
    ? [...fieldsBlock.matchAll(/^      ([A-Za-z][A-Za-z0-9_]*): \{$/gm)].map((m) => m[1])
    : null;
  const requiredBlock = protocolBlock.match(/\n    required: \[([^\]]*)\]/)?.[1];
  const required = requiredBlock
    ? [...requiredBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : null;
  const conditionalBlock = protocolBlock.match(/\n    conditional: \{([\s\S]*?)\n    \},/)?.[1];
  const conditional = conditionalBlock
    ? [...conditionalBlock.matchAll(/^      ([A-Za-z][A-Za-z0-9_]*): "/gm)].map((m) => m[1])
    : null;
  const reservedBlock = obj.match(/\n  reserved: \{([\s\S]*?)\n  \},/)?.[1];
  const reservedKeys = reservedBlock
    ? [...(reservedBlock.match(/\n    topLevelKeys: \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : null;
  const aliasBlock = legacyBlock.match(/\n    aliases: \{([\s\S]*?)\n    \},/)?.[1];
  const aliases = aliasBlock
    ? [...aliasBlock.matchAll(/^      (?:("[^"]+")|([A-Za-z][A-Za-z0-9_]*)): "([^"]+)"/gm)]
      .map((m) => ({ from: m[1] ? m[1].slice(1, -1) : m[2], to: m[3] }))
      .filter((a) => /^[A-Za-z][A-Za-z0-9_]*$/.test(a.from))   // 塔平宿主键那条是占位名，单独校
    : null;
  const out = {
    engineNs: engineBlock.match(/\bns: "([^"]+)"/)?.[1],
    hostNs: hostBlock.match(/\bns: "([^"]+)"/)?.[1],
    engineFields,
    required,
    conditional,
    reservedKeys,
    aliases,
    placeholderAlias: (() => {
      const m = legacyBlock.match(/^      "([^"]*<[^>]+>[^"]*)":\s*"([^"]+)"/m);   // "<host key>@top level": "metadata.<host key>"
      return m ? m[2] : null;
    })(),
  };
  const missing = Object.entries(out).filter(([, v]) => v === null || v === undefined || (Array.isArray(v) && !v.length));
  return missing.length ? { __incomplete: missing.map(([k]) => k).join("、"), ...out } : out;
}

/** 文档表格行：第一格里的反引号 token 就是声明的成员，第二格是拥有者。 */
function tableRowsByOwner(src, owners) {
  const rows = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("| `")) continue;
    const cells = line.replace(/^\|\s*/, "").replace(/\s*\|$/, "").split(/\s*\|\s*/);
    const owner = (cells[1] ?? "").replace(/[*_`]/g, "").trim().toLowerCase();
    if (!owners.includes(owner)) continue;
    rows.push({
      line: i + 1,
      snippet: line.trim().slice(0, 90),
      tokens: [...(cells[0] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]),
    });
  }
  return rows;
}

/** 「exactly five fields / 恰好五个字段」这类数量声明（中英各自一份句式，数字用词表展开）。 */
function engineFieldCountClaims(src) {
  const out = [];
  for (const m of src.matchAll(/(?:exactly|恰好)\s*([A-Za-z]+|[\u4e00-\u9fff])\s*(?:fields\b|个字段)/g)) {
    const word = m[1].toLowerCase();
    const n = EN_NUMERALS[word] ?? CN_NUMERALS[m[1]];
    out.push({ word: m[1], n, line: lineOf(src, m.index), snippet: snippetOf(src, m.index) });
  }
  return out;
}

/** 存在性矩阵的表头（第一格是「Case / 情形」那行）里的 `<ns>.<字段>` 列名（命名空间名也从常量拿）。 */
function existenceMatrixColumns(src, nsList) {
  const out = [];
  const lines = src.split("\n");
  const re = /\b([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\b/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\|\s*(?:Case|情形)\s*\|/i.test(line)) continue;
    const cols = [];
    const foreign = [];
    for (const m of line.matchAll(re)) {
      if (m[1] === nsList.engineNs || m[1] === nsList.hostNs) cols.push({ ns: m[1], field: m[2] });
      else foreign.push(`${m[1]}.${m[2]}`);
    }
    out.push({ cols, foreign, line: i + 1, snippet: line.trim().slice(0, 90) });
  }
  return out;
}

/** legacy 别名表：两格都是反引号 token 的行（「旧顶层键 | 新归属」）。 */
function legacyAliasRows(src) {
  const rows = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*$/);
    if (m) rows.push({ from: m[1], to: m[2], line: i + 1, snippet: lines[i].trim() });
  }
  return rows;
}

/** 别名表里「塔平宿主键」那一行：第一格是散文（占位键没有字面名），第二格是 `ns.<占位>`。 */
function hostFlattenAliasRows(src, hostNs) {
  const rows = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp("^\\|[^|`]*\\|\\s*`(" + esc(hostNs) + "\\.<[^>]+>)`\\s*\\|\\s*$"));
    if (m) rows.push({ to: m[1], line: i + 1, snippet: lines[i].trim().slice(0, 90) });
  }
  return rows;
}

/**
 * 保留键名的声明面（工单 261014 T1-fix 第 5 项）：按空行切段，段里既出现「保留 / reserved」
 * 这个说法、又用反引号点名词条里的键名，才算一处声明。只数「提到过这个名字」不算——
 * `metadata` / `erix` 在文档里到处都是，那样这条锚点会恒绿。
 */
function reservedKeyDeclarations(src, reservedKeys) {
  const out = [];
  let cursor = 0;
  for (const paragraph of src.split(/\n\s*\n/)) {
    const at = src.indexOf(paragraph, cursor);
    cursor = at < 0 ? cursor : at + paragraph.length;
    if (!/(保留|reserved)/i.test(paragraph)) continue;
    const tokens = [...paragraph.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const named = tokens.filter((token) => reservedKeys.includes(token));
    if (!named.length) continue;      // 说了一句「保留」但没点名任何保留键，不算一处声明
    out.push({ line: lineOf(src, at), snippet: paragraph.trim().slice(0, 90), tokens: named });
  }
  return out;
}

/** 命名空间前缀拆名：`erix.round` → {ns:"erix", field:"round"}；不带点的归为 ns:null。 */
function splitNs(token) {
  const i = token.indexOf(".");
  return i < 0 ? { ns: null, field: token } : { ns: token.slice(0, i), field: token.slice(i + 1) };
}

/**
 * 工具事实契约锚点的跑法（与 formatSize 那条同构：一个规则、多层断言）。
 * 每一面都是「逐处 + 双向」，另加中英声明点处数对账。
 */
function runToolFactRule(rule, out, notesOut) {
  const t = toolFactTruth(textOf(TOOL_FACT_SRC));
  const ruleId = `anchors/${rule.id}`;
  if (!t || t.__incomplete) {
    out.push(`${ruleId}: 在 ${TOOL_FACT_SRC} 里抽不全 TOOL_RESULT_CONTRACT 的真值`
      + `（缺：${t?.__incomplete ?? "整块常量"}）——源码形状变了，请同步更新本脚本（否则检查面静默失效）`);
    return;
  }
  // ④ 的期望集（写死的理由见本块顶部注释）：矩阵不给 `success` 开列。
  const matrixExpect = t.engineFields.filter((f) => f !== "success");
  const protocolExpect = [...t.required, ...t.conditional];
  const counts = { list: {}, rows: {}, count: {}, matrix: {}, alias: {} };
  for (const rel of rule.docs) {
    const src = textOf(rel);

    // ① 散文清单
    const lists = detectListClaims(src, { truth: t.engineFields });
    counts.list[rel] = lists.length;
    if (!lists.length) {
      out.push(`${ruleId}: ${rel} 找不到引擎字段清单声明（「以 \`${t.engineNs}.<field>\` 寻址：a / b / …」那一句）`
        + "——检查面在该文件已失效（要么把声明补回来，要么把它移出本规则的 docs）");
    }
    for (const c of lists) {
      assertSymmetric(out, {
        rule: `${ruleId} 字段清单`, where: `${rel}:${c.line}「${c.snippet}」`,
        truth: t.engineFields, doc: c.tokens, kind: rule.kind,
      });
    }

    // ② 字段归属表（engine / protocol / host 三类拥有者各自双向比）
    const engRows = tableRowsByOwner(src, ["engine", "引擎"]);
    const proRows = tableRowsByOwner(src, ["protocol", "协议"]);
    const hostRows = tableRowsByOwner(src, ["host", "宿主"]);
    counts.rows[rel] = engRows.length + proRows.length + hostRows.length;
    if (!engRows.length || !proRows.length || !hostRows.length) {
      out.push(`${ruleId}: ${rel} 的字段归属表不齐（engine ${engRows.length} 行 / protocol ${proRows.length} 行 / host ${hostRows.length} 行）`
        + "——Owner 列是这张表的锦定，被改掉就是检查面失效而不是「没声明」");
    }
    const declaredEngine = [];
    for (const r of engRows) {
      for (const tok of r.tokens) {
        const { ns, field } = splitNs(tok);
        if (ns !== t.engineNs) {
          out.push(`${ruleId}: ${rel}:${r.line}「${r.snippet}」把引擎字段写成 \`${tok}\`，而 ${TOOL_FACT_SRC} 的`
            + ` TOOL_RESULT_CONTRACT.engine.ns 是 "${t.engineNs}"（命名空间名就是那个值，文档得跟着改）`);
          continue;
        }
        declaredEngine.push(field);
      }
    }
    if (engRows.length) {
      assertSymmetric(out, {
        rule: `${ruleId} 字段归属表`, where: `${rel}:${engRows[0].line} 起的 ${engRows.length} 行`,
        truth: t.engineFields, doc: declaredEngine, kind: "引擎字段行",
      });
    }
    const declaredProtocol = proRows.flatMap((r) => r.tokens.filter((x) => !x.includes(".")));
    if (proRows.length) {
      assertSymmetric(out, {
        rule: `${ruleId} 协议字段行`, where: `${rel}:${proRows[0].line} 起的 ${proRows.length} 行`,
        truth: protocolExpect, doc: declaredProtocol, kind: "协议字段",
      });
    }
    for (const r of hostRows) {
      for (const tok of r.tokens) {
        if (splitNs(tok).ns !== t.hostNs) {
          out.push(`${ruleId}: ${rel}:${r.line}「${r.snippet}」把宿主命名空间写成 \`${tok}\`，而`
            + ` TOOL_RESULT_CONTRACT.host.ns 是 "${t.hostNs}"`);
        }
      }
    }

    // ③ 数量声明
    const nums = engineFieldCountClaims(src);
    counts.count[rel] = nums.length;
    if (!nums.length) {
      out.push(`${ruleId}: ${rel} 找不到「exactly N fields / 恰好 N 个字段」这类数量声明——检查面在该文件已失效`);
    }
    for (const c of nums) {
      if (c.n === undefined) {
        out.push(`${ruleId}: ${rel}:${c.line}「${c.snippet}」的数量词「${c.word}」不在词表里（词表外就是静默放行，补词表）`);
      } else if (c.n !== t.engineFields.length) {
        out.push(`${ruleId}: ${rel}:${c.line}「${c.snippet}」声称引擎命名空间有「${c.word}」个字段，而`
          + ` ${TOOL_FACT_SRC} 的 TOOL_RESULT_CONTRACT.engine.fields 是 ${t.engineFields.length} 个`
          + `（${t.engineFields.join("、")}）`);
      }
    }

    // ④ 存在性矩阵表头
    const matrices = existenceMatrixColumns(src, { engineNs: t.engineNs, hostNs: t.hostNs });
    counts.matrix[rel] = matrices.length;
    if (!matrices.length) {
      out.push(`${ruleId}: ${rel} 找不到存在性矩阵的表头行（「| Case | … |」/「| 情形 | … |」）——检查面在该文件已失效`);
    }
    for (const m of matrices) {
      for (const f of m.foreign) {
        out.push(`${ruleId}: ${rel}:${m.line}「${m.snippet}」的列 \`${f}\` 用的命名空间`
          + `既不是 TOOL_RESULT_CONTRACT.engine.ns（${t.engineNs}）也不是 host.ns（${t.hostNs}）`
          + "——命名空间名与字段名一样，是常量里的事实");
      }
      assertSymmetric(out, {
        rule: `${ruleId} 存在性矩阵列`, where: `${rel}:${m.line}「${m.snippet}」`,
        truth: matrixExpect,
        doc: m.cols.filter((c) => c.ns === t.engineNs).map((c) => c.field),
        kind: "矩阵列（引擎字段减去刻意不开列的 success）",
      });
    }

    // ⑤ legacy 别名表
    const aliasRows = legacyAliasRows(src);
    counts.alias[rel] = aliasRows.length;
    if (!aliasRows.length) {
      out.push(`${ruleId}: ${rel} 找不到 legacy 别名表行（「| \`旧顶层键\` | \`新归属\` |」）——检查面在该文件已失效`);
    }
    assertSymmetric(out, {
      rule: `${ruleId} legacy 别名表`, where: `${rel}${aliasRows.length ? `:${aliasRows[0].line} 起的 ${aliasRows.length} 行` : ""}`,
      truth: t.aliases.map((a) => a.from), doc: aliasRows.map((r) => r.from), kind: "旧顶层键",
    });
    for (const r of aliasRows) {
      const want = t.aliases.find((a) => a.from === r.from);
      if (want && r.to !== want.to) {
        out.push(`${ruleId}: ${rel}:${r.line}「${r.snippet}」把 \`${r.from}\` 的新归属写成 \`${r.to}\`，而常量里的别名是 \`${want.to}\``);
      }
      if (!want && !r.to.includes("<")) {
        out.push(`${ruleId}: ${rel}:${r.line}「${r.snippet}」的旧顶层键 \`${r.from}\` 在常量里没有对应别名条目`
          + `（已登记：${t.aliases.map((a) => a.from).join("、")}）`);
      }
    }
    if (t.placeholderAlias) {
      const ph = t.placeholderAlias.replace(/<[^>]+>/g, "");   // "metadata.<host key>" → "metadata."
      const flatRows = hostFlattenAliasRows(src, t.hostNs);
      if (!flatRows.some((r) => r.to.startsWith(ph))) {
        out.push(`${ruleId}: ${rel} 的别名表里没有「塔平宿主键 → \`${t.placeholderAlias}\`」那一行`
          + `（常量里有这条占位别名，文档侧必须有对应的描述行；只写两格反引号的形式不算，那个位置上没有字面键名）`);
      }
    }

    // ⑥ 保留键名（`legacyTopLevel` 摊平时被跳过的顶层键，工单 261014 T1-fix 第 5 项）：
    //    两侧文档都必须把「哪几个键名是保留的」说出口——少一个键名，宿主就会以为自己那个
    //    恰好同名的键被吃了却查不到原因；多一个键名，就是文档在承诺源码没做的事。
    const reservedDecls = reservedKeyDeclarations(src, t.reservedKeys);
    if (rel === rule.docs[0] && JSON.stringify([...t.reservedKeys].sort()) !== JSON.stringify([t.hostNs, t.engineNs].sort())) {
      out.push(`${ruleId}: ${TOOL_FACT_SRC} 自相矛盾——保留键名登记的是 ${t.reservedKeys.join(" / ")}，`
        + `但命名空间名是 ${t.hostNs} / ${t.engineNs}。保留的**就是**那两个命名空间本身，`
        + `两处不同源就说明有人只改了一处（构造器的过滤走的是登记那一份）`);
    }
    if (!reservedDecls.length) {
      out.push(`${ruleId}: ${rel} 找不到保留键名的声明（既要出现「保留 / reserved」这个说法，又要用反引号点名`
        + ` ${t.reservedKeys.map((k) => "`" + k + "`").join(" / ")}）——检查面在该文件已失效`);
    }
    assertSymmetric(out, {
      rule: `${ruleId} 保留键名`,
      where: `${rel}${reservedDecls.length ? `:${reservedDecls[0].line} 起的 ${reservedDecls.length} 段` : ""}`,
      truth: t.reservedKeys,
      doc: [...new Set(reservedDecls.flatMap((d) => d.tokens.filter((x) => t.reservedKeys.includes(x))))],
      kind: "保留键名",
    });
  }

  for (const [face, c] of Object.entries(counts)) {
    assertPairCensus(out, { rule: `${ruleId} ${face}`, counts: c, docs: rule.docs });
  }
  notesOut.push(`anchors: 「${rule.id}」真值 = ${t.engineNs}{${t.engineFields.join(", ")}} + 协议[${protocolExpect.join(", ")}]`
    + ` + 宿主 ${t.hostNs} + 别名[${t.aliases.map((a) => a.from).join(", ")}] + 保留键[${t.reservedKeys.join(", ")}]（${TOOL_FACT_SRC}），`
    + `声明面 ${JSON.stringify(counts)}（${rule.docs.join(" / ")}）`);
}

/**
 * 每条锚点的形状：{ id, src（真值出处）, truth(srcText)→string[], docs（中英成对排列）,
 *   mode/allowExtra/pipeOnly, 可选 run() 覆盖默认跑法 }
 * docs 必须按「EN, CN, EN, CN…」成对排列——处数对账按相邻两项配平。
 */
const ANCHOR_RULES = [
  {
    id: "vendor 跳过目录清单",
    kind: "目录",
    src: "src/tools/file-tools.js",
    truth: truthVendors,
    docs: [README_EN, README_CN, CONTRACT_EN, CONTRACT_CN],
    // 为什么能机械化：真值是源码里那个硬编码 Set，文档四处都是同一份清单的译文。
  },
  {
    id: "文件工具清单（契约的「七个」）",
    kind: "工具名",
    src: "src/tools/file-tools.js",
    truth: truthFileTools,
    docs: [CONTRACT_EN, CONTRACT_CN],
    // 只收契约：README 那句是 CLI 工具清单（多一个 `exec`），另立一条规则，见下一条。
  },
  {
    id: "内置 CLI 工具清单（README）",
    kind: "工具名",
    src: "src/tools/file-tools.js",
    truth: truthFileTools,
    docs: [README_EN, README_CN],
    mode: "contains",
    allowExtra: () => knownToolNames(),
  },
  {
    id: "内置压缩策略名",
    kind: "策略名",
    src: "src/compact/strategy-resolution.js",
    truth: truthStrategyNames,
    docs: [README_EN, README_CN, CONTRACT_EN, CONTRACT_CN],
    pipeOnly: true,   // 只认 `a | b | c` 取值串：这样 3 值枚举删 1 个必红，而「两种折叠策略（A 与 B）」不误判
  },
  {
    // 工单 261014 T1（#284 / #285）：契约文档的 erix 字段清单 ↔ `TOOL_RESULT_CONTRACT` 常量。
    // 跑法整条自定义（见 runToolFactRule）：一份常量有**五个**声明面（引擎字段、命名空间名、
    // 协议必需字段、条件字段、legacy 别名表），不是单一一张清单。
    id: "工具事实字段清单（契约中英 ↔ TOOL_RESULT_CONTRACT）",
    kind: "引擎字段",
    src: TOOL_FACT_SRC,
    truth: (src) => toolFactTruth(src)?.engineFields ?? null,
    docs: [CONTRACT_EN, CONTRACT_CN],
    run: runToolFactRule,
  },
  {
    id: "单位档位与示例映射（formatSize）",
    kind: "单位",
    src: "src/tools/file-tools.js",
    truth: (src) => formatSizeTruth(src)?.tiers.map((t) => t.unit) ?? null,
    docs: [CONTRACT_EN, CONTRACT_CN],
    minShared: 3,   // 单位词表无歧义（全大写短 token）：命中 3 个就肯定是在列档位，所以判据下探到 3（用默认 0.75 阈值时「删一个档位」会掉到阈值以下、只剩处数对账能接）
    // 单位清单走通用「逐处对称」；示例映射另有一层（见 runFormatSizeRule），两层各管一种破坏。
    run: runFormatSizeRule,
  },
];

/** `formatSize` 那条的两层断言：单位档位清单逐处对称 + 每条 `N` → `Xunit` 示例映射复算。 */
function runFormatSizeRule(rule, out, notesOut) {
  const t = formatSizeTruth(textOf(rule.src));
  if (!t) {
    out.push(`anchors/${rule.id}: 在 ${rule.src} 里抽不到 formatSize 的档位真值（单位字面量、基数或舍入形状变了）`
      + "——源码形状变了，请同步更新本脚本（否则检查面会静默失效）");
    return;
  }
  const units = t.tiers.map((x) => x.unit);
  const listCounts = {};
  const arrowCounts = {};
  for (const rel of rule.docs) {
    const src = textOf(rel);
    const lists = detectListClaims(src, { truth: units, minShared: rule.minShared });
    listCounts[rel] = lists.length;
    if (!lists.length) {
      out.push(`anchors/${rule.id}: ${rel} 找不到单位档位清单声明——检查面在该文件已失效（把档位清单补回来）`);
    }
    for (const c of lists) {
      assertSymmetric(out, {
        rule: `anchors/${rule.id}`, where: `${rel}:${c.line}「${c.snippet}」`,
        truth: units, doc: c.tokens, kind: rule.kind,
      });
    }
    const arrows = arrowByteClaims(src);
    arrowCounts[rel] = arrows.length;
    if (!arrows.length) {
      out.push(`anchors/${rule.id}: ${rel} 找不到「字节数 → 可读值」示例映射声明——检查面在该文件已失效`);
    }
    for (const a of arrows) {
      const want = renderFormatSize(t, a.raw);
      if (a.claimed !== want) {
        out.push(`anchors/${rule.id}: ${rel}:${a.line}「${a.snippet}」把 ${a.raw} 写成 \`${a.claimed}\`，`
          + `按源码档位（${units.join("/")}、${t.base} 基数）复算是 \`${want}\``);
      }
    }
  }
  assertPairCensus(out, { rule: `anchors/${rule.id} 单位清单`, counts: listCounts, docs: rule.docs });
  assertPairCensus(out, { rule: `anchors/${rule.id} 示例映射`, counts: arrowCounts, docs: rule.docs });
  notesOut.push(`anchors: 「${rule.id}」真值 = 档位 ${units.join("/")}（${t.base} 基数，逐档小数位 `
    + `${t.tiers.map((x) => x.decimals).join(",")}），单位清单 ${JSON.stringify(listCounts)}、示例映射 ${JSON.stringify(arrowCounts)}`);
}

/** 默认跑法：清单类锚点的「逐处对称 + 中英处数对账」。 */
function runListRule(rule, out, notesOut) {
  const truth = rule.truth(textOf(rule.src));
  if (!truth || truth.length < 2) {
    out.push(`anchors/${rule.id}: 在 ${rule.src} 里抽不到清单真值——源码形状变了，请同步更新本脚本（否则检查面会静默失效）`);
    return;
  }
  const allowExtra = rule.allowExtra ? rule.allowExtra() : [];
  const counts = {};
  for (const rel of rule.docs) {
    const src = textOf(rel);
    const claims = detectListClaims(src, { truth, pipeOnly: rule.pipeOnly });
    counts[rel] = claims.length;
    if (!claims.length) {
      out.push(`anchors/${rule.id}: ${rel} 找不到任何清单声明——检查面在该文件已失效（要么把声明补回来，要么把它移出本规则的 docs）`);
      continue;
    }
    for (const c of claims) {
      assertSymmetric(out, {
        rule: `anchors/${rule.id}`, where: `${rel}:${c.line}「${c.snippet}」`,
        truth, doc: c.tokens, mode: rule.mode ?? "exact", allowExtra, kind: rule.kind ?? "成员",
      });
    }
  }
  assertPairCensus(out, { rule: `anchors/${rule.id}`, counts, docs: rule.docs });
  notesOut.push(`anchors: 「${rule.id}」真值 ${truth.length} 项（${rule.src}），逐处核对 ${JSON.stringify(counts)}（${rule.docs.join(" / ")}）`);
}

/** 跑一遍所有清单/单位锚点，返回错误文本（不直接写全局，好让 `--self-test` 复用同一份实现）。 */
function collectAnchorErrors() {
  const out = [];
  const notesOut = [];
  for (const rule of ANCHOR_RULES) (rule.run ?? runListRule)(rule, out, notesOut);
  collectAnchorErrors.notes = notesOut;
  return out;
}

// ── 2.6 marker **字面量**同源（issue #272）───────────────────────────────────
// #267 只修了「源码模板 + NEXT_STEP_CLAUSE 不许被改形」（test/tools/file-tools.test.js），
// 没修「**文档引用的字面必须等于那份模板**」。后果：把 EN 契约里的 `（文件 <size>）` 段删掉，
// check:docs 与 check:docs:strict 都还是 exit 0。本规则把那一层接上：
//   真值侧 = toolMarker() 里 `case "readMoreLines"` 的 template literal + `NEXT_STEP_CLAUSE` 常量；
//   文档侧 = 形如 `[共 …]` 的那一处引用。两侧都是定长字符串，逐字比。
// 文档写的是模板的**占位符实例化**（它不能替模型填数），所以两边不会全等；对应关系就是下面
// 那张 `placeholders` 表。**模板里出现未登记的插值 → 直接红**（源码给 marker 加了新值，而文档
// 与本脚本都还不知道），而不是默默用旧字面去比。
const MARKER_LITERAL_RULES = [
  {
    id: "readMoreLines marker 字面（契约中英引用）",
    src: "src/tools/file-tools.js",
    kind: "readMoreLines",
    docs: [CONTRACT_EN, CONTRACT_CN],
    placeholders: [
      ["values.total - values.offset", "M"],
      ["formatSize(Number(values.size))", "<size>"],
      ["values.total", "N"],
      ["values.offset", "K"],
    ],
  },
];

/** 把源码模板渲染成「文档应该写的那份字面」。 */
function renderMarkerDocLiteral(srcText, rule) {
  const clause = srcText.match(/const NEXT_STEP_CLAUSE = "([^"]+)";/)?.[1];
  if (!clause) return { error: `在 ${rule.src} 里抽不到 NEXT_STEP_CLAUSE——#267 钉下的字面已不存在` };
  const tplSrc = `case "${rule.kind}":(?:(?!\\bcase\\b)[\\s\\S])*?return\\s*` + "`([^`]*)`" + `;`;
  const tpl = srcText.match(new RegExp(tplSrc))?.[1];
  if (!tpl) return { error: `在 ${rule.src} 里抽不到 toolMarker("${rule.kind}") 的模板（case 分支或 return 写法变了）——本规则检查面失效` };
  let out = "";
  let rest = tpl;
  const unmapped = [];
  while (rest.length) {
    const m = rest.match(/\$\{([^}]*)\}/);
    if (!m) { out += rest; break; }
    out += rest.slice(0, m.index);
    const expr = m[1].trim();
    if (expr === "NEXT_STEP_CLAUSE") {
      out += clause;
    } else {
      const hit = rule.placeholders.find(([e]) => e.replace(/\s+/g, " ") === expr.replace(/\s+/g, " "));
      if (!hit) { unmapped.push(expr); out += `⟨${expr}⟩`; }
      else out += hit[1];
    }
    rest = rest.slice(m.index + m[0].length);
  }
  if (unmapped.length) {
    return { error: `模板里有未登记的插值 \${${unmapped.join("} 与 \${")}}：源码给 marker 加了新值，`
      + `请把文档占位符与本脚本 placeholders 表一起补上（否则检查面会拿旧字面去比新真值）` };
  }
  return { literal: out, lead: tpl.slice(0, tpl.indexOf("${")) };
}

function collectMarkerLiteralErrors() {
  const out = [];
  const notes = [];
  for (const rule of MARKER_LITERAL_RULES) {
    const truth = renderMarkerDocLiteral(textOf(rule.src), rule);
    if (truth.error) {
      out.push(`markers/${rule.id}: ${truth.error}`);
      continue;
    }
    // 「一处文档引用」的判据：模板首个静态段开头（这里是 `[共 `）、到下一个 `]` 为止的串。
    // 不拿整份字面去找（文档写错就找不到了，那恰好是要报的情形），拿**开头**找。
    const claimRe = new RegExp(`${esc(truth.lead)}[^\\]\\n]*\\]`, "gu");
    const counts = {};
    for (const rel of rule.docs) {
      const src = textOf(rel);
      const claims = [...src.matchAll(new RegExp(claimRe.source, claimRe.flags))];
      counts[rel] = claims.length;
      if (!claims.length) {
        out.push(`markers/${rule.id}: ${rel} 找不到以 \`${truth.lead}\` 开头的 marker 字面引用——检查面在该文件已失效`
          + `（真值：${JSON.stringify(truth.literal)}）`);
        continue;
      }
      for (const c of claims) {
        if (c[0] === truth.literal) continue;
        out.push(`markers/${rule.id}: ${rel}:${lineOf(src, c.index)} 引用的是 ${JSON.stringify(c[0])}，`
          + `但按 ${rule.src} 的 toolMarker("${rule.kind}") 模板 + NEXT_STEP_CLAUSE 渲染出来是 ${JSON.stringify(truth.literal)}`
          + `（「${snippetOf(src, c.index)}」）；\n      占位符对应：${rule.placeholders.map(([e, p]) => `${p} = \${${e}}`).join("、")}、`
          + `；「下一步：」= \${NEXT_STEP_CLAUSE}`);
      }
    }
    assertPairCensus(out, { rule: `markers/${rule.id}`, counts, docs: rule.docs });
    notes.push(`markers/${rule.id}: 中英共 ${Object.values(counts).reduce((a, b) => a + b, 0)} 处引用，逐字等于 ${rule.src} 渲染出的那份字面`
      + `（${JSON.stringify(truth.literal)}）`);
  }
  collectMarkerLiteralErrors.notes = notes;
  return out;
}

// ── 2.7 `--checkJs` 棘轮**当前值** ↔ 棘轮常量（issue #274，只做最省的那一档）──────
// 真值 = scripts/type-check-ratchet.mjs 里的两个常量；文档侧 = AGENTS 中英里**复述这两个数**的句式。
// 本文件**没做**的那两档（代价不对等，写在这里不为完成率造活）：
//   · 真跑 tsc 核 `--listFiles` 的文件数（「基线 **N** / M files」那一句里的 M）：要 spawn tsc，而
//     check:docs 是文档门禁里跑得最勤的一条（每次文档改动），为此把 check:docs 变成十秒级不值得。
//     **这条对账因此不在本文件里**：它住在 `scripts/type-check-ratchet.mjs`（issue #635 ①，常量
//     `DOC_FILE_COUNT_CLAIMS`）—— 那个脚本本来就已经量出每档的「错误总数 + 带错文件数」，所以那里的对账是
//     **零额外 tsc 运行**；它逐处判（中英各判各的）、两档各判各的（句子里那个 N 等于哪一档的基线就按哪一档
//     的实测 M 判），写错了 exit 1 并点名，读不到声称句 exit 2。本文件只校那个 **N**（下面
//     `BASELINE_CLAIM_RULES` 里 `\d+ files` 那一处只认句式、不认 M），M 全部交给棘轮那一步。
//     issue #672 又把「带错文件数」的**另外四种形状**接进棘轮（`N of them (M files)` /
//     `**M of them carrying errors**` / `N 个错（涉 M 个文件）` / `其中 **M 个带错**`）；本文件对它们只做
//     **句式对账**（两条 `shapeOnly: true` 的规则）：句子在的时候那个 M 照样要对得上棘轮的实测，
//     而那个 M 的**真值**仍只在棘轮那一步判——不在这里抄第二份。
//   · 生成声明文件数（63）：那要跑 types:build，同样的理由。
// 「历史值不误伤」是这规则的命门：AGENTS 里同时存在 142/185/218/226/261 这些**已退役的**基线值
// （#251/#255/#265 那几段在讲棘轮降下来的过程），所以句式必须钉到「常量名 / 基线词」上，
// 而不是「抽一个四位数」；#265 那条就把棘轮写成开发中途的 142→138 / 185→181。
//
// ── issue #802：这一族**不再要求句子必须存在** ────────────────────────────────────
// 病根：`required: true` 让每一条规则变成「这句散文必须在，且必须长成这个句式」。它抓的永远是「有人改了
// 措辞」，永远抓不到「行为坏了」，代价是任何正当的文档改写都要先把措辞凑回正则（261109 指令面瘦身实测
// 来回 6 轮全撞在这上面）。判据的方向应当只有一条：**句子存在时，它的数字必须等于真值**。
// 所以：① 规则表里没有 `required` 字段；② 一条规则在某份文档里一处都不命中 ⇒ 只记一条 note，不红；
// ③ 中英**处数相等**（`assertPairCensus`）这一族也不再适用于 baseline——那是散文警察，不是真值对账。
const BASELINE_CLAIM_RULES = [
  {
    id: "常量写法 `BASELINE_ROOT = N`",
    tier: "root",
    claims: [
      { rel: AGENTS_EN, re: /BASELINE_ROOT\s*=\s*(\d+)/g },
      { rel: AGENTS_CN, re: /BASELINE_ROOT\s*=\s*(\d+)/g },
      { rel: CMDREF_EN, re: /BASELINE_ROOT\s*=\s*(\d+)/g },
      { rel: CMDREF_CN, re: /BASELINE_ROOT\s*=\s*(\d+)/g },
    ],
  },
  {
    id: "「基线常量 / baseline constant」声明",
    tier: "root",
    claims: [
      { rel: AGENTS_EN, re: /baseline constant\s*\*\*(\d+)\*\*/g },
      { rel: AGENTS_CN, re: /基线常量\s*\*\*(\d+)\*\*/g },
      { rel: CMDREF_EN, re: /baseline constant\s*\*\*(\d+)\*\*/g },
      { rel: CMDREF_CN, re: /基线常量\s*\*\*(\d+)\*\*/g },
    ],
  },
  {
    id: "「已接受的债 N 个错」声明",
    tier: "root",
    claims: [
      { rel: AGENTS_EN, re: /errors — (\d+) of them/g },
      { rel: AGENTS_CN, re: /——(\d+) 个错/g },
      { rel: CMDREF_EN, re: /errors — (\d+) of them/g },
      { rel: CMDREF_CN, re: /——(\d+) 个错/g },
    ],
  },
  {
    id: "「公共面 93 里的总数」声明",
    tier: "root",
    claims: [
      { rel: AGENTS_EN, re: /\d+ of the (\d+)/g },
      { rel: AGENTS_CN, re: /(\d+) 个里有/g },
      { rel: CMDREF_EN, re: /\d+ of the (\d+)/g },
      { rel: CMDREF_CN, re: /(\d+) 个里有/g },
    ],
  },
  {
    id: "「无 `.d.ts` 时的错误数」声明",
    tier: "root",
    claims: [
      { rel: AGENTS_EN, re: /\*\*(\d+) errors?\*\*\s+with\s+none\s+present/g },
      { rel: AGENTS_CN, re: /无\s*`\.d\.ts`\s*=\s*(\d+)\s*个错/g },
      { rel: CMDREF_EN, re: /\*\*(\d+) errors?\*\*\s+with\s+none\s+present/g },
      { rel: CMDREF_CN, re: /无\s*`\.d\.ts`\s*=\s*(\d+)\s*个错/g },
    ],
  },
  {
    id: "并集基线的分解式 `= A + B + C`",
    tier: "sum",
    claims: [
      { rel: AGENTS_EN, re: /= (\d+) \+ (\d+) \+ (\d+)/g },
      { rel: AGENTS_CN, re: /= (\d+) \+ (\d+) \+ (\d+)/g },
      { rel: CMDREF_EN, re: /= (\d+) \+ (\d+) \+ (\d+)/g },
      { rel: CMDREF_CN, re: /= (\d+) \+ (\d+) \+ (\d+)/g },
    ],
  },
  {
    // issue #630 S2（J）：文件数从写死的 `30 files` 改成 `\d+ files`。写死一个数字就是一枚哑弹：
    // 文件数一变（这一轮 30 → 29，`src/reflection/wrapup.js` 归零退出带错文件集），句式就整条
    // 匹配不上 ⇒ 那条规则（当时要求必现）让它变红得莫名其妙，而把它改成新数字又只是把哑弹往后推一格。
    // 这里只校**基线那个数**；M 由 `scripts/type-check-ratchet.mjs` 逐处对（issue #635 ①，常量
    // `DOC_FILE_COUNT_CLAIMS`）——那条对账零额外 tsc 运行，理由见本文件 2.7 节。
    id: "「基线 **N** / M 个文件」声明",
    tier: "withTools",
    claims: [
      { rel: AGENTS_EN, re: /baseline\s+\*\*(\d+)\*\*\s*\/\s*\d+\s*files/g },
      { rel: AGENTS_CN, re: /基线\s*\*\*(\d+)\*\*\s*\/\s*\d+\s*个文件/g },
      { rel: CMDREF_EN, re: /baseline\s+\*\*(\d+)\*\*\s*\/\s*\d+\s*files/g },
      { rel: CMDREF_CN, re: /基线\s*\*\*(\d+)\*\*\s*\/\s*\d+\s*个文件/g },
    ],
  },
  {
    // 当前文档里没这种写法（两侧都是 0 处）；出现了就必须对。
    id: "常量写法 `BASELINE_WITH_TOOLS = N`",
    tier: "withTools",
    claims: [
      { rel: AGENTS_EN, re: /BASELINE_WITH_TOOLS\s*=\s*(\d+)/g },
      { rel: AGENTS_CN, re: /BASELINE_WITH_TOOLS\s*=\s*(\d+)/g },
      { rel: CMDREF_EN, re: /BASELINE_WITH_TOOLS\s*=\s*(\d+)/g },
      { rel: CMDREF_CN, re: /BASELINE_WITH_TOOLS\s*=\s*(\d+)/g },
    ],
  },
  // ── issue #672：两族「M 个文件」现状声称的**句式对账**（真值不在这里，在棘轮那一步）────────
  // 这两条只干一件事：句子在的时候，那个 M 由 `scripts/type-check-ratchet.mjs` 的
  // `DOC_FILE_COUNT_CLAIMS`（#635 ① / #672）逐处对实测。句子不在 ⇒ 不红（issue #802）。
  // 所以这里 `shapeOnly: true`：**不**把捕获组拿去和基线常量比（M 不是 N，比了就是拿错东西判）。
  // `tier: "shape"` 是个不参与 `wantOf()` 的占位，看代码的人一眼能看出它不是档位。
  // 句式本身（与棘轮那边逐字同形）：`(M files)` 必须紧跟在 `N of them` 后面、`**M of them carrying errors**`
  // 必须整段加粗；中文侧是 `个错（涉 M 个文件）` 与 `其中 **M 个带错**`。历史值（`the other 27
  // error-carrying files` / `其余 27 个带错文件` / `142 / 185` 那一族）不落进这两个句式。
  {
    id: "「N of them (M files) / N 个错（涉 M 个文件）」声明",
    tier: "shape",
    shapeOnly: true,
    claims: [
      { rel: AGENTS_EN, re: /\d+\s+of them\s*\((\d+)\s+files\)/g },
      { rel: AGENTS_CN, re: /\d+\s*个错（涉\s*(\d+)\s*个文件）/g },
    ],
  },
  {
    id: "「**M of them carrying errors** / 其中 **M 个带错**」声明",
    tier: "shape",
    shapeOnly: true,
    claims: [
      { rel: AGENTS_EN, re: /\*\*(\d+) of them carrying errors\*\*/g },
      { rel: AGENTS_CN, re: /其中\s*\*\*(\d+)\s*个带错\*\*/g },
    ],
  },
];

/** 从棘轮脚本里抽两个基线常量（抽不到就是检查面失效，#164 口径）。 */
function ratchetBaselines(srcText) {
  const root = srcText.match(/^\s*const BASELINE_ROOT = (\d+);/m)?.[1];
  const withTools = srcText.match(/^\s*const BASELINE_WITH_TOOLS = (\d+);/m)?.[1];
  return { root, withTools };
}

function collectBaselineClaimErrors() {
  const out = [];
  const notes = [];
  const truth = ratchetBaselines(textOf(RATCHET_SRC));
  if (!truth.root || !truth.withTools) {
    return [`baseline: 在 ${RATCHET_SRC} 里抽不到 BASELINE_ROOT / BASELINE_WITH_TOOLS 常量——`
      + `棘轮改名或改写法了，本规则会静默失效，请同步这里（#164：抽不到真值就报错）`];
  }
  if (Number(truth.root) > Number(truth.withTools)) {
    out.push(`baseline: ${RATCHET_SRC} 自己的两个常量就不自洽：BASELINE_ROOT ${truth.root} > BASELINE_WITH_TOOLS ${truth.withTools}`);
  }
  const wantOf = (tier) => (tier === "root" ? truth.root : tier === "withTools" ? truth.withTools : null);
  const nameOf = (tier) => (tier === "sum" ? null : tier === "root" ? "BASELINE_ROOT" : "BASELINE_WITH_TOOLS");
  let total = 0;
  const missing = [];
  for (const rule of BASELINE_CLAIM_RULES) {
    const counts = {};
    for (const { rel, re } of rule.claims) {
      const src = textOf(rel);
      const m = [...src.matchAll(new RegExp(re.source, re.flags))];
      counts[rel] = m.length;
      if (!m.length) {
        // issue #802：句子不在 ⇒ **不红**（只留一条 note）。判据只管「句子在的时候数字对不对」。
        missing.push(`${rel}/${rule.id}`);
        continue;
      }
      for (const c of m) {
        total += 1;
        const at = `${rel}:${lineOf(src, c.index)}`;
        // `shapeOnly`（issue #672）：只数处数、不判那个数。M（带错文件数）的真值不在这里——
        // 它要跑 tsc 才拿得到，所以由 `scripts/type-check-ratchet.mjs` 的 `DOC_FILE_COUNT_CLAIMS` 逐处对；
        // 拿 `c[1]` 去和基线常量比就是拿错东西判（M ≠ N），比了只会得到一条永远红的假判据。
        const why = rule.shapeOnly
          ? null
          : rule.tier === "sum"
            ? (() => {
              const [a, b, cc] = c.slice(1).map(Number);
              if (a !== Number(truth.root)) return `首项 \`${a}\` 应等于 ${RATCHET_SRC} 的 BASELINE_ROOT（${truth.root}）`;
              if (a + b + cc !== Number(truth.withTools)) return `分解式 ${a} + ${b} + ${cc} = ${a + b + cc}，不等于 BASELINE_WITH_TOOLS（${truth.withTools}）`;
              return null;
            })()
            : (c[1] === wantOf(rule.tier) ? null : `声称 ${c[1]}，但 ${RATCHET_SRC} 的 ${nameOf(rule.tier)} 是 ${wantOf(rule.tier)}`);
        if (why) {
          out.push(`baseline/${rule.id}: ${at} ${why}。\n      棘轮基线的唯一真值在 ${RATCHET_SRC}：改常量就要同时改文档，`
            + `改文档就只能改成常量那个值（历史值 142/185/218/226/261 属于「已降下来」的叙述，不该出现在这些当前值句式里）；`
            + `\n      「${snippetOf(src, c.index)}」`);
        }
      }
    }
    // issue #802：这里**不再**做中英处数普查（`assertPairCensus`）。那条判据只能抓「有人单边删了一句散文」，
    // 抓不到任何行为问题，代价却是每一次正当改写都要把两侧句数凑平。
  }
  notes.push(`baseline: 指令面与冷层共 ${total} 处现值声明（含分解式算术闭合与 #672 的句式对账）——`
    + `凡是出现的数全部等于 ${RATCHET_SRC} 的 BASELINE_ROOT=${truth.root} / BASELINE_WITH_TOOLS=${truth.withTools}；`
    + "#672 那两族的 M 由 `scripts/type-check-ratchet.mjs` 对实测"
    + (missing.length ? `；未出现的声称（不判红，issue #802）：${missing.join(", ")}` : "；每条规则都至少命中一处"));
  collectBaselineClaimErrors.notes = notes;
  return out;
}

// ── 2.8 锚点粒度升级（issue #286 T-a：B 方案第一批 = 符号锚点 + 裸行号棘轮）─────────
// 病根（#286，已确证，不重新论证）：`paths` 那条锚点在解析 `path:line` 引用时**主动剥掉行号**
// （`extractRefOccurrences` 里的 `p.replace(/:\d+(?::\d+)?$/, "")`），只校「文件存在吗」。
// ⇒ 行号漂到别的代码段、甚至漂出文件末尾，门禁全绿无人报警。确凿样本：契约说 `emitEvent` 在
// `src/loop/orchestrator.js:1517-1531`，真身在 1660 一带；`docs/host-consumer-contract.md` 与
// `_cn.md` 各有一处 `src/store/notes.js:398-405`，而该文件只有 383 行（越界）。
//
// 本节两条锚点（T-a 只做这两条，**不做批量替换**；存量裸行号的替换归 T-b/T-c）：
//   · 2.8.1 symbol-anchor：「符号 + 文件」形态的引用必须能在被引文件里抽到该符号的**声明**
//     （R1，issue #210 的逐处一致口径：每一处单独校，找不到就红并点名相近符号；抽不到真值也红）。
//   · 2.8.2 bare-lines：`path:N` / `path:N-M` 形态的**裸行号引用**只减不增（R2 棘轮 + R3 越界必红）。
//
// 覆盖面与正则（工单 #286 T-a 的口径，脚本自己会数——别只信注释，跑 `--verbose` 看 note）：
//   覆盖面 = `SYMBOL_DOCS_STATIC` 点名的那批 + `docs/host-upgrade-guide*.md` 全部（按目录**实扫**：新增一份
//     指南就自动纳面，不存在「新文档漏在覆盖面外」的形状）。份数不在这里抄——跑 `--verbose` 看 ref-scan 那条 note，
//     文档里写着的份数由 `collectRefScanCountClaimErrors()` 逐格对账（#635 ①）。
//   正则 = BARE_LINE_RE：**实现面只算 `src/**.js:N[-M]`**（就是工单那条口径）。这段注释以前写「前缀面
//     放宽到 src|bin|scripts|test|docs|examples|fixtures」——**那一步从未落地**：现正则只匹配 `src/`，
//     于是 `bin/cli.js:841-848` 这类行号根本不进棘轮（`bin/final-guard.js:86`、`test/contract/…:124-142`
//     同理）。同一批 22 份文档现算的对照：只算 `src/` = 179 次出现 / 146 唯一（减 4 处豁免 ⇒ **142 = 基线**）；
//     真按那七个前缀放宽 = 191 次 / 158 唯一，差额 12 处全在 `bin/` 与 `test/` 上。放宽前缀会抬高棘轮
//     口径（要连基线一起重算），归独立的一刀，不在本单里偷偷做。
//     按工单那条只算 src/**.js 的口径实测：唯一 (文档,目标文件,行区间) **236** / 总出现 **271**
//     （T-b1a 之前是 248 / 279；契约那两大段锚点族被符号化 + 合并重复区间后降到这里。减去 4 处声明式
//     豁免 ⇒ 当时的棘轮基线 **232**——那是 T-b1a 落点，**不是现值**（现值 142，见下面常量的注释），
//     每一刀降基线的逐条理由就写在 `BARE_LINE_REF_BASELINE` 的注释里。）
//     `--verbose` 的 note 打的是**现实现**（只算 `src/`）那两个数，基线常量的注释里写了怎么复现。
//   `CHANGELOG.md` **不参与**：历史条目描述的是**当时**那份代码的行号，把它们改掉等于伪造历史
//     （同口径先例：#278 对 CHANGELOG 里的简称只登记不改写、#273 对历史条目逐条登记）。CHANGELOG 里
//     确实还有裸行号，它们仍由 `paths`（文件存在性）那条看守，只是不进棘轮面。
//
// 为什么 symbol-anchor **不做中英处数对账**（#210 R1 对逐处规则还额外要求中英对账，这里写明不做的理由）：
//   符号锚点的两侧数量**本来就不等**——契约 CN 的终止原因表比 EN 多写了几处机制说明，而 14 份升级指南里
//   有 8 份根本没有中文版。硬对账会逼着人为了凑数改措辞（#210 R3 警惕的「对措辞的绑架」）。
//   本条是**逐处真值**：每一处 (符号, 文件) 都单独与源码比，改错符号名/删掉声明都红；
//   处数只在 `--verbose` 里报，不做判据。真正的中英对账留给 T-b/T-c（存量被替换成符号锚点时，
//   中英两侧必须同步替换，那时数量才具备可比性）。

/** #286 T-a：覆盖面清单里被硬编码的那几份（升级指南按目录实扫，见 `refScanDocs()`）。 */
const SYMBOL_DOCS_STATIC = [README_EN, README_CN, AGENTS_EN, AGENTS_CN, CONTRACT_EN, CONTRACT_CN,
  // 工单 261021-03 B1：活文档纳面（架构 / 图表 / 需求对照中英各一份 + pi 扩展 README）。
  ARCH_EN, ARCH_CN, CHARTS_EN, CHARTS_CN, REQ_EN, REQ_CN, PI_EXT_README,
  // issue #644 ③：符号锚点声称链从 AGENTS 搬到 docs/maintenance/ 之后，这两份必须留在锚点面内——
  // 唯一 (符号, 文件) 组数是跨文档并集，链项引的那些锚点换了文档不能变成「消失」。
  LEDGER_EN, LEDGER_CN];

/** #286 返工 R2：覆盖面份数的**下限**。病根：覆盖面是「硬编码那批 + 按 `^host-upgrade-guide.*\.md$` 实扫」，
 *  于是有人把某份指南改名到不再匹配那个模式（或把它挪出 `docs/`），脚本与测试侧的 glob **一起少一份**，
 *  两边数字仍然相等 ⇒ 静默缩面、全绿。测试侧另硬编码一份当前清单做对照，这里再钉一道份数下限。
 *  现值 = `SYMBOL_DOCS_STATIC.length`（点名那批）+ 目录实扫到的指南份数，**由本文件算出来**：
 *  下限只是「不许比它小」的地板，它本身不解释自己为什么是这个数——所以文档里写的那组份数（点名几份 +
 *  实扫几份 = 下限）由 `collectRefScanCountClaimErrors()` 逐格对账（#635 ①）。
 *  历史（每一次抬高的理由：哪份指南落地、哪七份活文档纳面）在 `docs/maintenance/symbol-anchor-ledger.md`。
 *  写法必须保持这一行不变形（自测要改这个数）。 */
const REF_SCAN_DOCS_MINIMUM = 53;

/** #280 同款的「树形口子」，只给 `--self-test` 用（**不是豁免开关**）：模拟「某份指南改名到不匹配模式」。 */
let SIM_RENAMED_GUIDE = null;
let LAST_SCAN_DOC_COUNT = -1;   // 自测据此判断树形口子有没有真的落上（#279 的「变异没落上」同一条纪律）

/** 覆盖面：13 份点名文档 + `docs/host-upgrade-guide*.md` 全部（实扫，新增指南自动纳面）。 */
function refScanDocs() {
  const guides = readdirSync(path.join(ROOT, "docs"))
    .filter((f) => /^host-upgrade-guide.*\.md$/.test(f))
    .map((f) => `docs/${f}`)
    .filter((f) => f !== SIM_RENAMED_GUIDE)
    .sort();
  const docs = [...SYMBOL_DOCS_STATIC, ...guides];
  LAST_SCAN_DOC_COUNT = docs.length;
  return docs;
}

/** 从脚本自身文本里读覆盖面下限（自测能调它证锁）；抽不到返 null。 */
function refScanDocsMinimum() {
  const rec = fileRecord("scripts/docs-drift-check.mjs");
  const m = rec?.text.match(/^const REF_SCAN_DOCS_MINIMUM = (\d+);/m);
  return m ? Number(m[1]) : null;
}

/** 覆盖面自己也要被看守（#286 返工 R2）：份数下限 + 清单里点名却读不到的文档。 */
function collectRefScanCoverageErrors() {
  const out = [];
  const notes = [];
  const docs = refScanDocs();
  const minimum = refScanDocsMinimum();
  if (minimum === null) {
    out.push("ref-scan: 从 scripts/docs-drift-check.mjs 自己的文本里抽不到 `const REF_SCAN_DOCS_MINIMUM = <数字>;`——"
      + "覆盖面下限被删或改了写法（#164 口径：抽不到真值就报错，不许静默放行）");
  } else if (docs.length < minimum) {
    out.push(`ref-scan: 「符号锚点 + 裸行号棘轮」的覆盖面只剩 ${docs.length} 份文档，低于下限 **${minimum}** 份——`
      + `覆盖面是按 \`^host-upgrade-guide.*\.md$\` 实扫的，**把某份文档改名/移走就会静默缩面**（脚本和测试侧的 glob 一起少一份，`
      + `两边数字仍然相等）。要么把文档改回来，要么在提交信息里写明为什么覆盖面变小并把下限改成 ${docs.length}`
      + `（测试 test/docs-anchor-ratchet.test.js 里还硬编码了一份指南清单，两处必须一起改）`);
  }
  const unreadable = docs.filter((d) => fileRecord(d) === null);
  if (unreadable.length) {
    out.push(`ref-scan: 覆盖面清单里点名了却读不到的文档：${unreadable.join(", ")}——`
      + `硬编码那 ${SYMBOL_DOCS_STATIC.length} 份（README/AGENTS/契约/架构/图表/需求/pi 扩展 README）被改名或删除时，检查面会静默少一份，必须同步清单`);
  }
  notes.push(`ref-scan: 覆盖面 ${docs.length} 份文档（${SYMBOL_DOCS_STATIC.length} 份点名 + ${docs.length - SYMBOL_DOCS_STATIC.length} 份按目录实扫的升级指南），下限 ${minimum}`);
  collectRefScanCoverageErrors.notes = notes;
  return out;
}

/* ── #635 ①：文档里「点名几份 + 实扫几份 = 下限」这类**份数声称**必须等于实测 ─────────────
 * 病根：那句话是散文。脚本按目录实扫、测试侧另抄一份清单，两边自己算得没错，可**文档里写着的数**
 * 没人核对——现场：`README.md` 同一句里写着「That is 43 documents」又说「13 pinned + 32 …（= 45）」，
 * 两个数互相矛盾，而所有门禁一路绿（唯一被机器校过的是 `REF_SCAN_DOCS_MINIMUM = N` 那个常量声称）。
 * 判据（**静态对账**：一次目录扫描 + 几次正则，不跑 tsc、不跑 npm）：
 *   · 每份登记文档必须命中它登记的正则——句子被删也要红（否则「删掉这句话」就是合法逃逸）；
 *   · 每个捕获到的份数必须等于本文件自己算出来的真值（点名 = `SYMBOL_DOCS_STATIC.length`、
 *     实扫指南 = 目录里匹配的份数、合计、下限常量），红时点名「哪份文档的哪个数、声称多少、实测多少」。
 * 为什么真值取 `refScanDocs()`：它与覆盖面判据同源（自测的「改名一份指南」树形口子也照同一条路走），
 * 拿另算一份的目录数会让那条例外反向证多出一条与主题无关的红。
 */
const REF_SCAN_COUNT_CLAIMS = [
  {
    doc: README_EN,
    rules: [
      { re: /\((\d+) today, discovered from the directory\)/g, groups: ["guides"],
        label: "upgrade guides discovered from the directory" },
      { re: /That is (\d+) documents \(`REF_SCAN_DOCS_MINIMUM = (\d+)`: (\d+) pinned \+ the (\d+) upgrade-guide files/g,
        groups: ["total", "floor", "pinned", "guides"], label: "live-document count" },
    ],
  },
  {
    doc: README_CN,
    rules: [
      { re: /（当前 (\d+) 份，按目录实扫）/g, groups: ["guides"], label: "按目录实扫到的升级指南份数" },
      { re: /共 (\d+) 份（`REF_SCAN_DOCS_MINIMUM = (\d+)`：(\d+) 份点名 \+ 按目录实扫到的 (\d+) 份升级指南）/g,
        groups: ["total", "floor", "pinned", "guides"], label: "活文档份数" },
    ],
  },
  {
    doc: LEDGER_EN,
    rules: [
      { re: /The anchor face is \*\*(\d+) pinned documents \+ the (\d+) upgrade-guide files the directory scan finds = (\d+)\*\*\s*\(`REF_SCAN_DOCS_MINIMUM = (\d+)`\)/g,
        groups: ["pinned", "guides", "total", "floor"], label: "anchor-face document count" },
    ],
  },
  {
    doc: LEDGER_CN,
    rules: [
      { re: /锚点覆盖面是 \*\*(\d+) 份点名文档 \+ 按目录实扫到的 (\d+) 份升级指南 = (\d+)\*\*（`REF_SCAN_DOCS_MINIMUM = (\d+)`）/g,
        groups: ["pinned", "guides", "total", "floor"], label: "锚点覆盖面份数" },
    ],
  },
];

/** 份数声称的真值（与覆盖面判据同源：`refScanDocs()`）。 */
function refScanCountTruth() {
  const docs = refScanDocs();
  const pinned = SYMBOL_DOCS_STATIC.length;
  const floor = refScanDocsMinimum();
  return { pinned, guides: docs.length - pinned, total: docs.length, floor };
}

/** 把「点名 / 实扫 / 合计 / 下限」翻成人话（报错文案与 note 共用一份，别在别处再抄）。 */
const REF_SCAN_COUNT_LABEL = Object.freeze({
  pinned: "点名文档", guides: "实扫指南", total: "文档合计", floor: "下限常量",
});

function collectRefScanCountClaimErrors() {
  const out = [];
  const notes = [];
  const truth = refScanCountTruth();
  let claims = 0;
  for (const { doc, rules } of REF_SCAN_COUNT_CLAIMS) {
    const text = textOf(doc);
    if (typeof text !== "string") {
      out.push(`ref-scan-claims: ${doc} 读不到文本——份数声称面少一份，等于这份文档的数没人校`);
      continue;
    }
    for (const { re, groups, label } of rules) {
      const hits = [...text.matchAll(re)];
      if (!hits.length) {
        out.push(`ref-scan-claims: ${doc} 里找不到「${label}」那条份数声称——`
          + "句子被删也要红（否则删掉这句话就是合法逃逸；声称面登记在 REF_SCAN_COUNT_CLAIMS）");
        continue;
      }
      for (const m of hits) {
        const line = text.slice(0, m.index).split("\n").length;
        groups.forEach((key, i) => {
          const claimed = Number(m[i + 1]);
          const want = truth[key];
          claims += 1;
          if (claimed !== want) {
            out.push(`ref-scan-claims: ${doc}:${line} 声称「${REF_SCAN_COUNT_LABEL[key]}」${claimed}，`
              + `但脚本实测 ${want}——份数声称必须等于实测（${label}）；`
              + "改文档里的数，或把 SYMBOL_DOCS_STATIC / 目录里的指南一起改到一致");
          }
        });
      }
    }
  }
  notes.push(`ref-scan-claims: ${REF_SCAN_COUNT_CLAIMS.length} 份文档的 ${claims} 处份数声称全部等于实测`
    + `（点名 ${truth.pinned} / 实扫 ${truth.guides} / 合计 ${truth.total} / 下限 ${truth.floor}）`);
  collectRefScanCountClaimErrors.notes = notes;
  return out;
}

/* ── #644 ③：指令面必须指着声称链的新家 ────────────────────────────────────────
 * 搬链之后，AGENTS 里只剩「常量 + 一句指针」。指针本身也要有闸：把它删掉，下一位读者就再也找不到
 * 那条链（历史还在 docs/maintenance/，但指令面上没有任何线索）——这是「搬走了但没人知道搬哪去了」。
 * 判据是**存在性**（每份指令面文档必须点名自己语言的那一份账本），不是措辞对账。
 */
const LEDGER_POINTER_RULES = Object.freeze([
  { doc: AGENTS_EN, ledger: LEDGER_EN },
  { doc: AGENTS_CN, ledger: LEDGER_CN },
]);

function collectLedgerPointerErrors() {
  const out = [];
  for (const { doc, ledger } of LEDGER_POINTER_RULES) {
    const text = textOf(doc);
    if (typeof text !== "string") {
      out.push(`ledger-pointer: ${doc} 读不到文本——指令面少一份，指针判据在这份上失效`);
      continue;
    }
    if (!text.includes(ledger)) {
      out.push(`ledger-pointer: ${doc} 里没有指向 \`${ledger}\` 的指针——`
        + "符号锚点的实测流水整条住在那份账本里（issue #644 ③）；指令面上删掉这句指针，"
        + "下一位读者就找不到它，也就没人知道那条链搬哪去了");
    }
  }
  collectLedgerPointerErrors.notes = [`ledger-pointer: ${LEDGER_POINTER_RULES.length} 份指令面文档都指着各自的账本`];
  return out;
}

/** 行内代码形态的标识符（不是路径：干掉带 `/` 与 `.` 的东西）。 */
const INLINE_SYMBOL_RE = /`([A-Za-z_$][\w$]*)`/g;

/** **不是符号**的 JavaScript 字面量：它们出现在「值」的位置上，文档写 ``retry` 默认 `false`（`src/…`）``
 *  说的是「默认值长在哪个文件」，拿声明判据去问必然假红（`false` 在 orchestrator.js 里出现 102 次，
 *  却没有一条是声明）。这一档必须**逐个点名**，不许扩成正则去吞别的东西。 */
const SYMBOL_NOT_SYMBOL = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

/** 允许「具名字面量成员」当真理的引用文件（**逐份点名 + 写理由**）：这一档比声明弱一档，
 *  开给的是「文档在讲一个**字符串值**（终止原因 / 错误码），而该值就定义在被引文件里」的形状
 *  （`judge_done`、`provider_config`、`non_continuable`…）。逐文件点名而不是全仓开：
 *  全仓开等于把「同名字符串」当成通行票，#286 的病根正是这种宽进。条目空转 → 红。 */
const SYMBOL_VALUE_MEMBERSHIP = new Map([
  ["src/loop/orchestrator.js", "契约的终止原因表在这一列写「该 reason 由哪段代码产出」，被引符号里有相当一部分是 reason 字符串本身（`judge_done` / `no_final_guard` / `non_continuable`），不是变量名"],
  ["src/loop/termination.js", "同上：reason → errorCode 的映射表（`max_rounds_cap` 一类）在本文件里以字面量成员存在"],
  ["src/reflection/governor.js", "治理层的 stop 值（`completion` / `complete` / `noTool` / `cap`）是返回值字符串，契约表引的就是这些值"],
  ["src/providers/errors.js", "provider 错误码（`provider_config` 一类）以字符串成员定义"],
  // issue #743 建议项：契约的核验状态表把 CLI guard 的两个 skip reason 指到 `bin/final-guard.js:92` /
  // `:95`。它们是 `{ action: "skip", reason: "…" }` 里的**字符串值**，不是变量名 —— 加了这条点名之后
  // 这两个符号才第一次真的被校（此前坐标写成 `:86,89` 那种多行号形态，正则不匹配 ⇒ 整条锚点免检，
  // 而 86 / 89 两个行号本身是错的：86 是函数声明、89 是 `inspectRun` 调用）。
  ["bin/final-guard.js", "CLI guard 的 skip reason（`no_capture_evidence` / `no_extractable_candidates`）以字面量成员存在，契约的核验状态表引的就是这两个值"],
]);

/* ── #299：注释与字符串里的同名**不是**声明 ────────────────────────────────────
 * 病根（issue #299）：`symbolDeclarations` 逐行拿正则去匹配**原始文本**，于是
 *     /*
 *     const LEGACY_MODE = "x";     ← 注释里的一行，被当成真的绑定
 *     *\/
 * 这种形状会「证明」一个只活在注释里的名字是已声明；`valueLiterals` 同理，注释里写一句
 * `// "judge_done"` 就能给「具名字面量成员」那一档供一个假值。弱档最容易蒙混，因为它的真值
 * 本来就只是一串字符。
 * 修法：先做一遍**词法级**分类（代码 / 字符串字面量 / 注释），再让两条抽取各取所需——
 *   · `symbolDeclarations` 只看**代码**（注释与字符串都涂成空格）；
 *   · `valueLiterals` 看**代码 + 字符串**（注释涂成空格，字符串原样留着）。
 * 涂改只换非换行字符为空格 ⇒ 行号与原文逐行对齐，`fileLineCount` / 区间相交判据一字不用改。
 * 不做完整 AST（本仓零依赖，不引解析器）；正则字面量用「前一个有意义记号」判定，判不准时
 * 退回「当除号」——宁可少涂一格，也不要把后面整份文件吞进字符串里（那会让真声明集体消失，
 * 是比假绿更响的假红）。 */
const MASK_CODE = 0;
const MASK_STRING = 1;
const MASK_COMMENT = 2;
/** 正则字面量只可能出现在这些记号之后（`= /re/`、`( /re/`、`return /re/`…）；其余位置的 `/` 是除号。 */
const REGEX_ALLOWED_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">",
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else", "yield", "await"]);

/** 把 JS 文本按字符分类（代码 / 字符串 / 注释），返回与原文等长的 `Uint8Array`（换行位置不受影响）。 */
function jsMaskKinds(text) {
  const n = text.length;
  const kind = new Uint8Array(n);
  const mark = (from, to, k) => { for (let j = from; j < to; j += 1) if (text[j] !== "\n") kind[j] = k; };
  let i = 0;
  let prev = "";     // 上一个有意义的记号（标识符或单字符标点），用来分辨正则字面量与除号
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") { const s = i; i += 2; while (i < n && text[i] !== "\n") i += 1; mark(s, i, MASK_COMMENT); continue; }
    if (c === "/" && d === "*") {
      const s = i; i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i = Math.min(n, i + 2); mark(s, i, MASK_COMMENT); continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const s = i; const q = c; i += 1;
      while (i < n) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === q) { i += 1; break; }
        if (q !== "`" && text[i] === "\n") break;   // 未闭合的单行串：到此为止，别把后面整份文件当字符串
        i += 1;
      }
      mark(s, Math.min(i, n), MASK_STRING); prev = "string"; continue;
    }
    if (c === "/" && REGEX_ALLOWED_AFTER.has(prev)) {
      const s = i; i += 1; let inClass = false; let closed = false;
      while (i < n) {
        const ch = text[i];
        if (ch === "\\") { i += 2; continue; }
        if (ch === "\n") break;
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) { i += 1; closed = true; break; }
        i += 1;
      }
      if (closed) { while (i < n && /[a-z]/.test(text[i])) i += 1; mark(s, Math.min(i, n), MASK_STRING); prev = "regex"; continue; }
      i = s + 1; prev = "/"; continue;              // 不是正则：按除号处理，一格都不涂
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < n && /[\w$]/.test(text[j])) j += 1; prev = text.slice(i, j); i = j; continue; }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return kind;
}

/** 涂改后的文本（行号与原文逐行对齐）。`keepStrings: false` ⇒ 只剩代码；`true` ⇒ 代码 + 字符串字面量。 */
function maskJs(text, { keepStrings }) {
  const kind = jsMaskKinds(text);
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n") { out += ch; continue; }
    const k = kind[i];
    out += (k === MASK_COMMENT || (k === MASK_STRING && !keepStrings)) ? " " : ch;
  }
  return out;
}

/** 抽符号声明：逐行按「行首形态」匹配，返回 Map 名字 → 首次声明处。支持的形态就列在这里，
 *  报告与 AGENTS 的锚点分级段用同一份口径（够用即可，不做完整 AST——本仓零依赖，不引解析器）。
 *  #299：匹配的是**涂掉注释与字符串之后**的那份文本，注释里写一行 `const X = 1;` 不再算声明。 */
const SYMBOL_DECL_PATTERNS = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function"],
  [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, "binding"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+\{([^}]*)\}\s*=/, "解构绑定"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+\[([^\]]*)\]\s*=/, "解构绑定"],
  [/^\s*(?:export\s+)?\{([^}]*)\}\s*(?:;|$)/, "再导出"],
  [/^\s*(?:static\s+|get\s+|set\s+|async\s+|\*)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/, "方法"],
  [/^\s*(?:public\s+|private\s+|protected\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*:\s*(?![=:])/, "对象键/类字段"],
];

/** 控制流关键字：涂掉字符串之后 `case "x":` 会退化成 `case     :`，正好撞上「对象键/类字段」那条
 *  正则，凭空多出一个叫 `case` 的「符号」（#299 实测：只此两处，104 个文件里 decls 6223 → 6225）。
 *  这不是声明，逐个排掉；名单只收控制流词，别把 `get` / `set` / `async` 这类可能是真名字的收进来。 */
const JS_CONTROL_KEYWORDS = new Set(["if", "else", "case", "default", "return", "switch", "for", "while", "do",
  "try", "catch", "finally", "throw", "break", "continue", "new", "delete", "typeof", "instanceof", "in", "of",
  "void", "this", "super", "await", "yield", "function", "class", "const", "let", "var", "import", "export",
  "extends", "static"]);

/* 文件文本的进程内缓存（#286 T-a）。`--self-test` 要跑 85 轮全量检查，每轮都重新读一遍
 * orchestrator.js（350KB）× 两百多处引用，会把一条文档门禁拖到分钟级——那是「太慢所以会被跳过」的形状。
 * 口径：
 *   · 被 `--self-test` overlay 改过的文件**每次现读**（来源不同就必须重来，绝不吃缓存）；
 *   · 没被 overlay 的文件在本进程里只读一次——本脚本从头到尾是只读的，不存在自己改盘的路径；
 *   · 拆行与派生表（符号声明表、字面量集合）挂在同一条记录上，随文本一起失效——`--self-test` 会跑
 *     85 轮全量检查，每轮都把 350KB 的 `src/loop/orchestrator.js` 重拆一遍是把文档门禁拖到分钟级的错地方。
 * 早先的版本拿「长度 + 首尾 32 字」当文本身份，`src/a/b.js:12` → `src/a/c.js:12` 这种**等长**变异
 * 会命中旧缓存，自测里直接假绿（改了却不红）——所以身份判据必须是「是否被 overlay 覆盖」。 */
const FILE_LINE_CACHE = new Map();   // rel → { text, lines, decls, literals }

function fileRecord(rel) {
  const overlaid = OVERLAY.has(rel);
  const hit = FILE_LINE_CACHE.get(rel);
  if (hit && hit.overlaid === overlaid && (!overlaid || hit.text === textOf(rel))) return hit;
  let text;
  try { text = textOf(rel); } catch { return null; }
  const rec = { text, overlaid, lines: text.split("\n"), decls: null, literals: null };
  FILE_LINE_CACHE.set(rel, rec);
  return rec;
}

/** 文件的真实行数（末尾换行不是一行——`wc -l` 同口径，越界判据用它）；不存在返 null。 */
function fileLineCount(rel) {
  const rec = fileRecord(rel);
  if (!rec) return null;
  const n = rec.lines.length;
  return n > 1 && rec.lines[n - 1] === "" ? n - 1 : n;
}

function symbolDeclarations(rel) {
  const rec = fileRecord(rel);
  const lines = rec?.lines ?? null;
  if (!lines) return new Map();
  if (rec.decls) return rec.decls;
  const out = new Map();
  const all = new Map();        // #286 T-b1a R1：同一个名字在多处的全部声明位（区间相交判据要用全部）
  rec.declsAll = all;
  // #299：只看代码面。行号仍按原文计（涂改保换行），所以 `line` 与 `fileLineCount` / 区间判据同源。
  const codeLines = maskJs(rec.text, { keepStrings: false }).split("\n");
  const push = (n, i, kind) => {
    if (!n || JS_CONTROL_KEYWORDS.has(n)) return;
    if (!out.has(n)) out.set(n, { line: i + 1, kind });
    if (!all.has(n)) all.set(n, []);
    all.get(n).push({ line: i + 1, kind });
  };
  codeLines.forEach((line, i) => {
    for (const [re, kind] of SYMBOL_DECL_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const names = kind === "解构绑定" || kind === "再导出"
        ? m[1].split(",").map((p) => p.trim().split(/\s+as\s+/).pop().trim()).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
        : [m[1]];
      for (const n of names) push(n, i, kind);
    }
    // 环境变量：`process.env.ERIX_RETRY_ATTEMPTS` 被读的那一行就是它在 CLI 里的「定义处」（契约里
    // `ERIX_RETRY_ATTEMPTS`（`bin/cli.js:…`）引的就是它），不是声明语句，但同属「该文件里确有这个符号」。
    for (const m of line.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) {
      if (!out.has(m[1])) out.set(m[1], { line: i + 1, kind: "环境变量读取处" });
      if (!all.has(m[1])) all.set(m[1], []);
      all.get(m[1]).push({ line: i + 1, kind: "环境变量读取处" });
    }
  });
  rec.decls = out;
  return out;
}

/** 「具名字面量成员」那一档的真理：文件里出现过的字符串字面量内容（`"judge_done"` → `judge_done`）。
 *  只认整段字面量，不做「行里有这个词」那种宽判据。 */
function valueLiterals(rel) {
  const rec = fileRecord(rel);
  const lines = rec?.lines ?? null;
  if (!lines) return new Set();
  if (rec.literals) return rec.literals;
  const out = new Set();
  const byName = new Map();       // #286 T-b1a R1：具名字面量的出现行（区间相交判据在弱档上用的真值位）
  // #299：注释涂成空格、字符串原样留着——`// "judge_done"` 这种注释不再给弱档供值。
  maskJs(rec.text, { keepStrings: true }).split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/(["'])([A-Za-z_$][\w$]*)\1/g)) {
      out.add(m[2]);
      if (!byName.has(m[2])) byName.set(m[2], []);
      byName.get(m[2]).push(i + 1);
    }
  });
  rec.literalLines = byName;
  rec.literals = out;
  return out;
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** 找不到符号时点名「该文件里实际存在相近符号名」（#210/#286 口径：报错要能指路）。
 *  判据：互为前缀、互为子串、或编辑距离 ≤ 2（大小写折叠后）。最多报 5 个，按接近程度排。 */
function nearestSymbols(sym, decls) {
  const low = sym.toLowerCase();
  const scored = [];
  for (const [name, d] of decls) {
    const n = name.toLowerCase();
    let score = null;
    if (n === low) continue;
    if (n.startsWith(low) || low.startsWith(n)) score = 0;
    else if (n.includes(low) || low.includes(n)) score = 1;
    else if (editDistance(n, low) <= 2) score = 2;
    if (score !== null) scored.push({ score, text: `${name}（${d.kind} @ ${d.line}）` });
  }
  return scored.sort((a, b) => a.score - b.score || a.text.localeCompare(b.text)).slice(0, 5).map((s) => s.text);
}

/** 「符号 + 文件」的两种形态（`SYM`（`path`）与 markdown 链接）。提成模块级常量，是因为自测的
 *  打靶器 `mutateSymbolAnchor()` 必须与主检查用**同一套**提取逻辑（#279 的口径：打靶由提取逻辑定）。 */
/* #286 T-b1a R1：把 `:N` / `:N-M` 提成**独立捕获组**（原先是 `(?::\d+(?:-\d+)?)?` 的非捕获尾巴）。
 * 不捕获就看不见「这条符号锚点自带区间」，那条「区间必须与声明处相交」的判据（本节末）就无从下手。 */
const SYMBOL_ANCHOR_FORMS = [
  // `SYM`（`path`） / `SYM` (`path`) —— 全角半角括号都接，允许中间一个空格。
  // 允许带 :N / :N-M 行号后缀：带行号的「符号 + 文件」仍然是符号锚点（符号部分照校），
  // 行号部分则同时进 2.8.2 的裸行号棘轮——一条写法被两条锚点分别看守，互不掩盖。
  { re: /`([A-Za-z_$][\w$]*)`\s*[（(]\s*`([A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts))(:\d+(?:-\d+)?)?`\s*[)）]/g, kind: "括号并列" },
  // [SYM](path) / [`SYM`](./path#anchor)
  { re: /\[`?([A-Za-z_$][\w$]*)`?\]\(\.?\/?([A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts))(?:#[^)]*)?\)/g, kind: "markdown 链接" },
];

/** 从锚点尾巴 `:N` / `:N-M` 里抽出区间；没有区间后缀返 null（**本判据对它不适用**，见节末理由）。 */
function anchorSpan(span) {
  if (!span) return null;
  const m = span.match(/^:(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : null;
  return { from: a, to: b, lo: Math.min(a, b ?? a), hi: Math.max(a, b ?? a) };
}

/** 抽一份**文本**里的符号锚点，带 span（字符区间只覆盖**符号名本身**），供自测定点变异。 */
function symbolAnchorsInText(text, doc) {
  const found = [];
  let lineStart = 0;
  for (const [i, line] of text.split("\n").entries()) {
    for (const [fi, f] of SYMBOL_ANCHOR_FORMS.entries()) {
      f.re.lastIndex = 0;
      for (const m of line.matchAll(f.re)) {
        const sym = m[1];
        if (SYMBOL_NOT_SYMBOL.has(sym)) continue;          // JavaScript 字面量不是符号（见上面名单的理由）
        if (m[2].endsWith(".d.ts")) continue;              // 生成物声明文件不入库（#213），拿它当被引文件必然假红
        const lead = fi === 0 ? 1 : 1 + (m[0][1] === "`" ? 1 : 0);   // 前导的 `[` 与可选反引号
        const span = anchorSpan(m[3] ?? null);
        found.push({
          doc, line: i + 1, sym, file: m[2], form: f.kind, span,
          start: lineStart + m.index + lead, end: lineStart + m.index + lead + sym.length,
        });
      }
    }
    lineStart += line.length + 1;
  }
  return found;
}

/** 抽覆盖面里的符号锚点（按文档走 `textOf`，所以 `--self-test` 的内存副本被同一套逻辑扫）。
 *  返回每一处出现（不去重，逐处报）；报错时按 (符号, 文件) 归并成一条，点名所有引用处。 */
function symbolAnchorOccurrences(docs) {
  const found = [];
  for (const rel of docs) {
    const rec = fileRecord(rel);
    if (!rec) continue;
    found.push(...symbolAnchorsInText(rec.text, rel));
  }
  return found;
}

/** #286 T-a 自测的打靶器：把「符号 = `sym`、被引文件 = `filePath`」的**全部**锚点处的符号名换成 `to`。
 *  一处都没命中、或换完还剩着 → 原样返回，`runSelfTest` 的「变异没落上」判据就会报红（不给空跑假绿留门）。 */
function mutateSymbolAnchor(sym, filePath, to) {
  return (text) => {
    const hit = (t) => symbolAnchorsInText(t, "probe").filter((a) => a.sym === sym && a.file === filePath);
    const hits = hit(text).sort((a, b) => b.start - a.start);
    if (!hits.length) return text;
    let t = text;
    for (const h of hits) t = t.slice(0, h.start) + to + t.slice(h.end);
    return hit(t).length ? text : t;     // 该锚点还剩着 → 这一枪没打全，同样算没落上
  };
}

/** R1 判据：符号在被引文件里确有声明（或落在点名文件的「具名字面量成员」档）。 */
function symbolAnchorVerdict(sym, rel) {
  const lines = fileRecord(rel)?.lines ?? null;
  if (!lines) return { ok: false, missing: true };
  const decls = symbolDeclarations(rel);
  if (decls.size === 0) {
    return { ok: false, failure: true, why: "从被引文件里**抽不到任何符号声明**——检查面在该文件上失效（#164 口径：抽不到真值就报错，不许静默放行）" };
  }
  const hit = decls.get(sym);
  if (hit) return { ok: true, tier: `${hit.kind} @ ${hit.line}` };
  if (SYMBOL_VALUE_MEMBERSHIP.has(rel) && valueLiterals(rel).has(sym)) return { ok: true, tier: "具名字面量成员（点名文件一档）" };
  const near = nearestSymbols(sym, decls);
  return { ok: false, near, why: `该文件里没有 \`${sym}\` 的声明（支持的形态：function / class / const|let|var 绑定 / 解构绑定 / 再导出 / 方法 / 对象键、类字段 / process.env.X 环境变量读取处）` };
}

/* ── 2.8.1b 符号锚点自带的区间必须与声明处相交（issue #286 T-b1a R1）─────────────
 * 病根（#286）：`paths` 在解析 `path:line` 时把行号剥掉只校文件存在 ⇒ 行号漂到哪都绿。
 * 上面的 `symbols` 只回答「这个文件里到底有没有这个符号」，于是
 *   \`emitEvent\`（\`src/loop/orchestrator.js:1517-1531\`）
 * 这种「**符号对、区间错**」的写法一路全绿——而契约里这类条目占自带区间锚点的一半以上
 * （主 agent 独立复算：37 处带区间的锚点里 17 处不相交 = 46%，见工单 261016-286-tb1a §1）。样本：
 *   `emitEvent` 声明在 1669，文档写 1517-1531；`emitJudge` 在 1696，写 1544-1557；
 *   `sideEffect` 在 194，写 940-946；`completionSignalDetected` 在 3121，写 2739-2745。
 * 判据：区间 `[lo, hi]` 必须覆盖该符号在被引文件里的**至少一处真值位**（`lo <= p <= hi`）。
 *   · 取「全部」声明位而不是首处：`sideEffect` 这类名字在 orchestrator.js 里合法地出现在多处
 *     （194 的归一化与 1091 的 `fail()` 现场），只问首处会把说真话的那条判成假红；
 *   · 弱档（`SYMBOL_VALUE_MEMBERSHIP` 那 5 份点名文件里的字符串值）用「该字面量在文件里的出现行」
 *     当真值位——那一档承认的本来就是「值就定义在这里」，拿声明行去问必然假红；
 *   · **抽不到任何真值位 ⇒ 红**（#164：抽不到真值不许静默放行）。但同一处的 `symbols` 已经因为
 *     「该文件里没有这个符号」红了，这里不重复报（同一条根因交两条红会把自测的点名判据搅混），
 *     只在 note 里计数；
 *   · 不适用：不带区间的符号锚点（\`SYM\`（\`path\`））。那是**本刀首选的修法**——行号会漂而
 *     `symbols` 不需要它，删区间还会让裸行号棘轮合法下降（「确实少了一些」唯一可核对的写法）。 */

/** 一个符号在被引文件里的全部真值位（强档：全部声明位 + 环境变量读取处；弱档：具名字面量出现行）。 */
function symbolTruthPositions(sym, rel) {
  const rec = fileRecord(rel);
  if (!rec) return { tier: "missing", positions: [] };
  const first = symbolDeclarations(rel);              // 副作用：填好 rec.declsAll（全部声明位）
  const strong = rec.declsAll?.get(sym) ?? [];
  if (strong.length) return { tier: strong[0].kind, positions: strong.map((p) => p.line) };
  if (first.size === 0) return { tier: "抽不到任何声明", positions: [] };
  if (SYMBOL_VALUE_MEMBERSHIP.has(rel)) {
    valueLiterals(rel);                               // 副作用：填好 rec.literalLines
    const lines = rec.literalLines?.get(sym) ?? [];
    if (lines.length) return { tier: "具名字面量成员", positions: lines };
  }
  return { tier: "none", positions: [] };
}

/** 逐处判据：带区间的符号锚点 ⇒ 区间必须与真值位相交。不带区间返 null（不适用）。 */
function symbolAnchorSpanVerdict(o) {
  if (!o.span) return null;
  if (!fileRecord(o.file)) return { skip: true };    // 文件不存在：由 `symbols` 的「锚点是死的」那条点名
  const t = symbolTruthPositions(o.sym, o.file);
  if (!t.positions.length) return { noTruth: true, tier: t.tier };
  const hit = t.positions.filter((p) => p >= o.span.lo && p <= o.span.hi);
  if (hit.length) return { ok: true, tier: t.tier, hit };
  return { ok: false, tier: t.tier, truth: t.positions.slice(0, 6), total: t.positions.length };
}

/** #286 T-b1a R1 的逐处反向证靶子：把「符号 = `sym`」那一处锚点的**区间后缀**换成 `to`（`:N` / `:N-M` 整段）。
 *  与 `mutateSymbolAnchor` 同款纪律：打不上就原样返回，`runSelfTest` 的「变异没落上」会报红。 */
function mutateSymbolAnchorSpan(sym, filePath, to) {
  return (text) => {
    let hits = 0;
    // 捕获组的边界要数清楚：`sep` 这一组**已经含**路径前的那个反引号，闭合反引号是模式里的字面量（没进组）。
    // 早先重写时多补了一个反引号，变异结果成了 `path:94-100` 前面两个反引号 ⇒ 锚点整条解体（符号下限掉一组），
    // 于是这一例报的是「别的红」而不是本判据的红——#279 说的「变异器自己坏掉」就是这个形状。
    const out = text.replace(/`([A-Za-z_$][\w$]*)`(\s*[（(]\s*`)([A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts))(:\d+(?:-\d+)?)?`(\s*[)）])/g,
      (whole, s, sep, p, span, tail) => {
        if (s !== sym || p !== filePath || !span) return whole;
        hits += 1;
        return "`" + s + "`" + sep + p + to + "`" + tail;
      });
    return hits ? out : text;      // 一处都没打上 → 原样返回 → 「变异没落上」报红
  };
}

function collectSymbolAnchorSpanErrors(occurrences) {
  const out = [];
  const notes = [];
  const all = occurrences ?? symbolAnchorOccurrences(refScanDocs());
  const withSpan = all.filter((o) => o.span);
  const grouped = new Map();     // 同一条「符号 + 区间」在多处出现归并成一条红（与 symbol-anchor 同口径）
  let intersect = 0;
  let disjoint = 0;
  let noTruth = 0;
  for (const o of withSpan) {
    const v = symbolAnchorSpanVerdict(o);
    if (v?.skip) continue;
    if (v?.noTruth) { noTruth += 1; continue; }    // 同处已被 `symbols` 报红，不重复报
    const key = `${o.sym}|${o.file}|${o.span.from}-${o.span.to ?? ""}`;
    if (!grouped.has(key)) grouped.set(key, { sym: o.sym, file: o.file, span: o.span, v, sites: [] });
    grouped.get(key).sites.push(`${o.doc}:${o.line}`);
    if (v.ok) intersect += 1;
    else disjoint += 1;
  }
  for (const g of grouped.values()) {
    if (g.v.ok) continue;
    out.push(`symbol-anchor-span: ${g.sites.join(", ")} 引用 \`${g.sym}\`（\`${g.file}:${g.span.from}${g.span.to != null ? `-${g.span.to}` : ""}\`），`
      + `但自带区间 [${g.span.lo}, ${g.span.hi}] 与 \`${g.sym}\` 在 ${g.file} 里的**声明处不相交**——真值位在 `
      + `${g.v.truth.join(" / ")}${g.v.total > g.v.truth.length ? ` 等 ${g.v.total} 处` : ""}（真值形态 ${g.v.tier}）。`
      + "\`#286\` 的裸行号漂移就是这形状：符号对、区间错，而 `paths` 会把行号剥掉只看文件在不在 ⇒ 全绿。"
      + `修法二选一：① 删掉区间只留 \`${g.sym}\`（\`${g.file}\`）——首选，行号会漂而符号判据不需要它；② 把区间改成真的覆盖声明行`);
  }
  notes.push(`symbol-anchor-span: 覆盖面 ${all.length} 处符号锚点里自带区间 ${withSpan.length} 处：相交 ${intersect} 处 / 不相交 ${disjoint} 处`
    + `（另 ${noTruth} 处抽不到真值位，同处已由 symbol-anchor 报红）；不带区间的 ${all.length - withSpan.length} 处本判据不适用`);
  collectSymbolAnchorSpanErrors.notes = notes;
  return out;
}

/** 符号锚点的**只增不减下限**（#286 T-a 返工 R1）。为什么必须有它：裸行号棘轮的唯一键是
 *  (文档, 目标文件, 行区间)，**不含文档行号**——于是把
 *  `emitEvent`（`src/loop/orchestrator.js:1517-1531`）改写成不带括号、不带链接的裸
 *  `src/loop/orchestrator.js:1517-1531`，棘轮那一侧的计数**一字不变**（照旧绿），而符号声明校验
 *  整条消失。没有这条下限，#286 后面几刀就能「一边把裸行号换成符号锚点、一边偷偷退回去」而全程全绿。
 *  与 `BARE_LINE_REF_BASELINE` 同构：生效值从脚本**自身文本**里读（自测能把它调高来证它真的是锁）。
 *  现值 = 我自己那条 note 打出来的唯一 (符号, 文件) 组数 / 处数（跑 `--verbose` 现读，本文不抄）。
 *  历史（每一次抬高下限的链项：哪次合并、引了哪些符号、在哪棵树上量的）**不在本文件**：
 *  issue #644 ③ 把它整条搬到了 `docs/maintenance/symbol-anchor-ledger.md`（历史类文档，正文有命中数钉子）。
 *  抬底记录（issue #772，代号 261107-21）：把两轴载荷表**下**口径段的 4 处裸行号按 #286 首选修法改成符号锚点
 *  （`residueStart`（`src/loop/orchestrator.js`） 是新增的那一组），note 自己报「实测 238 组 > 下限 237 组
 *  … 请把 SYMBOL_ANCHOR_MIN_UNIQUE 升到 238」⇒ 按它现报的数抬，不在旧值上做加法。
 *  抬底记录（issue #769 R8，在 `wt-769w8` 这棵树 @ `727af80` 上量：242 → **243**）：本链在两份契约里净增了符号
 *  锚点，`node scripts/docs-drift-check.mjs --verbose` 在这棵树上现报（逐字）：
 *  「✓ symbol-anchor: 实测 243 组 > 下限 242 组——符号锚点在变多（好方向），请把 SYMBOL_ANCHOR_MIN_UNIQUE 升到 243，否则下限就在空转」
 *  ⇒ 抬到它现报的那个数，**不在旧值上做加法**：242 是主干 `4f9b908` 的值（`git show 4f9b908:scripts/docs-drift-check.mjs` 可复核），
 *  243 是扇描器在这棵树上现报的。同批把**现值声称**一起抬：`AGENTS.md` / `AGENTS_cn.md` 各一处（`test/static-guards.test.js`
 *  规则 4 拿脚本真值校这两处，中英必须同值）、`docs/maintenance/command-reference.md` / `_cn.md` 各一处（同是现值句）。
 *  为什么不能只做这一半：下限停在 242 时，下面那例「把中英契约的 `defaultSleep` 退化成裸行号」退化完恰好是
 *  242 组 = 下限 ⇒ 不红 ⇒ 那例等的那条红根本不出现（CI 上报的就是这个，不是断言太严）。
 *  这里只留判据与写法：`const SYMBOL_ANCHOR_MIN_UNIQUE = <数字>;` 必须保持一行（自测的两例要改这个数）。 */
const SYMBOL_ANCHOR_MIN_UNIQUE = 243;

/** 从脚本自己的文本里读下限（走 `fileRecord` ⇒ `--self-test` 的内存副本同样生效）；抽不到返 null。 */
function symbolAnchorMinUnique() {
  const rec = fileRecord("scripts/docs-drift-check.mjs");
  const m = rec?.text.match(/^const SYMBOL_ANCHOR_MIN_UNIQUE = (\d+);/m);
  return m ? Number(m[1]) : null;
}

function collectSymbolAnchorErrors() {
  const out = [];
  const notes = [];
  const docs = refScanDocs();
  const occurrences = symbolAnchorOccurrences(docs);
  out.push(...collectSymbolAnchorSpanErrors(occurrences));   // 2.8.1b：自带区间的相交校（#286 T-b1a R1）
  notes.push(...collectSymbolAnchorSpanErrors.notes ?? []);
  const groups = new Map();
  for (const o of occurrences) {
    const key = `${o.sym}|${o.file}`;
    if (!groups.has(key)) groups.set(key, { ...o, sites: [] });
    groups.get(key).sites.push(`${o.doc}:${o.line}`);
  }
  let literalTier = 0;
  let truthFailure = 0;
  const kindCensus = {};   // 报告「实际支持的声明形态里，语料真的用到了哪几种」——别只让注释自称支持
  for (const g of groups.values()) {
    const v = symbolAnchorVerdict(g.sym, g.file);
    if (v.ok) {
      if (v.tier.startsWith("具名字面量")) literalTier += 1;
      const kind = v.tier.split(" @ ")[0];
      kindCensus[kind] = (kindCensus[kind] ?? 0) + 1;
      continue;
    }
    if (v.missing) {
      out.push(`symbol-anchor: ${g.sites.join(", ")} 引用 \`${g.sym}\`（\`${g.file}\`），但 ${g.file} 在本仓不存在——`
        + `符号锚点的真理在被引文件里，文件没了这条锚点就是死的（改路径或删锚点，不许留）`);
      continue;
    }
    if (v.failure) {
      truthFailure += 1;
      out.push(`symbol-anchor: ${g.sites.join(", ")} 引用 \`${g.sym}\`（\`${g.file}\`），${v.why}`);
      continue;
    }
    out.push(`symbol-anchor: ${g.sites.join(", ")} 引用 \`${g.sym}\`（\`${g.file}\`，${g.form}），${v.why}${v.near?.length ? `\n      ↳ ${g.file} 里实际存在的相近符号：${v.near.join(" / ")}` : ""}`);
  }
  // 返工 R1：符号锚点的只增不减下限。低于下限 = 有人把符号锚点**退化成裸行号**（棘轮看不见那种退化）。
  const minUnique = symbolAnchorMinUnique();
  if (minUnique === null) {
    out.push("symbol-anchor: 从 scripts/docs-drift-check.mjs 自己的文本里抽不到 `const SYMBOL_ANCHOR_MIN_UNIQUE = <数字>;`——"
      + "下限常量被删或改了写法，这条锚点失效（#164 口径：抽不到真值就报错，不许静默放行）");
  } else if (groups.size < minUnique) {
    out.push(`symbol-anchor: 覆盖面里唯一 (符号, 文件) 只剩 ${groups.size} 组，低于下限 **${minUnique}** 组——符号锚点在**退化成裸行号**：`
      + `把 \`SYM\`（\`path:N\`） 改成不带括号/链接的裸 \`path:N\`，裸行号棘轮的计数一字不变（它的唯一键里没有文档行号），`
      + `只有这条下限会红（#286 T-a 返工 R1）。要么把符号锚点补回来，要么在提交信息里写明**新增**了什么并把常量升到 ${groups.size}`);
  } else if (groups.size > minUnique) {
    notes.push(`symbol-anchor: 实测 ${groups.size} 组 > 下限 ${minUnique} 组——符号锚点在变多（好方向），`
      + `请把 SYMBOL_ANCHOR_MIN_UNIQUE 升到 ${groups.size}，否则下限就在空转`);
  }
  const byFile = {};
  for (const o of occurrences) byFile[o.doc] = (byFile[o.doc] ?? 0) + 1;
  notes.push(`symbol-anchor: 覆盖面 ${docs.length} 份文档里「符号 + 文件」锚点 ${occurrences.length} 处（唯一 (符号, 文件) ${groups.size} 组：${Object.entries(byFile).map(([d, n]) => `${d} ${n}`).join("、") || "（无）"}）；` + `其中「具名字面量成员」一档 ${literalTier} 组（引用文件已逐份点名，见 SYMBOL_VALUE_MEMBERSHIP）、抽不到真值 ${truthFailure} 组；`
    + `命中的声明形态：${Object.entries(kindCensus).map(([k, n]) => `${k} ${n}`).join("、") || "（无）"}`);
  collectSymbolAnchorErrors.notes = notes;
  return out;
}

// ── 2.8.2 裸行号棘轮（issue #286 T-a：#286 B 方案第一批，**只减不增**）───────────
// 病根：`paths` 那条锚点在解析 `path:line` 时**主动剥掉行号**（`extractRefOccurrences` 里的
// `p.replace(/:\d+(?::\d+)?$/, "")`），只校文件是否存在 ⇒ 行号漂到别的代码段、甚至漂出文件末尾，
// 门禁全绿无人报警。确凿样本（#286）：契约说 `emitEvent` 在 `src/loop/orchestrator.js:1517-1531`，
// 真身在 1660 一带；中英契约各一处 `src/store/notes.js:398-405` 而该文件只有 383 行（越界）。
// 本单**不做批量替换**（那是 T-b/T-c）：先把「还剩多少」钉成一个只减不增的数，
// 再把已经确证的 2 处越界改掉。T-b/T-c 把存量换成符号锚点后，实测数会往下走，
// 那时降基线必须写理由（与本仓 `check:types` 的 `BASELINE_ROOT` 同构）。
/** 裸行号引用（`path:N` / `path:N-M`）的正则；覆盖面与 2.8.1 同一批文档（同一份理由）。
 *  实测值不靠注释：`--verbose` 会把「唯一区间数 / 出现次数 / 豁免数」打进 note（工单口径的三个数是
 *  现在的数在 note 里，基线常量的注释里写了它是怎么从 248 降到 232 的。非 `src/` 前缀（`bin/cli.js:88`、`test/x.js:9`）
 *  同样会漂，但本批把覆盖面钉在工单那条正则上，扩前缀归 T-b（扩时要重新登记基线）。
 *  唯一 (文档, 目标文件, 行区间) 与工单口径可复现：脚本自己数出来的数在下面那条 note 里，别只信注释。 */
const BARE_LINE_RE = /src\/([A-Za-z0-9_./-]+\.js):(\d+)(?:-(\d+))?/g;
/** 棘轮基线：唯一 (文档, 目标文件, 行区间) 实测 236，减去 4 处声明式豁免 ⇒ **232**。
 *  降它必须写理由；抬它必须写「为什么这次允许变差」。**不许悄悄抬**（同 `check:types` 棘轮的纪律）。
 *  降基线的理由（#286 T-b1a，244 → **232**，降 12）：契约 EN/CN 的 `src/loop/orchestrator.js` 锚点族按新判据
 *  「区间必须与声明处相交」逐条改绿——4 处**删掉区间**（`emitEvent` 1517-1531、`emitJudge` 1544-1557、
 *  `shouldContinue` 2739-2740、`dispatchAttemptEvent` provider-runner 96-110；中英各一份 ⇒ 8 个唯一键），
 *  另有 2 个唯一键是**三条不同写法指向同一段真身**（2739-2745 / 2742-2745 / 2743-2745 全部是
 *  `completionSignalDetected` 的声明处 3121-3125）合并成一条 ⇒ 每份文档再降 2 处。
 *  写法必须保持 `const BARE_LINE_REF_BASELINE = <数字>;` 一行（自测的「调低就红」用例要能改这个数）。
 *
 *  降基线的理由（#286 **T-b1b**，178 → **144**，本刀累计 232 → 144、降 88）：终止裁决决策表及其后三节里
 *  剩余的 orchestrator 区间同样按结局 (a) 删区间 + 写进真名（`runToolLoop` / `messageRounds` /
 *  `maxNoToolRounds` / `budgetRounds` / `continuationExhausted` / `errorHashes` / `termination` /
 *  `judge_done`），中英同一条目同时改（各 17 处）。
 *  保留 16 条区间（每份文档同一批：7 条符号锚点自带区间 + 9 条范围性事实），逐条理由见
 *  `docs/delivery/261016-286-tb1b-delivery.md`。
 *  降基线的理由（工单 261016-305 / issue #305，144 → **142**，降 2）：把 `jsonCandidates` 从
 *  `src/reflection/wrapup.js` 提取到 `src/text/json-candidates.js` 之后，该文件少了 30 行，中英契约里
 *  那条指向收尾/`judge` 文本归一化器的 `src/reflection/wrapup.js:132-135` **越界**（文件只剩 106 行），
 *  两条引用各改成不带区间的符号锚点 `normalizeWrapupWithLlm`（`src/reflection/wrapup.js`）
 *  降基线的理由（issue #326 wo-C，140 → **138**，降 2）：折叠摘要事实行 / TTL 降级事实行要写进 `orchestrator.js`，
 *  该文件行数一变，中英契约里两处**符号锚点自带区间**（`sideEffect` `1093-1098`、`no_final_guard` `1663-1665`）
 *  就与声明处不相交了 —— 按本文件与 AGENTS 的首选修法**删掉区间只留符号**（符号判据不需要行号），
 *  于是每处少一个唯一区间键。区间本身是错的（真值位在别处），删掉它同时消掉一处会漂移的假精度。
 *  降基线的理由（工单 P / issue #386 切片 1，136 → **132**，降 4）：`src/loop/termination.js` 与
 *  `src/loop/orchestrator.js` 因 finalGuard payload 的组装与上限常量各长了一截，中英契约里四处
 *  **符号锚点自带区间**（`notifyModelMetadataMissing` `916-969`、`errorReason` `173-176`，中英各两处）
 *  与声明处不再相交——同样按首选修法**删掉区间只留符号**（`symbols` 判据不需要行号），
 *  每处少一个唯一区间键 ⇒ 实测 136 唯一区间 − 4 处豁免 = **132**（`--verbose` 可复核：
 *  出现 162 次 / 唯一 136 处 / 豁免 4 处）。
 *  降基线的理由（#286 **T-b2**，130 → **80**，降 50）：`src/loop/provider-runner.js`（18 个唯一键）、
 *  `src/loop/termination.js`（15 个）、`src/reflection/governor.js`（18 个）三族剩下的裸行号引用
 *  在中英契约里逐处换成「符号 + 文件」锚点（首选修法：删区间，只留符号）。保留的 4 个键全是**符号锚点
 *  自带区间**（`terminationReasonForAction` :111 与 `max_rounds_cap` :116，中英各一）：那两条是 `--self-test`
 *  四条区间变异体的靶子，删掉区间就等于把反向证拆了。`--verbose` 可复核：出现 99 次 / 唯一 84 处 /
 *  豁免 4 处 ⇒ 80。
 *  降基线的理由（#286 **T-c**，80 → **6**，降 74）：中英契约与 `docs/host-upgrade-guide-0.17.0.md` 里剩下的
 *  **76 个裸行号键**逐处换成「符号 + 文件」锚点（首选修法：删区间只留符号），族别：`src/loop/orchestrator.js`
 *  24 键（`persist` / `replayForToolUse` / `fail` / `noToolRound` / `stallWindow` / `stallStreak` /
 *  `isEndTurn` / `finalGuardRetryLimit` / `appendEngineMessagesToTranscript` / `callRoundJudge` /
 *  `no_final_guard`）、`src/providers/errors.js` 6、`src/providers/openai.js` 6、
 *  `src/providers/anthropic.js` 4、`src/skills/loader.js` 4、`src/loop/run-snapshot-executor.js` 4
 *  （含 0.17.0 指南两处）、其余 12 个单点文件各 2 键（`index` / `canonical` / `projection` /
 *  `aggregate-budget` / `budget` / `api-key` / `json-file` / `static` / `compact/budget` /
 *  `sliding-window` / `reflection` / `notes-port` / `tools/notes`）。
 *  保留的 6 个键**全是 `--self-test` 的靶子**，不是区间事实（删掉区间等于把反向证拆了）：
 *  - `terminationReasonForAction` :111 中英各一：EN 是「改窄成 :112-116 ⇒ 与声明处不相交」那一例；
 *    CN 是越界（`99999-111`）、下界（`0-111`）、目标文件不存在（`__no_such_probe__.js:111`）三例的
 *    **逐字替换**靶子。
 *  - `max_rounds_cap` :116 中英各一：EN 改窄到 `:300-301`（弱档真值位）、CN 删区间证放行（本判据对
 *    不带区间的锚点不适用）。
 *  - `defaultSleep` :16 中英各一：CN 的「整段挪到 :30」变异体；中英「一起退化成裸行号」那一例**逐字替换**
 *    这两处的文本（(符号, 文件) 按全局去重 ⇒ 只退一侧掉不了组，必须两侧一起退）。
 *  **T-b2 的注释把保留面写成 4 个键（只算 termination 的两组），漏了 `defaultSleep` 那两处**——那两处同样
 *  被自测逐字依赖。这 6 处也不是空转的摆设：区间必须与声明处相交，所以这三个符号哪天换了行，
 *  `symbol-anchor-span` 会红（它们同时也是本判据在覆盖面里仅剩的活样本）。
 *  `--verbose` 可复核：出现 13 次 / 唯一 10 处 / 豁免 4 处 ⇒ **6**（另 3 处是 `pi-subagents:` 外仓前缀，
 *  见 `EXTERNAL_REPO_PREFIXES`，既不进棘轮也不查存在性）。 */
const BARE_LINE_REF_BASELINE = 6;

/** 棘轮生效值：从**本脚本自己的文本**里读 `BARE_LINE_REF_BASELINE`（走 `textOf`，所以 `--self-test`
 *  能把这个常量临时改小来证「它真的是锁」：调低到低于实测值必须红，改回来必须绿）。
 *  读不到（常量被删/改格式）= 检查面失效 → 返 null，调用侧按 #164 口径报红，不静默放行。 */
function bareLineBaseline() {
  const rec = fileRecord("scripts/docs-drift-check.mjs");
  const m = rec?.text.match(/^const BARE_LINE_REF_BASELINE = (\d+);/m);
  return m ? Number(m[1]) : null;
}

/** 声明式豁免（**条目 + 就地声明**双条件，缺一个不放行；命中要计数，条目空转就红）。
 *  沿用 #286 已落在 `test/static-guards.test.js` 的 `LOCAL_ARCHIVE_DIRS` + `LOCAL_ARCHIVE_DECLARATION` 口径，
 *  不另造一套。这里能进来的只有「目标文件本来就不存在」的示例/外仓路径：4 处，全部逐条点名。
 *  判据函数 `bareLineExemptionVerdict()` 是纯函数，反向证直接拿它问。 */
const BARE_LINE_EXEMPTIONS = [
  {
    doc: "docs/host-consumer-contract.md",
    target: "src/a/b.js",
    decl: /…|示例|示意|举例|例如|for example|placeholder|虚构/,   // 引用行末尾的 `…` 就是「这是格式样例里的占位值」的声明
    why: "契约的折叠摘要一节举的**锚点索引格式样例**（`src/a/b.js:12` 是本仓不存在的示意路径，同行还有 `shas: 1ed3f35, …`），不是引用；就地声明 = 行末的省略号占位符",
  },
  {
    doc: "docs/host-consumer-contract_cn.md",
    target: "src/a/b.js",
    decl: /…|示例|示意|举例|例如|for example|placeholder|虚构/,
    why: "同 EN 侧：CN 契约同一处举的示例锚点，中英成对，条目也必须成对",
  },
  {
    doc: "docs/host-upgrade-guide-v030.md",
    target: "src/pi/runner.js",
    decl: /apps\/worker\/|app_container/,      // 引用行写的就是宿主仓的**完整路径** `apps/worker/src/pi/runner.js:50`，不是本仓根相对路径
    why: "宿主 app_container 仓的调用点（原文写全路径 apps/worker/src/pi/runner.js:50），不是本仓文件；就地声明 = 行里带着外仓根 apps/worker/",
  },
  {
    doc: "docs/host-upgrade-guide-v030_cn.md",
    target: "src/pi/runner.js",
    decl: /apps\/worker\/|app_container/,           // 与 EN 侧同一段（中文句子，但路径字面量同样写全）
    why: "同 EN 侧：0.2.0 指南的宿主基线配置段，指的是 app_container 仓自己的调用点",
  },
];

/** 纯函数判据（#286 口径 + 返工 R4 收紧）：**三个信号缺一不放行**
 *   ① 表里有这一条（按 文档 + 目标路径 点名，无通配）；
 *   ② 引用行里**确实写着那个占位路径**（`lineText.includes(entry.target)`）——从前少了这一条，
 *      于是「同一行里还剩着一句 for example」这类附带措辞就能把声明这一侧糊过去（评审 R4）；
 *   ③ 引用行里还有「示例/示意/外仓根」这类就地声明词。
 *  ②③ 必须落在**同一行**：现存的 4 条豁免全部天然同行，而「紧邻行也算」只会把判据重新放软
 *  （#273 早写过：上一行常常是另一条目里顺手带出的字样）。
 *  条目自己还要过 `bareLineExemptionEntryErrors()` 的配置校（声明词不许匹配空串、不许带 g 标志）。
 *  也试过把「引用原文」整条钉死（连示例里的行号一起 pin），放弃：那会让 T-b 改一个示例数字都得回来动登记表，
 *  这里要的是「占位路径 + 声明词同时在场」这条下限，不是把文档文本冻住。 */
function bareLineExemptionVerdict({ doc, target, lineText }) {
  const entry = BARE_LINE_EXEMPTIONS.find((e) => e.doc === doc && e.target === target);
  if (entry === undefined) return { exempt: false, why: "没有对应的豁免条目" };
  if (!lineText.includes(entry.target)) {
    return { exempt: false, why: `引用行里没有豁免条目指向的占位路径 ${entry.target}（评审 R4：光有声明词不算声明）`, entry };
  }
  if (!entry.decl.test(lineText)) {
    return { exempt: false, why: "引用行没有「示例/示意/宿主仓根」这类就地声明词", entry };
  }
  return { exempt: true, entry };
}

/** 豁免表自己的配置校（评审 R4）：声明词若能匹配空串 = 这一侧恒真，双条件退化成单条件；
 *  带 `g`/`y` 标志的 `.test()` 有状态，同一行问两次会给出不同答案（判据不可复现）。两种都点名。 */
function bareLineExemptionEntryErrors() {
  const out = [];
  for (const e of BARE_LINE_EXEMPTIONS) {
    if (!(e.decl instanceof RegExp)) {
      out.push(`bare-lines: 豁免条目 ${e.target}（${e.doc}）的 decl 不是正则——就地声明判据无法执行`);
      continue;
    }
    if (e.decl.global || e.decl.sticky) {
      out.push(`bare-lines: 豁免条目 ${e.target}（${e.doc}）的 decl 带 g/y 标志——test() 有状态，`
        + `同一行问两次会得到不同答案，判据不可复现`);
    }
    e.decl.lastIndex = 0;
    if (e.decl.test("")) {
      out.push(`bare-lines: 豁免条目 ${e.target}（${e.doc}）的 decl 能匹配空串（${String(e.decl)}）——`
        + `「就地声明」这一侧恒真，双条件退化成了单条件（评审 R4），换一个真的判据`);
    }
  }
  return out;
}

/**
 * 标记区定点豁免（issue #772）：两轴载荷表（`docs/host-consumer-contract*.md` 里
 * `<!-- erix:snapshot-cell-axes:begin|end -->` 之间那 14 格）每格都**必须**写 `file:line` 的写点与读者，
 * 这一段天生是「裸行号密度最高、但已被机器逐条复核」的形状。三条口径，缺一不可：
 *   ① **位置**：只认那对 begin/end 标记**之间**、且以 `|` 开头的表格行；标记区外的裸行号照旧逐条计数，
 *      同一个 (文档, 目标文件, 行区间) 只要还在区外出现过一次就**不**豁免（`regionOutside`）。
 *   ② **机器复核 = 闸自己重算**（#772 R3）：锚点表住在 `scripts/cell-axes-anchors.mjs`，闸与专用契约测试
 *      **import 同一份**；闸拿登记锚点在源码里**当场**搜唯一命中行号，与两份契约表里写的 `path:line`
 *      逐组等值对账。命中 0 或 >1（歧义）/ 表里行号漂了 / 这一格这一轴没登记锚点 ⇒ 这一组**不再被豁免**，
 *      回到裸行号棘轮计数，并另发一条点名错误。闸不 spawn 测试（它是纯文档闸），也不读测试算出的结果。
 *   ③ **不静默**：豁免数进 `--verbose` 的分解；判据不在场时另发一条点名错误，而不是静默少算。
 *  越界 / 不存在 / 反向区间照旧逐条查——豁免只免「计入棘轮」这一档，未免「行号复核」那一档。 */
const CELL_AXES_MARK_BEGIN = "<!-- erix:snapshot-cell-axes:begin -->";
const CELL_AXES_MARK_END = "<!-- erix:snapshot-cell-axes:end -->";
const CELL_AXES_GUARD_TEST = "test/contract-snapshot-cell-axes-767.test.js";
/** #772 R3：闸对测试文件只核它**真能核**的那一件事实——专用契约测试在场、且真的 import 了锚点模块
 *  （= 两边读的是同一份登记表）。R2 那一族「正则认测试文件形状」的声称已经撤掉（`CELL_AXES_GUARD_LABEL`
 *  /`_DEF`/`_CALL`/`_LINE_DEF`/`_LINE_USE`/`_EQ_DEF`/`_EQ_USE`）：实测把 G4 的键名判据削弱成只查行号
 *  存在，那些形状照样在场、闸照样点头——它认的是**字形**而不是**判据**，正是 fail-open（self-test
 *  第 1 条红就是它）。语义那一档改由闸**自己**按锚点重算（见 `cellAxesRegionExemption()`），
 *  不再靠「猜测试长什么样」。 */
const CELL_AXES_GUARD_IMPORT = /from\s+["'][^"']*scripts\/cell-axes-anchors\.mjs["']/u;/** 表里两轴列的仓内引用（与测试侧的 `CITATION` 同形，只取 src/ 与 bin/）。 */
const CELL_AXES_SIDE_REF = /(?:src|bin)\/[A-Za-z0-9_./-]+\.js:[0-9]+/gu;
const CELL_AXES_DOCS = [CONTRACT_EN, CONTRACT_CN];

/** 标记区在这份文档里的行区间（0 基，不含标记行本身）；没有成对标记 → null。 */
function cellAxesRegion(rec) {
  if (!rec) return null;
  let begin = -1;
  let end = -1;
  rec.lines.forEach((line, i) => {
    if (begin < 0 && line.includes(CELL_AXES_MARK_BEGIN)) begin = i;
    else if (begin >= 0 && end < 0 && line.includes(CELL_AXES_MARK_END)) end = i;
  });
  return begin >= 0 && end > begin ? { begin, end } : null;
}

/**
 * #772 R2 M2 的**正向**不变量（评审 follow-up 第 1 条）：「标记区定点豁免」只免那一**张表**，
 * 而它原来只靠「豁免只认 `|` 开头的行」兼容——把 `begin` 往上搬，一大段无关正文就落进标记区里，
 * 没人报红（将来它们只要被改写成表格形状就能蹭进豁免的地盘）。于是钉死：
 *   区域内每一行要么以 `|` 开头（表格行），要么是标记行 / 空行 / 下面登记过的**口径行**；
 *   出现普通正文行 ⇒ 红。登记的口径行用不上同样红（同 `BARE_LINE_EXEMPTIONS`：登记了没人用 = 后门）。
 * 不用「豁免条数上限」那种数值禁——下一次加格子就会把它抬掉。
 */
const CELL_AXES_CALIBER_LINES = {
  [CONTRACT_EN]: [],
  [CONTRACT_CN]: [],
};

/**
 * 登记表的**生效值从本脚本自己的文本里读**（与 `BARE_LINE_REF_BASELINE` / `SYMBOL_ANCHOR_MIN_UNIQUE`
 * 同构）。不这么写的话 `--self-test` 的覆盖层根本改不动它——R2 那条「塞一条区域内没有的口径行 ⇒ 红」
 * 的自测例正是这样**空转**的：overlay 只改文本，改不了已加载的运行时数组，那条假条目从没被看过一眼
 * （#772 R3：这是第 3 条红的真实根因，不是判据没写）。
 */
function cellAxesCaliberLines() {
  const rec = fileRecord("scripts/docs-drift-check.mjs");
  const m = rec?.text.match(/^const CELL_AXES_CALIBER_LINES = (\{[\s\S]*?\n\});$/mu);
  if (!m) {
    return { why: "从 scripts/docs-drift-check.mjs 自己的文本里抽不到 `const CELL_AXES_CALIBER_LINES = { … };`——" + "登记表被改了写法 ⇒ 区域内容不变量无从对账（#164 口径：抽不到真值不许静默放行）" };
  }
  try {
    const table = new Function("CONTRACT_EN", "CONTRACT_CN", `"use strict"; return (${m[1]});`)(CONTRACT_EN, CONTRACT_CN);
    if (table === null || typeof table !== "object") return { why: "CELL_AXES_CALIBER_LINES 不是对象字面量" };
    return { table };
  } catch (error) {
    return { why: `CELL_AXES_CALIBER_LINES 的字面量跑不通：${error.message}` };
  }
}
const CELL_AXES_MARK_LINE = /^<!--[\s\S]*-->$/u;

function cellAxesRegionContentErrors() {
  const out = [];
  const notes = [];
  let tableRows = 0;
  let allowed = 0;
  const caliber = cellAxesCaliberLines();
  if (caliber.why) out.push(`cell-axes-region: ${caliber.why}`);
  for (const doc of CELL_AXES_DOCS) {
    const rec = fileRecord(doc);
    const region = cellAxesRegion(rec);
    if (region === null) continue;
    const registered = caliber.table?.[doc] ?? [];
    const used = new Set();
    rec.lines.slice(region.begin + 1, region.end).forEach((line, offset) => {
      const at = region.begin + 1 + offset + 1;          // 1 基行号
      const trimmed = line.trim();
      if (trimmed === "") { allowed += 1; return; }
      if (line.trimStart().startsWith("|")) { tableRows += 1; return; }
      if (CELL_AXES_MARK_LINE.test(trimmed)) { allowed += 1; return; }
      const hit = registered.find((entry) => entry === trimmed);
      if (hit !== undefined) { used.add(hit); allowed += 1; return; }
      out.push(`cell-axes-region: ${doc}:${at} 是标记区里的**普通正文行**——标记区只许包住两轴载荷表本身`
        + `（` + `|` + ` 开头的表格行 / 标记行 / 空行 / 已登记口径行）：这一行不是（原文：${trimmed.slice(0, 90)}）。`
        + `最常见的形状是把 \`${CELL_AXES_MARK_BEGIN}\` 往上搬——那一搬就把无关正文算进了「标记区定点豁免」`
        + `的范围（#772 R2 M2：把标记行挪回表格上方，或把这段话移到标记区外）`);
    });
    for (const entry of registered) {
      if (!used.has(entry)) {
        out.push(`cell-axes-region: ${doc} 在 CELL_AXES_CALIBER_LINES 里登记的口径行没有一行真正用到——`
          + `留着就是给未来的正文开后门（要么把那句话放回区域内，要么删登记）：${entry.slice(0, 60)}`);
      }
    }
  }
  cellAxesRegionContentErrors.notes = [`cell-axes-region: 两轴载荷表标记区内容不变量（#772 R2 M2）：`
    + `${CELL_AXES_DOCS.length} 份文档的标记区内表格行 ${tableRows} 行 / 其他允许形状 ${allowed} 行 `
    + `（登记口径行共 ${CELL_AXES_DOCS.reduce((n, d) => n + (caliber.table?.[d]?.length ?? 0), 0)} 条）⇒ 破口 ${out.length} 处`];
  return out;
}

/**
 * 一份契约标记区里的「两轴引用」索引：`格名|轴|同名第几行|文件` → Set(行号)。
 * 只抽 `src/` 与 `bin/` 那两档（测试侧指纹走词面 + 在场那一档，同测试口径）。标记区不在 → null。
 */
function cellAxesTableRefs(rec) {
  const region = cellAxesRegion(rec);
  if (region === null) return null;
  const rows = rec.lines.slice(region.begin + 1, region.end).filter((line) => line.trim().startsWith("|"));
  const out = new Map();
  const perKey = new Map();
  for (const line of rows.slice(2)) {   // 去掉表头与分隔行
    const cells = line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((c) => c.trim());
    if (cells.length < 7) continue;     // 列数残缺由测试那侧（G1）管，这里不抢它的错
    const key = ((cells[0] ?? "").match(/`([A-Za-z][A-Za-z0-9]*)`/u) ?? [])[1];
    if (!key) continue;
    const rowIndex = perKey.get(key) ?? 0;
    perKey.set(key, rowIndex + 1);
    for (const [axis, cell] of [["write", cells[5]], ["read", cells[6]]]) {
      CELL_AXES_SIDE_REF.lastIndex = 0;
      for (const ref of cell.match(CELL_AXES_SIDE_REF) ?? []) {
        const [path, lineNumber] = ref.split(":");
        const gk = `${key}|${axis}|${rowIndex}|${path}`;
        if (!out.has(gk)) out.set(gk, new Set());
        out.get(gk).add(Number(lineNumber));
      }
    }
  }
  return out;
}

/**
 * 闸这一侧的**前提**判据（#772 R3 收窄后只剩「在场」类，全部可核、没有一条靠猜形状）：
 *   ① 专用契约测试在场，且真的 `import` 了锚点模块（两边同一份表，不是各存一份副本）；
 *   ② 锚点模块在场、哨兵之间的数组字面量抽得出、跑不通/低于地板都算不在场；
 *   ③ 两份契约里那对 begin/end 标记成对在场（只剩一半 = 「标记区」无界 = 后门）。
 * 区域内每条引用是否真对得上锚点，由 `cellAxesRegionExemption()` 逐组当场重算，不在这里。
 * @returns {{ok:boolean, why?:string, entries?:number, groups?:number}}
 */
function cellAxesGuardVerdict() {
  const guardText = fileRecord(CELL_AXES_GUARD_TEST)?.text ?? null;
  if (guardText === null || guardText.trim() === "") {
    return { ok: false, why: `${CELL_AXES_GUARD_TEST} 不在场或空了（被改名/删除/清空 ⇒ 那份逐格断言没人跑）` };
  }
  if (!CELL_AXES_GUARD_IMPORT.test(guardText)) {
    return { ok: false, why: `${CELL_AXES_GUARD_TEST} 没有 import \`${CELL_AXES_ANCHOR_MODULE}\``
      + ` ⇒ 测试读的表和闸读的不是同一份（#772 R3 的单一真值不成立）` };
  }
  const table = cellAxesAnchorTable();
  if (table.why) return { ok: false, why: table.why };
  for (const doc of CELL_AXES_DOCS) {
    const lines = fileRecord(doc)?.lines ?? [];
    const b = lines.filter((l) => l.includes(CELL_AXES_MARK_BEGIN)).length;
    const e = lines.filter((l) => l.includes(CELL_AXES_MARK_END)).length;
    if (b === 0 || b !== e) {
      return { ok: false, why: `${doc} 的标记对不在场或残缺（begin ${b} 处 / end ${e} 处）`
        + ` ⇒ 「标记区」没有边界，定点豁免不能给` };
    }
  }
  return { ok: true, entries: table.entries.length, groups: table.shape.groups };
}

/**
 * 锚点表（#772 R3 单一真值）：住在 `scripts/cell-axes-anchors.mjs`，闸从它的**文本**里抽字面量
 * （`--self-test` 的覆盖层只改文本、改不动已加载的模块），并与本文件 `import` 到的出厂表比形状——
 * 两者不同形 = 有人把登记表改成运行期拼合/两份表各长各的。抽不到、跑不通、低于地板都拿不到豁免。
 */
function cellAxesAnchorTable() {
  const parsed = cellAxesParseAnchorTable(fileRecord(CELL_AXES_ANCHOR_MODULE)?.text ?? null);
  if (parsed.why) return { why: parsed.why };
  const resolved = cellAxesAnchorTableShape(parsed.entries);
  const shipped = cellAxesAnchorTableShape(CELL_AXES_ANCHORS_SHIPPED);
  const out = { entries: parsed.entries, shape: resolved };
  // #772 R4：地板（现由 `CELL_AXES_REQUIRED_CELLS` 算出，等于出厂条数）也**只是额外错误**，理由与下面的
  // parity 同构：它不能当「前提不在场」直接返回，否则「删一条登记」那一例只会报地板，报不出「哪一格
  // 哪一轴没登记 ⇒ 不再被豁免」——而地板本身仍是一条红。
  if (parsed.floorWhy) out.floorWhy = parsed.floorWhy;
  // 与 `import` 进来的出厂表比形状：不同形 = 闸手里那份与真正加载的那份不是同一张表。
  // 它只是一条**额外错误**，不能当成「前提不在场」直接返回——否则「删一条锚点条目」那一例
  // 会被它提前抢走，真正该报的那句（「这一格这一轴没有登记锚点 ⇒ 不再被豁免」）就印不出来了。
  if (resolved.entries !== shipped.entries || resolved.groups !== shipped.groups || resolved.cells !== shipped.cells) {
    out.parity = `闸从 \`${CELL_AXES_ANCHOR_MODULE}\` 的文本里抽到 ${resolved.entries} 条 / ${resolved.groups} 组 / ${resolved.cells} 格，`
      + `而 import 到的出厂表是 ${shipped.entries} 条 / ${shipped.groups} 组 / ${shipped.cells} 格`
      + ` ⇒ 两份表不是同一张（哨兵之间必须是纯数组字面量，改成运行期拼合就抽不齐）`;
  }
  return out;
}

/**
 * **逐组**豁免判定（#772 R3 的核心：闸自己当场重算，不 spawn 测试、也不读测试算出来的结果）。
 * 表里每一组 `格名|轴|同名第几行|文件` 的引用都要过三关，全过才免进棘轮：
 *   ① 这一格这一轴**有**登记锚点（没有 ⇒ 那条行号没有基准 ⇒ 红，并且**不再被豁免** ⇒ 回棘轮计数）；
 *   ② 锚点在源码里**唯一命中**（0 命中 = 锚点失效；>1 = 锚点歧义，歧义锚点不配当基准），
 *      且命中的那一行**种类相符**（#772 R4 M-A：`kind: "code"` 必须是真代码行、`kind: "comment"`
 *      必须是注释行——判据是共享的 `anchorKindError()`，与测试那一份是同一个函数）；
 *   ③ 表里写的行号与重算结果**等值**（漂一行就红，并打印「表写 :NNNN / 锚点实际 :MMMM / 那一行原文」）；
 *   ④ 覆盖面：人审清单 `CELL_AXES_REQUIRED_CELLS` 里每一格都要在登记 + EN 表 + CN 表各自在场
 *      （#772 R4 M-B，判据是共享的 `checkCellAxesCoverage()`）——光「剩下的那些自洽」不算过。
 * 中英两侧任一侧不合格 ⇒ 这一组两侧都不豁免（同一份真值不许一侧对一侧错）。
 * @returns {{why?:string, okGroups:Set<string>, refGroup:Map<string,string>, errors:string[],
 *            entries:number, groups:number}}
 */
function cellAxesRegionExemption() {
  const refGroup = new Map();     // `${doc}|${path}|${line}` → 组键
  const errors = [];
  const verdict = cellAxesGuardVerdict();
  if (!verdict.ok) {
    return { why: verdict.why, okGroups: new Set(), refGroup, errors, entries: 0, groups: 0 };
  }
  const table = cellAxesAnchorTable();
  if (table.parity) errors.push(`cell-axes-anchors: ${table.parity}`);
  if (table.floorWhy) errors.push(`cell-axes-anchors: ${table.floorWhy}`);   // #772 R4：地板红，但不抢「哪一格」那句
  // ② 每条锚点在目标文件里当场重算（0 / >1 命中都记进 failed，歧义锚点不配当基准）
  const recomputed = new Map();
  const failed = new Map();
  for (const entry of table.entries) {
    const gk = cellAxesAnchorGroupKey(entry.key, entry.axis, entry.row ?? 0, entry.codePath);
    const lines = fileRecord(entry.codePath)?.lines ?? null;
    if (lines === null) { failed.set(gk, `锚点指向的文件不在场：${entry.codePath}`); continue; }
    const { hits, error } = cellAxesAnchorHitLines(lines, entry);
    if (error) { failed.set(gk, `锚点正则跑不通：${error}`); continue; }
    if (hits.length !== 1) {
      failed.set(gk, hits.length === 0
        ? `锚点 0 命中（正则 ${entry.anchor}）⇒ 锚点已失效，表里那些行号没有基准`
        : `锚点歧义（正则 ${entry.anchor}）命中 ${hits.length} 行：${hits.map((n) => `:${n}`).join(" ")} ⇒ 歧义锚点不配当基准`);
      continue;
    }
    // #772 R4 M-A：种类判据（与测试共用 `anchorKindError()`）。指到注释行上的「代码锚点」即使
    // 两份契约表的引文同步改口、行号自洽，也照样红；错误文本直接进 `errors`（不只靠「没锚点」转发）。
    const kindError = cellAxesAnchorKindError(entry, lines, hits[0]);
    if (kindError !== null) {
      errors.push(`cell-axes-anchors: ${kindError}`);
      failed.set(gk, kindError);
    }
    // 同一格同一轴可以有多条锚点（例：快照侧 + 轮记录侧各一条）——它们命中同一组引用，所以取**并集**；
    // 但**每一条**都必须各自唯一命中，任一条歧义/失效都记进 failed（歧义锚点不配当基准）。
    recomputed.set(gk, new Set([...(recomputed.get(gk) ?? []), ...hits]));
  }
  // ①③ 与两份契约表里写的 path:line 逐组等值对账
  const show = (p, set) => [...set].sort((a, b) => a - b).map((n) => `${p}:${n}`).join(" / ");
  const drifted = new Set();
  const referenced = new Set();
  const refsByDoc = CELL_AXES_DOCS.map((doc) => [doc, cellAxesTableRefs(fileRecord(doc))]);
  for (const [doc, refs] of refsByDoc) {
    if (refs === null) { errors.push(`cell-axes-anchors: ${doc}：标记区读不出两轴引用 ⇒ 无从对账`); continue; }
    if (refs.size === 0) { errors.push(`cell-axes-anchors: ${doc}：标记区里一条两轴引用都没有 ⇒ 表被搬空了，无从对账`); continue; }
    const side = doc === CONTRACT_EN ? "en" : "cn";
    for (const [gk, cited] of refs) {
      const [key, axis, , path] = gk.split("|");
      for (const n of cited) refGroup.set(`${doc}|${path}|${n}`, gk);
      referenced.add(gk);
      const anchorLines = recomputed.get(gk);
      if (anchorLines === undefined) {
        errors.push(`cell-axes-anchors: ${side}：${doc} 表里 \`${key}\` 的 ${axis} 列引了 ${show(path, cited)}，`
          + `但这一格这一轴**没有登记锚点**${failed.get(gk) ? `（${failed.get(gk)}）` : ""}`
          + ` ⇒ 那条行号没有基准可对，也不再被豁免（回到裸行号棘轮计数）；`
          + `新增引用要同批在 \`${CELL_AXES_ANCHOR_MODULE}\` 登记能区分这件事的源码形状`);
        drifted.add(gk);
        continue;
      }
      if (!cellAxesAnchorLinesEqual(cited, anchorLines)) {
        const target = fileRecord(path)?.lines ?? [];
        errors.push(`cell-axes-anchors: ${side}：${doc} 表里 \`${key}\` 的 ${axis} 列与登记锚点不等值——`
          + `表写 ${show(path, cited)} / 锚点实际 ${show(path, anchorLines)}`
          + `（表里引的那一行原文：${[...cited].map((n) => (target[n - 1] ?? "<行号越界>").trim().slice(0, 90)).join(" ⧸ ")}`
          + `；锚点那一行原文：${[...anchorLines].map((n) => (target[n - 1] ?? "").trim().slice(0, 90)).join(" ⧸ ")}）`
          + ` ⇒ 行号漂了（#772 R2 评审第 3 节那个形状：错引到同一键名的注释行，词面判据当年看不见）`);
        drifted.add(gk);
      }
    }
  }
  // ④ 覆盖面真值（#772 R4 M-B）：拿那份与登记表无关的人审清单问四处（清单/登记/EN 表/CN 表）。
  // 「成对删掉登记条目 + 两份表里的对应行」在 ①②③ 下全自洽（剩下的那些仍等值），只有这一条看得见。
  const coverage = cellAxesCheckCoverage({
    anchors: table.entries,
    refsByDoc: refsByDoc
      .filter(([, refs]) => refs !== null)
      .map(([doc, refs]) => ({ side: doc === CONTRACT_EN ? "en" : "cn", doc, refs })),
  });
  if (coverage.required !== CELL_AXES_REQUIRED_CELLS.length) {
    errors.push(`cell-axes-anchors: 闸手里的人审清单是 ${CELL_AXES_REQUIRED_CELLS.length} 格，`
      + "而共享判据用的是 " + coverage.required + " 格 ⇒ 判据与登记不同源（import 被接掉了）");
  }
  for (const error of coverage.errors) errors.push(`cell-axes-anchors: ${error}`);
  // 登记了却没人在表里引 = 后门（同 `BARE_LINE_EXEMPTIONS` / `CELL_AXES_CALIBER_LINES` 的口径）
  for (const gk of recomputed.keys()) {
    if (referenced.has(gk)) continue;
    const [key, axis, rowIndex, path] = gk.split("|");
    errors.push(`cell-axes-anchors: \`${CELL_AXES_ANCHOR_MODULE}\` 里 \`${key}\` 的 ${axis} 锚点（同名第 ${Number(rowIndex) + 1} 行，${path}）`
      + `已经没人在表里引它 ⇒ 引用被删了而锚点还躺着，留着就是给未来的行号留后门`
      + `（要么把引用放回表里，要么删掉这条登记）`);
  }
  const okGroups = new Set();
  for (const gk of recomputed.keys()) {
    if (failed.has(gk) || drifted.has(gk) || !referenced.has(gk)) continue;
    okGroups.add(gk);
  }
  return { okGroups, refGroup, errors, entries: table.entries.length, groups: okGroups.size };
}
/** 裸行号一侧的外仓前缀（工单 261021-03 B1）：`BARE_LINE_RE` 不带首部边界，所以
 *  `pi-subagents:src/runs/background/async-execution.js:4` 里的 `src/…:4` 会被抽到。回看匹配点之前的
 *  那几个字符就能判「它是不是带了仓名前缀」。边界用 `[^\w./-]`（反引号 / 括号 / 中文标点都是），
 *  于是同名的裸 `src/x.js:4` 不会被误归到前缀那一档。 */
const BARE_LINE_PREFIX_RE = /(?:^|[^\w./-])([a-z][a-z0-9_-]{1,30}):$/;

function collectBareLineRefErrors() {
  const out = [];
  const notes = [];
  const docs = refScanDocs();
  const unique = new Map();   // `${doc}|${target}|${from}-${to}` → { doc, line, target, from, to }
  const exemptHits = new Set();
  const extPrefixed = new Set();   // 带已知外仓前缀的外仓行号（不计棘轮、不查存在性）
  // issue #772 标记区定点豁免：regionHits 记「在标记区内出现过的唯一键」，regionOutside 记「同一唯一键在
  // 标记区外也出现过」——两边都出现过的键**不**豁免（豁免只认纯区内的引用，区外照旧逐条计数）。
  const regionHits = new Set();
  const regionOutside = new Set();
  const regionEx = cellAxesRegionExemption();   // #772 R3：逐组当场重算，合格一组免一组
  let regionMarked = false;
  let occurrences = 0;
  for (const rel of docs) {
    const rec = fileRecord(rel);
    if (!rec) continue;
    const region = cellAxesRegion(rec);
    if (region) regionMarked = true;
    rec.lines.forEach((line, i) => {
      BARE_LINE_RE.lastIndex = 0;
      for (const m of line.matchAll(BARE_LINE_RE)) {
        // 工单 261021-03 B1：写成 `<仓名>:src/…:N` 的外仓引用 —— 行号属于那个仓，本仓没有可核对的真值，
        // 所以既不查存在性也**不计入棘轮**（只减不增的基线只能被本仓的改动推动）。
        // 前缀不在已知清单里 ⇒ 照样红：否则「随手编个前缀」就成了把死链藏起来的口子。
        const pm = line.slice(0, m.index).match(BARE_LINE_PREFIX_RE);
        if (pm) {
          const v = externalRepoPrefixVerdict(`${pm[1]}:${m[0]}`);
          if (v?.ok) { extPrefixed.add(`${rel}|${pm[1]}`); continue; }
          out.push(`bare-lines: ${rel}:${i + 1} 写了带外部仓前缀的 \`${pm[1]}:${m[0]}\`，${v.why}`);
          continue;
        }
        occurrences += 1;
        const target = `src/${m[1]}`;
        const from = Number(m[2]);
        const to = m[3] ? Number(m[3]) : null;
        const key = `${rel}|${target}|${from}-${to}`;
        if (!unique.has(key)) unique.set(key, { doc: rel, line: i + 1, target, from, to });
        const v = bareLineExemptionVerdict({ doc: rel, target, lineText: line });
        if (v.exempt) { exemptHits.add(`${rel}|${target}`); continue; }
        const inRegion = region !== null && i > region.begin && i < region.end && line.trimStart().startsWith("|");
        // #772 R3：豁免是**逐组**给的——这一行的锚点必须在闸自己手里唯一命中、且与表里写的行号等值；
        // 锚点被删 / 歧义 / 0 命中 / 行号漂了 ⇒ 只有这一条掉出豁免、回到棘轮计数（不必整张表一起没）。
        const axesGroup = inRegion && to === null ? regionEx.refGroup.get(`${rel}|${target}|${from}`) : undefined;
        if (axesGroup !== undefined && regionEx.okGroups.has(axesGroup)) regionHits.add(key); else regionOutside.add(key);      }
    });
  }
  // R3 越界必红（工单 #286 T-a：不是观察项）
  for (const u of unique.values()) {
    const v = bareLineExemptionVerdict({ doc: u.doc, target: u.target, lineText: (fileRecord(u.doc)?.lines ?? [])[u.line - 1] ?? "" });
    if (v.exempt) continue;
    // 返工 R3（下界）：`path:0` 在越界判据里永远「不越界」，等于给自己开了个免检口；负数写法同理。
    if (u.from < 1 || (u.to !== null && u.to < 1)) {
      out.push(`bare-lines: ${u.doc}:${u.line} 引用 ${u.target}:${u.from}${u.to !== null ? `-${u.to}` : ""} 的行号不合法——`
        + `行号必须 **≥ 1**（0 与负数是手写行号的典型笔误，而 \`:0\` 在越界判据里永远不算越界，等于免检）`);
    }
    const count = fileLineCount(u.target);
    if (count === null) {
      // 返工 R3（不存在）：这一族从前是**跳过**——于是「目标文件改名/被删 + 文档里还留着行号」静默放行，
      // 而 `paths` 那条只覆盖 README/AGENTS/契约/examples，14 份升级指南里的裸引用没人管。
      // 现在一律红，只有 BARE_LINE_EXEMPTIONS 里逐条登记的示例/外仓路径例外（它们本来就是虚构路径）。
      out.push(`bare-lines: ${u.doc}:${u.line} 引用 ${u.target}:${u.from}${u.to !== null ? `-${u.to}` : ""}，`
        + `但 ${u.target} 在本仓不存在——裸行号没有可核对的真值（改路径或删引用；示例/外仓路径要在 `
        + `BARE_LINE_EXEMPTIONS 里逐条登记理由，不许默默放行）`);
      continue;
    }
    const hi = Math.max(u.from, u.to ?? 0);
    if (hi > count) {
      out.push(`bare-lines: ${u.doc}:${u.line} 引用 ${u.target}:${u.from}${u.to ? `-${u.to}` : ""}，但该文件只有 ${count} 行——` + `行号已越界（#286 的裸行号漂移就是这种形状：门禁过去把行号剥掉只看文件在不在，所以全绿）`);
    } else if (u.to !== null && u.to < u.from) {
      out.push(`bare-lines: ${u.doc}:${u.line} 引用 ${u.target}:${u.from}-${u.to} 的区间是反的（结尾小于开头）`);
    }
  }
  out.push(...bareLineExemptionEntryErrors());   // 评审 R4：条目自己也要被校（声明词不许恒真、不许有状态）
  // 豁免条目反向校：条目没被任何一处引用用上 = 给未来的漂移留后门（同 #273/#278 的白名单口径）
  for (const e of BARE_LINE_EXEMPTIONS) {
    if (!exemptHits.has(`${e.doc}|${e.target}`)) {
      out.push(`bare-lines: 豁免条目 \`${e.target}\`（${e.doc}）没有一处引用真正用到它——要么引用已改对/已删，` + `要么就地声明那句话被改掉了；留着就是给未来的裸行号留后门（条目 + 声明双条件，缺一不可）`);
    }
  }
  // 棘轮：只减不增。基线从脚本自己的文本里读（`bareLineBaseline()`），自测才能拿「改小就红」证它是锁。
  const baseline = bareLineBaseline();
  if (baseline === null) {
    out.push("bare-lines: 从 scripts/docs-drift-check.mjs 自己的文本里抽不到 `const BARE_LINE_REF_BASELINE = <数字>;`——"
      + "棘轮常量被删或改了写法，棘轮失效（#164 口径：抽不到真值就报错，不许静默放行）");
  }
  let regionExempt = 0;
  for (const key of regionHits) if (!regionOutside.has(key)) regionExempt += 1;
  const measured = unique.size - exemptHits.size - regionExempt;
  const docsSeen = {};
  for (const u of unique.values()) docsSeen[u.doc] = (docsSeen[u.doc] ?? 0) + 1;
  if (baseline !== null && measured > baseline) {
    out.push(`bare-lines: 裸行号引用（唯一 (文档,目标文件,行区间)）实测 **${measured}** 处，超过棘轮基线 **${baseline}** 处——` + `新增裸行号\u8981么改成「符号 + 文件」锚点（#286 B 方案），要么写明「这次确实允许变差」并把基线改成 ${measured}。` + `分布：${Object.entries(docsSeen).sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} ${n}`).join("、")}`);
  } else if (baseline !== null && measured < baseline) {
    notes.push(`bare-lines: 实测 ${measured} 处 < 基线 ${baseline} 处——存量在变少，请把 BARE_LINE_REF_BASELINE 降到 ${measured}（降基线要写理由，棘轮不许空转）`);
  }
  notes.push(`bare-lines: 覆盖面 ${docs.length} 份文档里裸行号引用 ${occurrences} 次出现 / 唯一 (文档,目标文件,行区间) ${unique.size} 处，` + `其中声明式豁免 ${exemptHits.size} 处（${BARE_LINE_EXEMPTIONS.length} 条条目）、标记区定点豁免 ${regionExempt} 处（#772 R3 逐组重算合格才免：锚点表 ${regionEx.entries} 条 / 合格 ${regionEx.groups} 组，表在 ${CELL_AXES_ANCHOR_MODULE}；前提判据在场=${regionEx.why === undefined ? "是" : "否"}）⇒ 棘轮口径实测 **${measured}** vs 基线 ${baseline}`
    + `；另有带已知外部仓前缀的外仓行号 ${extPrefixed.size} 处（文档|仓名 去重，既不计棘轮也不查存在性，见 EXTERNAL_REPO_PREFIXES）`);
  out.push(...regionEx.errors);   // #772 R3：闸自己重算出来的破口（歧义 / 0 命中 / 行号漂 / 没登记 / 登记了没人引）
  if (regionMarked && (regionEx.why !== undefined || regionEx.errors.length > 0)) {
    out.push(`bare-lines: 标记区定点豁免的机器复核不在场 —— ${regionEx.why ?? `闸自己按登记锚点重算不过（共 ${regionEx.errors.length} 条）：${regionEx.errors.slice(0, 2).join("；")}${regionEx.errors.length > 2 ? " …" : ""}`}`
      + `；豁免的根据是 \`${CELL_AXES_ANCHOR_MODULE}\` 里的锚点在**闸自己手里**唯一命中、并与表里写的 path:line 逐组等值`
      + `（#772 R3：闸自己当场重算，不 spawn 测试——它是纯文档闸；R2 那一档拿正则认 ${CELL_AXES_GUARD_TEST} 的测试文件形状，`
      + `判据被削弱成只查行号存在它也认不出，所以撤了）`
      + `⇒ 不合格的那几条照旧计入棘轮（--verbose 的分解里有逐组计数；登记与 span 规则见 docs/maintenance/command-reference.md#docs-anchors）`);
  }  collectBareLineRefErrors.notes = notes;
  return out;
}

// ── 2.9 CLI 旗标清单：`bin/cli.js` 的帮助文本 ⇄ 两份 README 的 usage 行（issue #391 R4）────
//
// 为什么要有这一节：#386 切片 2 给 `erix chat` 加了 `--require-deliverable`，帮助文本、契约、
// 升级指南都写了，**两份 README 的 usage 行都没写**（实测：`README.md` / `README_cn.md` 的 chat 行
// 同时缺 `--require-deliverable`、`--no-todo`、`--error-log` 三个旗标，而所有门禁一路绿）。
// README 是宿主唯一会照着敲命令的那一页，而「加旗标的人只改了帮助文本」是一个**结构性**的漂移方向：
// 帮助与实现住在同一个文件里，改的人看得见；README 在另一个目录，改的人不会想起它。
//
// 真值 = `bin/cli.js` 的 `HELP_TEXT` 里 `erix chat …` / `erix repl …` 两条 usage 行的旗标集合；
// 文档侧 = `README.md` / `README_cn.md` 里 ```text 围栏内同名的两条 usage 行。**双向逐处**：
// README 少了红、多了红、改名红，错误信息点名是哪个旗标、哪份文档、哪条命令。
//
// 覆盖面（为什么只对 chat / repl 两条命令）：`erix --version` / `erix --help` / `erix skills` /
// `erix mcp` 那四行是单旗标行，两侧写法本就不同（帮助是 `erix --version, -v`，README 也是，但
// `skills`/`mcp` 只带一个 `--skills-dir`/`--config`），把它们拉进逐处对账只会让门禁对排版敏感；
// 真正的漂移面是 chat/repl 这两条长 usage 行——旗标一多，漏写就是静默的。
//
// 别名（`-c|--continue`、`-r`、`--no-final-guard`）**一律计入真值与文档两侧**：它们是真被接受的
// 旗标（`--no-final-guard` 是「兼容 no-op」，最容易被当成废话忘掉），把别名排除在外等于允许
// 「README 少写一个别名」静默通过。短别名 `-c` / `-r` 同样逐字比。
//
// 为什么是逐处而不是存在性（AGENTS §「锚点粒度」）：存在性锚点只问「文档里有没有这个字符串」，
// 于是「README 的 chat 行漏一个旗标、正文别处提过一次」就全绿——本单的病正是「帮助/正文都写了、
// usage 行没写」。旗标名是定长 token、两侧都是结构化列表，逐字比对不会变成措辞绑架
// （数值型 defaults 不敢升级到逐处，是因为它们的散文句式多变；这里不存在那个问题）。
//
// 放行口（`CLI_FLAG_EXEMPTIONS`）现在**一条也没有**，保留它是因为 #210 R2 的惯例：将来若真出现
// 「这条旗标对 repl 不适用」，放行必须逐条登记 + 写明理由，而且**条目空转本身就是错误**
// （那对 (doc, command, flag) 其实并不缺 / 旗标根本不在真值里 / 文档已补上 ⇒ 红），
// 否则放行表会变成一张永久免死金牌。两条都由 `--self-test` 的反向证钉着。

/** 真值出处：CLI 的帮助文本与 usage 行都在这一个文件里。 */
const CLI_SOURCE = "bin/cli.js";
/** 纳入逐处对账的命令（理由见本节节头）。 */
const CLI_FLAG_COMMANDS = Object.freeze(["chat", "repl"]);

/**
 * 「某份文档的某条 usage 行可以少写某个旗标」的登记表——**现在是空的，也不该有**。
 * 条目形状：`{ doc, command, flag, why }`，`why` 是给下一个人看的理由。
 */
const CLI_FLAG_EXEMPTIONS = [
  // { doc: README_CN, command: "repl", flag: "--example", why: "……" }
];

/** `--self-test` 用：临时替换放行表（与 `SIM_TREE_SHAPE` 同一课：overlay 只改文本，改不动运行时数组）。 */
let SIM_CLI_FLAG_EXEMPTIONS = null;
const cliFlagExemptions = () => SIM_CLI_FLAG_EXEMPTIONS ?? CLI_FLAG_EXEMPTIONS;

/** `erix chat …` / `erix repl …` 两条 usage 行（帮助与 README 同一句式，所以同一个提取器）。 */
function cliUsageLines(text) {
  const out = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*erix (chat|repl)\s+(\S.*)$/u.exec(line);
    if (!m) continue;
    const [, command, rest] = m;
    if (!out.has(command)) out.set(command, []);
    out.get(command).push(rest);
  }
  return out;
}

/** 一条 usage 行里的旗标 token（`--final-guard|--no-final-guard`、`[-c|--continue]` 各取两个）。 */
function cliFlagsOf(text) {
  return [...new Set(
    [...String(text ?? "").matchAll(/(?<![\w-])(--?[A-Za-z][\w-]*)/gu)].map((m) => m[1]),
  )];
}

/** README 里那份 ```text usage 围栏（找不到就是检查面失效，#164 口径）。 */
function readmeUsageBlock(rel) {
  const fences = [...String(textOf(rel) ?? "").matchAll(/```text\n([\s\S]*?)```/gu)]
    .map((m) => m[1])
    .filter((body) => /^\s*erix chat\s/mu.test(body));
  return fences.length === 1 ? fences[0] : null;
}

function collectCliFlagErrors() {
  const errors = [];
  const notes = [];
  const truth = new Map();
  const helpLines = cliUsageLines(textOf(CLI_SOURCE));
  for (const command of CLI_FLAG_COMMANDS) {
    const lines = helpLines.get(command);
    if (!lines || lines.length === 0) {
      errors.push(`cli-flags: 从 ${CLI_SOURCE} 的帮助文本里抽不到 \`erix ${command}\` 的 usage 行——`
        + "检查面失效（#164 口径：抽不到真值就报错，不许静默放行）");
      continue;
    }
    truth.set(command, cliFlagsOf(lines.join(" ")));
  }
  if (errors.length > 0) return errors;

  // 放行表的配置校（#210 R2 惯例：放行必须逐条有效，空转就是错误）
  const exemptions = cliFlagExemptions();
  for (const entry of exemptions) {
    const where = `cli-flags: 放行条目 (${entry?.doc} / ${entry?.command} / ${entry?.flag})`;
    if (![README_EN, README_CN].includes(entry?.doc)) {
      errors.push(`${where} 的 doc 不是受检文档（只能是 ${README_EN} 或 ${README_CN}）`);
      continue;
    }
    if (!CLI_FLAG_COMMANDS.includes(entry?.command)) {
      errors.push(`${where} 的 command 不在受检命令里（只能是 ${CLI_FLAG_COMMANDS.join(" / ")}）`);
      continue;
    }
    if (!truth.get(entry.command).includes(entry?.flag)) {
      errors.push(`${where} 的 flag 在帮助文本里根本没有——放行一个不存在的旗标等于免死金牌`);
      continue;
    }
    if (typeof entry.why !== "string" || entry.why.trim() === "") {
      errors.push(`${where} 没有 why（放行必须写明理由，否则下一个人只能靠猜）`);
      continue;
    }
    const block = readmeUsageBlock(entry.doc);
    const docFlags = block === null
      ? []
      : cliFlagsOf((cliUsageLines(block).get(entry.command) ?? []).join(" "));
    if (docFlags.includes(entry.flag)) {
      errors.push(`${where} 已经空转：该文档那条 usage 行**已经写了**这个旗标 ⇒ 删掉这条放行`
        + "（留着一张用不上的放行表，就是给下一次真漂移留的后门）");
    }
  }

  for (const doc of [README_EN, README_CN]) {
    const block = readmeUsageBlock(doc);
    if (block === null) {
      errors.push(`cli-flags: ${doc} 里找不到含 \`erix chat\` 的 \`\`\`text usage 围栏（或找到不止一个）——`
        + "检查面失效：这一节的全部对账都在空跑");
      continue;
    }
    const docLines = cliUsageLines(block);
    for (const command of CLI_FLAG_COMMANDS) {
      const docLine = docLines.get(command);
      if (!docLine) {
        errors.push(`cli-flags: ${doc} 的 usage 围栏里找不到 \`erix ${command}\` 那一行——`
          + "整条命令的旗标对账因此空转（删掉整行不是「少写一个旗标」，是检查面失效）");
        continue;
      }
      const docFlags = cliFlagsOf(docLine.join(" "));
      const truthFlags = truth.get(command);
      const exempt = new Set(exemptions
        .filter((entry) => entry.doc === doc && entry.command === command)
        .map((entry) => entry.flag));
      for (const flag of truthFlags) {
        if (docFlags.includes(flag) || exempt.has(flag)) continue;
        errors.push(`cli-flags: ${doc} 的 \`erix ${command}\` usage 行缺 旗标 ${flag}`
          + `（${CLI_SOURCE} 的帮助文本里有它）`);
      }
      for (const flag of docFlags) {
        if (truthFlags.includes(flag)) continue;
        errors.push(`cli-flags: ${doc} 的 \`erix ${command}\` usage 行多出 旗标 ${flag}`
          + `（${CLI_SOURCE} 的帮助文本里没有它：要么是文档写错了，要么是新旗标没进帮助）`);
      }
    }
  }
  notes.push(`cli-flags: ${CLI_SOURCE} 的帮助文本 ⇄ 两份 README 的 usage 行逐处对账`
    + `（${CLI_FLAG_COMMANDS.map((command) => `${command} ${truth.get(command).length} 个旗标`).join(" / ")}；`
    + `放行条目 ${exemptions.length} 条）`);
  collectCliFlagErrors.notes = notes;
  return errors;
}

// ── 2.10 压缩策略「默认值」的分层对账（issue #668 ①）────────────────────────────────
//
// 病根（#668 ①，现场在契约里）：`fold-llm` is therefore opt-in; `fold-statistical` remains the
// default everywhere (library default stays `sliding-window` when no strategy is set) —— 一句话把
// **两层**「默认」混成一句，而两层都不对：
//   · **库层**：不配策略时，预算溢出由 `fallback: true` 的那一层接手 = `sliding-window`
//     （真值 = `src/compact/pipeline.js` 里那一层的 `strategyNames`）；
//   · **CLI 层**：`slots.default.compaction` 缺省 = `fold-llm`（真值 = `bin/cli.js` 帮助文本里的
//     「默认：…」字样，与 `bin/config.js` 的 `DEFAULT_COMPACTION_STRATEGY` 常量同源）。
// **没有任何一层默认 `fold-statistical`**：它是 `fold-llm` 摘要失败 / 超时之后的确定性降级兜底。
// 把 CLI 的默认写成「库的默认」是本仓红线里的错（`bin/` 是校验器/调试器，不是契约面）。
//
// 为什么只登记**具体搭配**、不做自然语言判定（#668 自己划的边界）：判据必须机械、可复现。本节三条：
//   ① **分层声称**（`COMPACTION_CLAIM_SHAPES`）：句子用登记过的标记词（`library default` / `库层默认`
//      / `CLI slot default` / `CLI 槽位默认`）指出**它说的是哪一层**，紧随其后的策略名必须等于**那一层**
//      的源码真值。句子改了没同步源码 / 源码改了没同步句子 —— 两个方向都红并点名 `doc:行`。
//      登记过的 (文档, 层) 组合必须**至少命中一次**（`COMPACTION_CLAIM_REQUIRED`）：整句被删掉也红。
//      中英成对：同一对文档里每层的声明点处数必须相等（只在一侧删掉就是红）。
//   ② **退役句式**（`COMPACTION_MIXED_SHAPES`）：`X remains the default everywhere` /
//      `默认 everywhere 仍是 X` 这一种**把两层混成一句**的写法整体退役 —— 它既指不出层，也无法与
//      任何一层的真值对账；改写方向是拆成两句、各写一层（这正是本票要的「分层陈述」）。
//   ③ **无标记的默认声称**（`compactionUnmarkedDefaultClaims`，issue #668 ① 的残留盲区）：①② 都靠
//      **标记词**判断句子指哪一层，于是「新写一句不带任何标记词的默认声称」整句落在面外 —— 现场：
//      往契约里插一句 `By default, compaction uses `fold-statistical` whenever a host does not
//      configure a strategy.`，`check:docs` exit 0。#668 正文自己警告过这个病：**关键词面窄于语义面**
//      （上一次漏检就是因为它写的是「降级兜底」而不是「降级为统计摘要」）。所以 ③ 不是再往标记词表
//      里加几个词，而是把①的报错理由**反过来当规则**：活文档里凡「默认声称 + 三个内置策略名之一」
//      同句搭配，**必须**带分层标记词，否则红并点名 `文件:行`，报错给出正解（拆成两句、各带层标记）。
//      判据必须落在「**这句在说默认策略**」而不是「句子里同时出现了 default 和策略名」——见
//      `compactionUnmarkedDefaultClaims` 上那段「怎么区分」的注释（本单的全部风险都在那儿）。
//
// ① ② 的覆盖面（#668 点名的活文档）：两份契约、两份 README、两份 AGENTS、两份需求文档、`erix_run` 的
// README。`CHANGELOG.md` 与升级指南不在① ② 面内（历史记录写的是当时为真，改它等于伪造历史）。
// ③ 的覆盖面**另算**：入库 Markdown 全扫（`git ls-files`，#560 的教训：清单不许退回文件系统遍历），
// 只按路径剔掉**历史类**（`CHANGELOG.md` / `docs/v0.*` / `docs/decisions|design|research|harness-comparison|
// tasks|delivery/` / `docs/issue-469-*`）——升级指南留在面内：它们讲的正是「默认变了」，一句新的默认声称
// 落在那里同样要指得出层（`The CLI's default compaction strategy is now `fold-llm`` 这种带层名的写法照旧绿）。

/** 库层真值出处：`fallback: true` 的那一层就是「不配策略时接手」的那一个。 */
const COMPACTION_PIPELINE_SRC = "src/compact/pipeline.js";
/** CLI 层真值出处：帮助文本里的「默认：…」字样。 */
const COMPACTION_CLI_SRC = "bin/cli.js";
/** CLI 层真值的常量形态（与帮助文本必须同源，否则源码自己就不自洽）。 */
const COMPACTION_CLI_CONST_SRC = "bin/config.js";

/** 压缩策略「默认值」这句话的**活文档**面（#668 点名的清单，顺序即报告顺序）。 */
const COMPACTION_DEFAULT_DOCS = Object.freeze([README_EN, README_CN, AGENTS_EN, AGENTS_CN,
  CONTRACT_EN, CONTRACT_CN, REQ_EN, REQ_CN, PI_EXT_README]);

/**
 * 分层标记词表（**唯一一份**，① ② ③ 共用）：一句话用它指出「我说的是哪一层」。
 *
 * `binds: true` 的条目同时被 `compactionClaimShapes()` 拿去**绑策略名**做真值对账——所以必须窄：
 * 标记词后面必须紧跟一个反引号里的策略名，捕获组才圈得准（`CLI slot default` 而不是 `CLI default`：
 * 后者会把「CLI 默认值不变：`erix chat` 不带 `--final-guard` 仍是 `skipped`」读成策略声称）。
 * `binds: false` 的条目只回答「这句指了层吗」（③ 读它），不绑值——放宽它们不会把别的主题的默认句
 * 读成策略声称，只会让更多句子被认成「指了层」：升级指南的标题句 `The CLI's default compaction
 * strategy is now `fold-llm`` 就是这种形态（它点了层名，但没有 `slot` 这个字）。
 *
 * `layer: null` 的条目是**量化形态**：`no layer defaults to X` / `没有任何一层默认 X` 把两层一起否掉，
 * 它本身就是分层陈述（不是某一层的默认声称），所以既不绑值、也不属于任何一层。
 */
const COMPACTION_LAYER_MARKERS = Object.freeze([
  {
    id: "library",
    layer: "library",
    binds: true,
    marker: "library default|库层默认",
    where: `${COMPACTION_PIPELINE_SRC} 的 \`fallback: true\` 层`,
  },
  {
    id: "cli",
    layer: "cli",
    binds: true,
    marker: "CLI(?:'s)? (?:own )?slot default|CLI 槽位默认",
    where: `${COMPACTION_CLI_SRC} 帮助文本里的「默认：…」`,
  },
  // 下面三条只判「指了层」，不绑值（理由见上）。
  { id: "library-named", layer: "library", binds: false, marker: "library(?:-layer)? default|库层默认" },
  { id: "cli-named", layer: "cli", binds: false, marker: "CLI(?:'s)? (?:own )?(?:slot )?default|CLI (?:槽位|的)?默认" },
  { id: "layer-quantified", layer: null, binds: false, marker: "no layer (?:defaults?|defaulting) to|任何一层默认|every layer(?:'s)? default" },
]);

/**
 * 分层声称的登记句式：`layer` = 这句话指的是哪一层，捕获组 = 它声称的策略名。
 *
 * 标记词后面 `[^。\n]{0,60}?` 只允许「同一行、同一句」里的连接词——跨句、跨行的搭配不算声称
 * （那是另一句话的事，硬连起来只会变成措辞绑架）。标记词本身足够具体（`library default` /
 * `库层默认` / `CLI slot default` / `CLI 槽位默认`），所以捕获组不必再按内置名单收紧：
 * 名字写错（比如写成 `fold-statistical`）**必须**被抓到，那正是本票的病。
 *
 * 句式**从标记词表生成**（`binds: true` 那几条）：标记词的唯一一份在 `COMPACTION_LAYER_MARKERS`，
 * 这里不再抄一遍字符串。
 *
 * @returns {Array<{id: string, layer: "library"|"cli", re: RegExp, where: string}>}
 */
function compactionClaimShapes() {
  return COMPACTION_LAYER_MARKERS.filter((entry) => entry.binds).map((entry) => ({
    id: entry.id,
    layer: entry.layer,
    re: new RegExp(`(?:${entry.marker})[^。\\n]{0,60}?\`([a-z][a-z-]*)\``, "giu"),
    where: entry.where,
  }));
}

/**
 * ③ 的「这句指了层吗」判据：标记词表的**宽松全集**（含不绑值的形态）。
 *
 * @returns {RegExp[]}
 */
function compactionLayerMarkerRes() {
  return COMPACTION_LAYER_MARKERS.map((entry) => new RegExp(entry.marker, "iu"));
}

/**
 * ③ 的判据词表：什么叫「这句在说默认」。
 *
 * 为什么不是 `default` 一刀切：`(?<![\w./])` / `(?![\w./-])` 只认**独立的词**，于是
 * `slots.default.compaction`、`defaultHeaders`、`fold-default-real-e2e.mjs` 这些**标识符里的
 * default** 被排掉——它们不是声称（不排掉的话，每一句提到 `slots.default.compaction` 的话都会
 * 被判成默认声称）。
 *
 * 两侧的写法**刻意不对称**，别“对称化”掉：
 *   · 前面只排 `[\w./]`，**不排** `-`：英文里 `engine-default summarizer` 是正常的复合词，
 *     `README.md:1367` 那句「ships an engine-default summarizer」就在这里。把 `-` 也排掉，
 *     `the engine-default strategy is X` 这种真声称会连带漏掉（实测：排掉 `-` 时，把 summarizer
 *     排除拿掉也抓不到 README.md:1367）。
 *   · 后面排 `[\w./-]`：`fold-default-real-e2e.mjs` 的 `default` 后面跟的是 `-`，那是标识符。
 * 中文侧 `默认` / `缺省` 是同一件事；`缺省` 在本仓多出现在「引擎缺省」这类表格格里，而表格格的
 * 边界在下面的窗口里被切断，它不会把「引擎缺省」与隔壁格的策略名连起来。
 *
 * 这三条就是 ③ 的**全部**判据词——它们被抽掉，③ 就什么也判不到（见 `--self-test` 的退化证）。
 */
const COMPACTION_DEFAULT_WORDS = Object.freeze([
  { id: "en-default", re: /(?<![\w./])default(?:s|ed|ing)?(?![\w./-])/giu },
  { id: "cn-default", re: /默认/gu },
  { id: "cn-quesheng", re: /缺省/gu },
]);

/** `--self-test` 用：临时**抽掉**一条判据词（与 `SIM_CLI_FLAG_EXEMPTIONS` 同一课：overlay 只改文本，
 *  改不动运行时那个数组）。**不是豁免开关**：生产路径永远读 `COMPACTION_DEFAULT_WORDS` 全集，
 *  而「全集被清空」本身会报红（`collectCompactionDefaultErrors` 里的空转判据）。 */
let SIM_COMPACTION_DROP_WORD_IDS = null;

/** ③ 实际使用的判据词（自测可临时抽掉一条，见上）。 */
function compactionDefaultWords() {
  const drop = new Set(SIM_COMPACTION_DROP_WORD_IDS ?? []);
  return COMPACTION_DEFAULT_WORDS.filter((word) => !drop.has(word.id));
}

/** 句子边界：默认声称与策略名必须落在**同一句**里（跨句的搭配是两句话的事）。
 *  `.` 只当句号用（后面跟空白）：`pipeline.js` / `0.30.0` 里的点不是句子边界。 */
const COMPACTION_CLAIM_STOP = /[。；;！!？?]|\.(?=\s)/u;

/** `text` 里**最后一个**句界之后的位置（无句界返回 0）。 */
function afterLastStop(text) {
  let at = 0;
  for (const m of text.matchAll(new RegExp(COMPACTION_CLAIM_STOP.source, "gu"))) at = m.index + m[0].length;
  return at;
}

/** `text` 里**第一个**句界的位置（无句界返回 -1）。 */
function firstStop(text) {
  const m = text.match(new RegExp(COMPACTION_CLAIM_STOP.source, "u"));
  return m ? m.index : -1;
}

/** 策略名当**路径**用时不算声称：`src/compact/fold-llm.js` 说的是文件，不是默认策略。 */
function strategyNameIsPath(line, index, name) {
  const before = line[index - 1] ?? "";
  const after = line.slice(index + name.length, index + name.length + 4);
  return before === "/" || before === "\\" || /^\.(?:js|mjs|cjs|ts|json)\b/u.test(after);
}

/**
 * 窗口里与默认词**最近**的那个策略名（先向前、再向后），距离上限 60 / 40 字符。
 * 超上限不算声称（那是同一句里另一个子句的事，硬连起来就是措辞绑架）。
 */
function nearestStrategyName(line, wordEnd, winStart, winEnd, names) {
  const forward = [];
  const backward = [];
  for (const name of names) {
    for (let at = line.indexOf(name); at !== -1; at = line.indexOf(name, at + 1)) {
      if (at < winStart || at + name.length > winEnd) continue;
      if (strategyNameIsPath(line, at, name)) continue;
      if (at >= wordEnd) {
        if (at - wordEnd <= 60) forward.push({ name, at });
      } else if (wordEnd - (at + name.length) <= 40) {
        backward.push({ name, at });
      }
    }
  }
  const picked = forward.sort((a, b) => a.at - b.at)[0] ?? backward.sort((a, b) => b.at - a.at)[0];
  return picked ? picked.name : null;
}

/**
 * ③ 的判据：把一份文档里**指不出层**的默认声称逐处抽出来。
 *
 * ## 怎么区分「说默认策略」与「说默认 summarizer」（本单全部风险所在）
 *
 * 「句子里同时出现 default 和策略名」不是判据——现树里合法的不同话题句一抓一大把：
 * `README.md:1367`（`"fold-llm"` ships an engine-default summarizer）、`docs/host-consumer-contract.md:2620`
 * （`fold-llm` name injects a default summarizer）、`docs/host-consumer-contract.md:2055` /
 * `docs/host-consumer-contract_cn.md:1679`（`normalizeWrapupWithLlm` 那条的 `fold-llm` default
 * summarizer）、`README_cn.md:185`（`fold-llm` 默认 summarizer）。所以判据是五道闸，**每一道都在削
 * 「这句在说默认策略」以外的读法**：
 *   ① **默认词必须是独立的词**：标识符里的 `default`（`slots.default.compaction` / `defaultHeaders` /
 *      `fold-default-real-e2e.mjs`）不是声称；
 *   ② **默认词紧跟 summarizer / summary / 摘要**（≤ 3 个词，可带 `的`）⇒ 这句说的是**摘要器**，不是
 *      默认策略，放行（上面那五句全部落在这一道）；
 *   ③ **策略名当路径用**（`src/compact/fold-llm.js`）不算声称——它说的是文件；
 *   ④ **同一句、同一表格格**：跨句 / 跨 `|` 的搭配是两句话（两个格）的事；
 *   ⑤ **距离上限**（前 60 / 后 40 字符）：超出去就是另一个子句，硬连起来只会变成措辞绑架。
 * 剩下还命中的，才是「这句在说默认是哪个策略」。它若带了分层标记词（`COMPACTION_LAYER_MARKERS`）
 * 就交给 ① 去做真值对账；不带就是 ③ 的红。
 *
 * @param {string} src 文档正文
 * @param {string[]} names 内置策略名（从 `src/compact/pipeline.js` 现推，不抄）
 * @param {RegExp[]} markerRes 分层标记词（`compactionLayerMarkerRes()`）
 * @returns {Array<{line: number, name: string, snippet: string}>}
 */
function compactionUnmarkedDefaultClaims(src, names, markerRes) {
  const claims = [];
  const words = compactionDefaultWords();
  for (const [i, line] of src.split("\n").entries()) {
    if (!names.some((name) => line.includes(name))) continue;
    for (const word of words) {
      for (const m of line.matchAll(new RegExp(word.re.source, word.re.flags))) {
        // 表格格边界：一句的「默认」不该跨过 `|` 去绑隔壁格的策略名
        const cellStart = line.lastIndexOf("|", m.index) + 1;
        const barAfter = line.indexOf("|", m.index + m[0].length);
        const cellEnd = barAfter === -1 ? line.length : barAfter;
        const wordEnd = m.index + m[0].length;
        const before = line.slice(cellStart, m.index);
        const after = line.slice(wordEnd, cellEnd);
        const winStart = cellStart + afterLastStop(before);
        const stop = firstStop(after);
        const winEnd = wordEnd + (stop === -1 ? after.length : stop);
        // ② 默认词紧跟 summarizer / summary / 摘要 ⇒ 这句说的是摘要器，不是默认策略
        if (/^[-\s*`]*(?:的\s*)?(?:[`\w./-]+\s+){0,2}?(?:summar|摘要)/iu.test(line.slice(wordEnd, winEnd))) continue;
        // 指了层 ⇒ 放行（真值对账交给 ①）
        if (markerRes.some((re) => re.test(line.slice(winStart, winEnd)))) continue;
        const name = nearestStrategyName(line, wordEnd, winStart, winEnd, names);
        if (name === null) continue;
        claims.push({
          line: i + 1,
          name,
          snippet: line.slice(Math.max(0, m.index - 40), Math.min(line.length, wordEnd + 60)).trim(),
        });
      }
    }
  }
  return claims;
}

/**
 * ③ 的扫描面里**不判**的路径（历史类）：`CHANGELOG.md` 与带日期的档案写的是「当时为真」，
 * 改它等于伪造历史。**升级指南不在这一档**：它们讲的正是「默认变了」，一句新的默认声称落在那里
 * 同样要指得出层（`The CLI's default compaction strategy is now `fold-llm`` 这种带层名的写法照旧绿）。
 */
const LIVE_DOC_HISTORY = Object.freeze([
  /^CHANGELOG\.md$/u,
  /^docs\/v0\./u,
  /^docs\/decisions\//u,
  /^docs\/design\//u,
  /^docs\/research\//u,
  /^docs\/harness-comparison\//u,
  /^docs\/tasks\//u,
  /^docs\/delivery\//u,
  /^docs\/issue-469-/u,
]);

/** 清单只算一次：`--self-test` 一轮要跑 160+ 次全量检查，但 overlay 改的是**正文**，入库清单不变。 */
let LIVE_DOC_FACE_CACHE = null;

/**
 * ③ 的扫描面 = **入库** Markdown 清单（`git ls-files`），按路径剔掉历史类。
 *
 * 为什么走 `git ls-files` 而不是遍历文件系统（#560 的教训）：遍历会把不入库的文件喂给判据，
 * 于是开发树与干净克隆给出两个答案。`git` 不可用 / 不在仓库内 / 清单为空 ⇒ **报红**（#164 口径：
 * 抽不到真值就报错），**没有**文件系统回退分支。
 *
 * @returns {{docs: string[], error: string|null}}
 */
function liveDocFace() {
  if (LIVE_DOC_FACE_CACHE !== null) return { docs: LIVE_DOC_FACE_CACHE, error: null };
  let raw;
  try {
    raw = execFileSync("git", ["ls-files", "-z", "--cached", "--full-name", "--", "*.md"], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().split("\n").filter(Boolean)[0] ?? String(error);
    return {
      docs: [],
      error: `compaction-default/unmarked: 取不到入库 Markdown 清单（\`git ls-files\` 失败：${detail}）——`
        + "③ 的扫描面失效。不许退回文件系统遍历：那会把不入库的文件喂给判据，让门在开发树与干净克隆里给出两个答案（#560）",
    };
  }
  const docs = [...new Set(raw.split("\0")
    .filter((rel) => rel.length > 0 && rel.endsWith(".md"))
    .map((rel) => rel.split(path.sep).join("/")))]
    .filter((rel) => !LIVE_DOC_HISTORY.some((re) => re.test(rel)))
    .sort();
  if (docs.length === 0) {
    return { docs, error: "compaction-default/unmarked: 入库 Markdown 清单剔掉历史类之后是空的——③ 会假绿（#164 口径：抽不到真值就报错）" };
  }
  LIVE_DOC_FACE_CACHE = docs;
  return { docs, error: null };
}

/**
 * 登记过的 (文档, 层) 组合：**必须命中至少一次**。删掉整句声明 = 检查面在这份文档失效 ⇒ 红
 * （#210 那族「句子被删也要红」的口径）。⚠ 这个口径对**契约/README 的默认值声称**成立，
 * 对 `BASELINE_CLAIM_RULES` 那族已不成立（issue #802：指令面上的数字声称改成「出现才对账」）。
 */
const COMPACTION_CLAIM_REQUIRED = Object.freeze([
  { doc: CONTRACT_EN, layer: "library" },
  { doc: CONTRACT_EN, layer: "cli" },
  { doc: CONTRACT_CN, layer: "library" },
  { doc: CONTRACT_CN, layer: "cli" },
  { doc: README_EN, layer: "cli" },
  { doc: README_CN, layer: "cli" },
  { doc: PI_EXT_README, layer: "library" },
]);

/**
 * 中英成对的那几对活文档：**只登记一次**，两处判据都读它——
 *   ① 已标记的声明点处数（每层）必须相等；
 *   ③ 未标记的默认声称处数必须相等（只在一侧写了谎就是这种形状）。
 * 另造一张表就是第二条漂移路径（#429 的口径）。
 */
const COMPACTION_DOC_PAIRS = Object.freeze([
  [CONTRACT_EN, CONTRACT_CN],
  [README_EN, README_CN],
  [REQ_EN, REQ_CN],
  [AGENTS_EN, AGENTS_CN],
]);

/**
 * 退役句式：把两层混成一句的写法（#668 判定的矛盾形态，改写方向 = 拆成两句）。
 * 捕获组同样只认内置策略名（理由同上：这是「压缩策略默认值」的锚点，不是通用默认值锚点）。
 *
 * @param {string[]} names 内置策略名
 */
function compactionMixedShapes(names) {
  const alt = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  return [
    { id: "en-remains-default-everywhere", re: new RegExp(`\`(${alt})\`\\s+(?:still\\s+)?remains\\s+the\\s+default\\s+everywhere`, "giu") },
    { id: "cn-default-everywhere", re: new RegExp(`默认(?:\\s*everywhere)?\\s*仍是\\s*\`(${alt})\``, "gu") },
  ];
}

/**
 * 两层真值。抽不到就报错（#164 口径：抽不到真值 ≠ 没有漂移）。三处 CLI 字样（帮助文本两处 +
 * `bin/config.js` 常量）必须彼此相等，否则源码自己就不自洽，文档写哪一个都是错的。
 *
 * @returns {{errors: string[], library: string|null, cli: string|null, names: string[]}}
 */
function compactionDefaultTruth() {
  const errors = [];
  let library = null;
  let cli = null;
  let names = [];

  const pipeline = textOf(COMPACTION_PIPELINE_SRC);
  if (typeof pipeline !== "string") {
    errors.push(`compaction-default: 读不到 ${COMPACTION_PIPELINE_SRC}——库层默认值无从抽起（检查面失效）`);
  } else {
    // ⚠ `fallback: true` 有两层：`slidingWindow`（有策略名）与 `enforceSize`（安全层，`strategyNames: []`）。
    // 「库层默认是哪个策略」问的是**带策略名**的那一层，所以先按「有策略名」筛，再要求它唯一。
    const blocks = pipeline.split(/layer\(\{/u).slice(1);
    const fallback = blocks
      .filter((block) => /\bfallback:\s*true\b/u.test(block))
      .filter((block) => /strategyNames:\s*\[[^\]]*[a-z]/u.test(block));
    if (fallback.length !== 1) {
      errors.push(`compaction-default: ${COMPACTION_PIPELINE_SRC} 里 \`fallback: true\` 且**带策略名**的层不是恰好一个`
        + `（实测 ${fallback.length} 个）——「库层默认是哪个策略」失去唯一真值来源（#164 口径：抽不到就报错）`);
    } else {
      const names = [...(fallback[0].match(/strategyNames:\s*\[([^\]]*)\]/u)?.[1] ?? "")
        .matchAll(/"([a-z][a-z-]*)"/gu)].map((m) => m[1]);
      if (names.length !== 1) {
        errors.push(`compaction-default: ${COMPACTION_PIPELINE_SRC} 的 \`fallback: true\` 层 \`strategyNames\` 抽出来是 `
          + `${JSON.stringify(names)}——兜底层必须恰好声明一个策略名，否则「库层默认」无从对账`);
      } else {
        [library] = names;
      }
    }
  }

  if (typeof pipeline === "string") {
    // 内置策略名集合（现推，不抄）：分层声称的捕获组只认这些名字，免得把别的主题的默认句误判成策略声称
    names = [...new Set([...pipeline.matchAll(/strategyNames:\s*\[([^\]]*)\]/gu)]
      .flatMap((m) => [...m[1].matchAll(/"([a-z][a-z-]*)"/gu)].map((x) => x[1])))];
    if (names.length === 0) {
      errors.push(`compaction-default: 从 ${COMPACTION_PIPELINE_SRC} 的 \`strategyNames\` 里抽不到任何策略名——`
        + "分层声称的捕获组会退化成「任何反引号里的词」，判据失去边界（#164 口径：抽不到就报错）");
    }
  }

  const help = textOf(COMPACTION_CLI_SRC);
  const cliConst = textOf(COMPACTION_CLI_CONST_SRC);
  const flagDefault = typeof help === "string"
    ? help.match(/--compaction <名>[\s\S]{0,160}?（默认：([a-z][a-z-]*)）/u)?.[1] ?? null
    : null;
  const slotDefault = typeof help === "string"
    ? help.match(/slots\.default\.compaction[\s\S]{0,160}?默认 ([a-z][a-z-]*)/u)?.[1] ?? null
    : null;
  const constantDefault = typeof cliConst === "string"
    ? cliConst.match(/^export const DEFAULT_COMPACTION_STRATEGY = "([a-z][a-z-]*)";/mu)?.[1] ?? null
    : null;
  const cliSides = [
    ["`--compaction` 帮助行", flagDefault],
    ["`slots.default.compaction` 帮助行", slotDefault],
    [`${COMPACTION_CLI_CONST_SRC} 的 \`DEFAULT_COMPACTION_STRATEGY\``, constantDefault],
  ];
  for (const [what, value] of cliSides) {
    if (value === null) {
      errors.push(`compaction-default: 从 ${what} 里抽不到默认策略名——CLI 层真值来源失效（#164 口径：抽不到就报错）`);
    }
  }
  const known = cliSides.map(([, value]) => value).filter((value) => value !== null);
  if (new Set(known).size > 1) {
    errors.push(`compaction-default: CLI 层的三处字样彼此不一致（${cliSides.map(([what, value]) => `${what} = ${value ?? "抽不到"}`).join("；")}）`
      + "——源码自己就不自洽，文档写哪一个都是错的");
  } else if (known.length === 3) {
    [cli] = known;
  }
  return { errors, library, cli, names };
}

function collectCompactionDefaultErrors() {
  const errors = [];
  const notes = [];
  const truth = compactionDefaultTruth();
  errors.push(...truth.errors);
  if (truth.library === null || truth.cli === null) {
    // 抽不到真值就别再往下判：拿 null 去比会把整面文档染红成噪音（#164 的第一条报错已经点名了）
    collectCompactionDefaultErrors.notes = ["compaction-default: 真值抽不到，本节的逐处对账本轮未执行（上面已报红）"];
    return errors;
  }
  if (truth.names.length === 0) {
    collectCompactionDefaultErrors.notes = ["compaction-default: 内置策略名集合抽不到，本节未执行（上面已报红）"];
    return errors;
  }
  const claimShapes = compactionClaimShapes();
  const mixedShapes = compactionMixedShapes(truth.names);
  const layerTruth = { library: truth.library, cli: truth.cli };
  const layerName = { library: "库层", cli: "CLI 层" };

  /** 每个 (文档, 层) 的声明点处数（中英成对与覆盖面都读它）。 */
  const counts = new Map();
  const bump = (doc, layer) => counts.set(`${doc}|${layer}`, (counts.get(`${doc}|${layer}`) ?? 0) + 1);

  for (const doc of COMPACTION_DEFAULT_DOCS) {
    const src = textOf(doc);
    if (typeof src !== "string") {
      errors.push(`compaction-default: 读不到 ${doc}——它登记在活文档面里，读不到就等于那份没人校`);
      continue;
    }
    for (const shape of claimShapes) {
      for (const m of src.matchAll(new RegExp(shape.re.source, shape.re.flags))) {
        bump(doc, shape.layer);
        const claimed = m[1];
        const want = layerTruth[shape.layer];
        if (claimed === want) continue;
        errors.push(`compaction-default/${shape.id}: ${doc}:${lineOf(src, m.index)} 说${layerName[shape.layer]}默认是 `
          + `\`${claimed}\`，但${layerName[shape.layer]}的真值是 \`${want}\`（真值在 ${shape.where}）。`
          + `\n      「${snippetOf(src, m.index)}」`
          + `\n      两层不是一件事：库层不配策略时由兜底层接手，CLI 槽位是另一层自己的选择——分开写，别混成一句。`);
      }
    }
    for (const shape of mixedShapes) {
      for (const m of src.matchAll(new RegExp(shape.re.source, shape.re.flags))) {
        errors.push(`compaction-default/${shape.id}: ${doc}:${lineOf(src, m.index)} 把两层的「默认」混成了一句`
          + `（\`${m[1]}\` + 「default everywhere / 默认 everywhere」）——这种写法指不出是哪一层，也没有任何一层默认 `
          + `\`fold-statistical\`。拆成两句：库层默认 = \`${truth.library}\`（不配策略时由兜底层接手），`
          + `CLI 槽位默认 = \`${truth.cli}\`（\`slots.default.compaction\` 缺省时解析成它）。`
          + `\n      「${snippetOf(src, m.index)}」`);
      }
    }
  }

  const unmarkedCensusMismatch = [];
  // issue #802：「登记为必须命中」与「中英处数必须相等」这两条都删了。它们只能抓「这句散文被删/被改写」，
  // 抓不到任何行为问题；正当的文档改写（把一句默认声明搬进表格、或合并两句）都会被判红。
  // 保留的是真值对账：**句子在的时候**，它说的默认策略必须等于源码里的现值（上面那几组判据）。
  // 缺哪一格现在只进 note，由人判断「是不是该在文档里说这件事」。
  const missingDefaults = COMPACTION_CLAIM_REQUIRED
    .filter(({ doc, layer }) => (counts.get(`${doc}|${layer}`) ?? 0) === 0)
    .map(({ doc, layer }) => `${doc}/${layerName[layer]}`);

  // ── ③ 无标记的默认声称（issue #668 ① 的残留盲区）────────────────────────────
  // ①② 都靠标记词定位句子，于是「新写一句不带标记的默认声称」整句落在面外。这一节反过来：
  // 只要「默认声称 + 内置策略名」同句搭配，就**必须**带层标记词。判据（五道闸）在
  // `compactionUnmarkedDefaultClaims` 上那段「怎么区分」的注释里。
  const markerRes = compactionLayerMarkerRes();
  const face = liveDocFace();
  if (face.error !== null) errors.push(face.error);
  if (compactionDefaultWords().length === 0) {
    errors.push("compaction-default/unmarked: 判据词表 `COMPACTION_DEFAULT_WORDS` 是空的——"
      + "③ 会一句也判不到（抽不到判据词就报错，#164 口径；这一条不是豁免开关）");
  }
  /** 每份文档里**指不出层**的默认声称处数（中英成对与报告都读它）。 */
  const unmarked = new Map();
  let unmarkedTotal = 0;
  for (const doc of face.docs) {
    const src = textOf(doc);
    if (typeof src !== "string") continue;   // 入库清单里读不到的那份由 `paths:` 那一节点名
    const claims = compactionUnmarkedDefaultClaims(src, truth.names, markerRes);
    if (claims.length === 0) continue;
    unmarked.set(doc, claims.length);
    unmarkedTotal += claims.length;
    for (const claim of claims) {
      errors.push(`compaction-default/unmarked: ${doc}:${claim.line} 说默认是 \`${claim.name}\`，却没有指出这是**哪一层**——`
        + "这种写法指不出是哪一层，无法与任何一层的真值对账（登记过的分层标记词：`library default` / `库层默认` / "
        + "`CLI slot default` / `CLI 槽位默认`，或明确量化「no layer defaults to / 任何一层默认」）。"
        + `\n      「${claim.snippet}」`
        + "\n      正解是拆成两句、各带层标记："
        + `库层 = \`${truth.library}\`（不配策略时由 ${COMPACTION_PIPELINE_SRC} 的兜底层接手）`
        + `；CLI 槽位 = \`${truth.cli}\`（\`slots.default.compaction\` 缺省时解析成它）。`
        + "\n      只谈「默认 summarizer」（`default summarizer` / `默认 summarizer`）的句子不在此列——那是另一个话题。");
    }
  }
  for (const [en, cn] of COMPACTION_DOC_PAIRS) {
    const a = unmarked.get(en) ?? 0;
    const b = unmarked.get(cn) ?? 0;
    if (a === b) continue;
    // issue #802：不再判红——「只在一侧写了这句」是散文事实，不是行为回归（下面 ③ 的真值判据照旧：
    // 无标记的默认声称只要**句子存在**，它就必须与源码现值一致）。只记 note。
    unmarkedCensusMismatch.push(`${en} ${a} / ${cn} ${b}`);
  }

  notes.push(`compaction-default: 压缩策略默认值分层对账（库层 \`${truth.library}\` ← ${COMPACTION_PIPELINE_SRC} 的兜底层；`
    + `CLI 层 \`${truth.cli}\` ← ${COMPACTION_CLI_SRC} 帮助文本 + ${COMPACTION_CLI_CONST_SRC} 常量；`
    + (missingDefaults.length ? `登记过但今天没出现的（不判红，issue #802）：${missingDefaults.join(", ")}；` : "")
    + `${COMPACTION_DEFAULT_DOCS.length} 份活文档逐处对账，退役句式 ${mixedShapes.length} 种；`
    + (unmarkedCensusMismatch.length ? `；中英处数不齐（不判红，issue #802）：${unmarkedCensusMismatch.join("；")}` : "")
    + `③ 无标记的默认声称 ${unmarkedTotal} 处（入库 Markdown 面 ${face.docs.length} 份，历史类不判，判据词 ${compactionDefaultWords().length} 条））`);
  collectCompactionDefaultErrors.notes = notes;
  return errors;
}

// ── 2.11 退役语义「摘要器失败 ⇒ 降级/兜底为统计摘要」（issue #668 ②）──────────────
//
// 病根（#668 ②）：issue #661 把「`fold-llm` 摘要器失败/超时 ⇒ 静默降级为统计摘要、run 不失败」判死
// （现在是终局错误 `summarizer_failed`：run 以 `failed` 结束、CLI 退出码 5）。三处**活文档**在撒谎的
// 那几句已由 #661 自己修掉；本节买的是**防回潮**——那句话再出现在活面上就红。
//
// 为什么不能拿一条正则了事（本节的**全部**风险）：朴素搭配会同时命中「已死的谎」与「还活着的事实」——
//   · `src/compact/fold-llm.js` 里那几处讲的是**仍然存在**的降级分类（`classifyFoldDegradeKind`）与
//     「改前是什么」；`src/loop/orchestrator.js` 里那几处讲的是 #643 的**预算兜底 + 机械摘要**，
//     那是另一套机制，与摘要器失败无关；
//   · `src/compact/fold-summary-journal.js` 里「`fold-llm` 的降级兜底」是**合法保留形态**：
//     #661 之前写下的旧账本行仍可能带 `source: "statistical"`，映射表照旧要认它。
// 所以判据是「搭配 + 三种合法读法」，不是「出现某个词就红」：
//   ① **搭配**：同一行里「降级 / 兜底 / 回退 / 退回 / degrade / fall back / fallback」与
//      「统计摘要 / statistical summary」相距 ≤ 30 字符。英文的**连字符形态**（`statistical-summary
//      degradation`）也算：0.30 指南与 charts 用的就是它，而只认空格形态的正则漏掉了
//      `src/compact/provider-summarizer.js` 里一句一模一样的谎（#661 之后它一直是假话，门禁一路绿）。
//   ② **三种合法读法**（命中带其中一条 ⇒ 记为 `mention`，不红）：
//      · 直接否定：`不再` / `不会` / `从未` / `no longer` 与降级动词之间只隔 ≤ 8 个**非断句**字符
//        （`不会退回统计摘要`、`不再降级统计摘要`）。刻意**不**把「句子里出现 `不会` / `not`」当放行：
//        「失败不会让 run 失败，而是降级为统计摘要」正是谎的形状，而它的 `不会` 并不紧挨降级动词；
//      · 对照：那半句前面 24 字符内有 `instead of` / `rather than` / `not a` / `而不是` / `而非` / `不是`；
//      · 历史框定：命中行上下各 ≤ 2 行（遇空行止）的同一段里出现时态标记（`改前` / `此前` /
//        `已被删` / `旧语义` / `removed` / `used to` / `退役` …）——历史要留，但不许冒充现状。
//   ③ 判据只咬**活面**：入库清单（`git ls-files`）里的 `*.md` 加 `bin/`、`src/` 的 JS（**注释也在面内**：
//      改代码的人读的第一手材料就是注释），按路径剔掉历史类。面**只取** `git ls-files`（#560 的教训），
//      绝不走文件系统遍历；`git` 拿不到清单就报红，不回退。
//
// 与 `LIVE_DOC_HISTORY` 的差别是**故意的**：那一族的题目是「默认值变了没有」，版本化升级指南讲的正是
// 「变了」，所以它在面内；本族的题目是「旧行为还在不在」，0.29 指南里「统计摘要器降为降级兜底」是
// **当时为真**的记录，把它算成谎等于逼人改历史（#668 的分类表也把它列在历史一类）。
//
// 源码真值（`retiredSemanticsTruth()`）：本节不抄文档，而是把文档那半句**绑到源码**上——
// `src/compact/fold-llm.js` 的**代码面**（注释先涂空、字符串留着，与 #299 的符号抽取同一份词法分类）
// 必须仍有 `summarizer_failed`，且必须**不再**出现退役横幅 `已降级为统计摘要`。任一翻转 ⇒ 红：
// 那说明「失败即降级」的路径回来了（或终局错误没了），此时活文档里每一处「失败是终局错误、不再降级」
// 都变成假话——**改源码真值不改文档**就是这么被抓到的（自测里有一格专门打它）。

/** 本族的历史面（写的是「当时如此」）：正文一字不改，也不进判据。 */
const RETIRED_SEMANTICS_HISTORY = Object.freeze([
  /^CHANGELOG\.md$/u,
  /^docs\/v0\./u,
  /^docs\/decisions\//u,
  /^docs\/design\//u,
  /^docs\/research\//u,
  /^docs\/harness-comparison\//u,
  /^docs\/tasks\//u,
  /^docs\/delivery\//u,
  /^docs\/issue-469-/u,
  /^docs\/host-upgrade-guide-/u,
]);

/** 源码面：`bin/` 与 `src/` 的 JS（注释也在面内）。 */
const RETIRED_SEMANTICS_SOURCE = /^(?:bin|src)\/.*\.js$/u;

/** 真值出处：退役路径就在这个文件里（终局错误与退役横幅都在它身上）。 */
const RETIRED_SEMANTICS_TRUTH_SRC = "src/compact/fold-llm.js";
/** 退役横幅的字面量（#661 之前 fold-llm 失败时打的那一块）。回到**代码面**就是路径回来了。 */
const RETIRED_SEMANTICS_BANNER = "已降级为统计摘要";

/** 搭配的两半。`fall(?:s|ing)?\s*back` 连 `falls back` / `falling back` 一起认。 */
const RS_DEGRADE = /(?:降级|兜底|回退|退回|degrad\w*|fall(?:s|ing)?\s*back|fallback)/giu;
/** `statistical summary` 与 `statistical-summary` 都算（见上面 §2.11 的 ①）。 */
const RS_STATISTICAL = /(?:统计摘要|statistical[\s-]+summary)/giu;
/** 搭配的距离上限（字符）。 */
const RS_PAIR_WINDOW = 30;
/** 文件级快速排除：两半**都**得出现过才可能搭配（`--self-test` 一轮要跑上百次，
 *  而 249 份入库文件里只有 21 份同时带这两半——这不是放宽判据，是同一个条件的廉价前判）。 */
const RS_ANY_DEGRADE = /(?:降级|兜底|回退|退回|degrad|fall)/iu;
const RS_ANY_STATISTICAL = /(?:统计摘要|statistical)/iu;
/** ②·直接否定：否定词与降级动词之间只隔 ≤ 8 个非断句字符。 */
const RS_NEGATION = /(?:不再|不会|从未|no longer)\s*[^。；\n]{0,8}?(?:降级|兜底|回退|退回|degrad\w*|fall(?:s|ing)?\s*back|fallback)/iu;
/** ②·对照：命中半句前面这段窗口里出现对照词。 */
const RS_CONTRAST = /(?:instead of|rather than|not a |而不是|而非|不是|并非)/iu;
const RS_CONTRAST_LEAD = 24;
/** ②·历史框定：同一段里的时态标记。 */
const RS_HISTORICAL = /改前|此前|以前|原来|旧语义|旧账本|旧版|已删|被删|删掉|删除|移除|removed|deleted|dropped|used to|previously|退役|retired/iu;

/** 中英成对的那两对活文档（复用 `assertPairCensus`，不另造处数对账）。 */
const RETIRED_SEMANTICS_PAIRS = Object.freeze([[REQ_EN, REQ_CN], [CHARTS_EN, CHARTS_CN]]);
/** 必须命中至少一次的文档（整句被删掉、或措辞改到判据够不着 ⇒ 检查面在这份文档失效）。 */
const RETIRED_SEMANTICS_REQUIRED = Object.freeze([REQ_EN, REQ_CN, CHARTS_EN, CHARTS_CN]);

/** 面只算一次：`--self-test` 一轮要跑上百次全量检查，但 overlay 改的是**正文**，入库清单不变。 */
let RETIRED_SEMANTICS_FACE_CACHE = null;

/**
 * 本族的扫描面 = **入库**清单（`git ls-files`）里的 Markdown 与 `bin/`、`src/` 的 JS，按路径剔掉历史类。
 *
 * 为什么走 `git ls-files` 而不是遍历文件系统（#560 的教训）：遍历会把不入库的文件喂给判据，
 * 于是同一份仓库内容在开发树与干净克隆里给出两个答案。清单拿不到 ⇒ **报红**（#164 口径：
 * 抽不到真值就报错），**没有**文件系统回退分支。
 *
 * @returns {{docs: string[], error: string|null}}
 */
function retiredSemanticsFace() {
  if (RETIRED_SEMANTICS_FACE_CACHE !== null) return { docs: RETIRED_SEMANTICS_FACE_CACHE, error: null };
  let raw;
  try {
    raw = execFileSync("git", ["ls-files", "-z", "--cached", "--full-name"], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().split("\n").filter(Boolean)[0] ?? String(error);
    return {
      docs: [],
      error: `retired-semantics/face: 取不到入库清单（\`git ls-files\` 失败：${detail}）——本族的扫描面失效。`
        + "不许退回文件系统遍历：那会把不入库的文件喂给判据，让门在开发树与干净克隆里给出两个答案（#560）",
    };
  }
  const docs = [...new Set(raw.split("\0")
    .filter((rel) => rel.length > 0)
    .map((rel) => rel.split(path.sep).join("/")))]
    .filter((rel) => rel.endsWith(".md") || RETIRED_SEMANTICS_SOURCE.test(rel))
    .filter((rel) => !RETIRED_SEMANTICS_HISTORY.some((re) => re.test(rel)))
    .sort();
  if (docs.length === 0) {
    return { docs, error: "retired-semantics/face: 入库清单剔掉历史类之后是空的——本族会假绿（#164 口径：抽不到真值就报错）" };
  }
  RETIRED_SEMANTICS_FACE_CACHE = docs;
  return { docs, error: null };
}

/** 命中行上下各 ≤ 2 行的同段窗口（遇空行止）。历史框定只在这个窗口里找。 */
function retiredSemanticsWindow(lines, index, span = 2) {
  let from = index;
  let to = index;
  while (from > 0 && index - from < span && lines[from - 1].trim() !== "") from -= 1;
  while (to + 1 < lines.length && to - index < span && lines[to + 1].trim() !== "") to += 1;
  return lines.slice(from, to + 1).join("\n");
}

/**
 * 一段文本里所有「降级 × 统计摘要」的搭配。
 *
 * @param {string} src 文件正文
 * @returns {Array<{line: number, why: string|null, snippet: string}>} `why === null` ⇒ 声称（红）；
 *   否则是带标记的合法读法（`negation` / `contrast` / `historical`）。
 */
function retiredSemanticsHits(src) {
  const hits = [];
  const lines = src.split("\n");
  for (const [index, line] of lines.entries()) {
    const degrade = [...line.matchAll(RS_DEGRADE)].map((m) => m.index);
    const statistical = [...line.matchAll(RS_STATISTICAL)].map((m) => m.index);
    if (degrade.length === 0 || statistical.length === 0) continue;
    let closest = null;
    for (const d of degrade) {
      for (const s of statistical) {
        const gap = Math.abs(d - s);
        if (gap > RS_PAIR_WINDOW) continue;
        if (closest === null || gap < closest.gap) closest = { gap, start: Math.min(d, s) };
      }
    }
    if (closest === null) continue;
    const window = retiredSemanticsWindow(lines, index);
    const lead = line.slice(Math.max(0, closest.start - RS_CONTRAST_LEAD), closest.start);
    const why = RS_NEGATION.test(window) ? "negation"
      : RS_CONTRAST.test(lead) ? "contrast"
        : RS_HISTORICAL.test(window) ? "historical" : null;
    hits.push({ line: index + 1, why, snippet: line.trim().slice(0, 160) });
  }
  return hits;
}

/**
 * 源码真值：`fold-llm` 的失败出口**必须**仍是终局错误，且退役横幅**必须**不在代码面里。
 *
 * 注释先涂空、字符串留着（`maskJs`，与 #299 的符号抽取同一份词法分类）：注释里引用那句横幅是合法的
 * （那是在讲它退役了），而它若回到**代码**里，一定是字符串字面量。
 *
 * @returns {{errors: string[], terminal: boolean, bannerGone: boolean}}
 */
function retiredSemanticsTruth() {
  const errors = [];
  const src = textOf(RETIRED_SEMANTICS_TRUTH_SRC);
  if (typeof src !== "string") {
    errors.push(`retired-semantics/truth: 读不到 ${RETIRED_SEMANTICS_TRUTH_SRC}——「摘要器失败是终局错误」这条真值`
      + "无从抽起（检查面失效，#164 口径：抽不到真值就报错）");
    return { errors, terminal: false, bannerGone: false };
  }
  const code = maskJs(src, { keepStrings: true });
  const terminal = /summarizer_failed/u.test(code);
  if (!terminal) {
    errors.push(`retired-semantics/truth: ${RETIRED_SEMANTICS_TRUTH_SRC} 的**代码面**里抽不到 \`summarizer_failed\`——`
      + "摘要器失败不再是终局错误，而活文档仍在说它是（改源码真值不改文档 = 文档在撒谎）");
  }
  const bannerLine = code.split("\n").findIndex((line) => line.includes(RETIRED_SEMANTICS_BANNER));
  const bannerGone = bannerLine === -1;
  if (!bannerGone) {
    errors.push(`retired-semantics/truth: ${RETIRED_SEMANTICS_TRUTH_SRC}:${bannerLine + 1} 的**代码面**里又出现了退役横幅`
      + `字面量 \`${RETIRED_SEMANTICS_BANNER}\`——「失败即降级为统计摘要」那条路径回到了代码里，`
      + "而活文档仍在说「失败是终局错误、不再降级」：两侧必须一起动（改源码真值不改文档 = 文档在撒谎）");
  }
  return { errors, terminal, bannerGone };
}

/**
 * 本族的判据：活面上每一处「降级 × 统计摘要」的搭配都必须带三种合法读法之一，
 * 且那半句必须与源码真值一致（见 §2.11 的节头）。
 *
 * @returns {string[]} 错误文本（不直接写全局，好让 `--self-test` 复用同一份实现）
 */
function collectRetiredSemanticsErrors() {
  const errors = [];
  const notes = [];
  const face = retiredSemanticsFace();
  if (face.error !== null) errors.push(face.error);

  const claims = [];
  const mentions = [];
  const perDoc = new Map();
  for (const doc of face.docs) {
    const src = textOf(doc);
    if (typeof src !== "string") {
      errors.push(`retired-semantics: 读不到 ${doc}——它在入库面里，读不到就等于那份没人校`);
      continue;
    }
    if (!RS_ANY_DEGRADE.test(src) || !RS_ANY_STATISTICAL.test(src)) continue;
    for (const hit of retiredSemanticsHits(src)) {
      perDoc.set(doc, (perDoc.get(doc) ?? 0) + 1);
      (hit.why === null ? claims : mentions).push({ doc, ...hit });
    }
  }

  for (const claim of claims) {
    errors.push(`retired-semantics: ${claim.doc}:${claim.line} 说「摘要器失败/超时 ⇒ 自动降级或兜底为统计摘要」，`
      + "而 issue #661 起那是**终局错误**（`summarizer_failed`：run 以 `failed` 结束、CLI 退出码 5，不退回统计摘要）"
      + `\n      「${claim.snippet}」`
      + "\n      三种合法写法（判据认这三种）：① 直接否定——`不再` / `不会` / `no longer` 紧挨着降级动词；"
      + "② 对照——`instead of` / `rather than` / `而不是` / `而非` 紧挨着那半句；"
      + "③ 历史框定——同一段里带 `改前` / `此前` / `已被删` / `removed` 一类时态标记（历史要留，但不许冒充现状）。"
      + "\n      想表达「零 LLM 的折叠」请显式点名 `fold-statistical` 是**替代选择**，而不是 `fold-llm` 的自动兜底。");
  }

  const truth = retiredSemanticsTruth();
  errors.push(...truth.errors);
  if ((!truth.terminal || !truth.bannerGone) && claims.length + mentions.length > 0) {
    errors.push(`retired-semantics/truth: 源码真值已经不再支持「失败即终局」这句话，而活面里仍有 `
      + `${claims.length + mentions.length} 处相关陈述（声称 ${claims.length} / 带标记的保留形态 ${mentions.length}）——`
      + "改源码真值不改文档就是这种形状，两侧必须一起动");
  }

  // issue #802：同 compaction 那族——「必须命中」与中英处数普查都删了。留下的真值判据是上面那两条：
  // 源码真值说「失败即终局」时，活面上**不许**有相反的声称；句子不在就不判。
  const missingRetired = RETIRED_SEMANTICS_REQUIRED.filter((doc) => (perDoc.get(doc) ?? 0) === 0);

  notes.push(`retired-semantics: 「摘要器失败 ⇒ 降级/兜底为统计摘要」这条退役语义（#668 ②）在 `
    + `${face.docs.length} 份入库活文件上逐行对账（Markdown + \`bin/\`/\`src/\` 的 JS，历史类按路径不判）：`
    + `声称 ${claims.length} 处（红）/ 带标记的保留形态 ${mentions.length} 处；源码真值 \`summarizer_failed\` `
    + `${truth.terminal ? "在" : "缺"}、退役横幅 ${truth.bannerGone ? "已不在代码面里" : "又回到代码面里"}`
    + (missingRetired.length ? `；登记过但今天没出现的（不判红，issue #802）：${missingRetired.join(", ")}` : ""));
  collectRetiredSemanticsErrors.notes = notes;
  return errors;
}

// ── 2.12 契约「套件清单」的 unknownSlot 形态（issue #677）────────────────────────────
// 病历：契约里有一张「套件清单 / Suite inventory」散文表（EN `### Suite inventory (issue #183)`、
// CN `### 套件清单（issue #183）`），`model-config-provider.js` 那一行讲的是**按 provider 形态分别作答**
// 的未知槽名答案（issue #518：一条断言盖住两种形态 = 那条假承诺的病根）。这张表此前**零机器闸**
// （`grep -rn '套件清单\|Suite inventory' scripts/*.mjs` = 0），于是它可以被悄悄压平 / 单边改写 / 与真值
// 脱节而门禁一路绿。本族把它接上：
//   ① 真值：`test/contract/model-config-provider.js` 里 `unknownSlot.mode` 的判别值（注释先涂空——
//      注释里讲形态是合法的，代码里才是真值），**至少**要能抽出 `throws` / `single-config` 两种；
//   ② 两侧逐条语义：槽位图形态（static / json-file）未知槽名必须 throw、点名该槽名、列出可用槽位、
//      不许回落 default；单配置形态任何槽名返回同一份配置，且**不是**「未知回落 default」；
//   ③ 判据按**形态窗口**分段过：窗口按形态标记切（槽位图 → 单配置），每段只准出现自己那条腿的断言
//      ——把两段合成「都要抛」或「都返回同一份」就是 #518 的压平，必红；
//   ④ 中英同一套 facet id：任一侧缺一条 ⇒ 既报「缺语义」又报「中英背离」（只改一边不算改）。

/** 真值源：unknownSlot 的形态判别就写在这个套件里（`test/contract/model-config-provider.js`）。 */
const SUITE_INVENTORY_TRUTH_SRC = "test/contract/model-config-provider.js";

/** 两份契约里「套件清单」小节的标题行（按行首定位，不在全文里瞎搜）。 */
const SUITE_INVENTORY_SECTION = Object.freeze({
  [CONTRACT_EN]: /^### Suite inventory\b/u,
  [CONTRACT_CN]: /^### 套件清单/u,
});

/** 那一行的行首键（表格第一格）。行丢了 = 本族在这份文档上失效，按 #164 口径报错。 */
const SUITE_INVENTORY_ROW_KEY = "`model-config-provider.js`";

/** 形态窗口的分界标记：`slotmap` 段 = 槽位图形态那条腿，`single` 段 = 单配置形态那条腿。 */
const SUITE_INVENTORY_MARKERS = Object.freeze({
  [CONTRACT_EN]: Object.freeze({ slotmap: /slot-map/u, single: /single-config/u }),
  [CONTRACT_CN]: Object.freeze({ slotmap: /槽位图形态/u, single: /单配置形态/u }),
});

/**
 * 判据面：每种形态的每一条语义各一格，**中英同一个 id**（一侧缺 ⇒ 「缺语义」+「中英背离」两条都报）。
 *
 * `mode` 是该 facet 对应的 `unknownSlot.mode` 真值值：真值里的形态集合与这里的 `mode` 集合必须相等
 * （真值加了一种形态而文档没跟 = 文档在撒谎；真值删了一种而文档仍在讲 = 同一件事的另一面）。
 * 正则只认**语义**，不抄原话：同义改写（`must throw` → `has to throw`）仍应绿，压平/删句必红。
 */
const SUITE_INVENTORY_FACETS = Object.freeze([
  {
    id: "slot-map-shape",
    mode: "throws",
    window: "slotmap",
    why: "槽位图形态（static / json-file）必须点名——#518 的病就是把两种形态混成一条",
    re: {
      [CONTRACT_EN]: /slot-map\b[^|]{0,60}\(static\s*\/\s*json-file\)/u,
      [CONTRACT_CN]: /槽位图形态[^|]{0,60}（static\s*\/\s*json-file）/u,
    },
  },
  {
    id: "slot-map-throws",
    mode: "throws",
    window: "slotmap",
    why: "槽位图形态的未知槽名必须 throw / 抛错",
    re: {
      [CONTRACT_EN]: /\bthrow(?:s|ing)?\b/u,
      [CONTRACT_CN]: /抛错|抛异常|抛出错误/u,
    },
  },
  {
    id: "slot-map-names-unknown",
    mode: "throws",
    window: "slotmap",
    why: "错误必须点名那个未知槽名（宿主才看得懂写错了哪个槽）",
    re: {
      [CONTRACT_EN]: /nam(?:e|es|ing)\s+the\s+unknown\s+slot/u,
      [CONTRACT_CN]: /点名[^|。；\n]{0,8}槽名/u,
    },
  },
  {
    id: "slot-map-lists-available",
    mode: "throws",
    window: "slotmap",
    why: "错误必须列出可用槽位",
    re: {
      [CONTRACT_EN]: /list(?:s|ing)?\s+the\s+available\b/u,
      [CONTRACT_CN]: /列出[^|。；\n]{0,8}可用槽位/u,
    },
  },
  {
    id: "slot-map-no-default-fallback",
    mode: "throws",
    window: "slotmap",
    why: "不得回落 default（#518：写错槽位 ⇒ 跑的是另一个模型，且永远不知道）",
    re: {
      [CONTRACT_EN]: /never\s+fall(?:s|ing)?\s*back\s+to\s+default/u,
      [CONTRACT_CN]: /(?:不许|不得|不会|不)\s*回落\s*default/u,
    },
  },
  {
    id: "single-config-shape",
    mode: "single-config",
    window: "single",
    why: "单配置形态必须点名",
    re: {
      [CONTRACT_EN]: /single-config\b/u,
      [CONTRACT_CN]: /单配置形态/u,
    },
  },
  {
    id: "single-config-same-config",
    mode: "single-config",
    window: "single",
    why: "单配置形态任何槽名都返回同一份配置",
    re: {
      [CONTRACT_EN]: /returns?\s+the\s+same\s+config/u,
      [CONTRACT_CN]: /返回同一份配置/u,
    },
  },
  {
    id: "single-config-not-default-fallback",
    mode: "single-config",
    window: "single",
    why: "单配置形态是**形态差异**，不是「未知回落 default」——两者混为一谈就是 #518 那条假承诺",
    re: {
      [CONTRACT_EN]: /not\s+an?\s+unknown-slot\s+fallback\s+to\s+default/u,
      [CONTRACT_CN]: /不是[^|。；\n]{0,16}回落\s*default/u,
    },
  },
]);

/**
 * 窗口内的**反向**判据：压平（一条断言盖住两种形态）的两种典型形状。
 * 「单配置那段里说 throw」= 两种都要抛；「槽位图那段里说返回同一份」= 两种都不选槽。
 */
const SUITE_INVENTORY_FLATTENED = Object.freeze([
  {
    window: "single",
    why: "单配置形态那一段里出现了 throw / 抛错 ⇒ 两种形态被压平成「未知槽名都要抛」（#518 的病）",
    re: { [CONTRACT_EN]: /\bthrow(?:s|ing)?\b/u, [CONTRACT_CN]: /抛错|抛异常|抛出错误/u },
  },
  {
    window: "slotmap",
    why: "槽位图形态那一段里出现了「返回同一份配置」⇒ 两种形态被压平（槽位图形态不许有这条腿）",
    re: { [CONTRACT_EN]: /returns?\s+the\s+same\s+config/u, [CONTRACT_CN]: /返回同一份配置/u },
  },
]);

/** 本族必须两边都写的两份文档（顺序即报错顺序）。 */
const SUITE_INVENTORY_DOCS = Object.freeze([CONTRACT_EN, CONTRACT_CN]);

/**
 * 在一份契约的正文里定位「套件清单」小节，取出 `model-config-provider.js` 那一行。
 *
 * 返回 `{ start, end, line, text, cell }`：`start/end` 是整行在正文里的偏移（自测的定点打靶器用），
 * `line` 是 1 起的行号，`cell` 是第 2 列（「断言什么」那一格）——语义窗口只在格内算，
 * 不让后面两格的散文混进窗口。抽不到就返回 `null`（调用方按 #164 口径报错，不回退、不静默）。
 *
 * @param {string} rel 文档相对路径（决定小节标题与形态标记）
 * @param {string} src 文档正文（可以是 overlay 之后的文本）
 * @returns {{start:number,end:number,line:number,text:string,cell:string}|null}
 */
function suiteInventoryRowOf(rel, src) {
  const heading = SUITE_INVENTORY_SECTION[rel];
  const markers = SUITE_INVENTORY_MARKERS[rel];
  if (!heading || !markers) return null;
  const lines = String(src).split("\n");
  const from = lines.findIndex((line) => heading.test(line));
  if (from === -1) return null;
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i += 1) {
    if (/^#{2,3}\s/u.test(lines[i])) { to = i; break; }
  }
  for (let i = from + 1; i < to; i += 1) {
    const line = lines[i];
    if (!line.startsWith(`| ${SUITE_INVENTORY_ROW_KEY}`)) continue;
    const start = lines.slice(0, i).join("\n").length + 1;
    const parts = line.split("|");
    return { start, end: start + line.length, line: i + 1, text: line, cell: parts.length >= 4 ? parts[2] : "" };
  }
  return null;
}

/**
 * 真值：`unknownSlot.mode` 的判别值集合（**代码面**，注释先涂空、字符串保留）。
 *
 * 为什么涂注释：那个文件的 JSDoc 里就写着 `{mode:"throws", name, available}`（那是在**讲**契约，
 * 合法的）；真值只能是代码里真正参与判别的字面量，否则「注释里写一种形态」就能糊过门禁。
 *
 * @returns {{modes: string[], errors: string[]}}
 */
function suiteInventoryTruth() {
  const src = textOf(SUITE_INVENTORY_TRUTH_SRC);
  if (typeof src !== "string") {
    return {
      modes: [],
      errors: [`suite-inventory/truth: 读不到 ${SUITE_INVENTORY_TRUTH_SRC}——「未知槽名按 provider 形态分别作答」`
        + "这条真值无从抽起（#164 口径：抽不到真值就报错）"],
    };
  }
  const code = maskJs(src, { keepStrings: true });
  const modes = [...new Set([...code.matchAll(/unknownSlot\.mode\s*[!=]==?\s*"([^"]+)"/gu)].map((m) => m[1]))].sort();
  const errors = [];
  if (modes.length === 0) {
    errors.push(`suite-inventory/truth: ${SUITE_INVENTORY_TRUTH_SRC} 的**代码面**里抽不到任何 \`unknownSlot.mode\` 判别值`
      + "——未知槽名的答案不再按形态分开，而两份契约仍在说它按形态分开（改真值不改文档 = 文档在撒谎）");
    return { modes, errors };
  }
  const declared = [...new Set(SUITE_INVENTORY_FACETS.map((facet) => facet.mode))].sort();
  for (const mode of modes.filter((m) => !declared.includes(m))) {
    errors.push(`suite-inventory/truth: ${SUITE_INVENTORY_TRUTH_SRC} 的 unknownSlot 形态里多出 \`${mode}\`，`
      + `而两份契约的套件清单没有为它写一条答案（真值加了形态、文档没跟；文档声明的形态只有 ${declared.join(" / ")}）`);
  }
  for (const mode of declared.filter((m) => !modes.includes(m))) {
    errors.push(`suite-inventory/truth: ${SUITE_INVENTORY_TRUTH_SRC} 的 unknownSlot 形态里抽不到 \`${mode}\`」`
      + "——真值已经不再区分这种形态，而两份契约仍在为它陈述答案（改真值不改文档 = 文档在撒谎）");
  }
  return { modes, errors };
}

/**
 * 本族的判据：真值（两种 mode）× 两份契约的套件清单行（逐形态窗口、逐条语义、中英同 id）。
 *
 * @returns {string[]} 错误文本（不直接写全局，好让 `--self-test` 复用同一份实现）
 */
function collectSuiteInventoryErrors() {
  const errors = [];
  const notes = [];
  const truth = suiteInventoryTruth();
  errors.push(...truth.errors);

  const present = new Map(SUITE_INVENTORY_FACETS.map((facet) => [facet.id, new Set()]));
  for (const doc of SUITE_INVENTORY_DOCS) {
    const src = textOf(doc);
    if (typeof src !== "string") {
      errors.push(`suite-inventory: 读不到 ${doc}——它是本族必须对账的两份契约之一，读不到就等于那份没人校`);
      continue;
    }
    const row = suiteInventoryRowOf(doc, src);
    if (row === null) {
      errors.push(`suite-inventory: ${doc} 的「套件清单」小节里找不到 \`model-config-provider.js\` 那一行——`
        + "套件清单少一行 / 小节标题被改，本族的判据在这份文档上失效（#164 口径：抽不到真值就报错）");
      continue;
    }
    const markers = SUITE_INVENTORY_MARKERS[doc];
    const slotmapAt = row.cell.search(markers.slotmap);
    const singleAt = row.cell.search(markers.single);
    if (slotmapAt === -1 || singleAt === -1 || singleAt < slotmapAt) {
      errors.push(`suite-inventory: ${doc}:${row.line} 的 \`model-config-provider.js\` 行切不出「槽位图 → 单配置」两段形态窗口`
        + `（槽位图标记 ${slotmapAt === -1 ? "缺" : "在"} / 单配置标记 ${singleAt === -1 ? "缺" : "在"}`
        + `${singleAt !== -1 && slotmapAt !== -1 && singleAt < slotmapAt ? " / 顺序颠倒" : ""}）——`
        + "两种 provider 形态的答案被压平成一条，正是 #518 之前那条假承诺的形状（issue #677）");
      continue;
    }
    const windows = { slotmap: row.cell.slice(slotmapAt, singleAt), single: row.cell.slice(singleAt) };
    for (const facet of SUITE_INVENTORY_FACETS) {
      const re = facet.re[doc];
      if (re.test(windows[facet.window])) {
        present.get(facet.id).add(doc);
        continue;
      }
      errors.push(`suite-inventory: ${doc}:${row.line} 的 \`model-config-provider.js\` 行缺一条语义——${facet.why}`
        + `（${facet.window === "slotmap" ? "槽位图形态" : "单配置形态"}那一段里没写到；判据 ${re}）`);
    }
    for (const flat of SUITE_INVENTORY_FLATTENED) {
      const re = flat.re[doc];
      if (!re.test(windows[flat.window])) continue;
      errors.push(`suite-inventory: ${doc}:${row.line} 的 \`model-config-provider.js\` 行被压平了——${flat.why}`);
    }
  }

  // 中英背离：一条 facet 只有一侧写了 ⇒ 另一侧读者拿到的是一半的答案（「只改一边不算改」）。
  for (const facet of SUITE_INVENTORY_FACETS) {
    const hit = present.get(facet.id);
    if (hit.size === 0 || hit.size === SUITE_INVENTORY_DOCS.length) continue;
    const missing = SUITE_INVENTORY_DOCS.filter((doc) => !hit.has(doc));
    errors.push(`suite-inventory: 中英背离——「${facet.why}」只有 ${[...hit].join("、")} 写了，`
      + `${missing.join("、")} 没有（issue #677：任一侧缺语义或被压平都必须红）`);
  }

  notes.push(`suite-inventory: 套件清单的 \`model-config-provider.js\` 行（issue #677）按 `
    + `${SUITE_INVENTORY_FACETS.length} 条语义 × 中英两侧逐条对账（形态窗口内分段判，压平另判 `
    + `${SUITE_INVENTORY_FLATTENED.length} 种形状）；真值 ${SUITE_INVENTORY_TRUTH_SRC} 的 unknownSlot 形态 = `
    + `${truth.modes.length ? truth.modes.map((m) => `\`${m}\``).join(" / ") : "（抽不到）"}`);
  collectSuiteInventoryErrors.notes = notes;
  return errors;
}

// ── 2.13 强制收尾资格「按状态，不按 reason 枚举」（issue #475 post-stop verification）──
// 病历（issue #677 补充范围）：契约 §7「post-stop verification / 停止后验证」那句曾把资格写成
// **reason 白名单**（#467 的形状：往白名单上贴一条 `judge_done`），而 #475 把判据下沉成**状态**——
// 「被预算/截断掐断的那三条沿用更严的截断判据，其余 reason 只过一个判据：整个 run 一个字都没写过」，
// 于是新增 reason 天然被覆盖。这句话此前**零机器闸**：它既可以被压平回白名单口径（假话回潮），
// 也可以与 `src/loop/termination.js` 的成员集合悄悄脱节（源码加了/删了 reason，契约照旧）。
// 本族把它接上，三条形状各有一腿：
//   ① 两侧逐条语义（中英同一套 facet id）：状态口径、三条沿用截断判据、其余只看「一个字都没写过」、
//      新增 reason 天然覆盖、覆盖 ≠ 安全、覆盖那句点名 guard 集合与 `end_turn` / `no_tool`；
//      任一侧压平/退回假话 ⇒ 红；
//   ② 中英背离：某条语义只有一侧写了 ⇒ 缺语义 + 背离两条都报；
//   ③ 固定 reason 名单 × 源码成员集合：契约点名的「三条不可续跑」必须**恰好等于**
//      `FORCED_FINAL_TRUNCATED_REASONS`（双向），「覆盖 ≠ 安全」点名的 `end_turn` / `no_tool`
//      必须真在 `FINAL_GUARD_TERMINATION_REASONS` 里；任一失配 ⇒ 红（改源码不改契约必红）。

/** 真值源：两个 reason 集合都在这里（`src/loop/termination.js`）。 */
const FORCED_FINAL_TRUTH_SRC = "src/loop/termination.js";
/** 被预算/截断掐断的三条（函数作用域内私有，**不导出**——所以按名字在代码面里找字面量）。 */
const FORCED_FINAL_TRUNCATED_SET = "FORCED_FINAL_TRUNCATED_REASONS";
/** guard 适用 reason 集合（「覆盖 ≠ 安全」那句的真值）。 */
const FORCED_FINAL_GUARD_SET = "FINAL_GUARD_TERMINATION_REASONS";

/** §7 小节的起止行：按**编号 + 标题**定位（编号变了就红，fail-closed，不静默抓错段）。 */
const FORCED_FINAL_SECTION = Object.freeze({
  [CONTRACT_EN]: /^7\. \*\*post-stop verification\*\*/u,
  [CONTRACT_CN]: /^7\. \*\*停止后验证\*\*/u,
});
const FORCED_FINAL_SECTION_END = /^8\. /u;

/** 契约点名「三条不可续跑 reason」的那一句（名单在紧随其后的括号里）。 */
const FORCED_FINAL_THREE_CLAIM = Object.freeze({
  [CONTRACT_EN]: /the three non-continuable reasons\s*\(([^)]*)\)/u,
  [CONTRACT_CN]: /三条不可续跑的 reason\s*（([^）]*)）/u,
});

/** 「覆盖 ≠ 安全」那一句的起点（后面点名 guard 集合与两个 reason）。 */
const FORCED_FINAL_COVERAGE = Object.freeze({
  [CONTRACT_EN]: /Coverage is not safety/u,
  [CONTRACT_CN]: /覆盖\s*≠\s*安全/u,
});

/**
 * 判据面：中英**同一个 id**（一侧缺 ⇒ 「缺语义」+「中英背离」两条都报）。
 * 正则只认语义：`has to` / `必须` 一类同义改写仍绿，白名单口径必红（它缺下面这些腿）。
 */
const FORCED_FINAL_FACETS = Object.freeze([
  {
    id: "eligibility-is-state",
    why: "资格是**一个状态**，不是 reason 白名单（#475 把判据从原因枚举下沉到状态）",
    re: {
      [CONTRACT_EN]: /state,\s*not\s+a\s+whitelist\s+of\s+reasons/u,
      [CONTRACT_CN]: /一个状态、不是\s*reason\s*白名单/u,
    },
  },
  {
    id: "truncated-keeps-stricter-test",
    why: "那三条被预算/截断掐断的 reason 沿用更严的截断判据（不是「都要补发」）",
    re: {
      [CONTRACT_EN]: /keep\s+the\s+stricter\s+truncation\s+test/u,
      [CONTRACT_CN]: /沿用下面更严的截断判据/u,
    },
  },
  {
    id: "others-one-test-empty-body",
    why: "其余 reason 只过一个判据：整个 run 一个字都没写过",
    re: {
      [CONTRACT_EN]: /the\s+whole\s+run\s+wrote\s+not\s+a\s+single\s+character/u,
      [CONTRACT_CN]: /整个\s*run\s*一个字都没写过/u,
    },
  },
  {
    id: "new-reason-covered-by-construction",
    why: "新增 reason 天然被覆盖（不必再「记着回来贴一条」）",
    re: {
      [CONTRACT_EN]: /covered\s+by\s+construction/u,
      [CONTRACT_CN]: /天然被覆盖/u,
    },
  },
  {
    id: "coverage-is-not-safety",
    why: "覆盖 ≠ 安全：guard 覆盖了那两格，不等于那两格安全",
    re: {
      [CONTRACT_EN]: /Coverage\s+is\s+not\s+safety/u,
      [CONTRACT_CN]: /覆盖\s*≠\s*安全/u,
    },
  },
]);

/**
 * 「覆盖 ≠ 安全」那一句必须点名的东西：guard 集合常量 + 两个**真在集合里**的 reason
 * （成员关系由 `forcedFinalTruth()` 当场核——改源码成员集合而不改契约必红）。
 */
const FORCED_FINAL_COVERAGE_NAMES = Object.freeze([
  { id: "guard-set-constant", token: "FINAL_GUARD_TERMINATION_REASONS", why: "必须点名 guard 适用 reason 集合那个常量" },
  { id: "guard-set-end_turn", token: "end_turn", why: "必须点名 `end_turn`（它早就在 guard 集合里）" },
  { id: "guard-set-no_tool", token: "no_tool", why: "必须点名 `no_tool`（它早就在 guard 集合里）" },
]);

/** 压平/退回假话的形状：把资格写成白名单或固定条数枚举。 */
const FORCED_FINAL_ENUMERATION = Object.freeze([
  {
    why: "把资格写成「白名单 / 固定 reason 清单」——那正是 #475 之前那条假承诺的形状（新增 reason 会漏）",
    re: {
      [CONTRACT_EN]: /eligibility\s+is\s+(?:a\s+|an\s+)?(?:fixed\s+|static\s+)?(?:whitelist|reason\s+whitelist|list\s+of\s+reasons)/iu,
      [CONTRACT_CN]: /资格是(?:一份)?\s*(?:固定\s*)?reason\s*白名单/u,
    },
  },
  {
    why: "把资格写成固定条数（「只有六个 reason」）——条数是枚举的影子，源码一加 reason 就成假话",
    re: {
      [CONTRACT_EN]: /only\s+(?:the\s+)?(?:six|6)\s+(?:guard-eligible\s+)?reasons/iu,
      [CONTRACT_CN]: /只(?:有|对)\s*(?:那)?\s*(?:6|六)\s*个\s*(?:guard\s*适用\s*)?reason/u,
    },
  },
]);

/**
 * 从源码**代码面**里抽一个 `NAME = new Set([...])` 的成员（注释先涂空：注释里提到 reason 不算成员）。
 *
 * @param {string} code 涂过注释的源码
 * @param {string} name 集合常量名
 * @returns {string[]|null} 抽不到返回 `null`（调用方按 #164 口径报错，不猜）
 */
function reasonSetMembers(code, name) {
  const m = code.match(new RegExp(`${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`, "u"));
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/gu)].map((x) => x[1]);
}

/**
 * 真值：两个 reason 集合 + 「截断三条 ⊆ guard 集合」这条源码内不变量。
 *
 * 为什么还要最后那条不变量：契约 §7 的结构（「那三条沿用更严判据，发完之后 finalGuard 才可以
 * accept / skip / revise / 失败」）只有在截断三条**都在** guard 集合里时才成立；集合一旦分叉，
 * 契约那句话就变成假话，而两边看起来都「没改」。
 *
 * @returns {{truncated: string[], guardEligible: string[], errors: string[]}}
 */
function forcedFinalTruth() {
  const src = textOf(FORCED_FINAL_TRUTH_SRC);
  if (typeof src !== "string") {
    return {
      truncated: [], guardEligible: [],
      errors: [`forced-final/truth: 读不到 ${FORCED_FINAL_TRUTH_SRC}——强制收尾资格的真值无从抽起`
        + "（#164 口径：抽不到真值就报错）"],
    };
  }
  const code = maskJs(src, { keepStrings: true });
  const errors = [];
  const truncated = reasonSetMembers(code, FORCED_FINAL_TRUNCATED_SET);
  const guardEligible = reasonSetMembers(code, FORCED_FINAL_GUARD_SET);
  if (truncated === null || truncated.length === 0) {
    errors.push(`forced-final/truth: ${FORCED_FINAL_TRUTH_SRC} 的**代码面**里抽不到 \`${FORCED_FINAL_TRUNCATED_SET}\` 的成员`
      + "——「那三条沿用更严截断判据」这条真值无从对账（#164 口径：抽不到真值就报错）");
  }
  if (guardEligible === null || guardEligible.length === 0) {
    errors.push(`forced-final/truth: ${FORCED_FINAL_TRUTH_SRC} 的**代码面**里抽不到 \`${FORCED_FINAL_GUARD_SET}\` 的成员`
      + "——「覆盖 ≠ 安全」那句的真值无从对账（#164 口径：抽不到真值就报错）");
  }
  if (truncated !== null && guardEligible !== null) {
    const orphans = truncated.filter((reason) => !guardEligible.includes(reason));
    if (orphans.length) {
      errors.push(`forced-final/truth: \`${FORCED_FINAL_TRUNCATED_SET}\` 里的 ${orphans.join(" / ")} 不在 `
        + `\`${FORCED_FINAL_GUARD_SET}\` 里——契约 §7 说「那三条沿用更严判据、发完之后 finalGuard 才可以 accept / `
        + "skip / revise / 失败」，集合分叉之后那句话就是假话（两侧都要跟着改）");
    }
  }
  return { truncated: truncated ?? [], guardEligible: guardEligible ?? [], errors };
}

/**
 * 在一份契约的正文里定位 §7（post-stop verification / 停止后验证）那一段。
 *
 * @param {string} rel 文档相对路径
 * @param {string} src 文档正文（可以是 overlay 之后的文本）
 * @returns {{start:number,end:number,line:number,text:string}|null} 抽不到返回 `null`
 */
function forcedFinalWindowOf(rel, src) {
  const head = FORCED_FINAL_SECTION[rel];
  if (!head) return null;
  const text = String(src);
  const lines = text.split("\n");
  const from = lines.findIndex((line) => head.test(line));
  if (from === -1) return null;
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i += 1) {
    if (FORCED_FINAL_SECTION_END.test(lines[i])) { to = i; break; }
  }
  const start = lines.slice(0, from).join("\n").length + (from === 0 ? 0 : 1);
  const end = to >= lines.length ? text.length : lines.slice(0, to).join("\n").length + 1;
  return { start, end, line: from + 1, text: lines.slice(from, to).join("\n") };
}

/**
 * 本族的判据：真值（两个 reason 集合）× 两份契约 §7 那一段（逐条语义 + 名单成员对账 + 压平）。
 *
 * @returns {string[]} 错误文本（不直接写全局，好让 `--self-test` 复用同一份实现）
 */
function collectForcedFinalEligibilityErrors() {
  const errors = [];
  const notes = [];
  const truth = forcedFinalTruth();
  errors.push(...truth.errors);

  const present = new Map(FORCED_FINAL_FACETS.map((facet) => [facet.id, new Set()]));
  for (const doc of SUITE_INVENTORY_DOCS) {
    const src = textOf(doc);
    if (typeof src !== "string") {
      errors.push(`forced-final: 读不到 ${doc}——它是本族必须对账的两份契约之一，读不到就等于那份没人校`);
      continue;
    }
    const win = forcedFinalWindowOf(doc, src);
    if (win === null) {
      errors.push(`forced-final: ${doc} 里找不到 §7「post-stop verification / 停止后验证」那一段`
        + "（编号或标题被改）——本族的判据在这份文档上失效（#164 口径：抽不到真值就报错）");
      continue;
    }
    for (const facet of FORCED_FINAL_FACETS) {
      const re = facet.re[doc];
      if (re.test(win.text)) { present.get(facet.id).add(doc); continue; }
      errors.push(`forced-final: ${doc}:${win.line} 的 §7 缺一条语义——${facet.why}（判据 ${re}）`);
    }
    for (const bad of FORCED_FINAL_ENUMERATION) {
      if (!bad.re[doc].test(win.text)) continue;
      errors.push(`forced-final: ${doc}:${win.line} 的 §7 被压平/退回假话——${bad.why}`);
    }
    // 「覆盖 ≠ 安全」那一句：点名 guard 集合 + 两个真在集合里的 reason。
    const coverageAt = win.text.search(FORCED_FINAL_COVERAGE[doc]);
    if (coverageAt === -1) continue;   // 上面「覆盖 ≠ 安全」那条 facet 已经报过
    const coverage = win.text.slice(coverageAt);
    for (const item of FORCED_FINAL_COVERAGE_NAMES) {
      if (coverage.includes(item.token)) continue;
      errors.push(`forced-final: ${doc}:${win.line} 的 §7「覆盖 ≠ 安全」那句里没有点名 \`${item.token}\`——${item.why}`);
    }
    // ③ 固定 reason 名单 × 源码成员集合（双向）：契约点名的「三条」必须恰好是真值那一集。
    const claim = win.text.match(FORCED_FINAL_THREE_CLAIM[doc]);
    if (!claim) {
      errors.push(`forced-final: ${doc}:${win.line} 的 §7 里抽不到「三条不可续跑 reason」那句点名的名单`
        + "——资格口径的关键那一句被改写/删掉，本族的成员对账在这份文档上失效（#164 口径）");
      continue;
    }
    const named = [...new Set([...claim[1].matchAll(/`([^`]+)`/gu)].map((m) => m[1]))];
    if (named.length === 0) {
      errors.push(`forced-final: ${doc}:${win.line} 的 §7「三条不可续跑 reason」那句一个 reason 名都没点名`
        + "（括号里没有反引号名字）——按条数枚举不是合法写法（issue #677 补充范围）");
      continue;
    }
    for (const reason of named.filter((r) => !truth.truncated.includes(r))) {
      errors.push(`forced-final: ${doc}:${win.line} 的 §7 点名了 \`${reason}\` 属于「不可续跑三条」，`
        + `但 ${FORCED_FINAL_TRUTH_SRC} 的 \`${FORCED_FINAL_TRUNCATED_SET}\` 里没有它（真值：`
        + `${truth.truncated.map((r) => `\`${r}\``).join(" / ") || "抽不到"}）`);
    }
    for (const reason of truth.truncated.filter((r) => !named.includes(r))) {
      errors.push(`forced-final: ${doc}:${win.line} 的 §7 漏掉了 \`${reason}\`——它在 `
        + `${FORCED_FINAL_TRUTH_SRC} 的 \`${FORCED_FINAL_TRUNCATED_SET}\` 里（改源码成员集合而不改契约 = 契约在撒谎）`);
    }
    for (const item of FORCED_FINAL_COVERAGE_NAMES.filter((x) => x.token !== "FINAL_GUARD_TERMINATION_REASONS")) {
      if (!coverage.includes(item.token)) continue;
      if (truth.guardEligible.includes(item.token)) continue;
      errors.push(`forced-final: ${doc}:${win.line} 的 §7 说 \`${item.token}\` 早就在 \`${FORCED_FINAL_GUARD_SET}\` 里，`
        + `但 ${FORCED_FINAL_TRUTH_SRC} 的那个集合里没有它（改源码成员集合而不改契约 = 契约在撒谎）`);
    }
  }

  // 中英背离：一条 facet 只有一侧写了 ⇒ 另一侧读者拿到的是一半的答案（「只改一边不算改」）。
  for (const facet of FORCED_FINAL_FACETS) {
    const hit = present.get(facet.id);
    if (hit.size === 0 || hit.size === SUITE_INVENTORY_DOCS.length) continue;
    const missing = SUITE_INVENTORY_DOCS.filter((doc) => !hit.has(doc));
    errors.push(`forced-final: 中英背离——「${facet.why}」只有 ${[...hit].join("、")} 写了，`
      + `${missing.join("、")} 没有（issue #677 补充范围：一侧真一侧假也必须红）`);
  }

  notes.push(`forced-final: 契约 §7「post-stop verification / 停止后验证」（issue #475 / #677）按 `
    + `${FORCED_FINAL_FACETS.length} 条语义 × 中英两侧逐条对账，外加「覆盖 ≠ 安全」点名 `
    + `${FORCED_FINAL_COVERAGE_NAMES.length} 个名字、固定名单 × 源码成员集合双向对账、压平/条数枚举另判 `
    + `${FORCED_FINAL_ENUMERATION.length} 种形状；真值 ${FORCED_FINAL_TRUTH_SRC}：`
    + `\`${FORCED_FINAL_TRUNCATED_SET}\` = ${truth.truncated.map((r) => `\`${r}\``).join(" / ") || "（抽不到）"}；`
    + `\`${FORCED_FINAL_GUARD_SET}\` 含 ${truth.guardEligible.length} 个 reason`);
  collectForcedFinalEligibilityErrors.notes = notes;
  return errors;
}

// ── 3. README 引用的 package.json 清单（files / exports）────────────────────────
// issue #210 的**主修项**：这块原先是 fail-open 的——围栏定位靠真值键（`b["./tools"]`、
// `b.includes("src")`），文档把 `"./tools"` 改名或整个删掉时块就找不到了，于是退化成一条 warn
// （默认 exit 0，实测复现见 CHANGELOG #210 条目）。现在：
//   ① 块按**结构**定位（≥3 项字符串数组 = `files` 候选；键全为子路径 = `exports` 候选）；
//   ② 候选数 ≠ 1 直接 error（不再 warn：清单围栏找不到或找不准就是检查面失效，#164 口径）；
//   ③ 比对走 `assertSymmetric` 的双向对称——缺键/多键/改名/写重都红，并点名具体键；
//   ④ `JSON.parse` 会静默丢掉重复键（保留最后一个），所以再按围栏原文数一遍顶层键名。
function fencedJsonBlocks(rel) {
  const blocks = [];
  let current = null;
  for (const line of textOf(rel).split("\n")) {
    if (line.trim() === "```json") {
      current = [];
      continue;
    }
    if (current && line.trim() === "```") {
      blocks.push(current.join("\n"));
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  return blocks;
}

/** 围栏原文里的顶层键名（`JSON.parse` 吞掉的重复键在这里现形）。 */
function topLevelKeys(raw) {
  return [...raw.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);
}

function checkPkgBlocks() {
  const out = [];
  const outWarn = [];
  // issue #213：`exports` 的每个子路径是条件对象（`{types, default}`），所以按**结构化**比较
  const canonical = (v) => JSON.stringify(v, (_k, val) =>
    (val && typeof val === "object" && !Array.isArray(val))
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val);
  for (const rel of [README_EN, README_CN]) {
    const pkg = pkgNow();
    const raws = fencedJsonBlocks(rel);
    const parsed = raws.map((b) => { try { return JSON.parse(b); } catch { return undefined; } });
    const cands = raws.map((raw, i) => ({ raw, value: parsed[i] }));

    const filesCands = cands.filter(({ value }) => Array.isArray(value)
      && value.length >= 3 && value.every((x) => typeof x === "string"));
    if (filesCands.length !== 1) {
      out.push(filesCands.length === 0
        ? `pkg-block: ${rel} 找不到 \`files\` 清单围栏（≥3 项字符串数组），无法与 package.json 比对——检查面失效就是漂移`
        : `pkg-block: ${rel} 有 ${filesCands.length} 个 \`files\` 候选围栏，无法唯一定位（把多余的 JSON 围栏改掉或删掉）`);
    } else if (!assertSymmetric(out, {
      rule: "pkg-block", where: `${rel} 的 \`files\` 围栏`, truth: pkg.files, doc: filesCands[0].value,
      kind: "条目",
    })) {
      // 报错已由 assertSymmetric 落（缺/多/写重都点名到具体条目），这里不重复
    } else {
      note(`pkg-block: ${rel} files 清单与 package.json 双向对称（${pkg.files.length} 项）`);
    }

    const exportsCands = cands.filter(({ value }) => value && !Array.isArray(value)
      && Object.keys(value).length > 0 && Object.keys(value).every((k) => k === "." || k.startsWith("./")));
    if (exportsCands.length !== 1) {
      out.push(exportsCands.length === 0
        ? `pkg-block: ${rel} 找不到 \`exports\` 清单围栏（键全为子路径的 JSON 对象），无法与 package.json 比对——检查面失效就是漂移`
        : `pkg-block: ${rel} 有 ${exportsCands.length} 个 \`exports\` 候选围栏，无法唯一定位`);
      continue;
    }
    const block = exportsCands[0];
    // ① 键集合双向对称：缺键 / 多键 / 改名都红，点名到具体键（#210 追加评论要的正是这条）
    const keysOk = assertSymmetric(out, {
      rule: "pkg-block", where: `${rel} 的 \`exports\` 围栏键集合`,
      truth: Object.keys(pkg.exports), doc: Object.keys(block.value), kind: "子路径键",
    });
    // ② 重复键：JSON.parse 只保留最后一个，所以从原文数
    const rawKeys = topLevelKeys(block.raw);
    const dupKeys = rawKeys.filter((k, i) => rawKeys.indexOf(k) !== i);
    if (dupKeys.length) {
      out.push(`pkg-block: ${rel} 的 \`exports\` 围栏里子路径键 ${[...new Set(dupKeys)].map((k) => JSON.stringify(k)).join("、")} 写了不止一次（JSON.parse 会静默保留最后一个，文档读者看到的却是第一个）`);
    }
    // ③ 共有键的**值**也要逐键一致；点名是哪一个键、错在哪一侧
    for (const k of Object.keys(pkg.exports)) {
      if (!Object.hasOwn(block.value, k)) continue;
      if (canonical(block.value[k]) === canonical(pkg.exports[k])) continue;
      out.push(`pkg-block: ${rel} 的 \`exports\` 里键 ${JSON.stringify(k)} 的值与 package.json 不一致：`
        + `文档 ${JSON.stringify(block.value[k])} vs package.json ${JSON.stringify(pkg.exports[k])}`);
    }
    if (keysOk) note(`pkg-block: ${rel} exports 清单与 package.json 双向对称（${Object.keys(pkg.exports).length} 个子路径键 + 逐键值）`);
  }

  // 随包发布的契约套件必须真的在 files 白名单里（否则宿主 import 'erix-agent/contract-tests' 会炸）。
  const contractIndex = read("test/contract/index.js");
  for (const m of contractIndex.matchAll(/from "\.\/([\w.-]+\.js)"/g)) {
    const rel = `test/contract/${m[1]}`;
    if (!pkgNow().files.includes(rel)) {
      outWarn.push(`pkg-block: ${rel} 被 test/contract/index.js（npm 入口 ./contract-tests）再导出，但不在 package.json 的 files 白名单里 → 发布包内该套件会缺失`);
    }
  }
  return { errors: out, warnings: outWarn };
}

// ── 4. 模块地图完整性 ─────────────────────────────────────────────────────────
function walk(rel, acc = []) {
  for (const name of readdirSync(path.join(ROOT, rel))) {
    const childRel = `${rel}/${name}`;
    if (statSync(path.join(ROOT, childRel)).isDirectory()) walk(childRel, acc);
    else acc.push(childRel);
  }
  return acc;
}

const srcFiles = walk("src").filter((f) => f.endsWith(".js"));
for (const rel of [README_EN, README_CN]) {
  const mapBlock = read(rel)
    .split(/^```text$/m)
    .find((chunk) => chunk.includes("orchestrator.js") && chunk.includes("index.js"));
  if (!mapBlock) {
    err(`modulemap: ${rel} 找不到模块地图围栏（text 围栏块），检查面失效`);
    continue;
  }
  const counts = new Map();
  for (const m of mapBlock.matchAll(/([\w.-]+\.js)/g)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const missing = [];
  for (const f of srcFiles) {
    const base = path.basename(f);
    const needed = srcFiles.filter((x) => path.basename(x) === base).length;
    if ((counts.get(base) ?? 0) < needed) {
      counts.set(base, needed); // 同一缺失名只报一次
      missing.push(f);
    }
  }
  if (missing.length) {
    err(`modulemap: ${rel} 的模块地图缺少 ${missing.join(", ")}`);
  } else {
    note(`modulemap: ${rel} 覆盖 src/ 全部 ${srcFiles.length} 个文件`);
  }
}

// ── 5. 文档引用的路径与命令（覆盖面 + 三级解析 + 四类裁决，issue #273）──────────
// 修前两处都窄：
//   · 覆盖面：同一条不存在的仓内路径写进 README.md 会 exit 1，写进 examples/pi-extension/README.md
//     却 exit 0。
//   · 判据：只有「仓库根下存在吗」一级。examples 版 README 里 `erix-run.ts`（同目录文件）、
//     `../../test/examples/plain-data.js`（相对路径）、`erix-run-core.test.js`（裸文件名）这类
//     **真引用**一律解析不到，于是真引用与死引用在它眼里没区别。
/** paths 的覆盖面（#273）：使用者与宿主会照着找文件的那批入口文档。
 *  工单 261021-03 B1 把架构 / 图表 / 需求对照的中英各一份也纳进来（原本只有 README×2 + AGENTS×2 +
 *  契约×2 + pi 扩展 README）——这三对是「会被人当成现状读」的活文档，死引用漂了不会红的代价比
 *  入口文档只高不低。 */
const PATH_DOCS = [README_EN, README_CN, PI_EXT_README, CONTRACT_EN, CONTRACT_CN, AGENTS_EN, AGENTS_CN,
  ARCH_EN, ARCH_CN, CHARTS_EN, CHARTS_CN, REQ_EN, REQ_CN,
  // issue #644 ③：账本既然在锚点面内（`SYMBOL_DOCS_STATIC`），它的普通路径引用也该校——
  // 一份「符号锚点要被校验」的文档，没有理由让它的路径引用免检。
  LEDGER_EN, LEDGER_CN];

// 引用裁决分类（四类，**没一类能整目录/整前缀豁免**；每条白名单必须写理由）。
// 白名单条目还会被反向校：没人引用、或分类与 .gitignore 不再自洽 → 红，所以条目不会烂在那里。
/** ① 本仓曾有这个路径（或只是运行期产物名），文档在讲「已退役/迁移/宿主侧证据」。 */
const EXPECTED_ABSENT_PATHS = new Map([
  ["skills/notes/skill.mjs", "v0.11.0 已退役的兼容 shim，README 在讲「已删除」"],
  ["src/loop.js", "v0.14.0 已删除的转发 shim，README 在讲迁移"],
  ["judge.log", "引擎写入 transcripts/outputs/<runId>/ 的运行产物名，不是仓库文件"],
  ["erix-state/judge.log", "2026-09 基准证据里的宿主侧路径，不在本仓库"],
  ["status.json", "erix_run 在宿主 sessionDir 下写的 job 状态文件名，不是仓库文件"],
  ["report.md", "#391：`--require-deliverable report.md` / `deliverablePaths: [\"report.md\"]` 举的示例交付物名——它是宿主自己树里才有的文件（本仓当然没有），文档在讲「怎么声明一条命名判据」"],
  ["analysis.md", "#269 复盘：这条引用本身就是「不存在的文件」，CHANGELOG:102 在讲它为什么不存在（#278 把它纳进裸名裁决后必须登记）"],
  ["session-meta.json", "宿主 `~/.erix/session-meta.json`（#168 停读停写的会话归属状态文件），CHANGELOG:158 讲的是宿主侧行为"],
  ["models.json", "宿主 `~/.pi/agent/models.json`（provider 槽位配置），CHANGELOG:200-201 的 e2e 根因在宿主配置里"],
  ["recall.js", "CLI recall 工具的文件名（f26ea47 已移除，CHANGELOG:889 记的就是移除）"],
  ["nonce.json", "复验脚本临时写的 nonce 文件名（docs/research/2026-09-13-notes-why.md:1468 的 CLI 复验口径），不是仓库文件"],
  ["2026-10-09-architecture-review.md", "运行时输出文件名（任务单写的日期），落地到仓库时改名成 docs/design/2026-10-08-architecture-review.md，所以这个名字本仓不存在"],
  ["transcript.json", "erix run 写进宿主输出目录的 transcript 文件名（host-upgrade-guide-v030 中英 :94/:99 讲的是宿主怎么读它），不是仓库文件"],
  ["checkpoint-executor.js", "0.x 时代的 `src/loop/checkpoint-executor.js`（ADR-015 之后已拆掉），docs/design/2026-09-17:25 写当时落点时引的；文档在讲历史，所以登记"],
  ["console.log", "CHANGELOG:22 写的是 JS 调用形式 `console.log(...)`，不是文件路径——它被 .gitignore 的 `*.log` 顺手接住了，所以必须在这里写清它不是路径，而不是假装不存在"],
  // —— 以下是工单 261021-03 B1 把架构中英两份纳进 `paths` 覆盖面后暴露的两处：文档就在校「这个文件不存在」——
  //   它们是「预期的不在场」（与上面 `src/loop.js` 同档），不是死链，也不是外仓路径（前缀法不适用于它们）。
  ["src/providers/index.js", "架构中英（docs/architecture{,_cn}.md）在讲「当前目录树**特意不包含** providers 的 index，也不导出通用的 `createProvider` 工厂」——文档主旨就是这个路径不存在"],
  ["src/skills/index.js", "同上：`src/skills/` 只发 `loader.js`，没有 `src/skills/index.js`、也没有 `./skills` 子路径导出（中英同一句）"],
]);
/** ② 引用的是**另一个仓库/宿主安装物/文档里举的示意名**（写清归属或凭什么不是路径）。 */
const EXTERNAL_REPO_PATHS = new Map([
  ["src/shared/parent-wake.js", "上游 pi-subagents 仓内的路径（#269 逐分支对照的证据行号就在那个子模块里），本仓没有同名文件"],
  // （工单 261021-03 B1：这里原本还有一条 `src/runs/background/async-execution.js`——它是被
  //  `examples/pi-extension/README.md` 那一处引用养着的，现在那一处已改写成
  //  `pi-subagents:src/runs/background/async-execution.js:4`，逐路径登记已被**前缀登记**取代，反向校（条目空转）
  //  就把它带红了。`docs/research/2026-10-13-*` 与 CHANGELOG 里的写法不改：那是快照档案与历史条目。）
  ["dist/core/extensions/virtual-modules.js", "上游 pi 发行包的编译产物（#246 写 host-consumer-contract 时读的就是它）"],
  ["dist/core/extensions/loader.js", "上游 pi 发行包的编译产物（同上）"],
  ["docs/extensions.md", "pi 自己的官方文档（本仓不镜像）"],
  ["examples/extensions/shutdown-command.ts", "pi 仓的扩展示例（本仓不镜像）"],
  ["herdr-pi-bridge.js", "宿主侧桥接脚本（#247 写对照时引用的宿主文件）"],
  ["sync-erix-mirror.sh", "宿主侧 cron 脚本（AGENTS 「上游同步」一节讲的是宿主仓库，不在本仓）"],
  ["./x.js", "AGENTS 讲 `// @ts-check` 与 `.d.ts` 解析规则时举的**示意文件名**（中英同一处），不是仓库路径"],
  ["x.d.ts", "AGENTS 讲 `.d.ts` 伴生声明时举的**示意文件名**（与 `./x.js` 同处），不是仓库路径"],
  // —— 以下是 #278 把「无斜杠裸名」纳进裁决面后暴露的上游/宿主裸名引用（逐条写归属）——
  ["parent-wake.js", "上游 pi-subagents 的 `src/shared/parent-wake.js`（CHANGELOG:105 与 docs/research/2026-10-13:121 都用裸名指它）；本层同名物是 `erix-run-parent-wake.js`"],
  ["async-execution.js", "上游 pi-subagents 的 `src/runs/background/async-execution.js`（docs/research/2026-10-13:119 用裸名引它的 `spawn` 行）"],
  ["debug.routes.js", "宿主 touwaka 仓的 Express 路由文件（docs/research/2026-09-26:118 的人工对质源码结论）"],
  ["expert.routes.js", "宿主 touwaka 仓的 Express 路由文件（同上，同一行第二条结论）"],
  ["init-database.js", "宿主 touwaka 仓的建表脚本（docs/host-upgrade-guide-0.17.0.md:193 与 CHANGELOG:260 的迁移对照）"],
  ["upgrade-database.js", "宿主 touwaka 仓的迁移脚本（docs/host-upgrade-guide-0.17.0.md:194 与 CHANGELOG:260）"],
  ["llm-context-budget.md", "宿主 touwaka 仓里的设计档案（docs/requirements 中英 :12 引它 §7「not changed this cycle」），本仓不镜像"],
  ["skill.mjs", "技能目录的**约定入口名**（ADR-008 / docs/decisions/014 / harness-comparison 中英讲的是约定，不是某个具体文件）；本仓实物是 examples/skills/getTime/skill.mjs 与 examples/skills/todo/skill.mjs 两个，拿裸名指它俩属于约定名不是路径"],
]);
/** ②′ 外部仓引用的**前缀标记法**（工单 261021-03 B1）。
 *
 * 病根：覆盖面从 24 抬到 31 之后，架构 / 需求对照 / pi 扩展 README 里那批「引用别的仓库的路径」
 * 全暴露在红灯里（`lib/agent/`、`lib/context-organizer/`、`src/runs/background/async-execution.js:4`…）。
 * 用 `EXTERNAL_REPO_PATHS` 逐条登记能过，但它按**路径**开条目：外仓每多一个被引路径就得多一条白名单，
 * 而白名单条目本身会腐朽（#273/#278 已经为这个形状写过三条反向证）。前缀标记法把归属写在**引用本身**上：
 *   `touwaka:lib/agent/`、`pi-subagents:src/runs/background/async-execution.js:4`
 * 冒号前是**已知外部仓名**（下表逐仓点名 + 写归属），冒号后是那个仓里的路径。于是
 *   ① 不查本仓存在性（那本来就不是本仓文件），
 *   ② **不计入裸行号棘轮**（`BARE_LINE_REF_BASELINE` 数的是本仓可核对的裸行号；一条外仓引用不该把
 *      只减不增的基线顶上去，也不该为了让它不顶而删掉真证据）；
 *   ③ 前缀**不在**已知清单里 ⇒ 红 —— 这条是全部放宽的代价：否则「随手编个前缀」就成了死链的免检通道。
 * 已知清单还会被**反向校**（没有任何一处引用用到这个仓名 ⇒ 红，与四张白名单登记表同口径），条目不会烂在那儿。
 * 一句话口径（AGENTS 中英「文档真值」一节同写）：**引用别的仓库的文件时写 `<仓名>:<该仓路径>`，
 * 仓名必须是 `EXTERNAL_REPO_PREFIXES` 里登记过的那几个；不带前缀就是本仓路径，必须解得到。** */
const EXTERNAL_REPO_PREFIXES = new Map([
  ["touwaka", "宿主 touwaka 仓：`docs/requirements{,_cn}.md` §1 的消费方画像写的就是它的代码位置（`lib/agent/`、`lib/context-organizer/`）"],
  ["app_container", "宿主 app_container 仓：同上 §1 的另一个消费方（`apps/worker/src/pi/` + `packages/context`）。该仓已与 erix-station 合并进后继项目 fde-workshop，旧检出仍在盘上、仍带活引用，所以这些路径今天仍可读；裸行号一侧的外仓根就地声明见 `BARE_LINE_EXEMPTIONS` 的 `apps/worker/` 两条"],
  ["pi-subagents", "上游 pi-subagents 仓：`examples/pi-extension/README.md` §6 与 `docs/research/2026-10-13-*` 的对照证据行号都在那个子模块里（本仓没有 `src/runs/`）"],
]);
/** 前缀形状：`<小写仓名>:<路径>`。**排除** `://`（URL / 自定义 scheme，`push()` 早已整段跳过，这里再兜一道）、
 *  排除冒号后紧跟空白或斜杠（`done: true`、`file://` 这类不是路径）。名字干限小写字母数字与 `-` `_`，
 *  长度 ≥ 2 —— 拿实测语料校过：全仓 110 份已跟踪 Markdown 里形如 `<词>:` 又被当成路径的 token 一个都没有，
 *  所以这条判据不会把既有写法误判成前缀（`--self-test` 的对照组也证明了这点）。 */
const EXT_REPO_PREFIX_RE = /^([a-z][a-z0-9_-]{1,30}):(?!\/|\\|\s)(\S.*)$/;
/** 取一处引用带的外部仓名；没带前缀返 null。 */
function externalRepoPrefixOf(p) { return p.match(EXT_REPO_PREFIX_RE)?.[1] ?? null; }
/** 前缀裁决（纯函数，反向证直接拿它问）：带前缀 ⇒ 已知仓放行 / 未知仓点名；不带前缀 ⇒ 交回常规四类裁决。 */
function externalRepoPrefixVerdict(p) {
  const repo = externalRepoPrefixOf(p);
  if (repo === null) return null;
  if (EXTERNAL_REPO_PREFIXES.has(repo)) return { ok: true, repo };
  return {
    ok: false,
    repo,
    why: `带的是外部仓前缀 \`${repo}:\`，但 "${repo}" 不在 EXTERNAL_REPO_PREFIXES 已知清单里（已知：`
      + [...EXTERNAL_REPO_PREFIXES.keys()].join(" / ") + `）——前缀不是「不存在的免检通道」：它确实是清单外的仓，`
      + `就去表里登记并写归属；它是本仓路径，就**删掉前缀**并改成真的本仓路径（漏写前缀与编造前缀同样红）`,
  };
}
/** 已知仓名的**使用情况**：扫覆盖面（点名文档 + 实扫指南）里全部带前缀的引用，供反向校「条目空转」。
 *  行号在 `extractRefOccurrences` 里已被剥掉，所以带不带 `:N` 的引用都会算进来（不依赖两处判据的执行顺序）。 */
function externalRepoPrefixCensus() {
  const used = new Set();
  for (const rel of new Set([...PATH_DOCS, ...refScanDocs()])) {
    const rec = fileRecord(rel);
    if (!rec) continue;
    for (const { p } of extractRefOccurrences(rec.text).refs) {
      const repo = externalRepoPrefixOf(p);
      if (repo) used.add(repo);
    }
  }
  return used;
}

/** ③ 生成物：由命令产出、被 .gitignore 忽略，仓库里没有是预期的。**模式**级条目（一文件一条会造出
 *  63 条同义自述），但每条都带 why 并与 .gitignore 互校：匹配了模式却不被忽略 → 红。 */
const GENERATED_ARTIFACT_REFS = [
  { re: /^(?:\.\.?\/)?src\/[\w./-]*\.d\.ts$/, why: "`npm run types:build` / `prepack` 生成的公共面声明产物（.gitignore 的 `src/**/*.d.ts`）；仓库不提交是 #213 的既定选择" },
  { re: /^(?:\.\.?\/)?package-lock\.json$/, why: "本仓历史上没有 lockfile，加它属于另一个决定（.gitignore 里写了 issue #213）" },
];
/** ⑤ 文档里的**简称/歧义名**：作者用短名指本仓某个真实存在的文件（`format.js` 指 `erix-run-format.js`、
 *  `notes.js` 在 CHANGELOG 里指 `src/store/notes.js`）。与 ①②③④ 的区别是它既不是路径也不是外物，
 *  而是「同一实物的另一个名字」（或本仓多个同名文件里的某一个），所以每条必须给出实物，并被**双向校**：
 *  简称没被任何引用用到 → 红；实物现在解不到了（改名/删了）→ 红。 */
const SHORTHAND_REFS = new Map([
  ["format.js", { real: ["examples/pi-extension/erix-run-format.js"], why: "CHANGELOG:92-93 讲 #276 死分支时对 `erix-run-format.js` 的简称（历史条目不改写，故登记简称↔实物对应关系）" }],
  ["core.js", { real: ["examples/pi-extension/erix-run-core.js"], why: "CHANGELOG:146 讲 #234 异步面时对 `erix-run-core.js` 的简称（同上）" }],
  ["notes.js", { real: ["src/store/notes.js", "src/tools/notes.js"], why: "CHANGELOG:42 讲 #270 公共闭包计数时的简称；本仓确实有两个 `notes.js`，拿裸名指它俩的全体（歧义必须写清，历史条目不改写故登记）" }],
  ["anthropic.js", { real: ["src/providers/anthropic.js"], why: "CHANGELOG:180 与 docs/design/2026-10-08:28 讲类型错误分布时对 `src/providers/anthropic.js` 的简称（同段的 `src/messages/anthropic.js` 是另一个同名文件，裸名指前者）" }],
]);
/** 被忽略的**目录规则**必须逐条分类（#273：不许默认当没事）。语义分两类：
 *   · install-tree / build-output / runtime / worktree / scratch：目录内容根本不是仓库内容（安装位置、构建产物、
 *     运行日志、本机工作副本、丢弃型临时工作目录），引用它们不构成「克隆后死链」；
 *   · task-archive：`docs/tasks/` 存的是主 agent 的写作现场，**看起来像**仓内文档却整目录不入库，
 *     克隆后就是死引用——所以只有这一类要求**逐条**证据（就地声明或 LOCAL_ARCHIVE_REFS 逐条理由），
 *     其余类别按目录规则整体放行，但都必须在表里写明为什么。
 * 哪些类别**整目录不进扫描面**由 `SKIPPED_DIR_KINDS` 显式点名（#337：`.scratch/` 里的文件曾按文件系统
 * 扫进来，被当成仓内实物参与「唯一同名」解析与近邻判据）；没进那张清单的类别照常下钻。
 * .gitignore 里出现新的目录型规则而未登记 → 直接红（而不是默默放行）。
 * 反向也守（#302）：登记了类别、而 `.gitignore` 里根本没有那条规则 = 空转条目，同样红
 * （`test/static-guards.test.js` 的「目录规则双向一致」那一节）。因此这张表**不是**「可能会被忽略的目录清单」，
 * 而是「`.gitignore` 里那几条目录规则的分类」——所以 `dist/` 那条 `build-output` 在 #302 里被删了：
 * 本仓从来没有过 `dist/` 规则（建表至今 `git log -S'dist/' -- .gitignore` 为空），examples 也不往那儿构建，
 * 它是一条从落地那天起就永不生效的空转条目。哪天真的加了一条 `dist/` 规则，正向校会提醒在这里登记。 */
const IGNORED_DIR_CLASSES = new Map([
  ["node_modules/", { kind: "install-tree", why: "宿主侧安装位置，不是仓库内容" }],
  ["logs/", { kind: "runtime", why: "运行日志目录" }],
  [".worktrees/", { kind: "worktree", why: "并行任务的本机工作副本（#184 引入）" }],
  [".scratch/", { kind: "scratch", why: "丢弃型临时工作目录（复现脚本、`git archive` 对照树等一次性产物，#337）：内容不是仓库内容，整目录不进扫描面" }],
  ["docs/tasks/", { kind: "task-archive", why: "主 agent 的任务工作目录：整目录不入库，#162 定了口径，#273 把它纳进检查面" }],
  ["docs/delivery/", { kind: "task-archive", why: "交付报告的本机落点：与 docs/tasks/ 同口径不入库（2026-10-15 实测：新增 ignore 目录规则若不在这里登记类别，--self-test 会从 3 条红抬到 6 条）" }],
]);

/** 整目录**不进扫描面**的类别（显式清单，issue #337）。方向是「列出来的才跳过」，不是「除了某类都跳过」：
 *  将来新增一个类别时默认**照常下钻**（宁可多扫、让问题暴露），要跳过必须在这里点名并写明为什么；
 *  反向写法会让新类别静默漏扫——正是本文件反复踩的那类溃败。
 *   · install-tree / worktree：里面是一整份别的仓库，钻进去又慢又脏；
 *   · scratch：丢弃型临时工作目录（复现脚本、对照树），内容不是仓库内容，也不该参与实物解析。 */
const SKIPPED_DIR_KINDS = new Set(["install-tree", "worktree", "scratch"]);

/** ④ 本机档案：指向被 .gitignore 忽略的**目录**（本仓只有 `docs/tasks/`：主 agent 的任务工作目录）。
 *  首选判据是「就地声明」：引用所在行或紧邻上一行写了「本机/本地/不入库/未入库/未跟踪/gitignore/忽略/归档」
 *  之类的话 → 算已声明（docs/research/2026-09-26-* 的「任务文档（本地，不入库）」就是这种写法，
 *  #162 那轮已经定了这个口径）。声明不了的（禁改面与 CHANGELOG 历史条目）逐条登记 + 理由。 */
const LOCAL_ARCHIVE_REFS = new Map([
  ["e2e-wake.mjs", "examples/pi-extension/README.md 写「归档在 docs/tasks/active/261010-13-erix-run-async/」时同句举的本机脚本名（禁改面，且同句只说了「归档」）"],
  ["docs/tasks/active/261010-13-erix-run-async/repro-circular-details.mjs", "CHANGELOG:169（#234 条目）把复现脚本指向任务档案；历史条目不改写，逐条登记"],
  ["repro-circular-details.mjs", "CHANGELOG:89 与 docs/research/2026-10-13-pi-subagents-async-attribution.md:25 同句举的**裸名**复现脚本，实物在 docs/tasks/active/261010-13-erix-run-async/（#273 把 archive 类的三级解析接上后新暴露的两处引用；本轮禁改 docs/** 也不改 CHANGELOG 历史条目，故逐条登记）"],
  ["docs/tasks/active/task-20260830-touwaka-full-integration/BRANCH.md", "docs/harness-comparison/05:62 的 git 注入对照引用的是本机档案行号（#273 点名的两条历史样本之一；另一条 docs/research/2026-09-26 的 REPORT.md 已就地写「本地，不入库」而直接放行）。本轮禁改 docs/**，下轮在那行补上「本机档案、不入库」后请删本条"],
]);
const LOCAL_ARCHIVE_DECLARATION = /本机|本地|不入库|未入库|不提交|未提交|未跟踪|never committed|not committed|untracked|gitignore|忽略|归档/i;

/* ────────────────────────────────────────────────────────────────────────────────
 * #278：无斜杠的**裸文件名**引用（`repro-circular-details.mjs`、`e2e-wake.mjs`）
 * 修前：这类引用只有在「拼写恰好对 + 已在 LOCAL_ARCHIVE_REFS 登记」的那一瞬间才被看守——
 *   改坏拼写 → 脱离登记表 → 通用提取不认无斜杠名 → 静默放行（#273 那个「整目录豁免」换了个形式）。
 *   主 agent 的三个探针：删登记 → exit 1；改坏**已登记**裸名 → exit 0；改坏**未登记**裸名 → exit 0。
 *
 * 量与分类（在 HEAD ca6ed55 上实测，脚本 `--bare-census` 可复现；后人不要只信注释）：
 *   全仓已跟踪 .md 里「无斜杠 + 带扩展名 + 解不到 + 未登记未声明」的裸名引用共 **105 处 / 58 个唯一名**，其中
 *     · 跳仓引用（正文在讲另一个仓库/宿主安装物，如 MEMORY.md / output-accumulator.js / init-database.js）： **79 处**，全部落在下面 CROSS_REPO_DOCS 那 10 份文档里；
 *     · 本仓档案/历史简称/运行期产物名（analysis.md / format.js / session-meta.json / e2e-wake.mjs 这类）： **26 处**，落在 CHANGELOG 与 docs/{research,design} 里。
 *   所以裁决面按**文档**切：CROSS_REPO_DOCS 里的裸名不裁决（那本不是本仓路径，逐名登记 79 次只会造出 40 条会腐朽的白名单）；
 *   其余文档（PATH_DOCS + 本仓 research/design + 根 CHANGELOG）的裸名全部走同一套四类裁决。
 *   CROSS_REPO_DOCS 是**逐份点名**（无目录通配）+ 一句理由 + 反向校（不再有任何引用用到它 → 红）；条目数超 12 需上报。
 * ──────────────────────────────────────────────────────────────────────────────── */

/** 「像个文件」闸（裸名专用）：无斜杠 + 名字干以字母数字开头且 ≥ 4 字符 + 扩展名在已知集合里。
 *  拦掉的全是**不是引用**的东西：`.js` / `.d.ts`（扩展名残片，名字干为空或以 `.` 开头）、
 *  `_cn.md`（文件名后缀片段）、`gen.sh`（3 字干，太短，拿它当实物近邻只会假红）、
 *  `details`（无扩展名）、`scratch/`（带斜杠，走目录规则）。宁可少拦，不可把真引用挡在门外。 */
const BARE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.(?:js|mjs|cjs|ts|mts|tsx|json|md|sh|log|txt|ya?ml|py|zip|lock|diff)$/;
const BARE_STEM_MIN = 4;   // 「像个文件」闸的名字干最短长度
/** 近邻判据另开一个更高的门槛：**名字干 ≥ 8 字符才启用**。`index.js` / `skill.mjs` / `judge.log`
 *  这类 5 字干的词是「约定入口名 / 常见词」，它们跟本仓任何同字干的实物都能配一对，
 *  拿它们当「被改坏的实物名」必然假红；而真实的改名事故（`repro-circular-details` 20 字、
 *  `e2e-wake` 8 字）名字干都够长。这条常数写死，不做可调的模糊阈值。 */
const NEAR_STEM_MIN = 8;

/** 近邻判据（只抓「把本仓实物的名字改坏了一个尾巴」这一形状，不调模糊阈值）：
 *  去扩展名后的 basename 与本仓某实物（**含被 .gitignore 忽略的实物**，如 docs/tasks/ 下的实测件）的
 *  同名干满足以下之一——全仓生效（包括跳仓文档）：
 *    ① 完全相等（换了扩展名，如 `e2e-wake.mjs` → `e2e-wake.md`）；
 *    ② 互为前缀且长出来的那段 ≤ 3 个字符（`repro-circular-details` → `...X` / `...-v2` 这种改名）。
 *  **区分大小写**：`MEMORY.md` ↔ `src/store/memory.js` 不是改名，拿大小写折叠去比会把
 *  harness-comparison 里的跳仓名全部误红（实测 20 处假红）。 */
function bareNameNearest(p, ign) {
  const stemOf = (x) => path.posix.basename(x).replace(/\.[^.]+$/, "");
  const c = stemOf(p);
  if (c.length < NEAR_STEM_MIN) return [];
  const { tracked, ignored } = repoFiles(ign);
  const base = path.posix.basename(p);
  const out = [];
  for (const f of [...tracked, ...ignored]) {
    const s = stemOf(f);
    if (s.length < NEAR_STEM_MIN) continue;
    //  basename 一字不差地存在 → 那是「同名歧义」而不是「改坏了名字」，走歧义那条报，不算近邻。
    if (path.posix.basename(f) === base) continue;
    if (s === c) out.push(`${f}（同名字干、只换了扩展名）`);
    else if (c.startsWith(s) && c.length - s.length <= 3) out.push(`${f}（比实物名字干多写了 “${c.slice(s.length)}”）`);
    else if (s.startsWith(c) && s.length - c.length <= 3) out.push(`${f}（比实物名字干少了 “${s.slice(c.length)}”）`);
  }
  return [...new Set(out)];
}

/** 无斜杠裸名走通用四类裁决的文档（= 已跟踪 .md 减去 CROSS_REPO_DOCS）。新增文档默认纳面，
 *  要豁免只能进 CROSS_REPO_DOCS 点名写理由——不允许默默放行。 */
const BARE_NAME_ADJUDICATED = true;   // 开关只为了 self-test 里能跑「扩面前后」对比，不是豁免开关

/** 跳仓/宿主对照文档：**逐份**点名（禁止目录通配）+ 一句理由。这里的裸名不裁决（它们指的不是本仓实物），
 *  但条目本身被反向校：这份文档里已经没有任何裸名需要被豁免 → 红（防条目烂在那里）。 */
const CROSS_REPO_DOCS = new Map([
  ["docs/harness-comparison/01-pi-agent.md", "整篇在拆上游 pi 发行包的 dist/ 与源码，裸名是它的文件（output-accumulator.js、bash-executor.js…）"],
  ["docs/harness-comparison/02-touwaka.md", "整篇在拆宿主 touwaka 仓，裸名是它的源码文件（full-organizer.js、skill-runner.js…）"],
  ["docs/harness-comparison/03-codex.md", "整篇在拆上游 codex CLI，裸名是它的记忆目录产物（memory_summary.md、MEMORY.md…）"],
  ["docs/harness-comparison/04-hermes-agent.md", "整篇在拆上游 hermes-agent，裸名是它的指令文件与记忆文件（CLAUDE.md、USER.md…）"],
  ["docs/harness-comparison/06-cross-comparison.md", "五方横向对照表，裸名来自被对照的各仓，不指本仓实物"],
  ["docs/harness-comparison/07-takeaways-and-open-questions.md", "结论页引用的是被对照仓自己的档案（如 tw 自己补的 chat-memory-boundaries.md）"],
  ["docs/harness-comparison/08-runtime-erix-battery.md", "沙箱脚本清单（/tmp/erix-battery 下的 gen.sh 等），不是仓内文件"],
  ["docs/harness-comparison/README.md", "对照系列的导读页，结论里提的 MEMORY.md 属于被对照的各仓"],
  ["docs/eval/2026-09-18-erix-060-real-project-eval.md", "对宿主 touwaka 快照做运行时评估的记录，裸名是被评项目自己的文件（utils-id.test.js、message.controller.js…）"],
  ["docs/suggestions/03-cli-edit-tool.md", "建议稿引用的是上游 pi 仓 packages/coding-agent/src/core/tools/ 下的参考设计（edit-diff.ts）"],
]);

/** 极简 .gitignore 匹配（零依赖，只支持注释、`目录/`、`*.ext`、`**`、裸名——本仓那 9 条全在这个子集里）。
 *  取反 `!` 不在子集里：碰到就报错，而不是默默当没忽略（宁可假红，不要假绿）。 */
function compileIgnoreRule(pattern) {
  const dirOnly = pattern.endsWith("/");
  const p = pattern.replace(/\/+$/, "");
  const anchored = p.includes("/");
  const body = p
    .split("/")
    .map((seg) => (seg === "**" ? ".*" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
    .join("/")
    .replace(/\/\.\*\//g, "/(?:.*/)?"); // `a/**/b` 允许 `**` 匹配零段（git 语义）
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}${dirOnly ? "/.*$" : "(?:/.*)?$"}`);
}

function gitignoreMatcher(text) {
  const rules = [];
  const unsupported = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) return;
    if (raw.startsWith("!")) { unsupported.push({ pattern: raw, line: i + 1 }); return; }
    rules.push({ pattern: raw, line: i + 1, re: compileIgnoreRule(raw) });
  });
  // 后写的规则覆盖先写的（与 git 同口径）
  const ruleFor = (rel) => rules.filter((r) => r.re.test(rel)).at(-1) ?? null;
  return { ruleFor, unsupported, rules };
}

/** 未被忽略的仓库文件清单（惰性建一次；`walk()` 从根递归会钻到 node_modules，所以自带剪枝）。 */
/** 全仓文件清单（惰性建一次，键是 .gitignore 的规则集合 + 当前树形夹具）。分两份：未忽略的（= 克隆后仍在的）
 *  与被忽略的（= 只有本机有的）。被忽略目录照常下钻（要认得 e2e-wake.mjs 这种「裸名指向档案」），
 *  但安装位置、工作副本与丢弃型临时目录剪掉（node_modules/ / .worktrees/ / .scratch/ 里不是仓库内容：
 *  前两个是一整份别的仓库，后一个是复现脚本与对照树）。哪些类别被剪由 `SKIPPED_DIR_KINDS` 显式点名。
 *
 * `SIM_TREE_SHAPE`（#280 引入、#302 改造成**合成树夹具**；只给 `--self-test` 用，**不是豁免开关**）：
 * 「本机档案目录」这一格渗进裁决的地方只有两处——`resolveRef` 的裸名同名索引与 `bareNameNearest`
 * 的实物清单（都读这份清单的 `ignored` 那一半），外加一个 `taskArchiveDirPresent()` 谓词。
 * 所以「树形」在这份脚本里的**全部**含义就是这三样，夹具就声明在这三样上，与检查机上恰好有没有
 * `docs/tasks/` 无关：
 *   · `no-archive-dir`     —— 全新 clone / CI / 一次性沙箱：那个目录整片不在；
 *   · `empty-archive-dir`  —— 目录在、里面一条档案都没有（`npm test` 的端到端探针造过这个形状）；
 *   · `filled-archive-dir` —— 目录在、里面有本仓文档真的引用的那几条登记物（= 开发机）。
 * 声明一侧（.gitignore 规则、就地声明、登记表）一个字都不动：要证的正是「裁决只依赖声明时，
 * 三种树形必须给同一个结论」。
 *
 * #302 的病：旧口子 `SIM_ABSENT_TASK_ARCHIVE` 只有「摘掉实物」这一个动作，于是自测自己的落地检查
 * 拿**真实实物数量**当判据（「本机有档案目录却一条都没摘掉 ⇒ 口子没接线」）——在「目录在、里面是空的」
 * 机器上恒真地误报 2 例（CI 的干净检出上却是 0 例）。夹具化之后落地检查比对的是**夹具声明的那份清单**
 * （`treeFixtureLanding`），同一提交在三种树形上给同一个结论。
 * 缓存键必须带上它，否则同一个进程里三种树形会互相吃到对方的缓存。 */
const TREE_SHAPE_NO_DIR = "no-archive-dir";
const TREE_SHAPE_EMPTY = "empty-archive-dir";
const TREE_SHAPE_FILLED = "filled-archive-dir";
const TREE_SHAPES = [TREE_SHAPE_NO_DIR, TREE_SHAPE_EMPTY, TREE_SHAPE_FILLED];
/** `filled-archive-dir` 里那几条档案：本仓文档真的引用到的登记物（路径与开发机上同名同位置，内容不重要）。
 *  它把「实物在场」那一支也覆盖到：登记物解得到 ⇒ `localArchiveVerdict` 走「已核实」而不是「按声明放行」。 */
const TREE_FIXTURE_ARCHIVE_FILES = [
  "docs/tasks/active/261010-13-erix-run-async/repro-circular-details.mjs",
  "docs/tasks/active/261010-13-erix-run-async/e2e-wake.mjs",
  "docs/tasks/active/task-20260830-touwaka-full-integration/BRANCH.md",
  "docs/tasks/done/260926-strategy-variance-benchmark/REPORT.md",
];
let SIM_TREE_SHAPE = null;   // null = 真实树（默认）；否则是上面三种形状之一
let repoFilesCache = null;
/** 一条被忽略的**目录规则**要不要整目录剪掉（不进 tracked / ignored 清单）。未登记的规则按「不扫」处理：
 *  未分类本身已由 collectPathErrors 直接报红，扫描面不替它兜底。跳过与否只由 `SKIPPED_DIR_KINDS` 决定，
 *  所以 `--self-test` 能拿这个谓词直接证「`.scratch/` 真的不扫」（见 #337 那一例的 assertAfter）。 */
function ignoredDirIsSkipped(rule) {
  const cls = IGNORED_DIR_CLASSES.get(rule.pattern);
  if (!cls) return true;
  return SKIPPED_DIR_KINDS.has(cls.kind);
}
function repoFiles(ign) {
  const key = `${SIM_TREE_SHAPE ?? "real"}|${ign.rules.map((r) => r.pattern).join("\n")}`;
  if (repoFilesCache && repoFilesCache.key === key) return repoFilesCache;
  const tracked = [];
  const ignored = [];
  const skipDir = (rel) => {
    const rule = ign.ruleFor(`${rel}/`);
    if (!rule) return false;
    return ignoredDirIsSkipped(rule);
  };
  (function down(dir, underIgnored) {
    for (const name of readdirSync(path.join(ROOT, dir || "."))) {
      if (name === ".git" || name === "node_modules") continue;
      const rel = dir ? `${dir}/${name}` : name;
      if (skipDir(rel)) continue;
      if (statSync(path.join(ROOT, rel)).isDirectory()) down(rel, underIgnored || !!ign.ruleFor(`${rel}/`));
      else (underIgnored || ign.ruleFor(rel) ? ignored : tracked).push(rel);
    }
  })("", false);
  // 树形夹具：把 task-archive 类目录这一格**整片**换成夹具声明的那份清单（真实实物一律不参与），
  // 所以三形状之间只差「那批文件在不在索引里」这一件事——声明一侧（.gitignore / 登记表 / 就地声明）不动。
  const outside = SIM_TREE_SHAPE ? ignored.filter((f) => !isUnderTaskArchive(ign, f)) : ignored;
  const ignoredHere = SIM_TREE_SHAPE === TREE_SHAPE_FILLED
    ? outside.concat(TREE_FIXTURE_ARCHIVE_FILES)
    : outside;
  repoFilesCache = {
    key, tracked, ignored: ignoredHere,
    // #302：夹具落地检查要问「索引里那批档案到底是哪几条」，所以把它单独留一份（真实树里就是真清单）。
    archiveInIndex: ignoredHere.filter((f) => isUnderTaskArchive(ign, f)),
  };
  return repoFilesCache;
}

/** 引用行与登记表都要问「这个名字是不是落在 task-archive 目录下」——与 repoFiles 的 SIM 过滤共用一份定义。 */
function isUnderTaskArchive(ign, rel) {
  const rule = ign.ruleFor(rel);
  return !!rule && IGNORED_DIR_CLASSES.get(rule.pattern)?.kind === "task-archive";
}
/** 本机是否真的有 task-archive 类目录。夹具挂着时由**夹具**回答（#302：否则这个谓词读的是检查机上的
 *  文件系统，同一提交在「目录在」与「目录不在」两台机器上就不同判）。 */
function taskArchiveDirPresent(ign) {
  if (SIM_TREE_SHAPE) return SIM_TREE_SHAPE !== TREE_SHAPE_NO_DIR;
  return [...IGNORED_DIR_CLASSES.entries()]
    .filter(([, c]) => c.kind === "task-archive")
    .some(([dir]) => existsSync(path.join(ROOT, dir)));
}

/** #302：合成树夹具必须**真的落上**——索引里 task-archive 类的文件清单必须逐条等于夹具声明的那一份。
 *  旧判据是「本机确实有档案实物、却一条都没摘掉 ⇒ 口子没接线」，它把「机器上恰好有一个**空的**
 *  `docs/tasks/`」误报成没接线（#302 现场：同一提交在 CI 上 0 红、在空目录的机器上红 2 例）。
 *  新判据只问「夹具声明的清单 == 索引里的清单」，与机器形状无关；`filled` 那一格是非空期望，
 *  所以口子被拆掉时它会红（`no-archive-dir` / `empty-archive-dir` 在干净机器上退化成同一个清单，
 *  光靠它们证不到接线——这也是三形状必须**一起**跑的原因）。
 *  `taskArchiveDirPresent()` 那一句看着像同义反复，其实是唯一能证明「这个谓词由夹具回答」的断言：
 *  三种形状要求它依次返回 false / true / true，而真实文件系统只可能给其中一个值 ⇒ 三格同时绿
 *  只可能是夹具真的接管了它。返回 null = 落上了。 */
function treeFixtureLanding(ign) {
  const want = SIM_TREE_SHAPE === TREE_SHAPE_FILLED ? TREE_FIXTURE_ARCHIVE_FILES : [];
  const got = repoFiles(ign).archiveInIndex;
  const problems = [];
  const missing = want.filter((f) => !got.includes(f));
  const extra = got.filter((f) => !want.includes(f));
  if (missing.length) problems.push(`夹具声明的档案没进索引（${missing.join(", ")}）——SIM_TREE_SHAPE 没接进 repoFiles`);
  if (extra.length) problems.push(`索引里还有夹具没声明的档案（${extra.join(", ")}）——真实树的实物漏进了裁决面，树形没解耦`);
  const wantDir = SIM_TREE_SHAPE !== TREE_SHAPE_NO_DIR;
  if (taskArchiveDirPresent(ign) !== wantDir) {
    problems.push(`taskArchiveDirPresent() 与夹具形状 ${SIM_TREE_SHAPE} 不一致（应为 ${wantDir}）——口子没接进这条谓词`);
  }
  return problems.length ? problems.join("；") : null;
}

/** 三级解析：仓库根 → 文档同目录 → 全仓唯一同名。同名只认**唯一**命中（歧义不算解析成功，
 *  要写清路径）；先查未忽略文件（克隆后仍在的那批），再查被忽略的（解到就走「忽略类」裁决）。
 *  解不到时把命中的 .gitignore 规则一并带出，供分类使用。 */
function resolveRef(p, docRel, ign) {
  const fromDoc = p.startsWith("./") || p.startsWith("../");
  const clean = p.replace(/^\.\//, "");
  const docDir = path.posix.dirname(docRel);
  const cands = fromDoc
    ? [path.posix.normalize(path.posix.join(docDir, p))]
    : [clean, path.posix.normalize(path.posix.join(docDir, clean))];
  for (const c of cands) {
    const rule = ign.ruleFor(c);
    if (rule) return { ignoredPath: c, rule };
    if (existsSync(path.join(ROOT, c))) return { resolved: c, via: c === clean ? "仓库根" : "文档同目录" };
  }
  if (!clean.includes("/")) {
    const idx = repoFiles(ign);
    const hits = idx.tracked.filter((f) => path.posix.basename(f) === clean);
    if (hits.length === 1) return { resolved: hits[0], via: "全仓唯一同名" };
    if (hits.length > 1) return { ambiguous: hits };
    const local = idx.ignored.filter((f) => path.posix.basename(f) === clean);
    if (local.length === 1) return { ignoredPath: local[0], rule: ign.ruleFor(local[0]) };
    if (local.length > 1) return { ambiguous: local };
  }
  return { tried: clean, rule: ign.ruleFor(clean) };
}

/** 提取一份文本里「主检查真正会拿去裁决的引用」。**#279 附带产物 `spans`**：每一处被提取到的引用在文本里的
 * 字符区间，且区间只覆盖**归一化之后的那个值**（`raw` 的头尾被剥掉的 URL 前缀 / `#锚点` / `:行号` / 末尾标点
 * 都不算进来——归一化只做头尾裁剪，所以值一定是 raw 的连续子串，区间好定位）。
 * `--self-test` 的变异打靶就落在这些区间上（见 `refSweep`）：这样「打在哪一处」由**提取逻辑**决定，
 * 不再由「文本里第一次出现在哪」决定——后者会让任何人的一句散文抢走那一枪（见 SELF_TEST_CASES 上方的 #279 清单）。 */
function extractRefOccurrences(text) {
  const out = new Map(); // 去重保留首次出现位置，报错要能点名行
  const spans = [];      // #279：全部出现（不去重），供自测定点变异用
  const commands = [];
  let lineStart = 0;
  const push = (raw, line, at) => {
    let p = raw;
    const url = p.match(/^https?:\/\/[^/]+\/(?:ErixWong\/erix-agent)?\/?(?:blob|tree)\/main\/(.+)$/);
    if (url) p = url[1];
    else if (/^https?:/.test(p)) return;
    if (/^[~$]/.test(p)) return; // 用户目录（~/.erix）与环境变量形式（$XDG_CONFIG_HOME）不属于本仓库
    if (p.includes("\\") || (p.startsWith("/") && p.endsWith("/"))) return; // 正则字面量（`/valid NoteRecord/`）不是路径
    if (p.includes("://")) return; // 自定义 URL scheme（`app://skills/skill.mjs`）
    // 行号剥除（#621）：**单行 `file.js:N` 与区间 `file.js:N-M` 必须走同一条剥号路径**。
    // 修前这里只认 `:\d+(?::\d+)?$`，于是 `file.js:226-227` 的尾巴**没被剥掉**，紧接着的扩展名过滤
    // （`/\.(?:js|mjs|json|md|ts|sh|log)$/`）看到一个以 `-227` 结尾的串 ⇒ 整个 token 被 `return` 丢弃，
    // 这处引用**一处也不进裁决**（区间形式的裸引用 = 零校验：路径改成什么都绿）。
    // 剥完之后的裁决边界写在下一条注释里（两条规则各管一段，别把二者混成一条）。
    p = p.replace(/#.*$/, "").replace(/:\d+(?:-\d+)?(?::\d+)?$/, "").replace(/[).,;:;,]+$/, "");
    // 裁决边界（#621 期望 2，此前只存在于实现细节里）：
    //   ① **带外仓前缀**的引用（`pi-subagents:src/…:N`）不做**本仓**存在性核对——路径属于另一个仓，本仓没有
    //      可核对的真值；`externalRepoPrefixVerdict` 只认「前缀在 EXTERNAL_REPO_PREFIXES 里登记过」，前缀写错
    //      照样红。这是**预期**，不是漏洞：别为了「区间也红」把外仓路径改成必红。
    //   ② **区间形式**（`file.js:a-b`）与单行形式（`file.js:a`）走**同一条**裁决路径：剥掉行号后按普通引用
    //      解析（裸引用查存在性 / 外仓前缀走 ① 的豁免）。区间本身不被核对（行号会漂），但**路径**必须真的存在。
    if (!p || p.startsWith("#")) return;
    if (!p.startsWith("./") && !p.startsWith("../")) {
      if (p.startsWith(".")) return; // .mcp.json / .erix/skills/ 这类宿主侧配置目录
    }
    if (/[*<>|"'{}\[\]()=]/.test(p)) return; // glob 与占位符
    if (!/\.(?:js|mjs|json|md|ts|sh|log)$|\/$/.test(p)) return; // 只核对像路径的东西
    if (!out.has(p)) out.set(p, line);
    const head = url ? raw.indexOf(url[1]) : 0;   // 值在 raw 里的起点（URL 形式取捕获组那段）
    spans.push({ p, start: lineStart + at + head, end: lineStart + at + head + p.length });
  };
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) push(m[1], i + 1, m.index + m[0].lastIndexOf(m[1]));
    for (const m of line.matchAll(/`([^`\s]+)`/g)) push(m[1], i + 1, m.index + m[0].lastIndexOf(m[1]));
    for (const m of line.matchAll(/(?:^|\s)(?:LLM_KIT_E2E=1\s+)?node\s+([\w./-]+\.(?:mjs|js))/g)) {
      commands.push({ kind: "file", value: m[1], line: i + 1 });
    }
    for (const m of line.matchAll(/(?:^|[\s(（:：、，|《])((?:\.\.\/)*docs\/tasks\/[\w.\-\/]+)/g)) push(m[1], i + 1, m.index + m[0].lastIndexOf(m[1])); // #273：纯文本里写的任务档案路径也是引用
    for (const m of line.matchAll(/npm run ([\w:.-]+)/g)) {
      commands.push({ kind: "script", value: m[1], line: i + 1 });
    }
    lineStart += line.length + 1;
  });
  return { refs: [...out.entries()].map(([p, line]) => ({ p, line })), commands, spans };
}

/** 按文档提取（检查面用；`rel` 走 `textOf`，所以 `--self-test` 的内存副本一样被同一套逻辑扫）。 */
function candidatePaths(rel) {
  return extractRefOccurrences(textOf(rel));
}

/** 把一处解不到的引用归到四类里；解得出结论就返回 null。 */
/** 分类台账：每条白名单被哪一处引用用到过，都在这里留痕；收尾时反查「登记了却没一处用上」的条目。 */
const REF_CLASS_HITS = new Set();
/** 台账之三（工单 261021-03 B1）：外部仓前缀被哪些仓名真的用过——只用来报「条目空转」，
 *  使用情况本身另走 `externalRepoPrefixCensus()`（它不依赖两处判据的执行顺序）。 */
const extPrefixHits = new Set();
/** 台账之二（#280）：某条登记**被哪一处引用提到过**——在裁决**之前**记，与「那一处能不能放行」无关。
 *  「白名单条目空转」回答的是「登记表里有没有没人用的条目」，不回答「引用能不能裁决」。
 *  修前反向校只读 REF_CLASS_HITS，于是同一处引用一旦被判红，这里就**再补一条**「没有一处引用真正用到它」
 *  ——引用明明在，只是那一轮没放行；两条错误互相打脸，还把真问题（那处引用为什么红）淹成噪声。
 *  两张台账分开记：反向校「条目空转」只认这张（存不存在引用），放行证据才认那张（裁决结果）。 */
const REF_REFERRING_HITS = new Set();
let LAST_IGN = null;            // #280：collectPathErrors 用过的 .gitignore 规则（自测的树形例子要拿）
const passAs = (key) => { REF_CLASS_HITS.add(key); return null; };
/** 四张白名单登记表（反向校与「谁在用这条登记」共用一份定义，别再各处抄一遍） */
const WHITE_LIST_TABLES = [
  ["absent", EXPECTED_ABSENT_PATHS], ["external", EXTERNAL_REPO_PATHS],
  ["archive", LOCAL_ARCHIVE_REFS], ["shorthand", SHORTHAND_REFS],
];

/** #280：「本机档案」这一类**只按声明裁决**（就地声明或 LOCAL_ARCHIVE_REFS 逐条登记），
 *  不得要求实物在被 .gitignore 忽略的那个目录里解得到。修前把「实物解得到」当成放行的前提，
 *  于是这条门禁的绿隐含依赖「检查机上恰好有 docs/tasks/」——同一提交在**全新 clone / CI / 一次性沙箱**
 *  里必然红（与 #268「上一次运行的副作用决定门禁输出」同族的门禁不可复现）。
 *  实物解得到时**顺带加固**（核到就加固）：解到被忽略目录下 = 已核实；解到**未忽略**的实物 = 它已入库，
 *  「本机档案」的定义失效 → 红（这条与实物在不在无关，三种树形同判）。核不到实物（整目录不在本机）
 *  → 不影响结论，按声明放行。返回 { ok, verified, why }。 */
function localArchiveVerdict(p, ign, res = {}) {
  const probe = res.ignoredPath ?? p.replace(/^\.\.?\//, "");
  if (res.ignoredPath || ign.ruleFor(probe)) return { ok: true, verified: !!res.ignoredPath };
  if (res.resolved) return { ok: false, why: `它现在仓库里解得到实物 ${res.resolved}（没被 .gitignore 忽略）` };
  return { ok: true, verified: false };
}

/** 把一处解不到的引用归到四类里；能放行就返回 null，否则返回「为什么不放行」。 */
function classifyAbsent(p, docRel, line, ign, res = {}) {
  for (const [tag, table] of WHITE_LIST_TABLES) if (table.has(p)) REF_REFERRING_HITS.add(`${tag}:${p}`);
  if (EXPECTED_ABSENT_PATHS.has(p)) return passAs(`absent:${p}`);
  if (EXTERNAL_REPO_PATHS.has(p)) return passAs(`external:${p}`);
  const short = SHORTHAND_REFS.get(p);
  if (short) {
    // 简称本身不校 .gitignore（它不是生成物也不是本机档案），但它指向的实物必须还在：
    // 实物被改名/删了而简称没跟着改 → 这条登记就是在给未来的漂移留后门。
    return existsSync(path.join(ROOT, short.real[0]))
      ? passAs(`shorthand:${p}`)
      : `登记为 ${short.real.join(" / ")} 的简称（${short.why}），但 ${short.real[0]} 现在解不到了——实物已改名或已删，请连简称一起改（简称↔实物必须同生同死）`;
  }
  const probe = res.ignoredPath ?? p.replace(/^\.\.?\//, "");
  const gen = GENERATED_ARTIFACT_REFS.find((g) => g.re.test(p));
  if (gen) {
    return ign.ruleFor(probe)
      ? passAs(`generated:${gen.re.source}`)
      : `白名单把它归为生成物（${gen.why}），但 .gitignore 并不忽略 ${probe}——生成物的定义已失效`;
  }
  if (LOCAL_ARCHIVE_REFS.has(p)) {
    // #280：登记本身就是「这档案在本机、故意不入库」的声明，不得再拿「实物解不到」当反证——
    // 全新 clone 里根本没有 docs/tasks/。能核到实物就加固，核不到不影响结论（见 localArchiveVerdict）。
    const v = localArchiveVerdict(p, ign, res);
    return v.ok
      ? passAs(`archive:${p}`)
      : `登记为本机档案（${LOCAL_ARCHIVE_REFS.get(p)}），但 .gitignore 并不忽略 ${probe}——`
        + `它已入库或分类变了，请删掉这条登记（本机档案的定义已失效）：${v.why}`;
  }
  const rule = res.rule ?? ign.ruleFor(probe);
  if (rule) {
    if (!rule.pattern.endsWith("/")) {
      return `指向被 .gitignore 忽略的路径（.gitignore:${rule.line} \`${rule.pattern}\`），但这条规则没被分类——`
        + `去 IGNORED_DIR_CLASSES（目录型）或 GENERATED_ARTIFACT_REFS（生成物）里给它一个名字与理由，别默默放行`;
    }
    const dirCls = IGNORED_DIR_CLASSES.get(rule.pattern);
    if (!dirCls) {
      return `指向被 .gitignore 忽略的目录（.gitignore:${rule.line} \`${rule.pattern}\`），但这条目录规则没在 IGNORED_DIR_CLASSES 里分类`;
    }
    if (dirCls.kind !== "task-archive") {
      // 安装位置 / 构建产物 / 日志 / 工作副本：目录内容本身就不是仓库内容
      REF_CLASS_HITS.add(`dircls:${rule.pattern}`);
      return null;
    }
    // 「就地声明」只算**引用所在那一行**（不是上一行）：上一行常常是另一条目里顺手带出的
    // 「归档/忽略」字样，拿它放行就等于整目录豁免（#273：白名单不是整目录豁免）。
    const ctx = textOf(docRel).split("\n")[line - 1] ?? "";
    if (LOCAL_ARCHIVE_DECLARATION.test(ctx)) return null;
    return `指向任务档案（.gitignore:${rule.line} \`${rule.pattern}\` = ${dirCls.why}，实指 ${probe}），`
      + `但引用处没写「本机/本地/不入库/未跟踪/归档」这类声明，也没在 LOCAL_ARCHIVE_REFS 里逐条登记`
      + `（克隆后就是死引用；#162 定的口径：要么就地声明，要么逐条写理由，不许整目录豁免）`;
  }
  return `本仓不存在（仓库根 / ${docRel} 同目录 / 全仓唯一同名 三级都解不到），也不属于四类里的任何一类`
    + `——要么改对路径，要么按类登记并写理由（EXPECTED_ABSENT_PATHS / EXTERNAL_REPO_PATHS / `
    + `GENERATED_ARTIFACT_REFS / LOCAL_ARCHIVE_REFS）`;
}

function collectPathErrors() {
  const out = [];
  const notes = [];
  const ign = gitignoreMatcher(textOf(".gitignore"));
  LAST_IGN = ign;   // #280：`--self-test` 的树形例子要靠它拿到同一份 .gitignore 规则（见 runSelfTest）
  for (const u of ign.unsupported) {
    out.push(`paths: .gitignore:${u.line} 用了取反规则 \`${u.pattern}\`，本脚本的极简匹配器不认——`
      + `要么改 .gitignore，要么在这里支持取反（不能默默把它当没忽略）`);
  }
  // .gitignore 的**目录型规则**必须逐条分类（#273：新增一条目录规则不许默默放行）。这里不能只看
  // 「当前有文件被它忽略」：新建的 scratch/ 目录里还没文件时就完全不报，那条规则等于静默上线。
  for (const r of ign.rules.filter((x) => x.pattern.endsWith("/"))) {
    if (IGNORED_DIR_CLASSES.has(r.pattern)) continue;
    out.push(`paths: .gitignore:${r.line} 的目录规则 \`${r.pattern}\` 没在 IGNORED_DIR_CLASSES 里分类`
      + `（install-tree / build-output / runtime / worktree / scratch / task-archive 里选一个 + 写明理由）——`
      + `被忽略目录里的引用要不要放行、要不要进扫描面（SKIPPED_DIR_KINDS），得由分类决定，不许默默放行新目录`);
  }
  REF_CLASS_HITS.clear();
  REF_REFERRING_HITS.clear();
  extPrefixHits.clear();
  let excusedArchive = 0;
  for (const rel of PATH_DOCS) {
    const { refs, commands } = candidatePaths(rel);
    const bad = [];
    let resolvedByDoc = 0;
    let resolvedByBase = 0;
    let excused = 0;
    let extPrefixed = 0;
    for (const { p, line } of refs) {
      const ext = externalRepoPrefixVerdict(p);   // 工单 261021-03 B1：带外部仓前缀的引用不查本仓存在性
      if (ext) {
        if (ext.ok) { extPrefixHits.add(ext.repo); extPrefixed += 1; }
        else bad.push(`\`${p}\`（第 ${line} 行）：${ext.why}`);
        continue;
      }
      const r = resolveRef(p, rel, ign);
      if (r.resolved) {
        if (r.via === "文档同目录") resolvedByDoc += 1;
        if (r.via === "全仓唯一同名") resolvedByBase += 1;
        continue;
      }
      const why = classifyAbsent(p, rel, line, ign, r);
      if (why === null) {
        excused += 1;
        continue;
      }
      if (r.ambiguous) {
        bad.push(`\`${p}\`（第 ${line} 行）：本仓有 ${r.ambiguous.length} 个同名文件（${r.ambiguous.join(", ")}），`
          + `裸文件名到底指哪个写清（歧义不算解析成功）`);
        continue;
      }
      bad.push(`\`${p}\`（第 ${line} 行）：${why}`);
    }
    const badCommands = commands.filter((c) =>
      c.kind === "file" ? !existsSync(path.join(ROOT, c.value)) : !(PKG.scripts ?? {})[c.value]);
    if (bad.length) {
      out.push(`paths: ${rel} 引用了无法裁决的仓库内路径（${bad.length} 处）：\n      ${bad.join("\n      ")}`);
    }
    if (badCommands.length) {
      out.push(`paths: ${rel} 引用的命令不可执行：${badCommands.map((c) => `第 ${c.line} 行 \`${c.kind === "file" ? `node ${c.value}` : `npm run ${c.value}`}\``).join(", ")}`);
    }
    notes.push(`paths: ${rel} 核对 ${refs.length} 个路径引用（其中 ${resolvedByDoc} 个靠文档同目录、${resolvedByBase} 个靠唯一同名解析）、${commands.length} 个命令；白名单判定 ${excused} 处、外部仓前缀 ${extPrefixed} 处`);
  }
  // 本机档案与**无斜杠裸名**两类都**不限 PATH_DOCS**，全仓已跟踪 Markdown 都跑（#273 点名的两条历史样本就在
  // docs/harness-comparison/05 与 docs/research/2026-09-26 里，而那两份文档不适宜整体纳入
  // paths 覆盖面：docs/design/2026-10-08 实测 57 处引用里 46 处、docs/harness-comparison/01 的
  // 42 处里 32 处引用的是**别的仓库**的文件树，整体纳入就得整片豁免，等于没扩）。
  // #278 把「无斜杠裸名」也接进这一轮：带斜杠的引用维持原口径（上面的理由仍成立），
  // 但裸名要么能解析、要么有四类登记/就地声明，否则红——不再默默放行。豁免按**文档**逐份点名
  // （CROSS_REPO_DOCS），不允许目录通配；近邻判据则不分文档全仓生效。
  const bareCensus = { seen: 0, adjudicated: 0, excused: 0, red: 0, crossRepoSkipped: 0, nearRed: 0 };
  for (const docRel of repoFiles(ign).tracked.filter((f) => f.endsWith(".md") && !PATH_DOCS.includes(f))) {
    const rel = docRel;
    const { refs } = candidatePaths(rel);
    const bad = [];
    for (const { p, line } of refs) {
      const ext = externalRepoPrefixVerdict(p);   // 全仓 .md 那一轮同一条前缀判据（前缀不是 PATH_DOCS 专享的通道）
      if (ext) {
        if (ext.ok) extPrefixHits.add(ext.repo);
        else bad.push(`\`${p}\`（第 ${line} 行）：${ext.why}`);
        continue;
      }
      const r = resolveRef(p, rel, ign);
      if (r.resolved) continue;
      const rule = r.ignoredPath ? r.rule : ign.ruleFor(p.replace(/^\.\.?\//, ""));
      // 上一版读的是 r.ignored，而 resolveRef 返的字段叫 ignoredPath → 永远 undefined，
      // 于是「解到被忽略目录」的引用全部静默 continue（本类锚点实际从未跑过），这里一并接上。
      if (!rule || !rule.pattern.endsWith("/")) {
        // 解不到且没分类时，原本直接 continue（= 默默放行）。#278 后的口径：
        //   · 「像个文件」的无斜杠裸名 → 先跑近邻判据（全仓），再走四类裁决（除非整份文档已点名豁免）；
        //   · 同行自己就写了 docs/tasks/… 的引用 → 依旧当本机档案报（#273：白名单不是整目录豁免）；
        //   · 其余（带斜杠的解不到引用）→ 维持原状，不在本锚点覆盖面内。
        const lineText = textOf(rel).split("\n")[line - 1] ?? "";
        // 只拿「像个文件」的引用当档案引用：CHANGELOG 里 `scratch/` 这种目录/规则名也在同一行出现，
        // 不卡这一刀就会把目录名当成被改名的本机档案（假红）。
        const looksLikeFile = /\.[A-Za-z0-9]+$/.test(p.replace(/\/+$/, ""));
        const bare = !p.includes("/") && BARE_FILE_RE.test(p) && BARE_NAME_ADJUDICATED;
        const mentionsTaskArchive = /(^|[^-\w])docs\/tasks\//.test(lineText);
        if (looksLikeFile && mentionsTaskArchive) {
          // #280：这一支过去**不问登记也不问声明**，直接判红。于是「已登记的裸名」在没有 docs/tasks/ 的
          // 树形里会被说成「也不在 LOCAL_ARCHIVE_REFS 登记里」（它明明登记着），并连带把白名单反向校
          // 打成「条目空转」。现在先走同一套四类裁决：已登记/已就地声明 → 按声明放行（实物核到就加固，
          // 核不到不影响结论）；只有**既未登记又未声明**的才继续拿下面那句点名（措辞与 #273 一致）。
          if (classifyAbsent(p, rel, line, ign, r) === null) {
            excusedArchive += 1;
            if (bare) { bareCensus.seen += 1; bareCensus.adjudicated += 1; bareCensus.excused += 1; }
            continue;
          }
          // 引用行自己就在讲任务档案 → 无论有无斜杠都按「本机档案」判（#273 定的口径，措辞不变）。
          const stem = (s2) => s2.replace(/\.[^.]+$/, "");   // 去扩展名后比前缀：改名（加/删一个字符）必然落在同一前缀里
          const twin = [...LOCAL_ARCHIVE_REFS.keys()].find((k) => k !== p
            && (stem(path.posix.basename(k)).startsWith(stem(path.posix.basename(p)))
              || stem(path.posix.basename(p)).startsWith(stem(path.posix.basename(k)))));
          bad.push(`\`${p}\`（第 ${line} 行）：指向任务档案（同一行写了 \`docs/tasks/…\`，该目录整目录不入库），`
            + `但这个名字仓库里解不到、也不在 LOCAL_ARCHIVE_REFS 登记里`
            + (twin ? `——与已登记的 \`${twin}\` 只差一个字符：登记与引用必须一起改` : "")
            + (bareNameNearest(p, ign).length ? `；它跟本仓实物也只差一点：${bareNameNearest(p, ign).slice(0, 3).join(" / ")}` : ""));
          if (bare) { bareCensus.seen += 1; bareCensus.red += 1; }
          continue;
        }
        if (!bare) continue;   // 带斜杠又没在任务档案行里的解不到引用 → 不在本锚点覆盖面内（维持 #273 原口径）
        bareCensus.seen += 1;
        // 先跑四类裁决（能解析 / 已登记 / 就地声明就放行）。顺序很重要：已登记的裸名
        // （judge.log、status.json）必须先看登记，否则会被近邻判据误伤。
        const why = classifyAbsent(p, rel, line, ign, r);
        bareCensus.adjudicated += 1;
        if (why === null) { excusedArchive += 1; bareCensus.excused += 1; continue; }
        const near = bareNameNearest(p, ign);
        const crossRepo = CROSS_REPO_DOCS.get(rel) ?? null;
        // 跳仓对照文档：通篇在讲另一个仓库，解不到又不像本仓实名的裸名不裁决（但条目被反向校）。
        // 近邻判据**不豁免**——把本仓真实存在的档案名改坏一个尾巴，在哪份文档里都该红。
        if (crossRepo && !near.length) {
          REF_CLASS_HITS.add(`crossrepo-doc:${rel}`);
          bareCensus.crossRepoSkipped += 1;
          continue;
        }
        bareCensus.red += 1;
        if (crossRepo) bareCensus.nearRed += 1;
        // ③ 同名字干有实物 → 红字额外点名「它像哪个实物」；同名多命中（歧义）也点名候选实物。
        const hint = near.length
          ? `它跟本仓实物只差一点：${near.slice(0, 3).join(" / ")}——若本意就是那个文件，把裸名改成它的真实路径（改名要连引用一起改）`
          : (r.ambiguous ? `本仓有 ${r.ambiguous.length} 个同名文件（${r.ambiguous.join(", ")}），裸名到底指哪个要写清（歧义不算解析成功）` : "");
        bad.push(`\`${p}\`（第 ${line} 行）：${why}${hint ? `\n      ↳ ${hint}` : ""}${crossRepo ? "（这份文档已逐份点名豁免非实名的裸名引用，但近邻判据不豁免）" : ""}`);
        continue;
      }
      const why = classifyAbsent(p, rel, line, ign, r);
      if (why === null) { excusedArchive += 1; continue; }
      bad.push(`\`${p}\`（第 ${line} 行）：${why}`);
    }
    if (bad.length) {
      out.push(`archive-refs: ${rel} 引用了克隆后不存在的本机档案或无法裁决的裸文件名（${bad.length} 处）：\n      ${bad.join("\n      ")}`);
    }
  }
  notes.push(`archive-refs: 全仓非入口文档里指向被忽略目录的引用已全部裁决（白名单/就地声明共 ${excusedArchive} 处）`);
  notes.push(`bare-names: 无斜杠裸名裁决面——需裁决 ${bareCensus.adjudicated}（放行 ${bareCensus.excused}、红 ${bareCensus.red}，其中近邻判据 ${bareCensus.nearRed}）、`
    + `跳仓文档点名豁免 ${bareCensus.crossRepoSkipped} 处（${CROSS_REPO_DOCS.size} 份逐份点名的文档，无目录通配）`);
  // 白名单也要校：没人引用的条目就是「为不存在的引用留后门」，同样算检查面腐坏。
  const tables = WHITE_LIST_TABLES;
  for (const [tag, table] of tables) {
    for (const p of table.keys()) {
      const hitKey = `${tag}:${p}`;
      if (REF_CLASS_HITS.has(hitKey)) continue;
      // #280：与「引用能否裁决」解耦——这条引用**存在**、只是那一轮没能放行，那条红已经点名了它；
      // 这里不许再补一句「没有一处引用真正用到它」（引用明明在，只是未放行）。两条一起报只会互相打脸。
      if (REF_REFERRING_HITS.has(hitKey)) continue;
      out.push(`paths: 白名单条目 \`${p}\` 没有一处引用真正用到它——要么它现在已能直接解析到（那就该删），`
        + `要么被检文档（${PATH_DOCS.join(", ")} + 全仓 .md）里已没人引用它；留着就是给未来的漂移留后门`);
    }
  }
  // 已知外部仓前缀也要反向校（工单 261021-03 B1，与四张白名单登记表同口径）：没人用的仓名就是给
  // 未来的死链留的后门（随手拿一个已登记的仓名当「不是本仓文件」的通行票）。
  const extUsed = externalRepoPrefixCensus();
  for (const repo of EXTERNAL_REPO_PREFIXES.keys()) {
    if (extUsed.has(repo)) continue;
    out.push(`paths: 外部仓前缀 \`${repo}:\` 没有一处引用真正用到它（校面 = 点名文档 ∪ 实扫指南共 ${new Set([...PATH_DOCS, ...refScanDocs()]).size} 份）——`
      + `要么引用已改对/已删，要么该删这条登记；前缀清单里留着没人用的仓名，等于给下一个死链预备了一个借口（${EXTERNAL_REPO_PREFIXES.get(repo)}）`);
  }
  // #278：逐份点名的跳仓文档也要反向校—4 份文档里已经没有任何需要豁免的裸名（或文档已改名/删了）
  // 就该销账，否则豁免清单会默许烂下去（跟白名单条目同病）。
  for (const d of CROSS_REPO_DOCS.keys()) {
    if (REF_CLASS_HITS.has(`crossrepo-doc:${d}`)) continue;
    out.push(`bare-names: 跳仓点名清单里的 \`${d}\` 现在没有一处裸名引用用上它——文档已改名/删了，或里面的裸名引用已被逐条裁决；`
      + `请删这条豁免（逐份点名的清单不许有没人用的条目）`);
  }
  for (const g of GENERATED_ARTIFACT_REFS) {
    if (!REF_CLASS_HITS.has(`generated:${g.re.source}`)) {
      notes.push(`paths: 生成物条目 /${g.re.source}/ 当前没被用到（覆盖面内没有这类引用），保留是为了不让 *.d.ts 变红`);
    }
  }
  // 登记表自己也要被 .gitignore 校：「本机档案」的定义就是「被忽略目录里的档案」，目录不再忽略
  // 它就该销账（#273：分类真的读 .gitignore，不是只写在注释里）。
  let archiveUnverifiable = 0;
  for (const [p, why] of LOCAL_ARCHIVE_REFS) {
    // 登记可能是裸名（examples README 同句举的脚本名），先走同一套三级解析再问 .gitignore。
    const res = resolveRef(p, PI_EXT_README, ign);
    // #280：登记表自己的反向校也**不得依赖实物存在**。裸名在 .gitignore 里根本无从校（`docs/tasks/` 是
    // 目录规则，裸名不带目录），旧实现只认「实物解到 task-archive 目录下」，于是同一提交在全新 clone 里
    // 会把每一条裸名登记都判成「登记已失效」。现在能判红的只剩「解到了未忽略的实物」（= 已入库），
    // 那条与本机有没有那个目录无关，在任意树形上同判。
    const v = localArchiveVerdict(p, ign, res);
    if (v.ok) {
      if (!v.verified) archiveUnverifiable += 1;   // 核不到实物（树形里没有 task-archive 目录）：按声明放行
      continue;
    }
    // 逐份点名「谁在拿这条登记当护身符」：登记失效 = 那些引用同时失去裁决依据（#273：分类真的读 .gitignore）。
    const bn = path.posix.basename(p);
    const refDocs = [...PATH_DOCS, ...repoFiles(ign).tracked.filter((f) => f.endsWith(".md") && !PATH_DOCS.includes(f))]
      .filter((d) => { const t = textOf(d); return t.includes(p) || t.includes(bn); });
    for (const d of (refDocs.length ? refDocs : ["（无文档引用）"])) {
      out.push(`archive-refs: ${d} 登记的 \`${p}\` 登记为本机档案（${why}），但 .gitignore 并不忽略它`
        + `——本机档案的定义就是「被 task-archive 目录忽略的本机文件」，登记已失效，请删登记或改 .gitignore`);
    }
  }
  if (archiveUnverifiable) {
    notes.push(`archive-refs: ${archiveUnverifiable} 条本机档案登记在当前树形里核不到实物（没有 docs/tasks/ 的树形：全新 clone / CI / 一次性沙箱）`
      + `——按声明放行（#280：这类裁决不得依赖实物存在，否则门禁在克隆机上永远红）`);
  }
  const dirClsUsed = [...REF_CLASS_HITS].filter((k) => k.startsWith("dircls:"));
  notes.push(`paths: 被忽略目录的分类被用到的有 ${dirClsUsed.length ? dirClsUsed.map((k) => k.slice(7)).join(", ") : "（无）"}`);
  collectPathErrors.notes = notes;
  return out;
}

for (const e of collectPathErrors()) err(e);
for (const n of collectPathErrors.notes ?? []) note(n);

// ── 6. 中英标题骨架（README 一对，AGENTS 一对；issue #274 的附带项把 AGENTS 也纳入）────────
function headingLevels(rel) {
  return textOf(rel)
    .split("\n")
    .reduce((acc, line, i) => {
      const m = line.match(/^(#{1,6})\s+(.*)/);
      if (m) acc.push({ line: i + 1, level: m[1].length, title: m[2].trim() });
      return acc;
    }, []);
}

const seq = (hs) => hs.map((h) => h.level).join(",");

/** 一对中英文档的骨架对账（数量、层级序列、逐级数量）。*/
function collectSkeletonErrors(label, enRel, cnRel) {
  const out = [];
  const enH = headingLevels(enRel);
  const cnH = headingLevels(cnRel);
  if (enH.length !== cnH.length) {
    out.push(`skeleton: ${label} 标题总数不齐：EN ${enH.length} vs CN ${cnH.length}`);
  }
  if (seq(enH) !== seq(cnH)) {
    const i = [...seq(enH), "..."].findIndex((v, idx) => v !== [...seq(cnH), "..."][idx]);
    const at = Math.min(i, enH.length - 1, cnH.length - 1);
    out.push(
      `skeleton: ${label} 标题层级序列不齐（第 ${i + 1} 个标题起）：EN「${enH[at]?.title ?? "无"}」(L${enH[at]?.line ?? "-"}) vs CN「${cnH[at]?.title ?? "无"}」(L${cnH[at]?.line ?? "-"})；`
      + `\n    EN ${seq(enH)}\n    CN ${seq(cnH)}`,
    );
  }
  for (const level of new Set([...enH.map((h) => h.level), ...cnH.map((h) => h.level)])) {
    const ne = enH.filter((h) => h.level === level).length;
    const nc = cnH.filter((h) => h.level === level).length;
    if (ne !== nc) out.push(`skeleton: ${label} h${level} 数量不齐：EN ${ne} vs CN ${nc}`);
  }
  collectSkeletonErrors.notes = [`skeleton: ${label} 标题骨架一致（${enH.length} 个标题，层级序列相同）`];
  return out;
}

const SKELETON_PAIRS = [
  ["中英 README", README_EN, README_CN],
  ["中英 AGENTS", AGENTS_EN, AGENTS_CN],
];

// ── 14. doc-version 自述（issue #511 判据 1 前半）───────────────────────────────
// 病根（issue #511）：门禁只看守「值对不对」，不看守「这句话属于哪个版本」。0.27 指南曾整篇描述
// 一棵 **0.28 的树**（「七个分组」「没有 `config.observers` 这一组」「函数值 is now refused」），
// 而当时 `check:docs:strict` 退出码 **0** —— 版本锚点只比「`package.json` 的版本号有没有被正确
// 引用」，散文里的**版本归属**无人看守。这类病已第三次出现（#499 的白名单时代错置、#497 的锚点链
// 陈数、#511 本次）。
//
// 判据 1 前半：每份 `docs/host-upgrade-guide-<X.Y.Z>[_cn].md` 的**第一行**必须是机器可读自述
// `<!-- doc-version: X.Y.Z -->`，且与文件名同源。没有自述 ⇒ 后面两条判据都无从判定「这句话属于
// 哪个版本」（抽不到真值就报错，#164 口径）。
const GUIDE_VERSION_RE = /^docs\/host-upgrade-guide-(\d+\.\d+\.\d+)(_cn)?\.md$/;
const GUIDE_GLOB_RE = /^host-upgrade-guide.*\.md$/;
const DOC_VERSION_LINE_RE = /^<!--\s*doc-version:\s*(\d+\.\d+\.\d+)\s*-->$/;

/** 非 semver 命名的历史指南：**逐条点名 + 写理由**（条目空转即红，#210 R2 惯例）。
 *  为什么不是「凡 `host-upgrade-guide*` 都要求自述」：`v030` 那两份是老文件名，一份文件覆盖
 *  0.3.0–0.3.4 一条边界，**没有单一自述版本可写**——强行填一个版本号等于让门禁承认一句假话。 */
const DOC_VERSION_EXEMPT = new Map([
  ["docs/host-upgrade-guide-v030.md", "0.3.x 时代的老文件名：一份文件覆盖 v0.3.0–v0.3.4 一条边界，没有单一自述版本可写（当时指南形态还没有版本锚点）"],
  ["docs/host-upgrade-guide-v030_cn.md", "同上（中英成对）"],
]);

/** `--self-test` 用：临时替换放行表（与 `SIM_CLI_FLAG_EXEMPTIONS` 同一课：overlay 只改文本，改不动运行时
 *  那个 Map）。「登记了却没人用 ⇒ 红」这条反向证要靠它把一条假条目塞进表里才证得到。 */
let SIM_DOC_VERSION_EXEMPT = null;
const docVersionExemptions = () => SIM_DOC_VERSION_EXEMPT ?? DOC_VERSION_EXEMPT;

function allGuideDocs() {
  return readdirSync(path.join(ROOT, "docs"))
    .filter((f) => GUIDE_GLOB_RE.test(f))
    .map((f) => `docs/${f}`)
    .sort();
}

/** 覆盖面里那些「文件名就能读出被记录版本」的指南。 */
function versionedGuideDocs() {
  return allGuideDocs().filter((rel) => GUIDE_VERSION_RE.test(rel));
}

const guideVersionOf = (rel) => rel.match(GUIDE_VERSION_RE)?.[1] ?? null;

/** 指南的自述版本（走 `textOf` ⇒ `--self-test` 的内存副本同样生效）；没有自述返 null。 */
function guideDocVersion(rel) {
  const rec = fileRecord(rel);
  if (!rec) return null;
  return rec.lines[0]?.trim().match(DOC_VERSION_LINE_RE)?.[1] ?? null;
}

function collectDocVersionErrors() {
  const out = [];
  const notes = [];
  const used = new Set();
  for (const rel of allGuideDocs()) {
    const version = guideVersionOf(rel);
    if (version === null) {
      if (!docVersionExemptions().has(rel)) {
        out.push(`doc-version: ${rel} 的文件名不是 \`host-upgrade-guide-<X.Y.Z>[_cn].md\`，读不出被记录版本——`
          + `改名成带版本号的形态；历史文件则在 DOC_VERSION_EXEMPT 里逐条登记并写理由（#511 判据 1）`);
      } else {
        used.add(rel);
      }
      continue;
    }
    const rec = fileRecord(rel);
    if (!rec) { out.push(`doc-version: ${rel} 读不到（覆盖面里点名了却打不开）`); continue; }
    const first = (rec.lines[0] ?? "").trim();
    const m = first.match(DOC_VERSION_LINE_RE);
    if (!m) {
      out.push(`doc-version: ${rel} 的第一行不是机器可读自述 \`<!-- doc-version: ${version} -->\`（实际是「${first.slice(0, 60)}」）——`
        + `指南必须自述它记录的是哪个版本，否则「这句话属于哪个版本」无从看守（#511 判据 1）`);
      continue;
    }
    if (m[1] !== version) {
      out.push(`doc-version: ${rel} 自述 ${m[1]}，文件名是 ${version}——自述与文件名必须同源，不许两份真值并存（改名或改自述）`);
      continue;
    }
    notes.push(`doc-version: ${rel} 自述 ${m[1]} == 文件名`);
  }
  for (const rel of docVersionExemptions().keys()) {
    if (!used.has(rel)) out.push(`doc-version: DOC_VERSION_EXEMPT 里登记的 ${rel} 不存在（或已改名成带版本号的形态）——`
      + `空转的放行条目就是后门，删掉它（#210 R2 惯例）`);
  }
  notes.push(`doc-version: ${versionedGuideDocs().length} 份带版本号的指南都自述了版本；非 semver 命名的历史指南 ${docVersionExemptions().size} 份按登记豁免`);
  collectDocVersionErrors.notes = notes;
  return out;
}

// ── 14b. 0.30 破坏包的逐名表（issue #429 的**文档面**）──────────────────────────
// 病根：`@deprecated` 标记说「0.30 删」，而**指南是给人读的那一份**——它写谁、写几行、条款是不是照抄标记，
// 在 #429 之前没有任何东西看守。手抄一份名单进文档，下一次登记一变动文档就成假话；而这正是本仓
// `computeInventory()`「名单现算、不抄第二份」那条口径在文档侧的同一个病。
//
// 判据（每条都点名到 指南:行 与 名字）：
//   1. 两份指南在（删掉一份 ⇒ 红）；页面版本必须是唯一合法移除边界 `NEXT_BREAKING_VERSION` 的 x.y + `.0`
//      （0.30 → 0.30.0）——边界一变，这一页必须跟着走；
//   2. **双向**对账：现算候选集里有、表里缺 ⇒ 红（点名）；表里有、候选集里没有 ⇒ 红（点名）；
//      同一个名字两行 ⇒ 红（多出来的那行不会被集合对账看见）；
//   3. **中英对账**：两份的名字集合必须相等（只改一边 ⇒ 红），同一名字的入口列必须逐字相同；
//   4. **迁移条款照抄标记**：每行的条款格必须含该名字 `@deprecated` 标记里的那一条
//      （`` migrate to `X` `` / `no in-tree replacement`）——「另编一套说法」在这里红；
//   5. **入口列现算**：`.` / `./tools` 两个入口由 `src/index.js` / `src/tools/index.js` 的再导出块现读，
//      写错入口 ⇒ 红（名字对了、住址错了，读者会去错子路径找它）。
//
// 边界（写清，别当漏做）：候选集**为空**时（待删包已清空，issue #688 之后就是这一态），这一页不再是
// 「历史记录」而是**已落地记录**：真值从「现算候选」扩到「现算候选 ∪ 源码里带 `removed in
// <NEXT_BREAKING_VERSION>` 的退役标记」（删掉的是入口再导出，标记还贴在实现文件上）。于是逐名集合与迁移
// 条款两条判据在**下一个删除边界**上照样咬人，不会因为「今天没有候选」变成永真；只有入口列对已退役行失去
// 现读真值（再导出块里已经没有它），那一格对 retired 行只校中英一致。真的一行真值都没有时（候选与标记都空）
// 才退化为只校中英一致与行形状，note 会明说。
// 版本号、两份文件名、入口列的合法写法、以及「一行长什么样」都从 `scripts/bundle-guide-table.mjs` 读：
// `scripts/host-consumer-probe.mjs` 的覆盖判据读的是同一张表（同一份读法，不抄第二份）。

/** 一份指南里的逐名行（`name → {line, clause, entry}`）与重复行（读法在共享模块里，这里只负责取文本）。 */
function bundleRowsOf(rel) {
  return bundleRowsFromText(textOf(rel));
}

/** 入口文件里 `export { … } from "…"` 的再导出名。块内行注释先剥掉，否则注释里的中文会被逗号切碎。 */
function entryExportNames(rel) {
  const names = new Set();
  for (const block of textOf(rel).matchAll(/export\s*\{([\s\S]*?)\}\s*from\s*"[^"]+";/g)) {
    for (const raw of block[1].replace(/\/\/[^\n]*/g, "").split(",")) {
      const token = raw.trim();
      if (!token) continue;
      const alias = token.split(/\s+as\s+/);
      names.add((alias[1] ?? alias[0]).trim());
    }
  }
  return names;
}

/** `@deprecated` 标记里的迁移条款（与 `deprecated-export-check` 的 R4 同一套形状）；没有返 null。 */
function bundleClauseOf(tag) {
  const text = String(tag ?? "");
  const migrate = /migrate to\s+`([^`]+)`/i.exec(text);
  if (migrate) return `migrate to \`${migrate[1]}\``;
  if (/no in-tree replacement/i.test(text)) return "no in-tree replacement";
  return null;
}

/** 现算候选集（本进程只算一次：候选集由 `src/` + `package.json` 派生，自测的变异全打在文档上，
 *  重算一百多次只会把本来就四分钟的自测抬成两倍）。 */
let BUNDLE_TRUTH = null;
function bundleTruth() {
  if (BUNDLE_TRUTH) return BUNDLE_TRUTH;
  const records = buildExportRecords(ROOT);
  const entries = resolveExportEntries(ROOT);
  const hostContract = hostContractNames(entries.pkg, records);
  const inventory = computeExportInventory(records, {
    root: ROOT,
    entries: entries.entries,
    contractNames: hostContract.names,
    extraErrors: entries.errors,
    extraWarnings: [...entries.warnings, ...hostContract.warnings],
  });
  if (inventory.incomplete) {
    BUNDLE_TRUTH = {
      failure: `清点不完整（${inventory.errors.map((e) => e.code).join(",") || "未给出 code"}）——候选集不是真值，`
        + "本判据无从对账（#164 口径：抽不到真值就报错，不许静默放行）",
    };
    return BUNDLE_TRUTH;
  }
  const result = verifyDeprecatedExports({ records, inventory, contractNames: hostContract.names });
  const rows = new Map();
  for (const row of result.candidates) {
    const registered = result.registered.find((reg) => reg.name === row.name);
    rows.set(row.name, { def: row.def, tag: registered?.tag ?? null, retired: false });
  }
  // issue #688：候选集被删空之后，「这一版删哪些名字」的真值仍然在源码里——`@deprecated … removed in
  // <NEXT_BREAKING_VERSION>` 的标记还贴在实现文件上（删掉的是入口再导出，不是实现）。把带这种标记的名字
  // 并进对账面，于是**逐名集合**与**迁移条款**两条判据在下一个删除边界上照样咬人，不会因为「今天没有
  // 候选」变成永真；入口列对已退役行无从现读（再导出块里已经没有这个名字），那一格对 retired 行只校中英
  // 一致（下面单列）。
  const retiredTagRe = new RegExp(`removed in\\s+${NEXT_BREAKING_VERSION.replace(/\./g, "\\.")}\\b`);
  for (const record of records) {
    const lines = record.text.split("\n");
    for (const block of jsdocBlocks(record.text)) {
      const tag = deprecatedTagText(block.text);
      if (!tag || !retiredTagRe.test(tag)) continue;
      const adjacent = adjacentDeclaration(lines, block.endLine);
      if (!adjacent.name || rows.has(adjacent.name)) continue;
      rows.set(adjacent.name, { def: record.rel, tag, retired: true });
    }
  }
  BUNDLE_TRUTH = { rows };
  return BUNDLE_TRUTH;
}

/** 0.30 破坏包的两份逐名表 ↔ 现算候选集（双向）、中英一致、迁移条款照抄标记、入口列现算。 */
function collectBundleTableErrors() {
  const out = [];
  const notes = [];
  const docs = BUNDLE_GUIDE_DOCS;
  const truth = bundleTruth();
  if (truth.failure) {
    out.push(`bundle-table: ${truth.failure}`);
    collectBundleTableErrors.notes = notes;
    return out;
  }
  const candidates = truth.rows;
  const missingFiles = docs.filter((rel) => !existsSync(path.join(ROOT, rel)));
  if (missingFiles.length) {
    out.push(`bundle-table: ${BUNDLE_GUIDE_VERSION} 破坏包的逐名表不见了：${missingFiles.join(" / ")}——`
      + `这份表是「${NEXT_BREAKING_VERSION} 删哪些名字」的唯一人读面（中英成对），删文件不算处置`);
    collectBundleTableErrors.notes = notes;
    return out;
  }
  if (!BUNDLE_GUIDE_VERSION.startsWith(`${NEXT_BREAKING_VERSION}.`)) {
    out.push(`bundle-table: 指南版本 ${BUNDLE_GUIDE_VERSION} 与唯一合法移除边界 \`NEXT_BREAKING_VERSION\`（${NEXT_BREAKING_VERSION}）`
      + `不是同一个 x.y——${NEXT_BREAKING_VERSION} 是唯一合法的移除边界，这一页必须绑在它上面`
      + "（改边界 = 同时改指南名与 scripts/bundle-guide-table.mjs 的 BUNDLE_GUIDE_VERSION）");
  }
  const entrySets = {
    root: entryExportNames("src/index.js"),
    tools: entryExportNames("src/tools/index.js"),
  };
  const parsed = new Map();
  for (const rel of docs) {
    const { rows, dupes } = bundleRowsOf(rel);
    parsed.set(rel, rows);
    for (const dupe of dupes) {
      out.push(`bundle-table: ${rel} 同一个名字有两行：${dupe}——逐名表一行一个名字，多出来那行不会被集合对账看见`);
    }
    if (candidates.size === 0) continue;   // 空集：本页转历史（见节头边界）
    for (const name of [...candidates.keys()].filter((n) => !rows.has(n))) {
      out.push(`bundle-table: ${rel} 缺 \`${name}\`——它是这一版破坏包里的名字`
        + "（现算候选，或源码里那条 `removed in " + NEXT_BREAKING_VERSION + "` 的退役标记），指南必须逐名列出；"
        + "少一行 = 这一页在说谎（名单由脚本派生，不许手抄）");
    }
    for (const name of [...rows.keys()].filter((n) => !candidates.has(n))) {
      out.push(`bundle-table: ${rel} 多出 \`${name}\`——它既不是现算候选、也没有一条 \`removed in ${NEXT_BREAKING_VERSION}\` 的退役标记`
        + "（要么这个名字没登记删除，要么它已经删干净、标记也一起没了）；"
        + "表里多一行同样是假话（#210 R2：空转的条目本身就是错）");
    }
    for (const [name, row] of rows) {
      const truthRow = candidates.get(name);
      if (!truthRow) continue;
      const clause = bundleClauseOf(truthRow.tag);
      if (clause === null) {
        out.push(`bundle-table: ${rel}:${row.line} \`${name}\` 的 \`@deprecated\` 标记里没有迁移条款`
          + "（`check:exports:deprecated` 的 R4 会红）——先修标记，再让这一页照抄");
      } else if (!row.clause.includes(clause)) {
        out.push(`bundle-table: ${rel}:${row.line} \`${name}\` 的迁移条款格没照抄标记里的那一条：`
          + `标记写的是「${clause}」，这一格写的是「${row.clause.slice(0, 90)}」——`
          + "指南不许另编一套说法（条款的唯一真值在那个名字的 `@deprecated` 标记里）");
      }
      const claimed = bundleEntryClaim(row.entry);
      if (claimed === null) {
        out.push(`bundle-table: ${rel}:${row.line} \`${name}\` 的入口列写法不认识：「${row.entry}」——`
          + "只接受 `.` / `./tools` / `.` + `./tools` 三种逐字写法");
        continue;
      }
      // 已退役（名字已经不在再导出块里）的行：入口列没有现读真值可对，只校中英一致（下面单列）。
      if (truthRow.retired) continue;
      for (const [key, set] of Object.entries(entrySets)) {
        if (claimed.has(key) === set.has(name)) continue;
        out.push(`bundle-table: ${rel}:${row.line} \`${name}\` 的入口列说它在 ${key === "root" ? "`.`" : "`./tools`"}，`
          + `但 ${key === "root" ? "src/index.js" : "src/tools/index.js"} 的再导出块里${set.has(name) ? "有" : "没有"}这个名字`
          + "——名字对了、住址错了，读者会去错的子路径找它");
      }
    }
  }
  const enRows = parsed.get(BUNDLE_GUIDE_EN) ?? new Map();
  const cnRows = parsed.get(BUNDLE_GUIDE_CN) ?? new Map();
  const enOnly = [...enRows.keys()].filter((name) => !cnRows.has(name));
  const cnOnly = [...cnRows.keys()].filter((name) => !enRows.has(name));
  if (enOnly.length || cnOnly.length) {
    out.push(`bundle-table: ${BUNDLE_GUIDE_EN} / ${BUNDLE_GUIDE_CN} 中英两份的名字集合不一致（只改一边不算改）：`
      + `${enOnly.length ? `EN 有 CN 没有：${enOnly.join(", ")}` : ""}${enOnly.length && cnOnly.length ? "；" : ""}`
      + `${cnOnly.length ? `CN 有 EN 没有：${cnOnly.join(", ")}` : ""}`);
  }
  for (const [name, en] of enRows) {
    const cn = cnRows.get(name);
    if (!cn || en.entry === cn.entry) continue;
    out.push(`bundle-table: ${BUNDLE_GUIDE_EN} / ${BUNDLE_GUIDE_CN} 里 \`${name}\` 的入口列中英不一致：EN「${en.entry}」vs CN「${cn.entry}」——`
      + "入口是事实，不是措辞，两侧必须逐字相同");
  }
  notes.push(`bundle-table: ${BUNDLE_GUIDE_VERSION} 破坏包逐名表 ${docs.length} 份对账现算候选集 ${candidates.size} 个名字`
    + `（其中已退役标记 ${[...candidates.values()].filter((row) => row.retired).length} 个——删空候选之后真值仍在源码标记里），`
    + `EN ${enRows.size} 行 / CN ${cnRows.size} 行；入口列现读 src/index.js（${entrySets.root.size} 个再导出名）/ `
    + `src/tools/index.js（${entrySets.tools.size} 个）`
    + (candidates.size === 0 ? "；候选集为空 ⇒ 本页已转历史，只校中英一致与行形状" : ""));
  collectBundleTableErrors.notes = notes;
  return out;
}

/** `--self-test` 的变异器：删掉某名字的整行（打不上就原样返回 ⇒ 自测的「变异没落上」判据会红）。 */
function dropBundleRow(name) {
  const rowRe = new RegExp("^\\|\\s*`" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "`\\s*\\|");
  return (text) => {
    const lines = text.split("\n");
    const kept = lines.filter((line) => !rowRe.test(line));
    return kept.length === lines.length ? text : kept.join("\n");
  };
}

/** `--self-test` 的变异器：在某一行前插一行（锚行找不到就原样返回）。 */
function insertBundleRow(anchorName, row) {
  const rowRe = new RegExp("^\\|\\s*`" + anchorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "`\\s*\\|");
  return (text) => {
    const lines = text.split("\n");
    const at = lines.findIndex((line) => rowRe.test(line));
    if (at < 0) return text;
    lines.splice(at, 0, row);
    return lines.join("\n");
  };
}

/**
 * `--self-test` 的变异器：把**唯一**一处 `needle` 换成 `replacement`。
 *
 * 为什么比裸 `String.replace` 严：裸 `replace` 只换第一处，靶子有第二份时探针照样「落上」——那
 * 就不是「这句谎」在被判，而是「恰好第一句」在被判。所以要求**恰好一处**：0 处（锚点没了）与
 * 2+ 处（靶子不唯一）都原样返回，由 harness 的「变异没落上」判据判红（#279 / #210 R2 惯例）。
 */
function replaceUnique(needle, replacement) {
  return (text) => {
    const parts = text.split(needle);
    return parts.length === 2 ? `${parts[0]}${replacement}${parts[1]}` : text;
  };
}

/**
 * `--self-test` 的变异器：把一句话**追加**到某份文档末尾，并在格内先证「这句话原本不在文档里」。
 *
 * 为什么追加也要自带断言（#210 R2）：`after !== before` 对 append **恒真**，harness 那条「变异没落上」
 * 的判据在这里是空转的——追加永远「落上」，哪怕追加的是一句文档里本来就有的老话；那种格证明不了
 * 「门禁怎么判这句陈述」，红了也可能是别的什么把它弄红的。所以两半都断言：追加前**恰好 0 次**、追加后
 * **恰好 1 次**；任一不成立就原样返回，由既有的「变异没落到 X 上」判据报红。
 */
function appendUnique(sentence) {
  return (text) => {
    if (text.split(sentence).length !== 1) return text;            // 已经出现 ⇒ 靶子不成立
    const after = `${text}${text.endsWith("\n") ? "" : "\n"}\n${sentence}\n`;
    return after.split(sentence).length === 2 ? after : text;      // 追加后必须恰好一次
  };
}

/**
 * `#668` 点名的**合法保留形态**就写在 `fold-summary-journal.js` 的注释里：一句「`fold-llm` 的降级兜底」
 * 自带历史限定语（`#661 之前` / `已被删`）。这一格**不抄原文**——现读那一行，读不到、或者历史限定语
 * 被删掉，都原样返回 ⇒ 自测按「变异没落上」报红。于是这格钉的永远是源码里那句真话，而不是本脚本里的
 * 一份抄件（#621 的教训：靶子跟着用例走，不跟着某句活文档走）。
 */
const JOURNAL_RETENTION_LINE = (() => {
  const line = read("src/compact/fold-summary-journal.js").split("\n").find((l) => l.includes("降级兜底"));
  return line === undefined ? null : line.trim();
})();

/** 本族自测用的一句「退役语义」谎。①-A 与 ② 用的是**同一句**：两格唯一的差别是它落在哪一类文件里。 */
const RETIRED_SEMANTICS_LIE = "摘要器失败或超时的时候，引擎会自动降级为统计摘要，run 照常完成。";

// ── 15. 版本归属句（issue #511 判据 1 后半）────────────────────────────────────
// 判据 1 后半：文中「<verB> adds / removes / 删掉 / 新增」类句式里的 `verB` 若 **≠ 自述版本**，
// 同一句必须带前向指针（`see the <verB> upgrade guide` / 「见 <verB> 升级指南」），否则红并点名行号。
//
// 本实现的一个**收窄**（写清理由，别当成漏做）：只咬 `verB > 自述版本` 这一侧（= 这句话在讲
// **后面那个版本**的事）。理由有三条：
//   · #511 的现场正是这一侧：0.27 指南（0.27.0 从未发布）整篇在讲 0.28 的树 —— 「前向指针」这个
//     词本身指的就是「这条事实属于后面那个版本，去读那一份」；
//   · 向后的错话（「0.26.0 删掉了 X」而其实是 0.28 删的）由判据 2 看守：删掉是**单调**的，今天的树
//     就是有效证人（树里还有 X ⇒ 那句话错），不需要指针；
//   · 0.11.0 / 0.12.0 这类早期版本**没有**对应的指南可指，强行要求「见 0.11.0 升级指南」等于让
//     门禁要求一个死链接。
const ATTRIBUTION_VERB_EN = String.raw`(?:adds|added|introduces|introduced|ships|shipped|removes|removed|retires|retired|deletes|deleted|renames|renamed|changes|changed|refuses|refused)`;
const ATTRIBUTION_VERB_CN = String.raw`(?:新增|加入|引入|加了|删掉|删了|删除|移除|退役|不再|改的|改成|变了|变化)`;
const ATTRIBUTION_AROUND = String.raw`(?:from|since|as of|自|从)`;
const ATTRIBUTION_RE = new RegExp(
  String.raw`(?<![\w.])(\d+\.\d+\.\d+)(?![\w.-])[^.;。；]{0,40}?(?:${ATTRIBUTION_VERB_EN}|${ATTRIBUTION_VERB_CN})`
  + String.raw`|(?:${ATTRIBUTION_VERB_EN}|${ATTRIBUTION_VERB_CN})[^.;。；]{0,40}?(?<![\w.])(\d+\.\d+\.\d+)(?![\w.-])`
  + String.raw`|(?:${ATTRIBUTION_AROUND})\s*(\d+\.\d+\.\d+)(?![\w.-])`,
  "g");

/** 把一行切成句子：英文句号/分号（后面跟空白）/ 中文句号、分号、问叹号（**中文标点后不带空格**，
 *  所以不能统一要求 `\s+`—— 第一版就是统一要求的，于是中文侧「…是 **9 个分组 / 43 个叶子**。基线是
 *  0.28.0 的七个分组…」永远切不开，整句因「点名了别的版本号」被跳过，中文侧的数量声称一条也没校到
 *  （#511 自测的中文用例当场红在「改了但没红」）。行内代码里的 `0.27.0` 不会被切开（`.` 后面跟的是
 *  数字，不是空白），所以「同一句」的判定不会因为版本号里的点而碎掉。 */
const SENTENCE_TAIL = String.raw`[*_\`）)\]]*`;   // 句末的 markdown 强调/括号/反引号收尾（`.**`、`）**`）
const sentencesOf = (line) => line.split(new RegExp(String.raw`(?<=[。！？；])${SENTENCE_TAIL}|(?<=[.!?;])${SENTENCE_TAIL}\s+`))
  .filter((s) => s.trim().length > 0);

/** 文档 → 句子流（`{ text, line }`）。**必须先合回逻辑块再切句**：markdown 是硬换行的，
 *  「同一句」经常横跨两行——第一版按行切，于是 0.27 指南里那句 `… (issue #498, from 0.28.0 —\n
 *  see the 0.28.0 upgrade guide) is …` 的指针落在下一行、被判成「没有指针」，而 0.29 指南里
 *  「**8 groups / 43 leaves**：0.28.0 的七个分组、41 个叶子…」被拆成两句、后半句凭空变成
 *  「当前树是 41 个叶子」（两处都是假红）。合并规则：不以块首标记（`#` / `*` / `-` / `>` / `|` /
 *  `1.`）开头的行，接进上一块。 */
function docSentences(lines) {
  const blocks = [];
  let buf = null;
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) { if (buf) { blocks.push(buf); buf = null; } return; }
    const startsBlock = /^\s*(?:#{1,6}\s|[*\-+]\s|>\s?|\||\d+\.\s)/.test(line);
    if (buf && !startsBlock) {
      buf.text += ` ${line.trim()}`;
      return;
    }
    if (buf) blocks.push(buf);
    buf = { text: line.trim(), line: i + 1 };
  });
  if (buf) blocks.push(buf);
  const out = [];
  for (const b of blocks) for (const text of sentencesOf(b.text)) out.push({ text, line: b.line });
  return out;
}

/** 前向指针：`see the <ver> upgrade guide` / 「见 <ver> 升级指南」。`upgrade`/「升级」可省
 *  （本仓 0.26.0 指南里就写着「退役细节见 0.27.0 指南」——同一个标记，别为了一个词改文档措辞）。 */
const forwardPointerRe = (version) => new RegExp(
  String.raw`(?:see the|见)\s*${version.replace(/\./g, "\\.")}\s*(?:(?:upgrade\s+)?guide|(?:升级)?指南)`);

function collectVersionAttributionErrors() {
  const out = [];
  const notes = [];
  let checked = 0;
  for (const rel of versionedGuideDocs()) {
    const docVersion = guideDocVersion(rel);
    if (!docVersion) continue;              // 缺自述：由判据 1 前半点名，这里不重复报
    const rec = fileRecord(rel);
    if (!rec) continue;
    for (const { text: sentence, line: lineNo } of docSentences(rec.lines)) {
        for (const m of sentence.matchAll(ATTRIBUTION_RE)) {
          const version = m[1] ?? m[2] ?? m[3];
          if (cmpSemver(version, docVersion) <= 0) continue;   // 向后引用不在本判据（理由见节头）
          checked += 1;
          if (forwardPointerRe(version).test(sentence)) continue;
          out.push(`version-attribution: ${rel}:${lineNo} 这句话把事实归给 ${version}（本文件自述 ${docVersion}），`
            + `但同一句里没有前向指针「see the ${version} upgrade guide」/「见 ${version} 升级指南」——`
            + `「这句话属于哪个版本」就是靠这个指针看守的（#511 判据 1）：${sentence.trim().slice(0, 110)}`);
        }
    }
  }
  notes.push(`version-attribution: 前向归属句 ${checked} 处逐句过（` + `向后引用与早期无指南版本按节头理由不入本判据）`);
  collectVersionAttributionErrors.notes = notes;
  return out;
}

// ── 16. 指南里的「树 / CHANGELOG」声称（issue #511 判据 2）───────────────────────
// 判据 2 的两半，各自的真值来源不同，理由也写在各自的分支里：
//   (a) **删除声称**（「没有 X 组」/「删掉了 X」+ 点名的 `config.*` 路径）⇒ 该路径必须确实不在
//       当前树里。删除是**单调**的，所以今天的树对任何版本的指南都是有效证人；
//   (b) **新增声称**（「X 是 0.27.0 加的」+ 点名的 `config.*` 路径）⇒ 该路径必须出现在 CHANGELOG
//       的**那一版**段落里。新增**不**单调（今天树里有 X 不能证明是 0.27 加的），所以真值只能从
//       CHANGELOG 取；而「未发布版本」的条目按本仓惯例并入下一个已发布段（0.27 草案 → 0.28 发布，
//       0.24 → 0.25 同理），所以取「V 到下一个已发布段」的并集；
//   (c) **数量声称**（「N 个分组 / N 个叶子」）只在**当前版本**的指南上校——只有那一份指南描述的是
//       我们手里这棵树；老指南的「七个组」是当时为真的历史，拿今天的 8 个组去判它是假红。
const CONFIG_NS_SRC = "src/loop/config-namespace.js";

/** 从 `CONFIG_NAMESPACE_SCHEMA` 抽真值：组名与每组的叶子名。抽不到返 null（抽不到真值就报错）。 */
function configNamespaceTruth() {
  const rec = fileRecord(CONFIG_NS_SRC);
  if (!rec) return null;
  const start = rec.text.indexOf("CONFIG_NAMESPACE_SCHEMA = Object.freeze({");
  if (start < 0) return null;
  const end = rec.text.indexOf("\n});", start);
  const block = rec.text.slice(start, end < 0 ? undefined : end);
  const groups = [];
  const leaves = new Map();
  for (const m of block.matchAll(/^ {2}([a-z][\w]*):\s*Object\.freeze\(\[([\s\S]*?)\]\),/gm)) {
    groups.push(m[1]);
    leaves.set(m[1], [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  }
  if (!groups.length) return null;
  return { groups, leaves, leafCount: [...leaves.values()].reduce((n, l) => n + l.length, 0) };
}

/** 某个 `config.*` 路径是否**真的**在树里。真值取 `CONFIG_NAMESPACE_SCHEMA`（组 / 叶子两张名单），
 *  **不拿「src 里出现过这个字符串」当判据**——第一版就是那么写的，当场假红：`config.observers` 在
 *  `src/loop/capabilities-namespace.js` 与 `src/loop/config-namespace.js` 的**注释里**各出现一次
 *  （解释「这一组整组删掉了」），于是「`config.observers` 不存在」这句真话被判成假话。
 *  这正是 #299 的同一条课：注释里的名字不是声明。返回 `true/false` = 判得了；`null` = 不适用。 */
function configPathExists(truth, dotted) {
  const parts = dotted.split(".");
  if (parts[0] !== "config") return null;
  if (parts.length === 2) return truth.groups.includes(parts[1]);
  if (parts.length === 3) return (truth.leaves.get(parts[1]) ?? []).includes(parts[2]);
  return null;                       // 更深的路径 schema 不描述 ⇒ 不判（note 里说明，不假装判得了）
}

/** CHANGELOG 的版本段（标题行 + 该段正文）。 */
function changelogSections() {
  const rec = fileRecord("CHANGELOG.md");
  if (!rec) return null;
  const out = [];
  rec.lines.forEach((line, i) => {
    const head = matchChangelogVersionHeading(line);
    if (!head) return;
    const dateMatch = CHANGELOG_DATED_HEADING_SUFFIX.exec(head.suffix);
    const dated = changelogHeadingIsDated(head.suffix);
    // `date`（issue #697）：段首的发布日期字面量，没有就是 null——日期判据（§17b）拿它当被对账的那一侧。
    out.push({ version: head.version, line: i + 1, heading: line.trim(), dated, date: dateMatch ? dateMatch[1] : null });
  });
  // 正文按「本段标题到下一个版本标题」切
  out.forEach((s, i) => {
    const from = rec.lines.findIndex((l) => l.trim() === s.heading);
    const next = out[i + 1] ? rec.lines.findIndex((l, j) => j > from && l.trim() === out[i + 1].heading) : rec.lines.length;
    s.body = rec.lines.slice(from, next < 0 ? rec.lines.length : next).join("\n");
  });
  return out;
}

const CN_NUMERAL_ONE = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const EN_NUMERAL_ONE = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** 句子里「N 个分组 / N 个叶子」这类数量声称（数字、英文数词、中文数词都接）。 */
function configCountClaims(sentence) {
  const claims = [];
  const groupRes = [
    /(\d+)\s+(?:config\s+)?groups?\b/gi,
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:config\s+)?groups?\b/gi,
    /(\d+)\s*个(?:配置)?(?:分组|组)/g,
    /([一二三四五六七八九十])\s*个(?:配置)?(?:分组|组)/g,
  ];
  const leafRes = [
    /(\d+)\s+(?:config\s+)?leaves\b/gi,
    /(\d+)\s*个(?:配置)?叶子/g,
  ];
  for (const re of groupRes) {
    re.lastIndex = 0;
    for (const m of sentence.matchAll(re)) {
      const n = CN_NUMERAL_ONE[m[1]] ?? EN_NUMERAL_ONE[String(m[1]).toLowerCase()] ?? Number(m[1]);
      if (Number.isFinite(n)) claims.push({ kind: "分组", value: n, raw: m[0] });
    }
  }
  for (const re of leafRes) {
    re.lastIndex = 0;
    for (const m of sentence.matchAll(re)) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) claims.push({ kind: "叶子", value: n, raw: m[0] });
    }
  }
  return claims;
}

/** (a) 删除声称：`no`/`没有`/`removed`/`删掉了` 后面紧跟的 `config.*` 路径。 */
const REMOVAL_CLAIM_RES = [
  /(?:\bno|\bNo|\bnot)\s+`(config\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`/g,
  /没有\s*`(config\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`/g,
  /\b(?:removed|retired|deleted|dropped)\s+`(config\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`/g,
  /(?:删掉|删了|删除|移除|退役)(?:了)?\s*`(config\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`/g,
];

function collectGuideClaimErrors() {
  const out = [];
  const notes = [];
  const truth = configNamespaceTruth();
  if (!truth) {
    out.push(`guide-claim: 从 ${CONFIG_NS_SRC} 抽不到 \`CONFIG_NAMESPACE_SCHEMA\` 的组/叶子真值——`
      + `抽不到真值就报错（#164 口径），判据 2 不许静默放行`);
    return out;
  }
  const sections = changelogSections();
  const byVersion = new Map((sections ?? []).map((s) => [s.version, s]));
  const reg = registryFacts();
  const publishedSet = reg.ok ? new Set(reg.versions) : null;
  const emit = (msg) => { (reg.ok && reg.authoritative ? out : warnings).push(reg.ok && reg.authoritative ? msg : `${msg}（registry 数据来自本地缓存/不可得，降级为告警）`); };

  let removalChecked = 0;
  let removalSkipped = 0;
  let additionChecked = 0;
  let countChecked = 0;
  let countSkipped = 0;
  for (const rel of versionedGuideDocs()) {
    const docVersion = guideDocVersion(rel);
    if (!docVersion) continue;
    const rec = fileRecord(rel);
    if (!rec) continue;
    for (const { text: sentence, line: lineNo } of docSentences(rec.lines)) {
        // (a) 删除声称：路径必须不在树里
        for (const re of REMOVAL_CLAIM_RES) {
          re.lastIndex = 0;
          for (const m of sentence.matchAll(re)) {
            const exists = configPathExists(truth, m[1]);
            if (exists === null) { removalSkipped += 1; continue; }
            removalChecked += 1;
            if (!exists) continue;
            out.push(`guide-claim: ${rel}:${lineNo} 声称 \`${m[1]}\` 不存在/已删，但它在当前树里确实存在——`
              + `「删掉了 X」是**单调**声称，今天的树就是有效证人（#511 判据 2a）：${sentence.trim().slice(0, 110)}`);
          }
        }
        // (b) 新增声称：路径必须出现在 CHANGELOG 的那一版（未发布段并入下一个已发布段）
        for (const m of sentence.matchAll(ATTRIBUTION_RE)) {
          const version = m[1] ?? m[2] ?? m[3];
          const paths = [...sentence.matchAll(/`(config\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)`/g)].map((x) => x[1]);
          if (!paths.length) continue;
          additionChecked += 1;
          const reach = changelogReach(version, byVersion, publishedSet);
          const body = reach.map((v) => byVersion.get(v)?.body ?? "").join("\n");
          if (!body) { emit(`guide-claim: ${rel}:${lineNo} 把 \`${paths[0]}\` 归给 ${version}，但 CHANGELOG 里找不到 ${version} 的版本段——真值缺位`); continue; }
          for (const p of paths) {
            if (body.includes(p)) continue;
            emit(`guide-claim: ${rel}:${lineNo} 声称 \`${p}\` 属于 ${version}，但它不在 CHANGELOG 的 ${reach.join(" / ")} 段里——`
              + `「X 是这一版加的」的真值只能从 CHANGELOG 取（#511 判据 2b）`);
          }
        }
        // (c) 数量声称：只校当前版本的指南
        if (cmpSemver(docVersion, PKG_VERSION) !== 0) { if (configCountClaims(sentence).length) countSkipped += 1; continue; }
        if (!/config/i.test(sentence)) continue;
        // 句子里点名了**别的**版本号 ⇒ 这是历史句（「0.28.0 的七个分组、41 个叶子」），不按今天的树判。
        // 没有这一条，当前版本指南里任何一句「上一版是 N 组」都会被判成假话（第一版就这么假红过）。
        if ([...sentence.matchAll(/(?<![\w.])(\d+\.\d+\.\d+)(?![\w.-])/g)].some((m) => m[1] !== PKG_VERSION)) continue;
        for (const claim of configCountClaims(sentence)) {
          countChecked += 1;
          const real = claim.kind === "分组" ? truth.groups.length : truth.leafCount;
          if (claim.value === real) continue;
          out.push(`guide-claim: ${rel}:${lineNo} 声称「${claim.raw}」，而 ${CONFIG_NS_SRC} 里是 **${real}** 个${claim.kind}`
            + `（${claim.kind === "分组" ? truth.groups.join(" / ") : `${truth.groups.length} 组共 ${truth.leafCount} 叶`}）——`
            + `当前版本的指南描述的就是这棵树，数量对不上就是「这句话属于另一个版本」（#511 判据 2c）`);
        }
    }
  }
  notes.push(`guide-claim: 删除声称 ${removalChecked} 处（路径逐条对 ${CONFIG_NS_SRC} 的组/叶子名单；`
    + `${removalSkipped} 处路径 schema 不描述 ⇒ 不判）、新增声称 ${additionChecked} 处（逐条对 CHANGELOG）、`
    + `数量声称 ${countChecked} 处（只校自述版本 == package.json 的那份指南；老指南的 ${countSkipped} 处数量声称按节头理由跳过：`
    + `它们描述的是当时的树，今天没有那棵树可对）`);
  collectGuideClaimErrors.notes = notes;
  return out;
}

/** 「V 这一版」在 CHANGELOG 里的可达段落：V 自己 + 它之后的第一个**已发布**段
 *  （未发布版本的条目按本仓惯例并入下一个已发布版本）。registry 不可得时只看 V 自己。 */
function changelogReach(version, byVersion, publishedSet) {
  const out = [version];
  if (!publishedSet || publishedSet.has(version)) return out;
  const after = [...byVersion.keys()].filter((v) => cmpSemver(v, version) > 0).sort(cmpSemver);
  for (const v of after) {
    if (publishedSet.has(v)) { out.push(v); break; }
  }
  return out;
}

// ── 17. CHANGELOG 版本段的发布态（issue #511 判据 3）────────────────────────────
// 判据 3：带日期的版本段（`## [X.Y.Z] - YYYY-MM-DD`）若**不在 registry**，必须在该段首行标注
// 「（未发布 / unpublished）」，否则红。口径参照本仓 0.24.0 先例（从未发布、不回填、保留为历史）。
// registry 取不到（离线 / 无缓存）⇒ 跳过并在输出里明说原因，**不判红**（与 `check:cli:model-e2e` 的
// 闸门分类同一口径：网络不可得不是文档漂移）。
const UNPUBLISHED_MARK_RE = /未发布|unpublished/i;

/** 该版本段自己声称「未发布」吗（看标题行，或正文前三行——本仓的写法是段首一句引用块）。
 *  抽成函数是因为**两条判据都要用它**：判据 3 自己，以及 `--self-test` 的 registry 夹具（见
 *  `selfTestRegistry`）—— 夹具的「已发布」口径必须与判据的「未发布」口径逐字同源。 */
function hasUnpublishedMark(s) {
  return UNPUBLISHED_MARK_RE.test(s.heading) || s.body.split("\n").slice(1, 4).some((l) => UNPUBLISHED_MARK_RE.test(l));
}

function collectChangelogPublicationErrors() {
  const out = [];
  const notes = [];
  const sections = changelogSections();
  if (!sections) { out.push("changelog-published: 读不到 CHANGELOG.md，发布态判据无从对账"); return out; }
  const reg = registryFacts();
  if (!reg.ok) {
    notes.push(`changelog-published: 跳过——${reg.why}（判据 3 在 registry 不可得时按约定跳过，不判红）`);
    collectChangelogPublicationErrors.notes = notes;
    return out;
  }
  const published = new Set(reg.versions);
  const emit = (msg) => (reg.authoritative ? out : warnings).push(reg.authoritative ? msg : `${msg}（registry 数据来自本地缓存，降级为告警）`);
  let dated = 0;
  let marked = 0;
  for (const s of sections) {
    if (!s.dated) continue;
    dated += 1;
    const hasMark = hasUnpublishedMark(s);
    if (published.has(s.version)) {
      if (UNPUBLISHED_MARK_RE.test(s.heading)) {
        emit(`changelog-published: CHANGELOG:${s.line} 的 ${s.version} 段自称「未发布/unpublished」，但它**在** registry 的 versions 列表里——`
          + `发布态写反了（判据 3 的两个方向都看守）`);
      }
      continue;
    }
    if (hasMark) { marked += 1; continue; }
    emit(`changelog-published: CHANGELOG:${s.line} 的 ${s.version} 段带日期却不在 registry 的 versions 列表里，`
      + `而段首没有「（未发布 / unpublished）」标注——已发布与未发布必须从段落本身看得出来（#511 判据 3；0.24.0 是先例口径）`);
  }
  notes.push(`changelog-published: 带日期的版本段 ${dated} 个，其中 ${marked} 个不在 registry 且已标注未发布（registry 来源：${reg.source}）`);
  collectChangelogPublicationErrors.notes = notes;
  return out;
}

// ── 17b. CHANGELOG 段首日期（issue #697）──────────────────────────────────────
// 病：`## [0.31.0] - 2026-11-10（未发布 / unpublished）`——没发布却写了发布日期，而判据 3 只看标记、
// 从不看日期。发布日期是「发布这件事」的产物，所以它有两半真理：
//   (a) **正在准备的那一段**（版本序最高的版本段）标了未发布就不许带日期。历史段不受此限：本仓有先例
//       （0.24.0 / 0.21.0 / 0.12.0 / 0.8.0 都是「带日期 + 正文标未发布」的历史记录），改它们等于改历史事实。
//   (b) **已发布段的日期必须与 tag 日期同一天**（UTC+8 本地日历日；附注 tag 取 tagger date，轻量 tag 取
//       所指提交的 author date）。不一致 ⇒ 红并点名两个日期。
// 为什么 (b) 的红是红、而「registry 说已发布但 tag 不存在」是 **exit 2 未判定**：`release:day` 的 writeback
//   先翻「已发布」标记（并写日期）、finalize 之后才打 tag。那一刻 registry 已经是新版本、tag 还没有——
//   若判成红，writeback 自己那次 `check:docs` 会把 writeback 判死（而它做的事正是本单要求的）。
//   「读不出真值」与「文档与真值打架」必须是两个退出码（与 #690 ③ / #575 同一口径）：这里给 `TAG_MISSING`。
// 为什么 `TAG_MISSING` 只咬 **registry 的 `latest`**：本仓已发布版本里只有少数有 tag（打 tag 是 0.14.0 之后
//   才零星开始的，具体数跑 `--verbose` / 看 notes），对每个已发布段都要求 tag ⇒ 这条闸会永久 exit 2（= 没有闸）。
//   被验证的「发布这件事」永远是 registry 说的 latest；更早的已发布段**有 tag 才判**（没有就记一笔跳过）。
// 历史不一致的登记表：两条（跨零点的发版作业）都是当时为真的事实，**不许为了绿去改历史**；条目空转即红（#210 R2）。
const CHANGELOG_DATE_TAG_EXEMPTIONS = [
  { version: "0.19.0", why: "tag v0.19.0 的 tagger date 是 2026-10-14 00:50（+0800），CHANGELOG 写 2026-10-13——发版作业跨了零点，两处都是当时为真的事实，不回填" },
  { version: "0.25.0", why: "tag v0.25.0 的 tagger date 是 2026-10-25 02:15（+0000 = UTC+8 10:15），CHANGELOG 写 2026-10-24——同上，跨零点的发版作业，不回填" },
];

/** 自测口子：临时替掉登记表（overlay 只改文本，改不动运行时数组）。 */
let SIM_DATE_TAG_EXEMPTIONS = null;
function dateTagExemptions() {
  return SIM_DATE_TAG_EXEMPTIONS ?? CHANGELOG_DATE_TAG_EXEMPTIONS;
}

/** epoch 秒 → UTC+8 本地日历日（本仓发版时区；tag 的 tagger/author 时间戳换成这一天）。 */
function utc8Day(epochSeconds) {
  return new Date((Number(epochSeconds) + 8 * 3600) * 1000).toISOString().slice(0, 10);
}
/** 今天（UTC+8 本地日历日）。`--sync` 的 `--published-date` 缺省值。 */
function todayUtc8() {
  return utc8Day(Math.floor(Date.now() / 1000));
}
/** 自测夹具用：日期字串 ±N 天（纯日历算术，不碰时区）。 */
function shiftDay(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

/** tag 面：`vX.Y.Z` → 发布日期（UTC+8 日历日）。一次进程只读一次。
 *  读不出（不是 git 仓 / git 不在 PATH 上）⇒ `{ok:false}`，判据降级为「不判」并说明原因——
 *  「干净检出」（`git archive | tar -x`，没有 `.git`）也必须能让 check:docs 绿，这是 #280 的口径。 */
function probeTagDates() {
  let raw;
  try {
    raw = execFileSync("git", ["-C", ROOT, "for-each-ref", "refs/tags",
      "--format=%(refname:short)%09%(objecttype)%09%(taggerdate:raw)%09%(authordate:raw)"],
    { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    return { ok: false, why: `\`git for-each-ref refs/tags\` 跑不起来（${/** @type {{code?: string}} */ (err)?.code ?? "unknown"}）`
      + "——不是 git 仓（干净检出）或 git 不在 PATH 上" };
  }
  const dates = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [ref, kind, tagger, author] = line.split("\t");
    const m = /^v(\d+\.\d+\.\d+)$/.exec(ref ?? "");
    if (!m) continue;
    const stamp = kind === "tag" ? tagger : author;
    const epoch = Number(String(stamp ?? "").split(" ")[0]);
    if (!Number.isFinite(epoch) || epoch <= 0) continue;
    dates.set(m[1], { date: utc8Day(epoch), kind: kind === "tag" ? "annotated" : "lightweight" });
  }
  return { ok: true, dates,
    source: "`git for-each-ref refs/tags`（附注 tag 取 tagger date，轻量 tag 取所指提交的 author date）" };
}

let SIM_TAG_FACTS = null;   // 自测口子：{ ok, dates: Map<version, {date, kind}>, source }
let TAG_FACTS = null;

/** tag 面事实（一次进程只读一次）。`--self-test` 走内存夹具。 */
function tagDateFacts() {
  if (SIM_TAG_FACTS) return SIM_TAG_FACTS;
  if (!TAG_FACTS) TAG_FACTS = probeTagDates();
  return TAG_FACTS;
}

/** `--self-test` 的 tag 面夹具（**只给自测用**：生产路径永远走 `probeTagDates()`）。
 *  从 CHANGELOG 派生：带日期且没标未发布的版本段 = 已发布，tag 日期**取段首那天**（= 一致）；
 *  登记在 `CHANGELOG_DATE_TAG_EXEMPTIONS` 里的版本故意错开一天（复现「历史段与 tag 不一致」这个真实形状，
 *  否则那两条登记会在自测里变成空转条目）。要证「门禁真读到了 tag 面」时用 `simulateTagFacts` 显式拨开。 */
function selfTestTagFacts() {
  const dates = new Map();
  const exempt = new Set(dateTagExemptions().map((e) => e.version));
  for (const s of changelogSections() ?? []) {
    if (!s.dated || hasUnpublishedMark(s)) continue;
    dates.set(s.version, { date: exempt.has(s.version) ? shiftDay(s.date, 1) : s.date, kind: "annotated" });
  }
  return { ok: true, dates,
    source: "self-test 夹具（CHANGELOG 派生；登记在 CHANGELOG_DATE_TAG_EXEMPTIONS 里的版本故意错开一天）" };
}

/** §17b 的判据本体。`out` = 红（exit 1）；`notJudged` = 未判定（`TAG_MISSING`，主路径 exit 2）。 */
function collectChangelogDateErrors() {
  const out = [];
  const notes = [];
  const notJudged = [];
  collectChangelogDateErrors.notes = notes;
  collectChangelogDateErrors.notJudged = notJudged;
  const sections = changelogSections();
  if (!sections) {
    out.push("changelog-date: 读不到 CHANGELOG.md，段首日期判据无从对账");
    return out;
  }
  const top = [...sections].sort((a, b) => cmpSemver(b.version, a.version))[0] ?? null;
  // (a) 正在准备的那一段：标了未发布就不许带日期（与 registry 可得与否无关——标记本身就是「没发布」的声称）
  if (top && top.dated && hasUnpublishedMark(top)) {
    out.push(`changelog-date: CHANGELOG:${top.line} 的 ${top.version} 段标了「未发布 / unpublished」却带着发布日期 ${top.date}——`
      + "发布日期是「发布这件事」的产物，段还没发布就不该有日期（issue #697 判据 1）。"
      + `合法形状：\`## [${top.version}]（未发布 / unpublished）\`；发布时由 \`docs-drift-check --sync\` 一次写成 \`## [${top.version}] - <发布日期>\``);
  }
  const reg = registryFacts();
  const facts = tagDateFacts();
  if (!reg.ok) {
    notes.push(`changelog-date: 已发布段 ↔ tag 日期这一半跳过——${reg.why}（没有 registry 就没有「哪些段已发布」这个真值）`);
    return out;
  }
  if (!facts.ok) {
    notes.push(`changelog-date: 已发布段 ↔ tag 日期这一半跳过——${facts.why}（读不出 tag 面 ≠ 日期写错了；干净检出没有 .git，按 #280 口径不判）`);
    return out;
  }
  const published = new Set(reg.versions);
  const exemptions = dateTagExemptions();
  let compared = 0;
  let noTag = 0;
  const exemptUsed = new Set();
  for (const s of sections) {
    if (!s.dated || !published.has(s.version)) continue;
    if (hasUnpublishedMark(s)) continue;   // 判据 3 已按「已发布却自称未发布」判红，这里不重复
    const tag = facts.dates.get(s.version) ?? null;
    if (!tag) {
      if (s.version === reg.latest) {
        notJudged.push({ code: "TAG_MISSING",
          message: `changelog-date: registry 说 ${s.version} 已发布（\`dist-tags.latest\`），但仓库里没有 tag v${s.version}——`
            + "日期无从对账（writeback 之后、finalize 之前正是这个状态；打完 tag 再跑这一条会自己对）" });
      } else {
        noTag += 1;
      }
      continue;
    }
    const mismatch = s.date !== tag.date;
    const exempt = exemptions.find((e) => e.version === s.version);
    if (mismatch && exempt) { exemptUsed.add(s.version); continue; }
    compared += 1;
    if (mismatch) {
      out.push(`changelog-date: CHANGELOG:${s.line} 的 ${s.version} 段写 ${s.date}，tag v${s.version} 是 ${tag.date}——`
        + "发布日期是「发布这件事」的产物，两边必须是同一天（UTC+8 本地日历日；附注 tag 取 tagger date，轻量 tag 取所指提交的 author date；issue #697 判据 2）");
    }
  }
  // 登记表空转即红（#210 R2）：条目对应的段不再「已发布 + 有 tag + 不一致」就说明这一条该删了。
  for (const e of exemptions) {
    if (exemptUsed.has(e.version)) continue;
    out.push(`changelog-date: CHANGELOG_DATE_TAG_EXEMPTIONS 里 ${e.version} 那一条是空转的（该段不再与 tag 不一致 / 已不在 registry / 没有 tag）——`
      + "登记表只装真实存在的不一致，修好一处就该删掉那条（#210 R2 口径）");
  }
  notes.push(`changelog-date: 已发布段日期 ↔ tag 日期对账 ${compared} 段（另 ${exemptUsed.size} 段按 CHANGELOG_DATE_TAG_EXEMPTIONS 登记为历史不一致、`
    + `${noTag} 段没有 tag ⇒ 不判；tag 面来源：${facts.source}）`);
  return out;
}

// ── 18. 发布行声称 vs registry（issue #511 评论）────────────────────────────────
// 盲区（#511 评论）：README 那句「当前发布行 = X」对 npm 世界可能是假话，而门禁看不见——它只保证
// 文档与本仓版本一致，**从不与 registry 对账**。两类句子必须可分辨，真相来源也不同：
//   · 「本仓当前版本」⇒ `package.json`；
//   · 「发布行 / 已发布 / latest」⇒ registry 的 `dist-tags.latest` 与 `versions` 列表。
// 另一条（#511 第二条评论补的）：这类句子若带一个**测量日期**，日期自己不会过期 ⇒ 光对账不够。
// 本实现选的是「**把测量日期从句子里去掉**，改成门禁当场对账的输出」，理由：
//   · 日期是第二份真值，它只能靠人回来改；而门禁每次运行都能当场读一次 registry —— 留日期等于
//     给「过期」留一个合法位置；
//   · 「日期早于最近一次发布就点名」需要一个可信的发布时间源（registry 的 `time` 字段），它比
//     `versions` 列表更容易缺（离线缓存里常常没有 `time`），判据会在最需要它的时候降级成跳过；
//   · 所以本判据干脆**禁止**这两句里出现日期/「实测」字样：句子只留可当场对账的字面量。
const OFFLINE = process.argv.includes("--offline");
const REGISTRY_PKG = "erix-agent";
let SIM_REGISTRY = null;        // 自测口子：{ ok, authoritative, latest, versions, source }
let REGISTRY_FACTS = null;

/**
 * issue #703：registry 事实的**探针注入** —— `--registry-json <file>`（同一口子也认 env
 * `ERIX_DOCS_REGISTRY_JSON`，便于子进程传）。为什么要有它：自测早就有内存夹具（`simulateRegistry`），
 * 但**生产裁决路径**的 registry 事实只能 `npm view` 现读 ⇒ 「0.31.0 已发布」这种**还没发生**的发布态在
 * 合成树上无法表达（真 registry 永远说 0.30.0），而 issue #703 要的 S2/S3 探针要证的正是这一半事实。
 * 口径：
 *   · 形状 `{"latest": "x.y.z", "versions": ["x.y.z", ...]}`，可选 `"authoritative": false`；
 *   · 读不出 / 解析不了 / 形状不对 ⇒ **当场 exit 2**（真值缺位永远不等于绿；静默降级会让「注入没落上」长成绿）；
 *   · 只在合成树探针里用：CI 的 `check:docs` / `check:docs:strict` 不带这个旗标 ⇒ 生产口径一字未变；
 *     `source` 里写明它是注入而不是实测，`--verbose` 的 notes 会原样打出来（探针拿它做「桩真的被读了」的证）。
 */
const REGISTRY_FIXTURE_PATH = flagValue(process.argv, "--registry-json")
  || process.env.ERIX_DOCS_REGISTRY_JSON || "";
const REGISTRY_FIXTURE = REGISTRY_FIXTURE_PATH ? loadRegistryFixture(REGISTRY_FIXTURE_PATH) : null;

/** 读一个 registry 桩（不在表上就当场 exit 2，不降级）。 */
function loadRegistryFixture(spec) {
  const abs = path.isAbsolute(spec) ? spec : path.join(ROOT, spec);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    console.error(`docs-drift-check: --registry-json ${abs} 读不出 / 解析不了（${/** @type {{message?: string}} */ (e)?.message}）`
      + "——注入的 registry 真值缺位，exit 2（不是跳过）");
    process.exit(2);
  }
  const latest = typeof parsed?.latest === "string" ? parsed.latest : null;
  const versions = Array.isArray(parsed?.versions)
    ? parsed.versions.filter((v) => typeof v === "string" && v.length > 0) : [];
  if (!latest || !versions.includes(latest) || !versions.length) {
    console.error(`docs-drift-check: --registry-json ${abs} 形状不对（要 {"latest": "x.y.z", "versions": [...]} 且 latest 必须在 versions 里）`
      + "——exit 2（不是跳过）");
    process.exit(2);
  }
  return { ok: true, authoritative: parsed.authoritative !== false, latest, versions,
    source: `--registry-json ${spec}（issue #703 探针注入，不是 npm registry 实测）` };
}

function probeRegistry() {
  const run = (extra) => execFileSync("npm",
    ["view", REGISTRY_PKG, "versions", "dist-tags", "--json", ...extra],
    { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
  const parse = (raw, source) => {
    const j = JSON.parse(raw);
    const versions = Array.isArray(j.versions) ? j.versions : [j.versions].filter(Boolean);
    const latest = j["dist-tags"]?.latest ?? null;
    if (!latest || !versions.length) return null;
    return { ok: true, latest, versions, source };
  };
  try {
    const live = parse(run([]), `npm view ${REGISTRY_PKG} versions dist-tags --json（联网）`);
    if (live) return { ...live, authoritative: true };
  } catch { /* 联网取不到：退到本地缓存 */ }
  try {
    const cached = parse(run(["--offline"]), `npm view ${REGISTRY_PKG} versions dist-tags --json --offline（本地缓存）`);
    if (cached) {
      return { ...cached, authoritative: false,
        why: "联网取 registry 失败，退回 npm 本地缓存——缓存可能落后于 registry，所以这条只告警不判红" };
    }
  } catch { /* 缓存也没有 */ }
  return { ok: false, why: "registry 取不到（联网 `npm view` 与 `npm view --offline` 都失败）" };
}

/** registry 事实（一次进程只读一次）。`--self-test` 走内存夹具，`--registry-json` 走探针桩，`--offline` 直接跳过。 */
function registryFacts() {
  if (SIM_REGISTRY) return SIM_REGISTRY;
  if (REGISTRY_FACTS) return REGISTRY_FACTS;
  REGISTRY_FACTS = REGISTRY_FIXTURE ?? (OFFLINE
    ? { ok: false, why: "`--offline`：本脚本在离线口径下不读 registry（缓存可能落后于 registry，把过期数据当真理会把「刚发布」判成红）" }
    : probeRegistry());
  return REGISTRY_FACTS;
}

/** `--self-test` 的 registry 夹具（**只给自测用**：生产路径永远走 `probeRegistry()`）。
 *  把「已发布」定义成 CHANGELOG 里**带日期且没标未发布**的版本段（`hasUnpublishedMark`，与判据 3 同源），
 *  `latest` 默认取那份名单里的**最高版本**（= 这一版从 CHANGELOG 能推出来的发布行）。
 *  为什么不是 `package.json` 的版本：切版（发版准备）那一刻两者**有意不同**——树内已经是 0.30.0，
 *  registry 还是 0.29.0（`## [0.30.0] - …（未发布 / unpublished）`）。拿 `PKG_VERSION` 当 latest 会让
 *  「AGENTS 的发布行句」在所有放行证里假红，而那句恰好是对的。派生自 `versions` 则两个事实同源。
 *  为什么从 CHANGELOG 派生、而不写死一份 registry 快照：写死的快照会在下一次真实发布那天过期，
 *  而过期那天**所有** registry 类用例会一起变红，没人分得清是真回归还是夹具陈了（#292 的教训：
 *  硬编码 121/164 一降基线就变成空操作）。派生版的唯一风险是「夹具与被测文档同源」——所以每条用例
 *  都用 `exclude` / `latest` 把**要证的那一个事实**拨到与文档不同的值上，证的是「门禁读到了它」。 */
function selfTestRegistry({ exclude = [], latest } = {}) {
  const versions = (changelogSections() ?? [])
    .filter((s) => s.dated && !hasUnpublishedMark(s))
    .map((s) => s.version)
    .filter((v) => !exclude.includes(v));
  const derivedLatest = [...versions].sort(cmpSemver).at(-1) ?? PKG_VERSION;
  return { ok: true, authoritative: true, latest: latest ?? derivedLatest, versions,
    source: "self-test 夹具（CHANGELOG 派生）" };
}

// ── `--self-test` 的**版本面**夹具（issue #724：版本面由自测自己合成）─────────────────────────
// 病根（#724 现场）：`#697` 那 8 例与 `#511 评论` 那 1 例把「要判的那一版」抄成了 **0.30.x 发版窗口**的
// 形状——`## [0.31.0]（未发布 / unpublished）` 段首、`## [0.30.0] - 2026-11-03` 段首、registry 桩钉着
// `latest: 0.30.0`、AGENTS 的「`dist-tags.latest` — is `0.30.0`」句。0.31.0 发布 + 回写之后这些字面量在
// 真面上**已不存在** ⇒ `replaceUnique` 打不中 ⇒ 每例都按 #210 R2 报「变异没落上（反向证自身失效）」；
// 伴随的「本该绿、实测 4 处红 `published-claim: AGENTS.md 说发布行是 0.31.0，registry 实测 0.30.0`」是同一个
// 成因的下游（桩钉着旧 latest，而文档已经回写成新 latest）。⇒ **每次发版都会重演一次**。
//
// 这与 #713（`scripts/version-state-probe.mjs`）同一味病：**把真值抄成一份快照，快照过期**。修法也同族：
// 版本面由夹具**合成**，真树只当模板。合成规则全部机械，一个版本字面量都不抄：
//   · `released` = 树里**带日期且没标未发布**的最高段（= registry 的 `latest`，也是 AGENTS 的发布行）；
//   · `previous` = 低于它的最高已发布段，且**不在** `CHANGELOG_DATE_TAG_EXEMPTIONS` 里
//     （否则「日期不一致」会被登记表放行，反向证空转）；
//   · `inflight` = 树里**高于 released 的未发布段**（发版窗口里它本来就在那儿）；没有就由 `released`
//     机械 +1 个次版本号。两种树因此收敛到**同一个形状**：在飞那一段的段首一律是规范未发布形
//     `## [X.Y.Z]（未发布 / unpublished）`（`renderVersionFace` 负责落上；没有那一段就开一段）。
//   · `historicalMarked` = 低于 released 的「带日期 + 标未发布」历史段（判据 (a) 只管正在准备的那一段）。
// ⇒ 变异体的锚点由**夹具自己写下**（`faceInflightHeading()`），于是「变异没落上」这一类红在结构上不可能
//   因为发版而复发：锚点不是抄来的字符串，而是本夹具这一轮刚写进 overlay 的那一行。
// registry 桩 / tag 面仍从 CHANGELOG 派生（`selfTestRegistry` / `selfTestTagFacts`），派生口径与判据同源：
// `inflight` 段没有日期 ⇒ 它自然不在 `versions` 里、`latest` 自然停在 `released` 上。
let SELF_TEST_VERSION_FACE = null;

/** 次版本号 +1（`0.31.0` → `0.32.0`）。合成「在飞的那一版」用，**不落在任何一棵真树上**。 */
function bumpMinor(version) {
  const [major, minor] = version.split(".").map(Number);
  return `${major}.${minor + 1}.0`;
}

/** `--self-test` 的版本面（见上面的节头）。派生一次，全自测共用同一份。
 *  @returns {{released: object, previous: object|null, inflight: object, historicalMarked: object|null}} */
function selfTestVersionFace() {
  if (SELF_TEST_VERSION_FACE) return SELF_TEST_VERSION_FACE;
  const sections = changelogSections() ?? [];
  const published = sections
    .filter((s) => s.dated && !hasUnpublishedMark(s))
    .sort((a, b) => cmpSemver(a.version, b.version));
  const released = published.at(-1);
  if (!released) {
    // 真值缺位就报错（#164 口径）：没有已发布段 ⇒ 没有「发布行」这个事实，夹具无从合成。
    throw new Error("docs-drift-check --self-test: CHANGELOG 里没有任何「带日期且没标未发布」的版本段 ⇒ "
      + "版本面夹具没有 released 这个基准（#724）");
  }
  const exempt = new Set(CHANGELOG_DATE_TAG_EXEMPTIONS.map((e) => e.version));
  const previous = published
    .filter((s) => cmpSemver(s.version, released.version) < 0 && !exempt.has(s.version))
    .at(-1) ?? null;
  const inflightExisting = sections
    .filter((s) => hasUnpublishedMark(s) && cmpSemver(s.version, released.version) > 0)
    .sort((a, b) => cmpSemver(b.version, a.version))[0] ?? null;
  const inflight = inflightExisting ?? { version: bumpMinor(released.version), date: null, heading: null };
  const historicalMarked = sections
    .filter((s) => s.dated && hasUnpublishedMark(s) && cmpSemver(s.version, released.version) < 0)
    .sort((a, b) => cmpSemver(b.version, a.version))[0] ?? null;
  SELF_TEST_VERSION_FACE = { released, previous, inflight, historicalMarked };
  return SELF_TEST_VERSION_FACE;
}

/** 在飞那一段的**规范未发布段首**（夹具自己写下的那一行 = 所有 #697 变异的锚点）。 */
const faceInflightHeading = () => `## [${selfTestVersionFace().inflight.version}]（未发布 / unpublished）`;
/** 本仓另一种**合法**无日期形状（⑤ 放行证用它：换一种合法写法仍绿）。 */
const faceInflightAltHeading = () => `## [${selfTestVersionFace().inflight.version}] — 截至本提交尚未发布`;

/** 自测变异器：把**某一段的段首整行**换成 `build(那一行)`（#724）。
 *  为什么按「段首行」定位而不是按整串 `replaceUnique`：版本号 + 日期这种字面量会出现在**散文**里
 *  （本单的 CHANGELOG 条目就引了那两个段首形状，实测当场把 `#697 ②` 的靶子变成两处 ⇒ 「变异没落上」）。
 *  行锚定（`^## [x.y.z]…$`）把靶子限定在「那一段的标题行」，散文里提到同一个版本号抢不走枪。
 *  找不到 / 不止一处都原样返回 ⇒ 由 harness 的「变异没落上」报红（#210 R2）。 */
const rewriteSectionHeading = (version, build) => (text) => {
  const hits = [...text.matchAll(new RegExp(`^## \\[${esc(version)}\\].*$`, "gmu"))];
  if (hits.length !== 1) return text;
  return text.replace(new RegExp(`^## \\[${esc(version)}\\].*$`, "mu"), (line) => build(line));
};

/** 把版本面落到 CHANGELOG 文本上（`simulateVersionFace` 的落点，见节头）：
 *  · 树里已有在飞那一段 ⇒ 只把**段首整行**改写成规范未发布形（其余字节一字不动）；
 *  · 没有那一段 ⇒ 在最高已发布段前**开一段**（合法无日期形 + 一句夹具自述，不描述任何代码事实）。
 *  已经是这个形状 ⇒ 原样返回（幂等：同一副版本面上重复落不会叠加）。 */
function renderVersionFace(text) {
  const face = selfTestVersionFace();
  const canonical = faceInflightHeading();
  if (face.inflight.heading) {
    return text.split(face.inflight.heading).length === 2
      ? text.replace(face.inflight.heading, canonical) : text;
  }
  const anchor = `## [${face.released.version}]`;
  if (text.split(`\n${anchor}`).length !== 2) return text;   // 锚行找不到 ⇒ 原样返回（由用例的「变异没落上」报红）
  const block = `${canonical}\n\n### Changed\n\n- 自测夹具合成的一节：在飞的那一版（issue #724 的版本面夹具，不描述任何代码事实）。\n\n`;
  return text.replace(`\n${anchor}`, `\n${block}${anchor}`);
}

/** 版本面的 tag 面（最小面：只给 `released` / `previous` 两段的 tag，日期取各自段首）。
 *  为什么不给全：多给就会把 `CHANGELOG_DATE_TAG_EXEMPTIONS` 那两条历史不一致卷进来，而本族用例都
 *  用 `simulateDateTagExemptions: []` 关掉登记表 ⇒ 那两条会变成「空转条目」红（#210 R2），与用例要证的事无关。 */
function faceTagFacts() {
  const face = selfTestVersionFace();
  const dates = new Map();
  for (const s of [face.released, face.previous]) {
    if (s) dates.set(s.version, { date: s.date, kind: "annotated" });
  }
  return { ok: true, dates, source: "self-test 夹具（版本面：released / previous 两段，日期取 CHANGELOG 段首）" };
}

/** 两份「当前版本」声称句的规范写法：见 §1 的 `VERSION_CLAIM_RULES`（`--sync` 读同一张表，别再抄一份）。 */

/** 发布行 / 未发布声称的扫描面：宿主会读的那批文档 + 指南 + 两份 README / 需求对照。
 *  **CHANGELOG 不在面内**：本仓对它的既定口径是「保留那一刻为真的历史」（裸行号棘轮同样把它排除在外），
 *  拿今天的 registry 去改历史条目等于伪造历史。 */
function publicationDocs() {
  return [...new Set([README_EN, README_CN, REQ_EN, REQ_CN, AGENTS_EN, AGENTS_CN,
    CONTRACT_EN, CONTRACT_CN, ...allGuideDocs()])];
}

function collectPublishedClaimErrors() {
  const out = [];
  const notes = [];
  const reg = registryFacts();
  const emit = (msg) => {
    if (reg.ok && reg.authoritative) out.push(msg);
    else warnings.push(`${msg}（registry 数据来自本地缓存/不可得，降级为告警）`);
  };
  // (1) 两份「当前版本」句：本仓版本对 package.json、发布行对 registry、且不许带测量日期
  for (const rule of VERSION_CLAIM_RULES) {
    const rec = fileRecord(rule.file);
    if (!rec) { out.push(`published-claim: ${rule.file} 读不到，${rule.label}无从核对`); continue; }
    const idx = rec.lines.findIndex((l) => rule.repoRe.test(l));
    if (idx < 0) {
      out.push(`published-claim: ${rule.file} 缺少「${rule.label}」（规范写法：本仓版本对 \`package.json\`、发布行对 \`dist-tags.latest\`，`
        + `两者都写成可对账的字面量；见 scripts/docs-drift-check.mjs 顶部注释）——检查面失效本身就是漂移`);
      continue;
    }
    const line = rec.lines[idx];
    const repo = line.match(rule.repoRe)[1];
    if (repo !== PKG_VERSION) {
      out.push(`published-claim: ${rule.file}:${idx + 1} 的「${rule.label}」把**本仓版本**写成 ${repo}，package.json 是 ${PKG_VERSION}`);
    }
    const pub = line.match(rule.pubRe);
    if (!pub) {
      out.push(`published-claim: ${rule.file}:${idx + 1} 的「${rule.label}」没有可对账的发布行字面量`
        + `（要求 \`dist-tags.latest\` 后面紧跟 \`X.Y.Z\`）——只写「本仓版本」的句子对 npm 世界是假话也无人看守（#511 评论）`);
    } else if (reg.ok) {
      if (pub[1] !== reg.latest) {
        emit(`published-claim: ${rule.file}:${idx + 1} 说发布行（\`dist-tags.latest\`）是 ${pub[1]}，registry 实测是 ${reg.latest}`);
      }
    }
    // 测量日期：这两句里不许有（理由见节头）
    for (const sentence of sentencesOf(line)) {
      if (!rule.repoRe.test(sentence) && !rule.pubRe.test(sentence)) continue;
      const date = sentence.match(/\d{4}-\d{2}-\d{2}/);
      if (date || /measured|实测/.test(sentence)) {
        out.push(`published-claim: ${rule.file}:${idx + 1} 的「${rule.label}」里带了测量日期/「实测」字样（${date ? date[0] : "measured/实测"}）——`
          + `日期自己不会过期，留着它就是给「过期」留一个合法位置；这两句改成门禁**当场对账**的字面量，日期删掉（#511 第二条评论）`);
      }
    }
    // 「未发布」声称与 registry 的方向由下面第 (2) 条全文扫描统一看守（按「版本号紧贴声称」的形状，
    // 不按整行：这一行里合法的「0.24.0 was never published」会让整行级判据假红——第一版就这么假红过）。
    notes.push(`published-claim: ${rule.file}:${idx + 1} 本仓版本 ${repo} == package.json`
      + (reg.ok ? `；发布行 ${pub?.[1] ?? "（缺）"} vs registry ${reg.latest}` : `；registry 未取到（${reg.why}）`));
  }
  // (2) 全文扫描：`dist-tags.latest` 后面紧跟的版本号必须 == registry latest；
  //     「从未发布 / never published」后面紧跟的版本号必须**不在** registry 的 versions 里。
  for (const rel of publicationDocs()) {
    const rec = fileRecord(rel);
    if (!rec) continue;
    rec.lines.forEach((line, i) => {
      for (const sentence of sentencesOf(line)) {
        // 标记**不要求**反引号：契约里那批句子写的是 `npm view erix-agent dist-tags.latest`（整段一个
        // 行内代码），第一版按「恰好是 `dist-tags.latest` 一个代码段」去匹配，于是 38 行过期值全被漏掉
        // ——漏的正是这条判据要咬的那批（#511 评论点名「当前发布行」这类句子）。
        for (const m of sentence.matchAll(/dist-tags\.latest[^.;。；]{0,40}?(\d+\.\d+\.\d+)/g)) {
          if (!reg.ok) continue;
          if (m[1] === reg.latest) continue;
          emit(`published-claim: ${rel}:${i + 1} 把 \`dist-tags.latest\` 写成 ${m[1]}，registry 实测 ${reg.latest}——`
            + `「发布行」的真相来源是 registry，不是 package.json 也不是记忆（#511 评论）`);
        }
        // 形状钉成「版本号在前、声称紧跟着它」（`0.27.0 was **never published**` / `0.27.0 从未发布`）。
        // 反过来那种（「从未发布，所以 0.28.0 是第一个…」）**不是**对 0.28.0 的声称——第一版实现按
        // 「前后 40 字内出现」扫，当场把契约里两句这种话误判成「说 0.28.0 / 0.26.0 从未发布」（假红）。
        for (const m of sentence.matchAll(/(\d+\.\d+\.\d+)[^.;。；]{0,12}?(?:never published|从未发布|unpublished)/g)) {
          const v = m[1];
          if (!reg.ok) continue;
          if (!reg.versions.includes(v)) continue;
          emit(`published-claim: ${rel}:${i + 1} 说 ${v} 从未发布，但它**在** registry 的 versions 列表里——`
            + `未发布声称必须对着 registry 的 versions 列表说（#511 判据 3 的同一条真理）`);
        }
      }
    });
  }
  collectPublishedClaimErrors.notes = notes;
  return out;
}

// ── 19. 指南覆盖度：从代码侧取名单，反向要求「该不该有一条」（issue #636）──────
// 病：门禁只问「已存在的条目是否成对」，从不问「该不该有一条」。0.29.0 的指南写好后，压缩/续接那一整块
// 是空白（`fold-llm` / `workingSetRecentRounds` / `foldedFacts` / `budget_below_working_set` /
// `compaction_deferred` 全 0 命中），而这一版恰恰是最影响宿主钱包的一版。同一类缺口第三次应验
// （CHANGELOG 的 `compaction_deferred`、契约的加法事件表、这次 0.29 指南），三次都靠人肉 review 才发现。
//
// 判据：**代码里有、且 CHANGELOG 说「这一版加的」名字，指南必须写到（中英各判一次）。**
//   · 名单从**代码侧**取（`config` 叶子表、`type: "…"` 的事件名、`process.env.X` 的读点、内置压缩策略名），
//     不取「文档里已经写了的那些」——拿文档当名单就是本单要防的那个循环；
//   · 「这一版加的」由 CHANGELOG 的**当前版本段**里「加法句」判定（`ADDITION_VERBS`）：CHANGELOG 是
//     「这一版改了什么」的既有登记处，它已经成对、已经有门禁；
//   · 只删一侧（例如只删中文那段的续接块）也红：两个语言版本各判一次，缺哪个点哪个。
// 为什么**不是**「代码里的每个名字都要进指南」：指南写的是宿主**要动手**的变更，不是全量 API 手册；把 43 个
// 叶子全塞进去等于让判据绑架文档形态（与 #210「不能机械化的写明为什么」同口径）。为什么**不是**「指南里的
// 名字要在代码里存在」：那个方向由 §11 符号锚点与 `paths` 看守。
const ADDITION_VERBS = /(?:\badds?\b|\badded\b|\bintroduces?\b|\bintroduced\b|\bships?\b|\bshipped\b|新增|加入|引入|加了|多一条|新的|新叶子|新事件)/i;
/** 「加法句」的**邻近距离**：名字必须出现在动词之后这么多字符内。没有它，一条长句里 200 字符开外的
 *  引用（实测：`shipped a runToolLoop quick start …` 那句里嵌着的报错文案 `… its canonical home is
 *  config.input.system`）会被当成「这一版加了 `config.input.system`」——而它其实是 0.28 就有的叶子。 */
const ADDITION_WINDOW = 200;

/** 句子里有没有「动词 + 紧跟着这个名字」的加法形状。 */
function addedNameHit(sentence, name) {
  for (const m of sentence.matchAll(new RegExp(ADDITION_VERBS.source, "gi"))) {
    const at = sentence.indexOf(name, m.index);
    if (at >= 0 && at - m.index <= ADDITION_WINDOW) return true;
  }
  return false;
}

/** 代码侧「宿主能看见的名字」清单。四张脸各有结构化真值，任何一张抽不到就返回 null（#164 口径：
 *  抽不到真值就报错，不许静默放行）。 */
function nameInventory() {
  const truth = configNamespaceTruth();
  if (!truth) return null;
  const names = new Map();                       // 名字 → { kind, proseSafe }
  const add = (name, kind, proseSafe) => names.set(name, { kind, proseSafe });
  for (const g of truth.groups) for (const leaf of truth.leaves.get(g) ?? []) add(`config.${g}.${leaf}`, "config 叶子", true);
  const orch = fileRecord("src/loop/orchestrator.js");
  if (!orch) return null;
  // 事件名取**发出去的那一侧**（`type: "…"` 赋值），不取 JSDoc 里的联合：注释不是声明（#299 的课）。
  // `proseSafe: false`：`text` / `usage` / `compaction` 这类短名在英文散文里到处都是，拿它们做「中英成对」
  // 会全是假红（实测：0.18/0.19/0.22/0.25/0.28 五份指南各被 `text` / `usage` / `compaction` 误报一次）。
  // 它们仍进「加法句覆盖」那一侧（CHANGELOG 说「这一版加的」，那一句里的引用不会撞散文）。
  for (const m of orch.text.matchAll(/\btype:\s*"([a-z][a-z0-9_]{2,})"/g)) add(m[1], "观察者事件", false);
  const strat = fileRecord("src/compact/strategy-resolution.js");
  if (!strat) return null;
  for (const n of truthStrategyNames(strat.text)) add(n, "压缩策略名", true);
  for (const rel of [...walk("src"), ...walk("bin")]) {
    if (!rel.endsWith(".js")) continue;
    const rec = fileRecord(rel);
    if (!rec) continue;
    for (const m of rec.text.matchAll(/process\.env\.([A-Z][A-Z0-9_]{3,})/g)) add(m[1], "环境变量", true);
  }
  return names;
}

/** 当前版本 CHANGELOG 段里的「加法句」点到的名字（按代码侧清单过滤）。抽不到段 ⇒ null。 */
function releaseAddedNames(inventory) {
  const sections = changelogSections();
  const sect = (sections ?? []).find((s) => s.version === PKG_VERSION);
  if (!sect) return null;
  const out = new Map();
  for (const { text: sentence } of docSentences(sect.body.split("\n"))) {
    if (!ADDITION_VERBS.test(sentence)) continue;
    for (const [name, { kind }] of inventory) if (addedNameHit(sentence, name)) out.set(name, kind);
  }
  return out;
}

/** 代码侧名字集的**下限**（只许涨不许降的探针，与 `REF_SCAN_DOCS_MINIMUM` / `SYMBOL_ANCHOR_MIN_UNIQUE` 同构）：
 *  低于它说明 `nameInventory()` 的抽取逻辑被削（config schema / 事件发点 / 策略名 / `process.env` 读点里
 *  有一张脸抽不出来了）——那时本节会「绿得理直气壮」。
 *
 *  **为什么量的是它、而不是「与本版段的交集 ≥ N」**（issue #699 ②）：旧下限（`GUIDE_COVERAGE_MIN_NAMES = 4`）
 *  量的是「本版 CHANGELOG 段的**加法句**点到几个名字」，于是**合法零新增版恒假**：0.31.0 是纯删除 + 勘误 +
 *  发版流程的一版，段里一个加法句都没有 ⇒ 判据在 0.31 上永远红（切版树实测 `check:docs` exit 1，红话就是
 *  「本版只判到 0 个名字（下限 4）」）。「这一版没有新增」是合法事实，不是抽取器坏了；抽取器坏不坏，
 *  问的是代码侧那张名单还抽不抽得出来（`inventory.size`），那是本常量看守的那一侧。
 *  现值 **92** 是 0.30.0 这棵树实测（config 叶子 + 观察者事件 + 压缩策略名 + 环境变量）：没有留余量是刻意的
 *  ——降它必须写理由，不能默默降。 */
const NAME_INVENTORY_MIN_NAMES = 92;

function collectGuideCoverageErrors() {
  const out = [];
  const notes = [];
  const inventory = nameInventory();
  if (!inventory || !inventory.size) {
    out.push("guide-coverage: 从代码侧抽不到「宿主能看见的名字」清单（config 叶子 / 观察者事件 / 压缩策略名 / 环境变量）——"
      + "抽不到真值就报错（#164 口径），覆盖度判据不许静默放行");
    return out;
  }
  const added = releaseAddedNames(inventory);
  if (!added) {
    out.push(`guide-coverage: 读不到 CHANGELOG 的 ${PKG_VERSION} 段——「这一版加了什么」的真值缺位，`
      + `覆盖度判据不许静默放行（要么补 CHANGELOG 段，要么改本判据的真值来源）`);
    return out;
  }
  const en = `docs/host-upgrade-guide-${PKG_VERSION}.md`;
  const cn = `docs/host-upgrade-guide-${PKG_VERSION}_cn.md`;
  const texts = new Map([[en, fileRecord(en)?.text ?? null], [cn, fileRecord(cn)?.text ?? null]]);
  for (const [rel, text] of texts) {
    if (text === null) out.push(`guide-coverage: 读不到 ${rel}——当前版本必须有一对指南，否则覆盖度无从判定`);
  }
  let checked = 0;
  for (const [name, kind] of added) {
    checked += 1;
    for (const [rel, text] of texts) {
      if (text === null || text.includes(name)) continue;
      out.push(`guide-coverage: ${rel} 没有提到${kind} \`${name}\`，而 CHANGELOG 的 ${PKG_VERSION} 段说它是这一版加的——`
        + `「该不该有一条」就是靠这条判据看守的（#636）：CHANGELOG 里登记过的新名字，指南必须有一条（中英各一份）`);
    }
  }
  if (inventory.size < NAME_INVENTORY_MIN_NAMES) {
    out.push(`guide-coverage: 从代码侧只抽到 ${inventory.size} 个名字（下限 ${NAME_INVENTORY_MIN_NAMES}）——`
      + "抽取逻辑被削了（config 叶子 / 观察者事件 / 压缩策略名 / 环境变量四张脸里有一张抽不出来），"
      + "这条判据正在空跑（抽不到真值就报错，别拿「没有要判的」换全绿；降下限要写理由，#699 ②）");
  }
  // (b) 中英成对：**结构化名字**（`config.*` 路径 / 压缩策略名 / 环境变量）在一份指南里出现，就必须在
  //     它的另一语言版本里也出现。这一侧回答的是同一句「该不该有一条」，但问在**两份**之间：某一段只
  //     写了一种语言（或者被整块删掉一侧）时，覆盖度判据不会自己发现——中英成对会。逐份指南都判，
  //     不只判当前版本：历史指南的「那一刻为真」也要两边一致。
  //     只拿 `proseSafe` 的名字做这一侧：`text` / `usage` / `compaction` 这类短事件名与英文散文撞车，
  //     拿它们判成对会全是假红（实测五份指南各误报一次）。
  let parityPairs = 0;
  let parityChecked = 0;
  for (const rel of versionedGuideDocs()) {
    if (rel.endsWith("_cn.md")) continue;
    const cnRel = rel.replace(/\.md$/, "_cn.md");
    const enRec = fileRecord(rel);
    const cnRec = fileRecord(cnRel);
    if (!enRec || !cnRec) continue;             // 只有单语的老指南（0.6/0.12/0.14…）：没有配对可判
    parityPairs += 1;
    for (const [name, { kind, proseSafe }] of inventory) {
      if (!proseSafe) continue;
      const inEn = enRec.text.includes(name);
      const inCn = cnRec.text.includes(name);
      if (inEn === inCn) continue;
      parityChecked += 1;
      const missing = inEn ? cnRel : rel;
      out.push(`guide-coverage: ${missing} 没有提到${kind} \`${name}\`，而同一份指南的另一语言版本提到了——`
        + `中英成对是「该不该有一条」的另一半：只写一侧等于另一侧缺一条（#636）`);
    }
  }
  if (parityChecked === 0 && parityPairs === 0) {
    out.push("guide-coverage: 一份「有中英两版」的升级指南都没找到——成对判据在空跑（抽不到真值就报错）");
  }
  notes.push(`guide-coverage: 代码侧清单 ${inventory.size} 个名字，其中 CHANGELOG ${PKG_VERSION} 段的加法句点到 ${checked} 个，`
    + `逐条要求中英两份指南都提到；另有 ${parityPairs} 对指南按结构化名字做中英成对（${parityChecked} 处不对称）`);
  if (checked === 0) {
    // 合法零新增版：本版段里没有「加法句」点到代码侧名字（纯删除 / 勘误 / 发版流程版就是这种）。
    // 这一条只打印、不判红——健康与否由上面 `NAME_INVENTORY_MIN_NAMES` 看守（#699 ②）。
    notes.push(`guide-coverage: CHANGELOG ${PKG_VERSION} 段没有加法句点到代码侧名字 ⇒ 本版是零新增版，`
      + "「该不该有一条」这一半无可判项（不是抽取器坏了：代码侧清单仍然抽到 " + inventory.size + " 个名字）");
  }
  collectGuideCoverageErrors.notes = notes;
  return out;
}

// ── 20. 「不变」声明 × 本版 CHANGELOG 的字段真值（issue #690）────────────────────
// 病：升级指南里「以下东西不变」那一节是**假话**。0.30 指南的 §4 明写「观察者事件、诊断字段与 run-state
// 块」以及「transcript 与 run-state 的磁盘格式」不变，而**同一版 CHANGELOG** 记着 `degradeKind` /
// `degradeReason` 不再有写者、`budgetExhausted` 搬到 `details.`、`record.foldedFacts.text` 不再含任务
// 原文、失败终局改走 `exitCodeForRunFailure` 的独立退出码。这些名字在指南里 0 命中，而所有门禁一路绿。
//
// 与相邻闸的分工（**别合并成一条模糊判据**）：
//   · #687 管「指南称**已删** ↔ 运行时导出」——问的是「这个名字还在不在」；
//   · 本条管「指南称**不变** ↔ 本版真值」——问的是「这一版的字段到底动没动」；
//   · `check:docs` 既有的 `defaults` / `files` / `exports` / 符号锚点 / 裸行号棘轮是「文档字面量 ↔
//     源码字面量」，各自独立，本条一个字都不动它们。
//
// 判据（两个方向都看守）：
//   ① **正向**：本版 CHANGELOG 段里被声明**变更**（不是纯加法）的字段名，落到六格里的哪一格，指南那一格
//      就**不许**写「不变」；红时点名 `文件:行 + 字段名 + 格名`。
//   ② **反向**：本版没有任何变更证据的格子，指南写「不变」保持绿——不许逼文档为无变更的版本造条目。
//   ③ **读不出 = 红（exit 2）**：找不到那一节 / 读不到本版 CHANGELOG 段 / 段里有反引号字段名而解析结果
//      为空 ⇒ 真值缺位。读不出永远不等于绿。
//   ④ **中英各自判**：两份指南各跑一遍（变更真值同源），于是「一侧被整句删掉」红在**缺那一侧**。
//
// 六格的成员判据**从源码现算**，不抄名单（抄名单正是 #429 修过的漂移路径：名单会与代码各自腐烂）：
//   · 观察者事件 = 本版段里以 `type: "…"` / 引号字面量写出来、且 `src/loop/orchestrator.js` 确实发得出去的事件名；
//   · 选项       = `CONFIG_NAMESPACE_SCHEMA` 的叶子路径与叶子名 + `bin/cli.js` 的旗标与 slot 键；
//   · 默认值     = `bin/config.js` 里 `DEFAULT_*` 这类「某个选项的缺省值」常量；
//   · 诊断字段   = `createCompactionStat` 造出来的 `compactionStats` 条目形状的键（含 `foldSummary` 子键）；
//   · 磁盘格式   = `fold-summary-journal.js` 声明的轮记录字段 + `buildFoldedFacts({…})` 这个折叠记录字面量的键；
//   · 终局载荷   = `makeResult` 的返回键 + `termination` 的键 + `bin/cli.js` 的退出码符号。
//
// 「被声明变更」的判据也写在脚本里（不靠人读）：
//   · 只有**变更形状**（`no longer` / `moves to` / `instead of` / 改名 / 删掉 / 搬到 / `→` …）才算证据；
//   · **纯加法**（`adds` / `新增` / `纯加法`）不算——「既有面不变」与「多了一个新叶子」不是同一句话，
//     加法由 §4.1 与 `guide-coverage` 那一侧看守（否则「这一版新增了一个叶子」会把「既有叶子不变」判成假话）；
//   · 条目自带「只做展示层 / 不改任何引擎事实」限定语的**不算**引擎面变更证据（0.30 的 `judge.log` 那一条
//     正是这种：事件名与载荷都没动，动的是打印到哪里）。
//
// 为什么指南一侧按「格」判而不是按整节判：整节一句「以上都不变」对读者是承诺，对门禁是一团糊——判据要能
// 点名「哪一格、哪个字段」。所以每格单独取声明：同一格里**没有**「这一版变了」那句固定话术的，就按「不变」算。
const SURFACE_SECTION_HEADING = Object.freeze({
  en: /^##\s*\d+\.\s*What does not change\b/u,
  cn: /^##\s*\d+\.\s*没有变的东西/u,
});

/** 每格一句「这一格变了」的固定话术（指南侧唯一的变更标记；红/绿只看它在不在这一格里）。 */
const SURFACE_CHANGED_MARK = Object.freeze({
  en: /changed in this release|changes in this release|changed this release/iu,
  cn: /这一版变了|本版变了|这一版改了|本版改了/u,
});

/** 字段名形状：标识符，可带点分路径与 `[]` 后缀（`compactionStats[].strategyName` / `config.a.b`）。 */
const SURFACE_NAME_SHAPE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\[\])?$/u;

/** 变更形状（**证据**）：只认「既有字段被改/搬/删/改名」，不认「新增」。 */
const SURFACE_CHANGE_SHAPES = new RegExp(String.raw`\bno longer\b|\bmoves? to\b|\bmoved to\b|\binstead of\b`
  + String.raw`|\brenamed?\b|\brenames\b|\bremoves?\b|\bremoved\b|\bretires?\b|\bretired\b|\bdeletes?\b|\bdeleted\b`
  + String.raw`|\breplaces?\b|\breplaced\b|\bstops?\b|\bstopped\b|\bchanged?\b|\bchanges\b|→|->`
  + String.raw`|不再|搬到|移入|改成|改为|删掉|删除|移除|退役|改名|变了`, "u");

/** 加法形状：**不算**变更证据（理由见节头）。 */
const SURFACE_ADDITIVE_SHAPES = /\badds?\b|\badded\b|\bnew\b|\badditive\b|新增|加入|引入|纯加法/iu;

/** 条目级限定语：只动展示层 / 不改引擎事实 ⇒ 这一条里的名字不是引擎面变更的证人。 */
const SURFACE_DISPLAY_ONLY = /\bdisplay layer only\b|\bno engine fact changes?\b|\bno engine change\b|\bvisibility only\b|\bdocumentation only\b|\bno behaviour change\b|\bno behavior change\b|只做展示层|只做可见性|不改任何引擎事实|纯文档|零行为变更/iu;

/** 本版那一对指南（判据的扫描面与自测的靶子同源，不写第二份文件名）。 */
const SURFACE_GUIDE_EN = `docs/host-upgrade-guide-${PKG_VERSION}.md`;
const SURFACE_GUIDE_CN = `docs/host-upgrade-guide-${PKG_VERSION}_cn.md`;

// ── 自测期望里「当前版」的真值面（issue #699 ③）───────────────────────────────
/** 把一份路径变成可嵌进 `new RegExp` 的字面量（`docs/host-upgrade-guide-0.30.0.md` 里的点必须转义）。 */
const rePath = (rel) => String(rel).replace(/[.*+?^${}()|()[\]\\]/g, "\\$&");
/** **当前版指南的路径在自测期望里必须现读**（#699 ③）。把 `0.30.0` 抄进期望正则，切版当天就是
 *  「判据点对 0.31 那份指南，期望还在要 0.30 那份」⇒ 整族反向证在切版树上集体红（合成 0.31 树实测 6 例：
 *  #690 读不出 ①② 与 #511 判据 2c 中英两条）。生产判据一侧本来就是动态的（上面 `SURFACE_GUIDE_EN/CN`），
 *  这里只是把**期望**拉回同一个真值：`judge` 是红话前缀的判据 id，`tail` 是路径之后那段**正则字面量**
 *  （传字面量而不是字符串：省掉「字符串里再转义一层」这个坑，`.source` 原样接上）。
 *  **历史夹具不在此列**（0.27 / 0.29 的指南、0.31 破坏包那份逐名表：钉的是历史文档，切版不改那条事实）。 */
const guideExpectRe = (judge, rel, tail) => Object.assign(
  new RegExp(`${esc(judge)}: ${rePath(rel)}${tail.source}`, "u"),
  // 打上「路径来自真值」的标记，供 runSelfTest 的静态校查认（见那里的 #699 ③ 那一刀）。
  { pinnedToTruthPath: true });
/** 自测变异器：把**本版**那条 CHANGELOG 段首整行交给 `build(那一行)` 重写（#699 ③：不再抄死 `## [0.30.0] - 2026-11-03`
 *  这一行——它随版本走，切版后抄的那一行不在盘上，变异等于没落上）。 */
const rewriteCurrentChangelogHeading = (build) => (text) =>
  text.replace(new RegExp(`^## \\[${esc(PKG_VERSION)}\\].*$`, "mu"), (line) => build(line));
/** 自测变异器：改 AGENTS 两句里的**本仓版本**（`VERSION_CLAIM_RULES` 的 repoRe 就是判据读的同一形状），
 *  与上一条同理：`says \`0.30.0\`` 这种字面量在切版后的树上不存在。 */
const mutateRepoVersionClaim = (to) => (text) =>
  text.replace(VERSION_CLAIM_RULES[0].repoRe, `Current version: \`package.json\` says \`${to}\``);
/** 自测变异器：改 AGENTS 的**发布行**句（`VERSION_CLAIM_RULES` 的 `pubRe` 就是判据读的同一形状）。
 *  #724：不再抄 `` `dist-tags.latest` — is `0.30.0` `` 这个字面量——它随发版回写而变，抄它等于把反向证
 *  钉在某一个发版窗口上（0.31.0 回写后那个字串在真面上就不存在了）。改成「判据自己的正则 + 唯一性」：
 *  0 处（形状变了）与 2+ 处（靶子不唯一）都原样返回，由 harness 的「变异没落上」报红。 */
const mutatePublishedClaim = (to, lang = 0) => (text) => {
  const rule = VERSION_CLAIM_RULES[lang];
  const hits = [...text.matchAll(new RegExp(rule.pubRe.source, "g"))];
  if (hits.length !== 1) return text;
  return text.replace(rule.pubRe, (whole, current) => {
    const at = whole.indexOf(current);
    return `${whole.slice(0, at)}${to}${whole.slice(at + current.length)}`;
  });
};
const addMeasurementDateToRepoClaim = (date) => (text) =>
  text.replace(VERSION_CLAIM_RULES[0].repoRe, (whole) => `${whole}, measured ${date}`);

// ── #690 那一族的「两半前提自己带上」（issue #699 ③ (a)）───────────────────────
/**
 * 这一族考的是「**当前版指南 §4** × **本版 CHANGELOG**」这一条对账，两半前提都得成立：
 *   ① 本版段里有这一格的**字段级变更证据**（`declaredSurfaceChanges`）；
 *   ② 当前版 §4 里**有这一格可定位的声明**（`surfaceClaimBlocks`，规范形状是六格 bullet）。
 * 0.30 两半都是现成的（加法版 + 六格 bullet）。**0.31 是纯删除版**：段里 70 处反引号全是退役导出名
 * （按定义不属于六格 ⇒ ① 是空的），§4 也只有一段散文（⇒ ② 没有按格的行）。于是「只变异指南侧」的
 * 老写法在两棵树上表现不同：0.30 树上落得上、0.31 树上锚点找不到 ⇒ **用例静默失效**（#210 R2 那一类）。
 * 合成 0.31 树上这 7 例全部报「变异没落到」，就是这个洞在报信（`/tmp/b699/cutB-selftest-final.log`）。
 *
 * 所以这一族的**前提由夹具自己带上**，名字一律从真值现取（`cell.truth()` 与本版段），不抄 0.30 的原话：
 *   · `surfaceCaseEvidence(cellId)` —— 这一格这一例的**证据名字**：本版段里已有该格证据就用它自己的
 *     （0.30 是这种，红话与改前逐字相同）；没有就从该格真值里取一个真实成员，并回报「要注入」。
 *   · `addSurfaceEvidence(cellId)` —— 把那条证据注进本版段（只在上一行说「要注入」时才带上）。
 *   · `putSurfaceBullet(lang, cellId, body)` —— 把这一格在 §4 里的声明**换成 `body`**；那一格本来没有
 *     bullet（0.31 的散文形状）就在 §4 节首**补一条**（`surfaceClaimBlocks` 是「第一处声明为准」，
 *     补在节尾会被原有散文抢先声明）。§4 整节找不到 ⇒ 原样返回 ⇒ 框架照旧报「变异没落上」。
 *   · `writeSurfaceCells(lang, omitCellId)` —— 把 §4 正文写成**规范六格 bullet**（`omit` 那一格不写），
 *     用来考「整格缺席」：缺席必须是「这一格被删」，不能是「整节本来就没有按格的形状」。
 * **历史夹具不跟着漂**：0.29 / 0.27 指南那些用例钉的是历史文档，`SURFACE_GUIDE_*` 也不该套到它们身上。
 */
const SURFACE_CASE_PREFERRED = Object.freeze({
  diagnostics: "degradeKind", disk: "record.foldedFacts.text", finalPayload: "exitCodeForRunFailure",
});
const SURFACE_CASE_EVIDENCE = new Map();

/** 某一格在自测里的证据名字与「要不要注入证据」（见上面的节头；同一格只算一次）。 */
function surfaceCaseEvidence(cellId) {
  if (SURFACE_CASE_EVIDENCE.has(cellId)) return SURFACE_CASE_EVIDENCE.get(cellId);
  const truths = surfaceTruthMap();
  const declared = declaredSurfaceChanges(PKG_VERSION, truths);
  const own = [...(declared?.byCell.get(cellId) ?? [])].sort();
  const preferred = SURFACE_CASE_PREFERRED[cellId];
  // **名字必须被判据自己归回这一格**：真值成员里有相当一部分名字同时属于几格，而 `surfaceCellOf`
  // 是按 `SURFACE_CELLS` 的顺序**先命中的那格赢**（诊断字段在磁盘格式前面）。不反查就会注进一条
  // 「归属于别的格」的证人：0.31 探针树上实测抽到 `degradeReason`（它同时是折叠账本的记录字段与诊断
  // 字段）⇒ 注入后红的是「diagnostic fields 格写着不变」，而用例要的是「on-disk formats」（#703）。
  // `quoted: true` 与注入句里的反引号同口径（否则事件格那一格会被当散文）。
  const attributed = (name) => surfaceCellOf(name, { quoted: true, truths })?.id === cellId;
  const members = [...(truths.get(cellId) ?? [])].filter(attributed).sort();
  const out = own.length
    ? { name: own.includes(preferred) ? preferred : own[0], inject: false, source: `本版 CHANGELOG ${PKG_VERSION} 段里该格已有的证据` }
    : members.length
      ? { name: members.includes(preferred) ? preferred : members[0], inject: true,
        source: "本版段对这一格没有变更证据 ⇒ 证据由夹具从该格真值注入（只取判据会归回本格的成员）" }
      // 真值抽不出（提取器坏了）：让「抽不到成员真值」那条红自己去红，这里不另造名字。
      : { name: preferred ?? cellId, inject: false, source: "该格真值抽不出（或一个都不归本格 ⇒ 归属提取器飘了）" };
  SURFACE_CASE_EVIDENCE.set(cellId, out);
  return out;
}

/** 往本版段里注入一条「这一格在本版变了」的证据。**句式的三个形状都是判据定的**：落在
 *  `SURFACE_CHANGE_SHAPES`（`changed`）里、**不**落进 `SURFACE_ADDITIVE_SHAPES`（否则 `guide-coverage`
 *  会多要一条指南覆盖）、**不**落进 `SURFACE_DISPLAY_ONLY`（展示层句子里的名字不是变更证人）。 */
const addSurfaceEvidence = (cellId) => (text) => {
  const { name } = surfaceCaseEvidence(cellId);
  const line = `- Self-test premise (#699 ③): the \`${name}\` field changed in this release`
    + ` —— this line is the fixture's own witness for the \`${cellId}\` cell.`;
  // `\\[` / `\\]` 不能写成 `\[` / `\]`：模板字面量里那对反斜杠会被 JS 吃掉，正则变成
  // `^## [0\.31\.0].*$` = **字符类**（只认 `0 . 3 1` 五个字符之一），段首 `## [` 的方括号永远匹配不上
  // ⇒ 变异不落上。0.30 树上这一族 `inject=false`（本版段里已有该格证据），这个笔误被藏了一整版；
  // 0.31 是纯删除版（段里 70 处反引号全是退役导出名）⇒ `inject=true` ⇒ 五例同时报「变异没落到 CHANGELOG.md 上」。
  // 同一文件的 `rewriteCurrentChangelogHeading` / `addGuideCoverageClaim` 用的都是 `\\[`，只有这里是漏的（issue #703）。
  const head = new RegExp(`^## \\[${esc(PKG_VERSION)}\\].*$`, "mu");
  return head.test(text) ? text.replace(head, (h) => `${h}\n\n${line}`) : text;
};

/** §4 那一节的行范围（`{head, end}`，与判据的 `unchangedSurfaceSection` 同一个断法：到下一个 `##`/`###` 为止）。 */
function surfaceSectionSpan(lines, lang) {
  const head = lines.findIndex((l) => SURFACE_SECTION_HEADING[lang].test(l.trim()));
  if (head < 0) return null;
  let end = head + 1;
  while (end < lines.length && !/^#{2,3}\s/u.test(lines[end])) end += 1;
  return { head, end };
}

/** 规范 bullet 的正文（changed + 点名一个该格的证据名字）：`writeSurfaceCells` 用它把「不是被测格」的
 *  五格写成**自洽**的形状，于是红只从被测那一格来（#210 的「红只从被变异的地方来」）。 */
function surfaceCanonicalBullet(lang, cell) {
  const ev = surfaceCaseEvidence(cell.id);
  const declared = declaredSurfaceChanges(PKG_VERSION, surfaceTruthMap());
  const own = [...(declared?.byCell.get(cell.id) ?? [])].sort();
  const name = own[0] ?? ev.name;
  return lang === "en"
    ? `${SURFACE_BULLET.en[cell.id]} changed in this release.** \`${name}\` is named here;`
      + " this cell is not the subject of this case."
    : `${SURFACE_BULLET.cn[cell.id]}这一版变了。** 这里点名 \`${name}\`；这一格不是本例的被测格。`;
}

/** 六格真值的 Map（判据里那份的同款构造；自测夹具用它挑名字）。 */
function surfaceTruthMap() {
  const truths = new Map();
  for (const cell of SURFACE_CELLS) {
    const t = cell.truth();
    if (t) truths.set(cell.id, t);
  }
  return truths;
}

/** 把某一格在 §4 里的声明换成 `body`；那一格没有 bullet 时补在**节首**（见节头）。 */
function putSurfaceBullet(lang, cellId, body) {
  return (text) => {
    const lines = text.split("\n");
    const prefix = SURFACE_BULLET[lang][cellId];
    const at = lines.findIndex((l) => l.startsWith(prefix));
    if (at >= 0) {
      let stop = at + 1;
      while (stop < lines.length && lines[stop].trim() !== "" && !/^\s*(?:[*+-]|\d+\.)\s/u.test(lines[stop])) stop += 1;
      return [...lines.slice(0, at), ...body.split("\n"), ...lines.slice(stop)].join("\n");
    }
    const span = surfaceSectionSpan(lines, lang);
    if (!span) return text;          // 整节找不到 ⇒ 原样返回 ⇒ 框架报「变异没落上」（不假绿）
    return [...lines.slice(0, span.head + 1), "", ...body.split("\n"), ...lines.slice(span.head + 1)].join("\n");
  };
}

/** #636 那一例的**目标名字**（#699 ③(a)）：`preferred` 在本版仍是「代码侧名单里的名字」、而本版段又把它
 *  算成这一版加的 ⇒ 直接用它（0.30 是这种，红话与改前逐字相同）；本版段没有这笔加法 ⇒ 从代码侧名单里
 *  取一个真实成员当目标，并回报「加法句要注入」。名字一律现取，不抄 `compaction` 这一笔历史事实。 */
const GUIDE_COVERAGE_TARGETS = new Map();
function guideCoverageCaseTarget(preferred = "compaction") {
  if (GUIDE_COVERAGE_TARGETS.has(preferred)) return GUIDE_COVERAGE_TARGETS.get(preferred);
  const inventory = nameInventory();
  const added = releaseAddedNames(inventory) ?? new Map();
  let out;
  if (added.has(preferred)) {
    out = { name: preferred, kind: added.get(preferred), inject: false };
  } else {
    const hit = [...(inventory ?? new Map())].find(([n, v]) => v?.kind === "观察者事件" && !n.includes("."))
      ?? [...(inventory ?? new Map()).entries()][0];
    out = hit ? { name: hit[0], kind: hit[1]?.kind ?? "名字", inject: true }
      : { name: preferred, kind: "观察者事件", inject: false };
  }
  GUIDE_COVERAGE_TARGETS.set(preferred, out);
  return out;
}

/** 往本版段里补一条**加法句**（`guide-coverage` 的证人：`ADDITION_VERBS` + 反引号里的名字）。 */
const addGuideCoverageClaim = (name) => (text) => {
  const line = `- Self-test premise (#699 ③): this release adds the observer event \`${name}\`.`;
  const head = new RegExp(`^## \\[${esc(PKG_VERSION)}\\].*$`, "mu");
  return head.test(text) ? text.replace(head, (h) => `${h}\n\n${line}`) : text;
};

/** 把某一版指南里对 `name` 的**提及**去掉：没提过就先补一条提及再改掉
 *  （两棵树上「删掉那条提及」都真的落得上；`after === before` 会被框架判成变异没落上）。 */
const dropGuideMention = (name) => (text) => {
  const seeded = text.includes(name) ? text
    : `${text.trimEnd()}\n\n<!-- self-test premise (#699 ③): mentions \`${name}\` in this line. -->\n`;
  return seeded.split(name).join("该名字");
};

/** 把 §4 正文整节写成规范六格 bullet；`omitCellId` 那一格**不写**（= 整格缺席）。见节头。 */
function writeSurfaceCells(lang, omitCellId = null) {
  return (text) => {
    const lines = text.split("\n");
    const span = surfaceSectionSpan(lines, lang);
    if (!span) return text;
    const body = ["", ...SURFACE_CELLS.filter((c) => c.id !== omitCellId).map((c) => surfaceCanonicalBullet(lang, c))];
    return [...lines.slice(0, span.head + 1), ...body, "", ...lines.slice(span.end)].join("\n");
  };
}

/** 六格在指南里的**行首锚**：自测按格替换/删除 bullet 时用（改措辞要同步这里）。 */
const SURFACE_BULLET = Object.freeze({
  en: {
    options: "* **Options —",
    defaults: "* **Defaults —",
    events: "* **Observer events —",
    diagnostics: "* **Diagnostic fields —",
    disk: "* **On-disk formats —",
    finalPayload: "* **Final payload —",
  },
  cn: {
    options: "* **选项——",
    defaults: "* **默认值——",
    events: "* **观察者事件——",
    diagnostics: "* **诊断字段——",
    disk: "* **磁盘格式——",
    finalPayload: "* **终局载荷——",
  },
});

/**
 * 六格：`id`（内部键）+ 中英格名（红时点名用）+ 中英「这一格在讲什么」的标记 + 成员真值构造器。
 * 顺序即**归属优先级**：一个名字同时像两格时，先命中的那格赢（`compactionStats` 是诊断字段，不是终局载荷）。
 */
const SURFACE_CELLS = Object.freeze([
  { id: "diagnostics", en: "diagnostic fields", cn: "诊断字段",
    marker: { en: /\bdiagnostic fields?\b|\bdiagnostics\b/iu, cn: /诊断字段/u },
    truth: () => surfaceDiagnosticNames() },
  { id: "disk", en: "on-disk formats", cn: "磁盘格式",
    marker: { en: /\bon-disk\b|\bdisk formats?\b/iu, cn: /磁盘格式|磁盘/u },
    truth: () => surfaceDiskNames() },
  { id: "events", en: "observer events", cn: "观察者事件",
    marker: { en: /\bobserver events?\b/iu, cn: /观察者事件/u },
    truth: () => surfaceEventNames() },
  { id: "options", en: "options", cn: "选项",
    marker: { en: /\boptions?\b|\binput surface\b|\bconfiguration leaf\b/iu, cn: /选项|输入面|配置叶子/u },
    truth: () => surfaceOptionNames() },
  { id: "defaults", en: "defaults", cn: "默认值",
    marker: { en: /\bdefaults?\b/iu, cn: /默认值|默认/u },
    truth: () => surfaceDefaultNames() },
  { id: "finalPayload", en: "final payload", cn: "终局载荷",
    marker: { en: /\bfinal payload\b|\bterminal payload\b|\bexit[- ]codes?\b/iu, cn: /终局载荷|终局|退出码/u },
    truth: () => surfaceFinalPayloadNames() },
]);

/** 观察者事件：`src/loop/orchestrator.js` 里 `type: "…"` 真正发出去的事件类型。 */
function surfaceEventNames() {
  const rec = fileRecord("src/loop/orchestrator.js");
  if (!rec) return null;
  return new Set([...rec.text.matchAll(/\btype:\s*"([a-z][a-z0-9_]{2,})"/gu)].map((m) => m[1]));
}

/** 选项：配置叶子（路径 + 叶子名）+ CLI 旗标 + slot 键。真值来自 schema 与 `bin/cli.js`。 */
function surfaceOptionNames() {
  const truth = configNamespaceTruth();
  const cli = fileRecord("bin/cli.js");
  if (!truth || !cli) return null;
  const out = new Set();
  for (const group of truth.groups) {
    out.add(group);
    for (const leaf of truth.leaves.get(group) ?? []) {
      out.add(leaf);
      out.add(`config.${group}.${leaf}`);
    }
  }
  for (const m of cli.text.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]+)/gu)) out.add(m[1]);
  for (const m of cli.text.matchAll(/\bslots\.[A-Za-z][\w]*\.([A-Za-z][\w]*)/gu)) out.add(m[1]);
  return out;
}

/** 默认值：`bin/config.js` 里 `DEFAULT_*` 这类「某个选项的缺省值」常量（**不是**任意大写常量）。 */
function surfaceDefaultNames() {
  const rec = fileRecord("bin/config.js");
  if (!rec) return null;
  return new Set([...rec.text.matchAll(/\b(DEFAULT_[A-Z0-9_]+)/gu)].map((m) => m[1]));
}

/** 诊断字段：`createCompactionStat` 造出来的 `compactionStats` 条目形状的键（含 `foldSummary` 子键）。 */
function surfaceDiagnosticNames() {
  const rec = fileRecord("src/compact/pipeline.js");
  if (!rec) return null;
  const start = rec.text.indexOf("export function createCompactionStat(");
  const end = start < 0 ? -1 : rec.text.indexOf("export const COMPACTION_STATS_STATE_LIMIT", start);
  if (start < 0 || end < 0) return null;
  const block = rec.text.slice(start, end);
  const out = new Set(["compactionStats"]);
  for (const m of block.matchAll(/(?:^|[,{(\s])([A-Za-z_$][\w$]*)\s*:/gu)) out.add(m[1]);
  for (const m of block.matchAll(/\.([A-Za-z_$][\w$]*)\s*=[^=]/gu)) out.add(m[1]);
  return out;
}

/** 磁盘格式：`*_RECORD_FIELD` 声明的轮记录字段 + `buildFoldedFacts({…})` 这个折叠记录字面量的键。 */
function surfaceDiskNames() {
  const journal = fileRecord("src/compact/fold-summary-journal.js");
  const orch = fileRecord("src/loop/orchestrator.js");
  if (!journal || !orch) return null;
  const out = new Set([...journal.text.matchAll(/export const [A-Z_]+_RECORD_FIELD\s*=\s*"([^"]+)"/gu)].map((m) => m[1]));
  const masked = maskJs(orch.text, { keepStrings: false });
  const at = masked.indexOf("buildFoldedFacts({");
  if (at < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = masked.indexOf("{", at); i >= 0 && i < masked.length; i += 1) {
    if (masked[i] === "{") depth += 1;
    else if (masked[i] === "}") { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  for (const m of masked.slice(at, end).matchAll(/(?:^|[,{(])\s*([A-Za-z_$][\w$]*)\s*:/gmu)) out.add(m[1]);
  return out.size ? out : null;
}

/** 终局载荷：`makeResult` 的返回键 + `termination` 的键 + `bin/cli.js` 的退出码符号。 */
function surfaceFinalPayloadNames() {
  const term = fileRecord("src/loop/termination.js");
  const cli = fileRecord("bin/cli.js");
  if (!term || !cli) return null;
  const start = term.text.indexOf("const makeResult = ");
  const end = start < 0 ? -1 : term.text.indexOf("const forcedFinalFallbackApplies", start);
  if (start < 0 || end < 0) return null;
  const out = new Set();
  for (const m of term.text.slice(start, end).matchAll(/(?:^|[,{(]\s*)([A-Za-z_$][\w$]*)\s*:/gmu)) out.add(m[1]);
  for (const m of term.text.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*terminationErrorCodeForError/gu)) out.add(m[1]);
  for (const m of cli.text.matchAll(/export function (exitCode[A-Za-z0-9_]*)/gu)) out.add(m[1]);
  return out.size ? out : null;
}

/** 一段散文里的「字段名」候选：反引号里的名字（含 `type: "x"` / `"x"` 这种事件字面量）。 */
function surfaceNamesIn(sentence) {
  const out = [];
  for (const m of sentence.matchAll(/`([^`\n]+)`/gu)) {
    const span = m[1].trim();
    const quoted = span.match(/^type:\s*"([a-z][a-z0-9_]{2,})"$/u) ?? span.match(/^"([a-z][a-z0-9_]{2,})"$/u);
    if (quoted) { out.push({ name: quoted[1], quoted: true }); continue; }
    if (SURFACE_NAME_SHAPE.test(span)) out.push({ name: span, quoted: false });
  }
  return out;
}

/** 一个名字属于哪一格（`null` = 六格都不认）。`truths` 是 `id → Set`（一次判据内只现算一遍）。 */
function surfaceCellOf(name, { quoted = false, truths }) {
  const bare = name.replace(/\[\]$/u, "");
  const parts = bare.split(".");
  // `record.` 是轮记录的前缀：`record.foldedFacts.text` 的格身份由 `foldedFacts` 决定，
  // **不再回落到末段**——否则 `text` 会把它抢去「观察者事件」（`text` 确实是一个事件名）。
  const root = parts[0] === "record" ? parts[1] : parts[0];
  const last = parts.at(-1);
  for (const cell of SURFACE_CELLS) {
    const truth = truths.get(cell.id);
    if (!truth) continue;
    if (cell.id === "events" && !quoted) continue;      // 事件名只认 `type: "…"` / 引号字面量（裸 `text` 是散文）
    if (truth.has(root)) return cell;
    if (parts[0] !== "record" && parts.length > 1 && truth.has(last)) return cell;
  }
  return null;
}

/** 本版 CHANGELOG 段：逐条（bullet）切，逐句判「有没有变更形状」。读不到返 null。 */
function declaredSurfaceChanges(version, truths) {
  const sections = changelogSections();
  const sect = (sections ?? []).find((s) => s.version === version);
  if (!sect) return null;
  const byCell = new Map(SURFACE_CELLS.map((c) => [c.id, new Set()]));
  const entries = [];
  let cur = null;
  for (const line of sect.body.split("\n")) {
    if (/^- /u.test(line)) { cur = { line: sect.line, lines: [line] }; entries.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  let namesSeen = 0;
  let anyMember = 0;
  let changedCount = 0;
  for (const entry of entries) {
    const entryText = entry.lines.join(" ");
    if (SURFACE_DISPLAY_ONLY.test(entryText)) continue;   // 展示层/纯文档条目不是引擎面变更的证人
    for (const sentence of sentencesOf(entryText)) {
      const names = surfaceNamesIn(sentence);
      for (const { name, quoted } of names) {
        namesSeen += 1;
        if (surfaceCellOf(name, { quoted, truths })) anyMember += 1;
      }
      if (!names.length || !SURFACE_CHANGE_SHAPES.test(sentence)) continue;
      for (const { name, quoted } of names) {
        const cell = surfaceCellOf(name, { quoted, truths });
        if (!cell) continue;
        byCell.get(cell.id).add(name);
        changedCount += 1;
      }
    }
  }
  return { byCell, namesSeen, anyMember, changedCount, line: sect.line };
}

/**
 * 例「纯加法的名字不是变更证据」的靶子必须**现选一格**（0.32 切版树逼出来的改法）。
 *
 * 那条反向证要证的是：一个**纯加法**的名字不算变更证据 ⇒ 那一格写「不变」保持绿。它的前提是
 * **那一格本版没有变更证据** —— 那是本版的事实，不是恒真。0.32 的 `options` 格真的变了
 * （`snapshot.messages` 只交残余），拿固定的 `options` 当靶子时「写不变」本该红，于是这条
 * `expectGreen` 的例在整个发布窗口里恒红（实测 2 处红：中英各一条「写着不变而本版声明变了」）。
 *
 * 所以格子从本版事实里挑：六格真值齐、且本版**无**变更证据的第一格。一格都挑不出 ⇒ 落回
 * `options`，让这一例当场红 —— 那种形状（六格全有变更）需要人看一眼，不该被静默放行。
 *
 * 两半都得写：点名的 `config.metadata.modelMetadata.budgetTokens` 含代码侧清单里的
 * `config.metadata.model` / `config.metadata.modelMetadata` 两个叶子名，只写一侧等于凭空造一处
 * 中英背离，`guide-coverage` 会红在成对那一半上，而不是本例要考的事情（issue #703 的 S1 探针树暴露）。
 */
function surfaceAdditiveProbe(lang, text) {
  const ADDITIVE = "config.metadata.modelMetadata.budgetTokens";
  const truths = new Map();
  for (const cell of SURFACE_CELLS) {
    const truth = cell.truth();
    if (truth) truths.set(cell.id, truth);
  }
  const declared = declaredSurfaceChanges(PKG_VERSION, truths);
  const free = SURFACE_CELLS.find((c) => truths.has(c.id) && (declared?.byCell.get(c.id)?.size ?? 1) === 0);
  const cell = free ?? SURFACE_CELLS.find((c) => c.id === "options");
  const body = lang === "en"
    ? `* **${cell.en} — unchanged.** Nothing in this surface moved in this release; the added\n`
      + `  \`${ADDITIVE}\` leaf changes no existing member (§4.1).`
    : `* **${cell.cn}——不变。** 这一版没有改动这一格的任何成员；本版**新增**的\n`
      + `  \`${ADDITIVE}\` 叶子不改动任何既有成员（§4.1）。`;
  return putSurfaceBullet(lang, cell.id, body)(text);
}

/** 那一节（到第一个 `###` 子节或下一个 `##` 为止）。找不到返 null。 */
function unchangedSurfaceSection(rel, lang) {
  const rec = fileRecord(rel);
  if (!rec) return null;
  const head = rec.lines.findIndex((line) => SURFACE_SECTION_HEADING[lang].test(line.trim()));
  if (head < 0) return null;
  const lines = [];
  for (let i = head + 1; i < rec.lines.length; i += 1) {
    const line = rec.lines[i];
    if (/^#{2,3}\s/u.test(line)) break;
    lines.push({ text: line, line: i + 1 });
  }
  return { heading: head + 1, lines };
}

/** 把那一节切成「块」（一条 bullet / 一个自然段 = 一个声明单元），每块记它点名了哪几格。 */
function surfaceClaimBlocks(section, lang) {
  const blocks = [];
  let cur = null;
  for (const { text, line } of section.lines) {
    if (!text.trim()) { cur = null; continue; }
    const starts = /^\s*(?:[*+-]|\d+\.)\s/u.test(text);
    if (starts || cur === null) { cur = { text: "", line }; blocks.push(cur); }
    cur.text += ` ${text.trim()}`;
  }
  const claims = new Map();
  for (const block of blocks) {
    for (const cell of SURFACE_CELLS) {
      if (!cell.marker[lang].test(block.text)) continue;
      if (claims.has(cell.id)) continue;             // 第一处声明为准（红也只点一次名）
      claims.set(cell.id, { line: block.line, changed: SURFACE_CHANGED_MARK[lang].test(block.text), text: block.text });
    }
  }
  return claims;
}

/** 指南里点到的名字是否就是 CHANGELOG 声明变更的那一个（允许 `record.` 前缀 / 点分后缀的写法差）。 */
const surfaceNameMatches = (declared, name) => declared === name
  || declared.endsWith(`.${name}`) || name.endsWith(`.${declared}`);

function collectUnchangedSurfaceErrors() {
  const out = [];
  const notes = [];
  const readFailures = [];
  const done = () => {
    collectUnchangedSurfaceErrors.notes = notes;
    collectUnchangedSurfaceErrors.readFailures = readFailures;
    return out;
  };
  const fail = (msg) => { out.push(msg); readFailures.push(msg); };
  const guides = versionedGuideDocs().filter((rel) => guideDocVersion(rel) === PKG_VERSION);
  const en = guides.find((rel) => !rel.endsWith("_cn.md")) ?? null;
  const cn = guides.find((rel) => rel.endsWith("_cn.md")) ?? null;
  if (!en || !cn) {
    fail(`unchanged-surface: 当前版本 ${PKG_VERSION} 没有一对指南（EN=${en ?? "缺"} / CN=${cn ?? "缺"}）——`
      + "「不变」声明无从对账（读不出 = 红，不许静默放行）");
    return done();
  }
  const truths = new Map();
  for (const cell of SURFACE_CELLS) {
    const truth = cell.truth();
    if (truth) truths.set(cell.id, truth);
    else fail(`unchanged-surface: 抽不到「${cell.cn}」格的成员真值（源码里的形状定位点不见了）——`
      + "抽不到真值就报错，这一格不许当作「没有变更证据」（#164 口径）");
  }
  if (readFailures.length) return done();
  const declared = declaredSurfaceChanges(PKG_VERSION, truths);
  if (!declared) {
    fail(`unchanged-surface: 读不到 CHANGELOG 的 ${PKG_VERSION} 段——「这一版到底动了哪些字段」的真值缺位，`
      + "对账判据不许静默放行");
    return done();
  }
  // issue #699 ①：**零归属不是「提取器坏了」的信号**。真值提取器坏掉的信号是上面那一圈逐格判的
  // 「抽不到「X」格的成员真值」（`cell.truth()` 返回 null ⇒ 真值集为空）。六格真值各自非空时，本版段里的
  // 反引号名字可能**一个都不属于六格**——0.31.0 是纯删除版，段里 70 处反引号全是**已经从导出面消失**的
  // 导出名（`estimateMessagesTokens` / `setNotesClock` / `NOTE_VALUE_MAX_CHARS` …），按定义进不了六格：
  // 六格量的是「这一版还在的输入面 / 诊断字段 / 磁盘格式 / 事件 / 默认值 / 终局载荷」，退役导出名不在其中。
  // 旧判据把这种合法形状判成「本判据正在空跑」，于是 `check:docs` 在 0.31 上**永远 exit 2**（切版树与
  // 「切版 + 已补 §4」树都实测过）。修的是误报：判据一格没删，只把「零归属」从红降级成一条打印说明，
  // 并把每格真值规模一起印出来（读者能当场看见「六格都在、只是这一版没动它们」）。
  // 「本判据正在空跑」这句话只允许在**真值集为空**时说（上面那条 fail 里已经说了），这里不许再说。
  if (declared.namesSeen > 0 && declared.anyMember === 0) {
    notes.push(`unchanged-surface: CHANGELOG ${PKG_VERSION} 段里有 ${declared.namesSeen} 处反引号字段名，`
      + `但一处也没落进六格（各格真值规模：${[...truths].map(([id, set]) => `${id}=${set.size}`).join(" / ")}）——`
      + "这是「本版只有删除 / 勘误 / 发版流程」的合法形状：那些名字已从导出面消失，按定义不属于六格，"
      + "所以不判红；真值集本身抽不出来（提取器坏了）由上面那条「抽不到成员真值」判红（#699 ①）");
  }
  let cellsJudged = 0;
  for (const [rel, lang] of [[en, "en"], [cn, "cn"]]) {
    const section = unchangedSurfaceSection(rel, lang);
    if (!section) {
      fail(`unchanged-surface: ${rel} 里找不到「不变」那一节（标题应为 `
        + `\`${lang === "en" ? "## N. What does not change" : "## N. 没有变的东西"}\`）——`
        + "读不出这一节就等于没有声明可对账（读不出 = 红，exit 2）");
      continue;
    }
    const claims = surfaceClaimBlocks(section, lang);
    for (const cell of SURFACE_CELLS) {
      cellsJudged += 1;
      const changedNames = [...declared.byCell.get(cell.id)];
      if (!changedNames.length) continue;            // ② 反向：本版没有变更证据 ⇒ 写「不变」保持绿
      const claim = claims.get(cell.id);
      const label = cell[lang];
      const list = changedNames.join(", ");
      if (!claim) {
        out.push(`unchanged-surface: ${rel}:${section.heading} 第「${label}」格整格缺席——本版 CHANGELOG 声明 `
          + `${list} 变了，而这一节里没有这一格的任何声明（中英各自判：一侧被整句删掉不算处置，#690）`);
        continue;
      }
      if (!claim.changed) {
        out.push(`unchanged-surface: ${rel}:${claim.line} 第「${label}」格写着不变，而本版 CHANGELOG 声明这些字段变了：`
          + `${list}——「不变」与同一版 CHANGELOG 打架（#690）`);
        continue;
      }
      const named = surfaceNamesIn(claim.text)
        .filter(({ name, quoted }) => surfaceCellOf(name, { quoted, truths })?.id === cell.id)
        .filter(({ name }) => changedNames.some((d) => surfaceNameMatches(d, name)));
      if (!named.length) {
        out.push(`unchanged-surface: ${rel}:${claim.line} 第「${label}」格声明了变更，却没有点名本版 CHANGELOG 里`
          + `任何一个该格字段（本版该格声明变更的是：${list}）——「变了」不点名等于没对账（#690）`);
      }
    }
  }
  const total = [...declared.byCell.values()].reduce((n, set) => n + set.size, 0);
  const touched = [...declared.byCell.entries()].filter(([, set]) => set.size > 0).map(([id]) => id);
  notes.push(`unchanged-surface: CHANGELOG ${PKG_VERSION} 段解析出 ${declared.namesSeen} 处反引号字段名，`
    + `其中 ${total} 处是变更证据、落到 ${touched.length} 格（${touched.join(" / ") || "无"}）；`
    + `指南 ${en} / ${cn} 各判 ${cellsJudged / 2} 格（声明不变 / 声明变更并点名 / 整格缺席）`);
  return done();
}

/** `--self-test` 的变异器：把某条 bullet 整条删掉（锚不上 ⇒ 原样返回 ⇒ 框架报「变异没落上」）。 */
function dropSurfaceBullet(prefix) {
  return (text) => {
    const lines = text.split("\n");
    const at = lines.findIndex((line) => line.startsWith(prefix));
    if (at < 0) return text;
    let end = at + 1;
    while (end < lines.length && lines[end].trim() !== "" && !/^\s*(?:[*+-]|\d+\.)\s/u.test(lines[end])) end += 1;
    return [...lines.slice(0, at), ...lines.slice(end)].join("\n");
  };
}

/** `--self-test` 的变异器：把某条 bullet 的正文换掉（`build()` 从零构造，不抄文档原话）。 */
function replaceSurfaceBullet(prefix, build) {
  return (text) => {
    const lines = text.split("\n");
    const at = lines.findIndex((line) => line.startsWith(prefix));
    if (at < 0) return text;
    let end = at + 1;
    while (end < lines.length && lines[end].trim() !== "" && !/^\s*(?:[*+-]|\d+\.)\s/u.test(lines[end])) end += 1;
    const body = build();
    if (body === null) return text;
    return [...lines.slice(0, at), ...body.split("\n"), ...lines.slice(end)].join("\n");
  };
}

function collectAllDrift() {
  const out = [...collectAnchorErrors(), ...checkPkgBlocks().errors, ...collectPathErrors(),
    ...collectMarkerLiteralErrors(), ...collectBaselineClaimErrors(),
    ...collectSymbolAnchorErrors(), ...collectBareLineRefErrors(), ...collectRefScanCoverageErrors(),
    // #772 R2 M2：标记区内容的正向不变量（只许包住那张表）
    ...cellAxesRegionContentErrors(),
    // #635 ① / #644 ③：份数声称的机器对账 + 指令面指着账本的那句指针
    ...collectRefScanCountClaimErrors(), ...collectLedgerPointerErrors(),
    ...collectCliFlagErrors(),
    // #668 ①：压缩策略「默认值」的分层对账（库层 / CLI 层各自绑源码真值）
    ...collectCompactionDefaultErrors(),
    // #668 ②：退役语义「摘要器失败 ⇒ 降级/兜底为统计摘要」——活面 × 源码真值（见 §2.11）
    ...collectRetiredSemanticsErrors(),
    // issue #677：契约「套件清单」的 unknownSlot 形态（真值 = test/contract/model-config-provider.js，见 §2.12）
    ...collectSuiteInventoryErrors(),
    // issue #677 补充范围：强制收尾资格「按状态，不按 reason 枚举」（真值 = src/loop/termination.js，见 §2.13）
    ...collectForcedFinalEligibilityErrors(),
    // issue #511：「这句话属于哪个版本」与「这个版本发布了没有」四条（自测要连它们一起变异）
    ...collectDocVersionErrors(), ...collectVersionAttributionErrors(), ...collectGuideClaimErrors(),
    ...collectChangelogPublicationErrors(), ...collectPublishedClaimErrors(),
    // issue #697：段首日期是事实——未发布段不许带日期、已发布段的日期必须与 tag 同一天（§17b）
    ...collectChangelogDateErrors(),
    // issue #636：「该不该有一条」——代码侧名单 × CHANGELOG 加法句 ⇒ 指南必须覆盖
    ...collectGuideCoverageErrors(),
    // 14b：0.30 破坏包的逐名表 ↔ 现算候选集（issue #429 的文档面）
    ...collectBundleTableErrors(),
    // issue #690：「不变」那一节 × 本版 CHANGELOG 的字段真值（六格逐格对账，中英各判一次，见本节第 20 段的节头）
    ...collectUnchangedSurfaceErrors()];
  for (const [, en, cn] of SKELETON_PAIRS) out.push(...collectSkeletonErrors(en === README_EN ? "中英 README" : "中英 AGENTS", en, cn));
  return out;
}

for (const [label, en, cn] of SKELETON_PAIRS) {
  const errs = collectSkeletonErrors(label, en, cn);
  errs.forEach((e) => err(e));
  if (!errs.length) note(collectSkeletonErrors.notes.join(""));
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
// ── 7. 跑清单/单位类锚点、marker 字面、棘轮当前值与 package.json 清单比对 ────────
for (const e of collectRefScanCoverageErrors()) err(e);
for (const n of collectRefScanCoverageErrors.notes ?? []) note(n);
// #635 ① / #644 ③
for (const e of collectRefScanCountClaimErrors()) err(e);
for (const n of collectRefScanCountClaimErrors.notes ?? []) note(n);
for (const e of collectLedgerPointerErrors()) err(e);
for (const n of collectLedgerPointerErrors.notes ?? []) note(n);
for (const e of collectSymbolAnchorErrors()) err(e);
for (const n of collectSymbolAnchorErrors.notes ?? []) note(n);
for (const e of collectBareLineRefErrors()) err(e);
for (const n of collectBareLineRefErrors.notes ?? []) note(n);
// #772 R2 M2：标记区里只许包住两轴载荷表本身（begin 上移包住正文 ⇒ 红）
for (const e of cellAxesRegionContentErrors()) err(e);
for (const n of cellAxesRegionContentErrors.notes ?? []) note(n);
for (const e of collectCliFlagErrors()) err(e);
for (const n of collectCliFlagErrors.notes ?? []) note(n);
// #668 ①：压缩策略默认值（库层 / CLI 层分开对账）
for (const e of collectCompactionDefaultErrors()) err(e);
for (const n of collectCompactionDefaultErrors.notes ?? []) note(n);
// #668 ②：退役语义（活面 = 入库 Markdown + bin/src JS，历史类不判；源码真值当场对账）
for (const e of collectRetiredSemanticsErrors()) err(e);
for (const n of collectRetiredSemanticsErrors.notes ?? []) note(n);
// issue #677：契约「套件清单」的 unknownSlot 形态（中英两侧 × 套件真值，逐形态窗口过）
for (const e of collectSuiteInventoryErrors()) err(e);
for (const n of collectSuiteInventoryErrors.notes ?? []) note(n);
// issue #677 补充范围：强制收尾资格（中英两侧 × src/loop/termination.js 的两个 reason 集合）
for (const e of collectForcedFinalEligibilityErrors()) err(e);
for (const n of collectForcedFinalEligibilityErrors.notes ?? []) note(n);
// ── 9. 「这句话属于哪个版本」（issue #511）──────────────────────────────────────
for (const collect of [collectDocVersionErrors, collectVersionAttributionErrors, collectGuideClaimErrors,
  collectChangelogPublicationErrors, collectPublishedClaimErrors, collectGuideCoverageErrors, collectBundleTableErrors,
  collectUnchangedSurfaceErrors, collectChangelogDateErrors]) {
  for (const e of collect()) err(e);
  for (const n of collect.notes ?? []) note(n);
}
// issue #697：`TAG_MISSING` = **未判定**（不是红）。它与 `READ_FAILURES` 同一个退出码（exit 2），
// 但印成自己的形状（带机器可读的 code），好让 `release:day` 的 writeback 分辨「tag 还没打」与「别的读不出」。
const NOT_JUDGED = collectChangelogDateErrors.notJudged ?? [];
// issue #690 ③：**读不出 = 红，而且是 exit 2**。这一族与「文档与真值打架」（exit 1）分开：
// 前者是「判据没有真值可判」（§4 找不到 / 本版 CHANGELOG 段读不到 / 名字解析为空），后者是「判得了且判出漂移」。
// 把两者印成同一个退出码，等于让「闸自己坏了」与「文档写错了」在 CI 里长得一模一样。
const READ_FAILURES = collectUnchangedSurfaceErrors.readFailures ?? [];
for (const e of collectMarkerLiteralErrors()) err(e);
for (const n of collectMarkerLiteralErrors.notes ?? []) note(n);
for (const e of collectBaselineClaimErrors()) err(e);
for (const n of collectBaselineClaimErrors.notes ?? []) note(n);
const pkgBlock = checkPkgBlocks();
pkgBlock.errors.forEach((e) => err(e));
pkgBlock.warnings.forEach((w) => warn(w));
const anchorErrors = collectAnchorErrors();
anchorErrors.forEach((e) => err(e));
for (const n of collectAnchorErrors.notes ?? []) note(n);

// ── 8. 反向证自测（issue #210 R2：把反向证固化在脚本里，不靠一次性手工实验）──────
// 每条规则至少两例：改文档一处 → 必须红；改源码/清单一侧 → 必须红；都不改（对照）→ 必须绿。
// 变异没落上去也算失败——否则规则改了而变异体过期，自测会默默变成空跑。
/** 「实测 **N** 处，超过棘轮基线 **M** 处」的正则（#286 棘轮反向证用）。写成函数而不是手写转义：
 *  这句话里半角/全角括号混排，手写转义配错一次就是一个 SyntaxError（本单真踩过）。 */
const ratchetOverBaseline = (measured, baseline) => new RegExp(
  `bare-lines: 裸行号引用（唯一 \\(文档,目标文件,行区间\\)）实测 \\*\\*${measured}\\*\\* 处，超过棘轮基线 \\*\\*${baseline}\\*\\*`,
);

const SELF_TEST = process.argv.includes("--self-test");

/** #279：在文档**第一处 `## ` 标题之前**插一句散文（= 「在文档靠前位置提一句某个名字」）。 */
function mentionInProse(sentence) {
  return (t) => {
    const m = /^## /m.exec(t);
    if (!m) return t;
    return t.slice(0, m.index) + sentence + "\n\n" + t.slice(m.index);
  };
}

/** #279：自测的「位置无关」打靶器。把「在某文档里把一个引用改个名」这刀从
 *  「文本第一次出现」改成「主检查提取到的那一（几）处」：用与主检查同一套提取逻辑
 *  （`extractRefOccurrences` 的 `spans`）定位**提取值恰为 `from`** 的全部出现，逐处定点换成 `to`。
 *  理由、病历与用例清单写在文件头 §2.5 「#279 的病历」那一块（与 #210「其余锚点为何没升级」同位）。
 *  · 一处都没命中就**原样返回** → `runSelfTest` 既有的「变异没落到 X 上」判据会报红，不给空跑假绿留门。
 *  · `opts.mention`：变异前先在文档靠前插一句散文——这正是本单要钉住的形状（提一句不能抢枪）。 */
function mutateRef(from, to, opts = {}) {
  return (text) => {
    let t = opts.mention ? mentionInProse(opts.mention)(text) : text;
    const seen = new Set();
    const hits = extractRefOccurrences(t).spans
      .filter((s) => s.p === from)
      .filter((s) => !seen.has(`${s.start}:${s.end}`) && seen.add(`${s.start}:${s.end}`))
      .sort((a, b) => b.start - a.start);
    if (!hits.length) return text;
    for (const s of hits) t = t.slice(0, s.start) + to + t.slice(s.end);
    if (extractRefOccurrences(t).spans.some((s) => s.p === from)) return text;   // 该值还剩着 → 这一枪没打全，同样算没落上
    return t;
  };
}

/** #621：自测的**合成区间锚点夹具**——把区间引用注进 overlay 自己的内存副本，变异打在注入的这条上。
 *
 *  为什么不再拿文档原话当靶子：这两例修前把契约里一句原话（`` (`bin/cli.js:1032-1042`) ``）硬编码成变异靶，
 *  #661 按 #286 的首选修法（删区间、只留符号）把那处区间删掉之后，两次 `replace` 都成了空操作，
 *  `--self-test` 当场 2/148 红（CI 的独立必需步骤）。**靶子必须跟着用例走**，不跟着某句活文档走——
 *  否则下一次删句子又把反向证变成空跑，而空跑的表现正是「变异没落上」（#210 R2）。
 *
 *  `mutate` 收到注入的锚点字面量，返回要写进副本的那一条；返回值与入参**逐字相同**时原样返回文本
 *  ⇒ `runSelfTest` 的「变异没落上」判据会红，不会留下「注入了但没变异」的假绿。
 *
 *  注意：`bin/` 前缀不在 `BARE_LINE_RE` 的 `src/` 覆盖面里，注入**不抬** `BARE_LINE_REF_BASELINE` 棘轮。
 */
function injectRangeAnchor(mutate) {
  const injected = "`bin/cli.js:1032-1042`";
  const mutated = mutate(injected);
  return (text) => (mutated === injected
    ? text
    : `${text}\n\n自测夹具（#621，只在 --self-test 的内存副本里）：下面这条区间引用是这一例的变异靶子，不依赖契约现存哪句原文。\n\n${mutated}\n`);
}

// 棘轮两档的当前真值**现读**棘轮脚本，不写死（issue #292 踩到的坑）：下面 5 条 baseline 反向证的变异串
// 原先硬编码 121 / 164，基线一降到 119 / 162 就全部变成空操作，而 #210 R2 把「变异没打上」判成红 ——
// 于是「下调常量 + 同步文档」这笔完全正常的提交会打红 5 条反向证。现读之后，以后再降基线不必回来改这里。
const RATCHET_TRUTH = ratchetBaselines(textOf(RATCHET_SRC));
const B_ROOT = Number(RATCHET_TRUTH.root);
const B_WT = Number(RATCHET_TRUTH.withTools);
// 并集分解式的两个分项（`= 117 + 23 + 16` 里的 23 与 16）也**现读** AGENTS，不写死：它们不是常量（真值没有
// 单一脚本可抽），但「写死就会在下一次下调时变成空操作」是同一条病——#292 的 5 条硬编码 121/164 之后，
// #362 又把 27 写死在这里（160 → 156 那笔），于是两条反向证立刻变成「变异没落上」的假红。抽不到 → 变异打不上
// → `expectMutateMiss` 那条判据照样红（fail-closed，不给静默放行留门）。
const B_SPLIT = (() => {
  for (const rel of [AGENTS_EN, AGENTS_CN]) {
    const m = textOf(rel).match(/= (\d+) \+ (\d+) \+ (\d+)/);
    if (m && Number(m[1]) === B_ROOT) return { b: Number(m[2]), c: Number(m[3]) };
  }
  return { b: NaN, c: NaN };
})();

/**
 * #677 自测用的「套件清单」行：**从零构造**，不抄文档原话。
 *
 * 工单要求「靶子必须自包含」：文档将来怎么改写都不该让反向证空转。所以行是按「小节标题 + 行首键」
 * 定位的（`suiteInventoryRowOf`），替换文本由用例自己拼出来——变异体永远与文档同形，只有**语义**
 * 是变量。找不到行就原样返回，由框架既有的「变异没落上」判据报红（#210 R2）。
 *
 * @param {string} doc 目标契约（决定表头格与后两列的语言）
 * @param {string[]} cells 第 2 列（「断言什么」）起的格子，顺序拼进表格行
 */
function suiteInventoryRowLine(doc, cells) {
  const head = doc === CONTRACT_CN ? "`model-config-provider.js`（4 条）" : "`model-config-provider.js` (4 tests)";
  const tail = doc === CONTRACT_CN
    ? ["你的 provider 的槽位解析与 key 物化", "没有任何引擎侧内容：它从不加载引擎"]
    : ["your provider's slot resolution and key materialisation", "nothing engine-side: it never loads the engine"];
  return `| ${[head, ...cells, ...tail].join(" | ")} |`;
}

/** #677：把「套件清单」里那一行整行换成 `build()` 的结果（定点打靶，不依赖原话）。 */
function mutateSuiteInventoryRow(doc, build) {
  return (text) => {
    const row = suiteInventoryRowOf(doc, text);
    if (row === null) return text;
    return `${text.slice(0, row.start)}${build()}${text.slice(row.end)}`;
  };
}

/** #677：**正确**答案的另一种写法（与文档现文同义、不同词）——「恢复/改写正确语义 ⇒ 绿」那一格用它。 */
const SUITE_INVENTORY_CANON = Object.freeze({
  [CONTRACT_EN]: [
    "`resolve()` → default slot, `resolve(slot)` → named slot, `apiKey` indirect-reference materialisation (ADR-001), and the unknown-slot answer stated **per provider shape** (issue #518): a slot-map provider (static / json-file) has to **throw**, naming the unknown slot and listing the available ones, and never falls back to default; a single-config provider returns the same config under any slot name — a shape difference, not an unknown-slot fallback to default",
  ],
  [CONTRACT_CN]: [
    "`resolve()` → default 槽，`resolve(slot)` → 具名槽，`apiKey` 间接引用物化（ADR-001），以及按 provider 形态分别陈述的「未知槽名」答案（issue #518）：槽位图形态（static / json-file）必须**抛错**，错误点名该未知槽名并列出可用槽位，**不许回落 default**；单配置形态则任何槽名都返回同一份配置——这是形态差异，不是「未知槽名回落 default」",
  ],
});

/** #677：**压平**答案（#518 的病：一条断言盖住两种形态——「都要抛」）。 */
const SUITE_INVENTORY_FLAT = Object.freeze({
  [CONTRACT_EN]: [
    "`resolve()` → default slot, `resolve(slot)` → named slot, `apiKey` indirect-reference materialisation (ADR-001), and the unknown-slot answer (issue #518): a slot-map provider (static / json-file) and a single-config provider both must **throw**, naming the unknown slot and listing the available ones, never falling back to default",
  ],
  [CONTRACT_CN]: [
    "`resolve()` → default 槽，`resolve(slot)` → 具名槽，`apiKey` 间接引用物化（ADR-001），以及按 provider 形态分别陈述的「未知槽名」答案（issue #518）：槽位图形态（static / json-file）与单配置形态都必须**抛错**，错误点名该未知槽名并列出可用槽位，**不许回落 default**",
  ],
});

/** #677：**只少一条腿**（单配置那段不再说「这是形态差异、不是未知回落 default」）——中英背离那一格用它。 */
const SUITE_INVENTORY_ONE_LEG_MISSING = Object.freeze({
  [CONTRACT_EN]: [
    "`resolve()` → default slot, `resolve(slot)` → named slot, `apiKey` indirect-reference materialisation (ADR-001), and the unknown-slot answer stated **per provider shape** (issue #518): a slot-map provider (static / json-file) must **throw**, naming the unknown slot and listing the available ones, never falling back to default, while a single-config provider returns the same config under any slot name",
  ],
});

/** #677（#475）：§7 资格句的**句尾标记**——打靶时只换到这一行为止，§7 后面的事实一字不动。 */
const FORCED_FINAL_ELIGIBILITY_END = Object.freeze({
  [CONTRACT_EN]: /wrote not a single character\./u,
  [CONTRACT_CN]: /一个字都没写过。/u,
});

/**
 * #677（#475）自测用的「§7 资格句」打靶器：把 §7 里**那一段资格陈述**整段换成 `build()`。
 *
 * 为什么只换这一段：§7 后半段（payload-only、`FORCED_FINAL_FALLBACK_TEXT` 兜底、事件面）被符号锚点与
 * 路径判据盯着，整段重写会把那些判据一起弄红，反向证就证明不了「这一族在判这句话」。段界由
 * `forcedFinalWindowOf`（小节）+ 句尾标记共同定，替换文本由用例**从零构造**（不抄文档原话）；
 * 小节或句尾标记找不到 ⇒ 原样返回 ⇒ 框架报「变异没落上」（#210 R2）。
 */
function mutateForcedFinalEligibility(doc, build) {
  return (text) => {
    const win = forcedFinalWindowOf(doc, text);
    if (win === null) return text;
    const lines = win.text.split("\n");
    const stop = lines.findIndex((line) => FORCED_FINAL_ELIGIBILITY_END[doc].test(line));
    if (stop === -1) return text;
    const kept = lines.slice(stop + 1).join("\n");
    const body = [build(), kept].filter((part) => part !== "").join("\n");
    const tail = win.end >= text.length ? "" : `\n${text.slice(win.end)}`;
    return `${text.slice(0, win.start)}${body}${tail}`;
  };
}

/**
 * #677（#475）：往 `src/loop/termination.js` 的某个 `NAME = new Set([...])` 里加/删成员。
 *
 * 自包含：按**常量名**定位集合字面量，成员由用例给（不抄源码原话）。找不到集合、或要删的成员
 * 不在集合里 ⇒ 原样返回（框架报「变异没落上」，不给空跑留门）。
 */
function mutateReasonSet(name, { add = [], remove = [] } = {}) {
  return (text) => {
    const m = text.match(new RegExp(`(${name}\\s*=\\s*new Set\\(\\[)([\\s\\S]*?)(\\]\\))`, "u"));
    if (!m) return text;
    let body = m[2];
    for (const member of remove) {
      const next = body.split("\n").filter((line) => !line.includes(`"${member}"`)).join("\n");
      if (next === body) return text;                  // 要删的成员不在集合里 ⇒ 变异没落上
      body = next;
    }
    for (const member of add) {
      if (body.includes(`"${member}"`)) return text;    // 已经在了 ⇒ 变异没落上
      body = `${body.replace(/\s*$/u, "")}\n    "${member}",\n  `;
    }
    return `${text.slice(0, m.index)}${m[1]}${body}${m[3]}${text.slice(m.index + m[0].length)}`;
  };
}

/** #677（#475）：资格句的**正确**语义（同义改写、五条腿一条不少）——「恢复 ⇒ 绿」那一格用它。 */
const FORCED_FINAL_CANON = Object.freeze({
  [CONTRACT_EN]: [
    "7. **post-stop verification** — once a stop reason exists, forced wrap-up can",
    "   make one more provider call. Eligibility is a **state, not a whitelist of",
    "   reasons** (issue #475): the three non-continuable reasons",
    "   (`max_rounds_cap` / `stall` / `continuation_exhausted`) keep the stricter",
    "   truncation test below, while any other reason — `judge_done` (issue #467),",
    "   `end_turn` and `no_tool` (issue #475), and any reason a later release adds —",
    "   is eligible on one test only: the whole run wrote not a single character.",
    "   A new reason is therefore covered by construction — nobody has to \"append a",
    "   row to the whitelist\" again.",
  ].join("\n"),
  [CONTRACT_CN]: [
    "7. **停止后验证**——stop reason 定下来之后，可能多一次强制收尾的 provider 调用。",
    "   资格是**一个状态、不是 reason 白名单**（issue #475）：三条不可续跑的 reason",
    "   （`max_rounds_cap` / `stall` / `continuation_exhausted`）沿用下面更严的截断判据，",
    "   其余 reason —— `judge_done`（issue #467）、`end_turn` / `no_tool`（issue #475）、",
    "   以及后续版本新增的任何 reason —— 只过一个判据：整个 run 一个字都没写过。",
    "   ⇒ 新增 reason 天然被覆盖，不必再「记着回来贴一条」。",
  ].join("\n"),
});

/** #677（#475）：**退回假话**（#475 之前那套：资格是一份 reason 白名单 / 固定六个）。 */
const FORCED_FINAL_FLAT = Object.freeze({
  [CONTRACT_EN]: [
    "7. **post-stop verification** — after a stop reason exists, forced wrap-up may",
    "   add one more provider call. Eligibility is a whitelist of reasons (issue",
    "   #475): only the six guard-eligible reasons listed in",
    "   `FINAL_GUARD_TERMINATION_REASONS` (`src/loop/termination.js`) get that call.",
  ].join("\n"),
  [CONTRACT_CN]: [
    "7. **停止后验证**——stop reason 定下来后，可能多一次强制收尾的 provider 调用。",
    "   资格是一份 reason 白名单（issue #475）：只对 6 个 guard 适用 reason 补发一次。",
  ].join("\n"),
});

/** #677（#475）：**只少一条腿**（其余 reason 不再说「只过一个判据：整个 run 一个字都没写过」）
 *  ——中英背离那一格用它。注意腿要挑**落在被替换那一段里**的：§7 后面被保留下来的原文会照旧供腿。 */
const FORCED_FINAL_ONE_LEG_MISSING = Object.freeze({
  [CONTRACT_EN]: [
    "7. **post-stop verification** — after a stop reason exists, forced wrap-up may",
    "   add one more provider call. Eligibility is a **state, not a whitelist of",
    "   reasons** (issue #475): the three non-continuable reasons",
    "   (`max_rounds_cap` / `stall` / `continuation_exhausted`) keep the stricter",
    "   truncation test below, while every other reason — `judge_done` (issue #467),",
    "   `end_turn` and `no_tool` (issue #475), and any reason a later release adds —",
    "   is eligible without any further test.",
  ].join("\n"),
});

/** #772：标记区定点豁免的反向证共用的探针——现读 CN 契约标记区里的**第一条**裸行号引用，
 *  用例把它原样拄到标记区**外**。表里的行号会随实现漂移，所以靶子跟着用例走而不是跟着某句活
 *  文档走（#621 口径）：抽不到 → 变异打不上 → 「变异没落上」判据报红，不会假绿。 */
const CELL_AXES_PROBE_REF = (() => {
  const lines = textOf(CONTRACT_CN).split("\n");
  const b = lines.findIndex((l) => l.includes(CELL_AXES_MARK_BEGIN));
  const e = lines.findIndex((l) => l.includes(CELL_AXES_MARK_END));
  if (b < 0 || e <= b) return null;
  for (let i = b + 1; i < e; i += 1) {
    const m = lines[i].match(/src\/[A-Za-z0-9_./-]+\.js:\d+(?:-\d+)?/);
    if (m) return m[0];
  }
  return null;
})();

/** #772 R2：锚点一族反向证共用的两个探针——都从**现树现读**，不抄活文档里的行号（#621 口径）：
 *  CN 表里 `compactionStats` 写点的第一条引用，与 orchestrator 里那句「讲测试拿它当指纹」的注释行。
 *  抽不到 → 变异打不上 → 「变异没落上」判据报红，不会假绿。 */
const CELL_AXES_DRIFT_PROBE = (() => {
  const lines = textOf(CONTRACT_CN).split("\n");
  const b = lines.findIndex((l) => l.includes(CELL_AXES_MARK_BEGIN));
  const e = lines.findIndex((l, i) => i > b && l.includes(CELL_AXES_MARK_END));
  if (b < 0 || e <= b) return null;
  for (const line of lines.slice(b + 1, e)) {
    if (!line.includes("`compactionStats`")) continue;
    const m = line.match(/src\/loop\/orchestrator\.js:\d+/u);
    if (m) return m[0];
  }
  return null;
})();
/** #772 R2 M2 突变：把两轴表的 begin 标记整行往上搬 n 行 —— 原本在表格上方的 n 行正文落进标记区。 */
const liftCellAxesBegin = (linesUp) => (text) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.includes(CELL_AXES_MARK_BEGIN));
  if (at < linesUp) return text;
  return [...lines.slice(0, at - linesUp), lines[at], ...lines.slice(at - linesUp, at), ...lines.slice(at + 1)].join("\n");
};

const CELL_AXES_DISTRACTOR_LINE = (() => {
  const lines = textOf("src/loop/orchestrator.js").split("\n");
  const hits = lines.map((l, i) => (/^ +\/\/ - `compactionStats`：/u.test(l) ? i + 1 : 0)).filter((n) => n > 0);
  return hits.length === 1 ? hits[0] : null;
})();

/**
 * #770 R2：从锚点模块的**文本**里定位 `CELL_AXES_ANCHORS` 登记表里某一条登记所在的行下标（现读，不写死
 * 行号）。必须只在 `export const CELL_AXES_ANCHORS = [` **之后**找：#770 之后人审清单
 * `CELL_AXES_REQUIRED_CELLS` 也带 `kind` / `anchor` 字段，于是「同一行含 `key: "status", axis: "write"`
 * 且含 `anchor:`」在整份文件里有**两处**（清单一条 + 登记表一条）⇒ 旧夹具那种「整份文本里挑唯一一行」
 * 的靶子从 #770 起一律打不上 ⇒ 由 harness 的「变异没落上」判据报红（#210 R2 口径）。
 * @returns {number} 行下标；命中 0 处或不止一处 ⇒ -1（⇒ 变异原样返回 ⇒ 照旧报红）
 */
const cellAxesAnchorTableRow = (text, includes) => {
  const lines = text.split("\n");
  const from = lines.findIndex((l) => l.startsWith("export const CELL_AXES_ANCHORS = ["));
  if (from < 0) return -1;
  const hits = lines.map((l, i) => (i > from && includes(l) ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? hits[0] : -1;
};

/** `status` 写点那一条登记（#770 之后是一条 `kind: "comment"` 锚点）在登记表里的行下标。 */
const cellAxesStatusWriteAnchorRow = (text) => cellAxesAnchorTableRow(
  text, (l) => l.includes('key: "status", axis: "write"') && l.includes("anchor:"));

/**
 * 把登记表里那一行的 `anchor:` 换成别的内容（转义交给 `JSON.stringify`）。那一行不在场或没改成 ⇒
 * 原样返回文本 ⇒ 由「变异没落上」判据报红，而不是悄悄绿过去。
 */
const cellAxesWeakenAnchor = (text, anchor) => {
  const at = cellAxesStatusWriteAnchorRow(text);
  if (at < 0) return text;
  const lines = text.split("\n");
  const weakened = lines[at].replace(/anchor: "(?:[^"\\]|\\.)*"/u, () => `anchor: ${JSON.stringify(anchor)}`);
  return weakened === lines[at] ? text : [...lines.slice(0, at), weakened, ...lines.slice(at + 1)].join("\n");
};

/** 删掉登记表里 `status` 写点那一条登记（整行删 = 「这一格这一轴的登记被摸掉」那个形状）。 */
const cellAxesDropStatusWriteAnchor = (text) => {
  const at = cellAxesStatusWriteAnchorRow(text);
  if (at < 0) return text;
  const lines = text.split("\n");
  return [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n");
};

/**
 * 把登记表里 `${key}` 的 `${axis}` 那一行的 `kind:` 改成给定值：锚点与两份表的引用**都不动**，
 * 只有种类登记被改口（「种类登记造假」那族反向证的靶子）。那一格不在场或没改成 ⇒ 原样返回
 * ⇒ 由「变异没落上」判据报红。
 */
const rewriteCellAxesRowKind = (text, key, axis, kind) => {
  const at = cellAxesAnchorTableRow(text,
    (l) => l.includes(`key: "${key}", axis: "${axis}"`) && l.includes("kind:"));
  if (at < 0) return text;
  const lines = text.split("\n");
  const rewritten = lines[at].replace(/kind: "(?:code|comment)"/u, () => `kind: ${JSON.stringify(kind)}`);
  return rewritten === lines[at] ? text : [...lines.slice(0, at), rewritten, ...lines.slice(at + 1)].join("\n");
};

/**
 * #772 R4 M-A 的靶子（现读，不写死行号）：`compactionStats` 写点那一条 `kind: "code"` 锚点的
 * **字面量原文**（拿它当替换靶）、它命中的真写点行号，与同一键名的那句**注释**行号。
 * 拿不到靶子就返回 null ⇒ 下面那两条变异打不上 ⇒ 「变异没落上」判据报红，不会假绿。
 */
const CELL_AXES_R4_KIND_PROBE = (() => {
  const entry = CELL_AXES_ANCHORS_SHIPPED.find((e) => e.key === "compactionStats" && e.axis === "write" && e.kind === "code");
  if (entry === undefined) return null;
  const lines = textOf(entry.codePath).split("\n");
  const real = cellAxesAnchorHitLines(lines, entry).hits ?? [];
  if (real.length !== 1 || CELL_AXES_DISTRACTOR_LINE === null) return null;
  return { entry, literal: JSON.stringify(entry.anchor), realLine: real[0], commentLine: CELL_AXES_DISTRACTOR_LINE };
})();

/** 把两份契约里某条 `path:line` 同步改口到另一行（#772 R4：“两份引文同步改口”那个形状）。 */
const syncCellAxesCitation = (from, to) => (text) => text.split(from).join(to);

/**
 * #770 R2：M-A **反方向**那一例要「换进去的必须是一句真代码」。旧夹具拿 `status` 写点那条当“真代码”，
 * 而 #770 之后 `status` 写点自己就钉在「解释为什么这里没有写点」的注释行上 ⇒ 换进去的还是注释
 * ⇒ 种类轴没被逆 ⇒ 那一例只能报「行号不等值」，问不到它问的那件事。现在从出厂表里**现读**候选。
 * 唯一性必须按**闸实际会算法**算：本例只把 `anchor:` 的字面量换成候选，`kind` 与 `prev` 还是
 * `toolUse` 那一条的（现网：`round` 的锚点自带 `prev`，单独拿它的正则去扫会命中 4 行 ⇒ 闸先报「锚点
 * 歧义」就停了，种类判据根本轮不到出场）。所以这里把候选装进 `toolUse` 那条里重算：要求唯一命中、
 * 且那一行不是注释。抽不到 ⇒ null ⇒ 变异打不上 ⇒ 「变异没落上」报红。
 */
const CELL_AXES_R4_REVERSE_CODE_TARGET = (() => {
  const victim = CELL_AXES_ANCHORS_SHIPPED.find((e) => e.key === "toolUse" && e.axis === "write" && e.kind === "comment");
  if (victim === undefined) return null;
  for (const entry of CELL_AXES_ANCHORS_SHIPPED) {
    if (entry.axis !== "write" || entry.kind !== "code") continue;
    if (entry.codePath !== victim.codePath) continue;   // 换过去后是用 victim 的 codePath 扫的
    const lines = textOf(entry.codePath).split("\n");
    const hits = cellAxesAnchorHitLines(lines, { ...victim, anchor: entry.anchor }).hits ?? [];
    if (hits.length !== 1) continue;
    if (cellAxesAnchorLineIsComment(lines[hits[0] - 1])) continue;   // 必须是真代码行
    return { entry, literal: JSON.stringify(entry.anchor), line: hits[0] };
  }
  return null;
})();

/**
 * #770 R2：M-A「已知限度」特征用例的靶子（现算，不抄行号）：同一键名在 `src/loop/orchestrator.js` 里的
 * **另一处真代码行**。#770 之前夹具写死 `:3505`（那时它是快照载荷里的 `compactionStats,`），#770 把那格
 * 停写删行后，同一形状只剩 **run-state 落盘**那一份——它是**另一件产物**，正是这一例要钉的形状：
 * 锚点换到同键名的另一处真代码行 + 两份表同步改口 ⇒ 机械上全绿，而「快照这格的写点」这句话机器证不了。
 * 命中 0 或 >1、或那一行是注释 ⇒ null ⇒ 变异打不上 ⇒ 「变异没落上」报红。
 */
const CELL_AXES_R4_SAME_NAME_CODE_LINE = (() => {
  const anchor = "^ {6}compactionStats,$";
  const lines = textOf("src/loop/orchestrator.js").split("\n");
  const hits = lines.map((l, i) => (new RegExp(anchor, "u").test(l) ? i + 1 : 0)).filter((n) => n > 0);
  if (hits.length !== 1 || cellAxesAnchorLineIsComment(lines[hits[0] - 1])) return null;
  return { anchor, line: hits[0], citation: `src/loop/orchestrator.js:${hits[0]}` };
})();

/**
 * #770 R2：两轴表「今天的写点」那一列的列号（从标记区的**表头行**现算，不写死列号）。
 * 旧用例靠单元格里那句「（快照）」限定词认那一格，#770 之后它写的是「解释缺席的注释 + 快照轮记录」
 * ⇒ 字样变了 ⇒ 定位不到 ⇒ 变异空跑。现在跟闸自己读表用同一列（`cellAxesTableRefs` 读 `cells[5]`）；
 * 表头不在场或那一列改名 ⇒ -1 ⇒ 变异打不上 ⇒ 「变异没落上」报红。
 */
const cellAxesWriteColumnIndex = (lines) => {
  const begin = lines.findIndex((l) => l.includes(CELL_AXES_MARK_BEGIN));
  if (begin < 0) return -1;
  const header = lines.slice(begin + 1).find((l) => l.trim().startsWith("|"));
  if (header === undefined) return -1;
  return header.split("|").findIndex((c) => c.includes("今天的写点") || c.includes("Today's write site"));
};

/**
 * #772 R4 M-B 的靶子（现算）：每个**双锚点组**（同 key+axis+同名第几行+同文件上有两条登记）
 * 里挑一条，连同它在两份表里的那条引用一起删 ⇒ 剩下的仍然自洽（旧行为：两道闸全绿）。
 */
const CELL_AXES_R4_PAIR_VICTIMS = (() => {
  const bySlot = new Map();
  for (const entry of CELL_AXES_ANCHORS_SHIPPED) {
    const gk = cellAxesAnchorGroupKey(entry.key, entry.axis, entry.row ?? 0, entry.codePath);
    bySlot.set(gk, [...(bySlot.get(gk) ?? []), entry]);
  }
  const out = [];
  for (const [, list] of bySlot) {
    if (list.length < 2) continue;
    const entry = list[list.length - 1];
    const hits = cellAxesAnchorHitLines(textOf(entry.codePath).split("\n"), entry).hits ?? [];
    if (hits.length !== 1) continue;
    out.push({ entry, literal: JSON.stringify(entry.anchor), citation: `${entry.codePath}:${hits[0]}` });
  }
  return out.length >= 4 ? out : null;
})();

/** #772 R4 M-B：把双锚点组里那 N 条登记从表里摸掉（每条靠自己的锚点字面量定位）。 */
const dropCellAxesAnchorEntries = (text) => {
  if (CELL_AXES_R4_PAIR_VICTIMS === null) return text;
  let out = text;
  for (const { literal, entry } of CELL_AXES_R4_PAIR_VICTIMS) {
    const needle = `{ key: "${entry.key}", axis: "${entry.axis}"`;
    const lines = out.split("\n");
    const at = lines.findIndex((l) => l.includes(needle) && l.includes(literal));
    if (at < 0) return text;
    out = [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n");
  }
  return out;
};

/** #772 R4 M-B：把双锚点组里那 N 条引用从一份表里摸掉（只动写/读两格，不碰别的散文）。 */
const dropCellAxesCitations = (text) => {
  if (CELL_AXES_R4_PAIR_VICTIMS === null) return text;
  let out = text;
  for (const { citation } of CELL_AXES_R4_PAIR_VICTIMS) {
    if (!out.includes(citation)) return text;
    out = out.split(`\`${citation}\``).join("").replace(/\s*[，,、]\s*(?=[（(])/gu, "");
  }
  return out;
};

// issue #811：下面 #635 ① 那三例的锚点份数**由 `refScanCountTruth()` 现算**，不再写死。
// 写死那一份要求「每次覆盖面落地都有人记得回来改脚本」——0.32.0 中英指南落地把
// README 的 51/36 改成 53/38 那一刻没人想起来 ⇒ 变异落空、`--self-test` 2/224 未达预期，
// 而 `ci.yml` 不跑这条 ⇒ 在 main 上静默红着（PR #810 后发现）。锚点改取事实面之后
// 覆盖面再涨也不漂；变异改的仍是**当前真值**，判据一点没松（反向证：手写错一个份数仍红）。
const REF_SCAN_TRUTH = refScanCountTruth();

const SELF_TEST_CASES = [
  // —— pkg-block / exports：#210 报的四种破坏，**前两种修前是绿的** ——
  {
    label: "README 把 exports 的 \"./tools\" 改名（修前 exit 0）",
    overlay: { [README_EN]: (t) => t.replace('  "./tools": {', '  "./zzz": {') },
    expect: [/README\.md 的 `exports` 围栏键集合 缺 子路径键 "\.\/tools"/, /README\.md 的 `exports` 围栏键集合 多出真值里没有的 子路径键 "\.\/zzz"/],
  },
  {
    label: "README 删掉 exports 的 \"./tools\" 整个键（修前 exit 0）",
    overlay: { [README_EN]: (t) => t.replace('  "./tools": {\n    "types": "./src/tools/index.d.ts",\n    "default": "./src/tools/index.js"\n  },\n', "") },
    expect: [/README\.md 的 `exports` 围栏键集合 缺 子路径键 "\.\/tools"/],
  },
  {
    label: "README 的 exports 多一个 \"./zzz\" 键",
    overlay: { [README_EN]: (t) => t.replace('  "./contract-tests": "', '  "./zzz": "./test/contract/index.js",\n  "./contract-tests": "') },
    expect: [/README\.md 的 `exports` 围栏键集合 多出真值里没有的 子路径键 "\.\/zzz"/],
  },
  {
    label: "README 的 exports 把 \".\" 的值写错",
    overlay: { [README_EN]: (t) => t.replace('    "types": "./src/index.d.ts",', '    "types": "./src/nope.d.ts",') },
    expect: [/README\.md 的 `exports` 里键 "\." 的值与 package.json 不一致/],
  },
  {
    label: "README 的 exports 重复写同一个子路径键（JSON.parse 会静默吞掉）",
    overlay: { [README_EN]: (t) => t.replace('  "./tools": {', '  ".": {\n    "types": "./src/index.d.ts",\n    "default": "./src/index.js"\n  },\n  "./tools": {') },
    expect: [/子路径键 "\." 写了不止一次/],
  },
  // —— pkg-block / files：同一族 fail-open ——
  {
    label: "README 的 files 围栏删一项（连带块定位也会失效）",
    overlay: { [README_EN]: (t) => t.replace('```json\n[\n  "src",\n', '```json\n[\n') },
    expect: [/README\.md 的 `files` 围栏 缺 条目 "src"/],
  },
  {
    label: "README 的 files 围栏写重一项（集合相等但多了一份）",
    overlay: { [README_EN]: (t) => t.replace('  "LICENSE",\n', '  "LICENSE",\n  "LICENSE",\n') },
    expect: [/README\.md 的 `files` 围栏 的 条目清单里 "LICENSE" 写了不止一次/],
  },
  {
    label: "README 的 files 围栏被改坏（JSON 解不开 → 块找不到就是检查面失效）",
    overlay: { [README_EN]: (t) => t.replace('  "LICENSE",\n', '  "LICENSE",,\n') },
    expect: [/README\.md 找不到 `files` 清单围栏/],
  },
  // —— package.json 侧：中英两侧都必须红 ——
  {
    label: "package.json 加一个假子路径 → 中英都红",
    overlay: { "package.json": (t) => t.replace('    "./contract-tests": "', '    "./fake": "./src/fake.js",\n    "./contract-tests": "') },
    expect: [/README\.md 的 `exports` 围栏键集合 缺 子路径键 "\.\/fake"/, /README_cn\.md 的 `exports` 围栏键集合 缺 子路径键 "\.\/fake"/],
    expectFiles: [README_EN, README_CN],
  },
  {
    label: "package.json 的 files 加一个假条目 → 中英都红",
    overlay: { "package.json": (t) => t.replace('    "LICENSE",', '    "LICENSE",\n    "docs/host-upgrade-guide-9.9.9.md",') },
    expect: [/README\.md 的 `files` 围栏 缺 条目 "docs\/host-upgrade-guide-9\.9\.9\.md"/, /README_cn\.md 的 `files` 围栏 缺 条目 "docs\/host-upgrade-guide-9\.9\.9\.md"/],
    expectFiles: [README_EN, README_CN],
  },
  // —— anchors：vendor 跳过目录 ——
  {
    label: "契约 CN 的 vendor 跳过清单删一处 `target`",
    overlay: { [CONTRACT_CN]: (t) => t.replace("`node_modules`、`dist`、`build`、`target`、", "`node_modules`、`dist`、`build`、") },
    expect: [/host-consumer-contract_cn\.md.*缺 目录 "target"/],
  },
  {
    label: "源码 VENDOR_DIRECTORIES 加一档 → 中英四处都红",
    overlay: { "src/tools/file-tools.js": (t) => t.replace('new Set(["node_modules", "dist", "build", "target", "vendor"])', 'new Set(["node_modules", "dist", "build", "target", "vendor", "third_party"])') },
    expect: [/缺 目录 "third_party"/],
    expectFiles: [README_EN, README_CN, CONTRACT_EN, CONTRACT_CN],
  },
  // —— anchors：文件工具清单 / CLI 工具清单 ——
  {
    label: "契约 EN 的文件工具清单删一个 `edit`",
    overlay: { [CONTRACT_EN]: (t) => t.replace("  `edit` / `writeFile` schemas", "  `writeFile` schemas") },
    expect: [/host-consumer-contract\.md.*缺 工具名 "edit"/],
  },
  {
    label: "README EN 的 CLI 工具清单写一个源码里不存在的工具名（凭空多写）",
    overlay: { [README_EN]: (t) => t.replace("`writeFile`, and `exec`.", "`writeFile`, and `execx`.") },
    expect: [/README\.md.*多出真值与允许清单里都没有的 工具名 "execx"/],
  },
  {
    label: "README_cn 的 CLI 工具清单删一个 `edit`",
    overlay: { [README_CN]: (t) => t.replace("`tree`、`edit`、`writeFile` 和 `exec`", "`tree`、`writeFile` 和 `exec`") },
    expect: [/README_cn\.md.*缺 工具名 "edit"/],
  },
  {
    label: "源码改一个文件工具名 → 中英四处都红",
    overlay: { "src/tools/file-tools.js": (t) => t.replace('    name: "writeFile",', '    name: "writeFileNow",') },
    expect: [/缺 工具名 "writeFileNow"/, /多出真值里没有的 工具名 "writeFile"/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  // —— anchors：内置压缩策略名 ——
  {
    label: "README EN 的压缩策略名清单删一个 `fold-llm`",
    overlay: { [README_EN]: (t) => t.replace('"sliding-window" | "fold-statistical" | "fold-llm"', '"sliding-window" | "fold-statistical"') },
    expect: [/缺 策略名 "fold-llm"/],
  },
  {
    label: "源码加一个内置策略名 → 中英四处都红",
    overlay: { "src/compact/strategy-resolution.js": (t) => t.replace('  "fold-llm": createFoldLlmStrategy,', '  "fold-llm": createFoldLlmStrategy,\n  "zzz-window": createFoldLlmStrategy,') },
    expect: [/缺 策略名 "zzz-window"/],
    expectFiles: [README_EN, README_CN, CONTRACT_EN, CONTRACT_CN],
  },
  // —— anchors：formatSize 单位档位与示例映射 ——
  {
    label: "契约 EN 的单位清单删一处 `TB`（issue 正文的盲区复现）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("renders `B` / `KB` / `MB` / `GB` / `TB` on", "renders `B` / `KB` / `MB` / `GB` on") },
    expect: [/host-consumer-contract\.md.*缺 单位 "TB"/],
  },
  {
    label: "契约 CN 的单位清单把 `TB` 改名成 `TP`",
    overlay: { [CONTRACT_CN]: (t) => t.replace("`B`/`KB`/`MB`/`GB`/`TB`\n", "`B`/`KB`/`MB`/`GB`/`TP`\n") },
    expect: [/host-consumer-contract_cn\.md.*缺 单位 "TB"/, /多出真值里没有的 单位 "TP"/],
  },
  {
    label: "契约 EN 的单位清单整句删掉（逐处一致接不住，靠中英处数对账）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("(`B`/`KB`/`MB`/`GB`/`TB`, 1024 base,", "(human-readable, 1024 base,") },
    expect: [/单位清单.*声明点处数中英不齐/],
  },
  {
    label: "契约 EN 的示例映射把 1649267441664 写成 2.5TB",
    overlay: { [CONTRACT_EN]: (t) => t.replace("`1649267441664` → `1.5TB`", "`1649267441664` → `2.5TB`") },
    expect: [/把 1649267441664 写成 `2\.5TB`.*复算是 `1\.5TB`/],
  },
  {
    label: "契约 CN 的示例映射删掉一条（档位少一档 → 处数不齐）",
    overlay: { [CONTRACT_CN]: (t) => t.replace("`1536` → `2KB`、", "") },
    expect: [/示例映射.*声明点处数中英不齐/],
  },
  {
    label: "源码 formatSize 的 TB 档改名 → 档位清单与示例映射两层都红",
    overlay: { "src/tools/file-tools.js": (t) => t.replace("return `${(gb / 1024).toFixed(1)}TB`;", "return `${(gb / 1024).toFixed(1)}PB`;") },
    expect: [/缺 单位 "PB"/, /多出真值里没有的 单位 "TB"/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "源码 formatSize 的 MB 档改成两位小数 → 文档示例映射全红",
    overlay: { "src/tools/file-tools.js": (t) => t.replace("return `${mb.toFixed(1)}MB`;", "return `${mb.toFixed(2)}MB`;") },
    expect: [/写成 `1\.5MB`.*复算是 `1\.50MB`/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },

  // —— markers：marker 字面量与源码模板同源（issue #272；下面 4 例修前**全是 exit 0**）——
  {
    label: "契约 EN 把 marker 的 `（文件 <size>）` 段删掉（修前 exit 0）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("[共 N 行（文件 <size>），剩余 M 行", "[共 N 行，剩余 M 行") },
    expect: [/markers\/readMoreLines.*host-consumer-contract\.md:\d+ 引用的是 "\[共 N 行，剩余 M 行/, /渲染出来是 "\[共 N 行（文件 <size>）/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "契约 CN 把续读占位符 `offset=K` 写成 `offset=N`（修前 exit 0）",
    overlay: { [CONTRACT_CN]: (t) => t.replace("readFile 传 offset=K 继续", "readFile 传 offset=N 继续") },
    expect: [/markers\/readMoreLines.*host-consumer-contract_cn\.md:\d+ 引用的是 .*offset=N 继续.*，但按 src\/tools\/file-tools\.js/],
  },
  {
    label: "源码模板把「剩余」改成「还剩」→ 中英两处引用同时红",
    overlay: { "src/tools/file-tools.js": (t) => t.replace("剩余 ${values.total - values.offset}", "还剩 ${values.total - values.offset}") },
    // 逐处比对，每一处（EN 与 CN）单独成一条 error；期望两份都要被点名（[\s\S] 是因为 error 文本里带换行）
    expect: [/渲染出来是 "\[共 N 行（文件 <size>），还剩 M 行/, /markers\/readMoreLines marker 字面（契约中英引用）: docs\/host-consumer-contract(_cn)?\.md:\d+ 引用的是 .*但按 src\/tools\/file-tools\.js/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "源码 NEXT_STEP_CLAUSE 改文案 → 中英两处引用同时红（#267 只钉住了源码侧形状，没管文档）",
    overlay: { "src/tools/file-tools.js": (t) => t.replace('const NEXT_STEP_CLAUSE = "下一步：";', 'const NEXT_STEP_CLAUSE = "接着：";') },
    expect: [/渲染出来是 .*接着：readFile 传 offset=K/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "源码给 marker 模板加一个未登记的插值 → 红并点名未登记（不许拿旧字面比新真值）",
    overlay: { "src/tools/file-tools.js": (t) => t.replace("剩余 ${values.total - values.offset} 行", "剩余 ${values.total - values.offset} 行（从 ${values.offset + 1} 行起）") },
    expect: [/模板里有未登记的插值 .*values\.offset \+ 1/],
  },
  {
    label: "把 CN 契约那一处引用整段删掉 → 检查面失效 + 中英处数不齐",
    overlay: { [CONTRACT_CN]: (t) => t.replace("`[共 N 行（文件 <size>），剩余 M 行；下一步：readFile 传 offset=K 继续]`", "上面那张截断标记表里的续读提示") },
    expect: [/找不到以 `\[共 ` 开头的 marker 字面引用/, /声明点处数中英不齐：.* 1 处 vs .* 0 处/],
  },

  // —— paths：覆盖面与四类裁决（issue #273）——
  {
    label: "把 examples/pi-extension/README.md 里的同目录文件 `erix-run-core.js` 改个名（修前 exit 0）",
    overlay: { [PI_EXT_README]: mutateRef("erix-run-core.js", "erix-run-coreX.js") },   // #279：该值在本份文档里被提取到 4 处，全部定点换名
    expect: [/paths: examples\/pi-extension\/README\.md[\s\S]*`erix-run-coreX\.js`（第 \d+ 行）：本仓不存在/],
    expectFiles: [PI_EXT_README],
  },
  {
    label: "把根 README 引用的 docs/architecture.md 改名（既有行为不退化）",
    overlay: { [README_EN]: mutateRef("docs/architecture.md", "docs/architectureX.md") },   // #279：提取值是 URL 尾段，靶子由提取器定，不再靠人手工挑靶串
    // 变异要落在**真正被核对的那个引用**上：这行是 `[docs/architecture.md](https://…/blob/main/docs/architecture.md)`，
    // 只改链接文字动不了提取出的 href（URL 会被改写成仓内路径），所以上一版是“变异没接上检查面”而非锚点绿。
    // 上一版靠把靶串写成 `blob/main/…` 来手工避开链接文字（换一句措辞就失效）；#279 后 `mutateRef` 直接按
    // 提取值定位，链接文字天然不会被误伤——「打在哪」不再取决于靶串怎么写。
    expect: [/paths: README\.md[\s\S]*docs\/architectureX\.md/],
    expectFiles: [README_EN],
  },
  {
    label: "白名单不是整目录豁免：把已登记的 CHANGELOG 任务档案名改一个字 → 红",
    overlay: { "CHANGELOG.md": mutateRef("repro-circular-details.mjs", "repro-circular-detailsX.mjs") },   // #278 首次现场：旧写法只换第一次出现，散文提一句就抢枪
    // #279：报错的**措辞分支**取决于「被报告的那一行自己有没有写 `docs/tasks/`」（#273 定的口径），而报告
    // 的行 = 该值的**第一处出现**——散文里先提一句就会换掉那一行，于是旧期望「指向任务档案」会被无关措辞
    // 打断（#278 首次现场就是这条「红了但没点该点的名」）。期望钉的是**裁决**：点名改名后的引用、必须带行号、
    // 必须归到 LOCAL_ARCHIVE_REFS 那条口径上（两支措辞都满足）；不再钉某一支的措辞。不是放宽：仍然要点名到名字与行号。
    expect: [
      /archive-refs: CHANGELOG\.md[\s\S]*`repro-circular-detailsX\.mjs`（第 \d+ 行）/,
      /repro-circular-detailsX\.mjs[\s\S]*LOCAL_ARCHIVE_REFS/,
    ],
    expectFiles: ["CHANGELOG.md"],
  },
  {
    label: "就地声明就能放行（对照）：把已登记的 REPORT.md 换成没登记的 PLAN.md，同行仍写「本地，不入库」",
    overlay: { "docs/research/2026-09-26-strategy-variance-and-cache-economics.md": mutateRef(
      "docs/tasks/done/260926-strategy-variance-benchmark/REPORT.md",
      "docs/tasks/done/260926-strategy-variance-benchmark/PLAN.md") },   // #279：按提取值（整条路径）打靶，不拿子串去碰
    expectGreen: true,
  },
  {
    label: "把那句「（本地，不入库）」删掉 → 同一处立刻红（证明上一例的绿来自声明，不是恒绿）",
    overlay: {
      "docs/research/2026-09-26-strategy-variance-and-cache-economics.md": (t) =>
        mutateRef("docs/tasks/done/260926-strategy-variance-benchmark/REPORT.md",
          "docs/tasks/done/260926-strategy-variance-benchmark/PLAN.md")(
          t.replace("任务文档（本地，不入库）：", "任务文档：")),   // #279：文件名那一刀改成定点打靶，散文那一刀原样
    },
    expect: [/archive-refs: docs\/research\/2026-09-26[\s\S]*PLAN\.md[\s\S]*没在引用处写明|archive-refs: docs\/research\/2026-09-26[\s\S]*PLAN\.md[\s\S]*没写「本机/],
  },
  {
    label: "分类真的读 .gitignore：把 docs/tasks/ 从 .gitignore 里去掉 → 本机档案登记与放行全部失效",
    overlay: { ".gitignore": (t) => t.replace("docs/tasks/\n", "") },
    expect: [
      // 树形两侧同判（#280：这一类裁决**不得依赖实物存在**）：有 `docs/tasks/` 实物的树形里红在「登记失效」那一句，
      // 干净 clone / CI / 一次性沙箱里实物根本不存在、登记按声明放行，红就落在**引用侧**（同一个原因，不同那一句）。
      // 两个分支都要求点名 `docs/tasks`，所以不是拿「恒真」糊这一例。
      /登记为本机档案.*但 \.gitignore 并不忽略[\s\S]*docs\/tasks|archive-refs: [^\n]*引用了克隆后不存在的本机档案[\s\S]*docs\/tasks|paths: [^\n]*引用了无法裁决的仓库内路径[\s\S]*`docs\/tasks\/`/,
      /archive-refs: CHANGELOG\.md|paths: examples\/pi-extension\/README\.md|paths: AGENTS\.md/,   // 引用侧必须点名到文档（两种树形里至少中一个）
    ],
  },
  {
    label: ".gitignore 新增一条没分类的目录规则 → 红（不许默默放行新目录）",
    overlay: { ".gitignore": (t) => t.replace("docs/tasks/\n", "docs/tasks/\nscratch/\n") },
    expect: [/没在 IGNORED_DIR_CLASSES 里分类|没有一处引用真正用到它/],
  },
  {
    label: "#337 未登记的 ignore 目录规则必须点名那条规则本身，而不是报成「文档漂移」",
    // 病历（#337）：`.scratch/` 只在 `.git/info/exclude` 里时，本脚本**按文件系统**扫，对照树里的文件被当成
    // 仓内实物参与「唯一同名」解析，`check:docs` 当场变红——而红的是 `paths:` 的「无法裁决」，人以为是真文档漂移，
    // 白排查一轮。这一例把「新增目录规则未登记」那一句钉死：必须点名规则名与行号，且**不许**出现漂移 /
    // 无法裁决 / 白名单空转那类措辞（上一例的 expect 带 `|没有一处引用真正用到它` 的 OR，单独看不能证这件事）。
    overlay: { ".gitignore": (t) => t.replace("docs/tasks/\n", "docs/tasks/\nzz-337-probe-dir/\n") },
    expect: [/paths: \.gitignore:\d+ 的目录规则 `zz-337-probe-dir\/` 没在 IGNORED_DIR_CLASSES 里分类/],
    reject: [/漂移/, /引用了无法裁决的仓库内路径/, /白名单条目/],
  },
  {
    label: "#337 同一目录登记类别之后不再产生任何红，且真的整目录不进扫描面（反向证的另一半）",
    // 登记只能来自运行时那张 Map（overlay 只改**文本**，与 simulateLooseDecl 同一课），所以走配置口子；
    // 跑完在 finally 里还原。绿只能证明「静态分类不再报」，所以再加一句 assertAfter：这条类别必须在
    // `SKIPPED_DIR_KINDS` 里——否则 `.scratch/` 里的文件会重新进入实物解析（本单要防的静默污染）。
    overlay: { ".gitignore": (t) => t.replace("docs/tasks/\n", "docs/tasks/\nzz-337-probe-dir/\n") },
    simulateIgnoreDirClass: { pattern: "zz-337-probe-dir/", kind: "scratch", why: "#337 自测探针：丢弃型临时目录" },
    expectGreen: true,
    assertAfter: () => (ignoredDirIsSkipped({ pattern: "zz-337-probe-dir/" })
      ? null
      : "登记了但这条类别没进 SKIPPED_DIR_KINDS（整目录仍会被扫）——绿只是「静态分类不再报」，"
        + "真实 `.scratch/` 里的文件照样会参与「唯一同名」解析与近邻判据；把 scratch 加进那张显式清单"),
  },
  {
    label: "白名单条目变空转：两处引用（examples README 与 CHANGELOG 的同名提及）全改掉 → 该登记被判失效",
    overlay: {
      // #273 把 archive 类的三级解析接上后，CHANGELOG:89 的裸名提及也算一处真实引用；只下掉一处只会
      // 让那一处红，要证「登记空转」得把两处都下掉。
      [PI_EXT_README]: mutateRef("e2e-wake.mjs", "e2e-wake-v2.mjs"),
      "CHANGELOG.md": mutateRef("e2e-wake.mjs", "e2e-wake-v2.mjs"),
      "docs/research/2026-10-13-pi-subagents-async-attribution.md": mutateRef("e2e-wake.mjs", "e2e-wake-v2.mjs"),   // #279：三份文档各自按提取值定点，不再拿反引号靶串去猜第一次出现在哪
    },
    expect: [/白名单条目 `e2e-wake\.mjs` 没有一处引用真正用到它/],
  },

  // —— #280：门禁不得隐含依赖「检查机上恰好有被 .gitignore 忽略的 docs/tasks/」（修前全新 clone 必红）——
  // #302：这两例改成在**合成树夹具**上跑，三种树形（无目录 / 空目录 / 有档案）各跑一遍、各自断言。
  // 旧写法只在「无目录」那一格能跑通：「目录在、里面是空的」的机器上，自测自己的落地检查（拿真实
  // 实物数量当判据）恒真地误报 2 例——于是 CI 上 0 红、开发机上 2 红，同一提交两个结论。
  {
    label: "#280 树形对照：本机没有/空着/有 docs/tasks/ 三种树形下，本机档案类必须整片绿（合成树夹具）",
    // 修前：同一提交在 `git archive HEAD` 解出来的树里 check:docs exit 1（10 条）、工作树里 exit 0——
    // 「本机档案」的裁决把「实物在 docs/tasks/ 下解得到」当成了放行前提。这一例把那棵树的形状钉进自测：
    // 声明一侧（登记表 / 就地声明 / .gitignore 规则）一个字没动，只把实物换成夹具声明的那一份，必须仍 0 错。
    simulateTreeShapes: TREE_SHAPES,
    expectGreen: true,
  },
  {
    label: "#280 上一例的绿不是「整类不裁决」：同一批树形里把已登记裸名改成未登记的假名 → 三种树形都仍红",
    // 「本机档案默认按声明放行」很容易被糊成「干脆整类不裁决」——这条就是抓它的：树形一样是夹具那三份，
    // 但引用改成了既未登记、也解不到的假名，必须照样红并点名那处引用（与上一例共用同一批树形夹具）。
    simulateTreeShapes: TREE_SHAPES,
    overlay: { "docs/research/2026-10-13-pi-subagents-async-attribution.md": mutateRef("e2e-wake.mjs", "e2e-wake-cloneQ.mjs") },
    expect: [/archive-refs: docs\/research\/2026-10-13[\s\S]*`e2e-wake-cloneQ\.mjs`（第 \d+ 行）[\s\S]*本仓不存在/],
    expectFiles: ["docs/research/2026-10-13-pi-subagents-async-attribution.md"],
  },

  // —— bare-names：无斜杠裸名的通用裁决 + 近邻判据（issue #278；下面四条修前**全是 exit 0**）——
  {
    label: "#278-P2 改坏**已登记**的裸名（`repro-circular-details.mjs` 多个 Q）→ 红（修前 exit 0：脱离登记就静默放行）",
    overlay: { "docs/research/2026-10-13-pi-subagents-async-attribution.md": mutateRef("repro-circular-details.mjs", "repro-circular-detailsQ.mjs") },
    expect: [
      /archive-refs: docs\/research\/2026-10-13[\s\S]*`repro-circular-detailsQ\.mjs`（第 \d+ 行）/,
      // 近邻提示（↳ 它跟本仓实物只差一点）拿的是**被 .gitignore 忽略但本机真在**的实物：干净 clone 里没有
      // `docs/tasks/`，实物无从比对，红的就是「解不到 + 未登记」那一句。两个分支都点名了被改坏的名字，
      // 所以不是放宽：本例的主命题（改坏已登记的裸名必须红并点名）在两种树形里都被铉住。
      /↳ 它跟本仓实物只差一点：docs\/tasks\/active\/261010-13-erix-run-async\/repro-circular-details\.mjs|`repro-circular-detailsQ\.mjs`（第 \d+ 行）：本仓不存在[\s\S]*不属于四类里的任何一类/,
    ],
    expectFiles: ["docs/research/2026-10-13-pi-subagents-async-attribution.md"],
  },
  {
    label: "#278-P3 改坏**未登记**的裸名（`e2e-wake.mjs` 多个 Q）→ 红（修前 exit 0：它本来连被检资格都没有）",
    overlay: { "docs/research/2026-10-13-pi-subagents-async-attribution.md": mutateRef("e2e-wake.mjs", "e2e-wakeQ.mjs") },
    expect: [
      /archive-refs: docs\/research\/2026-10-13[\s\S]*`e2e-wakeQ\.mjs`（第 \d+ 行）[\s\S]*本仓不存在/,
      // 同上：近邻提示只在「本机有 task-archive 实物」的树形里存到，另一棵树上红在「解不到 + 未登记」那一句。
      /↳ 它跟本仓实物只差一点：docs\/tasks\/active\/261010-13-erix-run-async\/e2e-wake\.mjs（比实物名字干多写了 “Q”）|`e2e-wakeQ\.mjs`（第 \d+ 行）：本仓不存在[\s\S]*不属于四类里的任何一类/,
    ],
    expectFiles: ["docs/research/2026-10-13-pi-subagents-async-attribution.md"],
  },
  {
    label: "跳仓对照文档里的裸名不被裁决（对照）：把 codex 篇的 `MEMORY.md` 改个名必须仍然绿",
    // #278 裁定的另一面：跳仓/宿主对照文档（CROSS_REPO_DOCS 逐份点名那批）的裸名指的不是本仓实物，
    // 不该被拖进裁决面——这一例就是防「把 79 处跳仓引用用另一种方式再吃回来」。近邻判据不在此列，
    // 所以变异选 `MEMORY.md`（5 字干，低于 NEAR_STEM_MIN=8，不会误判成本仓实物改名）。
    overlay: { "docs/harness-comparison/03-codex.md": mutateRef("MEMORY.md", "MEMORYX.md") },   // #279：该值在这篇里有 5 处，全部定点换名（仍全绿才叫「跳仓裸名不被裁决」）
    expectGreen: true,
  },
  {
    label: "#269 原型：裁决清单内新写一个**凭空、无近邻**的裸名（`analysis.md` 形状）→ 红（这是近邻判据拓不到的那一半）",
    overlay: { "docs/research/2026-09-26-strategy-variance-and-cache-economics.md": mutateRef("debug.routes.js", "zz-nonexistent-evidence.md") },
    // #279：期望不再钉「第 118 行」这个**地址**——它钉的是「报错必须给出行号」；写死行号时，只要有人
    // 在那行以上加一句散文（哪怕提的是不相干的名字）这一例就会红，而那恰好就是本单要修的病。
    expect: [/archive-refs: docs\/research\/2026-09-26[\s\S]*`zz-nonexistent-evidence\.md`（第 \d+ 行）[\s\S]*本仓不存在/],
    expectFiles: ["docs/research/2026-09-26-strategy-variance-and-cache-economics.md"],
  },
  {
    label: "跳仓点名清单也不许烂着：那份文档已没一处裸名引用要用豁免 → 销账红（反向校）",
    // docs/harness-comparison/README.md 里需要豁免的裸名就是 `MEMORY.md` 两处；全改成能解析的实物名后，
    // 这条逐份点名的豁免就成了空条目 → 必须红（否则清单会默默堆着没人用的条目）。
    overlay: { "docs/harness-comparison/README.md": mutateRef("MEMORY.md", "AGENTS.md") },   // #279：原本就是 replaceAll，但它是「按子串」而不是「按提取值」，一并改成定点
    expect: [/bare-names: 跳仓点名清单里的 `docs\/harness-comparison\/README\.md` 现在没有一处裸名引用用上它/],
  },
  {
    label: "登记表反向校扩到裸名（#278 第 4 件）：本仓文档里已没人引用已登记的裸名 `repro-circular-details.mjs` → 销账红",
    // 两条引用（CHANGELOG 与 research 篇）全改成能解析的路径后，这条**无斜杠**登记就没人用了；
    // 反向校必须抓得住（#273 只对带斜杠条目做到了这件事）。
    overlay: {
      "CHANGELOG.md": mutateRef("repro-circular-details.mjs", "docs/tasks/active/261010-13-erix-run-async/repro-circular-details.mjs"),
      "docs/research/2026-10-13-pi-subagents-async-attribution.md": mutateRef("repro-circular-details.mjs", "docs/tasks/active/261010-13-erix-run-async/repro-circular-details.mjs"),   // #279：#280 现场——旧写法只换第一处，散文提一句就抢枪 → 该红的不红
    },
    expect: [/白名单条目 `repro-circular-details\.mjs` 没有一处引用真正用到它/],
  },
  {
    label: "近邻判据**不**跟跳仓豁免一起免：跳仓文档里把本仓实物名改坏一个尾缀 → 仍红",
    // 防的是反向滑坡：「这份文档在讲别的仓库」不等于本仓实物在它就是绿的。拿 `README.md`（能解析）
    // 换成 `erix-run-coreX.js`（本仓有 erix-run-core.js，只差一个 X），必须靠近邻判据抓红。
    overlay: { "docs/harness-comparison/02-touwaka.md": mutateRef("README.md", "erix-run-coreX.js") },   // #279：按提取值打靶（该值这篇里 2 处），不再拿「`README.md` 全文」这整串措辞当靶
    expect: [/archive-refs: docs\/harness-comparison\/02-touwaka\.md[\s\S]*`erix-run-coreX\.js`（第 \d+ 行）[\s\S]*examples\/pi-extension\/erix-run-core\.js/],
  },
  {
    label: "简称登记也要反向校（#278 新增第五类）：CHANGELOG 里的 `format.js` 简称改成实物路径后，简称条目就该销账",
    overlay: { "CHANGELOG.md": mutateRef("format.js", "examples/pi-extension/erix-run-format.js") },   // #279：同上，从「反引号 + 子串 replaceAll」改成按提取值定点
    expect: [/白名单条目 `format\.js` 没有一处引用真正用到它/],
  },

  // —— #279：在文档里「提一句同一个文件名」不许抢走变异的那一枪（打靶位置无关）——
  // 三次现场（#278 收尾 3 红、#280 收尾 2 红）全部指向同一个名字：别人只是**在散文里提了一句**
  // `repro-circular-details.mjs`，旧变异体（`t.replace("X.mjs", …)` 只换第一次出现）的那一枪就打在
  // 那句散文上——真正的引用一个字没动 → 「该红的不红」，还被自测报成 `改了但没红（锚点仍是 fail-open）`
  // 这个**假警报**（同一份树上 `check:docs` 明明 exit 0）。下面两条把这个形状钉住：第 1 条**修前就是红的**
  // （#280 那条「改了但没红」），第 2 条修前也绿——它钉的是「提一句」这个动作本身绝不该让门禁红；
  // 修前真正红的是**同树的其它用例**（拿 `git show HEAD:` 取出的修前脚本跑同一棵树：2/57 红，见 CHANGELOG #279）。
  {
    label: "#279 提一句不许抢枪：CHANGELOG 靠前散文先提一句已登记的裸名，再把两份文档里的裸名引用改成真实路径 → 销账红必须照样在（修前：散文那一处才是第一次出现 → 该红的不红）",
    overlay: {
      // mention 就是把「提一句」那个动作放进自测：插在第一处 `## ` 标题之前，比任何真引用都早。
      "CHANGELOG.md": mutateRef("repro-circular-details.mjs",
        "docs/tasks/active/261010-13-erix-run-async/repro-circular-details.mjs",
        { mention: "自测探针（#279）：这里只是在散文里提一句那个已登记的任务档案裸名 `repro-circular-details.mjs`。" }),
      "docs/research/2026-10-13-pi-subagents-async-attribution.md": mutateRef("repro-circular-details.mjs",
        "docs/tasks/active/261010-13-erix-run-async/repro-circular-details.mjs"),
    },
    expect: [/白名单条目 `repro-circular-details\.mjs` 没有一处引用真正用到它/],
  },
  {
    label: "#279 提一句本身不该让门禁红（对照）：只在 CHANGELOG 靠前插那句散文、什么也不改 → 必须 0 错（名字已登记，门禁不该因为一个名字被提到就改口）",
    overlay: { "CHANGELOG.md": mentionInProse("自测探针（#279）：这里只是在散文里提一句那个已登记的任务档案裸名 `repro-circular-details.mjs`。") },
    expectGreen: true,
  },

  // —— 工具事实契约面：契约文档的字段清单 ↔ TOOL_RESULT_CONTRACT（工单 261014 T1）——
  // 四种形状都钉住：只改文档→红、只改常量→红（中英两侧都红）、删掉整句→红、
  // 「变异没打上」→红（runSelfTest 的 `after === before` 判据，#210 R2 口径）。
  {
    label: "契约 EN 的引擎字段清单删一处 `durationMs`（只改文档）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("`toolCallKey` / `round` / `durationMs` / `executionStatus` /", "`toolCallKey` / `round` / `executionStatus` /") },
    expect: [/字段清单: docs\/host-consumer-contract\.md:\d+.*缺 引擎字段 "durationMs"/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "契约 CN 的引擎字段清单把 `success` 改名成 `ok`（只改文档、改名不是「删」）",
    overlay: { [CONTRACT_CN]: (t) => t.replace("`executionStatus` / `success`。", "`executionStatus` / `ok`。") },
    expect: [/host-consumer-contract_cn\.md.*缺 引擎字段 "success"/, /多出真值里没有的 引擎字段 "ok"/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "契约 EN 把「exactly five fields」那句整句改成不含清单的话（删掉整句 → 检查面失效 + 中英处数不齐）",
    overlay: { [CONTRACT_EN]: (t) => t.replace(
      "The engine namespace has exactly five fields, every one of them\naddressed as `erix.<field>`: `toolCallKey` / `round` / `durationMs` / `executionStatus` /\n`success`.",
      "The engine namespace is a namespace addressed per field.") },
    expect: [/找不到引擎字段清单声明/, /声明点处数中英不齐：docs\/host-consumer-contract\.md 0 处 vs docs\/host-consumer-contract_cn\.md 1 处/],
  },
  {
    label: "契约 EN 把「exactly five fields」改成 six（数量声明也是事实，不靠清单接）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("exactly five fields", "exactly six fields") },
    expect: [/声称引擎命名空间有「six」个字段.*engine\.fields 是 5 个/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "契约 EN 的存在性矩阵表头把 `erix.durationMs` 改名 → 矩阵列单独红",
    overlay: { [CONTRACT_EN]: (t) => t.replace("| Case | erix.toolCallKey | erix.round | erix.durationMs |", "| Case | erix.toolCallKey | erix.round | erix.elapsedMs |") },
    expect: [/存在性矩阵列: docs\/host-consumer-contract\.md:\d+.*缺 矩阵列.*"durationMs"/, /多出真值里没有的 矩阵列.*"elapsedMs"/],
  },
  {
    label: "契约 CN 的字段归属表把引擎命名空间写成 `engine.toolCallKey` → 命名空间名不一致就红",
    overlay: { [CONTRACT_CN]: (t) => t.replace("| `erix.toolCallKey` | 引擎 |", "| `engine.toolCallKey` | 引擎 |") },
    expect: [/把引擎字段写成 `engine\.toolCallKey`.*engine\.ns 是 "erix"/, /缺 引擎字段行 "toolCallKey"/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "契约 CN 的 legacy 别名表把 `duration` 的新归属写成 `erix.elapsedMs` → 别名值与常量不齐",
    overlay: { [CONTRACT_CN]: (t) => t.replace("| `duration` | `erix.durationMs` |", "| `duration` | `erix.elapsedMs` |") },
    expect: [/把 `duration` 的新归属写成 `erix\.elapsedMs`.*常量里的别名是 `erix\.durationMs`/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "常量里新增一个引擎字段 → 中英两侧同时红（清单缺、表缺、数量也不对）",
    overlay: { "src/tool-fact.js": (t) => t.replace(
      "    fields: {\n      toolCallKey: {",
      "    fields: {\n      zzzExtra: {\n        owner: \"engine\",\n        stages: [\"result\"],\n        resumeStable: true,\n        onWire: false,\n      },\n      toolCallKey: {") },
    expect: [/缺 引擎字段 "zzzExtra"/, /缺 引擎字段行 "zzzExtra"/, /声称引擎命名空间有「five」个字段.*是 6 个/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "常量里删掉一个引擎字段（success）→ 中英两侧「文档多写了」必须红",
    overlay: { "src/tool-fact.js": (t) => t.replace(/      success: \{\n[\s\S]*?\n      \},\n/, "") },
    expect: [/多出真值里没有的 引擎字段 "success"/, /多出真值里没有的 引擎字段行 "success"/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "常量把 engine.ns 改名（erix → engine）→ 中英两侧的 `erix.*` 声明全红",
    overlay: { "src/tool-fact.js": (t) => t.replace('    ns: "erix",', '    ns: "engine",') },
    expect: [/engine\.ns 是 "engine"/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "常量给协议必需字段加一项 → 中英两侧的协议字段行同时红",
    overlay: { "src/tool-fact.js": (t) => t.replace('required: ["type", "tool_use_id", "content"],', 'required: ["type", "tool_use_id", "content", "cursor"],') },
    expect: [/协议字段行.*缺 协议字段 "cursor"/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "契约 EN 把「保留顶层键名」那段整段删掉（只改文档：该文件的检查面失效必须当场红，不靠中英处数）",
    overlay: { [CONTRACT_EN]: (t) => t.replace(/^`metadata` and `erix` are \*\*reserved[\s\S]*?no longer reach those fields\.\n/m, "") },
    expect: [/docs\/host-consumer-contract\.md 找不到保留键名的声明/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "契约 CN 的保留键名那段少写一个 `erix`（只改文档、少一个键名也是漂移）",
    overlay: { [CONTRACT_CN]: (t) => t.replace("`metadata` 与 `erix` 是**保留的顶层键名**", "`metadata` 是**保留的顶层键名**") },
    expect: [/保留键名: docs\/host-consumer-contract_cn\.md.*缺 保留键名 "erix"/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "常量只改保留键名的登记、不改命名空间名（erix → engine）→ 源码自洽 + 中英文档同时红",
    overlay: { [TOOL_FACT_SRC]: (t) => t.replace('topLevelKeys: ["metadata", "erix"]', 'topLevelKeys: ["metadata", "engine"]') },
    expect: [/自相矛盾——保留键名登记的是 metadata \/ engine/, /缺 保留键名 "engine"/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },

  {
    // T2 把这张表从「双写对照表」改成**退役名单**（多了一条 `success`），所以「少一行」必须红：
    // 只删不改的退役条目最容易在文档里被漏掉，而漏掉就等于宿主不知道要迁移什么。
    label: "契约 EN 的退役名单少写 `success` 那一行（只改文档：T2 新增的那条退役名被漏掉）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("| `success` | `erix.success` |\n", "") },
    expect: [/legacy 别名表: docs\/host-consumer-contract\.md.*缺 旧顶层键 "success"/,
      /alias: 声明点处数中英不齐：docs\/host-consumer-contract\.md 3 处 vs docs\/host-consumer-contract_cn\.md 4 处/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "常量把 legacy 别名的新归属改名 → 中英两侧的别名表同时红",
    overlay: { "src/tool-fact.js": (t) => t.replace('duration: "erix.durationMs",', 'duration: "erix.elapsedMs",') },
    expect: [/常量里的别名是 `erix\.elapsedMs`/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },

  // —— baseline：AGENTS 的棘轮当前值 ↔ 棘轮常量（issue #274）——
  {
    label: `AGENTS EN 把基线写成 142（#265 当年留在 CHANGELOG 的那种开发中途值）（修前 exit 0）`,
    overlay: { [AGENTS_EN]: (t) => t.replace(`baseline constant **${B_ROOT}**`, "baseline constant **142**") },
    expect: [new RegExp(`baseline\\/「基线常量 \\/ baseline constant」声明: AGENTS\\.md:\\d+ 声称 142，但 scripts\\/type-check-ratchet\\.mjs 的 BASELINE_ROOT 是 ${B_ROOT}`)],
    expectFiles: [AGENTS_EN],
  },
  {
    label: `AGENTS CN 把常量写法写成 ${B_ROOT - 1} → 点名 AGENTS_cn.md`,
    overlay: { [AGENTS_CN]: (t) => t.replace(`BASELINE_ROOT = ${B_ROOT}`, `BASELINE_ROOT = ${B_ROOT - 1}`) },
    expect: [new RegExp(`baseline\\/常量写法 \`BASELINE_ROOT = N\`: AGENTS_cn\\.md:\\d+ 声称 ${B_ROOT - 1}，但 .* BASELINE_ROOT 是 ${B_ROOT}`)],
    expectFiles: [AGENTS_CN],
  },
  {
    label: `command-reference EN 把棘轮值写错 → 点名冷层文档行`,
    overlay: { [CMDREF_EN]: (t) => t.replace(`BASELINE_ROOT = ${B_ROOT}`, `BASELINE_ROOT = ${B_ROOT - 1}`) },
    expect: [new RegExp(`baseline\\/常量写法 .*docs\\/maintenance\\/command-reference\\.md:\\d+ 声称 ${B_ROOT - 1}，但 .* BASELINE_ROOT 是 ${B_ROOT}`)],
    expectFiles: [CMDREF_EN],
  },
  {
    label: "棘轮常量自己降 1 → 中英两侧的当前值句式全红",
    overlay: { [RATCHET_SRC]: (t) => t.replace(`const BASELINE_ROOT = ${B_ROOT};`, `const BASELINE_ROOT = ${B_ROOT - 1};`) },
    expect: [new RegExp(`BASELINE_ROOT 是 ${B_ROOT - 1}`)],
    expectFiles: [AGENTS_EN, AGENTS_CN],
  },
  {
    label: `CN 的分解式写成 ${B_ROOT} + ${B_SPLIT.b} + ${B_SPLIT.c - 1} → 算术不闭合就红`,
    overlay: { [AGENTS_CN]: (t) => t.replace(`= ${B_ROOT} + ${B_SPLIT.b} + ${B_SPLIT.c}`, `= ${B_ROOT} + ${B_SPLIT.b} + ${B_SPLIT.c - 1}`) },
    expect: [new RegExp(`分解式 ${B_ROOT} \\+ ${B_SPLIT.b} \\+ ${B_SPLIT.c - 1} = ${B_ROOT + B_SPLIT.b + B_SPLIT.c - 1}，不等于 BASELINE_WITH_TOOLS（${B_WT}）`)],
    expectFiles: [AGENTS_CN],
  },
  {
    // issue #802：原来这一例证的是「中英句式处数必须相等」，而那条判据已经按「散文警察」被删掉了。
    // 现在它证的是**新的契约**：某份文档里这条句式一处都不剩 ⇒ 绿（不是「没人看见」，而是「不存在就没得对账」），
    // 与上两例（句子在、数写错 ⇒ 红）配成一对，保证这次放宽没有把「出现就必须对」一起放宽掉。
    // 靶子用**全局**替换把 AGENTS.md 里这条句式的命中清零（只删一处时，剩下那处仍然对得上 ⇒ 绿，
    // 那样这一例就证不到「零命中 ⇒ 绿」）。
    label: "AGENTS.md 里这条句式一处不剩 ⇒ 绿（#802：不存在就没得对账，但存在的必须对）",
    overlay: { [AGENTS_EN]: (t) => t.replace(/baseline \*\*\d+\*\* \/ \d+ files/g, "baseline spread over some files") },
    expectGreen: true,
  },
  {
    label: "历史值不被误伤（对照）：CN 叙述里的退役基线 142 / 185 改成 143 / 185 必须仍然绿",
    // 靶子换过两次（issue #650 / #802）：原来钉的是「**无 `.d.ts` 在场 = 142 个错**」（B 类抄件，
    // 清账时按「命令自己打印」改写了），#650 换成同一份文档里退役基线叙述；261109 指令面瘦身后
    // 那串数字仍在（「实测 142 / 185 / 218 / 226 / 261」），所以靶子只跟着措辞换。变异没落上仍然算失败。
    overlay: { [AGENTS_CN]: (t) => t.replace("实测 142 / 185 / 218 / 226 / 261", "实测 143 / 185 / 218 / 226 / 261") },
    expectGreen: true,
  },
  {
    label: "AGENTS 中英标题骨架缺一边（#274 附带项：AGENTS 也纳入骨架对账）",
    overlay: { [AGENTS_CN]: (t) => t.replace("## 3. 开发命令", "#### 3. 开发命令") },
    // 变异必须只落在 CN 一侧（EN 写的是 "3. Development commands"）：两边都有的标题字串拿去变异会同时
    // 改掉两份文档，骨架差异被抹平 → 反向证自身失效（#274）。
    expect: [/skeleton: 中英 AGENTS/],
  },

  // —— 符号锚点与裸行号棘轮（issue #286 T-a：R1/R2/R3 的反向证，#210 R2 口径四条齐全）——
  // ① 只改文档（符号名改错）→ 红；② 只改真值（源码里给符号改名）→ 红；③ 新增裸行号 → 红；
  // ④ 行号越界 → 红；⑤ 变异没打上 → 红（`expectMutateMiss`，见 `runSelfTest`）；
  // 外加「合法锚点必须绿」「基线调回必须绿」两条放行证，证明这些锚点不是恒红。
  {
    label: "#286 符号锚点：契约 CN 把 `emitEvent` 改成 `emitEventProbe`（只改文档，修前门禁全绿）",
    overlay: { [CONTRACT_CN]: mutateSymbolAnchor("emitEvent", "src/loop/orchestrator.js", "emitEventProbe") },
    // 行号写成 `\d+`：这条断言查的是「点不点得出那个错符号」，而文档行号会随任何一次契约改动漂移
    // （issue #409 加一节契约就把 84 顶到 119）——把行号钉死等于给每次文档改动埋一颗哑雷（#286 的同一个病）。
    expect: [/symbol-anchor: docs\/host-consumer-contract_cn\.md:\d+ 引用 `emitEventProbe`（`src\/loop\/orchestrator\.js`/,
      /实际存在的相近符号：.*emitEvent/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#286 符号锚点：把真值一侧的 `defaultSleep` 改名（只改源码，中英引用同时红）",
    overlay: { "src/loop/abort.js": (t) => t.replace("export function defaultSleep(", "export function defaultSleepRenamed(") },
    expect: [/symbol-anchor: .*引用 `defaultSleep`（`src\/loop\/abort\.js`/, /实际存在的相近符号：.*defaultSleepRenamed/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#286 符号锚点不是恒红（对照）：在 AGENTS EN 加一处**合法**符号锚点 → 必须 0 错",
    overlay: { [AGENTS_EN]: mentionInProse("自测探针（#286）：`defaultSleep`（`src/loop/abort.js`）是一处合法的「符号 + 文件」锚点。") },
    expectGreen: true,
  },
  {
    label: "#286 棘轮：在 AGENTS EN 临时多写一处**合法**裸行号 `src/loop/termination.js:12` → 红（新增就红，越界都没有）",
    overlay: { [AGENTS_EN]: mentionInProse("自测探针（#286）：这里临时多写一处合法裸行号引用 `src/loop/termination.js:12`。") },
    expect: [ratchetOverBaseline(BARE_LINE_REF_BASELINE + 1, BARE_LINE_REF_BASELINE), /AGENTS\.md 1/],
    expectFiles: [AGENTS_EN],
  },
  // —— #772 两轴载荷表的「标记区定点豁免」：豁免只认标记区，且**闸自己按锚点重算**（R3）——
  {
    label: `#772 豁免只管标记区内：把表里同一条裸行号 \`${CELL_AXES_PROBE_REF}\` 原样拄到标记区**外** → 红（区外照旧逐条计数）`,
    overlay: { [CONTRACT_CN]: (t) => (CELL_AXES_PROBE_REF === null ? t
      : t.replace(CELL_AXES_MARK_BEGIN,
        `自测探针（#772）：表里那条 \`${CELL_AXES_PROBE_REF}\` 被原样拄到标记区外 ⇒ 它不再被定点豁免。\n${CELL_AXES_MARK_BEGIN}`)) },
    expect: [ratchetOverBaseline(BARE_LINE_REF_BASELINE + 1, BARE_LINE_REF_BASELINE), /host-consumer-contract_cn\.md \d+/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: `#772 豁免绑机器复核：把 ${CELL_AXES_GUARD_TEST} 整份清空（等价于被改名/移除）→ 豁免失效、闸回红并点名`,
    overlay: { [CELL_AXES_GUARD_TEST]: () => "" },
    expect: [/bare-lines: 标记区定点豁免的机器复核不在场/, /不在场或空了/,
      /裸行号引用（唯一 \(文档,目标文件,行区间\)）实测 \*\*\d+\*\* 处，超过棘轮基线 \*\*\d+\*\*/],
  },
  {
    label: `#772 R3 单一真值不许断：把 ${CELL_AXES_GUARD_TEST} 里对 ${CELL_AXES_ANCHOR_MODULE} 的 import 改名 → 红（测试读的和闸读的不再是同一张表）`,
    overlay: { [CELL_AXES_GUARD_TEST]: replaceUnique('from "../scripts/cell-axes-anchors.mjs"', 'from "../scripts/cell-axes-anchors-moved.mjs"') },
    expect: [/bare-lines: 标记区定点豁免的机器复核不在场/, /没有 import/, /cell-axes-anchors\.mjs/,
      /裸行号引用（唯一 \(文档,目标文件,行区间\)）实测 \*\*\d+\*\* 处，超过棘轮基线 \*\*\d+\*\*/],
  },
  {
    label: `#772 对照：给 ${CELL_AXES_GUARD_TEST} 只加一行尾注释（import 没动）→ 必须 0 错（证明绑定的不是恒红）`,
    overlay: { [CELL_AXES_GUARD_TEST]: (t) => `${t}\n// self-test 复原探针（#772）：只加一行注释，锚点模块的 import 没动。\n` },
    expectGreen: true,
  },
  {
    // #770 R2：靶子坐标换了，问的事没换。旧靶子是锤在快照载荷里那行 `status,`（`"^ {8}status,$"`），
    // 那一行已随 #770 停写消失；现在这一格的写轴登记本身就是一条 `kind: "comment"` 锚点（钉「这里为什么
    // 没有写点」那句注释）。把它削弱成**键名词面**仍然应当 ⇒ 词面命中多处 ⇒ 锚点歧义 ⇒ 不再被豁免。
    label: "#772 豁免不是「行号在范围内就行」的免检通道：把 `status` 写点的锚点削弱成**键名本身**（词面判据就是这个形状）→ 闸自己重算当场发现锚点歧义、那条引用掉出豁免、棘轮回红",
    overlay: { [CELL_AXES_ANCHOR_MODULE]: (t) => cellAxesWeakenAnchor(t, "status") },
    expect: [/cell-axes-anchors:/, /锚点歧义/, /`status`/, /bare-lines: 标记区定点豁免的机器复核不在场/,
      /裸行号引用（唯一 \(文档,目标文件,行区间\)）实测 \*\*\d+\*\* 处，超过棘轮基线 \*\*\d+\*\*/],
  },
  {
    // #770 R2 反向证（例 1 的靶子诚实性）：把新靶子**还原成 #770 之前的旧形状**（钉回载荷里那行 `status,`）
    // ⇒ 这一格今天已没有写点 ⇒ 锚点 0 命中 ⇒ 那条引用掉出豁免、棘轮回红，并点名 `status`。
    // 它证的是：例 1 只换了靶子坐标，词面锁不配当基准这条判据一步没松。
    label: "#770 R2 反向证（例 1）：把 `status` 写点锚点还原成 #770 之前的旧形状（`^ {8}status,$`）⇒ 这一格已无写点可钉 ⇒ 锚点 0 命中、那条引用不再被豁免、棘轮回红，并点名 `status`",
    overlay: { [CELL_AXES_ANCHOR_MODULE]: (t) => cellAxesWeakenAnchor(t, "^ {8}status,$") },
    expect: [/cell-axes-anchors:/, /锚点 0 命中/, /没有登记锚点/, /不再被豁免/, /`status`/,
      /bare-lines: 标记区定点豁免的机器复核不在场/,
      /裸行号引用（唯一 \(文档,目标文件,行区间\)）实测 \*\*\d+\*\* 处，超过棘轮基线 \*\*\d+\*\*/],
  },
  {
    label: `#772 R3 锚点表必须是闸能自己重算的字面量：把 ${CELL_AXES_ANCHOR_MODULE} 里的数组改成函数调用 → 豁免失效、闸回红`,
    overlay: { [CELL_AXES_ANCHOR_MODULE]: replaceUnique("\nexport const CELL_AXES_ANCHORS = [\n", "\nexport const CELL_AXES_ANCHORS = anchorTableAtRuntime();\n//") },
    expect: [/bare-lines: 标记区定点豁免的机器复核不在场/, /数组字面量/, /cell-axes-anchors\.mjs/,
      /裸行号引用（唯一 \(文档,目标文件,行区间\)）实测 \*\*\d+\*\* 处，超过棘轮基线 \*\*\d+\*\*/],
  },
  {
    label: `#772 R3 「删锚点躲过去」不成立：删掉 ${CELL_AXES_ANCHOR_MODULE} 里 \`status\` 写点那一条登记 ⇒ 那条引用不再被豁免 ⇒ 回到棘轮计数 ⇒ 红`,
    // #770 R2：定位改成「只在 `CELL_AXES_ANCHORS` 数组段里找 `status`+write 那一行」。#770 之后人审清单
    // `CELL_AXES_REQUIRED_CELLS` 也带 anchor 字段，旧 needle（整份文件里挑同时含 key/axis/anchor 的唯一行）
    // 会命中两处 ⇒ 变异一律打不上。问的事没换：删掉这一格这一轴的登记 ⇒ 引用失去基准 ⇒ 不再被豁免 ⇒ 回棘轮。
    overlay: { [CELL_AXES_ANCHOR_MODULE]: cellAxesDropStatusWriteAnchor },
    expect: [/cell-axes-anchors:/, /没有登记锚点/, /不再被豁免/, /`status`/,
      /裸行号引用（唯一 \(文档,目标文件,行区间\)）实测 \*\*\d+\*\* 处，超过棘轮基线 \*\*\d+\*\*/],
  },
  {
    // #770 R2 反向证（例 2）：登记那一行**留着**、只把它的锚点削弱成跑不通的正则 ⇒ 同样点名 `status`、
    // 同样不再被豁免。它证的是：豁免要的是「能重算的锚点」，不是「表里有一行」——两者都能躲。
    label: "#770 R2 反向证（例 2）：登记表里 `status` 写点那一条留着、只把锚点削弱成跑不通的正则 ⇒ 闸无法重算 ⇒ 同样点名 `status`、同样不再被豁免、棘轮回红",
    overlay: { [CELL_AXES_ANCHOR_MODULE]: (t) => cellAxesWeakenAnchor(t, "^ {8}status(,$") },
    expect: [/cell-axes-anchors:/, /锚点正则跑不通/, /没有登记锚点/, /不再被豁免/, /`status`/,
      /裸行号引用（唯一 \(文档,目标文件,行区间\)）实测 \*\*\d+\*\* 处，超过棘轮基线 \*\*\d+\*\*/],
  },
  {
    label: `#772 R2 评审第 3 节那个现场：把 CN 表 \`${CELL_AXES_DRIFT_PROBE}\` 换成同一键名的注释行 :${CELL_AXES_DISTRACTOR_LINE} ⇒ 闸自己重算锚点就发现行号漂了（词面判据当年看不见）`,
    overlay: { [CONTRACT_CN]: (t) => {
      if (CELL_AXES_DRIFT_PROBE === null || CELL_AXES_DISTRACTOR_LINE === null) return t;
      // 同一行里 `${CELL_AXES_DRIFT_PROBE}` 出现两次（权威源列 + 写点列），裸 String.replace 会打到
      // 第一处 ⇒ R2 这一例正是这样空转的（改了但没红）。这里只打**写点那一格**。
      // #770 R2：写点格的位置改成从表头现算（旧写法靠格子里那句「（快照）」认列，#770 之后那一格写的是
      // 「解释缺席的注释 + 快照轮记录」，字样换了 ⇒ 定位不到 ⇒ 变异空跑）。列号与闸读表的列位同源。
      const lines = t.split("\n");
      const at = lines.findIndex((l) => l.includes("`compactionStats`") && l.includes(CELL_AXES_DRIFT_PROBE));
      if (at < 0) return t;
      const cells = lines[at].split("|");
      const col = cellAxesWriteColumnIndex(lines);
      if (col < 0 || col >= cells.length || !cells[col].includes(CELL_AXES_DRIFT_PROBE)) return t;
      cells[col] = cells[col].replace(CELL_AXES_DRIFT_PROBE, `src/loop/orchestrator.js:${CELL_AXES_DISTRACTOR_LINE}`);
      lines[at] = cells.join("|");
      return lines.join("\n");
    } },
    // #770 R2：这一例现在还会多出一句**诚实的红**：这一格的 write 轴已不引 6185，钉「快照轮记录」的那条
    // 引用不再被逐组豁免⇒ 裸行号棘轮回红（不抬基线，按现测写）。
    expect: [/登记锚点不等值/, /表写 src\/loop\/orchestrator\.js:\d+/, /锚点实际 src\/loop\/orchestrator\.js:\d+/,
      /那一行原文/, /bare-lines: 标记区定点豁免的机器复核不在场/,
      /裸行号引用（唯一 \(文档,目标文件,行区间\)）实测 \*\*\d+\*\* 处，超过棘轮基线 \*\*\d+\*\*/],
    expectFiles: [CONTRACT_CN],
  },
  {
    // #770 R2 反向证（例 3）：把 CN 那一格**还原成 #770 之前的旧形状**（只引一条写点）⇒ 必须红：
    // 锚点重算是两条（解释注释 + 快照轮记录），表里只剩一条 ⇒ 不等值，并被覆盖面点名「cn 表只引了 1 处」。
    // 它证的是：#770 新增的那第二条引用不是装饰，它真的在被对账。
    label: "#770 R2 反向证（例 3）：把 CN 表 `compactionStats` 写点那一格还原成 #770 之前的单条引用形状（删掉锚点重算出的第二条）⇒ 不等值、覆盖面都红，并点名 `compactionStats`",
    overlay: { [CONTRACT_CN]: (t) => {
      if (CELL_AXES_R4_KIND_PROBE === null) return t;
      const cited = `src/loop/orchestrator.js:${CELL_AXES_R4_KIND_PROBE.realLine}`;
      const lines = t.split("\n");
      const at = lines.findIndex((l) => l.includes("`compactionStats`") && l.includes(cited));
      const col = cellAxesWriteColumnIndex(lines);
      if (at < 0 || col < 0) return t;
      const cells = lines[at].split("|");
      if (col >= cells.length || !cells[col].includes(`、\`${cited}\``)) return t;
      cells[col] = cells[col].replace(`、\`${cited}\``, "");
      lines[at] = cells.join("|");
      return lines.join("\n");
    } },
    expect: [/登记锚点不等值/, /`compactionStats`/,
      /覆盖面真值：.*cn 表（docs\/host-consumer-contract_cn\.md）里只引了 1 处/, /人审清单要求 2 处/,
      /bare-lines: 标记区定点豁免的机器复核不在场/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#772 R3 对照：原样的锚点表与两份表必须在闸自己手里重算得动（必须 0 错，证明上面几例不是恒红）",
    overlay: { [CELL_AXES_GUARD_TEST]: (t) => `${t}\n// self-test 复原探针（#772 R3）：只加一行尾注释，锚点表与两份契约都没动。\n` },
    expectGreen: true,
  },
  // —— #772 R4：锚点「种类」（M-A）与覆盖面人审清单（M-B）——
  {
    label: `#772 R4 M-A：把 \`compactionStats\` 写点的 kind=code 锚点指到同一键名的那句注释（:${CELL_AXES_R4_KIND_PROBE?.commentLine ?? "?"}），并把 EN/CN 两份引文同步改口 ⇒ 行号自洽但**种类**红`,
    overlay: {
      [CELL_AXES_ANCHOR_MODULE]: (t) => (CELL_AXES_R4_KIND_PROBE === null ? t
        : t.split(CELL_AXES_R4_KIND_PROBE.literal).join(JSON.stringify("^ {8}// - .*compactionStats.*："))),
      [CONTRACT_EN]: (t) => (CELL_AXES_R4_KIND_PROBE === null ? t
        : syncCellAxesCitation(`src/loop/orchestrator.js:${CELL_AXES_R4_KIND_PROBE.realLine}`, `src/loop/orchestrator.js:${CELL_AXES_R4_KIND_PROBE.commentLine}`)(t)),
      [CONTRACT_CN]: (t) => (CELL_AXES_R4_KIND_PROBE === null ? t
        : syncCellAxesCitation(`src/loop/orchestrator.js:${CELL_AXES_R4_KIND_PROBE.realLine}`, `src/loop/orchestrator.js:${CELL_AXES_R4_KIND_PROBE.commentLine}`)(t)),
    },
    expect: [/锚点种类不符/, /kind=code/, /是注释行/, /compactionStats/, /write 轴/,
      /bare-lines: 标记区定点豁免的机器复核不在场/,
      /裸行号引用（唯一 \(文档,目标文件,行区间\)）实测 \*\*\d+\*\* 处，超过棘轮基线 \*\*\d+\*\*/],
  },
  {
    label: "#772 R4 M-A 反方向：kind=comment 的锚点（`toolUse` 停写证据）被换成一句真代码 ⇒ 同样红（种类不许逆）",
    overlay: {
      // #770 R2：旧变异拿 `status` 写点锚点当“一句真代码”，而 #770 之后它自己也是注释锚点
      // ⇒ 换进去的种类没逆 ⇒ 这一例当时只能报「行号不等值」，问不到它问的那件事。现在从出厂表里
      // 现读一条 `kind: "code"` 且唯一命中非注释行的写点锚点当靶子（现读：表改了靶子跟着改）。
      [CELL_AXES_ANCHOR_MODULE]: (t) => {
        const entry = CELL_AXES_ANCHORS_SHIPPED.find((e) => e.key === "toolUse" && e.axis === "write" && e.kind === "comment");
        if (entry === undefined || CELL_AXES_R4_REVERSE_CODE_TARGET === null) return t;
        return t.split(JSON.stringify(entry.anchor)).join(CELL_AXES_R4_REVERSE_CODE_TARGET.literal);
      },
    },
    // #770 R2：种类红的同时还多一句诚实的红：`toolUse` 的 write 轴引用从此对不上任何登记锚点
    // ⇒ 那条引用掉出逐组豁免 ⇒ 裸行号棘轮回红（不抬基线，按现测写）。
    expect: [/锚点种类不符/, /kind=comment/, /不是注释行/, /`toolUse`/,
      /bare-lines: 标记区定点豁免的机器复核不在场/,
      /裸行号引用（唯一 \(文档,目标文件,行区间\)）实测 \*\*\d+\*\* 处，超过棘轮基线 \*\*\d+\*\*/],
  },
  {
    // #770 R2 反向证（例 4）：不动锚点、只把种类登记造假——`toolUse` 写点明明钉的是注释行，却登记成
    // `kind: "code"` ⇒ 必须红，并点名 `toolUse` 与「那一行是注释行」。它证的是：种类对账真的在比对
    // 锚点命中行的**文字**，不是只看了几个字段。
    label: "#770 R2 反向证（例 4）：`toolUse` 写点锚点不动、只把登记的 kind 从 comment 改成 code（种类登记造假）⇒ 同样红，并点名 `toolUse` 与「那一行是注释行」",
    overlay: { [CELL_AXES_ANCHOR_MODULE]: (t) => rewriteCellAxesRowKind(t, "toolUse", "write", "code") },
    expect: [/锚点种类不符/, /kind=code/, /是注释行/, /`toolUse`/,
      /bare-lines: 标记区定点豁免的机器复核不在场/],
  },
  {
    label: "#772 R4 M-A 对照：把 kind 字段整列删掉（闸抽不出合法种类）⇒ 红；原样必须 0 错（见下一条）",
    overlay: { [CELL_AXES_ANCHOR_MODULE]: (t) => t.replace(/ kind: "(?:code|comment)",/gu, "") },
    expect: [/kind/,
      /锚点表里有 `kind` 不合法的条目|bare-lines: 标记区定点豁免的机器复核不在场/],
  },
  {
    label: "#772 R4 M-B：从每个双锚点组各删一条登记，并把两份表里的对应引用**成对**删掉 ⇒ 剩下的全自洽（旧行为：两道闸全绿），但地板由人审清单算出 ⇒ 红，并点名缺的那一格缺在哪一份",
    overlay: {
      [CELL_AXES_ANCHOR_MODULE]: dropCellAxesAnchorEntries,
      [CONTRACT_EN]: dropCellAxesCitations,
      [CONTRACT_CN]: dropCellAxesCitations,
    },
    // 本例的要点就是「剩下的那些仍然自洽」⇒ 引用与登记成对消失，裸行号棘轮**看不见**它（没多出没缺），
    // 所以这里不要求棘轮那条红；要求的是地板（现由 `CELL_AXES_REQUIRED_CELLS.length` 算出）与
    // 覆盖面真值逐槽点名「缺哪一格、缺在哪一份」。地板那句已带「由人审清单算出」的后缀，所以括号不闭合。
    expect: [/锚点登记表只剩 \d+ 条（下限 \d+/,
      /覆盖面真值：.*在 `scripts\/cell-axes-anchors\.mjs` 里只有 1 条登记锚点/,
      /人审清单要求 2 处/, /en 表（docs\/host-consumer-contract\.md）/, /cn 表（docs\/host-consumer-contract_cn\.md）/,
      /bare-lines: 标记区定点豁免的机器复核不在场/],
  },
  {
    label: "#772 R4 M-B：只删两份表里的引用（登记留着）⇒ 覆盖面真值必红，并点名缺的那一格缺在哪一份（EN / CN）",
    overlay: { [CONTRACT_EN]: dropCellAxesCitations, [CONTRACT_CN]: dropCellAxesCitations },
    expect: [/覆盖面真值/, /en 表/, /cn 表/, /人审清单要求/,
      /bare-lines: 标记区定点豁免的机器复核不在场/],
  },
  {
    label: "#772 R4 已知限度（特征用例，见 docs/maintenance/command-reference.md）：把写点锚点换到**同一键名的另一处真代码行** + 两份引文同步改口 ⇒ 机械上全绿（语义真值机器证不了，故本例断言它**不红**）",
    overlay: {
      // #770 R2：靶子行不再写死 :3505（那行已随快照写点被删）。现在现算「同一键名的另一处真代码行」：
      // 只剩 run-state 落盘载荷里那一份 `compactionStats,`——它是**另一件产物**，恰好就是本例要钉的
      // 「机器证不了语义」那个形状（锚点能唯一命中、kind=code 也对、两份表同步改口 ⇒ 机械上全绿）。
      [CELL_AXES_ANCHOR_MODULE]: (t) => (CELL_AXES_R4_KIND_PROBE === null || CELL_AXES_R4_SAME_NAME_CODE_LINE === null ? t
        : t.split(CELL_AXES_R4_KIND_PROBE.literal).join(JSON.stringify(CELL_AXES_R4_SAME_NAME_CODE_LINE.anchor))),
      [CONTRACT_EN]: (t) => (CELL_AXES_R4_KIND_PROBE === null || CELL_AXES_R4_SAME_NAME_CODE_LINE === null ? t
        : syncCellAxesCitation(`src/loop/orchestrator.js:${CELL_AXES_R4_KIND_PROBE.realLine}`, CELL_AXES_R4_SAME_NAME_CODE_LINE.citation)(t)),
      [CONTRACT_CN]: (t) => (CELL_AXES_R4_KIND_PROBE === null || CELL_AXES_R4_SAME_NAME_CODE_LINE === null ? t
        : syncCellAxesCitation(`src/loop/orchestrator.js:${CELL_AXES_R4_KIND_PROBE.realLine}`, CELL_AXES_R4_SAME_NAME_CODE_LINE.citation)(t)),
    },
    expectGreen: true,
  },
  {
    // #770 R2 反向证（例 5）：上面那条特征用例的“同步改口”只做一半（只改 EN，CN 留着旧行号）⇒ 必须红，
    // 并点名 cn 侧那行不等值。它证的是：例 5 的绿不是恒绿——它靠的是两份表真的同步，不是判据不在场。
    label: "#770 R2 反向证（例 5）：已知限度那条锚点换同键名另一处真代码行后，只把 EN 一份表改口（CN 留着旧行号）⇒ 必须红，并点名 cn 表 `compactionStats` 的 write 列与锚点不等值",
    overlay: {
      [CELL_AXES_ANCHOR_MODULE]: (t) => (CELL_AXES_R4_KIND_PROBE === null || CELL_AXES_R4_SAME_NAME_CODE_LINE === null ? t
        : t.split(CELL_AXES_R4_KIND_PROBE.literal).join(JSON.stringify(CELL_AXES_R4_SAME_NAME_CODE_LINE.anchor))),
      [CONTRACT_EN]: (t) => (CELL_AXES_R4_KIND_PROBE === null || CELL_AXES_R4_SAME_NAME_CODE_LINE === null ? t
        : syncCellAxesCitation(`src/loop/orchestrator.js:${CELL_AXES_R4_KIND_PROBE.realLine}`, CELL_AXES_R4_SAME_NAME_CODE_LINE.citation)(t)),
    },
    expect: [/cn：docs\/host-consumer-contract_cn\.md 表里 `compactionStats` 的 write 列与登记锚点不等值/,
      /表写 .*锚点实际/, /bare-lines: 标记区定点豁免的机器复核不在场/],
    expectFiles: [CONTRACT_CN],
  },
  // --- #772 R2 M2：标记区内容的正向不变量（评审 follow-up 第 1 条）---
  {
    label: "#772 R2 M2 正向不变量：把 begin 标记上移 3 行（让标记区包住表格上方的正文）→ 红，并点名第一处正文行",
    overlay: { [CONTRACT_CN]: liftCellAxesBegin(3) },
    expect: [/cell-axes-region/, /普通正文行/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#772 R2 M2 对照：标记区内加一个空行（允许形状，不是正文）→ 必须 0 错",
    overlay: { [CONTRACT_CN]: (text) => text.replace(`${CELL_AXES_MARK_BEGIN}\n`, `${CELL_AXES_MARK_BEGIN}\n\n`) },
    expectGreen: true,
  },
  {
    label: "#772 R2 M2 登记表自己的后门：往 CELL_AXES_CALIBER_LINES 塞一条区域内没有的口径行 → 红（登记了没人用）",
    overlay: {
      // needle 故意拆成两段字面量：`--self-test` 拿本脚本自己的文本当靶面，这一段若整串写下来就会
      // 同时出现在「定义处」与「本用例源码里」⇒ 恰好两处 ⇒ replaceUnique 判「靶子不唯一」而空跑。
      "scripts/docs-drift-check.mjs": replaceUnique("  [CONTRACT_EN]: []" + ",",
        "  [CONTRACT_EN]: [\"自测探针（#772 R2 M2）：标记区里根本没有这行\"],"),
    },
    expect: [/cell-axes-region/, /后门/],
  },
  {
    label: "#772 R3 登记表的对照组：区域内真放一行口径行 + 同批登记它 → 必须 0 错（证明上一条不是恒红）",
    overlay: {
      [CONTRACT_CN]: (text) => text.replace(`${CELL_AXES_MARK_BEGIN}\n`,
        `${CELL_AXES_MARK_BEGIN}\n自测探针（#772 R3）：登记过的口径行应当被放行。\n`),
      "scripts/docs-drift-check.mjs": replaceUnique("  [CONTRACT_CN]: []" + ",",
        "  [CONTRACT_CN]: [\"自测探针（#772 R3）：登记过的口径行应当被放行。\"],"),
    },
    expectGreen: true,
  },
  {
    label: `#286 棘轮下限：把 BARE_LINE_REF_BASELINE 调到 ${BARE_LINE_REF_BASELINE - 1} → 必须红（证明这个数真是锁，不是装饰）`,
    overlay: { "scripts/docs-drift-check.mjs": (t) => t.replace(
      `const BARE_LINE_REF_BASELINE = ${BARE_LINE_REF_BASELINE};`,
      `const BARE_LINE_REF_BASELINE = ${BARE_LINE_REF_BASELINE - 1};`) },
    expect: [ratchetOverBaseline(BARE_LINE_REF_BASELINE, BARE_LINE_REF_BASELINE - 1),
      new RegExp(`把基线改成 ${BARE_LINE_REF_BASELINE}`)],
  },
  {
    label: `#286 棘轮下限的反向证：常量调回 ${BARE_LINE_REF_BASELINE}（只加一句尾注释、数值不变）→ 必须 0 错`,
    overlay: { "scripts/docs-drift-check.mjs": (t) => t.replace(
      `const BARE_LINE_REF_BASELINE = ${BARE_LINE_REF_BASELINE};`,
      `const BARE_LINE_REF_BASELINE = ${BARE_LINE_REF_BASELINE};   // self-test 复原探针`) },
    expectGreen: true,
  },
  {
    label: "#286 越界必红：CN 契约的 terminationReasonForAction 区间 :111 改成 99999-111（唯一区间数不变、区间仍与声明处相交 → 只有越界这条红）",
    overlay: { [CONTRACT_CN]: (t) => t.split("src/loop/termination.js:111").join("src/loop/termination.js:99999-111") },
    expect: [/bare-lines: docs\/host-consumer-contract_cn\.md:\d+ 引用 src\/loop\/termination\.js:99999-111，但该文件只有 \d+ 行/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#286 豁免双条件（就地声明那一侧）：去掉 v030 EN 的外仓根 apps/worker/ → 既不再放行（245）又留下空转条目",
    overlay: { "docs/host-upgrade-guide-v030.md": (t) => t.replace("apps/worker/src/pi/runner.js:50", "src/pi/runner.js:50") },
    expect: [ratchetOverBaseline(BARE_LINE_REF_BASELINE + 1, BARE_LINE_REF_BASELINE),
      /豁免条目 `src\/pi\/runner\.js`（docs\/host-upgrade-guide-v030\.md）没有一处引用真正用到它/],
  },
  {
    label: "#286 豁免双条件（条目那一侧）：CN 契约的示例路径改成没登记的 src/a/c.js:12 → 没有条目就不放行",
    overlay: { [CONTRACT_CN]: (t) => t.replace("paths: src/a/b.js:12", "paths: src/a/c.js:12") },
    expect: [ratchetOverBaseline(BARE_LINE_REF_BASELINE + 1, BARE_LINE_REF_BASELINE),
      /豁免条目 `src\/a\/b\.js`（docs\/host-consumer-contract_cn\.md）没有一处引用真正用到它/],
  },
  {
    label: "#286 变异器空转证：靶子（不存在的符号名）打不上时，runSelfTest 必须判这一例「变异没落上」而不是假绿",
    overlay: { [CONTRACT_EN]: mutateSymbolAnchor("zzProbeNoSuchSymbol", "src/loop/orchestrator.js", "anything") },
    expectMutateMiss: true,
  },

  // —— #286 T-b1a R1：符号锚点**自带区间**必须与声明处相交（2.8.1b）。逐处反向证四条：
  //    改窄区间 → 红、区间整段挪走 → 红、删掉区间 → 绿（本判据对不带区间的锚点不适用）、
  //    弱档（具名字面量）也真的按「该字面量的出现行」判 → 改窄到不含出现行就红。
  //  四条都用 `mutateSymbolAnchorSpan`（与主检查同一套提取逻辑，#279 口径：打靶由提取逻辑定）。
  {
    label: "#286 T-b1a 区间相交：把 `terminationReasonForAction`（termination.js:111）改窄成 112-116 ⇒ 声明在 111，红",
    overlay: { [CONTRACT_EN]: mutateSymbolAnchorSpan("terminationReasonForAction", "src/loop/termination.js", ":112-116") },
    expect: [/symbol-anchor-span: .*引用 `terminationReasonForAction`（`src\/loop\/termination\.js:112-116`）/,
      /声明处不相交/, /真值位在 111/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "#286 T-b1a 区间相交：把 `defaultSleep`（abort.js:16）整段挪到 :30（不越界、符号也在）⇒ 只有相交这条红",
    overlay: { [CONTRACT_CN]: mutateSymbolAnchorSpan("defaultSleep", "src/loop/abort.js", ":30") },
    expect: [/symbol-anchor-span: docs\/host-consumer-contract_cn\.md:\d+ 引用 `defaultSleep`（`src\/loop\/abort\.js:30`）/,
      /真值位在 16/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#286 T-b1a 区间相交的放行证：删掉 `max_rounds_cap`（termination.js:115）的区间（只留符号 + 文件）⇒ 本判据不适用，必须 0 错",
    overlay: { [CONTRACT_CN]: mutateSymbolAnchorSpan("max_rounds_cap", "src/loop/termination.js", "") },
    expectGreen: true,
  },
  {
    label: "#286 T-b1a 弱档真值位：把 `max_rounds_cap`（termination.js:115）改窄到 300-301 ⇒ 字面量都在区间外，红（弱档也真按出现行判）",
    overlay: { [CONTRACT_EN]: mutateSymbolAnchorSpan("max_rounds_cap", "src/loop/termination.js", ":300-301") },
    expect: [/symbol-anchor-span: .*引用 `max_rounds_cap`（`src\/loop\/termination\.js:300-301`）/,
      /真值形态 具名字面量成员/],
    expectFiles: [CONTRACT_EN],
  },

  // —— #299：注释与字符串里的同名**不算**声明（符号抽取只看代码面）——
  // 两例反向证（注释里的「声明」/注释里的「具名字面量」）加一例放行证（同一个名字挪成真声明 ⇒ 绿）。
  // 修前三条全是**绿**：抽取拿原始文本逐行正则，注释里写一行 `const X = 1;` 就能「证明」X 已声明。
  {
    label: "#299 注释里的「声明」不算声明：termination.js 末尾追加一段块注释、里面写 `const zzzPhantomBinding = 1;`，"
      + "EN 契约引 `zzzPhantomBinding`（`src/loop/termination.js`）⇒ 必须红（修前绿）",
    overlay: {
      "src/loop/termination.js": (t) => `${t}\n/*\nconst zzzPhantomBinding = 1;\n*/\n`,
      [CONTRACT_EN]: mentionInProse("Self-test probe (#299): `zzzPhantomBinding` (`src/loop/termination.js`) lives in a comment only."),
    },
    expect: [/symbol-anchor: .*引用 `zzzPhantomBinding`（`src\/loop\/termination\.js`/,
      /该文件里没有 `zzzPhantomBinding` 的声明/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "#299 同一个名字挪成**真实**声明 ⇒ 必须 0 错（放行证：证明上一例不是恒红）",
    overlay: {
      "src/loop/termination.js": (t) => `${t}\nexport const zzzPhantomBinding = 1;\n`,
      [CONTRACT_EN]: mentionInProse("Self-test probe (#299): `zzzPhantomBinding` (`src/loop/termination.js`) is a real binding here."),
    },
    expectGreen: true,
  },
  {
    label: "#299 注释里的字符串不算「具名字面量成员」：termination.js 注释里写 `\"zzz_phantom_code\"`，EN 契约引它 ⇒ 必须红（修前绿）",
    overlay: {
      "src/loop/termination.js": (t) => `${t}\n// 自测探针（#299）：这个值只活在注释里，不是任何字面量：\"zzz_phantom_code\"\n`,
      [CONTRACT_EN]: mentionInProse("Self-test probe (#299): `zzz_phantom_code` (`src/loop/termination.js`) is quoted inside a comment."),
    },
    expect: [/symbol-anchor: .*引用 `zzz_phantom_code`（`src\/loop\/termination\.js`/,
      /该文件里没有 `zzz_phantom_code` 的声明/],
    expectFiles: [CONTRACT_EN],
  },

  // —— 返工 R1（评审阻断项）：符号锚点的**只增不减下限**。病根：裸行号棘轮的唯一键不含文档行号，
  // 所以「把符号锚点换成裸行号」这种**退化**在棘轮那一侧一字不变，没有下限就没人报警。
  //
  // 下面两例的**前提数字**（`CONST - 1` / `CONST` / `CONST + 1`）全部从 `SYMBOL_ANCHOR_MIN_UNIQUE` 现算，
  // 不在这里拄字面量——这不是偷懒，是这两例成立的前提：**常量必须等于现测**。
  //   · 现测 = `node scripts/docs-drift-check.mjs --verbose` 那条 note 报的数（#769 R8 在 `727af80` 上量：**243**）。
  //   · 本例退化完的唯一组数 = 现测 - 1（同是量出来的：#769 R8 把下面两条 `replace` 原样落到两份契约上跑
  //     `--verbose`，现报「唯一 (符号, 文件) 242 组」；同轮 `bare-lines` 现报「棘轮口径实测 **6** vs 基线 6」一字不变）。
  // 于是常量陈旧的两种伤法都能被抱住：常量**高于**现测 ⇒ 下面那例「升到 CONST+1」不再红（由例 2 抱住）；常量**低于**
  // 现测 ⇒ 退化到 CONST 组恰好等于下限、本例等的那条红根本不出现（由例 1 抱住，#769 R8 在 CI 上撞到的就是这个）。
  // ⇒ 抬常量前先量一次；这两例红在**数字**上是在叫你去量，**不是**叫你把断言改松（`expect` 换成 `expectGreen`、
  // 删例、加 skip、改成「任意红都算」都算把这条锁拆了）。
  {
    label: "#286 返工 R1：把中英契约的 `defaultSleep`（`src/loop/abort.js:16`）一起退化成裸行号 ⇒ 棘轮一字不变，只有符号下限红（"
      + (SYMBOL_ANCHOR_MIN_UNIQUE - 1) + " < " + SYMBOL_ANCHOR_MIN_UNIQUE + "）",
    // 退化前后那一处 `src/loop/abort.js:16` 都还在文档里（棘轮的唯一键不含**文档行号**），所以裸行号侧
    // 一个数都不变——这正是本条下限存在的理由。两侧一起退化是因为 (符号, 文件) 是按全局去重的：
    // `defaultSleep` 中英各一处（CN:217 / EN:262），只退一侧不会掉组，只退一侧看不见评审那条形状。
    overlay: {
      [CONTRACT_CN]: (t) => t.replace("`defaultSleep`（`src/loop/abort.js:16`）", "`src/loop/abort.js:16`"),
      [CONTRACT_EN]: (t) => t.replace("`defaultSleep` (`src/loop/abort.js:16`)", "`src/loop/abort.js:16`"),
    },
    expect: [new RegExp(`symbol-anchor: 覆盖面里唯一 \\(符号, 文件\\) 只剩 ${SYMBOL_ANCHOR_MIN_UNIQUE - 1} 组，低于下限 \\*\\*${SYMBOL_ANCHOR_MIN_UNIQUE}\\*\\* 组`), /退化成裸行号/,
      /棘轮的计数一字不变|裸行号棘轮的计数一字不变/],
  },
  {
    // 同一对锁的另一侧（前提数字的算法见上面那段注）：变异目标 = **现测 + 1**（常量已抬到现测 243 ⇒ 这里就是 244），
    // 期望仍是**必须红**：证的就是「这个数是脚本从自己文本里读出来的，不是注释里的装饰」。
    label: `#286 返工 R1 的另一侧：把 SYMBOL_ANCHOR_MIN_UNIQUE 升到 ${SYMBOL_ANCHOR_MIN_UNIQUE + 1}（实测仍是 ${SYMBOL_ANCHOR_MIN_UNIQUE}）⇒ 必须红，证明这个数是读出来的、不是装饰`,
    overlay: { "scripts/docs-drift-check.mjs": (t) => t.replace(`const SYMBOL_ANCHOR_MIN_UNIQUE = ${SYMBOL_ANCHOR_MIN_UNIQUE};`, `const SYMBOL_ANCHOR_MIN_UNIQUE = ${SYMBOL_ANCHOR_MIN_UNIQUE + 1};`) },
    expect: [new RegExp(`唯一 \\(符号, 文件\\) 只剩 ${SYMBOL_ANCHOR_MIN_UNIQUE} 组，低于下限 \\*\\*${SYMBOL_ANCHOR_MIN_UNIQUE + 1}\\*\\* 组`)],
  },

  // —— 返工 R2（评审阻断项）：覆盖面会因为改名而**静默缩面**。脚本按
  // `^host-upgrade-guide.*\.md$` 实扫、测试侧用同一个 glob ⇒ 改一份名字就两边一起少一份，照样绿。
  // 树形口子 `SIM_RENAMED_GUIDE` 只影响清单、不动任何文本（与 #280 的 SIM_ABSENT_TASK_ARCHIVE 同款纪律，
  // 并且同样要证「口子真的落上了」，见 runSelfTest 里的覆盖面份数比对）。
  {
    label: `#286 返工 R2：模拟一份升级指南改名到不匹配实扫模式 ⇒ 覆盖面 ${REF_SCAN_DOCS_MINIMUM - 1} < ${REF_SCAN_DOCS_MINIMUM} 必须红（改名 = 静默缩面，两边 glob 一起少）`,
    simulateRenamedGuide: "docs/host-upgrade-guide-0.16.0.md",
    expect: [new RegExp(`ref-scan: 「符号锚点 \\+ 裸行号棘轮」的覆盖面只剩 ${REF_SCAN_DOCS_MINIMUM - 1} 份文档，低于下限 \\*\\*${REF_SCAN_DOCS_MINIMUM}\\*\\* 份`),
      /静默缩面/, /test\/docs-anchor-ratchet\.test\.js/],
  },

  // —— 返工 R3（评审低危但便宜）：行号**下界**与「目标文件不存在」的口径。
  // 前者从前是漏洞：`:0-1` 的结尾 1 永远不超过文件行数 ⇒ 零条红（主 agent 注入实测过）。
  // 后者从前是 `continue`：目标文件不存在就跳过，于是「文件改名/被删 + 还留着行号」静默放行。
  {
    label: "#286 返工 R3 下界：把 CN 契约的 terminationReasonForAction 区间写成 :0-111 ⇒ 必须红（从前零条红，`:0` 在越界判据里永远不越界；结尾仍与声明处相交，所以只有下界这条红）",
    overlay: { [CONTRACT_CN]: (t) => t.replace("src/loop/termination.js:111", "src/loop/termination.js:0-111") },
    expect: [/bare-lines: docs\/host-consumer-contract_cn\.md:\d+ 引用 src\/loop\/termination\.js:0-111 的行号不合法——行号必须 \*\*≥ 1\*\*/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#286 返工 R3 不存在：把 CN 契约的一处目标改成 src/loop/__no_such_probe__.js ⇒ 必须红（从前是 continue 静默跳过；同一坐标的符号锚点也会点名「文件不存在」，属同一处坏坐标）",
    overlay: { [CONTRACT_CN]: (t) => t.replace("src/loop/termination.js:111", "src/loop/__no_such_probe__.js:111") },
    expect: [/bare-lines: docs\/host-consumer-contract_cn\.md:\d+ 引用 src\/loop\/__no_such_probe__\.js:111，但 .*在本仓不存在——裸行号没有可核对的真值/],
    expectFiles: [CONTRACT_CN],
  },

  // —— 返工 R4（评审低危）：豁免的「就地声明」从前是整行 OR 匹配——同一行只要还剩着 `for example`
  // 之类的附带措辞就算声明成立。收紧成 **同一行同时含占位路径与声明词**（AND），并给条目自己加配置校。
  {
    label: "#286 返工 R4：把某条豁免的 decl 临时换成 /.*/（恒真）⇒ 双条件退化成单条件，必须被配置校抓住",
    // 为什么走「配置口子」而不是 overlay：overlay 只改**文本**，改不动运行时那份 BARE_LINE_EXEMPTIONS 对象；
    // 数值常量能靠 fileRecord 读自身文本来证，正则判据不行，所以要一个和 SIM_ABSENT_TASK_ARCHIVE 同款的
    // 运行时口子，并且同样要证「口子真的落上」（找不到条目就判自测自身失效）。
    simulateLooseDecl: { doc: "docs/host-upgrade-guide-v030.md", target: "src/pi/runner.js" },
    expect: [/豁免条目 src\/pi\/runner\.js（docs\/host-upgrade-guide-v030\.md）的 decl 能匹配空串（\/\.\*\/）——/,
      /「就地声明」这一侧恒真，双条件退化成了单条件/],
  },
  {
    label: "#286 返工 R4 的放行证：在 CN 契约里插一行无关散文 ⇒ 现有 4 条豁免在 AND 判据下全部仍然成立（零条红）",
    overlay: { [CONTRACT_CN]: mentionInProse("自测探针（#286 返工 R4）：这里只是在文档靠前插一句散文，什么引用都没动。") },
    expectGreen: true,
  },

  // —— 工单 261021-03 B1：外部仓引用的**前缀标记法**（`<仓名>:<该仓路径>`）。放宽了什么就必须有反向证：
  //    「带前缀 ⇒ 不查本仓存在性、不计裸行号棘轮」是把裁决交给**引用自己写的归属**，所以必须同时钉住
  //    ① 漏写前缀 ⇒ 红（否则谁都能拿一个冒号把死链藏起来）；
  //    ② 写了清单外的仓名 ⇒ 红（前缀不是「不是本仓文件」的免检通道）；
  //    ③ 前缀写法本身不动 ⇒ 绿（放行分支真的在放行，不是碰巧没扫到）；
  //    ④ 裸行号一侧同一条判据（前缀在/不在，两例各自点名）；
  //    ⑤ 前缀清单里的仓名没人用 ⇒ 红（与四张白名单登记表同口径，条目不许烂在那儿）。
  {
    label: "工单 261021-03 B1：requirements EN 把 `touwaka:lib/agent/` 的**前缀删掉** ⇒ 必须红（漏写前缀就是本仓死链）",
    overlay: { [REQ_EN]: (t) => t.replace("`touwaka:lib/agent/`", "`lib/agent/`") },
    expect: [/paths: docs\/requirements\.md 引用了无法裁决的仓库内路径/, /`lib\/agent\/`（第 \d+ 行）：本仓不存在/],
    expectFiles: [REQ_EN],
  },
  {
    label: "工单 261021-03 B1：requirements EN 换成清单外的仓名 `pi:` ⇒ 必须红（编一个前缀不能把死链藏起来）",
    overlay: { [REQ_EN]: (t) => t.replace("`touwaka:lib/agent/`", "`pi:lib/agent/`") },
    expect: [/paths: docs\/requirements\.md 引用了无法裁决的仓库内路径/,
      /外部仓前缀 `pi:`，但 "pi" 不在 EXTERNAL_REPO_PREFIXES 已知清单里/],
    expectFiles: [REQ_EN],
  },
  {
    label: "工单 261021-03 B1 的放行证：把带前缀的外仓路径改成本仓解不到的名字 ⇒ 必须 0 错（带前缀真的不查本仓存在性，不是碰巧没扫到）",
    overlay: { [REQ_EN]: (t) => t.split("`touwaka:lib/agent/`").join("`touwaka:lib/agent-selftest-probe/`") },
    expectGreen: true,
  },
  {
    label: "工单 261021-03 B1（裸行号一侧）：删掉 pi 扩展 README 的 `pi-subagents:` 前缀 ⇒ 既报「目标不存在」又把只减不增的棘轮顶到 " + (BARE_LINE_REF_BASELINE + 1),
    overlay: { [PI_EXT_README]: (t) => t.replace("`pi-subagents:src/runs/background/async-execution.js:4`", "`src/runs/background/async-execution.js:4`") },
    expect: [/bare-lines: examples\/pi-extension\/README\.md:\d+ 引用 src\/runs\/background\/async-execution\.js:4，但 .*在本仓不存在/,
      ratchetOverBaseline(BARE_LINE_REF_BASELINE + 1, BARE_LINE_REF_BASELINE)],
    expectFiles: [PI_EXT_README],
  },
  {
    label: "工单 261021-03 B1（裸行号一侧的未知前缀）：把 `pi-subagents:` 改成 `pi-workflow:` ⇒ 两侧都必须点名这个清单外的仓名",
    overlay: { [PI_EXT_README]: (t) => t.replace("`pi-subagents:src/runs/background/async-execution.js:4`", "`pi-workflow:src/runs/background/async-execution.js:4`") },
    expect: [/bare-lines: examples\/pi-extension\/README\.md:\d+ 写了带外部仓前缀的 `pi-workflow:src\/runs\/background\/async-execution\.js:4`，.*不在 EXTERNAL_REPO_PREFIXES 已知清单/,
      /paths: examples\/pi-extension\/README\.md[\s\S]*外部仓前缀 `pi-workflow:`/],
    expectFiles: [PI_EXT_README],
  },
  {
    label: "工单 261021-03 B1：把中英需求对照里的 `app_container:` 改成已登记的另一个仓名 ⇒ 前缀条目空转必须红（与前四张白名单登记表同口径）",
    // 为什不拿「改脚本自己的表」当变异：overlay 只改**文本**，改不动运行时那份 `EXTERNAL_REPO_PREFIXES`（与
    // `simulateLooseDecl` 同一课）。改引用侧反而仍的是真命题：登记了却没人用 = 给下一个死链预备了借口。
    overlay: {
      [REQ_EN]: (t) => t.replace("`app_container:apps/worker/src/pi/`", "`touwaka:apps/worker/src/pi/`"),
      [REQ_CN]: (t) => t.replace("`app_container:apps/worker/src/pi/`", "`touwaka:apps/worker/src/pi/`"),
    },
    expect: [/外部仓前缀 `app_container:` 没有一处引用真正用到它/],
  },
  // —— issue #621：`file.js:a-b` 与 `file.js:a` 必须走**同一条剥号路径**。修前 `:\d+(?::\d+)?$` 只认单行，
  //    区间尾巴剥不掉 ⇒ 紧接的扩展名过滤看到一个以 `-227` 结尾的串 ⇒ 整个 token 被丢弃，区间形式的引用
  //    **一处也不进裁决**（路径改成什么都绿）。下面四例同时钉住两条裁决边界：区间已进裁决（①）、
  //    外仓前缀引用**仍然**不做本仓存在性核对（③ 放行证），而前缀不是免检通道（④）。
  //    ⚠ 前两例的靶子是 `injectRangeAnchor` **注入**的合成锚点：它们只依赖「契约文本里有一条区间引用」
  //    这件事由夹具自己保证，不再依赖契约里现存哪句原话（#661 删掉那句之后，旧靶子变成了空操作）。
  {
    label: "#621：overlay 注入的区间锚点路径改坏 ⇒ 必须红（修前区间 token 被整条丢弃，零校验）",
    overlay: {
      [CONTRACT_EN]: injectRangeAnchor((anchor) => anchor.replace("bin/cli.js:1032-1042", "bin/cli621Probe.js:1032-1042")),
    },
    expect: [/paths: docs\/host-consumer-contract\.md[\s\S]*`bin\/cli621Probe\.js`（第 \d+ 行）：本仓不存在/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "#621 放行证：注入的同一处收窄成单行 `bin/cli.js:1032` ⇒ 仍然绿（区间与单行走同一条剥号路径，不是把单行也弄红）",
    overlay: {
      [CONTRACT_EN]: injectRangeAnchor((anchor) => anchor.replace("bin/cli.js:1032-1042", "bin/cli.js:1032")),
    },
    expectGreen: true,
  },
  {
    label: "#621 边界：外仓前缀 + 区间（`pi-subagents:extension/index.js:137-141`）路径改坏 ⇒ 仍然绿（EXTERNAL_REPO_PREFIXES 语义：外仓路径不做本仓存在性核对，这是预期）",
    overlay: { [PI_EXT_README]: (t) => t.replace("`pi-subagents:extension/index.js:137-141`", "`pi-subagents:extension/index621Probe.js:137-141`") },
    expectGreen: true,
  },
  {
    label: "#621 边界：外仓前缀 + 区间但仓名写错（`pi-workflow:`）⇒ 必须红（前缀不是免检通道，区间形式也不例外）",
    overlay: { [PI_EXT_README]: (t) => t.replace("`pi-subagents:extension/index.js:137-141`", "`pi-workflow:extension/index.js:137-141`") },
    expect: [/paths: examples\/pi-extension\/README\.md[\s\S]*外部仓前缀 `pi-workflow:`/],
    expectFiles: [PI_EXT_README],
  },
  // —— issue #391 R4：`cli-flags`（bin/cli.js 帮助文本 ⇄ 两份 README 的 usage 行，双向逐处）——
  {
    label: "#391 R4：README EN 的 chat usage 行删掉 `[--require-deliverable [<path>]]` ⇒ 红并点名那个旗标",
    overlay: { [README_EN]: (t) => t.replace(" [--require-deliverable [<path>]]", "", 1) },
    expect: [/cli-flags: README\.md 的 `erix chat` usage 行缺 旗标 --require-deliverable/],
    expectFiles: [README_EN],
  },
  {
    label: "#391 R4：README_cn 的 repl usage 行凭空多写一个旗标 ⇒ 红（双向：多也红）",
    // 靶点取 repl 行**末尾**（`[--require-deliverable [<path>]]` 在 chat 行里也出现一次，裸 replace 会打到 chat 上；
    // issue #617 P2 给 repl 行末尾补了 delegate 三件套，靶点随之移到新的行尾）。
    // issue #716 / #719：repl 行末尾又多了 `[--no-agents]`，旧靶串（`… [--delegate-timeout-ms <n>]\nerix skills`）
    // 不再连续 ⇒ 变异落不上 ⇒ 按 #210 R2「落不上算失败」报红。这是**文字合法变更后的正当跟随**（改的是锚点，
    // 不是判据）。本轮把锚点从「一串旗标的逐字片段」换成**行边界**：插在 `\nerix skills` 之前 = 插在 repl usage
    // 行的末尾，从此 repl 行再增删旗标也不会让这一枪脱靶；万一 repl 行不再紧邻 `erix skills`，它会打到别的行上
    // 并因「多出 --zzz-flag」的期望不匹配而**报红**（失靶失响，不是静默变绿）。
    overlay: { [README_CN]: (t) => t.replace("\nerix skills", " [--zzz-flag]\nerix skills", 1) },
    expect: [/cli-flags: README_cn\.md 的 `erix repl` usage 行多出 旗标 --zzz-flag/],
    expectFiles: [README_CN],
  },
  {
    label: "#391 R4：帮助文本侧（真值）加一个新旗标 ⇒ 中英两份 README 同时红（这才是「加旗标忘了文档」的形状）",
    // ⚠ 靶点是**帮助文本里那一段的逐字片段**：issue #435 给 chat 行补了 `[--require-deliverable-content]`，
    // 旧片段（`… [<path>]] [--no-notes]`）不再连续 ⇒ 变异落不上、本格变成「恒绿」。#210 R2 的惯例是
    // 变异没落地就算失败，所以这里跟着帮助文本一起改；改的是**锚点**，不是判据。
    overlay: { "bin/cli.js": (t) => t.replace("[--require-deliverable [<path>]] [--require-deliverable-content] [--no-notes]", "[--require-deliverable [<path>]] [--zzz-flag] [--require-deliverable-content] [--no-notes]", 1) },
    expect: [/cli-flags: README\.md 的 `erix chat` usage 行缺 旗标 --zzz-flag/,
      /cli-flags: README_cn\.md 的 `erix chat` usage 行缺 旗标 --zzz-flag/],
    expectFiles: [README_EN, README_CN],
  },
  {
    label: "#391 R4（放行证）：把 README chat 行里两个旗标**对调顺序** ⇒ 仍然绿（逐处比对的是集合，不是排版）",
    overlay: {
      [README_EN]: (t) => t.replace("[--final-guard|--no-final-guard] [--require-deliverable [<path>]]", "[--require-deliverable [<path>]] [--final-guard|--no-final-guard]", 1),
    },
    expectGreen: true,
  },
  {
    label: "#391 R4（放行表空转）：登记一条「README 已经写了」的放行 ⇒ 红（#210 R2 惯例：用不上的放行就是后门）",
    simulateCliFlagExemptions: [
      { doc: README_EN, command: "chat", flag: "--require-deliverable", why: "测试用：这一条其实不需要放行" },
    ],
    expect: [/cli-flags: 放行条目 \(README\.md \/ chat \/ --require-deliverable\) 已经空转/],
  },
  {
    label: "#391 R4（放行分支有效）：README 删掉一个旗标 + 为它登记一条放行 ⇒ 绿（证明放行真的被读到，不是恒绿）",
    overlay: { [README_EN]: (t) => t.replace(" [--require-deliverable [<path>]]", "", 1) },
    simulateCliFlagExemptions: [
      { doc: README_EN, command: "chat", flag: "--require-deliverable", why: "测试用：这一条确实是刻意的例外" },
    ],
    expectGreen: true,
  },
  // —— issue #668 ①：压缩策略「默认值」的分层对账（库层 / CLI 层各自绑源码真值）——
  // 每例钉一侧：把谎放回去 ⇒ 红并点名行；改源码真值 ⇒ 红（证锚点绑的是源码不是文案）；
  // 只改中英一边 ⇒ 红；删掉整句声明 ⇒ 红（覆盖面）；只动措辞、不动名字 ⇒ 绿（放行证）。
  {
    label: "#668 ①：把「两层混成一句」的谎放回契约 EN（`fold-statistical` remains the default everywhere）⇒ 红并点名行号",
    overlay: {
      [CONTRACT_EN]: (t) => t.replace("No layer defaults to `fold-statistical`:",
        "`fold-statistical` remains the default everywhere (library default stays `sliding-window` when no strategy is set).\n  No layer defaults to `fold-statistical`:"),
    },
    expect: [/compaction-default\/en-remains-default-everywhere: docs\/host-consumer-contract\.md:\d+ /],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "#668 ①：把同一个谎放回契约 CN（默认 everywhere 仍是 `fold-statistical`）⇒ 红并点名行号",
    overlay: {
      [CONTRACT_CN]: (t) => t.replace("  没有任何一层默认 `fold-statistical`：",
        "  默认 everywhere 仍是 `fold-statistical`。\n  没有任何一层默认 `fold-statistical`："),
    },
    expect: [/compaction-default\/cn-default-everywhere: docs\/host-consumer-contract_cn\.md:\d+ /],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#668 ①：把库层真值 `sliding-window` 在源码里临时改名 ⇒ 红（证锚点绑的是源码，不是文案）",
    overlay: { [COMPACTION_PIPELINE_SRC]: (t) => t.replace('strategyNames: ["sliding-window"],', 'strategyNames: ["sliding-window-renamed"],') },
    expect: [/compaction-default\/library: docs\/host-consumer-contract\.md:\d+ 说库层默认是 `sliding-window`/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "#668 ①：`bin/cli.js` 帮助文本只改一处默认 ⇒ 红（CLI 层三处字样必须同源，否则源码自己就不自洽）",
    overlay: { [COMPACTION_CLI_SRC]: (t) => t.replace("（默认：fold-llm）", "（默认：fold-statistical）") },
    expect: [/compaction-default: CLI 层的三处字样彼此不一致/],
  },
  {
    label: "#668 ①：CLI 层三处字样一起改成 `fold-statistical`（源码自洽、文档没跟）⇒ 红（文档侧 CLI 声明与真值不符）",
    overlay: {
      [COMPACTION_CLI_SRC]: (t) => t.replace("（默认：fold-llm）", "（默认：fold-statistical）").replace("，默认 fold-llm；", "，默认 fold-statistical；"),
      [COMPACTION_CLI_CONST_SRC]: (t) => t.replace('export const DEFAULT_COMPACTION_STRATEGY = "fold-llm";', 'export const DEFAULT_COMPACTION_STRATEGY = "fold-statistical";'),
    },
    expect: [/compaction-default\/cli: docs\/host-consumer-contract\.md:\d+ 说CLI 层默认是 `fold-llm`/,
      /compaction-default\/cli: README\.md:\d+ 说CLI 层默认是 `fold-llm`/],
    expectFiles: [CONTRACT_EN, README_EN],
  },
  {
    label: "#668 ①：只改中文契约的库层声明（`sliding-window` → `fold-statistical`）⇒ 红（中英成对，只改一边就红）",
    overlay: { [CONTRACT_CN]: (t) => t.replace("**库层默认**（未配策略时）是 `sliding-window`", "**库层默认**（未配策略时）是 `fold-statistical`") },
    expect: [/compaction-default\/library: docs\/host-consumer-contract_cn\.md:\d+ 说库层默认是 `fold-statistical`/],
    expectFiles: [CONTRACT_CN],
  },
  {
    // issue #802：删掉整句**不再判红**（覆盖面与中英处数都只进 note）。这一格改成它真正承重的那半：
    // 删掉之后必须**没有**红（否则放宽没落地），而「句子在而值错」那一格由上面 #668 ① 的第一例守着。
    label: "#668 ①：删掉中文契约那半句 CLI 槽位默认 ⇒ **不红**（#802：句子不在不是回归）",
    overlay: { [CONTRACT_CN]: (t) => t.replace("**CLI 槽位默认**是 `fold-llm`", "**CLI 槽位**不是库默认") },
    expectGreen: true,
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#668 ①（放行证）：只改契约 EN 的措辞、不动那两个名字 ⇒ 仍然绿（闸咬的是名字与层，不是排版）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("No layer defaults to `fold-statistical`:", "The degrade target is `fold-statistical`; no layer defaults to `fold-statistical`:") },
    expectGreen: true,
  },
  // —— issue #668 ① 的**残留盲区**（本单）：① ② 靠标记词定位句子，于是「新写一句不带标记的默认声称」
  // 整句落在面外。③ 反过来：默认声称 + 内置策略名同句搭配就必须带层标记词。下面四例各钉一侧：
  // 英文谎 → 红并点名行；中文谎 → 红 + 中英处数不齐；default summarizer 那一族 → 绿（放行证）；
  // 同一句谎 + 抽掉一条判据词 → 又变绿（证规则真在判那个词，不是措辞巧合）。
  {
    label: "#668 ① ③：契约 EN 插一句**不带任何分层标记词**的默认声称（By default, compaction uses `fold-statistical`）⇒ 红并点名行",
    overlay: {
      [CONTRACT_EN]: replaceUnique("No layer defaults to `fold-statistical`:",
        "By default, compaction uses `fold-statistical` whenever a host does not configure a strategy.\n  No layer defaults to `fold-statistical`:"),
    },
    expect: [/compaction-default\/unmarked: docs\/host-consumer-contract\.md:\d+ 说默认是 `fold-statistical`/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "#668 ① ③：中文契约插同形的无标记谎（未配策略时默认用 `fold-statistical`）⇒ 红 + 中英未标记处数不齐",
    overlay: {
      [CONTRACT_CN]: replaceUnique("  没有任何一层默认 `fold-statistical`：",
        "  未配策略时默认用 `fold-statistical`。\n  没有任何一层默认 `fold-statistical`："),
    },
    // issue #802：处数普查不再判红，所以这里只留**真值判据**那一条（那句话本身是谎 ⇒ 红）。
    expect: [/compaction-default\/unmarked: docs\/host-consumer-contract_cn\.md:\d+ 说默认是 `fold-statistical`/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#668 ① ③（放行证）：「默认 + `fold-llm` + summarizer」那一族再插一句 ⇒ 仍然绿（它说的是摘要器，不是默认策略）",
    overlay: {
      [CONTRACT_EN]: replaceUnique("The `fold-llm` name injects a default summarizer that reuses **this run's provider**",
        "The `fold-llm` name injects a default summarizer that reuses **this run's provider**.\nThat default summarizer is engine-provided, and `fold-llm` itself stays opt-in."),
    },
    expectGreen: true,
  },
  {
    label: "#668 ① ③（退化证）：同一句谎 + 抽掉 `default` 这条判据词 ⇒ 又变绿（证规则真在判那个词）",
    overlay: {
      [CONTRACT_EN]: replaceUnique("No layer defaults to `fold-statistical`:",
        "By default, compaction uses `fold-statistical` whenever a host does not configure a strategy.\n  No layer defaults to `fold-statistical`:"),
    },
    simulateCompactionDropWordIds: ["en-default"],
    expectGreen: true,
  },
  // —— #668 ① ③ 的**围栏决定**（这笔改动买的是未来覆盖，这两例就是它的价钱）。
  // 背景：原实现把 ``` 围栏里的行整段跳过（理由「围栏里的是样例，不是声称」），可本仓的围栏里
  // 放的不只是样例：README 的模块树就是围栏，而 `README_cn.md:185` 那句「用本 run provider 的
  // fold-llm 默认 summarizer」是一句**真的**描述性声称。所以跳过围栏 = 整类真声称从判据里消失。
  // 下面两例钉住这个决定的**两面**：围栏里的谎必须红（否则那 3 行白删），围栏里的
  // summarizer 句子必须绿（否则排除逻辑在围栏里不成立，同样白删）。
  {
    label: "#668 ① ③（围栏）：把一句无标记的默认策略谎放进**代码围栏里** ⇒ 红并点名行（跳过围栏就等于放过这一类）",
    overlay: {
      "docs/soak.md": replaceUnique("# 便宜自测（不联网",
        "# By default, compaction uses `fold-statistical` unless a host configures a strategy.\n# 便宜自测（不联网"),
    },
    expect: [/compaction-default\/unmarked: docs\/soak\.md:\d+ 说默认是 `fold-statistical`/],
    expectFiles: ["docs/soak.md"],
  },
  {
    label: "#668 ① ③（围栏・放行证）：围栏里的「默认 + `fold-llm` + summarizer」句（README_cn.md:185 那一类）⇒ 绿",
    overlay: {
      [README_CN]: replaceUnique("provider-summarizer.js          用本 run provider 的 fold-llm 默认 summarizer",
        "provider-summarizer.js          用本 run provider 的 fold-llm 引擎默认的 summarizer"),
    },
    expectGreen: true,
  },
  // —— issue #668 ②：退役语义「摘要器失败 ⇒ 降级/兜底为统计摘要」（§2.11）——
  // 这一族此前**零自测**（上一笔只手工变异验过，没钉进清单）。下面四格各钉一侧：
  //   ①-A 谎进**活文档** → 红并点名 file:line；
  //   ②   **同一句**谎进**历史类文件** → 不红（判据只咬活面，历史正文一字不改）；
  //   ③   `fold-summary-journal` 那句带历史限定语的「`fold-llm` 的降级兜底」（#668 点名的合法保留形态）
  //        进**活文档** → 不红（靶子现读源码，不抄原文）；
  //   ④   同一句谎 + 历史限定语、落在**同一份活文档**里 → 不红（证「历史框定」这条放行读法真的在放行：
  //        它和 ①-A 只差一个限定语，一个绿一个红）。
  {
    label: "#668 ②：把「摘要器失败 ⇒ 自动降级为统计摘要」这句谎放进活文档 ⇒ 红，并点名文件+行",
    overlay: { "docs/testing.md": appendUnique(RETIRED_SEMANTICS_LIE) },
    expect: [/retired-semantics: docs\/testing\.md:\d+ 说「摘要器失败\/超时 ⇒ 自动降级或兜底为统计摘要」/],
    expectFiles: ["docs/testing.md"],
  },
  {
    label: "#668 ②（对照）：**同一句**谎放进历史类文件（`docs/decisions/`）⇒ 不红（判据只咬活面）",
    overlay: { "docs/decisions/003-compaction-strategies.md": appendUnique(RETIRED_SEMANTICS_LIE) },
    expectGreen: true,
  },
  {
    label: "#668 ②（放行证）：`fold-summary-journal` 那句带历史限定语的「`fold-llm` 的降级兜底」进活文档 ⇒ 不红",
    overlay: {
      "docs/testing.md": (t) => {
        if (JOURNAL_RETENTION_LINE === null) return t;                 // 源码里那句没了 ⇒ 变异没落上 ⇒ 红
        if (!RS_HISTORICAL.test(JOURNAL_RETENTION_LINE)) return t;     // 历史限定语被删 ⇒ 这格不再证「合法保留」
        return appendUnique(JOURNAL_RETENTION_LINE)(t);
      },
    },
    expectGreen: true,
  },
  {
    label: "#668 ②（放行证）：同一句谎 + 历史限定语、落在同一份活文档 ⇒ 不红（「历史框定」那条读法在放行）",
    overlay: {
      "docs/testing.md": appendUnique(`${RETIRED_SEMANTICS_LIE.replace("。", "")}——那是 #661 之前的行为，那条路径已被删。`),
    },
    expectGreen: true,
  },
  // ══ issue #511：「这句话属于哪个版本」+「这个版本发布了没有」 ══════════════════════
  // 本节每个用例都钉**一条判据的一侧**（红侧）或**放行侧**（绿侧）。registry 一律走 `selfTestRegistry()`
  // 夹具（派生自 CHANGELOG，见那里的注释）：自测不许依赖网络，也不许依赖「今天 registry 恰好是什么」。
  {
    label: "#511 判据 1：删掉 0.29 指南第一行的 doc-version 自述 ⇒ 红（自述是后两条判据的真值来源）",
    overlay: { "docs/host-upgrade-guide-0.29.0.md": (t) => t.replace("<!-- doc-version: 0.29.0 -->\n", "") },
    expect: [/doc-version: docs\/host-upgrade-guide-0\.29\.0\.md 的第一行不是机器可读自述/],
  },
  {
    label: "#511 判据 1：自述与文件名不同源（0.27 指南自述 0.28.0）⇒ 红（不许两份真值并存）",
    overlay: { "docs/host-upgrade-guide-0.27.0.md": (t) => t.replace("<!-- doc-version: 0.27.0 -->", "<!-- doc-version: 0.28.0 -->") },
    expect: [/doc-version: docs\/host-upgrade-guide-0\.27\.0\.md 自述 0\.28\.0，文件名是 0\.27\.0/],
  },
  {
    label: "#511 判据 1 后半：删掉 0.27 指南里那句前向指针 ⇒ 红并点名行号（正是 #511 的病：0.27 的指南在讲 0.28 的树）",
    overlay: { "docs/host-upgrade-guide-0.27.0.md": (t) => t.replace("from 0.28.0 — see the 0.28.0 upgrade guide) is", "from 0.28.0) is") },
    expect: [/version-attribution: docs\/host-upgrade-guide-0\.27\.0\.md:\d+ 这句话把事实归给 0\.28\.0/],
  },
  {
    label: "#511 判据 1（放行证）：把中文指针「见 0.28.0 升级指南」写成「见 0.28.0 指南」⇒ 仍绿（`升级` 可省是同一枚标记）",
    overlay: { "docs/host-upgrade-guide-0.27.0_cn.md": (t) => t.replace("见 0.28.0 升级指南", "见 0.28.0 指南") },
    expectGreen: true,
  },
  {
    label: "#511 判据 2a：指南声称「没有 config.run 这一组」，而它就在树里 ⇒ 红（删掉是单调声称，今天的树就是证人）",
    overlay: { "docs/host-upgrade-guide-0.29.0.md": (t) => t + "\n\nThere is no `config.run` group in 0.29.0.\n" },
    expect: [/guide-claim: docs\/host-upgrade-guide-0\.29\.0\.md:\d+ 声称 `config\.run` 不存在\/已删/],
  },
  {
    label: "#511 判据 2a（放行证 / #299 的课）：声称「没有 config.observers」⇒ 仍绿（这个名字只活在注释里，注释里的名字不是声明）",
    overlay: { "docs/host-upgrade-guide-0.29.0.md": (t) => t + "\n\nThere is no `config.observers` group in 0.29.0.\n" },
    expectGreen: true,
  },
  {
    label: "#511 判据 2c：**当前版本那份**指南里出现「9 groups」的数量声称 ⇒ 红并点名真值（指南本身不写数量，所以把错误声称注入到它上面：判据咬的是「当前版本那份指南说了什么」，靶子与期望都随 PKG_VERSION 现读，#699 ③）",
    overlay: { [SURFACE_GUIDE_EN]: (t) => t + "\n\nThe configuration namespace still reads **9 groups / 43 leaves** today.\n" },
    expect: [guideExpectRe("guide-claim", SURFACE_GUIDE_EN, /:\d+ 声称「9 groups」，而 src\/loop\/config-namespace\.js 里是 \*\*8\*\* 个分组/)],
  },
  {
    label: "#511 判据 2c：中文侧同理（「9 个分组」⇒ 红；中文数词/阿拉伯数字都要接）",
    overlay: { [SURFACE_GUIDE_CN]: (t) => t + "\n\n`config` 命名空间今天仍然是 **9 个分组 / 43 个叶子**。\n" },
    expect: [guideExpectRe("guide-claim", SURFACE_GUIDE_CN, /:\d+ 声称「9 个分组」，而 src\/loop\/config-namespace\.js 里是 \*\*8\*\* 个分组/)],
  },
  {
    label: "#511 判据 2b：指南把某个 config 叶子归给 0.29.0，而 CHANGELOG 的 0.29.0 段没有它 ⇒ 红（新增不单调，真值只能从 CHANGELOG 取）",
    overlay: { "docs/host-upgrade-guide-0.29.0.md": (t) => t + "\n\n0.29.0 adds `config.run.zzzNotThere`.\n" },
    simulateRegistry: selfTestRegistry(),
    expect: [/guide-claim: docs\/host-upgrade-guide-0\.29\.0\.md:\d+ 声称 `config\.run\.zzzNotThere` 属于 0\.29\.0/],
  },
  {
    label: "#511 判据 3：新增一个带日期、不在 registry、也没标「未发布」的版本段 ⇒ 红",
    overlay: { "CHANGELOG.md": (t) => t.replace("## [0.29.0] - 2026-10-31", "## [0.9.9] - 2026-01-01\n\n### Added\n\n- 自测夹具：一个从未发布的版本段（故意不标未发布）。\n\n## [0.29.0] - 2026-10-31") },
    simulateRegistry: selfTestRegistry(),
    expect: [/changelog-published: CHANGELOG:\d+ 的 0\.9\.9 段带日期却不在 registry 的 versions 列表里/],
  },
  {
    label: "#511 判据 3（反向）：给一个**已发布**的版本段加「未发布」标注 ⇒ 红（发布态的两个方向都看守）",
    overlay: { "CHANGELOG.md": (t) => t.replace("## [0.29.0] - 2026-10-31", "## [0.29.0] - 2026-10-31（未发布 / unpublished）") },
    simulateRegistry: selfTestRegistry(),
    expect: [/changelog-published: CHANGELOG:\d+ 的 0\.29\.0 段自称「未发布\/unpublished」/],
  },
  {
    label: `#511 评论：AGENTS.md 的「发布行」写成 ${selfTestVersionFace().previous.version}，registry 说 9.9.9 ⇒ 红（发布行的真相来源是 registry，不是 package.json）`,
    // #724：不再抄「`dist-tags.latest` — is `0.30.0`」这个字面量（发版回写之后它就不在盘上了），
    // 改用判据自己的 `pubRe` 定位，写进去的假值也从版本面现取（上一版），不引入新字面量。
    overlay: { [AGENTS_EN]: mutatePublishedClaim(selfTestVersionFace().previous.version) },
    simulateRegistry: selfTestRegistry({ latest: "9.9.9" }),
    expect: [new RegExp(`published-claim: AGENTS\\.md:\\d+ 说发布行（\`dist-tags\\.latest\`）是 `
      + `${esc(selfTestVersionFace().previous.version)}，registry 实测是 9\\.9\\.9`, "u")],
  },
  {
    label: "#511：AGENTS.md 的「本仓版本」写成 0.28.0 ⇒ 红（本仓版本对 package.json，两类句子各对各的真值）",
    overlay: { [AGENTS_EN]: mutateRepoVersionClaim("0.28.0") },
    simulateRegistry: selfTestRegistry(),
    expect: [/published-claim: AGENTS\.md:\d+ 的「AGENTS\.md「当前版本」句」把\*\*本仓版本\*\*写成 0\.28\.0/],
  },
  {
    label: "#511 第二条评论：这两句里塞一个测量日期 ⇒ 红（日期自己不会过期，留着它等于给「过期」留合法位置）",
    overlay: { [AGENTS_EN]: addMeasurementDateToRepoClaim("2026-11-03") },
    simulateRegistry: selfTestRegistry(),
    expect: [/published-claim: AGENTS\.md:\d+ 的「AGENTS\.md「当前版本」句」里带了测量日期/],
  },
  {
    // 靶子换过（261109 指令面瘦身）：「`0.24.0` was **never published**」那句已搬进冷层
    // `docs/maintenance/command-reference.md`（它不在 `publicationDocs()` 面内），所以靶子换成契约里
    // 仍在的那句同类声称（`docs/host-consumer-contract.md`，面内）。判据本身不变：未发布声称必须对着 registry。
    label: "#511：把「0.27.0 was never published」写成「0.29.0」⇒ 红（未发布声称必须对着 registry 的 versions 列表说）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("0.27.0 was never published", "0.29.0 was never published") },
    simulateRegistry: selfTestRegistry(),
    expect: [/published-claim: docs\/host-consumer-contract\.md:\d+ 说 0\.29\.0 从未发布，但它\*\*在\*\* registry/],
  },
  {
    label: "#511 判据 1（放行表空转）：在 DOC_VERSION_EXEMPT 里登记一份不存在的指南 ⇒ 红（用不上的放行就是后门，#210 R2）",
    simulateDocVersionExemptions: new Map([...DOC_VERSION_EXEMPT,
      ["docs/host-upgrade-guide-0.9.9.md", "自测夹具：这份文件不存在，登记它必须红"]]),
    expect: [/doc-version: DOC_VERSION_EXEMPT 里登记的 docs\/host-upgrade-guide-0\.9\.9\.md 不存在/],
  },
  // ══ issue #636：「该不该有一条」——代码侧名单 × CHANGELOG 加法句 ⇒ 指南必须覆盖 ══════════
  {
    label: "#636：把 0.29 指南里的 `config.continuity.handoff` 整段改名（= 删掉那一段）⇒ 红并点名「代码里有、CHANGELOG 说这一版加的」",
    // 变异体必须**不含**那个名字本身（`…handoffSwitch` 仍以 `config.continuity.handoff` 为前缀，
    // `includes()` 照样命中 ⇒ 变异等于没落上，实测就是这么假绿了一次）。
    overlay: { "docs/host-upgrade-guide-0.29.0.md": (t) => t.replaceAll("config.continuity.handoff", "the continuity handoff switch") },
    expect: [/guide-coverage: docs\/host-upgrade-guide-0\.29\.0\.md 没有提到config 叶子 `config\.continuity\.handoff`/],
  },
  {
    label: `#636：只删中文侧对 \`${guideCoverageCaseTarget().name}\` 那条事件的提及 ⇒ 红（本版段说这一版加了它，中文指南没有就是缺一条）`,
    // 前提自带（#699 ③(a)）：0.31 那种纯删除版里「这一版加了某个观察者事件」这笔加法不存在、中文指南里也
    // 没提过它 ⇒ 老写法「把 \`compaction\` 改掉」在切版树上锚不到（= 用例静默失效）。名字与加法句都由
    // `guideCoverageCaseTarget` / `addGuideCoverageClaim` 现取现补，两棵树同一判据。
    overlay: {
      ...(guideCoverageCaseTarget().inject ? { "CHANGELOG.md": addGuideCoverageClaim(guideCoverageCaseTarget().name) } : {}),
      [SURFACE_GUIDE_CN]: dropGuideMention(guideCoverageCaseTarget().name),
    },
    expect: [guideExpectRe("guide-coverage", SURFACE_GUIDE_CN,
      new RegExp(` 没有提到.* \`${esc(guideCoverageCaseTarget().name)}\``, "u"))],
  },
  {
    label: "#636 中英成对：只从中文指南里删掉一个结构化名字（`ERIX_CONTINUITY_DIR`）⇒ 红（成对判据问的是「另一侧有没有一条」）",
    overlay: { "docs/host-upgrade-guide-0.29.0_cn.md": (t) => t.replaceAll("ERIX_CONTINUITY_DIR", "环境变量") },
    expect: [/guide-coverage: docs\/host-upgrade-guide-0\.29\.0_cn\.md 没有提到环境变量 `ERIX_CONTINUITY_DIR`/],
  },
  {
    label: "#636（fail-closed）：CHANGELOG 里没有当前版本段 ⇒ 红（「这一版加了什么」的真值缺位，不许静默放行）",
    overlay: { "CHANGELOG.md": rewriteCurrentChangelogHeading(() => "## [0.9.9] - 2026-11-03") },
    simulateRegistry: selfTestRegistry(),
    expect: [new RegExp(`guide-coverage: 读不到 CHANGELOG 的 ${esc(PKG_VERSION)} 段`, "u")],
  },
  // ══ issue #635 ①：文档里的「点名几份 + 实扫几份 = 下限」份数声称必须等于实测 ══════════
  {
    label: `#635 ①：把账本英文侧的「点名文档」数从 ${REF_SCAN_TRUTH.pinned} 改成 ${REF_SCAN_TRUTH.pinned + 1} ⇒ 红并点名那份文档的哪个数（份数声称是散文时没人校，正是本单的病根）`,
    overlay: { [LEDGER_EN]: (t) => t.replace(`**${REF_SCAN_TRUTH.pinned} pinned documents`, `**${REF_SCAN_TRUTH.pinned + 1} pinned documents`) },
    expect: [new RegExp(`ref-scan-claims: docs/maintenance/symbol-anchor-ledger[.]md:[0-9]+ 声称「点名文档」${REF_SCAN_TRUTH.pinned + 1}，但脚本实测 ${REF_SCAN_TRUTH.pinned}`, "u")],
    expectFiles: [LEDGER_EN],
  },
  {
    label: `#635 ①：把 README 英文侧的「That is ${REF_SCAN_TRUTH.total} documents」改成 ${REF_SCAN_TRUTH.total - 8} ⇒ 红（份数声称与实扫不一致）`,
    overlay: { [README_EN]: (t) => t.replace(`That is ${REF_SCAN_TRUTH.total} documents`, `That is ${REF_SCAN_TRUTH.total - 8} documents`) },
    expect: [new RegExp(`ref-scan-claims: README[.]md:[0-9]+ 声称「文档合计」${REF_SCAN_TRUTH.total - 8}，但脚本实测 ${REF_SCAN_TRUTH.total}`, "u")],
    expectFiles: [README_EN],
  },
  {
    label: `#635 ①（句子被删也要红）：把中文 README 里「（当前 ${REF_SCAN_TRUTH.guides} 份，按目录实扫）」整句删掉 ⇒ 红（删句子 = 合法逃逸）`,
    overlay: { [README_CN]: (t) => t.replace(`（当前 ${REF_SCAN_TRUTH.guides} 份，按目录实扫）`, "") },
    expect: [/ref-scan-claims: README_cn\.md 里找不到「按目录实扫到的升级指南份数」那条份数声称/],
    expectFiles: [README_CN],
  },
  // ══ issue #644 ③：指令面必须指着声称链的新家（搬走了但没人知道搬哪去 = 没搬）══════════
  {
    label: "#644 ③：从 AGENTS.md 里删掉指向账本的指针 ⇒ 红并点名（指令面上再没有任何线索指向那条链）",
    overlay: { [AGENTS_EN]: (t) => t.replaceAll(LEDGER_EN, "the anchor ledger") },
    expect: [/ledger-pointer: AGENTS\.md 里没有指向 `docs\/maintenance\/symbol-anchor-ledger\.md` 的指针/],
    expectFiles: [AGENTS_EN],
  },
  {
    label: "#644 ③：中文侧同样删掉指针 ⇒ 红（中英成对：只留一侧等于另一侧的读者找不到）",
    overlay: { [AGENTS_CN]: (t) => t.replaceAll(LEDGER_CN, "那份账本") },
    expect: [/ledger-pointer: AGENTS_cn\.md 里没有指向 `docs\/maintenance\/symbol-anchor-ledger_cn\.md` 的指针/],
    expectFiles: [AGENTS_CN],
  },
  // ══ 14b：0.30 破坏包的逐名表由闸对账（issue #429 的**文档面**）══════════════════════
  // 这一族证的是「表不是手抄的」：删一行 / 加一行 / 只改一边 / 同一个名字两行 / 中英入口列不一致，五种都要红
  // 并点名，而只改散文必须仍然绿（闸咬事实，不咬措辞）。
  // issue #688 之后**候选集为空**（16 个名字全删），按节头写明的边界，这一页转为历史记录：逐名集合与条款
  // 不再有现算真值可对（那是设计好的降级，不是漏做），但中英名集、行形状（重名）与入口列中英一致三条照样咬。
  {
    label: "14b：破坏包指南删掉一行（`estimateMessagesTokens`）⇒ 红并点名那个名字",
    overlay: { [BUNDLE_GUIDE_EN]: dropBundleRow("estimateMessagesTokens") },
    expect: [/bundle-table: docs\/host-upgrade-guide-0\.31\.0\.md 缺 `estimateMessagesTokens`/,
      /bundle-table: docs\/host-upgrade-guide-0\.31\.0\.md \/ docs\/host-upgrade-guide-0\.31\.0_cn\.md 中英两份的名字集合不一致（只改一边不算改）：CN 有 EN 没有：estimateMessagesTokens/],
    expectFiles: [BUNDLE_GUIDE_EN],
  },
  {
    label: "14b：破坏包指南多一行不存在的名字（`createNothingProvider`）⇒ 红并点名（多一个也是假话）",
    overlay: {
      [BUNDLE_GUIDE_EN]: insertBundleRow("createCompositeToolProvider",
        "| `createNothingProvider` | nothing at all | no in-tree replacement | `.` | `createNothingProvider` (`src/tools/providers.js`) |"),
    },
    expect: [/bundle-table: docs\/host-upgrade-guide-0\.31\.0\.md 多出 `createNothingProvider`/,
      /bundle-table: docs\/host-upgrade-guide-0\.31\.0\.md \/ docs\/host-upgrade-guide-0\.31\.0_cn\.md 中英两份的名字集合不一致（只改一边不算改）：EN 有 CN 没有：createNothingProvider/],
    expectFiles: [BUNDLE_GUIDE_EN],
  },
  {
    label: "14b：只改中英一边（CN 删掉同一行 `setNotesClock`）⇒ 红：CN 缺名 + 中英名字集合不一致",
    overlay: { [BUNDLE_GUIDE_CN]: dropBundleRow("setNotesClock") },
    expect: [/bundle-table: docs\/host-upgrade-guide-0\.31\.0_cn\.md 缺 `setNotesClock`/,
      /bundle-table: docs\/host-upgrade-guide-0\.31\.0\.md \/ docs\/host-upgrade-guide-0\.31\.0_cn\.md 中英两份的名字集合不一致（只改一边不算改）：EN 有 CN 没有：setNotesClock/],
    expectFiles: [BUNDLE_GUIDE_CN],
  },
  {
    label: "14b：把一行的迁移条款改成自编说法 ⇒ 红（条款的唯一真值在那个名字的 `@deprecated` 标记里；#688 之后靠退役标记仍在源码里）",
    overlay: {
      [BUNDLE_GUIDE_EN]: (t) => t.replace("migrate to `estimateMessageTokens` — identical behaviour",
        "migrate to `estimateMessageTokensV2` — better behaviour"),
    },
    expect: [/bundle-table: docs\/host-upgrade-guide-0\.31\.0\.md:\d+ `estimateMessagesTokens` 的迁移条款格没照抄标记里的那一条/],
    expectFiles: [BUNDLE_GUIDE_EN],
  },
  {
    label: "14b：同一个名字写两行 ⇒ 红（多出来那行不会被集合对账看见）",
    overlay: {
      [BUNDLE_GUIDE_EN]: insertBundleRow("setNotesClock",
        "| `setNotesClock` | a duplicate row | no in-tree replacement | `./tools` | `setNotesClock` (`src/tools/notes.js`) |"),
    },
    expect: [/bundle-table: docs\/host-upgrade-guide-0\.31\.0\.md 同一个名字有两行：`setNotesClock`/],
    expectFiles: [BUNDLE_GUIDE_EN],
  },
  {
    label: "14b：把一行的入口列在 EN 侧改掉 ⇒ 红（入口是事实，不是措辞：中英必须逐字相同）",
    overlay: {
      [BUNDLE_GUIDE_EN]: (t) => t.replace("| `./tools` | `createStaticToolProvider` (`src/tools/providers.js`) |",
        "| `.` | `createStaticToolProvider` (`src/tools/providers.js`) |"),
    },
    expect: [/bundle-table: docs\/host-upgrade-guide-0\.31\.0\.md \/ docs\/host-upgrade-guide-0\.31\.0_cn\.md 里 `createStaticToolProvider` 的入口列中英不一致：EN「`\.`」vs CN「`\.\/tools`」/],
    expectFiles: [BUNDLE_GUIDE_EN],
  },
  {
    label: "14b：破坏包指南只改散文（末尾补一段不陈述事实的话）⇒ 仍然 0 错（闸咬事实，不咬措辞）",
    overlay: { [BUNDLE_GUIDE_EN]: (t) => `${t}\n\nA closing paragraph that states no fact at all.\n` },
    expectGreen: true,
  },
  // ══ issue #677：契约「套件清单」的 unknownSlot 形态（§2.12）════════════════════════════
  // 这一族的靶子**自包含**：行按「小节标题 + 行首键」定位，替换文本由 `suiteInventoryRowLine` 从零构造
  // （不抄文档原话），于是文档将来怎么改写都不会让变异体与文档脱节。七格各钉一侧：
  //   ① EN 单侧压平 → 红；② CN 单侧压平 → 红；③ 只改 EN 一条腿 → 红（缺语义 + 中英背离）；
  //   ④ 真值改名 → 红；⑤ 真值少一种形态 → 红；⑥ 注释里写第三种形态 → 绿（注释不是真值）；
  //   ⑦ 两侧换成同义改写（= 恢复正确语义）→ 绿（闸咬语义，不咬措辞）；
  //   ⑧ 那一行不在目标文档里时 → 「变异没落上」算失败（#210 R2）。
  {
    label: "#677：EN 单侧把套件清单的未知槽名答案压平成一条（两种形态都「必须抛」）⇒ 红并点名 EN",
    overlay: {
      [CONTRACT_EN]: mutateSuiteInventoryRow(CONTRACT_EN,
        () => suiteInventoryRowLine(CONTRACT_EN, SUITE_INVENTORY_FLAT[CONTRACT_EN])),
    },
    expect: [/suite-inventory: docs\/host-consumer-contract\.md:\d+ 的 `model-config-provider\.js` 行被压平了/,
      /suite-inventory: docs\/host-consumer-contract\.md:\d+ 的 `model-config-provider\.js` 行缺一条语义——单配置形态任何槽名都返回同一份配置/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "#677：CN 单侧把同一处答案压平 ⇒ 红并点名 CN（中英成对：只留一侧的正确语义不算修好）",
    overlay: {
      [CONTRACT_CN]: mutateSuiteInventoryRow(CONTRACT_CN,
        () => suiteInventoryRowLine(CONTRACT_CN, SUITE_INVENTORY_FLAT[CONTRACT_CN])),
    },
    expect: [/suite-inventory: docs\/host-consumer-contract_cn\.md:\d+ 的 `model-config-provider\.js` 行被压平了/,
      /suite-inventory: docs\/host-consumer-contract_cn\.md:\d+ 的 `model-config-provider\.js` 行缺一条语义——单配置形态任何槽名都返回同一份配置/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#677：只改 EN 一条腿（单配置那段删掉「不是未知回落 default」）⇒ 红：缺语义 + 中英背离",
    overlay: {
      [CONTRACT_EN]: mutateSuiteInventoryRow(CONTRACT_EN,
        () => suiteInventoryRowLine(CONTRACT_EN, SUITE_INVENTORY_ONE_LEG_MISSING[CONTRACT_EN])),
    },
    expect: [/suite-inventory: docs\/host-consumer-contract\.md:\d+ 的 `model-config-provider\.js` 行缺一条语义——单配置形态是\*\*形态差异\*\*/,
      /suite-inventory: 中英背离——「单配置形态是\*\*形态差异\*\*[\s\S]*?只有 docs\/host-consumer-contract_cn\.md 写了，docs\/host-consumer-contract\.md 没有/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "#677：套件真值把 `single-config` 改名成 `single`（文档没跟）⇒ 红：多出一种形态 + 少了一种形态",
    overlay: { "test/contract/model-config-provider.js": (t) => t.split('"single-config"').join('"single"') },
    expect: [/suite-inventory\/truth: test\/contract\/model-config-provider\.js 的 unknownSlot 形态里多出 `single`/,
      /suite-inventory\/truth: test\/contract\/model-config-provider\.js 的 unknownSlot 形态里抽不到 `single-config`/],
  },
  {
    label: "#677：套件真值里 `single-config` 这个形态整个没了（只剩 throws）⇒ 红（真值少一种形态、文档还在讲）",
    overlay: { "test/contract/model-config-provider.js": (t) => t.split('"single-config"').join('"throws"') },
    expect: [/suite-inventory\/truth: test\/contract\/model-config-provider\.js 的 unknownSlot 形态里抽不到 `single-config`/],
  },
  {
    label: "#677（放行证）：真值文件的**注释**里提到第三种形态 ⇒ 仍绿（注释里讲形态不是真值）",
    overlay: {
      "test/contract/model-config-provider.js": appendUnique('// unknownSlot.mode === "third-mode" —— 注释里讲形态不算真值（issue #677）'),
    },
    expectGreen: true,
  },
  {
    label: "#677（恢复证）：中英两侧都换成同义改写（形态语义一条不少）⇒ 绿（闸咬语义，不咬措辞）",
    overlay: {
      [CONTRACT_EN]: mutateSuiteInventoryRow(CONTRACT_EN,
        () => suiteInventoryRowLine(CONTRACT_EN, SUITE_INVENTORY_CANON[CONTRACT_EN])),
      [CONTRACT_CN]: mutateSuiteInventoryRow(CONTRACT_CN,
        () => suiteInventoryRowLine(CONTRACT_CN, SUITE_INVENTORY_CANON[CONTRACT_CN])),
    },
    expectGreen: true,
  },
  {
    label: "#677 变异器空转证：套件清单那一行不在目标文档里时，必须判「变异没落上」而不是假绿（#210 R2）",
    overlay: {
      "docs/testing.md": mutateSuiteInventoryRow(CONTRACT_EN,
        () => suiteInventoryRowLine(CONTRACT_EN, SUITE_INVENTORY_CANON[CONTRACT_EN])),
    },
    expectMutateMiss: true,
  },  // ══ issue #677 补充范围（#475）：强制收尾资格「按状态，不按 reason 枚举」（§2.13）══════════
  // 三种形状各钉一侧，外加「改源码成员集合而不改契约 ⇒ 必红」与「变异没落上算失败」：
  //   ① EN 单侧退回假话 → 红；② CN 单侧退回假话 → 红；③ 只改 EN 一条腿 → 红（缺语义 + 中英背离）；
  //   ④ 源码两个 reason 集合都加一个成员、契约不改 → 红（固定名单 × 成员集合失配）；
  //   ⑤ 源码 guard 集合删掉 `no_tool` → 红（「覆盖 ≠ 安全」那句失去真值）；
  //   ⑥ 两侧同义改写（= 恢复正确语义）→ 绿；⑦ §7 那段不在目标文档里 → 「变异没落上」算失败（#210 R2）。
  {
    label: "#677（#475）：EN 单侧把强制收尾资格退回「reason 白名单 + 固定六个」的假话 ⇒ 红并点名 EN",
    overlay: {
      [CONTRACT_EN]: mutateForcedFinalEligibility(CONTRACT_EN, () => FORCED_FINAL_FLAT[CONTRACT_EN]),
    },
    expect: [/forced-final: docs\/host-consumer-contract\.md:\d+ 的 §7 被压平\/退回假话——把资格写成「白名单/,
      /forced-final: docs\/host-consumer-contract\.md:\d+ 的 §7 被压平\/退回假话——把资格写成固定条数/,
      /forced-final: docs\/host-consumer-contract\.md:\d+ 的 §7 缺一条语义——资格是\*\*一个状态\*\*，不是 reason 白名单/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "#677（#475）：CN 单侧把同一句退回假话 ⇒ 红并点名 CN（中英成对：只留一侧的正确口径不算修好）",
    overlay: {
      [CONTRACT_CN]: mutateForcedFinalEligibility(CONTRACT_CN, () => FORCED_FINAL_FLAT[CONTRACT_CN]),
    },
    expect: [/forced-final: docs\/host-consumer-contract_cn\.md:\d+ 的 §7 被压平\/退回假话——把资格写成「白名单/,
      /forced-final: docs\/host-consumer-contract_cn\.md:\d+ 的 §7 缺一条语义——资格是\*\*一个状态\*\*，不是 reason 白名单/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#677（#475）：只改 EN 一条腿（不再说「其余 reason 只过一个判据：整个 run 一个字都没写过」）⇒ 红：缺语义 + 中英背离",
    overlay: {
      [CONTRACT_EN]: mutateForcedFinalEligibility(CONTRACT_EN, () => FORCED_FINAL_ONE_LEG_MISSING[CONTRACT_EN]),
    },
    expect: [/forced-final: docs\/host-consumer-contract\.md:\d+ 的 §7 缺一条语义——其余 reason 只过一个判据：整个 run 一个字都没写过/,
      /forced-final: 中英背离——「其余 reason 只过一个判据：整个 run 一个字都没写过」只有 docs\/host-consumer-contract_cn\.md 写了，docs\/host-consumer-contract\.md 没有/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "#677（#475）：源码两个 reason 集合都加一个成员、契约一个字不改 ⇒ 红（固定名单 × 源码成员集合失配）",
    overlay: {
      "src/loop/termination.js": (t) => mutateReasonSet(FORCED_FINAL_GUARD_SET, { add: ["zzz_probe_reason"] })(
        mutateReasonSet(FORCED_FINAL_TRUNCATED_SET, { add: ["zzz_probe_reason"] })(t)),
    },
    expect: [/forced-final: docs\/host-consumer-contract\.md:\d+ 的 §7 漏掉了 `zzz_probe_reason`/,
      /forced-final: docs\/host-consumer-contract_cn\.md:\d+ 的 §7 漏掉了 `zzz_probe_reason`/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "#677（#475）：源码 guard 集合删掉 `no_tool` ⇒ 红（「覆盖 ≠ 安全」那句点名的成员不再成立）",
    overlay: { "src/loop/termination.js": mutateReasonSet(FORCED_FINAL_GUARD_SET, { remove: ["no_tool"] }) },
    expect: [/forced-final: docs\/host-consumer-contract\.md:\d+ 的 §7 说 `no_tool` 早就在 `FINAL_GUARD_TERMINATION_REASONS` 里/,
      /forced-final: docs\/host-consumer-contract_cn\.md:\d+ 的 §7 说 `no_tool` 早就在 `FINAL_GUARD_TERMINATION_REASONS` 里/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "#677（#475・恢复证）：中英两侧都换成同义改写（五条腿一条不少）⇒ 绿（闸咬语义，不咬措辞）",
    overlay: {
      [CONTRACT_EN]: mutateForcedFinalEligibility(CONTRACT_EN, () => FORCED_FINAL_CANON[CONTRACT_EN]),
      [CONTRACT_CN]: mutateForcedFinalEligibility(CONTRACT_CN, () => FORCED_FINAL_CANON[CONTRACT_CN]),
    },
    expectGreen: true,
  },
  {
    label: "#677（#475）变异器空转证：§7 那段不在目标文档里时，必须判「变异没落上」而不是假绿（#210 R2）",
    overlay: {
      "docs/testing.md": mutateForcedFinalEligibility(CONTRACT_EN, () => FORCED_FINAL_FLAT[CONTRACT_EN]),
    },
    expectMutateMiss: true,
  },
  // —— #690：「不变」那一节 × 本版 CHANGELOG 的字段真值（六格逐格对账）——
  // 前三条就是**改动前的原句**：把某一格退回修前的写法 ⇒ 必须红，且点名「格名 + 字段名」。
  // 这一族证明的是「闸真咬人」——不是跟着改口一起变绿。
  {
    label: `#690（还原）EN 磁盘格式退回改动前的原句 ⇒ 红并点名 ${surfaceCaseEvidence("disk").name}`,
    overlay: {
      ...(surfaceCaseEvidence("disk").inject ? { "CHANGELOG.md": addSurfaceEvidence("disk") } : {}),
      [SURFACE_GUIDE_EN]: putSurfaceBullet("en", "disk",
        "* Transcript and run-state on-disk formats; a ledger written by the previous release still resumes."),
    },
    expect: [
      guideExpectRe("unchanged-surface", SURFACE_GUIDE_EN, /:\d+ 第「on-disk formats」格写着不变/),
      new RegExp(esc(surfaceCaseEvidence("disk").name), "u"),
    ],
    expectFiles: [SURFACE_GUIDE_EN],
  },
  {
    label: `#690（还原）EN 诊断字段退回「observer events, diagnostic fields…」那句 ⇒ 红并点名 ${surfaceCaseEvidence("diagnostics").name}`,
    overlay: {
      ...(surfaceCaseEvidence("diagnostics").inject ? { "CHANGELOG.md": addSurfaceEvidence("diagnostics") } : {}),
      [SURFACE_GUIDE_EN]: putSurfaceBullet("en", "diagnostics",
        "* Observer events, diagnostic fields, and the run-state block."),
    },
    expect: [
      guideExpectRe("unchanged-surface", SURFACE_GUIDE_EN, /:\d+ 第「diagnostic fields」格写着不变/),
      new RegExp(esc(surfaceCaseEvidence("diagnostics").name), "u"),
    ],
  },
  {
    label: `#690（还原）EN 终局载荷退回「Termination, verification and exit-code…」那句 ⇒ 红并点名 ${surfaceCaseEvidence("finalPayload").name}`,
    overlay: {
      ...(surfaceCaseEvidence("finalPayload").inject ? { "CHANGELOG.md": addSurfaceEvidence("finalPayload") } : {}),
      [SURFACE_GUIDE_EN]: putSurfaceBullet("en", "finalPayload",
        "* Termination, verification and exit-code semantics, including the `skipped`-without-guard exit code."),
    },
    expect: [
      guideExpectRe("unchanged-surface", SURFACE_GUIDE_EN, /:\d+ 第「final payload」格写着不变/),
      new RegExp(esc(surfaceCaseEvidence("finalPayload").name), "u"),
    ],
  },
  {
    label: `#690（中英各自判）CN 诊断字段整格缺席 ⇒ 红在 CN 这一侧，EN 不受影响（证据：${surfaceCaseEvidence("diagnostics").name}）`,
    // 缺席必须是「这一格被删」，不能是「整节本来就没有按格的形状」——所以两侧都先写成规范六格，
    // 中文侧再少写那一格（#699 ③(a)；0.31 的 §4 是一段散文，直接删那条 bullet 会什么都删不掉）。
    overlay: {
      ...(surfaceCaseEvidence("diagnostics").inject ? { "CHANGELOG.md": addSurfaceEvidence("diagnostics") } : {}),
      [SURFACE_GUIDE_EN]: writeSurfaceCells("en"),
      [SURFACE_GUIDE_CN]: writeSurfaceCells("cn", "diagnostics"),
    },
    expect: [
      guideExpectRe("unchanged-surface", SURFACE_GUIDE_CN, /:\d+ 第「诊断字段」格整格缺席/),
      new RegExp(esc(surfaceCaseEvidence("diagnostics").name), "u"),
    ],
    expectFiles: [SURFACE_GUIDE_CN],
    reject: [guideExpectRe("unchanged-surface", SURFACE_GUIDE_EN, /(?:)/)],
  },
  {
    label: `#690 声明了变更却不点名该格字段 ⇒ 红（「变了」不点名等于没对账；该格证据：${surfaceCaseEvidence("disk").name}）`,
    overlay: {
      ...(surfaceCaseEvidence("disk").inject ? { "CHANGELOG.md": addSurfaceEvidence("disk") } : {}),
      [SURFACE_GUIDE_EN]: putSurfaceBullet("en", "disk",
        "* **On-disk formats — changed in this release.** The fold ledger moved; the names are in §1."),
    },
    expect: [
      guideExpectRe("unchanged-surface", SURFACE_GUIDE_EN, /:\d+ 第「on-disk formats」格声明了变更，却没有点名/),
      new RegExp(esc(surfaceCaseEvidence("disk").name), "u"),
    ],
  },
  {
    label: "#690 读不出（①）：§4 那一节被改名 ⇒ 红，且是「读不出」那一族（exit 2）",
    overlay: {
      // 节号别抄：`§4` 是 0.31 那份指南的编号，0.32 那份是 §9 ⇒ 抄一个号，切版当天变异就打不上，
      // 自测红的是「变异没落上」（0.32 切版树实测）。按判据自己的标题形状改，编号是几都落得上。
      [SURFACE_GUIDE_EN]: (t) => t.replace(/^## \d+\. What does not change\b/mu, "## 4. Notes on what moved"),
    },
    expect: [guideExpectRe("unchanged-surface", SURFACE_GUIDE_EN, / 里找不到「不变」那一节/)],
  },
  {
    label: "#690 读不出（②）：本版 CHANGELOG 段读不到 ⇒ 红（真值缺位不许当绿）",
    overlay: { "CHANGELOG.md": rewriteCurrentChangelogHeading((line) => line.replace(`## [${PKG_VERSION}]`, `## ${PKG_VERSION}`)) },
    expect: [new RegExp(`unchanged-surface: 读不到 CHANGELOG 的 ${esc(PKG_VERSION)} 段`, "u")],
  },
  {
    label: "#690（反向证）纯加法的名字不是变更证据：本版「无变更证据」那一格写「不变」仍绿",
    // 靶子那一格由 `surfaceAdditiveProbe` 现选（前提「这一格本版没有变更证据」是本版事实而非恒真；
    // 0.32 的 `options` 真变了 ⇒ 写死 `options` 会让这条 expectGreen 在整个发布窗口恒红）。
    overlay: {
      [SURFACE_GUIDE_EN]: (t) => surfaceAdditiveProbe("en", t),
      [SURFACE_GUIDE_CN]: (t) => surfaceAdditiveProbe("cn", t),
    },
    expectGreen: true,
  },
  // ══ issue #697：CHANGELOG 段首日期（§17b）═══════════════════════════════════════════
  // 判据是两半：未发布段不许带日期（①）；已发布段日期 ↔ tag 日期（②）。③ 是两种 exit 的分工：
  // 「registry 说已发布但没有 tag」= **exit 2 未判定**，不是红。所有 tag/registry 事实都走夹具
  // （`simulateTagFacts` / `simulateRegistry`），**不依赖本机 tag 面与网络**。
  //
  // **版本面由夹具自己合成**（issue #724，见 `selfTestVersionFace` 的节头）：这一族每一例都带
  // `simulateVersionFace`，于是「在飞的那一版」的段首是**夹具刚写下**的那一行（`faceInflightHeading()`），
  // 变异锚点不是从真树抄来的字符串 ⇒ 「变异没落上」不可能因为发版而复发。registry 桩一律 `selfTestRegistry()`
  // （派生 = 发布行停在 `released` 上），tag 面一律 `faceTagFacts()`（最小面：released / previous 两段）。
  {
    label: "#697 ①：正在准备的那一段（版本序最高）标了未发布却带着发布日期 ⇒ 红（registry 不可得也判）",
    simulateVersionFace: true,
    overlay: {
      "CHANGELOG.md": rewriteSectionHeading(selfTestVersionFace().inflight.version,
        () => `## [${selfTestVersionFace().inflight.version}] - ${shiftDay(selfTestVersionFace().released.date, 1)}（未发布 / unpublished）`),
    },
    simulateRegistry: { ok: false, why: "self-test 夹具：registry 不可得" },
    expect: [new RegExp(`changelog-date: CHANGELOG:\\d+ 的 ${esc(selfTestVersionFace().inflight.version)} 段`
      + `标了「未发布 / unpublished」却带着发布日期 ${esc(shiftDay(selfTestVersionFace().released.date, 1))}`, "u")],
    expectExit: 1,
  },
  {
    label: "#697 ②：已发布段的日期与 tag 日期不一致 ⇒ 红并点名两个日期",
    simulateVersionFace: true,
    overlay: {
      "CHANGELOG.md": rewriteSectionHeading(selfTestVersionFace().previous.version,
        (line) => line.replace(selfTestVersionFace().previous.date, shiftDay(selfTestVersionFace().previous.date, 1))),
    },
    simulateRegistry: selfTestRegistry(),
    simulateTagFacts: faceTagFacts(),
    simulateDateTagExemptions: [],
    expect: [new RegExp(`changelog-date: CHANGELOG:\\d+ 的 ${esc(selfTestVersionFace().previous.version)} 段写 `
      + `${esc(shiftDay(selfTestVersionFace().previous.date, 1))}，tag v${esc(selfTestVersionFace().previous.version)} 是 `
      + `${esc(selfTestVersionFace().previous.date)}`, "u")],
    expectExit: 1,
  },
  {
    label: "#697 ②（登记证）：同一处不一致登记进 CHANGELOG_DATE_TAG_EXEMPTIONS ⇒ 绿（历史事实不改）",
    simulateVersionFace: true,
    overlay: {
      "CHANGELOG.md": rewriteSectionHeading(selfTestVersionFace().previous.version,
        (line) => line.replace(selfTestVersionFace().previous.date, shiftDay(selfTestVersionFace().previous.date, 1))),
    },
    simulateRegistry: selfTestRegistry(),
    simulateTagFacts: faceTagFacts(),
    simulateDateTagExemptions: [{ version: selfTestVersionFace().previous.version, why: "self-test 探针：登记之后同一处不一致不红" }],
    expectGreen: true,
  },
  {
    label: "#697 ②（空转证）：登记表里一条对不上任何不一致的条目 ⇒ 红（#210 R2）",
    simulateVersionFace: true,
    overlay: { "CHANGELOG.md": rewriteSectionHeading(selfTestVersionFace().inflight.version, () => faceInflightAltHeading()) },
    simulateRegistry: selfTestRegistry(),
    simulateTagFacts: faceTagFacts(),
    simulateDateTagExemptions: [{ version: "9.9.9", why: "self-test 探针：空转条目" }],
    expect: [/changelog-date: CHANGELOG_DATE_TAG_EXEMPTIONS 里 9\.9\.9 那一条是空转的/],
    expectExit: 1,
  },
  {
    label: "#697 ③：registry 说 latest 已发布但没有 tag ⇒ 未判定 TAG_MISSING，exit 2 而不是红",
    simulateVersionFace: true,
    overlay: { "CHANGELOG.md": rewriteSectionHeading(selfTestVersionFace().inflight.version, () => faceInflightAltHeading()) },
    simulateRegistry: selfTestRegistry(),
    simulateTagFacts: { ok: true, dates: new Map(), source: "self-test 夹具：一个 tag 都没有" },
    simulateDateTagExemptions: [],
    expectNotJudged: ["TAG_MISSING"],
    expectExit: 2,
  },
  {
    label: "#697 ③（历史段无 tag 不判）：registry 说已发布但不是 latest、又没有 tag ⇒ 记一笔跳过，不 exit 2（只有 latest 缺 tag 才算 TAG_MISSING）",
    simulateVersionFace: true,
    overlay: { "CHANGELOG.md": rewriteSectionHeading(selfTestVersionFace().inflight.version, () => faceInflightAltHeading()) },
    simulateRegistry: selfTestRegistry(),
    simulateTagFacts: {
      ok: true,
      dates: new Map([[selfTestVersionFace().released.version,
        { date: selfTestVersionFace().released.date, kind: "annotated" }]]),
      source: "self-test 夹具：只有 latest 那个 tag",
    },
    simulateDateTagExemptions: [],
    expectGreen: true,
  },
  {
    label: "#697（历史段不受 (a) 管）：历史段的「带日期 + 正文标未发布」不改口 ⇒ 绿",
    simulateVersionFace: true,
    overlay: {
      "CHANGELOG.md": rewriteSectionHeading(selfTestVersionFace().historicalMarked.version,
        (line) => line.replace(selfTestVersionFace().historicalMarked.date,
          shiftDay(selfTestVersionFace().historicalMarked.date, 1))),
    },
    simulateRegistry: selfTestRegistry(),
    simulateTagFacts: faceTagFacts(),
    simulateDateTagExemptions: [],
    expectGreen: true,
  },
  {
    label: "#697 ⑤（放行证）：未发布段换成本仓另一种合法无日期形状 ⇒ 绿",
    simulateVersionFace: true,
    overlay: { "CHANGELOG.md": rewriteSectionHeading(selfTestVersionFace().inflight.version, () => faceInflightAltHeading()) },
    simulateRegistry: selfTestRegistry(),
    simulateTagFacts: faceTagFacts(),
    simulateDateTagExemptions: [],
    expectGreen: true,
  },
  {
    label: "#697（干净检出）：tag 面读不出 ⇒ 日期↔tag 这一半跳过，不判红（#280 口径）",
    simulateVersionFace: true,
    overlay: { "CHANGELOG.md": rewriteSectionHeading(selfTestVersionFace().inflight.version, () => faceInflightAltHeading()) },
    simulateRegistry: selfTestRegistry(),
    simulateTagFacts: { ok: false, why: "self-test 夹具：不是 git 仓（干净检出）" },
    simulateDateTagExemptions: [],
    expectGreen: true,
  },
  // ══ issue #724：反向证的反向证（判据 3 的机器面）══════════════════════════════════════
  {
    // 模拟一次**发布回写**：在飞那一段改成已发布形（段首带日期）、AGENTS 中英两句的发布行跟着走到
    // 新发布行、registry 与 tag 面同步 ⇒ 整棵树必须仍然**绿**。
    // 为什么不是「在自测里再跑一遍自测」：那是 199 例 × 199 例（≈ 11 小时），而且它要证的并不是
    // 「自测自己可重入」，而是**版本面换了、判据与夹具都不红**这一件事。两副真版本面上的整趟
    // `--self-test` 是这条用例的实测背书（issue #724 交付报告里贴了两次退出码）。
    label: "#724（回写模拟）：在飞的那一段按发布回写改成已发布形（段首带日期、AGENTS 发布行与 registry 一起走到新发布行）⇒ 绿",
    simulateVersionFace: true,
    overlay: {
      "CHANGELOG.md": rewriteSectionHeading(selfTestVersionFace().inflight.version,
        () => `## [${selfTestVersionFace().inflight.version}] - ${shiftDay(selfTestVersionFace().released.date, 1)}`),
      [AGENTS_EN]: mutatePublishedClaim(selfTestVersionFace().inflight.version, 0),
      [AGENTS_CN]: mutatePublishedClaim(selfTestVersionFace().inflight.version, 1),
    },
    simulateRegistry: {
      ok: true,
      authoritative: true,
      latest: selfTestVersionFace().inflight.version,
      versions: [...selfTestRegistry().versions, selfTestVersionFace().inflight.version],
      source: "self-test 夹具：回写之后（新发布行 = 在飞那一版）",
    },
    simulateTagFacts: {
      ok: true,
      dates: new Map([
        [selfTestVersionFace().released.version, { date: selfTestVersionFace().released.date, kind: "annotated" }],
        [selfTestVersionFace().inflight.version,
          { date: shiftDay(selfTestVersionFace().released.date, 1), kind: "annotated" }],
      ]),
      source: "self-test 夹具：回写之后的两段 tag",
    },
    simulateDateTagExemptions: [],
    expectGreen: true,
  },
];


/** #279：自测用例数的**下限**（只许涨不许降）。少了就是有用例被删 / 被整例跳过——那正是
 *  「拿跳过换全绿」的溃败方向，与棘轮基线同理：降下限必须写理由，不能默默降。 */
const MIN_SELF_TEST_CASES = 99;   // #677 加了两族反向证/放行证（「套件清单 unknownSlot」+「强制收尾资格 #475」）；工单 261021-03 B1 加了 6 例前缀反向证（实测 **109** 例：#337 又加 2 例目录规则反向证，修前 95 例；#391 R4 又加 6 例 `cli-flags` 反向证/放行证；下限留余量给并行分支，见上：别按当天条数写死）

function runSelfTest() {
  const run = () => collectAllDrift();
  const failures = [];
  const passed = [];
  // #279：**期望自己也要被看守**。「把期望放宽」就是本单要防的那个溃败方向，所以先静态校一遍：
  //   · 能匹配**空串**的期望（`.*/^/[\s\S]*/x*`）等于没有断言——拿它「永真」糊过一例就当场报红；
  //   · 既不是放行证（expectGreen）又没写 expect / expectFiles 的一例 = 整例被跳过；
  //   · 用例数低于下限 = 有用例被删。
  // 三刀都在跑变异**之前**报，以免「先全绿了再看」。变异未落上则由循环里的 `after === before` 报。
  if (SELF_TEST_CASES.length < MIN_SELF_TEST_CASES) {
    failures.push(`用例数被削：现在 ${SELF_TEST_CASES.length} 例，下限 ${MIN_SELF_TEST_CASES} 例——删用例 / 整例跳过不算修好`);
  }
  // #286 T-a：提取器自己也有一处「空转就能全绿」的形状——覆盖面或提取正则被改坏时，符号锚点会抽到
  // 0 处，于是本节所有反向证同时变成空跑。先问一句，别等用例自己变绿。
  if (!symbolAnchorOccurrences(refScanDocs()).length) {
    failures.push("symbol-anchor: 覆盖面里抽到 0 处「符号 + 文件」锚点——提取逻辑或覆盖面被改坏，"
      + "本节全部符号锚点反向证都在空跑（抽不到真值就报错，#164 口径）");
  }
  // #703：**注入型证人必须被判据自己归回它那一格**。`surfaceCellOf` 按 `SURFACE_CELLS` 的顺序
  // **先命中的那格赢**，而成员真值里一批名字同时属于几格（`degradeReason` 既是折叠账本的记录字段也是
  // 诊断字段）。名字归错格时，注入下去红的是**另一格** ⇒ 用例报「红了但没点该点的名」，看着像文档漂移、
  // 其实是夹具在说谎（0.31 探针树上实测到的是 disk 抽到 `degradeReason`）。不等到切版那天才暴。
  for (const cellId of Object.keys(SURFACE_CASE_PREFERRED)) {
    const truths703 = surfaceTruthMap();
    const attributed703 = [...(truths703.get(cellId) ?? [])]
      .filter((n) => surfaceCellOf(n, { quoted: true, truths: truths703 })?.id === cellId);
    if (!attributed703.length) {
      failures.push(`#690 夹具（#703）：「${cellId}」那一格的真值里没有一个名字是判据会归回本格的 ⇒ 注入型证人无法成立。`
        + "要么提取器把名字全给了排在它前面的格（归属顺序飘了），要么提取面被改坏（抽不到真值就报错，#164 口径）");
    }
  }
  // #699 ③：**当前版**指南的路径在期望里被抄成字面量，就是「切版当天整族反向证变红」的病根
  // （判据现算 `docs/host-upgrade-guide-<本版>.md`，期望还在要上一版那份）。这一刀把它钉死：
  // 期望 / reject 里出现「本版指南」那条路径的，必须由 `guideExpectRe` 现读常量构造。
  for (const [i, c] of SELF_TEST_CASES.entries()) {
    const who3 = c.label ?? `第 ${i + 1} 例`;
    for (const [key, list] of [["expect", c.expect ?? []], ["reject", c.reject ?? []]]) {
      for (const re of list) {
        const src = String(re?.source ?? "");
        // 只有「红话路径 = 当前版指南」的那两个判据受这一刀管：`unchanged-surface` 与 `guide-coverage`
        // 现算 `docs/host-upgrade-guide-${PKG_VERSION}.md`。`bundle-table` 那份是 0.31 破坏包的**历史**逐名表
        // （路径是钉住的那份指南，不随当前版走），历史指南（0.27 / 0.29）的字面量同理——都不算抄错。
        const judge = src.match(/^([a-z][a-z0-9-]*(?:\/[a-z0-9-]+)?):/u)?.[1];
        const named = src.match(/host-upgrade-guide-(\d+\.\d+\.\d+)/u)?.[1];
        if ((judge === "unchanged-surface" || judge === "guide-coverage")
          && named === PKG_VERSION && re?.pinnedToTruthPath !== true) {
          failures.push(`${who3}：${key} 里把当前版指南写成字面量（${named}）——切版当天这一例必然红在路径上；`
            + "用 `guideExpectRe(判据 id, SURFACE_GUIDE_EN/CN, …)` 现读常量构造（#699 ③）");
        }
      }
    }
  }
  for (const [i, c] of SELF_TEST_CASES.entries()) {
    const who = c.label ?? `第 ${i + 1} 例`;
    for (const re of c.expect ?? []) {
      if (re.test("")) failures.push(`${who}：期望被削弱——正则 ${re} 连空串都匹配，等于没有断言（不许拿「永真」糊过这一例）`);
    }
    // #337：`reject` 是「必须**不**出现的形状」。连空串都匹配的 reject 会禁掉一切报错，同样是没断言。
    for (const re of c.reject ?? []) {
      if (re.test("")) failures.push(`${who}：反向期望被削弱——reject 正则 ${re} 连空串都匹配，等于禁止一切报错`);
    }
    if (!c.expectGreen && !c.expectMutateMiss && !c.expectNotJudged
      && !(c.expect ?? []).length && !(c.expectFiles ?? []).length) {
      failures.push(`${who}：期望被削弱——既不是放行证（expectGreen）也没写 expect / expectFiles / expectNotJudged，等于整例被跳过`);
    }
  }
  // issue #697：日期↔tag 那一半的**真值面**在自测里必须是夹具。否则自测会绑在本机 tag 面上（
  // 干净检出 / 浅克隆里没有 tag），而且「对照组绿」会变成「这台机器碰巧有那几个 tag」。
  const tagFactsSaved = SIM_TAG_FACTS;
  SIM_TAG_FACTS = selfTestTagFacts();
  const control = run();
  SIM_TAG_FACTS = tagFactsSaved;
  if (control.length) {
    failures.push(`对照组（源码与文档都不改）本该 0 错，实测 ${control.length} 处：\n      ${control.join("\n      ")}`);
  } else {
    passed.push("对照：源码与文档都不改 → 0 错");
  }
  // #302：一例可以声明多份**合成树夹具**（`simulateTreeShapes`），每个形状各跑一遍、各自断言——
  // 要证的是「同一份声明在三种树形下同判」，而不是「在检查机碰巧有的那个树形下绿」。
  // 返回 { pass, msg }；所有状态还原（OVERLAY / 树形口子 / 配置口子）都在这里，调用方只管记账。
  function execCase(c, shape) {
    const label = shape ? `${c.label}［树形 ${shape}］` : c.label;
    // issue #697：tag 面夹具必须在**应用 overlay 之前**派生——否则「夹具从被测文档派生」会让
    // 「改日期 ⇒ 仍绿」变成永真（夹具与被测面同源，就是本单要堵的那种假绿）。
    const tagFixture = selfTestTagFacts();
    // issue #724：**版本面**夹具先落上（`simulateVersionFace`）。它只能改文本（overlay），所以「在飞的那一版」
    // 的段首是夹具自己写下的那一行 ⇒ 本用例的变异锚点（`faceInflightHeading()`）就指在这一行上。
    // 落不上（锚行找不到）**不在这里单独报**：那时用例自己的变异也打不中，由下面那条既有的
    // 「变异没落到 X 上」报红——同一味病不拿第二条判据重复计数。
    if (c.simulateVersionFace) {
      const faceBefore = read("CHANGELOG.md");
      const faced = renderVersionFace(faceBefore);
      if (faced !== faceBefore) OVERLAY.set("CHANGELOG.md", faced);
    }
    let missedOn = null;   // #286 T-a：变异没打上的那一处（`expectMutateMiss` 用例等的就是它）
    for (const [rel, mutate] of Object.entries(c.overlay ?? {})) {   // #280：纯树形例可以不带 overlay
      // #724：读**当前生效的文本**（`textOf`）而不是盘上那一份——上面刚落上的版本面夹具就在 OVERLAY 里，
      // 用例的变异锚点（`faceInflightHeading()`）指的正是夹具写下的那一行。没有预置 overlay 时
      // `textOf === read`（两者同源），所以这一改对其余 197 例是零行为变化。
      const before = textOf(rel);
      const after = mutate(before);
      if (after === before) { missedOn = rel; break; }
      OVERLAY.set(rel, after);
    }
    if (missedOn !== null) {
      OVERLAY.clear();
      return c.expectMutateMiss
        ? { pass: true, msg: `${c.label} → 变异确实没落上（${missedOn}），「变异器空转也算失败」这条判据在生效` }
        : { pass: false, msg: `${label}：变异没落到 ${missedOn} 上（反向证自身失效：脚本里的变异体已与文档/源码脱节）` };
    }
    if (c.expectMutateMiss) {
      OVERLAY.clear();
      return { pass: false, msg: `${label}：这一例要的就是「变异打不上」，结果打上了——靶子已存在于文档，换一个不存在的靶子` };
    }
    // #302：树形用合成树夹具模拟（只影响实物清单与那一个谓词，声明一侧一律不动），跑完必须还原。
    const simSaved = SIM_TREE_SHAPE;
    SIM_TREE_SHAPE = shape ?? null;
    const guideSaved = SIM_RENAMED_GUIDE;                       // #286 返工 R2：覆盖面缩面的树形口子
    SIM_RENAMED_GUIDE = c.simulateRenamedGuide ?? null;
    const scanCountBefore = LAST_SCAN_DOC_COUNT;
    let looseDeclSaved = null;                                  // #286 返工 R4：豁免判据的配置口子
    if (c.simulateLooseDecl) {
      const target = BARE_LINE_EXEMPTIONS.find((x) => x.doc === c.simulateLooseDecl.doc && x.target === c.simulateLooseDecl.target);
      if (!target) {
        OVERLAY.clear(); SIM_RENAMED_GUIDE = guideSaved; SIM_TREE_SHAPE = simSaved;
        return { pass: false, msg: `${label}：配置口子没落上（豁免表里找不到 ${c.simulateLooseDecl.doc} / ${c.simulateLooseDecl.target}）` };
      }
      looseDeclSaved = [target, target.decl];
      target.decl = /.*/;
    }
    // #337：目录**类别**的配置口子（与 simulateLooseDecl 同一课：overlay 只改文本，改不动运行时那张 Map）。
    // 用来证「未登记 → 红、登记之后同一目录 → 不再红」这对反向证的两半；跑完必须在 finally 里还原。
    let dirClassSaved = null;
    if (c.simulateIgnoreDirClass) {
      const { pattern } = c.simulateIgnoreDirClass;
      dirClassSaved = [pattern, IGNORED_DIR_CLASSES.get(pattern) ?? null];
      IGNORED_DIR_CLASSES.set(pattern, { kind: c.simulateIgnoreDirClass.kind, why: c.simulateIgnoreDirClass.why });
    }
    // #391 R4：CLI 旗标放行表的配置口子（与 simulateLooseDecl / simulateIgnoreDirClass 同一课：
    // overlay 只改文本，改不动运行时那个数组）。放行分支与「空转即红」两条反向证都靠它。
    const cliExemptSaved = SIM_CLI_FLAG_EXEMPTIONS;
    if (c.simulateCliFlagExemptions) SIM_CLI_FLAG_EXEMPTIONS = c.simulateCliFlagExemptions;
    // #511：registry 事实的配置口子（同一课：overlay 只能改文档，改不动「门禁从 registry 读到了什么」）。
    // 夹具只在**本用例的 run()** 里挂着，跑完在 finally 里还原——一条也不许留在全局。
    const registrySaved = SIM_REGISTRY;
    if (c.simulateRegistry) SIM_REGISTRY = c.simulateRegistry;
    // issue #697：tag 面 / 历史不一致登记表的配置口子（同一课：overlay 只能改文档，改不动
    // 「门禁从 git 读到了什么」与运行时那张登记表）。默认用夹具，一条也不许留在全局。
    const tagFactsSaved = SIM_TAG_FACTS;
    SIM_TAG_FACTS = c.simulateTagFacts ?? tagFixture;
    const dateExemptSaved = SIM_DATE_TAG_EXEMPTIONS;
    if (c.simulateDateTagExemptions) SIM_DATE_TAG_EXEMPTIONS = c.simulateDateTagExemptions;
    // #511：doc-version 放行表的配置口子（证「登记了却没人用 ⇒ 红」那一半）。
    const docExemptSaved = SIM_DOC_VERSION_EXEMPT;
    if (c.simulateDocVersionExemptions) SIM_DOC_VERSION_EXEMPT = c.simulateDocVersionExemptions;
    // #668 ① ③：判据词表的配置口子（同一课：overlay 只能改文档，改不动运行时那份词表）。
    // 退化证靠它：抽掉 `en-default` 之后同一句谎又变绿 ⇒ 证规则真在判那个词，不是措辞巧合。
    // 抽的名字必须**真的在表里**（配置口子没落上就算探针失败，不许把 exit 0 当通过）。
    const wordIdsSaved = SIM_COMPACTION_DROP_WORD_IDS;
    if (c.simulateCompactionDropWordIds) {
      const unknown = c.simulateCompactionDropWordIds
        .filter((id) => !COMPACTION_DEFAULT_WORDS.some((word) => word.id === id));
      if (unknown.length) {
        OVERLAY.clear(); SIM_TREE_SHAPE = simSaved; SIM_RENAMED_GUIDE = guideSaved;
        return { pass: false, msg: `${label}：配置口子没落上（判据词表里没有 ${unknown.join(", ")}）` };
      }
      SIM_COMPACTION_DROP_WORD_IDS = c.simulateCompactionDropWordIds;
    }
    let errs = [];
    let landing = null;    // #302：夹具有没有真的落上（null = 本例不挂夹具）
    let afterWhy = null;   // #337：assertAfter 必须在配置口子**还挂着**的时候问（否则临时登记已被还原）
    try {
      errs = run();
      if (shape && LAST_IGN) landing = treeFixtureLanding(LAST_IGN);
      if (c.assertAfter) afterWhy = c.assertAfter({ errs });
    } finally {
      SIM_TREE_SHAPE = simSaved; SIM_RENAMED_GUIDE = guideSaved;
      SIM_CLI_FLAG_EXEMPTIONS = cliExemptSaved;   // 放行表一条也不许留在全局
      SIM_REGISTRY = registrySaved;                // #511：registry 夹具同上
      SIM_TAG_FACTS = tagFactsSaved;               // #697：tag 面夹具同上
      SIM_DATE_TAG_EXEMPTIONS = dateExemptSaved;   // #697：登记表口子同上
      SIM_DOC_VERSION_EXEMPT = docExemptSaved;     // #511：doc-version 放行表同上
      SIM_COMPACTION_DROP_WORD_IDS = wordIdsSaved; // #668 ① ③：判据词表一条也不许留在全局
      if (looseDeclSaved) looseDeclSaved[0].decl = looseDeclSaved[1];   // 判据必须还原，别把探针留在表里
      if (dirClassSaved) {                                              // 同上：临时登记的类别一条也不许留在表里
        const [pattern, prev] = dirClassSaved;
        if (prev) IGNORED_DIR_CLASSES.set(pattern, prev); else IGNORED_DIR_CLASSES.delete(pattern);
      }
      OVERLAY.clear();
    }
    // #279 的教训：「变异没落上」的空跑会交出一条假的绿。树形口子也一样——但判据是**夹具声明与索引是否
    // 一致**（`treeFixtureLanding`），不是「本机实物掉了几条」（那条在空目录的机器上恒真地误报，#302）。
    // #286 返工 R2：树形口子也要证「真的落上了」——说要模拟一份指南改名，覆盖面份数却没变就是没接进 refScanDocs。
    if (c.simulateRenamedGuide && LAST_SCAN_DOC_COUNT > 0 && LAST_SCAN_DOC_COUNT === scanCountBefore) {
      return { pass: false, msg: `${label}：覆盖面树形口子没落上（说要模拟 \`c.simulateRenamedGuide\` 改名，但 refScanDocs() 的份数没变）` };
    }
    if (landing) return { pass: false, msg: `${label}：树形夹具没落上——${landing}` };
    // #337：绿只说明「静态分类不再报」，证不到扫描面——这里让用例自己再问一句生产谓词（如
    // 「这条类别真在 SKIPPED_DIR_KINDS 里」）。返回非空字符串就是失败。
    if (afterWhy) return { pass: false, msg: `${label}：${afterWhy}` };
    // issue #697：「未判定」自己就是结论（`TAG_MISSING` ⇒ exit 2，不是红）。
    if (c.expectNotJudged) {
      const items = collectChangelogDateErrors.notJudged ?? [];
      const codes = items.map((x) => x.code);
      const missedCodes = c.expectNotJudged.filter((code) => !codes.includes(code));
      if (missedCodes.length) {
        return { pass: false, msg: `${label}：未判定里没有 ${missedCodes.join(", ")}（实测 ${codes.join(", ") || "空"}）——TAG_MISSING 没被认出来` };
      }
      if (errs.length) {
        return { pass: false, msg: `${label}：这是「未判定」用例，不该红（实测 ${errs.length} 处：${errs.join(" ; ")}）` };
      }
      return { pass: true, msg: `${label} → 未判定 ${codes.join(", ")}、0 处红（未判定 ≠ 红）` };
    }
    // 退出码只能有一份来源（#575 的纪律）：这一栏读的是主路径用的那个 `docsDriftExitCode`。
    if (c.expectExit !== undefined) {
      const notJudged = collectChangelogDateErrors.notJudged ?? [];
      const code = docsDriftExitCode({ errors: errs, warnings: [], readFailures: [], notJudged, strict: true });
      if (code !== c.expectExit) {
        return { pass: false, msg: `${label}：退出码应为 ${c.expectExit}，实测 ${code}（红 ${errs.length} 处 / 未判定 ${notJudged.length} 处）` };
      }
    }
    if (c.expectGreen) {
      return errs.length
        ? { pass: false, msg: `${label}：变异之后本该绿（这条是在证「白名单/就地声明真的在放行」），实测 ${errs.length} 处红：\n      ${errs.join("\n      ")}` }
        : { pass: true, msg: `${label} → 仍然 0 错（放行分支有效，不是恒绿）` };
    }
    const missed = (c.expect ?? []).filter((re) => !errs.some((e) => re.test(e)));
    const missedFiles = (c.expectFiles ?? []).filter((rel) => !errs.some((e) => e.includes(rel)));
    // #337：红得「对」还不够，还得「没红错地方」——比如把「新增目录规则未登记」报成 `paths:` 的
    // 「引用了无法裁决的仓库内路径」（#337 的病：人看到红以为是真文档漂移，白排查一轮）。
    const rejected = (c.reject ?? []).filter((re) => errs.some((e) => re.test(e)));
    if (!errs.length) return { pass: false, msg: `${label}：改了但没红（锚点仍是 fail-open）` };
    if (rejected.length) {
      return { pass: false, msg: `${label}：红了，但报成了不该报的形状（命中 reject：${rejected.map((r) => String(r)).join(" ; ")}）`
        + `——这一例要的是「点名未登记的目录规则」，不是「文档漂移/无法裁决」那类误报：\n      实测：${errs.join("\n      ")}` };
    }
    if (missed.length || missedFiles.length) {
      return { pass: false, msg: `${label}：红了，但错误信息没点该点的名／没覆盖该覆盖的文件`
        + `（未命中 ${missed.map((r) => String(r)).join(" ; ") || "—"}${missedFiles.length ? `；未覆盖 ${missedFiles.join(", ")}` : ""}）`
        + `\n      实测：${errs.join("\n      ")}` };
    }
    return { pass: true, msg: `${label} → ${errs.length} 处红（已点名）` };
  }
  for (const c of SELF_TEST_CASES) {
    for (const shape of c.simulateTreeShapes ?? [null]) {
      const r = execCase(c, shape);
      if (r.pass) passed.push(r.msg); else failures.push(r.msg);
    }
  }
  console.log(`docs-drift-check --self-test：全部锚点的反向证（改→红、不改→绿、放行分支变异→绿；变异未落上也算失败）`);
  for (const p of passed) console.log(`  ✓ ${p}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (failures.length) {
    console.log(`docs-drift-check --self-test: 失败 — ${failures.length}/${SELF_TEST_CASES.length + 1} 例未达预期`);
    process.exit(1);
  }
  console.log(`docs-drift-check --self-test: OK — ${SELF_TEST_CASES.length} 例反向证/放行证全部按预期，对照组绿`);
}

if (SELF_TEST) {
  runSelfTest();
  process.exit(0);   // 自测只跑清单/单位类锚点与 package.json 清单那套比较器，不附带跑全部门禁
}

if (VERBOSE) {
  console.log("docs-drift-check 检查面：");
  for (const c of checked) console.log(`  ✓ ${c}`);
}
if (NOT_JUDGED.length) {
  // issue #697：未判定（`TAG_MISSING`）自己的形状。机器可读的 `docs-drift-check: 未判定 <CODE> — …` 前缀
  // 是 `release:day` 的 writeback 分辨「tag 还没打」与「别的读不出」的入口（只靠退出码分不出来）。
  console.log(`docs-drift-check: 未判定 — ${NOT_JUDGED.length} 处真值缺位（exit 2：未判定既不是绿也不是红）`);
  for (const item of NOT_JUDGED) console.log(`docs-drift-check: 未判定 ${item.code} — ${item.message}`);
}
if (READ_FAILURES.length) {
  console.log(`docs-drift-check: 读不出 — ${READ_FAILURES.length} 处真值缺位（exit 2：读不出永远不等于绿）`);
  for (const e of READ_FAILURES) console.log(`  ✗ ${e}`);
}
// 退出码只有一份来源（#575 的同款纪律）：主路径与 `--self-test` 读同一个 `docsDriftExitCode`，
// 所以「未判定 ⇒ exit 2 而不是红」这条映射在自测里是可证的，而不是靠读代码相信。
const EXIT_CODE = docsDriftExitCode({
  errors, warnings, readFailures: READ_FAILURES, notJudged: NOT_JUDGED, strict: STRICT,
});
if (EXIT_CODE === 1) {
  console.log(`docs-drift-check: 失败 — ${errors.length} 处漂移${STRICT && warnings.length ? `，${warnings.length} 处告警（--strict）` : ""}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}
if (EXIT_CODE === 0) {
  console.log(
    `docs-drift-check: OK — 版本/默认值/清单（含中英逐处对账）/模块地图/路径/中英骨架共 ${checked.length} 项对齐 package.json ${PKG_VERSION} 与源码`
    + (warnings.length ? `（${warnings.length} 处告警，先告警后阻塞：\n` + warnings.map((w) => `  ⚠ ${w}`).join("\n") + "\n）" : ""),
  );
}
process.exit(EXIT_CODE);