<!-- doc-version: 0.34.0 -->
# 宿主升级指南：0.34.0

> 范围：0.34.0 切版。**这一版没有删除、没有改名、没有改默认值**——它加的是*可观测性*：三件过去看不见的
> 事实（终稿其实是被文本化的工具调用、run-state 注入是否真的发生、交付物判据这次判不了），以及写台账里
> 过去漏掉的 shell 写。已经在跑的进程不做原地迁移。

## 1. 先读这张表

| 如果你的情况是 … | 那在 0.34.0 里 |
|---|---|
| 读 `result.finalText` 就把任何文本当正文 | 先看新的 `result.finalTextShape`：它一旦在场，那段「正文」其实是模型用文字写出来的工具调用（§2.1） |
| 配了 `finalGuard`，想知道判据什么时候是瞎的 | 订阅新的 one-shot 事件 `deliverable_blind`（§2.3） |
| 靠 `fileWrites` 证明「一个文件都没写」 | 它现在也收模型通过 shell 落的写，并在解析不了时明说（§2.4） |
| 判 `judge_done` 的交付许可 | 被文本化的工具调用不再算交付物（§2.2） |
| 读 `round_end` | 载荷新增 `runStateInject`，没有任何东西被拿掉（§2.5） |

## 2. 这一版加了什么

### 2.1 `result.finalTextShape`——终稿其实是被文本化的工具调用（#862）

新增字段。模型把工具调用写成散文而不是真的发出来时，run 照样结束，但 `result.finalTextShape` 现在会说：
`{ textualizedToolCall: true, marker: "<命中的标记>" }`。**缺席 = 没检测到——这个键是省略，绝不写 `false`。**
同一件事每 run 发一次 `final_text_textualized_tool_call` 事件，CLI 会为它打一行。

### 2.2 被文本化的工具调用不是交付物（#865）

`judge_done` 过去把那段文本当已交付的正文，现在不再：交付物分类器多一格 `textualized_tool_call`，
`roundDeliverableFacts` 用 `textualizedBlocks` 报它的条数。没有事件改名；judge 自己的判据未动。被重新分类的那种形状是：一轮里没有 `tool_use`、以 `end_turn` 结束、
正文非空——这样的轮不再能证明交付。

### 2.3 `deliverable_blind`——「判据这次判不了」现在是一个事件（#881）

新增，每 run 一次（one-shot），分层 **fact**。在 final-guard 载荷构造完、宿主自己的 `deliverables` 检查
之前发出，载荷里那三个计数在场时一并带上（`execWriteCount`、`execWriteUnresolvedCount`）。只在配了
`finalGuard` 时才可能发。**裁决本身没变**：不读这个事件的宿主看到的东西和以前一模一样。

### 2.4 写台账看得见 shell 写（#711）

`fileWrites` 现在也包含模型通过 `exec` 落盘的路径（heredoc、`>`、`>>`、`tee`、`sed -i`），final-guard
载荷新增 `execWriteCount`、`fileWritesBlindToExec` 与 `execWriteUnresolvedCount`——最后一个是**下界**：
解析不了的载荷按一条未解析写计数，绝不猜。`recordFileWrites` / `trimFileWrites` / `FILE_LEDGER_LIMIT`
三个形状与以前一致。

### 2.5 `round_end.runStateInject`（#872）

在既有 `round_end` 载荷上新增子对象：`{ lowBudget, request, persist, remainingRounds, injections }`。
它记录本轮是否真的发生了 run-state 注入，不再让宿主从 `runState` 去猜。

### 2.6 截断不再静默（#609）

单块内容超预算时，引擎会说清它是三种剪法里的哪一种。`readFile` 的描述不再引用「从本仓测出来的数字」
（#628），模型可见文案不再随我们自己的树漂。

## 3. 没有变的东西

- **选项——本版改了：** `reflection.roundJudge` 的键、类型与默认值都不动，但开着它的宿主在被评审那一轮
  只有一段被文本化的工具调用时，现在可能**多跑一轮**（§2.2）。其余选项保持原样；唯一新增的*输出*键就是
  §2 列的那些。
- **默认值——** 未变：`maxRounds`（引擎 8、CLI 64）、`stallDetection` `{ window: 4, mode: "consecutive" }`、
  `compaction` `fold-llm`、`finalGuardTimeoutMs` 30000，以及摘要器的五个旋钮。
- **观察者事件——** 没有事件被改名或删除。只有新增：`final_text_textualized_tool_call`（§2.1）与
  `deliverable_blind`（§2.3）；`round_end` 多了一个子对象（§2.5）。
- **诊断字段——** 既有名字的含义不变；`fileWrites` 只是装进了同一类事实的更多部分（§2.4），旁边多了三个计数。
- **磁盘格式——** 未变。`<runId>.jsonl`、`.recovery.jsonl`、`.partial.jsonl`、`.state.json`、`.status.json`
  与 0.33.0 完全一样地写；没有新文件，也没有旧文件被丢。
- **终局载荷——** 只有加法：`finalTextShape`（§2.1）。`finalText`、`verification`、`error`、`termination`
  以及退出码 0 / 1 / 2 / 4 的含义都不变。

## 4. 在你自己那边验一遍

- 跑一个你自己的场景，断言正常正文时 `result.finalTextShape` **缺席**——「没检测到」的形状是省略，不是 `false`。
- 如果你靠 `fileWrites` 证明一个否定命题，先看 `fileWritesBlindToExec`：它为 `true` 时，台账看不见模型
  通过 shell 写的全部内容。
- 如果你读 `deliverable_blind`，记住它每 run 只发一次，且只在配了 `finalGuard` 时发。
- `npm run check:release` 与 `ERIX_E2E_MODEL=1 npm run check:release:model-e2e` 是本仓切版前跑的两条命令，
  在 0.34.0 的树上都是绿的。
