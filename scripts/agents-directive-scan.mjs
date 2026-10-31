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
//      ⚠ 票面 ② 写的是「**带日期**的实测句」，而同一张票的验收又要求无日期的「实测 1234 组」也红 ——
//      两处冲突，按更严的一边落地：日期只是这一类的**一种**形状，无日期反而更危险（它读起来就是现值），
//      所以判据不要求日期。这条取舍写在 `--strict` 的报告里，也写在交付报告的「取证边界」里。
//   ③ **裸源码行号坐标**：`src/loop/orchestrator.js:4372`。行号随上游重构整体位移，指到别的函数也照样「存在」。
//      正确写法是符号锚点（`symbol` 与它的文件），行号一律丢掉（#286 的既有规矩）。
//
// 为什么这与 CHANGELOG 不同性质：CHANGELOG 里的旧数字没人执行，错了只是历史记录旧；AGENTS 里的旧数字
// **会被执行**。所以本门的判定面只有 AGENTS 这一对，`docs/` 与 `CHANGELOG.md` 照扫照报、**不判定**
// （票面 边界：不改历史文档；它们在 `git ls-files` 清单里，所以「分类」不是空话，也证明历史一侧确实不被判死）。
//
// 四条判据（每条都能被反向证打红，见 `--self-test`）：
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
//   node scripts/agents-directive-scan.mjs --self-test      # 反向证：**合成树夹具**上注入 `上限 − 实测 + 1` 条 ⇒ 红、还原 ⇒ 绿；
//                                                          #   同一套用例在三种欠账形态（贴上限 / 余量 +1 / 余量 +5）下裁决必须相同
//   node scripts/agents-directive-scan.mjs --sync   <文件>  # 刷上限表（**唯一合法**的改上限方式；手改数字即红，issue #644 ②）
//   node scripts/agents-directive-scan.mjs --verify <文件>  # 验上限表：逐格与实测比，不改文件；不一致 ⇒ exit 1 并点名
//                                                          #   用法（门禁跑的是 `--strict` + 这一条）见 `npm run check:agents-directives`

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    // 20：`#N … landed` 的历史流水账（「again to 122 when #438's … section landed as an EN/CN pair」那一族）。
    // 它们是**当时为真**的叙述，本票不清账（票面原话）；新写一句状态断言就会变成 21 ⇒ 红。
    // 2026-10-31 波次 4 合入时 18 → 20：#375 与 #308 各自往符号锚点声称链加了一条**链项**
    // （链项的既定句式就是「… landed as an EN/CN pair」，不是新写工单状态断言）。
    // 抬上限的正当理由就是这一种：存量本身在长。真正该做的是把整条链搬出指令面（已记在 #642 残留）。
    A: 20,
    // 25：`measured` 的抄件（命令表里的「measured 103 cases」「measured 0.1 s」与符号锚点那段流水账）。
    // 与上同：本票只建闸，清账留给后续票；清到 24 ⇒ 绿 + 提示「可下调至 24」。
    // 24：原登记 25。2026-10-31 合入 #429 / #286 时本面多出两处新抄件（导出清点句、裸行号句），
    // 按扫描器自己的提示走**改写法**而非抬上限：两句都改成「数字由那条命令现算输出、不在本文抄」
    // （见 commit）⇒ 实测回到 24，上限随之降到 24。再清一条就跟着降（它会打印「可把上限降到 N」）。
    B: 24,
    // 0：今天一处裸坐标都没有（AGENTS 里唯一两处 `src/…js:N` 都带 `pi-subagents:` 前缀 ⇒ 走例外）。
    C: 0,
  }),
  "AGENTS_cn.md": Object.freeze({
    // 4：中文侧同一族历史流水账（「此前 issue #394 … 落成契约之后实测 109 组」），比英文侧少是因为
    // 中文侧把「landed」写成了「落成 / 落地」而不是状态词。本票不清账。
    A: 4,
    // 30：中文侧的实测抄件（符号锚点流水账比英文侧长，因为它把「此前 … 实测 N 组 / M 处」整条链留在文件里）。
    // 29：与英文侧同一刀 —— 导出清点句与「84 唯一区间 − 4 处声明式豁免 = 80」那句改成不抄数 ⇒ 30 → 29。
    B: 29,
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
  return { manifest, report, gate, constants, externalPrefixes, staleConstants, exemptions, ceilings };
}

// ── 8. 上限表的刷写与验表（`--sync` / `--verify`，家族口径） ────────────────
/**
 * 为什么要有 `--sync`（issue #644 ②）：上限是**派生态**（实测值的钉子），但 #642 落地时它只能手改——
 * 两次调上限（25/30 → 24/29、18 → 20）都是人把扫描器输出手抄进 `DEBT_CEILINGS`，流程上没有任何东西能
 * 证明抄对了。而且抄**高**一位（24 → 42）在 `--strict` 下是**绿的**（棘轮方向只咬「实测 > 上限」），
 * 所以「手抄错」是这道门里唯一没有闸的东西。
 *
 * 家族标准（`scripts/flat-count-inventory.mjs` / `scripts/mutation-sample-check.mjs`）：
 *   · `--sync <文件>`：**刷表**。数字由实测重写 —— 这是**唯一合法**的改上限方式；
 *   · `--verify <文件>`：**验表**。逐格与实测比，**不改任何文件**；任一处不一致 ⇒ exit 1 并点名。
 * 两者都比 `--strict` 更紧：`--strict` 是棘轮（实测 ≤ 上限即绿，允许余量），`--sync` / `--verify`
 * 要求**相等**（表是量出来的，不是写出来的）⇒ 手抄高一位也红。棘轮方向本身不变：清账仍然是「跑
 * `--sync` 把上限降下来」，而不是「手改一个更小的数」。
 *
 * 与 `flat-count-inventory` 那条已知坑的区别：**少传路径不是崩溃，是明确的用法错误**（exit 2 + 用法）。
 * 那一族的 `--sync` 少传路径会 `readFileSync(undefined)` 崩在 TypeError 上，读起来像门自己坏了；
 * 这里先校验参数、再碰文件系统。
 *
 * 刷不了的两种红（都不是「数值抄错」，所以 `--sync` 不许静默吞掉）：
 *   · 指令面上有这份文件、表里没有它的行 ⇒ 缺一条**理由注释**，那是人写的，`--sync` 不代笔；
 *   · 表里有这一行、指令面上没有这份文件 ⇒ 死条目（改名 / 删文件留下的），人决定删还是改回。
 */

const DEBT_TABLE_USAGE = [
  "用法：",
  "  node scripts/agents-directive-scan.mjs                    # 全量报告（人读视图，exit 0）",
  "  node scripts/agents-directive-scan.mjs --strict           # 门禁：红数 > 0 ⇒ exit 1；清单拿不到 ⇒ exit 2",
  "  node scripts/agents-directive-scan.mjs --json             # 同一份事实的机器读法",
  "  node scripts/agents-directive-scan.mjs --sync   <文件>    # 刷上限表（唯一合法的改法；文件里必须有 `DEBT_CEILINGS`）",
  "  node scripts/agents-directive-scan.mjs --verify <文件>    # 验上限表（逐格与实测比；不改文件）",
  "  node scripts/agents-directive-scan.mjs --self-test        # 反向证（合成树夹具 × 三种欠账形态）",
].join("\n");

/** `DEBT_CEILINGS` 那一块在源码里的位置（抽不到就抛错：#164 口径，不许静默降级）。 */
function debtBlockOf(text) {
  const m = /(export const DEBT_CEILINGS = Object\.freeze\(\{)([\s\S]*?)(\n\}\);)/.exec(text);
  if (m === null) {
    throw new Error("这份文件里抽不到 `export const DEBT_CEILINGS = Object.freeze({ … });`——"
      + "上限表不是这个形状，`--sync` / `--verify` 没有可对账的真值（拒绝静默成功）");
  }
  return { head: m[1], body: m[2], tail: m[3], start: m.index, end: m.index + m[0].length };
}

/** 表里的一行：`  "AGENTS.md": Object.freeze({ … }),`。 */
const DEBT_ROW_RE = /\n  "([^"]+)": Object\.freeze\(\{([\s\S]*?)\n  \}\),/g;
/** 行里的一格：`    A: 20,`。 */
const DEBT_CELL_RE = /\n([ \t]+)([A-Z])(: )(\d+)(,)/g;

