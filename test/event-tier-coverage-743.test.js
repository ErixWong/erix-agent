// issue #743：事件分级表的**枚举守卫** —— 「引擎实际会发哪些事件类型」必须从**代码真值**现推。
//
// 病根（工单原话）：宿主的 `run_events` 占全库 91.6%，`*_delta` 三类占行数 99.2%，而它对这张表的
// `DELETE` 零命中 —— 不是宿主懒，是**契约没说哪一类可以删**，而删错的代价（丢历史）不对称。
// 分级表面前有两个会静默失效的形状，本文件一边一个：
//
//   ① 新增一个事件类型**忘记分级**：宿主查表拿到 `undefined`，只能保守地不删（体积压力回来），
//      而没有任何东西变红 ⇒ 本文件的 **T1/T2**（发射处 ⊆ 表，且表 ⊆ 发射处 ∪ 登记过的宿主侧拼写，
//      两个方向都对账）。
//   ② 分级表**抄契约文档的清单**：那守卫与文档会**一起错**（文档少写一类 ⇒ 两边都少一类 ⇒ 绿）。
//      所以本文件的清单**从调用点现推**（T3 钉抽取器本身，T4 钉「每一族都真的被读到」）。
//
// 口径：与 `test/loop-event-type-emissions-641.test.js`（守「发射处 ⊆ `LoopEvent.type` 联合」）
// **并排、不合并**——那张闸的对面是类型联合，本文件的对面是分级表；三者（发射处 / 联合 / 分级表）
// 两两对账，任何一边漂了都有人红。合并成一条只会让「联合改对了、表没改」这一类漂移没人管。
//
//   T3 抽取器自测：合成源码上「六族发射点都抽到、注释与字符串里的假调用不抽、非字面量 `type`
//      算「读不到真值」、空源码触发『取不到就红』」。规则表本身也要被钉，否则真用例会退化成恒绿。
//   T4 每一族至少有一个代表被真读到（`round_start` / 直调 `onEvent` / `port.emit` / 装配 helper /
//      `queueEvent` 碎片 / provider 自己的 `onEvent`）—— 缺一族就是那一族从扫描面上静默消失了。
//   T1 发射处 ⊆ `EVENT_TIERS`（缺哪个点名哪个）。
//   T2 表里没有「没人发的键」：`Object.keys(EVENT_TIERS)` \ 发射处 == 登记过的宿主侧拼写集合，
//      且登记的每一条都**不是**引擎发射名（否则就该是引擎名，别名是撒谎）。
//   T5 分类结果被钉死（工单判据 2）：`tool_call_delta` / `reasoning_delta` / `assistant_delta`
//      ⇒ `stream`；`tool_use` / `tool_result` / `round_end` / `usage` / `judge` / `compaction`
//      ⇒ `fact`；`derived` 恰好是 `recovering` / `recovered` / `tool_output_aggregate` 三条
//      （改档必须是**显式**改这里，不许悄悄挪）。
//   T6 别名与通道的现验：`assistant_delta` / `tool_call_delta` 在本仓**从不被发出**（全仓 grep 零命中），
//      `judge` 走的是 `onJudge` 通道且那条记录没有 `type` 字段 ⇒ 三条都是宿主侧拼写，档位与被替名字一致。
//   T7 终态名单也从代码真值现推：`markRunState(...)` 的**写点字面量**（含三元与 `const state = …` 的
//      初始化式）抽出来必须恰好等于 `RUN_TERMINAL_STATUSES ∪ {"running"}`，且 `running` 不在终态里。
//   T8 清理谓词的失败方向：档位未知 / `fact` / 非终态 / 状态缺失 / 没过窗口 / 数值缺失 ⇒ 一律不可删。
//   T9 契约中英两份的分级表**逐行**等于本表，且中英两侧的行集合彼此相等（「中英逐处对齐」在这一张表上
//      是机器判据，不是承诺）。
//
// 零 LLM、零写盘、不碰真实 `~/.erix`：只读 `src/` 的源码文本与两份契约文档。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVENT_TIERS,
  EVENT_TIER_DERIVED,
  EVENT_TIER_FACT,
  EVENT_TIER_STREAM,
  EVENT_TIER_VALUES,
  HOST_SIDE_EVENT_TYPE_NAMES,
  RUN_TERMINAL_STATUSES,
  canonicalEventTypeName,
  eventTierOf,
  streamCleanupEligible,
} from "../src/loop/event-tiers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SRC_DIR = join(REPO_ROOT, "src");
const EN_DOC = join(REPO_ROOT, "docs", "host-consumer-contract.md");
const CN_DOC = join(REPO_ROOT, "docs", "host-consumer-contract_cn.md");

