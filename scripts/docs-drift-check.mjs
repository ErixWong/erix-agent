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
//   3. pkg-block  README 引用的 files/exports JSON 围栏必须与 package.json **双向对称**
//                 （issue #210：缺键/多键/改名/写重都红，并点名差在哪个键）；
//                 test/contract/index.js 再导出的套件必须真的在 npm files 白名单里
//   4. modulemap  src/ 下每个 .js 都必须出现在中英 README 的模块地图里
//   5. paths      中英 README + 中英契约 + `examples/pi-extension/README.md` + 中英 AGENTS 里引用的
//                 仓库内路径，以及 `node <file>` / `npm run <script>` 命令，必须存在（issue #273：
//                 覆盖面从「两个根 README」扩到「宿主/使用者真的会照着找文件的那批入口文档」）。
//                 解析按 仓库根 → 文档同目录 → 唯一同名文件 三级；解析不到的按**四类**裁决（见下方
//                 「引用裁决分类」），**没一个能整目录/整前缀豁免**
//   6. skeleton   中英 README 标题数量与层级骨架必须一致（做法参考 docs-sync-check.mjs，更轻）；
//                 `AGENTS.md` / `AGENTS_cn.md` 这一对同样纳入（issue #274 附带项）
//   7. anchors    「清单/枚举/单位」类锚点升级为**逐处一致 + 双向对称**（issue #210 R1）：
//                 文件工具清单、CLI 工具清单、vendor 跳过目录、formatSize 单位档位与它的
//                 示例映射、内置压缩策略名——每一处声明单独与源码真值比，另加中英声明点处数对账
//   8. markers    marker **字面量**同源（issue #272）：契约中英引用的 `toolMarker("readMoreLines")`
//                 输出串，必须逐字等于从 `src/tools/file-tools.js` 的模板 + `NEXT_STEP_CLAUSE` 渲染
//                 出来的那份（文档占位符 `N`/`M`/`K`/`<size>` 与插值表达式的对应表就写在规则里，
//                 模板里出现**未登记的插值**会直接红）；逐处比对，另加中英引用处数对账
//   9. baseline   `AGENTS*.md` 里声称的 `--checkJs` 棘轮**当前值**（issue #274）：与
//                 `scripts/type-check-ratchet.mjs` 的 `BASELINE_ROOT` / `BASELINE_WITH_TOOLS` 逐处比，
//                 额外核「`164 = 121 + 27 + 16`」这类分解式的算术闭合（首项必须 = 包根基线、
//                 总和必须 = 并集基线），中英句式处数成对
//
// 锚点粒度（issue #210 R3：**别把「存在性」锚点误当成「文档里删一处提及就会红」**）：
//   · 存在性（每档被检查文档至少命中一次即可；同一句里删掉额外一处提及不会红）：
//       defaults 的全部条目（`must` 是「文档里存在这个正则」，`mustNot` 才是逐处的）、
//       modulemap（只查 src→文档 方向：地图多写文件不会红）、paths（只查文档→仓库 方向）
//   · 逐处一致（每一处声明都单独比，缺/多/改名/写重都红）：
//       version 的「当前版本」声明与「不得高于 package.json」的全量版本号扫描、
//       pkg-block 的 files/exports（双向对称）、anchors 的清单/枚举/单位规则、
//       markers 的 marker 字面量（#272）、baseline 的棘轮当前值（#274）
//   · 中英对账（比的是处数与数量级）：skeleton 的标题数与层级序列（README **与** AGENTS 两对）、
//       anchors 的声明点处数、markers 的引用处数、baseline 的句式处数
//   未升级成逐处一致的条目，理由逐条写在对应规则的注释里（#210「不能机械化的写明为什么」）：
//   数值型 defaults 条目在文档里的句式是散文级的多种写法，强行套「声明句式正则」会把门禁
//   变成对措辞的绑架（改一次措辞就红，且红了也不知道是真漂移还是措辞漂移）；它们的
//   「文档必须与真值同口径」仍由 must/mustNot 钉住，只是「删掉一处额外提及」不红。

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
//   node scripts/docs-drift-check.mjs --self-test  # 把 #210 每条清单/单位锚点的反向证固化在脚本里：
//                                                  # 内存改文档一处 / 内存改源码一处 / 都不改，
//                                                  # 断言「改→红、不改→绿」；变异没落上去也算失败

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");
const VERBOSE = process.argv.includes("--verbose");

const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const PKG_VERSION = PKG.version;
/** `--self-test` 要连 package.json 一侧的改动一起测，所以清单真值走这个口子（有内存副本就用副本）。 */
function pkgNow() {
  const overlay = OVERLAY.get("package.json");
  return overlay ? JSON.parse(overlay) : PKG;
}

const README_EN = "README.md";
const README_CN = "README_cn.md";
const REQ_EN = "docs/requirements.md";
const REQ_CN = "docs/requirements_cn.md";
const CONTRACT_EN = "docs/host-consumer-contract.md";
const CONTRACT_CN = "docs/host-consumer-contract_cn.md";
const AGENTS_EN = "AGENTS.md";
const AGENTS_CN = "AGENTS_cn.md";
const PI_EXT_README = "examples/pi-extension/README.md";
const RATCHET_SRC = "scripts/type-check-ratchet.mjs";

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

// ── 2.5 「清单/枚举/单位」锚点：逐处一致 + 双向对称（issue #210 R1/R2/R3）─────────
//
// 为什么要有这一节：#164 留下的锚点绝大多数是**存在性**的（「文档里存在这个字符串吗」）。
// issue #210 把盲区摊开了：契约文档里 `TB` 出现 3 处，**删掉其中一处 → 检查面全绿**；README
// 引用的 `exports` 清单把 `"./tools"` 改名或整个删掉 → 也是全绿（块定位靠真值键，键没了就退化成
// warn）。存在性锚点管的是「有没有写」，管不住「写的每一处对不对」。
// 本节的口径（三件事，缺一条都算没修）：
//   ① **双向对称**（`assertSymmetric`）：文档声明的成员集合必须与源码真值集合**完全相等**——
//      缺、多、改名、写重都红，错误信息点名差在哪个成员；
//   ② **逐处**（`detectListClaims`）：声明点是一处一处比的，不是「全文抽到一次就算过」；
//   ③ **中英处数对账**（`assertPairCensus`）：同一条规则在中英两侧的声明点**处数**必须相等——
//      ②管不住「把某一侧的整句声明删掉」（剩下的那处仍然全等），③管得住。
// 「抽不到真值就报错」（#164 口径）保留：源码形状变了 → error；文档里一处声明都抽不到 → error
// （检查面失效本身就是漂移）。
//
// 下面这份「新增为什么值得升级到逐处」与紧接的「没升级」记录是对称的两份（#210 R3 的口径是
// 「没升级的必须写理由」，不是「升级了的不用写理由」）：
//   · markers（#272）：真值是源码里的**一个 template literal**，文档写的是它的占位符实例化形式
//     （`N`/`M`/`K`/`<size>`），两侧都是定长字符串，逐字比对不会变成措辞绑架（那正是数值型 defaults
//     不敢升级的理由，这里不存在）。实证代价：把 EN 契约里的 `（文件 <size>）` 段删掉后，`check:docs`
//     与 `check:docs:strict` 都还是 exit 0，只有 #267 加的**源码↔文档**测试会红——而文档是宿主
//     唯一读得到的面，那个测试又不进任何门禁。
//   · baseline（#274）：AGENTS 里那两个基线数是 `scripts/type-check-ratchet.mjs` 里两个常量的**复述**，
//     复述句式可枚举（`BASELINE_ROOT = N`、「基线常量 **N**」、「基线 **N** / 31 个文件」、「= 121 + 27 + 16」），
//     分解式还能自证算术。实证代价：#265 的 CHANGELOG 条目把棘轮写成开发中途的 `142→138 / 185→181`
//     （落树终局是 121 / 164），当时随提交留下了；#270 手工改了中英共 11 处当前值，全靠人逐字读。
//   · paths（#273）：覆盖面本身就是检查面。同一条不存在的仓内路径写进根 README 会 exit 1，写进
//     `examples/pi-extension/README.md` 却 exit 0（那个文件里一整段「已验证」叙述引用的测试文件名
//     全部无人校）——规则有效而覆盖面漏了，是比「规则本身弱」更便宜的一种修。
//
// 「声明点」的判据（诚实的边界，别当成真值）：一处清单声明 = 反引号/双引号包住的 token，用 `/`、
// `|`、`,`、`;`、`、` 或 `与`/`和`/`and` 这类连接符连成的序列，**或**单个反引号里的 `a | b | c`
// 取值串；并且它命中的真值成员数 ≥ ⌈|真值|×0.75⌉。阈值是判据：它把「`rg` / `grep` / `tree` 顺带
// 并列」这种子集提及排除在清单声明之外。代价写进 R3 的残留清单：**一份清单同时删掉 ≥25% 的成员
// 会掉到阈值以下而静默放行**（删 1 处一定红）。3 值枚举用 `pipeOnly` 把判据换成「必须是 `a | b | c`
// 取值串」，于是策略名那种 3 值枚举删 1 个也一定红，而「两种轮次折叠策略（`fold-statistical` 与
// `fold-llm`）」这种合法的部分提及不会被误判。
//
// 本单**没有**升级成逐处一致的清单类锚点（理由写在这里，不为完成率造弱断言）：
//   · `SEARCH_MODES`（`literal`/`regex`）：中英四处的句式完全不同（EN 是「`literal` matches…, `regex`
//     as…」两个独立句子，CN 是「`"literal"`（字面量）与 `"regex"`（…）」一处并列），抽不出跨语言的
//     「声明句式」；现有 must[] 已经要求四写「必填 + 无默认 + 两个取值」、mustNot 拦住「mode 默认
//     literal」复活，缺一个取值就红；剩下「文档多写一个假取值」不红——已列入残留清单。
//   · README「内置 CLI 工具」那句的真值不是单一符号：CLI 另外还注册 `todo_*`/`note_*` 会话工具，
//     那句话刻意只列文件/搜索工具 + `exec`。所以这里用 `contains` 模式（真值必须全覆盖 + 额外成员
//     必须是源码里真存在的工具名），而不是硬造一个「CLI 工具全集」当真值。
//   · 数值型 defaults 条目：同 §检查面 的说明——散文句式多变，强行钉句式会得到一个措辞绑架器。

/** `--self-test` 用：把某个文件的文本换成内存副本（不落盘、不动工作树）。 */
const OVERLAY = new Map();
const textOf = (rel) => OVERLAY.get(rel) ?? read(rel);

/** 双向对称的集合差：缺什么、多什么、写了重复成员。 */
function diffSets(truth, doc) {
  const uniq = (a) => [...new Set(a)];
  return {
    missing: uniq(truth).filter((x) => !doc.includes(x)),
    extra: uniq(doc).filter((x) => !truth.includes(x)),
    dup: doc.filter((x, i) => doc.indexOf(x) !== i),
  };
}

/**
 * 双向对称断言——#210 唯一的「文档清单 vs 源码真值」比较器，README 的 files/exports 与所有
 * 清单类锚点共用这一份（issue #210 追加评论要求的「可复用比较器」）。
 *   mode `exact`    两边集合必须完全相等（缺/多/改名/写重都红）
 *   mode `contains` 文档必须覆盖真值（缺 → 红）；允许额外成员，但额外成员必须出现在 `allowExtra`
 *                   里，否则算「文档凭空多写一个成员」→ 红
 * @returns {boolean} 该处声明是否与真值一致
 */
function assertSymmetric(out, { rule, where, truth, doc, mode = "exact", allowExtra = [], kind = "成员" }) {
  const { missing, extra, dup } = diffSets(truth, doc);
  const phantom = extra.filter((x) => !allowExtra.includes(x));
  const q = (a) => a.map((x) => JSON.stringify(x)).join("、");   // 成员带引号：`.` 这种键名不 quoting 就看不清
  if (missing.length) out.push(`${rule}: ${where} 缺 ${kind} ${q(missing)}（源码真值：${truth.join("、")}）`);
  if (mode === "exact" && extra.length) {
    out.push(`${rule}: ${where} 多出真值里没有的 ${kind} ${q(extra)}（源码真值：${truth.join("、")}）`);
  }
  if (mode === "contains" && phantom.length) {
    out.push(`${rule}: ${where} 多出真值与允许清单里都没有的 ${kind} ${q(phantom)}（文档写了源码里不存在的成员）`);
  }
  if (dup.length) out.push(`${rule}: ${where} 的 ${kind}清单里 ${q([...new Set(dup)])} 写了不止一次`);
  return !missing.length && !(mode === "exact" && extra.length) && !(mode === "contains" && phantom.length) && !dup.length;
}

