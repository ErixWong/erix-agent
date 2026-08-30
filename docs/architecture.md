# 架构与接口契约 — erix-llm-kit

> 接口以 JSDoc typedef 表达（消费双方都是纯 JS ESM，库不引 TypeScript 工具链）。

## 1. 数据流总览

```
调用方                          llm-kit                              LLM API
  │                                │                                   │
  │  system / tools / executeTool  │                                   │
  │  ModelConfigProvider           │                                   │
  │  TranscriptStore (可选)         │                                   │
  │───────── runToolLoop ─────────▶│                                   │
  │                                │── config.resolve(slot)           │
  │                                │── 组装 messages                   │
  │                                │── 每轮:                           │
  │                                │    ① compact.check(预算)          │
  │                                │    ② 快照 → store.append          │
  │                                │    ③ provider.chat ──────────────▶│
  │                                │    ④ tool_use → executeTool(回调)─▶ 调用方可信代码
  │                                │    ⑤ tool_result 回喂             │
  │                                │    ⑥ stall/完成信号判定           │
  │◀──────── { finalText, messages, transcript, usage, stats } ───────│
```

库内零 I/O 决策：文件/网络/DB 全部由注入的 provider/store/executeTool 完成。

## 2. 规范消息模型（canonical）

内部统一为 Anthropic 风格块（app_container 现有格式，OpenAI 侧由适配层双向转换）：

```js
// CanonicalMessage
{ role: "system" | "user" | "assistant", content: string | Block[] }
// Block =
//   { type: "text", text }
//   { type: "tool_use", id, name, input }
//   { type: "tool_result", tool_use_id, content, is_error? }
//   { type: "raw", protocol, payload }   // 逃生舱：协议特有特性不丢
```

**轮次分组规则**（压缩的不可分割单位）：
- Anthropic 线：一轮 = `assistant`（含 tool_use 块）+ 紧随的 `user`（tool_result 块）
- OpenAI 线：一轮 = `assistant`（含 tool_calls）+ 紧随的连续 `tool` 消息
- 纯文本 assistant（无工具调用）独立成一轮
- 头部 = system + **首个**真实 user 消息，永不折叠（与 FR-3.3 / 不变量 3 一致；后续真实 user 消息可参与折叠）

## 3. 核心接口

### 3.1 Provider（FR-1）

```js
/**
 * @typedef {Object} LlmProvider
 * @property {(req: ChatRequest) => Promise<ChatResponse>} chat
 * @property {(req: ChatRequest & {onDelta?: (s:string)=>void, signal?: AbortSignal}) => Promise<ChatResponse>} chatStream
 * @property {string} model
 * @property {string} protocol   // "openai" | "anthropic"
 *
 * @typedef {Object} ChatRequest
 * @property {string} system
 * @property {CanonicalMessage[]} messages
 * @property {ToolSchema[]} [tools]
 * @property {number} [maxTokens] @property {number} [temperature] @property {number} [topP]
 *
 * @typedef {Object} ChatResponse
 * @property {Block[]} content
 * @property {string} stopReason   // "end_turn" | "tool_use" | "max_tokens" | ...
 * @property {{input_tokens?:number, output_tokens?:number}} [usage]
 */

createProvider({ protocol, endpoint, apiKey, model, fetchImpl?, timeoutMs? }): LlmProvider
// 错误：KitError，code ∈ timeout|rate_limited|auth|network|server，retryable: boolean
```

### 3.2 runToolLoop（FR-2）

```js
runToolLoop({
  provider,
  system,
  initialUserMessage,        // 或 initialMessages（完整初始上下文，优先）
  initialMessages,
  tools,                     // 规范 ToolSchema[]（适配层负责序列化成协议原生格式）
  executeTool,               // (name, input) => Promise<string>  ← 手在调用方
  maxRounds = 8,
  maxTokens, temperature, topP,
  context: {                 // 压缩（FR-3），缺省不压缩 = 现状行为
    strategy,                // CompactionStrategy 实例
    budgetTokens,
    keepRounds = 6,          // 库默认值；app_container 现状硬滑窗为 10 轮，迁移时显式传 10 保持行为
  },
  retry: { attempts = 2, backoffBaseMs = 1500, backoffMaxMs = 10000 },
  stallDetection: { window = 4 } | false,
  completion: { signals = [], maxNoToolRounds = 3 } | false,  // 无工具轮策略
  store,                     // TranscriptStore（可选）：每轮快照落 store，支持崩溃续跑
  runId,                     // store 的键
  resume = false,            // true 时从 store 恢复上次进度（忽略 initialUserMessage/initialMessages，消息与轮次以 store 为准）
  onRound, onDelta, signal,
  onToolResult,              // 钩子：结果回喂前的截断/脱敏后处理（调用方政策点）
}) => Promise<{
  finalText, messages, transcript, rounds, truncated, usage,
  compactionStats: { compacted, foldedRounds, tokensBefore, tokensAfter }[],
}>
```

### 3.3 CompactionStrategy（FR-3，详见 ADR-003）

