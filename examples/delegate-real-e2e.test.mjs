// 真上游 e2e（issue #617 P2）：**父 run 派生一个子 run 并取回结果**——走 CLI 的真实装配。
//
// 用法：ERIX_E2E_REAL=1 node --test examples/delegate-real-e2e.test.mjs
//
// 与 `examples/delegate-e2e.test.mjs`（离线、始终跑、脚本化假 provider）分工不同：那边钉的是库与
// 宿主注入面的形状，这边钉的是**真模型 + 真 relay** 下这条链路真的通：
//   父 `runChat`（真 CLI 装配：`createCliDelegation` + `createDelegateTool`）
//     → 模型调 `delegate action=run background=true`
//     → 子 run 是**同进程嵌套的真 `runToolLoop`**（同一个真上游 provider）
//     → 子 run 写自己的名册记录 / transcript
//     → 完成时经 `notifyParent` 唤醒父侧**恰好一次**
//     → 模型调 `delegate action=result` 取回终局
//
// 闸门口径与 `examples/e2e-real-gate.mjs` 逐字同源（不另造一套）：
//   · `ERIX_E2E_REAL` 不是 `1` ⇒ 本文件**一步都不跑**，`t.skip()` 打印分类原因（`GAP_CODES`）。
//     真上游永远不是默认门禁的硬依赖（AGENTS 测试隔离条）。
//   · 闸门**开着**但配置/凭据/端点不可用 ⇒ **`assert.fail`**，不是 skip。理由与
//     `scripts/release-real-check.mjs` 的预检同一条：「没跑成」不许报成绿——发版清单里的必跑项
//     被「跳过」冒充成「通过」，正是 PR #289 阻断 1 的镜像错误。`check:release:real` 那侧另有一道
//     闸（子进程里出现 `[gate_*]` / `[config_*]` / `[api_key_*]` / `[endpoint_unreachable]` 类 skip
//     同样判红），两层都要在。
//
// 隔离：临时目录（`makeTmp` 同源的 `os.tmpdir()`）、`--dir` / notes / 名册全部指到它下面，
// 不碰真实 `~/.erix`；模型名从 `slots.default` 解析（`ERIX_E2E_CONFIG` 可覆盖），源码零硬编码。
// 零依赖红线：只用 `node:` 内置 + 仓内相对路径；纯 ESM。

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runChat } from "../bin/cli.js";
import { createOpenAIProvider } from "../src/index.js";
import {
  formatSkip,
  GAP_CODES,
  printableEndpoint,
  REAL_GATE_ENV,
  resolveRealUpstream,
  TMP_PREFIX,
} from "./e2e-real-gate.mjs";

/** 父会话 id（同时是父 `runId`：CLI 的 runId = session）。 */
const PARENT_RUN_ID = "delegate-real-parent";

/**
 * 父 run 的指令。三条硬要求都写死在文案里，因为断言依赖它们：
 *   · `background: true` ⇒ 后台子 run，完成时才有「唤醒」可断言（前台派生不发通知）；
 *   · 先 `status` 轮询到终态、再 `result` ⇒ 唤醒发生在取回之前，次数才稳定为 1；
 *   · 终稿带「任务已完成」⇒ 命中 CLI 的完成信号，父 run 当场 `end_turn` 收尾。
 */
const PARENT_PROMPT = [
  "这是一个「派生（delegate）」工具的验证任务，请严格按三步执行，不要省略、不要改写参数名：",
  '1) 调用 delegate 工具，参数：action="run"，background=true，task="只回答一个词：pong"。',
  '2) 用上一步返回的 runId 调用 delegate，参数：action="status"，runId="<上一步返回的 runId>"。',
  "   如果 state 还是 queued 或 running，就再调用一次 status，最多 6 次，直到 state 变成 completed。",
  '3) 调用 delegate，参数：action="result"，runId="<同一个 runId>"，把取回的终局告诉我。',
  "最后一行只写：任务已完成",
].join("\n");

/**
 * 父首轮用户消息的取证锚点：**从 `PARENT_PROMPT` 本身切出来**，不在断言里另抄一份。
 * （实测漂移过一次：断言手写成「派生（delegate）工具的验证任务」，漏了提示词里的 `）」`，
 * 于是真上游跑永远红——虽然功能全对。锚点必须是派生值，不能是第二份手抄。）
 */
const FIRST_TURN_MARK = PARENT_PROMPT.slice(0, 18);

