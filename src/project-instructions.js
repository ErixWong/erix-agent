// @ts-check
// 项目约定文件发现（issue #716）：`<cwd>/AGENTS.md` → 可拼进系统提示的一段。
//
// 分层规矩（#184 确立）：凡可被 import 的实现住 `src/`，`bin/` 只做装配与呈现。这里只有**机制**
// （读文件 + 上限截断 + 形状）；「拼进系统提示的哪一段」「要不要往 stderr 打留痕行」是 CLI 政策，
// 归 `bin/system-prompt.js`。
//
// ⚠ 根只有 `cwd` 一层：**不向上走父目录**，**不碰 `home`**（home 层是 issue #717 的未决决策），
// 也**不猜路径**——`cwd` 必须由调用方显式传入（先例：`src/skills/loader.js` 的 `bundledDir`，
// 它第 10 行钉着「库内一律不猜路径」）。为什么库内不猜：`import.meta.url` 派生出来的相对层级在
// `bin/`、`src/`、宿主从 npm 包装出来的三种布局下各不相同，猜错时的症状是「静默发现不到」
// 而不是报错——最难查的那种坏。
//
// 文件不存在 ⇒ **空集合、不抛**：绝大多数目录没有 AGENTS.md，这是常态，抛异常会让 CLI 起不来。
// 读不了（EACCES / EISDIR 一类）同样不抛，进 `skipped` 让调用方自己决定要不要说出去。

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** 项目约定文件名（当前唯一支持的根文件）。 */
export const PROJECT_INSTRUCTIONS_FILENAME = "AGENTS.md";

/**
 * 注入总字节上限（64 KiB = 65,536 字节）。超限**截断**并在返回值里报 `truncated: true`——不静默丢。
 *
 * 为什么要有上限：这段内容拼进 system，被 `markStablePrefix` 打上 `cacheBoundary` 后**常驻**
 * 每一轮请求（折叠只动 `messages`、不动 `mainSystem`）。一份超大约定文件会把上下文预算吃掉一大块：
 * 本仓自己的 `AGENTS.md` 瘦身前是 112,464 字节，issue #726 之后实测 **32,698 字节**。
 *
 * 为什么是 64 KiB（issue #721 的裁决，两个加数都可现查，不是感觉）：
 *   预算闸允许的两页上限之和 = 全局页 30,720 字节（`pi-tools:scripts/check-agents-budget.sh`）
 *                            + 本仓页 33,792 字节（`scripts/agents-directive-scan.mjs` 的 `LENGTH_BUDGETS`）
 *                            = **64,512 字节 ≤ 65,536 字节**，余量 **1,024 字节**。
 *   今天两页实测合计 63,197 字节（全局 30,499 + 本仓 32,698）⇒ 抬完之后当前**全装得下，不再切尾**；
 *   上限仍要留，因为预算闸还会继续放长。
 *
 * 旧值 32 KiB 为什么是缺陷（缺陷本体，不是审美）：它比预算闸**单页**允许的上限 33,792 字节还小，
 * 于是「预算闸判合法的正文，注入面装不下」——本仓热层离旧上限只剩 70 字节，再长 71 字节就静默切尾，
 * 而预算闸一路绿：两道闸互相不知道。今天它俩的关系由 `test/project-instructions-716.test.js` 里
 * 那条「预算闸 ⇄ 注入上限」的用例钉住，不再靠人记得。
 *
 * 代价要如实说：`cacheBoundary` 之后这些字节每轮重发，模型侧没有前缀缓存时**全额重付**——按 issue #721
 * 实测的 3.4 字节/token 折算，满额 65,536 字节 ≈ 19,275 tokens/轮。所以上限抬高必须与「截断对模型
 * 可见」同片到账（`bin/system-prompt.js` 的 `buildProjectInstructionsSection`），见 issue #721。
 */
export const PROJECT_INSTRUCTIONS_MAX_BYTES = 64 * 1024;

/**
 * 按 UTF-8 码点边界截断：半个多字节字符会变成 U+FFFD 进模型视野（那不是截断，是伪造内容）。
 *
 * @param {Buffer} buffer
 * @param {number} limit
 * @returns {Buffer}
 */
