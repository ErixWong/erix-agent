# Testing — erix-agent

> Chinese version: [testing_cn.md](testing_cn.md)

The test suite is dependency-free: it uses `node:test` and `node:assert/strict`, mocks `fetch` at the protocol boundary, and uses a fake provider for loop orchestration. Real LLM calls are limited to optional example E2E tests. The project has no browser UI, so it does not require Playwright or vision tooling.

## 0. Test layers and infrastructure

### Layers

| Layer | Command | Scope | When to run |
|---|---|---|---|
| Unit and local integration tests | `npm test` (`node --test --test-reporter=tap` — issue #774 pins the reporter in argv so the summary shape never depends on which runner version is asking) | The repository test tree; no external LLM or network service is required | Before every commit; the suite must be green |
| Syntax check | `npm run check` (`node --check src/index.js`) | The command currently configured by the `check` script | As an engineering sanity check |
| One test file | `node --test test/loop.test.js` | Replace the path with any individual test file when focusing on one area | During focused development |
| Optional real-relay E2E | `LLM_KIT_E2E=1 node --test examples/*.test.mjs` | `examples/exec-demo.test.mjs`, `examples/memory-benchmark.test.mjs`, and `examples/provenance-repro.test.mjs`; these are skipped unless `LLM_KIT_E2E=1` is set. The provider slot and model id are resolved from `LLM_KIT_RELAY_PROVIDER`, `LLM_KIT_RELAY_URL`, or `LLM_KIT_MODEL` (or a single-slot `~/.pi/agent/models.json`); neither is hardcoded | Manual milestone or release validation |

The package defines the `./contract-tests` export as `./test/contract/index.js`. Contract tests are reusable `node:test` registrations for consumer-provided adapters; they are not a separate command in `package.json`. A consumer adapter test imports the public entry point and invokes the relevant contract:

```js
import { transcriptStoreContract, modelConfigProviderContract } from "erix-agent/contract-tests";
transcriptStoreContract("mariadb", () => createMariaTranscriptStore(...));
modelConfigProviderContract("mariadb", async () => ({ provider, slot, expect }), {
  mode: "throws", name: "no-such-slot", available: ["default", "audit"],
});
```

### Test infrastructure

1. **Mock fetch** (`test/helpers/mock-fetch.js`) provides a programmable `fetchImpl`. It records request URLs, methods, headers, and parsed bodies, then returns scripted JSON, text, byte, or streaming responses, or throws a scripted error. Protocol adapter tests use it instead of the network.
2. **Fake provider** (`test/helpers/fake-provider.js`) is an in-memory `LlmProvider`-shaped provider. It records requests, returns scripted text and `tool_use` content, supports repeated script steps, and can throw a scripted error. Loop tests use it directly because they exercise orchestration rather than HTTP.
3. **Canonical round fixtures** (`test/fixtures/rounds-fixtures.mjs`) provide representative text-only, single-tool, multiple-tool, and mixed multi-round conversations for message conversion and compaction tests.
4. **Local MCP fixtures** live in the repository-root `fixtures/` directory: `fixtures/mock-mcp-server.mjs` and `fixtures/mock-mcp-http-server.mjs`. They are executable stdio and HTTP servers used by `test/mcp.test.js`. Keep these servers outside `test/`: `node --test` discovers files under the test tree, and executing a long-lived fixture server as a test file can hang the test run. The data fixture under `test/fixtures/` is imported by tests and is not a server entry point.
5. **Contract helpers** (`test/contract/index.js`, `test/contract/transcript-store.js`, `test/contract/model-config-provider.js`, `test/contract/assembly-port.js`, `test/contract/execute-tool.js`, and `test/contract/notes-store.js`) define the shared assertions for the host ports. The built-in memory/file stores and config providers register these contracts from their own tests.
6. **Temp directory helper** (`test/helpers/tmp.js`) provides `makeTmp(prefix)` (respects `TMPDIR`, creates a missing parent directory, registers `after()` cleanup): every test temporary directory must go through it instead of hardcoding `/tmp`, and when the base directory is not writable the first call fails once with the named error `TMPDIR_NOT_WRITABLE` (machine guard: `npm run check:tests`, i.e. `scripts/test-hygiene-check.mjs`).

   **The guard blocks (issue #209).** `npm run check:tests` fails on any `mkdtemp` call under `test/**` — `mkdtemp(...)`, `fs.mkdtemp(...)` and `mkdtempSync(...)` alike — except inside `test/helpers/tmp.js` itself, and on any `/tmp` literal passed as a first argument. Before #209 only the narrow shape `mkdtemp(join(tmpdir(` was blocking while everything else was printed as a non-blocking hint (and `mkdtempSync` was not even counted, although the comment claimed it was). There is no synchronous `makeTmp`: a test that needs one must either be `async` (`node --test` callbacks may be `async`) or take its directory in a `before()` hook.

   **The guard has its own reverse proof (issue #374).** `node scripts/test-hygiene-check.mjs --self-test` runs the same rule table over an **in-memory fake file set** — nothing is written and `test/` is never touched: `mkdtempSync(...)`, `mkdtemp(...)` and `fs.mkdtemp(...)` must each come back red, `makeTmp(...)` green, an exempted call green while the reason-less `test-hygiene-exempt:` form is red and names the line, `test/helpers/tmp.js` itself uncounted, and a mutation that stops applying fails its case (the #210 R2 convention). CI runs it as its own blocking step beside `npm run check:tests`: the plain scan only proves today's tree is clean, and it stays green when the rule table itself is broken.

   **Exemptions are explicit and per line.** When a call genuinely cannot go through `makeTmp` (for example a directory that must outlive a `before()` hook scope, or one that must stay inside the working directory), put a comment on the call line or on the line directly above it:

   ```js
   // test-hygiene-exempt: 这个目录必须在文件级 after() 里删，makeTmp 的钩子作用域是 before()
   const dir = await mkdtemp(join(tmpdir(), "erix-something-"));
   ```

   A marker without a reason is itself a violation, so an exemption can never silently degrade into a mute switch; the guard prints every exemption it honoured, with its reason.

7. **Suite-summary reconciliation** (`scripts/suite-summary-reconcile.mjs`, issue #301) — `node --test` ends every run with a TAP summary (`# tests` / `# pass` / `# fail` / `# skipped` / `# todo` / `# cancelled`), and that summary used to live only in the log body: nothing read it, so "CI is green" was an adjective with no numbers behind it and a CI-versus-local skip difference had to be counted by hand. The `Test suite` step now tees `npm test` into a file (`set -o pipefail` is part of that step: without it the tee swallows a non-zero `node --test` exit and turns red into green), and the next blocking step, `npm run check:test-summary -- --log <file>`, reconciles the captured summary against `test/test-suite-baseline.json`. It prints one greppable line — `TEST-SUMMARY tests=… pass=… fail=… skipped=… todo=… cancelled=… source=<file>:<line>` — plus `TEST-SUMMARY-EXPECTED` and `TEST-SUMMARY-VERDICT ok|red`, and appends them to `$GITHUB_STEP_SUMMARY` so the numbers are visible on the run page without downloading the log bundle. Three red lines: `tests` must not fall **below** the registered value — a dropped case is the accident, so a run that prints more cases than registered stays green and adds a `TEST-SUMMARY-HINT` line naming the value the registry could be raised to (raising it stays a human action; the script never rewrites the file) — `fail` must equal the registered value (always zero), and `skipped` must not exceed the registered ceiling — skipping **fewer** cases stays green (ratchet direction). A log without a complete summary block (truncated, or not a `node --test` output at all) exits 2 and is never read as "no problem", and since issue #774 a log whose shape the reader recognizes as the **spec** reporter (Node 24's default for `node --test`) gets its own code — `NOT_TAP_LOG`, still exit 2, reported as "undetermined / this log is not TAP": it is neither green nor a regression, because comparing spec numbers against a TAP registry would report a runner-version change as missing test cases; a summary whose own fields do not add up (`pass + fail + cancelled + skipped + todo === tests`) is red instead of being silently accepted.

   **The registered file is an expectation, not a measurement.** The truth is the summary the command prints on that run, and it is environment-dependent: whether the real-upstream gate is open and whether the pi loader is installed both change `skipped`, which is why the ceiling is set to the largest environment measured so far while a machine that skips fewer cases is still green. There is deliberately no `--sync` for this file — the script only reads it: raising the registered value stays a human action, and an automatic copy would launder whichever run happened to print fewer cases into a new baseline, which is exactly the accident this criterion exists to catch. When a number moves, either the suite genuinely gained or lost cases (update `expect.tests` in the same commit and add an `observations` entry naming the commit, the environment and why it differs) or something drifted (fix it). **Never change the tests to match the numbers** — adding `skip`s, deleting cases or weakening assertions into always-true trades coverage for a green light. `observations` entries are historical facts: `--print` shows them, and no criterion judges them.

   **The gate has its own reverse proof.** `npm run check:test-summary -- --self-test` runs the same criteria over synthetic TAP fixtures and synthetic registries (nothing is written, no test is run): a wrong registered value reds and names the delta in both directions, `skipped` above the ceiling reds, a non-zero `fail` reds, a self-contradictory summary reds, a truncated log exits 2, a two-block log is picked correctly (`--pick last` for the tee'd file, `--pick largest` for a whole job log), a mutation that does not apply counts as a failure (the #210 R2 convention), and it checks the CI wiring itself — the `Test suite` step tees to `$RUNNER_TEMP` with `pipefail`, both new steps exist, `check:test-summary` points at this script, and the registry has the required shape — so deleting the wiring is what reds there. It is a separate CI step from the reconciliation on purpose: that one proves today's numbers match the registry, this one proves the criteria still bite. To read the numbers from a finished CI run, download the job log through the Actions API (`GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs`, or `/actions/jobs/{job_id}/logs` for plain text) and pass it with `--pick largest`, because a whole job log contains more than one `node --test` summary.

8. **Release-state probe** (`scripts/version-state-probe.mjs`, `npm run check:version-states`, issue #703) — `docs-drift-check --self-test` simulates "the current version" by rewriting `package.json`, so the three states every release actually passes through (cut but unpublished / published but untagged / fully published) could not be represented there at all, while the blocking CI step *is* that self-test. The probe builds its trees **mechanically** — the tracked list comes from `git ls-files` of the tree named by `--src <dir>`, then a throwaway `git init` plus one commit. The repository's own `.git` cannot be copied: this checkout is a linked worktree whose `.git` is a pointer file, so a copied tree keeps reading the *original* index and refs, which both leaks the real tag face into a tree that is supposed to have no tag and crashes the reader on any file the index gained that the copy does not have. The release state is stamped through the repository's own narrow write surface (`docs-drift-check.mjs --sync`, never a hand edit), the tag face is built per state (annotated tags at the CHANGELOG dates, with the versions registered in `CHANGELOG_DATE_TAG_EXEMPTIONS` shifted by one day so that ledger stays live), and the registry fact reaches the judgement through `--registry-json <file>` (a `{"latest", "versions"}` stub — unreadable is exit 2, never "skipped"; `check:docs` in CI passes nothing, so the production reading is unchanged), while the probe's own baseline for that stub comes from `npm view` by default, from `--registry-base auto` (derived from the source tree's CHANGELOG under the same "dated and not marked unpublished" definition criterion 3 uses, so the probe runs offline) or from `--registry-base <file>`, and the printed header says which of the three it used rather than calling a synthetic list a measurement. The assertions then run the **production judgement**, not a fixture: `S1` cut-unpublished must be `--strict` exit 0 (and the full `--self-test` exit 0, whose case count the probe prints), `S2` published-without-tag must exit **2** naming `TAG_MISSING` (not judged is never red, issue #697 ③), `S3` fully published must exit 0, and one **contradiction** state — the docs claim the new version is published while the stub says `latest` is still the previous one — must go red naming `published-claim`. Two of those are simultaneously reverse proofs that the injection landed: while the live registry is still at the previous version `S3` cannot reach exit 0, and a green contradiction state would mean the stub was never read. `test/version-state-probe-703.test.js` is the guard on the tool itself (`S3` plus the contradiction state green-as-expected, an unknown state name ⇒ exit 2, an unreadable stub ⇒ exit 2, a stubbed `latest` ⇒ red naming `published-claim`). Trees and stubs stay under `.scratch/` (or `--out <dir>`), and the probe writes no tracked file. **Which tree it judges, and which it does not (issue #703 round 2 — the probe had caught the very disease it was written to kill).** "The current version" is **never** read off the tree the probe happens to run in: it comes from `--next <x.y.z>` / `--previous <x.y.z>` when those are passed, otherwise from the tree named by `--src` — *the version being cut* = the highest section of that tree's `CHANGELOG.md` marked unpublished and not below that tree's `package.json`, *the previous release* = the highest published section below it (its `package.json` is used only as a lower bound, never as the answer). So: **run `npm run check:version-states` on a tree that has an unpublished version section — anywhere between a version cut and the publish, `0.30.0` or `0.31.0`-unpublished alike — and it judges all four states.** **Run it on a tree whose current version has already been written back as released with no new section opened (the window between `release:day --stage writeback` and the next cut) and it answers exit 2 naming `NO_INFLIGHT_SECTION`,** after printing the facts it did read — that is *not judged*, never green, never silence, and `--next` hands the decision back to the caller. The same rule covers every other missing fact (`SRC_UNREADABLE`, `NO_PREVIOUS_RELEASE`, `NEXT_SECTION_MISSING`, `PREVIOUS_NOT_BELOW_NEXT`, `REGISTRY_UNREADABLE`, `REGISTRY_BASE_UNREADABLE`, `PREVIOUS_NOT_PUBLISHED`, `NEXT_ALREADY_PUBLISHED`), and each of those exit-2 answers has its own case in `node scripts/version-state-probe.mjs --self-test` (the case count is printed by the probe itself, and `test/version-state-probe-703.test.js` reconciles its floor against that print — issue #731): the reverse proofs run on three **synthetic hosts** (pre-cut / cut-but-unpublished / written-back-as-released) built with the same mechanical recipe, two of them required to produce **the same reading** — the machine proof that the probe stopped deriving its facts from its host. `test/version-state-probe-703.test.js` is the guard on the tool itself: that self-test green with its case count printed, a host run that answers either a judgement or a reason-coded exit 2 (never silence), an unknown state name ⇒ exit 2 before any fact is read, an unreadable stub ⇒ exit 2, and a stubbed `latest` ⇒ red naming `published-claim`.

The complete tracked `test/` tree is:

```text
test/
├── app-container-p0.test.js
├── capture-honesty.test.js
├── cli.test.js
├── codewrite.test.js
├── config.test.js
├── error-ledger.test.js
├── governor.test.js
├── judge.test.js
├── loop-callback-this.test.js
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
├── notes-candidates-and-scopes.test.js
├── notes-directory.test.js
├── notes-experiment-script.test.js
├── notes-final-guard.test.js
├── notes.test.js
├── output-aggregate-budget.test.js
├── output-hygiene.test.js
├── persistence-diagnostics.test.js
├── reflection.test.js
├── repl.test.js
├── run-state.test.js
├── skills.test.js
├── tokens.test.js
├── tool-result-ttl.test.js
├── tools.test.js
├── wrapup.test.js
├── compact/
│   ├── anchors.test.js
│   ├── budget.test.js
│   ├── enforce-size.test.js
│   ├── fold-fidelity.test.js
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
│   ├── assembly-port.js / assembly-port.test.js
│   ├── execute-tool.js / execute-tool.test.js
│   ├── index.js
│   ├── model-config-provider.js
│   ├── notes-store.js
│   └── transcript-store.js
├── fixtures/
│   ├── notes/
│   └── rounds-fixtures.mjs
├── helpers/
│   ├── fake-provider.js
│   └── mock-fetch.js
├── integration/
│   └── memento-scenario.test.js
├── messages/
│   ├── anthropic.test.js
│   ├── canonical.test.js
│   ├── openai-normalization.test.js
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
    ├── providers.test.js
    └── registry.test.js
```

(The listing is a map, not a manifest; the authoritative inventory is `find test -name "*.js" | sort`.)

## 1. v0.0 (MVP) — the basic path works

The original MVP coverage is still represented by these tests:

| Area | Files | Coverage |
|---|---|---|
| Providers and errors | `test/providers/openai.test.js`, `test/app-container-p0.test.js` | OpenAI request/response mapping, tool calls, endpoint normalization, configuration validation, error classification, abort behavior, and the basic Anthropic/loop path |
| Canonical messages | `test/messages/canonical.test.js` | Canonical conversion, tool-result ordering, tool schemas, legacy function calls, invalid response diagnostics, and raw protocol fields |
| Token estimates | `test/tokens.test.js` | CJK and non-CJK estimates, safety margins, configurable coefficients, message/block costs, and tool identifiers |
| Tool loop | `test/loop.test.js` | Text completion, tool-result feedback, `config.run.maxRounds`, stall nudges and termination, tool errors, `onToolResult`, round snapshots, and usage accumulation |
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
| Resume and run state | `test/loop-resume.test.js`, `test/run-state.test.js` | Resuming without replaying paid provider calls or executed tools, partial tool results, folded checkpoints, bounded run state (agent-side credential redaction retired, #55), schema availability, idempotent replacement, and persisted tool facts |
| Stores and compaction | `test/store/file.test.js`, `test/store/v020-rc.test.js`, `test/compact/fold-llm.test.js`, `test/compact/v020-rc.test.js`, `test/tool-result-ttl.test.js` | JSONL append/load, malformed-tail and crash-safe handling, atomic state writes, deduplication, injected LLM summarizers, size enforcement, protected rounds, global round offsets, image cleanup, request-view TTL folding, warning rounds, navigation digests, and JSON skeletons |
| Configuration | `test/config/json-file.test.js`, `test/config.test.js` | JSON-file slots, API-key materialization, default-slot fallback, CLI config paths, environment overrides, context-window parsing, and compaction-context construction |
| Tools | `test/tools/providers.test.js`, `test/tools/registry.test.js`, `test/tools.test.js` | Tool-provider composition, note tools and folded payloads, schema intersection and input validation, CLI tool execution, `grep`, archiving, and output limits |
| CLI, REPL, MCP, and skills | `test/cli.test.js`, `test/repl.test.js`, `test/mcp.test.js`, `test/skills.test.js`, `test/codewrite.test.js` | CLI/repl argument and session handling, MCP stdio and HTTP fixtures, tool discovery/calls/errors, skill discovery/loading/conflicts, and the CLI code-writing tools |

The repository also has a scenario-level test in `test/integration/memento-scenario.test.js`. It exercises folding, verbatim folded stubs (agent-side credential filtering retired, #55), archive pointers, repeated folds, and note-first recovery across the loop, tools, compaction, and memory store.

## 4. v0.3 and current behavior — no regressions in judging, reflection, notes, and recovery

The later/current suite is represented by:

| Area | Files | Coverage |
|---|---|---|
| Judge and governor | `test/judge.test.js`, `test/governor.test.js` | Round and tool-use judging, transparent interception, direction hints, degraded judge behavior, progress/error governance, reflection requests, wrap-up nudges, and observable judge decisions |
| Reflection and final verification | `test/reflection.test.js`, `test/wrapup.test.js`, `test/loop-final-guard.test.js` | Reflection decisions, wrap-up parsing and loop behavior, final-guard acceptance/revision, provenance, retry limits, timeout/error reporting, and fail-closed verification |
| Notes and capture | `test/notes.test.js`, `test/notes-candidates-and-scopes.test.js`, `test/notes-final-guard.test.js`, `test/notes-experiment-script.test.js` | Note lifecycle and scoping, provenance, automatic capture and archival (credential filtering retired, #136/#55), final-guard integration, experiment planning/cost gates, usage summaries, and reproducibility reporting |
| Output hygiene and folding | `test/output-hygiene.test.js`, `test/output-aggregate-budget.test.js`, `test/persistence-diagnostics.test.js`, `test/error-ledger.test.js`, `test/capture-honesty.test.js`, `test/compact/anchors.test.js`, `test/compact/fold-fidelity.test.js`, `test/tool-result-ttl.test.js` | Full checkpoint output retention, request-view TTL placeholders, warning-round note extraction, per-round aggregate gates, persistence diagnostics, repeated-error accounting, mechanical anchors, verbatim user-input fidelity, and capture honesty |

These files are current product-surface tests rather than a new replacement for the version-tagged regression files above; `npm test` runs them together.

## 5. v1.0 (consumer migration and compatibility)

The consumer-side migration of pure functions and application behavior remains an external acceptance activity. `app_container` and `touwaka` should run their own migrated tests and compare compaction boundaries and summary output for shared conversation fixtures; those consumer-project tests are not part of this repository's `test/` tree.

The reusable repository-side compatibility layer is the contract suite in `test/contract/`. It is exported through `./contract-tests` as `./test/contract/index.js`, so a MariaDB, PostgreSQL, or other adapter can register the same transcript-store and model-config-provider assertions. The built-in memory/file stores and config providers use the same helpers in their tests. Adapter-specific connection management, cleanup, and crash recovery remain adapter tests rather than contract assertions. See §0 for the import and registration example.

## 6. Cross-cutting conventions

- **Unit tests do not call external services.** Protocol tests use `test/helpers/mock-fetch.js`; loop tests use `test/helpers/fake-provider.js`. MCP coverage uses the local servers in the repository-root `fixtures/` directory.
- **Tests must not depend on the caller's privilege level.** A `chmod 0o000`/`0o500` fixture that makes a directory unscannable or undeletable does not fail for a uid that holds `DAC_OVERRIDE` (root in containers), so the error-swallowing branch under test is never reached and the case turns red on an assertion that is only a symptom. Manufacture the failure with a uid-independent source instead — a regular file where a path component must be a directory (`ENOTDIR`), a symlink to a missing target (`ENOENT`), or a symlink loop (`ELOOP`) — so privileged and unprivileged runs execute the same path. `t.skip()` is a fallback, never the first choice, and it must carry the reason.
- **Tests must not depend on external binaries.** A binary that is not a declared dependency (for example `git`) is absent from slim images and from most CI images; probe for it and skip with an explicit reason when it is missing, and keep the contract itself covered by a fixture the test writes itself (see the `exec` fixture case in `test/codewrite.test.js`). "Just install the binary" is not a fix.
- **Use deterministic assertions for deterministic behavior.** Budget calculations, statistical folding, `enforce-size`, run-state rendering, TTL folding, note behavior, and provenance behavior are asserted exactly. Do not snapshot inherently variable LLM output.
- **Exercise failure paths deliberately.** Error classification, retryability, aborts, malformed data, persistence failures, stale or tampered cursors, invalid tool input, and fail-closed behavior are part of the suite rather than afterthoughts.
- **Keep test state isolated.** Tests that touch `~/.erix`, `~/.pi`, environment variables, sessions, or MCP configuration inject `home`, `cwd`, temporary directories, or restore the environment so they do not use a real user's configuration.
- **Examples are integration documentation.** The `examples/` programs show caller integration and optional real-relay behavior; keep them readable and run them explicitly with `LLM_KIT_E2E=1`.
- **Node-version scope.** `package.json` declares Node `>=22`. The repository README separately notes that the `app_container` consumer side needs Node 24 for `await using`; the library's own test target remains Node 22+.
- **The library does not provide a browser test layer.** The terminal REPL has direct coverage in `test/repl.test.js`, but browser automation and vision tests are outside the project.
