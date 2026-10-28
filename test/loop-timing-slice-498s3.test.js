// issue #498（S3）—— `timing` 组的**垂直切片**：删掉顶层扁平 `timeoutMs` / `deadlineMs` / `retry`，
// 它们的规范之家是 `config.timing.*`。
//
// 本文件只钉两件事（其余在本刀改过的既有用例里，见交付报告）：
//
//   P. **旧名反向拒绝钉**（三格，一键一格）：顶层再写 `timeoutMs` / `deadlineMs` / `retry` ⇒
//      **当场拒**，且错误文案必须**指向新家**。这条是宿主从 0.26 升级到 0.28 时唯一的救命索——
//      「未知选项 + 接受名单」会让宿主自己猜它搬去了哪；点名 `config.timing.<leaf>` 才是可执行的。
//      ⚠ 三格都用**逐字相等**断言（不是 `match`）：文案里少一个 `config.timing.`，升级的人就没了路标。
//   R. **读侧不变的机制证据**：三个键写在新家之后，展开相会把它们逐字写回
//      `effectiveOptions.<扁平名>`——这正是「删了顶层键、引擎读侧一行都不用改」的原因。
//      所以这里既断言 `effectiveOptions` 上的扁平名还在，也用一次**真 run** 证明引擎真的吃到了值
//      （`timeoutMs` 让 run 在死线前收尾、`deadlineMs` 进 wrap-up 提示词、`retry.attempts` 真的重发）。
//
// 为什么单独一个文件：这三条是「迁移完成」与「只删了键」的分界线。放在任何既有用例里都会被
// 那一格的叙事淹没，而本刀最容易出的错正是「删了键但没给宿主指路」。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";

import { configSchemaSelfCheck } from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  normalizeRunToolLoopOptions,
} from "../src/loop/option-normalization.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect as sharedRunDirect, withSeed } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 直连路线的最小合法 run（一次 end_turn 就结束）。 */
function runDirect(extra = {}) {
  return sharedRunDirect({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    seed: "go",
    completion: false,
    wrapup: false,
    ...extra,
  });
}

/** 直连路线「抛了什么」（不抛返回 null）。 */
const directError = (extra = {}) => runDirect(extra).then(() => null, (error) => error);

// ================================================================ P. 旧名反向拒绝（三格，一键一格）
//
// 每格两段：① 逐字相等的文案（含新家路径）；② 同一个值写在新家里必须**不抛**——
// 「拒旧名」与「收新家」必须同时成立，否则这条钉子只是在说「我把键弄丢了」。

test("P1 顶层 timeoutMs ⇒ 当场拒，文案逐字指向 config.timing.timeoutMs", async () => {
  const error = await directError({ timeoutMs: 1000 });
  assert.equal(error instanceof TypeError, true, "旧名必须在名称闸口抛 TypeError（不是静默忽略）");
  assert.equal(
    error.message,
    'unknown runToolLoop option: "timeoutMs" (its canonical home is config.timing.timeoutMs;'
      + " the flat spelling is rejected)",
    "文案必须点名新家——少了 config.timing.timeoutMs，升级的宿主只能自己猜",
  );
  // 同一个值写在新家里 ⇒ 不抛，且展开相把它写回扁平名（读侧不变）。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { timing: { timeoutMs: 1000 } },
  });
  assert.equal(effectiveOptions.timeoutMs, 1000, "config.timing.timeoutMs 必须写回 effectiveOptions.timeoutMs");
});

test("P2 顶层 deadlineMs ⇒ 当场拒，文案逐字指向 config.timing.deadlineMs", async () => {
  const error = await directError({ deadlineMs: 2000 });
  assert.equal(error instanceof TypeError, true);
  assert.equal(
    error.message,
    'unknown runToolLoop option: "deadlineMs" (its canonical home is config.timing.deadlineMs;'
      + " the flat spelling is rejected)",
  );
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { timing: { deadlineMs: 2000 } },
  });
  assert.equal(effectiveOptions.deadlineMs, 2000, "config.timing.deadlineMs 必须写回 effectiveOptions.deadlineMs");
});

