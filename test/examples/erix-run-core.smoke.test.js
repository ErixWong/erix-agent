// 真机冒烟（可选，默认跳过）：用 ~/.erix/config.json 的真配置对临时目录跑一次 core 级
// erix_run，任务=修一个注入的小 bug，然后断言「文件真的被修好了 + 结构化返回形状正确」。
//
//   ERIX_PI_SMOKE=1 node --test test/examples/erix-run-core.smoke.test.js
//
// 默认跳过的原因：这会打一次真 relay（一次完整多轮 run，成本很小但不是零），而 `npm test`
// 必须是离线可重复的（AGENTS.md 测试隔离条）。写文件只发生在 makeTmp 的临时目录里，
// 不碰 ~/.erix（内层工具集默认不带 todo，见 examples/pi-extension/README.md）。
//
// 库来源固定用 ERIX_AGENT_LIB 指向本仓检出（发版后可改成裸包名）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createScriptedUpstream } from "../../fixtures/upstream.mjs";
import * as core from "../../examples/pi-extension/erix-run-core.js";
import { makeTmp } from "../helpers/tmp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const enabled = process.env.ERIX_PI_SMOKE === "1";
const configPath = process.env.ERIX_CONFIG_PATH || core.defaultConfigPath({ env: process.env, home: homedir() });

const BUGGY = `"use strict";
// 一个小工具：add 应该返回 a + b
function add(a, b) {
  return a - b; // BUG: 这里应该是加法
}

module.exports = { add };
`;

const CHECK = `const assert = require("node:assert");
const { add } = require("./sum.js");
assert.strictEqual(add(2, 3), 5, "add(2,3) 应该等于 5");
console.log("OK");
`;

const TASK = [
  "工作目录里有 sum.js，它的 add() 实现错了（写成了减法，应该返回 a + b）。",
  "要求：",
  "1) 先用 readFile 看 sum.js 现状，再用 writeFile 就地修好 add()（只改这一处，保留其它内容与注释）。",
  "2) 然后用 exec 运行 \`node check.js\`，它必须在断言通过后打印 OK。",
  "3) 收尾时用中文写一句摘要，说明改了哪一行、验证命令的输出是什么。",
].join("\n");

