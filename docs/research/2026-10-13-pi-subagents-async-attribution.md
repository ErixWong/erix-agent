# erix_run 异步执行机制分析（issue #234）—— 对照 `pi-subagents@0.76.1` 的实证

> 快照档案（2026-10-13）：本文里的路径、数字与结论按**当时**为真；现状以 `docs/host-consumer-contract.md` 与 `CHANGELOG.md` 为准。
> 这份文件是 `examples/pi-extension/README.md`「异步执行：派工即返回句柄」一节与
> `examples/pi-extension/erix-run-*.js` / `erix-run.ts` 头注释里那个引用落点。
> **issue #269 之前它是不存在的**（三处代码注释、README、CHANGELOG 都在指一个空文件），
> 本文件把它补成真带行号的实证，而不是空壳。
>
> 上游读法（2026-10-13 复核）：`~/.pi/agent/npm/node_modules/pi-subagents/`，其 `package.json` 的
> `"version": "0.76.1"`。下面每个「上游」位置都是用 `grep -n` / `sed -n 'X,Yp'` 逐行读出来的，
> 不是凭印象写的；每条都附了可复核的读法。行号随上游版本漂移，**按内容定位**。

## 0. 先立口径：什么叫「照」，以及为什么不能写「逐行照搬」

本扩展**不 import `pi-subagents`**（`examples/pi-extension/**` 只依赖 `@earendil-works/pi-*` 与本仓 `erix-agent`），
所以「逐行照搬」这种说法在本仓**无法自证**。可自证的只有两类：

1. **UX / 策略同构**：返回形状、唤醒策略、去重语义、状态落盘的形状与上游一致；
2. **常量逐字同值**：三对常量可以逐字符比对（§2、§4）。

除此之外，函数名、文件布局、类型标注、注释全是本扩展自己写的。唯一能「逐分支对齐」的是 §2 的
parent-wake——上游那份只有 46 行、逻辑全在一个工厂函数里，可以一条分支一条分支地比。
其余各节讲的是**我们从上游哪个位置取了什么主意**，以及**本层的落点在哪**。

同目录另有三份当时的实测件（`e2e-wake.mjs` 真 relay 唤醒脚本、`e2e-wake-events.txt` 事件流、
`repro-circular-details.mjs` `details` 循环引用复现）——它们是 #234/#237 的实测证据，本文件只补机制对照。
这三份都是**本机档案、未入库**（实物在 `docs/tasks/active/261010-13-erix-run-async/`，该目录被 `.gitignore` 整体忽略），
克隆后按名字去仓库里找是找不到的。

## 1. 立即返回句柄 + 进程内 job 注册表

| | 位置 |
| --- | --- |
| 上游 | `src/extension/index.js:284`（`asyncJobs: new Map()`，注册表挂在扩展 `state` 上）；`src/runs/background/async-job-tracker.js:770`、`:893`（`state.asyncJobs.set(...)` 登记 job）；`src/runs/background/async-execution.js:1440`（workflow 面）、`:2011`（single 面）——派工**不等内层跑完**就返回，`details` 里带 `runId` / `asyncId` / `asyncDir` 当句柄 |
| 本层 | `examples/pi-extension/erix-run-jobs.js:135` `createAsyncJobRegistry()`、`:154` `globalAsyncJobRegistry()`、`:275` `handleOf(job)`（句柄形状 `{runId, status, cwd, model, maxRounds, timeoutMs, sessionDir, statusPath, quiet}`） |

上游另在 `src/extension/index.js:137-141`（`isSlashResultRunning`）用 `result.details?.progress?.some(e => e.status === "running")`
判「还在跑」——这是 README 里「可机读数据放 `AgentToolResult.details`」那条口径的出处：
**进度放在 `details` 而不是文本里**。本层同样把机读数据放 `details`，但字段是自己定的（且必须可 JSON 序列化，#237 R2）。

复核：`grep -n "asyncJobs: new Map()" src/extension/index.js`、`grep -n "asyncJobs.set" src/runs/background/async-job-tracker.js`。

## 2. 唤醒父会话：唯一可以逐分支对齐的一份（双分支 + pending 窗口 + reload 安全）

上游 `src/shared/parent-wake.js` **全文 46 行**（含末尾 `//# sourceMappingURL` 行；注意它在 `src/shared/`，**不在** `src/runs/shared/`）：

