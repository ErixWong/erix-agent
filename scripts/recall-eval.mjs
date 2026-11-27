#!/usr/bin/env node
// scripts/recall-eval.mjs — issue #896 §5：recall 真机评测（折叠后模型靠 recall_ask/recall_read 找事实）。
// 定位：**测量脚本**（不入 test/，要联网）。除本文件外不改 src/。
// 用法：
//   node scripts/recall-eval.mjs [--scenarios 1,2,...] [--groups A,B] [--slot default]
//        [--out /tmp/recall-eval-results.json] [--fake] [--max-rounds 12]
// 场景 = 预写 8 轮账本（前几轮埋一个具体事实）→ 最终轮问一个只有该事实能答的问题。
//   A 组：不折叠（预算巨大），无 recall 工具 ⇒ 基线。
//   B 组：折叠（小预算 + fold-llm）+ recall_read/recall_ask + capabilities.ports.recallProvider。
// 模型/端点/密钥一律读 config 槽位（源码零模型名）；读不到就失败。
// token 口径：主循环/折叠摘要/回忆三类 provider 调用在**包装层**逐发计量（↑/↓/耗时/事实是否仍在请求里）。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  createOpenAIProvider,
  createMemoryTranscriptStore,
  createBuiltinRecallTools,
  createRecallAskTool,
  runToolLoop,
} from "../src/index.js";

// ───────────────────────────────────────────────────────────────── config

function readSlot(slotName) {
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const candidates = [
    process.env.ERIX_CONFIG,
    path.join(xdg, "erix", "config.json"),
    path.join(home, ".erix", "config.json"),
  ].filter(Boolean);
  const configPath = candidates.find((p) => existsSync(p));
  if (configPath === undefined) {
    throw new Error(`未找到模型配置文件（候选：${candidates.join(", ")}）`);
  }
  const slot = JSON.parse(readFileSync(configPath, "utf8"))?.slots?.[slotName];
  if (!slot || !slot.endpoint || !slot.model || !slot.apiKey) {
    throw new Error(`配置 ${configPath} 里 slots.${slotName} 缺 endpoint/model/apiKey`);
  }
  return { configPath, slot };
}

// ───────────────────────────────────────────────────────────────── provider（带计量）

// 三类调用的识别（字符串出处）：
//   recall ⇒ recall-runner 的 system（"你是回忆检索器…"）
//   fold   ⇒ provider-summarizer 的 DEFAULT_SUMMARY_SYSTEM（"你是对话历史压缩器…"）
//   main   ⇒ 其余（主循环轮）
function classifyRequest(request) {
  const sys = typeof request?.system === "string" ? request.system : "";
  if (sys.includes("回忆检索器")) return "recall";
  if (sys.includes("对话历史压缩器")) return "fold";
  return "main";
}

