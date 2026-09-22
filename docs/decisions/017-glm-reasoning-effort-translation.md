# ADR-017: GLM-5.3 always-on reasoning — payload-level `reasoning_effort` none→low translation

- Status: Accepted (2026-09-22), implemented in commit `6523ff7`
- Related: judge/wrapup normalize callers of `reasoning_effort:"none"`; bench evidence in erix-bench REPORT.md (260928 glm run, judge degraded §4)
- Upstream: vLLM issue #54744, fix PR #54825, frontend fix PR #56994; Z.ai GLM-5.3 docs; unsloth GLM-5.3-GGUF card

## Background

erix's unified model-config interface exposes `reasoning_effort`, where `"none"`
means "the model should not emit any reasoning". Two internal consumers depend on
it: the round/intercept judge and the wrapup LLM normalizer, both of which require
parseable JSON-only output with a tight (1024-token) budget.

On the relay backend (`api.ai.erix.vip`, vLLM serving `glm-5.3-flash-awq`), the
2026-09-28 Terminal-Bench run produced 4 judge degradations (parse/timeout) out of
~12 audits. Root cause chain, confirmed by a request-matrix probe against the
relay (scripts archived at `/tmp/glm-thinking-test.mjs`, `/tmp/glm-focused-test.mjs`,
`/tmp/glm-translate-test.mjs`):

| request param | response `reasoning` field | response `content` | verdict |
|---|---|---|---|
| *(none)* baseline | thinking present, isolated (281-578 chars) | clean JSON | safe but costly |
| `reasoning_effort:"none"` | empty | **raw English CoT dumped into content** (4/4 repro, up to out_tok=1024 cap) | parse poison |
| `reasoning_effort:"low"` | brief thinking (88-140 chars), isolated | clean JSON, 18-151 out_tok | correct |
| `enable_thinking:false` / `chat_template_kwargs:{enable_thinking:false}` / `thinking:{type:"disabled"}` | thinking present, truncated by max_tokens | unusable | ignored by backend |

The judge had been sending `reasoning_effort:"none"` since 2026-09-20; for GLM the
semantics the backend applies is **"do not isolate reasoning"** rather than
"do not reason" — the model still thinks and the CoT lands in `content`,
burning the JSON-only consumer's output budget. The same relay honors `"none"`
correctly for deepseek, so the defect is GLM-template-specific.

## Upstream evidence (GLM-5.3 is officially always-thinking)

- Z.ai official docs (glm-5.3): "GLM-5.3 **always operates with reasoning enabled**;
  three levels low/high/max. **Disabling reasoning is no longer supported.**"
- unsloth GLM-5.3-GGUF: `reasoning_effort` accepts low/high/max and **defaults to
  max for any unrecognized value** — `"none"` is not in the vendor's value space.
- vLLM issue #54744: GLM-5.3 template guarantees a thinking block;
  "reasoning_effort only sizes it"; clients passing the 4.x-era off switches
  (`enable_thinking`/`thinking:false`) disable the reasoning **parser** while the
  model keeps thinking → raw think block leaks into `content`. Fixed by PR #54825
  (split leaked think blocks when extraction is disabled); the relay's vLLM build
  predates the fix.
- vllm-ascend #16592: non-thinking mode fails **silently** on GLM-5.3.
- Response-shape quirk: GLM-5.3 on vLLM returns reasoning as `message.reasoning`
  (renamed from `reasoning_content`) — non-standard, must be tolerated by clients.

## Decision

1. **Unified semantics unchanged**: callers keep sending
   `reasoning_effort:"none"` (= "no reasoning") at the port boundary.
2. **Payload-level translation, model-gated**: in the OpenAI payload assembly
   (`src/providers/payload.js`), when the outgoing payload has
   `reasoning_effort === "none"` and the model name matches `/glm/i`, rewrite to
   `"low"` — the lowest level GLM-5.3 actually supports. Gate on `provider === "openai"`
   and model name; deepseek/qwen on the same backend keep correct `"none"` semantics.
3. **Why `low` and not "find the off switch"**: there is no off switch on GLM-5.3
   (vendor-removed). `low` empirically yields brief, properly isolated reasoning
   with clean JSON content and the lowest latency (0.7-2.8s vs 2.0-14.3s in matrix).
4. **Stale-comment hygiene**: the judge call site comment (2026-09-20, claiming
   `none` "真正关思考") was corrected to point at the translation.

## Revisit triggers

- Relay upgrades vLLM to include #54825/#56994: `"none"` will then behave as
  "thinking isolated, content clean" (safe but pricier than low). The translation
  stays correct; optionally re-evaluate dropping it for cost.
- If a future GLM family restores a real non-thinking mode via
  `chat_template_kwargs` (the vLLM-documented channel for 4.x-era GLM), replace the
  name-gated translation with that parameter instead.

## Test coverage

`test/providers/v020-alpha.test.js`: glm + none → low; non-glm + none unchanged;
glm + low unchanged; glm + absent → key absent. Full suite at commit: 825 tests,
0 failures. End-to-end verified with a real erix+glm run: judge emitted a normal
`judge_done` decision with no degraded/parse entries.
