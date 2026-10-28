#!/usr/bin/env node
// final-guard-probe.mjs — `finalGuard` 的**能力探针**（issue #386 切片 1）。
//
// 为什么需要它：`finalGuard` 是引擎里唯一**有牙**的复核（宿主回调能改写终局），所以「它到底
// 拿得到什么事实、它真能抓住假完成吗、它失效时终局长什么样」必须是可复现的实测，而不是注释里的
// 声称。本脚本把这件事做成**离线、零 LLM 成本、逐字节可复现**的一组断言：
//   · provider 是 `test/helpers/fake-provider.js` 的脚本化假 provider（不打任何真实模型）；
//   · 交付物是真的写在临时目录里的文件（`os.tmpdir()`，跑完删掉），所以「文件在不在」是磁盘事实；
//   · **每个场景都断言语义**，不是只打印。任一场景的语义变了（payload 少一个键、假完成抓不住、
//     revise 耗尽不再 fail-closed、guard 抛错/超时被当成 verified、橡皮章 guard 又能蒙过、
//     声明了交付物判据却仍被橡皮章蒙过（issue #386 切片 2 的机器闸门）、新键体积超过 messages 的 2%、
//     预算类停机上的补跑桥失效或默认关时悄悄改行为（issue #386 切片 3 的 E4a/E4b 双格）、
//     guard `skip` 又把机器证据整包丢掉（issue #392 的 S6c/S6d 双格：skip + 判据全通过 ⇒
//     `verified:machine_only`，skip + 判据有失败 ⇒ `unverified:deliverables_failed`））
//     ⇒ 退出码非零。
//
// 用法：
//   node scripts/final-guard-probe.mjs            # 人读版（每个场景一行结论 + payload 逐键字节）
//   node scripts/final-guard-probe.mjs --json     # 机器读版：results JSON 到 stdout（日志走 stderr）
//
// 结果**不入库**（不写任何 results.json）：本脚本每次运行都是同一批断言，产物只有退出码；
// 与 `notes-experiment-results.json` 那种「一次性实验的原始数据要留档」不同——这里的「数据」
// 是断言的输入，判据（断言本身）已经在脚本里，落盘一份快照只会多一份会腐烂的副本。
// 详见 CHANGELOG / 报告的说明。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { pendingTrailingToolUses, validateMessages } from "../src/messages/rounds.js";
import { createFakeProvider } from "../test/helpers/fake-provider.js";

const JSON_OUT = process.argv.includes("--json");
const log = (...args) => { if (JSON_OUT) console.error(...args); else console.log(...args); };

// ── 既有契约的 7 个键（issue #386 之前就是这样，逐字不许变）──────────────────────────
const LEGACY_PAYLOAD_KEYS = [
  "finalText",
  "findings",
  "messages",
  "round",
  "rounds",
  "signal",
  "termination",
];
// ── issue #386 的加法键（含只在截断时出现的标记键）─────────────────────────────────
const ADDITIVE_PAYLOAD_KEYS = [
  "cwd",
  "runId",
  "filesWritten",
  "filesWrittenTruncated",
  "fileWrites",
  "fileWritesTruncated",
  "toolStats",
  "toolStatsTruncated",
  "taskBrief",
  "taskBriefTruncated",
  "selfReport",
  "selfReportSummaryTruncated",
  "selfReportOutputTruncated",
  "usage",
  "elapsedMs",
  "attempt",
  "guardBudget",
];
// 「引擎一定探得到」的那一批：任何一次 guard 调用都必须带（不在场就不是纯加法）。
const ALWAYS_PRESENT = ["filesWritten", "toolStats", "usage", "elapsedMs", "attempt", "guardBudget"];

const results = [];
const failures = [];
let currentCase = "";

/** 断言入口：场景名 + 判据 + 人话理由。失败不中断（一次跑完看得更全），最后统一非零退出。 */
function expect(ok, message) {
  if (!ok) failures.push(`${currentCase} — ${message}`);
  return ok;
}

/** 记录一个场景的结果（`measurements` 全是可复现的实测值，进 `--json` 与报告）。 */
function record(measurements) {
  results.push({ case: currentCase, ok: !failures.some((f) => f.startsWith(`${currentCase} — `)), ...measurements });
}

// ── 脚本化的 provider 片段 ────────────────────────────────────────────────────────
const text = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
const wrapup = (object, usage) => ({
  content: [{ type: "text", text: JSON.stringify(object) }],
  stopReason: "end_turn",
  ...(usage === undefined ? {} : { usage }),
});
const toolUse = (id, name, input) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "erix-final-guard-probe-"));
const answerPath = path.join(sandbox, "answer.txt");
const resetSandbox = () => fs.rmSync(answerPath, { force: true });

/**
 * 真实世界的宿主验收器：不看模型说什么，只看磁盘上有没有交付物。
 * 这是本探针的「独立事实」基准——它存在的意义就是证明 `finalText` 不能当判据。
 */
const diskVerifier = async () => {
  if (!fs.existsSync(answerPath)) {
    return { action: "revise", message: "验收失败：answer.txt 不存在，请真正写入后再收尾" };
  }
  const got = fs.readFileSync(answerPath, "utf8").trim();
  if (got !== "42") {
    return { action: "revise", message: `验收失败：answer.txt 内容是 ${got}，期望 42` };
  }
  return { action: "accept" };
};

