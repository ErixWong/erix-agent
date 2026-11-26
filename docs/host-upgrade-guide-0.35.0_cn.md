<!-- doc-version: 0.35.0 -->
# 宿主升级指南：0.35.0

> 范围：0.35.0 这一版切割。**这是一次公开面的破坏性变更，不是引擎的破坏性变更。** 有八个名字不再从
> 包根（`.`）导出；它们所在的模块原地不动，`bin/` 仍按模块路径直引，所以 CLI 不受影响。承担
> 「从 store 拿定义 → 造连接」这条链的三个名字被保留，且是官方替代。已经在跑的进程不做原地迁移。

## 1. 先读这一节

包的 `exports` 只开放 `.`、`./tools`、`./contract-tests` 三道门，所以从 `.` 摘掉一个名字，就等于包外
不可达。本版摘掉**配置间接层**（五个名字），保留**连接链**（三个名字）：

| 保留（连接链） | 来源模块 |
|---|---|
| `createOpenAIProvider` | `src/providers/openai.js` |
| `loadModelSlot` | `src/config/slot-provider.js` |
| `createProviderForSlot` | `src/config/slot-provider.js` |

| 从包入口摘掉（原属配置间接层） | 模块（留在原处） |
|---|---|
| `CONFIG_LEAF_BINDING` | `src/loop/config-namespace.js` |
| `createStaticModelConfigProvider` | `src/config/static.js` |
| `createModelConfigResolver` | `src/config/static.js` |
| `createJsonFileModelConfigProvider` | `src/config/json-file.js` |
| `resolveApiKey` | `src/config/api-key.js` |

理由：`createOpenAIProvider` 是包外唯一一道通向网线的门。摘掉它（或把整层配置一起摘掉）会逼每个宿主
重写传输层。而配置间接层只做两件事——重读 `{ "slots": { … } }`、落一个 api key——宿主这两件都能自己做，
或用 `loadModelSlot` / `createProviderForSlot`。

## 2. 每个被摘名字的替代做法

五个名字的配方是同一个：**自己读配置、自己拼 `endpoint` / key / model，喂给 `createOpenAIProvider`**
（直接喂，或经 `createProviderForSlot`）。

### 2.1 `createJsonFileModelConfigProvider` 与 `createModelConfigResolver`

两者都是「给我一个带 `async resolve(slot)` 的对象」。自己造这个对象——读同一份
`{ "slots": { "<name>": { … } } }` 文件并返回选中的 slot：

```js
import { readFile } from "node:fs/promises";

const modelConfig = {
  async resolve(name) {
    const { slots } = JSON.parse(await readFile(configPath, "utf8"));
    const entry = slots[name ?? "default"];
    return entry?.apiKey === undefined && entry?.apiKeyEnv !== undefined
      ? { ...entry, apiKey: process.env[entry.apiKeyEnv] }
      : entry;
  },
};
```

把 `modelConfig` 像以前一样喂给 `runToolLoop`（它仍要 resolver 形态的对象），再用
`createProviderForSlot`（§2.3）或直接用 `createOpenAIProvider` 从解析出的 slot 造 provider。

### 2.2 `createStaticModelConfigProvider`

它接的是内存里的同一份 `{ "slots": { … } }` 形状。替代同 §2.1，只是不读文件：保留那个对象，
返回 `slots[name ?? "default"]`。

### 2.3 `loadModelSlot` → `createProviderForSlot`（最短路径）

只需要 `default` 槽位时，保留的这一对一步到位：

```js
import { loadModelSlot, createProviderForSlot } from "erix-agent";

const { slot } = await loadModelSlot({ configPath });   // 校验 endpoint / model / apiKey
const provider = createProviderForSlot(slot);           // 把 slot 摊平给 createOpenAIProvider
```

### 2.4 `resolveApiKey`

把三步查找就地写出来——`apiKey`，其次 `apiKeyEnv`（一个环境变量），再次 `apiKeyFile`（内容即密钥的
文件）：

