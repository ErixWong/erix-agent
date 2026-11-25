#!/usr/bin/env node
// agents-directive-scan.mjs — 阻塞门：**AGENTS 指令面**的字节预算（issue #726 建，issue #909 收敛为只留这一条判据）
// （家族照 `scripts/retired-spelling-scan.mjs`：文件清单只取 `git ls-files`、`--strict` 与 `--strict --json`
//  共用同一份红集合、自带 `--self-test` 反向证、`--sync` / `--verify` 是派生预算表的唯一合法改法与验表）。
//
// #909 的裁决：这张闸原先挂着**三类文本启发式**（① 工单状态句、② 会过期的实测数抄件 / 手抄件上限表、
// ③ 裸源码行号坐标），它们是「读文本猜语义」的判据——误报面大、例外表越滚越大。本票把它们连同各自的
// `--sync` 路径与 `--self-test` 夹具一起删掉，**只留字节预算这一条**：它量的是真实的 context 成本。
// `AGENTS.md` / `AGENTS_cn.md` 是每次会话自动注入、折叠不动的那张面，**每轮全额重发**，字节数就是它的代价。
//
// 有意的行为改变（#909）：写一句假版本号 / 过期抄件 / 裸坐标**不再报红**——那是「读文本猜语义」的活，
// 交给 `check:docs` 的版本对账去管；本闸只认「这张面有多长」。
//
// 为什么只量 AGENTS 这一对：它是 system prompt 的一部分、每轮重发；`docs/` 与 `CHANGELOG.md` 不在注入面里，
// 不进预算。判定面 = `git ls-files` 出的 AGENTS 那一对（#560：只取清单，拒绝退回文件系统遍历）。
//
// 判据（唯一一条，见 `--self-test`）：字节预算 = `ceil512(实测) + 1024`（`budgetFor()`）。
//   · `--strict` 是棘轮：实测 > 预算 ⇒ 红，实测 ≤ 预算 ⇒ 绿（余量以内不红，这正是余量的用途）；
//   · 空转即红：预算表里有行、面上却没这份文件（死条目），或预算被写成非正数（不可能成立）；
//   · 面上有文件却没预算行 ⇒ 未登记红；
//   · `--sync <文件>` 把预算重写成 `budgetFor(实测)`（唯一合法改法），`--verify <文件>` 逐格要求**等于**
//     推出来的那一格（手改派生数 = 伪造，抄高抄低都是红，双向）。
//
// 退出码三档（与家族同构，语义不许混）：
//   · `0` = 绿（红数为 0；或报告模式——那是给人读的视图，不是门）；
//   · `1` = **指令面红了**（红数 > 0 且 `--strict`）；
//   · `2` = **门自己坏了**（清单拿不到：git 不可用 / 不在仓库内 / 仓库顶层不是本脚本所在目录 / 清单为空）。
//
// 用法：
//   node scripts/agents-directive-scan.mjs                 # 全量报告，exit 0（人读视图）
//   node scripts/agents-directive-scan.mjs --json           # 同一份事实的机器读法（含 `gate` 段）
//   node scripts/agents-directive-scan.mjs --strict         # 门禁：红数 > 0 ⇒ exit 1；清单拿不到 ⇒ exit 2
//   node scripts/agents-directive-scan.mjs --strict --json  # 同一道门，机器读法（红集合与退出码同源）
//   node scripts/agents-directive-scan.mjs --self-test      # 反向证：合成树夹具上「灌 2 KB 废话 ⇒ 红、还原 ⇒ 绿」等
//   node scripts/agents-directive-scan.mjs --sync   <文件>  # 刷字节预算表（**唯一合法**的改法；手改数字即红）
//   node scripts/agents-directive-scan.mjs --verify <文件>  # 验预算表：逐格与推出来的那一格比，不改文件；不一致 ⇒ exit 1

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF_PATH), "..");
// 旗标**不在模块顶层解析**（同家族 #575 A）：`runCli({ argv })` 每次运行自己解析，自测才能在同一进程里
// 分别跑「带 --strict」与「不带 --strict」两条路。

// ── 1. 指令面（预算只量这两页） ───────────────────────────────────────────────
/** 指令面：每次会话自动注入、模型不查证就照着执行的那一对文件（工单 #642）。 */
export const DIRECTIVE_FILES = Object.freeze(["AGENTS.md", "AGENTS_cn.md"]);

// ── 2. 字节预算判据（issue #726；#909 后本闸唯一的判据） ───────────────────────
/**
 * 折算比：字节 → token 的近似比值，**只用于给人看**，不参与任何判定。
 *
 * 为什么写死一个数：折算只出现在报告里（「这一页 ≈ N tokens」），判据按字节算，所以这个数漂了不会
 * 让任何一格变色。它来自 2026-11-05 主 agent 在 relay 上逐份实测的比值。
 */
export const BYTES_PER_TOKEN = 3.4;

/**
 * 预算的向上取整粒度（字节）：`ceil512(实测)`。
 *
 * 为什么要取整：预算贴着实测写（`预算 = 实测`）等于零余量——多打一个空格就红，人于是学会了
 * 「先跑 `--sync` 再提交」，派生闸就退化成一道人人绕过的仪式。取整到 512 让一次正常的句子修正
 * 不必顺手改预算，同时 512 字节这个量级仍然远小于「又塞回一整段参考材料」。
 */