/** 中英成对文档的声明点处数对账：删掉一侧的整句声明就在这里红（逐处一致管不到的那一路）。 */
function assertPairCensus(out, { rule, counts, docs }) {
  for (let i = 0; i + 1 < docs.length; i += 2) {
    const [en, cn] = [docs[i], docs[i + 1]];
    if (counts[en] === counts[cn]) continue;
    out.push(`${rule}: 声明点处数中英不齐：${en} ${counts[en]} 处 vs ${cn} ${counts[cn]} 处`
      + `（中英是成对译文，同一事实必须逐处对齐；只在一侧删掉整句声明就是这种形状）`);
  }
}

const LIST_TOKEN_RE = /[`"]([A-Za-z][A-Za-z0-9_.+-]*)[`"]/g;

/** 两个被引号包住的 token 之间是否构成「清单连接符」（仅空白不算：`a` `b` 是两个独立提及）。 */
function isListGap(gap, { pipeOnly = false } = {}) {
  const g = gap.trim();
  if (!g) return false;
  if (pipeOnly) return /^\|\s*$/.test(g) || /^\|\s*(?:(?:and|or|与|和)\s*)?$/.test(g);
  return /^(?:[/|,;，、；]\s*)+(?:(?:and|or|与|和|或|以及)\s*)?$/.test(g)
    || /^(?:and|or|与|和|或|以及)$/.test(g);
}

/** 连续的反引号/双引号 token 串（跨行允许，行内缩进算空白）。 */
function listRuns(src, opts = {}) {
  const toks = [...src.matchAll(LIST_TOKEN_RE)]
    .map((m) => ({ v: m[1], start: m.index, end: m.index + m[0].length }));
  const runs = [];
  let cur = null;
  for (const t of toks) {
    if (cur && isListGap(src.slice(cur.end, t.start), opts)) {
      cur.tokens.push(t.v);
      cur.end = t.end;
      continue;
    }
    if (cur) runs.push(cur);
    cur = { tokens: [t.v], start: t.start, end: t.end };
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.tokens.length >= 2);
}

/** 单个反引号里的 `a | b | c` 取值串（`listRuns` 看不见这种形状，不设这条就是静默盲区）。 */
function pipeSpans(src) {
  const out = [];
  for (const m of src.matchAll(/`([^`\n]+)`/g)) {
    if (!m[1].includes("|")) continue;
    const parts = m[1].split("|").map((s) => s.trim().replace(/^"|"$/g, ""));
    if (parts.length >= 2 && parts.every((s) => /^[A-Za-z][A-Za-z0-9_.+-]*$/.test(s))) {
      out.push({ tokens: parts, start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/** 同一段文字被两种抽法同时命中时只留一条（取覆盖更宽的那种）。 */
function dedupeRuns(runs) {
  const kept = [];
  for (const r of [...runs].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))) {
    const hit = kept.find((k) => r.start < k.end && k.start < r.end);
    if (!hit) { kept.push({ ...r }); continue; }
    if (r.end - r.start > hit.end - hit.start) Object.assign(hit, r);
  }
  return kept;
}

const lineOf = (src, i) => src.slice(0, i).split("\n").length;
const snippetOf = (src, i) => src.slice(0, i).split("\n").at(-1).trim().slice(0, 90);

/**
 * 抽出文档里**每一处**声明该清单的位置。
 * 判据：命中真值成员数 ≥ ⌈|真值|×0.75⌉（子集提及不算在声明这份清单）。
 */
function detectListClaims(src, { truth, pipeOnly = false, minShared }) {
  const need = minShared ?? (pipeOnly ? 2 : Math.max(2, Math.ceil(truth.length * 0.75)));
  return dedupeRuns([...listRuns(src, { pipeOnly }), ...pipeSpans(src)])
    .filter((r) => r.tokens.filter((t) => truth.includes(t)).length >= need)
    .map((r) => ({ ...r, line: lineOf(src, r.start), snippet: snippetOf(src, r.start) }));
}

/** `new Set(["a", "b"])` / `{ "a": … }` / `["a", "b"]` 字面量里的字符串成员。 */
function membersOf(src, blockRe, itemRe) {
  const block = src.match(blockRe)?.[1];
  if (!block) return null;
  const items = [...block.matchAll(itemRe)].map((m) => m[1]);
  return items.length ? items : null;
}

const truthVendors = (src) => membersOf(src,
  /const VENDOR_DIRECTORIES = new Set\(\[([^\]]+)\]\)/, /"([^"]+)"/g);
const truthFileTools = (src) => membersOf(src,
  /export const FILE_TOOL_DEFINITIONS = \[([\s\S]*?)\n\];/, /\n\s+name: "([^"]+)"/g);
const truthStrategyNames = (src) => membersOf(src,
  /export const BUILTIN_COMPACTION_STRATEGIES = Object\.freeze\(\{([\s\S]*?)\n\}\)/, /"([^"]+)":/g);

/** 源码里真实注册过的工具名（README 那句 CLI 工具清单的「不许凭空多写成员」白名单）。 */
function knownToolNames() {
  const names = new Set();
  for (const rel of [...walk("src"), ...walk("bin")]) {
    if (!rel.endsWith(".js")) continue;
    for (const m of read(rel).matchAll(/\bname: "([A-Za-z][\w-]*)"/g)) names.add(m[1]);
  }
  return [...names];
}

/**
 * `formatSize` 的真值：档位单位（低→高）、进位基数、每档小数位——全部从源码抽，抽不到就 null
 * （→ error，沿用 #164「抽不到真值就报错」）。
 */
function formatSizeTruth(src) {
  const body = src.match(/export function formatSize\(bytes\) \{([\s\S]*?)\n\}/)?.[1];
  if (!body) return null;
  const base = Number(body.match(/if \(value < (\d+)\) return/)?.[1]);
  if (!base) return null;
  const tiers = [];
  for (const m of body.matchAll(/return `\$\{([^}]*)\}([A-Z]{1,2})`;/g)) {
    const [, expr, unit] = m;
    const toFixed = expr.match(/\.toFixed\((\d+)\)$/);
    if (toFixed) { tiers.push({ unit, decimals: Number(toFixed[1]) }); continue; }
    if (!/^[A-Za-z_$][\w$]*$/.test(expr)) return null;   // 渲染表达式换了形状：显式报错
    const decl = body.match(new RegExp(`(?:const|let) ${expr} = ([^;]+);`));
    if (!decl || !/Math\.round/.test(decl[1])) return null;
    tiers.push({ unit, decimals: 0 });
  }
  return tiers.length >= 2 ? { base, tiers } : null;
}

const roundTo = (v, decimals) => (decimals === 0 ? String(Math.round(v)) : v.toFixed(decimals));

/** 照源码的晋级判据（「渲染后的值」到基数就晋级）复算一遍，用来验文档里每一条示例映射。 */
function renderFormatSize({ base, tiers }, rawBytes) {
  const value = Math.max(0, Math.round(rawBytes));
  let num = value;
  let rendered = `${roundTo(num, tiers[0].decimals)}${tiers[0].unit}`;
  for (let i = 1; i < tiers.length; i++) {
    num = value / base ** i;
    rendered = `${roundTo(num, tiers[i].decimals)}${tiers[i].unit}`;
    if (Number(roundTo(num, tiers[i].decimals)) < base) return rendered;   // 与源码同口径：比的是**渲染后**的数值
  }
  return rendered;
}

/** 文档里的示例映射声明：`` `262144` → `256KB` ``。 */
function arrowByteClaims(src) {
  return [...src.matchAll(/`(\d+)`\s*(?:→|->)\s*`(\d+(?:\.\d+)?)([A-Z]{1,2})`/g)]
    .map((m) => ({ raw: Number(m[1]), claimed: `${m[2]}${m[3]}`, line: lineOf(src, m.index), snippet: snippetOf(src, m.index) }));
}

/**
 * 每条锚点的形状：{ id, src（真值出处）, truth(srcText)→string[], docs（中英成对排列）,
 *   mode/allowExtra/pipeOnly, 可选 run() 覆盖默认跑法 }
 * docs 必须按「EN, CN, EN, CN…」成对排列——处数对账按相邻两项配平。
 */
const ANCHOR_RULES = [
  {
    id: "vendor 跳过目录清单",
    kind: "目录",
    src: "src/tools/file-tools.js",
    truth: truthVendors,
    docs: [README_EN, README_CN, CONTRACT_EN, CONTRACT_CN],
    // 为什么能机械化：真值是源码里那个硬编码 Set，文档四处都是同一份清单的译文。
  },
  {
    id: "文件工具清单（契约的「七个」）",
    kind: "工具名",
    src: "src/tools/file-tools.js",
    truth: truthFileTools,
    docs: [CONTRACT_EN, CONTRACT_CN],
    // 只收契约：README 那句是 CLI 工具清单（多一个 `exec`），另立一条规则，见下一条。
  },
  {
    id: "内置 CLI 工具清单（README）",
    kind: "工具名",
    src: "src/tools/file-tools.js",
    truth: truthFileTools,
    docs: [README_EN, README_CN],
    mode: "contains",
    allowExtra: () => knownToolNames(),
  },
  {
    id: "内置压缩策略名",
    kind: "策略名",
    src: "src/compact/strategy-resolution.js",
    truth: truthStrategyNames,
    docs: [README_EN, README_CN, CONTRACT_EN, CONTRACT_CN],
    pipeOnly: true,   // 只认 `a | b | c` 取值串：这样 3 值枚举删 1 个必红，而「两种折叠策略（A 与 B）」不误判
  },
  {
    id: "单位档位与示例映射（formatSize）",
    kind: "单位",
    src: "src/tools/file-tools.js",
    truth: (src) => formatSizeTruth(src)?.tiers.map((t) => t.unit) ?? null,
    docs: [CONTRACT_EN, CONTRACT_CN],
    minShared: 3,   // 单位词表无歧义（全大写短 token）：命中 3 个就肯定是在列档位，所以判据下探到 3（用默认 0.75 阈值时「删一个档位」会掉到阈值以下、只剩处数对账能接）
    // 单位清单走通用「逐处对称」；示例映射另有一层（见 runFormatSizeRule），两层各管一种破坏。
    run: runFormatSizeRule,
  },
];

/** `formatSize` 那条的两层断言：单位档位清单逐处对称 + 每条 `N` → `Xunit` 示例映射复算。 */
function runFormatSizeRule(rule, out, notesOut) {
  const t = formatSizeTruth(textOf(rule.src));
  if (!t) {
    out.push(`anchors/${rule.id}: 在 ${rule.src} 里抽不到 formatSize 的档位真值（单位字面量、基数或舍入形状变了）`
      + "——源码形状变了，请同步更新本脚本（否则检查面会静默失效）");
    return;
  }
  const units = t.tiers.map((x) => x.unit);
  const listCounts = {};
  const arrowCounts = {};
  for (const rel of rule.docs) {
    const src = textOf(rel);
    const lists = detectListClaims(src, { truth: units, minShared: rule.minShared });
    listCounts[rel] = lists.length;
    if (!lists.length) {
      out.push(`anchors/${rule.id}: ${rel} 找不到单位档位清单声明——检查面在该文件已失效（把档位清单补回来）`);
    }
    for (const c of lists) {
      assertSymmetric(out, {
        rule: `anchors/${rule.id}`, where: `${rel}:${c.line}「${c.snippet}」`,
        truth: units, doc: c.tokens, kind: rule.kind,
      });
    }
    const arrows = arrowByteClaims(src);
    arrowCounts[rel] = arrows.length;
    if (!arrows.length) {
      out.push(`anchors/${rule.id}: ${rel} 找不到「字节数 → 可读值」示例映射声明——检查面在该文件已失效`);
    }
    for (const a of arrows) {
      const want = renderFormatSize(t, a.raw);
      if (a.claimed !== want) {
        out.push(`anchors/${rule.id}: ${rel}:${a.line}「${a.snippet}」把 ${a.raw} 写成 \`${a.claimed}\`，`
          + `按源码档位（${units.join("/")}、${t.base} 基数）复算是 \`${want}\``);
      }
    }
  }
  assertPairCensus(out, { rule: `anchors/${rule.id} 单位清单`, counts: listCounts, docs: rule.docs });
  assertPairCensus(out, { rule: `anchors/${rule.id} 示例映射`, counts: arrowCounts, docs: rule.docs });
  notesOut.push(`anchors: 「${rule.id}」真值 = 档位 ${units.join("/")}（${t.base} 基数，逐档小数位 `
    + `${t.tiers.map((x) => x.decimals).join(",")}），单位清单 ${JSON.stringify(listCounts)}、示例映射 ${JSON.stringify(arrowCounts)}`);
}

