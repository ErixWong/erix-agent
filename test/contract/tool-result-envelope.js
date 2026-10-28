// 工具事实信封契约套件（工单 261014 T1，上游 issue #284 跨通道身份 / #285 耗时全形态）。
//
// 本套件钉的是**引擎产出的 tool_result / tool_use 事实形状**，不是宿主适配器：
//   · 字段归属：协议字段在顶层（`type`/`tool_use_id`/`content`，条件 `is_error`）、引擎事实只在
//     `erix.*`、宿主扩展只在 `metadata.*`（工单 261014 T2 之后**顶层不再有任何摊平键**）；
//   · `TOOL_RESULT_CONTRACT` 是这三条归属的唯一真相，期望字段集合**由常量生成**：字段名只能
//     来自 `contract.engine.fields`、且必须在常量里声明了 `stages` 含 `result`（`expectedEngineFields`），
//     常量被削掉一个字段本套件立即红，而不是文档与测试各自再抄一份清单。**唯一的例外**是
//     `PINNED_ENGINE_FIELDS` 那一条——它的职责恰恰是钉常量自身，故显式分开命名并注释；
//     文件末尾另有一条「常量里的每个字段都被断言过」的覆盖对账。
//   · 存在性矩阵（工单 §5）：成功 / 失败 / judge 拦截 / resume 中断重放 / 已完成结果复放 /
//     未 settle 即中止，逐情形断言，并含反向断言（拦截与中断**没有** durationMs、复放**不重算**、
//     宿主同名键**只在** `metadata` 而不在顶层、退役名单里的顶层旧名一个也不得再出现、provider `id` 未被改写）；
//   · `durationMs` 缺失 = unknown，**不是 0**。
//
// 用法（宿主拿到的是包入口命名空间，与 `engineApiContract` 同一形状）：
//   import { toolResultEnvelopeContract } from "erix-agent/contract-tests";
//   toolResultEnvelopeContract("reference", async () => await import("erix-agent"));
//
// 纪律：零网络、零本机依赖、不依赖仓库树形（`docs/tasks/` 不存在也照样绿）；只用 node: 内置 +
// 注入的入口命名空间，provider stub 自带，不 import test/helpers（未发布）。

import test from "node:test";
import assert from "node:assert/strict";

const TOOL_CALL_KEY_PATTERN = /^tc_[0-9a-f]{12}$/u;
const DONE = { content: [{ type: "text", text: "all done" }], stopReason: "end_turn" };

function toolUseBlock(id, name = "work", input = { n: 1 }) {
  return { type: "tool_use", id, name, input };
}

function toolRound(id, name = "work") {
  return { content: [toolUseBlock(id, name)], stopReason: "tool_use" };
}

/** 脚本化 provider：越界重复最后一项（拦截/收尾 judge 那条路径不关心终局，别把 stub 跑炸）。 */
function scriptedProvider(script) {
  const requests = [];
  let index = 0;
  return {
    requests,
    async chat(request) {
      requests.push(request);
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (step?.throw !== undefined) throw step.throw;
      return structuredClone(step);
    },
  };
}

/** 流式 provider：先推 tool-call 片段（OpenAI 那种「arguments 先到、id 后到」的形状），再返回终。 */
function streamingToolCallProvider(id, fragments) {
  const requests = [];
  let index = 0;
  return {
    requests,
    async chatStream(request) {
      requests.push(request);
      if (index === 0) {
        for (const fragment of fragments) request.onToolCall?.(fragment);
      }
      index += 1;
      return index === 1
        ? { content: [toolUseBlock(id)], stopReason: "tool_use" }
        : structuredClone(DONE);
    },
    async chat(request) {
      return this.chatStream(request);
    },
  };
}

function judgeProvider(decisions) {
  let index = 0;
  return {
    requests: [],
    async chat(request) {
      this.requests.push(request);
      const decision = decisions[Math.min(index, decisions.length - 1)];
      index += 1;
      return {
        content: [{ type: "text", text: JSON.stringify(decision) }],
        stopReason: "end_turn",
      };
    },
  };
}

function blocksOfMessages(messages, type) {
  return (messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === type);
}

/** 模型可见的那一份事实：从**上一次请求**里取（与 `execute-tool.js` 同一观测点，不加私有出口）。 */
function fedBackToolResult(provider, toolUseId) {
  const last = provider.requests.at(-1);
  const blocks = blocksOfMessages(last?.messages, "tool_result")
    .filter((block) => block.tool_use_id === toolUseId);
  assert.equal(blocks.length, 1, `期望恰好一条 ${toolUseId} 的 tool_result，实际 ${blocks.length} 条`);
  return blocks[0];
}

function eventsOfType(events, type) {
  return events.filter((event) => event?.type === type);
}

/**
 * @param {string} label 实现名（测试标题前缀）
 * @param {() => object | Promise<object>} getEntry 包入口命名空间
 *        （需要 `runToolLoop`、`createMemoryTranscriptStore`、`projectTranscriptForDisplay`、
 *         `TOOL_RESULT_CONTRACT`）
 */
