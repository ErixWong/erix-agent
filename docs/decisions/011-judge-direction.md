# ADR-011: Judge Direction Evaluation (direction Soft Hint)—Mechanism Design + Benchmark Evidence

> Chinese version: [011-judge-direction_cn.md](011-judge-direction_cn.md)

- Status: Decided (2026-09-06)
- Related: PR #28 (transparent interception), PR #29 (judge observation + stall soft correction + direction soft hint), Issue #27
- Evidence: db-wal-recovery reward=1 (88s/11 rounds, historical run1 reward=0/721s); circuit-fibsqrt run3 (11 interceptions all recorded)

## Background: judge only evaluates deliverables and cannot catch direction drift

The judge in transparent interception (PR #28) used only the following criteria during each mid-tool audit: task goal, the most recent 12-round timeline (tool calls + output),
files written, and recent errors. It was instructed that "if the direction is wrong, done must be false", but **all 11 interceptions (circuit-fibsqrt run3) were "deliverable/verification output" cases**:

```
"gates.txt 文件内容不完整且格式错误"        ("The gates.txt content is incomplete and malformed") ← 交付物 (deliverable)
"gen2.py 在 emit 函数中语法错误崩溃"        ("gen2.py crashes with a syntax error in the emit function") ← 交付物 (deliverable)
"输出恒为 32767 而非预期值"                 ("The output is always 32767 instead of the expected value") ← 交付物（验证输出） (deliverable/verification output)
```

The model's **direction** was indeed wrong (run3 became mired in 40+ rounds of repeatedly debugging the same isqrt digit-by-digit implementation detail), yet the judge never pointed it out. Reasons:
- The timeline contained only "tool actions + output", with no "intent/plan" layer—`exec python3 dbg_isqrt.py` looked like reasonable progress
- "Direction" is a long-range concept, while a single audit sees only the most recent 12 rounds
- The judge had no domain knowledge with which to assess the design route

## Decision 1: direction is a soft-hint layer and is never a hard gate

**The cost structure determines this**: the cost of misjudging direction > the cost of misjudging a deliverable.
- Wrongly blocking a deliverable: the model changes its action, with no loss
- Wrongly correcting direction (telling the model "the method is wrong" when it is actually right): the model abandons the correct path—if run1's successful path were misjudged, it would be destroyed

→ **Violates "better to miss a judgment than kill the task"**. Therefore direction is designed as follows:
- judge output extends to `{"direction":"on_track"|"uncertain"|"off_track","directionReason":"..."}`
- direction **never participates in stop/interception/termination decisions**
- done:true + off_track → **execute the original tool** (do not intercept), and attach a direction hint in tool_result/an independent message for the model to consider changing routes itself
- done:false (hard interception of the deliverable) semantics remain completely unchanged

## Decision 2: hints do not pollute the fact chain

If a direction hint were concatenated into tool_result.content, buildTimeline would treat it as real tool output → contaminating subsequent judge decisions. Fix: inject it as an **independent user text message**
(visible to the model, but not part of a tool_use/tool_result pair). All three paths—blocked/allowed/resume—flush it, with a limit of 2 messages/round + 200 characters to prevent bloat.

## Decision 3: judge-log observation + redaction (audit integrity)

- Every judge decision (round/intercept/degraded) emits onJudge and can optionally be written to a --judge-log JSONL file (not written by default)
- Redaction: do not write raw tool inputs (token/secret risk); reason/evidence paraphrases are also hidden at content level (CREDENTIAL_PATTERN: sk-/JWT/Bearer/ghp_/AWS/stripe/npm/Google, etc.)
- degraded events carry an error category (parse/error/timeout) + tool information

## Decision 4: stall soft correction to prevent spinning (same-source refactor)

First principles: **spinning can only be defined relative to the task goal**—repeated signatures do not equal spinning (legitimate reruns of verification commands/file reads in segments have repeated signatures). Mechanical detection (stall) has no task semantics yet applies the highest-level action (throw to kill the run) → catastrophic false kills (one redundant reread discards the entire task; circuit-fibsqrt run2 was killed after 3 rounds in actual testing).

- A stall hit no longer throws: soft nudge ("suspected repeated call; if there is no new purpose, please proceed") ≤2 times
- If it still hits 3 times consecutively → normal stop value:"stall" truncated:true (retain the final draft; do not lose it)
- stallStreak accumulates only when stalled, and is cleared only when a different signature appears (clearing the window does not incorrectly clear it)
- stallDetection:false takes precedence over ERIX_STALL_MODE (an explicit disable is not reopened by env)

## Decision 5: after round judge degradation, fail-open termination

When round judge parsing fails, the call errors, or completion has low confidence, it does not produce `judge_done`; instead it falls back to the existing
`completion`/`no-tool`/`end_turn` decisions. The model's self-reported completion signal may still terminate the task. After consecutive failures reach the limit,
round judge is automatically disabled. This fail-open behavior is an intentional availability-first choice, avoiding a judge provider
failure locking the task; a fail-closed configuration option remains for future evaluation (#45).

## Evidence (db-wal-recovery, first direction validation)

**reward=1 (88s, 11 rounds)** vs historical run1 reward=0 (721s stuck in apt/network spinning).

Complete judge.log audit chain (all 3 entries persisted and queryable):
```
#1 intercept blocked + direction=off_track
   reason: 模型仅执行侦察操作（tree/ls/xxd/which），尚未修复 WAL，关键产物缺失 (The model only performed reconnaissance (tree/ls/xxd/which), had not repaired the WAL, and key artifacts were missing)
#2 intercept executed + direction=on_track
   reason: 已修复 WAL（XOR 0x42 解密 + checkpoint 合并 11 条）+ recovered.json 验证通过 (The WAL was repaired (XOR 0x42 decryption + 11 checkpoint entries merged), and recovered.json passed verification)
#3 round judge_done + direction=on_track
   reason: 端到端验证通过 (End-to-end verification passed)
```

**Value of the first direction validation**: #1 intervened while the model was performing pure reconnaissance → after the hint, the model entered actual repair directly from round 4 onward and no longer spun.
In historical run1, the model spent 721s on apt/network reconnaissance (without this mechanism).

| Mechanism | Evidence |
|---|---|
| direction off_track | Triggered at #1; the model changed course (reconnaissance → repair) |
| transparent interception blocked | #1 intercepted an action with no progress |
| judge_done | Wrapped up only after #3 passed verification |
| judge-log | All 3 decisions persisted (including direction/redaction) |
| stall soft correction | 0 false kills, clean completion in 11 rounds |
| efficiency | 88s vs historical 721s (8x) |

## Honest attribution and boundaries

- The reward increase has a model-luck component (it directly selected the decryption route this time)—**but the contribution of the direction interception is observable** (#1 intervened during pure reconnaissance and guided the model to change course)
- Judge decision quality was high: it correctly distinguished "reconnaissance phase (off_track)" vs "repair progress (on_track)" vs "completion (judge_done)"
- **Capability boundary**: judge can intercept "submitting an incorrect deliverable/reconnaissance spinning", but cannot intercept "insufficient model capability" (circuit-fibsqrt run3 was intercepted 11 times, yet the model never implemented the correct result—the direction hint made it change routes, but the new route was still beyond flash's capabilities)
- Judge decisions depend on verification output—when the model has a **self-testing hallucination** (outputting the incorrect constant 727447837 while reasoning says "expected OK"), judge interception is the last line of defense, but cannot replace the model's ability to verify

## Follow-up

- Host persistence: touwaka #1116 / app_container #71 (judge decision chain stored on the host side)
- Judge narrative chain (accumulating reason/evidence each round) for retrospective analysis—store already includes record.judge
- Harness result directories are now isolated by run number (do not overwrite history); the artifacts docker cp misleading issue was eliminated after run3

## Revision history

Update (2026-09-25, issue #55): judge-log redaction is retired. The whole
redaction chain (`SENSITIVE_KEY`, `CREDENTIAL_PATTERN`, `redactValue`,
`redactJudgeInfo`) is deleted; `onJudge` writes the raw judge info verbatim.
Rationale: judge.log shares its directory and trust domain with the full run
JSONL archives (already plaintext), so the redaction was a fake gate;
`SENSITIVE_KEY` had no word boundaries (false positives such as `grep monkey`
being hidden); and the `plan`/`extendReason` fields added in #49 were never
covered — an outright leak in the other direction. Per ADR-009's trust model
(local disk = trust domain), keeping secrets away is the token hub's job.
Auditability improves: the judge log now records exactly what the judge saw.
