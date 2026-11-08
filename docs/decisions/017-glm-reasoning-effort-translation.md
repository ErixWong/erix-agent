# ADR-017: GLM-5.3 always-on reasoning — payload-level `reasoning_effort` none→low translation

> **Status (2026-10-29) — retired spelling in the body.** This document records a decision **as it was
> made**. It was written in the flat-spelling era (≤ 0.27 — and **0.27 was never released**), so the
> option names in its body are the flat spellings the name gate now rejects (`timeoutMs`,
> `toolResultTtl`, `initialMessages`, …). The spelling in force today is the `config.*` path for the
> same knob; the authoritative table is in `docs/host-consumer-contract.md`. The body below is left
> **verbatim on purpose** — rewriting a decision record into today's spelling would forge history.

> **Status note (2026-11-08)** — 本决议的现场模型 `glm-5.3-flash-awq` 对当前 token 已不可用（真上游实测 HTTP 404，网关 `one_hub_error`：Model … is not supported for current token；同族 `z-ai/glm-5.2` 虽在 `GET /models` 清单内仍 404 ⇒ 可用性由 token 级授权决定，不是型号下架）。因此本决议的行为断言**当前不可回放**：要修订或取代它，前置是先取得能跑 GLM 的凭证。**（此句已被下面 2026-11-09 那条更替：原型号按「已退出」处理，后继型号上已重放成功。）**另注：网关 404 响应的 `content-type` 是 `text/plain` 而正文是 JSON，错误体解析不能按 content-type 分流。

> **Status note (2026-11-09) — 上一条的「不可回放」不成立：本决议已被正面重放。** 换一个 token（pi 侧 `erixai` provider 的 key，`https://api.ai.erix.vip/v1`）实测：
>
> 1. **原现场型号 `glm-5.3-flash-awq` 在两个不同 token 下都不可用，且都不在各自的 `GET /models` 清单里**（另一个 token 的清单 39 项、含 `z-ai/glm-5.2`；这个 35 项、含 `z-ai/glm-5.3-flash`）。⇒ 上一条把它归因成「token 级授权」不够：现在按**该型号已从 relay 退出**处理。网关那句 `Model … is not supported for current token` 是**通用文案**，不能用它区分「没授权」与「已下架」（两种情形逐字相同）。
> 2. **后继型号 `z-ai/glm-5.3-flash` 能跑，本决议的行为被正面重放**：同一个 key **裸发** `reasoning_effort:"none"` ⇒ **HTTP 400** `Provider API error: Reasoning is mandatory for this endpoint and cannot be disabled.`；同值**走引擎**（`applyProviderPayloadOptions` 的 `none→low`）⇒ **HTTP 200**，轮记录留下 `hostValue:"none"` / `sentValue:"low"` / `translated:true`。⇒ 这层翻译的作用是**把 400 变成 200**，不是历史优化：**不许删**。
> 3. 该型号自报的合法值清单是 `max|xhigh|high|medium|low|minimal|none`（**7 个**，与 qwen 那一族报的 8 个不同），而 `none` 属于**模式接受、政策拒绝**：枚举里有、政策上禁用。⇒ 把任何一份清单抄成全局值域仍不成立（#788 的裁决据此继续有效）。
> 4. `minimal` / `high` / `max` 分别回报 `reasoning_tokens` = 10 / 11 / 38（**档位真的生效**），而 `low` 那一发回报 **0** ⇒ 「回报 0」与「没回报」的区分（#785 的 `reasoningTokens` 口径）在 GLM 路径上也成立。

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
