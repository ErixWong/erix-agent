# erix-agent

> Chinese version: [README_cn.md](README_cn.md)

**erix-agent** is a zero-dependency, pure ESM LLM runtime for headless coding
agents. It provides dual-protocol streaming providers, a tool-calling loop,
context compaction, checkpointing, resume, bounded recall, and an optional
reflection/judge layer for unattended work.

**Positioning: headless agent.** The product is an engine plus a
programmatic task entry point: a task enters, the agent runs its tool loop,
events leave the process, and the run can be resumed. It is not a UI and is
not designed for a person sitting in front of a terminal. `runToolLoop`
owns one agent task lifecycle: start, run, stop, resume, and stream events
through `onRound`, `onDelta`, `onToolCall`, `onUsage`, and `onEvent`.

The relationship with pi is complementary:

- **pi is an interactive agent**: human-in-the-loop, with TUI/subagent/MCP
  workflows.
- **erix is a headless agent**: unattended and scheduled by a host.

The boundary ends at one agent task lifecycle. Multi-role orchestration,
arbitration, retry scheduling, reapers, and task queues belong to the host
(`app_container` / `touwaka`), not to this library. Keeping that boundary
avoids turning a small runtime into a headless-agent platform and preserves
the zero-dependency design.

The CLI (`erix`) is a verifier and debugger, not the product:

- `erix chat` is a single-task entry point and can be used by a benchmark
  harness.
- `erix repl` is an interactive TUI and measures human-agent collaboration,
  not unattended autonomy.
- The intended unattended evaluation surface is the external
  **erix-bench** harness, which drives tasks in a container and compares
  `--agent erix|pi`.

The runtime also exposes extension surfaces for self-describing skills,
MCP integration, transcript stores, and host-provided task state. The
repository bundles the `notes` skill; the todo skill is an example under
`examples/skills/todo/`, not a built-in `runToolLoop` capability.

> **Security boundary:** the runtime does not enforce a security policy.
> The caller is responsible for safety. Running locally means giving the
> agent access to your local trust domain; embedded or sandboxed deployments
> must be isolated by the host. The CLI tools intentionally allow arbitrary
> file paths and shell commands and do not add an allowlist or confirmation
> prompt. The optional `erix-agent/tools` export includes a jail helper for
> callers that want to build a restricted tool surface.

The project is intended for integrations including `app_container` (PI Agent
audit/development paths) and `touwaka` (AgentLoop/conversation paths). Those
host integrations are outside this package's lifecycle boundary.

## Why a unified headless agent?

Several in-house projects and vibe-coded prototypes need LLM capability, and
their authors are not necessarily fluent in prompting, context engineering,
tool calling, structured output, retries or cost control. Wiring each one
straight to a provider reproduces the same defects everywhere: inconsistent
call conventions, poorly shaped context, wasted tokens, flaky tool calls,
thin error handling, unpredictable agent behaviour. A shared headless runtime
exists so that application code depends on one stable programmatic interface
instead of re-solving the engineering underneath it.

| Requirement | Provided by this runtime | Owned by the host |
|---|---|---|
| Lower the barrier to LLM use | `runToolLoop` as the single entry point; dual-protocol providers; canonical message model; compaction; checkpoint/resume; classified errors | product-level prompt and workflow design |
| Centralised model configuration and run policy | duck-typed `ModelConfigProvider.resolve(slot)` with `static` / `env` / `json-file` adapters, per-slot models, `apiKey`/`apiKeyEnv`/`apiKeyFile` indirection, budget derivation | the configuration store itself (database or config centre), project and tenant quotas, fallback policy, prompt and agent versions |
| Traceable calls, cost analysis and audit | event stream (`onRound` / `onDelta` / `onToolCall` / `onUsage` / `onJudge` / `onEvent`), token accounting, `TranscriptStore` persistence, stable run ids, checkpoints and bounded recall for replay | log and cost storage, dashboards, retention, audit process |
| One tool, permission and safety boundary | a single execution entry (`executeTool`), an executor registry that data cannot extend, schema intersection, optional jail/file/recall helpers under `erix-agent/tools` | the policy itself: which project may run which agent, which tools, which operations need confirmation, network and write access, rate and time limits |
| Contain third-party framework churn | zero runtime dependencies and an owned implementation, a stable exported surface plus `erix-agent/contract-tests` for consumers | — |
| Accumulate reusable agent engineering | canonical message and tool formats, ADR-tracked decisions, contract tests, benchmark harness | — |

