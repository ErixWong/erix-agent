# 688 — 删掉 16 个「本应已退役」的导出（删除边界 0.30 → 0.31）

分支：`feat-261103-03-delete-retired-exports-688`，基点 main `1d86fbc`，工作树
`/home/eric/projects/worktrees/erix-688`。六个实施步骤各一个 commit，本报告的每一节对应一个提交。

## 取证边界

实际打开 / 读取过的路径（全部在本工作树内，全部可读；没有打不开的路径，因此没有 `BLOCKED:` 条目）：

- 门禁脚本：`scripts/deprecated-export-check.mjs`、`scripts/guide-removal-gate.mjs`、
  `scripts/docs-drift-check.mjs`、`scripts/bundle-guide-table.mjs`、`scripts/host-consumer-probe.mjs`、
  `scripts/export-consumer-check.mjs`、`scripts/release-check.mjs`、`scripts/docs-sync-check.mjs`、
  `scripts/retired-spelling-scan.mjs`、`scripts/agents-directive-scan.mjs`、`scripts/build-types.mjs`、
  `scripts/soak.mjs`、`scripts/pack-link-check.mjs`
- 导出面与实现：`src/index.js`、`src/tools/index.js`、`src/tokens.js`、`src/reflection/l0.js`、
  `src/compact/provider-summarizer.js`、`src/tools/providers.js`、`src/tools/notes.js`、
  `src/tools/delegation/roster.js`、`src/tools/file-tools.js`、`src/config/env.js`、
  `src/providers/anthropic.js`（只读，未改）
- 测试：`test/guide-removal-gate.test.js`、`test/host-consumer-probe.test.js`、
  `test/docs-anchor-ratchet.test.js`、`test/static-guards.test.js`、`test/doc-examples.js`、
  `test/test-suite-baseline.json`
- 文档（中英成对）：`README.md` / `README_cn.md`、`AGENTS.md` / `AGENTS_cn.md`、
  `docs/architecture.md` / `docs/architecture_cn.md`、`docs/host-consumer-contract.md` /
  `docs/host-consumer-contract_cn.md`、`docs/requirements.md` / `docs/requirements_cn.md`、
  `docs/host-upgrade-guide-0.30.0.md` / `_cn.md`、新建 `docs/host-upgrade-guide-0.31.0.md` / `_cn.md`、
  `CHANGELOG.md`、`docs/maintenance/symbol-anchor-ledger.md` / `_cn.md`、`package.json`
- 宿主侧实测：`/home/eric/projects/{fde-workshop,touwaka,erix-station,app_container}`（只被探针递归读取，
  未做任何写入；命中 1 处 = `app_container/apps/worker/src/pi/erix-adapter.js:2`）

`docs/delivery/` 在本仓是 gitignore 的本地档案目录（`AGENTS.md` 写明「交付证据的持久落点是 PR/issue 评论」），
所以本报告写在任务指定的 `delivery/688-delete-retired-exports.md`（仓库根、可入库），不写 `docs/delivery/`。

## 第 1 步 · 把删除边界从 0.30 挪到 0.31（commit `30ea89a`）

改了什么：

- `scripts/deprecated-export-check.mjs`：`NEXT_BREAKING_VERSION = "0.30"` → `"0.31"`；全文件里把
  「唯一合法移除边界 = 0.30」的叙述同步成 0.31，并把「再编一个版本号」的例子改成 0.32（原来是 0.31）。
- 16 条 `@deprecated … removed in 0.30` 标记 → `removed in 0.31`（`grep -rn "removed in 0.30" src/` 之后为 0）。
- 自测期望逐条反转：④ R3 现在把标记改成 `0.30` 才红（原来是改成 0.31 红）；⑨「更晚的版本不是免死金牌」
  改成打 `0.32`；⑬ R9 的外来版本改成 `0.30`、合法版本控制组是 `0.31`。
- `AGENTS.md` / `AGENTS_cn.md` 里「0.30 是唯一合法移除边界 / 发明 0.31」一类措辞同步成 0.31 / 0.32
  （当前版本句 `package.json says 0.30.0` 不动）。

实测：

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `node scripts/deprecated-export-check.mjs --self-test` | 0 | `OK — 24 条判据全部按预期` |

## 第 2 步 · 删导出（commit `74f2d2e`）

