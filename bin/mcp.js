#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CALL_TIMEOUT_MS = 120_000;
const HTTP_TIMEOUT_MS = 300_000;
const RESULT_LIMIT = 4096;
const DEFAULT_MCP_CONFIG_PATHS = [
  () => path.join(process.cwd(), ".mcp.json"),
  () => path.join(homedir(), ".erix", "mcp.json"),
];

function readVersion() {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    return packageJson.version;
  } catch {
    return "0.0.0";
  }
}

export function resolveMcpConfigPath(explicitPath, cwd = process.cwd()) {
  if (explicitPath) return path.resolve(explicitPath);
  const candidates = [path.join(cwd, ".mcp.json"), path.join(homedir(), ".erix", "mcp.json")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function loadMcpConfig(configPath, cwd = process.cwd()) {
  const resolved = resolveMcpConfigPath(configPath, cwd);
  if (!resolved) return null;
  try {
    const raw = readFileSync(resolved, "utf8");
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object" || !config.mcpServers) {
      throw new Error(`MCP 配置文件缺少 mcpServers：${resolved}`);
    }
    return config;
  } catch (error) {
    throw new Error(`读取 MCP 配置失败：${error?.message ?? String(error)}`);
  }
}

function expandTilde(input) {
  if (typeof input !== "string") return input;
  if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
  if (input === "~") return homedir();
  return input;
}

function expandHeaderValue(value, configDir) {
  if (typeof value !== "string") return value;
  if (!value.startsWith("!cat ")) return value;
  let filePath = value.slice(5).trim();
  filePath = expandTilde(filePath);
  if (!path.isAbsolute(filePath)) {
    filePath = path.resolve(configDir, filePath);
  }
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch (error) {
    throw new Error(`读取 header 文件失败 ${filePath}：${error?.message ?? String(error)}`);
  }
}

function resolveConfigDir(configPath, cwd) {
  const resolved = configPath ? path.resolve(configPath) : resolveMcpConfigPath(undefined, cwd);
  return resolved ? path.dirname(resolved) : cwd;
}

class McpConnectionError extends Error {
  constructor(serverName, message) {
    super(`MCP server "${serverName}"：${message}`);
    this.name = "McpConnectionError";
    this.serverName = serverName;
  }
}

class McpClient {
  constructor(serverName, serverConfig, cwd) {
    this.serverName = serverName;
    this.serverConfig = serverConfig;
    this.cwd = cwd;
    this.configDir = resolveConfigDir(undefined, cwd);
    this.nextId = 1;
    this.pending = new Map();
    this.tools = null;
    this.status = "idle";
    this.error = null;
    this.stderrBuffer = "";
    this.proc = null;
    this.reader = null;
    this.connectPromise = null;
    this.closed = false;

    // HTTP transport state
    this.url = serverConfig.url ?? null;
    this.headers = resolveHeaders(serverConfig.headers, this.configDir);
    this.sessionId = null;
    this.httpControllers = new Set();
  }

  async connect() {
    if (this.connectPromise) return this.connectPromise;
    if (this.status === "connected") return;
    this.connectPromise = this._doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  _doConnect() {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new McpConnectionError(this.serverName, "连接已关闭"));
        return;
      }

      const { command, args = [], env = {}, url } = this.serverConfig;

      if (url) {
        this._doHttpConnect(resolve, reject);
        return;
      }

      if (typeof command !== "string" || command.trim() === "") {
        this.status = "error";
        this.error = new McpConnectionError(this.serverName, "缺少 command 或 url");
        reject(this.error);
        return;
      }

      this.status = "connecting";
      const child = spawn(command, args, {
        cwd: this.cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = child;

      const onChildError = (error) => {
        this.status = "error";
        this.error = new McpConnectionError(
          this.serverName,
          `启动失败：${error?.message ?? String(error)}`,
        );
        reject(this.error);
      };

      const onChildExit = (code, signal) => {
        this._rejectPending(
          new McpConnectionError(
            this.serverName,
            `进程已退出（code=${code ?? "未知"}, signal=${signal ?? "未知"}）`,
          ),
        );
        if (this.status === "connecting") {
          const hint = this.stderrBuffer ? `；stderr：${this.stderrBuffer.trim()}` : "";
          this.status = "error";
          this.error = new McpConnectionError(
            this.serverName,
            `子进程在握手前退出${hint}`,
          );
          reject(this.error);
        }
      };

      child.on("error", onChildError);
      child.on("exit", onChildExit);
      child.stderr.on("data", (chunk) => {
        this.stderrBuffer += String(chunk ?? "");
        if (this.stderrBuffer.length > 4096) {
          this.stderrBuffer = this.stderrBuffer.slice(-4096);
        }
      });

      this.reader = createInterface({ input: child.stdout });
      this.reader.on("line", (line) => this._handleLine(line));
      this.reader.on("close", () => {
        if (!this.closed && this.status !== "error") {
          this._rejectPending(
            new McpConnectionError(this.serverName, "stdout 已关闭"),
          );
          this.status = "error";
          this.error = this.error || new McpConnectionError(this.serverName, "stdout 已关闭");
        }
      });

      this._request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "erix", version: readVersion() },
      })
        .then(() => {
          this._notify("notifications/initialized", {});
          this.status = "connected";
          resolve();
        })
        .catch((error) => {
          this.status = "error";
          this.error = error;
          reject(error);
        });
    });
  }

  async _doHttpConnect(resolve, reject) {
    this.status = "connecting";
    try {
      await this._request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "erix", version: readVersion() },
      });
      await this._notify("notifications/initialized", {});
      this.status = "connected";
      resolve();
    } catch (error) {
      this.status = "error";
      this.error = error;
      reject(error);
    }
  }

  _handleLine(line) {
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    if (data.id !== undefined) {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) {
        pending.reject(
          new McpConnectionError(
            this.serverName,
            data.error.message ?? String(data.error),
          ),
        );
      } else {
        pending.resolve(data.result);
      }
    }
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  _request(method, params) {
    if (this.url) {
      return this._httpRequest(method, params, false);
    }
    return this._stdioRequest(method, params);
  }

  _notify(method, params) {
    if (this.url) {
      return this._httpRequest(method, params, true);
    }
    return this._stdioRequest(method, params, true).catch(() => {});
  }

  _stdioRequest(method, params, isNotification = false) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed || this.closed) {
        reject(new McpConnectionError(this.serverName, "连接不可用"));
        return;
      }
      const id = isNotification ? undefined : this.nextId++;
      const timer = setTimeout(() => {
        if (id !== undefined && this.pending.has(id)) {
          this.pending.delete(id);
          reject(new McpConnectionError(this.serverName, `请求 ${method} 超时`));
        }
      }, CALL_TIMEOUT_MS);
      if (id !== undefined) {
        this.pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      }
      const envelope = { jsonrpc: "2.0", method, params };
      if (id !== undefined) envelope.id = id;
      const message = JSON.stringify(envelope);
      try {
        this.proc.stdin.write(`${message}\n`);
        if (id === undefined) {
          clearTimeout(timer);
          resolve();
        }
      } catch (error_) {
        if (id !== undefined) this.pending.delete(id);
        clearTimeout(timer);
        reject(new McpConnectionError(this.serverName, `写入失败：${error_.message}`));
      }
    });
  }

  async _httpRequest(method, params, isNotification = false) {
    if (!this.url || this.closed) {
      throw new McpConnectionError(this.serverName, "连接不可用");
    }
    const id = isNotification ? undefined : this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const controller = new AbortController();
    this.httpControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      this._updateSessionId(response);
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok) {
        await response.body?.cancel();
        throw new McpConnectionError(
          this.serverName,
          `HTTP ${response.status} ${response.statusText}`,
        );
      }
      if (isNotification) {
        if (response.body) await response.arrayBuffer();
        return undefined;
      }
      if (contentType.includes("application/json")) {
        const data = await response.json();
        if (data.error) {
          throw new McpConnectionError(
            this.serverName,
            data.error.message ?? String(data.error),
          );
        }
        return data.result;
      }
      if (contentType.includes("text/event-stream")) {
        const result = await this._readSseResponse(response, id);
        return result;
      }
      await response.body?.cancel();
      throw new McpConnectionError(
        this.serverName,
        `不支持的响应类型：${contentType}`,
      );
    } finally {
      clearTimeout(timeout);
      this.httpControllers.delete(controller);
      controller.abort();
    }
  }

  _updateSessionId(response) {
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      this.sessionId = sessionId;
    }
  }

  async _readSseResponse(response, expectedId) {
    if (!response.body) {
      throw new McpConnectionError(this.serverName, "SSE 响应无 body");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(
          reject,
          new McpConnectionError(this.serverName, "SSE 读取超时"),
        );
      }, HTTP_TIMEOUT_MS);
      let buffer = "";
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void reader.cancel().catch(() => {});
        callback(value);
      };
      const check = () => {
        const lines = buffer.split("\n");
        let leftover = "";
        if (!buffer.endsWith("\n")) {
          leftover = lines.pop();
        }
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          try {
            const data = JSON.parse(payload);
            if (data.id === expectedId) {
              if (data.error) {
                finish(
                  reject,
                  new McpConnectionError(
                    this.serverName,
                    data.error.message ?? String(data.error),
                  ),
                );
              } else {
                finish(resolve, data.result);
              }
              return true;
            }
          } catch {
            // ignore malformed SSE data lines
          }
        }
        buffer = leftover;
        return false;
      };
      const pump = async () => {
        try {
          while (!settled) {
            const { done, value } = await reader.read();
            if (done) {
              finish(
                reject,
                new McpConnectionError(
                  this.serverName,
                  "SSE 流已结束但未收到响应",
                ),
              );
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            if (check()) return;
          }
        } catch (error) {
          finish(
            reject,
            new McpConnectionError(
              this.serverName,
              `SSE 读取错误：${error.message}`,
            ),
          );
        }
      };
      void pump();
    });
  }

  async listTools() {
    if (this.tools) return this.tools;
    await this.connect();
    const result = await this._request("tools/list", {});
    this.tools = Array.isArray(result?.tools) ? result.tools : [];
    return this.tools;
  }

  async callTool(toolName, args) {
    await this.connect();
    const result = await this._request("tools/call", {
      name: toolName,
      arguments: args ?? {},
    });
    return formatToolResult(result);
  }

  close() {
    this.closed = true;
    this._rejectPending(
      new McpConnectionError(this.serverName, "连接被关闭"),
    );
    if (this.reader) {
      try {
        this.reader.close();
      } catch {
        // ignore
      }
      this.reader = null;
    }
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
    }
    for (const controller of this.httpControllers) {
      controller.abort();
    }
    this.httpControllers.clear();
    this.status = "idle";
    this.error = null;
    return this._waitForProcessExit();
  }

  _waitForProcessExit() {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let forceTimer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        proc.removeListener("close", finish);
        resolve();
      };
      proc.once("close", finish);
      forceTimer = setTimeout(() => {
        if (settled) return;
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        finish();
      }, 1000);
    });
  }
}

