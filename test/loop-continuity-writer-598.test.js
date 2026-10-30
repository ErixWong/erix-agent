// issue #598 —— 续接块的**默认写者**（引擎侧）：模型在同一次响应里顺手写 `<handoff>`，引擎负责
// 注入指令 / 解析 / 落盘 / 下次 run 召回；`continuityProvider` 保留为 override；**默认关**。
//
// 判据（每条一个 test，名字里带编号，红的时候一眼知道打的是哪一格）：
//   1. **默认关 = 零变更**：`off`（以及完全不写这个叶）时请求逐字等于今天，且不含 `<handoff>` 指令；
//   2. **跨 run 召回**：run A 的模型输出含 `<handoff>` ⇒ 落盘；run B 的**首条请求**逐字含三段；
//   3. **不编造**：模型没写 ⇒ 块里明写 `unknown`，run 正常结束（不失败、不重试）；
//   4. **只搬运不背书**：模型写 `evidence: 已验证`（其实没跑测试）⇒ store 与块里原样是「已验证」，
//      且**不**被升级成引擎的 `verification`；
//   5. **兜底可关**：`prompt-and-fallback` 下没写 ⇒ 恰好 1 次补调用；`prompt` 下没写 ⇒ 0 次。
//
// 判据 6 的三次变异是**手工**实验（改源码 → 跑本文件 → 还原，见 DELIVERY/报告），它们咬的格子是：
//   · 解析键退化成「全文搜 contract」 ⇒ U1 与「判据 6-a 夹具」红；
//   · `unknown` 降级成空串/省略 ⇒ U2 与判据 3 红；
//   · `off` 仍然注入指令 ⇒ 判据 1 红。
//
// 开关的**叶名**是 `config.continuity.handoff`（名词：交接块），不是 `write`：动词做叶子名会让
// `scripts/retired-spelling-scan.mjs` 把文档里每一句 "write" 都算成退役拼写命中，从而不得不放行/抬钉子
// ——那会把「历史正文不许被改写」那把尺子磨钝（评审意见，本文件随之改用 `handoff`）。
//
// 零真实 LLM、零真实 `~/.erix`：fake provider + 内存 transcript store + 注入
// `ERIX_CONTINUITY_DIR`（`createFileContinuityStore` 的 `home`/`cwd`/`dir` 三个注入点的环境形式，
// 与 `src/tools/notes.js` 的 `ERIX_NOTES_DIR` 同一条纪律）。

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { sessionScanPrefix } from "../bin/session-scan.js";
import {
  CONTINUITY_BLOCK_START,
  CONTINUITY_SECTION_NAMES,
  CONTINUITY_WRITE_DEFAULT,
  CONTINUITY_WRITE_MODES,
  HANDOFF_FALLBACK_INSTRUCTION,
  HANDOFF_INSTRUCTION,
  HANDOFF_MARKER_START,
  HANDOFF_UNKNOWN,
  continuityProjectKey,
  createFileContinuityStore,
  handoffSectionsText,
  isContinuityMessage,
  normalizeContinuityProvided,
  normalizeContinuityWriteMode,
  parseHandoff,
  renderContinuityBlock,
} from "../src/loop/continuity-block.js";
import { CONFIG_LEAF_BINDING } from "../src/loop/config-namespace.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { runDirect } from "./helpers/run-direct.js";
import { makeTmp } from "./helpers/tmp.js";

const TOOLS = [{
  name: "echo",
  description: "回显输入",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
}];

