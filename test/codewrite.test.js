import { execFile } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { createCliTools } from "../bin/tools.js";

const execFileAsync = promisify(execFile);

async function withTempDir(callback) {
  const directory = await mkdtemp(join(tmpdir(), "erix-codewrite-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function initializeGitRepository(cwd) {
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Erix Codewrite"], { cwd });
  await execFileAsync("git", ["config", "user.email", "codewrite@example.invalid"], { cwd });
}

test("writeFile writes to an arbitrary path", async () => {
  await withTempDir(async (cwd) => {
    const destination = await mkdtemp(join(tmpdir(), "erix-codewrite-destination-"));
    try {
      const target = join(destination, "nested", "hello.txt");
      const { executeTool } = createCliTools({ cwd });
      assert.equal(
        await executeTool("writeFile", { path: target, content: "你好" }),
        Buffer.byteLength("你好", "utf8"),
      );
      assert.equal(await readFile(target, "utf8"), "你好");
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
});

test("exec runs arbitrary commands", async () => {
  await withTempDir(async (cwd) => {
    const { executeTool } = createCliTools({ cwd });
    assert.equal(await executeTool("exec", { command: "echo hello" }), "hello\n");
    assert.match(await executeTool("exec", { command: "ls /" }), /bin/);
  });
});

test("readFile reads arbitrary files", async () => {
  await withTempDir(async (cwd) => {
    await withTempDir(async (outside) => {
      const target = join(outside, "anywhere.txt");
      await writeFile(target, "outside\n", "utf8");
      const { executeTool } = createCliTools({ cwd });
      assert.equal(await executeTool("readFile", { path: target }), "1: outside");
    });
  });
});

test("exec runs git add, commit, and push commands", async () => {
  await withTempDir(async (cwd) => {
    await initializeGitRepository(cwd);
    await writeFile(join(cwd, "tracked.txt"), "tracked\n", "utf8");
    const { executeTool } = createCliTools({ cwd });

    assert.equal(await executeTool("exec", { command: "git add tracked.txt" }), "exit 0（无输出）");
    const commitResult = await executeTool(
      "exec",
      { command: 'git commit -m "codewrite commit"' },
    );
    assert.match(commitResult, /codewrite commit/);
    assert.match(await executeTool("exec", { command: "git log --oneline -1" }), /codewrite commit/);

    const pushResult = await executeTool("exec", { command: "git push" });
    assert.match(pushResult, /No configured push destination|没有配置的推送目标|push destination/i);
  });
});
