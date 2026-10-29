// issue #596 —— 重复读度量细化到 `(path, offset, limit)`：② 含分页读，②' 才是真浪费。
//
// 票面：②（同 path）把**分页读**也算成重复 ⇒ 本机 122 份真实 transcript 上 ② 报 164 次重读，
// 其中只有 59 次是「同 path 同 range」的真浪费，105 次是正当的分页读。任何基于 164 的优化决策
// 都是错的，所以先把度量拆开。本单**只动分析器 + 本测试**：`src/` 一行不动，`decide()` 一字不动。
//
// 本文件钉的格子（每格都配了能把它打红的反向证，不是恒真断言）：
//   A. **反向证 1（分页夹具）**：同一 path、三次**不同** range（offset 0/100/200）⇒ ②' 的浪费格
//      （`numerator` / `rate` / `repeatedKeys` / `repeatedCalls`）必须全 0，而 ② 仍然记 2 次重读。
//      把键退化成只用 `path` ⇒ 同一夹具上 `numerator` 变 1、`repeatedCalls` 变 2，**该格红**。
//   B. **反向证 2（真重复夹具）**：同一 path 同一 range 读 2 次 ⇒ `calls=2` / `numerator=1` /
//      `denominator=1` / `rate=1` / `repeatedCalls=1`；且既有 `read`（同 path）的六个字段与
//      **改动前的实现**（本文件里的 `legacyRepeatRate`，逐字拷贝旧算法）逐字相同。
//   C. 键构造：`path@offset:limit`，`offset` 缺省 0、`limit` 缺省 null，**两者按原值参与键、不做归一化**
//      （`limit: 0` 不等于缺省、`offset: null` 不折算成 0），缺 `path` ⇒ `null`（不进分母）。
//   D. ②' **不参与判定**：`decide()` 源码里没有 `sameRange` / `repeatedCalls`；把 ②' 塞进操作数
//      结论逐字不变；而「看 ②' 的变异判定器」在同一夹具上会给出不同结论（证明夹具会咬人）。
//   E. 报告与 JSON：两行**并列**打印 + 写死那句「分页读不计入浪费」；`--json` 里带 `read.sameRange`
//      与说明该口径的 `definitions` 行。
//   F. session 口径：②' 与 ② 一样**只在单个 run 内成立**（先逐 run 算、再累加分子/分母）。
//
// 隔离：合成账本写在 `makeTmp()` 的临时目录里（卫生门禁口径），不碰 `~/.erix`，零真实 LLM。
// 真实数据（122 份 transcript ⇒ 368 / 164 / 59 / 105）是本单的**人工对拍**，不是本文件的用例
// ——用例不许读 `~/.erix`（机器上没有那棵树时整批会红，而那不是产品缺陷）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFINITIONS,
  READ_TOOL,
  VERDICT_IMPROVED,
  VERDICT_UNCHANGED,
  aggregateSide,
  analyzeTranscript,
  collectToolUses,
  decide,
  formatReport,
  loadSide,
  parseTranscript,
  rangeRepeatRate,
  readRangeKey,
  repeatRate,
} from "../scripts/compaction-benefit-analyzer.mjs";
import { makeTmp } from "./helpers/tmp.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "compaction-benefit-analyzer.mjs");
const REAL_FIXTURE = join(
  ROOT, "test", "fixtures", "journal-0.22.0", "work-c7d61121-mvi9c4fj-77f54351.jsonl",
);

// ── 合成账本的搭台件（与 #592 的夹具同一形状）────────────────────────────────────
const text = (value) => [{ type: "text", text: value }];
const readCall = (id, path, range = {}) => ({
  type: "tool_use",
  id,
  name: READ_TOOL,
  input: { path, ...range },
});

function legacyRound({ round, inputTokens, toolUses = [] }) {
  return {
    round,
    roundKey: `synthetic-596:round:${round}`,
    dedupKey: `synthetic-596:engine:round:${round}`,
    ts: `2026-10-25T00:00:0${round}.000Z`,
    messages: [
      { role: "assistant", content: toolUses.length > 0 ? toolUses : text(`round ${round}`) },
    ],
    response: {
      content: toolUses.length > 0 ? toolUses : text(`round ${round}`),
      stopReason: toolUses.length > 0 ? "tool_use" : "end_turn",
      usage: { input_tokens: inputTokens, output_tokens: 10 },
    },
  };
}