const executeTool = async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`;

/**
 * 跑一次 run（共享夹具）：固定 cwd（project-key 的来源）、内存 store、无真实网络。
 *
 * `continuity` 是**引擎拼写**（`config.continuity`）；`undefined` = 一个字节都不写（今天的样子）。
 */
function runWith({ runId, provider, cwd, continuity, continuityProvider, config = {}, maxRounds = 4, events }) {
  return runDirect({
    provider,
    store: createMemoryTranscriptStore(),
    tools: TOOLS,
    executeTool,
    config: {
      ...config,
      run: {
        runId,
        cwd,
        completion: false,
        maxRounds,
        reflection: { enabled: false },
        ...(config.run ?? {}),
      },
      ...(continuity === undefined ? {} : { continuity }),
    },
    seed: "开始任务",
    ...(continuityProvider === undefined && events === undefined
      ? {}
      : {
        capabilities: {
          hooks: {
            ...(continuityProvider === undefined ? {} : { continuityProvider }),
            ...(events === undefined ? {} : { onEvent: (event) => events.push(event) }),
          },
        },
      }),
  });
}

/**
 * 对拍用的规范化：剔掉**跨 run 天然不同**的引擎事实键（`erix.toolCallKey` 是随机 id、
 * `erix.durationMs` 是墙钟）。与 `test/loop-continuity-block-568.test.js` 同一口径。
 */
function normalizeForParity(messages) {
  return JSON.parse(JSON.stringify(messages, (key, value) => (key === "erix" ? undefined : value)));
}

/** 一条消息的正文（字符串形态与块数组形态都收）。 */
function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block?.text ?? ""))
    .join("");
}

/** 请求视图里那条续接块的正文（没有 ⇒ `undefined`）。 */
function blockTextOfRequest(request) {
  return request.messages.map(textOf).filter((text) => text.startsWith(CONTINUITY_BLOCK_START)).at(-1);
}

/** 请求视图里**不是**续接块 / run-state 块 / 交接指令的那几条（= 今天的消息流）。 */
function conversationOf(request) {
  return request.messages.filter((message) => {
    const text = textOf(message);
    return !text.startsWith(CONTINUITY_BLOCK_START)
      && !text.startsWith("[run state deterministic v1]")
      && text !== HANDOFF_INSTRUCTION;
  });
}

/**
 * 把一次 run 的 store 目录指向 `dir`（`ERIX_CONTINUITY_DIR` 是库层默认目录的注入点），
 * 跑完恢复原值——测试绝不碰真实 `~/.erix`。
 */
async function withContinuityDir(dir, body) {
  const previous = process.env.ERIX_CONTINUITY_DIR;
  process.env.ERIX_CONTINUITY_DIR = dir;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.ERIX_CONTINUITY_DIR;
    else process.env.ERIX_CONTINUITY_DIR = previous;
  }
}

/** 读回某个 cwd 的那份 store 记录（没有 ⇒ `undefined`）。 */
async function readRecordFor(dir, cwd) {
  const store = createFileContinuityStore({ dir, cwd });
  return store.read();
}

/** 模型输出里带一段完整交接块的那条 assistant 正文。 */
function handoffAnswer({
  contract = "目标：把 #598 的判据跑绿",
  unfinished = "还欠：变异反向证",
  evidence = "已验证：判据 1–5",
  prefix = "做完了。",
} = {}) {
  return [
    prefix,
    HANDOFF_MARKER_START,
    `contract: ${contract}`,
    `unfinished: ${unfinished}`,
    `evidence: ${evidence}`,
    "</handoff>",
  ].join("\n");
}

// ================================================================ U. 单元面（判据 6 的两条变异靶子）

test("U1 解析只认 marker：散文里出现 `contract` 三个字**不是**交接段", () => {
  const prose = "我把 contract: 这段散文里的契约讲清楚了，也说了 unfinished 与 evidence 的事，但没有 marker。";
  const parsed = parseHandoff(prose);
  assert.equal(parsed.found, false, "没有 <handoff> … </handoff> ⇒ 整块缺失");
  for (const name of CONTINUITY_SECTION_NAMES) {
    assert.equal(parsed.sections[name], HANDOFF_UNKNOWN, `${name} 必须是 unknown（散文不是交接段）`);
  }

  // 有 marker 时只取块内：块外的散文一个字节都不许混进段里。
  const mixed = [
    "前言里提到 contract: 块外的散文契约",
    HANDOFF_MARKER_START,
    "contract: 块内的契约",
    "unfinished: 块内的未完成项",
    "evidence: 块内的证据",
    "</handoff>",
    "后记里又提到 evidence: 块外的证据",
  ].join("\n");
  const inside = parseHandoff(mixed);
  assert.equal(inside.found, true);
  assert.equal(inside.sections.contract, "块内的契约");
  assert.equal(inside.sections.unfinished, "块内的未完成项");
  assert.equal(inside.sections.evidence, "块内的证据");
  assert.equal(JSON.stringify(inside.sections).includes("块外"), false, "块外散文不许进段");
});

test("U2 缺失必须可见：缺段 / 空段 ⇒ 该段字面量 `unknown`（不是空串、不是省略）", () => {
  const partial = parseHandoff([
    HANDOFF_MARKER_START,
    "contract: 只有这一段",
    "unfinished:",
    "</handoff>",
  ].join("\n"));
  assert.equal(partial.found, true);
  assert.equal(partial.sections.contract, "只有这一段");
  assert.equal(partial.sections.unfinished, HANDOFF_UNKNOWN, "空段 ⇒ unknown");
  assert.equal(partial.sections.evidence, HANDOFF_UNKNOWN, "缺段 ⇒ unknown");

  // 渲染面：三段**都在**，缺的那两段各有一行 `- unknown`（#568 的骨架纪律，本单不改它）。
  // 走的是**真**管线：段文本 → `normalizeContinuityProvided`（召回那一侧的形状）→ 渲染。
  const normalized = normalizeContinuityProvided({ text: handoffSectionsText(partial.sections) });
  const rendered = renderContinuityBlock({ sections: normalized.sections, status: normalized.status });
  assert.equal(rendered.text.includes("## unfinished\n- unknown"), true, "缺失必须可见，不许省略该段");
  assert.equal(rendered.text.includes("## evidence\n- unknown"), true, "缺失必须可见，不许省略该段");

  // 段文本这一层也必须写出 `unknown` 这个字面量（store → 召回的中转形态）。
  const text = handoffSectionsText({ contract: "只有这一段" });
  assert.equal(text.includes(`[unfinished]\n${HANDOFF_UNKNOWN}`), true);
  assert.equal(text.includes(`[evidence]\n${HANDOFF_UNKNOWN}`), true);
});

test("U3 段名大小写不敏感、容忍全角冒号，段内容多行原样照抄", () => {
  const parsed = parseHandoff([
    HANDOFF_MARKER_START,
    "Contract：第一行",
    "第二行（同一段的多行内容）",
    "UNFINISHED: 还欠 A",
    "evidence: 已验证",
    "</handoff>",
  ].join("\n"));
  assert.equal(parsed.sections.contract, "第一行\n第二行（同一段的多行内容）", "多行内容原样保留（引擎不润色）");
  assert.equal(parsed.sections.unfinished, "还欠 A");
  assert.equal(parsed.sections.evidence, "已验证");
});

test("U4 project-key 与 session id 同一套 cwd 派生规则（与 sessionScanPrefix 逐字对拍）", () => {
  for (const cwd of ["/tmp/a/proj", "/", "/tmp/带中文/目录", "/tmp/space dir/x"]) {
    assert.equal(
      continuityProjectKey(cwd),
      sessionScanPrefix(cwd),
      `${cwd}: project-key 必须复用 session id 的派生式（不另造一套）`,
    );
  }
  assert.equal(continuityProjectKey("/tmp/a/proj"), "proj-" + continuityProjectKey("/tmp/a/proj").split("-")[1]);
});

test("U5 store：注入 home/cwd ⇒ 只保留最近一份；坏 JSON / 别人的 project-key ⇒ 没有记录", async () => {
  const home = await makeTmp("erix598-store-home");
  const cwd = path.join(home, "proj");
  await mkdir(cwd, { recursive: true });
  const store = createFileContinuityStore({ home, cwd });
  assert.equal(store.dir, path.join(home, ".erix", "continuity"), "默认目录 = <home>/.erix/continuity");
  assert.equal(store.path, path.join(store.dir, `${continuityProjectKey(cwd)}.json`));
  assert.equal(await store.read(), undefined, "没写过 ⇒ undefined");

  await store.write({ source: "model", sections: { contract: "第一份", unfinished: "u1", evidence: "e1" } });
  const first = await store.read();
  assert.equal(first?.sections.contract, "第一份");
  assert.equal(first?.source, "model");

  await store.write({ source: "fallback", sections: { contract: "第二份" } });
  const second = await store.read();
  assert.equal(second?.sections.contract, "第二份", "只保留最近一份（覆盖，不 append）");
  assert.equal(second?.sections.unfinished, HANDOFF_UNKNOWN, "缺段 ⇒ unknown 落盘");
  assert.equal(second?.source, "fallback");
  assert.deepEqual(await readdir(store.dir), [`${continuityProjectKey(cwd)}.json`], "一个 project 一个文件");

  // 坏 JSON ⇒ 「没有记录」（召回失败不许把一次 run 弄红）。
  await writeFile(store.path, "{ not json", "utf8");
  assert.equal(await store.read(), undefined, "坏 JSON ⇒ undefined");

  // 别人的 project-key（文件被挪到另一个目录名下）⇒ 不认。
  const otherCwd = path.join(home, "other");
  await mkdir(otherCwd, { recursive: true });
  await store.write({ source: "model", sections: { contract: "别人的" } });
  const otherStore = createFileContinuityStore({ home, cwd: otherCwd });
  assert.equal(await otherStore.read(), undefined, "记录里的 projectKey 与本次 cwd 不符 ⇒ 不认");
});

test("U6 开关取值与配置叶登记：`continuity.handoff` 是 init 叶，非法字面量在 intake 当场拒", async () => {
  assert.equal(CONFIG_LEAF_BINDING["continuity.handoff"], "init", "开关属 init 叶（createAgent 面）");
  assert.equal(normalizeContinuityWriteMode(undefined), "off", "默认 off");
  assert.equal(normalizeContinuityWriteMode("off"), "off");
  assert.equal(normalizeContinuityWriteMode("prompt"), "prompt");
  assert.equal(normalizeContinuityWriteMode("prompt-and-fallback"), "prompt-and-fallback");
  assert.equal(normalizeContinuityWriteMode("yes"), "off", "读侧不把非法值当半个开关");

  const provider = createFakeProvider([{ content: [{ type: "text", text: "x" }], stopReason: "end_turn" }]);
  await assert.rejects(
    () => runWith({ runId: "s598-badmode", provider, cwd: process.cwd(), continuity: { handoff: "yes" } }),
    (error) => error instanceof TypeError
      && error.message.includes("config.continuity.handoff")
      && error.message.includes('"off" / "prompt" / "prompt-and-fallback"'),
    "非法字面量必须在 intake 被点名拒掉（配了等于没配是静默形状）",
  );
});

// ================================================================ 判据 1

test("判据 1：默认关 = 零变更（不写这个叶与显式 `off` 逐字相同，且请求里没有 <handoff> 指令）", async () => {
  const cwd = await makeTmp("erix598-c1-cwd");
  const dir = path.join(await makeTmp("erix598-c1-store"), "continuity");
  await withContinuityDir(dir, async () => {
    const script = () => [
      { content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "hi" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" },
    ];
    const baseline = createFakeProvider(script());
    const explicitOff = createFakeProvider(script());
    // 同一个 runId ⇒ run-state 块逐字相同，对拍只差「本单有没有动请求」。
    const a = await runWith({ runId: "s598-c1", provider: baseline, cwd });
    const b = await runWith({ runId: "s598-c1", provider: explicitOff, cwd, continuity: { handoff: "off" } });

    assert.equal(a.termination.reason, "end_turn");
    assert.equal(b.termination.reason, "end_turn");
    assert.equal(baseline.requests.length, 2, "前提：两轮（工具 + 收尾）");
    assert.deepEqual(
      normalizeForParity(explicitOff.requests),
      normalizeForParity(baseline.requests),
      "`off` 必须逐字回到今天（请求消息流对拍）",
    );
    assert.equal(JSON.stringify(explicitOff.requests).includes("<handoff>"), false, "`off` 时请求里逐字不含指令");
    assert.equal(JSON.stringify(explicitOff.requests).includes(HANDOFF_INSTRUCTION), false);
    // 连 store 目录都不该被创建（off 时连路径都不算）。
    await assert.rejects(() => stat(dir), (error) => error?.code === "ENOENT", "`off` 不许碰 store");
  });
});

test("判据 1b：`off` 时**块内容**与今天逐字一致（同一个宿主 provider 的两次 run 对拍）", async () => {
  const cwd = await makeTmp("erix598-c1b-cwd");
  const dir = path.join(await makeTmp("erix598-c1b-store"), "continuity");
  const continuityProvider = async () => ({
    version: 3,
    text: ["[contract]", "goal: 对拍", "[unfinished]", "u1: 判据 1b", "[evidence]", "verified: 无"].join("\n"),
  });
  await withContinuityDir(dir, async () => {
    const baseline = createFakeProvider([{ content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" }]);
    const explicitOff = createFakeProvider([{ content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" }]);
    await runWith({ runId: "s598-c1b", provider: baseline, cwd, continuityProvider });
    await runWith({ runId: "s598-c1b", provider: explicitOff, cwd, continuityProvider, continuity: { handoff: "off" } });

    assert.deepEqual(
      normalizeForParity(explicitOff.requests),
      normalizeForParity(baseline.requests),
      "`off` 时块（含 #568 的渲染字节）必须与今天逐字一致",
    );
    assert.equal(blockTextOfRequest(explicitOff.requests[0]), blockTextOfRequest(baseline.requests[0]));
    assert.equal(JSON.stringify(explicitOff.requests).includes("<handoff>"), false);
  });
});

// ================================================================ 判据 2

test("判据 2：跨 run 召回——run A 的输出含 <handoff> ⇒ 落盘；run B 的首条请求逐字含三段", async () => {
  const cwd = await makeTmp("erix598-c2-cwd");
  const dir = path.join(await makeTmp("erix598-c2-store"), "continuity");
  await withContinuityDir(dir, async () => {
    const providerA = createFakeProvider([{
      content: [{ type: "text", text: handoffAnswer() }],
      stopReason: "end_turn",
    }]);
    const runA = await runWith({
      runId: "s598-c2-a", provider: providerA, cwd, continuity: { handoff: "prompt" },
    });
    assert.equal(runA.termination.reason, "end_turn");

    const record = await readRecordFor(dir, cwd);
    assert.ok(record !== undefined, "run A 的 <handoff> 必须落盘");
    assert.equal(record.source, "model", "来源是模型（同一次响应里顺手写）");
    assert.equal(record.sections.contract, "目标：把 #598 的判据跑绿");
    assert.equal(record.sections.unfinished, "还欠：变异反向证");
    assert.equal(record.sections.evidence, "已验证：判据 1–5");

    const providerB = createFakeProvider([{ content: [{ type: "text", text: "继续干" }], stopReason: "end_turn" }]);
    const runB = await runWith({
      runId: "s598-c2-b", provider: providerB, cwd, continuity: { handoff: "prompt" },
    });
    assert.equal(runB.termination.reason, "end_turn");
    const first = providerB.requests[0];
    const block = blockTextOfRequest(first);
    assert.ok(block !== undefined, "run B 的首条请求里必须有一条续接块（召回）");
    for (const line of [
      "## contract",
      "- 目标：把 #598 的判据跑绿",
      "## unfinished",
      "- 还欠：变异反向证",
      "## evidence",
      "- 已验证：判据 1–5",
    ]) {
      assert.ok(block.includes(line), `首条请求的块里必须逐字含 ${JSON.stringify(line)}，实测：\n${block}`);
    }
    // 召回的内容必须来自 store（而不是「模型这次又写了一遍」）：run B 的模型只说了「继续干」。
    assert.equal(textOf(first.messages.at(-1)).includes(HANDOFF_INSTRUCTION), true, "请求尾部仍带注入指令");
  });
});

// ================================================================ 判据 3

test("判据 3：模型没写 ⇒ 块里明写 unknown，run 正常结束（不失败、不重试）", async () => {
  const cwd = await makeTmp("erix598-c3-cwd");
  const dir = path.join(await makeTmp("erix598-c3-store"), "continuity");
  await withContinuityDir(dir, async () => {
    const providerA = createFakeProvider([{
      content: [{ type: "text", text: "干完了，但我没有写交接。" }],
      stopReason: "end_turn",
    }]);
    const runA = await runWith({
      runId: "s598-c3-a", provider: providerA, cwd, continuity: { handoff: "prompt" },
    });
    assert.equal(runA.termination.reason, "end_turn", "run 必须正常结束（不失败）");
    assert.equal(providerA.requests.length, 1, "`prompt` 下不许补调用（不重试）");

    const record = await readRecordFor(dir, cwd);
    assert.ok(record !== undefined, "没写也要落一份记录（下一轮才能把「不知道」说出来）");
    assert.equal(record.source, HANDOFF_UNKNOWN);
    for (const name of CONTINUITY_SECTION_NAMES) {
      assert.equal(record.sections[name], HANDOFF_UNKNOWN, `${name} 必须是 unknown（不编造）`);
    }

    const providerB = createFakeProvider([{ content: [{ type: "text", text: "收到" }], stopReason: "end_turn" }]);
    await runWith({ runId: "s598-c3-b", provider: providerB, cwd, continuity: { handoff: "prompt" } });
    const block = blockTextOfRequest(providerB.requests[0]);
    assert.ok(block !== undefined);
    for (const name of CONTINUITY_SECTION_NAMES) {
      assert.ok(
        block.includes(`## ${name}\n- ${HANDOFF_UNKNOWN}`),
        `${name} 段必须明写 unknown，实测：\n${block}`,
      );
    }

    // 第二半：模型写了块但**缺两段** ⇒ 缺的那两段必须是字面量 `unknown`（不是空串、不是省略）。
    // 这一半咬的是「缺失必须可见」在**落盘 + 召回**这条真路上的形状（判据 6 的第二条变异）。
    const providerC = createFakeProvider([{
      content: [{ type: "text", text: `${HANDOFF_MARKER_START}\ncontract: 只写了契约\nunfinished:\n</handoff>` }],
      stopReason: "end_turn",
    }]);
    await runWith({ runId: "s598-c3-c", provider: providerC, cwd, continuity: { handoff: "prompt" } });
    const partial = await readRecordFor(dir, cwd);
    assert.equal(partial?.sections.contract, "只写了契约");
    assert.equal(partial?.sections.unfinished, HANDOFF_UNKNOWN, "空段必须落成 unknown 字面量");
    assert.equal(partial?.sections.evidence, HANDOFF_UNKNOWN, "缺段必须落成 unknown 字面量");

    const providerD = createFakeProvider([{ content: [{ type: "text", text: "收到" }], stopReason: "end_turn" }]);
    await runWith({ runId: "s598-c3-d", provider: providerD, cwd, continuity: { handoff: "prompt" } });
    const partialBlock = blockTextOfRequest(providerD.requests[0]);
    assert.ok(partialBlock.includes("## unfinished\n- unknown"), `缺失必须可见，实测：\n${partialBlock}`);
    assert.ok(partialBlock.includes("## evidence\n- unknown"), `缺失必须可见，实测：\n${partialBlock}`);
  });
});

