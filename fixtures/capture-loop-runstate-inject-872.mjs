// @ts-check
// issue #872（第三轮：证据独立可验真）：本脚本是生成
// `test/fixtures/loop-runstate-inject-request-872.json` 的**捕获脚本**（原先住在仓外 `/tmp/`
// 且已丢失、又没校验捕获点的 worktree SHA，导致 fixture 的 base 来源无法独立复核）。
//
// 为什么放在根 `fixtures/`（不是 `test/fixtures/`）：静态守卫 `test/static-guards.test.js`
// 「test/ 下不再放会被 node --test 当测试执行的支撑文件」规定 `test/**/*.mjs` 的非测试支撑
// 脚本一律搬根 `fixtures/`（裸 `node --test` 会把 test/ 下任何 .mjs 当测试白跑一遍）。
//
// 为什么必须**在 base worktree 里跑**：判据 3 的期望值是「改动前（base 2ad95dfa）provider 真正
// 看到的请求体摘要」。注入行为在 base→HEAD 之间一字未动（本单硬约束），所以 base 产出的请求体
// 就是 HEAD 应有的请求体；期望值只有在 base 上量出来，才是与「观测面」无关的**独立**证据。
//
// 可复核性（本脚本存在的唯一目的）：脚本开头**硬校验**运行环境，跑不对就直接退出——
//   1) `git rev-parse HEAD` 必须等于常量 `BASE_SHA`（写死，防止在错误的树上跑出错误的期望值）；
//   2) `git status --porcelain` 除本脚本与其产物外必须干净（源码改动会污染请求体，不许捕获）。
// 判据自检：把 `BASE_SHA` 改成一个不存在的 sha 去跑 ⇒ 必须非 0 退出（本条只作注释记录，不另设测试）。
//
// 纯 ESM、零 npm 依赖（只用 node 内建 + 仓内相对模块）；`// @ts-check`。
//
// 重新生成方法（必须在该 commit 的干净 worktree 里跑）：
//   git worktree add /tmp/base-872 2ad95dfa
//   cp fixtures/capture-loop-runstate-inject-872.mjs /tmp/base-872/fixtures/
//   node /tmp/base-872/fixtures/capture-loop-runstate-inject-872.mjs
//   # 产物写到该 worktree 的 test/fixtures/loop-runstate-inject-request-872.json，再拷回主仓。

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { runDirect } from "../test/helpers/run-direct.js";
import { createFakeProvider } from "../test/helpers/fake-provider.js";

/** 期望值来源的 base commit（写死常量，勿改成动态取值，否则失去「钉死捕获点」的意义）。 */
const BASE_SHA = "2ad95dfa";

/** 跑一条 git 子命令，返回去掉首尾空白的 stdout。 */
function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// —— 硬校验：环境不对就不许捕获 ——
const measuredSha = git("rev-parse", "HEAD");
if (measuredSha !== BASE_SHA && !measuredSha.startsWith(BASE_SHA)) {
  process.stdout.write(`请在 ${BASE_SHA} 的干净 worktree 里跑本脚本。\n当前 HEAD=${measuredSha}，与 BASE_SHA=${BASE_SHA} 不符。\n`);
  process.exit(1);
}
const porcelain = git("status", "--porcelain");
// 脏树不许捕获：只有捕获工具自己（本脚本）与它的产物（fixture）可以是 untracked；
// 任何其他改动（已跟踪文件的修改/暂存、或别的 untracked 文件）都会污染请求体 ⇒ 拒绝。
const SELF = "fixtures/capture-loop-runstate-inject-872.mjs";
const OUTPUT = "test/fixtures/loop-runstate-inject-request-872.json";
const polluters = porcelain
  .split("\n")
  .map((line) => line.trimEnd())
  .filter((line) => line !== "")
  .filter((line) => !(line.startsWith("?? ") && (line.slice(3).trim() === SELF || line.slice(3).trim() === OUTPUT)));
if (polluters.length > 0) {
  process.stdout.write(`请在 ${BASE_SHA} 的干净 worktree 里跑本脚本。\n工作树有会污染请求体的改动（git status --porcelain 只允许本脚本与其产物 untracked）：\n${polluters.join("\n")}\n`);
  process.exit(1);
}
// 记录的是**实测**的 rev-parse 结果（不是常量回显）：证明捕获点确实落在这个 commit 上。
const baseSha = measuredSha;

// —— 与测试文件 test/loop-runstate-inject-872.test.js 逐字一致的两把尺 ——
// blockDigest / requestDigest 必须与测试里同名函数一字不差：两边是同一把尺，否则期望值对不上。
function blockDigest(block) {
  if (!block || typeof block !== "object") return { raw: typeof block };
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use") return { type: "tool_use", name: block.name, input: JSON.stringify(block.input ?? null) };
  if (block.type === "tool_result") {
    return { type: "tool_result", toolUseId: block.tool_use_id ?? block.toolUseId, content: typeof block.content === "string" ? block.content : JSON.stringify(block.content) };
  }
  return { type: block.type };
}
function requestDigest(requests) {
  return requests.map((req) => ({
    messages: (req.messages ?? []).map((m) => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.map(blockDigest) : [{ type: "text", text: String(m.content ?? "") }],
    })),
  }));
}

