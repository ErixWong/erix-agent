# 689 — 发版日收敛成一条命令（`npm run release:day`）

分支 `feat-261103-04-release-day-689`，基点 main `9b370df`，工作树
`/home/eric/projects/worktrees/erix-689`。实施分五个提交，本报告每一节对应实测证据，不写「应该」。

## 取证边界

实际打开 / 读取过的路径（全部在本工作树内，全部可读；**没有**打不开的路径，因此没有 `BLOCKED:` 条目）：

- 门禁与脚本：`scripts/docs-drift-check.mjs`（读了 §1 版本声明、§17/§18 发布态与发布行判据、`--self-test`
  尾部与 CLI 尾部，改了三处）、`scripts/release-check.mjs`（只读：确认它自己清理 `prepack` 生成的
  `src/**/*.d.ts`）、`scripts/guide-removal-gate.mjs`（只读：CLI 与自测的写法范式）、
  `scripts/host-consumer-probe.mjs`（只读：`--hosts` 的分类口径 `HOST_DIR_MISSING` / `HOST_DIR_NOT_DIR`）、
  `scripts/agents-directive-scan.mjs`（只读：A 类状态词表 `STATUS_RE`）、`scripts/suite-summary-reconcile.mjs`
  （经 `npm run check:test-summary` 调用）、`scripts/type-check-ratchet.mjs`（只读：基线常量与提示）
- 新建：`scripts/release-day.mjs`、`test/release-day.test.js`、本报告
- 改动：`scripts/docs-drift-check.mjs`、`package.json`、`AGENTS.md` / `AGENTS_cn.md`、
  `.github/workflows/ci.yml`、`test/test-suite-baseline.json`
- 只读文档：`README.md` / `README_cn.md`、`docs/requirements.md` / `docs/requirements_cn.md`、`CHANGELOG.md`、
  `docs/host-consumer-contract.md` / `docs/host-consumer-contract_cn.md`（grep 过发版口径，见 §6）
- git 只读：`git blame --porcelain -L 3,3 -- package.json`、`git show <sha>:package.json`、
  `git diff --quiet 1e3a277 2fe4424 -- src bin package.json`、`git tag -l --format=…`（`v0.30.0` 的附注正文）
- 临时树（全部在 `os.tmpdir()` 下，跑完删除）：`/tmp/689-smoke`、`/tmp/689-smoke2`、
  `/tmp/689-wb-real`（一个**真 git 仓库**，用来实跑 writeback 的 `git commit -a` 那一半）、
  `--self-test` 自己建的 `erix-release-day-*` 合成树
- 日志：`/tmp/689-sync-a.log`（`--sync` 有 `--published` 的实测）、`/tmp/689-sync-b.log`（不给 `--published`）、
  `/tmp/689-npm-test.log`（`npm test` 全量 TAP）、`/tmp/689-gates.txt`（26 条判据的逐条退出码）、
  `/tmp/689-drift-selftest.log`、`/tmp/689-release.log`
- 没有打开的东西（刻意）：`~/.npmrc`、`~/.erix/**`（`--self-test` 与测试都只碰合成树）、
  `/home/eric/projects/erix-llm-kit`（任务红线：不许动）、真实 npm registry（离线口径）

## 设计：四个阶段 + 一个可续跑的状态机

`scripts/release-day.mjs`（`npm run release:day`）把发版日拆成 `preflight → publish → writeback → finalize`，
`--all` 按序走，`--dry` 什么都不改。**唯一的版本真值是 `package.json`**，唯一的发布态真值是
`--published <x.y.z>`（CI 上没有 registry，离线自测不许联网）。

| 阶段 | 做什么 | 红 / 未判定时的退出码 |
|---|---|---|
| `preflight` | 按顺序跑 AGENTS §4 的五步（`check:docs` → `check:docs:strict` → `ERIX_E2E_REAL=1 check:release:real` → `check:release` → `check:host-consumers -- --hosts …`），**任一红就停在那一步并点名第几步** | 红 = 1；有步骤没判定 = 2 |
| `publish` | 只打印操作单（四条坑 + 两条续跑命令），**不 fork `npm publish`** | 等你发布 = 3 |
| `writeback` | `docs-drift-check --sync` → `git commit -a`（只提交回写动过的已跟踪文件）→ **立刻重跑 `check:docs`** | 任一红 = 1；缺 `--published` = 2 |
| `finalize` | 清 `src/**/*.d.ts` → 打附注 tag `v<版本>`（指向切版提交）→ `git push origin main` / `git push origin <tag>` → 两个远端 URL 各 `git ls-remote` 现验 → 再跑 `check:docs` / `check:docs:strict` | 任一红 = 1；双推没法互验 = 2 |