test("判据 3b（变异 1 的 run 级夹具）：散文里写 contract: 但没 marker ⇒ 三段全是 unknown", async () => {
  const cwd = await makeTmp("erix598-c3b-cwd");
  const dir = path.join(await makeTmp("erix598-c3b-store"), "continuity");
  await withContinuityDir(dir, async () => {
    const provider = createFakeProvider([{
      content: [{
        type: "text",
        text: "总结：contract: 这只是一句散文；unfinished: 也是散文；evidence: 还是散文。没有 marker。",
      }],
      stopReason: "end_turn",
    }]);
    await runWith({ runId: "s598-c3b", provider, cwd, continuity: { handoff: "prompt" } });
    const record = await readRecordFor(dir, cwd);
    assert.ok(record !== undefined);
    for (const name of CONTINUITY_SECTION_NAMES) {
      assert.equal(record.sections[name], HANDOFF_UNKNOWN, `${name}：散文不许被当成交接段`);
    }
  });
});

// ================================================================ 判据 4

test("判据 4：引擎只搬运不背书——`evidence: 已验证` 原样进 store 与块，且不升级 verification", async () => {
  const cwd = await makeTmp("erix598-c4-cwd");
  const dir = path.join(await makeTmp("erix598-c4-store"), "continuity");
  await withContinuityDir(dir, async () => {
    // 这次 run **一个工具都没调**（根本没跑测试），模型却自称「已验证」。
    const providerA = createFakeProvider([{
      content: [{
        type: "text",
        text: handoffAnswer({
          contract: "目标：只搬运",
          unfinished: "unknown",
          evidence: "已验证：全量 npm test 0 fail",
        }),
      }],
      stopReason: "end_turn",
    }]);
    const runA = await runWith({
      runId: "s598-c4-a", provider: providerA, cwd, continuity: { handoff: "prompt" },
    });
    assert.equal(runA.termination.reason, "end_turn");

    const record = await readRecordFor(dir, cwd);
    assert.equal(record?.sections.evidence, "已验证：全量 npm test 0 fail", "store 里必须原样是「已验证」");

    const providerB = createFakeProvider([{ content: [{ type: "text", text: "收到" }], stopReason: "end_turn" }]);
    const runB = await runWith({
      runId: "s598-c4-b", provider: providerB, cwd, continuity: { handoff: "prompt" },
    });
    const block = blockTextOfRequest(providerB.requests[0]);
    assert.ok(block.includes("- 已验证：全量 npm test 0 fail"), "块里必须原样是「已验证」（引擎不改写）");

    // 两套东西不许混：引擎的 `verification` 不是模型的自述。
    assert.notEqual(runB.verification?.status, "verified", "模型自称「已验证」不许升级成引擎的 verification");
    assert.equal(
      JSON.stringify(runB.verification ?? {}).includes("全量 npm test"),
      false,
      "verification 里不许出现 <handoff> 的自述正文",
    );
    assert.equal(runB.verification?.status, runA.verification?.status, "写者不改 verification 的取值");
  });
});

