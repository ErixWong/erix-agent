// @ts-check
// issue #862 修法 A：终局正文「被文本化的工具调用」
// 的**库侧形态识别**（第一块砖）。
//
// 现象（issue #862 的两条真机子 run）：模型经上游/网关把 tool call
// 以**标记**形式吐进
// `content`（而不是 provider 的 `tool_calls` 字段），而引擎只认结构化
// `tool_calls` ⇒ 那一轮
// 在引擎眼里就是「无工具调用 + `end_turn`」，`makeResult`
// 把那一堆标记当成交付物收下、
// run 判 `completed`。用户看到的「最终回复」就是那堆标记 ⇒
// **等于没交报告**，而
// `termination.reason` 仍是正常值（静默降级）。
//
// 本模块只回答一个问题：
// **这段终局正文看起来像不像「被文本化的工具调用」**。
// 它不发事件、不改终态、不碰裁决——`termination` / `finalText` / `rounds` /
// `usage` /
// `verification` 一个字节都不动（把这类终稿接进停门是 issue #862 的修法 B，
// 单开一单）。
//
// ── 为什么特征住在库里（而不是继续只在宿主）
// ──────────────────────────────────
// 宿主 `fde-station` **已经有**这一层（`runner/lib/final-text-toolcall.js`，它的 issue
// #243），
// 但它只有一处调用点、只作用于**顶层 run** 的终局信封 ⇒ `delegate` 子 run
// 的 `resultText`
// 不被识别，一个标记都不带地回给父 run。同一个故障：宿主对自己跑的
// run 会给中性提示，
// 对 delegate 出去的子 run 一声不响。
// 特征集与匹配口径**逐字复用**宿主那五条——
// issue #862 明确禁止在库里发明第二套特征集（两个真相源 ⇒
// 下次换个编码又漏一遍），
// 而宿主那份拷贝按那张票的口径是要删掉的（两个真相源是它写死的禁止项）。
//
// ── 缺省特征集为什么是这五条（**取证在下面，不是拍的**）
// ──────────────────────
// 前**三条**来自宿主 dev 库 `station-db` 的**真实样本**（只读查询，2026-11-16
// 现查）；
// 第四条 `<invoke` 与第五条 `chatcmpl-tool-` 是**预防性覆盖、零实证**
// （下面逐条标了它是实证还是预防——别把预防写成实证）：
//
// 1. `<｜｜DSML｜｜`（U+FF5C ×2 + `DSML` + U+FF5C ×2）——DSML 那一族的**前缀**。
//    样本 A（run `f4dfea1d-c439-…`，2026-10-11，`round_end.payload.final_text` seq 37223，
// `encode(convert_to(...,'UTF8'),'hex')` 逐字核过码点 `3c ff5c ff5c 44 53 4d 4c ff5c ff5c`）
// ：
// `<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="shell">\n<｜｜DSML｜｜parameter
// …`
//    样本 B（run `11fa3c68-353b-…`，2026-09-24，`messages` 行 `0549e113-…`）：
// `<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="shell">…`  ←
// **标记名前多一个空格**
// ⚠ 所以**不能拿 `<｜｜DSML｜｜invoke` 当特征**：样本 A 的第一行是
// `tool_calls`
// （不是 invoke），样本 B 那个标记写作 `<｜｜DSML｜｜ invoke`（带空格）
// ——两条真实样本都
// **命不中**那个字面串。取「到 `｜｜` 为止的前缀」才同时覆盖 `tool_calls`
// / `invoke` /
//    `parameter` 与带空格变体。
// 2. `<tool_call` —— 覆盖 `<tool_calls>` / `<tool_call>` / `<tool_call name=…>`。
// 3. `<｜Function` —— 覆盖 `<｜Function_calls｜>` / `<｜Function=…｜>`
// 一族（同一个 U+FF5C 族）。
// 4. `<invoke` —— XML 那一族（Anthropic/LiteLLM 把 tool call 编成
// `<invoke name="exec">…`）。
//    ⚠ **预防性覆盖，不是实证**：261116 返工现查 dev 库，`<invoke name=` 在
//    `run_events.payload`、`messages.content`、`transcript_rounds(record/messages)` 三处
// **各 0 命中**（同一批查询里 `DSML` 的阴性对照是 6 / 1 / 8 行 ⇒
// 不是查法失效，
// 是库里真没有）。加它的理由只有两条：形态确定（第三方复审在宿主 PR
// #555 上复现了
//    `detect('<invoke name="exec">…') => hit:false`），且**含 `<`、长度 7**，
//    正常交付在代码块**外**裸写它的概率极低（代码块已剥）。
// 5. `chatcmpl-tool-`（**不含 `<`** 的那一族）—— OpenAI/LiteLLM 把 tool call 的
// **id**
// 直接写进 content 时的前缀形态（同一次复审复现
// `detect('…chatcmpl-tool-abc123def456')`
// 在宿主旧特征集下 `hit:false`）。它进不了「条目必须含 `<`」这条规则，
// 而那条规则是
// **防误伤的承重墙**（`off` 会命中 "offset"），所以不是把门槛调低，而是把
// 「**像一个 id 前缀**」写成判据：**不含 `<` 的条目要求长度 ≥12 且含 `-`**
// （`chatcmpl-tool-` 长 14、含 `-` ⇒ 过；`chatcmpl` 长 8 ⇒ 拒；`offset` / `offer` ⇒
// 拒）。
//    ⚠ 同样是**预防性覆盖，不是实证**：`chatcmpl-tool-` 在 `run_events.payload`、
// `messages.content`、`transcript_rounds` 三处**各 0 命中**；`chatcmpl`
// 裸串全库只捞到
// 1 行，且那行是某个 run 用 `writeFile` 写下去的测试脚本正文（`tool_use`
// 载荷，
// 不是终局正文）⇒ 它同时说明「裸 `chatcmpl` 会出现在正常内容里」，
// 这就是为什么进缺省的
//    是**带 `-` 的前缀**而不是短词。
//
// ⚠ **不许只钉 DSML 一条**：这类泄漏的成因是「上游/网关把 tool call 编进
// content」，
// 不同上游的编码不同（issue #862 原文：「只要所用模型的 tool-call
// 编码落到 content…
// 就会复现，不是偶发」）。
//
// ── 匹配口径（误伤面就写在这里）
// ──────────────────────────────────────────────
// · 命中判据 = **逐字子串**（大小写不敏感，U+FF5C 不受大小写影响）。
// 不做位置/结构推断。
// · 匹配前先剥掉
// ``` 围栏代码块与
// `行内代码`：正常交付摘要**引用**这些标记时是写在代码里的
// （本仓的台账/文档就是这么写的），那段是「谈这个标记」
// 不是「泄漏了这个标记」。
//   两条真实样本里都没有反引号（现查），剥代码不会把真泄漏剥掉。
// · 「提到工具名」（「我调用了 shell 工具」）天然不命中：那里面没有
// `<`。
// · 残余误伤面（诚实标注）：正文在代码块**之外**裸写 `<tool_call`
// 这类字面串的正常交付摘要
// 会被判真。本模块的结论只是「值得提示」，不是「失败」
// ——下游一律按**中性提示**渲染。
// · 不做的事：不把 DSML **反解**成结构化调用（issue #862「不做」
// 那一节——那是给上游编码
//   问题在库里写第二种 tool-call 语法），也不引入第二套特征集。

