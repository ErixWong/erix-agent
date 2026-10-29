// issue #257 T3：静态守卫。病根是「假配置的形状由测试自己造、断言由同一个人写，于是永远碰不到
// 真形状」——真实事故是把 provider 槽位名写死成 `my-relay`，真机器上没有这个名字，`LLM_KIT_E2E=1`
// 的 4 个真实场景起跑即失败、瞎了约三周（同类：断言里调 0.8.0 已退役的 `store.recall`）。
//
// 五条规则（**取舍口径：宁可窄而真**，每条都同时断言扫描面不退化）：
//   1. examples/ test/ bin/ src/ 里不许出现**字面 provider 槽位名**；名字一律从 fixtures/config-shape.mjs 拿。
//      守卫自己也被这条管住（见「规则 1 自审」）。
//   2. 已退役的适配器/store 方法名不许再被调用（`store.recall` 那一类，出处逐条写死）。
//   3. 命令行旗标：接受集合**从 bin/cli.js 现推**（不手抄清单），凡是挂在 `erix` 命令行上的旗标
//      不在接受集合里就红；「已退役」名单同样从 CHANGELOG 现推，不手抄。
//   4. 文档里的**声称值**（`` `<CONST> = <N>` ``）必须与脚本常量对得上（issue #310；真值只从脚本
//      **自己的文本**里抽，抽不到就红）。声称面是五份：两份 AGENTS + 两份随包 README + `erix_run` 的 README
//      （issue #359 把后面三份纳进来）。第 4 条在文件末尾的独立 describe 里。
//   5. 描述 `--self-test` **当前行为**的句子不许再拿「已知假红 / known false red」冒充现状——除非同一段落
//      带时态标记（`#302 之前` / `before #302`，issue #377）。这一条专治散文：`check:docs` 校的是清单/枚举/
//      单位/路径/命令/默认值这些锚点，抓不到「这句话今天还成立吗」。第 5 条也在独立 describe 里（文件末尾）。
//
// 误报是第 3 条的头号风险（`--help`、npm/tsc/rg/pi 的参数、docs 里的历史叙述都会命中），所以
// 范围收到「只有挂在 erix 命令行上的旗标才算 erix 的旗标」，并在报告里如实写清扫了什么、豁免了什么。
//
// 本文件在 test/ 根：它自己就是测试文件。临时目录走 test/helpers/tmp.js 的 makeTmp（卫生门禁口径）。
// 绝不写真实的 ~/.erix 与 ~/.pi。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { before, describe, it } from "node:test";

import {
  ERIX_CONFIG_SLOT,
  ERIX_SLOT_CORE_KEYS,
  HISTORIC_RELAY_PROVIDER_SLOT,
  MODEL_CONFIG_ENV_NAMES,
  RELAY_ENTRY_KEYS,
  RELAY_PROVIDER_SLOT,
  createFakeConfigHome,
  erixConfigShape,
  fakeHomeEnv,
  relayModelsShape,
  relayProviderEntry,
  upstreamFields,
} from "../fixtures/config-shape.mjs";
import { createScriptedUpstream, jsonResponse } from "../fixtures/upstream.mjs";
// #546（规则 7）：白名单与 config schema 是**真值**，不另拄一张名单。
import { CONFIG_SURFACE_OPTION_NAMES, configPathForOption } from "../src/loop/config-namespace.js";
import { RUN_TOOL_LOOP_OPTION_NAMES } from "../src/loop/option-normalization.js";
import { makeTmp } from "./helpers/tmp.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SELF = relative(ROOT, new URL(import.meta.url).pathname).split("\\").join("/");

const CODE_EXTS = new Set([".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

function* walk(absDir, exts) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) yield* walk(abs, exts);
    else if (entry.isFile() && exts.has(extOf(entry.name))) yield abs;
  }
}

/** 扫描面：目录/文件 → 可扫文件（相对路径同时给出，报错信息好读）。 */
function* listScannable(exts, ...entries) {
  for (const entry of entries) {
    const abs = resolve(ROOT, entry);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      for (const file of walk(abs, exts)) yield { abs: file, rel: relative(ROOT, file).split("\\").join("/") };
    } else if (exts.has(extOf(entry))) {
      yield { abs, rel: entry.split("\\").join("/") };
    }
  }
}

/** 整行注释（含 JSDoc 续行）不算「代码里出现」——文档式注释里提名字是正当的。 */
function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("#");
}

function readLines(abs) {
  return readFileSync(abs, "utf8").split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// 规则 1：字面 provider 槽位名
// ---------------------------------------------------------------------------

/**
 * 受管名字集合：形状 B 的默认槽位名 + 事故里那个写死的名。
 * **形状 A 的 `ERIX_CONFIG_SLOT` 故意不在里面**：它的值是 `default`，在源码里是无处不在的
 * 普通词（JS 关键字、目录名、策略名），按字面量拦会淹死在误报里；形状 A 的槽位也不由命令行
 * 选择，写死它的风险面小得多。这条排除是**有意的窄**，写在这里而不是藏在代码里。
 */
const GUARDED_SLOT_NAMES = Object.freeze([RELAY_PROVIDER_SLOT, HISTORIC_RELAY_PROVIDER_SLOT]);

/** 字面槽位名的三种真会当槽位用的形状：引号字面量、`providers["名"]` 下标、erix 命令行上的槽位参数。 */
function slotLiteralMatchers(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    { re: new RegExp(`["'\`]\\s*${esc}\\s*["'\`]`), via: "引号字面量（含 `providers[\"名\"]` 下标）" },
    { re: new RegExp(`(?:--provider|-p)\\s+${esc}\\b`), via: "命令行里写死槽位名" },
    { re: new RegExp(`\\b${esc}\\b[^\\n]{0,20}?(?:--provider|-p)\\b`), via: "槽位名紧跟 provider 旗标" },
  ];
}

/**
 * 规则 1 的豁免：必须点名到**具体文件**、写**为什么**，且这轮**真的命中**（不留僵尸豁免）。
 */
const SLOT_NAME_EXEMPTIONS = Object.freeze([
  // 本轮实测：0 条。合并 PR #261 之前确实一个都没有；合并后 T4 的新增文案里出现过一次
  // （消息字符串里写死了事故名），已按本规则的口径改成从 fixtures/config-shape.mjs 的常量拿，
  // **没有开豁免**——那个文件正是事故现场，整文件放行等于把规则从最该管的地方撤走。
  // 表留着是为了「下次真需要豁免时必须点名文件 + 写理由」，下面的僵尸检查会保证
  // 它不会慢慢长成一堆整类放行。
]);

/**
 * 规则 3 的「本机档案类」豁免（issue #286 的一小半）。病根：本守卫的 `walk()` 不认
 * `.gitignore`，而 `EXEMPT_UNKNOWN_FILES` 只按**精确文件名**放行——`docs/tasks/` 里的
 * 交付报告（整目录不入库）一旦写下「当时在那台机器上跑过的 `erix … --某旗标`」，
 * 就会被规则 3 当成「文档声称 erix 接受这个旗标」而红；而逐文件点名在这种目录里没有
 * 意义（档案名每单都变）。口径：按**目录前缀 + 同句或文件头的档案声明**双条件放行，
 * 与 scripts/docs-drift-check.mjs 的 `IGNORED_DIR_CLASSES["docs/tasks/"]` /
 * `LOCAL_ARCHIVE_DECLARATION` 同一思路。既不放开整棵 docs/，也不允许只靠目录名静默放行。
 */
const LOCAL_ARCHIVE_DIRS = Object.freeze([
  {
    prefix: "docs/tasks/",
    reason: "交付档案目录：.gitignore 的目录型规则（#162 定口径、#273 纳入漂移检查面），里面的 erix 命令行是当时那台机器上的实录，不是「erix 接受该旗标」的声称",
  },
]);
const LOCAL_ARCHIVE_DECLARATION = /本机|本地|不入库|未入库|不提交|未提交|未跟踪|never committed|not committed|untracked|gitignore|忽略|归档|交付报告|工单|实录/i;

/** 纯函数口径（反向证直接拿它问）：两个信号缺任何一个都不放行。 */
function localArchiveVerdict({ rel, line = "", header = "" }) {
  const entry = LOCAL_ARCHIVE_DIRS.find((e) => rel.startsWith(e.prefix));
  if (entry === undefined) return { exempt: false, why: "不在本机档案目录里" };
  if (LOCAL_ARCHIVE_DECLARATION.test(line) || LOCAL_ARCHIVE_DECLARATION.test(header)) {
    return { exempt: true, why: entry.reason };
  }
  return { exempt: false, why: "同句与文件头都没有「本机/归档/不入库」这类声明" };
}

/**
 * 规则 3 的「别家工具旗标」口径（issue #457）。病根与 #286 同一条：`walk()` 不认 `.gitignore`，
 * 而 `docs/tasks/` 里的工单草稿与 `docs/delivery/` 里的交付报告**整目录不入库**。草稿里写下
 * `const argv = ["rg", "--include", …]` 这一类 JS 字符串时，那一行没有 `erix` 命令词、只靠
 * `ARGV_CONTEXT_RE`（argv/args/push/spawn…）进到扫描面，于是 **ripgrep/tsc/npm 的旗标被当成
 * 「erix 接受这个旗标」**而咬红。它最坑的地方是**只在作者机器上红**：干净检出里根本没有这两个
 * 目录，CI 与刚合进来的 `main` 都是绿的 ⇒ 症状被误读成「合并带回了回归」。
 *
 * 口径（与 `LOCAL_ARCHIVE_DIRS` 同一思路，两道条件缺一不可）：
 *   ① 路径在**已知本机档案/草稿目录**里（目录前缀，不放开整棵 docs/）；
 *   ② 命中那一行**没有** `erix` 命令词——同一行真挂了 erix 就仍然是「声称 erix 接受」，照红。
 * 放宽是**可数的**：命中进 `toolFlags` 桶（`status: "other-tool-flag"`），debug 口径与扫描面断言
 * 都看得到处数，所以它不会悄悄长成「整目录免检」。档案目录里写了 `erix … --某旗标` 的行仍然要
 * 档案声明（`localArchiveVerdict`），那条口径一字未动。
 */
const NON_ERIX_FLAG_DIRS = Object.freeze([
  {
    prefix: "docs/tasks/",
    reason: "工单草稿目录：.gitignore 的目录型规则，草稿里的 argv 数组是当时那台机器上的工具命令行（rg/tsc/npm 居多），不是 erix 的旗标声称",
  },
  {
    prefix: "docs/delivery/",
    reason: "交付报告落点：与 docs/tasks/ 同口径不入库，报告里引用的复现命令行同样混着别家工具",
  },
]);

/** 纯函数口径（反向证直接拿它问）：目录条件与「该行没有 erix 命令词」缺一不可。 */
function nonErixToolFlagVerdict({ rel, erixLine }) {
  if (erixLine) return { exempt: false, why: "同一行有 erix 命令词：那是真的在往 erix 命令行上挂旗标" };
  const entry = NON_ERIX_FLAG_DIRS.find((e) => rel.startsWith(e.prefix));
  if (entry === undefined) return { exempt: false, why: "不在本机档案/草稿目录里" };
  return { exempt: true, why: entry.reason };
}

/**
 * 规则 3 的「已知不是 erix 旗标」豁免：同样只按**确切文件名**放行，逐条带理由，不允许 glob/目录。
 * 只收一类：提案 / 评审意见文档——它们写的是「建议加这个旗标」，不是「erix 接受这个旗标」。
 */
const EXEMPT_UNKNOWN_FILES = Object.freeze([
  {
    file: "docs/suggestions/comment-on-179.md",
    reason: "提案/评审意见文档：出现处是「An optional `--root-only` flag makes…」（建议加，不是已实现）；该旗标在 bin/cli.js 与 CHANGELOG 里都不存在",
  },
]);

// ---------------------------------------------------------------------------
// 规则 2：已退役的适配器 / store 方法名
// ---------------------------------------------------------------------------

/**
 * 每条都写清「退役于哪个 issue/版本口径」与出处符号（**不写行号**）。出处都是仓内可查的文本：
 * CHANGELOG 的退役条目、README/契约里写明的「recall 适配器已在 0.8.0 契约中退役」。
 */
const RETIRED_ADAPTER_METHODS = Object.freeze([
  {
    method: "recall",
    source: "CHANGELOG「退役 recall 工具与 bounded-recall 协议（issue #36）」+ README/docs/host-consumer-contract.md（recall 适配器已在 0.8.0 契约中退役）",
  },
  {
    method: "boundedRecall",
    source: "CHANGELOG 同一条：「宿主如依赖 `boundedRecall` 公共导出或 recall 工具需改造为 note 工作流」（issue #36）",
  },
  {
    method: "recordAutoCapture",
    source: "CHANGELOG「删除 `recordAutoCapture()`（issue #67 PR 3，ADR-016 收尾）」",
  },
  {
    method: "captureToolExecution",
    source: "CHANGELOG「auto-capture 退役：`bin/auto-capture.js` 删除」+ ADR-016（可重放概念退役，见 test/capture-honesty.test.js 头注）",
  },
]);

/**
 * 现役 memory store 的 API（事故里「有 recall 没有」的那一份名单，抄自 CHANGELOG 的 #257 条目）。
 * 用途只有两个：① 证明本规则的匹配器**不会误报现役名**；② 名单本身要能在 src/ 里查到，
 * 免得这份「反误报样本」自己腐化成编造。
 */
const CURRENT_STORE_API = Object.freeze([
  "appendRound", "load", "markRunState", "saveRunState", "saveRunSnapshot", "loadLatestRunSnapshot",
  "saveCheckpoint", "appendCheckpoint", "loadLatestCheckpoint", "loadRunState", "loadRunStateStatus",
]);

/** 匹配器：只认「方法调用」这一种形状（`.name(`），单词本身不算——注释、散文、工具名都不算。 */
function retiredCallHits(line, method) {
  return new RegExp(`\\.${method}\\s*\\(`, "g").test(line) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 规则 3：命令行旗标
// ---------------------------------------------------------------------------

/** 接受集合：bin/cli.js 文本里出现的长旗标（解析表 + `--help` 文案都在里面，宁松不紧）。 */
function parseAcceptedFlags() {
  const src = readFileSync(resolve(ROOT, "bin/cli.js"), "utf8");
  return new Set([...src.matchAll(/--+[A-Za-z][A-Za-z0-9-]{1,}/g)].map((m) => m[0]));
}

/**
 * 「已退役」名单**从 CHANGELOG 现推**，不手抄：要求**退役动词与反引号旗标相邻**（同一小句内，
 * 中间不超过 12 个非句读字符），而不是「整行提过退役就算」——CHANGELOG 的条目常常一整段写在
 * 一行里，按整行算会把别家工具的旗标也算成 erix 退役旗标（实测：tsc 的 `--checkJs` 就在一条
 * 写了「待退役选项」的长行里）。再要求它当前不在接受集合里（在就说明没退役）。
 * 这样新增退役条目不需要改守卫，也抄不出假名字。实测口径下推出的唯一条目是 `--notes-ledger`
 * （CHANGELOG：「移除 `--notes-ledger`、`ERIX_NOTES_LEDGER` …」，issue #74）。
 * ⚠ 这里曾写成 `` `(^[A-Za-z]…)` ``：那个 `^` 是**锚点**而不是字面量，正则永远碰不到，
 * 名单静默恒空——下面那条非空断言就是为了让这种死法当天变红。
 */
function deriveRetiredFlags(accepted) {
  const changelog = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8");
  const out = [];
  for (const line of changelog.split(/\r?\n/)) {
    if (!/退役|删除|移除/.test(line)) continue;
    // 两种词序都认：「移除 `--x`」与「`--x` 已删除」
    const re = /(?:移除|退役|删除|去掉)[^。；，\n]{0,12}?`(--[A-Za-z][A-Za-z0-9-]{1,})`|`(--[A-Za-z][A-Za-z0-9-]{1,})`[^。；，\n]{0,12}?(?:被|已)?(?:移除|退役|删除)/g;
    for (const m of line.matchAll(re)) {
      const flag = m[1] ?? m[2];
      if (!accepted.has(flag) && !out.some((e) => e.flag === flag)) {
        out.push({ flag, evidence: line.trim().slice(0, 120) });
      }
    }
  }
  return out;
}

/**
 * 哪些行算「erix 的命令行」。这是本条规则的全部收窄口径，写死在这里：
 *   - 文档（.md）：整行必须出现 `erix` 这个命令词（`erix chat …` / `` `erix --config` ``）。
 *     别家 CLI（npm/tsc/rg/node/pi/gh）的旗标行没有这个词，**结构上就不可能**被误报。
 *   - examples 代码：只有把旗标真的传给被调程序的那行才算——需要出现 argv/args/spawn/execFile/
 *     push("…--…") 之类的 argv 上下文，**或**该行同时提到 erix。
 * 代价如实写进报告：不挂在 erix 命令行上的 erix 旗标（例如只在散文里提一句）本规则看不见。
 */
const ERIX_COMMAND_RE = /(^|[\s`$>"'|])erix(\s|$|[`"'])/i;
const ARGV_CONTEXT_RE = /\b(argv|args|spawnSync|spawn\(|execFile|execFileSync|runCli|command|push)\b/;

/**
 * 否定句里的旗标**不是**「声称 erix 接受这个旗标」。实测误报就是这一类：
 * `README_cn.md` 与 `docs/host-upgrade-guide-0.19.0*.md` 都写着「**没有 `--resume` 这个旗标**」
 * （英文版「there is **no `--resume` flag**」），同一行里又出现 `erix chat -r`，所以光靠
 * 「整行要有 erix 词」拦不住——不拦就得给整个 README_cn.md 开豁免，那太贵。
 * 口径：只看旗标**前 24 个字符**，去掉 markdown 强调符/引号/空白后，必须以否定词收尾
 * （中文：没有/不存在/并非/不是/不再有/不含/无；英文整词：no/not/never/without）。
 * 故意只往回看、不往后看：「用 --x 而不是 --y」这类句子中后面的 --y 才是真实意图的反面，
 * 而它前面没有否定词→依旧计红，方向是**偏严**。
 */
const NEGATION_TAIL_RE = /(?:没有|不存在|并非|不是|不再有|不含|无|(?:^|[\s,，。;；:!?])(?:no|not|never|without))\s*$/u;

function isNegatedMention(line, flagStart) {
  // 只抹 markdown 强调符与引号（**没有 ` → 没有），空白要留着当英文否定词的词界
  const window = line.slice(Math.max(0, flagStart - 24), flagStart).replace(/[*_`"]/g, "");
  return NEGATION_TAIL_RE.test(window);
}

/** 测试用：拿「整行 + 旗标」直接问口径（下标自己找，免得用例里写死位置）。 */
function negationProbe(line, flag) {
  const at = line.indexOf(flag);
  return at >= 0 && isNegatedMention(line, at);
}

function flagMentions({ rel, abs }, accepted, retired) {
  const mentioned = [];
  const unknown = [];
  const localArchive = [];
  const toolFlags = [];
  const isDoc = extOf(rel) === ".md";
  // 本机档案类的「文件头声明」信号：只看前 15 行（档案目录里的报告会把「本机不入库」写在开头）
  const allLines = readLines(abs);
  const header = allLines.slice(0, 15).join("\n");
  allLines.forEach((line, index) => {
    if (isCommentLine(line)) return;
    const erixLine = ERIX_COMMAND_RE.test(line);
    if (!erixLine && !(isDoc || !isDoc)) return;
    if (!isDoc && !erixLine && !ARGV_CONTEXT_RE.test(line)) return;
    if (isDoc && !erixLine) return;
    for (const m of line.matchAll(/(^|[\s"'`=])((?:--)[A-Za-z][A-Za-z0-9-]{1,})/g)) {
      const flag = m[2];
      if (isNegatedMention(line, m.index + m[1].length)) {
        mentioned.push({ flag, rel, line: index + 1, status: "negated" });
        continue;
      }
      if (accepted.has(flag)) { mentioned.push({ flag, rel, line: index + 1, status: "accepted" }); continue; }
      if (retired.some((e) => e.flag === flag)) {
        // 退役旗标**只在文档里豁免**：docs / README 提历史叙述是正当的；examples/ 的 erix 命令行上
        // 再出现退役旗标就是「示例没跟上」，那正是本规则要抓的东西（工单反向证 3）。
        if (isDoc) {
          mentioned.push({ flag, rel, line: index + 1, status: "retired" });
          continue;
        }
        mentioned.push({ flag, rel, line: index + 1, status: "unknown" });
        unknown.push({ flag, rel, line: index + 1, text: line.trim().slice(0, 160), retiredInDocs: true });
        continue;
      }
      // issue #457：本机档案/草稿目录里、且同一行没有 erix 命令词的命中（只有 argv 上下文）
      // 是别家工具的旗标，不算「erix 接受这个旗标」；仍然计数，不静默吞掉。
      const toolFlag = nonErixToolFlagVerdict({ rel, erixLine });
      if (toolFlag.exempt) {
        mentioned.push({ flag, rel, line: index + 1, status: "other-tool-flag" });
        toolFlags.push({ flag, rel, line: index + 1 });
        continue;
      }
      if (EXEMPT_UNKNOWN_FILES.some((e) => e.file === rel)) {
        mentioned.push({ flag, rel, line: index + 1, status: "exempted" });
        continue;
      }
      if (isDoc && localArchiveVerdict({ rel, line, header }).exempt) {
        mentioned.push({ flag, rel, line: index + 1, status: "local-archive" });
        localArchive.push({ flag, rel, line: index + 1 });
        continue;
      }
      mentioned.push({ flag, rel, line: index + 1, status: "unknown" });
      unknown.push({ flag, rel, line: index + 1, text: line.trim().slice(0, 160) });
    }
  });
  return { mentioned, unknown, localArchive, toolFlags };
}

// ---------------------------------------------------------------------------
// 真起 CLI 子进程（环境纪律与 fixtures/config-shape.mjs#fakeHomeEnv 一致）
// ---------------------------------------------------------------------------

/**
 * 异步跑一次 CLI。**不能用 spawnSync**：假上游就在本进程里，同步阻塞事件循环会让它收不到
 * 任何请求（实测：子进程挂到超时 ETIMEDOUT、上游 0 发）。
 */
function runErix(home, args) {
  const env = fakeHomeEnv(process.env, {
    home,
    extra: {
      PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LLM_KIT_RETRY_MAX_WAIT_MS: "1",
    },
  });
  // 代理会把环回请求带走，所以跟 test/cli-process.test.js 一样清掉，并把环回地址排除在外。
  const PROXY_VARS = [
    "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
  ];
  for (const key of PROXY_VARS) delete env[key];
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [resolve(ROOT, "bin/cli.js"), ...args], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolveRun({ status, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ status: null, signal: null, stdout, stderr: `${stderr}\nspawnError=${error.message}` });
    });
  });
}

/** 工单口径是 `README*`：根目录全部 README 开头的 markdown 都扫（`README.md` 与 `README_cn.md`）——
 * 只写死 `README.md` 会把中文那份的整批命令行整段放掉，而它同样会被人复制去跑。 */
function readmeEntries() {
  return readdirSync(ROOT).filter((name) => /^README[^/]*\.md$/i.test(name)).sort();
}

// ---------------------------------------------------------------------------