export const BUDGET_ROUNDING = 512;

/**
 * 取整之后再加的余量（字节）：**1024**，即总余量上限 512 + 1024 = 1536 ≤ 2048。
 *
 * 为什么不更大：余量就是「可以不红地长多少」。一次正当编辑（补一句纪律、把一条命令写清楚）在
 * 几百字节量级；把余量放到几千，等于把这条判据变成摆设。
 */
export const BUDGET_HEADROOM = 1024;

/**
 * 一份指令面文件**应有的**预算（字节）：`ceil512(实测) + 1024`。
 *
 * 这是本闸唯一一份「预算从哪来」的定义：`--sync` 写的就是它，`--verify` 比的就是它。
 * 手填任何别的数（哪怕更宽松）都是抄件，`--verify` 双向红。
 *
 * @param {number} bytes 实测字节数
 * @returns {number}
 */
export function budgetFor(bytes) {
  return Math.ceil(bytes / BUDGET_ROUNDING) * BUDGET_ROUNDING + BUDGET_HEADROOM;
}

/** 字节数折成 token（四舍五入；只用于报告，不参与判定）。 */
export function tokensOf(bytes) {
  return Math.round(bytes / BYTES_PER_TOKEN);
}

/**
 * 指令面每份文件的**字节预算**（issue #726 的长度判据，#909 后是本闸唯一的派生表）。
 *
 * 病根：#642 那把闸只看「面上有没有会过期的可变量」，**不看这张面有多长**——于是 AGENTS 一路长到
 * 112,464 字节（≈33k tokens），而它是 system prompt 的一部分、折叠不动它 ⇒ **每一轮都全额重发**。
 * 本闸是防复发的那一半：长度本身成为一条判据，超了就红。
 *
 * 纪律：
 *   · 预算**是派生态**：它由实测推出来（`budgetFor()` = `ceil512(实测) + 1024`），`--sync <文件>` 是
 *     **唯一合法**的改法；
 *   · `--verify <文件>` 逐格要求**等于推出来的那一格**，手改一个数字就红，**抄高抄低都是红**（双向）；
 *   · `--strict` 是棘轮：实测 > 预算 ⇒ 红，实测 ≤ 预算 ⇒ 绿（余量以内不红，这正是余量的用途）；
 *   · **空转即红**：预算表里有一行、指令面上却没有这份文件（死条目），或者预算被写成 0（不可能成立）。
 *
 * 表里写的是 `budgetFor(实测)`，不是实测本身：两者差的就是「可以不红地长多少」。
 *
 * @type {Readonly<Record<string, number>>}
 */
export const LENGTH_BUDGETS = Object.freeze({
  // issue #726 收口后：实测 32,548 字节 ⇒ ceil512 = 32,768 ⇒ + 1024 余量 = 33,792
  //（瘦身前 112,464 字节）。逐字保留 §1/§2/§4/§5/§6/§7/§8 与 §3 的纪律句，只把「碰到那道闸才需要读」
  // 的参考材料搬进 `docs/maintenance/command-reference.md` 之后的落点。
  // 想再降就继续搬参考材料，搬完跑 `--sync`——这个数只能由实测推出来，不许手填（--verify 逐格比）。
  // issue #731 T7 一度加长了指令面（一度到 33,082 ⇒ 这一格被 --sync 抬到 34,304），**已被回退**：
  // `test/project-instructions-716.test.js` 里 #721 那两条把这一格与注入上限 64 KiB 钉在一起
  // （单页必须整份注入；最坏两页组合 30,720 + 33,792 = 64,512）。抬到 34,304 之后组合是 65,024，
  // 余量只剩 512 字节，而这一格是**按 512 一档**往上刷的 ⇒ 下一次再加一句就会顶穿 65,536
  // （#721 修的正是「预算闸说合法、注入面装不下」）。所以正解是往冷层搬，不是抬预算：
  // §4 清单对账的说明性材料搬进了 `docs/maintenance/command-reference.md#release-day`（#726/#727 同一先例）。
  "AGENTS.md": 13824,
  // 同上。⚠ 本表注释里的「实测 X ⇒ …」全是**历史链条**，不是现值：现值只有上面那两个数，由 `--sync` 从实测刷、
  // 由 `--verify` 逐格对账（`--sync` 只改数字，从不改注释，所以注释里的数字必然过期——读它别当现值）。
  // issue #731 T7 中文侧同样回退（曾抬到 30,720）：两条闸互相知道的那道算的是 30,720 + 33,792，
  // 抬中文侧一样会把组合推过 65,536；说明性材料搬进 `docs/maintenance/command-reference_cn.md#release-day`。
  "AGENTS_cn.md": 13824,
});

// ── 3. 覆盖面（只取**入库**文件，清单 = `git ls-files`） ──────────────────────
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
 * 一份 pathspec 的**入库**文件清单（只取 `git ls-files`）。
 *
 * `git` 不可用 / 不在仓库内 / 仓库顶层不是本脚本所在目录 / 清单为空 ⇒ **抛错**，由 `runCli` 显式报
 * exit 2。**没有**文件系统回退分支：静默回退等于把「开发树与干净克隆两个答案」留在原地。
 *
 * @param {{root?: string, io?: {exec?: (args: string[], root: string) => string}, pathspecs?: readonly string[],
 *   suffix?: string|null, what?: string}} [options]
 * @returns {string[]} 仓库相对路径，已去重排序
 */