// ================================================================ 判据 5

test("判据 5：兜底次数——`prompt-and-fallback` 恰好 1 次补调用，`prompt` 0 次", async () => {
  const cwd = await makeTmp("erix598-c5-cwd");
  const dir = path.join(await makeTmp("erix598-c5-store"), "continuity");
  await withContinuityDir(dir, async () => {
    // prompt：模型不写 ⇒ 只有主循环那一发，零补调用。
    const promptProvider = createFakeProvider([{ content: [{ type: "text", text: "没有交接" }], stopReason: "end_turn" }]);
    await runWith({ runId: "s598-c5-prompt", provider: promptProvider, cwd, continuity: { handoff: "prompt" } });
    assert.equal(promptProvider.requests.length, 1, "`prompt` 下模型不写 ⇒ 0 次补调用");

    // prompt-and-fallback：模型不写 ⇒ 主循环一发 + 补调用一发。
    const fallbackProvider = createFakeProvider([
      { content: [{ type: "text", text: "没有交接" }], stopReason: "end_turn" },
      { content: [{ type: "text", text: handoffAnswer({ contract: "兜底拿到的契约", unfinished: "unknown", evidence: "unknown" }) }], stopReason: "end_turn" },
    ]);
    const run = await runWith({
      runId: "s598-c5-fallback", provider: fallbackProvider, cwd, continuity: { handoff: "prompt-and-fallback" },
    });
    assert.equal(run.termination.reason, "end_turn", "兜底成功也要正常收尾");
    assert.equal(fallbackProvider.requests.length, 2, "`prompt-and-fallback` 下模型不写 ⇒ **恰好 1 次**补调用");

    const fallbackRequest = fallbackProvider.requests[1];
    assert.equal(fallbackRequest.messages.length, 1, "补调用的输入有界：只有一条消息（不重发历史）");
    assert.deepEqual(fallbackRequest.tools, [], "补调用不许带工具（开不出新轮）");
    const fallbackText = textOf(fallbackRequest.messages[0]);
    assert.ok(fallbackText.includes(HANDOFF_FALLBACK_INSTRUCTION), "补调用必须只要求输出 <handoff>");
    assert.ok(fallbackText.length < 4000, `补调用输入必须有界，实测 ${fallbackText.length} 字符`);

    const record = await readRecordFor(dir, cwd);
    assert.equal(record?.source, "fallback", "来源记为兜底（不是 model）");
    assert.equal(record?.sections.contract, "兜底拿到的契约");
    assert.equal(record?.sections.unfinished, HANDOFF_UNKNOWN);

    // 模型自己写了 ⇒ 一次补调用都不该发生。
    const selfWritten = createFakeProvider([{
      content: [{ type: "text", text: handoffAnswer({ contract: "自己写的" }) }],
      stopReason: "end_turn",
    }]);
    await runWith({
      runId: "s598-c5-self", provider: selfWritten, cwd, continuity: { handoff: "prompt-and-fallback" },
    });
    assert.equal(selfWritten.requests.length, 1, "模型写了就不补调用");
  });
});