// —— 五个场景：与测试文件 runScenario / runContinuation 逐字等位 ——
const bigTtl = `line: ${"x".repeat(20_000)}`;
const midToolOutput = "payload: ".padEnd(1500, "x");
const contBigText = "truncated reasoning: ".padEnd(2200, "y");

async function runScenario(name) {
  const spec = {
    "low-budget": { shape: "sss", maxRounds: 4 },
    "generous": { shape: "s", maxRounds: 8 },
    "ttl-request": { shape: "BsBs", maxRounds: 8, foldTtl: 2 },
    "persist-fold": { shape: "ssss", maxRounds: 8, persistFold: true },
  }[name];
  const steps = spec.shape.split("").map((kind, index) => ({
    content: [{
      type: "tool_use",
      id: `call-${index + 1}`,
      name: "scan",
      input: { path: `src/f${index + 1}.js`, big: kind === "B" },
    }],
    stopReason: "tool_use",
  }));
  const provider = createFakeProvider([
    ...steps,
    { content: [{ type: "text", text: "最终结论：完成" }], stopReason: "end_turn" },
  ]);
  const events = [];
  await runDirect({
    provider,
    seed: "scan it",
    executeTool: async ({ input }) => (spec.persistFold ? midToolOutput : (input.big ? bigTtl : "small result")),
    maxRounds: spec.maxRounds,
    stallDetection: false,
    completion: false,
    ...(spec.foldTtl
      ? {
        config: { folding: { toolResultTtl: spec.foldTtl } },
        semanticStateProvider: ({ state }) => ({
          text: "notes: use note_list before note_read",
          version: state.stateVersion,
        }),
      }
      : {}),
    ...(spec.persistFold ? { config: { folding: { context: { budgetTokens: 400 } } } } : {}),
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  return requestDigest(provider.requests);
}

async function runContinuation() {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "c-1", name: "scan", input: { path: "f1.js" } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "c-2", name: "scan", input: { path: "f2.js" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: contBigText }], stopReason: "max_tokens" },
    { content: [{ type: "text", text: "final" }], stopReason: "end_turn" },
  ]);
  const events = [];
  await runDirect({
    provider,
    seed: "scan it",
    executeTool: async () => midToolOutput,
    maxRounds: 8,
    stallDetection: false,
    completion: false,
    config: { folding: { context: { budgetTokens: 400 } } },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  return requestDigest(provider.requests);
}

const fixture = {
  _meta: {
    source: `base worktree ${BASE_SHA} 现跑现取（等位脚本 fixtures/capture-loop-runstate-inject-872.mjs），runToolLoop 各场景 provider.requests 的稳定摘要（requestDigest：每条请求 messages 的 role + 每块 type + 文本块全文 / tool_use 的 name+入参JSON / tool_result 的 toolUseId+正文）。`,
    note: "注入行为在 base→HEAD 之间一字未动（本单硬约束），HEAD 同脚本产出的请求体逐字等于 base（已实测 5/5 场景 base==head）。判据 3 因此拿这份 base 摘要当期望值：注入文本变 ⇒ HEAD 摘要变 ⇒ 红；少一条注入块 ⇒ 红。",
    regenerate: "在 base 的干净 worktree 里跑本脚本：git worktree add /tmp/base-872 2ad95dfa && cp fixtures/capture-loop-runstate-inject-872.mjs /tmp/base-872/fixtures/ && node /tmp/base-872/fixtures/capture-loop-runstate-inject-872.mjs，再把产出的 test/fixtures/loop-runstate-inject-request-872.json 拷回主仓。脚本开头硬校验 HEAD==BASE_SHA 且工作树干净，否则非 0 退出。",
    // 三个可核对字段：baseSha 是实测的 rev-parse 结果（非 `BASE_SHA` 常量回显）。
    baseSha,
    capturedAt: new Date().toISOString(),
    nodeVersion: process.version,
  },
  "low-budget": await runScenario("low-budget"),
  "generous": await runScenario("generous"),
  "ttl-request": await runScenario("ttl-request"),
  "persist-fold": await runScenario("persist-fold"),
  continuation: await runContinuation(),
};

const outUrl = new URL("../test/fixtures/loop-runstate-inject-request-872.json", import.meta.url);
writeFileSync(outUrl, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
process.stdout.write(
  `已写出 ${outUrl.pathname}\nbaseSha=${baseSha} capturedAt=${fixture._meta.capturedAt} nodeVersion=${fixture._meta.nodeVersion}\n`,
);
