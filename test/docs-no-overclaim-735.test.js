// @ts-check
// issue #735 切片 2 · **契约禁语守卫**：被实测推翻并撤回的那句「大话」不许不改代码就写回契约。
//
// 病根（本刀自己踩的）：这一片的前一版契约中英两份都写过同一句承诺——
//   「能省哪些格子是**被封顶**的……锚点之前每一格**按构造**就在账本里 ⇒ 没有这层封顶，那段只在内存里
//     的正文就会被置 `null` 而**真丢**」（`97daf82`），更早一版还写过「被省掉的那段前缀**按构造**就已经
//   在账本里」（`c87f591` 时代）。
// 而并排探针把它否了（`6d98ac7`）：主干写整段、本支写残余，同一套两跳现场交出**逐字相同**的第二跳
// ⇒ 那段只在内存里的旧正文**无论怎么写都取不到**，`anchor` 是标量不是逐格位图。写侧的封顶被撤回，
// 跨恢复的取回问题另开 **#754**。
//
// 撤回收尾时中文那份**漏删了旧段**（新段插进了旧段中间，两份一度说的不是同一句话），而
// `npm run check:docs` / `check:docs:strict` **全绿**——它的中英对账量的是**标题骨架**与登记过的锚点，
// 抓不到「这句关于恢复的承诺今天还成立吗」，也抓不到「一侧改了、另一侧落后一版」。这正是仓内已经认过的
// 那一族（#511 声称归属 / #553 逐字判词 / #668 退役语义 / #743 T12 开场全称）：**散文没人管**。
//
// 本文件补这一格，四条判据（口径：宁可窄而真）：
//   G0 两节都**在场**（标题被改名 = 覆盖面静默消失 ⇒ 红），且每份文档里该标题恰好出现一次。
//   G1 两节的正文里都**不许**出现撤回过的句式（禁语表，逐条写死「为什么它今天是假的」）。
//      其中「封顶」那一族是**条件禁**：对面是代码真值——`resumeTranscriptAnchor` 已随 `6d98ac7` 从
//      `src/loop/orchestrator.js` 消失，所以契约里再出现「恢复锚点封顶」就是空头承诺；哪天真把机制
//      落回代码，这一族会**随代码解禁**并打一行 diagnostic 提醒重测。另一族（「按构造 / 不会丢信息」）
//      **无条件禁**：探针证明它与封顶在不在无关。
//   G2 两节都必须**留着**那句诚实表述（「读者永不读到」+「不是每一段正文都还在的承诺」+ `#754`）——
//      否则「把整段删掉」也算合规，守卫就退化成只会拦加法。
//   G3 **中英对齐是机器判据**：同一节引用的 issue 号集合两侧相等、字节账表的数字序列两侧逐字相等、
//      两侧都得留着「并排实测」那一幕。本轮的漂移（CN 落后一版）正是这一条抓的形状。
//   G4 **守卫自己不是恒绿**：把撤回**前**的旧文案（逐字取自 git 历史 `97daf82` / `ee2fbfa` 的删除行）
//      当夹具喂给同一套禁语谓词，每一条禁语都必须真的咬住它；一条都咬不住 ⇒ 红（#210 R2：变异没落上
//      就算失败，不许静默变绿）。
//
// 零 LLM、零写盘、零子进程：只读两份契约文档与 `src/loop/orchestrator.js` 的源码文本。
// 扫描面**只圈这两节**（不是整份契约）：`by construction` 在 EN 契约别处还有两处合法用法（#498 的
// 闭集枚举、`…:ttl:<fp>` 那一族的 `messages: []`），整篇禁会误伤；圈节是「窄而真」的那一半。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** 被守卫的两节（标题就是扫描面的边界；改名 ⇒ G0 红）。 */
const SECTIONS = {
  en: {
    file: "docs/host-consumer-contract.md",
    heading: "#### The run snapshot's `messages` cell is round residue, not the transcript (issue #735 slice 2)",
  },
  cn: {
    file: "docs/host-consumer-contract_cn.md",
    heading: "#### run snapshot 的 `messages` 这一格是「轮残余」，不是整段正文（issue #735 切片 2）",
  },
};

