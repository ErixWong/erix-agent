import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeTmp } from "./helpers/tmp.js";

import {
  buildCliToolsSystemPrompt,
  CLI_TOOL_PROMPT_PHRASES,
  CLI_TOOLS_SYSTEM_PROMPT,
  createCliTools,
  getCommandTimeoutMs,
  getExecTimeoutMs,
  isInstallCommand,
  resolveExecCeiling,
  truncateResult,
  wrapExecuteTool,
} from "../bin/tools.js";
import {
  DEFAULT_CHAT_IDLE_TIMEOUT_SECONDS,
  EXEC_CEILING_MARGIN_MS,
} from "../bin/idle.js";
import * as notes from "../src/tools/notes.js";

async function withDirectory(callback) {
  const directory = await makeTmp("erix-cli-tools-test-");
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
      "edit",
      "exec",
      "grep",
      "readFile",
      "rg",
      "searchText",
      "todo_add",
      "todo_clear",
      "todo_done",
      "todo_list",
      "tree",
      "writeFile",
    ],
  );
});

test("createCliTools({ todo: false }) drops the todo quartet (issue #69)", async () => {
  const { tools, executeTool } = createCliTools({ todo: false });
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["edit", "exec", "grep", "readFile", "rg", "searchText", "tree", "writeFile"],
  );
  await assert.rejects(executeTool("todo_add", { text: "x" }), /未知工具/u);
});

test("buildCliToolsSystemPrompt({ todo: false }) removes all todo mentions (issue #69)", () => {
  const disabled = buildCliToolsSystemPrompt({ todo: false });
  assert.doesNotMatch(disabled, /todo/i);
  // 基础段自身完整：工具清单行句号收尾、规划 bullet 保留、notes 纪律不受影响
  // （#184：工具清单行后面插了一句 vendor 默认 + 开关名）
  assert.match(disabled, /执行 shell 命令并返回输出。\n搜索与目录类工具/u);
  assert.match(disabled, /include_vendor=true、include_hidden=true。\n\n\[你的处境\]/u);
  assert.match(disabled, /复杂任务先规划并逐步执行\n/u);
  assert.match(disabled, /note_take/u);
  // 默认路径与导出常量逐字节一致（golden 锁定）
  assert.equal(buildCliToolsSystemPrompt(), CLI_TOOLS_SYSTEM_PROMPT);
  assert.ok(CLI_TOOLS_SYSTEM_PROMPT.includes(CLI_TOOL_PROMPT_PHRASES.todo_add.phrase));
});

