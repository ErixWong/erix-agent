# ADR-001: Route LLM Configuration Through ModelConfigProvider Adapters, with Built-in json-file

> Chinese version: [001-config-adapters_cn.md](001-config-adapters_cn.md)

- Status: Decided (2026-08-29)
- Background: The two consumers have completely different sources for LLM configuration—app_container stores it in the `system_settings` table
  (write-only keys + window metadata from the `pi_models` table + env fallback); touwaka stores it in the MySQL model table + expert configuration.
  The library cannot and should not prescribe storage.

## Decision

The library defines the `ModelConfigProvider` interface (`resolve(slot?) → ModelConfig`), with three built-in implementations:

| Adapter | Purpose |
|---|---|
| `static` | Tests/callers pass an object directly |
| `env` | Environment variables only (`LLM_KIT_PROTOCOL/ENDPOINT/MODEL/API_KEY/…`) |
| `json-file` | **Simplest usable form**: one JSON file describes all slots |

Example of the json-file form:

```json
{
  "slots": {
    "default": { "protocol": "anthropic", "endpoint": "https://…", "model": "claude-…",
                 "apiKeyFile": "/home/eric/.config/mcp/creds/llm.key",
                 "contextWindowTokens": 200000, "maxOutputTokens": 8192 },
    "fold":    { "protocol": "openai", "endpoint": "https://…", "model": "qwen-flash",
                 "apiKeyEnv": "FOLD_API_KEY" }
  }
}
```

**Three-level indirect apiKey references (first-class)**: `apiKey` (provided directly) → `apiKeyEnv` (environment variable name) →
`apiKeyFile` (600 credential file, aligned with the platform `~/.config/mcp/creds/` convention).
Referencing a credential file allows the configuration JSON itself to be stored in a database or checked into a repository without containing secret keys.

**slot (optional task-specific model slot)**: If `resolve("fold")` cannot obtain a configuration, it falls back to `"default"`.
This corresponds to the "future lightweight per-task extension" reserved in app_container pi-agent-runtime.md §8.7—
the library implements the slot mechanism from day one, while project-side configuration can always use only default.

## Rationale

- The filesystem is the lowest common denominator: any project (including scripts, workers, and local debugging) can use it, with zero infrastructure.
- DB adapters (the app_container system_settings wrapper and touwaka's model service wrapper) stay on the project side;
  implementing the same interface is all that is required, and no DB dependency appears in the library.
- v1 does not do caching/hot reload: `resolve()` reads the file every time (one small file read, with negligible cost);
  callers that need caching wrap it themselves. Simple and always correct.

## Consequences

- Project-side integration = write a 30-line provider wrapper.
- Adding remote configuration in the future (such as Consul/etcd) requires only a new adapter; the interface does not change.
