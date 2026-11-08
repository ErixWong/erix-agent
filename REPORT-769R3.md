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
