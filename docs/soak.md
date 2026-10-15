# soak 长跑观察脚本（`scripts/soak.mjs`）

issue #257 的 T6。把「长轮回放 + 多次强制压缩 + 中途 abort + `resumeRunSnapshot` 续跑 + 落盘一致性」
这五件事压进**一个 run**里跑，专门覆盖单测 / 随包契约套件 / `examples/` 真机 gate 都不覆盖的
「压缩 / 治理 / 快照三套同时压热」场景。

**定位：只观察引擎，不修改引擎。** 脚本发现引擎缺陷只写进报告（`engineDefects[]`），不顺手改 `src/`。

## 用法

```bash
# 便宜自测（不联网、一次真模型都不打；CI / 无 key 环境可用）
node scripts/soak.mjs --provider fake --rounds 6 --store "$(mktemp -d)" --out /tmp/soak-fake-report.json

# 真模型长跑（模型/端点/凭据从 ~/.erix/config.json 的 slots.default 读，源码里没有模型名）
ERIX_E2E_CONFIG=~/.erix/config.json node scripts/soak.mjs --provider real --rounds 200 --out /tmp/soak-real-report.json
```

参数：`--rounds <n>`（默认 200）、`--store <dir>`（默认临时目录，**绝不写真实 `~/.erix`**）、
`--out <file>`、`--compact-every <n>`、`--abort-at <n>`、`--provider fake|real`（默认 real）、
`--slot <name>`（默认 `default`）、`--keep-store`。`npm run soak` 等价于直接跑脚本。

## 它在断言什么

`assertions[]` 每项 `name` / `pass` / `blocking` / `evidence`，覆盖：

- **长轮回放**：轮数跑满；**强制压缩**靠把 `context.budgetTokens` 调到几个轮次的量级逼出来（不指望自然触发）。
- **三方对账**：`<runId>.jsonl` 行数 / `store.load()` 的 `RoundRecord` 数 / 事件流累计的 `round_end` 数。
  口径写在证据里：jsonl 行数 = 引擎轮记录 + `initialUserMessage` 那一条 seed；`round_end` 只等引擎轮记录。
- **契约事实**：`tool_result` 块的 `erix.{toolCallKey,round,durationMs,success}` 齐、顶层无退役名、
  `toolCallKey` 全局唯一、投影 `toolCalls[]` 的 key 集合与落盘**双向相等**、投影 `durationMs` 逐条等于
  落盘 `erix.durationMs` 且缺失不写成 0。
- **压缩后配对合法性**：折叠后的消息序列过 `canonicalToOpenAIMessages` / `canonicalToAnthropicRequest`，
  不许出现孤儿 `tool_result` 或缺结果块的 `tool_use`（直接测 TTL 年龄来源改动有没有把该留的轮算错年龄）。
- **abort**：必须抛标准错误（`termination.reason === "aborted"` 且带 `usage`/`rounds`/`partial`）；
  实际观察到的终局 `reason` 另记进 `abortObservedReason`（issue #282 的第一手数据）。
- **resume**：续跑成功；历史块逐字节不被回写；新块新 `toolCallKey` 不撞历史；
  `stale_attempt_result` 块因无 `tool_use_id` 而对 judge/L0 的读取面结构性不可见。

阻断性断言（`blocking: true`）任一 FAIL → 退出码 1；与已知引擎缺陷相关的观察项标 `blocking: false`，
只进报告不影响退出码——这样「引擎有已知缺陷」与「soak 脚本自己坏了」不会混成同一个红。
