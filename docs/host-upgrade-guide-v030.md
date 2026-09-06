# erix-agent v0.3.x 宿主升级应对指南（touwaka / app_container）

> 本文档面向 erix-agent 的两个宿主（消费方）——**touwaka**（专家对话链路）与 **app_container**（PI Agent 审计/开发链路）。
> 说明从 erix-agent ≤0.2.0 升级到 **v0.3.x**（0.3.0 起，npm latest = 0.3.2）后，宿主侧需要知道的行为变化与应对项。
> 配套：erix README（能力总览）、[ADR-011](decisions/011-judge-direction.md)（judge 机制设计）、[ADR-010](decisions/)（压缩）。

---

## 0. 升级内容速览（宿主视角）

v0.3.x 在 `runToolLoop` 层新增/改变的宿主可见行为：

| # | 变化 | 宿主影响 |
|---|---|---|
| 1 | **reflection（judge 体系）默认开启**：`maxRounds ≥ 16` 且未显式传 `reflection` 时自动启用 | 长任务（≥16 轮）会多出 judge LLM 调用；短任务（<16 轮）不受影响 |
| 2 | **透明劫持审计**：每 `judgeIntervalRound`(5) 次真实工具执行后，下一次工具调用先 judge 再执行；方向错则拦截（不执行） | 宿主注入的 executeTool 可能"被跳过"（收到审计消息而非执行）——副作用拦截语义 |
| 3 | **round judge**：end_turn 时独立验证，`done && confidence≥0.7` 才放行 | 模型"想停"不再立即停——需 judge 确认；可提前 `judge_done` 终止 |
| 4 | **checkpoint fail-closed**（有 store 时）：工具执行前 checkpoint 写失败 → 抛 `checkpoint_failed`，**不执行工具** | 宿主的 store 写失败会导致任务失败（此前是继续执行） |
| 5 | **stall 软纠正**：重复调用不再硬杀任务——nudge 引导（≤2 次）+ 连续 3 次才 stop | 原 `llm_kit_stalled` 硬杀错误消失，变正常 stop |
| 6 | **direction 软提示**：judge 判 off_track 时放行但附加提示 | 模型可能收到方向引导文本 |
| 7 | **maxRounds 非法值校验**：NaN/0/负/Infinity 抛 TypeError | 宿主传参需合法 |
| 8 | **store JSONL 崩溃恢复**：损坏尾部修复/隔离 | file store 宿主（如有）resume 更稳 |
| 9 | **onJudge 事件 + judge 决策落盘**（新 API） | 宿主可消费 judge 决策（审计/复盘） |

---

## 1. touwaka（专家对话链路）

**现状**（核实于 2026-09-06）：
- 调用点：`lib/agent/agent-loop.js:1074` → `buildErixRunOptions`（`lib/llm-kit-adapters/loop-bridge.js`）
- `store`: createErixStore（MariaDB，`llm_kit_transcripts` + `llm_kit_run_state`，**saveCheckpoint/appendCheckpoint/loadLatestCheckpoint 齐全 = 成对**）
- `stallDetection: false`（显式关，touwaka 有自己的重试/恢复体系）
- `maxRounds`: expert 配置 `max_tool_rounds` 或系统设置，**兜底默认 20**
- `reflection`: **未传** → 走新默认
- loop-bridge 有 `...passthrough`（透传未知参数）→ 宿主传 reflection 可透传给 runToolLoop

### ⚠️ 关键：touwaka 升级 v0.3.x 后**默认启用 judge**（maxRounds 兜底 20 ≥ 16）

**含义**：专家对话轮次达 16+ 时，每次 end_turn 会触发 round judge（一次额外 LLM 调用 + 延迟），每 5 次工具执行触发一次透明审计。**这是行为变化，需主动决策**。

### 应对清单

1. **决定 judge 策略**（三选一）：
   - **A. 接受默认开启**（推荐用于长任务/审计型专家）：无需改动代码，自动获得方向把关 + 防假完成。需评估成本（judge 调用 = 主 provider 同配额）。
   - **B. 显式关闭**（保守，对话型专家不想多一次调用/延迟）：`buildErixRunOptions` 调用处传 `reflection: false`。
   - **C. 精细化配置**：按 expert 类型区分——如审计型开 judge、对话型关：
     ```js
     reflection: expertConfig?.judge === true
       ? { enabled: true, roundJudge: true, judgeIntervalRound: 5, judge: { provider: judgeProvider } }
       : false
     ```

2. **judge provider 决策**：默认 judge 用主 provider（与对话同模型同配额）。若要隔离成本/延迟，传独立 `judge.provider`（如轻量模型）。touwaka 的 modelConfig 体系需在 loop-bridge 增加 judge provider 构造。

3. **checkpoint fail-closed 影响**：touwaka store 是**成对的**（save+load 齐全）→ **会触发 fail-closed**。MariaDB 写失败（瞬时 DB 错误）现在会导致任务失败而非继续。应对：
   - 升级 erix 后观察 DB 稳定性；瞬时错误需宿主侧 retry 或 erix 侧 adapter 重试（erix 0.3.2 暂无 checkpoint 重试，宿主 adapter 可包一层）。
   - `checkpoint_failed` 错误码需宿主识别（不要当普通模型错误无限重试）。

4. **transcript 表无 judge 列**（issue #1116）：judge 决策已随 `appendRound` 存进 transcript JSON（`record.judge`），但 MariaDB 表结构无独立列。若要按 judge 字段查询/复盘 → 需宿主加列或读 JSON 字段。