function truncateToUtf8Boundary(buffer, limit) {
  if (buffer.length <= limit) return buffer;
  let end = limit;
  // 续字节的高两位是 10；回退到「某个码点的首字节」（UTF-8 首字节最多带 3 个续字节）。
  let start = end - 1;
  let steps = 0;
  while (start > 0 && steps < 3 && (buffer[start] & 0xc0) === 0x80) {
    start -= 1;
    steps += 1;
  }
  const lead = buffer[start];
  const sequenceLength = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (start + sequenceLength > end) end = start;
  return buffer.subarray(0, end);
}

/**
 * 从「截断点之后被丢弃的那半段」里抽出 **Markdown 小节标题**（`#` 一到六级）。
 *
 * 为什么在 `src/` 算而不是在 `bin/` 算：全文只有这里拿得到（`content` 是截断后的），而「丢了哪些
 * 小节」正是 `bin/system-prompt.js` 要交给模型的那句话的内容。这是**只读事实**，不是截断策略：
 * 本单**不改**「按小节边界切」那半边（issue #721 裁决明确砍掉），切在哪就是哪，这里只负责把后果报名。
 *
 * 口径要如实：名单只保证「**完整落在丢弃段里**的标题」。截断点落在某行标题中间时，那半行的残段
 * 不构成一行标题 ⇒ 它不进名单（那种小节的前半截已随正文注入，本来就没全丢）。
 *
 * @param {Buffer} dropped 截断点之后的原始字节（已由 `truncateToUtf8Boundary` 对齐到码点边界）
 * @returns {string[]} 按出现顺序的小节标题（未截断时为空数组）
 */
