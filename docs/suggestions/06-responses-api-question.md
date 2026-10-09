# question(provider): OpenAI Responses API: in scope, out of scope, or the AI SDK trigger?

*(Filed as a question/decision request, not a feature request.)*

## Background

erix speaks two wire protocols: OpenAI-compatible `/chat/completions` and Anthropic `messages` (`docs/requirements.md` Goal 1, FR-1.1). OpenAI's own agent stack has moved to the **Responses API**: Codex CLI uses it, and Responses is where OpenAI reasoning models carry reasoning state across turns. Reasoning items are not returned through Chat Completions. Pi 1.x also ships a Responses adapter. It handles usage accounting by subtracting `cached_tokens` / cache-write tokens from `input_tokens` (`packages/ai/src/api/openai-responses-shared.ts`).

`docs/maintenance-policy.md` rule 1 says that when "a third non-OpenAI-compatible native protocol (Gemini native / Bedrock / Azure)" is needed, erix should migrate to AI SDK. Responses is an OpenAI protocol but is not chat-completions-compatible, so it is unclear whether it would trigger that rule.

## Question for the maintainer

Which of these applies?
1. **Out of scope**: hosts that need OpenAI reasoning models use a chat-completions relay and accept losing reasoning state between turns. If so, document it in `requirements.md` non-goals.
2. **In scope as a third first-party adapter**, explicitly exempted from the AI SDK trigger (same vendor, and the block format maps onto the canonical internal format).
3. **It is the AI SDK trigger**, so the migration plan applies.

Any of these is fine. The point is to record the decision so hosts targeting OpenAI models know what to expect.

## Semver

None (decision record). Option 2 would be a minor.
