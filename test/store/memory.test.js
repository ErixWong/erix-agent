import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";

test("memory transcript store appends, loads, and recalls by range and pattern", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound("run-1", {
    round: 1,
    messages: [
      { role: "user", content: [{ type: "text", text: "inspect files" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "list", input: { path: "." } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "README.md" }] },
    ],
  });
  await store.appendRound("run-1", {
    round: 2,
    messages: [{ role: "assistant", content: [{ type: "text", text: "summary" }] }],
  });

  const loaded = await store.load("run-1");
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded[0].messages[1].content[0], {
    type: "tool_use",
    id: "t1",
    name: "list",
    input: { path: "." },
  });
  assert.equal(
    await store.recall("run-1", 1, 1),
    'inspect files\nlist{"path":"."}\nREADME.md',
  );
  assert.equal(await store.recall("run-1", 2, 2), "summary");
  assert.equal(await store.recall("run-1", undefined, undefined, "README"), "README.md");
  assert.equal(await store.recall("missing"), "");
});
