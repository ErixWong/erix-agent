# Host upgrade guide for 0.6.0

Version 0.6.0 makes the host boundary explicit. The changes below are
breaking for integrations that relied on the previous implicit behavior.

## 1. `executeTool` receives one structured object

The loop always calls the host executor once with:

```js
{ id, name, input, context, signal }
```

There is no positional dispatch or function-arity negotiation. Migrate a
legacy executor by changing its signature:

```js
const executeTool = async ({ name, input }) => {
  return legacyExecuteTool(name, input);
};
```

Alternatively, rewrite the implementation directly:

```js
const executeTool = async ({ name, input }) => {
  // dispatch using name and input
};
```

An old `(name, input) => ...` function passed directly to `runToolLoop` will
receive the whole execution object as `name` and `undefined` as `input`.

## 2. Required stores expose all nine persistence methods

When `store` is supplied, persistence is required by default. Startup rejects
the store before provider or tool execution if any method is missing:

```text
appendRound, load, recall,
saveCheckpoint, appendCheckpoint, loadLatestCheckpoint,
saveRunState, loadRunState, markRunState
```

This validation is intentionally fail-closed. Use `persistence: "none"` only
when the host explicitly wants to disable persistence, including with an
incomplete or diagnostic-only store.

For touwaka, `createErixStore` must expose its existing `load`, `recall`, and
run-state methods (`saveRunState`, `loadRunState`, `markRunState`); the lower
layer already implements them, but the wrapper must not hide them.

## 3. Unknown run options throw

`runToolLoop` rejects unknown top-level option keys with `TypeError`. Remove
`...passthrough` objects and other private keys before calling the loop. Keep
host-private metadata in `toolContext`, `context`, or a provider-adapter
closure rather than adding it to the top-level options:

```js
const provider = createProvider({ tenantId }); // binds private metadata
await runToolLoop({
  provider,
  executeTool,
  toolContext: { tenantId },
});
```

For app_container, wrap the legacy executor at the host boundary:

```js
const executeTool = async ({ id, name, input, context, signal }) => (
  legacyExecuteTool(name, input, { id, context, signal })
);
```

Do not pass the legacy two-argument function directly.

## 4. Reuse the library normalization primitives

The OpenAI-compatible normalization code is now exported from the package
root. In `touwaka/lib/llm-kit-adapters/provider-adapter.js`, the following
local implementations can be considered during host migration:

| Local implementation | Use this export | Migration status |
|---|---|---|
| `normalizeUsage` | `normalizeOpenAIUsage` | Can replace directly; parity-tested |
| `normalizeStopReason` | `normalizeOpenAIStopReason` | Semantic difference — host decides whether to adopt |
| `parseToolArguments` | `parseOpenAIToolArguments` | Semantic difference — host decides whether to adopt |
| `toolCallParts` + `appendToolCallFragments` + `completedToolUseBlocks` | `createOpenAIStreamAccumulator` (`addToolCallDelta` / `getToolUseBlocks`) | Can replace directly; parity-tested |

The adapter's `toChatResponse` and `streamResponse` remain host glue for
Touwaka response shapes and callbacks, but should call the exported helpers
instead of reimplementing token, stop-reason, or argument semantics.
`buildCallOptions`, model resolution, abort bridging, and event forwarding
remain host-specific and are not replaced by this change.

The two non-drop-in cases are intentional. Touwaka's `normalizeStopReason`
returns `"function_call"` unchanged, while the exported helper maps it to
`"tool_use"`. Touwaka's `parseToolArguments` returns an object argument
directly, while the exported helper treats it as a non-JSON value and returns
its malformed-argument wrapper. Do not delete either local implementation
without deciding which behavior the host requires.
