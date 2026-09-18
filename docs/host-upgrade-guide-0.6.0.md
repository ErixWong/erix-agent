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

The documented semantics now follow the implementation exactly (see
`docs/host-consumer-contract.md`, "Reusable normalization primitives"):
`normalizeOpenAIUsage` returns `undefined` only for `null`/`undefined` and
otherwise returns `{ input_tokens?, output_tokens? }` built from
`prompt_tokens`/`completion_tokens` — it does **not** accept canonical aliases,
so passing `{ input_tokens: 5 }` yields `{}` rather than a passthrough.

## 5. The `resourceStore` port is removed

The archive port is gone in 0.6.0. Archived tool output now lives in the
transcript's byte-faithful `toolOutputs` (ADR-015), so there is no second
archive and nothing to keep in sync:

```js
// 0.5.1
await runToolLoop({ assemblyPort, resourceStore: createFileResourceStore({ dir }) });

// 0.6.0
await runToolLoop({ assemblyPort }); // archived output is in the transcript
```

Passing `resourceStore` (top-level or through `createAssemblyPort`) now throws
`TypeError` as an unknown option. Delete `validateResourceStore`,
`createFileResourceStore`, and the `resourceStoreContract` import; legacy
capture manifests remain readable by the guard for old transcripts, but new
runs never write them.

## 6. Archive hints no longer contain filesystem paths

The engine's archive stub tells the model to search the archive with
`recall({ pattern: "…" })` instead of pointing at a file path, and the
CLI's exec tool no longer emits archive paths either. A host that injected its
own path-bearing stub (`recoveryHint` / `stubFor`) should drop the path and
keep the retrieval instruction; a model that follows an old path hint will
read a file that no longer exists.

## 7. Completion and persistence failures are now reported, not swallowed

This release removes the silent-failure paths:

- auto-capture no longer writes capture notes (the concept was retired in
  ADR-016), so a host that relied on those notes must switch to
  `note_take`/`note_read` or to the transcript archive;
- a `NotesStore` write failure during teardown no longer disappears into the
  `finally` block: it lands in `result.completionErrors[]`, and when the main
  result is an exception it lands on `error.completionErrors`;
- persistence failures are reported through `result.unpersisted[]` (deduplicated,
  message capped at 500 characters) and `diagnostics.error(event)`, and are
  mirrored into the deterministic run state. Hosts that consume `unpersisted`
  should expect `repeat` on entries and treat `kind: "delivery_failure"` as a
  dead diagnostics channel rather than an application error.

## 8. The final guard verifies envelope `findings`, not prose

The guard no longer parses the final text. A run's verifiable claims belong in
the completion envelope:

```json
{"done":true,"summary":"…","output":"…","findings":{"TARGET":"gold-4173"}}
```

What this changes for a host:

- prose assertions are not checked at all — `verified` means "the declared
  findings matched archived values", never "the whole answer is trustworthy";
- a run that has archived values but declares no findings is revised and then
  fail-closes to `unverified` (it is no longer silently `skipped`);
- `skipped` now exits the CLI with code 4, so "not checked" is distinguishable
  from `verified` (exit code 0);
- when the loop LLM-normalizes a prose answer into the envelope, each finding
  value must appear verbatim in the model's own text; anything else is dropped
  before the guard sees it.

## 9. Reflection defaults are unified and scale with the budget

The CLI no longer uses a separate `max-rounds >= 32` threshold: both the
library and `erix chat` enable the basic judge at
`maxRounds >= DEFAULT_REFLECTION_MIN_ROUNDS` (16), unless
`ERIX_NO_REFLECTION=1`/`reflection: false` says otherwise. A 16-round task
that previously ran unguarded by reflection now makes judge calls — set
`reflection: false` explicitly if that cost is not wanted. The default
extension step is now `max(8, maxRounds * 0.5)` instead of a fixed `+32`, so a
small task is extended proportionally.
