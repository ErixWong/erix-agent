// 金样夹具生成器 + 对撞器（工单 261021「一条消息一落盘」读侧折叠层的真对照）。
//
// 用法：
//   node scripts/message-journal-golden.mjs --check      # 用**当前代码**重算，与已提交夹具比对（日常默认）
//   node scripts/message-journal-golden.mjs --write      # 用**改造前的基线代码**重写夹具（见下方方法论）
//
// ── 方法论（为什么 `--write` 绝不能在改后代码上跑）───────────────────────────────
// 折叠层（`src/store/message-rows.js`）的唯一职责是：让改造后的 `store.load()` 与改造前**逐字一致**。
// 如果夹具是拿改后代码生成、再拿同一份改后代码去比，那是**自己证明自己**——折叠层哪怕把正文
// 折乱了、折丢了，`--check` 也永远是绿的，等于什么都没钉（上一轮就错在这）。
//
// 正确做法（夹具必须由基线代码产出，已在 2ca60bc 上执行并提交了产物）：
//   git worktree add /tmp/base-<sha> 2ca60bc        # 改造前的最后一手
//   cp scripts/message-journal-golden.mjs /tmp/base-<sha>/scripts/
//   cd /tmp/base-<sha> && node scripts/message-journal-golden.mjs --write
//   cp /tmp/base-<sha>/test/fixtures/message-journal-golden.json <本仓库>/test/fixtures/
//   # 回到工作树：
//   node scripts/message-journal-golden.mjs --check  # 改后代码的折叠输出 vs 基线夹具
//
// 「老账本原样透传」不需要另一份夹具：基线代码跑出来的账本天然没有 `kind:"message"` 行，
// 同一份夹具即同时钉住老账本路径（`test/store/message-journal-golden.test.js` 里有守卫断言
// 夹具里不得出现消息行 ⇒ 谁拿改后代码重写了夹具，测试会立刻红，防止方法论再退化）。
//
// 场景是纯 fake provider + memory store，无时钟/网络依赖；比对前统一剥掉墙钟与随机身份
// （见 VOLATILE_KEYS：`ts` / `duration` / `toolCallKey` 等），其余字段全部参与深比较。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { appendUserTurn } from "../src/store/append-user-turn.js";
import { createFakeProvider } from "../test/helpers/fake-provider.js";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures",
  "message-journal-golden.json");

// 每次运行都会漂的键：墙钟、实测耗时、随机分配的工具调用身份键（tc_<6 hex>）。
// 口径与 src/store/transcript-dedup.js 的 PAYLOAD_VOLATILE_FIELDS 同族，另外加引擎实测值。
const VOLATILE_KEYS = new Set([
  "ts", "at", "updatedAt", "elapsedMs", "duration", "durationMs", "tookMs",
  "toolCallKey", "startedAt", "finishedAt",
]);

/** 递归剥掉墙钟/随机身份，并把 dedupKey 里的随机段归一化。 */
export function normalize(value) {
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (VOLATILE_KEYS.has(key)) continue;
    if ((key === "dedupKey" || key === "roundKey") && typeof child === "string") {
      // appendUserTurn 无稳定 messageId 时的 dedupKey 带 Date.now()+uuid：归一化成同一形状
      out[key] = child.replace(/:\d{13}:[0-9a-f-]{36}$/u, ":<volatile>");
      continue;
    }
    out[key] = normalize(child);
  }
  return out;
}

const text = (v) => ({ type: "text", text: v });
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { step: id } });
const toolTurn = (...ids) => ({ content: ids.map((id) => toolUse(id)), stopReason: "tool_use" });
const endTurn = (v) => ({ content: [text(v)], stopReason: "end_turn" });
const judgeJson = (decision) => ({ content: [text(JSON.stringify(decision))], stopReason: "end_turn" });
const judgeNotDone = (reason) => judgeJson({
  done: false, confidence: 0.6, reason, evidence: "本地证据", direction: "on_track",
});
const judgeDone = () => judgeJson({
  done: true, confidence: 0.95, reason: "已达成", evidence: "本地证据", direction: "on_track",
});

const TOOLS = [{ name: "work", replay: "safe", inputSchema: { type: "object" } }];
const BASE = {
  tools: TOOLS,
  completion: false,
  // #498 S3（`run` 片 A13）：顶层 `stallDetection` 已退役，家是 `config.run.stallDetection`
  // （展开相写回 `effectiveOptions.stallDetection`，引擎读侧不变）。本脚本是**观察脚本**：
  // 只改拼写，观察逻辑与金样字节都一字未改（`false` 仍是 `false`）。
  // #498 S3 A18：`wrapup` 同样退役（家 `config.input.wrapup`）——同一个 `config` 容器里并进
  // `input`，观察逻辑与金样字节照旧一字未改。
  config: { input: { wrapup: false }, run: { stallDetection: false } },
  executeTool: async ({ id }) => `done-${id}`,
};

