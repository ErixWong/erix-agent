// issue #641（可观测面诚实性，第二半）：**运行期真的发出去的事件名** ↔ `LoopEvent` 的 `type` 联合。
//
// #595 建的闸只守了「契约的**加法事件表** ⊆ 类型联合」这一格；它今天实测干净，但那是**另一份清单**。
// 类型面真正的病在**发射处**：`src/loop/**` 与装配口里真发的 27 个事件名中，有 6 个（`continuity_written`、
// `continuity_write_failed`、`final_guard_extend`、`tool_output_aggregate`、`forced_final`、
// `context_unknown_option`）根本不在联合里 —— 宿主照发布的 `.d.ts` / JSDoc 写 `switch (event.type)`，
// 这些分支永远不可达，而没有任何门禁会为此变红。
//
// 两道闸**并排、不合并**：#595 守「契约表 ⊆ 联合」（清单从文档现推），本文件守「发射处 ⊆ 联合」
// （清单从**代码调用点**现推）。两者的 `[A] 空 / [B] 非空` 就是「互相替代不了」的证据。
//
// 本文件钉的是**对账**，不是硬编码名单：
//
//   E1 发射清单**从调用点现推**（不手抄、不用裸 `type: "…"` 全文匹配）：
//      ① `emitEvent({ type: "…" })` —— 循环的观察者发射器（`src/loop/**`）；
//      ② 直调 `onEvent?.({ type: "…" })` —— 启动期诊断（绕开 `emitEvent` 的既有直调路径）；
//      ③ `port.emit("…", …)` —— 装配端口（`src/assembly.js`），宿主经它拿到事件；
//      ④ `onEvent(runOutcomeRecord(…))` —— 事件**装配 helper**（`src/loop/judge-record.js` 里才写 `type`）。
//      口径刻意不是全文 `type: "…"`：本仓同一形状还承载 content block 类型（`text` / `image` / …）、
//      provider 流式增量（`delta` / `reasoning_delta` / `tool_call`）与 JSON schema 类型（`object` / …），
//      这些**不是** `LoopEvent`。provider 协议目录（`src/providers/**`、`src/messages/**`）因此不在这张
//      扫描面上——它们的 `onEvent` 是 provider 自己的流式回调，不是 `runToolLoop` 的观察者。
//   E2 清单里**每一个**名字都必须在 `LoopEvent.type` 联合里，缺哪个点名哪个。
//   E3 读不到真值**就红**：取到 0 个发射点 / 某个调用点解析不出 `type` 字面量 / 联合抽不出来 ⇒ 红。
//      「两边都抽成空集 ⇒ 差集为空 ⇒ 绿」是本仓明令禁止的那种假绿。
//   E0 抽取器自测：合成源码上「四种发射族都抽到、注释与字符串里的假调用不抽、非字面量 `type`
//      进 problems、空源码触发 E3」，防上面三条退化成恒绿。
//
// 反向证明（实测见交付报告）：把某个真发的 type 从联合里删掉 ⇒ E2 红并点名它；补回来 ⇒ 绿；
// 把发射处改成发一个联合外的假 type ⇒ E2 红并点名假名；还原 ⇒ 绿。
//
// 零 LLM、零写盘、不碰真实 `~/.erix`：只读 `src/` 下的源码文本。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const ORCHESTRATOR_URL = new URL("../src/loop/orchestrator.js", import.meta.url);
const JUDGE_RECORD_URL = new URL("../src/loop/judge-record.js", import.meta.url);

/** provider 协议目录：`onEvent` 在这里是 provider 的流式回调，`type` 是 `delta` / `tool_call` 那一族。 */
const PROVIDER_PROTOCOL_DIRS = ["providers", "messages"];

/** 事件装配 helper：`onEvent(<helper>(…))` 的 `type` 写在 helper 的返回值里，不在调用点。 */
const ASSEMBLY_HELPERS = { runOutcomeRecord: JUDGE_RECORD_URL };

/**
 * 把注释、字符串、模板、正则字面量的**内容**替换成空格（保留换行与下标）。
 *
 * 为什么需要它：调用点扫描不能把注释里的 `onEvent?.()` 或字符串里的 `emitEvent(` 当成真发射；
 * 同时 `type: "round_start"` 的字面量要从**原文**读，所以遮罩只用于找调用/括号/顶层键。
 *
 * 正则 vs 除号的判定用前一个有效字符（`= ( , : [ ! & | ? { } ; + - * % < > ~ ^` 或行首
 * ⇒ 正则），够本仓使用；判错的方向是「少遮一段」，不会凭空造出发射点。
 *
 * @param {string} source
 * @returns {string}
 */
