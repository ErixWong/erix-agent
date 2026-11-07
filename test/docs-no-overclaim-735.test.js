// issue #735 切片 2 · **契约与 release notes 的禁语守卫**：被实测推翻并撤回的那句「大话」不许不改代码就写回去。
//
// 病根（本刀自己踩的，共三次）：这一片的前几版契约中英两份都写过同一句承诺——
//   「能省哪些格子是**被封顶**的……锚点之前每一格**按构造**就在账本里 ⇒ 没有这层封顶，那段只在内存里的
//     正文就会被置 `null` 而**真丢**」（`97daf82`），更早一版还写过「被省掉的那段前缀**按构造**就已经在账本里」。
// 并排探针把它否了（`6d98ac7`）：主干写整段、本支写残余，同一套两跳现场交出**逐字相同**的第二跳
// ⇒ 那段只在内存里的旧正文**无论怎么写都取不到**，`anchor` 是标量不是逐格位图。写侧封顶被撤回，
// 跨恢复的取回问题另开 **#754**。而撤回收尾时**中文契约漏删旧段**（新段插进旧段中间），
// `npm run check:docs` / `check:docs:strict` 全绿——它的中英对账量的是**标题骨架**与登记锚点，**不比散文**
// （#511 声称归属 / #553 逐字判词 / #668 退役语义 / #743 T12 开场全称是同一族）。
// 第 3 轮加了契约侧的守卫，第 4 轮评审又抓出两处：**CHANGELOG 里同一句大话（中文「把它留住」）**，以及
// 守卫自己的两个洞（**同义改写绕得过** + **一句注释就能把「封顶族」解禁**）。本文件把这三件一起钉住。
// 第 5 轮堵的是守卫自己的三个洞（meta 句自证 / 整句包反引号 / 只取首命中）。**第 6 轮**把 meta 名单里的
// 裸词「判据」摘掉——它是本仓库正文里的通用词，不是指涉守卫自身的词（口径与两条反向证见 META_MARKER 与 G7）。
// **第 7 轮**把「这条命中算不算在谈守卫自己」从**词表**升级成**提及 vs 使用**的判别：一把词表同时造两种错
// （它漏掉同义改写的复述句 = 假绿，又误伤顺带带上一个自我指涉词的真话句 = 假红），而「复述判据」这件事
// 其实有一个**结构信号**——**被引号整段包住的一个术语**。于是主判据换成 `mentionReason()`（G8 四条 RED/GREEN
// 各带退化对照），词表退居兜底；剩下那半个（**既不带引号、也不点名守卫机制的复述**）结构上无从判别，
// 登记成已知缺口并由 **G9** 钉住现状（那是 characterization，不是愿望）。
//
// 六条判据（口径：宁可窄而真）：
//   G0 扫描面在场：两份契约的「#735 切片 2」那一节 + CHANGELOG 里点名 `#735` 切片 2 的**中英两条条目**
//      （宿主读的就是 release notes，大话写在这里同样误导人）。标题/条目找不到 ⇒ 覆盖面静默消失 ⇒ 红。
//   G1 扫描面里不许出现被推翻并撤回的句式。禁语是**打地鼠**，所以它只是第一层。
//   G2 **肯定式判据**（#741 那条守卫用的同一招）：每一面都必须逐字留着那句诚实表述
//      （「读者永远读不到被省掉的格子」/ the reader never reads a slot that was elided /「永远读不到被置
//      null 的格子」）**和**「`anchor` 是标量、不是逐格位图」那半句——同义改写可以绕开禁语，绕不开这两句。
//   G3 **量词型断言禁令**：出现「每一格 / 所有格子 / 都」+「账本 / 入账」这类**全覆盖量词落在账本上的**
//      断言（EN：every/all slot + ledger/journal）⇒ 红。这是禁语表抓不到的那一层（「前缀已入账」
//      「无需逐格追踪」就是评审实测的绕法，两条都另设了专项禁语）。
//   G4 中英对齐是机器判据：契约那一节的 issue 引用集合两侧相等、字节账表的数字序列两侧逐字相等。
//   G5 反向证：每条禁语都必须咬住**撤回前**的原文（逐字取自 `97daf82` / `ee2fbfa` 的删除行），
//      咬不住 = 死条目 ⇒ 红（#210 R2「变异没落上就算失败」）；现树必须零命中。
//   G7 第 5 / 6 轮的自证：三个洞（meta 句顶替事实句 / 整句包反引号 / 只取首命中）+ meta 词表口径，各带退化对照。
//   G8 **提及 vs 使用**（第 7 轮）：命中被一段**术语级引号**整段包住 ⇒ 那是「提这个措辞」，既不算主张（G1/G3
//      豁免），也不满足在场（G2）；整句包进引号是**抄一句主张** ⇒ 使用，照扫。四条 RED/GREEN 各带一条
//      退化对照（不判引号 / 整句级豁免 / 引号内一律豁免 / 半个引号），并证现树上确有「只有结构这层认得出、
//      词表漏掉」的命中 ⇒ 这一层不是空转。
//   G9 **已知缺口（characterization）**：不带引号、也不点名守卫机制的复述句**判为使用**（算在场），
//      短术语包进引号的假主张**判为提及**（不算主张）。钉的是现状，理由是「提及」在这里没有任何结构信号。
//   G6 **代码真值是结构化的**：「恢复锚点封顶」那一族禁不禁，看的是 `resumeTranscriptAnchor` 有没有以
//      **真实代码形状**出现（`resumeTranscriptAnchor:` / `= resumeTranscriptAnchor` / `state.resumeTranscriptAnchor` /
//      `get resumeTranscriptAnchor(`），**注释里的名字不算**（判前先剥 `//` 与 `/* */`）。
//      ⇒ 一句注释关不掉这道闸；机制真落回代码时这一族自动解禁，并打一行 diagnostic 要求重测字节账。
//
// 扫描面刻意收窄：契约只圈那一节、CHANGELOG 只圈点名 `#735` 切片 2 的条目（整篇扫会误伤——`by construction`
// 在 EN 契约别处还有两处合法用法；CHANGELOG 里被禁的句子会以**引用**形式出现在反引号里，故 CHANGELOG 面
// 先剥掉行内代码再判，引用的禁语不算作者的主张）。零 LLM、零写盘、零子进程。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const CONTRACT = {
  en: {
    file: "docs/host-consumer-contract.md",
    heading: "#### The run snapshot's `messages` cell is round residue, not the transcript (issue #735 slice 2)",
  },
  cn: {
    file: "docs/host-consumer-contract_cn.md",
    heading: "#### run snapshot 的 `messages` 这一格是「轮残余」，不是整段正文（issue #735 切片 2）",
  },
};
const CHANGELOG_FILE = "CHANGELOG.md";
/** CHANGELOG 条目 = 以「- 」开头的 bullet；只认**标题行**点名切片 2 的那两条。 */
const ENTRY_HEAD = {
  en: /^- .*issue #735, slice 2.*$/um,
  cn: /^- .*issue #735，切片 2.*$/um,
};

/**
 * 两种规范化视图：`spaced` 折行压成一个空格（英文按原词序匹配）；`tight` 连空格与 `**` 一起删掉
 * （中文必须在这一面匹配——中文折行**不**插空格，「每一段正文 都还在」在 spaced 面会漏检，#553 F 组同族）。
 */
