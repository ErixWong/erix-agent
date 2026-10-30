// issue #617（P2）：CLI 侧 `delegate` 的装配面——**默认关闭、显式开启**，且子 run 落自己的会话文件。
//
// 这个文件钉的是「只有 CLI 才看得见」的那几条判据（库侧由 `test/tools-delegate-617.test.js` 与
// `examples/delegate-e2e.test.mjs` 钉着）：
//   ① 开关：`--delegate` / `--delegate-max-children` / `--delegate-timeout-ms` 的解析（chat 与 repl
//      同一套），默认**不注册** `delegate`，且默认系统提示里一个字都不提它；
//   ② 装配：`createCliTools({ delegate: true })` 必须注入 `delegateTool`（开关与实现同侧），
//      注册面上的 definition 归库（`DELEGATE_DEFINITION`），CLI 不手抄 schema；
//   ③ **会话文件互踩**（本刀的重点）：CLI 的会话 id 由 cwd 派生，父子同 cwd ⇒ 同一个会话文件名。
//      派生一次后，父会话文件里**不出现**子 run 的行；子 run 的 transcript 落在名册目录下。
//
// 全离线：脚本化假 provider（本文件内联，按系统提示分流父/子），临时目录走 `makeTmp`，
// 不碰真实 `~/.erix`、不发网络请求。

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { parseChatArgs, runChat } from "../bin/cli.js";
import { parseReplArgs, runRepl } from "../bin/repl.js";
import {
  DEFAULT_DELEGATE_MAX_CHILDREN,
  DEFAULT_DELEGATE_TIMEOUT_MS,
  createCliDelegation,
  resolveDelegationDir,
} from "../bin/delegation.js";
import { transcriptPath } from "../src/store/file.js";
import { readRecord } from "../src/tools/delegation/roster.js";
import {
  buildCliToolsSystemPrompt,
  createCliTools,
  DELEGATE_TOOL_NAMES,
} from "../bin/tools.js";
import { makeTmp } from "./helpers/tmp.js";

/** 只出现在**子 run** 工具入参里的字面量：父会话文件出现它就说明父子互踩。 */
const CHILD_ONLY_MARKER = "CHILD-TOOL-ONLY-MARKER-617";

/**
 * 按系统提示分流的脚本化假 provider：父 run 与子 run 共用同一个实例（CLI 的 `buildProvider`
 * 在未指定 model 时就是复用父那个），所以**必须在请求里分流**，不能用一个线性脚本。
 */