改了什么：

- `src/index.js` 去掉 10 个再导出：`createAnthropicProvider`、`estimateMessagesTokens`、
  `MESSAGE_OVERHEAD_TOKENS`、`NOTE_VALUE_MAX_CHARS`、`createEnvModelConfigProvider`、
  `serializeFoldedMessages`、`extractL0Fact`、`extractL0`、`parseReflectionSummary`、`parseSummary`。
- `src/tools/index.js` 去掉 7 个入口名：`createStaticToolProvider`、`createJsonFileToolProvider`、
  `createCompositeToolProvider`、`resolveFileReadMaxBytes`、`setNotesClock`、`removeRecord`、
  `NOTE_VALUE_MAX_CHARS`。
- **只删导出，不删实现**：16 个符号的实现、模块级 `export` 与 `@deprecated` 标记全部保留在原文件里
  （`src/providers/anthropic.js` 整个协议实现未动）。库内（`src/` `bin/` `examples/`）没有一处引用它们，
  所以没有内部引用要摘；`test/` 一律走 `src/...` 深路径，未受影响。
- `scripts/soak.mjs` 改为从 `../src/providers/anthropic.js` 取工厂（它是仓内脚本，不是宿主）。

实测（`node -e 'Object.keys(await import(...))'`）：

- 删除前：root **95** 键 / `./tools` **53** 键（用 `git show HEAD~1:src/index.js` 现数）。
- 删除后：root **85** 键 / `./tools` **46** 键。
- 任务书猜的 `tools 47` 差 1：`NOTE_VALUE_MAX_CHARS` 在两个入口上都存在，所以 16 个名字对应 **17** 行入口，
  `./tools` 是 53 − 7 = 46（以实测为准）。
- `npm run check:exports`：140 个导出名 ⇒ 零消费者候选 **0** 个（删之前是 16）。

这一提交之后的中间态是**故意红**的（任务书 §3 第 2 步要求 `check:release` 红）：文档、0.31 指南与 #687
登记表还没跟上。

## 第 3 步 · 文档面改写（commit `a270a45`）

改了什么（中英成对，8 个文件）：

- `README.md:1128` / `README_cn.md:609`：notes 一节不再推荐 `createStaticToolProvider`，改成「宿主自己写
  `{ listTools(sel) }`；本包不提供工具 provider 工厂」。
- `docs/architecture.md` / `_cn.md`：§3.1 删掉 `createAnthropicProvider` 的签名块，写清「`createOpenAIProvider`
  是本包唯一发布的 provider 工厂，其他协议由宿主提供 provider 对象，Anthropic 适配器是内部件、协议助手仍公开」；
  §3.4 删掉 `createEnvModelConfigProvider` 一行并说明宿主自己实现 `resolve(slot)`；§3.6 删掉三个工具 provider
  工厂并说明 `ToolProvider` 是宿主自建的 duck-typed 对象。
- `docs/host-consumer-contract.md` / `_cn.md`：请求注入一节（EN `:1890` / CN `:1540` 附近）改成「只有
  `createOpenAIProvider` 接受这两个键，内部 Anthropic 适配器同样接受」；probe order 表第 4 行与「未知 slot
  字段惰性」那段（EN `:2520` / `:2582`，CN `:2036` / `:2088`）改成「provider 对象自报元数据 / 工厂读固定参数
  列表」；notes 注册一节（EN `:4837` / CN `:3837`）不再点名 `createCompositeToolProvider` / `createStaticToolProvider`。
- `docs/requirements.md` / `_cn.md`：FR-1.1 与 FR-4.1 的口径同步（Anthropic 是内部件；环境变量 provider 不再发布）。
- `test/doc-examples.js`：`#181` 那个围栏 preamble 的 `linkImports` 去掉 `createAnthropicProvider`（围栏本体
  只用 `createOpenAIProvider`，原来那条 import 是多余且现在会加载期失败）。

实测：

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `node --test test/doc-examples.test.js` | 0 | `tests 63 / pass 63 / fail 0` |
| `npm run check:docs` | 1（中间态） | 仅剩 `bundle-table: 指南版本 0.30.0 与 …（0.31）不是同一个 x.y`（第 5 步修） |

## 第 4 步 · 账本要留，不能丢事实（commit `6e8fb30`）

改了什么：

