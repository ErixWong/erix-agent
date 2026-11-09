# REPORT-800 — issue #800：旧扩展实例迟到的 `session_shutdown` 把活会话的后台 run 弄成永久静默

分支 `fix-261109-05-handle-owner-guard`（从 `origin/main = f405264` 切出，**第三轮已 rebase 到
`origin/main = 6507ed1`**）。三轮的分工：

- **第一轮**：判据 1（摘句柄要有归属）+ 判据 2（同 id 双实例顺序）——已被上级复验收下（反向证他也重跑过）。
- **第二轮**：判据 3（补投回路）+ 判据 4（措辞诚实）+ 判据 5（迟到实例不清别人的定时器）+ README/CHANGELOG
  + 当时那批派生登记。
- **本轮（第三轮）**：主干前进 13 笔（PR #801 = #798）→ **rebase 到 `6507ed1`**，冲突只允许在登记面，
  两边的旧读数全丢掉后在最终树上重取；其余四刀的代码**本轮一行没改**（rebase 没碰到任何 js/ts）。

下文「判据 3 / 4 / 5」那三节仍是第二轮的交付（代码未变，本轮只**重跑**了它们与两条反向证，见
「rebase 与登记重取」那一节末尾）。

## 取证边界

**本轮（rebase）逐字看过 / 现跑过的**：

- `git log --oneline HEAD..origin/main`（主干那 13 笔的**逐笔主题**，确认它们动的是 `bin/` 的
  `reasoning_effort` 面 + 它自己的登记回填 `8d7be88` / `362ee3c` / `ef26eef` 与配对地板 `b2acde1`）。
- rebase 冲突体的两侧：`test/test-suite-baseline.json` 的 `expect.tests`（主干 3786 vs 本支 3772）与
  `test/static-guards.test.js` 的 `CHANGELOG_PAIR_FLOOR`（两侧都是 36，但各 自校准在不同树上），
  以及主干在 `## [Unreleased]` 里新加的 `#798` 中英条目（现查在 `CHANGELOG.md:409-410`，本支那对在 `:617-618`）。
- 最终树上四个登记打印面：`check:test-summary -- --log`（六个数 + HINT）、配对地板守卫的判词与观测行、
  `check:mutation` / `check:inventory` 的「0 处不一致」原文（逐字抄进注释与本报告）。

**第二轮逐字读过的**（只在这些范围内下结论）：

- `examples/pi-extension/erix-run-jobs.js`：`deliveryNoteText`（判据 4 的唯一文案真值源）、
  `createSessionHandleRegistry`（上一轮加的 `release` / `releaseRefusals`）、`jobView` 的投递字段族、
  `recordDelivery`、`clearJobTimers`、`scheduleNotifyRetry`（#659 的有界重试：`orphaned` 也排档，最多三档）、
  `notifySettled`（去重 `claim` + orphan 分支里那句 `claim.settle(false)` 把去重位**放回**）、
  `notifyThenPersist`（`sent` 撤档 / 没投成排下一档 + `persistStatus`）、`settle`、
  `shutdown(ownerSessionId)` 的机制注释（「会话关了 / 扩展实例换了」—— 判据 4 的矛盾方就在这段的邻居）、
  `createAsyncJobRegistry`（`list()` 只含**本进程内存里**的 job —— 这条界写进「未验证」）。
- `examples/pi-extension/erix-run.ts`：`session_start`（句柄登记 → `asyncRuntime()` → `#659` 的 steer 补偿）、
  `session_shutdown`（`#658` 的按会话清理 + 上一轮的 `release`）。
- `test/examples/erix-run-async.test.js`：`waitUntil` / `fakeClock` / `gatedJob` / `dispatchAndSettle` /
  `startSession` / `loadExtensionModule` 的签名与语义，`#658` 那格（`:760`，跨会话不跨实例），
  `#654 缺陷1`（`:1597`，手工删句柄），`#665` 的 orphaned 文案格（本轮按判据 4 改写）。