function createRoutingFakeProvider({ parentScript, childScript }) {
  const seen = { parent: 0, child: 0 };
  const requests = [];
  return {
    protocol: "fake",
    model: "fake-model",
    requests,
    seen,
    async chat(request) {
      requests.push(request);
      // 系统提示在 `request.system`（一个 `{ content }` 对象，不是字符串）——整份请求序列化后再判，
      // 不猜引擎把系统提示放在哪一格。
      const isChild = JSON.stringify(request ?? {}).includes("你是 erix 的子 run");
      const script = isChild ? childScript : parentScript;
      const key = isChild ? "child" : "parent";
      if (seen[key] >= script.length) {
        throw new Error(`fake provider: ${key} 脚本已用尽（第 ${seen[key] + 1} 次请求）`);
      }
      const step = script[seen[key]];
      seen[key] += 1;
      return {
        content: step.content ?? [],
        stopReason: step.stopReason ?? "end_turn",
      };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
}

/** 空 MCP 配置：`runChat` 默认会去读 `~/.erix/mcp.json` / 当前目录 `.mcp.json`（测试不许碰真家目录）。 */
async function writeEmptyMcpConfig(dir) {
  const configPath = join(dir, "mcp.json");
  await mkdir(dir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  return configPath;
}

test("parseChatArgs：--delegate 三件套（默认关、值可省、重复报错、非法值报错）", () => {
  // 默认：三个键都不出现（undefined），默认关的判据在装配侧，解析侧只需「不自己开」。
  const bare = parseChatArgs(["hi"]);
  assert.equal(bare.delegate, undefined);
  assert.equal(bare.delegateMaxChildren, undefined);
  assert.equal(bare.delegateTimeoutMs, undefined);

  const opened = parseChatArgs([
    "--delegate",
    "--delegate-max-children", "3",
    "--delegate-timeout-ms", "1234",
    "hi",
  ]);
  assert.equal(opened.delegate, true);
  assert.equal(opened.delegateMaxChildren, 3);
  assert.equal(opened.delegateTimeoutMs, 1234);
  assert.equal(opened.prompt, "hi");

  assert.throws(() => parseChatArgs(["--delegate", "--delegate"]), /参数重复：--delegate/u);
  assert.throws(() => parseChatArgs(["--delegate-max-children", "0", "hi"]), /大于等于 1 的整数/u);
  assert.throws(() => parseChatArgs(["--delegate-timeout-ms", "abc", "hi"]), /大于等于 1 的整数/u);
  assert.throws(() => parseChatArgs(["--delegate-timeout-ms", "--delegate", "hi"]), /缺少数值/u);
});

test("parseReplArgs：与 chat 同一套 delegate 旗标（repl 也要能开）", () => {
  const bare = parseReplArgs([]);
  assert.equal(bare.delegate, undefined);
  const opened = parseReplArgs(["--delegate", "--delegate-max-children", "1", "--delegate-timeout-ms", "9000"]);
  assert.equal(opened.delegate, true);
  assert.equal(opened.delegateMaxChildren, 1);
  assert.equal(opened.delegateTimeoutMs, 9000);
  assert.throws(() => parseReplArgs(["--delegate", "--delegate"]), /参数重复：--delegate/u);
});

test("delegate 默认关：注册面与系统提示里都没有它（golden 的默认路径零变化）", () => {
  const { tools } = createCliTools({ cwd: "/nonexistent-cwd" });
  assert.equal(tools.some((tool) => tool.name === "delegate"), false, "默认不注册 delegate");
  assert.equal(DELEGATE_TOOL_NAMES.has("delegate"), true);
  assert.doesNotMatch(buildCliToolsSystemPrompt(), /delegate/u, "默认提示词不得提 delegate");
  // 显式开：清单行出现 delegate，且**只**多这一段（todo 段照旧）。
  const opened = buildCliToolsSystemPrompt({ delegate: true });
  assert.match(opened, /delegate 派生一个子 run/u);
  assert.match(opened, /v1 不递归派生/u);
  assert.ok(opened.includes("todo_add 添加待办任务"), "delegate 段不得顶掉 todo 段");
});

test("createCliTools({ delegate: true }) 必须注入 delegateTool（开关与实现同侧）", async () => {
  assert.throws(
    () => createCliTools({ cwd: "/nonexistent-cwd", delegate: true }),
    /必须注入 delegateTool/u,
  );
  // 反方向也不许静默：给了实现却没开开关 ⇒ 提示词与工具面会各说各话。
  assert.throws(
    () => createCliTools({ cwd: "/nonexistent-cwd", delegateTool: { execute: async () => ({}) } }),
    /开关与实现必须同侧/u,
  );
  // 正例：definition 归库（名字/schema 只有一份），执行器走注入的那个。
  const calls = [];
  const { tools, executeTool } = createCliTools({
    cwd: "/nonexistent-cwd",
    delegate: true,
    delegateTool: { execute: async (input, context) => { calls.push({ input, context }); return { ok: true }; } },
  });
  const definition = tools.find((tool) => tool.name === "delegate");
  assert.ok(definition, "delegate 必须出现在注册面上");
  assert.equal(definition.inputSchema.properties.parentRunId, undefined, "schema 里不许有 parentRunId");
  const result = await executeTool("delegate", { action: "list" }, { runId: "parent-1" });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{ input: { action: "list" }, context: { runId: "parent-1" } }]);
});

test("resolveDelegationDir：显式参数 > 环境变量 > ~/.erix/delegation", () => {
  const explicit = resolveDelegationDir("/tmp/erix-delegation-explicit");
  assert.equal(explicit, "/tmp/erix-delegation-explicit");
  const saved = process.env.ERIX_DELEGATION_DIR;
  try {
    process.env.ERIX_DELEGATION_DIR = "/tmp/erix-delegation-env";
    assert.equal(resolveDelegationDir(), "/tmp/erix-delegation-env");
    delete process.env.ERIX_DELEGATION_DIR;
    assert.match(resolveDelegationDir(), /\.erix\/delegation$/u);
  } finally {
    if (saved === undefined) delete process.env.ERIX_DELEGATION_DIR;
    else process.env.ERIX_DELEGATION_DIR = saved;
  }
});

test("会话文件互踩：派生一次后父会话文件里不出现子 run 的行（子 run 落名册目录）", async () => {
  const root = await makeTmp("erix-cli-delegate-");
  const parentDir = join(root, "transcripts");
  const delegationDir = join(root, "delegation");
  const notesDir = join(root, "notes");
  const configPath = await writeEmptyMcpConfig(join(root, "mcp"));
  const parentSession = "delegate-cli-parent";
  // 子 run 写这个文件（入参里带 CHILD_ONLY_MARKER）；父 run 的入参/结果里都不带它。
  const childOnlyFile = join(root, `${CHILD_ONLY_MARKER}.txt`);

  const provider = createRoutingFakeProvider({
    parentScript: [
      {
        content: [{
          type: "tool_use",
          id: "deleg-cli-1",
          name: "delegate",
          input: { action: "run", task: "写一个只有子 run 才写的文件" },
        }],
        stopReason: "tool_use",
      },
      // 父 run 走 CLI 的 completion 启发式：终稿里带「任务已完成」信号才当场收尾（否则会被
      // 「连续无工具 N 轮」推着多跑几轮，脚本就不是两发了）。
      { content: [{ type: "text", text: "任务已完成：父 run 收尾" }], stopReason: "end_turn" },
    ],
    childScript: [
      {
        content: [{
          type: "tool_use",
          id: "child-tool-1",
          name: "writeFile",
          input: { path: childOnlyFile, content: "child" },
        }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "任务已完成：子 run 收尾" }], stopReason: "end_turn" },
    ],
  });

  const result = await runChat({
    prompt: "派生一个子任务并等它跑完",
    session: parentSession,
    cwd: root,
    dir: parentDir,
    notesDir,
    skillsDir: join(root, "skills"),
    configPath,
    provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    maxRounds: 4,
    idleTimeout: 0,
    delegate: true,
    delegationDir,
    toolOutput: () => {},
    idleLog: () => {},
  });

  // 父 run 正常收尾，且**真的**调到了 delegate（前台派生 ⇒ 拿回子 run 的 text）。
  assert.equal(result.termination?.reason, "end_turn");
  assert.equal(provider.seen.child, 2, "子 run 应该被真的跑起来（两轮：写文件 + 收尾）");
  assert.equal(await readFile(childOnlyFile, "utf8"), "child", "子 run 的工具真的执行了");

  // —— 判据 ①：父会话文件里不出现子 run 的行 ——
  const parentTranscript = join(parentDir, `${parentSession}.jsonl`);
  assert.equal(existsSync(parentTranscript), true, `父会话文件应存在：${parentTranscript}`);
  const parentText = await readFile(parentTranscript, "utf8");
  assert.ok(parentText.includes("父 run 收尾"), "父会话文件里应有父 run 自己的轮次（反向证）");
  assert.ok(parentText.includes("子 run 收尾"), "父会话文件里应有子 run 的终稿（它是 delegate 工具结果，反向证）");
  assert.equal(
    parentText.includes(CHILD_ONLY_MARKER),
    false,
    "父会话文件里出现了只属于子 run 的工具入参 ⇒ 子 run 追加进了父的会话文件（互踩）",
  );

  // —— 判据 ②：子 run 的 transcript 落在名册目录下，且真有自己的行 ——
  const rosterFiles = readdirSync(delegationDir).filter((name) => name.endsWith(".json"));
  assert.equal(rosterFiles.length, 1, "派生一次应恰好一条名册记录");
  const childRecord = JSON.parse(await readFile(join(delegationDir, rosterFiles[0]), "utf8"));
  assert.equal(childRecord.parentRunId, parentSession, "子名册的 parentRunId 逐字等于父 runId");
  assert.equal(childRecord.state, "completed");
  assert.equal(childRecord.termination, "end_turn");

  const childTranscript = join(delegationDir, "transcripts", `${childRecord.runId}.jsonl`);
  assert.equal(existsSync(childTranscript), true, `子 run 的 transcript 应在名册目录下：${childTranscript}`);
  const childText = await readFile(childTranscript, "utf8");
  assert.ok(childText.includes(CHILD_ONLY_MARKER), "子会话文件里应有子 run 自己的工具入参（反向证）");
  assert.notEqual(childTranscript, parentTranscript, "父子必须是两个不同的会话文件");
});