- `REMOVAL_REGISTRY.createAnthropicProvider` 增加 `status: "landed"`（已落地）并扩写 reason：名字真的在
  0.31 删了、标记随公共面消失，账留着记那笔宿主可见破坏；宿主事实 `app_container/.../erix-adapter.js:2`
  原样保留。
- 新增判据 **R14 `REGISTRY_LANDED_STILL_EXPORTED`**：`status: "landed"` 的名字若**还在**公共导出面上 ⇒ 红并
  点名。已落地条目跳过 R7（没有标记是正确形态）与 R10（没有标记正文可对），R8 增加 `status` 形状校验
  （只接受不写或 `landed`）。
- `--self-test` 重做：真树现在**零候选**（16 个全删），所以 R1–R6/R10/R11 的靶子改成一个**内存合成候选**
  （把 `estimateMessageTokens` 伪装成 zero-reference 并注入一条带「known host-visible breakage」自称与宿主
  事实的标记）；新增 ⑪b 两枪：已落地条目剥掉标记仍绿、同名放回公共导出面 ⇒ R14 红。判据数 24 → 26。
- `AGENTS.md` / `AGENTS_cn.md` 的 R 列表补 R14。

实测：

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `node scripts/deprecated-export-check.mjs` | 0 | `0 个候选`、`账本 1 条（其中已落地 1 条）`、0 红 |
| `node scripts/deprecated-export-check.mjs --self-test` | 0 | `OK — 26 条判据全部按预期` |
| `node scripts/deprecated-export-check.mjs --types`（先 `npm run types:build`） | 0 | 0 红 |

## 第 5 步 · 新指南 + 0.30 指南勘误（commit `7917360`）

改了什么：

- 新建 `docs/host-upgrade-guide-0.31.0.md` / `_cn.md`：第一行 `<!-- doc-version: 0.31.0 -->`，16 行逐名表
  （5 格：Name / What it did / Migration clause / Entry / Definition）+ `createAnthropicProvider` 的 §3 一节
  （带登记的宿主事实；配方指回 0.30.0 指南 §3.2，避免把退役扁平拼写带进新指南）。迁移条款逐字照抄标记：
  A 类 `migrate to \`X\``，B/C 类 `no in-tree replacement`。入口列按实测：6 个工具名在 `./tools`，
  `NOTE_VALUE_MAX_CHARS` 是 `.` + `./tools`，其余 9 个在 `.`。
- `package.json` 的 `files` 逐文件加入两份新指南；`README.md` / `README_cn.md` 的 `files` 围栏同步。
- `scripts/bundle-guide-table.mjs`：`BUNDLE_GUIDE_VERSION` 0.30.0 → 0.31.0（`check:docs` 的 `bundle-table`、
  `guide-removal-gate`、`host-consumer-probe` 三处读同一份，于是都认 0.31 指南）。
- 0.30.0 指南 **§2/§3 就地勘误**（顶部一条 errata 引用块 + §2 开头 + §3 那段「工厂已不存在」改成「其实还在，
  0.31.0 才删」，并带前向指针 `see the 0.31.0 upgrade guide` /「见 0.31.0 升级指南」）。**§4 一个字节没动**
  （#690 的 `unchanged-surface` 锚点在看着）。
- `CHANGELOG.md`：`## [0.31.0] - 2026-11-10（未发布 / unpublished）`，`### Breaking` 记 16 个删除 + 0.30.0
  勘误，中英成对（英文 2 条 / 中文 2 条）。
- `scripts/docs-drift-check.mjs`：`bundle-table` 的**真值**从「现算候选」扩成「现算候选 ∪ 源码里带
  `removed in <NEXT_BREAKING_VERSION>` 的退役标记」。这是主 agent 第 3 点要求的：候选集为空**不许**让这一格
  变成永真。现在逐名集合与迁移条款仍然现算对账（删一行 / 多一行 / 改条款都红），只有入口列对已退役行失去
  现读真值（再导出块里没有它了），那一格对 retired 行只校中英一致——候选集一旦非空，入口列对候选行自动
  恢复现读对账。`--self-test` 的 14b 家族同步：删一行 / 多一行 / 只改一边 / 改条款 / 重名 / 中英入口列不一致
  六枪 + 一条「只改散文仍绿」的放行证。
