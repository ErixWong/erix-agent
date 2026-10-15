// erix_run（examples/pi-extension，宿主扩展的 core 层）的**真机 e2e** —— 工单
// docs/tasks/261015-e2e-harness.md 第 3 项（issue #284/#285 收尾，T5）。
// erix_run 此前对「真 run + 真落盘 + 真进度行」是零覆盖：`test/examples/*.test.js` 全离线
// （假上游 / 假 lib），真机冒烟 `erix-run-core.smoke.test.js` 只验「文件被修好 + 载荷字段在场」，
// **没有任何断言看过进度行的耗时、也没有任何断言看过 transcript 里 tool_result 的字段面**。
// 第 1 项那个「进度行静默丢耗时」的缺陷正是在这块空白里活过了 T2 停写。
//
// 用法：ERIX_E2E_REAL=1 node --test examples/pi-extension/erix-run-e2e.test.mjs
// 闸门与配置解析与 examples/tool-fact-e2e.test.mjs、scripts/cli-real-smoke.mjs 共用
// examples/e2e-real-gate.mjs（`ERIX_E2E_REAL=1` 才跑；模型名从配置 slots.default 读，不硬编码；
// 闸门关着 / 无配置 / 无 key / 端点不可达**分别**报 skip 原因）。
//
// 本文件另有一段**始终跑、不联网**的确定性用例（formatLoopEvent 的耗时读法），因为第 1 项的
// 回归断言不该依赖「真模型这次肯不肯调工具」——真机段是补充证据，不是唯一证据。
//
// ---------------------------------------------------------------------------
// 两条已踩过的坑（工单原文，本文件照做）：
// ① **断言查块本体，不要在整段 JSON 上找子串**：模型的 `reasoning`/`text` 会复述工具内容
//    （"erix"、"metadata"、"duration" 这些词都可能出现在正文里），主 agent 这样假红过一次。
//    → 本文件一律先 `JSON.parse` 每行 transcript、再按 content 数组取 `type === "tool_result"` 的块，
//      然后只在这些**块对象**上按键判定；全文子串只在「进度行是否含 ms」这一条上用（那条本来就看文本）。
// ② **`RoundRecord.messages` 只存本轮新增消息**（设计如此，不是缺陷）：要折叠/回放下文必须
//    自己按轮拼完整历史。→ 本文件需要完整历史处（TTL/投影）一律走 `collapseHistory()`，
//      不去猜「最后一条记录里就是全部」。
// ---------------------------------------------------------------------------
// 零依赖红线：只用 node: 内置 + 相对路径；纯 ESM；不写真实 ~/.erix（store/sessionDir 全在 mkdtemp）。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatSkip, printableEndpoint, resolveRealUpstream, TMP_PREFIX } from "../e2e-real-gate.mjs";
import * as core from "./erix-run-core.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 引擎自己会给的终局原因（`docs/host-consumer-contract.md` Termination decision table）。 */
const ENGINE_TERMINATIONS = [
  "end_turn", "judge_done", "no_tool", "stall", "max_rounds_cap", "continuation_exhausted",
  "final_guard_unverified", "aborted", "failed", "persistence_failed",
];

// ---------------------------------------------------------------------------
// 始终跑（不联网、不打模型）：第 1 项修复的**确定性回归**
// ---------------------------------------------------------------------------
//
// 这三条能杀什么：
// - 把耗时读回退役名 `event.toolResult.duration`（= 修复前的形态）→ 第 ① 条当场红；
// - 只读顶层不看 `erix`、或反过来把回退删掉（一代读窗口断掉，0.19 落盘的老事件读不到耗时）→ 第 ②③ 条红；
// - 把 `Number.isFinite` 换成真值判定（`0ms` 被当成「没有耗时」）→ 第 ④ 条红；
// - 把优先级写反（旧顶层盖住新引擎事实）→ 第 ⑤ 条红。

const toolResultEvent = (toolResult) => ({ type: "tool_result", round: 3, toolResult });

