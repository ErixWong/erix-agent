import test from "node:test";
import assert from "node:assert/strict";

import { KitError } from "../../src/providers/errors.js";
import { createToolRegistry } from "../../src/tools/registry.js";

const baseSchema = {
  name: "echo",
  description: "Echo a value",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string", maxLength: 5 } },
    required: ["value"],
  },
};

test("executeTool validates required, type, and maxLength before calling the executor", async () => {
  let calls = 0;
  const registry = createToolRegistry({
    schemas: [baseSchema],
    executors: {
      echo: async (input) => {
        calls += 1;
        return input.value;
      },
    },
  });

  assert.match(await registry.executeTool("echo", {}), /missing required/);
  assert.match(await registry.executeTool("echo", { value: 1 }), /type string/);
  assert.match(await registry.executeTool("echo", { value: "123456" }), /maxLength/);
  assert.equal(calls, 0);
  assert.equal(await registry.executeTool("echo", { value: "ok" }), "ok");
  assert.equal(calls, 1);
});

test("resolveTools fails closed when a provider names an unregistered executor", async () => {
  const registry = createToolRegistry({ schemas: [baseSchema], executors: {} });
  await assert.rejects(
    registry.resolveTools({ listTools: async () => [{ name: "missing" }] }),
    (error) => error instanceof KitError
      && error.code === "tool_unknown_executor"
      && error.message === "missing",
  );
});

test("resolveTools accepts tighter provider constraints and ignores loosening", async () => {
  const registry = createToolRegistry({
    schemas: [baseSchema],
    executors: { echo: () => "ok" },
  });
  const tightened = await registry.resolveTools({
    listTools: async () => [{
      name: "echo",
      description: "Short echo",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string", maxLength: 3 } },
        required: [],
      },
    }],
  });
  assert.equal(tightened[0].description, "Short echo");
  assert.equal(tightened[0].inputSchema.properties.value.maxLength, 3);
  assert.deepEqual(tightened[0].inputSchema.required, ["value"]);

  const loosened = await registry.resolveTools({
    listTools: async () => [{
      name: "echo",
      inputSchema: {
        properties: { value: { maxLength: 20 } },
        required: [],
      },
    }],
  });
  assert.equal(loosened[0].inputSchema.properties.value.maxLength, 5);
  assert.deepEqual(loosened[0].inputSchema.required, ["value"]);
});
