# erix-agent v0.3.x 宿主升级指南（touwaka / app_container）

> English version: [host-upgrade-guide-v030.md](host-upgrade-guide-v030.md)

> 本指南面向 erix-agent 的两个宿主消费者：**touwaka**（专家对话链路）和 **app_container**（PI Agent 审计/开发链路）。
> 本文说明从 erix-agent <=0.2.0 升级到 **v0.3.x**（0.3.0 起；v0.3.x 参考版本为 npm 0.3.4）时宿主可见的变化。
> 相关阅读：erix README、[ADR-011](decisions/011-judge-direction_cn.md)（judge 设计）和 [ADR-010](decisions/)（压缩）。

> **范围说明：** 本文是 v0.3.x 升级指南，不是当前版本的发布说明。v0.3.x 之后的宿主可见变化见 [host-consumer-contract_cn.md](host-consumer-contract_cn.md)。

---

## 0. 宿主视角的升级摘要

以下 `runToolLoop` 行为对宿主来说是新增或变化的：

| # | 变化 | 宿主影响 |
|---|---|---|
| 1 | 当 `maxRounds >= 16`、省略 `reflection` 且 `ERIX_NO_REFLECTION` 不是 `1` 时，**reflection（judge 体系）自动启用** | 长任务可能产生额外的 judge 调用。低于 16 轮的运行不会自动启用。 |
| 2 | **透明工具调用审计：**每完成 `judgeIntervalRound` 次真实工具执行（默认 `5`），下一次工具调用会在执行前接受 judge 检查 | judge 返回 `done:false` 时可以跳过 `executeTool`，并返回审计或降级结果。judge 错误和超时会回退为执行原始工具。 |
| 3 | **轮次 judge：**不使用工具的 `end_turn` 响应会被独立评估；只有带有 `confidence >= 0.7` 的有效 `done:true` 才产生 `judge_done` | 模型尝试停止可能导致另一次 judge 调用并增加延迟。judge 失败会回退到正常的完成/no-tool/end-turn governor。 |
| 4 | 当 store 同时提供 checkpoint writer（`saveCheckpoint` 或 `appendCheckpoint`）和 `loadLatestCheckpoint` 时启用 **fail-closed checkpoint** | 实际工具执行前 checkpoint 失败会抛出 `checkpoint_failed`，且不执行工具。执行后失败会报告工具已运行但其结果未持久化。`executeTool` 应按 tool id 幂等。 |
| 5 | **stall 软纠正：**重复的工具签名会在第三次 stall 命中前收到 nudges，随后以 `termination.reason: "stall"` 停止 | 旧的 `llm_kit_stalled` 硬错误不再是正常路径。宿主必须处理 termination reason 为 `stall` 的正常结果（其 `truncated` 值为 `true`）。 |
| 6 | **方向提示是软指导** | 仅有 `direction: "off_track"` 不会阻止工具。它会添加方向提示；只有 judge 返回 `done:false` 时才会阻止原工具执行。 |
| 7 | **严格的 `maxRounds` 校验** | `maxRounds` 必须是正的安全整数。`NaN`、`0`、负数、`Infinity` 和非整数等无效值会抛出 `TypeError`。 |
| 8 | **file store 的 JSONL 崩溃恢复** | 没有换行符的完整最终 JSON 记录会被修复；不完整或无效的尾部片段会被隔离为 `.corrupt.*`，并从活动文件移除。 |
| 9 | **judge 可观测性和轮次记录持久化** | `onJudge` 会收到轮次和拦截决策，包括降级决策。宿主持久化轮次记录时，轮次 judge 数据会作为 `record.judge` 包含其中；拦截决策不会自动加入该记录。 |
| 10 | **可选的 final-guard 核验** | 宿主提供的 `finalGuard` 可以接受、跳过或要求修订最终结果。宿主必须消费 `verification.status`，而不是将每个返回的 `finalText` 都视为已核验。 |

### 轮次 judge 降级矩阵

