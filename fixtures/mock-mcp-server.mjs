#!/usr/bin/env node

import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

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
  {
    name: "uppercase",
    description: "Convert input text to uppercase.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "image",
    description: "Return an image content block for testing data-url omission.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "binary",
    description: "Return a base64 data URL text for testing omission.",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(message) {
  console.log(JSON.stringify(message));
}

function callTool(name, args) {
  if (name === "echo") {
    return {
      content: [{ type: "text", text: String(args?.message ?? "") }],
      isError: false,
    };
  }
  if (name === "uppercase") {
    return {
      content: [{ type: "text", text: String(args?.text ?? "").toUpperCase() }],
      isError: false,
    };
  }
  if (name === "image") {
    return {
      content: [
        {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
        },
      ],
      isError: false,
    };
  }
  if (name === "binary") {
    return {
      content: [
        {
          type: "text",
          text: "data:image/png;base64,iVBORw0KGgo=",
        },
      ],
      isError: false,
    };
  }
  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

rl.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!request || typeof request !== "object") return;

  const { id, method, params } = request;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "mock-mcp-server", version: "1.0.0" },
        capabilities: { tools: {} },
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }

  if (method === "tools/call") {
    const result = callTool(params?.name, params?.arguments);
    send({ jsonrpc: "2.0", id, result });
    return;
  }

  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
});
