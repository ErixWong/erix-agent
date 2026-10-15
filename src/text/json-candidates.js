// @ts-check
/**
 * 顶层平衡 JSON 对象扫描 —— 从可能夹带散文的文本里抠出 JSON 对象的**唯一共享扫描实现**。
 *
 * 供体：`jsonCandidates`（`src/reflection/wrapup.js`），为 issue #30 的 follow-up 而写；
 * issue #305 把它提取到这里，让 `parseReflectionDecision`（`src/loop/reflection.js`）复用同一份扫描，
 * 于是 wrapup 与 reflection 不再各持一套 JSON 抠取逻辑。
 *
 * 只共享**扫描**，不共享**校验**：产不产候选是语法事实，字段合不合法是调用方的事
 * （必填字段、类型、缺省值一律留在各调用方；reflection 六字段可缺省带默认，
 * 把 judge 的必填布尔校验搬过来会把 `{"progress":3}` 这种合法半集打成兜底）。
 */

/**
 * Single pass that only yields top-level balanced objects. Nested objects
 * inside a host JSON (e.g. {"summary":...,"meta":{"done":true}}) must not
 * be scanned as wrap-up candidates — an inner {done,...} would otherwise
 * bypass the mandatory-done guard (issue #30 follow-up).
 *
 * 为什么不用 `/{[\s\S]*}/`（贪婪）：它会把并列的两个顶层对象吞成一坨，
 * 于是两个都解析不了（issue #305 的翻转病根）。
 * 为什么不用 judge 的 every-start（每个 `{` 都起扫一次）：外层对象未闭合时，它会把
 * **内层残片**当成第一个合法候选返回，调用方拿到的就不再是模型真正写的那个对象。
 *
 * @param {string} text
 * @returns {Generator<string, void, unknown>} 按出现顺序产出的顶层平衡对象文本
 */
export function* jsonCandidates(text) {
  const value = String(text ?? "");
  let candidateStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) candidateStart = index;
      depth += 1;
    } else if (character === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && candidateStart >= 0) {
        yield value.slice(candidateStart, index + 1);
        candidateStart = -1;
      }
    }
  }
}