// 本段是**附加的真机验证**（ERIX_PI_SMOKE=1），默认不跑：门控关着时它是 SKIP 但整条仍算绿。
// 同一条装配链的离线替身在同文件默认段（假上游 127.0.0.1，始终跑）。
// 保留理由：只有真 relay 能证明「真模型会自己读文件、改文件、跑验证命令」这条完整行为链。
test(`真机冒烟：core 级 erix_run 修好临时目录里的 bug（配置 ${configPath}）`, {
  skip: enabled ? false : "默认跳过；ERIX_PI_SMOKE=1 才打真 relay（一次完整多轮 run）",
  timeout: 8 * 60 * 1000,
}, async (t) => {
  if (!existsSync(configPath)) {
    t.skip(`模型配置不存在：${configPath}`);
    return;
  }

  const dir = await makeTmp("erix-run-smoke-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "sum.js"), BUGGY, "utf8");
  writeFileSync(path.join(dir, "check.js"), CHECK, "utf8");
  // #207 R3/R4：同时自证一次真落盘（transcript / judge.log 与返回里的 artifacts 对得上）
  const sessionDir = path.join(dir, "sessions");

  // 前置条件：bug 确实在（check.js 现在必然失败）
  assert.throws(() => execFileSync("node", ["check.js"], { cwd: dir, encoding: "utf8" }));

  const progressLines = [];
  const payload = await core.runErixRun(
    {
      task: TASK,
      cwd: dir,
      maxRounds: 8,
      strategy: "sliding-window",
      timeoutMs: 5 * 60 * 1000,
      sessionDir,
    },
    {
      env: { ...process.env, ERIX_AGENT_LIB: repoRoot },
      home: homedir(),
      onProgress: (line) => progressLines.push(line),
    },
  );

  // 结构化返回全文（报告要贴的就是这个）
  console.log("--- erix_run smoke: progress ---\n" + progressLines.join("\n"));
  console.log("--- erix_run smoke: payload ---\n" + JSON.stringify(payload, null, 2));
  console.log("--- erix_run smoke: model-facing text ---\n" + core.formatPayloadForModel(payload));
  console.log("--- erix_run smoke: sessionDir ---\n" + JSON.stringify(payload.artifacts));

  for (const field of [
    "ok", "finalText", "rounds", "truncated", "usage", "termination", "timeout", "aborted",
    "artifacts", "extensionCount", "maxExtensions", "resumable", "diagnostics",
  ]) {
    assert.ok(field in payload, `载荷缺少字段 ${field}`);
  }
  // #207 R3：传了 sessionDir 就必须真落了盘，且 artifacts 报的就是那个文件
  assert.equal(typeof payload.artifacts.transcriptPath, "string", "传了 sessionDir 就不能报 null");
  assert.equal(existsSync(payload.artifacts.transcriptPath), true);
  assert.equal(payload.artifacts.transcriptPath.startsWith(sessionDir), true);
  assert.equal(payload.diagnostics.sessionDir, sessionDir);
  assert.equal(payload.resumable, false);
  assert.equal(typeof payload.extensionCount, "number");
  assert.equal(typeof payload.maxExtensions, "number");
  assert.equal(typeof payload.finalText, "string");
  assert.ok(payload.finalText.length > 0, "finalText 不能为空");
  assert.equal(typeof payload.rounds, "number");
  assert.equal(typeof payload.usage.input_tokens, "number");
  assert.equal(typeof payload.usage.output_tokens, "number");
  assert.ok(
    payload.usage.input_tokens > 0 && payload.usage.output_tokens > 0,
    `真调用必须有用量，实际 ${JSON.stringify(payload.usage)}`,
  );
  assert.ok(
    ["end_turn", "judge_done", "no_tool", "max_rounds_cap", "continuation_exhausted", "stall"].includes(
      payload.termination.reason,
    ),
    `终局应当是治理类原因，实际 ${JSON.stringify(payload.termination)}`,
  );
  assert.equal(payload.timeout, false, "5 分钟预算内不该超时");
  assert.equal(payload.aborted, false);
  assert.equal(payload.diagnostics.observerErrors.count, 0, "观察者不该出错");
  // 装配自查（#182）：配置里有预算元数据 → 压缩开启 → 不该出现 model_metadata_missing
  assert.equal(payload.diagnostics.modelMetadataMissing, null, "装配自查：元数据必须到位");
  assert.ok(payload.diagnostics.model, "diagnostics 必须记录实际使用的模型");

  // 交付物判据：文件真的被修好了（与内层说了什么无关）
  const fixed = execFileSync("node", ["check.js"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(fixed, "OK", "check.js 必须在修复后打印 OK");
  const sumSource = readFileSync(path.join(dir, "sum.js"), "utf8");
  assert.match(sumSource, /a\s*\+\s*b/u, "sum.js 里应当出现 a + b");
});

// ---------------------------------------------------------------------------
// 默认段（始终跑、不联网）：core 级 erix_run 的**同一条装配链**打到本地假上游
// ---------------------------------------------------------------------------
//
// 上面那条真机冒烟靠 ERIX_PI_SMOKE=1 门控：门控关着时它是 SKIP，**但整条仍算绿**，
// 于是装配链（loadErixAgent → loadModelSlot → createProviderForSlot → createInnerTools
// → runToolLoop → 落盘 artifacts → 结构化载荷）烂了也不会有人知道——这正是 #257 T4 的根因。
// 本段把同一套 core 导出原样跑一遍，只把 relay 换成 `fixtures/upstream.mjs` 的假上游
// （127.0.0.1:0）：任务仍是「修好 sum.js 的 add() 并跑 node check.js」，判据也仍是
// **文件真的被修好了**，而不是「没抛异常」。
//
// 两个已知坑都按现状钉住：配置路径是 `<HOME>/.erix/config.json`；
// slot 里指向服务端的字段名是 **endpoint**（`loadModelSlot` 逐项校验的就是它）。
// 末尾断言假上游真的收到了请求，否则「绿了但根本没发请求」在这里同样看不出来。

const FIXED_SUM = `"use strict";
// 一个小工具：add 应该返回 a + b
function add(a, b) {
  return a + b; // 修复：原来是减法
}

module.exports = { add };
`;

const OFFLINE_MODEL = "t4-scripted-model";
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NODE_USE_ENV_PROXY", "ERIX_CONFIG_PATH", "XDG_CONFIG_HOME"];

/** 进出清理代理与配置指向类变量：宿主设了它们会把 127.0.0.1 送去代理、或把配置指到别处 */
function isolateEnvForOfflineRun(t) {
  const saved = new Map();
  for (const key of PROXY_ENV_KEYS) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    delete process.env[key];
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** 非流式（provider.chat()）形状的一次工具调用 */
function toolCallResponse(name, args, usage) {
  return {
    kind: "json",
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: `chatcmpl-${name}`,
      object: "chat.completion",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: usage ?? { prompt_tokens: 1_200, completion_tokens: 30 },
    }),
  };
}

/** 非流式的纯文本终稿 */
function textResponse(content, usage) {
  return {
    kind: "json",
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "chatcmpl-final",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: usage ?? { prompt_tokens: 2_400, completion_tokens: 60 },
    }),
  };
}

