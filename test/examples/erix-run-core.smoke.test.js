// 真机冒烟（可选，默认跳过）：用 ~/.erix/config.json 的真配置对临时目录跑一次 core 级
// erix_run，任务=修一个注入的小 bug，然后断言「文件真的被修好了 + 结构化返回形状正确」。
//
//   ERIX_PI_SMOKE=1 node --test test/examples/erix-run-core.smoke.test.js
//
// 默认跳过的原因：这会打一次真 relay（一次完整多轮 run，成本很小但不是零），而 `npm test`
// 必须是离线可重复的（AGENTS.md 测试隔离条）。写文件只发生在 mkdtemp 的临时目录里，
// 不碰 ~/.erix（内层工具集默认不带 todo，见 examples/pi-extension/README.md）。
//
// 库来源固定用 ERIX_AGENT_LIB 指向本仓检出（发版后可改成裸包名）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as core from "../../examples/pi-extension/erix-run-core.js";

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

test(`真机冒烟：core 级 erix_run 修好临时目录里的 bug（配置 ${configPath}）`, {
  skip: enabled ? false : "默认跳过；ERIX_PI_SMOKE=1 才打真 relay（一次完整多轮 run）",
  timeout: 8 * 60 * 1000,
}, async (t) => {
  if (!existsSync(configPath)) {
    t.skip(`模型配置不存在：${configPath}`);
    return;
  }

  const dir = mkdtempSync(path.join(tmpdir(), "erix-run-smoke-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "sum.js"), BUGGY, "utf8");
  writeFileSync(path.join(dir, "check.js"), CHECK, "utf8");

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

  for (const field of ["ok", "finalText", "rounds", "truncated", "usage", "termination", "timeout", "aborted", "diagnostics"]) {
    assert.ok(field in payload, `载荷缺少字段 ${field}`);
  }
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
