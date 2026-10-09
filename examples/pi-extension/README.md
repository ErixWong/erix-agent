# erix_run — pi extension（pi 调度 erix 修代码）

把 **erix-agent 的 `runToolLoop` 内嵌成 pi 的原生工具**：pi（人机协同侧）把一个自包含的编码
子任务交给 erix（无人值守 headless 运行时），erix 在指定目录里跑完整的多轮工具循环（读写文件、
执行命令、压缩上下文），终局以结构化载荷交回 pi 模型。

这是「pi = 交互式 agent，erix = headless agent，互补而非竞争」（见仓库根 `AGENTS.md` §1）的落地形态：
**pi 负责编排与人机界面，erix 负责一次完整的无人值守执行**。

## 文件

| 文件 | 作用 |
|---|---|
| `erix-run.ts` | pi 扩展本体：`defineTool` 注册 `erix_run`、参数 schema、进度通道（`onUpdate`）、结果形状（`content` / `details` / `structuredContent` / `isError` / `usage`） |
| `erix-run-core.js` | 纯逻辑：库装载、配置装配、`runToolLoop` 选项装配、事件→进度、终局载荷组装。**不 import pi**，`node --test` 可测 |
| `index.ts` | 目录形态的入口（pi 把「含 `index.ts` 的子目录」当成一条扩展加载） |
| `../../test/examples/erix-run-core.test.js` | core 单测（fake provider / 注入 fake lib，全离线） |
| `../../test/examples/erix-run-core.smoke.test.js` | 真机冒烟（一次真 relay 调用，默认跳过） |
| `../../test/examples/erix-run-pi-load.test.js` | 用 **pi 自己的装载器**（jiti + 虚拟模块）加载 `.ts`，断言注册成功、失败路径不抛错 |

## 安装

pi 的扩展目录是 `~/.pi/agent/extensions/`（用户级）或项目内 `.pi/extensions/`。扩展需要**两个文件在一起**
（`erix-run.ts` 会 `import "./erix-run-core.js"`），所以按目录装：

```bash
# 方式 A：软链整个目录（开发期最省事，改代码后 /reload 即生效）
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/examples/pi-extension" ~/.pi/agent/extensions/erix-run

# 方式 B：整目录拷走（发版后）
cp -r examples/pi-extension ~/.pi/agent/extensions/erix-run
```

目录里有 `index.ts`，pi 会把整个目录当成**一条**扩展加载（不会把 `erix-run.ts` 再加载一遍）。

开发态也可以不落盘，直接指文件：

```bash
pi --extension ./examples/pi-extension/erix-run.ts
```

> **为什么 `.ts` 在 pi 里能用而 `node` 直接 import 不行**：pi 用 jiti 加载扩展，并把
> `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` / `typebox` 作为虚拟模块注入
> （`dist/core/extensions/virtual-modules.js`）。本仓零依赖，这些包名在仓库里根本不存在，
> 所以 `node --check` 能过（Node 22.18+ 自带类型剥离，语法没问题），但 `node -e "import('./erix-run.ts')"`
> 会以 `ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/pi-ai'` 失败——这是预期的，
> 加载自证走 `test/examples/erix-run-pi-load.test.js`（用 pi 的装载器，真跑）。

### 让扩展找到 erix-agent 库

内层 run 需要 `runToolLoop` / `createOpenAIProvider` / `createJsonFileModelConfigProvider` /
`createMemoryTranscriptStore`，以及内置工具装配 `bin/tools.js`。装载顺序（写死在 core 里）：

1. **`ERIX_AGENT_LIB`** 指向本仓检出：目录（自动补 `src/index.js`）或直接指 `src/index.js`。
   ```bash
   export ERIX_AGENT_LIB=/home/eric/projects/erix-llm-kit          # 或 .../erix-llm-kit/src/index.js
   ```
   指向的路径找不到 / 入口缺少必需导出时，报 `lib_missing` 并把「尝试过哪些来源、各自失败原因」
   写进错误消息（不崩 pi）。
