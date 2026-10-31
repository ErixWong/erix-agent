// issue #375：参数错误的**四条旧通道**与**一个统一出口**的逐格对账。
//
// 现场（本仓 HEAD 现读，不是照抄工单正文——正文那六格有四处与树对不上，见交付报告的「取证边界」）：
//   ① 静默归一/强转：`rg {pattern: 1}` 把 `1` 当 `"1"` 搜（一个字都不报）；
//      `readFile {max_bytes: "abc"}` 回默认值并挂 `[参数校正：…]`（#358）；
//   ② 文本 + 形状提示：`edit {edits: "x"}` 的 `错误：…（收到 字符串 "x"）`、`readFile {path: <目录>}`；
//   ③ 文本无提示：`searchText {pattern: 1}` 的 `错误：…必须是非空字符串`；
//   ④ 裸 `TypeError`：`grep {pattern: 1}` / `writeFile {content: 1}`。
//
// 本票**只做加法**：默认 `paramErrorMode: "legacy"` 时四条旧通道逐字不变（下面那条「字节不变」测试
// 把六格逐字钉死），`paramErrorMode: "unified"` 时才改由 `paramError` 统一出口出词，**控制流不变**
// （归一的仍归一、抛的仍抛）。所以这里的对账是**两次真调用**的对比，不是「看起来一样」。
//
// 反向证（#210 R2 惯例：变异没落地也算失败）：变异样本 M10 把 `readFile` 的 `max_bytes` 事实接线
// （`value: maxBytesRequested`）断掉 ⇒ 「对账 ③」这一格必须红并点名；`npm run check:mutation:run`
// 逐条真跑变异 → 红 → 还原 → 绿。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createFileTools, paramError, paramErrorFacts } from "../../src/tools/file-tools.js";
import { paramError as paramErrorFromBarrel } from "../../src/tools/index.js";
import { makeTmp } from "../helpers/tmp.js";