export function gitTrackedFiles({ root = ROOT, io, pathspecs = DIRECTIVE_FILES, suffix = ".md", what = "扫描清单" } = {}) {
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

// ── 4. 长度判据（#909 后本闸唯一的一份判据） ──────────────────────────────────
/**
 * 长度判据（issue #726）：指令面每份文件的字节数 vs 预算。
 *
 * 方向是**棘轮**：超预算 ⇒ 红（新长出来的字节必须要么搬进冷层、要么跑 `--sync` 把预算抬上去并在报告里说明）；
 * 低于预算 ⇒ 绿 + 提示「可降到 N」（清账永不红）；`--verify` 另外要求**相等**。
 *
 * 空转即红（两条）：预算表里有这一行、指令面上却没有这份文件（死条目，改名/删文件留下的）；
 * 预算被写成 0（文件至少有一个字节，0 这个格子永远不可能成立）。
 *
 * @param {{measured: Map<string, number>, budgets?: Readonly<Record<string, number>>}} input
 * @returns {{overBudget: Array<object>, unregisteredBudget: Array<object>, idleBudgets: Array<object>,
 *   downgradableBudget: Array<object>, counts: {overBudget: number, unregisteredBudget: number,
 *   idleBudgets: number}}}
 */
export function lengthVerdicts({ measured, budgets = LENGTH_BUDGETS }) {
  const overBudget = [];
  const unregisteredBudget = [];
  const idleBudgets = [];
  const downgradableBudget = [];
  for (const [file, bytes] of measured) {
    const budget = budgets[file];
    if (budget === undefined) {
      unregisteredBudget.push({ file, bytes, tokens: tokensOf(bytes) });
      continue;
    }
    if (bytes > budget) {
      overBudget.push({
        file, bytes, budget, over: bytes - budget,
        tokens: tokensOf(bytes), budgetTokens: tokensOf(budget), overTokens: tokensOf(bytes - budget),
      });
    } else {
      // 绿不等于「什么都不用说」：预算与推出来的那一格（`budgetFor(实测)`）不一致（但仍在实测之上）时提示，
      // `--sync` 会把这一格写成 `budgetFor(实测)`——抄高抄低都提示，抄件在 `--verify` 才是红。
      const derived = budgetFor(bytes);
      if (budget !== derived) {
        downgradableBudget.push({ file, bytes, budget, derived, headroom: budget - bytes });
      }
    }
  }
  for (const [file, budget] of Object.entries(budgets)) {
    if (!measured.has(file)) {
      idleBudgets.push({ file, budget, why: "预算表里有这一行，指令面上却没有这份文件（死条目）" });
    } else if (!(budget > 0)) {
      idleBudgets.push({ file, budget, why: "预算不是正数：文件至少有一个字节，这个格子永远不可能成立" });
    }
  }
  return {
    overBudget, unregisteredBudget, idleBudgets, downgradableBudget,
    counts: {
      overBudget: overBudget.length,
      unregisteredBudget: unregisteredBudget.length,
      idleBudgets: idleBudgets.length,
    },
  };
}

/**
 * 把一次扫描折成「红数」与逐格明细。**文本分支与 `--json` 分支都只读这里**（同家族 #575 A 的病根：
 * 同一套判据写两遍、其中一遍没写全 ⇒ 假绿）。
 *
 * #909 后红集合只剩三条（都来自 `lengthVerdicts`，少一条就是假绿）：
 *   · `overBudget`：指令面某份文件的字节数 > 预算（issue #726 的长度判据）；
 *   · `unregisteredBudget`：指令面上的文件没有字节预算行（新入指令面却忘了钉预算）；
 *   · `idleBudgets`：预算行没有对应文件（死条目）或预算被写成 0（不可能成立的格子）。
 *
 * `downgradableBudget` 不是红：预算与 `budgetFor(实测)` 不一致但仍在实测之上 ⇒ 绿 + 提示「--sync 会把这一格
 * 写成 N」。抄高抄低真正被拦在 `--verify`（双向红）——`--strict` 只负责「长度不许长过预算」这一条。
 *
 * @param {{length: object}} input
 * @returns {{overBudget: Array<object>, unregisteredBudget: Array<object>, idleBudgets: Array<object>,
 *   downgradableBudget: Array<object>, red: number,
 *   counts: {overBudget: number, unregisteredBudget: number, idleBudgets: number}}}
 */
export function gateVerdicts({ length }) {
  const red = length.counts.overBudget + length.counts.unregisteredBudget + length.counts.idleBudgets;
  return {
    overBudget: length.overBudget,
    unregisteredBudget: length.unregisteredBudget,
    idleBudgets: length.idleBudgets,
    downgradableBudget: length.downgradableBudget,
    counts: length.counts,
    red,
  };
}

/**
 * 红数 → 退出码。**唯一**一处把 `--strict` 应用上去的地方（文本分支与 `--json` 分支共用）。
 * 报告模式恒 0（既有语义：那是给人读的视图）；`--strict` 下红数 0 ⇒ 0，否则 1。
 */
export function gateExitCode(gate, { strict }) {
  if (!strict) return 0;
  return gate.red === 0 ? 0 : 1;
}

// ── 5. 一次完整扫描（`root` / `io` 可注入 ⇒ 自测在临时树上跑真实路径） ────────
/**
 * 扫一次：清单（`git ls-files`）→ 实测字节 → 长度判据。
 *
 * 预算只量**指令面**（issue #726）：`docs/` 与 `CHANGELOG.md` 不进预算，它们不是每轮重发的那张面。
 * #909 后不再有分类 / 命中 / 例外 / 上限表——那三类文本启发式连同它们的真值名单（门禁常量表、外部仓前缀）
 * 一起退账。
 *
 * @param {{root?: string, io?: object, budgets?: Readonly<Record<string, number>>}} [options]
 * @returns {{manifest: string[], report: Array<object>, gate: object, budgets: object,
 *   measuredBytes: Map<string, number>, length: object}}
 */
export function scanDirectives({ root = ROOT, io, budgets = LENGTH_BUDGETS } = {}) {
  // #560：只取 git manifest；git 拿不到 / 清单为空 ⇒ gitTrackedFiles 抛错，由 runCli 折成 exit 2。
  const manifest = gitTrackedFiles({ root, io });
  const measuredBytes = new Map();
  const report = [];
  for (const rel of manifest) {
    let text;
    try {
      text = readFileSync(path.join(root, rel), "utf8");
    } catch (error) {
      throw new Error(`清单里的 ${rel} 读不到（${errorLine(error)}）：`
        + "`git ls-files` 列出的入库文件必须在盘上，否则扫描面与实际内容不符");
    }
    const bytes = Buffer.byteLength(text, "utf8");
    measuredBytes.set(rel, bytes);
    report.push({ file: rel, bytes });
  }
  const length = lengthVerdicts({ measured: measuredBytes, budgets });
  const gate = gateVerdicts({ length });
  return { manifest, report, gate, budgets, measuredBytes, length };
}

// ── 6. 字节预算表的刷写与验表（`--sync` / `--verify`，家族口径） ──────────────
/**
 * 为什么要有 `--sync`（issue #644 ②）：预算是**派生态**（实测值的钉子），但手改没有任何东西能证明抄对了，
 * 而且抄**高**在 `--strict` 下是**绿的**（棘轮只咬「实测 > 预算」），所以「手抄错」是这道门里唯一没闸的东西。
 *
 * 家族标准（`--sync` / `--verify` 这一族现在只剩本脚本：`scripts/flat-count-inventory.mjs` 的台账与 `--sync` 已随 #907 撤走、`scripts/mutation-sample-check.mjs` 的 `--sync` / `--verify` 那半句已随 #906 撤走）：
 *   · `--sync <文件>`：**刷表**。数字由实测重写 —— 这是**唯一合法**的改预算方式；
 *   · `--verify <文件>`：**验表**。逐格与 `budgetFor(实测)` 比，**不改任何文件**；任一处不一致 ⇒ exit 1 并点名。
 * 两者都比 `--strict` 更紧：`--strict` 是棘轮（实测 ≤ 预算即绿，允许余量），`--sync` / `--verify`
 * 要求**相等**（表是量出来的，不是写出来的）⇒ 手抄高一位也红。
 *
 * 少传路径不是崩溃，是明确的用法错误（exit 2 + 用法）；先校验参数、再碰文件系统。
 */
const BUDGET_TABLE_USAGE = [
  "用法：node scripts/agents-directive-scan.mjs --sync <文件>   # 刷字节预算表（唯一合法改法）",
  "      node scripts/agents-directive-scan.mjs --verify <文件> # 验字节预算表（逐格 = ceil512(实测) + 1024）",
  "目标必须是本仓内含 `export const LENGTH_BUDGETS = Object.freeze({ ... })` 的源文件（通常是本脚本自身）。",
].join("\n");

/** `--sync` / `--verify` 的字节预算表（issue #726）。 */
function lengthBlockOf(text) {
  const m = /(export const LENGTH_BUDGETS = Object\.freeze\(\{)([\s\S]*?)(\n\}\);)/.exec(text);
  if (m === null) {
    throw new Error("这份文件里抽不到 `export const LENGTH_BUDGETS = Object.freeze({ … });`——"
      + "字节预算表不是这个形状，`--sync` / `--verify` 没有可对账的真值（拒绝静默成功）");
  }
  return { head: m[1], body: m[2], tail: m[3], start: m.index, end: m.index + m[0].length };
}

/** 表里的一行：`  "AGENTS.md": 29775,`。 */
const LENGTH_ROW_RE = /\n  "([^"]+)": (\d+),/g;

