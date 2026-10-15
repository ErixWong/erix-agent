# soak 长跑观察脚本（`scripts/soak.mjs`）

issue #257 的 T6（返工轮判据：#290 审阅结论 → T6-fix 工单，任务档案只在本机 `docs/tasks/` 下，不入库）。把「长轮回放 + 多次强制压缩 + **TTL 折叠** +
中途 abort + `resumeRunSnapshot` 续跑 + 落盘一致性」压进**同一个 store**里跑，专门覆盖单测 /
随包契约套件 / `examples/` 真机 gate 都不覆盖的「压缩 / 治理 / 快照三套同时压热」场景。

**定位：只观察引擎，不修改引擎。** 脚本发现引擎缺陷只写进报告（`engineDefects[]`），不顺手改 `src/`。

## 用法

```bash
# 便宜自测（不联网、一次真模型都不打；CI / 无 key 环境可用）
# 轮数必须 >=6：更少就压不出 TTL 折叠（引擎 TTL 层要求剩余轮数 > 2），脚本会把它判红而不是空跑
node scripts/soak.mjs --provider fake --rounds 6 --store "$(mktemp -d)" --out /tmp/soak-fake-report.json

# 真模型长跑（模型/端点/凭据从 ~/.erix/config.json 的 slots.default 读，源码里没有模型名）
ERIX_E2E_CONFIG=~/.erix/config.json node scripts/soak.mjs --provider real --rounds 200 --out /tmp/soak-real-report.json
```

参数：`--rounds <n>`（默认 200）、`--store <dir>`（默认临时目录）、`--out <file>`（默认
`/tmp/soak-report.json`）、`--compact-every <n>`、`--abort-at <n>`（中止阶段的开关与触发点，见下）、
`--provider fake|real`（默认 real）、`--slot <name>`（默认 `default`）、`--keep-store`。`npm run soak` 等价于直接跑脚本。

红线：**`--store` / `--out` 解析后若等于真实 `~/.erix` 或落在它之下，脚本干净拒绝（exit 2）并打印用法**，
不会先把文件写进去再报错。默认清理脚本自己 `mkdtemp` 出来的临时 store；**显式 `--store` 指定的目录
永不删除**（那是宿主的地盘），要保留自建临时目录用 `--keep-store`。

## 它在断言什么

`assertions[]` 每项 `name` / `pass` / `blocking` / `evidence`，名单与条数由 `test/soak-script.test.js`
的 `EXPECTED_ASSERTIONS` 逐条钉住（加一条或漏一条都红）。fake 路径下**每一条都必须 `pass:true`**：
「非阻断观察项」不是免罪符。覆盖：

- **长轮回放**：真上游**允许提前 `end_turn` / `judge_done` 收尾**（那不是缺陷），判据是「干净收口 +
  轮数够逼出压缩」；`max_rounds_cap` 带 `truncated:true` 是引擎的正确标记。`no_tool` **不算**干净收口
  （它是 prose 停滞被治理层撑住后的停局，见 `src/reflection/governor.js:112-113`）。
  **强制压缩**靠把 `context.budgetTokens` 调到几个轮次的量级逼出来（不指望自然触发）。
- **TTL 折叠真的发生**（`ttl-fold-actually-applied`）：`toolResultTtl` 传给引擎的是**数字**
  （`src/loop/orchestrator.js:321`；传对象会被 `src/loop/tool-result-ttl.js` 的 `!Number.isFinite(ttl)`
  原样退回消息，等于没开）。证据两路互证：引擎 TTL 层记账（折叠条数、省下的 token、发生在第几轮）+
  实际请求视图里看到的折叠占位符（被折块的 `erix.round` 与当时 `currentRound`、折叠前后 token）。
- **三方对账**：`<runId>.jsonl` 行数 / `store.load()` 的 `RoundRecord` 数 / 事件流累计的 `round_end` 数。
  口径写在证据里：`jsonl 行数 = 引擎轮记录 + 1 条 seed 记录`。那条 seed 不是「`initialUserMessage` 自己占一行」：
  `initialUserMessage` 只进内存消息（`src/loop/orchestrator.js:1412-1413`），轮记录写的是
  `messages.slice(roundStart)`（`:2904`）；seed 是**非 resume 分支专门归档的 `round=0` 记录**
  （`src/loop/resume-manager.js:274-289`，`dedupKey=<runId>:engine:round:0:seed`，无 `response`），
  为的是 ADR-002 的档案完整性。`round_end` 只等于引擎轮记录数（seed 不是轮）。
