<!-- doc-version: 0.30.0 -->
# Host upgrade guide: 0.30.0

**Release: 0.30.0 (unreleased — this page is a release-preparation document).** 0.30.0 is the
breaking bundle the library has been pointing at since the deprecation registry landed: **16 exported
names are removed**. Every one of them was registered as a *zero-consumer* export — nothing in this
repository imports it, nothing in the host checkouts the probe can see imports it — and the one name
that a live host does import gets a recipe (§3) rather than a promise.

Nothing else moves. No `runToolLoop` option is retired, renamed or re-homed, no default value
changes, no observer event, diagnostic field or on-disk format changes. A host that never imported any
of the 16 names upgrades by bumping the version.

**Why this table cannot rot.** The name set of the two tables below is reconciled, in the same
`check:docs` run, against the candidate list that `node scripts/deprecated-export-check.mjs --json`
computes live. Four things are red: a candidate that is missing from this page (named), a row on this
page whose name is not a candidate (named), an EN/CN disagreement (named), and a row whose migration
clause does not quote the clause written in that name's own `@deprecated` marker. The entry column is
checked too — it must agree with what `src/index.js` / `src/tools/index.js` actually re-export. The
list is derived on every run, never copied: registering a 17th name, or dropping one, makes this page
red until it follows.

## 1. Change summary

| What you change | Why it changed | Where |
|---|---|---|
| Stop importing the 15 names in §2 | they are zero-consumer exports, registered for removal in the 0.30 breaking bundle | §2 |
| Replace your `createAnthropicProvider` import **before** you upgrade | a live host imports it, and the factory is gone in 0.30.0 — an ESM import of a missing name fails at module load | §3 |
| Nothing else | no option, default, event or on-disk format moves | §4 |

## 2. The fifteen names nothing imports

Measured, not asserted: the candidate list this section is reconciled against is the set of exports
whose in-package, publish-surface and own-file consumers are all zero. If you never imported one of
these, its removal is invisible to you.

| Name | What it did | Migration clause | Entry | Definition |
|---|---|---|---|---|
| `createCompositeToolProvider` | wrapped several tool providers into one `listTools(sel)` that merged their schemas in order | no in-tree replacement — the host builds its own tool provider (any object with `listTools(sel)`) | `./tools` | `createCompositeToolProvider` (`src/tools/providers.js`) |
| `createEnvModelConfigProvider` | model-config provider that read one slot's values out of environment variables | no in-tree replacement — the host reads its own environment and implements the duck-typed `resolve(slot)` contract (`createJsonFileModelConfigProvider` is a different source, not a drop-in replacement) | `.` | `createEnvModelConfigProvider` (`src/config/env.js`) |
| `createJsonFileToolProvider` | tool provider that read its tool sets out of a JSON file (or a directory of them) | no in-tree replacement — the host builds its own tool provider (any object with `listTools(sel)`) | `./tools` | `createJsonFileToolProvider` (`src/tools/providers.js`) |
| `createStaticToolProvider` | tool provider that served a fixed in-memory set of schemas | no in-tree replacement — the host builds its own tool provider (any object with `listTools(sel)`) | `./tools` | `createStaticToolProvider` (`src/tools/providers.js`) |
| `estimateMessagesTokens` | token estimate over a whole message array | migrate to `estimateMessageTokens` — identical behaviour; the old name only existed for one external call site | `.` | `estimateMessagesTokens` (`src/tokens.js`) |
| `extractL0` | pulled the objective facts out of a model response | migrate to `extractL0Facts` — the same function under an older name | `.` | `extractL0` (`src/reflection/l0.js`) |
| `extractL0Fact` | singular spelling of the same fact extractor | migrate to `extractL0Facts` — the same function under an older name | `.` | `extractL0Fact` (`src/reflection/l0.js`) |
| `MESSAGE_OVERHEAD_TOKENS` | per-message token overhead constant | migrate to `MESSAGE_OVERHEAD` — a spelling alias of the same constant, not a separate knob | `.` | `MESSAGE_OVERHEAD_TOKENS` (`src/tokens.js`) |
| `NOTE_VALUE_MAX_CHARS` | a length constant that no tool schema ever read | no in-tree replacement — the constant is not wired into any tool schema (the `content` limit is `MAX_CONTENT_LENGTH`), so nothing in-tree can be migrated to it | `.` + `./tools` | `NOTE_VALUE_MAX_CHARS` (`src/tools/notes.js`) |
| `parseReflectionSummary` | parsed the inline summary protocol out of a response | migrate to `parseL1Summary` — the same function under an older name | `.` | `parseReflectionSummary` (`src/reflection/l0.js`) |
| `parseSummary` | shorter spelling of the same inline-summary parser | migrate to `parseL1Summary` — the same function under an older name | `.` | `parseSummary` (`src/reflection/l0.js`) |
| `removeRecord` | deleted one roster record file from a roster directory | no in-tree replacement — `reconcile` only rewrites state and deletes no file; do not build your archive logic on this primitive | `./tools` | `removeRecord` (`src/tools/delegation/roster.js`) |
| `resolveFileReadMaxBytes` | resolved the single-read byte cap from the environment | no in-tree replacement — the limit is resolved inside `createFileTools`, and there is no separate public entry for it | `./tools` | `resolveFileReadMaxBytes` (`src/tools/file-tools.js`) |
| `serializeFoldedMessages` | rendered the folded-history payload into the text a summarizer reads | migrate to `serializeFoldedMessagesWithMeta` — same text under `.text`, plus the `dropped` / `total` / `bounded` accounting this thin wrapper threw away | `.` | `serializeFoldedMessages` (`src/compact/provider-summarizer.js`) |
| `setNotesClock` | swapped the clock the notes tools stamp records with | no in-tree replacement — there is no supported clock-injection seam on the public surface (only the notes tests drove this hook) | `./tools` | `setNotesClock` (`src/tools/notes.js`) |

