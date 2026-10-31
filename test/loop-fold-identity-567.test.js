// issue #567 —— 折叠事件身份与投递时序：稳定 `foldId` + run 内单调 `seq` + 「投递在轮记录 append 之前」。
//
// 工单的三条诉求（本文件逐条钉）：
//   ① **稳定身份 `foldId`**：与 `foldSummaryFingerprint` **同源**（`messages + roundRange + recoveryHint`
//      的规范化 JSON 哈希；摘要器路径下还包括续写基底）⇒ 重放同一次折叠得到同一个 id，宿主据此幂等去重，
//      不再靠时刻、也不再靠「每 worker 从 0 起」的局部计数器（erix-station `runner/lib/fold-notes.js`）；
//   ② **`seq`（run 内单调）**：由引擎给，不让宿主数；同一 `foldId` 重投拿回**同一个**号；
//   ③ **投递时序写死**：投递发生在承载 `foldedFacts` 的轮记录 append **之前**（今天的现场），
//      契约里逐字同一句；本文件用「钩子里那一刻去账本里查不到这条 foldId」把它钉住，不是靠注释。
//
// 反向证（防回装；与 `test/mutation-samples.md` 的 M12 / M13 成对）：
//   · ④ 把 `roundRange` 从指纹输入里去掉 ⇒ 同 messages、不同区间的两次折叠会拿到**同一个** `foldId` ⇒ 红；
//   · ⑤ 把 `seq` 改回宿主自算（= 引擎不给）⇒ 载荷里没有 `seq` ⇒ 红。
//
// 零真实 LLM：fake provider + 内存 store（AGENTS.md 测试隔离规则：不写真实 `~/.erix`）。
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFoldedFacts,
  createFoldIdentityAllocator,
  FOLDED_FACTS_RECORD_FIELD,
  foldSummaryFingerprint,
} from "../src/compact/fold-summary-journal.js";
import { createSlidingWindowStrategy } from "../src/compact/sliding-window.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { runDirect } from "./helpers/run-direct.js";

const TOOLS = [{
  name: "echo",
  description: "回显输入",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
}];