2. **裸包名 `erix-agent`**（发版 + `npm i -g erix-agent` 或在 pi 的扩展目录旁放 `package.json` 后）。
   此时包根目录由 `import.meta.resolve("erix-agent")` 反推，再用 `file://` URL 直接加载
   `<pkgRoot>/bin/tools.js`。

发版之后 `ERIX_AGENT_LIB` 就可以省掉；未发版时它是**必填项**。

## 参数

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `task` | ✅ | — | 交给内层 run 的**自包含**任务描述。内层看不到本次 pi 会话历史，必要上下文必须写进 `task` |
| `cwd` | ✅ | — | 内层工作目录，必须是**已存在的绝对路径**（`~` 前缀会展开）。相对路径直接判 `bad_params` |
| `maxRounds` | | `8` | 内层工具循环轮数预算（1..100）。**≥16 会自动开启 judge**（与 `bin/cli.js` 同一策略，`ERIX_NO_REFLECTION=1` 可关） |
| `strategy` | | 引擎缺省 | 压缩策略内置名字：`sliding-window` \| `fold-statistical` \| `fold-llm`（交给引擎在启动期实例化，见 `docs/host-consumer-contract.md`「Compaction strategy selection」） |
| `timeoutMs` | | `600000`（10 分钟） | 硬超时，1000..21600000。到点 `abort` 内层 run 并在返回里标注 `timeout: true` |
| `model` | | 槽位里的 model | 覆盖 `slots.default` 的模型名（endpoint / apiKey 仍走该槽位） |

## 模型配置

读 `~/.erix/config.json`（可用 `ERIX_CONFIG_PATH` 指定别的路径；XDG：`$XDG_CONFIG_HOME/erix/config.json`
优先，与 `bin/config.js` 同口径）的 `slots.default`：

```json
{
  "slots": {
    "default": {
      "endpoint": "https://<relay>/v1",
      "model": "deepseek-flash",
      "apiKey": "***",
      "contextWindowTokens": 131072,
      "maxOutputTokens": 32768
    }
  }
}
```

- 槽位由**库自带**的 `createJsonFileModelConfigProvider(...).resolve("default")` 读取：`apiKey`
  支持 `apiKey` / `apiKeyEnv` / `apiKeyFile` 三选一（`resolveApiKey`），未发版的 key 玩法照常可用。
- provider 用 `createOpenAIProvider`（relay 是 OpenAI 协议），槽位整体摊平进去，`max_tokens`
  取 `maxTokens ?? maxOutputTokens`，provider 侧单次请求/流超时固定 300s（与 `bin/cli.js` 一致）。
- `contextWindowTokens` + `maxOutputTokens` 通过 `modelMetadata` **成对**交给引擎（#182：跨候选不合并，
  缺一个就不给）。**两个都缺 → 压缩与聚合输出预算整轮关闭**，返回里 `diagnostics.modelMetadataMissing`
  会带引擎的 `model_metadata_missing` detail（装配自查断言点）。
- 缺 `endpoint` / `model` / key → `config_invalid`；文件不存在 → `config_missing`（消息里带路径）。

## 内层工具集

**复用本仓 CLI 的同一装配函数** `bin/tools.js` 的 `createCliTools({ cwd, todo })`（不复制实现）：
`readFile` / `rg` / `grep` / `tree` / `writeFile` / `exec`。system prompt 也复用
`buildCliToolsSystemPrompt()`，再叠加「交付物落盘 + 收尾只写摘要 + 首行写「任务已完成」」。

- **`todo` 默认关**：`todo_*` 四件套把状态写在 `~/.erix/todos/<cwd-hash>.json`。erix_run 是嵌套执行，
  默认关可以避免污染用户 `~/.erix`、也避免并行 run 互相踩台账。要开就在 core 调用处传 `todo: true`
  （工具层未开参数，避免默认形态带副作用）。