test("formatLoopEvent：进度行耗时读 erix.durationMs（工单第 1 项的回归，不联网）", () => {
  // ① 现役形状：只有 erix.durationMs
  const modern = core.formatLoopEvent(toolResultEvent({
    type: "tool_result", tool_use_id: "call_1", content: "结果正文",
    erix: { toolCallKey: "tc_deadbeef", round: 3, durationMs: 4321, success: true },
  }));
  assert.match(modern, /\b4321ms\b/u, `新形状事件的进度行必须带耗时，实际：${modern}`);
  assert.match(modern, /^← 结果正文/u, `进度行正文形态不变，实际：${modern}`);

  // ② 一代读窗口：只有 0.19 及更早的顶层 duration（`erix` 整个缺席）→ 仍必须给耗时
  const legacy = core.formatLoopEvent(toolResultEvent({
    type: "tool_result", tool_use_id: "call_2", content: "旧记录正文",
    duration: 1234, erixRound: 1, success: true, executionStatus: "ok",
  }));
  assert.match(legacy, /\b1234ms\b/u, `只有旧顶层 duration 时必须回退成功（回退没断），实际：${legacy}`);

  // ③ 两个都在时 erix 优先（与 src/display/projection.js、src/loop/tool-result-ttl.js 同口径）
  const both = core.formatLoopEvent(toolResultEvent({
    type: "tool_result", tool_use_id: "call_3", content: "混合",
    duration: 1234, erix: { durationMs: 4321 },
  }));
  assert.match(both, /\b4321ms\b/u, `erix.durationMs 必须压过旧顶层残留，实际：${both}`);
  assert.doesNotMatch(both, /\b1234ms\b/u, `旧值不得盖住新引擎事实，实际：${both}`);

  // ④ 0 是合法耗时（存在性判定，不是真值判定）
  const zero = core.formatLoopEvent(toolResultEvent({
    type: "tool_result", tool_use_id: "call_4", content: "极快", erix: { durationMs: 0 },
  }));
  assert.match(zero, /\b0ms\b/u, `durationMs=0 要如实显示 0ms，实际：${zero}`);

  // ⑤ 两边都没有 = 未知 → 不编一个 0 出来（缺失 ≠ 0，与投影同口径）
  const none = core.formatLoopEvent(toolResultEvent({
    type: "tool_result", tool_use_id: "call_5", content: "未知耗时",
    erix: { toolCallKey: "tc_000000", round: 3 },
  }));
  assert.doesNotMatch(none, /\d+ms/u, `没有耗时事实时不许伪造，实际：${none}`);

  // ⑥ is_error 标记与耗时共存（改了耗时读法不能把 flag 带崩）
  const errored = core.formatLoopEvent(toolResultEvent({
    type: "tool_result", tool_use_id: "call_6", content: "炸了", is_error: true,
    erix: { durationMs: 77 },
  }));
  assert.match(errored, /\b77ms\b/u, `错误结果也要带耗时，实际：${errored}`);
  assert.match(errored, /\[error\]$/u, `is_error 标记仍在行尾，实际：${errored}`);
});

test("erix_run core 的源码不再把退役名当唯一耗时来源（静态守卫，不联网）", async () => {
  const src = await readFileSync(new URL("./erix-run-core.js", import.meta.url), "utf8");
  // 修复前那一行是 `Number.isFinite(event.toolResult?.duration) ? ...`：顶层名是**唯一**来源。
  assert.doesNotMatch(
    src,
    /Number\.isFinite\(\s*event\.toolResult\?\.duration\s*\)/u,
    "进度行不许再只按退役名 event.toolResult.duration 判定耗时（issue #284/#285 T2 停写后它恒 undefined）",
  );
  assert.match(
    src,
    /toolResult\?\.erix\?\.durationMs\s*\?\?\s*event\.toolResult\?\.duration/u,
    "口径必须是「erix 优先、顶层只作旧记录回退」（仓内其余读路径同一写法）",
  );
});

// ---------------------------------------------------------------------------
// 真机段（ERIX_E2E_REAL=1）：一次真 run + 真落盘 + 真进度行
// ---------------------------------------------------------------------------

const NOTES_TEXT = "T5-ERIX-RUN-E2E 标记行：needle-in-a-haystack\n第二行没有关键字\n";
const RUN_TASK = [
  "工作目录里有 notes.md。请严格按顺序做三件事，每件事一次工具调用：",
  "1) 用 readFile 读 notes.md 的全文；",
  "2) 用 exec 运行 `node -p \"6*7\"`；",
  "3) 最后一句话回答：notes.md 里关键字 needle-in-a-haystack 出现了几次，以及上一步算出的数字。",
  "首行写「任务已完成」。",
].join("\n");

/** 把「每条 RoundRecord 只存本轮新增消息」拼回完整历史（坑 ②） */
function collapseHistory(records) {
  const seen = new Set();
  const history = [];
  for (const record of [...records].sort((a, b) => (a?.round ?? 0) - (b?.round ?? 0))) {
    for (const message of record?.messages ?? []) {
      const fingerprint = JSON.stringify(message)?.slice(0, 400);
      if (fingerprint === undefined || seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      history.push(message);
    }
  }
  return history;
}

/** 从消息数组里取指定类型的内容块（坑 ①：断言只打在块本体上） */
function blocksOf(messages, type) {
  return messages
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === type);
}

