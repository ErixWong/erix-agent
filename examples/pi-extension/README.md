# erix_run — pi extension（pi 调度 erix 修代码）

把 **erix-agent 的 `runToolLoop` 内嵌成 pi 的原生工具**：pi（人机协同侧）把一个自包含的编码
子任务交给 erix（无人值守 headless 运行时），erix 在指定目录里跑完整的多轮工具循环（读写文件、
执行命令、压缩上下文），终局以结构化载荷交回 pi 模型。

这是「pi = 交互式 agent，erix = headless agent，互补而非竞争」（见仓库根 `AGENTS.md` §1）的落地形态：
**pi 负责编排与人机界面，erix 负责一次完整的无人值守执行**。

## 文件

| 文件 | 作用 |
|---|---|
| `erix-run.ts` | pi 扩展本体：`defineTool` 注册 `erix_run`、参数 schema、分流（同步 / 异步派工 / `action` 查询）、进度通道（`onUpdate`）、完成通知投递与生命周期接线。**结果形状不在这里**（→ `erix-run-format.js`） |
| `erix-run-core.js` | 纯逻辑：库装载、配置装配、`runToolLoop` 选项装配、事件→进度、终局载荷组装。**不 import pi**，`node --test` 可测 |
| `erix-run-format.js` | **结果形状层（issue #237）**：`outcome` / 同步载荷 → `AgentToolResult`（`content` / `details` / `structuredContent` / `isError` / `usage`）。按 `kind` 组装 `details`，只放纯数据，**`details` 必须可 JSON 序列化**这条由它保证。同样**不 import pi**，`node --test` 可测 |
| `erix-run-jobs.js` | **异步执行层（issue #234）**：job 注册表 + `status.json` 落盘（tmp + rename 原子写，写失败开 `deps` 注入缝，#237 R4）+ 立即返回句柄 + `action` 面（`status`/`result`/`list`/`cancel`）+ run 级超时看门狗 + 完成投递去重注册表 + 唤醒策略。同样**不 import pi** |
| `erix-run-parent-wake.js` | 唤醒父会话的双分支（idle 真触发 / 忙时追加 + `deliverAs:"steer"` 排队）+ `WAKE_PENDING_MS` pending 窗口 + `Symbol.for` WeakMap（`/reload` 不丢）。**逐分支对照** `pi-subagents` 的 `src/shared/parent-wake.js`（全文 46 行，分支结构一一对应，另多一个测试用的 `peekReservation`），**不 import pi** |
| `index.ts` | 目录形态的入口（pi 把「含 `index.ts` 的子目录」当成一条扩展加载） |
| `../../test/examples/erix-run-core.test.js` | core 单测（fake provider / 注入 fake lib，全离线） |
| `../../test/examples/erix-run-async.test.js` | **#234 异步面单测**：立即返回、`status`→`result` 生命周期、`cancel` 终局 `aborted`、`status.json` 落盘与跨 `/reload` 回落读盘、去重注册表、parent-wake 两条分支 + pending 窗口 + reload 安全、run 级看门狗、`quiet` 唤醒策略、`shutdown` 幂等；**#276 八条**钉住「异步终局视图覆盖同步结果的每个字段」（字段表从 core 载荷构造器派生、`UNPROJECTED_SYNC_FIELDS` 恒空、`result`/`status`/`status.json` 三处同形、未终局零值形状、句柄/摘要子集钉死） |
| `../../test/examples/erix-run-core.smoke.test.js` | 真机冒烟（一次真 relay 调用，默认跳过） |
| `../../test/examples/erix-run-pi-load.test.js` | 用 **pi 自己的装载器**（jiti + 虚拟模块）加载 `.ts`，断言注册成功、失败路径不抛错；#237 之后还拿**真 `execute()`** 把每条返回路径的 `details` 序列化一遍 |
| `../../test/examples/erix-run-details.test.js` | **#237 R2：`details` 必须可 JSON 序列化**。对 `started` / `status` / `result` / `list` / `cancel` / `unknown-run` / `error` / `crashed` + **同步终局**逐条断言 `JSON.stringify(details)` 不抛、`content[0].text` 非空、`details` 只含 plain 数据（+#276：视图带了嵌套 `diagnostics`/`verification` 后仍不触发 `detailsDropped`，失败终局的文本面要点名 `termination.errorCode`）（无函数 / 定时器 / promise / 循环引用），并把每个 `kind` 的键集合钉死 |
| `../../test/examples/plain-data.js` | 测试侧**独立实现**的「活对象」扫描器与 `assertMachineReadableResult`（故意不回读生产码的守卫，否则两边错在一起就是自证） |

## 安装

pi 的扩展目录是 `~/.pi/agent/extensions/`（用户级）或项目内 `.pi/extensions/`。扩展需要**两个文件在一起**
（`erix-run.ts` 会 `import "./erix-run-core.js"`），所以按目录装：

```bash
# 方式 A：软链整个目录（开发期最省事，改代码后 /reload 即生效）
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/examples/pi-extension" ~/.pi/agent/extensions/erix-run

# 方式 B：整目录拷走（发版后）
cp -r examples/pi-extension ~/.pi/agent/extensions/erix-run
```

目录里有 `index.ts`，pi 会把整个目录当成**一条**扩展加载（不会把 `erix-run.ts` 再加载一遍）。

开发态也可以不落盘，直接指文件：

```bash
pi --extension ./examples/pi-extension/erix-run.ts
```

> **为什么 `.ts` 在 pi 里能用而 `node` 直接 import 不行**：pi 用 jiti 加载扩展，并把
> `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` / `typebox` 作为虚拟模块注入
> （`dist/core/extensions/virtual-modules.js`）。本仓零依赖，这些包名在仓库里根本不存在，
> 所以 `node --check` 能过（Node 22.18+ 自带类型剥离，语法没问题），但 `node -e "import('./erix-run.ts')"`
> 会以 `ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/pi-ai'` 失败——这是预期的，
> 加载自证走 `test/examples/erix-run-pi-load.test.js`（用 pi 的装载器，真跑）。

### 让扩展找到 erix-agent 库

内层 run 需要 `runToolLoop` / `createOpenAIProvider` / `createJsonFileModelConfigProvider` /
`createMemoryTranscriptStore`（要落盘还要 `createFileTranscriptStore`），以及内置工具装配 `bin/tools.js`。装载顺序（写死在 core 里）：

1. **`ERIX_AGENT_LIB`** 指向本仓检出：目录（自动补 `src/index.js`）或直接指 `src/index.js`。
   ```bash
   export ERIX_AGENT_LIB=/home/eric/projects/erix-llm-kit          # 或 .../erix-llm-kit/src/index.js
   ```
   指向的路径找不到 / 入口缺少必需导出时，报 `lib_missing` 并把「尝试过哪些来源、各自失败原因」
   写进错误消息（不崩 pi）。
2. **裸包名 `erix-agent`**（发版 + `npm i -g erix-agent` 或在 pi 的扩展目录旁放 `package.json` 后）。
   此时包根目录由 `import.meta.resolve("erix-agent")` 反推，再用 `file://` URL 直接加载
   `<pkgRoot>/bin/tools.js`。

发版之后 `ERIX_AGENT_LIB` 就可以省掉；未发版时它是**必填项**。