- 工具结果进模型视野前按 head+tail 截断到 4096 字符（复用 `bin/tools.js` 的 `truncateResult`）；
  引擎侧的 `outputHygiene` 也在（transcript 用 `createMemoryTranscriptStore()`，纯内存、不落盘）。
- `exec` 由 `bin/tools.js` 自己带超时（`ERIX_EXEC_TIMEOUT_MS`，普通命令 120s / 安装编译类 300s），
  它**不吃 abort signal**：erix_run 被取消时，正在跑的 `exec` 会跑到自己的超时为止。
- 没有 `note_*` 工具、没有 skills、没有 MCP：最小内置工具集，行为可预期。

## 取消与超时

| 触发 | 行为 | 返回 |
|---|---|---|
| pi 取消工具调用（用户中断 / `signal` abort） | `signal ?? ctx.signal` 直连内层 `AbortController` → 引擎 `fail()` 走 abort 分支 | `aborted: true`、`termination.reason: "aborted"`、`termination.partial: true`；**不**报 `isError`（那是人的决定） |
| `timeoutMs` 到点 | 记 `timedOut` 后 abort 同一个 controller | `timeout: true`、`aborted: true`、`termination.reason: "aborted"`；报 `isError` |
| 引擎自身 deadline | `timeoutMs` 同时作为 run 级 deadline 交给引擎，治理层在轮边界上按剩余时间收尾 | 可能先于硬 abort 正常返回（`max_rounds_cap` / `end_turn` 等） |

取消/超时**都不会丢用量**：抛错路径按 #180 从 `error.usage` / `error.rounds` / `error.finalText`
（以及 `termination.usage` / `rounds` / `partial`）读回来，载荷字段形状恒定（没跑过就是零值，不是缺字段）。

## 返回结构

`content` 是交回模型的文本（终稿 + 一行终局摘要 + 一行 diagnostics），`details` / `structuredContent`
是同一份结构化载荷：

```jsonc
{
  "ok": true,                              // termination 是 end_turn/judge_done
  "finalText": "任务已完成\n\n- 改动：…",
  "rounds": 4,
  "truncated": false,
  "usage": { "input_tokens": 6003, "output_tokens": 396, "cacheRead": 4096 },
  "termination": { "reason": "end_turn", "errorCode": "…(仅 failed)", "detail": "…" },
  "timeout": false,
  "aborted": false,
  "diagnostics": {
    "observerErrors": { "count": 0, "samples": [] },
    "modelMetadataMissing": null,
    "ledgerErrors": { … }, "persistenceErrors": { … },
    "compaction": { "events": 0, "compactedRounds": 0, "foldedRounds": 0 },
    "model": "deepseek-flash", "configPath": "…", "cwd": "…",
    "libSource": "ERIX_AGENT_LIB=…", "strategy": "sliding-window",
    "runId": "…", "maxRounds": 8, "timeoutMs": 300000, "elapsedMs": 6276
  }
}
```

