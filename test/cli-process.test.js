// 真把 CLI 起成一个**子进程**的对外契约测试（issue #257 T2）。
//
// 为什么要有这一层：`bin/cli.js` 的四类对外承诺——**命令行参数怎么解析、退出码是几、
// stdout/stderr 打了什么、跑完磁盘上落了哪些文件**——此前没有任何一条用例真的起进程去验。
// 已发生的实例：issue #168 把 `chat --session <不存在的 id>` 从「静默新建」改成「报错退出」，
// 全量测试一条也没红（`test/cli.test.js` 那层是函数级调用，进程边界之外的事它看不见）。
// 本文件只加进程级用例，不替代函数级用例。
//
// 四条环境纪律（每一条都是实测踩出来的，改测试前先读）：
// 1. **假 HOME**：`HOME`/`USERPROFILE` 指向一次性临时目录，配置写 `<HOME>/.erix/config.json`
//    （`bin/config.js` 的 `defaultConfigPath`：`XDG_CONFIG_HOME` 优先，所以子进程环境里必须删掉
//    `XDG_CONFIG_HOME`，否则会读宿主用户的真实配置）。绝不允许写真实 `~/.erix`——「成功一条」
//    那条用例反查真实 HOME 里有没有出现本 run 的目录哈希，把这条规矩也钉住。
//    配置文件的**形状**不在本文件里造：拿 `fixtures/config-shape.mjs`（issue #257 T3）。
// 2. **slot 里的端点字段名是 `endpoint`，不是 `baseUrl`**（`bin/config.js` 只读 `fileConfig.endpoint`，
//    `src/config/json-file.js` 原样透传 slot）。写成 `baseUrl` 的失败形状是 exit 1 +
//    「缺少环境变量：LLM_KIT_ENDPOINT」，一条请求也不会发出去。该键名现在由构造器
//    `upstreamFields()` 给出，写反了整套用例会红（不再靠注释守）。
// 3. **不联网**：模型端点是 `fixtures/upstream.mjs` 的真 socket 夹具（绑 `127.0.0.1:0`）。
//    每条跑模型的用例都断言上游真的收到了请求（`requestCount` / `waitForRequests`）——
//    否则「绿了但根本没发请求」看不出来。
// 4. **代理防御**：宿主若设了 `NODE_USE_ENV_PROXY=1`，`127.0.0.1` 也会被送给代理；
//    所以进出都保存并清理代理变量，子进程环境里也一律删掉。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTmp } from "./helpers/tmp.js";
import {
  createScriptedUpstream,
  jsonResponse,
  openAITextChunks,
  sseOpenAI,
  sseResponse,
} from "../fixtures/upstream.mjs";
import { upstreamFields, writeConfigHome } from "../fixtures/config-shape.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = join(REPO_ROOT, "bin", "cli.js");
const README_PATH = join(REPO_ROOT, "README.md");
const CONTRACT_DOC_PATH = join(REPO_ROOT, "docs", "host-consumer-contract.md");
const CONTRACT_DOC_CN_PATH = join(REPO_ROOT, "docs", "host-consumer-contract_cn.md");

/** 每个子进程的硬超时：卡住的用例必须被杀掉并留下证据，绝不许拖死整个套件。 */
const CHILD_TIMEOUT_MS = 30_000;

// 退出码：以 `bin/cli.js` 的 `HELP_TEXT` 退出码段 + `exitCodeForVerification` 为准。
const EXIT_OK = 0;
const EXIT_USAGE = 1;
// guard=off 时 verification 是 `skipped`，`exitCodeForVerification` 给它 4——
// 于是「不带 --final-guard 的一次成功 chat」当前**不**退 0（README/帮助里那行「0 成功」
// 只在 verified 时成立）。本文件按**当前真实行为**钉住，差异写进 REPORT-T2.md。
const EXIT_NOT_VERIFIED = 4;
// issue #391 R3：交付物判据没过 ⇒ `verification.status = "unverified"` ⇒ exit 2
// （`exitCodeForVerification` 的既有承诺，不是新加的退出码）。
const EXIT_UNVERIFIED = 2;

/** 宿主可能带进来的代理类变量：进出都要保存并清掉。 */
const PROXY_VARS = [
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY",
];

const savedProxyValues = new Map(PROXY_VARS.map((name) => [name, process.env[name]]));
for (const name of PROXY_VARS) delete process.env[name];
after(() => {
  for (const [name, value] of savedProxyValues) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** 子进程环境：宿主的一律不带进来（`ERIX_*`/`LLM_KIT_*`/代理/`XDG_CONFIG_HOME`），只留假 HOME。 */
function childEnvironment({ home, extra = {} }) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:ERIX_|LLM_KIT_)/u.test(name)) delete env[name];
  }
  for (const name of PROXY_VARS) delete env[name];
  delete env.XDG_CONFIG_HOME;
  env.HOME = home;
  env.USERPROFILE = home;
  return { ...env, ...extra };
}

