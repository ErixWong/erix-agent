// issue #592 —— 压缩收益口径 = 「每任务总输入 + 重复劳动率」，**压缩率不参与判定**。
//
// 本文件钉四件事（每格都有反例，不是恒真断言）：
//   A. 存量真夹具：`test/fixtures/journal-0.22.0/…jsonl`（0.22.0 真产出的账本）上跑出三个数
//      （① 12355 token = 4008+4104+4243；② 0/2；③ n/a 0/0），且输出逐字打印定义与
//      `host-side / not-applicable` 那一格；
//   B. **反向证 1（本单的灵魂）**：夹具 A「压缩节省率 10% → 90%（明显改善）、每任务总输入 +33%」
//      ⇒ 结论必须是 `worsened`；同一份夹具喂给「看压缩率的判定器」必须得到 `improved`
//      —— 即：把判定改成看压缩率，这一格**真的会红**（错误实现产生可观测的错误结论）；
//   C. **反向证 2**：夹具 B「重复读取率 50% → 25%（下降）、每任务总输入不变」⇒ 结论必须是
//      `no-significant-change`，不许报 `improved`；「任一维度改善就算 improved」的判定器在这一格
//      必须得到 `improved`（同样证明夹具会咬人，不是恒绿）；
//   D. 形状兼容：0.23.0+ 的 `kind:"message"` 行 + 轮上 `usage` / `engineUsage` 也要算对
//      （工具调用从消息行取，总输入 = 主循环 + 引擎自发），resume 复制的同一 `tool_use.id` 只算一次。
//
// 隔离：合成账本写在 `makeTmp()` 的临时目录里（卫生门禁口径），不碰 `~/.erix`，零真实 LLM。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFINITIONS,
  SIGNIFICANT_INPUT_RATIO,
  SIGNIFICANT_REPEAT_PP,
  VERDICT_IMPROVED,
  VERDICT_SINGLE_SIDE,
  VERDICT_UNCHANGED,
  VERDICT_WORSENED,
  VERDICT_RULES,
  aggregateSide,
  analyzeTranscript,
  decide,
  formatReport,
  loadSide,
  repeatRate,
} from "../scripts/compaction-benefit-analyzer.mjs";
import { makeTmp } from "./helpers/tmp.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "compaction-benefit-analyzer.mjs");
const REAL_FIXTURE = join(
  ROOT, "test", "fixtures", "journal-0.22.0", "work-c7d61121-mvi9c4fj-77f54351.jsonl",
);

// ── 合成账本的搭台件 ────────────────────────────────────────────────────────────
// 老账本形状（0.22.0）：正文挂在轮行的 `messages` 上，usage 只在 `response.usage` 里。
const text = (value) => [{ type: "text", text: value }];
const readCall = (id, path) => ({ type: "tool_use", id, name: "readFile", input: { path } });
const execCall = (id, command) => ({ type: "tool_use", id, name: "exec", input: { command } });

function legacyRound({ round, inputTokens, toolUses = [], compactionStats }) {
  const record = {
    round,
    roundKey: `synthetic-592:round:${round}`,
    dedupKey: `synthetic-592:engine:round:${round}`,
    ts: `2026-10-24T00:00:0${round}.000Z`,
    messages: [
      { role: "assistant", content: toolUses.length > 0 ? toolUses : text(`round ${round}`) },
    ],
    response: {
      content: toolUses.length > 0 ? toolUses : text(`round ${round}`),
      stopReason: toolUses.length > 0 ? "tool_use" : "end_turn",
      usage: { input_tokens: inputTokens, output_tokens: 10 },
    },
  };
  if (compactionStats !== undefined) record.compactionStats = compactionStats;
  return record;
}

function stat({ tokensBefore, tokensAfter }) {
  return {
    compacted: true,
    foldedRounds: 1,
    tokensBefore,
    tokensAfter,
    layers: {
      ttl: { triggered: 0, tokensSaved: 0 },
      slidingWindow: { triggered: tokensBefore > tokensAfter ? 1 : 0, tokensSaved: tokensBefore - tokensAfter },
    },
  };
}