- **契约事实**：`tool_result` 块的 `erix.{toolCallKey,round,durationMs,success}` 齐、顶层无退役名、
  `toolCallKey` 全局唯一、投影 `toolCalls[]` 的 key 集合与落盘**双向相等**、投影/落盘两侧的
  `durationMs` **键集合双向相等**（整条漏掉也算红）且逐条相等、缺失不写成 0。
  `erix.executionStatus` 有两条独立断言：一条查「已有值只在 `intercepted`/`interrupted` 里」，
  另一条查**存在性**——写了 `erix.success` 的块（真正执行过的）必须根本没有 `executionStatus` 这个键
  （两个特殊状态按契约都不写 `success`，所以两者互斥；只查白名单会允许普通成功块带上 `interrupted`）。
- **压缩/TTL 折叠后的配对合法性**：喂进断言的是**实际发给上游的消息视图**（脚本给注入的 provider
  包了一层，把每次 `chat`/`chatStream` 收到的 `request.messages` 抓下来；真实折叠只作用于请求副本，
  `src/loop/provider-runner.js:51-57`，`runToolLoop` 返回的 `messages` 是未折叠的）。通过条件是
  `validateMessages(view, {allowPendingToolUse:false})`（`src/messages/rounds.js:43`）零报错
  **且** `orphanResults === 0 && danglingUses === 0`；协议转换照跑，但它不再充当配对判据——
  两个转换器本身不校验配对，「转换没抛错」是空断言。
- **abort**：先查**脚本自己有没有真的中止过**（`abort-actually-fired`，阻断项），再让引擎断言说话。
  - 触发点：默认在第 `min(ceil(rounds/2), 3)` 个**已落地的 `tool_result` 事件**之后立刻 abort；
    显式 `--abort-at n` 则改回**第 n 轮**触发（轮数语义）。理由：真模型会在任意早的轮次自然
    `end_turn` / `judge_done`，按轮次触发永远可能扑空（实测 `--rounds 200 --abort-at 100` 的 run 第 7 轮就收口）。
  - `abort-termination-reason-is-aborted`（非阻断，已知缺陷 #282）与 `abort-error-carries-usage-rounds-partial`
    （阻断）**只在真的触发过时才判**；没触发时两条都报 `coverage: "not-exercised"` 并计入非阻断观察——
    「脚本没中止成」是脚本的配置问题（由 `abort-actually-fired` 承担红），不能拿它算引擎缺陷。
    没触发的**根因**另写进 `unfiredDiagnosis`：触发点没踩到（脚本配置）还是上游在触发点之前就报错收口
    （本阶段本次没被覆盖，附 `upstreamMessage` / `upstreamCode`）——后者不该让人误读成「soak 又扑空了」。
  - 触发过之后：必须抛标准错误（`termination.reason === "aborted"` 且带 `usage`/`rounds`/`partial`）；
    实际观察到的终局 `reason` 另记进 `abortObservedReason`（issue #282 的第一手数据）。
  - **`issue282Rewritten` 是需要 abort 真触发才成立的结论**：只有 `abortFired === true` 且观察到的终局
    `reason === "judge_done"` 时才允许为 `true`（字段面：`abortStage.{abortFired,abortedAtRound,naturalTermination,coverage}`，
    `coverage` 取 `abort-fired` / `not-exercised` / `stage-skipped`）。旧版非抛分支不带 `abortedAtRound`、
    evidence 又用 `?? cli.abortAt` 兑底，于是「第 7 轮自然 judge_done、根本没中止」的 run 被报成
    `abortedAtRound: 100` + `issue282Rewritten: true`——那是假阳性，不是 #282 的一手复现。
- **resume**：续跑成功；历史块逐字节不被回写；新块新 `toolCallKey` 不撞历史；特殊状态块
  （引擎只写 `interrupted`/`intercepted`）不被 judge/L0 的读取面读成成功——这条自带一个确定性场景
  （形状照引擎写入点抄，读取面用仓里真函数 `buildTimeline` / `extractL0Facts`），并配一个「换成普通
  成功块必须读成 `ok`」的正控制，所以「本轮没有特殊状态样本」不会退化成空过。
- **未处理拒绝**：只有 `KitError` 且 `code === "aborted"`（`src/providers/errors.js:174` 的分类路径）
  算已知引擎观察项；**其余未处理拒绝算阻断性 soak 缺陷**（红 + 非 0 退出）。fake 不产生 in-flight
  网络拒绝，所以这条的真实覆盖靠 `--provider real`。

阻断性断言（`blocking: true`）任一 FAIL → 退出码 1；与已知引擎缺陷相关的观察项标 `blocking: false`，
只进报告不影响退出码——这样「引擎有已知缺陷」与「soak 脚本自己坏了」不会混成同一个红。
CLI 解析与 `~/.erix` 归属拒绝走退出码 2。
