// 模型输出归一化底座（issue #406 B2-a）：`src/normalization/parse-model-json.js` 的单测。
//
// 逐条对着任务书的 7 条硬要求写，另外两格是主 agent 追加的：
//   · 「两层确实分层」：同一段含非法转义的输入喂两个入口 ⇒ L0 仍 `unparsable`、归一化入口成功且值逐字等于原文；
//   · 「闸门对谁判」的变异级用例：宿主注入一条**会改字节**的修复器（jsonrepair 式删反斜杠），
//     闸门必须把那条值判掉；反向证里同时钉住「若闸门看的是修后文本，这格会被放行」——于是这格写反就红。
//
// 合并前评审（PR #443）补的五类看守，每一条都先红后绿：
//   · 补全档的闸门同样判**补全前**原文（往补全规则里插 `__FABRICATED__` ⇒ 必须判掉）；
//   · 候选集复用 L0 的平衡对象扫描（散文前缀 / 后缀 / 对象后跟垃圾）；
//   · 截断判据按「**任一**候选是截断形状」（多候选时 `every` 会把围栏里的截断报成 `unparsable`）；
//   · 补全档串联规则表 ⇒ 围栏里的截断（含未闭合围栏）与「截断 + 非法转义」真救得回来；
//   · 候选为空时 `llm:true` 一次请求都不发。
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeModelJson } from "../../src/normalization/parse-model-json.js";
import { parseModelJson } from "../../src/text/parse-model-json.js";
import { NORMALIZATION_REASONING_EFFORT } from "../../src/reflection/wrapup.js";
import { DEFAULT_REPAIR_RULE_IDS, REPAIR_RULES, repairJsonText } from "../../src/text/repair-json.js";
import { exampleToolArguments } from "../../src/messages/tool-arguments.js";

/** 模型在 JSON 串里写了正则风格的 `\.`：合法 JSON 转义里没有它（issue #406 的真事故现场）。 */
const ILLEGAL_ESCAPE = String.raw`{"api":"http\.request","done":true}`;

/** jsonrepair 式「删反斜杠」：**会改字节**，正是闸门必须拦住的那一类宿主修复器。 */
const HOST_UNESCAPE_RULE = {
  id: "host-unescape",
  apply: (text) => text.replace(/\\\./g, "."),
};

/** 「值必须逐字出现在候选原始字节里」这道闸门的最小实现（宿主侧照抄的形态）。 */
function verbatimGate(keys) {
  const seen = [];
  return {
    seen,
    validate(value, source) {
      seen.push(source);
      const missing = keys.filter((key) => {
        const text = value?.[key];
        return typeof text === "string" && !source.includes(text);
      });
      return missing.length === 0 ? { ok: true } : { ok: false, dropped: missing };
    },
  };
}

/** 记录请求、按序回放的 L2 provider 桩（canonical 响应形状）。 */
function stubProvider(replies) {
  const requests = [];
  return {
    requests,
    provider: {
      async chat(request) {
        requests.push(request);
        const reply = replies.shift();
        if (reply === undefined) throw new Error("L2 被调用的次数超过预期");
        return { content: [{ type: "text", text: reply }] };
      },
    },
  };
}

// ── 硬要求 1：复用 B1（不复制修复器）────────────────────────────────────────────

test("L1 就是 B1 的规则表：生效的 rule id 全在 REPAIR_RULES 里，且非法转义是「加倍」不是「删除」", async () => {
  const result = await normalizeModelJson(ILLEGAL_ESCAPE);
  assert.equal(result.ok, true);
  assert.equal(result.repaired?.trusted, true);
  assert.equal(result.repaired?.rule, "invalid-escape");
  for (const id of String(result.repaired?.rule).split("+")) {
    assert.ok(REPAIR_RULES.some((rule) => rule.id === id), `未知规则 id：${id}`);
  }
  // B1 的承重墙：值仍是原文里逐字存在的一段（jsonrepair 会给出 `http.request`，那就不是原文的子串）。
  assert.equal(result.value.api, String.raw`http\.request`);
  assert.ok(ILLEGAL_ESCAPE.includes(result.value.api));
  // 默认规则集就是 B1 的默认集（本模块不另立一套默认值）。
  const fenced = await normalizeModelJson("```json\n{'a': 1,}\n```");
  assert.equal(fenced.ok, true);
  assert.deepEqual(
    String(fenced.repaired?.rule).split("+"),
    DEFAULT_REPAIR_RULE_IDS.filter((id) => ["code-fence", "single-quotes", "trailing-comma"].includes(id)),
  );
});