/**
 * 事件名的**六族发射点**。前三族与 `test/loop-event-type-emissions-641.test.js` 同口径（`LoopEvent`
 * 观察者面），后三族是流式碎片：循环里的 `queueEvent` 与 provider 自己发的 `onEvent` —— 那正是
 * 工单量的 `*_delta` 三类的出处，所以分级表必须覆盖它们，而 #641 那张闸刻意把它们排除在联合之外。
 *
 * @type {Array<{callee: string, kind: "observer" | "stream", note: string}>}
 */
const EMISSION_FAMILIES = [
  { callee: "emitEvent", kind: "observer", note: "循环的观察者发射器" },
  { callee: "onEvent?.", kind: "observer", note: "启动期直调（绕开 emitEvent）" },
  { callee: "onEvent", kind: "observer", note: "装配端口的 `emit` 适配器与 provider 的流式回调" },
  { callee: "port.emit", kind: "observer", note: "装配端口（宿主经它拿到事件）" },
  { callee: "queueEvent", kind: "stream", note: "循环里的流式碎片队列（retry 回滚前暂存）" },
  { callee: "dispatchAttemptEvent", kind: "stream", note: "attempt 事件的派发口" },
];

/** 事件装配 helper：`onEvent(<helper>(…))` 的 `type` 写在 helper 的返回值里，不在调用点。 */
const ASSEMBLY_HELPER = "runOutcomeRecord";

/**
 * 已知**透传**点：载荷的 `type` 是调用者递进来的名字（定义体写 `emitEvent({ type, ...payload })`），
 * 名字在调用者那一侧。只登记函数名，形状跟 `loop-event-type-emissions-641.test.js` 的
 * `EMIT_EVENT_PAYLOAD_PASSTHROUGH` 一致 —— 那张闸登记的是 `diagnostic`（对面是类型联合），
 * 本文件对面是分级表：透传递进来的名字必须能在**本文件抽得到的发射点**里查到档位，否则 T1 依旧红。
 */
const PASSTHROUGH_CALLERS = new Set(["emitDiagnostic"]);

// ───────────────────────────── 抽取器（注释/字符串遮罩 + 括号配对 + 顶层 `type:`）─────────────

/**
 * 把注释、字符串、模板、正则字面量的**内容**换成空格（保留换行与下标，行号仍对得上原文）。
 *
 * 为什么必须遮：调用点扫描不能把注释里那句 `// emitEvent({ type: "x" })` 或文档式说明当成真发射；
 * 而 `type:` 的字面量要从**原文**读，所以遮罩只用来找调用、括号与顶层键。
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

/** 从 `openIndex` 指向的 `(` 找配对的 `)`（在遮罩文本上数括号）。 */
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
 * 读对象字面量**顶层**的 `type: "…"`；读不到（变量 / 计算值 / 没有）⇒ `undefined`。
 * 顶层 = 深度 1，所以 `toolResult: { type: "text" }` 这种载荷里的 content block 类型不会冒充事件名。
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
        // 值前的空白要在**原文**上跳：字符串在遮罩里已经变成空格，用遮罩会直接跳过引号。
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

/** 从装配 helper 的返回值里读 `type` 字面量（不手抄 `run_outcome`）。 */
function helperTypeLiteral(source, helperName) {
  const definitionAt = source.indexOf(`export function ${helperName}(`);
  if (definitionAt === -1) return undefined;
  const match = /\breturn\s*\{[\s\S]*?\btype:\s*"([A-Za-z0-9_]+)"/u.exec(source.slice(definitionAt));
  return match?.[1];
}

/** 扫 `src/` 下所有 `.js`（**含** provider 协议目录：碎片事件名就住在那里）。 */
function sourceFiles(directory = SRC_DIR, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      files.push(...sourceFiles(join(directory, entry.name), `${prefix}${entry.name}/`));
      continue;
    }
    if (entry.name.endsWith(".js")) {
      files.push({ path: `${prefix}${entry.name}`, source: readFileSync(join(directory, entry.name), "utf8") });
    }
  }
  return files;
}

/** 从源码抽**发射点**的事件名。读不到真值的调用点进 `problems`，**绝不静默跳过**（本仓惯例）。
 *
 * @param {Array<{path: string, source: string}>} files
 * @param {Record<string, string>} helpers helper 名 → 源码
 * @returns {{names: Map<string, string[]>, byFamily: Map<string, number>, sites: Map<string, number>, problems: string[]}}
 */
