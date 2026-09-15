# Testing — erix-agent

> Chinese version: [testing_cn.md](testing_cn.md)

The test suite is dependency-free: it uses `node:test` and `node:assert/strict`, mocks `fetch` at the protocol boundary, and uses a fake provider for loop orchestration. Real LLM calls are limited to optional example E2E tests. The project has no browser UI, so it does not require Playwright or vision tooling.

## 0. Test layers and infrastructure

### Layers

| Layer | Command | Scope | When to run |
|---|---|---|---|
| Unit and local integration tests | `npm test` (`node --test`) | The repository test tree; no external LLM or network service is required | Before every commit; the suite must be green |
| Syntax check | `npm run check` (`node --check src/index.js`) | The command currently configured by the `check` script | As an engineering sanity check |
| One test file | `node --test test/loop.test.js` | Replace the path with any individual test file when focusing on one area | During focused development |
| Optional real-relay E2E | `LLM_KIT_E2E=1 node --test examples/*.test.mjs` | `examples/exec-demo.test.mjs`, `examples/memory-benchmark.test.mjs`, and `examples/provenance-repro.test.mjs`; these are skipped unless `LLM_KIT_E2E=1` is set | Manual milestone or release validation |

The package defines the `./contract-tests` export as `./test/contract/index.js`. Contract tests are reusable `node:test` registrations for consumer-provided adapters; they are not a separate command in `package.json`. A consumer adapter test imports the public entry point and invokes the relevant contract:

```js
import { transcriptStoreContract, modelConfigProviderContract } from "erix-agent/contract-tests";
transcriptStoreContract("mariadb", () => createMariaTranscriptStore(...));
modelConfigProviderContract("mariadb", async () => ({ provider, slot, expect }));
```

### Test infrastructure

1. **Mock fetch** (`test/helpers/mock-fetch.js`) provides a programmable `fetchImpl`. It records request URLs, methods, headers, and parsed bodies, then returns scripted JSON, text, byte, or streaming responses, or throws a scripted error. Protocol adapter tests use it instead of the network.
2. **Fake provider** (`test/helpers/fake-provider.js`) is an in-memory `LlmProvider`-shaped provider. It records requests, returns scripted text and `tool_use` content, supports repeated script steps, and can throw a scripted error. Loop tests use it directly because they exercise orchestration rather than HTTP.
3. **Canonical round fixtures** (`test/fixtures/rounds-fixtures.mjs`) provide representative text-only, single-tool, multiple-tool, and mixed multi-round conversations for message conversion and compaction tests.
4. **Local MCP fixtures** live in the repository-root `fixtures/` directory: `fixtures/mock-mcp-server.mjs` and `fixtures/mock-mcp-http-server.mjs`. They are executable stdio and HTTP servers used by `test/mcp.test.js`. Keep these servers outside `test/`: `node --test` discovers files under the test tree, and executing a long-lived fixture server as a test file can hang the test run. The data fixture under `test/fixtures/` is imported by tests and is not a server entry point.
5. **Contract helpers** (`test/contract/index.js`, `test/contract/transcript-store.js`, and `test/contract/model-config-provider.js`) define the shared transcript-store and model-config-provider assertions. The built-in memory/file stores and config providers register these contracts from their own tests.

The complete tracked `test/` tree is:

```text
test/
├── app-container-p0.test.js
├── cli.test.js
├── codewrite.test.js
├── config.test.js
├── governor.test.js
├── judge.test.js
├── loop-final-guard.test.js
├── loop-fr2.test.js
├── loop-resume.test.js
├── loop-stream.test.js
├── loop-termination.test.js
├── loop-v020-beta.test.js
├── loop-v020-rc.test.js
├── loop-v020.test.js
├── loop.test.js
├── mcp.test.js
├── notes-autocapture.test.js
├── notes-experiment.test.js
├── notes-final-guard.test.js
├── notes.test.js
├── reflection.test.js
├── repl.test.js
├── run-state.test.js
├── skills.test.js
├── tokens.test.js
├── tools.test.js
├── wrapup.test.js
├── compact/
│   ├── budget.test.js
│   ├── enforce-size.test.js
│   ├── fold-llm.test.js
│   ├── fold-statistical.test.js
│   ├── sliding-window.test.js
│   └── v020-rc.test.js
├── config/
│   ├── api-key.test.js
│   ├── env.test.js
│   ├── json-file.test.js
│   └── static.test.js
├── contract/
│   ├── index.js
│   ├── model-config-provider.js
│   └── transcript-store.js
├── fixtures/
│   └── rounds-fixtures.mjs
├── helpers/
│   ├── fake-provider.js
│   └── mock-fetch.js
├── integration/
│   └── memento-scenario.test.js
├── messages/
│   ├── anthropic.test.js
│   ├── canonical.test.js
│   ├── rounds.test.js
│   └── v020-alpha.test.js
├── providers/
│   ├── anthropic.test.js
│   ├── openai-stream.test.js
│   ├── openai.test.js
│   ├── v020-alpha.test.js
│   ├── v020-beta.test.js
│   └── v020-rc.test.js
├── store/
│   ├── file.test.js
│   ├── memory.test.js
│   └── v020-rc.test.js
└── tools/
    ├── file-tools.test.js
    ├── jail.test.js
    ├── providers.test.js
    ├── recall.test.js
    └── registry.test.js
```