test("判据 5b：兜底失败 / 抛错 ⇒ 落 unknown，run 不失败", async () => {
  const cwd = await makeTmp("erix598-c5b-cwd");
  const dir = path.join(await makeTmp("erix598-c5b-store"), "continuity");
  await withContinuityDir(dir, async () => {
    const provider = createFakeProvider([
      { content: [{ type: "text", text: "没有交接" }], stopReason: "end_turn" },
      { throw: new Error("兜底调用炸了") },
    ]);
    const events = [];
    const run = await runWith({
      runId: "s598-c5b", provider, cwd, continuity: { handoff: "prompt-and-fallback" }, events,
    });
    assert.equal(run.termination.reason, "end_turn", "兜底失败不许让 run 失败");
    const record = await readRecordFor(dir, cwd);
    for (const name of CONTINUITY_SECTION_NAMES) {
      assert.equal(record?.sections[name], HANDOFF_UNKNOWN, `${name} 必须是 unknown`);
    }
    assert.equal(
      events.some((event) => event.type === "continuity_write_failed" && event.phase === "fallback"),
      true,
      "兜底失败必须上报（不许静默）",
    );
  });
});

test("判据 2b：宿主显式给 `continuityProvider` ⇒ override 生效（默认写者让位），写仍按开关跑", async () => {
  const cwd = await makeTmp("erix598-c2b-cwd");
  const dir = path.join(await makeTmp("erix598-c2b-store"), "continuity");
  await withContinuityDir(dir, async () => {
    // 先让默认写者落一份记录（run A）。
    const providerA = createFakeProvider([{
      content: [{ type: "text", text: handoffAnswer({ contract: "默认写者写的契约" }) }],
      stopReason: "end_turn",
    }]);
    await runWith({ runId: "s598-c2b-a", provider: providerA, cwd, continuity: { handoff: "prompt" } });

    // run B 同时有 override：块里必须是 override 的内容（默认写者的召回让位）。
    const providerB = createFakeProvider([{ content: [{ type: "text", text: "收到" }], stopReason: "end_turn" }]);
    await runWith({
      runId: "s598-c2b-b",
      provider: providerB,
      cwd,
      continuity: { handoff: "prompt" },
      continuityProvider: async () => ({ version: 9, text: "[contract]\n宿主 override 的契约" }),
    });
    const block = blockTextOfRequest(providerB.requests[0]);
    assert.ok(block.includes("- 宿主 override 的契约"), `override 必须赢，实测：\n${block}`);
    assert.equal(block.includes("默认写者写的契约"), false, "默认写者的召回必须让位给 override");

    // 但「写」仍按开关跑：run B 的模型没写 ⇒ 记录被覆盖成 unknown（来源不是 model）。
    const record = await readRecordFor(dir, cwd);
    assert.equal(record?.source, HANDOFF_UNKNOWN, "override 只接管「召回」，不接管「写」");
  });
});