// ── 硬要求 2：多候选（整段原文 + 按顺序每个围栏块）──────────────────────────────

test("候选顺序：整段原文 → 围栏块 1 → 围栏块 2；第一个「可解析 + 过闸门」者胜出", async () => {
  const gate = { validate: (value) => ({ ok: value?.tag === "wanted" }) };
  const text = [
    "先说明一下思路。",
    "```json",
    '{"tag":"first-fence"}',
    "```",
    "再看这一段：",
    "```json",
    '{"tag":"wanted"}',
    "```",
  ].join("\n");
  const result = await normalizeModelJson(text, gate);
  assert.equal(result.ok, true);
  assert.equal(result.value.tag, "wanted", "前两个候选（散文整段、第一个围栏）都不过闸门，第三个胜出");
});

test("候选按出现顺序：整段原文排在围栏块之前（原文自己就合法时不看围栏）", async () => {
  // 围栏符号本身在 JSON 字符串里：整段原文是合法 JSON，围栏块体也是合法 JSON，原文必须先胜出。
  const text = `{"tag":"raw","note":"\`\`\`json\\n{\\"tag\\":\\"fence\\"}\\n\`\`\`"}`;
  const result = await normalizeModelJson(text);
  assert.equal(result.ok, true);
  assert.equal(result.value.tag, "raw");
});

test("围栏块体是独立候选（去围栏符）：围栏里的 JSON 能被 L1 修好，整段原文修不了", async () => {
  const text = "说明\n```json\n{\"a\": 1,}\n```";
  const result = await normalizeModelJson(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { a: 1 });
  assert.equal(result.repaired?.rule, "trailing-comma");
  assert.equal(result.repaired?.trusted, true);
});

// ── 硬要求 3：闸门永远对候选的原始字节判（变异级用例）──────────────────────────

test("闸门对**候选原始字节**判：宿主注入会改字节的修复器时，那条值必须被判掉", async () => {
  const gate = verbatimGate(["api"]);
  const result = await normalizeModelJson(ILLEGAL_ESCAPE, {
    validate: gate.validate,
    repair: { inject: [HOST_UNESCAPE_RULE] },
  });
  // 宿主规则把 `http\.request` 改成 `http.request`（解析得出来，但原文里没有这一串）⇒ 闸门必须拒。
  assert.equal(result.ok, false, `被改写的值不许静默接受：${JSON.stringify(result)}`);
  assert.equal(result.error, "shape_mismatch");
  // 闸门看到的永远是**原文**，不是修后文本。
  assert.deepEqual(gate.seen, [ILLEGAL_ESCAPE]);
});

test("反向证（这格写反就红）：同一个 fixture 上「对修后文本判」会把原文里不存在的值放行", async () => {
  const gate = verbatimGate(["api"]);
  // 宿主规则把 `http\.request` 改成 `http.request`（删反斜杠 = 改了字节）。
  const rewritten = HOST_UNESCAPE_RULE.apply(ILLEGAL_ESCAPE);
  const rewrittenValue = JSON.parse(rewritten);
  assert.equal(rewrittenValue.api, "http.request");
  // 正确的判据：原文里找不到被改写的值 ⇒ 这一条必须被丢掉。
  assert.equal(ILLEGAL_ESCAPE.includes(rewrittenValue.api), false, "fixture 必须能区分「原文」与「修后文本」");
  assert.equal(gate.validate(rewrittenValue, ILLEGAL_ESCAPE).ok, false);
  // 写反的实现（把 `source` 传成修后文本）会在这里放行 —— 于是上面那格就红了。
  assert.equal(gate.validate(rewrittenValue, rewritten).ok, true);
});