describe("静态守卫：真配置形状与退役名（issue #257 T3）", () => {
  let accepted = new Set();
  let retired = [];
  let mentions = [];
  let unknown = [];
  let localArchive = [];
  let toolFlags = [];

  before(() => {
    accepted = parseAcceptedFlags();
    retired = deriveRetiredFlags(accepted);
    localArchive = [];
    toolFlags = [];
    for (const file of listScannable(new Set([...CODE_EXTS, ".md"]), "examples", "docs", ...readmeEntries())) {
      const scan = flagMentions(file, accepted, retired);
      mentions.push(...scan.mentioned);
      unknown.push(...scan.unknown);
      localArchive.push(...(scan.localArchive ?? []));
      toolFlags.push(...(scan.toolFlags ?? []));
    }
  });

  // ---- 规则 1 -------------------------------------------------------------

  it("规则 1：examples/ test/ bin/ src/ 里没有字面 provider 槽位名", () => {
    assert.ok(GUARDED_SLOT_NAMES.length >= 2, "受管槽位名少于 2 个，本规则会假绿");
    const offenders = [];
    const hits = [];
    for (const { abs, rel } of listScannable(CODE_EXTS, "examples", "test", "bin", "src")) {
      readLines(abs).forEach((line, index) => {
        if (isCommentLine(line)) return;
        for (const name of GUARDED_SLOT_NAMES) {
          for (const { re, via } of slotLiteralMatchers(name)) {
            if (!re.test(line)) continue;
            hits.push(`${rel}|${name}`);
            if (!SLOT_NAME_EXEMPTIONS.some((e) => e.file === rel)) {
              offenders.push(`${rel}:${index + 1}: 字面槽位名 ${name}（${via}）：${line.trim().slice(0, 140)}`);
            }
          }
        }
      });
    }
    // 扫描面自检：豁免项必须真的被扫到，否则说明口径已经看不见它（规则会假绿）
    const hitSet = new Set(hits);
    for (const entry of SLOT_NAME_EXEMPTIONS) {
      assert.ok(
        GUARDED_SLOT_NAMES.some((n) => hitSet.has(`${entry.file}|${n}`)),
        `豁免表里的 ${entry.file} 这轮一个字面槽位名都没命中——口径退化或豁免该删`,
      );
    }
    assert.deepEqual(
      offenders,
      [],
      "字面 provider 槽位名会让「换一台机器/换一个槽位」的测试直接瞎掉（事故：写死一个机器专属槽位名，瞎了约三周）。"
      + `名字请从 fixtures/config-shape.mjs 的常量拿；确实必须出现这个名字的，进 SLOT_NAME_EXEMPTIONS 并写理由：\n  `
      + offenders.join("\n  "),
    );
  });

  it("规则 1 自审：守卫自己被这条规则管住（名字从构造器拿，源码里不写字面量）", () => {
    const src = readFileSync(resolve(ROOT, SELF), "utf8");
    const codeLines = src.split(/\r?\n/).filter((line) => !isCommentLine(line));
    for (const name of GUARDED_SLOT_NAMES) {
      const inCode = codeLines.filter((line) => line.includes(name)).length;
      assert.equal(inCode, 0, `守卫自己的代码里出现了槽位名 ${name}（${inCode} 行）：它必须只用常量`);
    }
    assert.ok(
      !SLOT_NAME_EXEMPTIONS.some((e) => e.file === SELF),
      "守卫不该给自己开豁免：它一个字面槽位名都不该有",
    );
    // 构造器那边也必须真的把名字藏起来了（只看非注释行：文档里提这个名字是正当的）
    const shapeCode = readFileSync(resolve(ROOT, "fixtures/config-shape.mjs"), "utf8")
      .split(/\r?\n/).filter((line) => !isCommentLine(line)).join("\n");
    for (const name of GUARDED_SLOT_NAMES) {
      assert.ok(
        !new RegExp(`["'\`]${name}["'\`]`).test(shapeCode),
        `构造器的代码里还有 ${name} 的字面量：常量的 join 写法被改掉了，守卫的自审前提失效`,
      );
    }
  });

  // ---- 规则 2 -------------------------------------------------------------

  it("规则 2：没有代码再调已退役的适配器 / store 方法名", () => {
    assert.ok(RETIRED_ADAPTER_METHODS.length >= 1, "退役方法名清单为空，本规则会假绿");
    for (const entry of RETIRED_ADAPTER_METHODS) {
      assert.ok(entry.source.length >= 20, `${entry.method} 的退役出处太短：${entry.source}`);
    }
    const violations = [];
    for (const { abs, rel } of listScannable(CODE_EXTS, "examples", "test", "bin", "src")) {
      readLines(abs).forEach((line, index) => {
        if (isCommentLine(line)) return;
        for (const { method, source } of RETIRED_ADAPTER_METHODS) {
          if (retiredCallHits(line, method)) {
            violations.push(`${rel}:${index + 1}: 仍在调 .${method}()（退役出处：${source}）`);
          }
        }
      });
    }
    assert.deepEqual(
      violations,
      [],
      `已退役的适配器方法名又回到代码里（事故原形：store.recall is not a function，被默认 skip 掩护约三周）：\n  `
      + violations.join("\n  "),
    );
  });

  it("规则 2 的匹配器：现役 API 不误报、退役调用必报，且退役名确实已从 src/ 消失", () => {
    const currentCalls = CURRENT_STORE_API.map((m) => `  const x = await store.${m}(runId);`).join("\n");
    for (const { method } of RETIRED_ADAPTER_METHODS) {
      assert.equal(retiredCallHits(currentCalls, method), 0, `现役 API ${method} 被误判成退役调用`);
    }
    // 现役名单要还能在 src/ 里查到——否则上面那条「不误报」断言是在跟空气比
    const srcText = [...listScannable(CODE_EXTS, "src")].map((f) => readFileSync(f.abs, "utf8")).join("\n");
    for (const name of CURRENT_STORE_API) {
      assert.match(srcText, new RegExp(`${name}\\s*[:(]`), `现役 store API ${name} 在 src/ 里查不到了：名单已过期`);
    }
    for (const { method } of RETIRED_ADAPTER_METHODS) {
      assert.ok(
        !new RegExp(`\\.${method}\\s*\\(`).test(srcText),
        `src/ 里又出现 .${method}()——它没退役（或本表该删这一条），请把出处核对一遍`,
      );
    }
    // 正证：事故那一行必须被抓到（名字用拼接写，否则本文件自己会被规则 2 抓到）
    const accidentLine = `  const r = await store.${"re" + "call"}(runId, undefined, undefined, "exec");`;
    assert.equal(retiredCallHits(accidentLine, "recall"), 1);
  });

  // ---- 规则 3 -------------------------------------------------------------

  it("规则 3 前置：接受集合是从 bin/cli.js 现推的（非空、含关键旗标）", () => {
    assert.ok(accepted.size >= 15, `从 bin/cli.js 只推出 ${accepted.size} 个旗标，口径可能退化`);
    for (const flag of ["--help", "--version", "--config", "--session", "--max-rounds", "--tools"]) {
      assert.ok(accepted.has(flag), `接受集合里没有 ${flag}：解析方式失效，规则 3 不可信`);
    }
    // 否定句口径的对照（本轮实测误报就出在这一类）：说「没有这个旗标」不算声称接受，
    // 而正面写 erix 用这个旗标必须仍算——否则这条豁免会把真问题全放掉。
    assert.equal(
      negationProbe("要看有哪些能续用 `erix chat -r`（需 TTY，**没有 `--resume` 这个旗标**）", "--resume"),
      true,
      "中文否定句没被认出：README_cn.md / docs 的那批「没有 --resume 这个旗标」会变成天天误报",
    );
    assert.equal(negationProbe("there is **no `--resume` flag**, see erix chat -r", "--resume"), true);
    assert.equal(negationProbe("erix chat --resume <id> 续会话", "--resume"), false, "正面用法被否定句口径误放行");
    assert.equal(negationProbe("`erix chat --resume` 已废弃", "--resume"), false, "「已废弃」不在否定词表里，应当仍计工单口径的未知旗标");
  });

  it("规则 3：挂在 erix 命令行上的旗标必须被 bin/cli.js 接受", () => {
    assert.deepEqual(
      unknown.map((u) => `${u.rel}:${u.line} 旗标 ${u.flag}：${u.text}`),
      [],
      "这些旗标出现在 erix 命令行上，却不在 bin/cli.js 的接受集合里：要么旗标已退役/写错（该改用现役名），"
      + "要么文档/示例跑在了实现前面。本规则**没有**手抄白名单，只有从 CHANGELOG 推出的退役名单：\n  "
      + unknown.map((u) => `${u.rel}:${u.line} ${u.flag}`).join("\n  "),
    );
  });

  it("规则 3 的本机档案类豁免：目录 + 声明双条件，缺一即红（issue #286 的一小半，自带反向证）", () => {
    for (const entry of LOCAL_ARCHIVE_DIRS) {
      assert.ok(entry.prefix.endsWith("/"), `本机档案类必须按目录放行，不许退回逐文件点名：${entry.prefix}`);
      assert.ok(entry.reason.trim().length >= 20, `${entry.prefix} 的豁免理由太短`);
    }
    // 口径本体（纯函数）：两个信号缺任何一个都不放行
    assert.equal(localArchiveVerdict({ rel: "docs/tasks/x.md", line: "交付报告（本机不入库）：erix chat --unknown-probe-261015" }).exempt, true);
    assert.equal(localArchiveVerdict({ rel: "docs/tasks/x.md", line: "erix chat --unknown-probe-261015" }).exempt, false,
      "档案目录里没有档案声明就放行 = 整目录被静默吞掉（正是本单要堵的形状）");
    assert.equal(localArchiveVerdict({ rel: "docs/host-consumer-contract.md", line: "交付报告（本机不入库）：erix chat --unknown-probe-261015" }).exempt, false,
      "非档案目录不得靠措辞逃逸");

    // 端到端反向证：在 docs/tasks/ 真的落两个临时文件走一遍扫描口径，用完即删（不留在树里）
    const dir = resolve(ROOT, "docs/tasks");
    const made = [];
    // ⚠ 「用完即删」必须把**目录本身**也算进去：干净检出（CI / 全新 clone）里这个目录本来不存在，
    // 下面的 `mkdirSync(…, { recursive: true })` 会把它**造**出来。以前只删自己写的两个文件，空目录留在树里，
    // 于是同一棵树里稍后跑的 `docs-drift-check --self-test` 看到「docs/tasks/ 在场但里面一条实物都没有」，
    // 报「树形口子没落上」——**#302 之前**那会让自测红数从 3 抬到 5（CI 里就是这么被抬上去的，同属 issue #281
    // 那一族的假红）；#302 起树形用例跑在合成树夹具上，与真树有没有 `docs/tasks/` 无关（干净检出实测 103 例全 ✓），
    // 所以现在这条只是「别把自己造的东西留在树里」，不再改判据。
    // 修法只有一条：谁造的目录谁删。开发树里该目录本来就在（且里面有实物）⇒ dirWasAbsent=false，一律不碰。
    const dirWasAbsent = !existsSync(dir);
    const probe = (name, body) => {
      const abs = join(dir, name);
      const rel = relative(ROOT, abs).split("\\").join("/");
      made.push(abs);
      writeFileSync(abs, body, "utf8");
      return flagMentions({ rel, abs }, accepted, retired);
    };
    try {
      mkdirSync(dir, { recursive: true });
      const declared = probe("261015-03-proof-declared.md",
        "# 交付报告（本机，不入库）\n\n实测命令 `erix` 的守卫跑法：node scripts/docs-drift-check.mjs --self-probe-261015\n");
      assert.equal(declared.unknown.length, 0, `带档案声明的交付档案不该算工单：${JSON.stringify(declared.unknown)}`);
      assert.equal(declared.localArchive.length, 1, "豁免必须留下可数的命中，否则僵尸豁免会放掉以后的真问题");
      const undeclared = probe("261015-03-proof-undeclared.md",
        "# 随手记\n\n实测命令 `erix` 的守卫跑法：node scripts/docs-drift-check.mjs --self-probe-261015\n");
      assert.equal(undeclared.unknown.length, 1, "反向证：档案声明缺失时必须仍然红");
      assert.equal(undeclared.localArchive.length, 0);
      // 反向证不靠环境里恰好有档案文件：本轮真实扫描面里若有档案目录命中，也必须是 local-archive 而非 unknown
      assert.ok(localArchive.every((h) => h.rel.startsWith("docs/tasks/")), JSON.stringify(localArchive));
    } finally {
      for (const abs of made) rmSync(abs, { force: true });
      // rmdirSync（不是 rmSync recursive）：只能删空目录，因而不可能误删开发树里有实物的任务档案。
      if (dirWasAbsent) {
        try { rmdirSync(dir); } catch { /* 非空 = 里面有别人的东西，不碰 */ }
      }
    }
    // 反向证（只在干净树里可从）：把上面那行 rmdirSync 删掉就必须红——空目录留在仓树里不只难看，
    // 而且它是本测试自己造的（谁造的谁删；#302 之前它还会改同树里 docs-drift-check --self-test 的红数）。
    if (dirWasAbsent && existsSync(dir)) {
      assert.fail(`探针在干净树里造的 ${relative(ROOT, dir)}/ 没跟着探针一起消失（谁造的目录谁删）；`
        + "#302 之前这会把同树里 docs-drift-check --self-test 的红数从 3 抬到 5，现在那条耦合已经断了，"
        + "但把自己造的东西留在仓树里仍然是本测试自己的卫生问题");
    }
  });

  it("规则 3 的扫描面不是空转（覆盖数掉了说明口径被改窄到看不见东西）", () => {
    if (process.env.ERIX_GUARD_DEBUG === "1") {
      console.log(JSON.stringify({
        acceptedFlags: accepted.size,
        derivedRetiredFlags: retired.map((r) => r.flag),
        mentions: mentions.length,
        unknown: unknown.length,
        byFile: [...new Set(mentions.map((m) => m.rel))].sort(),
      }, null, 1));
    }
    assert.ok(
      mentions.length >= 25,
      `本轮只扫到 ${mentions.length} 次 erix 命令行旗标提及（本单落地时实测见报告）——范围退化会让守卫假绿`,
    );
    // 豁免表健康：每条都有理由、点名到文件、且本轮**真的扇到**（僵尸豁免会放掉以后的真问题）
    for (const entry of EXEMPT_UNKNOWN_FILES) {
      assert.ok(entry.reason.trim().length >= 20, `${entry.file} 的豁免理由太短`);
      assert.ok(existsSync(resolve(ROOT, entry.file)), `豁免指向的文件不存在：${entry.file}`);
      assert.ok(
        mentions.some((m) => m.rel === entry.file && m.status === "exempted"),
        `豁免 ${entry.file} 本轮一条都没扇到：删掉它，别留僵尸豁免`,
      );
    }
    const hitDirs = new Set(mentions.map((m) => m.rel.split("/")[0]));
    // README 这一面不能空转：中文那份同样有人群复制（本轮实测 README_cn.md 有命中）
    for (const name of readmeEntries()) {
      assert.ok(
        mentions.some((m) => m.rel === name),
        `旗标扫描在 ${name} 上零命中（当前命中：${[...hitDirs].join(", ")}）：口径被改窄`,
      );
    }
    for (const want of ["docs"]) {
      assert.ok(hitDirs.has(want), `旗标扫描在 ${want} 上零命中（当前命中：${[...hitDirs].join(", ")}）：口径被改窄`);
    }
    // issue #457：放宽面必须是**可数的**——所有 other-tool-flag 命中都只能在已知草稿目录里
    for (const hit of toolFlags) {
      assert.ok(
        NON_ERIX_FLAG_DIRS.some((e) => hit.rel.startsWith(e.prefix)),
        `toolFlags 里出现草稿目录之外的命中：${hit.rel}:${hit.line}`,
      );
    }
  });

  it("规则 3 的「别家工具旗标」口径（issue #457）：草稿目录里 argv 里的 rg/tsc 旗标不咬红，写了 erix 的仍咬", () => {
    assert.equal(
      NON_ERIX_FLAG_DIRS.every((entry) => entry.reason.length >= 20), true,
      "每条草稿目录口径都必须写清为什么（>=20 字符）",
    );
    // 纯函数口径：两道条件缺一不可
    assert.equal(nonErixToolFlagVerdict({ rel: "docs/tasks/x.mjs", erixLine: false }).exempt, true);
    assert.equal(
      nonErixToolFlagVerdict({ rel: "docs/tasks/x.mjs", erixLine: true }).exempt, false,
      "同一行有 erix 命令词 ⇒ 不放宽：那是真的在往 erix 命令行上挂旗标",
    );
    assert.equal(
      nonErixToolFlagVerdict({ rel: "examples/x.mjs", erixLine: false }).exempt, false,
      "只按目录前缀放宽：examples/ 与 docs/ 其他位置照旧红",
    );
    // 端到端探针：落在真被扫描、且整目录不入库的 docs/tasks/ 里跑一遍（与 #286 那一格同形）
    const dirRel = "docs/tasks/";
    const dirAbs = resolve(ROOT, dirRel);
    const dirWasAbsent = !existsSync(dirAbs);
    const written = [];
    const probe = (name, lines) => {
      const rel = `${dirRel}${name}`;
      writeFileSync(resolve(ROOT, rel), `${lines.join("\n")}\n`, "utf8");
      written.push(rel);
      return flagMentions({ rel, abs: resolve(ROOT, rel) }, accepted, retired);
    };
    try {
      // 整目录不入库 ⇒ 干净检出（CI / 全新 clone）里 `docs/tasks/` 本来就不存在，第一笔 `writeFileSync`
      // 直接 ENOENT（#461 的 CI 实测：本机有草稿所以看不见，#459 那轮 CI 同样是被它抬红的）。
      // 上面 #286 那一格早就有这一步（见其注释「谁造的目录谁删」），这格漏了；目录自己造，
      // 收尾的 `rmdirSync(dirAbs)` 与已记好的 `dirWasAbsent` 正好配对。
      mkdirSync(dirAbs, { recursive: true });
      // ① 只有 argv 上下文、没有 erix 词 ⇒ 不红，但**计数**（不静默吞掉）
      const tool = probe("261024-457-tool-flag.mjs", [
        "export const argv = [\"rg\", \"--include-probe-261024\", \"src\"];",
      ]);
      assert.equal(tool.unknown.length, 0, JSON.stringify(tool.unknown));
      assert.equal(tool.toolFlags.length, 1, JSON.stringify(tool.toolFlags));
      assert.equal(tool.toolFlags[0].flag, "--include-probe-261024");
      // ② 反向证：同一行挂了 erix ⇒ 仍然红（放宽不等于整目录免检）
      const erix = probe("261024-457-erix-line.mjs", [
        "export const argv = [\"erix\", \"chat\", \"--erix-probe-261024\"];",
      ]);
      assert.equal(erix.toolFlags.length, 0, JSON.stringify(erix.toolFlags));
      assert.equal(erix.unknown.length, 1, JSON.stringify(erix.unknown));
      // ③ 反向证：同一个形状换个不在草稿目录里的路径 ⇒ 仍不放宽
      assert.equal(
        flagMentions(
          { rel: "examples/261024-457-outside.mjs", abs: resolve(ROOT, "docs/tasks/261024-457-tool-flag.mjs") },
          accepted, retired,
        ).unknown.length,
        1,
        "同样的 argv 行换成 examples/ 路径必须仍红——否则放宽长到了目录外",
      );
    } finally {
      for (const rel of written) {
        try { rmSync(resolve(ROOT, rel), { force: true }); } catch { /* 探针没落盘，不用清理 */ }
      }
      if (dirWasAbsent) { try { rmdirSync(dirAbs); } catch { /* 里面有本机档案，不归本探针管 */ } }
    }
  });

  it("规则 3 的退役名单是推导出来的，且每条都真的不被接受", () => {
    const acceptedSrc = readFileSync(resolve(ROOT, "bin/cli.js"), "utf8");
    for (const entry of retired) {
      assert.ok(entry.evidence.length >= 20, `${entry.flag} 的退役证据行太短：${entry.evidence}`);
      assert.ok(!accepted.has(entry.flag), `${entry.flag} 在 bin/cli.js 里还存在，说明它没退役`);
      assert.ok(!acceptedSrc.includes(entry.flag), `${entry.flag} 仍在 bin/cli.js 文本里（含 --help 文案）`);
    }
    // 名单必须非空：CHANGELOG 里现成有「移除 `--notes-ledger`」（issue #74），所以推出 0 条
    // 不是「今天恰好没东西退役」，而是**推导器自己是死的**（实测：本单曾把退役正则写成带 `^`
    // 锚点的形式，命中永远为 0，名单静默恒空而全量依旧绿）。这条断言就是补那个坑。
    assert.ok(
      retired.length >= 1,
      `从 CHANGELOG 推出的退役旗标名单为空（接受集合 ${accepted.size} 个），推导器可能已死：`
      + "核对 deriveRetiredFlags 的动词邻接口径与 CHANGELOG 里的「移除 `--旗标`」写法",
    );
    for (const entry of retired) {
      assert.match(entry.flag, /^--[A-Za-z][A-Za-z0-9-]{1,}$/);
    }
  });

  // ---- 构造器接线（防 (a) 变成死代码 / 防字段名再写反） ---------------------

  it("形状 A（~/.erix/config.json）被 bin/config.js#loadCliConfig 真读出来", async () => {
    const { loadCliConfig } = await import("../bin/config.js");
    const saved = new Map(MODEL_CONFIG_ENV_NAMES.map((n) => [n, process.env[n]]));
    for (const name of MODEL_CONFIG_ENV_NAMES) delete process.env[name];
    const home = await makeTmp("erix-shape-a-");
    try {
      const written = await createFakeConfigHome({
        dir: home,
        erix: {
          endpoint: "https://shape-a.invalid/v1",
          apiKey: "k-shape-a",
          model: "m-shape-a",
          maxOutputTokens: 4096,
          contextWindowTokens: 200_000,
        },
      });
      const config = await loadCliConfig({ configPath: written.configPath });
      assert.equal(config.endpoint, "https://shape-a.invalid/v1");
      assert.equal(config.apiKey, "k-shape-a");
      assert.equal(config.model, "m-shape-a");
      assert.equal(config.maxOutputTokens, 4096);
      assert.equal(config.contextWindowTokens, 200_000);

      // 端点字段写成 baseUrl 就是「假配置形状错」最常见的写法错误：构造器必须先抛，
      // 真读取方也必须读不到端点（而不是静默用别的值）。
      assert.throws(() => erixConfigShape({ baseUrl: "https://x.invalid/v1" }), /未被读取方读取的键/);
      const noEndpoint = erixConfigShape({ apiKey: "k", model: "m" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(written.configPath, JSON.stringify(noEndpoint, null, 2));
      await assert.rejects(() => loadCliConfig({ configPath: written.configPath }), /LLM_KIT_ENDPOINT/);
    } finally {
      for (const [name, value] of saved.entries()) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("形状 B（~/.pi/agent/models.json）被 examples/exec-demo.js#loadRelayConfig 真解析出来", async () => {
    const { loadRelayConfig, DEMO_MODEL_PREFERENCES } = await import("../examples/exec-demo.js");
    const demoModel = DEMO_MODEL_PREFERENCES[0];
    const saved = new Map(MODEL_CONFIG_ENV_NAMES.map((n) => [n, process.env[n]]));
    for (const name of MODEL_CONFIG_ENV_NAMES) delete process.env[name];
    const home = await makeTmp("erix-shape-b-");
    try {
      const written = await createFakeConfigHome({
        dir: home,
        relay: { baseUrl: "https://shape-b.invalid/v1", apiKey: "k-shape-b", modelIds: [demoModel], maxTokens: 9000, contextWindow: 131_072 },
      });
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      const cfg = await loadRelayConfig({});
      assert.equal(cfg.endpoint, "https://shape-b.invalid/v1");
      assert.equal(cfg.apiKey, "k-shape-b");
      assert.equal(cfg.model, demoModel);
      assert.equal(cfg.contextWindowTokens, 131_072);
      // 8192 上限（issue #245）：给了 9000 也必须被夹到 8192
      assert.equal(cfg.maxOutputTokens, 8192);

      // 端点字段写成 endpoint 必须抛（工单单头那条「字段名别写反」的可执行版本）
      assert.throws(() => relayProviderEntry({ endpoint: "https://x.invalid/v1" }), /baseUrl/);
      assert.throws(() => relayModelsShape({ endpoint: "https://x.invalid/v1" }), /baseUrl/);
      assert.deepEqual([...RELAY_ENTRY_KEYS].sort(), ["apiKey", "baseUrl", "models"]);
    } finally {
      for (const [name, value] of saved.entries()) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("upstreamFields 把同一个上游 URL 填进两套**不同**键名，且形状 A 的假 HOME 真能起 CLI", async () => {
    const fields = upstreamFields("http://127.0.0.1:8099");
    assert.deepEqual(fields, { erixSlot: { endpoint: "http://127.0.0.1:8099" }, relayProvider: { baseUrl: "http://127.0.0.1:8099" } });
    assert.throws(() => upstreamFields(""), /上游 baseUrl/);
    assert.ok(ERIX_SLOT_CORE_KEYS.includes("endpoint") && !ERIX_SLOT_CORE_KEYS.includes("baseUrl"));

    const upstream = createScriptedUpstream({
      // 不带 --stream 时走非流式 JSON 回复（与 test/cli-process.test.js 的 replyWithText 同一形状）
      script: [jsonResponse({
        choices: [{ message: { role: "assistant", content: "SHAPE-A-OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      })],
    });
    const url = await upstream.listen();
    const home = await makeTmp("erix-shape-a-cli-");
    try {
      await createFakeConfigHome({
        dir: home,
        erix: { endpoint: url, apiKey: "k", model: "m-cli", maxOutputTokens: 1024 },
      });
      const proc = await runErix(home, ["chat", "hello", "--max-rounds", "3", "--reflection", "off"]);
      await upstream.waitForRequests(1, 2_000);
      const io = `exit=${proc.status} signal=${proc.signal} stdout=${JSON.stringify(String(proc.stdout).slice(-400))} stderr=${JSON.stringify(String(proc.stderr).slice(-400))}`;
      assert.equal(upstream.requestCount, 1, `上游收到 ${upstream.requestCount} 发请求，应为 1（假配置没接上真 CLI）；${io}`);
      assert.match(proc.stdout, /SHAPE-A-OK/, `终稿没进 stdout：${io}`);
    } finally {
      await upstream.close();
    }
  });

  // ---- 交付物 (c) 的防回归 -------------------------------------------------

  it("test/ 下不再放会被 node --test 当测试执行的支撑文件", () => {
    // 实测：裸 node --test 会把 test/ 下**任何**文件当测试文件收集执行（每轮白跑一遍，
    // 谁在里面加一行顶层代码就能挂住整套测试）。支撑文件一律放根 fixtures/。
    const strays = [...listScannable(new Set([".mjs", ".cjs"]), "test")]
      .map((f) => f.rel)
      .filter((rel) => !rel.endsWith(".test.js") && !rel.endsWith(".test.mjs") && !rel.startsWith("test/helpers/"));
    assert.deepEqual(
      strays,
      [],
      `test/ 下有非测试支撑文件（会被 node --test 白跑一遍）：${strays.join(", ")}——请搬到根 fixtures/`
      + "（test/helpers/ 下的辅助模块除外，本用例的清单口径见报告）",
    );
    assert.ok(existsSync(resolve(ROOT, "fixtures/rounds-fixtures.mjs")), "rounds-fixtures 没搬到根 fixtures/");
    assert.ok(!existsSync(resolve(ROOT, "test/fixtures/rounds-fixtures.mjs")), "test/fixtures/rounds-fixtures.mjs 还在原地");
  });

  // ---- 发布面：test/contract/ 不许依赖 test/helpers/（issue #498 S3 A2b）----------------

  it("test/contract/** 只许 import **已随包发布**的 helper（否则就是新增发布面）", () => {
    // 为什么这条是**发布面**的判据，不是风格偏好：
    //   · `package.json` 的 `files` 白名单**逐个列出** `test/contract/*.js`，宿主 `npm i` 之后
    //     能 `import { … } from "erix-agent/contract-tests"` 并**独立跑**这套契约测试；
    //   · 于是「契约套件能 import 什么」= 「包里必须发什么」。让 `test/contract/` 里的文件去 import
    //     一个**没在 `files` 里**的 helper，就必须把那个 helper 也加进 `files` —— 那是**新增发布面**，
    //     不是本仓内部重构（#498 S3 的裁决：`test/helpers/run-direct.js` 不进 `files`）；
    //   · 所以契约套件必须**自足**：要写种子首轮消息就就地写规位家
    //     `config: { input: { initialUserMessage } }`（#498 S3 A2b 的 8 处就是这么处理的）。
    //
    // 判据从符号派生，不手抄名单：① 解析相对 import 的真实路径；② 落在 `test/helpers/` 里的，
    // 逐条核它在 `package.json` 的 `files` 里**已被登记**（既有的 `test/helpers/tmp.js` 就是那种）。
    // 按**解析后的路径**判，不按拼写判：`../helpers/x.js` / `./helpers/x.js` / `../../test/helpers/x.js`
    // 一律算命中，将来换个相对路径写法也逃不掉。
    const HELPERS_DIR = resolve(ROOT, "test/helpers");
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    const published = (rel) => pkg.files.some((entry) => entry === rel || (entry.endsWith("/") && rel.startsWith(entry)));
    const specifierPattern = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gu;
    const offenders = [];
    let scanned = 0;
    let helperImports = 0;
    for (const { abs, rel } of listScannable(new Set([".js", ".mjs", ".cjs"]), "test/contract")) {
      scanned += 1;
      const src = readFileSync(abs, "utf8");
      for (const match of src.matchAll(specifierPattern)) {
        const specifier = match[1] ?? match[2];
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(abs), specifier);
        if (target !== HELPERS_DIR && !target.startsWith(`${HELPERS_DIR}${sep}`)) continue;
        helperImports += 1;
        const targetRel = relative(ROOT, target).split("\\").join("/");
        if (!published(targetRel)) offenders.push(`${rel} → ${specifier}（${targetRel} 不在 package.json 的 files 里）`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "test/contract/ 是**随包发布**的契约套件（package.json 的 files 逐个列它），"
      + "它一旦 import 未发布的 helper 就等于新增发布面：\n"
      + offenders.join("\n")
      + "\n——请就地写规位家（例如 `config: { input: { initialUserMessage } }`），不要 import 夹具",
    );
    // 扫描面不许退化：0 个文件 / 0 条 helper import = 扫描器自己坏了，不是「很干净」。
    assert.ok(scanned >= 10, `test/contract/ 只扫到 ${scanned} 个文件——扫描面退化了，这条守卫不可信`);
    assert.ok(helperImports >= 1, `一条 helper import 都没解析出来（实测 ${helperImports} 条）——解析器退化了`);

    // 同一条发布面判据的另一半：`files` 里没有把种子夹具登记进去（裁决：发布面不扩）。
    assert.equal(
      published("test/helpers/run-direct.js"),
      false,
      "test/helpers/run-direct.js 不许进 package.json 的 files（#498 S3 裁决：发布面不扩）"
      + "——契约套件要自足，不是把夹具塞进包里",
    );
  });
});

// ---------------------------------------------------------------------------
// 规则 4：文档里的「声称值」必须与脚本常量对得上（issue #310）
//
// 病根：`AGENTS.md` / `AGENTS_cn.md` 里有一批**声称值**引用门禁脚本自己的常量
// （`` `CONST_NAME = N` ``），而 `check:docs` 不锚定它们 ⇒ 脚本常量一改，文档静默过时而门禁照绿。
// 历史上已两次现场抓到（AGENTS 写 `SYMBOL_ANCHOR_MIN_UNIQUE = 27` 而脚本 29；写 `.d.ts` 66 而真实 67），
// 本单开工时又抓到第三处（写 76 而脚本 77）。
//
// #359 把声称面从「两份 AGENTS」扩到**五份**：`README.md` / `README_cn.md` 是**随包**文档（`package.json`
// 的 `files` 里有它们），宿主读得比 AGENTS 更多；`examples/pi-extension/README.md` 是 `erix_run` 的宿主
// 文档（虽不在 tarball 里，但它声称的是扩展自己的常量）。实测（本单开工时）这三份里各**恰好一处**真值声称：
//   `README.md:995` / `README_cn.md:590` 的 `` `REF_SCAN_DOCS_MINIMUM = 33` ``、
//   `examples/pi-extension/README.md:246` 的 `` `WAKE_PENDING_MS = 10_000` ``（真值在
//   `examples/pi-extension/erix-run-parent-wake.js`，`export const` + 数字分隔符两种写法都要认）。
// 三处的现值**当时都对得上**（不像 #310 那次 76 vs 77），本单没有需要修的现值——只是把它们钉住。
//
// 口径（与 #164 / #210 R2 一致）：
//   · 真值只从脚本**自己的文本**里抽（`const <NAME> = <数字>;`，也认 `export const` 与 `10_000` 这种
//     数字分隔符）；**抽不到 = 红**，禁止静默放行。
//   · 声称只认反引号包裹的 `` `<NAME> = <数字>` `` 这一种形态；散文里的数字不算声称。
//   · 「每份至少一处」**只对 `CLAIMED_VALUE_DOC_RULES` 里登记的 (文档, 常量) 对**要求——README 不必提到
//     全部常量（它只提其中一个），硬逼它去提别的常量等于往文档里造句子，那是本单要堵的 fail-open 形状。
//     但**登记了就必须在**：把 README 里那句删掉 ⇒ 红（#210 那族「句子被删也要红」的口径）。
//   · 每一处声称都等于真值；同一常量在**所有**声称它的文档里彼此相同（中英成对 + 随包 README 同值）。
//   · 未纳面的同形声称（本单实测为空）与**异形**声称（例：`README.md:546` 的「`maxRounds >= 16`
//     (`DEFAULT_REFLECTION_MIN_ROUNDS`)」是「比较式 + 常量名」，不是 `NAME = N`）不在本条管辖内，见报告。
//
// 覆盖面诚实标注（工单 261022-03 裁决 A；#359 只加文档，不动下面这几条的判据）：
//   · `BASELINE_ROOT` 的 `` `BASELINE_ROOT = N` `` 写法**已经**被 `scripts/docs-drift-check.mjs` 的
//     `BASELINE_CLAIM_RULES`（`required: true`，中英各一）校着 ⇒ 这里对它是**第二道锁**。
//   · `SYMBOL_ANCHOR_MIN_UNIQUE` / `BARE_LINE_REF_BASELINE` / `REF_SCAN_DOCS_MINIMUM` 在 `check:docs`
//     里没有声称锚点（脚本只把常量当真值读，没人校文档里的那个数）⇒ 这三个是**新增覆盖面**。
//   · `BASELINE_WITH_TOOLS` 在文档里的现值是「基线 **N** / 31 个文件」句式（不是 `= N` 写法，两侧 0 处），
//     已被 `BASELINE_CLAIM_RULES` 的 `tier: "withTools"` 规则校着 ⇒ 这里只锁**覆盖面**（那条规则还在不在、
//     还校不校两份 AGENTS），不重复造真值对账。`.d.ts` 计数声称同理（真值在 `check:pack-links`）。

const DRIFT_SRC = "scripts/docs-drift-check.mjs";
const RATCHET_SRC = "scripts/type-check-ratchet.mjs";
const PACK_LINK_SRC = "scripts/pack-link-check.mjs";
const WAKE_SRC = "examples/pi-extension/erix-run-parent-wake.js";

/**
 * R1 的常量表（工单裁决 A：4 个 + #359 的 `WAKE_PENDING_MS`）。每条只写「常量名 → 定义它的脚本」——
 * 真值不在这里，在脚本文本里。
 * `BASELINE_WITH_TOOLS` **不在表里**：文档里没有 `` `BASELINE_WITH_TOOLS = N` `` 这种写法（两侧 0 处），
 * 硬塞进来就只能靠「往文档里造一句」或「放宽每份至少一次」二选一，两个都是本单要堵的 fail-open 形状。
 * 它的现值句式由下面 `baselineTierCoverage` 的覆盖面断言看住。
 */
const CLAIMED_VALUE_CONSTANTS = Object.freeze([
  { name: "SYMBOL_ANCHOR_MIN_UNIQUE", script: DRIFT_SRC },
  { name: "BARE_LINE_REF_BASELINE", script: DRIFT_SRC },
  { name: "REF_SCAN_DOCS_MINIMUM", script: DRIFT_SRC },
  { name: "BASELINE_ROOT", script: RATCHET_SRC },
  // #359：`examples/pi-extension/README.md` 声称的那个（真值是 `export const` + 数字分隔符写法）
  { name: "WAKE_PENDING_MS", script: WAKE_SRC },
]);

/**
 * 两份 AGENTS 必须提到的那四个常量（手写清单，不从 `CLAIMED_VALUE_CONSTANTS` 推导）：
 * 推导式会让「表里新增一个只被 README 声称的常量」突然变成「AGENTS 也必须提它」⇒ 下次有人被卡就会
 * 把判据放宽。这里写死四个，跟 #310 落地时 AGENTS 中英两侧的实际声称面一致。
 * `WAKE_PENDING_MS` 不在里面：它是 `erix_run` 扩展的常量，两份 AGENTS 一个字都不提。
 */
const AGENTS_REQUIRED_CLAIMS = Object.freeze([
  "SYMBOL_ANCHOR_MIN_UNIQUE",
  "BARE_LINE_REF_BASELINE",
  "REF_SCAN_DOCS_MINIMUM",
  "BASELINE_ROOT",
]);

/**
 * 声称面（#359 起五份）。`requires` 是**这份文档必须至少出现一次**的常量：
 *   · 两份 AGENTS：表里那四个（`WAKE_PENDING_MS` 是扩展的常量，AGENTS 不提它是合法的）。
 *   · 两份随包 README：只登记 `REF_SCAN_DOCS_MINIMUM`（它们各自只声称这一个）。
 *   · `erix_run` 的 README：只登记 `WAKE_PENDING_MS`。
 * 没登记进 `requires` 的常量**不要求出现**，但一旦出现就照样对真值、照样参与「各文档同值」。
 */
const CLAIMED_VALUE_DOC_RULES = Object.freeze([
  { doc: "AGENTS.md", requires: AGENTS_REQUIRED_CLAIMS },
  { doc: "AGENTS_cn.md", requires: AGENTS_REQUIRED_CLAIMS },
  { doc: "README.md", requires: Object.freeze(["REF_SCAN_DOCS_MINIMUM"]) },
  { doc: "README_cn.md", requires: Object.freeze(["REF_SCAN_DOCS_MINIMUM"]) },
  { doc: "examples/pi-extension/README.md", requires: Object.freeze(["WAKE_PENDING_MS"]) },
]);

/**
 * 真值：`[export ]const <NAME> = <数字>;` 一行（与两个脚本里既有的 `fileRecord` 自读口径同形）。
 * #359 起也认两种新写法：`export const`（`examples/pi-extension/*.js` 的导出常量）与数字分隔符
 * （`10_000` —— `Number("10_000")` 是 NaN，必须自己剔下划线）。抽不到返 null。
 */
function extractConstValue(text, name) {
  if (typeof text !== "string") return null;
  const m = text.match(new RegExp(`^(?:export )?const ${name} = (\\d[\\d_]*);`, "m"));
  return m ? Number(m[1].replace(/_/g, "")) : null;
}

/**
 * 声称：反引号包裹的 `` `<NAME> = <数字>` ``（也认 `10_000`）。
 * 返回 `{ value, line }`（行号是文档自己的行，报错要用）。
 */
function extractDocClaims(text, name) {
  if (typeof text !== "string") return [];
  const re = new RegExp("`" + name + "\\s*=\\s*(\\d[\\d_]*)`", "g");
  return [...text.matchAll(re)].map((m) => ({
    value: Number(m[1].replace(/_/g, "")),
    line: text.slice(0, m.index).split("\n").length,
  }));
}

/**
 * R1 的核心（**纯函数，读文本可注入**——合成树的反向证直接拿它问，不绑真实文件）。
 *
 * @param {{readText: (rel: string) => (string|null), constants?: object[], docRules?: {doc: string, requires: readonly string[]}[]}} params
 * @returns {{errors: string[], rows: {name: string, script: string, truth: number|null, claims: {doc: string, line: number, value: number}[]}[]}}
 */
function claimedValueReport({ readText, constants = CLAIMED_VALUE_CONSTANTS, docRules = CLAIMED_VALUE_DOC_RULES }) {
  const errors = [];
  const rows = [];
  for (const { name, script } of constants) {
    const truth = extractConstValue(readText(script), name);
    const row = { name, script, truth, claims: [] };
    rows.push(row);
    if (truth === null) {
      errors.push(`claimed-values: 从 ${script} 自己的文本里抽不到 \`const ${name} = <数字>;\`——`
        + "真值读不到就判红（#164 口径：不许在真值缺席时静默放行）；脚本改了写法就同步改本守卫");
      continue;
    }
    const byDoc = new Map();
    for (const { doc, requires } of docRules) {
      const text = readText(doc);
      if (typeof text !== "string") {
        errors.push(`claimed-values: ${doc} 读不到文本——声称面少一份，等于这份文档的声称没人校`);
        continue;
      }
      const claims = extractDocClaims(text, name);
      row.claims.push(...claims.map((c) => ({ doc, ...c })));
      byDoc.set(doc, claims);
      // 只对**登记过的** (文档, 常量) 对要求「至少一处」：README 不提某常量是合法的，
      // 但登记了的那一句被删 ⇒ 红（#210 那族：句子没了不能算绿）
      if (requires.includes(name) && claims.length === 0) {
        errors.push(`claimed-values: ${doc} 里一处 \`${name} = <数字>\` 声称都没有——`
          + "这份文档的声称面登记了它，句子被删也要红（否则这个常量就脱离了机器校对；"
          + `真值在 ${script}）`);
      }
      for (const c of claims) {
        if (c.value !== truth) {
          errors.push(`claimed-values: ${doc}:${c.line} 声称 \`${name} = ${c.value}\`，但 ${script} 里的真值是 ${truth}——`
            + `把文档改成 ${truth}（历史沿革留着写历史），或改脚本常量并写明理由`);
        }
      }
    }
    // ③ 同一常量在所有声称它的文档里必须同值（中英成对 + 随包 README 同值；
    //    #210 那族「中英声明位数对不齐」的口径，#359 把它从「两份 AGENTS 两两比」改成「全部文档一个值」）
    const claiming = [...byDoc.entries()].filter(([, claims]) => claims.length > 0);
    const distinct = [...new Set(claiming.flatMap(([, claims]) => claims.map((c) => c.value)))];
    if (distinct.length > 1) {
      const detail = claiming
        .map(([doc, claims]) => `${doc} 声称 ${[...new Set(claims.map((c) => c.value))].join(" / ")}`)
        .join("；");
      errors.push(`claimed-values: \`${name}\` 的现值声称在各文档间不一致（${detail}）——`
        + `同一常量在所有声称它的文档里必须同值（中英成对 + 随包 README），且都等于 ${script} 里的真值 ${truth}`);
    }
  }
  return { errors, rows };
}

/** 从一段源码里取**第一层**的 `{ … }` 块（对象字面量配对；配不上对返 null，让调用方报红而不是静默空跑）。 */
function topLevelObjectBlocks(src) {
  const blocks = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0 && start >= 0) {
        blocks.push(src.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return depth === 0 ? blocks : null;
}

/**
 * `BASELINE_WITH_TOOLS` 那一半：**只锁覆盖面，不重复造真值**。
 *
 * 文档里 160 的现值句式是「基线 **N** / 31 个文件」（EN）与「基线 **N** / 31 个文件」（CN），真值对账已经由
 * `scripts/docs-drift-check.mjs` 的 `BASELINE_CLAIM_RULES` 做着。这里断言的是「那条规则还在，而且仍校两份
 * AGENTS」：把 `required` 改成 false、或从 `claims` 里删掉一份文档 ⇒ 红。分解式（`tier: "sum"`，`= A + B + C`）
 * 同理纳入。
 */
function baselineTierCoverage(readText, tiers = ["withTools", "sum"]) {
  const src = readText(DRIFT_SRC);
  if (typeof src !== "string") return { errors: [`claimed-values: ${DRIFT_SRC} 读不到文本——baseline 句式覆盖面无从校起`], rules: [] };
  const errors = [];
  const block = src.match(/^const BASELINE_CLAIM_RULES = \[([\s\S]*?)\n\];/m);
  const blocks = block ? topLevelObjectBlocks(block[1]) : null;
  if (!block || !blocks) {
    return {
      errors: [`claimed-values: 从 ${DRIFT_SRC} 自己的文本里抽不出 \`BASELINE_CLAIM_RULES\` 的规则表——`
        + "这张表是 baseline 现值句式的唯一锚点，抽不到就判红（#164 口径），别让覆盖面断言静默失效"],
      rules: [],
    };
  }
  const rules = blocks.map((b) => ({
    id: b.match(/\bid:\s*"([^"]*)"/)?.[1] ?? "(无 id)",
    tier: b.match(/\btier:\s*"([^"]*)"/)?.[1] ?? null,
    required: /\brequired:\s*true\b/.test(b),
    rels: [...b.matchAll(/\brel:\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
  }));
  const enDoc = src.match(/^const AGENTS_EN = "([^"]+)";/m)?.[1];
  const cnDoc = src.match(/^const AGENTS_CN = "([^"]+)";/m)?.[1];
  if (enDoc !== "AGENTS.md" || cnDoc !== "AGENTS_cn.md") {
    errors.push(`claimed-values: ${DRIFT_SRC} 的 AGENTS_EN / AGENTS_CN 不再指向两份 AGENTS`
      + `（实测 ${JSON.stringify(enDoc)} / ${JSON.stringify(cnDoc)}）——覆盖面断言下面的 rel 名字会对到别的文件上`);
  }
  for (const tier of tiers) {
    const hit = rules.filter((r) => r.tier === tier && r.required && r.rels.includes("AGENTS_EN") && r.rels.includes("AGENTS_CN"));
    if (hit.length === 0) {
      errors.push(`claimed-values: ${DRIFT_SRC} 的 \`BASELINE_CLAIM_RULES\` 里已经没有 \`tier: "${tier}"\` 且 \`required: true\`、`
        + "同时覆盖两份 AGENTS 的规则了——这条现值句式的锚点被删/被降级/被缩面，文档里的那个数从此没人校（#274 那族）");
    }
  }
  return { errors, rules };
}

/**
 * `.d.ts` 计数声称那一半：**只锁覆盖面**。真值对账（同一次 `npm pack --dry-run --json` 清单）由
 * `npm run check:pack-links` 的 `checkDeclarationClaims` 承担——本守卫**不在 `npm test` 里再跑 tsc/pack**。
 * 这里只钉住「哪几份文档在对账面里」：谁把 AGENTS 两份从 `DECLARATION_CLAIM_DOCS` 里摘掉就红。
 */
function declarationClaimCoverageErrors(readText, required = ["AGENTS.md", "AGENTS_cn.md"]) {
  const src = readText(PACK_LINK_SRC);
  if (typeof src !== "string") return [`claimed-values: ${PACK_LINK_SRC} 读不到文本——.d.ts 声称对账的覆盖面无从校起`];
  const m = src.match(/^const DECLARATION_CLAIM_DOCS = (\[[^\]]*\]);/m);
  if (!m) {
    return [`claimed-values: 从 ${PACK_LINK_SRC} 自己的文本里抽不到 \`const DECLARATION_CLAIM_DOCS = [...];\`——`
      + "覆盖面被改名/改写法，这条断言会静默失效（#164 口径：抽不到就报错）"];
  }
  let list;
  try {
    list = JSON.parse(m[1]);
  } catch (error) {
    return [`claimed-values: ${PACK_LINK_SRC} 的 DECLARATION_CLAIM_DOCS 解析不了（${error.message}）：${m[1]}`];
  }
  if (!Array.isArray(list)) return [`claimed-values: ${PACK_LINK_SRC} 的 DECLARATION_CLAIM_DOCS 不是数组：${m[1]}`];
  const missing = required.filter((rel) => !list.includes(rel));
  if (missing.length) {
    return [`claimed-values: ${PACK_LINK_SRC} 的 DECLARATION_CLAIM_DOCS 不再覆盖 ${missing.join(" / ")}（当前：${list.join(", ")}）——`
      + "`.d.ts` 现值声称的对账面被缩小了：AGENTS 里那句「装包应列 N 个 `.d.ts`」就没人校了"];
  }
  return [];
}

/** 变异器：**变异没打上也要红**（#210 R2 口径）——靶子被改写时这里直接抛，别让「没变异」冒充「变异后仍绿」。 */
function mutateText(text, from, to, label) {
  assert.equal(typeof text, "string", `变异「${label}」：靶子文本读不到`);
  assert.ok(
    text.includes(from),
    `变异「${label}」没落上：靶子里找不到 ${JSON.stringify(from)}——靶子被改写了，这一例不能当成绿（先修靶子）`,
  );
  return text.replace(from, to);
}

/** 真实树读文本（读不到返 null，让守卫按「抽不到真值就红」处理）。 */
function realReadText(rel) {
  const abs = resolve(ROOT, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

describe("静态守卫：文档声称值与脚本常量（issue #310）", () => {
  it("规则 4：五份文档的声称值逐处等于脚本常量（真实树 = 回归基线）", (t) => {
    const { errors, rows } = claimedValueReport({ readText: realReadText });
    t.diagnostic(`规则 4：${rows.length} 个常量 / ${rows.reduce((n, r) => n + r.claims.length, 0)} 处声称`);
    for (const { doc } of CLAIMED_VALUE_DOC_RULES) {
      const hits = rows.flatMap((r) => r.claims.filter((c) => c.doc === doc).map((c) => `${r.name}=${c.value}@${c.line}`));
      t.diagnostic(`  ${doc}：${hits.length ? hits.join(", ") : "（零处）"}`);
    }
    assert.deepEqual(errors, [], `文档声称值与脚本常量对不上：\n${errors.join("\n")}`);
    assert.equal(rows.length, CLAIMED_VALUE_CONSTANTS.length, "常量表被改了？rows 数应与表同长");
    // 声称面本身：#359 扩到五份之后，谁把它改窄/改名/删一份 ⇒ 红
    // （光靠「每份至少一处」不能防「把一份从 docRules 里拿掉」，所以这里把名单本身也钉住）
    assert.deepEqual(
      CLAIMED_VALUE_DOC_RULES.map((r) => r.doc),
      ["AGENTS.md", "AGENTS_cn.md", "README.md", "README_cn.md", "examples/pi-extension/README.md"],
      "规则 4 的声称面被改窄了（#359 要求两份随包 README 与 erix_run 的 README 都在面内）",
    );
    // 正面证据：登记过的 (文档, 常量) 对**真的**有声称，而不是靠别的文档盖住
    for (const { doc, requires } of CLAIMED_VALUE_DOC_RULES) {
      const claimed = new Set(rows.filter((r) => r.claims.some((c) => c.doc === doc)).map((r) => r.name));
      for (const name of requires) {
        assert.ok(claimed.has(name), `${doc} 里没有 \`${name} = <数字>\` 声称（登记了却没出现 ⇒ 该文档这一条没人校）`);
      }
      assert.ok(claimed.size > 0, `${doc} 在声称面里却一处声称都没有：它凭什么占一个位置`);
    }
    for (const row of rows) {
      assert.ok(row.claims.every((c) => c.value === row.truth), `\`${row.name}\` 有声称不等于真值 ${row.truth}`);
    }
  });

  it("规则 4 的覆盖面：`BASELINE_WITH_TOOLS` 的现值句式必须仍被 check:docs 校着（自带反向证）", (t) => {
    const { errors, rules } = baselineTierCoverage(realReadText);
    assert.deepEqual(errors, [], `baseline 句式覆盖面掉了：\n${errors.join("\n")}`);
    assert.ok(
      rules.some((r) => r.tier === "withTools" && r.required),
      "抽出来的规则表里一条 withTools + required 都没有——抽取口径可能失效了",
    );

    // 反向证 ①：把 withTools 那条规则的 required 改成 false ⇒ 必须红
    const downgraded = mutateText(
      realReadText(DRIFT_SRC),
      'tier: "withTools",\n    required: true,',
      'tier: "withTools",\n    required: false,',
      "降级 withTools 规则",
    );
    const downgradedErrors = baselineTierCoverage((rel) => (rel === DRIFT_SRC ? downgraded : realReadText(rel))).errors;
    assert.match(downgradedErrors.join("\n"), /没有 \`tier: "withTools"\` 且 \`required: true\`/);
    t.diagnostic(`withTools 规则 required → false ⇒ ${downgradedErrors.length} 处红：\n${downgradedErrors.join("\n")}`);

    // 反向证 ②：从那条规则的 claims 里删掉中文那份（rel 名字被换掉）⇒ 必须红
    const shrunk = mutateText(
      realReadText(DRIFT_SRC),
      "{ rel: AGENTS_CN, re: /基线\\s*",
      "{ rel: AGENTS_EN, re: /基线\\s*",
      "withTools 规则缩面",
    );
    const shrunkErrors = baselineTierCoverage((rel) => (rel === DRIFT_SRC ? shrunk : realReadText(rel))).errors;
    assert.match(shrunkErrors.join("\n"), /没有 \`tier: "withTools"\` 且 \`required: true\`/);
    t.diagnostic(`withTools 规则的 claims 缩掉中文那份 ⇒ ${shrunkErrors.length} 处红：\n${shrunkErrors.join("\n")}`);

    // 反向证 ③：AGENTS_CN 常量被改指向别的文件 ⇒ 必须红（rel 名字对、指向错，也会漏）
    const retargeted = mutateText(
      realReadText(DRIFT_SRC),
      'const AGENTS_CN = "AGENTS_cn.md";',
      'const AGENTS_CN = "README_cn.md";',
      "AGENTS_CN 改指向",
    );
    const retargetedErrors = baselineTierCoverage((rel) => (rel === DRIFT_SRC ? retargeted : realReadText(rel))).errors;
    assert.match(retargetedErrors.join("\n"), /AGENTS_EN \/ AGENTS_CN 不再指向两份 AGENTS/);
    t.diagnostic(`AGENTS_CN 改指向 README_cn.md ⇒ ${retargetedErrors.length} 处红：\n${retargetedErrors.join("\n")}`);
  });

  it("规则 4 的覆盖面：`.d.ts` 声称对账（check:pack-links）必须含两份 AGENTS（自带反向证）", (t) => {
    assert.deepEqual(declarationClaimCoverageErrors(realReadText), []);

    // 反向证：把覆盖面缩成两份 README ⇒ 必须点名缺的两份
    const shrunk = mutateText(
      realReadText(PACK_LINK_SRC),
      'const DECLARATION_CLAIM_DOCS = ["README.md", "README_cn.md", "AGENTS.md", "AGENTS_cn.md"];',
      'const DECLARATION_CLAIM_DOCS = ["README.md", "README_cn.md"];',
      "DECLARATION_CLAIM_DOCS 缩面",
    );
    const errors = declarationClaimCoverageErrors((rel) => (rel === PACK_LINK_SRC ? shrunk : realReadText(rel)));
    assert.match(errors.join("\n"), /不再覆盖 AGENTS\.md \/ AGENTS_cn\.md/);
    t.diagnostic(`DECLARATION_CLAIM_DOCS 缩成两份 README ⇒ ${errors.length} 处红：\n${errors.join("\n")}`);

    // 抽不到常量 = 红（改名/改写法不许静默放行）
    const renamed = mutateText(
      realReadText(PACK_LINK_SRC),
      "const DECLARATION_CLAIM_DOCS =",
      "const DECLARATION_CLAIM_FILES =",
      "DECLARATION_CLAIM_DOCS 改名",
    );
    const renamedErrors = declarationClaimCoverageErrors((rel) => (rel === PACK_LINK_SRC ? renamed : realReadText(rel)));
    assert.match(renamedErrors.join("\n"), /抽不到 \`const DECLARATION_CLAIM_DOCS = \[\.\.\.\];\`/);
    t.diagnostic(`DECLARATION_CLAIM_DOCS 改名 ⇒ ${renamedErrors.length} 处红：\n${renamedErrors.join("\n")}`);
  });

  it("规则 4 的反向证：合成树上只改一边必红、两边同改才绿（变异没打上也算失败）", async (t) => {
    const dir = await makeTmp("erix-claimed-values-");
    const read = (rel) => {
      const abs = join(dir, rel);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    };
    const write = (rel, text) => {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    };
    // 合成树的「真值」故意与真仓不同（7 / 11 / 13 / 17 / 10_000）：这条用例不会因为真仓的常量涨落而失效，
    // 也不会因为「恰好等于真仓现值」而假绿。
    const WAKE_LITERAL = "10_000"; // 数字分隔符写法：`Number("10_000")` 是 NaN，两侧都得自己剔下划线
    const V = {
      SYMBOL_ANCHOR_MIN_UNIQUE: 7,
      BARE_LINE_REF_BASELINE: 11,
      REF_SCAN_DOCS_MINIMUM: 13,
      BASELINE_ROOT: 17,
      WAKE_PENDING_MS: 10_000,
    };
    const script = (rel) => {
      if (rel === DRIFT_SRC) {
        return [`const SYMBOL_ANCHOR_MIN_UNIQUE = ${V.SYMBOL_ANCHOR_MIN_UNIQUE};`,
          `const BARE_LINE_REF_BASELINE = ${V.BARE_LINE_REF_BASELINE};`,
          `const REF_SCAN_DOCS_MINIMUM = ${V.REF_SCAN_DOCS_MINIMUM};`, ""].join("\n");
      }
      if (rel === RATCHET_SRC) return [`const BASELINE_ROOT = ${V.BASELINE_ROOT};`, ""].join("\n");
      // 真仓里 `WAKE_PENDING_MS` 就是 `export const` + 数字分隔符，合成树照抄这个写法
      return ["/** synthetic pending window */", `export const WAKE_PENDING_MS = ${WAKE_LITERAL};`, ""].join("\n");
    };
    const doc = (lang) => (lang === "en"
      ? ["# Synthetic AGENTS (makeTmp only)",
        `- only-up floor: \`SYMBOL_ANCHOR_MIN_UNIQUE = ${V.SYMBOL_ANCHOR_MIN_UNIQUE}\` (synthetic value)`,
        `- bare-line ratchet: \`BARE_LINE_REF_BASELINE = ${V.BARE_LINE_REF_BASELINE}\``,
        `- scan floor: \`REF_SCAN_DOCS_MINIMUM = ${V.REF_SCAN_DOCS_MINIMUM}\``,
        `- ratchet: \`BASELINE_ROOT = ${V.BASELINE_ROOT}\``, ""].join("\n")
      : ["# 合成 AGENTS（只在 makeTmp 里）",
        `- 只增不减下限：\`SYMBOL_ANCHOR_MIN_UNIQUE = ${V.SYMBOL_ANCHOR_MIN_UNIQUE}\`（合成值）`,
        `- 裸行号棘轮：\`BARE_LINE_REF_BASELINE = ${V.BARE_LINE_REF_BASELINE}\``,
        `- 覆盖面下限：\`REF_SCAN_DOCS_MINIMUM = ${V.REF_SCAN_DOCS_MINIMUM}\``,
        `- 棘轮：\`BASELINE_ROOT = ${V.BASELINE_ROOT}\``, ""].join("\n"));
    const readmeEn = () => ["# Synthetic README (makeTmp only)",
      `- scanned documents: 13 of them (\`REF_SCAN_DOCS_MINIMUM = ${V.REF_SCAN_DOCS_MINIMUM}\`)`, ""].join("\n");
    const readmeCn = () => ["# 合成 README（只在 makeTmp 里）",
      `- 实扫文档：共 13 份（\`REF_SCAN_DOCS_MINIMUM = ${V.REF_SCAN_DOCS_MINIMUM}\`）`, ""].join("\n");
    const wakeReadme = () => ["# 合成 erix_run README（只在 makeTmp 里）",
      `- **\`WAKE_PENDING_MS = ${WAKE_LITERAL}\` pending 窗口**：窗口内不重复排 steer。`, ""].join("\n");
    const seed = () => {
      write(DRIFT_SRC, script(DRIFT_SRC));
      write(RATCHET_SRC, script(RATCHET_SRC));
      write(WAKE_SRC, script(WAKE_SRC));
      write("AGENTS.md", doc("en"));
      write("AGENTS_cn.md", doc("cn"));
      write("README.md", readmeEn());
      write("README_cn.md", readmeCn());
      write("examples/pi-extension/README.md", wakeReadme());
    };
    const report = () => claimedValueReport({ readText: read });

    // 对照组：合成树本身必须绿（否则下面每一条变异证都不成立）
    seed();
    assert.deepEqual(report().errors, [], "合成树对照组没绿——后面的反向证会全部失去意义");
    assert.equal(report().rows.length, 5, "合成树上应当校 5 个常量");
    // 新增的**放行格**（必须真的放行，不是恒绿）：两份 README 只声称了 `REF_SCAN_DOCS_MINIMUM`，
    // 它们不提 `SYMBOL_ANCHOR_MIN_UNIQUE` / `BARE_LINE_REF_BASELINE` / `BASELINE_ROOT` 也不红。
    // 这一格和下面⑦⑧⑨⑪ 的「登记了就必须在」正好是一对：不要求出现 ≠ 出现了不管。
    const readmeNames = new Set(report().rows
      .filter((r) => r.claims.some((c) => c.doc === "README.md"))
      .map((r) => r.name));
    assert.deepEqual([...readmeNames], ["REF_SCAN_DOCS_MINIMUM"],
      "README.md 只声称一个常量：合成树里应当就这一处（这条也是「缺其它常量不红」的放行格）");
    t.diagnostic("对照组：5 份文档 / 5 个常量 全绿；README.md 只声称 REF_SCAN_DOCS_MINIMUM（其余缺不红）");


    // ① 只改脚本常量、不改文档 ⇒ 红（两份文档各一处，且只该有这两处）
    seed();
    write(DRIFT_SRC, mutateText(read(DRIFT_SRC),
      `const SYMBOL_ANCHOR_MIN_UNIQUE = ${V.SYMBOL_ANCHOR_MIN_UNIQUE};`,
      "const SYMBOL_ANCHOR_MIN_UNIQUE = 8;", "只改脚本常量"));
    const scriptOnly = report().errors;
    assert.equal(scriptOnly.length, 2, `只改脚本应当恰好 2 处红（中英各一），实测：\n${scriptOnly.join("\n")}`);
    assert.match(scriptOnly.join("\n"), /AGENTS\.md:\d+ 声称 \`SYMBOL_ANCHOR_MIN_UNIQUE = 7\`，但 scripts\/docs-drift-check\.mjs 里的真值是 8/);
    assert.match(scriptOnly.join("\n"), /AGENTS_cn\.md:\d+ 声称 \`SYMBOL_ANCHOR_MIN_UNIQUE = 7\`，但 scripts\/docs-drift-check\.mjs 里的真值是 8/);
    t.diagnostic(`① 只改脚本常量（7 → 8）⇒ ${scriptOnly.length} 处红：\n${scriptOnly.join("\n")}`);

    // ② 只改文档声称、不改脚本 ⇒ 红（值不等 + 中英彼此不同）
    seed();
    write("AGENTS.md", mutateText(read("AGENTS.md"),
      `\`SYMBOL_ANCHOR_MIN_UNIQUE = ${V.SYMBOL_ANCHOR_MIN_UNIQUE}\``, "`SYMBOL_ANCHOR_MIN_UNIQUE = 8`", "只改文档声称"));
    const docOnly = report().errors;
    assert.equal(docOnly.length, 2, `只改文档应当恰好 2 处红（值不等 + 中英不同），实测：\n${docOnly.join("\n")}`);
    assert.match(docOnly.join("\n"), /AGENTS\.md:\d+ 声称 \`SYMBOL_ANCHOR_MIN_UNIQUE = 8\`，但 scripts\/docs-drift-check\.mjs 里的真值是 7/);
    assert.match(docOnly.join("\n"), /\`SYMBOL_ANCHOR_MIN_UNIQUE\` 的现值声称在各文档间不一致/);
    t.diagnostic(`② 只改文档声称（EN 7 → 8）⇒ ${docOnly.length} 处红：\n${docOnly.join("\n")}`);

    // ③ 两边同时改 ⇒ 绿（证明判据不是恒红）
    seed();
    write(DRIFT_SRC, mutateText(read(DRIFT_SRC),
      `const SYMBOL_ANCHOR_MIN_UNIQUE = ${V.SYMBOL_ANCHOR_MIN_UNIQUE};`,
      "const SYMBOL_ANCHOR_MIN_UNIQUE = 8;", "两边同改（脚本）"));
    write("AGENTS.md", mutateText(read("AGENTS.md"),
      `\`SYMBOL_ANCHOR_MIN_UNIQUE = ${V.SYMBOL_ANCHOR_MIN_UNIQUE}\``, "`SYMBOL_ANCHOR_MIN_UNIQUE = 8`", "两边同改（EN）"));
    write("AGENTS_cn.md", mutateText(read("AGENTS_cn.md"),
      `\`SYMBOL_ANCHOR_MIN_UNIQUE = ${V.SYMBOL_ANCHOR_MIN_UNIQUE}\``, "`SYMBOL_ANCHOR_MIN_UNIQUE = 8`", "两边同改（CN）"));
    assert.deepEqual(report().errors, [], "两边同时改必须绿");
    t.diagnostic("③ 两边同时改（脚本 8 + 中英都 8）⇒ 0 处红（绿）");

    // ④ 把文档里那句整段删掉 ⇒ 因「每份至少一次」而红（不是靠数值不等才红）
    seed();
    write("AGENTS_cn.md", mutateText(read("AGENTS_cn.md"),
      `- 覆盖面下限：\`REF_SCAN_DOCS_MINIMUM = ${V.REF_SCAN_DOCS_MINIMUM}\`\n`, "", "删掉 CN 那句声称"));
    assert.match(report().errors.join("\n"), /AGENTS_cn\.md 里一处 \`REF_SCAN_DOCS_MINIMUM = <数字>\` 声称都没有/);
    t.diagnostic(`④ 删掉 CN 那句声称 ⇒ ${report().errors.length} 处红：\n${report().errors.join("\n")}`);

    // ⑤ 脚本里把常量整行删掉 ⇒ 抽不到真值就红（#164 口径，不许静默放行）
    seed();
    write(RATCHET_SRC, mutateText(read(RATCHET_SRC),
      `const BASELINE_ROOT = ${V.BASELINE_ROOT};\n`, "", "删掉脚本常量"));
    assert.match(report().errors.join("\n"), /抽不到 \`const BASELINE_ROOT = <数字>;\`/);
    t.diagnostic(`⑤ 删掉脚本里的常量行 ⇒ ${report().errors.length} 处红：\n${report().errors.join("\n")}`);

    // ⑥ 变异没打上也要红：靶子被改写时变异器自己就抛（防止「没变异」冒充「变异后仍绿」）
    assert.throws(
      () => mutateText(read("AGENTS.md"), "`SYMBOL_ANCHOR_MIN_UNIQUE = 999`", "`SYMBOL_ANCHOR_MIN_UNIQUE = 1`", "靶子不存在"),
      /变异「靶子不存在」没落上/,
    );

    // ── #359 新增的三份文档：每条新覆盖都带自己的反向证 ────────────────────────────────

    // ⑦ 只改 `README.md` 的声称（EN 13 → 14），`README_cn.md` / AGENTS / 脚本不动 ⇒
    //    值不等 + 「各文档同值」两条都红（中英成对的口径扩到 README 对）
    seed();
    write("README.md", mutateText(read("README.md"),
      `\`REF_SCAN_DOCS_MINIMUM = ${V.REF_SCAN_DOCS_MINIMUM}\``, "`REF_SCAN_DOCS_MINIMUM = 14`", "只改 README.md 声称"));
    const readmeOnly = report().errors;
    assert.equal(readmeOnly.length, 2, `只改 README.md 应当恰好 2 处红（值不等 + 各文档不同），实测：\n${readmeOnly.join("\n")}`);
    assert.match(readmeOnly.join("\n"), /README\.md:\d+ 声称 \`REF_SCAN_DOCS_MINIMUM = 14\`，但 scripts\/docs-drift-check\.mjs 里的真值是 13/);
    assert.match(readmeOnly.join("\n"), /\`REF_SCAN_DOCS_MINIMUM\` 的现值声称在各文档间不一致（AGENTS\.md 声称 13；AGENTS_cn\.md 声称 13；README\.md 声称 14；README_cn\.md 声称 13）/);
    t.diagnostic(`⑦ 只改 README.md 声称（13 → 14）⇒ ${readmeOnly.length} 处红：\n${readmeOnly.join("\n")}`);

    // ⑧ 只改 `examples/pi-extension/README.md` 的声称（10_000 → 20_000）⇒ 红
    seed();
    write("examples/pi-extension/README.md", mutateText(read("examples/pi-extension/README.md"),
      `\`WAKE_PENDING_MS = ${WAKE_LITERAL}\``, "`WAKE_PENDING_MS = 20_000`", "只改 erix_run README 声称"));
    const wakeDocOnly = report().errors;
    assert.equal(wakeDocOnly.length, 1, `只改 erix_run README 应当恰好 1 处红，实测：\n${wakeDocOnly.join("\n")}`);
    assert.match(wakeDocOnly.join("\n"), /examples\/pi-extension\/README\.md:\d+ 声称 \`WAKE_PENDING_MS = 20000\`，但 examples\/pi-extension\/erix-run-parent-wake\.js 里的真值是 10000/);
    t.diagnostic(`⑧ 只改 erix_run README 声称（10_000 → 20_000）⇒ ${wakeDocOnly.length} 处红：\n${wakeDocOnly.join("\n")}`);

    // ⑨ 只改脚本常量（`export const WAKE_PENDING_MS = 10_000` → 20_000）⇒ 红（真值侧走 `export const`）
    seed();
    write(WAKE_SRC, mutateText(read(WAKE_SRC),
      `export const WAKE_PENDING_MS = ${WAKE_LITERAL};`, "export const WAKE_PENDING_MS = 20_000;", "只改 WAKE 脚本常量"));
    const wakeScriptOnly = report().errors;
    assert.equal(wakeScriptOnly.length, 1, `只改 WAKE 脚本常量应当恰好 1 处红，实测：\n${wakeScriptOnly.join("\n")}`);
    assert.match(wakeScriptOnly.join("\n"), /examples\/pi-extension\/README\.md:\d+ 声称 \`WAKE_PENDING_MS = 10000\`，但 examples\/pi-extension\/erix-run-parent-wake\.js 里的真值是 20000/);
    t.diagnostic(`⑨ 只改脚本常量（WAKE 10_000 → 20_000）⇒ ${wakeScriptOnly.length} 处红：\n${wakeScriptOnly.join("\n")}`);

    // ⑩ 把 `examples/pi-extension/README.md` 里那句整段删掉 ⇒ 因「登记了就必须在」而红
    seed();
    write("examples/pi-extension/README.md", mutateText(read("examples/pi-extension/README.md"),
      `- **\`WAKE_PENDING_MS = ${WAKE_LITERAL}\` pending 窗口**：窗口内不重复排 steer。\n`, "", "删掉 erix_run README 那句声称"));
    assert.match(report().errors.join("\n"), /examples\/pi-extension\/README\.md 里一处 \`WAKE_PENDING_MS = <数字>\` 声称都没有/);
    t.diagnostic(`⑩ 删掉 erix_run README 那句声称 ⇒ ${report().errors.length} 处红：\n${report().errors.join("\n")}`);

    // ⑪ 把 `README_cn.md` 里那句整段删掉 ⇒ 同样红（两份随包 README 各一格）
    seed();
    write("README_cn.md", mutateText(read("README_cn.md"),
      `- 实扫文档：共 13 份（\`REF_SCAN_DOCS_MINIMUM = ${V.REF_SCAN_DOCS_MINIMUM}\`）\n`, "", "删掉 README_cn 那句声称"));
    assert.match(report().errors.join("\n"), /README_cn\.md 里一处 \`REF_SCAN_DOCS_MINIMUM = <数字>\` 声称都没有/);
    t.diagnostic(`⑪ 删掉 README_cn.md 那句声称 ⇒ ${report().errors.length} 处红：\n${report().errors.join("\n")}`);

    // ⑫ 五份文档 + 两个脚本**同时**改到同一个新值 ⇒ 绿（证明扩面后的判据不是恒红）
    seed();
    write(DRIFT_SRC, mutateText(read(DRIFT_SRC),
      `const REF_SCAN_DOCS_MINIMUM = ${V.REF_SCAN_DOCS_MINIMUM};`, "const REF_SCAN_DOCS_MINIMUM = 21;", "全改（脚本 REF）"));
    write(WAKE_SRC, mutateText(read(WAKE_SRC),
      `export const WAKE_PENDING_MS = ${WAKE_LITERAL};`, "export const WAKE_PENDING_MS = 20_000;", "全改（脚本 WAKE）"));
    for (const rel of ["AGENTS.md", "AGENTS_cn.md", "README.md", "README_cn.md"]) {
      write(rel, mutateText(read(rel),
        `\`REF_SCAN_DOCS_MINIMUM = ${V.REF_SCAN_DOCS_MINIMUM}\``, "`REF_SCAN_DOCS_MINIMUM = 21`", `全改（${rel}）`));
    }
    write("examples/pi-extension/README.md", mutateText(read("examples/pi-extension/README.md"),
      `\`WAKE_PENDING_MS = ${WAKE_LITERAL}\``, "`WAKE_PENDING_MS = 20_000`", "全改（erix_run README）"));
    assert.deepEqual(report().errors, [], "五份文档 + 两个脚本同时改到同值必须绿");
    t.diagnostic("⑫ 五份文档 + 两个脚本同改（REF 21 / WAKE 20_000）⇒ 0 处红（绿）");
  });
});

// ── #302：`.gitignore` 目录规则 ↔ `scripts/docs-drift-check.mjs` 的 `IGNORED_DIR_CLASSES` 双向一致 ──
//
// 病根（#273 埋的、2026-10-15 现场踩过）：两个方向只有一半被看守。
//   · 正向（`.gitignore` 有规则、登记表没类别）**已经有**了——`scripts/docs-drift-check.mjs` 的
//     `collectPathErrors()` 会直接报「`.gitignore:N 的目录规则 … 没在 IGNORED_DIR_CLASSES 里分类`」，
//     `--self-test` 里还有 #337 那一对反向证钉着它。实测（本单）：给 `.gitignore` 加一条 `zz-probe/`
//     而不登记类别 ⇒ `check:docs` 当场红并点名那条规则。
//   · 反向（登记表有类别、`.gitignore` 里没有对应规则）**没有任何人校**。实测（本单）：把
//     `.gitignore` 的 `logs/` 那行删掉之后 `check:docs` 与 `check:docs --strict` 双双 exit 0——
//     登记表里那条 `logs/` 从此是一条永不生效的空转条目，谁把它删了都没人知道；更糟的是有人以为
//     「这类目录已被处理」，而 `.gitignore` 根本不忽略它（`dist/` 就是这么一条：登记成 build-output，
//     `.gitignore` 里从来就没有过这条规则，本单加上这条守卫时才被它自己抓出来）。
// 所以这条规则是**成对**的：缺哪一半都红，并分别点名差在哪几条规则上。写成纯函数 + 现造文本反向证，
// 不靠「今天树里恰好少一条」碰运气。

/** 从脚本源码里解析 `IGNORED_DIR_CLASSES`（`new Map([["dir/", { kind, why }], …])`）。
 *  只认这一个字面量：解析不到就抛——宁可炸也不要静默返回空表（空表会让本规则恒绿）。 */
function parseIgnoredDirClasses(src) {
  const block = src.match(/const IGNORED_DIR_CLASSES = new Map\(\[([\s\S]*?)\n\]\);/);
  assert.ok(block, "scripts/docs-drift-check.mjs 里找不到 `const IGNORED_DIR_CLASSES = new Map([` 字面量："
    + "本规则靠它取真值，解析器必须先能看见它（找不到就抛，不许静默返回空表）");
  const out = new Map();
  for (const m of block[1].matchAll(/\[\s*"([^"]+)"\s*,\s*\{\s*kind:\s*"([^"]+)"\s*,\s*why:\s*"((?:[^"\\]|\\.)*)"\s*\}/g)) {
    out.set(m[1], { kind: m[2], why: m[3] });
  }
  return out;
}

/** `.gitignore` 里的**目录型规则**（以 `/` 结尾；注释与取反行不算——取反本身是另一种病，
 *  由 docs-drift-check 的 `unsupported` 那一支报）。 */
function gitignoreDirRules(text) {
  return text.split(/\r?\n/)
    .map((raw, i) => ({ line: i + 1, rule: raw.trim() }))
    .filter(({ rule }) => rule && !rule.startsWith("#") && !rule.startsWith("!") && rule.endsWith("/"));
}

/** 双向差集（纯函数，自带反向证）：缺哪一半都点名。 */
function ignoreDirClassDiff(gitignoreText, classes) {
  const rules = gitignoreDirRules(gitignoreText);
  const patterns = rules.map((r) => r.rule);
  return {
    rules,
    // 正向：`.gitignore` 有这条目录规则，登记表里没有类别
    unclassified: patterns.filter((p) => !classes.has(p)),
    // 反向：登记表里有这个类别，`.gitignore` 里没有对应规则（= 空转条目）
    orphan: [...classes.keys()].filter((p) => !patterns.includes(p)),
  };
}

describe("静态守卫：.gitignore 目录规则与 IGNORED_DIR_CLASSES 双向一致（issue #302）", () => {
  const scriptSrc = readFileSync(resolve(ROOT, "scripts/docs-drift-check.mjs"), "utf8");
  const gitignore = readFileSync(resolve(ROOT, ".gitignore"), "utf8");
  const classes = parseIgnoredDirClasses(scriptSrc);

  it("前置：两边都解析出了东西（否则本规则恒绿）", () => {
    assert.ok(classes.size >= 5, `IGNORED_DIR_CLASSES 只解析出 ${classes.size} 条：解析器或那张表被改坏了`);
    const rules = gitignoreDirRules(gitignore);
    assert.ok(rules.length >= 4, `.gitignore 只解析出 ${rules.length} 条目录规则：解析口径被改窄了（当前：${rules.map((r) => r.rule).join(", ")}）`);
    // 每条登记都要有类别名与理由：空理由等于「分类过了但没人知道为什么」
    for (const [pattern, cls] of classes) {
      assert.ok(pattern.endsWith("/"), `IGNORED_DIR_CLASSES 的键必须是目录（以 / 结尾）：${pattern}`);
      assert.ok(cls.kind && cls.kind.length >= 3, `${pattern} 没有类别名`);
      assert.ok(cls.why.trim().length >= 4, `${pattern} 的分类理由等于没写：${JSON.stringify(cls.why)}`);
    }
  });

  it("两个方向都闭合：`.gitignore` 每条目录规则都有类别，每个类别都有对应规则", () => {
    const { rules, unclassified, orphan } = ignoreDirClassDiff(gitignore, classes);
    assert.deepEqual(
      unclassified,
      [],
      "`.gitignore` 里有目录规则没在 IGNORED_DIR_CLASSES 里分类："
      + `${unclassified.join(", ")}（被忽略目录里的引用要不要放行、要不要进扫描面，得由分类决定——`
      + "这正是 docs-drift-check 自己会报的那条红，本规则在 `npm test` 这一侧再钉一遍）",
    );
    assert.deepEqual(
      orphan,
      [],
      "IGNORED_DIR_CLASSES 里有类别，`.gitignore` 里却没有对应的目录规则（空转条目）："
      + `${orphan.join(", ")}——要么在 .gitignore 里补回那条规则，要么从 IGNORED_DIR_CLASSES 里删掉这个类别；`
      + "留着它就是给未来的漂移留后门（有人会以为「这类目录已经被处理」，而 git 根本不忽略它）",
    );
    // 扫描面自检：`.gitignore` 的目录规则必须多于登记表的 0 条，且本仓真实存在的那几条在两边都看得见
    assert.ok(rules.length === [...classes.keys()].filter((p) => rules.some((r) => r.rule === p)).length,
      "两边的目录规则条数不一致（上面两条断言之外还漏了？）");
    for (const must of ["docs/tasks/", "docs/delivery/"]) {
      assert.ok(classes.has(must), `IGNORED_DIR_CLASSES 里没有 ${must}：本机档案类的分类被拆了`);
      assert.ok(rules.some((r) => r.rule === must), `.gitignore 里没有 ${must}：本机档案目录不再被忽略，档案会被提交进库`);
    }
  });

  it("反向证：两个方向各自缺一条都会红（拿现造文本证，不靠树里恰好少一条）", () => {
    // 这一例**自带一份**最小文本与登记表，不拿真实 .gitignore 当素材：真实那对一旦不一致，
    // 「两个方向都闭合」那一例已经红过一次了，这里再连带红一次只会把真问题淹掉（本单修前就踩过）。
    const base = "# 注释行不算规则\nnode_modules/\nlogs/\n*.log\n";
    const sample = new Map([
      ["node_modules/", { kind: "install-tree", why: "样例：安装位置" }],
      ["logs/", { kind: "runtime", why: "样例：运行日志" }],
    ]);
    // ④ 先证「两边一致时必须是空的」，否则下面三条只是「永远有话说」
    assert.deepEqual(ignoreDirClassDiff(base, sample), { rules: gitignoreDirRules(base), unclassified: [], orphan: [] },
      "自带的样例文本本身就不一致：纯函数口径有问题");
    // ① 反向那一半：登记表里的类别在 .gitignore 里没有规则 → orphan 点名它
    const dropped = base.split(/\r?\n/).filter((l) => l.trim() !== "logs/").join("\n");
    assert.ok(!dropped.split(/\r?\n/).some((l) => l.trim() === "logs/"), "变异没落上：logs/ 还在文本里");
    const rev = ignoreDirClassDiff(dropped, sample);
    assert.deepEqual(rev.orphan, ["logs/"], `反向证失败：删掉 .gitignore 的 logs/ 之后 orphan 应为 ["logs/"]，实测 ${JSON.stringify(rev.orphan)}`);
    assert.deepEqual(rev.unclassified, [], "反向证里不该冒正向问题");
    // ② 正向那一半：.gitignore 多一条没分类的目录规则 → unclassified 点名它
    const fwd = ignoreDirClassDiff(`${base}zz-302-probe-dir/\n`, sample);
    assert.deepEqual(fwd.unclassified, ["zz-302-probe-dir/"], `正向证失败：新增未登记目录规则应被点名，实测 ${JSON.stringify(fwd.unclassified)}`);
    assert.deepEqual(fwd.orphan, [], "正向证里不该冒反向问题");
    // ③ 只在登记表一侧多一条 → 仍然是 orphan（空转条目不因为「看起来合理」就放过）
    const extraClass = new Map(sample);
    extraClass.set("zz-302-orphan/", { kind: "scratch", why: "反向证用的假类别：.gitignore 里没有这条规则" });
    assert.deepEqual(ignoreDirClassDiff(base, extraClass).orphan, ["zz-302-orphan/"], "空转条目没被点名");
    // ⑤ 非目录规则（`*.log`、裸文件名、注释）一律不进两边：口径不能被扩到文件级
    assert.deepEqual(gitignoreDirRules("*.log\npackage-lock.json\n# docs/tasks/\n").map((r) => r.rule), [],
      "非目录规则被当成了目录规则：这条守卫会开始对文件级规则要求分类");
  });
});
// ── 规则 5：描述 `--self-test` 当前行为的句子不许再拿「已知假红」冒充现状（issue #377） ──
//
// 病根（#377 现场）：`AGENTS.md:69` / `AGENTS_cn.md:66` 的命令行表里，`docs-drift-check --self-test`
// 那一行从 #302 之前一直留到 0.24.0，写着「**必须在开发树里跑**：……其中 3 例是**已知假红**」。
// #302（PR #369）把树形判定改成**合成树夹具**之后，`git archive` 导出的干净树上实测 **103 例全 ✓**；
// 同一份 AGENTS 的 CI 段（EN/CN 两行）已被 #369 改口成「那批干净克隆红数已经不存在」⇒ 中英两份**自相矛盾**，
// 而 `check:docs` / `check:docs:strict` 双双 exit 0：它们校的是清单/枚举/单位/路径/命令/默认值这些**锚点**，
// 抓不到「这句散文今天还成立吗」。本单（以及这条规则）存在的理由就是那个缺口。
//
// 判据（**只禁止一种形状，不做语义判断**——语义判断交给评审，机器只管「有没有冒充现状的措辞」）：
//   · 范围：提到 `--self-test` 的**段落**（blank line 分隔）；段内出现「已知假红 / known false red」的行，
//     该段落必须带**时态标记**（`#302 之前` / `#302 以前` / `before #302`）。
//   · 为什么按段落而不是按行：中文句子会折行（`docs/host-upgrade-guide-0.19.0_cn.md` 那句的「已知假红」与
//     命令名就不在同一行），按行判会漏——那正是本规则要接住的形状。
//   · 为什么「带时态标记就放行」：历史要留（#377 明写「别删历史」），本规则只禁止它**冒充现状**。
//   · 为什么不是「出现『假红』就红」：那个词在 `test/` / `scripts/` 的注释里是常用语（「宁可假红，不要假绿」），
//     全仓禁令会淹死在误报里。本规则只管散文（文档 + 代码注释），且只管那一两个措辞；口径与第 3 条一致（宁可窄而真）。
//   · 另加一条**覆盖面**断言（#210 那族「句子被删也要红」）：两份 AGENTS 的 `--self-test` 那一行必须在，
//     且必须提到 `#302`——否则有人把整句删掉，上面那条禁令就恒绿了。
//   · 代码面（#384）：门禁脚本（`scripts/*.mjs`）与测试（`test/**`）的**注释**也在面内——改门禁的人读的
//     第一手材料就是那些注释，而 #377 只清了文档，同一类话在那里还有一份。只认**整行注释**（`isCommentLine`）：
//     代码里的字符串是靶子字面（本文件「放行证与范围证」那几条 `sample([...])` 就是故意造的红），
//     把它们算进面里等于让规则咬自己的反向证。提到集合也从「`--self-test`」扩到「`--self-test` 或
//     干净 clone / clean clone」：**#302 之前**那批红正是「干净 clone 本来就会红几例」的产物，
//     那种句子最容易冒充现状。段内出现「已知假红 / known false red」却没有任何时态标记 ⇒ 红并点名 `文件:行`。

/** 禁止冒充现状的措辞（真实树上的命中清单由下面「规则 5」用例的 diagnostic 打出来：文档面 4 处 +
 *  代码面若干处，后者都在本文件规则 5 的头注释里——#384 起代码注释也进面）。 */
const SELF_TEST_FALSE_RED_PHRASES = Object.freeze([
  { name: "已知假红", re: /已知假红/ },
  { name: "known false red", re: /known false reds?/i },
]);

/** 时态标记：把这句读成历史而不是现状。 */
const SELF_TEST_TENSE_MARKERS = Object.freeze([
  { name: "#302 之前", re: /#302\s*之前/ },
  { name: "#302 以前", re: /#302\s*以前/ },
  { name: "before #302", re: /\bbefore\s+#302\b/i },
]);

/** 提及集合：一段话提到其中任一，这段话才是在描述「树形 / 干净检出」那件事（#384 起从单个命令名扩到这里）。 */
const SELF_TEST_PROSE_MENTIONS = Object.freeze([
  { name: "--self-test", re: /--self-test/ },
  { name: "干净 clone", re: /干净\s*clone/ },
  { name: "clean clone", re: /clean\s+clone/i },
]);

/** 代码面只看整行注释：非注释行换成空行（行号不动），于是段落切分与报错点名与文档面完全同形。 */
function commentOnlyView(text) {
  return text.split(/\r?\n/).map((line) => (isCommentLine(line) ? line : "")).join("\n");
}

/** 段落切分（保留每行自己的行号，报错要点名到行）。 */
function paragraphsOf(text) {
  const out = [];
  let cur = null;
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") {
      cur = null;
      return;
    }
    if (!cur) {
      cur = { startLine: i + 1, lines: [] };
      out.push(cur);
    }
    cur.lines.push({ line: i + 1, text: line });
  });
  return out;
}

/**
 * 规则 5 的核心（**纯函数，读文本可注入**——反向证直接喂改过的真实文本，不碰磁盘）。
 *
 * @param {{readText: (rel: string) => (string|null), docs?: readonly string[], codeFiles?: readonly string[]}} params
 * @returns {{errors: string[], rows: {doc: string, kind: "doc"|"code", line: number, phrase: string, markerLine: number|null}[]}}
 */
function selfTestFalseRedReport({ readText, docs = SELF_TEST_PROSE_DOCS, codeFiles = SELF_TEST_PROSE_CODE_FILES }) {
  const errors = [];
  const rows = [];
  const surfaces = [
    ...docs.map((doc) => ({ doc, kind: "doc" })),
    ...codeFiles.map((doc) => ({ doc, kind: "code" })),
  ];
  for (const { doc, kind } of surfaces) {
    const text = readText(doc);
    if (typeof text !== "string") {
      errors.push(`self-test-prose: ${doc} 读不到文本——描述面少一份（文档与代码面同口径：少一份就等于那份没人校，issue #377 / #384）`);
      continue;
    }
    for (const para of paragraphsOf(kind === "code" ? commentOnlyView(text) : text)) {
      if (!para.lines.some((l) => SELF_TEST_PROSE_MENTIONS.some((m) => m.re.test(l.text)))) continue;
      const marker = para.lines.find((l) => SELF_TEST_TENSE_MARKERS.some((m) => m.re.test(l.text)));
      for (const l of para.lines) {
        for (const phrase of SELF_TEST_FALSE_RED_PHRASES) {
          if (!phrase.re.test(l.text)) continue;
          rows.push({ doc, kind, line: l.line, phrase: phrase.name, markerLine: marker ? marker.line : null });
          if (!marker) {
            errors.push(`self-test-prose: ${doc}:${l.line} 用「${phrase.name}」描述 \`--self-test\` / 干净检出，同段落却没有时态标记`
              + "（`#302 之前` / `before #302`）——#302 起树形用例跑在合成树夹具上，干净检出实测 103 例全绿："
              + "要么按现在的行为重写这句，要么把历史留成带时态的一句（issue #377 / #384）");
          }
        }
      }
    }
  }
  return { errors, rows };
}

/** 覆盖面：两份 AGENTS 的 `--self-test` 那一行必须在，且必须提到 `#302`（句子被删也要红）。 */
const SELF_TEST_ROW_DOCS = Object.freeze(["AGENTS.md", "AGENTS_cn.md"]);

function selfTestRowCoverageErrors({ readText, docs = SELF_TEST_ROW_DOCS }) {
  const errors = [];
  const rowRe = /^\|\s*`node scripts\/docs-drift-check\.mjs --self-test`\s*\|/;
  for (const doc of docs) {
    const text = readText(doc);
    if (typeof text !== "string") {
      errors.push(`self-test-prose: ${doc} 读不到文本——覆盖面少一份`);
      continue;
    }
    const line = text.split(/\r?\n/).find((l) => rowRe.test(l));
    if (!line) {
      errors.push(`self-test-prose: ${doc} 里找不到 \`node scripts/docs-drift-check.mjs --self-test\` 那一行——`
        + "命令表少一条（删句子不能算绿；issue #377）");
      continue;
    }
    if (!/#302/.test(line)) {
      errors.push(`self-test-prose: ${doc} 的 \`--self-test\` 那一行不再提 #302——合成树夹具这半事实被删掉了，`
        + "本规则会因此恒绿（issue #377）");
    }
  }
  return errors;
}

/** 描述面：第 4 条那五份（两份 AGENTS + 两份随包 README + `erix_run` 的 README）+ 顶层 `docs/*.md`。
 *  `docs/design/` / `docs/research/` / `docs/decisions/` / `docs/tasks/` 这些**带日期的档案**不在面内：
 *  它们按定义是「当时怎么想、当时什么行为」的记录，逼它们改口等于改历史（与 `docs/tasks/` 不入库同理）。 */
const SELF_TEST_PROSE_DOCS = Object.freeze([
  ...CLAIMED_VALUE_DOC_RULES.map((r) => r.doc),
  ...readdirSync(resolve(ROOT, "docs"))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `docs/${name}`),
]);

/** 代码面（#384）：门禁脚本 `scripts/*.mjs` + 测试 `test/**`。这些文件的**注释**是改门禁的人读的第一手材料，
 *  #377 只清了文档，同一类话在这里还有一份。扫描时只认整行注释（`commentOnlyView`），代码里的字符串不进面。
 *  面本身也钉住（见下面「规则 5」用例里的代码面断言）：只许是这两个目录，少一份就红——而不是静默缩小扫描面。 */
const SELF_TEST_PROSE_CODE_FILES = Object.freeze([
  ...readdirSync(resolve(ROOT, "scripts"))
    .filter((name) => name.endsWith(".mjs"))
    .sort()
    .map((name) => `scripts/${name}`),
  ...[...listScannable(CODE_EXTS, "test")].map((f) => f.rel).sort(),
]);

describe("静态守卫：`--self-test` 的散文不许拿「已知假红」冒充现状（issue #377；#384 扩到代码注释）", () => {
  it("规则 5：真实树上每条「已知假红」都有时态标记（回归基线），且两份 AGENTS 的那一行都在", (t) => {
    const { errors, rows } = selfTestFalseRedReport({ readText: realReadText });
    t.diagnostic(`规则 5：命中 ${rows.length} 处（「已知假红 / known false red」）：`);
    for (const row of rows) {
      t.diagnostic(`  ${row.doc}:${row.line}「${row.phrase}」← 时态标记在 ${row.markerLine === null ? "（无）" : `:${row.markerLine}`}`);
    }
    assert.deepEqual(errors, [], `有句子拿「已知假红」冒充现状：\n${errors.join("\n")}`);
    // 真实树上确实**有**命中（不是恒绿）：两份 AGENTS 各一处，且都带时态标记
    for (const doc of SELF_TEST_ROW_DOCS) {
      const hit = rows.find((r) => r.doc === doc);
      assert.ok(hit, `${doc} 里一处「已知假红 / known false red」都没有：若句子被改成别的措辞，`
        + "请同步本规则的靶子（恒绿比红更糟）");
      assert.notEqual(hit.markerLine, null, `${doc}:${hit.line} 的时态标记没被认出来`);
    }
    // 覆盖面：扫描面本身不许缩水（五份文档 + 顶层 docs/*.md）
    assert.deepEqual(
      SELF_TEST_PROSE_DOCS.slice(0, CLAIMED_VALUE_DOC_RULES.length),
      ["AGENTS.md", "AGENTS_cn.md", "README.md", "README_cn.md", "examples/pi-extension/README.md"],
      "规则 5 的描述面被改窄了（前五份必须与第 4 条的声称面一致）",
    );
    assert.ok(SELF_TEST_PROSE_DOCS.length > CLAIMED_VALUE_DOC_RULES.length, "顶层 docs/*.md 一份都没纳进来：docs 面被拆了");
    assert.ok(SELF_TEST_PROSE_DOCS.includes("docs/host-upgrade-guide-0.19.0_cn.md"),
      "0.19.0 指南（中英成对）不在面内：本单修的那两段就没人看住了");

    const coverage = selfTestRowCoverageErrors({ readText: realReadText });
    assert.deepEqual(coverage, [], `两份 AGENTS 的 \`--self-test\` 行覆盖面掉了：\n${coverage.join("\n")}`);
    t.diagnostic("规则 5 覆盖面：AGENTS.md / AGENTS_cn.md 的 `--self-test` 行都在，且都提到 #302");

    // 代码面（#384）：门禁脚本 + 测试的注释也在面内，且面本身不许缩水
    assert.ok(SELF_TEST_PROSE_CODE_FILES.includes("scripts/docs-drift-check.mjs"), "门禁脚本不在代码面里");
    assert.ok(SELF_TEST_PROSE_CODE_FILES.includes(SELF), "守卫自己不在代码面里：自审是这条规则的底线");
    assert.ok(SELF_TEST_PROSE_CODE_FILES.every((f) => f.startsWith("scripts/") || f.startsWith("test/")),
      "代码面混进了 scripts/ 与 test/ 之外的文件");
    assert.ok(SELF_TEST_PROSE_CODE_FILES.filter((f) => f.startsWith("test/")).length >= 100,
      `test/ 面只剩 ${SELF_TEST_PROSE_CODE_FILES.filter((f) => f.startsWith("test/")).length} 份：扫描面被改窄了`);
    const codeRows = rows.filter((r) => r.kind === "code");
    assert.ok(codeRows.length >= 1,
      "代码面一处命中都没有：本文件规则 5 的病根段本来就该命中（若那句话被改写成别的措辞，请同步靶子；恒绿比红更糟）");
    assert.ok(codeRows.some((r) => r.doc === SELF && r.markerLine !== null),
      "本文件规则 5 病根段的命中没有时态标记：那段历史叙述会冒充现状");
    t.diagnostic(`规则 5 代码面：${SELF_TEST_PROSE_CODE_FILES.length} 份（scripts/*.mjs + test/**），命中 ${codeRows.length} 处`);
  });

  it("规则 5 反向证：删掉时态标记 ⇒ 红（中英各一格；变异没落上也算失败）", (t) => {
    // ① EN：把「Before #302 it was the other way round」的时态标记删掉 ⇒ AGENTS.md 那一行红
    const enBroken = mutateText(realReadText("AGENTS.md"),
      "Before #302 it was the other way round:", "It used to be the other way round:", "删掉 EN 时态标记");
    const enReport = selfTestFalseRedReport({
      readText: (rel) => (rel === "AGENTS.md" ? enBroken : realReadText(rel)), codeFiles: [],
    });
    assert.equal(enReport.errors.length, 1, `只删 EN 时态标记应恰好 1 处红，实测：\n${enReport.errors.join("\n")}`);
    assert.match(enReport.errors.join("\n"), /self-test-prose: AGENTS\.md:\d+ 用「known false red」/);
    t.diagnostic(`① 删掉 AGENTS.md 的「Before #302」⇒ ${enReport.errors.length} 处红：\n${enReport.errors.join("\n")}`);

    // ② CN：把「#302 之前是另一回事」的时态标记删掉 ⇒ AGENTS_cn.md 那一行红
    const cnBroken = mutateText(realReadText("AGENTS_cn.md"),
      "#302 之前是另一回事", "曾经是另一回事", "删掉 CN 时态标记");
    const cnReport = selfTestFalseRedReport({
      readText: (rel) => (rel === "AGENTS_cn.md" ? cnBroken : realReadText(rel)), codeFiles: [],
    });
    assert.equal(cnReport.errors.length, 1, `只删 CN 时态标记应恰好 1 处红，实测：\n${cnReport.errors.join("\n")}`);
    assert.match(cnReport.errors.join("\n"), /self-test-prose: AGENTS_cn\.md:\d+ 用「已知假红」/);
    t.diagnostic(`② 删掉 AGENTS_cn.md 的「#302 之前」⇒ ${cnReport.errors.length} 处红：\n${cnReport.errors.join("\n")}`);

    // ③ 把 0.19.0 指南的时态标记删掉（中文那半）⇒ 红：证明修好的历史叙述也被同一条规则看住
    const guide = "docs/host-upgrade-guide-0.19.0_cn.md";
    const guideBroken = mutateText(realReadText(guide), "**那是 #302 之前的事**", "**那批红仍然在**", "删掉指南时态标记");
    const guideReport = selfTestFalseRedReport({
      readText: (rel) => (rel === guide ? guideBroken : realReadText(rel)), codeFiles: [],
    });
    assert.equal(guideReport.errors.length, 1, `只删指南时态标记应恰好 1 处红，实测：\n${guideReport.errors.join("\n")}`);
    assert.match(guideReport.errors.join("\n"), /docs\/host-upgrade-guide-0\.19\.0_cn\.md:\d+ 用「已知假红」/);
    t.diagnostic(`③ 删掉 0.19.0 指南（CN）的「#302 之前」⇒ ${guideReport.errors.length} 处红：\n${guideReport.errors.join("\n")}`);

    // ④ 覆盖面那一刀：把 AGENTS.md 那一行里的 #302 全抹掉 ⇒ 红（句子还在但事实被抽走）
    const noVerdict = mutateText(realReadText("AGENTS.md"),
      "**Since issue #302 the tree it runs in does not change the verdict**", "**Run it in the development tree**",
      "抹掉 AGENTS.md 那行的 #302（前半句）");
    const rowBroken = mutateText(noVerdict,
      "Before #302 it was the other way round:", "It used to be the other way round:",
      "抹掉 AGENTS.md 那行的 #302（后半句）");
    assert.ok(!rowBroken.split(/\r?\n/).find((l) => l.includes("`node scripts/docs-drift-check.mjs --self-test`")).includes("#302"),
      "变异没落上：AGENTS.md 那一行里还找得到 #302");
    const rowErrors = selfTestRowCoverageErrors({ readText: (rel) => (rel === "AGENTS.md" ? rowBroken : realReadText(rel)) });
    assert.equal(rowErrors.length, 1, `抹掉那一行的 #302 应恰好 1 处红，实测：\n${rowErrors.join("\n")}`);
    assert.match(rowErrors.join("\n"), /AGENTS\.md 的 `--self-test` 那一行不再提 #302/);
    t.diagnostic(`④ 抹掉 AGENTS.md 那一行的 #302 ⇒ ${rowErrors.length} 处红：\n${rowErrors.join("\n")}`);

    // ⑤ 把那一行整行删掉 ⇒ 红（#210 那族：句子被删也要红，否则上面那条禁令恒绿）
    const rowLineRe = /^\|\s*`node scripts\/docs-drift-check\.mjs --self-test`\s*\|/;
    const lines = realReadText("AGENTS.md").split(/\r?\n/);
    const rowIndex = lines.findIndex((l) => rowLineRe.test(l));
    assert.notEqual(rowIndex, -1, "变异没落上：AGENTS.md 里找不到 `--self-test` 那一行");
    const rowDeleted = lines.filter((_, i) => i !== rowIndex).join("\n");
    const delErrors = selfTestRowCoverageErrors({ readText: (rel) => (rel === "AGENTS.md" ? rowDeleted : realReadText(rel)) });
    assert.equal(delErrors.length, 1, `整行删掉应恰好 1 处红，实测：\n${delErrors.join("\n")}`);
    assert.match(delErrors.join("\n"), /AGENTS\.md 里找不到/);
    t.diagnostic(`⑤ 整行删掉 AGENTS.md 的 \`--self-test\` 行 ⇒ ${delErrors.length} 处红：\n${delErrors.join("\n")}`);
  });

  it("规则 5 的放行证与范围证（不是恒红、也不是全仓禁词）", (t) => {
    const sample = (lines) => lines.join("\n");
    // ⑤ 带时态标记 ⇒ 绿（历史可以留）
    assert.deepEqual(selfTestFalseRedReport({
      readText: () => sample(["`node scripts/docs-drift-check.mjs --self-test` 的树形用例：", "  #302 之前有 3 例已知假红，现在 0 红。"]),
      docs: ["x.md"], codeFiles: [],
    }).errors, [], "带时态标记的历史叙述被误判成红");
    // ⑥ 段落级：标记折到下一行也算（中文会换行，按行判会漏）
    assert.deepEqual(selfTestFalseRedReport({
      readText: () => sample(["`--self-test` 在干净检出里 3 例 known false reds", "before #302 it was; now 0."]),
      docs: ["x.md"], codeFiles: [],
    }).errors, [], "时态标记折行时被误判成红（段落级口径失效）");
    // ⑦ 不带时态标记 ⇒ 红（反向证的对照：证明上面两条不是恒绿）
    assert.equal(selfTestFalseRedReport({
      readText: () => sample(["`--self-test` 在干净检出里 3 例 known false reds。"]),
      docs: ["x.md"], codeFiles: [],
    }).errors.length, 1, "不带时态标记的现状口吻没被抓住");
    // ⑧ 范围证：段落里只出现「假红」、不出现 SELF_TEST_FALSE_RED_PHRASES 里那两个措辞 ⇒ 不红
    assert.deepEqual(selfTestFalseRedReport({
      readText: () => sample(["`--self-test` 宁可假红，不要假绿。"]),
      docs: ["x.md"], codeFiles: [],
    }).errors, [], "「假红」这个常用词被一刀切了：这条规则会开始淹死在误报里");
    // ⑨ 范围证：没提到 SELF_TEST_PROSE_MENTIONS 里任何一项的段落 ⇒ 不红（别的主题不归本条管）
    assert.deepEqual(selfTestFalseRedReport({
      readText: () => sample(["`check:release` 历史上 3 例已知假红。"]),
      docs: ["x.md"], codeFiles: [],
    }).errors, [], "不描述 `--self-test` 的段落被误伤");
    // ⑩ 读不到文本 ⇒ 红（描述面少一份不许静默放行）
    assert.equal(selfTestFalseRedReport({ readText: () => null, docs: ["gone.md"], codeFiles: [] }).errors.length, 1,
      "文档读不到时没有报错（描述面少一份被静默吞掉）");
    t.diagnostic("⑤–⑩ 放行证 / 范围证 / 读不到文本 逐条按预期");
  });

  it("规则 5 的代码面：注释里删掉时态标记 ⇒ 红并点名那一行（内存假文件，不依赖真树内容）", (t) => {
    const fake = (lines) => lines.join("\n");
    // ① 注释里带时态标记 ⇒ 绿（代码面与文档面同一判据）
    const withMarker = fake(["// 树形用例（#302 之前有 3 例已知假红，现在 0 红）：干净 clone 里也一样。"]);
    assert.deepEqual(selfTestFalseRedReport({ readText: () => withMarker, docs: [], codeFiles: ["fake/a.js"] }).errors, [],
      "代码注释里带时态标记的历史叙述被误判成红");
    // ② 把时态标记删掉 ⇒ 恰好 1 处红，并点名 `文件:行`（这一格就是工单要的反向证，靶子全在内存里）
    const noMarker = withMarker.replace("#302 之前", "当时");
    const red = selfTestFalseRedReport({ readText: () => noMarker, docs: [], codeFiles: ["fake/a.js"] });
    assert.equal(red.errors.length, 1, `删掉代码注释里的时态标记应恰好 1 处红，实测：\n${red.errors.join("\n")}`);
    assert.match(red.errors.join("\n"), /self-test-prose: fake\/a\.js:1 用「已知假红」/);
    assert.equal(red.rows[0].kind, "code");
    t.diagnostic(`① 删掉假文件注释里的「#302 之前」⇒ ${red.errors.length} 处红：${red.errors.join("\n")}`);
    // ③ 代码串不算：同一条句子写成字符串字面量 ⇒ 绿（靶子字面不是散文，把它们算进面里规则会咬自己的反向证）
    const asCode = fake(['      readText: () => sample(["`--self-test` 在干净 clone 里 3 例 known false reds。"]),']);
    assert.deepEqual(selfTestFalseRedReport({ readText: () => asCode, docs: [], codeFiles: ["fake/b.js"] }).errors, [],
      "代码串（非注释）被算成了散文：本规则会把规则自己的靶子字面当违规");
    // ④ 块注释也算（`/* */` 与 ` * ` 续行）——门禁脚本的头注释就是这个形状，只认 `//` 会让它们整片漏掉
    const block = fake(["/*", " * `--self-test` 在干净 clone 里 3 例 known false reds", " */"]);
    assert.equal(selfTestFalseRedReport({ readText: () => block, docs: [], codeFiles: ["fake/c.js"] }).errors.length, 1,
      "块注释里的现状口吻没被抓住");
    // ⑤ 代码面读不到文本 ⇒ 红（面少一份不许静默放行，与文档面同口径）
    assert.equal(selfTestFalseRedReport({ readText: () => null, docs: [], codeFiles: ["fake/gone.js"] }).errors.length, 1,
      "代码面读不到文本时没有报错（面少一份被静默吞掉）");
    t.diagnostic("①–⑤ 代码面反向证 / 范围证 / 读不到文本 逐条按预期");
  });
});

// ── #433 T0：`resolveExecCeiling → createCliTools({ execCeilingMs })` 这条接线的静态护栏 ──
//
// 病根（PR #444 评审现场）：T0 的修法有两半——引擎侧（`bin/tools.js#getCommandTimeoutMs` 按
// `ceilingMs` 收口）与**装配侧**（`bin/cli.js#runChat` / `bin/repl.js#runRepl` 各调一次
// `resolveExecCeiling(idleTimeout)`，把结果当 `execCeilingMs` 传给 `createCliTools`）。
// 评审把**两处装配都断开**（`execCeilingMs` 从调用里去掉）之后全量测试**照样全绿**：
// `test/tools.test.js` 是自己给 `createCliTools({ execCeilingMs: … })` 喂值的，
// `test/cli-idle.test.js` 走的是「工具期喂表」与纯函数口径——**没有任何一格**真的去看那两处
// 装配点写了什么。于是「接线被拆掉」只有人眼能发现。这条护栏补的就是那一格。
//
// 判据（**纯函数，读文本可注入**——反向证直接拿它问，不绑真实文件）：
//   · 装配文件里必须有一个 `createCliTools({ … })` **调用**，其实参对象里出现 `execCeilingMs`，
//     且不是 `execCeilingMs: null` / `undefined`（`null` 就是「不钳」，等于接线断开）；
//   · 同一个文件里还要有 `resolveExecCeiling(` 调用——只传一个常量同样接不上；
//   · 覆盖面**逐份点名**（`bin/cli.js` / `bin/repl.js`）：少一份 = 少一处接线，且会静默缩面。
// 口径与其余几条一致：宁可窄而真（只认这一个选项名与这两个文件，不做语义判断）。

/** 护栏要看见的选项名（**只在这一处**出现；反向证就是把它改掉 ⇒ 恰好「真实树」那一格红）。 */
const EXEC_CEILING_WIRING_OPTION = "execCeilingMs";

/** 覆盖面：`idle → exec 天花板` 的装配点，逐份点名 + 一句为什么它必须在面内。 */
const EXEC_CEILING_WIRING_FILES = Object.freeze([
  ["bin/cli.js", "runChat：chat 的装配点（`--idle-timeout` 的默认值就从这里进 run）"],
  ["bin/repl.js", "runRepl：repl 的装配点（`--idle-timeout` 缺省 0 = 不启用 ⇒ 不钳）"],
]);

/** 从 `open`（必须是 `{` 或 `(`）起配对到同种括号的闭合处，返回闭合下标（找不到返 -1）。
 *  只做括号计数，不解析字符串字面量：两处装配点的实参都是单行字面量，真出现带括号的字符串实参时
 *  本护栏会红——那时改判据，不许反过来放行。 */
function matchBracket(text, open) {
  const opener = text[open];
  const closer = opener === "{" ? "}" : ")";
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === opener) depth += 1;
    else if (text[i] === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `createCliTools({ … })` 的**实参对象**文本（`export function createCliTools({ … })` 那种声明不算调用）。 */
function createCliToolsCallArgs(text) {
  const needle = "createCliTools(";
  const out = [];
  let i = text.indexOf(needle);
  while (i !== -1) {
    const isDeclaration = /function\s+$/.test(text.slice(Math.max(0, i - 40), i));
    const argStart = i + needle.length;
    if (!isDeclaration && text[argStart] === "{") {
      const end = matchBracket(text, argStart);
      if (end !== -1) out.push(text.slice(argStart, end + 1));
    }
    i = text.indexOf(needle, i + needle.length);
  }
  return out;
}

/** 接线判据（纯函数）：返回每个装配点的缺口，空数组 = 接线在。 */
function missingExecCeilingWiring(textByFile, option = EXEC_CEILING_WIRING_OPTION) {
  const findings = [];
  const wired = new RegExp(`(?:^|[{,\\s])${option}(?!\\s*:\\s*(?:null|undefined)\\b)`);
  for (const [rel, text] of Object.entries(textByFile)) {
    if (typeof text !== "string") {
      findings.push(`${rel}: 读不到文本（装配点无从校起，不许静默放行）`);
      continue;
    }
    if (!/\bresolveExecCeiling\s*\(/.test(text)) {
      findings.push(`${rel}: 没有 \`resolveExecCeiling(...)\` 调用——exec 天花板没被算出来，接不上`);
    }
    const calls = createCliToolsCallArgs(text);
    if (calls.length === 0) {
      findings.push(`${rel}: 找不到 \`createCliTools({ … })\` 调用点（装配点被改名/搬走？）`);
      continue;
    }
    // 行注释先剥掉：注释里提到选项名不算接线
    const hit = calls.some((args) => wired.test(args.replace(/\/\/[^\n]*/g, "")));
    if (!hit) {
      findings.push(`${rel}: \`createCliTools({ … })\` 的实参里没有 \`${option}\`（或传的是 null/undefined = 不钳）——idle 与 exec 天花板之间的接线断了`);
    }
  }
  return findings;
}

describe("静态守卫：idle → exec 天花板的装配接线（issue #433 T0；PR #444 评审补）", () => {
  const readWiring = () => Object.fromEntries(
    EXEC_CEILING_WIRING_FILES.map(([rel]) => [rel, realReadText(rel)]),
  );

  it("前置：覆盖面逐份点名两处装配点，且每份都真的解析得到 createCliTools({ … }) 调用", (t) => {
    assert.deepEqual(
      EXEC_CEILING_WIRING_FILES.map(([rel]) => rel),
      ["bin/cli.js", "bin/repl.js"],
      "接线护栏的覆盖面被改窄了：两处装配点（chat / repl）都必须逐份点名，否则少的那一处断了没人知道",
    );
    for (const [rel, why] of EXEC_CEILING_WIRING_FILES) {
      const text = realReadText(rel);
      assert.equal(typeof text, "string", `${rel} 读不到文本：装配点无从校起`);
      const calls = createCliToolsCallArgs(text);
      assert.ok(calls.length >= 1,
        `${rel} 里解析不到任何 \`createCliTools({ … })\` 调用（解析口径被改窄 / 装配点被搬走）——本规则会恒绿`);
      t.diagnostic(`${rel}（${why}）: createCliTools 调用点 ${calls.length} 处（${calls.map((a) => a.trim()).join(" | ")}）`);
    }
  });

  it("两处装配点都把 resolveExecCeiling 的结果当 execCeilingMs 传给了 createCliTools（真实树 = 回归基线）", (t) => {
    const findings = missingExecCeilingWiring(readWiring());
    t.diagnostic(`接线判据：${findings.length ? findings.join(" / ") : "两处装配点都在"}`);
    assert.deepEqual(
      findings,
      [],
      `idle → exec 天花板的接线断了（评审的变异就是把这两处拆掉，全量测试照样绿）：\n${findings.join("\n")}\n`
      + "修法：装配处写 `const execCeilingMs = resolveExecCeiling(idleTimeout);` 并把它传给 `createCliTools({ …, execCeilingMs })`；"
      + "传 `null` 等于不钳，同样算断开",
    );
  });

  it("反向证与放行证：拿掉选项 / 传 null / 删掉 resolveExecCeiling ⇒ 各自点名；不动 ⇒ 零处红", (t) => {
    // 合成文本从同一个选项名造：这样「把护栏断言的字面量改掉」时这一格仍然自洽（红的只有真实树那一格）
    const wire = (rel) => [
      `  const execCeilingMs = resolveExecCeiling(idleTimeout);`,
      `  const cliTools = createCliTools({ cwd, todo: !todoDisabled, ${EXEC_CEILING_WIRING_OPTION} });`,
      `  // ${rel}`,
    ].join("\n");
    const fake = (rel, text) => ({ [`fake/${rel}`]: text });

    // ① 放行证：接线完整 ⇒ 零处红（否则下面三条只是「永远有话说」）
    assert.deepEqual(missingExecCeilingWiring(fake("ok.js", wire("ok"))), [], "自带的完整样例被判红：判据口径有问题");
    // ② 拿掉选项 ⇒ 恰好点名那一个文件
    const dropped = wire("dropped").replace(`, ${EXEC_CEILING_WIRING_OPTION} `, " ");
    assert.ok(
      createCliToolsCallArgs(dropped).every((args) => !args.includes(EXEC_CEILING_WIRING_OPTION)),
      "变异没落上：createCliTools 的实参里还有那个选项名",
    );
    const droppedFindings = missingExecCeilingWiring(fake("dropped.js", dropped));
    assert.equal(droppedFindings.length, 1, `拿掉选项应恰好 1 条缺口，实测：${JSON.stringify(droppedFindings)}`);
    assert.match(droppedFindings[0], /^fake\/dropped\.js: .*接线断了/);
    // ③ 传 null / undefined ⇒ 同样算断开（`null` 就是「不钳」，语义上等于没接线）
    for (const bad of ["null", "undefined"]) {
      const asNull = wire("nulled").replace(`, ${EXEC_CEILING_WIRING_OPTION} }`, `, ${EXEC_CEILING_WIRING_OPTION}: ${bad} }`);
      assert.ok(asNull.includes(`${EXEC_CEILING_WIRING_OPTION}: ${bad}`), `变异没落上：${bad} 没写进去`);
      assert.equal(missingExecCeilingWiring(fake("nulled.js", asNull)).length, 1,
        `${EXEC_CEILING_WIRING_OPTION}: ${bad} 被当成了接线（它等于不钳）`);
    }
    // ④ 删掉 resolveExecCeiling ⇒ 点名它（只传一个常量同样接不上）
    const noResolve = wire("noresolve").split("\n").slice(1).join("\n");
    const noResolveFindings = missingExecCeilingWiring(fake("noresolve.js", noResolve));
    assert.equal(noResolveFindings.length, 1, `删掉 resolveExecCeiling 应恰好 1 条缺口，实测：${JSON.stringify(noResolveFindings)}`);
    assert.match(noResolveFindings[0], /没有 `resolveExecCeiling\(\.\.\.\)` 调用/);
    // ⑤ 读不到文本 / 没有 createCliTools 调用 ⇒ 红（面少一份不许静默放行，与其余规则同口径）
    assert.equal(missingExecCeilingWiring({ "fake/gone.js": null }).length, 1, "读不到文本时没有报错");
    assert.equal(missingExecCeilingWiring(fake("nocall.js", "const x = 1;\n")).length, 2,
      "既没有 resolveExecCeiling 也没有 createCliTools 调用时应报两条缺口");
    // ⑥ 声明处不算调用（`export function createCliTools({ execCeilingMs = null })` 不许冒充装配点）
    const declaration = "export function createCliTools({\n  execCeilingMs = null,\n}) {}\n";
    assert.deepEqual(createCliToolsCallArgs(declaration), [], "函数声明被当成了调用点：护栏会拿声明冒充接线");
    // ⑦ 注释里的选项名不算接线
    const commented = [
      "  const execCeilingMs = resolveExecCeiling(idleTimeout);",
      "  const cliTools = createCliTools({ cwd, // execCeilingMs 待接",
      "  });",
    ].join("\n");
    assert.equal(missingExecCeilingWiring(fake("commented.js", commented)).length, 1,
      "注释里提到选项名被当成了接线");
    t.diagnostic("①–⑦ 放行证 / 变异证 / 面证 逐条按预期");
  });
});

// ── 规则 6：随包契约套件 `modelConfigProviderContract(` 的每一处调用都必须传满 3 个实参（issue #518a） ──
//
// 病根（#518a 修复轮现场）：#518 把 `modelConfigProviderContract(label, setup, unknownSlot)` 的第三参
// 改成**必填**（设计上认可：强制每个适配器显式声明自己的未知槽位策略，给默认值会把这件事藏起来），
// 仓内消费者只补齐了 `test/config/*.test.js` 三份——**漏了 `scripts/release-check.mjs`**。那一处
// 不是普通的调用点：它是发布自检脚本在临时根里**生成**的一份消费者视角自检源码（模板字符串里的
// `modelConfigProviderContract(label + " static model config provider", async () => ({…}))`）。
// 于是 `node --test`（含 `node --test test/contract/`）全绿，而 `npm run check:release` 的第 3/5 步
// 当场红（`contract-selftest.test.mjs`，not ok 1）——**破坏面只落在一条不在常规 CI 路径上那么显眼
// 的门禁里**，签名再变一次还会同样漏。这条守卫就是把那一格补上：不靠「今天恰好想起来跑 check:release」，
// 而是让「有调用点少传一个实参」这件事在 `npm test` 里就红。
//
// 判据（纯函数，读文本可注入——反向证直接喂改过的真实文本，不碰磁盘）：
//   · 扫描面：`bin/ scripts/ src/ test/ examples/ fixtures/` 的 js/mjs/cjs（整份文本，**含模板字符串
//     内容**——发布自检那份源码整个是模板字符串，跳过反引号等于把最该管的那一处漏掉）；
//     外加根 `*.md` + `docs/**/*.md` + `examples/**/*.md` 里 **js 围栏**（`docs/testing.md` 的契约示例
//     就是两参写法，本轮一并修掉了）。散文与表格里的签名行不算调用点，不进面（宁可窄而真）。
//   · 每一处 `modelConfigProviderContract(` 都要按括号配对取出实参、按顶层逗号切分，**恰好 3 个**；
//     红时点名 `文件:行` 与实际个数。整行注释里的提及不算（`isCommentLine`）。
//   · 覆盖面**逐份点名**（`EXPECTED_CONTRACT_CALL_SITES`）：漏扫一份 = 少一处调用点，且会静默缩面。
//   · 本文件自己的反向证样本用 `CONTRACT_FN + "("` 在运行时拼出来，不写字面量：否则规则会咬自己的
//     靶子（与规则 5 的「代码串不算散文」同一口径）。

/** 只在这一个常量里出现一次：样本用 `CONTRACT_FN + "("` 拼，避免本文件自己被自己的规则咬到。 */
const CONTRACT_FN = "modelConfigProviderContract";

/** 代码面：整份文本都扫（含模板字符串内容）。 */
const CONTRACT_CALL_CODE_ROOTS = Object.freeze(["bin", "scripts", "src", "test", "examples", "fixtures"]);

/** 文档面：只扫 js 围栏（散文/表格里的签名行不是调用点）。 */
const CONTRACT_CALL_MD_ROOTS = Object.freeze(["docs", "examples"]);

/** 本机档案目录（`.gitignore` 里成对忽略、`IGNORED_DIR_CLASSES` 有分类）：
 *  它们按定义只在本机存在，扫进来会让本规则在开发树上红、在干净 clone 上绿——
 *  与 issue #280 的「门禁必须在两种树上同结论」相悖。 */
const CONTRACT_CALL_MD_SKIP_PREFIXES = Object.freeze(["docs/tasks/", "docs/delivery/"]);

/** 围栏语言标记：只认真正会被当成 js 跑的那几种。 */
const JS_FENCE_LANGS = new Set(["js", "javascript", "mjs", "cjs"]);

/** 覆盖面：每一份**已知**调用点都逐份点名（含发布自检那一份——本轮的病根就在这里）。 */
const EXPECTED_CONTRACT_CALL_SITES = Object.freeze([
  ["scripts/release-check.mjs", "发布自检生成的随包契约自检源码（#518a 的病根：漏传第三参 ⇒ check:release 第 3/5 步红）"],
  ["test/config/env.test.js", "env provider（单配置形态）"],
  ["test/config/json-file.test.js", "json-file provider（槽位图形态）"],
  ["test/config/static.test.js", "static provider（槽位图形态）"],
  ["docs/testing.md", "`docs/testing.md` 的契约套件示例围栏（示例不该教两参写法）"],
  ["docs/testing_cn.md", "`docs/testing_cn.md` 的同一处示例围栏"],
]);

/**
 * 从 `open`（必须是 `(`）起做括号配对，返回闭合下标（找不到返 -1）。
 * 跟踪 `()` / `[]` / `{}`，跳过 `'…'` 与 `"…"` 字符串（含转义）；**不跳反引号**——
 * 发布自检那份源码整个是模板字符串，跳过它就等于把最该管的那一处漏掉。
 */
function matchParen(text, open) {
  const closers = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < text.length && text[i] !== ch) i += text[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (closers[ch]) {
      stack.push(closers[ch]);
      i += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** 按**顶层**逗号切分实参，返回每个实参的 `[start, end)`（相对 `inner`）。空串（`f()`）返回空数组。 */
function splitTopLevelArgs(inner) {
  const spans = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < inner.length && inner[i] !== ch) i += inner[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      spans.push([start, i]);
      start = i + 1;
    }
    i += 1;
  }
  spans.push([start, inner.length]);
  const args = spans.map(([s, e]) => inner.slice(s, e).trim()).filter((a) => a !== "");
  return args;
}

/**
 * 纯函数：给定 `文件相对路径 → 文本`，返回每一处 `modelConfigProviderContract(` 的实参个数。
 * `lineOffset` 由调用方给（md 围栏要换算回文档里的绝对行号）。
 *
 * @param {Record<string, string|null>} textByFile
 * @returns {{sites: {file: string, line: number, kind: "call"|"declaration", argCount: number}[], unparsable: string[]}}
 */
function contractCallSites(textByFile) {
  const re = new RegExp(`\\b${CONTRACT_FN}\\s*\\(`, "g");
  const sites = [];
  const unparsable = [];
  for (const [file, text] of Object.entries(textByFile)) {
    if (typeof text !== "string") continue;
    const lines = text.split(/\r?\n/);
    for (const m of text.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      const line = text.slice(0, m.index).split(/\r?\n/).length;
      // 整行注释里的提及不算调用点（文档式注释里提名字是正当的）
      if (isCommentLine(lines[line - 1] ?? "")) continue;
      const close = matchParen(text, open);
      if (close === -1) {
        unparsable.push(`${file}:${line} 的 \`${CONTRACT_FN}(\` 括号配不上（扫描口径被改坏了？不许静默放行）`);
        continue;
      }
      const kind = /\bfunction\s+$/.test(text.slice(Math.max(0, m.index - 40), m.index)) ? "declaration" : "call";
      sites.push({ file, line, kind, argCount: splitTopLevelArgs(text.slice(open + 1, close)).length });
    }
  }
  return { sites, unparsable };
}

/** 判据：返回每一处「没传满 3 个实参」的缺口（空数组 = 全仓调用点都合规）。 */
function contractArityErrors(textByFile) {
  const { sites, unparsable } = contractCallSites(textByFile);
  const errors = [...unparsable];
  for (const site of sites) {
    if (site.argCount === 3) continue;
    errors.push(
      `${site.file}:${site.line} \`${CONTRACT_FN}(\` 的${site.kind === "declaration" ? "声明只写了" : "调用只传了"}`
      + ` ${site.argCount} 个实参，必须恰好 3 个（label, setup, unknownSlot）——`
      + "第三参 `unknownSlot` 自 issue #518 起**必填**（强制每个适配器显式声明自己的未知槽位策略："
      + "`{mode:\"throws\", name, available}` 槽位图 / `{mode:\"single-config\", name}` 单配置）",
    );
  }
  return errors;
}

/** 扫一份 md 的 js 围栏，返回 `{ [虚拟文件名]: 围栏正文 }`（行号按围栏在文档里的位置补 `\n` 对齐）。 */
function jsFenceTexts(rel, text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const open = /^```(\w*)\s*$/.exec(lines[i]);
    if (!open || !JS_FENCE_LANGS.has(open[1].toLowerCase())) {
      i += 1;
      continue;
    }
    const startLine = i + 2; // 围栏正文第一行的绝对行号（1-based；`i` 是 0-based 的围栏行）
    const body = [];
    i += 1;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) {
      body.push(lines[i]);
      i += 1;
    }
    i += 1;
    out[`${rel}#L${startLine}`] = "\n".repeat(startLine - 1) + body.join("\n");
  }
  return out;
}

/** 扫描面（真实树）：代码面整份文本 + 文档面的 js 围栏。 */
function contractCallSurface() {
  const surface = {};
  for (const { rel, abs } of listScannable(CODE_EXTS, ...CONTRACT_CALL_CODE_ROOTS)) {
    surface[rel] = readFileSync(abs, "utf8");
  }
  const mdFiles = [
    ...readdirSync(ROOT).filter((n) => n.endsWith(".md")).map((n) => n),
    ...[...listScannable(new Set([".md"]), ...CONTRACT_CALL_MD_ROOTS)].map((f) => f.rel),
  ].filter((rel) => !CONTRACT_CALL_MD_SKIP_PREFIXES.some((p) => rel.startsWith(p)));
  for (const rel of [...new Set(mdFiles)].sort()) {
    const text = realReadText(rel);
    if (typeof text !== "string") continue;
    Object.assign(surface, jsFenceTexts(rel, text));
  }
  return surface;
}

describe("静态守卫：随包契约套件的 modelConfigProviderContract 调用点必须传满 3 个实参（issue #518a）", () => {
  it("前置：扫描面逐份点名已知调用点（含发布自检那一份），否则本规则恒绿", (t) => {
    const surface = contractCallSurface();
    const files = Object.keys(surface);
    const { sites } = contractCallSites(surface);
    t.diagnostic(`规则 6：扫描面 ${files.length} 份（代码面 ${CONTRACT_CALL_CODE_ROOTS.join("/ ")} + md js 围栏），`
      + `命中 ${sites.length} 处调用点`);
    for (const site of sites) t.diagnostic(`  ${site.file}:${site.line} ${site.kind} args=${site.argCount}`);

    // 面本身不许缩水：代码面三个根目录都得扫到东西
    for (const root of ["scripts", "test", "bin", "src"]) {
      assert.ok(files.some((f) => f.startsWith(`${root}/`)),
        `扫描面里一份 ${root}/ 下的文件都没有：规则 6 的代码面被拆了`);
    }
    assert.ok(files.some((f) => f.startsWith("docs/") && f.includes("#L")),
      "扫描面里一份 docs/ 的 js 围栏都没有：文档面被拆了（`docs/testing.md` 的示例就是靠这一格看住的）");

    // 逐份点名：每一处已知调用点都必须被扫到
    for (const [rel, why] of EXPECTED_CONTRACT_CALL_SITES) {
      const hit = sites.some((s) => s.file === rel || s.file.startsWith(`${rel}#L`));
      assert.ok(hit, `扫描面里找不到 ${rel} 的调用点（${why}）——漏扫一份 = 少一处调用点，`
        + "本规则会对那一份恒绿（#518a 的病根正是「漏了发布自检那一处」）");
    }
    t.diagnostic(`规则 6 覆盖面：${EXPECTED_CONTRACT_CALL_SITES.map(([rel]) => rel).join(" / ")} 全部扫到`);
  });

  it("真实树 = 回归基线：每一处调用都传满 3 个实参（release-check 也在面内）", (t) => {
    const errors = contractArityErrors(contractCallSurface());
    t.diagnostic(`规则 6：${errors.length ? errors.join(" / ") : "全仓调用点都是 3 实参"}`);
    assert.deepEqual(
      errors,
      [],
      `有 \`${CONTRACT_FN}(\` 调用点没传满 3 个实参（#518 起第三参必填）：\n${errors.join("\n")}\n`
      + "修法：给每个调用点补第三参 `unknownSlot`——槽位图形态（static / json-file）写 "
      + "`{ mode: \"throws\", name: \"<一个图里没有的名字>\", available: [\"default\", …] }`，"
      + "单配置形态（env）写 `{ mode: \"single-config\", name: \"<任意名字>\" }`。"
      + "**别把必填改回可选**：给默认值等于把「这个适配器对未知槽名的策略」藏起来。",
    );
  });

  it("反向证：把真实调用点改成两参 ⇒ 红并点名文件与行（变异没落上也算失败）", (t) => {
    const rel = "test/config/static.test.js";
    const real = realReadText(rel);
    assert.equal(typeof real, "string", `${rel} 读不到：反向证的靶子没了`);

    // 用同一个解析器把最后一个实参切掉——不手写「改成两参」的字面量，避免靶子改写后这一例静默失效
    const open = real.search(new RegExp(`\\b${CONTRACT_FN}\\s*\\(`));
    assert.notEqual(open, -1, `变异没落上：${rel} 里找不到调用点`);
    const openParen = real.indexOf("(", open);
    const closeParen = matchParen(real, openParen);
    assert.notEqual(closeParen, -1, `变异没落上：${rel} 的调用括号配不上`);
    const inner = real.slice(openParen + 1, closeParen);
    const args = splitTopLevelArgs(inner);
    assert.equal(args.length, 3, `变异前 ${rel} 的调用应当是 3 实参，实测 ${args.length}（靶子被改写了，先修靶子）`);
    const lastArg = args[2];
    const lastArgAt = inner.lastIndexOf(lastArg);
    assert.notEqual(lastArgAt, -1, "变异没落上：切不出最后一个实参");
    const dropped = real.slice(0, openParen + 1) + inner.slice(0, lastArgAt).replace(/,\s*$/, "") + real.slice(closeParen);
    const mutatedSites = contractCallSites({ [rel]: dropped }).sites;
    assert.equal(mutatedSites[0]?.argCount, 2, `变异没落上：改成两参后实测 ${mutatedSites[0]?.argCount} 个实参`);

    const errors = contractArityErrors({ [rel]: dropped });
    assert.equal(errors.length, 1, `把 ${rel} 改成两参应恰好 1 处红，实测：\n${errors.join("\n")}`);
    assert.match(errors.join("\n"), new RegExp(`^${rel.replace(/\./g, "\\.")}:\\d+ \`${CONTRACT_FN}\\(\` 的调用只传了 2 个实参`),
      `红的时候必须点名文件与行：${errors.join("\n")}`);
    t.diagnostic(`① 把 ${rel} 的调用改成两参 ⇒ ${errors.length} 处红：${errors.join("\n")}`);

    // ② 发布自检那一份（本轮真出事的调用点）：同样切成两参 ⇒ 红并点名 scripts/release-check.mjs
    const releaseRel = "scripts/release-check.mjs";
    const releaseText = realReadText(releaseRel);
    const rOpen = releaseText.search(new RegExp(`\\b${CONTRACT_FN}\\s*\\(`));
    assert.notEqual(rOpen, -1, `变异没落上：${releaseRel} 里找不到调用点（发布自检不再消费契约套件了？）`);
    const rOpenParen = releaseText.indexOf("(", rOpen);
    const rCloseParen = matchParen(releaseText, rOpenParen);
    const rInner = releaseText.slice(rOpenParen + 1, rCloseParen);
    const rArgs = splitTopLevelArgs(rInner);
    assert.equal(rArgs.length, 3, `变异前 ${releaseRel} 的调用应当是 3 实参，实测 ${rArgs.length}`);
    const rLast = rInner.lastIndexOf(rArgs[2]);
    const rDropped = releaseText.slice(0, rOpenParen + 1) + rInner.slice(0, rLast).replace(/,\s*$/, "") + releaseText.slice(rCloseParen);
    const rErrors = contractArityErrors({ [releaseRel]: rDropped });
    assert.equal(rErrors.length, 1, `把 ${releaseRel} 改成两参应恰好 1 处红，实测：\n${rErrors.join("\n")}`);
    assert.match(rErrors.join("\n"), /scripts\/release-check\.mjs:\d+ .*只传了 2 个实参/,
      `红的时候必须点名发布自检那一行：${rErrors.join("\n")}`);
    t.diagnostic(`② 把 ${releaseRel} 的调用改成两参 ⇒ ${rErrors.length} 处红：${rErrors.join("\n")}`);
  });

  it("放行证与范围证：3 实参绿、模板字符串里的调用也算、整行注释与散文不算", (t) => {
    const fn = `${CONTRACT_FN}(`; // 运行时拼，避免本文件自己被自己的规则咬到
    // ① 放行证：3 实参 ⇒ 绿（否则下面几条只是「永远有话说」）
    assert.deepEqual(contractArityErrors({ "fake/ok.js": `x = ${fn}"a", async () => ({}), { mode: "single-config", name: "s" });` }), [],
      "3 实参的调用被判红：判据口径有问题");
    // ② 两参 ⇒ 恰好 1 处红，点名文件与行
    const two = contractArityErrors({ "fake/two.js": `// 头注释\nx = ${fn}"a", async () => ({}));` });
    assert.equal(two.length, 1, `两参应恰好 1 处红，实测：${JSON.stringify(two)}`);
    assert.match(two[0], /^fake\/two\.js:2 /);
    // ③ 模板字符串里的调用**要**被扫到（发布自检就是这么写的，跳过反引号 = 漏掉本轮病根）
    assert.equal(contractArityErrors({ "fake/tpl.mjs": `const SRC = \`\n${fn}"a", setup\n\`;` }).length, 1,
      "模板字符串里的两参调用没被扫到：本规则会对发布自检那一份恒绿");
    // ④ 整行注释里的提及不算（文档式注释里提签名是正当的）
    assert.deepEqual(contractArityErrors({ "fake/c.js": `// ${fn}label, setup) 是旧写法` }), [],
      "整行注释里的提及被当成了调用点");
    // ⑤ 字符串里的逗号/括号不参与切分（否则 3 实参会因为引号里的逗号被算成 4 个）
    assert.deepEqual(contractArityErrors({ "fake/str.js": `x = ${fn}"a,b)", setup, { mode: "single-config", name: "s)" });` }), [],
      "字符串里的逗号/括号被算进了实参切分");
    // ⑥ 括号配不上 ⇒ 红（不许静默放行）
    assert.equal(contractArityErrors({ "fake/bad.js": `x = ${fn}"a", setup` }).length, 1,
      "括号配不上时没有报错（扫描口径坏了也不红）");
    // ⑦ 空实参不算：`f()` 是 0 个
    assert.equal(contractArityErrors({ "fake/empty.js": `x = ${fn});` }).length, 1, "空实参没被算成 0 个");
    t.diagnostic("①–⑦ 放行证 / 变异证 / 范围证 逐条按预期");
  });
});

// ---------------------------------------------------------------------------
// 规则 7（issue #546）：`scripts/*.mjs` 里 `runToolLoop({…})` 的**顶层选项名**必须来自白名单
// ---------------------------------------------------------------------------
//
// 病根：#530 之前的那一轮迁移只迁了三个脚本（`message-journal-golden` / `final-guard-probe` /
// `release-check`），另外几个**观察脚本**（`probe-462-resume-refold` / `probe-326-compaction-facts` /
// `notes-experiment` / `notes-why-experiment`）仍写着已退役的扁平拼写（`runId` / `resume` /
// `reflection` / `completion` / `maxRounds` …）⇒ **启动期就抛**，于是「跑 scripts/probe-xxx 可复现」
// 这类写在 CHANGELOG / issue 回帖里的主张**不可复现**。它们不被任何门禁引用，所以全仓绿着。
//
// 判据：调用点的**顶层选项名**必须落在 `RUN_TOOL_LOOP_OPTION_NAMES` 里。名单**从符号派生**
// （`src/loop/option-normalization.js`），**不硬编码退役名清单**——硬编码的第二张表正是这类
// 守卫腐烂的方式（#498 S3 每个切片退役一个键，抄一张清单就得跟着抄十一次）。
//
// 扫描面（如实写清，别把「扫到」当「扫全」）：
//   · `scripts/*.mjs` 一份不落（脚本是观察面，不进任何门禁，最容易烂在这里）；
//   · 锚点 = **代码里的** `runToolLoop(`（注释/字符串/模板串内容先被抹成空格再找，所以
//     `release-check.mjs` 里那份「故意坏的宿主样本」模板串不会被当成调用点）；
//   · 实参是对象字面量 ⇒ 取它的**顶层**键（嵌套 `config.run.maxRounds` 不参与：那是 config
//     schema 的活，`collectConfigNamespaceProblems` 已经在运行时管）；
//   · 实参是**本文件声明的** helper 调用（`runToolLoop(loopOptions(…))`）⇒ 顺着声明找到它
//     `return` 的对象字面量，取顶层键（`probe-462` 就是这么写的）；
//   · `...spread` / `[computed]` ⇒ **无法静态求值**，记为 `...` / `<computed>` 并要求**显式登记**
//     （照 `docs-drift-check.mjs` 的 `BARE_LINE_EXEMPTIONS`：条目 + 理由，**闲置条目本身判红**）。
//     这是本规则已知的逃生口，登记表就是它的账：新开一处就要多一条带理由的条目。

const RUN_LOOP_FN = "runToolLoop";
const RUN_LOOP_SCAN_ROOT = "scripts";

/**
 * 豁免登记表（`{ file, name, why }`，无通配）。
 *
 * 只有「静态上**不可能**求值」的两种形态能登记：`...`（展开一个变量/表达式）与
 * `<computed>`（计算键）。**静态名字一个都不许登记**——那等于把规则本身撤掉。
 * 条目闲置（真实树里一处都没命中）⇒ 红：放行表不许长成永久免死金牌（#210 R2 惯例）。
 */
const RUN_LOOP_OPTION_EXEMPTIONS = Object.freeze([
  {
    file: "scripts/message-journal-golden.mjs",
    name: "...",
    why: "金样生产者把公共选项放在文件级 `BASE` 里再展开（`...BASE` / `...BASE, store`）；"
      + "`BASE` 自己的顶层键（`tools` / `config` / `executeTool`）就在同文件第 74 行，肉眼与运行时闸口都看得见。"
      + "展开是「同一条选项的复用」，不是藏名字的地方；真要藏，加一处展开就得加一条登记。",
  },
  {
    file: "scripts/soak.mjs",
    name: "...",
    why: "soak 的阶段参数由 `common` 装配后展开（`...common`），且有两处条件展开（`...(x ? {k} : {})`）。"
      + "`common` 是同文件里手写的对象（`provider` / `config` 之类），不是从别处 import 的黑盒。",
  },
  {
    file: "scripts/soak.mjs",
    name: "<computed>",
    why: "`probeRunToolLoopOption(name)` 是**故意**拿任意名字去撞名称闸口的只读探针（`runToolLoop({ [name]: false })`）："
      + "它测的正是「未知键会不会被拒」，静态名字在这里没有意义。",
  },
  {
    file: "scripts/probe-462-resume-refold.mjs",
    name: "...",
    why: "`loopOptions(...)` 把 `capabilities` 之类按需透传（`...rest`），其余旋钮走 `run` / `folding` 两个具名组。"
      + "helper 返回的字面量本身在扫描面内（`provider` / `executeTool` / `store` / `config` 都被核过）。",
  },
]);

/**
 * 把注释、字符串、模板串的**内容**抹成空格（换行保留）⇒ 与原文逐字符同长。
 *
 * 为什么必须先抹：`scripts/release-check.mjs` 里有一份**故意坏的宿主样本**（模板串），
 * 里面就写着 `thisOptionKeyDoesNotExistInRunToolLoopOptions`——不抹就会把它当成真调用点。
 * 抹完再用同一个下标回原文取文本，行号因此仍然是真的。
 *
 * @param {string} text
 * @returns {string}
 */
function maskNonCode(text) {
  const out = [...text];
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " "; };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      blank(i, Math.min(j + 1, text.length));
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

const lineAt = (text, index) => text.slice(0, index).split("\n").length;

/** 展开表达式的收尾下标（顶层逗号 / 收尾括号）。 */
function spreadExpressionEnd(masked, start) {
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    const ch = masked[i];
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (ch === "," && depth === 0) return i;
  }
  return masked.length;
}

/** 展开表达式里所有对象字面量的顶层键（条件展开 `...(c ? {} : { k })` ⇒ `k`）。 */
function spreadLiteralKeys(text, masked, start) {
  const end = spreadExpressionEnd(masked, start);
  const keys = [];
  for (let i = start; i < end; i += 1) {
    if (masked[i] !== "{" || !looksLikeLiteralBrace(masked, i)) continue;
    keys.push(...literalTopLevelKeys(text, masked, i));
    i = matchParen(masked, i);
  }
  return keys;
}

/**
 * 从 `{` 起点的对象字面量取**顶层**键。`...x` → `...`，`[expr]` → `<computed>`。
 *
 * 嵌套的括号/数组/对象整组跳过（深度不变）——`config: { run: { maxRounds } }` 里的
 * `maxRounds` 不是本规则的靶子（它由 config schema 在运行时管）。
 *
 * @param {string} text 原文（取行号用）
 * @param {string} masked `maskNonCode(text)`
 * @param {number} brace `{` 的下标
 * @returns {{name: string, line: number}[]}
 */
function literalTopLevelKeys(text, masked, brace) {
  const keys = [];
  let expectKey = true;
  let i = brace + 1;
  while (i < masked.length) {
    const ch = masked[i];
    if (ch === "}" || ch === ")" || ch === "]") return keys;
    if (ch === ",") { expectKey = true; i += 1; continue; }
    if (/\s/u.test(ch)) { i += 1; continue; }
    if (!expectKey) {
      if ("([{".includes(ch)) { i = matchParen(masked, i) + 1; continue; }
      i += 1;
      continue;
    }
    if (masked.startsWith("...", i)) {
      // 展开：先看表达式里有没有对象字面量（`...(cond ? {} : { deliverables })` 这种**条件展开**
      // 是能静态求值的，核它们的键）；一个都没有（`...BASE` / `...rest`）才记成无法求值的 `...`。
      const inner = spreadLiteralKeys(text, masked, i + 3);
      if (inner.length > 0) keys.push(...inner);
      else keys.push({ name: "...", line: lineAt(text, i) });
      expectKey = false;
      i = spreadExpressionEnd(masked, i + 3);
      continue;
    }
    if (ch === "[") { keys.push({ name: "<computed>", line: lineAt(text, i) }); expectKey = false; i = matchParen(masked, i) + 1; continue; }
    const word = /^[A-Za-z_$][\w$]*|^"[^"]*"|^'[^']*'/u.exec(masked.slice(i));
    if (word !== null) {
      keys.push({ name: word[0].replace(/^["']|["']$/gu, ""), line: lineAt(text, i) });
      expectKey = false;
      i += word[0].length;
      continue;
    }
    i += 1;
  }
  return keys;
}

/** `{` 是不是对象字面量起点（排除 block 与解构：`=> {` / `const {` 都不算）。 */
function looksLikeLiteralBrace(masked, brace) {
  let k = brace - 1;
  while (k >= 0 && /\s/u.test(masked[k])) k -= 1;
  if (k < 0) return false;
  if ("(=,[:?".includes(masked[k])) return true;
  const word = /([A-Za-z_$][\w$]*)\s*$/u.exec(masked.slice(Math.max(0, k - 12), k + 1));
  return word !== null && (word[1] === "return" || word[1] === "yield");
}

/** 本文件里 `name` 的声明区间 `[start, end)`（`const/let/var name =` 或 `function name(`）。 */
function localDeclarationSpan(masked, name) {
  const re = new RegExp(`(?:\\b(?:const|let|var)\\s+${name}\\s*=|\\bfunction\\s+${name}\\s*\\()`, "u");
  const m = re.exec(masked);
  if (m === null) return null;
  let depth = 0;
  for (let i = m.index; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === ";" && depth === 0) return [m.index, i];
  }
  return [m.index, masked.length];
}

/**
 * 纯函数：`文件相对路径 → 文本` ⇒ 每一处 `runToolLoop({…})` 的顶层选项名。
 *
 * @param {Record<string, string|null>} textByFile
 * @returns {{hits: {file: string, name: string, line: number, site: number, via?: string}[], unparsable: string[]}}
 */
function runLoopOptionHits(textByFile) {
  const hits = [];
  const unparsable = [];
  const re = new RegExp(`\\b${RUN_LOOP_FN}\\s*\\(`, "gu");
  for (const [file, text] of Object.entries(textByFile)) {
    if (typeof text !== "string") continue;
    const masked = maskNonCode(text);
    for (const m of masked.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      const close = matchParen(masked, open);
      if (close === -1) { unparsable.push(`${file}:${lineAt(text, m.index)} 调用括号配不上`); continue; }
      const argText = masked.slice(open + 1, close);
      const firstNonSpace = argText.search(/\S/u);
      if (firstNonSpace === -1) { unparsable.push(`${file}:${lineAt(text, m.index)} 实参为空`); continue; }
      const argStart = open + 1 + firstNonSpace;
      const site = lineAt(text, m.index);
      if (masked[argStart] === "{") {
        for (const key of literalTopLevelKeys(text, masked, argStart)) hits.push({ file, site, ...key });
        continue;
      }
      // 实参不是字面量：把**本文件声明的** helper 名解析成它 `return` 的字面量（`runToolLoop(loopOptions(…))`）。
      const names = [...new Set([...argText.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)].map((x) => x[1]))];
      let resolved = 0;
      for (const name of names) {
        const span = localDeclarationSpan(masked, name);
        if (span === null) continue;
        for (let i = span[0]; i < span[1]; i += 1) {
          if (masked[i] !== "{" || !looksLikeLiteralBrace(masked, i)) continue;
          for (const key of literalTopLevelKeys(text, masked, i)) hits.push({ file, site, via: name, ...key });
          resolved += 1;
          i = matchParen(masked, i);
        }
      }
      if (resolved === 0) {
        unparsable.push(`${file}:${site} 实参既不是字面量、也不是本文件声明的 helper（静态看不见选项名）`);
      }
    }
  }
  return { hits, unparsable };
}

/**
 * 纯函数：违规 = 顶层名字不在白名单、且没有登记豁免。
 *
 * @param {Record<string, string|null>} textByFile
 * @param {{allowlist: readonly string[], exemptions?: readonly {file: string, name: string, why: string}[]}} rules
 * @returns {{violations: string[], unparsable: string[], idleExemptions: string[], hits: object[]}}
 */
function runLoopOptionViolations(textByFile, { allowlist, exemptions = [] }) {
  const { hits, unparsable } = runLoopOptionHits(textByFile);
  const allowed = new Set(allowlist);
  const violations = [];
  const used = new Set();
  for (const hit of hits) {
    if (allowed.has(hit.name)) continue;
    const entry = exemptions.find((e) => e.file === hit.file && e.name === hit.name);
    if (entry !== undefined) { used.add(`${entry.file}\u0000${entry.name}`); continue; }
    const where = hit.via === undefined ? `${hit.file}:${hit.line}` : `${hit.file}:${hit.line}（经 ${hit.via} 的返回值）`;
    violations.push(`${where} 顶层选项 ${JSON.stringify(hit.name)} 不在 RUN_TOOL_LOOP_OPTION_NAMES 里`
      + `（调用点在第 ${hit.site} 行）`);
  }
  // 闲置豁免 = 后门（#210 R2 惯例：用不上的放行就是永久免死金牌）
  const idleExemptions = exemptions
    .filter((e) => !used.has(`${e.file}\u0000${e.name}`))
    .map((e) => `${e.file} 的 ${JSON.stringify(e.name)} 豁免一处都没命中（闲置条目 = 后门，删掉它或修好理由）`);
  return { violations, unparsable, idleExemptions, hits };
}

/** 扫描面：`scripts/` 顶层的 `.mjs`（脚本是观察面，不进任何门禁）。 */
function runLoopOptionSurface() {
  const dir = resolve(ROOT, RUN_LOOP_SCAN_ROOT);
  const surface = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || extOf(entry.name) !== ".mjs") continue;
    surface[`${RUN_LOOP_SCAN_ROOT}/${entry.name}`] = readFileSync(join(dir, entry.name), "utf8");
  }
  return surface;
}

describe("静态守卫：scripts 里 runToolLoop 的顶层选项名必须来自白名单（issue #546）", () => {
  it("前置：扫描面逐份点名已知调用点，否则本规则会静默缩面", (t) => {
    const surface = runLoopOptionSurface();
    const { hits, unparsable } = runLoopOptionHits(surface);
    const filesWithHits = [...new Set(hits.map((h) => h.file))].sort();
    t.diagnostic(`规则 7：扫描面 ${Object.keys(surface).length} 份脚本，命中 ${hits.length} 个顶层选项名，`
      + `覆盖 ${filesWithHits.length} 份文件：${filesWithHits.join(" / ")}`);
    assert.deepEqual(unparsable, [], `有调用点静态解析不了（守卫会对其恒绿）：\n${unparsable.join("\n")}`);
    // 逐份点名：这 6 份是今天真有**代码里**的 `runToolLoop(` 调用点的脚本（少一份 = 面被拆了）。
    // `scripts/release-check.mjs` 刻意不在名单里：它的两处 `runToolLoop(` 都住在**模板串**里
    // （`TS_HOST_GOOD_SOURCE` / `TS_HOST_BAD_SOURCE` = 给 tsc 编译的宿主样本，其中一份**故意坏**），
    // 抹掉模板串之后它一处调用点都没有。那份好样本由 `check:release` 用 `tsc --strict` 对着
    // **随包 .d.ts** 编译——比本规则更强（退役名会 TS2353），所以不是漏扫。
    for (const rel of [
      "scripts/final-guard-probe.mjs",
      "scripts/message-journal-golden.mjs",
      "scripts/notes-why-experiment.mjs",
      "scripts/probe-326-compaction-facts.mjs",
      "scripts/probe-462-resume-refold.mjs",
      "scripts/soak.mjs",
    ]) {
      assert.ok(filesWithHits.includes(rel), `扫描面里找不到 ${rel} 的调用点：本规则会对那一份恒绿`);
    }
    // 豁免表条目必须点名到**具体文件 + 名字**，并且带理由
    for (const entry of RUN_LOOP_OPTION_EXEMPTIONS) {
      assert.ok(typeof entry.why === "string" && entry.why.length >= 20,
        `豁免条目 ${entry.file} / ${JSON.stringify(entry.name)} 没写理由（豁免必须显式登记理由）`);
      assert.ok(surface[entry.file] !== undefined, `豁免条目点名的 ${entry.file} 不在扫描面里`);
      assert.ok(["...", "<computed>"].includes(entry.name),
        `豁免条目 ${entry.file} / ${JSON.stringify(entry.name)}：静态名字一个都不许登记（那等于撤掉规则）`);
    }
  });

  it("真实树 = 回归基线：每一处顶层选项名都在白名单里（scripts/*.mjs 全绿）", (t) => {
    const surface = runLoopOptionSurface();
    const { violations, unparsable, idleExemptions } = runLoopOptionViolations(surface, {
      allowlist: RUN_TOOL_LOOP_OPTION_NAMES,
      exemptions: RUN_LOOP_OPTION_EXEMPTIONS,
    });
    t.diagnostic(`规则 7：${violations.length ? violations.join(" / ") : "0 处违规"}`
      + `；豁免 ${RUN_LOOP_OPTION_EXEMPTIONS.length} 条（全部命中）`);
    assert.deepEqual(unparsable, [], `有调用点静态解析不了：\n${unparsable.join("\n")}`);
    assert.deepEqual(idleExemptions, [], `豁免表里有闲置条目：\n${idleExemptions.join("\n")}`);
    assert.deepEqual(violations, [],
      `scripts/*.mjs 里还有 runToolLoop 的**已退役扁平拼写**（启动期就抛 ⇒ 脚本不可复现）：\n${violations.join("\n")}\n`
      + "修法：按 `configPathForOption(name)` 给出的家搬进 `config.<组>.<叶>`（函数值走 "
      + "`capabilities.hooks.*` / `capabilities.ports.*`）。名单真值 = `RUN_TOOL_LOOP_OPTION_NAMES`，别另抄一张。");
  });

  it("派生证：白名单是唯一真值（退役名从 schema 派生，不硬编码）", (t) => {
    // 白名单非空、且容器/第三站成员真在里面（否则下面的「退役样本」会误判）
    assert.ok(RUN_TOOL_LOOP_OPTION_NAMES.length > 20, `白名单只有 ${RUN_TOOL_LOOP_OPTION_NAMES.length} 项，抽取坏了`);
    for (const name of ["config", "capabilities", "provider", "store", "executeTool"]) {
      assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(name), true, `白名单里没有 ${JSON.stringify(name)}：抽取坏了`);
    }
    // 退役样本**从 schema 派生**：一个 config 叶子、名字已不在白名单里（S3 之后这种键一定存在）
    const retired = CONFIG_SURFACE_OPTION_NAMES.find((name) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(name));
    assert.equal(typeof retired, "string", "派生不出「已退役的扁平配置键」：本规则失去活样本");
    t.diagnostic(`规则 7：派生出的退役样本 = ${JSON.stringify(retired)}（它的家是 config.${configPathForOption(retired)}）`);
    // 反向证：把那个退役名写进一个假脚本的调用点 ⇒ 必须红，且报错点名文件与名字
    const synthetic = `x = ${RUN_LOOP_FN}({ provider, ${retired}: 1 });`;
    const { violations } = runLoopOptionViolations({ "scripts/fake.mjs": synthetic }, {
      allowlist: RUN_TOOL_LOOP_OPTION_NAMES,
    });
    assert.equal(violations.length, 1, `派生出的退役名 ${JSON.stringify(retired)} 没被拦：${JSON.stringify(violations)}`);
    assert.match(violations[0], new RegExp(`scripts/fake\\.mjs:1 顶层选项 "${retired}"`),
      `红的时候必须点名文件与名字：${violations[0]}`);
  });

  it("自测（放行证 / 变异证 / 范围证 / 登记式样）：变异没落上也判失败", (t) => {
    const fn = `${RUN_LOOP_FN}(`; // 运行时拼，避免本文件自己被自己的规则咬到
    const rules = { allowlist: RUN_TOOL_LOOP_OPTION_NAMES };
    // ① 放行证：合法名字 ⇒ 绿（否则下面几条只是「永远有话说」）
    assert.deepEqual(runLoopOptionViolations({ "scripts/ok.mjs": `x = ${fn}{ provider, config: { run: { maxRounds: 3 } }, store });` }, rules).violations, [],
      "合法调用被判红：判据口径有问题");
    // ② 嵌套键不是靶子：`config.run.maxRounds` 里的 `maxRounds` 不算顶层（由 config schema 管）
    assert.deepEqual(runLoopOptionViolations({ "scripts/nested.mjs": `x = ${fn}{ config: { run: { maxRounds: 3, resume: true } } });` }, rules).violations, [],
      "嵌套 config 键被当成了顶层选项名");
    // ③ 变异证：塞一个退役名 ⇒ 恰好 1 处红、点名文件与行；变异没落上要失败
    const clean = "x = " + fn + "{ provider });";
    const retired = CONFIG_SURFACE_OPTION_NAMES.find((name) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(name));
    assert.ok(clean.includes("{ provider }"), "变异没落上：靶子里找不到 `{ provider }`");
    const mutated = clean.replace("{ provider }", `{ provider, ${retired}: 1 }`);
    assert.ok(mutated.includes(`${retired}: 1`), "变异没落上：退役名没写进靶子");
    const red = runLoopOptionViolations({ "scripts/mut.mjs": mutated }, rules);
    assert.equal(red.violations.length, 1, `塞一个退役名应恰好 1 处红，实测：${JSON.stringify(red.violations)}`);
    assert.match(red.violations[0], /^scripts\/mut\.mjs:1 /, `红必须点名文件与行：${red.violations[0]}`);
    assert.deepEqual(runLoopOptionViolations({ "scripts/mut.mjs": clean }, rules).violations, [], "改回来之后必须绿");
    // ④ 注释 / 字符串 / 模板串里的提及不算（发布自检那份坏样本就住在模板串里）
    assert.deepEqual(runLoopOptionViolations({
      "scripts/c.mjs": `// ${fn}{ ${retired}: 1 }) 是旧写法\nconst S = \`${fn}{ ${retired}: 1 })\`;`,
    }, rules).violations, [], "注释/字符串里的提及被当成了调用点");
    // ⑤ helper 返回值在面内：`runToolLoop(helper(…))` 的选项名从声明里抽
    const helper = `const opts = (a) => ({\n  provider: a,\n  ${retired}: 1,\n});\nx = ${fn}opts(p));`;
    const helperRed = runLoopOptionViolations({ "scripts/h.mjs": helper }, rules);
    assert.equal(helperRed.violations.length, 1, `helper 返回字面量里的退役名没被扫到：${JSON.stringify(helperRed.violations)}`);
    assert.match(helperRed.violations[0], /经 opts 的返回值/, `红时要说是哪个 helper 的返回值：${helperRed.violations[0]}`);
    // ⑥ 登记式样：`...` / `<computed>` 可登记 ⇒ 绿；**闲置条目** ⇒ 红（后门）；静态名字不许登记
    const dynamicSrc = `x = ${fn}{ provider, ...rest });\ny = ${fn}{ [name]: false });`;
    assert.equal(runLoopOptionViolations({ "scripts/d.mjs": dynamicSrc }, rules).violations.length, 2,
      "`...` / `<computed>` 没有当成「无法静态求值」处理（要么漏扫，要么误报）");
    const used = runLoopOptionViolations({ "scripts/d.mjs": dynamicSrc }, {
      allowlist: RUN_TOOL_LOOP_OPTION_NAMES,
      exemptions: [
        { file: "scripts/d.mjs", name: "...", why: "登记式样自测：展开一个变量，静态看不见名字" },
        { file: "scripts/d.mjs", name: "<computed>", why: "登记式样自测：计算键，静态看不见名字" },
      ],
    });
    assert.deepEqual(used.violations, [], `登记过的动态形态仍被判红：${JSON.stringify(used.violations)}`);
    assert.deepEqual(used.idleExemptions, [], "登记过的动态形态被当成闲置条目");
    const idle = runLoopOptionViolations({ "scripts/d.mjs": `x = ${fn}{ provider });` }, {
      allowlist: RUN_TOOL_LOOP_OPTION_NAMES,
      exemptions: [{ file: "scripts/d.mjs", name: "...", why: "登记式样自测：这一条一处都没命中，必须判红" }],
    });
    assert.equal(idle.idleExemptions.length, 1, "闲置豁免没有判红：放行表会变成永久免死金牌");
    // ⑦ 括号配不上 ⇒ 红（不许静默放行）
    assert.equal(runLoopOptionViolations({ "scripts/bad.mjs": `x = ${fn}{ provider` }, rules).unparsable.length, 1,
      "括号配不上时没有报错（扫描口径坏了也不红）");
    // ⑧ 实参不是字面量、也不是本文件 helper ⇒ 记为「静态看不见」而不是静默绿
    assert.equal(runLoopOptionViolations({ "scripts/e.mjs": `x = ${fn}buildOptions());` }, rules).unparsable.length, 1,
      "实参解析不了时静默放行了");
    t.diagnostic("①–⑧ 放行证 / 变异证 / 范围证 / 登记式样 逐条按预期");
  });
});

// ── 规则 8（issue #541）：CHANGELOG 顶部版本节的卫生 ──
// ---------------------------------------------------------------------------
//
// 病根（本仓本月真事，不是规范洁癖）：
//   · `CHANGELOG.md` 归主 agent 维护，但一片 worker **越界自己写了同主题条目**（A19 的 `resume`
//     那条）⇒ 主 agent 得手工去重，还把另一条里的**逐字拒绝文案**嫁接进自己那条；
//   · 用来查重的临时正则**不可信**：按字节去重看不见**语义重复**（同主题两条各写各的）；而中英片号是
//     **两套键空间**（EN `S3, <ord> slice` / CN `S3 第N片`，还有 ` b 段` 这种后缀），那套正则一度报
//     「CN `三` 重复」——到底是真重复还是正则产物，没人核过；
//   · 真实标签错位也发生过：A2b 那条 CN 写成「第三片」，实际应是「第三片 b 段」（手工修的）。
//
// 判据五条（解析单位 = **整条 bullet**：从 `- ` 行到下一条 `- ` / `### ` / 空行之前；本仓条目普遍
// 4~10 行，只扫首行等于看不见一半内容——EN 那条 `S3, third slice` 就是**折行**的）：
//   R1 字节唯一：同节内 bullet 不得逐字重复；
//   R2 片号唯一：EN `S3, <ord> slice` 与 CN `S3 第<ord>片`（**含 ` b 段` 后缀**）**各自内部**不得重复；
//      **两套键空间不许互相折算**——EN 的 `c` 不等于 CN 的 `三`，折算会造出假重复；
//   R3 中英配对数相等：带 EN 片号标签的条数 == 带 CN 片号标签的条数（专抓「某一侧整句被删掉」）；
//   R4 语义近重复：两条 bullet 若 **issue 引用集合相同**且**反引号符号集合相同** ⇒ 判重
//      （这正是 A19 那对「各写各的」的形状：字节不同、语义同）；
//   R5 结构：版本节内 `### Breaking` → `### Changed` → `### Fixed` 的相对顺序成立，且节内没有既不是
//      bullet 也不是缩进/惰性续行的游离正文行。
//
// 扫描面与口径（如实写清，别把「扫到」当「扫全」）：
//   · 范围 = **最顶部的那一个版本节** `## [Unreleased]`。issue #558：发布开版那一刻顶部
//     `## [Unreleased]` **必然为空**（内容整体下移成了刚开的版本节，见 0.27.0 的开版提交 4963293），
//     所以「顶部节是 Unreleased 且一条 bullet 都没有」时，卫生目标**退到紧随其后的那一个版本节**
//     ——那正是开版提交真正的内容；Unreleased 一有内容，扫描面自动回到它（`surface.fellBack`）。
//     退让只改「扫哪一节」，五条判据一条没放宽（反向证 ⑦ 逐字复制刚开的版本节 ⇒ R1 照样红）；
//   · 顶部节被改名（发布时把 `## [Unreleased]` 直接写成 `## [0.28.0] - …` 而没补新的 Unreleased）
//     ⇒ 红并点名「找不到版本节」，那是**该补一个新 Unreleased** 的信号，不是静默放过；
//   · 顶部 `## [Unreleased]` 为空、其后又没有任何版本节 ⇒ 红并点名「找不到可扫的版本节」
//     （不许在空节上静默变绿：前置格要断言的是「真扫出了结构」，不是「允许为空」）；
//   · **R1 / R4 是全节口径**（跨小节）：逐字复制和「同 issue + 同符号集」的重复跨小节也是错的；
//   · **R2 是逐小节口径**：同一个片号合法地会出现在两个小节里（今天 `S3, sixteenth slice` 在 Breaking
//     是 `runId` 退役、在 Fixed 是拒绝文案，两条是**同一个片的两个事实**）。整节一个键空间会把这种
//     正常形态判红，正是本规则要避免的那类**假红**。代价明写：**跨小节**的同片号重复 R2 不抓，
//     由 R4 兜（同 issue 集合同符号集合），两者都不中的留给人工评审；
//   · **R4 只在同一语言内比**：中英是同一件事的两份译本（issue 集合天然相同、符号集合高度重合），
//     跨语言比会把**每一对译本**都判成重复；
//   · 空集合不参与 R4（两条都没引用的 bullet 天然「同集合」，那是没有信息，不是重复）。

const CHANGELOG_REL = "CHANGELOG.md";
const CHANGELOG_VERSION_HEADING = "## [Unreleased]";
/** 版本节里必须出现、且必须按这个相对顺序出现的小节（其余小节名不硬编码：KaC 允许 `Added` 之类插在中间）。 */
const CHANGELOG_REQUIRED_SUBSECTIONS = Object.freeze(["Breaking", "Changed", "Fixed"]);
/**
 * 片号标签的**两套**键空间。`space` 是键空间名，两套之间**永不互相折算**。
 * 后缀（EN ` b` / CN ` b 段`）是键的一部分：`第三片` 与 `第三片 b 段` 是两个不同的片。
 */
const CHANGELOG_SLICE_LABEL_SPACES = Object.freeze([
  { space: "en", source: String.raw`\bS3,?\s+([A-Za-z]+)\s+slice(?:\s+([A-Za-z])\b)?` },
  { space: "cn", source: String.raw`S3\s*第\s*([一二三四五六七八九十百零两〇]+)\s*片(?:\s*([A-Za-z])\s*段)?` },
]);
/** issue 引用 / 反引号符号：用正则字面量（源码里带反引号，写成模板串会被当成字符串边界）。 */
const CHANGELOG_ISSUE_REF_RE = /(?<![A-Za-z0-9_#])#(\d{2,5})\b/g;
const CHANGELOG_SYMBOL_RE = /`([^`\n]+)`/g;
/** 每次现造一份（`matchAll` 要 `g`，而共享的 `lastIndex` 是这类守卫最经典的坑）。 */
const freshRe = (re) => new RegExp(re.source, re.flags);
const CHANGELOG_CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/**
 * 语言判定阈值：**整条 bullet** 的 CJK 占比 `CJK / (CJK + 连续拉丁词长度)` `> 0.12` ⇒ 中文。
 *
 * issue #563：R4 与配对地板**共用这一个判定**。原先 R4 用的是 `CHANGELOG_CJK.test(bullet.text)`
 * （「整条里出现任意一个汉字就算中文」），一旦中英成对（英文条目里逐字引用中文判词，如 `[已修剪]` /
 * `## 主题词面包屑`），英文译本就会被判成中文，R4 于是拿**一对译本**去比「同 issue + 同符号集」——
 * 而译本天然同集合 ⇒ 每一对都判红。按占比判才是「同一语言内比」的原意；实测本节余量很大：
 * 全部英文条目占比 0.000，中文条目最低 0.27。
 */
const CHANGELOG_CJK_RATIO_MAX = 0.12;

/**
 * 语言判定：**整条 bullet** 的 CJK 占比。分母只放 CJK 字数与连续拉丁词（`[A-Za-z]+` 的最长连续段）
 * 长度——数字、标点、反引号不携带语种信息。
 * **不许**按标题前若干字判：英文条目里引用中文判词、中文条目首行整段反引号标识符，两个方向都会误判。
 */
function changelogBulletLanguage(text) {
  const cjk = [...text.matchAll(new RegExp(CHANGELOG_CJK.source, "g"))].length;
  const latin = [...text.matchAll(/[A-Za-z]+/g)].reduce((sum, m) => sum + m[0].length, 0);
  const total = cjk + latin;
  const ratio = total === 0 ? 0 : cjk / total;
  return { lang: ratio > CHANGELOG_CJK_RATIO_MAX ? "cn" : "en", ratio, cjk, latin };
}

/** 片号标签 → `[{ space, key, raw }]`（同一 bullet 内同键出现两次只算一个键）。 */
function changelogSliceLabels(text) {
  const flat = text.replace(/\s+/g, " ");
  const out = [];
  for (const spec of CHANGELOG_SLICE_LABEL_SPACES) {
    for (const m of flat.matchAll(new RegExp(spec.source, "g"))) {
      const ord = m[1];
      const suffix = m[2] ?? "";
      const key = spec.space === "en"
        ? `${ord.toLowerCase()} slice${suffix ? ` ${suffix.toLowerCase()}` : ""}`
        : `第${ord}片${suffix ? ` ${suffix} 段` : ""}`;
      out.push({ space: spec.space, key, raw: m[0].trim() });
    }
  }
  return out;
}

/** issue 引用集合（`#541` 这类；`#` 前面是字母数字时不算，避免吃掉 `foo#12`）。 */
function changelogIssueRefs(text) {
  return new Set([...text.matchAll(freshRe(CHANGELOG_ISSUE_REF_RE))].map((m) => m[1]));
}

/** 反引号符号集合（去掉首尾空白、内部空白折叠成一个空格）。 */
function changelogSymbols(text) {
  return new Set([...text.matchAll(freshRe(CHANGELOG_SYMBOL_RE))]
    .map((m) => m[1].trim().replace(/\s+/g, " "))
    .filter((s) => s !== ""));
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/** 一节里的 bullet 条数（`- ` 行数；与下面 bullet 解析的单位一致，这里只数不解析）。 */
function countSectionBullets(lines, from, to) {
  let count = 0;
  for (let i = from; i < to; i += 1) if (lines[i].startsWith("- ")) count += 1;
  return count;
}

/**
 * **扫描面选取**（issue #558，本单只改这一处）：取**最顶部**的 `## [x]` 节；若它是
 * `## [Unreleased]` **且 bullet 数为 0**（= 发布开版那一刻的形态），退到**紧随其后的那一个
 * 版本节**作为卫生目标。Unreleased 一旦有内容，扫描面自动回到它。
 *
 * 这里只决定「扫哪一节」，五条判据（R1–R5）的语义一个字都不在这里。
 *
 * ⚠ 本函数里的正则都**没有 `g`**（只走 `.test`，不走 `matchAll`），所以不存在共享 `lastIndex` 那个坑；
 * 真需要 `matchAll` 的地方一律现造一份（文件里的 `freshRe`，见 `changelogIssueRefs`）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * **扫描面的保护范围**（issue #575 B）
 *
 * 下面这段是写给「想改这个函数的人」的：**面只有一节**，面外的东西**没有任何人看着**。
 * 写清范围不是为了免责，是为了让扩面变成一个**知情决定**，而不是「顺手把 `to` 改成 `lines.length`」。
 *
 * **面内**（规则 8 的 R1–R5 与规则 9 的中英配对地板都只跑这一节）：
 *   · 顶部 `## [Unreleased]`（它有 bullet 时，`fellBack: false`）；
 *   · 开版态（顶部 `## [Unreleased]` 为空）⇒ 紧随其后的**那一个**版本节（`fellBack: true`）。
 *   这一节里**每一条** bullet 都在面上：逐字重复（R1）、片号重复（R2，逐小节口径）、语义近重复（R4）、
 *   小节顺序与游离正文（R5），以及「每一条中文条目有没有英文对应」（规则 9 的配对判据 + 配对地板）。
 *
 * **面外**（明确**放弃**的保护，不是「顺带没管」）：
 *   · **已发布的版本节一条都不扫**（今天的 `## [0.28.0]` 及其后的每一节）。后果要说明白：#575 实测
 *     ——把 `## [0.28.0]` 里**第 1 条**或**第 2 条**（乃至第 3 条）bullet 逐字复制一份，
 *     `node --test test/static-guards.test.js` 仍然 52 格全绿（对照组：把同样的事做在 `## [Unreleased]`
 *     上，规则 8 与规则 9 同时变红）。也就是说已发布节里的逐字重复、片号重复、以及**中英配对缺失**
 *     （删掉一条英文译本）都没有判据覆盖。这是设计后果、不是缺陷，本单只把范围写清，**不扩面**。
 *   · **退让期间的空 `## [Unreleased]`** 同样不在面上：它 0 条 bullet，没有内容可判；此时判据全部
 *     落在刚开的那一节上。
 *   · 面外的内容只有**人工评审**与 `check:docs` / `check:docs:strict` 里那些**与重复无关**的判据兜
 *     （后者看的是引用与棘轮，不看 bullet 重复，也不看译本配对）。
 *
 * **为什么按「扫最新一节」定标（发布即冻结）**：
 *   · 判据要回答的是「**还没发出去**的这批条目干净吗」——那是唯一还能改的字节面。发布一发生，那一节
 *     的字节就属于历史：改它等于改写历史（同 #278 的口径），把它判红只会逼人重写发布记录。
 *   · 于是「面」跟着开版走（#563）：Unreleased 一有内容就是它；开版那一刻（顶部 Unreleased 必然为
 *     空）退到刚开的版本节。判据因此**永远**看着「下一次发布将要带出去的东西」。
 *   · 全文件扫**不是**一个可选项：0.25 / 0.26 / 0.27 那几节本来就纯中文发布（没有英文译本），把
 *     它们拉进配对判据 = 一道常年红的门，而常年红的门等于没有门（这正是规则 9 要避的假红）。
 *
 * **想扩面的人该动哪里**（按这个顺序，别只改一处）：
 *   1. 扩面**只改本函数**（`resolveChangelogScanSurface`）：两条判据（规则 8 的
 *      `collectChangelogProblems` 与规则 9 的 `collectChangelogPairingProblems`）都只从它的返回值取
 *      `{from, to}`，**没有第二份选取逻辑** —— 这就是为什么扩面不需要动任何一条判据函数本体。
 *   2. 面的**个数**一旦从 1 变多（例如「Unreleased + 最近 N 个版本节」），返回值形状就得从
 *      `{from, to}` 改成区间数组，两个消费端要跟着改（`problems.surface` 是给 diagnostic 与地板判词
 *      用的单节描述）。这是本函数与两条判据之间**唯一**的契约，扩面时别偷偷绕过它。
 *   3. **地板必须重测**（`CHANGELOG_PAIR_FLOOR` / `CHANGELOG_PAIR_FLOOR_SURFACE`）：地板是**在某一节上
 *      实测**的配对数，不是全局常数。面换了（或从一节变成多节）⇒ 实测值必然变 ⇒ 先跑
 *      `node --test test/static-guards.test.js`，从 diagnostic 里抄下「配对 N 对」，再改常量与校准面
 *      标题，并把新数写进注释（中英 `AGENTS*.md` 里若有带这两个数的声称句，也要一起改）。
 *      **不重测就改面**等于拿一个没有校准依据的数当闸门：判词会说「地板被踩穿」，而实际只是面挪了
 *      ——假红和假绿一样坏。
 *   4. 已发布节进面**必然**要同时放弃「发布即冻结」这条口径（那些节是历史），所以扩面不是纯技术改动：
 *      得先在工单里说明「为什么这次要判历史」，否则下一个读这段注释的人会以为面本来就该是全文件。
 * ─────────────────────────────────────────────────────────────────────────
 *
 * @param {string[]} lines 整份 CHANGELOG 的行（已去 `\r`）
 * @param {string} [heading] 顶部版本节标题（默认 `## [Unreleased]`）
 * @returns {{ok: true, surface: object} | {ok: false, reason: string}}
 */
function resolveChangelogScanSurface(lines, heading = CHANGELOG_VERSION_HEADING) {
  const isVersionHeading = (line) => /^## \[/.test(line);
  const sectionEnd = (start) => {
    for (let i = start + 1; i < lines.length; i += 1) if (/^## /.test(lines[i])) return i;
    return lines.length;
  };
  const top = lines.findIndex(isVersionHeading);
  // 顶部不是 `## [Unreleased]`（发布时被改名却没补新的）⇒ 保持原口径：红并点名该补一个
  if (top === -1 || !lines[top].startsWith(heading)) {
    return { ok: false, reason: `找不到版本节标题 ${JSON.stringify(heading)}：本规则会对整份文件恒绿` };
  }
  const topTo = sectionEnd(top);
  const unreleasedBullets = countSectionBullets(lines, top + 1, topTo);
  if (unreleasedBullets > 0) {
    return {
      ok: true,
      surface: { heading: lines[top], line: top + 1, from: top + 1, to: topTo, fellBack: false, unreleasedBullets },
    };
  }
  // 开版态：Unreleased 是空的 ⇒ 卫生目标退到紧随其后的那一个版本节（那才是开版提交的内容）
  if (topTo >= lines.length || !isVersionHeading(lines[topTo])) {
    return {
      ok: false,
      reason: `顶部 ${JSON.stringify(heading)} 是空的（0 条 bullet），其后又找不到可扫的版本节：`
        + "开版提交应紧随其后写出本次发布的版本节——本规则不许在空节上静默变绿",
    };
  }
  return {
    ok: true,
    surface: {
      heading: lines[topTo],
      line: topTo + 1,
      from: topTo + 1,
      to: sectionEnd(topTo),
      fellBack: true,
      unreleasedBullets,
    },
  };
}

/**
 * 解析**扫描面那一节**（默认 `## [Unreleased]`，开版态退到紧随其后的版本节——见
 * `resolveChangelogScanSurface`），并把五条规则的违规一次算清（**纯函数，文本可注入**——
 * 反向证直接喂改过的真实文本，不碰磁盘）。
 *
 * @param {string} text 整份 CHANGELOG
 * @param {string} [heading] 顶部版本节标题（默认 `## [Unreleased]`）
 */
function collectChangelogProblems(text, heading = CHANGELOG_VERSION_HEADING) {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const problems = {
    found: false,
    surface: null,
    subsections: [],
    bullets: [],
    byteDuplicates: [],
    sliceDuplicates: [],
    labelCounts: { en: 0, cn: 0 },
    sectionLabelCounts: {},
    pairingProblems: [],
    nearDuplicates: [],
    structureProblems: [],
  };
  const resolved = resolveChangelogScanSurface(lines, heading);
  if (!resolved.ok) {
    problems.structureProblems.push(resolved.reason);
    return problems;
  }
  problems.found = true;
  problems.surface = resolved.surface;
  const { from, to } = resolved.surface;

  // ── 小节切分（每个小节的终点 = 下一个小节标题；最后一个小节到版本节末尾） ──
  let current = null;
  for (let i = from; i < to; i += 1) {
    const m = /^### (.*)$/.exec(lines[i]);
    if (!m) continue;
    if (current) current.to = i;
    current = { name: m[1].trim(), line: i + 1, from: i + 1, to };
    problems.subsections.push(current);
  }

  // ── R5 结构：小节顺序（`Added` 之类可以插在中间，只钉三者的**相对**顺序 + 各出现一次） ──
  const names = problems.subsections.map((s) => s.name);
  const present = names.filter((name) => CHANGELOG_REQUIRED_SUBSECTIONS.includes(name));
  if (present.join(" → ") !== CHANGELOG_REQUIRED_SUBSECTIONS.join(" → ")) {
    problems.structureProblems.push(
      `小节顺序应为 ${CHANGELOG_REQUIRED_SUBSECTIONS.join(" → ")}（各出现一次），实测 ${names.join(" → ") || "（无小节）"}`,
    );
  }

  // ── R5 结构：游离正文行（既不是 bullet、也不是缩进续行 / 惰性续行） ──
  let prevKind = "heading";
  for (let i = from; i < to; i += 1) {
    const line = lines[i];
    if (line.trim() === "") { prevKind = "blank"; continue; }
    if (/^#{1,6} /.test(line)) { prevKind = "heading"; continue; }
    if (line.startsWith("- ")) { prevKind = "bullet"; continue; }
    if (/^[ \t]/.test(line)) { prevKind = "continuation"; continue; }
    // 非缩进、非 bullet、非标题：紧跟在 bullet 正文后面 ⇒ 合法的「惰性续行」（Markdown 允许）
    if (prevKind === "bullet" || prevKind === "continuation") { prevKind = "continuation"; continue; }
    problems.structureProblems.push(
      `第 ${i + 1} 行是游离正文（${prevKind === "heading" ? "小节标题下直接写正文" : "段首散文"}，`
      + `既不是 bullet 也不是续行）：${JSON.stringify(line.slice(0, 60))}`,
    );
    prevKind = "prose";
  }

  // ── bullet 解析（整条：`- ` 行 + 后续非空、非 bullet、非标题的行） ──
  for (const section of problems.subsections) {
    for (let i = section.from; i < section.to; i += 1) {
      if (!lines[i].startsWith("- ")) continue;
      const body = [lines[i]];
      let j = i + 1;
      while (j < section.to) {
        const line = lines[j];
        if (line.startsWith("- ") || /^#{1,6} /.test(line) || line.trim() === "") break;
        body.push(line);
        j += 1;
      }
      const raw = body.join("\n");
      problems.bullets.push({
        section: section.name,
        line: i + 1,
        raw,
        text: raw,
        labels: changelogSliceLabels(raw),
      });
      i = j - 1;
    }
  }

  // ── R1 字节唯一（全节口径） ──
  const byRaw = new Map();
  for (const bullet of problems.bullets) {
    const first = byRaw.get(bullet.raw);
    if (first) problems.byteDuplicates.push({ first: first.line, second: bullet.line, section: bullet.section });
    else byRaw.set(bullet.raw, bullet);
  }

  // ── R2 片号唯一（**逐小节** + 两套键空间互不折算） ──
  const keysBySection = new Map();
  for (const bullet of problems.bullets) {
    for (const label of bullet.labels) {
      const id = `${bullet.section}\u0000${label.space}\u0000${label.key}`;
      if (!keysBySection.has(id)) keysBySection.set(id, { section: bullet.section, space: label.space, key: label.key, lines: [] });
      keysBySection.get(id).lines.push(bullet.line);
    }
  }
  for (const entry of keysBySection.values()) {
    if (entry.lines.length > 1) problems.sliceDuplicates.push(entry);
  }

  // ── R3 中英配对数相等（全节口径；逐小节数字只打印，不做判据——避免多余假红面） ──
  for (const bullet of problems.bullets) {
    const spaces = new Set(bullet.labels.map((label) => label.space));
    for (const space of spaces) problems.labelCounts[space] += 1;
    const key = bullet.section;
    problems.sectionLabelCounts[key] ??= { en: 0, cn: 0 };
    for (const space of spaces) problems.sectionLabelCounts[key][space] += 1;
  }
  if (problems.labelCounts.en !== problems.labelCounts.cn) {
    problems.pairingProblems.push(
      `带 EN 片号标签的 ${problems.labelCounts.en} 条 ≠ 带 CN 片号标签的 ${problems.labelCounts.cn} 条`
      + "（某一侧整句被删掉了？）",
    );
  }

  // ── R4 语义近重复（全节口径，**同一语言内**比） ──
  for (const group of ["cn", "en"]) {
    const bullets = problems.bullets.filter((bullet) => changelogBulletLanguage(bullet.text).lang === group);
    for (let i = 0; i < bullets.length; i += 1) {
      for (let j = i + 1; j < bullets.length; j += 1) {
        const a = bullets[i];
        const b = bullets[j];
        const issuesA = changelogIssueRefs(a.text);
        const issuesB = changelogIssueRefs(b.text);
        const symbolsA = changelogSymbols(a.text);
        const symbolsB = changelogSymbols(b.text);
        if (issuesA.size === 0 || issuesB.size === 0) continue;
        if (symbolsA.size === 0 || symbolsB.size === 0) continue;
        if (!sameSet(issuesA, issuesB) || !sameSet(symbolsA, symbolsB)) continue;
        problems.nearDuplicates.push({
          first: a.line,
          second: b.line,
          issues: [...issuesA].sort(),
          symbols: symbolsA.size,
        });
      }
    }
  }

  return problems;
}

/** 真实树上的 CHANGELOG（只读一次；反向证走内存文本，不写盘）。 */
const changelogText = () => readFileSync(resolve(ROOT, CHANGELOG_REL), "utf8");

/** 开版夹具里刚开的那个版本节标题（日期固定，不与真实版本号耦合）。 */
const CHANGELOG_OPENING_HEADING = "## [0.28.0] - 2026-11-01";
/**
 * **开版态夹具**（issue #558，**纯内存合成，不写盘**）：顶部 `## [Unreleased]` 留空，扫描面那
 * 一整节内容整体下移成 `CHANGELOG_OPENING_HEADING` —— 与 0.27.0 的开版提交 `4963293` 同一形状。
 *
 * 真实 `CHANGELOG.md` 只当**素材**（它归主 agent 维护，本单禁改），且**幂等**：无论真实树当前是
 * 未开版（顶部 Unreleased 有内容）还是已经开过版（顶部 Unreleased 为空），本夹具合成的都是同一形状
 * ——它不能因为「主 agent 此刻正在做 0.28 开版」而变成一个空节。
 */
function changelogOpeningStateText() {
  const lines = changelogText().split("\n");
  const top = lines.findIndex((line) => /^## \[/.test(line));
  assert.notEqual(top, -1, `CHANGELOG 里没有任何 \`## [x]\` 版本节：夹具无素材`);
  assert.equal(lines[top].startsWith(CHANGELOG_VERSION_HEADING), true,
    `顶部版本节不是 ${CHANGELOG_VERSION_HEADING}（实测 ${JSON.stringify(lines[top])}）：夹具无法合成开版态`);
  const resolved = resolveChangelogScanSurface(lines);
  assert.equal(resolved.ok, true, `夹具取不到扫描面：${resolved.ok ? "" : resolved.reason}`);
  const { from, to } = resolved.surface;
  return [
    ...lines.slice(0, top), // 文件头（`# Changelog` + 遵循说明）
    CHANGELOG_VERSION_HEADING, // 开版后留空的 Unreleased
    "",
    CHANGELOG_OPENING_HEADING, // 本次发布的版本节（内容 = 原扫描面那一整段，逐字搬过来）
    ...lines.slice(from, to),
    ...lines.slice(to), // 其余历史版本节，原样保留
  ].join("\n");
}

/** 变异：锚点必须**恰好出现一次**，否则抛——「变异没落上」按 #210 R2 也算失败。 */
function replaceExactlyOnce(text, from, to, what = "变异锚点") {
  const hits = text.split(from).length - 1;
  assert.equal(hits, 1, `${what}必须恰好出现一次，实测 ${hits} 次：${JSON.stringify(from.slice(0, 60))}`);
  return text.replace(from, to);
}

/**
 * **扫描面**在整份文件里的字符区间（行号口径 → 字符区间）。与 `collectChangelogProblems` 共用
 * **同一套选取**（issue #558）：开版态下变异靶子也要落在退让后的那个版本节里，否则
 * 「`### Changed` 在空 Unreleased 里 0 次」会把反向证 ⑤ 假红成「变异没落上」。
 */
function changelogVersionSectionSpan(text, heading = CHANGELOG_VERSION_HEADING) {
  const lines = text.split("\n");
  const offsets = [];
  let cursor = 0;
  for (const line of lines) { offsets.push(cursor); cursor += line.length + 1; }
  const resolved = resolveChangelogScanSurface(lines, heading);
  assert.equal(resolved.ok, true,
    `找不到扫描面：${resolved.ok ? "" : resolved.reason}`);
  const { from, to } = resolved.surface;
  return { start: offsets[from], end: to < lines.length ? offsets[to] : text.length };
}

/**
 * 只在**版本节内部**做变异：`### Changed` 这类小节标题在别的（已发布）版本节里也有，
 * 拿全文件当锚点会「不唯一」而变异失败——那不是判据问题，是靶子选错了。
 */
function replaceExactlyOnceInVersionSection(text, from, to, what = "变异锚点") {
  const { start, end } = changelogVersionSectionSpan(text);
  return text.slice(0, start) + replaceExactlyOnce(text.slice(start, end), from, to, what) + text.slice(end);
}

/**
 * **合成形状夹具**（issue #571：反向证的靶子必须与「当前面恰好是什么形状」无关）。
 *
 * 纯内存字符串，不读真树、不写盘：它与 `CHANGELOG.md` 今天扫的是哪一节、那一节里有几条条目**完全无关**，
 * 所以「主 agent 把条目从 `## [0.28.0]` 搬进 `## [Unreleased]`」这件事不会再让反向证变红
 * （#571 之前那 12 格红就是这一族：靶子按内容指名了 0.28.0 那一节里的具体 bullet）。
 *
 * 形状是**成熟节**（`### Breaking → ### Changed → ### Fixed` 各一次）：R5 的「相对顺序」判据因此有一个
 * 零红的正样本。新生节（只有 `### Added`）不满足它——那是**成熟度**，不是解析器健康度，
 * 见 `changelogSurfaceParseProblems()` 的注释。
 *
 * 里面刻意放了真仓出现过的形态，每一种都对应下面某一条判据：
 *   · 中英成对、issue 集合逐对相同 —— R3 的配对数相等（EN 3 / CN 3）；
 *   · `S3 第三片` 与 `S3 第三片 b 段` **同一小节共存** —— 粗正则会把它们报成「三 重复」，真键是两个；
 *   · 无 issue 引用且紧邻的一对（丁 / Delta）—— 配对判据的「紧邻」分支不是死代码；
 *   · 同 issue 集合、不同符号集的两条 CN 条目（丙 / 戊）—— R4 的判别面非空且不恒红；
 *   · 折行的续行条目（甲 / Alpha）—— 解析单位是整条 bullet，不是首行。
 */
const CHANGELOG_SYNTHETIC_SECTION = [
  "# Changelog",
  "",
  "本文件遵循 Keep a Changelog；版本号遵循语义化版本。",
  "## [Unreleased]",
  "",
  "### Breaking",
  "",
  "- **甲：旧写法被拆掉了（issue #901，S3 第四片）。**",
  "  续行说明为什么拆：这一段故意折行，用来证明解析单位是整条 bullet 而不是首行。",
  "- **Alpha: the old spelling is gone (issue #901, S3, fourth slice).**",
  "  A wrapped continuation line: the parse unit is the whole bullet, not its first line.",
  "",
  "### Changed",
  "",
  "- **乙：默认值改了（issue #902）。**",
  "- **Beta: the default changed (issue #902).**",
  "",
  "### Fixed",
  "",
  "- **丙：拒绝文案修好了（issue #903、#904，S3 第三片）。**",
  "- **Gamma: the rejection text is fixed (issue #903, #904, S3, third slice).**",
  "- **丁：第三片 b 段的收尾（S3 第三片 b 段）。**",
  "- **Delta: the wrap-up of the third slice b (S3, third slice b).**",
  "- **戊：同一个 issue 集合、不同的符号集合（issue #903、#904，`alpha`）。**",
  "- **Epsilon: same issue set, different symbols (issue #903, #904, `beta`).**",
  "",
].join("\n");

/** 合成夹具的文本（每次现造一份；调用方只读，变异一律走 `replaceExactlyOnce*` 造新串）。 */
const changelogSyntheticSectionText = () => CHANGELOG_SYNTHETIC_SECTION;

/**
 * **「解析面没空转」的判据**（issue #571：**不许依赖成熟度**）。
 *
 * 原先这一格数的是「至少 3 个小节 / 至少 40 条 bullet / 至少 10 个片号标签 / 至少 50 对同 issue 对子」——
 * 那是 `## [0.28.0]` 那一节的**成熟度**，不是解析器健康度：顶部 `## [Unreleased]` 一有内容（哪怕只有
 * 1 小节 1 对条目），扫描面就合法地缩成新生节，这一格于是假红。换成与成熟度无关的三件事：
 *   ① 面上写的**每一行**都要有归宿：`### ` 级标题数 == 解析出的小节数，Markdown 列表项行数
 *      （`- ` / `* ` / `+ `）== 解析出的 bullet 数——静默丢行必红；
 *   ② 面上有内容（有非空行）却一个小节 / 一条 bullet 都没解析出来 ⇒ 红（空转必红）；
 *   ③ 每条 bullet 的原文非空、行号落在面里（解析单位不是空壳）。
 * 于是「新生节 1 小节 1 条目」放行，「面上有内容却解析出 0」仍红（两向反向证见调用处）。
 *
 * @returns {string[]} 违规描述（空数组 = 解析面健康）
 */
function changelogSurfaceParseProblems(text, heading = CHANGELOG_VERSION_HEADING) {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const problems = collectChangelogProblems(text, heading);
  if (!problems.found) return [`找不到扫描面（顶部 ${JSON.stringify(heading)}）`];
  const { from, to } = problems.surface;
  const out = [];
  if (!(to > from)) out.push(`扫描面区间退化：${JSON.stringify({ from, to })}`);
  const region = lines.slice(from, to);
  // 独立数一遍（不复用解析器）：`### ` 级标题行、Markdown 列表项行
  const subheadingLines = region.filter((line) => /^#{3,6} /.test(line)).length;
  const listLines = region.filter((line) => /^[-*+] /.test(line)).length;
  if (subheadingLines !== problems.subsections.length) {
    out.push(`面上有 ${subheadingLines} 个 \`###\` 级标题，只解析出 ${problems.subsections.length} 个小节：`
      + "解析器静默丢行（判据只认 `### `，`#### ` 之类会被整段跳过）");
  }
  if (listLines !== problems.bullets.length) {
    out.push(`面上有 ${listLines} 行 Markdown 列表项（\`- \` / \`* \` / \`+ \`），只解析出 ${problems.bullets.length} 条 bullet：`
      + "解析器静默丢行（不在小节里的 bullet 会被整条丢掉）");
  }
  const contentLines = region.filter((line) => line.trim() !== "").length;
  if (contentLines > 0 && problems.subsections.length === 0 && problems.bullets.length === 0) {
    out.push(`面上有 ${contentLines} 行内容，却一个小节 / 一条 bullet 都没解析出来：解析面空转`);
  }
  for (const bullet of problems.bullets) {
    if (bullet.raw.trim() === "") out.push(`第 ${bullet.line} 行的 bullet 原文是空的：解析单位退化成空壳`);
    if (bullet.line < from + 1 || bullet.line > to) {
      out.push(`第 ${bullet.line} 行的 bullet 落在扫描面 ${from + 1}–${to} 之外`);
    }
  }
  return out;
}

/**
 * 扫描面上的**第一条** bullet（issue #571：靶子从当前面**自己派生**，不再按内容指名某一条）。
 * 派生不出来 ⇒ 显式判失败（`assert` 直接抛），**不许静默跳过**——跳过会让反向证变成永远绿。
 */
function firstChangelogSurfaceBullet(text, heading = CHANGELOG_VERSION_HEADING) {
  const problems = collectChangelogProblems(text, heading);
  assert.equal(problems.found, true, `派生靶子失败：找不到扫描面（顶部 ${JSON.stringify(heading)}）`);
  const [first] = problems.bullets;
  assert.ok(first, `派生靶子失败：扫描面（${problems.surface.heading}）里一条 bullet 都没有——`
    + "这一格没有靶子就会静默恒绿，所以直接判失败");
  return first;
}

/**
 * 扫描面**下面**那一节里的第一条 bullet（反向证 ⑧ 要证「面外的重复不归它管」）。
 * 同样派生：取 `surface.to` 之后的第一条 `- ` 行，连同续行读成一整条；派生不出来 ⇒ 显式判失败。
 */
function firstChangelogBulletBelowSurface(text, heading = CHANGELOG_VERSION_HEADING) {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const resolved = resolveChangelogScanSurface(lines, heading);
  assert.equal(resolved.ok, true, `派生靶子失败：找不到扫描面（${resolved.ok ? "" : resolved.reason}）`);
  const start = lines.findIndex((line, i) => i >= resolved.surface.to && line.startsWith("- "));
  assert.notEqual(start, -1,
    "派生靶子失败：扫描面下面没有任何 bullet——这一格没有靶子就会静默恒绿，所以直接判失败");
  const body = [lines[start]];
  let j = start + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (line.startsWith("- ") || /^#{1,6} /.test(line) || line.trim() === "") break;
    body.push(line);
    j += 1;
  }
  return { line: start + 1, raw: body.join("\n") };
}

/**
 * 合成一条与靶子**同 issue 集合 + 同反引号符号集合**的中文 bullet（反向证 ② 用）。
 * 语言判定按**整条 bullet 的 CJK 占比**（R4 只在同一语言内比），而靶子常常是一堆长标识符 + 少量中文，
 * 所以合成样本可能被判成英文而绕过比较——这里逐次补中文散文直到判定为 `cn`，并**显式断言**
 * 三件事：被判成中文、issue 集合相同、符号集合相同（任一条不成立就红，不许静默恒绿）。
 */
function changelogNearDuplicateOf(bullet) {
  const issues = [...changelogIssueRefs(bullet.text)].sort();
  const symbols = [...changelogSymbols(bullet.text)].sort();
  const head = `- 近重复样本（${issues.map((id) => `#${id}`).join("、")}）：`
    + `${symbols.map((s) => `\`${s}\``).join("、")}。正文一字不同，但 issue 集合与反引号符号集合完全相同。`;
  let text = head;
  for (let i = 0; i < 20 && changelogBulletLanguage(text).lang !== "cn"; i += 1) {
    text += "这一条刻意补足中文散文，好让整条 bullet 的 CJK 占比过判定阈值，与靶子同属中文条目。";
  }
  assert.equal(changelogBulletLanguage(text).lang, "cn",
    "合成的近重复样本没被判成中文条目：R4 只在同一语言内比，这一格会退化成恒绿");
  assert.deepEqual([...changelogIssueRefs(text)].sort(), issues, "合成样本的 issue 集合与靶子不同：这一格证不到集合比较");
  assert.deepEqual([...changelogSymbols(text)].sort(), symbols, "合成样本的符号集合与靶子不同：这一格证不到符号比较");
  assert.notEqual(text, bullet.text, "变异没落上：合成的近重复条目与靶子逐字相同");
  return text;
}

/**
 * R5「小节顺序」判词在**当前面**上应得的结论（issue #571：真实面的形状随成熟度变，判词也跟着变）。
 *
 * 这里**独立**再推一遍（不复用 `collectChangelogProblems` 里那段代码）：面上实际有哪些必需小节、
 * 顺序对不对，只由小节名决定。返回空数组 = 面的形状合法；否则是**唯一**该出现的那条判词。
 * 判据本体一个字没动（仍在 `collectChangelogProblems` 里），这里只把「今天该红哪一条」算出来，
 * 好让「该红的没红 / 不该红的红了」两头都能被抓住——判据被放宽时，这份独立推导**不会**跟着放宽。
 */
function changelogExpectedShapeComplaints(problems) {
  const names = problems.subsections.map((section) => section.name);
  const present = names.filter((name) => CHANGELOG_REQUIRED_SUBSECTIONS.includes(name));
  if (present.join(" → ") === CHANGELOG_REQUIRED_SUBSECTIONS.join(" → ")) return [];
  return [`小节顺序应为 ${CHANGELOG_REQUIRED_SUBSECTIONS.join(" → ")}（各出现一次），实测 ${names.join(" → ") || "（无小节）"}`];
}

describe("静态守卫：CHANGELOG 顶部版本节的卫生（issue #541）", () => {
  it("前置：解析面不退化成空转（面上写的小节 / bullet 一条都没被静默丢掉；成熟度不算判据）", (t) => {
    const text = changelogText();
    const problems = collectChangelogProblems(text);
    t.diagnostic(`规则 8：扫描面 = ${problems.surface?.heading}（第 ${problems.surface?.line} 行；`
      + `${problems.surface?.fellBack ? `顶部 ${CHANGELOG_VERSION_HEADING} 为空 ⇒ 退让` : "顶部节本身"}，`
      + `Unreleased bullet ${problems.surface?.unreleasedBullets} 条）= ${problems.subsections.map((s) => `${s.name}@${s.line}`).join(" / ")}；`
      + `${problems.bullets.length} 条 bullet；片号标签 EN ${problems.labelCounts.en} / CN ${problems.labelCounts.cn}`);
    assert.equal(problems.found, true, `找不到扫描面（顶部 ${CHANGELOG_VERSION_HEADING}）`);
    // 扫描面必须**点得出名字**且区间不退化（开版态下这里是刚开的那个版本节，不是空转）
    assert.ok(problems.surface && problems.surface.heading, "扫描面没记录下是哪一节：诊断看不见扫的是谁");
    assert.ok(problems.surface.to > problems.surface.from,
      `扫描面区间退化：${JSON.stringify({ from: problems.surface.from, to: problems.surface.to })}`);
    // ── 「解析器没坏」= 面上写的东西**没被静默丢掉**，不是「面足够成熟」──
    // issue #571：扫描面会随开版 / 收条目挪动（#558），新生节合法地只有 1 小节 1 对条目。
    // 所以这一格不数「至少几小节 / 至少几条 bullet / 至少几个片号标签 / 至少几对同 issue 对子」——
    // 那是成熟度，数它必然把新生节判成假红（旧版就是这 4 条一起红）。
    assert.deepEqual(changelogSurfaceParseProblems(text), [],
      `扫描面（${problems.surface.heading}）的解析面空转了：${JSON.stringify(changelogSurfaceParseProblems(text))}`);
    assert.ok(problems.subsections.length >= 1, `扫描面（${problems.surface.heading}）一个小节都没解析出来`);
    assert.ok(problems.bullets.length >= 1, `扫描面（${problems.surface.heading}）一条 bullet 都没解析出来`);
    // 放行证（issue #571 要求逐字兑现的那一格）：**新生节 1 小节 1 条目必须放行**
    const newborn = `# Changelog\n\n本文件遵循 Keep a Changelog。\n## [Unreleased]\n\n### Added\n\n- 一条新条目（issue #999）。\n`;
    assert.deepEqual(changelogSurfaceParseProblems(newborn), [],
      "新生节（1 小节 1 条目）被这一格判红了：解析面健康度的判据又依赖成熟度了");
    // 反向证（两向，全部在**当前面**上就地造，不依赖面是哪一节）：
    const { start, end } = changelogVersionSectionSpan(text);
    const region = text.slice(start, end);
    // ① 面内小节标题整体降级（`### ` → `#### `）：面上还有内容，却一个小节 / 一条 bullet 都解析不出来 ⇒ 红
    const allLevel4 = text.slice(0, start) + region.replace(/^### /gm, "#### ") + text.slice(end);
    const allLevel4Problems = changelogSurfaceParseProblems(allLevel4);
    assert.equal(allLevel4Problems.some((p) => p.includes("解析面空转")), true,
      `面上有内容却解析出 0 小节 0 bullet 时没点名「解析面空转」：${JSON.stringify(allLevel4Problems)}`);
    // ② 只把**第一条**列表项换成 `* `（其余留着 ⇒ 扫描面不会因此退让）：那一行被静默丢掉 ⇒ 红
    const oneStarList = text.slice(0, start) + region.replace(/^- /m, "* ") + text.slice(end);
    const oneStarProblems = changelogSurfaceParseProblems(oneStarList);
    assert.equal(oneStarProblems.some((p) => /只解析出 \d+ 条 bullet/.test(p)), true,
      `面内一条列表项换成 \`* \` 之后这一格没红（那一行被静默丢掉）：${JSON.stringify(oneStarProblems)}`);
    assert.equal(collectChangelogProblems(oneStarList).bullets.length, problems.bullets.length - 1,
      "丢掉一行列表项之后解析出的 bullet 数应减 1：解析器把 `* ` 当成了正文");
    t.diagnostic(`规则 8 前置反向证：小节标题整体降级 ⇒ ${allLevel4Problems.length} 处红（含「解析面空转」）；`
      + `一条 \`- \`→\`* \` ⇒ ${oneStarProblems.length} 处红（点名丢行）；真实面 ⇒ 0 处`);
    // 片号标签的解析能力**与面无关**：真实面今天可能一个片号都没有（新生节），所以拿合成形状夹具证
    // 「两套键空间都认得出、且折行的标签也算进整条 bullet」。不拿「真实面恰好有 N 个标签」当解析器健康度。
    const shape = collectChangelogProblems(changelogSyntheticSectionText());
    assert.equal(shape.labelCounts.en, 3, `合成夹具的 EN 片号应有 3 条，实测 ${shape.labelCounts.en}：片号解析坏了`);
    assert.equal(shape.labelCounts.cn, 3, `合成夹具的 CN 片号应有 3 条，实测 ${shape.labelCounts.cn}：片号解析坏了`);
    assert.ok(shape.bullets.some((bullet) => bullet.text.includes("\n") && bullet.labels.length > 0),
      "合成夹具里没有「折行的多行 bullet + 片号标签」样本：多行解析没被覆盖");
    // R4 的判别面同样与面无关：在夹具上数「同语言 + issue 集合相同」的对子，并要求 R4 不把它们全判红
    let sameIssuePairs = 0;
    for (const group of ["cn", "en"]) {
      const groupBullets = shape.bullets.filter((bullet) => changelogBulletLanguage(bullet.text).lang === group);
      for (let i = 0; i < groupBullets.length; i += 1) {
        for (let j = i + 1; j < groupBullets.length; j += 1) {
          const a = changelogIssueRefs(groupBullets[i].text);
          const b = changelogIssueRefs(groupBullets[j].text);
          if (a.size > 0 && b.size > 0 && sameSet(a, b)) sameIssuePairs += 1;
        }
      }
    }
    t.diagnostic(`规则 8：R4 的判别面（合成夹具）= ${sameIssuePairs} 对「同语言 + issue 集合相同」的 bullet，`
      + `其中符号集合也相同的 = ${shape.nearDuplicates.length} 对；真实面 ${problems.bullets.length} 条 bullet / `
      + `${problems.subsections.length} 个小节，解析面 0 处丢行`);
    assert.ok(sameIssuePairs >= 2, `合成夹具上「同 issue 集合」的对子只有 ${sameIssuePairs} 对：R4 的判别面塌了`);
    assert.deepEqual(shape.nearDuplicates, [],
      `合成夹具上 R4 把「同 issue 集合但符号集不同」的条目也判红了：${JSON.stringify(shape.nearDuplicates)}`);
  });

  it("R1 字节唯一 / R2 片号唯一（两套键空间不折算）/ R3 中英配对数相等（真实树 = 回归基线）", (t) => {
    const problems = collectChangelogProblems(changelogText());
    t.diagnostic(`规则 8 R1：${problems.bullets.length} 条 bullet，逐字重复 ${problems.byteDuplicates.length} 对`);
    t.diagnostic(`规则 8 R2：EN 键 ${problems.labelCounts.en} / CN 键 ${problems.labelCounts.cn}，`
      + `逐小节重复 ${problems.sliceDuplicates.length} 处`);
    t.diagnostic(`规则 8 R3：逐小节标签条数 ${JSON.stringify(problems.sectionLabelCounts)}`);
    assert.deepEqual(problems.byteDuplicates, [],
      `版本节里有逐字重复的 bullet（同一条写了两遍）：\n${JSON.stringify(problems.byteDuplicates, null, 2)}`);
    assert.deepEqual(problems.sliceDuplicates, [],
      `同一个片号标签在**同一小节**里出现了两次（EN / CN 各自一套键空间，不互相折算）：\n`
      + `${problems.sliceDuplicates.map((d) => `${d.section} / ${d.space} / ${d.key} @ 行 ${d.lines.join(",")}`).join("\n")}`);
    assert.deepEqual(problems.pairingProblems, [],
      `中英片号条数不等：${problems.pairingProblems.join(" / ")}`);
  });

  it("R4 语义近重复：同 issue 引用集合 + 同反引号符号集合 ⇒ 判重（真实树零命中）", (t) => {
    const problems = collectChangelogProblems(changelogText());
    t.diagnostic(`规则 8 R4：命中 ${problems.nearDuplicates.length} 对`);
    assert.deepEqual(problems.nearDuplicates, [],
      "有两条 bullet 引用了同一组 issue 且反引号符号集合相同——字节查重看不见这种「各写各的」重复：\n"
      + `${problems.nearDuplicates.map((d) => `行 ${d.first} vs 行 ${d.second}（issue ${d.issues.map((i) => `#${i}`).join(",")}，`
        + `${d.symbols} 个符号）`).join("\n")}`);
  });

  it("R5 结构：Breaking → Changed → Fixed 的相对顺序 + 无游离正文行（判据本体按形状夹具验，真实面只证「没有游离正文」）", (t) => {
    const problems = collectChangelogProblems(changelogText());
    t.diagnostic(`规则 8 R5：小节顺序 ${problems.subsections.map((s) => s.name).join(" → ") || "（无小节）"}；`
      + `游离正文 ${problems.structureProblems.filter((p) => p.includes("游离正文")).length} 处；`
      + `判词 ${JSON.stringify(problems.structureProblems)}`);
    // ① 真实面上与**成熟度无关**的那一半：节内没有游离正文行（写歪了就红，不管面是新是旧）
    assert.deepEqual(problems.structureProblems.filter((p) => p.includes("游离正文")), [],
      `版本节里有游离正文行：\n${problems.structureProblems.filter((p) => p.includes("游离正文")).join("\n")}`);
    // ② 「小节顺序」那一半在真实面上是**成熟度信号**（新生节只有 `### Added`，缺 Breaking/Changed/Fixed）：
    //    判据本体一个字没动，这里只断言「今天该红的就红那一条、不该红的没红」——期望值由
    //    `changelogExpectedShapeComplaints()` **独立**再推一遍（面形状变了它跟着变，判据被放宽它**不**跟着变）。
    assert.deepEqual(problems.structureProblems.filter((p) => p.includes("小节顺序")),
      changelogExpectedShapeComplaints(problems),
      `R5 的小节顺序判词与面上实际的小节名对不上：实测 ${JSON.stringify(problems.subsections.map((s) => s.name))}`);
    // ③ 判据本体（形状夹具）：成熟形状 ⇒ 零红（证明「相对顺序」判据仍在，而且放行合法形状）
    const fixture = changelogSyntheticSectionText();
    assert.deepEqual(collectChangelogProblems(fixture).structureProblems, [],
      "成熟形状（Breaking → Changed → Fixed 各一次）被判红了：R5 的判据本体被改坏了");
    // ④ 反向：换序 / 缺一个必需小节 ⇒ 红（靶子在夹具上，与真实面是哪一节无关）
    const swapped = replaceExactlyOnceInVersionSection(fixture, "### Changed", "### Fixed", "小节标题");
    assert.equal(collectChangelogProblems(swapped).structureProblems.some((p) => p.includes("小节顺序")), true,
      "夹具上把 Changed 换成 Fixed 之后 R5 没红：判据被放宽了");
    const dropped = replaceExactlyOnceInVersionSection(fixture, "### Changed\n", "", "必需小节");
    assert.equal(collectChangelogProblems(dropped).structureProblems.some((p) => p.includes("小节顺序")), true,
      "夹具上删掉 ### Changed 之后 R5 没红：判据被放宽了");
    // ⑤ 游离正文的判据本体（同样在夹具上）：段首散文 ⇒ 红
    const stray = replaceExactlyOnceInVersionSection(fixture, "### Breaking\n",
      "### Breaking\n\n这一行是段首散文，不是 bullet。\n", "小节标题");
    assert.equal(collectChangelogProblems(stray).structureProblems.some((p) => p.includes("游离正文")), true,
      "夹具上插入段首散文之后 R5 没红：判据被放宽了");
    t.diagnostic("规则 8 R5：真实面 游离正文 0 处 + 形状判词与面形状逐字对应；成熟形状夹具 0 红；"
      + "换序 / 缺小节 / 游离正文 三种变异各自点名");
  });

  it("R2 的「三」是正则产物、不是重复：`第三片` 与 `第三片 b 段` 是两个键（形状夹具证据，不依赖真实面）", (t) => {
    const fixture = changelogSyntheticSectionText();
    const problems = collectChangelogProblems(fixture);
    const cnKeys = new Map();
    for (const bullet of problems.bullets) {
      for (const label of bullet.labels) {
        if (label.space !== "cn") continue;
        if (!cnKeys.has(label.key)) cnKeys.set(label.key, []);
        cnKeys.get(label.key).push({ line: bullet.line, raw: label.raw });
      }
    }
    t.diagnostic(`规则 8 R2 的 CN 键空间（形状夹具）：${[...cnKeys.keys()].join(" / ")}`);
    const third = cnKeys.get("第三片") ?? [];
    const thirdB = cnKeys.get("第三片 b 段") ?? [];
    assert.equal(third.length, 1, `CN 键「第三片」应有且只有 1 条，实测 ${JSON.stringify(third)}`);
    assert.equal(thirdB.length, 1, `CN 键「第三片 b 段」应有且只有 1 条，实测 ${JSON.stringify(thirdB)}`);
    assert.notEqual(third[0].line, thirdB[0].line, "「第三片」与「第三片 b 段」指到了同一条 bullet：后缀没进键");
    // 对照：只用 `第N片` 的粗正则会把这两条报成「三 重复」——那正是没人核过的那条报法
    const naive = [...fixture.replace(/\s+/g, " ").matchAll(/S3\s*第([一二三四五六七八九十]+)片/g)]
      .filter((m) => m[1] === "三").length;
    t.diagnostic(`规则 8：粗正则 \`S3\\s*第([一二三四五六七八九十]+)片\` 在「三」上命中 ${naive} 次`
      + `（= 假重复的来源）；本规则把它们解析成两个键：${JSON.stringify([third[0].raw, thirdB[0].raw])}`);
    assert.equal(naive, 2, "粗正则的假重复样本没了：这一格的对照失去意义");
    assert.deepEqual(problems.sliceDuplicates, [], "夹具上 R2 有真重复：这一格的对照失去意义");
    // 真实面：片号键空间今天可能是空的（新生节里没有片号），但**有真重复就要红**——这一条与成熟度无关
    const live = collectChangelogProblems(changelogText());
    assert.deepEqual(live.sliceDuplicates, [], "真实树上 R2 有真重复（不是正则产物）：这要人工处理，不能改规则");
    t.diagnostic(`规则 8：真实面（${live.surface.heading}）片号标签 EN ${live.labelCounts.en} / `
      + `CN ${live.labelCounts.cn}，R2 真重复 0 处`);
  });

  it("反向证 ①：把面上第一条 bullet 原文复制进同节 ⇒ R1 红（靶子从当前面派生，不按内容指名；变异没落上也算失败）", (t) => {
    const text = changelogText();
    const target = firstChangelogSurfaceBullet(text);
    const mutated = replaceExactlyOnceInVersionSection(text, target.raw, `${target.raw}\n\n${target.raw}`, "复制靶子");
    const problems = collectChangelogProblems(mutated);
    assert.equal(problems.byteDuplicates.length, 1,
      `逐字复制一条 bullet 后 R1 应恰好 1 对红，实测 ${JSON.stringify(problems.byteDuplicates)}`);
    assert.equal(problems.byteDuplicates[0].section, target.section, "红要落在同一个小节里");
    t.diagnostic(`规则 8 反向证 ①：复制第 ${target.line} 行（面 = ${problems.surface.heading}）⇒ `
      + `R1 红 ${JSON.stringify(problems.byteDuplicates[0])}；原文 ⇒ 绿`);
    assert.deepEqual(collectChangelogProblems(text).byteDuplicates, [], "原文必须绿");
    // 面无关证：同一插法打在**合成夹具**上也红（夹具与真树内容无关 ⇒ 这一格不靠真树恰好有什么条目）
    const fixture = changelogSyntheticSectionText();
    const fixtureTarget = firstChangelogSurfaceBullet(fixture);
    const fixtureMutated = replaceExactlyOnceInVersionSection(fixture, fixtureTarget.raw,
      `${fixtureTarget.raw}\n\n${fixtureTarget.raw}`, "夹具复制靶子");
    assert.equal(collectChangelogProblems(fixtureMutated).byteDuplicates.length, 1,
      "合成夹具上逐字复制没被判红：这一格仍然只对真树当时的内容有效");
  });

  it("反向证 ②：字节不同但同 issue 引用 + 同符号集 ⇒ R4 红（靶子从面上派生；字节查重看不见它）", (t) => {
    const text = changelogText();
    const problems = collectChangelogProblems(text);
    const target = problems.bullets.find((bullet) => changelogBulletLanguage(bullet.text).lang === "cn"
      && changelogIssueRefs(bullet.text).size > 0
      && changelogSymbols(bullet.text).size > 0);
    assert.ok(target, `派生靶子失败：扫描面（${problems.surface.heading}）里没有「中文 + 有 issue 引用 + "
      + "有反引号符号」的 bullet——这一格没有靶子就会静默恒绿，所以直接判失败`);
    const issues = [...changelogIssueRefs(target.text)].sort();
    const symbols = [...changelogSymbols(target.text)];
    assert.ok(issues.length > 0 && symbols.length > 0, "靶子的 issue / 符号集合为空：这一格会退化成恒真");
    const fake = changelogNearDuplicateOf(target);
    const mutated = replaceExactlyOnceInVersionSection(text, target.raw, `${target.raw}\n${fake}`, "近重复靶子");
    const after = collectChangelogProblems(mutated);
    assert.equal(after.byteDuplicates.length, 0, "这一格要证的是「字节查重看不见」：不许让 R1 替 R4 抓住");
    assert.equal(after.nearDuplicates.length, 1,
      `合成一条「同 issue + 同符号集」的 bullet 后 R4 应恰好 1 对红，实测 ${JSON.stringify(after.nearDuplicates)}`);
    assert.deepEqual(after.nearDuplicates[0].issues, issues, "红要按 issue 集合点名");
    t.diagnostic(`规则 8 反向证 ②：字节不同、issue 集合 ${JSON.stringify(issues)}、符号集合 ${symbols.length} 个 ⇒ R4 红；`
      + "R1 不响（正是「按字节查重看不见语义重复」）");
    // 面无关证：同样的合成近重复打进形状夹具也红（靶子仍从夹具自己派生）
    const fixture = changelogSyntheticSectionText();
    const fixtureTarget = collectChangelogProblems(fixture).bullets.find((bullet) =>
      changelogBulletLanguage(bullet.text).lang === "cn"
      && changelogIssueRefs(bullet.text).size > 0
      && changelogSymbols(bullet.text).size > 0);
    assert.ok(fixtureTarget, "派生靶子失败：形状夹具里没有「中文 + issue + 符号」的 bullet");
    const fixtureAfter = collectChangelogProblems(replaceExactlyOnceInVersionSection(fixture, fixtureTarget.raw,
      `${fixtureTarget.raw}\n${changelogNearDuplicateOf(fixtureTarget)}`, "夹具近重复靶子"));
    assert.equal(fixtureAfter.byteDuplicates.length, 0, "夹具上 R1 不该响：这一格证的是 R4");
    assert.equal(fixtureAfter.nearDuplicates.length, 1,
      `夹具上合成近重复后 R4 应恰好 1 对红，实测 ${JSON.stringify(fixtureAfter.nearDuplicates)}`);
  });

  it("反向证 ③：把一个 CN 片号改成与另一条同值 ⇒ R2 红，改回 ⇒ 绿（靶子在形状夹具上）", (t) => {
    const fixture = changelogSyntheticSectionText();
    assert.deepEqual(collectChangelogProblems(fixture).sliceDuplicates, [], "夹具原文必须绿");
    const mutated = replaceExactlyOnceInVersionSection(fixture, "S3 第三片 b 段", "S3 第三片", "CN 片号靶子");
    const problems = collectChangelogProblems(mutated);
    assert.equal(problems.sliceDuplicates.length, 1,
      `CN 片号改成同值后 R2 应恰好 1 处红，实测 ${JSON.stringify(problems.sliceDuplicates)}`);
    assert.equal(problems.sliceDuplicates[0].space, "cn", "红要落在 CN 键空间里");
    assert.equal(problems.sliceDuplicates[0].key, "第三片", `红的键应是「第三片」，实测 ${problems.sliceDuplicates[0].key}`);
    assert.equal(problems.sliceDuplicates[0].lines.length, 2, "红要点名两条 bullet 的行号");
    t.diagnostic(`规则 8 反向证 ③：CN 第四片→第三片 ⇒ R2 红 ${JSON.stringify(problems.sliceDuplicates[0])}；`
      + "改回 ⇒ 绿（注意「第三片 b 段」不受牵连：后缀是键的一部分）");
  });

  it("反向证 ④：删掉一侧带片号 bullet ⇒ R3 红（配对数不等），补回 ⇒ 绿（靶子在形状夹具上）", (t) => {
    const fixture = changelogSyntheticSectionText();
    const before = collectChangelogProblems(fixture);
    assert.equal(before.pairingProblems.length, 0, "夹具原文的配对数必须先是相等的");
    assert.equal(before.labelCounts.en, before.labelCounts.cn, "夹具的 EN / CN 片号条数应先相等");
    const target = before.bullets.find((bullet) => bullet.labels.some((label) => label.space === "cn"));
    assert.ok(target, "派生靶子失败：夹具里没有带 CN 片号的 bullet");
    const mutated = replaceExactlyOnceInVersionSection(fixture, `${target.raw}\n`, "", "配对靶子");
    const problems = collectChangelogProblems(mutated);
    assert.equal(problems.pairingProblems.length, 1,
      `删掉一侧带片号的 bullet 后 R3 应红，实测 ${JSON.stringify(problems.pairingProblems)}`);
    assert.equal(problems.labelCounts.cn, before.labelCounts.cn - 1, "CN 条数应减一");
    assert.equal(problems.labelCounts.en, before.labelCounts.en, "EN 条数不该动（这一格证的是「一侧被删」）");
    t.diagnostic(`规则 8 反向证 ④：删掉第 ${target.line} 行（CN 片号）⇒ R3 红：${problems.pairingProblems[0]}；补回 ⇒ 绿`);
    assert.deepEqual(collectChangelogProblems(fixture).pairingProblems, [], "补回原文必须绿");
  });

  it("反向证 ⑤：变异没落上 / 找不到版本节 / 结构漂移都要判失败（#210 R2 惯例）", (t) => {
    const text = changelogText();
    // ① 变异没落上 ⇒ 变异器自己抛（每个反向证都走它，所以「没落上」不会静默变绿）
    assert.throws(() => replaceExactlyOnce(text, "这条锚点在 CHANGELOG 里绝对不存在", "x"), /必须恰好出现一次/,
      "变异没落上时没有判失败：反向证会变成永远绿");
    // ② 锚点出现两次也抛（避免「改错了一处」被当成变异成功）——靶子自带，不依赖 CHANGELOG 现内容
    assert.throws(() => replaceExactlyOnce(`${text}\nREPEAT-MARKER\nREPEAT-MARKER\n`, "REPEAT-MARKER", "x"), /必须恰好出现一次/,
      "锚点出现两次时没有判失败：变异可能落到了另一条上");
    // ③ 版本节被改名（发布时的正常动作）⇒ 红并点名，不许静默恒绿
    // 锚点带换行：正文里还有一处 `## [Unreleased]`（0.27.0 那节引用它），只认标题行
    const renamed = replaceExactlyOnce(text, `${CHANGELOG_VERSION_HEADING}\n`, "## [0.28.0] - 2026-11-01\n", "版本节标题");
    const noSection = collectChangelogProblems(renamed);
    assert.equal(noSection.found, false, "版本节改名后仍说找到了：规则会静默缩面");
    assert.equal(noSection.structureProblems.length, 1, "版本节改名后没有判红");
    assert.match(noSection.structureProblems[0], /找不到版本节标题/, "红要点名找不到标题");
    // ④ 小节顺序被换 ⇒ R5 红（锚点在**形状夹具**上：真实面今天可能没有 `### Changed`，那是成熟度不是变异失败）
    const fixture = changelogSyntheticSectionText();
    const swapped = replaceExactlyOnceInVersionSection(fixture, "### Changed", "### Fixed", "小节标题");
    assert.equal(collectChangelogProblems(swapped).structureProblems.some((p) => p.includes("小节顺序")), true,
      "小节顺序被换后 R5 没红");
    // ⑤ 游离正文行（缩进续行与惰性续行都不算，只有段首散文才算）⇒ R5 红
    const stray = replaceExactlyOnceInVersionSection(fixture, "### Breaking\n",
      "### Breaking\n\n这一行是段首散文，不是 bullet。\n", "小节标题");
    const strayProblems = collectChangelogProblems(stray).structureProblems;
    assert.equal(strayProblems.some((p) => p.includes("游离正文")), true, `游离正文行没被判红：${JSON.stringify(strayProblems)}`);
    t.diagnostic("规则 8 反向证 ⑤：变异没落上 / 锚点不唯一 / 版本节改名 / 小节顺序被换 / 游离正文行 —— 五格逐条按预期");
  });

  it("反向证 ⑥（issue #558）：开版态（顶部空 Unreleased）⇒ 扫描面退到刚开的版本节，真实内容仍然全绿", (t) => {
    const before = collectChangelogProblems(changelogText());
    const opening = changelogOpeningStateText();
    const problems = collectChangelogProblems(opening);
    assert.equal(problems.found, true, "开版态说找不到扫描面：退让没生效（这正是 issue #558 的那一格红）");
    assert.ok(problems.surface, "开版态没记录扫描面：诊断看不见扫的是哪一节");
    assert.equal(problems.surface.fellBack, true, "开版态应标记为「退让」");
    assert.equal(problems.surface.unreleasedBullets, 0, "开版夹具的顶部 Unreleased 必须是 0 条 bullet");
    assert.equal(problems.surface.heading, CHANGELOG_OPENING_HEADING,
      `扫描面应是刚开的版本节，实测 ${JSON.stringify(problems.surface.heading)}`);
    // 卫生目标**确实是那个版本节**：bullet 数 / 小节名与真实树原扫描面逐项相等（不只是「通过了」）
    assert.equal(problems.bullets.length, before.bullets.length,
      `退让后的扫描面只解析出 ${problems.bullets.length} 条 bullet，原扫描面是 ${before.bullets.length} 条`);
    // issue #571：这里不再要求「≥ 40 条」（那是 0.28.0 那一节的成熟度）。要求的是**一条都没丢**：
    // 内容逐项与退让前相等，且解析面 0 处丢行。
    assert.ok(problems.bullets.length >= 1,
      `退让后的扫描面一条 bullet 都没解析出来：这一格退化成空转了`);
    assert.deepEqual(problems.subsections.map((s) => s.name), before.subsections.map((s) => s.name),
      "退让后的小节序列与原 Unreleased 不一致：扫的不是同一节");
    assert.deepEqual(changelogSurfaceParseProblems(opening), [],
      `开版态解析面空转了：${JSON.stringify(changelogSurfaceParseProblems(opening))}`);
    assert.deepEqual(problems.byteDuplicates, [], `开版态 R1 红：${JSON.stringify(problems.byteDuplicates)}`);
    assert.deepEqual(problems.sliceDuplicates, [], `开版态 R2 红：${JSON.stringify(problems.sliceDuplicates)}`);
    assert.deepEqual(problems.pairingProblems, [], `开版态 R3 红：${JSON.stringify(problems.pairingProblems)}`);
    assert.deepEqual(problems.nearDuplicates, [], `开版态 R4 红：${JSON.stringify(problems.nearDuplicates)}`);
    // R5：游离正文 0 处（与成熟度无关）+ 形状判词与（新生节的）实际形状逐字对应——不拿成熟度当退让失败
    assert.deepEqual(problems.structureProblems.filter((p) => p.includes("游离正文")), [],
      `开版态 R5 游离正文红：${JSON.stringify(problems.structureProblems)}`);
    assert.deepEqual(problems.structureProblems.filter((p) => p.includes("小节顺序")),
      changelogExpectedShapeComplaints(problems),
      `开版态 R5 的形状判词与面上实际的小节名对不上：${JSON.stringify(problems.structureProblems)}`);
    // 成熟形状上的开版态：R5 也零红——「退让」只改扫哪一节，判据一格没放宽
    const matureOpening = replaceExactlyOnce(changelogSyntheticSectionText(), `${CHANGELOG_VERSION_HEADING}\n`,
      `${CHANGELOG_VERSION_HEADING}\n\n## [9.9.9] - 2026-01-01\n`, "成熟形状开版态");
    const mature = collectChangelogProblems(matureOpening);
    assert.equal(mature.surface.fellBack, true, "成熟形状开版态没退让：夹具造错了");
    assert.deepEqual(mature.structureProblems, [], `成熟形状的开版态 R5 红：${JSON.stringify(mature.structureProblems)}`);
    assert.deepEqual(mature.byteDuplicates, [], `成熟形状的开版态 R1 红：${JSON.stringify(mature.byteDuplicates)}`);
    assert.deepEqual(mature.sliceDuplicates, [], `成熟形状的开版态 R2 红：${JSON.stringify(mature.sliceDuplicates)}`);
    assert.deepEqual(mature.pairingProblems, [], `成熟形状的开版态 R3 红：${JSON.stringify(mature.pairingProblems)}`);
    assert.deepEqual(mature.nearDuplicates, [], `成熟形状的开版态 R4 红：${JSON.stringify(mature.nearDuplicates)}`);
    t.diagnostic(`规则 8 反向证 ⑥：扫描面 = ${problems.surface.heading}（退让，顶部 ${CHANGELOG_VERSION_HEADING} `
      + `bullet 0 条）= ${problems.bullets.length} 条 bullet / ${problems.subsections.length} 个小节 / `
      + `片号 EN ${problems.labelCounts.en} / CN ${problems.labelCounts.cn} ⇒ R1–R4 全绿、R5 游离正文 0 处；`
      + `成熟形状开版态 ⇒ R5 也 0 红`);
  });

  it("反向证 ⑦：退让之后 R1 仍然咬人——把刚开的版本节里一条 bullet 逐字复制 ⇒ 红", (t) => {
    const opening = changelogOpeningStateText();
    const before = collectChangelogProblems(opening);
    assert.equal(before.surface.fellBack, true, "夹具不是开版态：这一格证不了「退让之后仍咬人」");
    const target = firstChangelogSurfaceBullet(opening);
    const mutated = replaceExactlyOnceInVersionSection(opening, target.raw, `${target.raw}\n\n${target.raw}`, "复制靶子");
    const problems = collectChangelogProblems(mutated);
    assert.equal(problems.surface.heading, CHANGELOG_OPENING_HEADING, "扫描面漂了：这一格就白做了");
    assert.equal(problems.bullets.length, before.bullets.length + 1, "复制没被解析面看见：bullet 数应 +1");
    assert.equal(problems.byteDuplicates.length, 1,
      `退让之后逐字复制没被判红（规则被放宽了），实测 ${JSON.stringify(problems.byteDuplicates)}`);
    assert.equal(problems.byteDuplicates[0].section, target.section, "红要落在同一个小节里");
    t.diagnostic(`规则 8 反向证 ⑦：扫描面 = ${problems.surface.heading}（退让）→ ${before.bullets.length} 条变 `
      + `${problems.bullets.length} 条 bullet ⇒ R1 红 ${JSON.stringify(problems.byteDuplicates[0])}；`
      + `同一份夹具不改 ⇒ R1 0 对`);
    assert.deepEqual(before.byteDuplicates, [], "未变异的开版夹具必须绿");
  });

  it("反向证 ⑧：Unreleased 一有内容，扫描面就回到它（下面版本节的重复不再归它管）", (t) => {
    const opening = changelogOpeningStateText();
    const newBullet = "- **开版后第一条（issue #558）**：Unreleased 一有内容，扫描面就回到它。";
    // 开版后往 Unreleased 里补一条正常条目（三个必需小节都在，R5 也就不会替我们红）
    const stub = `${CHANGELOG_VERSION_HEADING}\n\n### Breaking\n\n${newBullet}\n\n### Changed\n\n### Fixed\n`;
    const withNew = replaceExactlyOnce(opening, `${CHANGELOG_VERSION_HEADING}\n`, stub, "Unreleased 新条目");
    const live = collectChangelogProblems(withNew);
    assert.equal(live.surface.heading, CHANGELOG_VERSION_HEADING,
      `Unreleased 有内容时扫描面应回到它，实测 ${JSON.stringify(live.surface.heading)}`);
    assert.equal(live.surface.fellBack, false, "Unreleased 有内容了还说「退让」：退让条件写宽了");
    assert.equal(live.surface.unreleasedBullets, 1, `Unreleased 应有 1 条 bullet，实测 ${live.surface.unreleasedBullets}`);
    assert.equal(live.bullets.length, 1, `扫描面应只含 Unreleased 那 1 条，实测 ${live.bullets.length}`);
    assert.deepEqual(live.structureProblems, [], `干净的 Unreleased 应全绿：${JSON.stringify(live.structureProblems)}`);
    assert.deepEqual(live.byteDuplicates, [], "干净的 Unreleased 不该有 R1 红");

    // ① 下面那个版本节里**逐字重复**一条 ⇒ 不在扫描面内 ⇒ 不红（证明扫的真是 Unreleased）
    const lower = firstChangelogBulletBelowSurface(withNew);
    const lowerDup = replaceExactlyOnce(withNew, lower.raw, `${lower.raw}\n\n${lower.raw}`, "下面版本节的重复");
    assert.equal(lowerDup.split(lower.raw).length - 1, 2, "变异没落上：下面版本节里并没有两份逐字相同的 bullet");
    const quiet = collectChangelogProblems(lowerDup);
    assert.equal(quiet.surface.heading, CHANGELOG_VERSION_HEADING, "扫描面漂了：这一格就白做了");
    assert.equal(quiet.bullets.length, 1, `扫描面应仍只有 Unreleased 那 1 条，实测 ${quiet.bullets.length}`);
    assert.deepEqual(quiet.byteDuplicates, [],
      `下面版本节的重复被算进扫描面了（扫的不是 Unreleased）：${JSON.stringify(quiet.byteDuplicates)}`);

    // ② 同样的重复放进 Unreleased 里 ⇒ R1 红（扫描面之内，规则照样咬）
    const dup = replaceExactlyOnce(withNew, `${newBullet}\n`, `${newBullet}\n\n${newBullet}\n`, "Unreleased 内重复");
    const problems = collectChangelogProblems(dup);
    assert.equal(problems.surface.heading, CHANGELOG_VERSION_HEADING, "扫描面漂了：这一格就白做了");
    assert.equal(problems.bullets.length, 2, `扫描面应有 2 条 bullet，实测 ${problems.bullets.length}`);
    assert.equal(problems.byteDuplicates.length, 1,
      `Unreleased 内逐字重复没被判红，实测 ${JSON.stringify(problems.byteDuplicates)}`);
    assert.equal(problems.byteDuplicates[0].section, "Breaking", "红要落在 Unreleased 的 Breaking 小节里");
    t.diagnostic(`规则 8 反向证 ⑧：扫描面 = ${CHANGELOG_VERSION_HEADING}（Unreleased bullet 1 条）；`
      + `下面版本节内造 1 对逐字重复 ⇒ R1 0 对（不在扫描面内）；`
      + `Unreleased 内造 1 对 ⇒ R1 红 ${JSON.stringify(problems.byteDuplicates[0])}`);
  });

  it("反向证 ⑨：顶部空 Unreleased 且整份文件只有它 ⇒ 仍然红，点名「找不到可扫的版本节」", (t) => {
    // 什么都没有：不许静默绿（前置格要的是「真扫出了结构」，不是「允许为空」）
    const bare = `# Changelog\n\n本文件遵循 Keep a Changelog；版本号遵循语义化版本。\n${CHANGELOG_VERSION_HEADING}\n`;
    const problems = collectChangelogProblems(bare);
    assert.equal(problems.found, false, "空 Unreleased 独苗竟然说找到了扫描面：这是静默绿");
    assert.equal(problems.bullets.length, 0, `扫描面应为空，实测 ${problems.bullets.length} 条`);
    assert.equal(problems.structureProblems.length, 1, `应恰好 1 条红，实测 ${JSON.stringify(problems.structureProblems)}`);
    assert.match(problems.structureProblems[0], /找不到可扫的版本节/, "红要点名「找不到可扫的版本节」");
    // 对照：退过去的那一节同样是空的 ⇒ 仍然红（R5 判「无小节」），仍然不许静默绿
    const twoEmpty = `${bare}\n${CHANGELOG_OPENING_HEADING}\n`;
    const p2 = collectChangelogProblems(twoEmpty);
    assert.equal(p2.found, true, "顶部空 + 下一个版本节存在时应能找到扫描面");
    assert.equal(p2.bullets.length, 0, "扫描面里本应 0 条 bullet");
    assert.equal(p2.structureProblems.some((p) => p.includes("小节顺序")), true,
      `退到空节后没判红（静默绿）：${JSON.stringify(p2.structureProblems)}`);
    t.diagnostic(`规则 8 反向证 ⑨：扫描面 = 无（顶部 ${CHANGELOG_VERSION_HEADING} bullet 0 条、`
      + `其后 0 个版本节）⇒ found=${problems.found} + 红：${problems.structureProblems[0].slice(0, 48)}…；`
      + `对照「退到空版本节」⇒ found=${p2.found} / bullet ${p2.bullets.length} / R5 红`);
  });
});

// ---------------------------------------------------------------------------
// ── 规则 8 的同族补丁（issue #563）：CHANGELOG **未发布节**的跨语言配对地板 ──
// ---------------------------------------------------------------------------
//
// 为什么需要它（规则 8 的五条判据一条都抓不到这个洞）：
//   · R1 逐字唯一 / R2 片号唯一 / R4 语义近重复，**三条都只在同一语言内比**（R4 的理由就写在上面：
//     中英是同一件事的两份译本，跨语言比会把**每一对译本**都判成重复）⇒ 它们从不回答「这一条有没有
//     译文」这个问题；
//   · 于是 `CHANGELOG.md`（在 `package.json` 的 `files` 里，**随包发出去**）可以整节只写中文、一条英文
//     都不写，而全量门禁仍然全绿。0.28 是宿主唯一要读的破坏性版本，实测 `Added` / `Changed` / `Fixed`
//     三节曾同时有 17 条只有中文没有英文（Added 5 / Changed 5 / Fixed 7）——这就是本判据堵的洞。
//
// 判据三条（**只能升不能降**，学符号锚点地板的做法）：
//   1. 语言判定按**整条 bullet 的 CJK 占比**（`CJK / (CJK + 连续拉丁词长度) > 0.12` ⇒ 中文）。
//      **不许**按标题前若干字判：英文条目里会逐字引用中文判词（`[已修剪]` / `## 主题词面包屑`），
//      中文条目首行也可能整段是反引号标识符——两个方向都会误判（审计当场就分别错过一次）。
//      实测余量很大：本节全部英文条目占比 0.000，中文条目最低 0.27。
//   2. 配对判据 = **issue 引用集合完全相同**；无 issue 引用的条目只允许与「同样无引用且紧邻」的对方
//      语言条目配对。**紧邻**用**行号区间**判（两条 bullet 之间最多隔 `CHANGELOG_PAIR_ADJACENT_GAP`
//      行），不拿首行距离判——本仓的英文条目普遍折行成十几行，首行距离对它们没有意义。
//      **禁止**按邻接位置直接配对：`Changed` 里连着三条都引 `#469`，按位置会假配。
//   3. 判据面**跟着开版走**（issue #563）：**复用规则 8 的 `resolveChangelogScanSurface()`**——顶部
//      `## [Unreleased]` 为空（= 开版那一刻）⇒ 退到紧随其后的那个版本节（0.28 开版那一刻解析成
//      `## [0.28.0]`），Unreleased 一有内容就自动回到它（#571 之后面就停在 `## [Unreleased]` 上）。**不许另写一份选取逻辑**：两条判据管的是同一节内容，
//      各选各的面迟早漂成两个真相（0.29 开版后新内容的重复/配对问题会一个看得见、一个看不见）。
//      也**不扫** 0.27.0 / 0.26.0 / 0.25.0——那三节是已发布历史，重写等于造假（同 #278 的口径），
//      而且它们本来就纯中文发布。
//      ⚠ 面一旦挪走，地板就**失去校准依据**（它是在 `CHANGELOG_PAIR_FLOOR_SURFACE` 上实测的）：
//      配对数不足 ⇒ **红并点名「面已挪到 <节名>，请重测地板」**。这是有意信号，不许下调地板、
//      也不许把面硬钉回旧标题来换绿。
//
// 地板常量 = 在 `CHANGELOG_PAIR_FLOOR_SURFACE` 那一节上**实测**的配对数。断言 `配对数 >= 地板`；超过时只打印
// 「可以抬地板到 N」。**不**把地板做成「两语言条数必须相等」的硬闸——0.25 / 0.26 那两节永远不满足，
// 那种闸会把门常年压红，而那正是本判据要避免的假红。
//
// issue #571（本单）：面已随 #571 片1 的条目（`createAgent`）**挪到 `## [Unreleased]`**（#558 的选取逻辑：
// 顶部 Unreleased 非空 ⇒ 面就是它）。地板**必须跟着面一起重测**——「只升不降」是**同一面内**的规则，
// 跨面重测是 #563 设计好的动作，不是放宽。
/** 地板校准所在的节标题（`CHANGELOG_PAIR_FLOOR` 是在**这一节**上实测的；面挪走且配对数不足 ⇒ 点名重测）。 */
const CHANGELOG_PAIR_FLOOR_SURFACE = "## [Unreleased]";
/** 两条 bullet 之间最多隔几行才算「紧邻」（0 = 直接相邻，1 = 中间隔一行）。 */
const CHANGELOG_PAIR_ADJACENT_GAP = 1;
/** 配对地板：在 `CHANGELOG_PAIR_FLOOR_SURFACE` 那一节上实测的配对数。**同一面内只能升不能降。**
 *
 * 历史：#563 在 `## [0.28.0]` 上实测 51；#571 片1 在那一节末尾加了一对 `createAgent` 条目 ⇒ 52；
 * 随后 #571（本单）把那条目搬进了 `## [Unreleased]`（0.28.0 已发布），面跟着挪到 `## [Unreleased]`
 * ⇒ **在新面上重测 = 1 对**。反向证（删一条英文 / 改一个 issue 引用 ⇒ 配对数必须掉到地板**以下**）
 * 要求地板恰等于实测值，否则它们会说「地板拦不住」——所以这个数不是拍出来的，是量出来的。只许继续往上抬。
 *
 * issue #574：`## [Unreleased] ### Fixed` 新增一对 `createAgent` 条目（同一个 issue 引用集合 #574 + #524）
 * ⇒ 在**同一个面**上实测 **2 对**（中文 2 / 英文 2 / 无对应 0，`node --test test/static-guards.test.js`
 * 的 diagnostic 原文），地板随之 1 → 2。同一面内只升不降，这次是**升**。
 *
 * issue #575：`## [Unreleased] ### Fixed` 再新增一对（`--json` 退出码 + CHANGELOG 扫描面注释，同一个
 * issue 引用集合 #575）⇒ 面没挪，仍是 `## [Unreleased]`，实测变成 **3 对**，地板 2 → 3。
 * 先贴守卫自己的实测 diagnostic（面未挪、只是配对变多时它会直接这么说）：
 *
 *     # 配对地板：判据面 = ## [Unreleased]（第 4 行，由 resolveChangelogScanSurface 选出：
 *     #   顶部 Unreleased 有内容）；中文 3 条 / 英文 3 条 / 配对 3 对
 *     #   （其中按「无 issue 引用 + 紧邻」配的 0 对）/ 无对应 0 条；地板 2（校准面 ## [Unreleased]）
 *     # 配对地板：实测 3 对 > 地板 2 对 ⇒ 可以抬地板到 3
 *
 * 同一格里的另一句（校准面上地板必须**恰等于**实测值，所以不改常量就会红）：
 *
 *     校准面（## [Unreleased]）上实测 3 对 ≠ 地板 2 对：地板必须恰等于校准面上的实测值
 *     （否则「掉一条就穿底」证不出来）。配对变多了 ⇒ 请抬地板到实测值
 */
const CHANGELOG_PAIR_FLOOR = 3;

/**
 * 一节里的 bullet（解析单位与规则 8 一致：`- ` 行 + 后续非空、非 bullet、非标题的行）。
 * 这里自带一份而不复用规则 8 的解析器：那条函数把五条判据算在一起，本判据不该为了拿 bullet
 * 去动它（规则 8 的 14 格一格都不许因为本单而变）。
 *
 * @returns {Array<{line: number, endLine: number, raw: string, lang: string, ratio: number, issues: Set<string>}>}
 *   `line` / `endLine` 都是 1-based 行号，`endLine` = 这条 bullet 的**最后一行**。
 */
function parseChangelogSectionBullets(lines, from, to) {
  const bullets = [];
  for (let i = from; i < to; i += 1) {
    if (!lines[i].startsWith("- ")) continue;
    const body = [lines[i]];
    let j = i + 1;
    while (j < to) {
      const line = lines[j];
      if (line.startsWith("- ") || /^#{1,6} /.test(line) || line.trim() === "") break;
      body.push(line);
      j += 1;
    }
    const raw = body.join("\n");
    const { lang, ratio } = changelogBulletLanguage(raw);
    bullets.push({ line: i + 1, endLine: j, raw, lang, ratio, issues: changelogIssueRefs(raw) });
    i = j - 1;
  }
  return bullets;
}

/** 两条 bullet 之间隔了几行（0 = 直接相邻；多行 bullet 按行号**区间**算，不按首行距离）。 */
function changelogBulletGap(a, b) {
  const [first, second] = a.line <= b.line ? [a, b] : [b, a];
  return second.line - first.endLine - 1;
}

/**
 * 未发布节的中英配对（**纯函数，文本可注入**——反向证直接喂改过的真实文本，不碰磁盘）。
 *
 * 判据面**不自己选**：走规则 8 的 `resolveChangelogScanSurface()`（issue #563）——顶部 `## [Unreleased]`
 * 为空就退到刚开的版本节，一有内容就回到它。两条判据管同一节，必须同源。
 *
 * @param {string} text 整份 CHANGELOG
 * @param {string} [heading] 顶部版本节标题（默认 `## [Unreleased]`，由 `resolveChangelogScanSurface` 解析）
 */
function collectChangelogPairingProblems(text, heading = CHANGELOG_VERSION_HEADING) {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const problems = {
    found: false,
    reason: "",
    surface: null,
    cn: [],
    en: [],
    pairs: [],
    unpairedCn: [],
    unpairedEn: [],
    adjacencyPairs: 0,
  };
  const resolved = resolveChangelogScanSurface(lines, heading);
  if (!resolved.ok) { problems.reason = resolved.reason; return problems; }
  problems.found = true;
  problems.surface = resolved.surface;
  const bullets = parseChangelogSectionBullets(lines, resolved.surface.from, resolved.surface.to);
  problems.cn = bullets.filter((bullet) => bullet.lang === "cn");
  problems.en = bullets.filter((bullet) => bullet.lang === "en");
  const usedEn = new Set();
  for (const cnBullet of problems.cn) {
    const candidates = cnBullet.issues.size === 0
      // 无 issue 引用 ⇒ 只允许与「同样无引用且紧邻」的对方语言条目配对（位置在此处**不是**判据本身，
      // 而是「没有 issue 引用可用」时唯一剩下的那条证据）
      ? problems.en.filter((enBullet) => enBullet.issues.size === 0
        && changelogBulletGap(cnBullet, enBullet) <= CHANGELOG_PAIR_ADJACENT_GAP)
      // 有 issue 引用 ⇒ 配对判据是**集合完全相同**（不是「有交集」，也不是「按位置」）
      : problems.en.filter((enBullet) => sameSet(cnBullet.issues, enBullet.issues));
    const partner = candidates.find((enBullet) => !usedEn.has(enBullet.line));
    if (!partner) { problems.unpairedCn.push(cnBullet); continue; }
    usedEn.add(partner.line);
    problems.pairs.push({ cn: cnBullet.line, en: partner.line, issues: [...cnBullet.issues].sort(), byIssueSet: cnBullet.issues.size > 0 });
    if (cnBullet.issues.size === 0) problems.adjacencyPairs += 1;
  }
  problems.unpairedEn = problems.en.filter((enBullet) => !usedEn.has(enBullet.line));
  return problems;
}

describe("静态守卫：CHANGELOG 未发布节的中英配对地板（issue #563，规则 8 的同族补丁）", () => {
  it("每一条中文条目都要有英文对应：配对数 >= 地板（只能升不能降）且无对应条数 = 0", (t) => {
    const text = changelogText();
    const problems = collectChangelogPairingProblems(text);
    // 地板是在 `CHANGELOG_PAIR_FLOOR_SURFACE` 那一节上实测的（#571 面随 #571 片1 的条目挪到
    // `## [Unreleased]`，所以地板 = 在 Unreleased 上重测的值：#571 起 1 对、#574 ⇒ 2 对、#575 ⇒ 3 对）。
    // 面被 `resolveChangelogScanSurface` 挪到别的节（例如 0.29 开版后顶部 Unreleased 又空了 ⇒ 退到刚开的
    // 版本节）时，这个数就没有校准依据了。
    const onFloorSurface = Boolean(problems.surface)
      && problems.surface.heading.startsWith(CHANGELOG_PAIR_FLOOR_SURFACE);
    t.diagnostic(`配对地板：判据面 = ${problems.surface?.heading}（第 ${problems.surface?.line} 行，`
      + `由 resolveChangelogScanSurface 选出${problems.surface?.fellBack
        ? "：顶部 Unreleased 为空 ⇒ 退到刚开的版本节"
        : "：顶部 Unreleased 有内容"}）；`
      + `中文 ${problems.cn.length} 条 / 英文 ${problems.en.length} 条 / 配对 ${problems.pairs.length} 对`
      + `（其中按「无 issue 引用 + 紧邻」配的 ${problems.adjacencyPairs} 对）/ `
      + `无对应 ${problems.unpairedCn.length + problems.unpairedEn.length} 条；地板 ${CHANGELOG_PAIR_FLOOR}`
      + `（校准面 ${CHANGELOG_PAIR_FLOOR_SURFACE}）`);

    // ── 前置：判据面必须真扫到东西，否则这一格退化成恒绿 ──
    assert.equal(problems.found, true,
      `找不到扫描面（顶部 ${JSON.stringify(CHANGELOG_VERSION_HEADING)}）：${problems.reason}`);
    assert.ok(problems.surface && problems.surface.to > problems.surface.from,
      `判据面区间退化：${JSON.stringify(problems.surface)}`);

    // ── 主判据先于地板判：无对应条数 = 0（两侧都要为零，不是「两边条数相等」）──
    // 顺序有意：面挪到别的节、而那一节里确实有中文条目缺译本时，红因必须落在「无对应 N 条」这个
    // 具体原因上，不被地板那句盖住。
    assert.deepEqual(problems.unpairedCn.map((bullet) => bullet.line), [],
      "有中文条目没有英文对应（行号）——随包发出去的 CHANGELOG 缺了译本："
      + `${problems.unpairedCn.map((bullet) => `${bullet.line}: ${JSON.stringify(bullet.raw.slice(3, 60))}`).join(" / ")}`);
    assert.deepEqual(problems.unpairedEn.map((bullet) => bullet.line), [],
      "有英文条目没有中文对应（行号）："
      + `${problems.unpairedEn.map((bullet) => `${bullet.line}: ${JSON.stringify(bullet.raw.slice(3, 60))}`).join(" / ")}`);

    // ── 地板：只能升不能降（前提是「同一节」；面挪走了就必须点名重测，不许静默按旧数判）──
    const counts = `（中文 ${problems.cn.length} / 英文 ${problems.en.length} / 无对应 `
      + `${problems.unpairedCn.length + problems.unpairedEn.length} 条）`;
    const floorMessage = onFloorSurface
      ? `配对地板被踩穿：实测 ${problems.pairs.length} 对 < 地板 ${CHANGELOG_PAIR_FLOOR} 对${counts}——`
        + "少了一条英文对应，或者它的 issue 引用被改了（配对判据靠 issue 引用逐字相等）。地板只许抬、不许降"
      : `配对地板被踩穿：实测 ${problems.pairs.length} 对 < 地板 ${CHANGELOG_PAIR_FLOOR} 对${counts}；`
        + `面已挪到 ${problems.surface.heading}，请重测地板`
        + `（地板 ${CHANGELOG_PAIR_FLOOR} 是在 ${CHANGELOG_PAIR_FLOOR_SURFACE} 上实测的，`
        + "扫描面已由 resolveChangelogScanSurface 换到另一节）——这是有意信号："
        + "不许下调地板、也不许把面硬钉回旧标题来换绿";
    assert.ok(problems.pairs.length >= CHANGELOG_PAIR_FLOOR, floorMessage);
    if (problems.pairs.length > CHANGELOG_PAIR_FLOOR) {
      t.diagnostic(`配对地板：实测 ${problems.pairs.length} 对 > 地板 ${CHANGELOG_PAIR_FLOOR} 对`
        + ` ⇒ 可以抬地板到 ${problems.pairs.length}`);
    }

    // ── 语言判定 / 分支不许恒真或退化成死代码 ──
    // issue #571：真实面上的条数**跟着面走**（新生节可能只有 1 对），所以「恒真 / 死代码」的证据
    // 不能挂在「真实面恰好有 N 条」上——那是成熟度。真实面只证「两侧都有真样本」，
    // 两个方向、两条分支的真样本放在**合成形状夹具**上（同一份判定函数、同一份配对逻辑）。
    assert.ok(problems.cn.length >= 1 && problems.en.length >= 1,
      `判据面上没有两侧样本（中文 ${problems.cn.length} / 英文 ${problems.en.length}）：配对会退化成数条数`);
    assert.ok(problems.en.some((bullet) => bullet.ratio === 0),
      "没有一条零 CJK 的英文条目：语言判定可能恒判中文");
    const shape = collectChangelogPairingProblems(changelogSyntheticSectionText());
    assert.equal(shape.found, true, "形状夹具上找不到判据面：这一格失去对照组");
    assert.ok(shape.cn.some((bullet) => bullet.ratio > 0.5),
      "形状夹具上没有一条 CJK 占比 > 0.5 的中文条目：语言判定可能恒判英文");
    assert.ok(shape.en.some((bullet) => bullet.ratio === 0),
      "形状夹具上没有零 CJK 的英文条目：语言判定可能恒判中文");
    // 「无 issue 引用 + 紧邻」这条分支不许是死代码（夹具里丁 / Delta 就是这一对）
    assert.ok(shape.cn.some((bullet) => bullet.issues.size === 0),
      "形状夹具里没有无 issue 引用的条目：紧邻配对那条分支退化成死代码");
    assert.ok(shape.adjacencyPairs >= 1,
      `形状夹具里「无 issue 引用 + 紧邻」一对都没配上（实测 ${shape.adjacencyPairs} 对）：那条分支是死的`);
    assert.ok(shape.cn.some((bullet) => bullet.issues.size > 1),
      "形状夹具里没有引用多个 issue 的中文条目：集合比较退化成单值比较");
    assert.deepEqual(shape.unpairedCn.map((bullet) => bullet.line), [], "形状夹具的中文条目有缺译本的");
    assert.deepEqual(shape.unpairedEn.map((bullet) => bullet.line), [], "形状夹具的英文条目有缺译本的");
    assert.equal(shape.pairs.length, shape.cn.length, "形状夹具里每条中文条目都应有英文对应");

    // ── 三条反向证（纯内存，不写盘；变异没落上由 replaceExactlyOnce 直接抛，沿用 #210 R2 口径） ──
    // 靶子必须**双侧唯一**（该 issue 集合在中文侧与英文侧各只出现一次）：否则删掉一条英文之后，
    // 贪心配对会把那条中文改配给另一条同集合的英文，反向证就证不到「它自己少了对应」。
    const setCount = (list, key) => list.filter((bullet) => [...bullet.issues].sort().join(",") === key).length;
    const target = problems.pairs.find((pair) => pair.byIssueSet
      && setCount(problems.cn, pair.issues.join(",")) === 1
      && setCount(problems.en, pair.issues.join(",")) === 1);
    assert.ok(target, "找不到「issue 集合双侧唯一」的配对靶子：反向证会退化成恒绿或落到会改配的集合上");
    const targetEn = problems.en.find((bullet) => bullet.line === target.en);
    assert.ok(targetEn, `配对记录里的英文条目 ${target.en} 行找不到：配对表与解析面不一致`);
    const targetCn = problems.cn.find((bullet) => bullet.line === target.cn);
    assert.ok(targetCn, `配对记录里的中文条目 ${target.cn} 行找不到：配对表与解析面不一致`);
    assert.ok(target.issues.length > 0, "靶子的 issue 集合为空：这一格会退化成恒真");

    // 反向证 ①：删掉一条英文条目 ⇒ 配对下降、它的中文对手变成「无对应」
    const deleted = replaceExactlyOnce(text, `${targetEn.raw}\n`, "", "英文条目靶子");
    const afterDelete = collectChangelogPairingProblems(deleted);
    assert.equal(afterDelete.pairs.length, problems.pairs.length - 1,
      `删掉一条英文条目后配对数应减 1，实测 ${afterDelete.pairs.length}（原 ${problems.pairs.length}）`);
    assert.equal(afterDelete.unpairedCn.length, 1,
      `删掉一条英文条目后应恰好 1 条中文无对应，实测 ${JSON.stringify(afterDelete.unpairedCn.map((b) => b.line))}`);
    // 行号在删掉多行英文条目后会整体前移，所以按**原文**认人，不按行号
    assert.equal(afterDelete.unpairedCn[0].raw, targetCn.raw, "无对应的那条中文应是靶子的对手（按原文比）");
    // 「地板拦不住」只在**校准面**上有意义：地板恰等于那一节实测的配对数 ⇒ 掉一条就穿底。
    // 面挪走后地板本来就没有校准依据（#563 的「请重测地板」信号正是为此而设），拿旧地板去判新面
    // 只会造出一条与面无关的假红——所以那一半只在校准面上判，挪面时由上面的地板判词点名重测。
    if (onFloorSurface) {
      assert.equal(problems.pairs.length, CHANGELOG_PAIR_FLOOR,
        `校准面（${CHANGELOG_PAIR_FLOOR_SURFACE}）上实测 ${problems.pairs.length} 对 ≠ 地板 ${CHANGELOG_PAIR_FLOOR} 对：`
        + "地板必须恰等于校准面上的实测值（否则「掉一条就穿底」证不出来）。配对变多了 ⇒ 请抬地板到实测值");
      assert.ok(afterDelete.pairs.length < CHANGELOG_PAIR_FLOOR,
        `删掉一条英文条目后配对数 ${afterDelete.pairs.length} 仍 >= 地板 ${CHANGELOG_PAIR_FLOOR}：地板拦不住`);
    } else {
      t.diagnostic(`地板拦截力：本面 ${problems.pairs.length} 对 / 地板 ${CHANGELOG_PAIR_FLOOR} 对`
        + `（校准面 ${CHANGELOG_PAIR_FLOOR_SURFACE}）——不在校准面上，这一栏不判`);
    }

    // 反向证 ②：把英文条目里的一个 issue 引用改掉（**数量不变、值不同**）⇒ 集合不再相等 ⇒ 配对下降
    const firstIssue = target.issues[0];
    assert.equal(changelogIssueRefs(text).has("999"), false,
      "真实 CHANGELOG 里已经出现 #999：反向证 ② 的替换值不唯一，请换一个值");
    assert.ok(targetEn.raw.includes(`#${firstIssue}`), `靶子里找不到 #${firstIssue}：反向证 ② 会打空`);
    // 靶子里同一个引用可能出现多次（同一条目里既在正文又在续行里提它）：**全部**换成同一个新值，
    // 这样「个数不变、值不同」才成立；只换一处会让集合多出一个元素，证的东西就不是集合比较了。
    const rewritten = targetEn.raw.split(`#${firstIssue}`).join("#999");
    assert.notEqual(rewritten, targetEn.raw, "变异没落上：issue 引用没被改掉");
    assert.equal(changelogIssueRefs(rewritten).size, targetEn.issues.size,
      "反向证 ② 要求「数量不变、值不同」：改完之后 issue 个数变了，这一格证的东西就不是集合比较了");
    const swapped = collectChangelogPairingProblems(replaceExactlyOnce(text, `${targetEn.raw}\n`, `${rewritten}\n`, "issue 引用靶子"));
    assert.equal(swapped.pairs.length, problems.pairs.length - 1,
      `改掉一个 issue 引用后配对数应减 1，实测 ${swapped.pairs.length}（原 ${problems.pairs.length}）`);
    assert.equal(swapped.unpairedCn.length, 1, "改掉一个 issue 引用后应恰好 1 条中文无对应");
    assert.equal(swapped.unpairedCn[0].raw, targetCn.raw, "无对应的那条中文应是靶子的对手（按原文比）");
    assert.equal(swapped.unpairedEn.length, 1, "改掉一个 issue 引用后应恰好 1 条英文无对应（它就是被改的那条）");
    assert.equal(swapped.unpairedEn[0].raw, rewritten, "无对应的那条英文应是被改的那条");
    if (onFloorSurface) {
      assert.ok(swapped.pairs.length < CHANGELOG_PAIR_FLOOR,
        `改掉一个 issue 引用后配对数 ${swapped.pairs.length} 仍 >= 地板 ${CHANGELOG_PAIR_FLOOR}：地板拦不住`);
    }

    // 反向证 ③：还原 ⇒ 全绿
    const restored = collectChangelogPairingProblems(text);
    assert.equal(restored.pairs.length, problems.pairs.length, "还原原文后配对数应回到原值");
    assert.deepEqual(restored.unpairedCn, [], "还原原文后不该有中文无对应");
    assert.deepEqual(restored.unpairedEn, [], "还原原文后不该有英文无对应");
    assert.ok(restored.pairs.length >= CHANGELOG_PAIR_FLOOR, "还原原文后地板必须仍成立");

    t.diagnostic(`配对地板反向证：删掉第 ${targetEn.line} 行英文条目 ⇒ ${afterDelete.pairs.length} 对`
      + `（地板 ${CHANGELOG_PAIR_FLOOR}${onFloorSurface ? "，已穿底" : "，不在校准面上不判"}）+ 中文第 ${target.cn} 行无对应；`
      + `把该条的 #${firstIssue} 改成 #999（数量不变）⇒ ${swapped.pairs.length} 对；还原 ⇒ `
      + `${restored.pairs.length} 对全绿`);
  });
});