## 参数

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `task` | 派工必填 | — | 交给内层 run 的**自包含**任务描述。内层看不到本次 pi 会话历史，必要上下文必须写进 `task`。⚠ #234 之后它在 schema 层**不再硬 required**（`action:"status"` 这类查询调用不带它），必填性改由运行时守：缺了就当场 `ok:false` + `error.code:"bad_params"` |
| `cwd` | 派工必填 | — | 内层工作目录，必须是**已存在的绝对路径**（`~` 前缀会展开）。相对路径直接判 `bad_params` |
| `maxRounds` | | `8` | 内层工具循环轮数预算（1..100）。**≥16 会自动开启 judge**（与 `bin/cli.js` 同一策略，`ERIX_NO_REFLECTION=1` 可关） |
| `strategy` | | 引擎缺省 | 压缩策略内置名字：`sliding-window` \| `fold-statistical` \| `fold-llm`（交给引擎在启动期实例化，见 `docs/host-consumer-contract.md`「Compaction strategy selection」） |
| `timeoutMs` | | `600000`（10 分钟） | 硬超时，1000..21600000。到点 `abort` 内层 run 并在返回里标注 `timeout: true` |
| `model` | | 槽位里的 model | 覆盖 `slots.default` 的模型名（endpoint / apiKey 仍走该槽位） |
| `sessionDir` | | 不落盘 | **过程落盘目录**（绝对路径，`~` 会展开；不存在则递归创建）。给了它就把内层 transcript 落到 `<sessionDir>/<runId>.jsonl`、judge 决策落到 `<sessionDir>/outputs/<runId>/judge.log`，并在返回的 `artifacts` 里给出真路径。坏目录（指到文件 / 不可写）归一成 `bad_params` 终局 |
| `transcript` | | — | `sessionDir` 的同义写法：`"file"` → 缺省目录 `~/.erix/transcripts`；其它非空串按目录路径处理；`"memory"` / `"none"` / `"off"` → 显式不落盘。两个都给时 `sessionDir` 赢 |
| `maxExtensions` | | 引擎缺省 `2` | 扩轮上限，直传引擎 `reflection.maxExtensions`。**`0` 是有效值 = 关掉扩轮**（引擎侧是 `>= 0` 判断，所以本层不能用「正整数」卡它）。非法值（负数 / 小数 / 非数字 / >1000）归 `bad_params` |
| `maxRoundsCap` | | 引擎缺省 `256` | 扩轮后的总轮数硬顶，直传 `reflection.maxRoundsCap`（正整数；引擎会抬到不低于 `maxRounds`）。上限 100000 |
| `extensionStep` | | 引擎缺省 `max(8, ⌊maxRounds/2⌋)` | 每次扩轮加的轮数，直传 `reflection.extensionStep`（正整数，上限 10000） |
| `async` | | `false` | **#234：`true` = 派工即返回句柄**（主会话不阻塞），内层 run 在同进程后台跑，终局经通知回到本会话。缺省 `false` = 原有同步语义逐字不变。句柄形状：`{runId, status:"running", cwd, model, maxRounds, timeoutMs, sessionDir, statusPath, quiet}` |
| `quiet` | | `false` | 只在 `async:true` 时有意义：**成功的完成不唤醒**父会话（只落 `status.json`），失败 / 中止仍然唤醒。一次派一批切片时用它免得把主会话打断成筛子 |
| `action` | | — | `status`（当前状态 + 终局四件套）\| `result`（完整终局：四件套 + `artifacts` + **终稿正文 `finalText`**，#261）\| `list`（本进程已知 run 的摘要表）\| `cancel`（把 `signal` 打进内层，终局记成 `aborted`）。`status`/`result`/`cancel` 要带 `runId` |
| `runId` | | — | `action` 要操作的 run id（就是 `async:true` 返回句柄里的 `runId`）|

> ⚠ **三个扩轮参数只在 judge 真的跑了时才生效**：引擎只在 `nearLimit` 且 judge 给了布尔 `extend` 时才读它们，
> 而本层的 judge 闸门是「`maxRounds ≥ 16` 自动开，`ERIX_NO_REFLECTION=1` 关」（与 #207 之前逐字一致）。
> 闸门关着时三个参数**整体不下发**，返回里 `diagnostics.reflection.enabled` 是 `false`、
> 模型可见文本里会多一行「扩轮参数未生效」——本层不顺手替你打开 judge（那会改变成本）。
> 另：`maxRounds` 的 1..100 是**入参校验上限**，不是引擎的总轮数上限（扩轮后由 `maxRoundsCap` 说话）。

## 过程落盘与审计面（issue #207）

**缺省一个字节也不写**：不传 `sessionDir` 时内层 store 仍是 `createMemoryTranscriptStore()`，
既不建目录也不接 judge 观察者（与 0.18 及之前逐字一致）。给了目录才换成库的
`createFileTranscriptStore({ dir })`（从包根导出取，不新造落盘管道；宿主注入的
`deps.createStore` 仍然优先）。目录布局照仓库 `AGENTS.md` §6：

```
<sessionDir>/
├── <runId>.jsonl                    # 每轮记录（含 judge 决策字段、runState、工具输出归档）
├── <runId>.state.json / .snapshot.json / .status.json   # 引擎自己的 run-state / 快照 / 状态
└── outputs/<runId>/
    └── judge.log                    # judge 决策 JSONL + 末行 run_outcome 终局汇总
```

- **`judge.log` 的位置与 CLI 默认一致**（`transcripts/outputs/<runId>/judge.log`）。CLI 那对
  `--judge-log` / `ERIX_JUDGE_LOG` 覆盖**本层不读**：宿主环境里一个无关的 CLI 变量不该把
  `erix_run` 的审计面搬到别处去，位置只由 `sessionDir` 决定。
- **记录形状**（照 `AGENTS.md` §6 / 契约「Judge record」）：每条带 `runId` + 实际 `model`（judge 走了
  别的评估模型时还有 `judgeModel`），引擎给的字段一个不改、不补占位值；末行是 `run_outcome` 汇总
  （`termination` + `verification`，append 而非回写）。写入器额外加**一条**判别键 `extendDecision`：

  | `extendDecision` | 含义 |
  |---|---|
  | `"yes"` | judge 说了扩（`decision.extend === true`） |
  | `"no"` | judge **明确**说不扩（`extend === false`，引擎 action `decline_extend`） |
  | `"missing"` | judge **没给** `extend` 字段 → 治理层 fail-closed 不扩 |
  | `"invalid"` | 字段在但不是布尔值（引擎解析层不该出现，留作哨兵） |

  这条是为 #207 的原始缺口立的：「judge 说不扩」与「judge 没答所以被 fail-closed 挡住」是两件
  不同的事实（前者是模型的决定，后者是模型没回答），而在原生 JSONL 里前者是 `"extend": false`、
  后者是**缺键**，只读日志的人很容易把它们看成同一件。`decision: null`（parse 失败的 degraded）与
  `run_outcome` 汇总记录**不写**该键。
- **路径怎么算的**：`<runId>` 文件名片段由 `safeRunIdForFile()` 算，与引擎 `src/store/file.js`
  的 `safeRunId()` 逐字同式（该符号没从包根导出，本层零依赖红线只能照抄），同式性由测试拿
  **真引擎函数**逐字符对账钉住——算错就等于往返回里报一个不存在的路径。
- **写不进去不改变终局**：judge.log 建目录 / append 失败只记一次 `diagnostics.persistenceErrors`
  （`channel: "judgeLog"`）并停止后续审计行；已跑完的 run 不会因审计面失败变 `failed`。
- 落盘不等于可续跑：`runToolLoop` 的 `resume` 通道（R2）是另一张单，本层现在**不接**，
  所以 `resumable` 恒 `false`。

## 异步执行：派工即返回句柄（issue #234）

