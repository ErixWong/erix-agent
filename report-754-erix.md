# #754 裁决 2（选 Y：关掉 pre-261021 档案的恢复）执行报告 — erix

## 取证边界

实际打开/跑过的（全部在本工作树 `/home/eric/wt-754-erix`，分支 `fix-261108-02-legacy-gate-erix`）：

- `.task-issue-754.md`（裁决全文，重点读裁决 2 / 判据 / 归属三节）
- `src/loop/resume-manager.js`（530-700、760-855 段；恢复锚点、被删闸门、告示调用点）
- `src/loop/resume-notice.js`（全文 212 行 → 改后 233 行）
- `src/loop/orchestrator.js:5455-5495`（`resumeNotice` 的注入与 `:control:` 入账位置）
- `src/messages/rounds.js:112-120`（孤儿 `tool_result` 的抛错点）
- `test/loop-snapshot-round-residue-735.test.js`（全文分三段读完）
- `test/fixtures/journal-0.22.0/work-c7d61121-mvi9c4fj-77f54351.jsonl` / `.snapshot.json`（只读，未改）
- `CHANGELOG.md`（只看 `## [Unreleased]` 与中英配对惯例；本单只加这一处）
- `package.json` 的 scripts（只为决定跑哪些门禁）
- 跑过的命令：`node --check` ×2、`node --test test/loop-snapshot-round-residue-735.test.js`（多次）、
  `node --test` 邻近 8 个 resume/journal 文件、`git archive HEAD~2 | tar -x -C /tmp/base754` + 在副本里跑
  `node --test test/loop-resume.test.js test/loop-resume-unpersisted-tool-results.test.js`（对照基点）、
  两个自写探针 `/tmp/probe-754.mjs`、`/tmp/probe-754b.mjs`
- **没有看**：`docs/host-consumer-contract.md` / `docs/host-consumer-contract_cn.md`（本单禁改，一个字都没读进改动）、
  全量 `npm test`、`check:types`、`check:release`、`check:pack-links`、`check:mutation:run`（主 agent 负责）、
  `docs/design/observability-ledger.md`、`docs/maintenance/command-reference.md`、`test/compat-pin-inventory.md`、
  `test/test-suite-baseline.json`（未读未改，见「需要主 agent 重取的派生值」）
- 读不到的路径：无（没有 `BLOCKED` 项）

## 基点

逐字照抄工具返回里出现过的字面值（括号里是产生它的那条命令）：

- `HEAD=8de0d9f`、`BASE=762ef52`（`git rev-parse --short HEAD` / `git rev-parse --short HEAD~4`）
- `762ef52 Merge pull request #771 from ErixWong/feat-261107-15-erix-run-steer-action`（`git log --oneline -1 HEAD~4`）
- 本次三个提交（同一命令的输出）：`840db57 docs(#754 裁决2): CHANGELOG Breaking 中英各一条 + 执行报告 report-754-erix.md（实测形状、出声机制、邻近 7 条连带红点定位）`
  / `df1372d test(#754 裁决2): …` / `bb86b59 fix(#754 裁决2): …`
- `ANCHOR 3 snap.round 2`（`node /tmp/probe-754b.mjs` 尾行；早先一轮 `node /tmp/probe-754.mjs` 还返过
  `snap.messages.length 5 nonNull 5 toolResults [ 'chatcmpl-tool-80778b291064178e' ]`）
- 现场摘要（`node /tmp/probe-754b.mjs` 的 JSON，两跳与双崩两棵逐字同值；下面每行都是返回里的原行）：
  - ` "mode": "twohop",`（另一棵是 ` "mode": "double",`）
  - ` "crashed": false,`
  - `"firstOk": false,`
  - `"firstError": "invalid_messages: Invalid message at index 3: user tool_result has no matching assistant tool_use",`
  - `"firstRequests": 0,`
  - `"firstMarkers": 0,`
  - `"secondOk": false,`
  - `"secondError": "invalid_messages: Invalid message at index 4: user tool_result has no matching assistant tool_use",`
  - `"secondRequests": 0,`
  - `"latestRound": 2,`
  - `"latestMarkers": 1,`
  - `"anchorAfter": 5`
- 本特征用例文件结果（`node --test test/loop-snapshot-round-residue-735.test.js`）：`# tests 7` / `# pass 7` / `# fail 0`
- 邻近 8 文件结果（同一轮 `node --test` 那 8 个文件）：`# tests 95` / `# pass 88` / `# fail 7`
- 基点对照（`/tmp/base754`，`git archive HEAD~2 | tar -x` 后在副本里跑两个红点文件）：
  `# tests 51` / `# pass 51` / `# fail 0`
