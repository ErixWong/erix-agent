import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFileTools } from "../../src/tools/file-tools.js";
import { createJail } from "../../src/tools/jail.js";

async function withTempDir(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "erix-files-"));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("file tools read, search, tree, and write within the jail", async () => {
  await withTempDir(async (root) => {
    await fs.mkdir(path.join(root, "nested"));
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, "notes.txt"), "zero\none needle\ntwo\nthree\n");
    await fs.writeFile(path.join(root, "nested", "other.txt"), "needle here\n");
    await fs.writeFile(path.join(root, ".git", "secret.txt"), "needle secret\n");
    await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1, "x"));

    const tools = createFileTools(createJail({
      root,
      writable: ["out"],
      maskedPaths: [".git"],
    }));

    assert.equal(
      await tools.executors.readFile({ path: "notes.txt", offset: 1, limit: 2 }),
      "2: one needle\n3: two\n[共 4 行，offset=3 继续]",
    );
    const matches = await tools.executors.rg({ pattern: "needle" });
    assert.match(matches, /notes\.txt:2:one needle/);
    assert.match(matches, /nested\/other\.txt:1:needle here/);
    assert.doesNotMatch(matches, /secret|binary|large/);

    const tree = await tools.executors.tree({ depth: 2 });
    assert.match(tree, /notes\.txt/);
    assert.match(tree, /nested\//);
    assert.match(tree, /other\.txt/);
    assert.doesNotMatch(tree, /\.git|secret\.txt/);

    const bytes = await tools.executors.writeFile({
      path: "out/result.txt",
      content: "你好",
    });
    assert.equal(bytes, Buffer.byteLength("你好", "utf8"));
    assert.equal(await fs.readFile(path.join(root, "out/result.txt"), "utf8"), "你好");
  });
});