`async: true` 把「一次完整多轮 run」从「堵住主会话的工具调用」变成「派工 + 句柄 + 完成通知」。
六条机制**参考** `pi-subagents` 的 UX / 策略，实现由本扩展自己写（本扩展**不 import** 它，所以「逐行照搬」在本仓无法自证；
逐条带上游行号的对照见 `docs/research/2026-10-13-pi-subagents-async-attribution.md`）。唯一一处**实质分歧**是进程模型（见下面「6. 限制」）。

### 1. 立即返回句柄

```jsonc
// erix_run({task, cwd, sessionDir, async:true}) 的返回（实测 5ms 就回来了，见下面时间戳）
{ "runId": "erix-run-2026-10-11T04-31-06.030Z-636c52", "status": "running",
  "cwd": "/tmp/234-e2e-work", "model": null, "maxRounds": 8, "timeoutMs": 120000,
  "sessionDir": "/tmp/234-e2e",
  "statusPath": "/tmp/234-e2e/outputs/<runId>/status.json", "quiet": false }
```

可机读数据在 `AgentToolResult.details`（照 `pi-subagents` 的 `result.details.progress` 口径——上游 `extension/index.js:137-141`
就是读 `result.details?.progress?.some(e => e.status === "running")` 判「还在跑」的），
**且 `details` 必须是可 JSON 序列化的纯数据**——宿主（pi）会把它序列化进会话记录 / 转发给订阅者，
一旦里面混了活对象，序列化一抛就白烧一轮 auto-retry（见「返回结构」节里的
「`details` 必须可 JSON 序列化（issue #237）」）。
`outputSchema` / `structuredContent` **仍只描述同步终局面**——异步面塑进同一个 schema 就得把
同步终局的那 15 个字段（#277 起含 `verification` 与错误路径的 `error`）全改 optional，把「同步终局一定有四件套」这条承诺改软，不值得。
而「异步视图的字段 ⊆ `outputSchema` 声明的字段」这条包含关系本身由 `test/examples/erix-run-pi-load.test.js`
的锚点守（它回读 `SYNC_RESULT_FIELDS` 那个派生值，不是第三份手抄清单）：上游加一个同步字段而 schema 不补，当场红。
`model` 是宿主请求的覆盖值；没传就是 `null`（= 用配置槽位的模型），不编一个名字。

### 2. job 注册表与 `status.json`

内存 Map（状态机 `queued` / `running` / `completed` / `failed` / `aborted`）**并落盘**：
`<sessionDir>/outputs/<safeRunId>/status.json`（**tmp + rename 原子写**：先写同目录的
`status.json.tmp-<pid>-<时间>`，再 `rename` 到最终名，读者永远看不到半截文件）。选这个落点的理由：
它就在 #207 的 `judge.log` **旁边同一棵树**，不新造布局；而工单给的另一个候选
`<sessionDir>/<runId>.status.json` **已被引擎占用**（实测内容 `{"runId":…, "status":"succeeded", "ts":…}`，
106 B，真机 `ls -R` 可直接看到），放那里就是两个写者撞一个文件。

**写中途失败的三条保证（#237 R4）**：① **旧文件内容不被破坏**（`rename` 没成功就没人动过
`status.json`，读者要么看到旧的完整内容、要么看到新的完整内容）；② **不留 `.tmp-` 残留**
（半截临时文件在 `catch` 里 `unlink`）；③ **不抛**——错误以 `{path, error}` 回报，放进
`job.statusWriteError` → 经 `jobView` 进查询视图与 `details`，模型文本面也多一行
`[status.json 写入失败] …`。所以「写不进去」不会把派工/查询面带崩，但也不会被谎报成落盘成功。
这层原本**零测试覆盖**（把它退化成直接写同名文件，全量测试零红），现在拿
`writeStatusFile(input, deps)` 的注入缝（照 `deps.createStore` 风格；`deps` 可换 `mkdirSync` /
`writeFileSync` / `renameSync` / `unlinkSync`，`createAsyncRuntime({deps})` 一路透传）钉在
`test/examples/erix-run-async.test.js` 的 #237 R4 四条上。

内容包含**终局四件套**（`termination.reason` / `truncated` / `rounds` / `usage`）+ `artifacts`
（**沿用 core 的 `resolveArtifacts` 口径**，宁给 `null` 不猜路径，不另写一份）+ 运行时事实
（`cwd` / `sessionDir` / `timeout` / `aborted` / `progressTail`）。内层还没给出终局时
`termination` 是 `null`——本层不替引擎发明一个 `reason`。没传 `sessionDir` 的异步 run 只有内存表（查不到跨 `/reload`）。

#### 终局视图的字段覆盖：`syncOnlyFields` 是空集（issue #276）

**主张**：`jobView`（= `action:"status"` = `action:"result"` = `status.json` 的内容，四处共用一个函数）
携带**同步返回的每一个字段**，再加 job 自己的运行时事实。所以下面那份「同步终局载荷」的字段清单
在异步面**逐字成立**（包括 `diagnostics` 整块与 `termination.errorCode`）；
**`syncOnlyFields`（只在同步面有、异步面没的字段）= `[]`，一个也没有。**

这不是「这次记得把 `diagnostics` 加上」，而是结构上不依靠「记得」：

| 层 | 在哪 | 它保证什么 |
|---|---|---|
| 字段表 `SYNC_RESULT_FIELDS` | `erix-run-jobs.js`，**装载期从 core 的 `buildSuccessPayload`/`buildErrorPayload` 现场探出来** | 上游新加一个同步字段 → 这张表当场变长，异步视图跟着投（字段表不是手抄清单） |
| 口径表 `TERMINAL_FIELD_SHAPES` | 同上，只定「这个字段怎么投 / 未终局时的零值形状」 | 口径没登记也不丢数据（未登记字段原样透传，缺位给 `null`），但 `UNPROJECTED_SYNC_FIELDS` 会变非空 |
| 看守 | `test/examples/erix-run-async.test.js` 的 #276 五条 | 字段表 == core 构造器的键集；`UNPROJECTED_SYNC_FIELDS` 恒空；同步结果里出现的每个键在 `result`/`status`/`status.json` **三处**都出现（含一个本层不认识的假字段）；未终局时字段也恒在场 |

为什么修这个而不是只补一个字段：`jobView` 以前是**手抄**投影，而 `runJob` 的返回才是真值源，
同一条病因已经静默过两次——A3（`d14f0f7`：`status.json` 缺 `runId`/`sessionDir`）与 #276
（缺 `diagnostics`，连带 #266 的 `notesLifecycle`；而 `erix-run.ts` 的返回形状与「`ok:false` 先读
`termination.errorCode` / `diagnostics`」那条指导都在向模型承诺它存在）。`status.json` 是
`/reload`、pi 重启后**唯一残留**，所以它丢的字段等于永久丢。

**刻意只给子集的两个视图（它们不是终局面，与 `syncOnlyFields` 无关）**：

| 视图 | 字段 | 为什么刻意少 |
|---|---|---|
| `handleOf`（`async:true` 派工即返回的句柄，**刻意子集**） | 9 个：`runId`/`status`/`cwd`/`model`/`maxRounds`/`timeoutMs`/`sessionDir`/`statusPath`/`quiet` | 派工时**还没有终局**，四件套还不存在；句柄的目的是拿住 `runId` 去查，不是给结果。本单**没动它的语义** |
| `action:"list"` 的摘要行 | 12 个（`runId`/`status`/`cwd`/`model`/`rounds`/`termination`/`ok`/`createdAt`/`finishedAt`/`elapsedMs`/`sessionDir`/`statusPath`） | 一张表列完所有 run，`diagnostics`/`finalText` 会把上下文撑爆；细节走 `status`/`result` |