| Judge 结果 | Loop 行为 | 宿主可见含义 |
|---|---|---|
| 有效的 `done:true` 且 `confidence >= 0.7` | 产生 `judge_done` 并结束 | judge 以高置信度接受完成。 |
| 有效的 `done:false` | 注入 judge nudge 并继续 | judge 明确表示还需要更多工作。 |
| 有效的 `done:true` 且 `confidence < 0.7` | 不产生 `judge_done`；由正常的 `completion`、`no-tool` 或 `end_turn` 逻辑决定 | 模型的完成信号仍然可以停止运行。 |
| 解析失败或 evaluator 异常 | 发出降级的 `onJudge` 决策并使用正常 governor | 默认连续失败三次后，本次运行的轮次 judge 会被禁用。 |

`direction` 是 judge 响应中的建议字段。judge prompt 明确说明它不影响 `done`。对于拦截，
只有 `done:false` 会阻止原始副作用；`off_track` 方向可能改为向下一次模型上下文添加提示。

## 1. touwaka（专家对话链路）

**基线配置**（来自原始宿主集成指南；上线前请对照 touwaka 仓库核实）：

- 调用点：`lib/agent/agent-loop.js:1074` -> `lib/llm-kit-adapters/loop-bridge.js` 中的 `buildErixRunOptions`。
- `store`：由 MariaDB 支持的 `createErixStore`，使用 `llm_kit_transcripts` 和 `llm_kit_run_state`；`saveCheckpoint`/`appendCheckpoint` 与 `loadLatestCheckpoint` 均存在，因此是成对的 checkpoint store。
- 显式设置 `stallDetection: false`；touwaka 有自己的重试和恢复系统。
- `maxRounds` 来自专家配置 `max_tool_rounds` 或系统设置，宿主兜底为 **8**。
- 省略 `reflection`，因此当有效 `maxRounds` 至少为 16 且 `ERIX_NO_REFLECTION` 不是 `1` 时适用核心自动启用规则。
- `loop-bridge` 使用 `...passthrough`，因此宿主提供的 `reflection` 选项可以传递给 `runToolLoop`。

### 重要：为 touwaka 禁用收尾协议

v0.3.x 默认启用 wrap-up 协议。对话型宿主应传入 `wrapup: false`。这会同时禁用指令注入、
wrap-up JSON 解析、`finalText` 替换以及 wrap-up LLM 规范化。`completion.signals` 保持独立；
不要用 `completion: false` 替换它。

以 touwaka 的 8 轮兜底值来看，自动 judge 通常关闭。如果专家或系统设置达到
`maxRounds >= 16`，不使用工具的 `end_turn` 可能调用轮次 judge，每五次真实工具执行会
安排一次拦截审计。请明确决定，因为这会改变延迟、provider 使用量和工具副作用处理。

### 响应清单

1. **选择 judge 策略：**
   - **A. 接受自动启用**（长任务或审计型专家推荐）：当 `maxRounds >= 16` 且省略 `reflection` 时无需修改代码。这会增加方向检查和完成复核；除非配置独立 judge provider，否则应通过主 provider 为这些调用预留预算。
   - **B. 显式禁用**，适用于不应承担额外延迟的对话型专家：在 `buildErixRunOptions` 调用点传入 `reflection: false`。
   - **C. 按专家类型配置**，例如：
     ```js
     reflection: expertConfig?.judge === true
       ? { enabled: true, roundJudge: true, judgeIntervalRound: 5, judge: { provider: judgeProvider } }
       : false
     ```
     `judgeIntercept: false` 可以只禁用拦截，同时保留轮次 judge。`roundJudge: false` 可以只禁用 end-turn judge。

2. **传递任务简报（issue #34）：**对于多轮和续跑的运行，将当前指令作为字符串传给 `runToolLoop` 的 `task`。优先级为 `task` > `context.task` > 入口 transcript 中最后一条 user 消息。显式的 `task` 和 `context.task` 值上限为 1500 个 code point；消息回退上限为 500。续跑时再次传入 `task`。续跑时的回退来源是原始 round-0 seed messages，而不是之后注入的方向提示或 nudges。