Two boundaries keep this honest. The runtime **executes no policy** — it
exposes the hooks and the host decides
([ADR-009](docs/decisions/009-safety-layering.md)). And it **owns exactly one
task lifecycle** — queues, arbitration and retry scheduling stay with the host
([ADR-012](docs/decisions/012-engine-truth-model-efficiency-host-policy.md)).

## Why build our own?

The project research conclusion (2026-08-29; see the research index below)
is that the important gap is not another provider adapter:

- **Vercel AI SDK** (`ai` v7) has mature provider and tool-loop support, but
  context compaction is explicitly left to the application (the official
  cookbook uses `prepareStep` for application code). The most valuable part
  of this runtime would still need to be built.
- **LangChain.js / Mastra / LangGraph** provide framework-level abstractions,
  while both named host projects intentionally avoid taking a framework
  dependency.
- **oneringai and similar full stacks** have the wrong shape: heavy
  dependencies and unrelated audio/image capabilities.
- **pi SDK** is an interactive agent. Its human-in-the-loop shape is
  complementary to erix's headless lifecycle rather than a replacement for
  it.

The trigger for replacing this implementation (for example, adding a third
non-OpenAI-compatible protocol) and the project's stop-loss line are internal
decisions; they are not runtime capabilities.

## Module map

The public entry point is `src/index.js`; the complete current source tree is:

```text
src/
  index.js                         Public exports
  loop.js                          runToolLoop and reflection parsing
  run-state.js                     Bounded deterministic and semantic run state
  tokens.js                        Conservative token estimation
  providers/
    anthropic.js                   Anthropic provider and streaming
    errors.js                      Provider errors and classification
    openai.js                      OpenAI-compatible provider and streaming
    payload.js                     Provider payload and timeout options
    timeout.js                     Provider timeout handling
  messages/
    anthropic.js                   Anthropic protocol conversion and stream assembly
    canonical.js                   Canonical message/tool conversion
    rounds.js                      Message validation and round grouping
  compact/
    budget.js                      Context-budget calculation
    enforce-size.js                Field-size enforcement
    fold-llm.js                    LLM-assisted folding strategy
    fold-statistical.js            Statistical folding and navigation records
    helpers.js                     Shared folding, protection, stub, and hook helpers
    sliding-window.js              Sliding-window folding strategy
  store/
    bounded-recall.js              Bounded, cursor-based recall implementation
    file.js                        JSONL transcript, checkpoint, and state store
    memory.js                      In-process transcript, checkpoint, and state store
  config/
    api-key.js                     API-key materialization
    env.js                         Environment-backed model configuration
    json-file.js                   JSON-file model configuration
    static.js                      Static model configuration
  reflection/
    governor.js                    Deterministic round governance
    judge.js                       Objective timeline and judge prompt/response parsing
    l0.js                          Objective facts and summary parsing
    wrapup.js                      Wrap-up protocol parsing and normalization
  tools/
    file-tools.js                  File tool implementations
    index.js                       Optional tools subpath exports
    jail.js                        Optional path-jail helper
    providers.js                   Tool-provider adapters
    recall.js                      Optional recall tool adapter
    registry.js                    Tool schemas and executor registry
```

`src/index.js` exports the providers, canonical message conversions, token
and compaction helpers, transcript stores, run-state helpers, configuration
providers, `runToolLoop`, and reflection helpers. The optional
`erix-agent/tools` subpath exports the tool helpers listed above.

## Engineering constraints

- Zero runtime npm dependencies, pure ESM, Node 22+, and no build step.
- Tests use `node --test`; type information is expressed with JSDoc typedefs.
- The package is published as `erix-agent` on npm and hosted at
  `ErixWong/erix-agent` on GitHub.
