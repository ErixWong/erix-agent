# MCP 对接设计（erix CLI）

目标：让 erix 能使用 MCP（Model Context Protocol）服务器提供的工具。基于第一性结论：**MCP client 内嵌（无独立常驻代理进程）、server 懒启动 + 会话内 keep-alive、跨会话不保留**（CLI 会话式架构；touwaka 的常驻代理是服务端架构的产物，不适用）。

## 设计原则

1. **单代理工具（proxy tool）模式**（pi-mcp-adapter 同款）：只注册 1 个 `mcp` 工具（~200 tokens），不把几百个 MCP 工具全量合并进工具集（会烧爆上下文窗口——erix 预算 ~52k）
2. **零依赖**：手写 stdio MCP client（newline-delimited JSON-RPC），不引官方 SDK（项目红线：dependencies 保持为空）
3. **懒启动 + keep-alive**：首次用到某 server 才 spawn + initialize；会话内保持连接；CLI 退出清理子进程
4. **配置复用标准格式**：`~/.erix/mcp.json`（或项目 `.mcp.json`）——与 pi/Claude Code 同构，可直接复用现有配置

## 配置（~/.erix/mcp.json）

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

- 本阶段支持 **stdio 传输**（command/args/env）；HTTP 传输（url/headers）列为 TODO
- 配置文件不存在 → MCP 功能不可用（`erix mcp` 提示）

## 客户端（bin/mcp.js，零依赖手写）

- `spawnServer(serverConfig, cwd)`：spawn 子进程（cwd = erix 启动目录），newline-delimited JSON-RPC over stdio
- `connect(serverName)`：懒启动——spawn + `initialize` 握手（协议版本 2025-06-18，capabilities）+ `notifications/initialized`；失败缓存错误（不阻塞其他 server）
- `listTools(serverName)`：`tools/list` → 工具元数据（name/description/inputSchema），缓存
- `callTool(serverName, toolName, args)`：`tools/call` → 结果 content blocks → 文本提取 + 截断
- **连接池**：Map<serverName, { proc, client, tools, status }>——会话内保持，`closeAll()` 在 CLI 退出时杀子进程
- **结果处理**：content blocks 文本拼接，截断 4096；base64/data-url 省略（`[data-url omitted]`）；超时 120s
- **工具 id 规范**：`mcp_<server>_<tool>`（搜索/调用的内部标识）

## 代理工具（注册 1 个 `mcp`，ToolSchema）

```js
{
  name: "mcp",
  description: "访问 MCP 服务器工具。action：list（列全部 server 工具）/ search（按关键词搜工具）/ call（调用工具）/ status（连接状态）；call 需 server/tool/args，search 需 query，其余 action 可选 server 过滤",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "search", "call", "status"] },
      server: { type: "string" },
      tool: { type: "string" },
      args: { type: "object" },
      query: { type: "string", maxLength: 100 }
    },
    required: ["action"]
  }
}
```

行为：
- `list`：遍历配置的 server（懒启动逐个连接），返回 `server: 工具数` + 工具清单摘要（名字 + 一句话 description）
- `search { query }`：在所有元数据里匹配（server/tool/description 包含），返回匹配工具 + 完整 schema（供调用参考）
- `call { server, tool, args }`：内部 id 可用 `mcp_<server>_<tool>` 或分开传；调 callTool，返回文本结果
- `status`：各 server 连接状态（未连接/已连接/错误）

## 集成（bin/cli.js + bin/repl.js）

- 启动时读 mcp.json（不存在则 mcp 工具不注册）
- 工具集追加 `mcp` 代理工具；executeTool 路由：name === "mcp" → mcp 处理器
- 退出时 closeAll（SIGINT/SIGTERM/正常退出）
- 新子命令 `erix mcp`：打印 mcp.json 找到的 server + 连接状态
- repl 加 `/mcp`：同 `erix mcp` 输出

## 测试

- **mock MCP server**（test/fixtures/mock-mcp-server.mjs）：零依赖手写一个假 stdio MCP server——initialize/tools/list（2 个假工具 echo/uppercase）/tools/call 响应；供单测连接/列表/调用/错误路径
- 单测（test/mcp.test.js）：
  - 配置解析（存在/缺失/非法）
  - 连接 + 握手 + tools/list 缓存
  - callTool 调用 + 结果文本提取/截断/base64 省略
  - 懒启动（未用不 spawn）、错误缓存（坏 server 不阻塞）
  - 工具 id 规范 mcp_<server>_<tool>
- e2e：真实 server（npx @modelcontextprotocol/server-filesystem 或本机已有的 MCP 配置）→ `erix chat "用 mcp 调用 xxx"` 验证搜索 + 调用链路
- 现有 201 测试全绿 + 新增，不允许 skip

## 红线

1. dependencies 保持为空（只 import node: 内置 + ../src/ 相对路径）
2. 不把 MCP 工具全量合并进 LLM 工具集（只有 1 个 mcp 代理工具）
3. 懒启动：配置了但没用到的 server 不 spawn
4. 不提交 key 明文；测试用临时目录/mock server
5. 不改 src/ 现有代码（loop/provider 不动）
6. CLI 退出必须清理子进程（不泄漏）

## 验收

- node --check bin/mcp.js bin/cli.js bin/repl.js
- npm test 全绿（201 + 新增）
- `erix mcp` 输出配置 server 列表
- e2e：真实 MCP server（npx filesystem 或本机 mcp.json 复用）——`erix chat "用 mcp 工具列出 /tmp 下的文件"`（filesystem server）能走通 search → call；结果正确返回
- git status 确认只改 bin/ + test/ + docs/mcp-design.md
