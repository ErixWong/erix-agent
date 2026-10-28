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
//   F. **分词器自证**（#555 新增）：文档结构本身（围栏 vs 行内跨度）——多反引号等长配对、
//      跳围栏、无错位残留。A / C / E 三组共用同一个 `inlineSpans()`，所以它的正确性是
//      上面所有格子的**地基**：#555 之前它在 CN 契约 `:2715` 那个合法 4 反引号跨度上错位，
//      CN 从那里之后的引用**全部静默漏检**（旧分词器数出 3803 个跨度 vs EN 6092，
//      且同一句能力面真值在 CN 上命中 0 处——不是红，是看不见）。
//   G. **端口顶层成员闸判词**（#557 新增）：`1be8d00` 往中英契约的 `## AssemblyPort` 段各插了
//      5 处逐字引用（EN 5 + CN 5 = 10 处），但覆盖面按分组枚举（A/B/C/E），这 5 条**不在任何
//      一组里**——没有判据的逐字引用就是等着的债（#553 抓出 2 处、#554 抓出 1 处，都是这个形状）。
//      取真值现调 `createAssemblyPort` 取 `error.message`；另给 G2 一格**只钉指路子句**
//      （`; its canonical home is …`），G3 是它的内存反向证。
//
// 本文件导出的 `auditDocument()` / `auditFences()` / `auditCapabilityVerdicts()` /
// `truthForFlatName()` / `inlineSpans()` / `scanInlineSpans()` 给反向证用（工单 §4）：
// 反向证 ① 内存夹具里的多反引号跨度配对正确（正向证据，F-1）、② 文档里**改错一个词**⇒红
// （F-3 / D 组）、③ 原样跑 ⇒ 绿。判据与反向证走**同一条代码路径**，所以"绿"不是常数。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createAssemblyPort } from "../src/assembly.js";
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

// ---------------------------------------------------------------- 文档结构：围栏 vs 行内
//
// #555 的病根：**单反引号朴素配对**（旧 `inlineSpans()` 用 `/`([^`]+)`/g`）。CN 契约
// `docs/host-consumer-contract_cn.md:2715` 有一处**合法的 4 反引号行内跨度**——那行讲的正是
// 「内联内容里带反引号就得用更多反引号包」这个写法**本身**（内容就是 ```json）。它不是错处，
// 删不得；错的是分词器：单反引号配到那里就与后面的反引号整体错位，**CN 从 2715 之后的引用
// 全部静默漏检**（实测跨度 3803 vs EN 6092）。
//
// 正解是 CommonMark 的两条规则，本文件照抄：
//   ① **围栏**：开围栏 = 行首（≤3 空格）连续 ≥3 个反引号，且其后的信息串**不含反引号**；
//      闭围栏 = 行首连续 ≥ 开围栏长度的反引号且其后只有空白。围栏内部不当行内处理。
//      ⇒ `:2715` 那行开头虽是 4 个反引号，但后面紧跟 ```json（信息串里有反引号）⇒ **不是围栏**，
//      正是行内跨度。
//   ② **行内跨度**：开启串是 n 个反引号（n≥1），闭合串必须是**恰好 n 个**；找不到等长闭合串
//      时该串按字面文字处理（继续往后扫），所以一处畸形写法不会污染整份文档。
// 两条规则合起来的效果：跨度数从 3803 回到 6096（EN 6092），A/B/C/E 四组的**处数逐数不变**
// （对照表见文件末尾 D 组的自证与 `/tmp/i555-report.md`）。

const FENCE_OPEN = /^ {0,3}(`{3,})(.*)$/;

/**
 * 把文档切成「围栏块」与「正文行」。
 * 返回 `{ blocks, prose }`：`blocks` 是围栏块（内容压成单空格），`prose` 是挖掉围栏后的正文原文。
 */
export function splitFences(text) {
  const lines = text.split("\n");
  const blocks = [];
  const prose = [];
  let open = null; // { len, lang, start, buf }
  lines.forEach((line, index) => {
    const match = FENCE_OPEN.exec(line);
    if (open === null) {
      // 信息串里带反引号 ⇒ 这不是围栏（CommonMark 的限定），落回正文。
      if (match && !match[2].includes("`")) {
        open = { len: match[1].length, lang: match[2].trim(), start: index + 1, buf: [] };
      } else {
        prose.push(line);
      }
      return;
    }
    if (match && match[1].length >= open.len && match[2].trim() === "") {
      blocks.push({ lang: open.lang, start: open.start, end: index, content: flatten(open.buf.join("\n")) });
      open = null;
      return;
    }
    open.buf.push(line);
  });
  return { blocks, prose: prose.join("\n") };
}

