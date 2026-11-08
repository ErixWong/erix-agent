# REPORT-769-r7 —— 第四轮独立验收剩下的四处文案（纯文档/注释，行为不变）

工作树 `/home/eric/wt-769w7`，基点 HEAD `a60a17a`。分支 `fix-261109-01-capability-docs-audit`。

## 取证边界

每条指回一条我真跑过的命令（下列命令均在 `/home/eric/wt-769w7` 执行，原文抄在对应 commit 段落里）。

- **代码事实 A（读侧静默）**：`sed -n '85,95p' src/loop/resume-manager.js` —— 看 `readRecoveryRowsOrRefuse` 开头对 `listRecoveryRows` 缺席的短路返回，确认**不发事件**。
- **代码事实 B（写侧/清盘侧各发一条、按方法名去重）**：`grep -rn "notifyCapabilitySkipped" src/` 与 `grep -rn "persistence_capability_degraded" src/` —— 数调用点，确认 `listRecoveryRows` 不在其中。
- **代码事实 C（持久化关着 ⇒ 既不清也不发诊断）**：`grep -n "function persistClassified" -A 3 src/loop/orchestrator.js` —— 看第一行 `if (!persistenceRequired) return false;`。
- **① 落点**：`grep -n "persistence_capability_degraded" README.md README_cn.md` —— EN `:813-814`、CN `:548`（`:432` 是另一段快照能力句，别误改）。
- **② 落点**：`sed -n '2265p' docs/host-consumer-contract.md`（EN 能力表那行）+ `grep -n "clearRecoveryRows" docs/host-consumer-contract_cn.md` 找 CN 对应行；生命周期段 EN `:7516-7525` / CN `:5910-5918` **只读不改**。
- **② CHANGELOG 落点**：`sed -n '9,10p' CHANGELOG.md`（EN `:9` / CN `:10` 那对条目）。
- **③④ 落点**：`sed -n '2244,2252p' src/loop/orchestrator.js`、`sed -n '511,519p' src/store/file.js`。
- **闸**：`find src -name '*.d.ts' -delete` 后依次 `npm run check:docs`、`npm run check:docs:strict`、`npm run check:docs-spelling`、`npm run check:changelog`、`npm run check:docs-examples`、`node --test test/contract-verbatim-verdicts-553.test.js`、`node --test test/static-guards.test.js` —— 现报原文逐个抄在下面各笔 commit 段落。

## 四处打算怎么改

**①（README EN `:813-814` + CN `:548`）**：现在的括注 `(one shot per missing optional store capability)` / 「每个缺失的可选 store capability 各发一条」把静默的读侧也算成会发事件。改成：一条按**方法名**去重、**只覆盖写侧与清盘侧的可选 store 能力**；读侧（缺 `listRecoveryRows`）**不发**，宿主若要察觉只能自己查 store 有没有实现这个方法。中英同数同义（各一处括注，不增不减句）。

**②（契约能力表 EN `:2265` + CN 对应行；CHANGELOG `:9-10`）**：能力表那一行现在既写了两个前提、又把后果展开了一遍、还自称「this row points there instead of restating them」——**同一行前半段已经复述过后果，这句话本身在自相矛盾**，就是「两处真相」。改成：只留两个前提（持久化开着、且 store 实现了 `clearRecoveryRows`）+ 一句指向「条件缺任何一个的后果与宿主义务见「runId 生命周期」段」，把后果的展开（旧行还在盘上 / 连诊断都不发 / 只许永不续跑否则换 ID）删掉。生命周期段是唯一写全后果的地方，不动。CHANGELOG 那对条目同处理：收成一句 + 指向，不新增配对条、粗体标题里不套 `**`，配对地板保持 32。

**③（`src/loop/orchestrator.js:2248-2249` 注释）**：补一句限定 —— 这一清只在持久化开着（`persistence` 非 `"none"`）时才会走到，因为 `persistClassified` 第一行按 `persistenceRequired` 短路。**注释改动，代码一个字不动**。

**④（`src/store/file.js:515-516` 注释）**：同 ③ 的限定（「引擎在 `resume !== true` 的 fresh start 调一次」这句话加上「且持久化开着」的前提），**注释改动，代码一个字不动**。

## 未验证

（收尾时填，保持最后一格）
