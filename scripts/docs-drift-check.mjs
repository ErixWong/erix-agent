#!/usr/bin/env node
// docs-drift-check.mjs — 文档事实漂移检查（issue #164；零依赖，仅 node: 内置）
//
// 背景：独立审计（#164）证明 README/requirements 会点状腐坏——版本号停在 0.9.0、
// stallDetection 默认模式写成 appear、模块地图漏了 src/display/、requirements 的
// 「当前版本」停在 0.8.0。这类漂移不影响测试变红，却会直接把宿主引导到错误默认值上。
// 本脚本把「文档说的 == 代码/清单里真实的那份」钉成可执行检查。
//
// 检查面（issue #164 的「数值层」。判据层——升级指南里的参考 SQL/谓词 sketch 必须与运行时同
// 判据——本轮仍只纳入人工检查清单，中期归 #158 三层可执行验证扩面）：
//   1. version    中英 README 与 docs/requirements 的「当前版本」声明必须 == package.json；
//                 文中出现的任何版本号都不得高于 package.json（不得把没发布的东西写成事实）
//   2. defaults   关键默认值白名单（stall 窗口与模式、maxRounds、TTL 与折叠阈值、judge
//                 interval/timeout/failureLimit、退避、reflection 门槛、notes 保留期…）逐条从
//                 源码参数默认值里抽真值，再要求中英文档同口径
//   3. pkg-block  README 引用的 files/exports JSON 围栏必须与 package.json 逐项一致；
//                 test/contract/index.js 再导出的套件必须真的在 npm files 白名单里
//   4. modulemap  src/ 下每个 .js 都必须出现在中英 README 的模块地图里
//   5. paths      README 引用的仓库内路径与 node <file> / npm run <script> 命令必须存在
//   6. skeleton   中英 README 标题数量与层级骨架必须一致（做法参考 docs-sync-check.mjs，更轻）
//
// 严重级与 #158 三层验证「先告警后阻塞」同口径：
//   - error（默认 exit 1）：会直接把宿主引导错的——当前版本声明、默认值、路径/命令、
//     files/exports 清单、模块地图、中英骨架、引用了高于 package.json 的版本。
//   - warn（默认 exit 0，`--strict` 升级为 error）：只表示「文档没跟上」的滞后信号——
//     版本历史最高条目落后于 package.json、requirements 阶段表 current 行落后、
//     `test/contract/index.js` 再导出的套件未进 npm `files`。
//
// 用法：
//   node scripts/docs-drift-check.mjs              # error 才阻塞
//   node scripts/docs-drift-check.mjs --strict     # warn 也阻塞
//   node scripts/docs-drift-check.mjs --verbose    # 打印每条规则的实测值与检查面

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");
const VERBOSE = process.argv.includes("--verbose");

const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const PKG_VERSION = PKG.version;

const README_EN = "README.md";
const README_CN = "README_cn.md";
const REQ_EN = "docs/requirements.md";
const REQ_CN = "docs/requirements_cn.md";

