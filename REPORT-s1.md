# REPORT — issue #767 落地片 S1（方案 A + B）· 代号 261107-17

分支 `fix-261107-17-snapshot-cell-axes-erix`，基点 `40a518d`，工作树 `/home/eric/wt-767e`。
**未动 `src/`**（`git diff --stat 40a518d..HEAD -- src/` 为空）。未 push、未开 PR、未碰 `/home/eric/wt-767`。

## 取证边界

**打开过的文件（只读，逐段）**

| 文件 | 读了什么 | 用什么读的 |
| --- | --- | --- |
| `docs/host-consumer-contract_cn.md` | 1815-1880（#735 切片 2 那一节 + 相邻小节标题） | `readFile offset=1815 limit=130` / `offset=1844 limit=36`、`grep -n "run snapshot"` |
| `docs/host-consumer-contract.md` | 2246-2370（对应英文节） | `readFile offset=2245 limit=125`、`grep -n "run snapshot"` |
| `src/loop/orchestrator.js` | 2936-3005、3005-3075、6146-6206（快照 payload 字面量、轮记录字面量） | `readFile` 三段 |
| `src/loop/resume-manager.js` | 10-20、340-350、380-392、425-435、510-520、535-545、560-575、580-600、650-672、695-710 | `sed -n` 分段 + 逐键 `grep -rnoE` |
| `bin/final-guard-support.js` | 210-245 | `sed -n '210,245p'` |
| `test/loop-snapshot-write-side-735.test.js` | 1-160（夹具取法 + 127-142 的在场要求） | `sed -n '1,160p'` |
| `test/compaction-observability.test.js` | 65-85 | `sed -n` |
| `test/persistence-diagnostics.test.js` | 165-175 | `sed -n` |
| `test/loop-persistence-phase.test.js` | 80-92 | `sed -n` |
| `test/docs-no-overclaim-735.test.js` | 1-235（扫描面定义 + 禁语表 + 中英对账判据 G4） | `sed -n` 三段 |
| `CHANGELOG.md` | 1-12 + 条目标题骨架（`grep -n "^## \|^### \|..."`） | `sed`/`grep` |
| `package.json` | `scripts` 全表 | `node -e` |
| `scripts/docs-drift-check.mjs` | 1918-2007 附近注释、2660-2731（裸行号棘轮面与基线常量） | `grep -n` + `sed -n '2700,2730p'` |

**跑过的命令（每个数字都指回这里）**

1. `git log --oneline -3` / `git status --porcelain` / `git branch --show-current` — 基点与洁净度。
2. `wc -l docs/*.md src/loop/orchestrator.js src/loop/resume-manager.js bin/final-guard-support.js` — `5724`（cn 契约，改前）、`7292`（en 契约，改前）、`6738`、`855`、`443`。
3. `grep -rhoE "resumeRunSnapshot\??\.[A-Za-z_]+" src/ | sed 's/.*\.//' | sort | uniq -c` — 恢复侧字段面 5 键（`partialText` 2、`pendingToolUse` 2、`pendingToolUses` 1、`round` 8、`toolResults` 1）。
4. 逐键 `grep -rnoE "(resumeRunSnapshot|snapshot|snap)\??\.<key>\b" src/`（10 键各一遍）— 得到 10 格读点行号（见下）。
5. `grep -rn "snapshot" src/ bin/ | grep "\.status"` — **零命中**（⇒ `status` 的 `read: not-source`）。
6. 自写的 33 条引用校验脚本（`sed -n "${l}p" $f | grep -F "$k"` 形状）：**32 OK / 1 MISS**，MISS 是 `test/loop-invalid-arguments.test.js:234`，正确行号是 **235**（`grep -n "snapshot.status\|\.status ===" test/loop-invalid-arguments.test.js`），文档里已按 235 写。
7. `node --check test/contract-snapshot-cell-axes-767.test.js` — CHECK_OK。
8. `node --test test/contract-snapshot-cell-axes-767.test.js` — `# tests 8 / # pass 8 / # fail 0`。
9. `node --test test/loop-snapshot-write-side-735.test.js`（`7 / 7 / 0`）、`node --test test/compaction-observability.test.js`（`1 / 1 / 0`）、两者并跑（`8 / 8 / 0`）。
10. `python3 /tmp/falsify.py` 与 `python3 /tmp/falsify3.py` — 三组反向证（日志留在 `/tmp/RED1-stopped.log`、`/tmp/RED2-dropped-row.log`、`/tmp/RED3-messages-not-source.log`），每组跑完 `git checkout --` 还原，脚本自己打印 `clean: True` + `green again: True`。
11. `npm run -s check:docs` / `check:docs-spelling` / `check:tests` / `check:changelog`；`node scripts/docs-sync-check.mjs`；`git checkout 40a518d -- docs/<两份契约> && node scripts/docs-drift-check.mjs` 后还原。
12. `python3` 统计两份标记块内的行数与引用数（见「留给主会话」）。

