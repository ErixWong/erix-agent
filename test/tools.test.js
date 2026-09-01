import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCliTools,
  getExecTimeoutMs,
  truncateResult,
  wrapExecuteTool,
} from "../bin/tools.js";

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

test("rg and tree skip dangling symlinks without crashing", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "real.txt"), "needle in real file\n", "utf8");
    // 悬空 symlink：指向不存在的目标，statSync 会抛 ENOENT（benchmark 中 /dev/fd 场景）
    await mkdir(join(cwd, "sub"));
    await symlink(join(cwd, "missing-target"), join(cwd, "sub", "dangling"));
    const { executeTool } = createCliTools({ cwd });

    assert.doesNotReject(
      executeTool("rg", { pattern: "needle", path: cwd }),
    );
    assert.match(
      await executeTool("rg", { pattern: "needle", path: cwd }),
      /real\.txt:1:needle in real file/,
    );
    assert.doesNotReject(
      executeTool("tree", { path: cwd, depth: 2 }),
    );
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

test("exec reports exit code when a successful command has no output", async () => {
  const { executeTool } = createCliTools();
  assert.equal(await executeTool("exec", { command: "true" }), "exit 0（无输出）");
});

test("exec starts background commands without waiting", async () => {
  const { executeTool } = createCliTools();
  const startedAt = Date.now();
  const result = await executeTool("exec", { command: "sleep 30 &" });

  assert.ok(Date.now() - startedAt < 5000);
  assert.match(result, /已启动|PID/);
});

test("exec keeps nohup commands in the foreground unless they end with &", async () => {
  const { executeTool } = createCliTools();

  const chainedResult = await executeTool("exec", {
    command: "nohup sh -c 'sleep 0.1' >/dev/null 2>&1 & sleep 0.2 && printf foreground",
  });
  assert.equal(chainedResult, "foreground");

  const plainResult = await executeTool("exec", {
    command: "nohup printf nohup-foreground",
  });
  assert.equal(plainResult, "nohup-foreground");
});

test("exec timeout defaults to 120 seconds and accepts a valid environment override", () => {
  const previous = process.env.ERIX_EXEC_TIMEOUT_MS;
  try {
    delete process.env.ERIX_EXEC_TIMEOUT_MS;
    assert.equal(getExecTimeoutMs(), 120_000);

    process.env.ERIX_EXEC_TIMEOUT_MS = "2500";
    assert.equal(getExecTimeoutMs(), 2500);

    process.env.ERIX_EXEC_TIMEOUT_MS = "not-a-number";
    assert.equal(getExecTimeoutMs(), 120_000);
  } finally {
    if (previous === undefined) delete process.env.ERIX_EXEC_TIMEOUT_MS;
    else process.env.ERIX_EXEC_TIMEOUT_MS = previous;
  }
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

test("wrapExecuteTool logs calls and truncates result summaries", async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);
  let result;
  try {
    const executeTool = wrapExecuteTool(async () => `${"x".repeat(250)}\nsecond line`);
    result = await executeTool("exec", { command: "ls -la" });
  } finally {
    console.log = originalLog;
  }

  assert.equal(result, `${"x".repeat(250)}\nsecond line`);
  assert.equal(lines[0], "→ exec: ls -la");
  assert.equal(lines[1], `← exec: ${'x'.repeat(250)}\nsecond line`);
  assert.match(lines[1], /second line/);
});

test("wrapExecuteTool redacts sensitive generic input fields", async () => {
  const lines = [];
  const executeTool = wrapExecuteTool(
    async () => "ok",
    { output: (line) => lines.push(line) },
  );

  await executeTool("tree", { path: ".", token: "secret-value" });

  assert.equal(lines[0], '→ tree: {"path":".","token":"[已隐藏]"}');
});