/** 场景 1：单段跑完——并行工具结果、judge nudge、finalGuard revise、终稿。 */
export async function scenarioSingleRun() {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    toolTurn("a1", "a2"),
    endTurn("第二段正文"),
    toolTurn("a3"),
    endTurn("第一版终稿"),
    endTurn("第二版终稿"),
  ]);
  let guardCalls = 0;
  const result = await runToolLoop({
    ...BASE,
    maxRounds: 8,
    store,
    // 并进**同一个** `config` 容器：写第二个 `config` 键会让 BASE 里的 `run.stallDetection` 静默消失。
    // #498 S3 A20: `runId` 也退役了扁平写法（家 `config.run.runId`），同样并进这棵树。
    config: {
      ...BASE.config,
      input: { ...BASE.config.input, initialUserMessage: "金样任务" },
      run: { ...BASE.config.run, runId: "golden-single" },
    },
    provider,
    finalGuard: async () => {
      guardCalls += 1;
      return guardCalls === 1
        ? { action: "revise", message: "请补充证据后再收口" }
        : { action: "accept" };
    },
    reflection: {
      enabled: true,
      roundJudge: true,
      judgeIntercept: false,
      judge: { provider: createFakeProvider([judgeNotDone("还差证据"), judgeDone(), judgeDone()]) },
    },
  });
  return { store, runId: "golden-single", termination: result.termination.reason, rounds: result.rounds };
}

/** 场景 2：崩溃 → 宿主追问 → resume（覆盖 :resume 载体、种子行、快照恢复）。 */
export async function scenarioCrashResume() {
  const store = createMemoryTranscriptStore();
  const runId = "golden-resume";
  const first = createFakeProvider([
    toolTurn("a1"),
    endTurn("第一段正文"),
    toolTurn("a2"),
    { throw: new Error("golden crash after tool a2") },
  ]);
  let thrown = "";
  try {
    await runToolLoop({
      ...BASE, maxRounds: 8, store,
      // #498 S3 A20: `runId` 的家是 `config.run.runId`（与下面的种子并进同一棵树）。
      config: {
        ...BASE.config,
        input: { ...BASE.config.input, initialUserMessage: "金样任务" },
        run: { ...BASE.config.run, runId },
      },
      provider: first,
      reflection: {
        enabled: true, roundJudge: true, judgeIntercept: false,
        judge: { provider: createFakeProvider([judgeNotDone("还没完"), judgeNotDone("还没完"), judgeDone()]) },
      },
    });
  } catch (error) {
    thrown = error?.message ?? String(error);
  }
  await appendUserTurn(store, { key: runId, text: "追问：还剩什么没做？", messageId: "host-followup-1" });
  const resumed = createFakeProvider([toolTurn("a3"), endTurn("恢复后的终稿")]);
  const result = await runToolLoop({
    // #498 S3 A19: `resume` left the top-level allowlist; home `config.run.resume`. This script is an
    // **observation** producer (the golden fixture's generator): only the spelling moves.
    ...BASE, maxRounds: 8, store,
    config: { ...BASE.config, run: { ...BASE.config.run, resume: true, runId } },
    provider: resumed,
    reflection: {
      enabled: true, roundJudge: true, judgeIntercept: false,
      judge: { provider: createFakeProvider([judgeDone()]) },
    },
  });
  return {
    store,
    runId,
    thrown,
    termination: result.termination.reason,
    rounds: result.rounds,
    resumedModelMessages: normalize(resumed.requests.at(-1)?.messages ?? []),
  };
}

const SCENARIOS = [
  { name: "single-run", run: scenarioSingleRun },
  { name: "crash-resume", run: scenarioCrashResume },
];

/** 基线提交：夹具必须在它上面 `--write` 生成（口径见文件头「方法论」）。 */
export const BASELINE_COMMIT = "2ca60bc";

/** issue #404（工单 BB「复活赛告示」）的**豁免**：恢复告示是基线代码**不可能产出**的新事实
 *  （`2ca60bc` 上根本没有这条注入），所以它没法出现在基线夹具里，也不该让「折叠层逐字一致」这条
 *  对照判据变红。这里把它从**捕获侧**逐条剥掉，并把剥掉的条数交回去由测试断言——
 *  多剥一条就等于这条豁免在替别的漂移打掩护，少剥一条说明槽位名变了（两条都会当场红）。
 *
 *  剥三处：账本里的 `…:control:resume-notice:<fp>` 行、它的正文（`messagesFlat` 由 records 派生，
 *  剥行即剥正文）、以及恢复那次请求里的那条消息（`resumedModelMessages`）。
 *  告示自己的行为锚在 `test/loop-resume-notice.test.js`，不靠这份金样。 */