test("默认跳 vendor + 开关名写进了系统提示（#184：「告诉模型」是本轮核心要求）", () => {
  // issue #312(b) R4：工具名文案不再在此处**第四次手抄**（以前把提示词短语重抄一遗：
  // 删一个工具不会红，因为这里抄的那份还在）。现在一律从 `CLI_TOOL_PROMPT_PHRASES` 取原文：
  // 这里只验「表里的原句逐字进了提示词」+「表本身口径没跑偏」，不再养第二份文案。
  const phrase = (name) => CLI_TOOL_PROMPT_PHRASES[name].phrase;
  const deprecatedNames = Object.keys(CLI_TOOL_PROMPT_PHRASES)
    .filter((name) => CLI_TOOL_PROMPT_PHRASES[name].phrase.includes("已弃用，请改用 searchText 并显式传 mode"));
  for (const prompt of [CLI_TOOLS_SYSTEM_PROMPT, buildCliToolsSystemPrompt({ todo: false })]) {
    assert.match(prompt, /默认跳过 node_modules、dist、build、target、vendor/u);
    assert.match(prompt, /\. 开头的目录/u);
    assert.match(prompt, /include_vendor=true、include_hidden=true/u);
    assert.match(prompt, /结果尾部会回报跳过数量/u);
    // 清单行里的工具文案：表 ⇄ 提示词逐字对齐（rg/grep/searchText 是 #184/#195 改过的重点）
    for (const name of ["readFile", "searchText", "rg", "grep", "tree", "edit", "writeFile", "exec"]) {
      assert.ok(prompt.includes(phrase(name)), `清单行少了 ${name} 的文案（或表与提示词已不同源）`);
    }
    // rg/grep 的默认口径不得跑回旧世界（正则默认 vs 字面量逃生口都是模型要会用的旗标）
    assert.match(phrase("rg"), /默认按正则匹配，与 rg 命令一致/u);
    assert.match(phrase("rg"), /is_regex=false 按字面量匹配，等价 rg --fixed-strings/u);
    assert.match(phrase("grep"), /默认正则，等价 grep -E；传 is_regex=false 按字面量，等价 grep -F/u);
    // 旧的「默认字面量」口径不得复活（模型读到旧口径就等于本轮白做）
    assert.doesNotMatch(prompt, /默认按字面量/u);
    // issue #195：新入口与它的两个「已弃用」别名都必须在清单行里（不是藏在描述里）
    assert.match(phrase("searchText"), /mode 必填、无默认值：literal 按字面量、regex 按 JavaScript 正则/u);
    assert.match(phrase("searchText"), /name_pattern 只匹配文件名、不跨 \//u);
    assert.deepEqual(deprecatedNames, ["rg", "grep"], "被标弃用的应当只有 rg 与 grep");
    assert.match(phrase("grep"), /glob 文件名过滤（只匹配文件名、不跨 \//u);
  }
  // todo 段的工具后缀只在 todo=true 里出现（#69），并且也从表里取，不在此处重抄
  assert.ok(CLI_TOOLS_SYSTEM_PROMPT.includes(phrase("todo_add")));
  assert.ok(CLI_TOOLS_SYSTEM_PROMPT.includes(phrase("todo_clear")));
  assert.doesNotMatch(buildCliToolsSystemPrompt({ todo: false }), /todo_add 添加待办任务/u);
});

test("searchText 的 {content, metadata} 结果在 CLI 回显里看得见（#195）", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "a.txt"), "needle here\n", "utf8");
    const lines = [];
    const echo = wrapExecuteTool(createCliTools({ cwd }).executeTool, { output: (line) => lines.push(line) });
    const result = await echo("searchText", { pattern: "needle", mode: "regex" });
    assert.equal(typeof result, "object", "库侧形状：{content, metadata}（引擎 normalizeExecutionResult 认这个形状）");
    assert.match(result.content, /a\.txt:1:needle here/u);
    assert.equal(result.metadata.searchHits, 1);
    assert.match(lines.at(-1), /a\.txt:1:needle here/u, "回显必须打正文，不是 [object Object]");
    assert.doesNotMatch(lines.at(-1), /\[object Object\]/u);
    // 纯字符串结果（别名）不受影响
    const alias = await echo("rg", { pattern: "needle" });
    assert.equal(typeof alias, "string");
    assert.match(alias, /已弃用/u);
  });
});

test("CLI 文件工具完全来自库实现，且 exec/todo_* 行为不变（#184 分层）", async () => {
  await withDirectory(async (cwd) => {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "a.js"), "needle\n", "utf8");
    await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(cwd, "node_modules", "pkg", "i.js"), "needle vendor\n", "utf8");
    const { tools, executeTool } = createCliTools({ cwd });

    // schema 名单与顺序（文件工具在前、exec 在后；#195 在 rg 之前插入 searchText、#191 在 writeFile 之前插入 edit，其余位置不动）
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["readFile", "searchText", "rg", "grep", "tree", "edit", "writeFile", "exec", "todo_add", "todo_list", "todo_done", "todo_clear"],
    );
    // 新工具的 schema 从库里一路可用（不是 CLI 自己另写一套）
    const searchTextSchema = tools.find((tool) => tool.name === "searchText").inputSchema;
    assert.deepEqual(searchTextSchema.required, ["pattern", "mode"]);
    assert.ok(searchTextSchema.properties.name_pattern);
    // 库里新增的参数从 CLI 一路可用（不是 CLI 自己另写一套）
    assert.ok(tools.find((tool) => tool.name === "readFile").inputSchema.properties.max_bytes);
    assert.ok(tools.find((tool) => tool.name === "rg").inputSchema.properties.include_vendor);
    // issue #191：`edit` 的 schema 也只能来自库（CLI 不再自己塑一份工具面）
    assert.match(tools.find((tool) => tool.name === "edit").description, /EXACT matching only/u);

    // 排除账 + 无命中口径从 CLI 可见
    const skipped = await executeTool("grep", { pattern: "needle" });
    assert.match(skipped, /已跳过/u);
    assert.match(skipped, /include_vendor=true/u);
    // 无命中同样统一口径，且排除账一起给出（不是空串）
    assert.match(
      await executeTool("rg", { pattern: "nothing-here" }),
      /^（无命中）\n\[已跳过 /u,
    );
    // exec 不受影响（ADR-005：不下库）
    assert.equal(await executeTool("exec", { command: "printf ok" }), "ok");
  });
});