/**
 * 两种规范化视图（同一份文本，两种匹配面）：
 *   `spaced` 折行压成一个空格 ⇒ 英文句子按原词序匹配；
 *   `tight`  连空格与 `**` 一起删掉 ⇒ 中文必须在这一面匹配（中文折行**不**插空格，
 *            在 `spaced` 面上「每一段正文 都还在」会漏检——#553 的 F 组就是这类错位）。
 */
const spaced = (text) => text.replace(/\s+/gu, " ");
const tight = (text) => text.replace(/[\s*]+/gu, "");

/** 一条禁语：`where` 决定它跑在哪一面；`family` 决定它是无条件禁还是随代码真值解禁。 */
const BANNED = [
  // —— 无条件禁：探针证明这与「封顶在不在」无关（写整段 / 写残余同结果）。
  { id: "en-by-construction", side: "en", where: "spaced", family: "always",
    re: /\bby construction\b/iu,
    why: "「按构造就在账本里」是 A1 的论证，已撤回（#754：anchor 是标量、不是逐格位图）" },
  { id: "en-never-loses", side: "en", where: "spaced", family: "always",
    re: /\b(?:lose|loses|losing|lost)\b[^.]{0,24}\b(?:information|the\s+body|bodies)\b|\b(?:never|cannot|can\s?not|will\s+not|won'?t|nothing\s+can)\b[^.]{0,24}\b(?:lose|loses|lost)\b|\bno\s+information\s+is\s+lost\b|\bnothing\s+is\s+lost\b/iu,
    why: "跨恢复的「不会丢信息」全称已被并排实测否掉（两棵第二跳逐字同结果）" },
  { id: "en-all-bodies-survive", side: "en", where: "spaced", family: "always",
    re: /(?<!not\s+a\s+promise\s+that\s+)\b(every|all|each)\s+(slot|body|bodies)\b[^.]{0,40}\b(survives?|in\s+the\s+ledger|journaled)\b/iu,
    why: "「每一格都在账本里」这一族正是被撤回的那句承诺（今天的真话只关于读者；「not a promise that every body survives」那句否定式写法不在禁内）" },
  { id: "cn-by-construction", side: "cn", where: "tight", family: "always",
    re: /按构造/u,
    why: "同 en-by-construction：A1 的论证，`6d98ac7` 撤回" },
  { id: "cn-never-loses", side: "cn", where: "tight", family: "always",
    re: /不会丢信息|不会丢正文|信息不会丢|就不会丢/u,
    why: "同 en-never-loses：跨恢复的全称承诺" },
  { id: "cn-all-bodies-survive", side: "cn", where: "tight", family: "always",
    re: /每一格都在账本里|锚点之前每一格/u,
    why: "同 en-all-bodies-survive" },
  // —— 条件禁：对面是代码真值 `resumeTranscriptAnchor`（撤回后已从 src/ 消失）。
  { id: "en-anchor-cap", side: "en", where: "spaced", family: "cap",
    re: /\bresume\s+anchor\b|\banchor\s+cap\b|\bcapped?\s+at\s+(the\s+)?(resume\s+)?anchor\b/iu,
    why: "「恢复锚点封顶」这一机制已被 `6d98ac7` 撤回；机制不在代码里时，契约提它=空头承诺" },
  { id: "en-cap-makes-it-safe", side: "en", where: "spaced", family: "cap",
    re: /\bthe\s+cap\b[^.]{0,60}\b(safe|security|makes)\b/iu,
    why: "「这个封顶正是省得安全的理由」是撤回那版的论证句" },
  { id: "cn-anchor-cap", side: "cn", where: "tight", family: "cap",
    re: /恢复锚点|锚点封顶|按锚点封顶/u,
    why: "同 en-anchor-cap" },
  { id: "cn-cap-makes-it-safe", side: "cn", where: "tight", family: "cap",
    re: /封顶正是|这个封顶为何必要/u,
    why: "同 en-cap-makes-it-safe" },
];

/** 两节都必须留着的诚实表述（缺一条 ⇒ G2 红）。 */
const REQUIRED = [
  { id: "en-reader-never-reads", side: "en", where: "spaced",
    re: /\bthe\s+reader\s+never\s+reads\s+a\s+slot\s+that\s+was\s+elided\b/iu,
    why: "被证到的那一件事只关于读者" },
  { id: "en-not-a-promise", side: "en", where: "spaced",
    re: /\bnot\s+a\s+promise\s+that\s+every\s+body\s+survives\b/iu,
    why: "明说这不是「每一段正文都还在」的承诺" },
  { id: "en-names-754", side: "en", where: "spaced",
    re: /issue\s+#754/u, why: "跨恢复取不回旧正文归 #754" },
  { id: "en-side-by-side", side: "en", where: "spaced",
    re: /\bmeasured\s+side\s+by\s+side\b/iu, why: "两侧同结果的实测现场要在场" },
  { id: "cn-reader-never-reads", side: "cn", where: "tight",
    re: /读者永远读不到被省掉的格子/u, why: "同 en-reader-never-reads" },
  { id: "cn-not-a-promise", side: "cn", where: "tight",
    re: /不是「每一段正文都还在」的承诺/u, why: "同 en-not-a-promise" },
  { id: "cn-names-754", side: "cn", where: "tight",
    re: /issue#754/u, why: "同 en-names-754" },
  { id: "cn-side-by-side", side: "cn", where: "tight",
    re: /并排实测/u, why: "同 en-side-by-side" },
];

/** 代码真值：封顶机制在不在树上，决定 `cap` 那一族禁不禁。 */
const capLandedInCode = () => readFileSync(join(ROOT, "src", "loop", "orchestrator.js"), "utf8")
  .includes("resumeTranscriptAnchor");

const docText = (/** @type {string} */ rel) => readFileSync(join(ROOT, rel), "utf8");

/** 取一节：从标题到下一个标题；标题缺失或出现多次 ⇒ 当场红（覆盖面不许静默变化）。 */
function readSection(/** @type {keyof typeof SECTIONS} */ side) {
  const { file, heading } = SECTIONS[side];
  const text = docText(file);
  const hits = text.split(heading).length - 1;
  assert.equal(hits, 1,
    `${file} 里这一节的标题必须恰好出现一次（出现 0 次 = 本守卫的覆盖面静默消失，>1 = 有人复制了节）：实测 ${hits} 次\n标题：${heading}`);
  const at = text.indexOf(heading);
  const rest = text.slice(at + heading.length);
  const next = rest.search(/\n#{2,4}\s/u);
  const body = next < 0 ? rest : rest.slice(0, next);
  return { file, heading, body, title: heading };
}

const views = (/** @type {string} */ body) => ({ spaced: spaced(body), tight: tight(body) });

const findHits = (
  /** @type {{ id: string; side: string; where: string; re: RegExp; why: string }[]} */ rules,
  /** @type {{ spaced: string; tight: string }} */ view,
) => rules
  .map((rule) => ({ rule, hit: view[/** @type {"spaced" | "tight"} */ (rule.where)].match(rule.re) }))
  .filter((row) => row.hit !== null);

// ── G0 扫描面在场 ─────────────────────────────────────────────────────────────

test("#735 切片2 · G0 两份契约都还有这一节（改名 / 复制 = 覆盖面静默变化 ⇒ 红）", () => {
  for (const side of /** @type {(keyof typeof SECTIONS)[]} */ (["en", "cn"])) {
    const section = readSection(side);
    assert.ok(section.body.includes("`saveRunSnapshot`"),
      `${section.file} 的这一段必须真的还是讲 saveRunSnapshot 的 messages 格子（节选错了 ⇒ 后面三条都是空的）`);
    assert.ok(section.body.length > 400,
      `${section.file} 的这一段短得不像还写完了（实测 ${section.body.length} 字符）`);
  }
});

// ── G1 禁语 ───────────────────────────────────────────────────────────────────

test("#735 切片2 · G1 撤回过的句式不许写回契约（中英各一份；封顶族随代码真值解禁）", (t) => {
  const cap = capLandedInCode();
  const applicable = BANNED.filter((rule) => rule.family === "always" || !cap);
  if (!cap) {
    t.diagnostic("封顶族（anchor cap / 恢复锚点）当前是禁的：`resumeTranscriptAnchor` 不在 `src/loop/orchestrator.js` 里（6d98ac7 撤回）。");
  } else {
    t.diagnostic("封顶机制又落回代码了 ⇒ 封顶族自动解禁，但「按构造 / 不会丢信息」那一条仍然禁，且必须重测字节账再更新本节。");
  }
  for (const side of /** @type {(keyof typeof SECTIONS)[]} */ (["en", "cn"])) {
    const section = readSection(side);
    const view = views(section.body);
    const hits = findHits(applicable.filter((rule) => rule.side === side), view);
    assert.deepEqual(hits.map((row) => `${row.rule.id}: …${String(row.hit?.[0])}…`), [],
      `${section.file} 的「#735 切片 2」这一节里出现了被实测推翻并撤回的句式：\n`
      + hits.map((row) => `  · ${row.rule.id} 命中「${String(row.hit?.[0])}」——${row.rule.why}`).join("\n")
      + "\n要么把句子改回实测口径（只声明「读者永不读到」），要么先把机制落回代码并给出新的实测。");
  }
});

// ── G2 诚实表述必须在场（防「删掉就算合规」）─────────────────────────────────

test("#735 切片2 · G2 「读者永不读到 + 不是承诺 + #754 + 并排实测」这四句中英两侧都得留着", () => {
  for (const side of /** @type {(keyof typeof SECTIONS)[]} */ (["en", "cn"])) {
    const section = readSection(side);
    const view = views(section.body);
    const missing = REQUIRED.filter((rule) => rule.side === side)
      .filter((rule) => !view[/** @type {"spaced" | "tight"} */ (rule.where)].match(rule.re))
      .map((rule) => `${rule.id}（${rule.why}）`);
    assert.deepEqual(missing, [],
      `${section.file} 的「#735 切片 2」这一节少了诚实表述：${missing.join("、")}\n`
      + "禁语表只拦加法；这几句不在场，就说明有人把「窄承诺」整段删了却想让守卫闭嘴。");
  }
});

// ── G3 中英对齐（机器判据，不是承诺）────────────────────────────────────────

test("#735 切片2 · G3 中英对齐是机器判据：issue 引用集合相等 + 字节账数字逐字相等", () => {
  const en = readSection("en");
  const cn = readSection("cn");
  const issues = (/** @type {string} */ text) =>
    [...new Set([...text.matchAll(/#(\d+)/gu)].map((m) => m[1]))].sort();
  const enIssues = issues(`${en.heading}\n${en.body}`);
  const cnIssues = issues(`${cn.heading}\n${cn.body}`);
  assert.deepEqual(cnIssues, enIssues,
    `两份契约同一节引用的 issue 号必须一模一样（一侧改了、另一侧落后一版就是本轮的漂移形状）\nEN: ${enIssues.join(", ")}\nCN: ${cnIssues.join(", ")}`);

  // 字节账表：两侧的**数字序列**逐字相等（本轮 CN 落后一版时，这一条正是会红的那条）。
  const numbers = (/** @type {string} */ body) => {
    const rows = body.split("\n").filter((line) => line.trimStart().startsWith("|"));
    assert.ok(rows.length >= 3, `这一节必须还带着那张字节账表（实测表格行 ${rows.length} 行）`);
    return rows.join("\n").match(/[\d.]+/gu) ?? [];
  };
  const enNums = numbers(en.body);
  const cnNums = numbers(cn.body);
  assert.ok(enNums.length >= 20, `EN 表格里的数字序列短得不像还在对量（实测 ${enNums.length} 个）`);
  assert.deepEqual(cnNums, enNums,
    `字节账的数字序列两侧逐字相等（EN ${enNums.length} 个 / CN ${cnNums.length} 个）：\n`
    + `EN: ${enNums.join(" ")}\nCN: ${cnNums.join(" ")}`);
});

// ── G4 反向证：禁语表必须真咬得住撤回前的原文 ────────────────────────────────

// 撤回**前**的两段旧文案，逐字取自 git 历史：EN = `97daf82` 写进、`ee2fbfa` 删掉的那一段；
// CN = 同一处中文（`ee2fbfa` 的删除行 + 本刀从 CN 契约里删掉的那段，两边逐字相同）。
// 它们只当夹具用（不进扫描面），作用是让「守卫今天绿」不等于「守卫恒绿」。
const RETRACTED = {
  en: `Which slots may be elided is capped, and the cap is what makes the elision safe: the
engine nulls slots strictly below **this run's own resume anchor** (a run that never resumed:
below \`min(round start, messages it journaled itself)\`). Every slot below that anchor is in the
ledger by construction — the anchor *is* the number of message rows the ledger holds — so the
engine never has to track, per slot, whether a body reached disk. That cap matters: on a resumed
run the journaled counter is seeded from \`messages.length\`, so without the anchor cap those
memory-only bodies would be nulled out and lost. Nothing can lose information here.`,
  cn: `能省哪些格子是被**封顶**的，而这个封顶正是省得安全的理由：引擎只会把**严格小于「本次 run 自己的恢复锚点」**的格子置 \`null\`（没恢复过的 run：小于 \`min(本轮起点, 本进程亲手落盘的条数)\`）。锚点之前每一格**按构造**就在账本里——锚点的定义就是「账本里的正文行数」——于是引擎**不需要逐格追踪某条正文是否真已落盘**。这个封顶为何必要：没有锚点封顶，这段只在内存里的正文就会被置 \`null\` 而真丢，按锚点封顶之后就**不会丢信息**了。`,
};

test("#735 切片2 · G4 反向证：每一条禁语都必须咬住撤回前的原文（咬不住 = 死条目 ⇒ 红）", (t) => {
  const cap = capLandedInCode();
  const fixtures = { en: views(RETRACTED.en), cn: views(RETRACTED.cn) };
  const dead = [];
  for (const rule of BANNED) {
    const view = fixtures[/** @type {"en" | "cn"} */ (rule.side)];
    if (!view[/** @type {"spaced" | "tight"} */ (rule.where)].match(rule.re)) {
      dead.push(`${rule.id}（${rule.why}）`);
    }
  }
  assert.deepEqual(dead, [],
    `这些禁语在**撤回前的原文**上一条都没命中 ⇒ 它们是死条目，整条守卫在自欺：${dead.join("、")}`);
  // 同一套谓词喂今天的两节必须零命中（G1 已断言，这里再钉一次「夹具红 / 现树绿」的对照）。
  for (const side of /** @type {(keyof typeof SECTIONS)[]} */ (["en", "cn"])) {
    const section = readSection(side);
    const hits = findHits(BANNED.filter((rule) => rule.side === side && (rule.family === "always" || !cap)),
      views(section.body));
    assert.equal(hits.length, 0, `${section.file} 现树应当零命中（G1 的复述）：${hits.map((h) => h.rule.id).join(", ")}`);
    t.diagnostic(`${side}: 夹具命中 ${BANNED.filter((r) => r.side === side).length} 条禁语，现树命中 0 条`);
  }
});
