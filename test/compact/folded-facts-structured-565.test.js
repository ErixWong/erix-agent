// issue #565：`foldedFacts` 结构化 —— `title` / `summary?` / `origin` / `toolCalls?` 四个键（纯加法）。
//
// 病根（工单正文）：宿主想把「每次折叠」渲染成一行可判断的索引（`区间 | 主题 | 规模`），
// 但引擎只给一段自由文本；`text` 还会被 `FOLDED_FACTS_MAX_BYTES`（2048）**前缀夹断**，
// 截掉什么由文本顺序决定、不由语义决定。同时引擎今天**没有语义写者**（`fold-statistical` 零 LLM），
// 所以正确做法不是让它假装会写语义，而是**把「这是谁写的」标出来**（`origin`）。
//
// 判据（工单「判据（绿）」逐条，每格一个用例）：
//   1. `fold-statistical` 路径 ⇒ `origin === "mechanical"` 且 `summary` **缺失**（不伪造语义）；
//   2. 宿主注入路径（宿主自带策略经 `foldSummary` 注入正文）⇒ `origin === "host"`；
//   3. 构造 >2048 字节摘要 ⇒ **`title` 仍在**（本单唯一硬断言：`text` 里仍含它，结构性存活）；
//   4. `toolCalls` 与 `text` 清单节逐条一致（同源，不是两份实现）；
//   5. 既有键 `source` / `strategy` / `from` / `to` / `rounds` / `bytes` / `truncated` / `degradeReason`
//      语义逐字不变（`bytes` 在 `summary` 缺席时**逐字节等于**旧口径 = 正文字节数）。
//
// 两条与初稿相反的修正（工单正文「⚠ 两处修正」，以此为准）：
//   · **不新增 `source`**（它已存在，说的是「文本来自策略还是摘要器」）⇒ 本单新增 `origin`（谁写的），两者正交；
//   · **不新增 `coverage`**（`from`/`to`/`rounds` 就是覆盖范围，再加一个只是同值复制）。
//
// 零真实 LLM：fake provider + 内存 store（AGENTS.md 测试隔离规则：不写真实 `~/.erix`）。
//
// #565 修补（title 剥掉引擎内部 marker）—— 判据见文件末尾的 `#565-6` 两格：
// 机械摘要的首行是「marker + 区间行 + 足迹行」（`formatFoldSummary` 里 `lines.slice(0, 2).join("")`，
// 两行之间没有换行），所以 `title` 开口就是 `FOLD_SUMMARY_MARKER`（带版本号与哈希的**内部标识**）。
// `title` 的唯一用途是宿主渲染一行索引 ⇒ marker 既占预算（60 字符里占 23）又会漏进宿主 UI；
// 让宿主自己去剥 marker，就把「解析引擎内部字面量」又塞回宿主 —— 那正是本方案要消灭的东西。

import assert from "node:assert/strict";
import test from "node:test";

import {
  FOLD_SUMMARY_MARKER,
  MAX_TOOL_INVENTORY_CHARS,
  MAX_TOOL_INVENTORY_ENTRIES,
  createFoldStatisticalStrategy,
  summarizeFoldedPayload,
} from "../../src/compact/fold-statistical.js";
import {
  FOLDED_FACTS_MAX_BYTES,
  FOLDED_FACTS_RECORD_FIELD,
  FOLDED_FACTS_TITLE_MAX_CHARS,
  FOLDED_FACT_ORIGINS,
  buildFoldedFacts,
} from "../../src/compact/fold-summary-journal.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { runDirect } from "../helpers/run-direct.js";

const encoder = new TextEncoder();
const bytesOf = (value) => encoder.encode(String(value ?? "")).length;

