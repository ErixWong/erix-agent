// issue #553 —— 契约里**逐字引用的引擎判词**必须与运行时真值**逐字相等**（不是"文档里有这串"）。
//
// 病根（#551 落地时实测撞上，属 #511「文档声称归属」那一族）：契约中英两份里有**用代码块 / 行内代码
// 逐字引用**的引擎判词。#551 把运行时判词换成"点名载荷新家"的句子之后，文档里那段还是旧的一句，
// 而 `npm run check:docs` 与 `check:docs:strict` **全绿**——`paths` / `markers` 这类锚点只问
// 「这串在文档里存在吗」，**不问它是否还等于运行时真值**。宿主照文档抄到的是引擎早就不说的句子。
//
// 本文件把那条缺口钉成机器判据。三条纪律（工单 §要求 2 / §不许）：
//
//   ① **真值只有一个来源**：`truthForFlatName()` / `truthForDirect()` 都是**真的调引擎**
//      （`runToolLoop(...)` 抛出来的那句 `error.message`），文档里比对的是**同一处**产出的字符串。
//      本文件**不写**任何一句判词的副本——没有第二个 `legacyAccumulator`（#533 同族教训：手抄的
//      期望与代码漂移之后，反而"验证"了错的那份）。
//   ② **比对是逐字相等**，不是"包含关键子串"：`assert.equal(span, truth)`。#551 那种**整句替换**
//      恰好是子串判据漏掉的那一类；判据里唯一的规范化是把文档的**折行 / 缩进**压成单空格
//      （见 `flatten()`——围栏里的多行是排版，不是文案），词序与词本身一个字符都不许差。
//   ③ **零新门禁**：本文件进既有 `node --test` 套件，不新建 npm script、不动 CI、不动 `docs/**`。
//
// 覆盖面（清点见 `/tmp/i553-report.md`，判据只覆盖"整句逐字引用"）：
//   A. 扁平名闸口家族 `unknown runToolLoop option: "<key>" (its canonical home is …; the flat
//      spelling is rejected)`：**从文档里自动取 key**（不手抄名单），每个 key 现调引擎取真值。
//      EN 21 处 + CN 21 处；`"<key>"` 那条是**模板占位**（不是某一句真值），显式排除。
//   B. 三段**整句围栏**判词：`context` 混装壳两站、`config.metadata.expert` 拒函数值、
//      `config.metadata.session` 点名载荷新家（#551 就是这一段错配过）。
//   C. 五句**单句校验判词**（`cwd` / `maxRounds` / `persistence` / `partialPersistence` /
//      `reflection.judgeDoneAdvisory`）：整句被行内代码引用，同样逐字相等。
//   E. **能力面形状判词**（#554 新增）：`capabilities.hooks.onFoldSummary must be a function
//      (or omitted)`。契约曾引 `TypeError: onFoldSummary must be a function`——**没有代码路径打印它**；
//      真判词由 `CAPABILITIES_GROUP_VALIDATORS.hooks`（`src/loop/capabilities-namespace.js`）拼出。
//      它与 C 的差别**不是排版而是机制**（契约 #554 之后自己就写着「两个形状都校，但机制是两套」）：
//      C 是配置面启动期校值，E 是能力面容器的形状校验 ⇒ 真值来源也多走一个形状。
//
// 本文件导出的 `auditDocument()` / `auditFences()` / `auditCapabilityVerdicts()` /
// `truthForFlatName()` 给反向证用（工单 §4）：
// 反向证 ① 拿同一份代码在**改错一个词**的文档文本上跑（红）、② 拿**改了一个词**的运行时消息跑（红）、
// ③ 原样跑（绿）。判据与反向证走**同一条代码路径**，所以"绿"不是常数。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

const DOC_PATHS = {
  en: fileURLToPath(new URL("../docs/host-consumer-contract.md", import.meta.url)),
  cn: fileURLToPath(new URL("../docs/host-consumer-contract_cn.md", import.meta.url)),
};