/**
  * 缺省特征集（五条，逐条理由见文件头；**顺序即匹配优先级**，
  * 命中就带回是哪一条）。
  * 前三条是宿主 dev 库真样本（**实证**），第四条 `<invoke` 与第五条
  * `chatcmpl-tool-` 是
 * **预防性覆盖**（库里现查各 0 命中；措辞不许写成实证）。
  * 值域说明：前四条**含 `<`** 且长度 ≥3 ⇒ 形状闸对含 `<`
  * 的条目拒的正是「短于 3」
  * （`<` 会命中一切正文）；第五条**不含 `<`** ⇒ 它靠的是「**长度 ≥12
  * 且含 `-**`」这条形状闸
  * （「像 id 前缀」写成判据），同一个闸挡住 `off` / `chatcmpl` / `offset`
  * 这类短词。
 *
  * ⚠ 与宿主 `runner/lib/final-text-toolcall.js` 的同名常量**逐字相同**：
  * 这条同源由
 * `test/loop-final-text-shape-862.test.js` 钉住（逐条断言，不靠自觉）。
 *
 * @type {readonly string[]}
 */
export const DEFAULT_TOOLCALL_MARKERS = Object.freeze([
  "<｜｜DSML｜｜", "<tool_call", "<｜Function",
  "<invoke",            // XML 一族：**预防性覆盖**（宿主 dev 库现查 0 命中，理由见文件头）
  "chatcmpl-tool-",     // OpenAI 的 tool-call id 前缀：**预防性覆盖**，唯一一条**不含 `<`** 的
]);