/** 记录数组 → 账本文本（与 `writeTranscript` 落盘的是同一份字节）。 */
const bodyOf = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

async function writeTranscript(dir, name, records) {
  const path = join(dir, name);
  await writeFile(path, bodyOf(records), "utf8");
  return path;
}

/** 账本文本 → 工具调用列表（与 `analyzeTranscript` 内部同一条入口）。 */
const usesOf = (body) => collectToolUses(parseTranscript(body).records);

/**
 * **改动前的 ② 实现**（issue #592 落地的那一版，逐字拷贝）。
 * 它的唯一用途是「历史对拍」：本单不许改 ② 的口径，所以拿它当基准逐字比对 ② 的六个字段。
 * 不要在这里补 `sameRange` / `repeatedCalls`——它代表的是**旧**算法。
 */
function legacyRepeatRate(uses, toolName, keyName) {
  const counts = new Map();
  let missingKeyCalls = 0;
  let calls = 0;
  for (const use of uses) {
    if (use.name !== toolName) continue;
    calls += 1;
    const key = use.input?.[keyName];
    if (typeof key !== "string" || key === "") {
      missingKeyCalls += 1;
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const denominator = counts.size;
  let numerator = 0;
  for (const count of counts.values()) if (count >= 2) numerator += 1;
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
    calls,
    missingKeyCalls,
    repeatedKeys: [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([key, count]) => ({ key, count })),
  };
}

/** ②（同 path）的**旧口径六格**——本单只允许「加法」，这六格必须逐字相同。 */
const LEGACY_FIELDS = ["numerator", "denominator", "rate", "calls", "missingKeyCalls", "repeatedKeys"];
const pick = (rate) => Object.fromEntries(LEGACY_FIELDS.map((field) => [field, rate[field]]));
/** ②' 的**浪费格**（分页夹具里必须全 0）。`calls` 不是浪费格：它是「该工具一共调了几次」。 */
const WASTE_FIELDS = ["numerator", "rate", "repeatedKeys", "repeatedCalls"];
const wasteOf = (rate) => Object.fromEntries(WASTE_FIELDS.map((field) => [field, rate[field]]));

// ── A. 反向证 1：分页读不得计入浪费 ─────────────────────────────────────────────

test("#596 A：分页夹具（同 path × 三个不同 range）⇒ ②' 的浪费格全 0；把键退化成只用 path 则该格红", async () => {
  const dir = await makeTmp("erix-596-paging-");
  const records = [
    legacyRound({
      round: 1,
      inputTokens: 3000,
      toolUses: [
        readCall("p-1", "src/page.js", { offset: 0 }),
        readCall("p-2", "src/page.js", { offset: 100 }),
        readCall("p-3", "src/page.js", { offset: 200 }),
      ],
    }),
  ];
  const body = bodyOf(records);
  const path = await writeTranscript(dir, "paging.jsonl", records);

  const side = loadSide([path], "基线");
  const run = side.runs[0];
  const sameRange = run.read.sameRange;

  // ②'（同 path 同 range）：三个键互不相同 ⇒ 分母 3、没有重复键 ⇒ 浪费格全 0。
  assert.equal(sameRange.calls, 3, "calls 是「readFile 一共调了几次」，与 read.calls 同义");
  assert.equal(sameRange.denominator, 3);
  assert.equal(sameRange.numerator, 0);
  assert.equal(sameRange.rate, 0, "分母不为 0 时 rate 必须是 0（不是 null：null 只留给 0/0）");
  assert.equal(sameRange.repeatedCalls, 0, "分页读不是重读 ⇒ repeatedCalls 必须是 0");
  assert.deepEqual(sameRange.repeatedKeys, []);
  assert.deepEqual(wasteOf(sameRange), {
    numerator: 0, rate: 0, repeatedKeys: [], repeatedCalls: 0,
  });

  // ②（同 path）在**同一夹具**上仍然是「重复」：3 次调用、1 个 path ⇒ 重读 2 次。
  // 这正是票面说的「② 含分页读、不等于浪费」——两行必须能同时成立。
  assert.equal(run.read.calls, 3);
  assert.equal(run.read.denominator, 1);
  assert.equal(run.read.numerator, 1);
  assert.equal(run.read.rate, 1);
  assert.equal(run.read.repeatedCalls, 2);

  // 报告里并列两行，②' 那行把 0/3 与「重读 0 次、分页读 2 次」写出来。
  const report = formatReport(side, null, null);
  assert.match(report, /② 重复读取率（同 path）\s+= 1\/1 = 100\.0%（含分页读，不等于浪费）/u);
  assert.match(report, /②' 真浪费（同 path 同 range） = 0\/3 = 0\.0%（\*\*分页读不计入浪费\*\*）/u);
  assert.match(report, /重读调用 0 次；分页读（同 path 不同 range）= 2 次/u);

  // **反向证**：把键退化成只用 path（= ② 的旧口径）⇒ 同一夹具上浪费格立刻不为 0。
  const mutated = repeatRate(usesOf(body), READ_TOOL, "path");
  assert.equal(mutated.numerator, 1, "退化成只用 path 时这一格必须是 1（红）");
  assert.equal(mutated.repeatedCalls, 2, "退化成只用 path 时重读调用必须是 2（红）");
  assert.notDeepEqual(wasteOf(mutated), wasteOf(sameRange),
    "键一退化，②' 的浪费格必须与正确实现不同 —— 否则这格证明不了任何事");
  assert.notEqual(mutated.numerator, sameRange.numerator);
});

// ── B. 反向证 2：真重复算得准，且 ② 的口径逐字未变 ─────────────────────────────

test("#596 B：真重复夹具（同 path 同 range ×2）⇒ ②' calls=2 / 1/1 / repeatedCalls=1；② 六格与改动前逐字相同", async () => {
  const dir = await makeTmp("erix-596-dup-");
  const records = [
    legacyRound({
      round: 1,
      inputTokens: 2000,
      toolUses: [readCall("d-1", "src/dup.js", { offset: 40, limit: 60 })],
    }),
    legacyRound({
      round: 2,
      inputTokens: 2000,
      toolUses: [readCall("d-2", "src/dup.js", { offset: 40, limit: 60 })],
    }),
  ];
  const body = bodyOf(records);
  const path = await writeTranscript(dir, "dup.jsonl", records);

  const side = loadSide([path], "基线");
  const run = side.runs[0];
  const sameRange = run.read.sameRange;

  // ②'：同一个键 `src/dup.js@40:60` 出现 2 次 ⇒ calls 2、分母 1、分子 1、rate 1/1、重读 1 次。
  assert.equal(sameRange.calls, 2);
  assert.equal(sameRange.denominator, 1);
  assert.equal(sameRange.numerator, 1);
  assert.equal(sameRange.rate, 1);
  assert.equal(sameRange.repeatedCalls, 1);
  assert.equal(sameRange.missingKeyCalls, 0);
  assert.deepEqual(sameRange.repeatedKeys, [{ key: "src/dup.js@40:60", count: 2 }]);

  // ②（同 path）在这一格上也报重复，但它**没有** range 信息：值必须与改动前逐字相同。
  assert.equal(run.read.numerator, 1);
  assert.equal(run.read.denominator, 1);
  assert.equal(run.read.calls, 2);
  assert.equal(run.read.rate, 1);
  assert.equal(run.read.repeatedCalls, 1);
  assert.deepEqual(pick(run.read), legacyRepeatRate(usesOf(body), READ_TOOL, "path"));

  // **历史对拍**（存量真夹具，0.22.0 真产出的账本）：② 六格同样逐字相同。
  const realSide = loadSide([REAL_FIXTURE], "基线");
  const realBody = readFileSync(REAL_FIXTURE, "utf8");
  assert.deepEqual(pick(realSide.runs[0].read), legacyRepeatRate(usesOf(realBody), READ_TOOL, "path"));
  assert.equal(realSide.runs[0].read.repeatedCalls, 0);

  // **反向证**：把两个 range 改成不同值 ⇒ ②' 的浪费格必须归零（同一夹具的对照组）。
  const differentRanges = repeatRate(
    [
      { name: READ_TOOL, input: { path: "src/dup.js", offset: 40, limit: 60 } },
      { name: READ_TOOL, input: { path: "src/dup.js", offset: 40, limit: 61 } },
    ],
    READ_TOOL,
    "path",
  );
  assert.equal(differentRanges.numerator, 1, "只用 path 时「改了 limit」仍算重复（这就是旧口径的病）");
  assert.equal(
    rangeRepeatRate([
      { name: READ_TOOL, input: { path: "src/dup.js", offset: 40, limit: 60 } },
      { name: READ_TOOL, input: { path: "src/dup.js", offset: 40, limit: 61 } },
    ]).numerator,
    0,
    "②' 必须把「limit 不同」认成两次不同的读",
  );
});

// ── C. 键构造：path@offset:limit，原值参与、不归一化 ─────────────────────────────

test("#596 C：键 = `path@offset:limit`（缺省 0/null，原值参与、不归一化；缺 path ⇒ null）", () => {
  const cases = [
    [{ path: "a.js" }, "a.js@0:null"],
    [{ path: "a.js", offset: 0 }, "a.js@0:null"],
    [{ path: "a.js", offset: 100 }, "a.js@100:null"],
    [{ path: "a.js", limit: 50 }, "a.js@0:50"],
    [{ path: "a.js", offset: 100, limit: 50 }, "a.js@100:50"],
    // 「按原值参与、不做归一化」的三条反向证：
    [{ path: "a.js", limit: 0 }, "a.js@0:0"], // limit:0 ≠ 缺省 null
    [{ path: "a.js", offset: null }, "a.js@null:null"], // 显式 null 不折算成 0
    [{ path: "a.js", offset: "100" }, "a.js@100:null"], // 非数字原样进键，不做类型归一化
  ];
  for (const [input, expected] of cases) {
    assert.equal(readRangeKey(input), expected, `键构造错了：${JSON.stringify(input)}`);
  }
  // 缺 path（缺参 / 空串 / 非字符串）⇒ null：不进分母，与 ② 的缺参口径一致。
  for (const input of [{}, { path: "" }, { path: 42 }, { path: null }, null, undefined]) {
    assert.equal(readRangeKey(input), null, `缺 path 必须返回 null：${JSON.stringify(input)}`);
  }
  // 反向证：把 limit:0 折成缺省、或把 offset:null 折成 0，都会让下面这两组键相等（红）。
  assert.notEqual(readRangeKey({ path: "a.js" }), readRangeKey({ path: "a.js", limit: 0 }));
  assert.notEqual(readRangeKey({ path: "a.js" }), readRangeKey({ path: "a.js", offset: null }));
  assert.notEqual(readRangeKey({ path: "a.js", offset: 0 }), readRangeKey({ path: "a.js", offset: 200 }));
});

// ── D. ②' 不参与判定 ────────────────────────────────────────────────────────────

test("#596 D：②' 不参与判定（源码守卫 + 操作数污染守卫 + 变异判定器在同一夹具上给不同结论）", async () => {
  // 源码守卫：判定函数里不许出现 ②' 的任何字样。
  const source = decide.toString();
  for (const forbidden of ["sameRange", "repeatedCalls", "repeatedKeys", "readRangeKey", "paging"]) {
    assert.ok(!source.includes(forbidden),
      `decide() 的源码里出现了 ②' 字样 ${forbidden} —— ②' 不许进入判定`);
  }

  // 操作数污染守卫：把 ②' 塞进两侧，结论必须与不塞时逐字相同。
  const plainBase = { totalInputTokens: 10000, read: { rate: 0.5 }, exec: { rate: 0 } };
  const plainCand = { totalInputTokens: 10000, read: { rate: 0.5 }, exec: { rate: 0 } };
  const plain = decide(plainBase, plainCand);
  const polluted = decide(
    { ...plainBase, read: { ...plainBase.read, sameRange: { rate: 1, repeatedCalls: 59 } } },
    { ...plainCand, read: { ...plainCand.read, sameRange: { rate: 0, repeatedCalls: 0 } } },
  );
  assert.deepEqual(polluted, plain);

  // 同一夹具：① 不变、② 不变，只有 ②' 从「全是真浪费」变成「全是分页读」。
  const dir = await makeTmp("erix-596-judge-");
  const baselinePath = await writeTranscript(dir, "baseline.jsonl", [
    legacyRound({
      round: 1,
      inputTokens: 5000,
      toolUses: [readCall("j-1", "src/s.js", { offset: 0 }), readCall("j-2", "src/s.js", { offset: 0 })],
    }),
  ]);
  const candidatePath = await writeTranscript(dir, "candidate.jsonl", [
    legacyRound({
      round: 1,
      inputTokens: 5000,
      toolUses: [readCall("k-1", "src/s.js", { offset: 0 }), readCall("k-2", "src/s.js", { offset: 200 })],
    }),
  ]);
  const baseline = loadSide([baselinePath], "基线");
  const candidate = loadSide([candidatePath], "候选");
  assert.equal(baseline.read.rate, 1); // 同 path 同 range ×2 ⇒ 100% 重复
  assert.equal(candidate.read.rate, 1); // 同 path 不同 range ⇒ ② 仍是 100%（这就是病）
  assert.equal(baseline.read.sameRange.rate, 1);
  assert.equal(candidate.read.sameRange.rate, 0); // ②' 从 100% 掉到 0%

  const decision = decide(baseline, candidate);
  assert.equal(decision.verdict, VERDICT_UNCHANGED,
    `②' 改善不是优化证据（① 未变），实测 ${decision.verdict}`);

  // **反向证**：把判定改成看 ②' 的变异判定器 ⇒ 同一夹具给 improved（该格红）。
  const mutatedVerdict = candidate.read.sameRange.rate < baseline.read.sameRange.rate
    ? VERDICT_IMPROVED
    : VERDICT_UNCHANGED;
  assert.equal(mutatedVerdict, VERDICT_IMPROVED,
    "夹具必须能让「看 ②' 的判定器」给出 improved，否则这一格证明不了任何事");
  assert.notEqual(mutatedVerdict, decision.verdict);
});

// ── E. 报告并列两行 + JSON 带 read.sameRange 与 definitions ──────────────────────

test("#596 E：报告两行并列 + 写死那句说明；--json 带 read.sameRange 与定义行", async () => {
  const dir = await makeTmp("erix-596-report-");
  const path = await writeTranscript(dir, "one.jsonl", [
    legacyRound({
      round: 1,
      inputTokens: 1000,
      toolUses: [
        readCall("r-1", "src/r.js", { offset: 0 }),
        readCall("r-2", "src/r.js", { offset: 0 }),
        readCall("r-3", "src/r.js", { offset: 200 }),
      ],
    }),
  ]);
  const side = loadSide([path], "基线");
  const report = formatReport(side, null, null);
  const lines = report.split("\n");
  // 只认**数值行**（`= 1/2 = 50.0%` / `= n/a（0/0）`）：定义段里也有同名标签，但它后面接的是说明。
  const isReadLine = (line) => /^\s*② 重复读取率（同 path）\s+= (?:\d|n\/a)/u.test(line);
  const isSameRangeLine = (line) => /^\s*②' 真浪费（同 path 同 range）\s+= (?:\d|n\/a)/u.test(line);
  const readIndex = lines.findIndex(isReadLine);
  const sameRangeIndex = lines.findIndex(isSameRangeLine);
  assert.ok(readIndex >= 0 && sameRangeIndex >= 0, "报告里必须同时有 ② 与 ②' 两行");
  assert.ok(readIndex < sameRangeIndex, "② 在前、②' 在后");
  // 两行之间只隔一行（② 的分母/分子明细）⇒ 视觉上是并列的，不是隔着别的指标。
  assert.equal(sameRangeIndex - readIndex, 2, "② 与 ②' 必须紧邻（中间只许有 ② 的明细行）");
  // 写死的两句说明逐字在报告里。
  assert.match(lines[readIndex], /（含分页读，不等于浪费）$/u);
  assert.match(lines[sameRangeIndex], /（\*\*分页读不计入浪费\*\*）$/u);
  // 定义段里也必须有 ②' 的口径（读者不必翻文档）。
  assert.ok(DEFINITIONS.some((line) => line.includes("②' 真浪费（同 path 同 range）")));
  assert.ok(DEFINITIONS.some((line) => line.includes("**分页读（同 path 不同 range）不计入浪费**")));
  for (const line of DEFINITIONS) assert.ok(report.includes(line), `报告里缺少定义行：${line}`);

  const cli = spawnSync(process.execPath, [SCRIPT, "--json", path], {
    cwd: ROOT, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(cli.status, 0, cli.stderr);
  const payload = JSON.parse(cli.stdout);
  const jsonRead = payload.baseline.read;
  assert.equal(jsonRead.calls, 3);
  assert.equal(jsonRead.repeatedCalls, 2);
  // JSON 里同样带 read.sameRange，且七个字段齐全（形状与 read 对齐）。
  assert.deepEqual(Object.keys(jsonRead.sameRange).sort(), [
    "calls", "denominator", "missingKeyCalls", "numerator",
    "rate", "repeatedCalls", "repeatedKeys",
  ]);
  assert.equal(jsonRead.sameRange.calls, 3);
  assert.equal(jsonRead.sameRange.numerator, 1);
  assert.equal(jsonRead.sameRange.denominator, 2);
  assert.equal(jsonRead.sameRange.repeatedCalls, 1);
  assert.deepEqual(jsonRead.sameRange.repeatedKeys, [{ key: "src/r.js@0:null", count: 2 }]);
  // definitions 里带一条说明该口径的行。
  assert.ok(payload.definitions.some((line) => line.includes("②' 真浪费（同 path 同 range）")),
    "JSON 的 definitions 里必须说明 ②' 的口径");
  // 逐 run 明细里也有（`runs[]`）。
  assert.equal(payload.baseline.runs[0].read.sameRange.numerator, 1);

  // 文本模式也跑通（结论不影响退出码）。
  const textRun = spawnSync(process.execPath, [SCRIPT, path], {
    cwd: ROOT, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(textRun.status, 0, textRun.stderr);
  assert.match(textRun.stdout, /②' 真浪费（同 path 同 range） = 1\/2 = 50\.0%/u);
});

// ── F. session 口径：②' 也只在单个 run 内成立 ───────────────────────────────────

test("#596 F：同一侧多个 run 时 ②' 先逐 run 算再累加（不跨 run 去重）", async () => {
  const dir = await makeTmp("erix-596-multi-");
  const first = await writeTranscript(dir, "run-1.jsonl", [
    legacyRound({
      round: 1,
      inputTokens: 1000,
      toolUses: [readCall("m-1", "src/shared.js"), readCall("m-2", "src/shared.js")],
    }),
  ]);
  const second = await writeTranscript(dir, "run-2.jsonl", [
    legacyRound({ round: 1, inputTokens: 2000, toolUses: [readCall("n-1", "src/shared.js")] }),
  ]);
  const side = loadSide([first, second], "候选");
  assert.equal(side.runCount, 2);
  // run-1: 1/1（重读 1 次）；run-2: 0/1（首次）⇒ 合计 1/2、重读 1 次。
  // 若跨 run 合并去重，「shared.js@0:null」会变成 3 次调用 / 1 个键 ⇒ 分子 1、分母 1、重读 2（红）。
  assert.equal(side.read.sameRange.calls, 3);
  assert.equal(side.read.sameRange.numerator, 1);
  assert.equal(side.read.sameRange.denominator, 2);
  assert.equal(side.read.sameRange.rate, 0.5);
  assert.equal(side.read.sameRange.repeatedCalls, 1);
  // ②（同 path）同一条纪律，逐字未变。
  assert.equal(side.read.numerator, 1);
  assert.equal(side.read.denominator, 2);
  assert.equal(side.read.repeatedCalls, 1);

  const single = aggregateSide([side.runs[1]], "单 run");
  assert.equal(single.read.sameRange.rate, 0);
  assert.equal(single.read.sameRange.repeatedCalls, 0);

  // 文本报告的「合计」段也带 ②' 行。
  const report = formatReport(side, null, null);
  assert.match(report, /合计（session 口径：先逐 run 算再累加分子\/分母）/u);
  assert.ok((report.match(/②' 真浪费（同 path 同 range）/gu) ?? []).length >= 3,
    "两个 run 的明细 + 合计段都该有 ②' 行");
});

// ── G. 形状守卫：`analyzeTranscript` 的 read 一定带 sameRange（不是可选字段） ────

test("#596 G：任何账本（含空账本）上 read.sameRange 都在，且 0/0 时 rate 是 null 不是 0", async () => {
  const empty = analyzeTranscript("");
  assert.equal(empty.read.sameRange.calls, 0);
  assert.equal(empty.read.sameRange.denominator, 0);
  assert.equal(empty.read.sameRange.numerator, 0);
  assert.equal(empty.read.sameRange.rate, null, "0/0 必须是 null —— 不许把「没数据」说成「0%」");
  assert.equal(empty.read.sameRange.repeatedCalls, 0);
  assert.deepEqual(empty.read.sameRange.repeatedKeys, []);
  // 缺参调用：不进分母，单独计数（②' 与 ② 同一口径）。
  const missing = analyzeTranscript(
    JSON.stringify(legacyRound({ round: 1, inputTokens: 10, toolUses: [readCall("x-1", undefined)] })),
  );
  assert.equal(missing.read.sameRange.calls, 1);
  assert.equal(missing.read.sameRange.missingKeyCalls, 1);
  assert.equal(missing.read.sameRange.denominator, 0);
  assert.equal(missing.read.sameRange.rate, null);
  assert.equal(missing.read.sameRange.repeatedCalls, 0);
});