test("围栏候选的「原始字节」是围栏块体本身（不是整段原文，也不是修后文本）", async () => {
  const gate = verbatimGate(["api"]);
  const body = String.raw`{"api":"http\.request"}`;
  const result = await normalizeModelJson(`说明\n\`\`\`json\n${body}\n\`\`\``, { validate: gate.validate });
  assert.equal(result.ok, true);
  assert.equal(gate.seen.at(-1), body);
});

// 合并前评审 blocker 1：补全版候选的 `source` 必须是**补全前**原文。
// 变异敏感点：把补全规则改成插一个伪造字符串值 ⇒ 下面第一格必须变红（原先 30/30 全绿）。
test("补全档的闸门同样判**补全前**原文：补全规则伪造的字符串值必须被判掉", async () => {
  const gate = verbatimGate(["a"]);
  const result = await normalizeModelJson('{"a":', { validate: gate.validate, repair: { truncateCompletion: true } });
  // 今天 truncation 只补结构（这里补出来的是 null），所以正常规则下这一格是命中。
  assert.equal(result.ok, true, `补全档正常工作时应当命中：${JSON.stringify(result)}`);
  // 闸门看到的是补全**前**的原文，不是 `{"a":null}`。
  assert.deepEqual(gate.seen, ['{"a":'], "闸门必须看到补全前的原文");

  // 反向证（这格写反就红）：补全规则一旦伪造一个字符串值，闸门必须判掉。
  // 判据是「原文里有没有这一串」：补全后的文本里有、补全前的原文里没有。
  const fabricated = "__FABRICATED__";
  assert.equal(gate.validate({ a: fabricated }, `{"a":"${fabricated}"}`).ok, true, "拿补全后文本当 source 会放行伪造值");
  assert.equal(gate.validate({ a: fabricated }, '{"a":').ok, false, "拿补全前原文当 source 必须判掉伪造值");
});

// 合并前评审 blocker 2：候选集必须复用 L0 的平衡对象扫描（D1：调 L0，不复制扫描）。
// 三格分别对应「散文前缀」「散文后缀」「对象后跟垃圾」——修前全红（L0 `ok`、本入口 `unparsable`）。

test("候选集复用 L0 扫描：散文前缀不影响抠取（`好的，结果如下：{…}`）", async () => {
  const text = '好的，结果如下：{"done":true}';
  assert.equal(parseModelJson(text).ok, true, "L0 能抠出来");
  const result = await normalizeModelJson(text);
  assert.equal(result.ok, true, `新入口不许比它包装的 L0 更弱：${JSON.stringify(result)}`);
  assert.deepEqual(result.value, { done: true });
  assert.equal("repaired" in result, false, "只是抠取，不该有修复出处");
});

test("候选集复用 L0 扫描：散文后缀不影响抠取（`{…} 以上是结果。`）", async () => {
  const text = '{"done":true} 以上是结果。';
  assert.equal(parseModelJson(text).ok, true, "L0 能抠出来");
  const result = await normalizeModelJson(text);
  assert.equal(result.ok, true, `新入口不许比它包装的 L0 更弱：${JSON.stringify(result)}`);
  assert.deepEqual(result.value, { done: true });
});

test("候选集复用 L0 扫描：对象后跟垃圾不影响抠取（`{…}}extra{`）", async () => {
  const text = '{"a":1}}extra{';
  assert.equal(parseModelJson(text).ok, true, "L0 能抠出来");
  const result = await normalizeModelJson(text);
  assert.equal(result.ok, true, `新入口不许比它包装的 L0 更弱：${JSON.stringify(result)}`);
  assert.deepEqual(result.value, { a: 1 });
});

