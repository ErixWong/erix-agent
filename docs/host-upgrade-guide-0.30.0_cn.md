<!-- doc-version: 0.30.0 -->
# 宿主升级指南：0.30.0

**版本：0.30.0（尚未发布——这一页是发版预备文档）。** 0.30.0 就是库从「退役登记表落地」那天起一直在指的那个
破坏包：**16 个导出名被删除**。每一个都是按*零消费者*导出登记的——本仓没有一处 import 它，宿主探针能看到的宿主
检出里也没有——其中唯一一个宿主真在用的名字，给出的是一份配方（§3），不是一句承诺。

其余一处没动的是**输入面**：`runToolLoop` 没有选项被退役、改名或搬家，没有默认值变化，也没有观察者事件、
诊断字段或磁盘格式变化；一个从没 import 过这 16 个名字的宿主，升级动作就是抬版本号。**有一处行为变化跟着
这一版一起来，折叠上下文的宿主会碰到它：** `fold-llm` 的摘要器失败现在是终局错误，不再是静默的「降级为统计摘要」
（issue #661）——run 以 `failed` 收尾、错误码 `summarizer_failed`，CLI 对失败终局退出 **`5`**，不再与用法
错误共用 `1`。错误形状由宿主契约规定，`CHANGELOG.md` 的 `Breaking` 段记录了这次变化。

**这张表为什么不会烂。** 下面两张表里的名字集合，在同一次 `check:docs` 里与
`node scripts/deprecated-export-check.mjs --json` **现算**的候选清单双向对账。四种情形红：候选集里有、本页缺
（点名）；本页有、候选集里没有（点名）；中英两份不一致（点名）；某一行的迁移条款没有照抄该名字自己
`@deprecated` 标记里的那条（点名）。入口列也校——它必须与 `src/index.js` / `src/tools/index.js` 真正再导出的
事实一致。清单每次现算、从不手抄：谁登记了第 17 个名字、或从候选里删掉一个，这一页不跟着改就红。

## 1. 变更总览

| 你要改什么 | 为什么改 | 见 |
|---|---|---|
| 停止 import §2 里那 15 个名字 | 它们是零消费者导出，登记在 0.30 破坏包里删除 | §2 |
| **先**把 `createAnthropicProvider` 的 import 换掉，再升级 | 宿主真在用，而工厂在 0.30.0 已不存在——ESM 下 import 一个不存在的名字在**模块加载期**就失败 | §3 |
| 其余不用改（除 §4.1 那一处**新增**配置叶子） | 没有选项、默认值、事件或磁盘格式搬家；§4.1 新增一个配置叶子，并说明随之而来的 slot 同名键迁移危险 | §4 / §4.1 |

## 2. 十五个没人 import 的名字

这是量出来的，不是声称的：本节对账用的候选清单 = 包内消费者、发布面消费者与自身定义文件内引用**全为零**的那
批导出。你要是从没 import 过其中任何一个，它们的删除对你不可见。

