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
