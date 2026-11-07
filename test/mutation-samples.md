# 常驻变异样本表（issue #257 T7）

> **这张表是量出来的，不是写出来的。** 第 4 / 5 / 6 列（`行` / `锚点 sha256[:12]` / `命中`）与末尾的合计行
> 由 `node scripts/mutation-sample-check.mjs --sync test/mutation-samples.md` 从**真树**重算重写；
> 手改这三个数字 = 伪造，`--verify` 会当场红并点名到行。其余列（面 / 目标文件 / 锚点 / 变异 / 捕获者 /
> 期望红签名）是**人写的样本定义** —— 机器不替你决定「该钉哪个行为面」。
> **重复样本**（同一锚点文件 + 同一被变异行，只差编号）也算伪造：`--verify` 红并点名两条编号，
> `--sync` 拒绝写入（它只刷派生列，不会替你删样本）。

## 这张表为什么存在（以及它与 #257 原文的偏差）

#257 那张「测试边界真实性」大单的八层里，T1–T6、T8 都已落在树上（真上游 HTTP、真 CLI 进程、静态守卫、
门控离线自检、发布前消费层、长跑 soak、`messages` 身份契约）。**只剩 T7「常驻变异样本表」**。

原文把 T7 写成「6–10 条通用样本表」，并排在「可选，最慢，最后做」。**那一版没有照做**，理由写在 #257 的
2026-10-31 修订里：2026-10 之后新增的 `--self-test` 家族（`docs-drift-check` / `pack-link-check` /
`retired-spelling-scan` / `test-hygiene-check` / `export-consumer-check`）已经在**各自门禁内部**自带变异自证，
再按原文造一张通用表，等于把已经被覆盖的东西再覆盖一遍。所以本表按修订收窄成：

> **只收「那些 `--self-test` 没覆盖的行为面」** —— 各刀手工做过、验完就散、下一次重构不会因此变红的变异。

具体是五个面、六个捕获者：

| 行为面 | 为什么它不在任何 `--self-test` 的覆盖面里 |
|---|---|
| `state-view` 的三条设计红线（活引用 / `getOnly` 不设 setter / 字段面不泄漏） | 它是 `src/` 里的运行时行为，`--self-test` 家族全在文档 / 打包 / 拼写 / 卫生这些**外围面**上 |
| `state-view` **接线侧**的字段清单（消费者 ctx 的字段漏一项 ⇒ 那一格变成 `undefined`） | 同上；工厂自测钉的是「视图怎么造」，不钉「哪个 ctx 声明了哪些字段」，漏一项时 ctx 的读-改-写静默丢数 |
| `result.messages` 与内部状态数组的**身份**契约 | 同上；#246 接线一动它就会破，而破的时候不会有任何门禁红 |
| provider 的 `retryable` 映射、4xx → `code` 分类、abort 非重试 | 同上（这三条是**宿主可见**的值面：`termination.errorCode` 直接上行） |
| `sessionScanPrefix` 的哈希式（`-c` 续跑按它筛会话） | 同上；它与 `bin/repl.js` / `src/tools/notes.js` 是两份同式实现，漂一边不会有门禁红 |

**不收**：`docs-drift-check` / `pack-link-check` / `retired-spelling-scan` / `test-hygiene-check` /
`export-consumer-check` 各自 `--self-test` 已经钉住的那批（重复一遍只会让 CI 更慢，不会多抓一个 bug）。

## 判据（每一条都能被 `--self-test` 打红）

1. **锚点必须是整行，且在该文件里唯一。** 用「整行相等」而不是子串：行号才是可核对的东西，子串会随缩进与
   同行注释漂移。唯一性不成立时变异会打偏（改到第一处，而捕获者验的是另一处）—— 那种样本比没有样本更坏，
   它会绿得理直气壮。
2. **锚点 sha256 进表（前 12 位）。** 把锚点改宽 / 改窄时，行号照样对、命中数照样是 1，只有摘要抓得住。
3. **期望红签名必须命中 `not ok` 行。** 只要求「非 0 退出」不够：语法错、模块找不到、基线本来红，三种都非 0。
   注意测试名在**通过**时也会以 `# Subtest:` / `ok N -` 出现，所以只认 `not ok N - …`。
