// issue #609：单条内容超预算被截断时，**必须让模型看见「被截了」并能自己续读**。
//
// 三种「内容丢失」里这是最后一种静默的：
//   · 字段被修剪 ⇒ `prunedFieldText()` 写 `## 标题\n[已修剪]`（#469）；
//   · 整条消息被删 ⇒ `safeTruncateMessages` 的 `stubFor` 写桩；
//   · 单条被截断 ⇒ 以前返回裸 `characters.slice(0, low).join("")`，模型拿着半截结果
//     却不知道自己被砍了（票面实测：119k 字符文档、5 条事实 0 命中）。
//
// 本文件钉的是 `truncateTextToBudget()` 这一处收口的四条不变量：
//   ① 标记可见且**报数字**（原文字符数 / 原文 token / 保留字符与 token / 被砍 token）；
//   ② `estimateTokens(返回值) <= budgetTokens`（标记自己占预算，二分在
//      `budgetTokens − TRUNCATION_MARKER_RESERVE_TOKENS` 上做 —— 否则 #846 那一族原样回来）；
//   ③ 码点安全（切点只落码点边界，不劈开代理对）；
//   ④ **没被截断的内容一个字节都不变**；
//   ⑤ 复审 ①：被截到只剩标记前缀时，**「被截断」这句话仍要在最前面**（判据词 `截断`
//      占住第 1～2 个码点）—— G9 / G9b 钉的就是这一条，旧形状（`budget=5 → "[本条"`）当场红。
// 外加：标记确定性、措辞与聚合桩同源（`NO_RERUN_SIDE_EFFECT_CLAUSE`）、以及
// 「这一格在安全层里是最后一道」的可达面事实（G7/G8 —— 免得下一个读者以为标记天天出场）。
//
// ⚠ 可达面（G8 钉住）：安全层第一步是**整轮删除**，字段级截断只在「轮删不动 + 字段仍超预算」
// 时到场 ⇒ 本文件的判据主要**直接钉函数**，不靠安全层路径凑（那条路径多半到不了这一格）。
import assert from "node:assert/strict";
import test from "node:test";

import { estimateTokens } from "../src/tokens.js";
import { NO_RERUN_SIDE_EFFECT_CLAUSE, aggregateStubText } from "../src/loop/aggregate-budget.js";
import {
  TRUNCATION_JUDGE_WORD,
  TRUNCATION_JUDGE_WORD_TOKENS,
  TRUNCATION_MARKER_RESERVE_TOKENS,
  TRUNCATION_READ_BACK_CLAUSE,
  safeTruncateMessages,
  truncateTextToBudget,
  truncationMarkerText,
} from "../src/loop/budget.js";

/** 一份「中文 + ASCII」混合的长文（票面那一份的形状：远超预算的单个工具结果）。 */
function bigDocument(repeats = 4000) {
  return ("中文文档内容 mixed ascii filler line " + "x".repeat(60) + "\n").repeat(repeats);
}

/** 码点安全的判据：孤立代理对在 UTF-8 往返里会变成 U+FFFD，回来就不等于原串。 */
function hasLoneSurrogate(text) {
  return Buffer.from(text, "utf8").toString("utf8") !== text;
}

/** 标记在返回值里的起点（判据词就是标记的第一个字，复审 ①）。 */
function markerStartOf(text) {
  const index = text.indexOf(TRUNCATION_JUDGE_WORD);
  assert.ok(index >= 0, `返回值里找不到判据词：${text.slice(0, 60)}`);
  return index;
}

/** 把标记里那四个数字取回来（逐字解析，断言的是模型真能读到的数，不是内部变量）。 */
function markerNumbers(marker) {
  const matched = /原文共 (\d+) 字符 ≈ (\d+) token，此处仅保留前 (\d+) 字符 ≈ (\d+) token，被砍掉约 (\d+) token/u;
  const hit = matched.exec(marker);
  assert.ok(hit !== null, `标记里没有那五个数字：${marker.slice(0, 120)}`);
  return hit.slice(1).map((value) => Number(value));
}

