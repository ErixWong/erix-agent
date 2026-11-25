# REPORT-905 — 删掉 check:test-summary 整条数字基线闸（删闸，不是修闸）

工单：WO-37.md（分支 chore-261126-37-kill-test-summary-baseline）
裁决：GitHub issue #905 —— 整条机制删除，真判据只留 npm test 的退出码。

## 取证边界

- **这是一次删闸**：删除 npm test 汇总数（tests/pass/skipped）对着派生登记表逐项比对的整条机制。
  登记表基线现值 expect {tests:3971, fail:0, maxSkipped:18}、observations 124 条，均为删除对象。
- **这道闸在基点上当前不红**（不是"它坏了"）：主 agent 在基点实测 npm test = 3971/3958/0/13，
  且 suite-summary-reconcile 的判定为 TEST-SUMMARY-VERDICT ok。它的问题是**书计负担**——并行的
  commit af90d95f 整笔内容就是"删了 21 格闸测试后把数字重登一次"。
- **锚点偏差（据实纠正，已在 changelog-coverage-check.mjs 内注释与 commit 信息据实记）**：工单
  建议把 changelog 接线定位锚点换成 ci.yml 里"真实在场"的 run: npm run check:docs。实测 ci.yml
  **根本没有 check:docs 步**（issue #802 已把 docs 整族移出 CI，只剩 real / registries 两个 job）。
  把锚点定在一个不在场的步上会重演 #855 恒红，故改锚 ci.yml 里**真实在场**且由 #905 明令保留的
  Test suite 步 run: npm test（ci.yml 第 84 行）。**判据语义强度不降**：仍要求该阻塞步存在 +
  check:changelog 排在它之后（位置判据），⑧/⑧d 自测夹具同步改，--self-test 19 条判据全绿。
- **本地唯一红 = 未追踪的工单自身**：docs-drift-check 的 archive-refs 规则会扫工作树里所有 .md，
  工单 WO-37.md 第 18 行以反引号裸名引用了已删的 suite-summary-reconcile.mjs，删后该引用变悬空
  → docs-drift exit 非 0 → 连带把把 docs-drift 当子进程调的两个 #286 棘轮测试（test/
  docs-anchor-ratchet.test.js）一并判红。WO-37.md **未被 git 追踪**（git status 显示 ??），
  CI clone 不含它，故这些门禁在 CI 语境下全绿。已用"临时把 WO-37.md 移开"复验全部转绿。
- **不做变异探针**（删一格仍绿 / 让一格真失败必红）由主 agent 负责，本报告未做。

## 基点

abf86325

（git rev-parse --short HEAD 在基点的输出原样行；abf86325 = 分支基点，Merge pull request #912。）

## 结论

### 两笔 commit

- M1（删闸本体）：86cef678 — 6 files, +27 / -2799
- M2（文档退账）：0fcd1191 — 9 files, +21 / -32

### git diff --numstat abf86325..HEAD 原文（两笔合并 vs 基点）

```
5	16	.github/workflows/ci.yml
1	1	AGENTS.md
2	2	AGENTS_cn.md
2	0	CHANGELOG.md
8	9	docs/maintenance/command-reference.md
6	8	docs/maintenance/command-reference_cn.md
0	1	docs/maintenance/doc-review-pass.md
0	1	docs/maintenance/doc-review-pass_cn.md
1	5	docs/testing.md
1	5	docs/testing_cn.md
0	1	package.json
20	15	scripts/changelog-coverage-check.mjs
0	960	scripts/suite-summary-reconcile.mjs
2	2	test/examples/pi-web-liveness-contract.test.js
0	1805	test/test-suite-baseline.json
```
合计：48 行新增 / 2831 行删除（15 个文件）。

### 删掉的行数 / 字节数（M1 git rm 的整文件精确量）

- scripts/suite-summary-reconcile.mjs：960 行 / 49,628 字节（对账脚本，整删）
- test/test-suite-baseline.json：1805 行 / 179,468 字节（派生登记表 + 124 段 why 观测散文，整删）
- 两文件合计：2765 行 / 229,096 字节（约 175 KiB）
- 另有 package.json 的 check:test-summary 一行、ci.yml 两步 + 一条读 ci 验证接线的注释随之删（计入上面 numstat）。

### 每条命令退出码与关键行

CI 语境（把未追踪的 WO-37.md 移开后跑，等价于 fresh clone）：

