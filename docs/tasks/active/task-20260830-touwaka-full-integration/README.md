# task-20260830-touwaka-full-integration

**erix-agent 全面承载 touwaka 专家对话 —— 能力升级清单（分析结论）**

## 目标

分析 touwaka（AI 专家系统）若要以 erix-agent 引擎作为专家对话链路的底座（替代 AgentLoop / LLMClient 的实现职责），erix-agent 还需要升级哪些能力。产出可执行的升级清单与版本规划。

## 范围

- 消费方：touwaka（`/home/eric/projects/touwaka`）专家对话关键路径：
  - `lib/agent/agent-loop.js`（核心循环：完成信号 / 连续无工具轮 / 流式恢复重试 / compactHistory / 证据注入 / LLM payload 缓存）
  - `lib/chat/base-llm.js`（流式传输：reasoning/thinking/tool_calls 实时事件、流式绝对/停滞超时、keep-alive）
  - `lib/llm-client.js`（多模态、abort 注册、图片注入/清理）
  - `lib/message-llm-client.js` + `lib/llm-thinking-config.js`（thinking 策略矩阵）
  - `lib/token-utils.js`、`lib/agent/history-compactor.js`、`lib/chat/round-state-snapshot.js`、`lib/llm-retry.js`、`lib/http-agent.js`
- 引擎侧：erix-agent（本仓库）`src/` 全部：loop / providers / messages / compact / tokens / store / config
- 分析方式：逐文件差异对比（本任务由 copilot_cli 委派分析 + 主 agent 核实行号/事实）

## 结论总览

`erix-agent@0.1.0` 目前只能替代「工具循环 + Provider 调用 + 基础压缩」骨架，**不能直接承载 touwaka 完整专家对话链路**。核心缺口四类：

1. canonical 消息保真（reasoning/thinking/图片/raw 丢失）
2. 流式事件与恢复语义不完整（无 reasoning/tool-call/usage 实时事件、无 round snapshot）
3. thinking/多模态参数与超时模型透传不足
4. 工具执行接口与持久化契约不达生产要求

## P0 升级清单（全面使用的前置硬阻塞，8 项）

| # | 能力 | 现状缺口（文件:行号佐证） |
|---|---|---|
| 1 | canonical 消息模型完整保真 | 仅 text/tool_use/tool_result/raw 四类块；`canonicalToOpenAIMessages` 显式跳过 raw（src/messages/canonical.js:128-131）；`openAIResponseToCanonical` 不读 reasoning_content（canonical.js:177-220）。touwaka message-converter 已把 reasoning 存为 raw 扩展块，当前转换即丢 |
| 2 | thinking/reasoning 参数透传 | `buildPayload` 仅 model/messages/tools/max_tokens/temperature/top_p（src/providers/openai.js:47-60）；touwaka 每轮依赖 thinking/reasoning/reasoning_effort/enable_thinking/chat_template_kwargs（lib/chat/base-llm.js:104-108） |
| 3 | 流式 reasoning/tool-call/usage 事件 | `chatStream` 仅 onDelta；tool_calls 流结束才整体组装（openai.js:404-436）；Anthropic assembler 不处理 thinking_delta。touwaka 有四事件 onDelta/onReasoningDelta/onToolCall/onUsage（base-llm.js:527-560） |
| 4 | 流式恢复重试 + round snapshot | retry 仅存 messages.length 截断回滚（src/loop.js:192-224），无法恢复 finalText/reasoning/usage/已发事件；touwaka 有完整 round snapshot + recovering/recovered 事件（agent-loop.js:186-297） |
| 5 | 流式超时模型（首字/总时长/停滞） | 单一 timeoutMs 全程 race；touwaka 区分慢首字保护、首字节后 total、最后数据后 idle（base-llm.js:398-450） |
| 6 | 结构化工具执行接口 | `executeTool(name, input) => string`；touwaka 需完整上下文（expert/user/task/session/request_id）+ 结果元数据（success/data/duration/toolMessageId/atomic_steps/图片） |
| 7 | completion/no-tool continuation 显式化 | completion 默认 false（关闭）；touwaka 依赖中文 COMPLETION_SIGNALS + 连续无工具轮，直接替换会致任务型专家提前收尾 |
| 8 | 消息结构校验贯穿运行 | 仅 groupIntoRounds 校验 tool_use/tool_result 配对（且只在压缩时触发）；无压缩路径下可能把非法结构直接交给 provider |