3. **选择 judge provider：**默认情况下 judge 调用使用主 provider。若要隔离成本或延迟，传入独立的 `reflection.judge.provider`（或 `reflection.judge.evaluator`），例如轻量模型。如果需要构造该 provider，应扩展 touwaka 的模型配置和 `loop-bridge`。

4. **处理成对 store 的 checkpoint 失败：**由于 touwaka store 是成对的，checkpoint 写入失败会 fail-closed。瞬时 MariaDB 故障现在会导致运行失败，而不是允许工具调用继续。升级后观察数据库稳定性；如适用，增加宿主侧重试或 adapter 重试层。识别 `checkpoint_failed` 错误码，不要将其作为普通模型错误无限重试。执行后的失败窗口无法保证 exactly-once 执行，因此 `executeTool` 必须按 tool id 幂等。

5. **考虑 judge 持久化：**核心会将轮次 judge 数据以 `record.judge` 存入轮次 JSON，但 MariaDB transcript 表不一定有独立的 judge 列。如果 touwaka 需要字段级查询或回放，应添加列/索引，或在宿主 adapter 中查询存储的 JSON。拦截决策应从 `onJudge` 或宿主 judge 日志中捕获。

6. **容忍注入的审计消息：**模型可能收到运行时的 `【审计拦截】方向可能偏...` 和 `（附方向提示...）` 消息。它们是合成的 `user` 角色消息，可能出现在 transcript 中。展示层应容忍它们，或对其标记/过滤。

### 验证

- 将 erix-agent 依赖升级到 0.3.4，并运行一次长专家对话（`maxRounds >= 16`）。观察额外的 judge 使用量、模型在审计/拦截提示之后的行为，以及 MariaDB checkpoint 路径。
- 运行一次短对话（`maxRounds < 16`），不显式设置 `reflection`，确认不会启动自动 judge。
- 在 `wrapup: false` 下确认对话响应仍为自然语言，同时 `completion.signals` 仍然有效。

## 2. app_container（PI Agent 审计/开发链路）

**基线配置**（来自原始宿主集成指南；上线前请对照 app_container 仓库核实）：

- 调用点：`apps/worker/src/pi/runner.js:50` -> `runToolLoop`。
- 宿主不传 `reflection` 和 `store`；`maxRounds` 由调用方提供，审计器兜底为 **12**。
- `completion: { signals: [], maxNoToolRounds: 3 }`，重试次数：2。
- transcript 只将 `result.transcript` 写入 `transcript.json`（只有 messages，不包含 judge 或 usage 层）。
- 宿主移除 JSON wrapping，并将 `wrapup: false` 作为第二道防线传入。如果宿主最终 schema 含有顶层 `done: boolean` 键，例如 `{"done":true,"summary":...}`，其 JSON 形状无法与 wrap-up 协议区分。必需的自有 `done` 键守卫可以拒绝仅有 summary 的输出，但无法解决这种冲突；因此必须使用 `wrapup: false` 或进行 JSON 反序列化。
- 这对应 issue #71（judge 未启用且无 store）。

### 影响评估

- 审计器兜底 `maxRounds = 12` 时，核心自动 reflection 规则不适用，因此当前路径不会启动 judge。
- 如果任务使用 `maxRounds >= 16`、省略 `reflection` 且 `ERIX_NO_REFLECTION` 不是 `1`，核心自动 judge 会启动。
- 显式的 `reflection` 配置或显式的 `reflection: false` 始终优先于自动规则。

### 响应清单

1. **决定是否启用 judge：**
   - 如果审计或开发任务需要方向和完成检查，将 `maxRounds` 提高到至少 16，或传入 `reflection: { enabled: true }`。
   - 要保持当前行为，保持配置不变。
   - 显式传入 `reflection: false`，防止宿主之后提高 `maxRounds` 时意外启用。

