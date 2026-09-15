# ADR-006: ToolProvider Layering—Pluggable Definitions (json/db), with Executors Always in Code

> Chinese version: [006-tool-provider_cn.md](006-tool-provider_cn.md)

- Status: Decided (2026-08-29)
- Background: The user proposed that tool definitions should also use a provider—load the json layer from disk and the db layer from a database,
  with configuration deciding the source. The request is valid: app_container's audit/development agents expose different tool surfaces
  (currently two frozen arrays in code), and touwaka's experts each have their own tool configuration (already in the DB);
  "change the tool surface without changing code" is a real need. **But one hole must be closed first.**

## Key correction: schema is data, executor is code

A tool = definition (name/description/input_schema) + executor (function). Definitions may come from anywhere,
**but executors can only be functions registered in the process**—otherwise "adding one record to the DB gives you new execution capability",
which turns app_container's whitelist security boundary into writable data and crosses the red line directly.

Therefore the layered semantics are:

> **The executor registry defines the "capability universe" (code, reviewed by code review);
> ToolProvider only performs "selection and configuration" (data)—deciding what to expose and overriding descriptions/parameters.**

If the DB contains a tool name without a corresponding executor, startup reports an error (fail closed), rather than discovering it only at runtime.

## Decision

### Interface

```js
/**
 * @typedef {Object} ToolProvider
 * @property {(sel?: { set?: string }) => Promise<ToolSchema[]>} listTools
 * // set: tool set name (such as app_container's "audit" / "dev"); defaults to the default set
 */

// Executor registry (code side, capability universe)
createToolRegistry({
  executors: { [name]: (input, ctx) => Promise<string> },
  schemas: ToolSchema[],            // baseline definitions in code (authoritative version of description)
}) => {
  executeTool,                      // feed directly to runToolLoop
  resolveTools: (provider, sel) => Promise<ToolSchema[]>,  // intersect with provider + apply overrides
}
```

`resolveTools` semantics: every schema returned by the provider **must** match an executor in the
registry, otherwise throw `tool_unknown_executor` (fail closed); the provider may override description
and input_schema parameter constraints (such as reducing maxLength), but may not change the name or meaning.

### Built-in ToolProviders

| Adapter | Form | Purpose |
|---|---|---|
| `static` | Code array (= the current state of both projects) | Default; schema changes go through code review |
| `json-file` | `dir/tools.json` or `dir/*.json`, containing tool-set definitions | Tool surface configurable on disk; files can enter the repository through review |
| `composite` | Multiple providers merged by priority | Code baseline + DB overlay |

The DB adapter remains project-side (touwaka's expert tool configuration and app_container's future
settings-page tool management), implementing the same interface.

### Integration with the loop

`runToolLoop` continues to accept the existing `tools` + `executeTool`; add a convenience entry:
when `registry` + `toolProvider` + `set` are passed, first call `resolveTools` internally and then enter the loop.
Before calling an executor, the loop validates inputs against the schema (required/type/maxLength, with a minimal zero-dependency validator);
validation failure goes directly to tool_result as an error without touching the executor (lowering app_container's existing behavior into the library).

## Rationale

- "The universe is in code, selection is in data" simultaneously enables operational configuration of the tool surface (change descriptions/toggles without a release)
  and preserves the security red line (data cannot add capabilities).
- Putting json-file in the repository makes tool-definition changes reviewable; the DB layer is reserved for genuine operational needs (toggle by expert/task type),
  with the two responsibilities naturally separated and composite supporting overlays.
- Fail-closed intersection semantics make configuration errors explode at startup rather than being discovered halfway through an LLM call.

## Consequences

- v0.2 lands together with the tools subpath (the registry produces executeTool and lives in the same package as ADR-005's Layer Two).
- Project-side migration: app_container turns `PI_TOOL_SCHEMAS`/`PI_DEV_TOOL_SCHEMAS` into a static provider + registry registration;
  touwaka wraps its toolManager in a DB ToolProvider.
- The documentation must state: **never implement an adapter that "registers executors from data"** (for example, storing JS code in a DB and evaling it)—
  that is RCE as a service.
