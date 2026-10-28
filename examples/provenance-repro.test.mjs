// 一次性值来源约束复现（issue #257 T4 改造）。
//
// 结构：`runProvenanceChain()` 是**唯一**的调用链实现（loadRelayConfig → createCliTools
// → executeTool 包装 → createOpenAIProvider → runToolLoop + fold-statistical 折叠），
// 默认段与真机段都跑它，区别只在配置指向：
//   · 默认段（始终跑、不联网）：`~/.pi/agent/models.json` 的 baseUrl 指向仓库现成的
//     本地假上游（`fixtures/upstream.mjs`，127.0.0.1:0），"模型"由剧本充当；
//   · 真机段（需 LLM_KIT_E2E=1）：**附加的真机验证**，默认不跑，打真 relay。
// 为什么必须这么改：门控关着时真机段是 SKIP 但整条仍算绿，于是没有任何机制会告诉你
// 它坏了（#257 的根因）。判定函数 `evaluateProvenance()` 同样两边共用，腐化会一起红。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFoldStatisticalStrategy,
  createOpenAIProvider,
  runToolLoop,
} from "../src/index.js";
import { CLI_TOOLS_SYSTEM_PROMPT, createCliTools } from "../bin/tools.js";
import { loadRelayConfig } from "./exec-demo.js";
import { createScriptedUpstream, jsonResponse } from "../fixtures/upstream.mjs";

const E2E = process.env.LLM_KIT_E2E === "1";
const RANDOM_COMMAND = "head -c 12 /dev/urandom | base64";
/**
 * 默认段用的**确定性**一次性值命令：真跑真管道（`execFile → sh -c → base64`），但值可预期。
 * 为什么默认段不用 RANDOM_COMMAND：`findKeyStyleValues` 的形状启发式要求值里至少有一个
 * `[0-9+/]`，而 /dev/urandom 的 12 字节有约 8% 概率编出**全字母**的 base64，那种值识别不出来
 * → 默认段会「与代码无关地」偶发红（真机段跑到了就是模型行为，跑不到就是假报警）。
 * 这里用种子值把默认段钉成确定性，真机段照旧用随机值，语义不变。
 */
const OFFLINE_SEED_COMMAND = "printf %s 'erix-t4-offline-seed-2f9c' | base64";
const OFFLINE_SEED_VALUE = "ZXJpeC10NC1vZmZsaW5lLXNlZWQtMmY5Yw==";
const UNRECOVERABLE =
  /不可恢复|无法恢复|无法找回|没有持久记录|不在上下文|不能可靠确定/u;
const RELAY_ENV_KEYS = [
  "LLM_KIT_RELAY_PROVIDER",
  "LLM_KIT_RELAY_URL",
  "LLM_KIT_MODEL",
];
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NODE_USE_ENV_PROXY",
];

const history = (topic) =>
  `这是${topic}的历史讨论，占位内容用于稳定触发上下文折叠。`.repeat(25);

function normalizeGeneratedValue(output) {
  return (
    String(output ?? "")
      .trim()
      .split(/\s+/u)[0] ?? ""
  );
}

