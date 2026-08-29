import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCliTools, truncateResult } from "../bin/tools.js";

async function withDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "erix-cli-tools-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("createCliTools exposes all five tools", () => {
  const { tools } = createCliTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["exec", "readFile", "rg", "tree", "writeFile"],
  );
});

test("file tools operate on paths outside the working directory", async () => {
  await withDirectory(async (cwd) => {
    await withDirectory(async (outside) => {
      await writeFile(join(outside, "notes.txt"), "first\nsecond\n", "utf8");
      await writeFile(join(outside, "nested.txt"), "needle here\n", "utf8");
      const { executeTool } = createCliTools({ cwd });

      assert.equal(
        await executeTool("readFile", { path: join(outside, "notes.txt") }),
        "1: first\n2: second",
      );
      assert.match(
        await executeTool("rg", { pattern: "needle", path: outside }),
        /nested\.txt:1:needle here/,
      );
      assert.match(
        await executeTool("tree", { path: outside, depth: 1 }),
        /notes\.txt/,
      );
    });
  });
});

test("writeFile creates parent directories at any path", async () => {
  await withDirectory(async (cwd) => {
    await withDirectory(async (outside) => {
      const target = join(outside, "nested", "hello.txt");
      const { executeTool } = createCliTools({ cwd });
      assert.equal(
        await executeTool("writeFile", { path: target, content: "你好" }),
        Buffer.byteLength("你好", "utf8"),
      );
      assert.equal(await readFile(target, "utf8"), "你好");
    });
  });
});

test("exec runs arbitrary shell commands", async () => {
  const { executeTool } = createCliTools();
  assert.equal(await executeTool("exec", { command: "echo hello | tr a-z A-Z" }), "HELLO\n");
  assert.match(await executeTool("exec", { command: "ls /" }), /bin/);
});

test("exec truncates output at 4096 characters", async () => {
  const { executeTool } = createCliTools();
  const result = await executeTool("exec", { command: "head -c 5000 /dev/zero" });
  assert.equal(result.slice(0, 4096), "\0".repeat(4096));
  assert.match(result, /\n\[已截断，共 5000 字符\]$/);
});

test("truncateResult caps oversized output and reports its original length", () => {
  const result = truncateResult("x".repeat(4097));
  assert.equal(result.slice(0, 4096), "x".repeat(4096));
  assert.equal(result, `${"x".repeat(4096)}\n[已截断，共 4097 字符]`);
});