/** 默认跑法：清单类锚点的「逐处对称 + 中英处数对账」。 */
function runListRule(rule, out, notesOut) {
  const truth = rule.truth(textOf(rule.src));
  if (!truth || truth.length < 2) {
    out.push(`anchors/${rule.id}: 在 ${rule.src} 里抽不到清单真值——源码形状变了，请同步更新本脚本（否则检查面会静默失效）`);
    return;
  }
  const allowExtra = rule.allowExtra ? rule.allowExtra() : [];
  const counts = {};
  for (const rel of rule.docs) {
    const src = textOf(rel);
    const claims = detectListClaims(src, { truth, pipeOnly: rule.pipeOnly });
    counts[rel] = claims.length;
    if (!claims.length) {
      out.push(`anchors/${rule.id}: ${rel} 找不到任何清单声明——检查面在该文件已失效（要么把声明补回来，要么把它移出本规则的 docs）`);
      continue;
    }
    for (const c of claims) {
      assertSymmetric(out, {
        rule: `anchors/${rule.id}`, where: `${rel}:${c.line}「${c.snippet}」`,
        truth, doc: c.tokens, mode: rule.mode ?? "exact", allowExtra, kind: rule.kind ?? "成员",
      });
    }
  }
  assertPairCensus(out, { rule: `anchors/${rule.id}`, counts, docs: rule.docs });
  notesOut.push(`anchors: 「${rule.id}」真值 ${truth.length} 项（${rule.src}），逐处核对 ${JSON.stringify(counts)}（${rule.docs.join(" / ")}）`);
}

/** 跑一遍所有清单/单位锚点，返回错误文本（不直接写全局，好让 `--self-test` 复用同一份实现）。 */
function collectAnchorErrors() {
  const out = [];
  const notesOut = [];
  for (const rule of ANCHOR_RULES) (rule.run ?? runListRule)(rule, out, notesOut);
  collectAnchorErrors.notes = notesOut;
  return out;
}

// ── 2.6 marker **字面量**同源（issue #272）───────────────────────────────────
// #267 只修了「源码模板 + NEXT_STEP_CLAUSE 不许被改形」（test/tools/file-tools.test.js），
// 没修「**文档引用的字面必须等于那份模板**」。后果：把 EN 契约里的 `（文件 <size>）` 段删掉，
// check:docs 与 check:docs:strict 都还是 exit 0。本规则把那一层接上：
//   真值侧 = toolMarker() 里 `case "readMoreLines"` 的 template literal + `NEXT_STEP_CLAUSE` 常量；
//   文档侧 = 形如 `[共 …]` 的那一处引用。两侧都是定长字符串，逐字比。
// 文档写的是模板的**占位符实例化**（它不能替模型填数），所以两边不会全等；对应关系就是下面
// 那张 `placeholders` 表。**模板里出现未登记的插值 → 直接红**（源码给 marker 加了新值，而文档
// 与本脚本都还不知道），而不是默默用旧字面去比。
const MARKER_LITERAL_RULES = [
  {
    id: "readMoreLines marker 字面（契约中英引用）",
    src: "src/tools/file-tools.js",
    kind: "readMoreLines",
    docs: [CONTRACT_EN, CONTRACT_CN],
    placeholders: [
      ["values.total - values.offset", "M"],
      ["formatSize(Number(values.size))", "<size>"],
      ["values.total", "N"],
      ["values.offset", "K"],
    ],
  },
];

/** 把源码模板渲染成「文档应该写的那份字面」。 */
function renderMarkerDocLiteral(srcText, rule) {
  const clause = srcText.match(/const NEXT_STEP_CLAUSE = "([^"]+)";/)?.[1];
  if (!clause) return { error: `在 ${rule.src} 里抽不到 NEXT_STEP_CLAUSE——#267 钉下的字面已不存在` };
  const tplSrc = `case "${rule.kind}":(?:(?!\\bcase\\b)[\\s\\S])*?return\\s*` + "`([^`]*)`" + `;`;
  const tpl = srcText.match(new RegExp(tplSrc))?.[1];
  if (!tpl) return { error: `在 ${rule.src} 里抽不到 toolMarker("${rule.kind}") 的模板（case 分支或 return 写法变了）——本规则检查面失效` };
  let out = "";
  let rest = tpl;
  const unmapped = [];
  while (rest.length) {
    const m = rest.match(/\$\{([^}]*)\}/);
    if (!m) { out += rest; break; }
    out += rest.slice(0, m.index);
    const expr = m[1].trim();
    if (expr === "NEXT_STEP_CLAUSE") {
      out += clause;
    } else {
      const hit = rule.placeholders.find(([e]) => e.replace(/\s+/g, " ") === expr.replace(/\s+/g, " "));
      if (!hit) { unmapped.push(expr); out += `⟨${expr}⟩`; }
      else out += hit[1];
    }
    rest = rest.slice(m.index + m[0].length);
  }
  if (unmapped.length) {
    return { error: `模板里有未登记的插值 \${${unmapped.join("} 与 \${")}}：源码给 marker 加了新值，`
      + `请把文档占位符与本脚本 placeholders 表一起补上（否则检查面会拿旧字面去比新真值）` };
  }
  return { literal: out, lead: tpl.slice(0, tpl.indexOf("${")) };
}

function collectMarkerLiteralErrors() {
  const out = [];
  const notes = [];
  for (const rule of MARKER_LITERAL_RULES) {
    const truth = renderMarkerDocLiteral(textOf(rule.src), rule);
    if (truth.error) {
      out.push(`markers/${rule.id}: ${truth.error}`);
      continue;
    }
    // 「一处文档引用」的判据：模板首个静态段开头（这里是 `[共 `）、到下一个 `]` 为止的串。
    // 不拿整份字面去找（文档写错就找不到了，那恰好是要报的情形），拿**开头**找。
    const claimRe = new RegExp(`${esc(truth.lead)}[^\\]\\n]*\\]`, "gu");
    const counts = {};
    for (const rel of rule.docs) {
      const src = textOf(rel);
      const claims = [...src.matchAll(new RegExp(claimRe.source, claimRe.flags))];
      counts[rel] = claims.length;
      if (!claims.length) {
        out.push(`markers/${rule.id}: ${rel} 找不到以 \`${truth.lead}\` 开头的 marker 字面引用——检查面在该文件已失效`
          + `（真值：${JSON.stringify(truth.literal)}）`);
        continue;
      }
      for (const c of claims) {
        if (c[0] === truth.literal) continue;
        out.push(`markers/${rule.id}: ${rel}:${lineOf(src, c.index)} 引用的是 ${JSON.stringify(c[0])}，`
          + `但按 ${rule.src} 的 toolMarker("${rule.kind}") 模板 + NEXT_STEP_CLAUSE 渲染出来是 ${JSON.stringify(truth.literal)}`
          + `（「${snippetOf(src, c.index)}」）；\n      占位符对应：${rule.placeholders.map(([e, p]) => `${p} = \${${e}}`).join("、")}、`
          + `；「下一步：」= \${NEXT_STEP_CLAUSE}`);
      }
    }
    assertPairCensus(out, { rule: `markers/${rule.id}`, counts, docs: rule.docs });
    notes.push(`markers/${rule.id}: 中英共 ${Object.values(counts).reduce((a, b) => a + b, 0)} 处引用，逐字等于 ${rule.src} 渲染出的那份字面`
      + `（${JSON.stringify(truth.literal)}）`);
  }
  collectMarkerLiteralErrors.notes = notes;
  return out;
}

// ── 2.7 `--checkJs` 棘轮**当前值** ↔ 棘轮常量（issue #274，只做最省的那一档）──────
// 真值 = scripts/type-check-ratchet.mjs 里的两个常量；文档侧 = AGENTS 中英里**复述这两个数**的句式。
// 本单**没做**的那两档（代价不对等，写在这里不为完成率造活）：
//   · 真跑 tsc 核 `--listFiles` 的文件数（31 files 那一句）：要 spawn tsc，而 check:docs 是文档门禁里
//     跑得最勤的一条（每次文档改动），为此把 check:docs 变成十秒级不值得；棘轮自己会校文件数。
//   · 生成声明文件数（63）：那要跑 types:build，同样的理由。
// 「历史值不误伤」是这规则的命门：AGENTS 里同时存在 142/185/218/226/261 这些**已退役的**基线值
// （#251/#255/#265 那几段在讲棘轮降下来的过程），所以句式必须钉到「常量名 / 基线词」上，
// 而不是「抽一个四位数」；#265 那条就把棘轮写成开发中途的 142→138 / 185→181。
const BASELINE_CLAIM_RULES = [
  {
    id: "常量写法 `BASELINE_ROOT = N`",
    tier: "root",
    required: true,
    claims: [
      { rel: AGENTS_EN, re: /BASELINE_ROOT\s*=\s*(\d+)/g },
      { rel: AGENTS_CN, re: /BASELINE_ROOT\s*=\s*(\d+)/g },
    ],
  },
  {
    id: "「基线常量 / baseline constant」声明",
    tier: "root",
    required: true,
    claims: [
      { rel: AGENTS_EN, re: /baseline constant\s*\*\*(\d+)\*\*/g },
      { rel: AGENTS_CN, re: /基线常量\s*\*\*(\d+)\*\*/g },
    ],
  },
  {
    id: "「已接受的债 N 个错」声明",
    tier: "root",
    required: true,
    claims: [
      { rel: AGENTS_EN, re: /errors — (\d+) of them/g },
      { rel: AGENTS_CN, re: /——(\d+) 个错/g },
    ],
  },
  {
    id: "「公共面 93 里的总数」声明",
    tier: "root",
    required: true,
    claims: [
      { rel: AGENTS_EN, re: /\d+ of the (\d+)/g },
      { rel: AGENTS_CN, re: /(\d+) 个里有/g },
    ],
  },
  {
    id: "「无 `.d.ts` 时的错误数」声明",
    tier: "root",
    required: true,
    claims: [
      { rel: AGENTS_EN, re: /\*\*(\d+) errors?\*\*\s+with\s+none\s+present/g },
      { rel: AGENTS_CN, re: /无\s*`\.d\.ts`\s*=\s*(\d+)\s*个错/g },
    ],
  },
  {
    id: "并集基线的分解式 `= A + B + C`",
    tier: "sum",
    required: true,
    claims: [
      { rel: AGENTS_EN, re: /= (\d+) \+ (\d+) \+ (\d+)/g },
      { rel: AGENTS_CN, re: /= (\d+) \+ (\d+) \+ (\d+)/g },
    ],
  },
  {
    id: "「基线 **N** / 31 个文件」声明",
    tier: "withTools",
    required: true,
    claims: [
      { rel: AGENTS_EN, re: /baseline\s+\*\*(\d+)\*\*\s*\/\s*31\s*files/g },
      { rel: AGENTS_CN, re: /基线\s*\*\*(\d+)\*\*\s*\/\s*31\s*个文件/g },
    ],
  },
  {
    // 当前文档里没这种写法（两侧都是 0 处）；出现了就必须对，但不因为「没写」而红。
    id: "常量写法 `BASELINE_WITH_TOOLS = N`",
    tier: "withTools",
    required: false,
    claims: [
      { rel: AGENTS_EN, re: /BASELINE_WITH_TOOLS\s*=\s*(\d+)/g },
      { rel: AGENTS_CN, re: /BASELINE_WITH_TOOLS\s*=\s*(\d+)/g },
    ],
  },
];

/** 从棘轮脚本里抽两个基线常量（抽不到就是检查面失效，#164 口径）。 */
function ratchetBaselines(srcText) {
  const root = srcText.match(/^\s*const BASELINE_ROOT = (\d+);/m)?.[1];
  const withTools = srcText.match(/^\s*const BASELINE_WITH_TOOLS = (\d+);/m)?.[1];
  return { root, withTools };
}