`termination.reason` 一律是**引擎给的**（`end_turn` / `judge_done` / `no_tool` / `stall` /
`max_rounds_cap` / `continuation_exhausted` / `final_guard_unverified` / `aborted` / `failed` /
`persistence_failed`），语义与宿主处置建议见
[`docs/host-consumer-contract.md`「Termination decision table」](../../docs/host-consumer-contract.md#termination-decision-table-issue-170)。
本层不发明 reason、不把 abort 粉饰成成功。`failed` 时读 `termination.errorCode`（#176：引擎只透传，
没分类就是 `unknown`）再决定重试。

非 `ok` 的终局以 `isError: true` 返回（模型看得见，同时 `structuredContent` 仍在）。

## 进度

内层事件（`round_start` / `tool_use` / `tool_result` / `round_end` / `compaction` /
`model_metadata_missing` / `persistence_error` / `recovering` / `final_guard` / `run_outcome`）
经 `formatLoopEvent` 压成一行，走 pi 的 `onUpdate` 进度通道（节流 150ms，窗口保留最后 12 行，
终局强制刷一次）。观察者一律自防：进度通道抛错只计入 `diagnostics.observerErrors`，绝不反打内层 run。

## 成本提示

- **一次 `erix_run` = 一次完整多轮 run**：每轮一次主力模型调用，外加治理/压缩的辅助调用。上面的
  冒烟样本（4 轮、改一行代码）实测 ↑6003 / ↓396 tokens、6.3s。
- **`fold-llm` 每压缩一次多花一次主力模型调用**（输入约等于被折叠轮次的大小，见契约「Compaction
  strategy selection」）。默认用 `fold-statistical`/`sliding-window` 更省。
- `maxRounds ≥ 16` 会自动开 judge（每轮 end_turn 一次评估 + 可能的扩轮），`ERIX_NO_REFLECTION=1` 关。
- 收尾用 `completion.signals`（中文完成词表，与 `bin/cli.js` 同一份）+ system prompt 里的
  「首行写「任务已完成」」提前收口，否则模型纯文本收尾会白烧到 `no_tool`（默认 3 轮无工具才停）。
- `wrapup: false`：对话型宿主不收 JSON 信封，终稿就是模型原文。
- 没有 `finalGuard`，所以 `verification.status` 恒为 `skipped` —— **`end_turn` 不是交付证明**，
  验证要靠内层自己跑的 `exec`（或外层 pi 再跑一次测试）。

## 测试

```bash
node --test test/examples/*.test.js                                   # 离线：core 单测 + pi 装载自证
ERIX_PI_SMOKE=1 node --test test/examples/erix-run-core.smoke.test.js   # 真机冒烟（一次真调用）
```

- 冒烟默认跳过（`npm test` 必须离线可重复）；`ERIX_PI_SMOKE=1` 才打真 relay，用 `~/.erix/config.json`
  真配置、在 `mkdtemp` 的临时目录里修一个注入的小 bug，断言「`node check.js` 打印 OK + 载荷形状正确 +
  `model_metadata_missing` 不出现」。
- `erix-run-pi-load.test.js` 在找不到已安装的 `@earendil-works/pi-coding-agent` 时整条跳过；
  指路变量：`PI_CODING_AGENT_ROOT=<pi-coding-agent 安装目录>`。

## 待主 agent `/reload` 实测的清单

1. **`onUpdate` 的可见性**：`onUpdate` 是文档化的进度通道（`AgentToolUpdateCallback`，
   `examples/extensions/shutdown-command.ts` 同一用法），但 TUI 里渲染成什么样 / RPC 与 `--mode json`
   / print 下会不会丢，需要真机 `/reload` 后看一次（print/json 模式无 UI，预期只是不可见、不影响结果）。
2. **`structuredContent` 是否被二次校验**：`outputSchema` 声明了终局载荷形状（`additionalProperties`
   未收紧）。若 pi 对 `structuredContent` 做严格校验，`termination` 在 abort 路径上会多带
   `usage` / `rounds` / `partial` 三个字段，届时需要把它们写进 schema。
3. **`usage` 归集口径**：`AgentToolResult.usage` 明确「不计入主 LLM 上下文」，且 `cost` 字段我们
   只能填 0（relay 侧记账）。pi 会话总额统计里会出现 `cost: 0` 的这条，是否符合预期需实测确认。
4. **`ctx.executeTool` 复用 pi 内置 read/edit/write/bash**：本实现**没走**这条路（任务书要求复用本仓
   `bin/tools.js` 的装配函数）。`ctx.executeTool` 在本机 dist 类型与 `docs/extensions.md` 里都存在，
   但示例里没有用例；若要改成复用 pi 内置工具（少一套文件/shell 实现），需要先实测该 API 的
   参数与结果形状。
5. **`exposure` / `defaultActive`**：当前是缺省 `direct` + 注册即激活。若希望它默认不声明给模型
   （按需 `pi.setActiveTools()` 再开），要确认 `/reload` 后 `pi.getAllTools()` 的可见行为。