## 1. v0.0 (MVP) — the basic path works

The original MVP coverage is still represented by these tests:

| Area | Files | Coverage |
|---|---|---|
| Providers and errors | `test/providers/openai.test.js`, `test/app-container-p0.test.js` | OpenAI request/response mapping, tool calls, endpoint normalization, configuration validation, error classification, abort behavior, and the basic Anthropic/loop path |
| Canonical messages | `test/messages/canonical.test.js` | Canonical conversion, tool-result ordering, tool schemas, legacy function calls, invalid response diagnostics, and raw protocol fields |
| Token estimates | `test/tokens.test.js` | CJK and non-CJK estimates, safety margins, configurable coefficients, message/block costs, and tool identifiers |
| Tool loop | `test/loop.test.js` | Text completion, tool-result feedback, `maxRounds`, stall nudges and termination, tool errors, `onToolResult`, round snapshots, and usage accumulation |
| Memory transcript store | `test/store/memory.test.js` | Memory-store behavior plus the reusable transcript-store contract |

The example E2E coverage is no longer a single `node examples/exec-demo.test.mjs` invocation. The current optional set is the `examples/*.test.mjs` command in the layer table above. `examples/exec-demo.test.mjs` still checks a real multi-round tool task and compaction behavior; the other two example files cover memory benchmarking and provenance reproducibility. The demo's `exec` tool remains allowlisted and time-limited to demonstrate the caller's security responsibility.

## 2. v0.1 (full FR-1/FR-2 and first compaction strategies) — behavior is correct

| Area | Files | Coverage |
|---|---|---|
| Anthropic and OpenAI protocol paths | `test/providers/anthropic.test.js`, `test/providers/openai-stream.test.js`, `test/messages/anthropic.test.js`, `test/messages/rounds.test.js` | Non-streaming and SSE conversion, streamed text and tool-call assembly, usage, malformed streamed input, error classification, protected message heads, tool pairing, and validation errors |
| Loop retries and completion | `test/loop-fr2.test.js`, `test/loop-stream.test.js`, `test/loop-termination.test.js` | Retryable versus non-retryable errors, original-message retries, capped backoff, completion signals, no-tool completion, `max_tokens` continuation, adjacent-assistant merging, streaming observers, streaming retries, fallback to `chat`, and termination reasons |
| Budget and compaction | `test/compact/budget.test.js`, `test/compact/sliding-window.test.js`, `test/compact/fold-statistical.test.js`, `test/compact/enforce-size.test.js` | Budget calculation, whole-round sliding windows, deterministic statistical folding, bounded navigation and recovery stubs, protected heads, and deterministic field-priority size enforcement |
| Model configuration | `test/config/static.test.js`, `test/config/env.test.js`, `test/config/api-key.test.js` | Static and environment-backed providers, numeric and boolean parsing, invalid configuration errors, and direct/environment/file API-key precedence |

The migration acceptance criterion remains external to this repository: after `app_container` completes its `runToolLoop` migration, its own `npm test` must be green. The repository tests cover the library behavior; they do not claim to measure the separate 24-round application comparison.

## 3. v0.2 (persistence, resume, LLM folding, tools, and CLI surfaces) — survives interruption and remains recoverable