4. **还原后必须绿。** 这是「把红归因给变异」的前提：基线本身红的时候，变异后的红什么也不证明。
5. **样本数有下限、id 必须连续。** 让闸变绿最省力的办法是删掉那条咬人的样本：下限挡住「删到 0」，
   连续 id 挡住「删中间一条、其余照旧」。
6. **变异没落地 = 失败**（#210 R2 惯例）：锚点找不到时替换会**原样返回**，那时捕获者当然还是绿的 ——
   若把它读成「变异被抓住」，整条判据就恒真了。脚本把它单独判成「变异没落地」，与「变异没被抓住」分开点名。
7. **（锚点文件, 被变异行）不许重复**（#646 ④）：两条样本打在同一行上，只差编号与措辞 —— 删掉一条，
   闸的覆盖面一点不减，而「一条变异咬一条断言」的账面数量会虚高。判据取**树里的行号**（唯一命中那一行）：
   `--verify` 红并点名两条编号，`--sync` 在重排时拒绝写入；删掉多余的并重排编号之后才绿。

## 表

| # | 面 | 目标文件 | 行 | 锚点 sha256[:12] | 命中 | 锚点（单行真值） | 变异（改成） | 捕获者 | 期望红签名 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M1 | state-view 活引用（getter 不构造时快照） | `src/loop/state-view.js` | 39 | `200476485ce6` | 1 | `      get: get ?? (() => state[key]),` | `      get: get ?? ((s) => () => s[key])({ ...state }),` | `test/state-view.test.js` | `state-view 活引用` |
| M2 | state-view getOnly（不定义 setter、不冻结） | `src/loop/state-view.js` | 40 | `51aa6cc49f6f` | 1 | `      set: getOnly ? undefined : (set ?? ((value) => { state[key] = value; })),` | `      set: set ?? ((value) => { state[key] = value; }),` | `test/state-view.test.js` | `state-view getOnly` |
| M3 | state-view 字段面（不把 state 泄进视图） | `src/loop/state-view.js` | 43 | `db80dcdb8979` | 1 | `  return Object.defineProperties({}, descriptors);` | `  return Object.defineProperties({ ...state }, descriptors);` | `test/state-view.test.js` | `state-view 字段面` |
| M4 | result.messages 与内部数组同一引用 | `src/loop/termination.js` | 676 | `5f067454ae77` | 1 | `      messages: ctx.messages,` | `      messages: [...ctx.messages],` | `test/messages-identity.test.js` | `A1 返回载荷的 messages 与内部状态数组是同一个对象` |
| M5 | retryable 映射（哪些 code 会重试） | `src/providers/errors.js` | 1 | `eeddca598c5b` | 1 | `const RETRYABLE_CODES = new Set(["timeout", "rate_limited", "server", "disconnect"]);` | `const RETRYABLE_CODES = new Set(["timeout", "server", "disconnect"]);` | `test/providers/error-classification.test.js` | `classifyHttpError：429 → rate_limited` |
| M6 | 4xx → code 分类（422 也是 invalid_request） | `src/providers/errors.js` | 115 | `3538a130cd2a` | 1 | `  } else if (status === 400 \|\| status === 422) {` | `  } else if (status === 400) {` | `test/providers/error-classification.test.js` | `classifyHttpError：422 → invalid_request` |
| M7 | abort 分类（`aborted` 永不重试） | `src/providers/errors.js` | 173 | `67dc3cfd6103` | 1 | `  if (isAbortException(err, opts.signal)) {` | `  if (false && isAbortException(err, opts.signal)) {` | `test/app-container-p0.test.js` | `classifies AbortError and aborted signals as non-retryable aborted errors` |
| M8 | sessionScanPrefix 哈希式（`-c` 靠它筛会话） | `bin/session-scan.js` | 41 | `df9e0af01aee` | 1 | `  const hash8 = createHash("sha256").update(normalizedCwd).digest("hex").slice(0, 8);` | `  const hash8 = createHash("sha256").update(normalizedCwd).digest("hex").slice(0, 7);` | `test/session-scan.test.js` | `sessionScanPrefix 就是` |
| M9 | state-view 接线侧的字段清单（漏一项 ⇒ 该字段在 ctx 上变成 `undefined`） | `src/loop/orchestrator.js` | 3993 | `ed509a147bf5` | 1 | `      "toolErrorCount",` | `      "toolErrorCountTypo",` | `test/loop-error-budget-cells.test.js` | `errors.tool=2` |
| M10 | #375 参数错误新出口的事实接线（`max_bytes` 的 received 格断掉 ⇒ 与旧通道对不上） | `src/tools/file-tools.js` | 1599 | `4314da641058` | 1 | `      value: maxBytesRequested,` | `      value: undefined,` | `test/tools/param-error-375.test.js` | `对账 ③ readFile {max_bytes` |
| M11 | state-view 接线侧的字段清单（`providerContext` 面漏一项 ⇒ 该字段在 ctx 上变 `undefined`） | `src/loop/orchestrator.js` | 2850 | `ebeefb88aa8f` | 1 | `      "roundEventDeltas",` | `      "roundEventDeltasTypo",` | `test/loop-fr2.test.js` | `retries a retryable provider error with the original messages` |
| M12 | #567 折叠身份：`foldId` 必须随被折轮区间变化（去掉 `roundRange` ⇒ 两次不同折叠撞同一个 id） | `src/compact/fold-summary-journal.js` | 246 | `29df1d1d7b6d` | 1 | `    roundRange: input?.roundRange ?? null,` | `    roundRange: null,` | `test/loop-fold-identity-567.test.js` | `foldId 随被折轮区间变化` |
| M13 | #567 折叠身份：`seq` 由引擎给（不让宿主从 0 数；不写该键 ⇒ 载荷里没有序号） | `src/compact/fold-summary-journal.js` | 735 | `e7dd1878acdd` | 1 | `    ...(seq === undefined ? {} : { seq }),` | `    ...(undefined ? { seq } : {}),` | `test/loop-fold-identity-567.test.js` | `seq 由引擎给` |
| M14 | #436 预算类停机的交付物补齐轮（机器证据的极性写反：健康 run 被啰嗦 / 失败的 run 不补） | `src/loop/orchestrator.js` | 5102 | `03c17bbf0f31` | 1 | `      if (guardDecision.deliverablesAllPassed !== false) return false;` | `      if (guardDecision.deliverablesAllPassed === false) return false;` | `test/loop-deliverables-gap-436.test.js` | `#436 ① deliverables_failed = 0 ⇒ 不 nudge` |
| M15 | #657 账本归因：`strategyName` 必须写「真正折了的那一层」，不是折叠入口选中的那个（判定退回旧语义 ⇒ 配置策略折 0 轮时仍报配置名） | `src/loop/orchestrator.js` | 4460 | `1c4845fbec9b` | 1 | `      const actualFolderName = strategyFoldedRounds > 0` | `      const actualFolderName = strategyFoldedRounds >= 0` | `test/compaction-strategy-fallback.test.js` | `#657 交叉锁：` |
| M16 | #661 摘要器失败必须**抛出**：把失败改回「返回一份替代物」⇒ 失败的 run 又变成静默成功（用户原话：静默着跑，质量差，也没人发现问题） | `src/compact/fold-llm.js` | 802 | `855c35afffb5` | 1 | `      throw fail(error, first.dropped, limitPart);` | `      return { summary: "（摘要器失败，已降级）", droppedMessages: first.dropped, ...limitPart };` | `test/compact/fold-llm-fail-661.test.js` | `#661-1/2/3/8 必抛 summarizer` |
| M17 | #721 截断声明必须落在**注入正文**里（删掉那一行 ⇒ 模型拿到的残页不再自称是残页，「切在哪个字节」重新变成被测量对象） | `bin/system-prompt.js` | 171 | `ed1d86774160` | 1 | `      + buildTruncationDeclaration(file))` | `      + "")` | `test/project-instructions-716.test.js` | `721 截断时注入正文里出现声明` |
| M18 | #735 run snapshot 的**写侧字段面**：零读者的 `toolUse` 不许回到 payload（把这一格改回写出 ⇒ 「断言它缺省」那格红；同时 `pendingToolUse` 消失，恢复侧拿不到在飞调用） | `src/loop/orchestrator.js` | 2998 | `4bb8ac6de4c7` | 1 | `        pendingToolUse: cloneState(snapshotPendingToolUse),` | `        toolUse: cloneState(snapshotPendingToolUse),` | `test/loop-snapshot-write-side-735.test.js` | `不再带 toolUse / ts 这两格零读者字段` |
| M19 | #736 崩溃现场的**识别源**：边界必须能从账本推出，不许退回「只认快照」（退回 ⇒ #734 那次写失败的正是快照本身，悬空 `tool_use` 落回中段，每次请求在出网前被本地校验器拒掉） | `src/loop/resume-manager.js` | 528 | `b222bba7fc79` | 1 | `      if (crashSiteRound \|\| ledgerBoundary !== null) {` | `      if (crashSiteRound) {` | `test/loop-resume-ledger-crash-boundary.test.js` | `夹具：陈旧快照 + 宿主预写行盖住崩溃现场` |
| M20 | #736 边界的**后半归属判据**：崩溃行之后只许出现结果行 / 宿主预写行 / 引擎控制行（去掉这一半 ⇒ 崩溃前已落盘的引擎正文也被当成尾队列，#425 那条「尾行判引擎 ⇒ 零请求」的边界一起被推翻） | `src/loop/resume-manager.js` | 171 | `e8692e686616` | 1 | `      if (!isPostCrashEntry(entries[tail], tail)) return null;` | `      if (false) return null;` | `test/loop-ledger-crash-boundary.test.js` | `边界：崩溃行之后混进崩溃` |
| M21 | #736 中段桩的**排除集**：马上要补跑出真结果的 id 不许再被桩占（去掉 B 集合那一格 ⇒ `t2` 的真结果被「结果没落盘、结局未知」的桩**顶掉**：id 数照样对、本地校验器照样过，只有这条会红 ⇒ 断言面不能只数 id） | `src/loop/resume-manager.js` | 705 | `c0700f4d6e7c` | 1 | `      for (const pendingTool of ctx.resumePendingTools) {` | `      for (const pendingTool of []) {` | `test/loop-resume-ledger-crash-boundary.test.js` | `评审补格：崩溃行带` |