function collectBaselineClaimErrors() {
  const out = [];
  const notes = [];
  const truth = ratchetBaselines(textOf(RATCHET_SRC));
  if (!truth.root || !truth.withTools) {
    return [`baseline: 在 ${RATCHET_SRC} 里抽不到 BASELINE_ROOT / BASELINE_WITH_TOOLS 常量——`
      + `棘轮改名或改写法了，本规则会静默失效，请同步这里（#164：抽不到真值就报错）`];
  }
  if (Number(truth.root) > Number(truth.withTools)) {
    out.push(`baseline: ${RATCHET_SRC} 自己的两个常量就不自洽：BASELINE_ROOT ${truth.root} > BASELINE_WITH_TOOLS ${truth.withTools}`);
  }
  const wantOf = (tier) => (tier === "root" ? truth.root : tier === "withTools" ? truth.withTools : null);
  const nameOf = (tier) => (tier === "sum" ? null : tier === "root" ? "BASELINE_ROOT" : "BASELINE_WITH_TOOLS");
  let total = 0;
  for (const rule of BASELINE_CLAIM_RULES) {
    const counts = {};
    for (const { rel, re } of rule.claims) {
      const src = textOf(rel);
      const m = [...src.matchAll(new RegExp(re.source, re.flags))];
      counts[rel] = m.length;
      if (!m.length && rule.required) {
        out.push(`baseline/${rule.id}: ${rel} 里一处都抽不到——该声明被整句删了或改了形，检查面在这份文档已失效`
          + `（真值：${nameOf(rule.tier) ?? "分解式"} = ${wantOf(rule.tier) ?? `${truth.root} + … = ${truth.withTools}`}）`);
        continue;
      }
      for (const c of m) {
        total += 1;
        const at = `${rel}:${lineOf(src, c.index)}`;
        const why = rule.tier === "sum"
          ? (() => {
            const [a, b, cc] = c.slice(1).map(Number);
            if (a !== Number(truth.root)) return `首项 \`${a}\` 应等于 ${RATCHET_SRC} 的 BASELINE_ROOT（${truth.root}）`;
            if (a + b + cc !== Number(truth.withTools)) return `分解式 ${a} + ${b} + ${cc} = ${a + b + cc}，不等于 BASELINE_WITH_TOOLS（${truth.withTools}）`;
            return null;
          })()
          : (c[1] === wantOf(rule.tier) ? null : `声称 ${c[1]}，但 ${RATCHET_SRC} 的 ${nameOf(rule.tier)} 是 ${wantOf(rule.tier)}`);
        if (why) {
          out.push(`baseline/${rule.id}: ${at} ${why}。\n      棘轮基线的唯一真值在 ${RATCHET_SRC}：改常量就要同时改文档，`
            + `改文档就只能改成常量那个值（历史值 142/185/218/226/261 属于「已降下来」的叙述，不该出现在这些当前值句式里）；`
            + `\n      「${snippetOf(src, c.index)}」`);
        }
      }
    }
    assertPairCensus(out, { rule: `baseline/${rule.id}`, counts, docs: rule.claims.map((c) => c.rel) });
  }
  notes.push(`baseline: AGENTS 中英共 ${total} 处当前值声明（含分解式算术闭合）全部等于 ${RATCHET_SRC} 的 `
    + `BASELINE_ROOT=${truth.root} / BASELINE_WITH_TOOLS=${truth.withTools}`);
  collectBaselineClaimErrors.notes = notes;
  return out;
}

