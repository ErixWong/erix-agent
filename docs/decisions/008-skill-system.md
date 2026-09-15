# ADR-008: erix Skill System—Script Self-Description Protocol (Simplified touwaka Mechanism)

> Chinese version: [008-skill-system_cn.md](008-skill-system_cn.md)

- Status: Decided (2026-08-29)
- Background: The tools of the erix CLI were hard-coded (`bin/tools.js` built-in readFile/rg/tree + jail).
  Actual user usage ("look at what kind of project this is") exposed the need for **extensible tools**.
  Existing touwaka mechanism as a reference: without an external inventory (skills.md), instead **call the
  functions exported by the skill script itself and let the script say how many tools it has**
  (self-description protocol).
- Key points of the touwaka mechanism (confirmed by reading the existing source):
  - skill = directory + entrypoint script (node/python dual runtimes)
  - script exports `getSkillDefinition()` (v1) or `getTools()` (legacy)
  - host runs the script to obtain SkillDefinition (schema_version/skill/tools), validates it, then registers it
  - when invoking tools, execute a child process by script_path/entrypoint (firejail sandbox)
  - validation rules: schema_version, non-empty skill.id, entrypoint/script_path relative path must not escape
    the skill root, tools array, unique name

## Decision: Three-layer design

### Layer one: Protocol (script self-description)

- Each skill = one directory: `<skills-dir>/<skill-id>/skill.mjs`
- The default entrypoint is `skill.mjs`, exporting `getSkillDefinition()` that returns:

```json
{
  "schema_version": 1,
  "skill": { "id": "<skill-id>", "runtime": "node", "entrypoint": "skill.mjs" },
  "tools": [ /* library's ToolSchema array: name/description/inputSchema */ ]
}
```

- **The host does not maintain an inventory**—import the script and call `getSkillDefinition()`, and the script reports itself (the core of touwaka)
- Compatible with `getTools()` (returns a ToolSchema array, with schema_version recorded as 0/legacy)

### Layer two: Discovery and loading

- Two skill directories: `~/.erix/skills/` (personal global) + `<cwd>/.erix/skills/` (project-local)
- Scan only existing first-level subdirectories; a project skill with the same name takes precedence (the personal one is overridden by the project)
- Validation follows touwaka validateSkillDefinition: schema_version, non-empty skill.id,
  tools array, unique name, entrypoint relative path must not escape the skill root
- A tool name conflicting with a built-in tool (readFile/rg/tree) → report an error and skip that skill (do not silently overwrite)

### Layer three: Execution and security

- **in-process import** (node dynamic import): skills are the user's own scripts, and within the personal CLI
  trust domain no subprocess isolation is needed. touwaka's subprocess/firejail is a multi-tenant sandbox requirement;
  the erix single-user scenario does not need it for now—it is listed as a future enhancement
- Tool input validation goes through `createToolRegistry` (name dispatch + inputSchema validation + friendly return for unknown tools)
- **The security boundary is not embedded in the agent** (ADR-009): skill tools, like built-in tools, are not wrapped
  in a jail and commands are not path-restricted—the runtime environment provides security (the user's machine = trust domain;
  embedded container/sandbox scenarios are isolated by the host). The library's createJail/file-tools are retained as
  reference implementations for callers that need to build their own sandbox
- Result truncation continues to use onToolResult (OUTPUT_LIMIT)

## Command surface

- `erix skills`: list discovery results (the two directories, each skill's id/tool count/validation errors)
- `/skills` inside the repl: show currently loaded skill tools
- Load failures (validation errors/import errors) do not block CLI startup; report them explicitly in `erix skills`/`/skills`

## Rationale

- "Script self-description" does not conflict with ADR-005's "contract in the library, execution in the caller":
  the skill tool definition format is the library's ToolSchema, and the skill script is a "caller-side tool package"
- No inventory to maintain = adding a skill means only placing a directory, with no registration file, matching the touwaka-validated pattern
- in-process simplification: no subprocess protocol (saves two JSON channels, describe/execute), direct debugging,
  and an acceptable security boundary for the personal scenario

## Consequences

- Future enhancements (as needed): subprocess-isolated execution, python runtime, skill dependency declarations,
  skill marketplace/template directory
- Skill examples are included under `examples/skills/` (such as getTime and git status lookup)
- Documentation: add a "Skills" section to README explaining the protocol and directory conventions
