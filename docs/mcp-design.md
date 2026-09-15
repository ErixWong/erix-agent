# MCP Integration Design (erix CLI)

> Chinese version: [mcp-design_cn.md](mcp-design_cn.md)

The goal is to let erix use tools provided by MCP (Model Context Protocol) servers. The client is embedded in the CLI rather than running as a separate long-lived proxy process. Servers start lazily, connections stay alive for the lifetime of the CLI process, and no MCP connection state is persisted across processes.

## Design principles

1. **Single proxy tool**: register exactly one `mcp` tool with the model instead of merging every MCP tool into the model's tool set. Tool metadata is discovered only when the proxy needs it.
2. **Zero dependencies**: `bin/mcp.js` contains a hand-written MCP client using Node built-ins. Stdio uses newline-delimited JSON-RPC; streamable HTTP uses the built-in `fetch`.
3. **Lazy startup and keep-alive**: the first operation that needs a server starts it and performs the MCP handshake. The connection is then reused for later operations in the same CLI process.
4. **Standard configuration shape**: the client reads the `mcpServers` format used by common MCP clients, while applying erix's explicit configuration lookup rules.

## Configuration (`.mcp.json` or `~/.erix/mcp.json`)

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"],
      "env": { "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1" }
    }
  }
}
```

Each entry in `mcpServers` uses one of the supported transports:

- **stdio**: `command` is required, with optional `args` and `env`. The child process is spawned with the CLI's current working directory and an environment formed by overlaying `env` on `process.env`.
- **Streamable HTTP**: `url` is required, with optional `headers`. Requests are sent as JSON-RPC `POST` requests and responses may be `application/json` or `text/event-stream`. A returned `Mcp-Session-Id` is cached and sent on subsequent requests.

When no explicit path is supplied, the lookup order is:

1. `.mcp.json` in the current working directory
2. `~/.erix/mcp.json`

The first existing file wins; the files are not merged. An explicit path is resolved relative to the current working directory and disables fallback lookup. The same `--config <path>` option is accepted by the CLI commands that use MCP. There is no separate `--mcp` flag.

HTTP header values support `!cat <path>`. `~` is expanded to the home directory, and a relative path is resolved relative to the MCP configuration file. The file contents are trimmed before being used as the header value.

If no configuration file is found, MCP is disabled and the `mcp` tool is not registered. Invalid JSON or a configuration without `mcpServers` makes `loadMcpConfig()` fail; `erix mcp` and `/mcp` display that error, while chat and the REPL do not register the proxy. An empty `mcpServers` object also leaves MCP disabled.

## Hand-written client (`bin/mcp.js`)

`bin/mcp.js` creates an internal `McpClient` for each configured server and does not depend on an MCP SDK.

- **Connection**: `connect()` coalesces concurrent connection attempts, reuses an already connected client, and otherwise starts a new transport. The handshake sends `initialize` with protocol version `2025-06-18`, empty client capabilities, and the erix client version, followed by `notifications/initialized`.
- **stdio transport**: the client spawns the configured command, reads newline-delimited JSON-RPC responses, and captures up to 4096 characters of stderr for connection errors. A stdio request times out after 120 seconds.
- **Streamable HTTP transport**: requests use `POST` with `Accept: application/json, text/event-stream`. JSON-RPC response IDs must match the request. SSE responses are read until the matching response ID arrives. HTTP requests and SSE reads time out after 300 seconds.
- **Reconnect behavior**: a failed connection is marked `error` and its failure is retained for status reporting. A later `connect()` call may try the transport again. A failed stdio handshake cleans up the child process. `close()` marks that client closed; `closeAllMcpServers()` closes every pooled client and clears the pool.
- **Tool metadata**: `listTools()` sends `tools/list` after connecting and caches the returned array after the first successful request.
- **Tool calls**: `callTool()` sends `tools/call` with the raw tool name and `args`, defaulting arguments to `{}` when omitted.
- **Connection pool**: clients are pooled by server name, working directory, resolved configuration path, and normalized server configuration. This prevents two configurations that happen to use the same server name from sharing a connection.
- **Result formatting**: text content blocks are joined with newlines. `image` and `resource` blocks, as well as base64 data URLs in text blocks, become `[data-url omitted]`. Results are limited to 4096 characters; oversized results include a truncation notice with the original character count.

Transport and JSON-RPC failures are surfaced as MCP connection errors. When the proxy lists multiple servers, an error for one server is recorded in that server's result and does not prevent the remaining servers from being listed.

## Proxy tool

When `mcpServers` contains at least one entry, the model receives exactly one tool named `mcp`. Its input schema requires `action` and declares the following properties:

- `action`: one of `"list"`, `"search"`, `"call"`, or `"status"`.
- `server`: an optional server name.
- `tool`: an optional tool name or internal ID.
- `args`: an optional object passed to the MCP server.
- `query`: an optional string declared with `maxLength: 100`.

The action behavior is:

- **`list`**: connects to every configured server, obtains each server's tool list, and returns a text summary containing each server's tool count, name, and first description line. A server failure is shown as an error while other servers continue.
- **`search`**: requires a non-empty `query`, connects to every configured server, and matches the lower-cased query against the server name, tool name, and description. Matches include the server, raw tool name, description, and complete input schema. This is metadata search, not internet search.
- **`call`**: requires `tool` and either `server` or an internal ID in the form `mcp_<server>_<tool>`. The parser prefers the longest configured server name, so server names containing underscores are supported. The call returns the formatted textual result.
- **`status`**: reports each configured server's current state, such as `idle`, `connecting`, `connected`, or an error string. Status inspection does not initiate a connection.

The proxy does not register individual MCP tools with the model, does not validate a tool's arguments locally, and does not offer a server filter for `list` or `search`.

## CLI and REPL integration (`bin/cli.js` and `bin/repl.js`)

- `erix chat` and `erix repl` accept `--config <path>`. The selected path is passed to both the normal CLI configuration loader and MCP configuration lookup. Without it, MCP uses the current-directory or home-directory search order described above.
- If MCP is enabled, the CLI and REPL append the single `mcp` schema to their existing tool list and route executions whose name is `mcp` to the proxy.
- `erix mcp [--config <path>]` loads the MCP configuration and prints each configured server with its current connection state. It does not connect to servers merely to display the status.
- The interactive REPL provides `/mcp`, which reports the same configured servers and states. It also reports a malformed MCP configuration instead of silently hiding it.
- Normal chat completion, the CLI entry point's finalization, and REPL shutdown call `closeAllMcpServers()`. In the REPL, `SIGINT` either aborts the active run or closes the interface, which then follows the normal cleanup path. There is no separate `SIGTERM` handler in the CLI integration.

## Tests

The MCP unit tests are in `test/mcp.test.js`. Their fixtures are in the repository-root `fixtures/` directory, not under `test/`:

- `fixtures/mock-mcp-server.mjs` is a zero-dependency stdio server. It implements the `initialize` handshake, `tools/list`, and `tools/call` for four tools: `echo`, `uppercase`, `image`, and `binary`. It can also simulate a failed handshake and write its PID for lifecycle assertions.
- `fixtures/mock-mcp-http-server.mjs` exercises streamable HTTP with JSON responses and SSE responses, session IDs, authorization headers, and deliberately mismatched response IDs.
- Configuration tests cover explicit paths, `.mcp.json` lookup, missing files, valid configuration, invalid JSON, and missing `mcpServers`.
- Proxy tests cover disabled and enabled states, configured server discovery, lazy startup, connection pooling, handshake cleanup, tool-list caching, healthy and broken servers, status reporting, search, calls, `mcp_<server>_<tool>` resolution, server names containing underscores, omitted data content, and result truncation.
- The end-to-end test creates a temporary MCP server and file, then verifies the search-to-call path without requiring an external package or a real `npx` server.
- HTTP tests verify JSON and SSE list/call flows, `!cat` header expansion relative to both the working directory configuration and an explicit configuration file, session reuse, and response-ID validation.

## Red lines

1. Keep `dependencies` empty. MCP code may use Node built-ins and local relative modules only.
2. Do not merge the complete MCP tool catalog into the model tool set; expose only the `mcp` proxy tool.
3. Keep server startup lazy. A configured but unused server must not be spawned.
4. Never commit plaintext keys or tokens. Tests use temporary directories, generated configurations, and mock servers.
5. Keep MCP integration in `bin/`; do not alter the existing `src/` loop or provider implementation for this feature.
6. Always clean up MCP transports when the CLI or REPL exits; no child process or active HTTP request may leak.

## Acceptance

- `node --check bin/mcp.js bin/cli.js bin/repl.js`
- `npm test` passes without skipped MCP coverage.
- `erix mcp [--config <path>]` reports the configured server list and current states.
- `erix chat` and `erix repl` expose one `mcp` tool when a valid MCP configuration is present, and the proxy can complete the `list`, `search`, `call`, and `status` flows.
- Stdio and streamable HTTP fixtures cover handshake, listing, calling, errors, session reuse, and cleanup.
- A manual integration run with a configured filesystem server can exercise the existing command line `erix chat "用 mcp 工具列出 /tmp 下的文件"` and verify the search-to-call path and returned result.
