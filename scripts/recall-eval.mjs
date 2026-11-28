#!/usr/bin/env node
// scripts/recall-eval.mjs — issue #896 §5：recall 真机评测（折叠后模型靠 recall_ask/recall_read 找事实）。
// 定位：**测量脚本**（不入 test/，要联网）。除本文件外不改 src/。
// 用法：
//   node scripts/recall-eval.mjs [--scenarios 1,2,...] [--groups A,B] [--slot default]
//        [--out /tmp/recall-eval-results.json] [--fake] [--max-rounds 12]
// 场景 = 预写 20 轮账本（事实**埋在第 2 轮那份模块清单的某一条注释里**）→ 最终轮问一个只有该事实能答
// 的问题。体量（261128 修）：每轮 ~1.9k token 的可判读清单，20 轮 ≈ 38k —— 超过 B 组 16k 预算，
// 折叠由**内容量**自然触发，不再靠把预算压到 2.5k（2.5k 放不下任何真实工作）。
//
// 题目必须**点名第 2 轮**（261128 修）：不点名时 A 组要在 20 轮 × 40 行 ≈ 800 行里找一根针，
// 它答错是「找不到」而不是「记不住」，于是 B 组答错时无法归因。点名之后 A 只要看第 2 轮
// （必答对），B 的第 2 轮被折掉了（必须回账本捞）—— 变量被隔离出来。
//
// 两组基线（261128 修）：A = **模型自己的窗口**（`contextWindowTokens`，本机 262144），不再写
// 8_000_000（没有任何模型能吃 8M，那是不存在的基线）；B = 16k（窗口的 1/16）+ keepRounds 6（引擎默认）。
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
/**
 * 把**召回工具**的结果正文从请求里剔掉（其余原样保留）。
 *
 * 为什么需要它（261128）：「折叠后事实还在吗」这一格旧口径看整份请求，而 `recall_read` / `recall_ask`
 * 的返回值里就带着那段原文——召回成功反而被判成「泄漏」。剔掉它们，「事实是否还需要召回才能看见」
 * 才是可测的。
 *
 * 识别方式（261128 第二版）：按 `tool_use` 的 **id → 工具名** 认。第一版按结果正文的形态猜
 * （找 `"status"` / `"answer"` / `"text"`），而 `recall_read` 的 pattern 模式返回
 * `{status, pattern, matches[]}`、round 模式返回 `{status, text}` —— 形状各异，按正文猜必漏判
 * （实测两条召回结果只剔掉一条，事实仍可见 ⇒ 这一格假红）。
 * 为什么按 id 可靠：请求视图校验要求每个 `tool_result` 与相邻的 `tool_use` 配对，TTL 折叠保留配对
 * ⇒「结果还在、调用块已被折掉」不可达（copilot 复审确认）。
 */
function withoutRecallToolResults(request) {
  const messages = request?.messages;
  if (!Array.isArray(messages)) return request;
  // 按 **tool_use 的 id → 工具名** 认，不按结果正文的形态认。
  // 上一版按正文找 `"status"`/`"answer"`/`"text"`：`recall_read` 的 pattern 模式返回
  // `{status, pattern, matches:[{round,text}]}`、`round` 模式返回 `{status, text}`——形态各异，
  // 按正文猜必然漏判（实测两条召回结果只剔掉一条，事实仍可见 ⇒ 这一格假红）。
  const recallIds = new Set();
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "tool_use") continue;
      if (block.name === "recall_read" || block.name === "recall_ask") recallIds.add(block.id);
    }
  }
  if (recallIds.size === 0) return request;
  const strip = (content) => (Array.isArray(content)
    ? content.filter((b) => !(b?.type === "tool_result" && recallIds.has(b.tool_use_id)))
    : content);
  return { ...request, messages: messages.map((m) => ({ ...m, content: strip(m.content) })) };
}

