// issue #386 切片 2（前置 #388）：`fileWrites` 原始写路径台账 + 宿主交付物判据 `deliverables`。
//
// 这一组用例的职责边界：
//   · R0（#388）：`fileWrites[].path` 是 `tool_use.input[pathKey]` 的**原始值**（逐字，可直接 stat），
//     与 `filesWritten[].path`（judge 提示用的 40 码点摘要）分工不同、不许混用；
//   · R1/R2/R3：`deliverables` 的校验、核验时机、以及**机器闸门**（判据失败 ⇒ guard 的 accept 不得
//     产生 verified）；
//   · R4：逐格钉住闸门真值表的四格 + fail-closed 两条 + 反向证。
//
// 三处刻意的写法，改之前请先读完：
//   1. 「未声明 deliverables ⇒ 与今天逐字一致」那一格（R4-1）是本单**唯一**的回归锚：它逐字比较
//      `verification` / `verification.metrics` / payload 的键集合，任何新键漏进未声明路径都会红。
//   2. 闸门四格都用**同一个**天真 guard（只看 finalText 非空就 accept），差别只在 `deliverables`
//      是否声明、以及判据看不看磁盘。这样「机器证据压过 guard 意见」才是唯一变量。
//   3. 判据一律读**磁盘事实**（`fs.existsSync`），不读 payload 里的自报文本——否则测的就是模型嘴。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect, withSeed } from "./helpers/run-direct.js";
import { buildFinalGuardPayload, FILE_LEDGER_LIMIT } from "../src/loop/termination.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

const toolUse = (id, name, input) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});
const text = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
const wrapup = (object) => ({
  content: [{ type: "text", text: JSON.stringify(object) }],
  stopReason: "end_turn",
});

/** 真写盘：`executeTool` 把 `writeFile` 的 input 落到磁盘（否则「文件存在」不是磁盘事实）。 */
const diskWriteTool = async (call) => {
  mkdirSync(dirname(call.input.path), { recursive: true });
  writeFileSync(call.input.path, call.input.content ?? "");
  return "ok";
};

/** 天真 guard：只看终稿有没有字。它**永远** accept —— 橡皮章的原型。 */
const rubberStampGuard = async (payload) => (String(payload.finalText).length > 0
  ? { action: "accept" }
  : { action: "revise", message: "空终稿" });

/** 同一个天真 guard，外加把 payload 存进 `sink.payload`（`sink` 是调用方的对象）。 */
const capturingRubberStamp = (sink) => async (payload) => {
  sink.payload = payload;
  return rubberStampGuard(payload);
};

// ── R0（issue #388）：原始写路径逐字正确 ──────────────────────────────────────────
test("#388 fileWrites[].path 是 input 原值（>40 码点长路径逐字相等），filesWritten 仍是 40 码点摘要", async () => {
  const dir = await makeTmp("erix-deliverables-fw-");
  // 故意造一条 > 40 码点的深路径：摘要会把它截成前 40 个字符（不带省略号、不带截断标记）。
  const deep = `${dir}/nested/deep/artifact-with-a-very-long-name.txt`;
  assert.ok(Array.from(deep).length > 40, `测试路径不够长（${Array.from(deep).length} 码点），造不出摘要截断`);

  let payload;
  const result = await runDirect({
    provider: createFakeProvider([
      toolUse("w1", "writeFile", { path: deep, content: "42" }),
      wrapup({ done: true, summary: "已写入", output: "done" }),
    ]),
    initialUserMessage: `把 42 写进 ${deep}`,
    cwd: dir,
    maxRounds: 4,
    executeTool: diskWriteTool,
    finalGuard: async (value) => {
      payload = value;
      return { action: "accept" };
    },
  });

  assert.equal(existsSync(deep), true, "真写工具没落到磁盘上（这个用例的判据就是磁盘事实）");
  assert.deepEqual(payload.fileWrites, [{ path: deep, round: 1, tool: "writeFile" }],
    `fileWrites[].path 必须逐字等于 input 原值（实测 ${JSON.stringify(payload.fileWrites)}）`);
  // 对照组：同一个 run 的摘要台账**确实**被截断了 —— 两个键的分工是这条用例的重点。
  assert.equal(payload.filesWritten.length, 1);
  assert.notEqual(payload.filesWritten[0].path, deep, "filesWritten 不该再是原值（它就是 40 码点摘要）");
  assert.equal(Array.from(payload.filesWritten[0].path).length, 40,
    `filesWritten[].path 应仍是 summarizeArgument 的 40 码点摘要，实测 ${payload.filesWritten[0].path}`);
  assert.ok(deep.startsWith(payload.filesWritten[0].path), "摘要必须是原值的前缀（否则不是同一个路径）");
  // 台账与 payload 的两个键都不许带截断标记（只有 1 条，远未到上限）。
  assert.equal("fileWritesTruncated" in payload, false);
  assert.equal("filesWrittenTruncated" in payload, false);
  assert.equal(result.verification.status, "verified");
});

