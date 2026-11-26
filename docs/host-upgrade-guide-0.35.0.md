<!-- doc-version: 0.35.0 -->
# Host upgrade guide: 0.35.0

> Scope: the 0.35.0 version cut. **This is a breaking release of the public surface, not of the
> engine.** Five names are no longer exported from the package root (`.`); the modules they lived
> in stay exactly where they were, and `bin/` keeps importing them by module path, so the CLI is
> unaffected. The three names that carry the "get a slot definition → build a connection" chain are
> kept and are the supported replacement. An already-running process is not migrated in place.

## 1. Read this first

The package `exports` map only exposes `.`, `./tools` and `./contract-tests`, so dropping a name
from `.` makes it unreachable from outside the package. This release drops the **config-indirection
layer** (five names) and keeps the **connection chain** (three names):

| Kept (the connection chain) | Source module |
|---|---|
| `createOpenAIProvider` | `src/providers/openai.js` |
| `loadModelSlot` | `src/config/slot-provider.js` |
| `createProviderForSlot` | `src/config/slot-provider.js` |

| Dropped from the entry (was the config indirection) | Module (still in place) |
|---|---|
| `CONFIG_LEAF_BINDING` | `src/loop/config-namespace.js` |
| `createStaticModelConfigProvider` | `src/config/static.js` |
| `createModelConfigResolver` | `src/config/static.js` |
| `createJsonFileModelConfigProvider` | `src/config/json-file.js` |
| `resolveApiKey` | `src/config/api-key.js` |

The reason: `createOpenAIProvider` is the only door from outside the package to the wire. Dropping
it (or the whole config layer with it) would force every host to re-implement the transport. The
config layer, by contrast, only re-reads `{ "slots": { … } }` and resolves an api key — a host can
do those two things itself, or use `loadModelSlot` / `createProviderForSlot`.

## 2. Replacement per dropped name

The recipe is the same for all five: **read the config yourself, assemble `endpoint` / key / model,
and hand them to `createOpenAIProvider`** (directly, or through `createProviderForSlot`).

### 2.1 `createJsonFileModelConfigProvider` and `createModelConfigResolver`

Both were "give me an object with `async resolve(slot)`". Build that object yourself — read the
same `{ "slots": { "<name>": { … } } }` file and return the selected slot:

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

Feed `modelConfig` to `runToolLoop` exactly as before (it still wants the resolver-shaped object),
and build the provider from the resolved slot with `createProviderForSlot` (§2.3) or
`createOpenAIProvider` directly.

### 2.2 `createStaticModelConfigProvider`

It took the same `{ "slots": { … } }` shape held in memory. Same replacement as §2.1, minus the
file read: keep the object and return `slots[name ?? "default"]`.

### 2.3 `loadModelSlot` → `createProviderForSlot` (the short path)

If you only need the `default` slot, the kept pair does the whole job:

```js
import { loadModelSlot, createProviderForSlot } from "erix-agent";

const { slot } = await loadModelSlot({ configPath });   // validates endpoint / model / apiKey
const provider = createProviderForSlot(slot);           // flattens the slot into createOpenAIProvider
```

### 2.4 `resolveApiKey`

Inline the three-step lookup — `apiKey`, then `apiKeyEnv` (an environment variable), then
`apiKeyFile` (a file whose contents are the key):

```js
function resolveApiKey(config, env = process.env) {
  if (config.apiKey != null) return config.apiKey;
  if (config.apiKeyEnv !== undefined && env[config.apiKeyEnv] !== undefined) return env[config.apiKeyEnv];
  if (config.apiKeyFile !== undefined) return readFileSync(config.apiKeyFile, "utf8").trim();
  return undefined;
}
```

### 2.5 `CONFIG_LEAF_BINDING`

It was re-exported so a host could compute "which key belongs to initialization vs. each call". That
binding is now internal to `src/loop/config-namespace.js` (the engine reconciles it there against
`CONFIG_NAMESPACE_SCHEMA`). A host that needs the split should read the contract's config-plane
section rather than import the table.

## 3. What does not change

- **Options —** no `runToolLoop` option, its key, type or default changes in this release; only the
  package-entry export list loses the five names above.
- **Defaults —** unchanged: `maxRounds`, `stallDetection`,
  `finalGuardTimeoutMs` and the summarizer knobs.
- **Observer events —** no event renamed, removed or added.
- **Diagnostic fields —** unchanged.
- **On-disk formats —** unchanged; nothing new is written and nothing old is dropped.
- **Final payload —** unchanged.
- **CLI —** unaffected: `bin/config.js` imports `../src/config/json-file.js` by module path, not
  through the package entry, so it keeps using `createJsonFileModelConfigProvider` regardless.

## 4. Verify on your side

- Grep your host for the five dropped names; each hit becomes either a `loadModelSlot` /
  `createProviderForSlot` call or a local read like §2.1–§2.4.
- If you import the package entry (`import { … } from "erix-agent"`), the five names are now
  `undefined` there — a runtime check like `typeof index.resolveApiKey === "function"` is the
  fastest way to see whether any call site still expects them.
