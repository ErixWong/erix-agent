#!/usr/bin/env node
// 装后 CLI 打**真上游**（工单 docs/tasks/261015-e2e-harness.md 第 4 项，T5）。
//
//   ERIX_E2E_REAL=1 npm run check:cli-real
//
// 为什么还要这一条：`check:release` 的第 5 步（CLI 冒烟）打的是**本地假上游**，
// 它证明的是「装好的包能跑通一次退出码/归档」，不证明「装好的包在真服务端 + 真模型
// 的分片行为下仍然如此」。真 relay 的分片、真工具执行、真轮数节奏只有真上游能给
// （`examples/tool-fact-e2e.test.mjs` 覆盖的是**库 API**，这里是**装后的 CLI 二进制**）。
//
// 闸门与配置来源与两个 gate 测试共用 `examples/e2e-real-gate.mjs`：
// `ERIX_E2E_REAL=1` 才跑，否则**退出码 0 + 分类说明**（gate 缺失 / 配置缺失 / JSON 坏了 /
// 缺字段 / 端点不可达），真上游不许变成任何默认门禁的硬依赖。
//
// 隔离纪律（照 `scripts/release-check.mjs` 的先例）：
// - `npm pack` / `npm i` 一律带一次性 `--cache` 与 `--userconfig`，子进程清掉 `npm_config_*`
//   与代理变量（含 `NODE_USE_ENV_PROXY`）→ 真实 `~/.npmrc` 一个字节都不动（前后哈希对账）。
// - 子进程 `HOME` 指到临时假 HOME，配置从真配置**复制**过来（凭据只在临时文件里，不落仓库）。
// - transcript 走 `--dir <临时目录>`，笔记/待办关掉 → 真实 `~/.erix` 前后清单对账必须一致。
// - `prepack` 会在仓库里生成 `src/**/*.d.ts`：跑之前不存在、跑完出现了的那些，一律删掉
//   （残留会让 `npm run check:types` 假绿）。
// - 临时目录 `mkdtemp(os.tmpdir())` + `finally` 与 `exit` 钩子双保险删除。
//
// 零依赖：只用 node: 内置 + 仓内相对路径（`fixtures/config-shape.mjs` 写配置形状）。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { fakeHomeEnv, writeConfigHome } from "../fixtures/config-shape.mjs";
import { formatSkip, printableEndpoint, resolveRealUpstream, TMP_PREFIX } from "../examples/e2e-real-gate.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const PACKAGE_VERSION = String(PACKAGE_JSON.version);
/** `bin/cli.js` 帮助里承诺的退出码（不是本脚本自创的期望）。 */
const EXIT_NOT_VERIFIED = 4;
const PROXY_VARS = [
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY",
];
/** 真配置槽位里要复制进临时配置的键（凭据只进临时文件）。 */
const SLOT_KEYS_TO_COPY = [
  "protocol", "endpoint", "apiKey", "apiKeyEnv", "apiKeyFile",
  "contextWindowTokens", "maxOutputTokens", "compaction",
];
/** 终稿里必须出现的固定标记（证明真上游回了我们要求的内容，而不是只跑了个流程）。 */
const MARKER = "T5-CLI-REAL-SMOKE-OK";

const tmpRoot = mkdtempSync(join(tmpdir(), TMP_PREFIX.cliReal));
const realHome = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
/** @type {string[]} */ const notes = [];

process.on("exit", () => {
  cleanupGeneratedDeclarations();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function log(message) {
  console.log(`[check:cli-real] ${message}`);
}

function run(command, args, { cwd, env, timeoutMs = 180_000, label } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const name = label ?? `${command} ${args.join(" ")}`;
  if (result.error) {
    return { status: -1, stdout: result.stdout ?? "", stderr: String(result.error.message), name };
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.signal !== undefined && result.signal !== null,
    name,
  };
}

/** 子进程环境：清代理 + 清 npm 的配置外泄通道 + 可选假 HOME */
function childEnv({ home, extra } = {}) {
  const base = { ...process.env };
  for (const name of PROXY_VARS) delete base[name];
  for (const name of Object.keys(base)) {
    if (/^npm_config_/u.test(name)) delete base[name];
  }
  const env = home ? fakeHomeEnv(base, { home }) : base;
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = String(value);
  }
  return env;
}

// —— 真实 HOME 的污染对账（与 release-check 同一口径）——

function snapshotDir(dir) {
  if (!existsSync(dir)) return `${dir}（不存在）`;
  let count = 0;
  let newest = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        count += 1;
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  };
  walk(dir);
  return `${count} 个文件，最新 mtime=${newest ? new Date(newest).toISOString() : "无"}`;
}

