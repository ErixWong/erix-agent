# ADR-020: Transcript single source of truth — official engine channels for host writes and reads (`appendUserTurn` + `projectTranscriptForDisplay`)

- Status: Accepted (2026-10-07) — implemented and released in 0.15.0 (GitHub PR #146 read side, PR #147 write side, audit closure PR #148)
- Related: ADR-009 (safety layering), ADR-012 (engine truth model / host policy), ADR-019 (run-state store authority — the run-state side of the same single-store theme); Gitea issues #91 / #95 / #97, recorded by #99; GitHub-era mirror issue #135 was this line's early request before the mirror froze
- Basis: `src/store/append-user-turn.js`, `src/display/projection.js`, `src/loop/resume-manager.js`, `test/contract/engine-api.js`; contract text in `docs/host-consumer-contract.md` ("Multi-turn resume contract", "Host display projection" → "Anti-pattern"); `CHANGELOG.md` 0.15.0; `docs/host-upgrade-guide-0.15.0.md`

## Background

The transcript (`RoundRecord[]` in a host-supplied `TranscriptStore`) is the
model-context truth: byte-faithful for replay, carrying both model-facing
payloads and display-oriented fields (ADR-012 assigns truth to the engine,
policy and LTM to the host). Hosts touch that truth at exactly two points —
feeding a new user turn into a resuming run, and rendering a human-readable
chat view — and until 0.15.0 **neither point had an official channel**:

- **Write side.** The "pre-write a user turn, then `resume: true`" protocol
  (round derivation, `dedupKey` namespacing, record shape, idempotency rule)
  was only observable from built-in CLI behaviour; hosts reverse-engineered it
  from outside. The CLI and REPL themselves had each hand-rolled their own
  `dedupKey`/record construction (removed in PR #147).
- **Drive case (erix-station, #95/#97).** The host kept a second, lossy
  `{ role, text }` message table beside the transcript; the two stores forked,
  history gaps appeared, and the text-injection fallback was rejected by
  thinking-mode providers (`reasoning_content must be passed back` — the
  contract wording is "thinking-mode providers reject text-only assistant
  history"). A UI table cannot round-trip tool calls, reasoning, or fold state.
- ADR-019 (issue #91) had already settled the run-state half of the same
  theme: the engine prescribes semantic channels, never physical layout (D4).

## Decision

### D1: write side — `appendUserTurn` is the engine's official pre-write channel

`appendUserTurn(store, { key, text, messageId?, ts? })`
(`src/store/append-user-turn.js`, requires a store with `load`/`appendRound`)
resolves to `{ key, dedupKey, round, written, record? }` and owns the whole
derivation the host used to hand-roll:

- **Round**: reuses the existing maximum round (`Math.max(0, …)`; empty store
  → seed path round `0`) — the engine resumes from that maximum and writes its
  own rows at later rounds; pre-writes must not advance it.
- **dedupKey**: namespaced `<key>:input:<…>`, disjoint from engine rows
  (`<runId>:engine:round:<n>`, `…:resume`, `…:seed`). With `messageId` it is
  stable (`<key>:input:<messageId>`) → sequential reruns are idempotent;
  without it the suffix degrades to timestamp + random UUID (unique per call).
- **Idempotency check**: an existing record whose `dedupKey` (falling back to
  `roundKey`) matches short-circuits the append (`written: false`, existing
  `record` returned).
- **Resume interplay**: a host user message reaches the model *only* through
  the pre-written record — `resume: true` ignores `initialMessages` /
  `initialUserMessage`, and only when combined with a supplied `store` and
  `runId` (condition in `src/loop/resume-manager.js`); resuming without them
  is an unsupported call.

`bin/cli.js` / `bin/repl.js` are the reference consumers. Full usage
discipline (transaction timing, non-array `load` rejection, whitespace-only
`text` rejection) lives in `docs/host-consumer-contract.md` → "Multi-turn
resume contract"; it is not duplicated here.

### D2: read side — `projectTranscriptForDisplay` is the official display channel

`projectTranscriptForDisplay(records)` (`src/display/projection.js`) is a
pure, host-agnostic projection of any subset of `RoundRecord[]` (e.g. raw
`load()` output) to `DisplayTurn[]`:
`{ role, text, blocks, toolCalls?, reasoning?, folded?, round?, ts?, meta }`.

- `reasoning` is separated from `text` and never merged into it; folded rounds
  render as summary + range + navigation pointers, never raw `foldedPayload`;
  synthetic turns are labelled via `meta.synthetic` / `meta.source`.
- Deterministic, input never mutated, ordered by `round` ascending (records
  without a usable round keep input order and sort last); the result is a
  **read-only view** sharing references with the input records.

Full field-by-field guidance lives in `docs/host-consumer-contract.md` →
"Host display projection".

### D3: anti-pattern — a second lossy message table may not feed the model

The host's second, lossy message table **must not be the source of model
context**; every UI view must be derived from the transcript through D2
(single-store pattern, same theme as #91/#135). Host-specific anchors (session
id, sequence number, attachments, run attribution) may live beside the
transcript; message content must not be duplicated there.

## Relationship to existing ADRs

**Natural extension, not a reversal**, of ADR-009 and ADR-012:

- The engine still embeds no host policy and no security boundary (ADR-009);
  both new APIs are I/O-free — the projection is a pure function, and
  `appendUserTurn` only drives the host's own store methods, so store choice,
  sandboxing, and acceptance transactions remain host territory.
- The engine still owns only the single-task lifecycle and the transcript
  truth (ADR-012); LTM and cross-run orchestration stay on the host. What this
  ADR moves is **ownership of the protocol details of producing/consuming that
  truth** — round numbering, dedup-key naming, record shape, idempotency, the
  display-field selection — which hosts had been re-deriving from observed
  behaviour. Reclaiming them into the engine removes silent per-host drift
  from the truth model, exactly the ADR-012 principle that correctness must not
  depend on each consumer's guesswork.
- ADR-019's stance is reused wholesale (semantic channels, not physical
  layout): `appendUserTurn` never prescribes storage format, and the
  projection consumes whatever `load()` returns.

## Consequences

- **The projection output shape becomes the stable contract surface hosts may
  depend on** (`role`/`text`/`blocks`/`toolCalls`/`reasoning`/`folded`/`round`/
  `ts`/`meta`; additions to entries and `meta` are non-breaking). `RoundRecord`
  internals are **not**: block shapes inside `messages`/`response`/
  `foldedPayload`/`runState` may change across minor versions as long as the
  projection keeps producing the same shape.
- **Idempotency is sequential-rerun semantics** (narrowed in 0.15.0, PR #148):
  a rerun with the same `dedupKey` is a no-op; **concurrent** appends against
  the same key are not covered — the host must serialize per key or issue them
  inside its receiving transaction. `written: true` means "this call executed
  `appendRound`", not "durably unique under concurrency".
- **The contract surface is locked by `test/contract/engine-api.js`**, shipped
  with the package: hosts can run `engineApiContract(label, getEntry)` against
  their own entry to verify both exports exist and the minimal pre-write →
  projection round-trip holds.
- API usage prose stays in `docs/host-consumer-contract.md`; this ADR records
  the decision boundary only.
- Entirely additive (0.15.0, zero new npm dependencies); the built-in CLI/REPL
  lost their hand-rolled pre-write code to D1.