async function writeTranscript(dir, name, records) {
  const path = join(dir, name);
  const body = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  await writeFile(path, body, "utf8");
  return path;
}

// 两个**变异判定器**（故意实现错的那种）。它们的意义不是"备份实现"，而是证明夹具会咬人：
// 如果分析器真的按下面任一条判，对应那一格就必须红。
/** 只看压缩节省率（错误实现 #1：正是本单要禁掉的口径）。 */
function compactionRateVerdict(baseline, candidate) {
  const base = baseline.compaction.savingsRatio;
  const cand = candidate.compaction.savingsRatio;
  if (!Number.isFinite(base) || !Number.isFinite(cand)) return VERDICT_UNCHANGED;
  if (cand - base > 0.01) return VERDICT_IMPROVED;
  if (base - cand > 0.01) return VERDICT_WORSENED;
  return VERDICT_UNCHANGED;
}
/** 任一维度改善就算 improved（错误实现 #2：把"局部改善"当结论）。 */
function anyImprovementVerdict(baseline, candidate) {
  const readDown = Number.isFinite(baseline.read.rate) && Number.isFinite(candidate.read.rate)
    && candidate.read.rate < baseline.read.rate;
  const execDown = Number.isFinite(baseline.exec.rate) && Number.isFinite(candidate.exec.rate)
    && candidate.exec.rate < baseline.exec.rate;
  const inputDown = candidate.totalInputTokens < baseline.totalInputTokens;
  return readDown || execDown || inputDown ? VERDICT_IMPROVED : VERDICT_UNCHANGED;
}

// ── A. 存量真夹具（0.22.0 的真实账本）────────────────────────────────────────────

test("#592 A：存量真夹具上跑出三个数（① 累加 / ② 分子分母 / ③ n/a），定义逐字打印", async () => {
  const side = loadSide([REAL_FIXTURE], "基线");
  const run = side.runs[0];

  assert.equal(run.runId, "work-c7d61121-mvi9c4fj-77f54351");
  // ① 累加，不是峰值：4008 + 4104 + 4243（不是 4243，也不是压缩率）。
  assert.equal(run.totalInputTokens, 12355);
  assert.equal(run.modelInputTokens, 12355);
  assert.equal(run.engineInputTokens, 0);
  assert.deepEqual(run.perRound.map((entry) => entry.model), [4008, 4104, 4243]);
  // ② 两次 readFile 读的是两个不同 path ⇒ 分子 0、分母 2。
  assert.equal(run.read.numerator, 0);
  assert.equal(run.read.denominator, 2);
  assert.equal(run.read.calls, 2);
  assert.equal(run.read.rate, 0);
  // ③ 这份账本没有 exec 调用 ⇒ 0/0，rate 必须是 null（不是 0，不许把"没数据"说成"0%"）。
  assert.equal(run.exec.denominator, 0);
  assert.equal(run.exec.calls, 0);
  assert.equal(run.exec.rate, null);

  // 单侧报告：结论 not-applicable，且 ④ 的标记逐字出现。
  const report = formatReport(side, null, null);
  assert.match(report, /① 每任务总输入 = 12355 token/u);
  assert.match(report, /② 重复读取率 = 0\/2 = 0\.0%/u);
  assert.match(report, /③ 重复执行率 = n\/a（0\/0）/u);
  assert.match(report, /host-side \/ not-applicable/u);
  assert.match(report, /【结论】not-applicable/u);
  assert.equal(VERDICT_SINGLE_SIDE, "not-applicable");
  // 定义与判定规则是打印物的一部分（读者不必翻文档就知道分子分母）。
  for (const line of DEFINITIONS) assert.ok(report.includes(line), `报告里缺少定义行：${line}`);
  for (const line of VERDICT_RULES) assert.ok(report.includes(line), `报告里缺少规则行：${line}`);
  assert.match(report, /压缩率（compactionStats 的节省量 \/ compacted 真假 \/ 层触发次数）不参与判定/u);
});