2. **决定是否使用 store：**app_container 当前没有 store，因此没有 checkpoint 或 fail-closed checkpoint 行为，且 resume 不可用。对于无人值守的长任务崩溃恢复，应接入实现 `TranscriptStore` 契约的 file 或 database store。不添加 store 时，checkpoint 相关行为保持禁用。

3. **若启用 judge，持久化 judge 决策：**`result.transcript` 只包含 messages。使用 `onJudge` 写入审计轨迹，或添加 store 使轮次记录能够携带 `record.judge`；不要假定内存中的 result transcript 包含 judge 决策。

4. **处理 stall 软纠正：**app_container 之前可能看到 `llm_kit_stalled` 硬失败。当前 loop 会提示疑似重复调用，并在 stall 连续 3 次后以 `termination.reason: "stall"` 和 `truncated: true` 停止。没有 final guard 时这是正常返回；有 final guard 时，不可继续的 stall 可能以 `final_guard_unverified` 结束。

5. **校验 `maxRounds`：**传给 `runToolLoop` 的值必须是正的安全整数。审计器兜底值 12 有效。

### 验证

- 升级依赖并运行 `maxRounds = 12` 的审计任务，确认没有 judge 调用且现有路径保持不变。
- 如果启用 judge，运行长任务并观察轮次 judge、每第五次工具调用的拦截、`onJudge` 记录和合成审计消息。
- 确认调用方处理变化后的终止语义，尤其是旧的 stall 错误与 `termination.reason: "stall"` 的差异。
- 确认宿主的 `wrapup: false` 路径仍返回自己的最终 JSON/text schema，不进行协议解析或 `finalText` 替换。

## 3. 共同注意事项

