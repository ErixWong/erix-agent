// @ts-check
/**
 * 从模型文本里抠 JSON 的**唯一公共入口**（issue #307）。
 *
 * 本仓原本有四套「从模型文本抠 JSON」的实现：`jsonCandidates`（顶层平衡扫描，
 * `src/text/json-candidates.js`）、`parseJudgeDecision` 的 every-start 扫描
 * （`src/reflection/judge.js`）、`<erix-summary>` 标签内提取（`src/reflection/l0.js`）、
 * 行锚定正则（`src/compact/fold-statistical.js`）。#305 收了第一套的扫描，本件把
 * 「扫描 + 逐个试解析 + 三态失败」这一段收成可调用的公共面，并让**判据可分**：
 * 一个候选都没有 / 有候选但全解析不了 / 解析成功却形状不合格，是三种不同的事实。
 *
 * **没有 repair**：不补闭合括号、不改值、不做任何归一化。理由见
 * `docs/host-consumer-contract_cn.md` 的「归一化器只许搬运」章程——一旦允许修补，
 * 「模型到底写了什么」就再也查不回来了。解析不了就报 `unparsable`，把判断还给调用方。
 *
 * `topOnly: false` 是留给 issue #309 的口子：它逐字复刻 judge 现在的 every-start 行为
 * （从**每个** `{` 各起扫一次，于是外层对象未闭合时会把**内层残片**当成候选）。
 * 本刀不改 judge 语义，只让它复用这份扫描件。
 */

import { jsonCandidates } from "./json-candidates.js";

/**
 * every-start 扫描：从文本里**每一个** `{` 各起一次括号配对扫描，产出一个平衡对象就停。
 *
 * 逐字搬自 `src/reflection/judge.js`（原本地 `jsonCandidates`），一个字没改语义：
 * 包括「起点字符本身不判断是否落在字符串里」这一既有口径（从字符串内部的 `{` 起扫会
 * 产出 `{"a":1}` 里那段 `{a}` 式的碎片候选，它解析不了、被调用方跳过）。
 *
 * @param {string} text
 * @returns {Generator<string, void, unknown>} 按起点位置升序产出的候选文本
 */
function* everyStartCandidates(text) {
  const value = String(text ?? "");
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const character = value[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
        continue;
      }
      if (character === "\"") inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          yield value.slice(start, index + 1);
          break;
        }
      }
    }
  }
}

/**
 * 三态失败原因，彼此**可分**（宿主可据此区分「模型没写」「模型写坏了」「模型写的不是这个」）：
 *
 * - `"no_candidate"`：文本里一个平衡对象切片都没有（纯散文，或 `{` 永不闭合且无内层）。
 * - `"unparsable"`：有候选，但每一个 `JSON.parse` 都失败（例：`{"a":,}`）。
 * - `"shape_mismatch"`：有候选且至少一个解析成功，但都不满足 `requireKeys`。
 *
 * @typedef {"no_candidate" | "unparsable" | "shape_mismatch"} ModelJsonError
 */

/**
 * 命中：拿到一个可解析、且（在传了 `requireKeys` 时）形状合格的候选对象。
 *
 * `value` 是 `JSON.parse` 的直接产物（未做任何搬运/校验/默认值填充），类型为 `unknown`：
 * 字段合不合法是调用方的事，本件不替宿主猜。
 *
 * @typedef {object} ModelJsonHit
 * @property {true} ok
 * @property {unknown} value 解析出的对象（未校验）
 * @property {"json"} via 来源标记：值来自一次成功的 `JSON.parse`
 * @property {string[]} candidates 本次扫描到的全部候选文本（含解析失败的）
 */

/**
 * 未命中：`error` 说明是哪一种失败。
 *
 * **没有 `value` 键**（不是 `value: undefined`）——`"value" in result` 可用来区分
 * 「没有值」和「值恰好是 undefined」，宿主不必去猜。
 *
 * @typedef {object} ModelJsonMiss
 * @property {false} ok
 * @property {ModelJsonError} error
 * @property {string[]} candidates 本次扫描到的全部候选文本（`no_candidate` 时为空数组）
 */

/**
 * 可收窄的判别联合：`if (result.ok)` 之后 `result.value` 存在，
 * `else` 分支里 `result.error` 存在且 `result.value` 不存在。
 *
 * @typedef {ModelJsonHit | ModelJsonMiss} ModelJsonResult
 */

/**
 * @typedef {object} ModelJsonOptions
 * @property {boolean} [topOnly] `true`（默认）只产**顶层平衡**对象；`false` 走 every-start，
 *   于是外层未闭合时会产出**内层残片**（`src/reflection/judge.js` 的现状语义，#309 才改）。
 * @property {string[] | null} [requireKeys] 候选对象**至少含其中一**个键才算形状合格；
 *   `null`/空数组 = 不做形状校验。**是「任一」而不是「全部」**：本仓两个调用方都要的是
 *   「模型写了这个协议的部分字段」——六字段可缺省带默认是 reflection 的既有契约
 *   （issue #305：半集是合法输入），要求全存在会把 `{"progress":3}` 打成失败。
 */

/**
 * 从可能夹带散文/代码围栏的模型输出里抠出一个 JSON 对象。
 *
 * 候选按出现顺序逐个试：解析不了就试下一个（不修补）；解析成功但不满足 `requireKeys`
 * 也试下一个。第一个两者都过的候选即胜出。
 *
 * 三种失败的优先级：`no_candidate` > `unparsable` > `shape_mismatch`
 * （候选为空时无从谈起解析；全解析失败时无从谈起形状）。
 *
 * @param {string} text 模型原始文本
 * @param {ModelJsonOptions} [options]
 * @returns {ModelJsonResult}
 */
export function parseModelJson(text, options = {}) {
  const { topOnly = true, requireKeys = null } = options ?? {};
  const scan = topOnly === false ? everyStartCandidates(text) : jsonCandidates(text);
  const candidates = [...scan];
  if (candidates.length === 0) return { ok: false, error: "no_candidate", candidates };

  const required = Array.isArray(requireKeys) ? requireKeys : [];
  let parsedAny = false;
  for (const candidate of candidates) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue; // 这个候选不是合法 JSON：试下一个，不修补
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    parsedAny = true;
    if (required.length > 0
      && !required.some((key) => Object.prototype.hasOwnProperty.call(parsed, key))) {
      continue;
    }
    return { ok: true, value: parsed, via: "json", candidates };
  }

  return {
    ok: false,
    error: parsedAny ? "shape_mismatch" : "unparsable",
    candidates,
  };
}
