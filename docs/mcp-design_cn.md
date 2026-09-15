# MCP 集成设计（erix CLI）

> English version: [mcp-design.md](mcp-design.md)

目标是让 erix 使用 MCP（Model Context Protocol）server 提供的工具。客户端内嵌在 CLI 中，而不是作为独立的长驻 proxy 进程运行。server 按需启动，连接在 CLI 进程的生命周期内保持，跨进程不持久化任何 MCP 连接状态。

## 设计原则

1. **单一 proxy 工具**：向 model 注册恰好一个 `mcp` 工具，而不是把每个 MCP 工具合并进 model 的工具集。只有 proxy 需要工具元数据时才发现它们。
2. **零依赖**：`bin/mcp.js` 使用 Node 内置模块手写 MCP client。stdio 使用按行分隔的 JSON-RPC；streamable HTTP 使用内置的 `fetch`。
3. **懒启动与 keep-alive**：首次需要某个 server 的操作会启动它并执行 MCP 握手。之后在同一个 CLI 进程中复用该连接。
4. **标准配置形状**：客户端读取常见 MCP client 使用的 `mcpServers` 格式，同时应用 erix 明确的配置查找规则。

## 配置（`.mcp.json` 或 `~/.erix/mcp.json`）

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

`mcpServers` 中的每个条目使用一种受支持的 transport：

- **stdio**：必须提供 `command`，可选 `args` 和 `env`。子进程使用 CLI 当前工作目录启动，环境由将 `env` 覆盖到 `process.env` 上形成。
- **Streamable HTTP**：必须提供 `url`，可选 `headers`。请求以 JSON-RPC `POST` 发送，响应可以是 `application/json` 或 `text/event-stream`。返回的 `Mcp-Session-Id` 会被缓存，并在后续请求中发送。

未提供显式路径时，查找顺序是：

1. 当前工作目录中的 `.mcp.json`
2. `~/.erix/mcp.json`

第一个存在的文件优先；不会合并两个文件。显式路径相对于当前工作目录解析，并禁用回退查找。使用 MCP 的 CLI 命令都接受相同的 `--config <path>` 选项。没有单独的 `--mcp` flag。

HTTP header 值支持 `!cat <path>`。`~` 会展开为 home 目录，相对路径相对于 MCP 配置文件解析。文件内容在用作 header 值前会先 trim。

找不到配置文件时，MCP 被禁用，不注册 `mcp` 工具。无效 JSON 或缺少 `mcpServers` 的配置会使 `loadMcpConfig()` 失败；`erix mcp` 和 `/mcp` 会显示该错误，而 chat 和 REPL 不会注册 proxy。空的 `mcpServers` 对象同样会使 MCP 保持禁用。

## 手写 client（`bin/mcp.js`）

`bin/mcp.js` 为每个已配置的 server 创建内部 `McpClient`，不依赖 MCP SDK。

- **连接**：`connect()` 合并并发连接尝试，复用已经连接的 client，否则启动新的 transport。握手使用协议版本 `2025-06-18`、空的 client capabilities 和 erix client version 发送 `initialize`，随后发送 `notifications/initialized`。
- **stdio transport**：client 启动已配置的 command，读取按行分隔的 JSON-RPC 响应，并为连接错误捕获最多 4096 个字符的 stderr。stdio 请求在 120 秒后超时。
- **Streamable HTTP transport**：请求使用 `POST`，并设置 `Accept: application/json, text/event-stream`。JSON-RPC 响应 ID 必须匹配请求。收到 SSE 响应后，会一直读取到匹配的响应 ID。HTTP 请求和 SSE 读取在 300 秒后超时。
- **重连行为**：连接失败会被标记为 `error`，并保留该失败供状态报告使用。后续 `connect()` 调用可以再次尝试 transport。stdio 握手失败会清理子进程。`close()` 将该 client 标记为 closed；`closeAllMcpServers()` 关闭池中的每个 client 并清空连接池。
- **工具元数据**：连接后，`listTools()` 发送 `tools/list`，并在第一次成功请求后缓存返回的数组。
- **工具调用**：`callTool()` 使用原始工具名和 `args` 发送 `tools/call`；省略参数时默认使用 `{}`。
- **连接池**：client 按 server name、工作目录、解析后的配置路径和规范化的 server 配置进行池化。这会避免两个碰巧使用同一 server name 的配置共享连接。
- **结果格式化**：文本 content block 用换行连接。`image` 和 `resource` block，以及文本 block 中的 base64 data URL，都会变为 `[data-url omitted]`。结果限制为 4096 个字符；超大结果会带有包含原始字符数的截断提示。

Transport 和 JSON-RPC 失败会作为 MCP connection errors 暴露。当 proxy 列出多个 server 时，某个 server 的错误会记录在该 server 的结果中，不会阻止其余 server 被列出。

## Proxy 工具

当 `mcpServers` 至少包含一个条目时，model 恰好收到一个名为 `mcp` 的工具。其输入 schema 要求 `action`，并声明以下属性：

- `action`：可以是 `"list"`、`"search"`、`"call"` 或 `"status"` 之一。
- `server`：可选的 server name。
- `tool`：可选的工具名或内部 ID。
- `args`：传给 MCP server 的可选对象。
- `query`：可选字符串，声明了 `maxLength: 100`。

