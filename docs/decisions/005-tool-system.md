# ADR-005：工具体系三层——契约在库、执行在调用方、参考实现走子路径

- 状态：已决策（2026-08-29）
- 背景：最纠结的问题。两个约束拉扯：
  - app_container 红线："LLM 只发工具调用请求，执行由可信代码校验白名单后转发，
    LLM 无任何直接执行面"——**库绝不能自带会执行的工具**。
  - 但零内置意味着每个项目重写 readFile/rg/tree 和路径牢笼——而这些**逻辑本身**是通用的。

## 决策：三层分离

### 第一层：工具契约（核心包，零工具）

- 规范 `ToolSchema`（JSON Schema 入参），**协议序列化由适配层负责**
  （OpenAI `tools[].function` ⇄ Anthropic `tools[].input_schema`，调用方只写一份）。
- `executeTool(name, input)` 回调是循环的唯一执行入口，实现永远在调用方。
- `onToolResult` 钩子：结果回喂 LLM 前的后处理点（截断/脱敏/扫描），
  项目政策（如 app_container 的 secret 复查）挂在这里，库提供挂载点不提供规则。

### 第二层：可选工具库（`@erix/llm-kit/tools` 子路径导出，v0.2）

不进主导出，显式 `import … from "@erix/llm-kit/tools"` 才可用。三件：

1. **`createJail({ root, writable = [], maskedPaths = [] })`** —— 路径牢笼助手。
   解析后必须仍在 root 内（越界抛错）、写仅限 writable 子树、maskedPaths 拒读。
   这是两个项目都需要的纯逻辑，与"执行什么"无关，值得共享。
2. **文件工具参考实现**（readFile/rg/tree/writeFile）——建在 jail 上，
   适合脚本/原型/低风险场景直接用；生产场景项目可抄可换。
3. **`recall` 工具**（用户点名内置）——建在 TranscriptStore 上：

```
recall({ fromRound?, toRound?, pattern? }) → 被折叠轮次的原文摘录
```

摘要里统一写"早期 N 轮已折叠，可 recall(fromRound: X, toRound: Y) 取回"。
**折叠由此从有损变近无损**——这是本库相对两个前身的核心增量，
也是 recall 必须内置的理由：它和压缩策略是同一枚硬币的两面，分家就断了。

### 第三层：永不进库

白名单校验策略、容器 exec、网络类工具、业务工具（文档检索/notes/embedding…）。
这些携带项目安全模型与业务语义，共享即泄漏抽象。

## 理由

- "契约共享、执行私有"同时满足安全红线和去重诉求：
  touwaka 的 toolManager、app_container 的 tools.js 都只需把 schema 换成规范格式，
  执行体一行不动。
- 子路径导出让"用参考实现"成为显式选择而非默认行为，误用成本高。
- recall 依赖 store 接口而非具体实现：memory store 也能 recall（进程内任务），
  file store 天然持久。

## 后果

- 项目侧迁移工作量 = schema 格式转换 +（可选）换用 createJail。
- 参考实现的质量边界要在文档写明："参考级，生产慎用，严肃场景请自建执行层"。
- 未来若出现第三个消费方需要新协议（Gemini），只动第一层适配，二三层不受影响。