// 扁平名闸口家族的**身份前缀**：只用来认出"这一段是在引用判词"，不参与相等性判定。
const FLAT_NAME_QUOTE = /^unknown runToolLoop option: "([^"]+)"/;
// 模板占位（`unknown runToolLoop option: "<key>" (its canonical home is config.run.<key>; …)`）：
// 它不是一个具体的运行时真值，是**句式**示意，所以不进逐字判据（清点表里单列）。
const PLACEHOLDER_KEYS = new Set(["<key>"]);

/** 文档折行 / 缩进是**排版**，不是文案：压成单空格后逐字比。词序与词本身一个字符都不许差。 */
export function flatten(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** 直连路线的最小合法入参（`executeTool` 必须在场，否则先撞的是 missing-methods 那条）。 */
function directOptions(extra = {}) {
  return {
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    config: { run: { completion: false }, input: { initialUserMessage: "go" } },
    ...extra,
  };
}

/** **真值来源 ①**：把扁平键喂给引擎，取它当场抛出来的那句原文（端到端路线，不抄文案）。 */
export async function truthForFlatName(optionName) {
  let message = null;
  try {
    // 名称闸口在任何宿主端口被读之前跑，所以这里不会发出任何请求。
    await runToolLoop(directOptions({ [optionName]: 1 }));
  } catch (error) {
    message = error.message;
  }
  // 走到这里说明闸口没拒 ⇒ 判据的输入已经不对了，抛出去让调用方看见。
  if (message === null) throw new Error(`名称闸口没有拒绝 ${optionName}`);
  return message;
}

/** **真值来源 ②**：把一份**合法**选项但**非法取值**喂给引擎，取它抛出来的那句原文。 */
export async function truthForDirect(extra) {
  try {
    await runToolLoop(directOptions(extra));
  } catch (error) {
    // 契约里这几句是用 `TypeError: <消息>` 的写法引用的，所以"抛出者确实是 TypeError"是引用成立的一半。
    assert.equal(
      error instanceof TypeError,
      true,
      `引擎对 ${JSON.stringify(extra)} 抛的不是 TypeError（${error?.constructor?.name}）——契约里 \`TypeError: …\` 的写法就错了`,
    );
    return error.message;
  }
  throw new Error(`引擎没有拒绝 ${JSON.stringify(extra)}`);
}

/** 文档里的围栏块（` ```lang ` 与 ` ``` ` 之间），内容压成单空格。 */
export function fencedBlocks(text) {
  const blocks = [];
  const lines = text.split("\n");
  let inFence = false;
  let start = 0;
  let lang = "";
  let buf = [];
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      if (!inFence) {
        inFence = true;
        start = index + 1;
        lang = line.trim().slice(3).trim();
        buf = [];
      } else {
        inFence = false;
        blocks.push({ lang, start, end: index, content: flatten(buf.join("\n")) });
      }
      return;
    }
    if (inFence) buf.push(line);
  });
  return blocks;
}

