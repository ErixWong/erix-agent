#!/usr/bin/env node
// agents-directive-scan.mjs — 阻塞门：**AGENTS 指令面**里不许出现「住在别处、会过期、且没有闸看守」的可变量
// （工单 #642；家族照 `scripts/retired-spelling-scan.mjs`：名单从真值推、文件清单只取 `git ls-files`、
//  文件按路径分类、`--strict` 与 `--strict --json` 共用同一份红集合、自带 `--self-test` 反向证）。
//
// 病根（#642 的原话）：`AGENTS.md` / `AGENTS_cn.md` 是**每次会话自动注入、模型不查证就照着执行**的那张面。
// 写在这张面上的三类东西不是「记录旧」，而是**被执行成错的**：
//
//   ① **工单状态句**：`#N 已落地 / 已 closed / 待做 / 挂起`（英文 `landed / closed / pending / shipped` …）。
//      状态句一旦写进指令面，它就变成**下一位的行动依据**：相信「已 closed」的人不会再去看参数面实况。
//      只许 `见 issue #N` 形式的**出处引用**（不带状态）——那种写法天然不命中本门（射程要「状态词」）。
//   ② **会过期的实测数**：`实测 1234 组` / `measured 87 declarations` 这类**抄件**。数字的正本各在代码里
//      （`BASELINE_ROOT`、`SYMBOL_ANCHOR_MIN_UNIQUE`、`npm pack --dry-run --json`），抄件没有闸、正本有。
//      正确写法是复现命令（`node scripts/docs-drift-check.mjs --verbose` 现读）。
//   ③ **裸源码行号坐标**：`src/loop/orchestrator.js:4372`。行号随上游重构整体位移，指到别的函数也照样「存在」。
//      正确写法是符号锚点（`symbol` 与它的文件），行号一律丢掉（#286 的既有规矩）。
//
// 为什么这与 CHANGELOG 不同性质：CHANGELOG 里的旧数字没人执行，错了只是历史记录旧；AGENTS 里的旧数字
// **会被执行**。所以本门的判定面只有 AGENTS 这一对，`docs/` 与 `CHANGELOG.md` 照扫照报、**不判定**
// （票面 边界：不改历史文档；它们在 `git ls-files` 清单里，所以「分类」不是空话，也证明历史一侧确实不被判死）。
//
// 三条判据（每条都能被反向证打红，见 `--self-test`）：
//   1. **分类**（`classify()`，纯路径，第一等公民）：`directive` = `AGENTS.md` / `AGENTS_cn.md`（判定）；
//      `history` = 面上其余一切（`CHANGELOG.md` + `docs/**`，只计数、只报告）。未登记路径 ⇒ **directive**
//      （未知分类不是免检：宁可多红一句，与 #560 的方向一致）。
//   2. **命中**：只在**句子**里算（`sentenceOf()`：`。；！？` 与 `. ` 断句）——一条命中 = 一句里同时出现
//      「工单号 + 状态词」（A 类）/「实测动词 + 数字」（B 类）/ 一个裸 `src/…js:N` 坐标（C 类）。
//      只按 token 判、不按「这词看着像不像散文」判：判据必须是机械的，否则下一个读者没法复现。
//   3. **例外必须是显式登记表 + 理由**（`EXEMPTIONS`），且**空转条目即红**（#210 R2）：一条例外在指令面上
//      一处也没命中 ⇒ `IDLE`。今天登记三条，每条都是票面点名的合法类：
//        · `gate-owned-constant`：常量真值住在门禁脚本里（`BASELINE_ROOT = 108` 那一类），AGENTS 只复述
//          名字与值。本例外**当场对账**：句子里的 `NAME = N` 必须等于 `scripts/*.mjs` 里那个常量的**现值**
//          （名字清单从源码推，不抄）。漂一格就不再放行 ⇒ 它不是一个免检通道，而是一条活的核对。
//        · `historical-value-label`：句子自己标明是历史值（`Historical values` / `历史值` / `此前` /
//          `before that`）。票面允许历史值句里的数字，但历史值不许当现值用——标签就是分界线。
//        · `external-repo-coordinate`：带**登记过的**外部仓前缀（`<repo>:src/…js:N`）不是本仓坐标；仓名清单
//          从 `scripts/docs-drift-check.mjs` 的 `EXTERNAL_REPO_PREFIXES` **现读**，清单外的仓名照样红。
//   4. **存量欠账**（`DEBT_CEILINGS`）：本票**只建闸、不清账**（票面原话：别一上来清零，那会让本批其他单的
//      证据叙述变成回归）。所以每份指令面文件 × 每个类别钉一个**上限**：实测 > 上限 ⇒ 红（新写进去的
//      可变量必须改成不变式/复现命令，或者显式抬上限并在报告里说明）；实测 < 上限 ⇒ 绿 + 提示
//      「可下调至 N」（棘轮方向：清账永远不红，这与 `check:types` 同口径）；上限 > 0 而实测 = 0 ⇒ **红**
//      （整条登记空转，与例外的 IDLE 同一条规矩）。
//
// 退出码三档（与家族同构，语义不许混）：
//   · `0` = 绿（红数为 0；或报告模式——那是给人读的视图，不是门）；
//   · `1` = **指令面红了**（红数 > 0 且 `--strict`）；
//   · `2` = **门自己坏了**（清单拿不到：git 不可用 / 不在仓库内 / 仓库顶层不是本脚本所在目录 / 清单为空 /
//     推不出外部仓名单或门禁常量表）。
//
// 用法：
//   node scripts/agents-directive-scan.mjs                 # 全量报告，exit 0（人读视图）
//   node scripts/agents-directive-scan.mjs --json           # 同一份事实的机器读法（含 `gate` 段）
//   node scripts/agents-directive-scan.mjs --strict         # 门禁：红数 > 0 ⇒ exit 1；清单拿不到 ⇒ exit 2
//   node scripts/agents-directive-scan.mjs --strict --json  # 同一道门，机器读法（红集合与退出码同源）
//   node scripts/agents-directive-scan.mjs --self-test      # 反向证：临时树副本上改一处 ⇒ 红、还原 ⇒ 绿

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF_PATH), "..");
// 旗标**不在模块顶层解析**（同家族 #575 A）：`runCli({ argv })` 每次运行自己解析，自测才能在同一进程里
// 分别跑「带 --strict」与「不带 --strict」两条路。

// ── 1. 射程三类（判据的**唯一**一份定义） ─────────────────────────────────────
/** 类别 id → 人话（报告、JSON、报错文案共用一份，别在别处再抄一遍）。 */
export const CATEGORIES = Object.freeze({
  A: "工单状态句（`#N` + 状态词）",
  B: "会过期的实测数（实测 / measured + 数字）",
  C: "裸源码行号坐标（`src/…js:N`）",
});

/**
 * A 类的状态词。中文侧收票面点名的四个（已落地 / 已 closed / 待做 / 挂起）加同义的两个；
 * 英文侧收同一件事的说法——AGENTS.md 是英文的，只咬中文等于只咬半边（中英必须成对，判据也得成对）。
 *
 * 边界用显式字符类而不是 `\b`：`pendingToolUse` / `pendingTailToolUses` 是**符号名**，不是状态词，
 * `pending-` 后面接反引号才是状态叙述。`\b` 在中文里没有意义，两侧都靠字符类兜住。
 */
const STATUS_RE = new RegExp([
  "已\\s*落地", "已落地", "已交付", "已完成", "已合并", "已关闭", "已\\s*closed",
  "待做", "待办", "挂起", "不再做",
  "(?:^|[^\\w])(?:landed|closed|delivered|shipped|merged|pending|todo|on\\s+hold|in\\s+progress)(?:[^\\w]|$)",
].join("|"), "i");