| M22 | #738 续跑回填的**逐字面**：读侧有 `fedSummaryText` 就必须原样回放（把这一行短路 ⇒ 回填退回 `.summary`，模型看到的摘要换字节，而请求合法、`validateMessages` 通过 ⇒ 没有任何闸会红） | `src/compact/resume-fold-trim.js` | 195 | `d9124e0df304` | 1 | `  if (exact !== undefined) return accountReplay(exact, exact, FOLDED_SUMMARY_FED_TEXT_KEY);` | `  if (false) return accountReplay(exact, exact, FOLDED_SUMMARY_FED_TEXT_KEY);` | `test/compact/fold-fed-summary-738.test.js` | `#738-E 读侧逐字（判据 2）：fedSummaryText 在场 ⇒ 回填等于当年 fed 的那串（不 trim、不剥正文）` |
| M23 | #738 摘要块的**身份**：写侧只认「钉住的那一块」，同文正文块不算证据（丢掉「必须落在插入约定那个下标」⇒ 摘要块被夹断后，同一条新消息里保留的正文块会被当成当年 fed 的摘要写进账） | `src/compact/fold-summary-journal.js` | 120 | `06cb8b73b592` | 1 | `    if (content.indexOf(hits[0]) !== FOLD_SUMMARY_BLOCK_SLOT) return undefined;` | `    if (false) return undefined;` | `test/compact/fold-fed-summary-738.test.js` | `#738-G2 同文歧义一律不写：同一条消息里两块同文 / 两条新消息都命中 / 命中的不是插入下标` |
| M24 | #741 归档丢弃计数必须是**算出来的**（置 0 ⇒ `foldArchive` 键永不出现，「归档把原文丢了」重新变成静默） | `src/compact/fold-archive.js` | 217 | `5f6a54196144` | 1 | `    droppedMessages = payload.length - kept.length;` | `    droppedMessages = 0;` | `test/compact/fold-note-honesty-741.test.js` | `③归档夹断丢掉原文` |
| M25 | #741 折叠替代物的广告语必须由笔记证据决定（恒走「有笔记」那一句 ⇒ 没笔记时也宣称有，且 `note_*` 重新出现在无工具的提示里） | `src/compact/helpers.js` | 55 | `8bf2a60d4a49` | 1 | `  return noteRecall?.available === true` | `  return true \|\| noteRecall?.available === true` | `test/compact/fold-note-honesty-741.test.js` | `①折叠替代物：整族笔记工具在面上但账本里没有笔记` |
| M26 | #741 TTL 的取回指引必须由笔记证据决定（把证据分支写死成「有笔记」= 评审必修 1 的缺陷字面） | `src/loop/tool-result-ttl.js` | 497 | `a135a49fb2c7` | 1 | `  if (recall?.available !== true) return unverifiedRetrievalHint(retrievalCommand, recall?.reason);` | `  if (false) return unverifiedRetrievalHint(retrievalCommand, recall?.reason);` | `test/compact/fold-note-honesty-741.test.js` | `①TTL 占位符：笔记为空` |
| M27 | #741 写入证据必须由**配对结果 + 载荷证实**决定（放行 ⇒ 未配对/`invalid`/解不出的载荷都算「有笔记」） | `src/loop/tool-result-ttl.js` | 169 | `9adf8b005cb0` | 1 | `        if (!payloadConfirms(paired, NOTE_WRITE_OK_STATUSES)) {` | `        if (false) {` | `test/compact/fold-note-honesty-741.test.js` | `证据判定：工具面整族齐全` |
| M28 | #741 撤销必须真的作废（只清 key 不记账 ⇒ 撤销过的笔记仍被当成可查，且原因退回「无笔记写入」） | `src/loop/tool-result-ttl.js` | 182 | `d6c861400386` | 1 | `        if (live.delete(key)) sawRevoke = true;` | `        if (live.delete(key) && false) sawRevoke = true;` | `test/compact/fold-note-honesty-741.test.js` | `证据判定：工具面整族齐全` |
**合计 28 条样本 / 14 个目标文件 / 18 个捕获者**