- 告示文本（`node /tmp/probe-754.mjs 2>&1 | grep -o '本次恢复丢弃了[^\\]*。'` 的原样输出）：
  `本次恢复丢弃了 pre-261021 档案中只存在于快照的崩溃轮正文（共 2 条，该格式已不再支持恢复）。`
  （入账行由 `node /tmp/probe-754.mjs | grep ^CONTROL` 给出：
  `CONTROL work-c7d61121-mvi9c4fj-77f54351:engine:round:2:control:resume-notice:79d2df882e96f23a`）
- 告示体积与指纹（`node -e … buildResumeNotice({round:2,…,legacySnapshotBodyDropped:2}) --input-type=module`）：
  `694 resume-notice:79d2df882e96f23a 5`

## 实际改了什么

1. `src/loop/resume-manager.js:581-591` —— **删掉升级闸门**：原来的
   `if (ledgerMessages.length === anchor && snapshotBody.length > anchor) { … push(cloned) … }` 整块删除，
   连同上面「升级路径（不是旧逻辑的残留）…一份快照正文也不会多喂」那 5 行措辞换成 #754 的裁决说明。
   原条件**只留来数条数**：`ctx.resumeLegacySnapshotBodyDropped = … ? snapshotBody.length - anchor : 0`
   （`src/loop/resume-manager.js:589-591`）。写侧一行未动。
   删后 `grep -n "snapshot\." src/loop/resume-manager.js` 显示对 `snapshot.messages` 的读取**只剩 588 行这一处**，
   且只用于计数；快照的其余来源（`toolResults:660`、`toolOutputs:666`、`executedToolIds:656`、
   `pendingToolUses:698`、`partialText:633`）都不是正文通道。
2. `src/loop/resume-manager.js:593-594`、`:601-604`、`:681-682` —— 三处失效措辞改口
   （「升级补全的那段」「升级路径会把崩溃轮正文补进内存」「升级路径可能已把结果补进上下文」），
   #424/#420 的守卫判据本身没动。
3. `src/loop/resume-notice.js:53-54` 新增 `export const RESUME_NOTICE_LEGACY_SNAPSHOT_DROPPED_HEADER`；
   `:178-187` 在告示里插入一行（条数为 0 ⇒ 整行缺席）；`:227` 由 `planResumeNotice` 传
   `legacySnapshotBodyDropped: ctx?.resumeLegacySnapshotBodyDropped`；`:150-158` 更新 `@param facts` 说明。
   **没有**新增事件类型，**没有**给 `resume_journal_skipped` 加 reason，**没有**碰契约文档。
4. `CHANGELOG.md:6-32` —— `## [Unreleased] → ### Breaking` 下中英各一条（成对）。

## 用例改动

`test/loop-snapshot-round-residue-735.test.js`（6 tests → 7 tests，全绿）：

- `:151-171` 判据函数 `assertCrashRoundBodyFed`（断「恰 1 份喂进来」）→ `assertCrashRoundBodyNotFed`
  （断「每一次请求都是 0 份」），并新增 `noticeTexts(store)` 从 `:control:resume-notice` 行取告示正文。
- `:174-201`（原 ①，旧标题「升级路径仍把它喂给模型」）→ 「#754 裁决 2 · ① …该恢复路径已关掉，一份正文也不喂」。
  前后对比：旧 `assert.equal(resumed.ok, true)` + `assertCrashRoundBodyFed` ⇒ 新
  `assert.equal(resumed.ok, false)` + `assert.match(... /Invalid message at index 3: user tool_result has no matching assistant tool_use/)`
  + `assert.equal(resumed.provider.requests.length, 0)` + `assertCrashRoundBodyNotFed`。
- `:270-309`（原 ② 双崩现场）→ 「双崩现场在关掉之后不再发生」。旧断言
  `assert.ok(scene.crashed)` / `latestRound > fixtureSnapshot.round` / 三条快照残余形状 ⇒ 新断言
  `scene.crashed === false`、`scene.latestRound === fixtureSnapshot.round`、两跳都 `ok === false`
  且分别是 index 3 / index 4 的孤儿 `tool_result`、两跳都 0 次请求。与「写回整段」副本引擎的 `deepEqual` 对账保留。
- `:384-416`（原 ④b）→ 「变异『删掉残余』⇒ 失败形状不变但告示不再报 N；只拿掉锚点之前的前缀 ⇒ 逐字不变」。
  旧：变异一红在 ① 的孤儿结果（正文没了）、变异二要求 ① 仍红且 `assertCrashRoundBodyFed` ⇒
  新：变异一仍报同一条孤儿结果，但**告示不再出现那句丢正文**（读侧对快照正文只剩计数这一个读取点）；
  变异二改为「与未变异现场逐字同形」（`ok` 相等 + `error` 逐字相等 + `noticeTexts` deepEqual）。