- `:1` `export const PARENT_WAKE_TEXT = "Subagent updates above.";`
- `:4` `const WAKE_PENDING_MS = 10_000;`
- `:5` `const reservationsSymbol = Symbol.for("pi-subagents.parent-wake-reservations.v1");`
- `:7` reservation 存 `globalThis[reservationsSymbol]` 上的 **WeakMap**（键是 `sessionManager`）→ 扩展实例重建（`/reload`）不丢
- `:14-17` 分支一：`options?.triggerTurn !== true` → 原样 `pi.sendMessage`，返回 `false`
- `:18-21` 分支二：`!ctx.isIdle()` → 原样透传，**不排 steer**、不建 reservation，返回 `false`
- `:22-27` 分支三：idle → `pi.sendMessage(message, {triggerTurn:false})` 只追加；未占窗口则记 `sentAt` 并 `pi.sendUserMessage(PARENT_WAKE_TEXT, {deliverAs:"steer"})`（`:26`），返回 `true`
- `:30` `isPending: () => reservation.sentAt !== undefined && (reserved() || !ctx.isIdle())`
- `:31-37` `bindSession`：在 `session_start` 里绑 `ctx`，按 `sessionManager` 取回同 `sessionId` 的 reservation
- `:38-40` `agentStarted()` 清位；`:41-44` `sessionShutdown(reason)` 只在 `reason !== "reload"` 时清位

本层 `examples/pi-extension/erix-run-parent-wake.js`：**逐分支对照**上面 `:14-44`，只改了单号、文本常量
（`"erix_run updates above."`）与 `Symbol.for` 键名（`"erix-run.parent-wake-reservations.v1"`），
**分支结构一条没动**；额外多一个上游没有的 `peekReservation()`（`:83`，测试/诊断用，返回浅拷贝不暴露内部引用）。

**逐字同值（可自证）**：本层 `erix-run-parent-wake.js:21` `WAKE_PENDING_MS = 10_000` == 上游 `:4`。
上游为什么必须双分支、为什么要有 pending 窗口，注释里那三条理由（idle 才真起轮 / 被处理掉的 prompt 不发 `agent_start` /
WeakMap 才扛得住 reload）都是从上面那段代码反推的，不是听来的。

复核：`cat -n ~/.pi/agent/npm/node_modules/pi-subagents/src/shared/parent-wake.js`。

## 3. 状态落盘 `status.json`

| | 位置 |
| --- | --- |
| 上游 | `src/shared/utils.js:126` `const statusPath = path.join(asyncDir, "status.json");`（另 `:93` 用 `path.resolve(root, runId, "status.json")` 组当前 run 集合）；`src/missions/lifecycle.js:101`、`src/missions/goal-driver.js:21`、`src/api/preflight.js:391` 都是读同一个 `<asyncDir>/status.json` |
| 本层 | `erix-run-jobs.js:164` `statusFilePath({sessionDir, runId})` → `<sessionDir>/outputs/<safeRunId>/status.json`；`:188` `writeStatusFile(..., deps)` **tmp + rename 原子写**；`:212` `readStatusFile` |

**本层与上游不同的两点，都写在 README 的「2. job 注册表与 `status.json`」里**：① 落点不跟上游的 `asyncDir`，而是贴 #207 的 `judge.log` 同一棵树（工单给的候选 `<sessionDir>/<runId>.status.json` **已被引擎占用**，实测引擎在 `sessionDir` 根写 106 B 的同名族文件）；② 上游没有 tmp+rename 那条原子写约定，本层自己加了「旧内容不破坏 / 不留 `.tmp-` 残留 / 写失败不抛」三条（#237 R4）。

复核：`grep -rn "status.json" src/shared/utils.js src/missions/lifecycle.js`。

## 4. 唤醒策略与投递去重

| 机制 | 上游 | 本层 |
| --- | --- | --- |
| 唤醒策略 `!(quiet && completed)` | `pi-subagents:src/runs/background/notify.js:226-227` `export function scheduledCompletionTriggersTurn(origin, outcome) { return !(origin?.quiet === true && outcome === "completed"); }` | `erix-run-jobs.js:60` `completionTriggersTurn(input)` |
| 投递去重注册表 | `pi-subagents:src/runs/background/notify.js:371` `createCompletionSendRegistry(ttlMs = COMPLETION_SEND_TTL_MS, cap = COMPLETION_SEND_REGISTRY_CAP)`（`:372` `const entries = new Map()`，prune 只淘汰**已投递**条目） | `erix-run-jobs.js:83` `createCompletionSendRegistry(ttlMs, cap)`、`:126` `globalCompletionSendRegistry()` |
| 常量对 | `pi-subagents:src/runs/background/notify.js:19` `COMPLETION_SEND_TTL_MS = 10 * 60 * 1000`、`pi-subagents:src/runs/background/notify.js:20` `COMPLETION_SEND_REGISTRY_CAP = 4_096` | `erix-run-jobs.js:38-39` **同两个表达式**，逐字符相同 |

