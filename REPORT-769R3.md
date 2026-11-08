# REPORT #769 R3 —— 清 copilot 验收的两阻断（A/B）+ 四处契约/实现不符（C1-C4）+ 顺序证据（D）

树 `/home/eric/wt-769e3`，分支 `fix-261108-25-recovery-gen-guard-erix`，基点 `a015da5`（含 R2 全部 + 主会话两笔派生登记 `cfae178`/`a015da5`）。

## 取证边界

**读过的输入（只有这三类）**

1. 工单 `/home/eric/store-review-261106/tickets/769-r3.md`（全文，语义以它为准）。
2. 验收原文 `/home/eric/copilot-sbx/rv769/REVIEW-769.md`（唯一被读的沙箱文件，未读同目录/其他沙箱的别的文件）。
3. 本树源码 / 文档 / 测试 / 脚本 + 本树命令输出。

**边界声明**

- 未读 `/home/eric/wt-769e`、`/home/eric/wt-769e2`、`/home/eric/wt-769w`、`/home/eric/wt-75*`、`/home/eric/wt-77*`、主仓 `/home/eric/projects/erix-llm-kit` 的任何文件；所有编辑只落本树。
- 起点数值（`npm test` 3725 / pass 3712 / fail 0、`CHANGELOG_PAIR_FLOOR = 30`、`BARE_LINE_REF_BASELINE = 6`）取自工单文本；本报告里凡是**我声称的**数字都指回本树里我真跑过的一条命令，起点值不算我的实测。
- 验收原文里的行号是其快照行号；我在本树定位一律用「符号 + 文件」，不复用其行号作判据。
- 未 push、未开 PR。每个里程碑一次 commit + `git diff > /tmp/769r3-mN.diff`。

## 逐条处置（A/B/C1-C4/D）

### A —— 恢复行无 run 代际 + `resume:false` 不清盘（阻断，M2）

（待填）

### B —— 读侧把任意 rejection 吞成空集（阻断，M1）

（待填）

### C1 —— `clearRecoveryRows` 契约承诺但零实现

（待填）

### C2 —— 能力分级表漏登记三方法

（待填）

### C3 —— `partial-text` 的 `textLength` 声称

（待填）

### C4 —— `482 B/轮` 口径不是「不含正文」

（待填）

### D —— 跨通道顺序与续跑幂等无证据

（待填）

## 闸

（待填）

## 未验证

（待填）

---

# R4 收口段（第 164 轮起）

## R4 取证边界
- 只读：本树 `/home/eric/wt-769e3`、工单 `/home/eric/store-review-261106/tickets/769-r3.md`、验收原文 `/home/eric/copilot-sbx/rv769/REVIEW-769.md`。未读对照树 `/home/eric/wt-769w3`（F4 的两处取值只照主会话给的结论移植，没去翻它别的文件）。
- 起点勘验（本轮实跑）：`git log --oneline -3` ⇒ HEAD `eda20ed`（主会话代打的 checkpoint，含 R3 段末我未提交的 EN 反引号修复 + 删临时脚本）；`git status --porcelain` ⇒ **空输出（树干净）**。
- 起点证据复现：`grep -rn "200\|truncat" src/store/recovery-rows.js` ⇒ **空**（⇒ F1 契约那句「truncated to 200 characters」是假话，EN `docs/host-consumer-contract.md:7367` 实存）；`grep -c "methodLog\|recordingStore" test/store/ledger-recovery-rows-769.test.js` ⇒ **0**（⇒ F2 为真，R3 段我自报的 `recordingStore`/`methodLog` 在树上不存在，**自报错一处**）。
- 判定只认退出码与点名到具体断言；每个数字指回本报告中一条我真跑过的命令。