各 action 的行为如下：

- **`list`**：连接每个已配置的 server，取得其工具列表，并返回文本摘要，其中包含每个 server 的工具数、名称和 description 的第一行。某个 server 失败时显示错误，但其他 server 继续处理。
- **`search`**：要求非空的 `query`，连接每个已配置的 server，并将小写后的 query 与 server name、tool name 和 description 匹配。匹配结果包含 server、原始工具名、description 和完整 input schema。这是元数据搜索，不是互联网搜索。
- **`call`**：要求 `tool`，以及 `server` 或形如 `mcp_<server>_<tool>` 的内部 ID。解析器优先使用最长的已配置 server name，因此包含下划线的 server name 也受支持。调用返回格式化后的文本结果。
- **`status`**：报告每个已配置 server 的当前状态，例如 `idle`、`connecting`、`connected` 或错误字符串。状态检查不会发起连接。

Proxy 不会向 model 注册单个 MCP 工具，不会在本地校验工具参数，也不会为 `list` 或 `search` 提供 server filter。

## CLI 与 REPL 集成（`bin/cli.js` 和 `bin/repl.js`）

- `erix chat` 和 `erix repl` 接受 `--config <path>`。选定的路径同时传给普通 CLI 配置加载器和 MCP 配置查找。没有该选项时，MCP 使用上文所述的当前目录或 home 目录查找顺序。
- 如果 MCP 已启用，CLI 和 REPL 会将单个 `mcp` schema 追加到已有工具列表，并将名称为 `mcp` 的执行路由到 proxy。
- `erix mcp [--config <path>]` 加载 MCP 配置，打印每个已配置 server 及其当前连接状态。它不会仅为了显示状态而连接 server。
- 交互式 REPL 提供 `/mcp`，报告同样的已配置 server 和状态。它也会报告格式错误的 MCP 配置，而不是静默隐藏。
- 普通 chat completion、CLI 入口的 finalization 和 REPL shutdown 都会调用 `closeAllMcpServers()`。在 REPL 中，`SIGINT` 要么 abort 活跃的 run，要么关闭 interface，之后都会遵循正常的清理路径。CLI 集成没有单独的 `SIGTERM` handler。

## 测试

MCP 单元测试位于 `test/mcp.test.js`。fixture 位于仓库根目录的 `fixtures/`，而不是 `test/` 下：

- `fixtures/mock-mcp-server.mjs` 是零依赖的 stdio server。它实现 `initialize` 握手、`tools/list` 和 `tools/call`，支持四个工具：`echo`、`uppercase`、`image` 和 `binary`。它还可以模拟握手失败，并写出自己的 PID 供生命周期断言使用。
- `fixtures/mock-mcp-http-server.mjs` 测试带 JSON 响应和 SSE 响应的 streamable HTTP、session ID、authorization headers，以及故意不匹配的响应 ID。
- 配置测试覆盖显式路径、`.mcp.json` 查找、文件缺失、有效配置、无效 JSON 和缺少 `mcpServers`。
- Proxy 测试覆盖禁用和启用状态、已配置 server 发现、懒启动、连接池、握手清理、工具列表缓存、正常和损坏的 server、状态报告、搜索、调用、`mcp_<server>_<tool>` 解析、包含下划线的 server name、省略的数据内容以及结果截断。
- 端到端测试创建临时 MCP server 和文件，然后验证 search-to-call 路径，无需外部 package 或真实的 `npx` server。
- HTTP 测试验证 JSON 和 SSE list/call 流程、相对于工作目录配置和显式配置文件的 `!cat` header 展开、session 复用以及响应 ID 校验。

## 红线

1. 保持 `dependencies` 为空。MCP 代码只能使用 Node 内置模块和本地相对模块。
2. 不要将完整的 MCP 工具目录合并进 model 工具集；只暴露 `mcp` proxy 工具。
3. 保持 server 懒启动。已配置但未使用的 server 不得启动。
4. 绝不提交明文 key 或 token。测试使用临时目录、生成的配置和 mock server。
5. MCP 集成保持在 `bin/` 中；不要为此功能修改现有的 `src/` loop 或 provider 实现。
6. CLI 或 REPL 退出时始终清理 MCP transport；不得泄漏子进程或活跃的 HTTP 请求。

## 验收

- `node --check bin/mcp.js bin/cli.js bin/repl.js`
- `npm test` 在没有跳过 MCP 覆盖的情况下通过。
- `erix mcp [--config <path>]` 报告已配置的 server 列表和当前状态。
- 存在有效 MCP 配置时，`erix chat` 和 `erix repl` 暴露一个 `mcp` 工具，并且 proxy 可以完成 `list`、`search`、`call` 和 `status` 流程。
- Stdio 和 streamable HTTP fixtures 覆盖握手、列表、调用、错误、session 复用和清理。
- 使用已配置的 filesystem server 进行手动集成运行，可以执行现有命令行 `erix chat "用 mcp 工具列出 /tmp 下的文件"`，并验证 search-to-call 路径及返回结果。
