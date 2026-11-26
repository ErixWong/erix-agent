# 命令参考——`AGENTS.md` §3 / §4 的冷层

> English version: [command-reference.md](command-reference.md)

`AGENTS.md` 是指令面：每次会话自动注入、模型不查证就照着执行，所以它只装「每次任务都要遵守」的东西，体积由
`npm run check:agents-directives` 看守（issue #726）。这一页是另一半——每道闸背后的参考材料，**只在你要碰那道闸
的时候**才读。

下面每一块都是 issue #726 从 `AGENTS.md` **逐字搬出来**的（§3 命令表里的长说明、它下面的长注释，以及 §4 里那几段
指针点名的段落）。一个字都没有改写，纪律句也一句都没搬：红线、发布纪律、git 边界、环境与模型规矩仍留在指令面上。
标题就是指令面指过来的锚点（`#check-docs`、`#type-ratchets`、`#docs-anchors` …），所以从 `AGENTS.md` 点过来的
链接落在解释那道闸的那一节。

## test-suite
全量测试（`node --test`）

## check-single-file
语法安全检查

## check-syntax
**全量**语法检查（issue #187）：`scripts/syntax-check.mjs` 把 `git ls-files` 里每一个跟踪的 `.js`/`.mjs`/`.cjs`（`src/`、`bin/`、`scripts/`、`test/`、`examples/`、`fixtures/`）都过一遍 `node --check`，红就点名文件并非零退出。`npm run check` 故意**保留**成单文件的 `node --check src/index.js`：`check:docs` 会校文档引用的命令真的存在，把它换掉反而制造文档漂移

## check-test-summary
**已删除（issue #905）。** 它把 `npm test` 打印的 `tests` / `pass` / `skipped` 汇总数与一张手工维护的登记表逐项对账；但把这张表维持同步原来是记账税、不是判定（并行的另一笔 commit 整笔内容就是「套件改后把数字重登一次」）。留下来的真判据是 `npm test` 的退出码——全量套件仍在 CI 里跑，非 0 退出就是红。

## check-changelog
**碰到公开面的合并必须在版本 CHANGELOG 段里被点名**（issue #691 —— #636 预言、#686 量到的那个缺口）：`scripts/changelog-coverage-check.mjs` 回答的是其他 CHANGELOG 门禁都没问的那个问题——*该不该有一条*。区间与段都从树里现读，不拄手写清单：待判版本 = `CHANGELOG.md` 里最新的 `## [x.y.z]` 段（`--version` 可指定），区间 = 版本序上比它小的最大 tag `..` 该版本自己的 tag（该版本还没打 tag 时上端取 `HEAD`），合并集 = `git log --first-parent --merges`。一个合并算**行为可见**，当且仅当它的 first-parent diff（`git diff --name-only <merge>^1 <merge>`）碰到公开面路径——`src/`、`bin/`、`package.json`、两份 README、宿主契约、需求文件、或本版升级指南；只碰测试、内部文档、`scripts/`、交付记录、`AGENTS*`、CI 配置、示例的合并归**类别豁免**，那是规则算出来的、不是往登记表里塞的。覆盖**只查一边**：每一个碰到公开面的合并号都必须在那个版本的 CHANGELOG 段里、或在已登记的豁免里——散文里引用旧 issue 号是合法的，反向会把它们判成假红。红时点名 issue 号、合并的短 sha、以及它碰到的公开面文件。`COVERAGE_EXEMPTIONS` 只为**反向**情形存在（看起来属类别豁免、但确实行为可见）：每条都要带 `why`，空转条目红、空 `why` 红，条数与 `COVERAGE_EXEMPTION_MAX` **双向**对账。区间端点解析不出、段读不到、git 不可用 ⇒ exit 2 而不是放行。`node scripts/changelog-coverage-check.mjs --self-test` 是这条闸自己的反向证，跑在 `os.tmpdir()` 里**自建的合成 git 仓**上（自己的 tag、分支与合并，不碰本仓历史），并且把接线本身也当判据：阻塞的 CI 步骤排在 Test suite 步骤（`npm test`）之后、checkout 取全历史、npm script 指向那个文件。**这条条目由谁写（issue #702）**：碰到公开面的那个 PR，在**它自己这个 PR 里**把自己那个 issue 号写进本版 CHANGELOG 段。闸比的是**编号**——段正文与合并主题走的是同一个取号器，而条目从来不要求带合并 sha（还没发生的那次合并的 sha 不可知，要求它等于让每一条 PR 对自己恒红）。所以条目里写 `#702` 就够了，sha 事后可以补；忘写编号就会红在 `main` 上，那道红是强制在生效，不是 bug，也不是塞进 `COVERAGE_EXEMPTIONS` 的理由（那张表只为反向情形存在：看着属类别豁免、实则行为可见）。`npm run release:day -- --stage preflight` 第一步照旧跑它，没有豁免

## check-docs
文档漂移检查（`scripts/docs-drift-check.mjs`：版本声明、README 引用的 `files`/`exports` 清单、模块地图、文中路径与命令、从 `src/` 直抽的关键默认值（规则集在脚本里，本文不抄条数）、`bin/cli.js` 帮助文本与两份 README 的 usage 行双向对账的 CLI 旗标清单、中英 README 标题骸架，**以及自 issue #511 起的「这句话属于哪个版本」**：每份升级指南第一行必须自述版本；把事实归给**后面**那个版本的句子必须带指向那份指南的前向指针；「没有 `config.X`」对 `CONFIG_NAMESPACE_SCHEMA` 核、「V 加的」对该版 CHANGELOG 段核；每个带日期的 CHANGELOG 段必须写明发布了没有；`AGENTS*.md` 那两句「当前版本」当场对账——本仓版本对 `package.json`、发布行对 npm 的 `dist-tags.latest`——且两句都不许带测量日期），**以及自 issue #668 起的退役语义**：摘要器失败是终局错误，所以任何把「降级 / 兜底」这类动词与「统计摘要」并列的句子都必须带三种合法读法之一——直接否定、对照（`instead of` / `rather than`），或同一段里的历史框定——平铺直叙的声称会红并点名文件与行，而历史类页面正文一字不改；这条判据同时绑到源码真值（`fold-llm` 的代码面必须仍有那条终局错误路径、退役横幅不得回到代码面），**issue #677 起的契约「套件清单」**：中英套件清单里 `model-config-provider.js` 那一行按 provider 形态逐条对账到 `test/contract/model-config-provider.js` 的 `unknownSlot` 形态——槽位图形态（static / json-file）未知槽名必须抛错、点名该槽名并列出可用槽位、不得回落 default，单配置形态则任何槽名都返回同一份配置，这是形态差异而不是「未知回落 default」——于是把两种形态压平成一句、只改一侧少一条腿、或改真值的形态集合而文档没跟，都会红，**同一批 #677 还接了强制收尾资格那一句**：契约 §7（停止后验证）同样上闸——资格必须写成状态，而不是 reason 白名单或固定条数，它点名的三条不可续跑 reason 必须等于 `src/loop/termination.js` 的 `FORCED_FINAL_TRUNCATED_REASONS`，而 `end_turn` / `no_tool` 必须真在那个文件的 `FINAL_GUARD_TERMINATION_REASONS` 里，于是把它压平回白名单口径、只改一侧少一条腿、或改源码成员集合而契约没跟，都会红；且条数由命令自己打印（本文不抄）+ 中英契约标题结构对齐
同上，但把告警升级为失败