test("默认关的整条链路：不开 --delegate 时 runChat 不派生、不建名册目录", async () => {
  const root = await makeTmp("erix-cli-delegate-off-");
  const configPath = await writeEmptyMcpConfig(join(root, "mcp"));
  const delegationDir = join(root, "delegation");
  const provider = createRoutingFakeProvider({
    parentScript: [{ content: [{ type: "text", text: "没派生" }], stopReason: "end_turn" }],
    childScript: [],
  });
  const result = await runChat({
    prompt: "什么也不做",
    session: "delegate-cli-off",
    cwd: root,
    dir: join(root, "transcripts"),
    notesDir: join(root, "notes"),
    skillsDir: join(root, "skills"),
    configPath,
    provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    maxRounds: 2,
    idleTimeout: 0,
    delegationDir,
    toolOutput: () => {},
    idleLog: () => {},
  });
  assert.equal(result.finalText, "没派生");
  assert.equal(existsSync(delegationDir), false, "默认关时一个名册字节都不该落盘");
  assert.equal(provider.seen.child, 0);
  // 默认值与常量同源（不在测试里手抄 2 / 600000）。
  assert.equal(DEFAULT_DELEGATE_MAX_CHILDREN, 2);
  assert.equal(DEFAULT_DELEGATE_TIMEOUT_MS, 600_000);
});

