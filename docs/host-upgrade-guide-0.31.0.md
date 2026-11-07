<!-- doc-version: 0.31.0 -->
# Host upgrade guide: 0.31.0

**Release: 0.31.0.** This is the breaking bundle that **actually lands the sixteen deletions** the
0.30.0 guide announced. In 0.30.0 the names below were still exported — the guide said "removed"
and the package kept handing every one of them to `import` — so the real boundary moved here. Ten
names leave the package root (`erix-agent`), seven entry names leave `erix-agent/tools`
(`NOTE_VALUE_MAX_CHARS` lived on both, which is why sixteen names make seventeen entry rows), and
nothing else moves.

**What is deleted is the export, not the implementation.** `createAnthropicProvider`, the three tool
providers, the environment model-config provider and the five one-line aliases still exist inside
`src/` as internal parts; the package entries simply stop re-exporting them. An ESM `import` of one
of these names from `erix-agent` / `erix-agent/tools` now fails **at module load** — not with a
warning, not at first use.

**Why this table cannot rot.** The name set of the two tables below is reconciled, in the same
`check:docs` run, against the candidate list that `node scripts/deprecated-export-check.mjs --json`
computes live, and `check:release` re-reads this page against the **installed** package's runtime
export surface: a name this page claims is gone must really be absent from the entry its row
registers. The EN/CN halves must carry the same names and the same entry columns, and every
migration clause is the one written in that name's own `@deprecated` marker. The guide is derived on
every run, never copied.

## 1. What 0.30.0 actually did (errata)

0.30.0 shipped the deprecation registry, the markers and the guide — but **not** the deletions.
`erix-agent@0.30.0` still exported all sixteen names from the two entries, so a host that upgraded
to 0.30.0 and had already migrated saw no breakage, and a host that had not migrated saw no
breakage either. The 0.30.0 page has been corrected in place (§2 and §3 carry an errata note); the
deletion itself is this release.

If you are on 0.30.0 and never imported any of the sixteen names, upgrading is a version bump. If
you did import one, migrate **before** you upgrade: an ESM import of a missing name fails at module
load, so "upgrade first, migrate later" does not degrade — it fails to start.

That page also carried one migration clause that was never importable: for `serializeFoldedMessages`
it named `serializeFoldedMessagesWithMeta`, a serializer no entry of 0.30.0 or 0.31.0 has ever
exported, so the row for that name in §2 — not the 0.30.0 wording — is what a host should follow.

## 2. The sixteen removed names

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
| `serializeFoldedMessages` | rendered the folded-history payload into the text a summarizer reads | no in-tree replacement — the fold is rendered inside `createProviderSummarizer` now (it calls the serializer itself and returns summary text); a host that rendered the fold by hand keeps its own renderer. `serializeFoldedMessagesWithMeta` is the internal serializer, not exported from any entry — do not import it | `.` | `serializeFoldedMessages` (`src/compact/provider-summarizer.js`) |
| `setNotesClock` | swapped the clock the notes tools stamp records with | no in-tree replacement — there is no supported clock-injection seam on the public surface (only the notes tests drove this hook) | `./tools` | `setNotesClock` (`src/tools/notes.js`) |

Six of these are one-line aliases (`estimateMessagesTokens`, `extractL0`, `extractL0Fact`,
`MESSAGE_OVERHEAD_TOKENS`, `parseReflectionSummary`, `parseSummary`): the replacement is the same
function or the same value, so the edit is a rename at the import site. The notes surface itself is
not shrinking — `createBuiltinNotesTools`, `MAX_CONTENT_LENGTH`, `resolveNotesDir` and the five
notes tools stay, unchanged.

## 3. `createAnthropicProvider` (the one name a live host imports)

`createAnthropicProvider` (`src/providers/anthropic.js`) is the only name in this bundle that a host
repository really imports today. The recorded host fact is an import of this factory at module scope
in `app_container/apps/worker/src/pi/erix-adapter.js`; re-check it with the host-side probe
(`npm run check:host-consumers -- --hosts <host repo dirs>`), which is the half of this decision
this repository cannot see by itself.

| Name | What it did | Migration clause | Entry | Definition |
|---|---|---|---|---|
| `createAnthropicProvider` | built an Anthropic-protocol provider (`{protocol, model, chat, chatStream}`) out of an endpoint, a key and a model name | no in-tree replacement — the host builds the provider object itself (the duck-typed `{protocol, model, chat, chatStream}` shape); the copyable recipe is in the 0.30.0 guide §3.2 | `.` | `createAnthropicProvider` (`src/providers/anthropic.js`) |

That clause is meant literally.