function emissionNames(files, helpers) {
  const names = new Map();
  const byFamily = new Map();
  const problems = [];
  const record = (name, family, where) => {
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(`${where}#${family}`);
    byFamily.set(family, (byFamily.get(family) ?? 0) + 1);
  };
  /** 每一族被**读到**的次数（含转发调用）—— T4 钉的是「这一族还在扫描面上」。 */
  const sites = new Map();
  const callPattern = /\b(emitEvent|onEvent\?\.|onEvent|port\.emit|queueEvent|dispatchAttemptEvent)\s*\(/gu;
  for (const { path, source } of files) {
    const masked = codeOnly(source);
    for (const match of masked.matchAll(callPattern)) {
      const callee = match[1];
      sites.set(callee, (sites.get(callee) ?? 0) + 1);
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
        // 逗号要在**未 trim** 的遮罩段上找：第一个参数若是字符串字面量，它在遮罩里是一整段空格，
        // trim 会把那段空格连引号一起削掉，误判成「空参数」。
        const comma = maskedArgRaw.search(/,/u);
        const firstArgOriginal = (comma === -1 ? originalArgRaw : originalArgRaw.slice(0, comma)).trim();
        const firstArgMasked = (comma === -1 ? maskedArgRaw : maskedArgRaw.slice(0, comma)).trim();
        if (firstArgMasked === "event.type") continue; // 装配适配器转发，不是字面量发射
        if (/^"[A-Za-z0-9_]+"$/u.test(firstArgOriginal) || /^'[A-Za-z0-9_]+'$/u.test(firstArgOriginal)) {
          record(firstArgOriginal.slice(1, -1), callee, where);
          continue;
        }
        problems.push(`${where}：\`port.emit(\` 的第一个参数不是字符串字面量（读不到真值 ⇒ 红）：${firstArgOriginal.slice(0, 60)}`);
        continue;
      }

      if (originalArg === "event") continue; // `emitEvent` 自己的定义体：`onEvent?.(event)` 转发
      // `queueEvent(event, callback, channel)` / `dispatchAttemptEvent(event, callback, channel)`：
      // 事件是**第一个**参数，取到第一个顶层逗号为止（对象字面量里的逗号在深度 ≥1，不算）。
      const argHead = callee === "queueEvent" || callee === "dispatchAttemptEvent"
        ? firstArgumentOf(originalArg, maskedArg, maskedArgRaw, originalArgRaw)
        : { original: originalArg, masked: maskedArg };
      // 转发一个变量（`queueEvent(event, onEvent, "onEvent")` / `dispatchAttemptEvent(event, …)` /
      // 适配器的 `port.emit(type, payload)`）：名字在它自己的调用点上读不到，不算字面量发射点。
      if (argHead.original === "event" || (callee === "port.emit" && argHead.original === "type")) continue;

      if (argHead.masked.startsWith("{")) {
        const name = topLevelTypeLiteral(argHead.original, argHead.masked);
        if (name === undefined) {
          const outer = declaredBy(masked, match.index);
          if (PASSTHROUGH_CALLERS.has(outer)) continue; // 名字在调用者那一侧，不在这里
          problems.push(`${where}：\`${callee}(\` 的对象载荷里没有顶层的 \`type: "…"\` 字面量（读不到真值 ⇒ 红）；外层函数：${outer || "<top-level>"}`);
          continue;
        }
        record(name, callee, where);
        continue;
      }
      const helper = /^([A-Za-z_$][\w$]*)\s*\(/u.exec(argHead.masked);
      if (helper !== null && Object.hasOwn(helpers, helper[1])) {
        const name = helperTypeLiteral(helpers[helper[1]], helper[1]);
        if (name === undefined) {
          problems.push(`${where}：事件装配 helper \`${helper[1]}\` 里读不到 \`type: "…"\` 字面量（读不到真值 ⇒ 红）`);
          continue;
        }
        record(name, callee, where);
        continue;
      }
      // 转发一个变量（`emitEvent(buildEvent())` / `queueEvent(event, …)`）：不是字面量发射点，
      // 也不许当成「没问题」——它意味着这一族的真值在别处，扫描面读不到。
      problems.push(`${where}：\`${callee}(\` 的参数既不是对象字面量、也不是已知的装配 helper（读不到真值 ⇒ 红）：${argHead.original.slice(0, 60)}`);
    }
  }
  return { names, byFamily, sites, problems };
}

/** 取调用点所在的**外层函数名**（往回找最近的 `function NAME(` / `const NAME = (`；只给透传登记用）。 */
function declaredBy(masked, index) {
  const before = masked.slice(0, index);
  const named = [
    ...before.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/gu),
    ...before.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*)?\(?/gu),
  ];
  return named.length > 0 ? named.at(-1)[1] : "";
}

