// issue #498（S3）—— `run` 组的垂直切片 **A16**：`stream` 按裁决退役。
//
// 裁决（#495，原文不在此复述）：**照 `metadata` 族先例退役，接受「函数被拒」这条收窄**。
// 依据是配置面只装「可用 JSON 表示的数据」，而引擎对 `stream` **只做真值判断、从不调用**——
// 函数在那个位置从来不是行为。所以本片**不**加布尔校验器（那是 #538 的活，且裁决明确否掉了
// 「先加校验器再退役」这条路），也**不**动 `src/loop/provider-runner.js` 的两处读法（读侧一字不动）。
//
// 本文件钉六件事（账目全部派生，不手抄条数）：
//   P. 反向拒绝钉：顶层再写 `stream` ⇒ 当场拒，文案**逐字**指向 `config.run.stream`，
//      并且拒在任何宿主端口被调用之前（零请求）。
//   G. 闸口二（数据面）：`true` / `false` / 对象 / 数字 1 在规位侧**全 ACCEPT**、扁平侧**全拒**。
//      这一格里不存在「两侧取值差异」——`stream` 仍然没有值校验器，退役不放宽也不收紧取值面。
//   F. 函数值：**两个拼写都被拒**（扁平侧名称闸口、规位侧 `config` 的 intake）。这条就是裁决
//      接受的那条收窄，逐字钉住，不许因为「退役了」就把它抹掉。
//   R. 读侧不动：展开相逐字写回 `effectiveOptions.stream`；真 run 里 `config.run.stream: true`
//      仍走 `chatStream`、`false` 仍走 `chat`；`partialPersistence` 依赖它的那条真值判断照旧咬人。
//   N. 邻接与账目：白名单被四个面恰好切一遍（派生），`stream` 是「失去顶层键的叶子」，
//      叶子仍在 schema 里，撞名面（provider 请求字段 / `chatStream` / `--stream` 旗标）一个没动。
//   S. 夹具是翻译点：`withSeed` 产物里没有扁平 `stream`，值落在 `config.run.stream`。
//
// ⚠ 撞名提醒：整词 grep `stream` 在本仓有几百处命中，其中**只有一类**是「`runToolLoop` 的顶层
// 选项」——provider 请求体的 `stream: true`、`decoder.decode(value, { stream: true })`、
// `provider.chatStream`、CLI 的 `--stream` 旗标全都**不是**同一个东西。本片只退役那一个入口。
//
// 零真实 LLM（fake / scripted provider）、不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_NAMESPACE_SCHEMA,
  configPathForOption,
  configSchemaSelfCheck,
  optionHomeBuckets,
  CONFIG_SURFACE_OPTION_NAMES,
} from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  normalizeRunToolLoopOptions,
} from "../src/loop/option-normalization.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { runDirect, withSeed } from "./helpers/run-direct.js";

/** 本片退役的键（字符串标量；家由 schema 派生）。 */
const KEY = "stream";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 规位路径（`run.stream`），拒绝文案里点名的那一条。 */
function homeOf(key) {
  const path = configPathForOption(key);
  assert.equal(typeof path, "string", `${key} 失去顶层键之后必须仍有 config 家`);
  return `config.${path}`;
}

/**
 * 最小合法 run：一次 end_turn 就结束。
 *
 * 与 A15 同理：**不经过** `runDirect` 夹具——夹具会把扁平拼写翻译进规位，于是「扁平拼写被拒」
 * 这一格永远测不到。本文件要测的正是引擎拼写，所以直连 `runToolLoop`。
 */
function base(extra = {}) {
  return {
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    ...extra,
    // #498 S3 A18: `wrapup` left the allowlist, so the fixture-era flat switch is gone; the home is
    // `config.input.wrapup`. The container is **merged** instead of spread over: a call site that
    // passes its own `config` keeps both the seed and the wrap-up switch (a plain `config` key after
    // `...extra` would silently drop one of them).
    config: {
      ...extra.config,
      input: { initialUserMessage: "go", wrapup: false, ...extra.config?.input },
      run: { completion: false, ...extra.config?.run },
    },
  };
}

/** 直连 `runToolLoop` 的「抛了什么」（不抛返回 null）。 */
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

// ================================================================ P. 反向拒绝

test(`P1 扁平拼写已退役：名称闸口当场拒，文案逐字点名 ${KEY} 的新家`, async () => {
  const home = homeOf(KEY);
  assert.equal(home, "config.run.stream", "家必须仍是 config.run.stream（删扁平键 ≠ 删叶子）");
  const error = await rawError(base({ [KEY]: true }));
  assert.equal(error instanceof TypeError, true, `${KEY} 的扁平拼写必须当场拒`);
  assert.equal(
    error.message,
    `unknown runToolLoop option: "${KEY}" (its canonical home is ${home}; the flat spelling is rejected)`,
    `${KEY} 的拒绝文案必须逐字点名 ${home}`,
  );
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(KEY), false, `${KEY} 不许还在白名单`);
});

