# ADR-005: Three Layers of the Tool System—Contract in the Library, Execution in the Caller, Reference Implementations via a Subpath

> Chinese version: [005-tool-system_cn.md](005-tool-system_cn.md)

- Status: Decided (2026-08-29)
- Background: The most difficult issue. Two constraints pull in opposite directions:
  - app_container's red line: "The LLM only sends tool-call requests; trusted code validates the whitelist and forwards them,
    and the LLM has no direct execution surface"—**the library must never include tools that execute things**.
  - But having no built-ins means every project rewrites readFile/rg/tree and the path jail—and this
    **logic itself** is generic.

## Decision: Three-layer separation

### Layer One: Tool contract (core package, zero tools)

- Specify `ToolSchema` (JSON Schema inputs); **protocol serialization is handled by the adapter**
  (OpenAI `tools[].function` ⇄ Anthropic `tools[].input_schema`; callers write it only once).
- The `executeTool(name, input)` callback is the loop's only execution entry point; the implementation always belongs to the caller.
- `onToolResult` hook: the post-processing point before results are fed back to the LLM (truncation/redaction/scanning);
  project policies (such as app_container's secret recheck) attach here; the library provides the mounting point, not the rules.

### Layer Two: Optional tool library (`erix-agent/tools` subpath export, v0.2)

It is not part of the main export; it is available only through an explicit `import … from "erix-agent/tools"`. Three parts:

1. **`createJail({ root, writable = [], maskedPaths = [] })`**—path-jail helper.
   After resolution the path must still be inside root (an out-of-bounds path throws), writes are limited to writable subtrees, and maskedPaths cannot be read.
   This is pure logic needed by both projects and is worth sharing because it is unrelated to "what to execute".
2. **Reference filesystem tools** (readFile/rg/tree/writeFile)—built on the jail,
   suitable for direct use in scripts/prototypes/low-risk scenarios; production scenarios may copy or replace them.
3. **`recall` tool** (explicitly requested as built-in)—built on TranscriptStore:

```
recall({ fromRound?, toRound?, pattern? }) → excerpts of original text from folded rounds
```

Summaries uniformly say "the early N rounds have been folded; use recall(fromRound: X, toRound: Y) to retrieve them".
**Folding thereby changes from lossy to nearly lossless**—this is the library's core increment over the two predecessors,
and also why recall must be built in: it and the compaction strategy are two sides of the same coin; separating them breaks the link.

### Layer Three: Never part of the library

Whitelist validation policy, container exec, network tools, and business tools (document retrieval/notes/embedding…).
These carry the project's security model and business semantics; sharing them would leak the abstraction.

## Rationale

- "Shared contract, private execution" satisfies both the security red line and the deduplication request:
  touwaka's toolManager and app_container's tools.js only need to convert their schema to the standard format;
  the execution body does not change at all.
- A subpath export makes "use the reference implementation" an explicit choice rather than the default, increasing the cost of misuse.
- recall depends on the store interface rather than a concrete implementation: a memory store can also recall (for an in-process task),
  while a file store is naturally persistent.

## Consequences

- Project-side migration work = schema format conversion + (optionally) switching to `createJail`.
- The reference implementation's quality boundary must be stated in the documentation: "reference-grade, use with caution in production; build your own execution layer for serious scenarios".
- If a third consumer later needs a new protocol (Gemini), only the first-layer adapter changes; layers two and three are unaffected.
