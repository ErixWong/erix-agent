#!/usr/bin/env node
// @ts-check
// cli-continuity-smoke.mjs — issue #598 的**零 token CLI 跨 run 续接 e2e**（离线、自清理）。
//
// 它验的是什么（一句话）：`config.continuity.handoff = "prompt"` 时，**第一个 run** 的模型在正文里
// 顺手写 `<handoff>` ⇒ 引擎落盘；**第二个 run** 的第一条请求里逐字含上一轮那三段；不写这个叶时
// 请求里逐字没有 `<handoff>`、store 目录连创建都不创建。这是「CLI 真的接上了这个开关」的**端到端**
// 证据：`test/loop-continuity-writer-598.test.js` 钉的是引擎侧（进程内），本脚本钉的是
// `bin/cli.js` 把配置装配进 `loopOptions.config` 那一段（`grep -rn "continuity" bin/` 曾经是空的）。
//
// 纪律（与 `scripts/release-check.mjs` 第 5 步同一套，**照抄不发明**）：
//   · 真子进程跑 CLI（`node bin/cli.js` 或装好的 `erix`，由调用方给入口），端点打
//     `fixtures/upstream.mjs#createScriptedUpstream` 起的本地假上游（绑 `127.0.0.1:0`）；
//   · 假 HOME 用 `fixtures/config-shape.mjs#writeConfigHome` + `fakeHomeEnv` 造，**绝不读真实
//     `~/.erix/config.json`**；`ERIX_CONTINUITY_DIR` 把 store 指到临时目录（库层的注入点，
//     与 `ERIX_NOTES_DIR` 同一条纪律）；
//   · 跑前跑后各取一次真实 `~/.erix` 目录快照与 `~/.npmrc` 哈希，变了就红（污染不许悄悄发生）；
//   · 临时目录一律 `mkdtemp(join(tmpdir(), "erix-cli-continuity-"))`，`finally` + `exit` 钩子双保险删。
//
// 退出码：0 = A/B/C/D 全绿；非 0 = 红，且**点名是哪一条断言**（stderr 里 `断言 A 红：…`）。
//
// 断言（编号与工单一致）：
//   A  存：run 1 之后 store 文件出现，三段**逐字**等于 run 1 的模型输出；
//   B  召回：run 2 的**首个请求体**逐字含那三段，且含 `<handoff>` 指令；
//   C  默认关：配置里不写这个叶 ⇒ 请求体不含 `<handoff>`、continuity 目录**不存在**；
//   D  非法值：`handoff: "on"` ⇒ load 期报错（退 1）并列出三个合法值，且一个请求都不发
//      （D 是 `bin/config.js#buildContinuityConfig` 那一格的机器判据：它放过非法值 ⇒ D 红）。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createScriptedUpstream, jsonResponse } from "../fixtures/upstream.mjs";
import { fakeHomeEnv, upstreamFields, writeConfigHome } from "../fixtures/config-shape.mjs";
import { CONTINUITY_BLOCK_START, HANDOFF_INSTRUCTION, HANDOFF_MARKER_START } from "../src/loop/continuity-block.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** `bin/cli.js` 帮助里承诺的退出码（与第 5 步同口径，不是本脚本自创的期望）。 */
const EXIT_USAGE = 1;
/** 默认不开 `--final-guard` 的一次成功 chat：核验 `skipped` ⇒ 退 4（**不是**失败）。 */
const EXIT_NOT_VERIFIED = 4;

/** 宿主可能带进来的代理类变量：进子进程前一律清掉（`NODE_USE_ENV_PROXY` 会把 127.0.0.1 也送给代理）。 */
const PROXY_VARS = [
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY",
];

// ---- 夹具字面量：三段各用**独特**字符串，红的时候一眼能看出是哪一段没进请求体 --------------
const CONTRACT_LITERAL = "契约A-7f3";
const UNFINISHED_LITERAL = "欠B-7f3";
const EVIDENCE_LITERAL = "已验证-7f3";
/** run 1 的模型输出：正文 + 合法 `<handoff>` 块（三段都有实质内容）。 */
const HANDOFF_REPLY = [
  "任务已完成。",
  HANDOFF_MARKER_START,
  `contract: ${CONTRACT_LITERAL}`,
  `unfinished: ${UNFINISHED_LITERAL}`,
  `evidence: ${EVIDENCE_LITERAL}`,
  "</handoff>",
].join("\n");
/** run 2 / 断言 C 的模型输出：纯文本，**不写** handoff。 */
const PLAIN_REPLY = "任务已完成，没有更多步骤。";