- `examples/pi-extension/README.md`：`delivery` 取值表、`jobView` 字段表、`#665` 那句文案表。
- `CHANGELOG.md`：`## [Unreleased]` 的 `### Fixed` 开头与中英成对写法（照 `#753 C2` / `#765` 的形）。
- 登记生成器**自己打印**的原文：`check:test-summary -- --log`、`test/static-guards.test.js` 的配对地板
  diagnostic、`mutation-sample-check.mjs --sync` 的改动行数、`check:inventory` 的「0 处不一致」。

**没有读过 / 明确不动的**：`src/**`、`bin/**`、`docs/host-consumer-contract*.md`、`AGENTS.md`（字节预算）、
根 `README.md`、`package.json`、`examples/pi-extension/erix-run-e2e.test.mjs`（只跑，没改）。
本轮**没有**动引擎：判据 3/4/5 全在扩展面可取证，不需要动 `src/`，所以没有 `BLOCKED`。

**现场事实**（来自 issue 与上轮复现，不是本轮新测）：同一个 owner 连续三次结算全 `orphaned`、
`notifyRetries` 耗尽，而 `notifyTargetSessionId` 逐字就是当前在发轮的会话 id；受害 run 的
`status.json` 停在 `running`。

## 基点
（第三轮：本支已 **rebase 到 `origin/main = 6507ed1`**（PR #801 = issue #798 的 CLI `reasoning_effort` 面）。
旧基点 `f405264` 上量到的 `3772` / `PAIR_FLOOR 36` 已作废，理由见「结论 → rebase 与登记重取」。）

`git log --oneline origin/main..HEAD`（现跑，非空；测量点 = `886cdf0`）：

```
886cdf0 chore(#800): rebase 到 6507ed1 后在最终树重取派生登记（TAP 地板 3786→3790 + observation、CHANGELOG_PAIR_FLOOR 36→37 取守卫自报值）
5172bfa docs(#800): 报告四格按第二轮补全（判据 3/4/5 的反向证现场、门禁逐条退出码、派生登记取值来源、未验证边界）
af07b9f chore(#800): 变异样本表 --sync 刷 M29 行号（rebase 后登记常量两边都丢掉，改在最终树现测）
868c9be docs(#800): README 补「摘句柄要有归属 / owner 回来会补投 / 三个计数怎么读」一节并按判据 4 改准 delivery 值表；CHANGELOG 中英成对条目（不写 TAP 计数）
b6736a3 fix(#800): orphaned 之后 owner 回来要补投一次；orphaned 措辞改机制表述；迟到的 shutdown 不得清活实例的定时器
4ab75b0 docs(#800): 回填基点两行（git log / git diff --numstat 现跑值，测量点 e95fcf0，只动本报告）
2fa806b docs(#800): 交付报告四格（取证边界 / 基点 / 结论 / 未验证）—— 本轮只交判据 1+2
99950a4 fix(#800): erix_run 摘会话句柄要有归属 —— 旧扩展实例迟到的 session_shutdown 不再抹掉活实例的登记
```

`git diff --numstat origin/main..HEAD`（现跑，逐字）：

```
3	0	CHANGELOG.md
228	0	REPORT-800.md
36	1	examples/pi-extension/README.md
128	5	examples/pi-extension/erix-run-jobs.js
22	3	examples/pi-extension/erix-run.ts
235	2	test/examples/erix-run-async.test.js
1	1	test/mutation-samples.md
14	1	test/static-guards.test.js
18	1	test/test-suite-baseline.json
```

- 两行都**非空** ✓。rebase 后这一版**只剩本片自己的改动**：上一版里那几行「只有删、没有加」的
  `bin/reasoning-effort.js 0 187` / `test/cli-reasoning-effort-798.test.js 0 490` 假象已消失
  （现查 `git diff --numstat origin/main..HEAD | grep -c bin/` = **0**），`bin/` 一个字节没动 ✓。
- 基点核对：`git merge-base --is-ancestor origin/main HEAD` ⇒ `origin/main = 6507ed1` **是** HEAD 的祖先 ✓
  （rebase 基点正确；`git status --porcelain` 空）。