**「未判定」是一个独立的裁决，不是绿。** 实测（真树，闸门关着、没给 `--hosts`）：

```
[3/5] ERIX_E2E_REAL=1 check:release:real → **未判定**（ERIX_E2E_REAL 未开：真上游那一族在闸门关着时一步都不跑）
[4/5] check:release → 绿
[5/5] check:host-consumers -- --hosts … → **未判定**（没给 --hosts：探针不给目录时只打印口径并 exit 0，那是「未判定」不是绿）
preflight → **未判定**（2 步没跑：release-real, host-consumers）——发布前置没有全绿，这不是通过（未判定不是绿）
EXIT=2
```

给上宿主目录之后（`--hosts /home/eric/projects/fde-workshop,/home/eric/projects/touwaka`）第 5 步真跑且绿，
第 3 步仍是未判定 ⇒ 整体仍 `EXIT=2`。**这是刻意的**：真上游那一族不跑，就不许报绿。

### 为什么脚本不自己 publish（照 AGENTS §4 的坑写死）

`publish` 阶段的产物是**一张给人看的操作单**，不是子进程。四条坑逐条打在操作单里：npm 12 在
`~/.npm-global/bin/npm` 且被 `/usr/bin/npm`（10.x）遮蔽（必须绝对路径）、每次 publish 都要独立的
device-flow 认证、非 TTY 下 URL 被打码成 `***`、**不能按 ENTER**（无桌面时 `xdg-open` 失败会把 npm 弄死，
exit 3）、成功行 `+ erix-agent@<ver>` 之后 registry 还可能滞后约 2 分钟。把这几条塞进后台 fork，等于把
「人必须在场」的那一步伪装成自动化，所以默认**不起任何子进程**（`--self-test` ⑧ 钉住：`deps.calls.length === 0`）。
`--publish-cmd <cmd>` 是显式开关，默认关，且 `--dry` 下即使给了也不跑。

## `--sync` 的窄面证明（新增的写盘能力，两态实测）

`scripts/docs-drift-check.mjs` 新增 `--sync`：**只**改下面这几处，别的一个字节都不写。

| 改哪 | 正则来自 | 真值 |
|---|---|---|
| `README.md` / `README_cn.md` 的当前发布行 | `CURRENT_CLAIMS`（门禁 §1 读的就是它） | `package.json` |
| `docs/requirements.md` / `docs/requirements_cn.md` 的两处「对照版本」 | 同上 | `package.json` |
| 两份 AGENTS 的「本仓版本」句 | `VERSION_CLAIM_RULES[*].repoRe` | `package.json` |
| 两份 AGENTS 的「发布行」句 | `VERSION_CLAIM_RULES[*].pubRe` | `--published` |
| `CHANGELOG.md` 当前版本段段首的 `（未发布 / unpublished）` | `changelog-published`（判据 3） | `--published` 是否等于本仓版本 |

**每一处都是门禁自己会读的那一处**（没有第二份措辞）：`--sync` 用的就是 `CURRENT_CLAIMS` /
`VERSION_CLAIM_RULES` 那两条正则对象本身，所以「回写写对了」与「门禁读到了」是同一个事实。
requirements 那四处**也在面内**，理由是机器性的：`check:docs` 的 `CURRENT_CLAIMS` 同样把它们对到
`package.json`，漏掉它们则「回写之后 `check:docs` 绿」这条自洽证明直接假掉。

### (a) 给 `--published 9.9.9 --version 9.9.9`（真树实测，跑完 `git checkout -- .` 还原）

```
docs-drift-check --sync: ⚠ `--version 9.9.9` 覆盖了 package.json 的 0.30.0（只给合成树 / 自测用；发版日回写不传它，版本号一律取自 package.json）
  · CHANGELOG.md 里没有 9.9.9 的版本段（`## [9.9.9]`）——发布态没有落脚处，CHANGELOG 一个字节未动（缺段由 check:docs 的 guide-coverage 判红）