- Never commit tokens, API keys, or other credentials.

The published package currently has version `0.5.1` in `package.json`. Its
declared `files` are:

```json
["src", "bin", "skills", "README.md", "CHANGELOG.md",
 "docs/host-consumer-contract.md", "test/contract", "LICENSE"]
```

Its public `exports` are:

```json
{
  ".": "./src/index.js",
  "./tools": "./src/tools/index.js",
  "./contract-tests": "./test/contract/index.js"
}
```

## `runToolLoop` API

The core entry point is:

```js
runToolLoop({ provider, executeTool, ...options })
```

It owns one task lifecycle and returns `finalText`, the current `messages`
and `transcript`, `rounds`, `truncated`, `termination`, `verification`,
optional `runState`, aggregate `usage`, and `compactionStats`.

### Completion, retries, and termination

- `completion` defaults to `{ signals: [], maxNoToolRounds: 3 }`. When
  enabled, completion signals and consecutive no-tool rounds can stop a
  task. `completion: false` disables that completion layer.
- `retry` defaults to `false`. An object enables retries for provider errors
  classified as retryable; with `retry: {}` the default is two retries after
  the initial attempt. `backoffBaseMs` defaults to `1500` and
  `backoffMaxMs` to `10000`.
- `maxRounds` defaults to `8` in the library. The CLI supplies its own
  command-specific defaults.
- `maxTokenContinuations` defaults to `3`. A response ending in
  `max_tokens` can be continued up to that many times; exhaustion produces
  `termination.reason === "continuation_exhausted"`.
- `stallDetection` defaults to `{ window: 4 }`. The default mode is
  `appear`, which detects a repeated tool signature anywhere in the window;
  `mode: "consecutive"` requires the whole window to match. Pass
  `stallDetection: false` to disable it.
- `resume` defaults to `false`. With a `store` and `runId`, `resume: true`
  restores the transcript, run state, latest checkpoint, and all pending
  tool calls that still need execution. Checkpoint stores with both a writer
  (`saveCheckpoint` or `appendCheckpoint`) and `loadLatestCheckpoint` fail
  closed when a pre-execution or post-execution checkpoint cannot be
  persisted. The host's `executeTool` must still be idempotent by tool id;
  the loop cannot guarantee exactly-once external side effects.

The normal termination vocabulary is:

```text
end_turn
no_tool
stall
max_rounds_cap
reflection_stop
judge_done
continuation_exhausted
final_guard_unverified
aborted
failed
```

`aborted` and `failed` are also attached to thrown errors when the loop
cannot return a normal result.

### Final guard and wrap-up

- `finalGuard` is optional. Before a normal stop (`end_turn`, `no_tool`,
  `judge_done`, completion, or a non-continuable cap), it receives
  `{ finalText, messages, round, rounds, signal, termination }`.
  It can return `{ action: "accept" }`, `{ action: "skip", reason }`, or
  `{ action: "revise", message }`.
- `finalGuardMaxRetries` defaults to `2`; `finalGuardTimeoutMs` defaults to
  `30000`. A revise decision injects the returned `message` as a user
  message and continues while retries remain. A revise decision on a
  non-continuable stop, or after retries are exhausted, returns
  `termination.reason === "final_guard_unverified"` with
  `verification.status === "unverified"`. A guard error or an explicit skip
  keeps the original termination reason.
  Guard errors and timeouts are reported as `verification.status ===
  "error"` and fail open for availability, but the text is not verified.
  Without a guard, verification is `skipped` with reason `no_final_guard`.
- `wrapup` defaults to `true`. With it enabled, the loop can interpret the
  top-level JSON protocol
  `{"done":true,"summary":"...","output":"..."}` at `end_turn`. Passing
  `wrapup: false`, or setting `ERIX_NO_WRAPUP_INSTRUCTION=1`, disables the
  instruction, JSON parsing, `finalText` replacement, and LLM
  normalization together.

Only `verification.status === "verified"` means that a final text passed a
guard. `skipped` means that no verification was performed or no comparable
capture existed; it is not a positive correctness result.