| Area | Files | Coverage |
|---|---|---|
| Versioned provider/message regressions | `test/providers/v020-alpha.test.js`, `test/providers/v020-beta.test.js`, `test/providers/v020-rc.test.js`, `test/messages/v020-alpha.test.js` | Optional provider payloads, reasoning and image blocks, provider options, streamed reasoning/tool events, timeout phases, retry classification, transport forwarding, and Anthropic system summaries |
| Versioned loop regressions | `test/loop-v020.test.js`, `test/loop-v020-beta.test.js`, `test/loop-v020-rc.test.js` | Message revalidation, continuation compaction, snapshot retry, structured tool execution, completion defaults, compaction budgets, checkpoint behavior, and persistence failure handling |
| Resume and run state | `test/loop-resume.test.js`, `test/run-state.test.js` | Resuming without replaying paid provider calls or executed tools, partial tool results, folded checkpoints, bounded/redacted run state, schema availability, idempotent replacement, and persisted tool facts |
| Stores and compaction | `test/store/file.test.js`, `test/store/v020-rc.test.js`, `test/compact/fold-llm.test.js`, `test/compact/v020-rc.test.js` | JSONL append/load, malformed-tail and crash-safe handling, atomic state writes, deduplication, bounded recall cursors, injected LLM summarizers, size enforcement, protected rounds, global round offsets, and image cleanup |
| Configuration | `test/config/json-file.test.js`, `test/config.test.js` | JSON-file slots, API-key materialization, default-slot fallback, CLI config paths, environment overrides, context-window parsing, and compaction-context construction |
| Tools | `test/tools/file-tools.test.js`, `test/tools/jail.test.js`, `test/tools/providers.test.js`, `test/tools/recall.test.js`, `test/tools/registry.test.js`, `test/tools.test.js` | Jail boundaries and symlink handling, file operations, tool-provider composition, recall and folded payloads, schema intersection and input validation, CLI tool execution, archiving, replayability, redaction, and output limits |
| CLI, REPL, MCP, and skills | `test/cli.test.js`, `test/repl.test.js`, `test/mcp.test.js`, `test/skills.test.js`, `test/codewrite.test.js` | CLI/repl argument and session handling, MCP stdio and HTTP fixtures, tool discovery/calls/errors, skill discovery/loading/conflicts, and the CLI code-writing tools |

The repository also has a scenario-level test in `test/integration/memento-scenario.test.js`. It exercises folding, non-replayable values, credential exclusion, archive pointers, repeated folds, and byte-for-byte bounded recall across the loop, tools, compaction, and memory store.

## 4. v0.3 and current behavior — no regressions in judging, reflection, notes, and recovery

The later/current suite is represented by:

| Area | Files | Coverage |
|---|---|---|
| Judge and governor | `test/judge.test.js`, `test/governor.test.js` | Round and tool-use judging, transparent interception, direction hints, degraded judge behavior, progress/error governance, reflection requests, wrap-up nudges, and observable judge decisions |
| Reflection and final verification | `test/reflection.test.js`, `test/wrapup.test.js`, `test/loop-final-guard.test.js` | Reflection decisions, wrap-up parsing and loop behavior, final-guard acceptance/revision, provenance, retry limits, timeout/error reporting, and fail-closed verification |
| Notes and capture | `test/notes.test.js`, `test/notes-autocapture.test.js`, `test/notes-final-guard.test.js`, `test/notes-experiment.test.js` | Note lifecycle and scoping, provenance, credential filtering, automatic capture and archival, final-guard integration, experiment planning/cost gates, usage summaries, and reproducibility reporting |

These files are current product-surface tests rather than a new replacement for the version-tagged regression files above; `npm test` runs them together.

## 5. v1.0 (consumer migration and compatibility)

The consumer-side migration of pure functions and application behavior remains an external acceptance activity. `app_container` and `touwaka` should run their own migrated tests and compare compaction boundaries and summary output for shared conversation fixtures; those consumer-project tests are not part of this repository's `test/` tree.

The reusable repository-side compatibility layer is the contract suite in `test/contract/`. It is exported through `./contract-tests` as `./test/contract/index.js`, so a MariaDB, PostgreSQL, or other adapter can register the same transcript-store and model-config-provider assertions. The built-in memory/file stores and config providers use the same helpers in their tests. Adapter-specific connection management, cleanup, and crash recovery remain adapter tests rather than contract assertions. See §0 for the import and registration example.

## 6. Cross-cutting conventions

- **Unit tests do not call external services.** Protocol tests use `test/helpers/mock-fetch.js`; loop tests use `test/helpers/fake-provider.js`. MCP coverage uses the local servers in the repository-root `fixtures/` directory.
- **Use deterministic assertions for deterministic behavior.** Budget calculations, statistical folding, `enforce-size`, run-state rendering, bounded recall, and provenance/redaction behavior are asserted exactly. Do not snapshot inherently variable LLM output.
- **Exercise failure paths deliberately.** Error classification, retryability, aborts, malformed data, persistence failures, stale or tampered cursors, invalid tool input, and fail-closed behavior are part of the suite rather than afterthoughts.
- **Keep test state isolated.** Tests that touch `~/.erix`, `~/.pi`, environment variables, sessions, or MCP configuration inject `home`, `cwd`, temporary directories, or restore the environment so they do not use a real user's configuration.
- **Examples are integration documentation.** The `examples/` programs show caller integration and optional real-relay behavior; keep them readable and run them explicitly with `LLM_KIT_E2E=1`.
- **Node-version scope.** `package.json` declares Node `>=22`. The repository README separately notes that the `app_container` consumer side needs Node 24 for `await using`; the library's own test target remains Node 22+.
- **The library does not provide a browser test layer.** The terminal REPL has direct coverage in `test/repl.test.js`, but browser automation and vision tests are outside the project.