## R4 待办（主会话实测清单，逐条办完即 commit + `git diff > /tmp/769r4-mN.diff` + 交棒）
- [x] **F1** 契约两语各一处：`partial-text` 载的是**那一刻的完整累计正文**（不截断、无派生长度）——改文档，不改代码（`src/store/recovery-rows.js` 里既无 `200` 也无 `truncat`；`orchestrator.js` 整段传 `text`）。⚠ `check:docs`/`:strict` 抓不到这条，不能靠闸兜。
- [x] **F2** `test/store/ledger-recovery-rows-769.test.js` 的「写点」格补**跨通道调用次序**断言：包一层记录调用序列的 store，同一序列里比较 `appendRecoveryRow` 与写 `tool_result` 的那次调用谁先；反向证＝把恢复行的 await 挪到写 `tool_result` 之后 ⇒ 这格必须红，红话点名。
- [x] **F3** CHANGELOG 中英字节口径改口：`256 B` 那格**含**一段短样例正文（`test/store/ledger-recovery-rows-769.test.js` 里写的 `"半截正文样例"`，按整行字节统计）；真实成本随正文长度增长、K 个不同前缀 = K 行、目前无上限。**不新增配对条**，粗体标题内不再套 `**`。
- [x] **F4** 并对照版两处：`phase` 按失败点分两格（读失败 / fresh-start 清盘失败可分流，命名沿用 `checkpoint_after_tool` 那种「说在哪一步失败」的风格），中英错误码与字段说明同步；`cause` 已在 `KitError` 构造选项里传（**已同型，不动**）。
- [x] **F5** 四条红闸从红转绿：`check:inventory`（只能 `node scripts/flat-count-inventory.mjs . --sync test/compat-pin-inventory.md`）、`check:mutation`（先 `--sync`，「期望红话」列手写要自己对）+ `check:mutation:run` 全咬、`check:pack-links`（`AGENTS.md:147` 与 `AGENTS_cn.md:123` 的 `89`→`90`，中英一起）、`check:docs-spelling`（按扫描器现报 uses 登记 + 脚本注释写逐条定位）。
- [x] **F6** 本报告的 `## 逐条处置（A/B/C1-C4/D + F1-F5）` / `## 闸` / `## 未验证` 补全，每条指回一条真跑过的命令。
- [x] **F7** 记进报告（不修）：`partial-text` 每轮重抄整段累计正文 ⇒ 平方级增长，已单开 **issue #791**，本切片不动语义。

## 逐条处置（A/B/C1-C4/D + F1-F5）

**R3 段落的四条阻断/四处不符**（实现见 commit `18201b5`，主会话已在源码上逐条复核并承认「A、B、C1、C2 都做对了」）：
A 代际边界 ⇒ `clearRecoveryRows` + `resume !== true` 的一次性清盘（`src/loop/orchestrator.js:2247`，走能力位）；
B 吞错 ⇒ 新终局错误码 `recovery_rows_unreadable`（`src/loop/resume-manager.js`，`cause` 走 `KitError` 构造选项）；
C1 `clearRecoveryRows` 两 store 落地；C2 三个方法进中英能力分级表；C3 `textLength` 改文档删声称（不给行加字段）；
C4 字节口径改口（见 F3）；D 幂等格改成 run 层「第二条不同事件键 + 第一条无重复」，次序断言见 F2。
⚠ **自报纠错一处**：R3 段终稿说 M4 用的是 `recordingStore` / `methodLog` —— 这两个名字在树上不存在，
实际实现是同一测试文件末尾那条「（D）跨通道顺序」用例里的 `calls` 序列包装（`test/store/ledger-recovery-rows-769.test.js:584-620`）。
主会话据 grep 判「那一格仍没做」，本轮核完：**断言在场且被反向证咬住**（下条），缺的是我报错了变量名。

- **F1（契约自己改出假话）**：中英各一处把 `partial-text` 的「truncated to 200 字符」改成**那一刻的完整累计正文——不截断、不设上限，引擎整段透传；也没有 `textLength`**。代码一行没动。
  证据：起点 `grep -rn "200|truncat" src/store/recovery-rows.js` ⇒ 空；改后 `grep -n "truncated to 200|截到 200" docs/host-consumer-contract.md docs/host-consumer-contract_cn.md` ⇒ 只剩 `docs/host-consumer-contract.md:3940`（judge `reason` 的截断，另一件事）。commit `e60e375`，diff `/tmp/769r4-m1.diff`。
- **F2（M4 次序断言）**：断言在场——包装 store 在**同一调用序列**里比较 `appendRecoveryRow` 与带 `tool_result` 的那次 `appendRound`；本轮只补了「写点」格里指向它的注释（事后两次读比不出先后）。
  反向证两条实跑：① 只把恢复行落盘延后到下一次 `appendRound` 之后 ⇒ `node --test test/store/ledger-recovery-rows-769.test.js` = **14 tests / pass 13 / fail 1**，唯一红格 `not ok 14 …（D）跨通道顺序…`，红话点名「恢复行在第 3 次调用、结果行在第 2 次」；② 注释掉 `src/loop/run-snapshot-executor.js` 里那句 await ⇒ **14 / pass 7 / fail 7**，次序格红话「必须真的写过 order-1 的 tool-executed 恢复行」。终态该文件 **14 / pass 14 / fail 0**。commit `1ee1d80`，diff `/tmp/769r4-m2.diff`。
