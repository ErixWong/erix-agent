# 需求文档 — erix-llm-kit

> 2026-08-29 初版。背景：app_container 与 touwaka 各自实现了 LLM 工具循环与上下文管理，
> 逻辑重复（两份 token 估算、两份压缩、两份协议适配），且各自缺对方已验证的能力。
> 本库把共有层抽出，各自只保留项目特有的执行/存储/安全层。

## 1. 两个消费方的现状与痛点

### app_container（`apps/worker/src/pi/` + `packages/context`）

- 已有：双协议归一（OpenAI/Anthropic → 统一 tool_use/tool_result 块）、死循环检测（签名窗口比对）、
  固定 10 轮硬滑窗、max_tokens 续写、骨架折叠（idea 对话，`chat_summary_json` + `foldedUpTo` 水位线）
- 痛点：① 硬滑窗**静默丢弃**早期轮次，24 轮开发任务丢一半历史，模型"换种方式重做"打转；
  ② provider 抛错 → 整个 task 失败 → reaper 从头重跑（已跑的 LLM 调用费全浪费）；
  ③ `pi_models.context_window_tokens` 已入库但**没接到循环**（llm-context-budget.md §7 "本期不动"）；
  ④ 骨架折叠结果无确定性尺寸执法（信任 LLM 自律，违反"终稿归代码"不变量）。

### touwaka（`lib/agent/` + `lib/context-organizer/`）

- 已有：预算驱动整组折叠 + 统计摘要（history-compactor，R19-1）、轮内快照重试（round-state-snapshot）、
  完成信号判定（R15）、相邻 assistant 合并（R16-3）、孤儿消息防护、Psyche 反思体系（对话场景）
- 痛点：与 app_container 逻辑重复但各自演化；压缩/重试经验没有回流通道。

## 2. 目标 / 非目标

### 目标

1. 双协议适配（OpenAI 兼容 + Anthropic），流式/非流式，统一内部块格式，统一错误分类
2. 工具调用循环：maxRounds、轮内快照重试、死循环检测、完成信号/无工具轮策略、max_tokens 续写
3. 上下文预算压缩：策略可插拔（见 ADR-003），折叠可回溯（配合 recall，见 ADR-005）
4. 配置与存取走适配器（见 ADR-001 / ADR-002），库内置文件系实现，DB 实现留在项目侧
5. 零运行时依赖、纯 ESM、Node 22+、`node --test`

### 非目标（永远不做）

- ❌ 内置会执行的工具（read/bash/write 的**执行**在调用方；库只提供参考实现与牢笼助手，见 ADR-005）
- ❌ agent 人格/skills/会话管理/TUI/MCP
- ❌ 安全策略（白名单校验、密钥脱敏规则、产物海关）——调用方职责
- ❌ 存储引擎选型（DB schema 在项目侧，库只定义接口）
- ❌ 成为"迷你 pi"。需要完整 agent 时直接用 pi 本体/SDK，不把本库养成 agent

## 3. 功能需求

### FR-1 Provider 适配

| # | 需求 | 来源 |
|---|---|---|
| FR-1.1 | OpenAI 兼容（chat/completions）+ Anthropic（messages）双协议，流式+非流式 | app_container 已实现，抽出 |
| FR-1.2 | 两协议归一到同一内部块格式（text / tool_use / tool_result） | app_container 已实现 |
| FR-1.3 | 统一错误分类：timeout / rate_limited / auth / network / server，可重试性标记 | 两边各有，合并 |
| FR-1.4 | HTTP 2xx + error-body 透传真实上游 message（不误报 no choices） | app_container 已有 |
| FR-1.5 | 模型元信息（contextWindowTokens / maxOutputTokens）随配置传入循环，驱动压缩预算 | app_container 缺口 |

### FR-2 工具循环（runToolLoop）

| # | 需求 | 来源 |
|---|---|---|
| FR-2.1 | 调用方注入 `tools`（规范 JSON Schema）+ `executeTool(name, input)` 回调；库不执行 | 架构红线 |
| FR-2.2 | 轮内快照重试：可重试错误就地恢复快照重试（默认 2 次，指数退避 1.5s→10s），仍失败才抛出 | touwaka R-系修复 |
| FR-2.3 | 死循环检测：工具签名滑动窗口比对，重复即抛 `llm_kit_stalled` | app_container 已有 |
| FR-2.4 | 完成信号 + 无工具轮策略：有工具历史且无完成信号时视为过渡文本继续（可配，默认连续 3 轮强制结束）；相邻 assistant 合并防 400 | touwaka R15/R16-3 |
| FR-2.5 | max_tokens 截断续写 | app_container 已有 |
| FR-2.6 | 每轮 LLM 调用前跑压缩检查（FR-3），压缩事件进返回的 stats | touwaka R19-1 |

### FR-3 上下文压缩

