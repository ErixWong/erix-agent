# erix-agent v0.3.x Host Upgrade Guide (touwaka / app_container)

> Chinese version: [host-upgrade-guide-v030_cn.md](host-upgrade-guide-v030_cn.md)

> This guide is for erix-agent's two host consumers: **touwaka** (the expert conversation path) and **app_container** (the PI Agent audit/development path).
> It describes the host-visible changes when upgrading from erix-agent <=0.2.0 to **v0.3.x** (0.3.0 onward; the v0.3.x reference point is npm 0.3.4).
> Related reading: the erix README, [ADR-011](decisions/011-judge-direction.md) (judge design), and [ADR-010](decisions/) (compaction).

> **Scope note:** This is a v0.3.x upgrade guide, not current release notes. For host-visible changes after v0.3.x, see [host-consumer-contract.md](host-consumer-contract.md).

---

## 0. Upgrade summary from the host's point of view

The following `runToolLoop` behaviors are new or changed for hosts:

| # | Change | Host impact |
|---|---|---|
| 1 | **Reflection (the judge system) is enabled automatically** when `maxRounds >= 16`, `reflection` is omitted, and `ERIX_NO_REFLECTION` is not `1` | Long runs can make additional judge calls. Runs below 16 rounds are not automatically enabled. |
| 2 | **Transparent tool-call auditing:** after every `judgeIntervalRound` real tool executions (default `5`), the next tool call is judged before execution | `executeTool` can be skipped when the judge returns `done:false`; an audit or degraded result is returned instead. Judge errors and timeouts fall back to executing the original tool. |
| 3 | **Round judge:** an `end_turn` response without tool use is independently evaluated; only a valid `done:true` with `confidence >= 0.7` yields `judge_done` | A model's attempt to stop can cause another judge call and delay. A judge failure falls back to the normal completion/no-tool/end-turn governor. |
| 4 | **Fail-closed checkpoints** when the store supplies both a checkpoint writer (`saveCheckpoint` or `appendCheckpoint`) and `loadLatestCheckpoint` | A failed checkpoint before an actual tool execution raises `checkpoint_failed` and the tool is not executed. A failed checkpoint afterward reports that the tool already ran but its result was not persisted. `executeTool` should be idempotent by tool id. |
| 5 | **Soft stall correction:** repeated tool signatures are nudged before the third stall hit, then stop with `termination.reason: "stall"` | The old `llm_kit_stalled` hard error is no longer the normal path. Hosts must handle a normal result whose termination reason is `stall` (and whose `truncated` value is `true`). |
| 6 | **Direction hints are soft guidance** | `direction: "off_track"` alone does not block a tool. It adds a direction hint; an intercept is blocked only when the judge returns `done:false`. |
| 7 | **Strict `maxRounds` validation** | `maxRounds` must be a positive safe integer. Invalid values such as `NaN`, `0`, negative values, `Infinity`, and non-integers throw `TypeError`. |
| 8 | **JSONL crash recovery in the file store** | A complete final JSON record without a newline is repaired; an incomplete or invalid trailing fragment is isolated as `.corrupt.*` and removed from the active file. |
| 9 | **Judge observability and round-record persistence** | `onJudge` receives round and interception decisions, including degraded decisions. Round judge data is included as `record.judge` when a host persists round records; interception decisions are not automatically added to that record. |
| 10 | **Optional final-guard verification** | A host-supplied `finalGuard` can accept, skip, or request a revision of a final result. Hosts must consume `verification.status` rather than treating every returned `finalText` as verified. |

### Round-judge degradation matrix

| Judge result | Loop behavior | Host-visible meaning |
|---|---|---|
| Valid `done:true` and `confidence >= 0.7` | Produces `judge_done` and finishes | The judge accepted completion with high confidence. |
| Valid `done:false` | Injects a judge nudge and continues | The judge explicitly says that more work is required. |
| Valid `done:true` with `confidence < 0.7` | Does not produce `judge_done`; normal `completion`, `no-tool`, or `end_turn` logic decides | The model's completion signal can still stop the run. |
| Parse failure or evaluator exception | Emits a degraded `onJudge` decision and uses the normal governor | After three consecutive failures by default, round judge is disabled for the rest of the run. |

`direction` is an advisory field in the judge response. The judge prompt explicitly says it does not affect `done`. For an intercept, only `done:false` blocks the original side effect; an `off_track` direction may instead add a hint to the next model context.

## 1. touwaka (expert conversation path)