- ⚠ 测量点是 `886cdf0`。把本报告抄进 `REPORT-800.md` 的那一笔（以及之后回填的那一笔）**只动
  `REPORT-800.md`**（上面 `228 0 REPORT-800.md` 就是它们叠加的结果），不动代码。抄进来会让这一行
  再变一次 —— 那是自指不是造假：标测量点就是为了让下一个读者能逐字复现
  （`git log --oneline origin/main..886cdf0` / `git diff --numstat origin/main..886cdf0`）。
  的下一笔**只动** `REPORT-800.md`，不动代码（自指，标测量点即可复现）。
- `src/` 与 `bin/` 在 merge-base 那一版里**一行都没有** ⇒ 「不动引擎」这条纪律是盘上事实，不是自称。

## 结论

### 判据 3：恢复回路（本轮正题）

| 位置 | 改动 |
|---|---|
| `erix-run-jobs.js:1018-1037` | 新增 `requeueOrphaned(ownerSessionId)`：按 owner 筛出 `delivery === "orphaned"` 且 `orphanRecoveries === 0` 的 job，**每条只补投一次**；计数在投递**之前**落（补投又没成也不来第二次，退回 #659 的有界重试链，不开第二个循环）；没句柄直接返回（不把同一句 orphaned 再写一遍）；返回补投过的 `runId` 列表 |
| `erix-run-jobs.js`（`:1369-1372` 的 runtime `return {…}` 面） | `requeueOrphaned` 随 runtime 一起导出 |
| `erix-run-jobs.js:671-676`（`jobView`） | 新增**恒在场**的结构化事实 `orphanRecoveries`（没补过是 `0`）与 `orphanRecoveredAt`（没补过是 `null`）—— 与 `delivery` 同族，同一个 `jobView` 喂 `action:"status"` / `"result"` / `status.json` |
| `erix-run.ts:634-642`（`session_start`） | 登记句柄之后调 `asyncRuntime().requeueOrphaned(sessionId)` —— `session_start` 是唯一的新登记点，而它本身不重放旧 job |

- **不双投**：补投走的就是 `notifyThenPersist` ⇒ `sendRegistry.claim(job.notifyKey ?? runId)` 那道闸一道不少。
  orphan 那一刻 `notifySettled` 里已经 `claim.settle(false)` 把去重位放回（#656），所以这里能重新领到；
  若真被别的结算路径抢先，`claim.owned !== true` ⇒ 只计 `deduped`，不重复投。测试里那条
  `deduped === 0` + 「owner 第三次回来不再投」钉的就是这两道闸。
- **`deliveryNote` 整句重算**：补成之后 `recordDelivery` → `refreshDeliveryNote` → `deliveryNoteText`
  按当下的结构化事实重算 ⇒ `sent` 时是 `null`（不贴噪音），不是把旧句子手抹掉。断言写的是
  `assert.equal(jobView(job).deliveryNote, null)`。
- 现场：`test/examples/erix-run-async.test.js:1783` —— owner 真走一次 ⇒ 落 `orphaned`（盘上也是）；
  以**同一个 sessionId** 回来 ⇒ `delivery` 变 `sent`、`notifyTargetSessionId` 仍是 owner、
  `orphanRecoveries` 从 `0` 变 `1`、`orphanRecoveredAt` 非 `null`、`status.json` 同步变 `sent`、
  新实例的投递口收到 1 条；owner 再回来一次不双投。

**反向证（补投那一环拆掉）** —— 变异锚点是 `requeueOrphaned` 里那一行整行替换
`notifyThenPersist(job);` → `void job; // MUT-800-3`：

```
not ok 50 - \#800 判据3：owner 以同一个 sessionId 回来 ⇒ session_start 把它名下 orphaned 的 job 补投一次（只一次、不双投）
  error: |-  expected: 'sent'  actual: 'orphaned'
  TestContext.<anonymous> (…/erix-run-async.test.js:1812:12)      ← 正是 `delivery` 那条断言，不是文案
# tests 63 / # pass 62 / # fail 1
```
红在 `delivery`，且**只有这一格**红 ✓（要求的形状）。

### 判据 4：措辞诚实

`erix-run-jobs.js:177-183`（`deliveryNoteText` 的 orphaned 分支）改成：

