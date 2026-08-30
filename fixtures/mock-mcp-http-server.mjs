#!/usr/bin/env node

import http from "node:http";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const tools = [
  {
    name: "echo",
    description: "Echo the input message back.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
];

let initializedSessionId = null;

function respondJson(res, id, result, error) {
  const payload = { jsonrpc: "2.0", id };
  if (error) payload.error = error;
  else payload.result = result;
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
}

function respondSse(res, id, result, error) {
  const payload = { jsonrpc: "2.0", id };
  if (error) payload.error = error;
  else payload.result = result;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end();
}

function handleRequest(req, res) {
  const mode = req.url.startsWith("/sse") ? "sse" : "json";
  const expectedAuth = process.env.MOCK_MCP_AUTH;

  if (req.method !== "POST") {
    res.writeHead(405).end("method not allowed");
    return;
  }

  let body = "";
  req.on("data", (chunk) => { body += String(chunk); });
  req.on("end", () => {
    const sessionId = req.headers["mcp-session-id"];
    if (expectedAuth && req.headers.authorization !== expectedAuth) {
      res.writeHead(401).end("unauthorized");
      return;
    }

    let request;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }

    const { id, method, params } = request;

    if (method !== "initialize" && (!sessionId || sessionId !== initializedSessionId)) {
      res.writeHead(401).end("missing session");
      return;
    }

    if (method === "initialize") {
      initializedSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      res.setHeader("Mcp-Session-Id", initializedSessionId);
      const result = {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "mock-http", version: "1.0.0" },
        capabilities: { tools: {} },
      };
      if (mode === "sse") respondSse(res, id, result);
      else respondJson(res, id, result);
      return;
    }

    if (method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }

    if (method === "tools/list") {
      if (mode === "sse") respondSse(res, id, { tools });
      else respondJson(res, id, { tools });
      return;
    }

    if (method === "tools/call") {
      if (params?.name === "echo") {
        const text = String(params.arguments?.message ?? "");
        if (mode === "sse") respondSse(res, id, { content: [{ type: "text", text }] });
        else respondJson(res, id, { content: [{ type: "text", text }] });
      } else {
        const error = { content: [{ type: "text", text: `Unknown tool: ${params?.name}` }], isError: true };
        if (mode === "sse") respondSse(res, id, error);
        else respondJson(res, id, error);
      }
      return;
    }

    const error = { code: -32601, message: `Method not found: ${method}` };
    if (mode === "sse") respondSse(res, id, null, error);
    else respondJson(res, id, null, error);
  });
}

function start(port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer(handleRequest);
    server.listen(port, () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  start().then(({ port }) => {
    console.error(`mock-mcp-http-server listening on ${port}`);
  });
}

export { start };
