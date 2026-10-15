// @ts-check
/**
 * `parseModelJson` —— 本仓「从模型文本里抠 JSON」的**唯一公共入口**（issue #307）。
 *
 * 病根：同一个动作（在夹带散文的模型输出里找 JSON 对象）在本仓有四套写法，对「对象到哪里
 * 结束」各持一说 —— 顶层平衡扫描（`jsonCandidates`，`src/text/json-candidates.js`）、
 * 每个 `{` 起扫一次（`parseJudgeDecision`，`src/reflection/judge.js`）、标签内提取（`src/reflection/l0.js`）、
 * 行锚定正则（`src/compact/fold-statistical.js`）。前两套是本刀的范围：调用方不再自带扫描器，
 * 一律经本入口，扫描实现因此只剩**一份文件里的两档**。
 *
 * 只做**搬运**，不做**改写**：命中即原样 `JSON.parse` 的结果，失败即失败 ——
 * 不补闭合括号、不改值、不清洗尾逗号（「归一化器只许搬运」章程，
 * 见 `docs/host-consumer-contract_cn.md`）。
 *
 * 两档扫描的区别就是本入口存在的理由，别当成开关随便选：
 * - `topOnly: true`（缺省）：只认括号深度归零的顶层对象。外层未闭合时**一个候选都不产**，
 *   于是不会把内层残片当成模型写的那个对象。
 * - `topOnly: false`：从**每个** `{` 起扫一次 ⇒ 外层未闭合时会先产内层残片。
 *   这一档只是为了让 `parseJudgeDecision`（`src/reflection/judge.js`）复用同一份扫描而
 *   **语义一字不变**（issue #309 才改它的行为，本刀不改）。
 */

import { jsonCandidates } from "./json-candidates.js";

/**
 * 每个 `{` 起扫一次的候选扫描 —— 从 `parseJudgeDecision`（`src/reflection/judge.js`）
 * 的私有 `jsonCandidates` 逐字搬来（issue #307），产出顺序与切片必须与它一字不差：
 * 同一个起点最多产一个候选（深度归零即止），后一个起点照样起扫。
 *
 * 为什么不并进 `jsonCandidates`（`src/text/json-candidates.js`）：那份文件的契约就是
 * 「只产顶层平衡对象」，中英契约都按这句话写着；两档并存的事实由本入口的 `topOnly` 承担。
 *
 * @param {string} text
 * @returns {Generator<string, void, unknown>} 按起点下标升序产出的候选文本
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
 * 命中：值来自**第一个**可解析且形状合格的候选。
 *
 * `ok` 写成字面量 `true`（不是 `boolean`）是为了让 `.d.ts` 里产出**可收窄的判别联合**
 * ——`if (result.ok) result.value` 在宿主侧不收窄成 `any`（#213 记过两种静默退化：
 * 文档块不紧贴自己的声明、类型字面量里夹独占一行的 `//` 注释）。
 *
 * @typedef {object} ModelJsonHit
 * @property {true} ok
 * @property {Record<string, unknown>} value 命中候选的 `JSON.parse` 结果，未做任何改写
 * @property {"json"} via 来源标记：值来自可解析的候选对象
 * @property {string[]} candidates 扫描件产出的**全部**候选文本（按出现顺序，含未胜出的）
 */

/**
 * 三态失败，互不重叠：
 * - `no_candidate` 扫描件一个候选都没产（纯散文、或花括号全不配对）
 * - `unparsable` 有候选，但 `JSON.parse` 全部抛错（例：`{"a":,}`）
 * - `shape_mismatch` 有候选解析成功，但没有一个满足 `requireKeys`
 *
 * @typedef {"no_candidate" | "unparsable" | "shape_mismatch"} ModelJsonErrorKind
 */

/**
 * 失败：**没有 `value` 键**（不是 `value: undefined`）——宿主写 `if (!result.ok)` 之后
 * 手里什么都没有，就不会把一次失败的解析当成「模型给了个空对象」。
 *
 * @typedef {object} ModelJsonMiss
 * @property {false} ok
 * @property {ModelJsonErrorKind} error
 * @property {string[]} candidates
 */

/**
 * @typedef {ModelJsonHit | ModelJsonMiss} ModelJsonResult
 */

/**
 * 从可能夹带散文的模型文本里抠出一个 JSON 对象。
 *
 * 候选顺序 = 出现顺序；**第一个**「能 `JSON.parse` 且满足 `requireKeys`」的候选胜出，
 * 其余候选一个都不看（但照样出现在 `candidates` 里，供调用方自己复查）。
 * `candidates` 恒为**完整**扫描结果（扫到文本末尾才返回），因此调用方拿到它就能复刻
 * 「逐候选自己校验」的老写法 —— `parseJudgeDecision` 靠这一点保持行为逐字不变。
 *
 * `requireKeys` 是**键存在性**判定，且是 any-of：候选至少含有其中一个键即算合格。
 * 为什么是 any-of：reflection 的决策对象六个字段**全部可缺省**（`{"progress":3}` 是合法决策），
 * 「必须同时含齐六个」会把合法半集全打成 `shape_mismatch`。它**不**校验类型 ——
 * 值类型合不合格是调用方的事（同「只共享扫描、不共享校验」的分工）。
 *
 * @param {string} text 模型输出原文（`null` / `undefined` 当空串处理）
 * @param {{
 *   topOnly?: boolean,                // true（缺省）= 只认顶层平衡对象；false = 每个 `{` 起扫一次
 *   requireKeys?: readonly string[] | null  // 候选必须至少含其中一个键；null / 空数组 = 不做形状校验
 * } } [options]
 * @returns {ModelJsonResult} 命中带 `value`；失败只带 `error`，**不带** `value`
 */
export function parseModelJson(text, { topOnly = true, requireKeys = null } = {}) {
  const value = String(text ?? "");
  const scan = topOnly ? jsonCandidates : everyStartCandidates;
  /** @type {string[]} */
  const candidates = [];
  for (const candidate of scan(value)) candidates.push(candidate);

  const required = Array.isArray(requireKeys) ? requireKeys : [];
  let parseable = 0;
  for (const candidate of candidates) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue; // 这个候选不是合法 JSON：试下一个，**不**修补它
    }
    parseable += 1;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = /** @type {Record<string, unknown>} */ (parsed);
    if (required.length > 0 && !required.some((key) => Object.prototype.hasOwnProperty.call(record, key))) continue;
    return { ok: true, value: record, via: "json", candidates };
  }

  /** @type {ModelJsonErrorKind} */
  const error = candidates.length === 0
    ? "no_candidate"
    : parseable === 0 ? "unparsable" : "shape_mismatch";
  return { ok: false, error, candidates };
}