> `orphaned (owner 会话 <id> 的句柄查不到，不投给任何存活会话；成因可能是会话已关，也可能只是扩展实例换了（同一个 sessionId 稍后重新登记后会补投一次）)`

- 仍然只在 `deliveryNoteText` 一处生成（没另起硬编码），仍然由 `recordDelivery` / `scheduleNotifyRetry`
  两个调用点整句重算；`examples/pi-extension/README.md:385` 的 `delivery` 值表**逐字同步**。
- 看守格：`erix-run-async.test.js:2196`（原 `#665` 文案格，标题跟着口径改了）新增三条正向断言
  （`句柄查不到` / `扩展实例换了` / `补投`）+ 一条**反向**断言 `assert.doesNotMatch(lines[0], /已不在/u)`
  —— 把旧措辞钉成回归。盘上 `deliveryNote` 与文本面那句仍要求逐字同源。
- 反向证（措辞退回旧版整行替换）⇒ 两格红：`:2214`（`#665` 文案格）与 `:1803`（判据 3 的前置文案断言），
  `# tests 63 / # pass 61 / # fail 2` ✓。

### 判据 5：兄弟洞（迟到实例清掉活实例的定时器）

| 位置 | 改动 |
|---|---|
| `erix-run-jobs.js:1343-1367`（`shutdown`） | 签名变 `shutdown(ownerSessionId, sessionHandle)`。判据与判据 1 逐字同源：表里这一条是**别人的**句柄 ⇒ 会话仍被一个活实例管着 ⇒ **一个定时器都不清**，并对「当时真有定时器」的 job 记 `job.shutdownTimerSkips += 1`（不许静默）。没递句柄 = 调用方不认领归属 ⇒ 照旧 #658 清自己会话名下的（旧调用方不退） |
| `erix-run-jobs.js:667-670`（`jobView`） | 新增恒在场字段 `shutdownTimerSkips`（`0` = 没人模过 / 模了都清成了） |
| `erix-run.ts:664-667` | `asyncRuntime().shutdown(sessionId, sessionHandle)` —— **接线本身就是判据**：不递句柄，runtime 比不出归属 |

- 为什么「旧实例自己派的那条」也保留：owner 会话**还活着**（只是换了实例），它的 run 还能投出去 ——
  摘掉看门狗就再没有任何路径写终局，那正是 `status.json` 停在 `running` 的成因。
- 看守格 1（机制，注入假时钟）`erix-run-async.test.js:1835`：同 id 两实例，旧实例迟到 shutdown ⇒
  返回 `false`、两条 job 的看门狗都在、`shutdownTimerSkips` 各 `1`；两根定时器都到点后**两条都**写
  `aborted`（`clock.tick()` 第三次返回 `false` ⇒ 没多清也没少清），盘上 `status: aborted` / `timeout: true`；
  活实例自己走（归属匹配）⇒ 照旧 `true` 并真清掉（`:760` 的 #658 语义不退）。
- 看守格 2（**接线**）`erix-run-async.test.js:1896`：真 factory + 真 `session_shutdown` handler，
  证的是「有没有把自己那个句柄递下去」。

  ⚠ 这一格是补上的：先只有机制格，我拿接线变异跑 ⇒ **62/62 全绿**（机制格注入的是自己的 runtime，
  碰不到 `erix-run.ts`）⇒ 那是一格假绿，所以加了接线格。
- 反向证两条：
  - `if (heldByOther)` → `if (false && heldByOther)` ⇒ `:1866`（`shutdown` 返回 `false` 那条）红
    `expected: false / actual: true`，接线格同时红（`watchdog` 变 `undefined`），`# fail 2` ✓。
  - 接线 `shutdown(sessionId, sessionHandle)` → `shutdown(sessionId)` ⇒ **只有**接线格红（`:1926`，
    `watchdog` 变 `undefined`），`# fail 1` ✓。

### rebase 到最新主干与登记重取（第三轮）

`git fetch origin` 直连就通（未动代理），`git rebase origin/main` 基点 = **`6507ed1`**（PR #801 = #798）。
主干领先的 13 笔里自己动过派生登记（TAP 地板 `3768 → 3781 → 3785 → 3786`、配对地板也被它取过一次
守卫自报值），所以冲突只出现在登记面：