## docs-anchors
清单/枚举/单位类锚点的反向证自测（issue #210）：改文档一处声明 → 红、改源码真值 → 红、都不改 → 绿；变异没落上去也算失败（#210 R2） **自 issue #302 起，在哪棵树里跑都不影响结论**：`#280` 那两条树形用例跑在**合成树夹具**上，判定与本机是否存在那个不入库的 `docs/tasks/` 目录无关——「无 / 空 / 有 `docs/tasks/`」三种形状各在 `git archive HEAD | tar -x` 造出的检出里跑一遍，例数与红数都由那条命令自己打印（本文两个数都不抄）。#302 之前是另一回事：没有 `docs/tasks/` 的检出里 3 例是**已知假红**（树里有个空的则 5 例），由 issue #281 记录在案——那批红已经不存在，所以「必须在开发树里跑」是历史，不是现在的要求。
- 锚点粒度（issue #210）：**不要默认「文档里删一处提及就会红」**——多数锚点是*存在性*级的（`defaults`
全组、`modulemap`、`paths`：它们只问「那个文件里有没有这个字符串」，所以从同一句里删掉一处额外提及仍然绿）。只有这些是*逐处*级的（每个声明点单独比对，缺 / 多 / 改名都红）：`version`
的当前版本声明、README 的 `files` /`exports` 围栏（与 `package.json`
**双向对称**比对——文档里改名或删键也会红，不只是多写才红），以及清单/枚举/单位类锚点（文件工具清单、CLI 工具清单、vendor 跳过目录、`formatSize` 的单位档位与每一条 `` `字节数` →
`可读值` `` 示例映射、内置压缩策略名），以及 `cli-flags` 锚点（issue #391 R4：`erix chat` / `erix repl` 两条 usage 行的旗标集合与 `bin/cli.js`
帮助文本**双向逐处**对账——帮助里加了旗标而 README 忘了写是红，README 凭空多写一个也是红；`-c|--continue`、`--no-final-guard` 这类别名一律计入；放行表
`CLI_FLAG_EXEMPTIONS` 必须空着或逐条写明理由，条目空转本身即红）。这些锚点还会对账**中英两侧的声明点处数**，接住「把某一侧的整句声明删掉」这一类。每条逐处锚点的反向证都固化在
`node scripts/docs-drift-check.mjs --self-test` 里；**该入口已删除**（任务 261126-59）——它在人工
`docs:pass` 之外没有主顾、一次约 8.5 分钟，且**已红 23 例无人发现**。每个锚点属于哪一级、以及剩下那些
为何**没**升级，写在脚本头部注释里。
- 文档行号锚点（issue #286，第一批 T-a）：文档不得依赖**裸行号**。`paths` 过去在解析引用时会把 `:1234` 剥掉，
  于是只校到「文件在不在」——行号漂到别的函数、甚至漂出文件末尾都照样绿（契约曾把 `src/store/notes.js` 的 limit
  校验指到第 398 行，而那个文件只有 383 行）。现在三条锚点钉住这件事，三条都接进了 `--self-test`：
  *`symbol-anchor`* 是**逐处**级的：每一处 `` `符号`（`路径`） `` 或 `[符号](路径)` 形式的引用，都必须在**那个文件里**
  抽到该符号的真实声明（`function` / `class` / `const|let|var` 绑定 / 解构 / 再导出 / 方法 / 对象键 / `process.env.X`）。
  抽取只认**代码面**：注释与字符串字面量先被涂成空格，只活在注释里或引号里的名字**不算**声明（issue #299——
  修之前，块注释里写一行 `const X = 1;` 就能「证明」X 已声明，注释里一句带引号的名字还能喂进弱档）。
  找不到符号就红，报错会点名该文件里**实际存在的相近符号**；一个文件里连一条声明都抽不到同样算红（#164 口径：
  抽不到真值不许静默放行）。**字符串值**（终止原因、provider 错误码）是唯一弱一档的形态，只在
  `scripts/docs-drift-check.mjs` 的 `SYMBOL_VALUE_MEMBERSHIP` 里逐份点名并写明理由的那 5 个文件里被接受（第 5 份 `bin/final-guard.js` 是 issue #743 加的，为的是让 CLI guard 那两个 skip reason 真被校一次）。
  符号锚点判的是它点名的那个符号：把 `` `符号`（`路径:1517-1531`） `` 改写成裸 `路径:1517-1531`，不改变该符号在目标文件里是否
  存在，`symbols` 直接查这条真值——点名的符号不存在就红。#908 拆掉了旧的**只增不减下限** `SYMBOL_ANCHOR_MIN_UNIQUE` 与它
  指向的测量日志 `docs/maintenance/symbol-anchor-ledger*.md`（都已删除）；存在性与区间相交这两条真值本身不变。
  *`symbol-shape`*（issue #755）管**另外两种**写法，它们在 `symbol-anchor` 眼里一直是隐形的：**S2**
  `` `路径`: `符号` and `符号` ``（文件在前、冒号、一个或多个反引号符号——#755 的现场就是
  `src/loop/tool-result-ttl.js`: `stubFor` and `placeholderFor`，而这两个符号在该文件里**都不存在**）；
  **S3** 一个 code span 里写 `路径:符号`。声明表与 `symbol-anchor` 相同，只少 `X:` 一项（对象键在这里
  **不算**声明：S2/S3 比 S1 严一档，正因为冒号写法会让对象键看起来像符号）。目录前缀是一份显式登记表
  （`src/` `bin/` `scripts/` `test/` `examples/` `fixtures/`），指向**别的仓**的引用
  （`EXTERNAL_REPO_PREFIXES`）不查。**只写符号不给文件**的散文列举**故意不在范围内**——没有文件可对。
  存量违规由 `SYMBOL_EXISTENCE_BASELINE` 钉住，**只降不升**，语义与 `check:types` 同构：超过 ⇒ 红
  （报错逐条点名 文档:行、符号、文件），低于 ⇒ 绿 + 一句「可下调」提示，`--verbose` 逐条列出剩下的每一组，
  基线才有被真正做下去的可能。（原有三条 `--self-test` 反向证把它钉住，该入口已随任务 261126-59 删除；
  判据本身未变。）
  *`symbol-anchor-span`*（#286 第二刀 T-b1a）是上面那条的**逐处**搭档：符号锚点**自带行号区间**时
  （`` `符号`（`路径:1517-1531`） ``），该区间必须**与该符号在被引文件里的真值位相交**（`lo <= p <= hi`）。真值位 =
  该名字的**全部**声明处（不只首处：`sideEffect` 在持久化归一化与 `fail()` 里各合法出现一次），再加上那 4 份点名文件里
  该具名字面量的出现行。区间指错地方正是 #286 的漂移形状——符号对、行号错，而旧的 `paths` 在解析前把行号剥掉，根本
  看不见。合法修法两条：**删掉区间**（`` `符号`（`路径`） ``，首选：行号会漂，`symbols` 从来不需要它），或把区间挪到真的
  覆盖声明处。不带区间的锚点不在本判据范围内，这也正是「删区间」能让下面那道棘轮合法下降的原因。
  *`bare-lines`* 按唯一 (文档, 目标文件, 行区间) 统计 `src/**.js:N` / `:N-M` 形态的裸行号引用。#908 起它是**提示，不阻塞**：
  `check:docs` 照旧统计并打一行 `BARE-LINES-ADVISORY 现存 N 处（提示，不阻塞）`，但不再因份数压红——旧的**只降不升**
  `BARE_LINE_REF_BASELINE` 棘轮（及其测量日志 `docs/maintenance/symbol-anchor-ledger*.md`）已随 #908 拆除。复核用
  `node scripts/docs-drift-check.mjs --verbose`（实测数字只在那条命令输出里，不在本文抄）。豁免走 `BARE_LINE_EXEMPTIONS`，**三个信号缺一不放行**（评审 R4 把从前的整行 OR 收紧成 AND）：
  ① 表里点名这一条（文档 + 占位路径）；② 引用行里确实写着那个占位路径；③ 同一行还有「示例/示意/宿主仓根」
  这类就地声明词——同一行剩着一句 `for example` 之类的附带措辞不算声明。条目自己还要过配置校（声明词若能
  匹配空串 = 这一侧恒真、或带 `g` 标志让 `.test()` 变有状态 ⇒ 红）；没被任何引用用到的条目本身也会红
  （与 #286 已落在 `test/static-guards.test.js` 的双条件同口径）。
  行号越界是**错误**，不是观察项。覆盖面是宿主真会读的那批文档：两份 README、中英 AGENTS、中英契约、中英架构、中英图表、中英需求对照、`examples/pi-extension/README.md`，加上
  **全部** `docs/host-upgrade-guide*.md`（按目录实扫，新指南一落地就自动在面内）。按目录实扫有一个静默失效的形状：
  把某份指南改名到不再匹配那个模式，脚本侧和用同一个 glob 的测试侧**一起**少一份，两边数字仍然相等 ⇒ 覆盖面悄悄缩面。
  覆盖面不再设数字下限（#908）；`check:docs` 代表的份数（点名文档 + 目录实扫到的指南）**只报不判**（261122）：
  `check:docs` 每次把实测值打成一条 `ref-scan-claims` 提示，文档里写了个不一样的数也只是**提示**、不再判红——
  「让文档复述一个没人拿来做决定的测量」属于自指类判据（每加一份指南就要连带改四处）。覆盖面不再设数字下限：
  改名到不匹配模式的指南由下面的硬编码点名清单抓（不靠份数阈值）。并且 `test/docs-anchor-ratchet.test.js` 里另硬编码了同一批点名文档：**改名或删除**其中一份是红（那是覆盖面被悄悄缩了），**新增**指南不红——它自动进锚点覆盖面（261122 裁决：要求清单与实扫集合逐份相等，等于每加一份指南就多一次改清单的税，而读者看不到任何收益）。`CHANGELOG.md` 明确**不参与**：
  它的行号记的是「发版那一刻为真」的事实，改掉等于伪造历史（与 #278 的简称登记表同一套理由）。
  第一批 T-a 做的是基建与棘轮；第二批 T-b1a 把契约里**自带区间的符号锚点**那一族改绿（中英同一个 PR），基线从 244 降到 232；第三批 T-b1b 收尾同一族——两份契约里剩下的裸 `src/loop/orchestrator.js:N[-M]` 条目要么**删掉区间**（首选，并把真声明处的符号名写进句子：`resolvedModelConfig` / `reportObserverError` / `persist` / `isEndTurn` 等），要么作为**范围性事实**保留并把区间对过代码，基线从 232 降到 144。剩下的 `provider-runner.js` / `termination.js` / `governor.js` 三族属 T-b2，而「把基线常量降下来并在提交信息里写理由」
  仍然是「确实少了一些」唯一可核对的写法。

## check-docs-examples
真实执行**两份契约文档与两份根 README**（自 issue #576 起 `README.md` / `README_cn.md` 也在面内）里的 js 围栏，每格三层——语法编译、真实符号链接、独立子进程真实执行——且 README 目标表本身被看守（摘掉一条目标，守卫格就红）。执行**离线**：脚本化假 provider / `fetchImpl` 桩，不碰网络、不读 `~/.erix`（issue #158、#576）

## check-pack-links
随包 Markdown 的链接闭合检查，**外加** `.d.ts` 声称对账：四份入口文档里每一句「装包应列 **N** 个 `.d.ts`」都必须等于同一次 `npm pack --dry-run --json` 列出的 `src/**/*.d.ts` 条目数（不为了数数再跑一次 `tsc`），**外加** `test/contract/` 发布面对账（issue #505）：`files` 对那个目录是**逐个列举**、从不收目录，于是「新加一个 `.js` 却没人把它加进 `files`」会静默不打包而**没有任何门禁会红**（`check:release` 只反方向断言）。三条判据：**①（红）** `test/contract/` 下存在、却不在 tarball 清单里的非 `*.test.js` 的 `.js` 逐个点名——那就是「忘了加进 `files`」；**②（红）** `files` 里列的 `test/contract/...` 在磁盘上不存在就点名——历史残留的死条目；**③（只打印，永不红）** 每个 `test/contract/*.test.js` 连同「谁跑它」与「有意不随包」的说明逐条列出（它们是 `node --test` 套件，`npm pack` 清单里 `*.test.js` 恒为 **0**——这一行存在的全部理由，就是免得后来人又把它当成漏包）。「有意不发布」必须在 `CONTRACT_PUBLISH_EXEMPTIONS` 里登记（登记表的内容就是真值；曾经需要登记的那份文档示例 harness 已经搬出发布面目录），而登记表自己被双向看守：文件没了、文件其实随包了、`why` 为空、`path` 不是 `test/contract/` 下的具体文件、条数与 `CONTRACT_PUBLISH_EXEMPTION_MAX`（多了少了都红）对不上 ⇒ 全红。仍然**离线**、仍然只跑一次 `npm pack --dry-run --json`；`node scripts/pack-link-check.mjs --self-test` 带自己那套反向证（内存夹具 + 本仓真树；例数由命令打印，不跑 `npm pack`、不联网）