- `:563-601`（原第 520 行那条特征用例，旧标题「两跳恢复记录当前行为（主干既有缺陷，修好见 #754）」）
  → 「#754 裁决 2 · 两跳恢复（关掉之后）：旧档案两跳都以孤儿 tool_result 失败、旧正文一份不喂」。
  四条「当前行为」逐条翻面：`second.ok false→false` 但原因从 `assistant tool_use has no immediately following
  user tool_result`（闸门喂出来的悬空 tool_use）换成 `user tool_result has no matching assistant tool_use`
  （实测形状，原样写进断言）；`second.requests.length` 仍钉 0；`countMarker(latestMessages)` 由 0 改钉 1
  （引擎从未获得覆盖写快照的机会，夹具那份仍是原样）；新增 `assert.doesNotMatch(... "has no immediately following user tool_result")`
  钉死「悬空 tool_use 那个旧形状已消失」。标题里的「主干既有缺陷，修好见 #754」口吻已去掉。
- **新增用例（第 3 步）**：`:620-…`「#754 裁决 2 · 关掉旧格式恢复不许静默：旧账本的恢复告示说出丢了 N 条，新账本一声不出」。
  前置钉 `dropped === 2`（= `fixtureSnapshot.messages.slice(ANCHOR)` 的非 null 条数）；旧账本跑一次恢复后
  从账本取告示，断 `includes(RESUME_NOTICE_LEGACY_SNAPSHOT_DROPPED_HEADER)` 且
  `includes("（共 2 条，该格式已不再支持恢复）")`；再把 round 2 的行补进账本造出**新账本**现场
  （`freshLedger > ANCHOR`），断恢复 `ok === true` 且告示里**不含**那句（一声不出）。

## 出声机制

- 通道：`src/loop/resume-manager.js:836` 的 `ctx.resumeNotice = planResumeNotice(ctx, records, pendingTail)`
  （唯一调用点，未新增事件类型/reason）→ `src/loop/orchestrator.js:5472-5486` 把它推进 `messages`
  并按 `:control:<slot>:<fp>` 入账，既进模型上下文也在恢复结果里给宿主（既有行为，未改）。
- 文案原文（实测取回，常量在 `src/loop/resume-notice.js:53-54`）：
  `本次恢复丢弃了 pre-261021 档案中只存在于快照的崩溃轮正文（共 2 条，该格式已不再支持恢复）。`
  完整告示第 2 行就是这一句，实测整条（入账行 `…:control:resume-notice:79d2df882e96f23a`）：
  `【恢复运行】这是一次崩溃后的恢复运行，不是连续会话：上一段停在第 2 轮；停机原因未入账（进程被终止或崩溃）。`
  / `本次恢复丢弃了 …（共 2 条，该格式已不再支持恢复）。`
  / `崩溃时尾部没有未结清的 tool_use（上一次请求与结果已成对落账）。`
  / `账本记录：最近调过的工具 readFile(a.txt)。` / `动手前先勘验：…`
- 触发条件：与被删 `if` 逐字同条件 —— `ledgerMessages.length === anchor && snapshotBody.length > anchor`
  （`src/loop/resume-manager.js:590-591`），N = `snapshotBody.length - anchor`；条数为 0 时整行缺席。
- 旧账本出什么声：上面那句（N=2），且第一次恢复以孤儿 `tool_result` 失败。
  新账本出什么声：什么都不多出（`resumeNotice` 里不含该行；`test/loop-resume-notice.test.js` 钉的
  「四行 / ≤1024 字节」也未受影响（实测该文件 `# tests 8` / `# pass 8` / `# fail 0`）。

## 未碰隔壁文件声明

`docs/host-consumer-contract.md` 与 `docs/host-consumer-contract_cn.md` **一个字节都没改**（`git status --short`
只有 `M CHANGELOG.md` 与本两份未跟踪文件 `.task-issue-754.md`/`.erix-run/`、`report-754-erix.md`）。
也没有任何门禁逼我改它们：本单没跑它们相关的门禁（见下一节）。
另外 `src/store/*`、`src/messages/rounds.js`、`src/loop/orchestrator.js` 均只读未改。

## 未跑的门禁

`npm test`（全量）、`npm run check:types`、`check:release`、`check:pack-links`、`check:mutation:run`
（任务禁止）；另外这些我也没跑，请主 agent 补：`check`、`check:syntax`、`check:docs`（CHANGELOG 双语配对 +
docs 漂移）、`check:changelog`、`check:tests`（test-hygiene）、`check:test-summary`、`check:inventory`、
`check:exports`、`check:docs-examples`、`check:final-guard-probe`、`check:host-consumers`。
我只跑了 `node --check` 两个改动文件 + 8 个点名测试文件 + 2 个探针。