| 冲突件 | 解法 |
|---|---|
| `test/test-suite-baseline.json` | **两边的值与本支那条旧 observation 全丢掉**（`git checkout --ours` 取主干那一份），不在旧读数上做算术 |
| `test/static-guards.test.js` | 同上（主干已把地板取到 36，本支旧笔也是 36 但那是**旧基点**的读数） |
| `test/mutation-samples.md` | 没冲突；保留本支那行 `--sync` 结果（M29 行号），rebase 后 `check:mutation` 仍 rc=0 ⇒ 不需要再刷 |
| `test/compat-pin-inventory.md` | 没冲突（主干 `--sync` 过，本支未动）；`check:inventory` rc=0 |
| `CHANGELOG.md` | **没冲突**：主干那笔 `#798` 在 `### Added`，本支 `#800` 在 `### Fixed`，两条**并列**各自一字未动（现查：`CHANGELOG.md:409-410` 是 #798 中英，`:617-618` 是 #800 中英） |

冲突那笔提交（原 `b388aa5`）的内容因解冲突而变了，已 `reword` 成 `af07b9f`（只说它真留下的那一行：
变异样本表的 M29 锚点行号），**没改内容**。

**登记值全部在 rebase 后的最终树上重取（零算术）**，两边旧读数都不进账：

| 登记 | 取到的值 | 取值来源（命令自己打印的原文） |
|---|---|---|
| `test/test-suite-baseline.json` `expect.tests` | `3786 → 3790` | `npm run check:test-summary -- --log /tmp/800-r3-npmtest2.log`：`TEST-SUMMARY tests=3790 pass=3775 fail=0 skipped=15 todo=0 cancelled=0` + `TEST-SUMMARY-HINT 登记值可抬到 3790（当前登记值 3786，本次实测 3790，+4）`（抬完 HINT 消失，`VERDICT ok`） |
| 同文件的 observation | 新增一条（六个数 + 环境 + 测量点 + 为何 +4 + 写明「两边旧读数都不进账」） | 主干侧 3786 是它自己在 `ef26eef` 那笔里现测的（在案），本支旧基点的 3772 只是历史 ⇒ 重取的是**这棵合并后的唯一真树**；`+4` 在 observation 里逐名列出是 #800 新增哪四格。`skipped 15` 未变 ⇒ `maxSkipped 18` 不动 |
| `test/static-guards.test.js` `CHANGELOG_PAIR_FLOOR` | `36 → 37` | 守卫在这棵最终树上自报（逐字抄进注释）：`校准面（## [Unreleased]）上实测 37 对 ≠ 地板 36 对：… 配对变多了 ⇒ 请抬地板到实测值` + `# 配对地板：实测 37 对 > 地板 36 对 ⇒ 可以抬地板到 37` + `中文 37 条 / 英文 37 条 / 配对 37 对 … / 无对应 0 条`。**不是 36+1**，也不是旧读数加一 |
| `test/mutation-samples.md` | **本轮未再动** | `check:mutation` 在最终树上 rc=0：「逐条：0 处不一致（行号 / 锚点 sha256 / 命中数 / 捕获者 / 合计行 / 重复样本）」⇒ 上轮 `--sync` 的 M29 行号在新树上仍对（#798 没碰 `erix-run-jobs.js`） |
| `test/compat-pin-inventory.md` | **未动** | 本仓没 `compat-pin-sync` 脚本，这张表由 `check:inventory` 验；最终树上 rc=0「逐文件：0 处不一致」。表里 grep `orphaned` 零命中 ⇒ 判据 4 改文案踩不到它 |

- `AGENTS.md` 未动（字节预算）。

**rebase 没碰坏 #800，且两条反向证仍红在该红的位置**（都在最终树上重跑，跑完 `git checkout` 还原干净，
`git status --porcelain` 空）：

- `node --test --test-name-pattern "#800" test/examples/erix-run-async.test.js` ⇒
  `# tests 5 / # pass 5 / # fail 0 / # skipped 0`（四格新测试 + 被判据 4 改写过的 `#665` 文案格）。