/** 文档里的行内代码跨度（整份文档压平之后再抽，于是**折行的引用**也认得出来）。 */
export function inlineSpans(text) {
  // 先摘掉围栏块：围栏里的反引号会与正文的反引号错位配对，抽出来的跨度就是垃圾。
  const flat = flatten(text.replace(/^\s*```[\s\S]*?^\s*```/gm, " "));
  const spans = [];
  const re = /`([^`]+)`/g;
  let match;
  while ((match = re.exec(flat))) spans.push(match[1].trim());
  return spans;
}

// ---------------------------------------------------------------- A. 扁平名闸口家族
//
// key **从文档里取**（不手抄名单）：文档里引了哪些键，就问引擎要哪些键的真值。
// 于是"文档新引了一个键而没人钉"不会静默通过，而"文档把引用整段删掉"由下面的处数下限兜住。

/** 返回 [{ key, span }]，按文档顺序。占位键被排除（它不是一个具体真值）。 */
export function flatNameQuotes(text) {
  const out = [];
  for (const span of inlineSpans(text)) {
    const match = FLAT_NAME_QUOTE.exec(span);
    if (!match) continue;
    if (PLACEHOLDER_KEYS.has(match[1])) continue;
    out.push({ key: match[1], span });
  }
  return out;
}

// ---------------------------------------------------------------- B. 三段整句围栏
//
// 定位器是**判词的身份前缀**（`unknown runToolLoop option: "context"` 这类"这一段在说哪件事"），
// 相等性判定仍是对整段内容。定位器两边都 fail-closed：运行时换了开头 ⇒ 找不到（红），
// 文档中间改了一个词 ⇒ 找到但不等（红）。两种都不会绿。

const FENCE_IDENTITIES = [
  { id: "context-shell", prefix: 'unknown runToolLoop option: "context"', truth: () => truthForFlatName("context") },
  { id: "metadata-expert", prefix: "config.metadata.expert is not accepted", truth: () => truthForDirect({ config: { metadata: { expert: () => 1 }, run: { completion: false }, input: { initialUserMessage: "go" } } }) },
  { id: "metadata-session", prefix: "config.metadata.session:", truth: () => truthForDirect({ config: { metadata: { session: "payload" }, run: { completion: false }, input: { initialUserMessage: "go" } } }) },
];

/** 返回 [{ id, found, content, truth }]——`found === false` 本身就是红的理由（引用不见了）。 */
export async function auditFences(text) {
  const blocks = fencedBlocks(text);
  const out = [];
  for (const identity of FENCE_IDENTITIES) {
    const matches = blocks.filter((block) => block.content.startsWith(identity.prefix));
    out.push({
      id: identity.id,
      found: matches.length,
      content: matches[0]?.content ?? null,
      truth: await identity.truth(),
    });
  }
  return out;
}

// ---------------------------------------------------------------- C. 单句校验判词
//
// 这几句是 `runToolLoop` 启动期**整句**抛出的校验文案，文档里以行内代码整句引用。
// 判据 = 「文档里存在**整段等于真值**的行内引用，且处数等于期望值」——不是"包含关键子串"：
// 文档改一个词 ⇒ 那个跨度不再等于真值 ⇒ 处数变 0 ⇒ 红。

// `TypeError: ` 是**错误类标注**（契约用 `TypeError: <消息>` 的写法引用），不是文案的一部分：
// 剥掉这个前缀之后，剩下的必须与真值**逐字相等**——一个词都不许差。`truthForDirect` 同时断言
// 抛出者确实是 `TypeError`，于是这个前缀不是白给的宽容。
const TYPE_ERROR_PREFIX = "TypeError: ";

const SHORT_VERDICTS = [
  { id: "cwd", extra: { config: { run: { cwd: 1 }, input: { initialUserMessage: "go" } } }, expect: 1 },
  { id: "maxRounds", extra: { config: { run: { maxRounds: 0 }, input: { initialUserMessage: "go" } } }, expect: 1 },
  { id: "persistence", extra: { config: { run: { persistence: true }, input: { initialUserMessage: "go" } } }, expect: 1 },
  { id: "partialPersistence", extra: { config: { run: { partialPersistence: { intervalMs: 10 } }, input: { initialUserMessage: "go" } } }, expect: 1 },
  { id: "judgeDoneAdvisory", extra: { config: { run: { reflection: { judgeDoneAdvisory: 1 } }, input: { initialUserMessage: "go" } } }, expect: 1 },
];

/** 返回 [{ id, truth, occurrences }]——`occurrences` 是**整段等于真值**的行内引用处数。 */
export async function auditShortVerdicts(text) {
  const spans = inlineSpans(text);
  const out = [];
  for (const verdict of SHORT_VERDICTS) {
    const truth = await truthForDirect(verdict.extra);
    out.push({
      id: verdict.id,
      truth,
      occurrences: spans.filter((span) => span === truth || span === TYPE_ERROR_PREFIX + truth).length,
    });
  }
  return out;
}

// ---------------------------------------------------------------- E. 能力面形状判词（#554）
//
// 病根（#554）：契约把能力面的形状规则引成 `TypeError: onFoldSummary must be a function`——
// **没有任何代码路径打印那句话**。真判词由 `src/loop/capabilities-namespace.js` 的
// `CAPABILITIES_GROUP_VALIDATORS.hooks` 拼出来：`${path} must be a function (or omitted)`，
// 其中 `path` 是叶子的**完整路径**（`capabilities.hooks.onFoldSummary`）。
//
// 取真值照旧**现调引擎**：`runToolLoop({ capabilities: { hooks: { onFoldSummary: 1 } } })`。
// `truthForDirect` 同时断言抛出者确实是 `TypeError`（契约用「抛 `<那句>`」的写法引用，
// 而错误类别是引用成立的一半）。本文件依旧**零判词副本**：这里不写那句真值的任何一个字。
//
// ⚠ 定位器与 A / C 两组**不同**，这是实测逼出来的：`inlineSpans()` 用「单反引号两两配对」抽跨度，
// 而 CN 契约里有一个 **4 反引号的代码跨度**（`docs/host-consumer-contract_cn.md:2715` 的
// ```` ```json ````）—— 从那一行之后配对整体错位（实测：CN 抽出 3803 个跨度 / EN 6092；
// 压平后反引号总数 CN 12355 为**奇数** / EN 12350 为偶数）。本组要钉的那句恰在错位区之后，
// 用 `inlineSpans()` 会数出 0（假红）。所以这一组用**与全局配对无关的局部锚点**：
// 在压平文本里找真值本身，并要求它**紧贴**在两个反引号之间。
// 这不放松判据——`indexOf` 找的是**整串**，改一个词就找不到；只是不再依赖「第几个反引号」。

