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
//  10. toolfact   工具事实契约面（工单 261014 T1，#284 / #285）：契约中英里声明 `erix` 字段
//                 归属的**五个声明面**（散文清单、字段归属表、「恰好 N 个字段」数量声明、
//                 存在性矩阵表头、legacy 别名表）逐面与 `src/tool-fact.js` 导出的
//                 `TOOL_RESULT_CONTRACT` **双向**比成员；命名空间名（engine.ns / host.ns）、
//                 协议必需/条件字段、别名的新归属同属真值；每面另加中英声明点处数对账。
//                 这一条就是「同一个事实第三处自说自话」的防线：字段改名/新增/退役不再
//                 只红契约测试，文档也会同时红
//  11. symbols    符号锚点（issue #286 T-a）：文档里「符号 + 文件」形态的引用（`` `SYM`（`src/x.js`） `` 与
//                 markdown 链接两种形态）必须能在被引文件里抽到该符号的**声明**。支持的声明形态：
//                 `function` / `class` / `const|let|var` 绑定 / 解构绑定 / 再导出 / 方法 / 对象键与类字段 /
//                 `process.env.X` 环境变量读取处。逐处校（每一处单独比），找不到就红并点名该文件里**实际存在的
//                 相近符号名**（前缀 / 子串 / 编辑距离 ≤2）；一个文件里连一条声明都抽不到同样算红
//                 （#164「抽不到真值就报错」）。唯一的弱一档——「具名字面量成员」（终止原因 / provider 错误码
//                 这类**字符串值**）——只在 `SYMBOL_VALUE_MEMBERSHIP` 里逐份点名并写明理由的 4 个文件生效，
//                 不做全仓放行。本条**不做**中英处数对账，理由写在 §2.8 的节头。
//  12. bare-lines 裸行号棘轮（issue #286 T-a）：`src/**.js:N` / `:N-M` 形态的引用按唯一
//                 (文档, 目标文件, 行区间) 计数，**只减不增**：基线 `BARE_LINE_REF_BASELINE = 244`，超了红
//                 （并提示「可以把基线降到 N」），低于基线算过但会催你降。**越界行号是 error**，不是观察项。
//                 覆盖面 = 宿主会读的 20 份文档：README{,_cn} / AGENTS{,_cn} / host-consumer-contract{,_cn}
//                 + `docs/host-upgrade-guide*.md` 全部（按目录实扫，新指南落地即自动纳面）。
//                 正则 `src\/[A-Za-z0-9_./-]+\.js:(\d+)(?:-(\d+))?`；工单口径实测 248 唯一区间 / 279 次出现
//                 （跑 `--verbose` 复核，别只信注释），减去 `BARE_LINE_EXEMPTIONS` 的 4 处示例/外仓路径 ⇒ 244。
//                 豁免是**条目 + 引用行就地声明**双条件（与 #286 已落在 `test/static-guards.test.js` 的
//                 `LOCAL_ARCHIVE_DIRS` + `LOCAL_ARCHIVE_DECLARATION` 同口径），条目没被任何引用用到就红。
//                 `CHANGELOG.md` **不进棘轮面**：历史条目写的是**当时**那份代码的行号，改掉等于伪造历史
//                 （与 #278 对简称「只登记不改写」同口径）；那些行号仍由 `paths` 校文件存在性，只是不进这个数。
//
// 锚点粒度（issue #210 R3：**别把「存在性」锚点误当成「文档里删一处提及就会红」**）：
//   · 存在性（每档被检查文档至少命中一次即可；同一句里删掉额外一处提及不会红）：
//       defaults 的全部条目（`must` 是「文档里存在这个正则」，`mustNot` 才是逐处的）、
//       modulemap（只查 src→文档 方向：地图多写文件不会红）、paths（只查文档→仓库 方向）
//   · 逐处一致（每一处声明都单独比，缺/多/改名/写重都红）：
//       version 的「当前版本」声明与「不得高于 package.json」的全量版本号扫描、
//       pkg-block 的 files/exports（双向对称）、anchors 的清单/枚举/单位规则、
//       markers 的 marker 字面量（#272）、baseline 的棘轮当前值（#274）、
//       toolfact 的五个字段声明面（工单 261014，与 TOOL_RESULT_CONTRACT 双向对称）、
//       symbols 的「符号 + 文件」锚点（#286 T-a：每一处都要在被引文件里抽到该符号的声明）
//   · 只减不增的棘轮（比的是「还剩多少」：新增即红，变少则必须降基线并写理由）：
//       bare-lines 的裸行号引用数（#286 T-a，基线 244，与 `check:types` 的 BASELINE_ROOT 同构）
//   · 中英对账（比的是处数与数量级）：skeleton 的标题数与层级序列（README **与** AGENTS 两对）、
//       anchors 的声明点处数、markers 的引用处数、baseline 的句式处数、
//       toolfact 每一面的声明点处数
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
/** 工具事实契约常量的真值出处（工单 261014 T1）。 */
const TOOL_FACT_SRC = "src/tool-fact.js";

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
//
// ── #279 的病历（与上面同一份口径：谁有病、为什么不逐例重写）─────────────────────────
// 病：`--self-test` 若干用例的 overlay 是「在某文档里把一个文件名改个名」，写法是 JS 的
//   `t.replace("X.mjs", …)` —— **只换文本里第一次出现**。而「第一次出现在哪」取决于文档措辞：
//   任何人在同一文档更靠前的位置**用散文提一句同一个名字**（带反引号就会被提取成引用），那一枪
//   就打在未被裁决的那一处上。实证三次（#278 收尾 3 红、#280 收尾 2 红——两条形状不同：一条
//   「红了但没点该点的名」、一条「**改了但没红**」= 自测报出假 fail-open 警报），两次都得靠
//   「把那个名字从散文里去掉」才恢复——那正是让人放宽期望的溃败入口。
// 治（选定：按提取结果定点打靶）：`mutateRef(from, to)` 用**与主检查同一套提取逻辑**
//   （`extractRefOccurrences` 的 `spans`）定位「提取值 == from」的全部出现，逐处定点替换。
//   · 为什么不是「只改第一次出现」的定点版：主检查按**值去重**（`candidatePaths` 的 `out` 一个值只留
//     一条），改一处而别处还剩着同一个值 → 提取集没变 → 该红的不红（假 fail-open）。所以「那一处」
//     在本检查的语义下就是「该值的全部出现」，必须一次打全。
//   · 为什么不是裸 `replaceAll`：`"repro-circular-details.mjs"` 是 `docs/tasks/…/repro-circular-details.mjs`
//     这个**另一个引用值**的子串，裸替换会顺手打死不相干的登记，期望只能跟着改（措辞绑架）。
//   · 为什么不是注入提取结果集（issue 说的「最稳」）：注入会让**文本与提取结果对不上**——同一行写着
//     A、检查按 B 判，而「同行写了 `docs/tasks/`」「同地声明」这些判据读的就是行文本，那个状态任何真
//     文档都造不出来，验收时没人能重现。定点替换只改文本，不制造假状态。
//   · 防「空跑假绿」：一个 span 都没命中（靶串已从文档消失 / 本来就不是被提取的引用）就**原样返回**，
//     由 `runSelfTest` 既有的「变异没落到 X 上」判据报红；另加了期望强度校（能匹配空串的期望 = 永真）。
// 清单（本单前共 56 例，其中「在某文档里替换一个文件名/路径」的共 **15 例 / 18 个 overlay**，本轮全改成 `mutateRef`）：
//   ① examples/pi-extension/README 的 `erix-run-core.js` 改名（该值在本仓提取面里有 4 处，旧写法只打 1 处）
//   ② 根 README 引用的 docs/architecture.md 改名（提取值是 URL 尾段，旧写法靠人手工挑靶串）
//   ③ 白名单不是整目录豁免：CHANGELOG 里已登记的 `repro-circular-details.mjs` 改一个字（#278 首次现场）
//   ④ 同地声明就能放行（对照）：2026-09-26 那篇的 REPORT.md → PLAN.md
//   ⑤ 上面那例的反向证：把「（本地，不入库）」删掉（同一行里的文件名变异 + 散文变异两刀）
//   ⑥ 白名单条目变空转：`e2e-wake.mjs` 在三份文档里的同名提及全改掉
//   ⑦ #280：空树形下把已登记裸名改成未登记假名（`e2e-wake-cloneQ.mjs`）
//   ⑧ #278-P2：改坏**已登记**的裸名 `repro-circular-details.mjs`
//   ⑨ #278-P3：改坏**未登记**的裸名 `e2e-wake.mjs`
//   ⑩ 跳仓对照文档的裸名不被裁决（对照）：codex 篇的 `MEMORY.md` 改名（该值 5 处）
//   ⑪ #269 原型：`debug.routes.js` 改成凭空无近邻的 `zz-nonexistent-evidence.md`（唯一把**行号钉在
//      期望里**的一例：`（第 118 行）`——只要有人在那行上面加一句散文它就红，而那正是本单的病；
//      改成断言「必须点名一个行号」（`第 \d+ 行`）而不是某个固定地址，不是放宽：两者都要求报出行号）
//   ⑫ 跳仓点名清单不许烂着：harness-comparison/README 的 `MEMORY.md` 全改成实物名（原本就是 `replaceAll`，
//      仍是「按子串」而非「按提取值」，一并改成定点）
//   ⑬ 登记表反向校扩到裸名（#278 第 4 件）：CHANGELOG 与 research 篇的裸名全改成真实路径（#280 现场）
//   ⑭ 近邻判据不跟跳仓豁免一起免：02-touwaka 篇把 `README.md` 换成本仓实物名改坏尾缀
//   ⑮ 简称登记也要反向校（#278 第五类）：CHANGELOG 里的 `format.js` 简称改成实物路径（原本已是 `replaceAll`，
//      仍是按子串而非按提取值，一并改成定点）
//   没改的 41 例（README/package.json 的 exports・files 围栏、清单/单位/标记/默认值锚点、棘轮基线句式、
//   `.gitignore` 文本、#280 的树形口子那两例）：它们的靶不是「一个文件名」，不存在抢枪问题
//   （围栏/句式类靶的唯一性由各自的提取器保证；树形例根本不碰文本）。
// 另外新增两例把本单的病钉住（见 SELF_TEST_CASES 里标着「#279」那两条）：散文提一句已登记的裸名，
//   既要「门禁仍绿」，也要「变异仍打在真正被提取到的那一处」——前者单独存在时修前也是绿的，
//   所以本单的修前红证据靠后者（它在修前就是 #280 那条「改了但没红」的假 fail-open）。

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

// ── 2.5.2 工具事实契约面：契约文档的字段清单 ↔ `TOOL_RESULT_CONTRACT` 常量（工单 261014 T1）───
// 病根（#284 / #285）：同一个事实的「谁拥有哪个字段」在构造器、文档、契约测试三处各写一份。
// 修法是把它写成导出常量，本规则接上其中「文档 ↔ 常量」那条边：**双向**比成员。
// 真值从 `src/tool-fact.js` 的**源码文本**抽（不 import）：门禁要在没有生成物、没有
// node_modules 的树里能跑，且必须能吃 `--self-test` 的内存副本（OVERLAY）。
// 声明面有五个（都在中英两份契约里各自存一份，所以下面逐面做中英处数对账）：
//   ① 散文清单「以 `erix.<field>` 寻址：`a` / `b` / …」
//   ② 字段归属表（第一格是字段、第二格是 Owner）——含命名空间名本身
//   ③ 「exactly five fields / 恰好五个字段」这类数量声明
//   ④ 存在性矩阵的表头列名
//   ⑤ legacy 别名表（旧顶层键 → 新归属）
// ④ 的期望集是「引擎字段减去 `success`」：矩阵刻意不给 `success` 开列（契约里就写了理由：
// 它是输入/输出不对称的那个），所以下面写成显式常量而不是从常量推；新增一个引擎字段仍必须
// 同时多一列，否则就是「缺」红。

