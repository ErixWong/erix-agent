# docs(harness-comparison): refresh the pi baseline 0.84.2 → 1.1.0 and note patterns worth evaluating

## Background

`docs/harness-comparison/01-pi-agent.md` analyses `@earendil-works/pi-coding-agent` **0.84.2**. Pi shipped 1.0.0 on 2026-10-01 and 1.1.0 on 2026-10-07 (github.com/earendil-works/pi; the old badlogic/pi-mono redirects there). Several statements the comparison relies on are no longer true. ADRs and `requirements.md` ("Do not become a 'mini pi'") use pi as their reference point, so a stale baseline can mislead future decisions.

## Facts now out of date in 01-pi-agent.md

| Doc says (0.84.2) | Pi 1.1 reality | Source (pi repo, main @ 1.1.0) |
|---|---|---|
| "**不内置** MCP" (no built-in MCP) (L8, L18, L137) | MCP is built in since 0.99/1.0 via **codemode**: model-written JS runs in QuickJS-WASM and can only call injected `tools.*`. Exposure modes are `codemode` (default), `deferred`, `direct` and `hidden`. | `packages/codemode/README.md`, `packages/coding-agent/docs/mcp.md` |
| No dynamic per-turn injection; `before_agent_start` replacing `systemPrompt` breaks cache (L192) | Since 0.86, **system messages can appear mid-conversation**: a `SystemMessage` with `sections` / `toolsAdded` / `toolsRemoved` is appended, so the prefix stays byte-stable. | `packages/ai/README.md#system-messages` |
| agent-core includes harness pieces | At 1.0, `packages/agent` was cut down to just `Agent` + loop + proxy stream. Sessions, compaction and tools moved out. | `packages/agent/CHANGELOG.md` (1.0.0) |
| Deferred loading only via extensions | Built-in `tool_search`. Loaded tools are recorded per branch in the transcript, with native deferral for Anthropic, OpenAI Responses and Fireworks. | `packages/coding-agent/docs/cli.md` |

## Patterns worth evaluating for erix (in rough priority order)

1. **Automatic prompt-cache breakpoint placement.**
   - Pi puts Anthropic `cache_control` on three places: the system block, the last tool definition, and the last block of the last user/system message (`packages/ai/src/api/anthropic-messages.ts`). It uses the 1h TTL only when requested and supported.
   - erix passes through block-level `cache_control` only (`src/messages/anthropic.js:28-31`), so every host has to place breakpoints itself.
   - This complements the existing cache-economics research (`docs/research/2026-09-26-strategy-variance-and-cache-economics.md`) and proposal B3 (`summaryPlacement:"boundary"`, still 🔶). An opt-in `cacheBreakpoints: "auto"` would let hosts get the benefit without hand-placing markers.
2. **Context edits as append-only entries.**
   - Pi 0.87 added `ContextEditEntry`, which drops or replaces a message in the model-visible projection without mutating history. Compaction is also an entry that stores `{summary, firstKeptEntryId, tokensBefore, usage}`.
   - This may be a cleaner model for erix's TTL folding and anchors than rewriting history, and it makes "what did the model actually see at round N" reconstructable.
3. **Host message injection mid-run (steering / follow-up queues).**
   - Pi's `agent.steer()` injects after the current tool batch, and `agent.followUp()` injects when the loop would otherwise stop (`packages/agent/README.md#steering-and-follow-up`).
   - For unattended runs this is less central, but a host-side "inject guidance at next round boundary" hook may be useful to schedulers. Evaluate it; don't necessarily adopt it.

## Already covered by erix (worth stating in the refreshed doc)

- **Replay safety on resume.** erix `replayPolicy: "per-tool-declaration"` ≈ pi-durable's per-tool `replay: "safe"` (pi-durable is still marked experimental).
- **Context estimate.** erix `projectedApiInputTokens` (provider-reported usage scaled by an estimate ratio) ≈ pi's "last reported usage + char estimate of the tail". Neither uses a tokenizer.
- **Observer error isolation.** erix isolates host observer errors (#173). In pi 1.1 `Agent.processEvents` awaits listeners without try/catch, so a throwing listener ends the run with `stopReason:"error"` (`packages/agent/src/agent.ts`; this comes from reading the source, not from running it). **erix is ahead here.**

## Acceptance

- `01-pi-agent.md` (and its CN/EN pair) states the pi version analysed as 1.1.0, corrects the four rows above, and is cross-checked against `06-cross-comparison.md` / `07-takeaways-and-open-questions.md`.
- Items 1–3 are either opened as separate issues or explicitly recorded as won't-do with a reason.

## Semver

None (docs).
