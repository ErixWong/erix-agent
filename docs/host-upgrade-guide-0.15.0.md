# Host upgrade guide: 0.15.0

Additive release: the two host-side transcript contract capabilities requested by
erix-station (Gitea erix-llm-kit issues #95/#96/#97), plus one documentation
correction and an audit hardening pass. **No breaking changes** — existing
`runToolLoop`, `TranscriptStore`, and run-state behaviour are unchanged.

## 1. New engine API: `appendUserTurn` (write side of multi-turn resume)

The "host pre-writes a user turn, then resumes" pattern is now an engine
capability. Hosts no longer hand-roll the record:

```js
import { appendUserTurn } from "erix-agent";

// Call this inside the transaction that accepts the user message.
const { key, dedupKey, round, written } = await appendUserTurn(store, {
  key: sessionId,          // transcript key (runId / session id)
  text: userText,
  messageId: row.id,       // stable id → stable dedupKey → idempotent reruns
});
// then start the worker with runToolLoop({ session: { resume: true }, ... })
```

Semantics (full contract in `docs/host-consumer-contract.md` →
"Multi-turn resume contract"):

- `round` reuses the existing maximum round (the engine resumes from it and
  writes its own records at later rounds); empty store → round `0`.
- With `messageId`, the pre-write is safely repeatable **sequentially**
  (crash-rerun / retry by `dedupKey`). Concurrent appends on the same key are
  not covered — serialize per key or issue them inside your receiving
  transaction.
- `store.load()` returning a non-array now throws (`TypeError`) instead of
  silently behaving like an empty store. Whitespace-only `text` is rejected.
- `resume: true` ignores `initialMessages`/`initialUserMessage` — and only
  when a `store` and `runId` are supplied; resuming without them is an
  unsupported call.

The built-in CLI and REPL call `appendUserTurn` internally; their on-disk
record shapes are unchanged.

## 2. New display projection: `projectTranscriptForDisplay` (read side)

Hosts that render a human-readable chat view should derive it from the
transcript with the official projection instead of maintaining a second lossy
message table:

```js
import { projectTranscriptForDisplay } from "erix-agent";

const turns = projectTranscriptForDisplay(await store.load(runId));
// [{ role, text, blocks, toolCalls?, reasoning?, folded?, round, ts, meta }]
```

Key rules (full contract in "Host display projection"):

- The projection output shape is the stable contract surface; `RoundRecord`
  internals are not. New `meta` keys are non-breaking — ignore unknown ones.
- `reasoning` is separated from `text`; do not drop it from what you feed back
  to the engine (thinking-model replay requires `reasoning_content`).
- Folded rounds render as summary + range + navigation pointers; never dump
  `foldedPayload` raw into the chat view.
- The returned value is a **read-only view**: `blocks`, `usage`, and
  `navigationRecord` share references with the input records. Treat projection
  results as immutable data.

## 3. Fixed doc: `loadRunStateStatus` returns a status string

The 0.14.0 upgrade guide §1 example was wrong (it read `status?.status`). The
reader resolves to the status **string** directly:

```js
const status = await store.loadRunStateStatus(runId); // Promise<string | undefined>
if (status === "succeeded") { /* ... */ }
```

Snapshot fields (`stateVersion`, `deterministic`, `semantic`) still come from
`loadRunState`. Hosts that copied the old example should re-check their
terminal-status comparisons.

## 4. Contract self-check for hosts

A new contract suite ships with the package:

```js
import { engineApiContract } from "erix-agent/contract-tests";
engineApiContract("my-host-bundle", () => import("erix-agent"));
```

It locks the package entry exports and the minimal pre-write behaviour of
`appendUserTurn`.

## 5. Self-check commands for this release (issue #183)

The requirements here are API-level, not schema-level, so the self-check is a
code probe rather than a SQL statement. Each block is copy-pasteable after
replacing the module path:

```bash
# the two new entry exports must be functions (not undefined after a bad bump)
node -e "import('erix-agent').then((m) => console.log(
  ['appendUserTurn', 'projectTranscriptForDisplay'].map((k) => [k, typeof m[k]),
));"

# the store surface appendUserTurn depends on; an empty array is the pass
node -e "import('./your-store.js').then(async (m) => {
  const store = await m.createStore();
  console.log(['appendRound', 'load'].filter((k) => typeof store[k] !== 'function'));
});"

# load() must return an array for an unknown key — a null/undefined return now
# makes appendUserTurn throw TypeError (see §1)
node -e "import('./your-store.js').then(async (m) => {
  const store = await m.createStore();
  const rows = await store.load('probe-run-does-not-exist');
  console.log(Array.isArray(rows) ? 'array' : typeof rows);
});"
```

Checklist item 2 keeps host-side anchor columns (session id, sequence number,
attachments, run attribution) beside the transcript. Those are host-owned
optional columns: verify them with
`SHOW COLUMNS FROM your_table LIKE 'seq'` (or the
`INFORMATION_SCHEMA.COLUMNS` form in
[host-upgrade-guide-0.17.0.md](host-upgrade-guide-0.17.0.md) §4) rather than
assuming they exist, and land any addition on both the new-install baseline and
the upgrade migration (0.17.0 guide §5).

## Checklist

1. Replace hand-rolled `:input:` pre-writes with `appendUserTurn` (keep calling
   it inside your message-acceptance transaction).
2. Replace second message tables with `projectTranscriptForDisplay` output;
   persist only host-side anchors (seq/attachments/run ownership) if needed.
3. Verify terminal-status reads compare the string directly (issue #96 fix).
4. Optional: wire `engineApiContract` into your test suite.