// ── 硬要求 4：截断输入（候选数 0）──────────────────────────────────────────────

test("截断输入：truncateCompletion 关 ⇒ no_candidate（与今天的观察面一字不差）", async () => {
  for (const text of ['{"a":1', '{"a":{"b":2', '{"a":"unterminated']) {
    const result = await normalizeModelJson(text);
    assert.equal(result.ok, false, text);
    assert.equal(result.error, "no_candidate", `截断输入必须是 no_candidate：${text} → ${JSON.stringify(result)}`);
    // 与 #307 的 L0 同一个答案（不是「看起来差不多」，是逐字相等）。
    assert.equal(parseModelJson(text).error, "no_candidate", `L0 对同一输入的答案：${text}`);
  }
});

test("截断输入：truncateCompletion 开 ⇒ 补全后的候选当**额外**候选追加在末尾", async () => {
  const result = await normalizeModelJson('{"a":1', { repair: { truncateCompletion: true } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { a: 1 });
  assert.equal(result.repaired?.rule, "truncation");
  assert.equal(result.repaired?.trusted, true);

  // 「额外」= 追加在末尾，不抢原文的位置：本来就完整的输入仍然由原文胜出，且不出现 repaired。
  const complete = await normalizeModelJson('{"a":1}', { repair: { truncateCompletion: true } });
  assert.equal(complete.ok, true);
  assert.equal("repaired" in complete, false);

  // 围栏里的截断（模型最常写的形态）也救得回来：补全版排在原候选之后。
  const fenced = await normalizeModelJson("说明\n```json\n{\"a\":1\n```", { repair: { truncateCompletion: true } });
  assert.equal(fenced.ok, true);
  assert.deepEqual(fenced.value, { a: 1 });
  assert.equal(fenced.repaired?.rule, "truncation");
});

test("空输入 ⇒ no_candidate（候选数为 0 的另一档）", async () => {
  for (const text of ["", "   \n\t "]) {
    const result = await normalizeModelJson(text);
    assert.equal(result.ok, false);
    assert.equal(result.error, "no_candidate");
  }
});

// 合并前评审 blocker 3（a）：截断判据按「**任一**候选是截断形状」，不是「全都」。
// 修前这一格是红的：多候选时 `every` 会把围栏里的截断报成 `unparsable`（L0 报 `no_candidate`）。
test("截断判据按「任一候选」算：围栏里的截断与 L0 同答 no_candidate", async () => {
  for (const text of ["说明\n```json\n{\"a\":1\n```", "说明\n```json\n{\"a\":1", '说明\n```json\n{"a":"x\\.y"']) {
    const strict = parseModelJson(text);
    assert.equal(strict.ok, false, text);
    assert.equal(strict.error, "no_candidate", `L0 的答案：${text}`);
    const result = await normalizeModelJson(text);
    assert.equal(result.ok, false, text);
    assert.equal(result.error, "no_candidate", `多候选时按「任一」算：${text} → ${JSON.stringify(result)}`);
  }
});

// 合并前评审 blocker 3（b）：补全档与规则表**串联**跑，围栏里的截断真救得回来。
// 修前三格全红（补全要求「补完即 JSON.parse」，而单跑 truncation 不吃非法转义、也不认未闭合围栏）。
test("补全档救得回围栏里的截断（含未闭合围栏）与「截断 + 非法转义」", async () => {
  const cases = [
    ["围栏内截断", "说明\n```json\n{\"a\":1\n```", { a: 1 }, "truncation"],
    ["未闭合围栏", "说明\n```json\n{\"a\":1", { a: 1 }, "truncation"],
    ["截断 + 非法转义", '{"a":"x\\.y"', { a: String.raw`x\.y` }, "invalid-escape+truncation"],
    ["围栏内截断 + 非法转义", '说明\n```json\n{"a":"x\\.y"', { a: String.raw`x\.y` }, "invalid-escape+truncation"],
  ];
  for (const [label, text, value, rule] of cases) {
    const result = await normalizeModelJson(text, { repair: { truncateCompletion: true } });
    assert.equal(result.ok, true, `${label} 必须救得回来：${JSON.stringify(result)}`);
    assert.deepEqual(result.value, value, label);
    assert.equal(result.repaired?.rule, rule, `${label} 的出处必须点名生效的规则：${JSON.stringify(result)}`);
    assert.equal(result.repaired?.trusted, true, label);
  }
});

// 合并前评审 blocker 3 的边界：这一档**救不回来**，如实钉住（契约中英都写着，不许留假话）。
test("已知边界：散文前缀 + 截断 ⇒ 本入口 unparsable，L0 no_candidate（补全档也救不回）", async () => {
  const text = '前言 {"a":1';
  assert.equal(parseModelJson(text).error, "no_candidate", "L0 靠「括号不配对」认出截断");
  const plain = await normalizeModelJson(text);
  assert.equal(plain.ok, false);
  assert.equal(plain.error, "unparsable", "候选集里没有一段能被补全规则改写的片段");
  const completed = await normalizeModelJson(text, { repair: { truncateCompletion: true } });
  assert.equal(completed.ok, false);
  assert.equal(completed.error, "unparsable", "补全要求「补完即 JSON.parse」，散文前缀不是结构字符");
});

// 合并前评审 blocker 4：候选为空 ⇒ 一次请求都不发（原先空串会白烧 1 个请求 + `llmUsed:true`）。
test("候选为空时一次请求都不发（空输入 / 纯空白 + llm:true）", async () => {
  for (const text of ["", "   \n\t "]) {
    let requests = 0;
    const provider = {
      async chat() {
        requests += 1;
        return { content: [{ type: "text", text: '{"done":true}' }] };
      },
    };
    const result = await normalizeModelJson(text, { provider, llm: true });
    assert.equal(requests, 0, `候选为空不许发请求：${JSON.stringify(text)}`);
    assert.equal(result.ok, false);
    assert.equal(result.error, "no_candidate");
    assert.equal("llmUsed" in result, false, "没发请求就不许声称用过 L2");
  }
});

// ── 硬要求 5：L2（llm 唯一开关 / 恒定 reasoning_effort / 仍过同一道闸门）────────

test("L2 只在 L1 全败且 llm:true 时才发请求；请求恒定带 reasoning_effort", async () => {
  const { provider, requests } = stubProvider(['{"done":true}']);
  const hit = await normalizeModelJson('{"done":true}', { provider, llm: true });
  assert.equal(hit.ok, true);
  assert.equal(requests.length, 0, "L1 命中就不许发请求");
  assert.equal("llmUsed" in hit, false);

  const missed = await normalizeModelJson("纯散文，没有任何 JSON", { provider, llm: true });
  assert.equal(missed.ok, true);
  assert.equal(missed.llmUsed, true);
  assert.deepEqual(missed.value, { done: true });
  assert.equal(requests.length, 1);
  // 取值引用 wrapup 的唯一字面量，不在本模块里另写一份。
  assert.equal(requests[0].reasoning_effort, NORMALIZATION_REASONING_EFFORT);
  assert.equal(requests[0].reasoning_effort, "none");
  assert.equal("maxTokens" in requests[0], false, "不给 maxTokens 就不许新造默认值");
  assert.equal(requests[0].messages[0].content[0].type, "text");
  assert.match(requests[0].messages[0].content[0].text, /纯散文，没有任何 JSON/);
});

test("thinking:\"inherit\" ⇒ 不发 reasoning_effort 字段；其它取值直接拒收", async () => {
  const { provider, requests } = stubProvider(['{"done":true}']);
  await normalizeModelJson("散文", { provider, llm: true, thinking: "inherit" });
  assert.equal("reasoning_effort" in requests[0], false);

  await assert.rejects(
    () => normalizeModelJson("散文", { provider, llm: true, thinking: "off" }),
    /thinking 只接受 "none" 或 "inherit"/,
  );
});

test("L2 产物仍过同一道 validate 闸门：不过就 shape_mismatch（不许静默接受）", async () => {
  const { provider, requests } = stubProvider(['{"done":"yes"}']);
  const result = await normalizeModelJson("散文", {
    provider,
    llm: true,
    validate: (value) => ({ ok: typeof value?.done === "boolean" }),
  });
  assert.equal(requests.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, "shape_mismatch");
  assert.equal(result.llmUsed, true);
  assert.equal("value" in result, false, "失败结果不许带 value 键");
});

test("L2 走 slot：createProviderForSlot 摊平后的真 provider（fetch 桩接住请求）", async () => {
  const requests = [];
  const slot = {
    endpoint: "https://slot.example.invalid/v1",
    apiKey: "slot-secret",
    model: "slot-model",
    maxOutputTokens: 2048,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(String(options?.body ?? "{}")) });
      return {
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{ message: { content: '{"done":true}' }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          });
        },
      };
    },
  };
  const result = await normalizeModelJson("散文", { slot, llm: true, maxTokens: 512 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { done: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, "slot-model");
  assert.equal(requests[0].body.max_tokens, 512);
  assert.equal(requests[0].body.reasoning_effort, NORMALIZATION_REASONING_EFFORT);
});