```js
/**
 * @typedef {Object} CompactionStrategy
 * @property {string} name
 * @property {(messages: CanonicalMessage[], budgetTokens: number) => boolean} shouldCompact
 * @property {(messages: CanonicalMessage[], opts: CompactOpts) => Promise<CompactResult>} compact
 * CompactResult = { messages, compacted, foldedRounds, tokensBefore, tokensAfter, foldedPayload? }
 * // foldedPayload：被折叠轮次的完整原文（调用方/store 留存，recall 的数据源）
 */
```

### 3.4 ModelConfigProvider（FR-4.1，详见 ADR-001）

```js
/**
 * @typedef {Object} ModelConfig
 * @property {"openai"|"anthropic"} protocol
 * @property {string} endpoint @property {string} model
 * @property {string} [apiKey]            // 直给（不推荐入库/入仓）
 * @property {string} [apiKeyEnv]         // 环境变量名间接引用
 * @property {string} [apiKeyFile]        // 600 凭据文件路径（对齐 ~/.config/mcp/creds 约定）
 * @property {number} [contextWindowTokens] @property {number} [maxOutputTokens]
 * @property {number} [temperature] @property {number} [topP]
 *
 * @typedef {Object} ModelConfigProvider
 * @property {(slot?: string) => Promise<ModelConfig>} resolve
 * // slot：按任务的可选模型槽位（"default" / "audit" / "fold" …），
 * // 对应 app_container pi-agent-runtime.md §8.7 预留的轻量扩展
 */
```

### 3.5 TranscriptStore（FR-4.2，详见 ADR-002）
```js
/**
 * @typedef {Object} TranscriptStore
 * @property {(runId: string, record: RoundRecord) => Promise<void>} appendRound
 * @property {(runId: string) => Promise<RoundRecord[]>} load
 * @property {(runId: string, fromRound?: number, toRound?: number, pattern?: string) => Promise<string>} recall
 * RoundRecord = { round, messages: CanonicalMessage[], folded: boolean, ts }
 */
```

### 3.6 ToolProvider / ToolRegistry（FR-5.3，详见 ADR-006）

分层语义：**执行器注册表 = 能力宇宙（代码）；ToolProvider = 选择与配置（数据）**。

```js
/**
 * @typedef {Object} ToolProvider
 * @property {(sel?: { set?: string }) => Promise<ToolSchema[]>} listTools
 */

createToolRegistry({ executors, schemas }) => {
  executeTool,                     // 喂给 runToolLoop
  resolveTools(provider, sel),     // 求交+覆盖；schema 无执行器 → fail closed
}
```

内置 provider：`static`（默认）/ `json-file` / `composite`；DB 适配器在项目侧。
`runToolLoop` 在调用执行器前按 schema 做入参最小校验（required/type/maxLength），
校验失败回 tool_result 错误，不碰执行器。

## 4. 源码结构

```
src/
├── index.js              # 公共导出（不含 tools，tools 走 subpath）
├── providers/
│   ├── index.js          # createProvider 工厂 + 协议分派
│   ├── openai.js         # chat/completions（流式 SSE 解析、2xx+error-body 透传）
│   ├── anthropic.js      # messages（流式 content_block 解析）
│   └── errors.js         # KitError + 错误分类 + retryable
├── messages/
│   ├── canonical.js      # 块格式 typedef + openai⇄canonical 双向转换
│   └── rounds.js         # groupIntoRounds（双协议成对规则）
├── tokens.js             # estimateTokens / estimateMessageTokens（系数可配）
├── compact/
│   ├── budget.js         # computeBudget(contextWindow, maxOutput)
│   ├── sliding-window.js # 策略①：整组丢弃（=app_container 现状行为）
│   ├── fold-statistical.js # 策略②：整组折叠 + 确定性统计摘要
│   ├── fold-llm.js       # 策略③：折叠点 LLM 工作日志（summarizer 注入；含确定性尺寸执法）
│   └── enforce-size.js   # LLM 摘要的优先级确定性修剪（FR-3.5）
├── store/
│   ├── memory.js         # 默认：进程内 Map
│   └── file.js           # JSONL：dir/<runId>.jsonl，每轮一行（v0.2）
├── config/
│   ├── static.js env.js  # v0.1
│   └── json-file.js      # v0.2：含 slot 与 apiKey 间接引用解析
├── tools/                # subpath export erix-agent/tools（v0.2）
│   ├── jail.js           # 路径牢笼助手（root 内解析、writable 子树、maskedPaths 拒读）
│   ├── file-tools.js     # readFile/rg/tree/writeFile 参考实现（建在 jail 上）
│   ├── recall.js         # recall 工具（建在 TranscriptStore 上）
│   ├── registry.js       # createToolRegistry：执行器宇宙 + schema 求交（ADR-006）
│   └── providers.js      # ToolProvider：static / json-file / composite
└── loop.js               # runToolLoop
```

## 5. 不变量

1. 库不执行工具；`executeTool` 是唯一执行入口，在调用方。
2. 折叠按轮整组，绝不产生孤儿 tool/tool_result 消息。
3. 头部（system + 首个真实 user）永不折叠。
4. LLM 产出的摘要必过确定性尺寸执法。
5. 被折叠的轮次在 store 中有完整原文（fold 只影响上下文，不影响档案）。
6. 库代码零密钥；apiKey 间接引用是一等公民。
7. 执行器只能来自代码注册表；数据（json/DB）只能选择在哪些暴露，不能新增能力。