/**
 * 从源码文本里读字节预算表（**只读文本**，不读模块常量 ⇒ 自测能对一份副本对账）。
 *
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function budgetsFromSource(text) {
  const { body } = lengthBlockOf(text);
  const rows = new Map();
  for (const m of body.matchAll(LENGTH_ROW_RE)) rows.set(m[1], Number(m[2]));
  if (rows.size === 0) {
    throw new Error("`LENGTH_BUDGETS` 块里一行都抽不到——表被改坏了（拒绝静默成功）");
  }
  return rows;
}

/**
 * 验预算表：逐格与**推出来的那一格**（`budgetFor(实测)`）比。**不改任何文件**，返回问题清单（空 = 绿）。
 *
 * 为什么比推出来的值而不是比实测：预算的用途是留一点余量（`ceil512 + 1024`），所以它天然不等于实测；
 * 真正的“抄件”是「人手写上去的任何一个数字」——而唯一合法的数字是那个函数算出来的。
 * 比它大 ⇒ 余量被手工放宽（今天不红，明天就能塞回一整段参考材料）；比它小 ⇒ 贴上限或已经超了。
 * 两个方向都红，这就是“双向”。
 *
 * @param {{text: string, measured: Map<string, number>}} input
 * @returns {string[]}
 */
export function verifyBudgets({ text, measured }) {
  const table = budgetsFromSource(text);
  const problems = [];
  for (const [file, bytes] of measured) {
    const budget = table.get(file);
    if (budget === undefined) {
      problems.push(`${file}：指令面上有这份文件，字节预算表里却没有它的行（新入指令面却忘了钉预算；`
        + "`--sync` 不替你编理由注释，人手加一条再跑 --sync）");
      continue;
    }
    if (budget !== budgetFor(bytes)) {
      problems.push(`${file}：预算 ${budget} / 实测 ${bytes} 字节（≈${tokensOf(bytes)} tokens）——`
        + `这一格应该是 ${budgetFor(bytes)}（= ceil${BUDGET_ROUNDING}(${bytes}) + ${BUDGET_HEADROOM}），`
        + `差 ${budget - budgetFor(bytes)} 字节（手改派生数 = 伪造，抄高抄低都是红；跑 --sync）`);
    }
  }
  for (const file of table.keys()) {
    if (!measured.has(file)) {
      problems.push(`${file}：预算表里有这一行，指令面上却没有这份文件（死条目：文件名改了或文件删了，`
        + "人手决定删掉还是改回来）");
    }
  }
  return problems;
}