// ── B. 反向证 1：压缩率明显改善、但每任务总输入上升 ⇒ worsened ──────────────────

test("#592 B：夹具 A「压缩率改善 + 总输入上升」⇒ worsened；改成看压缩率的判定器在同一夹具上给 improved（该格红）", async () => {
  const dir = await makeTmp("erix-592-a-");
  const baselinePath = await writeTranscript(dir, "baseline-a.jsonl", [
    legacyRound({ round: 1, inputTokens: 4000, toolUses: [readCall("a-1", "src/one.js")] }),
    legacyRound({ round: 2, inputTokens: 4000, toolUses: [readCall("a-2", "src/two.js")], compactionStats: [stat({ tokensBefore: 10000, tokensAfter: 9000 })] }),
    legacyRound({ round: 3, inputTokens: 4000 }),
  ]);
  const candidatePath = await writeTranscript(dir, "candidate-a.jsonl", [
    legacyRound({ round: 1, inputTokens: 5000, toolUses: [readCall("b-1", "src/one.js")] }),
    legacyRound({ round: 2, inputTokens: 6000, toolUses: [readCall("b-2", "src/two.js")], compactionStats: [stat({ tokensBefore: 40000, tokensAfter: 4000 })] }),
    legacyRound({ round: 3, inputTokens: 5000 }),
  ]);

  const baseline = loadSide([baselinePath], "基线");
  const candidate = loadSide([candidatePath], "候选");
  assert.equal(baseline.totalInputTokens, 12000);
  assert.equal(candidate.totalInputTokens, 16000); // +33.3%
  // 压缩侧确实"改善"了：节省率 10% → 90%。
  assert.equal(baseline.compaction.savingsRatio, 0.1);
  assert.equal(candidate.compaction.savingsRatio, 0.9);

  const decision = decide(baseline, candidate);
  assert.equal(decision.verdict, VERDICT_WORSENED,
    `压缩率改善但总输入上升必须是 worsened，实测 ${decision.verdict}`);
  assert.ok(decision.inputRatio > SIGNIFICANT_INPUT_RATIO);

  // **反向证**：同一个夹具喂给"看压缩率"的判定器 ⇒ improved（错误结论真的产生出来了）。
  const mutated = compactionRateVerdict(baseline, candidate);
  assert.equal(mutated, VERDICT_IMPROVED,
    "夹具必须能让压缩率判定器给出 improved，否则这一格证明不了任何事");
  assert.notEqual(mutated, decision.verdict,
    "正确判定与压缩率判定的结论必须不同 —— 把判定改成看压缩率，这一格就会红");

  // 报告里：结论行是 worsened，压缩侧数字只出现在"不参与判定"的附注段。
  const report = formatReport(baseline, candidate, decision);
  assert.match(report, /【结论】worsened/u);
  assert.match(report, /压缩率下降\*\*不构成\*\*优化证据/u);
  assert.ok(report.indexOf("【附注（不参与判定）】") < report.indexOf("节省率 90.0%"),
    "压缩节省率只能出现在附注段里");
});

// ── C. 反向证 2：重复读取率下降、但每任务总输入不变 ⇒ no-significant-change ──────