function read(rel) {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

const errors = [];
const warnings = [];
const checked = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
const note = (msg) => checked.push(msg);

/** 行内代码形式的值（`8`）；数字里的 `_` 分隔符（30_000）会被归一。 */
const bt = (v) => {
  const s = String(v);
  const norm = /^[\d_]+$/.test(s) ? s.replace(/_/g, "") : s;
  return "`" + norm + "`";
};
/** 把文档需要引用的字面量转成正则片段。 */
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 语义化版本比较：a<b → -1，a==b → 0，a>b → 1。 */
function cmpSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

// ── 1. 版本声明 ───────────────────────────────────────────────────────────────
// 「当前版本」的规范写法（新增/改写文档时请沿用，否则等于绕过检查）：
//   README.md     Current release: **vX.Y.Z**
//   README_cn.md  当前发布版本：**vX.Y.Z**
//   requirements  "…shipped in version X.Y.Z" / "package version X.Y.Z"
//                 「与 X.Y.Z 版本交付的实现」「package 版本 X.Y.Z」
const CURRENT_CLAIMS = [
  { file: README_EN, label: "README 当前发布行", re: /Current release:\s*\*\*v?(\d+\.\d+\.\d+)\*\*/ },
  { file: README_CN, label: "README_cn 当前发布行", re: /当前发布版本[：:]\s*\*\*v?(\d+\.\d+\.\d+)\*\*/ },
  { file: REQ_EN, label: "requirements 对照版本", re: /implementation shipped in version (\d+\.\d+\.\d+)/ },
  { file: REQ_EN, label: "requirements §4 对照版本", re: /exists in package version (\d+\.\d+\.\d+)/ },
  { file: REQ_CN, label: "requirements_cn 对照版本", re: /与\s*(\d+\.\d+\.\d+)\s*版本交付的实现/ },
  { file: REQ_CN, label: "requirements_cn §4 对照版本", re: /package 版本\s*(\d+\.\d+\.\d+)/ },
];

for (const claim of CURRENT_CLAIMS) {
  const text = read(claim.file);
  const matches = [...text.matchAll(claim.re.global ? claim.re : new RegExp(claim.re, "g"))];
  if (matches.length === 0) {
    err(`version: ${claim.file} 缺少「${claim.label}」声明（规范写法见 scripts/docs-drift-check.mjs 顶部注释），检查面失效本身就是漂移`);
    continue;
  }
  for (const m of matches) {
    if (m[1] !== PKG_VERSION) {
      err(`version: ${claim.file} 的「${claim.label}」写的是 ${m[1]}，package.json 是 ${PKG_VERSION}`);
    } else {
      note(`version: ${claim.file}「${claim.label}」= ${m[1]}（== package.json ${PKG_VERSION}）`);
    }
  }
}

// 文档里出现的任何版本号都不得高于当前发布版本（不得把未发布的东西写成事实）。
const FOUR_FILES = [README_EN, README_CN, REQ_EN, REQ_CN];
for (const rel of FOUR_FILES) {
  const text = read(rel);
  const seen = new Set();
  for (const m of text.matchAll(/(?<![\w./-])(?:v|V)?(\d+\.\d+\.\d+)(?![\w./-])/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    if (cmpSemver(m[1], PKG_VERSION) > 0) {
      err(`version: ${rel} 引用了高于 package.json（${PKG_VERSION}）的版本 ${m[1]}`);
    }
  }
}

// 「版本历史」/阶段表的最高条目落后于 package.json 只算滞后信号（先告警后阻塞）。
const HISTORY_MAX = { [README_EN]: /v(\d+\.\d+\.\d+)/g, [README_CN]: /v(\d+\.\d+\.\d+)/g };
for (const [rel, re] of Object.entries(HISTORY_MAX)) {
  const versions = [...read(rel).matchAll(re)].map((m) => m[1]);
  const max = versions.sort(cmpSemver).at(-1);
  if (max && cmpSemver(max, PKG_VERSION) < 0) {
    warn(`version: ${rel} 提到的最高版本是 ${max}，落后于 package.json 的 ${PKG_VERSION}（新版本条目/里程碑未补）`);
  } else if (max) {
    note(`version: ${rel} 提到的最高版本 ${max} == package.json ${PKG_VERSION}`);
  }
}

// requirements 阶段表里被标为 current 的那一行，必须覆盖当前版本。
for (const rel of [REQ_EN, REQ_CN]) {
  const row = read(rel)
    .split("\n")
    .find((line) => /^\|\s*\*\*v[\d.]+.*(?:—\s*(?:current|当前))/i.test(line));
  if (!row) {
    err(`version: ${rel} §4 阶段表找不到标为 current 的行，无法核对「当前版本」`);
    continue;
  }
  const versions = [...row.matchAll(/(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  const max = versions.sort(cmpSemver).at(-1);
  if (!max) {
    err(`version: ${rel} 的 current 行没有版本号：${row.slice(0, 60)}…`);
  } else if (cmpSemver(max, PKG_VERSION) < 0) {
    warn(`version: ${rel} 阶段表 current 行停在 ${max}，落后于 package.json 的 ${PKG_VERSION}`);
  } else {
    note(`version: ${rel} current 行覆盖到 ${max}（package.json ${PKG_VERSION}）`);
  }
}

// ── 2. 关键默认值白名单 ───────────────────────────────────────────────────────
// 每条规则：从源码里抽出**真值**（抽不到即规则失效 → error，逼着改代码的人同步改这里），
// 再用 must（正则模板）要求文档同口径、mustNot 拦住旧措辞复活。
const DEFAULT_RULES = [
  {
    id: "stallDetection 默认窗口与模式",
    src: "src/loop/orchestrator.js",
    srcRe: /stallDetection = \{ window: (\d+), mode: "(\w+)" \}/,
    docs: [README_EN, README_CN, REQ_EN, REQ_CN],
    must: ([w, mode]) => [new RegExp(`stallDetection[\\s\\S]{0,220}?window: ${w}, mode: "${mode}"`)],
    mustNot: [/default(?:se)? (?:mode|mode is)?\s*is\s*\n?\s*`?appear`?/, /默认模式是\s*`?appear`?/],
    hint: "orchestrator 的参数默认值是唯一真值（ERIX_STALL_MODE 只在运行时覆盖）",
  },
  {
    id: "maxRounds 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /\n\s+maxRounds = (\d+),/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`maxRounds[\\s\\S]{0,60}?(?:defaults to|默认为)\\s*${bt(v)}`)],
  },
  {
    id: "maxTokenContinuations 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /\n\s+maxTokenContinuations = (\d+),/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`maxTokenContinuations[\\s\\S]{0,40}?(?:defaults to|默认为)\\s*${bt(v)}`)],
  },
  {
    id: "tool-result TTL 默认轮数",
    src: "src/loop/tool-result-ttl.js",
    srcRe: /TOOL_RESULT_TTL_DEFAULT = (\d+)/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`toolResultTtl[\\s\\S]{0,40}?(?:defaults to|默认为)\\s*${bt(v)}`)],
  },
  {
    id: "toolResultFoldMinTokens 默认值",
    src: "src/loop/tool-result-ttl.js",
    srcRe: /TOOL_RESULT_FOLD_MIN_TOKENS_DEFAULT = (\d+)/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`toolResultFoldMinTokens[\\s\\S]{0,80}?(?:defaults to|默认为)[\\s\\S]{0,24}?${v}`)],
  },
  {
    id: "judgeIntervalRound 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /const judgeIntervalRound = [\s\S]{0,600}?: (\d+);/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`judgeIntervalRound[\\s\\S]{0,30}?(?:is|defaults to|为|默认为)\\s*${bt(v)}`)],
  },
  {
    id: "judgeInterceptTimeoutMs 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /const judgeInterceptTimeoutMs = [\s\S]{0,400}?: (\d[\d_]*);/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`judgeInterceptTimeoutMs[\\s\\S]{0,30}?(?:is|defaults to|为|默认为)\\s*${bt(v)}`)],
  },
  {
    id: "judgeFailureLimit 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /const roundJudgeFailureLimit = [\s\S]{0,300}?: (\d+);/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`judgeFailureLimit[\\s\\S]{0,40}?(?:defaults to|默认为)\\s*${bt(v)}`)],
  },
  {
    id: "reflection 自动启用门槛",
    src: "src/loop/reflection.js",
    srcRe: /DEFAULT_REFLECTION_MIN_ROUNDS = (\d+)/,
    docs: [README_EN, README_CN, REQ_EN, REQ_CN],
    must: ([v]) => [new RegExp(`maxRounds >= ${v}`)],
  },
  {
    id: "maxExtensions 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /const reflectionMaxExtensions = [\s\S]{0,300}?: (\d+);/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`maxExtensions[\\s\\S]{0,80}?${bt(v)}`)],
  },
  {
    id: "maxRoundsCap 兜底值",
    src: "src/loop/orchestrator.js",
    srcRe: /const reflectionMaxRoundsCap = [\s\S]{0,500}?: (\d+),/,
    docs: [README_EN, README_CN],
    must: ([v]) => [new RegExp(`maxRoundsCap[\\s\\S]{0,160}?${bt(v)}`)],
  },
  {
    id: "retry 退避下限/上限",
    src: "src/loop/orchestrator.js",
    srcRe: /const backoffBaseMs = [\s\S]{0,200}?: (\d+);[\s\S]{0,200}?const backoffMaxMs = [\s\S]{0,200}?: (\d+);/,
    docs: [README_EN, README_CN],
    must: ([base, max]) => [
      // 允许「A defaults to X and B to Y」这类共用动词的句式，因此按出现顺序校两个真值。
      new RegExp(`backoffBaseMs[\\s\\S]{0,120}?${bt(base)}[\\s\\S]{0,120}?backoffMaxMs[\\s\\S]{0,120}?${bt(max)}`),
    ],
  },
  {
    // issue #191：`writeToolNames` 的默认值不再是 orchestrator 里的字面量（它与 judge timeline 的回退
    // 已归一为 src/reflection/judge.js 的共享常量），真值从常量定义处抽。
    id: "writeToolNames 默认值",
    src: "src/reflection/judge.js",
    srcRe: /export const DEFAULT_WRITE_TOOL_NAMES = (\[[^\]]+\]);/,
    docs: [README_EN, README_CN],
    must: ([names]) => [
      new RegExp(`writeToolNames[\\s\\S]{0,60}?${esc(names)}`),
    ],
    hint: "judge 的默认写工具集；orchestrator 的参数默认值与 normalizeToolNameSet 回退共用这个常量",
  },
  {
    id: "writeToolPathKeys 默认值",
    src: "src/loop/orchestrator.js",
    srcRe: /\n\s+writeToolPathKeys = (\[[^\]]+\]),/,
    docs: [README_EN, README_CN],
    must: ([keys]) => [
      new RegExp(`writeToolPathKeys[\\s\\S]{0,60}?${esc(keys)}`),
    ],
  },
  {
    id: "notes 统一保留期",
    src: "src/store/notes.js",
    srcRe: /const DEFAULT_RETENTION_MS = (\d+) \* 24/,
    docs: ["docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([days]) => [new RegExp(`(?:default|默认)\\s*${days}\\s*(?:days|天)`, "i")],
    hint: "契约里 ERIX_NOTES_RETENTION_MS 的默认天数",
  },
  {
    // issue #184：readFile 有界读的默认上限只在契约文档里写了一次，
    // 没机器校验时改源码默认值不会让 check:docs 变红。
    id: "readFile max_bytes 默认值",
    src: "src/tools/file-tools.js",
    srcRe: /FILE_READ_MAX_BYTES_DEFAULT = ([\d_]+)/,
    docs: ["docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([v]) => [new RegExp(`max_bytes[\\s\\S]{0,200}?${bt(v)}`)],
    hint: "契约里 readFile 单次返回字节上限（ERIX_FILE_READ_MAX_BYTES）的默认值",
  },
  {
    // #184 追加轮 A：rg 与 grep 共用同一个命中行宽上限，全库只有源码这一处定义。
    id: "搜索命中行宽上限",
    src: "src/tools/file-tools.js",
    srcRe: /const GREP_LINE_LIMIT = (\d+);/,
    docs: [README_EN, README_CN, "docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([v]) => [new RegExp(`(?:${v} characters|${v} 字符|\`${v}\`)`)],
    hint: "两个搜索工具共用的命中行截断上限（README 与契约中英都按源码真值写；历史上是 200，#184 提到 500）",
  },
  {
    // #184 追加轮 A：默认按正则（与真实 rg/grep 一致）。锚点取**行为**而不是描述文案：
    // 把默认翻回字面量会让这条抽不到真值 → check:docs 变红，逼着同步四处文档。
    // #195 起别名把 mode 映射抽成了 aliasSearchMode()（searchText 与两个别名共跑一份实现体），
    // 锚点跟着改成那个映射的**真值行**：把 `is_regex === false` 改成正向判定，这里立刻变红。
    id: "rg 默认搜索模式为正则",
    src: "src/tools/file-tools.js",
    srcRe: /function aliasSearchMode\(input\) \{[\s\S]{0,120}?input\?\.is_regex === (false) \? "(literal)" : "(regex)"/,
    docs: [README_EN, README_CN, "docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([, literalMode, regexMode]) => [
      new RegExp(`is_regex[\\s\\S]{0,300}(?:regular expression|regex|${esc(regexMode)}|正则)`, "i"),
      new RegExp(`is_regex[\\s\\S]{0,300}(?:literal|${esc(literalMode)}|字面量)`, "i"),
    ],
    hint: "rg 默认正则是真实命令的口径；`is_regex=false` 才是字面量（rg --fixed-strings / grep -F），两处都要写",
  },
  {
    // issue #195 R1：`searchText` 的 `mode` **必填且无默认值**。锚点取源码里的取值集合
    // （行为真值，不是描述文案）：加/删一个取值，或文档偷偷写「默认 literal」，都会变红。
    id: "searchText mode 必填且无默认值",
    src: "src/tools/file-tools.js",
    srcRe: /const SEARCH_MODES = new Set\(\["(literal)", "(regex)"\]\)/,
    docs: [README_EN, README_CN, "docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([literalMode, regexMode]) => [
      new RegExp(`mode[\\s\\S]{0,320}(?:required|必填)`, "i"),
      new RegExp(`mode[\\s\\S]{0,320}(?:no default|\\u65e0\\u9ed8\\u8ba4\\u503c)`, "i"),
      new RegExp(`mode[\\s\\S]{0,320}?${esc(literalMode)}`, "i"),
      new RegExp(`mode[\\s\\S]{0,320}?${esc(regexMode)}`, "i"),
    ],
    // 「mode 默认 literal」就是本轮要修的谎，不许在文档里复活
    mustNot: [/mode[`"']?\s*(?:defaults to|默认(?:为|是))\s*`?(?:literal|regex)/i],
    hint: "searchText 的 mode 必填、无默认值（取值字面量来自源码 SEARCH_MODES）；中英四处都要写「必填 + 无默认 + 两个取值」",
  },
  {
    // issue #195 R2：名称过滤参数只有「匹配 basename」这一子集能力，所以它叫 name_pattern。
    // 锚点取**匹配对象**（path.basename 的那一处调用）而不是文案：把过滤改成整路径匹配 → 变红，
    // 逼着同步「只匹配文件名、不跨 /」这条口径（否则参数名又开始撒谎）。
    id: "name_pattern 只匹配文件名（不跨 /）",
    src: "src/tools/file-tools.js",
    srcRe: /nameExpression\.test\(path\.(basename)\(filePath\)\)/,
    docs: [README_EN, README_CN, "docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([target]) => [
      new RegExp(`name_pattern[\\s\\S]{0,300}(?:${target}|file name|\\u6587\\u4ef6\\u540d)`, "i"),
      new RegExp(`name_pattern[\\s\\S]{0,300}(?:never crosses|\\u4e0d\\u8de8)`, "i"),
    ],
    mustNot: [/name_pattern[\s\S]{0,120}?(?:full glob|\\u5b8c\\u6574 glob|\*\*\/\*\.\w+\s*(?:works|\\u751f\\u6548))/i],
    hint: "name_pattern 只匹配 basename、不跨 `/`；`**/*.ts` 一类完整 glob 不工作（锚点 = path.basename 那一处）",
  },
  {
    // issue #196 R1：截断 marker 必须给得出「下一步」。锚点取源码里那个**统一子句前缀**
    // （`NEXT_STEP_CLAUSE`，措辞的唯一来源）而不是文档文案：改前缀 = 模型可见承诺变了 → 本检查变红，
    // 逼着同步中英两处；文档把出口偷偷写成 `exec`/`sed`（本库没有的工具）也接不住这条锚点。
    id: "截断 marker 的「下一步」子句与允许点名的工具",
    src: "src/tools/file-tools.js",
    srcRe: /const NEXT_STEP_CLAUSE = "([^"]+)";/,
    docs: ["docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([clause]) => [
      new RegExp(esc(clause)),
      // 收紧条款：出口只能点名本模块的两个工具，并且文档要写明 `exec` 属 CLI 装配层
      new RegExp(`readFile[\\s\\S]{0,200}?searchText`),
      new RegExp(`exec[\\s\\S]{0,200}(?:belongs to the CLI|属 CLI 装配层)`, "i"),
    ],
    hint: "marker 的「下一步」子句（真值 = 源码 NEXT_STEP_CLAUSE）、只许点名 readFile/searchText、以及「exec 属 CLI 装配层所以不得进 marker」这条收紧，中英两处都要写",
  },
  {
    // issue #196 R2：结果文本里的字节数走 formatSize。锚点取源码真值：默认上限 262144 经
    // `/ 1024` 推导出的可读值（当前 256KB）+ 单位字面量 KB/MB/GB/TB。改默认值或改单位 → 变红。
    // ⚠ 追加轮 R6 加了 GB/TB 两档，这里必须**逐档**抽字面量：只写死 KB/MB 的话，加档（或把
    //   新档写成 GB 以外的字面）文档与检查面都会静默失效——检查面漏掉一档等于那一档没有契约。
    id: "marker 字节数的可读单位（formatSize）",
    src: "src/tools/file-tools.js",
    srcRe: /export const FILE_READ_MAX_BYTES_DEFAULT = ([\d_]+);[\s\S]*?return `\$\{kb\}(KB)`;[\s\S]*?toFixed\(1\)\}(MB)`;[\s\S]*?toFixed\(1\)\}(GB)`;[\s\S]*?toFixed\(1\)\}(TB)`;/,
    docs: ["docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"],
    must: ([raw, unitKB, unitMB, unitGB, unitTB]) => {
      const kb = Number(String(raw).replace(/_/g, "")) / 1024;
      return [
        new RegExp("formatSize"),
        new RegExp(`${kb}${esc(unitKB)}`),
        new RegExp(esc(unitMB)),
        new RegExp(esc(unitGB)),
        new RegExp(esc(unitTB)),
        new RegExp("1024 基数|1024 base"),
        new RegExp("裸字节数|raw byte count"),
      ];
    },
    hint: "契约里要写：导出名 formatSize、默认上限的可读形式（由源码 262144/1024 推导）、KB/MB/GB/TB 四档单位与 1024 基数、以及「可读值不与裸字节数并存」",
  },
];

for (const rule of DEFAULT_RULES) {
  const srcText = read(rule.src);
  const m = srcText.match(rule.srcRe);
  if (!m) {
    err(`defaults: 规则「${rule.id}」在 ${rule.src} 里抽不到真值——源码形状变了，请同步更新本脚本（否则检查面会静默失效）`);
    continue;
  }
  const values = m.slice(1);
  for (const rel of rule.docs) {
    const text = read(rel);
    for (const re of rule.must(values)) {
      if (!re.test(text)) {
        err(`defaults: ${rel} 没有按源码真值声明「${rule.id}」= ${JSON.stringify(values)}（${rule.src}；规则提示：${rule.hint ?? "文档需与参数默认值同口径"}）`);
      }
    }
    for (const re of rule.mustNot ?? []) {
      if (re.test(text)) {
        err(`defaults: ${rel} 仍含有害旧措辞 /${re}/（「${rule.id}」的真值是 ${JSON.stringify(values)}）`);
      }
    }
  }
  note(`defaults: 「${rule.id}」实测值 ${JSON.stringify(values)}（${rule.src}），已在 ${rule.docs.join(" / ")} 核对`);
}

// ── 3. README 引用的 package.json 清单（files / exports）────────────────────────
function fencedJsonBlocks(rel) {
  const blocks = [];
  let current = null;
  for (const line of read(rel).split("\n")) {
    if (line.trim() === "```json") {
      current = [];
      continue;
    }
    if (current && line.trim() === "```") {
      blocks.push(current.join("\n"));
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  return blocks;
}

for (const rel of [README_EN, README_CN]) {
  const blocks = fencedJsonBlocks(rel).map((b) => {
    try {
      return JSON.parse(b);
    } catch {
      return undefined;
    }
  });
  const filesBlock = blocks.find((b) => Array.isArray(b) && b.includes("src"));
  const exportsBlock = blocks.find((b) => b && !Array.isArray(b) && b["./tools"]);
  if (!filesBlock) {
    warn(`pkg-block: ${rel} 没有可解析的 \`files\` JSON 围栏（无法与 package.json 比对）`);
  } else {
    const missing = PKG.files.filter((f) => !filesBlock.includes(f));
    const extra = filesBlock.filter((f) => !PKG.files.includes(f));
    if (missing.length || extra.length) {
      err(`pkg-block: ${rel} 的 files 清单与 package.json 不一致：缺 ${missing.join(", ") || "—"}；多 ${extra.join(", ") || "—"}`);
    } else {
      note(`pkg-block: ${rel} files 清单与 package.json 一致（${PKG.files.length} 项）`);
    }
  }
  if (!exportsBlock) {
    warn(`pkg-block: ${rel} 没有可解析的 \`exports\` JSON 围栏（无法与 package.json 比对）`);
  } else {
    // issue #213：`exports` 的每个子路径现在是条件对象（`{types, default}`）而不是字符串，
    // 所以这里做**结构化**比较（键排序后的深度比较），否则 `{}` 与 `{}` 用 `===` 永远不等。
    const canonical = (v) => JSON.stringify(v, (_k, val) =>
      (val && typeof val === "object" && !Array.isArray(val))
        ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
        : val);
    const keys = Object.keys(PKG.exports).sort();
    const docKeys = Object.keys(exportsBlock).sort();
    const same = keys.length === docKeys.length && keys.every((k, i) => docKeys[i] === k && canonical(exportsBlock[k]) === canonical(PKG.exports[k]));
    if (!same) {
      err(`pkg-block: ${rel} 的 exports 清单与 package.json 不一致：文档 ${JSON.stringify(exportsBlock)} vs package.json ${JSON.stringify(PKG.exports)}`);
    } else {
      note(`pkg-block: ${rel} exports 清单与 package.json 一致（${keys.length} 项）`);
    }
  }
}

// 随包发布的契约套件必须真的在 files 白名单里（否则宿主 import 'erix-agent/contract-tests' 会炸）。
const contractIndex = read("test/contract/index.js");
for (const m of contractIndex.matchAll(/from "\.\/([\w.-]+\.js)"/g)) {
  const rel = `test/contract/${m[1]}`;
  if (!PKG.files.includes(rel)) {
    warn(`pkg-block: ${rel} 被 test/contract/index.js（npm 入口 ./contract-tests）再导出，但不在 package.json 的 files 白名单里 → 发布包内该套件会缺失`);
  }
}

// ── 4. 模块地图完整性 ─────────────────────────────────────────────────────────
function walk(rel, acc = []) {
  for (const name of readdirSync(path.join(ROOT, rel))) {
    const childRel = `${rel}/${name}`;
    if (statSync(path.join(ROOT, childRel)).isDirectory()) walk(childRel, acc);
    else acc.push(childRel);
  }
  return acc;
}

const srcFiles = walk("src").filter((f) => f.endsWith(".js"));
for (const rel of [README_EN, README_CN]) {
  const mapBlock = read(rel)
    .split(/^```text$/m)
    .find((chunk) => chunk.includes("orchestrator.js") && chunk.includes("index.js"));
  if (!mapBlock) {
    err(`modulemap: ${rel} 找不到模块地图围栏（text 围栏块），检查面失效`);
    continue;
  }
  const counts = new Map();
  for (const m of mapBlock.matchAll(/([\w.-]+\.js)/g)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const missing = [];
  for (const f of srcFiles) {
    const base = path.basename(f);
    const needed = srcFiles.filter((x) => path.basename(x) === base).length;
    if ((counts.get(base) ?? 0) < needed) {
      counts.set(base, needed); // 同一缺失名只报一次
      missing.push(f);
    }
  }
  if (missing.length) {
    err(`modulemap: ${rel} 的模块地图缺少 ${missing.join(", ")}`);
  } else {
    note(`modulemap: ${rel} 覆盖 src/ 全部 ${srcFiles.length} 个文件`);
  }
}

// ── 5. README 引用的路径与命令 ────────────────────────────────────────────────
// 历史上真实存在过、但按文意必须保留的字面路径（退役说明、宿主侧证据路径）。
const EXPECTED_ABSENT_PATHS = new Set([
  "skills/notes/skill.mjs", // v0.11.0 已退役的兼容 shim，README 在讲「已删除」
  "src/loop.js", // v0.14.0 已删除的转发 shim，README 在讲迁移
  "judge.log", // 引擎写入 transcripts/outputs/<runId>/ 的运行产物名，不是仓库文件
  "erix-state/judge.log", // 2026-09 基准证据里的宿主侧路径，不在本仓库
]);

function candidatePaths(rel) {
  const out = new Set();
  const text = read(rel);
  // markdown 链接目标 + 行内代码里的路径
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) out.add(m[1]);
  for (const m of text.matchAll(/`([^`\s]+)`/g)) out.add(m[1]);
  // `node <path>` / `npm run <script>`
  const commands = [];
  for (const m of text.matchAll(/(?:^|\s)(?:LLM_KIT_E2E=1\s+)?node\s+([\w./-]+\.(?:mjs|js))/g)) {
    commands.push({ kind: "file", value: m[1] });
  }
  for (const m of text.matchAll(/npm run ([\w:.-]+)/g)) {
    commands.push({ kind: "script", value: m[1] });
  }
  const paths = [];
  for (const raw of out) {
    let p = raw;
    const url = p.match(/^https?:\/\/[^/]+\/(?:ErixWong\/erix-agent)?\/?(?:blob|tree)\/main\/(.+)$/);
    if (url) p = url[1];
    else if (/^https?:/.test(p)) continue;
    p = p.replace(/#.*$/, "");
    if (!p || p.startsWith("#")) continue;
    if (/^[~$]/.test(p)) continue; // 用户目录（~/.erix）与环境变量形式（$XDG_CONFIG_HOME）不属于本仓库
    if (p.startsWith(".")) continue; // .mcp.json / .erix/skills/ 这类宿主侧配置目录
    if (/[*<>|]/.test(p)) continue; // glob 与占位符
    if (!/\.(?:js|mjs|json|md|ts|sh|log|mjs)$|\/$/.test(p)) continue; // 只核对像路径的东西
    paths.push(p);
  }
  return { paths, commands };
}

for (const rel of [README_EN, README_CN]) {
  const { paths, commands } = candidatePaths(rel);
  const bad = [];
  for (const p of paths) {
    if (EXPECTED_ABSENT_PATHS.has(p)) continue;
    if (!existsSync(path.join(ROOT, p))) bad.push(p);
  }
  const badCommands = commands.filter((c) =>
    c.kind === "file"
      ? !existsSync(path.join(ROOT, c.value))
      : !(PKG.scripts ?? {})[c.value],
  );
  if (bad.length) {
    err(`paths: ${rel} 引用了仓库里不存在的文件：${bad.join(", ")}（确属历史事实就加进 EXPECTED_ABSENT_PATHS 并注明原因）`);
  }
  if (badCommands.length) {
    err(`paths: ${rel} 引用的命令不可执行：${badCommands.map((c) => (c.kind === "file" ? `node ${c.value}` : `npm run ${c.value}`)).join(", ")}`);
  }
  note(`paths: ${rel} 核对 ${new Set(paths).size} 个路径、${commands.length} 个命令（${[...new Set(commands.map((c) => (c.kind === "file" ? `node ${c.value}` : `npm run ${c.value}`)))].join(", ")}）`);
}

// ── 6. 中英 README 标题骨架 ───────────────────────────────────────────────────
function headingLevels(rel) {
  return read(rel)
    .split("\n")
    .reduce((acc, line, i) => {
      const m = line.match(/^(#{1,6})\s+(.*)/);
      if (m) acc.push({ line: i + 1, level: m[1].length, title: m[2].trim() });
      return acc;
    }, []);
}

const enH = headingLevels(README_EN);
const cnH = headingLevels(README_CN);
const seq = (hs) => hs.map((h) => h.level).join(",");
if (enH.length !== cnH.length) {
  err(`skeleton: 中英 README 标题总数不齐：EN ${enH.length} vs CN ${cnH.length}`);
}
if (seq(enH) !== seq(cnH)) {
  const i = [...seq(enH), "..."].findIndex((v, idx) => v !== [...seq(cnH), "..."][idx]);
  const at = Math.min(i, enH.length - 1, cnH.length - 1);
  err(
    `skeleton: 中英 README 标题层级序列不齐（第 ${i + 1} 个标题起）：EN「${enH[at]?.title ?? "无"}」(L${enH[at]?.line ?? "-"}) vs CN「${cnH[at]?.title ?? "无"}」(L${cnH[at]?.line ?? "-"})；`
    + `\n    EN ${seq(enH)}\n    CN ${seq(cnH)}`,
  );
}
for (const level of new Set([...enH.map((h) => h.level), ...cnH.map((h) => h.level)])) {
  const ne = enH.filter((h) => h.level === level).length;
  const nc = cnH.filter((h) => h.level === level).length;
  if (ne !== nc) err(`skeleton: h${level} 数量不齐：EN ${ne} vs CN ${nc}`);
}
if (!errors.some((e) => e.startsWith("skeleton:"))) {
  note(`skeleton: 中英 README 标题骨架一致（${enH.length} 个标题，层级序列相同）`);
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
if (VERBOSE) {
  console.log("docs-drift-check 检查面：");
  for (const c of checked) console.log(`  ✓ ${c}`);
}
if (errors.length || (STRICT && warnings.length)) {
  console.log(`docs-drift-check: 失败 — ${errors.length} 处漂移${STRICT && warnings.length ? `，${warnings.length} 处告警（--strict）` : ""}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  process.exit(1);
}
console.log(
  `docs-drift-check: OK — 版本/默认值/清单/模块地图/路径/中英骨架共 ${checked.length} 项对齐 package.json ${PKG_VERSION} 与源码`
  + (warnings.length ? `（${warnings.length} 处告警，先告警后阻塞：\n` + warnings.map((w) => `  ⚠ ${w}`).join("\n") + "\n）" : ""),
);
