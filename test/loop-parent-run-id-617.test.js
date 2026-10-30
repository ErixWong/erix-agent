// issue #617（P0，第一刀）——「子 run 的发起者关联」`parentRunId` 的注册面与投影面守门测试。
//
// 范围（工单钉死，一件不多）：
//   1. 新数据叶 `parentRunId`（`run` 组、`config.run.parentRunId`），注册方式**逐字同构**
//      `runId`（#498 S3 A20 之后的形状：nested-only，无扁平孪生）。
//   2. 投影三处：judge 记录（`judgeRecordFields`）、宿主 diagnostics（`persistence_error`）、
//      今天已带 `runId` 的事件；宿主没给就**整字段省略**（不写 "" / null / undefined）。
//   3. `executeTool` 上下文递进当前 run 的 `runId`（派生工具据此自填父身份）。
//   不做：派生工具 / 名册 / CLI 工具 / transcript 行形状（`src/store/` 一字未动）。
//
// ⚠ 裁决记录（与派单人确认过）：任务原文「扁平与嵌套两种写法都被接受」的前提（「新叶必须有
// 顶层孪生键」）不成立——`runId` 的扁平写法今天被名称闸当场拒，判词逐字点名 `config.run.runId`。
// 故本片同构注册：**扁平 `parentRunId` 当场拒**，测试按此钉（P 段三断言）。
//
// 卫生：store 全程注入内存实现（`src/store/memory.js`），不写盘、不碰真实 `~/.erix`、零真实 LLM。
import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import {
  CONFIG_LEAF_BINDING,
  CONFIG_NAMESPACE_SCHEMA,
  configSchemaSelfCheck,
} from "../src/loop/config-namespace.js";
import { RUN_TOOL_LOOP_OPTION_NAMES } from "../src/loop/option-normalization.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];
const CALL_NOOP = {
  content: [{ type: "tool_use", id: "c1", name: "noop", input: {} }],
  stopReason: "tool_use",
};

/** 最小合法 run（直连 `runToolLoop`，不走 `runDirect` 夹具——P 段测的正是引擎拼写）。 */
function base(extra = {}) {
  return {
    provider: createFakeProvider([DONE, DONE, DONE, DONE, DONE, DONE]),
    executeTool: async () => "ok",
    ...extra,
    config: {
      ...extra.config,
      input: { initialUserMessage: "go", wrapup: false, ...extra.config?.input },
      run: { completion: false, ...extra.config?.run },
    },
  };
}

function rawError(options) {
  return runToolLoop(options).then(() => null, (error) => error);
}

async function exitCode(options) {
  try {
    await runToolLoop(options);
    return 0;
  } catch {
    return 1;
  }
}

// ================================================================ P. 注册面与名称闸

test("P1 parentRunId 逐字同构 runId 的注册面：run 组叶 + call 绑定 + 不在顶层白名单", () => {
  assert.ok(CONFIG_NAMESPACE_SCHEMA.run.includes("parentRunId"), "家是 config.run.parentRunId");
  assert.equal(CONFIG_LEAF_BINDING["run.parentRunId"], "call", "绑定逐字同构 run.runId=call");
  assert.equal(
    RUN_TOOL_LOOP_OPTION_NAMES.includes("parentRunId"),
    false,
    "无扁平孪生：不在顶层白名单（同构 A20 之后的 runId）",
  );
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [], "schema 自检不红");
});

test("P2 闸口：嵌套写法 exit 0（opaque 值不解析），扁平写法 exit 1，未知叶被拒", async () => {
  // opaque：引擎不解析、不校验——带空格、带冒号的值原样接受。
  const legal = ["parent-run-9", "run:sub:42"];
  assert.ok(legal.length >= 2, "至少抽查 2 格合法形状");
  for (const value of legal) {
    const label = `parentRunId=${JSON.stringify(value)}`;
    const nested = await exitCode(base({
      config: { run: { parentRunId: value, runId: "child-1" } },
    }));
    assert.equal(nested, 0, `${label}：规位必须可达（exit 0）`);
  }
  // 扁平写法：从来没有过这个拼写（新字段，不是迁移），名称闸当场拒并逐字点名规位家。
  const flat = await rawError(base({ parentRunId: "p-1" }));
  assert.equal(flat instanceof TypeError, true, "扁平 parentRunId 必须当场拒");
  assert.equal(
    flat.message,
    'unknown runToolLoop option: "parentRunId"'
      + " (its canonical home is config.run.parentRunId; the flat spelling is rejected)",
    "拒绝文案逐字点名 config.run.parentRunId",
  );
  // 未知叶：名称闸当场拒（不是静默忽略）。
  const unknown = await rawError(base({ config: { run: { parentRunIdX: "p-1" } } }));
  assert.equal(unknown instanceof TypeError, true);
  assert.match(unknown.message, /^unknown config\.run option: "parentRunIdX"/u);
});

