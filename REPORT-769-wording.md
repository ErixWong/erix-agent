# REPORT-769-wording（R6：两处「文档说的 ≠ 实际行为」纯文案修正）

工作树 `/home/eric/wt-769w6`，分支 `fix-261108-32-capability-wording`，起点 HEAD `7095ef6`。
本切片**只改文案**：`CHANGELOG.md` 与 `docs/host-consumer-contract.md` / `docs/host-consumer-contract_cn.md`。不碰 `src/`，不动 `test/test-suite-baseline.json` 与 `scripts/type-check-ratchet.mjs`。

## 取证边界

边界：以下每条结论都指回一次我在这棵树上真跑过的命令；闸门输出抄现报原文，不转述。
未跑的面一律进 `## 未验证`（最后一格）。

代码事实（照抄来源，不改行为）：

- 读侧缺席静默：`src/loop/resume-manager.js:91` —— `if (typeof ctx.store?.listRecoveryRows !== "function") return [];`，不发事件、直接回落快照三格。
  取证命令：`sed -n '85,95p' src/loop/resume-manager.js`
- 写侧/清盘侧缺席各发一条按方法去重的：`src/loop/orchestrator.js` 的 `persistClassified` 里 `typeof store?.[method] !== "function"` ⇒ `notifyCapabilitySkipped(method)`。
  取证命令：`grep -n "notifyCapabilitySkipped\|typeof store?\.\[method\]" src/loop/orchestrator.js`
- 清盘有前提：`persistClassified` 开头 `if (!persistenceRequired) return false;` ⇒ `persistence: "none"` 时既不清也不发诊断。
  取证命令：同上的函数体 `sed` 落点。

## 打算怎么改

### ① 拆掉「三者都可选 ⇒ 报 capability_skipped 并读不到东西」的一锅烩

事件面分两种，写清楚：
- **写侧 `appendRecoveryRow` / 清盘侧 `clearRecoveryRows` 缺席** ⇒ 各发一条 `persistence_capability_degraded`（按方法名去重，整轮一条）。
- **读侧 `listRecoveryRows` 缺席** ⇒ **静默**，回落快照三格；宿主想知道就得自己查 store 有没有实现这个方法。
落点：`CHANGELOG.md` #769 中英两条、能力表 `Optional ledger recovery rows (issue #769)` 行（EN/CN）、恢复行章节「All three are **optional**」段（EN/CN）。
裁决不变：读侧维持静默回落，**不加事件、不改行为**（每次续跑都可能命中，发事件会把降级面变成噪音）。

### ② 「fresh start 会清恢复行」补两个前提

必须写全：清盘只在 **持久化开着**（`persistence` 非 `"none"`）**且 store 实现了 `clearRecoveryRows`** 时才发生；缺任何一个 ⇒ 旧行留在场上，此时同一 `runId` 复用只许「永不续跑」，否则换新 `runId`。
落点：能力表 `Optional ledger recovery-row clear (issue #769 R3)` 行（EN/CN）、`CHANGELOG.md:9-10`。
**用指向**：指回契约「runId 生命周期」段（条件在那里已写全），不把那段复制一遍造成两处真相。

## 闸门

（跑完在这里补现报原文，尤其 spelling 钉子改前的红与改后的绿。）

## 未验证

（保持最后一格。）