test("repl：--delegate 注册 delegate，且真的能派生子 run（与 chat 同一套装配）", async () => {
  const home = await makeTmp("erix-repl-delegate-");
  const delegationDir = join(home, "delegation");
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  const configPath = await writeEmptyMcpConfig(join(home, "mcp"));
  const seen = { tools: [], delegate: undefined };
  // 子 run 走真 runToolLoop + 这个假 provider（父循环被 io.loop 换成下面的桩）。
  const provider = createRoutingFakeProvider({
    parentScript: [],
    childScript: [{ content: [{ type: "text", text: "任务已完成：pong" }], stopReason: "end_turn" }],
  });
  try {
    const run = runRepl(
      ["--session", "repl-delegate", "--delegate", "--config", configPath, "--dir", join(home, "transcripts")],
      {
        input,
        output,
        home,
        notesDir: join(home, "notes"),
        // 名册目录注入临时目录（不许污染真实 ~/.erix）。
        delegationDir,
        config: { model: "fake-model", maxOutputTokens: 1000 },
        providerFactory: () => provider,
        loop: async (loopOptions) => {
          seen.tools = loopOptions.tools.map((tool) => tool.name);
          // 走真执行端口（含 wrapExecuteTool 的结构化解包），父身份从 context.runId 自取。
          seen.delegate = await loopOptions.executeTool({
            name: "delegate",
            input: { action: "run", task: "只回答一个词：pong" },
            context: { runId: "repl-delegate" },
          });
          return {
            finalText: "done",
            messages: [],
            rounds: 1,
            usage: { input_tokens: 0, output_tokens: 0 },
            compactionStats: [],
          };
        },
      },
    );
    input.end("派生一次\n/exit\n");
    await run;

    assert.ok(seen.tools.includes("delegate"), `repl 的注册面应含 delegate，实际 ${seen.tools.join(",")}`);
    // `wrapExecuteTool({ returnMetadata: true })` 把结果包成 `{ data }`（引擎侧由
    // `normalizeExecutionResult` 解包；这里直接读端口，所以读 `.data`）。
    assert.equal(seen.delegate?.data?.ok, true);
    assert.equal(seen.delegate?.data?.state, "completed");
    assert.equal(seen.delegate?.data?.text, "任务已完成：pong", "前台派生应把子 run 的 text 交回");

    const rosterFiles = readdirSync(delegationDir).filter((name) => name.endsWith(".json"));
    assert.equal(rosterFiles.length, 1, "repl 侧派生也应写一条名册记录");
    const record = JSON.parse(await readFile(join(delegationDir, rosterFiles[0]), "utf8"));
    assert.equal(record.parentRunId, "repl-delegate", "父身份来自 repl 的执行上下文");
    assert.equal(record.state, "completed");
  } finally {
    input.destroy();
    output.destroy();
  }
});