### Reflection and judge governance

When `reflection` is omitted, the library enables the basic judge
automatically for `maxRounds >= 16`, unless `ERIX_NO_REFLECTION=1` is set.
Pass `reflection: false` to disable it. The CLI has separate defaults:
`chat` enables reflection at `max-rounds >= 32`, while `repl` explicitly
passes `reflection: false`. `ERIX_NO_ROUND_JUDGE=1` disables round judging
without disabling transparent interception.

The object form accepts:

```text
enabled
roundJudge
judgeIntercept
judgeIntervalRound
judgeInterceptTimeoutMs
judgeFailureLimit
triggerRound
extensionStep
maxExtensions
maxRoundsCap
format
wrapupNormalize
judge: { provider, evaluator }
onReflection
```

The defaults used by the loop are:

- `roundJudge` and `judgeIntercept` are enabled when reflection is enabled.
- `judgeFailureLimit` defaults to `3`; repeated round-judge failures then
  disable round judging for the remainder of the run.
- `judgeIntervalRound` is `5`; after that many real tool executions, the
  next tool call is independently audited before execution.
- `judgeInterceptTimeoutMs` is `30000`; an interception timeout or judge
  failure degrades to executing the original tool.
- `triggerRound` defaults to 80% of the initial `maxRounds`.
- `extensionStep` defaults to `32`, `maxExtensions` to `2`, and
  `maxRoundsCap` to at least the initial `maxRounds` and otherwise `256`.
- A round judge can stop only with `done: true` and `confidence >= 0.7`.
  A `done: false` decision injects a continuation/nudge; `direction:
  "off_track"` is a soft direction hint and does not itself block a tool.
- Wrap-up LLM normalization is off by default; enable
  `wrapupNormalize: true` or `ERIX_WRAPUP_NORMALIZE=1`.

`onJudge` receives round and interception decisions, including `judge_done`,
`nudge`, `continue`, `executed`, `blocked`, and `degraded` actions. The loop
does not treat a judge as a host-level completion certificate; hosts still
decide whether to consume the result.

### Tools, context, stores, and compaction

- `executeTool` supports positional `(name, input)` and structured
  `({ id, name, input, context, signal })` forms. A structured executor can
  return `{ success, data, duration, toolMessageId }`; the loop preserves
  the returned metadata alongside the canonical `tool_result`.
- `context` is optional and defaults to `undefined`; when supplied, it
  accepts `strategy`, `budgetTokens`, `keepRounds`, `toolContext`, and
  `task`. When `budgetTokens` is absent, the loop derives it from
  `contextWindowTokens` and `maxOutputTokens` found in `modelConfig`,
  `modelMetadata`, `model`, `provider`, or `context`. Compaction keeps six
  rounds by default when a strategy is active. A task brief takes precedence
  in this order: explicit `task`, `context.task`, then the last user message
  in the entry transcript.
- Compaction supports `summaryRole`, `recoveryHint`, `protectedMessage`,
  `stripHistoricalImages`, `onBeforeFold`, `onAfterFold`, and `stubFor`.
  Protected messages can be downgraded if the protected set itself cannot
  fit the budget; the result records `compactionStats[].protectedDowngraded`.
  A single protected message that cannot fit produces `invalid_budget`.
- A `stubFor(message)` hook can retain a bounded, non-secret stub for folded
  `replayable: false` tool results. The CLI's capture stub is limited to
  200 characters and at most three safe `label=value` facts. Fold navigation
  records are address-only records of the form
  `{ roundFrom, roundTo, artifacts: [{ id, locator, digest, status }] }`,
  bounded to at most 10 artifacts and 400 characters. They are not semantic
  search or provenance proof.
- `writeToolNames` defaults to `["writeFile"]`; custom write tools must be
  named explicitly. `writeToolPathKeys` defaults to `["path", "file_path"]`.
  The judge's `filesWritten` footprint does not infer arbitrary write tools
  from their names.