/**
 * 刷预算表：把每一行的数字重写成**推出来的那一格**（`budgetFor(实测)`；**只碰数字**，行尾的理由注释一个字不动）。
 *
 * @param {{text: string, measured: Map<string, number>}} input
 * @returns {{text: string, changes: Array<{file: string, from: number, to: number}>,
 *   missing: string[], dead: string[]}}
 */
export function syncBudgets({ text, measured }) {
  const { head, body, tail, start, end } = lengthBlockOf(text);
  const table = budgetsFromSource(text);
  const missing = [...measured.keys()].filter((file) => !table.has(file));
  const dead = [...table.keys()].filter((file) => !measured.has(file));
  const changes = [];
  const rebuilt = body.replace(LENGTH_ROW_RE, (row, file, digits) => {
    const bytes = measured.get(file);
    if (bytes === undefined) return row;
    const next = budgetFor(bytes);
    if (Number(digits) !== next) changes.push({ file, from: Number(digits), to: next, measured: bytes });
    return `\n  "${file}": ${next},`;
  });
  return { text: `${text.slice(0, start)}${head}${rebuilt}${tail}${text.slice(end)}`, changes, missing, dead };
}

/** 字节预算的实测面（一次扫描，不跑第二遍）。 */
function measuredBytesForTable({ root, io }) {
  return scanDirectives({ root, io, budgets: {} }).measuredBytes;
}

/** 目标文件必须是**本仓内**的路径（刷仓库外的文件等于给「手抄」开一条后门）。 */
function resolveTableTarget(target, root) {
  const abs = path.resolve(root, target);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`目标文件 ${target} 不在仓库内（${root}）——预算表只许刷本仓里的源文件`);
  }
  return { abs, rel: rel.split(path.sep).join("/") };
}

/** `--verify <文件>`：验预算表，不改文件。退出码 0 = 逐格等于推出来的那一格，1 = 有格不一致，2 = 门自己坏了。 */
function mainVerifyTable({ target, root, io }) {
  let rel;
  let text;
  let measuredBytes;
  try {
    const resolved = resolveTableTarget(target, root);
    rel = resolved.rel;
    text = readFileSync(resolved.abs, "utf8");
    measuredBytes = measuredBytesForTable({ root, io });
  } catch (error) {
    console.error(`agents-directive-scan --verify: ${error.message}`);
    return 2;
  }
  let problems;
  try {
    problems = verifyBudgets({ text, measured: measuredBytes });
  } catch (error) {
    console.error(`agents-directive-scan --verify: ${error.message}`);
    return 2;
  }
  console.log(`agents-directive-scan --verify：${rel}`);
  if (problems.length > 0) {
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    console.log(`agents-directive-scan: 失败 — ${problems.length} 处不一致`
      + "（字节预算是量出来的：跑 `--sync`，不许手改）");
    return 1;
  }
  console.log(`  ${measuredBytes.size} 份指令面文件的字节数逐格等于推出来的那一格（ceil${BUDGET_ROUNDING}(实测) + ${BUDGET_HEADROOM}）`);
  console.log(`复跑：node scripts/agents-directive-scan.mjs --verify ${rel}`);
  return 0;
}

