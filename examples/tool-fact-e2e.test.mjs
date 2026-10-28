// 真上游 e2e：工具事实契约面（#284 / #285）—— 工单 docs/tasks/261015-e2e-harness.md 第 2 项（T5）。
//
// 来历：#284/#285 两刀的验收此前**全打在 createFakeProvider 上**。主 agent 后来手做了真机 e2e
// （`/tmp/e2e-tool-fact/e2e.mjs` + `recheck.mjs` + `e2e-b.mjs`，25 条断言全绿），但脚本在 /tmp、
// 一次性的。本文件把那批断言**原样搬进仓库**（含它踩过的坑），使其成为可重复的门禁。
//
// 用法：ERIX_E2E_REAL=1 node --test examples/tool-fact-e2e.test.mjs
// 闸门 / 配置解析 / 模型名来源共用 examples/e2e-real-gate.mjs：
//   `ERIX_E2E_REAL=1` 才跑；缺省 skip，且 **gate 缺失 / 配置不存在 / JSON 坏了 / 缺字段 /
//   凭据引用解不出值（变量未设·文件不存在·值为空）/ 端点不可达** 分别报（不许一律「skipped」）；模型从 `slots.default` 解析
//   （`ERIX_E2E_CONFIG=<path>` 可覆盖路径），源码里不出现任何模型名。
// 不污染真实 ~/.erix：store 一律 `mkdtemp`，工作目录也是 `mkdtemp`。
// 零依赖红线：只用 node: 内置 + 相对路径；纯 ESM。
//
// ---------------------------------------------------------------------------
// 两条已踩过的坑（工单原文；本文件的断言全部照做，主 agent 各假红过一次）：
// ① **断言查块本体，不要在整段 JSON 上找子串**：模型的 `reasoning`/`text` 会复述工具内容
//    （`erix` / `metadata` / `duration` 这些词都可能出现在正文里）。→ 本文件一律先按 content 数组
//      取出 `type === "tool_result"` 的块，再在**块对象**上按键判定；「erix/metadata 不上 wire」
//      也是遍历 wire 的**键集合**，不是拿整段 JSON 找 `"erix"` 子串。
// ② **`RoundRecord.messages` 只存本轮新增消息**（设计如此，不是缺陷）：要折叠/回放下文必须自己
//    按轮拼完整历史。→ 需要完整历史处（TTL 折叠、投影）一律走 `collapseHistory()`；
//      把最后一条 RoundRecord 当成全量历史去折叠，就会得到「foldedCount=0」这种假红。
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  canonicalToOpenAIMessages,
  createFileTranscriptStore,
  createOpenAIProvider,
  projectTranscriptForDisplay,
  runToolLoop,
  TOOL_RESULT_CONTRACT,
} from "../src/index.js";
import { foldToolResultsForRequest } from "../src/loop/tool-result-ttl.js";
import { formatSkip, printableEndpoint, resolveRealUpstream, TMP_PREFIX } from "./e2e-real-gate.mjs";

/** 退役名（TOOL_RESULT_CONTRACT.legacy.aliases 的键，去掉宿主摊平那条描述性键）。 */
const RETIRED = Object.keys(TOOL_RESULT_CONTRACT.legacy.aliases)
  .filter((name) => !name.includes("@"));
/** 本用例自造的宿主扩展键（必须只住在 metadata.*）。 */
const HOST_KEYS = ["artifactStatus", "readBytes"];

/** 落盘 tool_result 允许的顶层键集合：**由契约常量派生**，不在这里手抄一份 */
const ALLOWED_TOP_LEVEL = new Set([
  ...TOOL_RESULT_CONTRACT.protocol.required,
  TOOL_RESULT_CONTRACT.engine.ns,
  TOOL_RESULT_CONTRACT.host.ns,
  ...(TOOL_RESULT_CONTRACT.protocol.conditional?.is_error !== undefined ? ["is_error"] : []),
]);

/** 坑 ①：只从消息数组里取内容块，断言一律打在块本体上 */
function blocksOf(messages, type) {
  return (messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === type);
}