- `scripts/host-consumer-probe.mjs`：求交面从「候选」扩成「候选 ∪ 当前指南声称已删的名字」，命中带
  `retired: true`。这样真删之后宿主对已删名字的导入仍然是命中（否则最该被覆盖的那笔账会被静默掉）。
- 连带的**份数/数字真值**同步（都是仓库写死的机器对账，不是手改口径）：`REF_SCAN_DOCS_MINIMUM` 49 → 51、
  README 的「49 documents / 34 份」→ 51 / 36、`AGENTS*.md` 与 `symbol-anchor-ledger*` 的同一组数、
  `test/docs-anchor-ratchet.test.js` 的 `GUIDE_DOCS_PINNED` +2 与字面量 51。
- `.d.ts` 真值：90 → **87**。`src/tools/providers.js`、`src/providers/anthropic.js`、`src/config/env.js` 的唯一
  公共再导出退役后，它们离开了声明依赖图（实现仍在 `src/`，`files` 仍随包）。`AGENTS*.md` 的「装包应列 N 个
  `.d.ts`」与类型棘轮的「带错文件数」声称（27/29 → 26/28）都按实测更新。

实测：

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `npm run check:docs` | 0 | `122 项对齐 package.json 0.30.0 与源码` |
| `npm run check:docs:strict` | 0 | 同上 |
| `node scripts/docs-drift-check.mjs --self-test` | 0 | `OK — 189 例反向证/放行证全部按预期` |
| `npm run check:docs-spelling` | 0 | `--strict: OK — 0 处红` |
| `npm run check:agents-directives` | 0 | `--strict: OK — 0 处红`；`--verify` 逐格等于实测 |
| `node scripts/agents-directive-scan.mjs --self-test` | 0 | `OK — 16 例 … × 3 种欠账形态` |
| `npm run check:pack-links` | 0 | `.d.ts 声称对账：2 处声明位全部等于随包声明数 87` |
| `npm run check:inventory` | 0 | 逐文件 0 处不一致 |
| `npm run check:config-leaf-values` | 0 | 表与实测一致 |
| `npm run check:mutation` | 0 | 16 条样本，逐条 0 处不一致 |
| `npm run check:types` | 0 | 94 个错 / 26 个文件（基线 103） |
| `npm run check:types -- --with-tools` | 0 | 129 个错 / 28 个文件（基线 138） |
| `npm run check:types:strict` | 0 | 1845 个 strict 错 / 70 个文件（基线 1892） |
| `npm run check:types:strict -- --with-tools` | 0 | 2058 / 76（基线 2122） |
| `npm run check:types-build` | 0 | 87 个 `.d.ts`，4 个断言全命中 |
| `node scripts/host-consumer-probe.mjs --self-test` | 0 | `OK — 15 条判据全部按预期` |

## 第 6 步 · 清空 #687 的登记表（commit `796abe9`）

改了什么：

- `scripts/guide-removal-gate.mjs`：`KNOWN_NOT_REMOVED` 16 条 ⇒ **0 条**；注释改成「删干净之后它是空的，
  它是棘轮：条目只许减，将来再出现『指南说删了、包还在』必须重新登记并写 why」。
- `--self-test` 的反向证改成用**内存合成登记表**（真表为空是事实，不是判据失效）：⑥ 合成表兜住全部名集 ⇒ 绿；
  ⑥b 真表 0 条 + 全删净的世界 ⇒ 绿；⑦ 少一条 ⇒ G1、多一条 ⇒ G3；⑧ 空 why ⇒ G2；⑨ 删除发生而登记还在 ⇒ G3；
  ⑭ 形状坏 / 重名 ⇒ 红。判据数仍是 18。
- `test/guide-removal-gate.test.js`：A 改成「登记表必须是空的」；B 断言真树 `stillExported.size === 0`；
  B2/C 用合成登记表；D 的 CHANGELOG 夹具段改成 0.31.0；F 改成两态：全删净 + 空表 ⇒ exit 0 且
  `已知未删除 0 条（N=0）`，「一个都没删」的世界 + 空表 ⇒ exit 1 且点名 `STILL_EXPORTED`。

实测：

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `node scripts/guide-removal-gate.mjs --self-test` | 0 | `OK — 18 条判据全部按预期` |
| `node --test test/guide-removal-gate.test.js` | 0 | `tests 7 / pass 7 / fail 0` |