/**
 * 把源码文本里的上限表读成 `Map<文件, {A,B,C}>`（**只读文本**，不读模块常量 ⇒ 自测能对一份副本对账）。
 *
 * @param {string} text
 * @returns {Map<string, Record<string, number>>}
 */
export function ceilingsFromSource(text) {
  const { body } = debtBlockOf(text);
  const rows = new Map();
  for (const m of body.matchAll(DEBT_ROW_RE)) {
    const cells = {};
    for (const c of m[2].matchAll(DEBT_CELL_RE)) cells[c[2]] = Number(c[4]);
    rows.set(m[1], cells);
  }
  if (rows.size === 0) {
    throw new Error("`DEBT_CEILINGS` 块里一行都抽不到——表被改坏了（拒绝静默成功）");
  }
  return rows;
}

/**
 * 验表：逐格与实测比。**不改任何文件**，返回问题清单（空 = 绿）。
 *
 * @param {{text: string, measured: Map<string, Record<string, number>>}} input
 * @returns {string[]}
 */
export function verifyCeilings({ text, measured }) {
  const table = ceilingsFromSource(text);
  const problems = [];
  for (const [file, counts] of measured) {
    const row = table.get(file);
    if (row === undefined) {
      problems.push(`${file}：指令面上有这份文件，上限表里却没有它的行（新入指令面却忘了钉上限；`
        + "`--sync` 不替你编理由注释，人手加一条再跑 --sync）");
      continue;
    }
    for (const category of Object.keys(CATEGORIES)) {
      const claim = row[category];
      if (claim === undefined) {
        problems.push(`${file} ${category} 类：上限表里没有这一格（--sync 只重写已有的格，缺格要人手补）`);
        continue;
      }
      if (claim !== counts[category]) {
        problems.push(`${file} ${category} 类：表 ${claim} / 实测 ${counts[category]}`
          + "（手改派生数 = 伪造；跑 --sync）");
      }
    }
  }
  for (const file of table.keys()) {
    if (!measured.has(file)) {
      problems.push(`${file}：上限表里有这一行，指令面上却没有这份文件（死条目：文件名改了或文件删了，`
        + "人手决定删掉还是改回来）");
    }
  }
  return problems;
}

/**
 * 刷表：把每一格的数字重写成实测值（**只碰数字**，行尾的理由注释一个字不动）。
 *
 * @param {{text: string, measured: Map<string, Record<string, number>>}} input
 * @returns {{text: string, changes: Array<{file: string, category: string, from: number, to: number}>,
 *   missing: string[], dead: string[]}}
 */
export function syncCeilings({ text, measured }) {
  const { head, body, tail, start, end } = debtBlockOf(text);
  const table = ceilingsFromSource(text);
  const missing = [...measured.keys()].filter((file) => !table.has(file));
  const dead = [...table.keys()].filter((file) => !measured.has(file));
  const changes = [];
  const rebuilt = body.replace(DEBT_ROW_RE, (row, file, inner) => {
    const counts = measured.get(file);
    if (counts === undefined) return row;
    const cells = inner.replace(DEBT_CELL_RE, (cell, indent, category, sep, digits, comma) => {
      const next = counts[category];
      if (next === undefined) return cell;
      if (Number(digits) !== next) changes.push({ file, category, from: Number(digits), to: next });
      return `\n${indent}${category}${sep}${next}${comma}`;
    });
    return inner === "" ? row : row.replace(inner, () => cells);
  });
  return { text: `${text.slice(0, start)}${head}${rebuilt}${tail}${text.slice(end)}`, changes, missing, dead };
}

/** 实测（只读 `counts`；上限传空表即可——`unregistered` 的红在这里无关，我们只要数）。 */
function measuredForTable({ root, io }) {
  const { report } = scanDirectives({ root, io, ceilings: {} });
  return new Map(report.filter((entry) => entry.kind === "directive").map((entry) => [entry.file, { ...entry.counts }]));
}

/** 目标文件必须是**本仓内**的路径（刷仓库外的文件等于给「手抄」开一条后门）。 */
function resolveTableTarget(target, root) {
  const abs = path.resolve(root, target);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`目标文件 ${target} 不在仓库内（${root}）——上限表只许刷本仓里的源文件`);
  }
  return { abs, rel: rel.split(path.sep).join("/") };
}

/** `--verify <文件>`：验表，不改文件。退出码 0 = 逐格等于实测，1 = 有格不一致，2 = 门自己坏了。 */
function mainVerifyTable({ target, root, io }) {
  let rel;
  let text;
  let measured;
  try {
    const resolved = resolveTableTarget(target, root);
    rel = resolved.rel;
    text = readFileSync(resolved.abs, "utf8");
    measured = measuredForTable({ root, io });
  } catch (error) {
    console.error(`agents-directive-scan --verify: ${error.message}`);
    return 2;
  }
  let problems;
  try {
    problems = verifyCeilings({ text, measured });
  } catch (error) {
    console.error(`agents-directive-scan --verify: ${error.message}`);
    return 2;
  }
  console.log(`agents-directive-scan --verify：${rel}`);
  if (problems.length > 0) {
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    console.log(`agents-directive-scan: 失败 — ${problems.length} 处不一致`
      + "（上限是量出来的：跑 `--sync`，不许手改）");
    return 1;
  }
  console.log(`  ${measured.size} 份指令面文件 × ${Object.keys(CATEGORIES).length} 类，逐格等于实测`);
  console.log(`复跑：node scripts/agents-directive-scan.mjs --verify ${rel}`);
  return 0;
}