// ================================================================ E. 给了 parentRunId：三面逐字镜像

// 一次带 judge 的 run（round judge 路径），收集 judge 记录与事件流。
async function runJudged({ parentRunId, runId = "child-617" } = {}) {
  const records = [];
  const events = [];
  const ON_TRACK = {
    done: true,
    confidence: 0.9,
    reason: "已完成",
    evidence: "验证通过",
    direction: "on_track",
    directionReason: "已接近验证",
  };
  const result = await runDirect({
    provider: createFakeProvider([
      CALL_NOOP,
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn", times: 4 },
    ]),
    executeTool: async () => "ok",
    tools: [{ name: "noop", description: "probe", inputSchema: { type: "object", properties: {} } }],
    maxRounds: 4,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: true,
      judge: { provider: createFakeProvider([{ content: [{ type: "text", text: JSON.stringify(ON_TRACK) }] }]) },
    },
    config: { run: { runId, ...(parentRunId === undefined ? {} : { parentRunId }) } },
    capabilities: {
      hooks: {
        onJudge: (info) => records.push(info),
        onEvent: (event) => events.push(event),
      },
    },
  });
  return { records, events, result };
}

test("E1 judge 记录与 run_outcome 逐字带 parentRunId（round judge 路径）", async () => {
  const { records, events } = await runJudged({ parentRunId: "parent-run-9" });
  assert.ok(records.length > 0, "应产生 judge 记录");
  for (const record of records) {
    assert.equal(record.parentRunId, "parent-run-9", "judge 决策记录逐字镜像");
  }
  const outcome = events.find((event) => event.type === "run_outcome");
  assert.ok(outcome, "应有 run_outcome 事件");
  assert.equal(outcome.parentRunId, "parent-run-9", "run 级 outcome 汇总逐字镜像");
  assert.equal(outcome.runId, "child-617", "runId 不受影响");
});

test("E2 宿主 diagnostics 面：diagnostics.error 收到的 persistence_error 逐字带 parentRunId", async () => {
  const diagnosticsEvents = [];
  const store = createMemoryTranscriptStore();
  const boom = Object.assign(new Error("disk full"), { code: "EDISK" });
  store.appendRound = async () => { throw boom; };
  const thrown = await runDirect({
    provider: createFakeProvider([DONE, DONE, DONE, DONE]),
    executeTool: async () => "ok",
    store,
    initialUserMessage: "go",
    completion: false,
    config: {
      run: { runId: "child-617", parentRunId: "parent-run-9" },
      timing: { retry: false },
    },
    diagnostics: { error: (event) => diagnosticsEvents.push(event) },
  }).then(() => null, (error) => error);
  assert.ok(thrown, "落盘失败必须抛 persistence_failed");
  assert.equal(thrown.code, "persistence_failed");
  // persistence_error 事件今天只走 diagnostics.error / onPersistenceError（不走 onEvent），
  // parentRunId 只镜像 runId 已在的面。
  const diag = diagnosticsEvents.find((event) => event.type === "persistence_error");
  assert.ok(diag, "diagnostics.error 必须收到 persistence_error");
  assert.equal(diag.parentRunId, "parent-run-9", "宿主 diagnostics 面逐字镜像");
  // 抛出的错误对象上携带的同一份事件也逐字带（终止载荷的同源口径）。
  assert.equal(thrown.persistenceError?.parentRunId, "parent-run-9");
});