docs-drift-check --sync: 回写 11 处发布态句子（6 个文件）——本仓版本 9.9.9 / 发布行 9.9.9：
  · README.md:1287 「README 当前发布行」 0.30.0 → 9.9.9
  · README_cn.md:348 「README_cn 当前发布行」 0.30.0 → 9.9.9
  · README_cn.md:697 「README_cn 当前发布行」 0.30.0 → 9.9.9
  · docs/requirements.md:5 「requirements 对照版本」 0.30.0 → 9.9.9
  · docs/requirements.md:101 「requirements §4 对照版本」 0.30.0 → 9.9.9
  · docs/requirements_cn.md:5 「requirements_cn 对照版本」 0.30.0 → 9.9.9
  · docs/requirements_cn.md:98 「requirements_cn §4 对照版本」 0.30.0 → 9.9.9
  · AGENTS.md:319 AGENTS.md「本仓版本」句 0.30.0 → 9.9.9
  · AGENTS.md:319 AGENTS.md「发布行」句 0.30.0 → 9.9.9
  · AGENTS_cn.md:214 AGENTS_cn.md「本仓版本」句 0.30.0 → 9.9.9
  · AGENTS_cn.md:214 AGENTS_cn.md「发布行」句 0.30.0 → 9.9.9
EXIT=0
```

`git diff --stat`：`6 files changed, 9 insertions(+), 9 deletions(-)`——11 处改写里有两对落在同一行
（AGENTS 那句「本仓版本 + 发布行」在同一个物理行），所以是 9 行。逐字 diff（`/tmp/689-sync-a.log` 全份）：

```diff
--- a/README.md
+++ b/README.md
-line below against it. Current release: **v0.30.0** (2026-11-03). The complete,
+line below against it. Current release: **v9.9.9** (2026-11-03). The complete,
--- a/README_cn.md
+++ b/README_cn.md
-发布行）。当前发布版本：**v0.30.0**（2026-11-03；**0.27.0 从未发布**）。下面引用的 `files` 清单以 `package.json` 为权威：
+发布行）。当前发布版本：**v9.9.9**（2026-11-03；**0.27.0 从未发布**）。下面引用的 `files` 清单以 `package.json` 为权威：
-…当前发布版本：**v0.30.0**（2026-11-03；**0.27.0 从未发布**，已发布线是 0.26.0 → 0.30.0）。完整且权威的历史见…
+…当前发布版本：**v9.9.9**（2026-11-03；**0.27.0 从未发布**，已发布线是 0.26.0 → 0.30.0）。完整且权威的历史见…
--- a/AGENTS.md
+++ b/AGENTS.md
-- Current version: `package.json` says `0.30.0` (the repo version) and the published line — npm's `dist-tags.latest` — is `0.30.0`; … `0.24.0` was **never published** …
+- Current version: `package.json` says `9.9.9` (the repo version) and the published line — npm's `dist-tags.latest` — is `9.9.9`; … `0.24.0` was **never published** …
--- a/docs/requirements.md
+++ b/docs/requirements.md
-… reconciled with the implementation shipped in version 0.30.0. …
+… reconciled with the implementation shipped in version 9.9.9. …
-… exists in package version 0.30.0. …
+… exists in package version 9.9.9. …
```

**历史句一字未动**（`0.24.0` was never published / `0.27.0 从未发布` / 「已发布线是 0.26.0 → 0.30.0」），
这就是窄面的肉眼证据；合成树上还有机器证据（`--self-test` ⑦a/⑦c 逐字节比对期望文本）。

### (b) 不给 `--published` ⇒ 一个字节都不写

```
docs-drift-check --sync: 缺 `--published <x.y.z>`——「已发布与否」没有真值（CI 上没有 registry，离线自测不许联网），
往哪一边写都是猜；**本次一个字节都没写**。发布成功之后回写请给 `--published <版本>`。
EXIT=2
git status --porcelain:
(空 = 一个字节都没写)
```

`--self-test` ⑦b 把这条钉成机器判据（合成树前后快照逐字相同 + exit 2）。另外两条同族判据：**先全部定位、
再落盘**（任一声称句读不到 ⇒ exit 2 且 0 字节写入，不做半截回写）、**幂等**（同一组参数重跑 0 字节写入，⑦d）。

### 回写之后 `check:docs` 必须绿（自洽证明）

`--stage writeback` 的第三步就是它。合成树上的 ⑦c 顺带钉住「发布态与 CHANGELOG 段首标记」这一对：
`--version 0.31.0 --published 0.31.0` 时 0.31.0 段首的 `（未发布 / unpublished）` 被摘掉、段里其余字节逐字不动
（`## [0.31.0] - 2026-11-10（未发布 / unpublished）` → `## [0.31.0] - 2026-11-10`）。这一条不是锦上添花：
判据 3 的 `changelog-published` 会红在「已发布却自称未发布」上，不回写它，回写后的 `check:docs` 就不绿。

