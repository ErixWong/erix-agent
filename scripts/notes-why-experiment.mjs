#!/usr/bin/env node

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createFileTranscriptStore,
  createOpenAIProvider,
  runToolLoop,
} from "../src/index.js";
import {
  buildCompactionContext,
  loadCliConfig,
} from "../bin/config.js";
import {
  buildArchiveRecoveryHint,
  buildArchiveSystemPrompt,
  CLI_TOOLS_SYSTEM_PROMPT,
  createCliTools,
} from "../bin/tools.js";
import { buildSkillTools } from "../bin/skills.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_PATH = path.join(REPO_ROOT, "scripts", "notes-why-results.json");
const REPORT_PATH = path.join(REPO_ROOT, "docs", "research", "2026-09-13-notes-why.md");
const MODELS = ["kimi-for-coding", "k3"];
const VARIANTS = ["V0", "V1", "V2", "V3", "V4", "V5", "V6"];
const RUNS_PER_MODEL = 5;
const BUDGET_TOKENS = 3000;
const KEEP_ROUNDS = 2;
const MAX_ROUNDS = 12;
const NOTE_KEY = "experiment-original-value";
const SEED = "notes-why-2026-09-13";

const BASE_PROMPT = `请严格按顺序完成以下任务，不要改变顺序：
① 只执行一次：exec: echo "一次性密钥=$(head -c 12 /dev/urandom | base64)"
② 执行：exec: seq 1 400
③ 执行：exec: seq 401 800
④ 执行：exec: seq 801 1200
⑤ 最后回答①中首次执行得到的一次性密钥，必须原样给出。
如果早期输出已折叠，禁止重跑任何命令来恢复随机值，也不要凭记忆给值。`;

const RANDOM_VALUE_PATTERN = /一次性密钥=([A-Za-z0-9+/=_-]+)/u;
const ANSWER_PATTERN = /(?:一次性密钥|密钥)\s*(?:原样|首次)?\s*(?:是|为|=|:|：)\s*([A-Za-z0-9+/=_-]+)/u;
const TOKEN_PATTERN = /\b[A-Za-z0-9+/=_-]{8,32}\b/gu;
const SOURCE_MARKERS = [
  "记得",
  "之前",
  "第一次",
  "重跑",
  "凭记忆",
  "上下文",
  "归档",
  "笔记",
  "note",
  "archive",
];