/** 文档里的围栏块（` ```lang ` … ` ``` `；也认 ` ```` ` 这类更长的围栏），内容压成单空格。 */
export function fencedBlocks(text) {
  return splitFences(text).blocks;
}

/** 文档里的行内代码跨度（整份正文压平之后再抽，于是**折行的引用**也认得出来）。 */
export function inlineSpans(text) {
  return scanInlineSpans(text).spans;
}

/**
 * 行内跨度的**结构**扫描（给自证用）：除了跨度本身，还把「没配上对的 run」交出来。
 *
 * `unpaired` 是 #555 那个病的**指纹**：单反引号朴素配对撞上 4 反引号跨度时，错位会把一半的反引号
 * 配成垃圾跨度、另一半成对地剩下，而 `unpaired` 恰好把「反引号总数是奇数」这个症状暴露出来。
 * 健康文档（中英两份）的 `unpaired` 必须为空：正文里每一个反引号 run 要么是某跨度的定界串，
 * 要么是某个多反引号跨度的**内容**（如 CN `:2715` 跨度内容里的 ```json）。
 *
 * @param {string} text
 * @returns {{ spans: string[], unpaired: { len: number, near: string }[] }}
 */
export function scanInlineSpans(text) {
  // 先摘掉围栏块：围栏里的反引号会与正文的反引号错位配对，抽出来的跨度就是垃圾。
  const flat = flatten(splitFences(text).prose);
  // 反引号连续段（run）先全部切出来，再按「等长配对」贪心消费。
  const runs = [];
  for (let i = 0; i < flat.length; ) {
    if (flat[i] !== "`") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < flat.length && flat[j] === "`") j += 1;
    runs.push({ start: i, len: j - i });
    i = j;
  }
  const spans = [];
  const consumed = new Set();
  let k = 0;
  while (k < runs.length) {
    const opener = runs[k];
    let close = -1;
    for (let m = k + 1; m < runs.length; m += 1) {
      if (runs[m].len === opener.len) {
        close = m;
        break;
      }
    }
    // 没有等长闭合串 ⇒ 这个 run 是字面文字（畸形写法只吃掉自己，不影响后面的配对）。
    if (close === -1) {
      k += 1;
      continue;
    }
    spans.push(flat.slice(opener.start + opener.len, runs[close].start).trim());
    // 定界串与跨度的**内容**都算被消费：内容里的 run 不是畸形（` ```` ```json ```` ` 就是如此）。
    for (let m = k; m <= close; m += 1) consumed.add(m);
    k = close + 1;
  }
  const unpaired = runs
    .map((run, index) => ({ run, index }))
    .filter(({ index }) => !consumed.has(index))
    .map(({ run }) => ({ len: run.len, near: flat.slice(Math.max(0, run.start - 40), run.start + 40) }));
  return { spans, unpaired };
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
// 定位器：**与 A / C 两组同一个**——`inlineSpans()` 抽出的跨度，整段等于真值即计入。
//
// #554 落地时这里不是这样：那时 `inlineSpans()` 是单反引号朴素配对，CN 契约里
// `docs/host-consumer-contract_cn.md:2715` 那个**合法的 4 反引号跨度**（内容就是 ```json）
// 把配对整体顶错位，本组要钉的那句恰在错位区之后 ⇒ 用 `inlineSpans()` 数出 0（假红）。
// 当时只好改用「整串紧贴反引号」的局部计数（`quotedExactlyCount()`）绕过。
//
// **#555 把这个绕过收回了**：分词器改成 CommonMark 的多反引号定界配对 + 跳围栏之后，
// 错位区不存在了（跨度 CN 3803 → 6091，A / C / E 三组处数逐数不变），本组于是与 A / C
// 走**同一条数法**。理由：两套数法并存、却只有一套被自测覆盖，等于给 CN 留一个制度化的盲区
// ——局部锚点只认「真值前后各一个反引号」，`` ``n 真值 ``n ``（n≥2 的引用写法）它就看不见了。
// 现在只有一条数法，正反两个方向都由 D 组自证盯住。

