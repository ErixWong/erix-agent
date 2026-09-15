import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileResourceStore } from "../../src/store/resource-file.js";

test("file ResourceStore exposes an opaque locator and a readable display", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erix-resource-store-"));
  try {
    const store = createFileResourceStore({ dir });
    const reference = await store.put("persisted text");

    assert.deepEqual(Object.keys(reference.locator), ["id"]);
    assert.equal(reference.display.endsWith(".bin"), true);
    assert.equal(await readFile(reference.display, "utf8"), "persisted text");
    assert.equal(await store.get(reference.locator), "persisted text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