/**
 * `truth` 在文档里被**整句**行内代码引用的处数（局部锚点：真值前后各紧贴一个反引号）。
 * 两种引用形态都认：`\`<真值>\`` 与 `\`TypeError: <真值>\``（后者是契约的错误类标注写法）。
 *
 * @param {string} text
 * @param {string} truth 引擎当场抛出的 `error.message`
 * @returns {number}
 */
export function quotedExactlyCount(text, truth) {
  const flat = flatten(text);
  let count = 0;
  for (const needle of [truth, TYPE_ERROR_PREFIX + truth]) {
    let from = 0;
    let index;
    while ((index = flat.indexOf(needle, from)) !== -1) {
      if (flat[index - 1] === "`" && flat[index + needle.length] === "`") count += 1;
      from = index + 1;
    }
  }
  return count;
}

const CAPABILITY_SHAPE_VERDICTS = [
  {
    id: "capabilities.hooks.onFoldSummary",
    extra: { capabilities: { hooks: { onFoldSummary: 1 } } },
    expect: 1,
  },
];

/** 返回 [{ id, truth, occurrences }]——`occurrences` 是**整段等于真值**的行内引用处数。 */
export async function auditCapabilityVerdicts(text) {
  const out = [];
  for (const verdict of CAPABILITY_SHAPE_VERDICTS) {
    const truth = await truthForDirect(verdict.extra);
    out.push({ id: verdict.id, truth, occurrences: quotedExactlyCount(text, truth) });
  }
  return out;
}