## 三态证明（§4，log 摘要）

- **态一（删完导出、还没清登记表）**：`npm run check:release` **exit 1**，红在第 2/6 步「装」——
  `升级指南「已删除」对账红了 16 处（指南说删了、发布物还在导出）`，逐条 `[REGISTRY_IDLE] <名字> @
  docs/host-upgrade-guide-0.31.0.md:<行> / …_cn.md:<行> @ <入口>`（16 条全点名）。log：`/tmp/e688/release-state1.log`
  （摘要见本报告第 5 步之前那一次运行；关键行已抄在上面）。
- **态二（全部完成后）**：`npm run check:release` **exit 0**，`6 步全绿，累计 20.3s`；第 2 步打印
  `升级指南「已删除」对账：名集 16 个名字（中英两份，入口按指南行）全部不在运行时导出面上；运行时面
  root 85 键 / ./tools 46 键；已知未删除 0 条（N=0）`；随包契约套件 `tests=139 pass=139 fail=0`；tsc 正向
  exit 0、未知键 TS2353、#519 反向证、CLI 冒烟（`--version=0.30.0`、chat 退 4、`--session` 缺失退 1）、
  跨 run 续接 4 条断言全绿。log：`/tmp/e688/release-state2.log`。
- **态三（宿主覆盖）**：`npm run check:host-consumers -- --hosts
  /home/eric/projects/fde-workshop,/home/eric/projects/touwaka,/home/eric/projects/erix-station,/home/eric/projects/app_container`
  **exit 0**；扫 2611 个代码文件、解析不出名字 9 处（`dynamic-import` × 9，照实打印）；`## 命中（1 处）—— 全部已被
  0.31.0 指南覆盖：绿`，那一处是 `createAnthropicProvider @ 宿主仓 app_container —
  /home/eric/projects/app_container/apps/worker/src/pi/erix-adapter.js:2`（登记删除版本 0.31；这一版已删），
  并带出中英两份指南条目 `host-upgrade-guide-0.31.0.md:73` / `_cn.md:61`。log：`/tmp/e688/host-state3.log`。

## 判据清单（§5，逐条退出码）

| 判据 | 退出码 | 备注 |
|---|---|---|
| `npm run check:syntax` | 0 | 462 个文件全过 |
| `npm test` | 0 | `# tests 3393 / # pass 3380 / # fail 0 / # skipped 13`（另有 suites 13 / cancelled 0 / todo 0） |
| `npm run check:test-summary -- --log <测试日志>` | 0 | `TEST-SUMMARY-VERDICT ok`（tests=3393 等于登记值，skipped 13 ≤ 15，无需改基线） |
| `npm run check:docs` | 0 | 122 项 |
| `npm run check:docs:strict` | 0 | 同上 |
| `node scripts/docs-drift-check.mjs --self-test` | 0 | 189 例 |
| `npm run check:docs-spelling` | 0 | 0 处红 |
| `npm run check:agents-directives` | 0 | `--strict` + `--verify` 都过 |
| `node scripts/agents-directive-scan.mjs --self-test` | 0 | 16 例 |
| `npm run check:exports` | 0 | 候选 0 个（清点，无闸） |
| `npm run check:exports:deprecated` | 0 | 0 红 |
| `npm run check:exports:deprecated -- --types` | 0 | 先 `npm run types:build`；0 红 |
| `node scripts/deprecated-export-check.mjs --self-test` | 0 | 26 条 |
| `npm run check:pack-links` | 0 | 87 个 `.d.ts` 对账 |
| `npm run check:inventory` | 0 | 0 处不一致 |
| `npm run check:config-leaf-values` | 0 | 一致 |
| `npm run check:types` / `-- --with-tools` | 0 / 0 | 94/26、129/28 |
| `npm run check:types:strict` / `-- --with-tools` | 0 / 0 | 1845/70、2058/76 |
| `npm run check:types-build` | 0 | 87 个 `.d.ts` |
| `npm run check:mutation` | 0 | 16 条样本 |
| `node scripts/guide-removal-gate.mjs --self-test` | 0 | 18 条 |
| `npm run check:release` | 态一 1 / 态二 0 | 见上 |
| `npm run check:host-consumers -- --hosts …` | 0 | 见态三 |