/** B 类的实测动词（「抄件」的标记词）。 */
const MEASURE_RE = /实测|复测|measured|re-measured/i;

/** C 类的坐标：可选的 `<外仓名>:` 前缀 + `src/…js:` + 行号。 */
const COORD_RE = /(?:([a-z][a-z0-9_-]{1,30}):)?(src\/[A-Za-z0-9_./-]*\.js):(\d+)/g;

/** 历史值标签（`historical-value-label` 例外的判据；票面：历史值句里的数字放行，但历史值不许当现值用）。 */
const HISTORICAL_MARKER = /历史值|历史记录|此前|再此前|before that|Historical values?|historical value|earlier counts|at that time|当时/i;

/** 一句话里有没有工单号（`#123`）。 */
const ISSUE_RE = /(?:^|[^\w&])#\d+\b/;

/**
 * 把一行切成句子（带行号）。命中按句子算、不按行算：一行里可以既有一句合法的复现命令、又有一句状态断言。
 *
 * 断句规则（够用即可，不做 NLP）：`。；！？` 之后断；`. ` 之后断（`0.28.0` / `e.g.` 这类没有空格，不误断）。
 * Markdown 表格行没有句号 ⇒ 整行就是一句（宁可多红一句，方向与 #560 的「未知分类不是免检」一致）。
 */
export function sentenceOf(line) {
  const out = [];
  let start = 0;
  const push = (end) => {
    if (end > start) out.push(line.slice(start, end));
    start = end;
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ("。；！？".includes(ch)) {
      push(i + 1);
      continue;
    }
    if ((ch === "." || ch === "!" || ch === "?") && /[ \t]/.test(line[i + 1] ?? "")) {
      push(i + 1);
    }
  }
  push(line.length);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * 一份文本的命中（纯函数：同一份判据被报告、JSON、自测三处共用）。
 *
 * @param {string} text
 * @returns {Array<{line: number, category: "A"|"B"|"C", text: string, sentence: string, prefix: string|null}>}
 */
export function scanText(text) {
  const hits = [];
  text.split("\n").forEach((line, index) => {
    const lineNo = index + 1;
    for (const sentence of sentenceOf(line)) {
      if (ISSUE_RE.test(sentence) && STATUS_RE.test(sentence)) {
        hits.push({ line: lineNo, category: "A", text: sentence.match(ISSUE_RE)?.[0]?.trim() ?? "", sentence, prefix: null });
      }
      if (MEASURE_RE.test(sentence) && /\d/.test(sentence)) {
        hits.push({ line: lineNo, category: "B", text: sentence.slice(0, 80), sentence, prefix: null });
      }
    }
    for (const m of line.matchAll(COORD_RE)) {
      const [raw, prefix, file, digits] = m;
      const at = m.index ?? 0;
      const before = at === 0 ? "" : line[at - 1];
      // token 边界：`foo/src/x.js:1` 与 `pi-subagents:src/x.js:1` 里的 `src/` 不是本仓路径的开头
      if (prefix === undefined && /[\w/.:-]/.test(before)) continue;
      if (prefix !== undefined && /[\w/.:-]/.test(before)) continue;
      hits.push({
        line: lineNo,
        category: "C",
        text: raw,
        sentence: line.trim(),
        prefix: prefix ?? null,
        file,
        digits: Number(digits),
      });
    }
  });
  return hits;
}

// ── 2. 分类表（第一等公民，纯路径） ───────────────────────────────────────────
/** 指令面：每次会话自动注入、模型不查证就照着执行的那一对文件（工单 #642）。 */
export const DIRECTIVE_FILES = Object.freeze(["AGENTS.md", "AGENTS_cn.md"]);

/**
 * 一份文件属于哪一档（纯路径，不看内容）。
 *
 * 两分沿用家族口径：
 *   · `directive` = **现状描述**（该改）：就是 AGENTS 这一对——它教的是「现在该怎么做」；
 *   · `history` = **历史记录**（正文一字不改）：面上其余一切（`CHANGELOG.md` + `docs/**`），写的是
 *     「当时发生的事」。票面 边界 明写本轮不改历史文档与契约，所以它们只计数、只报告，不进判据。
 *
 * **未登记路径 ⇒ `directive`**：未知分类不是免检（与 #560 拆掉 `out-of-scope` 同一条方向）。
 */
export function classify(rel) {
  // 指令面按**文件名形状**认，不是按一张写死的清单：`AGENTS_cn.md` 今天在册，将来多一份 `AGENTS_xx.md`
  // 也自动进判定面（新语言的文件不许因为「没登记」而免检）。
  if (/^AGENTS(?:_[a-z]{2})?\.md$/.test(rel)) {
    return { kind: "directive", why: "指令面：每次会话自动注入、模型不查证就照着执行（issue #642 的判定面）" };
  }
  if (rel === "CHANGELOG.md") {
    return { kind: "history", why: "历史记录：CHANGELOG 写的是当时发布/当时为真，没人照它执行（票面 边界）" };
  }
  if (rel.startsWith("docs/")) {
    return { kind: "history", why: "历史/非指令面文档：docs/ 的正文是当时的记录（票面 边界：本轮不改），只计数不判定" };
  }
  // 面上剩下的一切（未登记路径）⇒ **directive**：未知分类不是免检（与 #560 拆掉 `out-of-scope` 同一方向）。
  return { kind: "directive", why: "未登记路径 ⇒ 按指令面扫（未知分类不是免检：宁可多红一句）" };
}

// ── 3. 例外登记表（显式 + 理由；空转条目即红） ────────────────────────────────
/**
 * 门禁常量表的对账（`gate-owned-constant` 例外的判据）。
 *
 * 一句话里出现 `NAME = N`（可带反引号），且 `NAME` 是 `scripts/*.mjs` 里**真的声明过**的数值常量：
 *   · `N` 等于源码现值 ⇒ 放行（这就是票面点名的合法例外：「常量 + 有门禁对账」）；
 *   · `N` 与现值不一致 ⇒ **不放行**（记成 `stale`，报告里点名——抄件过期了，它不该继续待在指令面上）；
 *   · 名字不是门禁常量 ⇒ 本例外不适用（`none`）。
 *
 * @param {string} sentence
 * @param {Map<string, {value: number, file: string}>} constants
 * @returns {{verdict: "ok"|"stale"|"none", name?: string, value?: number, truth?: number, file?: string}}
 */
export function gateConstantVerdict(sentence, constants) {
  for (const m of sentence.matchAll(/([A-Z][A-Z0-9_]{2,})\s*=\s*(\d[\d_]*)/g)) {
    const truth = constants.get(m[1]);
    if (truth === undefined) continue;
    const value = Number(m[2].replace(/_/g, ""));
    if (truth.value === value) return { verdict: "ok", name: m[1], value, truth: truth.value, constantFile: truth.file };
    return { verdict: "stale", name: m[1], value, truth: truth.value, constantFile: truth.file };
  }
  return { verdict: "none" };
}

/**
 * 例外登记表。**每条都要有 `why`**（空泛的放行等于后门，#210 R2），且必须在指令面上真的命中至少一处
 * ——一处也没命中的条目是 `IDLE`（红）：那说明判据或登记已经空转，绿是假的。
 *
 * `matches(hit, ctx)` 只判「这一条命中算不算例外」，判词与红集合在 `gateVerdicts()` 里。
 */
export const EXEMPTIONS = Object.freeze([
  {
    id: "gate-owned-constant",
    categories: Object.freeze(["B"]),
    why: "常量真值住在门禁脚本里（`BASELINE_ROOT = 108` 那一类），AGENTS 只复述名字与值；本例外**当场对账**"
      + "——句子里的 `NAME = N` 必须等于 `scripts/*.mjs` 里那个常量的现值（名字清单从源码推），漂一格就不再放行",
    matches: (hit, ctx) => gateConstantVerdict(hit.sentence, ctx.constants).verdict === "ok",
  },
  {
    id: "historical-value-label",
    categories: Object.freeze(["B"]),
    why: "句子自己标明是历史值（`Historical values` / `历史值` / `此前` / `before that`）——票面允许历史值句里的"
      + "数字，但历史值不许当现值用，所以只有带这层标签的句子放行",
    matches: (hit) => HISTORICAL_MARKER.test(hit.sentence),
  },
  {
    id: "external-repo-coordinate",
    categories: Object.freeze(["C"]),
    why: "带**登记过的**外部仓前缀（`<repo>:src/…js:N`）不是本仓坐标：路径属于另一个仓，本仓没有可核对的真值。"
      + "仓名清单从 `scripts/docs-drift-check.mjs` 的 `EXTERNAL_REPO_PREFIXES` 现读，清单外的仓名照样红",
    matches: (hit, ctx) => hit.prefix !== null && ctx.externalPrefixes.has(hit.prefix),
  },
]);

/**
 * 存量欠账的上限（**本票只建闸、不清账**，票面原话：「别一上来清零」）。
 *
 * 方向是**棘轮**：实测 ≤ 上限 ⇒ 绿（并提示「可下调至 N」——清账永远不红，与 `check:types` 同口径）；
 * 实测 > 上限 ⇒ 红（新写进去的可变量必须改成不变式 / 复现命令，或者显式抬上限并在报告里说明）；
 * 上限 > 0 而实测 = 0 ⇒ 红（整条登记空转，与例外的 `IDLE` 同一条规矩）。
 *
 * 每一格的理由写在行尾注释里：**这批数是存量**（#642 之前就在 AGENTS 里），不是「这些是可变量所以合法」。
 *
 * @type {Readonly<Record<string, Readonly<Record<"A"|"B"|"C", number>>>>}
 */
export const DEBT_CEILINGS = Object.freeze({
  "AGENTS.md": Object.freeze({
    // 18：`#N … landed` 的历史流水账（「again to 122 when #438's … section landed as an EN/CN pair」那一族）。
    // 它们是**当时为真**的叙述，本票不清账（票面原话）；新写一句状态断言就会变成 19 ⇒ 红。
    A: 18,
    // 25：`measured` 的抄件（命令表里的「measured 103 cases」「measured 0.1 s」与符号锚点那段流水账）。
    // 与上同：本票只建闸，清账留给后续票；清到 24 ⇒ 绿 + 提示「可下调至 24」。
    B: 25,
    // 0：今天一处裸坐标都没有（AGENTS 里唯一两处 `src/…js:N` 都带 `pi-subagents:` 前缀 ⇒ 走例外）。
    C: 0,
  }),
  "AGENTS_cn.md": Object.freeze({
    // 4：中文侧同一族历史流水账（「此前 issue #394 … 落成契约之后实测 109 组」），比英文侧少是因为
    // 中文侧把「landed」写成了「落成 / 落地」而不是状态词。本票不清账。
    A: 4,
    // 30：中文侧的实测抄件（符号锚点流水账比英文侧长，因为它把「此前 … 实测 N 组 / M 处」整条链留在文件里）。
    B: 30,
    // 0：同上，一处裸坐标都没有。
    C: 0,
  }),
});

// ── 4. 真值（名单从源码推，不抄） ─────────────────────────────────────────────
/**
 * 门禁常量表：`scripts/*.mjs` 里 `const NAME = <整数>;` 形态的常量。
 *
 * 为什么从源码推：手抄一份「哪些常量有门禁对账」的名单，就是又造一份会腐烂的清单（#560 的病根）。
 * 只收全大写名字 + 纯整数（`0.05` 这类比率不收：它们几乎不会出现在「实测 N」句里，收了只是放宽面）。
 *
 * @param {Array<{file: string, text: string}>} sources
 * @returns {Map<string, {value: number, file: string}>}
 */
export function gateConstantsFrom(sources) {
  const out = new Map();
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?const[ \t]+([A-Z][A-Z0-9_]{2,})[ \t]*=[ \t]*(\d[\d_]*)[ \t]*;/gm)) {
      if (!out.has(m[1])) out.set(m[1], { value: Number(m[2].replace(/_/g, "")), file });
    }
  }
  return out;
}

