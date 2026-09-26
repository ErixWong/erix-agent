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
import * as notes from "../src/tools/notes.js";

async function withDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "erix-cli-tools-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("createCliTools exposes all builtin tools including the todo quartet", () => {
  const { tools } = createCliTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "exec",
      "grep",
      "readFile",
      "rg",
      "todo_add",
      "todo_clear",
      "todo_done",
      "todo_list",
      "tree",
      "writeFile",
    ],
  );
});

test("grep finds matches grouped by file with line numbers", async () => {
  await withDirectory(async (cwd) => {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "a.js"), "const needle = 1;\nconst other = 2;\n", "utf8");
    await writeFile(join(cwd, "src", "b.js"), "let needle2 = needle;\n", "utf8");
    const { executeTool } = createCliTools({ cwd });

    const output = await executeTool("grep", { pattern: "needle", path: "src" });
    assert.match(output, /src\/a\.js\n1: const needle = 1;/);
    assert.match(output, /src\/b\.js\n1: let needle2 = needle;/);
    // 按文件分组：a.js 的命中块在 b.js 之前，块间空行分隔
    assert.ok(output.indexOf("src/a.js") < output.indexOf("src/b.js"));
  });
});

test("grep supports literal mode and reports invalid regex", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "x.txt"), "a.b (literal)\n", "utf8");
    const { executeTool } = createCliTools({ cwd });

    // 字面量：点号不当正则元字符
    assert.match(
      await executeTool("grep", { pattern: "a.b (literal)", path: cwd, is_regex: false }),
      /x\.txt\n1: a\.b \(literal\)/,
    );
    // 正则模式默认开启
    assert.match(
      await executeTool("grep", { pattern: "a\.b", path: cwd }),
      /x\.txt\n1: a\.b \(literal\)/,
    );
    // 无效正则返回错误提示而不是抛异常
    assert.match(
      await executeTool("grep", { pattern: "([", path: cwd }),
      /无效正则/,
    );
  });
});

test("grep truncates at max_results with a truncation note", async () => {
  await withDirectory(async (cwd) => {
    const lines = Array.from({ length: 20 }, (_, index) => `hit line ${index}`);
    await writeFile(join(cwd, "many.txt"), `${lines.join("\n")}\n`, "utf8");
    const { executeTool } = createCliTools({ cwd });

    const output = await executeTool("grep", {
      pattern: "hit line",
      path: cwd,
      max_results: 5,
    });
    // 5 条命中（文件头 + 5 行），另有截断说明段
    const hitLines = output.split("\n").filter((line) => /^\d+: /.test(line));
    assert.equal(hitLines.length, 5);
    assert.match(output, /max_results=5 截断/);
    // 硬上限 200：传 999 也只按 200 截断
    const more = await mkdtemp(join(tmpdir(), "erix-grep-cap-"));
    try {
      const many = Array.from({ length: 250 }, (_, index) => `hit line ${index}`);
      await writeFile(join(more, "many.txt"), `${many.join("\n")}\n`, "utf8");
      const capped = await executeTool("grep", {
        pattern: "hit line",
        path: more,
        max_results: 999,
      });
      const cappedHits = capped.split("\n").filter((line) => /^\d+: /.test(line));
      assert.equal(cappedHits.length, 200);
      assert.match(capped, /max_results=200 截断/);
    } finally {
      await rm(more, { recursive: true, force: true });
    }
  });
});

test("grep skips node_modules, .git, hidden directories, and oversized files", async () => {
  await withDirectory(async (cwd) => {
    await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(cwd, ".git"), { recursive: true });
    await mkdir(join(cwd, ".hidden"), { recursive: true });
    await writeFile(join(cwd, "node_modules", "pkg", "index.js"), "needle nm\n", "utf8");
    await writeFile(join(cwd, ".git", "config.txt"), "needle git\n", "utf8");
    await writeFile(join(cwd, ".hidden", "secret.txt"), "needle hidden\n", "utf8");
    await writeFile(join(cwd, "big.log"), `needle ${"x".repeat(2 * 1024 * 1024)}\n`, "utf8");
    await writeFile(join(cwd, "keep.txt"), "needle keep\n", "utf8");
    const { executeTool } = createCliTools({ cwd });

    const output = await executeTool("grep", { pattern: "needle", path: cwd });
    assert.match(output, /keep\.txt\n1: needle keep/);
    assert.doesNotMatch(output, /needle nm/);
    assert.doesNotMatch(output, /needle git/);
    assert.doesNotMatch(output, /needle hidden/);
    assert.doesNotMatch(output, /big\.log/);
  });
});