test("#388 fileWrites 与 filesWritten 共用同一个上限常量，超限只留最后 N 条并带 fileWritesTruncated", () => {
  assert.equal(FILE_LEDGER_LIMIT, 50);
  const many = Array.from({ length: FILE_LEDGER_LIMIT + 10 }, (_unused, index) => ({
    path: `f-${index + 1}.txt`,
    round: index + 1,
    tool: "writeFile",
  }));
  const payload = buildFinalGuardPayload({ fileWrites: many }, "end_turn", undefined, 1);
  assert.equal(payload.fileWrites.length, FILE_LEDGER_LIMIT);
  assert.equal(payload.fileWrites[0].path, "f-11.txt", "留下的必须是**最后** N 条（= 最新）");
  assert.equal(payload.fileWrites.at(-1).path, `f-${FILE_LEDGER_LIMIT + 10}.txt`);
  assert.equal(payload.fileWritesTruncated, true);

  const exactly = buildFinalGuardPayload(
    { fileWrites: many.slice(10) },
    "end_turn",
    undefined,
    1,
  );
  assert.equal(exactly.fileWrites.length, FILE_LEDGER_LIMIT);
  assert.equal("fileWritesTruncated" in exactly, false, "恰好 N 条不该出现截断标记");

  // 探不到就不写该键（与 #386 切片 1 的纪律一致）。
  const none = buildFinalGuardPayload({}, "end_turn", undefined, 1);
  assert.equal("fileWrites" in none, false);
});

test("#388 非写工具不进 fileWrites；写工具但没带路径键也不进（不写空壳）", async () => {
  const dir = await makeTmp("erix-deliverables-fw2-");
  let payload;
  await runDirect({
    provider: createFakeProvider([
      toolUse("r1", "readFile", { path: `${dir}/whatever.txt` }),
      toolUse("w1", "writeFile", { content: "no path key here" }),
      toolUse("e1", "exec", { command: "echo hi" }),
      wrapup({ done: true, summary: "s", output: "o" }),
    ]),
    initialUserMessage: "x",
    cwd: dir,
    maxRounds: 6,
    executeTool: async () => "ok",
    finalGuard: async (value) => {
      payload = value;
      return { action: "accept" };
    },
  });

  assert.deepEqual(payload.fileWrites, [], `非写工具/无路径键都不许进台账，实测 ${JSON.stringify(payload.fileWrites)}`);
  assert.deepEqual(payload.filesWritten, []);
});