test(`P2 扁平写法在**任何 provider 调用之前**被拒（零请求）`, async () => {
  const provider = createFakeProvider(DONE);
  const error = await runToolLoop(base({ provider, [KEY]: true })).then(() => null, (e) => e);
  assert.equal(error instanceof TypeError, true);
  assert.equal(provider.requests.length, 0, "名称闸口必须早于任何宿主端口被调用");
});

// ================================================================ G. 闸口二（数据面）

test(`G1 闸口二矩阵（${KEY}）：数据取值规位侧全 ACCEPT，扁平侧全被名称闸口拒`, async () => {
  // ⚠ 这一格里**没有**「两侧取值差异」：数据取值在规位侧一个都不被拒（没有值校验器），
  // 差异只在「拼写」这一维上。别把 as-is 时代那句「两侧都可达」照抄成「两侧都拒」。
  const shapes = [true, false, { onChunk: "x" }, 1];
  assert.ok(shapes.length >= 2, `${KEY} 至少要抽查 2 格数据取值`);
  const nameGate = `unknown runToolLoop option: "${KEY}" (its canonical home is ${homeOf(KEY)};`
    + " the flat spelling is rejected)";
  for (const value of shapes) {
    const label = `${KEY}=${JSON.stringify(value)}`;
    const nested = await exitCode(base({
      config: { input: { initialUserMessage: "go" }, run: { [KEY]: value } },
    }));
    assert.equal(nested, 0, `${label}：规位必须可达（exit 0，取值面没被收紧）`);
    const flat = await rawError(base({ [KEY]: value }));
    assert.equal(flat instanceof TypeError, true, `${label}：扁平拼写已退役 ⇒ 必须当场拒`);
    assert.equal(flat.message, nameGate, `${label}：扁平侧拒在名称闸口（逐字）`);
  }
});

test(`G2 取值逐字到达 effectiveOptions（引擎既不校验也不改写）`, async () => {
  for (const value of [true, false, 1, { onChunk: "x" }]) {
    const { effectiveOptions } = await normalizeRunToolLoopOptions({
      config: { run: { [KEY]: value } },
    });
    assert.deepEqual(effectiveOptions[KEY], value, `${JSON.stringify(value)} 必须逐字写回`);
  }
});

// ================================================================ F. 函数值（裁决接受的收窄）

test(`F1 函数值：扁平侧与规位侧**都**被拒（这就是本片接受的收窄）`, async () => {
  const flat = await rawError(base({ [KEY]: () => 1 }));
  assert.equal(flat instanceof TypeError, true, "扁平侧：名称闸口（A16 之前它是 exit 0）");
  assert.match(flat.message, new RegExp(`^unknown runToolLoop option: "${KEY}"`, "u"));

  const nested = await rawError(base({
    config: { input: { initialUserMessage: "go" }, run: { [KEY]: () => 1 } },
  }));
  assert.equal(nested instanceof TypeError, true, "规位侧：`config` 只装数据（这条一个字没动）");
  assert.match(nested.message, new RegExp(`^config\\.run\\.${KEY} is not accepted`, "u"));
  assert.match(nested.message, /the config namespace holds data only/u);
  assert.match(nested.message, /the engine never calls it, it only forwards the value/u,
    "「引擎从不调用它」是裁决的正当性说明：函数在这个位置从来不是行为");
});

// ================================================================ R. 读侧不动

test(`R1 真 run：规位 ${KEY}: true 仍走 chatStream，false 仍走 chat（读侧一行未改）`, async () => {
  /** 记下这次 run 到底走了哪条通道。 */
  function channelSpy() {
    const seen = { stream: 0, batch: 0 };
    const provider = {
      protocol: "fake",
      model: "fake-model",
      async chat() {
        seen.batch += 1;
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
      },
      async chatStream() {
        seen.stream += 1;
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
      },
    };
    return { provider, seen };
  }

  const on = channelSpy();
  const streamed = await runDirect({
    provider: on.provider,
    seed: "go",
    stream: true,
    executeTool: async () => "ok",
    completion: false,
    wrapup: false,
  });
  assert.equal(streamed.termination.reason, "end_turn");
  assert.equal(on.seen.stream, 1, "`stream: true` 必须仍打开流式通道");
  assert.equal(on.seen.batch, 0);

  const off = channelSpy();
  const batch = await runDirect({
    provider: off.provider,
    seed: "go",
    executeTool: async () => "ok",
    completion: false,
    wrapup: false,
  });
  assert.equal(batch.termination.reason, "end_turn");
  assert.equal(off.seen.stream, 0, "不传就仍是批式通道（缺省 false）");
  assert.equal(off.seen.batch, 1);
});

