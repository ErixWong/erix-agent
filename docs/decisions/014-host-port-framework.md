# ADR-014：宿主端口框架（Ports & Adapters）——三宿主共性下沉与契约冻结

- 状态：**草案**（2026-09-15，待评审）
- 关联：ADR-001（ModelConfigProvider）、ADR-002（TranscriptStore）、ADR-006（tool provider）、
  ADR-009（安全分层）、issue #49（AssemblyPort + 三宿主共性下沉）、#98（持久化静默降级）、
  #96（回调 this 绑定回归）

## 一、背景

### 1.1 消费方

本库（erix-agent）被四个宿主消费：

| 宿主 | 配置来源 | Provider | store | session 身份 | 生命周期 | 事件出口 |
|---|---|---|---|---|---|---|
| CLI | `~/.erix/config.json`（json-file） | 库内 HTTP provider | 文件 JSONL | `process.cwd()` + unique | 一次性进程 | stdout |
| touwaka | MySQL `ai_model`/`providers` 表 | 自家 `LLMClient`（user_id/request_id 路由 + abort） | MariaDB 表 | expert/会话 | 长驻多会话 | SSE |
| app_container | `system_settings` + `pi_models` 表 | 自家 provider | `task_runs` | task/容器 | 任务级 | HTTP/DB |
| erix_station | 未接入（需求未验证） | ？ | ？ | FDE/工作区 | 长驻多用户 | ？ |

**共性（= 端口的依据）**：四个宿主无一例外都是
`拿到配置 → 造 provider → 给工具 → 给 store → 给身份 → 跑循环 → 收事件`。

### 1.2 既有基础（沿用，不新造）

ADR-001/002 已建立端口范式并落地部分：

- `ModelConfigProvider`（`resolve(slot?) → ModelConfig`），内置 `static`/`env`/`json-file`，`src/index.js` 导出；
- `TranscriptStore`，内置 `memory`/`file(JSONL)`；
- 契约测试包 `erix-agent/contract-tests`（`transcriptStoreContract` / `modelConfigProviderContract`）；
- 红线：**库内零 I/O 决策**（`docs/architecture.md:26`：文件/网络/DB 全部由注入的 provider/store/executeTool 完成）；
- ADR-002 明文：**DB 适配器永远在消费方项目侧实现，不进库**。

### 1.3 已付的代价（实测，非推测）

1. **装配层没有端口，重复已经发生**：装配逻辑（配置→provider→工具→store→身份→resume→事件）在
   `bin/cli.js:460-838`（~380 行）、touwaka `lib/llm-kit-adapters/`（**5 文件 1629 行**，其中
   `buildErixRunOptions()` 就是"装配 runToolLoop 参数包"）、app_container `apps/worker/src/pi/erix-adapter.js`
   各写了一遍——至少三份。
2. **契约漂移无人拦截**：
   - ADR-002 文档写 `TranscriptStore` 3 个方法，实际实现 **9 个**；
   - touwaka 的 `createErixStore` 只暴露 5 个（缺 `load`/`recall`/run-state 三件套），底层明明有——
     **该适配器跑不过已发布的 `transcriptStoreContract`**，「接口兼容」从未被验证；
   - `executeTool` 的调用约定靠 `function.length` 猜，**库和 touwaka 双向互猜**
     （touwaka 注释原文："erix uses function.length to decide…"——宿主被迫反向工程库源码）；
   - `buildErixRunOptions` 用 `...requestMeta` + `...passthrough` 透传任意键——宿主打错字静默用默认值、
     erix 改名后宿主配置静默失效。
3. **持久化静默降级**（#98）：`persist()` 对"方法不存在"直接 `return false` 静默跳过；写失败兜底
   `console.error`——headless 场景没有可靠错误交付通道。用户裁定：**写入失败必须通过 agent 直接告诉使用者**。
4. **回调语义回归**（#96，已修）：拆分 loop 时 `ctx.executeTool(...)` 改变了 `this` 绑定——630 个测试全绿
   也没抓到（测试没有依赖 `this` 的回调）。
