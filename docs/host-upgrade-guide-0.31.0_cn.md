<!-- doc-version: 0.31.0 -->
# 宿主升级指南：0.31.0

**版本：0.31.0。** 这一版才是**真正落地那 16 个删除**的破坏包——0.30.0 指南宣布了它们，而 0.30.0 的包里
一个都没删。下面这些名字在 0.30.0 里仍然被导出：指南写着「已删除」，包却把每一个都照样交还给 `import`，
所以真正的边界挪到了这里。包根（`erix-agent`）少 10 个名字，`erix-agent/tools` 少 7 个入口名
（`NOTE_VALUE_MAX_CHARS` 在两个入口上都有，所以 16 个名字对应 17 行入口），其余一处没动。

**删掉的是「导出」，不是实现。** `createAnthropicProvider`、三个工具 provider、环境变量模型配置提供器和五个
一行别名仍然作为内部件活在 `src/` 里；只是包入口不再把它们再导出。现在从 `erix-agent` / `erix-agent/tools`
`import` 其中一个名字会在**模块加载期**就失败——不是警告，也不是等到第一次使用。

**这张表为什么不会烂。** 下面两张表里的名字集合，在同一次 `check:docs` 里与
`node scripts/deprecated-export-check.mjs --json` **现算**的候选清单双向对账；`check:release` 还会把本页
与**装好的包**的运行时导出面再比一次：本页说「已经没了」的名字，必须在它那一行登记的入口上真的不存在。
中英两份的名字集合与入口列必须逐字相同，每一行的迁移条款都必须是那个名字自己 `@deprecated` 标记里写的那一条。
这张表每次现算、从不手抄。

## 1. 0.30.0 到底做了什么（勘误）

0.30.0 交付了退役登记表、标记和指南——但**没有**交付删除。`erix-agent@0.30.0` 仍然从两个入口导出全部 16 个
名字：于是升到 0.30.0 的宿主里，已经迁完的看不到破坏，没迁的也看不到破坏。0.30.0 那一页已就地更正
（§2 与 §3 带勘误说明）；删除本身是这一版。

如果你在 0.30.0 上、且从没 import 过这 16 个名字里的任何一个，升级就是一个版本号。如果你 import 过其中一个，
请**先**迁移**再**升级：ESM 里 import 一个不存在的名字在模块加载期就失败，「先升级、后迁移」不是降级，是起不来。

## 2. 被删掉的十六个名字

| Name | What it did | Migration clause | Entry | Definition |
|---|---|---|---|---|
| `createCompositeToolProvider` | 把多个工具 provider 合成一个 `listTools(sel)`，按顺序合并 schema | no in-tree replacement —— 宿主自建工具 provider（任何带 `listTools(sel)` 的对象） | `./tools` | `createCompositeToolProvider` (`src/tools/providers.js`) |
| `createEnvModelConfigProvider` | 从环境变量里读一个槽位值的模型配置提供器 | no in-tree replacement —— 宿主自己读环境变量，并实现 duck-typed 的 `resolve(slot)` 契约（`createJsonFileModelConfigProvider` 是另一个来源，不是 drop-in 替代） | `.` | `createEnvModelConfigProvider` (`src/config/env.js`) |
| `createJsonFileToolProvider` | 从 JSON 文件（或目录）里读工具集的工具 provider | no in-tree replacement —— 宿主自建工具 provider（任何带 `listTools(sel)` 的对象） | `./tools` | `createJsonFileToolProvider` (`src/tools/providers.js`) |
| `createStaticToolProvider` | 提供一组固定的内存内 schema | no in-tree replacement —— 宿主自建工具 provider（任何带 `listTools(sel)` 的对象） | `./tools` | `createStaticToolProvider` (`src/tools/providers.js`) |
| `estimateMessagesTokens` | 对整个消息数组做 token 估算 | migrate to `estimateMessageTokens` —— 行为完全相同；旧名只为一个外部调用点存在 | `.` | `estimateMessagesTokens` (`src/tokens.js`) |
| `extractL0` | 从模型应答里抽出客观事实 | migrate to `extractL0Facts` —— 同一个函数的旧名 | `.` | `extractL0` (`src/reflection/l0.js`) |
| `extractL0Fact` | 同一个事实抽取器的单数拼写 | migrate to `extractL0Facts` —— 同一个函数的旧名 | `.` | `extractL0Fact` (`src/reflection/l0.js`) |
| `MESSAGE_OVERHEAD_TOKENS` | 每条消息的 token 开销常量 | migrate to `MESSAGE_OVERHEAD` —— 同一个常量的拼写别名，不是另一个旋钮 | `.` | `MESSAGE_OVERHEAD_TOKENS` (`src/tokens.js`) |
| `NOTE_VALUE_MAX_CHARS` | 一个没有任何工具 schema 读过的长度常量 | no in-tree replacement —— 这个常量没有接进任何工具 schema（`content` 的上限是 `MAX_CONTENT_LENGTH`），所以仓内没有可迁的目标 | `.` + `./tools` | `NOTE_VALUE_MAX_CHARS` (`src/tools/notes.js`) |
| `parseReflectionSummary` | 从应答里解析内联摘要协议 | migrate to `parseL1Summary` —— 同一个函数的旧名 | `.` | `parseReflectionSummary` (`src/reflection/l0.js`) |
| `parseSummary` | 同一个内联摘要解析器的更短拼写 | migrate to `parseL1Summary` —— 同一个函数的旧名 | `.` | `parseSummary` (`src/reflection/l0.js`) |
| `removeRecord` | 从花名册目录里删掉一条记录文件 | no in-tree replacement —— `reconcile` 只重写状态、不删文件；别把归档逻辑建在这个原语上 | `./tools` | `removeRecord` (`src/tools/delegation/roster.js`) |
| `resolveFileReadMaxBytes` | 从环境变量解析单次读取的字节上限 | no in-tree replacement —— 上限在 `createFileTools` 内部解析，没有单独的公共入口 | `./tools` | `resolveFileReadMaxBytes` (`src/tools/file-tools.js`) |
| `serializeFoldedMessages` | 把折叠历史渲染成摘要器读的那段文本 | migrate to `serializeFoldedMessagesWithMeta` —— 同样的文本在 `.text` 上，另加这层薄包装丢掉的 `dropped` / `total` / `bounded` 账 | `.` | `serializeFoldedMessages` (`src/compact/provider-summarizer.js`) |
| `setNotesClock` | 替换 notes 工具给记录盖时间戳用的时钟 | no in-tree replacement —— 公共面上没有受支持的时钟注入口（只有 notes 测试驱动过这个钩子） | `./tools` | `setNotesClock` (`src/tools/notes.js`) |

