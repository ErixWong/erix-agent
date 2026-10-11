# erix_run — pi extension（pi 调度 erix 修代码）

把 **erix-agent 的 `runToolLoop` 内嵌成 pi 的原生工具**：pi（人机协同侧）把一个自包含的编码
子任务交给 erix（无人值守 headless 运行时），erix 在指定目录里跑完整的多轮工具循环（读写文件、
执行命令、压缩上下文），终局以结构化载荷交回 pi 模型。

这是「pi = 交互式 agent，erix = headless agent，互补而非竞争」（见仓库根 `AGENTS.md` §1）的落地形态：
**pi 负责编排与人机界面，erix 负责一次完整的无人值守执行**。

## 文件

| 文件 | 作用 |
|---|---|
| `erix-run.ts` | pi 扩展本体：`defineTool` 注册 `erix_run`、参数 schema、分流（同步 / 异步派工 / `action` 查询）、进度通道（`onUpdate`）、结果形状（`content` / `details` / `structuredContent` / `isError` / `usage`）、完成通知投递与生命周期接线 |
| `erix-run-core.js` | 纯逻辑：库装载、配置装配、`runToolLoop` 选项装配、事件→进度、终局载荷组装。**不 import pi**，`node --test` 可测 |
| `erix-run-jobs.js` | **异步执行层（issue #234）**：job 注册表 + `status.json` 落盘 + 立即返回句柄 + `action` 面（`status`/`result`/`list`/`cancel`）+ run 级超时看门狗 + 完成投递去重注册表 + 唤醒策略。同样**不 import pi** |
| `erix-run-parent-wake.js` | 唤醒父会话的双分支（idle 真触发 / 忙时追加 + `deliverAs:"steer"` 排队）+ `WAKE_PENDING_MS` pending 窗口 + `Symbol.for` WeakMap（`/reload` 不丢）。逐条照 `pi-subagents` 的 `shared/parent-wake.js`，**不 import pi** |
| `index.ts` | 目录形态的入口（pi 把「含 `index.ts` 的子目录」当成一条扩展加载） |
| `../../test/examples/erix-run-core.test.js` | core 单测（fake provider / 注入 fake lib，全离线） |
| `../../test/examples/erix-run-async.test.js` | **#234 异步面单测**：立即返回、`status`→`result` 生命周期、`cancel` 终局 `aborted`、`status.json` 落盘与跨 `/reload` 回落读盘、去重注册表、parent-wake 两条分支 + pending 窗口 + reload 安全、run 级看门狗、`quiet` 唤醒策略、`shutdown` 幂等 |
| `../../test/examples/erix-run-core.smoke.test.js` | 真机冒烟（一次真 relay 调用，默认跳过） |
| `../../test/examples/erix-run-pi-load.test.js` | 用 **pi 自己的装载器**（jiti + 虚拟模块）加载 `.ts`，断言注册成功、失败路径不抛错 |

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
| `action` | | — | `status`（当前状态 + 终局四件套）\| `result`（完整终局：四件套 + `artifacts`）\| `list`（本进程已知 run 的摘要表）\| `cancel`（把 `signal` 打进内层，终局记成 `aborted`）。`status`/`result`/`cancel` 要带 `runId` |
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
六条机制逐条照 `pi-subagents` 的真实实现搬（出处：`docs/tasks/active/261010-13-erix-run-async/analysis.md`）。

### 1. 立即返回句柄

```jsonc
// erix_run({task, cwd, sessionDir, async:true}) 的返回（实测 5ms 就回来了，见下面时间戳）
{ "runId": "erix-run-2026-10-11T04-31-06.030Z-636c52", "status": "running",
  "cwd": "/tmp/234-e2e-work", "model": null, "maxRounds": 8, "timeoutMs": 120000,
  "sessionDir": "/tmp/234-e2e",
  "statusPath": "/tmp/234-e2e/outputs/<runId>/status.json", "quiet": false }
```

可机读数据在 `AgentToolResult.details`（照 `pi-subagents` 的 `result.details.progress` 口径），
`outputSchema` / `structuredContent` **仍只描述同步终局面**——异步面塑进同一个 schema 就得把
13 个字段全改 optional，把「同步终局一定有四件套」这条承诺改软，不值得。
`model` 是宿主请求的覆盖值；没传就是 `null`（= 用配置槽位的模型），不编一个名字。

### 2. job 注册表与 `status.json`

