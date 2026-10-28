// issue #552 —— `collectLoopCapabilitiesMissing` 里那三个**类型**子条件今天不可达（#545 纪律）。
//
// 待审的那段（`src/assembly-validators.js`）：
//   if (session !== undefined && (!session || typeof session !== "object"
//     || Array.isArray(session) || typeof session.id !== "string" || session.id.length === 0))
// 前三个（S1 `!session` / S2 `typeof session !== "object"` / S3 `Array.isArray(session)`）**永远不会
// 为真**，所以它们从来没有让任何一条判词出现过；可达的只有后半段（`session.id` 的**在场性**，
// 由 #551 的 `D2` 钉住）。#551 只处理了同族的恒真判据 `typeof session === "object"`，本条补上
// 同一分支里剩下的三个。
//
// 处置（#545 先例的第二种）：**保留 + 内部不变量抛**，不是删。理由：删掉之后，一个「新选项来源
// 绕过语义相」的未来改动会让这里**静默**把 `session: "abc"` 报成
// `assembly port is missing methods: session.id`——一句关于宿主端口的话，而错在引擎侧。保留成
// 会抛的内部不变量，同一场回归就变成一条点名根因的 `TypeError`。注释里写清了「谁还走得到」
// （答案：没人，六种形状逐条关掉）与覆盖证据（本文件）。
//
// 本文件钉四件事：
//   A. **可达性取证**（自己造，不引用 #551 的结论）：六种形状 × 四种非对象值，全部在语义相
//      （或装配口构造期）被拒，判词是容器那句，**不是** capability 闸口那句。
//   B. 那个内部不变量**有牙齿**：直调函数喂非对象 `session` 必须抛（反向证①的靶子——
//      把 throw 去掉、退回 `missing.push("session.id")`，本格立刻红）。
//   C. 可达的那半没被放宽：`session.id` 的在场性判据逐格可分（`{}` / `{id: ""}` 点名，
//      `{id: "s"}` / 缺容器不点名）。
//   D. 端到端判词逐字未变：缺 `session.id` 仍是 `assembly port is missing methods: session.id`。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createAssemblyPort } from "../src/assembly.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { collectLoopCapabilitiesMissing } from "../src/assembly-validators.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];
const MODEL_CONFIG = { resolve: async () => ({}) };
const textMessage = (text) => ({ role: "user", content: [{ type: "text", text }] });
const thrown = async (promise) => promise.then(() => null, (error) => error);

/** 形状 4 需要一个可续跑的账本 + 快照；每次现建，避免形状之间互相污染。 */
async function resumableStore() {
  const store = createMemoryTranscriptStore();
  await store.appendRound("r-552-resume", { round: 0, messages: [textMessage("seed")] });
  await store.saveRunSnapshot("r-552-resume", {
    round: 0,
    status: "completed",
    messages: [textMessage("seed")],
  });
  return store;
}

/**
 * 六种能走到（或看起来能走到）细粒度闸口的入口形状。每种都接受一个 `session` 值，这样同一张表
 * 既能跑「合法容器」基线，也能跑四种非对象值。
 */
const SHAPES = [
  {
    name: "① 完整装配口",
    run: (session) => runToolLoop({
      assemblyPort: createAssemblyPort({
        modelConfig: MODEL_CONFIG,
        provider: createFakeProvider(DONE),
        tools: { definitions: [], executeTool: async () => "ok" },
        session,
        policy: { config: { input: { initialUserMessage: "go" } } },
      }),
    }),
  },
  {
    name: "② 细粒度直连",
    run: (session) => runToolLoop({
      provider: createFakeProvider(DONE),
      executeTool: async () => "ok",
      modelConfig: MODEL_CONFIG,
      session,
      config: { run: { completion: false }, input: { initialUserMessage: "go" } },
    }),
  },
  {
    name: "③ policy 翻译后填充（policy.runId → config.run.runId）",
    run: (session) => runToolLoop({
      assemblyPort: createAssemblyPort({
        modelConfig: MODEL_CONFIG,
        provider: createFakeProvider(DONE),
        tools: { definitions: [], executeTool: async () => "ok" },
        session,
        policy: { runId: "r-552", config: { input: { initialUserMessage: "go" } } },
      }),
    }),
  },
  {
    name: "④ loadLatestRunSnapshot 续跑",
    run: async (session) => runToolLoop({
      provider: createFakeProvider(DONE),
      executeTool: async () => "ok",
      modelConfig: MODEL_CONFIG,
      session,
      store: await resumableStore(),
      config: {
        run: { resume: true, runId: "r-552-resume", completion: false },
        input: { initialUserMessage: "go" },
      },
    }),
  },
  {
    name: "⑤ 缺 modelConfig",
    run: (session) => runToolLoop({
      provider: createFakeProvider(DONE),
      executeTool: async () => "ok",
      session,
      config: { run: { completion: false }, input: { initialUserMessage: "go" } },
    }),
  },
  {
    name: "⑥ 缺 session.id",
    run: (session) => runToolLoop({
      provider: createFakeProvider(DONE),
      executeTool: async () => "ok",
      modelConfig: MODEL_CONFIG,
      session,
      config: { run: { completion: false }, input: { initialUserMessage: "go" } },
    }),
  },
];

/** S1 / S2 / S3 各自的触发值（覆盖 `null` / 字符串 / 数组 / 数字四种形状）。 */
const NON_OBJECT_SESSIONS = [
  ["S1 !session", null],
  ["S2 typeof !== object", "payload-552"],
  ["S3 Array.isArray", [1, 2]],
  ["S2 typeof !== object", 552],
];