**没打开 / 没跑的**

- **没跑 `npm test` 全套**（按纪律留给主会话）；因此**没有**跑任何依赖全套的汇总闸（`check:test-summary`、`check:mutation:run`、`check:release` 等）。
- **依赖 typescript 的闸一个都没跑**：`check:types`、`check:types:strict`、`types:build`、`check:types-build`、`prepack`（本树 `node_modules` 是软链，跑不动不算本片结论）。
- `src/` 只读了上表列出的行段，其余 **6000+ 行未读**；`examples/`、`delivery/`、`skills/`、`docs/` 其余文档、`test/` 其余 300+ 文件均未打开（除上表 5 份 + 被 `check:tests` 扫过一遍文件名/临时目录口径）。
- 没读过任何 `.env`/密钥文件；没执行过 `git push`。

## 交付物（4 笔 commit，按时间序）

| commit | 内容 |
| --- | --- |
| `39b1ed7` | `docs(#767)` 中文契约两轴表（A 组，中文侧） |
| `a00b2f3` | `docs(#767)` 英文契约同步表（A 组，英文侧，轴值与中文逐格一致） |
| `835eb38` | `test(#767)` 新文件 `test/contract-snapshot-cell-axes-767.test.js`（B 组，8 例） |
| `6d4b8a5` | `docs(changelog)` CHANGELOG 中英配对条目 |

第一笔 commit 落在开跑后约 5 分钟内（第 6 分钟之前），此后每个里程碑各一笔。

## A. 契约（中英同步）

落点：中文契约 `1879` 起（原 `#### run snapshot 的 messages…` 小节之后、`#### 可选原始行锚点探针（issue #714）` 之前）；英文契约 `2327` 起（同一相对位置）。两份都带 `<!-- erix:snapshot-cell-axes:begin|end -->` 标记，表被测试当数据读。

- **禁用「退役」单标签**（G1 用例把这条也钉住：两个轴列里出现 `退役|retire|deprecat*` 即红）。
- 两轴：`write: written|residue|stopped`、`read: source|fallback(条件)|not-source`；`read` 轴口径**只量恢复侧**（`src/loop/resume-manager.js` 对快照对象那一层的属性读取），并在正文写明「引擎不读 ≠ 没人碰这格」。
- **11 行列全 10 格**：`persistedTranscriptLength` 按「盘上那格 / 进程内计数器」**分两行**（G1 断言它必须恰好两行）。
- 双写格（`toolOutputs` / `compactionStats` / `persistedTranscriptLength` / `messages`）带「权威源」「交接条件」两列；非双写格写 `—` 并在表下写明 `—` 的含义。
- 今天轴值：`round`/`status`/`pendingToolUse(s)`/`executedToolIds`/`toolResults`/`toolOutputs`/`persistedTranscriptLength`×2/`compactionStats` = `written`，`messages` = `residue`；`read` 侧 `not-source` 三格（`status`、`compactionStats`、`persistedTranscriptLength` 盘上格）、`fallback` 两格（`pendingToolUse`、`messages`）、余下 `source`。表内今天**没有一格 `stopped`**（已停写的 `toolUse`/`ts` 在 #735 切片 1 处理，不在本表）。
- 行号全部是在 `40a518d` 上现取并逐行验过的（取证边界第 6 条），**没有抄 #767 正文里的 0.31.0 行号**。已现验的四条要点写进了表/表下口径：
  - `toolOutputs`：快照 `src/loop/orchestrator.js:3037` vs 轮记录 `src/loop/orchestrator.js:6181`；终稿 guard 的证据源是轮记录（`bin/final-guard-support.js:238`，口径写在同文件 `:218` 注释），不读最新快照。
  - `compactionStats`：快照 `:3038` vs 轮记录 `:6161`，恢复读 run-state（`src/loop/resume-manager.js:346`）；两侧都有活断言（`test/compaction-observability.test.js:73` 轮记录侧、`:76` 快照侧）。
  - `persistedTranscriptLength`：盘上那格 `:3030` 可退役（`src/loop/resume-manager.js:16` 注释 + `:430` 现算覆盖），进程内计数器必须留（残余上界 `src/loop/orchestrator.js:2975`）；测试侧夹具锚点两处 `test/loop-invalid-arguments.test.js:250`、`test/loop-resume-anchor.test.js:152` 列为停写前置。
  - `status`：引擎不读（取证边界第 5 条零命中），但形状被 5 处测试钉住（`test/loop-persistence-phase.test.js:87`、`test/persistence-diagnostics.test.js:171`、`test/loop-invalid-arguments.test.js:235`、`test/loop-v020-rc.test.js:479`、`:605`）⇒ 只写 `not-source`，不写「可停写」。
  - `messages`：残余（`src/loop/orchestrator.js:3029` 写出、`residueStart` 在 `:2975` 一带），旧格式升级路径 `src/loop/resume-manager.js:586` 是活读者 ⇒ 只写 `fallback(仅旧格式账本)`。