async function withRoot(callback) {
  const cwd = await makeTmp("erix-param-error-375-");
  try {
    await writeFile(join(cwd, "a.txt"), "hello 1\nworld 2\n", "utf8");
    await mkdir(join(cwd, "sub"));
    return await callback(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** 同一次坏调用跑两遍：一遍默认（旧通道），一遍 `unified`（新出口）。 */
async function bothModes(cwd, name, input) {
  const run = async (options) => {
    const fileTools = createFileTools({ cwd, ...options });
    try {
      const result = await fileTools.executors(name, input);
      return { threw: false, text: typeof result === "string" ? result : JSON.stringify(result) };
    } catch (error) {
      return { threw: true, text: String(error?.message ?? error) };
    }
  };
  return { legacy: await run({}), unified: await run({ paramErrorMode: "unified" }) };
}

/**
 * 统一出口文本 → 事实。**测试自己解析**（不借库里的格式化函数）：对账的另一半必须是独立读者，
 * 拿被检代码自己的输出再喂回它自己，等于没对账。
 */
function parseParamError(text) {
  const match = String(text).match(
    /^\[参数错误：(?<tool>[^ ]+) 的 (?<field>[^ ]+) 期望 (?<expected>.+?)，收到 (?<type>[^（]+)（(?<preview>.*?)）(?<rest>.*)\]$/u,
  );
  assert.ok(match, `统一出口的文本形状不认识（本测试的解析面要同步）：${text}`);
  const rest = match.groups.rest;
  const next = rest.match(/；下一步：(.*)$/u)?.[1] ?? null;
  const detail = rest.replace(/；下一步：(.*)$/u, "").replace(/^；/u, "") || null;
  return {
    tool: match.groups.tool,
    field: match.groups.field,
    expected: match.groups.expected,
    receivedType: match.groups.type,
    receivedPreview: match.groups.preview,
    detail,
    next,
  };
}

// ── 六格：旧通道 ↔ 新出口逐条对账 ────────────────────────────────────────────
// 每一格都问两件事：
//   (a) 旧通道**带了的**事实，新出口必须逐字同值（等价性，不是「看起来一样」）；
//   (b) 旧通道**没带的**事实，新出口必须带上（这正是本票要收的口子）。

test("#375 对账 ① rg {pattern: 1}：旧通道静默强转（零参数信息）⇒ 新出口必须带 tool/field/received/next", async () => {
  await withRoot(async (cwd) => {
    const { legacy, unified } = await bothModes(cwd, "rg", { pattern: 1, path: "a.txt" });
    // 旧通道：真的搜了（把 1 当 "1"），结果里没有一个字说「你的参数类型不对」。
    assert.equal(legacy.threw, false);
    assert.match(legacy.text, /a\.txt:1:hello 1/u, "旧通道必须仍然是「静默强转后真搜」——本票不改语义");
    assert.doesNotMatch(legacy.text, /参数错误|参数校正/u, "旧通道在这一格不该有任何参数信息（这正是通道①的病）");

    // 新出口：同一份事实补齐。
    const facts = parseParamError(unified.text.split("\n").find((line) => line.startsWith("[参数错误：")));
    assert.equal(facts.tool, "rg");
    assert.equal(facts.field, "pattern");
    assert.equal(facts.receivedType, "number");
    assert.equal(facts.receivedPreview, "1", "收到的原值必须逐字回显（1 ≠ \"1\"）");
    assert.match(facts.detail ?? "", /已按 "1" 处理/u);
    assert.ok(facts.next, "新出口必须给下一步");
    // 语义没变：正文命中行仍在（新出口只是多挂一行）。
    assert.match(unified.text, /a\.txt:1:hello 1/u);
  });
});

test("#375 对账 ② grep {pattern: 1}：旧通道裸 TypeError ⇒ 新出口仍然抛（计数不变）但带全事实", async () => {
  await withRoot(async (cwd) => {
    const { legacy, unified } = await bothModes(cwd, "grep", { pattern: 1, path: "a.txt" });
    // 旧通道：裸 TypeError，消息里只有 tool + field + expected（英文），没有「收到什么」。
    assert.equal(legacy.threw, true, "旧通道必须仍然抛——把抛改成文本会让 toolStats.failures 掉账");
    assert.equal(legacy.text, "grep pattern must be a non-empty string");
    assert.match(legacy.text, /^grep /u, "旧通道带 tool");
    assert.match(legacy.text, /pattern/u, "旧通道带 field");
    assert.match(legacy.text, /non-empty string/u, "旧通道带 expected");

    // 新出口：仍然抛（控制流一致），消息换成统一形状并补齐 received / next。
    assert.equal(unified.threw, true, "unified 模式也不许把抛改成返回文本（本票只换文案）");
    const facts = parseParamError(unified.text);
    assert.equal(facts.tool, "grep");
    assert.equal(facts.field, "pattern");
    assert.equal(facts.receivedType, "number");
    assert.equal(facts.receivedPreview, "1");
    assert.ok(facts.next);
  });
});

test("#375 对账 ③ readFile {max_bytes: \"abc\"}：旧通道 [参数校正] 与新出口逐字等价", async () => {
  await withRoot(async (cwd) => {
    const { legacy, unified } = await bothModes(cwd, "readFile", { path: "a.txt", max_bytes: "abc" });
    // 旧通道（#358 的 `[参数校正：…]`）：field / 原值 / 已按什么处理 / 下一步 都在。
    assert.equal(legacy.threw, false);
    const legacyMarker = legacy.text.split("\n").find((line) => line.startsWith("[参数校正："));
    assert.ok(legacyMarker, `旧通道的 [参数校正] 不见了：\n${legacy.text}`);
    const legacyField = legacyMarker.match(/^\[参数校正：(max_bytes)=/u)?.[1];
    const legacyPreview = legacyMarker.match(/^\[参数校正：max_bytes=("abc") 不是可用整数/u)?.[1];
    const legacyDetail = legacyMarker.match(/^\[参数校正：(max_bytes="abc" 不是可用整数，已按 \d+ 处理)；/u)?.[1];
    const legacyNext = legacyMarker.match(/；下一步：(.*)\]$/u)?.[1];
    assert.equal(legacyField, "max_bytes");
    assert.equal(legacyPreview, "\"abc\"");
    assert.ok(legacyDetail && legacyNext, `旧通道的关键信息不齐：${legacyMarker}`);

    // 新出口：同一格逐条对账（(a) 等价）。
    const facts = parseParamError(unified.text.split("\n").find((line) => line.startsWith("[参数错误：")));
    assert.equal(facts.tool, "readFile");
    assert.equal(facts.field, legacyField, "field 必须与旧通道同值");
    assert.equal(facts.receivedType, "string");
    assert.equal(facts.receivedPreview, legacyPreview, "收到的原值必须与旧通道逐字同值");
    assert.equal(facts.detail, legacyDetail, "「已怎么处理」必须与旧通道逐字同值");
    assert.equal(facts.next, legacyNext, "下一步必须与旧通道逐字同值");
    // 语义没变：正文仍返回（归一不是拒绝）。
    assert.match(unified.text, /1: hello 1/u);
  });
});

test("#375 对账 ④ readFile {path: <目录>}：旧通道文本带目录名 ⇒ 新出口同名同值", async () => {
  await withRoot(async (cwd) => {
    const { legacy, unified } = await bothModes(cwd, "readFile", { path: "sub" });
    // 旧通道：`错误：路径是目录：sub（readFile 只读文件；要看目录用 tree）`。
    assert.equal(legacy.threw, false);
    const legacyPreview = legacy.text.match(/^错误：路径是目录：(sub)（/u)?.[1];
    const legacyDetail = legacy.text.match(/^错误：路径是目录：sub（(readFile 只读文件)；要看目录用 tree）$/u)?.[1];
    assert.equal(legacyPreview, "sub");
    assert.equal(legacyDetail, "readFile 只读文件");

    const facts = parseParamError(unified.text);
    assert.equal(facts.tool, "readFile");
    assert.equal(facts.field, "path");
    assert.equal(facts.receivedType, "目录");
    assert.equal(facts.receivedPreview, legacyPreview, "目录名必须与旧通道逐字同值");
    assert.equal(facts.detail, legacyDetail, "「readFile 只读文件」必须与旧通道同值");
    assert.ok(facts.next?.includes("tree"), "新出口必须指向 tree");
  });
});

test("#375 对账 ⑤ writeFile {content: 1}：旧通道裸 TypeError ⇒ 新出口仍然抛但带全事实", async () => {
  await withRoot(async (cwd) => {
    const { legacy, unified } = await bothModes(cwd, "writeFile", { path: "x.txt", content: 1 });
    assert.equal(legacy.threw, true, "旧通道必须仍然抛（toolStats.failures 的账不变）");
    assert.equal(legacy.text, "writeFile content must be a string");
    assert.match(legacy.text, /^writeFile /u);
    assert.match(legacy.text, /content/u);
    assert.match(legacy.text, /must be a string/u);

    assert.equal(unified.threw, true);
    const facts = parseParamError(unified.text);
    assert.equal(facts.tool, "writeFile");
    assert.equal(facts.field, "content");
    assert.equal(facts.receivedType, "number");
    assert.equal(facts.receivedPreview, "1");
    assert.match(facts.detail ?? "", /不做 String\(\) 强转/u, "拒绝强转的理由必须在场（#375 的拍板点）");
    assert.ok(facts.next);
  });
});

test("#375 对账 ⑥ edit {edits: \"x\"}：旧通道带原值回显 ⇒ 新出口同值", async () => {
  await withRoot(async (cwd) => {
    const { legacy, unified } = await bothModes(cwd, "edit", { path: "a.txt", edits: "x" });
    // 旧通道：`错误：edit 的 edits 是字符串但不是合法 JSON："x"；…`
    assert.equal(legacy.threw, false);
    const legacyTool = legacy.text.match(/^错误：(edit) 的 edits/u)?.[1];
    const legacyPreview = legacy.text.match(/^错误：edit 的 edits 是字符串但不是合法 JSON：("x")；/u)?.[1];
    assert.equal(legacyTool, "edit");
    assert.equal(legacyPreview, "\"x\"");

    const facts = parseParamError(unified.text);
    assert.equal(facts.tool, legacyTool, "tool 必须与旧通道同值");
    assert.equal(facts.field, "edits");
    assert.equal(facts.receivedType, "string");
    assert.equal(facts.receivedPreview, legacyPreview, "原值回显必须与旧通道逐字同值");
    assert.match(facts.detail ?? "", /不是合法 JSON/u);
    assert.ok(facts.next);
  });
});

test("#375 旧通道在默认模式下**逐字不变**（0.29 线上不改任何分支语义）", async () => {
  await withRoot(async (cwd) => {
    const fileTools = createFileTools({ cwd });
    const call = async (name, input) => {
      try {
        return { threw: false, text: await fileTools.executors(name, input) };
      } catch (error) {
        return { threw: true, text: error.message };
      }
    };
    assert.equal(
      (await call("readFile", { path: "a.txt", max_bytes: "abc" })).text.split("\n").at(-1),
      "[参数校正：max_bytes=\"abc\" 不是可用整数，已按 262144 处理；下一步：重传 readFile 并传整数 max_bytes]",
    );
    assert.equal(
      (await call("readFile", { path: "sub" })).text,
      "错误：路径是目录：sub（readFile 只读文件；要看目录用 tree）",
    );
    assert.equal(
      (await call("searchText", { pattern: 1, mode: "regex", path: "a.txt" })).text,
      "错误：searchText 的 pattern 必须是非空字符串",
    );
    assert.deepEqual(await call("grep", { pattern: 1, path: "a.txt" }), {
      threw: true,
      text: "grep pattern must be a non-empty string",
    });
    assert.deepEqual(await call("writeFile", { path: "x.txt", content: 1 }), {
      threw: true,
      text: "writeFile content must be a string",
    });
    assert.equal(
      (await call("edit", { path: "a.txt", edits: "x" })).text,
      "错误：edit 的 edits 是字符串但不是合法 JSON：\"x\"；传数组本身（不要多包一层引号），或确保它是合法 JSON：[{\"oldText\":\"…\",\"newText\":\"…\"}]",
    );
    // ① 的旧语义：仍然静默强转并真搜（不是报错）。
    const rgLegacy = await call("rg", { pattern: 1, path: "a.txt" });
    assert.match(rgLegacy.text, /^a\.txt:1:hello 1\n\[已弃用 rg：/u);
  });
});

// ── 出口本身 ────────────────────────────────────────────────────────────────

test("#375 paramError 是唯一出口：同一份事实 → 同一段文本，且从 `erix-agent/tools` 取到的是同一个函数", () => {
  const text = paramError({
    tool: "readFile", field: "max_bytes", expected: "整数", value: "abc",
    detail: "max_bytes=\"abc\" 不是可用整数，已按 262144 处理", next: "重传 readFile 并传整数 max_bytes",
  });
  assert.equal(
    text,
    "[参数错误：readFile 的 max_bytes 期望 整数，收到 string（\"abc\"）；max_bytes=\"abc\" 不是可用整数，已按 262144 处理；下一步：重传 readFile 并传整数 max_bytes]",
  );
  assert.equal(paramErrorFromBarrel, paramError, "宿主从 `erix-agent/tools` 拿到的必须是同一个出口");
  // 结构化事实与文本同源：文本里的每一格都能从 facts 取到。
  const facts = paramErrorFacts({ tool: "grep", field: "pattern", expected: "非空字符串", value: 1 });
  assert.deepEqual(facts, {
    tool: "grep", field: "pattern", expected: "非空字符串",
    receivedType: "number", receivedPreview: "1", detail: null, next: null,
  });
});

test("#375 两种模式之外的值在构造期 fail-loud（静默回落 = 又开一条「不报」的通道）", () => {
  assert.throws(() => createFileTools({ paramErrorMode: "unified " }), TypeError);
  assert.throws(() => createFileTools({ paramErrorMode: true }), TypeError);
});