// ── R4-1（回归锚）：未声明 deliverables ⇒ 与今天逐字一致 ────────────────────────────
test("#386-2 R4-1 未声明 deliverables：payload 无相关键，verification 与 metrics 与今天逐字一致", async () => {
  const dir = await makeTmp("erix-deliverables-reg-");
  let payload;
  const events = [];
  const result = await runDirect({
    provider: createFakeProvider([
      toolUse("w1", "writeFile", { path: `${dir}/a.txt`, content: "1" }),
      wrapup({ done: true, summary: "s", output: "o" }),
    ]),
    initialUserMessage: "x",
    cwd: dir,
    maxRounds: 4,
    executeTool: diskWriteTool,
    finalGuard: async (value) => {
      payload = value;
      return { action: "accept" };
    },
    onEvent: (event) => events.push(event),
  });

  // payload：没有 deliverables / deliverablesAllPassed 这两个键（连空数组都不许出现）。
  assert.equal("deliverables" in payload, false, "未声明判据却往 payload 里塞了 deliverables 键");
  assert.equal("deliverablesAllPassed" in payload, false);
  // metrics：五个键逐字不变，多一个都算回归（`deepEqual` 是严格集合语义）。
  assert.deepEqual(result.verification, {
    status: "verified",
    metrics: { verified: 1, skipped: 0, revised: 0, unverified: 0, guard_error: 0 },
  });
  // 事件形状也逐字不变（新字段只在声明判据时出现）。
  const guardEvents = events.filter((event) => event.type === "final_guard");
  assert.deepEqual(guardEvents, [{ type: "final_guard", round: 2, action: "accept" }]);
});

// ── R4-2：判据通过 + guard accept ⇒ verified，metrics 计数正确 ────────────────────
test("#386-2 R4-2 判据通过 + guard accept ⇒ verified，deliverables_checked/failed 计数正确", async () => {
  const dir = await makeTmp("erix-deliverables-ok-");
  const target = `${dir}/answer.txt`;
  const sink = {};
  const facts = [];
  const result = await runDirect({
    provider: createFakeProvider([
      toolUse("w1", "writeFile", { path: target, content: "42" }),
      wrapup({ done: true, summary: "s", output: "o" }),
    ]),
    initialUserMessage: `把 42 写进 ${target}`,
    task: "写 answer.txt",
    cwd: dir,
    maxRounds: 4,
    executeTool: diskWriteTool,
    deliverables: [{
      name: "report",
      check: (value) => {
        facts.push(value);
        return existsSync(target);
      },
    }],
    finalGuard: capturingRubberStamp(sink),
  });

  // 判据拿到的就是 `buildFinalGuardPayload` 那份事实（切片 1 的十个键都在）。
  assert.equal(facts.length, 1);
  for (const key of ["cwd", "fileWrites", "filesWritten", "toolStats", "taskBrief", "finalText", "attempt", "rounds"]) {
    assert.ok(key in facts[0], `判据事实里缺 ${key}（payloadFacts 必须是 buildFinalGuardPayload 的输出）`);
  }
  assert.equal(facts[0].cwd, dir);
  assert.deepEqual(facts[0].fileWrites, [{ path: target, round: 1, tool: "writeFile" }]);
  assert.equal(facts[0].attempt, 1, "第一次核验时 attempt 必须是 1（与 guard 看到的一致）");
  assert.equal(facts[0].taskBrief, "写 answer.txt");

  assert.equal(result.verification.status, "verified");
  assert.deepEqual(result.verification.metrics, {
    verified: 1,
    skipped: 0,
    revised: 0,
    unverified: 0,
    guard_error: 0,
    deliverables_checked: 1,
    deliverables_failed: 0,
  });
  assert.deepEqual(sink.payload.deliverables, [{ name: "report", ok: true }]);
  assert.equal(sink.payload.deliverablesAllPassed, true);
});