// 与 #470 / #470-D 那两套 fake provider 同一形状：先几发工具调用把上下文撑起来（折叠必然发生），再收尾。
function makeProvider({ toolTurns = 4 } = {}) {
  let turns = 0;
  const provider = {
    protocol: "fake",
    model: "fake-model",
    async chat() {
      if (turns < toolTurns) {
        turns += 1;
        return {
          content: [{
            type: "tool_use",
            id: `tu_${turns}`,
            name: "exec",
            input: { command: `npm test -- --grep case-${turns}` },
          }],
          stopReason: "tool_use",
        };
      }
      return { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" };
    },
  };
  provider.chatStream = provider.chat;
  return provider;
}

// #565 修补那两格用的"被折负载"：N 发 exec 调用（`summarizeFoldedPayload` 从中数出足迹与清单节）。
const execPayload = (count) => Array.from({ length: count }, (_, index) => ({
  role: "assistant",
  content: [{
    type: "tool_use",
    id: `use-${index + 1}`,
    name: "exec",
    input: { command: `npm test -- --grep case-${index + 1}` },
  }],
}));

const factsOf = async (store, runId) => {
  const records = await store.load(runId);
  const rows = records
    .filter((record) => record?.[FOLDED_FACTS_RECORD_FIELD] !== undefined)
    .map((record) => record[FOLDED_FACTS_RECORD_FIELD]);
  assert.ok(rows.length >= 1,
    `前置：这条路径必须真的折过（否则判据是空断言）。记录形状：${JSON.stringify(
      records.map((record) => ({ round: record.round, hasFacts: record?.[FOLDED_FACTS_RECORD_FIELD] !== undefined })),
    )}`);
  return rows;
};

// 测试侧的独立清单解析（与 `src/` 里那份**故意不共用**：判据 4 要的是「两处独立读同一段 text 仍相等」，
// 复用被检实现来验被检实现只会自证）。
const inventoryLinesOf = (text) => {
  const lines = String(text).split("\n");
  const heading = lines.findIndex((line) => line.startsWith("工具调用清单"));
  if (heading < 0) return [];
  const entries = [];
  for (const line of lines.slice(heading + 1)) {
    if (!line.startsWith("- ")) break;
    entries.push(line.slice(2));
  }
  return entries;
};

const ttlLine = (command) => "【已折叠·TTL】exec " + command
  + "（约 4200 tokens，r1 读取）"
  + "— 后续需要时先用 note_list 查找，再用 note_read 读取；未记录且无法确定性重算时请省略，不要猜测"
  + "；要点见对话中已有笔记/结论";

// ---- 判据 1：机械产物必须自报 mechanical，且不伪造 summary ----------------------

test("#565-1 fold-statistical（零 LLM）：origin === mechanical，summary 缺失，既有键不动", async () => {
  const store = createMemoryTranscriptStore();
  await runDirect({
    provider: makeProvider(),
    executeTool: async () => `tool output ${"z".repeat(400)}`,
    maxRounds: 2,
    completion: false,
    reflection: false,
    config: {
      folding: { context: { budgetTokens: 300, keepRounds: 0, strategy: "fold-statistical" } },
    },
    store,
    runId: "565-mechanical",
    seed: `start ${"y".repeat(600)}`,
  });

  for (const facts of await factsOf(store, "565-mechanical")) {
    // 判据 1 的两半：**机械** + **不冒充语义**。
    assert.equal(facts.origin, "mechanical",
      `零 LLM 的路径必须自报 mechanical，实测 ${JSON.stringify(facts.origin)}`);
    assert.equal(Object.hasOwn(facts, "summary"), false,
      `机械路径不得写 summary（没有语义写者就不许有语义字段），实测 ${JSON.stringify(facts.summary)}`);
    // 判据 5（同一条真机路径上对拍既有键）：source/strategy/bytes 逐字不变。
    assert.equal(facts.source, "statistical", "既有键 source 的取值一字未改");
    assert.equal(facts.strategy, "fold-statistical");
    assert.equal(facts.bytes, bytesOf(facts.text),
      "summary 缺席时 bytes 必须逐字节等于正文字节数（旧口径，不许被新键改写）");
    assert.ok(facts.bytes <= FOLDED_FACTS_MAX_BYTES);
    assert.equal(typeof facts.title, "string");
    assert.ok(facts.title !== "", "title 必填且非空");
    // #565 修补（真机路径的端到端证人）：机械摘要的首行**以引擎 marker 开头**，
    // 而 `title` 是给宿主渲染一行索引用的 ⇒ 它不许把那个**版本化内部标识**带出去。
    // 这条不在单元构造上验，而是钉在「真折了一次、真落了轮记录」的那份投影上。
    assert.equal(facts.text.startsWith(FOLD_SUMMARY_MARKER), true,
      "前置：真机那条机械摘要的首行确实以引擎 marker 开头（否则这条断言是空断言）");
    assert.equal(facts.title.includes(FOLD_SUMMARY_MARKER), false,
      `title 不得带引擎内部 marker（版本化标识不许漏进宿主 UI），实测 ${JSON.stringify(facts.title)}`);
  }
});

test("#565-1b 机械路径**给了**假 summary 也不许写出来（origin 是判据，不是注释）", () => {
  const facts = buildFoldedFacts({
    text: "早期第 1–3 轮（共 3 轮）已折叠。工具足迹：exec×2。",
    source: "statistical",
    strategy: "fold-statistical",
    // 机械产物假装有语义摘要：来源是 statistical ⇒ 这一份必须被丢弃，不是被照抄。
    summary: "主题：把早期历史收成一句",
  });
  assert.equal(facts.origin, "mechanical");
  assert.equal(Object.hasOwn(facts, "summary"), false,
    "机械路径写了 summary 就必须丢弃（否则宿主会把机械文本当语义索引用）");
  // 反方向：语义来源才允许有。
  const semantic = buildFoldedFacts({
    text: "## 阶段\n模型写的摘要",
    source: "llm",
    strategy: "fold-llm",
    summary: "主题：模型写的语义摘要",
  });
  assert.equal(semantic.origin, "semantic");
  assert.equal(semantic.summary, "主题：模型写的语义摘要", "语义来源才允许有 summary");
  assert.ok(semantic.bytes <= FOLDED_FACTS_MAX_BYTES,
    "summary 与 text 共用同一个 maxBytes 预算（不新开预算）");
  assert.equal(semantic.bytes, bytesOf(semantic.text) + bytesOf(semantic.summary),
    "summary 在场时 bytes 反映 text + summary 总量（谁都不在预算外）");
  // 判据 1 的派生面：**机械来源的每一档**都必须自报 mechanical（派生表里属于「机械」的那几行）。
  assert.equal(buildFoldedFacts({ text: "x", source: "strategy" }).origin, "mechanical",
    "零 LLM 策略（sliding-window）也是机械产物");
  assert.equal(buildFoldedFacts({ text: "x" }).origin, "mechanical",
    "source 缺省 = strategy ⇒ 机械（既有默认值不变）");
  assert.deepEqual([...FOLDED_FACT_ORIGINS], ["mechanical", "semantic", "host"], "闭集三值，不多不少");
});

// ---- 判据 2：宿主注入的正文自报 host --------------------------------------------

test("#565-2 宿主自带策略注入正文：origin === host（不是 mechanical，也不许有 summary）", async () => {
  // 宿主注入点：宿主把**自己的**策略挂在 `context.strategy` 上，`compact()` 返回的 `foldSummary`
  // 就是「宿主写的正文」。引擎侧唯一写侧产出点仍是 `buildFoldedFacts()` ⇒ 它必须能认出这条来源。
  const hostStrategy = {
    name: "host-supplied",
    shouldCompact: (messages) => Array.isArray(messages) && messages.length > 2,
    async compact(messages) {
      const head = messages.slice(0, messages.length - 1);
      const retained = messages.slice(-1);
      return {
        messages: retained,
        compacted: head.length > 0,
        foldedRounds: head.length,
        tokensBefore: 0,
        tokensAfter: 0,
        foldedPayload: head,
        foldedRoundRange: { from: 1, to: head.length },
        foldSummary: {
          source: "host",
          text: "宿主注入的主题摘要：把早期历史收成一句",
          // 宿主连语义摘要也一起塞：`origin === "host"` 不是语义来源 ⇒ 这个键必须被丢弃。
          summary: "宿主自报的语义摘要",
        },
      };
    },
  };

  const store = createMemoryTranscriptStore();
  await runDirect({
    provider: makeProvider(),
    executeTool: async () => `tool output ${"z".repeat(200)}`,
    maxRounds: 2,
    completion: false,
    reflection: false,
    // 策略对象是**端口**不是数据（`config` 子树必须能过 JSON 往返）⇒ 它的家是 `capabilities.ports.strategy`。
    capabilities: { ports: { strategy: hostStrategy } },
    config: { folding: { context: { budgetTokens: 300, keepRounds: 0 } } },
    store,
    runId: "565-host",
    seed: `start ${"y".repeat(400)}`,
  });

  const rows = await factsOf(store, "565-host");
  assert.equal(rows[0].origin, "host",
    `宿主注入的正文必须自报 host，实测 ${JSON.stringify(rows[0].origin)}（source=${JSON.stringify(rows[0].source)}）`);
  assert.equal(rows[0].source, "host", "既有键 source 逐字保留宿主给的值");
  assert.equal(Object.hasOwn(rows[0], "summary"), false, "只有 semantic 才允许 summary");
  assert.match(rows[0].text, /宿主注入的主题摘要/u, "前置：宿主那份正文真的进了投影");
});

test("#565-2b 宿主侧派生：llm ⇒ semantic，host/未知 ⇒ host（未知不得冒充引擎产物）", () => {
  const originOf = (source) => buildFoldedFacts({ text: "x", source }).origin;
  assert.equal(originOf("llm"), "semantic");
  assert.equal(originOf("host"), "host");
  assert.equal(originOf("something-else"), "host",
    "未知来源不得冒充引擎产物（宁可少认，不可多认）");
});

// ---- 判据 3：>2048 字节夹断后 title 仍在（本单唯一硬断言）------------------------

test("#565-3 >2048 字节摘要：夹断后 title 仍在（text 里仍含它，结构性存活）", async () => {
  const messages = [{ role: "user", content: "task" }];
  for (let index = 1; index <= 12; index += 1) {
    messages.push(
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: `use-${index}`,
          name: "exec",
          input: { command: `npm test -- --grep case-${index}` },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: `use-${index}`,
          content: `${ttlLine(`npm test -- --grep case-${index}`)}\n${"y".repeat(64)}`,
        }],
      },
    );
  }
  messages.push({ role: "user", content: "keep" });

  const compacted = await createFoldStatisticalStrategy().compact(messages, { keepRounds: 1 });
  const summary = compacted.messages[0].content[0].text;
  assert.ok(bytesOf(summary) > FOLDED_FACTS_MAX_BYTES,
    `前置：摘要必须真的超过 ${FOLDED_FACTS_MAX_BYTES} 字节，实测 ${bytesOf(summary)}`);

  const facts = buildFoldedFacts({
    text: summary,
    source: "statistical",
    strategy: "fold-statistical",
    roundRange: { from: 1, to: 12 },
    rounds: 12,
  });
  assert.equal(facts.truncated, true, "前置：这一份必须真的被夹断");
  assert.ok(facts.bytes <= FOLDED_FACTS_MAX_BYTES, `夹断后 ≤ ${FOLDED_FACTS_MAX_BYTES}，实测 ${facts.bytes}`);

  // ★ 硬断言：title 在夹断后**结构性**存活。
  //
  // 为什么是 `includes` 而不是 `startsWith`（#565 修补）：`title` 现在会先剥掉首行里那段引擎 marker
  // （`【上下文折叠·v1·…】`），于是它**不再是 `text` 的字面前缀**。但「结构性」没有变弱：
  // `title` 仍是 `raw` 头部的一个**连续子串**（剥的是它前面的 marker、末尾夹的是字符数），
  // 而 `text` 保留的是 `raw` 的**前缀** ⇒ 只要那个前缀跨过 `title` 的末尾，`title` 就整段在里面。
  // 这不是「看起来像」：它由「夹断只削尾」+「title 取自 raw 头部」两条构造成立，与文本内容无关。
  assert.ok(facts.title !== "", "title 不得为空");
  assert.ok(Array.from(facts.title).length <= FOLDED_FACTS_TITLE_MAX_CHARS,
    `title ≤ ${FOLDED_FACTS_TITLE_MAX_CHARS} 字符，实测 ${Array.from(facts.title).length}`);
  assert.ok(facts.text.includes(facts.title),
    `夹断后 text 必须仍含 title（否则 title 只是"看起来还在"）：title=${JSON.stringify(facts.title)}`
    + ` text=${JSON.stringify(facts.text.slice(0, 80))}`);
  assert.match(facts.title, /早期第 1–12 轮（共 12 轮）已折叠/u,
    "title 就是那条区间句（宿主渲染一行索引要的「区间」不必再正则解析中文）");

  // 更小的预算（512）也一样：夹断削的是尾部，首行（剥掉 marker 后）按构造还在。
  const tight = buildFoldedFacts({ text: summary, source: "statistical", maxBytes: 512 });
  assert.equal(tight.truncated, true);
  assert.ok(tight.bytes <= 512);
  assert.ok(tight.text.includes(tight.title),
    `小预算下 title 同样必须存活：${JSON.stringify(tight.text.slice(0, 60))}`);
});