Two of these rows deserve one sentence each, because "delete it" reads like a product decision:

* **The notes surface is not shrinking.** `NOTE_VALUE_MAX_CHARS` and `setNotesClock` are recorded here
  exactly as their own markers describe them — a constant nothing read and a test-only clock hook.
  `createBuiltinNotesTools`, `MAX_CONTENT_LENGTH`, `resolveNotesDir` and the five notes tools stay,
  unchanged.
* **Six of the fifteen are one-line aliases** (`estimateMessagesTokens`, `extractL0`, `extractL0Fact`,
  `MESSAGE_OVERHEAD_TOKENS`, `parseReflectionSummary`, `parseSummary`): the replacement is the same
  function or the same value, so the edit is a rename at the import site.

## 3. The one name a live host imports: `createAnthropicProvider`

`createAnthropicProvider` (`src/providers/anthropic.js`) is the only name in this bundle that a host
repository really imports today. The recorded host fact is an import of this factory at module scope
in `app_container/apps/worker/src/pi/erix-adapter.js`; re-check it with the host-side probe
(`npm run check:host-consumers -- --hosts <host repo dirs>`), which is the half of this decision this
repository cannot see by itself.

In 0.30.0 the factory is gone, and the failure mode is not a warning: the package is ESM, so an
`import` of a name that no longer exists fails **at module load**. A host that upgrades first and
migrates later does not degrade — it fails to start.

| Name | What it did | Migration clause | Entry | Definition |
|---|---|---|---|---|
| `createAnthropicProvider` | built an Anthropic-protocol provider (`{protocol, model, chat, chatStream}`) out of an endpoint, a key and a model name | no in-tree replacement — the host builds the provider object itself (the duck-typed `{protocol, model, chat, chatStream}` shape); §3.2 is the recipe | `.` | `createAnthropicProvider` (`src/providers/anthropic.js`) |
Its marker's clause is `no in-tree replacement`, and that is meant literally.

