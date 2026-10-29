// issue #564：折叠摘要补取证力 —— 三处缺口各一组判据，全部走**真机形态**（不传 `stubFor`）。
//
// 缺口 1：TTL 句柄（`【已折叠·TTL】<工具名 + 关键入参>`，全角）进不了摘要（旧正则只认半角 `[已折叠]`）；
// 缺口 2：摘要只有 `name → count`（`exec×12`），没有“跑了什么命令 / 读了哪个路径”；
// 缺口 3：锚点抽取不读 `tool_use` 入参，于是 `exec git commit -m "…closes #123"` 里的 `#123` 全丢。
//
// 六格判据（issue 正文「判据（绿）」逐条）：
//   1. 摘要里出现命令/路径，而不只是 `exec×12`；
//   2. 被折内容里的 `【已折叠·TTL】exec git status` 作为 stub 进入摘要；
//   3. `exec git commit -m "…closes #123"` 被折走后，`#123` 出现在锚点节；
//   4. 清单节恒不超上界（≤8 条 / ≤80 字符/条）；
//   5. 折叠内容 >2048 字节时，区间行与清单仍存活（防“加了东西但被夹断吃掉”）；
//   6. 不传 `stubFor`（真机形态）也能拿到清单与 TTL 句柄。
//
// 文案纪律（#392 订正结论）：机械清单 ≠ 执行成功，摘要措辞不得出现判词（已提交/已完成/已交付）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TOOL_INVENTORY_CHARS,
  MAX_TOOL_INVENTORY_ENTRIES,
  createFoldStatisticalStrategy,
  summarizeFoldedPayload,
} from "../../src/compact/fold-statistical.js";
import {
  FOLDED_FACTS_MAX_BYTES,
  buildFoldedFacts,
} from "../../src/compact/fold-summary-journal.js";

const ttlLine = (command = "git status") => "【已折叠·TTL】exec " + command
  + "（约 4200 tokens，r1 读取）"
  + "— 后续需要时先用 note_list 查找，再用 note_read 读取；未记录且无法确定性重算时请省略，不要猜测"
  + "；要点见对话中已有笔记/结论";
const TTL_LINE = ttlLine();

const toolUse = (id, name, input) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input }],
});
const toolResult = (id, content) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }],
});

const summaryOf = (result) => result.messages[0].content[0].text;
const inventoryEntries = (summary) => {
  const lines = summary.split("\n");
  const heading = lines.findIndex((line) => line.startsWith("工具调用清单"));
  if (heading < 0) return [];
  const entries = [];
  for (const line of lines.slice(heading + 1)) {
    if (!line.startsWith("- ")) break;
    entries.push(line.slice(2));
  }
  return entries;
};

test("#564-1 摘要里有命令与路径，而不只是 exec×12（真机形态，不传 stubFor）", async () => {
  const messages = [
    { role: "user", content: "task" },
    toolUse("a", "exec", { command: "git status" }),
    toolResult("a", "clean"),
    toolUse("b", "readFile", { path: "src/compact/anchors.js", offset: 1, limit: 40 }),
    toolResult("b", "1: // hi"),
    { role: "user", content: "keep" },
  ];
  const summary = summaryOf(
    await createFoldStatisticalStrategy().compact(messages, { keepRounds: 1 }),
  );

  assert.match(summary, /工具足迹：exec×1, readFile×1/u, "计数仍在（既有口径不动）");
  assert.match(summary, /^工具调用清单（机械摘要，不代表执行成功）：$/mu);
  assert.match(summary, /^- exec git status$/mu);
  assert.match(summary, /^- readFile path=src\/compact\/anchors\.js offset=1 limit=40$/mu);
  // 清单不是「执行成功」的判词：措辞纪律（#392）。
  assert.doesNotMatch(summary, /已提交|已完成|已交付/u);
});

test("#564-2 被折内容里的 TTL 句柄作为 stub 进摘要，半角 [已折叠] 行为逐字不变", async () => {
  const messages = [
    { role: "user", content: "task" },
    toolUse("a", "exec", { command: "git status" }),
    toolResult("a", TTL_LINE),
    toolUse("b", "readFile", { path: "src/a.js" }),
    toolResult("b", "content"),
    { role: "user", content: "keep" },
  ];
  // ① 不传 stubFor：TTL 句柄必须自己进来（旧实现这里一条 stub 都没有）。
  const plain = summaryOf(
    await createFoldStatisticalStrategy().compact(messages, { keepRounds: 1 }),
  );
  assert.ok(plain.includes(TTL_LINE), `TTL 句柄必须逐字进摘要：${plain}`);
  // ② 传 stubFor：半角形态与全角形态并存，半角那条逐字不变。
  const hostStub = "[已折叠] 值：nonce=abc123；原文：/tmp/001-exec.txt";
  const withHost = summaryOf(
    await createFoldStatisticalStrategy().compact(messages, {
      keepRounds: 1,
      stubFor: () => hostStub,
    }),
  );
  assert.ok(withHost.includes(hostStub), "宿主 stub 逐字保留（既有行为不变）");
  assert.ok(withHost.includes(TTL_LINE), "TTL 句柄与宿主 stub 并存");
});