> 单元格里的 `\|` 是**转义的竖线**：markdown 表格里写不出裸 `|`（会把整行拆成多列），所以 M6 锚点里的
> `||` 存成 `\|\|`，脚本读的时候还原成 `||`。这条转义回环由 `--self-test` 的第 ㉒ 例钉住（不转义 ⇒
> 那一行被拆成 11 列 ⇒ 表读不成 ⇒ 红）。

## 复跑方法

```bash
# 1) 验表：表 ↔ 真树逐条对账（行号 / 锚点 sha256 / 命中数 / 捕获者 / 合计行），不改文件
node scripts/mutation-sample-check.mjs --verify test/mutation-samples.md; echo "EXIT=$?"   # ⇒ EXIT=0

# 2) 真跑：逐条「变异写进真文件 → 捕获者必须红在该报的断言上 → 还原 → 必须绿」
node scripts/mutation-sample-check.mjs --run test/mutation-samples.md; echo "EXIT=$?"      # ⇒ EXIT=0

# 3) 反向证（内存夹具，不落盘、不碰真树）：改坏 → 红、干净 → 绿、--sync 只改派生列、变异没落上也算失败
node scripts/mutation-sample-check.mjs --self-test; echo "EXIT=$?"                        # ⇒ EXIT=0

# 4) 真值漂了怎么办：**机器刷表**，不许手改数字
node scripts/mutation-sample-check.mjs --sync test/mutation-samples.md
node scripts/mutation-sample-check.mjs --verify test/mutation-samples.md; echo "EXIT=$?"   # ⇒ 必须 EXIT=0
```