/** `--sync <文件>`：刷表（唯一合法的改法），刷完当场复验。退出码 0 = 刷完绿，1 = 有刷不动的红，2 = 门坏了。 */
function mainSyncTable({ target, root, io }) {
  let rel;
  let abs;
  let text;
  let measured;
  try {
    const resolved = resolveTableTarget(target, root);
    ({ rel, abs } = resolved);
    text = readFileSync(abs, "utf8");
    measured = measuredForTable({ root, io });
  } catch (error) {
    console.error(`agents-directive-scan --sync: ${error.message}`);
    return 2;
  }
  let result;
  try {
    result = syncCeilings({ text, measured });
  } catch (error) {
    console.error(`agents-directive-scan --sync: ${error.message}`);
    return 2;
  }
  console.log(`agents-directive-scan --sync：${rel}`);
  const unfixable = [];
  for (const file of result.missing) {
    unfixable.push(`${file}：指令面上有这份文件，上限表里没有它的行——人手加一条（连理由注释），再跑 --sync`);
  }
  for (const file of result.dead) {
    unfixable.push(`${file}：上限表里有这一行，指令面上没有这份文件——人手决定删掉它还是把文件名改回来`);
  }
  if (unfixable.length > 0) {
    for (const line of unfixable) console.log(`  ✗ ${line}`);
    console.log("agents-directive-scan: 刷不动 —— 上面这些不是上限数值能修的（不写文件）");
    return 1;
  }
  if (result.text !== text) writeFileSync(abs, result.text);
  for (const change of result.changes) {
    console.log(`  ${change.to > change.from ? "↑" : "↓"} ${change.file} ${change.category} 类：`
      + `${change.from} → ${change.to}${change.to > change.from
        ? "（**抬高**：新写进去的可变量要么改成复现命令，要么在报告里写明为什么是存量）" : ""}`);
  }
  console.log(`  改动 ${result.changes.length} 格（数字由实测重写；行尾的理由注释一个字都没碰）`);
  const problems = verifyCeilings({ text: result.text, measured });
  if (problems.length > 0) {
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    console.log("agents-directive-scan: 刷完仍有不一致 —— 上面这些不是上限数值能修的");
    return 1;
  }
  console.log("刷完复验：逐格等于实测");
  return 0;
}