function droppedSectionTitles(dropped) {
  if (dropped.length === 0) return [];
  const titles = [];
  for (const match of dropped.toString("utf8").matchAll(/^#{1,6}[ \t]+(\S[^\n]*)$/gmu)) {
    const title = (match[1] ?? "").trim();
    if (title !== "") titles.push(title);
  }
  return titles;
}

/**
 * @typedef {object} ProjectInstructionFile
 * @property {string} path 绝对路径（= `path.resolve(cwd)` + 文件名）
 * @property {string} content 注入的正文（已按上限截断）
 * @property {number} bytes 注入的字节数（截断后；`content` 的 UTF-8 长度）
 * @property {number} originalBytes 磁盘上的原始字节数
 * @property {boolean} truncated 这个文件是否被截断过
 * @property {string[]} droppedSections 因截断而未进入注入的小节标题（未截断时为空数组，issue #721）
 */

/**
 * @typedef {object} ProjectInstructionsDiscovery
 * @property {ProjectInstructionFile[]} files 发现并注入的文件（不存在时为空数组）
 * @property {number} totalBytes 注入的总字节数（截断后合计）
 * @property {number} originalBytes 原文总字节数
 * @property {boolean} truncated 是否有文件被截断
 * @property {number} limit 本次生效的字节上限（调用方可能覆盖缺省常量）
 * @property {string[]} droppedSections 被截断丢弃的小节标题（按出现顺序；未截断时为空数组）
 * @property {{ path: string, code: string }[]} skipped 存在但读不了的文件（不进 `files`、不算注入）
 */

/**
 * 读 `catch` 到的值上的一个字段（`code` / `name`）。
 *
 * 为什么要有这个函数：`catch (error)` 的绑定在 `--strict`（`useUnknownInCatchVariables`）下是
 * `unknown`，直读 `error.code` / `error.name` 是类型错误。语义与 `error?.field` **逐字一致**：
 * 非对象（含 `null` / `undefined` / 字符串 / 数字）一律 `undefined`，没有这个属性也是 `undefined`。
 *
 * @param {unknown} error
 * @param {"code" | "name"} field
 * @returns {unknown} 字段原值（可能是任何类型，调用方自己收口）
 */
function errorField(error, field) {
  const record = typeof error === "object" && error !== null
    ? error
    : typeof error === "function" ? error : null;
  if (record === null) return undefined;
  // 字面量 `in` 才能让 tsc 窄化出带该属性的形状（变量做 key 时只能窄到 `{}`）。
  if (field === "code") return "code" in record ? record.code : undefined;
  return "name" in record ? record.name : undefined;
}

/**
 * `code ?? name ?? 原值` 的字符串化——`skipped[].code` 的**唯一**来源（原来这段表达式抄了两遍）。
 *
 * 为什么不直接 `String(error)`：Node 的 fs 错误是 `Error` 实例，`String(err)` 得到
 * `Error: ENOENT: no such file or directory, stat '...'`（带路径，随 cwd 变），而留痕行要的是
 * 稳定的 `ENOENT`；自定义错误（如 `IdleTimeoutError`）往往只有 `name` 没有 `code`。
 *
 * @param {unknown} error
 * @returns {string}
 */
function errorCode(error) {
  return String(errorField(error, "code") ?? errorField(error, "name") ?? error);
}

/** @returns {ProjectInstructionsDiscovery} */
function emptyDiscovery(limit = PROJECT_INSTRUCTIONS_MAX_BYTES) {
  return {
    files: [],
    totalBytes: 0,
    originalBytes: 0,
    truncated: false,
    limit,
    droppedSections: [],
    skipped: [],
  };
}

/**
 * 发现 `<cwd>/AGENTS.md`（**只这一层**，不向上走、不碰 home）。
 *
 * `cwd` 在 JSDoc 里写成**可选**只是为了跟 `= {}` 这个默认值对齐（`--strict` 下默认值必须可赋给
 * 参数类型）：它**语义上仍是必填**，缺失时下面第一条守卫会抛 `TypeError`，守卫之后窄化成 `string`。
 * 改成「删掉 `= {}`」或「删掉守卫」都会改动运行期行为，不是这里该做的事。
 *
 * @param {{ cwd?: string, maxBytes?: number }} [options] `cwd` 必填：库内不猜路径。
 * @returns {ProjectInstructionsDiscovery}
 */
export function discoverProjectInstructions({ cwd, maxBytes = PROJECT_INSTRUCTIONS_MAX_BYTES } = {}) {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new TypeError(
      "discoverProjectInstructions 需要非空 cwd（字符串）：项目约定根由调用方显式给出，库内不猜路径",
    );
  }
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? maxBytes
    : PROJECT_INSTRUCTIONS_MAX_BYTES;
  const filePath = path.join(path.resolve(cwd), PROJECT_INSTRUCTIONS_FILENAME);

  let stats;
  try {
    stats = statSync(filePath);
  } catch (error) {
    // 不存在（或 cwd 本身不是目录）⇒ 空集合。这是常态，不是错误。
    const fsCode = errorField(error, "code");
    if (fsCode === "ENOENT" || fsCode === "ENOTDIR") return emptyDiscovery(limit);
    return { ...emptyDiscovery(limit), skipped: [{ path: filePath, code: errorCode(error) }] };
  }
  // 路径在、但不是普通文件（目录 / 设备 …）：算「没找到可用约定」，但把原因记进 `skipped`，
  // 免得调用方把它说成「这个目录没有 AGENTS.md」（那是另一件事）。
  if (!stats.isFile()) {
    return {
      ...emptyDiscovery(limit),
      skipped: [{ path: filePath, code: stats.isDirectory() ? "EISDIR" : "ENOTFILE" }],
    };
  }

  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (error) {
    return { ...emptyDiscovery(limit), skipped: [{ path: filePath, code: errorCode(error) }] };
  }

  const injected = truncateToUtf8Boundary(buffer, limit);
  const truncated = injected.length < buffer.length;
  const droppedSections = droppedSectionTitles(buffer.subarray(injected.length));
  return {
    files: [{
      path: filePath,
      content: injected.toString("utf8"),
      bytes: injected.length,
      originalBytes: buffer.length,
      truncated,
      droppedSections,
    }],
    totalBytes: injected.length,
    originalBytes: buffer.length,
    truncated,
    limit,
    droppedSections,
    skipped: [],
  };
}