/** 取多参调用的**第一个**实参（在遮罩上数深度，深度 0 的逗号才断）。 */
function firstArgumentOf(original, masked, maskedRaw, originalRaw) {
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      return { original: original.slice(0, index).trim(), masked: masked.slice(0, index).trim() };
    }
  }
  void maskedRaw;
  void originalRaw;
  return { original, masked };
}

/** 取清单，**取不到就红**：0 个发射点 / 抽不动的调用点都不许静默变绿。 */
function emissionsOrFail(files, helpers, label) {
  const { names, byFamily, problems } = emissionNames(files, helpers);
  assert.deepEqual(problems, [], `${label}：有抽不动的发射点 —— 判据不许在这种时候变绿`);
  const sites = [...names.values()].reduce((total, list) => total + list.length, 0);
  assert.ok(
    sites > 0 && names.size > 0,
    `${label}：从发射点取到 0 个事件名 —— 扫描面/解析器坏了。判据不许在这种时候变绿（读不到真值就红）`,
  );
  return { names, byFamily };
}

const ASSEMBLY_HELPER_SOURCE = {
  [ASSEMBLY_HELPER]: readFileSync(join(SRC_DIR, "loop", "judge-record.js"), "utf8"),
};

// ───────────────────────────── T3 抽取器自测 ─────────────────────────────

const SAMPLE_SOURCE = [
  "const emitEvent = (event) => { onEvent?.(event); };",
  "emitEvent({ type: \"round_start\", round });",
  "emitEvent({",
  "  type: \"tool_use\",",
  "  toolUse: cloneState(block),",
  "});",
  "onEvent?.({ type: \"model_metadata_missing\", runId });",
  "port.emit(\"context_unknown_option\", { key });",
  "onEvent(runOutcomeRecord({ runId }));",
  "queueEvent({ type: \"delta\", delta: chunk }, () => onDelta?.(chunk), \"onDelta\");",
  "dispatchAttemptEvent({ type: \"tool_call\", ...fragment }, cb, \"onToolCall\");",
  "// emitEvent({ type: \"commented_out\" });",
  "const text = \"emitEvent({ type: \\\\\\\"inside_string\\\\\\\" })\";",
  "emitEvent({ toolResult: { type: \"text\" }, round });",
].join("\n");

test("T3 抽取器自测：六族都抽到、注释与字符串不抽、嵌套 `type` 不冒充、空源码触发「取不到就红」", () => {
  const helpers = { runOutcomeRecord: "export function runOutcomeRecord(input = {}) {\n  return { type: \"run_outcome\", ...input };\n}\n" };
  const { names, byFamily, problems } = emissionNames(
    [{ path: "sample.js", source: SAMPLE_SOURCE }],
    helpers,
  );
  assert.deepEqual(
    [...names.keys()].sort(),
    ["context_unknown_option", "delta", "model_metadata_missing", "round_start", "run_outcome", "tool_call", "tool_use"],
    "六族（emitEvent / 直调 onEvent / port.emit / 装配 helper / queueEvent / dispatchAttemptEvent）都必须抽到；注释与字符串里的假调用不算",
  );
  assert.equal(names.get("tool_use").length, 1, "多行对象载荷里的 `type:` 必须抽到（不能只看第一行）");
  assert.equal(
    problems.length,
    1,
    "样本里只该剩下「嵌套 `type`」那一处问题：载荷里 `toolResult: { type: \"text\" }` 这种 content block 类型不得冒充事件名，而那个调用点也不许静默跳过",
  );
  assert.match(problems[0], /:14：/u, "唯一那条问题必须就是样本里 `toolResult: { type: \"text\" }` 那一行");
  assert.ok(!names.has("text"), "`{ type: \"text\" }` 这种 content block 类型不得冒充事件名");
  for (const family of ["emitEvent", "onEvent?.", "port.emit", "onEvent", "queueEvent", "dispatchAttemptEvent"]) {
    assert.ok((byFamily.get(family) ?? 0) > 0, `样本里 \`${family}\` 这一族必须被读到（实际 ${byFamily.get(family) ?? 0}）`);
  }

  // 非字面量 `type` 与看不懂的 helper 必须进 problems，而不是被静默丢掉。
  const broken = emissionNames(
    [{ path: "broken.js", source: "emitEvent({ type: someVariable });\nemitEvent(buildEvent());\nport.emit(name, {});\n" }],
    {},
  );
  assert.equal(broken.problems.length, 3, "非字面量 `type` / 未知 helper / 非字面量 `port.emit` 三处都必须进 problems");

  // 嵌套的 `type`（content block 类型）不算事件名：上面样本里 `toolResult: { type: "text" }` 那行没进清单。
  assert.ok(!names.has("text"), "`{ type: \"text\" }` 这种 content block 类型不得冒充事件名");

  assert.throws(
    () => emissionsOrFail([{ path: "empty.js", source: "// 没有发射点\n" }], {}, "自测"),
    /取到 0 个事件名/u,
    "空源码必须红——否则扫描面被改名/搬走之后这道闸会静默变绿",
  );
});