const CN_NUMERALS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 两: 2 };
const EN_NUMERALS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** 从 `src/tool-fact.js` 的源码抽 `TOOL_RESULT_CONTRACT` 的真值；抽不到就 null（→ error）。 */
function toolFactTruth(src) {
  const obj = src.match(/export const TOOL_RESULT_CONTRACT = deepFreeze\(\{([\s\S]*?)\n\}\)/)?.[1];
  if (!obj) return null;
  const engineBlock = obj.match(/\n  engine: \{([\s\S]*?)\n  \},/)?.[1];
  const hostBlock = obj.match(/\n  host: \{([\s\S]*?)\n  \},/)?.[1];
  const protocolBlock = obj.match(/\n  protocol: \{([\s\S]*?)\n  \},/)?.[1];
  const legacyBlock = obj.match(/\n  legacy: \{([\s\S]*?)\n  \},/)?.[1];
  if (!engineBlock || !hostBlock || !protocolBlock || !legacyBlock) return null;
  const fieldsBlock = engineBlock.match(/\n    fields: \{([\s\S]*)$/)?.[1];
  const engineFields = fieldsBlock
    ? [...fieldsBlock.matchAll(/^      ([A-Za-z][A-Za-z0-9_]*): \{$/gm)].map((m) => m[1])
    : null;
  const requiredBlock = protocolBlock.match(/\n    required: \[([^\]]*)\]/)?.[1];
  const required = requiredBlock
    ? [...requiredBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : null;
  const conditionalBlock = protocolBlock.match(/\n    conditional: \{([\s\S]*?)\n    \},/)?.[1];
  const conditional = conditionalBlock
    ? [...conditionalBlock.matchAll(/^      ([A-Za-z][A-Za-z0-9_]*): "/gm)].map((m) => m[1])
    : null;
  const reservedBlock = obj.match(/\n  reserved: \{([\s\S]*?)\n  \},/)?.[1];
  const reservedKeys = reservedBlock
    ? [...(reservedBlock.match(/\n    topLevelKeys: \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : null;
  const aliasBlock = legacyBlock.match(/\n    aliases: \{([\s\S]*?)\n    \},/)?.[1];
  const aliases = aliasBlock
    ? [...aliasBlock.matchAll(/^      (?:("[^"]+")|([A-Za-z][A-Za-z0-9_]*)): "([^"]+)"/gm)]
      .map((m) => ({ from: m[1] ? m[1].slice(1, -1) : m[2], to: m[3] }))
      .filter((a) => /^[A-Za-z][A-Za-z0-9_]*$/.test(a.from))   // 塔平宿主键那条是占位名，单独校
    : null;
  const out = {
    engineNs: engineBlock.match(/\bns: "([^"]+)"/)?.[1],
    hostNs: hostBlock.match(/\bns: "([^"]+)"/)?.[1],
    engineFields,
    required,
    conditional,
    reservedKeys,
    aliases,
    placeholderAlias: (() => {
      const m = legacyBlock.match(/^      "([^"]*<[^>]+>[^"]*)":\s*"([^"]+)"/m);   // "<host key>@top level": "metadata.<host key>"
      return m ? m[2] : null;
    })(),
  };
  const missing = Object.entries(out).filter(([, v]) => v === null || v === undefined || (Array.isArray(v) && !v.length));
  return missing.length ? { __incomplete: missing.map(([k]) => k).join("、"), ...out } : out;
}

/** 文档表格行：第一格里的反引号 token 就是声明的成员，第二格是拥有者。 */
function tableRowsByOwner(src, owners) {
  const rows = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("| `")) continue;
    const cells = line.replace(/^\|\s*/, "").replace(/\s*\|$/, "").split(/\s*\|\s*/);
    const owner = (cells[1] ?? "").replace(/[*_`]/g, "").trim().toLowerCase();
    if (!owners.includes(owner)) continue;
    rows.push({
      line: i + 1,
      snippet: line.trim().slice(0, 90),
      tokens: [...(cells[0] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]),
    });
  }
  return rows;
}

/** 「exactly five fields / 恰好五个字段」这类数量声明（中英各自一份句式，数字用词表展开）。 */
function engineFieldCountClaims(src) {
  const out = [];
  for (const m of src.matchAll(/(?:exactly|恰好)\s*([A-Za-z]+|[\u4e00-\u9fff])\s*(?:fields\b|个字段)/g)) {
    const word = m[1].toLowerCase();
    const n = EN_NUMERALS[word] ?? CN_NUMERALS[m[1]];
    out.push({ word: m[1], n, line: lineOf(src, m.index), snippet: snippetOf(src, m.index) });
  }
  return out;
}

/** 存在性矩阵的表头（第一格是「Case / 情形」那行）里的 `<ns>.<字段>` 列名（命名空间名也从常量拿）。 */
function existenceMatrixColumns(src, nsList) {
  const out = [];
  const lines = src.split("\n");
  const re = /\b([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\b/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\|\s*(?:Case|情形)\s*\|/i.test(line)) continue;
    const cols = [];
    const foreign = [];
    for (const m of line.matchAll(re)) {
      if (m[1] === nsList.engineNs || m[1] === nsList.hostNs) cols.push({ ns: m[1], field: m[2] });
      else foreign.push(`${m[1]}.${m[2]}`);
    }
    out.push({ cols, foreign, line: i + 1, snippet: line.trim().slice(0, 90) });
  }
  return out;
}

/** legacy 别名表：两格都是反引号 token 的行（「旧顶层键 | 新归属」）。 */
function legacyAliasRows(src) {
  const rows = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*$/);
    if (m) rows.push({ from: m[1], to: m[2], line: i + 1, snippet: lines[i].trim() });
  }
  return rows;
}

/** 别名表里「塔平宿主键」那一行：第一格是散文（占位键没有字面名），第二格是 `ns.<占位>`。 */
function hostFlattenAliasRows(src, hostNs) {
  const rows = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp("^\\|[^|`]*\\|\\s*`(" + esc(hostNs) + "\\.<[^>]+>)`\\s*\\|\\s*$"));
    if (m) rows.push({ to: m[1], line: i + 1, snippet: lines[i].trim().slice(0, 90) });
  }
  return rows;
}

/**
 * 保留键名的声明面（工单 261014 T1-fix 第 5 项）：按空行切段，段里既出现「保留 / reserved」
 * 这个说法、又用反引号点名词条里的键名，才算一处声明。只数「提到过这个名字」不算——
 * `metadata` / `erix` 在文档里到处都是，那样这条锚点会恒绿。
 */
function reservedKeyDeclarations(src, reservedKeys) {
  const out = [];
  let cursor = 0;
  for (const paragraph of src.split(/\n\s*\n/)) {
    const at = src.indexOf(paragraph, cursor);
    cursor = at < 0 ? cursor : at + paragraph.length;
    if (!/(保留|reserved)/i.test(paragraph)) continue;
    const tokens = [...paragraph.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const named = tokens.filter((token) => reservedKeys.includes(token));
    if (!named.length) continue;      // 说了一句「保留」但没点名任何保留键，不算一处声明
    out.push({ line: lineOf(src, at), snippet: paragraph.trim().slice(0, 90), tokens: named });
  }
  return out;
}

/** 命名空间前缀拆名：`erix.round` → {ns:"erix", field:"round"}；不带点的归为 ns:null。 */
function splitNs(token) {
  const i = token.indexOf(".");
  return i < 0 ? { ns: null, field: token } : { ns: token.slice(0, i), field: token.slice(i + 1) };
}

/**
 * 工具事实契约锚点的跑法（与 formatSize 那条同构：一个规则、多层断言）。
 * 每一面都是「逐处 + 双向」，另加中英声明点处数对账。
 */
function runToolFactRule(rule, out, notesOut) {
  const t = toolFactTruth(textOf(TOOL_FACT_SRC));
  const ruleId = `anchors/${rule.id}`;
  if (!t || t.__incomplete) {
    out.push(`${ruleId}: 在 ${TOOL_FACT_SRC} 里抽不全 TOOL_RESULT_CONTRACT 的真值`
      + `（缺：${t?.__incomplete ?? "整块常量"}）——源码形状变了，请同步更新本脚本（否则检查面静默失效）`);
    return;
  }
  // ④ 的期望集（写死的理由见本块顶部注释）：矩阵不给 `success` 开列。
  const matrixExpect = t.engineFields.filter((f) => f !== "success");
  const protocolExpect = [...t.required, ...t.conditional];
  const counts = { list: {}, rows: {}, count: {}, matrix: {}, alias: {} };
  for (const rel of rule.docs) {
    const src = textOf(rel);

    // ① 散文清单
    const lists = detectListClaims(src, { truth: t.engineFields });
    counts.list[rel] = lists.length;
    if (!lists.length) {
      out.push(`${ruleId}: ${rel} 找不到引擎字段清单声明（「以 \`${t.engineNs}.<field>\` 寻址：a / b / …」那一句）`
        + "——检查面在该文件已失效（要么把声明补回来，要么把它移出本规则的 docs）");
    }
    for (const c of lists) {
      assertSymmetric(out, {
        rule: `${ruleId} 字段清单`, where: `${rel}:${c.line}「${c.snippet}」`,
        truth: t.engineFields, doc: c.tokens, kind: rule.kind,
      });
    }

    // ② 字段归属表（engine / protocol / host 三类拥有者各自双向比）
    const engRows = tableRowsByOwner(src, ["engine", "引擎"]);
    const proRows = tableRowsByOwner(src, ["protocol", "协议"]);
    const hostRows = tableRowsByOwner(src, ["host", "宿主"]);
    counts.rows[rel] = engRows.length + proRows.length + hostRows.length;
    if (!engRows.length || !proRows.length || !hostRows.length) {
      out.push(`${ruleId}: ${rel} 的字段归属表不齐（engine ${engRows.length} 行 / protocol ${proRows.length} 行 / host ${hostRows.length} 行）`
        + "——Owner 列是这张表的锦定，被改掉就是检查面失效而不是「没声明」");
    }
    const declaredEngine = [];
    for (const r of engRows) {
      for (const tok of r.tokens) {
        const { ns, field } = splitNs(tok);
        if (ns !== t.engineNs) {
          out.push(`${ruleId}: ${rel}:${r.line}「${r.snippet}」把引擎字段写成 \`${tok}\`，而 ${TOOL_FACT_SRC} 的`
            + ` TOOL_RESULT_CONTRACT.engine.ns 是 "${t.engineNs}"（命名空间名就是那个值，文档得跟着改）`);
          continue;
        }
        declaredEngine.push(field);
      }
    }
    if (engRows.length) {
      assertSymmetric(out, {
        rule: `${ruleId} 字段归属表`, where: `${rel}:${engRows[0].line} 起的 ${engRows.length} 行`,
        truth: t.engineFields, doc: declaredEngine, kind: "引擎字段行",
      });
    }
    const declaredProtocol = proRows.flatMap((r) => r.tokens.filter((x) => !x.includes(".")));
    if (proRows.length) {
      assertSymmetric(out, {
        rule: `${ruleId} 协议字段行`, where: `${rel}:${proRows[0].line} 起的 ${proRows.length} 行`,
        truth: protocolExpect, doc: declaredProtocol, kind: "协议字段",
      });
    }
    for (const r of hostRows) {
      for (const tok of r.tokens) {
        if (splitNs(tok).ns !== t.hostNs) {
          out.push(`${ruleId}: ${rel}:${r.line}「${r.snippet}」把宿主命名空间写成 \`${tok}\`，而`
            + ` TOOL_RESULT_CONTRACT.host.ns 是 "${t.hostNs}"`);
        }
      }
    }

    // ③ 数量声明
    const nums = engineFieldCountClaims(src);
    counts.count[rel] = nums.length;
    if (!nums.length) {
      out.push(`${ruleId}: ${rel} 找不到「exactly N fields / 恰好 N 个字段」这类数量声明——检查面在该文件已失效`);
    }
    for (const c of nums) {
      if (c.n === undefined) {
        out.push(`${ruleId}: ${rel}:${c.line}「${c.snippet}」的数量词「${c.word}」不在词表里（词表外就是静默放行，补词表）`);
      } else if (c.n !== t.engineFields.length) {
        out.push(`${ruleId}: ${rel}:${c.line}「${c.snippet}」声称引擎命名空间有「${c.word}」个字段，而`
          + ` ${TOOL_FACT_SRC} 的 TOOL_RESULT_CONTRACT.engine.fields 是 ${t.engineFields.length} 个`
          + `（${t.engineFields.join("、")}）`);
      }
    }

    // ④ 存在性矩阵表头
    const matrices = existenceMatrixColumns(src, { engineNs: t.engineNs, hostNs: t.hostNs });
    counts.matrix[rel] = matrices.length;
    if (!matrices.length) {
      out.push(`${ruleId}: ${rel} 找不到存在性矩阵的表头行（「| Case | … |」/「| 情形 | … |」）——检查面在该文件已失效`);
    }
    for (const m of matrices) {
      for (const f of m.foreign) {
        out.push(`${ruleId}: ${rel}:${m.line}「${m.snippet}」的列 \`${f}\` 用的命名空间`
          + `既不是 TOOL_RESULT_CONTRACT.engine.ns（${t.engineNs}）也不是 host.ns（${t.hostNs}）`
          + "——命名空间名与字段名一样，是常量里的事实");
      }
      assertSymmetric(out, {
        rule: `${ruleId} 存在性矩阵列`, where: `${rel}:${m.line}「${m.snippet}」`,
        truth: matrixExpect,
        doc: m.cols.filter((c) => c.ns === t.engineNs).map((c) => c.field),
        kind: "矩阵列（引擎字段减去刻意不开列的 success）",
      });
    }

    // ⑤ legacy 别名表
    const aliasRows = legacyAliasRows(src);
    counts.alias[rel] = aliasRows.length;
    if (!aliasRows.length) {
      out.push(`${ruleId}: ${rel} 找不到 legacy 别名表行（「| \`旧顶层键\` | \`新归属\` |」）——检查面在该文件已失效`);
    }
    assertSymmetric(out, {
      rule: `${ruleId} legacy 别名表`, where: `${rel}${aliasRows.length ? `:${aliasRows[0].line} 起的 ${aliasRows.length} 行` : ""}`,
      truth: t.aliases.map((a) => a.from), doc: aliasRows.map((r) => r.from), kind: "旧顶层键",
    });
    for (const r of aliasRows) {
      const want = t.aliases.find((a) => a.from === r.from);
      if (want && r.to !== want.to) {
        out.push(`${ruleId}: ${rel}:${r.line}「${r.snippet}」把 \`${r.from}\` 的新归属写成 \`${r.to}\`，而常量里的别名是 \`${want.to}\``);
      }
      if (!want && !r.to.includes("<")) {
        out.push(`${ruleId}: ${rel}:${r.line}「${r.snippet}」的旧顶层键 \`${r.from}\` 在常量里没有对应别名条目`
          + `（已登记：${t.aliases.map((a) => a.from).join("、")}）`);
      }
    }
    if (t.placeholderAlias) {
      const ph = t.placeholderAlias.replace(/<[^>]+>/g, "");   // "metadata.<host key>" → "metadata."
      const flatRows = hostFlattenAliasRows(src, t.hostNs);
      if (!flatRows.some((r) => r.to.startsWith(ph))) {
        out.push(`${ruleId}: ${rel} 的别名表里没有「塔平宿主键 → \`${t.placeholderAlias}\`」那一行`
          + `（常量里有这条占位别名，文档侧必须有对应的描述行；只写两格反引号的形式不算，那个位置上没有字面键名）`);
      }
    }

    // ⑥ 保留键名（`legacyTopLevel` 摊平时被跳过的顶层键，工单 261014 T1-fix 第 5 项）：
    //    两侧文档都必须把「哪几个键名是保留的」说出口——少一个键名，宿主就会以为自己那个
    //    恰好同名的键被吃了却查不到原因；多一个键名，就是文档在承诺源码没做的事。
    const reservedDecls = reservedKeyDeclarations(src, t.reservedKeys);
    if (rel === rule.docs[0] && JSON.stringify([...t.reservedKeys].sort()) !== JSON.stringify([t.hostNs, t.engineNs].sort())) {
      out.push(`${ruleId}: ${TOOL_FACT_SRC} 自相矛盾——保留键名登记的是 ${t.reservedKeys.join(" / ")}，`
        + `但命名空间名是 ${t.hostNs} / ${t.engineNs}。保留的**就是**那两个命名空间本身，`
        + `两处不同源就说明有人只改了一处（构造器的过滤走的是登记那一份）`);
    }
    if (!reservedDecls.length) {
      out.push(`${ruleId}: ${rel} 找不到保留键名的声明（既要出现「保留 / reserved」这个说法，又要用反引号点名`
        + ` ${t.reservedKeys.map((k) => "`" + k + "`").join(" / ")}）——检查面在该文件已失效`);
    }
    assertSymmetric(out, {
      rule: `${ruleId} 保留键名`,
      where: `${rel}${reservedDecls.length ? `:${reservedDecls[0].line} 起的 ${reservedDecls.length} 段` : ""}`,
      truth: t.reservedKeys,
      doc: [...new Set(reservedDecls.flatMap((d) => d.tokens.filter((x) => t.reservedKeys.includes(x))))],
      kind: "保留键名",
    });
  }

  for (const [face, c] of Object.entries(counts)) {
    assertPairCensus(out, { rule: `${ruleId} ${face}`, counts: c, docs: rule.docs });
  }
  notesOut.push(`anchors: 「${rule.id}」真值 = ${t.engineNs}{${t.engineFields.join(", ")}} + 协议[${protocolExpect.join(", ")}]`
    + ` + 宿主 ${t.hostNs} + 别名[${t.aliases.map((a) => a.from).join(", ")}] + 保留键[${t.reservedKeys.join(", ")}]（${TOOL_FACT_SRC}），`
    + `声明面 ${JSON.stringify(counts)}（${rule.docs.join(" / ")}）`);
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
    // 工单 261014 T1（#284 / #285）：契约文档的 erix 字段清单 ↔ `TOOL_RESULT_CONTRACT` 常量。
    // 跑法整条自定义（见 runToolFactRule）：一份常量有**五个**声明面（引擎字段、命名空间名、
    // 协议必需字段、条件字段、legacy 别名表），不是单一一张清单。
    id: "工具事实字段清单（契约中英 ↔ TOOL_RESULT_CONTRACT）",
    kind: "引擎字段",
    src: TOOL_FACT_SRC,
    truth: (src) => toolFactTruth(src)?.engineFields ?? null,
    docs: [CONTRACT_EN, CONTRACT_CN],
    run: runToolFactRule,
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

// ── 2.8 锚点粒度升级（issue #286 T-a：B 方案第一批 = 符号锚点 + 裸行号棘轮）─────────
// 病根（#286，已确证，不重新论证）：`paths` 那条锚点在解析 `path:line` 引用时**主动剥掉行号**
// （`extractRefOccurrences` 里的 `p.replace(/:\d+(?::\d+)?$/, "")`），只校「文件存在吗」。
// ⇒ 行号漂到别的代码段、甚至漂出文件末尾，门禁全绿无人报警。确凿样本：契约说 `emitEvent` 在
// `src/loop/orchestrator.js:1517-1531`，真身在 1660 一带；`docs/host-consumer-contract.md` 与
// `_cn.md` 各有一处 `src/store/notes.js:398-405`，而该文件只有 383 行（越界）。
//
// 本节两条锚点（T-a 只做这两条，**不做批量替换**；存量裸行号的替换归 T-b/T-c）：
//   · 2.8.1 symbol-anchor：「符号 + 文件」形态的引用必须能在被引文件里抽到该符号的**声明**
//     （R1，issue #210 的逐处一致口径：每一处单独校，找不到就红并点名相近符号；抽不到真值也红）。
//   · 2.8.2 bare-lines：`path:N` / `path:N-M` 形态的**裸行号引用**只减不增（R2 棘轮 + R3 越界必红）。
//
// 覆盖面与正则（工单 #286 T-a 的口径，脚本自己会数——别只信注释，跑 `--verbose` 看 note）：
//   覆盖面 = 宿主会读的 20 份文档：README{,_cn}.md、AGENTS{,_cn}.md、docs/host-consumer-contract{,_cn}.md
//     这 6 份硬编码 + `docs/host-upgrade-guide*.md` 全部 14 份（按目录**实扫**：新增一份指南就自动纳面，
//     不存在「新文档漏在覆盖面外」的形状）。
//   正则 = BARE_LINE_RE（工单口径写的是 `src/**.js:N[-M]`；这里把前缀面放宽到 src|bin|scripts|test|docs|
//     examples|fixtures，因为 `bin/cli.js:88` 这类行号同样会漂，窄到 src/ 等于给未来的漂移留门）。
//     按工单那条只算 src/**.js 的口径实测：唯一 (文档,目标文件,行区间) **248** / 总出现 **279**
//     （契约 CN 138、契约 EN 137、0.17.0 指南 2、v030 指南中英各 1）；减去 4 处声明式豁免 ⇒ 棘轮基线 **244**。
//     放宽前缀后的实测数在 `--verbose` 的 note 里，基线常量的注释里也写了怎么复现。
//   `CHANGELOG.md` **不参与**：历史条目描述的是**当时**那份代码的行号，把它们改掉等于伪造历史
//     （同口径先例：#278 对 CHANGELOG 里的简称只登记不改写、#273 对历史条目逐条登记）。CHANGELOG 里
//     确实还有裸行号，它们仍由 `paths`（文件存在性）那条看守，只是不进棘轮面。
//
// 为什么 symbol-anchor **不做中英处数对账**（#210 R1 对逐处规则还额外要求中英对账，这里写明不做的理由）：
//   符号锚点的两侧数量**本来就不等**——契约 CN 的终止原因表比 EN 多写了几处机制说明，而 14 份升级指南里
//   有 8 份根本没有中文版。硬对账会逼着人为了凑数改措辞（#210 R3 警惕的「对措辞的绑架」）。
//   本条是**逐处真值**：每一处 (符号, 文件) 都单独与源码比，改错符号名/删掉声明都红；
//   处数只在 `--verbose` 里报，不做判据。真正的中英对账留给 T-b/T-c（存量被替换成符号锚点时，
//   中英两侧必须同步替换，那时数量才具备可比性）。

/** #286 T-a：覆盖面清单里被硬编码的那几份（升级指南按目录实扫，见 `refScanDocs()`）。 */
const SYMBOL_DOCS_STATIC = [README_EN, README_CN, AGENTS_EN, AGENTS_CN, CONTRACT_EN, CONTRACT_CN];

/** 覆盖面：宿主会读的 20 份文档 = 6 份硬编码 + `docs/host-upgrade-guide*.md` 全部（实扫，新增指南自动纳面）。 */
function refScanDocs() {
  const guides = readdirSync(path.join(ROOT, "docs"))
    .filter((f) => /^host-upgrade-guide.*\.md$/.test(f))
    .map((f) => `docs/${f}`)
    .sort();
  return [...SYMBOL_DOCS_STATIC, ...guides];
}

/** 行内代码形态的标识符（不是路径：干掉带 `/` 与 `.` 的东西）。 */
const INLINE_SYMBOL_RE = /`([A-Za-z_$][\w$]*)`/g;

/** **不是符号**的 JavaScript 字面量：它们出现在「值」的位置上，文档写 ``retry` 默认 `false`（`src/…`）``
 *  说的是「默认值长在哪个文件」，拿声明判据去问必然假红（`false` 在 orchestrator.js 里出现 102 次，
 *  却没有一条是声明）。这一档必须**逐个点名**，不许扩成正则去吞别的东西。 */
const SYMBOL_NOT_SYMBOL = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

/** 允许「具名字面量成员」当真理的引用文件（**逐份点名 + 写理由**）：这一档比声明弱一档，
 *  开给的是「文档在讲一个**字符串值**（终止原因 / 错误码），而该值就定义在被引文件里」的形状
 *  （`judge_done`、`provider_config`、`non_continuable`…）。逐文件点名而不是全仓开：
 *  全仓开等于把「同名字符串」当成通行票，#286 的病根正是这种宽进。条目空转 → 红。 */
const SYMBOL_VALUE_MEMBERSHIP = new Map([
  ["src/loop/orchestrator.js", "契约的终止原因表在这一列写「该 reason 由哪段代码产出」，被引符号里有相当一部分是 reason 字符串本身（`judge_done` / `no_final_guard` / `non_continuable`），不是变量名"],
  ["src/loop/termination.js", "同上：reason → errorCode 的映射表（`max_rounds_cap` 一类）在本文件里以字面量成员存在"],
  ["src/reflection/governor.js", "治理层的 stop 值（`completion` / `complete` / `noTool` / `cap`）是返回值字符串，契约表引的就是这些值"],
  ["src/providers/errors.js", "provider 错误码（`provider_config` 一类）以字符串成员定义"],
]);

/** 抽符号声明：逐行按「行首形态」匹配，返回 Map 名字 → 首次声明处。支持的形态就列在这里，
 *  报告与 AGENTS 的锚点分级段用同一份口径（够用即可，不做完整 AST——本仓零依赖，不引解析器）。 */
const SYMBOL_DECL_PATTERNS = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function"],
  [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, "binding"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+\{([^}]*)\}\s*=/, "解构绑定"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+\[([^\]]*)\]\s*=/, "解构绑定"],
  [/^\s*(?:export\s+)?\{([^}]*)\}\s*(?:;|$)/, "再导出"],
  [/^\s*(?:static\s+|get\s+|set\s+|async\s+|\*)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/, "方法"],
  [/^\s*(?:public\s+|private\s+|protected\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*:\s*(?![=:])/, "对象键/类字段"],
];

/* 文件文本的进程内缓存（#286 T-a）。`--self-test` 要跑 85 轮全量检查，每轮都重新读一遍
 * orchestrator.js（350KB）× 244 处引用，会把一条文档门禁拖到分钟级——那是「太慢所以会被跳过」的形状。
 * 口径：
 *   · 被 `--self-test` overlay 改过的文件**每次现读**（来源不同就必须重来，绝不吃缓存）；
 *   · 没被 overlay 的文件在本进程里只读一次——本脚本从头到尾是只读的，不存在自己改盘的路径；
 *   · 拆行与派生表（符号声明表、字面量集合）挂在同一条记录上，随文本一起失效——`--self-test` 会跑
 *     85 轮全量检查，每轮都把 350KB 的 `src/loop/orchestrator.js` 重拆一遍是把文档门禁拖到分钟级的错地方。
 * 早先的版本拿「长度 + 首尾 32 字」当文本身份，`src/a/b.js:12` → `src/a/c.js:12` 这种**等长**变异
 * 会命中旧缓存，自测里直接假绿（改了却不红）——所以身份判据必须是「是否被 overlay 覆盖」。 */
const FILE_LINE_CACHE = new Map();   // rel → { text, lines, decls, literals }

function fileRecord(rel) {
  const overlaid = OVERLAY.has(rel);
  const hit = FILE_LINE_CACHE.get(rel);
  if (hit && hit.overlaid === overlaid && (!overlaid || hit.text === textOf(rel))) return hit;
  let text;
  try { text = textOf(rel); } catch { return null; }
  const rec = { text, overlaid, lines: text.split("\n"), decls: null, literals: null };
  FILE_LINE_CACHE.set(rel, rec);
  return rec;
}

/** 文件的真实行数（末尾换行不是一行——`wc -l` 同口径，越界判据用它）；不存在返 null。 */
function fileLineCount(rel) {
  const rec = fileRecord(rel);
  if (!rec) return null;
  const n = rec.lines.length;
  return n > 1 && rec.lines[n - 1] === "" ? n - 1 : n;
}

function symbolDeclarations(rel) {
  const rec = fileRecord(rel);
  const lines = rec?.lines ?? null;
  if (!lines) return new Map();
  if (rec.decls) return rec.decls;
  const out = new Map();
  lines.forEach((line, i) => {
    for (const [re, kind] of SYMBOL_DECL_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const names = kind === "解构绑定" || kind === "再导出"
        ? m[1].split(",").map((p) => p.trim().split(/\s+as\s+/).pop().trim()).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
        : [m[1]];
      for (const n of names) if (n && !out.has(n)) out.set(n, { line: i + 1, kind });
    }
    // 环境变量：`process.env.ERIX_RETRY_ATTEMPTS` 被读的那一行就是它在 CLI 里的「定义处」（契约里
    // `ERIX_RETRY_ATTEMPTS`（`bin/cli.js:…`）引的就是它），不是声明语句，但同属「该文件里确有这个符号」。
    for (const m of line.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) {
      if (!out.has(m[1])) out.set(m[1], { line: i + 1, kind: "环境变量读取处" });
    }
  });
  rec.decls = out;
  return out;
}

/** 「具名字面量成员」那一档的真理：文件里出现过的字符串字面量内容（`"judge_done"` → `judge_done`）。
 *  只认整段字面量，不做「行里有这个词」那种宽判据。 */
function valueLiterals(rel) {
  const rec = fileRecord(rel);
  const lines = rec?.lines ?? null;
  if (!lines) return new Set();
  if (rec.literals) return rec.literals;
  const out = new Set();
  for (const line of lines) {
    for (const m of line.matchAll(/(["'])([A-Za-z_$][\w$]*)\1/g)) out.add(m[2]);
  }
  rec.literals = out;
  return out;
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** 找不到符号时点名「该文件里实际存在相近符号名」（#210/#286 口径：报错要能指路）。
 *  判据：互为前缀、互为子串、或编辑距离 ≤ 2（大小写折叠后）。最多报 5 个，按接近程度排。 */
function nearestSymbols(sym, decls) {
  const low = sym.toLowerCase();
  const scored = [];
  for (const [name, d] of decls) {
    const n = name.toLowerCase();
    let score = null;
    if (n === low) continue;
    if (n.startsWith(low) || low.startsWith(n)) score = 0;
    else if (n.includes(low) || low.includes(n)) score = 1;
    else if (editDistance(n, low) <= 2) score = 2;
    if (score !== null) scored.push({ score, text: `${name}（${d.kind} @ ${d.line}）` });
  }
  return scored.sort((a, b) => a.score - b.score || a.text.localeCompare(b.text)).slice(0, 5).map((s) => s.text);
}

/** 「符号 + 文件」的两种形态（`SYM`（`path`）与 markdown 链接）。提成模块级常量，是因为自测的
 *  打靶器 `mutateSymbolAnchor()` 必须与主检查用**同一套**提取逻辑（#279 的口径：打靶由提取逻辑定）。 */
const SYMBOL_ANCHOR_FORMS = [
  // `SYM`（`path`） / `SYM` (`path`) —— 全角半角括号都接，允许中间一个空格。
  // 允许带 :N / :N-M 行号后缀：带行号的「符号 + 文件」仍然是符号锚点（符号部分照校），
  // 行号部分则同时进 2.8.2 的裸行号棘轮——一条写法被两条锚点分别看守，互不掩盖。
  { re: /`([A-Za-z_$][\w$]*)`\s*[（(]\s*`([A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts))(?::\d+(?:-\d+)?)?`\s*[)）]/g, kind: "括号并列" },
  // [SYM](path) / [`SYM`](./path#anchor)
  { re: /\[`?([A-Za-z_$][\w$]*)`?\]\(\.?\/?([A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts))(?:#[^)]*)?\)/g, kind: "markdown 链接" },
];

/** 抽一份**文本**里的符号锚点，带 span（字符区间只覆盖**符号名本身**），供自测定点变异。 */
function symbolAnchorsInText(text, doc) {
  const found = [];
  let lineStart = 0;
  for (const [i, line] of text.split("\n").entries()) {
    for (const [fi, f] of SYMBOL_ANCHOR_FORMS.entries()) {
      f.re.lastIndex = 0;
      for (const m of line.matchAll(f.re)) {
        const sym = m[1];
        if (SYMBOL_NOT_SYMBOL.has(sym)) continue;          // JavaScript 字面量不是符号（见上面名单的理由）
        if (m[2].endsWith(".d.ts")) continue;              // 生成物声明文件不入库（#213），拿它当被引文件必然假红
        const lead = fi === 0 ? 1 : 1 + (m[0][1] === "`" ? 1 : 0);   // 前导的 `[` 与可选反引号
        found.push({
          doc, line: i + 1, sym, file: m[2], form: f.kind,
          start: lineStart + m.index + lead, end: lineStart + m.index + lead + sym.length,
        });
      }
    }
    lineStart += line.length + 1;
  }
  return found;
}

/** 抽覆盖面里的符号锚点（按文档走 `textOf`，所以 `--self-test` 的内存副本被同一套逻辑扫）。
 *  返回每一处出现（不去重，逐处报）；报错时按 (符号, 文件) 归并成一条，点名所有引用处。 */
function symbolAnchorOccurrences(docs) {
  const found = [];
  for (const rel of docs) {
    const rec = fileRecord(rel);
    if (!rec) continue;
    found.push(...symbolAnchorsInText(rec.text, rel));
  }
  return found;
}

/** #286 T-a 自测的打靶器：把「符号 = `sym`、被引文件 = `filePath`」的**全部**锚点处的符号名换成 `to`。
 *  一处都没命中、或换完还剩着 → 原样返回，`runSelfTest` 的「变异没落上」判据就会报红（不给空跑假绿留门）。 */
function mutateSymbolAnchor(sym, filePath, to) {
  return (text) => {
    const hit = (t) => symbolAnchorsInText(t, "probe").filter((a) => a.sym === sym && a.file === filePath);
    const hits = hit(text).sort((a, b) => b.start - a.start);
    if (!hits.length) return text;
    let t = text;
    for (const h of hits) t = t.slice(0, h.start) + to + t.slice(h.end);
    return hit(t).length ? text : t;     // 该锚点还剩着 → 这一枪没打全，同样算没落上
  };
}

/** R1 判据：符号在被引文件里确有声明（或落在点名文件的「具名字面量成员」档）。 */
function symbolAnchorVerdict(sym, rel) {
  const lines = fileRecord(rel)?.lines ?? null;
  if (!lines) return { ok: false, missing: true };
  const decls = symbolDeclarations(rel);
  if (decls.size === 0) {
    return { ok: false, failure: true, why: "从被引文件里**抽不到任何符号声明**——检查面在该文件上失效（#164 口径：抽不到真值就报错，不许静默放行）" };
  }
  const hit = decls.get(sym);
  if (hit) return { ok: true, tier: `${hit.kind} @ ${hit.line}` };
  if (SYMBOL_VALUE_MEMBERSHIP.has(rel) && valueLiterals(rel).has(sym)) return { ok: true, tier: "具名字面量成员（点名文件一档）" };
  const near = nearestSymbols(sym, decls);
  return { ok: false, near, why: `该文件里没有 \`${sym}\` 的声明（支持的形态：function / class / const|let|var 绑定 / 解构绑定 / 再导出 / 方法 / 对象键、类字段 / process.env.X 环境变量读取处）` };
}

function collectSymbolAnchorErrors() {
  const out = [];
  const notes = [];
  const docs = refScanDocs();
  const occurrences = symbolAnchorOccurrences(docs);
  const groups = new Map();
  for (const o of occurrences) {
    const key = `${o.sym}|${o.file}`;
    if (!groups.has(key)) groups.set(key, { ...o, sites: [] });
    groups.get(key).sites.push(`${o.doc}:${o.line}`);
  }
  let literalTier = 0;
  let truthFailure = 0;
  for (const g of groups.values()) {
    const v = symbolAnchorVerdict(g.sym, g.file);
    if (v.ok) {
      if (v.tier.startsWith("具名字面量")) literalTier += 1;
      continue;
    }
    if (v.missing) {
      out.push(`symbol-anchor: ${g.sites.join(", ")} 引用 \`${g.sym}\`（\`${g.file}\`），但 ${g.file} 在本仓不存在——`
        + `符号锚点的真理在被引文件里，文件没了这条锚点就是死的（改路径或删锚点，不许留）`);
      continue;
    }
    if (v.failure) {
      truthFailure += 1;
      out.push(`symbol-anchor: ${g.sites.join(", ")} 引用 \`${g.sym}\`（\`${g.file}\`），${v.why}`);
      continue;
    }
    out.push(`symbol-anchor: ${g.sites.join(", ")} 引用 \`${g.sym}\`（\`${g.file}\`，${g.form}），${v.why}${v.near?.length ? `\n      ↳ ${g.file} 里实际存在的相近符号：${v.near.join(" / ")}` : ""}`);
  }
  const byFile = {};
  for (const o of occurrences) byFile[o.doc] = (byFile[o.doc] ?? 0) + 1;
  notes.push(`symbol-anchor: 覆盖面 ${docs.length} 份文档里「符号 + 文件」锚点 ${occurrences.length} 处（唯一 (符号, 文件) ${groups.size} 组：${Object.entries(byFile).map(([d, n]) => `${d} ${n}`).join("、") || "（无）"}）；` + `其中「具名字面量成员」一档 ${literalTier} 组（引用文件已逐份点名，见 SYMBOL_VALUE_MEMBERSHIP）、抽不到真值 ${truthFailure} 组`);
  collectSymbolAnchorErrors.notes = notes;
  return out;
}

// ── 2.8.2 裸行号棘轮（issue #286 T-a：#286 B 方案第一批，**只减不增**）───────────
// 病根：`paths` 那条锚点在解析 `path:line` 时**主动剥掉行号**（`extractRefOccurrences` 里的
// `p.replace(/:\d+(?::\d+)?$/, "")`），只校文件是否存在 ⇒ 行号漂到别的代码段、甚至漂出文件末尾，
// 门禁全绿无人报警。确凿样本（#286）：契约说 `emitEvent` 在 `src/loop/orchestrator.js:1517-1531`，
// 真身在 1660 一带；中英契约各一处 `src/store/notes.js:398-405` 而该文件只有 383 行（越界）。
// 本单**不做批量替换**（那是 T-b/T-c）：先把「还剩多少」钉成一个只减不增的数，
// 再把已经确证的 2 处越界改掉。T-b/T-c 把存量换成符号锚点后，实测数会往下走，
// 那时降基线必须写理由（与本仓 `check:types` 的 `BASELINE_ROOT` 同构）。
/** 裸行号引用（`path:N` / `path:N-M`）的正则；覆盖面与 2.8.1 同一批文档（同一份理由）。
 *  实测值不靠注释：`--verbose` 会把「唯一区间数 / 出现次数 / 豁免数」打进 note（工单口径的三个数是
 *  248 / 279 / 基线 244，note 里应该逐字对得上）。非 `src/` 前缀（`bin/cli.js:88`、`test/x.js:9`）
 *  同样会漂，但本批把覆盖面钉在工单那条正则上，扩前缀归 T-b（扩时要重新登记基线）。
 *  唯一 (文档, 目标文件, 行区间) 与工单口径可复现：脚本自己数出来的数在下面那条 note 里，别只信注释。 */
const BARE_LINE_RE = /src\/([A-Za-z0-9_./-]+\.js):(\d+)(?:-(\d+))?/g;
/** 棘轮基线（工单 #286 T-a 口径）：唯一 (文档, 目标文件, 行区间) 实测 248，减去 4 处声明式豁免 ⇒ **244**。
 *  降它必须写理由；抬它必须写「为什么这次允许变差」。**不许悄悄抬**（同 `check:types` 棘轮的纪律）。
 *  写法必须保持 `const BARE_LINE_REF_BASELINE = <数字>;` 一行（自测的「调低就红」用例要能改这个数）。 */
const BARE_LINE_REF_BASELINE = 244;

/** 棘轮生效值：从**本脚本自己的文本**里读 `BARE_LINE_REF_BASELINE`（走 `textOf`，所以 `--self-test`
 *  能把这个常量临时改小来证「它真的是锁」：调低到低于实测值必须红，改回来必须绿）。
 *  读不到（常量被删/改格式）= 检查面失效 → 返 null，调用侧按 #164 口径报红，不静默放行。 */
function bareLineBaseline() {
  const rec = fileRecord("scripts/docs-drift-check.mjs");
  const m = rec?.text.match(/^const BARE_LINE_REF_BASELINE = (\d+);/m);
  return m ? Number(m[1]) : null;
}

/** 声明式豁免（**条目 + 就地声明**双条件，缺一个不放行；命中要计数，条目空转就红）。
 *  沿用 #286 已落在 `test/static-guards.test.js` 的 `LOCAL_ARCHIVE_DIRS` + `LOCAL_ARCHIVE_DECLARATION` 口径，
 *  不另造一套。这里能进来的只有「目标文件本来就不存在」的示例/外仓路径：4 处，全部逐条点名。
 *  判据函数 `bareLineExemptionVerdict()` 是纯函数，反向证直接拿它问。 */
const BARE_LINE_EXEMPTIONS = [
  {
    doc: "docs/host-consumer-contract.md",
    target: "src/a/b.js",
    decl: /…|示例|示意|举例|例如|for example|placeholder|虚构/,   // 引用行末尾的 `…` 就是「这是格式样例里的占位值」的声明
    why: "契约的折叠摘要一节举的**锚点索引格式样例**（`src/a/b.js:12` 是本仓不存在的示意路径，同行还有 `shas: 1ed3f35, …`），不是引用；就地声明 = 行末的省略号占位符",
  },
  {
    doc: "docs/host-consumer-contract_cn.md",
    target: "src/a/b.js",
    decl: /…|示例|示意|举例|例如|for example|placeholder|虚构/,
    why: "同 EN 侧：CN 契约同一处举的示例锚点，中英成对，条目也必须成对",
  },
  {
    doc: "docs/host-upgrade-guide-v030.md",
    target: "src/pi/runner.js",
    decl: /apps\/worker\/|app_container/,      // 引用行写的就是宿主仓的**完整路径** `apps/worker/src/pi/runner.js:50`，不是本仓根相对路径
    why: "宿主 app_container 仓的调用点（原文写全路径 apps/worker/src/pi/runner.js:50），不是本仓文件；就地声明 = 行里带着外仓根 apps/worker/",
  },
  {
    doc: "docs/host-upgrade-guide-v030_cn.md",
    target: "src/pi/runner.js",
    decl: /apps\/worker\/|app_container/,           // 与 EN 侧同一段（中文句子，但路径字面量同样写全）
    why: "同 EN 侧：0.2.0 指南的宿主基线配置段，指的是 app_container 仓自己的调用点",
  },
];

/** 纯函数判据（#286 口径：条目与声明缺一不可，缺任何一个都不放行）。 */
function bareLineExemptionVerdict({ doc, target, lineText }) {
  const entry = BARE_LINE_EXEMPTIONS.find((e) => e.doc === doc && e.target === target);
  if (entry === undefined) return { exempt: false, why: "没有对应的豁免条目" };
  if (!entry.decl.test(lineText)) {
    return { exempt: false, why: "引用行没有「示例/示意/宿主」这类就地声明", entry };
  }
  return { exempt: true, entry };
}

function collectBareLineRefErrors() {
  const out = [];
  const notes = [];
  const docs = refScanDocs();
  const unique = new Map();   // `${doc}|${target}|${from}-${to}` → { doc, line, target, from, to }
  const exemptHits = new Set();
  let occurrences = 0;
  for (const rel of docs) {
    const rec = fileRecord(rel);
    if (!rec) continue;
    rec.lines.forEach((line, i) => {
      BARE_LINE_RE.lastIndex = 0;
      for (const m of line.matchAll(BARE_LINE_RE)) {
        occurrences += 1;
        const target = `src/${m[1]}`;
        const from = Number(m[2]);
        const to = m[3] ? Number(m[3]) : null;
        const key = `${rel}|${target}|${from}-${to}`;
        if (!unique.has(key)) unique.set(key, { doc: rel, line: i + 1, target, from, to });
        const v = bareLineExemptionVerdict({ doc: rel, target, lineText: line });
        if (v.exempt) exemptHits.add(`${rel}|${target}`);
      }
    });
  }
  // R3 越界必红（工单 #286 T-a：不是观察项）
  for (const u of unique.values()) {
    const v = bareLineExemptionVerdict({ doc: u.doc, target: u.target, lineText: (fileRecord(u.doc)?.lines ?? [])[u.line - 1] ?? "" });
    if (v.exempt) continue;
    const count = fileLineCount(u.target);
    if (count === null) continue;              // 目标文件不存在：由 symbol-anchor / paths 那一条点名，这里不重复报
    const hi = Math.max(u.from, u.to ?? 0);
    if (hi > count) {
      out.push(`bare-lines: ${u.doc}:${u.line} 引用 ${u.target}:${u.from}${u.to ? `-${u.to}` : ""}，但该文件只有 ${count} 行——` + `行号已越界（#286 的裸行号漂移就是这种形状：门禁过去把行号剥掉只看文件在不在，所以全绿）`);
    } else if (u.to !== null && u.to < u.from) {
      out.push(`bare-lines: ${u.doc}:${u.line} 引用 ${u.target}:${u.from}-${u.to} 的区间是反的（结尾小于开头）`);
    }
  }
  // 豁免条目反向校：条目没被任何一处引用用上 = 给未来的漂移留后门（同 #273/#278 的白名单口径）
  for (const e of BARE_LINE_EXEMPTIONS) {
    if (!exemptHits.has(`${e.doc}|${e.target}`)) {
      out.push(`bare-lines: 豁免条目 \`${e.target}\`（${e.doc}）没有一处引用真正用到它——要么引用已改对/已删，` + `要么就地声明那句话被改掉了；留着就是给未来的裸行号留后门（条目 + 声明双条件，缺一不可）`);
    }
  }
  // 棘轮：只减不增。基线从脚本自己的文本里读（`bareLineBaseline()`），自测才能拿「改小就红」证它是锁。
  const baseline = bareLineBaseline();
  if (baseline === null) {
    out.push("bare-lines: 从 scripts/docs-drift-check.mjs 自己的文本里抽不到 `const BARE_LINE_REF_BASELINE = <数字>;`——"
      + "棘轮常量被删或改了写法，棘轮失效（#164 口径：抽不到真值就报错，不许静默放行）");
  }
  const measured = unique.size - exemptHits.size;
  const docsSeen = {};
  for (const u of unique.values()) docsSeen[u.doc] = (docsSeen[u.doc] ?? 0) + 1;
  if (baseline !== null && measured > baseline) {
    out.push(`bare-lines: 裸行号引用（唯一 (文档,目标文件,行区间)）实测 **${measured}** 处，超过棘轮基线 **${baseline}** 处——` + `新增裸行号\u8981么改成「符号 + 文件」锚点（#286 B 方案），要么写明「这次确实允许变差」并把基线改成 ${measured}。` + `分布：${Object.entries(docsSeen).sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} ${n}`).join("、")}`);
  } else if (baseline !== null && measured < baseline) {
    notes.push(`bare-lines: 实测 ${measured} 处 < 基线 ${baseline} 处——存量在变少，请把 BARE_LINE_REF_BASELINE 降到 ${measured}（降基线要写理由，棘轮不许空转）`);
  }
  notes.push(`bare-lines: 覆盖面 ${docs.length} 份文档里裸行号引用 ${occurrences} 次出现 / 唯一 (文档,目标文件,行区间) ${unique.size} 处，` + `其中声明式豁免 ${exemptHits.size} 处（${BARE_LINE_EXEMPTIONS.length} 条条目）⇒ 棘轮口径实测 **${measured}** vs 基线 ${baseline}`);
  collectBareLineRefErrors.notes = notes;
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
  ["analysis.md", "#269 复盘：这条引用本身就是「不存在的文件」，CHANGELOG:102 在讲它为什么不存在（#278 把它纳进裸名裁决后必须登记）"],
  ["session-meta.json", "宿主 `~/.erix/session-meta.json`（#168 停读停写的会话归属状态文件），CHANGELOG:158 讲的是宿主侧行为"],
  ["models.json", "宿主 `~/.pi/agent/models.json`（provider 槽位配置），CHANGELOG:200-201 的 e2e 根因在宿主配置里"],
  ["recall.js", "CLI recall 工具的文件名（f26ea47 已移除，CHANGELOG:889 记的就是移除）"],
  ["nonce.json", "复验脚本临时写的 nonce 文件名（docs/research/2026-09-13-notes-why.md:1468 的 CLI 复验口径），不是仓库文件"],
  ["2026-10-09-architecture-review.md", "运行时输出文件名（任务单写的日期），落地到仓库时改名成 docs/design/2026-10-08-architecture-review.md，所以这个名字本仓不存在"],
  ["transcript.json", "erix run 写进宿主输出目录的 transcript 文件名（host-upgrade-guide-v030 中英 :94/:99 讲的是宿主怎么读它），不是仓库文件"],
  ["checkpoint-executor.js", "0.x 时代的 `src/loop/checkpoint-executor.js`（ADR-015 之后已拆掉），docs/design/2026-09-17:25 写当时落点时引的；文档在讲历史，所以登记"],
  ["console.log", "CHANGELOG:22 写的是 JS 调用形式 `console.log(...)`，不是文件路径——它被 .gitignore 的 `*.log` 顺手接住了，所以必须在这里写清它不是路径，而不是假装不存在"],
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
  // —— 以下是 #278 把「无斜杠裸名」纳进裁决面后暴露的上游/宿主裸名引用（逐条写归属）——
  ["parent-wake.js", "上游 pi-subagents 的 `src/shared/parent-wake.js`（CHANGELOG:105 与 docs/research/2026-10-13:121 都用裸名指它）；本层同名物是 `erix-run-parent-wake.js`"],
  ["notify.js", "上游 pi-subagents 的唤醒侧文件（CHANGELOG:144、docs/research/2026-10-13:82 引它的常量行号 `notify.js:19`）"],
  ["async-execution.js", "上游 pi-subagents 的 `src/runs/background/async-execution.js`（docs/research/2026-10-13:119 用裸名引它的 `spawn` 行）"],
  ["debug.routes.js", "宿主 touwaka 仓的 Express 路由文件（docs/research/2026-09-26:118 的人工对质源码结论）"],
  ["expert.routes.js", "宿主 touwaka 仓的 Express 路由文件（同上，同一行第二条结论）"],
  ["init-database.js", "宿主 touwaka 仓的建表脚本（docs/host-upgrade-guide-0.17.0.md:193 与 CHANGELOG:260 的迁移对照）"],
  ["upgrade-database.js", "宿主 touwaka 仓的迁移脚本（docs/host-upgrade-guide-0.17.0.md:194 与 CHANGELOG:260）"],
  ["llm-context-budget.md", "宿主 touwaka 仓里的设计档案（docs/requirements 中英 :12 引它 §7「not changed this cycle」），本仓不镜像"],
  ["skill.mjs", "技能目录的**约定入口名**（ADR-008 / docs/decisions/014 / harness-comparison 中英讲的是约定，不是某个具体文件）；本仓实物是 examples/skills/getTime/skill.mjs 与 examples/skills/todo/skill.mjs 两个，拿裸名指它俩属于约定名不是路径"],
]);
/** ③ 生成物：由命令产出、被 .gitignore 忽略，仓库里没有是预期的。**模式**级条目（一文件一条会造出
 *  63 条同义自述），但每条都带 why 并与 .gitignore 互校：匹配了模式却不被忽略 → 红。 */
const GENERATED_ARTIFACT_REFS = [
  { re: /^(?:\.\.?\/)?src\/[\w./-]*\.d\.ts$/, why: "`npm run types:build` / `prepack` 生成的公共面声明产物（.gitignore 的 `src/**/*.d.ts`）；仓库不提交是 #213 的既定选择" },
  { re: /^(?:\.\.?\/)?package-lock\.json$/, why: "本仓历史上没有 lockfile，加它属于另一个决定（.gitignore 里写了 issue #213）" },
];
/** ⑤ 文档里的**简称/歧义名**：作者用短名指本仓某个真实存在的文件（`format.js` 指 `erix-run-format.js`、
 *  `notes.js` 在 CHANGELOG 里指 `src/store/notes.js`）。与 ①②③④ 的区别是它既不是路径也不是外物，
 *  而是「同一实物的另一个名字」（或本仓多个同名文件里的某一个），所以每条必须给出实物，并被**双向校**：
 *  简称没被任何引用用到 → 红；实物现在解不到了（改名/删了）→ 红。 */
const SHORTHAND_REFS = new Map([
  ["format.js", { real: ["examples/pi-extension/erix-run-format.js"], why: "CHANGELOG:92-93 讲 #276 死分支时对 `erix-run-format.js` 的简称（历史条目不改写，故登记简称↔实物对应关系）" }],
  ["core.js", { real: ["examples/pi-extension/erix-run-core.js"], why: "CHANGELOG:146 讲 #234 异步面时对 `erix-run-core.js` 的简称（同上）" }],
  ["notes.js", { real: ["src/store/notes.js", "src/tools/notes.js"], why: "CHANGELOG:42 讲 #270 公共闭包计数时的简称；本仓确实有两个 `notes.js`，拿裸名指它俩的全体（歧义必须写清，历史条目不改写故登记）" }],
  ["anthropic.js", { real: ["src/providers/anthropic.js"], why: "CHANGELOG:180 与 docs/design/2026-10-08:28 讲类型错误分布时对 `src/providers/anthropic.js` 的简称（同段的 `src/messages/anthropic.js` 是另一个同名文件，裸名指前者）" }],
]);
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

/* ────────────────────────────────────────────────────────────────────────────────
 * #278：无斜杠的**裸文件名**引用（`repro-circular-details.mjs`、`e2e-wake.mjs`）
 * 修前：这类引用只有在「拼写恰好对 + 已在 LOCAL_ARCHIVE_REFS 登记」的那一瞬间才被看守——
 *   改坏拼写 → 脱离登记表 → 通用提取不认无斜杠名 → 静默放行（#273 那个「整目录豁免」换了个形式）。
 *   主 agent 的三个探针：删登记 → exit 1；改坏**已登记**裸名 → exit 0；改坏**未登记**裸名 → exit 0。
 *
 * 量与分类（在 HEAD ca6ed55 上实测，脚本 `--bare-census` 可复现；后人不要只信注释）：
 *   全仓已跟踪 .md 里「无斜杠 + 带扩展名 + 解不到 + 未登记未声明」的裸名引用共 **105 处 / 58 个唯一名**，其中
 *     · 跳仓引用（正文在讲另一个仓库/宿主安装物，如 MEMORY.md / output-accumulator.js / init-database.js）： **79 处**，全部落在下面 CROSS_REPO_DOCS 那 10 份文档里；
 *     · 本仓档案/历史简称/运行期产物名（analysis.md / format.js / session-meta.json / e2e-wake.mjs 这类）： **26 处**，落在 CHANGELOG 与 docs/{research,design} 里。
 *   所以裁决面按**文档**切：CROSS_REPO_DOCS 里的裸名不裁决（那本不是本仓路径，逐名登记 79 次只会造出 40 条会腐朽的白名单）；
 *   其余文档（PATH_DOCS + 本仓 research/design + 根 CHANGELOG）的裸名全部走同一套四类裁决。
 *   CROSS_REPO_DOCS 是**逐份点名**（无目录通配）+ 一句理由 + 反向校（不再有任何引用用到它 → 红）；条目数超 12 需上报。
 * ──────────────────────────────────────────────────────────────────────────────── */

/** 「像个文件」闸（裸名专用）：无斜杠 + 名字干以字母数字开头且 ≥ 4 字符 + 扩展名在已知集合里。
 *  拦掉的全是**不是引用**的东西：`.js` / `.d.ts`（扩展名残片，名字干为空或以 `.` 开头）、
 *  `_cn.md`（文件名后缀片段）、`gen.sh`（3 字干，太短，拿它当实物近邻只会假红）、
 *  `details`（无扩展名）、`scratch/`（带斜杠，走目录规则）。宁可少拦，不可把真引用挡在门外。 */
const BARE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.(?:js|mjs|cjs|ts|mts|tsx|json|md|sh|log|txt|ya?ml|py|zip|lock|diff)$/;
const BARE_STEM_MIN = 4;   // 「像个文件」闸的名字干最短长度
/** 近邻判据另开一个更高的门槛：**名字干 ≥ 8 字符才启用**。`index.js` / `skill.mjs` / `judge.log`
 *  这类 5 字干的词是「约定入口名 / 常见词」，它们跟本仓任何同字干的实物都能配一对，
 *  拿它们当「被改坏的实物名」必然假红；而真实的改名事故（`repro-circular-details` 20 字、
 *  `e2e-wake` 8 字）名字干都够长。这条常数写死，不做可调的模糊阈值。 */
const NEAR_STEM_MIN = 8;

/** 近邻判据（只抓「把本仓实物的名字改坏了一个尾巴」这一形状，不调模糊阈值）：
 *  去扩展名后的 basename 与本仓某实物（**含被 .gitignore 忽略的实物**，如 docs/tasks/ 下的实测件）的
 *  同名干满足以下之一——全仓生效（包括跳仓文档）：
 *    ① 完全相等（换了扩展名，如 `e2e-wake.mjs` → `e2e-wake.md`）；
 *    ② 互为前缀且长出来的那段 ≤ 3 个字符（`repro-circular-details` → `...X` / `...-v2` 这种改名）。
 *  **区分大小写**：`MEMORY.md` ↔ `src/store/memory.js` 不是改名，拿大小写折叠去比会把
 *  harness-comparison 里的跳仓名全部误红（实测 20 处假红）。 */
function bareNameNearest(p, ign) {
  const stemOf = (x) => path.posix.basename(x).replace(/\.[^.]+$/, "");
  const c = stemOf(p);
  if (c.length < NEAR_STEM_MIN) return [];
  const { tracked, ignored } = repoFiles(ign);
  const base = path.posix.basename(p);
  const out = [];
  for (const f of [...tracked, ...ignored]) {
    const s = stemOf(f);
    if (s.length < NEAR_STEM_MIN) continue;
    //  basename 一字不差地存在 → 那是「同名歧义」而不是「改坏了名字」，走歧义那条报，不算近邻。
    if (path.posix.basename(f) === base) continue;
    if (s === c) out.push(`${f}（同名字干、只换了扩展名）`);
    else if (c.startsWith(s) && c.length - s.length <= 3) out.push(`${f}（比实物名字干多写了 “${c.slice(s.length)}”）`);
    else if (s.startsWith(c) && s.length - c.length <= 3) out.push(`${f}（比实物名字干少了 “${s.slice(c.length)}”）`);
  }
  return [...new Set(out)];
}

/** 无斜杠裸名走通用四类裁决的文档（= 已跟踪 .md 减去 CROSS_REPO_DOCS）。新增文档默认纳面，
 *  要豁免只能进 CROSS_REPO_DOCS 点名写理由——不允许默默放行。 */
const BARE_NAME_ADJUDICATED = true;   // 开关只为了 self-test 里能跑「扩面前后」对比，不是豁免开关

/** 跳仓/宿主对照文档：**逐份**点名（禁止目录通配）+ 一句理由。这里的裸名不裁决（它们指的不是本仓实物），
 *  但条目本身被反向校：这份文档里已经没有任何裸名需要被豁免 → 红（防条目烂在那里）。 */
const CROSS_REPO_DOCS = new Map([
  ["docs/harness-comparison/01-pi-agent.md", "整篇在拆上游 pi 发行包的 dist/ 与源码，裸名是它的文件（output-accumulator.js、bash-executor.js…）"],
  ["docs/harness-comparison/02-touwaka.md", "整篇在拆宿主 touwaka 仓，裸名是它的源码文件（full-organizer.js、skill-runner.js…）"],
  ["docs/harness-comparison/03-codex.md", "整篇在拆上游 codex CLI，裸名是它的记忆目录产物（memory_summary.md、MEMORY.md…）"],
  ["docs/harness-comparison/04-hermes-agent.md", "整篇在拆上游 hermes-agent，裸名是它的指令文件与记忆文件（CLAUDE.md、USER.md…）"],
  ["docs/harness-comparison/06-cross-comparison.md", "五方横向对照表，裸名来自被对照的各仓，不指本仓实物"],
  ["docs/harness-comparison/07-takeaways-and-open-questions.md", "结论页引用的是被对照仓自己的档案（如 tw 自己补的 chat-memory-boundaries.md）"],
  ["docs/harness-comparison/08-runtime-erix-battery.md", "沙箱脚本清单（/tmp/erix-battery 下的 gen.sh 等），不是仓内文件"],
  ["docs/harness-comparison/README.md", "对照系列的导读页，结论里提的 MEMORY.md 属于被对照的各仓"],
  ["docs/eval/2026-09-18-erix-060-real-project-eval.md", "对宿主 touwaka 快照做运行时评估的记录，裸名是被评项目自己的文件（utils-id.test.js、message.controller.js…）"],
  ["docs/suggestions/03-cli-edit-tool.md", "建议稿引用的是上游 pi 仓 packages/coding-agent/src/core/tools/ 下的参考设计（edit-diff.ts）"],
]);

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
 *  但安装位置与工作副本剪掉（node_modules/ 与 .worktrees/ 里是一整份别的仓库，钻进去又慢又脏）。
 *
 * `SIM_ABSENT_TASK_ARCHIVE`（#280，只给 `--self-test` 用，**不是豁免开关**）：把「本机根本没有任务档案
 * 目录」这一**树形**模拟出来 = 全新 clone / CI / 一次性沙箱。实物只从两个地方渗进裁决——`resolveRef`
 * 的裸名同名索引与 `bareNameNearest` 的实物清单——两处都读这份清单的 `ignored` 那一半，所以在这里
 * 把 task-archive 类目录下的文件摘掉就等于「那个目录整目录不在」。声明一侧（.gitignore 规则、就地声明、
 * 登记表）一个字都不动：要证的正是「裁决只依赖声明时，有实物与没实物两种树形必须给同一个结论」。
 * 缓存键必须带上它，否则同一个进程里两种树形会互相吃到对方的缓存。 */
let SIM_ABSENT_TASK_ARCHIVE = false;
let repoFilesCache = null;
function repoFiles(ign) {
  const key = `${SIM_ABSENT_TASK_ARCHIVE ? "no-archive|" : ""}${ign.rules.map((r) => r.pattern).join("\n")}`;
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
  const ignoredHere = SIM_ABSENT_TASK_ARCHIVE
    ? ignored.filter((f) => !isUnderTaskArchive(ign, f))
    : ignored;
  repoFilesCache = { key, tracked, ignored: ignoredHere, simDropped: ignored.length - ignoredHere.length };
  return repoFilesCache;
}

/** 引用行与登记表都要问「这个名字是不是落在 task-archive 目录下」——与 repoFiles 的 SIM 过滤共用一份定义。 */
function isUnderTaskArchive(ign, rel) {
  const rule = ign.ruleFor(rel);
  return !!rule && IGNORED_DIR_CLASSES.get(rule.pattern)?.kind === "task-archive";
}
/** 本机是否真的有 task-archive 类目录：用来区分「树形口子没落地（空跑，假绿）」与
 *  「这棵树本来就没有那个目录（在全新 clone 里跑自测）」——后者里树形例退化成对照，不算失败。 */
function taskArchiveDirPresent(ign) {
  return [...IGNORED_DIR_CLASSES.entries()]
    .filter(([, c]) => c.kind === "task-archive")
    .some(([dir]) => existsSync(path.join(ROOT, dir)));
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

/** 提取一份文本里「主检查真正会拿去裁决的引用」。**#279 附带产物 `spans`**：每一处被提取到的引用在文本里的
 * 字符区间，且区间只覆盖**归一化之后的那个值**（`raw` 的头尾被剥掉的 URL 前缀 / `#锚点` / `:行号` / 末尾标点
 * 都不算进来——归一化只做头尾裁剪，所以值一定是 raw 的连续子串，区间好定位）。
 * `--self-test` 的变异打靶就落在这些区间上（见 `refSweep`）：这样「打在哪一处」由**提取逻辑**决定，
 * 不再由「文本里第一次出现在哪」决定——后者会让任何人的一句散文抢走那一枪（见 SELF_TEST_CASES 上方的 #279 清单）。 */
function extractRefOccurrences(text) {
  const out = new Map(); // 去重保留首次出现位置，报错要能点名行
  const spans = [];      // #279：全部出现（不去重），供自测定点变异用
  const commands = [];
  let lineStart = 0;
  const push = (raw, line, at) => {
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
    const head = url ? raw.indexOf(url[1]) : 0;   // 值在 raw 里的起点（URL 形式取捕获组那段）
    spans.push({ p, start: lineStart + at + head, end: lineStart + at + head + p.length });
  };
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) push(m[1], i + 1, m.index + m[0].lastIndexOf(m[1]));
    for (const m of line.matchAll(/`([^`\s]+)`/g)) push(m[1], i + 1, m.index + m[0].lastIndexOf(m[1]));
    for (const m of line.matchAll(/(?:^|\s)(?:LLM_KIT_E2E=1\s+)?node\s+([\w./-]+\.(?:mjs|js))/g)) {
      commands.push({ kind: "file", value: m[1], line: i + 1 });
    }
    for (const m of line.matchAll(/(?:^|[\s(（:：、，|《])((?:\.\.\/)*docs\/tasks\/[\w.\-\/]+)/g)) push(m[1], i + 1, m.index + m[0].lastIndexOf(m[1])); // #273：纯文本里写的任务档案路径也是引用
    for (const m of line.matchAll(/npm run ([\w:.-]+)/g)) {
      commands.push({ kind: "script", value: m[1], line: i + 1 });
    }
    lineStart += line.length + 1;
  });
  return { refs: [...out.entries()].map(([p, line]) => ({ p, line })), commands, spans };
}

/** 按文档提取（检查面用；`rel` 走 `textOf`，所以 `--self-test` 的内存副本一样被同一套逻辑扫）。 */
function candidatePaths(rel) {
  return extractRefOccurrences(textOf(rel));
}

/** 把一处解不到的引用归到四类里；解得出结论就返回 null。 */
/** 分类台账：每条白名单被哪一处引用用到过，都在这里留痕；收尾时反查「登记了却没一处用上」的条目。 */
const REF_CLASS_HITS = new Set();
/** 台账之二（#280）：某条登记**被哪一处引用提到过**——在裁决**之前**记，与「那一处能不能放行」无关。
 *  「白名单条目空转」回答的是「登记表里有没有没人用的条目」，不回答「引用能不能裁决」。
 *  修前反向校只读 REF_CLASS_HITS，于是同一处引用一旦被判红，这里就**再补一条**「没有一处引用真正用到它」
 *  ——引用明明在，只是那一轮没放行；两条错误互相打脸，还把真问题（那处引用为什么红）淹成噪声。
 *  两张台账分开记：反向校「条目空转」只认这张（存不存在引用），放行证据才认那张（裁决结果）。 */
const REF_REFERRING_HITS = new Set();
let LAST_IGN = null;            // #280：collectPathErrors 用过的 .gitignore 规则（自测的树形例子要拿）
const passAs = (key) => { REF_CLASS_HITS.add(key); return null; };
/** 四张白名单登记表（反向校与「谁在用这条登记」共用一份定义，别再各处抄一遍） */
const WHITE_LIST_TABLES = [
  ["absent", EXPECTED_ABSENT_PATHS], ["external", EXTERNAL_REPO_PATHS],
  ["archive", LOCAL_ARCHIVE_REFS], ["shorthand", SHORTHAND_REFS],
];

/** #280：「本机档案」这一类**只按声明裁决**（就地声明或 LOCAL_ARCHIVE_REFS 逐条登记），
 *  不得要求实物在被 .gitignore 忽略的那个目录里解得到。修前把「实物解得到」当成放行的前提，
 *  于是这条门禁的绿隐含依赖「检查机上恰好有 docs/tasks/」——同一提交在**全新 clone / CI / 一次性沙箱**
 *  里必然红（与 #268「上一次运行的副作用决定门禁输出」同族的门禁不可复现）。
 *  实物解得到时**顺带加固**（核到就加固）：解到被忽略目录下 = 已核实；解到**未忽略**的实物 = 它已入库，
 *  「本机档案」的定义失效 → 红（这条与实物在不在无关，三种树形同判）。核不到实物（整目录不在本机）
 *  → 不影响结论，按声明放行。返回 { ok, verified, why }。 */
function localArchiveVerdict(p, ign, res = {}) {
  const probe = res.ignoredPath ?? p.replace(/^\.\.?\//, "");
  if (res.ignoredPath || ign.ruleFor(probe)) return { ok: true, verified: !!res.ignoredPath };
  if (res.resolved) return { ok: false, why: `它现在仓库里解得到实物 ${res.resolved}（没被 .gitignore 忽略）` };
  return { ok: true, verified: false };
}

/** 把一处解不到的引用归到四类里；能放行就返回 null，否则返回「为什么不放行」。 */
function classifyAbsent(p, docRel, line, ign, res = {}) {
  for (const [tag, table] of WHITE_LIST_TABLES) if (table.has(p)) REF_REFERRING_HITS.add(`${tag}:${p}`);
  if (EXPECTED_ABSENT_PATHS.has(p)) return passAs(`absent:${p}`);
  if (EXTERNAL_REPO_PATHS.has(p)) return passAs(`external:${p}`);
  const short = SHORTHAND_REFS.get(p);
  if (short) {
    // 简称本身不校 .gitignore（它不是生成物也不是本机档案），但它指向的实物必须还在：
    // 实物被改名/删了而简称没跟着改 → 这条登记就是在给未来的漂移留后门。
    return existsSync(path.join(ROOT, short.real[0]))
      ? passAs(`shorthand:${p}`)
      : `登记为 ${short.real.join(" / ")} 的简称（${short.why}），但 ${short.real[0]} 现在解不到了——实物已改名或已删，请连简称一起改（简称↔实物必须同生同死）`;
  }
  const probe = res.ignoredPath ?? p.replace(/^\.\.?\//, "");
  const gen = GENERATED_ARTIFACT_REFS.find((g) => g.re.test(p));
  if (gen) {
    return ign.ruleFor(probe)
      ? passAs(`generated:${gen.re.source}`)
      : `白名单把它归为生成物（${gen.why}），但 .gitignore 并不忽略 ${probe}——生成物的定义已失效`;
  }
  if (LOCAL_ARCHIVE_REFS.has(p)) {
    // #280：登记本身就是「这档案在本机、故意不入库」的声明，不得再拿「实物解不到」当反证——
    // 全新 clone 里根本没有 docs/tasks/。能核到实物就加固，核不到不影响结论（见 localArchiveVerdict）。
    const v = localArchiveVerdict(p, ign, res);
    return v.ok
      ? passAs(`archive:${p}`)
      : `登记为本机档案（${LOCAL_ARCHIVE_REFS.get(p)}），但 .gitignore 并不忽略 ${probe}——`
        + `它已入库或分类变了，请删掉这条登记（本机档案的定义已失效）：${v.why}`;
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
  LAST_IGN = ign;   // #280：`--self-test` 的树形例子要靠它拿到同一份 .gitignore 规则（见 runSelfTest）
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
  REF_REFERRING_HITS.clear();
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
  // 本机档案与**无斜杠裸名**两类都**不限 PATH_DOCS**，全仓已跟踪 Markdown 都跑（#273 点名的两条历史样本就在
  // docs/harness-comparison/05 与 docs/research/2026-09-26 里，而那两份文档不适宜整体纳入
  // paths 覆盖面：docs/design/2026-10-08 实测 57 处引用里 46 处、docs/harness-comparison/01 的
  // 42 处里 32 处引用的是**别的仓库**的文件树，整体纳入就得整片豁免，等于没扩）。
  // #278 把「无斜杠裸名」也接进这一轮：带斜杠的引用维持原口径（上面的理由仍成立），
  // 但裸名要么能解析、要么有四类登记/就地声明，否则红——不再默默放行。豁免按**文档**逐份点名
  // （CROSS_REPO_DOCS），不允许目录通配；近邻判据则不分文档全仓生效。
  const bareCensus = { seen: 0, adjudicated: 0, excused: 0, red: 0, crossRepoSkipped: 0, nearRed: 0 };
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
        // 解不到且没分类时，原本直接 continue（= 默默放行）。#278 后的口径：
        //   · 「像个文件」的无斜杠裸名 → 先跑近邻判据（全仓），再走四类裁决（除非整份文档已点名豁免）；
        //   · 同行自己就写了 docs/tasks/… 的引用 → 依旧当本机档案报（#273：白名单不是整目录豁免）；
        //   · 其余（带斜杠的解不到引用）→ 维持原状，不在本锚点覆盖面内。
        const lineText = textOf(rel).split("\n")[line - 1] ?? "";
        // 只拿「像个文件」的引用当档案引用：CHANGELOG 里 `scratch/` 这种目录/规则名也在同一行出现，
        // 不卡这一刀就会把目录名当成被改名的本机档案（假红）。
        const looksLikeFile = /\.[A-Za-z0-9]+$/.test(p.replace(/\/+$/, ""));
        const bare = !p.includes("/") && BARE_FILE_RE.test(p) && BARE_NAME_ADJUDICATED;
        const mentionsTaskArchive = /(^|[^-\w])docs\/tasks\//.test(lineText);
        if (looksLikeFile && mentionsTaskArchive) {
          // #280：这一支过去**不问登记也不问声明**，直接判红。于是「已登记的裸名」在没有 docs/tasks/ 的
          // 树形里会被说成「也不在 LOCAL_ARCHIVE_REFS 登记里」（它明明登记着），并连带把白名单反向校
          // 打成「条目空转」。现在先走同一套四类裁决：已登记/已就地声明 → 按声明放行（实物核到就加固，
          // 核不到不影响结论）；只有**既未登记又未声明**的才继续拿下面那句点名（措辞与 #273 一致）。
          if (classifyAbsent(p, rel, line, ign, r) === null) {
            excusedArchive += 1;
            if (bare) { bareCensus.seen += 1; bareCensus.adjudicated += 1; bareCensus.excused += 1; }
            continue;
          }
          // 引用行自己就在讲任务档案 → 无论有无斜杠都按「本机档案」判（#273 定的口径，措辞不变）。
          const stem = (s2) => s2.replace(/\.[^.]+$/, "");   // 去扩展名后比前缀：改名（加/删一个字符）必然落在同一前缀里
          const twin = [...LOCAL_ARCHIVE_REFS.keys()].find((k) => k !== p
            && (stem(path.posix.basename(k)).startsWith(stem(path.posix.basename(p)))
              || stem(path.posix.basename(p)).startsWith(stem(path.posix.basename(k)))));
          bad.push(`\`${p}\`（第 ${line} 行）：指向任务档案（同一行写了 \`docs/tasks/…\`，该目录整目录不入库），`
            + `但这个名字仓库里解不到、也不在 LOCAL_ARCHIVE_REFS 登记里`
            + (twin ? `——与已登记的 \`${twin}\` 只差一个字符：登记与引用必须一起改` : "")
            + (bareNameNearest(p, ign).length ? `；它跟本仓实物也只差一点：${bareNameNearest(p, ign).slice(0, 3).join(" / ")}` : ""));
          if (bare) { bareCensus.seen += 1; bareCensus.red += 1; }
          continue;
        }
        if (!bare) continue;   // 带斜杠又没在任务档案行里的解不到引用 → 不在本锚点覆盖面内（维持 #273 原口径）
        bareCensus.seen += 1;
        // 先跑四类裁决（能解析 / 已登记 / 就地声明就放行）。顺序很重要：已登记的裸名
        // （judge.log、status.json）必须先看登记，否则会被近邻判据误伤。
        const why = classifyAbsent(p, rel, line, ign, r);
        bareCensus.adjudicated += 1;
        if (why === null) { excusedArchive += 1; bareCensus.excused += 1; continue; }
        const near = bareNameNearest(p, ign);
        const crossRepo = CROSS_REPO_DOCS.get(rel) ?? null;
        // 跳仓对照文档：通篇在讲另一个仓库，解不到又不像本仓实名的裸名不裁决（但条目被反向校）。
        // 近邻判据**不豁免**——把本仓真实存在的档案名改坏一个尾巴，在哪份文档里都该红。
        if (crossRepo && !near.length) {
          REF_CLASS_HITS.add(`crossrepo-doc:${rel}`);
          bareCensus.crossRepoSkipped += 1;
          continue;
        }
        bareCensus.red += 1;
        if (crossRepo) bareCensus.nearRed += 1;
        // ③ 同名字干有实物 → 红字额外点名「它像哪个实物」；同名多命中（歧义）也点名候选实物。
        const hint = near.length
          ? `它跟本仓实物只差一点：${near.slice(0, 3).join(" / ")}——若本意就是那个文件，把裸名改成它的真实路径（改名要连引用一起改）`
          : (r.ambiguous ? `本仓有 ${r.ambiguous.length} 个同名文件（${r.ambiguous.join(", ")}），裸名到底指哪个要写清（歧义不算解析成功）` : "");
        bad.push(`\`${p}\`（第 ${line} 行）：${why}${hint ? `\n      ↳ ${hint}` : ""}${crossRepo ? "（这份文档已逐份点名豁免非实名的裸名引用，但近邻判据不豁免）" : ""}`);
        continue;
      }
      const why = classifyAbsent(p, rel, line, ign, r);
      if (why === null) { excusedArchive += 1; continue; }
      bad.push(`\`${p}\`（第 ${line} 行）：${why}`);
    }
    if (bad.length) {
      out.push(`archive-refs: ${rel} 引用了克隆后不存在的本机档案或无法裁决的裸文件名（${bad.length} 处）：\n      ${bad.join("\n      ")}`);
    }
  }
  notes.push(`archive-refs: 全仓非入口文档里指向被忽略目录的引用已全部裁决（白名单/就地声明共 ${excusedArchive} 处）`);
  notes.push(`bare-names: 无斜杠裸名裁决面——需裁决 ${bareCensus.adjudicated}（放行 ${bareCensus.excused}、红 ${bareCensus.red}，其中近邻判据 ${bareCensus.nearRed}）、`
    + `跳仓文档点名豁免 ${bareCensus.crossRepoSkipped} 处（${CROSS_REPO_DOCS.size} 份逐份点名的文档，无目录通配）`);
  // 白名单也要校：没人引用的条目就是「为不存在的引用留后门」，同样算检查面腐坏。
  const tables = WHITE_LIST_TABLES;
  for (const [tag, table] of tables) {
    for (const p of table.keys()) {
      const hitKey = `${tag}:${p}`;
      if (REF_CLASS_HITS.has(hitKey)) continue;
      // #280：与「引用能否裁决」解耦——这条引用**存在**、只是那一轮没能放行，那条红已经点名了它；
      // 这里不许再补一句「没有一处引用真正用到它」（引用明明在，只是未放行）。两条一起报只会互相打脸。
      if (REF_REFERRING_HITS.has(hitKey)) continue;
      out.push(`paths: 白名单条目 \`${p}\` 没有一处引用真正用到它——要么它现在已能直接解析到（那就该删），`
        + `要么被检文档（${PATH_DOCS.join(", ")} + 全仓 .md）里已没人引用它；留着就是给未来的漂移留后门`);
    }
  }
  // #278：逐份点名的跳仓文档也要反向校—4 份文档里已经没有任何需要豁免的裸名（或文档已改名/删了）
  // 就该销账，否则豁免清单会默许烂下去（跟白名单条目同病）。
  for (const d of CROSS_REPO_DOCS.keys()) {
    if (REF_CLASS_HITS.has(`crossrepo-doc:${d}`)) continue;
    out.push(`bare-names: 跳仓点名清单里的 \`${d}\` 现在没有一处裸名引用用上它——文档已改名/删了，或里面的裸名引用已被逐条裁决；`
      + `请删这条豁免（逐份点名的清单不许有没人用的条目）`);
  }
  for (const g of GENERATED_ARTIFACT_REFS) {
    if (!REF_CLASS_HITS.has(`generated:${g.re.source}`)) {
      notes.push(`paths: 生成物条目 /${g.re.source}/ 当前没被用到（覆盖面内没有这类引用），保留是为了不让 *.d.ts 变红`);
    }
  }
  // 登记表自己也要被 .gitignore 校：「本机档案」的定义就是「被忽略目录里的档案」，目录不再忽略
  // 它就该销账（#273：分类真的读 .gitignore，不是只写在注释里）。
  let archiveUnverifiable = 0;
  for (const [p, why] of LOCAL_ARCHIVE_REFS) {
    // 登记可能是裸名（examples README 同句举的脚本名），先走同一套三级解析再问 .gitignore。
    const res = resolveRef(p, PI_EXT_README, ign);
    // #280：登记表自己的反向校也**不得依赖实物存在**。裸名在 .gitignore 里根本无从校（`docs/tasks/` 是
    // 目录规则，裸名不带目录），旧实现只认「实物解到 task-archive 目录下」，于是同一提交在全新 clone 里
    // 会把每一条裸名登记都判成「登记已失效」。现在能判红的只剩「解到了未忽略的实物」（= 已入库），
    // 那条与本机有没有那个目录无关，在任意树形上同判。
    const v = localArchiveVerdict(p, ign, res);
    if (v.ok) {
      if (!v.verified) archiveUnverifiable += 1;   // 核不到实物（树形里没有 task-archive 目录）：按声明放行
      continue;
    }
    // 逐份点名「谁在拿这条登记当护身符」：登记失效 = 那些引用同时失去裁决依据（#273：分类真的读 .gitignore）。
    const bn = path.posix.basename(p);
    const refDocs = [...PATH_DOCS, ...repoFiles(ign).tracked.filter((f) => f.endsWith(".md") && !PATH_DOCS.includes(f))]
      .filter((d) => { const t = textOf(d); return t.includes(p) || t.includes(bn); });
    for (const d of (refDocs.length ? refDocs : ["（无文档引用）"])) {
      out.push(`archive-refs: ${d} 登记的 \`${p}\` 登记为本机档案（${why}），但 .gitignore 并不忽略它`
        + `——本机档案的定义就是「被 task-archive 目录忽略的本机文件」，登记已失效，请删登记或改 .gitignore`);
    }
  }
  if (archiveUnverifiable) {
    notes.push(`archive-refs: ${archiveUnverifiable} 条本机档案登记在当前树形里核不到实物（没有 docs/tasks/ 的树形：全新 clone / CI / 一次性沙箱）`
      + `——按声明放行（#280：这类裁决不得依赖实物存在，否则门禁在克隆机上永远红）`);
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
    ...collectMarkerLiteralErrors(), ...collectBaselineClaimErrors(),
    ...collectSymbolAnchorErrors(), ...collectBareLineRefErrors()];
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
for (const e of collectSymbolAnchorErrors()) err(e);
for (const n of collectSymbolAnchorErrors.notes ?? []) note(n);
for (const e of collectBareLineRefErrors()) err(e);
for (const n of collectBareLineRefErrors.notes ?? []) note(n);
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

/** #279：在文档**第一处 `## ` 标题之前**插一句散文（= 「在文档靠前位置提一句某个名字」）。 */
function mentionInProse(sentence) {
  return (t) => {
    const m = /^## /m.exec(t);
    if (!m) return t;
    return t.slice(0, m.index) + sentence + "\n\n" + t.slice(m.index);
  };
}

/** #279：自测的「位置无关」打靶器。把「在某文档里把一个引用改个名」这刀从
 *  「文本第一次出现」改成「主检查提取到的那一（几）处」：用与主检查同一套提取逻辑
 *  （`extractRefOccurrences` 的 `spans`）定位**提取值恰为 `from`** 的全部出现，逐处定点换成 `to`。
 *  理由、病历与用例清单写在文件头 §2.5 「#279 的病历」那一块（与 #210「其余锚点为何没升级」同位）。
 *  · 一处都没命中就**原样返回** → `runSelfTest` 既有的「变异没落到 X 上」判据会报红，不给空跑假绿留门。
 *  · `opts.mention`：变异前先在文档靠前插一句散文——这正是本单要钉住的形状（提一句不能抢枪）。 */
function mutateRef(from, to, opts = {}) {
  return (text) => {
    let t = opts.mention ? mentionInProse(opts.mention)(text) : text;
    const seen = new Set();
    const hits = extractRefOccurrences(t).spans
      .filter((s) => s.p === from)
      .filter((s) => !seen.has(`${s.start}:${s.end}`) && seen.add(`${s.start}:${s.end}`))
      .sort((a, b) => b.start - a.start);
    if (!hits.length) return text;
    for (const s of hits) t = t.slice(0, s.start) + to + t.slice(s.end);
    if (extractRefOccurrences(t).spans.some((s) => s.p === from)) return text;   // 该值还剩着 → 这一枪没打全，同样算没落上
    return t;
  };
}

// 棘轮两档的当前真值**现读**棘轮脚本，不写死（issue #292 踩到的坑）：下面 5 条 baseline 反向证的变异串
// 原先硬编码 121 / 164，基线一降到 119 / 162 就全部变成空操作，而 #210 R2 把「变异没打上」判成红 ——
// 于是「下调常量 + 同步文档」这笔完全正常的提交会打红 5 条反向证。现读之后，以后再降基线不必回来改这里。
const RATCHET_TRUTH = ratchetBaselines(textOf(RATCHET_SRC));
const B_ROOT = Number(RATCHET_TRUTH.root);
const B_WT = Number(RATCHET_TRUTH.withTools);

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
    overlay: { [PI_EXT_README]: mutateRef("erix-run-core.js", "erix-run-coreX.js") },   // #279：该值在本份文档里被提取到 4 处，全部定点换名
    expect: [/paths: examples\/pi-extension\/README\.md[\s\S]*`erix-run-coreX\.js`（第 \d+ 行）：本仓不存在/],
    expectFiles: [PI_EXT_README],
  },
  {
    label: "把根 README 引用的 docs/architecture.md 改名（既有行为不退化）",
    overlay: { [README_EN]: mutateRef("docs/architecture.md", "docs/architectureX.md") },   // #279：提取值是 URL 尾段，靶子由提取器定，不再靠人手工挑靶串
    // 变异要落在**真正被核对的那个引用**上：这行是 `[docs/architecture.md](https://…/blob/main/docs/architecture.md)`，
    // 只改链接文字动不了提取出的 href（URL 会被改写成仓内路径），所以上一版是“变异没接上检查面”而非锚点绿。
    // 上一版靠把靶串写成 `blob/main/…` 来手工避开链接文字（换一句措辞就失效）；#279 后 `mutateRef` 直接按
    // 提取值定位，链接文字天然不会被误伤——「打在哪」不再取决于靶串怎么写。
    expect: [/paths: README\.md[\s\S]*docs\/architectureX\.md/],
    expectFiles: [README_EN],
  },
  {
    label: "白名单不是整目录豁免：把已登记的 CHANGELOG 任务档案名改一个字 → 红",
    overlay: { "CHANGELOG.md": mutateRef("repro-circular-details.mjs", "repro-circular-detailsX.mjs") },   // #278 首次现场：旧写法只换第一次出现，散文提一句就抢枪
    // #279：报错的**措辞分支**取决于「被报告的那一行自己有没有写 `docs/tasks/`」（#273 定的口径），而报告
    // 的行 = 该值的**第一处出现**——散文里先提一句就会换掉那一行，于是旧期望「指向任务档案」会被无关措辞
    // 打断（#278 首次现场就是这条「红了但没点该点的名」）。期望钉的是**裁决**：点名改名后的引用、必须带行号、
    // 必须归到 LOCAL_ARCHIVE_REFS 那条口径上（两支措辞都满足）；不再钉某一支的措辞。不是放宽：仍然要点名到名字与行号。
    expect: [
      /archive-refs: CHANGELOG\.md[\s\S]*`repro-circular-detailsX\.mjs`（第 \d+ 行）/,
      /repro-circular-detailsX\.mjs[\s\S]*LOCAL_ARCHIVE_REFS/,
    ],
    expectFiles: ["CHANGELOG.md"],
  },
  {
    label: "就地声明就能放行（对照）：把已登记的 REPORT.md 换成没登记的 PLAN.md，同行仍写「本地，不入库」",
    overlay: { "docs/research/2026-09-26-strategy-variance-and-cache-economics.md": mutateRef(
      "docs/tasks/done/260926-strategy-variance-benchmark/REPORT.md",
      "docs/tasks/done/260926-strategy-variance-benchmark/PLAN.md") },   // #279：按提取值（整条路径）打靶，不拿子串去碰
    expectGreen: true,
  },
  {
    label: "把那句「（本地，不入库）」删掉 → 同一处立刻红（证明上一例的绿来自声明，不是恒绿）",
    overlay: {
      "docs/research/2026-09-26-strategy-variance-and-cache-economics.md": (t) =>
        mutateRef("docs/tasks/done/260926-strategy-variance-benchmark/REPORT.md",
          "docs/tasks/done/260926-strategy-variance-benchmark/PLAN.md")(
          t.replace("任务文档（本地，不入库）：", "任务文档：")),   // #279：文件名那一刀改成定点打靶，散文那一刀原样
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
      [PI_EXT_README]: mutateRef("e2e-wake.mjs", "e2e-wake-v2.mjs"),
      "CHANGELOG.md": mutateRef("e2e-wake.mjs", "e2e-wake-v2.mjs"),
      "docs/research/2026-10-13-pi-subagents-async-attribution.md": mutateRef("e2e-wake.mjs", "e2e-wake-v2.mjs"),   // #279：三份文档各自按提取值定点，不再拿反引号靶串去猜第一次出现在哪
    },
    expect: [/白名单条目 `e2e-wake\.mjs` 没有一处引用真正用到它/],
  },

  // —— #280：门禁不得隐含依赖「检查机上恰好有被 .gitignore 忽略的 docs/tasks/」（修前全新 clone 必红）——
  {
    label: "#280 树形对照：本机没有 docs/tasks/（全新 clone / CI / 一次性沙箱）时，本机档案类必须整片绿",
    // 修前：同一提交在 `git archive HEAD` 解出来的树里 check:docs exit 1（10 条）、工作树里 exit 0——
    // 「本机档案」的裁决把「实物在 docs/tasks/ 下解得到」当成了放行前提。这一例把那棵树的形状钉进自测：
    // 声明一侧（登记表 / 就地声明 / .gitignore 规则）一个字没动，只把实物从清单里摘掉，必须仍 0 错。
    simulateAbsentTaskArchive: true,
    expectGreen: true,
  },
  {
    label: "#280 上一例的绿不是「整类不裁决」：同一空树形里把已登记裸名改成未登记的假名 → 仍红",
    // 「本机档案默认按声明放行」很容易被糊成「干脆整类不裁决」——这条就是抓它的：树形一样是空的，
    // 但引用改成了既未登记、也解不到的假名，必须照样红并点名那处引用（与上一例共用同一个树形口子）。
    simulateAbsentTaskArchive: true,
    overlay: { "docs/research/2026-10-13-pi-subagents-async-attribution.md": mutateRef("e2e-wake.mjs", "e2e-wake-cloneQ.mjs") },
    expect: [/archive-refs: docs\/research\/2026-10-13[\s\S]*`e2e-wake-cloneQ\.mjs`（第 \d+ 行）[\s\S]*本仓不存在/],
    expectFiles: ["docs/research/2026-10-13-pi-subagents-async-attribution.md"],
  },

  // —— bare-names：无斜杠裸名的通用裁决 + 近邻判据（issue #278；下面四条修前**全是 exit 0**）——
  {
    label: "#278-P2 改坏**已登记**的裸名（`repro-circular-details.mjs` 多个 Q）→ 红（修前 exit 0：脱离登记就静默放行）",
    overlay: { "docs/research/2026-10-13-pi-subagents-async-attribution.md": mutateRef("repro-circular-details.mjs", "repro-circular-detailsQ.mjs") },
    expect: [
      /archive-refs: docs\/research\/2026-10-13[\s\S]*`repro-circular-detailsQ\.mjs`（第 \d+ 行）/,
      /↳ 它跟本仓实物只差一点：docs\/tasks\/active\/261010-13-erix-run-async\/repro-circular-details\.mjs/,
    ],
    expectFiles: ["docs/research/2026-10-13-pi-subagents-async-attribution.md"],
  },
  {
    label: "#278-P3 改坏**未登记**的裸名（`e2e-wake.mjs` 多个 Q）→ 红（修前 exit 0：它本来连被检资格都没有）",
    overlay: { "docs/research/2026-10-13-pi-subagents-async-attribution.md": mutateRef("e2e-wake.mjs", "e2e-wakeQ.mjs") },
    expect: [
      /archive-refs: docs\/research\/2026-10-13[\s\S]*`e2e-wakeQ\.mjs`（第 \d+ 行）[\s\S]*本仓不存在/,
      /↳ 它跟本仓实物只差一点：docs\/tasks\/active\/261010-13-erix-run-async\/e2e-wake\.mjs（比实物名字干多写了 “Q”）/,
    ],
    expectFiles: ["docs/research/2026-10-13-pi-subagents-async-attribution.md"],
  },
  {
    label: "跳仓对照文档里的裸名不被裁决（对照）：把 codex 篇的 `MEMORY.md` 改个名必须仍然绿",
    // #278 裁定的另一面：跳仓/宿主对照文档（CROSS_REPO_DOCS 逐份点名那批）的裸名指的不是本仓实物，
    // 不该被拖进裁决面——这一例就是防「把 79 处跳仓引用用另一种方式再吃回来」。近邻判据不在此列，
    // 所以变异选 `MEMORY.md`（5 字干，低于 NEAR_STEM_MIN=8，不会误判成本仓实物改名）。
    overlay: { "docs/harness-comparison/03-codex.md": mutateRef("MEMORY.md", "MEMORYX.md") },   // #279：该值在这篇里有 5 处，全部定点换名（仍全绿才叫「跳仓裸名不被裁决」）
    expectGreen: true,
  },
  {
    label: "#269 原型：裁决清单内新写一个**凭空、无近邻**的裸名（`analysis.md` 形状）→ 红（这是近邻判据拓不到的那一半）",
    overlay: { "docs/research/2026-09-26-strategy-variance-and-cache-economics.md": mutateRef("debug.routes.js", "zz-nonexistent-evidence.md") },
    // #279：期望不再钉「第 118 行」这个**地址**——它钉的是「报错必须给出行号」；写死行号时，只要有人
    // 在那行以上加一句散文（哪怕提的是不相干的名字）这一例就会红，而那恰好就是本单要修的病。
    expect: [/archive-refs: docs\/research\/2026-09-26[\s\S]*`zz-nonexistent-evidence\.md`（第 \d+ 行）[\s\S]*本仓不存在/],
    expectFiles: ["docs/research/2026-09-26-strategy-variance-and-cache-economics.md"],
  },
  {
    label: "跳仓点名清单也不许烂着：那份文档已没一处裸名引用要用豁免 → 销账红（反向校）",
    // docs/harness-comparison/README.md 里需要豁免的裸名就是 `MEMORY.md` 两处；全改成能解析的实物名后，
    // 这条逐份点名的豁免就成了空条目 → 必须红（否则清单会默默堆着没人用的条目）。
    overlay: { "docs/harness-comparison/README.md": mutateRef("MEMORY.md", "AGENTS.md") },   // #279：原本就是 replaceAll，但它是「按子串」而不是「按提取值」，一并改成定点
    expect: [/bare-names: 跳仓点名清单里的 `docs\/harness-comparison\/README\.md` 现在没有一处裸名引用用上它/],
  },
  {
    label: "登记表反向校扩到裸名（#278 第 4 件）：本仓文档里已没人引用已登记的裸名 `repro-circular-details.mjs` → 销账红",
    // 两条引用（CHANGELOG 与 research 篇）全改成能解析的路径后，这条**无斜杠**登记就没人用了；
    // 反向校必须抓得住（#273 只对带斜杠条目做到了这件事）。
    overlay: {
      "CHANGELOG.md": mutateRef("repro-circular-details.mjs", "docs/tasks/active/261010-13-erix-run-async/repro-circular-details.mjs"),
      "docs/research/2026-10-13-pi-subagents-async-attribution.md": mutateRef("repro-circular-details.mjs", "docs/tasks/active/261010-13-erix-run-async/repro-circular-details.mjs"),   // #279：#280 现场——旧写法只换第一处，散文提一句就抢枪 → 该红的不红
    },
    expect: [/白名单条目 `repro-circular-details\.mjs` 没有一处引用真正用到它/],
  },
  {
    label: "近邻判据**不**跟跳仓豁免一起免：跳仓文档里把本仓实物名改坏一个尾缀 → 仍红",
    // 防的是反向滑坡：「这份文档在讲别的仓库」不等于本仓实物在它就是绿的。拿 `README.md`（能解析）
    // 换成 `erix-run-coreX.js`（本仓有 erix-run-core.js，只差一个 X），必须靠近邻判据抓红。
    overlay: { "docs/harness-comparison/02-touwaka.md": mutateRef("README.md", "erix-run-coreX.js") },   // #279：按提取值打靶（该值这篇里 2 处），不再拿「`README.md` 全文」这整串措辞当靶
    expect: [/archive-refs: docs\/harness-comparison\/02-touwaka\.md[\s\S]*`erix-run-coreX\.js`（第 \d+ 行）[\s\S]*examples\/pi-extension\/erix-run-core\.js/],
  },
  {
    label: "简称登记也要反向校（#278 新增第五类）：CHANGELOG 里的 `format.js` 简称改成实物路径后，简称条目就该销账",
    overlay: { "CHANGELOG.md": mutateRef("format.js", "examples/pi-extension/erix-run-format.js") },   // #279：同上，从「反引号 + 子串 replaceAll」改成按提取值定点
    expect: [/白名单条目 `format\.js` 没有一处引用真正用到它/],
  },

  // —— #279：在文档里「提一句同一个文件名」不许抢走变异的那一枪（打靶位置无关）——
  // 三次现场（#278 收尾 3 红、#280 收尾 2 红）全部指向同一个名字：别人只是**在散文里提了一句**
  // `repro-circular-details.mjs`，旧变异体（`t.replace("X.mjs", …)` 只换第一次出现）的那一枪就打在
  // 那句散文上——真正的引用一个字没动 → 「该红的不红」，还被自测报成 `改了但没红（锚点仍是 fail-open）`
  // 这个**假警报**（同一份树上 `check:docs` 明明 exit 0）。下面两条把这个形状钉住：第 1 条**修前就是红的**
  // （#280 那条「改了但没红」），第 2 条修前也绿——它钉的是「提一句」这个动作本身绝不该让门禁红；
  // 修前真正红的是**同树的其它用例**（拿 `git show HEAD:` 取出的修前脚本跑同一棵树：2/57 红，见 CHANGELOG #279）。
  {
    label: "#279 提一句不许抢枪：CHANGELOG 靠前散文先提一句已登记的裸名，再把两份文档里的裸名引用改成真实路径 → 销账红必须照样在（修前：散文那一处才是第一次出现 → 该红的不红）",
    overlay: {
      // mention 就是把「提一句」那个动作放进自测：插在第一处 `## ` 标题之前，比任何真引用都早。
      "CHANGELOG.md": mutateRef("repro-circular-details.mjs",
        "docs/tasks/active/261010-13-erix-run-async/repro-circular-details.mjs",
        { mention: "自测探针（#279）：这里只是在散文里提一句那个已登记的任务档案裸名 `repro-circular-details.mjs`。" }),
      "docs/research/2026-10-13-pi-subagents-async-attribution.md": mutateRef("repro-circular-details.mjs",
        "docs/tasks/active/261010-13-erix-run-async/repro-circular-details.mjs"),
    },
    expect: [/白名单条目 `repro-circular-details\.mjs` 没有一处引用真正用到它/],
  },
  {
    label: "#279 提一句本身不该让门禁红（对照）：只在 CHANGELOG 靠前插那句散文、什么也不改 → 必须 0 错（名字已登记，门禁不该因为一个名字被提到就改口）",
    overlay: { "CHANGELOG.md": mentionInProse("自测探针（#279）：这里只是在散文里提一句那个已登记的任务档案裸名 `repro-circular-details.mjs`。") },
    expectGreen: true,
  },

  // —— 工具事实契约面：契约文档的字段清单 ↔ TOOL_RESULT_CONTRACT（工单 261014 T1）——
  // 四种形状都钉住：只改文档→红、只改常量→红（中英两侧都红）、删掉整句→红、
  // 「变异没打上」→红（runSelfTest 的 `after === before` 判据，#210 R2 口径）。
  {
    label: "契约 EN 的引擎字段清单删一处 `durationMs`（只改文档）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("`toolCallKey` / `round` / `durationMs` / `executionStatus` /", "`toolCallKey` / `round` / `executionStatus` /") },
    expect: [/字段清单: docs\/host-consumer-contract\.md:\d+.*缺 引擎字段 "durationMs"/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "契约 CN 的引擎字段清单把 `success` 改名成 `ok`（只改文档、改名不是「删」）",
    overlay: { [CONTRACT_CN]: (t) => t.replace("`executionStatus` / `success`。", "`executionStatus` / `ok`。") },
    expect: [/host-consumer-contract_cn\.md.*缺 引擎字段 "success"/, /多出真值里没有的 引擎字段 "ok"/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "契约 EN 把「exactly five fields」那句整句改成不含清单的话（删掉整句 → 检查面失效 + 中英处数不齐）",
    overlay: { [CONTRACT_EN]: (t) => t.replace(
      "The engine namespace has exactly five fields, every one of them\naddressed as `erix.<field>`: `toolCallKey` / `round` / `durationMs` / `executionStatus` /\n`success`.",
      "The engine namespace is a namespace addressed per field.") },
    expect: [/找不到引擎字段清单声明/, /声明点处数中英不齐：docs\/host-consumer-contract\.md 0 处 vs docs\/host-consumer-contract_cn\.md 1 处/],
  },
  {
    label: "契约 EN 把「exactly five fields」改成 six（数量声明也是事实，不靠清单接）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("exactly five fields", "exactly six fields") },
    expect: [/声称引擎命名空间有「six」个字段.*engine\.fields 是 5 个/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "契约 EN 的存在性矩阵表头把 `erix.durationMs` 改名 → 矩阵列单独红",
    overlay: { [CONTRACT_EN]: (t) => t.replace("| Case | erix.toolCallKey | erix.round | erix.durationMs |", "| Case | erix.toolCallKey | erix.round | erix.elapsedMs |") },
    expect: [/存在性矩阵列: docs\/host-consumer-contract\.md:\d+.*缺 矩阵列.*"durationMs"/, /多出真值里没有的 矩阵列.*"elapsedMs"/],
  },
  {
    label: "契约 CN 的字段归属表把引擎命名空间写成 `engine.toolCallKey` → 命名空间名不一致就红",
    overlay: { [CONTRACT_CN]: (t) => t.replace("| `erix.toolCallKey` | 引擎 |", "| `engine.toolCallKey` | 引擎 |") },
    expect: [/把引擎字段写成 `engine\.toolCallKey`.*engine\.ns 是 "erix"/, /缺 引擎字段行 "toolCallKey"/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "契约 CN 的 legacy 别名表把 `duration` 的新归属写成 `erix.elapsedMs` → 别名值与常量不齐",
    overlay: { [CONTRACT_CN]: (t) => t.replace("| `duration` | `erix.durationMs` |", "| `duration` | `erix.elapsedMs` |") },
    expect: [/把 `duration` 的新归属写成 `erix\.elapsedMs`.*常量里的别名是 `erix\.durationMs`/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "常量里新增一个引擎字段 → 中英两侧同时红（清单缺、表缺、数量也不对）",
    overlay: { "src/tool-fact.js": (t) => t.replace(
      "    fields: {\n      toolCallKey: {",
      "    fields: {\n      zzzExtra: {\n        owner: \"engine\",\n        stages: [\"result\"],\n        resumeStable: true,\n        onWire: false,\n      },\n      toolCallKey: {") },
    expect: [/缺 引擎字段 "zzzExtra"/, /缺 引擎字段行 "zzzExtra"/, /声称引擎命名空间有「five」个字段.*是 6 个/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "常量里删掉一个引擎字段（success）→ 中英两侧「文档多写了」必须红",
    overlay: { "src/tool-fact.js": (t) => t.replace(/      success: \{\n[\s\S]*?\n      \},\n/, "") },
    expect: [/多出真值里没有的 引擎字段 "success"/, /多出真值里没有的 引擎字段行 "success"/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "常量把 engine.ns 改名（erix → engine）→ 中英两侧的 `erix.*` 声明全红",
    overlay: { "src/tool-fact.js": (t) => t.replace('    ns: "erix",', '    ns: "engine",') },
    expect: [/engine\.ns 是 "engine"/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "常量给协议必需字段加一项 → 中英两侧的协议字段行同时红",
    overlay: { "src/tool-fact.js": (t) => t.replace('required: ["type", "tool_use_id", "content"],', 'required: ["type", "tool_use_id", "content", "cursor"],') },
    expect: [/协议字段行.*缺 协议字段 "cursor"/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },
  {
    label: "契约 EN 把「保留顶层键名」那段整段删掉（只改文档：该文件的检查面失效必须当场红，不靠中英处数）",
    overlay: { [CONTRACT_EN]: (t) => t.replace(/^`metadata` and `erix` are \*\*reserved[\s\S]*?no longer reach those fields\.\n/m, "") },
    expect: [/docs\/host-consumer-contract\.md 找不到保留键名的声明/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "契约 CN 的保留键名那段少写一个 `erix`（只改文档、少一个键名也是漂移）",
    overlay: { [CONTRACT_CN]: (t) => t.replace("`metadata` 与 `erix` 是**保留的顶层键名**", "`metadata` 是**保留的顶层键名**") },
    expect: [/保留键名: docs\/host-consumer-contract_cn\.md.*缺 保留键名 "erix"/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "常量只改保留键名的登记、不改命名空间名（erix → engine）→ 源码自洽 + 中英文档同时红",
    overlay: { [TOOL_FACT_SRC]: (t) => t.replace('topLevelKeys: ["metadata", "erix"]', 'topLevelKeys: ["metadata", "engine"]') },
    expect: [/自相矛盾——保留键名登记的是 metadata \/ engine/, /缺 保留键名 "engine"/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },

  {
    // T2 把这张表从「双写对照表」改成**退役名单**（多了一条 `success`），所以「少一行」必须红：
    // 只删不改的退役条目最容易在文档里被漏掉，而漏掉就等于宿主不知道要迁移什么。
    label: "契约 EN 的退役名单少写 `success` 那一行（只改文档：T2 新增的那条退役名被漏掉）",
    overlay: { [CONTRACT_EN]: (t) => t.replace("| `success` | `erix.success` |\n", "") },
    expect: [/legacy 别名表: docs\/host-consumer-contract\.md.*缺 旧顶层键 "success"/,
      /alias: 声明点处数中英不齐：docs\/host-consumer-contract\.md 3 处 vs docs\/host-consumer-contract_cn\.md 4 处/],
    expectFiles: [CONTRACT_EN],
  },
  {
    label: "常量把 legacy 别名的新归属改名 → 中英两侧的别名表同时红",
    overlay: { "src/tool-fact.js": (t) => t.replace('duration: "erix.durationMs",', 'duration: "erix.elapsedMs",') },
    expect: [/常量里的别名是 `erix\.elapsedMs`/],
    expectFiles: [CONTRACT_EN, CONTRACT_CN],
  },

  // —— baseline：AGENTS 的棘轮当前值 ↔ 棘轮常量（issue #274）——
  {
    label: `AGENTS EN 把基线写成 142（#265 当年留在 CHANGELOG 的那种开发中途值）（修前 exit 0）`,
    overlay: { [AGENTS_EN]: (t) => t.replace(`baseline constant **${B_ROOT}**`, "baseline constant **142**") },
    expect: [new RegExp(`baseline\\/「基线常量 \\/ baseline constant」声明: AGENTS\\.md:\\d+ 声称 142，但 scripts\\/type-check-ratchet\\.mjs 的 BASELINE_ROOT 是 ${B_ROOT}`)],
    expectFiles: [AGENTS_EN],
  },
  {
    label: `AGENTS CN 把常量写法写成 ${B_ROOT - 1} → 点名 AGENTS_cn.md`,
    overlay: { [AGENTS_CN]: (t) => t.replace(`BASELINE_ROOT = ${B_ROOT}`, `BASELINE_ROOT = ${B_ROOT - 1}`) },
    expect: [new RegExp(`baseline\\/常量写法 \`BASELINE_ROOT = N\`: AGENTS_cn\\.md:\\d+ 声称 ${B_ROOT - 1}，但 .* BASELINE_ROOT 是 ${B_ROOT}`)],
    expectFiles: [AGENTS_CN],
  },
  {
    label: "棘轮常量自己降 1 → 中英两侧的当前值句式全红",
    overlay: { [RATCHET_SRC]: (t) => t.replace(`const BASELINE_ROOT = ${B_ROOT};`, `const BASELINE_ROOT = ${B_ROOT - 1};`) },
    expect: [new RegExp(`BASELINE_ROOT 是 ${B_ROOT - 1}`)],
    expectFiles: [AGENTS_EN, AGENTS_CN],
  },
  {
    label: `CN 的分解式写成 ${B_ROOT} + 27 + 15 → 算术不闭合就红`,
    overlay: { [AGENTS_CN]: (t) => t.replace(`= ${B_ROOT} + 27 + 16`, `= ${B_ROOT} + 27 + 15`) },
    expect: [new RegExp(`分解式 ${B_ROOT} \\+ 27 \\+ 15 = ${B_ROOT + 42}，不等于 BASELINE_WITH_TOOLS（${B_WT}）`)],
    expectFiles: [AGENTS_CN],
  },
  {
    label: `EN 少写一处「基线 **${B_WT}** / 31 files」→ 中英句式处数不齐`,
    overlay: { [AGENTS_EN]: (t) => t.replace(`baseline **${B_WT}** / 31 files = ${B_ROOT} + 27 + 16`, `the ${B_WT}-error baseline spread over 31 files (= ${B_ROOT} + 27 + 16)`) },
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

  // —— 符号锚点与裸行号棘轮（issue #286 T-a：R1/R2/R3 的反向证，#210 R2 口径四条齐全）——
  // ① 只改文档（符号名改错）→ 红；② 只改真值（源码里给符号改名）→ 红；③ 新增裸行号 → 红；
  // ④ 行号越界 → 红；⑤ 变异没打上 → 红（`expectMutateMiss`，见 `runSelfTest`）；
  // 外加「合法锚点必须绿」「基线调回必须绿」两条放行证，证明这些锚点不是恒红。
  {
    label: "#286 符号锚点：契约 CN 把 `emitEvent` 改成 `emitEventProbe`（只改文档，修前门禁全绿）",
    overlay: { [CONTRACT_CN]: mutateSymbolAnchor("emitEvent", "src/loop/orchestrator.js", "emitEventProbe") },
    expect: [/symbol-anchor: docs\/host-consumer-contract_cn\.md:84 引用 `emitEventProbe`（`src\/loop\/orchestrator\.js`/,
      /实际存在的相近符号：.*emitEvent/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#286 符号锚点：把真值一侧的 `defaultSleep` 改名（只改源码，中英引用同时红）",
    overlay: { "src/loop/abort.js": (t) => t.replace("export function defaultSleep(", "export function defaultSleepRenamed(") },
    expect: [/symbol-anchor: .*引用 `defaultSleep`（`src\/loop\/abort\.js`/, /实际存在的相近符号：.*defaultSleepRenamed/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#286 符号锚点不是恒红（对照）：在 AGENTS EN 加一处**合法**符号锚点 → 必须 0 错",
    overlay: { [AGENTS_EN]: mentionInProse("自测探针（#286）：`defaultSleep`（`src/loop/abort.js`）是一处合法的「符号 + 文件」锚点。") },
    expectGreen: true,
  },
  {
    label: "#286 棘轮：在 AGENTS EN 临时多写一处**合法**裸行号 `src/loop/termination.js:12` → 红（新增就红，越界都没有）",
    overlay: { [AGENTS_EN]: mentionInProse("自测探针（#286）：这里临时多写一处合法裸行号引用 `src/loop/termination.js:12`。") },
    expect: [/bare-lines: 裸行号引用（唯一 \(文档,目标文件,行区间\)）实测 \*\*245\*\* 处，超过棘轮基线 \*\*244\*\*/, /AGENTS\.md 1/],
    expectFiles: [AGENTS_EN],
  },
  {
    label: "#286 棘轮下限：把 BARE_LINE_REF_BASELINE 调到 243 → 必须红（证明这个数真是锁，不是装饰）",
    overlay: { "scripts/docs-drift-check.mjs": (t) => t.replace("const BARE_LINE_REF_BASELINE = 244;", "const BARE_LINE_REF_BASELINE = 243;") },
    expect: [/实测 \*\*244\*\* 处，超过棘轮基线 \*\*243\*\*/, /把基线改成 244/],
  },
  {
    label: "#286 棘轮下限的反向证：常量调回 244（只加一句尾注释、数值不变）→ 必须 0 错",
    overlay: { "scripts/docs-drift-check.mjs": (t) => t.replace("const BARE_LINE_REF_BASELINE = 244;", "const BARE_LINE_REF_BASELINE = 244;   // self-test 复原探针") },
    expectGreen: true,
  },
  {
    label: "#286 越界必红：CN 契约的 termination.js:93-100 改成 99999-100（唯一区间数不变 → 只有越界这条红）",
    overlay: { [CONTRACT_CN]: (t) => t.split("src/loop/termination.js:93-100").join("src/loop/termination.js:99999-100") },
    expect: [/bare-lines: docs\/host-consumer-contract_cn\.md:\d+ 引用 src\/loop\/termination\.js:99999-100，但该文件只有 \d+ 行/],
    expectFiles: [CONTRACT_CN],
  },
  {
    label: "#286 豁免双条件（就地声明那一侧）：去掉 v030 EN 的外仓根 apps/worker/ → 既不再放行（245）又留下空转条目",
    overlay: { "docs/host-upgrade-guide-v030.md": (t) => t.replace("apps/worker/src/pi/runner.js:50", "src/pi/runner.js:50") },
    expect: [/实测 \*\*245\*\* 处，超过棘轮基线 \*\*244\*\*/,
      /豁免条目 `src\/pi\/runner\.js`（docs\/host-upgrade-guide-v030\.md）没有一处引用真正用到它/],
  },
  {
    label: "#286 豁免双条件（条目那一侧）：CN 契约的示例路径改成没登记的 src/a/c.js:12 → 没有条目就不放行",
    overlay: { [CONTRACT_CN]: (t) => t.replace("paths: src/a/b.js:12", "paths: src/a/c.js:12") },
    expect: [/实测 \*\*245\*\* 处，超过棘轮基线 \*\*244\*\*/,
      /豁免条目 `src\/a\/b\.js`（docs\/host-consumer-contract_cn\.md）没有一处引用真正用到它/],
  },
  {
    label: "#286 变异器空转证：靶子（不存在的符号名）打不上时，runSelfTest 必须判这一例「变异没落上」而不是假绿",
    overlay: { [CONTRACT_EN]: mutateSymbolAnchor("zzProbeNoSuchSymbol", "src/loop/orchestrator.js", "anything") },
    expectMutateMiss: true,
  },
];

/** #279：自测用例数的**下限**（只许涨不许降）。少了就是有用例被删 / 被整例跳过——那正是
 *  「拿跳过换全绿」的溃败方向，与棘轮基线同理：降下限必须写理由，不能默默降。 */
const MIN_SELF_TEST_CASES = 80;   // #286 T-a 之后共 85 例（下限留 5 例余量给并行分支）

function runSelfTest() {
  const run = () => collectAllDrift();
  const failures = [];
  const passed = [];
  // #279：**期望自己也要被看守**。「把期望放宽」就是本单要防的那个溃败方向，所以先静态校一遍：
  //   · 能匹配**空串**的期望（`.*/^/[\s\S]*/x*`）等于没有断言——拿它「永真」糊过一例就当场报红；
  //   · 既不是放行证（expectGreen）又没写 expect / expectFiles 的一例 = 整例被跳过；
  //   · 用例数低于下限 = 有用例被删。
  // 三刀都在跑变异**之前**报，以免「先全绿了再看」。变异未落上则由循环里的 `after === before` 报。
  if (SELF_TEST_CASES.length < MIN_SELF_TEST_CASES) {
    failures.push(`用例数被削：现在 ${SELF_TEST_CASES.length} 例，下限 ${MIN_SELF_TEST_CASES} 例——删用例 / 整例跳过不算修好`);
  }
  // #286 T-a：提取器自己也有一处「空转就能全绿」的形状——覆盖面或提取正则被改坏时，符号锚点会抽到
  // 0 处，于是本节所有反向证同时变成空跑。先问一句，别等用例自己变绿。
  if (!symbolAnchorOccurrences(refScanDocs()).length) {
    failures.push("symbol-anchor: 覆盖面里抽到 0 处「符号 + 文件」锚点——提取逻辑或覆盖面被改坏，"
      + "本节全部符号锚点反向证都在空跑（抽不到真值就报错，#164 口径）");
  }
  for (const [i, c] of SELF_TEST_CASES.entries()) {
    const who = c.label ?? `第 ${i + 1} 例`;
    for (const re of c.expect ?? []) {
      if (re.test("")) failures.push(`${who}：期望被削弱——正则 ${re} 连空串都匹配，等于没有断言（不许拿「永真」糊过这一例）`);
    }
    if (!c.expectGreen && !c.expectMutateMiss && !(c.expect ?? []).length && !(c.expectFiles ?? []).length) {
      failures.push(`${who}：期望被削弱——既不是放行证（expectGreen）也没写 expect / expectFiles，等于整例被跳过`);
    }
  }
  const control = run();
  if (control.length) {
    failures.push(`对照组（源码与文档都不改）本该 0 错，实测 ${control.length} 处：\n      ${control.join("\n      ")}`);
  } else {
    passed.push("对照：源码与文档都不改 → 0 错");
  }
  for (const c of SELF_TEST_CASES) {
    let ok = true;
    let missedOn = null;   // #286 T-a：变异没打上的那一处（`expectMutateMiss` 用例等的就是它）
    for (const [rel, mutate] of Object.entries(c.overlay ?? {})) {   // #280：纯树形例可以不带 overlay
      const before = read(rel);
      const after = mutate(before);
      if (after === before) { missedOn = rel; break; }
      OVERLAY.set(rel, after);
    }
    if (missedOn !== null) {
      OVERLAY.clear();
      if (c.expectMutateMiss) {
        passed.push(`${c.label} → 变异确实没落上（${missedOn}），「变异器空转也算失败」这条判据在生效`);
      } else {
        failures.push(`${c.label}：变异没落到 ${missedOn} 上（反向证自身失效：脚本里的变异体已与文档/源码脱节）`);
      }
      continue;
    }
    if (c.expectMutateMiss) {
      OVERLAY.clear();
      failures.push(`${c.label}：这一例要的就是「变异打不上」，结果打上了——靶子已存在于文档，换一个不存在的靶子`);
      continue;
    }
    // #280：有的锚点要测的不是文件**文本**而是**树形**（本机有没有那个被 .gitignore 忽略的任务档案目录）。
    // 树形用 SIM_ABSENT_TASK_ARCHIVE 这个口子模拟（只影响实物清单，声明一侧一律不动），跑完必须还原。
    const simSaved = SIM_ABSENT_TASK_ARCHIVE;
    SIM_ABSENT_TASK_ARCHIVE = !!c.simulateAbsentTaskArchive;
    let errs = [];
    let simDropped = -1;
    try {
      errs = run();
      simDropped = LAST_IGN ? repoFiles(LAST_IGN).simDropped : 0;
    } finally { SIM_ABSENT_TASK_ARCHIVE = simSaved; OVERLAY.clear(); }
    // #279 的教训：「变异没落上」的空跑会交出一条假的绿。树形口子也一样——本机确实有任务档案实物、
    // 却一个都没从清单里摘掉，就是 SIM_ABSENT_TASK_ARCHIVE 没接进 repoFiles。本机本来就没那个目录
    // （在全新 clone 里跑自测）时这一例退化成对照，不算失败。
    if (c.simulateAbsentTaskArchive && LAST_IGN && taskArchiveDirPresent(LAST_IGN) && simDropped === 0) {
      failures.push(`${c.label}：树形口子没落上（说要模拟「没有 docs/tasks/」，但实物清单一条都没摘掉）`);
      continue;
    }
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
