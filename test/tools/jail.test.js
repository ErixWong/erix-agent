import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createJail, JailError } from "../../src/tools/jail.js";

async function withTempDir(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "erix-jail-"));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("jail resolves existing and missing paths, rejects lexical escapes, and restricts writes", async () => {
  await withTempDir(async (root) => {
    await fs.mkdir(path.join(root, "out"));
    const jail = createJail({ root, writable: ["out"] });

    assert.equal(jail.resolve("new/file.txt"), path.join(root, "new/file.txt"));
    assert.equal(jail.resolveForWrite("out/new.txt"), path.join(root, "out/new.txt"));
    assert.throws(
      () => jail.resolve("../outside"),
      (error) => error instanceof JailError && error.code === "path_escapes_root",
    );
    assert.throws(
      () => jail.resolveForWrite("new/file.txt"),
      (error) => error.code === "path_not_writable",
    );
  });
});

test("jail follows symlinks before checking the root boundary", async () => {
  await withTempDir(async (root) => {
    await fs.symlink("/etc", path.join(root, "escape"));
    const jail = createJail({ root });

    assert.throws(
      () => jail.resolve("escape/passwd"),
      (error) => error instanceof JailError && error.code === "path_escapes_root",
    );
  });
});

test("jail masks path prefixes after resolution", async () => {
  await withTempDir(async (root) => {
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".git", "config"), "secret");
    const jail = createJail({ root, maskedPaths: [".git"] });

    assert.equal(jail.resolve(".git/config"), path.join(root, ".git/config"));
    assert.throws(
      () => jail.assertReadable(".git/config"),
      (error) => error.code === "path_masked",
    );
    assert.equal(jail.assertReadable("public.txt"), path.join(root, "public.txt"));
  });
});