5. **指针泄漏宿主假设**：折叠 stub 把**绝对文件路径**写进消息文本（进而进 transcript 持久化）；
   `src/compact/fold-statistical.js:69-80` 的导航记录把 id 清洗成 basename、locator 限定 line/byte 范围——
   库内已内建"文件系统风味"的指针模型，DB/对象存储宿主无法表达。

## 二、决策

### 2.1 三层框架

```
③ 适配层（宿主实现）    CLI 文件实现 / touwaka MariaDB / app_container / erix_station
        ↑ 实现的是
② 接口层（库声明）      端口契约：唯一形态 + 语义 + 错误约定
        ↑ 建立在
① 素材层（库共享实现）  协议归一化原语：宿主适配器由这些零件组装，薄到只剩胶水
```

**判据（决定一个交互是不是端口）**：

| 交互性质 | 归宿 |
|---|---|
| 会被**回读**，或参与**正确性判定** | ✅ 端口（本 ADR） |
| **只写不读**（日志/审计/统计） | ❌ 不做端口 → 统一事件流 `emit(event)` |
| **纯数据注入**（值，不是能力） | ❌ 普通参数（`maxRounds`、`writeToolNames`…） |

### 2.2 端口三件套（缺一不算落地）

每个端口必须同时具备：

1. **接口声明**：唯一调用形态、语义、成功/失败约定（写进 ADR 或 docs，成为单一事实源）；
2. **契约测试**：进 `erix-agent/contract-tests` 子路径；宿主适配器跑它全绿 = 兼容；
3. **库内置默认实现**：可替换的参考件，保证 CLI 开箱即用（否则试用者要先写七个 adapter）。

### 2.3 端口全景清单

| 端口 | 状态 | 契约测试 | 默认实现 |
|---|---|---|---|
| `ModelConfigProvider` | ✅ ADR-001 已声明 | ✅ 已有 | `static`/`env`/`json-file` |
| `TranscriptStore` | ✅ ADR-002 已声明，**文档需修正为实际 9 方法** | ⚠️ 缺 checkpoint/run-state 6 方法 | `memory` / `file(JSONL)` |
| `Provider`（chat/chatStream/流式回调/abort） | 有实现、无声明 | ❌ 新增 `providerContract` | `openai` / `anthropic` |
| `ToolExecutor`（executeTool） | 事实上存在、从未声明 | ❌ 新增 `executeToolContract` | `bin/tools.js`（CLI 工具集） |
| `diagnostics.error`（#98） | ❌ 新增——headless 最低错误出口 | 随 #98 | CLI：stderr + error.log |
| `AssemblyPort`（组合根） | ✅ P2 已落地——`createAssemblyPort` 收齐下列端口 | ✅ `assemblyPortContract` | `createAssemblyPort`；CLI 适配器可渐进迁移 |
| `ResourceStore`（归档产出物） | ✅ P2 已落地 | ✅ `resourceStoreContract` | `createFileResourceStore`（文件系统） |
| `NotesStore` | ❌ 新增（P3）——**引擎核心技能**（跨 run 记忆，ADR-007 落地件；用户裁定 2026-09-15 晚） | ❌ | CLI：文件系统 |
| ~~LogPort / MessagePort / MetricsPort~~ | **明确不做**：只写不读走 `emit(event)`；messages 就是 store 的数据 | — | — |

### 2.4 各端口的关键约定

**ToolExecutor**（终结 arity 猜测）：

```js
// 唯一形态：结构化对象——这是唯一签名，不保留位置形态
executeTool({ id, name, input, context, signal })
// 返回一并冻结：string | { content, metadata? } | Error
```

- 位置形态 `(name, input)` 不只是风格问题，是**语义缺陷**：`signal`（abort）与 `context`
  只有对象形态传得进来——留它等于宣布“工具不支持中断”；