两者的键集合都有测试钉死（`#234 R1` / `#234 R2` / `#237 R2` / `#276 R2⑤`），改它们必须是有意识的决定。

### 3. `action` 面：为什么是同一个工具加参数

| `action` | 需要 `runId` | 返回 |
|---|---|---|
| `status` | ✅ | 当前状态 + **同步终局结果的每个字段**（#276：与 `result` 同一个 `jobView`，含四件套 / `artifacts` / `finalText` / `diagnostics`）+ 进度尾巴 |
| `result` | ✅ | 同上（四件套 + `artifacts` + `diagnostics` + `progressTail`）**再加终稿正文 `view.finalText`**，且文本面直接附上正文（显示层截到 4000 字；终稿为空时文本里明说「终稿为空」，别让宿主以为只是没刷屏）；查一个已失败的 run 仍算「数据」，但报 `isError` 让模型看得见。⚠ **#261 之前这一支取不到终稿**：`jobView`（= `status.json` 的内容）从不填 `finalText`，而 `erix-run-format.js` 里那一支的条件是 `typeof view?.finalText === "string"` —— 字段根本不存在，条件永不成立（死分支），于是完成通知把宿主引导到 `result`、`result` 却给不出正文（没传 `sessionDir` 时连 `artifacts` 两项都是 `null`）。⚠ **#276 之前这一支也没有 `diagnostics`**（手抄投影拄漏，连带 #266 的 `notesLifecycle`），而工具描述一直告诉模型「`ok:false` 先读 `termination.errorCode` / `diagnostics`」 |
| `list` | | 本进程已知 run 的摘要表 + 活跃数 |
| `cancel` | ✅ | 把 `signal` 打进内层 `runToolLoop`，终局 `aborted`（已结束的 run 报「无需取消」，不假装成功） |

选「同一个工具 + `action`」而不是另注册 `erix_run_status`：**只多一套 schema / 一段 promptGuidelines /
一次 `outputSchema` 声明**就要把同一个注册表的读面拆到第二个工具名上，模型要记两个名字，而本仓
只有一个 job 注册表可查；代价是 `task`/`cwd` 在 schema 层不能再硬 required（必填性移到运行时）。
`action:"status"` 在内存表 miss 时会按已知 `sessionDir` 清单**回落读盘**——所以扩展 `/reload` 之后
仍能查到旧 run 的最后一个已知状态（但旧 run 本身已经被 `/reload` 杀掉了，见下面限制）。

### 4. 完成通知与唤醒（双分支 + pending + 策略 + 去重）

- **只在 `ctx.isIdle()` 时**才走「消息只追加（`triggerTurn:false`）+ `pi.sendUserMessage("erix_run updates above.", {deliverAs:"steer"})` 起一轮」；
  父会话忙时退化成「`pi.sendMessage(msg, {triggerTurn:true})` 原样透传、**不排 steer**」（硬触发会打断它）。
- **`WAKE_PENDING_MS = 10_000` pending 窗口**：被处理掉或失败的唤醒 prompt **不会发 `agent_start`**，
  超窗只能算「那一轮丢了」；窗口内不重复排 steer，`agent_start` 里清位。
- reservation 存 `Symbol.for("erix-run.parent-wake-reservations.v1")` 挂 globalThis 的 **WeakMap（按 `sessionManager` 键）**
  → 扩展 `/reload` 后不丢；`bindSession(ctx)` 在 **`session_start`** 里做（不在 factory）。
- **唤醒策略**：`!(quiet && completed)`——quiet 的成功完成只落状态不吵父会话（否则一批切片会把主会话打断成筛子），
  失败 / 中止仍然唤醒。
- **投递去重**：TTL（10 分钟）+ 容量上限（4096）的注册表，防同一 run 被投递多次（看门狗与内层返回
  两个触发源、`/reload` 后旧实例闭包、宿主重试）；两个常量与 `pi-subagents` 逐字同值。

### 5. `timeoutMs` 定时器归 run 级（不在 `execute()` 里）

异步分支返回后，定时器仍要把终局写成 `aborted` 并落进 `status.json`（否则查询侧永远停在 `running`）。
即使内层 run **连 abort 都不理**，看门狗也会到点把盘上状态推到 `aborted` 并发一次通知；之后内层真终局
到了仍会**覆盖落盘**（四件套以引擎为准）但**不再二次投递**。

### 6. 限制（写死，不要猜）

- **后台 run 与扩展同进程**：pi 进程退出 / 扩展 `/reload` 会杀掉它（`status.json` 只留下最后一个已知状态，
  **不会自动续跑**）。⚠ 这**不是** `pi-subagents` 的做法：上游**每个**后台 run 都 `spawn` 一个独立 runner 进程
  （`src/runs/background/async-execution.js:4` 导入 `spawn`，`spawnRunner` 定义在 `:385`，`:484` 真调用，调用点 `:1255` / `:1800`）。
  所以「同进程 + 不起子进程 / IPC」是**本单自己的选择**而不是跟上游——理由与代价见
  `docs/research/2026-10-13-pi-subagents-async-attribution.md` §6（旧版本这里写的「`pi-subagents` 也没为每个子任务
  spawn 子进程（全仓唯一 `spawnSync` 在 `herdr-pi-bridge.js:1`）」是假的，#269 已改：上游 `spawnSync` 有十来处，
  但都是 git / ssh 辅助调用，跟跑子任务无关）。
- **跨重启恢复不属于本单**（那是 #207 R2 + run-state store 的地盘），`resumable` 仍恒 `false`。
- 内存注册表**不跨进程重启**；要跨 `/reload` 可查就必须传 `sessionDir`。
- `async:true` 时，派工这次工具调用自己的 `signal` **不接**到后台 run（它在 `execute()` 返回时就失效了）；
  后台 run 的取消通道是 `action:"cancel"`。
- `executionMode: "sequential"` 不变：一个**同步** `erix_run` 在跑时，`action:"status"` 会排在它后面。

### 不阻塞实测（真扩展 + 真模型 + 真 relay）

用 pi 自己的扩展装载器（`dist/core/extensions/loader.js`）加载改后的 `erix-run.ts`，真调 `execute()`
（`ERIX_AGENT_LIB=/tmp/wt-234`、`sessionDir=/tmp/234-e2e`、`maxRounds 8`；**只有 `pi.sendMessage` /
`pi.sendUserMessage` 是桩**，用于记录调用时刻与参数）：

| 时刻 | 事件 |
|---|---|
| `T+1004ms` `04:31:06.029Z` | 调用 `execute(async:true)` |
| `T+1009ms` `04:31:06.034Z` | **execute 已返回（差值 5ms）**，拿到句柄 |
| `T+1060ms` | 期间干一件无关工作（读 package.json + `readdir src` + 跑一次 `node`）完成，共 51ms |
| `T+1081ms … T+9086ms` | `action:"status"` 五次轮询均 `running`（内层在后台跑） |
| `T+9385ms` `04:31:14.410Z` | 完成通知到达：`pi.sendMessage(…, {triggerTurn:false})` + `pi.sendUserMessage("erix_run updates above.", {deliverAs:"steer"})` |
| `T+11088ms` | `action:"result"` 拿到四件套：`end_turn` / `rounds=3` / `truncated=false` / `↑10992↓440`，`artifacts` 两条路径均在盘上 |

