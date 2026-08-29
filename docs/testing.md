# 测试方案 — erix-llm-kit

> 原则：零依赖（只用 `node:test` + `node:assert`）、协议层 mock fetch、循环层 fake provider、
> 真实 LLM 只做少量 e2e 且可开关。本库无浏览器/UI，不需要 playwright/vision。

## 0. 测试分层与基建

### 分层

| 层 | 命令 | 依赖 | 何时跑 |
|---|---|---|---|
| 单测 | `npm test`（`node --test`） | 无网络 | 每次提交前，必须全绿 |
| e2e（真实 LLM） | `node examples/exec-demo.test.mjs` | 本机 relay 在线 | 里程碑验收手动跑；`LLM_KIT_E2E=1` 才执行，缺省 skip |

### 三个测试基建（v0.0 第一天就建）

1. **mock fetch**（`test/helpers/mock-fetch.js`）：可编程的 fetchImpl——
   捕获请求体（断言序列化结果）+ 按脚本返回响应（含错误码 / 2xx+error-body / 流式 SSE 字节流）。
   协议适配层的全部测试都走它，不碰网络。
2. **fake provider**（`test/helpers/fake-provider.js`）：内存版 LlmProvider，
   按脚本依次吐出 content 块（text / tool_use），可注入"第 N 次调用抛可重试错误"。
   循环层测试不走 HTTP，直接喂 fake provider——loop 的测试对象是编排逻辑，不是协议。
3. **canonical fixtures**（`test/fixtures/`）：双协议典型消息序列样本
   （纯文本轮 / 工具轮 / 连续工具轮 / 多轮混合），canonical 转换与压缩分组共用。

## 1. v0.0（MVP）——"链路通"

### 单测

| 模块 | 测什么 |
|---|---|
| `providers/openai` | 请求序列化（canonical→openai messages/tools）；响应解析（text / tool_calls→canonical 块）；FR-1.3 错误分类五类 + retryable 标记；FR-1.4 2xx+error-body 透传真实 message；timeoutMs 触发 abort → timeout |
| `messages/canonical` | openai⇄canonical 双向转换无损；`raw` 逃生舱保留协议特有字段 |
| `tokens` | 中文 1.5 tok/字、英文 3.5 字/tok、混合文本、+15% 余量、系数可配 |
| `loop`（fake provider） | 多轮 tool_use→executeTool→tool_result 回喂→终稿；maxRounds 截断（truncated=true）；死循环检测：签名窗口重复抛 `llm_kit_stalled`；executeTool 抛错→回 tool_result is_error 不中断循环；usage 累计；memory store 每轮快照 |
| `store/memory` | appendRound / load / recall（范围 + pattern） |

### e2e（真实 relay）

`examples/exec-demo.test.mjs`：任务「查看当前目录并总结」，断言——
轮数 ≥ 2、transcript 含 exec 的 tool_result、finalText 非空、无 llm_kit_stalled。
**demo 里 exec 工具有白名单/超时**（demo 也要示范调用方安全职责，哪怕从简）。

### 工程保底

每个文件 `node --check`；`npm test` 全绿才能提交（GLOBAL_AGENTS §3.2）。

## 2. v0.1（FR-1/2 全量 + 压缩 ①②）——"行为对"

| 模块 | 测什么 |
|---|---|
| `providers/anthropic` | mock fetch：请求/响应双向、**SSE 流式 content_block 事件解析**、错误分类 |
| `providers/openai` | 补流式：SSE 解析、流式 tool_calls 增量拼装 |
| `loop` 完整 FR-2 | 轮内快照重试：fake provider 第 1 次抛 retryable → 断言恢复快照重发、attempts 用尽才抛、退避时序（sleep 可注入，测试用立即返回）；完成信号 + 无工具轮策略（连续 3 轮强制结束）；相邻 assistant 合并防 400；max_tokens 截断续写；`onToolResult` 钩子在回喂前生效 |
| `compact` | `computeBudget` 公式（窗口−输出−max(2000,10%)）；`groupIntoRounds` 双协议成对规则、**孤儿零容忍**（tool_result 无配对 tool_use → 抛错而非静默）；sliding-window 整组丢弃；fold-statistical 摘要**确定性快照**（同样输入逐字节相同）；头部保护（system + 首个 user 永不折叠，fixtures 覆盖多轮场景）；foldedPayload 与原文逐字节一致 |
| `config` | static 直给；env 变量解析；apiKey 三级引用优先级；slot 缺失回落 default |

### 迁移验收（本阶段的真验收）

- app_container **完整迁移 runToolLoop** 后其 `npm test` 全绿；
- 行为指标：24 轮开发场景对比硬滑窗基线——早期轮次不再静默丢失（transcript 完整），
  折叠后"重做已完成工作"次数可观测下降（人工审 transcript，记录进 issue）。

## 3. v0.2（file store + recall + fold-llm + tools 子路径）——"扛崩溃、可找回"

| 模块 | 测什么 |
|---|---|
| `store/file` | JSONL 追加/流式读；**崩溃安全**：模拟写半行 kill → 重启 load 只读到完整行；recall 范围/grep |
| 崩溃续跑 e2e | 脚本化演示：fake/真实 provider 跑到第 3 轮 kill 进程 → `resume: true` 从断点继续，断言断点后 LLM 调用次数 = 剩余轮数（不重跑已付 token） |
| `compact/fold-llm` | summarizer 注入（fake summarizer）；**确定性尺寸执法**：summarizer 故意返回超预算摘要 → enforce-size 按字段优先级修剪到预算内（不信任 LLM 自律，FR-3.5） |
| `tools/jail` | 路径解析越界抛错；写仅限 writable 子树；maskedPaths 拒读；符号链接逃逸 |
| `tools/registry` | 求交 fail closed：provider 返回无执行器的 schema → 启动即抛 `tool_unknown_executor`；description/约束覆盖；**入参最小校验**（required/type/maxLength）失败回 tool_result 错误、执行器零调用（用计数执行器断言） |
| `tools/recall` | 建在 memory 与 file store 上各测一遍；摘要指引文案与工具签名一致 |

## 4. v1.0（touwaka 迁移）——"无回归"

- touwaka 侧先迁纯函数层（token-utils / history-compactor），其测试全绿；
- **行为对比**：迁移前后相同对话 fixture 的压缩水位线/摘要输出一致（快照对比）；
- MariaDB 适配器（touwaka 项目侧交付物）：接口契约测试可复用本库 fixtures
  （同一组 RoundRecord 样本，memory/file/mariadb 三实现跑同一套断言——**契约测试套件**，
  建议 v0.2 把 store 的断言抽成可复用 `test/contract/transcript-store.js`，项目侧直接引用）。

## 5. 横切约定

- **禁止打网络的单测**：一切协议测试走 mock fetch；发现单测访问网络即视为 bug。
- **快照断言用于确定性输出**（统计摘要、enforce-size 修剪结果），禁止对 LLM 输出做快照。
- **错误路径优先**：本库的价值一半是"抖动不重跑、错误可分类"，每个模块的测试清单里错误用例不少于正常用例。
- e2e 脚本同时是文档：`examples/` 代码即"调用方接入指南"，保持可读性优先于花哨。