// ───────────────────────────── T4 每一族都被真读到 ─────────────────────────────

const REAL_FILES = sourceFiles();

// 取证用的旁路（`EVENT_TIER_DUMP=1 node --test test/event-tier-coverage-743.test.js`）：把抽到的
// 每一个名字连同**文件:行号**打出来。报告与两份契约里的表都从这份输出抄，不手抄。
if (process.env.EVENT_TIER_DUMP === "1") {
  const { names } = emissionNames(REAL_FILES, ASSEMBLY_HELPER_SOURCE);
  for (const name of [...names.keys()].sort()) {
    console.error(`[event-tier-dump] ${name}\t${EVENT_TIERS[name] ?? "<未分级>"}\t${names.get(name).join(", ")}`);
  }
}

test("T4 真值面：六族发射点各自都还在扫描面上（缺族 = 那一族从扫描面上静默消失了）", () => {
  const { names, byFamily, sites } = emissionNames(REAL_FILES, ASSEMBLY_HELPER_SOURCE);
  assert.deepEqual(emissionNames(REAL_FILES, ASSEMBLY_HELPER_SOURCE).problems, [], "真树：有抽不动的发射点 —— 判据不许在这种时候变绿");
  const recorded = [...names.values()].reduce((total, list) => total + list.length, 0);
  assert.ok(recorded >= 25, `真树只抽到 ${recorded} 个发射点 / ${names.size} 个名字 —— 扫描面塌了，判据在空转`);
  for (const family of EMISSION_FAMILIES) {
    // 转发族（`dispatchAttemptEvent(event, …)`）不产出字面量名字，但调用点必须还在 ——
    // 它产出的是**运行期**的碎片记录（`{type:"tool_call", …}` 由 `{...record, type, ...fragment}` 铺成）。
    assert.ok(
      (sites.get(family.callee) ?? 0) > 0,
      `\`${family.callee}\`（${family.note}）在 src/ 里一个调用点都没读到 —— 这一族从扫描面上消失了，真值得重新推`,
    );
    if (family.callee !== "dispatchAttemptEvent") {
      assert.ok((byFamily.get(family.callee) ?? 0) > 0, `\`${family.callee}\` 一个**字面量**发射点都没读到（这一族的真值丢了）`);
    }
  }
});

test("T1 分级表覆盖引擎实际会发的每一个类型（新增事件类型忘记分级 ⇒ 这条红并点名）", () => {
  const { names } = emissionsOrFail(REAL_FILES, ASSEMBLY_HELPER_SOURCE, "发射处");
  const missing = [...names.keys()].filter((name) => eventTierOf(name) === undefined).sort();
  assert.deepEqual(
    missing,
    [],
    "引擎真发、而 EVENT_TIERS 没分级的类型（宿主查表得 undefined ⇒ 永远不敢删）: "
      + missing.map((name) => `${name} @ ${names.get(name).join(", ")}`).join(" / "),
  );
});