const spaced = (text) => text.replace(/\s+/gu, " ");
const tight = (text) => text.replace(/[\s*]+/gu, "");
/**
 * CHANGELOG 面：**术语级**行内代码豁免。被禁的措辞常以「引用」形式出现在反引号里（RED 证据清单），
 * 那不是作者的主张 ⇒ 剥掉。但整句假主张包进反引号不能免扫（第 5 轮评审抓的洞②）：只有
 * **不含句读**（`。；;!?…` 或英文 `.` + 空格 / 句末 `.`）且**长度 ≤ 60** 的片段才当引用，其余**保留照扫**。
 */
const TERM_SPAN_MAX = 60;
const SENTENCE_PUNCT = /[。；;!?…]|\.(\s|$)/u;
function stripInlineCode(text) {
  return text.replace(/`([^`\n]*)`/gu, (whole, inner) =>
    (inner.length <= TERM_SPAN_MAX && !SENTENCE_PUNCT.test(inner) ? "" : whole));
}
/** 术语级片段（第 5 轮的尺子，第 7 轮的引号判别复用同一把）：不含句读且长度 ≤ `TERM_SPAN_MAX`。 */
const isTermSpan = (inner) => inner.length <= TERM_SPAN_MAX && !SENTENCE_PUNCT.test(inner);
/** 剥注释（只用于 G6 的代码真值）：块注释与行注释。字符串里含 `//` 时会被多剥一点 ⇒ 方向保守（照样算「不在」）。 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

