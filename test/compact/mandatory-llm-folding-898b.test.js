// @ts-check
// issue #898 第二刀：折叠**必须由 LLM 完成**——删掉「显式选一个零 LLM 机械策略」这条退路。
//
// 四格判据（内存 store + fake provider，零真实 LLM / 零网络 / 零 ~/.erix）：
//   ① 没有策略就报错：`runToolLoop` 不传任何压缩策略、也不传 summarizer ⇒ 抛 `KitError`
//      （code `compaction_strategy_required`），不许再静默退回引擎库层的机械 `sliding-window`。
//   ② 有 summarizer 就正常折：给 `createFoldLlmStrategy({ summarizer })` ⇒ 折叠真的发生、
//      摘要正文来自 summarizer（不是机械拼接的工具足迹）。
//   ③ 预算兜底可检测：构造「LLM 折完仍然超预算」的场景 ⇒ 落账里**出现**降级标记
//      `foldedFacts.degradeReason === "budget_fallback_mechanical"`，且**正常折叠时该标记缺席**
//      （两个对象的 `foldedFacts` 用 `deepStrictEqual` 必须不等 ⇒ 落账形状可区分）。
//   ④ CLI 不再认 `--compaction`：子进程 `chat --compaction sliding-window` ⇒ 非 0 退出 + 文案含
//      「未知」；`config.compaction` 同理（直接走 `bin/config.js` 的 `loadCliConfig` 断言）。
//
// 反向证（基点 72bd9a92 上逐格先红）：① ③ ④ 在基点红（无脑退机械折叠 / 无 degradeReason 标记 /
// CLI 还认 `--compaction`），② 是回归闸（基点与改后皆绿，钉「LLM 折叠仍然真的发生」）。

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { KitError } from "../../src/providers/errors.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import { FOLDED_FACTS_RECORD_FIELD } from "../../src/compact/fold-summary-journal.js";
import { BUILTIN_COMPACTION_STRATEGY_NAMES } from "../../src/compact/strategy-resolution.js";
import { loadCliConfig } from "../../bin/config.js";
import { runDirect } from "../helpers/run-direct.js";
import { createFakeProvider } from "../helpers/fake-provider.js";

const execFileAsync = promisify(execFile);

/** 每轮正文用**可辨认**的标记（`M<n> CONTENT`），「哪一轮被折掉」因此是逐字的，不靠计数。 */
function makeContent(chars) {
  const body = "lorem ipsum dolor sit amet ".repeat(Math.ceil(chars / 27));
  return (index) => `M${index} CONTENT ${body}`;
}