// ---- 判据 4：toolCalls 与 text 清单节逐条一致（同源）-----------------------------

test("#565-4 toolCalls 与 text 清单节逐条一致（同源，不是第二份实现）", async () => {
  const messages = [{ role: "user", content: "task" }];
  for (let index = 1; index <= 12; index += 1) {
    messages.push(
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: `use-${index}`,
          name: index % 2 === 0 ? "exec" : "readFile",
          input: index % 2 === 0
            ? { command: `npm test -- --grep case-${index}` }
            : { path: `src/case-${index}.js` },
        }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `use-${index}`, content: `${"y".repeat(200)}` }],
      },
    );
  }
  messages.push({ role: "user", content: "keep" });

  const compacted = await createFoldStatisticalStrategy().compact(messages, { keepRounds: 1 });
  const summary = compacted.messages[0].content[0].text;

  const facts = buildFoldedFacts({ text: summary, source: "statistical", strategy: "fold-statistical" });
  assert.ok(Array.isArray(facts.toolCalls), "清单节在场 ⇒ toolCalls 必须在场");
  assert.ok(facts.toolCalls.length <= MAX_TOOL_INVENTORY_ENTRIES,
    `≤ ${MAX_TOOL_INVENTORY_ENTRIES} 条，实测 ${facts.toolCalls.length}`);

  // 逐条对拍：测试侧**自己**从 `text` 里读一遍（不共用被检解析器），两边必须逐条相等。
  const lines = inventoryLinesOf(facts.text);
  assert.equal(facts.toolCalls.length, lines.length,
    `toolCalls 条数必须等于 text 清单节条数：${JSON.stringify(facts.toolCalls)} vs ${JSON.stringify(lines)}`);
  for (const [index, entry] of facts.toolCalls.entries()) {
    const rendered = entry.argsSummary === "" ? entry.name : `${entry.name} ${entry.argsSummary}`;
    assert.equal(rendered, lines[index],
      `第 ${index + 1} 条必须与 text 里的那一行逐字相等（同源）：${JSON.stringify(rendered)} vs ${JSON.stringify(lines[index])}`);
    assert.ok(Array.from(rendered).length <= MAX_TOOL_INVENTORY_CHARS,
      `每条 ≤ ${MAX_TOOL_INVENTORY_CHARS} 字符`);
  }
  assert.equal(facts.toolCalls.length, MAX_TOOL_INVENTORY_ENTRIES, "12 次调用只留 8 条");

  // 夹断之后仍然逐条相等（清单节排在区间行之后 ⇒ 它在前缀里；残行也逐字相等）。
  const truncated = buildFoldedFacts({
    text: `${summary}\n${"锚点行".repeat(600)}`,
    source: "statistical",
    strategy: "fold-statistical",
  });
  assert.equal(truncated.truncated, true, "前置：这一份必须真的被夹断");
  const keptLines = inventoryLinesOf(truncated.text);
  assert.equal(truncated.toolCalls.length, keptLines.length);
  for (const [index, entry] of truncated.toolCalls.entries()) {
    const rendered = entry.argsSummary === "" ? entry.name : `${entry.name} ${entry.argsSummary}`;
    assert.equal(rendered, keptLines[index], `夹断后第 ${index + 1} 条仍须逐字相等`);
  }

  // 没有清单节时**不写这个可选键**（不造占位字面量，与 #470-A2 同口径）。
  const withoutInventory = buildFoldedFacts({ text: "早期第 1–2 轮（共 2 轮）已折叠。", source: "statistical" });
  assert.equal(Object.hasOwn(withoutInventory, "toolCalls"), false,
    "清单节缺席 ⇒ toolCalls 缺席（不是空数组占位）");
});

