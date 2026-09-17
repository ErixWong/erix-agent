import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCliTools,
  getCommandTimeoutMs,
  getExecTimeoutMs,
  truncateResult,
  wrapExecuteTool,
} from "../bin/tools.js";
import * as notes from "../skills/notes/skill.mjs";

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

test("replayability records declared, policy, heuristic, and unknown sources", async () => {
  await withDirectory(async (cwd) => {
    const cases = [
      {
        name: "declared",
        options: {
          replayable: { exec: false },
          nonReplayable: { patterns: ["declared"] },
        },
        command: "printf declared",
        source: "declared",
      },
      {
        name: "policy",
        options: { nonReplayable: { patterns: ["policy"] } },
        command: "printf policy",
        source: "policy",
      },
      {
        name: "heuristic",
        options: {},
        command: "printf heuristic; : \"$RANDOM\"",
        source: "heuristic",
      },
      {
        name: "unknown",
        options: {},
        command: "printf unknown",
        source: "unknown",
      },
    ];

    for (const [index, item] of cases.entries()) {
      const tools = createCliTools({
        cwd,
        ...item.options,
      });
      const result = await tools.executeTool("exec", { command: item.command });
      const metadata = tools.getLastToolMetadata();
      assert.equal(metadata.replayableSource, item.source, item.name);
      assert.equal(metadata.replayable, item.source === "unknown" ? undefined : false);
      // ADR-015 4b：manifest/artifactStatus 已退役；全文经 fullOutput 交给引擎归档
      assert.doesNotMatch(result, /完整输出已归档/u, item.name);
    }

    const unknownTools = createCliTools({ cwd });
    await unknownTools.executeTool("exec", { command: "printf rerun" });
    const rerun = await unknownTools.executeTool("exec", { command: "printf rerun" });
    assert.doesNotMatch(rerun, /已拦截重复执行/u);
    assert.equal(unknownTools.getLastToolMetadata().replayableSource, "unknown");
  });
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

test("install/compile commands get extended timeout while regular commands keep default", () => {
  const previous = process.env.ERIX_EXEC_TIMEOUT_MS;
  try {
    delete process.env.ERIX_EXEC_TIMEOUT_MS;
    // 安装/编译/下载类命令：300s
    assert.equal(getCommandTimeoutMs("apt-get install -y build-essential"), 300_000);
    assert.equal(getCommandTimeoutMs("pip3 install numpy"), 300_000);
    assert.equal(getCommandTimeoutMs("make -j4"), 300_000);
    assert.equal(getCommandTimeoutMs("curl -sL https://example.com/x.tar.gz"), 300_000);
    // 普通命令：120s
    assert.equal(getCommandTimeoutMs("echo hello"), 120_000);
    assert.equal(getCommandTimeoutMs("ls -la /app"), 120_000);
    assert.equal(getCommandTimeoutMs("node /app/run.py"), 120_000);
    // 显式设置全局超时则不放大
    process.env.ERIX_EXEC_TIMEOUT_MS = "2500";
    assert.equal(getCommandTimeoutMs("apt-get install -y gcc"), 2500);
  } finally {
    if (previous === undefined) delete process.env.ERIX_EXEC_TIMEOUT_MS;
    else process.env.ERIX_EXEC_TIMEOUT_MS = previous;
  }
});

test("exec returns full output (truncation retired to engine outputHygiene, ADR-015)", async () => {
  const { executeTool } = createCliTools();
  const result = await executeTool("exec", { command: "head -c 5000 /dev/zero" });
  assert.equal(result.length, 5000);
  assert.doesNotMatch(result, /已截断/);
});

test("replayable large output is returned in full; nothing is archived to disk (ADR-015)", async () => {
  await withDirectory(async (cwd) => {
    const { executeTool } = createCliTools({ cwd });
    const result = await executeTool("exec", { command: "seq 1 500" });
    assert.ok(result.includes("500"));
    assert.doesNotMatch(result, /完整输出已归档/);
  });
});

test("reruns get recall-style guidance without paths (ADR-015)", async () => {
  await withDirectory(async (cwd) => {
    const { executeTool } = createCliTools({ cwd });
    const command = "seq 1 500";

    const first = await executeTool("exec", { command });
    const second = await executeTool("exec", { command });

    assert.doesNotMatch(first, /这是第 2 次执行/u);
    assert.match(second, /这是第 2 次执行/u);
    assert.match(second, /recall\(\{ pattern/u);
    assert.doesNotMatch(second, new RegExp(cwd.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  });
});

test("cross-process rerun provenance rebuilds from transcript records (ADR-015 4b)", async () => {
  await withDirectory(async (cwd) => {
    const notesDir = join(cwd, "notes");
    const runState = { rerunDetected: false, captureCount: 0 };
    const firstInstance = createCliTools({
      cwd,
      notesScope: { runId: "cross-process", notesDir },
      runState,
      replayable: { exec: false },
    });
    const firstExecute = wrapExecuteTool(firstInstance.executeTool, {
      output: () => {},
      getToolMetadata: firstInstance.getLastToolMetadata,
      returnMetadata: true,
    });
    const first = await firstExecute({
      id: "cross-process-1",
      name: "exec",
      input: { command: "printf nonce" },
      context: { round: 7 },
    });
    assert.equal(first.rerunOf, undefined);

    // 模拟跨进程 resume：把第一实例的 transcript 记录喂给第二实例
    const command = "printf nonce";
    const digest = (await import("node:crypto")).createHash("sha256")
      .update("nonce\n", "utf8").digest("hex");
    const existingRecords = [{
      round: 7,
      toolOutputs: [{ toolUseId: "cross-process-1", name: "exec", content: "nonce\n" }],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "cross-process-1", name: "exec", input: { command } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "cross-process-1", content: "nonce\n", replayable: false }] },
      ],
    }];
    const resumedInstance = createCliTools({
      cwd,
      existingRecords,
      replayable: { exec: false },
    });
    const resumedExecute = wrapExecuteTool(resumedInstance.executeTool, {
      output: () => {},
      getToolMetadata: resumedInstance.getLastToolMetadata,
      returnMetadata: true,
    });
    const second = await resumedExecute({
      id: "cross-process-2",
      name: "exec",
      input: { command: "printf nonce" },
      context: { round: 8 },
    });
    assert.match(second.data, /这是第 2 次执行/u);
    assert.equal(second.rerunOf.round, 7);
    assert.equal(second.rerunOf.digest, digest);
    assert.equal(second.rerunOf.archivePath, undefined);
    assert.equal(second.rerunOf.artifactId, undefined);
  });
});

test("executes a captured non-replayable rerun with first provenance metadata", async () => {
  await withDirectory(async (cwd) => {
    const notesDir = join(cwd, "notes");
    const tools = createCliTools({
      cwd,
      notesScope: { runId: "rerun-guard", notesDir },
    });
    const executeTool = wrapExecuteTool(tools.executeTool, {
      output: () => {},
      getToolMetadata: tools.getLastToolMetadata,
      notesScope: { runId: "rerun-guard", notesDir },
      returnMetadata: true,
    });
    const command = "printf 'nonce=%s\\n' \"$NON_IDEMPOTENT_VALUE\"; : \"$RANDOM\"";

    process.env.NON_IDEMPOTENT_VALUE = "first-value";
    try {
      const first = await executeTool({
        id: "first-exec",
        name: "exec",
        input: { command },
        context: { round: 1 },
      });
      await notes.note_take({
        key: "nonce",
        content: "agent-overwrite",
        __erix: { runId: "rerun-guard", notesDir },
      });
      process.env.NON_IDEMPOTENT_VALUE = "second-value";
      const second = await executeTool({
        id: "second-exec",
        name: "exec",
        input: { command: `  ${command}  ` },
        context: { round: 2 },
      });

      assert.match(first.data, /nonce=first-value/u);
      assert.match(second.data, /nonce=second-value/u);
      assert.match(second.data, /首次执行记录：nonce=first-value/u);
      assert.equal(second.rerunOf.round, 1);
      assert.equal(typeof second.rerunOf.digest, "string");
      assert.doesNotMatch(second.data, /agent-overwrite/u);
    } finally {
      delete process.env.NON_IDEMPOTENT_VALUE;
    }
  });
});

test("executes credential reruns without copying credentials into provenance", async () => {
  await withDirectory(async (cwd) => {
    const notesDir = join(cwd, "notes");
    const tools = createCliTools({
      cwd,
      notesScope: { runId: "credential-rerun", notesDir },
    });
    const executeTool = wrapExecuteTool(tools.executeTool, {
      output: () => {},
      getToolMetadata: tools.getLastToolMetadata,
      notesScope: { runId: "credential-rerun", notesDir },
      returnMetadata: true,
    });
    const command = "printf 'token: secret-value-%s\\n' \"$RANDOM\"";

    const first = await executeTool({
      id: "credential-first",
      name: "exec",
      input: { command },
      context: { round: 1 },
    });
    const second = await executeTool({
      id: "credential-second",
      name: "exec",
      input: { command: ` ${command} ` },
      context: { round: 2 },
    });

    assert.match(first.data, /token: secret-value-/u);
    assert.match(second.data, /secret-value-/u);
    // 凭据值不得进入首次值提示（first.value 只取非凭据候选）
    assert.doesNotMatch(second.data.split("\n")[0], /secret-value-/u);
    assert.doesNotMatch(JSON.stringify(second.rerunOf), /secret-value-/u);
    assert.doesNotMatch(JSON.stringify(tools.getLastToolMetadata()), /secret-value-/u);
  });
});

test("wrapped commands and legal second UUID generation are never blocked", async () => {
  await withDirectory(async (cwd) => {
    const { executeTool } = createCliTools({ cwd });
    await executeTool("exec", { command: "printf wrapped" });
    const wrapped = await executeTool("exec", { command: "bash -lc 'printf wrapped'" });
    assert.match(wrapped, /wrapped/u);
    assert.doesNotMatch(wrapped, /拦截/u);

    const uuidCommand = "node -e \"console.log(crypto.randomUUID())\"";
    const first = await executeTool("exec", { command: uuidCommand });
    const second = await executeTool("exec", { command: uuidCommand });
    assert.match(first, /^[0-9a-f-]{36}\n/u);
    assert.match(second, /^[\s\S]*[0-9a-f-]{36}\n/u);
    assert.doesNotMatch(second, /拦截/u);
  });
});

test("non-replayable rerun still returns fresh output with guidance", async () => {
  await withDirectory(async (cwd) => {
    const tools = createCliTools({ cwd });
    const command = "printf 'nonce=%s\\n' \"$NON_IDEMPOTENT_VALUE\"; : \"$RANDOM\"";

    process.env.NON_IDEMPOTENT_VALUE = "first-value";
    try {
      await tools.executeTool("exec", { command });
      process.env.NON_IDEMPOTENT_VALUE = "second-value";
      const second = await tools.executeTool("exec", { command });

      assert.match(second, /nonce=second-value/u);
      assert.match(second, /这是第 2 次执行/u);
    } finally {
      delete process.env.NON_IDEMPOTENT_VALUE;
    }
  });
});

test("does not intercept a different non-replayable command", async () => {
  await withDirectory(async (cwd) => {
    const notesDir = join(cwd, "notes");
    const tools = createCliTools({
      cwd,
      notesScope: { runId: "different-rerun", notesDir },
    });
    const executeTool = wrapExecuteTool(tools.executeTool, {
      output: () => {},
      getToolMetadata: tools.getLastToolMetadata,
      notesScope: { runId: "different-rerun", notesDir },
      returnMetadata: true,
    });

    process.env.NON_IDEMPOTENT_VALUE = "first-value";
    try {
      await executeTool({
        id: "first-different",
        name: "exec",
        input: {
          command: "printf 'nonce=first-value\\n'; : \"$RANDOM\"",
        },
        context: { round: 1 },
      });
      const second = await executeTool({
        id: "second-different",
        name: "exec",
        input: {
          command: "printf 'nonce=other-value\\n'; : \"$RANDOM\"",
        },
        context: { round: 2 },
      });

      assert.match(second.data, /nonce=other-value/u);
      assert.doesNotMatch(second.data, /该命令非幂等、不可重放/u);
    } finally {
      delete process.env.NON_IDEMPOTENT_VALUE;
    }
  });
});

test("increments the rerun notice count on every execution", async () => {
  await withDirectory(async (cwd) => {
    const { executeTool } = createCliTools({ cwd });
    const command = "seq 1 500";

    await executeTool("exec", { command });
    const second = await executeTool("exec", { command });
    const third = await executeTool("exec", { command });

    assert.match(second, /这是第 2 次执行/u);
    assert.match(third, /这是第 3 次执行/u);
    assert.doesNotMatch(third, /这是第 2 次执行/u);
  });
});

test("replayable reruns get guidance instead of being blocked", async () => {
  await withDirectory(async (cwd) => {
    const { executeTool } = createCliTools({
      cwd,
      replayable: { exec: true },
    });
    const command = "printf small";

    await executeTool("exec", { command });
    const second = await executeTool("exec", { command });

    assert.match(second, /这是第 2 次执行/u);
    assert.match(second, /recall\(\{ pattern/u);
    assert.doesNotMatch(second, /归档/u);
  });
});

test("does not add repeated command guards when archiving is disabled", async () => {
  const { executeTool } = createCliTools();
  const command = "seq 1 500";

  await executeTool("exec", { command });
  const second = await executeTool("exec", { command });

  assert.doesNotMatch(second, /该命令本次运行已执行过/u);
});

test("does not trigger the guard for different commands", async () => {
  await withDirectory(async (cwd) => {
    const { executeTool } = createCliTools({ cwd });

    await executeTool("exec", { command: "seq 1 500" });
    const differentCommand = await executeTool("exec", { command: "seq 1 501" });

    assert.doesNotMatch(differentCommand, /该命令本次运行已执行过/u);
  });
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