## check-release
把发版前那条手工验证变成一条命令（issue #257 T5）：按顺序六步，红就点名第几步——`npm pack` → 断言 tarball（声明文件数 > 0、当前版本的中英两份升级指南都在、随包的
`test/contract/` 文件一个不少、`files` 白名单之外没有杂物；Markdown 链接闭合**交给** `check:pack-links` ，不在这里重写）→ 把 tarball
装进一个一次性临时项目并断言 `import("erix-agent")`
/`import("erix-agent/tools")`，**并**拿这个装好的包的运行时导出面与升级指南声称「已删除」的每个名字对账（issue
#687：指南说没了的名字，必须在它那一行登记的入口上真的不在——中英任一份声明即算声明，入口列写法不认识时两个入口都查而不是猜一个；仍然导出的名字 ⇒ 红并点名 `名字 @ 指南文件:行 @ 入口`
，而今天之所以绿是因为 `scripts/guide-removal-gate.mjs` 里的 `KNOWN_NOT_REMOVED` 登记表是两边缺口的那把棘轮——issue #688 把 16
个名字真的删了之后它是**空的**，这条门禁绿是因为装好的包确实不再导出它们；每条都带 `why` ，空转条目（指南不再声称它，或运行时已经不再导出它）、空 `why`
、条数与现算红名数**双向**漂移都是红，指南文件缺失 / 名表解析不出 / 运行时面缺失则 exit 2 而不是放行；计数由命令自己打印，`node scripts/guide-removal-gate.mjs
--self-test` 是这条闸的反向证）→ 用**装好的包**跑随包契约套件 → 用 `tsc --strict --skipLibCheck` 编译一个真 TypeScript 宿主（退 0，且未知的
`runToolLoop` option 键**必须**报 `TS2353` ）并把编译产物真跑一遍——外加一份由它派生的样本：端口与调用点各给一次 `provider` ，必须非 0 退出且点名
`assemblyPort.provider` 与 `runToolLoop.provider` （issue #519 的直连冲突闸口是运行期规则，这种写法本身是合法 TS，只有真跑才证明它在拦）→
拿本地假上游冒烟装好的 `erix`
CLI（`--version` 等于 `package.json` ；一次成功的 `chat` 退 **4**，因为不开 `--final-guard` 时核验是 `skipped` ；`--session` 不存在退
1）→ CLI 跨 run 续接（`config.continuity.handoff`，issue #598：零 token 两轮 e2e——A 存 / B 召回 / 默认关 / 非法值拒绝）。离线（`npm
--offline` + 一次性 cache/userconfig + 假 `HOME` ）、跑完自清、耗时由它自己打印

## check-release-real
**261109 起前置清单是五步**（用户裁决）：两步文档闸（`check:docs`、`check:docs:strict`）被摘掉——脚本判不了
文档，它只能判措辞。文档检查的机械那一半移到定期 agent 检查（`doc-review-pass_cn.md`），发版只留值对账那一族
（`check:changelog`、`[Unreleased]` 漏搬、`check:release:model-e2e`、`check:release`、`check:host-consumers`）。

**发版前真机清单**（issue #817 把它从 `check:release:real` 改名成 `check:release:model-e2e` —— 名字必须说出**哪一面是真的**，真的那一面是**模型服务端点**，不是场景；工单 261021-13；写它的直接起因是 0.23.0 在「文档审计没跑 + 四条真模型端点 e2e 没跑」的状态下发车）：按固定顺序串成一条命令（步序与步数在脚本的 `STEPS` 里）——`node --test examples/tool-fact-e2e.test.mjs` → `examples/delegate-real-e2e.test.mjs`（父 run 派生一个子 run，issue #617）→ `examples/normalize-truncation-real-e2e.test.mjs`（归一化兜底的截断判别，issue #637）→ `examples/resume-real-e2e.test.mjs` → `examples/cross-version-real-e2e.test.mjs` → `examples/pi-extension/erix-run-e2e.test.mjs` → `node scripts/cli-real-smoke.mjs` → `examples/fold-default-real-e2e.mjs`（**CLI 槽位默认**压缩策略 `fold-llm` 真机，issue #619）——每条前打 `[i/N] <名字>`（N 是 `STEPS.length`），跑完打该条的 `tests/pass/fail` 与耗时——但第七步（`node scripts/cli-real-smoke.mjs`）不是 `node --test` 套件，于是两件事同时错：TAP 解析器只认 TAP（四个字段全是 `?`），而它自己的 `PASS`/`FAIL` 行**只在红时**才被回放，绿时那几条检查根本不进汇总。修法选的是**机器可读计数行**这一种（不是「绿时也转发它的 `PASS`/`FAIL` 行」那种）：该步收尾印一行 `RELEASE-REAL-SMOKE id=cli-real checks=… pass=… fail=… dry=… failed=… status=…`（格式与解析在 `scripts/smoke-summary-line.mjs`，两侧共用一份），清单把它并成同一行里的 `cli_real=<checks>/<pass>/<fail>`（绿红都并），另三档只在真发生时才印：`dry=true`（那次跑的是 `--dry`，只跑了 C8 ⇒ `checks=1`，没跑的 C1–C7 绝不算成过）、`failed=C4,…`（点名红的是哪几条）、`status=error`（脚本自身抛了）。这些计数来自冒烟自己 `check()` 的结果、**不是**字面量，而红时回放尾巴从此只是兼底渠道而不是唯一渠道。读不到的字段一律保持 `?`（读不到的摘要绝不印成「零失败」；声明了会报汇总却读不到那一行的步骤写 `cli_real=?`）——而「读得到」的判据是**七个字段全在且都合法**（`id=cli-real`、三个计数是**安全整数**且满足 `pass + fail = checks`——位数超长的字段会被解析成 `Infinity`，而 `Infinity + 0 === Infinity` 恰好绕过这条自洽判据，所以超过 `Number.MAX_SAFE_INTEGER` 同样算没读到——`dry=true|false`、`failed=-` 或长度等于 `fail` 的逗号列表、`status=ok|fail|error`），所以残行不会被默认值补齐：`… checks=1 pass=1 fail=0` 后面全缺 ⇒ 当没读到、汇总保持 `cli_real=?`，绝不补成 `1/1/0`（PR #681 独立验收逮到的正是这一格），每条单独 **900 秒**硬超时（超时算红，按**进程组** `SIGKILL` 以免孙进程继续烧钱，然后继续下一条）。任一条红 ⇒ **跑完整张清单后** exit 1，末尾点名是哪几条；全绿 exit 0 并打总耗时。闸门：`ERIX_E2E_MODEL=1` 不是 1 时**一步都不跑**（旧名 `ERIX_E2E_REAL` 已退役：设了不开闸而是判红，红文点名两个名字——退役如果只是删掉，配错就会被显示成「闸门关着所以没跑」）、exit 0、打分类原因（与 `examples/e2e-real-gate.mjs` 同一套 `GAP_CODES`），因此永不成为任何默认门禁的硬依赖；但闸门**开着**而配置/凭据/端点不可用 ⇒ exit **1**（发版必跑项被「跳过」冒充「通过」正是 PR #289 阻断 1 的镜像错误）；子进程出现闸门/配置类 skip 也判红（预检与子进程口径打架 = 装置坏了），别的 skip（例：跨版本那条的「旧 CLI 0.22.0 不可用」）不判红但在汇总里点名。本脚本**一个字节也不写**（不建临时目录、不写 `~/.erix`），隔离留在各子命令的消费点

## release-day
**发版日一条命令，人工只剩那一半**（issue #689；0.30.0 带着过期发布态发出去之后写的）：`scripts/release-day.mjs` 把发版日拆成四个阶段。`--stage preflight` 就是 §4 那份清单，按顺序跑——`check:changelog` → `[Unreleased]` 漏搬格（issue #715，本进程内读文件而不是 spawn 子进程：本版段已开而条目还停在 `## [Unreleased]` ⇒ **红**；还没切版、读不出搬运事实（本版没有段 / 本版段首已带发布日期）⇒ **未判定**；段已开且 `[Unreleased]` 为空 ⇒ **绿**）→ `check:docs` → `check:docs:strict` → `ERIX_E2E_MODEL=1 check:release:model-e2e` → `check:release` → `check:host-consumers -- --hosts …`——**任一红就停在那一步并点名第几步**，而闸门关着没跑的步骤判**未判定**（exit 2）而不是绿，所以缺 `ERIX_E2E_MODEL`、或 `--hosts` 目录不在，都再也不可能看起来像通过。`--stage publish` **不 fork `npm publish`**：扫码那一步是人的那一半，所以它只把踩过的坑一次性打出来（npm 12 在 `~/.npm-global/bin/npm`、被 `/usr/bin/npm` 遮蔽；每次 publish 都要独立的 device flow；非 TTY 的 URL 会被打码；按 ENTER 会把 npm 弄死；`+ erix-agent@<ver>` 之后 registry 还会滞后）并 exit 3；`--publish-cmd` 是显式开关，默认关。`--stage writeback --version <x> --published <x>` 是**本单的纪律**：发布成功之后**先回写发布态、再打 tag**——`scripts/docs-drift-check.mjs --sync` 只改发布态那几句（两份 README、两份 requirements、两份 AGENTS 的「当前版本 / 发布行」句，以及 CHANGELOG 当前版本段**段首那一行**——`（未发布 / unpublished）` 标记**与发布日期**同一步写，因为它们是同一件事的两半：`--published-date <YYYY-MM-DD>` 缺省取当天 UTC+8），其余字节一字不动；回写随后被提交，并**立刻重跑 `check:docs`** 作为「回写自洽」的证据。这次重跑发生在 tag 还不存在的时候，所以它的 `check:docs` 会 exit 2 / `TAG_MISSING`——日期↔tag 那一半此刻没有真值；那是**未判定**、绝不是红，而且只在每一处未判定原因都是 `TAG_MISSING` 时才算（别的读不出照样红；`finalize` 打完 tag 会带着 tag 再跑一遍这道闸）。`--stage finalize` 清 `src/**/*.d.ts`、打附注 tag `v<版本>`（指向 **切版提交**——`git blame` 现读 `package.json` 的 `version` 行得到的那个提交，绝不指向回写提交）、用 `git push origin` 双推 `main` 与 tag（GitHub + Gitea，**永不 `--force`**——这条禁令是脚本自己的纪律，不是外部闸门：main 当前没有分支保护、CI 红目前也拦不住任何合并，那道闸门实况的唯一现验命令只写在脚本 finalize ④ 那条注释里、别处不抄；真实的危险是同一个远端挂着两条各跑各的 push URL（GitHub 在前、Gitea 在后）而 mirror cron 关着 ⇒ force-push 会改写 GitHub 上**已发布**的历史、还可能只推上一侧而另一侧静默落后，而唯一的探测器是跑在 push 之后的两侧互验 ⇒ 非快进必须让 push 自己失败）、对**两个**远端 URL 各 `git ls-remote` 现验（两侧不一致就红）、再跑一遍 `check:docs` / `check:docs:strict`。`--all` 按顺序走这四个阶段，并**从状态文件续跑**（`$RUNNER_TEMP`/临时目录，不入库）：`phase=published_unwritten`（回写一开始就写下的那一笔）意思是「已发布、未回写」，所以重跑从回写接着走、**不会重复发布**；而 `finalize` 只在状态文件说 `phase=written` 且工作树干净时才动手，所以「tag 打出去了、文档还写着未发布」这一态在顺序上不可能发生。`--dry` 什么都不写、不发、不打 tag、不 push。`node scripts/release-day.mjs --self-test` 是离线反向证（合成树 + 假 runner：红的步骤停下并点名、闸门关着判未判定、回写失败留下可续跑的状态、没回写就 finalize 必须红、两侧不一致必须红、`--dry` 一个字节都不写、`check:docs` 的 exit 2 只在每一处原因都是 `TAG_MISSING` 时判未判定、`--sync` 只动发布态那几句——把边界挪一寸就红）；条数由命令自己打印
**第 2 步看的是「搬运」（issue #715）。** 过去每次发版都靠有人记得在 `## [Unreleased]` 与它的条目之间插一行
`## [<版本>]` 标题，而既没有任何机制搬、也没有任何机制提醒：`--sync` 只重写**已存在**的版本标题行（那一版没有段时
CHANGELOG 一个字节未动），`check:changelog` 只认数字段、且比对的是合并主题里的 PR 号，`guide-coverage` 只兜
「版本号升了而段没开」，中英配对判据只兜「新版本节被开成空节」（它的前置要求两侧各有真条目；条目留在原地时判据面**就是**
`[Unreleased]` ⇒ 绿）。
所以这一格答**三态**：**红**——本版段已经开了（还是未发布形态）、而 bullet 还停在 `## [Unreleased]` 里，判词点名条数、
逐条给出前 60 字与行号，并给可执行动作（把 `## [<版本>]` 那一行放到 `## [Unreleased]` 与条目之间，就是 `4963293`
的形状：正文一字不动、`[Unreleased]` 留空）；**未判定（exit 2）**——搬运事实读不出：`package.json` 那一版**还没有版本节**
（先切版：bump、开节、把标题行挪下来），或那一版**段首已经带发布日期**（上一版已经发出去，这些条目属于下一版，
所以跑在切版**之前**的 preflight 永远不会是假红）；**绿**——版本节已开且 `## [Unreleased]` 为空。它**不另写一套
CHANGELOG 解析器**：扫描面就是 `test/static-guards.test.js` 已经在用的那一套（顶部 `## [Unreleased]` 到下一个 `## ` 为止；
顶部标题被改名 ⇒ 红并点名「找不到版本节」，不静默放过），日期形状用 `docs-drift-check.mjs` 自己那一条，
版本号从 `package.json` 现读而不是写死。
文档审计也不是可选项：0.23.0 发出去的文档里就有审计本来会抓到的东西（契约版本标注、中英成对、存储图）。