| 名字 | 它原来干什么 | 迁移条款 | 入口 | 定义处 |
|---|---|---|---|---|
| `createCompositeToolProvider` | 把若干个工具 provider 合成一个 `listTools(sel)`，按顺序合并它们的 schema | no in-tree replacement —— 宿主自建工具 provider（任何带 `listTools(sel)` 的对象） | `./tools` | `createCompositeToolProvider` (`src/tools/providers.js`) |
| `createEnvModelConfigProvider` | 从环境变量里读一个槽位的模型配置 | no in-tree replacement —— 宿主自己读环境、实现鸭子形的 `resolve(slot)` 契约（`createJsonFileModelConfigProvider` 是另一个来源，不是直接替代） | `.` | `createEnvModelConfigProvider` (`src/config/env.js`) |
| `createJsonFileToolProvider` | 从 JSON 文件（或一个目录里的若干 JSON）读工具集 | no in-tree replacement —— 宿主自建工具 provider（任何带 `listTools(sel)` 的对象） | `./tools` | `createJsonFileToolProvider` (`src/tools/providers.js`) |
| `createStaticToolProvider` | 提供一组固定的内存内 schema | no in-tree replacement —— 宿主自建工具 provider（任何带 `listTools(sel)` 的对象） | `./tools` | `createStaticToolProvider` (`src/tools/providers.js`) |
| `estimateMessagesTokens` | 对整段消息数组估 token | migrate to `estimateMessageTokens` —— 行为逐字相同；旧名只为一个外部调用点存在 | `.` | `estimateMessagesTokens` (`src/tokens.js`) |
| `extractL0` | 从模型响应里抽出客观事实 | migrate to `extractL0Facts` —— 同一个函数的旧名 | `.` | `extractL0` (`src/reflection/l0.js`) |
| `extractL0Fact` | 同一个事实抽取器的单数拼写 | migrate to `extractL0Facts` —— 同一个函数的旧名 | `.` | `extractL0Fact` (`src/reflection/l0.js`) |
| `MESSAGE_OVERHEAD_TOKENS` | 每条消息的 token 开销常量 | migrate to `MESSAGE_OVERHEAD` —— 同一个常量的拼写别名，不是另一个旋钮 | `.` | `MESSAGE_OVERHEAD_TOKENS` (`src/tokens.js`) |
| `NOTE_VALUE_MAX_CHARS` | 一个没有任何工具 schema 读过的长度常量 | no in-tree replacement —— 这个常量没接进任何工具 schema（`content` 的上限是 `MAX_CONTENT_LENGTH`），所以仓内没有东西能迁到它 | `.` + `./tools` | `NOTE_VALUE_MAX_CHARS` (`src/tools/notes.js`) |
| `parseReflectionSummary` | 从响应里解析内联摘要协议 | migrate to `parseL1Summary` —— 同一个函数的旧名 | `.` | `parseReflectionSummary` (`src/reflection/l0.js`) |
| `parseSummary` | 同一个内联摘要解析器的短拼写 | migrate to `parseL1Summary` —— 同一个函数的旧名 | `.` | `parseSummary` (`src/reflection/l0.js`) |
| `removeRecord` | 从名册目录里删掉一条记录文件 | no in-tree replacement —— `reconcile` 只改状态、不删文件，宿主自建归档逻辑前不要依赖本原语 | `./tools` | `removeRecord` (`src/tools/delegation/roster.js`) |
| `resolveFileReadMaxBytes` | 从环境里解析单次读取的字节上限 | no in-tree replacement —— 上限在 `createFileTools` 内部解析，宿主没有（也不需要）单独的公共入口 | `./tools` | `resolveFileReadMaxBytes` (`src/tools/file-tools.js`) |
| `serializeFoldedMessages` | 把被折叠的历史渲染成摘要器读到的那段文本 | migrate to `serializeFoldedMessagesWithMeta` —— `.text` 里是同一段文本，另加这层薄包装扔掉的 `dropped` / `total` / `bounded` 账 | `.` | `serializeFoldedMessages` (`src/compact/provider-summarizer.js`) |
| `setNotesClock` | 换掉 notes 工具给记录盖时间戳用的时钟 | no in-tree replacement —— 公共面上没有受支持的时钟注入缝（只有 notes 的测试在驱这个钩子） | `./tools` | `setNotesClock` (`src/tools/notes.js`) |

有两行各值得一句话，因为「删掉」读起来像产品决策：

* **notes 面没有缩。** `NOTE_VALUE_MAX_CHARS` 与 `setNotesClock` 按它们**自己标记里的原话**如实记在这里——一个
  没人读的常量、一个只有测试用的时钟钩子。`createBuiltinNotesTools`、`MAX_CONTENT_LENGTH`、`resolveNotesDir`
  与五个 notes 工具都在，一字未改。
* **十五个里有六个是一行别名**（`estimateMessagesTokens`、`extractL0`、`extractL0Fact`、
  `MESSAGE_OVERHEAD_TOKENS`、`parseReflectionSummary`、`parseSummary`）：替代品是同一个函数或同一个值，改动就是
  import 处改个名字。

## 3. 唯一一个宿主真在用的名字：`createAnthropicProvider`

`createAnthropicProvider`（`src/providers/anthropic.js`）是这个包里唯一一个今天真被宿主仓 import 的名字。记在案的
宿主事实是：`app_container/apps/worker/src/pi/erix-adapter.js` 在模块顶层 import 了这个工厂；复核它的手段是宿主
侧探针（`npm run check:host-consumers -- --hosts <宿主仓目录>`）——那正是本仓自己看不见的另一半。

0.30.0 里工厂已不存在，而且失败形状不是警告：包是 ESM，import 一个不存在的名字在**模块加载期**就失败。先升级、
后迁移的宿主不会降级运行——它起不来。