test("signal 不再被丢：wrapExecuteTool 把顶层 signal 并入 context（#184）", async () => {
  let seen;
  const executeTool = wrapExecuteTool(
    async (_name, _input, context) => {
      seen = context;
      return "ok";
    },
    { output: () => {} },
  );
  const controller = new AbortController();

  await executeTool({
    id: "toolu_1",
    name: "tree",
    input: { path: "." },
    context: { round: 4 },
    signal: controller.signal,
  });

  assert.equal(seen.signal, controller.signal, "引擎放在顶层的 signal 必须并入 context");
  assert.equal(seen.toolUseId, "toolu_1");
  assert.equal(seen.round, 4);

  // 没有 signal 时不得凭空造出 signal 字段（形状与历史一致）
  await executeTool({ id: "toolu_2", name: "tree", input: {}, context: { round: 5 } });
  assert.equal("signal" in seen, false);
});

test("signal 不再被丢：createCliTools.executeTool 把 context 透传给 executor（#184）", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "a.txt"), "needle\n", "utf8");
    const { executeTool } = createCliTools({ cwd });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      executeTool("rg", { pattern: "needle" }, { signal: controller.signal }),
      (error) => error?.name === "AbortError",
      "context 没透传的话，库里的中止检查永远看不到 signal",
    );
    await assert.rejects(
      executeTool("tree", { path: "." }, { signal: controller.signal }),
      (error) => error?.name === "AbortError",
    );
    // 无 signal 路径行为不变
    assert.match(await executeTool("rg", { pattern: "needle" }), /a\.txt:1:needle/);
  });
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
    const more = await makeTmp("erix-grep-cap-");
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

test("grep glob filters file names and truncates long lines at 500 chars (200 → 500，#184 追加轮 A)", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "a.js"), "needle js\n", "utf8");
    await writeFile(join(cwd, "b.txt"), "needle txt\n", "utf8");
    await writeFile(join(cwd, "long.js"), `needle ${"y".repeat(800)}\n`, "utf8");
    // 297 字符：旧的 200 上限会把它截成半行（本轮要修的就是这个），新上限下必须整行返回
    await writeFile(join(cwd, "normal.js"), `needle ${"z".repeat(290)}\n`, "utf8");
    const { executeTool } = createCliTools({ cwd });

    const byGlob = await executeTool("grep", { pattern: "needle", path: cwd, glob: "*.js" });
    assert.match(byGlob, /a\.js/);
    assert.doesNotMatch(byGlob, /b\.txt/);

    const longLine = await executeTool("grep", { pattern: "needle", path: cwd, glob: "long.js" });
    const hitLine = longLine.split("\n").find((line) => line.startsWith("1: "));
    // 恰 500 字符正文 + 1 个省略号 + 3 个前缀字符（"1: "）；旧的 200 上限会是 204
    assert.equal(hitLine.length, 3 + 500 + 1, `命中行必须按 500 字符截断，实得到 ${hitLine.length}`);
    assert.ok(hitLine.endsWith("…"), "截断必须留省略号尾巴");

    const normal = await executeTool("grep", { pattern: "needle", path: cwd, glob: "normal.js" });
    assert.ok(
      normal.includes(`1: needle ${"z".repeat(290)}`),
      "297 字符的正常行不得再被截断（这就是 200 → 500 的理由）",
    );
    assert.doesNotMatch(normal, /…/u, "未触顶的行不得带省略号");
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
    // 安装/编译/下载类命令：240s（issue #433 T0：= chat 默认 idle 300s − 60s 余量，
    // 见下一条不变式；旧值 300s 与 idle 同值 ⇒ 那条「命令超时」事实上不可达）
    assert.equal(getCommandTimeoutMs("apt-get install -y build-essential"), 240_000);
    assert.equal(getCommandTimeoutMs("pip3 install numpy"), 240_000);
    assert.equal(getCommandTimeoutMs("make -j4"), 240_000);
    assert.equal(getCommandTimeoutMs("curl -sL https://example.com/x.tar.gz"), 240_000);
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

// issue #434 T1：install 档的判定口径 = 「切段 + 剥前缀之后的**段首**」，不是整条命令的开头。
// 两张表分开写：正例是「漏网写法」（改动前全部落默认档），反例是本单的主要风险面——
// 命令**里**出现过 `apt-get` / `npm install` 字样不等于它就是安装命令。
const INSTALL_HEAD_CASES = [
  "cd /app && pip install x",
  "cd /app && npm ci",
  "sudo -E apt-get install -y gcc",
  "time npm ci",
  "timeout 300 npm ci",
  "NODE_ENV=prod npm install",
  "set -e; pip install x",
  "/usr/local/bin/pip3 install x",
  "make -j4 && make install",
];