/** `--sync <文件>`：刷预算表（唯一合法的改法），刷完当场复验。退出码 0 = 刷完绿，1 = 有刷不动的红，2 = 门坏了。 */
function mainSyncTable({ target, root, io }) {
  let rel;
  let abs;
  let text;
  let measuredBytes;
  try {
    const resolved = resolveTableTarget(target, root);
    ({ rel, abs } = resolved);
    text = readFileSync(abs, "utf8");
    measuredBytes = measuredBytesForTable({ root, io });
  } catch (error) {
    console.error(`agents-directive-scan --sync: ${error.message}`);
    return 2;
  }
  let budgetResult;
  try {
    budgetResult = syncBudgets({ text, measured: measuredBytes });
  } catch (error) {
    console.error(`agents-directive-scan --sync: ${error.message}`);
    return 2;
  }
  console.log(`agents-directive-scan --sync：${rel}`);
  const unfixable = [];
  for (const file of budgetResult.missing) {
    unfixable.push(`${file}：指令面上有这份文件，字节预算表里没有它的行——人手加一条（连理由注释），再跑 --sync`);
  }
  for (const file of budgetResult.dead) {
    unfixable.push(`${file}：字节预算表里有这一行，指令面上没有这份文件——人手决定删掉它还是把文件名改回来`);
  }
  if (unfixable.length > 0) {
    for (const line of unfixable) console.log(`  ✗ ${line}`);
    console.log("agents-directive-scan: 刷不动 —— 上面这些不是预算数值能修的（不写文件）");
    return 1;
  }
  const nextText = budgetResult.text;
  if (nextText !== text) writeFileSync(abs, nextText);
  for (const change of budgetResult.changes) {
    console.log(`  ${change.to > change.from ? "↑" : "↓"} ${change.file} 字节预算：`
      + `${change.from} → ${change.to}（实测 ${change.measured} ⇒ ceil${BUDGET_ROUNDING} + ${BUDGET_HEADROOM}；`
      + `≈${tokensOf(change.to)} tokens；${change.to > change.from
        ? "抬高 = 这张面又长长了，先在报告里写明为什么" : "清账"}）`);
  }
  console.log(`  改动 ${budgetResult.changes.length} 格（数字由实测重写；行尾的理由注释一个字都没碰）`);
  const problems = verifyBudgets({ text: nextText, measured: measuredBytes });
  if (problems.length > 0) {
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    console.log("agents-directive-scan: 刷完仍有不一致 —— 上面这些不是预算数值能修的");
    return 1;
  }
  console.log("刷完复验：逐格等于实测");
  return 0;
}

// ── 7. 输出（两条分支都只读 `gate`，不自己算红） ─────────────────────────────
/** 人读视图。返回值 = 退出码（由 `gateExitCode` 给；本函数不自己拼红数）。 */
function printReport({ manifest, report, gate, budgets }, { strict }) {
  const measuredBytes = new Map(report.map((r) => [r.file, r.bytes]));
  console.log("agents-directive-scan: AGENTS 指令面字节预算（issue #726）");
  console.log(`  判定面 = git ls-files（AGENTS 那一对，共 ${manifest.length} 份；#560：只取清单，不退回文件系统遍历）`);
  console.log("  #909：三类文本启发式（状态声明 / 手抄件上限表 / 裸坐标）已删，本闸只判字节预算");

  console.log("\n指令面长度（字节预算，每轮全额重发）：");
  for (const [file, bytes] of measuredBytes) {
    const budget = budgets[file];
    if (budget === undefined) {
      console.log(`  ✗ ${file}: 实测 ${bytes} 字节（≈${tokensOf(bytes)} tokens）：指令面上有这份文件，预算表里却没有它的行`);
      continue;
    }
    if (bytes > budget) {
      console.log(`  ✗ ${file}: 实测 ${bytes} > 预算 ${budget}（超 ${bytes - budget}，≈${tokensOf(bytes - budget)} tokens）`);
    } else {
      const derived = budgetFor(bytes);
      const hint = budget !== derived ? `  ← --sync 会把这一格刷成 ${derived}` : "";
      console.log(`  ✓ ${file}: 实测 ${bytes} / 预算 ${budget}（余量 ${budget - bytes}，≈${tokensOf(bytes)} tokens）${hint}`);
    }
  }
  for (const entry of gate.downgradableBudget) {
    console.log(`  ~ ${entry.file}: --sync 会把预算刷成 ${entry.derived}（当前 ${entry.budget}，差 ${entry.budget - entry.derived} 字节）`);
  }
  console.log(`    换算口径：${BYTES_PER_TOKEN} 字节/token（折算只给人看，判定按字节，见 BYTES_PER_TOKEN）`);

  console.log("\n判据（#909 后唯一一条）：");
  console.log("  ⑥ 字节预算：实测 ≤ ceil512(实测) + 1024，且表里有这一行且为正数");
  console.log("  已删：① 状态声明 ② 手抄件上限表 ③ 裸坐标——假版本号不再报红，真值由 check:docs 的版本对账管");

  const redLines = [];
  for (const entry of gate.overBudget) redLines.push(`${entry.file} 超预算 ${entry.over} 字节`);
  for (const entry of gate.unregisteredBudget) redLines.push(`${entry.file} 缺字节预算行`);
  for (const entry of gate.idleBudgets) redLines.push(`预算行「${entry.file}」空转（${entry.why}）`);
  console.log(`\n总判词：${gate.red === 0 ? "绿" : "红"}（红 ${gate.red} 处 = 超预算 ${gate.counts.overBudget} + 未登记预算 ${gate.counts.unregisteredBudget} + 空转预算 ${gate.counts.idleBudgets}；另有可降预算提示 ${gate.downgradableBudget.length} 处）`);
  if (redLines.length > 0) {
    console.log("红项：");
    for (const line of redLines) console.log(`  ✗ ${line}`);
  }

  if (strict) return gateExitCode(gate, { strict });
  console.log("当前是报告模式（给人读的视图，恒 exit 0）；要拿它当门：加 --strict");
  console.log("派生预算表怎么改（**手改派生数 = 伪造**）：`node scripts/agents-directive-scan.mjs --sync <文件>` 把预算重写成 ceil512(实测) + 1024，`--verify <文件>` 双向逐格验（抄高抄低都红）");
  return 0;
}