test("E3 已带 runId 的事件：persistence_capability_degraded 逐字带 parentRunId", async () => {
  const store = createMemoryTranscriptStore();
  delete store.markRunState;
  const events = [];
  const result = await runDirect({
    provider: createFakeProvider([DONE, DONE, DONE, DONE]),
    executeTool: async () => "ok",
    store,
    initialUserMessage: "go",
    completion: false,
    config: { run: { runId: "child-617", parentRunId: "parent-run-9" } },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  assert.equal(result.termination.reason, "end_turn");
  const degraded = events.find((event) => event.type === "persistence_capability_degraded");
  assert.ok(degraded, "store 缺 markRunState 必须发 capability 降级事件");
  assert.equal(degraded.runId, "child-617");
  assert.equal(degraded.parentRunId, "parent-run-9", "降级事件逐字镜像");
});

test("E4 观察者错误记账口统一注入：onObserverError 的 detail 逐字带 parentRunId", async () => {
  const store = createMemoryTranscriptStore();
  delete store.markRunState;
  const contexts = [];
  const result = await runDirect({
    provider: createFakeProvider([DONE, DONE, DONE, DONE]),
    executeTool: async () => "ok",
    store,
    initialUserMessage: "go",
    completion: false,
    config: { run: { runId: "child-617", parentRunId: "parent-run-9" } },
    capabilities: {
      hooks: {
        // 降级事件上抛错 ⇒ 经 reportObserverError 记账，run 终局不变（#173 PR-B）。
        onEvent: (event) => {
          if (event.type === "persistence_capability_degraded") throw new Error("startup throw");
        },
        onObserverError: (error, context) => contexts.push(context),
      },
    },
  });
  assert.equal(result.termination.reason, "end_turn", "观察者抛错不改变终局");
  const detail = contexts.find((context) => context.type === "persistence_capability_degraded");
  assert.ok(detail, "记账口必须收到该通道的错误");
  assert.equal(detail.runId, "child-617");
  assert.equal(detail.parentRunId, "parent-run-9", "统一注入处逐字镜像");
});

test("E5 executeTool 上下文递进当前 run 的 runId（派生工具据此自填父身份）", async () => {
  const contexts = [];
  const result = await runDirect({
    provider: createFakeProvider([
      CALL_NOOP,
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn", times: 4 },
    ]),
    executeTool: async (options) => {
      contexts.push({ ...options.context });
      return "ok";
    },
    tools: [{ name: "noop", description: "probe", inputSchema: { type: "object", properties: {} } }],
    initialUserMessage: "call noop",
    completion: false,
    config: { run: { runId: "ctx-run-617", parentRunId: "parent-run-9" } },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.ok(contexts.length > 0, "工具应被执行");
  for (const context of contexts) {
    assert.equal(context.runId, "ctx-run-617", "工具上下文 runId 等于本次传入的 runId");
    assert.equal(
      Object.hasOwn(context, "parentRunId"),
      false,
      "本刀只递进 runId：parentRunId 不进工具上下文",
    );
  }
});

// ================================================================ N. 不给：整字段省略 + 回归

test("N1 不给 parentRunId：事件与 judge 记录里不存在该键（不是 undefined/空串）", async () => {
  const { records, events } = await runJudged({});
  assert.ok(records.length > 0, "应产生 judge 记录");
  for (const record of records) {
    assert.equal(Object.hasOwn(record, "parentRunId"), false, "judge 记录不得出现 parentRunId 键");
  }
  assert.ok(events.length > 0, "应产生事件");
  for (const event of events) {
    assert.equal(Object.hasOwn(event, "parentRunId"), false, "事件不得出现 parentRunId 键");
  }
});

test("N2 回归（快照式）：不给 parentRunId 时 run_outcome 与改动前逐字段等值", async () => {
  const { events } = await runJudged({});
  const outcome = events.find((event) => event.type === "run_outcome");
  assert.ok(outcome);
  // 显式字面量 = 改动前的公开形状（type/runId/model/rounds/judgeRecordCount/termination/verification，
  // 无 parentRunId）。deepEqual 逐字段对撞，任何新增/改名/假值字段当场红。
  assert.deepEqual(Object.keys(outcome).sort(), [
    "judgeRecordCount",
    "model",
    "rounds",
    "runId",
    "termination",
    "type",
    "verification",
  ]);
  assert.equal(outcome.type, "run_outcome");
  assert.equal(outcome.runId, "child-617");
  assert.equal(outcome.judgeRecordCount, 1, "挂了 onJudge ⇒ 恰一条 round judge 记录（既有口径）");
  assert.deepEqual(outcome.termination, { reason: "judge_done" });
  assert.equal(outcome.verification.status, "skipped");
});