其中六个是一行别名（`estimateMessagesTokens`、`extractL0`、`extractL0Fact`、`MESSAGE_OVERHEAD_TOKENS`、
`parseReflectionSummary`、`parseSummary`）：替代物是同一个函数或同一个值，改动就是 import 站点改名。
notes 表面本身**没有缩水**——`createBuiltinNotesTools`、`MAX_CONTENT_LENGTH`、`resolveNotesDir` 与五个
notes 工具原样保留。

## 3. `createAnthropicProvider`（唯一一个宿主真在 import 的名字）

`createAnthropicProvider`（`src/providers/anthropic.js`）是这一包里唯一一个宿主仓今天真在 import 的名字。
登记的宿主事实是 `app_container/apps/worker/src/pi/erix-adapter.js` 在模块作用域 import 了这个工厂；
用宿主探针重核它（`npm run check:host-consumers -- --hosts <宿主仓目录>`）——那是本仓自己看不见的那一半。

| Name | What it did | Migration clause | Entry | Definition |
|---|---|---|---|---|
| `createAnthropicProvider` | 用 endpoint、key 与模型名构造一个 Anthropic 协议的 provider（`{protocol, model, chat, chatStream}`） | no in-tree replacement —— 宿主自己构造 provider 对象（duck-typed 的 `{protocol, model, chat, chatStream}` 形状）；可复制的配方在 0.30.0 指南 §3.2 | `.` | `createAnthropicProvider` (`src/providers/anthropic.js`) |

这一格是字面意思。

* **`createProviderForSlot` 不是它的替代物。** 它读一个模型槽位并摊平给 `createOpenAIProvider`；把 Anthropic
  端点指过去，就是把 OpenAI 形状的请求体发给 Anthropic 端点——是错的请求，不是编译错误。
* **协议层仍然公开、仍然受支持。** `canonicalToAnthropicRequest`、`anthropicResponseToCanonical` 与
  `createAnthropicStreamAssembler` 仍从包根导出；退役的是**工厂**。0.30.0 指南 §3.2 的配方用这三个助手构造
  同一个 duck-typed 对象，仍然逐字适用。
* **`createOpenAIProvider` 是本包唯一发布的 provider 工厂。** 其他协议由宿主自己提供 provider 对象。

## 4. 没有变的东西

输入面上的其余一切：这一版没有 `runToolLoop` 选项被退役、改名或搬家，没有默认值变化，也没有观察者事件、
诊断字段或磁盘格式变化；notes 工具表面、文件工具、派生簿记模块与全部 provider 协议助手都留在原处。
零运行时依赖的红线同样不变。

## 5. 在你自己那边验证

1. **证明你没有 import 这十六个。** 在你的树里 grep §2 与 §3 的名字（或把检出目录作为参数跑宿主探针）。
   命中就意味着其中某一行适用于你。
2. **对着发布的声明做类型检查**（`tsc --strict`）。这一包里的每个名字都不在 0.31.0 生成的声明里，所以迁移
   漏掉的 import 是编译错误，不是运行时惊喜。
3. **重跑管这一页的门禁。** `npm run check:docs` 对账上面的表，`npm run check:exports:deprecated` 对账标记
   与账本，`npm run check:release` 把本页与装好的包的运行时导出面再比一次。往包里加名字或删名字，三条要在
   同一个提交里一起动。