test("T2 表里没有「没人发的键」：多出来的键必须是登记过的宿主侧拼写，且登记的都不是引擎名", () => {
  const { names } = emissionsOrFail(REAL_FILES, ASSEMBLY_HELPER_SOURCE, "发射处");
  const emitted = new Set(names.keys());
  const extra = Object.keys(EVENT_TIERS).filter((name) => !emitted.has(name)).sort();
  const registered = Object.keys(HOST_SIDE_EVENT_TYPE_NAMES).sort();
  assert.deepEqual(
    extra,
    registered,
    `EVENT_TIERS 里躺着没有发射点的键：${extra.join(" / ")}；登记的宿主侧拼写：${registered.join(" / ")}`
      + "（两边不齐就是漂移：要么表多写了一个没人发的名字，要么有人新增了登记却没写档位）",
  );
  for (const alias of registered) {
    assert.ok(
      !emitted.has(alias),
      `登记的宿主侧拼写 \`${alias}\` 其实被引擎发出来了（${names.get(alias)?.join(", ")}）——它该是引擎名，别名条目是撒谎`,
    );
    assert.equal(canonicalEventTypeName(alias), HOST_SIDE_EVENT_TYPE_NAMES[alias].standsFor);
    if (HOST_SIDE_EVENT_TYPE_NAMES[alias].standsFor !== alias) {
      assert.ok(
        emitted.has(HOST_SIDE_EVENT_TYPE_NAMES[alias].standsFor),
        `别名 \`${alias}\` 指向的 \`${HOST_SIDE_EVENT_TYPE_NAMES[alias].standsFor}\` 必须是引擎真发的名字`,
      );
      assert.equal(EVENT_TIERS[alias], EVENT_TIERS[HOST_SIDE_EVENT_TYPE_NAMES[alias].standsFor]);
    }
  }
});

// ───────────────────────────── T5 分类结果被钉死 ─────────────────────────────

test("T5 分类结果钉住（工单判据 2）：三条 stream、六条 fact、三条 derived，值域只有三档", () => {
  for (const name of ["tool_call_delta", "reasoning_delta", "assistant_delta", "delta", "tool_call"]) {
    assert.equal(eventTierOf(name), EVENT_TIER_STREAM, `${name} 必须是 stream（工单现网量的打字机碎片）`);
  }
  for (const name of ["tool_use", "tool_result", "round_end", "usage", "judge", "compaction"]) {
    assert.equal(eventTierOf(name), EVENT_TIER_FACT, `${name} 必须是 fact（成型入参 / 结果 / 轮界 / 裁决的唯一副本）`);
  }
  const derived = Object.keys(EVENT_TIERS).filter((name) => EVENT_TIERS[name] === EVENT_TIER_DERIVED).sort();
  assert.deepEqual(
    derived,
    ["recovered", "recovering", "tool_output_aggregate"],
    "`derived` 的门槛是「同一件事在别处还有一份能读到的 durable 副本」；改档必须显式改这条断言并写理由",
  );
  // 值域与不可变性：档位拼错（`streem`）在载入期就 throw，这里再钉一次「表里没有第四档」。
  for (const tier of Object.values(EVENT_TIERS)) {
    assert.ok(EVENT_TIER_VALUES.includes(tier), `档位 ${tier} 不在值域里`);
  }
  assert.deepEqual([...EVENT_TIER_VALUES], ["fact", "stream", "derived"]);
  assert.ok(Object.isFrozen(EVENT_TIERS) && Object.isFrozen(HOST_SIDE_EVENT_TYPE_NAMES), "两张表都必须冻结（宿主拿到的就是那一份）");
  assert.equal(eventTierOf("no_such_event_type"), undefined, "未知类型必须回 undefined，而不是回一个能删的档位");
  assert.equal(eventTierOf(undefined), undefined);
});

test("T6 别名与通道的现验：`assistant_delta` / `tool_call_delta` 本仓从不发出，`judge` 走 `onJudge` 通道", () => {
  // 引擎侧不发这两个名字：全仓（src/ bin/ examples/）逐字扫，只允许出现在**本表与两份文档**里。
  const haystack = [...sourceFiles(), ...sourceFiles(join(REPO_ROOT, "bin"), "bin/"), ...sourceFiles(join(REPO_ROOT, "examples"), "examples/")]
    .filter((file) => !file.path.endsWith("loop/event-tiers.js"));
  for (const alias of ["assistant_delta", "tool_call_delta"]) {
    const hits = haystack.filter((file) => file.source.includes(`"${alias}"`) || file.source.includes(`"${alias}`));
    assert.deepEqual(hits.map((file) => file.path), [], `\`${alias}\` 在 src/ bin/ examples/ 里不该有任何出现（它是宿主自己入库时的拼写）`);
  }
  // `judge` 不是 `LoopEvent` 的一格：`emitJudge` 铺的是 `{...correlation, ...info}`，没有 `type`。
  const orchestrator = readFileSync(join(SRC_DIR, "loop", "orchestrator.js"), "utf8");
  assert.match(orchestrator, /onJudge\(\{ \.\.\.runLoopState\.judgeRecordCorrelation, \.\.\.info \}\)/u,
    "`emitJudge` 的形状变了（不再铺 `{...correlation, ...info}`）—— `judge` 这条别名条目要重新核");
  assert.ok(!orchestrator.includes("type: \"judge\""), "引擎侧若真的开始发 `type: \"judge\"`，它就该是引擎名而不是通道拼写");
});