test("#592 C：夹具 B「重复读取率下降 + 总输入不变」⇒ no-significant-change，不许报 improved", async () => {
  const dir = await makeTmp("erix-592-b-");
  const baselinePath = await writeTranscript(dir, "baseline-b.jsonl", [
    legacyRound({
      round: 1,
      inputTokens: 6000,
      toolUses: [
        readCall("c-1", "src/a.js"),
        readCall("c-2", "src/a.js"),
        readCall("c-3", "src/b.js"),
        readCall("c-4", "src/b.js"),
      ],
    }),
    legacyRound({
      round: 2,
      inputTokens: 6000,
      toolUses: [readCall("c-5", "src/a.js"), readCall("c-6", "src/c.js")],
    }),
  ]);
  const candidatePath = await writeTranscript(dir, "candidate-b.jsonl", [
    legacyRound({
      round: 1,
      inputTokens: 6000,
      toolUses: [readCall("d-1", "src/a.js"), readCall("d-2", "src/b.js")],
    }),
    legacyRound({
      round: 2,
      inputTokens: 6000,
      toolUses: [readCall("d-3", "src/c.js"), readCall("d-4", "src/d.js")],
    }),
  ]);

  const baseline = loadSide([baselinePath], "基线");
  const candidate = loadSide([candidatePath], "候选");
  // 基线：a×3 / b×2 / c×1 ⇒ 分子 2、分母 3；候选：四个 path 各一次 ⇒ 分子 0、分母 4。
  assert.equal(baseline.read.numerator, 2);
  assert.equal(baseline.read.denominator, 3);
  assert.equal(candidate.read.numerator, 0);
  assert.equal(candidate.read.denominator, 4);
  assert.equal(baseline.totalInputTokens, 12000);
  assert.equal(candidate.totalInputTokens, 12000); // ① 不变

  const decision = decide(baseline, candidate);
  assert.equal(decision.verdict, VERDICT_UNCHANGED,
    `① 不变时 ② 的下降不构成优化证据，实测 ${decision.verdict}`);
  assert.notEqual(decision.verdict, VERDICT_IMPROVED);
  assert.ok(decision.readPp <= -SIGNIFICANT_REPEAT_PP);
  assert.match(decision.reasons.join("\n"), /局部改善不算结论/u);

  // **反向证**：把判定改成"任一维度改善就算 improved" ⇒ 同一夹具给 improved（该格红）。
  const mutated = anyImprovementVerdict(baseline, candidate);
  assert.equal(mutated, VERDICT_IMPROVED,
    "夹具必须能让'任一维度改善即 improved'的判定器给出 improved");
  assert.notEqual(mutated, decision.verdict);
});

// ── D. 形状兼容：kind:"message" 行 + usage/engineUsage + resume 复制块 ────────────

test("#592 D：0.23.0+ 形状（消息行 / 轮上 usage+engineUsage / 同一 tool_use.id 复制）也算对", async () => {
  const dir = await makeTmp("erix-592-c-");
  const records = [
    // 轮 1：消息行带正文（新形状），轮行只有元数据 + 轮累计 usage。
    {
      round: 1,
      roundKey: "modern-592:round:1",
      dedupKey: "modern-592:engine:round:1",
      kind: "message",
      seq: 0,
      messages: [{ role: "assistant", content: [readCall("m-1", "src/x.js")] }],
      ts: "2026-10-24T01:00:00.000Z",
    },
    {
      round: 1,
      roundKey: "modern-592:round:1",
      dedupKey: "modern-592:engine:round:1",
      ts: "2026-10-24T01:00:01.000Z",
      response: { content: text("done"), stopReason: "tool_use", usage: { input_tokens: 900, output_tokens: 5 } },
      usage: { input_tokens: 1000, output_tokens: 20 },
      engineUsage: { input_tokens: 300, output_tokens: 10 },
    },
    // 轮 2：resume 预落盘行带着同一个 tool_use.id 的副本（不许算两次调用）。
    {
      round: 2,
      roundKey: "modern-592:round:2:resume",
      dedupKey: "modern-592:engine:round:2:resume",
      messages: [
        {
          role: "assistant",
          content: [
            readCall("m-1", "src/x.js"), // 同一个 id 的副本：不算第二次
            readCall("m-3", "src/y.js"),
            execCall("m-2", "npm test"),
          ],
        },
      ],
      ts: "2026-10-24T01:00:02.000Z",
    },
    {
      round: 2,
      roundKey: "modern-592:round:2",
      dedupKey: "modern-592:engine:round:2",
      ts: "2026-10-24T01:00:03.000Z",
      response: { content: text("done"), stopReason: "end_turn", usage: { input_tokens: 1100, output_tokens: 5 } },
      usage: { input_tokens: 1100, output_tokens: 15 },
      engineUsage: { input_tokens: 0, output_tokens: 0 },
    },
  ];
  const path = await writeTranscript(dir, "modern.jsonl", records);
  const side = loadSide([path], "基线");
  const run = side.runs[0];

  // ① 轮累计 usage（1000 + 1100）+ 引擎自发（300 + 0）= 2400；不是最后一发 1100。
  assert.equal(run.modelInputTokens, 2100);
  assert.equal(run.engineInputTokens, 300);
  assert.equal(run.totalInputTokens, 2400);
  // ②③ 从消息行取调用；resume 复制的同一 id 只算一次（4 个块 → 3 次调用）⇒
  // readFile 两个不同 path、exec 一条命令。
  assert.equal(run.read.calls, 2);
  assert.equal(run.read.denominator, 2);
  assert.equal(run.read.numerator, 0);
  assert.equal(run.exec.calls, 1);
  assert.equal(run.exec.denominator, 1);
  assert.equal(run.exec.numerator, 0);
});