| 名字 | 它原来干什么 | 迁移条款 | 入口 | 定义处 |
|---|---|---|---|---|
| `createAnthropicProvider` | 用端点、密钥与模型名造一个 Anthropic 协议的 provider（`{protocol, model, chat, chatStream}`） | no in-tree replacement —— 宿主自己拼出 provider 对象（鸭子形的 `{protocol, model, chat, chatStream}`），配方见 §3.2 | `.` | `createAnthropicProvider` (`src/providers/anthropic.js`) |
它标记里的条款是 `no in-tree replacement`，这句是字面意思。

* **`createProviderForSlot` 不是它的替代品。** `createProviderForSlot`（`src/config/slot-provider.js`）读一个模型
  槽位、摊平给 `createOpenAIProvider`；那个文件明写它**不自己挑协议**——「今天只有 OpenAI 兼容这一条路」，加第
  三条协议是另一张票的事。把一个 Anthropic 端点指给它，等于把 OpenAI 形状的请求发给 Anthropic 端点：这是**错的
  请求**，不是编译错误。
* **仓内没有别的东西能造 Anthropic provider。** 协议层仍然公开、仍然受支持——请求构造、响应映射、流式装配三个
  件都还导出。退役的是那个**工厂**。

### 3.1 你要产出的形状

provider 是一个鸭子形对象，不是类，也不是注册进某张表的工厂。引擎只读四个成员，别的一概不看：

```js
{ protocol, model, chat, chatStream }
```

`createOpenAIProvider`（`src/providers/openai.js`）返回的正是这个形状——它的 return 块是 `protocol`、`model`、
`chat`、`chatStream` 加四个可选透传字段——所以手搓的 provider 不需要在任何地方注册：`runToolLoop` 收的是这个
对象本身。

### 3.2 一份可照抄的配方

下面四件就是那个退役工厂的原料，四件都仍然从包根导出。

```js
import {
  KitError,
  classifyFetchException,
  classifyHttpError,
  canonicalToAnthropicRequest,
  anthropicResponseToCanonical,
  createAnthropicStreamAssembler,
} from "erix-agent";

/** 与退役工厂返回的是同一个鸭子形 provider。 */
export function createAnthropicProviderObject({ endpoint, apiKey, model, maxTokens = 4096 }) {
  const base = String(endpoint).replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };

  async function post(request, stream) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(canonicalToAnthropicRequest({
        model,
        maxTokens: request.maxTokens ?? maxTokens,   // 构造器要求这一项
        system: request.system,
        messages: request.messages ?? [],
        tools: request.tools,
        stream,
        temperature: request.temperature,
      })),
      signal: request.signal,
    });
    return response;
  }

  async function chat(request = {}) {
    try {
      const response = await post(request, false);
      const body = String(await response.text() ?? "");
      if (response.status < 200 || response.status >= 300) {
        throw classifyHttpError(response.status, body, { phase: "request" });
      }
      const value = JSON.parse(body);
      if (value?.type === "error") throw new KitError("server", body.slice(0, 400));
      return anthropicResponseToCanonical(value);
    } catch (error) {
      if (error instanceof KitError) throw error;
      throw classifyFetchException(error, { signal: request.signal });
    }
  }

  async function chatStream(request = {}) {
    const assembler = createAnthropicStreamAssembler({
      onDelta: request.onDelta,
      onReasoningDelta: request.onReasoningDelta,
      onToolCall: request.onToolCall,
      onUsage: request.onUsage,
    });
    const response = await post(request, true);
    if (response.status < 200 || response.status >= 300) {
      throw classifyHttpError(response.status, String(await response.text() ?? ""), { phase: "request" });
    }
    // SSE：`event:` 给类型，`data:` 带一个 JSON 对象，空行派发。
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType = "";
    let data = [];
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line === "") {
          if (data.length > 0) assembler.push(eventType, data.join("\n"));
          eventType = "";
          data = [];
        } else if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ +/, ""));
        }
      }
      if (done) break;
    }
    return assembler.finish();
  }

  return { protocol: "anthropic", model, chat, chatStream };
}
```

这份配方**刻意不复刻**的东西：退役工厂的超时与传输旋钮、它的 `extraBody` / `defaultHeaders` 注入、以及它的
system 消息归一化。那些是它自己的便利件；你若依赖过它们，把真正需要的行为搬进这个对象——引擎一处都不读它们。