- `TranscriptStore` implementations provide idempotent `appendRound` plus
  optional checkpoint and run-state persistence. The object form of
  `store.recall()` supports `fromRound`, `toRound`, `pattern`, `artifactRef`,
  `limit`, `cursor`, and `maxBytes`, returning `{ text, truncated,
  nextCursor?, status }`. It is bounded exact retrieval, not semantic
  search, completion proof, or provenance verification. `cursor` is bound
  to its run, range, filter, limits, and source version; mismatch is
  rejected rather than silently restarting. `limit: 0` and `maxBytes: 0`
  are rejected. File stores report an oversized source record as
  `status: "truncated"` with `error.code === "record_too_large"`.
  Legacy positional recall remains available and returns a string.
- `runState` is deterministic, bounded, and replace-injected at compaction
  points. Stores can implement `markRunState`,
  `saveRunState`/`loadRunState`, `saveCheckpoint`/`appendCheckpoint`, and
  `loadLatestCheckpoint`. Persisted run state has a 64 KiB serialized hard
  limit plus entry and field limits; truncation is visible through
  `bounds.truncated`. `todoStateProvider` and `semanticStateProvider` are
  host-injected; semantic state is bounded and versioned, and stale versions
  are marked `stale`. Invalid or corrupted state is reported as
  `state_unavailable` on resume rather than silently treated as a fresh
  state.
- Provider-specific details remain explicit: `transport` is passed through to
  fetch as a `dispatcher` (or can enhance fetch options), malformed OpenAI
  tool arguments are exposed as `_truncatedArguments` with `_raw` as a
  compatibility alias, and unsafe run IDs map to
  `run-h-<sha256 first 24 hex characters>`.

### Callbacks and events

The loop callbacks are:

```text
onRound
onJudge
onToolResult
onPersistenceError
onObserverError
onDelta
onReasoningDelta
onToolCall
onUsage
onEvent
```

Streaming observers (`onDelta`, `onReasoningDelta`, `onToolCall`, and
`onUsage`) report through `onObserverError` when an observer throws.
Persistence failures use `onPersistenceError`. `onEvent` receives structured
events including `round_start`, `round_end`, `tool_use`, `tool_result`,
`attempt`, `recovering`, `recovered`, `delta`, `reasoning_delta`, `tool_call`,
`usage`, `forced_final`, and `final_guard`.

## CLI: `erix`

`erix` is the repository's validation/debugging front end. It is not the
headless runtime's product interface.

### Commands and flags

```text
erix --version, -v
erix --help, -h
erix chat "<prompt>" [--stream] [--reflection <on|off>] [--final-guard|--no-final-guard] [--no-notes] [--timeout <ms>] [--config <path>] [--skills-dir <path>] [--session <id>] [--dir <path>] [--compact-budget <tokens>] [--max-rounds <n>] [--idle-timeout <seconds>] [--judge-log <path>]
erix repl [--config <path>] [--skills-dir <path>] [--session <id>] [--dir <path>] [--compact-budget <tokens>] [--max-rounds <n>] [--idle-timeout <seconds>] [--final-guard|--no-final-guard]
erix skills [--skills-dir <path>]
erix mcp [--config <path>]
```

Running `erix` with no arguments enters `repl`. The `chat` flags are
implemented by `bin/cli.js`; the `repl` flags above are implemented by
`bin/repl.js`. In particular, `repl` does not implement `--stream`,
`--reflection`, `--timeout`, `--no-notes`, or `--judge-log`.

`chat` defaults to 64 rounds, a 300-second idle timeout, reflection enabled
when `max-rounds >= 32`, and the final guard disabled. `repl` defaults to
32 rounds, no idle timeout, `reflection: false`, and completion after one
no-tool round. The CLI help text in `bin/repl.js` still labels its default as
16; the executable constant and `runToolLoop` call use 32.

The shared CLI flags are:

- `--stream` streams model text in `chat`.
- `--session <id>` selects the session; without an explicit chat session,
  `chat` creates a unique ID derived from the working directory.
- `--dir <path>` selects the transcript directory; the `chat` default is
  `~/.erix/transcripts`.