/** 空 MCP 配置：`runChat` 默认会去读 `~/.erix/mcp.json` / 当前目录 `.mcp.json`（真机不许碰真家目录）。 */
async function writeEmptyMcpConfig(dir) {
  const path = join(dir, "mcp.json");
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify({ mcpServers: {} }), "utf8");
  return path;
}

test("派生真上游件已接进 check:release:real 步骤表（始终跑，不联网）", () => {
  // 反向证：把本文件从步骤表里摘掉 ⇒ 这一格红。否则「补了 e2e 但没进门禁」会静默存活，
  // 而发版清单是唯一会真的跑它的地方。
  const script = readFileSync(new URL("../scripts/release-real-check.mjs", import.meta.url), "utf8");
  assert.match(script, /examples\/delegate-real-e2e\.test\.mjs/u, "步骤表里必须点名本文件");
  // 临时目录前缀唯一（残留可认领）。
  const prefixes = Object.values(TMP_PREFIX);
  assert.equal(new Set(prefixes).size, prefixes.length, "TMP_PREFIX 的值必须互不相同");
  assert.ok(prefixes.includes(TMP_PREFIX.delegateReal));
});

test("真上游 e2e：父 run 派生子 run → 名册归属/终态 → 唤醒恰好一次 → 取回结果（#617 P2）", {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  const gate = await resolveRealUpstream({ probeTimeoutMs: 8_000 });
  if (!gate.ok) {
    if (gate.code === GAP_CODES.GATE_MISSING) {
      // 缺省形态：一步都不跑。分类原因照 `formatSkip` 打（gate/config/key/endpoint 四类分得开）。
      t.skip(`真上游门禁默认关闭：${formatSkip(gate)}（跑法：${REAL_GATE_ENV}=1 node --test examples/delegate-real-e2e.test.mjs）`);
      return;
    }
    // 闸门开着但真上游不可用：**红**。「没跑成」不是「通过」。
    assert.fail(`闸门开着（${REAL_GATE_ENV}=1）但真上游不可用 ⇒ 本用例没跑成，不许报绿：${formatSkip(gate)}`);
  }
  console.log(`[6] model=${gate.model} endpoint=${printableEndpoint(gate.endpoint)} config=${gate.configPath}`);

  const root = await mkdtemp(join(tmpdir(), TMP_PREFIX.delegateReal));
  try {
    const parentDir = join(root, "transcripts");
    const delegationDir = join(root, "delegation");
    const configPath = await writeEmptyMcpConfig(join(root, "mcp"));
    /** @type {string[]} 父侧唤醒记录（`notifyParent` 的落点，就是「父收到唤醒」的可观测面）。 */
    const notifications = [];

    // provider 只从闸门解析出来的槽位建（模型名/端点/凭据都不是字面量）。
    const provider = createOpenAIProvider({
      ...gate.slot,
      timeoutMs: 300_000,
      maxTokens: gate.slot.maxOutputTokens,
    });

    const result = await runChat({
      prompt: PARENT_PROMPT,
      session: PARENT_RUN_ID,
      // 子 run 也跑在这个可写临时目录里（子 run 的 cwd 缺省沿用父的）。
      cwd: root,
      dir: parentDir,
      notesDir: join(root, "notes"),
      skillsDir: join(root, "skills"),
      configPath,
      provider,
      config: {
        model: gate.model,
        endpoint: gate.endpoint,
        apiKey: gate.apiKey,
        ...(gate.slot.maxOutputTokens === undefined ? {} : { maxOutputTokens: gate.slot.maxOutputTokens }),
      },
      // 12 < DEFAULT_REFLECTION_MIN_ROUNDS(16) ⇒ 父 run 不跑 reflection/judge，终局词汇收敛到 end_turn。
      maxRounds: 12,
      idleTimeout: 300,
      delegate: true,
      delegationDir,
      delegateMaxChildren: 2,
      delegateTimeoutMs: 300_000,
      delegateNotify: (line) => notifications.push(line),
      // 工具回显与 idle 日志照常进 stderr（现场要看得到；不进 stdout 的终稿面）。
      idleLog: (line) => console.error(line),
    });

    // —— 父 run 自己的收尾 ——
    assert.equal(result?.termination?.reason, "end_turn", `父 run 应以 end_turn 收尾：${JSON.stringify(result?.termination)}`);

    // —— ① 名册：一条记录、归属逐字、终态 completed、子 termination 是 end_turn ——
    const rosterFiles = readdirSync(delegationDir).filter((name) => name.endsWith(".json"));
    assert.equal(rosterFiles.length, 1, `派生一次应恰好一条名册记录，实际 ${rosterFiles.length}`);
    const record = JSON.parse(await readFile(join(delegationDir, rosterFiles[0]), "utf8"));
    console.log(`[6] 子 runId=${record.runId} state=${record.state} termination=${JSON.stringify(record.termination)}`);
    assert.equal(record.parentRunId, PARENT_RUN_ID, "子名册的 parentRunId 必须逐字等于父 runId");
    assert.equal(record.state, "completed", `名册终态应为 completed，实际 ${record.state}`);
    assert.equal(record.termination, "end_turn", `子 run 的 termination.reason 应为 end_turn，实际 ${JSON.stringify(record.termination)}`);

    // —— ② 唤醒恰好一次（父 result 自取过就不再唤醒，去重归库）——
    assert.equal(notifications.length, 1, `父侧应恰好被唤醒一次，实际 ${notifications.length} 次：${JSON.stringify(notifications)}`);
    assert.match(notifications[0], /^【子run完成】/u, "唤醒文案必须带库的固定前缀（NOTIFICATION_PREFIX）");

    // —— ③ 会话文件不互踩：子 run 的 transcript 在自己的目录里，父文件里没有它的轮次 ——
    const childTranscriptDir = join(delegationDir, "transcripts");
    assert.equal(existsSync(childTranscriptDir), true, `子 run 的 transcript 目录应存在：${childTranscriptDir}`);
    const childTranscript = join(childTranscriptDir, `${record.runId}.jsonl`);
    assert.equal(existsSync(childTranscript), true, `子 run 的 transcript 应落在 ${childTranscript}`);
    const parentText = await readFile(join(parentDir, `${PARENT_RUN_ID}.jsonl`), "utf8");
    // 反向证：父会话文件里必须有父 run 自己的首轮用户消息（否则「不含子 run 系统提示」是空转的）。
    assert.ok(parentText.includes(FIRST_TURN_MARK), `父会话文件里应有父 run 的首轮用户消息（反向证，锚点 ${JSON.stringify(FIRST_TURN_MARK)}）`);
    // —— 互踩的判据用**行身份**，不用措辞 ——
    // 本仓 transcript 每行都带 `<runId>:…` 前缀的身份键（`dedupKey` 与 `roundKey` 都是：
    //   `src/store/message-rows.js` 的 `dedupKey = <runId>:msg:<round>:<seq>`、
    //   `src/loop/orchestrator.js` 的 `roundKey = <runId>:round:<n>`）。
    // ⇒ 「子 run 追加进了父的会话文件」是可判定的结构事实，不必挑一个字符串去猜。
    // ⚠ 原先这里断言的是「子会话文件里应有子 run 自己的系统提示」——**那条断言本身不成立**：
    //   transcript 不落系统提示（`src/store/` 里没有任何 system 行），于是真上游跑永远红（#617 P2 实测）。
    const rowsOf = (text) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const parentRows = rowsOf(parentText);
    const childRows = rowsOf(await readFile(childTranscript, "utf8"));
    assert.ok(parentRows.length > 0, "父会话文件应至少有一行");
    const foreignKeys = parentRows
      .flatMap((row) => [row.dedupKey, row.roundKey])
      .filter((key) => typeof key === "string" && key !== "" && !key.startsWith(`${PARENT_RUN_ID}:`));
    assert.deepEqual(foreignKeys, [], `父会话文件里混进了别的 run 的行 ⇒ 父子会话互踩：${JSON.stringify(foreignKeys)}`);
    assert.ok(
      childRows.some((row) => typeof row.dedupKey === "string" && row.dedupKey.startsWith(`${record.runId}:`)),
      "子 transcript 里应有身份键属于子 run 自己的行",
    );
    // 反向证（防上一条空转）：子文件里得真的写着子 run 的任务文本——**从提示词里抠出来**，不另抄一份。
    const childTaskMark = PARENT_PROMPT.match(/task="([^"]+)"/u)?.[1] ?? "";
    assert.ok(childTaskMark !== "", "剧本里应能从 PARENT_PROMPT 抠出子任务文本");
    assert.ok(
      childRows.some((row) => JSON.stringify(row).includes(childTaskMark)),
      `子 transcript 里应有子 run 的首轮用户消息（锚点 ${JSON.stringify(childTaskMark)}）`,
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