function makeMeteredProvider(slot, fake) {
  const log = [];
  let factForLeakCheck = null; // 每次 run 前设置；用于「请求里是否还看得到事实」
  const record = (entry) => { log.push(entry); };
  const probe = (request) => JSON.stringify(request ?? null);
  if (fake) {
    // 假上游：只验证脚本管线（不算真机数据，报告里必须标注 --fake）。
    const scripted = { n: 0 };
    return {
      log,
      setFact: (f) => { factForLeakCheck = f; },
      provider: {
        async chat(request) {
          const kind = classifyRequest(request);
          const t0 = Date.now();
          if (kind === "recall") {
            record({ kind, ms: 0, input: 1, output: 1, factInRequest: probe(request).includes(factForLeakCheck ?? "") });
            return { content: [{ type: "text", text: JSON.stringify({ answer: "FAKE", pointers: [], uncertain: false }) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
          }
          if (kind === "fold") {
            record({ kind, ms: 0, input: 1, output: 1, factInRequest: probe(request).includes(factForLeakCheck ?? "") });
            return { content: [{ type: "text", text: "（假摘要）" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
          }
          scripted.n += 1;
          const hasToolResults = probe(request).includes("tool_result");
          record({ kind, ms: 0, input: 1, output: 1, factInRequest: probe(request).includes(factForLeakCheck ?? "") });
          if (scripted.n === 1 && !hasToolResults) {
            return { content: [{ type: "tool_use", id: `t${scripted.n}`, name: "recall_ask", input: { question: "之前的关键事实是什么", fromRound: 1, toRound: 8 } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } };
          }
          return { content: [{ type: "text", text: `假答案 ${factForLeakCheck ?? ""}` }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    };
  }
  const base = createOpenAIProvider({
    endpoint: slot.endpoint,
    apiKey: slot.apiKey,
    model: slot.model,
    ...(slot.maxOutputTokens === undefined ? {} : { maxOutputTokens: slot.maxOutputTokens }),
    ...(slot.contextWindowTokens === undefined ? {} : { contextWindowTokens: slot.contextWindowTokens }),
    ...(slot.reasoning_effort === undefined ? {} : { reasoning_effort: slot.reasoning_effort }),
    requestTimeoutMs: 120_000,
  });
  return {
    log,
    setFact: (f) => { factForLeakCheck = f; },
    provider: {
      ...base,
      async chat(request) {
        const kind = classifyRequest(request);
        const t0 = Date.now();
        const factInRequest = factForLeakCheck === null ? null : probe(request).includes(factForLeakCheck);
        const response = await base.chat(request);
        record({
          kind,
          ms: Date.now() - t0,
          input: response?.usage?.input_tokens ?? null,
          output: response?.usage?.output_tokens ?? null,
          factInRequest,
          stop: response?.stop_reason ?? null,
        });
        return response;
      },
    },
  };
}

// ───────────────────────────────────────────────────────────────── 场景

function pad(n, topic) {
  // 每轮约 100–150 token 的填充，保证 8 轮总量足以越过 B 组折叠预算。
  return `[第${n}轮·${topic}] 我们在梳理迁移背景。先盘依赖面：网关层、存储层、调度层三条线各自有负责人，`
    + `接口冻结在下周一，冻结前的变更要走评审；预算方面本季度还剩两次外部扩容，超了要写复盘。`
    + `监控上 p50 与 p95 分开看，告警阈值按环境分别配；文档要求跟代码同 PR 提交，缺文档的合并会被打回。`
    + `这一轮先对齐这些背景，具体数字后面按轮登记，别凭记忆答。`;
}

const scenarios = [
  {
    id: 1, name: "单点字符串（令牌）", fact: "tok-7f3a",
    rounds: [
      ["启动清单核对：服务名、端口、日志采集，都过了。", "收到，登记进启动清单。"],
      ["部署令牌定下来了：tok-7f3a。后面部署要用的就是这个，别记混。", "好，部署令牌 tok-7f3a 已登记，后续以这条为准。"],
      ["灰度比例第一轮 5%，观察两小时无异常再放。", "明白，5% 起步，两小时后看指标。"],
      ["回滚预案：保留上一版镜像 72 小时。", "已写入回滚预案。"],
      ["日志采样率先调到 20% 控制成本。", "采样率 20% 已配置。"],
      ["压测窗口定在周四凌晨。", "已预约周四凌晨压测窗口。"],
      ["文档站今晚发布，别动 main。", "收到，main 挂起合并。"],
      ["本周例会顺延到周五下午。", "已改到周五下午。"],
    ],
    question: "当时定下的部署令牌是什么？请逐字给出令牌本身。",
  },
  {
    id: 2, name: "数字（p95）", fact: "412ms",
    rounds: [
      ["压测环境先对齐：三台 4C8G，数据量 1200 万行。", "环境参数已登记。"],
      ["第 1 次实验跑完，p95 是 318ms，作为基准。", "第 1 次基准 p95=318ms 已记录。"],
      ["第 3 次实验结果出来了：p95 是 412ms，比基准差，先别改代码，查索引。", "第 3 次实验 p95=412ms 已记录，先查索引再动代码。"],
      ["索引确实缺了，加复合索引的 PR 我开好了。", "去看 PR，今天合。"],
      ["加完索引复测排到明天上午。", "复测排明天上午。"],
      ["看板加了 p95 分位数面板。", "面板已上线。"],
      ["值班表下周轮换。", "值班表已更新。"],
      ["季度总结模板发群里了。", "模板收到。"],
    ],
    question: "第 3 次实验的 p95 是多少？请逐字给出那个数值（含单位）。",
  },
  {
    id: 3, name: "文件路径", fact: "src/loop/budget.js",
    rounds: [
      ["预算这块的口径要先定：按请求视图估算，不按账本。", "口径记下：以请求视图为准。"],
      ["定位了，要改的文件是 src/loop/budget.js，别的都先不动。", "明确了：只改 src/loop/budget.js。"],
      ["改之前先补单测，覆盖预算计算的两条分支。", "先补测试再动手。"],
      ["回归跑全量，别只跑单包。", "全量回归，收到。"],
      ["CHANGELOG 里要带一句动机。", "CHANGELOG 会写动机。"],
      ["评审人找主 agent。", "已挂主 agent 评审。"],
      ["合完打 tag 通知下游。", "打 tag 通知下游。"],
      ["这周冻结发布窗口。", "冻结窗口已知悉。"],
    ],
    question: "当时定位下来要改的是哪个文件？请逐字给出路径。",
  },
  {
    id: 4, name: "两跳（A 指向 B）", fact: "/etc/erix/keys.yaml",
    rounds: [
      ["密钥策略定了：不进代码库，放在一个 YAML 文件里。具体路径我登记在后面某轮，这里先不写。", "好，密钥走 YAML 文件，路径以登记那条为准。"],
      ["部署脚本改从环境变量注入路径。", "脚本已改环境变量注入。"],
      ["审计要求文件权限 600。", "权限按 600 收。"],
      ["备份策略：密钥文件每日快照。", "每日快照已配。"],
      ["配置清单更新：密钥文件路径登记为 /etc/erix/keys.yaml，与第 2 轮策略对应。", "已登记：/etc/erix/keys.yaml，与密钥策略对应。"],
      ["轮换演练安排在月底。", "月底演练已排。"],
      ["监控探针加一条文件存在性检查。", "探针规则已加。"],
      ["这季度合规扫描下月初开始。", "扫描时间已同步。"],
    ],
    question: "密钥所在的 YAML 文件的完整路径是什么？请逐字给出路径。",
  },
  {
    id: 5, name: "否定事实", fact: "重复打包",
    rounds: [
      ["依赖治理开始：先列候选库清单。", "清单已建。"],
      ["决定：不要用 lodash，原因是它整包进 bundle，造成重复打包、体积膨胀。替代用原生方法。", "记住了：禁用 lodash，原因是重复打包导致体积膨胀。"],
      ["已有的三个引用点在 PR-12 里清掉。", "PR-12 清理引用点。"],
      ["bundle 体积红线 450KB。", "红线 450KB 已挂 CI。"],
      ["rollup 分析器接进构建。", "分析器已接入。"],
      ["tree-shaking 效果周四复测。", "周四复测 tree-shaking。"],
      ["前端周会加一条体积议题。", "议程已加。"],
      ["下个迭代排依赖升级。", "已排入下个迭代。"],
    ],
    question: "之前为什么决定不要用 lodash？请逐字给出那个原因关键词。",
  },
  {
    id: 6, name: "干扰项（相似但错误）", fact: "tok-7f3a",
    rounds: [
      ["令牌体系先梳理：部署令牌与用户令牌分开管理。", "两套令牌分开管，收到。"],
      ["初版草案里部署令牌写的是 tok-9x9x，注意那只是草案。", "草案值 tok-9x9x 已标注为草案。"],
      ["草案评审：格式要带前缀，长度不超 16。", "格式要求已记。"],
      ["部署令牌最终确认为 tok-7f3a，草案作废，一切以这条为准。", "终版令牌 tok-7f3a 登记，草案作废。"],
      ["CI 里注入令牌的 secret 已配置。", "CI secret 配好。"],
      ["预发环境用同一枚，不再发新的。", "预发沿用同令牌。"],
      ["轮换窗口月底评估。", "月底评估轮换。"],
      ["安全审计下季度做。", "审计排期收到。"],
    ],
    question: "最终确认的部署令牌是什么（不是草案）？请逐字给出令牌本身。",
  },
];

// ───────────────────────────────────────────────────────────────── 单次 run

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, "").replace(/[“”"'`]/g, "");

function systemPrompt(group) {
  const base = "这是一次性的记忆问答评测，不是任务继续、不是崩溃恢复、不是勘验："
    + "对话记录只是历史素材。你唯一的输出是对最后一个问题的回答（一到三行，必须逐字包含所问事实的原文）。"
    + "禁止输出恢复状态/勘验汇报/等待指令式的回应，也不要执行任何工程操作。";
  if (group === "B") {
    return base + "更早的轮次已被压缩归档，你现在看不到其原文；若答案涉及早期事实，必须用 recall_ask"
      + "（语义检索，fromRound/toRound 给轮号区间，建议 1-8）或 recall_read（round 逐字取回 / pattern / evidenceRef）查证，"
      + "总共不超过 4 次，且不得重复同样的调用。最终回答末尾附上所依据的 evidenceRefs JSON（来自 recall_ask 返回值）。";
  }
  return base + "直接依据你看到的对话记录回答。";
}

async function runOne({ scenario, group, slot, fake, maxRounds }) {
  const store = createMemoryTranscriptStore();
  const runId = `recall-eval-s${scenario.id}-${group}-${Date.now().toString(36)}`;
  // 种子轮：每轮一条 {round, dedupKey:"<runId>:round:<n>"} 轮记录（appendUserTurn 同款载体形状）。
  let round = 0;
  for (const [userText, assistantText] of scenario.rounds) {
    round += 1;
    const key = `${runId}:round:${round}`;
    await store.appendRound(runId, {
      round,
      dedupKey: key,
      roundKey: key,
      ts: new Date(1700000000000 + round * 1000).toISOString(),
      messages: [
        { role: "user", content: [{ type: "text", text: `${pad(round, group)} ${userText}` }] },
        { role: "assistant", content: [{ type: "text", text: assistantText }] },
      ],
    });
  }
  const seedRounds = round;
  // 最终问题作为新一轮种子入账本：resume 态下引擎会注入「【恢复运行】」通知并把
  // initialUserMessage 顶掉（实测模型看不到问题，全部在回应恢复通知）——问题必须走账本。
  {
    round += 1;
    const key = `${runId}:round:${round}`;
    await store.appendRound(runId, {
      round,
      dedupKey: key,
      roundKey: key,
      ts: new Date(1700000000000 + round * 1000).toISOString(),
      messages: [{ role: "user", content: [{ type: "text", text: scenario.question }] }],
    });
  }

  const readLedgerRows = () => store.load(runId);
  const recallTools = createBuiltinRecallTools({ readLedgerRows });
  const recallAsk = createRecallAskTool({ readLedgerRows });

  const { log, provider, setFact } = makeMeteredProvider(slot, fake);
  setFact(scenario.fact);

  const toolCalls = [];
  const executeTool = async (request) => {
    const name = request?.name;
    if (name === "recall_read") {
      const out = await recallTools.executeTool(request);
      toolCalls.push({ name, input: request.input, result: out });
      return out;
    }
    if (name === "recall_ask") {
      const out = await recallAsk.executeTool(request);
      toolCalls.push({ name, input: request.input, result: out });
      return out;
    }
    return JSON.stringify({ status: "no_such_tool" });
  };

  const folding = group === "A"
    ? {
      context: { budgetTokens: 8_000_000, keepRounds: 64, task: `recall-eval A${scenario.id}` },
      toolResultTtl: 8,
    }
    : {
      context: {
        // 预算/保留轮取宽：1200/1 会让 recall 结果一进来就二次折叠，把**问题轮**也折掉
        // （实测模型反复说「问题不可见」直到撞 max_rounds）；keepRounds=2 保住问题轮与最近一轮。
        budgetTokens: 2500,
        keepRounds: 2,
        task: `recall-eval B${scenario.id}`,
        // issue #261127-12 起策略名字形态已删：不写策略 = 引擎内置 fold-llm（同一行为）。
        maxSummaryTokens: 200,
      },
      // 评测关键：缺省 TTL 会把工具结果在下一请求就折掉，模型永远看不到自己刚拿到的 recall 结果
      // （实测反复说「结果不可见」直到撞轮次上限）；抬到 8 保证整段问答内结果在位。
      toolResultTtl: 8,
    };

  const started = Date.now();
  let runResult;
  let runError = null;
  try {
    runResult = await runToolLoop({
      provider,
      store,
      tools: group === "B" ? [...recallTools.definitions, ...recallAsk.definitions] : [],
      executeTool,
      ...(group === "B" ? { capabilities: { ports: { recallProvider: provider } } } : {}),
      config: {
        tuning: { maxTokens: 2048 },
        metadata: { toolContext: { recallTimeoutMs: 45_000 } },
        run: { runId, maxRounds, resume: true, persistence: "required", stallDetection: false },
        input: { system: systemPrompt(group) },
        folding,
      },
    });
  } catch (error) {
    runError = { message: String(error?.message ?? error), code: error?.code ?? null };
  }
  const wallMs = Date.now() - started;

  // ── 计量 ──
  const byKind = {};
  for (const entry of log) {
    const k = byKind[entry.kind] ??= { calls: 0, input: 0, output: 0, ms: 0 };
    k.calls += 1;
    k.input += entry.input ?? 0;
    k.output += entry.output ?? 0;
    k.ms += entry.ms ?? 0;
  }
  const mainCalls = log.filter((e) => e.kind === "main");
  const recallCalls = toolCalls.filter((c) => c.name === "recall_ask" || c.name === "recall_read").length;
  const finalText = runResult?.finalText ?? "";
  const correct = norm(finalText).includes(norm(scenario.fact));

  // 证据可验证率：把每次 recall_ask 返回的 evidenceRefs 全部拿去 recall_read({evidenceRef})。
  const refs = [];
  for (const call of toolCalls) {
    if (call.name !== "recall_ask") continue;
    try {
      const parsed = JSON.parse(call.result);
      if (parsed.status === "found" && Array.isArray(parsed.evidenceRefs)) refs.push(...parsed.evidenceRefs);
    } catch { /* 非 JSON 结果不计 */ }
  }
  const refChecks = [];
  for (const ref of refs) {
    const parsed = JSON.parse(await recallTools.executeTool({ name: "recall_read", input: { evidenceRef: ref } }));
    refChecks.push(parsed.status);
  }
  const refFound = refChecks.filter((s) => s === "found").length;

  // 影子当事实：终稿逐字含正确事实，但本 run 没有任何 found 证据支撑（A 组无证据通道，单独标注）。
  const shadowAsFact = correct && refFound === 0;

  // 折叠是否真的把事实折掉了：看折叠后（fold 调用之后）主循环请求里事实还在不在。
  const foldIdx = log.findIndex((e) => e.kind === "fold");
  const mainAfterFold = foldIdx === -1 ? [] : mainCalls.filter((e) => log.indexOf(e) > foldIdx);
  const factAfterFold = mainAfterFold.length === 0 ? null : mainAfterFold.every((e) => e.factInRequest === false);

  return {
    scenario: scenario.id,
    name: scenario.name,
    group,
    runId,
    seedRounds,
    rounds: runResult?.rounds ?? null,
    termination: runResult?.termination?.reason ?? (runError ? `error:${runError.code ?? "unknown"}` : null),
    runError,
    finalText,
    correct,
    recallToolCalls: recallCalls,
    converged: group === "B" ? (correct && recallCalls <= 4 && recallCalls >= 1) : correct,
    evidenceRefsReturned: refs.length,
    evidenceRefFound: refFound,
    shadowAsFact,
    folded: foldIdx !== -1,
    factStillInContextAfterFold: factAfterFold === null ? null : !factAfterFold,
    toolCalls: toolCalls.map((c) => ({ name: c.name, input: c.input, result: String(c.result).slice(0, 800) })),
    providerLog: log,
    usageByKind: byKind,
    runUsage: runResult?.usage ?? null,
    wallMs,
  };
}

// ───────────────────────────────────────────────────────────────── main

const { values: cli } = parseArgs({
  options: {
    scenarios: { type: "string", default: "1" },
    groups: { type: "string", default: "A,B" },
    slot: { type: "string", default: "default" },
    out: { type: "string", default: "/tmp/recall-eval-results.json" },
    fake: { type: "boolean", default: false },
    "max-rounds": { type: "string", default: "12" },
  },
});

const maxRounds = Number(cli["max-rounds"]);
if (!Number.isSafeInteger(maxRounds) || maxRounds <= 0) throw new Error("--max-rounds 必须是正整数");
const wantScenarios = cli.scenarios.split(",").map((s) => Number(s.trim())).filter(Number.isSafeInteger);
const wantGroups = cli.groups.split(",").map((s) => s.trim().toUpperCase()).filter((g) => g === "A" || g === "B");

const slotInfo = cli.fake ? { configPath: "(fake)", slot: { model: "fake-provider", endpoint: "-", apiKey: "***" } } : readSlot(cli.slot);
console.log(`#896 §5 recall-eval · slot=${cli.slot} model=${slotInfo.slot.model} endpoint=${slotInfo.slot.endpoint} config=${slotInfo.configPath}`);
console.log(`scenarios=[${wantScenarios}] groups=[${wantGroups}] maxRounds=${maxRounds} fake=${cli.fake}`);

const results = [];
for (const s of wantScenarios) {
  const scenario = scenarios.find((x) => x.id === s);
  if (scenario === undefined) { console.error(`未知场景 ${s}`); continue; }
  for (const g of wantGroups) {
    process.stdout.write(`▶ 场景 ${s}（${scenario.name}）组 ${g} … `);
    const r = await runOne({ scenario, group: g, slot: slotInfo.slot, fake: cli.fake, maxRounds });
    results.push(r);
    console.log(
      `rounds=${r.rounds} termination=${r.termination} correct=${r.correct} recallCalls=${r.recallToolCalls} `
      + `refs=${r.evidenceRefFound}/${r.evidenceRefsReturned} shadow=${r.shadowAsFact} folded=${r.folded} `
      + `factLeakAfterFold=${r.factStillInContextAfterFold} ↑${r.usageByKind.main?.input ?? 0}+fold${r.usageByKind.fold?.input ?? 0}+rec${r.usageByKind.recall?.input ?? 0} `
      + `↓${(r.usageByKind.main?.output ?? 0) + (r.usageByKind.fold?.output ?? 0) + (r.usageByKind.recall?.output ?? 0)} ${r.wallMs}ms`,
    );
    if (r.runError) console.log(`   ⚠ runError: ${JSON.stringify(r.runError)}`);
    console.log(`   finalText: ${String(r.finalText).slice(0, 300)}`);
  }
}

const totals = { model: slotInfo.slot.model, input: 0, output: 0, wallMs: 0 };
for (const r of results) {
  for (const k of Object.values(r.usageByKind)) { totals.input += k.input; totals.output += k.output; }
  totals.wallMs += r.wallMs;
}
console.log(`\n总量：model=${totals.model} ↑${totals.input} ↓${totals.output} 墙钟=${totals.wallMs}ms fake=${cli.fake}`);
writeFileSync(cli.out, JSON.stringify({ slot: slotInfo.slot.model, fake: cli.fake, totals, results }, null, 2));
console.log(`结果 JSON：${cli.out}`);