内存 Map（状态机 `queued` / `running` / `completed` / `failed` / `aborted`）**并落盘**：
`<sessionDir>/outputs/<safeRunId>/status.json`（tmp + rename 原子写）。选这个落点的理由：
它就在 #207 的 `judge.log` **旁边同一棵树**，不新造布局；而工单给的另一个候选
`<sessionDir>/<runId>.status.json` **已被引擎占用**（实测内容 `{"runId":…, "status":"succeeded", "ts":…}`，
106 B，真机 `ls -R` 可直接看到），放那里就是两个写者撞一个文件。

内容包含**终局四件套**（`termination.reason` / `truncated` / `rounds` / `usage`）+ `artifacts`
（**沿用 core 的 `resolveArtifacts` 口径**，宁给 `null` 不猜路径，不另写一份）+ 运行时事实
（`cwd` / `sessionDir` / `timeout` / `aborted` / `progressTail`）。内层还没给出终局时
`termination` 是 `null`——本层不替引擎发明一个 `reason`。没传 `sessionDir` 的异步 run 只有内存表（查不到跨 `/reload`）。

### 3. `action` 面：为什么是同一个工具加参数

| `action` | 需要 `runId` | 返回 |
|---|---|---|
| `status` | ✅ | 当前状态 + 终局四件套 + `artifacts` + 进度尾巴 |
| `result` | ✅ | 同上，额外带 `finalText` 前 4000 字；查一个已失败的 run 仍算「数据」，但报 `isError` 让模型看得见 |
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
  **不会自动续跑**）。`pi-subagents` 也没为每个子任务 spawn 子进程（全仓唯一 `spawnSync` 在
  `herdr-pi-bridge.js:1`，是另一件事），所以本单**同样不引入子进程 / IPC**。
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

⚠ **诚实边界**：以上是在脚本 harness 里跑的（真装载器 + 真 `execute()` + 真模型 run，但 pi 传输层是桩）。
它证明的是「扩展确实以正确参数调了 `pi.sendMessage` / `pi.sendUserMessage`」。**在交互式 TUI 里
`agent_settled` 之后这条 steer 能不能真的把父会话叫醒，本环境无人值守，未实测**（需主 agent 真机
`/reload` 后看一次，已列入下面「待实测清单」第 6 条）。忙分支与 pending 窗口则是**单元级桩验证**。

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
- 工具结果进模型视野前按 head+tail 截断到 4096 字符（复用 `bin/tools.js` 的 `truncateResult`）；
  引擎侧的 `outputHygiene` 也在。transcript 缺省用 `createMemoryTranscriptStore()`（**纯内存、不落盘**），
  传了 `sessionDir` / `transcript:"file"` 才换成 `createFileTranscriptStore()`——见下一节。
- `exec` 由 `bin/tools.js` 自己带超时（`ERIX_EXEC_TIMEOUT_MS`，普通命令 120s / 安装编译类 300s），
  它**不吃 abort signal**：erix_run 被取消时，正在跑的 `exec` 会跑到自己的超时为止。
- 没有 `note_*` 工具、没有 skills、没有 MCP：最小内置工具集，行为可预期。

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
  "diagnostics": {
    "observerErrors": { "count": 0, "samples": [] },
    "modelMetadataMissing": null,
    "ledgerErrors": { … }, "persistenceErrors": { … },
    "compaction": { "events": 0, "compactedRounds": 0, "foldedRounds": 0 },
    "model": "deepseek-flash", "configPath": "…", "cwd": "…",
    "libSource": "ERIX_AGENT_LIB=…", "strategy": "sliding-window",
    "runId": "…", "maxRounds": 8, "timeoutMs": 300000, "elapsedMs": 6276,
    "sessionDir": "/home/eric/.erix/transcripts",   // 未落盘时 null
    "reflection": { "enabled": false, "requested": {}, "maxExtensions": 0 }
  }
}
```

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
node --test test/examples/*.test.js                                   # 离线：core 单测 + 异步面 + pi 装载自证
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
6. **（#234）`agent_settled` 之后异步通知能不能真唤醒父会话**：双分支代码逐字照 `pi-subagents`，
   并在真装载器 + 真 `execute()` + 真模型 run 的 harness 里实测到「`pi.sendMessage(msg,
   {triggerTurn:false})` + `pi.sendUserMessage("erix_run updates above.", {deliverAs:"steer"})` 确实被调用」，
   但 pi 的传输层在 harness 里是桩。**交互式 TUI 里收到通知后是否真起一轮、以及 `customType:
   "erix-run-notify"` 的显示效果**（本扩展没注册 renderer），需要 `/reload` 后派一单看一眼；
   如果没醒来，就按「未唤醒，需轮询」处理（`action:"status"` 已是可用入口），并把这条改成已知限制。