test("grep glob filters file names and truncates long lines", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "a.js"), "needle js\n", "utf8");
    await writeFile(join(cwd, "b.txt"), "needle txt\n", "utf8");
    await writeFile(join(cwd, "long.js"), `needle ${"y".repeat(500)}\n`, "utf8");
    const { executeTool } = createCliTools({ cwd });

    const byGlob = await executeTool("grep", { pattern: "needle", path: cwd, glob: "*.js" });
    assert.match(byGlob, /a\.js/);
    assert.doesNotMatch(byGlob, /b\.txt/);

    const longLine = await executeTool("grep", { pattern: "needle", path: cwd, glob: "long.js" });
    const hitLine = longLine.split("\n").find((line) => line.startsWith("1: "));
    assert.ok(hitLine.length <= 4 + 200 + 1, `命中行应截断到 200 字符：${hitLine.length}`);
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

test("large output is returned in full; nothing is archived to disk (ADR-015)", async () => {
  await withDirectory(async (cwd) => {
    const { executeTool } = createCliTools({ cwd });
    const result = await executeTool("exec", { command: "seq 1 500" });
    assert.ok(result.includes("500"));
    assert.doesNotMatch(result, /完整输出已归档/);
  });
});

test("reruns return fresh output without guidance (ADR-016)", async () => {
  await withDirectory(async (cwd) => {
    const { executeTool } = createCliTools({ cwd });
    const command = "seq 1 500";

    await executeTool("exec", { command });
    const second = await executeTool("exec", { command });

    assert.match(second, /\n500/u);
    assert.doesNotMatch(second, /这是第/u);
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

test("truncateResult keeps head and tail for oversized output (issue #32 #2)", () => {
  const oversized = `HEAD-MARKER-${"x".repeat(4097)}-TAIL-ERROR-MARKER`;
  const result = truncateResult(oversized);
  const marker = result.match(/\n\[中间省略 (\d+) 字符，共 (\d+) 字符\]\n/u);
  assert.ok(marker, `expected a head+tail marker, got ${result.slice(0, 120)}`);
  const [head, tail] = result.split(marker[0]);
  // 头部：开头命令上下文可见（head-only 截断的旧行为也满足）
  assert.equal(head, oversized.slice(0, head.length));
  assert.match(head, /^HEAD-MARKER-/u);
  // 尾部：结局/报错可见——这正是 head-only 截断会整段丢掉的部分
  assert.match(tail, /-TAIL-ERROR-MARKER$/u);
  assert.equal(tail, oversized.slice(oversized.length - tail.length));
  // 省略字符数标注：head + tail + omitted == 原文长度
  assert.equal(
    Number(marker[1]) + head.length + tail.length,
    oversized.length,
  );
  assert.equal(Number(marker[2]), oversized.length);
  assert.ok(head.length + tail.length <= 4096, "head+tail 不超过原上限");
  assert.ok(tail.length > 0, "尾部必须保留（报错/exit 行）");
});

test("truncateResult leaves short output and closed archive markers untouched", () => {
  assert.equal(truncateResult("abc"), "abc");
  assert.equal(truncateResult("x".repeat(4096)), "x".repeat(4096));
  const closed = `${"y".repeat(5000)}\n[完整输出已归档：/tmp/x.txt]`;
  assert.equal(truncateResult(closed), closed);
});

test("truncateResult never splits a surrogate pair (CJK/emoji safe)", () => {
  const emoji = "🙂".repeat(4000);
  const result = truncateResult(emoji);
  assert.doesNotMatch(
    result,
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    "head/tail 边界不得切碎代理对",
  );
  assert.match(result, /中间省略 3904 字符/u);
});

test("wrapExecuteTool exec log line keeps the trailing error (head+tail)", async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);
  let result;
  try {
    const executeTool = wrapExecuteTool(async () => `head-line\n${"f".repeat(6000)}\nexit 1: boom at the end`);
    result = await executeTool("exec", { command: "make" });
  } finally {
    console.log = originalLog;
  }
  assert.match(result, /exit 1: boom at the end$/u, "返回值不截断");
  const logLine = lines[1];
  assert.match(logLine, /^← exec: head-line\n/u);
  assert.match(logLine, /中间省略 \d+ 字符，共 \d+ 字符/u);
  assert.match(logLine, /exit 1: boom at the end$/u, "日志尾部保留报错");
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

test("wrapExecuteTool echoes generic input fields verbatim (pi 对齐，回显不打码)", async () => {
  const lines = [];
  const executeTool = wrapExecuteTool(
    async () => "ok",
    { output: (line) => lines.push(line) },
  );

  await executeTool("tree", { path: ".", token: "secret-value" });

  assert.equal(lines[0], '→ tree: {"path":".","token":"secret-value"}');
});