// ───────────────────────────── T7 终态名单也从代码真值现推 ─────────────────────────────

/** 在深度 0 上切实参（字符串里的逗号不算）。 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== "") {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if ("([{[".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** 只取**三元分支**上的纯字面量（`cond ? "a" : "b"` ⇒ `["a","b"]`）；比较式里的字面量不是状态名。 */
function branchLiterals(text) {
  const segments = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== "") {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (depth === 0 && (char === "?" || char === ":")) {
      segments.push(text.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(text.slice(start));
  return segments
    .map((segment) => segment.trim())
    .filter((segment) => /^[a-z_][a-z0-9_]*$/.test(segment) === false && /^["']([a-z_][a-z0-9_]*)["']$/u.test(segment))
    .map((segment) => segment.slice(1, -1));
}

/**
 * 抽 `markRunState(...)` **写点**里的状态名。
 *
 * 三种形状都要能读：字面量（`markRunState("running")`）、三元（`signal?.aborted ? "aborted" : "failed"`）、
 * 变量（`const state = …三元…` 之后 `markRunState(state)`）。store 里那两个**定义**
 * （`async markRunState(runId, state) {`）不是写点，按「右括号后面紧跟 `{`」排除。
 * 读不到就 `throw`/红 —— 绝不在空集上变绿。
 *
 * @param {Array<{path: string, source: string}>} files
 * @returns {Map<string, string[]>} 状态名 → 写点位置
 */
function markedRunStatuses(files) {
  const found = new Map();
  let definitions = 0;
  let writeSites = 0;
  const record = (literal, where) => {
    if (!found.has(literal)) found.set(literal, []);
    found.get(literal).push(where);
  };
  for (const { path, source } of files) {
    const masked = codeOnly(source);
    for (const match of masked.matchAll(/\bmarkRunState\s*\(/gu)) {
      const openIndex = match.index + match[0].length - 1;
      const closeIndex = closingParen(masked, openIndex);
      const where = `${path}:${masked.slice(0, match.index).split("\n").length}`;
      assert.notEqual(closeIndex, -1, `${where}：\`markRunState(\` 括号配不上，读不到真值`);
      const argument = source.slice(openIndex + 1, closeIndex).trim();
      if (masked.slice(closeIndex + 1).trimStart().startsWith("{")) {
        definitions += 1; // store 的实现（形参名），不是写点
        continue;
      }
      writeSites += 1;
      const literals = splitTopLevel(argument)
        .map((part) => part.trim())
        .filter((part) => /^["'][a-z_][a-z0-9_]*["']$/u.test(part))
        .map((part) => part.slice(1, -1));
      if (literals.length === 0) literals.push(...branchLiterals(argument));
      if (literals.length === 0) {
        const name = /^[a-zA-Z_$][\w$]*$/u.exec(argument)?.[0];
        assert.ok(name, `${where}：\`markRunState(\` 的参数既不是字面量、也不是三元、也不是可追踪的变量：${argument.slice(0, 40)}`);
        const declaration = new RegExp(`\\bconst\\s+${name}\\s*=([\\s\\S]{0,400}?);`, "u").exec(source);
        assert.ok(declaration, `${where}：找不到 \`const ${name} = …\` 的初始化式，读不到真值`);
        literals.push(...branchLiterals(declaration[1].trim()));
      }
      assert.ok(literals.length > 0, `${where}：\`markRunState(\` 里抽不到任何状态名（读不到真值 ⇒ 红）`);
      for (const literal of literals) record(literal, where);
    }
  }
  assert.ok(writeSites > 0, "一个 `markRunState` **写点**都没读到（只读到定义也算没读到）—— 终态名单的真值丢了，判据不许在空集上变绿");
  assert.ok(definitions > 0, "一个 `markRunState` 定义都没读到 —— store 的形状改了，本抽取器的「定义 vs 写点」区分要重新核");
  assert.ok(found.size > 0, "写点里抽不到任何状态名 —— 判据不许在空集上变绿");
  return found;
}

test("T7 终态名单从 `markRunState` 写点现推：等于名单 ∪ {running}，且 `running` 不是终态", () => {
  const writers = sourceFiles().filter((file) => file.source.includes("markRunState("));
  const written = new Set(markedRunStatuses(writers).keys());
  assert.deepEqual(
    [...written].sort(),
    [...RUN_TERMINAL_STATUSES, "running"].sort(),
    "`markRunState` 真写出的状态名与本仓登记的终态名单（+ 非终态的 running）必须逐字相等；"
      + "新增终态而不改名单 ⇒ 这条红并点名",
  );
  assert.ok(!RUN_TERMINAL_STATUSES.includes("running"), "`running` 必须是**非**终态：在飞与崩在半路的 run 都不许被清理");
  assert.ok(!RUN_TERMINAL_STATUSES.includes("persistence_failed"), "`persistence_failed` 是 termination.reason，不是 markRunState 的状态名");
});

// ───────────────────────────── T8 清理谓词的失败方向 ─────────────────────────────

test("T8 清理谓词 fail-closed：只有「stream ∧ 终态 ∧ 过了窗口」三条同时成立才可删", () => {
  const terminal = "succeeded";
  assert.equal(streamCleanupEligible({ type: "delta", runStatus: terminal, ageMs: 10, retentionMs: 1 }), true);
  assert.equal(streamCleanupEligible({ type: "assistant_delta", runStatus: terminal, ageMs: 10, retentionMs: 1 }), true);
  assert.equal(streamCleanupEligible({ type: "tool_use", runStatus: terminal, ageMs: 10, retentionMs: 1 }), false, "fact 永不可删");
  assert.equal(streamCleanupEligible({ type: "recovering", runStatus: terminal, ageMs: 10, retentionMs: 1 }), false, "derived 由宿主自己处置，谓词不替它删");
  assert.equal(streamCleanupEligible({ type: "brand_new_event", runStatus: terminal, ageMs: 10, retentionMs: 1 }), false, "未知类型不许删");
  assert.equal(streamCleanupEligible({ type: "delta", runStatus: "running", ageMs: 10, retentionMs: 1 }), false, "在飞的 run 不许删");
  assert.equal(streamCleanupEligible({ type: "delta", ageMs: 10, retentionMs: 1 }), false, "读不到终态就不许删（崩在半路 / store 没有 markRunState）");
  assert.equal(streamCleanupEligible({ type: "delta", runStatus: terminal, ageMs: 1, retentionMs: 10 }), false, "没过保留窗口");
  assert.equal(streamCleanupEligible({ type: "delta", runStatus: terminal, ageMs: 10 }), false, "窗口没给 ⇒ 不判");
  assert.equal(streamCleanupEligible(), false);
  for (const status of RUN_TERMINAL_STATUSES) {
    assert.equal(streamCleanupEligible({ type: "delta", runStatus: status, ageMs: 10, retentionMs: 1 }), true, `${status} 是终态`);
  }
});

// ───────────────────────────── T9 契约中英两张分级表与本表逐行对齐 ─────────────────────────────

/** 抽本次新增那一节（标题里带 `issue #743`）里的分级表行：第一列 `` `名字` ``、第二列 `` `档位` ``。 */
function docTierRows(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^#{2,3}\s/.test(line) && /issue\s+#743/iu.test(line));
  assert.notEqual(start, -1, "契约里没有「标题带 issue #743」的那一节 —— 新增那节被改名或删了");
  const section = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{2,3}\s/.test(lines[index])) break;
    section.push(lines[index]);
  }
  const rows = [];
  for (const line of section) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const name = /^`([a-z][a-z0-9_]*)`$/.exec(cells[1] ?? "")?.[1];
    const tier = /^`([a-z]+)`$/.exec(cells[2] ?? "")?.[1];
    if (name === undefined || tier === undefined) continue;
    if (!EVENT_TIER_VALUES.includes(tier)) continue;
    rows.push({ name, tier });
  }
  return rows;
}

test("T9 契约中英两份的分级表逐行等于 EVENT_TIERS，且中英两侧彼此相等（中英对齐是机器判据）", () => {
  assert.ok(existsSync(EN_DOC) && existsSync(CN_DOC), "两份契约文档必须在树里");
  const en = docTierRows(readFileSync(EN_DOC, "utf8"));
  const cn = docTierRows(readFileSync(CN_DOC, "utf8"));
  const table = Object.entries(EVENT_TIERS).map(([name, tier]) => `${name}=${tier}`).sort();
  for (const [label, rows] of [["EN", en], ["CN", cn]]) {
    assert.ok(rows.length > 0, `${label} 契约里抽到 0 行分级表 —— 表格形状变了或解析器坏了，判据不许在空集上变绿`);
    assert.deepEqual(
      [...new Set(rows.map((row) => `${row.name}=${row.tier}`))].sort(),
      table,
      `${label} 契约的分级表与 EVENT_TIERS 不一致（逐行比 \`名字=档位\`）`,
    );
  }
  assert.deepEqual(en, cn, "中英两侧的分级表行序与内容必须逐处一致");
});