// ── 9. 输出（两条分支都只读 `gate`，不自己算红） ─────────────────────────────
/** 人读视图。返回值 = 退出码（由 `gateExitCode` 给；本函数不自己拼红数）。 */
function printReport({ report, gate, constants, externalPrefixes, staleConstants, exemptions, ceilings }, { strict }) {
  const directive = report.filter((r) => r.kind === "directive");
  const history = report.filter((r) => r.kind === "history");
  console.log(`agents-directive-scan: ${report.length} 份**入库**文件（清单 = \`git ls-files\`；`
    + `面 = AGENTS 那一对 + \`CHANGELOG.md\` + \`docs/\`，issue #642）`);
  console.log("门禁：`npm run check:agents-directives`（= `--strict` + `--verify`）在 CI 里阻塞，紧跟 `Documentation drift check` 一族；"
    + "上限表只能由 `--sync <文件>` 刷（手改数字 = 伪造），默认模式只打报告\n");

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
  for (const entry of exemptions) {
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
    const row = ceilings[entry.file] ?? {};
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
  console.log(`  ③ 例外登记：${exemptions.length} 条，空转 ${gate.counts.idleExemptions} 条`);
  console.log(`  ④ 存量欠账：${Object.keys(ceilings).length} 份文件登记，超上限 ${gate.counts.overCeiling} 格、空转 ${gate.counts.idleCeilings} 格`);
  console.log(`  ⑤ 常量抄件对账：${staleConstants.length === 0 ? "全部等于源码现值" : `${staleConstants.length} 处过期`}`);

  if (strict) {
    console.log(`\n--strict: ${gate.red === 0 ? "OK — 0 处红" : `${gate.red} 处红`}`);
    return gateExitCode(gate, { strict });
  }
  console.log("\n结论：报告模式（exit 0）。门禁跑的是 `--strict`（`npm run check:agents-directives`）。");
  return gateExitCode(gate, { strict });
}

// ── 10. 自测（合成树夹具 / 纯函数夹具，不碰真文档） ───────────────────────────
/**
 * 合成树夹具的**内容**（issue #644 ①）。
 *
 * 为什么不再拿真 `AGENTS.md` 当注入目标：真面上「实测命中」与 `DEBT_CEILINGS` 之差（= 余量）是**这台机器
 * 此刻的欠账状态**。旧用例「塞一条 ⇒ 红」隐含「干净面恰好贴在上限上」——B 类从 25 清到 24 之后，注入的
 * 那一条落进余量 ⇒ 门是绿的，用例却期望红 ⇒ **扫完账，反向证自己变红**（#644 ① 的原话）。
 *
 * 合成树把三件事都写进用例：内容在这张表里、上限 = 实测 + `margin`、注入数 = `上限 − 实测 + 1` ⇒
 * 裁决只依赖夹具，不依赖真树欠了多少（与 `docs-drift-check --self-test` 的树形用例同一个理由，#302）。
 *
 * 夹具面必须**三类都有非例外命中**：某一格实测为 0 时给它加余量会撞上「上限 > 0 而实测 0 ⇒ 红」那条
 * 规矩（空转上限），夹具自己就红了，与注入无关。同理三条例外**各自命中**（否则空转例外红）。
 */
const FIXTURE_FILES = Object.freeze({
  "AGENTS.md": [
    "# AGENTS（合成树夹具，issue #644 ①；不是真文档）",
    "",
    "- 见 issue #642（出处引用，不带状态）——这一句**不算** A 类命中",
    "- 工单 #900 已落地（夹具里的存量 A 类命中）",
    "- measured 87 declarations（夹具里的存量 B 类命中）",
    "- 看 `src/loop/orchestrator.js:4372`（夹具里的存量 C 类命中）",
    "- `BASELINE_ROOT = 108` 与「实测 108 个类型错误」同句（夹具里的 gate-owned-constant 例外）",
    "- 历史值：此前实测 122 组 / 346 处（夹具里的 historical-value-label 例外）",
    "- 看 `pi-subagents:src/runs/background/async-execution.js:9`（夹具里的 external-repo-coordinate 例外）",
    "",
  ].join("\n"),
  "AGENTS_cn.md": [
    "# AGENTS_cn（合成树夹具，issue #644 ①；不是真文档）",
    "",
    "- 工单 #901 已落地（夹具里的存量 A 类命中）",
    "- 实测 122 组 / 346 处（夹具里的存量 B 类命中）",
    "- 看 `src/loop/orchestrator.js:4372`（夹具里的存量 C 类命中）",
    "",
  ].join("\n"),
  "CHANGELOG.md": [
    "# CHANGELOG（夹具：历史一侧只计数、不判定）",
    "",
    "- issue #998 已落地；实测 1234 组（同一句式在指令面上是红，在历史一侧是绿）",
    "",
  ].join("\n"),
  "docs/decisions/001-config-adapters.md": [
    "# ADR-001（夹具：历史一侧只计数、不判定）",
    "",
    "- issue #998 已落地；实测 1234 组",
    "",
  ].join("\n"),
  // 门禁常量表的真值来源：`gate-owned-constant` 例外**当场**与这里对账（名字清单从源码推，不抄）
  "scripts/type-check-ratchet.mjs": "// 夹具：`gateConstantsFrom()` 的真值来源\nconst BASELINE_ROOT = 108;\n",
  // 外部仓前缀名单的真值来源：`external-repo-coordinate` 例外从这里现读
  "scripts/docs-drift-check.mjs": [
    "// 夹具：`externalPrefixesFrom()` 的真值来源",
    "const EXTERNAL_REPO_PREFIXES = new Map([",
    '  ["pi-subagents", "夹具里唯一登记在案的外部仓"],',
    "]);",
    "",
  ].join("\n"),
  // `--sync` / `--verify` 的刷写目标（#644 ②）：一份带 `DEBT_CEILINGS` 表的最小源文件，
  // 数字先摆成夹具的实测值（1 / 1 / 1），所以干净的夹具上 `--verify` 是绿的。
  "scripts/debt-table-fixture.mjs": [
    "// 夹具：`--sync` / `--verify` 的刷写目标（数字 = 夹具实测值 1/1/1）",
    "export const DEBT_CEILINGS = Object.freeze({",
    '  "AGENTS.md": Object.freeze({',
    "    // 1：夹具里的存量 A 类命中",
    "    A: 1,",
    "    // 1：夹具里的存量 B 类命中",
    "    B: 1,",
    "    // 1：夹具里的存量 C 类命中",
    "    C: 1,",
    "  }),",
    '  "AGENTS_cn.md": Object.freeze({',
    "    // 1 / 1 / 1：同上（中文侧）",
    "    A: 1,",
    "    B: 1,",
    "    C: 1,",
    "  }),",
    "});",
    "",
  ].join("\n"),
});

/**
 * 三种欠账形态（issue #644 ① 的判据：同一份夹具在这三种形态下**裁决必须相同**）。
 * `margin` = 上限与实测之差；贴上限那一种是 #642 落地时的形态，另两种是「清过账」之后的形态。
 */
const DEBT_SHAPES = Object.freeze([
  { id: "at-ceiling", margin: 0, label: "贴上限（上限 = 实测）" },
  { id: "with-margin", margin: 1, label: "有余量（上限 = 实测 + 1）" },
  { id: "ample-margin", margin: 5, label: "余量充足（上限 = 实测 + 5）" },
]);

async function selfTest() {
  const eq = (actual, expected, what) => {
    if (actual !== expected) throw new Error(`${what}: 期望 ${expected}，实测 ${actual}`);
  };
  const realTruthFiles = gitTrackedFiles({ root: ROOT, pathspecs: TRUTH_PATHSPECS, suffix: ".mjs", what: "真值清单" });

  /** 建一棵合成树夹具（内容全在 `FIXTURE_FILES` 里；git 用注入的假执行器，真 git 由第 ⑨ 例证过）。 */
  const makeFixture = () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "erix-directive-fixture-")));
    for (const [rel, text] of Object.entries(FIXTURE_FILES)) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
    const surface = Object.keys(FIXTURE_FILES).filter((rel) => rel.endsWith(".md")).sort();
    const truth = Object.keys(FIXTURE_FILES).filter((rel) => rel.startsWith("scripts/")).sort();
    // `tracked` = 夹具声明的「入库」清单（可增可删：`--sync` 那两例要模拟「新入指令面」与「文件改名」）
    const tracked = [...surface];
    const io = {
      exec: (args) => {
        if (args[0] === "rev-parse") return `${dir}\n`;
        if (args[0] === "ls-files") {
          const pathspecs = args.slice(args.indexOf("--") + 1);
          return (pathspecs.includes("scripts") ? truth : tracked).map((rel) => `${rel}\0`).join("");
        }
        throw new Error(`夹具 git 不认识这个子命令：${args.join(" ")}`);
      },
    };
    // 实测：用全零上限探一次（只读 `counts`；全零不会触发空转红——空转要 `上限 > 0`）
    const probe = scanDirectives({
      root: dir,
      io,
      ceilings: Object.fromEntries(DIRECTIVE_FILES.map((rel) => [rel, { A: 0, B: 0, C: 0 }])),
    });
    const measured = Object.fromEntries(probe.report
      .filter((entry) => entry.kind === "directive")
      .map((entry) => [entry.file, { ...entry.counts }]));
    const ceilingsFor = (margin) => Object.fromEntries(Object.entries(measured).map(([file, counts]) => [
      file,
      Object.fromEntries(Object.keys(CATEGORIES).map((category) => [category, counts[category] + margin])),
    ]));
    return {
      dir,
      io,
      surface,
      measured,
      ceilingsFor,
      /** 新增一份「入库」文件（模拟「新入指令面却忘了钉上限」）。 */
      addTracked: (rel, text) => {
        const abs = path.join(dir, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, text);
        tracked.push(rel);
      },
      /** 把一份文件从「入库」清单里拿掉（模拟改名 / 删文件后表里留下的死行）。 */
      removeTracked: (rel) => {
        rmSync(path.join(dir, rel), { force: true });
        const at = tracked.indexOf(rel);
        if (at >= 0) tracked.splice(at, 1);
      },
    };
  };

  /** 在夹具上跑一段（跑完删树；`margin` 决定这一轮的欠账形态）。 */
  const withFixture = async (margin, fn) => {
    const tree = makeFixture();
    try {
      return await fn({ ...tree, margin, ceilings: tree.ceilingsFor(margin) });
    } finally {
      rmSync(tree.dir, { recursive: true, force: true });
    }
  };

  /** 跑一次真实 `runCli()`，把两条输出流收进内存（自测自己的报告不许被人读视图淹没）。 */
  const runCaptured = async (argv, tree) => {
    const saved = { log: console.log, error: console.error };
    const out = [];
    const err = [];
    console.log = (...args) => out.push(args.map((a) => String(a)).join(" "));
    console.error = (...args) => err.push(args.map((a) => String(a)).join(" "));
    try {
      const code = await runCli({ argv, root: tree.dir, io: tree.io, ceilings: tree.ceilings });
      return { code, stdout: out.join("\n"), stderr: err.join("\n") };
    } finally {
      console.log = saved.log;
      console.error = saved.error;
    }
  };

  /** 往夹具里的一份文件追加若干行（返回追加前的原文与原文行数，供还原与「变异真的落上」核对）。 */
  const injectLines = (tree, rel, lines) => {
    const before = readFileSync(path.join(tree.dir, rel), "utf8");
    writeFileSync(path.join(tree.dir, rel), `${before}\n${lines.join("\n")}\n`);
    return { before, baseLines: before.split("\n").length - 1 };
  };
  const restore = (tree, rel, text) => writeFileSync(path.join(tree.dir, rel), text);

  /** 每一类命中各一种句式；`i` 只用来让每一行各自成句、行号互不相同。 */
  const probeLine = (category, i) => (category === "A"
    ? `issue #99${i} 已落地（反向证塞进去的第 ${i} 条）`
    : category === "B"
      ? `实测 1234 组（反向证塞进去的第 ${i} 条）`
      : `看 \`src/loop/probe.js:${100 + i}\`（反向证塞进去的第 ${i} 条）`);

  /**
   * 注入**恰好把某一格顶出上限**的命中数：`上限 − 实测 + 1`。
   *
   * 固定塞一条就是 #644 ① 的病根：余量 ≥ 1 时那一条落进余量 ⇒ 门是绿的，用例却期望红。
   * 注入数从夹具自己的两个数推出来，所以三种欠账形态下都恰好顶出 1 格。
   */
  const injectOver = (tree, rel, category) => {
    const n = tree.ceilings[rel][category] - tree.measured[rel][category] + 1;
    const { before, baseLines } = injectLines(tree, rel, Array.from({ length: n }, (_, k) => probeLine(category, k + 1)));
    return { n, before, baseLines };
  };

  const hitsOf = (payload, rel) => payload.files.find((f) => f.file === rel)?.hits ?? [];

  // ── 用例表：每个用例的签名是 `(shape) => Promise`；三种欠账形态各跑一遍，判词向量必须逐例相同 ──
  const caseList = (shape) => {
    const pending = [];
    const t = (name, fn) => pending.push([name, fn]);

    t("放行证：真指令面与合成树夹具上 `--strict` / `--strict --json` 都绿，红数 0", async () => {
      const real = await runCaptured(["--strict"], { dir: ROOT });
      eq(real.code, 0, "真指令面 `--strict` 的退出码");
      eq(JSON.parse((await runCaptured(["--strict", "--json"], { dir: ROOT })).stdout).gate.red, 0, "真指令面的红数");
      await withFixture(shape.margin, async (tree) => {
        const text = await runCaptured(["--strict"], tree);
        eq(text.code, 0, `夹具（${shape.label}）\`--strict\` 的退出码`);
        const json = await runCaptured(["--strict", "--json"], tree);
        eq(json.code, 0, "夹具 `--strict --json` 的退出码");
        const payload = JSON.parse(json.stdout);
        eq(payload.gate.red, 0, "夹具的红数");
        // 「形态真的落上了」（#210 R2）：贴上限那一种一格余量都没有，另两种六个格子全是余量
        eq(payload.gate.downgradable.length, shape.margin === 0 ? 0 : 6, `夹具（${shape.label}）的余量格数`);
      });
    });

    t("反向证 ①：注入 `上限 − 实测 + 1` 条 A 类命中 ⇒ 红并点名文件:行；`--strict --json` 同判；还原 ⇒ 绿",
      () => withFixture(shape.margin, async (tree) => {
        const { n, before, baseLines } = injectOver(tree, "AGENTS.md", "A");
        const text = await runCaptured(["--strict"], tree);
        const json = await runCaptured(["--strict", "--json"], tree);
        eq(text.code, 1, "注入 A 类命中后 `--strict` 的退出码");
        eq(json.code, text.code, "两条输出分支的退出码必须相同");
        if (!/AGENTS\.md\s+A 类/.test(text.stdout)) {
          throw new Error(`文本分支没点名 AGENTS.md 的 A 类红：${text.stdout.slice(-300)}`);
        }
        const payload = JSON.parse(json.stdout);
        if (!payload.gate.overCeiling.some((v) => v.file === "AGENTS.md" && v.category === "A")) {
          throw new Error("JSON 的红集合里没有 AGENTS.md 的 A 类");
        }
        // 变异必须真的落上（#210 R2）：注入的 n 条各自被抽成 A 类命中，行号在夹具原文之后，且没被例外放行
        const injected = hitsOf(payload, "AGENTS.md").filter((h) => h.category === "A" && h.line > baseLines);
        eq(injected.length, n, "注入的 A 类命中条数");
        if (injected.some((h) => h.exempt)) throw new Error("注入的 A 类命中被例外放行了——这条反证是空的");
        if (!injected.every((h) => h.line > 0)) throw new Error("A 类命中没带行号");
        restore(tree, "AGENTS.md", before);
        eq((await runCaptured(["--strict"], tree)).code, 0, "还原后 `--strict` 的退出码");
        eq((await runCaptured(["--strict", "--json"], tree)).code, 0, "还原后 `--strict --json` 的退出码");
      }));

    t("反向证 ②：注入 `上限 − 实测 + 1` 条 B 类命中 ⇒ 红；换成一模一样的登记例外 ⇒ 绿",
      () => withFixture(shape.margin, async (tree) => {
        const { n, before, baseLines } = injectOver(tree, "AGENTS.md", "B");
        const red = await runCaptured(["--strict"], tree);
        eq(red.code, 1, "注入裸实测数时 `--strict` 的退出码");
        if (!/B 类/.test(red.stdout)) throw new Error("文本分支没说是 B 类红");
        const payload = JSON.parse((await runCaptured(["--strict", "--json"], tree)).stdout);
        eq(hitsOf(payload, "AGENTS.md").filter((h) => h.category === "B" && h.line > baseLines).length, n,
          "注入的 B 类命中条数");
        restore(tree, "AGENTS.md", before);

        // 换成**登记过的例外**：同一句话里带「实测 + 数字」（所以它确实是一处 B 类命中），但数字是门禁
        // 自己持有的常量且**与现值一致** ⇒ 放行。这一格证的正是票面第 ④ 条：「塞一条登记过的例外 ⇒ 绿」。
        const withConstant = injectLines(tree, "AGENTS.md", [
          "实测 108 个类型错误（`BASELINE_ROOT = 108`，真值在 `scripts/type-check-ratchet.mjs`，门禁自己会对账）",
        ]).before;
        eq((await runCaptured(["--strict"], tree)).code, 0, "塞了登记例外后 `--strict` 的退出码");
        const green = JSON.parse((await runCaptured(["--strict", "--json"], tree)).stdout);
        // 变异必须真的落上（#210 R2）：塞进去的那一句必须**先是**一处 B 类命中，**再**被例外放行。
        // 只断言「有 `gate-owned-constant` 放行」是假证——夹具里本来就有两处。
        const inserted = hitsOf(green, "AGENTS.md").find((h) => h.category === "B" && h.text.includes("108 个类型错误"));
        if (inserted === undefined) throw new Error("变异没落上：塞进去的实测句没被抽成 B 类命中");
        eq(inserted.exempt, true, "塞进去的那一句必须被例外放行（否则它只是没命中）");
        eq(inserted.exemption, "gate-owned-constant", "放行它的是哪一条例外");
        restore(tree, "AGENTS.md", withConstant);
      }));

    t("反向证 ③：常量抄件与源码现值不一致 ⇒ 例外**不放行** ⇒ 红（这不是免检通道，是活的对账）",
      () => withFixture(shape.margin, async (tree) => {
        const before = injectLines(tree, "AGENTS.md", [
          "`BASELINE_ROOT = 999` 是门禁自己持有的常量（反向证：值写错）",
        ]).before;
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
      () => withFixture(shape.margin, async (tree) => {
        const ghost = { id: "fixture-never-matches", categories: ["B"], why: "反向证用的空转条目", matches: () => false };
        const saved = EXEMPTIONS;
        // 直接问判据（纯函数）：扫描面不变，只多一条谁也不命中的登记
        const { report } = scanDirectives({ root: tree.dir, io: tree.io, exemptions: [...saved, ghost], ceilings: tree.ceilings });
        const gate = gateVerdicts({ report, exemptions: [...saved, ghost], ceilings: tree.ceilings });
        if (!gate.idleExemptions.some((e) => e.id === "fixture-never-matches")) {
          throw new Error("空转的例外没被判红：登记表里的死条目会一直是假的绿");
        }
        eq(gate.counts.idleExemptions, 1, "空转例外的条数");
        eq(gateExitCode(gate, { strict: true }), 1, "空转例外在门禁下的退出码");
        // 反向：把它删掉 ⇒ 绿（证明上面那条红是它带来的，不是恒红）
        const clean = gateVerdicts({ report, exemptions: saved, ceilings: tree.ceilings });
        eq(clean.counts.idleExemptions, 0, "删掉空转条目后的空转数");
        eq(gateExitCode(clean, { strict: true }), 0, "删掉空转条目后的退出码");
      }));

    t("反向证 ⑤：注入 `上限 − 实测 + 1` 条裸坐标 ⇒ 红；带登记前缀的外仓坐标 ⇒ 绿；未登记前缀 ⇒ 红",
      () => withFixture(shape.margin, async (tree) => {
        const { n, before, baseLines } = injectOver(tree, "AGENTS_cn.md", "C");
        const red = await runCaptured(["--strict", "--json"], tree);
        const payload = JSON.parse(red.stdout);
        const injected = hitsOf(payload, "AGENTS_cn.md").filter((h) => h.category === "C" && h.line > baseLines);
        eq(injected.length, n, "注入的裸坐标条数");
        if (injected.some((h) => h.exempt)) throw new Error("注入的裸坐标被例外放行了——这条反证是空的");
        eq(red.code, 1, "裸坐标下 `--strict --json` 的退出码");
        restore(tree, "AGENTS_cn.md", before);

        // 带**登记过**前缀的外仓坐标不是本仓坐标（例外）⇒ 一处也不进计数 ⇒ 绿
        const withPrefix = injectLines(tree, "AGENTS_cn.md", [
          "看 `pi-subagents:src/runs/background/async-execution.js:9`（反向证）",
        ]).before;
        eq((await runCaptured(["--strict"], tree)).code, 0, "带登记前缀的外仓坐标必须绿");
        restore(tree, "AGENTS_cn.md", withPrefix);
        // 未登记的前缀不是免检票：同一个形状换个仓名 ⇒ 照样是一处 C 类命中，所以注入数同样是自适应的
        const { before: bogusBefore } = injectLines(tree, "AGENTS_cn.md",
          Array.from({ length: n }, (_, k) => `看 \`zzz-repo:src/loop/probe.js:${200 + k}\`（反向证：未登记前缀）`));
        eq((await runCaptured(["--strict"], tree)).code, 1, "未登记外部仓前缀必须红");
        restore(tree, "AGENTS_cn.md", bogusBefore);
        eq((await runCaptured(["--strict"], tree)).code, 0, "还原后必须绿");
      }));

    t("分类不是空话：同一句塞进 CHANGELOG.md / docs 历史文档 ⇒ 绿（历史一侧只计数、不判定）",
      () => withFixture(shape.margin, async (tree) => {
        const changelog = injectLines(tree, "CHANGELOG.md", ["issue #999 已落地；实测 1234 组"]).before;
        eq((await runCaptured(["--strict"], tree)).code, 0, "CHANGELOG 里的同一句式必须绿");
        const payload = JSON.parse((await runCaptured(["--strict", "--json"], tree)).stdout);
        const entry = payload.files.find((f) => f.file === "CHANGELOG.md");
        eq(entry.kind, "history", "CHANGELOG.md 的分类");
        if (entry.hits.length === 0) throw new Error("变异没落上：CHANGELOG 里一处命中都没抽到");
        restore(tree, "CHANGELOG.md", changelog);

        const doc = injectLines(tree, "docs/decisions/001-config-adapters.md", ["issue #999 已落地；实测 1234 组"]).before;
        eq((await runCaptured(["--strict"], tree)).code, 0, "docs 历史文档里的同一句式必须绿");
        restore(tree, "docs/decisions/001-config-adapters.md", doc);
      }));

    t("存量欠账是棘轮：实测 < 上限 ⇒ 绿（清账永不红）+ 提示可下调；上限 > 0 而实测 0 ⇒ 红", () => {
      const ceiling = 3 + shape.margin;
      const report = [{ file: "AGENTS.md", kind: "directive", counts: { A: 0, B: 0, C: 0 }, hits: [] }];
      const ceilings = { "AGENTS.md": { A: ceiling, B: 0, C: 0 } };
      const gate = gateVerdicts({ report, exemptions: EXEMPTIONS, ceilings });
      eq(gate.counts.overCeiling, 0, "实测 0 < 上限时的超上限数");
      eq(gate.downgradable.length, 1, "可下调的格数");
      eq(gate.counts.idleCeilings, 1, "上限 > 0 而实测 0 ⇒ 空转 1 格");
      if (gate.red === 0) throw new Error("空转的上限必须算红（否则登记表可以永远挂着没人用的数）");
      const raised = gateVerdicts({
        report: [{ file: "AGENTS.md", kind: "directive", counts: { A: ceiling + 1, B: 0, C: 0 }, hits: [] }],
        exemptions: EXEMPTIONS, ceilings,
      });
      eq(raised.counts.overCeiling, 1, "实测 上限 + 1 > 上限 时的超上限数");
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
      const sources = realTruthFiles.map((file) => ({ file, text: readFileSync(path.join(ROOT, file), "utf8") }));
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

    t("反向证 ⑥：注入数自适应 —— 固定塞一条在有余量的形态下是**假绿**（#644 ① 的原病根），"
      + "塞 `上限 − 实测 + 1` 条则三种欠账形态同判红", async () => {
      const verdicts = [];
      for (const probe of DEBT_SHAPES) {
        await withFixture(probe.margin, async (tree) => {
          const one = injectLines(tree, "AGENTS.md", ["实测 1234 组（固定只塞一条）"]).before;
          const green = await runCaptured(["--strict"], tree);
          restore(tree, "AGENTS.md", one);
          const { before } = injectOver(tree, "AGENTS.md", "B");
          const red = await runCaptured(["--strict"], tree);
          restore(tree, "AGENTS.md", before);
          verdicts.push({ probe, one: green.code, adaptive: red.code });
        });
      }
      // 判据一：自适应那一列在三种形态下**必须相同**（都红）
      eq(verdicts.map((v) => v.adaptive).join(","), "1,1,1", "自适应注入在三种欠账形态下的退出码");
      // 判据二：固定塞一条只在贴上限那一形态下红 —— 这就是「反向证自己变红」的机制，写进用例免得复发
      eq(verdicts.map((v) => v.one).join(","), "1,0,0", "固定塞一条在三种欠账形态下的退出码（后两种是假绿）");
    });

    t("反向证 ⑦：手改一格上限 ⇒ `--verify` 红并点名（抄高也是红）；`--sync` 刷回 ⇒ 逐字回到原样；再刷一遍 0 格改动",
      () => withFixture(shape.margin, async (tree) => {
        const rel = "scripts/debt-table-fixture.mjs";
        const abs = path.join(tree.dir, rel);
        const pristine = readFileSync(abs, "utf8");
        eq((await runCaptured(["--verify", rel], tree)).code, 0, "干净表 `--verify` 的退出码");
        const cell = "    A: 1,\n    // 1：夹具里的存量 B 类命中";
        // 两个方向都试。抄高那一方向是 #644 ② 的洞：它在 `--strict` 下是**绿的**（棘轮只咬「实测 > 上限」）
        for (const wrong of [9, 0]) {
          const tampered = pristine.replace(cell, `    A: ${wrong},\n    // 1：夹具里的存量 B 类命中`);
          if (tampered === pristine) throw new Error("变异没落上：手改那一格没改到");
          writeFileSync(abs, tampered);
          const run = await runCaptured(["--verify", rel], tree);
          eq(run.code, 1, `手改成 ${wrong} 后 \`--verify\` 的退出码`);
          if (!/AGENTS\.md A 类/.test(run.stdout)) throw new Error(`--verify 没点名是哪一格：${run.stdout}`);
          if (!/实测 1/.test(run.stdout)) throw new Error(`--verify 没报实测值：${run.stdout}`);
          eq((await runCaptured(["--sync", rel], tree)).code, 0, "`--sync` 的退出码");
          eq(readFileSync(abs, "utf8"), pristine, "`--sync` 刷完必须逐字回到原样（只重写数字，注释不动）");
          eq((await runCaptured(["--verify", rel], tree)).code, 0, "刷回后 `--verify` 的退出码");
        }
        const again = await runCaptured(["--sync", rel], tree);
        eq(again.code, 0, "再刷一遍的退出码");
        if (!/改动 0 格/.test(again.stdout)) throw new Error(`--sync 不幂等（干净表上又改了几格）：${again.stdout}`);
      }));

    t("反向证 ⑧：`--sync` / `--verify` 少传路径 ⇒ exit 2 且说清缺什么（不是 `readFileSync(undefined)` 崩）；"
      + "目标里没有表 / 路径越界 ⇒ 同样 exit 2 且一个字节都不写", async () => {
      for (const mode of ["--sync", "--verify"]) {
        const run = await runCaptured([mode], { dir: ROOT });
        eq(run.code, 2, `${mode} 少传路径时的退出码`);
        if (!/缺少目标文件路径/.test(run.stderr)) throw new Error(`${mode} 少传路径时没说清缺什么：${run.stderr}`);
        if (!/用法/.test(run.stderr)) throw new Error(`${mode} 少传路径时没打用法：${run.stderr}`);
      }
      // 目标文件里没有 `DEBT_CEILINGS` ⇒ 明确报错，而且**不写文件**（刷表不许变成「猜着写」）
      const before = readFileSync(path.join(ROOT, "README.md"), "utf8");
      const noTable = await runCaptured(["--sync", "README.md"], { dir: ROOT });
      eq(noTable.code, 2, "目标里没有表时 `--sync` 的退出码");
      if (!/抽不到/.test(noTable.stderr)) throw new Error(`报错没说清抽不到表：${noTable.stderr}`);
      eq(readFileSync(path.join(ROOT, "README.md"), "utf8"), before, "报错路径上一个字节都不许写");
      // 仓库外的路径不许刷（否则「刷表」就是给「手抄」开的另一道后门）
      const outside = await runCaptured(["--sync", path.join(tmpdir(), "not-ours.md")], { dir: ROOT });
      eq(outside.code, 2, "仓库外路径的退出码");
      if (!/不在仓库内/.test(outside.stderr)) throw new Error(`报错没说清路径越界：${outside.stderr}`);
    });

    t("反向证 ⑨：`--sync` 修不了的两类红（指令面上没登记的文件 / 表里死了的行）⇒ 明确报错并点名，不写文件",
      () => withFixture(shape.margin, async (tree) => {
        const rel = "scripts/debt-table-fixture.mjs";
        const abs = path.join(tree.dir, rel);
        const pristine = readFileSync(abs, "utf8");
        // ① 指令面上多了一份没登记的文件（新入指令面却忘了钉上限）
        tree.addTracked("AGENTS_xx.md", "# AGENTS_xx（夹具）\n\n- 工单 #902 已落地\n");
        const missing = await runCaptured(["--sync", rel], tree);
        eq(missing.code, 1, "有未登记文件时 `--sync` 的退出码");
        if (!/AGENTS_xx\.md/.test(missing.stdout)) throw new Error(`没点名未登记的文件：${missing.stdout}`);
        eq(readFileSync(abs, "utf8"), pristine, "刷不动时不许写文件");
        tree.removeTracked("AGENTS_xx.md");
        // ② 表里有一行，指令面上没有这份文件（死条目）
        const withDeadRow = pristine.replace('  "AGENTS_cn.md": Object.freeze({',
          '  "AGENTS_zz.md": Object.freeze({\n    A: 0,\n    B: 0,\n    C: 0,\n  }),\n  "AGENTS_cn.md": Object.freeze({');
        if (withDeadRow === pristine) throw new Error("变异没落上：死条目没插进去");
        writeFileSync(abs, withDeadRow);
        const dead = await runCaptured(["--sync", rel], tree);
        eq(dead.code, 1, "有死条目时 `--sync` 的退出码");
        if (!/AGENTS_zz\.md/.test(dead.stdout)) throw new Error(`没点名死条目：${dead.stdout}`);
        // `--verify` 同样点名这两类（它不该只在 `--sync` 里被看见）
        eq((await runCaptured(["--verify", rel], tree)).code, 1, "死条目下 `--verify` 的退出码");
      }));

    return pending;
  };

  // ── 三种欠账形态各跑一遍全部用例，再比判词向量（#644 ① 的判据：裁决与欠账形态无关） ──
  const runs = [];
  for (const shape of DEBT_SHAPES) {
    const rows = [];
    for (const [name, fn] of caseList(shape)) {
      try {
        await fn(shape);
        rows.push({ name, ok: true, detail: "" });
      } catch (error) {
        rows.push({ name, ok: false, detail: error.message });
      }
    }
    runs.push({ shape, rows });
  }
  const base = runs[0];
  const divergent = [];
  for (const run of runs.slice(1)) {
    run.rows.forEach((row, index) => {
      const ref = base.rows[index];
      if (row.name !== ref.name) {
        divergent.push(`用例顺序在「${run.shape.label}」下与「${base.shape.label}」不一致（${row.name} ≠ ${ref.name}）`);
      } else if (row.ok !== ref.ok) {
        divergent.push(`「${ref.name}」在「${base.shape.label}」是${ref.ok ? "绿" : "红"}、`
          + `在「${run.shape.label}」是${row.ok ? "绿" : "红"}——裁决必须与欠账形态无关（#644 ①）`);
      }
    });
  }
  const merged = base.rows.map((row, index) => {
    const bad = runs.map((run) => ({ shape: run.shape, row: run.rows[index] })).filter((x) => !x.row.ok);
    return {
      name: row.name,
      ok: bad.length === 0,
      detail: bad.length === 0 ? "" : `[${bad[0].shape.label}] ${bad[0].row.detail}`,
    };
  });
  for (const row of merged) console.log(`  ${row.ok ? "✓" : "✗"} ${row.name}${row.ok ? "" : ` — ${row.detail}`}`);
  for (const line of divergent) console.log(`  ✗ ${line}`);
  console.log(`  欠账形态 × 用例：${DEBT_SHAPES.length} 种形态 × ${merged.length} 例，逐例裁决`
    + `${divergent.length === 0 ? "完全相同" : `有 ${divergent.length} 处不同`}（${DEBT_SHAPES.map((s) => s.label).join(" / ")}，#644 ①）`);
  const failed = merged.filter((row) => !row.ok).length + divergent.length;
  console.log(`\nagents-directive-scan --self-test: ${failed === 0
    ? `OK — ${merged.length} 例反向证/放行证 × ${DEBT_SHAPES.length} 种欠账形态全部按预期`
    : `${failed} 例失败`}`);
  return failed === 0 ? 0 : 1;
}

// ── 11. main ─────────────────────────────────────────────────────────────────
/**
 * 一次 CLI 运行。`root` / `io` / `ceilings` 可注入 ⇒ 自测能在**临时树**上把真实路径（清单 → 分类 → 命中 →
 * 例外 → 上限 → 判词 → 退出码）整条跑一遍，不碰真文档、也不假造判词；`ceilings` 那一格是「欠账形态」
 * 的注入点（#644 ①：上限与实测的余量必须能由用例摆布，否则裁决会依赖这台机器此刻的欠账数）。
 *
 * 模式（互斥，别混）：`--strict` 门禁 / 报告 / `--json` / `--sync <文件>` 刷上限表 / `--verify <文件>`
 * 验上限表 / `--self-test` 反向证。
 *
 * @param {{argv?: string[], root?: string, io?: {exec?: (args: string[], root: string) => string},
 *   ceilings?: Readonly<Record<string, Readonly<Record<"A"|"B"|"C", number>>>>}} [options]
 * @returns {Promise<number>} 进程退出码
 */
export async function runCli({ argv = process.argv.slice(2), root = ROOT, io, ceilings = DEBT_CEILINGS } = {}) {
  const strict = argv.includes("--strict");
  const jsonOut = argv.includes("--json");
  const selfTestMode = argv.includes("--self-test");
  const syncMode = argv.includes("--sync");
  const verifyTableMode = argv.includes("--verify");

  if (selfTestMode) return selfTest();

  // 上限表的刷写 / 验表（#644 ②）。**先校验参数再碰文件系统**：少传路径是明确的用法错误（exit 2），
  // 不是 `readFileSync(undefined)` 那类崩溃（`flat-count-inventory` 的已知坑，别照抄）。
  if (syncMode || verifyTableMode) {
    const mode = syncMode ? "--sync" : "--verify";
    if (syncMode && verifyTableMode) {
      console.error("agents-directive-scan: `--sync` 与 `--verify` 是两种模式（刷表 / 验表），不许同时给");
      console.error(DEBT_TABLE_USAGE);
      return 2;
    }
    const target = argv.find((arg) => !arg.startsWith("--"));
    if (target === undefined) {
      console.error(`agents-directive-scan ${mode}: 缺少目标文件路径（${mode} 后面要跟一份含 \`DEBT_CEILINGS\` 的源文件）`);
      console.error(DEBT_TABLE_USAGE);
      return 2;
    }
    return syncMode ? mainSyncTable({ target, root, io }) : mainVerifyTable({ target, root, io });
  }

  let scan;
  try {
    scan = scanDirectives({ root, io, ceilings });
  } catch (error) {
    console.error(`agents-directive-scan: ${error.message}`);
    console.error(`  仓库根：${root}`);
    return 2;
  }
  const { gate, manifest, report, constants, externalPrefixes, staleConstants } = scan;
  const usedCeilings = scan.ceilings;
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
      ceilings: usedCeilings,
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