test("判据 6-c（`off` 的夹具）：`off` 下 store 有记录也**不召回**、不注入指令", async () => {
  const cwd = await makeTmp("erix598-off-cwd");
  const dir = path.join(await makeTmp("erix598-off-store"), "continuity");
  await withContinuityDir(dir, async () => {
    const store = createFileContinuityStore({ dir, cwd });
    await store.write({ source: "model", sections: { contract: "上一份契约", unfinished: "u", evidence: "e" } });

    const provider = createFakeProvider([{ content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" }]);
    await runWith({ runId: "s598-off", provider, cwd, continuity: { handoff: "off" } });
    assert.equal(blockTextOfRequest(provider.requests[0]), undefined, "`off` 时不许召回（store 里有记录也不读）");
    assert.equal(JSON.stringify(provider.requests).includes("<handoff>"), false, "`off` 时不许注入指令");
    assert.deepEqual(
      conversationOf(provider.requests[0]).map(textOf),
      ["开始任务"],
      "除 run-state 块之外不该多出任何引擎消息（种子消息一个字节都不动）",
    );
    // 上一份记录不许被 `off` 的 run 覆盖（`off` 连写都不写）。
    assert.equal((await store.read())?.sections.contract, "上一份契约");
  });
});

test("判据 6-a（`prompt` 的读回）：注入指令只在请求视图里，不进 messages / transcript", async () => {
  const cwd = await makeTmp("erix598-inst-cwd");
  const dir = path.join(await makeTmp("erix598-inst-store"), "continuity");
  await withContinuityDir(dir, async () => {
    const provider = createFakeProvider([{
      content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "hi" } }],
      stopReason: "tool_use",
    }, {
      content: [{ type: "text", text: handoffAnswer() }],
      stopReason: "end_turn",
    }]);
    const run = await runWith({ runId: "s598-inst", provider, cwd, continuity: { handoff: "prompt" } });
    assert.equal(run.termination.reason, "end_turn");
    assert.equal(provider.requests.length, 2, "前提：两轮");
    for (const request of provider.requests) {
      assert.equal(textOf(request.messages.at(-1)), HANDOFF_INSTRUCTION, "每一发请求的尾部都有指令");
    }
    assert.equal(
      run.messages.some((message) => textOf(message).includes(HANDOFF_INSTRUCTION)),
      false,
      "指令只活在请求视图里：`messages` / transcript 里不许有它（否则每轮长一条）",
    );
    assert.equal(isContinuityMessage(run.messages.at(-1)) === false, true, "块与本单无关时不注入");
    // 文件真的落在注入的目录里（不是真实 ~/.erix）。
    const entries = await readdir(dir);
    assert.deepEqual(entries, [`${continuityProjectKey(cwd)}.json`]);
    const raw = JSON.parse(await readFile(path.join(dir, entries[0]), "utf8"));
    assert.equal(raw.projectKey, continuityProjectKey(cwd));
    assert.equal(raw.cwd, cwd);
    assert.equal(raw.sections.evidence, "已验证：判据 1–5");
  });
});