**逐字同值（可自证）**：`10 * 60 * 1000` 与 `4_096` 两个表达式在本仓与上游完全一致，README 里「两个常量与 `pi-subagents` 逐字同值」这句是**可核对的**，不是修辞。
本层比上游多的是 `Symbol.for` 挂 globalThis（上游 `state` 本身活在一个进程里，不需要这层），以及 `settle(false)` 让位重试。

## 5. `timeoutMs` 定时器归 run 级，不在 `execute()` 里

上游的做法：把 `timeoutMs` 换算成 `deadlineAt` 随 run 记录**交给那个独立 runner 进程**去执行——
`src/runs/background/async-execution.js:1211`（`params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined`）、
`:1287-1288` 与 `:1440`（写进返回的 `details`）、`:1647-1648`（single 面，另支持 `absoluteDeadlineAt`）、`:968`（`defaultTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS`）。
`src/watchdog/runtime.js`（约 38 KB）是**另一件事**：它是 review / settle 的大循环（`:587`、`:848` 的 `setTimeout` 是等 review/等 settle 的计时，`:455-456` `waitForIdle`/`waitForSettled`），
不是一条 run 超时看门狗；本层只取「到点 abort + 把终局写成 `aborted`」这一小片语义，**不抄整套看门狗**。

本层落点：`erix-run-jobs.js:412` `job.watchdog = setTimeout(...)`（派工时创建、`:373`/`:522`/`:546` 清位、`:424` `unref()`），
所以异步分支返回之后定时器仍活着；即使内层不理 `abort`，到点仍把盘上状态推到 `aborted` 并发一次通知，
之后迟到的真终局仍覆盖落盘（四件套以引擎为准）但**不再二次投递**（回到 §4 的去重注册表）。

## 6. 进程模型：**唯一一处实质分歧**（本层与上游不一样，且是故意的）

上游**每个后台 run 都 spawn 一个独立 runner 进程**：

- `src/runs/background/async-execution.js:4` `import { spawn } from "node:child_process";`
- `:385` `function spawnRunner(cfg, suffix, cwd, initialStatus, initialStatusPath, launchParentSessionId, onProcessTerminal, onBeforeProceed, requestedCwd = cwd)`
- `:484` 真调用：`const proc = spawn(command, args, { cwd, ...backgroundProcessOptions(), stdio: ["ignore", stdoutFd ?? "ignore", stderrFd ?? "ignore"], env: runnerEnv });`（`runnerEnv` 见 `:470-479`：剔 git routing / extension bindings env、注 `PI_PACKAGE_DIR`、`PI_SUBAGENT_RUNNER_CONFIG` 等）
- 调用点两处：`:1255`（workflow / multi 面）、`:1800`（single 面）；spawn 失败只打 `:501` 的 `[pi-subagents] async spawn failed: …`
- 顺带：`spawnSync` 在上游**不止一处**（`src/extension/herdr-pi-bridge.js:1`、`src/agents/agent-memory.js:14`、`src/workflows/chat-progress.js:1`、`src/watchdog/change-signature.js:1`、`src/watchdog/diff-tool.js:1`、`src/runs/shared/worktree.js:2`、`src/runs/shared/acceptance.js:2` 等），但那些全是 `git` / `ssh` 的辅助调用，与「跑一个子任务」无关

本层：**同进程 Promise + 内存 Map + 文件状态机**，`async:true` 不起子进程、不引 IPC。
代价写死在 README「6. 限制」：pi 进程退出或扩展 `/reload` 会杀掉在跑的后台 run，`status.json` 只留下最后一个已知状态，
**不会自动续跑**；跨重启恢复不属于 #234（那是 #207 R2 + run-state store 的地盘），`resumable` 仍恒 `false`。

这条分歧是**选择**而不是遗漏：起进程就要带上一整套（可执行文件解析、env 清洗、stdio 落盘、崩溃回收、跨平台），
而上游那套的价值恰恰在它已经在管这些。本层只有一层薄 job，把复杂度换成「同进程 + 明确的不可恢复」更容易自证。

## 7. #269 更正记录（这两句当时是假的）

1. **「`pi-subagents` 也没为每个子任务 spawn 子进程（全仓唯一 `spawnSync` 在 `herdr-pi-bridge.js:1`）」**——两句都不成立：
   上游在 `async-execution.js:484` 用 `spawn` 为每个后台 run 起 runner 进程（§6），且 `spawnSync` 在上游有十来处（都是 git/ssh 辅助）。
   本层「同进程」的结论不变，但它是**本层的选择**，不能再拿上游当论据。
2. **「`erix-run-parent-wake.js` 逐条搬 `parent-wake.js` 全文 40 行」**——上游那份是 **46 行**（§2）。分支结构一条没动这句仍然成立。

同批把「六条机制**逐条照搬**」改成「参考其 UX / 策略，本扩展自行实现」——见 §0 的口径。