同一轮里：把 `isIdle()` 翻成 `false` 再派一单 → 只看到 `pi.sendMessage(…, {triggerTurn:true})`、
**没有 steer 排队**（忙分支）；第三单派工 2.5s 后 `action:"cancel"` → 终局 `{"reason":"aborted","partial":true}`
且 `status.json` 同步变 `aborted`。事件总数 4 条（第三条完成通知落在 pending 窗口内 → 不重复排 steer；
迟到的真终局被去重注册表挡住 → 不二次投递）。

⚠ **诚实边界**：上表是在脚本 harness 里跑的（真装载器 + 真 `execute()` + 真模型 run，但 pi 传输层是桩）。
它证明的是「扩展确实以正确参数调了 `pi.sendMessage` / `pi.sendUserMessage`」，**并不能证明父会话真被唤醒**。
后来拿真 pi 进程（`--mode rpc`）跑了一次，那个问题的答案见下面第 6 条（已实测）。
忙分支与 pending 窗口仍是**单元级桩验证**。

### 真进程 rpc e2e（#237 复核：唤醒仍生效 + `auto_retry` 已消失）

上表的 harness 把 pi 传输层做成桩，所以「settle 后能不能真唤醒」当时算未实测。真跑方式：
真 `pi --mode rpc` 常驻进程 + 真扩展（工作树的 `examples/pi-extension/index.ts`）+ 真模型 run，
脚本与事件流归档在 `docs/tasks/active/261010-13-erix-run-async/`（`e2e-wake.mjs` / `e2e-wake-events.txt`）。
本轮（#237 修完）的关键时间戳：

| 时刻 | 事件 |
|---|---|
| `T+001218ms` | 外层 `prompt` 受理，`agent_start`（第一轮） |
| `T+007415ms` → `T+007427ms` | 第一次 `erix_run` 调用被 schema 拒（模型传了 `action:""`，enum 不收空串），当场返 Validation 错 |
| `T+010210ms` → `T+010299ms` | 第二次调用（不传 `action`）**工具执行共 89ms 就回了句柄**（主会话没被 4 轮的 inner run 堵住） |
| `T+013955ms` | **第一轮 `agent_end`（settle）**，此刻盘上仍是 `running/rounds=0` |
| `T+025992ms` | **`agent_start`（第二轮 = 被唤醒）**，距 settle `12_037ms` |
| `T+027957ms` | 第二轮自己调 `erix_run(action:"result", runId=…)` 取回终局 |
| `T+030012ms` | 内层 `status.json` 从 `running` 走到 `completed/rounds=4` |
| `T+034255ms` | 第二轮 `agent_end`（它读到了 `termination=end_turn`） |

全程 `auto_retry` 事件数 **0**（#234 那一版在 `T+004759ms` 就有一条 `auto_retry_start`，
`errorMessage="Converting circular structure to JSON"`，占了一个 `agent_start`/`agent_end` 对）。
这就是 `details` 可序列化修好了的直接证据。
边界：**以上是 `--mode rpc` 下验的**（无 UI，事件流可直接读）；**交互式 TUI 界面层未逐字验**
（消息渲染、`customType:"erix-run-notify"` 的显示效果）。另：跟跑工作树扩展时要加 `--no-extensions`
（只关自动发现，显式 `--extension` 仍生效），否则安装副本也被加载，两个 `erix_run` 撞名 pi 直接退。

## 模型配置



读 `~/.erix/config.json`（可用 `ERIX_CONFIG_PATH` 指定别的路径；XDG：`$XDG_CONFIG_HOME/erix/config.json`
优先，与 `bin/config.js` 同口径）的 `slots.default`：

```json
{
  "slots": {
    "default": {
      "endpoint": "https://<relay>/v1",
      "model": "deepseek-flash",
      "apiKey": "***",
      "contextWindowTokens": 131072,
      "maxOutputTokens": 32768
    }
  }
}
```

- 槽位由**库自带**的 `createJsonFileModelConfigProvider(...).resolve("default")` 读取：`apiKey`
  支持 `apiKey` / `apiKeyEnv` / `apiKeyFile` 三选一（`resolveApiKey`），未发版的 key 玩法照常可用。
- provider 用 `createOpenAIProvider`（relay 是 OpenAI 协议），槽位整体摊平进去，`max_tokens`
  取 `maxTokens ?? maxOutputTokens`，provider 侧单次请求/流超时固定 300s（与 `bin/cli.js` 一致）。
- `contextWindowTokens` + `maxOutputTokens` 通过 `modelMetadata` **成对**交给引擎（#182：跨候选不合并，
  缺一个就不给）。**两个都缺 → 压缩与聚合输出预算整轮关闭**，返回里 `diagnostics.modelMetadataMissing`
  会带引擎的 `model_metadata_missing` detail（装配自查断言点）。
- 缺 `endpoint` / `model` / key → `config_invalid`；文件不存在 → `config_missing`（消息里带路径）。

## 内层工具集

**复用本仓 CLI 的同一装配函数** `bin/tools.js` 的 `createCliTools({ cwd, todo })`（不复制实现）：
`readFile` / `rg` / `grep` / `tree` / `writeFile` / `exec`。system prompt 也复用
`buildCliToolsSystemPrompt()`，再叠加「交付物落盘 + 收尾只写摘要 + 首行写「任务已完成」」。

- **`todo` 默认关**：`todo_*` 四件套把状态写在 `~/.erix/todos/<cwd-hash>.json`。erix_run 是嵌套执行，
  默认关可以避免污染用户 `~/.erix`、也避免并行 run 互相踩台账。要开就在 core 调用处传 `todo: true`
  （工具层未开参数，避免默认形态带副作用）。
- **工具结果原样进模型视野，本层不再截断**（issue 261013 R1，**推翻此前「对所有工具一律 head+tail 截到
  4096 字符」的口径**）：体积护栏本来就在引擎手里——`outputHygiene`（ADR-015：超限把**原文**归档进
  round record 的 `toolOutputs`，模型只见 stub + 指针，内容随时可取回；给了 `contextWindowTokens` 时
  单次上限是 `min(100000, max(8192, 窗口×15%))`，262144 窗口 = 39,321 字符）+ `aggregate-budget`
  （单轮合计）+ `exec` 自己的 `maxBuffer` 硬顶。宿主先在下游截到 4KB 就把这三层**整个架空**
  （归档分支从未触发），而且是就地销毁：按字符 head+tail 会切在行中间，`readFile` 的
  「整行 + offset 续读」契约当场失效（实测：请求 `offset=0,limit=200` 拿到 1-66 + 182-200，
  中段约 115 行静默消失，模型连补 5 轮回补取证）。transcript 缺省用 `createMemoryTranscriptStore()`
  （**纯内存、不落盘**），传了 `sessionDir` / `transcript:"file"` 才换成 `createFileTranscriptStore()`——见下一节。
- `exec` 由 `bin/tools.js` 自己带超时（`ERIX_EXEC_TIMEOUT_MS`，普通命令 120s / 安装编译类 300s），
  它**不吃 abort signal**：erix_run 被取消时，正在跑的 `exec` 会跑到自己的超时为止。
- **`note_*` 四件套已接入**（issue 261013 R2）：`note_take` / `note_read` / `note_list` / `note_forget`
  走引擎公共导出 `createBuiltinNotesTools`（照 `bin/cli.js` 的用法，不是本层自写）。为什么必须接：
  R1 之后引擎的结果 TTL 折叠第一次真会触发，而它的预警文案写着「请现在用 `note_take` 记录要点」、
  占位符写着「先用 `note_list` 查找，再用 `note_read` 读取」——文案点名的工具得真在场。
  落点**跟着 `sessionDir` 走**（`<sessionDir>/notes/run/<runId>/`，与 transcript / judge.log 同根）；
  不传 `sessionDir` 则走**内存 store**（本层自带的 `createMemoryNotesStore()`），**缺省不污染 `~/.erix`**
  ——引擎的 `resolveNotesDir()` 缺省是 `~/.erix/notes`，直用会污染用户目录且并行 run 共抢一个 scope。