// ── 3. README 引用的 package.json 清单（files / exports）────────────────────────
// issue #210 的**主修项**：这块原先是 fail-open 的——围栏定位靠真值键（`b["./tools"]`、
// `b.includes("src")`），文档把 `"./tools"` 改名或整个删掉时块就找不到了，于是退化成一条 warn
// （默认 exit 0，实测复现见 CHANGELOG #210 条目）。现在：
//   ① 块按**结构**定位（≥3 项字符串数组 = `files` 候选；键全为子路径 = `exports` 候选）；
//   ② 候选数 ≠ 1 直接 error（不再 warn：清单围栏找不到或找不准就是检查面失效，#164 口径）；
//   ③ 比对走 `assertSymmetric` 的双向对称——缺键/多键/改名/写重都红，并点名具体键；
//   ④ `JSON.parse` 会静默丢掉重复键（保留最后一个），所以再按围栏原文数一遍顶层键名。
function fencedJsonBlocks(rel) {
  const blocks = [];
  let current = null;
  for (const line of textOf(rel).split("\n")) {
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

/** 围栏原文里的顶层键名（`JSON.parse` 吞掉的重复键在这里现形）。 */
function topLevelKeys(raw) {
  return [...raw.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);
}

function checkPkgBlocks() {
  const out = [];
  const outWarn = [];
  // issue #213：`exports` 的每个子路径是条件对象（`{types, default}`），所以按**结构化**比较
  const canonical = (v) => JSON.stringify(v, (_k, val) =>
    (val && typeof val === "object" && !Array.isArray(val))
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val);
  for (const rel of [README_EN, README_CN]) {
    const pkg = pkgNow();
    const raws = fencedJsonBlocks(rel);
    const parsed = raws.map((b) => { try { return JSON.parse(b); } catch { return undefined; } });
    const cands = raws.map((raw, i) => ({ raw, value: parsed[i] }));

    const filesCands = cands.filter(({ value }) => Array.isArray(value)
      && value.length >= 3 && value.every((x) => typeof x === "string"));
    if (filesCands.length !== 1) {
      out.push(filesCands.length === 0
        ? `pkg-block: ${rel} 找不到 \`files\` 清单围栏（≥3 项字符串数组），无法与 package.json 比对——检查面失效就是漂移`
        : `pkg-block: ${rel} 有 ${filesCands.length} 个 \`files\` 候选围栏，无法唯一定位（把多余的 JSON 围栏改掉或删掉）`);
    } else if (!assertSymmetric(out, {
      rule: "pkg-block", where: `${rel} 的 \`files\` 围栏`, truth: pkg.files, doc: filesCands[0].value,
      kind: "条目",
    })) {
      // 报错已由 assertSymmetric 落（缺/多/写重都点名到具体条目），这里不重复
    } else {
      note(`pkg-block: ${rel} files 清单与 package.json 双向对称（${pkg.files.length} 项）`);
    }

    const exportsCands = cands.filter(({ value }) => value && !Array.isArray(value)
      && Object.keys(value).length > 0 && Object.keys(value).every((k) => k === "." || k.startsWith("./")));
    if (exportsCands.length !== 1) {
      out.push(exportsCands.length === 0
        ? `pkg-block: ${rel} 找不到 \`exports\` 清单围栏（键全为子路径的 JSON 对象），无法与 package.json 比对——检查面失效就是漂移`
        : `pkg-block: ${rel} 有 ${exportsCands.length} 个 \`exports\` 候选围栏，无法唯一定位`);
      continue;
    }
    const block = exportsCands[0];
    // ① 键集合双向对称：缺键 / 多键 / 改名都红，点名到具体键（#210 追加评论要的正是这条）
    const keysOk = assertSymmetric(out, {
      rule: "pkg-block", where: `${rel} 的 \`exports\` 围栏键集合`,
      truth: Object.keys(pkg.exports), doc: Object.keys(block.value), kind: "子路径键",
    });
    // ② 重复键：JSON.parse 只保留最后一个，所以从原文数
    const rawKeys = topLevelKeys(block.raw);
    const dupKeys = rawKeys.filter((k, i) => rawKeys.indexOf(k) !== i);
    if (dupKeys.length) {
      out.push(`pkg-block: ${rel} 的 \`exports\` 围栏里子路径键 ${[...new Set(dupKeys)].map((k) => JSON.stringify(k)).join("、")} 写了不止一次（JSON.parse 会静默保留最后一个，文档读者看到的却是第一个）`);
    }
    // ③ 共有键的**值**也要逐键一致；点名是哪一个键、错在哪一侧
    for (const k of Object.keys(pkg.exports)) {
      if (!Object.hasOwn(block.value, k)) continue;
      if (canonical(block.value[k]) === canonical(pkg.exports[k])) continue;
      out.push(`pkg-block: ${rel} 的 \`exports\` 里键 ${JSON.stringify(k)} 的值与 package.json 不一致：`
        + `文档 ${JSON.stringify(block.value[k])} vs package.json ${JSON.stringify(pkg.exports[k])}`);
    }
    if (keysOk) note(`pkg-block: ${rel} exports 清单与 package.json 双向对称（${Object.keys(pkg.exports).length} 个子路径键 + 逐键值）`);
  }

  // 随包发布的契约套件必须真的在 files 白名单里（否则宿主 import 'erix-agent/contract-tests' 会炸）。
  const contractIndex = read("test/contract/index.js");
  for (const m of contractIndex.matchAll(/from "\.\/([\w.-]+\.js)"/g)) {
    const rel = `test/contract/${m[1]}`;
    if (!pkgNow().files.includes(rel)) {
      outWarn.push(`pkg-block: ${rel} 被 test/contract/index.js（npm 入口 ./contract-tests）再导出，但不在 package.json 的 files 白名单里 → 发布包内该套件会缺失`);
    }
  }
  return { errors: out, warnings: outWarn };
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

// ── 5. 文档引用的路径与命令（覆盖面 + 三级解析 + 四类裁决，issue #273）──────────
// 修前两处都窄：
//   · 覆盖面：同一条不存在的仓内路径写进 README.md 会 exit 1，写进 examples/pi-extension/README.md
//     却 exit 0。
//   · 判据：只有「仓库根下存在吗」一级。examples 版 README 里 `erix-run.ts`（同目录文件）、
//     `../../test/examples/plain-data.js`（相对路径）、`erix-run-core.test.js`（裸文件名）这类
//     **真引用**一律解析不到，于是真引用与死引用在它眼里没区别。
/** paths 的覆盖面（#273）：使用者与宿主会照着找文件的那批入口文档。 */
const PATH_DOCS = [README_EN, README_CN, PI_EXT_README, CONTRACT_EN, CONTRACT_CN, AGENTS_EN, AGENTS_CN];

// 引用裁决分类（四类，**没一类能整目录/整前缀豁免**；每条白名单必须写理由）。
// 白名单条目还会被反向校：没人引用、或分类与 .gitignore 不再自洽 → 红，所以条目不会烂在那里。
/** ① 本仓曾有这个路径（或只是运行期产物名），文档在讲「已退役/迁移/宿主侧证据」。 */
const EXPECTED_ABSENT_PATHS = new Map([
  ["skills/notes/skill.mjs", "v0.11.0 已退役的兼容 shim，README 在讲「已删除」"],
  ["src/loop.js", "v0.14.0 已删除的转发 shim，README 在讲迁移"],
  ["judge.log", "引擎写入 transcripts/outputs/<runId>/ 的运行产物名，不是仓库文件"],
  ["erix-state/judge.log", "2026-09 基准证据里的宿主侧路径，不在本仓库"],
  ["status.json", "erix_run 在宿主 sessionDir 下写的 job 状态文件名，不是仓库文件"],
]);
/** ② 引用的是**另一个仓库/宿主安装物/文档里举的示意名**（写清归属或凭什么不是路径）。 */
const EXTERNAL_REPO_PATHS = new Map([
  ["src/shared/parent-wake.js", "上游 pi-subagents 仓内的路径（#269 逐分支对照的证据行号就在那个子模块里），本仓没有同名文件"],
  ["src/runs/background/async-execution.js", "上游 pi-subagents 仓内的路径（#269 对照的等待循环本体）"],
  ["dist/core/extensions/virtual-modules.js", "上游 pi 发行包的编译产物（#246 写 host-consumer-contract 时读的就是它）"],
  ["dist/core/extensions/loader.js", "上游 pi 发行包的编译产物（同上）"],
  ["docs/extensions.md", "pi 自己的官方文档（本仓不镜像）"],
  ["examples/extensions/shutdown-command.ts", "pi 仓的扩展示例（本仓不镜像）"],
  ["herdr-pi-bridge.js", "宿主侧桥接脚本（#247 写对照时引用的宿主文件）"],
  ["sync-erix-mirror.sh", "宿主侧 cron 脚本（AGENTS 「上游同步」一节讲的是宿主仓库，不在本仓）"],
  ["./x.js", "AGENTS 讲 `// @ts-check` 与 `.d.ts` 解析规则时举的**示意文件名**（中英同一处），不是仓库路径"],
  ["x.d.ts", "AGENTS 讲 `.d.ts` 伴生声明时举的**示意文件名**（与 `./x.js` 同处），不是仓库路径"],
]);
/** ③ 生成物：由命令产出、被 .gitignore 忽略，仓库里没有是预期的。**模式**级条目（一文件一条会造出
 *  63 条同义自述），但每条都带 why 并与 .gitignore 互校：匹配了模式却不被忽略 → 红。 */
const GENERATED_ARTIFACT_REFS = [
  { re: /^(?:\.\.?\/)?src\/[\w./-]*\.d\.ts$/, why: "`npm run types:build` / `prepack` 生成的公共面声明产物（.gitignore 的 `src/**/*.d.ts`）；仓库不提交是 #213 的既定选择" },
  { re: /^(?:\.\.?\/)?package-lock\.json$/, why: "本仓历史上没有 lockfile，加它属于另一个决定（.gitignore 里写了 issue #213）" },
];
/** 被忽略的**目录规则**必须逐条分类（#273：不许默认当没事）。两类语义不同：
 *   · install-tree / build-output / runtime / worktree：目录内容根本不是仓库内容（安装位置、构建产物、
 *     运行日志、本机工作副本），引用它们不构成「克隆后死链」；
 *   · task-archive：`docs/tasks/` 存的是主 agent 的写作现场，**看起来像**仓内文档却整目录不入库，
 *     克隆后就是死引用——所以只有这一类要求**逐条**证据（就地声明或 LOCAL_ARCHIVE_REFS 逐条理由），
 *     其余三类按目录规则整体放行，但都必须在表里写明为什么。
 * .gitignore 里出现新的目录型规则而未登记 → 直接红（而不是默默放行）。 */
const IGNORED_DIR_CLASSES = new Map([
  ["node_modules/", { kind: "install-tree", why: "宿主侧安装位置，不是仓库内容" }],
  ["dist/", { kind: "build-output", why: "examples 的构建产物目录" }],
  ["logs/", { kind: "runtime", why: "运行日志目录" }],
  [".worktrees/", { kind: "worktree", why: "并行任务的本机工作副本（#184 引入）" }],
  ["docs/tasks/", { kind: "task-archive", why: "主 agent 的任务工作目录：整目录不入库，#162 定了口径，#273 把它纳进检查面" }],
]);

/** ④ 本机档案：指向被 .gitignore 忽略的**目录**（本仓只有 `docs/tasks/`：主 agent 的任务工作目录）。
 *  首选判据是「就地声明」：引用所在行或紧邻上一行写了「本机/本地/不入库/未入库/未跟踪/gitignore/忽略/归档」
 *  之类的话 → 算已声明（docs/research/2026-09-26-* 的「任务文档（本地，不入库）」就是这种写法，
 *  #162 那轮已经定了这个口径）。声明不了的（禁改面与 CHANGELOG 历史条目）逐条登记 + 理由。 */
const LOCAL_ARCHIVE_REFS = new Map([
  ["e2e-wake.mjs", "examples/pi-extension/README.md 写「归档在 docs/tasks/active/261010-13-erix-run-async/」时同句举的本机脚本名（禁改面，且同句只说了「归档」）"],
  ["docs/tasks/active/261010-13-erix-run-async/repro-circular-details.mjs", "CHANGELOG:169（#234 条目）把复现脚本指向任务档案；历史条目不改写，逐条登记"],
  ["repro-circular-details.mjs", "CHANGELOG:89 与 docs/research/2026-10-13-pi-subagents-async-attribution.md:25 同句举的**裸名**复现脚本，实物在 docs/tasks/active/261010-13-erix-run-async/（#273 把 archive 类的三级解析接上后新暴露的两处引用；本轮禁改 docs/** 也不改 CHANGELOG 历史条目，故逐条登记）"],
  ["docs/tasks/active/task-20260830-touwaka-full-integration/BRANCH.md", "docs/harness-comparison/05:62 的 git 注入对照引用的是本机档案行号（#273 点名的两条历史样本之一；另一条 docs/research/2026-09-26 的 REPORT.md 已就地写「本地，不入库」而直接放行）。本轮禁改 docs/**，下轮在那行补上「本机档案、不入库」后请删本条"],
]);
const LOCAL_ARCHIVE_DECLARATION = /本机|本地|不入库|未入库|不提交|未提交|未跟踪|never committed|not committed|untracked|gitignore|忽略|归档/i;

/** 极简 .gitignore 匹配（零依赖，只支持注释、`目录/`、`*.ext`、`**`、裸名——本仓那 9 条全在这个子集里）。
 *  取反 `!` 不在子集里：碰到就报错，而不是默默当没忽略（宁可假红，不要假绿）。 */
function compileIgnoreRule(pattern) {
  const dirOnly = pattern.endsWith("/");
  const p = pattern.replace(/\/+$/, "");
  const anchored = p.includes("/");
  const body = p
    .split("/")
    .map((seg) => (seg === "**" ? ".*" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
    .join("/")
    .replace(/\/\.\*\//g, "/(?:.*/)?"); // `a/**/b` 允许 `**` 匹配零段（git 语义）
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}${dirOnly ? "/.*$" : "(?:/.*)?$"}`);
}

function gitignoreMatcher(text) {
  const rules = [];
  const unsupported = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) return;
    if (raw.startsWith("!")) { unsupported.push({ pattern: raw, line: i + 1 }); return; }
    rules.push({ pattern: raw, line: i + 1, re: compileIgnoreRule(raw) });
  });
  // 后写的规则覆盖先写的（与 git 同口径）
  const ruleFor = (rel) => rules.filter((r) => r.re.test(rel)).at(-1) ?? null;
  return { ruleFor, unsupported, rules };
}

/** 未被忽略的仓库文件清单（惰性建一次；`walk()` 从根递归会钻到 node_modules，所以自带剪枝）。 */
/** 全仓文件清单（惰性建一次，键是 .gitignore 的规则集合）。分两份：未忽略的（= 克隆后仍在的）
 *  与被忽略的（= 只有本机有的）。被忽略目录照常下钻（要认得 e2e-wake.mjs 这种「裸名指向档案」），
 *  但安装位置与工作副本剪掉（node_modules/ 与 .worktrees/ 里是一整份别的仓库，钻进去又慢又脏）。 */
let repoFilesCache = null;
function repoFiles(ign) {
  const key = ign.rules.map((r) => r.pattern).join("\n");
  if (repoFilesCache && repoFilesCache.key === key) return repoFilesCache;
  const tracked = [];
  const ignored = [];
  const skipDir = (rel) => {
    const rule = ign.ruleFor(`${rel}/`);
    if (!rule) return false;
    const cls = IGNORED_DIR_CLASSES.get(rule.pattern);
    return !cls || cls.kind === "install-tree" || cls.kind === "worktree";
  };
  (function down(dir, underIgnored) {
    for (const name of readdirSync(path.join(ROOT, dir || "."))) {
      if (name === ".git" || name === "node_modules") continue;
      const rel = dir ? `${dir}/${name}` : name;
      if (skipDir(rel)) continue;
      if (statSync(path.join(ROOT, rel)).isDirectory()) down(rel, underIgnored || !!ign.ruleFor(`${rel}/`));
      else (underIgnored || ign.ruleFor(rel) ? ignored : tracked).push(rel);
    }
  })("", false);
  repoFilesCache = { key, tracked, ignored };
  return repoFilesCache;
}

/** 三级解析：仓库根 → 文档同目录 → 全仓唯一同名。同名只认**唯一**命中（歧义不算解析成功，
 *  要写清路径）；先查未忽略文件（克隆后仍在的那批），再查被忽略的（解到就走「忽略类」裁决）。
 *  解不到时把命中的 .gitignore 规则一并带出，供分类使用。 */
function resolveRef(p, docRel, ign) {
  const fromDoc = p.startsWith("./") || p.startsWith("../");
  const clean = p.replace(/^\.\//, "");
  const docDir = path.posix.dirname(docRel);
  const cands = fromDoc
    ? [path.posix.normalize(path.posix.join(docDir, p))]
    : [clean, path.posix.normalize(path.posix.join(docDir, clean))];
  for (const c of cands) {
    const rule = ign.ruleFor(c);
    if (rule) return { ignoredPath: c, rule };
    if (existsSync(path.join(ROOT, c))) return { resolved: c, via: c === clean ? "仓库根" : "文档同目录" };
  }
  if (!clean.includes("/")) {
    const idx = repoFiles(ign);
    const hits = idx.tracked.filter((f) => path.posix.basename(f) === clean);
    if (hits.length === 1) return { resolved: hits[0], via: "全仓唯一同名" };
    if (hits.length > 1) return { ambiguous: hits };
    const local = idx.ignored.filter((f) => path.posix.basename(f) === clean);
    if (local.length === 1) return { ignoredPath: local[0], rule: ign.ruleFor(local[0]) };
    if (local.length > 1) return { ambiguous: local };
  }
  return { tried: clean, rule: ign.ruleFor(clean) };
}

function candidatePaths(rel) {
  const out = new Map(); // 去重保留首次出现位置，报错要能点名行
  const commands = [];
  const text = textOf(rel);
  const push = (raw, line) => {
    let p = raw;
    const url = p.match(/^https?:\/\/[^/]+\/(?:ErixWong\/erix-agent)?\/?(?:blob|tree)\/main\/(.+)$/);
    if (url) p = url[1];
    else if (/^https?:/.test(p)) return;
    if (/^[~$]/.test(p)) return; // 用户目录（~/.erix）与环境变量形式（$XDG_CONFIG_HOME）不属于本仓库
    if (p.includes("\\") || (p.startsWith("/") && p.endsWith("/"))) return; // 正则字面量（`/valid NoteRecord/`）不是路径
    if (p.includes("://")) return; // 自定义 URL scheme（`app://skills/skill.mjs`）
    p = p.replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, "").replace(/[).,;:;,]+$/, "");
    if (!p || p.startsWith("#")) return;
    if (!p.startsWith("./") && !p.startsWith("../")) {
      if (p.startsWith(".")) return; // .mcp.json / .erix/skills/ 这类宿主侧配置目录
    }
    if (/[*<>|"'{}\[\]()=]/.test(p)) return; // glob 与占位符
    if (!/\.(?:js|mjs|json|md|ts|sh|log)$|\/$/.test(p)) return; // 只核对像路径的东西
    if (!out.has(p)) out.set(p, line);
  };
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) push(m[1], i + 1);
    for (const m of line.matchAll(/`([^`\s]+)`/g)) push(m[1], i + 1);
    for (const m of line.matchAll(/(?:^|\s)(?:LLM_KIT_E2E=1\s+)?node\s+([\w./-]+\.(?:mjs|js))/g)) {
      commands.push({ kind: "file", value: m[1], line: i + 1 });
    }
    for (const m of line.matchAll(/(?:^|[\s(（:：、，|《])((?:\.\.\/)*docs\/tasks\/[\w.\-\/]+)/g)) push(m[1], i + 1); // #273：纯文本里写的任务档案路径也是引用
    for (const m of line.matchAll(/npm run ([\w:.-]+)/g)) {
      commands.push({ kind: "script", value: m[1], line: i + 1 });
    }
  });
  return { refs: [...out.entries()].map(([p, line]) => ({ p, line })), commands };
}

/** 把一处解不到的引用归到四类里；解得出结论就返回 null。 */
/** 分类台账：每条白名单被哪一处引用用到过，都在这里留痕；收尾时反查「登记了却没一处用上」的条目。 */
const REF_CLASS_HITS = new Set();
const passAs = (key) => { REF_CLASS_HITS.add(key); return null; };

/** 把一处解不到的引用归到四类里；能放行就返回 null，否则返回「为什么不放行」。 */
function classifyAbsent(p, docRel, line, ign, res = {}) {
  if (EXPECTED_ABSENT_PATHS.has(p)) return passAs(`absent:${p}`);
  if (EXTERNAL_REPO_PATHS.has(p)) return passAs(`external:${p}`);
  const probe = res.ignoredPath ?? p.replace(/^\.\.?\//, "");
  const gen = GENERATED_ARTIFACT_REFS.find((g) => g.re.test(p));
  if (gen) {
    return ign.ruleFor(probe)
      ? passAs(`generated:${gen.re.source}`)
      : `白名单把它归为生成物（${gen.why}），但 .gitignore 并不忽略 ${probe}——生成物的定义已失效`;
  }
  if (LOCAL_ARCHIVE_REFS.has(p)) {
    return ign.ruleFor(probe)
      ? passAs(`archive:${p}`)
      : `登记为本机档案（${LOCAL_ARCHIVE_REFS.get(p)}），但 .gitignore 并不忽略 ${probe}——`
        + `它已入库或分类变了，请删掉这条登记（本机档案的定义已失效）`;
  }
  const rule = res.rule ?? ign.ruleFor(probe);
  if (rule) {
    if (!rule.pattern.endsWith("/")) {
      return `指向被 .gitignore 忽略的路径（.gitignore:${rule.line} \`${rule.pattern}\`），但这条规则没被分类——`
        + `去 IGNORED_DIR_CLASSES（目录型）或 GENERATED_ARTIFACT_REFS（生成物）里给它一个名字与理由，别默默放行`;
    }
    const dirCls = IGNORED_DIR_CLASSES.get(rule.pattern);
    if (!dirCls) {
      return `指向被 .gitignore 忽略的目录（.gitignore:${rule.line} \`${rule.pattern}\`），但这条目录规则没在 IGNORED_DIR_CLASSES 里分类`;
    }
    if (dirCls.kind !== "task-archive") {
      // 安装位置 / 构建产物 / 日志 / 工作副本：目录内容本身就不是仓库内容
      REF_CLASS_HITS.add(`dircls:${rule.pattern}`);
      return null;
    }
    // 「就地声明」只算**引用所在那一行**（不是上一行）：上一行常常是另一条目里顺手带出的
    // 「归档/忽略」字样，拿它放行就等于整目录豁免（#273：白名单不是整目录豁免）。
    const ctx = textOf(docRel).split("\n")[line - 1] ?? "";
    if (LOCAL_ARCHIVE_DECLARATION.test(ctx)) return null;
    return `指向任务档案（.gitignore:${rule.line} \`${rule.pattern}\` = ${dirCls.why}，实指 ${probe}），`
      + `但引用处没写「本机/本地/不入库/未跟踪/归档」这类声明，也没在 LOCAL_ARCHIVE_REFS 里逐条登记`
      + `（克隆后就是死引用；#162 定的口径：要么就地声明，要么逐条写理由，不许整目录豁免）`;
  }
  return `本仓不存在（仓库根 / ${docRel} 同目录 / 全仓唯一同名 三级都解不到），也不属于四类里的任何一类`
    + `——要么改对路径，要么按类登记并写理由（EXPECTED_ABSENT_PATHS / EXTERNAL_REPO_PATHS / `
    + `GENERATED_ARTIFACT_REFS / LOCAL_ARCHIVE_REFS）`;
}

function collectPathErrors() {
  const out = [];
  const notes = [];
  const ign = gitignoreMatcher(textOf(".gitignore"));
  for (const u of ign.unsupported) {
    out.push(`paths: .gitignore:${u.line} 用了取反规则 \`${u.pattern}\`，本脚本的极简匹配器不认——`
      + `要么改 .gitignore，要么在这里支持取反（不能默默把它当没忽略）`);
  }
  // .gitignore 的**目录型规则**必须逐条分类（#273：新增一条目录规则不许默默放行）。这里不能只看
  // 「当前有文件被它忽略」：新建的 scratch/ 目录里还没文件时就完全不报，那条规则等于静默上线。
  for (const r of ign.rules.filter((x) => x.pattern.endsWith("/"))) {
    if (IGNORED_DIR_CLASSES.has(r.pattern)) continue;
    out.push(`paths: .gitignore:${r.line} 的目录规则 \`${r.pattern}\` 没在 IGNORED_DIR_CLASSES 里分类`
      + `（install-tree / build-output / runtime / worktree / task-archive 五选一 + 写明理由）——`
      + `被忽略目录里的引用要不要放行，得由分类决定，不许默默放行新目录`);
  }
  REF_CLASS_HITS.clear();
  let excusedArchive = 0;
  for (const rel of PATH_DOCS) {
    const { refs, commands } = candidatePaths(rel);
    const bad = [];
    let resolvedByDoc = 0;
    let resolvedByBase = 0;
    let excused = 0;
    for (const { p, line } of refs) {
      const r = resolveRef(p, rel, ign);
      if (r.resolved) {
        if (r.via === "文档同目录") resolvedByDoc += 1;
        if (r.via === "全仓唯一同名") resolvedByBase += 1;
        continue;
      }
      const why = classifyAbsent(p, rel, line, ign, r);
      if (why === null) {
        excused += 1;
        continue;
      }
      if (r.ambiguous) {
        bad.push(`\`${p}\`（第 ${line} 行）：本仓有 ${r.ambiguous.length} 个同名文件（${r.ambiguous.join(", ")}），`
          + `裸文件名到底指哪个写清（歧义不算解析成功）`);
        continue;
      }
      bad.push(`\`${p}\`（第 ${line} 行）：${why}`);
    }
    const badCommands = commands.filter((c) =>
      c.kind === "file" ? !existsSync(path.join(ROOT, c.value)) : !(PKG.scripts ?? {})[c.value]);
    if (bad.length) {
      out.push(`paths: ${rel} 引用了无法裁决的仓库内路径（${bad.length} 处）：\n      ${bad.join("\n      ")}`);
    }
    if (badCommands.length) {
      out.push(`paths: ${rel} 引用的命令不可执行：${badCommands.map((c) => `第 ${c.line} 行 \`${c.kind === "file" ? `node ${c.value}` : `npm run ${c.value}`}\``).join(", ")}`);
    }
    notes.push(`paths: ${rel} 核对 ${refs.length} 个路径引用（其中 ${resolvedByDoc} 个靠文档同目录、${resolvedByBase} 个靠唯一同名解析）、${commands.length} 个命令；白名单判定 ${excused} 处`);
  }
  // 本机档案那一类**不限 PATH_DOCS**，全仓已跟踪 Markdown 都跑（#273 点名的两条历史样本就在
  // docs/harness-comparison/05 与 docs/research/2026-09-26 里，而那两份文档不适宜整体纳入
  // paths 覆盖面：docs/design/2026-10-08 实测 57 处引用里 46 处、docs/harness-comparison/01 的
  // 42 处里 32 处引用的是**别的仓库**的文件树，整体纳入就得整片豁免，等于没扩）。
  // 代价很轻：全仓指向被忽略**目录**的引用共 9 处，其中 4 处已经就地声明了「本地/不入库/gitignore」。
  for (const docRel of repoFiles(ign).tracked.filter((f) => f.endsWith(".md") && !PATH_DOCS.includes(f))) {
    const rel = docRel;
    const { refs } = candidatePaths(rel);
    const bad = [];
    for (const { p, line } of refs) {
      const r = resolveRef(p, rel, ign);
      if (r.resolved) continue;
      const rule = r.ignoredPath ? r.rule : ign.ruleFor(p.replace(/^\.\.?\//, ""));
      // 上一版读的是 r.ignored，而 resolveRef 返的字段叫 ignoredPath → 永远 undefined，
      // 于是「解到被忽略目录」的引用全部静默 continue（本类锚点实际从未跑过），这里一并接上。
      if (!rule || !rule.pattern.endsWith("/")) {
        // 解不到且没分类时，原本直接 continue（= 默默放行）。但**引用所在行自己就在讲任务档案目录**
        // （写了 docs/tasks/…）时，这一处就是在引本机档案：已登记的档案名被改一个字就同时弄坏了登记
        // 与引用，必须报（#273：白名单不是整目录豁免）。
        const lineText = textOf(rel).split("\n")[line - 1] ?? "";
        // 只拿「像个文件」的引用当档案引用：CHANGELOG 里 `scratch/` 这种目录/规则名也在同一行出现，
        // 不卡这一刀就会把目录名当成被改名的本机档案（假红）。
        const looksLikeFile = /\.[A-Za-z0-9]+$/.test(p.replace(/\/+$/, ""));
        if (!looksLikeFile || !/(^|[^-\w])docs\/tasks\//.test(lineText)) continue;
        const stem = (s2) => s2.replace(/\.[^.]+$/, "");   // 去扩展名后比前缀：改名（加/删一个字符）必然落在同一前缀里
        const twin = [...LOCAL_ARCHIVE_REFS.keys()].find((k) => k !== p
          && (stem(path.posix.basename(k)).startsWith(stem(path.posix.basename(p)))
            || stem(path.posix.basename(p)).startsWith(stem(path.posix.basename(k)))));
        bad.push(`\`${p}\`（第 ${line} 行）：指向任务档案（同一行写了 \`docs/tasks/…\`，该目录整目录不入库），`
          + `但这个名字仓库里解不到、也不在 LOCAL_ARCHIVE_REFS 登记里`
          + (twin ? `——与已登记的 \`${twin}\` 只差一个字符：登记与引用必须一起改` : ""));
        continue;
      }
      const why = classifyAbsent(p, rel, line, ign, r);
      if (why === null) { excusedArchive += 1; continue; }
      bad.push(`\`${p}\`（第 ${line} 行）：${why}`);
    }
    if (bad.length) {
      out.push(`archive-refs: ${rel} 引用了克隆后不存在的本机档案（${bad.length} 处）：\n      ${bad.join("\n      ")}`);
    }
  }
  notes.push(`archive-refs: 全仓非入口文档里指向被忽略目录的引用已全部裁决（白名单/就地声明共 ${excusedArchive} 处）`);
  // 白名单也要校：没人引用的条目就是「为不存在的引用留后门」，同样算检查面腐坏。
  const tables = [["absent", EXPECTED_ABSENT_PATHS], ["external", EXTERNAL_REPO_PATHS], ["archive", LOCAL_ARCHIVE_REFS]];
  for (const [tag, table] of tables) {
    for (const p of table.keys()) {
      if (REF_CLASS_HITS.has(`${tag}:${p}`)) continue;
      out.push(`paths: 白名单条目 \`${p}\` 没有一处引用真正用到它——要么它现在已能直接解析到（那就该删），`
        + `要么被检文档（${PATH_DOCS.join(", ")} + 全仓 .md）里已没人引用它；留着就是给未来的漂移留后门`);
    }
  }
  for (const g of GENERATED_ARTIFACT_REFS) {
    if (!REF_CLASS_HITS.has(`generated:${g.re.source}`)) {
      notes.push(`paths: 生成物条目 /${g.re.source}/ 当前没被用到（覆盖面内没有这类引用），保留是为了不让 *.d.ts 变红`);
    }
  }
  // 登记表自己也要被 .gitignore 校：「本机档案」的定义就是「被忽略目录里的档案」，目录不再忽略
  // 它就该销账（#273：分类真的读 .gitignore，不是只写在注释里）。
  for (const [p, why] of LOCAL_ARCHIVE_REFS) {
    // 登记可能是裸名（examples README 同句举的脚本名），先走同一套三级解析再问 .gitignore。
    const res = resolveRef(p, PI_EXT_README, ign);
    const rule = res.ignoredPath ? res.rule : ign.ruleFor(p.replace(/^\.\.?\//, ""));
    if (rule && IGNORED_DIR_CLASSES.get(rule.pattern)?.kind === "task-archive") continue;
    // 逐份点名「谁在拿这条登记当护身符」：登记失效 = 那些引用同时失去裁决依据（#273：分类真的读 .gitignore）。
    const bn = path.posix.basename(p);
    const refDocs = [...PATH_DOCS, ...repoFiles(ign).tracked.filter((f) => f.endsWith(".md") && !PATH_DOCS.includes(f))]
      .filter((d) => { const t = textOf(d); return t.includes(p) || t.includes(bn); });
    for (const d of (refDocs.length ? refDocs : ["（无文档引用）"])) {
      out.push(`archive-refs: ${d} 登记的 \`${p}\` 登记为本机档案（${why}），但 .gitignore 并不忽略它`
        + `——本机档案的定义就是「被 task-archive 目录忽略的本机文件」，登记已失效，请删登记或改 .gitignore`);
    }
  }
  const dirClsUsed = [...REF_CLASS_HITS].filter((k) => k.startsWith("dircls:"));
  notes.push(`paths: 被忽略目录的分类被用到的有 ${dirClsUsed.length ? dirClsUsed.map((k) => k.slice(7)).join(", ") : "（无）"}`);
  collectPathErrors.notes = notes;
  return out;
}

for (const e of collectPathErrors()) err(e);
for (const n of collectPathErrors.notes ?? []) note(n);

// ── 6. 中英标题骨架（README 一对，AGENTS 一对；issue #274 的附带项把 AGENTS 也纳入）────────
function headingLevels(rel) {
  return textOf(rel)
    .split("\n")
    .reduce((acc, line, i) => {
      const m = line.match(/^(#{1,6})\s+(.*)/);
      if (m) acc.push({ line: i + 1, level: m[1].length, title: m[2].trim() });
      return acc;
    }, []);
}

const seq = (hs) => hs.map((h) => h.level).join(",");

/** 一对中英文档的骨架对账（数量、层级序列、逐级数量）。*/
function collectSkeletonErrors(label, enRel, cnRel) {
  const out = [];
  const enH = headingLevels(enRel);
  const cnH = headingLevels(cnRel);
  if (enH.length !== cnH.length) {
    out.push(`skeleton: ${label} 标题总数不齐：EN ${enH.length} vs CN ${cnH.length}`);
  }
  if (seq(enH) !== seq(cnH)) {
    const i = [...seq(enH), "..."].findIndex((v, idx) => v !== [...seq(cnH), "..."][idx]);
    const at = Math.min(i, enH.length - 1, cnH.length - 1);
    out.push(
      `skeleton: ${label} 标题层级序列不齐（第 ${i + 1} 个标题起）：EN「${enH[at]?.title ?? "无"}」(L${enH[at]?.line ?? "-"}) vs CN「${cnH[at]?.title ?? "无"}」(L${cnH[at]?.line ?? "-"})；`
      + `\n    EN ${seq(enH)}\n    CN ${seq(cnH)}`,
    );
  }
  for (const level of new Set([...enH.map((h) => h.level), ...cnH.map((h) => h.level)])) {
    const ne = enH.filter((h) => h.level === level).length;
    const nc = cnH.filter((h) => h.level === level).length;
    if (ne !== nc) out.push(`skeleton: ${label} h${level} 数量不齐：EN ${ne} vs CN ${nc}`);
  }
  collectSkeletonErrors.notes = [`skeleton: ${label} 标题骨架一致（${enH.length} 个标题，层级序列相同）`];
  return out;
}

const SKELETON_PAIRS = [
  ["中英 README", README_EN, README_CN],
  ["中英 AGENTS", AGENTS_EN, AGENTS_CN],
];

function collectAllDrift() {
  const out = [...collectAnchorErrors(), ...checkPkgBlocks().errors, ...collectPathErrors(),
    ...collectMarkerLiteralErrors(), ...collectBaselineClaimErrors()];
  for (const [, en, cn] of SKELETON_PAIRS) out.push(...collectSkeletonErrors(en === README_EN ? "中英 README" : "中英 AGENTS", en, cn));
  return out;
}

for (const [label, en, cn] of SKELETON_PAIRS) {
  const errs = collectSkeletonErrors(label, en, cn);
  errs.forEach((e) => err(e));
  if (!errs.length) note(collectSkeletonErrors.notes.join(""));
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
// ── 7. 跑清单/单位类锚点、marker 字面、棘轮当前值与 package.json 清单比对 ────────
for (const e of collectMarkerLiteralErrors()) err(e);
for (const n of collectMarkerLiteralErrors.notes ?? []) note(n);
for (const e of collectBaselineClaimErrors()) err(e);
for (const n of collectBaselineClaimErrors.notes ?? []) note(n);
const pkgBlock = checkPkgBlocks();
pkgBlock.errors.forEach((e) => err(e));
pkgBlock.warnings.forEach((w) => warn(w));
const anchorErrors = collectAnchorErrors();
anchorErrors.forEach((e) => err(e));
for (const n of collectAnchorErrors.notes ?? []) note(n);

// ── 8. 反向证自测（issue #210 R2：把反向证固化在脚本里，不靠一次性手工实验）──────
// 每条规则至少两例：改文档一处 → 必须红；改源码/清单一侧 → 必须红；都不改（对照）→ 必须绿。
// 变异没落上去也算失败——否则规则改了而变异体过期，自测会默默变成空跑。
const SELF_TEST = process.argv.includes("--self-test");
const SELF_TEST_CASES = [
  // —— pkg-block / exports：#210 报的四种破坏，**前两种修前是绿的** ——
  {
    label: "README 把 exports 的 \"./tools\" 改名（修前 exit 0）",
    overlay: { [README_EN]: (t) => t.replace('  "./tools": {', '  "./zzz": {') },
    expect: [/README\.md 的 `exports` 围栏键集合 缺 子路径键 "\.\/tools"/, /README\.md 的 `exports` 围栏键集合 多出真值里没有的 子路径键 "\.\/zzz"/],
  },
  {
    label: "README 删掉 exports 的 \"./tools\" 整个键（修前 exit 0）",
    overlay: { [README_EN]: (t) => t.replace('  "./tools": {\n    "types": "./src/tools/index.d.ts",\n    "default": "./src/tools/index.js"\n  },\n', "") },
    expect: [/README\.md 的 `exports` 围栏键集合 缺 子路径键 "\.\/tools"/],
  },
  {
    label: "README 的 exports 多一个 \"./zzz\" 键",
    overlay: { [README_EN]: (t) => t.replace('  "./contract-tests": "', '  "./zzz": "./test/contract/index.js",\n  "./contract-tests": "') },
    expect: [/README\.md 的 `exports` 围栏键集合 多出真值里没有的 子路径键 "\.\/zzz"/],
  },
  {
    label: "README 的 exports 把 \".\" 的值写错",
    overlay: { [README_EN]: (t) => t.replace('    "types": "./src/index.d.ts",', '    "types": "./src/nope.d.ts",') },
    expect: [/README\.md 的 `exports` 里键 "\." 的值与 package.json 不一致/],
  },
  {
    label: "README 的 exports 重复写同一个子路径键（JSON.parse 会静默吞掉）",
    overlay: { [README_EN]: (t) => t.replace('  "./tools": {', '  ".": {\n    "types": "./src/index.d.ts",\n    "default": "./src/index.js"\n  },\n  "./tools": {') },
    expect: [/子路径键 "\." 写了不止一次/],
  },
  // —— pkg-block / files：同一族 fail-open ——
  {
    label: "README 的 files 围栏删一项（连带块定位也会失效）",
    overlay: { [README_EN]: (t) => t.replace('```json\n[\n  "src",\n', '```json\n[\n') },
    expect: [/README\.md 的 `files` 围栏 缺 条目 "src"/],
  },
  {
    label: "README 的 files 围栏写重一项（集合相等但多了一份）",
    overlay: { [README_EN]: (t) => t.replace('  "LICENSE",\n', '  "LICENSE",\n  "LICENSE",\n') },
    expect: [/README\.md 的 `files` 围栏 的 条目清单里 "LICENSE" 写了不止一次/],
  },
  {
    label: "README 的 files 围栏被改坏（JSON 解不开 → 块找不到就是检查面失效）",
    overlay: { [README_EN]: (t) => t.replace('  "LICENSE",\n', '  "LICENSE",,\n') },
    expect: [/README\.md 找不到 `files` 清单围栏/],
  },
  // —— package.json 侧：中英两侧都必须红 ——
  {
    label: "package.json 加一个假子路径 → 中英都红",
    overlay: { "package.json": (t) => t.replace('    "./contract-tests": "', '    "./fake": "./src/fake.js",\n    "./contract-tests": "') },
    expect: [/README\.md 的 `exports` 围栏键集合 缺 子路径键 "\.\/fake"/, /README_cn\.md 的 `exports` 围栏键集合 缺 子路径键 "\.\/fake"/],
    expectFiles: [README_EN, README_CN],
  },
  {
    label: "package.json 的 files 加一个假条目 → 中英都红",
    overlay: { "package.json": (t) => t.replace('    "LICENSE",', '    "LICENSE",\n    "docs/host-upgrade-guide-9.9.9.md",') },
    expect: [/README\.md 的 `files` 围栏 缺 条目 "docs\/host-upgrade-guide-9\.9\.9\.md"/, /README_cn\.md 的 `files` 围栏 缺 条目 "docs\/host-upgrade-guide-9\.9\.9\.md"/],
    expectFiles: [README_EN, README_CN],
  },
  // —— anchors：vendor 跳过目录 ——
  {
    label: "契约 CN 的 vendor 跳过清单删一处 `target`",
    overlay: { [CONTRACT_CN]: (t) => t.replace("`node_modules`、`dist`、`build`、`target`、", "`node_modules`、`dist`、`build`、") },
    expect: [/host-consumer-contract_cn\.md.*缺 目录 "target"/],
  },
  {
    label: "源码 VENDOR_DIRECTORIES 加一档 → 中英四处都红",
    overlay: { "src/tools/file-tools.js": (t) => t.replace('new Set(["node_modules", "dist", "build", "target", "vendor"])', 'new Set(["node_modules", "dist", "build", "target", "vendor", "third_party"])') },
    expect: [/缺 目录 "third_party"/],
    expectFiles: [README_EN, README_CN, CONTRACT_EN, CONTRACT_CN],
  },
  // —— anchors：文件工具清单 / CLI 工具清单 ——
  {
    label: "契约 EN 的文件工具清单删一个 `edit`",
    overlay: { [CONTRACT_EN]: (t) => t.replace("  `edit` / `writeFile` schemas", "  `writeFile` schemas") },
    expect: [/host-consumer-contract\.md.*缺 工具名 "edit"/],
  },
  {
    label: "README EN 的 CLI 工具清单写一个源码里不存在的工具名（凭空多写）",
    overlay: { [README_EN]: (t) => t.replace("`writeFile`, and `exec`.", "`writeFile`, and `execx`.") },
    expect: [/README\.md.*多出真值与允许清单里都没有的 工具名 "execx"/],
  },
  {
    label: "README_cn 的 CLI 工具清单删一个 `edit`",
    overlay: { [README_CN]: (t) => t.replace("`tree`、`edit`、`writeFile` 和 `exec`", "`tree`、`writeFile` 和 `exec`") },
    expect: [/README_cn\.md.*缺 工具名 "edit"/],
  },
  {
    label: "源码改一个文件工具名 → 中英四处都红",
    overlay: { "src/tools/file-tools.js": (t) => t.replace('    name: "writeFile",', '    name: "writeFileNow",') },
    expect: [/缺 工具名 "writeFileNow"/, /多出真值里没有的 工具名 "writeFile"/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  // —— anchors：内置压缩策略名 ——
  {
    label: "README EN 的压缩策略名清单删一个 `fold-llm`",
    overlay: { [README_EN]: (t) => t.replace('"sliding-window" | "fold-statistical" | "fold-llm"', '"sliding-window" | "fold-statistical"') },
    expect: [/缺 策略名 "fold-llm"/],
  },
  {
    label: "源码加一个内置策略名 → 中英四处都红",
    overlay: { "src/compact/strategy-resolution.js": (t) => t.replace('  "fold-llm": createFoldLlmStrategy,', '  "fold-llm": createFoldLlmStrategy,\n  "zzz-window": createFoldLlmStrategy,') },
    expect: [/缺 策略名 "zzz-window"/],
    expectFiles: [README_EN, README_CN, CONTRACT_EN, CONTRACT_CN],
  },
  // —— anchors：formatSize 单位档位与示例映射 ——
  {
    label: "契约 EN 的单位清单删一处 `TB`（issue 正文的盲区复现）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("renders `B` / `KB` / `MB` / `GB` / `TB` on", "renders `B` / `KB` / `MB` / `GB` on") },
    expect: [/host-consumer-contract\.md.*缺 单位 "TB"/],
  },
  {
    label: "契约 CN 的单位清单把 `TB` 改名成 `TP`",
    overlay: { [CONTRACT_CN]: (t) => t.replace("`B`/`KB`/`MB`/`GB`/`TB`\n", "`B`/`KB`/`MB`/`GB`/`TP`\n") },
    expect: [/host-consumer-contract_cn\.md.*缺 单位 "TB"/, /多出真值里没有的 单位 "TP"/],
  },
  {
    label: "契约 EN 的单位清单整句删掉（逐处一致接不住，靠中英处数对账）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("(`B`/`KB`/`MB`/`GB`/`TB`, 1024 base,", "(human-readable, 1024 base,") },
    expect: [/单位清单.*声明点处数中英不齐/],
  },
  {
    label: "契约 EN 的示例映射把 1649267441664 写成 2.5TB",
    overlay: { [CONTRACT_EN]: (t) => t.replace("`1649267441664` → `1.5TB`", "`1649267441664` → `2.5TB`") },
    expect: [/把 1649267441664 写成 `2\.5TB`.*复算是 `1\.5TB`/],
  },
  {
    label: "契约 CN 的示例映射删掉一条（档位少一档 → 处数不齐）",
    overlay: { [CONTRACT_CN]: (t) => t.replace("`1536` → `2KB`、", "") },
    expect: [/示例映射.*声明点处数中英不齐/],
  },
  {
    label: "源码 formatSize 的 TB 档改名 → 档位清单与示例映射两层都红",
    overlay: { "src/tools/file-tools.js": (t) => t.replace("return `${(gb / 1024).toFixed(1)}TB`;", "return `${(gb / 1024).toFixed(1)}PB`;") },
    expect: [/缺 单位 "PB"/, /多出真值里没有的 单位 "TB"/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "源码 formatSize 的 MB 档改成两位小数 → 文档示例映射全红",
    overlay: { "src/tools/file-tools.js": (t) => t.replace("return `${mb.toFixed(1)}MB`;", "return `${mb.toFixed(2)}MB`;") },
    expect: [/写成 `1\.5MB`.*复算是 `1\.50MB`/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },

  // —— markers：marker 字面量与源码模板同源（issue #272；下面 4 例修前**全是 exit 0**）——
  {
    label: "契约 EN 把 marker 的 `（文件 <size>）` 段删掉（修前 exit 0）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("[共 N 行（文件 <size>），剩余 M 行", "[共 N 行，剩余 M 行") },
    expect: [/markers\/readMoreLines.*host-consumer-contract\.md:\d+ 引用的是 "\[共 N 行，剩余 M 行/, /渲染出来是 "\[共 N 行（文件 <size>）/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "契约 CN 把续读占位符 `offset=K` 写成 `offset=N`（修前 exit 0）",
    overlay: { [CONTRACT_CN]: (t) => t.replace("readFile 传 offset=K 继续", "readFile 传 offset=N 继续") },
    expect: [/markers\/readMoreLines.*host-consumer-contract_cn\.md:\d+ 引用的是 .*offset=N 继续.*，但按 src\/tools\/file-tools\.js/],
  },
  {
    label: "源码模板把「剩余」改成「还剩」→ 中英两处引用同时红",
    overlay: { "src/tools/file-tools.js": (t) => t.replace("剩余 ${values.total - values.offset}", "还剩 ${values.total - values.offset}") },
    // 逐处比对，每一处（EN 与 CN）单独成一条 error；期望两份都要被点名（[\s\S] 是因为 error 文本里带换行）
    expect: [/渲染出来是 "\[共 N 行（文件 <size>），还剩 M 行/, /markers\/readMoreLines marker 字面（契约中英引用）: docs\/host-consumer-contract(_cn)?\.md:\d+ 引用的是 .*但按 src\/tools\/file-tools\.js/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "源码 NEXT_STEP_CLAUSE 改文案 → 中英两处引用同时红（#267 只钉住了源码侧形状，没管文档）",
    overlay: { "src/tools/file-tools.js": (t) => t.replace('const NEXT_STEP_CLAUSE = "下一步：";', 'const NEXT_STEP_CLAUSE = "接着：";') },
    expect: [/渲染出来是 .*接着：readFile 传 offset=K/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "源码给 marker 模板加一个未登记的插值 → 红并点名未登记（不许拿旧字面比新真值）",
    overlay: { "src/tools/file-tools.js": (t) => t.replace("剩余 ${values.total - values.offset} 行", "剩余 ${values.total - values.offset} 行（从 ${values.offset + 1} 行起）") },
    expect: [/模板里有未登记的插值 .*values\.offset \+ 1/],
  },
  {
    label: "把 CN 契约那一处引用整段删掉 → 检查面失效 + 中英处数不齐",
    overlay: { [CONTRACT_CN]: (t) => t.replace("`[共 N 行（文件 <size>），剩余 M 行；下一步：readFile 传 offset=K 继续]`", "上面那张截断标记表里的续读提示") },
    expect: [/找不到以 `\[共 ` 开头的 marker 字面引用/, /声明点处数中英不齐：.* 1 处 vs .* 0 处/],
  },

  // —— paths：覆盖面与四类裁决（issue #273）——
  {
    label: "把 examples/pi-extension/README.md 里的同目录文件 `erix-run-core.js` 改个名（修前 exit 0）",
    overlay: { [PI_EXT_README]: (t) => t.replace("`erix-run-core.js`", "`erix-run-coreX.js`") },
    expect: [/paths: examples\/pi-extension\/README\.md[\s\S]*`erix-run-coreX\.js`（第 \d+ 行）：本仓不存在/],
    expectFiles: [PI_EXT_README],
  },
  {
    label: "把根 README 引用的 docs/architecture.md 改名（既有行为不退化）",
    overlay: { [README_EN]: (t) => t.replace("blob/main/docs/architecture.md", "blob/main/docs/architectureX.md") },
    // 变异要落在**真正被核对的那个引用**上：这行是 `[docs/architecture.md](https://…/blob/main/docs/architecture.md)`，
    // 只改链接文字动不了提取出的 href（URL 会被改写成仓内路径），所以上一版是“变异没接上检查面”而非锚点绿。
    expect: [/paths: README\.md[\s\S]*docs\/architectureX\.md/],
    expectFiles: [README_EN],
  },
  {
    label: "白名单不是整目录豁免：把已登记的 CHANGELOG 任务档案名改一个字 → 红",
    overlay: { "CHANGELOG.md": (t) => t.replace("repro-circular-details.mjs", "repro-circular-detailsX.mjs") },
    expect: [/archive-refs: CHANGELOG\.md[\s\S]*repro-circular-detailsX\.mjs[\s\S]*指向任务档案/],
    expectFiles: ["CHANGELOG.md"],
  },
  {
    label: "就地声明就能放行（对照）：把已登记的 REPORT.md 换成没登记的 PLAN.md，同行仍写「本地，不入库」",
    overlay: { "docs/research/2026-09-26-strategy-variance-and-cache-economics.md": (t) => t.replace("REPORT.md", "PLAN.md") },
    expectGreen: true,
  },
  {
    label: "把那句「（本地，不入库）」删掉 → 同一处立刻红（证明上一例的绿来自声明，不是恒绿）",
    overlay: {
      "docs/research/2026-09-26-strategy-variance-and-cache-economics.md": (t) =>
        t.replace("REPORT.md", "PLAN.md").replace("任务文档（本地，不入库）：", "任务文档："),
    },
    expect: [/archive-refs: docs\/research\/2026-09-26[\s\S]*PLAN\.md[\s\S]*没在引用处写明|archive-refs: docs\/research\/2026-09-26[\s\S]*PLAN\.md[\s\S]*没写「本机/],
  },
  {
    label: "分类真的读 .gitignore：把 docs/tasks/ 从 .gitignore 里去掉 → 本机档案登记与放行全部失效",
    overlay: { ".gitignore": (t) => t.replace("docs/tasks/\n", "") },
    expect: [/登记为本机档案.*但 \.gitignore 并不忽略/, /archive-refs: CHANGELOG\.md|paths: examples\/pi-extension\/README\.md/],
  },
  {
    label: ".gitignore 新增一条没分类的目录规则 → 红（不许默默放行新目录）",
    overlay: { ".gitignore": (t) => t.replace("docs/tasks/\n", "docs/tasks/\nscratch/\n") },
    expect: [/没在 IGNORED_DIR_CLASSES 里分类|没有一处引用真正用到它/],
  },
  {
    label: "白名单条目变空转：两处引用（examples README 与 CHANGELOG 的同名提及）全改掉 → 该登记被判失效",
    overlay: {
      // #273 把 archive 类的三级解析接上后，CHANGELOG:89 的裸名提及也算一处真实引用；只下掉一处只会
      // 让那一处红，要证「登记空转」得把两处都下掉。
      [PI_EXT_README]: (t) => t.replace("`e2e-wake.mjs`", "`e2e-wake-v2.mjs`"),
      "CHANGELOG.md": (t) => t.replace("`e2e-wake.mjs`", "`e2e-wake-v2.mjs`"),
      "docs/research/2026-10-13-pi-subagents-async-attribution.md": (t) => t.replace("`e2e-wake.mjs`", "`e2e-wake-v2.mjs`"),
    },
    expect: [/白名单条目 `e2e-wake\.mjs` 没有一处引用真正用到它/],
  },

  // —— baseline：AGENTS 的棘轮当前值 ↔ 棘轮常量（issue #274）——
  {
    label: "AGENTS EN 把基线写成 142（#265 当年留在 CHANGELOG 的那种开发中途值）（修前 exit 0）",
    overlay: { [AGENTS_EN]: (t) => t.replace("baseline constant **121**", "baseline constant **142**") },
    expect: [/baseline\/「基线常量 \/ baseline constant」声明: AGENTS\.md:\d+ 声称 142，但 scripts\/type-check-ratchet\.mjs 的 BASELINE_ROOT 是 121/],
    expectFiles: [AGENTS_EN],
  },
  {
    label: "AGENTS CN 把常量写法写成 120 → 点名 AGENTS_cn.md",
    overlay: { [AGENTS_CN]: (t) => t.replace("BASELINE_ROOT = 121", "BASELINE_ROOT = 120") },
    expect: [/baseline\/常量写法 `BASELINE_ROOT = N`: AGENTS_cn\.md:\d+ 声称 120，但 .* BASELINE_ROOT 是 121/],
    expectFiles: [AGENTS_CN],
  },
  {
    label: "棘轮常量自己降 1 → 中英两侧的当前值句式全红",
    overlay: { [RATCHET_SRC]: (t) => t.replace("const BASELINE_ROOT = 121;", "const BASELINE_ROOT = 120;") },
    expect: [/BASELINE_ROOT 是 120/],
    expectFiles: [AGENTS_EN, AGENTS_CN],
  },
  {
    label: "CN 的分解式写成 121 + 27 + 15 → 算术不闭合就红",
    overlay: { [AGENTS_CN]: (t) => t.replace("= 121 + 27 + 16", "= 121 + 27 + 15") },
    expect: [/分解式 121 \+ 27 \+ 15 = 163，不等于 BASELINE_WITH_TOOLS（164）/],
    expectFiles: [AGENTS_CN],
  },
  {
    label: "EN 少写一处「基线 **164** / 31 files」→ 中英句式处数不齐",
    overlay: { [AGENTS_EN]: (t) => t.replace("baseline **164** / 31 files = 121 + 27 + 16", "the 164-error baseline spread over 31 files (= 121 + 27 + 16)") },
    expect: [/baseline\/「基线 \*\*N\*\* \/ 31 个文件」声明: 声明点处数中英不齐：AGENTS\.md 1 处 vs AGENTS_cn\.md 2 处/],
  },
  {
    label: "历史值不被误伤（对照）：CN 叙述里的 142 改成 143 必须仍然绿",
    overlay: { [AGENTS_CN]: (t) => t.replace("**无 `.d.ts` 在场 = 142 个错**", "**无 `.d.ts` 在场 = 143 个错**") },
    expectGreen: true,
  },
  {
    label: "AGENTS 中英标题骨架缺一边（#274 附带项：AGENTS 也纳入骨架对账）",
    overlay: { [AGENTS_CN]: (t) => t.replace("## 3. 开发命令", "#### 3. 开发命令") },
    // 变异必须只落在 CN 一侧（EN 写的是 "3. Development commands"）：两边都有的标题字串拿去变异会同时
    // 改掉两份文档，骨架差异被抹平 → 反向证自身失效（#274）。
    expect: [/skeleton: 中英 AGENTS/],
  },
];

function runSelfTest() {
  const run = () => collectAllDrift();
  const failures = [];
  const passed = [];
  const control = run();
  if (control.length) {
    failures.push(`对照组（源码与文档都不改）本该 0 错，实测 ${control.length} 处：\n      ${control.join("\n      ")}`);
  } else {
    passed.push("对照：源码与文档都不改 → 0 错");
  }
  for (const c of SELF_TEST_CASES) {
    let ok = true;
    for (const [rel, mutate] of Object.entries(c.overlay)) {
      const before = read(rel);
      const after = mutate(before);
      if (after === before) {
        failures.push(`${c.label}：变异没落到 ${rel} 上（反向证自身失效：脚本里的变异体已与文档/源码脱节）`);
        ok = false;
        break;
      }
      OVERLAY.set(rel, after);
    }
    if (!ok) { OVERLAY.clear(); continue; }
    const errs = run();
    OVERLAY.clear();
    if (c.expectGreen) {
      if (errs.length) {
        failures.push(`${c.label}：变异之后本该绿（这条是在证「白名单/就地声明真的在放行」），实测 ${errs.length} 处红：\n      ${errs.join("\n      ")}`);
      } else {
        passed.push(`${c.label} → 仍然 0 错（放行分支有效，不是恒绿）`);
      }
      continue;
    }
    const missed = (c.expect ?? []).filter((re) => !errs.some((e) => re.test(e)));
    const missedFiles = (c.expectFiles ?? []).filter((rel) => !errs.some((e) => e.includes(rel)));
    if (!errs.length) failures.push(`${c.label}：改了但没红（锚点仍是 fail-open）`);
    else if (missed.length || missedFiles.length) {
      failures.push(`${c.label}：红了，但错误信息没点该点的名／没覆盖该覆盖的文件`
        + `（未命中 ${missed.map((r) => String(r)).join(" ; ") || "—"}${missedFiles.length ? `；未覆盖 ${missedFiles.join(", ")}` : ""}）`
        + `\n      实测：${errs.join("\n      ")}`);
    } else {
      passed.push(`${c.label} → ${errs.length} 处红（已点名）`);
    }
  }
  console.log(`docs-drift-check --self-test：全部锚点的反向证（改→红、不改→绿、放行分支变异→绿；变异未落上也算失败）`);
  for (const p of passed) console.log(`  ✓ ${p}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (failures.length) {
    console.log(`docs-drift-check --self-test: 失败 — ${failures.length}/${SELF_TEST_CASES.length + 1} 例未达预期`);
    process.exit(1);
  }
  console.log(`docs-drift-check --self-test: OK — ${SELF_TEST_CASES.length} 例反向证/放行证全部按预期，对照组绿`);
}

if (SELF_TEST) {
  runSelfTest();
  process.exit(0);   // 自测只跑清单/单位类锚点与 package.json 清单那套比较器，不附带跑全部门禁
}

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
  `docs-drift-check: OK — 版本/默认值/清单（含中英逐处对账）/模块地图/路径/中英骨架共 ${checked.length} 项对齐 package.json ${PKG_VERSION} 与源码`
  + (warnings.length ? `（${warnings.length} 处告警，先告警后阻塞：\n` + warnings.map((w) => `  ⚠ ${w}`).join("\n") + "\n）" : ""),
);