## 需要主 agent 重取的派生值

只列名字与命令（我一个都没手改）：

- 全套 TAP 计数地板（本文件 6 → 7 tests，净 +1）：`node scripts/suite-summary-reconcile.mjs`
- 兼容点行（新增/改名的用例名）：`node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md`
- 变异样本表（④b 的两条判据换了红点）：`node scripts/mutation-sample-check.mjs --verify test/mutation-samples.md`
- CHANGELOG 覆盖与双语配对：`node scripts/changelog-coverage-check.mjs`、`node scripts/docs-sync-check.mjs`
- 观察台账里若登记了「恢复告示」文本面：`node scripts/docs-drift-check.mjs`

## 结论

1. 升级闸门已删，恢复路径不再从 `snapshot.messages` 喂正文；唯一残留的读取是 `src/loop/resume-manager.js:588`
   的那一次 `Array.isArray(snapshot.messages)`，只为数条数（第 3 步要求的原条件），不是正文通道。写侧未动。
2. 关掉之后的实测形状（不是「恢复成功」）：pre-261021 档案**第一次恢复就**以
   `invalid_messages: Invalid message at index 3: user tool_result has no matching assistant tool_use` 失败，
   0 次模型请求；第二跳是同一次失败的重复现场（多一条告示 ⇒ 下标移到 4）。
   原因：崩溃轮那条已成型结果仍从 `snapshot.toolResults` 接回（`src/loop/resume-manager.js:660` → `:683`，
   它的筛子只问「这个 id 进账本了没有」），而带它 `tool_use` 的 assistant 不再被喂 ⇒ 孤儿结果，
   由 `src/messages/rounds.js:118` 的配对校验在第一次请求之前抛出 ⇒ 宿主拿到响亮失败。
   **这条路径由 `src/messages/rounds.js:118`（`validateMessages`）兜底**，本单按裁决没有为变绿去恢复喂正文，
   也没有新增事件/reason。
3. 出声走既有 `:control:resume-notice` 通道，文案与条数 N 已钉进新用例；新旧两种账本只有旧的会出声（实测 N=2）。
4. 本特征用例文件 7 tests / 7 pass（`node --test test/loop-snapshot-round-residue-735.test.js`）。
5. 邻近面（**本改动引入，需要主 agent 定夺**）：`node --test` 八个 resume/journal 文件得 95/88/7，
   同一批在基点副本（`git archive HEAD~2` → `/tmp/base754`）是 51/51/0 ⇒ 下面 7 条红点确实是我这次关掉闸门造成的，
   它们的现场全部是「崩溃轮正文只在快照里」的 pre-261021 形状，判据仍写着旧世界的「喂进来」：
   - `test/loop-resume-unpersisted-tool-results.test.js:412`（#424 升级路径 · 三态自证）
   - `test/loop-resume.test.js:435`、`:494`、`:582`、`:645`、`:773`、`:834`（六条全是
     `Invalid message at index 1: user tool_result has no matching assistant tool_use`）
   建议的处置（本单预算内没做，也不该顺手做）：把这 7 条的夹具改成 261021 之后的形状（崩溃轮正文自己入账），
   或按 ① 的方式翻成「断言弃用」；这属于「把主干其余角落的 pre-261021 期望一并改判」，需要主 agent 认域后另开一刀。

## 未验证

- 上面 7 条邻近红点我只证实了「基点绿、本树红、错误原文」，没有逐条读它们的夹具源码判定每条应怎么翻。
- 没跑任何全量/门禁类命令，因此以下都可能仍红而未被我看见：`check:docs`（CHANGELOG 行宽/配对细节）、
  `check:test-summary`（测试总数 +1）、`check:inventory`（用例改名 `两跳恢复记录当前行为…` → 新标题，
  `test/compat-pin-inventory.md` 若按用例名点行会漂）、`check:mutation`（④b 的红点定义变了）、
  `check:exports`（`resume-notice.js` 多了一个 `export const`，`docs/design/observability-ledger.md`
  一类派生表可能要求登记）。
- 没验证「恢复结果里给宿主」那条出口在新文案下的具体形状（只验证了它进 `messages` + 入账行）；
  `test/loop-resume-notice.test.js` 的 1024 字节 / 四行锚点在新账本场景不变，但**旧格式**场景的告示字节数
  我没单独测过（实测重造同一份事实：694 字节 / 5 行 / 指纹 `resume-notice:79d2df882e96f23a`，
  与入账行一致，仍在 1024 预算内，但没有用例钉它）。
- `git status` 里 `.erix-run/` 是引擎自己的运行目录，未纳入提交；`.task-issue-754.md` 与探针脚本也没提交。
