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
//     新键体积超过 messages 的 2%）⇒ 退出码非零。
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
      initialUserMessage: `把 42 写进 ${answerPath}`,
      task: `把 42 写进 ${answerPath}`,
      cwd: sandbox,
      runId: "probe-run-1",
      finalGuardMaxRetries: 2,
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
      initialUserMessage: `把 42 写进 ${answerPath}`,
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
      initialUserMessage: "写文件",
      maxRounds: 8,
      finalGuardMaxRetries: 2,
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
      initialUserMessage: "x",
      maxRounds: 2,
      executeTool: async () => "ok",
      finalGuard: async (payload) => {
        payloads.push({ attempt: payload.attempt, keys: Object.keys(payload).length });
        return guard(payload);
      },
      finalGuardTimeoutMs: 100,
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

  // ── S6 天真 guard 橡皮章：只看 finalText 有没有字 ⇒ 撒谎也能 verified ──────────────
  {
    currentCase = "S6 天真 guard（只看 finalText 非空）= 橡皮章";
    resetSandbox();
    const result = await runToolLoop({
      provider: createFakeProvider([
        wrapup({ done: true, summary: "完成", output: `已生成 ${answerPath}，内容为 42` }),
      ]),
      initialUserMessage: "写文件",
      maxRounds: 2,
      executeTool: async () => "ok",
      finalGuard: async (payload) => (String(payload.finalText).length > 0
        ? { action: "accept" }
        : { action: "revise", message: "空" }),
    });

    // 这条断言是**故意反着写**的：它记录的是「白名单式 guard 的失效形状」，不是期望行为。
    // 判据 = 磁盘事实（文件根本不存在）+ 引擎裁决（verified）同时成立 ⇒ 橡皮章。
    expect(
      !fs.existsSync(answerPath) && result.verification?.status === "verified",
      "天真 guard 的失效形状变了：现在「finalText 非空」不再能骗过 verified —— "
      + "若这是有意的语义改动，请连同 S6 的结论与 docs 里的反例一起改",
    );
    // 同一份撒谎输入交给磁盘验收器（S2 的第一轮）必须被抓住 —— 两个场景合起来才是完整的对照。
    expect(
      result.finalText.includes("已生成"),
      "S6 的终稿不再是模型的自报文本（对照失去意义）",
    );

    record({
      file_exists: String(fs.existsSync(answerPath)),
      termination: JSON.stringify(result.termination),
      verification: JSON.stringify(result.verification),
      conclusion: "文件不存在但 verification=verified ⇒ 只看 finalText 的 guard 是橡皮章",
    });
    log(`\n── ${currentCase}`);
    log(`   文件存在=${fs.existsSync(answerPath)} / verification=${result.verification?.status}`
      + " ⇒ 白名单式 guard 是橡皮章（验收判据必须是独立事实）");
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
      initialUserMessage: `把 30 个 4KB 文件写进 ${sandbox}`,
      task: "把 30 个 4KB 文件写进工作目录",
      cwd: sandbox,
      runId: "probe-run-overhead",
      maxRounds: 30,
      // 关掉两件会改动 payload 体积的既有机制，让这个数只反映「新键 vs messages」：
      // 工具结果 TTL 折叠（0 = 关闭）与 reflection（maxRounds ≥ 16 会自动开启 judge）。
      toolResultTtl: 0,
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