**§4 那些 `[i/N]` 行不是自由文字（issue #731）。** 上面那份 `#   [i/N] <命令>` 清单是 `PREFLIGHT_STEPS` 的手工抄件，`test/release-day.test.js` 逐格与脚本对账：行数、序号是否连续、`/N` 的分母（由 `PREFLIGHT_STEPS.length` 现算，抄来的分母一漂就红）以及**命令列**（由这一步自己的定义推导：`K=V` 环境变量前缀、npm script 名、宿主类步骤的 ` -- --hosts …` 后缀）。中英**两份**都在扫描面里 ⇒ 只在脚本那侧加一步、没在两份文档里补行，或改了 script 名没改那一列，当场红。内联判据步骤没有 `argv` 可推导，必须显式声明 `docCommand`——**没有默认值，缺了就红**（fail-closed）。

**为什么落点是这一页，而不是把字节预算抬上去（issue #731，沿用 #726/#727 的先例）。** `scripts/agents-directive-scan.mjs` 的 `LENGTH_BUDGETS` 由 `--sync` **按 512 一档**往上刷，而 `test/project-instructions-716.test.js` 把这一格与注入上限钉在一起：最坏两页组合 = 30,720（全局页）+ 33,792（本仓这一页）= 64,512，上限 65,536 ⇒ **余量只有 1,024 字节**。把本仓那一格抬一档就吃光余量，下一次任何人往指令面加一句就会把组合推过 64 KiB —— 那正是 #721 修掉的缺陷（「预算闸说合法、注入面装不下」）。所以关于某道闸的说明性材料落在**这里**，指令面只留一句短话加一个指向本锚点的指针。

**文档审计同样不是可选项：** 0.23.0 发出去的文档里，审计本来能拦住那些问题（契约版本标签、中英成对、存储示意图）。

**preflight 答「未判定」时，`--all` 的结语按步骤 id 分叉（issue #731）。** 闸门类步骤没跑 ⇒ 那是**有闸可开**（`ERIX_E2E_MODEL=1`，或带上 `--hosts <目录>`）；第 2 步（`[Unreleased]` 搬运）**根本没有闸可开**——它读的是 `package.json` 与 `CHANGELOG.md` 的事实，缺的是只有人做得到的那件事：**切版**。旧的那一句硬写的「把闸开起来再发」让人去找一个不存在的开关，所以现在 `unjudgedConclusion()` 按未判定的 id 推结语（`UNJUDGED_ACTIONS` 两类：`open-gate` / `cut-version`），而每个可能答未判定的步骤都必须在这里登记——新加步骤漏登记，`--self-test` 当场红。

## check-cli-real
装后 CLI 打真模型端点的 gate 冒烟（工单 261015 T5，#284/#285 收尾）：`npm pack` → 把 tarball 装进一次性临时项目 → 用**装好的 `erix` **（不是
`node bin/cli.js` ）打真模型端点跑一个 ≥2 次工具的任务，断言退出码承诺（不开 `--final-guard` 的成功 run 退 **4** = 核验 skipped）、transcript 里
`tool_result` 的字段面、以及装好的包自己的投影。只有 `ERIX_E2E_MODEL=1` 才跑（旧名 `ERIX_E2E_REAL` 已退役：设了判红，不再开闸）；闸门关着时 exit 0 并打出**分类**原因（gate 缺失 / 配置不存在 / JSON 坏了 /
缺字段 / 端点不可达）。模型名从 `slots.default` 读（`ERIX_E2E_CONFIG` 可换路径）。另两条同闸门的套件：`examples/tool-fact-e2e.test.mjs` 与
`examples/pi-extension/erix-run-e2e.test.mjs` （`npm test` 里默认 skip，真模型端点不是默认门禁的硬依赖）。需要 `node_modules` ；自清理，不写真实
`~/.npmrc` 与 `~/.erix/config.json`

## check-docs-spelling
活文档里**退役扁平选项拼写**的**阻塞门禁**（issue #560；脚本本身是 #523 的 `scripts/retired-spelling-scan.mjs --strict`）：退役集从 `CONFIG_SURFACE_OPTION_NAMES` 减去 `RUN_TOOL_LOOP_OPTION_NAMES` 派生（从不拄清单），只在**代码语境**里算命中（围栏与行内 span；`config: { … }` 子树按叶子名跳过；`AMBIGUOUS_KEYS` 里那些「同时是别的东西的名字」不进判据），且面上每一份**入库的**文档——`docs/**/*.md` 加两份根 README（issue #572）——都**按路径**分类：现状描述（`architecture*`、`charts*`、`requirements*`、`testing*`、`maintenance-policy*`、`soak.md`）必须写成当前 API；历史记录（`decisions/*`、`v0.*`、`design/*`、`research/*`、`harness-comparison/*`、`suggestions/*`、`issue-469-*`、`tasks/*`、`host-upgrade-guide-*`）、契约（`host-consumer-contract*`）与根文档（`README.md`、`README_cn.md`，即「根文档」这一档，issue #572）正文一字不改，但**不再靠命中数钉子看守**（issue #961 A 删掉了 `HISTORY_BODY_PINS` / `CONTRACT_BODY_PINS` / `ROOT_DOC_BODY_PINS` 三张命中数钉子表、`unpinned` 与 `deadPins` 判据，连同 `SUSPECT` / `UNPINNED` / `DEAD-PIN` 判词；两份根 README 仍按 `rootdoc` 一档分类（issue #572），但这一档和 `history` / `contract` 一样不再 gating）。**文件清单只取 `git ls-files`**（issue #560）：扫描面是**入库的** `docs/**/*.md` 加两份入库的根 README（issue #572——**显式** pathspec 清单 `SCAN_PATHSPECS`，绝不是 `.`，所以面不会偷偷变成整个仓库），绝不走文件系统遍历——因为 `docs/tasks/` 与 `docs/delivery/` 是被 gitignore 的本地档案，走盘会让同一份仓库内容在开发树 `--strict` exit 1、在干净克隆 exit 0（CI 跑的是克隆，那批红永远见不到）。`git` 不可用 / 不在仓库内 / 仓库顶层不是本脚本所在目录 / 清单为空 ⇒ 扫描器**显式报错 exit 2**，**绝不**退回文件系统遍历（静默退回等于把「两个答案」留在原地，只是更难发现）。**哪份清单都不在的 `docs/**.md` 按现状类照扫**——「这张单没管到」那一类已经删了，未知分类不是免检。`check:docs` 完全不读选项拼写形态，所以这是紧跟 `check:docs:strict` 的独立阻塞步；`node scripts/retired-spelling-scan.mjs --self-test` 是这道门自己的反向证（阻塞，15 例；它拿**入库面的副本**当真扫描对象、在副本上造红——其中三例是 issue #572 扩面的反向证：往 `README.md` 里塞一句扁平拼写 ⇒ `--strict` 与 `--strict --json` 都红、还原 ⇒ 两路都绿；根文档类的 README 即便有命中也仍是 `OK`（issue #961 A：正文钉子表已删，此例只验 README 在面上且该档不 gating）。`--strict --json` 是**同一道门**的机器读法（issue #575）：红集合（`gateVerdicts()`）与「红数 → 退出码」（`gateExitCode()`）各只有一份，两条输出分支都只读它们，所以 `--strict --json` 在有红的面子上与文本分支一样答 exit 1，且 JSON 里带 `gate.{strict,gating,mode,red,counts,exitCode,wouldExitCode}` —— #575 之前 `--json` 分支无条件 `process.exitCode = 0`，任何机器消费者都把红读成绿。报告模式（`--json` 不带 `--strict`）仍是 exit 0，但照样报出同一个红数并标 `gating: false`