## B. 证伪连接（`test/contract-snapshot-cell-axes-767.test.js`，8 例全绿）

| 例 | 判据 |
| --- | --- |
| G1 | 表自洽：10 格集合**恰好**（漏格/多格都红）、`persistedTranscriptLength` 恰好两行、两轴取值合法、7 列无空值、轴列禁「退役」单标签 |
| G5 | 中英逐格一致：格序列、`write` 轴、`read` 轴头（括注里的条件按语言写，故只比对轴头） |
| G2 | **写轴对真载荷**：夹具照 `loop-snapshot-write-side-735.test.js`（包一层 `saveRunSnapshot` 抓引擎亲手写的 payload，不手搓）；`stopped` ⇒ 每条载荷必须**无该键**，`written`/`residue` ⇒ 必须**有** |
| G3-A | **读轴对真源码**：`not-source` ⇒ `src/loop/resume-manager.js` 剥完注释与字符串后对该键的快照读点必须为 0 |
| G3-B | 剥逻辑的**反例**：行注释 / 块注释（含续行）/ 双引号 / 单引号 / 模板字面量 / 正则字面量里的读点一律不算，代码里的两处算；并带「剥多了会把代码吃掉」的在场对照 |
| G3-C | 真实文件上的反例：`src/loop/resume-manager.js` 里那句**注释里的** `snapshot.messages` 不算读点、代码里那句算（行号不写死，靠扫描现取）；并断言剥完行数与原文一致（行号对齐） |
| G4 | 表内每条 `file:line` 复核：文件在场 + 行号在范围内 + **那一行确实提到这格的键名**（词边界，`pendingToolUse` 不会被 `pendingToolUses` 蒙过）；引用面 < 20 条即红 |
| G6 | 轴与源码互相对账：`source`/`fallback` 行引的恢复侧行号必须出现在剥完源码的真读点集合里；`not-source` 行引的恢复侧行号只能是「不信它 / 现算覆盖」的证据 |

## 三组反向证（真跑，跑完已还原）

① 契约把 `status` 改 `stopped` 而代码照写（中英两份同改）：

```
not ok 3 - G2 写轴对真载荷：声明 written/residue ⇒ 键必须在场，声明 stopped ⇒ 键必须缺席
  error: '契约把 `status` 标成 stopped，但引擎仍把该键交给 saveRunSnapshot（keys：["round","status","pendingToolUse","pendingToolUses","messages","persistedTranscriptLength","executedToolIds","toolResults","toolOutputs","compactionStats"]）'
# tests 8 / # pass 7 / # fail 1        ← /tmp/RED1-stopped.log
```

② 从两份表里删掉 `executedToolIds` 一行：