const CAPABILITY_SHAPE_VERDICTS = [
  {
    id: "capabilities.hooks.onFoldSummary",
    extra: { capabilities: { hooks: { onFoldSummary: 1 } } },
    expect: 1,
  },
];

/** 返回 [{ id, truth, occurrences }]——`occurrences` 是**整段等于真值**的行内引用处数。 */
export async function auditCapabilityVerdicts(text) {
  const spans = inlineSpans(text);
  const out = [];
  for (const verdict of CAPABILITY_SHAPE_VERDICTS) {
    const truth = await truthForDirect(verdict.extra);
    out.push({
      id: verdict.id,
      truth,
      occurrences: spans.filter((span) => span === truth || span === TYPE_ERROR_PREFIX + truth).length,
    });
  }
  return out;
}

// ---------------------------------------------------------------- G. 端口顶层成员闸判词（#556 / #557）
//
// 来由（#557）：`1be8d00` 往中英契约的 `## AssemblyPort` 段各插了 **5 处逐字引用**（EN 5 + CN 5 =
// 10 处），但 #553 的覆盖面按分组枚举（A/B/C/E）——这 5 条**不在任何一组里**。没有判据的逐字
// 引用就是等着的债：#553 抓出 2 处、#554 抓出 1 处，全是这个形状。
//
// 取真值：**现调 `createAssemblyPort`** 取 `error.message`（#556 的闸口在构造期**同步**抛，且在
// 读任何宿主工厂之前跑 ⇒ 这条真值来源是纯本地的：不发请求、不碰盘）。本文件依旧**零判词副本**：
// 下表只有**入参**（成员名 / `null`）与**处数**，句子一个字都不写。
//
// 三个形状坑（#557 工单，都是空跑过的）：
//   ① `createAssemblyPort` 的**数据面住在 `policy` 里**，顶层 `config` / `capabilities` 正是 #556
//      刚加的闸要拒的两个名字（也是 G 组第 1、2 条的成因）——所以那两格的入参是「合法端口 +
//      一个顶层容器」，证明被拒的原因只能是那个名字，不是端口不完整。
//   ② `{ ...base, ...null }` 展开成**空对象** ⇒ 非对象入参必须**直接**传 `null`。
//   ③ 端口成员表用 `Map` 而不是对象字面量写：`test/**` 里 `session` / `tools` 这类字面量属性名
//      会被 `npm run check:inventory` 计成**扁平写点**（本片零新增写点，见工单 §地盘与禁改）。

const PORT_MEMBERS = new Map([
  ["modelConfig", () => ({ resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) })],
  ["provider", () => createFakeProvider(DONE)],
  ["tools", () => ({ definitions: [], executeTool: async () => "ok" })],
  ["session", { id: "port-557" }],
]);

/** 一份**合法**端口入参，再挂上 `name`（要被闸口拒的那个名字）。`name` 缺省 ⇒ 纯合法端口。 */
function portInputWith(name, value = 1) {
  const input = {};
  for (const [member, memberValue] of PORT_MEMBERS) input[member] = memberValue;
  if (name !== undefined) input[name] = value;
  return input;
}

/** 描述入参（只用于报错文本，不参与判定）：非对象入参直接把值写出来，对象写出它的键。 */
function describePortInput(input) {
  if (input === null || typeof input !== "object") return String(input);
  return JSON.stringify(Object.keys(input));
}

/**
 * **真值来源 ③**：把入参喂给 `createAssemblyPort`，取它当场抛出来的那句原文。
 *
 * 闸口在构造期同步跑，所以这里不需要 await；它拒的是**名字**（或非对象入参的形状），
 * 在任何一个宿主工厂被调之前——与直连路线 `assertRunToolLoopOptionNames` 同一条次序承诺。
 *
 * @param {any} input
 * @returns {string}
 */
export function truthForPortInput(input) {
  try {
    createAssemblyPort(input);
  } catch (error) {
    // 契约里这五句都是裸句引用（没有 `TypeError: ` 前缀），所以「抛出者确实是 TypeError」
    // 是引用成立的一半：它要是换了错误类别，文档的写法也得跟着变。
    assert.equal(
      error instanceof TypeError,
      true,
      `端口闸口对 ${describePortInput(input)} 抛的不是 TypeError（${error?.constructor?.name}）`,
    );
    return error.message;
  }
  throw new Error(`端口闸口没有拒绝 ${describePortInput(input)}——判据的输入已经不对了`);
}

