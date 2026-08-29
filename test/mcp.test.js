import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeAllMcpServers,
  createMcpProxyTool,
  getMcpPoolStatus,
  listMcpServerTools,
  loadMcpConfig,
  resolveMcpConfigPath,
  truncateResult,
} from "../bin/mcp.js";

const mockServerPath = fileURLToPath(
  new URL("../fixtures/mock-mcp-server.mjs", import.meta.url),
);

async function withTempDir(callback) {
  const dir = await mkdtemp(join(tmpdir(), "erix-mcp-test-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function writeMcpConfig(dir, servers) {
  return writeFile(
    join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: servers }, null, 2),
    "utf8",
  );
}

async function withMcpCleanup(callback) {
  try {
    return await callback();
  } finally {
    await closeAllMcpServers();
  }
}

test("resolveMcpConfigPath resolves explicit path", () => {
  assert.equal(resolveMcpConfigPath("/tmp/explicit.json"), "/tmp/explicit.json");
  assert.equal(resolveMcpConfigPath("/tmp/explicit.json", "/other"), "/tmp/explicit.json");
  assert.equal(resolveMcpConfigPath(), null);
});

test("resolveMcpConfigPath finds .mcp.json in cwd", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, {});
    assert.equal(resolveMcpConfigPath(undefined, dir), join(dir, ".mcp.json"));
  });
});

test("resolveMcpConfigPath returns null when no config exists", async () => {
  await withTempDir(async (dir) => {
    assert.equal(resolveMcpConfigPath(undefined, dir), null);
  });
});

test("loadMcpConfig returns null when no config is found", async () => {
  await withTempDir(async (dir) => {
    assert.equal(loadMcpConfig(undefined, dir), null);
  });
});

test("loadMcpConfig loads a valid mcpServers config", async () => {
  await withTempDir(async (dir) => {
    const servers = { mock: { command: "node", args: [mockServerPath] } };
    await writeMcpConfig(dir, servers);
    const config = loadMcpConfig(undefined, dir);
    assert.deepEqual(config, { mcpServers: servers });
  });
});

test("loadMcpConfig throws when mcpServers is missing", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, ".mcp.json"), "{}", "utf8");
    assert.throws(() => loadMcpConfig(undefined, dir), /缺少 mcpServers/);
  });
});

test("loadMcpConfig throws on invalid JSON", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, ".mcp.json"), "{ not json", "utf8");
    assert.throws(() => loadMcpConfig(undefined, dir), /读取 MCP 配置失败/);
  });
});

test("createMcpProxyTool is disabled without config", async () => {
  await withTempDir(async (dir) => {
    const proxy = createMcpProxyTool({ cwd: dir });
    assert.equal(proxy.enabled, false);
    assert.equal(proxy.schema, undefined);
  });
});

test("createMcpProxyTool is disabled when config is invalid", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, ".mcp.json"), "{ not json", "utf8");
    const proxy = createMcpProxyTool({ cwd: dir });
    assert.equal(proxy.enabled, false);
    assert.ok(proxy.error);
  });
});

test("createMcpProxyTool is enabled with a valid config", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, { mock: { command: "node", args: [mockServerPath] } });
    const proxy = createMcpProxyTool({ cwd: dir });
    assert.equal(proxy.enabled, true);
    assert.equal(proxy.schema.name, "mcp");
  });
});

test("createMcpProxyTool exposes configured server names", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, {
      mock: { command: "node", args: [mockServerPath] },
      other: { command: "node", args: [mockServerPath] },
    });
    const proxy = createMcpProxyTool({ cwd: dir });
    assert.deepEqual(proxy.listConfiguredServers().sort(), ["mock", "other"]);
  });
});

test("createMcpProxyTool is lazy and does not spawn before use", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, { mock: { command: "node", args: [mockServerPath] } });
    await withMcpCleanup(() => {
      const proxy = createMcpProxyTool({ cwd: dir });
      assert.deepEqual(getMcpPoolStatus(), {});
      assert.deepEqual(proxy.status(), { mock: "idle" });
      return Promise.resolve();
    });
  });
});

test("execute list connects, handshakes, and returns tools", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, { mock: { command: "node", args: [mockServerPath] } });
    await withMcpCleanup(async () => {
      const proxy = createMcpProxyTool({ cwd: dir });
      const result = await proxy.execute({ action: "list" });
      assert.match(result, /mock：4 个工具/);
      assert.match(result, /echo/);
      assert.match(result, /uppercase/);
      assert.deepEqual(getMcpPoolStatus(), { mock: "connected" });
    });
  });
});

test("listMcpServerTools caches tools after first call", async () => {
  await withTempDir(async (dir) => {
    const cfg = { command: "node", args: [mockServerPath] };
    await withMcpCleanup(async () => {
      const first = await listMcpServerTools("mock", cfg, dir);
      assert.equal(first.length, 4);
      const second = await listMcpServerTools("mock", cfg, dir);
      assert.equal(first, second);
    });
  });
});

test("execute search finds tools by keyword", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, { mock: { command: "node", args: [mockServerPath] } });
    await withMcpCleanup(async () => {
      const proxy = createMcpProxyTool({ cwd: dir });
      const result = await proxy.execute({ action: "search", query: "uppercase" });
      assert.match(result, /uppercase/);
      assert.match(result, /mock/);
      const parsed = JSON.parse(result);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].server, "mock");
      assert.equal(parsed[0].tool, "uppercase");
    });
  });
});