test("provider 与 slot 只能二选一；llm:true 必须给一个", async () => {
  const { provider } = stubProvider([]);
  await assert.rejects(
    () => normalizeModelJson("散文", { provider, slot: {}, llm: true }),
    /provider 与 slot 只能给一个/,
  );
  await assert.rejects(() => normalizeModelJson("散文", { llm: true }), /llm:true 需要 provider 或 slot/);
  await assert.rejects(
    () => normalizeModelJson("散文", { provider: { chat: 1 }, llm: true }),
    /provider 必须是 \{ chat\(request\) \} 或一个函数/,
  );
});

test("schema 给了才在 L2 提示词里出现「正确形状示例」，且示例来自 exampleToolArguments", async () => {
  const schema = { properties: { done: { type: "boolean" }, summary: { type: "string" } }, required: ["done"] };
  const withSchema = stubProvider(['{"done":true}']);
  await normalizeModelJson("散文", { provider: withSchema.provider, llm: true, schema });
  const prompt = withSchema.requests[0].messages[0].content[0].text;
  assert.ok(prompt.includes(`正确形状示例：${exampleToolArguments(schema)}`), prompt);

  const without = stubProvider(['{"done":true}']);
  await normalizeModelJson("散文", { provider: without.provider, llm: true });
  assert.equal(
    without.requests[0].messages[0].content[0].text.includes("正确形状示例"),
    false,
    "没有 schema 时整行省略，绝不编造形状",
  );
});