- **MUT-800-3**（`requeueOrphaned` 里 `notifyThenPersist(job);` 整行换掉）⇒ `not ok 50`，
  `expected: 'sent' / actual: 'orphaned'`，栈顶仍是指向 `erix-run-async.test.js:1812` 的 **`delivery`**
  断言，`# tests 63 / # pass 62 / # fail 1` ⇒ 红点仍在 `delivery`，没跑到文案上。
- **MUT-800-5**（`if (heldByOther)` → `if (false && heldByOther)`）⇒ `not ok 51`，
  `expected: false / actual: true`，栈顶 `:1866` 仍是指向 `shutdown(...)` 返回值的断言，
  接线格 `:1926`（`watchdog` 变 `undefined`）同时红，`# tests 63 / # pass 61 / # fail 2` ⇒
  与第二轮同形（红的就是这两格，别的 61 格全绿）。
- 还原后整文件：`# tests 63 / # pass 63 / # fail 0`。

### 文档

- `examples/pi-extension/README.md`：`delivery` 值表按判据 4 改准；新增小节
  「摘句柄要有归属，owner 回来要补投（issue #800）」，写三条机制 + 四个新字段（`handleReleaseRefusals` /
  `orphanRecoveries` / `orphanRecoveredAt` / `shutdownTimerSkips`）怎么读，并写明这些计数是
  **最后一次落盘前**的值（与 `delivery` 同一条口径，不是实时值）。
- `CHANGELOG.md`：`## [Unreleased] → ### Fixed` 顶部中英**成对**一条，不含 TAP 计数；rebase 后与主干
  `#798` 那条**并列**（不覆盖、不合并措辞），`check:changelog` rc=0。


### 门禁（第三轮指示的那一组，**串行**，逐条退出码；全部在 rebase 后的最终树上）

| # | 命令 | rc | 关键输出 |
|---|---|---|---|
| 1 | `git fetch origin` → `git rebase origin/main` | 0 | 基点 `6507ed1`；`git merge-base --is-ancestor origin/main HEAD` 通过 |
| 2 | `find src -name '*.d.ts' -delete` | 0 | 现测前清干净（`find … \| wc -l` = 0） |
| 3 | `npm test`（整套，第一趟） | 1 | `# tests 3790 / # pass 3774 / # fail 1 / # skipped 15`；唯一红项 = 配对地板（新增一对中英） |
| 4 | （取守卫自报值抬 `CHANGELOG_PAIR_FLOOR` → 37）后 `npm test`（第二趟） | **0** | `# tests 3790 / # pass 3775 / # fail 0 / # cancelled 0 / # skipped 15 / # todo 0`（`/tmp/800-r3-npmtest2.log:24182`） |
| 5 | `npm run check:test-summary -- --log /tmp/800-r3-npmtest2.log` | 0 | 抬之前 `VERDICT ok` + `HINT 登记值可抬到 3790（+4）`；回填后 `EXPECTED tests=3790`、HINT 消失 |
| 6 | `npm run check:changelog` | 0 | `changelog-coverage: OK …（命中 8 / 登记豁免 0 / 缺项 0）` |
| 7 | `npm run check:docs` | 0 | `docs-sync-check: OK — 中英契约标题结构对齐（117 节，锚点齐全）` |
| 8 | `npm run check:docs:strict` | 0 | `docs-drift-check: OK … 126 项对齐 package.json 0.31.0 与源码` |
| 9 | `npm run check:docs-spelling` | 0 | `--strict: OK — 0 处红` |
| 10 | `npm run check:docs-examples` | 0 | 文档里的可执行例全过（`# duration_ms 4755`） |
| 11 | `npm run check:inventory` | 0 | 「逐文件：0 处不一致」 |
| 12 | `npm run check:mutation` | 0 | 「逐条：0 处不一致（行号 / 锚点 sha256 / 命中数 / 捕获者 / 合计行 / 重复样本）」 |
| 13 | `npm run -s check:syntax` | 0 | `syntax-check: OK — 全量 501 个跟踪的 .js/.mjs/.cjs 文件 node --check 全过`（比上轮 +2 = 主干 #798 带进来的 `bin/reasoning-effort.js` 与它的测试） |
| — | `node --test --test-name-pattern "#800" test/examples/erix-run-async.test.js` | 0 | `# tests 5 / # pass 5 / # fail 0 / # skipped 0`（rebase 没碰坏 #800 那几格） |
| — | `node --test test/examples/erix-run-async.test.js`（整文件，还原后） | 0 | `# tests 63 / # pass 63 / # fail 0` |