- 没有 skills、没有 MCP：最小内置工具集，行为可预期。

## 边界：不得依赖 `bin/`（已知缺口，本单只立规则）

**现状**：内层工具面里的 `exec`（以及 `buildCliToolsSystemPrompt`）**只能**从 `bin/tools.js` 拿——
`src/tools/index.js` 的公共导出只有 registry / file-tools / notes / skills loader，
`grep 'name: "exec"' src/` 为空；而 `bin/` 在 `AGENTS.md` §1 里被定位为「验证器/调试器，不是产品重点」。
于是宿主想给内层 run 一个能跑命令的工具，就只能 `import <libRoot>/bin/tools.js`
（`erix-run-core.js` 里那一处硬编码，也是 `lib_missing` 报错里「找不到内置工具装配」的来源）。

**为什么这是缺口**：`bin/` 不在契约面里（`docs/host-consumer-contract*.md` 只承诺 `src/` 导出），
装配函数名/参数名/结果格式都不算公开面，改了不算 break；而 `examples/**` 会被别的宿主抄去当模板，
等于把「产品路径上的代码骑在验证器代码上」传下去。

**两条出路**（任选其一，**都要另开单**，本单没动公共导出）：
1. 把 `exec` 提到 `src/tools/` 公共面（additive / minor）——同时要补 `test/contract/` 契约与中英契约文档；
2. 宿主自己实现 `exec`（`node:child_process` + 自己的超时与缓冲上限），`erix_run` 那侧只靠
   `deps.createAssembly` 注入工具装配，不再 import `bin/`。

在两条都没落地前，**新增对 `bin/` 的依赖都要先补 `src/` 公共面**（同一口径也写进了
`AGENTS.md` / `AGENTS_cn.md`）。

## 取消与超时

| 触发 | 行为 | 返回 |
|---|---|---|
| pi 取消工具调用（用户中断 / `signal` abort） | `signal ?? ctx.signal` 直连内层 `AbortController` → 引擎 `fail()` 走 abort 分支 | `aborted: true`、`termination.reason: "aborted"`、`termination.partial: true`；**不**报 `isError`（那是人的决定） |
| `timeoutMs` 到点 | 记 `timedOut` 后 abort 同一个 controller | `timeout: true`、`aborted: true`、`termination.reason: "aborted"`；报 `isError` |
| 引擎自身 deadline | `timeoutMs` 同时作为 run 级 deadline 交给引擎，治理层在轮边界上按剩余时间收尾 | 可能先于硬 abort 正常返回（`max_rounds_cap` / `end_turn` 等） |
| **`action:"cancel"`（#234，异步 run 的唯一取消通道）** | job 自己的 `AbortController` abort → 经 `deps.signal` 打进内层 `runToolLoop`（走的仍是上面第一行那条链） | 当场 `status:"aborted"`（不等内层自己醒），终局 `termination.reason:"aborted"` + `partial:true`，`status.json` 同步；发一次唤醒通知 |
| **异步 run 的 `timeoutMs` 到点（#234）** | 定时器由 **job 持有**（不在 `execute()` 里），到点写 `aborted` 进 `status.json` + 发通知 + abort；即使内层连 abort 都不理也能推到终局 | 查询侧 `status:"aborted"`、`timeout:true`；迟到的真终局覆盖落盘但不二次投递 |

取消/超时**都不会丢用量**：抛错路径按 #180 从 `error.usage` / `error.rounds` / `error.finalText`
（以及 `termination.usage` / `rounds` / `partial`）读回来，载荷字段形状恒定（没跑过就是零值，不是缺字段）。

## 返回结构

`content` 是交回模型的文本（终稿 + 一行终局摘要 + 一行 diagnostics + 一行决策事实），
`details` / `structuredContent` 是同一份结构化载荷：

### `details` 必须可 JSON 序列化（issue #237）

**硬规矩**：`AgentToolResult.details`（以及同步面的 `structuredContent`）只能是
**可 JSON 序列化的纯数据**：plain object / array / string / number / boolean / `null`。
不会有函数、定时器句柄、`AbortController`/`AbortSignal`、未结算的 promise，也不会有循环引用。
为什么是硬规矩而不是风格问题：宿主会把 `details` 序列化进会话记录 / 转发给订阅者，
一抛就是 `Converting circular structure to JSON` —— 在真进程里它表现为**白烧一轮 auto-retry**
（可机读面当场作废，而单测当时全绿）。这条规矩由 `erix-run-format.js` 保证（逐 `kind` 组装，
不把 `outcome` 原样交出去）、由 `test/examples/erix-run-details.test.js` 与
`test/examples/erix-run-pi-load.test.js`（真装载器）钉住。

每个 `kind` 的 `details` 形状（**钉死**，多出东西就算测试红）：

| 路径 | `details` |
|---|---|
| `async:true` 派工 | `{ kind: "started", handle }` |
| `action:"status"` | `{ kind: "status", source, view }`（`source` = `memory` \| `disk`） |
| `action:"result"` | `{ kind: "result", source, view }` |
| `action:"list"` | `{ kind: "list", jobs, active }` |
| `action:"cancel"` | `{ kind: "cancel", cancelled, view[, message] }` |
| 查不存在的 run | `{ kind: "unknown-run", runId, message }`（报 `isError`） |
| `action` 参数不对 | `{ kind: "error", code, message }`（报 `isError`） |
| 扩展内部异常 | `{ crashed: true, error }`（报 `isError`） |
| **同步终局**（缺省路径） | `details` === `structuredContent` === core 组装的那份终局载荷（下面那份） |

`view` / `handle` / `jobs` 都是 `erix-run-jobs.js` 里 `jobView` / `handleOf` 组的**纯数据视图**；
活的 job 对象（controller / 定时器 / promise）**只留在 jobs 层内部**，不进返回值。
**三者不是一回事（#276）**：`view` 是**终局面**，携带上面那份同步载荷的每一个字段
（`syncOnlyFields` 为空，含 `diagnostics`）；而 `handle` 与 `jobs` 行是**刻意子集**（理由见「异步
执行」那一节的表）。拿 `handle`/`list` 的存在当「异步面本来就是子集」的借口，就是 #276 发生的原因。
视图里的 `finalText`（#261）是**原样透传、不在视图层截断**（单一真值：4000 字是 `erix-run-format.js`
的显示层口径），而且**只有 `result` 会把它打进文本**（`status` 只给可机读面，轮询不必每次重读一篇报告）；
还没终局 / 载荷没带它是 `""` 而不是缺字段（与四件套的零值形状同口径）。
万一上游哪天还是把活对象混了进来，`detailsForHost` 守卫会把 `details` **退化成**
`{ kind, detailsDropped: true, dropReason: "$.view.controller: 非 plain 对象（AbortController）" }`
而不是让宿主抛——宁可少给数据，不可带崩宿主；看到 `detailsDropped` 就该当缺陷查。
下面那份同步终局载荷（`details` 与 `structuredContent` 是**同一个引用**）。**这份清单同时也是异步终局视图的清单**（#276：`syncOnlyFields` 为空——`status` / `result` / `status.json` 三处逐字携带下面的一切，含 `diagnostics`）：