* **`createProviderForSlot` is not its replacement.** `createProviderForSlot`
  (`src/config/slot-provider.js`) reads one model slot and flattens it into `createOpenAIProvider`.
  That file says in so many words that it does **not** pick a protocol — "today there is only the
  OpenAI-compatible path", and adding a third protocol is a separate ticket. Pointing an Anthropic
  endpoint at it would send OpenAI-shaped payloads to an Anthropic endpoint: a wrong request, not a
  compile error.
* **Nothing else in the tree builds an Anthropic provider.** The protocol layer stays public and
  supported — the request builder, the response mapper and the stream assembler are all still
  exported. The *factory* is what retires.

### 3.1 The shape you have to produce

A provider is a duck-typed object, not a class and not a registered factory. The engine reads four
members and ignores anything else:

```js
{ protocol, model, chat, chatStream }
```

`createOpenAIProvider` (`src/providers/openai.js`) returns exactly that shape — its return block is
`protocol`, `model`, `chat`, `chatStream` plus four optional passthrough fields — which is why a
hand-built provider needs no registration anywhere: `runToolLoop` takes the object.

### 3.2 A recipe you can copy

The four pieces below are the ones the retired factory was made of, and all four stay exported from
the package root.

```js
import {
  KitError,
  classifyFetchException,
  classifyHttpError,
  canonicalToAnthropicRequest,
  anthropicResponseToCanonical,
  createAnthropicStreamAssembler,
} from "erix-agent";

/** Same duck-typed provider the retired factory returned. */
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
        maxTokens: request.maxTokens ?? maxTokens,   // the builder requires it
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
    // SSE: `event:` names the type, `data:` carries one JSON object, a blank line dispatches.
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

What the recipe deliberately does **not** reproduce: the retired factory's timeout and transport
knobs, its `extraBody` / `defaultHeaders` injection, and its system-message normalisation. Those were
its own conveniences; if you relied on them, carry the behaviour you actually need into this object —
nothing in the engine reads them.

### 3.3 What the engine will do with it

Nothing protocol-specific. The provider object is passed to `runToolLoop` like any other, and the
canonical request/response shapes on either side of `chat` / `chatStream` are the ones documented in
`docs/host-consumer-contract.md`. Two failure shapes are worth pinning, because both look like a
model problem and are not: an HTTP error must be thrown as a `KitError` (that is what
`classifyHttpError` produces), and a stream must end with `finish()` — the assembler returns the
canonical response; returning raw SSE text is not a response.

## 4. What does not change

* The `runToolLoop` input surface, the `capabilities` shape, and every configuration leaf. No option
  is retired, renamed or re-homed by this release.
* Termination, verification and exit-code semantics, including the `skipped`-without-guard exit code.
* Observer events, diagnostic fields, and the run-state block.
* Transcript and run-state on-disk formats; a ledger written by the previous release still resumes.
* The notes tool surface (five tools plus `createBuiltinNotesTools`, `MAX_CONTENT_LENGTH`,
  `resolveNotesDir`), the file tools, the delegation bookkeeping modules, and every provider protocol
  helper.
* The zero-runtime-dependency rule.

## 5. Verify it on your side

1. **Prove you do not import the 15.** Grep your tree for the names in §2 (or run the host-side probe
   with your checkout as an argument). A hit means one of those rows applies to you.
2. **Prove the Anthropic path still runs.** With the recipe in §3.2 in place, send one non-streaming
   request and assert the canonical response carries `content` and `stopReason`; then send one
   streaming request and assert `finish()` returns the same two fields. A thrown `KitError` with a
   status is an HTTP problem; a thrown `TypeError` is your payload, not the network.
3. **Type-check against the published declarations** (`tsc --strict`). Every name in this bundle is
   absent from the generated declarations of 0.30.0, so an import that survived the migration is a
   compile error, not a runtime surprise.
4. **Re-run the gates that own this page.** `npm run check:docs` reconciles the tables above against
   the live candidate list; `npm run check:exports:deprecated` reconciles the markers themselves. If
   you add or drop a name in the bundle, both move in the same commit.