/** 已回传给模型的工具结果条数 = 剧本的推进位置（不靠请求序号，多一发治理调用也不会错位） */
function toolResultCount(requestJson) {
  return (requestJson?.messages ?? []).filter((message) => message?.role === "tool").length;
}

/** 写 `<HOME>/.erix/config.json`：slot 字段名是 endpoint / model / apiKey + 预算元数据 */
function writeOfflineConfig(home, endpoint) {
  const dir = path.join(home, ".erix");
  mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    slots: {
      default: {
        protocol: "openai",
        endpoint,
        apiKey: "sk-fake-not-secret",
        model: OFFLINE_MODEL,
        contextWindowTokens: 200_000,
        maxOutputTokens: 2_048,
      },
    },
  }), "utf8");
  return configPath;
}

test("默认段：core 级 erix_run 在本地假上游上修好 bug（装配链与真机冒烟同一条）", {
  timeout: 180_000,
}, async (t) => {
  isolateEnvForOfflineRun(t);

  const script = [(ctx) => {
    const seen = toolResultCount(upstream.requests[ctx.seq]?.json);
    if (seen === 0) return toolCallResponse("writeFile", { path: "sum.js", content: FIXED_SUM });
    if (seen === 1) return toolCallResponse("exec", { command: "node check.js" });
    return textResponse("已把 add() 从减法改成加法，node check.js 断言通过并打印 OK。");
  }];
  const upstream = createScriptedUpstream({ script });
  t.after(() => upstream.close());
  const baseUrl = await upstream.listen();

  const home = await makeTmp("erix-run-offline-home-");
  const dir = await makeTmp("erix-run-offline-cwd-");
  const sessionDir = path.join(dir, "sessions");
  const configPath = writeOfflineConfig(home, `${baseUrl}/v1`);
  writeFileSync(path.join(dir, "sum.js"), BUGGY, "utf8");
  writeFileSync(path.join(dir, "check.js"), CHECK, "utf8");
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  // 前置条件：bug 确实在（与真机冒烟同一道闸，否则「修好了」是空的）
  assert.throws(() => execFileSync("node", ["check.js"], { cwd: dir, encoding: "utf8" }));

  const progressLines = [];
  const payload = await core.runErixRun(
    {
      task: TASK,
      cwd: dir,
      maxRounds: 8,
      strategy: "sliding-window",
      timeoutMs: 120_000,
      sessionDir,
    },
    {
      // 库来源与配置来源都指到临时目录：真 ~/.erix 与真 ~/.pi 一个字节都不许写
      env: { ...process.env, ERIX_AGENT_LIB: repoRoot, HOME: home },
      home,
      onProgress: (line) => progressLines.push(line),
    },
  );

  // ① 假上游必须真被请求过（否则这一段只是「装配没抛异常」的空壳）
  assert.ok(await upstream.waitForRequests(3, 20_000),
    `假上游必须真收到 ≥3 次请求（改文件 → 跑验证 → 终稿），实际 ${upstream.requestCount} 次`);
  assert.ok(upstream.requests.every((entry) => entry.path.endsWith("/chat/completions")),
    `请求必须落在 OpenAI chat/completions 上，实际：${upstream.pathsFor().join(", ")}`);
  assert.ok(upstream.requests.every((entry) => entry.json?.model === OFFLINE_MODEL),
    "每次请求都必须带上配置里解析出的模型名");

  // ② 工具真的执行过（进度通道里的 start 留痕），不是剧本自说自话
  assert.ok(progressLines.some((line) => line.includes("writeFile")),
    `进度应留下 writeFile 调用痕迹，实际：${progressLines.join(" | ")}`);
  assert.ok(progressLines.some((line) => line.includes("exec")),
    `进度应留下 exec 调用痕迹，实际：${progressLines.join(" | ")}`);

  // ③ 结构化载荷形状：与真机冒烟同一张字段清单
  for (const field of [
    "ok", "finalText", "rounds", "truncated", "usage", "termination", "timeout", "aborted",
    "artifacts", "extensionCount", "maxExtensions", "resumable", "diagnostics",
  ]) {
    assert.ok(field in payload, `载荷缺少字段 ${field}`);
  }
  // 采纳判据契约（Termination decision table）：只有 end_turn / judge_done 才算「可当答案用」。
  // 剧本以纯文本收尾时，引擎在默认 completion 下走的是 no_tool（不是 failed/timeout），
  // 因此这里钉的是**契约关系**而不是硬写 ok===true：把 ok 改成恒真、或把终局改成
  // failed/timeout，都会红。实测现象已写进报告（纯文本终稿拿不到 end_turn）。
  const adoptable = ["end_turn", "judge_done"].includes(payload.termination.reason);
  assert.equal(payload.ok, adoptable,
    `ok 必须严格等于「终局是 end_turn/judge_done」，实际 ok=${payload.ok} termination=${JSON.stringify(payload.termination)}`);
  assert.equal(payload.error, undefined, "正常跑完不该带 error 字段");
  assert.equal(typeof payload.finalText, "string");
  assert.ok(payload.finalText.length > 0, "finalText 不能为空");
  assert.equal(typeof payload.rounds, "number");
  assert.ok(payload.rounds >= 3, `改文件 → 跑验证 → 终稿至少 3 轮，实际 ${payload.rounds}`);
  assert.equal(typeof payload.usage.input_tokens, "number");
  assert.equal(typeof payload.usage.output_tokens, "number");
  assert.ok(payload.usage.input_tokens > 0 && payload.usage.output_tokens > 0,
    `有用量才说明真打了模型，实际 ${JSON.stringify(payload.usage)}`);
  assert.ok(
    ["end_turn", "judge_done", "no_tool", "max_rounds_cap", "continuation_exhausted", "stall"].includes(
      payload.termination.reason,
    ),
    `终局应当是治理类原因，实际 ${JSON.stringify(payload.termination)}`,
  );
  assert.equal(payload.timeout, false);
  assert.equal(payload.aborted, false);
  assert.equal(payload.diagnostics.observerErrors.count, 0, "观察者不该出错");
  assert.equal(payload.diagnostics.modelMetadataMissing, null, "装配自查：元数据必须到位");
  assert.equal(payload.diagnostics.model, OFFLINE_MODEL, "diagnostics 必须记录实际使用的模型");
  assert.equal(payload.diagnostics.configPath, configPath, "配置必须来自 <HOME>/.erix/config.json");
  assert.equal(payload.resumable, false);
  assert.equal(typeof payload.extensionCount, "number");
  assert.equal(typeof payload.maxExtensions, "number");

  // ④ #207 R3：传了 sessionDir 就必须真落了盘，且 artifacts 报的就是那个文件
  assert.equal(typeof payload.artifacts.transcriptPath, "string", "传了 sessionDir 就不能报 null");
  assert.equal(existsSync(payload.artifacts.transcriptPath), true);
  assert.equal(payload.artifacts.transcriptPath.startsWith(sessionDir), true);
  assert.equal(payload.diagnostics.sessionDir, sessionDir);

  // ⑤ 交付物判据：文件真的被修好了（与模型说了什么无关）
  const fixed = execFileSync("node", ["check.js"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(fixed, "OK", "check.js 必须在修复后打印 OK");
  const sumSource = readFileSync(path.join(dir, "sum.js"), "utf8");
  assert.match(sumSource, /a\s*\+\s*b/u, "sum.js 里应当出现 a + b");

  // ⑥ 离线跑的 transcript 全文里必须留有两次工具调用与 exec 的真实输出（档案不是空壳）
  const transcriptText = readFileSync(payload.artifacts.transcriptPath, "utf8");
  assert.match(transcriptText, /writeFile/u, "transcript 应含 writeFile 足迹");
  assert.match(transcriptText, /node check\.js/u, "transcript 应含 exec 命令足迹");
  assert.match(transcriptText, /OK/u, "transcript 应含 exec 的真实输出 OK");

  console.log(`[erix-run-offline] requests=${upstream.requestCount} rounds=${payload.rounds} `
    + `termination=${payload.termination.reason} transcript=${payload.artifacts.transcriptPath}`);
});