// ---- 判据 5：既有键语义对拍 ------------------------------------------------------

test("#565-5 既有键逐字不变：source/strategy/from/to/rounds/bytes/truncated/bytesBefore/degradeReason", () => {
  const small = buildFoldedFacts({
    text: "早期第 1–9 轮（共 9 轮）已折叠。工具足迹：shell×3。",
    source: "statistical",
    strategy: "fold-statistical",
    roundRange: { from: 1, to: 9 },
    rounds: 9,
    degradeReason: "x".repeat(200),
    fingerprint: "sha256:deadbeefdeadbeefdeadbeef",
  });
  assert.equal(small.source, "statistical");
  assert.equal(small.strategy, "fold-statistical");
  assert.deepEqual({ from: small.from, to: small.to, rounds: small.rounds }, { from: 1, to: 9, rounds: 9 });
  assert.equal(small.bytes, bytesOf(small.text), "bytes 旧口径：正文字节数（summary 缺席时逐字节相同）");
  assert.equal(small.truncated, undefined, "没超限不得谎报 truncated");
  assert.equal(small.bytesBefore, undefined, "没夹断就没有 bytesBefore");
  assert.equal(small.degradeReason.length, 120, "degradeReason 仍夹到 120 字符（既有口径）");
  assert.equal(small.fingerprint, "sha256:deadbeefdeadbeefdeadbeef");

  const huge = buildFoldedFacts({ text: `头${"字".repeat(4000)}尾`, maxBytes: 512 });
  assert.ok(huge.bytes <= 512);
  assert.equal(huge.truncated, true);
  assert.equal(huge.bytesBefore, bytesOf(`头${"字".repeat(4000)}尾`), "bytesBefore 仍是**原始正文**字节数");
  assert.match(huge.text, /\[替代物已按字节上限夹断\]/u);

  // 非法输入不写畸形事实（既有格）。
  const odd = buildFoldedFacts({ text: "x", rounds: 0, roundRange: { from: null, to: "3" } });
  assert.equal(odd.rounds, undefined);
  assert.equal(odd.from, undefined);
  assert.equal(odd.to, undefined);

  // 空文本仍然 ⇒ undefined（调用方据此不写键）。
  assert.equal(buildFoldedFacts({ text: "   " }), undefined);
});

