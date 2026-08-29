import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function withHome(callback) {
  const previous = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "erix-cli-tools-home-"));
  process.env.HOME = home;
  try {
    return await callback(home);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test("createCliTools exposes only read-only tools", async () => {
  await withHome(async () => {
    await withDirectory(async (cwd) => {
      const { tools } = createCliTools({ cwd });
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ["exec", "readFile", "rg", "tree"],
      );
      assert.equal(tools.some((tool) => tool.name === "writeFile"), false);
    });
  });
});

test("exec runs allowlisted read-only commands", async () => {
  await withDirectory(async (cwd) => {
    const { executeTool } = createCliTools({ cwd });
    assert.equal(await executeTool("exec", { command: "pwd" }), `${cwd}\n`);
    assert.equal(await executeTool("exec", { command: "echo hello" }), "hello\n");
  });
});

test("exec rejects commands outside the whitelist", async () => {
  const { executeTool } = createCliTools();
  const rmResult = await executeTool("exec", { command: "rm -rf /tmp/x" });
  const sudoResult = await executeTool("exec", { command: "sudo" });
  assert.match(rmResult, /不在白名单/);
  assert.match(sudoResult, /不在白名单/);
});

test("exec rejects unsafe shell syntax", async () => {
  const { executeTool } = createCliTools();
  for (const command of ["ls | wc", "cat x > y", "date; whoami", "$(rm)", "ls *"]) {
    assert.equal(
      await executeTool("exec", { command }),
      "错误：命令含不安全语法",
      command,
    );
  }
});

test("exec truncates output using the shared result limit", async () => {
  const { executeTool } = createCliTools();
  const result = await executeTool("exec", { command: "head -c 5000 /dev/zero" });
  assert.equal(result.slice(0, 4096), "\0".repeat(4096));
  assert.match(result, /\n\[已截断，共 5000 字符\]$/);
});

test("executeTool readFile reads a file inside the jail", async () => {
  await withHome(async () => {
    await withDirectory(async (cwd) => {
      await writeFile(join(cwd, "notes.txt"), "first\nsecond\n", "utf8");
      const { executeTool } = createCliTools({ cwd });
      assert.equal(
        await executeTool("readFile", { path: "notes.txt" }),
        "1: first\n2: second",
      );
    });
  });
});

test("executeTool turns masked or outside paths into a friendly error", async () => {
  await withHome(async (home) => {
    await withDirectory(async (cwd) => {
      await withDirectory(async (sensitiveDirectory) => {
        await writeFile(join(sensitiveDirectory, "secret.txt"), "not for the model", "utf8");
        await mkdir(join(home, ".erix"), { recursive: true });
        await writeFile(join(home, ".erix", "config.json"), "not for the model", "utf8");
        const { executeTool } = createCliTools({
          cwd,
          maskedPaths: [sensitiveDirectory],
        });

        const result = await executeTool("readFile", {
          path: join(sensitiveDirectory, "secret.txt"),
        });
        assert.match(result, /^路径被禁止：/);
        assert.doesNotMatch(result, /not for the model/);

        const homeResult = await executeTool("readFile", {
          path: "~/.erix/config.json",
        });
        assert.match(homeResult, /^路径被禁止：/);
        assert.doesNotMatch(homeResult, /not for the model/);
      });
    });
  });
});

test("truncateResult caps oversized output and reports its original length", () => {
  const result = truncateResult("x".repeat(4097));
  assert.equal(result.slice(0, 4096), "x".repeat(4096));
  assert.equal(result, `${"x".repeat(4096)}\n[已截断，共 4097 字符]`);
});