```jsonc
{
  "ok": true,                              // termination 是 end_turn/judge_done
  "finalText": "任务已完成\n\n- 改动：…",
  "rounds": 4,
  "truncated": false,
  "usage": { "input_tokens": 6003, "output_tokens": 396, "cacheRead": 4096 },
  "termination": { "reason": "end_turn", "errorCode": "…(仅 failed)", "detail": "…" },
  "timeout": false,
  "aborted": false,
  // ↓ #207 R4：决策事实
  "artifacts": {
    "transcriptPath": "/home/eric/.erix/transcripts/erix-run-….jsonl",  // 未落盘 / 没写出这个文件 → null
    "judgeLogPath": "/home/eric/.erix/transcripts/outputs/erix-run-…/judge.log",
  },
  "extensionCount": 0,                     // 本次真扩了几轮（从引擎 reflection.onReflection 数出来）
  "maxExtensions": 0,                      // 本次生效的扩轮上限：judge 没开就是 0；开着且未传参 = 引擎缺省 2
  "resumable": false,                      // 终局能不能续跑：R2 未落地，本单一律 false
  "verification": { "status": "skipped" },  // 引擎的验证结论（来自 runToolLoop 的返回）；没给时是 undefined，JSON 里不落盘
  "error": { "name": "Error", "message": "…", "code": "…", "stage": "…" },  // **只在抛错路径**：成功载荷里没这个键（#277：两个面都真会返它，schema 已声明）
  "diagnostics": {
    "observerErrors": { "count": 0, "samples": [] },
    "modelMetadataMissing": null,
    "ledgerErrors": { … }, "persistenceErrors": { … },
    "compaction": { "events": 0, "compactedRounds": 0, "foldedRounds": 0 },
    "model": "deepseek-flash", "configPath": "…", "cwd": "…",
    "libSource": "ERIX_AGENT_LIB=…", "strategy": "sliding-window",
    "runId": "…", "maxRounds": 8, "timeoutMs": 300000, "elapsedMs": 6276,
    "sessionDir": "/home/eric/.erix/transcripts",   // 未落盘时 null
    "reflection": { "enabled": false, "requested": {}, "maxExtensions": 0 },
    "notesLifecycle": { "attempted": true, "completed": 1, "errors": [] }
      // #266：未装配 notes（如自定义 createAssembly 不给 notes）时整个键不存在
  }
}
```

**`notesLifecycle` 是「收尾只留痕、不改终局」的存证（#266）**：run 终局时本层在公共收尾
`finally` 里调引擎 notes assembler 的 `lifecycle.onRunComplete`（只做 `completeRun`：把本 run scope
的 `active` 笔记收为 `done`），所以传了 `sessionDir` 的 run 事后翻 `<sessionDir>/notes/run/<runId>/`
能看出已收口（`note_list` 默认只列 `active`）。**成功、抛错、`timeoutMs` 到点、`aborted` 四种终局
共用这一条收口路径**；未传 `sessionDir` 时走内存 store，收口照样跑（不落盘）。钩子抛错或返回
`errors[]` 非空时，终局的 `ok` / `termination` / `usage` **一字不动**：错误逐条转成
`{operation, message}` 只写进本字段（与 `observerErrors` 同类），同时进度通道与 `[diagnostics]` 行
（`notesClosed=<完成数>/errors=<错误数>`）各留一行——收尾失败不等于任务失败，也不进 `finalText`。
本层**不调 `purge`**：它是无视 `scopeRef` 的全量清扫，属宿主策略（`src/tools/notes.js` 的端口注释同此）。

**`artifacts` 宁给 `null` 也不猜路径**：只有「传了 `sessionDir`」且「该文件此刻真在盘上」才给路径。
未落盘、装配期就失败、`judge.log` 一行也没写过（连 `run_outcome` 都没发出）都是 `null`；
宿主自己注入 `createStore` 时本层不知道它把东西写到哪，也给 `null`。

**`extensionCount` / `maxExtensions` 的口径**：前者是引擎**真的执行了扩轮**的次数（唯一可靠入口是
`reflection.onReflection`，它在 `governorState.extensionCount += 1` 旁边被调），后者是**生效上限**：
judge 闸门关着 = `0`（根本没额度），闸门开着且没传参 = 引擎缺省 `2`（这个 2 是引用引擎默认值，
本层**不把它下发**，不传就是引擎自己定）。**`resumable` 是能力声明而不是状态**：#207 R2 的
`resume` 通道落地前恒 `false`（常量 `RESUMABLE`）——落盘不等于能续跑。