## check-agents-directives
**阻塞门**（issue #726；三类文本启发式已由 issue #909 删除），判定面是**指令面**——`AGENTS.md` / `AGENTS_cn.md`，每次会话自动注入、模型不查证就照着执行的那一页。#909 之后这道闸**只有一条判据**：**字节预算**（见下一段）。它原先跑的三类文本启发式——工单状态断言、会过期的实测抄件、裸源码坐标——连同它们的例外登记表、按「文件 × 类别」钉的上限表、各自的 `--sync` 路径与 `--self-test` 夹具，全部删除。**有意的行为改变（#909）**：往 `AGENTS.md` / `AGENTS_cn.md` 里写一句假版本号、过期抄件或裸坐标**不再在这里报红**——那种「读文本猜语义」的活由 `check:docs` 的版本对账负责，不归这道字节预算闸管。文件清单仍只取 `git ls-files`（#560 红线：不退回文件系统遍历），`node scripts/agents-directive-scan.mjs --self-test` 仍在，但只测字节预算（它的夹具：往合成 `AGENTS.md` 灌 2 KB 废话必红、还原必绿）。`--sync <文件>` 是改预算格的唯一合法法，`--verify <文件>` 对任何不等于推导值的格判红（手抄 = 抄高抄低都红），CI 两步都跑

**字节预算（issue #726——本页唯一一段「不是从 `AGENTS.md` 搬出来的」文字）。** 指令面是 system prompt 的一部分、折叠不动它，所以这里的每一个字节都在**每一轮**全额重发；issue #726 因此把「长度」本身变成一条判据，即 `--strict` 的第 ⑥ 条。预算**是派生态、绝不是手写的数**：`budgetFor(实测) = ceil512(实测) + 1024`，也就是把实测字节向上取整到下一个 512 字节边界、再加 1,024 字节余量（总余量 ≤ 512 + 1,024 = 1,536 字节，刻意压在 2,048 以下：余量的含义是「这一页还可以不红地长多少」，给到几千字节这条判据就成了摆设）。`--sync <文件>` 是**唯一**合法的改法——它写进去的正是 `budgetFor(实测)`，行尾的理由注释一个字不动。`--verify <文件>` 对**任何**不等于这个推导值的格子判红，所以手抄的预算抄高抄低都是红（双向），CI 两步都跑（`--strict` 与 `--verify`）。`--strict` 本身是棘轮：实测 > 预算 ⇒ 红，并打印实测字节、预算、超量（tokens 按 **3.4 字节/token** 折算——那是 2026-11-05 在 relay 上实测的比值，**不是常数**，只用于报告、不参与判定）；实测 ≤ 预算 ⇒ 绿，余量就是为这个留的。**空转**格按与这道闸其余部分同一条惯例判红：预算行对应的文件已经不在指令面上（死条目），或者预算被写成 0（永远不可能成立的格子）。真超了，办法是把参考材料搬到本页来，不是抬预算；要抬得在报告里给理由，而且仍然只能走 `--sync`。

## types-build
把随包发布的 `.d.ts` 生成到 `src/**/*.d.ts` 并保留（issue #213；`prepack` 钩子跑的是同一个脚本）
断言式门禁：`tsc` exit 0 / 声明文件数 > 0 / `src/index.d.ts` 含 `runToolLoop` / `src/tools/index.d.ts` 含 `createFileTools`，跑完删掉生成物（issue #213；需要先 `npm install --include=dev`）

## type-ratchets
`--checkJs` **棘轮**：统计从 `src/index.js` 可达的类型错误总数，超过 `scripts/type-check-ratchet.mjs` 里写死的基线常量 **98** 就失败（issue #214；棘轮 = 只减不增，低于基线仍通过并提示「可下调至 N」；每次下调都**两档一起数、同一笔提交里一起降**，而逐轮流水账（哪一轮降了几个、落在哪个文件）写在 `scripts/type-check-ratchet.mjs` 的头注释里——命令自己打印当前总数、每文件分布与「可下调至 N」的提示，所以除了两个基线之外本文不抄任何数）。**跑之前先删掉生成的 `src/**/*.d.ts`**——见下面「`--checkJs` 棘轮规则」。加 `-- --with-tools` 可把范围扩到 `./tools` 入口（基线 **133** / 28 个文件）
- `--checkJs` 棘轮规则（issue #214）：`npm run check:types` **不追求清零**——98 个错（涉 26 个文件）是已接受的债（#214 首测是 218，issue #177 刀 1 给 `src/loop/orchestrator.js` 还掉 1 个；PR #249（即 #213 的两个 provider 工厂 JSDoc）又还掉 75 个，**全部落在那两个工厂文件**：`src/providers/openai.js` 46 → 7、`src/providers/anthropic.js` 45 → 9，其余 27 个带错文件一个没动；issue #265 把 `src/store/notes.js` 的端口语义抽进两个新模块后又还掉 21 个，**同样全部落在那一个文件**：`src/store/notes.js` 27 → 6，两个首行 `// @ts-check` 的新模块（`src/store/notes-port.js`、`src/store/notes-memory.js`）各自贡献 0 个，其余 28 个带错文件一个没动——逐文件对账用的是 `git archive` 取出的 `7354fab^` 对照树，它在同一条命令下逐字复现 142 / 185）。
  它保证的是**只减不增**：总数与 `scripts/type-check-ratchet.mjs` 里的 `BASELINE_ROOT = 98` 常量比较（两档**在同一笔提交里一起数、一起降**；逐轮流水账——哪一轮降了几个、落在哪个文件——写在那个脚本自己的头注释里，本文不抄）。
  **先还哪一半**：一部分错误落在**宿主可及的文件**，另一部分住在纯实现内部；`src/store/notes.js` 那次重构还掉的 21 个因此全落在公共面那半边（`src/store/notes.js` 本来就在公共闭包里）。哪份文件在哪半边由 `src/index.js` 的引用闭包决定：每文件计数由 `node scripts/type-check-ratchet.mjs --verbose` 打印、单条错由 `--show-errors N` 定位，所以本文既不抄这份切分，也不抄逐轮流水账——每一轮降基线都在**降它的那笔提交**里写清哪个文件减了几个。准入规则：
  - **新增文件必须首行开 `// @ts-check`。** 它是「这份文件愿意被检查」的声明，**不是范围开关**：`--checkJs` 加上
    `src/index.js` 已经会把整张 import 图拉进来（`--listFiles` 打印单入口能到 `src/` 下多少个文件（这个数由那条命令打印、本文不抄；2026-10-21 记的 65、2026-10-13 记的 58、#265 之前的 56 都是**历史值**），其中 **26 个带错**），
    所以「只编入口」根本限制不了范围；白名单只能按文件加，这正是 #214 R2 要的事。
  - **改动某个文件时，若它的错误数能降就是顺路机会**（#179 那一类：随本就在改这个文件的 PR 消化，不单开单）。
    总数降下来后，把基线常量的下调**单独一次提交**，并在提交信息里写清哪个文件减了几个——棘轮的全部价值在于「这个数只会变小」。
  - ⚠ **跑之前先删掉生成物。** tsc 解析 `./x.js` 时**优先命中同目录的 `x.d.ts`**，所以 `npm run types:build`/`prepack`
    之后，本门禁会变成「在检查声明而不是实现」：**无 `.d.ts` = 98 个错**（即常量那个值），**声明在场 = 0 个错**
    （`--skipLibCheck` 直接跳过声明文件），去掉 `--skipLibCheck` 会得到一小批错、且全部落在 `.d.ts` 上（条数与涉及文件由同一条 tsc 命令打印）。生成物数量见 `npm run types:build` 的输出（它就是随包声明数，`check:pack-links` 与 tarball 对账；更早的读数都是**历史值**，按当时为真保留）。
    「0 < 基线」在这里是**假绿**，所以脚本对残留的 `src/**/*.d.ts` 直接变红（仓库提交了 0 个 `.d.ts`，存在即生成物）；
    清掉即可：`find src -name '*.d.ts' -delete`（生成物不入库、可随时重建）。
  - 故意留着的盲区（规格就是这么定的）：第二个公共入口 `src/tools/index.js` 会拉进包根图里**到不了**的
    `src/tools/file-tools.js` 与 `src/skills/loader.js`，所以这两个文件的新错默认**卡不住**；
    `npm run check:types -- --with-tools` 卡并集（基线 **133** / 28 个文件 = 98 + 19 + 16，与压低它的那笔修同一笔提交里一起数；**两档在 CI 上都有自己的步骤**——`--with-tools` 那两步紧跟包根档，所以常量在这里过期会像别处一样红，issue #653）。并集背后的每文件计数由命令打印（`--verbose`），每一轮降基线都在**降它的那笔提交**里写清哪个文件减了几个（issue #409 的 `parseToolArguments` 改走、`parseJsonWithRepair` 的 `@returns` 拍平、issue #356 的 `markerCount` 窄化）；将来收紧就走这条路，不要拿它当「反正卡不住」的理由。
    ⚠ 退役的 261 里悄悄留着 #177 已经还掉的那 1 个（那一档当时没跟着复测）：**下调基线必须两档在同一笔提交里一起复测、一起降**。
  - 工具链许可（issue #213，#214 重申）：`typescript` + `@types/node` 只能待在 dev——零运行时依赖红线约束的是
    `src/`/`bin/` 的 import（`node:` 内置 + 相对路径），本门禁也不新增依赖（只用 `node:` 内置，不建 tsconfig、不引入新工具）。
  - **量数纪律（issue #653），对本文提到的每一道棘轮、每一张派生表都成立**：
    - **派生数与基线只在最终树上取。** 基线、派生表、覆盖面下限都是「量在哪棵树上」的快照；同批还有别的分支没合进来时就取数，
      得到的是「谁也不会真的构建的那棵树」的数。
    - **基点落后 main 就先 rebase 再取数。** 本分支的基点在 main 后面时，先 rebase 到 main，之后再取数——在旧基点上读出来的数，
      描述的是已经不存在的那棵树。
    - **降债与它对应的基线 / 派生表更新在同一个 PR 里原子地进。** 同一个 PR 内部保留多个 commit（审阅边界照旧可读）是对的，
      但两半必须一起进：只降债、不降常量（或不同步刷新派生表）的中间态绝不许单独进 main——正是这个中间态让 strict 棘轮的
      反向证与树对不上（issue #653）。