```
not ok 1 - G1 载荷表自洽：10 格齐全、两轴取值合法、无空值
  error: 表里的格集合必须**恰好**是这 10 个（漏一格 = 集合缺项，多一格 = 多项）…（deepEqual 差集含 executedToolIds）
# tests 8 / # pass 7 / # fail 1        ← /tmp/RED2-dropped-row.log
```

③ 把 `messages` 标 `not-source`：

```
not ok 4 - G3-A 读轴对真源码：声明 read: not-source ⇒ 恢复侧不得有该键的快照读点
  error: 契约把 `messages` 标成 read: not-source，但 src/loop/resume-manager.js 第 586, 587 行仍在读快照那一格
not ok 8 - G6 …  error: '`messages` 标的是 read: not-source，读者列引的 src/loop/resume-manager.js:586 却是真读点（真读点在：586, 587）'
# tests 8 / # fail 2                   ← /tmp/RED3-messages-not-source.log
```

还原后：`git status --porcelain` 空 + `node --test` 该文件 `8 / 8 / 0`（脚本自印 `clean: True`、`green again: True`）。

## 跑过的闸与结果

| 命令 | 结果 |
| --- | --- |
| `node --check` 新测试文件 | OK |
| `node --test` 新测试文件 | 8 pass / 0 fail |
| `node --test test/loop-snapshot-write-side-735.test.js` | 7 pass / 0 fail |
| `node --test test/compaction-observability.test.js` | 1 pass / 0 fail |
| `node --test test/docs-no-overclaim-735.test.js test/contract-verbatim-verdicts-553.test.js`（两份文档禁语/逐字判词闸） | 30 pass / 0 fail |
| `node scripts/docs-sync-check.mjs` | OK — 中英契约标题结构对齐（**115 节**，锚点齐全）⇒ 新加的中英两个 `####` 小节骨架成对 |
| `npm run check:docs-spelling`（`--strict`） | OK — 0 处红 |
| `npm run check:tests` | OK — 扫 `test/**` **313** 个文件 |
| `npm run check:changelog` | OK |
| `npm run check:docs` | **红 1 处**：`bare-lines` 裸行号棘轮实测 **62** vs 基线 **6**（分布：en 契约 32、cn 契约 32、`docs/host-upgrade-guide-v030*.md` 各 1）；把两份契约退回 `40a518d` 再跑同一条 → OK ⇒ 增量全部来自本片的表 |

## 留给主会话在合并树上现测的派生数字（我一个基线都没改）

1. **裸行号棘轮**：`scripts/docs-drift-check.mjs:2723` 的 `const BARE_LINE_REF_BASELINE = 6;`，本片实测 **62**（其中两份契约各 32，其余 2 处是既有的升级指南）。工单要求的修法二选一：把行号换成「符号 + 文件」锚点（该闸 2.8.1b 还要求「符号自带区间必须与符号声明处相交」，而本表的行号指的是**写点/读者**而不是声明处，直接套这个修法会撞那条判据），或写明允许变差并把地板改成 **62**。
2. **套件用例总数**：本片新增 1 个测试文件、**8** 条用例（全套汇总数由 `check:test-summary` 现测）。
3. **CHANGELOG 配对地板 / 登记值**：中英各 1 条 `### Added` 条目已写；配对口径的计数由主会话现测（本片跑过 `check:changelog` 只覆盖 0.31.0 已发布段，不覆盖 `[Unreleased]`）。
4. **依赖 typescript 的闸未跑**（`check:types*`、`types:build`）。

## 风险与本片刻意没做的事

- 表里今天**没有 `stopped` 格**，所以 G2 的「stopped ⇒ 必须无该键」这一支在现树是**空跑**——已用反向证 ① 证明它咬得住（不是死条目）。
- `read` 轴只覆盖 `src/loop/resume-manager.js`（工单指定面）；`src/loop/orchestrator.js` 里的 `resumeRunSnapshot.round` 等 4 处读点只出现在读者列的引用里，由 G4 的行号复核看守，不在 G3-A 的源码扫描面内。
- 退役动作本身（逐格停写 + 迁测试指纹）本片**一件没做**：目标是「退役整条通道」，本片只把「哪格今天满足什么条件」变成可被测试证伪的事实。
- `messages` 那格的 #754 遗留（跨恢复取不回旧正文）只在表下口径里指认归属，未改代码。
