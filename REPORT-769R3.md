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
- [ ] **F1** 契约两语各一处：`partial-text` 载的是**那一刻的完整累计正文**（不截断、无派生长度）——改文档，不改代码（`src/store/recovery-rows.js` 里既无 `200` 也无 `truncat`；`orchestrator.js` 整段传 `text`）。⚠ `check:docs`/`:strict` 抓不到这条，不能靠闸兜。
- [ ] **F2** `test/store/ledger-recovery-rows-769.test.js` 的「写点」格补**跨通道调用次序**断言：包一层记录调用序列的 store，同一序列里比较 `appendRecoveryRow` 与写 `tool_result` 的那次调用谁先；反向证＝把恢复行的 await 挪到写 `tool_result` 之后 ⇒ 这格必须红，红话点名。
- [ ] **F3** CHANGELOG 中英字节口径改口：`256 B` 那格**含**一段短样例正文（`test/store/ledger-recovery-rows-769.test.js` 里写的 `"半截正文样例"`，按整行字节统计）；真实成本随正文长度增长、K 个不同前缀 = K 行、目前无上限。**不新增配对条**，粗体标题内不再套 `**`。
- [ ] **F4** 并对照版两处：`phase` 按失败点分两格（读失败 / fresh-start 清盘失败可分流，命名沿用 `checkpoint_after_tool` 那种「说在哪一步失败」的风格），中英错误码与字段说明同步；`cause` 已在 `KitError` 构造选项里传（**已同型，不动**）。
- [ ] **F5** 四条红闸从红转绿：`check:inventory`（只能 `node scripts/flat-count-inventory.mjs . --sync test/compat-pin-inventory.md`）、`check:mutation`（先 `--sync`，「期望红话」列手写要自己对）+ `check:mutation:run` 全咬、`check:pack-links`（`AGENTS.md:147` 与 `AGENTS_cn.md:123` 的 `89`→`90`，中英一起）、`check:docs-spelling`（按扫描器现报 uses 登记 + 脚本注释写逐条定位）。
- [ ] **F6** 本报告的 `## 逐条处置（A/B/C1-C4/D + F1-F5）` / `## 闸` / `## 未验证` 补全，每条指回一条真跑过的命令。
- [ ] **F7** 记进报告（不修）：`partial-text` 每轮重抄整段累计正文 ⇒ 平方级增长，已单开 **issue #791**，本切片不动语义。