* **`createProviderForSlot` is not its replacement.** It reads one model slot and flattens it into
  `createOpenAIProvider`; pointing an Anthropic endpoint at it sends OpenAI-shaped payloads to an
  Anthropic endpoint — a wrong request, not a compile error.
* **The protocol layer stays public and supported.** `canonicalToAnthropicRequest`,
  `anthropicResponseToCanonical` and `createAnthropicStreamAssembler` are still exported from the
  package root; the *factory* is what retires. The 0.30.0 guide's §3.2 recipe builds the same
  duck-typed object out of those three helpers, and it still applies verbatim.
* **`createOpenAIProvider` is the only provider factory the package publishes.** Other protocols are
  the host's own provider object.

## 4. What does not change

Six surfaces, taken one at a time. This release deletes exports and nothing else: not one member of
these six surfaces moves, so every row below says **unchanged** — and each row says what it means by
that, because an "unchanged" that does not name the members it covers is not worth reading. The
cross-check runs in both directions: the `[0.31.0]` section of `CHANGELOG.md`, which is the only
record of what this version changed, names no member of any of the six surfaces. A name that leaves
the package root is not an input-surface member: the sixteen names in §2 are exports, not options,
not events, not payload keys.

* **Options — unchanged.** No `runToolLoop` option is retired, renamed or re-homed by this release,
  and the configuration namespace keeps every group and every leaf it had in 0.30.0 —
  `run.maxRounds`, `folding.toolResultTtl`, `guard.finalGuardMaxRetries`, `timing.timeoutMs`,
  `metadata.modelMetadata` and the rest, at the same nesting. The CLI flag set is the same set too
  (`--compaction`, `--compact-budget`, `--final-guard`, `--require-deliverable`, `--delegate` and the
  rest): this release adds no flag and drops none.
* **Defaults — unchanged.** No existing option's default value is re-specified here. The two loader
  constants that carry them, `DEFAULT_MAX_OUTPUT_TOKENS` and `DEFAULT_COMPACTION_STRATEGY`, hold the
  values they held in 0.30.0, so a configuration that omitted them derives what it derived before.
* **Observer events — unchanged.** The same event names go out with the same payloads: `round_start`,
  `round_end`, `tool_use`, `tool_result`, `usage`, `run_outcome`, `persistence_error`, `compaction`,
  `compaction_strategy_fallback` and the rest of the set. Nothing is renamed, nothing is added, and
  `type: "compaction"` still means what it meant in 0.30.0.
* **Diagnostic fields — unchanged.** The `compactionStats` entry keeps the shape 0.30.0 wrote,
  including the fields that release moved: `strategyName`, the `foldSummary` sub-object,
  `degradeKind` / `degradeReason` (still without an in-tree writer) and `budgetExhausted` on the
  failure branch.
* **On-disk formats — unchanged.** The fold ledger keeps its 0.30.0 shape — `foldedFacts` with
  `foldId`, `seq`, `text`, `source`, `strategy`, `roundRange` and the rest — so a ledger written by
  0.30.0 resumes under 0.31.0 with no migration step and no renumbering pass. The run-state and
  transcript files are written by the same code.
* **Final payload — unchanged.** `makeResult` returns the same keys (`finalText`, `messages`,
  `transcript`, `rounds`, `truncated`, `verification`, `guardVerdict`, `metrics`, `runState`, `usage`,
  `engineUsage`, `compactionStats`, `completionErrors`, `finalTextFallback`, `forcedFinal`), a failed
  run still carries `termination.errorCode`, and the exit codes keep their meanings:
  `exitCodeForRunFailure` for a failed run, `exitCodeForVerification` for a run that did not verify,
  and neither of them shares the usage-error code.
* What did **not** move either: the notes tool surface (`createBuiltinNotesTools`,
  `MAX_CONTENT_LENGTH`, `resolveNotesDir` and the five notes tools), the file tools, the delegation
  bookkeeping modules, every provider protocol helper (`canonicalToAnthropicRequest`,
  `anthropicResponseToCanonical`, `createAnthropicStreamAssembler`), and the
  zero-runtime-dependency rule.

## 5. Verify it on your side

1. **Prove you do not import the sixteen.** Grep your tree for the names in §2 and §3 (or run the
   host-side probe with your checkout as an argument). A hit means one of those rows applies to you.
2. **Type-check against the published declarations** (`tsc --strict`). Every name in this bundle is
   absent from the generated declarations of 0.31.0, so an import that survived the migration is a
   compile error, not a runtime surprise.
3. **Re-run the gates that own this page.** `npm run check:docs` reconciles the tables above,
   `npm run check:exports:deprecated` reconciles the markers and the ledger, and `npm run
   check:release` compares this page with the installed package's runtime export surface. If you add
   or drop a name in the bundle, all three move in the same commit.