test("G1 截断后尾部带标记，且报的是真数字（原文/保留/被砍，逐一对得上）", () => {
  const value = bigDocument();
  const out = truncateTextToBudget(value, 4096);
  assert.notEqual(out, value, "超预算必须被截");
  assert.match(out, /\[本条内容已超上下文预算，尾部已被引擎截断：/u, "模型必须看见「被截了」");

  const markerStart = markerStartOf(out);
  const keptText = out.slice(0, markerStart);
  const marker = out.slice(markerStart);
  const [originalChars, originalTokens, keptChars, keptTokens, droppedTokens] = markerNumbers(marker);

  assert.equal(originalChars, Array.from(value).length, "原文字符数 = 码点数（与函数内部同口径）");
  assert.equal(originalTokens, estimateTokens(value), "原文 token 用同一个 estimateTokens");
  assert.equal(keptChars, Array.from(keptText).length, "保留字符数与真实保留的前缀一致");
  assert.equal(keptTokens, estimateTokens(keptText), "保留 token 与真实保留的前缀一致");
  assert.equal(droppedTokens, originalTokens - keptTokens, "被砍掉的 token 让模型能自己算还要读几段");
  assert.ok(droppedTokens > 0, "真有内容被砍才报这个数字");
});

test("G2 标记给可执行的续读指引：工具无关（readFile 与 exec 都在场），且不许硬写 note_* 工具名", () => {
  const marker = truncateTextToBudget(bigDocument(), 4096);
  assert.match(marker, /offset\/limit/u, "readFile 的分段续读入参要点名");
  assert.match(marker, /head\/tail\/sed/u, "模型可能用的是 exec ⇒ 那一侧也要有指引");
  assert.match(marker, /只读方式分段取回/u);
  assert.match(marker, /写过笔记/u, "笔记那条退路要留（条件式）");
  // #746 的口径：这一层既拿不到装配后的工具面、也拿不到笔记账本 ⇒ 不许指挥模型去调
  // 一个可能不在场上的工具（票面里模型就是自己去猜了不存在的 `note_list`）。
  assert.equal(/note_(take|list|read|forget)/u.test(marker), false, "标记里不许硬写 note_* 工具名");
  assert.ok(
    marker.includes(TRUNCATION_READ_BACK_CLAUSE),
    "指引本体是那条常量，不是散在文案里的第二份措辞",
  );
});

test("G3 标记本身占预算：加完标记后 estimateTokens(返回值) <= budgetTokens（含极端小预算）", () => {
  const value = bigDocument();
  for (const budget of [1, 2, 5, 20, 100, 319, 320, 321, 400, 600, 1000, 4096, 64000]) {
    const out = truncateTextToBudget(value, budget);
    assert.ok(
      estimateTokens(out) <= budget,
      `budget=${budget} 时返回值 ${estimateTokens(out)} token，超出预算（先截后贴就是这么回来的）`,
    );
  }
});

test("G3b 反向证：这条预算判据不是恒绿 —— 先截后贴（旧写法）确实会超预算", () => {
  const value = bigDocument();
  const characters = Array.from(value);
  for (const budget of [1000, 4096, 64000]) {
    // 旧算法：二分把**整条预算**给正文，再把标记贴上去。
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (estimateTokens(characters.slice(0, middle).join("")) <= budget) low = middle;
      else high = middle - 1;
    }
    const kept = characters.slice(0, low).join("");
    const pasted = kept + truncationMarkerText({
      originalChars: characters.length,
      originalTokens: estimateTokens(value),
      keptChars: low,
      keptTokens: estimateTokens(kept),
    });
    assert.ok(
      estimateTokens(pasted) > budget,
      `budget=${budget}：先截后贴只有 ${estimateTokens(pasted)} token ⇒ G3 那一格抓不住回归`,
    );
  }
});

test("G3c 二分确实跑在 `budgetTokens − 标记额度` 上：正文只拿让出额度之后那块", () => {
  const budget = 4096;
  const out = truncateTextToBudget(bigDocument(), budget);
  const markerStart = markerStartOf(out);
  const keptTokens = markerNumbers(out.slice(markerStart))[3];
  const allowance = budget - TRUNCATION_MARKER_RESERVE_TOKENS;
  // 二分取的是「不超过额度」的最长前缀：拿满了额度（码点粒度内），又不多吃。
  // 把二分改回「用整条预算截、再贴标记」时 keptTokens ≈ budget ⇒ 这一格红，
  // 即使那边还有个「整段再截一次」的兜底把 G3 的预算不变量抹平。
  assert.ok(
    keptTokens <= allowance,
    `正文吃了 ${keptTokens} token，超出额度 ${allowance} ⇒ 二分没在让出标记额度后的预算上做`,
  );
  assert.ok(
    keptTokens >= allowance - 4,
    `正文只吃了 ${keptTokens} token，额度 ${allowance} 没用满 ⇒ 额度算术多让了`,
  );
});

test("G4 标记额度够用：极端数字下标记仍 <= TRUNCATION_MARKER_RESERVE_TOKENS", () => {
  const widest = truncationMarkerText({
    originalChars: Number.MAX_SAFE_INTEGER,
    originalTokens: Number.MAX_SAFE_INTEGER,
    keptChars: Number.MAX_SAFE_INTEGER,
    keptTokens: Number.MAX_SAFE_INTEGER,
  });
  assert.ok(
    estimateTokens(widest) <= TRUNCATION_MARKER_RESERVE_TOKENS,
    `标记 ${estimateTokens(widest)} token 超出额度 ${TRUNCATION_MARKER_RESERVE_TOKENS}`
    + " ⇒ 二分给标记留的空间不够，G3 那一格会在真输入上变红",
  );
});