/** 整份文档的审计（四条判据一起跑），给反向证与正式断言共用同一条代码路径。 */
export async function auditDocument(text) {
  const flat = flatNameQuotes(text);
  const truths = new Map();
  for (const quote of flat) {
    if (!truths.has(quote.key)) truths.set(quote.key, await truthForFlatName(quote.key));
  }
  return {
    flat: flat.map((quote) => ({ ...quote, truth: truths.get(quote.key), ok: quote.span === truths.get(quote.key) })),
    fences: await auditFences(text),
    shorts: await auditShortVerdicts(text),
    capabilities: await auditCapabilityVerdicts(text),
  };
}

const read = (which) => readFileSync(DOC_PATHS[which], "utf8");

// ================================================================ A. 扁平名闸口家族（中英各一格）
//
// 一格一份文档：逐处比 + 处数下限 + 中英键集合对账。三件事分开断言，红了能直接看出是哪一层。

const FLAT_NAME_FLOOR = 21; // 实测 EN 21 / CN 21（第 22 处是 `"<key>"` 模板占位，已排除）。

for (const which of ["en", "cn"]) {
  test(`A-${which}: 扁平名判词的每一处引用逐字等于运行时真值（${which.toUpperCase()}）`, async () => {
    const quotes = flatNameQuotes(read(which));
    assert.ok(
      quotes.length >= FLAT_NAME_FLOOR,
      `引用处数 ${quotes.length} 低于下限 ${FLAT_NAME_FLOOR}：引用被删掉不能算"问题消失"（它们是宿主迁移的唯一指引）`,
    );
    for (const quote of quotes) {
      assert.equal(
        quote.span,
        await truthForFlatName(quote.key),
        `契约里的 \`unknown runToolLoop option: "${quote.key}"\` 那段与运行时真值不再逐字相等`
          + "（文档引用了引擎早就不说的句子——宿主会照文档抄）",
      );
    }
  });
}

test("A-中英对账：两份契约引用的扁平键集合逐键相同", () => {
  const en = flatNameQuotes(read("en")).map((quote) => quote.key).sort();
  const cn = flatNameQuotes(read("cn")).map((quote) => quote.key).sort();
  assert.deepEqual(cn, en, "中英契约引用的扁平键必须成对（漏一侧 = 一侧的宿主没有迁移指引）");
});

// ================================================================ B. 三段整句围栏（#551 错配的就是其中一段）

for (const which of ["en", "cn"]) {
  test(`B-${which}: 三段整句围栏判词逐字等于运行时真值（${which.toUpperCase()}）`, async () => {
    const audit = await auditFences(read(which));
    for (const fence of audit) {
      assert.equal(fence.found, 1, `围栏判词 ${fence.id} 在文档里找不到（或不止一处）——引用不许删`);
      assert.equal(
        fence.content,
        fence.truth,
        `围栏判词 ${fence.id} 与运行时真值不再逐字相等`,
      );
    }
  });
}

// ================================================================ C. 单句校验判词

for (const which of ["en", "cn"]) {
  test(`C-${which}: 单句校验判词逐字等于运行时真值（${which.toUpperCase()}）`, async () => {
    const audit = await auditShortVerdicts(read(which));
    for (const verdict of audit) {
      const expected = SHORT_VERDICTS.find((item) => item.id === verdict.id).expect;
      assert.equal(
        verdict.occurrences,
        expected,
        `${verdict.id} 那句（真值：${JSON.stringify(verdict.truth)}）在 ${which.toUpperCase()} 契约里的整句引用处数`
          + `从 ${expected} 变成 ${verdict.occurrences}`,
      );
    }
  });
}

// ================================================================ E. 能力面形状判词（#554）

for (const which of ["en", "cn"]) {
  test(`E-${which}: 能力面形状判词逐字等于运行时真值（${which.toUpperCase()}）`, async () => {
    const audit = await auditCapabilityVerdicts(read(which));
    for (const verdict of audit) {
      const expected = CAPABILITY_SHAPE_VERDICTS.find((item) => item.id === verdict.id).expect;
      assert.equal(
        verdict.occurrences,
        expected,
        `${verdict.id} 那句（真值：${JSON.stringify(verdict.truth)}）在 ${which.toUpperCase()} 契约里的整句引用处数`
          + `从 ${expected} 变成 ${verdict.occurrences}`
          + "（契约引用的句子必须**逐字**等于引擎当场抛出的那一句）",
      );
    }
  });
}