function resolveHeaders(rawHeaders, configDir) {
  const headers = {};
  if (!rawHeaders || typeof rawHeaders !== "object") return headers;
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value !== "string") continue;
    headers[key] = expandHeaderValue(value, configDir);
  }
  return headers;
}

function isDataUrlLike(text) {
  return typeof text === "string" && /^data:[^;]*;base64,/i.test(text);
}

function formatToolResult(result) {
  const content = result?.content;
  if (!Array.isArray(content)) {
    return truncateResult(String(content ?? JSON.stringify(result ?? "")));
  }
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      const text = String(block.text ?? "");
      if (isDataUrlLike(text)) {
        parts.push("[data-url omitted]");
      } else {
        parts.push(text);
      }
    } else if (block.type === "image" || block.type === "resource") {
      parts.push("[data-url omitted]");
    }
  }
  return truncateResult(parts.join("\n"));
}

export function truncateResult(text, limit = RESULT_LIMIT) {
  const string = String(text ?? "");
  if (string.length <= limit) return string;
  return `${string.slice(0, limit)}\n[MCP 结果已截断，共 ${string.length} 字符]`;
}

const pool = new Map();

function getClient(serverName, serverConfig, cwd) {
  const key = serverName;
  if (!pool.has(key)) {
    pool.set(key, new McpClient(serverName, serverConfig, cwd));
  }
  return pool.get(key);
}