- **F3（CHANGELOG 字节口径）**：`grep -o "不含正文"` 的残留命中其实是**改口句里引号内的旧说法**（R3 已改口过），本轮去掉引号并把四条事实写白：`256 B` 那格**含**一段短样例正文（用例写 `"半截正文样例"`，按整行字节统计）、真实成本随正文长度增长、K 个不同前缀 = K 行、目前无上限。
  证据：`grep -c "不含正文" CHANGELOG.md` ⇒ **0**；`npm run check:changelog` ⇒ OK（**未新增配对条**，`CHANGELOG_PAIR_FLOOR` 未动，粗体标题里没再套 `**`）。commit `aa38ea9`，diff `/tmp/769r4-m3.diff`。
- **F4（phase 按失败点分格）**：三格 `transcript`（恢复行写不进）/ `resume_recovery_rows`（续跑读不出）/ `recovery_rows_clear`（fresh-start 清盘失败），命名沿用 `checkpoint_after_tool` 那种「说在哪一步失败」；中英各加一段字段面（`reason`/`operation`/`phase`/`sideEffect:"not_started"`/`errorCode`/`cause`，并写明宿主不得把三格合一桶）；`cause` 已在 `KitError` 构造选项里 —— **已同型，未动**。
  派生登记随树重钉：两棵树表内各 41 处 `path:line` + 受害者 8 个 `at:`（orchestrator +4，resume-manager +2；例 `6275→6279`、`819→821`）。
  证据：`npm run check:docs` ⇒ drift OK + 中英 116 节、`✗` 计数 0；`node --test test/contract-snapshot-cell-axes-767.test.js` ⇒ **pass 15 / fail 0**；`node --test test/store/ledger-recovery-rows-769.test.js` ⇒ **14 / fail 0**；`node --test test/tools/file-tools.test.js` ⇒ **64 / fail 0**（样本中位仍 6,157，`resume-manager.js` 长两行没把中位挪走）。commit `70902c8`，diff `/tmp/769r4-m4.diff`。
- **F5（四条红闸从红转绿）**：
  · `check:pack-links`：`AGENTS.md:148` / `AGENTS_cn.md:123` 的 `89`→`90`（`npm pack` 实测 90 个 `src/**/*.d.ts`，新模块进了声明图）⇒ 现报 `pack-link-check: OK — 2 处声明位全部等于随包声明数 90`。
  · `check:inventory`：按唯一合法路子 `node scripts/flat-count-inventory.mjs . --sync test/compat-pin-inventory.md` 补行（主表 2 点 / 附表 4 点），分类列按 --sync 留的 TODO 做**人手裁决** = `MIGRATE · S7c（2）`（两点都是 `runDirect` 顶层扁平 `onEvent` 搭台，沿用 #495/#753 先例），小结写点 8→10、文件列按 §S7c 清单语义保持 17 ⇒ `逐文件：0 处不一致`。commit `660db95` + `277926c`。
  · `check:docs-spelling`：钉子按扫描器现报登记（EN `458→462`、CN `579→584`），并在 `scripts/retired-spelling-scan.mjs` 的钉子注释里写逐条定位（EN 7393/7396/7397/7398/7401/7405/7409、CN 5811/5812/5815/5819，命中键 `resume`/`persistence`，属同名异义不进退役判据）⇒ `--strict: OK — 0 处红`。commit `69b23c4`。
  · `check:mutation`：`node scripts/mutation-sample-check.mjs --sync test/mutation-samples.md` 刷 9 行（M9/M10/M11/M14/M15/M18/M19/M20/M21，比工单多 4 行——F4 又长了行）⇒ `逐条：0 处不一致`；手写「期望红话」列 `--sync` 没碰，改由 `--run` 机器验：**29 条样本逐条「变异 → 红在该报的断言上 → 还原 → 绿」OK**。commit `49d3c66`。
- **F7（记进报告，不修）**：`partial-text` 每轮重抄**整段累计正文** ⇒ 账本字节随轮数**平方级**增长；已单开 **issue #791**，本切片不动语义。（本轮 F1 把「不截断、不设上限」写进契约，正是这条的前置事实。）

## 闸（终态；跑任何闸前 `find src -name '*.d.ts' -delete`）