**Baseline configuration** (from the original host integration guide; verify against the touwaka repository before rollout):

- Call site: `lib/agent/agent-loop.js:1074` -> `buildErixRunOptions` in `lib/llm-kit-adapters/loop-bridge.js`.
- `store`: `createErixStore` backed by MariaDB, using `llm_kit_transcripts` and `llm_kit_run_state`; `saveCheckpoint`/`appendCheckpoint` and `loadLatestCheckpoint` are all present, so the store is a paired checkpoint store.
- `stallDetection: false` is explicit; touwaka has its own retry and recovery system.
- `maxRounds` comes from the expert configuration `max_tool_rounds` or system settings, with a host fallback of **8**.
- `reflection` is omitted, so the core automatic-enable rule applies when the effective `maxRounds` is at least 16 and `ERIX_NO_REFLECTION` is not `1`.
- `loop-bridge` has `...passthrough`, so host-supplied `reflection` options can reach `runToolLoop`.

### Important: disable the wrap-up protocol for touwaka

The v0.3.x wrap-up protocol is enabled by default. A conversational host should pass `wrapup: false`. This disables instruction injection, wrap-up JSON parsing, `finalText` replacement, and wrap-up LLM normalization together. `completion.signals` remains independent; do not replace it with `completion: false`.

With touwaka's fallback of 8 rounds, the automatic judge is normally off. If an expert or system setting reaches `maxRounds >= 16`, an `end_turn` without tool use can invoke the round judge, and every fifth real tool execution schedules an intercept audit. Decide this explicitly because it changes latency, provider usage, and tool-side-effect handling.

### Response checklist

1. **Choose a judge policy:**
   - **A. Accept automatic enablement** (recommended for long-running or audit-oriented experts): no code change is required when `maxRounds >= 16` and `reflection` is omitted. This adds direction checks and completion review; budget for calls through the main provider unless a separate judge provider is configured.
   - **B. Disable it explicitly** for conversational experts that should not pay the extra latency: pass `reflection: false` at the `buildErixRunOptions` call site.
   - **C. Configure it by expert type**, for example:
     ```js
     reflection: expertConfig?.judge === true
       ? { enabled: true, roundJudge: true, judgeIntervalRound: 5, judge: { provider: judgeProvider } }
       : false
     ```
     `judgeIntercept: false` can disable only interception while retaining the round judge. `roundJudge: false` can disable only the end-turn judge.