function codeOnly(source) {
  const out = source.split("");
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) {
      if (source[index] !== "\n") out[index] = " ";
    }
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      const quote = char;
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== quote) {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
      blank(index, Math.min(cursor + 1, source.length));
      index = cursor + 1;
      continue;
    }
    if (char === "/") {
      const previous = source.slice(0, index).trimEnd().at(-1) ?? "";
      const startsRegex = previous === "" || "=(,:[!&|?{};+-*%<>~^".includes(previous);
      if (startsRegex) {
        let cursor = index + 1;
        let inClass = false;
        while (cursor < source.length) {
          const current = source[cursor];
          if (current === "\\") {
            cursor += 2;
            continue;
          }
          if (current === "[") inClass = true;
          else if (current === "]") inClass = false;
          else if (current === "/" && !inClass) break;
          else if (current === "\n") break;
          cursor += 1;
        }
        blank(index, Math.min(cursor + 1, source.length));
        index = cursor + 1;
        continue;
      }
    }
    index += 1;
  }
  return out.join("");
}

/** 从 `openIndex` 指向的 `(` 找到配对的 `)`（在遮罩文本上数括号）。 */
function closingParen(masked, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < masked.length; index += 1) {
    if (masked[index] === "(") depth += 1;
    else if (masked[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * 读对象字面量的**顶层** `type:` 字符串字面量；读不到（变量、计算值、根本没有）⇒ `undefined`。
 *
 * 顶层 = 深度 1（对象自己的花括号内），所以 `toolResult: { type: "text" }` 这种载荷不会冒充事件名。
 *
 * @param {string} original 原文切片（字面量在这里）
 * @param {string} masked 同一段的遮罩文本（字符串已变空格，深度扫描不会误判）
 * @returns {string|undefined}
 */
function topLevelTypeLiteral(original, masked) {
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (depth === 1 && masked.startsWith("type", index)) {
      const before = masked[index - 1] ?? " ";
      if (!/[\w$]/u.test(before)) {
        let cursor = index + 4;
        while (/\s/u.test(masked[cursor] ?? "")) cursor += 1;
        if (masked[cursor] !== ":") continue;
        cursor += 1;
        // 值前面的空白要在**原文**上跳：字符串字面量在遮罩里已经变成空格，用遮罩会直接跳过引号。
        while (/\s/u.test(original[cursor] ?? "")) cursor += 1;
        const quote = original[cursor];
        if (quote !== "\"" && quote !== "'") return undefined;
        let value = "";
        cursor += 1;
        while (cursor < original.length && original[cursor] !== quote) {
          if (original[cursor] === "\\") {
            value += original[cursor];
            cursor += 1;
          }
          value += original[cursor];
          cursor += 1;
        }
        return value;
      }
    }
  }
  return undefined;
}

/**
 * 从事件装配 helper 的返回值里读 `type` 字面量（不手抄 `run_outcome`）。
 *
 * @param {string} source
 * @param {string} helperName
 * @returns {string|undefined}
 */
function helperTypeLiteral(source, helperName) {
  const definitionAt = source.indexOf(`export function ${helperName}(`);
  if (definitionAt === -1) return undefined;
  const match = /\breturn\s*\{[\s\S]*?\btype:\s*"([A-Za-z0-9_]+)"/u.exec(source.slice(definitionAt));
  return match?.[1];
}

/** 扫 `src/` 下属于 `LoopEvent` 观察者面的文件（排除 provider 协议目录）。 */
function loopEventSurfaceFiles() {
  const files = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (PROVIDER_PROTOCOL_DIRS.includes(entry.name)) continue;
        walk(`${directory}/${entry.name}`, `${prefix}${entry.name}/`);
        continue;
      }
      if (entry.name.endsWith(".js")) files.push({ path: `${prefix}${entry.name}`, url: `${directory}/${entry.name}` });
    }
  };
  walk(SRC_DIR, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * 从源码里抽**发射点**的事件名。
 *
 * @param {Array<{path: string, source: string}>} files
 * @param {Record<string, string>} helpers helper 名 → 源码
 * @returns {{names: Map<string, string[]>, problems: string[]}}
 */
function emissionNames(files, helpers) {
  const names = new Map();
  const problems = [];
  const record = (name, where) => {
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(where);
  };
  const callPattern = /\b(emitEvent|onEvent\?\.|onEvent|port\.emit)\s*\(/gu;
  for (const { path, source } of files) {
    const masked = codeOnly(source);
    for (const match of masked.matchAll(callPattern)) {
      const callee = match[1];
      const openIndex = match.index + match[0].length - 1;
      const closeIndex = closingParen(masked, openIndex);
      const line = masked.slice(0, match.index).split("\n").length;
      const where = `${path}:${line}`;
      if (closeIndex === -1) {
        problems.push(`${where}：\`${callee}(\` 找不到配对的右括号（解析器读不动，不许静默跳过）`);
        continue;
      }
      const originalArgRaw = source.slice(openIndex + 1, closeIndex);
      const maskedArgRaw = masked.slice(openIndex + 1, closeIndex);
      const originalArg = originalArgRaw.trim();
      const maskedArg = maskedArgRaw.trim();

      if (callee === "port.emit") {
        // 逗号位置在**未 trim** 的遮罩段上找：第一个参数若是字符串字面量，它在遮罩里是一整段空格，
        // trim 会把那段空格连同引号一起削掉，导致误判成「空参数」。
        const comma = maskedArgRaw.search(/,/u);
        const firstArgOriginal = (comma === -1 ? originalArgRaw : originalArgRaw.slice(0, comma)).trim();
        const firstArgMasked = (comma === -1 ? maskedArgRaw : maskedArgRaw.slice(0, comma)).trim();
        if (firstArgMasked === "event.type") continue; // 装配适配器转发，不是字面量发射
        if (/^"[A-Za-z0-9_]+"$/u.test(firstArgOriginal) || /^'[A-Za-z0-9_]+'$/u.test(firstArgOriginal)) {
          record(firstArgOriginal.slice(1, -1), where);
          continue;
        }
        problems.push(`${where}：\`port.emit(\` 的第一个参数不是字符串字面量（读不到真值 ⇒ 红）：${firstArgOriginal.slice(0, 60)}`);
        continue;
      }

      if (originalArg === "event") continue; // `emitEvent` 定义里的 `onEvent?.(event)` 转发
      if (maskedArg.startsWith("{")) {
        const name = topLevelTypeLiteral(originalArg, maskedArg);
        if (name === undefined) {
          problems.push(`${where}：\`${callee}(\` 的对象载荷里没有顶层的 \`type: "…"\` 字面量（读不到真值 ⇒ 红）`);
          continue;
        }
        record(name, where);
        continue;
      }
      const helper = /^([A-Za-z_$][\w$]*)\s*\(/u.exec(maskedArg);
      if (helper !== null && Object.hasOwn(helpers, helper[1])) {
        const name = helperTypeLiteral(helpers[helper[1]], helper[1]);
        if (name === undefined) {
          problems.push(`${where}：事件装配 helper \`${helper[1]}\` 里读不到 \`type: "…"\` 字面量（读不到真值 ⇒ 红）`);
          continue;
        }
        record(name, where);
        continue;
      }
      problems.push(`${where}：\`${callee}(\` 的参数既不是对象字面量、也不是已知的装配 helper（读不到真值 ⇒ 红）：${originalArg.slice(0, 60)}`);
    }
  }
  return { names, problems };
}

/** 取清单，**取不到就红**：0 个发射点 / 抽不动的调用点都不许静默变绿。 */
function emissionNamesOrFail(files, helpers, label) {
  const { names, problems } = emissionNames(files, helpers);
  assert.deepEqual(problems, [], `${label}：有抽不动的发射点 —— 判据不许在这种时候变绿`);
  const sites = [...names.values()].reduce((total, list) => total + list.length, 0);
  assert.ok(
    sites > 0 && names.size > 0,
    `${label}：从发射点取到 0 个事件名 —— 扫描面/解析器坏了。判据不许在这种时候变绿`
      + "（读不到真值就红，本仓既有规矩）",
  );
  return names;
}

/** 抽 `LoopEvent` 的 `type` 联合成员（逐字取自 `@property {"a"|"b"|…} type` 那一行）。 */
function loopEventTypeUnion(source) {
  const typedefAt = source.indexOf("@typedef {object} LoopEvent");
  assert.notEqual(typedefAt, -1, "`orchestrator.js` 里必须还有 `@typedef {object} LoopEvent`——抽不到就等于判据在空转");
  const unionLine = /@property \{((?:"[a-z][a-z0-9_]*"\|?)+)\} type/u.exec(source.slice(typedefAt));
  assert.notEqual(unionLine, null, "`LoopEvent` 里必须还有 `@property {\"…\"|\"…\"} type` 这一行");
  const members = unionLine[1].split("|").map((member) => member.replaceAll("\"", ""));
  assert.ok(members.length > 0, "`LoopEvent.type` 联合抽到 0 个成员——判据不许在空集上变绿");
  return members;
}

const HELPER_SOURCES = Object.fromEntries(
  Object.entries(ASSEMBLY_HELPERS).map(([name, url]) => [name, readFileSync(url, "utf8")]),
);

// ================================================================ E0
// 抽取器自测（house 口径同 `test/loop-event-type-surface-595.test.js` 的 C0：规则表本身也要被钉）。
const SAMPLE = [
  "const emitEvent = (event) => { onEvent?.(event); };",
  "emitEvent({ type: \"round_start\", round });",
  "emitEvent({",
  "  type: \"tool_use\",",
  "  toolUse: cloneState(block),",
  "});",
  "onEvent?.({ type: \"model_metadata_missing\", runId });",
  "port.emit(\"context_unknown_option\", { key });",
  "onEvent(runOutcomeRecord({ runId }));",
  "// emitEvent({ type: \"commented_out\" });",
  "const text = \"emitEvent({ type: \\\"inside_string\\\" })\";",
  "emitEvent({ type: someVariable });",
  "port.emit(someName, { key });",
  "emitEvent(buildEvent());",
].join("\n");

const SAMPLE_HELPERS = { runOutcomeRecord: "export function runOutcomeRecord(input = {}) {\n  return { type: \"run_outcome\", ...input };\n}\n" };

test("E0 抽取器自测：四族发射点都抽到、注释与字符串不抽、非字面量进 problems、空源码触发「取不到就红」", () => {
  const { names, problems } = emissionNames(
    [{ path: "sample.js", source: SAMPLE }],
    SAMPLE_HELPERS,
  );
  assert.deepEqual(
    [...names.keys()].sort(),
    ["context_unknown_option", "model_metadata_missing", "round_start", "run_outcome", "tool_use"],
    "`emitEvent` / 直调 `onEvent` / `port.emit` / 装配 helper 四族都必须抽到；注释与字符串里的假调用不算",
  );
  assert.equal(names.get("tool_use").length, 1, "多行对象载荷里的 `type:` 必须抽到（不能只看第一行）");
  assert.equal(problems.length, 3, "三处读不到真值的调用点必须进 problems（非字面量 type / 非字面量 port.emit / 未知 helper）");
  assert.match(problems.join("\n"), /sample\.js:12/u, "非字面量 `type` 的调用点必须点名（行号）");
  assert.match(problems.join("\n"), /port\.emit/u, "非字面量 `port.emit` 必须点名");
  assert.match(problems.join("\n"), /buildEvent/u, "未知装配 helper 必须点名");

  assert.throws(
    () => emissionNamesOrFail([{ path: "empty.js", source: "// 没有任何发射点\n" }], {}, "自测"),
    /取到 0 个事件名/u,
    "空源码必须红——否则扫描面被改名/搬走后这道闸会静默变绿",
  );
  assert.throws(
    () => emissionNamesOrFail([{ path: "broken.js", source: SAMPLE }], SAMPLE_HELPERS, "自测"),
    /抽不动的发射点/u,
    "抽不动的调用点也必须让取清单失败（不是「跳过它继续」）",
  );
});

// ================================================================ E1 / E2 / E3
test("E1 发射处 → `LoopEvent.type`：代码里真发的每个事件名都必须在联合里（缺哪个点名哪个）", () => {
  const files = loopEventSurfaceFiles().map(({ path, url }) => ({ path, source: readFileSync(url, "utf8") }));
  const emitted = emissionNamesOrFail(files, HELPER_SOURCES, "发射处");
  const union = new Set(loopEventTypeUnion(readFileSync(ORCHESTRATOR_URL, "utf8")));

  // 前提：四族各至少有一个代表被真的读到。缺一族 ⇒ 那一族的发射点从扫描面上消失了，
  // 下面的「⊆」会在没人看守的情况下变成一句空话。
  for (const representative of ["round_start", "model_metadata_missing", "context_unknown_option", "run_outcome"]) {
    assert.ok(
      emitted.has(representative),
      `发射处清单里必须还有 \`${representative}\`（实测 ${JSON.stringify([...emitted.keys()].sort())}）`
        + "——它不在 ⇒ 对应那一族（emitEvent / 直调 onEvent / port.emit / 装配 helper）没被读到",
    );
  }

  const missing = [...emitted.keys()].filter((name) => !union.has(name)).sort();
  assert.deepEqual(
    missing,
    [],
    "运行期真发、`LoopEvent.type` 里没有的事件名（宿主照发布的类型写 `switch`，这些分支永远不可达）: "
      + missing.join(" / "),
  );
});
