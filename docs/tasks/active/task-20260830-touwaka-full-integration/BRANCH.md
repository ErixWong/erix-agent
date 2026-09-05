# BRANCH.md — task-20260830-touwaka-full-integration

## 当前分支

- 仓库：`~/projects/erix-llm-kit`
- 当前：`master`（本地，远端 `github` = ErixWong/erix-agent，`origin` = git.erix.vip/eric/erix-llm-kit）

## 建议分支

- 类型：`refactor`（引擎能力升级属重构/增强混合；若走版本里程碑拆多 PR，则每个里程碑一个分支）
- 命名：`refactor/20260830-touwaka-full-integration`
- 若按里程碑拆分：
  - `refactor/20260830-touwaka-integration-contract-tests`（0.1.1 发布缺陷：files/contract-tests）
  - `refactor/20260830-touwaka-integration-v020-alpha`（canonical v0.2 + 参数透传 + 校验 + token）
  - `refactor/20260830-touwaka-integration-v020-beta`（流式事件 + snapshot 恢复 + 超时模型 + retryable）
  - `refactor/20260830-touwaka-integration-v020-rc`（executeTool + compaction hooks + TranscriptStore 契约）

## Issue 映射

- 无正式 Issue。按 GLOBAL_AGENTS.md「新需求先确认 issue」与 touwaka AGENTS.md 标准流程，开工前建议：
  - Gitea issue：`enhancement: erix-agent 引擎升级以全面承载 touwaka 专家对话（canonical v0.2 / 流式事件 / 工具契约）`
  - 里程碑：0.2.0（alpha → beta → rc），0.1.1 为发布缺陷修复
- 关联仓库：touwaka（消费方集成面）侧另开 issue 记录适配器升级（message-converter canonical v0.2、ModelConfigProvider 参数扩展、TranscriptStore 新契约、SSE 适配层）

## 修改范围（erix-agent 引擎侧）

| 模块 | 文件 | 变更 |
|---|---|---|
| 发布 | `package.json` | files 加 `test/contract`（或契约测试迁 src/），版本 0.1.1 |
| messages | `src/messages/canonical.js` | canonical v0.2：新增 image/reasoning 块、raw 保真、reasoning_content ↔ reasoning、tool call 元数据 |
| messages | `src/messages/anthropic.js` | thinking_delta/signature 处理、raw 保留 |
| messages | `src/messages/rounds.js` | 结构校验抽出为独立入口（贯穿运行） |
| providers | `src/providers/openai.js` | 参数透传（frequency/presence/response_format/thinking/reasoning/reasoning_effort/enable_thinking/chat_template_kwargs/providerOptions）；流式事件 onReasoningDelta/onToolCall/onUsage；超时模型（request/firstByte/streamTotal/streamIdle）；transport 注入 |
| providers | `src/providers/anthropic.js` | 同上对齐 |
| providers | `src/providers/errors.js` | retryable 覆盖 ECONNRESET/EPIPE/502-504；错误带 phase/elapsedMs |
| loop | `src/loop.js` | round snapshot 恢复；attempt 事件去重；退避响应 AbortSignal；结构化 executeTool({id,name,input,context,signal})；completion policy 显式化；中性 onEvent 事件总线；store 幂等/checkpoint 语义 |
| compact | `src/compact/*.js` | 压缩后强制预算校验；summaryRole/protectedMessage/前后 hook |
| tokens | `src/tokens.js` | overhead/图片成本/reasoning/raw 覆盖，成本可配置 |
| store | `src/store/*.js` | 契约扩展：append 幂等键、loadLatestCheckpoint、markRunState、onPersistenceError |
| config | `src/config/*.js` | ModelConfig 字段扩展（protocol/timeout/model_type/supports_reasoning/thinking_format） |

## 消费方配合（touwaka 侧，另仓）

- `lib/llm-kit-adapters/message-converter.js`：升级 canonical v0.2 双向转换
- `lib/llm-kit-adapters/model-config-provider.js`：协议/参数/能力字段补齐
- `lib/llm-kit-adapters/transcript-store.js`：适配新 store 契约（幂等/checkpoint）
- 新增 SSE 适配层：erix 中性事件 → 现有前端协议
- AgentLoop 迁移：保留流式外壳 + 业务 hooks，循环决策交由 runToolLoop

## 约束

- 零运行时依赖、纯 ESM、Node 22+、无构建（保持）
- 测试 `node --test` 全绿；契约测试随包可导入（`erix-agent/contract-tests`）
- 任何提交禁止 token/密钥明文