test(`R2 ${KEY} 的真值判断仍咬人：partialPersistence 依赖它（唯一那处读法）`, async () => {
  // `src/loop/orchestrator.js`: `if (partialPersistence !== false && !stream) throw ...`——
  // 这就是「引擎只做真值判断、从不调用」那句话的出处，本片一个字没动。
  await assert.rejects(
    runToolLoop(base({
      config: {
        input: { initialUserMessage: "go" },
        run: { partialPersistence: { intervalMs: 10 }, [KEY]: false },
      },
    })),
    { name: "TypeError", message: "partialPersistence requires stream: true" },
  );
  const ok = await runToolLoop(base({
    config: {
      input: { initialUserMessage: "go" },
      run: { partialPersistence: { intervalMs: 10 }, [KEY]: true },
    },
  }));
  assert.equal(ok.termination.reason, "end_turn", "`stream: true` + partialPersistence 照旧跑通");
});

// ================================================================ S. 夹具是翻译点

test(`S1 夹具是翻译点：withSeed 产物里没有扁平 ${KEY}，值落在 config.run`, () => {
  const moved = withSeed({ [KEY]: true, seed: "go" });
  assert.equal(Object.hasOwn(moved, KEY), false, "夹具漏摘扁平键 ⇒ 引擎当场拒");
  assert.equal(moved.config.run[KEY], true, "值必须搬进 config.run");
  assert.equal(moved.config.input.initialUserMessage, "go", "种子照旧进 config.input");
  const untouched = withSeed({ [KEY]: undefined, seed: "go" });
  assert.equal(untouched.config.run, undefined, "undefined 不许被翻译成一个键");
});

// ================================================================ N. 邻接与账目

test("N1 四向闭合 + 账目派生：删键只搬家，配置面顶层键 + 孤儿叶子 = 叶子总数", () => {
  const { configPlane, capability, topLevelSurface, containers } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  const partition = [...configPlane, ...capability, ...topLevelSurface, ...containers];
  assert.equal(new Set(partition).size, partition.length, "四个面两两不相交");
  assert.deepEqual([...partition].sort(), [...RUN_TOOL_LOOP_OPTION_NAMES].sort(),
    "四向之和逐键等于白名单（不靠条数自证）");
  const leaves = Object.values(CONFIG_NAMESPACE_SCHEMA).flat();
  const orphanLeaves = leaves.filter((leaf) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(leaf));
  assert.equal(configPlane.includes(KEY), false, `${KEY} 已退役 ⇒ 不在配置面顶层键里`);
  assert.equal(configPathForOption(KEY) !== undefined, true, `${KEY} 的叶子仍有家`);
  assert.ok(orphanLeaves.includes(KEY), `${KEY} 必须出现在「失去顶层键的叶子」里`);
  assert.equal(configPlane.length + orphanLeaves.length, leaves.length,
    "配置面顶层键 + 孤儿叶子必须等于叶子总数（删键只搬家，不丢叶子）");
  assert.equal(configPlane.length + orphanLeaves.length, CONFIG_SURFACE_OPTION_NAMES.length,
    "配置面名单本身没变（本片只动白名单，不动 schema）");
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), []);
});

test("N2 撞名面逐类钉住：只有 `runToolLoop` 的顶层选项被退役", () => {
  // 归属表（本片只动第 ① 类）：
  //   ① 顶层选项 `runToolLoop({ stream })`     → 本片退役（→ `config.run.stream`）
  //   ② provider 请求体的 `stream: true`       → OpenAI/Anthropic 协议字段（`src/providers/*`）
  //   ③ `decoder.decode(value, { stream: true })` → 流式解码器参数（`src/providers/*`、`bin/mcp.js`）
  //   ④ `provider.chatStream`                  → 端口方法名（`src/loop/provider-runner.js` 的读侧）
  //   ⑤ CLI 的 `--stream` 旗标                  → `bin/` 的宿主面，与引擎选项无关
  // ①：叶子仍在 schema 里。
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(KEY), true, "叶子不许被顺手删掉");
  // ②：provider 请求字段仍是协议字段，与白名单无关。
  const requestBody = { model: "m", messages: [], stream: true };
  assert.equal(requestBody.stream, true, "请求体字段是独立面，本片不碰");
  // ④：端口方法名照旧存在（本片不 import `provider-runner.js`，只钉「它不是引擎选项名」）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("chatStream"), false, "`chatStream` 从来不是引擎选项");
});

test("N3 `#538` 是已知缺陷，本片未修（读侧两处读法一字未动）", () => {
  // 本片**不**修 `stream` 的两处读法矛盾（`orchestrator.js` 的真值判断 vs `provider-runner.js` 的
  // `ctx.stream === true` 严格比较）：裁决把「退役写侧」与「修读侧」拆成了两件事。
  // 这里只钉住「退役没有顺手改读侧」：`effectiveOptions.stream` 逐字保留宿主给的值，
  // 于是 `1` 这类非布尔真值**仍然**只在 orchestrator 那处算真、在 provider-runner 那处不算——
  // 那是 #538 的形状，本片不掩盖也不修。
  return normalizeRunToolLoopOptions({ config: { run: { [KEY]: 1 } } }).then(({ effectiveOptions }) => {
    assert.equal(effectiveOptions[KEY], 1, "读侧照旧拿到宿主原值（本片不替它做布尔化）");
    assert.notEqual(effectiveOptions[KEY], true, "1 仍是 1，没有被归一化成 true（#538 的形状保持原样）");
  });
});