/** 与 #470-D / #479 那两格同一套 fake provider：先几发工具调用把上下文撑起来（折叠必然发生），再收尾。 */
function makeProvider({ toolTurns = 6, tag = "" } = {}) {
  let turns = 0;
  const provider = {
    // fake 协议的判别键：缺了它 `runToolLoop` 不会把这份 provider 当 fake 驱动。
    protocol: "fake",
    model: "fake-model",
    async chat() {
      if (turns < toolTurns) {
        turns += 1;
        return {
          content: [{
            type: "tool_use",
            id: `tu_${tag}${turns}`,
            name: "echo",
            input: { text: `R${turns}_${"填充".repeat(300)}` },
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

/** 折叠必然发生的那条路：`budgetTokens` 很小 + `sliding-window` 策略（零 LLM、机械替代物）。 */
async function runFolding({ onFoldSummary, store = createMemoryTranscriptStore(), runId = "s-567-identity" } = {}) {
  const payloads = [];
  const run = await runDirect({
    // 观察面走**规位**（`capabilities.hooks.*`），不用已退役的顶层扁平拼写（#499 / #498 S4c）：
    // 新写的格子不往兼容钉子的计数面（`test/compat-pin-inventory.md` 的主表）添写点。
    capabilities: {
      ports: { strategy: createSlidingWindowStrategy({ keepRounds: 1 }) },
      hooks: {
        onFoldSummary: (payload) => {
          payloads.push(payload);
          onFoldSummary?.(payload);
        },
      },
    },
    provider: makeProvider(),
    runId,
    store,
    seed: "开始任务",
    tools: TOOLS,
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`,
    config: {
      run: { maxRounds: 20, completion: false },
      folding: { context: { budgetTokens: 300, keepRounds: 1 } },
    },
  });
  const records = await store.load(runId);
  return {
    run,
    records,
    payloads,
    factRecords: records.filter((record) => record[FOLDED_FACTS_RECORD_FIELD] !== undefined),
  };
}

const factsOf = (record) => record[FOLDED_FACTS_RECORD_FIELD];

test("①两轮各折一次 ⇒ foldId 互不相同、seq 严格递增且可排序，且按 foldId 能唯一对回被折的那批轮（#567 判据③）", async () => {
  const { run, payloads, factRecords } = await runFolding();
  assert.ok(String(run?.finalText ?? "").includes("收尾结论"),
    `run 必须正常收尾：${JSON.stringify(run?.termination ?? {})}`);
  // 前提：至少两折（否则「两次 id/seq 不同」测不到）。这条路径实测 6 折，这里只要求 ≥2。
  assert.ok(payloads.length >= 2, `前提：这条路径必须真的折过至少两次，实测 ${payloads.length}`);
  assert.equal(payloads.length, factRecords.length, "一次折叠 = 一次投递 = 一条轮记录事实（不多不少）");

  // ① 每条投递都带稳定身份与 run 内序号（宿主不必自己造）。
  for (const payload of payloads) {
    assert.equal(typeof payload.foldId, "string", `foldId 必须是字符串，实测 ${String(payload.foldId)}`);
    assert.match(payload.foldId, /^sha256:[0-9a-f]{24}$/u, `foldId 必须是指纹形状，实测 ${payload.foldId}`);
    assert.ok(Number.isSafeInteger(payload.seq) && payload.seq >= 1,
      `seq 必须是 ≥1 的安全整数，实测 ${String(payload.seq)}`);
    // 「一个身份，不是两个」：`foldId` 与既有内部键 `fingerprint` 同值（见模块注释）。
    assert.equal(payload.foldId, payload.fingerprint,
      "foldId 必须就是复用指纹那个值（再哈希一层 = 两处口径，迟早会漂）");
  }

  // ② 两次折叠的 id 必须不同（不同输入 ⇒ 不同身份），seq 必须严格递增（可排序）。
  const ids = payloads.map((payload) => payload.foldId);
  assert.equal(new Set(ids).size, ids.length, `不同折叠不得共用同一个 foldId：${ids.join(" / ")}`);
  const seqs = payloads.map((payload) => payload.seq);
  for (let index = 1; index < seqs.length; index += 1) {
    assert.ok(seqs[index] > seqs[index - 1], `seq 必须严格递增：${seqs.join(" → ")}`);
  }
  // 「可排序」的可测面：按 seq 排序 = 投递顺序（不是按字符串排）。
  const sorted = [...payloads].sort((a, b) => a.seq - b.seq);
  assert.deepEqual(sorted.map((payload) => payload.foldId), ids, "按 seq 排序必须还原投递顺序");

  // ③ 宿主拿 foldId 能把这条摘要**唯一**对回被折的那批轮：轮记录里恰好一条同 id 的事实，
  //    且它的区间与载荷逐字段相等（区间就是「被折的那批轮」）。
  for (const payload of payloads) {
    const matched = factRecords.filter((record) => factsOf(record)?.foldId === payload.foldId);
    assert.equal(matched.length, 1, `foldId ${payload.foldId} 必须唯一命中一条轮记录，实测 ${matched.length}`);
    const fact = factsOf(matched[0]);
    assert.equal(fact.seq, payload.seq, "同一条事实的 seq 必须一致（载荷 = 轮记录那份）");
    assert.equal(Number(matched[0].round), Number(payload.round), "命中的必须是发生这次折叠的那一轮");
    assert.equal(fact.from, payload.foldedRoundRange.from, "区间 from 与载荷同一份");
    assert.equal(fact.to, payload.foldedRoundRange.to, "区间 to 与载荷同一份");
    assert.ok(Number.isSafeInteger(fact.from) && fact.to >= fact.from,
      `区间必须是一段真实轮次：${JSON.stringify({ from: fact.from, to: fact.to })}`);
  }
});

test("②同一折叠投递两次 ⇒ foldId / seq 都相同：身份是被折输入的函数（可从账本逐位重算），序号按身份记忆", async () => {
  // 甲：分配器按 foldId 记忆（「同一次折叠」在引擎内的判据）——这是「seq 相同」的实现点。
  const allocator = createFoldIdentityAllocator();
  assert.equal(allocator.allocate("sha256:aaa"), 1);
  assert.equal(allocator.allocate("sha256:bbb"), 2);
  assert.equal(allocator.allocate("sha256:aaa"), 1, "同一 foldId 重投必须拿回首次那个号");
  assert.equal(allocator.lastSeq(), 2, "重投不得把计数器往前推");
  assert.equal(allocator.allocate(""), undefined, "空 foldId 不占号（没事实就不写键）");
  assert.equal(allocator.allocate(undefined), undefined);

  // 乙：身份是**被折输入的函数**，不是时刻 / 随机量。可证伪面：拿账本里的 `foldedPayload`
  // + `foldedRoundRange` 重算指纹，必须逐位等于落账的 `foldId` ⇒ 同一个折叠输入重放多少次
  // 都是同一个 id（宿主可以幂等去重，不用靠时刻）。
  // ⚠ 范围：机械路径（`sliding-window` / `fold-statistical`，`lastFoldSummaryOutcome === undefined`）
  // 下指纹输入就是「被折负载 + 区间 + 恢复提示」，所以能从账本重算；摘要器路径的指纹还含
  // 续写基底与截断后的入参（#469），那不是账本可重算的——两条路径的共同契约只是「同输入同 id」。
  const { payloads, factRecords } = await runFolding();
  assert.ok(factRecords.length >= 2, `前提：这条路径必须真的折过至少两次，实测 ${factRecords.length}`);
  for (const record of factRecords) {
    const fact = factsOf(record);
    assert.equal(
      fact.foldId,
      foldSummaryFingerprint({
        messages: record.foldedPayload,
        roundRange: record.foldedRoundRange ?? null,
        recoveryHint: null,
      }),
      `foldId 必须能从账本那份被折负载逐位重算（第 ${record.round} 轮）——重放同一个折叠输入必须得到同一个 id`,
    );
  }
  // 同一 foldId 在投递里只出现一次（不重投）；一旦重投，分配器会把它映射回同一个 seq。
  const deliveredIds = payloads.map((payload) => payload.foldId);
  assert.equal(new Set(deliveredIds).size, deliveredIds.length);
  for (const payload of payloads) {
    assert.equal(allocator.allocate(payload.foldId) !== undefined, true, "分配器必须能为已投递的身份给出序号");
  }
});

test("③投递时序：钩子里那一刻账本还没有这条 foldId 的轮记录，run 结束后恰好一条（投递在 append 之前）", async () => {
  // 现场核对：投递发生在 `compactBeforeRound` 内（替代物定稿处），而承载 `foldedFacts` 的轮记录
  // 要到本轮结束才 `persist("appendRound", …)` ⇒ 投递那一刻账本里**没有**这条 foldId。
  // 这一格就是契约那句「投递发生在轮记录 append 之前」的可证伪面：把投递挪到 append 之后 ⇒ 红。
  const store = createMemoryTranscriptStore();
  const deliverySnapshots = [];
  const runId = "s-567-order";
  const ordered = await runDirect({
    capabilities: {
      ports: { strategy: createSlidingWindowStrategy({ keepRounds: 1 }) },
      hooks: {
        onFoldSummary: async (payload) => {
          const records = await store.load(runId);
          deliverySnapshots.push({
            foldId: payload.foldId,
            alreadyPersisted: records.filter((record) => record[FOLDED_FACTS_RECORD_FIELD]?.foldId === payload.foldId).length,
          });
        },
      },
    },
    provider: makeProvider(),
    runId,
    store,
    seed: "开始任务",
    tools: TOOLS,
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`,
    config: {
      run: { maxRounds: 20, completion: false },
      folding: { context: { budgetTokens: 300, keepRounds: 1 } },
    },
  });
  assert.ok(String(ordered?.finalText ?? "").includes("收尾结论"),
    `run 必须正常收尾：${JSON.stringify(ordered?.termination ?? {})}`);
  assert.ok(deliverySnapshots.length >= 1, "前提：这条 run 必须真的投递过");
  for (const snapshot of deliverySnapshots) {
    assert.equal(snapshot.alreadyPersisted, 0,
      `投递那一刻账本里不该有 foldId=${snapshot.foldId} 的轮记录（投递在 append 之前）`);
  }
  const after = (await store.load(runId)).filter((record) => record[FOLDED_FACTS_RECORD_FIELD] !== undefined);
  assert.equal(after.length, deliverySnapshots.length, "run 结束后每条投递都恰好落一条轮记录");
  for (const snapshot of deliverySnapshots) {
    assert.equal(after.filter((record) => factsOf(record).foldId === snapshot.foldId).length, 1,
      `run 结束后 foldId=${snapshot.foldId} 必须恰好一条（补写是 update，不是重复追加）`);
  }
});

test("④反向证（#567）：foldId 随被折轮区间变化 —— 同 messages、不同区间必须是不同 id（去掉 roundRange 就会撞车）", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "早期第 1–2 轮的正文" }] },
    { role: "assistant", content: [{ type: "text", text: "早期第 1–2 轮的回复" }] },
  ];
  const early = foldSummaryFingerprint({ messages, roundRange: { from: 1, to: 2 } });
  const later = foldSummaryFingerprint({ messages, roundRange: { from: 3, to: 4 } });
  assert.notEqual(early, later,
    "同一份被折正文、不同轮区间的两次折叠必须是不同 foldId（否则宿主会把两次折叠当成一次去重掉）");

  // 另外两个输入维度也各占一位（同源口径 = messages + roundRange + recoveryHint）：
  assert.notEqual(
    foldSummaryFingerprint({ messages, roundRange: { from: 1, to: 2 }, recoveryHint: "继续修测试" }),
    early,
    "恢复提示必须进身份（否则「同正文、不同恢复提示」的两次折叠会撞同一个 id）",
  );
  assert.notEqual(
    foldSummaryFingerprint({ messages: [...messages, { role: "user", content: "多一轮" }], roundRange: { from: 1, to: 2 } }),
    early,
    "被折正文必须进身份",
  );
  // 同输入 ⇒ 同 id（稳定性的另一半）。
  assert.equal(foldSummaryFingerprint({ messages, roundRange: { from: 1, to: 2 } }), early,
    "同一输入必须得到同一个 foldId（重放可幂等去重的前提）");
});

test("⑤反向证（#567）：seq 由引擎给 —— 引擎侧每次折叠都带一个安全正整数，纯函数拿不到就不写键", async () => {
  // 纯函数侧：「没有事实就不写键」的既有口径（拿不到 seq 就不许编一个）。
  const withoutSeq = buildFoldedFacts({ text: "早期第 1–2 轮已折叠。", foldId: "sha256:abc" });
  assert.equal(Object.hasOwn(withoutSeq, "seq"), false, "没给 seq ⇒ 不得写该键（不写占位字面量）");
  assert.equal(withoutSeq.foldId, "sha256:abc", "给了 foldId 就必须带上");
  assert.equal(Object.hasOwn(buildFoldedFacts({ text: "x" }), "foldId"), false, "没给 foldId ⇒ 不得写该键");
  for (const bad of [0, -1, 1.5, "3", null]) {
    assert.equal(Object.hasOwn(buildFoldedFacts({ text: "x", seq: bad }), "seq"), false,
      `非法 seq 不得落进事实：${String(bad)}`);
  }

  // 引擎侧：每条投递与每条轮记录都必须带 seq，且是同一个号（宿主不许自己数）。
  const { payloads, factRecords } = await runFolding();
  assert.ok(payloads.length >= 1, "前提：必须真的折叠过");
  for (const payload of payloads) {
    assert.ok(Number.isSafeInteger(payload.seq) && payload.seq >= 1,
      `引擎侧每次折叠都必须带 seq（宿主自算 = 工单要消灭的那个 bug），实测 ${String(payload.seq)}`);
  }
  for (const record of factRecords) {
    const fact = factsOf(record);
    assert.ok(Number.isSafeInteger(fact.seq) && fact.seq >= 1,
      `轮记录里的 foldedFacts 必须带 seq，实测 ${String(fact.seq)}`);
  }
  assert.deepEqual(
    factRecords.map((record) => factsOf(record).seq),
    payloads.map((payload) => payload.seq),
    "账本里的 seq 序列必须与投递顺序逐个相等",
  );
});

test("⑥resume：账本里的 seq 灌回分配器 ⇒ 新折叠接在最大号之后，旧记录按账本顺序补号（#567）", async () => {
  // 甲：纯函数侧的三条口径。
  const allocator = createFoldIdentityAllocator();
  allocator.allocate("sha256:a");                       // ⇒ 1
  const seeded = allocator.seed([
    { foldId: "sha256:a", seq: 1 },                      // 已有 ⇒ 不重复灌
    { foldId: "sha256:b", seq: 2 },                      // 原样恢复
    { foldId: "sha256:c" },                              // #567 之前的记录（无 seq）⇒ 按账本顺序补号
    { foldId: "" },                                      // 空 id ⇒ 跳过
    null,                                                // 非对象 ⇒ 跳过
  ]);
  assert.equal(seeded, 2, "只灌入两条有效的新身份");
  assert.equal(allocator.seqOf("sha256:b"), 2, "账本里的 seq 原样恢复");
  assert.equal(allocator.seqOf("sha256:c"), 3, "无 seq 的旧记录按账本顺序补号（旧 → 新）");
  assert.equal(allocator.allocate("sha256:d"), 4, "新折叠必须接在已见最大值之后");
  assert.equal(allocator.allocate("sha256:c"), 3, "重放旧折叠拿回它原来的号（resume 不打穿宿主去重）");

  // 乙：端到端 —— run1 折三次（seq 1..3），resume 出来的 run 必须从 4 起。
  const store = createMemoryTranscriptStore();
  const runId = "s-567-resume";
  const firstPayloads = [];
  const first = await runDirect({
    capabilities: {
      ports: { strategy: createSlidingWindowStrategy({ keepRounds: 1 }) },
      hooks: { onFoldSummary: (payload) => { firstPayloads.push(payload); } },
    },
    provider: makeProvider({ toolTurns: 4 }),
    runId,
    store,
    seed: "开始任务",
    tools: TOOLS,
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`,
    config: {
      run: { maxRounds: 4, completion: false },
      folding: { context: { budgetTokens: 300, keepRounds: 1 } },
    },
  });
  assert.ok(first?.termination !== undefined, "前提：run1 必须跑完");
  assert.ok(firstPayloads.length >= 1, `前提：run1 必须真的折叠过，实测 ${firstPayloads.length}`);
  const watermark = Math.max(...firstPayloads.map((payload) => payload.seq));

  const resumedPayloads = [];
  await runToolLoop({
    provider: makeProvider({ toolTurns: 4, tag: "b" }),
    store,
    tools: TOOLS,
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`,
    capabilities: { hooks: { onFoldSummary: (payload) => { resumedPayloads.push(payload); } } },
    config: {
      run: { resume: true, runId, maxRounds: 4, completion: false, reflection: false },
      folding: { context: { budgetTokens: 300, keepRounds: 1, strategy: "sliding-window" } },
    },
  });
  assert.ok(resumedPayloads.length >= 1, "前提：resume 出来的 run 必须真的折叠过");
  for (const payload of resumedPayloads) {
    assert.ok(payload.seq > watermark,
      `resume 后的新折叠必须接在账本最大号 ${watermark} 之后，实测 ${payload.seq}`);
  }
  const resumedIds = new Set(resumedPayloads.map((payload) => payload.foldId));
  for (const payload of firstPayloads) {
    assert.equal(resumedIds.has(payload.foldId), false, "resume 后折的是新轮次 ⇒ 不得复用旧身份");
  }
  // 账本侧：全量 seq 严格递增（跨两次 run 也不回退）。
  const records = await store.load(runId);
  const allSeqs = records
    .filter((record) => record[FOLDED_FACTS_RECORD_FIELD] !== undefined)
    .map((record) => factsOf(record).seq);
  for (let index = 1; index < allSeqs.length; index += 1) {
    assert.ok(allSeqs[index] > allSeqs[index - 1], `账本里的 seq 必须严格递增：${allSeqs.join(" → ")}`);
  }
});

test("⑦契约中英成对：身份两键与投递时序逐字可查（改契约就得改这里，反之亦然）", async () => {
  // 工单判据：「契约里能逐字查到投递与账本 append 的先后」。散文钉在契约里，这里钉住**那两句原文**
  // 还在——把契约那两句删掉/改词（例如把时序改回「之后」）⇒ 本格红，不用等谁去通读 6000 行。
  const { readFileSync } = await import("node:fs");
  const en = readFileSync(new URL("../docs/host-consumer-contract.md", import.meta.url), "utf8");
  const cn = readFileSync(new URL("../docs/host-consumer-contract_cn.md", import.meta.url), "utf8");
  const pairs = [
    ["docs/host-consumer-contract.md", en, "Fold identity and delivery order (issue #567)"],
    ["docs/host-consumer-contract.md", en, "Delivery happens before the round record is appended (issue #567, contractual)"],
    ["docs/host-consumer-contract.md", en, "**before** `appendRound` writes the round record that carries `record.foldedFacts`"],
    ["docs/host-consumer-contract_cn.md", cn, "折叠身份与投递时序（issue #567）"],
    ["docs/host-consumer-contract_cn.md", cn, "投递发生在轮记录 append 之前（issue #567，属契约）"],
    ["docs/host-consumer-contract_cn.md", cn, "写下承载 `record.foldedFacts` 的那条轮记录**之前**"],
  ];
  for (const [rel, text, needle] of pairs) {
    assert.ok(text.includes(needle), `${rel} 少了这句契约原文（逐字）：${needle}`);
  }
  // 身份两键在契约里必须成对出现（中英各一次），否则「宿主拿 foldId / seq 对回被折轮次」只写在代码里。
  for (const [rel, text] of [["docs/host-consumer-contract.md", en], ["docs/host-consumer-contract_cn.md", cn]]) {
    assert.ok(text.includes("`foldId`") && text.includes("`seq`"), `${rel} 没有把 foldId / seq 写进契约`);
  }
});