class SmokeFailure extends Error {
  /**
   * @param {"A"|"B"|"C"|"D"} assertion
   * @param {string} detail
   */
  constructor(assertion, detail) {
    super(`断言 ${assertion} 红：${detail}`);
    this.name = "SmokeFailure";
    this.assertion = assertion;
  }
}

/** @param {"A"|"B"|"C"|"D"} assertion @param {string} detail @returns {never} */
function fail(assertion, detail) {
  throw new SmokeFailure(assertion, detail);
}

// ---------------------------------------------------------------------------
// 真实用户配置的对账（与 release-check 的 snapshotDir / hashFileIfExists 同式）
// ---------------------------------------------------------------------------

/** @param {string} dir */
function snapshotDir(dir) {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return `MISSING:${dir}`;
    return `${dir}:${stat.mtimeMs}:${readdirSync(dir).sort().join(",")}`;
  } catch {
    return `MISSING:${dir}`;
  }
}

/** @param {string} filePath */
function hashFileIfExists(filePath) {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return `MISSING:${filePath}`;
  }
}

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------

/**
 * **异步**跑子进程：假上游 HTTP 服务就跑在本进程里，`spawnSync` 会把事件循环堵死
 * （CLI 的请求永远没人应答，最后被超时杀掉）。与 `release-check.mjs#runAsync` 同一条理由。
 *
 * @param {{command: string, args: string[]}} cli
 * @param {string[]} args
 * @param {{cwd: string, env: Record<string, string|undefined>, timeoutMs?: number, label?: string}} options
 * @returns {Promise<{status: number, stdout: string, stderr: string}>}
 */