- `--strict` 棘轮规则（issue #417）：同一条 `tsc` 命令追加 `--strict`，与**它自己**那一对基线
  （`scripts/type-check-ratchet.mjs` 里的 `BASELINE_STRICT_ROOT` / `BASELINE_STRICT_WITH_TOOLS`）比较，自 #417 起是
  **阻塞**门禁——#416 只把它做成观测点（把数打出来、不卡任何东西），而那笔债在没人卡的期间一直在长。契约与非
  strict 那条逐字同构：超过基线 ⇒ exit 1 并点名超出多少，等于 ⇒ 绿，低于 ⇒ 绿 + 提示「可下调至 N」，并且
  **两档必须同一笔提交里一起测、一起降**。两个总数是两次独立测量、不是差额——不许用一个推另一个，也不许把
  任何一个抄进文档（常量是唯一真值，命令表里 `check:types:strict` 那一行也是这么写的）。**#417 只加闸**：基线就是
  入库那一刻的总数，存量债由后续切片按文件还，红的是**新增**的一处 strict 错——包括加在覆盖面已有文件里的那一处。
  上面 `--checkJs` 规则里的**量数纪律**对本文一档同样逐字成立：派生数与基线只在最终树上取、基点落后 main 时先 rebase 再取数、
  降债与它对应的基线更新在同一个 PR 里一起进（PR 内部可保留多个 commit），但「只降债、不降基线」的中间态绝不许单独进 main
  ——那正是本档反向证与树对不上的形态（issue #653）。
**strict 棘轮，阻塞门禁**（issue #417，把 #416 的观测点升级）：用与 `npm run check:types` **同一条** `tsc` 命令再追加 `--strict`（入口、依赖图、`typescript` + `@types/node` 都是同一对），把总数与 `scripts/type-check-ratchet.mjs` 里的 `BASELINE_STRICT_ROOT` / `BASELINE_STRICT_WITH_TOOLS` 常量比较——与非 strict 棘轮同一套「只减不增」，而且两档必须**同一笔提交里一起测、一起降**（只降一档 = 把差额推给另一档）。超过基线 ⇒ exit 1（点名超出几个 + 最多的文件）；等于 ⇒ exit 0；低于 ⇒ exit 0 并提示「基线可下调至 N」。strict 的两个数**只住在**那两个常量里：本文不抄，也不许拿一档的数去下调另一档的基线（两档是两次独立测量，不是 strict / 非 strict 的差额）。本票**只加闸、不还债**：基线就是落地那一刻的总数，所以存量债照样绿，红的是**新增**。非 0 还可能是脚本自己跑不成——tsc 缺失、tsc 非 0 退出却一条错都没解析出来、`src/**/*.d.ts` 生成物在场（共用的陈旧声明守卫拒绝报假的 0：`npm run types:build` 之后跑本命令 exit 1）、总数归零而基线 > 0（按检查面失效判红，不是「债还完了」）。加 `-- --with-tools` 跑 `./tools` 并集那一档，加 `-- --verbose` 出完整分布，加 `-- --show-errors N` 逐条定位

## check-mutation
**常驻变异样本表校验——已删除（#906）**（原 issue #257 T7）：这一步过去把表里三个**派生列**（锚点行号、锚点 sha256 前缀、命中数）连同合计行从真树重算、再与入库抄件对账（`node scripts/mutation-sample-check.mjs --verify`，`--sync` 是唯一合法的重写方式）。抄件一漂，红的不只是抄件：漂的时候连真判据 `--run` 也拒跑（拿漂了的表去真跑 = 把变异打在错的那一行），于是一张过期的抄件把唯一那个真信号一起拖死。变异样本现在以**只钉语义的清单**住在 `scripts/mutation-samples.mjs`（id / face / file / anchor / mutation / catcher / signature）——不钉行号、不钉 sha、不钉命中数——所以代码漂移不再要求刷表；存续的机器证据是下面的 `--run`，它现读现用行号、并自己判定锚点死没死、唯不唯一。
**这些样本真的会被闸咬住**（issue #257 T7）：`node scripts/mutation-sample-check.mjs --run` 逐条把变异写进真文件、用 `node --test` 跑该条的捕获者，要求**非 0 退出、且 `not ok N - …` 那一行里含该条的期望红签名**——通过的 `ok N -` 行不算，红在别的断言上也不算，因为「非 0 退出」本身也是语法错 / 模块找不到 / 基线本来红会给出的东西。然后还原文件并要求**绿**：这才把红归因给变异，而不是归因给这棵树。**变异没落地 = 失败，不是通过**（#210 R2 的口径：替换会原样返回，判据会因此恒真）。还原结果逐字节核对，并挂了 `SIGINT`/`SIGTERM` 还原钩子；它是整条 CI 里**唯一**会改写 tracked 源文件的步骤，所以排在**最后**。每一条都跑两发（变异后 + 还原后）；条数与耗时都由命令打印，本文不抄

## check-exports
**已删除（#904，2026-11-25）。** 用户裁决：库不该管谁在用、更不该管别人电脑上装了什么。
原来的「公开面零消费者」清点与闸整套删掉；它量的那张面（开发树里的引用计数）没有人会跑，
而且「发布面」按目录前缀判、连不随包发布的 `*.test.js` 都算成消费者。
保留：`scripts/guide-removal-gate.mjs`（比安装包导出面 vs 指南声称，不看任何用户）。

## check-exports-deprecated
**已删除（#904，2026-11-25）。** 见上一节。`REMOVAL_REGISTRY` 里「已知破坏」的记录职责已随机制一起删除。

## check-host-consumers
**已删除（#904，2026-11-25）。** 扫宿主仓等于管别人的电脑；`release:day --stage preflight` 因此从 5 步变 4 步。


## check-config-leaf-values
配置叶子值类型现状表校验（issue #586）：`node scripts/config-leaf-value-probe.mjs --verify docs/config-leaf-value-status.md docs/config-leaf-value-status_cn.md` 重跑探针（每个 schema 叶子 × 8 个固定错值，每一格都过一次真的两轮 `runToolLoop`），再把重算出来的中英两张表与入库的那两张对账——任何漂移都 exit 1 并点名文件。探针**实测**每一格的结局，而不是断言愿望：`G` / `V` 在 `config` 闸口 / 语义相被拒，`S` 在 run 启动期被拒**且判词点名该叶子**，`C` 在启动期炸但**不点名**，`U` 到第一发请求之后才抛，`A` 是被接受且**真的生效**（run 的指纹变了），`·` 是被接受但**无差异**（指纹逐字相同）。「拒在哪一层」取自**栈帧**（文件名 + 函数名，从不取行号 ⇒ 无关重构撞不红它），「生效在哪」取自指纹的**第一个差异路径**，所以「悄悄接受」是一个位置加一对值，不是形容词。`--sync` 是刷这张表**唯一合法**的姿势（手改数字就是造假）；`configSchemaSelfCheck` 红、或三次基线跑的指纹不一致时，探针**拒绝出表**（`exit 2`）——指纹不稳会把 `A` / `·` 变成噪声。它自己打印耗时（约一秒级），所以在 CI 里是**阻塞**步骤 `Config-leaf value status verify`。**它一个字都没收窄接受面**：每条类型校验都是收窄 ⇒ 要记 Breaking，裁定权留在维护者手里

## registry-updates
派生格只用该登记表所属的生成器刷新，不手改：

| 登记表 | 唯一的机器更新命令 |
|---|---|
| 配置叶子现状表（中英） | `node scripts/config-leaf-value-probe.mjs --sync docs/config-leaf-value-status.md docs/config-leaf-value-status_cn.md` |

汇总对账器与它登记的地板已在 issue #905 删除（把登记的总数维持同步原来是记账税、不是判定，也刻意没有 `--sync`，因为抬地板是人的动作）。`test/static-guards.test.js` 的中英配对判据**不登记任何数字**：那个 `CHANGELOG_PAIR_FLOOR` 校准值
（在某一节上实测的配对数、只能升不能降）已在 PR #826 删掉——它每开一个发布窗口就作废一次、要人现测
重填，而真正兜住覆盖的是「两侧都不得有条目缺对应」加「判据面两侧各有真条目」这两条，它们自校准。
**中英整对**删掉的条目归定期文档检查（`docs/maintenance/doc-review-pass_cn.md`），不归登记数字。