## P1 升级清单（核心体验差异，必须补，8 项）

| # | 能力 | 关键点 |
|---|---|---|
| 9 | token 估算对齐 | 不统计消息 overhead/图片成本/reasoning/raw；touwaka 有 IMAGE_TOKEN_COST=1000、MESSAGE_OVERHEAD=4（token-utils.js:7-10） |
| 10 | 压缩后强制不超预算 | fold 后不再校验；enforceSize 只剪摘要字段 |
| 11 | 压缩支持 system 注入/图片清理 hook | erix 摘要前置到 user 消息；touwaka 是 system 角色注入 + stripHistoricalImages |
| 12 | provider 超时错误带 phase/retryable | 错误需携带 code/phase/elapsedMs |
| 13 | retryable 错误分类覆盖网络断连 | RETRYABLE_CODES 仅 timeout/rate_limited/server（src/providers/errors.js:1）；ECONNRESET/EPIPE/502-504 不可重试；touwaka isRetryableError 全覆盖 |
| 14 | TranscriptStore 幂等/元数据/checkpoint | append 失败被吞（src/loop.js:372-378）；touwaka store 已有业务列但 erix loop 未利用 folded_payload 恢复 |
| 15 | 中性生命周期事件总线 | 需 onEvent 统一（round/attempt/usage/recovering…），由 touwaka 映射 SSE |
| 16 | transport 可配置（keep-alive） | provider 基于 fetch，无法复用 touwaka 的 http.Agent 连接池（lib/http-agent.js） |

## 发布层面问题（非引擎能力，但阻塞集成）

1. **contract-tests 导出断裂**：package.json `exports["./contract-tests"]` 指向 `./test/contract/index.js`，但 `files` 只含 `src/bin/README.md`，**test 目录未随包发布**——touwaka 契约测试换包导入会失败。需修（files 加 test/contract 或迁入 src/），重发 0.1.1。
2. **Node 版本**：erix-agent 要求 Node ≥22，touwaka 生产 4 个 compose 全是 Node 20 镜像，升级前置。

## touwaka 侧保留、不上移 erix-agent 的能力

- ToolManager 执行面（权限/校验/展示名/atomic_steps 轨迹）
- 文档检索证据聚合注入（`_consumeDocRetrievalResult`）
- 多模态业务策略（图片识别/降级/合成消息/历史清理）
- 业务持久化（MariaDB TranscriptStore、消息表转换、LLM payload 审计缓存）
- SSE 前端协议（tool_call 实时展示、tool_limit_warning、history_compacted 等事件映射）
- thinking policy 业务决策（模型名规则、/no_think 策略留在 llm-thinking-config.js）

## 版本规划建议

```
0.2.0-alpha   canonical v0.2（image/reasoning/raw 保真）+ 双向转换 + thinking 参数透传 + 消息校验 + token 对齐
0.2.0-beta    流式事件（onEvent/onReasoningDelta/onToolCall/onUsage）+ round snapshot 恢复 + 超时模型 + retryable 分类
0.2.0-rc      结构化 executeTool + compaction hooks + 强制预算 + TranscriptStore 幂等/checkpoint
0.2.0         接入 touwaka 适配器、替换 AgentLoop 实际链路、SSE 适配层落地
（附带 0.1.1：修 contract-tests 发布）
```

验收标准：OpenAI/Anthropic 文本/工具/reasoning/thinking/图片消息不丢字段；流式断连重试不重复前端已显示内容；用户中止能终止请求与退避；压缩后满足 provider 结构约束与 token 预算；resume 不重复执行已完成工具。

## 验证结论

- ✅ 已逐文件核实 erix-agent 引擎现状（loop/providers/messages/compact/tokens/store/config）
- ✅ 已核实 touwaka 专家对话关键路径（AgentLoop/LLMClient/base-llm/thinking-config/token-utils/round-snapshot/llm-retry）
- ✅ 关键行号引用经主 agent 复核（errors.js retryable 集合、canonical raw 跳过、buildPayload 字段、stream 事件）
- ⏳ 未验证：升级落地后的行为（待 0.2.0 各里程碑实现后回归）

## 状态

`active` —— 分析结论已定稿，待开 issue 立项（建议 Gitea issue，类型 enhancement）
