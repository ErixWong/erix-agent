// issue #595（可观测面诚实性）：契约的**加法事件表** ↔ `LoopEvent` 的 `type` 联合，这两份清单
// 以前**没有任何东西看守**。
//
// 病根不是「少写一个名字」那一下手滑：`continuity_injection_skipped` 在 `src/loop/orchestrator.js`
// 的 `recordContinuitySkip` 里真的发，契约的加法事件表里也真有它那一行，而 `LoopEvent.type` 收了
// 同族的 `compaction_deferred`（#588）却没收它 —— 于是宿主照发布的类型写 `switch`，那个分支
// **永远不可达**，而且没有任何门禁会为此变红。单点补名字治不了这一类，所以本文件钉的是**对账**：
//
//   C1 清单**从契约现推**（不手抄）：逐行解析契约里「`` `名字` event `` / `` `名字` stat ``」形态的
//      行，取它的**名字列**，再与同一行的载荷字面量 `type: "…"` 交叉核对（自相矛盾就红）。
//   C2 清单里**每一个**名字都必须出现在 `LoopEvent` 的 `type` 联合里，缺哪个点名哪个。
//   C3 解析失败**就报**：取不到表 / 取到 0 行 ⇒ 红（本仓「读不到真值就红」的既有规矩）。
//   C0 抽取器自测：合成 Markdown 上「该抽的抽到、非事件行不抽、载荷与名字不一致能看出来、
//      空文档触发 C3」，防上面三条退化成恒绿。
//
// 反向证明（实测见交付报告）：把契约表里某一行的事件名从**类型联合**里删掉 ⇒ C2 红并点名它；
// 往契约表里加一个假事件名 ⇒ C2 也红（证明清单真的是从契约取来的，不是硬编码列表）；还原 ⇒ 绿。
//
// 零 LLM、零写盘、不碰真实 `~/.erix`：只读两份文本（契约 + orchestrator 的 JSDoc）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CONTRACT_URL = new URL("../docs/host-consumer-contract.md", import.meta.url);
const ORCHESTRATOR_URL = new URL("../src/loop/orchestrator.js", import.meta.url);

/**
 * 从契约里抽「加法事件表」的行。
 *
 * 判据只看表格行的**第一列**：`` `compaction_deferred` event `` / `` `compaction` stat ``。
 * 为什么用名字列而不是「正文里出现 `type: "…"` 的行」：正文里提到事件名的地方太多
 * （叙述段、别的表的 `Present on` 列），那种口径抽出来的不是清单，是关键词命中。
 *
 * 每一行再带上它载荷里出现的 `type: "…"` 字面量，供调用方交叉核对（名字列 vs 载荷）。
 *
 * ⚠ **抽不动就报，不许跳**：第一列长得像事件行（`` `…` event `` / `` `…` stat ``）但名字不是
 * `snake_case` 时，那一行进 `problems` 而不是被静默丢下——「解析器看不见的行」与「没有那一行」
 * 在结果上是同一个绿，而前者恰恰是这道闸会漏掉的真名字（首版写成 `[a-z_]+` 时，
 * `fake_event_for_595_probe` 这种带数字的名字就被静默跳过了，反向变异因此没变红）。
 *
 * @param {string} markdown
 * @returns {{rows: Array<{name: string, kind: string, payloadTypes: string[], line: string}>, problems: string[]}}
 */
function additiveEventRows(markdown) {
  const rows = [];
  const problems = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|");
    const first = (cells[1] ?? "").trim();
    const candidate = /^`([^`]+)`\s+(event|stat)$/u.exec(first);
    if (candidate === null) continue;
    const [name, kind] = [candidate[1], candidate[2]];
    if (!/^[a-z][a-z0-9_]*$/u.test(name)) {
      problems.push(`第一列长得像事件行，但名字 \`${name}\` 不是 snake_case（解析器抽不动，不许静默跳过）: ${line.slice(0, 120)}`);
      continue;
    }
    const payloadTypes = [...line.matchAll(/type:\s*"([a-z][a-z0-9_]*)"/gu)].map((match) => match[1]);
    rows.push({ name, kind, payloadTypes, line });
  }
  return { rows, problems };
}

/**
 * 取清单，**取不到就红**：空表 / 抽不动的行 / 结构变了都不许静默变绿。
 *
 * @param {string} markdown
 * @param {string} label 报错时点名来源（自测用它区分「合成样本」与「真契约」）
 * @returns {Array<{name: string, kind: string, payloadTypes: string[], line: string}>}
 */
function eventRowsOrFail(markdown, label) {
  const { rows, problems } = additiveEventRows(markdown);
  assert.deepEqual(problems, [], `${label}：契约里有抽不动的事件行 —— 判据不许在这种时候变绿`);
  assert.ok(
    rows.length > 0,
    `${label}：从契约里取到 0 条事件行 —— 表格结构变了或解析器坏了。判据不许在这种时候变绿`
      + "（读不到真值就红，本仓既有规矩）",
  );
  return rows;
}