| # | 需求 | 来源 |
|---|---|---|
| FR-3.1 | 预算 = contextWindowTokens − maxOutputTokens − max(2000, 10%窗口) | app_container llm-context-budget.md |
| FR-3.2 | token 估算：中文 1.5 tok/字、其余 3.5 字/tok、+15% 余量（保守宁高勿低，系数可配） | 两边合并取保守 |
| FR-3.3 | 整组折叠：轮 = assistant + 紧随的工具结果消息（两种协议各自的成对规则），头部 system+首个 user 永不折叠 | touwaka，扩展双协议 |
| FR-3.4 | 策略谱系（详见 ADR-003）：`sliding-window` → `fold-statistical` → `fold-llm`（可选 summarizer）→ `psyche`（v2） | 本次升级核心 |
| FR-3.5 | LLM 产出的摘要（fold-llm/psyche）必须过**确定性尺寸执法**：代码按字段优先级修剪到预算内，不信任 LLM 自律 | Psyche 借鉴 + app_container 不变量 |
| FR-3.6 | 折叠水位线 `foldedUpTo`：被折叠轮次完整进 TranscriptStore，可经 recall 工具取回（近无损折叠） | app_container 水位线 + touwaka recall 融合 |

### FR-4 配置与存取适配器

| # | 需求 | 详见 |
|---|---|---|
| FR-4.1 | ModelConfigProvider 接口 + static/env/json-file 内置实现；apiKey 支持 env/文件间接引用 | ADR-001 |
| FR-4.2 | TranscriptStore 接口 + memory/file(JSONL) 内置实现；支持崩溃续跑 | ADR-002 |

### FR-5 工具体系

| # | 需求 | 详见 |
|---|---|---|
| FR-5.1 | 规范工具 schema + 协议序列化由适配层负责；执行永远在调用方 | ADR-005 |
| FR-5.2 | 可选子路径导出 `erix-agent/tools`：路径牢笼助手 + 文件工具参考实现 + recall | ADR-005 |
| FR-5.3 | ToolProvider 分层：定义可插拔（static/json-file/composite，DB 在项目侧），执行器注册表永远在代码，求交 fail closed | ADR-006 |

## 4. 分期

| 版本 | 内容 | 验收 |
|---|---|---|
| **v0.0** | **MVP 垂直切片**（issue #1）：openai provider（非流式）+ canonical + tokens + runToolLoop 最小版（maxRounds / executeTool / 死循环检测）+ memory store + `examples/exec-demo`（exec 工具在 demo 侧，实证"库不执行"红线） | `node --test` 全绿（mock fetch）；exec demo 对真实 LLM（本机 relay）跑通多轮工具调用，transcript 完整 |
| **v0.1** | providers 全量（+Anthropic +流式）+ messages + tokens + loop（FR-1/2 全量）+ sliding-window + fold-statistical + memory store + config（static / env） | app_container **完整迁移 runToolLoop**（只迁纯函数层不算完成），原有 `npm test` 全绿；24 轮开发场景不再静默丢历史；**行为指标**：折叠后模型"重做已完成工作"次数较硬滑窗基线可观测下降 |
| **v0.2** | file store(JSONL) + recall 工具 + json-file config + fold-llm summarizer + tools 子路径（牢笼+文件工具+registry/ToolProvider） | 崩溃续跑演示；折叠后 recall 能取回原文 |
| **v1.0** | touwaka 迁移（第一步只换 token-utils/history-compactor，AgentLoop 本体看收益再定）+ 文档完善 | touwaka 侧测试全绿、行为无回归 |
| **v2 候选** | psyche 策略（对话场景）、每轮反思、Gemini native（触发 AI SDK 底座重估） | 另行立项 |

## 5. 非功能需求

- `examples/` 是一等公民：每个里程碑附可运行 demo（exec / 对话 / 审计），新消费方按 demo 接入；demo 同时承担"调用方角色"的实证职责（执行体全在 demo 侧）
- 存储策略：库内置 memory → file(JSONL) 先行，文件系统即可跑通全链路；DB 适配器用本机 MariaDB，但永远在**消费方项目侧**实现 TranscriptStore / ModelConfigProvider 接口，不进库（ADR-001/002）
- 零运行时依赖；devDependencies 也不引入（node --test 够用）
- 库内任何文件不含密钥；配置适配器的 apiKey 间接引用机制是第一公民（ADR-001）
- 所有压缩/重试行为有 `node --test` 单测锁定；协议适配层用 mock fetch 测
- 发布走 Gitea npm registry（`erix-agent`），消费方 docker build 用 secret mount 注入 npmrc token

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 抽象泄漏：双协议归一后某协议特性丢失 | v0.1 验收以 app_container 全量测试通过为准；canonical 格式保留 `raw` 逃生舱 |
| touwaka 迁移回归（AgentLoop 有 R15/R16/R19 一串实战修复） | v1.0 只迁纯函数层；AgentLoop 本体迁移单列决策 |
| 单维护者项目的发布摩擦 | 版本语义化 + CHANGELOG；消费方锁版本升级 |
| 迁移搁置：库做好了消费方不迁（迁移有成本无即时收益，单维护者尤其容易搁置） | v0.1 验收绑死 app_container 完整迁移 runToolLoop；库退化为"纯 utils 包"即视为失败 |
| 上游 API 侵蚀：商业 API 内建 context editing / 服务端循环能力 | 价值锚点绑定自托管 relay + 开源模型场景（服务端能力不可用，自研是唯一解）；触发重估条件不变（README） |
| 压缩谱系造了四级只用第一级 | v0.1 验收含行为指标；谱系升级必须实证驱动（ADR-004 的升级阶梯，不跳级） |