test("G5 码点安全：切点只落码点边界，绝不劈开代理对", () => {
  const astral = "😀🧠".repeat(4000);
  for (const budget of [1, 3, 7, 50, 200, 300, 330, 1000, 5000, 64000]) {
    const out = truncateTextToBudget(astral, budget);
    assert.equal(hasLoneSurrogate(out), false, `budget=${budget} 的返回值里有孤立代理对`);
    assert.ok(
      Array.from(out).join("") === out,
      `budget=${budget}：返回值不是合法码点串`,
    );
  }
  // 正文前缀 + 整段标记这一条组合路径也要码点安全（标记接在截断点之后）。
  const mixed = "😀".repeat(300) + bigDocument(200);
  for (const budget of [400, 900, 2000]) {
    const out = truncateTextToBudget(mixed, budget);
    assert.equal(hasLoneSurrogate(out), false, "接在截断点之后的标记劈开了代理对");
  }
});

test("G6 没被截断的内容一个字节都不变（不给正常内容加任何前后缀）", () => {
  const value = "普通的一行内容 with some ascii";
  assert.equal(truncateTextToBudget(value, 10_000), value);
  // 正好等于预算那一格也算「没被截」：不许贴标记。
  const exact = estimateTokens(value);
  assert.equal(truncateTextToBudget(value, exact), value);
  assert.equal(truncateTextToBudget("", 10), "");
  assert.equal(truncateTextToBudget(undefined, 10), "");
  for (const text of ["x", "中文", "😀", JSON.stringify({ a: 1 })]) {
    assert.equal(truncateTextToBudget(text, 1000), text);
  }
});

test("G6b 标记确定性：同一输入两次调用逐字相同（无时间戳、无随机）", () => {
  const value = bigDocument(600);
  assert.equal(truncateTextToBudget(value, 800), truncateTextToBudget(value, 800));
  const facts = {
    originalChars: 1234, originalTokens: 567, keptChars: 89, keptTokens: 12,
  };
  assert.equal(truncationMarkerText(facts), truncationMarkerText(facts));
  assert.equal(
    truncationMarkerText(facts),
    truncationMarkerText({ ...facts }),
    "标记只由那四个数字决定",
  );
});

test("G7 措辞与聚合桩同源：两侧共用 NO_RERUN_SIDE_EFFECT_CLAUSE，聚合桩文案逐字未变", () => {
  const out = truncateTextToBudget(bigDocument(), 4096);
  assert.ok(out.includes(NO_RERUN_SIDE_EFFECT_CLAUSE), "截断标记里那句要与聚合桩逐字同一份");
  const stub = aggregateStubText({ round: 3, length: 90_000 });
  assert.ok(stub.includes(NO_RERUN_SIDE_EFFECT_CLAUSE), "聚合桩改抽常量后仍要说同一句");
  // 重构不许动模型真正读到的句子：聚合桩的结尾逐字钉住。
  assert.ok(
    stub.endsWith(NO_RERUN_SIDE_EFFECT_CLAUSE + "]"),
    `聚合桩结尾变了：${stub.slice(-140)}`,
  );
  assert.match(stub, /本轮工具输出已超单轮聚合预算：完整输出已由引擎归档（第 3 轮，共 90000 字符）。/u);
  assert.match(stub, /不要仅凭截断输出判断成败/u);
});

test("G8 安全层：预算宽松时逐字不动，且第一步是整轮删除而不是字段截断（标记不是天天出场）", async () => {
  const value = bigDocument();
  const messages = [
    { role: "user", content: "读一下大文档" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "readDoc", input: {} }] },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: value }],
    },
  ];
  // ① 预算宽松：安全层一个字都不许动（既有用例的形状，也钉住「未截断不加前后缀」）。
  const roomy = await safeTruncateMessages(messages, 1_000_000, undefined, undefined);
  assert.deepEqual(roomy.messages, messages);
  assert.equal(JSON.stringify(roomy.messages).includes("已被引擎截断"), false);

  // ② 超预算 + 未保护：安全层第一步是**整轮删除**（走 `stubFor`），不是把字段截成前缀。
  //    这一格钉的是架构事实：字段级截断是最后一道，G1～G6 因此直接钉函数本体。
  const tight = await safeTruncateMessages(messages, 64_000, undefined, undefined);
  assert.equal(
    JSON.stringify(tight.messages).includes("已被引擎截断"),
    false,
    "这一格的形状走的是整轮删除；若哪天改成字段截断，这里要跟着改并补标记断言",
  );
  assert.ok(tight.tokensAfter <= 64_000);
});