test("#564-3 exec git commit -m \"…closes #123\" 被折走后 #123 出现在锚点节", async () => {
  const messages = [
    { role: "user", content: "task" },
    toolUse("a", "exec", { command: 'git commit -m "feat(compact): 折叠摘要补取证力 (closes #123)"' }),
    // 前置：正文里**没有** #123 —— 锚点只能来自 tool_use 入参。
    toolResult("a", "1 file changed, 2 insertions(+)"),
    { role: "user", content: "keep" },
  ];
  const summary = summaryOf(
    await createFoldStatisticalStrategy().compact(messages, { keepRounds: 1 }),
  );

  assert.match(summary, /## 锚点索引（机械抽取，未经 LLM 改写）/u);
  assert.match(summary, /^issues: #123$/mu, `#123 必须从入参抽到锚点节：${summary}`);
  // 入参里的命令也进了清单（同一份入参，两个出口）。
  assert.match(summary, /^- exec git commit -m "feat\(compact\)/mu);
});

test("#564-4 清单节恒不超上界（≤8 条 × ≤80 字符），超长命令被夹断而不是撑爆", async () => {
  const messages = [{ role: "user", content: "task" }];
  for (let index = 1; index <= 12; index += 1) {
    messages.push(
      toolUse(`use-${index}`, "exec", {
        command: `echo ${index} ${"x".repeat(300)}`,
      }),
      toolResult(`use-${index}`, `out-${index}`),
    );
  }
  messages.push({ role: "user", content: "keep" });

  const summary = summaryOf(
    await createFoldStatisticalStrategy().compact(messages, { keepRounds: 1 }),
  );
  const entries = inventoryEntries(summary);

  assert.equal(MAX_TOOL_INVENTORY_ENTRIES, 8);
  assert.equal(MAX_TOOL_INVENTORY_CHARS, 80);
  assert.equal(entries.length, MAX_TOOL_INVENTORY_ENTRIES, "12 次调用只留 8 条");
  for (const entry of entries) {
    assert.ok(
      Array.from(entry).length <= MAX_TOOL_INVENTORY_CHARS,
      `每条 ≤${MAX_TOOL_INVENTORY_CHARS} 字符，实测 ${Array.from(entry).length}：${entry}`,
    );
  }
  // 夹断是「截断 + …」而不是把 300 字符原样塞进摘要。
  assert.ok(entries.every((entry) => entry.endsWith("…")));
  assert.doesNotMatch(summary, /x{120}/u, "超长命令不得原样进摘要");
});

test("#564-5 >2048 字节的折叠内容：区间行与清单仍存活（不被字节夹断吃掉）", async () => {
  const messages = [{ role: "user", content: "task" }];
  for (let index = 1; index <= 12; index += 1) {
    messages.push(
      toolUse(`use-${index}`, "exec", { command: `npm test -- --grep case-${index}` }),
      // 每条正文都带一条**不同**的 TTL 句柄（≈200 字符，去重后仍 10 条）：摘要必超 2048。
      toolResult(`use-${index}`, `${ttlLine(`npm test -- --grep case-${index}`)}\n${"y".repeat(64)}`),
    );
  }
  messages.push({ role: "user", content: "keep" });

  const summary = summaryOf(
    await createFoldStatisticalStrategy().compact(messages, { keepRounds: 1 }),
  );
  const summaryBytes = new TextEncoder().encode(summary).length;
  assert.ok(summaryBytes > FOLDED_FACTS_MAX_BYTES,
    `前置：摘要必须真的超过 ${FOLDED_FACTS_MAX_BYTES} 字节，实测 ${summaryBytes}`);

  const facts = buildFoldedFacts({
    text: summary,
    roundRange: { from: 1, to: 12 },
    rounds: 12,
  });
  assert.equal(facts.truncated, true, "前置：这一份必须真的被夹断");
  assert.ok(facts.bytes <= FOLDED_FACTS_MAX_BYTES, `夹断后 ≤ ${FOLDED_FACTS_MAX_BYTES}`);
  // 区间行（标题/范围句）与清单节都在被保留的前缀里。
  assert.match(facts.text, /早期第 1–12 轮（共 12 轮）已折叠/u);
  assert.match(facts.text, /工具足迹：exec×12/u);
  const kept = inventoryEntries(facts.text);
  assert.equal(kept.length, MAX_TOOL_INVENTORY_ENTRIES,
    `夹断后清单仍须 8 条齐活，实测 ${kept.length}：${facts.text}`);
  for (let index = 1; index <= MAX_TOOL_INVENTORY_ENTRIES; index += 1) {
    assert.ok(
      facts.text.includes(`- exec npm test -- --grep case-${index}`),
      `清单第 ${index} 条必须存活：${facts.text}`,
    );
  }
});

test("#564-6 真机形态（不传 stubFor）：清单与 TTL 句柄都拿得到（三条折叠路径同源）", async () => {
  const payload = [
    toolUse("a", "exec", { command: "git status" }),
    toolResult("a", TTL_LINE),
    toolUse("b", "readFile", { path: "src/compact/fold-statistical.js", offset: 10, limit: 5 }),
    toolResult("b", "10: export const x = 1;"),
  ];
  // ① fold-statistical 的 compact 产物（进消息流的那一份）。
  const compacted = summaryOf(await createFoldStatisticalStrategy().compact(
    [{ role: "user", content: "task" }, ...payload, { role: "user", content: "keep" }],
    { keepRounds: 1 },
  ));
  assert.ok(compacted.includes(TTL_LINE), "compact：TTL 句柄在场");
  assert.match(compacted, /^- readFile path=src\/compact\/fold-statistical\.js offset=10 limit=5$/mu);

  // ② summarizeFoldedPayload（fold-llm 降级 / sliding-window 落账同一套零件）。
  const summarized = summarizeFoldedPayload(payload, { from: 1, to: 2, count: 2 });
  assert.ok(summarized.includes(TTL_LINE), "summarizeFoldedPayload：TTL 句柄在场");
  assert.match(summarized, /^- exec git status$/mu);
  assert.match(summarized, /^- readFile path=src\/compact\/fold-statistical\.js offset=10 limit=5$/mu);
});
