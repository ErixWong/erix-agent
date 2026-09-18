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

## 5. The `resourceStore` port never shipped — nothing to migrate

`resourceStore` was added during the unreleased 0.6.0 window and removed again
before the release (ADR-015 folded archived output into the transcript's
`toolOutputs`). It does not exist in 0.5.1, so a 0.5.1 host has nothing to
remove. The only observable effect is that explicitly passing the key now
throws `TypeError` through the unknown-option check (§3). If you adopted a
commit from `main` during the window, delete the `resourceStore` option and any
`createFileResourceStore` wiring; archived output now lives in the transcript
and is retrieved with `recall`.

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

## 10. `erix-agent/tools` no longer exports the jail/file helpers

`JailError`, `createJail`, and `createFileTools` were dead code and are gone.
A 0.5.1 host that imported them must bring its own path/permission handling:

```js
// 0.5.1
import { createJail, createFileTools } from "erix-agent/tools";

// 0.6.0 — implement the boundary in the host, or keep using the CLI's
// bin/tools.js exec tool; the library does not ship a sandbox (ADR-009)
```

The remaining `erix-agent/tools` exports are `createToolRegistry`,
`createStaticToolProvider`, `createJsonFileToolProvider`,
`createCompositeToolProvider`, and `createRecallTool`.

## 11. Two new defaults change model-visible behavior

These are not crashes, but they change what the model sees and what a run costs:

- **Output hygiene is on by default.** A tool result longer than 4096 characters
  is archived byte-faithfully into the transcript's `toolOutputs`; the model
  sees a truncated remainder plus a `recall({ pattern: "…" })` recipe instead
  of the whole text. Hosts that relied on the model reading a complete large
  tool result should rely on `recall` (or raise the limit through their own
  tool) instead. Nothing is lost: the full bytes stay in the transcript.
- **`recall` is a standard engine tool.** The loop registers it by default and
  serves calls itself (an identically named host tool wins; `recall: false`
  opts out). A host that already exposes its own retrieval tool should either
  drop it or keep the name to take precedence.

## 12. The contract test suites got stricter

`executeToolContract` now describes only the structured call shape, and the
positional `(name, input)` form moved into `executeToolMigrationContract` as a
negative assertion (`name` receives the whole execution object, `input` is
`undefined`). `resourceStoreContract` no longer exists. A host adapter that was
"green on 0.5.1" can therefore go red on 0.6.0 without any code change — that
is the intended tightening, not a regression: run both suites and fix the
adapter rather than loosening the assertion.