/** 抽 `LoopEvent` 的 `type` 联合成员（逐字取自 `@property {"a"|"b"|…} type` 那一行）。 */
function loopEventTypeUnion(source) {
  const typedefAt = source.indexOf("@typedef {object} LoopEvent");
  assert.notEqual(typedefAt, -1, "`orchestrator.js` 里必须还有 `@typedef {object} LoopEvent`——抽不到就等于判据在空转");
  const unionLine = /@property \{((?:"[a-z][a-z0-9_]*"\|?)+)\} type/u.exec(source.slice(typedefAt));
  assert.notEqual(unionLine, null, "`LoopEvent` 里必须还有 `@property {\"…\"|\"…\"} type` 这一行");
  return unionLine[1].split("|").map((member) => member.replaceAll("\"", ""));
}

// ================================================================ C0
// 抽取器自测（house 口径同 `test/static-guards.test.js` 的 `--self-test` 一族：规则表本身也要被钉）。
const SAMPLE = [
  "| Field | Present on | Contract |",
  "|---|---|---|",
  "| `runId` | every `onJudge` record and the `run_outcome` event | join key |",
  "| `compaction` stat | `onEvent` (`type: \"compaction\"`) | existing keys unchanged |",
  "| `compaction_deferred` event | `onEvent`, one per deferred compaction | `{ type: \"compaction_deferred\", runId?, round }` |",
  "| `broken` event | `onEvent` | `{ type: \"something_else\" }` |",
  "| `fakeEvent595` event | `onEvent` | `{ type: \"fakeEvent595\" }` |",
  "",
  "Not a table row: `round_start` event",
].join("\n");

test("C0 抽取器自测：名字列抽到、非事件行不抽、抽不动的行进 problems、载荷与名字不一致可发现、空文档触发「取不到就红」", () => {
  const { rows, problems } = additiveEventRows(SAMPLE);
  assert.deepEqual(
    rows.map((row) => `${row.name}:${row.kind}`),
    ["compaction:stat", "compaction_deferred:event", "broken:event"],
    "只认「`名字` event/stat」形态的第一列：`runId` 那种字段行与正文句都不算",
  );
  assert.deepEqual(rows[0].payloadTypes, ["compaction"], "载荷里的 `type:` 字面量必须抽出来（供交叉核对）");
  assert.deepEqual(rows[2].payloadTypes, ["something_else"], "名字列与载荷不一致的那一行必须能被看出来");
  assert.equal(problems.length, 1, "非 snake_case 的事件名必须进 problems（静默跳过 = 这道闸漏一个真名字）");
  assert.match(problems[0], /fakeEvent595/u, "problems 必须点名抽不动的那一行");

  assert.throws(
    () => eventRowsOrFail("# 没有表格\n\n纯散文。\n", "自测"),
    /取到 0 条事件行/u,
    "空表必须红——否则表格被改名/搬走后这道闸会静默变绿",
  );
  assert.throws(
    () => eventRowsOrFail(SAMPLE, "自测"),
    /抽不动的事件行/u,
    "抽不动的行也必须让取清单失败（不是「跳过它继续」）",
  );
});

// ================================================================ C1 / C2 / C3
test("C1 契约加法事件表 → `LoopEvent.type`：表里每个事件名都必须在联合里（缺哪个点名哪个）", () => {
  const rows = eventRowsOrFail(readFileSync(CONTRACT_URL, "utf8"), "契约");
  const union = new Set(loopEventTypeUnion(readFileSync(ORCHESTRATOR_URL, "utf8")));

  // 前提：这单的主体事件必须真的在清单里。不在 ⇒ 契约表丢了那一行（或解析口径漏了它），
  // 下面的「⊆」会变成一句空话。
  assert.ok(
    rows.some((row) => row.name === "continuity_injection_skipped"),
    `契约加法事件表里必须还有 \`continuity_injection_skipped\` 那一行（实测清单 ${JSON.stringify(rows.map((row) => row.name))}）`,
  );

  // 名字列 vs 载荷字面量：同一行自相矛盾 ⇒ 红（两份清单已经对不上了，别再往后判）。
  const contradictory = rows
    .filter((row) => row.payloadTypes.length > 0 && row.payloadTypes.some((name) => name !== row.name))
    .map((row) => `${row.name}（载荷写的是 ${row.payloadTypes.join(" / ")}）`);
  assert.deepEqual(contradictory, [], `契约行自相矛盾（名字列与载荷的 type 不是同一个）: ${contradictory.join("；")}`);

  const missing = rows.map((row) => row.name).filter((name) => !union.has(name)).sort();
  assert.deepEqual(
    missing,
    [],
    "契约加法事件表里有、`LoopEvent.type` 里没有的事件名（宿主照发布的类型写 `switch`，这些分支永远不可达）: "
      + missing.join(" / "),
  );
});