/**
 * 外部仓前缀名单：从 `scripts/docs-drift-check.mjs` 的 `EXTERNAL_REPO_PREFIXES` **现读**（不抄）。
 *
 * 读不到就抛错（由 `runCli` 报 exit 2）：读不到意味着这条例外在空转，而空转的例外比没有例外更糟——
 * 它看起来在放行，其实放行的是「所有带冒号的东西」。
 *
 * @param {string} text `scripts/docs-drift-check.mjs` 的正文
 * @returns {Set<string>}
 */
export function externalPrefixesFrom(text) {
  const block = text.match(/const EXTERNAL_REPO_PREFIXES = new Map\(\[([\s\S]*?)\n\]\);/);
  if (block === null) {
    throw new Error("从 `scripts/docs-drift-check.mjs` 里抽不到 `EXTERNAL_REPO_PREFIXES = new Map([...])`——"
      + "外部仓前缀这条例外失去真值来源（不许静默降级成「没有例外」）");
  }
  const names = new Set([...block[1].matchAll(/^\s*\["([^"]+)",/gm)].map((m) => m[1]));
  if (names.size === 0) {
    throw new Error("`EXTERNAL_REPO_PREFIXES` 抽出来是空的——那条例外会空转，拒绝继续");
  }
  return names;
}

// ── 5. 覆盖面（只取**入库**文件，清单 = `git ls-files`） ──────────────────────
/** 默认执行器：跑一次 git，返回 stdout（`root` 必须是仓库顶层，调用方先验过）。 */
function defaultGit(args, root) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

const MANIFEST_REFUSAL = "拒绝退回文件系统遍历：那会把不入库的文件喂给判据，让门在开发树与干净克隆里给出两个答案（#560）";

/** 把任意异常折成一行可读的原因（`execFileSync` 的 stderr 可能是 Buffer）。 */
function errorLine(error) {
  if (error?.code === "ENOENT") return "找不到 git 可执行文件";
  const raw = error?.stderr === undefined || error?.stderr === null ? error?.message : error.stderr;
  return String(raw ?? error).trim().split("\n").filter(Boolean)[0] ?? String(error);
}

/**
 * 扫描面的**显式** pathspec：AGENTS 那一对 + `CHANGELOG.md` + `docs/`。
 *
 * 为什么把 `docs/` 与 `CHANGELOG.md` 也列进来：它们是 `history` 那一档的**实物**。面里没有它们，
 * 「分类」就只是注释里的话（`history` 一份都没有 ⇒ 判据无法被反向证）；而且面必须显式列出，
 * **不是** `.`——扫描面不许偷偷变成整个仓库。
 *
 * @type {readonly string[]}
 */
export const SCAN_PATHSPECS = Object.freeze([...DIRECTIVE_FILES, "CHANGELOG.md", "docs"]);

/** 真值面：门禁常量与外部仓名单都从这里推（同样是显式 pathspec）。 */
export const TRUTH_PATHSPECS = Object.freeze(["scripts"]);

/**
 * 一份 pathspec 的**入库**文件清单（只取 `git ls-files`）。
 *
 * `git` 不可用 / 不在仓库内 / 仓库顶层不是本脚本所在目录 / 清单为空 ⇒ **抛错**，由 `runCli` 显式报
 * exit 2。**没有**文件系统回退分支：静默回退等于把「开发树与干净克隆两个答案」留在原地。
 *
 * @param {{root?: string, io?: {exec?: (args: string[], root: string) => string}, pathspecs?: readonly string[],
 *   suffix?: string|null, what?: string}} [options]
 * @returns {string[]} 仓库相对路径，已去重排序
 */
export function gitTrackedFiles({ root = ROOT, io, pathspecs = SCAN_PATHSPECS, suffix = ".md", what = "扫描清单" } = {}) {
  const exec = io?.exec ?? defaultGit;
  const refuse = (detail) => new Error(`${what}只取 \`git ls-files\`，但${detail}。${MANIFEST_REFUSAL}`);

  let top;
  try {
    top = exec(["rev-parse", "--show-toplevel"], root).trim();
  } catch (error) {
    throw refuse(`${root} 不在 git 仓库内或 git 不可用（${errorLine(error)}）`);
  }
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch (error) {
    throw refuse(`${root} 读不到（${errorLine(error)}）`);
  }
  let topReal = null;
  try {
    topReal = top === "" ? null : realpathSync(top);
  } catch {
    topReal = null;
  }
  if (topReal === null || topReal !== rootReal) {
    throw refuse(`git 认的仓库顶层是 ${top === "" ? "（空）" : top}，不是本脚本所在的 ${root}（不在仓库内 ⇒ 清单不可信）`);
  }

  let raw;
  try {
    raw = exec(["ls-files", "-z", "--cached", "--full-name", "--", ...pathspecs], root);
  } catch (error) {
    throw refuse(`\`git ls-files\` 失败（${errorLine(error)}）`);
  }
  const files = [...new Set(raw.split("\0")
    .filter((rel) => rel.length > 0 && (suffix === null || rel.endsWith(suffix)))
    .map((rel) => rel.split(path.sep).join("/")))].sort();
  if (files.length === 0) {
    throw refuse(`清单是空的（0 份入库文件 ⇒ 这道门会假绿）`);
  }
  return files;
}

// ── 6. 判定（「哪些命中算红」的**唯一**一份定义） ────────────────────────────
/**
 * 把一次扫描折成「红数」与逐类明细。**文本分支与 `--json` 分支都只读这里**（同家族 #575 A 的病根：
 * 同一套判据写两遍、其中一遍没写全 ⇒ 假绿）。
 *
 * 红集合（五条，少一条就是假绿）：
 *   · `overCeiling`：指令面上某份文件某类的实测命中 > 登记上限（新写进去的可变量）；
 *   · `idleExemptions`：登记了却在指令面上一处也没命中的例外（空转条目，#210 R2）；
 *   · `idleCeilings`：上限 > 0 而实测 = 0 的欠账格（整条登记空转，同一条规矩）；
 *   · `unregistered`：指令面上有命中却没有登记上限的文件（新入指令面却忘了钉 ⇒ 与 `UNPINNED` 同族）；
 *   · `staleConstants`：`NAME = N` 里的 N 与门禁脚本里的现值不一致（抄件过期了，例外因此不放行）。
 *
 * @param {{report: Array<object>, exemptions: ReadonlyArray<object>, ceilings: Readonly<Record<string, object>>,
 *   staleConstants?: Array<object>}} input
 * @returns {{overCeiling: Array<object>, idleExemptions: Array<object>, idleCeilings: Array<object>,
 *   unregistered: Array<object>, staleConstants: Array<object>, red: number,
 *   counts: {overCeiling: number, idleExemptions: number, idleCeilings: number, unregistered: number,
 *     staleConstants: number}, downgradable: Array<object>}}
 */
export function gateVerdicts({ report, exemptions, ceilings, staleConstants = [] }) {
  const directive = report.filter((r) => r.kind === "directive");
  const overCeiling = [];
  const unregistered = [];
  const downgradable = [];
  const idleCeilings = [];
  for (const entry of directive) {
    const row = ceilings[entry.file];
    for (const category of Object.keys(CATEGORIES)) {
      const actual = entry.counts[category];
      if (row === undefined) {
        if (actual > 0) unregistered.push({ file: entry.file, category, actual });
        continue;
      }
      const ceiling = row[category];
      if (actual > ceiling) {
        overCeiling.push({
          file: entry.file, category, actual, ceiling,
          lines: entry.hits.filter((h) => h.category === category && !h.exempt).map((h) => h.line),
        });
      } else if (actual < ceiling) {
        downgradable.push({ file: entry.file, category, actual, ceiling });
      }
      if (ceiling > 0 && actual === 0) {
        idleCeilings.push({ file: entry.file, category, ceiling });
      }
    }
  }
  const used = new Set(directive.flatMap((entry) => entry.hits.filter((h) => h.exempt).map((h) => h.exemption)));
  const idleExemptions = exemptions
    .filter((entry) => !used.has(entry.id))
    .map((entry) => ({ id: entry.id, why: entry.why }));
  const counts = {
    overCeiling: overCeiling.length,
    idleExemptions: idleExemptions.length,
    idleCeilings: idleCeilings.length,
    unregistered: unregistered.length,
    staleConstants: staleConstants.length,
  };
  const red = Object.values(counts).reduce((n, v) => n + v, 0);
  return { overCeiling, idleExemptions, idleCeilings, unregistered, staleConstants, downgradable, counts, red };
}

/**
 * 红数 → 退出码。**唯一**一处把 `--strict` 应用上去的地方（文本分支与 `--json` 分支共用）。
 * 报告模式恒 0（既有语义：那是给人读的视图）；`--strict` 下红数 0 ⇒ 0，否则 1。
 */
export function gateExitCode(gate, { strict }) {
  if (!strict) return 0;
  return gate.red === 0 ? 0 : 1;
}

// ── 7. 一次完整扫描（`root` / `io` 可注入 ⇒ 自测在临时树上跑真实路径） ────────
/**
 * 扫一次：清单 → 分类 → 命中 → 例外 → 上限 → 判词。
 *
 * @param {{root?: string, io?: object, exemptions?: ReadonlyArray<object>, ceilings?: object}} [options]
 * @returns {{manifest: string[], report: Array<object>, gate: object, constants: Map<string, object>,
 *   externalPrefixes: Set<string>, staleConstants: Array<object>}}
 */
export function scanDirectives({ root = ROOT, io, exemptions = EXEMPTIONS, ceilings = DEBT_CEILINGS } = {}) {
  const manifest = gitTrackedFiles({ root, io });
  const truthFiles = gitTrackedFiles({ root, io, pathspecs: TRUTH_PATHSPECS, suffix: ".mjs", what: "真值清单" });
  const sources = truthFiles.map((file) => ({ file, text: readFileSync(path.join(root, file), "utf8") }));
  const constants = gateConstantsFrom(sources);
  if (constants.size === 0) {
    throw new Error("`scripts/*.mjs` 里抽不到任何 `const NAME = <整数>;` 常量——`gate-owned-constant` 例外会空转");
  }
  const driftCheck = sources.find((s) => s.file === "scripts/docs-drift-check.mjs");
  if (driftCheck === undefined) {
    throw new Error("真值清单里没有 `scripts/docs-drift-check.mjs`——外部仓前缀名单没有真值来源");
  }
  const externalPrefixes = externalPrefixesFrom(driftCheck.text);

  const ctx = { constants, externalPrefixes };
  const staleConstants = [];
  const report = [];
  for (const rel of manifest) {
    let text;
    try {
      text = readFileSync(path.join(root, rel), "utf8");
    } catch (error) {
      throw new Error(`清单里的 ${rel} 读不到（${errorLine(error)}）：`
        + "`git ls-files` 列出的入库文件必须在盘上，否则扫描面与实际内容不符");
    }
    const { kind, why } = classify(rel);
    const hits = scanText(text).map((hit) => {
      const exemption = exemptions.find((entry) => entry.categories.includes(hit.category) && entry.matches(hit, ctx));
      return { ...hit, exempt: exemption !== undefined, exemption: exemption?.id ?? null };
    });
    // 抄件过期只在**指令面**上算红，且**独立于 B 类**：一句话里写着 `NAME = 999` 但没写「实测」，
    // 它照样是一份过期抄件（判据不该靠另一个类别的词才醒）。`docs/` 与 `scripts/` 里的旧数字是历史注释，
    // 没人照着执行，所以不进这里。
    if (kind === "directive") {
      text.split("\n").forEach((line, index) => {
        for (const sentence of sentenceOf(line)) {
          const verdict = gateConstantVerdict(sentence, constants);
          if (verdict.verdict === "stale") staleConstants.push({ file: rel, line: index + 1, ...verdict });
        }
      });
    }
    const counts = Object.fromEntries(Object.keys(CATEGORIES).map((c) => [c, hits.filter((h) => h.category === c && !h.exempt).length]));
    report.push({ file: rel, kind, why, hits, counts });
  }
  const gate = gateVerdicts({ report, exemptions, ceilings, staleConstants });
  return { manifest, report, gate, constants, externalPrefixes, staleConstants };
}

// ── 8. 输出（两条分支都只读 `gate`，不自己算红） ─────────────────────────────
/** 人读视图。返回值 = 退出码（由 `gateExitCode` 给；本函数不自己拼红数）。 */
function printReport({ manifest, report, gate, constants, externalPrefixes, staleConstants }, { strict }) {
  const directive = report.filter((r) => r.kind === "directive");
  const history = report.filter((r) => r.kind === "history");
  console.log(`agents-directive-scan: ${report.length} 份**入库**文件（清单 = \`git ls-files\`；`
    + `面 = AGENTS 那一对 + \`CHANGELOG.md\` + \`docs/\`，issue #642）`);
  console.log("门禁：`npm run check:agents-directives`（= --strict）在 CI 里阻塞，紧跟 `Documentation drift check` 一族；"
    + "默认模式只打报告\n");

  console.log("── 分类（第一等公民，纯路径） ──────────────────────────────────");
  console.log(`  directive    ${String(directive.length).padStart(3)} 份  ${directive.map((r) => r.file).join(", ")}`);
  console.log(`  history      ${String(history.length).padStart(3)} 份  （CHANGELOG + docs/，只计数、不判定）`);
  console.log(`  真值来源：门禁常量 ${constants.size} 个（\`scripts/*.mjs\` 现读）、`
    + `外部仓前缀 ${externalPrefixes.size} 个（\`scripts/docs-drift-check.mjs\` 现读：${[...externalPrefixes].join(" / ")}）\n`);

  console.log("── 射程三类 × 指令面（非例外命中数） ──────────────────────────");
  for (const entry of directive) {
    const cells = Object.keys(CATEGORIES).map((c) => `${c}=${entry.counts[c]}`).join("  ");
    const exempt = entry.hits.filter((h) => h.exempt).length;
    console.log(`  ${entry.file}  ${cells}  （例外放行 ${exempt} 处）`);
  }
  console.log("  A = 工单状态句；B = 会过期的实测数；C = 裸源码行号坐标（口径见文件头）\n");

  const exemptHits = directive.flatMap((entry) => entry.hits.filter((h) => h.exempt).map((h) => ({ ...h, file: entry.file })));
  console.log("── 例外登记表（每条都必须在指令面上真的命中；空转即红） ──────────");
  for (const entry of EXEMPTIONS) {
    const used = exemptHits.filter((h) => h.exemption === entry.id);
    console.log(`  ${used.length === 0 ? "✗" : "✓"} ${entry.id}（${entry.categories.join("/")}）—— `
      + `${used.length} 处：${used.slice(0, 4).map((h) => `${h.file}:${h.line}`).join(", ")}${used.length > 4 ? " …" : ""}`);
    console.log(`      ${entry.why}`);
  }
  if (staleConstants.length > 0) {
    console.log("  ⚠ 常量抄件与源码现值不一致（例外因此不放行）：");
    for (const s of staleConstants) {
      console.log(`    ${s.file}:${s.line}  \`${s.name} = ${s.value}\` ≠ 源码现值 ${s.truth}（真值在 ${s.constantFile}）`);
    }
  }

  console.log("\n── 存量欠账（本票只建闸、不清账：棘轮方向） ────────────────────");
  for (const entry of directive) {
    const row = DEBT_CEILINGS[entry.file] ?? {};
    const cells = Object.keys(CATEGORIES).map((c) => `${c}: ${entry.counts[c]} / 上限 ${row[c] ?? "（未登记）"}`).join("；");
    console.log(`  ${entry.file}  ${cells}`);
  }
  for (const d of gate.downgradable) {
    console.log(`  ↓ ${d.file} ${d.category} 类实测 ${d.actual} < 上限 ${d.ceiling}——存量在变少，可把上限降到 ${d.actual}`);
  }

  if (gate.red > 0) {
    console.log("\n── 红（每条都点名文件 + 行） ─────────────────────────────────");
    for (const v of gate.overCeiling) {
      console.log(`  ✗ ${v.file}  ${v.category} 类（${CATEGORIES[v.category]}）实测 ${v.actual} > 上限 ${v.ceiling}`
        + `  ⇒ 行 ${v.lines.join(", ")}`);
      console.log("      改成不变式或复现命令（`node scripts/agents-directive-scan.mjs` 现读）；确属存量才抬上限，并在报告里说明");
    }
    for (const v of gate.unregistered) {
      console.log(`  ✗ ${v.file}  ${v.category} 类有 ${v.actual} 处命中，却没登记上限（新入指令面却忘了钉）`);
    }
    for (const v of gate.idleExemptions) console.log(`  ✗ 例外 \`${v.id}\` 在指令面上一处也没命中（空转条目，#210 R2）——删掉它，或修好它的判据`);
    for (const v of gate.idleCeilings) console.log(`  ✗ ${v.file} ${v.category} 类上限 ${v.ceiling} 而实测 0（整条登记空转）`);
    for (const v of gate.staleConstants) {
      console.log(`  ✗ ${v.file}:${v.line}  \`${v.name} = ${v.value}\` 与源码现值 ${v.truth}（真值在 ${v.constantFile}）不一致`
        + "——例外因此不放行：把抄件改成现值，或把数字换成复现命令");
    }
  }

  console.log("\n── 判据 ───────────────────────────────────────────────────────");
  console.log(`  ① 指令面（AGENTS 中英）三类命中：${directive.reduce((n, r) => n + r.hits.length, 0)} 处，`
    + `其中例外放行 ${exemptHits.length} 处、非例外 ${directive.reduce((n, r) => n + Object.values(r.counts).reduce((a, b) => a + b, 0), 0)} 处`);
  console.log(`  ② 历史一侧（CHANGELOG + docs/）：${history.reduce((n, r) => n + r.hits.length, 0)} 处命中——**不判定**（票面 边界）`);
  console.log(`  ③ 例外登记：${EXEMPTIONS.length} 条，空转 ${gate.counts.idleExemptions} 条`);
  console.log(`  ④ 存量欠账：${Object.keys(DEBT_CEILINGS).length} 份文件登记，超上限 ${gate.counts.overCeiling} 格、空转 ${gate.counts.idleCeilings} 格`);
  console.log(`  ⑤ 常量抄件对账：${staleConstants.length === 0 ? "全部等于源码现值" : `${staleConstants.length} 处过期`}`);

  if (strict) {
    console.log(`\n--strict: ${gate.red === 0 ? "OK — 0 处红" : `${gate.red} 处红`}`);
    return gateExitCode(gate, { strict });
  }
  console.log("\n结论：报告模式（exit 0）。门禁跑的是 `--strict`（`npm run check:agents-directives`）。");
  return gateExitCode(gate, { strict });
}

// ── 9. 自测（临时树副本 / 纯函数夹具，不碰真文档） ───────────────────────────
async function selfTest() {
  const pending = [];
  const t = (name, fn) => pending.push([name, fn]);
  const eq = (actual, expected, what) => {
    if (actual !== expected) throw new Error(`${what}: 期望 ${expected}，实测 ${actual}`);
  };

  // 夹具：把**真实**指令面 + CHANGELOG + 一份 docs 历史文档 + 全部 `scripts/*.mjs` 复制到临时树，
  // git 用注入的假执行器（真 git 已由「清单拿不到就报错」那例证过）。所有变异都落在副本上。
  const truthFiles = gitTrackedFiles({ root: ROOT, pathspecs: TRUTH_PATHSPECS, suffix: ".mjs", what: "真值清单" });
  const surface = gitTrackedFiles({ root: ROOT });
  const copyList = [...new Set([...surface, ...truthFiles])];
  const makeTree = () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "erix-directive-fixture-")));
    for (const rel of copyList) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      copyFileSync(path.join(ROOT, rel), abs);
    }
    const exec = (args) => {
      if (args[0] === "rev-parse") return `${dir}\n`;
      if (args[0] === "ls-files") {
        const pathspecs = args.slice(args.indexOf("--") + 1);
        const list = pathspecs.includes("scripts") ? truthFiles : surface;
        return list.map((rel) => `${rel}\0`).join("");
      }
      throw new Error(`夹具 git 不认识这个子命令：${args.join(" ")}`);
    };
    return { dir, io: { exec } };
  };
  /** 跑一次真实 `runCli()`，把两条输出流收进内存（自测自己的报告不许被人读视图淹没）。 */
  const runCaptured = async (argv, tree) => {
    const saved = { log: console.log, error: console.error };
    const out = [];
    const err = [];
    console.log = (...args) => out.push(args.map((a) => String(a)).join(" "));
    console.error = (...args) => err.push(args.map((a) => String(a)).join(" "));
    try {
      const code = await runCli({ argv, root: tree.dir, io: tree.io });
      return { code, stdout: out.join("\n"), stderr: err.join("\n") };
    } finally {
      console.log = saved.log;
      console.error = saved.error;
    }
  };
  const withTree = async (fn) => {
    const tree = makeTree();
    try {
      return await fn(tree);
    } finally {
      rmSync(tree.dir, { recursive: true, force: true });
    }
  };
  /** 往临时树里的一份文件追加一段（返回追加前的内容，供还原）。 */
  const append = (tree, rel, extra) => {
    const abs = path.join(tree.dir, rel);
    const before = readFileSync(abs, "utf8");
    writeFileSync(abs, `${before}\n${extra}\n`);
    return before;
  };
  const restore = (tree, rel, text) => writeFileSync(path.join(tree.dir, rel), text);

  t("放行证：真实指令面上 `--strict` 与 `--strict --json` 都绿，红数 0", () => withTree(async (tree) => {
    const text = await runCaptured(["--strict"], tree);
    eq(text.code, 0, "干净面 `--strict` 的退出码");
    const json = await runCaptured(["--strict", "--json"], tree);
    eq(json.code, 0, "干净面 `--strict --json` 的退出码");
    eq(JSON.parse(json.stdout).gate.red, 0, "干净面的红数");
  }));

  t("反向证 ①：往 AGENTS.md 塞一句「#999 已落地」⇒ 红并点名文件:行；`--strict --json` 同判；删掉 ⇒ 绿",
    () => withTree(async (tree) => {
      const before = append(tree, "AGENTS.md", "issue #999 已落地（这句话是反向证塞进去的）");
      const text = await runCaptured(["--strict"], tree);
      const json = await runCaptured(["--strict", "--json"], tree);
      const payload = JSON.parse(json.stdout);
      // 变异必须真的落上（#210 R2）：A 类命中没涨 ⇒ 下面的「非 0」证不到任何东西
      const agents = payload.files.find((f) => f.file === "AGENTS.md");
      if (agents.counts.A === 0) throw new Error("变异没落上：A 类命中仍是 0（判据抽不到这个句式）");
      eq(json.code, 1, "`--strict --json` 的退出码");
      eq(text.code, json.code, "两条输出分支的退出码必须相同");
      if (!/AGENTS\.md\s+A 类/.test(text.stdout)) throw new Error(`文本分支没点名 AGENTS.md 的 A 类红：${text.stdout.slice(-200)}`);
      if (!payload.gate.overCeiling.some((v) => v.file === "AGENTS.md" && v.category === "A")) {
        throw new Error("JSON 的红集合里没有 AGENTS.md 的 A 类");
      }
      const hit = payload.files.find((f) => f.file === "AGENTS.md").hits.find((h) => h.category === "A" && !h.exempt);
      if (!(hit.line > 0)) throw new Error("A 类命中没带行号");
      restore(tree, "AGENTS.md", before);
      eq((await runCaptured(["--strict"], tree)).code, 0, "还原后 `--strict` 的退出码");
      eq((await runCaptured(["--strict", "--json"], tree)).code, 0, "还原后 `--strict --json` 的退出码");
    }));

  t("反向证 ②：往 AGENTS.md 塞一个实测计数（「实测 1234 组」）⇒ 红；换成一模一样的登记例外 ⇒ 绿",
    () => withTree(async (tree) => {
      const before = append(tree, "AGENTS.md", "实测 1234 组（这句话是反向证塞进去的）");
      const red = await runCaptured(["--strict"], tree);
      eq(red.code, 1, "塞了裸实测数时 `--strict` 的退出码");
      if (!/B 类/.test(red.stdout)) throw new Error("文本分支没说是 B 类红");
      restore(tree, "AGENTS.md", before);

      // 换成**登记过的例外**：常量名 + 值与门禁脚本现值一致 ⇒ 放行（同一句话，只多一个活的对账）
      const withConstant = append(tree, "AGENTS.md",
        "`BASELINE_ROOT = 108` 是门禁自己持有的常量（这句话是反向证塞进去的登记例外）");
      const green = await runCaptured(["--strict"], tree);
      eq(green.code, 0, "塞了登记例外后 `--strict` 的退出码");
      const payload = JSON.parse((await runCaptured(["--strict", "--json"], tree)).stdout);
      const exempt = payload.files.find((f) => f.file === "AGENTS.md").hits.filter((h) => h.exempt);
      if (!exempt.some((h) => h.exemption === "gate-owned-constant")) {
        throw new Error("登记例外没被用上：`gate-owned-constant` 一处也没放行");
      }
      restore(tree, "AGENTS.md", withConstant);
    }));

  t("反向证 ③：常量抄件与源码现值不一致 ⇒ 例外**不放行** ⇒ 红（这不是免检通道，是活的对账）",
    () => withTree(async (tree) => {
      const before = append(tree, "AGENTS.md", "`BASELINE_ROOT = 999` 是门禁自己持有的常量（反向证：值写错）");
      const run = await runCaptured(["--strict", "--json"], tree);
      const payload = JSON.parse(run.stdout);
      if (payload.staleConstants.length === 0) throw new Error("变异没落上：抄件过期没被报出来");
      eq(payload.staleConstants[0].name, "BASELINE_ROOT", "过期抄件的常量名");
      eq(payload.staleConstants[0].value, 999, "过期抄件的值");
      eq(run.code, 1, "抄件过期时 `--strict --json` 的退出码");
      restore(tree, "AGENTS.md", before);
      eq((await runCaptured(["--strict"], tree)).code, 0, "还原后的退出码");
    }));

  t("反向证 ④：登记表里留一条用不上的例外 ⇒ 红（空转条目，#210 R2）",
    () => withTree(async (tree) => {
      const ghost = { id: "zzz-never-matches", categories: ["B"], why: "反向证用的空转条目", matches: () => false };
      const saved = EXEMPTIONS;
      // 直接问判据（纯函数）：扫描面不变，只多一条谁也不命中的登记
      const { report } = scanDirectives({ root: tree.dir, io: tree.io, exemptions: [...saved, ghost] });
      const gate = gateVerdicts({ report, exemptions: [...saved, ghost], ceilings: DEBT_CEILINGS });
      if (!gate.idleExemptions.some((e) => e.id === "zzz-never-matches")) {
        throw new Error("空转的例外没被判红：登记表里的死条目会一直是假的绿");
      }
      eq(gate.counts.idleExemptions, 1, "空转例外的条数");
      eq(gateExitCode(gate, { strict: true }), 1, "空转例外在门禁下的退出码");
      // 反向：把它删掉 ⇒ 绿（证明上面那条红是它带来的，不是恒红）
      const clean = gateVerdicts({ report, exemptions: saved, ceilings: DEBT_CEILINGS });
      eq(clean.counts.idleExemptions, 0, "删掉空转条目后的空转数");
      eq(gateExitCode(clean, { strict: true }), 0, "删掉空转条目后的退出码");
    }));

  t("反向证 ⑤：往 AGENTS_cn.md 塞裸坐标 `src/loop/orchestrator.js:4372` ⇒ 红；塞带登记前缀的外仓坐标 ⇒ 绿",
    () => withTree(async (tree) => {
      const before = append(tree, "AGENTS_cn.md", "看 `src/loop/orchestrator.js:4372` 那一行（反向证塞进去的）");
      const red = await runCaptured(["--strict", "--json"], tree);
      const payload = JSON.parse(red.stdout);
      const hits = payload.files.find((f) => f.file === "AGENTS_cn.md").hits.filter((h) => h.category === "C");
      if (!hits.some((h) => !h.exempt && h.text.includes("orchestrator.js:4372"))) {
        throw new Error("变异没落上：裸坐标没被报出来");
      }
      eq(red.code, 1, "裸坐标下 `--strict --json` 的退出码");
      restore(tree, "AGENTS_cn.md", before);

      const withPrefix = append(tree, "AGENTS_cn.md", "看 `pi-subagents:src/runs/background/async-execution.js:9`（反向证）");
      eq((await runCaptured(["--strict"], tree)).code, 0, "带登记前缀的外仓坐标必须绿");
      // 未登记的前缀不是免检票：同一个形状换个仓名 ⇒ 红
      restore(tree, "AGENTS_cn.md", withPrefix);
      const bogus = append(tree, "AGENTS_cn.md", "看 `zzz-repo:src/loop/orchestrator.js:9`（反向证：未登记前缀）");
      eq((await runCaptured(["--strict"], tree)).code, 1, "未登记外部仓前缀必须红");
      restore(tree, "AGENTS_cn.md", bogus);
      eq((await runCaptured(["--strict"], tree)).code, 0, "还原后必须绿");
    }));

  t("分类不是空话：同一句塞进 CHANGELOG.md / docs 历史文档 ⇒ 绿（历史一侧只计数、不判定）",
    () => withTree(async (tree) => {
      const changelog = append(tree, "CHANGELOG.md", "issue #999 已落地；实测 1234 组");
      eq((await runCaptured(["--strict"], tree)).code, 0, "CHANGELOG 里的同一句式必须绿");
      const payload = JSON.parse((await runCaptured(["--strict", "--json"], tree)).stdout);
      const entry = payload.files.find((f) => f.file === "CHANGELOG.md");
      eq(entry.kind, "history", "CHANGELOG.md 的分类");
      if (entry.hits.length === 0) throw new Error("变异没落上：CHANGELOG 里一处命中都没抽到");
      restore(tree, "CHANGELOG.md", changelog);

      const doc = append(tree, "docs/decisions/001-config-adapters.md", "issue #999 已落地；实测 1234 组");
      eq((await runCaptured(["--strict"], tree)).code, 0, "docs 历史文档里的同一句式必须绿");
      restore(tree, "docs/decisions/001-config-adapters.md", doc);
    }));

  t("存量欠账是棘轮：实测 < 上限 ⇒ 绿（清账永不红）+ 提示可下调；上限 > 0 而实测 0 ⇒ 红",
    () => {
      const report = [{ file: "AGENTS.md", kind: "directive", counts: { A: 0, B: 0, C: 0 }, hits: [] }];
      const ceilings = { "AGENTS.md": { A: 3, B: 0, C: 0 } };
      const gate = gateVerdicts({ report, exemptions: EXEMPTIONS, ceilings });
      eq(gate.counts.overCeiling, 0, "实测 0 < 上限 3 时的超上限数");
      eq(gate.downgradable.length, 1, "可下调的格数");
      eq(gate.counts.idleCeilings, 1, "上限 3 而实测 0 ⇒ 空转 1 格");
      if (gate.red === 0) throw new Error("空转的上限必须算红（否则登记表可以永远挂着没人用的数）");
      const raised = gateVerdicts({
        report: [{ file: "AGENTS.md", kind: "directive", counts: { A: 4, B: 0, C: 0 }, hits: [] }],
        exemptions: EXEMPTIONS, ceilings,
      });
      eq(raised.counts.overCeiling, 1, "实测 4 > 上限 3 时的超上限数");
      // 未登记上限的指令面文件（新入指令面却忘了钉）⇒ 红
      const unpinned = gateVerdicts({
        report: [{ file: "AGENTS_xx.md", kind: "directive", counts: { A: 1, B: 0, C: 0 }, hits: [] }],
        exemptions: EXEMPTIONS, ceilings,
      });
      eq(unpinned.counts.unregistered, 1, "未登记上限的条数");
    });

  t("清单拿不到就报错退出：git 不可用 / 不在仓库内 / 空清单，都不许退回文件系统遍历", () => {
    const boom = () => {
      const error = new Error("spawnSync git ENOENT");
      error.code = "ENOENT";
      throw error;
    };
    const cases = [
      ["git 不在 PATH", { exec: boom }, /不在 git 仓库内|找不到 git/],
      ["仓库顶层不是本脚本所在目录", { exec: (args) => (args[0] === "rev-parse" ? "/somewhere/else\n" : "") }, /不是本脚本所在的/],
      ["`git ls-files` 失败", { exec: (args) => {
        if (args[0] === "rev-parse") return `${ROOT}\n`;
        throw new Error("fatal: bad pathspec");
      } }, /git ls-files/],
      ["空清单", { exec: (args) => (args[0] === "rev-parse" ? `${ROOT}\n` : "") }, /清单是空的/],
    ];
    for (const [what, io, expected] of cases) {
      let thrown = null;
      try {
        gitTrackedFiles({ root: ROOT, io });
      } catch (error) {
        thrown = error;
      }
      if (thrown === null) throw new Error(`${what}：没报错（静默退回文件系统遍历了）`);
      if (!expected.test(thrown.message)) throw new Error(`${what}：报错没说清原因（${thrown.message}）`);
      if (!/拒绝退回文件系统遍历/.test(thrown.message)) throw new Error(`${what}：报错没声明「不回退」（${thrown.message}）`);
    }
    // 放行证：真 git 在真仓库里跑得通（否则上面四条只是「永远有话说」）
    if (gitTrackedFiles({ root: ROOT }).length === 0) throw new Error("真仓库里清单是空的：判据失效");
  });

  t("分类按路径：AGENTS* 与未登记路径 ⇒ directive（未知分类不是免检），CHANGELOG 与 docs/ ⇒ history", () => {
    for (const rel of ["AGENTS.md", "AGENTS_cn.md", "AGENTS_xx.md", "NOTES.md"]) {
      eq(classify(rel).kind, "directive", rel);
    }
    for (const rel of ["CHANGELOG.md", "docs/zzz-unknown.md", "docs/decisions/001-config-adapters.md",
      "docs/host-consumer-contract.md"]) {
      eq(classify(rel).kind, "history", rel);
    }
    // 未登记路径不是免检：它进的是**判定面**，而判定面上没登记上限的文件由 `unregistered` 判红
    eq(classify("NOTES.md").why.includes("未登记"), true, "未登记路径的分类理由要点明它为什么进判定面");
  });

  t("断句与 token 边界：`pendingToolUse` 不是状态词，`foo/src/x.js:1` 不是本仓坐标", () => {
    eq(scanText("issue #1 landed as a pair").length, 1, "英文状态句");
    eq(scanText("`pendingToolUse` 是符号名").length, 0, "符号名里的 pending 不算");
    eq(scanText("见 issue #642（出处引用，不带状态）").filter((h) => h.category === "A").length, 0, "纯出处引用不算");
    eq(scanText("看 `test/src/x.js:12`").filter((h) => h.category === "C").length, 0, "长路径里的 src 不算");
    eq(scanText("看 `src/x.js:12`").filter((h) => h.category === "C").length, 1, "裸坐标算一处");
    // 一行两句：一句是状态断言、一句是复现命令 ⇒ 只红前一句（按句子判，不按行判）
    const mixed = scanText("issue #7 已落地。跑 `node scripts/x.mjs` 现读").filter((h) => h.category === "A");
    eq(mixed.length, 1, "一行里的状态句只算一处");
  });

  t("真值从源码推：门禁常量表非空且含 `BASELINE_ROOT`，外部仓前缀名单非空（否则例外在空转）", () => {
    const sources = truthFiles.map((file) => ({ file, text: readFileSync(path.join(ROOT, file), "utf8") }));
    const constants = gateConstantsFrom(sources);
    if (constants.size === 0) throw new Error("门禁常量表是空的");
    if (!constants.has("BASELINE_ROOT")) throw new Error("门禁常量表里没有 `BASELINE_ROOT`：真值没推到");
    const prefixes = externalPrefixesFrom(sources.find((s) => s.file === "scripts/docs-drift-check.mjs").text);
    if (prefixes.size === 0) throw new Error("外部仓前缀名单是空的");
    // 抽不到就抛错（不许静默降级成「没有例外」）
    let thrown = null;
    try {
      externalPrefixesFrom("const NOT_IT = 1;");
    } catch (error) {
      thrown = error;
    }
    if (thrown === null) throw new Error("抽不到 `EXTERNAL_REPO_PREFIXES` 时没有抛错");
  });

  const cases = [];
  for (const [name, fn] of pending) {
    try {
      await fn();
      cases.push([true, name]);
    } catch (error) {
      cases.push([false, `${name} — ${error.message}`]);
    }
  }
  const failed = cases.filter(([ok]) => !ok);
  for (const [ok, name] of cases) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  console.log(`\nagents-directive-scan --self-test: ${failed.length === 0 ? `OK — ${cases.length} 例反向证/放行证全部按预期` : `${failed.length} 例失败`}`);
  return failed.length === 0 ? 0 : 1;
}