5. **方向提示/审计消息**：模型可能收到"【审计拦截】方向可能偏…"或"（附方向提示…）"消息——这些是**用户角色的合成消息**，会出现在 transcript。宿主展示层需容忍（或过滤标记）。

### 验证步骤
- 升级 erix-agent 依赖到 0.3.2 → 跑一个长专家对话（≥16 轮）→ 观察：是否多出 judge 调用（usage 变化）、模型收到拦截/提示消息时行为、DB checkpoint 写路径正常。
- 短对话（<16 轮）确认**无行为变化**（judge 不触发）。

---

## 2. app_container（PI Agent 审计/开发链路）

**现状**（核实于 2026-09-06）：
- 调用点：`apps/worker/src/pi/runner.js:50` → `runToolLoop`
- 参数：**无 reflection、无 store**；`maxRounds` 由调用方传（auditor 默认 **12**）；`completion: { signals: [], maxNoToolRounds: 3 }`；retry attempts:2
- transcript 只落 `result.transcript` 到 `transcript.json`（messages 文本，无 judge/usage 分层持久化）
- 对应 issue #71（未启用 judge + 无 store）

### 影响评估
- **maxRounds 默认 12 < 16** → **不触发 reflection 默认开启**。现状行为基本不变（judge 不开）。
- 若某任务配置 maxRounds ≥ 16（长审计/开发任务）→ 会触发默认 judge。

### 应对清单

1. **决定是否启用 judge**（现状 = 不启用，因 maxRounds 12）：
   - 若审计/开发任务需要方向把关 → 提 maxRounds 到 ≥16（或显式传 `reflection: { enabled: true }`）。
   - 保持现状 → 无需改动（短任务不受影响）。
   - **明确传 `reflection: false`** 可防未来 maxRounds 调高时意外启用（显式优于隐式）。

2. **store 决策**：app_container 目前**无 store** → 无 checkpoint、无 fail-closed（不受 #4 影响）、resume 不可用。若要恢复保护（无人值守长任务 crash 恢复）→ 建议接入 file/DB store（见 erix TranscriptStore 契约）。不接 → checkpoint 相关能力（含 fail-closed）自动关闭，行为同旧版。

3. **judge 决策落盘**（如启用）：result.transcript 只有 messages——judge 决策（record.judge/onJudge）未持久化。若需审计链 → 用 `onJudge` 回调自行落盘，或接 store（issue #71 关联）。

4. **stall 软纠正**（#5）：app_container 之前可能遇到 `llm_kit_stalled` 硬杀——升级后变 nudge + 正常 stop。**行为改善**（长任务不再被一次重复误杀），无需改动，但任务终止 reason 从 error 变正常 stop（宿主状态机需识别 `termination.reason: "stall"`）。

5. **maxRounds 校验**（#7）：宿主传的 maxRounds 需合法（正整数）；默认 12 合法。

### 验证步骤
- 升级依赖 → 跑审计任务（maxRounds 12）确认无行为变化 → 若启用 judge 则跑长任务观察。
- 确认 terminate reason 语义（原 stall error → 现 normal stop）被调用方处理。

---

## 3. 共同注意点

| 主题 | 说明 |
|---|---|
| **成本** | judge 启用后：end_turn 每次 +1 LLM 调用（读足迹几百 token）；每 5 工具 +1 审计。长任务成本约 +10~30%。用独立 judge provider（轻模型）可降。 |
| **judge provider 配额** | judge 默认用主 provider（同配额）——主 provider 配额耗尽会连带 judge 失败（降级为直接执行，不崩任务，但有损保护）。 |
| **`checkpoint_failed`** | 只在"store 成对 + checkpoint 写失败 + 工具执行前"抛。宿主需识别该错误码（可重试/不可重试分类），勿当普通模型错误。 |
| **审计/提示消息** | "【审计拦截】…"与"（附方向提示…）"是 loop 注入的 **user role 合成消息**——进 transcript/展示，宿主需容忍。 |
| **termination reason 扩展** | 新增 `stall`（原 error）与可能的 `judge_done`（judge 确认完成提前停）。宿主 switch 需覆盖。 |
| **onJudge 新 API** | 每次 judge 决策 emit `{kind: "round"|"intercept", action, decision, tool?}`——审计/复盘消费入口。 |
| **env 开关** | `ERIX_NO_REFLECTION=1`（全关）/ `ERIX_NO_ROUND_JUDGE=1`（关 round judge）——运维兜底。 |
| **版本锚点** | 本文档对应 erix-agent **0.3.0~0.3.2**。0.3.1 仅 README，0.3.2 加 MIT license（无功能差异）。 |

---

## 4. 升级 checklist（两宿主通用）

- [ ] 确认 erix-agent 依赖版本（≥0.3.2）
- [ ] 决定 reflection/judge 策略（默认开 / 显式关 / 精细配置）并落实代码
- [ ] 若启用 judge：确认 judge provider（主 provider 或独立）
- [ ] store 宿主：确认 checkpoint 成对（save+load）→ 了解 fail-closed 语义；无 store 宿主：确认不需要恢复保护
- [ ] 覆盖新 termination reason（`stall`、`judge_done`）
- [ ] 处理合成审计消息（过滤/展示）
- [ ] 评估 judge 成本（长任务 +10~30%）
- [ ] 跑真机验证（短任务无变化 + 长任务 judge 生效）