const RESUME_NOTICE_ROW = /:engine:round:\d+:control:resume-notice:/u;
export const RESUME_NOTICE_MARKER = "【恢复运行】";

function isResumeNoticeMessage(message) {
  return message?.meta?.source === "judge-control"
    && (Array.isArray(message?.content) ? message.content : [])
      .some((block) => typeof block?.text === "string" && block.text.includes(RESUME_NOTICE_MARKER));
}

/** @returns {number} 本次真的剥掉了几条（行 + 请求消息各算一条） */
function stripResumeNotice(scenario) {
  let stripped = 0;
  const before = scenario.records.length;
  scenario.records = scenario.records.filter((record) => {
    const key = String(record?.dedupKey ?? record?.roundKey ?? "");
    if (!RESUME_NOTICE_ROW.test(key)) return true;
    stripped += 1;
    return false;
  });
  if (scenario.records.length !== before) scenario.messagesFlat = null; // 由下面重算
  if (scenario.resumedModelMessages !== undefined) {
    const kept = scenario.resumedModelMessages.filter((message) => {
      if (!isResumeNoticeMessage(message)) return true;
      stripped += 1;
      return false;
    });
    scenario.resumedModelMessages = kept;
  }
  return stripped;
}

/** 每次 `capture()` 都会重填：`[{ name, stripped }]` —— 那条豁免剥掉了几条（0 = 该场景没有告示）。
 *  由 `test/store/message-journal-golden.test.js` 断言，防止豁免面悄悄变大。 */
export const resumeNoticeCensus = [];

/**
 * issue #438：轮记录上两个**新增**分账键——`usage`（本轮全部响应累计）与 `engineUsage`（本轮
 * 引擎自发起的调用）。基线 `2ca60bc` 上不可能产出它们（那个版本连 `record.usage` 都没有），
 * 而金样的职责是「折叠层把基线账本读成同一个形状」⇒ 与 #404 的恢复告示同口径：**捕获侧逐条剥掉**，
 * 再用下面的 census 把**豁免面**钉住（哪几条轮记录带了它们、各剥了几个键）。
 * 注意只剥轮记录**顶层**这两个键：`record.response.usage` 是历史形状，一个字都不许动。
 */
const ADDITIVE_USAGE_KEYS = ["usage", "engineUsage"];

/** 引擎轮记录的身份形态（`<runId>:engine:round:<n>`，含 `:seed` / `:control:*` 这些后缀行）。 */
const ENGINE_ROUND_ROW = /:engine:round:\d+(?::|$)/u;

/**
 * 「这条记录看起来像引擎轮记录吗」——剥键的**准入判据**，不是摆设：
 *   · 轮记录一定带 `response`（`record.response` 是它的历史字段），或
 *   · 它的身份键是 `…:engine:round:<n>` 形态。
 * 收紧到这两条的理由（评审退回项）：原来的实现是对**任意**记录无脑 `delete usage`，于是宿主将来
 * 自己写的、**真带 `usage`** 的行（例如 `…:input:<id>` 这类宿主自写行）会被无声吞掉——金样照样绿，
 * 而宿主的账被悄悄改掉了。收紧后那种行会留在捕获结果里，与基线夹具对不上 ⇒ 当场红。
 * 注意只剥轮记录**顶层**这两个键：`record.response.usage` 是历史形状，一个字都不许动。
 */
function looksLikeEngineRoundRecord(record) {
  if (Object.hasOwn(record, "response")) return true;
  const key = String(record?.dedupKey ?? record?.roundKey ?? "");
  return ENGINE_ROUND_ROW.test(key);
}

/**
 * 每次 `capture()` 都会重填：`[{ name, detail: [{ round, keys }] }]` —— **逐条**记下
 * 「哪一轮剥掉了哪几个新增分账键」。只记总数是不够的（评审实测：把 `engineUsage` 从 round 2
 * 挪到 round 3，总数一模一样 ⇒ 照样绿），逐条明细才钉得住**归属**。
 */
export const additiveUsageCensus = [];

/** @returns {Array<{round: number|undefined, keys: string[]}>} 本次真的剥掉了哪些键（逐条） */
function stripAdditiveUsageKeys(scenario) {
  const detail = [];
  for (const record of scenario.records) {
    if (record === null || typeof record !== "object") continue;
    if (!looksLikeEngineRoundRecord(record)) continue;
    const keys = ADDITIVE_USAGE_KEYS.filter((key) => Object.hasOwn(record, key));
    if (keys.length === 0) continue;
    for (const key of keys) delete record[key];
    detail.push({ round: record.round, keys });
  }
  return detail;
}