test("P3 顶层 retry ⇒ 当场拒，文案逐字指向 config.timing.retry", async () => {
  const error = await directError({ retry: { attempts: 1 } });
  assert.equal(error instanceof TypeError, true);
  // #498 S3 收尾（folding 片）补的一句：`retry` 也是**混装壳**（数据 `attempts` + 行为
  // `sleepImpl`），所以文案必须一次把两站都点名——只指 `config.timing.retry` 会让宿主把函数写进去、
  // 撞第二次才看到 `capabilities.ports.sleepImpl`。逐字相等仍然成立（少一个字符都不行）。
  assert.equal(
    error.message,
    'unknown runToolLoop option: "retry" (its canonical home is config.timing.retry;'
      + " the flat spelling is rejected) — this shell holds both data and functions:"
      + " write data as config.timing.retry.<leaf>, and behaviour members as capabilities.ports.sleepImpl",
  );
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { timing: { retry: { attempts: 1 } } },
  });
  assert.deepEqual(effectiveOptions.retry, { attempts: 1 }, "config.timing.retry 必须写回 effectiveOptions.retry");
});

// 三格合起来还有一句：这三个键**真的**不在白名单里了（不是「拒了但又留着」）。
test("P4 三个旧名都不在白名单里，而 config.timing 的三个叶子都在 schema 里", () => {
  for (const name of ["timeoutMs", "deadlineMs", "retry"]) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(name), false, `${name} 必须已经离开顶层白名单`);
  }
  // 新家还在（本刀删的是**写法**，不是叶子）：否则 P1–P3 的文案会指向一个不存在的组。
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [], "schema 自检必须 []");
});

// ================================================================ R. 读侧不变（真 run 的行为证据）
//
// 「引擎读的是 `effectiveOptions.timeoutMs`」这句话必须用行为证明，不能靠读代码。三个键各一条：
// 删掉展开相里 `timing` 的映射（`config-namespace.js` 的 `CONFIG_NAMESPACE_SCHEMA.timing`），
// 下面三条会同时红——那就是本刀「删键但不动读侧」的可行性证据。

test("R1 timeoutMs 经新家生效：外部时间预算进入 wrap-up 提示（真 run）", async () => {
  // 每一轮都睡 40ms，预算 100ms ⇒ 第 2/3 轮的提示词里必须各出现一次「时间预算将尽」。
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "one", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "two", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await runToolLoop(withSeed({
    provider,
    initialUserMessage: "finish it",
    executeTool: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { data: "worked", success: true };
    },
    maxRounds: 3,
    completion: false,
    stallDetection: false,
    config: { timing: { timeoutMs: 100 } },
  }));
  const nudges = provider.requests.slice(0, 3).map((request) => request.messages.filter((message) => (
    message.content?.some((block) => /外部时间预算将尽/.test(block.text ?? ""))
  )).length);
  assert.equal(nudges[0], 0, "第一轮不该有提示（预算还宽）");
  assert.equal(
    nudges.slice(1).every((count) => count === 1),
    true,
    `第 2/3 轮必须各注入一次——引擎真的读到了 config.timing.timeoutMs，实测 ${JSON.stringify(nudges)}`,
  );
});

test("R2 deadlineMs 经新家生效：wrap-up 提示词按剩余时间注入（真 run）", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "one", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "two", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await runToolLoop(withSeed({
    provider,
    initialUserMessage: "finish it",
    executeTool: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { data: "worked", success: true };
    },
    maxRounds: 3,
    completion: false,
    stallDetection: false,
    config: { timing: { deadlineMs: Date.now() + 100 } },
  }));
  const nudges = provider.requests.slice(0, 3).map((request) => request.messages.filter((message) => (
    message.content?.some((block) => /外部时间预算将尽/.test(block.text ?? ""))
  )).length);
  assert.equal(nudges[0], 0, "第一轮不该有提示（预算还宽）");
  assert.equal(nudges.slice(1).every((count) => count === 1), true, `第 2/3 轮必须各注入一次，实测 ${JSON.stringify(nudges)}`);
});

test("R3 retry.attempts 经新家生效：可重试错误真的重发（真 run）", async () => {
  const retryable = new Error("temporary");
  retryable.retryable = true;
  const provider = createFakeProvider([
    { throw: retryable },
    { content: [{ type: "text", text: "recovered" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop(withSeed({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    config: { timing: { retry: { attempts: 1, backoffBaseMs: 0 } } },
    capabilities: { ports: { sleepImpl: async () => {} } },
  }));
  assert.equal(result.finalText, "recovered");
  assert.equal(provider.requests.length, 2, "config.timing.retry.attempts 真的生效（一次重发）");
});
