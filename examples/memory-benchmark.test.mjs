// 摘要保真度与 transcript 档案完整性（issue #257 T4 改造）。
//
// 现状如实：本用例**没有真模型调用链**——`runMemoryBenchmark()` 只做
// `loadRelayConfig()`（读配置文件，不发请求）+ `strategy.compact()` + `store.appendRound()`，
// 全文件 0 处 provider / `runToolLoop` 引用。它过去整条挂在 LLM_KIT_E2E=1 上，
// 属于「本来就该默认跑的被门控用例」，因此本文件**取消 skip**：
//   · 唯一的真机依赖（真实 `~/.pi/agent/models.json` 可读）在 exec-demo 的真机段里
//     已被更强的形态覆盖（那里逐槽位解析并断言 endpoint/apiKey/model 形状），故不在此重复；
//   · 断言面（折叠是否真发生、摘要足迹、foldedPayload 档案）全部是确定性的，默认段原样保留。
//
// 默认段同时钉住「它真的不联网」：注入的 fetch 桩一旦被打到就抛错，末尾再断言零命中。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryTranscriptStore } from "../src/index.js";
import { FACT, runMemoryBenchmark } from "./memory-benchmark.js";

const RELAY_ENV_KEYS = [
  "LLM_KIT_RELAY_PROVIDER",
  "LLM_KIT_RELAY_URL",
  "LLM_KIT_MODEL",
];
const OFFLINE_SLOT = "t4-offline-slot";

/**
 * 把 HOME 指向只装了 `.pi/agent/models.json` 的临时目录（字段名是 **baseUrl**，不是 endpoint），
 * 清掉 relay 提示变量，并把 globalThis.fetch 换成「一打就红」的桩：
 * 本用例是纯离线的，真发了请求就必须失败得看得见。
 */
async function withOfflineConfigHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "erix-membench-home-"));
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(
    join(home, ".pi/agent/models.json"),
    JSON.stringify({
      providers: {
        [OFFLINE_SLOT]: {
          baseUrl: "https://relay.invalid/v1",
          apiKey: "sk-fake-not-secret",
          models: [
            { id: "kimi-for-coding", maxTokens: 1024, contextWindow: 200_000 },
          ],
        },
      },
    }),
    "utf8",
  );

  const saved = {};
  for (const key of ["HOME", ...RELAY_ENV_KEYS]) saved[key] = process.env[key];
  const savedFetch = globalThis.fetch;
  let fetchHits = 0;
  process.env.HOME = home;
  for (const key of RELAY_ENV_KEYS) delete process.env[key];
  globalThis.fetch = () => {
    fetchHits += 1;
    throw new Error("memory-benchmark 是纯离线用例，不该发出任何网络请求");
  };
  try {
    return { ...(await fn()), fetchHits };
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}

test(
  "记忆基准（默认段·不联网）：fold-statistical 摘要保真且 foldedPayload 可找回",
  { timeout: 60_000 },
  async () => {
    const { result, store, runId, model, fetchHits } =
      await withOfflineConfigHome(() => runMemoryBenchmark());

    assert.equal(
      fetchHits,
      0,
      "纯离线用例一次网络请求都不该发（发了就说明它偷偷联网了）",
    );
    assert.ok(
      typeof model === "string" && model.length > 0,
      "model 来自配置解析，不得为空或写死",
    );

    assert.equal(result.strategy, "fold-statistical");
    assert.equal(result.shouldCompact, true, "测试输入应超过折叠预算");
    assert.ok(
      result.compactionStats.some((stat) => stat.compacted),
      "应真实发生折叠",
    );
    assert.ok(
      result.compactionStats[0].foldedRounds >= 1,
      "应折叠至少一个轮次",
    );

    // 摘要不需要包含原文事实，但必须保留可定位的轮次与工具足迹。
    assert.match(result.foldedSummary, /早期第 \d+–\d+ 轮（共 \d+ 轮）已折叠/u);
    assert.match(result.foldedSummary, /工具足迹：recordFact×1/u);

    // 折叠只改变上下文视图，原文必须仍在 transcript 的 foldedPayload 档案中。
    const transcript = await store.load(runId);
    const folded = transcript.find((record) => record.folded === true);
    assert.ok(folded, "store 应有 folded 记录");
    assert.ok(
      Array.isArray(folded.foldedPayload),
      "folded 记录应带 foldedPayload",
    );
    assert.deepEqual(folded.foldedPayload, result.foldedPayload);
    assert.match(
      JSON.stringify(folded.foldedPayload),
      new RegExp(FACT.text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
    );

    console.log(
      `[memory-benchmark] model=${model} verdict=PASS ` +
        `summary=${result.foldedSummary.slice(0, 120)}... ` +
        `payload=${folded.foldedPayload.length}`,
    );
  },
);

// 「调了不存在的方法」这类腐化（#257 里 `store.recall` 腐了三周）只有**真调用**才能当天抓住；
// 本用例的链路上没有模型，所以这一条把链路上真正被用到的方法名逐个钉成断言，
// 并把 0.8.0 退役的 `recall` 显式钉成「不存在」——两边都不许悄悄漂移。
test("记忆基准（默认段·形状与现役方法守卫）：store 与 strategy 的方法面", async () => {
  const store = createMemoryTranscriptStore();
  for (const method of ["appendRound", "load"]) {
    assert.equal(
      typeof store[method],
      "function",
      `基准链路依赖 store.${method}()，必须仍是函数`,
    );
  }
  assert.equal(
    store.recall,
    undefined,
    "recall 已在 0.8.0 契约中退役：本基准不得再指望它存在",
  );

  const { result } = await withOfflineConfigHome(() => runMemoryBenchmark());
  for (const field of [
    "strategy",
    "budgetTokens",
    "shouldCompact",
    "compactionStats",
    "foldedSummary",
    "foldedPayload",
  ]) {
    assert.ok(field in result, `基准返回缺少字段 ${field}`);
  }
  assert.ok(
    result.compactionStats[0].tokensBefore >
      result.compactionStats[0].tokensAfter,
    "折叠必须真的把 token 数降下来（否则「已折叠」只是自述）",
  );
  // 植入事实必须**具体到不可猜**（数值 + 日期 + 手册章节），否则「foldedPayload 里有原文」
  // 这条断言就会退化成恒真——随便一段占位文本都能过。
  assert.match(FACT.text, /42\.5%/u, "植入事实要含具体数值");
  assert.match(FACT.text, /\d{4}-\d{2}-\d{2}/u, "植入事实要含日期");
  assert.ok(
    FACT.text.includes("遥测服务") && FACT.text.includes("告警阈值"),
    `植入事实必须能由其关键词定位（keyword=${FACT.keyword}）：${FACT.text}`,
  );
});