判读 `check:docs` / `:strict` / `docs-spelling` / `docs-examples` 时**同棵树上没有 `npm test` 在跑**
（第 4/5 步已跑完退净才开第 7 步），按主干冷层那条并发判读禁令排开。`node --check` 本轮不必单独跑：
rebase 没有改动任何 js/ts 内容（只有 md 与两个登记件），第 13 步的 `check:syntax` 是全量 501 文件的超集。

## 未验证

- **补投只覆盖「还在本进程内存注册表里」的 job**：`requeueOrphaned` 扫的是 `registry.list()`，
  而 `createAsyncJobRegistry` 是内存表 —— pi 真的重启过（job 只剩盘上 `status.json`）时那条 job 不在表里，
  不会被补投，仍然读得到 `delivery:"orphaned"`。这是**设计内**的界（与 `action:"status"` 读不到内存外 job
  同一条），但本轮没有为「重启后从盘上恢复 orphaned」写任何代码或测试。
- **只在 owner 以同一个 `sessionId` 重新登记时才补投**：宿主如果换了 id，旧 job 不会被补投（本轮没做
  跨 id 认领，也不该做 —— 那会破坏 #654 的「不投给任何存活会话」）。
- 补投的**时序**：本轮测的是「job 已落 `orphaned` 之后 owner 再来 `session_start`」这条顺序。
  真实 `/reload` 里新旧实例与 `session_shutdown` 的到达顺序**没有实测**（本轮的接线格是手工排的顺序），
  所以「reload 窗口里第几次 `session_start` 会触发补投」是按代码路径推出来的，不是量出来的。
- `shutdownTimerSkips` / `orphanRecoveries` 的**上盘时机**：字段在 `jobView` 里恒在场，但 `status.json`
  只在投递/终局/取消那一刻重写 ⇒ 迟到 shutdown 之后、下一次落盘之前，盘上那一份还是旧值（内存视图
  `action:"status"` 是新的）。README 里写了这条口径，但没有为「盘上滞后」单独设闸。
- **登记面本轮已覆盖到的**：TAP 地板与配对地板都在最终树现取（见上表），`skipped` 维（上限 18）本轮
  实测仍是 15 ⇒ 未动；**未覆盖到**的是 `maxSkipped` 的已量最大环境仍拿的是 CI 那侧的历史读数
  （本轮没在 CI 环下重跑），以及 `test/compat-pin-inventory.md` / `test/mutation-samples.md` 本轮靠
  `check:inventory` / `check:mutation` 的 rc=0 间接确认「不需刷」，而不是自己重算一遍表内每个数。
- **本地未跑**（按指示交给 PR 的 CI）：`check:release`、`check:pack-links`、`check:agents-directives`、
  `check:exports:deprecated`、四档类型棘轮 + `check:types-build`、`check:cli-real`、
  各 `--self-test`（含 `docs-drift-check --self-test`）、`check:mutation:run`（常驻变异样本真跑）、
  `check:config-leaf-values` ⇒ 这些**不声称绿也不声称红**。
- **真上游未跑**：`ERIX_E2E_REAL=1` 的 e2e 那 3 格仍是 skip；「pi 真会以同一个 `sessionId` 再跑一次
  factory」这个成因归属仍是 issue 现场 + 代码路径推断，本轮没有真上游复现。
- 未 push、未开 PR、未新建/切换分支。已 **rebase 到 `origin/main = 6507ed1`**（本轮做的正是这件事），
  rebase 后的 `git rebase -i` 只 `reword` 了一笔提交说明（`b388aa5 → af07b9f`），**没改任何内容**；
  主干新带进来的 `bin/reasoning-effort.js` / `test/cli-reasoning-effort-798.test.js` 等一概未动
  （`git diff --numstat origin/main..HEAD` 里 `bin/` 行数为 0）。