test("L2 提示词带上 L1 的解析器判词（原文 + 判词一起交给模型）", async () => {
  const { provider, requests } = stubProvider(['{"done":true}']);
  await normalizeModelJson('{"a":,}', { provider, llm: true });
  assert.match(requests[0].messages[0].content[0].text, /上一版解析失败的原因：/);
});

// ── 硬要求 6：repaired.trusted 分引擎自带 / 宿主注入 ───────────────────────────

test("repaired.trusted：引擎自带规则 ⇒ true；宿主注入的修复器 ⇒ false", async () => {
  const engineOnly = await normalizeModelJson(ILLEGAL_ESCAPE);
  assert.deepEqual(engineOnly.repaired, { rule: "invalid-escape", trusted: true });

  // 宿主先剥掉自己的信封前缀，剩下的交回引擎规则：两条都生效，且因为掺了宿主的规则 ⇒ trusted:false。
  const hostTouched = await normalizeModelJson("结果：{'a': 1}", {
    repair: { inject: [{ id: "host-strip-prefix", apply: (text) => text.replace(/^结果：/, "") }] },
  });
  assert.equal(hostTouched.ok, true);
  assert.deepEqual(hostTouched.value, { a: 1 });
  assert.deepEqual(hostTouched.repaired, { rule: "host-strip-prefix+single-quotes", trusted: false });
});