// 五条 = 契约里那 5 处引用。`expect` 是**每处恰好 1 次**（EN 5 + CN 5 = 10 处，与 A/C/E 同一套数法）。
const ASSEMBLY_PORT_VERDICTS = [
  { id: "port-top-level-config", input: () => portInputWith("config", { input: { initialUserMessage: "go" } }), expect: 1 },
  { id: "port-top-level-capabilities", input: () => portInputWith("capabilities", { hooks: {} }), expect: 1 },
  { id: "port-unknown-member", input: () => portInputWith("bogusMember"), expect: 1 },
  { id: "port-misspelled-member", input: () => portInputWith("provder"), expect: 1 },
  // 非对象入参：**直接**传 `null`（不是 spread，见上面形状坑 ②）。
  { id: "port-non-object", input: () => null, expect: 1 },
];

/**
 * 返回 [{ id, truth, expect, occurrences }]——`occurrences` 是**整段等于真值**的行内引用处数。
 *
 * 比对是 `span === truth`：**不接受** `TypeError: ` 前缀（契约这五处是裸句），也**不接受**子串包含
 * ——子串判据恰好漏掉「整句被换掉一句看着合理的」那一类（#551 就是那么错的）。
 *
 * @param {string} text
 * @returns {{ id: string, truth: string, expect: number, occurrences: number }[]}
 */
export function auditAssemblyPortVerdicts(text) {
  const spans = inlineSpans(text);
  return ASSEMBLY_PORT_VERDICTS.map((verdict) => {
    const truth = truthForPortInput(verdict.input());
    return {
      id: verdict.id,
      truth,
      expect: verdict.expect,
      occurrences: spans.filter((span) => span === truth).length,
    };
  });
}

// ---------------------------------------------------------------- G2. 指路子句单钉（#556 留的一笔）
//
// 那条**指路子句**（`… ; its canonical home is <住所>: …`）今天只有一处报警面：#556 自己套件的
// B2——那里是**手抄**的整句。对齐套件里它只是 G 组那两格**整句**的一部分：整句变了当然红，
// 但「指路指错了地方」与「可接受集合变了」在报警文本上分不开；更要紧的是**引擎哪天不再指路**时，
// G 组只会说「整句不等」。所以单独给一格，只钉指路子句：
//   · 目标住所由**规则**算出（端口的两个容器都住在 `policy` 下一层 ⇒ `policy.<name>`），不手抄；
//   · 子句的切点也**不写判词**：用上面那个规则算出的住所定位，再回溯到上一个子句分隔 `; `。
// 于是这一格的三种红各不相同：引擎不再指路 / 指错了住所 / 文档没有逐字复述。

const POINTER_CONTAINERS = ["config", "capabilities"];

/**
 * 把一句判词切成「主体 + 指路子句 + 指路住所」；没有指路子句 ⇒ `null`（引擎不再指路时 G2 必须红）。
 *
 * 切点**不写判词字面量**：先用规则算出的住所 `policy.<name>` 定位，找不到就退回**最后一个**子句分隔
 * `; `（那时指路要么指错了地方、要么整段不见了——两种都由 G2 的**不同断言**点名）。
 * `policy.` 之后到第一个 `:` 之前就是住所本身。
 *
 * @param {string} verdict
 * @param {string} name 容器名（`config` / `capabilities`）——它同时是 G 组要断言的成员名
 * @returns {{ head: string, pointer: string, home: string | null } | null}
 */
export function splitPointerClause(verdict, name) {
  const at = verdict.indexOf(`policy.${name}`);
  const start = verdict.lastIndexOf("; ", at === -1 ? verdict.length : at);
  if (start === -1) return null;
  const pointer = verdict.slice(start);
  const homeAt = pointer.indexOf("policy.");
  return {
    head: verdict.slice(0, start),
    pointer,
    home: homeAt === -1 ? null : pointer.slice(homeAt).split(":")[0].trim(),
  };
}

/** 整份文档的审计（五条判据一起跑），给反向证与正式断言共用同一条代码路径。 */
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
    assembly: auditAssemblyPortVerdicts(text),
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

