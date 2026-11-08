# 报告 #781（把 worker #774 版里两处更好的改法并进来）

分支 `fix-261109-03-spec-observe-erix`，基点 = 主干 `4f9b908`。两笔里程碑提交：

- ① `b7c5e15` feat(#781 ①)：汇总闸喂 spec 日志时多报一行「只报数、不判定」的 `TEST-SUMMARY-SPEC` 观测
- ② `57e2bc5` docs(#781 ②)：收紧 `release-real-check.mjs`「取不到汇总」的注释口径（只改注释）

## 取证边界

实际打开/读取过的路径（均可打开，无 BLOCKED）：

- **工单全文**（派单时从仓外的派单目录副本到本目录，收尾按工单要求删除 ⇒ **它在仓里解不到，这是事实而不是漏写**）
- **工单随附的参考补丁**（仓外抽出后副本到本目录，收尾按工单要求删除 ⇒ 仓里同样解不到）
- `scripts/suite-summary-reconcile.mjs`（**全文分段读完**：常量区、`runReconcile`、CASES 表 A1–A19、`runSelfTest`、CLI/`main`）
- `scripts/release-real-check.mjs`（头注释 + `STEPS`/`childEnv()`/`spawn` 区段 readFile；其余 grep）
- `docs/maintenance/command-reference.md`（第 27 行）、`docs/maintenance/command-reference_cn.md`（第 24 行）
- `package.json`（grep `test` / `check:release:real` / `--test-reporter`）
- `.github/workflows/ci.yml`（grep `release:real` / `test-reporter`）
- `scripts/mutation-sample-check.mjs`、`scripts/release-check.mjs`（grep reporter 钉法 + R1/R1b）
- `test/test-suite-baseline.json`（grep `test-reporter`；登记值经 `--self-test` P1 读到 `tests=3743 fail=0 maxSkipped=16`）
- `.npmrc`（`cat`：仓库根**无**此文件）
- 现造判据日志 `/tmp/spec-781.log`、`/tmp/tap-781.log`（本次生成）
- Node 24 探针 `/home/eric/.local/node24/bin/node`（实测裸 `node --test` 交回的形状）

## 改了什么、为什么

### ① `scripts/suite-summary-reconcile.mjs`（加观测行，只报数不判定）

- 新增常量 `export const SPEC_OBSERVED_PREFIX = "TEST-SUMMARY-SPEC";`，与 `EXPECTED_PREFIX`/`VERDICT_PREFIX` 并排。
- 新增 `formatSpecObservedLine(values, source)`，产 `TEST-SUMMARY-SPEC tests=… pass=… fail=… skipped=… source=<路径>:<行>`。
- 在 `runReconcile` 的 spec 分支（`summary` 为 null 且认出 spec 汇总那条路）**数组末尾**追加这一行——不动 `lines[0]/lines[1]`（`$GITHUB_STEP_SUMMARY` 取这两格），verdict 行 `unreadable codes=NO_SUMMARY,NOT_TAP_LOG` 与退出码 `EXIT.UNREADABLE` **一字未动**。
- **红线守住**：spec 日志仍 exit 2，**没**改成 0/1；**没**拿 spec 数字去比登记值（仍走 `NOT_TAP_LOG` 未判定，主干 #774 那条路没回退成 REF 版的 `undetermined/SPEC_REPORTER_LOG`）。
- 自检加 **A20/A21/A22** 三格（`MIN_SELF_TEST_CASES` 19→22），写进既有 `CASES` 那一族，未新建 `test/*.test.js`。

**措辞坑（工单顶栏第 3 条）已按字面成立处理**：注释/文档写的是「观测行**不带**判定行的两个后缀 `VERDICT`/`EXPECTED`，所以 `grep '^TEST-SUMMARY-VERDICT'` 只数到未判定那一条」，**没有**写「故意不以 `TEST-SUMMARY` 开头」这种字面假话（`TEST-SUMMARY-SPEC` 本身就以它开头），并在 A20/A22 配了可验断言。

### ② `scripts/release-real-check.mjs`（只改注释）

REF 里那句「#774 已把 reporter 钉死、runner Node 版本不再是借口、由 `test/tap-reporter-pin-774.test.js` 逐字钉住」对**本文件不字面成立**（该测试文件在本仓不存在；本文件 `STEPS` 的 7 条 argv 全是裸 `["--test", …]`；`check:release:real` 直接 `node` 本脚本、不走 `npm test`；CI 只跑离线 `check:release`）。照抄=写假话。按现树现状重写：第 7 条是设计上唯一「该取不到汇总」的一条；本文件其余各条读回 `?` 属 reporter 形状问题，而这条口子 #774 **没替本文件闭**（要闭得给每条 argv 加 `--test-reporter=tap`，参照 `mutation-sample-check.mjs` 的钉法+R1/R1b，属逻辑改动，本单不动）。`STEPS` argv 与所有逻辑一字未动（diff 仅 `//` 注释，已用 `git diff | grep -v '^//'` 证明为空）。

`docs/maintenance/command-reference.md` 与其 `_cn` 各加一句登记这行新输出（口径变化，中英两份同步）。

## 判据（每条抄现报原文）

跑前 `find src -name '*.d.ts' -delete`。

```
$ node --test --test-reporter=spec test/loop-snapshot-round-residue-735.test.js > /tmp/spec-781.log 2>&1   # exit 0
$ node scripts/suite-summary-reconcile.mjs --log /tmp/spec-781.log; echo "exit=$?"
TEST-SUMMARY-VERDICT unreadable codes=NO_SUMMARY,NOT_TAP_LOG
  · **日志不是 TAP**：认出的是 **spec reporter** 的汇总（`ℹ tests …`）——Node 24 起 `node --test` 的默认就是 spec，而本判据只读 TAP 的 `# tests` / `# pass` / `# fail` / `# skipped`
  · **未判定 ≠ 绿，也 ≠ 回归**：spec 那一侧现读到 tests=10 pass=10 fail=0 skipped=0（source=/tmp/spec-781.log:12），但拿它去比 TAP 登记值只会把「runner 换了默认 reporter」误报成掉用例 / 红用例
  · 重跑要钉住形状：`npm test`（本仓已钉 `--test-reporter=tap`）或 `node --test --test-reporter=tap …`，再把那份日志喂给本脚本
TEST-SUMMARY-SPEC tests=10 pass=10 fail=0 skipped=0 source=/tmp/spec-781.log:12
exit=2                          # 仍 exit 2（未判定）✓，且多一行 TEST-SUMMARY-SPEC ✓
$ … | grep -c '^TEST-SUMMARY-VERDICT'   # ⇒ 1（只有未判定那一条，观测行没被吃掉）✓
$ … | grep -c '^TEST-SUMMARY-SPEC '     # ⇒ 1 ✓
```

```
$ node --test --test-reporter=tap test/loop-snapshot-round-residue-735.test.js > /tmp/tap-781.log 2>&1   # exit 0
$ node scripts/suite-summary-reconcile.mjs --log /tmp/tap-781.log 2>&1 | grep -E '^TEST-SUMMARY|^TEST-SUMMARY-VERDICT'
TEST-SUMMARY tests=10 pass=10 fail=0 skipped=0 todo=0 cancelled=0 source=/tmp/tap-781.log:64
TEST-SUMMARY-EXPECTED tests=3743 fail=0 maxSkipped=16 registry=test/test-suite-baseline.json
TEST-SUMMARY-VERDICT red codes=TESTS_DRIFT
  ✗ TESTS_DRIFT: tests 10 < 登记值 3743（-3733）——少的那些用例就是掉了覆盖…
tap exit=1                      # 真对账、造漂移 ⇒ exit 1 + codes=TESTS_DRIFT ✓
$ … | grep -c '^TEST-SUMMARY-SPEC '     # ⇒ 0（TAP 路径不出现观测行）✓
```

（说明：这份小 TAP 日志的单文件计数 10 对登记值 3743 天然差 3733，是**预期的登记值不匹配**，不是回归；工单亦言「小日志对账时登记值不匹配是预期的」。）

### 脚本自检面（`--self-test`，本脚本确实叫这个名）

```
$ node scripts/suite-summary-reconcile.mjs --self-test
…
✓ A20（spec 日志 ⇒ 额外多一行…TEST-SUMMARY-SPEC 观测行，且 ^TEST-SUMMARY-VERDICT 仍只有未判定那一条）→ exit 2
✓ A21（真 TAP 日志 ⇒ 不出现 TEST-SUMMARY-SPEC 观测行）→ exit 0
✓ A22（反向证专格：…^TEST-SUMMARY-VERDICT 只有一条单独拿 rejectLines 顶住…）→ exit 2
✓ W1 / S1 / P1 …
suite-summary-reconcile --self-test: OK — 22 例反向证/放行证 + 接线 + 登记表 + 无 --sync 全部按预期
```

### 反向证（观测前缀临时改成 `TEST-SUMMARY-VERDICT` ⇒ 相关格变红，证它真在管前缀、不是恒绿）

```
$ sed -i 's/"TEST-SUMMARY-SPEC"/"TEST-SUMMARY-VERDICT"/' scripts/suite-summary-reconcile.mjs   # 临时
$ node scripts/suite-summary-reconcile.mjs --self-test 2>&1 | grep -E 'A20|A21|A22|失败'
  ✓ A21（…）→ exit 0                                  # TAP 路径不受影响
  ✗ A20（…）：未命中 /^TEST-SUMMARY-SPEC tests=3265 pass=3253 fail=0 skipped=12 source=<memory>:\d+$/u
  ✗ A22（…）：出现不该出现的行（命中 /^TEST-SUMMARY-VERDICT (?!unreadable codes=NO_SUMMARY,NOT_TAP_LOG$)/u）
失败 — 2 处未达预期（共 22 例 + 接线/登记表/无 --sync 3 项）
$ sed 还原 ⇒ self-test 回到 22/22 OK
```

A22 的红**正落在 rejectLines 那条「判定行只有一条」断言上**（工单点名要的那条），A20 的红落在观测行 expectLines 上，两者都证这条纪律真的在管前缀。

### Node 24 裸 reporter 探针（②取证依据）

```
$ /home/eric/.local/node24/bin/node --test t781-probe.test.js | tail
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 94.356645
```
（无 `# tests`、无 `# SKIP` ⇒ Node 24 裸 `node --test` 交回 spec 形状，坐实 ② 的注释结论。）

## 其余闸（本地跑，全绿；全量 `npm test` 未跑，主会话复跑）

- `check:syntax`：OK — 全量 496 个跟踪文件 `node --check` 全过
- `node --test test/static-guards.test.js`：**58 / 0**（要求 58/0 ✓）
- `check:types`：OK — 实测 102 / 26 文件 = 基线 102（未抬）
- `check:types:strict`：OK — 实测 1887 / 72 文件 = 基线 1887（未抬）
- `check:docs-spelling`：OK。**但 `check:docs` / `check:docs:strict` 本报告自己红过一次**（主会话复跑时才发现，上面那句「落盘后消解」是错的）：`archive-refs` 不接受**克隆后解不到的裸文件名**，而本报告早期版本把派单文件与参考补丁写成了裸文件名（现报：`✗ archive-refs: REPORT-781.md 引用了克隆后不存在的本机档案或无法裁决的裸文件名`）。**不是闸错，也不是「非本单引入」**——红就在本仓已提交的这份报告里。已改成不带裸文件名的说法并写清「仓外件在仓里解不到」，**三道闸由主会话在修正后重跑**（现报见下面「主会话复跑」）。

## 主会话复跑（修正本报告裸文件名之后）

- 每里程碑各一笔（①/② 各一次 commit），未攒到最后。
- 未 push、未开 PR、未动别的目录。
- 未动 `test/test-suite-baseline.json`、未动 `type-check-ratchet.mjs` 的基线常量（types/strict 实测等于基线即证未抬）。
- 新断言加在脚本内 `CASES` 族，未新建 `test/*.test.js`。
- 参考补丁副本收尾前删除、不进提交；工单副本按既往惯例（派单文件从不入库）也不提交。

## 未验证

- **全量 `npm test` 未跑**（工单言主会话复跑）；`test/test-suite-baseline.json` 的登记值由主会话在合并树上重取，本单未动它，故 `npm test` 全量的 tests/skipped 读数不在本地复现。
- ②的「在 Node 24 上真跑本清单，其余各条会整批落进 spec、全部写 `?`」是**推断**：由 Node 24 裸 `node --test`=spec 的实测 + 读 `childEnv()`/`runStep`（确认无 reporter 注入）得出，**没有**真的在 Node 24 上开着 `ERIX_E2E_REAL=1` 跑一遍 `check:release:real`（要真上游+成本，且闸门关时它 exit 0 不跑步骤）。
- `--self-test` 的 22 例与 `static-guards` 58/0 是在**本环境 Node v22.23.2** 上跑的；未在 Node 24 上单独复跑（self-test 用合成夹具、reporter 无关，预期不受 runner 影响，但未实测）。
- 观测行的行号（`source=<路径>:<行>`）取的是 spec 汇总块首行的 1-based 行号；跨多段 spec 汇总时用 `pick` 选中的那段，未专门构造多段 spec 日志测 `--pick largest` 下的观测行（沿用 `pickSummary` 既有语义）。
- 主会话若在别处（如给 release-real-check 逐条加 argv 钉）另有决策，与本单「②只改注释」边界不冲突，但未在本地体现。
