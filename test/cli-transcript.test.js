// issue #928：显示投影从 `src/index.js` 公共面搬进 `bin/display/projection.js`，
// 并长成 CLI 子命令 `erix transcript <runId>`。本文件钉三格判据（都是端到端子进程）：
//   ① `erix transcript <runId>` 对一份真 store 产出可读文本（stdout，非 JSON，含角色/轮次/正文/工具名）。
//   ② 同一份 store 用 `--json` 拿到的结构与 `projectTranscriptForDisplay` 的返回逐字相等。
//   ③ 反向：`src/index.js` **不再**导出 `projectTranscriptForDisplay`（运行时导出面 own keys，
//      沿用 `test/guide-removal-gate.test.js#sourceSurface` 的既有机制，不自造新面）。
// 外加一格：runId 找不到 ⇒ 走**已有**退出码语义（exit 1「会话不存在」），错误文案点名 runId。
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTmp } from "./helpers/tmp.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { projectTranscriptForDisplay } from "../bin/display/projection.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = join(REPO_ROOT, "bin", "cli.js");

/** 一份最小但真实的 transcript 记录：user 正文 + assistant 正文/工具调用 + 工具结果。 */
function sampleRecords() {
  return [{
    round: 1,
    ts: "2026-01-01T00:00:00.000Z",
    messages: [
      { role: "user", content: "list the files please" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running ls now" },
          { type: "tool_use", name: "exec", id: "call-1", input: { command: "ls -la" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "alpha.txt\nbeta.txt" }],
      },
    ],
  }];
}

/** 把一份记录写进真 store，返回其目录与 runId。 */
async function seedStore(runId) {
  const dir = await makeTmp("erix-transcript-");
  const store = createFileTranscriptStore({ dir });
  for (const record of sampleRecords()) await store.appendRound(runId, record);
  return { dir, runId };
}

/** 起子进程跑 `erix transcript`，返回 { status, stdout, stderr }。 */
function runCli(args, { dir } = {}) {
  const env = { ...process.env };
  // 不联网、不读宿主配置：清掉会改变路径解析的变量，store 目录靠 --dir 显式给出。
  delete env.XDG_CONFIG_HOME;
  for (const key of Object.keys(env)) {
    if (/proxy/i.test(key)) delete env[key];
  }
  const full = dir ? [...args, "--dir", dir] : args;
  return spawnSync(process.execPath, [CLI_PATH, ...full], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
}

test("① erix transcript <runId> 对真 store 产出可读文本（端到端子进程）", async () => {
  const { dir, runId } = await seedStore("run-readable");
  const result = runCli(["transcript", runId], { dir });
  assert.equal(result.status, 0, `期望 exit 0，实际 ${result.status}；stderr=${result.stderr}`);
  const out = result.stdout;
  // 是可读文本，不是 JSON 结构。
  assert.throws(() => JSON.parse(out), "可读输出不应是 JSON");
  assert.match(out, /\[user\]/, "应带角色标记 [user]");
  assert.match(out, /\[assistant\]/, "应带角色标记 [assistant]");
  assert.match(out, /#1/, "应带轮次标记 #1");
  assert.match(out, /list the files please/, "应含 user 正文");
  assert.match(out, /running ls now/, "应含 assistant 正文");
  assert.match(out, /exec/, "应含工具名");
  assert.match(out, /ls -la/, "应含工具参数摘要");
});

test("② 同一 store 用 --json 拿到的结构与 projectTranscriptForDisplay 逐字相等", async () => {
  const { dir, runId } = await seedStore("run-json");
  const result = runCli(["transcript", runId, "--json"], { dir });
  assert.equal(result.status, 0, `期望 exit 0，实际 ${result.status}；stderr=${result.stderr}`);
  const cliValue = JSON.parse(result.stdout);
  // 独立地在测试里重跑投影，作为「结构一致」的对照物。
  const store = createFileTranscriptStore({ dir });
  const records = await store.load(runId);
  const expected = projectTranscriptForDisplay(records);
  assert.deepStrictEqual(cliValue, expected, "--json 结构应与投影返回逐字相等");
  // 结构确实是投影形状（非空、每项带 key/role/text/blocks/meta）。
  assert.ok(Array.isArray(expected) && expected.length > 0, "投影应非空");
  for (const turn of expected) {
    for (const field of ["key", "role", "text", "blocks", "meta"]) {
      assert.ok(field in turn, `投影条目应带 ${field}`);
    }
  }
});

test("③ 反向：src/index.js 不再导出 projectTranscriptForDisplay（运行时导出面 own keys）", async () => {
  // 沿用 test/guide-removal-gate.test.js#sourceSurface 的既有机制：真 import 后看 own keys。
  const root = await import("../src/index.js");
  assert.ok(
    !("projectTranscriptForDisplay" in root),
    "src/index.js 不应再导出 projectTranscriptForDisplay",
  );
  assert.ok(
    !Object.keys(root).includes("projectTranscriptForDisplay"),
    "导出名集里不应有 projectTranscriptForDisplay",
  );
  // 同时钉住「搬而不删」：实现仍在 bin/display/projection.js 且可导出。
  const binProjection = await import("../bin/display/projection.js");
  assert.equal(typeof binProjection.projectTranscriptForDisplay, "function",
    "实现应仍住在 bin/display/projection.js 并导出");
});

test("④ runId 找不到 ⇒ 复用已有退出码 1，错误文案点名 runId", async () => {
  const { dir } = await seedStore("run-present");
  const result = runCli(["transcript", "no-such-run-id"], { dir });
  assert.equal(result.status, 1, `期望 exit 1（会话不存在语义），实际 ${result.status}`);
  assert.match(result.stderr, /no-such-run-id/, "错误应点名 runId");
  assert.match(result.stderr, /transcript/, "错误应说明找不到 transcript");
  // 不能把整份 HELP_TEXT 倾泻到 stderr（showHelp 应为 false，保持「会话不存在」的窄文案）。
  assert.ok(!result.stderr.includes("退出码："), "不该 dump 整份主 HELP_TEXT");
});