// ================================================================ G. 端口顶层成员闸判词（#557）
//
// 一格一份文档：逐条处数（每处恰好 1）+ 本语言合计（5）。两件事分开断言，红了能直接看出是哪一层。
// 中英合计 10 处是工单的数字：**每处引用必须恰好 1 次**（EN 5 + CN 5）。

const ASSEMBLY_PORT_TOTAL = 5; // EN 5 / CN 5；中英合计 10。

for (const which of ["en", "cn"]) {
  test(`G-${which}: 端口顶层成员闸的五句判词逐字等于运行时真值（${which.toUpperCase()}）`, () => {
    const audit = auditAssemblyPortVerdicts(read(which));
    for (const verdict of audit) {
      assert.equal(
        verdict.occurrences,
        verdict.expect,
        `${verdict.id} 那句（真值：${JSON.stringify(verdict.truth)}）在 ${which.toUpperCase()} 契约里的整句引用处数`
          + `从 ${verdict.expect} 变成 ${verdict.occurrences}`
          + "（契约引用的句子必须**逐字**等于 `createAssemblyPort` 当场抛出的那一句）",
      );
    }
    const total = audit.reduce((sum, verdict) => sum + verdict.occurrences, 0);
    assert.equal(
      total,
      ASSEMBLY_PORT_TOTAL,
      `${which.toUpperCase()} 契约里这五句的整句引用合计 ${total} 处（应为 ${ASSEMBLY_PORT_TOTAL}）`
        + "——少一处不是「问题消失」，是宿主照文档抄不到了",
    );
  });
}

// G2：指路子句单钉（与 G 共用 `inlineSpans()` 与同一个真值来源，不是第二套数法）。
for (const which of ["en", "cn"]) {
  test(`G2-${which}: 指路子句单独钉——住所按规则算出 policy.<name>，文档逐字复述（${which.toUpperCase()}）`, () => {
    const spans = inlineSpans(read(which));
    for (const name of POINTER_CONTAINERS) {
      const truth = truthForPortInput(portInputWith(name, {}));
      const runtime = splitPointerClause(truth, name);
      assert.notEqual(
        runtime,
        null,
        `引擎对顶层 ${name} 的判词不再带指路子句——契约里那句指路就成了没有出处的引用`,
      );
      // 住所是**算出来的**：端口的两个容器都住在 `policy` 下一层，所以指路目标恒为 `policy.<name>`。
      assert.equal(
        runtime.home,
        `policy.${name}`,
        `指路子句把 ${name} 指向了 ${runtime.home}——端口的两个容器只能住在 policy 下一层`,
      );
      const matching = spans.filter((span) => {
        const doc = splitPointerClause(span, name);
        return doc !== null && doc.pointer === runtime.pointer;
      });
      assert.equal(
        matching.length,
        1,
        `${name} 的指路子句在 ${which.toUpperCase()} 契约里的逐字复述处数从 1 变成 ${matching.length}`
          + `（真值：${JSON.stringify(runtime.pointer)}）`,
      );
    }
  });
}

// G3：反向证（内存）——证明上面两格不是常数绿。盘上 `docs/**` 一个字节不动。
// 与工单 §4 的盘上探针同一条代码路径，这里是它在内存里的对应格。
test("G3-自证不是常数：端口判词改一个词 ⇒ 审计翻红（不改盘上文件）", () => {
  const original = read("en");
  const green = auditAssemblyPortVerdicts(original);
  assert.equal(
    green.every((verdict) => verdict.occurrences === verdict.expect),
    true,
    "原文档必须是绿的（否则下面的反向证没有意义）",
  );
  // 锚点**取自运行时**（不手抄）：只把 `bogusMember` 那句里的一个词改掉。
  const truth = green.find((verdict) => verdict.id === "port-unknown-member").truth;
  assert.equal(original.includes(truth), true, "变异锚点必须存在（否则这条自证是空的）");
  const mutatedDoc = original.replace(truth, truth.replace("accepted:", "accepted set:"));
  assert.notEqual(mutatedDoc, original, "变异必须真的落到文本上");
  const red = auditAssemblyPortVerdicts(mutatedDoc);
  assert.equal(
    red.find((verdict) => verdict.id === "port-unknown-member").occurrences,
    0,
    "改一个词的端口判词必须翻红——处数还是 1 说明判据在拿子串/常数比对",
  );
});