test("没改文本就没有 repaired 键（可解析就是可解析）", async () => {
  const result = await normalizeModelJson('{"a":1}');
  assert.equal(result.ok, true);
  assert.equal("repaired" in result, false);
});

// ── 硬要求 7：三态名沿用，不新造 ───────────────────────────────────────────────

test("三态只有 no_candidate / unparsable / shape_mismatch，且没有 failureMode", async () => {
  const kinds = new Set(["no_candidate", "unparsable", "shape_mismatch"]);
  const cases = [
    ["", {}],
    ['{"a":1', {}],
    ['{"a":,}', {}],
    ['{"a":1}', { validate: () => ({ ok: false }) }],
  ];
  for (const [text, options] of cases) {
    const result = await normalizeModelJson(text, options);
    assert.equal(result.ok, false);
    assert.ok(kinds.has(result.error), `未知三态名：${result.error}`);
    assert.equal("failureMode" in result, false);
    assert.equal("value" in result, false);
  }
});

// ── 主 agent 追加：两层确实分层 ───────────────────────────────────────────────

test("两层分层：同一段非法转义输入，L0 仍 unparsable，归一化入口成功且值逐字等于原文", async () => {
  const strict = parseModelJson(ILLEGAL_ESCAPE);
  assert.equal(strict.ok, false);
  assert.equal(strict.error, "unparsable", "L0 不可收买：它绝不修");

  const normalized = await normalizeModelJson(ILLEGAL_ESCAPE);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.api, String.raw`http\.request`);
  assert.ok(ILLEGAL_ESCAPE.includes(normalized.value.api), "值必须逐字来自原文");
  assert.equal(normalized.repaired?.trusted, true);
});

// ── 闸门与选项的其它行为 ───────────────────────────────────────────────────────

test("闸门放行时可以声明 dropped，原样透传给宿主", async () => {
  const result = await normalizeModelJson('{"a":1,"b":2}', {
    validate: () => ({ ok: true, dropped: ["b"] }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.dropped, ["b"]);
});

test("validate 的第二个参数是候选原始字节；返回形状不合法直接抛", async () => {
  const seen = [];
  await normalizeModelJson('{"a":1}', {
    validate: (value, source) => {
      seen.push({ value, source });
      return { ok: true };
    },
  });
  assert.deepEqual(seen, [{ value: { a: 1 }, source: '{"a":1}' }]);
  await assert.rejects(
    () => normalizeModelJson('{"a":1}', { validate: () => true }),
    /validate 必须返回 \{ ok: boolean, dropped\?: string\[\] \}/,
  );
  await assert.rejects(() => normalizeModelJson('{"a":1}', { validate: "nope" }), /validate 必须是函数/);
});

test("repair 选项校验：未知规则 id / 注入 id 冲突 / 非函数 apply 都直接抛", async () => {
  await assert.rejects(
    () => normalizeModelJson('{"a":1}', { repair: { rules: ["no-such-rule"] } }),
    /未知规则 id "no-such-rule"/,
  );
  await assert.rejects(
    () => normalizeModelJson('{"a":1}', { repair: { inject: [{ id: "invalid-escape", apply: (t) => t }] } }),
    /规则 id 冲突/,
  );
  await assert.rejects(
    () => normalizeModelJson('{"a":1}', { repair: { inject: [{ id: "x" }] } }),
    /必须带 apply\(text\)/,
  );
  await assert.rejects(() => normalizeModelJson('{"a":1}', { repair: { rules: "invalid-escape" } }), /必须是规则 id 数组/);
});