// ---- #565 修补：title 剥掉引擎内部 marker（宿主索引行不该带版本化内部标识）---------
//
// 真机现场（主 agent 实测，不是构造）：
//   title = "【上下文折叠·v1·erix-9f6e2c】早期第 12–57 轮（共 46 轮）已折叠。工具足迹：exec×12。"
// 两个事实：① 首行带 `FOLD_SUMMARY_MARKER`（含版本号与哈希）；② `formatFoldSummary` 里
// `prefix = lines.slice(0, 2).join("")` —— 区间行与足迹行**之间没有换行**，所以「首行」= marker + 区间 + 足迹。
// `title` 的唯一用途是宿主渲染一行索引 ⇒ marker 占掉 60 字符预算的三分之一，而且它是版本化内部标识，
// 会漏进宿主 UI；宿主若自己去剥 marker，就又把「解析引擎内部字面量」这件事塞回宿主。

test("#565-6 机械摘要 ⇒ title 逐字等于剥掉 marker 的首行（判据 1 / 判据 2）", () => {
  // 判据 1：真机那条字面（12–57 轮 / 共 46 轮 / exec×12）。文本由**引擎自己的**那个函数产出
  // （`summarizeFoldedPayload` —— `orchestrator` 在定稿处就地现算机械替代物用的就是它），
  // 不是手写常量 ⇒ 这条测的是「引擎写什么，title 就剥什么」，不是「两个字符串能不能相等」。
  // 负载是 12 发 exec 调用 ⇒ 足迹 exec×12、清单节在场（清单节在场时首行才正好止于足迹行：
  // `formatFoldSummary` 里 `prefix = lines.slice(0, 2).join("")` 之后才 `\n` 接后续节）。
  const text = summarizeFoldedPayload(execPayload(12), { from: 12, to: 57, count: 46 });
  assert.equal(text.startsWith(FOLD_SUMMARY_MARKER), true,
    "前置：机械摘要的首行确实以引擎 marker 开头（否则这一格是空断言）");

  const facts = buildFoldedFacts({ text, source: "statistical" });
  assert.equal(facts.title, "早期第 12–57 轮（共 46 轮）已折叠。工具足迹：exec×12。",
    `title 必须逐字等于剥掉 marker 后的首行，实测 ${JSON.stringify(facts.title)}`);
  assert.equal(facts.title.includes(FOLD_SUMMARY_MARKER), false,
    `title 不得带引擎内部 marker（版本化标识不许漏进宿主 UI），实测 ${JSON.stringify(facts.title)}`);

  // 判据 2：字符上界不变（60），且 title 仍是 text 里的**连续子串**。
  // 为什么 `includes` 就够：剥掉 marker 之后 title 不再是字面前缀，但它仍是 `raw` 头部的一个连续子串，
  // 而 `text` 保留的是 `raw` 的前缀 ⇒ 「夹断后仍在」依旧按构造成立（见 `#565-3` 的注释）。
  assert.ok(facts.title.length <= FOLDED_FACTS_TITLE_MAX_CHARS,
    `title ≤ ${FOLDED_FACTS_TITLE_MAX_CHARS} 字符，实测 ${facts.title.length}`);
  assert.ok(facts.text.includes(facts.title),
    `title 必须是 text 里的连续子串：title=${JSON.stringify(facts.title)}`);
  // 剥 marker 不改 `text` 一个字节（`title` 是投影，不是对正文的改写）。
  assert.equal(facts.text, text, "text 逐字未动（剥 marker 只作用于 title）");
});