CI 的阻塞步序（`.github/workflows/ci.yml`）：`npm run check:mutation`（验表，亚秒级）→
`node scripts/mutation-sample-check.mjs --self-test`（反向证）→ `npm run check:mutation:run`（真跑，约 10 s）。
三条分开的理由与其它 `--self-test` 家族一致：**验表证的是「今天的表与树对得上」，反向证证的是「判据还拦得住」，
真跑证的是「这些变异真的会被闸咬住」** —— 三者缺一条，另外两条都能绿着骗人。

## 纪律

- 改动被本表锚定的 `src/` / `bin/` 真值 ⇒ `--verify` 红 ⇒ 跑 `--sync`（diff 里能看见行号与摘要变了），
  **不要手改**；`--sync` 之后再跑一次 `--run`，确认变异仍然咬得住。
- 新做过的变异值得常驻时：往表里加一行（id 重排、`面` 写清「钉的是哪个行为」），然后 `--sync` + `--run`。
  加行的门槛是**它现在真的会红**：`--run` 会替你验，绿着加进来是加不进的。
- 删样本要连 id 一起重排，并且把 `MIN_SAMPLES` 下限一起降（降要写理由）；只删行不改下限 ⇒ `--verify` 红。
- **合并平行分支时先查重复**：两条分支各自重排编号，并集里很容易长出 `M4 ≡ M14`（同锚点、同一行）。
  `--verify` 会点名两条编号，`--sync` 会拒绝写入 —— 删掉一条、重排编号，再 `--sync` + `--verify`。