- 两侧删除 `function.length` 猜测；契约测试断言调用形态与返回形态；
- 历史教训同族：#96 的 `this` 绑定、#98 的静默跳过——**隐式契约靠运气，冻结靠合同**。

**run options**（终结透传）：

- `runToolLoop` 对未知选项键**显式报错**（`TypeError: unknown option: …`），扩展点走显式命名空间
  （如 `requestMeta` 只进 provider 调用，不铺顶层）；
- 契约测试锁定选项面——erix 改名 = 宿主测试当场红，而非线上静默失效。

**TranscriptStore**（修正文档漂移）：

- ADR-002 的接口清单修正为实际 9 方法（appendRound / load / recall / saveCheckpoint /
  appendCheckpoint / loadLatestCheckpoint / saveRunState / loadRunState / markRunState）；
- 契约测试补齐 6 个未覆盖方法；
- 补充语义契约：`appendRound` 幂等（同 round 重写的约定）、记录 `schemaVersion`、
  大字段外置引用（`foldedPayloadRef`，可选）。

**指针不透明**（ResourceStore 的核心语义）：

```js
resourceStore.put(bytesOrText) → { locator, digest, display }
resourceStore.get(locator)     → bytesOrText
```

- 库**不解析、不假设** locator 是路径；`lineStart/byteStart` 等行/字节定位是**文件默认实现**的细节；
- 折叠 stub 渲染宿主给的 `display` 串（可为路径/URI/DB 引用），**绝不再把绝对路径写进消息**；
- `status` 词汇表扩展（`archived | truncated | external | expired`…）。

**diagnostics.error**（#98，headless 最低要求）：

- 结构化错误交付（事件含 `phase`/`operation`/`runId`/`sideEffect`/`error`），**不是日志端口**；
- `persistence: "none" | "required"` **两档，拒绝 best_effort**（理由见 2.7）；`required` 启动即校验
  全部方法，缺失列表直接失败；`required` 内建**有界重试**（复用 retry 的 attempts/backoff）
  吸收瞬时抖动，持续失败 → `persistence_error` + 终止 run；
- 写失败 → `persistence_error` 事件 + 终止 run（`termination.reason = "persistence_failed"`）；
- 删除 `persist()` 对缺方法的静默 `return false`；`console.error` 只是 CLI 适配器的兜底展示。

### 2.7 缓议与明确拒绝

- **~~NotesStore 缓议~~（已撤销，用户裁定）**：notes 是**引擎核心技能**而非宿主领域功能——跨 run 记忆
  与读写文件同级通用（ADR-007 记忆三层模型的落地件，npm 包已随包携带）。判据修正：
  **回读判据之外加通用性判据**——引擎本职的通用能力（记忆/文件/shell）→ 核心技能，
  库内置默认实现 + 端口化；宿主领域能力 → 宿主实现。形状从现有实现提取
  （`key → {current, superseded[≤3], folded, state}`，墓碑可见、provenance），不新设计。
- **拒绝 best_effort 持久化模式**：best_effort = “写失败继续跑”，即 #98 正在清除的
  静默降级换个名字。库失去承诺能力（内存态与持久态分叉，resume/recall 语义即坏）。
  瞬时抖动由 `required` 的有界重试吸收；真有宿主提出明确场景再按数据决定。

**AssemblyPort**（组合根）：

```js
createSession({
  modelConfig, // () => ModelConfigProvider（ADR-001，已有）
  provider,    // () => Provider（宿主构造，库永远不见 apiKey）
  tools,       // () => { definitions, executeTool, getToolMetadata? }
  store,       // () => TranscriptStore（file / MySQL / MariaDB 由宿主定）
  session,     // () => { id, resume?, initialMessages? }
  policy,      // () => {...} 可选，库给默认值
  emit,        // (event, payload) => void 可选
});
// 库侧职责：session 生命周期（submit/stop/history）、resume 语义、run-state、
//          事件分发、端口启动校验、默认策略——全部零 I/O
```

