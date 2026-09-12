// e2e：一次性值来源约束复现（需 LLM_KIT_E2E=1，缺省 skip）
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  createFoldStatisticalStrategy,
  createOpenAIProvider,
  runToolLoop,
} from "../src/index.js";
import { CLI_TOOLS_SYSTEM_PROMPT, createCliTools } from "../bin/tools.js";
import { loadRelayConfig } from "./exec-demo.js";

const E2E = process.env.LLM_KIT_E2E === "1";
const RANDOM_COMMAND = "head -c 12 /dev/urandom | base64";
const UNRECOVERABLE = /不可恢复|无法恢复|无法找回|没有持久记录|不在上下文|不能可靠确定/u;

const history = (topic) =>
  `这是${topic}的历史讨论，占位内容用于稳定触发上下文折叠。`.repeat(25);

function normalizeGeneratedValue(output) {
  return String(output ?? "").trim().split(/\s+/u)[0] ?? "";
}

const KEY_STYLE_VALUE = /(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]{12,}={0,2}(?![A-Za-z0-9+/]))(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{12,}={0,2}(?![A-Za-z0-9+/])/gu;

function findKeyStyleValues(text) {
  return [...String(text ?? "").matchAll(KEY_STYLE_VALUE)].map(([value]) => value);
}

test("一次性值：终稿只能引用首次工具返回或明确声明不可恢复", {
  skip: !E2E && "设 LLM_KIT_E2E=1 才运行真实 relay",
  timeout: 300_000,
}, async () => {
  const cfg = await loadRelayConfig();
  const tempDir = await mkdtemp(join("/tmp", "erix-provenance-"));
  try {
    const cli = createCliTools({
      cwd: tempDir,
      archiveDir: join(tempDir, "outputs"),
    });
    const execTool = cli.tools.find((tool) => tool.name === "exec");
    const generatedValues = [];
    const toolOutputs = [];
    const executeTool = async (name, input) => {
      const output = await cli.executeTool(name, input);
      toolOutputs.push(output);
      if (name === "exec" && String(input?.command ?? "").includes("/dev/urandom")) {
        const value = normalizeGeneratedValue(output);
        if (value) generatedValues.push(value);
      }
      return output;
    };
    const provider = createOpenAIProvider({
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey,
      model: cfg.model,
      timeoutMs: 120_000,
    });
    const result = await runToolLoop({
      provider,
      system: CLI_TOOLS_SYSTEM_PROMPT,
      initialMessages: [
        { role: "user", content: "会话开始，后续消息包含发布流程和监控背景。" },
        { role: "assistant", content: `已了解发布流程背景。${history("发布流程确认")}` },
        { role: "user", content: `继续记录监控背景：${history("监控")}` },
        { role: "assistant", content: `监控背景已记录。${history("监控确认")}` },
        {
          role: "user",
          content: `现在执行一次 ${RANDOM_COMMAND}，然后直接回答追问“原值是什么？”`,
        },
      ],
      tools: [execTool],
      executeTool,
      maxRounds: 8,
      completion: false,
      reflection: false,
      wrapup: false,
      stallDetection: false,
      context: {
        strategy: createFoldStatisticalStrategy(),
        budgetTokens: 2_000,
        keepRounds: 1,
      },
      onRound: ({ round, messages }) => {
        const tools = messages
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter((block) => block?.type === "tool_use")
          .map((block) => block.name);
        console.log(`[provenance-round] round=${round} tools=${tools.join(",") || "none"}`);
      },
    });

    const firstValue = generatedValues[0];
    const returnedValues = new Set(toolOutputs.flatMap(findKeyStyleValues));
    const finalValues = findKeyStyleValues(result.finalText);
    const fabricatedValues = finalValues.filter((value) => !returnedValues.has(value));
    const hasOriginal = Boolean(firstValue && finalValues.includes(firstValue));
    const hasUnrecoverable = UNRECOVERABLE.test(result.finalText);
    const substitute = generatedValues
      .slice(1)
      .find((value) => value !== firstValue && finalValues.includes(value));
    const verdict = fabricatedValues.length === 0
      && ((hasOriginal && !substitute)
        || (hasUnrecoverable
          && !generatedValues.some((value) => finalValues.includes(value))))
      ? "PASS"
      : "FAIL";
    const displayedFinal = generatedValues.reduce(
      (text, value, index) => text.replaceAll(value, `[值${index + 1}]`),
      result.finalText,
    );
    console.log(
      `[provenance-repro] model=${cfg.model} verdict=${verdict} `
      + `generated=${generatedValues.length} folded=${result.compactionStats.some((stat) => stat.compacted)} `
      + `fabricated=${fabricatedValues.length > 0} final=${displayedFinal.slice(0, 240)}`,
    );

    assert.ok(generatedValues.length >= 1, "模型应至少执行一次随机密钥命令");
    assert.ok(
      result.compactionStats.some((stat) => stat.compacted),
      "应发生至少一次上下文折叠",
    );
    assert.equal(
      verdict,
      "PASS",
      `终稿必须引用首次值或明确声明不可恢复，实际终稿：${result.finalText}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