test("#592 D2：重复率分子/分母口径（≥2 次才算重复；缺参调用不进分母，单独计数）", () => {
  const uses = [
    { name: "readFile", input: { path: "a" } },
    { name: "readFile", input: { path: "a" } },
    { name: "readFile", input: { path: "b" } },
    { name: "readFile", input: {} }, // 缺参：不进分母
    { name: "readFile", input: { path: "" } }, // 空串：不进分母
    { name: "exec", input: { command: "ls" } },
  ];
  const read = repeatRate(uses, "readFile", "path");
  assert.equal(read.calls, 5);
  assert.equal(read.missingKeyCalls, 2);
  assert.equal(read.denominator, 2);
  assert.equal(read.numerator, 1);
  assert.equal(read.rate, 0.5);
  assert.deepEqual(read.repeatedKeys, [{ key: "a", count: 2 }]);
  const exec = repeatRate(uses, "exec", "command");
  assert.equal(exec.denominator, 1);
  assert.equal(exec.numerator, 0);
});

// ── E. 判定口径守卫：decide 的源码里不许出现压缩侧字段 ─────────────────────────

test("#592 E：判定函数不读压缩侧事实（源码守卫 + 入参守卫）", () => {
  const source = decide.toString();
  for (const forbidden of [
    "compaction", "compactionStats", "tokensBefore", "tokensAfter",
    "savedTokens", "savingsRatio", "compacted", "layers", "triggered",
  ]) {
    assert.ok(!source.includes(forbidden),
      `decide() 的源码里出现了压缩侧字样 ${forbidden} —— 压缩率不许进入判定`);
  }
  // 入参守卫：把压缩侧字段塞进两个操作数，结论必须与不塞时逐字相同。
  const baseline = { totalInputTokens: 10000, read: { rate: 0.5 }, exec: { rate: 0 } };
  const candidate = { totalInputTokens: 10000, read: { rate: 0.5 }, exec: { rate: 0 } };
  const plain = decide(baseline, candidate);
  const polluted = decide(
    { ...baseline, compaction: { savingsRatio: 0.9, savedTokens: 999999, compactedTrue: 99 } },
    { ...candidate, compaction: { savingsRatio: 0.01, savedTokens: 0, compactedTrue: 0 } },
  );
  assert.equal(polluted.verdict, plain.verdict);
  assert.deepEqual(polluted, plain);
});

// ── F. CLI：同一份夹具跑一次，退出码 0，输出里三格齐全 ──────────────────────────