- 必填 = 循环跑不起来的（provider/tools/store/session）；其余可选 + 库默认值；
- **端口只在装配层**：`runToolLoop` 现有细粒度注入保持不动，不再包一层。

### 2.5 素材层（P1，先于契约冻结）

库导出协议归一化原语，**并让库内 `src/providers/openai.js` 也改用**（否则两份真相进库）：

- `normalizeOpenAIUsage` / `normalizeOpenAIStopReason` / `parseOpenAIToolArguments`
- `createOpenAIStreamAccumulator()`（流式 tool_call 分片拼装）
- `normalizeRoundRecord()`

素材层是普通导出函数（不是端口、不做抽象），随 semver 走。收益：touwaka 适配层 508 → ~80 行
（只剩 `llmClient` 绑定、`resolveModel(user_id)`、abort 桥接这些真宿主特有逻辑）。

### 2.6 三条纪律

1. **判据前置**：回读 → 端口；只写 → 事件；纯数据 → 参数。统一 ≠ 万物皆接口。
2. **三件套**：声明 + 契约测试 + 默认实现，缺一不算落地。
3. **版本化**：接口冻结后改名 = 破坏性变更（semver + 迁移说明）；记录/事件带 `schemaVersion`；
   不做能力协商引擎（`persistence` 显式模式即可）。

## 三、落地顺序（先收敛、再冻结、后扩展）

| 优先级 | 内容 | 归层 | Issue |
|---|---|---|---|
| **P0** | #98：diagnostics + persistence 模式 + 启动校验 + 删静默跳过 | ② | #98 |
| **P0** | ToolExecutor 唯一形态（两侧删 `.length` 猜测）+ run options 拒绝陌生键 | ② | #49 |
| **P1** | 素材归库：导出归一化原语 + 库内改用 + 删宿主 ~200 行 | ① | #49 |
| **P2** | 契约补齐（provider / store 9 方法 / round record / executeToolContract）+ AssemblyPort + ResourceStore + 对应契约 | ② | #49 |
| **P3** | NotesStore 端口化（notes 形状从现有实现提取，见 2.7） | ② | #49 |

## 四、明确不做

- ❌ 库内读配置文件 / 连数据库（零 I/O 决策红线；默认实现除外——它们是可替换件，不是引擎依赖）
- ❌ 为 erix_station 的想象形态预设计（未接入，需求未验证）
- ❌ 端口之上再套适配器注册表 / 能力协商 / 插件发现
- ❌ LogPort / MessagePort / MetricsPort（只写不读走 `emit`；messages 走 store）
- ❌ 改动 `runToolLoop` 的循环行为（本框架是装配层封装，不是改 agent 循环）

## 五、验收（框架级）

- [ ] 每个端口三件套齐备，契约测试可被外部项目 import 并跑通
- [ ] `bin/cli.js` 收敛为**文件型适配器**（第一个 adapter），`erix chat`/`erix repl` 行为完全不变
      ——构造性证明端口充分
- [ ] touwaka 适配层跑 `contract-tests` 全绿（需其仓库补 `load`/`recall`）
- [ ] 无任何消息文本内嵌宿主文件系统路径（指针一律 `display` 串）
- [ ] 持久化写失败必有结构化交付，无静默路径（#98 验收）
- [ ] 全量 `npm test` 绿；零新依赖；引擎核心零 I/O 不破

## 六、理由（为什么是这个形状）

- **不是新发明**：ADR-001/002 已验证该模式可行且已被 touwaka 实现过一遍——本 ADR 只是把
  "事实上存在的端口"补全声明、把"没冻结的约定"写成合同；
- **三份装配逻辑是当前最大维护税**：每次宿主可见行为变化改三处，且互相靠猜对齐；
- **静默失效是当前最大风险**：#96（`this`）与 #98（persist 跳过）证明，隐式契约的失效
  都发生在生产、无声无息——契约测试是把它们拦在门口的唯一手段；
- **顺序经过论证**：先收敛（P1）再冻结（P2），否则契约测试会把三份重复实现焊死。