/** 含 `<` 的条目至少这么长（`<x` 这种两字符子串会在正文里乱咬）。宿主同名常量同值。 */
const MIN_MARKER_LENGTH = 3;

/**
 * **不含 `<`** 的条目的形状闸（宿主同族规则）：长度 ≥12 **且含 `-`**。
 *
  * 为什么需要它：OpenAI 那一族的特征是 tool-call **id 前缀**（`chatcmpl-tool-`）
  * ，天生不含 `<`，
  * 而「条目必须含 `<`」是防误伤的承重墙（`off` 会命中 "offset"）。
  * 所以不是把门槛调低，
  * 而是把「**像一个 id 前缀**」写成判据：够长 + 带分隔符。
  * 缺省集合里只有第五条走这条路，
  * 而它挡住的是 `off` / `offer` / `chatcmpl`
  * 这类会在正常交付里大面积命中的短词——
 * 每个 run 都刷一条中性提示 = 信号贬值 = 下一次真泄漏没人看。
 */
const MIN_BARE_MARKER_LENGTH = 12;
const BARE_MARKER_REQUIRED_CHAR = "-";

/**
  * 一条特征**能不能拿来匹配**（形状闸）。宿主那一侧把这条闸放在 env
  * 解析期，
  * 本模块没有配置面 ⇒ 闸落在匹配期；对同一份特征集，
  * 两侧给出的裁决一致。
 *
 * @param {unknown} marker 特征条目
 * @returns {boolean}
 */
function markerIsUsable(marker) {
  if (typeof marker !== "string" || marker === "") return false;
  if (marker.length < MIN_MARKER_LENGTH) return false;
  if (marker.includes("<")) return true;
  return marker.length >= MIN_BARE_MARKER_LENGTH
    && marker.includes(BARE_MARKER_REQUIRED_CHAR);
}

/** 剥掉 ``` 围栏与 `行内代码`（见文件头「匹配口径」；两条真实样本都不含反引号）。 */
function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

/**
  * 这段终局正文是不是「被文本化的工具调用」
  * ？命中就带回**是哪一条特征**。
 *
 * @param {unknown} text 终局正文（`result.finalText`）
 * @param {readonly string[]} [markers] 特征集（缺省 = `DEFAULT_TOOLCALL_MARKERS`）
  * @returns {string|null} 命中的那条特征原文；未命中 / 空正文 / 非字符串 ⇒
  * `null`。
  * 空正文与非法入参算**未命中**——「没有正文」是另一件事（#476 的
  * `finalTextFallback` 管）。
 */
export function detectTextualizedToolCall(text, markers = DEFAULT_TOOLCALL_MARKERS) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const haystack = stripCode(text).toLowerCase();
  for (const marker of markers ?? []) {
    if (!markerIsUsable(marker)) continue;
    if (haystack.includes(String(marker).toLowerCase())) return marker;
  }
  return null;
}

/**
 * 把识别结果换算成 **`result` 上的加法字段**（本单唯一的引擎侧出口）。
 *
 * 三条口径（照 #476 `finalTextFallback` 那条链抄，一字不改）：
  * ① **只在命中时给这个键**（缺席 = 没命中）。绝不写 `false`：
  * 那会把「老引擎根本不认识
  * 这个键」与「明确没命中」在宿主载荷上分不开（#442 / #476 的同款理由）
  * 。
 *   ② 命名跟既有 `finalText` 走 camelCase（`result` 面是引擎面，不是 IPC 面）。
  * ③ **不改终态语义**：`termination.reason` / `usage` / `rounds` / `finalText`
  * 一个字节
 *      都不动。命中与否只多带一个形状对象（+ 每 run 至多一条
 *      `final_text_textualized_tool_call` 事件）。
 *
 * @param {unknown} finalText `result.finalText`
  * @param {readonly string[]} [markers] 特征集（调用方传；缺省 =
  * `DEFAULT_TOOLCALL_MARKERS`）
 * @returns {{ finalTextShape?: {textualizedToolCall:true, marker:string} }}
  * 命中 ⇒ 一个键；未命中 / 空正文 / 非字符串 ⇒
  * **空对象**（一个字节都不多带）。
 */
export function textualizedToolCallField(finalText, markers = DEFAULT_TOOLCALL_MARKERS) {
  const marker = detectTextualizedToolCall(finalText, markers);
  if (marker === null) return {};
  return { finalTextShape: { textualizedToolCall: true, marker } };
}