export function getMcpPoolStatus() {
  const status = {};
  for (const [name, client] of pool.entries()) {
    status[name] = client.status;
  }
  return status;
}

export async function listMcpServerTools(serverName, serverConfig, cwd) {
  const client = getClient(serverName, serverConfig, cwd);
  try {
    return await client.listTools();
  } catch (error) {
    client.status = "error";
    client.error = error;
    throw error;
  }
}

export async function callMcpServerTool(serverName, serverConfig, cwd, toolName, args) {
  const client = getClient(serverName, serverConfig, cwd);
  try {
    return await client.callTool(toolName, args);
  } catch (error) {
    client.status = "error";
    client.error = error;
    throw error;
  }
}

export async function closeAllMcpServers() {
  const closing = [...pool.values()].map((client) => client.close());
  pool.clear();
  await Promise.all(closing);
}

function parseInternalToolId(toolId) {
  const match = /^mcp_([^_]+)_(.+)$/.exec(toolId);
  if (match) return { server: match[1], tool: match[2] };
  return null;
}

export function createMcpProxyTool({ mcpConfigPath, cwd = process.cwd() } = {}) {
  let config;
  try {
    config = loadMcpConfig(mcpConfigPath, cwd);
  } catch (error) {
    return { enabled: false, error };
  }
  if (!config) return { enabled: false };

  const servers = config.mcpServers;
  const serverNames = Object.keys(servers);
  if (serverNames.length === 0) return { enabled: false };

  function serverConfig(serverName) {
    const entry = servers[serverName];
    if (!entry || typeof entry !== "object") return null;
    return {
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args : [],
      env: entry.env && typeof entry.env === "object" ? entry.env : {},
      url: entry.url,
      headers: entry.headers && typeof entry.headers === "object" ? entry.headers : {},
    };
  }

  async function listAllTools() {
    const results = [];
    for (const serverName of serverNames) {
      const cfg = serverConfig(serverName);
      if (!cfg) {
        results.push({ server: serverName, error: "配置无效" });
        continue;
      }
      try {
        const tools = await listMcpServerTools(serverName, cfg, cwd);
        results.push({ server: serverName, tools });
      } catch (error) {
        results.push({ server: serverName, error: error?.message ?? String(error) });
      }
    }
    return results;
  }

  async function execute({ action, server, tool, args, query }) {
    if (action === "status") {
      const status = {};
      for (const serverName of serverNames) {
        const client = getClient(serverName, serverConfig(serverName), cwd);
        status[serverName] = client.status === "error" ? `错误：${client.error?.message ?? "未知"}` : client.status;
      }
      return JSON.stringify(status, null, 2);
    }

    if (action === "list") {
      const results = await listAllTools();
      const lines = [];
      for (const item of results) {
        if (item.error) {
          lines.push(`${item.server}：错误 - ${item.error}`);
        } else {
          lines.push(`${item.server}：${item.tools.length} 个工具`);
          for (const t of item.tools) {
            const description = String(t?.description ?? "").split("\n")[0] ?? "";
            lines.push(`  - ${t?.name ?? "?"}：${description}`);
          }
        }
      }
      return lines.join("\n");
    }

    if (action === "search") {
      if (typeof query !== "string" || query.trim() === "") {
        return "错误：search 需要提供 query";
      }
      const needle = query.toLowerCase();
      const results = await listAllTools();
      const matches = [];
      for (const item of results) {
        if (item.error) continue;
        for (const t of item.tools) {
          const haystack = `${item.server} ${t?.name ?? ""} ${t?.description ?? ""}`.toLowerCase();
          if (haystack.includes(needle)) {
            matches.push({
              server: item.server,
              tool: t?.name,
              description: t?.description,
              inputSchema: t?.inputSchema ?? t?.input_schema,
            });
          }
        }
      }
      if (matches.length === 0) return `未找到包含 "${query}" 的工具`;
      return JSON.stringify(matches, null, 2);
    }

    if (action === "call") {
      if (!tool) return "错误：call 需要提供 tool";
      let resolvedServer = server;
      let resolvedTool = tool;
      const parsed = parseInternalToolId(tool);
      if (parsed) {
        resolvedServer = parsed.server;
        resolvedTool = parsed.tool;
      }
      if (!resolvedServer) return "错误：call 需要提供 server 或使用 mcp_<server>_<tool> 形式";
      if (!serverNames.includes(resolvedServer)) return `错误：未配置 server "${resolvedServer}"`;
      const cfg = serverConfig(resolvedServer);
      if (!cfg) return `错误：server "${resolvedServer}" 配置无效`;
      return callMcpServerTool(resolvedServer, cfg, cwd, resolvedTool, args);
    }

    return `错误：未知 action "${action}"`;
  }

  return {
    enabled: true,
    schema: {
      name: "mcp",
      description:
        "访问 MCP 服务器工具。action：list（列全部 server 工具）/ search（按关键词搜工具）/ call（调用工具）/ status（连接状态）；call 需 server/tool/args，search 需 query，其余 action 可选 server 过滤",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "search", "call", "status"],
          },
          server: { type: "string" },
          tool: { type: "string" },
          args: { type: "object" },
          query: { type: "string", maxLength: 100 },
        },
        required: ["action"],
      },
    },
    execute,
    listConfiguredServers: () => [...serverNames],
    status: () => {
      const status = {};
      for (const serverName of serverNames) {
        const client = getClient(serverName, serverConfig(serverName), cwd);
        status[serverName] = client.status === "error" ? `错误：${client.error?.message ?? "未知"}` : client.status;
      }
      return status;
    },
    closeAll: closeAllMcpServers,
  };
}