## cli-local
本地运行 CLI（无需安装）

## ci
- **`.github/workflows/ci.yml` 自 2026-11-25 起不由任何事件触发**——`pull_request` 与 `push` 两个触发按用户裁决
  摘除（此前半个月 9 次红里 6 次是派生登记表刷表、0 次是 `src/` 行为回归）。只剩 `workflow_dispatch`；
  `main` 的门禁是 ruleset `main-require-pr`（必须走 PR，不要求任何 status check）。**由此得出的结论就是本节的
  组织性事实：没有事件触发的步骤是仪表盘，不是闸**（issue #908 R2）。在这棵树上「它在 CI 里跑」的意思是
  「有人点一下才跑」。
- **一个 job，三类真值**（261126，issue #908 R2）。工作流只留「干净检出或第二个 node 大版本才证得动」的东西：
  - 全量套件跑在 **node 22 与 node 24** 上（`fail-fast: false`）。22 既是 `engines` 声明的最低版本，**也是宿主
    实际在跑的那个**，所以门禁验证的是用户真在用的运行时；24 是 agent 与新宿主实际会落到的 runner。
    issue #774 把第二格加进来的理由是**只在某一个 runner 上成立的判定根本不算判定**：
    `scripts/mutation-sample-check.mjs` 的变异用例 spawn 子进程时没点名 reporter，而 Node 24 的默认 reporter 是
    spec ⇒ 它断言的那行 `not ok …③…` 永远不会出现——只有一格的矩阵也永远看不见另一格的红。`npm test` 在
    `package.json` 里钉 `--test-reporter=tap` 是同一个理由（issue #301）：一次跑要产出的那份 reporter 必须写在
    argv 里，不能去继承 runner 的默认。
  - 四档 `tsc --checkJs` 棘轮是**四个独立的阻塞步骤**，不带 `continue-on-error`；
    `test/type-check-strict-ratchet.test.js` 钉住四格都在场、都不是建议性质、每个工具档紧跟它自己那一档。
    `check:types-build` 排在它们之后：它会往树里落 `src/**/*.d.ts`，而声明文件与源码并排时 `tsc --checkJs`
    量的就不再是实现而是声明。
  - 干净环境那一族三件，各自带 `if: matrix.node == 22`：`check:release`（真 tarball → 真装包 → 契约套件 →
    CLI 冒烟）、`check:pack-links`（随包面从真 pack 里读出来）、`check:mutation:run`（会临时改写 tracked 源文件，
    所以排最后、且必须在全量套件已绿之后，红才可归因）。**这三件是这份文件存在的不可约理由**：
    「开发树里绿、干净检出里红」（issue #914 那一类）没有别的办法看得见。
- **撤走了什么、每一块去了哪**（issue #908 R2）。步骤清单在 `ci.yml`，本页不抄它。
  - 秒级的代码面判据**搬进套件**，因为那是唯一每次都跑的地方：`test/gate-self-tests.test.js` 逐条 spawn
    `syntax-check`、`test-hygiene-check`（验证态与 `--self-test`）、`mutation-sample-check --self-test`、
    `pack-link-check --self-test`、`config-leaf-value-probe --verify`，并且有一格钉住「这些命令不许再作为重复
    步骤爬回 `ci.yml`」。
  - 纯重复的直接删：`guide-removal-gate --self-test`、`release-day --self-test` 早就分别被
    `test/guide-removal-gate.test.js`、`test/release-day.test.js` spawn 了。
  - 文档族（`check:docs`、`check:docs:strict`、`check:docs-spelling`、`check:docs-examples`、
    `check:agents-directives`、`check:changelog`）住在**已经接线的那道版本边界**上——`check:changelog` 作为
    `PREFLIGHT_STEPS[0]` 阻塞、`check:docs` 在 `release:day --stage writeback` 里重跑——其余时候由周期性 agent
    检查承担（`doc-review-pass_cn.md`，入口 `npm run docs:pass`）。背后的用户裁决是 #802：脚本只能判措辞，
    而那一类判据造出了 25% 的红率（200 次运行 138 成功 / 49 失败 / 13 取消；抽样 12 次失败里 9 次是登记表漂移，
    不是行为），却几乎抓不到真缺陷。`docs-drift-check --self-test` 曾是**分钟级**的（261109 约 7 分钟、
    261126 在 219 例上约 8.5 分钟），**已随任务 261126-59 删除**：它在人工 pass 之外没有主顾。
  - `check:cli:model-e2e` 撤出 CI：`ERIX_E2E_MODEL` 没设时它只 exit 0 并打一个分类原因，作为 CI 步骤它是空转；
    真端点那一跑是 preflight 的第 3 步。
- **与步骤无关的不变量**：装依赖用 `npm install --include=dev`，**绝不是** `npm ci`——`package-lock.json` 是故意
  gitignore 的，而那两个 dev 包（`typescript` + `@types/node`，issue #213）正是 `check:types*` /
  `check:types-build` / `check:pack-links` / `check:release` 能跑起来的前提。`fetch-depth: 0` 留着，虽然现在已经
  没有步骤需要全历史（它原先是 `check:changelog` 的硬前置，issue #691）：浅克隆之下，将来某条读 tag 的判据会
  空跑一圈返绿，而不是红。`npm run soak` 需要真实 relay 配置与 key ⇒ **绝不进** CI。Gitea 只是代码镜像：那边
  **不建** Actions，GitHub 仍是唯一执行方。`POST …/dispatches` 在 GitHub **第一次见过**这份 workflow 之前一直返
  **404**，推上分支 + 跑过任意一次就注册好了，之后 dispatch 返 204。
- **`continue-on-error` 随 `registries` 那个 job 一起没了**：「PR 上看得见但不停车」这个分层，在没有事件触发
  之后已经无可再分。`npm run release:day -- --stage preflight` 仍然是让行为面、CHANGELOG 与打包面同时阻塞的那一处
  （`PREFLIGHT_STEPS`）。

## gate-reproducibility
- 门禁可复现口径（issue #280）：`npm run check:docs` 与 `npm run check:docs:strict` 在开发工作树里和在全新 clone 里（`git archive HEAD | tar -x -C <空目录>` 解出来的那棵树）必须同样 exit 0。「本机档案」这一类——`docs/tasks/` 下的文件，该目录被 `.gitignore` 整目录忽略、故意不入库，因此任何 clone 里都不存在——按**声明**裁决（`LOCAL_ARCHIVE_REFS` 逐条登记，或引用就地写明「本机 / 不入库 / 归档」），实物只在那个目录恰好在场时顺便核实，核不到不得把门禁判红。真正有本机前置的，是那一批需要 `node_modules`（两个 dev 包 `typescript` + `@types/node`，issue #213）的门禁：`npm run check:types`、`npm run check:types:strict` 与 `npm run check:types-build`（三张都直接驱动 `tsc`），以及 `npm run check:pack-links` / `npm run check:release`（它们 shell out 去跑 `npm pack`，而 `npm pack` 的 `prepack` 钩子会重生声明文件，再加 `tsc`）。没有 `node_modules` 的检出里这些闸会非 0 退出并报 `Cannot find module 'typescript'`——那是「**这道闸没跑起来**」，从来不是回归；先 `npm install --include=dev`。**除此之外没有任何闸读工具链**。
- **并发判读禁令（issue #799）**：同一棵树里还有 `npm test` 在跑的时候，
  不得判读 `npm run check:docs`、`npm run check:docs:strict` 或
  `node scripts/docs-drift-check.mjs`。下面那组形状是**当次实测的读数**
  （同一棵**已提交**的树、跑了两次），不是现值：
  套件在飞时这条命令 exit **0**、零红项；
  同一棵树等套件退出后干净重跑，exit **1**、点名 20 处漂移
  （`bare-lines` 超过它的棘轮基线，外加两种契约语言里
  `cell-axes-anchors` 的读列不等值）。那批漂移真被修掉之后，
  两种形状都回来是绿的 ⇒ **红是真的、绿是假的**。
  这是**沉默成功**形状的失败：退 0、一条红项都不报，
  读起来正是好消息，而退出码恰恰是下一个读者直接拿去用的东西
  （据此下结论、关单、合并），所以「小心点」不是一道控制。
  **CI 不受影响**（它的步骤是串行的，见 `ci`）；
  只有与一趟套件跑重叠的本地 shell 会触发它。
  归因落地之前，裁决是程序性的：
  **让套件退净，然后重跑，只把那一趟干净的运行当判读**——
  与另一个写入者重叠的扫描是*未判定*，不是通过
  （issue #511 对一道关掉的闸用的是同一条规则：没跑不算通过）。
  归因仍在 #799；「扫描面可能吃到某条套件成员中途生成、又中途删掉的
  `src/**/*.d.ts`」是**一条线索，不是结论**——核实它的人把它写进本文，
  谁都不许把它当事实往下抄。