### 3.3 引擎会拿它干什么

没有任何协议专属动作。这个 provider 对象与其他任何一个一样交给 `runToolLoop`，`chat` / `chatStream` 两侧的规位
请求/响应形状就是 `docs/host-consumer-contract.md` 写的那一份。有两种失败形状值得钉住，因为两者都长得像「模型
的问题」而其实不是：HTTP 错误必须抛成 `KitError`（`classifyHttpError` 产出的就是它），流式必须以 `finish()` 收尾
——装配器返回的才是规位响应，把 SSE 原文返回去不算响应。

## 4. 没有变的东西

* `runToolLoop` 的输入面、`capabilities` 形状与每一个**既有**配置叶子。本版没有退役、改名或搬家任何选项
  （§4.1 只**新增**一个叶子）。
* 终止、验证与退出码语义，包括「有 `skipped` 但没有 guard」那个退出码。
* 观察者事件、诊断字段与 run state 块。
* transcript 与 run state 的磁盘格式；上一个发布版本写下的账本仍然可以续跑。
* notes 工具面（五个工具加 `createBuiltinNotesTools`、`MAX_CONTENT_LENGTH`、`resolveNotesDir`）、文件工具、派生
  簿记模块，以及全部 provider 协议件。
* 零运行时依赖这条规矩。

另有一处只动展示层、不改任何引擎事实的变更：`erix chat` 现在每发生一次真实折叠就打一行，并把同样的记录
追加进 `judge.log`，所以折叠过上下文的 run 以 `type: "compaction"` 事件可见（配置的策略跑不起来时另有
一条 `compaction_strategy_fallback`）。事件本身一处未动——名字、载荷都照旧。

### 4.1 一处新增配置叶子，以及它带来的 slot 同名键迁移危险（issue #682）

0.30.0 还**新增**一个配置叶子；没有退役任何东西。`config.metadata.modelMetadata.budgetTokens` 是引擎侧的
**显式压缩预算**（正整数）。优先级一句话：CLI 旗标 `--compact-budget` > CLI slot
`slots.default.compactBudgetTokens` > 引擎载体字段 `budgetTokens` > 窗口派生 > **关闭**。缺窗口**不是**启动
失败：压缩保持关闭、run 照常跑，CLI 打**一行 stderr 告警**（以前是哑的）。以前「缺 `maxOutputTokens`」时
两个互相打架的数——配置加载器那条路径的 16384 与 `buildCompactionContext` 里的 65536——现在来自同一个
常量，所以两条路径派生出同一个预算（此前差 49152 token，约等于 262144 窗口的 18.8%）。

**迁移危险，直说：** 今天**未知的 slot 字段是惰性的**——内置 provider 原样拷贝 slot，工厂又只读固定参数
列表，所以认不出的键既上不了线也不会抛错。加了这两个叶子之后，这一点对两个预算键改变了：**谁以前恰好把
`compactBudgetTokens`（CLI slot）或 `budgetTokens`（载体）写进了 slot，它会从「被忽略」变成「生效并被校验」**
——这个值现在真的驱动折叠，写坏了会被拒（CLI 在配置加载期拒；引擎在首次请求前以 `invalid_budget` 拒）。
删掉那个键，或者把它写成一个真预算。slot 对象的其余部分一字未变。

## 5. 在你这边怎么验

1. **证明你没 import 那 15 个。** 在你的树里 grep §2 的名字（或把检出目录作为参数跑宿主侧探针）。命中就说明那
   一行对你有份。
2. **证明 Anthropic 这条路还跑得通。** 换上 §3.2 的配方后，发一次非流式请求，断言规位响应带 `content` 与
   `stopReason`；再发一次流式请求，断言 `finish()` 返回同样两项。抛出的 `KitError` 带状态码是 HTTP 问题；抛出
   `TypeError` 是你自己的载荷，不是网络。
3. **对着随包声明做类型检查**（`tsc --strict`）。本包里每个名字都不在 0.30.0 的生成声明里，所以迁移漏掉的 import
   是编译错误，不是运行期惊喜。
4. **重跑拥有这一页的那道门。** `npm run check:docs` 把上面两张表与现算候选集对账；`npm run
   check:exports:deprecated` 对账标记本身。破坏包里加一个或删一个名字，两处必须在同一个提交里跟上。