test("G9 极小预算既不静默也不超预算：返回值是标记自己的前缀，判据词排最前（复审 ①）", () => {
  const value = bigDocument(200);
  // 兑底分支里正文会被让到 0 ⇒「整段」就是这条零保留的标记，拿它当前缀尺子。
  const marker = truncationMarkerText({
    originalChars: Array.from(value).length,
    originalTokens: estimateTokens(value),
    keptChars: 0,
    keptTokens: 0,
  });
  // 结构守卫：判据词必须在标记**开头**（否则下面「前缀也带判据词」的断言名不副实）。
  assert.ok(marker.startsWith(TRUNCATION_JUDGE_WORD), `标记没以判据词开头：${marker.slice(0, 24)}`);

  for (const budget of [1, 2, 5, 10, 20, 64, TRUNCATION_JUDGE_WORD_TOKENS]) {
    const out = truncateTextToBudget(value, budget);
    assert.ok(estimateTokens(out) <= budget, `budget=${budget} 超预算`);
    assert.equal(hasLoneSurrogate(out), false, `budget=${budget} 勬开代理对`);
    // 收紧（旧断言 `"["` 也能过）：返回值只能是**标记自己的**前缀，不能是一段内容前缀。
    assert.ok(
      marker.startsWith(out),
      `budget=${budget} 返回值不是标记的前缀 ⇒ 又回到静默截断：${JSON.stringify(out)}`,
    );
    if (budget >= TRUNCATION_JUDGE_WORD_TOKENS) {
      // 只要求「装得下判据词」那一格起：输出里必须有「截断」二字，且就在开头。
      assert.ok(
        out.startsWith(TRUNCATION_JUDGE_WORD) && out.includes("截断"),
        `budget=${budget} 的返回值里没有判据词“截断” ⇒ 模型看不出内容被截过：`
        + JSON.stringify(out),
      );
    } else {
      // 物理下限那一格（见 G9b）：只能带走判据词自己的前缀（“截”），绝不是内容片段。
      assert.ok(
        TRUNCATION_JUDGE_WORD.startsWith(out),
        `budget=${budget} 返回了判据词以外的片段：${JSON.stringify(out)}`,
      );
    }
  }
});

test("G9b 判据词的开销 = 4 token：预算 1/2/3 的取舍写死，不留没有用例覆盖的静默分支（复审 ①）", () => {
  // 本估算器下**一个汉字值 2 token**（tokens.js：cjkTokensPerChar 1.5 × margin 1.15 后取整）
  // ⇒ 判据词「截断」要 4 token，这是「模型能看见『截断』二字」的最低预算。
  assert.equal(estimateTokens("截"), 2);
  assert.equal(TRUNCATION_JUDGE_WORD_TOKENS, 4);

  const value = bigDocument(200);
  const ladder = [1, 2, 3, 4, 5].map((budget) => truncateTextToBudget(value, budget));
  // 逐字钉住退化阶梅：估算器系数若变了，这一格要按它现报的值改——它钉的就是当前实测的
  // 物理下限，不是凑数。
  assert.deepEqual(
    ladder,
    ["", "截", "截", "截断[", "截断["],
    `退化阶梅变了：${JSON.stringify(ladder)}`,
  );
  // 取舍（写在这里，不留没名的静默分支）：
  //   · 预算 1 连一个汉字都装不下（1 个汉字 = 2 token）⇒ 返回空串。宁可不给字，也不给
  //     一段「看起来像正常内容」的裸前缀（那才是 #609 的原始缺陷形状），而超预算会把 #846
  //     那族 `budgetUnreachable` 原样引回来；
  //   · 预算 2、3 只能带走判据词的第一个字「截」（仍是标记的最开头，不是内容）；
  //   · 预算 >= 4 起必有完整的「截断」（G9 逐格钉）——旧文案里该二字要 ~40 token 才露出来。
  assert.ok(estimateTokens(ladder[0]) <= 1, "预算 1 不能超预算");
  assert.ok(ladder[1].length === 1 && ladder[2].length === 1, "预算 2/3 只剩判据词首字");
  assert.ok(ladder[3].includes("截断"), "预算 4 起必须完整说出‘截断’");
});

test("G10 反复截断不膨胀：在已带标记的文本上再截一次仍 <= 预算", () => {
  const value = bigDocument();
  const once = truncateTextToBudget(value, 1200);
  const twice = truncateTextToBudget(once, 1200);
  assert.ok(estimateTokens(twice) <= 1200);
  assert.ok(estimateTokens(twice) <= estimateTokens(once), "同一预算反复过这一格只会更短，不会越长越大");
});