// ── R4-3：判据失败 + guard accept ⇒ unverified / deliverables_failed（橡皮章被拦）──
test("#386-2 R4-3 判据失败 + 天真 guard accept ⇒ unverified:deliverables_failed（机器证据压过 guard 意见）", async () => {
  const dir = await makeTmp("erix-deliverables-gate-");
  const target = `${dir}/never-written.txt`;
  const sink = {};
  const events = [];
  const result = await runDirect({
    provider: createFakeProvider([
      wrapup({ done: true, summary: "完成", output: `已生成 ${target}，内容为 42` }),
    ]),
    initialUserMessage: "写文件",
    cwd: dir,
    maxRounds: 2,
    executeTool: diskWriteTool,
    deliverables: [{ name: "report", check: () => existsSync(target) }],
    // 天真 guard：只看终稿有没有字 ⇒ 它会 accept（这正是「橡皮章」的定义）。
    finalGuard: capturingRubberStamp(sink),
    onEvent: (event) => events.push(event),
  });

  assert.equal(existsSync(target), false, "本用例的前提是交付物**不存在**（判据必须真失败）");
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.verification.reason, "deliverables_failed");
  assert.deepEqual(result.verification.metrics, {
    verified: 0,
    skipped: 0,
    revised: 0,
    unverified: 1,
    guard_error: 0,
    deliverables_checked: 1,
    deliverables_failed: 1,
  });
  // 闸门只改 verification，**不改** termination.reason（不引入新的停机原因）。
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.deepEqual(sink.payload.deliverables, [{ name: "report", ok: false }]);
  assert.equal(sink.payload.deliverablesAllPassed, false);
  // guard 确实说了 accept，事件里必须能看见「accept 被闸门拦下」。
  const accept = events.filter((event) => event.type === "final_guard" && event.action === "accept");
  assert.equal(accept.length, 1);
  assert.equal(accept[0].deliverables_failed, 1);
});

// ── R4-4：失败 → revise → 模型补做（真写文件）→ 第二次通过 ⇒ verified ────────────────
test("#386-2 R4-4 判据失败 → guard revise → 模型补做 → 第二次判据通过 ⇒ verified（attempt 1→2，fileWrites 0→1）", async () => {
  const dir = await makeTmp("erix-deliverables-retry-");
  const target = `${dir}/answer.txt`;
  const attempts = [];
  const provider = createFakeProvider([
    // 第一次：撒谎（什么都没写）。
    wrapup({ done: true, summary: "已完成", output: "写好了" }),
    // 补救：真写。
    toolUse("w2", "writeFile", { path: target, content: "42" }),
    wrapup({ done: true, summary: "已写入", output: "完成" }),
  ]);
  const result = await runDirect({
    provider,
    initialUserMessage: `把 42 写进 ${target}`,
    cwd: dir,
    maxRounds: 6,
    executeTool: diskWriteTool,
    deliverables: [{
      name: "answer-file",
      check: (facts) => {
        attempts.push({
          attempt: facts.attempt,
          fileWrites: facts.fileWrites?.length ?? 0,
          exists: existsSync(target),
        });
        return existsSync(target);
      },
    }],
    finalGuard: async (payload) => (attempts.at(-1).exists
      ? { action: "accept" }
      : { action: "revise", message: `验收失败：${target} 不存在，请真正写入` }),
  });

  assert.deepEqual(attempts, [
    { attempt: 1, fileWrites: 0, exists: false },
    { attempt: 2, fileWrites: 1, exists: true },
  ], `判据必须在**每次** guard 调用前重算（实测 ${JSON.stringify(attempts)}）`);
  assert.equal(result.verification.status, "verified");
  assert.equal(result.verification.metrics.revised, 1);
  assert.equal(result.verification.metrics.deliverables_checked, 2, "两次 attempt ⇒ 核了两遍");
  assert.equal(result.verification.metrics.deliverables_failed, 1, "只有第一次失败");
  assert.equal(result.termination.reason, "end_turn");
});