function runCli(cli, args, options) {
  const label = options.label ?? `erix ${args.join(" ")}`;
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cli.command, [...cli.args, ...args], {
      cwd: options.cwd,
      env: /** @type {NodeJS.ProcessEnv} */ (options.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(new Error(`${label} 起不来：${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === null) {
        rejectPromise(new Error(`${label} 被 ${signal ?? "超时"} 终止（${timeoutMs}ms 硬超时）`));
        return;
      }
      resolvePromise({ status: code, stdout, stderr });
    });
  });
}

/** 子进程统一环境：清代理 + 换假 HOME + 注入 `extra`（`ERIX_CONTINUITY_DIR` 走这里）。 */
function childEnv(home, extra = {}) {
  /** @type {Record<string, string | undefined>} */
  const base = { ...process.env };
  for (const name of PROXY_VARS) delete base[name];
  for (const name of Object.keys(base)) {
    if (/^npm_config_/u.test(name)) delete base[name];
  }
  return fakeHomeEnv(base, { home, extra });
}

// ---------------------------------------------------------------------------
// 请求体读取
// ---------------------------------------------------------------------------

/**
 * 请求体里**人读得懂的那部分文本**：把 `messages[].content` 的字符串段与 text 块拼起来。
 *
 * 为什么不能直接 `bodyText.includes(HANDOFF_INSTRUCTION)`：线上字节是 JSON，`\n` 被转义成
 * `\\n`，多行字面量在 `bodyText` 里**必然**找不到。三段夹具字面量不含换行，因此在 `bodyText`
 * 上逐字断言（那才是真的「上线的字节」）；多行指令在解码后的文本上断言。
 *
 * @param {{json?: any, bodyText?: string}|undefined} entry
 * @returns {string}
 */
function requestText(entry) {
  const messages = entry?.json?.messages;
  if (!Array.isArray(messages)) return String(entry?.bodyText ?? "");
  const parts = [];
  for (const message of messages) {
    if (typeof message?.content === "string") {
      parts.push(message.content);
      continue;
    }
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (typeof part?.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

/** @param {string} text @param {string} name @param {string} literal @returns {string|undefined} */
function missingLiteral(text, name, literal) {
  return text.includes(literal) ? undefined : `${name}（${JSON.stringify(literal)}）不在请求体里`;
}

/**
 * run 2 首个请求体里那段续接块的原文片段（**证据**，不是断言）：报告里要贴的就是它。
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
function continuityExcerpt(text, limit = 400) {
  const start = text.indexOf(CONTINUITY_BLOCK_START);
  if (start === -1) return "（请求体里没有续接块）";
  const slice = text.slice(start, start + limit);
  return slice.length < text.length - start ? `${slice}…` : slice;
}

// ---------------------------------------------------------------------------
// 主体
// ---------------------------------------------------------------------------

/**
 * 跑整套 A/B/C/D。**调用方给 CLI 入口与工作目录**，隔离与清理都归本函数。
 *
 * @param {{
 *   cli?: {command: string, args: string[]},
 *   workRoot?: string,
 *   log?: (line: string) => void,
 * }} [options]
 * @returns {Promise<{assertions: string[], notes: string[], workRoot: string}>}
 */
export async function runCliContinuitySmoke(options = {}) {
  const cli = options.cli ?? { command: process.execPath, args: [join(ROOT, "bin", "cli.js")] };
  const log = options.log ?? (() => {});
  const ownedRoot = options.workRoot === undefined
    ? mkdtempSync(join(tmpdir(), "erix-cli-continuity-"))
    : options.workRoot;
  mkdirSync(ownedRoot, { recursive: true });

  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const realErixDir = join(realHome, ".erix");
  const realNpmrc = join(realHome, ".npmrc");
  const erixDirBefore = snapshotDir(realErixDir);
  const npmrcBefore = hashFileIfExists(realNpmrc);

  /** @type {string[]} */
  const assertions = [];
  /** @type {string[]} */
  const notes = [];

  // 假上游的回复由这个可变槽决定（`script` 里的函数每次请求现取）：run 1 = 带 handoff，
  // 之后 = 纯文本。用**可变槽**而不是按下标排 script，是因为「每个 run 恰好一发请求」是
  // 引擎的现状而不是本脚本的契约——真多一发也不会把后面几条断言错位。
  let reply = HANDOFF_REPLY;
  const upstream = createScriptedUpstream({
    script: [() => jsonResponse({
      choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 5 },
    })],
  });

  try {
    const baseUrl = await upstream.listen();

    /** 造一套「假 HOME + 空 cwd + 空 store 目录」，端点指向本地假上游。 */
    const makeFixture = (name, continuityLeaf) => {
      const home = join(ownedRoot, `${name}-home`);
      const projectDir = join(ownedRoot, `${name}-project`);
      const continuityDir = join(ownedRoot, `${name}-store`);
      mkdirSync(projectDir, { recursive: true });
      writeConfigHome({
        dir: home,
        erix: {
          ...upstreamFields(baseUrl).erixSlot,
          apiKey: "continuity-smoke-key",
          model: "continuity-smoke-model",
          maxOutputTokens: 4096,
          ...(continuityLeaf === undefined ? {} : { continuity: continuityLeaf }),
        },
      });
      return { home, projectDir, continuityDir };
    };

    /** 跑一次 `erix chat`（旗标与 release-check 第 5 步同口径）。 */
    const chat = (fixture, prompt, label) => runCli(cli, [
      "chat", prompt,
      "--max-rounds", "3",
      "--reflection", "off",
    ], {
      cwd: fixture.projectDir,
      env: childEnv(fixture.home, { ERIX_CONTINUITY_DIR: fixture.continuityDir }),
      label,
      timeoutMs: 60_000,
    });

    // ---- 夹具 1：`continuity: { handoff: "prompt" }`，同一 cwd + 同一假 HOME 连跑两次 ----------
    const fixture = makeFixture("prompt", { handoff: "prompt" });

    // ——— run 1：模型顺手写 `<handoff>` ⇒ 引擎落盘 ———
    const run1 = await chat(fixture, "工单 #598：第一轮，结束前写交接块", "erix chat（run 1）");
    if (run1.status !== EXIT_NOT_VERIFIED) {
      fail("A", `run 1 退出码 ${run1.status}，期望 ${EXIT_NOT_VERIFIED}（默认不开 --final-guard → 核验 skipped）`
        + `\nstdout=${tail(run1.stdout)}\nstderr=${tail(run1.stderr)}`);
    }

    // ——— 断言 A：store 文件出现，三段逐字等于 run 1 那三句 ———
    const storeFiles = existsSync(fixture.continuityDir)
      ? readdirSync(fixture.continuityDir).filter((name) => name.endsWith(".json"))
      : [];
    if (storeFiles.length !== 1) {
      fail("A", `continuity store 目录里应有且只有 1 个 .json，实际 ${storeFiles.length} 个`
        + `（目录 ${fixture.continuityDir}；ERIX_CONTINUITY_DIR 没接上 / 收尾没落盘）`
        + `\nstdout=${tail(run1.stdout)}\nstderr=${tail(run1.stderr)}`);
    }
    /** @type {any} */
    let record;
    try {
      record = JSON.parse(readFileSync(join(fixture.continuityDir, storeFiles[0]), "utf8"));
    } catch (error) {
      fail("A", `store 文件读不成 JSON：${/** @type {any} */ (error)?.message ?? error}`);
    }
    const sections = record?.sections ?? {};
    const expected = {
      contract: CONTRACT_LITERAL,
      unfinished: UNFINISHED_LITERAL,
      evidence: EVIDENCE_LITERAL,
    };
    for (const [name, literal] of Object.entries(expected)) {
      if (sections[name] !== literal) {
        fail("A", `store 的 sections.${name} 是 ${JSON.stringify(sections[name])}，期望逐字等于 `
          + `${JSON.stringify(literal)}（原文照抄，不许代写）`);
      }
    }
    if (record?.source !== "model") {
      fail("A", `store 的 source 是 ${JSON.stringify(record?.source)}，期望 "model"（同一次响应里顺手写）`);
    }
    assertions.push(`A 存：store ${storeFiles[0]} 出现，source=model，三段逐字=`
      + `${CONTRACT_LITERAL} / ${UNFINISHED_LITERAL} / ${EVIDENCE_LITERAL}`);
    log(`  A ok — store=${storeFiles[0]}（source=${record.source}）`);

    // ——— run 2：同一 cwd、同一假 HOME、同一 store；模型只回纯文本 ———
    reply = PLAIN_REPLY;
    upstream.reset();
    const run2 = await chat(fixture, "工单 #598：第二轮，只回一句话", "erix chat（run 2）");
    if (run2.status !== EXIT_NOT_VERIFIED) {
      fail("B", `run 2 退出码 ${run2.status}，期望 ${EXIT_NOT_VERIFIED}`
        + `\nstdout=${tail(run2.stdout)}\nstderr=${tail(run2.stderr)}`);
    }

    // ——— 断言 B：run 2 的**首个请求体**逐字含 run 1 的三句 + `<handoff>` 指令 ———
    const firstRequest = upstream.requests[0];
    if (firstRequest === undefined) {
      fail("B", `run 2 一个请求也没发到假上游（端点没接上？）\nstdout=${tail(run2.stdout)}`);
    }
    const firstBody = String(firstRequest.bodyText ?? "");
    const firstText = requestText(firstRequest);
    const problems = [
      missingLiteral(firstBody, "上一轮 contract", CONTRACT_LITERAL),
      missingLiteral(firstBody, "上一轮 unfinished", UNFINISHED_LITERAL),
      missingLiteral(firstBody, "上一轮 evidence", EVIDENCE_LITERAL),
      firstBody.includes(HANDOFF_MARKER_START)
        ? undefined
        : `请求体里没有 ${HANDOFF_MARKER_START} 指令（开关开着 ⇒ 每请求都要注入）`,
      firstText.includes(HANDOFF_INSTRUCTION)
        ? undefined
        : "请求体里没有完整的 HANDOFF_INSTRUCTION（措辞必须逐字来自 src/loop/continuity-block.js）",
    ].filter((item) => item !== undefined);
    if (problems.length > 0) {
      fail("B", `run 2 的首个请求体不满足「逐字召回 + 指令在位」：\n  - ${problems.join("\n  - ")}`
        + `\nbody(tail)=${tail(firstBody, 1200)}`);
    }
    assertions.push(`B 召回：run 2 首个请求体逐字含 ${CONTRACT_LITERAL} / ${UNFINISHED_LITERAL} / `
      + `${EVIDENCE_LITERAL}，且含 <handoff> 指令（HANDOFF_INSTRUCTION 整段）`);
    const excerpt = continuityExcerpt(firstText);
    notes.push(`run 2 首个请求体里的续接块原文：\n${excerpt}`);
    log(`  B ok — run 2 首个请求体（${firstBody.length} 字节）里三段与指令都在位`);
    log(`  B 证据 — 续接块原文：\n${excerpt}`);

    // ---- 夹具 2：同一套夹具，**不写** `continuity` 这个叶 ⇒ 默认关 ———
    reply = PLAIN_REPLY;
    upstream.reset();
    const offFixture = makeFixture("default-off", undefined);
    const offRun = await chat(offFixture, "工单 #598：默认关，只回一句话", "erix chat（默认关）");
    if (offRun.status !== EXIT_NOT_VERIFIED) {
      fail("C", `默认关那次 chat 退出码 ${offRun.status}，期望 ${EXIT_NOT_VERIFIED}`
        + `\nstdout=${tail(offRun.stdout)}\nstderr=${tail(offRun.stderr)}`);
    }
    const offRequest = upstream.requests[0];
    if (offRequest === undefined) {
      fail("C", `默认关那次 chat 一个请求也没发到假上游\nstdout=${tail(offRun.stdout)}`);
    }
    const offBody = String(offRequest.bodyText ?? "");
    const offText = requestText(offRequest);
    if (offBody.includes(HANDOFF_MARKER_START) || offText.includes(HANDOFF_INSTRUCTION)) {
      fail("C", `默认关（配置里没有 continuity 这个叶）时请求体仍然带着 ${HANDOFF_MARKER_START} 指令`
        + `——「默认关 = 零行为变更」被破坏\nbody(tail)=${tail(offBody, 1200)}`);
    }
    if (existsSync(offFixture.continuityDir)) {
      fail("C", `默认关时 continuity 目录被创建了（${offFixture.continuityDir}）——`
        + `off 档必须「连路径都不算」`);
    }
    assertions.push("C 默认关：配置里不写该叶 ⇒ 请求体不含 <handoff>、continuity 目录未创建");
    log("  C ok — 请求体无 <handoff>，store 目录未创建");

    // ---- 夹具 3：非法字面量 ⇒ load 期报错并列出合法值（D） ———
    const before = upstream.requestCount;
    const badFixture = makeFixture("illegal", { handoff: "on" });
    const badRun = await chat(badFixture, "工单 #598：非法值不该跑起来", "erix chat（非法值 on）");
    const combined = `${badRun.stdout}\n${badRun.stderr}`;
    if (badRun.status !== EXIT_USAGE) {
      fail("D", `handoff: "on" 的 chat 退出码 ${badRun.status}，期望 ${EXIT_USAGE}（load 期就该报错）`
        + `\nstdout=${tail(badRun.stdout)}\nstderr=${tail(badRun.stderr)}`);
    }
    const legalList = "可选值：off | prompt | prompt-and-fallback";
    if (!combined.includes(legalList)) {
      fail("D", `报错里没有列出全部合法值（期望含 ${JSON.stringify(legalList)}）`
        + `\nstderr=${tail(badRun.stderr)}`);
    }
    if (upstream.requestCount !== before) {
      fail("D", `非法值那次仍然发出了 ${upstream.requestCount - before} 个请求——`
        + `它应该在装配阶段就被挡下`);
    }
    assertions.push(`D 非法值：handoff: "on" 退 ${badRun.status} 并列出 ${legalList}，零请求`);
    log(`  D ok — 非法值退 ${badRun.status}，零请求，报错里列全三个合法值`);

    // ---- 真实用户配置对账（污染不许悄悄发生） ----
    const pollution = [];
    if (snapshotDir(realErixDir) !== erixDirBefore) pollution.push(`真实 ${realErixDir} 的目录形状/时间戳变了`);
    if (hashFileIfExists(realNpmrc) !== npmrcBefore) pollution.push(`真实 ${realNpmrc} 内容变了`);
    if (pollution.length > 0) {
      throw new Error(`污染了真实用户配置：\n  ${pollution.join("\n  ")}`);
    }
    notes.push(`真实 ~/.erix 与 ~/.npmrc 前后一致（${erixDirBefore}｜npmrc=${npmrcBefore.slice(0, 12)}…）`);
    notes.push(`断言全绿：A 存 / B 召回 / C 默认关 / D 非法值（CLI 入口 ${cli.command} ${cli.args.join(" ")}）`);

    return { assertions, notes, workRoot: ownedRoot };
  } finally {
    await upstream.close();
    if (options.workRoot === undefined) {
      try {
        rmSync(ownedRoot, { recursive: true, force: true });
      } catch {
        // 清理失败不许盖掉真正的失败原因
      }
    }
  }
}

/** @param {string} text @param {number} [limit] */
function tail(text, limit = 900) {
  const trimmed = String(text ?? "").trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

// ---------------------------------------------------------------------------
// 直接运行（`node scripts/cli-continuity-smoke.mjs`）
// ---------------------------------------------------------------------------

const isDirectRun = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const savedProxyValues = new Map(PROXY_VARS.map((name) => [name, process.env[name]]));
  for (const name of PROXY_VARS) delete process.env[name];
  process.on("exit", () => {
    for (const [name, value] of savedProxyValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const startedAt = Date.now();
  try {
    const result = await runCliContinuitySmoke({ log: (line) => console.log(line) });
    for (const line of result.assertions) console.log(`cli-continuity-smoke: ${line}`);
    for (const note of result.notes) console.log(`cli-continuity-smoke: ${note}`);
    const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    console.log(`cli-continuity-smoke: OK — A/B/C/D 全绿，${seconds}s`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`cli-continuity-smoke: FAIL — ${message}`);
    process.exitCode = 1;
  }
}