/** 落盘 tool_result 的合法顶层键集合：由 TOOL_RESULT_CONTRACT 派生，不在这里手抄 */
async function allowedTopLevelKeys() {
  const { TOOL_RESULT_CONTRACT: contract } = await import("../../src/index.js");
  const keys = new Set([...contract.protocol.required, contract.engine.ns, contract.host.ns]);
  if (contract.protocol.conditional?.is_error !== undefined) keys.add("is_error");
  return keys;
}

test("erix_run 真机 e2e：真 run 的终局四件套 + transcript 新形状 + 进度行带耗时", {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const gate = await resolveRealUpstream({ probeTimeoutMs: 8_000 });
  if (!gate.ok) {
    t.skip(`真上游不可用/闸门关：${formatSkip(gate)}`);
    return;
  }

  const dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX.erixRun));
  const sessionDir = path.join(dir, "sessions");
  writeFileSync(path.join(dir, "notes.md"), NOTES_TEXT, "utf8");
  const progressLines = [];
  /** @type {string[]} */ const failures = [];
  const check = (id, fn, detail = "") => {
    try {
      fn();
      console.log(`PASS [3] ${id}${detail ? `  — ${detail}` : ""}`);
    } catch (error) {
      failures.push(id);
      console.log(`FAIL [3] ${id}  — ${error?.message ?? error}${detail ? ` ｜ 现场：${detail}` : ""}`);
    }
  };

  try {
    const payload = await core.runErixRun(
      {
        task: RUN_TASK,
        cwd: dir,
        maxRounds: 6,
        strategy: "sliding-window",
        timeoutMs: 5 * 60 * 1000,
        sessionDir,
      },
      {
        // 库入口指本仓 src/index.js（发版前 ERIX_AGENT_LIB 是必填项），配置指闸门解析出的那份
        env: {
          ...process.env,
          [core.LIB_ENV]: path.join(repoRoot, "src", "index.js"),
          [core.CONFIG_PATH_ENV]: gate.configPath,
        },
        home: homedir(),
        onProgress: (line) => progressLines.push(line),
      },
    );

    console.log(`[3] model=${gate.model} endpoint=${printableEndpoint(gate.endpoint)} `
      + `termination=${JSON.stringify(payload.termination)} rounds=${payload.rounds} `
      + `↑${payload.usage?.input_tokens}/↓${payload.usage?.output_tokens} `
      + `artifacts=${JSON.stringify(payload.artifacts)}`);
    console.log(`[3] 进度行（${progressLines.length} 行）:\n${progressLines.map((l) => `      ${l}`).join("\n")}`);

    // —— 终局四件套的形状未被本系列改动破坏（工单第 3 项第 2 条）——
    check("E1 finalText 是非空字符串", () => {
      assert.equal(typeof payload.finalText, "string");
      assert.ok(payload.finalText.length > 0, "终稿不能为空");
    });
    check("E2 termination.reason 是引擎给的原因（本层不发明）", () => {
      assert.ok(ENGINE_TERMINATIONS.includes(payload.termination?.reason),
        `实际 ${JSON.stringify(payload.termination)}`);
    });
    check("E3 usage 真累计（↑↓ 都 > 0 才说明打了模型）", () => {
      assert.ok(payload.usage?.input_tokens > 0 && payload.usage?.output_tokens > 0,
        JSON.stringify(payload.usage));
    });
    check("E4 verification 在场且是 skipped（本层不开 finalGuard → end_turn 不是交付证明）", () => {
      assert.equal(typeof payload.verification?.status, "string", JSON.stringify(payload.verification));
      assert.equal(payload.verification.status, "skipped",
        "erix_run 不接 finalGuard，承诺恒为 skipped");
    });
    check("E5 ok 严格等于「终局是 end_turn/judge_done」（采纳判据不被粉饰）", () => {
      const adoptable = ["end_turn", "judge_done"].includes(payload.termination.reason);
      assert.equal(payload.ok, adoptable,
        `ok=${payload.ok} termination=${JSON.stringify(payload.termination)}`);
    });
    check("E6 观察者零错误 + 预算元数据到位（装配自查）", () => {
      assert.equal(payload.diagnostics.observerErrors.count, 0,
        JSON.stringify(payload.diagnostics.observerErrors));
      assert.equal(payload.diagnostics.modelMetadataMissing, null);
      assert.equal(payload.diagnostics.model, gate.model,
        "实际模型必须是配置里解析出来的那一个（不硬编码）");
    });

    // —— 落盘面：给了 sessionDir 就必须真有 transcript 与 judge.log（工单第 3 项第 5 条）——
    check("E7 transcript 真落盘且就在 sessionDir 里", () => {
      assert.equal(typeof payload.artifacts.transcriptPath, "string", "给了 sessionDir 就不许报 null");
      assert.ok(payload.artifacts.transcriptPath.startsWith(sessionDir));
      assert.ok(existsSync(payload.artifacts.transcriptPath));
    });
    check("E8 judge.log 真落盘且末行是 run_outcome 汇总（AGENTS.md §6 的承诺，不是「有就查」）", () => {
      assert.equal(typeof payload.artifacts.judgeLogPath, "string", "传了 sessionDir 就必须写出 judge.log");
      assert.ok(existsSync(payload.artifacts.judgeLogPath), `judge.log 不存在：${payload.artifacts.judgeLogPath}`);
      const lines = readFileSync(payload.artifacts.judgeLogPath, "utf8")
        .split("\n").filter((line) => line.trim() !== "");
      assert.ok(lines.length >= 1, "judge.log 不能是空文件");
      const last = JSON.parse(lines.at(-1));
      assert.equal(last.type, "run_outcome", `末行应是 run_outcome 汇总，实际 ${last.type}`);
      // PR #289 断言强度 2：修前是 `last?.termination?.reason ?? payload.termination.reason`——
      // `run_outcome` 行**缺** termination/verification 时会回退到 payload 自己蒙过去（日志里
      // 什么都没写也算绿）。下面一律直接打末行字段：「没写」就是红。
      assert.ok(Object.hasOwn(last, "termination"),
        `run_outcome 末行缺 termination 字段（不许回退到载荷兼过）：实际键=${Object.keys(last).join(",")}`);
      assert.ok(ENGINE_TERMINATIONS.includes(last.termination?.reason),
        `末行 termination.reason 不是引擎给的原因：${JSON.stringify(last.termination)}`);
      assert.equal(last.termination.reason, payload.termination.reason,
        `末行 termination.reason 与载荷不一致：日志=${last.termination.reason} 载荷=${payload.termination.reason}`);
      assert.ok(Object.hasOwn(last, "verification"),
        `run_outcome 末行缺 verification 字段（终局裁决不能只留一半）：实际键=${Object.keys(last).join(",")}`);
      assert.equal(last.verification.status, payload.verification.status,
        `末行 verification.status 与载荷不一致：日志=${last.verification.status} 载荷=${payload.verification.status}`);
      assert.equal(last.verification.status, "skipped",
        "erix_run 不开 finalGuard ⇒ 日志里的 verification 状态也必须是 skipped（与 E4 同口径）");
    });

    // —— transcript 里 tool_result 的字段面（工单第 3 项第 3 条）——
    const records = readFileSync(payload.artifacts.transcriptPath, "utf8")
      .split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    const history = collapseHistory(records);
    const results = blocksOf(history, "tool_result");
    const allowed = await allowedTopLevelKeys();
    check(`E9 transcript 里有 ≥2 个 tool_result（任务要求两次工具）`, () => {
      assert.ok(results.length >= 2, `实际 ${results.length} 个；RoundRecord=${records.length} 条`);
    });
    check("E10 落盘块顶层键集合 ⊆ 契约集合（无退役名、无宿主摊平键）", () => {
      const bad = [];
      for (const block of results) {
        for (const key of Object.keys(block)) {
          if (!allowed.has(key)) bad.push(`${block.tool_use_id}:${key}`);
        }
      }
      assert.deepEqual(bad, [], `顶层多出来的键：${bad.join(",")}`);
    });
    check("E11 erix 事实齐（toolCallKey/round/durationMs/success）且耗时至少一个 > 0", () => {
      const durations = results.map((block) => block?.erix?.durationMs);
      for (const block of results) {
        assert.equal(typeof block?.erix?.toolCallKey, "string", `${block?.tool_use_id} 缺 toolCallKey`);
        assert.ok(block.erix.toolCallKey.startsWith("tc_"), `前缀不对：${block.erix.toolCallKey}`);
        assert.ok(Number.isFinite(block?.erix?.round), `round 非有限：${block?.erix?.round}`);
        assert.ok(Number.isFinite(block?.erix?.durationMs) && block.erix.durationMs >= 0,
          `durationMs 非有限/为负：${block?.erix?.durationMs}`);
        assert.equal(typeof block?.erix?.success, "boolean", `success 非布尔：${block?.erix?.success}`);
      }
      assert.ok(durations.some((d) => d > 0), `真执行必须有非 0 耗时：${JSON.stringify(durations)}`);
    });

    // —— 进度行的耗时没静默消失（第 1 项在**真事件流**上的证据）——
    const toolResultLines = progressLines.filter((line) => line.startsWith("← "));
    check("E12 真进度行里 tool_result 行带 <n>ms（修复前这里恒缺失）", () => {
      assert.ok(toolResultLines.length >= 2, `tool_result 进度行只有 ${toolResultLines.length} 行`);
      const withMs = toolResultLines.filter((line) => /\b\d+ms\b/u.test(line));
      assert.equal(withMs.length, toolResultLines.length,
        `带耗时的行 ${withMs.length}/${toolResultLines.length}：${toolResultLines.join(" | ")}`);
    });

    // —— 交付物判据：模型真读到过内容（不是只「调了工具」）——
    check("E13 transcript 里留有两次工具的真实足迹（readFile 的正文 + exec 的 42）", () => {
      const text = results.map((block) => String(block?.content ?? "")).join("\n");
      assert.match(text, /needle-in-a-haystack/u, "readFile 的正文应在结果里");
      assert.match(text, /\b42\b/u, "exec `node -p 6*7` 的输出应在结果里");
    });

    assert.deepEqual(failures, [], `真机段失败的断言：${failures.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #314 R1：显式开启 finalGuard ⇒ `verification` 不再是 `skipped`（**加法**用例）。
// 上面 E4 那条（默认关 ⇒ 恒 `skipped`）原样保留，两条一起才说明「开关真的在开关」。
// 只在真上游可用时跑；闸门关着 / 没配置 / 端点不可达一律 skip（不红）。
// ---------------------------------------------------------------------------

test("erix_run 真机：显式 finalGuard:true ⇒ verification 不再是 skipped，成本进 diagnostics", {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const gate = await resolveRealUpstream({ probeTimeoutMs: 8_000 });
  if (!gate.ok) {
    t.skip(`真上游不可用/闸门关：${formatSkip(gate)}`);
    return;
  }

  const dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX.erixRun));
  const progressLines = [];
  try {
    // 让内层「取一个只有本次 run 才有的值」当基点：exec 的时间戳必然出现在本次 tool_result 里，
    // 于是谓词的硬闸有机会过；过不了也只会是 unverified，**不可能**是 skipped。
    const payload = await core.runErixRun(
      {
        task: "用 exec 跑一次 `node -p process.pid`，把打印出来的数字**逐字**当成本次结论的基点。"
          + "终稿必须依次写四段：## 取证边界 / ## 基点 / ## 结论 / ## 未验证（段名逐字照抄），"
          + "「## 基点」里只写那个数字，「## 结论」里给一条带「文件:行」的结论。",
        cwd: dir,
        maxRounds: 5,
        timeoutMs: 4 * 60 * 1000,
        finalGuard: true,
      },
      {
        env: {
          ...process.env,
          [core.LIB_ENV]: path.join(repoRoot, "src", "index.js"),
          [core.CONFIG_PATH_ENV]: gate.configPath,
        },
        home: homedir(),
        onProgress: (line) => progressLines.push(line),
      },
    );

    console.log(`[314] termination=${JSON.stringify(payload.termination)} `
      + `verification=${JSON.stringify(payload.verification)} `
      + `finalGuard=${JSON.stringify(payload.diagnostics?.finalGuard)}`);

    assert.notEqual(payload.verification?.status, "skipped",
      `开了 finalGuard 还恒 skipped ⇒ 透传断了：${JSON.stringify(payload.verification)}`);
    assert.ok(["verified", "unverified", "error"].includes(payload.verification?.status),
      `状态必须是 guard 真裁出来的三态之一：${JSON.stringify(payload.verification)}`);
    // 成本必须看得见（R3）：宿主计数 + 引擎 guardMetrics 两份都在，且各带来源
    const guard = payload.diagnostics?.finalGuard;
    assert.equal(guard?.enabled, true, JSON.stringify(guard));
    assert.ok((guard?.calls ?? 0) >= 1, `guard 一次也没被叫到：${JSON.stringify(guard)}`);
    assert.ok(typeof guard?.elapsedMs === "number", JSON.stringify(guard));
    assert.match(guard.source, /erix-run-final-guard\.js/u, JSON.stringify(guard));
    assert.ok(payload.verification.metrics, "引擎侧 guardMetrics 也该在（口径不同，两份都留）");
    // 终局面里要读得到这一行（默认关时那一行是 disabled）
    assert.match(core.formatPayloadForModel(payload), /finalGuard calls=\d+/u);
    assert.match(progressLines.join("\n"), /finalGuard=on/u, "启动行要把余量与等待上限说出来");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