- `--max-rounds <n>` sets the tool-loop round limit.
- `--reflection <on|off>` selects chat reflection behavior.
- `--final-guard` enables the CLI provenance guard;
  `--no-final-guard` is a compatibility no-op because the default is already
  off.
- `--no-notes` removes only the `notes` skill and leaves other skills loaded.
- `--timeout <ms>` supplies a soft task deadline to `chat`; it nudges the
  loop toward wrap-up rather than hard-killing the process.
- `--idle-timeout <seconds>` aborts after no progress; it defaults to 300
  for `chat` and 0 (disabled) for `repl`.
- `--compact-budget <tokens>` overrides the automatic compaction budget.
- `--judge-log <path>` appends redacted round/interception judge decisions
  as JSONL in `chat`.

The built-in CLI tools are `readFile`, `rg`, `tree`, `writeFile`, and `exec`.
They operate on arbitrary paths and commands. When an archive directory is
configured, outputs longer than 800 characters and every `exec` result are
written to:

```text
<transcriptDir>/outputs/<safeRunId>/<sequence>-<toolName>.txt
```

Each archive has a `.meta.json` sidecar with `digest`, `locator`, replayability
metadata, and `status` (`ok` or `truncated`). A single archive is capped at
1 MiB. Existing sequence numbers are scanned and concurrent collisions are
advanced safely. The tool result points to the absolute archive path; read
that archive with `readFile` or `cat` instead of rerunning a command.

For a normalized repeated `exec` command, the CLI still executes the command.
It adds `rerunOf` metadata pointing to the first round, artifact, digest,
locator, and artifact status (`ok`, `truncated`, `missing`, `stale`, or
`unrecoverable`). This is an audit notice, not an effect rollback,
correctness guarantee, or protection against payment, deletion, publication,
write, or external API side effects.

The bundled self-describing `notes` skill provides `note_take`, `note_read`,
`note_list`, and `note_forget`. It is a run-scoped, pull-only convenience
index for facts, one-time values, decisions, and artifact references; it is
not a per-round log and it does not replace the capture manifest used by the
provenance guard. The bundled skill is loaded from `skills/notes/`; user and
project skills can be supplied from `~/.erix/skills/`, the project
`.erix/skills/`, or `--skills-dir <path>`. `erix skills` lists discovered
skills.

MCP uses standard `.mcp.json` configuration and supports both stdio and HTTP
servers. The `mcp` proxy exposes `list`, `search`, `call`, and `status`
actions. `erix mcp` lists configured servers and their connection status.

### Configuration and local state

The CLI reads model configuration from
`$XDG_CONFIG_HOME/erix/config.json` or `~/.erix/config.json`; `--config
<path>` overrides that location, and environment variables take precedence.
The required model inputs are `LLM_KIT_ENDPOINT`, `LLM_KIT_API_KEY`, and a
model from `LLM_KIT_MODEL`, `ERIX_DEFAULT_MODEL`, or
`slots.default.model`. `slots.default.maxOutputTokens` defaults to `16384`;
`slots.default.contextWindowTokens` enables automatic compaction, and
`--compact-budget` overrides its computed budget.

MCP configuration is read from the current directory's `.mcp.json` or
`~/.erix/mcp.json`. The main local layout is:

```text
~/.erix/
  config.json
  mcp.json
  transcripts/
    <safeRunId>.jsonl
    <safeRunId>.checkpoint.json
    <safeRunId>.state.json
  <session>.json                 REPL session snapshot
  notes/run/<safeRunId>/         notes skill data
  skills/                        user skills
  todos/                         used by the example todo skill
```

`ERIX_NOTES_DIR` changes the notes root. Both CLI modes honor
`ERIX_EXEC_TIMEOUT_MS` and `ERIX_FINAL_GUARD`; `chat` additionally honors
`ERIX_NO_TOOL_ROUNDS`, `ERIX_MAX_ROUNDS`, `ERIX_REFLECTION`,
`ERIX_NO_REFLECTION`, `ERIX_NO_NOTES`, and `ERIX_JUDGE_LOG`. The
library-level controls
`ERIX_NO_WRAPUP_INSTRUCTION`, `ERIX_NO_FORCED_FINAL`, and
`ERIX_STALL_MODE` are also honored by the relevant loop behavior;
`ERIX_WRAPUP_NORMALIZE=1` enables wrap-up LLM normalization.