// ================================================================ D. 判据自身不许是常数
//
// 反向证 ③（正向）：`auditDocument()` 在**今天的文档**上全绿——它证明上面那些格子不是永远红。
// 改文档 / 改运行时那两条反向证由工单报告里的探针给出退出码（F 组的 F-1 / F-3 是它们在内存里的对应格）；
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

// ================================================================ F. 分词器自证（#555）
//
// #555 的病根不在判词、在**分词器**：单反引号朴素配对遇到合法的 4 反引号行内跨度就整体错位，
// CN 从 `:2715` 之后的引用**静默漏检**（不是红，是看不见）。下面三格把这个盲区钉死：
//   F-1 内存夹具：多反引号定界配对 + 跳围栏（新规则的**正向**证据，且证明夹具真的踩到了旧病）。
//   F-2 两份真文档的结构自检：没有残留的未配对反引号 run、CN 那个 4 反引号跨度被抽成**一个**跨度、
//       跨度数不低于地板（旧分词器在 CN 上数出 3803，远低于地板 ⇒ 这一格本身就是回归闸）。
//   F-3 CN 反向证：CN 契约里（原先的盲区之后）那句能力面判词改一个词 ⇒ 处数 0。
//
// 修复前后对照（#555 实测，逐数相等那几行就是"零新红"的凭据）：
//
//   | 项目                        | EN 前 → 后     | CN 前 → 后     |
//   |-----------------------------|----------------|----------------|
//   | 行内跨度数                  | 6092 → 6092    | 3803 → **6091**|
//   | A 扁平名引用处数            | 21 → 21        | 21 → 21        |
//   | A 引用到的键集合            | 21 键 → 同     | 21 键 → 同     |
//   | B 三段围栏 found            | 1/1/1 → 同     | 1/1/1 → 同     |
//   | C 五句处数                  | 1×5 → 1×5      | 1×5 → 1×5      |
//   | E 能力面处数                | 1 → 1          | 1 → 1          |
//
// ⚠ **跨度数不是证据，跨度身份才是**。把两个病分开量（隔离实验，见报告 §3）：
//   · 只修围栏识别、配对仍用单反引号 ⇒ CN 数出 **6092** 个跨度（与正确的 6091 只差 1！），但
//     `:2715` 之后的跨度**边界全错**：能力面那句命中 **0** 处，而它吐出来的"跨度"是另一句
//     看着完全合理的判词（`capabilities.hooks.onReflection must be a function (or omitted)`）。
//     ⇒ 这就是 #555 说的"静默漏检"：数目对得上，内容是垃圾。
//   · 只修配对、围栏仍用旧正则（`^\s*```…^\s*``` `）⇒ CN 仍数出 **3803**：旧正则把 `:2715`
//     那行当成围栏开头，把 2715–2733 整段从正文里**挖掉**了。
//   ⇒ 两个病都得治，且验收要靠"那个 4 反引号跨度被抽成一个跨度 + 真值命中"这类**身份**断言，
//     不是靠跨度数。（工单记的 #554 原型数 6096 复现不出来：五种围栏/配对变体 EN 只有 6092
//     与 #554 吻合；上面的 run 级算术 12183/12184 是可复核的那一份，报告里写明了这处差异。）
//
// CN 跨度 3803 → 6091 的 run 级算术：CN 正文 12183 个反引号 run，其中 ` ```json ` 这 1 个是那个
// 4 反引号跨度的**内容**，剩下 12182 个两两成对 ⇒ 6091；EN 12184 个 run 全成对 ⇒ 6092。

const SPAN_FLOOR = 6000; // 今天 EN 6092 / CN 6091；旧分词器在 CN 上数出 3803 ⇒ 地板本身就是回归闸。