function classifyRequest(request) {
  const sys = typeof request?.system === "string" ? request.system : "";
  if (sys.includes("回忆检索器")) return "recall";
  if (sys.includes("对话历史压缩器")) return "fold";
  return "main";
}

function makeMeteredProvider(slot, fake, { hasRecallTools = true } = {}) {
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
            record({ kind, ms: 0, input: 1, output: 1, factInRequest: probe(request).includes(factForLeakCheck ?? ""), factVisibleWithoutRecall: probe(withoutRecallToolResults(request)).includes(factForLeakCheck ?? "") });
            return { content: [{ type: "text", text: JSON.stringify({ answer: "FAKE", pointers: [], uncertain: false }) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
          }
          if (kind === "fold") {
            record({ kind, ms: 0, input: 1, output: 1, factInRequest: probe(request).includes(factForLeakCheck ?? ""), factVisibleWithoutRecall: probe(withoutRecallToolResults(request)).includes(factForLeakCheck ?? "") });
            return { content: [{ type: "text", text: "（假摘要）" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
          }
          scripted.n += 1;
          const hasToolResults = probe(request).includes("tool_result");
          record({ kind, ms: 0, input: 1, output: 1, factInRequest: probe(request).includes(factForLeakCheck ?? ""), factVisibleWithoutRecall: probe(withoutRecallToolResults(request)).includes(factForLeakCheck ?? "") });
          // copilot 复审（PR #985）：A 组没有召回工具，假上游却照样发 `recall_ask` ⇒ 冒烟跑的是
          // 一条不存在的路径。现在按 `hasRecallTools` 决定（只有 B 组为真）。
          // 判据改成「**还没出现过 tool_result** 就发一次召回」，不再用 `scripted.n === 1`：
          // 种了 20 轮历史 + resume 之后，主循环第一发的序号不一定是 1（实测 `--fake` 下
          // 一次召回都没发，冒烟跑的是「不召回直接答」那条路）。
          if (hasRecallTools && !hasToolResults && scripted.recalled !== true) {
            scripted.recalled = true;
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
        // 「不需要召回就看得见」：把 recall 工具结果的正文剔掉再找（recall 把事实捞回来是它该做的事，
        // 记成泄漏会让 B 组这一格永远红）。只剔 `tool_result` 块里属于 recall 工具的那部分。
        const factVisibleWithoutRecall = factForLeakCheck === null
          ? null
          : probe(withoutRecallToolResults(request)).includes(factForLeakCheck);
        const response = await base.chat(request);
        record({
          kind,
          ms: Date.now() - t0,
          input: response?.usage?.input_tokens ?? null,
          output: response?.usage?.output_tokens ?? null,
          factInRequest,
          factVisibleWithoutRecall,
          // 只在排障时留请求体（默认不留：一轮 37k token 的请求留在内存里没必要）
          ...(process.env.ERIX_EVAL_DEBUG_LEAK === "1" ? { request } : {}),
          stop: response?.stop_reason ?? null,
        });
        return response;
      },
    },
  };
}

// ───────────────────────────────────────────────────────────────── 场景

/**
 * 一轮的**真实体量**填充：一份可判读的源码清单（不是无意义重复）。
 *
 * 为什么改（261128）：旧版每轮 ~130 token 的散文填充，8 轮合计才 1.5k —— 而模型窗口 262k、
 * B 组折叠预算被压到 2.5k 才勉强触发折叠。那是**为了触发而扭曲场景**：2.5k 上下文放不下任何
 * 真实工作，测出来的只是「小历史上折叠是纯亏」。现在按真实体量造：每轮一份模块清单（~900 token），
 * 20 轮 ≈ 18k，折叠预算取 16k（模型的 1/16，远小于 262k 窗口）⇒ 折叠由**内容量**自然触发，
 * 不靠压小预算。
 *
 * 内容确定性生成（无随机），保证 A/B 两组拿到逐字相同的账本。
 */
function codeList(n, topic, burial) {
  const modules = [
    "gateway/router.ts", "gateway/auth.ts", "gateway/ratelimit.ts", "gateway/cors.ts",
    "store/pg/pool.ts", "store/pg/migrate.ts", "store/pg/tx.ts", "store/pg/replica.ts",
    "store/redis/cache.ts", "store/redis/lock.ts", "store/redis/pubsub.ts", "store/s3/put.ts",
    "sched/queue.ts", "sched/worker.ts", "sched/retry.ts", "sched/lease.ts",
    "sched/cron.ts", "sched/backfill.ts", "sched/dag.ts", "sched/deadletter.ts",
    "obs/metrics.ts", "obs/trace.ts", "obs/log.ts", "obs/alert.ts",
    "obs/audit.ts", "obs/slo.ts", "obs/profiler.ts", "obs/dashboard.ts",
    "auth/session.ts", "auth/token.ts", "auth/scope.ts", "auth/mfa.ts",
    "billing/meter.ts", "billing/quota.ts", "billing/invoice.ts", "billing/plan.ts",
    "search/index.ts", "search/query.ts", "search/rank.ts", "search/suggest.ts",
  ];
  const lines = modules.map((module, index) => {
    const seq = (n * 31 + index * 7) % 900 + 100;
    // 事实**埋进清单的某一条**（261128）：埋在一句显眼的话里，摘要会照抄 ⇒ 折叠后模型不靠 recall
    // 也能答，测不出 recall 的价值。埋进 40 条机器清单的中间，摘要（≤200 token）抄不下来，
    // 要答对就必须回账本捞 —— 这才是「判读过大文件之后要回忆」的真实场景。
    const planted = burial !== undefined && burial.round === n && burial.index === index
      ? ` // ${burial.marker}`
      : (burial !== undefined && burial.round === n && burial.secondIndex === index
        ? ` // ${burial.secondMarker}`
        : "");
    return `${module}:${seq}  // ${topic}·第${n}轮快照 export ${module.split("/").pop().replace(".ts", "")}Handler`
      + `(input: { id: string; retries: number }) → { ok: boolean; seq: ${seq} }${planted}`;
  });
  return `[第${n}轮·${topic}] 读了一遍模块清单（${String(modules.length)} 个文件）：\n${lines.join("\n")}`;
}

const scenarios = [
  {
    id: 1, name: "单点字符串（令牌）", fact: "tok-7f3a",
    burial: { round: 2, index: 7, marker: "deploy-token=tok-7f3a" },
    rounds: [
      ["启动清单核对：服务名、端口、日志采集，都过了。", "收到，登记进启动清单。"],
      ["部署令牌定下来了，写在第 2 轮那份模块清单的某一条注释里。后面部署要用的就是它，别记混。", "好，令牌已随清单登记，后续以这条为准。"],
      ["灰度比例第一轮 5%，观察两小时无异常再放。", "明白，5% 起步，两小时后看指标。"],
      ["回滚预案：保留上一版镜像 72 小时。", "已写入回滚预案。"],
      ["日志采样率先调到 20% 控制成本。", "采样率 20% 已配置。"],
      ["压测窗口定在周四凌晨。", "已预约周四凌晨压测窗口。"],
      ["文档站今晚发布，别动 main。", "收到，main 挂起合并。"],
      ["本周例会顺延到周五下午。", "已改到周五下午。"],
    ],
    question: "第 2 轮那份模块清单里登记的部署令牌是什么？请逐字给出令牌本身。",
  },
  {
    id: 2, name: "数字（p95）", fact: "412ms",
    burial: { round: 2, index: 11, marker: "p95-budget-ms=412ms" },
    rounds: [
      ["压测环境先对齐：三台 4C8G，数据量 1200 万行。", "环境参数已登记。"],
      ["第 1 次实验跑完，p95 是 318ms，作为基准。", "第 1 次基准 p95=318ms 已记录。"],
      // copilot 复审（PR #985）：这一句原来写着 412ms —— 与埋点重复，于是 B 组即使第 2 轮被折掉，
      // 也能从第 3 轮读到答案，对照就塌了。事实必须**唯一来源**。
      ["第 3 次实验结果比基准差，先别改代码，查索引。", "第 3 次实验结论已记录，先查索引再动代码。"],
      ["索引确实缺了，加复合索引的 PR 我开好了。", "去看 PR，今天合。"],
      ["加完索引复测排到明天上午。", "复测排明天上午。"],
      ["看板加了 p95 分位数面板。", "面板已上线。"],
      ["值班表下周轮换。", "值班表已更新。"],
      ["季度总结模板发群里了。", "模板收到。"],
    ],
    question: "第 2 轮那份模块清单里登记的 p95 预算值是多少？请逐字给出那个数值（含单位）。",
  },
  {
    id: 3, name: "文件路径", fact: "src/db/schema/orders.sql",
    burial: { round: 2, index: 19, marker: "schema-path=src/db/schema/orders.sql" },
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
    question: "第 2 轮那份模块清单里标出的 schema 文件路径是什么？请逐字给出路径。",
  },
  {
    // copilot 复审（PR #985）：上一版直接把答案写成 `handoff-owner=obs-trace`，那就不是两跳了。
    // 恢复真两跳：埋点只给**指针**（`handoff-owner-ref=OWNER-7`），值在**另一条**里
    // （`OWNER-7 → 张启明`），模型要先把两条对上才答得出。
    id: 4, name: "两跳（A 指向 B）", fact: "张启明",
    burial: {
      round: 2, index: 23, marker: "handoff-owner-ref=OWNER-7",
      secondIndex: 27, secondMarker: "OWNER-7 → 张启明（交接责任人）",
    },
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
    question: "第 2 轮那份模块清单里标出的交接责任人（handoff-owner）是谁？请逐字给出。",
  },
  {
    // copilot 复审（PR #985）：上一版直接问 `retry-forbidden` 的字段值，那不是「否定推理」，
    // 只是读字段。恢复否定语义：清单里写着**禁止**用某方案及理由，题目问「为什么不用」。
    id: 5, name: "否定事实", fact: "no-retry-on-4xx",
    burial: { round: 2, index: 29, marker: "retry-forbidden=no-retry-on-4xx（4xx 是客户端错，重试只会放大故障）" },
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
    // 否定推理（copilot 复审 PR #985）：只答出取值不算对，**理由也要答出来** —— 否则这一格
    // 与「读字段」没有区别，测不出「为什么不能这么做」。
    mustInclude: ["no-retry-on-4xx", "客户端错"],
    question: "第 2 轮那份模块清单里写明**禁止**在 4xx 上重试。禁令的取值是什么，"
      + "给出的理由是什么（逐字引用理由里的关键词）？",
  },
  {
    id: 6, name: "干扰项（相似但错误）", fact: "tok-7f3a",
    burial: { round: 2, index: 31, marker: "deploy-token=tok-7f3a" },
    rounds: [
      ["令牌体系先梳理：部署令牌与用户令牌分开管理。", "两套令牌分开管，收到。"],
      ["初版草案里部署令牌写的是 tok-9x9x，注意那只是草案。", "草案值 tok-9x9x 已标注为草案。"],
      ["草案评审：格式要带前缀，长度不超 16。", "格式要求已记。"],
      ["部署令牌最终确认（以第 2 轮模块清单里那条注释为准），草案作废。", "终版令牌已按清单那条登记，草案作废。"],
      ["CI 里注入令牌的 secret 已配置。", "CI secret 配好。"],
      ["预发环境用同一枚，不再发新的。", "预发沿用同令牌。"],
      ["轮换窗口月底评估。", "月底评估轮换。"],
      ["安全审计下季度做。", "审计排期收到。"],
    ],
    question: "第 2 轮那份模块清单里登记的部署令牌是什么（不是草案里的那个）？请逐字给出令牌本身。",
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
        { role: "user", content: [{ type: "text", text: `${codeList(round, group, scenario.burial)}\n${userText}` }] },
        { role: "assistant", content: [{ type: "text", text: assistantText }] },
      ],
    });
  }
  // 261128：场景自带的 rounds 只有 8 条（事实埋在其中），补到 20 条「例行轮」把历史体量撑过
  // B 组 16k 预算 —— 补的内容确定性生成（同 A/B 两组逐字相同），不掺任何新事实。
  const targetRounds = 20;
  while (round < targetRounds) {
    round += 1;
    const key = `${runId}:round:${round}`;
    const routine = `例行巡检第 ${String(round)} 轮：` + `网关/存储/调度三条线指标正常，无告警。`;
    await store.appendRound(runId, {
      round,
      dedupKey: key,
      roundKey: key,
      ts: new Date(1700000000000 + round * 1000).toISOString(),
      messages: [
        { role: "user", content: [{ type: "text", text: `${codeList(round, group, scenario.burial)}\n${routine}` }] },
        { role: "assistant", content: [{ type: "text", text: `第 ${String(round)} 轮巡检完成，登记在案。` }] },
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

  const { log, provider, setFact } = makeMeteredProvider(slot, fake, { hasRecallTools: group === "B" });
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
      // A 组 = **真实窗口内不折叠**（261128 修）：旧版写 8_000_000 —— 没有任何模型能吃 8M 上下文，
      // 那是个不存在的基线。现在取模型自己的窗口（`contextWindowTokens`，本机 262144），保留轮拉满。
      context: {
        budgetTokens: slot.contextWindowTokens ?? 128_000,
        keepRounds: 999,
        task: `recall-eval A${scenario.id}`,
      },
      toolResultTtl: 8,
    }
    : {
      context: {
        // 261128：预算从 2500 抬到 16000 —— 2500 放不下任何真实工作（2.5k 上下文能放啥），
        // 那是「为了触发折叠而压小预算」。16k = 模型窗口的 1/16，折叠由**内容量**自然触发。
        // keepRounds=6 是引擎默认值（保住最近 6 轮 + 问题轮），不再靠 2 硬撑。
        budgetTokens: 16_000,
        keepRounds: 6,
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
  // 正确率（261128 第二版）：支持**多要素必须全中**。场景 5 是「否定推理」——只答出取值
  // （`no-retry-on-4xx`）不算对，还要答出**理由**（copilot 复审：只查取值仍只是检索，不测否定）。
  const required = scenario.mustInclude ?? [scenario.fact];
  const missing = required.filter((needle) => !norm(finalText).includes(norm(needle)));
  const correct = missing.length === 0;

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

  // ── 「影子当事实」拆成两格（261128 修）────────────────────────────────────────
  // 旧口径 `correct && refFound === 0` 把两件不同的事记成同一个名字：
  //   ① **召回成功但没引用**：模型调了 recall_ask，工具把答案直接给它了，它没再用 recall_read 核；
  //   ② **凭印象答**：一次 recall 都没调，答案却对。
  // ① 是「引擎已把 answerUnbacked=true 告诉它、它没去核」，② 才是真·影子。两者对产品的含义不同，
  // 混在一格会让「recall 起作用」看起来像「模型在编」。
  const recallAnswersUnbacked = toolCalls
    .filter((c) => c.name === "recall_ask")
    .map((c) => {
      try {
        return JSON.parse(String(c.result));
      } catch {
        return null;
      }
    })
    .filter((parsed) => parsed !== null)
    .filter((parsed) => parsed.answerUnbacked === true).length;
  const answeredWithoutAnyRecall = correct && recallCalls === 0 && refFound === 0;
  // 兼容旧字段名：`shadowAsFact` 只保留「② 凭印象答」这一种（A 组没有召回通道，恒 false）。
  const shadowAsFact = group === "B" ? answeredWithoutAnyRecall : false;

  // ── 「折叠后事实还在吗」修口径（261128）──────────────────────────────────────
  // 旧口径直接看整份请求里有没有那个字符串——而 `recall_read` / `recall_ask` 把事实捞回来放进请求
  // **正是它该做的事**，于是「召回成功」被记成「泄漏」，B 组这一格永远红。
  // 新口径：只看**不需要召回就看得见**的那部分——请求里把 recall 工具结果的正文剔掉再找。
  const foldIdx = log.findIndex((e) => e.kind === "fold");
  const mainAfterFold = foldIdx === -1 ? [] : mainCalls.filter((e) => log.indexOf(e) > foldIdx);
  const factAfterFold = mainAfterFold.length === 0
    ? null
    : mainAfterFold.every((e) => e.factVisibleWithoutRecall === false);
  if (process.env.ERIX_EVAL_DEBUG_LEAK === "1" && factAfterFold === false && mainAfterFold.length > 0) {
    const first = mainAfterFold[0];
    const probe = JSON.stringify(withoutRecallToolResults(first.request ?? {}));
    const at = probe.indexOf(scenario.fact);
    console.log(`   [debug] 事实仍可见，上下文：…${probe.slice(Math.max(0, at - 120), at + 80)}…`);
  }

  // 取消资格（copilot 复审 PR #985）：B 组若「折叠后不召回仍看得见事实」，这一格**测不出召回**
  // （模型可能从摘要/别处直接读到），不能算进对照。旧版只把它当一条观测打印，于是泄漏场景照样参与
  // 正确率比较 —— 那会让 B 组看起来比实际好。
  const disqualified = group === "B" && foldIdx !== -1 && factAfterFold === false
    ? "fact_visible_after_fold_without_recall"
    : null;

  return {
    scenario: scenario.id,
    name: scenario.name,
    group,
    disqualified,
    runId,
    seedRounds,
    rounds: runResult?.rounds ?? null,
    termination: runResult?.termination?.reason ?? (runError ? `error:${runError.code ?? "unknown"}` : null),
    runError,
    finalText,
    correct,
    missingFacts: missing,
    recallToolCalls: recallCalls,
    converged: group === "B" ? (correct && recallCalls <= 4 && recallCalls >= 1) : correct,
    evidenceRefsReturned: refs.length,
    evidenceRefFound: refFound,
    shadowAsFact,
    // ① 召回给了答案但没回账本核（引擎的 `answerUnbacked: true` 出现过几次）
    recallAnswersUnbacked,
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
    if (r.disqualified !== null) {
      console.log(`   ⚠ 取消资格（${r.disqualified}）：这一格测不出召回，不计入汇总`);
    }
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
// 汇总：**排除被取消资格的场景**（它们测不出召回，算进去会让 B 组虚高）。
const counted = results.filter((r) => r.disqualified === null);
const summary = {
  counted: counted.length,
  disqualified: results.length - counted.length,
  correct: counted.filter((r) => r.correct).length,
  byGroup: Object.fromEntries([...new Set(results.map((r) => r.group))].map((g) => {
    const rows = counted.filter((r) => r.group === g);
    return [g, {
      scenarios: rows.length,
      correct: rows.filter((r) => r.correct).length,
      recallCalls: rows.reduce((sum, r) => sum + r.recallToolCalls, 0),
      inputTokens: rows.reduce((sum, r) => sum + (r.usageByKind.main?.input ?? 0), 0),
    }];
  })),
};
console.log(`\n汇总（已排除 ${summary.disqualified} 个取消资格的场景）：`
  + Object.entries(summary.byGroup)
    .map(([g, v]) => `${g} ${v.correct}/${v.scenarios} 召回 ${v.recallCalls} 次 ↑${v.inputTokens}`)
    .join("｜"));
console.log(`总量：model=${totals.model} ↑${totals.input} ↓${totals.output} 墙钟=${totals.wallMs}ms fake=${cli.fake}`);
writeFileSync(cli.out, JSON.stringify({ slot: slotInfo.slot.model, fake: cli.fake, totals, summary, results }, null, 2));
console.log(`结果 JSON：${cli.out}`);