| 主题 | 指引 |
|---|---|
| **成本** | 启用 judge 后，对符合条件的 `end_turn` 响应增加一次轮次 judge 调用，默认每五次真实工具执行增加一次拦截审计。总增量取决于运行情况；应测量 provider 使用量，不要依赖固定百分比。独立的 `reflection.judge.provider` 可以隔离成本。 |
| **Judge provider 配额** | 默认 judge 使用主 provider，因此主 provider 配额失败可能影响 judge 保护。轮次 judge 失败会降级为正常 governor 行为；拦截失败和超时会降级为直接执行工具。 |
| **`checkpoint_failed`** | 成对 store 无法在实际工具执行前或后持久化 checkpoint 时抛出。执行后消息明确说明工具已运行但结果未持久化。单独分类此错误，并让 `executeTool` 按 tool id 幂等。 |
| **合成审计消息** | `【审计拦截】方向可能偏...` 和 `（附方向提示...）` 是注入的 `user` 角色消息。它们可能出现在 transcript 和 UI 输出中。 |
| **终止原因** | 正常结果可以使用 `end_turn`、`no_tool`、`stall`、`max_rounds_cap`、`reflection_stop`、`judge_done` 或 `continuation_exhausted`；中止和未捕获失败使用 `aborted` 和 `failed`。如果 final guard 无法核验不可继续的结果，原因会变为 `final_guard_unverified`。宿主状态机应覆盖这些值，而不是将每个非错误返回都视为成功完成。 |
| **`onJudge`** | 每个轮次或拦截决策以 `{kind: "round"|"intercept", action, decision, tool?}` 传递；降级决策还会将 `error` 设为 `timeout`、`error` 或 `parse`。存储轮次记录时，轮次决策会持久化为 `record.judge`；拦截决策需要回调或日志。 |
| **`finalGuard`** | 核心 API guard 为 opt-in。默认 `finalGuardMaxRetries` 为 `2`；默认 `finalGuardTimeoutMs` 为 `30000`，非正值/非有限值使用该默认值。`{ action: "accept" }` 产生 `verification.status: "verified"`，`{ action: "skip", reason }` 产生 `"skipped"`，`{ action: "revise", message }` 会在可能时继续。耗尽重试或不可继续的修订产生 `"unverified"` 和 `final_guard_unverified`；guard 错误/超时返回 `"error"`，且不会将文本视为已核验。没有 guard 时以原因 `"no_final_guard"` 产生 `"skipped"`。 |
| **`wrapup` 与 `completion`** | `wrapup` 默认是 `true`；`wrapup: false` 或 `ERIX_NO_WRAPUP_INSTRUCTION=1` 会禁用指令注入、JSON 解析、`finalText` 替换和 wrap-up 规范化。规范化默认关闭，通过 `ERIX_WRAPUP_NORMALIZE=1` 或 `reflection.wrapupNormalize === true` 启用。`completion` 默认是 `{ signals: [], maxNoToolRounds: 3 }`；`completion: false` 禁用 completion/no-tool 策略，而不是 wrap-up 协议。 |
| **Stall detection** | `stallDetection` 默认是 mode 为 `"appear"` 的 `{ window: 4 }`；`"consecutive"` 要求整个窗口都匹配。`stallDetection: false` 会禁用它。`ERIX_STALL_MODE` 可以提供 mode，但显式的 `stallDetection: false` 优先。 |
| **环境控制** | `ERIX_NO_REFLECTION=1` 禁用自动 reflection；`ERIX_NO_ROUND_JUDGE=1` 只禁用 end-turn judge；`ERIX_NO_WRAPUP_INSTRUCTION=1` 禁用整个 wrap-up 协议；`ERIX_WRAPUP_NORMALIZE=1` 启用可选的 wrap-up 规范化。这些是 `src/loop.js` 中存在的运行时控制。 |
| **CLI 控制** | 在 `bin/cli.js` 中，`erix chat` 使用默认值为 `64` 的 `--max-rounds <n>`；`ERIX_MAX_ROUNDS` 是正整数回退值。未提供显式选项或环境设置时，当 `maxRounds >= 32`，CLI reflection 默认启用（不是 16）；`--reflection <on|off>` 和 `ERIX_REFLECTION` 控制它，而 `ERIX_NO_REFLECTION=1` 优先。`--final-guard` 和 `ERIX_FINAL_GUARD=1` 启用 CLI guard；`--no-final-guard` 是兼容性 no-op。`--judge-log <path>` 写入脱敏的轮次/拦截 JSONL，并覆盖 `ERIX_JUDGE_LOG`。`ERIX_NO_TOOL_ROUNDS` 控制 CLI 的正数 `maxNoToolRounds` 回退值，其默认值为 `3`。 |
| **版本锚点** | 本指南描述 v0.3.0-v0.3.4 的升级边界：0.3.1 仅修改 README，0.3.2 加入 MIT license，0.3.3 使 wrap-up 协议可切换，0.3.4 修复 judge task brief（#34）。之后的宿主可见行为见 [host-consumer-contract_cn.md](host-consumer-contract_cn.md)。 |

## 4. 升级清单（两个宿主）

- [ ] 确认 erix-agent 依赖版本（至少 0.3.4，包含 #34 task-brief 修复）。
- [ ] 选择并实施 reflection/judge 策略（自动启用、显式禁用或按专家配置）。
- [ ] 如果启用 judge，选择 judge provider（主 provider 或独立 provider）。
- [ ] 对使用 store 的宿主，确认 checkpoint 写入和加载方法成对，并理解 fail-closed 行为。对不使用 store 的宿主，确认不需要 resume 保护。
- [ ] 处理 `stall`、`judge_done`、`reflection_stop`、`final_guard_unverified` 以及上文列出的其他终止原因。
- [ ] 容忍或标记合成审计消息。
- [ ] 决定启用 final guard 时如何消费 `verification.status`；不得将 `skipped`、`unverified` 或 `error` 视为 `verified`。
- [ ] 测量长任务增加的 judge 使用量。
- [ ] 运行真实宿主验证：一次不启用自动 judge 的短任务，以及一次能观察到已配置 judge 行为的长任务。