test("#592 F：CLI 跑通（退出码 0 + 定义/结论/④ 标记 + --json 同一批事实）", async () => {
  const dir = await makeTmp("erix-592-cli-");
  const baselinePath = await writeTranscript(dir, "baseline-a.jsonl", [
    legacyRound({ round: 1, inputTokens: 4000, toolUses: [readCall("a-1", "src/one.js")] }),
    legacyRound({ round: 2, inputTokens: 4000, toolUses: [readCall("a-2", "src/two.js")], compactionStats: [stat({ tokensBefore: 10000, tokensAfter: 9000 })] }),
  ]);
  const candidatePath = await writeTranscript(dir, "candidate-a.jsonl", [
    legacyRound({ round: 1, inputTokens: 6000, toolUses: [readCall("b-1", "src/one.js")] }),
    legacyRound({ round: 2, inputTokens: 6000, toolUses: [readCall("b-2", "src/two.js")], compactionStats: [stat({ tokensBefore: 40000, tokensAfter: 4000 })] }),
  ]);

  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });

  const textRun = run([baselinePath, candidatePath]);
  assert.equal(textRun.status, 0, `CLI 必须退出 0（结论不影响退出码），实测 ${textRun.status}\n${textRun.stderr}`);
  assert.match(textRun.stdout, /【结论】worsened/u);
  assert.match(textRun.stdout, /host-side \/ not-applicable/u);
  assert.match(textRun.stdout, /不参与判定/u);
  assert.match(textRun.stdout, /② 重复读取率 = 0\/2 = 0\.0%/u);

  const jsonRun = run(["--json", baselinePath, candidatePath]);
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const payload = JSON.parse(jsonRun.stdout);
  assert.equal(payload.scope, "run");
  assert.equal(payload.decision.verdict, "worsened");
  assert.equal(payload.baseline.totalInputTokens, 8000);
  assert.equal(payload.candidate.totalInputTokens, 12000);
  assert.equal(payload.userRestatement, "host-side / not-applicable");
  // 压缩侧事实在 JSON 里叫 compactionNotJudged —— 名字就把"不进判定"写在脸上。
  assert.equal(payload.candidate.compactionNotJudged.savingsRatio, 0.9);

  // 单侧：只打印三个数，结论 not-applicable。
  const single = run([baselinePath]);
  assert.equal(single.status, 0);
  assert.match(single.stdout, /【结论】not-applicable/u);

  // 用法错误 ⇒ 2（不是 0，也不是 1：观察面不把"结论不好"和"没跑起来"混成一个码）。
  const bad = run([join(dir, "missing.jsonl")]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /读账本失败/u);
});

// ── G. 多 run 一侧（session 口径）：分子/分母按 run 先算再累加 ──────────────────

test("#592 G：同一侧多个 run 时，重复率仍只在单个 run 内成立（累加分子/分母，不跨 run 去重）", async () => {
  const dir = await makeTmp("erix-592-multi-");
  const first = await writeTranscript(dir, "run-1.jsonl", [
    legacyRound({ round: 1, inputTokens: 1000, toolUses: [readCall("e-1", "src/shared.js"), readCall("e-2", "src/shared.js")] }),
  ]);
  const second = await writeTranscript(dir, "run-2.jsonl", [
    legacyRound({ round: 1, inputTokens: 2000, toolUses: [readCall("f-1", "src/shared.js")] }),
  ]);
  const side = loadSide([first, second], "候选");
  assert.equal(side.runCount, 2);
  assert.equal(side.totalInputTokens, 3000);
  // run-1: 1/1；run-2: 0/1 ⇒ 合计 1/2（若跨 run 合并，"shared.js" 会被算成 2 次、分母 1 ⇒ 1/1）。
  assert.equal(side.read.numerator, 1);
  assert.equal(side.read.denominator, 2);
  assert.equal(side.read.rate, 0.5);

  const single = aggregateSide([side.runs[1]], "单 run");
  assert.equal(single.read.rate, 0);
});
