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
import { dirname, join, relative, resolve } from "node:path";
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
