#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createFoldStatisticalStrategy,
  createMemoryTranscriptStore,
  createOpenAIProvider,
  runToolLoop,
} from "../src/index.js";

const HELP_TEXT = `用法：
  erix --version, -v
  erix --help, -h
  erix chat "<prompt>" [--compact-budget <tokens>] [--max-rounds <n>]

环境变量：
  LLM_KIT_ENDPOINT   OpenAI 兼容 API 地址（必填）
  LLM_KIT_API_KEY    API 密钥（必填）
  LLM_KIT_MODEL      模型名称（默认：kimi-for-coding）`;

class CliError extends Error {
  constructor(message, { showHelp = false } = {}) {
    super(message);
    this.name = "CliError";
    this.showHelp = showHelp;
  }
}

function printHelp() {
  console.log(HELP_TEXT);
}

function usageError(message) {
  throw new CliError(message, { showHelp: true });
}

function readVersion() {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  return packageJson.version;
}

function parseIntegerOption(name, rawValue, minimum) {
  if (!/^\d+$/.test(rawValue)) {
    usageError(`${name} 必须是大于等于 ${minimum} 的整数`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum) {
    usageError(`${name} 必须是大于等于 ${minimum} 的整数`);
  }
  return value;
}

function parseChatArgs(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { showHelp: true };
  }

  let prompt;
  const options = {};
  const seenOptions = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--compact-budget" || argument === "--max-rounds") {
      if (seenOptions.has(argument)) {
        usageError(`参数重复：${argument}`);
      }
      seenOptions.add(argument);

      const rawValue = args[index + 1];
      if (rawValue === undefined) {
        usageError(`${argument} 缺少数值`);
      }
      index += 1;

      if (argument === "--compact-budget") {
        options.compactBudget = parseIntegerOption(argument, rawValue, 0);
      } else {
        options.maxRounds = parseIntegerOption(argument, rawValue, 1);
      }
      continue;
    }

    if (argument.startsWith("-")) {
      usageError(`未知参数：${argument}`);
    }
    if (prompt !== undefined) {
      usageError(`只能提供一个 prompt，收到多余参数：${argument}`);
    }
    prompt = argument;
  }

  return { prompt, ...options };
}

function readEnvironment() {
  const endpoint = process.env.LLM_KIT_ENDPOINT?.trim();
  const apiKey = process.env.LLM_KIT_API_KEY?.trim();
  const model = process.env.LLM_KIT_MODEL?.trim() || "kimi-for-coding";
  const missing = [];

  if (!endpoint) missing.push("LLM_KIT_ENDPOINT");
  if (!apiKey) missing.push("LLM_KIT_API_KEY");
  if (missing.length > 0) {
    throw new CliError(
      `缺少环境变量：${missing.join("、")}。\n请先设置，例如：\n  export LLM_KIT_ENDPOINT="https://你的 OpenAI 兼容 API 地址"\n  export LLM_KIT_API_KEY="你的 API 密钥"`,
    );
  }

  return { endpoint, apiKey, model };
}

async function runChat({ prompt, compactBudget, maxRounds }) {
  const config = readEnvironment();
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new CliError("chat 需要提供 prompt，例如：erix chat \"你好\"");
  }

  const provider = createOpenAIProvider({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: 120_000,
  });
  const store = createMemoryTranscriptStore();
  const loopOptions = {
    provider,
    system: "你是 erix-llm-kit 的对话循环引擎演示。当前没有可用工具，请直接回答用户的问题。",
    initialUserMessage: prompt,
    store,
    runId: `cli-${Date.now()}`,
    onRound: (info) => console.log(`[round ${info.round}]`),
  };

  if (maxRounds !== undefined) loopOptions.maxRounds = maxRounds;
  if (compactBudget !== undefined) {
    loopOptions.context = {
      strategy: createFoldStatisticalStrategy(),
      budgetTokens: compactBudget,
    };
  }

  const result = await runToolLoop(loopOptions);
  const compacted = result.compactionStats.some((stat) => stat.compacted === true);
  console.log(`\n=== 终稿 ===\n${result.finalText}`);
  console.log(
    `\n=== 统计 === rounds=${result.rounds} truncated=${result.truncated} usage=${JSON.stringify(result.usage)} compacted=${compacted}`,
  );
}

async function main(args) {
  if (args.length === 0) {
    printHelp();
    return;
  }

  const command = args[0];
  if (command === "--version" || command === "-v") {
    if (args.length !== 1) usageError(`未知参数：${args[1]}`);
    console.log(readVersion());
    return;
  }
  if (command === "--help" || command === "-h") {
    if (args.length !== 1) usageError(`未知参数：${args[1]}`);
    printHelp();
    return;
  }
  if (command !== "chat") {
    usageError(`未知子命令：${command}`);
  }

  const chatArgs = parseChatArgs(args.slice(1));
  if (chatArgs.showHelp) {
    printHelp();
    return;
  }
  await runChat(chatArgs);
}

if (
  import.meta.url === `file://${process.argv[1]}`
  || (
    process.argv[1] !== undefined
    && existsSync(process.argv[1])
    && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  )
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`错误：${error?.message ?? String(error)}`);
    if (error?.showHelp) console.error(`\n${HELP_TEXT}`);
    process.exitCode = 1;
  }
}