2. **Pass the task brief (issue #34):** for multi-turn and resumed runs, pass the current instruction as a string in `runToolLoop`'s `task`. The precedence is `task` > `context.task` > the last user message in the entry transcript. Explicit `task` and `context.task` values are bounded to 1500 code points; the message fallback is bounded to 500. Pass `task` again when resuming. For a resume, the fallback source is the original round-0 seed messages, not later injected direction hints or nudges.

3. **Choose the judge provider:** by default, judge calls use the main provider. To isolate cost or latency, pass a separate `reflection.judge.provider` (or `reflection.judge.evaluator`), such as a lightweight model. Extend touwaka's model configuration and `loop-bridge` if it needs to construct that provider.

4. **Handle paired-store checkpoint failures:** because the touwaka store is paired, a checkpoint write failure is fail-closed. A transient MariaDB failure now fails the run instead of allowing the tool call to proceed. Observe database stability after the upgrade; add host-side retry or an adapter retry layer if appropriate. Recognize the `checkpoint_failed` error code and do not treat it as an ordinary model error for unlimited retries. The post-execution failure window cannot provide exactly-once execution, so `executeTool` must be idempotent by tool id.

5. **Account for judge persistence:** the core stores round judge data in the round JSON as `record.judge`, but a MariaDB transcript table need not have a separate judge column. If touwaka needs field-level queries or replay, add a column/index or query the stored JSON in the host adapter. Interception decisions should be captured from `onJudge` or the host's judge log.

6. **Tolerate injected audit messages:** the model may receive the runtime's `【审计拦截】方向可能偏...` and `（附方向提示...）` messages. They are synthetic `user`-role messages and can appear in the transcript. The presentation layer should tolerate them or label/filter them.

### Verification

- Upgrade the erix-agent dependency to 0.3.4 and run a long expert conversation (`maxRounds >= 16`). Observe the additional judge usage, the model's behavior after audit/interception hints, and the MariaDB checkpoint paths.
- Run a short conversation (`maxRounds < 16`) with no explicit `reflection` and confirm that the automatic judge does not start.
- Verify that a conversational response remains natural-language after `wrapup: false`, while `completion.signals` still works.

## 2. app_container (PI Agent audit/development path)

**Baseline configuration** (from the original host integration guide; verify against the app_container repository before rollout):

- Call site: `apps/worker/src/pi/runner.js:50` -> `runToolLoop`.
- The host passes no `reflection` and no `store`; `maxRounds` is supplied by the caller, with the auditor fallback at **12**.
- `completion: { signals: [], maxNoToolRounds: 3 }` and retry attempts: 2.
- The transcript writes only `result.transcript` to `transcript.json` (messages, without judge or usage layers).
- The host removes JSON wrapping and passes `wrapup: false` as a second line of defense. If the host's final schema contains a top-level `done: boolean` key, such as `{"done":true,"summary":...}`, its JSON shape cannot be distinguished from the wrap-up protocol. The required own `done` key guard can reject summary-only output but cannot solve that collision; this is why `wrapup: false` or JSON de-serialization is required.
- This corresponds to issue #71 (judge not enabled and no store).

### Impact assessment

- With the auditor fallback `maxRounds = 12`, the core automatic reflection rule does not apply, so the current path does not start the judge.
- If a task uses `maxRounds >= 16`, `reflection` is omitted, and `ERIX_NO_REFLECTION` is not `1`, the core automatic judge starts.
- Explicit `reflection` configuration or an explicit `reflection: false` always takes precedence over the automatic rule.

### Response checklist

1. **Decide whether to enable the judge:**
   - If an audit or development task needs direction and completion checks, raise `maxRounds` to at least 16 or pass `reflection: { enabled: true }`.
   - To preserve current behavior, leave the configuration unchanged.
   - Pass `reflection: false` explicitly to prevent accidental future enablement if the host later raises `maxRounds`.

2. **Decide on a store:** app_container currently has no store, so it has no checkpoints or fail-closed checkpoint behavior, and resume is unavailable. For crash recovery in unattended long tasks, integrate a file or database store that implements the `TranscriptStore` contract. If no store is added, checkpoint-related behavior remains disabled.

3. **Persist judge decisions if the judge is enabled:** `result.transcript` contains messages only. Use `onJudge` to write an audit trail, or add a store so round records can carry `record.judge`; do not assume that the in-memory result transcript contains judge decisions.

4. **Handle soft stall correction:** app_container may previously have seen `llm_kit_stalled` as a hard failure. The current loop nudges suspected repeated calls and stops after a stall streak of 3 with `termination.reason: "stall"` and `truncated: true`. Without a final guard this is a normal return; with a final guard, a non-continuable stall can instead end as `final_guard_unverified`.

5. **Validate `maxRounds`:** the value supplied to `runToolLoop` must be a positive safe integer. The auditor fallback of 12 is valid.

### Verification

- Upgrade the dependency and run an audit task with `maxRounds = 12`; confirm that no judge call is made and the existing path remains unchanged.
- If the judge is enabled, run a long task and observe the round judge, the every-fifth-tool intercept, `onJudge` records, and any synthetic audit messages.
- Confirm that the caller handles the changed termination semantics, especially the old stall error versus `termination.reason: "stall"`.
- Confirm that the host's `wrapup: false` path still returns its own final JSON/text schema without protocol parsing or `finalText` replacement.

## 3. Shared caveats

| Topic | Guidance |
|---|---|
| **Cost** | An enabled judge adds one round-judge call for eligible `end_turn` responses and one intercept audit after each five real tool executions by default. The total increase depends on the run; measure provider usage rather than relying on a fixed percentage. A separate `reflection.judge.provider` can isolate cost. |
| **Judge-provider quota** | The default judge uses the main provider. A main-provider quota failure can therefore affect judge protection. Round-judge failures degrade to normal governor behavior; intercept failures and timeouts degrade to direct tool execution. |
| **`checkpoint_failed`** | It is raised when a paired store cannot persist the checkpoint before or after an actual tool execution. The post-execution message explicitly says that the tool ran but the result was not persisted. Classify this error separately and make `executeTool` idempotent by tool id. |
| **Synthetic audit messages** | `【审计拦截】方向可能偏...` and `（附方向提示...）` are injected `user`-role messages. They can appear in transcripts and UI output. |
| **Termination reasons** | The normal result can use `end_turn`, `no_tool`, `stall`, `max_rounds_cap`, `reflection_stop`, `judge_done`, or `continuation_exhausted`; aborts and uncaught failures use `aborted` and `failed`. If a final guard cannot verify a non-continuable result, the reason becomes `final_guard_unverified`. Host state machines should cover these values rather than treating every non-error return as successful completion. |
| **`onJudge`** | Each round or intercept decision is delivered as `{kind: "round"|"intercept", action, decision, tool?}`; degraded decisions also include `error` as `timeout`, `error`, or `parse`. Round decisions are persisted as `record.judge` when round records are stored; intercept decisions require the callback or a log. |
| **`finalGuard`** | The core API guard is opt-in. Its default `finalGuardMaxRetries` is `2`; its default `finalGuardTimeoutMs` is `30000` and non-positive/non-finite values use that default. `{ action: "accept" }` yields `verification.status: "verified"`, `{ action: "skip", reason }` yields `"skipped"`, and `{ action: "revise", message }` continues when possible. Exhausted or non-continuable revisions yield `"unverified"` and `final_guard_unverified`; guard errors/timeouts return `"error"` without treating the text as verified. No guard yields `"skipped"` with reason `"no_final_guard"`. |
| **`wrapup` and `completion`** | `wrapup` defaults to `true`; `wrapup: false` or `ERIX_NO_WRAPUP_INSTRUCTION=1` disables instruction injection, JSON parsing, `finalText` replacement, and wrap-up normalization. Optional normalization is off by default and is enabled by `ERIX_WRAPUP_NORMALIZE=1` or `reflection.wrapupNormalize === true`. `completion` defaults to `{ signals: [], maxNoToolRounds: 3 }`; `completion: false` disables the completion/no-tool policy, not the wrap-up protocol. |
| **Stall detection** | `stallDetection` defaults to `{ window: 4 }` with mode `"appear"`; `"consecutive"` requires the entire window to match. `stallDetection: false` disables it. `ERIX_STALL_MODE` can provide the mode, but an explicit `stallDetection: false` wins. |
| **Environment controls** | `ERIX_NO_REFLECTION=1` disables automatic reflection; `ERIX_NO_ROUND_JUDGE=1` disables only the end-turn judge; `ERIX_NO_WRAPUP_INSTRUCTION=1` disables the whole wrap-up protocol; `ERIX_WRAPUP_NORMALIZE=1` enables optional wrap-up normalization. These are runtime controls that exist in `src/loop.js`. |
| **CLI controls** | In `bin/cli.js`, `erix chat` uses `--max-rounds <n>` with a default of `64`; `ERIX_MAX_ROUNDS` is the positive-integer fallback. CLI reflection defaults to enabled when `maxRounds >= 32` (not 16) if no explicit option or env setting is supplied; `--reflection <on|off>` and `ERIX_REFLECTION` control it, while `ERIX_NO_REFLECTION=1` wins. `--final-guard` and `ERIX_FINAL_GUARD=1` enable the CLI guard; `--no-final-guard` is a compatibility no-op. `--judge-log <path>` writes redacted round/intercept JSONL and overrides `ERIX_JUDGE_LOG`. `ERIX_NO_TOOL_ROUNDS` controls the CLI's positive `maxNoToolRounds` fallback, whose default is `3`. |
| **Version anchor** | This guide describes the v0.3.0-v0.3.4 upgrade boundary: 0.3.1 was README-only, 0.3.2 added the MIT license, 0.3.3 made the wrap-up protocol switchable, and 0.3.4 fixed the judge task brief (#34). Later host-visible behavior belongs in [host-consumer-contract.md](host-consumer-contract.md). |

## 4. Upgrade checklist (both hosts)

- [ ] Confirm the erix-agent dependency version (at least 0.3.4, including the #34 task-brief fix).
- [ ] Choose and implement a reflection/judge policy (automatic enablement, explicit disablement, or per-expert configuration).
- [ ] If the judge is enabled, choose the judge provider (the main provider or a separate one).
- [ ] For a store host, confirm that checkpoint write and load methods are paired and understand fail-closed behavior. For a host without a store, confirm that resume protection is not required.
- [ ] Handle the termination reasons `stall`, `judge_done`, `reflection_stop`, `final_guard_unverified`, and the other values listed above.
- [ ] Tolerate or label synthetic audit messages.
- [ ] Decide how `verification.status` is consumed when a final guard is enabled; do not treat `skipped`, `unverified`, or `error` as `verified`.
- [ ] Measure the additional judge usage for long tasks.
- [ ] Run real-host verification: a short task with no automatic judge and a long task where the configured judge behavior is observable.