function hashFileIfExists(file) {
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16) : "（不存在）";
}

function listGeneratedDeclarations() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".d.ts")) out.push(full);
    }
  };
  if (existsSync(join(ROOT, "src"))) walk(join(ROOT, "src"));
  return out;
}

const declarationsBefore = new Set(listGeneratedDeclarations());
const erixDirBefore = snapshotDir(join(realHome, ".erix"));
const npmrcBefore = hashFileIfExists(join(realHome, ".npmrc"));
const erixConfigBefore = hashFileIfExists(join(realHome, ".erix", "config.json"));

function cleanupGeneratedDeclarations() {
  for (const file of listGeneratedDeclarations()) {
    if (!declarationsBefore.has(file)) rmSync(file, { force: true });
  }
}

// —— 逐条打点的断言器（报告要贴的就是这张表）——

/** @type {string[]} */ const failures = [];
function check(id, fn, detail = "") {
  try {
    fn();
    log(`PASS [4] ${id}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    failures.push(id);
    log(`FAIL [4] ${id}  — ${String(error?.message ?? error).split("\n")[0]}`
      + (detail ? ` ｜ 现场：${detail}` : ""));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}：实际 ${a}，期望 ${b}`);
}

/** 只从消息数组取内容块（真机 e2e 的坑 ①：断言打在块本体上，不在整段 JSON 上找子串） */
function blocksOf(messages, type) {
  return (messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === type);
}

/** RoundRecord.messages 只存本轮新增消息（坑 ②）：按轮拼回完整历史 */
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

async function main() {
  const gate = await resolveRealUpstream({ probeTimeoutMs: 8_000 });
  if (!gate.ok) {
    log(`SKIP — ${formatSkip(gate)}`);
    process.exitCode = 0;
    return;
  }
  log(`闸门开：model=${gate.model} endpoint=${printableEndpoint(gate.endpoint)}`);

  const npmEnv = childEnv({
    extra: {
      npm_config_cache: join(tmpRoot, "npm-cache"),
      npm_config_userconfig: join(tmpRoot, "npmrc"),
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
  writeFileSync(join(tmpRoot, "npmrc"), "", "utf8");

  // ① 打包（触发仓内 prepack 生成 .d.ts；跑完由 exit 钩子清理）
  const packDir = join(tmpRoot, "pack");
  mkdirSync(packDir, { recursive: true });
  const pack = run(NPM, [
    "pack", `--pack-destination=${packDir}`,
    `--userconfig=${join(tmpRoot, "npmrc")}`, `--cache=${join(tmpRoot, "npm-cache")}`,
  ], { cwd: ROOT, env: npmEnv, label: "npm pack", timeoutMs: 240_000 });
  assert(pack.status === 0, `npm pack 退出码 ${pack.status}\n${pack.stderr.slice(-800)}`);
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  assert(tarballs.length === 1, `pack 目录里应有且只有 1 个 tgz，实际：${tarballs.join(",")}`);
  const tarball = join(packDir, tarballs[0]);
  notes.push(`tarball=${tarballs[0]}（${statSync(tarball).size} 字节）`);

  // ② 装进一次性临时项目（--offline：装本地 tarball，不需要 npm 网络）
  const hostDir = join(tmpRoot, "host");
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, "package.json"), JSON.stringify({
    name: "t5-cli-real-host", private: true, type: "module",
  }, null, 2), "utf8");
  const install = run(NPM, [
    "i", "--offline", "--no-audit", "--no-fund",
    `--cache=${join(tmpRoot, "npm-cache")}`, `--userconfig=${join(tmpRoot, "npmrc")}`,
    tarball,
  ], { cwd: hostDir, env: npmEnv, label: "npm i <tarball>", timeoutMs: 240_000 });
  assert(install.status === 0, `临时项目安装失败，退出码 ${install.status}\n${install.stderr.slice(-800)}`);
  const installedRoot = join(hostDir, "node_modules", "erix-agent");
  assert(existsSync(join(installedRoot, "package.json")), "装好的 erix-agent/package.json 不存在");
  assertDeepEqual(
    JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")).version,
    PACKAGE_VERSION,
    "装好的包版本必须等于 package.json（版本号不许被本单动过）",
  );
  const erixBin = join(hostDir, "node_modules", ".bin", process.platform === "win32" ? "erix.cmd" : "erix");
  assert(existsSync(erixBin), `装好的 CLI 入口不存在：${erixBin}`);

  // ③ 假 HOME：配置从真配置**复制**（模型名不硬编码；凭据只进临时文件）
  const home = join(tmpRoot, "home");
  const copiedSlot = { model: gate.model };
  for (const key of SLOT_KEYS_TO_COPY) {
    if (gate.slot[key] !== undefined) copiedSlot[key] = gate.slot[key];
  }
  // `writeConfigHome` 吃的就是「槽位字段」本身（它内部才包 `slots.default`），不要先包一层。
  const { configPath } = writeConfigHome({ dir: home, erix: copiedSlot });
  assert(configPath !== undefined && existsSync(configPath), "假 HOME 的配置没写出来");
  const env = childEnv({ home });

  // ④ 用**装好的 erix**（不是 node bin/cli.js）打真上游，跑一个 ≥2 次工具的任务
  const workDir = join(tmpRoot, "work");
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, "notes.md"), "T5 真机装后冒烟标记行：needle-in-a-haystack\n第二行没有关键字\n", "utf8");
  const transcripts = join(tmpRoot, "transcripts");
  const cliResult = run(erixBin, [
    "chat",
    [
      "严格按顺序做三件事，每件事一次工具调用：",
      "1) readFile 读 notes.md；",
      "2) exec 运行 `node -p \"6*7\"`；",
      `3) 最后一行只输出固定标记 ${MARKER}，并在它前面写上关键字出现的次数与上一步的数字。`,
    ].join(" "),
    "--config", configPath,
    "--dir", transcripts,
    "--max-rounds", "6",
    "--reflection", "off",
    "--no-notes",
    "--no-todo",
  ], { cwd: workDir, env, label: "erix chat（真上游）", timeoutMs: 420_000 });

  log(`CLI 退出码=${cliResult.status}${cliResult.timedOut ? "（超时）" : ""}`);
  log(`CLI stdout 尾部：\n${cliResult.stdout.slice(-1200).split("\n").map((l) => `      ${l}`).join("\n")}`);
  if (cliResult.stderr.trim() !== "") {
    log(`CLI stderr 尾部：${cliResult.stderr.slice(-400)}`);
  }

  check("C1 无 --final-guard 的成功 run 退出码是 4（verification=skipped 的承诺）", () => {
    assert(cliResult.status === EXIT_NOT_VERIFIED,
      `退出码 ${cliResult.status}，期望 ${EXIT_NOT_VERIFIED}`);
  });
  check("C2 真上游真的回了要求的内容（固定标记在 stdout 里）", () => {
    assert(cliResult.stdout.includes(MARKER), `stdout 里没有 ${MARKER}`);
  });

  // ⑤ transcript 字段面（与 examples/tool-fact-e2e.test.mjs 的第 3/4 条同形）
  const { TOOL_RESULT_CONTRACT: contract } = await import(pathToFileURL(join(installedRoot, "src", "index.js")).href);
  const allowed = new Set([
    ...contract.protocol.required, contract.engine.ns, contract.host.ns,
    ...(contract.protocol.conditional?.is_error !== undefined ? ["is_error"] : []),
  ]);
  const retired = Object.keys(contract.legacy.aliases).filter((name) => !name.includes("@"));
  const jsonlFiles = existsSync(transcripts)
    ? readdirSync(transcripts).filter((name) => name.endsWith(".jsonl"))
    : [];
  check("C3 CLI 把 transcript 写进了 --dir 指的临时目录（真 ~/.erix 没被写）", () => {
    assert(jsonlFiles.length >= 1, `--dir 目录下没有 jsonl：${jsonlFiles.join(",") || "无"}`);
  });
  const transcriptPath = join(transcripts, jsonlFiles[0] ?? "");
  const records = jsonlFiles.length > 0
    ? readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l))
    : [];
  const history = collapseHistory(records);
  const results = blocksOf(history, "tool_result");
  const durations = results.map((block) => block?.erix?.durationMs);
  const usage = records.reduce((acc, record) => {
    const u = record?.response?.usage ?? {};
    acc.input += Number(u.input_tokens ?? u.prompt_tokens ?? 0);
    acc.output += Number(u.output_tokens ?? u.completion_tokens ?? 0);
    return acc;
  }, { input: 0, output: 0 });

  check("C4 装后的 CLI 真跑了 ≥2 次工具（不是空转）", () => {
    assert(results.length >= 2, `落盘 tool_result=${results.length}，RoundRecord=${records.length}`);
    assert(usage.input > 0 && usage.output > 0, `用量必须非零，实际 ${JSON.stringify(usage)}`);
  }, `RoundRecord=${records.length}，↑${usage.input}/↓${usage.output}`);
  check("C5 落盘 tool_result 顶层键集合 ⊆ 契约集合，退役名不在顶层", () => {
    const problems = [];
    for (const block of results) {
      for (const key of Object.keys(block)) if (!allowed.has(key)) problems.push(`${block.tool_use_id}:${key}`);
      for (const name of retired) if (Object.hasOwn(block, name)) problems.push(`${block.tool_use_id}:${name}`);
    }
    assertDeepEqual(problems, [], "顶层多出来的键");
  }, `允许集合=[${[...allowed].sort().join(",")}]`);
  check("C6 erix 事实面齐（tc_ 前缀 / round / durationMs ≥0 且至少一个 >0 / success 布尔）", () => {
    for (const block of results) {
      assert(typeof block?.erix?.toolCallKey === "string" && block.erix.toolCallKey.startsWith("tc_"),
        `身份键缺失：${block?.tool_use_id}`);
      assert(Number.isFinite(block?.erix?.round), `round 非有限：${block?.erix?.round}`);
      assert(Number.isFinite(block?.erix?.durationMs) && block.erix.durationMs >= 0,
        `durationMs 非有限/为负：${block?.erix?.durationMs}`);
      assert(typeof block?.erix?.success === "boolean", "success 非布尔");
    }
    assert(durations.some((d) => d > 0), `真执行必须有非 0 耗时：${JSON.stringify(durations)}`);
  }, JSON.stringify(durations));

  // ⑥ 投影用**装好的包**跑（宿主 UI 的镜像也必须是新形状）
  const { projectTranscriptForDisplay } = await import(pathToFileURL(join(installedRoot, "src", "index.js")).href);
  const calls = projectTranscriptForDisplay(records).flatMap((card) => card?.toolCalls ?? []);
  check("C7 装好的包投影的每条 toolCalls 带 toolCallKey，durationMs 只透真实值", () => {
    assert(calls.length >= 2, `投影条目=${calls.length}`);
    assert(calls.every((call) => typeof call.toolCallKey === "string" && call.toolCallKey.startsWith("tc_")),
      JSON.stringify(calls.map((call) => call.toolCallKey)));
    assert(calls.every((call) => call.durationMs === undefined
      || (Number.isFinite(call.durationMs) && call.durationMs >= 0)),
    JSON.stringify(calls.map((call) => call.durationMs)));
  }, JSON.stringify(calls.map((call) => ({ k: call.toolCallKey, d: call.durationMs, n: call.name }))));

  // ⑧ 真实 HOME 没被污染
  //
  // 与 `scripts/release-check.mjs` 的一个**有意识差异**：那边整棵 `~/.erix` 前后快照必须逐字相等。
  // 本单跑在开发者机器上，同时可能有其它 session 在往 `~/.erix/transcripts` 写东西（那些写入与本脚本无关，
  // 把它们算成本脚本的污染就是假红）。所以硬断言盯的是**本脚本能碰到的两个文件**：
  // `~/.npmrc`（子 npm 本可默认读它）与 `~/.erix/config.json`（真配置本身）；整棵目录树的前后快照
  // 作为备注输出，变了但非本脚本所为时可以人工判定。本脚本的子进程 HOME 全部指临时假 HOME，
  // 不存在能写真实 `~/.erix` 的路径。
  check("C8 真实 ~/.npmrc 与 ~/.erix/config.json 前后一致（本脚本只碰临时目录）", () => {
    assert(hashFileIfExists(join(realHome, ".npmrc")) === npmrcBefore,
      `~/.npmrc 内容变了（${npmrcBefore} → ${hashFileIfExists(join(realHome, ".npmrc"))}）`);
    assert(hashFileIfExists(join(realHome, ".erix", "config.json")) === erixConfigBefore,
      "真配置 ~/.erix/config.json 被改写了");
    assert(hashFileIfExists(join(realHome, ".erix", "config.json")) !== "（不存在）",
      "真配置本应在（不在就说明闸门与配置解析两边对不上）");
  }, `~/.erix 快照：前=${erixDirBefore} 后=${snapshotDir(join(realHome, ".erix"))}`);

  for (const note of notes) log(`备注：${note}`);
  assertDeepEqual(failures, [], `失败的断言：${failures.join(", ")}`);
  log(`全绿：装后的 erix@${PACKAGE_VERSION} 打真上游（模型 ${gate.model}）退出码 4，`
    + `工具 ${results.length} 次，↑${usage.input}/↓${usage.output}`);
}

main().then(() => {
  // 失败靠 process.exitCode，不用 throw（throw 会把已经跑完的断言表埋在栈里）
  if (failures.length > 0) process.exitCode = 1;
}, (error) => {
  log(`脚本自身失败：${error?.stack ?? error}`);
  process.exitCode = 1;
});