// ── R4-5：fail-closed 两条（抛异常 / 超时）──────────────────────────────────────────
test("#386-2 R4-5 check 抛异常 ⇒ ok:false + detail:\"threw\"，且绝不出现 verified", async () => {
  const dir = await makeTmp("erix-deliverables-threw-");
  let payload;
  const result = await runDirect({
    provider: createFakeProvider([wrapup({ done: true, summary: "s", output: "o" })]),
    initialUserMessage: "x",
    cwd: dir,
    maxRounds: 2,
    executeTool: diskWriteTool,
    deliverables: [{ name: "boom", check: () => { throw new Error("verifier crashed"); } }],
    finalGuard: rubberStampGuard,
  });

  assert.notEqual(result.verification.status, "verified", "判据崩了却盖了 verified（fail-closed 被写成了认证）");
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.verification.reason, "deliverables_failed");
  assert.deepEqual(result.verification.metrics.deliverables_failed, 1);
});

test("#386-2 R4-5 check 超时 ⇒ ok:false + detail:\"timeout\"（复用 finalGuardTimeoutMs），且绝不出现 verified", async () => {
  const dir = await makeTmp("erix-deliverables-timeout-");
  const result = await runDirect({
    provider: createFakeProvider([wrapup({ done: true, summary: "s", output: "o" })]),
    initialUserMessage: "x",
    cwd: dir,
    maxRounds: 2,
    executeTool: diskWriteTool,
    finalGuardTimeoutMs: 60,
    deliverables: [{
      name: "hangs",
      check: async () => {
        await new Promise((resolve) => { setTimeout(resolve, 400); });
        return true;
      },
    }],
    finalGuard: rubberStampGuard,
  });

  assert.notEqual(result.verification.status, "verified", "判据超时却盖了 verified");
  assert.equal(result.verification.reason, "deliverables_failed");
});

// ── R4-6：非法返回值 ⇒ invalid_result ─────────────────────────────────────────────
test("#386-2 R4-6 判据返回非法值（字符串 / 缺 ok 的对象）⇒ ok:false + invalid_result，不许当通过", async () => {
  const dir = await makeTmp("erix-deliverables-invalid-");
  for (const [label, value] of [["字符串", "yes"], ["缺 ok 的对象", { passed: true }], ["undefined", undefined]]) {
    let payload;
    const result = await runDirect({
      provider: createFakeProvider([wrapup({ done: true, summary: "s", output: "o" })]),
      initialUserMessage: "x",
      cwd: dir,
      maxRounds: 2,
      executeTool: diskWriteTool,
      deliverables: [{ name: "weird", check: () => value }],
      finalGuard: async (facts) => {
        payload = facts;
        return { action: "accept" };
      },
    });
    assert.deepEqual(payload.deliverables, [{ name: "weird", ok: false, detail: "invalid_result" }],
      `判据返回${label}时必须判 invalid_result（实测 ${JSON.stringify(payload.deliverables)}）`);
    assert.equal(result.verification.status, "unverified", `判据返回${label}却通过了`);
    assert.equal(result.verification.reason, "deliverables_failed");
  }
  // 反向：对象形态 `{ok:false, detail}` 原样搬（detail 不许被吞）。
  let payload;
  await runDirect({
    provider: createFakeProvider([wrapup({ done: true, summary: "s", output: "o" })]),
    initialUserMessage: "x",
    cwd: dir,
    maxRounds: 2,
    executeTool: diskWriteTool,
    deliverables: [{ name: "object", check: () => ({ ok: false, detail: "missing answer.txt" }) }],
    finalGuard: async (facts) => {
      payload = facts;
      return { action: "accept" };
    },
  });
  assert.deepEqual(payload.deliverables, [{ name: "object", ok: false, detail: "missing answer.txt" }]);
});

