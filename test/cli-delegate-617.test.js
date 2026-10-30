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
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parseChatArgs, runChat } from "../bin/cli.js";
import { parseReplArgs } from "../bin/repl.js";
import {
  DEFAULT_DELEGATE_MAX_CHILDREN,
  DEFAULT_DELEGATE_TIMEOUT_MS,
  resolveDelegationDir,
} from "../bin/delegation.js";
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