## Documentation

- [docs/requirements.md](docs/requirements.md) - requirements and stages
- [docs/architecture.md](docs/architecture.md) - API contracts and data flow
- [docs/decisions/](docs/decisions/) - design decisions, including
  configuration, storage, compaction, reflection, tools, skills, safety,
  judge direction, engine/model/host boundaries, and guard policy
- [docs/testing.md](docs/testing.md) - test strategy and behavior metrics
- [docs/host-consumer-contract.md](docs/host-consumer-contract.md) - host
  consumer contract for verification, bounded recall, provenance, and reruns
- [docs/host-upgrade-guide-v030.md](docs/host-upgrade-guide-v030.md) - host
  upgrade guidance for `touwaka` / `app_container` and v0.3.x behavior
- [docs/maintenance-policy.md](docs/maintenance-policy.md) - maintenance
  policy and internal replacement/stop-loss criteria
- [docs/research/](docs/research/) - research reports (Chinese only)
- [docs/design/](docs/design/) - design and RFC material (Chinese only)
- [docs/tasks/](docs/tasks/) - active task documents (Chinese only)

The bounded recall design note is
[docs/design/2026-09-14-bounded-recall-api.md](docs/design/2026-09-14-bounded-recall-api.md)
(Chinese only).

## Status and version history

The current package version is **v0.5.1**, dated 2026-09-15 according to
`package.json` and `CHANGELOG.md`.

- **v0.5.1 (2026-09-15)**: fixes repeated accumulation of fold summaries,
  navigation records, stubs, `[本 run 状态]`, and run state by recognizing
  and replacing the fold marker; adds end-to-end Memento scenario coverage
  for folded truth, credential-safe stubs, reruns, repeated folding, and
  bounded recall.
- **v0.5.0 (2026-09-15)**: makes the CLI provenance guard opt-in;
  normalized reruns execute and report `rerunOf` instead of being blocked;
  adds object-form bounded recall, cursor and source binding, replayability
  provenance, bounded fold navigation and stubs, deterministic run state,
  host-injected `todoStateProvider`/`semanticStateProvider`, and forced-final
  handling.
- **v0.4.0 (2026-09-14)**: adds the run-scoped notes skill, tool-output
  archives and provenance capture. Notes use `current` plus at most three
  `superseded` values and visible `folded` counts; the old notes ledger,
  version chain, and related environment variables were removed. The
  provenance guard compares capture manifests rather than trusting notes.
- **v0.3.5 (2026-09-12)**: the broad compatibility and persistence repair
  batch, including real-time streaming callbacks, fail-closed post-tool
  checkpoint persistence, complete pending-tool resume, provider SSE and
  legacy `function_call` compatibility, safer file-store IDs, REPL
  persistence, MCP cleanup, input validation, and `onObserverError`.
- **v0.3.4 (2026-09-07)**: task-brief selection for multi-turn hosts was
  corrected. Explicit `task` and `context.task` take precedence, followed
  by the last entry user message; resume does not use untrusted historical
  task seeds.
- **v0.3.3 (2026-09-06)**: `wrapup: false` disables the whole wrap-up
  instruction/parsing/replacement/normalization protocol, with stricter
  top-level `done` validation.
- **v0.3.2 (2026-09-06)**: MIT licensing and README restructuring; no
  runtime feature change.
- **v0.3.0 (2026-09-06)**: judge governance became available: transparent
  tool interception, round judge, direction hints, stall correction, and
  `onJudge` / `--judge-log` observability. Reflection defaults to enabled in
  the library for `maxRounds >= 16` when omitted.
- **v0.2.0 (2026-09-01)**: dual-protocol streaming, full tool loops,
  automatic budget-driven folding, file stores and recall, JSON-file
  configuration, the interactive CLI, persistence, self-describing skills,
  built-in CLI tools, streaming output, MCP stdio/HTTP integration, and
  idle timeouts.

