# ADR-009: Safety Layering—The Agent Does Not Embed Security; the Sandbox Provides the Jail

> Chinese version: [009-safety-layering_cn.md](009-safety-layering_cn.md)

- Status: Decided (2026-08-30)
- Background: The erix CLI once had a complete built-in security layer (createJail path jail, exec allowlist, syntax interception,
  confirmation mechanism for high-risk operations, maskedPaths redaction). The user decision: **remove it entirely and run bare**.
  Reason: security should not be provided by the agent itself—pi agent has none of these flourishes either; it relies on the runtime
  environment (the user's own container/machine) for isolation. Whoever uses this agent is responsible for security.

## Decision

### 1. The agent (library + CLI) does not embed security policies

- The library (erix-agent) has zero execution and zero security rules (ADR-005 decided this; unchanged).
- The CLI (erix) tool surface is **fully direct**: readFile/writeFile/rg/tree/exec accept any path,
  any shell command, and git has no subcommand restrictions. Remove createJail/allowlists/syntax interception/
  confirmation mechanisms/maskedPaths.

### 2. The sandbox/runtime environment provides the jail

| Runtime scenario | Security layer |
|---|---|
| Local CLI (the user's own machine) | Trust domain = the user; no additional isolation |
| app_container worker | Container sandbox (its responsibility; the agent does not interfere) |
| touwaka | firejail-executor (built by touwaka) |

### 3. Whoever uses it is responsible for security

- CLI help text and the system prompt state: "erix provides no security boundary; the runtime environment is responsible for isolation.
  Do not run it bare in an untrusted environment; embedded container/sandbox scenarios are isolated by the host."
- Responsibility for security issues is transferred: take them to the runtime environment, not the agent.

### 4. Engineering guardrails ≠ security policies (retain)

- exec 10s timeout (prevents hangs), output 4096 truncation (prevents context explosions), non-TTY fallback,
  and session archival—these are engineering behaviors, not security boundaries, and are retained.

### 5. A general-purpose sandbox is an independent component

- If a general-purpose sandbox solution is needed in the future (container templates, filesystem isolation), **provide it as an
  independent component**, decoupled from the agent—"sandbox" and "agent" are fundamentally two different things and must not be mixed into agent code.

## Rationale

- The agent's responsibility is conversation/tool orchestration/context management; the runtime environment is responsible for the
  security boundary. Mixing them both bloats the agent and makes the "security promise" a false guarantee (an embedded allowlist ≠ true isolation).
- After layering: library = pure engine; CLI = thin shell; sandbox = environment. Each of the three components can evolve,
  be tested, and be replaced independently (app_container can change its sandbox approach without affecting the agent layer).

## Consequences

- The tool execution surface is fully open: the model can delete files, push, and write to any path—**running erix in an
  untrusted environment is equivalent to running bare**, and the documentation must state this prominently.
- The library's tools subpath (createJail/file-tools) is retained as a **reference implementation** for callers that need
  to build their own sandbox/guardrails; the CLI does not depend on them.
- If a general-purpose sandbox component is provided later, create a separate ADR rather than merging it into the agent.

## Revision (2026-09)

The earlier decision to retain the path-jail and filesystem helpers as reference
implementations is withdrawn. `createJail` and `createFileTools` have been
removed from the library because no consumer used them, and their names
misleadingly suggested that the library supplied a sandbox. This conflicts with
the principle above that the library provides no security boundary; sandboxing
belongs to the host/runtime.