`termination.reason` 一律是**引擎给的**（`end_turn` / `judge_done` / `no_tool` / `stall` /
`max_rounds_cap` / `continuation_exhausted` / `final_guard_unverified` / `aborted` / `failed` /
`persistence_failed`），语义与宿主处置建议见
[`docs/host-consumer-contract.md`「Termination decision table」](../../docs/host-consumer-contract.md#termination-decision-table-issue-170)。
本层不发明 reason、不把 abort 粉饰成成功。`failed` 时读 `termination.errorCode`（#176：引擎只透传，
没分类就是 `unknown`）再决定重试。

非 `ok` 的终局以 `isError: true` 返回（模型看得见，同时 `structuredContent` 仍在）。

## 进度

内层事件（`round_start` / `tool_use` / `tool_result` / `round_end` / `compaction` /
`model_metadata_missing` / `persistence_error` / `recovering` / `final_guard` / `run_outcome`）
经 `formatLoopEvent` 压成一行，走 pi 的 `onUpdate` 进度通道（节流 150ms，窗口保留最后 12 行，
终局强制刷一次）。观察者一律自防：进度通道抛错只计入 `diagnostics.observerErrors`，绝不反打内层 run。
落盘模式还会多两行：启动时的「落盘：transcript=… judgeLog=…」与每次扩轮的
「↻ 扩轮 n/N：round r → 上限 M」。

**异步派工（`async:true`）没有 `onUpdate` 可刷**（那个工具调用早就返回了）：进度改由 job 自己缓存
（上限 400 行），取回入口是 `action:"status"` / `action:"result"` 里的 `progressTail`（最后 10 行）。

## 成本提示

- **一次 `erix_run` = 一次完整多轮 run**：每轮一次主力模型调用，外加治理/压缩的辅助调用。上面的
  冒烟样本（4 轮、改一行代码）实测 ↑6003 / ↓396 tokens、6.3s。
- **judge 自身也有成本**：开 judge（`maxRounds ≥ 16`）后每个 end_turn 轮多一次评估调用；工具透传
  审计（intercept）也按频率抽样的 judge 调用。要压住扩轮的花费就 `maxExtensions: 0`（一次也不扩），
  要控住总量就同时传 `maxRoundsCap` / `extensionStep`（扩轮后的总轮数硬顶与步长）。
- **`fold-llm` 每压缩一次多花一次主力模型调用**（输入约等于被折叠轮次的大小，见契约「Compaction
  strategy selection」）。默认用 `fold-statistical`/`sliding-window` 更省。
- **`maxRounds ≥ 16` 会自动开 judge**（每轮 end_turn 一次评估 + 可能的扩轮），`ERIX_NO_REFLECTION=1` 关。
  开着的 run 可以用 `maxExtensions` / `maxRoundsCap` / `extensionStep` 调扩轮形状（直传引擎
  `reflection:{…}`，**本层不改引擎默认值**：不传就一个键都不写）；`maxExtensions: 0` 是「一次也不许扩」。
  ⚠ 这三个参数在 judge 没开的 run 里**不生效**（会被整体不下发，`diagnostics.reflection.enabled:false`
  + 模型文本里一行「扩轮参数未生效」），本单不为了它们擅自把 judge 打开（那会多花模型调用）。
- 收尾用 `completion.signals`（中文完成词表，与 `bin/cli.js` 同一份）+ system prompt 里的
  「首行写「任务已完成」」提前收口，否则模型纯文本收尾会白烧到 `no_tool`（默认 3 轮无工具才停）。
- `wrapup: false`：对话型宿主不收 JSON 信封，终稿就是模型原文。
- 没有 `finalGuard`，所以 `verification.status` 恒为 `skipped` —— **`end_turn` 不是交付证明**，
  验证要靠内层自己跑的 `exec`（或外层 pi 再跑一次测试）。

## 测试

```bash
node --test test/examples/*.test.js                                   # 离线：core 单测 + 异步面 + details 形状 + pi 装载自证
ERIX_PI_SMOKE=1 node --test test/examples/erix-run-core.smoke.test.js   # 真机冒烟（一次真调用）
```

- 冒烟默认跳过（`npm test` 必须离线可重复）；`ERIX_PI_SMOKE=1` 才打真 relay，用 `~/.erix/config.json`
  真配置、在 `mkdtemp` 的临时目录里修一个注入的小 bug，断言「`node check.js` 打印 OK + 载荷形状正确 +
  `model_metadata_missing` 不出现」；它同时跑一次 `sessionDir` 落盘，断言 `artifacts` 里的路径真在盘上。
- `erix-run-pi-load.test.js` 在找不到已安装的 `@earendil-works/pi-coding-agent` 时整条跳过；
  指路变量：`PI_CODING_AGENT_ROOT=<pi-coding-agent 安装目录>`。
- `erix-run-async.test.js`（#234）全离线：内层 run 走注入的 `runJob`（或假 lib + 假 provider 的真
  `runToolLoop`），`cwd` / `home` / `sessionDir` 一律临时目录 —— 不碰真实 `~/.erix`（跑完
  `find ~/.erix -newermt '-25 minutes'` 应为空）。看门狗那两条用 `timeoutMs = MIN_TIMEOUT_MS`（1s），
  所是整个文件比纯静态用例多花约 2s。
- `erix-run-readchain.test.js`（**issue 261013**）也全离线（真 `src/index.js` + 真 `bin/tools.js` + 临时 cwd）：
  钉住「宿主层不截工具结果」（>4,096 字符的 `readFile`/`exec` 结果逐字等于工具原样输出、中段哨兵在场）、
  「`note_*` 四件在内层工具面里且真可执行」、以及「**不传 `sessionDir` 时真实 `~/.erix` 不得多出文件**」
  （只**读** home 做前后对比）与「`readFile` 的续读 marker 带 `formatSize` 形态的文件大小」。
  反向证入口：把截断加回 `executeTool` → 前两条当场红；把 `createInnerNotesTools` 的注册拆掉 → notes 那三条红。
- `erix-run-details.test.js`（**#237 R2**）也全离线：把形状层（`erix-run-format.js`）的**每一条返回路径**
  跑一遍——`JSON.stringify(details)` 不抛、`content[0].text` 非空、`details` 只含 plain 数据（拿
  `test/examples/plain-data.js` 里**独立实现**的扫描器判，不回读生产码的守卫）、每个 `kind` 的键集合钉死。
  它能杀什么：把活对象 `job` 塞回返回值（即 #237 的原始缺陷形式）它就红。
  **#276 另补 2 条**：终局视图加了嵌套的 `diagnostics` / `verification` 之后 `status`/`result` 两条路径仍须
  机读（不触发 `detailsDropped` 退化），且失败终局的 `details` 与**文本面**都点名 `termination.errorCode`
  （工具描述让模型「先读 `termination.errorCode` / `diagnostics`」，而模型读的是文本）。
- `erix-run-async.test.js` 里的 **#237 R4** 四条钉 `status.json` 的 tmp + rename 原子写（顺序、
  旧内容不被破坏、不留 `.tmp-` 残留、错误进 `statusWriteError` 而不抛）；注入缝是
  `writeStatusFile(input, deps)` 与 `createAsyncRuntime({deps})`。
- `erix-run-pi-load.test.js` 除了装载自证，#237 之后还拿**真 `execute()`** 把 `started` / `status` /
  `cancel` / `result` / `list` / `unknown-run` / `error` / 同步失败八条路径的 `details` 各序列化一次
  （内层库指到不存在的路径 → 后台 run 秒回 `lib_missing`，不触网、不花模型钱）。

## 待主 agent `/reload` 实测的清单

1. **`onUpdate` 的可见性**：`onUpdate` 是文档化的进度通道（`AgentToolUpdateCallback`，
   `examples/extensions/shutdown-command.ts` 同一用法），但 TUI 里渲染成什么样 / RPC 与 `--mode json`
   / print 下会不会丢，需要真机 `/reload` 后看一次（print/json 模式无 UI，预期只是不可见、不影响结果）。
2. **`structuredContent` 是否被二次校验**：`outputSchema` 声明了终局载荷形状（`additionalProperties`
   未收紧）。若 pi 对 `structuredContent` 做严格校验，`termination` 在 abort 路径上会多带
   `usage` / `rounds` / `partial` 三个字段，届时需要把它们写进 schema。
3. **`usage` 归集口径**：`AgentToolResult.usage` 明确「不计入主 LLM 上下文」，且 `cost` 字段我们
   只能填 0（relay 侧记账）。pi 会话总额统计里会出现 `cost: 0` 的这条，是否符合预期需实测确认。
4. **`ctx.executeTool` 复用 pi 内置 read/edit/write/bash**：本实现**没走**这条路（任务书要求复用本仓
   `bin/tools.js` 的装配函数）。`ctx.executeTool` 在本机 dist 类型与 `docs/extensions.md` 里都存在，
   但示例里没有用例；若要改成复用 pi 内置工具（少一套文件/shell 实现），需要先实测该 API 的
   参数与结果形状。
5. **`exposure` / `defaultActive`**：当前是缺省 `direct` + 注册即激活。若希望它默认不声明给模型
   （按需 `pi.setActiveTools()` 再开），要确认 `/reload` 后 `pi.getAllTools()` 的可见行为。
6. **（#234 → #237 已实测）`agent_settled` 之后异步通知能不能真唤醒父会话**：✅ **已实测（`pi --mode rpc` 真进程）**。
   真常驻进程 + 真扩展 + 真模型 run：第一轮 `agent_end`（settle）在 `T+013955ms`（此刻内层 `status.json` 仍是
   `running/rounds=0`）→ **`T+025992ms` 真的又起了一轮 `agent_start`（距 settle 12 037ms）**→ 第二轮自己调
   `erix_run(action:"result", runId=…)` 取回终局四件套（`T+027957ms`），内层 `status.json` 在 `T+030012ms`
   从 `running` 走到 `completed/rounds=4`。事件流归档在同目录
   `docs/tasks/active/261010-13-erix-run-async/e2e-wake-events.txt`，时刻表与本单复核结果见上面
   「真进程 rpc e2e」那张表。
   ⚠ **边界（写清）**：验的是 **rpc 模式**（事件流可直读）；**交互式 TUI 界面层未逐字验**——具体是
   `customType: "erix-run-notify"` 在界面上渲染成什么样（本扩展没注册 renderer，预期按普通消息显示）与
   steer 在 TUI 里的排队表现。唤醒本身（「能不能再起一轮」）已不再是问号；如果 TUI 里真有显示差异，
   `action:"status"` / `action:"result"` 仍是可用入口。