/**
 * 起一个真的 `bin/cli.js` 子进程并收干 stdout/stderr。
 * `code === null` 意味着 30s 超时被杀——调用方的断言会因此失败，这里额外把已收到的
 * 输出贴进错误信息，避免「超时但看不出卡在哪」。
 */
function runCliOnce({ args, home, cwd, env = {} }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: childEnvironment({ home, extra: env }),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CHILD_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === null) {
        rejectPromise(new Error(
          `CLI 子进程被 ${signal ?? "超时"} 终止（args=${JSON.stringify(args)}）`
          + `\nstdout(tail)=${JSON.stringify(stdout.slice(-400))}`
          + `\nstderr(tail)=${JSON.stringify(stderr.slice(-400))}`,
        ));
        return;
      }
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function writeCliConfig(home, baseUrl) {
  // 形状不在这儿造：拿 `fixtures/config-shape.mjs`（全仓唯一一份真配置形状），
  // 上游 URL 填进哪个键由 `upstreamFields()` 定（形状 A 是 `endpoint`）。
  // model 走 slot，不用环境变量，这样「配置来自假 HOME」这件事本身也是被测路径。
  writeConfigHome({
    dir: home,
    erix: {
      ...upstreamFields(baseUrl).erixSlot,
      apiKey: "t2-test-key",
      model: "t2-model",
    },
  });
}

/**
 * 一次性沙箱：假 HOME + 项目目录 + 真上游夹具。夹具在 `t.after()` 里关（漏关会挂住套件）。
 */
async function makeSandbox(t, { script, withConfig = true } = {}) {
  const root = await makeTmp("erix-cli-");
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".erix"), { recursive: true });
  mkdirSync(project, { recursive: true });
  const upstream = createScriptedUpstream({ script: script ?? [] });
  t.after(() => upstream.close());
  const baseUrl = await upstream.listen();
  if (withConfig) writeCliConfig(home, baseUrl);
  const transcriptsDir = join(home, ".erix", "transcripts");
  return {
    root,
    home,
    project,
    upstream,
    baseUrl,
    transcriptsDir,
    run: (args, options = {}) => runCliOnce({ args, home, cwd: project, ...options }),
  };
}

// OpenAI 协议的非流式回复（CLI 不带 --stream 时走 provider.chat → JSON body）。
function replyWithText(text) {
  return jsonResponse({
    choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  });
}

function replyWithToolCall(name, args, id) {
  return jsonResponse({
    choices: [{
      message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: "tool_calls",
    }],
  });
}

/** 跑模型时统一带的旗标：把轮数与反思压到最小，别把 judge 的额外调用混进请求计数。 */
const MINIMAL_CHAT_FLAGS = ["--max-rounds", "3", "--reflection", "off"];

function listJsonl(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}

function listDir(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * 「报错退出前什也没跑」的落盘断言（当前行为）：transcript 一个也没多，但
 * `bin/assembly-root.js` 在会话存在性检查**之前**就把归档根目录建出来了，于是
 * transcripts 目录会多出 `outputs/<那个 id>/` 这个**空目录**（无任何文件）。
 * 断到这一层而不是只断「无 transcript」，是为了让「将来真往这里写了东西」也能红。
 */
function assertEmptyArchiveOnly(transcriptsDir, sessionId) {
  assert.deepEqual(listJsonl(transcriptsDir), [], "会话不存在时不许落任何 transcript");
  assert.deepEqual(listDir(transcriptsDir), ["outputs"], `当前行为：只多一个归档根目录，实得 ${JSON.stringify(listDir(transcriptsDir))}`);
  assert.deepEqual(listDir(join(transcriptsDir, "outputs")), [sessionId], "outputs/ 下只该有那个从未跑过的 id 的空目录");
  assert.deepEqual(listDir(join(transcriptsDir, "outputs", sessionId)), [], "那个归档目录必须是空的（judge.log 等一个也没写）");
}

/**
 * 会话 id 的目录前缀（`<目录名>-<sha256(绝对路径) 前 8 位>`）。
 * 这里**故意重新实现一份**而不是 import `bin/session-scan.js`：进程级契约要钉的是
 * 「文档写死的这个形状」本身，借被测端的实现来断言就等于让它自己证明自己。
 */
function expectedScanPrefix(dir) {
  const normalized = resolve(dir);
  const baseName = basename(normalized) || "root";
  return `${baseName}-${createHash("sha256").update(normalized).digest("hex").slice(0, 8)}`;
}

/** `--help` 的「退出码：」段 → Map<码, 同行描述>（按行抓，不硬编码整段文本）。 */
function parseExitCodeSection(text, header) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  assert.notEqual(start, -1, `找不到退出码段表头 ${JSON.stringify(header)}`);
  const entries = new Map();
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (/^\S/u.test(line)) break; // 顶到行首的非缩进行 = 下一段
    const match = /^\s*(\d{1,2})\s+(\S.*)$/u.exec(line);
    if (match) entries.set(Number(match[1]), match[2].trim());
  }
  assert.ok(entries.size > 0, "退出码段没解析出任何条目（格式漂移了）");
  return entries;
}