test("#565-6b 首行只有 marker ⇒ title 退回未剥版本（非空），夹断后仍是 text 的子串（判据 4）", () => {
  // 判据 4：剥完为空时不许产出空串 —— 空 title 会让宿主那行索引变成**空白**。
  const bare = buildFoldedFacts({ text: FOLD_SUMMARY_MARKER });
  assert.ok(bare !== undefined, "前置：只有 marker 也是可投影的正文");
  assert.equal(bare.title, FOLD_SUMMARY_MARKER, "剥完为空 ⇒ 退回未剥版本的首行（宁可漏标识，不给空串）");
  assert.ok(bare.title !== "", "title 永不为空");

  // 首行只有 marker、正文还有后续行：同样退回未剥版本（不是空串、也不是第二行）。
  const firstLineOnlyMarker = buildFoldedFacts({ text: `${FOLD_SUMMARY_MARKER}\n工具足迹：无。` });
  assert.equal(firstLineOnlyMarker.title, FOLD_SUMMARY_MARKER);
  assert.ok(firstLineOnlyMarker.title !== "", "title 永不为空");

  // 剥了 marker 之后「夹断后 title 仍在」仍然是**结构性**的（不是运气）：
  // title 是 raw 头部的连续子串，text 保留的是 raw 的前缀 ⇒ 前缀跨过 title 末尾就整段在里面。
  const longText = summarizeFoldedPayload(execPayload(12), { from: 12, to: 57, count: 46 });
  const huge = buildFoldedFacts({ text: `${longText}\n${"锚点行".repeat(600)}`, source: "statistical" });
  assert.equal(huge.truncated, true, "前置：这一份必须真的被夹断");
  assert.equal(huge.title.startsWith(FOLD_SUMMARY_MARKER), false, "夹断后 title 同样不带 marker");
  assert.ok(huge.text.includes(huge.title),
    `夹断后 text 必须仍含 title：title=${JSON.stringify(huge.title)} text=${JSON.stringify(huge.text.slice(0, 80))}`);
});