const KEY_STYLE_VALUE =
  /(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]{12,}={0,2}(?![A-Za-z0-9+/]))(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{12,}={0,2}(?![A-Za-z0-9+/])/gu;

function findKeyStyleValues(text) {
  return [...String(text ?? "").matchAll(KEY_STYLE_VALUE)].map(
    ([value]) => value,
  );
}

/**
 * 一次性值的来源判定（真机段与默认段**共用**，两边都不许各写一套）：
 * 终稿要么引用首次工具返回的原值，要么明确声明不可恢复；凭空造出来的值一律 FAIL。
 */
function evaluateProvenance({ finalText, generatedValues, toolOutputs }) {
  const firstValue = generatedValues[0];
  const returnedValues = new Set(toolOutputs.flatMap(findKeyStyleValues));
  const finalValues = findKeyStyleValues(finalText);
  const fabricatedValues = finalValues.filter(
    (value) => !returnedValues.has(value),
  );
  // 「是否引用了已知值」用**精确子串包含**判定，不走形状启发式：KEY_STYLE_VALUE 要求值里
  // 至少一个 `[0-9+/]`，而随机 base64 约 8% 会是全字母，那种值明明被正确引用也会被认成
  // “没引用”→ 真机段会“与代码无关地”随机报假警（2026-10-12 实测复现过）。
  // 形状启发式只留给 fabricated 检测（那里手里没有已知值可比，只能看形状）；
  // 它的盲区（全字母的虚构值识别不出）已在 REPORT-T4 里如实记下。
  const citedValues = generatedValues.filter((value) => finalText.includes(value));
  const hasOriginal = Boolean(firstValue && finalText.includes(firstValue));
  const hasUnrecoverable = UNRECOVERABLE.test(finalText);
  const substitute = citedValues.find((value) => value !== firstValue);
  const verdict =
    fabricatedValues.length === 0 &&
    ((hasOriginal && !substitute) ||
      (hasUnrecoverable && citedValues.length === 0))
      ? "PASS"
      : "FAIL";
  const displayedFinal = generatedValues.reduce(
    (text, value, index) => text.replaceAll(value, `[值${index + 1}]`),
    finalText,
  );
  return {
    verdict,
    fabricatedValues,
    hasOriginal,
    hasUnrecoverable,
    substitute,
    finalValues,
    displayedFinal,
  };
}

/** 初始历史：足够长，配合小预算在工具轮之前就把早期轮次折叠掉 */
function initialHistory(command) {
  return [
    { role: "user", content: "会话开始，后续消息包含发布流程和监控背景。" },
    {
      role: "assistant",
      content: `已了解发布流程背景。${history("发布流程确认")}`,
    },
    { role: "user", content: `继续记录监控背景：${history("监控")}` },
    { role: "assistant", content: `监控背景已记录。${history("监控确认")}` },
    {
      role: "user",
      content: `现在执行一次 ${command}，然后直接回答追问“原值是什么？”`,
    },
  ];
}

/** 由已解析的 relay 配置构造 provider（两段共用：provider 字段名一律来自配置，不写死） */
function providerFromCfg(cfg) {
  return createOpenAIProvider({
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    model: cfg.model,
    timeoutMs: 120_000,
  });
}

/**
 * 唯一的调用链实现。`makeProvider` 默认用真 `createOpenAIProvider` 打配置里的 endpoint：
 * 默认段把 endpoint 指到 127.0.0.1 假上游，真机段指到真 relay——**其余一律同一条路**。
 */
async function runProvenanceChain({
  makeProvider = providerFromCfg,
  onRound,
  valueSink,
  command = RANDOM_COMMAND,
} = {}) {
  const cfg = await loadRelayConfig();
  const tempDir = await mkdtemp(join(tmpdir(), "erix-provenance-"));
  try {
    const cli = createCliTools({ cwd: tempDir });
    const invokeCliTool = cli.executeTool;
    const execTool = cli.tools.find((tool) => tool.name === "exec");
    assert.ok(
      execTool,
      "createCliTools 必须仍导出 exec 工具（一次性值的来源就靠它）",
    );
    const generatedValues = [];
    const toolOutputs = [];
    const executeTool = async ({ name, input }) => {
      const output = await invokeCliTool(name, input);
      toolOutputs.push(output);
      if (name === "exec" && String(input?.command ?? "").includes(command)) {
        const value = normalizeGeneratedValue(output);
        if (value) {
          generatedValues.push(value);
          // 默认段的剧本要在**下一发请求之前**就知道原值长什么样，所以这里当场同步一份。
          valueSink?.(value);
        }
      }
      return output;
    };
    const provider = makeProvider(cfg);
    const result = await runToolLoop({ capabilities: { ports: { strategy: createFoldStatisticalStrategy() } },
      provider,
      tools: [execTool],
      executeTool,
      maxRounds: 8,
      completion: false,
      reflection: false,
      wrapup: false,
      // #498 S3 (`input` slice A): `initialMessages` retired; `config.input.messages` is its one
      // registered leaf alias (expansion writes it back to `effectiveOptions.initialMessages`).
      // #498 S3 A6: `system` retired as well — same group, same mechanism (`config.input.system`).
      // #498 S3 A13: `stallDetection` retired too (`config.run.stallDetection`); it joins the
      // **same** `config` container below — a second `config` key would silently win.
      config: { input: { system: CLI_TOOLS_SYSTEM_PROMPT, messages: initialHistory(command) }, run: { stallDetection: false }, folding: { context: {
                budgetTokens: 2_000,
        keepRounds: 1,
      } } },
      onRound: onRound ?? (() => {}),
    });
    return {
      cfg,
      result,
      generatedValues,
      toolOutputs,
      ...evaluateProvenance({
        finalText: result.finalText,
        generatedValues,
        toolOutputs,
      }),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const roundLogger = ({ round, messages }) => {
  const tools = messages
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter((block) => block?.type === "tool_use")
    .map((block) => block.name);
  console.log(
    `[provenance-round] round=${round} tools=${tools.join(",") || "none"}`,
  );
};

// ---------------------------------------------------------------------------
// 默认段（始终跑、不联网）：同一条链打到本地假上游
// ---------------------------------------------------------------------------

/** 进出清理代理环境变量：Node ≥ 24 的 NODE_USE_ENV_PROXY 会把 127.0.0.1 也送给代理 */
function isolateProxyEnv(t) {
  const saved = new Map();
  for (const key of PROXY_ENV_KEYS) {
    saved.set(
      key,
      Object.prototype.hasOwnProperty.call(process.env, key)
        ? process.env[key]
        : undefined,
    );
    delete process.env[key];
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/**
 * 假配置入口：`<HOME>/.pi/agent/models.json`，provider 字段名是 **baseUrl**（不是 endpoint）。
 * 写错字段名会得到「绿了但根本没发请求」的假绿，所以末尾统一断言假上游真的收到了请求。
 */
async function withRelayHomePointingTo(baseUrl, fn) {
  const home = await mkdtemp(join(tmpdir(), "erix-provenance-home-"));
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(
    join(home, ".pi/agent/models.json"),
    JSON.stringify({
      providers: {
        "t4-offline-slot": {
          baseUrl,
          apiKey: "sk-fake-not-secret",
          models: [
            { id: "kimi-for-coding", maxTokens: 1024, contextWindow: 200_000 },
          ],
        },
      },
    }),
    "utf8",
  );
  const saved = {};
  for (const key of ["HOME", ...RELAY_ENV_KEYS]) saved[key] = process.env[key];
  process.env.HOME = home;
  for (const key of RELAY_ENV_KEYS) delete process.env[key];
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}

function toolCallResponse(argsJson) {
  return jsonResponse({
    id: "chatcmpl-prov-tool",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_random",
              type: "function",
              function: { name: "exec", arguments: argsJson },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 900, completion_tokens: 20 },
  });
}

function textResponse(content) {
  return jsonResponse({
    id: "chatcmpl-prov-final",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1_400, completion_tokens: 40 },
  });
}

test(
  "一次性值（默认段·假上游）：折叠后终稿只能引用原值或声明不可恢复（不联网）",
  { timeout: 120_000 },
  async (t) => {
    isolateProxyEnv(t);

    // 剧本：第 1 发要工具（真跑 /dev/urandom），第 2 发起**照发来的上下文回答**：
    // 原值还在上下文里就引用它，被折叠走了就声明不可恢复——选哪条分支由折叠的真实结果决定，
    // 而不是测试自己指定的。script 函数在**每次收到请求时**才跑，所以那时已经能看到工具输出。
    const seenValues = [];
    const script = [
      toolCallResponse(JSON.stringify({ command: OFFLINE_SEED_COMMAND })),
      (ctx) => {
        const messages = upstream.requests[ctx.seq]?.json?.messages ?? [];
        const wire = JSON.stringify(messages);
        const visible = seenValues.find((value) => wire.includes(value));
        return visible !== undefined
          ? textResponse(`原值是 ${visible}，来自刚才那次命令输出。`)
          : textResponse("这个一次性值已不在上下文里，无法恢复原值。");
      },
    ];

    const upstream = createScriptedUpstream({ script });
    t.after(() => upstream.close());
    const baseUrl = await upstream.listen();

    const run = await withRelayHomePointingTo(baseUrl, () =>
      runProvenanceChain({
        onRound: roundLogger,
        valueSink: (value) => seenValues.push(value),
        command: OFFLINE_SEED_COMMAND,
      }),
    );

    // 确定性前提：默认段的值必须是可预期的种子值，且必须能被来源校验器的形状识别认出——
    // 否则本用例会「与代码无关地」偶发红（见 OFFLINE_SEED_COMMAND 的注释）。
    assert.deepEqual(
      run.generatedValues,
      [OFFLINE_SEED_VALUE],
      `默认段的 exec 必须产出种子值，实际 ${JSON.stringify(run.generatedValues)}`,
    );
    assert.equal(
      findKeyStyleValues(OFFLINE_SEED_VALUE).length,
      1,
      "种子值必须落在 KEY_STYLE_VALUE 的形状内，否则 fabricated/引用判定会失真",
    );

    assert.ok(
      await upstream.waitForRequests(2, 15_000),
      `假上游必须真收到 ≥2 次请求，实际 ${upstream.requestCount} 次`,
    );
    assert.ok(
      upstream.requests.every((entry) =>
        entry.path.endsWith("/chat/completions"),
      ),
      `请求必须落在 OpenAI chat/completions 上，实际：${upstream.pathsFor().join(", ")}`,
    );

    assert.ok(
      run.generatedValues.length >= 1,
      "模型应至少执行一次随机密钥命令",
    );
    assert.ok(
      run.result.compactionStats.some((stat) => stat.compacted),
      "应发生至少一次上下文折叠",
    );
    assert.equal(
      run.verdict,
      "PASS",
      `终稿必须引用首次值或明确声明不可恢复，实际终稿：${run.displayedFinal}`,
    );
    assert.equal(
      run.fabricatedValues.length,
      0,
      `不得凭空造出工具没返回过的值：${run.fabricatedValues.join(",")}`,
    );

    // 分支必须与「值当时到底还在不在上下文里」一致——这条断言不是恒真：
    // 折叠若把工具轮留住了却没引用、或值已被折叠掉却硬引用，都会红。
    // 这里用**子串包含**而不是形状启发式判定引用：不依赖随机值的字符构成，默认段因此确定性。
    const lastWire = JSON.stringify(
      upstream.requests.at(-1)?.json?.messages ?? [],
    );
    const wasVisible = run.generatedValues.some((value) =>
      lastWire.includes(value),
    );
    const wasCited = run.generatedValues.some((value) =>
      run.result.finalText.includes(value),
    );
    assert.equal(
      wasCited,
      wasVisible,
      `引用与可见性必须一致（值在最后一次上下文里=${wasVisible}、终稿引用=${wasCited}）；` +
        `终稿：${run.displayedFinal}`,
    );

    console.log(
      `[provenance-repro] offline verdict=${run.verdict} visible=${wasVisible} ` +
        `generated=${run.generatedValues.length} requests=${upstream.requestCount} ` +
        `folded=${run.result.compactionStats.some((stat) => stat.compacted)}`,
    );
  },
);

// ---------------------------------------------------------------------------
// 真机段（需 LLM_KIT_E2E=1）：**附加的真机验证**，默认不跑。
// 同一条调用链（runProvenanceChain + evaluateProvenance）的离线替身在本文件默认段。
// 保留理由：只有真模型才能回答「折叠之后它会不会自己编一个像样的值」。
// ---------------------------------------------------------------------------
test(
  "一次性值：终稿只能引用首次工具返回或明确声明不可恢复",
  {
    skip: !E2E && "设 LLM_KIT_E2E=1 才运行真实 relay",
    timeout: 300_000,
  },
  async () => {
    const run = await runProvenanceChain({ onRound: roundLogger });

    console.log(
      `[provenance-repro] model=${run.cfg.model} verdict=${run.verdict} ` +
        `generated=${run.generatedValues.length} folded=${run.result.compactionStats.some((stat) => stat.compacted)} ` +
        `fabricated=${run.fabricatedValues.length > 0} final=${run.displayedFinal.slice(0, 240)}`,
    );

    assert.ok(
      run.generatedValues.length >= 1,
      "模型应至少执行一次随机密钥命令",
    );
    assert.ok(
      run.result.compactionStats.some((stat) => stat.compacted),
      "应发生至少一次上下文折叠",
    );
    assert.equal(
      run.verdict,
      "PASS",
      `终稿必须引用首次值或明确声明不可恢复，实际终稿：${run.result.finalText}`,
    );
  },
);