// ── 10. main ─────────────────────────────────────────────────────────────────
/**
 * 一次 CLI 运行。`root` / `io` 可注入 ⇒ 自测能在**临时树**上把真实路径（清单 → 分类 → 命中 → 例外 →
 * 上限 → 判词 → 退出码）整条跑一遍，不碰真文档、也不假造判词。
 *
 * @param {{argv?: string[], root?: string, io?: {exec?: (args: string[], root: string) => string}}} [options]
 * @returns {Promise<number>} 进程退出码
 */
export async function runCli({ argv = process.argv.slice(2), root = ROOT, io } = {}) {
  const strict = argv.includes("--strict");
  const jsonOut = argv.includes("--json");
  const selfTestMode = argv.includes("--self-test");

  if (selfTestMode) return selfTest();

  let scan;
  try {
    scan = scanDirectives({ root, io });
  } catch (error) {
    console.error(`agents-directive-scan: ${error.message}`);
    console.error(`  仓库根：${root}`);
    return 2;
  }
  const { gate, manifest, report, constants, externalPrefixes, staleConstants } = scan;
  const exitCode = gateExitCode(gate, { strict });

  if (jsonOut) {
    const slim = report.map((r) => ({
      file: r.file, kind: r.kind, counts: r.counts,
      hits: r.hits.map((h) => ({
        line: h.line, category: h.category, exempt: h.exempt, exemption: h.exemption, text: h.text,
      })),
    }));
    console.log(JSON.stringify({
      surface: { source: "git ls-files", pathspecs: SCAN_PATHSPECS, files: manifest.length },
      gate: {
        strict,
        gating: strict,
        mode: strict ? "gate" : "report",
        red: gate.red,
        counts: gate.counts,
        exitCode,
        // 「红数 > 0 ⇒ 非 0」在两种模式下都成立：`exitCode` 是**这一次运行**的退出码（报告模式恒 0，
        // 既有语义），`wouldExitCode` 是**同一份红数在门禁下**的退出码。两个字段都只从 `gateExitCode()` 来。
        wouldExitCode: gateExitCode(gate, { strict: true }),
        exitCodes: { clean: 0, red: 1, manifestUnavailable: 2 },
        overCeiling: gate.overCeiling,
        idleExemptions: gate.idleExemptions,
        idleCeilings: gate.idleCeilings,
        unregistered: gate.unregistered,
        downgradable: gate.downgradable,
      },
      exemptions: EXEMPTIONS.map((e) => ({ id: e.id, categories: e.categories, why: e.why })),
      ceilings: DEBT_CEILINGS,
      constants: Object.fromEntries([...constants].map(([name, v]) => [name, v.value])),
      externalPrefixes: [...externalPrefixes],
      staleConstants,
      files: slim,
    }, null, 2));
    if (exitCode !== 0) {
      console.error(`agents-directive-scan --strict --json: ${gate.red} 处红`
        + `（超上限 ${gate.counts.overCeiling} / 空转例外 ${gate.counts.idleExemptions}`
        + ` / 空转上限 ${gate.counts.idleCeilings} / 未登记 ${gate.counts.unregistered}`
        + ` / 抄件过期 ${gate.counts.staleConstants}）`);
    }
    return exitCode;
  }
  return printReport(scan, { strict });
}

// 入口：本文件是 CLI（被 `import` 时也照旧跑一遍）。退出码走 `process.exitCode`，不用 `process.exit()`——
// 后者会跳过 stdout 的冲刷，`--json` 的大段输出可能被截断。
process.exitCode = await runCli();
