// exec-demo —— v0.0 垂直切片 e2e：真实 LLM + 命令执行工具的多轮工具循环
//
// 红线实证（ADR-005）：库不执行任何东西。exec 工具的执行体、白名单、超时、
// 输出截断全部在本文件（调用方侧）。库只提供 provider + runToolLoop。
//
// LLM 配置直接读 pi 的 ~/.pi/agent/models.json（apiKeyFile 哲学：凭据不落本仓库）。
//
// 用法：
//   node examples/exec-demo.js ["任务描述"]        # 手动跑
//   LLM_KIT_E2E=1 node examples/exec-demo.test.mjs # 测试形态
// 环境变量：LLM_KIT_MODEL 覆盖模型（默认 models.json 里 my-relay 的第一个模型）

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createOpenAIProvider, runToolLoop, createMemoryTranscriptStore } from "../src/index.js";

/** 从 pi models.json 读 relay 配置（单一来源，不复制凭据） */
export async function loadRelayConfig() {
  const modelsJson = JSON.parse(
    await readFile(join(homedir(), ".pi/agent/models.json"), "utf8"),
  );
  const relay = modelsJson.providers["my-relay"];
  if (!relay) throw new Error("models.json 里没有 providers['my-relay']");
  return {
    endpoint: relay.baseUrl,
    apiKey: relay.apiKey,
    // 注意：models[0]（Qwen3.5）对当前 token 未开通（relay 会透传 "not supported for current token"），
    // 默认用 kimi-for-coding（已实测工具调用可用）；LLM_KIT_MODEL 可覆盖
    model: process.env.LLM_KIT_MODEL ?? "kimi-for-coding",
    contextWindowTokens: relay.models[0].contextWindow,
    maxOutputTokens: Math.min(relay.models[0].maxTokens ?? 8192, 8192),
  };
}

// ---- 调用方安全层（示范：白名单 + 超时 + 截断，生产场景应更严）----

const EXEC_WHITELIST = new Set(["ls", "pwd", "echo", "date", "uname", "head", "cat", "wc", "find", "git"]);
const EXEC_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT = 4096;

const tools = [
  {
    name: "exec",
    description: "在白名单内执行 shell 命令（ls/pwd/echo/date/uname/head/cat/wc/find/git），返回 stdout+stderr",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的命令" } },
      required: ["command"],
    },
  },
];

function truncate(s) {
  return s.length > OUTPUT_LIMIT ? s.slice(0, OUTPUT_LIMIT) + `\n…[截断，共 ${s.length} 字符]` : s;
}

/** executeTool：库的唯一执行入口，实现在调用方 */
async function executeTool(name, input) {
  if (name !== "exec") throw new Error(`未知工具: ${name}`);
  const command = String(input?.command ?? "");
  const bin = command.trim().split(/\s+/)[0];
  if (!EXEC_WHITELIST.has(bin)) {
    return `错误：命令 "${bin}" 不在白名单（${[...EXEC_WHITELIST].join("/")}）`;
  }
  return await new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err?.killed) return resolve(`错误：命令超时（${EXEC_TIMEOUT_MS}ms）被终止`);
      const out = [stdout, stderr].filter(Boolean).join("");
      resolve(truncate(out || (err ? `退出码 ${err.code}` : "(无输出)")));
    });
  });
}

/** 跑一次 demo，返回 loop 结果（测试与 CLI 共用） */
export async function runExecDemo(task = "查看当前目录有哪些文件，并简要总结这个项目") {
  const cfg = await loadRelayConfig();
  const provider = createOpenAIProvider({
    endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: 120_000,
  });
  const store = createMemoryTranscriptStore();
  const runId = `exec-demo-${Date.now()}`;

  const result = await runToolLoop({
    provider,
    system: "你是一个命令行助手。用 exec 工具完成用户的查看类任务，然后用中文简要总结。命令必须在白名单内。",
    initialUserMessage: task,
    tools,
    executeTool,
    maxRounds: 8,
    store,
    runId,
    onRound: (info) => console.log(`[round ${info.round}] +${info.messages.length} 条消息`),
  });
  return { result, store, runId, model: cfg.model };
}

// CLI 入口（被 import 时不执行）
if (import.meta.url === `file://${process.argv[1]}`) {
  const { result, store, runId, model } = await runExecDemo(process.argv[2]);
  console.log("\n=== 终稿 ===\n" + result.finalText);
  console.log(`\n=== 统计 === model=${model} rounds=${result.rounds} truncated=${result.truncated} usage=${JSON.stringify(result.usage)}`);
  const transcript = await store.load(runId);
  console.log(`=== transcript === ${transcript.length} 轮已存 memory store`);
}