test("execute search reports no matches", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, { mock: { command: "node", args: [mockServerPath] } });
    await withMcpCleanup(async () => {
      const proxy = createMcpProxyTool({ cwd: dir });
      const result = await proxy.execute({ action: "search", query: "nothing" });
      assert.match(result, /未找到/);
    });
  });
});

test("execute call invokes a tool and returns text", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, { mock: { command: "node", args: [mockServerPath] } });
    await withMcpCleanup(async () => {
      const proxy = createMcpProxyTool({ cwd: dir });
      const result = await proxy.execute({
        action: "call",
        server: "mock",
        tool: "echo",
        args: { message: "hello" },
      });
      assert.equal(result, "hello");
    });
  });
});

test("execute call resolves mcp_<server>_<tool> id", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, { mock: { command: "node", args: [mockServerPath] } });
    await withMcpCleanup(async () => {
      const proxy = createMcpProxyTool({ cwd: dir });
      const result = await proxy.execute({
        action: "call",
        tool: "mcp_mock_echo",
        args: { message: "via-id" },
      });
      assert.equal(result, "via-id");
    });
  });
});

test("execute call returns uppercase result", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, { mock: { command: "node", args: [mockServerPath] } });
    await withMcpCleanup(async () => {
      const proxy = createMcpProxyTool({ cwd: dir });
      const result = await proxy.execute({
        action: "call",
        server: "mock",
        tool: "uppercase",
        args: { text: "abc" },
      });
      assert.equal(result, "ABC");
    });
  });
});

test("execute call omits image content blocks", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, { mock: { command: "node", args: [mockServerPath] } });
    await withMcpCleanup(async () => {
      const proxy = createMcpProxyTool({ cwd: dir });
      const result = await proxy.execute({ action: "call", server: "mock", tool: "image" });
      assert.equal(result.trim(), "[data-url omitted]");
    });
  });
});

test("execute call omits base64 data URLs in text", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, { mock: { command: "node", args: [mockServerPath] } });
    await withMcpCleanup(async () => {
      const proxy = createMcpProxyTool({ cwd: dir });
      const result = await proxy.execute({ action: "call", server: "mock", tool: "binary" });
      assert.equal(result.trim(), "[data-url omitted]");
    });
  });
});

test("execute call returns an error for an unknown tool", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, { mock: { command: "node", args: [mockServerPath] } });
    await withMcpCleanup(async () => {
      const proxy = createMcpProxyTool({ cwd: dir });
      const result = await proxy.execute({
        action: "call",
        server: "mock",
        tool: "missing",
      });
      assert.match(result, /Unknown tool: missing/);
    });
  });
});

test("truncateResult caps oversized output and reports length", () => {
  const oversized = "x".repeat(4097);
  const result = truncateResult(oversized);
  assert.equal(result.length, 4096 + "\n[MCP 结果已截断，共 4097 字符]".length);
  assert.match(result, /\[MCP 结果已截断，共 4097 字符\]$/);
});

test("broken server does not block a healthy server in list", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, {
      healthy: { command: "node", args: [mockServerPath] },
      broken: { command: "definitely-not-a-command-" + Date.now(), args: [] },
    });
    await withMcpCleanup(async () => {
      const proxy = createMcpProxyTool({ cwd: dir });
      const result = await proxy.execute({ action: "list" });
      assert.match(result, /healthy：4 个工具/);
      assert.match(result, /broken：错误/);
      assert.match(result, /definitely-not-a-command/);
    });
  });
});

test("status reports errors for broken servers", async () => {
  await withTempDir(async (dir) => {
    const badCommand = "definitely-not-a-command-" + Date.now();
    await writeMcpConfig(dir, {
      broken: { command: badCommand, args: [] },
    });
    await withMcpCleanup(async () => {
      const proxy = createMcpProxyTool({ cwd: dir });
      // Trigger connection attempt via list, which marks server as error.
      await proxy.execute({ action: "list" });
      const result = proxy.status();
      assert.match(result.broken, /错误/);
      assert.match(result.broken, /definitely-not-a-command/);
    });
  });
});

test("e2e: real MCP server is searchable and callable", async () => {
  await withTempDir(async (dir) => {
    const serverPath = join(dir, "fs-server.mjs");
    const targetFile = join(dir, "hello.txt");
    await writeFile(targetFile, "world", "utf8");
    await writeFile(
      serverPath,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
const rl = createInterface({ input: process.stdin });
function send(message) { console.log(JSON.stringify(message)); }
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "temp-fs", version: "1.0.0" }, capabilities: { tools: {} } } });
  } else if (req.method === "notifications/initialized") {
    return;
  } else if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] } });
  } else if (req.method === "tools/call") {
    const { name, arguments: args } = req.params;
    if (name === "read_file") {
      const text = readFileSync(args.path, "utf8");
      send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text }] } });
    } else {
      send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "unknown tool" }], isError: true } });
    }
  }
});`,
      "utf8",
    );
    await writeMcpConfig(dir, {
      tempfs: { command: "node", args: [serverPath] },
    });
    await withMcpCleanup(async () => {
      const proxy = createMcpProxyTool({ cwd: dir });
      const searchResult = await proxy.execute({ action: "search", query: "read" });
      assert.match(searchResult, /read_file/);
      assert.match(searchResult, /tempfs/);
      const callResult = await proxy.execute({
        action: "call",
        tool: "mcp_tempfs_read_file",
        args: { path: targetFile },
      });
      assert.equal(callResult, "world");
    });
  });
});