test("F-1 分词器：多反引号定界配对 + 跳围栏（内存夹具，正向证据）", () => {
  const fixture = [
    "正文 `a` 之后是 4 反引号跨度 ```` ```json ```` 后面还有 `b`。",
    "```js",
    "const x = `围栏里不是行内跨度`;",
    "```",
    "结尾 `c`。",
  ].join("\n");
  const spans = inlineSpans(fixture);
  assert.deepEqual(
    spans,
    ["a", "```json", "b", "c"],
    "跨度必须按**等长**定界配对（4 反引号跨度的内容就是 ```json），围栏里的反引号一个都不许抽出来",
  );
  // 夹具必须真的踩到旧病：单反引号朴素配对在这份文本上抽出来的东西与上面**不等**。
  const naive = fixture.replace(/^\s*```[\s\S]*?^\s*```/gm, " ").replace(/\s+/g, " ").trim();
  const naiveSpans = [...naive.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
  assert.notDeepEqual(naiveSpans, spans, "夹具必须能区分新旧两种分词器（否则这格是空的）");
  // 旧分词器（单反引号朴素配对）在这份夹具上：`a` 之后整体错位——4 反引号跨度被拆成垃圾
  // （`""` / `"json"`），后续的 `b` / `c` **完全抽不出来**（静默漏检，不是红）。
  assert.equal(naiveSpans.includes("b"), false, "旧分词器在错位之后丢掉 `b`（正是 #555 的静默漏检）");
  assert.equal(naiveSpans.includes("c"), false, "旧分词器在错位之后丢掉 `c`（正是 #555 的静默漏检）");
  assert.equal(naiveSpans.includes("```json"), false, "旧分词器把 4 反引号跨度拆成垃圾，抽不出它的内容");
});

test("F-2 分词器：两份真文档都没有错位残留，CN 那个 4 反引号跨度被抽成一个跨度", () => {
  for (const which of ["en", "cn"]) {
    const { spans, unpaired } = scanInlineSpans(read(which));
    assert.deepEqual(
      unpaired,
      [],
      `${which.toUpperCase()} 契约正文里有没配上对的反引号 run（${JSON.stringify(unpaired)}）——`
        + "要么是多反引号跨度没被等长配对，要么是文档里真有一个落单的反引号",
    );
    assert.ok(
      spans.length >= SPAN_FLOOR,
      `${which.toUpperCase()} 只抽出 ${spans.length} 个行内跨度（地板 ${SPAN_FLOOR}）——`
        + "跨度数塌下来说明配对又错位了，后面的引用判词会静默漏检",
    );
  }
  const cnSpans = inlineSpans(read("cn"));
  assert.equal(
    cnSpans.filter((span) => span === "```json").length,
    1,
    "CN `:2715` 那个合法的 4 反引号跨度必须被抽成**一个**跨度，内容是 ```json"
      + "（它是合法 markdown：那行讲的正是「内联内容里带反引号就得用更多反引号包」这个写法本身）",
  );
  // 对照（**不是**第二套判词数法，只证明上面这条断言有牙）：旧的单反引号配对在同一条正文上
  // 抽不出那个 4 反引号跨度——它把 `` ```` ```json ```` `` 拆成 `""` / `"json"` 之类的垃圾。
  // 于是"跨度数"几乎不变（6092 vs 6091）而**内容全错**，正是 #555 的静默漏检。
  const cnProse = flatten(splitFences(read("cn")).prose);
  const naiveSpans = [...cnProse.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
  assert.equal(
    naiveSpans.includes("```json"),
    false,
    "对照失效：旧配对居然也抽出了那个 4 反引号跨度（那这一格就没在盯东西）",
  );
  assert.ok(
    Math.abs(naiveSpans.length - cnSpans.length) <= 2,
    "对照失效：旧配对在 CN 上的跨度数与新配对差得太多（本仓实测只差 1：6092 vs 6091）",
  );
});

test("F-3 自证不是常数：CN 能力面那句改一个词 ⇒ 审计翻红（原先的盲区现在盯得住）", async () => {
  const original = read("cn");
  const truth = (await auditCapabilityVerdicts(original)).find(
    (verdict) => verdict.id === "capabilities.hooks.onFoldSummary",
  ).truth;
  assert.equal(original.includes(truth), true, "变异锚点必须存在（否则这条自证是空的）");
  // 这句在 CN 契约里位于 `:2715` **之后**——旧分词器的错位区正是从那里开始，所以这格是
  // 「收回主判据」这件事的正面证据：换成旧的 `inlineSpans()` 它数出 0，正向就已经假红了。
  const mutated = original.replace(truth, truth.replace("or omitted", "or undefined"));
  assert.notEqual(mutated, original, "变异必须真的落到文本上");
  const red = await auditCapabilityVerdicts(mutated);
  assert.equal(
    red.find((verdict) => verdict.id === "capabilities.hooks.onFoldSummary").occurrences,
    0,
    "改一个词的 CN 能力面判词必须翻红——处数还是 1 说明判据在拿子串/常数比对",
  );
});