// issue #626（C1）：`tail` 的读侧早就实现了，但**真装配**从没走过——库在派生时建记录，它不知道宿主
// 把子 run 的 transcript 写在哪，CLI 算出了 `<rosterDir>/transcripts` 却从没把它登记进名册，于是父
// run 的 `tail` 永远报 `no_transcript`（真机现场：名册 `transcriptPath: null`，盘上文件却在）。
// 这条测试就是那个缺口的钉子：走 `createCliDelegation`（真装配）派一个子 run，断言
// ① 名册登记了非空且真存在的 transcriptPath；② `tail` 读得到，rows 里含子的工具名；
// ③ 尾读**没有**把子 transcript 改小（防日后有人把它换回 `store.load()`——那会 repairTranscriptTail
// 截断正在被追加写的那一行）。
test("真装配（#626 C1）：createCliDelegation 派生的子 run 在名册里登记 transcriptPath，父 tail 真读得到", async () => {
  const root = await makeTmp("erix-cli-delegate-tail-626-");
  const delegationDir = join(root, "delegation");
  const childTranscriptDir = join(delegationDir, "transcripts");
  const childOnlyFile = join(root, "child-tail-626.txt");

  // 父 run 不参与（这里直接调装配出来的 execute），子 run 两轮：写一个文件 + 收尾。
  const provider = createRoutingFakeProvider({
    parentScript: [],
    childScript: [
      {
        content: [{
          type: "tool_use",
          id: "child-tail-626-1",
          name: "writeFile",
          input: { path: childOnlyFile, content: "child-tail-626" },
        }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "任务已完成：子 run 收尾" }], stopReason: "end_turn" },
    ],
  });

  const delegation = createCliDelegation({
    buildProvider: () => provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    cwd: root,
    todo: false,
    notesDir: join(root, "notes"),
    rosterDir: delegationDir,
    maxRounds: 4,
    notify: () => {},
    childToolOutput: () => {},
  });

  const ran = await delegation.execute({ action: "run", task: "写一个文件然后收尾" }, { runId: "parent-626" });
  assert.equal(ran.ok, true, `前台派生应该成功：${JSON.stringify(ran)}`);
  assert.equal(ran.state, "completed");
  assert.equal(await readFile(childOnlyFile, "utf8"), "child-tail-626", "子 run 的工具真的执行了");

  // —— 判据 ①：名册记录里的 transcriptPath 非空且真在盘上 ——
  const record = readRecord(delegationDir, ran.runId);
  assert.ok(record !== null, "子 run 必须有名册记录");
  assert.equal(record.parentRunId, "parent-626", "父身份来自执行上下文");
  assert.equal(typeof record.transcriptPath, "string", "名册必须登记 transcriptPath（#626 C1 的根因）");
  assert.notEqual(record.transcriptPath, "", "空串等于没登记");
  assert.equal(existsSync(record.transcriptPath), true, `登记的路径必须真在盘上：${record.transcriptPath}`);
  // 路径必须复用 store 自己的命名口径，不是手拼 `${runId}.jsonl`——两者对不安全的 id **不恒等**：
  assert.notEqual(transcriptPath("/d", "a/b"), join("/d", "a/b.jsonl"), "safeRunId 会哈希不安全 id，手拼恒错");
  assert.equal(
    record.transcriptPath,
    transcriptPath(childTranscriptDir, ran.runId),
    "CLI 登记的路径必须逐字等于 store 的 transcriptPath(dir, runId)",
  );

  // —— 判据 ②：tail 返回 ok:true，rows 里含子 run 的工具名 ——
  // 先往子 transcript 尾部追加一行「写盘进行中的半截」：尾读若哪天被换回 load()，
  // repairTranscriptTail 会把它截掉 ⇒ 判据 ③ 红（这一行就是那个探针）。
  appendFileSync(
    record.transcriptPath,
    '{"round":99,"kind":"message","seq":0,"messages":[{"role":"assist',
    "utf8",
  );
  const sizeBefore = statSync(record.transcriptPath).size;

  const tail = await delegation.execute({ action: "tail", runId: ran.runId }, { runId: "parent-626" });
  assert.equal(tail.ok, true, `tail 必须读得到（不是 no_transcript_path / no_transcript）：${JSON.stringify(tail)}`);
  assert.equal(tail.transcriptPath, record.transcriptPath);
  assert.equal(tail.state, "completed");
  const toolRow = tail.rows.find((row) => row.kind === "tool_use");
  assert.ok(toolRow, `rows 里必须有子的 tool_use 行：${JSON.stringify(tail.rows)}`);
  assert.equal(toolRow.tool, "writeFile", "tail 必须点名子 run 在跑哪个工具");
  assert.match(String(toolRow.argsDigest), /child-tail-626\.txt/u, "参数摘要里要有子的入参");
  assert.equal(tail.partial, true, "尾部那行半截 JSON 是写盘进行中的正常现象（不抛、不丢好行）");

  // —— 判据 ③：尾读没有动刀（字节数不减）——
  const sizeAfter = statSync(record.transcriptPath).size;
  assert.equal(
    sizeAfter,
    sizeBefore,
    "tail 把子 transcript 改小了 ⇒ 尾读走了 load()/repairTranscriptTail（父读一次就截子一刀）",
  );
});