The host migration and benchmark work described by the project is ongoing
integration work, not a promise that a future host or sandbox component is
already released in this package.

## Release validation

The repository's release process uses real relay E2E tests when
`LLM_KIT_E2E=1`:

```bash
LLM_KIT_E2E=1 node --test examples/*.test.mjs
```

The tests require a configured model. The model is resolved from
`slots.default.model`, `LLM_KIT_MODEL`, or `ERIX_DEFAULT_MODEL`; an absent
configuration fails instead of silently selecting another model. The release
record should identify the actual model used.

The notes experiment scripts likewise take the model from `--model`,
`ERIX_EXPERIMENT_MODEL`, or `--config`/`~/.erix/config.json` in that order.
They provide a cost preview, default to dry-run without `--yes`, default to
`--max-calls 40`, and stop immediately on a failed model call rather than
switching models.

## Benchmark validation (erix-bench / Terminal-Bench archive)

The project reports headless harness results for Terminal-Bench archive tasks
using a container driver and the official grader, with `--agent erix|pi`
comparisons. The full per-run report is maintained in the companion
erix-bench repository; the figures below are the README's recorded results,
not a claim that this repository runs those tasks automatically.

### Passing tasks (reward=1, by model)

`historical-model` has **34 passing tasks** across a broad task set:

```text
bn-fit-modify
break-filter-js-from-html
build-cython-ext
build-pmars
cancel-async-tasks
cobol-modernization
configure-git-webserver
constraints-scheduling
count-dataset-tokens
crack-7z-hash
custom-memory-heap-crash
extract-elf
financial-document-processor
fix-git
git-leak-recovery
git-multibranch
hf-model-inference
kv-store-grpc
log-summary-date-ranges
merge-diff-arc-agi-task
modernize-scientific-stack
mteb-retrieve
multi-source-data-merger
openssl-selfsigned-cert
polyglot-c-py
portfolio-optimization
prove-plus-comm
pypi-server
regex-log
reshard-c4-data
sam-cell-seg
sqlite-db-truncate
torch-tensor-parallelism
vulnerable-secret
```

`historical-model-2` has **11 passing tasks** in the more recent difficult-task
sample:

```text
adaptive-rejection-sampler
break-filter-js-from-html
build-cython-ext
build-pov-ray
cancel-async-tasks
chess-best-move
code-from-image
configure-git-webserver
db-wal-recovery
fix-code-vulnerability
password-recovery
```

The `pi` comparison on the `historical-model-2` sample has **4 passing
tasks**:

```text
break-filter-js-from-html
build-cython-ext
build-pov-ray
distribution-search
```

The two `historical-model` totals are not directly comparable: the first has
more runs and a broader task mix, while the second emphasizes difficult and
recovery tasks.

### Transparent interception and judge evidence

The recorded 2026-09 evidence for `erix main + PR #28/#29` describes
long-running headless tasks under transparent interception, round judge,
stall correction, and direction hints. Judge decisions were written to
`erix-state/judge.log` for audit:

| Task | Result | Reported judge evidence |
|---|---|---|
| db-wal-recovery | reward=1 (88s; historical 721s failure) | `direction: off_track` interception redirected a reconnaissance-only route toward repair |
| adaptive-rejection-sampler | reward=1 (12 rounds; historical 901s timeout) | Early judge interception prevented environment spinning |
| password-recovery | reward=1 (187s, flash first run) | **5 blocked** decisions stopped repeated partial submissions without the complete password |
| fix-code-vulnerability | reward=1 (123s, grader 6/6) | Round judge allowed wrap-up only after a positive completion assessment |
| cancel-async-tasks | reward=1 (117s) | Judge logging and transparent approval observed an on-track route |
| circuit-fibsqrt | reward=0 (64 complete rounds) | 11 real interception records; the report attributes the failure to model capability rather than the mechanism |

These benchmark figures are historical project evidence and are not an API
guarantee. The judge design decision is documented in
[ADR-011](docs/decisions/011-judge-direction.md).

## License

MIT © 2026 ErixWong (see [LICENSE](LICENSE)).