// ── R4-7：非可续跑终局也照核一次，但 non_continuable 语义不变 ────────────────────────
test("#386-2 R4-7 max_rounds_cap 终局：判据照核、non_continuable 与 final_guard_unverified 语义一字不改", async () => {
  const dir = await makeTmp("erix-deliverables-cap-");
  const target = `${dir}/answer.txt`;
  const checks = [];
  const result = await runDirect({
    provider: createFakeProvider([
      // 只有一轮预算：这一轮用掉工具，随后出圈 ⇒ max_rounds_cap。
      toolUse("w1", "writeFile", { path: target, content: "42" }),
      { times: 4, ...text("我不收尾") },
    ]),
    initialUserMessage: "写文件",
    cwd: dir,
    maxRounds: 1,
    executeTool: diskWriteTool,
    deliverables: [{ name: "report", check: (facts) => {
      checks.push({ attempt: facts.attempt, fileWrites: facts.fileWrites?.length ?? 0 });
      return existsSync(target);
    } }],
    finalGuard: rubberStampGuard,
  });

  assert.equal(result.termination.reason, "final_guard_unverified",
    "非可续跑终局被本单改写了（闸门不引入新的停机原因）");
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.verification.reason, "non_continuable", "non_continuable 的既有语义不许被 deliverables 顶掉");
  assert.equal(result.verification.detail, "max_rounds_cap");
  assert.equal(result.verification.metrics.deliverables_checked, 1, "非可续跑终局也要照核一次");
  assert.equal(checks.length, 1);
  assert.equal(checks[0].fileWrites, 1, "出圈前那一轮写的文件必须已经在 fileWrites 台账里");
});

// ── R4-8：选项校验口径 ────────────────────────────────────────────────────────────
test("#386-2 R4-8 deliverables 的校验：超 20 条 / name 重复 / name 空 / 形状不对 ⇒ TypeError", async () => {
  const dir = await makeTmp("erix-deliverables-validate-");
  // 每个 run 都要一个**新**的 scripted provider（`createFakeProvider` 的脚本是一次性队列）。
  const base = () => ({
    provider: createFakeProvider([text("done")]),
    initialUserMessage: "x",
    cwd: dir,
    executeTool: async () => "ok",
  });
  const check = () => true;
  const cases = [
    ["超 20 条", Array.from({ length: 21 }, (_unused, index) => ({ name: `d${index}`, check })),
      "deliverables must have at most 20 entries"],
    ["name 重复", [{ name: "dup", check }, { name: "dup", check }],
      'deliverables[1].name must be unique: "dup"'],
    ["name 空串", [{ name: "  ", check }], "deliverables[0].name must be a non-empty string"],
    ["不是数组", { name: "x", check }, "deliverables must be an array of { name, check }"],
    ["条目不是对象", ["nope"], "deliverables[0] must be an object like { name, check }"],
    ["check 不是函数", [{ name: "x", check: "yes" }], "deliverables[0].check must be a function"],
  ];
  for (const [label, value, message] of cases) {
    await assert.rejects(
      () => runToolLoop(withSeed({ ...base(), deliverables: value })),
      (error) => {
        assert.equal(error.constructor, TypeError, `${label}：抛的不是 TypeError`);
        assert.equal(error.message, message, `${label}：文案与既有校验口径不一致`);
        return true;
      },
      `${label} 没有被拦住`,
    );
  }
  // 放行面：恰好 20 条合法；空数组等价于未声明（= 今天的行为）。
  const twenty = await runToolLoop(withSeed({
    ...base(),
    deliverables: Array.from({ length: 20 }, (_unused, index) => ({ name: `d${index}`, check })),
  }));
  assert.equal(twenty.verification.status, "skipped", "20 条合法判据不该影响 run 本身");
  const empty = await runToolLoop(withSeed({ ...base(), deliverables: [] }));
  // 空数组 = 未声明 ⇒ metrics 里连 deliverables_* 都不该出现（与 R4-1 同一把尺子）。
  assert.deepEqual(empty.verification, {
    status: "skipped",
    reason: "no_final_guard",
    metrics: { verified: 0, skipped: 0, revised: 0, unverified: 0, guard_error: 0 },
  });
});