（另外跑过 `node scripts/retired-spelling-scan.mjs --self-test`（0，23 例）、
`node scripts/pack-link-check.mjs --self-test`（0，18 例）、`node --test test/doc-examples.test.js`（0，63/63）。）

## 改动了既有自测期望的地方（逐条理由）

主 agent 要求「改既有期望必须逐条写清为什么」。以下是全部：

1. `scripts/deprecated-export-check.mjs --self-test` ④/⑨/⑬：**真边界变化**（0.30 → 0.31），把「写 0.31 仍红」
   反转为「写 0.30 仍红」，更晚版本那一枪挪到 0.32。不是放宽。
2. 同文件 `--self-test` ①–⑦/⑩/⑭：**真树候选集归零**（16 个全删）。R1–R6/R10/R11 的靶子改成内存合成候选
   （不写盘），判据本体一字未改；新增 ⑪b 两枪把「已落地」形态的两侧都钉住。判据 24 → 26（变多，不是变宽）。
3. `scripts/guide-removal-gate.mjs --self-test` ⑥⑦⑧⑨⑭ + `test/guide-removal-gate.test.js` B2/C：
   **真登记表归零**（删除真的发生）。反向证改用内存合成登记表，判据本体不变；F 两态反转成「全删净 ⇒ exit 0、
   一个都没删 ⇒ exit 1 点名 STILL_EXPORTED」。
4. `scripts/docs-drift-check.mjs --self-test` 的 `#635 ①` 两条：**份数地板真的变了**（新增两份指南 ⇒
   49→51、34→36），overlay 的靶串与期望数字随之更新，判据本体不变。
5. 同文件 14b 家族：`bundle-table` 的指南从 0.30.0 换成 0.31.0、真值扩成「候选 ∪ 退役标记」。删一行/多一行/
   只改一边/改条款四枪恢复成「点名缺/多/条款」；新增「重名」与「中英入口列不一致」两枪；原来那枪「入口列
   写错 ⇒ 红（住址错了）」在退役行上失去现读真值，改成中英一致判据（这是**收窄一格**，已在代码节头与
   `bundle-table` 的边界注释里写明；候选集一旦非空，入口列对候选行自动恢复原判据）。
6. `test/static-guards.test.js` 的 CHANGELOG 配对地板：**校准面真的挪了**（顶部 `Unreleased` 为空 ⇒ 退到新开的
   0.31.0 节），按该文件注释第 3 条重测：`CHANGELOG_PAIR_FLOOR_SURFACE` 0.30.0 → 0.31.0、
   `CHANGELOG_PAIR_FLOOR` 7 → 2。同一面内「只升不降」的规则不变。
7. `test/host-consumer-probe.test.js`：版本字面量 0.30 → 0.31；「真树 × 全候选」改成「真树 × 全退役名」
   （候选现在是 0，这是事实；求交面由指南那一半提供，与探针实现同源）；`--json` 的
   `candidates.some(createAnthropicProvider)` 改成 `hit.retired === true`（候选清单为空）。
8. `test/docs-anchor-ratchet.test.js`：`GUIDE_DOCS_PINNED` +2 份、下限字面量 49 → 51（新指南按目录实扫自动
   纳面，测试侧那份硬编码清单必须同步，否则就是「覆盖面静默缩面」）。
9. `test/doc-examples.js` 的 `#181` preamble：去掉围栏里没用到的 `createAnthropicProvider` import（它现在会
   在加载期失败）。

## 未验证项

- **没跑 `npm run check:mutation:run`**：任务书 §5 明确不跑（真上游/会改写 tracked 源文件那一族归发布前）。
- **没跑 `npm run check:release:real`**：同上，归发布前真上游清单。
- **`check:host-consumers` 的「未解析形状」**：9 处 `dynamic-import` 解析不出名字，探针照实打印但证明不了
  「没在用」；`touwaka` 用动态 import 取包根，这一维没有机器证据。
- **宿主实际迁移**：本单只证「破坏可见 + 可迁」，没有核 `app_container`（已被 `fde-workshop` 取代）是否真的
  改掉了那一行 import。
- **`package.json` 版本仍是 0.30.0**：切版归 #689，本单不切；0.31.0 指南与 CHANGELOG 段都标了「未发布」，
  `check:docs` 的版本归属/发布态判据按这个口径绿。