## 失败纪律与续跑

状态文件：`$RUNNER_TEMP` / `os.tmpdir()` 下的 erix-release-day-state.json（`--state <file>` 或
`RELEASE_DAY_STATE` 可覆盖），**不入库**。四个相位 `preflight_ok → published_unwritten → written → finalized`。

- **「publish 成功但回写失败」是可恢复状态**：`writeback` 一进门先把 `phase=published_unwritten` + `published=<版本>`
  落盘；`--sync` / 提交 / `check:docs` 任一红都把它留在盘上并 exit 1，输出明确写「已发布、未回写」。
- **`--all` 重跑识别它并从 writeback 续跑**：读到 `phase=published_unwritten` 就跳过 preflight、也不再打
  publish 操作单，直接 `--sync` + 提交 + `check:docs`，然后 finalize。**脚本从不自己 publish，所以「重复发布」
  在结构上不可能发生**，续跑也不会把人再叫去发一次。
- **回写提交不许夹带别人的改动**：`writeback` 写盘前先要求 `git status --porcelain` 为空（脏 ⇒ 红、不跑
  `--sync`、不留状态文件）；`--no-commit` 可以让它只写盘不提交。
- **「tag 打出去了但文档还写着未发布」不可能发生**：`finalize` 的顺序闸要求状态文件里 `phase=written`
  （= 回写已提交 + `check:docs` 已绿）**并且**工作树干净；任一不满足就红，且一个 `git tag` / `git push` 都不跑。
  状态文件的版本也必须等于本仓版本（上一版的状态不许授权这一版的 tag）。
- 真 git 仓库上实跑过 writeback 的提交那一段（`/tmp/689-wb-real`，`scripts/docs-drift-check.mjs` 用桩替代）：

```
状态：已发布 0.31.0、**未回写** → 记进 /tmp/689-wb-real-state.json
writeback ① 回写发布态：node scripts/docs-drift-check.mjs --sync --published 0.31.0 --version 0.31.0
writeback ② 提交回写：`git commit -a -m "docs: release-day writeback — v0.31.0 发布态回写"`
[master 68ddc27] docs(#689): release-day writeback — v0.31.0 发布态回写
 1 file changed, 1 insertion(+), 1 deletion(-)
writeback ③ 回写自洽证明：`npm run check:docs`
writeback → 绿：发布态已回写、已提交、check:docs 自洽（phase=written）
```

### tag 指向哪棵树（依据）

`finalize` 用 `git blame --porcelain -L <version 行>,<version 行> -- package.json` 现读「切版提交」，
**不指向回写提交**，并额外核三条：那棵树的 `package.json` 版本 == 本版、它是 `HEAD` 的祖先、
它与 `HEAD` 在运行时面（`src` / `bin` / `package.json` / `skills`）上**逐字相同**（回写只该动文档面）。
本仓现状支持这条口径：`v0.30.0` 的附注正文自己写着「本 tag 指向**产出 erix-agent@0.30.0 tarball 的那棵树**」，
而它指的那个提交（`2fe4424`，发布分支的合并提交）与 version 行的切版提交（`1e3a277`）在
`src bin package.json` 上逐字相同（`git diff --quiet 1e3a277 2fe4424 -- src bin package.json` → 0）。

## 自测清单与条数

`node scripts/release-day.mjs --self-test`：**51 条判据**，全离线（合成树 + 假 runner），不装包、不联网、
不碰 `~/.erix` 与真实 `~/.npmrc`，跑完删临时树。任务要求的七类反向证逐条对上：