/** 文档里那张「verification.status ↔ CLI 退出码」表 → 退出码集合（按表头定位，抗重排）。 */
function parseDocTableExitCodes(markdown, headerNeedle) {
  const rows = markdown.split("\n").filter((line) => line.trim().startsWith("|"));
  const headerIndex = rows.findIndex((line) => line.includes(headerNeedle));
  assert.notEqual(headerIndex, -1, `文档里找不到含 ${JSON.stringify(headerNeedle)} 的表头`);
  const codes = new Set();
  for (const row of rows.slice(headerIndex + 1)) {
    if (/^\|\s*[-:|\s]+\|\s*$/u.test(row.trim())) continue; // 分隔行
    const cells = row.split("|").map((cell) => cell.trim()).filter((cell) => cell !== "");
    const last = cells.at(-1) ?? "";
    const match = /^`?(\d{1,2})`?$/u.exec(last);
    if (match) codes.add(Number(match[1]));
  }
  assert.ok(codes.size > 0, "文档退出码表没解析出任何码（格式漂移了）");
  return codes;
}

/** README 散文里对退出码的引用（`exit code (4)` / `` exit code `4` `` / 退出码 `1` …）。 */
function parseREADMEExitCodes(markdown) {
  const codes = new Set();
  const patterns = [
    /exit\s+codes?\s*\(?\s*`(\d{1,2})`/giu,
    /exit\s+codes?\s*\(?\s*(\d{1,2})\b/giu,
    /exits?\s+with\s+code\s+`?(\d{1,2})`?/giu,
    /退出码\s*`(\d{1,2})`/gu,
  ];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) codes.add(Number(match[1]));
  }
  return codes;
}