## type-surface
- 类型面规则（issue #213）：`src/**/*.d.ts` 是**生成物、永不入库**（`.gitignore` 已覆盖）；`files` 里本来就有 `src`，
  所以 tarball 里有声明而仓库里没有。`prepack` 钩子在 `npm pack`/`npm publish` 前重新生成它们，且**只能往 stderr 打日志**——
  lifecycle 脚本继承 npm 的 stdout，而 `scripts/pack-link-check.mjs` 要把 `npm pack --dry-run --json` 当纯 JSON 解析。
  两种 JSDoc 形状会**静默**把参数退化成 `any`（编译一个错都不报，只有读生成的 `.d.ts` 才看得见；#213 R4 两处都已修）：
  **内联 `@param {{ … }}` 类型字面量里独占一行的 `//` 注释**，以及**没有紧贴被文档化声明的文档块**。
  宿主可见签名要紧的时候，去读生成的 `.d.ts`，而不是源码里的注释。
  因此干净检出里一个 `.d.ts` 都没有——**装包后列出多少个，以 `npm run check:pack-links` 现报为准**（它从 `npm pack` 清单里读数，并对账四份入口
  文档里的这句声称；本页**不抄现值**）。下面都是**当时那棵树上实测的历史读数**，不是现值：**88** 是 issue #743 把 `src/loop/event-tiers.js`（事件分级表，从包入口再导出）接进声明依赖图
  那棵树上的值；
  此前 **87**（因为 issue #688 把 `src/tools/providers.js`、`src/providers/anthropic.js` 与
  `src/config/env.js` 移出了声明依赖图——它们唯一的公共再导出退役了，入口侧再没有谁 import 它们；
  此前 **90**（在新增 `src/loop/judge-runner.js` 的那棵树上实测）；此前 **89**（在 #643 的树上实测，
  列出整整 89 个，因为那一单新增 `src/compact/budget-fit.js`）；此前 **88**（在 #246 第一刀的树上实测，
  列出整整 88 个，因为那一刀把 `src/loop/state-view.js` 接进了声明依赖图，它的声明也开始随包）；此前 **87**（在 #626 C1 的树上实测，
  列出整整 87 个，因为那一单新增 `src/tools/delegation/tail.js`；此前 **86**（在 #617 P1b 的树上实测，
  因为该单新增 `src/tools/delegation/tool.js`）；此前 **85**（在 #617 P1a 的树上实测，
  因为该单新增 `src/tools/delegation/roster.js`、`src/tools/delegation/capacity.js` 与
  `src/tools/delegation/notify.js`）；此前 **82**（在 #568 的树上实测，因为该单新增 `src/loop/continuity-block.js`）；此前 **81**（在 #498 S4a 的树上实测，因为该单新增
  `src/loop/capabilities-namespace.js`）；此前 **80**（在 #497 的树上实测，因为该单新增
  `src/loop/config-namespace.js`）；此前 **79**（2026-10-25 在 #462 的树上实测，因为该单新增
  `src/compact/resume-fold-trim.js`；再此前 78（2026-10-24 在 #460 的树上实测，因为该单新增
  `src/compact/fold-archive.js`）；此前 77（2026-10-23 在 #406 B2-a 的树上实测，因为该单新增 `src/normalization/parse-model-json.js`
  与 `src/config/slot-provider.js`）；此前是 75，因为 #409 新增 `src/text/repair-json.js` 与 `src/messages/tool-arguments.js`；再此前 73，因为 #404 新增 `src/loop/resume-notice.js`；再此前 72，因为 #394 新增 `src/loop/pending-tool-result.js`；再此前 71，因为 #386 切片 2 新增 `src/loop/deliverables.js`；再此前 70，因为 #333 新增 `src/store/message-rows.js`；再此前 69，因为 #326 新增 `src/store/transcript-dedup.js`、#322 新增 `src/compact/fold-summary-journal.js`）。**这个数由
  `npm run check:pack-links` 与 tarball 内容对账——不许手抄进这两份口径文件，门禁会点名文档与行。**
  以下都是**历史值**，按当时为真保留：67（#307 之后，2026-10-16 实测）、66（#305 新增 `src/text/json-candidates.js` 之后）、
  65（#292 之后，2026-10-15）、64（0.20.0 的 tarball）、63（0.19.0 时代）；体积差也是 0.18.0 的历史（tarball 自己会打印体积）。
  `npm run check:types-build` 是「还能不能生成」的门禁。

## unattributed-merges
打 tag 前还有一遍人工，而它是「一个没被点名的公开改动」与「已经发布的 tag」之间唯一的屏障：`check:changelog` 打印 **`unattributed`** 那条 note 时——碰到公开面的合并，主题里一个 issue 号都没有，闸归因不到任何条目——它**只打印、不阻塞**，这是设计（合并主题是散文，要求某条条目必须点名它做不到）。对那条 note 里的每一个短 sha，读它的 first-parent diff（`git diff --name-only <merge>^1 <merge>`），要么确认那个公开改动已经写进本版 CHANGELOG 段，要么留下一个后来的人能复核的理由。这张清单是**故意打印**的，好让这一步有输入；机器门禁里没有任何一条会替你做这件事。

## npm-policy
- ✅ **唯一途径（`npm@12`）**：
  ```bash
  npm i -g npm@12                    # 升级（系统 npm 10 不支持新流程）
  npm login --auth-type=web          # 浏览器 OAuth + passkey
  npm publish                        # device flow：终端打印认证 URL
  ```
- **发布交互（已在 2026-09 验证）**：即使已执行 `npm login`，`npm publish` 仍会触发**一次独立的 device flow 认证**（EOTP；每次发布都要重新认证，而不是由登录覆盖）——终端会打印 `https://www.npmjs.com/auth/cli/<id>`；将其复制到浏览器，在手机上使用相机扫描/确认 passkey，然后命令行自动继续。
- ⚠️ **预发布版本必须显式指定 `--tag`**（由 npm12 强制）：`npm publish --tag latest`；否则会报告 `You must specify a tag when publishing a prerelease version`。
- ⚠️ 在非 TTY 环境（脚本/管道）中，认证 URL 会被掩码为 `***`——**用户必须在自己的终端运行**；在 agent 侧，使用 Python pty 方案为用户捕获真实 URL（见陷阱 4）。
- ⚠️ **不要在 "Press ENTER to open in the browser..." 提示处按 ENTER**（已在 2026-09 验证）：没有浏览器时，按 ENTER 会触发 `xdg-open` 失败并终止 npm（`command failed`，code 3）。如果不按 ENTER，npm 会继续轮询认证状态并正常完成。

## local-runtime-data
## 6. 本地运行数据（不提交到仓库）

```
~/.erix/
├── config.json        # LLM 配置（endpoint/model/apiKey/maxOutputTokens/contextWindowTokens）
├── mcp.json           # MCP server 注册（标准格式，可复用 ~/.config/mcp/mcp.json）
├── <session>.json     # 会话历史（id 按 cwd 派生）
├── transcripts/
│   ├── <runId>.jsonl          # 只留元数据的轮行 + 一条消息一行（`kind:"message"`，`seq` / `partOf?`）；`load()` 折叠回轮行
│   └── outputs/<runId>/       # 该 run 的全部产物归档：工具捕获、报告、judge.log
│       └── judge.log          # judge 决策 JSONL（默认写这里；--judge-log / ERIX_JUDGE_LOG 可覆盖）
├── skills/            # 用户级 skill（自描述协议）
└── todos/             # 任务清单（按 cwd 隔离）
```

- **judge 日志有固定归属**：`transcripts/outputs/<runId>/judge.log`，与 transcript/工具捕获同目录同生命周期；监督者排查 judge 行为直接看这里，不再依赖 `/tmp` 重定向。
- **judge.log 记录形状（#165，additive）**：每条决策记录带 `runId` + 被评决策发生时 run 实际使用的 `model`（judge 走另一个 evaluator 模型时再带 `judgeModel`；探不到就缺省字段，绝不写占位值），且每个 run 的末条是一条 `run_outcome` 汇总记录（`termination` + `verification`）——追加而非回写。per-model 校准指标（blocked 率 / 误拦率 / extend ROI）就是把这两类记录按 `runId` join。


## pitfall-4
4. 对于无浏览器 + 非 TTY 的认证流程（已于 2026-09 验证，在没有桌面环境的机器上）：用 Python pty 包装 npm（`pty.fork()` + `select` 读取输出），使用 `setsid nohup` 完全脱离进程组，防止 bash 工具清理它；在脚本中使用正则将 `https://www.npmjs.com/(login|auth/cli)/[0-9a-f-]+` 提取到文件，然后读取 URL 并交给用户在浏览器中操作；**不要自动按 ENTER**（见上文）。登录成功会将 token 写入 `~/.npmrc`；发布成功由日志行 `+ erix-agent@<ver>` 标记；参考实现 `/tmp/npm-pty-login5.py`。

## pitfall-1
1. 改 `package.json` 用 node 脚本，不要用 `sed` 删行：那样删掉 `private` 那行会留下尾逗号，JSON 直接解析失败。
   改完自己验一次：`node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"`。

## pitfall-2
2. 发布前先 unlink 本地 link（`npm unlink -g <旧包名>`；`@erix/llm-kit` 是历史遗留），否则 `npm i -g` 报文件冲突。

## pitfall-3
3. npm 政策动得很快：新的 TOTP 注册返回 404，细粒度 bypass-2FA token 从 2026-08 起失去发布权限。遇到 `403` / `EOTP`，
   先读 npm 官方 changelog，再来调本仓的配置。

## publish-prerequisites
这里全是最终态；把它逼出来的过程在上面 `## npm-policy`。
- `package.json` 里必须去掉 `private`（否则发布 PUT 是 `403`）；`repository.url` 用 `git+https://…` 形态，或跑 `npm pkg fix`。
- `files` 是一份很长的显式白名单，`test/contract/*` 是**逐文件**列出的（没有目录条目，所以它们旁边的 `*.test.js`
  永远不进包）。`package.json` 是唯一真值：**别把那份清单抄进任何文档**。用 `npm publish --dry-run` 看产物。
- **版本号一发布就被烧掉。** 判断某个号是否空闲只看**退出码**（`npm view <pkg>@<ver> version`），不要 grep 输出：
  「找不到」的报错文案里也带着那个版本号，grep 会把一个空闲的号读成「已占用」。改版本用
  `npm version <x.y.z> --no-git-tag-version`；功能完整的首发版本不要用 `0.0.0`。
- `0.24.0` 从未发布到 registry（已发布序列是 0.23.0 → 0.25.0），且刻意不回填：`0.25.0` 已取代它，`CHANGELOG.md`
  里 0.24.0 那段保留为「那一刻为真」的历史。
- **锚点覆盖不到的人工一步**（打 tag 之前）：手工走一遍三类声称值——**默认值**（`default X` / 默认的 `X`）、
  **数字**（N 步 / N 项 / 某个常量的值）与**名称集合**（策略名、工具名、旗标），范围是两份 README、两份 AGENTS
  与两份契约文档。锚点只覆盖有人登记过的维度，而默认值是「最容易改、改错最贵」的一类：#614 把 CLI 槽位的缺省折叠
  策略换掉了，机器闸一路全绿。发现某条声称其实可以机器化，就在当场把锚点加上。