// ---------------------------------------------------------------------------------------------------
// A. 可达性取证：六种形状 × 四种非对象值，全部在闸口之前被拒
// ---------------------------------------------------------------------------------------------------

test("#552 A：六种形状都走不到细粒度闸口——非对象 session 一律先在语义相 / 装配期被拒", async () => {
  // 基线：合法容器下，六种形状里 ①②③④ 跑完、⑤⑥ 停在 capability 闸口（证明闸口真的会响）。
  const baselines = [
    ["① 完整装配口", { id: "s-552" }, null],
    ["② 细粒度直连", { id: "s-552" }, null],
    ["③ policy 翻译后填充（policy.runId → config.run.runId）", { id: "s-552" }, null],
    ["④ loadLatestRunSnapshot 续跑", { id: "s-552" }, null],
    ["⑤ 缺 modelConfig", { id: "s-552" }, "assembly port is missing methods: modelConfig.resolve"],
    ["⑥ 缺 session.id", {}, "assembly port is missing methods: session.id"],
  ];
  for (const [name, session, expected] of baselines) {
    const shape = SHAPES.find((candidate) => candidate.name === name);
    assert.notEqual(shape, undefined, `形状表里必须有「${name}」——找不到就是这张表在空转`);
    const error = await thrown(Promise.resolve().then(() => shape.run(session)));
    if (expected === null) {
      assert.equal(error, null, `${name}：合法容器下必须能跑完，实际 ${error && error.message}`);
    } else {
      assert.ok(error instanceof TypeError, `${name}：必须抛，实际 ${error && error.message}`);
      assert.ok(error.message.startsWith(expected),
        `${name}：capability 闸口必须真的会响（否则下面的「走不到」证明的是空集），实际 ${error.message}`);
    }
  }

  // 四种非对象值 × 六种形状：全部是容器判词，一条都不能落到 capability 闸口。
  for (const shape of SHAPES) {
    for (const [sub, value] of NON_OBJECT_SESSIONS) {
      const error = await thrown(Promise.resolve().then(() => shape.run(value)));
      assert.ok(error instanceof TypeError, `${shape.name} / ${sub}：必须抛`);
      assert.match(error.message, /^session must be an object \(got /u,
        `${shape.name} / ${sub}：必须是容器判词（先于闸口的那一句），实际 ${error.message}`);
      assert.equal(error.message.includes("assembly port is missing methods"), false,
        `${shape.name} / ${sub}：不许走到细粒度闸口（那说明 S1/S2/S3 还有活可干）`);
      assert.equal(error.message.includes("internal invariant"), false,
        `${shape.name} / ${sub}：也不许落到内部不变量（那条只在有人绕过语义相时才该响）`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------
// B. 内部不变量有牙齿（反向证①的靶子）
// ---------------------------------------------------------------------------------------------------

test("#552 B：非对象 session 直调函数 ⇒ 内部不变量抛（不是 capability 判词）", () => {
  for (const [sub, value] of NON_OBJECT_SESSIONS) {
    assert.throws(
      () => collectLoopCapabilitiesMissing({
        provider: createFakeProvider(DONE),
        executeTool: async () => "ok",
        modelConfig: MODEL_CONFIG,
        session: value,
        fineGrainedPortShape: true,
      }),
      (error) => {
        assert.ok(error instanceof TypeError, `${sub}：必须是 TypeError`);
        assert.match(error.message, /^internal invariant: the loop capability check received /u,
          `${sub}：必须是内部不变量那句（改成 missing.push("session.id") 会让本格红），实际 ${error.message}`);
        assert.equal(error.message.includes("assembly port is missing methods"), false,
          `${sub}：不变量不许冒充 capability 判词`);
        assert.equal(error.message.includes("issue #552"), true,
          `${sub}：判词必须点名工单，否则下一个人不知道这是纪律不是宿主错误`);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------------------------------
// C. 可达的那半：只有「在场性」
// ---------------------------------------------------------------------------------------------------

test("#552 C：session.id 的在场性判据逐格可分（本片没有放宽它）", () => {
  const call = (session) => collectLoopCapabilitiesMissing({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    modelConfig: MODEL_CONFIG,
    session,
    fineGrainedPortShape: true,
  });
  assert.deepEqual(call({}), ["session.id"], "容器在场但缺 id ⇒ 点名");
  assert.deepEqual(call({ id: "" }), ["session.id"], "空串不是 id ⇒ 点名");
  assert.deepEqual(call({ id: 552 }), ["session.id"], "非字符串 id ⇒ 点名");
  assert.deepEqual(call({ id: "s-552" }), [], "合法 id ⇒ 不点名");
  assert.deepEqual(call(undefined), [], "没有容器 ⇒ 不进细粒度端口契约（不点名）");
});

// ---------------------------------------------------------------------------------------------------
// D. 端到端判词逐字未变（与 #551 D2 同一句）
// ---------------------------------------------------------------------------------------------------

test("#552 D：缺 session.id 的端到端判词逐字未变", async () => {
  const missingId = await thrown(runToolLoop({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    modelConfig: MODEL_CONFIG,
    session: {},
    config: { run: { completion: false }, input: { initialUserMessage: "go" } },
  }));
  assert.equal(missingId.message, "assembly port is missing methods: session.id");
  assert.equal(missingId.via, undefined, "这条判词不带路线标签（历史形状，本片不改）");
});