describe("真起 CLI 子进程：参数、退出码、stdout/stderr、落盘（issue #257 T2）", () => {
  it("--help：退出 0、输出帮助，且退出码集合与文档表格逐条对齐", async () => {
    const root = await makeTmp("erix-cli-help-");
    const help = await runCliOnce({ args: ["--help"], home: root, cwd: root });
    assert.equal(help.signal, null);
    assert.equal(help.code, EXIT_OK, `--help 应退出 0，stderr=${JSON.stringify(help.stderr.slice(0, 200))}`);
    assert.match(help.stdout, /erix chat "<prompt>"/u);
    assert.equal(help.stderr, "", "--help 不该往 stderr 写东西");

    const helpCodes = parseExitCodeSection(help.stdout, "退出码：");
    // README 承诺的两个码必须存在：0（成功/verified）与 1（用法错误 / 会话不存在）。
    assert.ok(helpCodes.has(EXIT_OK), "帮助里缺少退出码 0 那一行");
    assert.ok(helpCodes.has(EXIT_USAGE), "帮助里缺少退出码 1 那一行");
    for (const [code, description] of helpCodes) {
      assert.ok(description.length > 1, `退出码 ${code} 那一行没有描述文字`);
    }
    // issue #168 的对外承诺就写在这一行里：码 1 必须提「会话不存在」，码 4 必须提「核验未执行」。
    assert.match(helpCodes.get(EXIT_USAGE), /会话/u);
    assert.ok(helpCodes.has(EXIT_NOT_VERIFIED), "帮助里缺少退出码 4（skipped）那一行");

    // 文档侧：host-consumer-contract 表格里出现的每个退出码，帮助里都必须有；EN/CN 两张表必须一致。
    const docCodes = parseDocTableExitCodes(readFileSync(CONTRACT_DOC_PATH, "utf8"), "CLI exit code");
    const docCodesCn = parseDocTableExitCodes(readFileSync(CONTRACT_DOC_CN_PATH, "utf8"), "CLI 退出码");
    assert.deepEqual(docCodesCn, docCodes, "中英两份契约文档的退出码集合不一致");
    for (const code of docCodes) {
      assert.ok(helpCodes.has(code), `文档承诺退出码 ${code}，但 --help 的退出码段里没有它`);
    }
    // README 散文里引用过的码同样不能漂出帮助那张表（README 没有独立退出码表，见 REPORT 现象）。
    const readmeCodes = parseREADMEExitCodes(readFileSync(README_PATH, "utf8"));
    assert.ok(readmeCodes.size > 0, "README 里没解析出任何退出码引用（格式漂移了）");
    for (const code of readmeCodes) {
      assert.ok(helpCodes.has(code), `README 引用了退出码 ${code}，但 --help 的退出码段里没有它`);
    }
  });

  it("--version / 未知子命令 / chat --help 的参数面", async (t) => {
    const sandbox = await makeSandbox(t, { script: [replyWithText("这条不该被用到 T2-ARGS 任务已完成")] });
    const version = await sandbox.run(["--version"]);
    assert.equal(version.code, EXIT_OK);
    assert.equal(
      version.stdout.trim(),
      JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version,
      "--version 必须报 package.json 的版本号",
    );

    const unknown = await sandbox.run(["bogus-subcommand"]);
    assert.equal(unknown.code, EXIT_USAGE, "未知子命令应 usageError 退 1");
    assert.match(unknown.stderr, /未知子命令/u);
    assert.match(unknown.stderr, /用法：/u, "usageError 要连帮助一起给出路");
    assert.equal(unknown.stdout, "");

    const chatHelp = await sandbox.run(["chat", "--help"]);
    assert.equal(chatHelp.code, EXIT_OK);
    assert.match(chatHelp.stdout, /--session/u);

    const unknownFlag = await sandbox.run(["chat", "你好", "--no-such-flag"]);
    assert.equal(unknownFlag.code, EXIT_USAGE);
    assert.match(unknownFlag.stderr, /未知参数：--no-such-flag/u);
    assert.equal(sandbox.upstream.requestCount, 0, "参数就没过，不该发出任何模型请求");
  });

  it("成功一条：不带 --session 跑 chat，退出码、stdout 与假 HOME 下的落盘形状", async (t) => {
    const sandbox = await makeSandbox(t, { script: [replyWithText("探针回复 T2-HELLO-77 任务已完成")] });
    const result = await sandbox.run(["chat", "打个招呼", ...MINIMAL_CHAT_FLAGS]);

    // 上游真的收到了请求（不是「绿了但没发请求」），而且用的就是假 HOME 配置里的端点。
    assert.ok(await sandbox.upstream.waitForRequests(1, 2_000), "CLI 根本没往模型端点发请求");
    assert.equal(sandbox.upstream.requestCount, 1);
    const request = sandbox.upstream.requests[0];
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/v1/chat/completions");
    assert.match(String(request.headers.authorization ?? ""), /t2-test-key/u);
    assert.equal(request.json.model, "t2-model");

    // 当前行为：guard=off ⇒ verification=skipped ⇒ 退出码 4（不是 0）。见 REPORT「发现的现象」。
    assert.equal(result.code, EXIT_NOT_VERIFIED, `当前行为：guard=off 的成功 run 退 4；stdout=${JSON.stringify(result.stdout.slice(-300))}`);
    assert.match(result.stdout, /探针回复 T2-HELLO-77 任务已完成/u, "终稿文本必须出现在 stdout");
    assert.match(result.stdout, /=== 终稿 ===/u);
    assert.match(result.stdout, /=== 统计 ===/u);
    assert.match(result.stdout, /guard=off/u);
    assert.equal(result.stderr, "");

    // 落盘形状（README「Configuration and local state」那张布局 + judge.log 默认位置）。
    const prefix = expectedScanPrefix(sandbox.project);
    const transcripts = listJsonl(sandbox.transcriptsDir);
    assert.equal(transcripts.length, 1, `transcripts 目录应只落一个会话，实得 ${JSON.stringify(transcripts)}`);
    const sessionId = transcripts[0].replace(/\.jsonl$/u, "");
    assert.ok(
      sessionId.startsWith(`${prefix}-`),
      `派生 id 必须以 <目录名>-<sha256(cwd)[:8]> 开头（期望前缀 ${prefix}，实得 ${sessionId}）`,
    );
    assert.deepEqual(
      listDir(sandbox.transcriptsDir),
      ["outputs", `${sessionId}.jsonl`, `${sessionId}.state.json`, `${sessionId}.status.json`].sort(),
      "当前行为：一次成功 run 落 .jsonl/.state.json/.status.json + outputs/（.status.json 未见于 README 布局，见 REPORT）",
    );
    assert.deepEqual(
      listDir(join(sandbox.transcriptsDir, "outputs")),
      [sessionId],
      "归档目录 outputs/ 下只该有本次 run 的目录",
    );
    assert.ok(
      listDir(join(sandbox.transcriptsDir, "outputs", sessionId)).includes("judge.log"),
      "judge.log 默认落在归档目录里",
    );
    assert.match(readFileSync(join(sandbox.transcriptsDir, `${sessionId}.jsonl`), "utf8"), /T2-HELLO-77/u);

    // 真实 ~/.erix 不能被写：本 run 的目录哈希是唯一标识，真实 HOME 里搜不到它才算隔离成立。
    const hash8 = prefix.split("-").at(-1);
    const realTranscripts = join(homedir(), ".erix", "transcripts");
    const leaked = existsSync(realTranscripts)
      ? readdirSync(realTranscripts).filter((name) => name.includes(hash8))
      : [];
    assert.deepEqual(leaked, [], `真实 ~/.erix/transcripts 被写了：${JSON.stringify(leaked)}`);
  });

  it("--dir 覆盖归档目录：transcripts 落在指定目录，假 HOME 的默认目录不产生", async (t) => {
    const sandbox = await makeSandbox(t, { script: [replyWithText("自定义目录 T2-DIR-7 任务已完成")] });
    const customDir = join(sandbox.root, "custom-transcripts");
    const result = await sandbox.run(["chat", "换个目录", "--dir", customDir, ...MINIMAL_CHAT_FLAGS]);
    assert.equal(result.code, EXIT_NOT_VERIFIED, `stdout=${JSON.stringify(result.stdout.slice(-300))}`);
    assert.equal(listJsonl(customDir).length, 1, "--dir 指定后 transcripts 应落在该目录");
    assert.equal(listDir(sandbox.transcriptsDir).length, 0, "--dir 给了就不该再创建默认的 ~/.erix/transcripts");
  });

  it("--stream：模型的分片文本要真的写到 stdout", async (t) => {
    const sandbox = await makeSandbox(t, {
      script: [sseResponse({ frames: sseOpenAI(openAITextChunks(["流式片段 A", "流式片段 B", " 任务已完成"])) })],
    });
    const result = await sandbox.run(["chat", "流式", "--stream", ...MINIMAL_CHAT_FLAGS]);
    assert.equal(sandbox.upstream.requestCount, 1, "流式路径也必须真的发过请求");
    assert.match(sandbox.upstream.requests[0].bodyText, /"stream":true/u, "--stream 要落到请求体里");
    assert.match(result.stdout, /流式片段 A/u);
    assert.match(result.stdout, /流式片段 B/u);
    assert.equal(result.code, EXIT_NOT_VERIFIED);
  });

  it("--final-guard + 工具调用 + findings：退出 0，且工具真的在磁盘上留了痕", async (t) => {
    const sandbox = await makeSandbox(t, {
      script: [
        replyWithToolCall("exec", { command: "echo T2MARKER=alpha-777 && printf side > t2-tool-side-effect.txt" }, "call-1"),
        replyWithText(JSON.stringify({
          done: true,
          summary: "任务已完成",
          output: "值是 alpha-777",
          findings: { T2MARKER: "alpha-777" },
        })),
      ],
    });
    const result = await sandbox.run(["chat", "跑个工具", "--final-guard", ...MINIMAL_CHAT_FLAGS]);
    assert.equal(sandbox.upstream.requestCount, 2, "一轮工具调用 + 一轮终稿，共两次模型请求");
    assert.equal(result.code, EXIT_OK, `verified 的 run 才退 0；stdout=${JSON.stringify(result.stdout.slice(-400))}`);
    assert.match(result.stdout, /已核验/u);
    assert.match(result.stdout, /guard=\{verified:1/u);
    // 工具是在这个真子进程里真的执行的：它的副作用必须在项目目录里看得见。
    assert.equal(readFileSync(join(sandbox.project, "t2-tool-side-effect.txt"), "utf8"), "side");
    assert.match(result.stdout, /T2MARKER=alpha-777/u, "工具输出要在 stdout 里可见");
  });

  // issue #391 R3：交付物判据的**进程级**证据。函数级用例（test/cli.test.js）只证明
  // 「loopOptions.deliverables 里有这条判据」，看不见退出码与输出——而 exit 2 正是本单对宿主的
  // 承诺面。这一格是 #391 报的「真空通过」在 CLI 层的反例转正：
  // guard 说 accept（findings 逐字对得上归档捕获值 ⇒ 否则它会 revise），但声明的交付物不在盘上
  // ⇒ 机器闸门拦下盖章，终局 unverified:deliverables_failed ⇒ 退出 2。
  it("--final-guard --require-deliverable <缺失路径>：退出 2 + 输出 deliverables_failed（机器证据压过 guard accept）", async (t) => {
    const sandbox = await makeSandbox(t, {
      script: [
        replyWithToolCall("exec", { command: "echo T2MARKER=delta-391" }, "call-1"),
        replyWithText(JSON.stringify({
          done: true,
          summary: "任务已完成",
          output: "值是 delta-391",
          findings: { T2MARKER: "delta-391" },
        })),
      ],
    });
    const result = await sandbox.run([
      "chat", "交付 report.md", "--final-guard",
      "--require-deliverable", "report.md", ...MINIMAL_CHAT_FLAGS,
    ]);
    assert.equal(sandbox.upstream.requestCount, 2, "一轮工具调用 + 一轮终稿");
    assert.equal(
      result.code,
      EXIT_UNVERIFIED,
      `交付物不在盘上必须退 ${EXIT_UNVERIFIED}（不是 0，也不是「guard 关着」的 4）；`
      + `stdout=${JSON.stringify(result.stdout.slice(-500))}`,
    );
    assert.match(result.stdout, /deliverables_failed/u, "输出必须点名原因");
    assert.match(result.stdout, /交付物判据没过/u);
    assert.match(result.stdout, /guard=\{verified:0,skipped:0,revised:0,unverified:1,guard_error:0,deliverables_checked:1,deliverables_failed:1\}/u,
      `统计行要同时给出判据计数；stdout=${JSON.stringify(result.stdout.slice(-400))}`);
    assert.match(result.stdout, /未核验，不可信/u);
    // 盘上确实没有那个文件（判据判的是磁盘事实，不是模型的嘴）
    assert.equal(existsSync(join(sandbox.project, "report.md")), false);
  });

  it("--final-guard --require-deliverable <已写入的路径>：退出 0（判据不是恒假，写到位就放行）", async (t) => {
    const sandbox = await makeSandbox(t, {
      script: [
        replyWithToolCall("exec", { command: "printf done > report.md && echo T2MARKER=epsilon-391" }, "call-1"),
        replyWithText(JSON.stringify({
          done: true,
          summary: "任务已完成",
          output: "值是 epsilon-391",
          findings: { T2MARKER: "epsilon-391" },
        })),
      ],
    });
    const result = await sandbox.run([
      "chat", "交付 report.md", "--final-guard",
      "--require-deliverable", "report.md", ...MINIMAL_CHAT_FLAGS,
    ]);
    assert.equal(result.code, EXIT_OK, `stdout=${JSON.stringify(result.stdout.slice(-500))}`);
    assert.match(result.stdout, /已核验/u);
    assert.match(result.stdout, /deliverables_failed:0/u);
    assert.equal(readFileSync(join(sandbox.project, "report.md"), "utf8"), "done");
  });

  it("--require-deliverable <path> 不带 --final-guard：用法错误（exit 1），一次模型调用都不花", async (t) => {
    const sandbox = await makeSandbox(t, { script: [replyWithText("不该被用到 T2-UNUSED-3 任务已完成")] });
    const result = await sandbox.run(["chat", "随便", "--require-deliverable", "report.md"]);
    assert.equal(result.code, EXIT_USAGE, `stdout=${JSON.stringify(result.stdout.slice(-300))}`);
    assert.match(result.stderr, /--require-deliverable 必须与 --final-guard 同用/u);
    assert.equal(sandbox.upstream.requestCount, 0);
  });

  it("--session <存在的 id>：退出 0/4 同一次成功、且上游第二发带上了历史", async (t) => {
    const sandbox = await makeSandbox(t, {
      script: [replyWithText("第一轮 T2-R1 任务已完成"), replyWithText("第二轮 T2-R2 任务已完成")],
    });
    const first = await sandbox.run(["chat", "第一轮", ...MINIMAL_CHAT_FLAGS]);
    assert.equal(first.code, EXIT_NOT_VERIFIED);
    const sessionId = listJsonl(sandbox.transcriptsDir)[0].replace(/\.jsonl$/u, "");
    const filesAfterFirst = listDir(sandbox.transcriptsDir);

    const resumed = await sandbox.run(["chat", "接着上一轮", "--session", sessionId, ...MINIMAL_CHAT_FLAGS]);
    assert.equal(sandbox.upstream.requestCount, 2);
    assert.equal(resumed.code, first.code, "续跑 run 的退出码该与新建 run 同形（都是 guard=off 的形状）");
    assert.match(resumed.stdout, /第二轮 T2-R2 任务已完成/u);
    const secondRequest = sandbox.upstream.requests[1].bodyText;
    assert.ok(secondRequest.includes("T2-R1"), `续跑必须把上一轮的回复带进请求体：${secondRequest.slice(0, 200)}`);
    assert.ok(secondRequest.includes("接着上一轮"), "本次 prompt 也要在请求体里");
    // 续跑复用同一个 id：不许冒出第二个 transcript（「静默新建」的真凭据）。
    assert.deepEqual(listJsonl(sandbox.transcriptsDir), [`${sessionId}.jsonl`]);
    assert.deepEqual(listDir(sandbox.transcriptsDir), filesAfterFirst);
  });

  it("--session <不存在的 id>：退出非 0、给出可操作出路、且磁盘上没有新增 transcript", async (t) => {
    const sandbox = await makeSandbox(t, { script: [replyWithText("不该被用到 T2-UNUSED 任务已完成")] });
    // 起点先钉住：假 HOME 下连 transcripts 目录都还没建——否则「只多一个空归档目录」会退化成恒真。
    assert.deepEqual(listDir(sandbox.transcriptsDir), []);
    const result = await sandbox.run(["chat", "随便", "--session", "t2-no-such-session"]);

    assert.equal(result.code, EXIT_USAGE, `会话不存在必须非 0；实得 ${result.code}`);
    assert.match(result.stderr, /会话不存在/u);
    assert.match(result.stderr, /t2-no-such-session/u, "文案里要带上用户打错的那个 id");
    // 出路关键词（不断言整段文案）：列可续跑清单、传完整 id、或不带 --session 新建。
    assert.match(result.stderr, /-r/u);
    assert.match(result.stderr, /--session/u);
    assert.match(result.stderr, /不带 --session/u);
    assert.equal(result.stdout, "");
    assertEmptyArchiveOnly(sandbox.transcriptsDir, "t2-no-such-session");
    assert.equal(sandbox.upstream.requestCount, 0, "会话都不存在，不该花一次模型调用");
  });

  it("--session <全新名字>（chat 里）：当前行为是报错退出，不静默命名新会话", async (t) => {
    const sandbox = await makeSandbox(t, { script: [replyWithText("不该被用到 T2-UNUSED-2 任务已完成")] });
    assert.deepEqual(listDir(sandbox.transcriptsDir), []);
    const result = await sandbox.run(["chat", "随便", "--session", "t2-brand-new-name"]);
    // 当前行为：chat 的 --session 只是续跑入口，命名新会话是 repl 的语义（README 明写）。
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.stderr, /会话不存在：t2-brand-new-name/u);
    assertEmptyArchiveOnly(sandbox.transcriptsDir, "t2-brand-new-name");
    assert.equal(sandbox.upstream.requestCount, 0);
  });

  it("-c：没有可接续会话时非 0 并给出路，而不是静默新建", async (t) => {
    const sandbox = await makeSandbox(t, { script: [replyWithText("不该被用到 T2-UNUSED-3 任务已完成")] });
    const result = await sandbox.run(["chat", "随便", "-c"]);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.stderr, /没有可接续的会话/u);
    assert.match(result.stderr, /--session/u, "要给出 --session <完整 id> 这条出路");
    assert.deepEqual(listJsonl(sandbox.transcriptsDir), []);
    assert.equal(sandbox.upstream.requestCount, 0);
  });

  it("-c：选中本目录最近一次会话并续跑，不产生第二个 transcript", async (t) => {
    const sandbox = await makeSandbox(t, {
      script: [replyWithText("首发 T2-C1 任务已完成"), replyWithText("接续 T2-C2 任务已完成")],
    });
    const first = await sandbox.run(["chat", "首发", ...MINIMAL_CHAT_FLAGS]);
    assert.equal(first.code, EXIT_NOT_VERIFIED);
    const sessionId = listJsonl(sandbox.transcriptsDir)[0].replace(/\.jsonl$/u, "");

    const continued = await sandbox.run(["chat", "接续", "-c", ...MINIMAL_CHAT_FLAGS]);
    assert.equal(sandbox.upstream.requestCount, 2);
    assert.equal(continued.code, first.code);
    assert.match(continued.stdout, /接续 T2-C2 任务已完成/u);
    assert.ok(sandbox.upstream.requests[1].bodyText.includes("T2-C1"), "-c 选中的必须是刚跑完的那个会话");
    assert.deepEqual(listJsonl(sandbox.transcriptsDir), [`${sessionId}.jsonl`], "-c 是续跑，不是新建");
  });

  it("--session 与 -c / -r 互斥，是 usageError", async (t) => {
    const sandbox = await makeSandbox(t, { script: [replyWithText("这条不该被用到 T2-MUTEX 任务已完成")] });
    const withContinue = await sandbox.run(["chat", "x", "--session", "whatever", "-c"]);
    assert.equal(withContinue.code, EXIT_USAGE);
    assert.match(withContinue.stderr, /互斥/u);

    const withPicker = await sandbox.run(["chat", "x", "--session", "whatever", "-r"]);
    assert.equal(withPicker.code, EXIT_USAGE);
    assert.match(withPicker.stderr, /互斥/u);

    const doubled = await sandbox.run(["chat", "x", "-c", "--continue"]);
    assert.equal(doubled.code, EXIT_USAGE);
    assert.match(doubled.stderr, /参数重复/u);
    assert.equal(sandbox.upstream.requestCount, 0);
  });

  it("-r：非交互终端下拒绝，并指路 -c / --session", async (t) => {
    const sandbox = await makeSandbox(t, { script: [replyWithText("这条不该被用到 T2-PICKER 任务已完成")] });
    const result = await sandbox.run(["chat", "x", "-r"]);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.stderr, /非交互终端不支持 -r/u);
    assert.match(result.stderr, /-c/u);
    assert.equal(sandbox.upstream.requestCount, 0);
  });

  it("非派生形状的 id：-c 里看不见，但 --session <完整 id> 仍可恢复（README 的取舍）", async (t) => {
    const sandbox = await makeSandbox(t, {
      script: [
        replyWithText("源会话 T2-SRC 任务已完成"),
        replyWithText("被恢复 T2-RESUMED 任务已完成"),
      ],
    });
    const first = await sandbox.run(["chat", "源", ...MINIMAL_CHAT_FLAGS]);
    assert.equal(first.code, EXIT_NOT_VERIFIED);
    const real = listJsonl(sandbox.transcriptsDir)[0];
    // 手工改出一个「用户自取名字」的 transcript：形状不匹配 <目录名>-<哈希8>。
    copyFileSync(join(sandbox.transcriptsDir, real), join(sandbox.transcriptsDir, "t2-hand-named.jsonl"));

    // 换一个目录跑 -c：源会话的前缀属于 `project`，本目录看不见；手工命名的那条形状也不对，
    // 于是「目录里明明有非空 transcript，-c 却说没有」正是 README 写下的取舍。
    const otherProject = join(sandbox.root, "other-project");
    mkdirSync(otherProject, { recursive: true });
    const invisible = await runCliOnce({
      args: ["chat", "x", "-c"],
      home: sandbox.home,
      cwd: otherProject,
    });
    assert.equal(invisible.code, EXIT_USAGE, `非标定 id 对 -c 不可见，应报「没有可接续的会话」；实得 ${invisible.code}`);
    assert.match(invisible.stderr, /没有可接续的会话/u);
    assert.ok(listJsonl(sandbox.transcriptsDir).includes("t2-hand-named.jsonl"), "transcript 确实在盘上（不是用例自己没造出来）");

    const recovered = await runCliOnce({
      args: ["chat", "接着跑", "--session", "t2-hand-named", ...MINIMAL_CHAT_FLAGS],
      home: sandbox.home,
      cwd: otherProject,
    });
    assert.equal(recovered.code, EXIT_NOT_VERIFIED, `--session <完整 id> 必须能恢复非标定 id；stderr=${JSON.stringify(recovered.stderr.slice(0, 200))}`);
    const last = sandbox.upstream.requests.at(-1).bodyText;
    assert.ok(last.includes("T2-SRC"), "恢复的请求体要带上被恢复会话的历史");
  });

  it("上游 500：退出 1、把上游错误文案给用户，并真的发过请求", async (t) => {
    const sandbox = await makeSandbox(t, {
      script: [jsonResponse({ error: { message: "t2-upstream-boom-500" } }, { status: 500 })],
    });
    const result = await sandbox.run(
      ["chat", "炸一个", ...MINIMAL_CHAT_FLAGS],
      { env: { ERIX_RETRY_ATTEMPTS: "0" } },
    );
    assert.ok(await sandbox.upstream.waitForRequests(1, 2_000), "500 用例必须真的发过请求");
    assert.equal(sandbox.upstream.requestCount, 1, "ERIX_RETRY_ATTEMPTS=0 时不该重发");
    assert.equal(result.code, EXIT_USAGE, `失败 run 退 1（README：run 抛错 → CLI 顶层 1）；stdout=${JSON.stringify(result.stdout.slice(-200))}`);
    assert.match(result.stderr, /t2-upstream-boom-500/u, "上游的报错文案要透出来，别只留一句「失败」");
    assert.match(result.stderr, /错误：/u);
  });

  it("上游持续 500：默认重发一次就收手（ERIX_RETRY_ATTEMPTS=1 → 恰好两发）", async (t) => {
    const sandbox = await makeSandbox(t, {
      script: [jsonResponse({ error: { message: "t2-upstream-always-500" } }, { status: 500 })],
    });
    const result = await sandbox.run(
      ["chat", "再炸一个", ...MINIMAL_CHAT_FLAGS],
      { env: { ERIX_RETRY_ATTEMPTS: "1" } },
    );
    assert.equal(result.code, EXIT_USAGE);
    assert.equal(sandbox.upstream.requestCount, 2, "attempts=1 意味着首发之外再重发 1 次");
    assert.ok(
      sandbox.upstream.pathsFor().every((path) => path === "/v1/chat/completions"),
      `重发必须打同一个端点：${JSON.stringify(sandbox.upstream.pathsFor())}`,
    );
  });

  it("假 HOME 里没有配置文件：退出 1 并点名缺哪个环境变量，且不联网", async (t) => {
    const sandbox = await makeSandbox(t, {
      script: [replyWithText("这条不该被用到 T2-NOCONF 任务已完成")],
      withConfig: false,
    });
    const result = await sandbox.run(["chat", "没配置"]);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.stderr, /缺少配置|缺少环境变量/u);
    assert.match(result.stderr, /LLM_KIT_ENDPOINT/u);
    assert.match(result.stderr, /slots\.default\.model/u, "文案要给出不走环境变量的那条出路（配置文件 slot）");
    assert.equal(sandbox.upstream.requestCount, 0, "没有端点配置时一条请求也不该发");
  });
});