try {
  // ── S1 payload 面：宿主验收器实际拿到什么 ───────────────────────────────────────
  {
    currentCase = "S1 payload 面（键名 / 每键字节 / 9 项需求命中）";
    resetSandbox();
    let payload;
    const result = await runToolLoop({
      provider: createFakeProvider([
        toolUse("w1", "writeFile", { path: answerPath, content: "42" }),
        wrapup(
          { done: true, summary: "已写入", output: "answer.txt 内容是 42", findings: { answer: "42" } },
          { input_tokens: 120, output_tokens: 30 },
        ),
      ]),
      // #498 S3 (`guard` slice): the budget lives at its canonical home `config.guard.finalGuardMaxRetries`
      // (the flat spelling is rejected at the name gate; the expansion phase writes it back).
      // #498 S3 (`metadata` A9): the flat `task` is retired at the name gate; its canonical home is
      // `config.metadata.task`, and the expansion phase writes it back onto `effectiveOptions.task`.
      config: {
        input: { initialUserMessage: `把 42 写进 ${answerPath}` },
        guard: { finalGuardMaxRetries: 2 },
        metadata: { task: `把 42 写进 ${answerPath}` },
      },
      cwd: sandbox,
      runId: "probe-run-1",
      maxRounds: 4,
      executeTool: async (call) => {
        fs.writeFileSync(call.input.path, call.input.content);
        return `wrote ${call.input.path}`;
      },
      finalGuard: async (value) => {
        payload = value;
        return { action: "accept" };
      },
    });

    const keys = Object.keys(payload);
    const perKeyBytes = Object.fromEntries(keys.map((key) => [key, jsonBytes(payload[key])]));

    // 既有 7 键：名字、顺序、类型、取值逐字不变。
    expect(
      JSON.stringify(keys.slice(0, LEGACY_PAYLOAD_KEYS.length)) === JSON.stringify(LEGACY_PAYLOAD_KEYS),
      `payload 前 ${LEGACY_PAYLOAD_KEYS.length} 个键不再是 ${LEGACY_PAYLOAD_KEYS.join(",")}（实际 ${keys.slice(0, 7).join(",")}）`,
    );
    expect(payload.finalText === "answer.txt 内容是 42", "payload.finalText 不是终稿");
    expect(payload.round === payload.rounds, "payload.round / rounds 不再相等");
    expect(payload.termination?.reason === "end_turn", "payload.termination.reason 不是 end_turn");
    expect(Array.isArray(payload.messages) && payload.messages.length > 0, "payload.messages 不是非空数组");
    // 既有 7 键里的 `signal` 是引擎内部的 tool AbortSignal（既有契约，一直如此）。
    expect(
      payload.signal !== undefined && typeof payload.signal?.aborted === "boolean",
      `payload.signal 不再是 AbortSignal（实测 ${typeof payload.signal}）`,
    );
    expect(
      payload.findings?.answer === "42",
      "payload.findings 丢了信封里声明的 label→value",
    );

    // 未知键：payload 只许由「既有 7 键 + 已登记加法键」组成。
    const known = new Set([...LEGACY_PAYLOAD_KEYS, ...ADDITIVE_PAYLOAD_KEYS]);
    const unknown = keys.filter((key) => !known.has(key));
    expect(unknown.length === 0, `payload 出现未登记的键：${unknown.join(",")}`);
    for (const key of ALWAYS_PRESENT) {
      expect(keys.includes(key), `payload 缺了引擎一定探得到的加法键 ${key}`);
    }

    // 9 项需求逐个命中（这就是本切片要解决的「验收要用的事实一项都没有」）。
    // ⚠ `filesWritten[].path` 是 **judge timeline 的摘要参数**（`summarizeArgument`），
    // 被 `MAX_COMMAND_LENGTH = 40` 截断且**不带截断标记**——所以这里只断「是本 run 写入的
    // 那条路径的前缀 + 轮号」，不断全路径相等。这条限制在 S7 里单独钉住。
    const needs = {
      cwd: payload.cwd === sandbox,
      runId: payload.runId === "probe-run-1",
      filesWritten: Array.isArray(payload.filesWritten)
        && payload.filesWritten.length === 1
        && answerPath.startsWith(payload.filesWritten[0].path)
        && payload.filesWritten[0].round === 1,
      toolStats: payload.toolStats?.writeFile?.calls === 1
        && payload.toolStats?.writeFile?.failures === 0
        && Object.getPrototypeOf(payload.toolStats) === Object.prototype,
      taskBrief: payload.taskBrief === `把 42 写进 ${answerPath}`,
      selfReport: payload.selfReport?.done === true
        && payload.selfReport?.output === "answer.txt 内容是 42"
        && payload.selfReport?.findings?.answer === "42",
      usage: payload.usage?.input_tokens === 120 && payload.usage?.output_tokens === 30,
      elapsedMs: Number.isFinite(payload.elapsedMs) && payload.elapsedMs >= 0,
      guardAttempt: payload.attempt === 1 && payload.guardBudget === 2,
    };
    for (const [name, hit] of Object.entries(needs)) {
      expect(hit, `需求项 ${name} 没命中（实测 ${JSON.stringify(payload[name === "guardAttempt" ? "attempt" : name])}）`);
    }

    // JSON-safe：宿主第一件事就是 `JSON.stringify(payload)` 落盘/发队列。
    let roundTrip;
    try {
      roundTrip = JSON.parse(JSON.stringify(payload));
    } catch (error) {
      roundTrip = null;
      expect(false, `payload 不能 JSON 序列化：${error?.message ?? error}`);
    }
    expect(roundTrip?.toolStats?.writeFile?.calls === 1, "JSON 往返后 toolStats 丢了真实计数（Map 没转 plain object）");
    expect(roundTrip?.selfReport?.findings?.answer === "42", "JSON 往返后 selfReport.findings 丢了");
    expect(result.verification?.status === "verified", "guard accept 之后 verification 不是 verified");

    record({
      payload_keys: keys.join(","),
      per_key_bytes: perKeyBytes,
      payload_bytes: jsonBytes(payload),
      needs_hit: `${Object.values(needs).filter(Boolean).length}/${Object.keys(needs).length}`,
    });
    log(`\n── ${currentCase}`);
    log(`   payload 键（${keys.length}）: ${keys.join(",")}`);
    log(`   逐键字节: ${JSON.stringify(perKeyBytes)}`);
    log(`   9 项需求命中: ${Object.values(needs).filter(Boolean).length}/9`);
  }

  // ── S2 假完成 → revise → 补救（guard 真能救回来）────────────────────────────────
  {
    currentCase = "S2 假完成被抓住 → revise → 补救";
    resetSandbox();
    const attempts = [];
    const provider = createFakeProvider([
      // 撒谎：声称写好了，但磁盘上什么都没有。
      wrapup({ done: true, summary: "已完成", output: `已生成 ${answerPath}，内容为 42` }),
      toolUse("w2", "writeFile", { path: answerPath, content: "42" }),
      wrapup({ done: true, summary: "已写入", output: "完成" }),
    ]);
    const result = await runToolLoop({
      provider,
      config: { input: { initialUserMessage: `把 42 写进 ${answerPath}` } },
      maxRounds: 6,
      executeTool: async (call) => {
        fs.writeFileSync(call.input.path, call.input.content);
        return "ok";
      },
      finalGuard: async (payload) => {
        attempts.push({ attempt: payload.attempt, round: payload.round, files: payload.filesWritten?.length ?? 0 });
        return diskVerifier(payload);
      },
    });

    expect(attempts.length === 2, `guard 应被调用 2 次（撒谎 1 次 + 补救后 1 次），实际 ${attempts.length}`);
    expect(
      JSON.stringify(attempts.map((entry) => entry.attempt)) === JSON.stringify([1, 2]),
      `attempt 必须 1→2 单调递增，实际 ${JSON.stringify(attempts.map((entry) => entry.attempt))}`,
    );
    expect(
      attempts[0].files === 0,
      `第一次 guard 调用时 filesWritten 应为空（模型什么都没写），实际 ${attempts[0].files} 条`,
    );
    expect(
      attempts[1].files >= 1,
      `补救之后 filesWritten 必须能看见交付物，实际 ${attempts[1].files} 条`,
    );
    expect(fs.existsSync(answerPath), "补救之后 answer.txt 仍不存在（revise 没把模型拉回来）");
    expect(result.verification?.status === "verified", `补救之后 verification 应为 verified，实际 ${result.verification?.status}`);
    expect(result.termination?.reason === "end_turn", `终局应为 end_turn，实际 ${result.termination?.reason}`);
    expect(result.verification?.metrics?.revised === 1, "verification.metrics.revised 应记 1 次 revise");

    // revise 文本确实递给了模型（不是被吞掉）。
    const lastUserText = (provider.requests.at(-1)?.messages ?? [])
      .filter((message) => message.role === "user")
      .map((message) => (Array.isArray(message.content)
        ? message.content.map((block) => block.text ?? "").join("")
        : String(message.content)))
      .join("\n");
    expect(lastUserText.includes("answer.txt 不存在"), "revise 的 message 没有出现在模型看到的上下文里");

    record({
      guard_calls: attempts.length,
      attempts: JSON.stringify(attempts),
      rounds: result.rounds,
      file_exists_after: String(fs.existsSync(answerPath)),
      termination: JSON.stringify(result.termination),
      verification: JSON.stringify(result.verification),
    });
    log(`\n── ${currentCase}`);
    log(`   guard 调用 ${attempts.length} 次，attempt=${JSON.stringify(attempts.map((a) => a.attempt))}，`
      + `filesWritten=${JSON.stringify(attempts.map((a) => a.files))}，补救后文件存在=${fs.existsSync(answerPath)}`);
  }

  // ── S3 revise 耗尽：模型死不悔改 ⇒ fail-closed ──────────────────────────────────
  {
    currentCase = "S3 revise 耗尽（fail-closed 到 final_guard_unverified）";
    resetSandbox();
    const attempts = [];
    const budgets = [];
    const result = await runToolLoop({
      provider: createFakeProvider([
        wrapup({ done: true, summary: "完成", output: "已经写好了" }),
        { times: 6, ...wrapup({ done: true, summary: "完成", output: "确实写好了" }) },
      ]),
      config: { input: { initialUserMessage: "写文件" }, guard: { finalGuardMaxRetries: 2 } },
      maxRounds: 8,
      executeTool: async () => "ok",
      finalGuard: async (payload) => {
        attempts.push(payload.attempt);
        budgets.push(payload.guardBudget);
        return { action: "revise", message: "answer.txt 不存在" };
      },
    });

    expect(
      JSON.stringify(attempts) === JSON.stringify([1, 2, 3]),
      `finalGuardMaxRetries=2 ⇒ guard 恰好 3 次且 attempt 为 1,2,3，实际 ${JSON.stringify(attempts)}`,
    );
    expect(
      budgets.every((value) => value === 2),
      `guardBudget 必须恒等于 finalGuardMaxRetries(2)，实际 ${JSON.stringify(budgets)}`,
    );
    expect(
      result.termination?.reason === "final_guard_unverified",
      `revise 耗尽后终局必须是 final_guard_unverified，实际 ${result.termination?.reason}`,
    );
    expect(
      result.verification?.status === "unverified" && result.verification?.reason === "max_retries",
      `verification 应为 unverified/max_retries，实际 ${JSON.stringify(result.verification)}`,
    );
    expect(result.finalText === "确实写好了", "fail-closed 之后 finalText 被改写了（不许改写终稿）");

    record({
      guard_calls: attempts.length,
      attempts: JSON.stringify(attempts),
      guard_budget: JSON.stringify(budgets),
      rounds: result.rounds,
      termination: JSON.stringify(result.termination),
      verification: JSON.stringify(result.verification),
    });
    log(`\n── ${currentCase}`);
    log(`   guard ${attempts.length} 次 attempt=${JSON.stringify(attempts)} ⇒ `
      + `${result.termination?.reason} / ${result.verification?.status}:${result.verification?.reason}`);
  }

  // ── S4 guard 抛错 / S5 guard 超时：对可用性 fail-open，但绝不 verified ───────────
  for (const [label, guard, expectedReason] of [
    ["S4 guard 抛错（宿主验收器崩了）", async () => { throw new Error("verifier crashed"); }, "error"],
    ["S5 guard 超时（验收器卡住）", async () => {
      await new Promise((resolve) => { setTimeout(resolve, 500); });
      return { action: "accept" };
    }, "timeout"],
  ]) {
    currentCase = label;
    resetSandbox();
    const payloads = [];
    const result = await runToolLoop({
      provider: createFakeProvider([wrapup({ done: true, summary: "s", output: "o" })]),
      config: { input: { initialUserMessage: "x" }, guard: { finalGuardTimeoutMs: 100 } },
      maxRounds: 2,
      executeTool: async () => "ok",
      finalGuard: async (payload) => {
        payloads.push({ attempt: payload.attempt, keys: Object.keys(payload).length });
        return guard(payload);
      },
    });

    expect(payloads.length === 1, `guard 应被调用 1 次，实际 ${payloads.length}`);
    expect(payloads[0]?.attempt === 1, `attempt 应为 1，实际 ${payloads[0]?.attempt}`);
    expect(
      result.verification?.status === "error" && result.verification?.reason === expectedReason,
      `verification 应为 error/${expectedReason}，实际 ${JSON.stringify(result.verification)}`,
    );
    expect(result.termination?.reason === "end_turn", `终局 reason 应被保留为 end_turn，实际 ${result.termination?.reason}`);
    expect(result.verification?.status !== "verified", "guard 崩了/超时却报了 verified（fail-open 被写成了认证）");

    record({
      guard_calls: payloads.length,
      termination: JSON.stringify(result.termination),
      verification: JSON.stringify(result.verification),
      payload_keys: payloads[0]?.keys,
    });
    log(`\n── ${currentCase}`);
    log(`   ${result.termination?.reason} / ${result.verification?.status}:${result.verification?.reason}`
      + `（payload 键 ${payloads[0]?.keys} 个）`);
  }

  // ── S6 天真 guard 橡皮章（**四格**：issue #386 切片 2 的 S6a/S6b + issue #392 的 S6c/S6d）──
  // 同一个天真 guard 家族（只看 finalText 有没有字）、同一份撒谎输入、同一份磁盘事实，
  // 变量只有两个：宿主有没有声明 `deliverables`、以及 guard 给的是 `accept` 还是 `skip`：
  //   S6a 未声明 ⇒ 仍然 verified（证明闸门是**纯加法**：不声明就一个字都不改）；
  //   S6b 声明了 + accept ⇒ 必须 unverified:deliverables_failed（**机器闸门**真的压过 guard 意见）；
  //   S6c 声明了 + **skip** + 判据全通过 ⇒ 必须 verified:machine_only（#392 的现场：今天这一格是
  //       `skipped`，于是真上游「文件真在盘上」的 run 退出码是 4）；
  //   S6d 声明了 + **skip** + 判据有失败 ⇒ 必须 unverified:deliverables_failed（状态不许再说「没验」）。
  // 四格合起来才是完整证据：单看 S6b 无法排除「顺手把 accept 改严了」，单看 S6a 无法证明闸门有效，
  // 单看 S6c 无法排除「skip 一律当通过」，单看 S6d 无法排除「skip 一律当失败」。
  for (const cell of [
    {
      case: "S6a 天真 guard（只看 finalText 非空）+ 未声明 deliverables = 仍是橡皮章（纯加法）",
      deliverables: undefined,
      guardDecision: { action: "accept" },
      expectedStatus: "verified",
      expectedReason: undefined,
    },
    {
      case: "S6b 天真 guard + 声明了 deliverables（文件不存在）= 被机器闸门拦住",
      deliverables: [{ name: "answer-file", check: () => fs.existsSync(answerPath) }],
      guardDecision: { action: "accept" },
      expectedStatus: "unverified",
      expectedReason: "deliverables_failed",
    },
    {
      // issue #392：天真 guard 这次**放弃**（`skip` = 「我验不了」，不是「交付物没交付」），
      // 但判据是磁盘事实且真的过了 ⇒ 机器证据本身构成验收，且必须标成 machine_only。
      case: "S6c 天真 guard 判 skip + 声明了 deliverables（文件真在盘上）= verified:machine_only",
      deliverables: [{
        name: "answer-file",
        check: () => fs.existsSync(answerPath)
          && fs.readFileSync(answerPath, "utf8").trim() === "42",
      }],
      guardDecision: { action: "skip", reason: "no_capture_evidence" },
      writeAnswer: true,
      expectedStatus: "verified",
      expectedReason: "machine_only",
      expectedMachineOnly: true,
    },
    {
      // 同一格的反面：skip + 判据**没过** ⇒ 状态必须说「没过」，不许留在「没验」。
      case: "S6d 天真 guard 判 skip + 声明了 deliverables（文件不存在）= unverified:deliverables_failed",
      deliverables: [{ name: "answer-file", check: () => fs.existsSync(answerPath) }],
      guardDecision: { action: "skip", reason: "no_capture_evidence" },
      expectedStatus: "unverified",
      expectedReason: "deliverables_failed",
    },
  ]) {
    currentCase = cell.case;
    resetSandbox();
    let payload;
    const events = [];
    const result = await runToolLoop({
      provider: createFakeProvider([
        // `writeAnswer` 的格先真写一次盘（判据要的是磁盘事实，不是模型的自报）。
        ...(cell.writeAnswer
          ? [toolUse("w-s6c", "writeFile", { path: answerPath, content: "42" })]
          : []),
        wrapup({ done: true, summary: "完成", output: `已生成 ${answerPath}，内容为 42` }),
      ]),
      config: { input: { initialUserMessage: "写文件" } },
      cwd: sandbox,
      maxRounds: 3,
      executeTool: async (call) => {
        if (call.name === "writeFile") fs.writeFileSync(call.input.path, call.input.content ?? "");
        return "ok";
      },
      ...(cell.deliverables === undefined ? {} : { deliverables: cell.deliverables }),
      finalGuard: async (value) => {
        payload = value;
        // 天真 guard 的**裁决**由格指定：它自己不看磁盘，只看终稿有没有字。
        if (cell.guardDecision.action === "skip") return { ...cell.guardDecision };
        return String(value.finalText).length > 0
          ? { action: "accept" }
          : { action: "revise", message: "空" };
      },
      onEvent: (event) => events.push(event),
    });

    expect(
      fs.existsSync(answerPath) === (cell.writeAnswer === true),
      `本场景的磁盘前提不成立（answerPath 存在=${fs.existsSync(answerPath)}）`,
    );
    expect(
      result.finalText.includes("已生成"),
      "终稿不再是模型的自报文本（对照失去意义）",
    );
    expect(
      result.verification?.status === cell.expectedStatus,
      `verification 应为 ${cell.expectedStatus}，实际 ${result.verification?.status}`
        + (cell.expectedReason === undefined ? "" : `（reason 应为 ${cell.expectedReason}）`),
    );
    // 闸门只改 verification，不改 termination.reason。
    expect(
      result.termination?.reason === "end_turn",
      `闸门不许改写 termination.reason，实际 ${result.termination?.reason}`,
    );
    if (cell.expectedReason !== undefined) {
      expect(
        result.verification?.reason === cell.expectedReason,
        `verification.reason 应为 ${cell.expectedReason}，实际 ${result.verification?.reason}`,
      );
      expect(
        payload?.deliverablesAllPassed === (cell.expectedMachineOnly === true),
        `payload.deliverablesAllPassed 与磁盘事实不符，实际 ${payload?.deliverablesAllPassed}`,
      );
      if (cell.expectedMachineOnly === true) {
        // machine_only 是「引擎用宿主判据验收」的**唯一**凭据：计数键 + 事件字段各一处。
        expect(
          result.verification?.metrics?.deliverables_machine_only === 1,
          `metrics.deliverables_machine_only 应为 1，实际 ${result.verification?.metrics?.deliverables_machine_only}`,
        );
        expect(
          result.verification?.metrics?.verified === 0,
          "guard 没有 accept，`verified` 计数（数的是 guard 裁决）不该涨",
        );
        const guardEvents = events.filter((event) => event.type === "final_guard");
        expect(
          guardEvents.length === 1 && guardEvents[0].machine_only === true
            && guardEvents[0].action === "skip",
          `事件应是 action:"skip" + machine_only:true，实际 ${JSON.stringify(guardEvents)}`,
        );
      } else {
        expect(
          !("deliverables_machine_only" in (result.verification?.metrics ?? {})),
          "machine_only 的计数漏进了不该出现的格",
        );
      }
      expect(
        result.verification?.metrics?.deliverables_failed
          === (cell.expectedStatus === "unverified" ? 1 : 0),
        `metrics.deliverables_failed 与结论不符，实际 ${result.verification?.metrics?.deliverables_failed}`,
      );
      // 机器说「没过」时，状态不许再说「没验」。
      expect(
        result.verification?.reason !== "no_capture_evidence",
        "reason 仍是 skip 串（状态说「没验」，而机器其实说了「没过」）",
      );
    } else {
      expect(
        !("deliverables" in (payload ?? {})),
        "未声明 deliverables 却往 payload 里塞了 deliverables 键（不是纯加法）",
      );
      expect(
        result.verification?.metrics?.deliverables_checked === undefined,
        "未声明 deliverables 却往 metrics 里塞了 deliverables_* 键（不是纯加法）",
      );
    }

    record({
      guard_action: cell.guardDecision.action,
      deliverables_declared: String(cell.deliverables !== undefined),
      file_exists: String(fs.existsSync(answerPath)),
      termination: JSON.stringify(result.termination),
      verification: JSON.stringify(result.verification),
      conclusion: cell.expectedMachineOnly === true
        ? "guard skip + 判据全通过 ⇒ verified:machine_only（机器证据本身构成验收，且可区分于 guard 验收）"
        : cell.expectedReason === undefined
          ? "未声明判据 ⇒ 文件不存在也能 verified（纯加法：闸门不改变既有行为）"
          : `guard ${cell.guardDecision.action} + 判据有失败 ⇒ unverified:deliverables_failed（证据优先于「我验不了」）`,
    });
    log(`\n── ${currentCase}`);
    log(`   文件存在=${fs.existsSync(answerPath)} / guard=${cell.guardDecision.action}`
      + ` / termination=${result.termination?.reason}`
      + ` / verification=${result.verification?.status}${result.verification?.reason === undefined ? "" : `:${result.verification.reason}`}`);
  }

  // ── S7 新键的体积开销：30 轮 × 4KB 工具输出下必须 < messages 的 2% ────────────────
  {
    currentCase = "S7 新键体积开销（30 轮 × 4KB 工具输出 < messages 的 2%）";
    resetSandbox();
    const BIG = "x".repeat(4096);
    const script = [];
    for (let index = 1; index <= 30; index += 1) {
      script.push(toolUse(`big-${index}`, "writeFile", { path: path.join(sandbox, `f-${index}.txt`), content: BIG }));
    }
    script.push(wrapup({ done: true, summary: "写完 30 个文件", output: "完成" }));
    let payload;
    const result = await runToolLoop({
      provider: createFakeProvider(script),
      cwd: sandbox,
      runId: "probe-run-overhead",
      maxRounds: 30,
      // 关掉两件会改动 payload 体积的既有机制，让这个数只反映「新键 vs messages」：
      // 工具结果 TTL 折叠（0 = 关闭）与 reflection（maxRounds ≥ 16 会自动开启 judge）。
      // #498 S3 (`metadata` A9): `task` 的规位家是 `config.metadata.task`（展开相写回 `effectiveOptions.task`）。
      config: {
        folding: { toolResultTtl: 0 },
        input: { initialUserMessage: `把 30 个 4KB 文件写进 ${sandbox}` },
        metadata: { task: "把 30 个 4KB 文件写进工作目录" },
      },
      reflection: false,
      executeTool: async () => BIG,
      finalGuard: async (value) => {
        payload = value;
        return { action: "accept" };
      },
    });

    const messagesBytes = jsonBytes(payload.messages);
    // 加法键的**整包**开销（含键名与逗号）：整份 payload 减去「把加法键全摘掉」的那份。
    // 只累加值的字节会漏掉键名（10 个键名 ≈ 130 字节），那种数偏乐观，不用它。
    const stripped = Object.fromEntries(
      Object.entries(payload).filter(([key]) => !ADDITIVE_PAYLOAD_KEYS.includes(key)),
    );
    const additiveBytes = jsonBytes(payload) - jsonBytes(stripped);
    const share = additiveBytes / messagesBytes;

    expect(result.rounds >= 30, `场景应跑满 30 轮，实际 ${result.rounds} 轮`);
    expect(messagesBytes > 100_000, `messages 应 ≈ 30×4KB，实际只有 ${messagesBytes} 字节（场景没成形）`);
    expect(
      share < 0.02,
      `新键总字节 ${additiveBytes} 占 messages ${messagesBytes} 的 ${(share * 100).toFixed(2)}%，超过 2% 上限 ⇒ 收紧上限`,
    );
    expect(
      payload.filesWritten?.length === 30,
      `filesWritten 应有 30 条（30 次 writeFile），实际 ${payload.filesWritten?.length}`,
    );
    expect(
      payload.filesWrittenTruncated === undefined,
      "30 条 filesWritten 不该触发 50 条上限的截断标记",
    );
    // 已知限制（本探针实测钉住）：`filesWritten[].path` 是 judge timeline 的摘要参数，
    // 被 `MAX_COMMAND_LENGTH = 40` 截断且**不带任何截断标记** ⇒ 长路径只能当提示，不能当主键。
    // 这条断言故意钉死当前行为：改这个上限（或加截断标记）时它会变红，逼着同步契约文档。
    const longest = payload.filesWritten?.reduce((max, entry) => Math.max(max, entry.path.length), 0);
    expect(
      longest === 40,
      `filesWritten[].path 最长 ${longest} 字符（期望 40 = summarizeArgument 的 MAX_COMMAND_LENGTH）——`
        + "这个上限一变，契约里「path 是被截断的摘要」那句话就得同步",
    );

    record({
      rounds: result.rounds,
      messages_bytes: messagesBytes,
      additive_bytes: additiveBytes,
      share_percent: Number((share * 100).toFixed(3)),
      files_written: payload.filesWritten?.length,
      path_cap_chars: payload.filesWritten?.[0]?.path.length,
      payload_bytes: jsonBytes(payload),
    });
    log(`\n── ${currentCase}`);
    log(`   messages ${messagesBytes} B / 新键 ${additiveBytes} B = ${(share * 100).toFixed(2)}%`
      + `（${result.rounds} 轮，filesWritten ${payload.filesWritten?.length} 条）`);
  }
  // ── E4 预算类停机的补跑桥（**双格**，issue #386 切片 3；形状按 issue #393 改成末轮带工具）────
  // 同一个「轮预算被掐停、模型还在正常调工具、交付物还差一步」的现场，同一个 guard（第一次必
  // `revise`、第二次 `accept`），唯一变量是宿主有没有 opt-in `finalGuardExtend`：
  //   E4a 默认关 ⇒ 与今天逐字一致：`unverified / non_continuable` + `final_guard_unverified`，
  //       模型**没有**被拉回来补做（provider 请求数 2 = 第 1 轮 + 强制收尾）；
  //   E4b opt-in ⇒ 事件里出现 `final_guard_extend`（from→to 抬了上限）、模型真的补做了那一步、
  //       第二次 guard `accept` ⇒ `verified`。
  // 两格合起来才是本切片要的证据：单看 E4b 无法排除「顺手把停机行为全改了」，单看 E4a 无法证明桥有效。
  //
  // issue #393 把两格的**形状**一起换掉了（仍是单变量：只差 opt-in）：强制收尾那一轮模型回的是
  // **工具调用**，不是纯文本 ⇒ 末条 assistant 带着未被回答的 `tool_use`。这才是真实现场（探针原先
  // 那一版让强制收尾回纯文本，于是恰好绕开了这个形状，对 #393 这类回归零信号）。补跑桥在这里
  // 必须先把尾部结清再注入控制文本，否则 provider 以 `invalid_messages` 拒掉整份历史 ⇒
  // 宿主拿到 `termination: failed`。两格都断言「终局不得是 failed」。
  for (const cell of [
    {
      case: "E4a max_rounds_cap + guard revise + 未 opt-in = 今天的行为（标签，不是补跑）",
      optIn: false,
      expectedStatus: "unverified",
      expectedReason: "non_continuable",
      expectedTermination: "final_guard_unverified",
    },
    {
      case: "E4b max_rounds_cap + guard revise + finalGuardExtend:true = 补跑一轮后 verified",
      optIn: true,
      expectedStatus: "verified",
      expectedReason: undefined,
      expectedTermination: "end_turn",
    },
  ]) {
    currentCase = cell.case;
    resetSandbox();
    const events = [];
    const executed = [];
    let guardCalls = 0;
    const provider = createFakeProvider([
      // 第 1 轮：模型还在正常调工具（预算只有 1 轮）⇒ 出圈 ⇒ max_rounds_cap。
      toolUse("e4-w1", "writeFile", { path: answerPath, content: "0" }),
      // 强制收尾（issue #393 的形状）：引擎要一句终稿，模型**又回了一个工具调用** ⇒
      // 末条 assistant 带着未被回答的 `tool_use`（这条调用不会被执行，交付物此时还差一步）。
      toolUse("e4-w2", "writeFile", { path: answerPath, content: "1" }),
      // 补跑那一轮：模型补做交付物。
      toolUse("e4-fix", "writeFile", { path: answerPath, content: "42" }),
      wrapup({ done: true, summary: "已补做", output: "answer.txt 内容是 42" }),
      { times: 8, ...text("idle") },
    ]);
    const result = await runToolLoop({
      provider,
      config: { input: { initialUserMessage: `把 42 写进 ${answerPath}` }, guard: { finalGuardExtend: cell.optIn } },
      maxRounds: 1,
      // 显式给全扩轮参数：默认 step 是 max(8, maxRounds/2)，不显式给的话「抬到多少」会漂。
      reflection: { enabled: true, extensionStep: 2, maxExtensions: 2, maxRoundsCap: 8 },
      executeTool: async (call) => {
        fs.writeFileSync(call.input.path, call.input.content);
        executed.push(call.id);
        return `wrote ${call.input.path}`;
      },
      finalGuard: async (payload) => {
        guardCalls += 1;
        return diskVerifier(payload);
      },
      onEvent: (event) => events.push(event),
    });

    const extensions = events.filter((event) => event.type === "final_guard_extend");
    // issue #393：这条形状**不许**落成 `failed`（现状就是把非法消息序漏给宿主的那一格）。
    expect(
      result.termination?.reason !== "failed",
      `末轮带工具时终局不得是 failed（实际 ${JSON.stringify(result.termination)}）`,
    );
    expect(
      result.termination?.errorCode === undefined,
      `终局不许带 errorCode（实际 ${result.termination?.errorCode}）`,
    );
    expect(
      result.verification?.status === cell.expectedStatus,
      `verification.status 应为 ${cell.expectedStatus}，实际 ${result.verification?.status}`,
    );
    if (cell.expectedReason === undefined) {
      expect(
        result.verification?.reason === undefined,
        `verified 的结果不该带 verification.reason，实际 ${result.verification?.reason}`,
      );
    } else {
      expect(
        result.verification?.reason === cell.expectedReason,
        `verification.reason 应为 ${cell.expectedReason}，实际 ${result.verification?.reason}`,
      );
      expect(
        result.verification?.detail === "max_rounds_cap",
        `verification.detail 应为 max_rounds_cap，实际 ${result.verification?.detail}`,
      );
    }
    expect(
      result.termination?.reason === cell.expectedTermination,
      `termination.reason 应为 ${cell.expectedTermination}，实际 ${result.termination?.reason}`,
    );
    if (cell.optIn) {
      expect(extensions.length === 1, `opt-in 时事件里必须恰好一条 final_guard_extend，实际 ${extensions.length}`);
      expect(
        extensions[0]?.from_max_rounds === 1 && extensions[0]?.to_max_rounds === 3,
        `final_guard_extend 的 from/to 必须是 1 → 3（step=2），实际 ${JSON.stringify(extensions[0])}`,
      );
      expect(extensions[0]?.guard_extension === true, "事件必须自带 guard_extension: true");
      expect(guardCalls === 2, `opt-in 时 guard 应被问 2 次（revise → 补跑 → accept），实际 ${guardCalls}`);
      expect(executed.includes("e4-fix"), "模型没有被拉回来补做（e4-fix 从未执行）");
      expect(
        fs.existsSync(answerPath) && fs.readFileSync(answerPath, "utf8").trim() === "42",
        "补跑之后交付物仍不对（桥没有真的把模型拉回到「差的那一步」上）",
      );
      expect(
        result.verification?.metrics?.guard_extensions === 1,
        `metrics.guard_extensions 应为 1，实际 ${result.verification?.metrics?.guard_extensions}`,
      );
      // issue #393 的消息序不变量：判据用 canonical 那一份（`validateMessages` 的配对规则 +
      // 同源的 `pendingTrailingToolUses`），不在这里另写一遍。
      let canonicalError;
      try {
        validateMessages(result.messages);
      } catch (error) {
        canonicalError = error;
      }
      expect(
        canonicalError === undefined,
        `补跑之后的消息序不合法：${canonicalError?.message}`,
      );
      expect(
        pendingTrailingToolUses(result.messages).length === 0,
        "补跑之后尾部还留着悬空 tool_use",
      );
      const repaired = (result.messages ?? [])
        .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
        .find((block) => block?.type === "tool_result" && block.tool_use_id === "e4-w2");
      expect(repaired !== undefined, "强制收尾那条 tool_use（e4-w2）没有被结清");
      expect(
        repaired?.is_error === true && /\[erix\]/u.test(String(repaired?.content)),
        `引擎自写的 tool_result 必须带 is_error 与 [erix] marker，实际 ${JSON.stringify(repaired)}`,
      );
      expect(
        !executed.includes("e4-w2"),
        "补的只是事实陈述：那条未执行的调用不许被真的执行",
      );
    } else {
      expect(extensions.length === 0, `未 opt-in 时不许出现 final_guard_extend 事件，实际 ${extensions.length} 条`);
      expect(guardCalls === 1, `未 opt-in 时 guard 只该被问 1 次，实际 ${guardCalls}`);
      expect(!executed.includes("e4-fix"), "未 opt-in 时模型不许被拉回来补做");
      expect(
        provider.requests.length === 2,
        `未 opt-in 时 provider 请求数应保持 2（第 1 轮 + 强制收尾），实际 ${provider.requests.length}`,
      );
      expect(
        !("guard_extensions" in (result.verification?.metrics ?? {})),
        "未 opt-in 时 metrics 里不许出现 guard_extensions（回归锚：与今天逐字一致）",
      );
    }

    record({
      opted_in: String(cell.optIn),
      guard_calls: guardCalls,
      provider_requests: provider.requests.length,
      termination: JSON.stringify(result.termination),
      verification: JSON.stringify(result.verification),
      extend_events: JSON.stringify(extensions),
      executed_tools: executed.join(","),
      answer_on_disk: fs.existsSync(answerPath) ? fs.readFileSync(answerPath, "utf8").trim() : "(absent)",
    });
    log(`\n── ${currentCase}`);
    log(`   guard ${guardCalls} 次 / provider ${provider.requests.length} 次 / 事件 ${extensions.length} 条`
      + ` ⇒ ${result.termination?.reason} / ${result.verification?.status}`
      + `${result.verification?.reason === undefined ? "" : `:${result.verification.reason}`}`
      + `（磁盘 answer.txt = ${fs.existsSync(answerPath) ? fs.readFileSync(answerPath, "utf8").trim() : "不存在"}）`);
  }

} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

const ok = failures.length === 0;
const summary = {
  ok,
  cases: results.length,
  failures,
  results,
};
if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  log(`\nfinal-guard-probe: ${ok ? "OK" : "失败"} — ${results.length} 个场景，${failures.length} 条判据不成立`);
  for (const failure of failures) log(`  ✗ ${failure}`);
}
process.exit(ok ? 0 : 1);