export function toolResultEnvelopeContract(label, getEntry) {
  /** @type {any} */
  let contract;

  const entry = async () => {
    const namespace = await getEntry();
    if (contract === undefined) contract = namespace.TOOL_RESULT_CONTRACT;
    return namespace;
  };

  // ── 常量自身（防「三方消费」塌成两方）────────────────────────────────────────
  test(`${label}: TOOL_RESULT_CONTRACT 是导出的常量面且形状如契约`, async () => {
    const { TOOL_RESULT_CONTRACT: constant } = await entry();
    assert.equal(typeof constant, "object");
    assert.deepEqual(constant.protocol.required, ["type", "tool_use_id", "content"]);
    assert.ok(Object.hasOwn(constant.protocol.conditional, "is_error"),
      "is_error 必须作为条件协议字段登记（它在顶层，不在任何命名空间里）");
    assert.equal(constant.engine.ns, "erix");
    assert.equal(constant.host.ns, "metadata");
    // `PINNED_ENGINE_FIELDS` 是本套件里**唯一一处**故意不从常量派生的字段名清单：它的职责就是
    // 钉住常量自身被削/被改名（派生自它的断言在「常量少了字段、而构造器还在写」时才会红，
    // 派生自身钉不住常量）。其余期望字段集合一律走 `expectedEngineFields()`。
    assert.deepEqual(Object.keys(constant.engine.fields).sort(), PINNED_ENGINE_FIELDS);
    for (const [name, spec] of Object.entries(constant.engine.fields)) {
      assert.equal(spec.owner, "engine", `${name} 的 owner 必须是 engine`);
      assert.equal(spec.onWire, false, `${name} 不得上 wire`);
      assert.equal(spec.resumeStable, true, `${name} 必须跨 resume 稳定`);
    }
    assert.equal(constant.engine.fields.durationMs.capturedAt, "executor settle");
    assert.equal(constant.engine.fields.durationMs.recomputedOnReplay, false);
    assert.equal(constant.legacy.retireAt.includes("minor"), true,
      "旧顶层字段的退役节奏必须写在常量里（T2 的 Changed（BREAKING）依据）");
  });

  /**
   * 常量自身的期望形状（**故意**手写的例外，故与下面的派生器分开命名）：这条断言的职责是
   * 在「常量被削字段 / 字段被改名」时立刻红——那份清单如果从常量派生就永远追不上被削的常量。
   */
  const PINNED_ENGINE_FIELDS = ["durationMs", "executionStatus", "round", "success", "toolCallKey"];
  /** 本套件逐情形声明过的字段名（用来反向证明「常量里的每个字段都被断言过」）。 */
  const assertedEngineFields = new Set();
  /**
   * 期望的 `erix` 字段集合——**由 `TOOL_RESULT_CONTRACT` 生成**（这一刀的全部意义就是常量、
   * 构造器、文档锚点与本套件四方同源，所以这里不写第二份清单）：
   *   · 字段名只能来自 `contract.engine.fields`——用例引用一个常量里没有的名字 ⇒ 立刻红；
   *   · 每个字段还必须在常量里声明了 `stages` 含 `"result"`，否则它根本不该出现在 tool_result 上；
   *   · 返回的集合按常量的成员顺序生成，用例只声明「这一情形写了哪几件」，不声明清单。
   * 于是：常量削掉一个字段而构造器还在写 ⇒ 下面的集合对不上；常量新增字段而没人断言它 ⇒
   * 文件末尾那条覆盖对账红。
   */
  const expectedEngineFields = (...written) => {
    const registered = Object.keys(contract.engine.fields);
    const unregistered = written.filter((name) => !registered.includes(name));
    assert.deepEqual(unregistered, [],
      `用例声明了常量里没登记的引擎字段名：${unregistered.join(" / ")}（期望集合只能来自 TOOL_RESULT_CONTRACT）`);
    const offResultStage = written
      .filter((name) => !contract.engine.fields[name].stages.includes("result"));
    assert.deepEqual(offResultStage, [],
      `这些字段在常量里的 stages 不含 "result"，不该出现在 tool_result 的 erix 上：${offResultStage.join(" / ")}`);
    for (const name of written) assertedEngineFields.add(name);
    return registered.filter((name) => written.includes(name)).sort();
  };
  /** 一次「真的执行过」的结果应当带的字段（拦截 / 中断那两条另算，见各自用例）。
   *  T2 起 `success` 属于这一行：executed 结果一律写，不再取决于宿主声明没声明。 */
  const EXECUTED_RESULT_FIELDS = ["toolCallKey", "round", "durationMs", "success"];
  /** 退役名单里「executed 结果上不得再出现」的顶层旧名（对应 `TOOL_RESULT_CONTRACT.legacy.aliases`）。
   *  写死而不从常量推：从常量推就钉不住「常量改了、写入侧还在写」。 */
  const RETIRED_TOP_LEVEL_KEYS = ["erixRound", "duration", "executionStatus", "success"];

  /** 逐情形跑一次 runToolLoop，交回事件流、provider 请求、store 记录三侧的观测点。 */
  async function runCase(executeTool, { script = [toolRound("call-1"), DONE], options = {} } = {}) {
    const { runToolLoop, createMemoryTranscriptStore } = await entry();
    const provider = scriptedProvider(script);
    const events = [];
    const fragments = [];
    const store = createMemoryTranscriptStore();
    const runId = "contract-tool-envelope";
    // #498 S3 A21: `maxRounds` retired its flat spelling, so a cell may now need to add a `config`
    // leaf. The caller's tree is merged into the base one (same container — a second `config` key
    // would silently replace the seed message / runId this helper depends on).
    const { onEvent, onToolCall, config: extraConfig, ...rest } = options;
    const baseConfig = { input: { initialUserMessage: "task" }, run: { runId, completion: false } };
    const config = extraConfig === undefined ? baseConfig : {
      ...baseConfig,
      ...extraConfig,
      input: { ...baseConfig.input, ...(extraConfig.input ?? {}) },
      run: { ...baseConfig.run, ...(extraConfig.run ?? {}) },
    };
    const result = await runToolLoop({
      provider,
      config,
      executeTool,
      store,
      ...rest,
      onEvent: (event) => {
        events.push(event);
        onEvent?.(event);
      },
      onToolCall: (fragment) => {
        fragments.push(fragment);
        onToolCall?.(fragment);
      },
    });
    const records = await store.load(runId);
    return {
      provider,
      events,
      fragments,
      result,
      records,
      toolUseFacts: eventsOfType(events, "tool_use").map((event) => event.toolUse),
      toolResultFacts: eventsOfType(events, "tool_result").map((event) => event.toolResult),
    };
  }

  // ── §5 存在性矩阵：成功与失败的全部返回形态 ──────────────────────────────────
  const SUCCESS_FORMS = [
    { name: "string", executor: async () => "plain text", isError: false, success: true },
    { name: "number", executor: async () => 42, isError: false, success: true },
    {
      name: "{content,metadata}",
      executor: async () => ({ content: "structured", metadata: { searchHits: 3 }, success: true }),
      isError: false,
      success: true,
    },
    {
      name: "legacy {data}",
      executor: async () => ({ data: "legacy payload", success: true, toolMessageId: "m-1" }),
      isError: false,
      success: true,
    },
    {
      name: "returned Error",
      executor: async () => new Error("executor said no"),
      isError: true,
      success: false,
    },
    {
      name: "thrown non-abort",
      executor: async () => {
        throw new Error("executor threw");
      },
      isError: true,
      success: false,
    },
  ];

  for (const form of SUCCESS_FORMS) {
    test(`${label}: 返回形态 ${form.name} —— toolCallKey/round/durationMs/success 齐全，is_error=${form.isError}`, async () => {
      const { toolResultFacts, toolUseFacts } = await runCase(form.executor);
      assert.equal(toolResultFacts.length, 1);
      const fact = toolResultFacts[0];

      // 协议必需字段在顶层（期望集合由常量生成）
      for (const field of contract.protocol.required) {
        assert.ok(Object.hasOwn(fact, field), `协议必需字段 ${field} 必须在顶层`);
      }
      assert.equal(fact.is_error, form.isError ? true : undefined);

      // 引擎事实只在 erix.*，且字段集合恰为矩阵这一行（T2 起 `success` 一律写，不再看宿主声明）
      assert.deepEqual(
        Object.keys(fact.erix).sort(),
        expectedEngineFields(...EXECUTED_RESULT_FIELDS),
      );
      assert.match(fact.erix.toolCallKey, TOOL_CALL_KEY_PATTERN);
      assert.equal(fact.erix.round, 1);
      assert.equal(typeof fact.erix.durationMs, "number");
      assert.ok(Number.isFinite(fact.erix.durationMs) && fact.erix.durationMs >= 0);
      assert.equal(fact.erix.executionStatus, undefined);
      assert.equal(fact.erix.success, form.success,
        "erix.success 一律写，取值就是旧顶层那个表达式归一化后的布尔");
      // 引擎事实不出现在顶层；顶层也不得再出现退役名单里的任何一个旧名（停写的定义就是这一条）。
      for (const key of ["toolCallKey", "round", "durationMs", "success"]) {
        assert.equal(Object.hasOwn(fact, key), false,
          `顶层不得再出现 \`${key}\`（引擎事实只在 \`${contract.engine.ns}.*\`）：${JSON.stringify(fact)}`);
      }
      for (const key of RETIRED_TOP_LEVEL_KEYS) {
        assert.equal(Object.hasOwn(fact, key), false, `退役的顶层旧名 \`${key}\` 又回到写入了`);
      }
      // provider 配对键未被改写
      assert.equal(fact.tool_use_id, "call-1");
      assert.equal(toolUseFacts[0].id, "call-1");
      assert.equal(toolUseFacts[0].erix.toolCallKey, fact.erix.toolCallKey,
        "线 A 的 tool_use 与线 B 的 tool_result 必须带同一个身份键");
    });
  }

  // ── 停写后：宿主键只在 `metadata`（顶层摊平已退役），引擎写的键不进 metadata ──
  test(`${label}: 宿主扩展键只在 metadata、顶层不得再出现摊平键，且 metadata 里没有引擎写的键`, async () => {
    const { provider, toolResultFacts, records } = await runCase(
      async () => ({ content: "structured", metadata: { artifactStatus: "ok" }, success: true }),
    );
    const fact = toolResultFacts[0];
    assert.deepEqual(fact.metadata, { artifactStatus: "ok" },
      "metadata.* 只装宿主自己给的键：引擎写的 duration/success 不许漏进宿主命名空间");
    // 下面三条是 T1 那三条「双写期照写」的**反向**（断言方向反了等于没改）。
    assert.equal(Object.hasOwn(fact, "artifactStatus"), false,
      "宿主摊平键不得再出现在顶层（值在 metadata.artifactStatus）");
    assert.equal(Object.hasOwn(fact, "duration"), false,
      "顶层 duration 已退役，耗时只在 erix.durationMs");
    assert.equal(Object.hasOwn(fact, "success"), false,
      "顶层 success 已退役，成败只在 erix.success");
    assert.equal(typeof fact.erix.durationMs, "number");
    assert.equal(fact.erix.success, true, "erix.success 写引擎判定后的布尔值");

    // 线 A ↔ 线 B：已提交的调用，事件里的事实与落盘 block 逐字段相等（同一对象的两个克隆）
    const persisted = blocksOfMessages(records.flatMap((record) => record.messages ?? []), "tool_result");
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0], fact);
    assert.equal(fedBackToolResult(provider, "call-1").erix.toolCallKey, fact.erix.toolCallKey);
  });

  // ── 保留键名：宿主自有键不得吃掉命名空间那两个顶层键 ────────────────────────────
  test(`${label}: 宿主自有键恰好叫 metadata / erix 时，命名空间不被吃掉（保留键由常量登记）`, async () => {
    const { TOOL_RESULT_CONTRACT: constant } = await entry();
    // 保留键名是常量里登记的事实，不是套件手抄的清单。
    assert.deepEqual([...constant.reserved.topLevelKeys].sort(), ["erix", "metadata"]);
    assert.deepEqual(
      [...constant.reserved.topLevelKeys].sort(),
      [constant.engine.ns, constant.host.ns].sort(),
      "保留键名就是那两个命名空间名本身，两处必须同源",
    );

    // 走完整链路：executor 交回来的扩展里就有这两个要命的名字。
    const { toolResultFacts } = await runCase(
      async () => ({
        content: "structured",
        metadata: { metadata: { hits: 3 }, erix: "mine", artifactStatus: "ok" },
        success: true,
      }),
    );
    const fact = toolResultFacts[0];
    // 顶层那两个键是命名空间，不是宿主自己的值（修前：双写包先写、命名空间再盖，值在顶层消失）。
    assert.equal(typeof fact.erix, "object", "顶层 erix 必须是引擎命名空间");
    assert.deepEqual(Object.keys(fact.metadata).sort(), ["artifactStatus", "erix", "metadata"],
      "宿主那两个同名键必须原样留在宿主命名空间里，一个都不丢");
    assert.deepEqual(fact.metadata.metadata, { hits: 3 }, "宿主自己的 metadata 键不得被吃掉");
    assert.equal(fact.metadata.erix, "mine", "宿主自己的 erix 键不得被引擎命名空间吃掉");
    assert.equal(Object.hasOwn(fact, "artifactStatus"), false,
      "普通宿主键同样只在 metadata：顶层不再有摊平路径，保留键也就没有可被盖的东西");
    assert.equal(fact.erix.toolCallKey !== undefined, true, "引擎命名空间里仍是引擎事实");
    assert.equal(fact.erix.artifactStatus, undefined, "宿主键不得漏进引擎命名空间");
  });

  test(`${label}: 构造器直接调用时，顶层只剩协议字段与两个命名空间（双写入参已退役）`, async () => {
    const { buildToolResultFact, TOOL_RESULT_CONTRACT: constant } = await entry();
    // ① 两个命名空间都写出来的常见形状：除协议字段外只有这两个键。
    const both = buildToolResultFact({
      toolUseId: "k-1",
      content: "body",
      hostMetadata: { artifactStatus: "ok" },
      engine: { toolCallKey: "tc_1234567890ab", round: 4 },
    });
    assert.deepEqual(
      Object.keys(both).sort(),
      ["content", "erix", "metadata", "tool_use_id", "type"],
      `引擎写出的块的顶层键集合就是「协议字段 + 两个命名空间」：${JSON.stringify(Object.keys(both))}`,
    );
    assert.deepEqual(both.erix, { toolCallKey: "tc_1234567890ab", round: 4 },
      "顶层 erix 只属于引擎命名空间");
    assert.deepEqual(both.metadata, { artifactStatus: "ok" }, "顶层 metadata 只属于宿主命名空间");

    // ② 双写入参已是退役通道：再传一个 `legacyTopLevel` 也必须被忽略（写入路径整条删掉了，
    //    不是「传了但被过滤」）——否则旧顶层键会在某个调用点默默复活。
    const retiredInput = {
      content: "body",
      legacyTopLevel: { metadata: "host-owned", erix: "host-owned", artifactStatus: "ok", erixRound: 4 },
    };
    const bare = buildToolResultFact(retiredInput);
    assert.equal(Object.hasOwn(bare, "artifactStatus"), false, "退役入参不得再往顶层写任何键");
    assert.equal(Object.hasOwn(bare, "erixRound"), false, "年龄标记只能由 engine.round 产生");
    assert.equal(Object.hasOwn(bare, constant.engine.ns), false,
      `没有引擎事实时顶层不该出现 \`${constant.engine.ns}\`，更不该是宿主的摊平值：${JSON.stringify(bare[constant.engine.ns])}`);
    assert.equal(Object.hasOwn(bare, constant.host.ns), false,
      `没有宿主扩展时顶层不该出现 \`${constant.host.ns}\`，更不该是宿主的摊平值：${JSON.stringify(bare[constant.host.ns])}`);
    // 宿主的同名扩展走命名空间才留得住（保留键名从「被过滤」变成「天然只住这里」）。
    const namespaced = buildToolResultFact({
      content: "body",
      hostMetadata: { metadata: "host-owned", erix: "host-owned" },
    });
    assert.deepEqual(namespaced.metadata, { metadata: "host-owned", erix: "host-owned" });
    assert.equal(Object.hasOwn(namespaced, constant.engine.ns), false,
      "宿主那个叫 erix 的扩展不会冒充引擎命名空间：没有引擎事实就没有该键");
  });

  test(`${label}: 退役名单的内容与语义（常量不再写、旧记录一代内仍可读）`, async () => {
    const { TOOL_RESULT_CONTRACT: constant } = await entry();
    // 名单内容：四个顶层旧名 + 一条塔平占位（`success` 是 T2 新登记的一条）。
    assert.deepEqual(constant.legacy.aliases, {
      erixRound: "erix.round",
      duration: "erix.durationMs",
      executionStatus: "erix.executionStatus",
      success: "erix.success",
      "<host key>@top level": "metadata.<host key>",
    });
    // 语义：引擎不再写它们（所以下面两个旧字段名不得出现在 engine.fields 里），
    // 而退役节奏仍写在常量里（文档锦定与契约套件都读它）。
    assert.equal(constant.legacy.written, false, "名单的语义就是「不再写」，该由常量自己说出来");
    assert.equal(constant.legacy.retireAt.includes("minor"), true,
      "退役窗口必须仍然写在常量里");
    assert.equal(constant.legacy.readWindow.includes("一代"), true,
      "旧记录一代内可读这条承诺也要写在常量里");
    for (const retired of ["erixRound", "duration"]) {
      assert.equal(Object.hasOwn(constant.engine.fields, retired), false,
        `${retired} 是退役名，不是引擎字段`);
    }
  });

  test(`${label}: 未显式声明 success 也写 erix.success（T2 取消条件，一律写）`, async () => {
    const { toolResultFacts } = await runCase(async () => ({ content: "no verdict" }));
    const fact = toolResultFacts[0];
    assert.equal(fact.erix.success, true,
      "没声明就是引擎判定为成功：顶层停写后这是成败的唯一出口，缺键会被读成「不知道」");
    assert.equal(fact.is_error, undefined);
    assert.equal(Object.hasOwn(fact, "success"), false, "顶层旧键不得再写");
  });

  test(`${label}: 显式 success:false 同时写 erix.success 与顶层 is_error`, async () => {
    const { toolResultFacts } = await runCase(async () => ({ content: "partial", success: false }));
    assert.equal(toolResultFacts[0].erix.success, false);
    assert.equal(toolResultFacts[0].is_error, true);
    assert.equal(typeof toolResultFacts[0].erix.durationMs, "number");
  });

  // issue #286（0.20.0 追加）：`erix.executionStatus` 是**条件存在**字段。引擎行为不变，但常量面
  // 以前没标这个存在条件 → 只读 `TOOL_RESULT_CONTRACT` 的宿主会按「每个结果块都有」写代码。
  test(`${label}: erix.executionStatus 只在特殊状态存在，常量面登记了存在条件（issue #286）`, async () => {
    const { buildToolResultFact, TOOL_RESULT_CONTRACT: constant } = await entry();
    const spec = constant.engine.fields.executionStatus;
    assert.equal(spec.writtenFor, "special states only",
      "常量必须标出存在条件，否则只读常量的消费者会把它当恒存在字段");
    // issue #409 追加第三档 `rejected`：引数解析失败 ⇒ 工具从未执行，判词经 `is_error` 的
    // `tool_result` 回给模型（见下面矩阵里那一条）。取值面扩展 = 契约新增，所以这里必须逐值手写。
    assert.deepEqual(spec.presentValues, ["intercepted", "interrupted", "rejected"]);

    // 普通结果块：**无条件**断言它不存在（不是「有就查」）
    const plain = buildToolResultFact({
      toolUseId: "k-1",
      content: "body",
      engine: { toolCallKey: "tc_1234567890ab", round: 1, success: true },
    });
    assert.equal(Object.hasOwn(plain.erix, "executionStatus"), false,
      `普通结果块不该带 executionStatus：${JSON.stringify(plain.erix)}`);
    assert.equal(plain.erix.executionStatus, undefined);

    // 端到端：真跑一轮的普通成功 / 失败结果都不带（失败也不是特殊状态）
    const { toolResultFacts: okFacts } = await runCase(async () => ({ content: "done", success: true }));
    assert.equal(Object.hasOwn(okFacts[0].erix, "executionStatus"), false,
      `引擎只在 resume 改写与审计拦截时写它：${JSON.stringify(okFacts[0].erix)}`);
    const { toolResultFacts: badFacts } = await runCase(async () => ({ content: "nope", success: false }));
    assert.equal(Object.hasOwn(badFacts[0].erix, "executionStatus"), false);

    // 特殊状态：逐值钉住「等于对应值」
    for (const status of spec.presentValues) {
      const special = buildToolResultFact({
        toolUseId: "k-2",
        content: "body",
        engine: { toolCallKey: "tc_1234567890ab", round: 2, executionStatus: status },
      });
      assert.equal(special.erix.executionStatus, status, `${status} 必须原值写进 erix 命名空间`);
      assert.equal(Object.hasOwn(special, "executionStatus"), false, "旧顶层摊平路径不得复活");
    }
  });

  // ── 跨通道身份：onToolCall fragment → tool_use → tool_result 同一个值 ────────
  test(`${label}: 流式片段的 toolCallKey 与 tool_use / tool_result 同值，原有片段字段不动`, async () => {
    const { runToolLoop, createMemoryTranscriptStore } = await entry();
    const provider = streamingToolCallProvider("call_stream", [
      { index: 0, argumentsDelta: "{\"n\": " },
      { index: 0, id: "call_stream", name: "work" },
      { index: 0, argumentsDelta: "1}" },
    ]);
    const fragments = [];
    const events = [];
    await runToolLoop({
      provider,
      // #498 S3 A16: `stream` has no flat spelling any more — canonical home `config.run.stream`.
      config: {
        input: { initialUserMessage: "task" },
        run: { stream: true, runId: "contract-stream-key", completion: false },
      },
      executeTool: async () => "ok",
      store: createMemoryTranscriptStore(),
      onToolCall: (fragment) => fragments.push(fragment),
      onEvent: (event) => events.push(event),
    });

    assert.ok(fragments.length >= 2, "至少要看到两个片段，否则这条断言没内容");
    for (const fragment of fragments) {
      assert.match(fragment.toolCallKey, TOOL_CALL_KEY_PATTERN);
      assert.equal(typeof fragment.index, "number");
    }
    assert.ok(fragments.some((fragment) => typeof fragment.argumentsDelta === "string"),
      "原有字段 argumentsDelta 必须原样透传（片段形状只增不改）");
    assert.equal(new Set(fragments.map((fragment) => fragment.toolCallKey)).size, 1,
      "同一次调用的所有片段必须共用一个 key（id 迟到的 OpenAI 形状靠 index 桥接）");
    const toolUse = eventsOfType(events, "tool_use")[0].toolUse;
    assert.equal(toolUse.id, "call_stream", "provider id 不得被改写");
    assert.equal(toolUse.erix.toolCallKey, fragments[0].toolCallKey);
    assert.equal(eventsOfType(events, "tool_result")[0].toolResult.erix.toolCallKey,
      fragments[0].toolCallKey);
    // 当前引擎事实：循环**不**把 provider 的流式 `tool_call` 事件转发到 onEvent（宿主拿片段的
    // 通道是 `onToolCall`；provider 自己发的 `tool_call` 只走 `req.onEvent`，而引擎不注入那个回调）。
    // 钉住这条是为了契约文档里「tool_call 在 onEvent 还是 onToolCall」不能被写成两样。
    assert.deepEqual(eventsOfType(events, "tool_call"), []);
  });

  // ── executor 未 settle 就中止：存在性矩阵的最后一行（不许用假记录补等式）──────────
  test(`${label}: executor 未 settle 就 abort ⇒ tool_use 带身份键，一条 tool_result 也没有`, async () => {
    const { runToolLoop, createMemoryTranscriptStore } = await entry();
    const controller = new AbortController();
    const events = [];
    const store = createMemoryTranscriptStore();
    const runId = "contract-abort-before-settle";
    let executorEntered = false;

    await assert.rejects(
      runToolLoop({
        provider: scriptedProvider([toolRound("hang-1"), DONE]),
        store,
        config: { run: { runId, completion: false } },
        signal: controller.signal,
        executeTool: async () => {
          executorEntered = true;
          // 宿主在工具还在跑的时候就按了停止：executor 这一辈子不会 settle。
          controller.abort(new Error("host stopped the run mid-tool"));
          return new Promise(() => {});
        },
        onEvent: (event) => events.push(event),
      }),
      (error) => {
        assert.equal(error.termination.reason, "aborted");
        return true;
      },
    );

    assert.ok(executorEntered, "本例必须真的走进 executor，否则等于什么都没测");
    const toolUses = eventsOfType(events, "tool_use").map((event) => event.toolUse);
    assert.equal(toolUses.length, 1, "tool_use 事件在中止前已经发出（身份键先于结果存在）");
    assert.match(toolUses[0].erix.toolCallKey, TOOL_CALL_KEY_PATTERN);
    assert.deepEqual(eventsOfType(events, "tool_result"), [],
      "没有结果就没有事实：中止不得让引擎发出一条编出来的 tool_result");
    const persisted = blocksOfMessages(
      (await store.load(runId)).flatMap((record) => record.messages ?? []), "tool_result",
    );
    assert.deepEqual(persisted, [], "线 B 这一轮可以就是没有记录，引擎不得为补齐等式而发明记录");
    assert.deepEqual(eventsOfType(events, "round_end"), [], "本轮没有跑完，不得发 round_end");
  });

  test(`${label}: 墙钟回拨不得造出负的 erix.durationMs（夹到 0，缺失才是未知）`, async () => {
    const realNow = Date.now;
    // executor 一旦开跑就把时钟拨回 5 秒（模拟 NTP 校时/手动改时），于是「settle 时刻 - 起始时刻」
    // 是一个负数。引擎事实必须夹到 0：**负的耗时不是一个可解释的事实**，而缺失另有含义（未知）。
    const rewind = () => { Date.now = () => realNow() - 5000; };
    try {
      const { toolResultFacts } = await runCase(
        async () => {
          rewind();
          return "clock rewound mid-execution";
        },
        { options: { onEvent: (event) => { if (event.type === "tool_result") Date.now = realNow; } } },
      );
      const fact = toolResultFacts[0];
      assert.equal(typeof fact.erix.durationMs, "number");
      assert.ok(Number.isInteger(fact.erix.durationMs) && fact.erix.durationMs >= 0,
        `erix.durationMs 必须非负，实测 ${fact.erix.durationMs}`);
      assert.equal(fact.erix.durationMs, 0, `夹到 0 才对，实测 ${fact.erix.durationMs}`);
    } finally {
      Date.now = realNow;
    }
  });

  // ── 跨轮复用同一个 provider id：那是**两次调用**，不是同一次 ─────────────────────
  // provider 的 tool-call id **不保证 run 内唯一**（轮内 index 前缀，或畸形响应兜底成常量
  // `call_legacy`，issue #284）。所以「按 id 扫历史消息继承 key」会把上一轮那张卡的身份发给
  // 本轮的新调用——串号只是从 `id` 搬进 `toolCallKey`。下面两条钉住：新调用必须拿到新身份，
  // 而 provider 的配对键（`id` / `tool_use_id`）一个字符都不动，仍然逐轮配得上对。
  test(`${label}: 连续两轮同 provider id ⇒ 两次调用各有各的 toolCallKey（配对 id 未改写）`, async () => {
    const executed = [];
    const { records, toolUseFacts, toolResultFacts } = await runCase(
      async ({ id, name }) => {
        executed.push(`${name}:${id}`);
        return "ok";
      },
      {
        // 同一个 id `call_0_dup`（OpenAI 那种「轮内 index 前缀」跨轮重复的真实形状），
        // 换工具名只为绕开 stalled 判定，与本条断言无关。
        script: [toolRound("call_0_dup", "work_first"), toolRound("call_0_dup", "work_second"), DONE],
      },
    );
    assert.deepEqual(executed, ["work_first:call_0_dup", "work_second:call_0_dup"],
      "两次都必须真的执行：新一轮的同 id 调用不得被当成上一轮的复放吞掉");
    assert.equal(toolUseFacts.length, 2);
    assert.equal(toolResultFacts.length, 2);
    const keys = toolUseFacts.map((fact) => fact.erix.toolCallKey);
    for (const key of keys) assert.match(key, TOOL_CALL_KEY_PATTERN);
    assert.equal(new Set(keys).size, 2,
      `跨轮同名 id 是两次不同的调用，必须各有各的身份，实际两次都是 ${keys[0]}`);
    // 反向：provider 的配对键未被改写，也未被拼进 key（key 的形状里不含 id）。
    assert.deepEqual(toolUseFacts.map((fact) => fact.id), ["call_0_dup", "call_0_dup"]);
    assert.deepEqual(toolResultFacts.map((fact) => fact.tool_use_id), ["call_0_dup", "call_0_dup"]);
    assert.equal(/call_0_dup/u.test(keys[0]), false, "key 不得由 provider id 派生");
    // 线 A 内部：每条 tool_result 带回**自己那一次**调用的身份，且不串到另一条上。
    assert.deepEqual(toolResultFacts.map((fact) => fact.erix.toolCallKey), keys);
    assert.deepEqual(toolResultFacts.map((fact) => fact.erix.round), [1, 2]);
    // 线 A ↔ 线 B：落盘的两个块带着同一对身份键。
    assert.deepEqual(
      blocksOfMessages(records.flatMap((record) => record.messages ?? []), "tool_use")
        .map((block) => block.erix?.toolCallKey),
      keys,
    );
  });

  test(`${label}: provider 不给 id（call_legacy 兜底）时，跨轮两次调用也各有各的身份`, async () => {
    const { openAIResponseToCanonical } = await entry();
    // **真走兜底路径**，不是手抄一个同名字符串：legacy `function_call` 形态没有 id，规范化后
    // 落到常量 `call_legacy`（`src/messages/canonical.js` 的 `legacyFunctionCall.id ?? "call_legacy"`，
    // 流式侧同源：`src/messages/openai-normalization.js` 的 `slots[0]?.id ?? "call_legacy"`）。
    const legacyRound = (name) => {
      const canonical = openAIResponseToCanonical({
        choices: [{
          message: { function_call: { name, arguments: JSON.stringify({ n: 1 }) } },
          finish_reason: "function_call",
        }],
      });
      assert.deepEqual(canonical.content.map((block) => block.id), ["call_legacy"],
        "本例必须真的落到兜底常量上，否则等于没测那条路径");
      assert.equal(canonical.stopReason, "tool_use");
      return canonical;
    };
    const executed = [];
    const { toolUseFacts, toolResultFacts } = await runCase(
      async ({ id, name }) => {
        executed.push(`${name}:${id}`);
        return "ok";
      },
      { script: [legacyRound("legacy_first"), legacyRound("legacy_second"), DONE] },
    );
    assert.deepEqual(executed, ["legacy_first:call_legacy", "legacy_second:call_legacy"]);
    const keys = toolUseFacts.map((fact) => fact.erix.toolCallKey);
    assert.equal(new Set(keys).size, 2,
      `兜底常量 call_legacy 不是身份：两轮各得一个 key，实际 ${keys.join(" / ")}`);
    assert.deepEqual(toolResultFacts.map((fact) => fact.tool_use_id), ["call_legacy", "call_legacy"],
      "配对键仍是那个兜底常量本身（未被改写、未被拼接）");
    assert.deepEqual(toolResultFacts.map((fact) => fact.erix.toolCallKey), keys);
  });

  // ── 已完成结果的复放：原值不重算 ─────────────────────────────────────────────
  test(`${label}: 已完成结果复放沿用原 erix 值（durationMs 不重算、executor 不再被调）`, async () => {
    const { runToolLoop, createMemoryTranscriptStore } = await entry();
    const store = createMemoryTranscriptStore();
    const runId = "contract-replay-recorded";
    // 崩溃前已执行完的调用：run snapshot 里同时带着 tool_use 块与结果块，两者共用一个身份键。
    const recorded = {
      type: "tool_result",
      tool_use_id: "done-1",
      content: "recorded before the crash",
      erixRound: 3,
      erix: { toolCallKey: "tc_1234567890ab", round: 3, durationMs: 777 },
    };
    await store.appendRound(runId, { round: 0, messages: [{ role: "user", content: "task" }] });
    await store.saveCheckpoint(runId, {
      round: 3,
      pendingToolUses: [{ type: "tool_use", id: "done-1", name: "work", input: {} }],
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "done-1",
            name: "work",
            input: {},
            erix: { toolCallKey: "tc_1234567890ab" },
          }],
        },
      ],
      executedToolIds: ["done-1"],
      toolResults: [{ toolUseId: "done-1", toolResult: recorded }],
    });

    let calls = 0;
    const events = [];
    await runToolLoop({
      // 模型把己执行过的调用又发了一遍（复放路径），下一轮自然收尾。
      provider: scriptedProvider([toolRound("done-1"), DONE]),
      config: { run: { resume: true, runId, completion: false } },
      store,
      executeTool: async () => {
        calls += 1;
        return "must not execute again";
      },
      onEvent: (event) => events.push(event),
    });

    assert.equal(calls, 0, "复放路径不得二次执行 executor");
    const replayEvent = eventsOfType(events, "tool_result")
      .find((event) => event.toolResult?.tool_use_id === "done-1");
    assert.ok(replayEvent, "应发出复放的 tool_result 事件");
    const replayed = replayEvent.toolResult;
    assert.equal(replayed.content, "recorded before the crash");
    assert.equal(replayed.erix.durationMs, 777, "原值不重算：沿崩溃前那份耗时");
    assert.equal(replayed.erix.round, 3, "erix.round 是执行轮，不是交付轮");
    assert.equal(replayed.erix.toolCallKey, "tc_1234567890ab");
    // 事件 envelope 的 round 是**交付轮**，与 erix.round（执行轮）不合并（工单 §2）。
    assert.notEqual(replayEvent.round, replayed.erix.round);
    assert.equal(
      eventsOfType(events, "tool_use")
        .find((event) => event.toolUse?.id === "done-1").toolUse.erix.toolCallKey,
      "tc_1234567890ab",
      "同一个 provider id 被模型再发一次也不得换身份",
    );
  });

  // ── 升级前写入的记录被复放：身份两端一致地缺失，不许凭空造一个 ───────────────────
  test(`${label}: 复放升级前的已记录结果 ⇒ tool_use 与 tool_result 两端都没有 toolCallKey`, async () => {
    const { runToolLoop, createMemoryTranscriptStore } = await entry();
    const store = createMemoryTranscriptStore();
    const runId = "contract-replay-pre-contract-record";
    // 升级前（0.19 及更早）写下的 run snapshot：结果与块里都**没有 `erix`** —— 那时还没有这套字段。
    const recorded = {
      type: "tool_result",
      tool_use_id: "old-1",
      content: "recorded before the fact contract existed",
      erixRound: 2,
    };
    await store.appendRound(runId, { round: 0, messages: [{ role: "user", content: "task" }] });
    await store.saveCheckpoint(runId, {
      round: 2,
      pendingToolUses: [{ type: "tool_use", id: "old-1", name: "work", input: {} }],
      messages: [
        { role: "user", content: "task" },
        { role: "assistant", content: [{ type: "tool_use", id: "old-1", name: "work", input: {} }] },
      ],
      executedToolIds: ["old-1"],
      toolResults: [{ toolUseId: "old-1", toolResult: recorded }],
    });

    let calls = 0;
    const events = [];
    await runToolLoop({
      provider: scriptedProvider([toolRound("old-1"), DONE]),
      config: { run: { resume: true, runId, completion: false } },
      store,
      executeTool: async () => {
        calls += 1;
        return "must not execute again";
      },
      onEvent: (event) => events.push(event),
    });

    assert.equal(calls, 0, "复放路径不得二次执行 executor");
    const replayed = eventsOfType(events, "tool_result").map((event) => event.toolResult)
      .find((fact) => fact.tool_use_id === "old-1");
    assert.ok(replayed, "应发出复放的 tool_result 事件");
    assert.equal(replayed.content, "recorded before the fact contract existed");
    assert.equal(replayed.erix, undefined, "复放旧记录时不得给它补出引擎命名空间");
    assert.equal(replayed.toolCallKey, undefined, "顶层也不许凭空冒出一个身份键");

    const replayedUse = eventsOfType(events, "tool_use").map((event) => event.toolUse)
      .find((block) => block.id === "old-1");
    assert.ok(replayedUse, "应发出本轮的 tool_use 事件");
    assert.equal(replayedUse.erix, undefined,
      "本轮的 tool_use 也**不认领**新 key：两端一致地缺失，胜过一端有一端没有");
    assert.equal(replayedUse.id, "old-1", "provider 配对键照旧未改");

    // 线 B：落盘的块也没被凭空造出身份（事件里没有、记录里也不许有）。
    const persisted = blocksOfMessages(
      (await store.load(runId)).flatMap((record) => record.messages ?? []), "tool_use",
    ).filter((block) => block.id === "old-1");
    assert.ok(persisted.length >= 1, "线 B 必须有这条 tool_use 块");
    for (const block of persisted) {
      assert.equal(block.erix, undefined, `落盘块被凭空造出了身份：${JSON.stringify(block.erix)}`);
    }
  });

  // ── judge 拦截：未执行 ⇒ 没有 round、没有 durationMs ──────────────────────────
  test(`${label}: judge 拦截的事实没有 round 与 durationMs（未执行 = 未知，不是 0）`, async () => {
    const judge = judgeProvider([{
      done: false, confidence: 0.8, reason: "方向可能偏", evidence: "证据不足",
    }]);
    const executed = [];
    const { toolResultFacts } = await runCase(
      async ({ id }) => {
        executed.push(id);
        return "ok";
      },
      {
        script: [toolRound("a1"), toolRound("a2"), DONE],
        options: {
          // #498 S3 A21: `maxRounds` lives at `config.run.maxRounds` now.
          config: { run: { maxRounds: 8 } },
          reflection: {
            enabled: true, roundJudge: false, judgeIntervalRound: 1, judge: { provider: judge },
          },
        },
      },
    );
    assert.deepEqual(executed, ["a1"], "第二次调用应被拦截（写工具不放行）");
    const intercepted = toolResultFacts.find((fact) => fact.erix?.executionStatus === "intercepted");
    assert.ok(intercepted, `应有一条 intercepted 事实，实际：${JSON.stringify(toolResultFacts)}`);
    assert.deepEqual(
      Object.keys(intercepted.erix).sort(),
      expectedEngineFields("toolCallKey", "executionStatus"),
      "拦截只该带身份键与状态两件事（round/durationMs 未执行 = 未知）",
    );
    assert.equal(intercepted.erix.executionStatus, "intercepted");
    assert.equal(intercepted.erix.round, undefined, "拦截未执行，不该伪造成交轮");
    assert.equal(intercepted.erix.durationMs, undefined, "拦截未执行，耗时是未知而不是 0");
    assert.equal(intercepted.erix.success, undefined, "未执行就没有成败可言：不得为「一律写」编一个 true");
    assert.equal(intercepted.is_error, undefined);
    // 顶层旧键已退役（T1 时这一条的方向是「顶层旧键照写」，已反转）。
    for (const key of RETIRED_TOP_LEVEL_KEYS) {
      assert.equal(Object.hasOwn(intercepted, key), false,
        `拦截事实的顶层不得再出现退役旧名 \`${key}\`：${JSON.stringify(intercepted)}`);
    }
    assert.deepEqual(Object.keys(intercepted).sort(), ["content", "erix", "tool_use_id", "type"],
      "拦截块的顶层只剩协议字段与引擎命名空间（本例没有宿主扩展，连 metadata 也不该有）");
  });

  // ── 引数解析失败：工具从未执行 ⇒ 有身份与状态、无 round/durationMs/success ────
  test(`${label}: 引数解析失败的事实带 rejected 与判词，且工具从未执行（issue #409）`, async () => {
    // 归一化层（`src/messages/tool-arguments.js`）把判词挂在 `tool_use` 块的
    // `erix.argumentsParseError` 上；这里直接按那个形状喂给执行层（provider 契约是 canonical
    // 内容块，真 run 里这一步由 OpenAI/Anthropic 两侧的归一化完成）。
    const parseError = {
      reason: "unparsable",
      message: "Unexpected end of JSON input",
      text: "{\"path\":",
    };
    const badRound = {
      content: [{
        type: "tool_use",
        id: "bad-1",
        name: "readFile",
        input: { _truncatedArguments: "{\"path\":", _raw: "{\"path\":" },
        erix: { argumentsParseError: parseError },
      }],
      stopReason: "tool_use",
    };
    const executed = [];
    const { toolResultFacts } = await runCase(
      async ({ input }) => {
        executed.push(input);
        return "should not run";
      },
      { script: [badRound, DONE] },
    );
    assert.deepEqual(executed, [], "引数解析不了 ⇒ 工具**一次都不许**被调用");
    assert.equal(toolResultFacts.length, 1);
    const rejected = toolResultFacts[0];
    assert.equal(rejected.is_error, true);
    assert.equal(rejected.erix.executionStatus, "rejected");
    assert.deepEqual(
      Object.keys(rejected.erix).sort(),
      expectedEngineFields("toolCallKey", "executionStatus"),
      "被拒的调用只该带身份键与状态两件事（没跑过 ⇒ 没有 round / durationMs / success）",
    );
    assert.equal(rejected.erix.round, undefined, "没执行就没有执行轮");
    assert.equal(rejected.erix.durationMs, undefined, "没执行，耗时是未知而不是 0");
    assert.equal(rejected.erix.success, undefined, "没执行就没有成败可言");
    // 判词里必须有解析器原话与正确形状示例（模型下一轮据此自己改）
    assert.match(rejected.content, /Unexpected end of JSON input/u, "解析器原话必须逐字回给模型");
    assert.match(rejected.content, /正确形状/u, "判词必须带正确形状示例");
    for (const key of RETIRED_TOP_LEVEL_KEYS) {
      assert.equal(Object.hasOwn(rejected, key), false,
        `被拒事实的顶层不得出现退役旧名 \`${key}\`：${JSON.stringify(rejected)}`);
    }
  });

  // ── resume 的 unsafe 中断重放：有身份、无耗时 ─────────────────────────────────
  test(`${label}: resume 中断重放带身份键与 interrupted，且没有 round 与 durationMs`, async () => {
    const { runToolLoop, createMemoryTranscriptStore } = await entry();
    const store = createMemoryTranscriptStore();
    const runId = "contract-resume-interrupted";
    await store.appendRound(runId, {
      round: 0,
      messages: [{ role: "user", content: "task" }],
    });
    await store.saveCheckpoint(runId, {
      round: 3,
      pendingToolUses: [{ type: "tool_use", id: "pending-1", name: "exec", input: { cmd: "rm -rf" } }],
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "pending-1",
              name: "exec",
              input: { cmd: "rm -rf" },
              erix: { toolCallKey: "tc_deadbeefcafe" },
            },
          ],
        },
      ],
      executedToolIds: [],
      toolResults: [],
    });

    const events = [];
    await runToolLoop({
      provider: scriptedProvider([DONE]),
      store,
      // #498 S3（`run` 片 A11）：扁平 `replayPolicy` 已退役，规位是 `config.run.replayPolicy`。
      // #498 S3 A19：`resume` 同样退役（家 `config.run.resume`），并进**同一个** `config` 容器
      // ——两个 `config` 键会后者静默胜，那正是本文件里另一格要防的形状。
      config: { run: { resume: true, replayPolicy: "per-tool-declaration", runId, completion: false } },
      executeTool: async () => "should not run",
      onEvent: (event) => events.push(event),
    });

    const resumedToolUse = eventsOfType(events, "tool_use")[0].toolUse;
    assert.equal(resumedToolUse.erix.toolCallKey, "tc_deadbeefcafe",
      "旧快照块上的身份键必须沿用，不重生成");
    const interrupted = eventsOfType(events, "tool_result").map((event) => event.toolResult)
      .find((fact) => fact.erix?.executionStatus === "interrupted");
    assert.ok(interrupted, "unsafe 调用应产出 interrupted 的 tool_result");
    assert.deepEqual(
      Object.keys(interrupted.erix).sort(),
      expectedEngineFields("toolCallKey", "executionStatus"),
      "中断重放只该带身份键与状态两件事（本轮没跑过）",
    );
    assert.equal(interrupted.erix.toolCallKey, "tc_deadbeefcafe");
    assert.equal(interrupted.is_error, true);
    assert.equal(interrupted.erix.durationMs, undefined, "重放没跑过，耗时不得伪造");
    assert.equal(interrupted.erix.round, undefined);
    assert.equal(interrupted.erix.success, undefined, "没跑过的重放不写成败");
    // 顶层旧键已退役（同样是从「双写期照写」反转过来的）。
    for (const key of RETIRED_TOP_LEVEL_KEYS) {
      assert.equal(Object.hasOwn(interrupted, key), false,
        `中断重放事实的顶层不得再出现 \`${key}\`：${JSON.stringify(interrupted)}`);
    }

    const records = await store.load(runId);
    const persisted = blocksOfMessages(records.flatMap((record) => record.messages ?? []), "tool_result")
      .filter((block) => block.tool_use_id === "pending-1");
    assert.ok(persisted.length >= 1, "线 B 必须有这条记录");
    assert.deepEqual(persisted.at(-1).erix, interrupted.erix);
  });

  // ── 投影：B 的派生视图新增两字段，legacy 记录一律缺省 ─────────────────────────
  test(`${label}: 投影带出 toolCallKey 与 durationMs，旧记录（无 erix）两字段缺省`, async () => {
    const { projectTranscriptForDisplay } = await entry();
    const { records } = await runCase(async () => "body");
    const calls = projectTranscriptForDisplay(records)
      .flatMap((turn) => turn.toolCalls ?? []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "call-1", "投影仍保留 provider id 作为结果关联键");
    assert.match(calls[0].toolCallKey, TOOL_CALL_KEY_PATTERN);
    assert.equal(typeof calls[0].durationMs, "number");
    assert.equal(typeof calls[0].key, "string", "位置型展示键必须仍然存在（语义未变）");

    const legacy = projectTranscriptForDisplay([{
      round: 9,
      response: { content: [{ type: "tool_use", id: "old-1", name: "work", input: {} }] },
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "old-1", content: "x" }] }],
    }]).flatMap((turn) => turn.toolCalls ?? []);
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].toolCallKey, undefined, "0.19 及更早的记录没有该字段，投影不得造一个");
    assert.equal(legacy[0].durationMs, undefined, "缺失就是缺失，不得渲染成 0");
  });

  // ── 单轮聚合把 content 换成 stub 时，事实字段必须留着 ─────────────────────────
  test(`${label}: 聚合 stub 只换 content，erix 与 metadata 字段原样保留`, async () => {
    const { toolResultFacts } = await runCase(
      async () => ({ content: "巨".repeat(120000), metadata: { artifactStatus: "ok" } }),
      // #498 S3 A13: `outputHygiene` retired its flat spelling; `config.run.outputHygiene` is the
      // only home now — and it must join the **same** `config` container as the folding budget.
      { options: { config: { folding: { context: { budgetTokens: 53337 } }, run: { outputHygiene: { limit: 1_000_000 } } } } },
    );
    const fact = toolResultFacts[0];
    assert.notEqual(fact.content, "巨".repeat(120000), "本例必须真的走到 stub 化，否则等于没测");
    assert.match(fact.content, /预算/u);
    assert.equal(fact.metadata.artifactStatus, "ok");
    assert.match(fact.erix.toolCallKey, TOOL_CALL_KEY_PATTERN);
    assert.equal(fact.erix.round, 1);
    assert.equal(typeof fact.erix.durationMs, "number");
  });

  // ── 观察者改写与卫生不改变耗时口径 ────────────────────────────────────────────
  test(`${label}: durationMs 不含 onToolResult 改写耗时（口径 = executor settle）`, async () => {
    const { toolResultFacts } = await runCase(
      async () => ({ content: "fast", metadata: {} }),
      {
        options: {
          onToolResult: async () => {
            const until = Date.now() + 60;
            while (Date.now() < until) { /* 自旋，把 hook 耗时抬到可观测 */ }
            return { content: "rewritten", metadata: {} };
          },
        },
      },
    );
    const fact = toolResultFacts[0];
    assert.equal(fact.content, "rewritten");
    assert.ok(fact.erix.durationMs < 50,
      `erix.durationMs 只该覆盖 executor settle（实测 ${fact.erix.durationMs}ms，hook 自旋了 60ms）`);
    // 旧顶层 `duration` 曾在结构化路径上把 hook 耗时算进去（两个口径故意不相等）；T2 停写后顶层
    // 已没有该键，所以本条钉的是「只剩一个耗时口径」，不再是「旧口径保持不动」。
    assert.equal(Object.hasOwn(fact, "duration"), false,
      `顶层 duration 已退役：实测 ${JSON.stringify(fact.duration)}`);
  });

  // ── 覆盖对账（**必须声明在本文件最后**：它读的是前面每条用例跑过时登记下来的字段名）────
  // 有了它，「往常量里加一个引擎字段但没人断言它」不会静默过关；反方向（常量削字段而构造器
  // 还在写）由各情形的集合对账兜住，「用例引用常量外的名字」由 `expectedEngineFields` 兜住。
  test(`${label}: 常量登记的每个引擎字段都被某条期望集合断言过`, async () => {
    await entry();
    assert.deepEqual(
      Object.keys(contract.engine.fields).sort(),
      [...assertedEngineFields].sort(),
      `常量与本套件的断言覆盖面不齐（常量多出：${
        Object.keys(contract.engine.fields).filter((n) => !assertedEngineFields.has(n)).join(" / ")
      }；套件多出：${
        [...assertedEngineFields].filter((n) => !Object.hasOwn(contract.engine.fields, n)).join(" / ")
      }）`,
    );
  });
}