| 闸 | 现报 |
| --- | --- |
| `npm test --silent > /tmp/r4-full-final.log` | **exit 0**；`tests 3731 / pass 3718 / fail 0 / skipped 13 / todo 0` |
| `npm run check:test-summary -- --log /tmp/r4-full-final.log` | `TEST-SUMMARY-VERDICT ok`（EXPECTED 3725/fail 0/maxSkipped 16）；**无 TESTS_DRIFT**；HINT 原文：「登记值可抬到 3731（当前登记值 3725，本次实测 3731，+6）——多出来的用例不是事故，抬登记值仍是人的动作：本脚本只提示，不改写 test/test-suite-baseline.json（没有 --sync）」⇒ `test/test-suite-baseline.json` **未动** |
| `npm run check:inventory` | `逐文件：0 处不一致` |
| `npm run check:mutation` / `--run` | `逐条：0 处不一致` / `OK — 29 条样本逐条「变异 → 红在该报的断言上 → 还原 → 绿」` |
| `npm run check:pack-links` | `OK — 2 处声明位全部等于随包声明数 90` |
| `npm run check:docs-spelling` | `--strict: OK — 0 处红` |
| `node --test test/static-guards.test.js` | `pass 58 / fail 0` |
| `npm run check:docs` / `check:docs:strict` | 两段 `OK`（drift 126 项 + 中英 116 节）；`--strict` **exit 0** |
| 裸行号棘轮 | `--strict --verbose`：`棘轮口径实测 **6** vs 基线 6` ⇒ `BARE_LINE_REF_BASELINE` 未抬，新散文没用裸行号 |
| `npm run check:syntax` | `OK — 全量 496 个跟踪的 .js/.mjs/.cjs 文件 node --check 全过` |
| `npm run check:agents-directives` / `check:exports` | 各自 **exit 0** |
| `npm run check:docs-examples` | `pass 66 / fail 0` |
| `npm run check:changelog` | `OK — 0.31.0 段覆盖 v0.30.0..v0.31.0 每个碰到公开面的合并号（命中 8 / 豁免 0 / 缺项 0）` |
| `npm run types:build` / `check:types-build` | `OK — tsc exit 0，src/ 下 90 个 .d.ts`；`check:types-build: OK — 断言全过`（exit 0） |
| `npm run check:types` / `check:types:strict` | `OK — 实测 99 / 26 文件，等于基线 99`；strict 实测 **1876 < 基线 1877**（打印「基线可下调至 1876」）⇒ **两档基线一个都没抬**，下调留给主会话 |

## 未验证

- `--self-test`（`docs-drift-check.mjs` / `mutation-sample-check.mjs --self-test`）**没跑**：本段只改了表与钉子数据（`test/compat-pin-inventory.md`、`test/mutation-samples.md`、`scripts/retired-spelling-scan.mjs` 的钉子值），没动漂移检查器判据或锚点面；按工单口径它只在动了 those 时才跑。
- `check:mutation` 的手写「期望红话」列**没有逐条手改**：`--sync` 不碰它，我也没自己改一个字；它的一致性只由 `--run` 的「变异 → 红 → 还原 → 绿」证明，没有独立的词面复核。
- `check:types:strict` 基线**可下调 1877→1876** 这件事没做（不是没验，是留给主会话的合并动作）。
- `test/compat-pin-inventory.md` 的「文件」列语义我按 §S7c 清单行数保持 17（#753 同口径），这是**我做的裁决**，不是扫描器证明的；若主会话认为重新排队的文件也该进清单，那格要一起改。
- R4 段没跑：`check:host-consumers`、`check:exports:deprecated`、`check:release*`、`soak`、`check:final-guard-probe`、`check:config-leaf-values`、`check:version-states`、`check:docs`（`--published` 相关）——工单没列，我也没顺手跑，不声称。
- 对照树 `/home/eric/wt-769w3` **一个字都没读**（F4 只照主会话给的结论移植取值），因此「与对照版同型」只在主会话给的口径上成立，不是我比对出来的。

未 push、未开 PR。分支 `fix-261108-25-recovery-gen-guard-erix`；本段 commit：`89bb405`（R4 待办+取证边界）、`e60e375`（F1）、`1ee1d80`（F2）、`aa38ea9`（F3）、`70902c8`（F4）、`660db95`+`277926c`（F5 inventory/AGENTS）、`69b23c4`（F5 spelling 钉子）、`49d3c66`（F5 mutation 表）、本报告这笔（F6/F7）。