```js
function resolveApiKey(config, env = process.env) {
  if (config.apiKey != null) return config.apiKey;
  if (config.apiKeyEnv !== undefined && env[config.apiKeyEnv] !== undefined) return env[config.apiKeyEnv];
  if (config.apiKeyFile !== undefined) return readFileSync(config.apiKeyFile, "utf8").trim();
  return undefined;
}
```

### 2.5 `CONFIG_LEAF_BINDING`

它当初被导出，是为了让宿主算「哪个键属于初始化、哪个属于每次调用」。这份绑定现在是
`src/loop/config-namespace.js` 的内部件（引擎在同一处对着 `CONFIG_NAMESPACE_SCHEMA` 跟它对账）。
需要这一拆分的宿主应改读契约里的 config 面那一节，而不是 import 这张表。

## 2.4 三个 Anthropic 协议助手已退役（issue #926）

0.35.0 同时落地**内置 Anthropic 线协议适配器**的退役，连带三个原本从包根导出的名字。它们与配置层同一次
切割被摘掉，理由相同：那是一层**转换**，而本包现在只说**一种**线协议（OpenAI 兼容）。

| 从包入口摘掉 | 原本做什么 | 代码原址 |
|---|---|---|
| `canonicalToAnthropicRequest` | canonical 消息/工具 → Anthropic 请求体 | `src/messages/anthropic.js` |
| `anthropicResponseToCanonical` | Anthropic 响应 JSON → canonical 响应 | `src/messages/anthropic.js` |
| `createAnthropicStreamAssembler` | Anthropic SSE → 流式 canonical 增量 | `src/messages/anthropic.js` |

**替代做法。** 包内**没有**一对一替代，以后也不会有：引擎不再携带第二种线协议方言。具体地：

- **OpenAI 兼容端点** —— 什么都不用做。`createOpenAIProvider` 未变，它仍是包外通向线协议的唯一一道门。
- **Anthropic 端点** —— 由**宿主**提供 provider。`runToolLoop` 接受任何 `{ protocol, model, chat, chatStream }`
  形状的对象；自己造这个对象，按你面向的 Anthropic API 实现请求编码、响应映射与流装配。你必须产出/消费的
  canonical 形状见 `docs/host-consumer-contract.md`（消息、工具调用、usage、`stopReason`）。
- **压缩摘要** —— 不受影响。`summaryRole: "system"` 仍然是「把摘要前置成 system 消息」；线协议归宿主时，
  把它并进 provider 自己的 `system` 字段是**宿主**的事（这段合并原本住在被退役的适配器里）。

如果你原来直接调这三个助手去对接 Anthropic，迁移就是：保留你的 HTTP 代码，删掉这些 import，
按契约文档读 canonical 形状，而不是从退役的转换器读。

## 3. 不变的部分

- **选项——** 本版没有任何 `runToolLoop` 选项、它的键、类型或默认值变化；包入口导出清单只是少了上面那五个名字。
- **默认值——** 不变：`maxRounds`、`stallDetection`、`finalGuardTimeoutMs`
  以及 summarizer 那几个旋钮。
- **观察者事件——** 没有事件被改名、删除或新增。
- **诊断字段——** 不变。
- **磁盘格式——** 不变；不新写任何东西，也不丢弃任何东西。
- **终局载荷——** 不变。
- **CLI——** 不受影响：`bin/config.js` 按模块路径直引 `../src/config/json-file.js`，不走包入口，
  所以它继续用 `createJsonFileModelConfigProvider`，与本版无关。

## 4. 在你这边验证

- 在宿主里 grep 那五个被摘的名字；每一处命中要么改成 `loadModelSlot` / `createProviderForSlot` 调用，
  要么改成 §2.1–§2.4 那样的本地读取。
- 若你 import 包入口（`import { … } from "erix-agent"`），那五个名字现在在那里是 `undefined`——
  `typeof index.resolveApiKey === "function"` 这样的运行时探测，是看清还有没有调用点指望它们的最快办法。