/** 真实代码形状：属性定义 / 赋值 / 读取 / 访问器。**注释里的裸名字不在这些形状里。** */
const CAP_SHAPES = [
  /\bresumeTranscriptAnchor\s*:/u, // 状态对象里的属性、或 `ctx.resumeTranscriptAnchor: value`
  /\bresumeTranscriptAnchor\s*=[^=]/u, // 赋值
  /[.\[]\s*resumeTranscriptAnchor\b/u, // 读取 `state.resumeTranscriptAnchor` / `ctx["…"]` 之外的点取
  /\b(?:get|set)\s+resumeTranscriptAnchor\s*\(/u, // 访问器
];
const CAP_TRUTH_FILES = ["src/loop/orchestrator.js", "src/loop/resume-manager.js"];

/** 代码真值：封顶机制是否以真实代码形状在场（G6）。 */
function capLandedInCode() {
  const code = CAP_TRUTH_FILES.map((rel) => stripComments(readFileSync(join(ROOT, rel), "utf8"))).join("\n");
  return CAP_SHAPES.some((shape) => shape.test(code));
}

/** 一条禁语：`where` 决定跑在哪一面；`family` 决定它是无条件禁还是随代码真值解禁。 */
const BANNED = [
  // —— 无条件禁：探针证明这与「封顶在不在」无关（写整段 / 写残余同结果）。
  { id: "en-by-construction", side: "en", where: "spaced", family: "always", surfaces: "all",
    re: /\bby construction\b/iu,
    why: "「按构造就在账本里」是 A1 的论证，`6d98ac7` 撤回" },
  { id: "en-never-loses", side: "en", where: "spaced", family: "always", surfaces: "all",
    re: /\b(?:lose|loses|losing|lost)\b[^.]{0,24}\b(?:information|the\s+body|bodies)\b|\b(?:never|cannot|can\s?not|will\s+not|won'?t|nothing\s+can)\b[^.]{0,24}\b(?:lose|loses|lost)\b|\bno\s+information\s+is\s+lost\b|\bnothing\s+is\s+lost\b/iu,
    why: "跨恢复的「不会丢信息」全称已被并排实测否掉（两棵第二跳逐字同结果）" },
  { id: "en-prefix-already-journaled", side: "en", where: "spaced", family: "always", surfaces: "all",
    re: /\b(?:the\s+)?(?:elided\s+)?prefix\b[^.]{0,40}\b(?:is\s+)?(?:already\s+)?journal\w*/iu,
    why: "同义改写（评审实测的绕法之一）：「前缀已入账」就是被撤回的那句，换个说法一样是假的" },
  { id: "en-keeps-it-alive", side: "en", where: "spaced", family: "always", surfaces: "all",
    re: /\b(?:keeps?|kept|keep(?:ing)?)\s+(?:it|that\s+body|the\s+body|that\s+slot)\b[^.]{0,24}\b(?:alive|intact|in\s+the\s+ledger|journaled)\b|\bis\s+exactly\s+what\b[^.]{0,60}\bkeeps\b/iu,
    why: "「那一项把它留住了」的英文同族：写侧没置 null ≠ 读侧取得到（后者是 #754）" },
  { id: "cn-by-construction", side: "cn", where: "tight", family: "always", surfaces: "all",
    re: /按构造/u, why: "同 en-by-construction" },
  { id: "cn-never-loses", side: "cn", where: "tight", family: "always", surfaces: "all",
    re: /不会丢信息|不会丢正文|信息不会丢|就不会丢|不会丢那段/u, why: "同 en-never-loses" },
  { id: "cn-prefix-already-journaled", side: "cn", where: "tight", family: "always", surfaces: "all",
    re: /前缀[^。；]{0,14}(?:已入账|已在账本|本来就?在账本|已经?入账)/u,
    why: "同义改写：「（那段）前缀已入账」＝被撤回的按构造断言" },
  { id: "cn-keeps-it", side: "cn", where: "tight", family: "always", surfaces: "all",
    re: /把它留住|把它保?住|保住了那段|那一项把它/u,
    why: "第 4 轮 BLOCK 的原句：中文 CHANGELOG 写过「正是 min(...) 那一项把它留住」——写侧没擦它而已" },
  // —— 条件禁：对面是**结构化**代码真值（G6）。
  { id: "en-anchor-cap", side: "en", where: "spaced", family: "cap", surfaces: "all",
    re: /\bresume\s+anchor\b|\banchor\s+cap\b|\bcapped?\s+at\s+(?:the\s+)?(?:resume\s+)?anchor\b/iu,
    why: "「恢复锚点封顶」的机制已随 `6d98ac7` 从代码里撤回" },
  { id: "en-cap-makes-it-safe", side: "en", where: "spaced", family: "cap", surfaces: "all",
    re: /\bthe\s+cap\b[^.]{0,60}\b(?:safe|security|makes)\b/iu,
    why: "「这个封顶正是省得安全的理由」是撤回那版的论证句" },
  { id: "en-no-need-to-track", side: "en", where: "spaced", family: "cap", surfaces: "all",
    re: /\b(?:never|no)\s+(?:has\s+to\s+need|has\s+to|need\s+to)?\s*track[^.]{0,30}per\s+slot|\bper\s+slot\b[^.]{0,30}\b(?:bitmap|track)/iu,
    why: "「不需要逐格追踪哪些格子已入账」只在有封顶时才成立（评审实测的另一条绕法）" },
  { id: "cn-anchor-cap", side: "cn", where: "tight", family: "cap", surfaces: "all",
    re: /恢复锚点|锚点封顶|按锚点封顶/u, why: "同 en-anchor-cap" },
  { id: "cn-cap-makes-it-safe", side: "cn", where: "tight", family: "cap", surfaces: "all",
    re: /封顶正是|这个封顶为何必要/u, why: "同 en-cap-makes-it-safe" },
  { id: "cn-no-need-to-track", side: "cn", where: "tight", family: "cap", surfaces: "all",
    re: /无[需不必]逐格追踪|不需要逐格追踪|逐格追踪/u,
    why: "同 en-no-need-to-track：这句的前提就是那层被撤回的封顶" },
];

/**
 * 量词型断言禁令（G3）：全覆盖量词落在「账本 / 入账」上 ⇒ 红。这是禁语表抓不到的那一层。
 * 唯一豁免：G2 要求的那句诚实表述本身（「not a promise that every body survives … journaled」里
 * every body + journaled 会顺带撞上正则），所以英文那一条带否定式 lookahead/behind——被否定掉的
 * 全称不是主张，是撤回声明。
 */
const QUANTIFIED = [
  { id: "en-quantified-ledger-claim", side: "en", where: "spaced",
    re: /(?<!not\s+a\s+promise\s+that\s+)\b(?:every|all|each)\s+(?:slot|body|bodies)\b[^.]{0,40}\b(?:ledger|journal)\w*/iu,
    why: "「每一格都在账本里」这类全覆盖断言（今天的真话只关于读者）" },
  { id: "cn-quantified-ledger-claim", side: "cn", where: "tight",
    re: /(?:每(?:一)?格|所有格子|全部格子)[^。；]{0,40}(?:账本|入账)/u,
    why: "同 en-quantified-ledger-claim" },
  { id: "cn-quantified-prefix-all", side: "cn", where: "tight",
    re: /(?:那些?格子|前缀)[^。；]{0,16}(?:都|全都|全部|本来就?|已经?)[^。；]{0,10}(?:在账本里|入账|落进账本)/u,
    why: "「被省掉的那段前缀（按构造）就已经在账本里」——`c87f591` 时代那句同一主张的另一种语序" },
];

/**
 * 「谈守卫本身」的句子（第 5 轮评审抓的洞①）：CHANGELOG 里**描述这条守卫**的那句会**逐字复述**判据要求的
 * 那句事实 ⇒ 「关于这句话的文字」顶替了「这句话本身」，G2 被守卫自己的说明喂饱（自证循环）。
 * 含这些词的句子是 meta 句，**不算**满足在场。
 *
 * 名单里只许放**指涉守卫自身**的词（第 6 轮）：裸词「判据」被摘掉了——它是本仓库正文里的**通用名词**
 * （「两跳恢复判据」「机器判据」都在说别的东西，不是这条守卫），留在名单里同时制造两种错：
 *   · **假红**：一句真话只要顺带提到「判据」，就被判成复述句 ⇒ 明明在场却不算在场；
 *   · **假绿**：一句假主张只要顺带提到它，就被当成「只是在提这个措辞」而误豁免（`realHits` 那条豁免）。
 * 指涉守卫自身的词照旧（`肯定式` / `必须逐字留着` / `禁语` / `本守卫` …——「肯定式判据」这类复合词由
 * `肯定式` 覆盖）。两个方向的反向证在 G7：把名单退化回「只有裸判据」⇒ 复述句立刻顶替事实句（洞重开），
 * 而提到「判据」的真话句在旧名单下判为不在场（假红）。
 */
const META_MARKER = /禁语|必须逐字留着|肯定式|本守卫|守卫自己|这条守卫|条件禁|无条件禁|自动解禁|那一族是|这一族是|\bG[0-9]\b|this\s+guard|the\s+guard\b|restat\w*|required\s+sentence|ban\s+list|\bfamily\b[^.]{0,20}\bbanned\b|is\s+banned\b/u;

/**
 * 「提及 vs 使用」的**结构**信号（第 7 轮的主判据）：成对的引号。
 * 反引号也算——CHANGELOG 面的术语级反引号已被 `stripInlineCode` 剥掉，剩下的反引号片段是整句型（算使用），
 * 所以这一条在 CHANGELOG 面只会更保守；契约面本来不剥行内代码，从此与 CHANGELOG 面同一口径。
 * 直双引号/反引号不跨行（`\n` 之内必须闭合）。**未闭合的半个引号不算引用**（不许拿一个 `「` 当逃生门）。
 * 单引号 `'` 故意不在表里：英文撇号会与它撞车（`that's`），造出的假 span 会把真主张吃掉。
 */
const QUOTE_PAIRS = [["「", "」"], ["『", "』"], ["“", "”"], ['"', '"'], ["`", "`"]];
const quoteCache = new Map(); // 视图文本 → 引号片段；扫描面很小（几 KB），缓存只为多次判定时不重复扫
function quoteSpansOf(text) {
  const cached = quoteCache.get(text);
  if (cached) return cached;
  const spans = [];
  for (const [open, close] of QUOTE_PAIRS) {
    let from = 0;
    for (;;) {
      const s = text.indexOf(open, from);
      if (s < 0) break;
      const e = text.indexOf(close, s + open.length);
      if (e < 0) break;                      // 没有闭合 ⇒ 这一种引号后面也无从配对
      const inner = text.slice(s + open.length, e);
      spans.push({ start: s, end: e + close.length, inner, termLevel: isTermSpan(inner) });
      from = e + close.length;               // 不嵌套：闭引号之后才找下一段
    }
  }
  if (quoteCache.size > 200) quoteCache.clear();
  quoteCache.set(text, spans);
  return spans;
}
/** 完整包住 [at, at+len) 的那段**术语级**引号（没有则 null）。命中跨过引号边界 ⇒ 不算被包住。 */
function quotedTermSpanWrapping(text, at, len) {
  return quoteSpansOf(text).find((s) => s.termLevel && s.start <= at && at + len <= s.end) ?? null;
}
/** 区间 [from, to) 里是否存在任何引号片段（退化实现「整句级豁免」用它，见 G8 的对照）。 */
const hasAnyQuoteSpanInside = (text, from, to) => quoteSpansOf(text).some((s) => s.start >= from && s.end <= to);

/** 肯定式判据（G2）：每面都必须留着的两句真话。 */
const REQUIRED = [
  { id: "reader-never-reads", sides: ["en", "cn"],
    en: { where: "spaced", re: /\b(?:the\s+reader\s+never\s+reads\s+a\s+slot\s+that\s+was\s+elided|never\s+reads\s+a\s+nulled\s+slot)\b/iu },
    cn: { where: "tight", re: /(?:读者永远读不到被省掉的格子|永远读不到被置null的格子)/u },
    why: "被证到的那一件事只关于读者" },
  { id: "scalar-not-bitmap", sides: ["en", "cn"],
    en: { where: "spaced", re: /a\s+scalar\s*\(?\s*(?:folded\s+)?message\s+count[^.]{0,60}?bitmap/iu },
    cn: { where: "tight", re: /标量[^。；]{0,30}位图/u },
    why: "`anchor` 是标量、不是逐格位图——#754 之所以归读侧的全部理由，这句必须在场" },
  { id: "not-a-promise", sides: ["en", "cn"],
    en: { where: "spaced", re: /\bnot\s+a\s+promise\s+that\s+every\s+body\s+survives\b/iu },
    cn: { where: "tight", re: /不是「每(?:一)?段正文[都还]能?跨?恢复?活?下来?」?的承诺|不是「每一段正文都还在」的承诺/u },
    why: "明说这不是「每一段正文都还在」的承诺" },
  { id: "names-754", sides: ["en", "cn"],
    en: { where: "spaced", re: /issue\s+#754/u },
    cn: { where: "tight", re: /issue#754/u },
    why: "跨恢复取不回旧正文归 #754" },
];

const docText = (rel) => readFileSync(join(ROOT, rel), "utf8");
const views = (body) => ({ spaced: spaced(body), tight: tight(body) });

/** 取契约的一节：标题必须恰好出现一次（缺失 = 覆盖面静默消失，>1 = 有人复制了节）。 */
function readContractSection(side) {
  const { file, heading } = CONTRACT[side];
  const text = docText(file);
  const hits = text.split(heading).length - 1;
  assert.equal(hits, 1,
    `${file} 里这一节的标题必须恰好出现一次（0 = 本守卫的覆盖面静默消失，>1 = 有人复制了节）：实测 ${hits}\n标题：${heading}`);
  const at = text.indexOf(heading);
  const rest = text.slice(at + heading.length);
  const next = rest.search(/\n#{2,4}\s/u);
  return { label: `${side}·契约`, file, heading, body: next < 0 ? rest : rest.slice(0, next) };
}

/** 取 CHANGELOG 里点名切片 2 的那一条（中英各一）。CHANGELOG 是 bullet 正文，先剥行内代码。 */
function readChangelogEntry(side) {
  const text = docText(CHANGELOG_FILE);
  const head = text.match(ENTRY_HEAD[side]);
  assert.ok(head,
    `${CHANGELOG_FILE} 里必须还有一条标题点名「issue #735 ${side === "en" ? "slice 2" : "切片 2"}」的条目（宿主读的就是 release notes；条目被改名 = 这一面静默脱离守卫）`);
  const at = head.index + head[0].length;
  const rest = text.slice(at);
  const next = rest.search(/\n- |##\s/u);
  return {
    label: `${side}·CHANGELOG`,
    file: CHANGELOG_FILE,
    heading: head[0].slice(0, 80),
    body: stripInlineCode(next < 0 ? rest : rest.slice(0, next)),
  };
}

/**
 * 「撤回标记」豁免：同一句里带着 `撤回 / 已撤 / reverted / no bound / 既不换来` 的，是**历史叙事**
 * （「实现过、测过、撤了，理由是……」），不是现状主张——与 `check:docs` 的 #668 退役语义、
 * `static-guards` 第 5 条的时态标记同一口径。豁免只按**句**算（窗口止于 `。；;!?` 与英文 `.` + 空格），
 * 把撤回标记写到别处不算；**且只对封顶族生效**——「按构造 / 不会丢信息 / 把它留住」那一族永不豁免。
 */
const RETRACTION_MARKER = /撤回|撤了|已撤|revert\w*|retract\w*|no\s+bound|既不换来/u;
const RETRACTABLE_FAMILIES = new Set(["cap"]);
const STOPS = "。；;!?…：:";

/** 命中所在的句子窗口（在中英混排的正文上按偏移取，不做整体切分，免得偏移错位）。 */
function windowBounds(flat, at, len) {
  const isBoundary = (i) => STOPS.includes(flat[i] ?? "")
    || (flat[i] === "." && /\s/u.test(flat[i + 1] ?? ""));
  let s = at;
  while (s > 0 && !isBoundary(s - 1)) s -= 1;
  let e = Math.min(flat.length, at + len);
  while (e < flat.length && !isBoundary(e)) e += 1;
  return [s, Math.min(flat.length, e + 1)];
}
const windowFor = (flat, at, len) => flat.slice(...windowBounds(flat, at, len));

/**
 * 一次命中是**提及**（在谈这个措辞）还是**使用**（主张这句话）。G1 禁语、G3 量词断言、G2 的「在场」
 * 共用这一个判定——同一个短语被引号包住时，不能一面算引用、另一面算主张。
 *   ① **结构**（第 7 轮的主判据）：命中被一段**术语级引号**整段包住 ⇒ 提及。尺子沿用第 5 轮那把
 *      （`TERM_SPAN_MAX` + `SENTENCE_PUNCT`）：整句包进引号是把一句主张抄一遍 ⇒ **使用**，照扫。
 *   ② **词表**（兜底）：同句点名守卫自身的机制（`META_MARKER`）⇒ 提及。词表换词就漏，故只作第二层；
 *      它自己造的那两种错（漏 = 假绿、误伤 = 假红）在 G7 / G9 里各有反向证。
 * 已知缺口（G9 钉住）：不带引号又不点名机制的复述句 ⇒ 这里判**使用**；短术语包进引号的假主张 ⇒ 判**提及**。
 * 两者都是「没有结构信号 / 结构信号与主张相反」的那半个问题，不是这里的实现缺陷。
 */
function mentionReason(text, at, len, window) {
  const span = quotedTermSpanWrapping(text, at, len);
  if (span) return `术语级引用「${span.inner}」`;
  if (META_MARKER.test(window)) return "同句在点名守卫自身的机制（词表兜底）";
  return null;
}
const mentionAt = (text, at, len) => mentionReason(text, at, len, windowFor(text, at, len));

/** 封顶族的命中若落在带撤回标记的句子里，就是历史叙事；其余一律算数。提及（引号内的术语 / 谈守卫自身）不算主张。 */
function realHits(rows, view) {
  return rows.filter((row) => {
    const text = view[row.rule.where];
    const window = windowFor(text, row.index, row.text.length);
    if (mentionReason(text, row.index, row.text.length, window)) return false;
    // 历史叙事：只有**封顶族**能被一句带的「撤回 / reverted / retracted」放过；「按构造 / 不会丢信息」那族永不豁免。
    if (!RETRACTABLE_FAMILIES.has(row.rule.family)) return true;
    return !RETRACTION_MARKER.test(window);
  });
}

const applicableBanned = (cap) => BANNED.filter((rule) => rule.family === "always" || !cap);
const withGlobal = (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);

/**
 * 全局扫描（第 5 轮评审抓的洞③）：非全局的 `match` 只看**首命中** ⇒ 被撤回的那句之后再加一句未撤回的断言
 * 就被遮蔽。这里每条规则的**每一处**命中各自成行（带偏移），豁免判定逐命中做。
 */
function scan(rules, view) {
  const rows = [];
  for (const rule of rules) {
    for (const m of view[rule.where].matchAll(withGlobal(rule.re))) {
      rows.push({ rule, text: m[0], index: m.index });
    }
  }
  return rows;
}

/** 肯定式判据的在场：至少要有一处命中落在**使用**（不是提及）的位置上（见 `mentionReason` / G8）。 */
function requiredPresent(rule, side, view) {
  const text = view[rule[side].where];
  return [...text.matchAll(withGlobal(rule[side].re))]
    .some((m) => !mentionAt(text, m.index, m[0].length));
}

// ── G0 扫描面在场（契约两节 + CHANGELOG 两条条目）─────────────────────────────

test("#735 切片2 · G0 四面都在（契约两节 + CHANGELOG 中英两条；改名 = 覆盖面静默消失 ⇒ 红）", (t) => {
  for (const side of ["en", "cn"]) {
    const contract = readContractSection(side);
    const entry = readChangelogEntry(side);
    assert.ok(contract.body.includes("`saveRunSnapshot`"), `${contract.file} 这一节必须还是讲 saveRunSnapshot 的 messages 格子`);
    assert.ok(contract.body.length > 400, `${contract.file} 这一节短得不像还写完了（${contract.body.length} 字符）`);
    assert.ok(entry.body.length > 400, `${entry.file} 那条 #735 条目短得不像还写完了（${entry.body.length} 字符）`);
    assert.match(entry.body, /persistRunSnapshot|残余|residue/u, `${entry.file} 那条必须真的还是讲这一片`);
    t.diagnostic(`${side}: 契约 ${contract.body.length} 字符 / CHANGELOG ${entry.body.length} 字符（已剥行内代码）`);
  }
});

// ── G1 禁语 ───────────────────────────────────────────────────────────────────

test("#735 切片2 · G1 撤回过的句式不许写回契约或 CHANGELOG（中英各一份；封顶族随结构化代码真值解禁）", (t) => {
  const cap = capLandedInCode();
  t.diagnostic(cap
    ? "封顶机制以真实代码形状在场 ⇒ 封顶族解禁；此时「按构造 / 不会丢信息 / 量词断言」仍禁，且必须重测字节账。"
    : "封顶族当前是禁的：`resumeTranscriptAnchor` 在 src/ 的**代码**里没有任何真实形状（注释里的名字不算，见 G6）。");
  const banned = applicableBanned(cap);
  for (const side of ["en", "cn"]) {
    for (const surface of [readContractSection(side), readChangelogEntry(side)]) {
      const view = views(surface.body);
      const hits = realHits(scan(banned.filter((rule) => rule.side === side), view), view);
      assert.deepEqual(hits.map((row) => row.rule.id), [],
        `${surface.label}（${surface.file}）里出现了被实测推翻并撤回的句式：\n`
        + hits.map((row) => `  · ${row.rule.id} 命中「${row.text}」——${row.rule.why}`).join("\n")
        + "\n要么改回实测口径（只声明「读者永不读到」+「写侧没擦它 ≠ 读侧取到」），要么把机制落回代码并给出新的实测。");
    }
  }
});

// ── G2 肯定式判据（同义改写绕得开禁语，绕不开这两句）─────────────────────────

test("#735 切片2 · G2 每面都必须逐字留着「读者永不读到」与「anchor 是标量、不是逐格位图」", () => {
  for (const side of ["en", "cn"]) {
    for (const surface of [readContractSection(side), readChangelogEntry(side)]) {
      const view = views(surface.body);
      const missing = REQUIRED.filter((rule) => rule.sides.includes(side))
        .filter((rule) => !requiredPresent(rule, side, view))
        .map((rule) => `${rule.id}（${rule.why}）`);
      assert.deepEqual(missing, [],
        `${surface.label}（${surface.file}）缺了必须留着的真话：${missing.join("、")}\n`
        + "禁语表只拦已知措辞；这两句不在场，就说明有人把窄口径改写成了别的说法（同义绕法）或整段删掉。\n"
        + "注意：只算**使用**——被引号整段包住的引用（「锚点封顶」这类术语级引用）与点名守卫自身的复述句都算**提及**，不算在场（见 G8 / `mentionReason`）—— 那是自证循环。");
    }
  }
});

// ── G3 量词型断言禁令 ─────────────────────────────────────────────────────────

test("#735 切片2 · G3 量词型断言（每一格/所有格子/都 + 账本/入账；every slot + ledger）⇒ 红", () => {
  for (const side of ["en", "cn"]) {
    for (const surface of [readContractSection(side), readChangelogEntry(side)]) {
      // 与 G1 共用同一个「提及 vs 使用」判定（第 7 轮）：把量词断言**引**出来当证据不算主张，写上去才算。
      const view = views(surface.body);
      const hits = realHits(scan(QUANTIFIED.filter((rule) => rule.side === side), view), view);
      assert.deepEqual(hits.map((row) => row.rule.id), [],
        `${surface.label}（${surface.file}）出现了「全覆盖量词落在账本上」的断言：\n`
        + hits.map((row) => `  · ${row.rule.id} 命中「${row.text}」——${row.rule.why}`).join("\n")
        + "\n今天没有这种资格：快照这格只声明「读者不会读到」，而「哪些下标真在账本里」需要逐格账，写侧没有（#754 的正身）。");
    }
  }
});

// ── G4 中英对齐（机器判据，不是承诺）────────────────────────────────────────

test("#735 切片2 · G4 中英对齐是机器判据：契约那一节的 issue 引用集合相等 + 字节账数字逐字相等", () => {
  const en = readContractSection("en");
  const cn = readContractSection("cn");
  const issues = (text) => [...new Set([...text.matchAll(/#(\d+)/gu)].map((m) => m[1]))].sort();
  const enIssues = issues(`${en.heading}\n${en.body}`);
  const cnIssues = issues(`${cn.heading}\n${cn.body}`);
  assert.deepEqual(cnIssues, enIssues,
    `两份契约同一节引用的 issue 号必须一模一样（一侧改了、另一侧落后一版就是第 3 轮的漂移形状）\nEN: ${enIssues.join(", ")}\nCN: ${cnIssues.join(", ")}`);
  const numbers = (body) => {
    const rows = body.split("\n").filter((line) => line.trimStart().startsWith("|"));
    assert.ok(rows.length >= 3, `这一节必须还带着那张字节账表（实测表格行 ${rows.length} 行）`);
    return rows.join("\n").match(/[\d.]+/gu) ?? [];
  };
  const enNums = numbers(en.body);
  assert.ok(enNums.length >= 20, `EN 表格里的数字序列短得不像还在对量（实测 ${enNums.length} 个）`);
  assert.deepEqual(numbers(cn.body), enNums, "字节账的数字序列两侧逐字相等");
});

// ── G5 反向证：禁语与量词判据必须咬得住撤回前的原文 ──────────────────────────

// 撤回**前**的原文，两个版本逐字取自 git 历史：`97daf82` 写进 / `ee2fbfa` 删掉的「锚点封顶」段，
// 以及它的前一版（`c87f591` 时代，被 `97daf82` 替换掉的「前缀按构造就已经在账本里」那句）。只当夹具用。
const RETRACTED = {
  en: [`Which slots may be elided is capped, and the cap is what makes the elision safe: the engine nulls
slots strictly below **this run's own resume anchor** (a run that never resumed: below min(round start,
messages it journaled itself)). Every slot below that anchor is in the ledger by construction — the
anchor *is* the number of message rows the ledger holds — so the engine never has to track, per slot,
whether a body reached disk. That cap matters: without the anchor cap those memory-only bodies would be
nulled out and lost; the term keeps the body intact, so nothing can lose information here.`,
    `The elided prefix is by construction already journaled (the engine journals each message as it
forms, issue 261021 slice 2, plus the #326 engine rows), and the only reader of this cell slices
messages.slice(anchor), so it never reads a slot that was elided.`],
  cn: [`能省哪些格子是被**封顶**的，而这个封顶正是省得安全的理由：引擎只会把**严格小于「本次 run 自己的恢复锚点」**的格子置 \`null\`。锚点之前每一格**按构造**就在账本里——于是引擎**不需要逐格追踪**某条正文是否真已落盘。没有锚点封顶，这段只在内存里的正文就会被置 \`null\` 而真丢；正是 \`min(...)\` 那一项把它留住了，按锚点封顶之后就**不会丢信息**了。`,
    `被省掉的那段前缀**按构造**就已经在账本里（引擎「一条消息一成型就落盘」，工单 261021 第二刀，外加 #326 的引擎补充行），而这格唯一的读者只切 \`messages.slice(anchor)\`，永远读不到被省掉的格子。`,
    `被置 null 的那些格子其实前缀已入账（引擎逐条落盘），所以无需逐格追踪，按锚点封顶就不会丢信息。`],
};

test("#735 切片2 · G5 反向证：每条禁语与量词判据都必须咬住撤回前的原文（咬不住 = 死条目 ⇒ 红）", (t) => {
  const cap = capLandedInCode();
  const fixtures = { en: RETRACTED.en.map(views), cn: RETRACTED.cn.map(views) };
  const dead = [];
  for (const rule of [...BANNED, ...QUANTIFIED]) {
    const bites = fixtures[rule.side].some((view) => view[rule.where].test
      ? false
      : view[rule.where].match(rule.re) !== null);
    if (!bites) dead.push(`${rule.id}（${rule.why}）`);
  }
  assert.deepEqual(dead, [], `这些判据在**撤回前的原文**上一条都没命中 ⇒ 它们是死条目，整条守卫在自欺：${dead.join("、")}`);
  const banned = applicableBanned(cap);
  for (const side of ["en", "cn"]) {
    const fixtureHits = RETRACTED[side].reduce((sum, body) => sum
      + realHits(scan(banned.filter((r) => r.side === side), views(body)), views(body)).length, 0);
    for (const surface of [readContractSection(side), readChangelogEntry(side)]) {
      const view = views(surface.body);
      const hits = realHits(scan(banned.filter((r) => r.side === side), view), view);
      assert.equal(hits.length, 0, `${surface.label} 现树应当零命中（G1 的复述）：${hits.map((h) => h.rule.id).join(", ")}`);
      t.diagnostic(`${surface.label}: 夹具命中 ${fixtureHits} 条禁语（含封顶族），现树命中 0 条`);
    }
  }
});

// ── G6 代码真值是结构化的：一句注释解不开这道闸 ──────────────────────────────

test("#735 切片2 · G6 封顶族只认**代码形状**：注释里写名字不算在场（三种状态各测一遍）", (t) => {
  const real = readFileSync(join(ROOT, "src", "loop", "orchestrator.js"), "utf8");
  // 状态①：现树——机制不在（撤回过）⇒ 封顶族必须在禁语表里。
  assert.equal(capLandedInCode(), false,
    "现树里 `resumeTranscriptAnchor` 不该以真实代码形状存在（`6d98ac7` 撤回）；若它回来了，本用例与 G1 的诊断都要一起重看");
  assert.ok(BANNED.some((r) => r.family === "cap"), "封顶族必须存在于禁语表里（不是被谁删掉的）");
  // 状态②：**只在注释里**提这个名字 ⇒ 仍算不在场（这正是评审抓的洞：一句注释就能解禁）。
  const commentOnly = `${real}\n// 历史：resumeTranscriptAnchor 曾在这里当过前缀上界（A1，已撤回）。\n`;
  assert.ok(/resumeTranscriptAnchor/u.test(commentOnly), "夹具必须真的含这个名字（否则这条反证是空的，#210 R2）");
  assert.ok(!CAP_SHAPES.some((shape) => shape.test(stripComments(commentOnly))),
    "剥掉注释后仍不该匹配到任何真实代码形状 ⇒ 注释里的出现**不能**解除封顶族的禁令");
  // 状态③：真实代码形状 ⇒ 判为在场（这一族会随代码自动解禁，G1 打 diagnostic）。
  const shapes = [
    "  const state = { resumeTranscriptAnchor: undefined };\n", // 属性定义
    "  state.resumeTranscriptAnchor = anchor;\n", // 赋值 + 点取读取
    "  get resumeTranscriptAnchor() { return 3; }\n", // 访问器
  ];
  for (const shape of shapes) {
    assert.ok(CAP_SHAPES.some((s) => s.test(shape)), `形状没被识别：${shape.trim()}`);
  }
  t.diagnostic("三态实测：现树 = 不在场（封顶族禁）；只加注释 = 仍不在场（禁）；属性/赋值/访问器三种真实形状 = 在场（解禁 + diagnostic）。");
});

// ── G7 三个洞的自证（第 5 轮评审：守卫不能自己糊弄自己）───────────────────────

test("#735 切片2 · G7 三个洞 + meta 名单口径的自证：meta 句不算事实句 / 整句包进反引号照扫 / 每一处命中各自判豁免", (t) => {
  const scalar = REQUIRED.find((rule) => rule.id === "scalar-not-bitmap");
  assert.ok(scalar, "REQUIRED 里必须还留着 scalar-not-bitmap 这条肯定式判据");
  // **洞①**：同一条目里「复述判据的 meta 句」不能顶替它引用的那句事实（第 4 轮的自证循环）。
  const metaOnly = "肯定式判据：必须逐字留着「`anchor` 是标量、不是逐格的位图」这一句。";
  const fact = "而 `anchor` 是一个**标量**（折叠后的消息条数）、不是逐格的位图 ⇒ 旧正文取不到。";
  assert.equal(requiredPresent(scalar, "cn", views(metaOnly)), false,
    "只剩「守卫说必须逐字留着 X」这一句时，X 不算在场 —— 关于这句话的文字不能顶替这句话本身");
  assert.equal(requiredPresent(scalar, "cn", views(fact)), true,
    "事实句自己在场时必须判为在场（豁免不能反向吃掉真话）");
  // **第 6 轮：meta 名单的口径**（两个方向各一条反向证，#210 R2）。名单里只许放**指涉守卫自身**的词：
  // 裸「判据」是本仓库正文里的通用名词（「两跳恢复判据」「机器判据」都在说别的东西），留在名单里会同时
  // 造出两种错——**假红**：真话句顺带提到它就判成复述；**假绿**：假主张顺带提到它就判成「只是在提措辞」。
  const BARE_ONLY = /判据/u; // 把名单退化回「只有裸判据」那一份，用来证明下面两条断言真咬在名单上
  const presentWithMarker = (marker, text) => {
    const flat = views(text).tight;
    return [...flat.matchAll(withGlobal(scalar.cn.re))]
      .some((m) => !marker.test(windowFor(flat, m.index, m[0].length)));
  };
  // ① **洞仍封得住**：摘掉裸词之后那句复述**照样**不算在场——封口的是 `肯定式` / `必须逐字留着` 这批指涉自身的词。
  assert.ok(/肯定式/u.test(metaOnly) && /必须逐字留着/u.test(metaOnly),
    "夹具必须真的带着指涉守卫自身的词（否则「洞封得住」是一条空转的反证，#210 R2）");
  assert.equal(presentWithMarker(META_MARKER, metaOnly), false,
    "现名单（已无裸「判据」）下复述句仍判为 meta ⇒ 不算在场：第 5 轮那个自证循环没有因为摘词而张回来");
  assert.equal(presentWithMarker(BARE_ONLY, metaOnly), true,
    "把名单退化回「只有裸判据」⇒ 复述句立刻顶替它引用的事实句（洞重开）——上面那条因此不是空转");
  // ② **假红消失**：一句**真话**顺带提到「判据」这个词，不再被当成 meta 句。
  const factNamingCriterion = "而这条判据要求的实测口径是 `anchor` 是一个**标量**（折叠后的消息条数）、不是逐格的位图。";
  assert.ok(/判据/u.test(factNamingCriterion), "夹具必须真的含裸词「判据」（这条反向证不能是空的）");
  assert.equal(requiredPresent(scalar, "cn", views(factNamingCriterion)), true,
    "真话句里出现通用词「判据」⇒ 算在场（摘词之前它被判成 meta，就是第 6 轮修掉的那记假红）");
  assert.equal(presentWithMarker(BARE_ONLY, factNamingCriterion), false,
    "带裸「判据」的旧名单把这句真话判成不在场 = 假红（上面那条的变异对照）");
  // **洞②**：行内代码只豁免**术语级**片段，整句假主张包进反引号照样扫。
  assert.equal(stripInlineCode("禁语表里 `按构造` 是引用。"), "禁语表里  是引用。",
    "短术语片段（引用禁语本身作 RED 证据）仍按引用剥掉");
  const wrapped = "说法：`被省掉的前缀都已入账，按锚点封顶保证跨恢复不会丢。`";
  assert.match(stripInlineCode(wrapped), /不会丢/u, "整句假主张包进反引号必须留在扫描面上");
  const wrappedHits = realHits(scan(BANNED.filter((rule) => rule.side === "cn"), views(stripInlineCode(wrapped))),
    views(stripInlineCode(wrapped)));
  assert.ok(wrappedHits.length >= 1, "整句假主张（包在反引号里）必须至少被一条禁语咬住");
  t.diagnostic(`整句假主张包进反引号后咬住它的禁语：${wrappedHits.map((row) => row.rule.id).join(" / ")}`);
  // **洞③**：全局扫描 + 逐命中豁免 —— 已撤回的那句遮蔽不了它后面那句未撤回的断言。
  const body = "为此实现并实测过一个「恢复锚点封顶」版本，已撤回：它既不换来正确性。恢复锚点封顶仍然成立。\n";
  const view = views(body);
  const rows = scan(BANNED.filter((rule) => rule.id === "cn-anchor-cap"), view);
  assert.equal(rows.length, 2, `两处命中都要被看见（只取首命中 = 后面的能被遮蔽；实测 ${rows.length} 处）`);
  const live = realHits(rows, view);
  assert.equal(live.length, 1,
    "第一处落在带「撤回」标记的句子（历史叙事，豁免），第二处未撤回 ⇒ 必须算数；实测算数 " + live.length + " 处");
  t.diagnostic("三洞自证 + 名单口径：meta 句不算在场（摘掉裸「判据」后仍封得住）/ 整句反引号照扫 / 每一处命中各自取句窗判豁免 / 提到「判据」的真话句不再被误判为不在场。");
});

// ── G8 提及 vs 使用：结构信号（引号）当主判据，词表退居兜底（第 7 轮）─────────────

test("#735 切片2 · G8 提及 vs 使用：引号内的术语级命中不算主张也不算在场（四条 RED/GREEN，各带退化对照）", (t) => {
  const scalar = REQUIRED.find((rule) => rule.id === "scalar-not-bitmap");
  const cap = BANNED.find((rule) => rule.id === "cn-anchor-cap");
  const quantifier = QUANTIFIED.find((rule) => rule.id === "cn-quantified-ledger-claim");
  assert.ok(scalar && cap && quantifier, "对照夹具要用的三条判据必须都还在（少一条 ⇒ 下面全是空转，#210 R2）");
  const flatOf = (text) => views(text).tight;
  const cnBanned = () => BANNED.filter((rule) => rule.side === "cn");

  // 三份**退化实现**：每份只坏在一处，而那些「坏处」正是本轮判据要排除的形状 —— 没有它们，下面的 GREEN
  // 就成了恒真断言（#210 R2「变异没落上就算失败」）。
  /** ① 只认词表（第 6 轮那份）：完全不判引号。 */
  const presentWordListOnly = (text) => {
    const flat = flatOf(text);
    return [...flat.matchAll(withGlobal(scalar.cn.re))]
      .some((m) => !META_MARKER.test(windowFor(flat, m.index, m[0].length)));
  };
  /** ② 整句级豁免：同一句里出现过引号 ⇒ 整句都当提及。 */
  const presentWindowQuote = (text) => {
    const flat = flatOf(text);
    return [...flat.matchAll(withGlobal(scalar.cn.re))]
      .some((m) => !hasAnyQuoteSpanInside(flat, ...windowBounds(flat, m.index, m[0].length)));
  };
  /** ③ 引号内一律豁免：不分术语级还是整句（第 5 轮洞②在引号轴上的翻版）。 */
  const wrappedByAnyQuote = (text, at, len) => quoteSpansOf(text).some((s) => s.start <= at && at + len <= s.end);

  // **RED/GREEN ①：引号内的复述 = 提及 ⇒ 不算在场**，而且这一条**词表根本够不着**（夹具里没有任何词表词）。
  const quotedRestat = "下一节写着「`anchor` 是标量、不是逐格的位图」。";
  assert.equal(META_MARKER.test(flatOf(quotedRestat)), false,
    "夹具必须不带任何自我指涉词（否则「封得住」是词表给的，不是在证引号判别）");
  assert.equal(presentWordListOnly(quotedRestat), true,
    "RED：只认词表时这句被算成事实句 ⇒ 复述顶替了它引用的那句事实（自证循环还开着）");
  assert.equal(requiredPresent(scalar, "cn", views(quotedRestat)), false,
    "GREEN：结构这层认出「被引号整段包住的一个术语」⇒ 提及，不满足在场");

  // **RED/GREEN ②：引号不许反向吃真话**——命中在引号外面就是使用，哪怕同一句里别处带着引号。
  const factWithStrayQuote = "那条「读者永不读到」的口径之外，`anchor` 是标量、不是逐格的位图，这是实测的。";
  assert.ok(hasAnyQuoteSpanInside(flatOf(factWithStrayQuote), 0, flatOf(factWithStrayQuote).length),
    "夹具必须真的带着一段引号（否则这条对照没有对象）");
  assert.equal(requiredPresent(scalar, "cn", views(factWithStrayQuote)), true,
    "GREEN：命中落在引号外面 ⇒ 使用 ⇒ 算在场");
  assert.equal(presentWindowQuote(factWithStrayQuote), false,
    "RED：「同句有引号就整句豁免」会把这句真话判成不在场 = 假红（第 6 轮摘裸词「判据」修的是同一族错）");

  // **RED/GREEN ③：整句包进引号是抄一句主张 = 使用 ⇒ 照扫**（第 5 轮洞②从反引号扩到引号，两侧都要成立）。
  const quotedClaim = "辩护词只有一句：「被省掉的前缀都已入账，按锚点封顶保证跨恢复不会丢。」";
  const flatClaim = flatOf(quotedClaim);
  const rowsClaim = scan(cnBanned(), views(quotedClaim));
  assert.ok(rowsClaim.length >= 1, "夹具必须真的被禁语咬住（否则下面两条对照是空的）");
  assert.equal(realHits(rowsClaim, views(quotedClaim)).length, rowsClaim.length,
    "GREEN：整句型引用不是术语级 ⇒ 一处都不许豁免");
  assert.equal(rowsClaim.filter((row) => !wrappedByAnyQuote(flatClaim, row.index, row.text.length)).length, 0,
    "RED：「引号内一律豁免」会把这句假主张整句吃掉 = 假绿");
  const quotedFullFact = "上一节写着「`anchor` 是标量、不是逐格的位图，旧正文因此取不到。」";
  assert.equal(requiredPresent(scalar, "cn", views(quotedFullFact)), true,
    "GREEN（同一尺子的反向）：整句型引用就是把那句真话抄了一遍 ⇒ 读者读到了 ⇒ 算在场");

  // **RED/GREEN ④：逐命中判，不整句判**——同一句里，引号里那处是提及，引号外那处是主张。
  const mixed = "「锚点封顶」这四个字之外，恢复锚点封顶仍然成立。";
  const viewMixed = views(mixed);
  assert.equal(META_MARKER.test(viewMixed.tight), false, "夹具不许带词表词（否则豁免是词表给的）");
  assert.equal(RETRACTION_MARKER.test(viewMixed.tight), false, "也不许带撤回标记（封顶族会被它豁免）");
  const rowsMixed = scan([cap], viewMixed);
  assert.equal(rowsMixed.length, 2, `同一句里两处命中都要看见（实测 ${rowsMixed.length}）`);
  assert.equal(realHits(rowsMixed, viewMixed).length, 1,
    "GREEN：引号内那处豁免、引号外那处算数；两处一起或一处都不算都是错的口径");
  assert.equal(rowsMixed.filter((row) => !META_MARKER.test(windowFor(viewMixed.tight, row.index, row.text.length))).length, 2,
    "RED：只认词表 ⇒ 两处都算主张（把引用当主张 = 假红）");
  assert.equal(rowsMixed.filter((row) => !hasAnyQuoteSpanInside(viewMixed.tight, ...windowBounds(viewMixed.tight, row.index, row.text.length))).length, 0,
    "RED：整句级豁免 ⇒ 两处都算提及（引号外那句主张被遮蔽 = 假绿）");

  // 顺带把同一口径接到 G3（量词断言）：引出来当证据不算主张，写上去才算。
  const quotedQuantifier = "上一版把它写成「每一格都在账本里」。";
  assert.equal(realHits(scan([quantifier], views(quotedQuantifier)), views(quotedQuantifier)).length, 0,
    "GREEN：被引号包住的量词断言是提及（CHANGELOG 里正是这样引 RED 证据的）");
  assert.equal(scan([quantifier], views("每一格都在账本里。")).length, 1,
    "RED 对照：同一句不引就是主张 ⇒ 必须咬住");

  // **现树实证**：这一层不是只活在夹具里。四面里确有「被术语级引号包住」的命中，且其中至少一处词表认不出来。
  let quotedMentions = 0;
  let structureOnly = 0;
  for (const side of ["en", "cn"]) {
    for (const surface of [readContractSection(side), readChangelogEntry(side)]) {
      const view = views(surface.body);
      for (const rule of [...BANNED.filter((r) => r.side === side), ...REQUIRED.filter((r) => r.sides.includes(side))]) {
        const spec = rule[side] ?? rule; // REQUIRED 的 re/where 挂在 rule[side] 上，BANNED 直接挂在 rule 上
        const text = view[spec.where];
        for (const m of text.matchAll(withGlobal(spec.re))) {
          if (!quotedTermSpanWrapping(text, m.index, m[0].length)) continue;
          quotedMentions += 1;
          if (!META_MARKER.test(windowFor(text, m.index, m[0].length))) structureOnly += 1;
        }
      }
    }
  }
  t.diagnostic(`现树四面里被术语级引号整段包住的命中 ${quotedMentions} 处，其中 ${structureOnly} 处词表认不出来`
    + "（这些就是第 7 轮补上的那一族；旧口径把它们当主张 / 当在场）。");
  assert.ok(structureOnly >= 1,
    "现树上必须至少留一处「只有结构认得出、词表漏掉」的引用命中；它消失了说明扫描面被改窄或文档被洗过 ⇒"
    + " 这一层只剩夹具能证，要么把那种命中请回来，要么在 CHANGELOG 里改口径并删掉这条断言");

  t.diagnostic("四条 RED/GREEN：① 引号内的复述不算在场（词表够不着）② 引号不吃引号外的真话 ③ 整句包引号照扫（两侧同尺）④ 逐命中判（引号内提及 / 引号外主张）；量词判据同口径。");
});

// ── G9 已知缺口：没有结构信号的「提及」判不出来（characterization，钉现状）──────

test("#735 切片2 · G9 已知缺口（characterization）：不带引号也不点名守卫的复述算在场；短术语包进引号的假主张算提及", (t) => {
  const scalar = REQUIRED.find((rule) => rule.id === "scalar-not-bitmap");
  const prefixClaim = BANNED.find((rule) => rule.id === "cn-prefix-already-journaled");
  assert.ok(scalar && prefixClaim, "两条缺口都要用到的判据必须还在");

  // **缺口①（假绿方向）**：复述既不带引号、也不点名守卫机制 ⇒ 结构上没有「提及」信号 ⇒ 按使用算 ⇒ 算在场。
  // 为什么不做成「红」：判它不在场要的是语义（这句是复述还是主张），而本守卫的口径是**零 LLM、只读字节**；
  // 硬要抓它只剩「再堆一张词表」，而词表正是第 6 / 7 轮实测会两头错的东西。读者在这一句里确实逐字读到了
  // 那句真话，所以按「读者能不能读到」的口径算它合规也是**真话**——只是它挡不住偷懒的写法。
  const unquotedRestat = "上一节还写着 anchor 是标量、不是逐格的位图，那是抄来的。";
  const flatUnquoted = views(unquotedRestat).tight;
  assert.ok(scalar.cn.re.test(flatUnquoted), "夹具必须真的命中肯定式判据（否则这条 characterization 是空的）");
  assert.equal(META_MARKER.test(flatUnquoted), false, "夹具必须不带词表词——缺口①说的正是词表也漏的那一族");
  assert.equal(requiredPresent(scalar, "cn", views(unquotedRestat)), true,
    "现状：判为在场（已知缺口）。要翻这条断言，先拿出一个不是词表的判别信号");
  // 词表这一层仍然兜住「点名守卫机制」的那一类复述 ⇒ 两层并存，第 7 轮没有把兜底拆掉。
  const namesMachinery = "守卫要求正文里必须逐字留着 anchor 是标量、不是逐格的位图。";
  assert.ok(/必须逐字留着/u.test(namesMachinery), "夹具必须真的点名守卫机制（否则下面那条是空转）");
  assert.equal(requiredPresent(scalar, "cn", views(namesMachinery)), false,
    "兜底层仍在：点名「必须逐字留着」的复述不算在场");

  // **缺口②（假绿方向，禁语侧）**：短术语包进引号的假主张 ⇒ 判提及 ⇒ 不算主张。这与第 5 轮对反引号
  // 已经接受的口径同一条（`按构造` 引出来当 RED 证据不算主张），代价是同一种躲法在引号轴上也照样有效。
  const quotedFalseClaim = "正文里现在写「前缀已入账」。";
  const rowsQuoted = scan([prefixClaim], views(quotedFalseClaim));
  assert.equal(rowsQuoted.length, 1, `命中必须存在（实测 ${rowsQuoted.length}）——否则「豁免掉了什么」无从谈起`);
  assert.equal(realHits(rowsQuoted, views(quotedFalseClaim)).length, 0,
    "现状：引号内的短术语按提及豁免（已知缺口）；把整句写进引号就不再豁免，见 G8 的 RED/GREEN ③");
  const unquotedSameClaim = "正文里现在写前缀已入账。";
  assert.equal(realHits(scan([prefixClaim], views(unquotedSameClaim)), views(unquotedSameClaim)).length, 1,
    "对照：同一句不包引号就算主张 ⇒ 上面那条豁免确实是引号给的，不是这条禁语咬不住");

  t.diagnostic("两个缺口钉的是现状：① 无引号 + 不点名守卫的复述 ⇒ 算在场（结构上没有信号，词表也漏）；"
    + "② 短术语包进引号的假主张 ⇒ 算提及而放过（与第 5 轮反引号同口径）。两者都不是本刀能零 LLM 判出来的那一类。");
});