| 要求 | 自测用例 |
|---|---|
| ① preflight 某步红 ⇒ 停在那一步且点名 | ①（第 4 步红：`failedAt=4` / `failedId=release` / 第 5 步一步没跑 / 带着 exit 1） |
| ② `ERIX_E2E_REAL` 缺失 ⇒ 未判定而非绿 | ②（`release-real` = `not-judged`、整体 = `not-judged`、真上游 argv 一次没出现）；②b（`--hosts` 目录不在 ⇒ 未判定 + `HOST_DIR_*` 口径 + 探针没跑）；②c 对照组（闸开 + 目录在 ⇒ 5 步全绿） |
| ③ 回写失败 ⇒ 非零 + 状态文件留下 + 重跑能续 | ③（exit 1、`phase=published_unwritten`、`published=0.31.0`；续跑没重跑 preflight、真跑了 `--sync`、不回 exit 3） |
| ④ 跳过 publish 直接 finalize ⇒ 红 | ④（红 + 一个 `git tag` / `git push` 都没跑）、⑨（上一版状态不授权）、⑩（脏树不打 tag） |
| ⑤ 两侧 ls-remote 不一致 ⇒ 红 | ⑤（Gitea 侧 tag 落后 ⇒ 红 + 两个 URL 各查一次；对照组两侧一致 ⇒ 绿 + 双推两个 ref + 无 `--force`） |
| ⑥ `--dry` 一个字节都不写 | ⑥（合成树前后快照逐字相同、无状态文件、argv 里没有 `--sync` / `git tag` / `git push`、停在 exit 3） |
| ⑦ `--sync` 只动发布态那几句 | ⑦a（9.9.9：只改 6 个文件、逐字节等于期望文本、历史句保留、CHANGELOG 未动）、⑦b（缺 `--published` ⇒ exit 2 + 0 字节）、⑦c（段首标记）、⑦d（幂等） |

另外 ⑧（默认 publish 阶段零子进程；`--dry` 下 `--publish-cmd` 也不跑）、⑪（已 `finalized` 的 `--all`
零子进程）、⑫（切版提交与 HEAD 运行时面不一致 ⇒ 红且不打 tag）、⑬（回写前工作树脏 ⇒ 红、不跑 `--sync`、
不留状态文件）。**变异没落上一律算失败**（每条都断言
「真的改了 / 真的没跑」，不是「没红就算过」）。

命令行那一层的七格在 `test/release-day.test.js`（`--help` 四阶段与退出码 / 无参数 exit 2 / 没有 preflight
状态就 publish 的红 / writeback 缺 `--published` 且不写状态文件 / 没有状态就 finalize 的红 /
`--self-test` 绿 / npm script + 中英 AGENTS + CI 三处接线且不抄条数）。

## 接线路径

- `package.json`：`"release:day": "node scripts/release-day.mjs"`。
- `.github/workflows/ci.yml`：新增阻塞步 `Release-day command self-test`（`node scripts/release-day.mjs --self-test`），
  紧挨 `Compatibility-pin inventory verify`——同族是「提交进库的东西必须与真树对得上」。
- `AGENTS.md` / `AGENTS_cn.md`：命令表各加一行 `npm run release:day`（中英成对，**不抄判据条数**，
  条数由命令自己打印）；§4「Pre-release checklist」由「六条命令 + 一堆坑备注」改成
  「跑 `npm run release:day -- --stage preflight --hosts …`，人工只剩 publish 与扫码」，
  并把 `--stage writeback` / `--stage finalize` 写成续跑的两条命令。
- `docs/host-consumer-contract.md` / `_cn.md`：**没有改**，因为两份契约里没有发版流程口径
  （`grep -n "check:release|发版|release-day|publish"` 的命中全是「哪个版本已发布 / 从未发布」的历史事实，
  不是流程说明），改它等于往契约里造一段流程。这一条在 §7 也记了一笔。

## 判据清单（逐条退出码，全绿）

`find src -name '*.d.ts' -delete` 之后逐条跑（日志 `/tmp/689-gates.txt`，26 条全部 `EXIT=0`）：

| # | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| 1 | `npm run check:syntax` | 0 | 464 个跟踪文件全过 |
| 2 | `node scripts/release-day.mjs --self-test` | 0 | 51 条判据全部按预期 |
| 3 | `npm test` | 0 | `# tests 3400 / # pass 3387 / # fail 0 / # skipped 13 / # todo 0 / # cancelled 0` |
| 4 | `npm run check:test-summary -- --log /tmp/689-npm-test.log` | 0 | `TEST-SUMMARY-VERDICT ok`，`EXPECTED tests=3400` |
| 5 | `npm run check:docs` | 0 | 122 项对齐 + `docs-sync-check: OK`（106 节） |
| 6 | `npm run check:docs:strict` | 0 | 122 项对齐 |
| 7 | `node scripts/docs-drift-check.mjs --self-test` | 0 | 189 例反向证 / 放行证全部按预期 |
| 8 | `npm run check:docs-spelling` | 0 | `--strict: OK — 0 处红` |
| 9 | `npm run check:agents-directives` | 0 | 0 处红 + `--verify` 逐格等于实测 |
| 10 | `node scripts/agents-directive-scan.mjs --self-test` | 0 | 16 例 × 3 种欠账形态 |
| 11 | `npm run check:docs-examples` | 0 | 文档围栏用例全绿 |
| 12 | `npm run check:pack-links` | 0 | 87 个 `.d.ts` 声称对账 2 处声明位 |
| 13 | `node scripts/pack-link-check.mjs --self-test` | 0 | 18 例 |
| 14 | `npm run check:inventory` | 0 | 逐文件 0 处不一致 |
| 15 | `npm run check:config-leaf-values` | 0 | 两张表与实测一致 |
| 16 | `npm run check:mutation` | 0 | 逐条 0 处不一致 |
| 17 | `node scripts/mutation-sample-check.mjs --self-test` | 0 | 26 例 |
| 18 | `npm run check:types` | 0 | 94 / 26 文件（基线 103，提示可下调） |
| 19 | `npm run check:types -- --with-tools` | 0 | 129 / 28 文件（基线 138） |
| 20 | `npm run check:types:strict` | 0 | 1845 / 70 文件（基线 1892） |
| 21 | `npm run check:types:strict -- --with-tools` | 0 | 2058 / 76 文件（基线 2122） |
| 22 | `npm run check:types-build` | 0 | 87 个 `.d.ts` 生成 + 断言 + 清理，工作树干净 |
| 23 | `npm run check:exports:deprecated` | 0 | 登记面与候选面一致 |
| 24 | `node scripts/guide-removal-gate.mjs --self-test` | 0 | 18 条判据 |
| 25 | `npm run check:release` | 0 | 6 步全绿，19 s（墙钟 19.1 s） |
| 26 | `node scripts/test-hygiene-check.mjs --self-test` | 0 | 13 例 |

上面这一轮跑在**最终树**上（`git status --porcelain` 干净，日志 `/tmp/689-gates-final.txt`）：26 条命令
逐条 `EXIT=0`，没有一条非零。一处发现写在这里，因为它改了我第一版的写法：`delivery/*.md` 也在 `check:docs`
的 `paths` 面内——本报告最初把状态文件名写成反引号形态，被判成「裸文件名三级都解不到」而红
（`archive-refs: delivery/689-release-day.md … erix-release-day-state.json（第 155 行）`），改成非引用形态后绿。
也就是说**交付报告本身也要过文档门禁**，这一条对后来写报告的人有用。

`check:types*` 的四条都打印「基线可下调」的提示（94/129/1845/2058）。**本片没有下调**：棘轮下调要求
「改常量 + 单独提交 + 说清哪个文件少了多少」，那是另一笔账，混进发版日这一片会让「这次为什么变」不可归因。

## 改动了既有期望的地方（逐条理由）

1. **`AGENTS.md` / `AGENTS_cn.md` §4 的前置清单**：六条命令（`check:docs && check:docs:strict` /
   `ERIX_E2E_REAL=1 check:release:real` / `check:release` / `check:host-consumers`）改成
   `npm run release:day -- --stage preflight --hosts …` 一条 + 三步续跑。理由：本单的验收要求
   （「把 §4 前置清单改成『跑 preflight，人工只剩 publish 与扫码』」）；旧清单正是 0.30.0 出事的那个形状——
   顺序靠人记。**保留的部分**：真上游「不跑 ≠ 通过」的口径原样保留并升级成机器行为（exit 2），
   宿主探针「覆盖不是否决」的整段原样保留（只把「最后一条」改成「第 5 步」）。
2. **两份 AGENTS 的命令表各加一行 `npm run release:day`**：中英成对，说明里只写口径与坑，
   **不抄判据条数**（条数由 `--self-test` 自己打印）。
3. **`scripts/docs-drift-check.mjs` 新增 `--sync` / `--root`**：`--sync` 是本单要求的写盘能力；
   `--root <dir>` 只给 `--sync` 用（合成树自测），**判据模式带 `--root` 直接 exit 2**——不许出现
   「换一棵树就能绿」。同时把 `VERSION_CLAIM_RULES` 从 §18 移到 §1（纯搬家：同一对象、同一引用，
   `collectPublishedClaimErrors` 一字未改），因为 `--sync` 必须在 §1 之前就能读到这两条正则。
   `--sync` 复用 `CURRENT_CLAIMS` / `VERSION_CLAIM_RULES` 本身，**不抄第二份措辞**。
