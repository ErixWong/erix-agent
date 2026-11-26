<!-- doc-version: 0.35.0 -->
# 宿主升级指南：0.35.0

> 范围：0.35.0 这一版切割。**这是一次公开面的破坏性变更，不是引擎的破坏性变更。** 有五个名字不再从
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

## 3. 不变的部分

- **选项——** 本版没有任何 `runToolLoop` 选项、它的键、类型或默认值变化；包入口导出清单只是少了上面那五个名字。
- **默认值——** 不变：`maxRounds`、`stallDetection`、`compaction`（`fold-llm`）、`finalGuardTimeoutMs`
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