// ── 8. 自测（合成树夹具上把真实路径跑一遍，不碰真文档、不假造判词） ───────────
async function selfTest() {
  let failures = 0;
  const eq = (actual, expected, what) => {
    if (actual !== expected) { failures += 1; console.error(`  ✗ ${what}：期望 ${expected}，实测 ${actual}`); }
  };
  const ok = (cond, what) => { if (!cond) { failures += 1; console.error(`  ✗ ${what}`); } };

  // ① #560 红线：git 拿不到 / 清单为空 ⇒ 抛错，**不退回文件系统遍历**。预算实测必须走 manifest。
  let threw = false;
  try { gitTrackedFiles({ root: "/no/such/repo", io: { exec: () => { throw new Error("git 不可用"); } } }); }
  catch { threw = true; }
  ok(threw, "git 不可用时 gitTrackedFiles 必须抛错（不静默回退文件系统遍历）");
  threw = false;
  try { gitTrackedFiles({ root: ROOT, io: { exec: (args) => (args[0] === "rev-parse" ? ROOT : "") } }); }
  catch { threw = true; }
  ok(threw, "清单为空（0 份入库文件）必须抛错（这道门会假绿）");

  // 合成指令面树（两页 AGENTS + 一把注入的假 git 执行器）。
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "erix-budget-fixture-")));
  try {
    mkdirSync(dir, { recursive: true });
    const enBody = "# Fixture EN\n" + "lorem ipsum dolor sit amet ".repeat(60) + "\n";
    const cnBody = "# 夹具 中文\n" + "之乎者也。".repeat(150) + "\n";
    const writeBoth = (en, cn) => { writeFileSync(path.join(dir, "AGENTS.md"), en); writeFileSync(path.join(dir, "AGENTS_cn.md"), cn); };
    writeBoth(enBody, cnBody);
    const enBytes = Buffer.byteLength(enBody, "utf8");
    const cnBytes = Buffer.byteLength(cnBody, "utf8");
    const budgets = Object.freeze({ "AGENTS.md": budgetFor(enBytes), "AGENTS_cn.md": budgetFor(cnBytes) });
    const io = { exec: (args) => (args[0] === "rev-parse" ? dir : "AGENTS.md\0AGENTS_cn.md\0") };

    // ② budgetFor 的公式（派生格的定义）。
    eq(budgetFor(enBytes), Math.ceil(enBytes / 512) * 512 + 1024, "budgetFor = ceil512(实测) + 1024");

    // ③ 派生预算表 + 未变文件 ⇒ 绿（红数 0）。
    eq(scanDirectives({ root: dir, io, budgets }).gate.red, 0, "派生预算表 + 未变文件 ⇒ 红数应为 0");

    // ④ 实测 > 预算 ⇒ 超预算红（棘轮方向）。
    const overBudget = { "AGENTS.md": Math.max(1, enBytes - 10), "AGENTS_cn.md": budgets["AGENTS_cn.md"] };
    ok(scanDirectives({ root: dir, io, budgets: overBudget }).gate.counts.overBudget === 1, "实测 > 预算 ⇒ 超预算红");

    // ⑤ 票面点名的反向证：往合成 AGENTS.md 末尾灌 2 KB 废话 ⇒ --strict 必红。
    writeBoth(enBody + "\n" + "y".repeat(2048) + "\n", cnBody);
    eq(await runCli({ argv: ["--strict"], root: dir, io, budgets }), 1, "灌 2 KB 废话（预算未抬）⇒ runCli --strict 必返回 1");

    // ⑥ 撤掉废话 ⇒ 回绿。
    writeBoth(enBody, cnBody);
    eq(await runCli({ argv: ["--strict"], root: dir, io, budgets }), 0, "撤掉 2 KB 废话后必须回绿");

    // ⑦ 「假版本号不再报红」（#909 有意的行为改变）：写一句状态声明句，红数仍 0。
    writeBoth(enBody + "\n当前版本是 9.9.9。\n", cnBody);
    eq(await runCli({ argv: ["--strict"], root: dir, io, budgets }), 0, "写一句假版本号（短到不超预算）⇒ 不再报红（#909 行为改变）");
    writeBoth(enBody, cnBody);

    // ⑧ 预算表里有行、面上没这份文件 ⇒ 空转预算红。
    ok(scanDirectives({ root: dir, io, budgets: { ...budgets, "AGENTS_gone.md": 5000 } }).gate.counts.idleBudgets >= 1,
      "预算行没对应文件 ⇒ 空转预算红");

    // ⑨ 面上有文件却没预算行 ⇒ 未登记预算红。
    ok(scanDirectives({ root: dir, io, budgets: { "AGENTS.md": budgets["AGENTS.md"] } }).gate.counts.unregisteredBudget >= 1,
      "指令面有文件却没预算行 ⇒ 未登记预算红");

    // ⑩ --sync / --verify 往返：手填的表 verifyBudgets 报不一致；syncBudgets 刷成推出来的那一格；刷完复验绿。
    const tableSrc = "export const LENGTH_BUDGETS = Object.freeze({\n  // 手填\n  \"AGENTS.md\": 9999,\n  // 手填\n  \"AGENTS_cn.md\": 8888,\n});\n";
    const measured = new Map([["AGENTS.md", enBytes], ["AGENTS_cn.md", cnBytes]]);
    ok(verifyBudgets({ text: tableSrc, measured }).length > 0, "手填的表 ≠ 推出来的那一格 ⇒ verifyBudgets 报不一致");
    const synced = syncBudgets({ text: tableSrc, measured });
    eq(synced.changes.length, 2, "syncBudgets 应重写两格");
    eq(verifyBudgets({ text: synced.text, measured }).length, 0, "刷完复验必须逐格等于推出来的那一格");
    eq(budgetsFromSource(synced.text).get("AGENTS.md"), budgetFor(enBytes), "budgetsFromSource 读回刷出来的那一格");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nagents-directive-scan --self-test: ${failures === 0
    ? "OK — 全部字节预算判据反向证通过（#909：只留预算这一条）"
    : `${failures} 例失败`}`);
  return failures === 0 ? 0 : 1;
}

// ── 9. main ──────────────────────────────────────────────────────────────────
/**
 * 一次 CLI 运行。`root` / `io` / `budgets` 可注入 ⇒ 自测能在**临时树**上把真实路径（清单 → 实测 → 判据 →
 * 退出码）整条跑一遍，不碰真文档、也不假造判词。
 *
 * 模式（互斥，别混）：`--strict` 门禁 / 报告 / `--json` / `--sync <文件>` 刷预算表 / `--verify <文件>`
 * 验预算表 / `--self-test` 反向证。
 *
 * @param {{argv?: string[], root?: string, io?: {exec?: (args: string[], root: string) => string},
 *   budgets?: Readonly<Record<string, number>>}} [options]
 * @returns {Promise<number>} 进程退出码
 */
export async function runCli({ argv = process.argv.slice(2), root = ROOT, io, budgets = LENGTH_BUDGETS } = {}) {
  const strict = argv.includes("--strict");
  const jsonOut = argv.includes("--json");
  const selfTestMode = argv.includes("--self-test");
  const syncMode = argv.includes("--sync");
  const verifyTableMode = argv.includes("--verify");

  if (selfTestMode) return selfTest();

  // 预算表的刷写 / 验表。**先校验参数再碰文件系统**：少传路径是明确的用法错误（exit 2），
  // 不是 `readFileSync(undefined)` 那类崩溃。
  if (syncMode || verifyTableMode) {
    const mode = syncMode ? "--sync" : "--verify";
    if (syncMode && verifyTableMode) {
      console.error("agents-directive-scan: `--sync` 与 `--verify` 是两种模式（刷表 / 验表），不许同时给");
      console.error(BUDGET_TABLE_USAGE);
      return 2;
    }
    const target = argv.find((arg) => !arg.startsWith("--"));
    if (target === undefined) {
      console.error(`agents-directive-scan ${mode}: 缺少目标文件路径（${mode} 后面要跟一份含 \`LENGTH_BUDGETS\` 的源文件）`);
      console.error(BUDGET_TABLE_USAGE);
      return 2;
    }
    return syncMode ? mainSyncTable({ target, root, io }) : mainVerifyTable({ target, root, io });
  }

  let scan;
  try {
    scan = scanDirectives({ root, io, budgets });
  } catch (error) {
    console.error(`agents-directive-scan: ${error.message}`);
    console.error(`  仓库根：${root}`);
    return 2;
  }
  const { gate, manifest, report } = scan;
  const measuredBytes = Object.fromEntries([...scan.measuredBytes].map(([file, bytes]) => [file, bytes]));
  const exitCode = gateExitCode(gate, { strict });

  if (jsonOut) {
    console.log(JSON.stringify({
      surface: { source: "git ls-files", pathspecs: [...DIRECTIVE_FILES], files: manifest.length },
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
        overBudget: gate.overBudget,
        unregisteredBudget: gate.unregisteredBudget,
        idleBudgets: gate.idleBudgets,
        downgradableBudget: gate.downgradableBudget,
      },
      length: {
        // 判定按字节；tokens 只是给人看的折算（比值不是常数，见 `BYTES_PER_TOKEN`）。
        bytesPerToken: BYTES_PER_TOKEN,
        budgets,
        measured: measuredBytes,
        tokens: Object.fromEntries(Object.entries(measuredBytes).map(([file, bytes]) => [file, tokensOf(bytes)])),
      },
      files: report.map((r) => ({ file: r.file, bytes: r.bytes })),
    }, null, 2));
    if (exitCode !== 0) {
      console.error(`agents-directive-scan --strict --json: ${gate.red} 处红`
        + `（超预算 ${gate.counts.overBudget} / 未登记预算 ${gate.counts.unregisteredBudget}`
        + ` / 空转预算 ${gate.counts.idleBudgets}）`);
    }
    return exitCode;
  }
  return printReport(scan, { strict });
}

// 入口：本文件是 CLI（被 `import` 时也照旧跑一遍）。退出码走 `process.exitCode`，不用 `process.exit()`——
// 后者会跳过 stdout 的冲刷，`--json` 的大段输出可能被截断。
process.exitCode = await runCli();