// ================================================================ D. 判据自身不许是常数
//
// 反向证 ③（正向）：`auditDocument()` 在**今天的文档**上全绿——它证明上面那些格子不是永远红。
// 反向证 ①② 不放在本文件（它们要改文档 / 改运行时），由工单报告里的探针给出退出码；
// 但"改错一个词就红"这件事在这里再自证一次：**在内存里**把一处引用改一个词，审计必须翻红。

test("D-自证不是常数：内存里改一个词 ⇒ 审计翻红（不改盘上文件）", async () => {
  const original = read("en");
  const green = await auditDocument(original);
  assert.equal(green.flat.every((quote) => quote.ok), true, "原文档必须是绿的（否则下面的反向证没有意义）");
  assert.equal(green.fences.every((fence) => fence.found === 1 && fence.content === fence.truth), true);

  // ① 文档里改一个词（`rejected` → `refused`）：判据必须红。
  const mutatedDoc = original.replace(
    'unknown runToolLoop option: "cwd" (its canonical home is config.run.cwd; the flat spelling is rejected)',
    'unknown runToolLoop option: "cwd" (its canonical home is config.run.cwd; the flat spelling is refused)',
  );
  assert.notEqual(mutatedDoc, original, "变异必须真的落到文本上（否则这条自证是空的）");
  const red = await auditDocument(mutatedDoc);
  assert.equal(
    red.flat.filter((quote) => !quote.ok).length,
    1,
    "改一个词的引用必须**恰好**翻红一处——翻红 0 处说明判据是常数绿，翻红多处说明判据在乱咬",
  );
});

test("D-自证不是常数：围栏里整句换掉 ⇒ 审计翻红（#551 那种错配）", async () => {
  const original = read("en");
  const oldSentence = "the top-level `session` option is the run identity container";
  assert.equal(original.includes(oldSentence), true, "变异锚点必须存在");
  // #551 之前那句（旧的、不点名载荷新家的一句）：整句替换，一个词都不留。
  const mutated = original.replace(
    /config\.metadata\.session: the opaque per-run payload's home is config\.folding\.context\.session[^\n]*/,
    "config.metadata.session: write it at the top level as session: …",
  );
  assert.notEqual(mutated, original, "变异必须真的落到文本上");
  const red = await auditFences(mutated);
  const session = red.find((fence) => fence.id === "metadata-session");
  assert.notEqual(session.content, session.truth, "整句替换必须被逐字判据抓住（子串判据会漏掉这一格）");
});

test("D-自证不是常数：能力面那句改一个词 ⇒ 审计翻红（#554 新钉的那句）", async () => {
  const original = read("en");
  // 锚点**只**认「引擎真的会打印这句」这个前提：句子的字面值取自运行时（下面 `truth`），不手抄。
  const truth = (await auditCapabilityVerdicts(original)).find(
    (verdict) => verdict.id === "capabilities.hooks.onFoldSummary",
  ).truth;
  assert.equal(original.includes(truth), true, "变异锚点必须存在（否则这条自证是空的）");
  // 改一个词：`omitted` → `undefined`（两词都说得通，正是"手抄一句看似合理的话"那种漂移）。
  const mutated = original.replace(truth, truth.replace("or omitted", "or undefined"));
  assert.notEqual(mutated, original, "变异必须真的落到文本上");
  const red = await auditCapabilityVerdicts(mutated);
  assert.equal(
    red.find((verdict) => verdict.id === "capabilities.hooks.onFoldSummary").occurrences,
    0,
    "改一个词的能力面判词必须翻红——处数还是 1 说明判据在拿子串/常数比对",
  );
});