/** 跑全部场景，产出可提交的夹具对象。 */
export async function capture() {
  resumeNoticeCensus.length = 0;
  additiveUsageCensus.length = 0;
  const scenarios = [];
  for (const scenario of SCENARIOS) {
    const outcome = await scenario.run();
    const records = await outcome.store.load(outcome.runId);
    const entry = {
      name: scenario.name,
      runId: outcome.runId,
      termination: outcome.termination,
      rounds: outcome.rounds,
      ...(outcome.thrown === undefined ? {} : { thrown: outcome.thrown }),
      ...(outcome.resumedModelMessages === undefined
        ? {}
        : { resumedModelMessages: outcome.resumedModelMessages }),
      records: normalize(records),
      // 模型可见正文序列（折叠层的第一判据：这条序列不得因存储改造而改变）
      messagesFlat: null,
    };
    resumeNoticeCensus.push({ name: scenario.name, stripped: stripResumeNotice(entry) });
    additiveUsageCensus.push({ name: scenario.name, detail: stripAdditiveUsageKeys(entry) });
    entry.messagesFlat = normalize(entry.records.flatMap((record) => record.messages ?? []));
    scenarios.push(entry);
  }
  return { generator: "scripts/message-journal-golden.mjs", volatileKeys: [...VOLATILE_KEYS], scenarios };
}

const diffLines = (left, right, path = "$", out = []) => {
  if (left === right) return out;
  const leftType = Array.isArray(left) ? "array" : typeof left;
  const rightType = Array.isArray(right) ? "array" : typeof right;
  if (leftType !== rightType || left === null || right === null) {
    out.push(`${path}: ${JSON.stringify(left)} → ${JSON.stringify(right)}`);
    return out;
  }
  if (leftType === "array") {
    if (left.length !== right.length) {
      out.push(`${path}.length: ${String(left.length)} → ${String(right.length)}`);
    }
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      diffLines(left[index], right[index], `${path}[${String(index)}]`, out);
    }
    return out;
  }
  if (leftType === "object") {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!Object.hasOwn(left, key)) out.push(`${path}.${key}: <missing> → ${JSON.stringify(right[key])}`);
      else if (!Object.hasOwn(right, key)) out.push(`${path}.${key}: ${JSON.stringify(left[key])} → <missing>`);
      else diffLines(left[key], right[key], `${path}.${key}`, out);
    }
    return out;
  }
  out.push(`${path}: ${JSON.stringify(left)} → ${JSON.stringify(right)}`);
  return out;
};

export { diffLines, FIXTURE_PATH as FIXTURE };

/** 读已提交的基线夹具。 */
export async function readFixture() {
  return JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
}

/** 夹具是否出自**改造前的基线代码**：基线不会写 `kind:"message"` 行（写侧尚未落地）。
 * 拿改后代码 `--write` 过的夹具会在这里被抓住，防止「自己证明自己」的退化。 */
export function fixtureHasMessageRows(fixture) {
  return (fixture?.scenarios ?? []).some((scenario) => (scenario.records ?? [])
    .some((record) => record?.kind === "message"));
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!invokedDirectly) {
  // 被测试 import：只导出函数，不跑 CLI。
} else {
const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : "";
if (mode === "") {
  console.log("用法：node scripts/message-journal-golden.mjs --write|--check（--write 必须在基线提交上跑，见文件头）");
} else {
  const captured = await capture();
  if (mode === "write") {
    await mkdir(dirname(FIXTURE_PATH), { recursive: true });
    await writeFile(FIXTURE_PATH, `${JSON.stringify(captured, null, 2)}\n`, "utf8");
    console.log(`金样夹具已写入 ${FIXTURE_PATH}（场景 ${String(captured.scenarios.length)} 个）`);
    for (const scenario of captured.scenarios) {
      console.log(`  · ${scenario.name}: 行数 ${String(scenario.records.length)}`
        + ` 正文条数 ${String(scenario.messagesFlat.length)} termination=${String(scenario.termination)}`);
    }
  } else {
    const committed = await readFixture();
    if (fixtureHasMessageRows(committed)) {
      console.log("金样比对：夹具里出现了 kind:\"message\" 行 ⇒ 夹具不是基线代码产出的，"
        + `请在 ${BASELINE_COMMIT} 上重新 --write（见脚本头「方法论」）`);
      process.exitCode = 1;
    }
    const differences = diffLines(committed, captured, "$");
    if (differences.length === 0) {
      console.log("金样比对：与基线夹具逐字一致 ✅（改前/改后宿主读到的形状相同）");
    } else {
      console.log(`金样比对：${String(differences.length)} 处差异（前 40 条）`);
      for (const line of differences.slice(0, 40)) console.log(`  ${line}`);
      process.exitCode = 1;
    }
  }
}
}
