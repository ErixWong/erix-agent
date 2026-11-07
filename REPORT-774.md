# REPORT-774 — issue #774：闸/用例的判定不许依赖 runner 的 Node 版本

分支 `fix-261108-11-reporter-pin-erix`，基点 `855d6ff`。不 rebase、不 push、不开 PR。

## 取证边界

**这一格在第一笔 commit 之前写好**（本节写完时才动手改代码），后面每一格只在做过对应实测之后追加数字。

### 我在哪台机器上取证

| 项 | 值 | 我怎么知道的（命令） |
|---|---|---|
| 工作树 | `/home/eric/wt-774e` | `cd /home/eric/wt-774e && pwd`（每条命令都在这个 cwd 跑） |
| 分支 / 基点 | `fix-261108-11-reporter-pin-erix` @ `855d6ff` | `git status --short && git log --oneline -3 && git branch --show-current` |
| 起点 epoch | `1794092200` | `date +%s`（与「第一笔 commit 在第 4 分钟之前」对照） |
| Node 22（默认 `node`） | `v22.23.2` | `node -v` |
| Node 24 | `v24.19.0`，在 `~/.local/node24/bin/node` | `~/.local/node24/bin/node -v` |

### 取证口径（本报告的每个数字都要满足）

1. **每个数字指回一条我真跑过的命令**；报告里写「实测 X」的必须能贴出命令与退出码。
2. **两个 runner 都算数**：凡判定类结论一律 `node`（v22.23.2）与 `PATH=~/.local/node24/bin:$PATH node`（v24.19.0）各跑一遍，分别记 exit 码；只跑一个 runner 的结论要标明是哪个。
3. **未判定 ≠ 绿**：本仓既有口径（`check:test-summary` / `check:changelog` 一类读不出真值按设计 exit 2）。报告里「exit 2」不许写成「通过」。
4. **不抄主会话的数**：任务书里 `762ef52` 时测的那组（Node22 6/6 绿 / Node24 5/6 红）在 `855d6ff` 上**复测**后才写进本报告，两者不一致时以本树实测为准并写明差异。
5. 派生值边界：**`BARE_LINE_REF_BASELINE` 不动**、**`test/test-suite-baseline.json` 不动**（TAP 基线由主会话在合并树现取，我只报告新增了几格用例）；配对地板只按守卫自报值。

### 边界之外（我不碰的）

- `/home/eric/wt-774w`（同单对照树）与其它 `~/wt-*`：不读不写不比较。
- 不 rebase / 不 push / 不开 PR；`npm test` 全套不在我的闸清单里（主会话跑），我一条都不跑全套。
- 不读密钥 / `.env`。

## 现场复测（`855d6ff`，改代码之前）

（待追加）

## 改了什么

（待追加）

## 未验证

（待追加）

## 实测追加（M2–M5，每条都是本机跑过的命令）

### 反向证①：同一份文件在两个 runner 上都全绿
- `node -v` = v22.23.2；`node --test test/loop-snapshot-round-residue-735.test.js` ⇒ exit 0，`# tests 10 / # pass 10 / # fail 0`（Node 22 默认就是 TAP）
- `PATH=~/.local/node24/bin:$PATH node --test test/loop-snapshot-round-residue-735.test.js` ⇒ exit 0，`ℹ tests 10 / ℹ pass 10 / ℹ fail 0`（Node 24 默认是 spec，同一份文件照样全绿）
- 同一文件在 Node 24 上 `--test-reporter=tap` ⇒ exit 0，`# tests 10 / # pass 10 / # fail 0`；Node 22 上 `--test-reporter=spec` ⇒ exit 0，`ℹ tests 10 / ℹ pass 10 / ℹ fail 0`
- 用例数：`git show 855d6ff:test/loop-snapshot-round-residue-735.test.js | grep -c '^test('` = 6，现树 `grep -c '^test('` = 10 ⇒ **本单在这个文件里新增 4 格**（TAP 日志里的 `ok 6`–`ok 9`），全套 `npm test` 因此 +4；`test/test-suite-baseline.json` 一格未动（`git diff 855d6ff --stat -- test/test-suite-baseline.json` 空输出）。

### 反向证②：把被变异那一侧改回「不该红」⇒ 变异用例必须红并点名 ③
- 做成用例而非手工：`ok 6 - \#774 反向证 · 被变异那一侧改回「不该红」⇒ ④a 必须红，且红在点名 ③ 上`（Node 22 与 Node 24 都是 ok）。它断言的是子进程输出里 `/^not ok .*③ 快照里不再有锚点之前那段前缀/um` **那一格**加上退出码非 0，没有退化成只看退出码。
- `ok 7 - \#774 反向证 · 子进程 reporter 不是 TAP ⇒ 判「未判定」，既不判绿也不把读不到当红`：喂 ④a 一份 spec 形状的副本输出 ⇒ 判未判定。
- `ok 8`：整份文件在当前 runner 全绿，且把默认 reporter 换成 spec 也全绿；`ok 9`：机器上有 Node 24 时用它跑整份文件必须全绿（没有 Node 24 时这格自己 skip）。