// ================================================================ 默认值守护（issue #618）

// 双层：名字级（常量逐字相等 ⇒ 改这个字面量就红）+ 行为级（默认档位确实「不注入、不读不写」）。
// 落点选本文件：默认档位 = 零行为变更的夹具（runWith / withContinuityDir / 判据 1 的对拍形状）都在这里。
test("默认值守护：CONTINUITY_WRITE_DEFAULT 逐字 \"off\"，且默认档位下请求尾部不注入 handoff 指令", async () => {
  assert.equal(CONTINUITY_WRITE_DEFAULT, "off", "续接块默认写者档位（改这个字面量就该有题红）");
  assert.equal(CONTINUITY_WRITE_MODES[0], CONTINUITY_WRITE_DEFAULT, "三档里的第一个就是默认值（同一份真相）");
  // 读侧默认必须逐字等于这个常量：常量与运行时默认不许漂（否则「文档说 off、跑起来是 prompt」）。
  assert.equal(normalizeContinuityWriteMode(undefined), CONTINUITY_WRITE_DEFAULT);

  const cwd = await makeTmp("erix598-default-cwd");
  const dir = path.join(await makeTmp("erix598-default-store"), "continuity");
  await withContinuityDir(dir, async () => {
    // 一个字节都不写 `config.continuity` ⇒ 走默认档位。
    const byDefault = createFakeProvider([{ content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" }]);
    await runWith({ runId: "s598-default", provider: byDefault, cwd });
    assert.equal(JSON.stringify(byDefault.requests).includes(HANDOFF_INSTRUCTION), false, "默认档位 ⇒ 不注入指令");
    assert.equal(JSON.stringify(byDefault.requests).includes(HANDOFF_MARKER_START), false, "默认档位 ⇒ 请求里连 marker 都没有");
    await assert.rejects(() => stat(dir), (error) => error?.code === "ENOENT", "默认档位 ⇒ 连 store 目录都不该被创建");

    // 对照：同一份夹具，只把这个开关拨到 `prompt` ⇒ 指令逐字出现在请求尾部。
    const turnedOn = createFakeProvider([{ content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" }]);
    await runWith({ runId: "s598-default", provider: turnedOn, cwd, continuity: { handoff: "prompt" } });
    assert.equal(textOf(turnedOn.requests[0].messages.at(-1)), HANDOFF_INSTRUCTION, "拨到 prompt ⇒ 注入");
  });
});
