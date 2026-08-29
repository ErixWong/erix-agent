import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createCompositeToolProvider,
  createJsonFileToolProvider,
  createStaticToolProvider,
} from "../../src/tools/providers.js";

const first = {
  name: "one",
  description: "first",
  inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 10 } } },
};
const second = {
  name: "two",
  description: "second",
  inputSchema: { type: "object", properties: {} },
};

test("static provider selects sets and returns isolated schemas", async () => {
  const provider = createStaticToolProvider({ sets: { default: [first], other: [second] } });
  const selected = await provider.listTools({ set: "other" });
  assert.deepEqual(selected, [second]);
  selected[0].description = "mutated";
  assert.equal((await provider.listTools({ set: "other" }))[0].description, "second");
  assert.deepEqual(await provider.listTools({ set: "unknown" }), [first]);
});

test("json-file provider reloads definitions on every listTools call", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "erix-provider-"));
  try {
    const file = path.join(directory, "tools.json");
    await fs.writeFile(file, JSON.stringify({ sets: { default: [first] } }));
    const provider = createJsonFileToolProvider({ path: file });
    assert.deepEqual(await provider.listTools(), [first]);
    await fs.writeFile(file, JSON.stringify({ sets: { default: [second] } }));
    assert.deepEqual(await provider.listTools(), [second]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("composite provider lets later definitions override descriptions and constraints", async () => {
  const provider = createCompositeToolProvider({
    providers: [
      createStaticToolProvider({ sets: { default: [first] } }),
      createStaticToolProvider({
        sets: {
          default: [{
            name: "one",
            description: "override",
            inputSchema: { properties: { text: { maxLength: 3 } } },
          }],
        },
      }),
    ],
  });
  const [tool] = await provider.listTools();
  assert.equal(tool.description, "override");
  assert.equal(tool.inputSchema.properties.text.maxLength, 3);
});