/** `rounds` 轮逐段 readFile（入参各不同，避开 #608 的同入参循环判据）+ 一轮收尾文本。 */
function toolProvider(rounds) {
  return createFakeProvider([
    ...Array.from({ length: rounds }, (_unused, index) => ({
      content: [{
        type: "tool_use",
        id: `t${index}`,
        name: "readFile",
        input: { path: `docs/mod${index}.md` },
      }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" },
  ]);
}

/**
 * 跑一次带预算的 run。`strategy` 缺席 ⇒ 宿主既没给策略也没给 summarizer（①的现场）。
 * @param {{ budgetTokens: number, rounds: number, chars: number, keepRounds?: number,
 *   strategy?: object, runId: string }} options
 */
async function runFold(options) {
  const { budgetTokens, rounds, chars, keepRounds, strategy, runId } = options;
  const content = makeContent(chars);
  const store = createMemoryTranscriptStore();
  const result = await runDirect({
    provider: toolProvider(rounds),
    seed: "Read every docs/mod*.md fully (one readFile each), then summarise.",
    executeTool: async ({ input }) => content(
      Number(input?.path?.match(/mod(\d+)/u)?.[1] ?? 0),
    ),
    store,
    runId,
    config: {
      folding: {
        context: {
          budgetTokens,
          ...(keepRounds === undefined ? {} : { keepRounds }),
        },
      },
      run: { maxRounds: rounds + 2, completion: false, outputHygiene: { limit: 300_000 } },
    },
    ...(strategy === undefined ? {} : { capabilities: { ports: { strategy } } }),
  });
  const records = await store.load(runId);
  /** @type {Array<Record<string, unknown>>} 落在轮记录上的折叠事实（一折一条，旧→新）。 */
  const facts = records
    .filter((record) => record[FOLDED_FACTS_RECORD_FIELD] !== undefined)
    .flatMap((record) => record[FOLDED_FACTS_RECORD_FIELD]);
  return { result, facts };
}

// ── ① 没有策略就报错 ────────────────────────────────────────────────────────────────
test("#898-① 无策略且无 summarizer 时超预算折叠必须抛 KitError（不许静默退回机械折叠）", async () => {
  // 票面现场形状：可折轮数 ≤ 默认 keepRounds ⇒ 若还留着机械兜底，它会「悄悄折好」而不报错。
  await assert.rejects(
    () => runFold({ budgetTokens: 12_000, rounds: 2, chars: 19_000, runId: "898b-no-strategy" }),
    (error) => {
      assert.ok(error instanceof KitError, `必须是 KitError，实际 ${error?.name}`);
      assert.equal(error.code, "compaction_strategy_required", "错误码必须是装配错误专用码");
      assert.match(
        error.message,
        /compaction requires an LLM folding strategy/u,
        "文案必须说清折叠必须由 LLM 完成",
      );
      assert.match(
        error.message,
        /provide a compactionStrategy|compactionStrategy|summarizer/u,
        "文案必须点名宿主需提供 compactionStrategy 或 summarizer",
      );
      return true;
    },
  );
});

// ── ② 有 summarizer 就正常折 ─────────────────────────────────────────────────────────
test("#898-② 配 createFoldLlmStrategy({ summarizer }) ⇒ 折叠发生且摘要来自 summarizer", async () => {
  let summarizerCalls = 0;
  const strategy = createFoldLlmStrategy({
    summarizer: async () => {
      summarizerCalls += 1;
      // 正文里带一个可辨认的标记 ⇒ 「摘要到底是谁写的」是逐字可证的，不靠调用计数。
      return `LLMFOLD-MARKER ${"summary word ".repeat(60)}`;
    },
  });
  const { facts } = await runFold({
    budgetTokens: 2_500, rounds: 12, chars: 700, keepRounds: 2,
    strategy, runId: "898b-llm-fold",
  });

  assert.ok(summarizerCalls >= 1, `摘要器必须真被调用（实际 ${summarizerCalls} 次）`);
  assert.ok(facts.length >= 1, "折叠必须真的落账（轮记录上出现 foldedFacts）");
  assert.ok(
    facts.some((fact) => typeof fact.text === "string" && fact.text.includes("LLMFOLD-MARKER")),
    "折叠替代物里必须出现 summarizer 写的那一份，而不是机械工具足迹",
  );
});

// ── ③ 预算兜底可检测（marker present vs normal absent）───────────────────────────────
test("#898-③ 预算兜底的机械折叠只在真发生时落账，且与正常折叠的落账形状可区分", async () => {
  // 预算兜底现场：可折轮数 ≤ keepRounds ⇒ LLM 折不动、兜底最后手段把轮次折掉（机械）。
  const fallback = await runFold({
    budgetTokens: 12_000, rounds: 2, chars: 19_000,
    strategy: createFoldLlmStrategy({ summarizer: async () => "unused LLM SUMMARY" }),
    runId: "898b-budget-fallback",
  });
  const degradedFacts = fallback.facts
    .filter((fact) => fact.degradeReason === "budget_fallback_mechanical");
  assert.ok(
    degradedFacts.length >= 1,
    "预算兜底真折时落账必须带 degradeReason=budget_fallback_mechanical（可检测）",
  );

  // 正常 LLM 折叠现场：兜底没动手 ⇒ 同一份标记必须**缺席**。
  const normal = await runFold({
    budgetTokens: 2_500, rounds: 12, chars: 700, keepRounds: 2,
    strategy: createFoldLlmStrategy({ summarizer: async () => `LLMFOLD-MARKER ${"summary word ".repeat(60)}` }),
    runId: "898b-normal-fold",
  });
  assert.ok(normal.facts.length >= 1, "正常折叠也必须落账");
  assert.ok(
    normal.facts.every((fact) => fact.degradeReason !== "budget_fallback_mechanical"),
    "正常 LLM 折叠不得出现机械兜底的降级标记",
  );

  // 落账形状可区分：把两份 foldedFacts 摆到一起，`deepStrictEqual` 必须**不等**。
  assert.notDeepStrictEqual(
    degradedFacts[0],
    normal.facts[0],
    "「预算兜底机械折」与「正常折叠」的 foldedFacts 必须在形状上分得开",
  );
});

// ── ④ CLI / config 不再认 compaction 入口 ────────────────────────────────────────────
test("#898-④a bin/cli.js chat --compaction 报未知参数并非 0 退出", async () => {
  const cliPath = new URL("../../bin/cli.js", import.meta.url).pathname;
  let exitedWith = 0;
  try {
    await execFileAsync(process.execPath, [cliPath, "chat", "hi", "--compaction", "sliding-window"], {
      env: { ...process.env, ERIX_CONFIG: "/nonexistent-erix-config.json" },
    });
  } catch (error) {
    exitedWith = typeof error?.code === "number" ? error.code : 1;
    const blob = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
    assert.match(blob, /未知/u, "CLI 必须按未知参数报错并点名");
    assert.match(blob, /--compaction/u, "报错必须点名被删的旗标");
  }
  assert.notEqual(exitedWith, 0, "chat --compaction 必须非 0 退出");
});

test("#898-④b loadCliConfig 传 config.compaction 按未知键报错", async () => {
  const directory = await mkdtemp(join(tmpdir(), "erix-898b-config-"));
  const configPath = join(directory, "config.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({ slots: { default: { endpoint: "https://x.invalid", apiKey: "k", model: "m", compaction: "fold-statistical" } } }),
      "utf8",
    );
    await assert.rejects(
      () => loadCliConfig({ configPath }),
      (error) => {
        assert.match(error.message, /未知/u, "必须按未知 config 字段报错");
        assert.match(error.message, /compaction/u, "必须点名 compaction");
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ── 附带：策略名可选项已收口为唯一默认 fold-llm ──────────────────────────────────────
test("#898 内置可显式选择的策略名只剩 fold-llm（零 LLM 的两个可选项已退）", () => {
  assert.deepEqual([...BUILTIN_COMPACTION_STRATEGY_NAMES].sort(), ["fold-llm"]);
});