const NON_INSTALL_HEAD_CASES = [
  "echo apt-get",
  "echo \"npm install 很慢\"",
  "grep 'apt-get install' README.md",
  "sed -i 's/apt-get install/x/' f",
  "node -e \"require('npm')\"",
  "cat install.log",
  "ls && echo done",
  "git add -A && git commit -m x",
  // 引号内的 `|` 不是段分隔符（`grep -E 'a|b'` 是一段）：切段必须尊重引号
  "grep -E 'apt-get|npm install' README.md",
  // `command -v` 只是查存在，不是执行：吃掉 `-v` 就会把 `npm` 顶到段首 ⇒ 假 install 档
  "command -v npm",
];

// issue #434 T1 正例：分段 / 前缀剥完之后的段首命中 install 正则 ⇒ 放大档。
// 每条改动前都是 120_000（整条命令开头是 `cd` / `sudo` / `time` / `VAR=值` / `set` / 绝对路径）。
test("install tier fires on the segment head after separators and shell prefixes (issue #434 T1)", () => {
  const previous = process.env.ERIX_EXEC_TIMEOUT_MS;
  try {
    delete process.env.ERIX_EXEC_TIMEOUT_MS;
    for (const command of INSTALL_HEAD_CASES) {
      assert.equal(
        getCommandTimeoutMs(command),
        240_000,
        `${JSON.stringify(command)} 的段首是安装/编译类命令 ⇒ 必须落进 install 档（240s）`,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.ERIX_EXEC_TIMEOUT_MS;
    else process.env.ERIX_EXEC_TIMEOUT_MS = previous;
  }
});

// issue #434 T1 反例（本单的主要风险面）：只是**提到**了安装命令/文件名，一律保持默认档。
// 全局去掉 `^` 的写法会把这些全部误判成 install 档，白白给 240s。
test("commands that merely mention install tools keep the default timeout (issue #434 T1)", () => {
  const previous = process.env.ERIX_EXEC_TIMEOUT_MS;
  try {
    delete process.env.ERIX_EXEC_TIMEOUT_MS;
    for (const command of NON_INSTALL_HEAD_CASES) {
      assert.equal(
        getCommandTimeoutMs(command),
        120_000,
        `${JSON.stringify(command)} 不是安装/编译命令（只是字样出现在参数里）⇒ 必须保持默认档（120s）`,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.ERIX_EXEC_TIMEOUT_MS;
    else process.env.ERIX_EXEC_TIMEOUT_MS = previous;
  }
});

// issue #434 T1：分类是**纯函数**（零 IO）——`ERIX_EXEC_TIMEOUT_MS` 这类环境变量只影响「用哪个值」，
// 不得影响「这是哪一类」；同一输入多次求值必须一致。
test("isInstallCommand is a pure predicate: env cannot change the classification (issue #434 T1)", () => {
  const previous = process.env.ERIX_EXEC_TIMEOUT_MS;
  try {
    delete process.env.ERIX_EXEC_TIMEOUT_MS;
    for (const command of INSTALL_HEAD_CASES) assert.equal(isInstallCommand(command), true, command);
    for (const command of NON_INSTALL_HEAD_CASES) assert.equal(isInstallCommand(command), false, command);
    process.env.ERIX_EXEC_TIMEOUT_MS = "1";
    assert.equal(isInstallCommand("cd /app && pip install x"), true, "显式超时环境变量不许改写分类");
    assert.equal(isInstallCommand("echo apt-get"), false);
    assert.equal(isInstallCommand(""), false);
  } finally {
    if (previous === undefined) delete process.env.ERIX_EXEC_TIMEOUT_MS;
    else process.env.ERIX_EXEC_TIMEOUT_MS = previous;
  }
});

// issue #434 T1 不变式（#433 T0 那条）：放大档仍**严格小于**默认 idle 窗口，且显式 `ERIX_EXEC_TIMEOUT_MS`
// 仍不被改写——新写法（分段/前缀）不得把任何一条正例抬到 idle 之上，也不得绕过显式配置。
test("install tier stays strictly below the idle window and never rewrites an explicit timeout (issue #434 T1)", () => {
  const previous = process.env.ERIX_EXEC_TIMEOUT_MS;
  try {
    delete process.env.ERIX_EXEC_TIMEOUT_MS;
    const idleMs = DEFAULT_CHAT_IDLE_TIMEOUT_SECONDS * 1000;
    for (const command of INSTALL_HEAD_CASES) {
      assert.ok(
        getCommandTimeoutMs(command) < idleMs,
        `${JSON.stringify(command)} 的 install 档 ${getCommandTimeoutMs(command)}ms 必须 < idle 默认窗口 ${idleMs}ms`,
      );
    }
    // 显式配置仍然一字不改：分段写法也不放大
    process.env.ERIX_EXEC_TIMEOUT_MS = "2500";
    for (const command of INSTALL_HEAD_CASES) {
      assert.equal(getCommandTimeoutMs(command), 2500, `${JSON.stringify(command)} 不得绕过显式 ERIX_EXEC_TIMEOUT_MS`);
    }
    assert.equal(process.env.ERIX_EXEC_TIMEOUT_MS, "2500");
  } finally {
    if (previous === undefined) delete process.env.ERIX_EXEC_TIMEOUT_MS;
    else process.env.ERIX_EXEC_TIMEOUT_MS = previous;
  }
});

// issue #433 T0 ②：**天花板不变式**——exec 的任何一档默认值都必须短于 chat 的 idle 默认窗口。
// 为什么这是一条不变式而不是一个具体数字：idle 的计时起点更早（模型请求期就开始走），同值时
// idle 必然先响 ⇒ 「命令超时」这条路事实上不可达，挂住的安装命令的结局是「整个 run 被打死」。
// 断言「小于」而不是「等于某个数」：idle 默认值以后可以调，这条关系不能被悄悄破坏。
test("exec ceilings stay strictly below the default chat idle window (issue #433 T0)", () => {
  const previous = process.env.ERIX_EXEC_TIMEOUT_MS;
  try {
    delete process.env.ERIX_EXEC_TIMEOUT_MS;
    const idleMs = DEFAULT_CHAT_IDLE_TIMEOUT_SECONDS * 1000;
    for (const command of ["make", "apt-get install -y gcc", "echo hi", "ls -la"]) {
      assert.ok(
        getCommandTimeoutMs(command) < idleMs,
        `getCommandTimeoutMs(${JSON.stringify(command)}) = ${getCommandTimeoutMs(command)} 必须 < idle 默认窗口 ${idleMs}ms`,
      );
    }
    // 余量口径也钉住：天花板 = idle − 60s（不是「碰巧小一点」）
    assert.equal(getCommandTimeoutMs("make"), idleMs - EXEC_CEILING_MARGIN_MS);
  } finally {
    if (previous === undefined) delete process.env.ERIX_EXEC_TIMEOUT_MS;
    else process.env.ERIX_EXEC_TIMEOUT_MS = previous;
  }
});

// issue #433 T0 ②：显式 `ERIX_EXEC_TIMEOUT_MS` 超过天花板时**只警告、不改值**（既有语义：
// 尊重显式配置）。「钳天花板」只动默认值。
test("explicit ERIX_EXEC_TIMEOUT_MS above the idle ceiling warns but is never rewritten (issue #433 T0)", () => {
  const previous = process.env.ERIX_EXEC_TIMEOUT_MS;
  try {
    process.env.ERIX_EXEC_TIMEOUT_MS = "600000";
    const warnings = [];
    // idle=300s ⇒ 天花板 240s < 显式 600s
    const ceiling = resolveExecCeiling(300, { warn: (line) => warnings.push(line) });
    assert.equal(ceiling, null, "显式配置超限时不钳（返回 null = 不设天花板）");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ERIX_EXEC_TIMEOUT_MS=600000/u);
    assert.match(warnings[0], /不钳值/u);
    // 显式值原样生效，一个字节都没被改写
    assert.equal(getCommandTimeoutMs("make", { ceilingMs: 240_000 }), 600_000);
    assert.equal(getCommandTimeoutMs("echo hi", { ceilingMs: 240_000 }), 600_000);
    assert.equal(process.env.ERIX_EXEC_TIMEOUT_MS, "600000");
  } finally {
    if (previous === undefined) delete process.env.ERIX_EXEC_TIMEOUT_MS;
    else process.env.ERIX_EXEC_TIMEOUT_MS = previous;
  }
});

// issue #433 T0 ③ 的装配侧：天花板真的走到了 exec 工具里（不是只算出来放着）。
// 用 100ms 这种「不可能由 resolveExecCeiling 生成」的值直接喂 createCliTools，观察 exec 的
// 超时文案里带着它——事件驱动（命令自己超时返回），不靠 sleep 断言时长。
test("createCliTools({ execCeilingMs }) reaches the exec timeout (issue #433 T0)", async () => {
  const previous = process.env.ERIX_EXEC_TIMEOUT_MS;
  try {
    delete process.env.ERIX_EXEC_TIMEOUT_MS;
    const { executeTool } = createCliTools({ execCeilingMs: 100 });
    const result = await executeTool("exec", { command: "sleep 0.4" });
    assert.match(result, /命令超时（100ms）被终止/u);
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