4. **`package.json` 加一个 script**：`release:day`。
5. **CI 加一个阻塞步**：`Release-day command self-test`。理由：本单的接线要求，且它与
   `Compatibility-pin inventory verify` 同族（提交进库的东西必须与真树对得上）。
6. **`test/test-suite-baseline.json`：`expect.tests` 3393 → 3400**（+7）。理由：新增
   `test/release-day.test.js` 七格是**有意的增删**；数字逐字取自本树 `npm test` 的 TAP 汇总行，
   并经 `check:test-summary --log` 复核为 `ok`（脚本自己提示「可抬到 3400」），不是手抄。
   `maxSkipped` 上限 15 未动（实测 skipped 仍是 13）。
7. **writeback 会自己提交**（`git commit -a -m "docs(#689): release-day writeback — v<ver> 发布态回写"`）：
   这是新增行为，理由是顺序闸：`finalize` 要求工作树干净才打 tag，而「回写没提交」正是「tag 出去了、
   文档还写着未发布」的成因。只提交**已跟踪文件的改动**（`-a`），不 `git add -A`、不碰未跟踪文件；
   回写前要求工作树干净（脏 ⇒ 红，不写盘），没有改动时跳过提交；`--no-commit` 可关。
8. **`--sync` 的改写面包含 `docs/requirements*.md` 与 `CHANGELOG.md` 段首标记**：任务的原话点名的是
   「AGENTS 两份 + README 的当前版本句」，这里多了两类，理由都是机器性的——requirements 的四处「对照版本」
   是 `check:docs` 的 `CURRENT_CLAIMS` 的一部分（不回写则「回写后 `check:docs` 绿」假掉）；
   CHANGELOG 段首标记是判据 3 的一部分（不回写则 `changelog-published` 红）。两者都是**发布态句子**，
   不是别的东西，且窄面由 ⑦a/⑦c 的逐字节比对看守。

## 未验证项

- **`npm publish` 本身没跑过**（任务红线：不许真发布；脚本也刻意不 fork 它）。`publish` 阶段只验证了
  「打操作单 + exit 3 + 零子进程」。
- **`git push` / 打真 tag / 对两个真实远端 `ls-remote` 没跑过**（会改远端；任务不许 push main、不许发版）。
  这三段由假 runner 的自测（⑤ 正反两态）与真树只读的 `git blame` / `git diff --quiet` 校验覆盖；
  **`git push` 在真远端上的行为没有现场证据**。
- **`ERIX_E2E_REAL=1 check:release:real` 没跑**（任务明令不跑；`check:mutation:run` 同理）。所以
  `preflight` 的「全绿」这一态在真树上没出现过，只出现过「4 绿 + 1 未判定 + 1 未判定」与「4 绿 + 1 未判定」。
- **一次真实的 0.31.0 发版日没走完整链路**（今天没有发版）。所以 `finalize` 的端到端（tag → 双推 →
  两侧现验 → 文档门禁）只有自测证据。
- **CI 上的新步没有被实际跑过**（要等下一次 push 的 workflow run）。
- **`--sync` 在真树上的实测用的是 `--version 9.9.9` 然后 `git checkout -- .` 还原**；真实回写（版本 ==
  `package.json`）只在合成树与 `/tmp/689-wb-real` 上跑过。
- **回写提交的「夹带」已用硬闸堵上**：`writeback` 在写盘前要求 `git status --porcelain` 为空（脏 ⇒ 红、
  一个字节都不写、不留状态文件；自测 ⑬）。残留风险只剩「回写期间（写盘与提交之间）有人同时改文件」——
  这个窗口是毫秒级，脚本不锁。
- **`--sync` 不改日期**：README 当前发布行里的 `(2026-11-03)` 这类日期不在改写面内（它不是 `check:docs`
  对账的字面量）。回写之后那行会变成「新版本 + 旧日期」，需要人在切版提交里顺手改。这是**刻意的窄面**
  （日期不是发布态真值，机器不知道哪天发的），但它是回写之后唯一需要人再看一眼的地方。
- 未覆盖：非 `origin` 远端命名、Windows 路径、`git worktree` 里的 `main` 检出、prerelease 版本的
  `--tag latest`（操作单里提了，脚本不判）。