### 第 2 面：`check:test-summary` 对两种 reporter 各一份（同一棵树、同一份登记表 expect.tests=3712）
- `npm run check:test-summary --silent -- --log /tmp/774e-n22-tap.log` ⇒ **exit 1**，`TEST-SUMMARY tests=10 pass=10 fail=0 skipped=0 todo=0 cancelled=0 source=/tmp/774e-n22-tap.log:64` + `TEST-SUMMARY-VERDICT red codes=TESTS_DRIFT`（TAP 被认出、真的去对账；单文件日志低于登记值 ⇒ 判红是正当判定，不是格式问题）
- `-- --log /tmp/774e-n24-tap.log` ⇒ **exit 1**，同一行 `tests=10`、同 `codes=TESTS_DRIFT` ⇒ Node 22 与 Node 24 产出的 TAP 日志走同一条判定
- `-- --log /tmp/774e-n22-spec.log`（Node 22 上 `--test-reporter=spec`）⇒ **exit 2**，`TEST-SUMMARY-VERDICT unreadable codes=NO_SUMMARY,NOT_TAP_LOG`
- `-- --log /tmp/774e-n24-default.log`（Node 24 的默认输出，spec）⇒ **exit 2**，同上两个码 ⇒ 未判定 ≠ 绿，也没有报成回归
- `-- --log /tmp/774e-n24-npmtest.log`（Node 24 下 `npm test -- test/loop-snapshot-round-residue-735.test.js`；因为 `package.json` 的 `test` 现在钉了 `--test-reporter=tap`，日志是 TAP）⇒ **exit 1** 且 `tests=10` 被正常读出 ⇒ 钉 reporter 之后 Node 24 的 `npm test` 日志仍能被对账
- 两个码同时出现的原因：spec 打的是 `ℹ tests` 而不是 `# tests`，所以既「读不到 TAP 汇总块」（NO_SUMMARY）又「形状被认出是 spec」（NOT_TAP_LOG），合起来报的就是「未判定 / 这份日志不是 TAP」。

### CI 要能看见（改前先读了 `docs/maintenance/command-reference.md#ci`）
- `.github/workflows/ci.yml` 矩阵 `node: [22]` → `[22, 24]`；`check:release` 仍锁 `if: matrix.node == 22`（那格护栏从今天起才真的在做事）；**没有任何一步被设成 `continue-on-error`**。
- 24 那一格会碰到的其它 reporter 相关面，本地实测：`PATH=~/.local/node24/bin:$PATH node --test --test-reporter=tap test/static-guards.test.js` ⇒ exit 0，`# tests 58 / # pass 58 / # fail 0`；`PATH=... node scripts/suite-summary-reconcile.mjs --self-test` ⇒ exit 0（19 例）；`PATH=... node scripts/mutation-sample-check.mjs --self-test` ⇒ exit 0（26 例，含新增的 R1b「把 argv 里的 tap 换成 spec ⇒ 当场红并点名 argv」）；`node scripts/mutation-sample-check.mjs --verify test/mutation-samples.md` ⇒ exit 0。

### 闸清单（本轮全绿）
- `node --test test/loop-snapshot-round-residue-735.test.js`：Node 22 exit 0（10/10）、Node 24 exit 0（10/10）
- `node --test test/static-guards.test.js`：Node 22 exit 0（58/58）；Node 24 加 `--test-reporter=tap` 同样 58/58
- `npm run check:docs` ⇒ exit 0（`docs-drift-check: OK … 126 项对齐`、`docs-sync-check: OK — 中英契约标题结构对齐（115 节）`）；`npm run check:docs:strict` ⇒ exit 0（`--strict: OK — 0 处红`）；`npm run check:docs-spelling` ⇒ exit 0（同 `--strict: OK — 0 处红`）
- `npm run check:syntax` ⇒ exit 0（全量 494 个跟踪的 `.js/.mjs/.cjs` 过 `node --check`）
- 派生值：`test/static-guards.test.js` 一字未动（`BARE_LINE_REF_BASELINE` 仍是 11，`git diff 855d6ff -- test/static-guards.test.js` 空）；`test/test-suite-baseline.json` 一字未动，新增格数 = 该文件 **+4**（报告见上）。

## 未验证
- **`npm test` 全套**（3712+4 格）在 Node 22 / Node 24 下是否全绿，以及一份**全量** TAP 日志喂给 `check:test-summary` 是否 `TEST-SUMMARY-VERDICT ok`：按任务口径本轮不跑全套，只跑了单文件日志与 `--self-test`（后者用合成夹具覆盖 ok 路径）。
- **CI 真跑**：矩阵 24 那一格在其余测试文件上是否还有别的 reporter 类红，本地只实测了 `test/static-guards.test.js`、两个 `--self-test`、`mutation-sample-check --verify` 这四条；CI 上的 `Test suite` + `check:test-summary` 两步顺序与退出码只能等真 CI。
- Node 24 下 `npm test` 的**全量**日志形状：只实测了 `npm test -- <单文件>` 这一条路径是 TAP。