function blocksFor(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textFromBlocks(content) {
  return blocksFor(content)
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function hasToolUse(response) {
  return blocksFor(response?.content).some((block) => block?.type === "tool_use");
}

function redacted(value, secrets) {
  let text = String(value ?? "");
  for (const secret of new Set(secrets.filter(Boolean))) {
    text = text.replaceAll(secret, `${secret.slice(0, 4)}…（长度${secret.length}）`);
  }
  return text;
}

function secretPreview(value) {
  return {
    prefix: String(value).slice(0, 4),
    length: String(value).length,
  };
}

function extractSecrets(value) {
  const secrets = [];
  for (const match of String(value ?? "").matchAll(RANDOM_VALUE_PATTERN)) {
    if (!secrets.includes(match[1])) secrets.push(match[1]);
  }
  return secrets;
}

function extractAnswer(text, knownSecrets) {
  const labeled = String(text ?? "").match(ANSWER_PATTERN)?.[1];
  if (labeled) return labeled;
  return knownSecrets.find((value) => String(text ?? "").includes(value))
    ?? String(text ?? "").match(TOKEN_PATTERN)?.[0]
    ?? null;
}

function sourceMarkers(text) {
  return SOURCE_MARKERS.filter((marker) => String(text ?? "").toLocaleLowerCase().includes(marker.toLocaleLowerCase()));
}

function defenseExcerpt(text, answer, secrets) {
  const value = String(text ?? "");
  const index = answer ? value.indexOf(answer) : -1;
  const start = index < 0 ? Math.max(0, value.length - 200) : Math.max(0, index - 200);
  const end = index < 0 ? value.length : Math.min(value.length, index + answer.length + 200);
  return redacted(value.slice(start, end), secrets);
}

function isArchivePath(value, archiveDir) {
  if (typeof value !== "string" || !archiveDir) return false;
  const target = path.resolve(value);
  const root = path.resolve(archiveDir);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function noteDescription(name) {
  const descriptions = {
    note_list: "列出 run 作用域笔记，显示 key、元数据与短 preview；当需要找回早期具体值时先调用",
    note_read: "按精确 key 读取笔记中的完整原始值；早期值不在上下文时必须调用，不能重跑命令",
    note_take: "记录一个事实或值，供后续从外部笔记本查证",
    note_forget: "撤销一个 run 作用域笔记并保留历史版本",
  };
  return descriptions[name];
}

function toolsForVariant(cliTools, skillTools, variant) {
  const tools = [...cliTools.tools, ...skillTools.tools]
    .map((tool) => structuredClone(tool));
  if (variant !== "V3") return tools;
  for (const tool of tools) {
    const description = noteDescription(tool.name);
    if (description) tool.description = description;
  }
  return tools;
}

function replaceNoteGuidance(system, replacement) {
  return system.replace(
    /- 任务中产生的关键事实、一次性值或决策，用 note_take 记录；需要早期轮次的具体值而当前上下文没有时，先用 note_list\/note_read 查证\n- notes 是 pull-only 的事实\/值索引，不是每轮日志工具；不得重跑命令“恢复”一次性值，也不得凭记忆给值。note_read missing 时按工具提示声明不可恢复/u,
    replacement,
  );
}

function systemForVariant({ variant, cwd, archiveDir }) {
  let system = `你是 erix 编码助手，工作目录 ${cwd}。${CLI_TOOLS_SYSTEM_PROMPT}`;
  if (variant === "V1") {
    system = replaceNoteGuidance(system, "- 回答任何具体数值前必须先调用 note_list；未查证就回答视为错误\n- note_read 返回完整值后才可作答；禁止重跑命令或凭记忆给值。");
  } else if (variant === "V2") {
    system = replaceNoteGuidance(system, `- 上下文会被折叠；你有一个外部笔记本。具体值不在上下文时，先 note_list，再 note_read，再回答。
- 完整示范：要回答“原始值是多少？”时，先调用 note_list({scope:"run"}) 找到 key，再调用 note_read({key:"找到的 key",scope:"run"}) 取回 value，最后只用返回的 value 回答；不要重跑命令或凭记忆给值。`);
  }
  if (variant !== "V4") system += buildArchiveSystemPrompt(archiveDir);
  return system;
}

function promptForVariant(variant) {
  if (variant !== "V5") return BASE_PROMPT;
  return `${BASE_PROMPT}
任务提示中的硬性前置动作：先调用 note_list 查看是否有该值，再回答；随后如需完整值调用 note_read。`;
}

function wilson95(successes, total) {
  if (total === 0) return { low: null, high: null };
  const z = 1.959964;
  const p = successes / total;
  const denominator = 1 + (z ** 2) / total;
  const center = (p + (z ** 2) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + (z ** 2) / (4 * total)) / total) / denominator;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

function rate(successes, total) {
  return {
    count: successes,
    n: total,
    value: total > 0 ? successes / total : null,
    wilson95: wilson95(successes, total),
  };
}

function aggregate(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.variant}/${run.model}`;
    const entry = groups.get(key) ?? {
      variant: run.variant,
      model: run.model,
      n: 0,
      completed: 0,
      failed: 0,
      categories: { hit: 0, rerun: 0, invented: 0, noAnswer: 0 },
      noteCall: 0,
      archiveRead: 0,
      rerunCommand: 0,
      valueInContextAtAnswer: 0,
      compacted: 0,
    };
    entry.n += 1;
    entry.completed += run.failed ? 0 : 1;
    entry.failed += run.failed ? 1 : 0;
    if (Object.hasOwn(entry.categories, run.category)) entry.categories[run.category] += 1;
    entry.noteCall += run.noteCall ? 1 : 0;
    entry.archiveRead += run.archiveRead ? 1 : 0;
    entry.rerunCommand += run.rerunCommand ? 1 : 0;
    entry.valueInContextAtAnswer += run.valueInContextAtAnswer ? 1 : 0;
    entry.compacted += run.compacted ? 1 : 0;
    groups.set(key, entry);
  }
  return [...groups.values()].map((entry) => ({
    ...entry,
    rates: {
      noteCall: rate(entry.noteCall, entry.n),
      archiveRead: rate(entry.archiveRead, entry.n),
      rerunCommand: rate(entry.rerunCommand, entry.n),
      valueInContextAtAnswer: rate(entry.valueInContextAtAnswer, entry.n),
      hit: rate(entry.categories.hit, entry.n),
      rerun: rate(entry.categories.rerun, entry.n),
      invented: rate(entry.categories.invented, entry.n),
      noAnswer: rate(entry.categories.noAnswer, entry.n),
    },
  }));
}

function pct(rateValue) {
  return rateValue === null || rateValue === undefined
    ? "—"
    : `${(rateValue * 100).toFixed(1)}%`;
}

function interval(rateEntry) {
  return `${pct(rateEntry.value)} [${pct(rateEntry.wilson95.low)}, ${pct(rateEntry.wilson95.high)}]`;
}

function aggregateRow(entry) {
  return {
    ...entry,
    categories: { ...entry.categories },
    rates: Object.fromEntries(
      Object.entries(entry.rates).map(([key, value]) => [key, { ...value, wilson95: { ...value.wilson95 } }]),
    ),
  };
}

function reportMarkdown(result) {
  const rows = result.aggregate.map((entry) => `| ${entry.variant} | ${entry.model} | ${entry.n} | ${entry.completed} | ${entry.failed} | ${interval(entry.rates.noteCall)} | ${interval(entry.rates.archiveRead)} | ${interval(entry.rates.valueInContextAtAnswer)} | ${interval(entry.rates.hit)} | ${interval(entry.rates.rerun)} | ${interval(entry.rates.invented)} | ${interval(entry.rates.noAnswer)} |`);
  const rawAggregate = JSON.stringify(result.aggregate.map(aggregateRow), null, 2);
  return `# Notes 归因实验：模型为什么不主动查证

运行时间：${result.startedAt}。这是库级 \`runToolLoop\` harness，不调用 CLI 二进制；每个变体、每个模型运行 ${RUNS_PER_MODEL} 次。

## 假设与可证伪判据

- **H1 不知道有这工具**：工具确实在 request.tools 中，但模型从未感知或无法把“需要历史值”与它关联。若 V0 的工具 schema 已发送而 V5 仍不调用 notes，或工具调用率与工具是否存在无关，则支持 H1；若 V5 显著调用则否定“完全不知道”。
- **H2 不觉得自己缺信息（记忆错觉）**：模型以为自己记得而直接作答。可证伪判据是终稿时真值已不在发给模型的 \`messages\` 中（\`value_in_context_at_answer=false\)，但仍输出具体值，并伴随“记得/之前/第一次”等来源声明；若值仍在上下文，不能归因于记忆错觉。
- **H3 触发条件太弱**：抽象的“需要时先查证”不足以产生前置动作。若 V1/V2 相比 V0 的 \`note_call\` 率明显上升，且 V5 也能调用，支持 H3。
- **H4 更便宜的路存在**：重跑命令或读归档比调新工具更符合习惯。若 V0 的 \`archive_read\` 或 \`rerun_command\` 显著高于 \`note_call\)，而禁用归档 V4 后 notes 上升，支持 H4。
- **H5 工具形态不吸引**：英文短描述、JSON 返回和陌生名字降低使用率。若只把描述改为中文并说明 when-to-use/重跑取舍的 V3 相比 V0 上升，支持 H5。
- **H6 能力/习惯问题**：即使被明确要求也做不到。若 V5 或 V6 在工具存在且任务可完成时仍不调用 notes，支持 H6；若 V5/V6 能稳定调用，否定 H6。

判定单位是 run；Wilson 区间为 95%，分母为该行全部 n=5（失败 run 仍保留在原始证据中，不伪装成成功）。

## 变体

| 变体 | 唯一改变 |
|---|---|
| V0 | 当前 CLI system guidance 与原始英文 notes 描述。 |
| V1 | guidance 改成回答具体数值前必须先 \`note_list\` 的命令式前置动作。 |
| V2 | guidance 加入显式记忆模型与一次完整 \`note_list → note_read → 回答\` 示范。 |
| V3 | 只把 notes 工具描述改成中文，并说明何时使用及不要重跑命令。 |
| V4 | 不生成 sidecar 归档、不向 system prompt 提供归档路径；notes 是唯一找回路径。 |
| V5 | 只在任务提示词中直接点名先调用 \`note_list\`，作为 sanity check。 |
| V6 | 只增加 runtime final-guard nudge：首次无 notes 的 end-turn 注入指定 user 消息，最多续跑 2 轮。 |

所有变体固定 \`budgetTokens=${BUDGET_TOKENS}\`、\`keepRounds=${KEEP_ROUNDS}\`、\`maxRounds=${MAX_ROUNDS}\`、同一任务和三段 \`seq\` 大输出。随机值只在 JSON 中保存前 4 位和长度。

## 聚合结果

\`note_call/archive_read/value_in_context_at_answer\` 与四类结果单元格均为“率 [Wilson 95% 区间]”；每个 rate 对应的计数仍保存在 JSON 的 \`count\` 字段。

| 变体 | 模型 | n | 完成 | 失败 | note_call | archive_read | value_in_context | hit | rerun | invented | noAnswer |
|---|---|---:|---:|---:|---|---|---|---:|---:|---:|---:|
| ${rows.join("\n| ")}

## 每个变体原始聚合输出

\`\`\`json
${rawAggregate}
\`\`\`

## 证据解释与归因结论

结果应按“工具是否可见 → 触发是否足够 → 替代路径是否更便宜 → 形态是否影响 → 强制 nudge 是否仍失败”的顺序解释。V5 是最强 sanity check：若 V5 的 notes 调用率接近 100%，工具能力和 schema 通路成立，V0 的 0 率不能归因于 H1/H6，而优先归因 H3/H4/H5；若 V4 在 archive_read 消失后 notes 上升，H4 得到直接支持。V6 若在首次 end-turn 后调用 notes，说明 runtime nudge 可补齐触发缺口；若仍不调用，才有较强证据支持 H6。

本报告的最终排序以本次 JSON 聚合为准：${result.conclusion}

## 可执行修复建议

首选把 V2 的显式记忆模型和“具体数值回答前先 \`note_list\`、再 \`note_read\`”写进 CLI guidance，并采用 V3 的中文、when-to-use 工具描述；这两项成本低、不会改变 loop API，预期收益是提高 notes 触发率并保留模型自主性。对 provenance gate 已经发现未核验具体值的场景，再采用 V6 的一次 runtime nudge（最多 2 轮），作为 fail-closed 的恢复路径；成本是额外模型轮次和 token，不能无限重试。V4 不建议直接产品化：禁用归档会移除另一条可恢复路径，只有在宿主已经提供等价持久笔记且接受单点故障时才适用。

## 局限

- 每个变体/模型 n=5，Wilson 区间很宽，不能据此估计稳定的生产提升。
- 只有 kimi-for-coding 与 k3；deepseek 当前 token 不可用，未纳入。
- 单一随机值、三段 \`seq\` 和一次折叠形态，不能代表所有任务。
- provider 负载、模型采样和服务端策略仍可能影响结果；变体按固定轮转顺序执行，不能替代更大规模随机化实验。
- \`value_in_context_at_answer\` 是 harness 在最终无工具 provider request 上检查真值字面量的操作性指标，不等价于模型内部是否“记得”。
`;
}

function createModelConfig(source, model, filePath) {
  return writeFile(
    filePath,
    `${JSON.stringify({
      slots: {
        default: {
          endpoint: source.endpoint,
          apiKey: source.apiKey,
          model,
          maxOutputTokens: source.maxOutputTokens,
          contextWindowTokens: source.contextWindowTokens,
        },
      },
    }, null, 2)}\n`,
    "utf8",
  ).then(() => chmod(filePath, 0o600));
}

async function runOne({ variant, model, index, configPath, root, timeoutMs }) {
  const runId = `notes-why-${variant.toLowerCase()}-${model}-${String(index).padStart(2, "0")}`;
  const runRoot = path.join(root, runId);
  const transcriptDir = path.join(runRoot, "transcripts");
  const notesDir = path.join(runRoot, "notes");
  const archiveDir = variant === "V4"
    ? undefined
    : path.join(transcriptDir, "outputs", runId);
  await mkdir(runRoot, { recursive: true });
  const config = await loadCliConfig({ configPath });
  const providerBase = createOpenAIProvider({
    ...config,
    timeoutMs: 300_000,
    maxTokens: config.maxOutputTokens,
  });
  const providerRequests = [];
  const secretValues = [];
  const answerContexts = [];
  const toolCalls = [];
  const noteCalls = [];
  let randomCommandCount = 0;
  const provider = {
    async chat(request) {
      const hasValue = JSON.stringify(request.messages).includes(secretValues[0] ?? "\u0000");
      const response = await providerBase.chat(request);
      if (!hasToolUse(response)) {
        answerContexts.push({
          round: answerContexts.length + 1,
          valueInContext: hasValue,
        });
      }
      providerRequests.push({
        valueInContext: hasValue,
        messageCount: request.messages?.length ?? 0,
      });
      return response;
    },
  };

  const cliTools = createCliTools({
    cwd: runRoot,
    ...(archiveDir === undefined ? {} : { archiveDir }),
  });
  const skillTools = await buildSkillTools({
    home: root,
    cwd: runRoot,
    runId,
    notesDir,
    builtinNames: cliTools.tools.map((tool) => tool.name),
  });
  const tools = toolsForVariant(cliTools, skillTools, variant);
  const executeTool = async ({ id, name, input, context }) => {
    const round = context?.round;
    const call = {
      name,
      round,
      ...(name === "readFile" && typeof input?.path === "string" ? { path: input.path } : {}),
      ...(name === "exec" && typeof input?.command === "string" ? { command: input.command } : {}),
    };
    toolCalls.push(call);
    if (name === "note_list" || name === "note_read") {
      noteCalls.push({ name, round });
    }

    const result = cliTools.tools.some((tool) => tool.name === name)
      ? await cliTools.executeTool(name, input, { toolUseId: id, round })
      : await skillTools.executeTool(name, input, context);
    if (name === "exec") {
      const metadata = cliTools.getLastToolMetadata();
      const output = metadata?.fullOutput ?? String(result ?? "");
      const found = extractSecrets(output);
      if (found.length > 0) {
        randomCommandCount += 1;
        for (const value of found) {
          if (!secretValues.includes(value)) secretValues.push(value);
        }
        if (secretValues.length === 1) {
          await skillTools.executeTool("note_take", {
            key: NOTE_KEY,
            content: secretValues[0],
            pinned: true,
            tags: ["experiment"],
          }, context);
        }
      }
    }
    return result;
  };

  const recoveryHint = archiveDir === undefined ? undefined : buildArchiveRecoveryHint(archiveDir);
  const context = {
    ...buildCompactionContext({}, BUDGET_TOKENS, recoveryHint),
    keepRounds: KEEP_ROUNDS,
  };
  const system = systemForVariant({ variant, cwd: runRoot, archiveDir });
  const finalGuard = variant === "V6"
    ? async () => (noteCalls.length > 0
      ? { action: "accept" }
      : {
          action: "revise",
          message: "你尚未查证笔记。请先调用 note_list/note_read 取回原始值再回答；不得重跑命令。",
        })
    : undefined;
  const store = createFileTranscriptStore({ dir: transcriptDir });
  const started = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error(`run timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );
  let result;
  let error;
  try {
    result = await runToolLoop({
      provider,
      system,
      initialUserMessage: promptForVariant(variant),
      task: promptForVariant(variant),
      tools,
      executeTool,
      maxRounds: MAX_ROUNDS,
      maxTokens: config.maxOutputTokens,
      context,
      store,
      runId,
      reflection: false,
      completion: { signals: [], maxNoToolRounds: 1 },
      signal: controller.signal,
      ...(finalGuard === undefined ? {} : {
        finalGuard,
        finalGuardMaxRetries: 2,
      }),
    });
  } catch (caught) {
    error = caught;
  } finally {
    clearTimeout(timeoutId);
  }
  const durationMs = Date.now() - started;
  const finalText = result?.finalText ?? "";
  const answer = extractAnswer(finalText, secretValues);
  const category = answer === null
    ? "noAnswer"
    : answer === secretValues[0]
      ? "hit"
      : secretValues.slice(1).includes(answer)
        ? "rerun"
        : "invented";
  const lastAnswerContext = answerContexts.at(-1);
  const archiveRead = toolCalls.some((call) => (
    (call.name === "readFile" && isArchivePath(call.path, archiveDir))
    || (call.name === "exec" && isArchivePath(call.command, archiveDir))
  ));
  const compacted = (result?.compactionStats ?? []).some((entry) => entry.compacted);
  const failed = Boolean(error) || result?.verification?.status === "unverified";
  const roundForAnswer = lastAnswerContext?.round;
  const run = {
    id: `${variant}-${model}-${String(index).padStart(2, "0")}`,
    variant,
    model,
    index,
    runId,
    durationMs,
    failed,
    error: error ? redacted(error.message, secretValues) : null,
    termination: result?.termination?.reason ?? "failed",
    verification: result?.verification?.status ?? "error",
    category,
    answer: answer ? secretPreview(answer) : null,
    originalValue: secretValues[0] ? secretPreview(secretValues[0]) : null,
    generatedValues: secretValues.map(secretPreview),
    noteCall: noteCalls.length > 0,
    noteCalls: noteCalls.map((call) => ({
      ...call,
      subsequentHit: category === "hit" && (
        roundForAnswer === undefined || call.round <= roundForAnswer
      ),
    })),
    archiveRead,
    rerunCommand: randomCommandCount > 1,
    valueInContextAtAnswer: lastAnswerContext?.valueInContext ?? false,
    answerRound: roundForAnswer ?? null,
    answerContextEvidence: lastAnswerContext
      ? { valueInContext: lastAnswerContext.valueInContext }
      : null,
    defenseText: defenseExcerpt(finalText, answer, secretValues),
    defenseMarkers: sourceMarkers(finalText),
    finalText: redacted(finalText, secretValues),
    toolCalls: toolCalls.map((call) => ({
      ...call,
      ...(call.command ? { command: redacted(call.command, secretValues) } : {}),
    })),
    compacted,
    rounds: result?.rounds ?? 0,
    providerRequests: providerRequests.map((request) => ({ ...request })),
  };
  return run;
}

function conclusionFor(aggregates, runs) {
  const byVariant = new Map();
  for (const row of aggregates) {
    const current = byVariant.get(row.variant) ?? [];
    current.push(row);
    byVariant.set(row.variant, current);
  }
  const summaries = [];
  const pooled = new Map();
  for (const variant of VARIANTS) {
    const rows = byVariant.get(variant) ?? [];
    if (rows.length === 0) continue;
    const notes = rows.reduce((sum, row) => sum + row.noteCall, 0);
    const total = rows.reduce((sum, row) => sum + row.n, 0);
    const pool = {
      n: total,
      noteCall: notes,
      archiveRead: rows.reduce((sum, row) => sum + row.archiveRead, 0),
      rerunCommand: rows.reduce((sum, row) => sum + row.rerunCommand, 0),
      valueInContext: rows.reduce((sum, row) => sum + row.valueInContextAtAnswer, 0),
      hit: rows.reduce((sum, row) => sum + row.categories.hit, 0),
      rerun: rows.reduce((sum, row) => sum + row.categories.rerun, 0),
      invented: rows.reduce((sum, row) => sum + row.categories.invented, 0),
      noAnswer: rows.reduce((sum, row) => sum + row.categories.noAnswer, 0),
    };
    pooled.set(variant, pool);
    summaries.push(`${variant}: note_call=${notes}/${total}, archive_read=${pool.archiveRead}/${total}, value_in_context=${pool.valueInContext}/${total}, rerun_command=${pool.rerunCommand}/${total}, hit/rerun/invented/noAnswer=${pool.hit}/${pool.rerun}/${pool.invented}/${pool.noAnswer}`);
  }
  const v0 = pooled.get("V0");
  const statements = [];
  if (v0) {
    const v5 = pooled.get("V5");
    const v6 = pooled.get("V6");
    const v4 = pooled.get("V4");
    const v3 = pooled.get("V3");
    const v1 = pooled.get("V1");
    const v2 = pooled.get("V2");
    if (v5 && v5.noteCall > v0.noteCall) {
      statements.push("V5 比 V0 的 notes 调用率上升，否定 H1 的“工具完全不可见/不可用”，并支持 H3 的触发条件不足。");
    } else if (v5) {
      statements.push("V5 未比 V0 增加 notes 调用，H1/H6 仍不能排除。");
    }
    if (v4 && v4.noteCall > v0.noteCall && v4.archiveRead < v0.archiveRead) {
      statements.push("V4 在归档被禁用后 notes 上升且 archive_read 下降，支持 H4 的替代路径竞争。");
    } else if (v4) {
      statements.push("V4 未显示禁用归档会提高 notes 调用，H4 未获直接支持。");
    }
    if (v3 && v3.noteCall > v0.noteCall) {
      statements.push("V3 的中文/when-to-use 描述提高 notes 调用，支持 H5。");
    } else if (v3) {
      statements.push("V3 未超过 V0，H5 未获直接支持。");
    }
    if ((v1 && v1.noteCall > v0.noteCall) || (v2 && v2.noteCall > v0.noteCall)) {
      statements.push("V1/V2 的可执行前置动作或记忆模型提高调用率，支持 H3。");
    } else {
      statements.push("V1/V2 未超过 V0，H3 在本样本中未获支持。");
    }
    if (v6 && v6.noteCall > v0.noteCall) {
      statements.push("V6 的 runtime nudge 能把首次无 notes 的 end-turn 拉回查证，H6 被否定；若提升有限则仅部分成立。");
    } else if (v6) {
      statements.push("V6 的 runtime nudge 仍未带来 notes 调用，支持 H6。");
    }
  }
  const memoryCases = runs.filter((run) => (
    run.category !== "noAnswer"
      && run.valueInContextAtAnswer === false
      && run.defenseMarkers.some((marker) => ["记得", "之前", "第一次", "凭记忆"].includes(marker))
  )).length;
  statements.push(`H2 操作性证据：${memoryCases}/${runs.length} 个 run 在具体作答时真值不在 messages 且出现记忆来源声明。`);
  return `${summaries.join("; ")}。归因：${statements.join(" ")}`;
}

function parseArgs(args) {
  const options = { runs: RUNS_PER_MODEL, timeout: 300_000, variants: VARIANTS };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--runs" || arg === "--timeout-ms") {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${arg} must be a positive integer`);
      if (arg === "--runs") options.runs = value;
      else options.timeout = value;
      continue;
    }
    if (arg === "--variants") {
      const values = String(args[++index] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      if (values.length === 0 || values.some((value) => !VARIANTS.includes(value))) {
        throw new Error(`--variants must be a comma-separated subset of ${VARIANTS.join(",")}`);
      }
      options.variants = values;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("用法：node scripts/notes-why-experiment.mjs [--runs 5] [--timeout-ms 300000] [--variants V0,V1]");
      return null;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) return;
  const startedAt = new Date().toISOString();
  const root = await mkdtemp(path.join(REPO_ROOT, ".notes-why-"));
  const runs = [];
  try {
    const source = await loadCliConfig();
    const configPaths = new Map();
    for (const model of MODELS) {
      const configPath = path.join(root, `${model}.config.json`);
      await createModelConfig(source, model, configPath);
      configPaths.set(model, configPath);
    }
    for (const variant of options.variants) {
      for (const model of MODELS) {
        for (let index = 1; index <= options.runs; index += 1) {
          const run = await runOne({
            variant,
            model,
            index,
            configPath: configPaths.get(model),
            root,
            timeoutMs: options.timeout,
          });
          runs.push(run);
          console.log(`${variant}/${model} #${index}: category=${run.category} note=${run.noteCall ? 1 : 0} archive=${run.archiveRead ? 1 : 0} context=${run.valueInContextAtAnswer ? 1 : 0} rerun=${run.rerunCommand ? 1 : 0} duration=${(run.durationMs / 1000).toFixed(1)}s`);
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const result = {
    protocol: {
      seed: SEED,
      models: MODELS,
      variants: options.variants,
      runsPerModel: options.runs,
      budgetTokens: BUDGET_TOKENS,
      keepRounds: KEEP_ROUNDS,
      maxRounds: MAX_ROUNDS,
      prompt: "one-time random value + seq 1..400/401..800/801..1200 + original value query",
      config: "temporary per-model config copied from the resolved local provider config; no user config writes",
    },
    startedAt,
    completedAt: new Date().toISOString(),
    runs,
    aggregate: aggregate(runs),
  };
  result.conclusion = conclusionFor(result.aggregate, runs);
  await writeFile(RESULTS_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${reportMarkdown(result)}\n`, "utf8");
  console.log("RAW_AGGREGATE_BEGIN");
  console.log(JSON.stringify(result.aggregate.map(aggregateRow), null, 2));
  console.log("RAW_AGGREGATE_END");
  console.log(result.conclusion);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