/** 坑 ②：各 RoundRecord 只存本轮新增消息，按轮拼回完整历史（同引用去重，不复制语义） */
function collapseHistory(records) {
  const seen = new Set();
  const history = [];
  for (const record of [...records].sort((a, b) => (a?.round ?? 0) - (b?.round ?? 0))) {
    for (const message of record?.messages ?? []) {
      const fingerprint = JSON.stringify(message)?.slice(0, 400);
      if (fingerprint === undefined || seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      history.push(message);
    }
  }
  return history;
}

/** 遍历 wire 的**键集合**（不是子串）：`erix`/`metadata` 作为键出现才算上了线 */
function collectKeys(value, acc = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      acc.add(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

/** 项目素材：两次工具调用都要真有活干（一个命中、一个纯文本返回） */
async function makeProject(dir) {
  await writeFile(join(dir, "a.txt"), "第一行 needle 在这里\n第二行 没有\n第三行 又有一个 needle\n", "utf8");
  await writeFile(join(dir, "b.txt"), "b 文件里的 needle 只有一处\n", "utf8");
}

const TOOLS = [
  {
    name: "readFile",
    description: "读取项目内文本文件",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "searchText",
    description: "在项目内文件里搜索字面量，返回命中行",
    inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  },
];

/**
 * 宿主执行器：readFile 走**结构化返回**（{content, metadata} → 宿主键必须落 metadata.*），
 * searchText 走**纯文本返回**（工单第 2 项第 5 条：这种结果的 `metadata` 允许缺席，
 * 构造器刻意不写空对象——不许把它断言成缺陷）。
 */
function makeExecutor(dir) {
  return async ({ name, input }) => {
    if (name === "readFile") {
      const text = await readFile(join(dir, String(input?.path ?? "").replace(/^\.?\//u, "")), "utf8");
      return { content: text, metadata: { artifactStatus: "ok", readBytes: text.length } };
    }
    if (name === "searchText") {
      const pattern = String(input?.pattern ?? "");
      const hits = [];
      for (const file of ["a.txt", "b.txt"]) {
        const text = await readFile(join(dir, file), "utf8");
        text.split("\n").forEach((line, index) => {
          if (line.includes(pattern)) hits.push(`${file}:${index + 1}:${line.trim()}`);
        });
      }
      return `命中 ${hits.length} 次\n${hits.join("\n")}`;
    }
    return "unknown tool";
  };
}

test("断言集自身的不变量：允许键集合与退役名单没被偷偷改弱（始终跑，不联网）", () => {
  // 这两张表是上面一堆断言的地基：它们被改小而下面的断言不会自己喊红，所以在这里钉住。
  assert.deepEqual([...ALLOWED_TOP_LEVEL].sort(),
    ["content", "erix", "is_error", "metadata", "tool_use_id", "type"],
    `落盘 tool_result 的合法顶层键集合应是 6 个，实际 ${ALLOWED_TOP_LEVEL.size} 个`);
  assert.deepEqual([...RETIRED].sort(),
    ["duration", "erixRound", "executionStatus", "success"],
    `退役名单应与 TOOL_RESULT_CONTRACT.legacy.aliases 一致，实际 ${RETIRED.join(",")}`);
});

test("真上游 e2e：工具事实契约面（两线同键 / 字段面 / wire / 投影 / 一代读窗口）", {
  timeout: 12 * 60 * 1000,
}, async (t) => {
  const gate = await resolveRealUpstream({ probeTimeoutMs: 8_000 });
  if (!gate.ok) {
    t.skip(`真上游不可用/闸门关：${formatSkip(gate)}`);
    return;
  }
  const providerFields = {
    // 闸门已把 `endpoint`/`baseUrl` 归一（gate.endpoint）、把凭据引用解成**实际值**（gate.apiKey）：
    // 传给 createOpenAIProvider 的必须是解析后的真实值，不是变量名/文件路径（PR #289 阻断 1 的配套：
    // src/providers/openai.js 只认 apiKey，传引用名就是起跑即报 apiKey 必填）。
    endpoint: gate.endpoint,
    apiKey: gate.apiKey,
    model: gate.slot.model,
    contextWindowTokens: gate.slot.contextWindowTokens,
    maxOutputTokens: gate.slot.maxOutputTokens,
  };
  assert.ok(
    typeof providerFields.apiKey === "string" && providerFields.apiKey.trim() !== "",
    "闸门 ok 就等于凭据**真实值**在场（引用名不算）：这里拿到空值就是闸门退弱了",
  );
  console.log(`[2] model=${gate.model} endpoint=${printableEndpoint(gate.endpoint)} config=${gate.configPath}`);

  /** 逐条 PASS/FAIL 打点：报告要贴的就是这张表，一条红不掩盖其余结果 */
  const failures = [];
  const check = (id, fn, detail = "") => {
    try {
      fn();
      console.log(`PASS [2] ${id}${detail ? `  — ${detail}` : ""}`);
    } catch (error) {
      failures.push(id);
      console.log(`FAIL [2] ${id}  — ${String(error?.message ?? error).split("\n")[0]}`
        + (detail ? ` ｜ 现场：${detail}` : ""));
    }
  };

  const root = await mkdtemp(join(tmpdir(), TMP_PREFIX.toolFact));
  try {
    // =============== 场景 A：真上游 + 真执行 + 流式 ===============
    const dirA = join(root, "proj-a");
    await mkdir(dirA, { recursive: true });
    await makeProject(dirA);
    const storeA = createFileTranscriptStore({ dir: join(root, "store-a") });
    const events = [];
    const fragments = [];
    const outA = await runToolLoop({
      provider: createOpenAIProvider(providerFields),
      // #498 S3 A2b: the seed's canonical home is `config.input.initialUserMessage`.
      // #498 S3 A16: `stream` lost its flat spelling too — canonical home `config.run.stream`
      // (the expansion phase writes it back to `effectiveOptions.stream`).
      config: {
        input: { initialUserMessage: "先用 readFile 读 a.txt；再用 searchText 搜 needle；最后一句话回答命中几次。" },
        run: { stream: true },
      },
      task: "读 a.txt 并搜索 needle",
      tools: TOOLS,
      executeTool: makeExecutor(dirA),
      store: storeA,
      runId: "e2e-a",
      maxRounds: 6,
      onEvent: (event) => events.push(event),
      onToolCall: (fragment) => fragments.push(fragment),
    });
    const recordsA = await storeA.load("e2e-a");
    const historyA = collapseHistory(recordsA);
    const evResults = events.filter((e) => e.type === "tool_result").map((e) => e.toolResult);
    const persistedA = blocksOf(historyA, "tool_result");
    const persistedUsesA = blocksOf(historyA, "tool_use");

    check("A0 run 正常收尾（end_turn，不是错误/轮数耗尽）", () => {
      assert.equal(outA?.termination?.reason, "end_turn", JSON.stringify(outA?.termination));
    }, `↑${outA?.usage?.input_tokens}/↓${outA?.usage?.output_tokens} rounds=${outA?.rounds}`);

    check("A1 真的执行了 ≥2 次工具（落盘 tool_result ≥2）", () => {
      assert.ok(persistedA.length >= 2, `落盘 tool_result=${persistedA.length}`);
    }, `tool_result=${persistedA.length}，tool_use=${persistedUsesA.length}，流式分片=${fragments.length}`);

    // 第 1 条：两线同键（引擎的核心承诺）+ **双向数量/id 集合对账**（PR #289 断言强度 1）。
    // 修前只要求事件流「至少一条」再逐个查 key ⇒「落盘 2 条、事件只发 1 条」（漏发）与
    // 「同一次调用发两条结果」（重发）都照样绿。这里把⊇与⊆钉在一起：同数量、同 id 集合、两边都不重号。
    const keyByToolUseId = new Map();
    for (const block of persistedA) {
      if (typeof block?.erix?.toolCallKey === "string") keyByToolUseId.set(block.tool_use_id, block.erix.toolCallKey);
    }
    /** 事件侧 / 落盘侧的 tool_use_id（落盘侧 = 真的执行过并落盘的调用，本场景是新 run，全是现役形状） */
    const evIds = evResults.map((block) => block?.tool_use_id);
    const persistedIds = persistedA.map((block) => block?.tool_use_id);
    const duplicates = (ids) => [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    check("F1 两线同键 + 双向对账：事件侧与落盘侧同数量、同 tool_use_id 集合、不重号，key 逐条相等", () => {
      assert.ok(evResults.length > 0, "事件流里一个 tool_result 也没有");
      // ⊇：落盘执行过的每一次调用，事件流必须都发过结果；⊆：事件流不许发落盘没有的结果。
      assert.equal(evIds.length, persistedIds.length,
        `数量不等（事件侧⊇落盘侧、又⊆落盘侧 ⇔ 同数量）：事件=${evIds.length} 落盘=${persistedIds.length}`);
      assert.deepEqual(duplicates(evIds), [], `事件侧同一次调用发了多条结果（重发）：${duplicates(evIds).join(",")}`);
      assert.deepEqual(duplicates(persistedIds), [], `落盘侧同一次调用落了多条结果：${duplicates(persistedIds).join(",")}`);
      assert.deepEqual([...new Set(evIds)].sort(), [...new Set(persistedIds)].sort(),
        `tool_use_id 集合不双向相等：只在事件侧=${evIds.filter((id) => !persistedIds.includes(id)).join(",") || "无"}`
        + `｜只在落盘侧=${persistedIds.filter((id) => !evIds.includes(id)).join(",") || "无"}`);
      const problems = [];
      for (const block of evResults) {
        const key = block?.erix?.toolCallKey;
        if (typeof key !== "string" || !key.startsWith("tc_")) {
          problems.push(`事件侧缺 key：${block?.tool_use_id}`);
          continue;
        }
        if (keyByToolUseId.get(block.tool_use_id) !== key) {
          problems.push(`${block.tool_use_id}: 事件=${key} 落盘=${keyByToolUseId.get(block.tool_use_id)}`);
        }
      }
      // 反方向：落盘每一块的身份键也必须真的等于事件侧发过的那一份（上面只遍历事件侧，漏发时查不到）。
      for (const block of persistedA) {
        const onEvent = evResults.find((e) => e?.tool_use_id === block?.tool_use_id)?.erix?.toolCallKey;
        if (onEvent !== block?.erix?.toolCallKey) {
          problems.push(`${block?.tool_use_id}: 落盘=${block?.erix?.toolCallKey} 事件=${onEvent}`);
        }
      }
      assert.deepEqual(problems, [], problems.join(" | "));
    }, `事件=${evIds.length} 落盘=${persistedIds.length}，` 
      + `块侧 key 集合=${new Set(keyByToolUseId.values()).size}`);

    // 第 2 条：流式分片上的身份键（只有真上游能覆盖这条分支——假 provider 不给分片）
    check("F2 流式 tool_call 分片带 toolCallKey，且每个值都在块侧 key 集合里", () => {
      assert.ok(fragments.length > 0, `onToolCall 一个分片也没收到（stream=true 未生效？）`);
      const keys = fragments.map((f) => f?.toolCallKey);
      assert.ok(keys.every((k) => typeof k === "string" && k.startsWith("tc_")),
        `分片 key 缺失/前缀不对：${JSON.stringify(keys)}`);
      const blockKeys = new Set(keyByToolUseId.values());
      assert.ok(keys.every((k) => blockKeys.has(k)),
        `分片里有块侧不存在的 key：${keys.filter((k) => !blockKeys.has(k)).join(",")}`);
    }, `分片=${fragments.length}，带 key=${fragments.filter((f) => f?.toolCallKey).length}`);

    // 第 3 条：顶层键集合（T2 停写的核心断言）
    check("F3 落盘块顶层键集合 ⊆ 契约集合，退役名与宿主摊平键都不在顶层", () => {
      const problems = [];
      for (const block of persistedA) {
        for (const key of Object.keys(block)) {
          if (!ALLOWED_TOP_LEVEL.has(key)) problems.push(`${block.tool_use_id}:${key}`);
        }
      }
      assert.deepEqual(problems, [], `多出来的顶层键：${problems.join(",")}`);
    }, `允许集合=[${[...ALLOWED_TOP_LEVEL].sort().join(",")}]，退役名单=[${RETIRED.join(",")}]`);
    check("F3b 四个退役名逐个确认不在顶层（顶层键集合断言的点名字版本）", () => {
      const hits = [];
      for (const block of persistedA) {
        for (const name of RETIRED) if (Object.hasOwn(block, name)) hits.push(`${block.tool_use_id}:${name}`);
        for (const name of HOST_KEYS) if (Object.hasOwn(block, name)) hits.push(`${block.tool_use_id}:${name}(宿主摊平)`);
      }
      assert.deepEqual(hits, [], hits.join(","));
    });

    // 第 4 条：erix 事实面
    const durationsA = persistedA.map((b) => b?.erix?.durationMs);
    check("F4 erix 五件套：tc_ 前缀 / round 有限 / durationMs 有限且 ≥0 且至少一个 >0 / success 布尔", () => {
      for (const block of persistedA) {
        const erix = block?.erix;
        assert.equal(typeof erix?.toolCallKey, "string", `${block?.tool_use_id} 缺 toolCallKey`);
        assert.ok(erix.toolCallKey.startsWith("tc_"), `前缀不对：${erix.toolCallKey}`);
        assert.ok(Number.isFinite(erix.round), `erix.round 非有限：${erix.round}`);
        assert.ok(Number.isFinite(erix.durationMs) && erix.durationMs >= 0,
          `durationMs 非有限/为负：${erix.durationMs}`);
        assert.equal(typeof erix.success, "boolean", `success 非布尔：${erix.success}`);
        if (erix.executionStatus !== undefined) {
          assert.ok(["ok", "error", "interrupted", "intercepted"].includes(erix.executionStatus),
            `executionStatus 取值意外：${erix.executionStatus}`);
        }
      }
      assert.ok(durationsA.some((d) => d > 0),
        `真执行必须至少有一个非 0 耗时（全 0 = 没真跑或耗时没捕获）：${JSON.stringify(durationsA)}`);
    }, JSON.stringify(durationsA));

    // 第 5 条：纯文本返回时 metadata 允许缺席（构造器刻意不写空对象）
    const structured = persistedA.filter((b) => b?.metadata !== undefined);
    const plainText = persistedA.filter((b) => b?.metadata === undefined);
    check("F5 executor 返回纯文本时 metadata 可以缺席（不是缺陷）", () => {
      assert.ok(plainText.length >= 1,
        `本次没有纯文本返回的工具结果，判据落空（searchText 该返回纯文本）：${JSON.stringify(persistedA.map((b) => Object.keys(b)))}`);
      assert.ok(structured.length >= 1, "readFile 的结构化返回应产生 metadata.*");
      for (const block of plainText) {
        assert.equal(block[TOOL_RESULT_CONTRACT.host.ns], undefined);
        assert.ok(String(block?.content ?? "").length > 0, "纯文本结果本身必须有内容");
      }
    }, `metadata 在场=${structured.length}，缺席=${plainText.length}`);

    // 第 6 条：宿主扩展键只在 metadata.*
    check("F6 宿主扩展键只在 metadata.*（readFile 那次结构化返回）", () => {
      const host = persistedA.find((b) => b?.metadata?.artifactStatus === "ok");
      assert.ok(host, "readFile 的 metadata.artifactStatus 没落到块上");
      assert.equal(typeof host.metadata.readBytes, "number", "readBytes 应是数字");
      for (const block of persistedA) {
        if (block?.metadata === undefined) continue;
        assert.ok(!Object.hasOwn(block.metadata, TOOL_RESULT_CONTRACT.engine.ns),
          "metadata 里不得混进引擎命名空间");
        assert.ok(!Object.hasOwn(block.metadata, "toolCallKey"), "metadata 里不得混进引擎身份键");
      }
    }, JSON.stringify(structured.map((b) => b.metadata)));

    // 第 7 条：erix / metadata 不上出站 wire（遍历键集合，不找子串——见坑 ①）
    const wireA = canonicalToOpenAIMessages("", historyA.filter((m) => m?.role !== "system"));
    const wireKeys = collectKeys(wireA);
    check("F7 erix/metadata 不出现在 canonicalToOpenAIMessages 的 wire 键集合里", () => {
      assert.ok(Array.isArray(wireA) && wireA.length > 0, "wire 不能是空的（否则这条判据是假的）");
      assert.ok(!wireKeys.has(TOOL_RESULT_CONTRACT.engine.ns),
        `wire 键集合里出现了 ${TOOL_RESULT_CONTRACT.engine.ns}`);
      assert.ok(!wireKeys.has(TOOL_RESULT_CONTRACT.host.ns),
        `wire 键集合里出现了 ${TOOL_RESULT_CONTRACT.host.ns}`);
      // 反面自证：wire 里真的带了工具结果（否则「没有 erix」只是因为根本没有内容）
      assert.ok(JSON.stringify(wireA).includes(String(persistedA[0]?.content ?? "#").slice(0, 20))
        || wireA.some((m) => m?.role === "tool"),
      `wire 里应当有工具结果内容，实际角色：${wireA.map((m) => m?.role).join(",")}`);
    }, `wire 消息=${wireA.length} 条，键集合大小=${wireKeys.size}`);

    // 第 8 条：投影（宿主 UI 的镜像）
    const cardsA = projectTranscriptForDisplay(recordsA);
    const callsA = cardsA.flatMap((card) => card?.toolCalls ?? []);
    check("F8 投影 toolCalls[] 每条带 toolCallKey，durationMs 只透真实值（缺失不写成 0）", () => {
      assert.ok(callsA.length >= 2, `投影卡片里的工具条目=${callsA.length}`);
      assert.ok(callsA.every((c) => typeof c.toolCallKey === "string" && c.toolCallKey.startsWith("tc_")),
        JSON.stringify(callsA.map((c) => c.toolCallKey)));
      assert.ok(callsA.every((c) => c.durationMs === undefined
        || (Number.isFinite(c.durationMs) && c.durationMs >= 0)),
        JSON.stringify(callsA.map((c) => c.durationMs)));
      assert.ok(callsA.some((c) => typeof c.durationMs === "number" && c.durationMs > 0),
        "至少一条带真实非 0 耗时（否则 durationMs 这条线是死的）");
      const keysOnCards = new Set(callsA.map((c) => c.toolCallKey));
      assert.deepEqual([...keysOnCards].sort(), [...keyByToolUseId.values()].sort(),
        "投影的 key 集合应与落盘块的 key 集合一致（一一对应，不重号不丢号）");
    }, JSON.stringify(callsA.map((c) => ({ k: c.toolCallKey, d: c.durationMs, n: c.name }))));

    // 附加（/tmp recheck A11′）：TTL 折叠在真落盘记录上真的生效（读 erix.round 的路径活着）
    check("A11 TTL 折叠按 erix.round 在真记录上生效（完整历史按轮拼，坑 ②）", () => {
      const stats = {};
      const folded = foldToolResultsForRequest(historyA, { currentRound: 99, ttl: 2, minTokens: 1, stats });
      assert.ok((stats.foldedCount ?? 0) > 0, `foldedCount=${stats.foldedCount}`);
      assert.notDeepEqual(folded, historyA, "折叠后视图应与原视图不同");
    }, "currentRound=99, ttl=2, minTokens=1");

    // =============== 场景 C：升级前（0.19 形状）检查点复放 = 一代读窗口 ===============
    const dirC = join(root, "proj-c");
    await mkdir(dirC, { recursive: true });
    await makeProject(dirC);
    const storeC = createFileTranscriptStore({ dir: join(root, "store-c") });
    // 探针：resume 期间引擎每写一次 run snapshot 就留一份副本。快照的 `messages` 是
    // `cloneState(messages)`——即**引擎内存里那份上下文**的逐字快照 ⇒ 拿它判「引擎有没有在内存里
    // 给宿主传进来的旧块补 `erix`」。光看 `store.load()` 不够：那是磁盘，就地改内存对象而不再落盘
    // 的坏法不会在磁盘上留下痕迹（本单要防的 (a) 正是那一种）。
    const snapshotPayloads = [];
    const storeCProbed = {
      ...storeC,
      async saveRunSnapshot(runId, snapshot) {
        snapshotPayloads.push(snapshot);
        return storeC.saveRunSnapshot(runId, snapshot);
      },
    };
    const runIdC = "e2e-c";
    const legacyBlock = {
      type: "tool_result",
      tool_use_id: "legacy-1",
      content: "旧版本落盘的读取结果（needle 在旧结果里）",
      erixRound: 0,
      duration: 1234,
      success: true,
      executionStatus: "ok",
      artifactStatus: "ok",
    };
    const legacyRoundMessages = [
      { role: "user", content: "旧会话" },
      { role: "assistant", content: [{ type: "tool_use", id: "legacy-1", name: "readFile", input: { path: "a.txt" } }] },
      { role: "user", content: [legacyBlock] },
      { role: "assistant", content: [{ type: "text", text: "旧版本：已读完 a.txt。" }] },
    ];
    await storeC.appendRound(runIdC, { round: 0, messages: [{ role: "user", content: "旧会话" }] });
    // 工单 261021（存储收敛）之后的形状：**旧正文也必须在账本里**。
    // 为什么本条以前把正文只放在快照里、现在不行（旧断言不是被放宽，而是取值来源过期）：
    // 改造前 resume 会把「快照里账本没有的那段正文」抄进 `…:resume` 轮行
    // （`resumeRunSnapshotMessages` + `messages.slice(resumeTranscriptStart)`），于是只写在快照里的旧块
    // 会经那条轮行落进 `load()`；改造后 `…:resume` 只带锚点之后新产生的引擎控制正文，恢复的正文
    // **只认账本**（`resume-manager.js#restoreResume`：`ctx.messages = foldLedgerMessages(records)`，
    // 快照正文只在「崩溃现场」判定成立时作升级补全），快照里的旧块既不进上下文、也不进 `load()`
    // ⇒ F9b 的 `legacy` / F9d 的投影条目会整条落空（`assert.ok(legacy)` 红，而不是断言被改写）。
    // 升级前的真实账本本来就是这个形状：`appendRound` 每轮都带全量轮内消息，快照只是同一份正文的
    // 第二副本 ⇒ 旧块写在轮行里才是「0.19 形状」的原样，快照留一份副本正好顺带钉住
    // 「快照正文不再被当成上下文」（重复的正文一份也不多喂）。
    await storeC.appendRound(runIdC, { round: 1, messages: legacyRoundMessages });
    await storeC.saveRunSnapshot(runIdC, {
      round: 1,
      status: "done",
      messages: legacyRoundMessages,
      executedToolIds: ["legacy-1"],
      toolResults: [legacyBlock],
    });
    // resume 后的新调用靠模型自愿调工具——真模型有权利直接根据历史作答（实测会偶尔发生）。
    // 那不会改变本场景的契约判据（旧块不回写 / TTL 按旧名折叠 / 投影一代回退），但会让
    // 「新块用新形状」这条**没有主语**。工单不许把它断弱成「有就查」，所以这里：
    // ① 把任务写成不许直接作答；② 首轮没产生新调用就再推一轮 resume（同 store、同 runId），
    //    最多两次；两次都没有 = 真的坏了，F9a 照样红。
    const resumePrompt = (attempt) => `第 ${attempt} 次要求：必须调用 searchText 工具在文件里搜 needle（`
      + "不许根据上面已有的历史结果直接作答），然后一句话回答命中几次。";
    let outC = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      outC = await runToolLoop({
        provider: createOpenAIProvider(providerFields),
        resume: true,
        config: { input: { initialUserMessage: resumePrompt(attempt) } },
        task: "继续旧会话（必须真的调一次工具）",
        tools: TOOLS,
        executeTool: makeExecutor(dirC),
        store: storeCProbed,
        runId: runIdC,
        maxRounds: 4,
      });
      const freshSoFar = blocksOf(collapseHistory(await storeC.load(runIdC)), "tool_result")
        .filter((block) => block?.tool_use_id !== "legacy-1");
      if (freshSoFar.length > 0) break;
      console.log(`[2] resume 第 ${attempt} 轮没产生新调用（termination=${outC?.termination?.reason}），再推一轮`);
    }
    const recordsC = await storeC.load(runIdC);
    const historyC = collapseHistory(recordsC);
    const resultsC = blocksOf(historyC, "tool_result");
    const legacy = resultsC.find((b) => b?.tool_use_id === "legacy-1");
    const freshC = resultsC.filter((b) => b?.tool_use_id !== "legacy-1");

    check("F9a resume 后的新块用新形状（erix 在、顶层无退役名）", () => {
      assert.ok(freshC.length > 0, `resume 后没有新的 tool_result（termination=${JSON.stringify(outC?.termination)}）`);
      for (const block of freshC) {
        assert.equal(typeof block?.erix?.toolCallKey, "string");
        assert.ok(block.erix.toolCallKey.startsWith("tc_"));
        assert.equal(typeof block?.erix?.success, "boolean");
        for (const name of RETIRED) assert.ok(!Object.hasOwn(block, name), `新块顶层残留退役名 ${name}`);
      }
    }, `新块=${freshC.length}，↑${outC?.usage?.input_tokens}/↓${outC?.usage?.output_tokens}`);

    check("F9b 引擎不回写历史：旧块的退役名与宿主摊平键原样保留（只读不回写）", () => {
      assert.ok(legacy, "旧块没被带回上下文");
      assert.equal(legacy.erixRound, 0);
      assert.equal(legacy.duration, 1234);
      assert.equal(legacy.success, true);
      assert.equal(legacy.executionStatus, "ok");
      assert.equal(legacy.artifactStatus, "ok");
      assert.equal(legacy.erix, undefined, "旧块不该被补上 erix 命名空间");
      // 磁盘之外的另一半：引擎**内存里**那份上下文也不许改写宿主传进来的旧块。
      // 探针取的是 run snapshot 的 `messages`（= `cloneState(messages)`），即引擎内存上下文的逐字副本
      // ⇒ 这一条才真的钉住「宿主对象不被就地改写」；只读 `store.load()` 的话，改内存不落盘的坏法看不见。
      assert.ok(snapshotPayloads.length > 0, "resume 期间没写任何 run snapshot（探针空转，判据落空）");
      const seenInMemory = snapshotPayloads.flatMap((payload) => blocksOf(payload?.messages, "tool_result"))
        .filter((block) => block?.tool_use_id === "legacy-1");
      assert.ok(seenInMemory.length > 0, "引擎内存上下文里没见过旧块（探针没盖上要判的那一段）");
      for (const block of seenInMemory) {
        assert.deepEqual(Object.keys(block).sort(), Object.keys(legacyBlock).sort(),
          "引擎在内存里改了旧块的键集合（就地改写宿主对象）");
        assert.equal(block.erix, undefined, "引擎在内存里给旧块补了 erix（就地改写宿主对象）");
      }
    }, `旧块仍带退役名=${RETIRED.filter((r) => Object.hasOwn(legacy ?? {}, r)).join(",")}，快照探针=${snapshotPayloads.length} 份`);

    check("F9c 一代读窗口：TTL 仍按旧块 erixRound 算年龄并折叠（年龄来源没断）", () => {
      const stats = {};
      const folded = foldToolResultsForRequest(historyC, { currentRound: 50, ttl: 2, minTokens: 1, stats });
      assert.ok((stats.foldedCount ?? 0) > 0, `foldedCount=${stats.foldedCount}`);
      assert.ok(!JSON.stringify(blocksOf(folded, "tool_result"))
        .includes("旧版本落盘的读取结果"), "旧块应已被折叠掉原文");
    }, "旧块 erixRound=0 → currentRound=50");

    const legacyCall = projectTranscriptForDisplay(recordsC)
      .flatMap((card) => card?.toolCalls ?? [])
      .find((call) => call?.id === "legacy-1");
    check("F9d 投影的一代回退：旧块只回退 executionStatus，不伪造 toolCallKey/durationMs", () => {
      assert.ok(legacyCall, "投影里没有旧块对应的条目（判据落空）");
      assert.equal(legacyCall.executionStatus, "ok", "旧块的顶层 executionStatus 仍应读得到");
      assert.equal(legacyCall.toolCallKey, undefined, "旧块没有身份键，投影不许编一个");
      assert.equal(legacyCall.durationMs, undefined, "旧块的 duration 不许被当成 erix.durationMs 透出来");
    }, JSON.stringify(legacyCall));

    const freshCallsC = projectTranscriptForDisplay(recordsC)
      .flatMap((card) => card?.toolCalls ?? [])
      .filter((call) => call?.id !== "legacy-1");
    check("F9e 同一份混合历史里新块照样带 toolCallKey/durationMs（两代共存不互相污染）", () => {
      assert.ok(freshCallsC.length >= 1, `新块投影条目=${freshCallsC.length}`);
      assert.ok(freshCallsC.every((c) => typeof c.toolCallKey === "string"
        && Number.isFinite(c.durationMs) && c.durationMs >= 0),
      JSON.stringify(freshCallsC.map((c) => ({ k: c.toolCallKey, d: c.durationMs }))));
    });

    assert.deepEqual(failures, [], `真机段失败的断言：${failures.join(", ")}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