| 命令 | 退出码 | 关键行 |
|---|---|---|
| npm test | 0 | `# tests 3971` / `# pass 3958` / `# fail 0` / `# skipped 13`，`^not ok` 计数 0 |
| npm run check:docs | 0 | `docs-drift-check: OK — 版本/默认值/清单（含中英逐处对账）/模块地图/路径/中英骨架共 136 项对齐 … 0.34.0`；`docs-sync-check: OK — 中英契约标题结构对齐（117 节）` |
| npm run check:docs:strict | 0 | `docs-drift-check: OK`（--strict） |
| node scripts/changelog-coverage-check.mjs --self-test | 0 | `19 条判据全部按预期`；含 ✓⑧（阻塞步存在且在 npm test/Test suite 之后）与 ✓⑧d（把 check:changelog 挪到 run: npm test 之前仍点名 ⇒ 换锚后位置判据仍活着，非"存在就好"） |
| node --check scripts/changelog-coverage-check.mjs | 0 | （无输出，语法 OK） |
| node scripts/agents-directive-scan.mjs --sync … | 0 | `改动 0 格`（派生格未被触碰，该脚本未改） |
| npm run check:agents-directives | 0 | `AGENTS.md 实测 12562 / 预算 13824`、`AGENTS_cn.md 实测 12372 / 预算 13824`，总判词：绿 |
| npm run check:changelog | 0 | `changelog-coverage: OK — 0.34.0 段覆盖了 v0.33.0..v0.34.0 里每一个碰到公开面的合并号（命中 9 / 豁免 0 / 缺项 0）` |

本地语境（WO-37.md 留在工作树时）两条会红，**同一根因 = WO-37.md:18 悬空裸名**：

- npm run check:docs → 1：`archive-refs: WO-37.md 引用了…裸文件名（1 处）：suite-summary-reconcile.mjs（第 18 行）：本仓不存在 …`
- npm test → 1（fail 2）：#286 docs-anchor-ratchet 两格因把 docs-drift 当子进程调、拿到上面那条 exit 非 0 而连带失败。
  移开 WO-37.md 后两者均转绿（见上表）。这两条不是我的改动造成的回归。

### grep -rn 残留清单（必须只剩历史档案）

全仓 grep -rn "check:test-summary|suite-summary-reconcile|test-suite-baseline"（排除 node_modules/.git/我的 .scratch）：
命中文件**全部**是历史档案或工单自身——WO-37.md（工单，14 处）、CHANGELOG.md（历史 + 我新增的 [Unreleased] 一条）、
根目录 REPORT-*.md（历史交付报告）、delivery/*.md（历史台账）。
**活引用面（package.json / .github / scripts / test / docs / AGENTS.md / AGENTS_cn.md）零命中**——
即 WO 规定的权威作用域 grep 退出码 1（无任何命中），残留已清干净。
- CHANGELOG.md 的命中含我 M2 新增的一条（它按 Keep-a-Changelog 规则**必须点名**被删的脚本与登记表）；
  CHANGELOG.md 已被 docs-drift 的路径存在性判据排除（历史类"当时为真"），故点名已删文件不触红。
- 本报告的取证边界说明里，被删的脚本名/登记表名以**纯文本**出现（未加反引号、未前置 node），
  正是为避免被 docs-drift 的引用提取器当作悬空路径引用。

## 未验证

- **变异探针未做**（主 agent 负责）：删一格测试 npm test 仍绿 / 让一格真失败 npm test 必红 —— 验证 npm test
  退出码这道留下来的真判据确实有咬合，未由本报告验证。
- **GitHub Actions 实际跑动**未验证：本地以"移开未追踪 WO-37.md"模拟 fresh clone；未推送到远端、未观察真实 CI run。
- ci.yml 的 npm test 步撤掉 tee/set -o pipefail 后，仅"日志被下游对账消费"这一用途消失；npm test 本身仍在
  real job（第 84 行，阻塞）跑——CI 实跑层面的等价性未端到端验证。
- 基点上 npm test 的精确数字（3971/3958/0/13）取自主 agent 实测与本仓复验；未在"未删任何文件"的原始基点
  重跑（M1 已 git rm，重跑会得不同值）。
- 工单 WO-37.md 自身的悬空引用（其第 18 行）我**未修改**（它不在允许改的文件清单内，且属工单/交接现场）；
  恢复坐标与是否需在 issue 台账登记由主 agent 决定。
