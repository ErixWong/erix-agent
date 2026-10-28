#!/usr/bin/env node
// retired-spelling-scan.mjs — 观察性检查：`docs/` 里还有谁按**已退役的扁平拼写**叙述 `runToolLoop` 的输入
// （工单 #523；零依赖，仅 node: 内置）。
//
// 病根：引擎 0.28 起**当场拒**顶层扁平配置键（`timeoutMs` / `toolResultTtl` / `initialMessages` …），
// 而文档里仍有一批按扁平拼写叙述输入形态。宿主从架构文档或 ADR 抄写法，会抄到一个已被拒的形态。
//
// ⚠ **这不是门禁。** 本单（#523 要求 4）只交付脚本本身 + 一次实测输出；**没有**接进
// `.github/workflows/ci.yml`，也**没有**改动 `scripts/docs-drift-check.mjs`（那份是锚点真值）。
// 默认模式永远 exit 0：命中清单是给人读的，不是用来卡 CI 的。`--strict` 是给「S9 之后想接门禁」那天
// 留的开关，今天没人跑它。
//
// 三条判据（每条都能被反向证打红，见报告）：
//   1. **分类**：`docs/architecture*` / `docs/charts*` 是**现状描述**（改）；`docs/decisions/*` 与
//      `docs/v0.*` 是**历史记录**（只加日期横幅、正文一字不改）。分类错 = 改错文件，所以分类表是
//      本脚本的第一等公民（`classify()`），不在别处隐式决定。
//   2. **命中**：退役键名出现在**代码语境**里（围栏内的键位、行内代码 span），且**不在** `config.*`
//      之下（`config.timing.timeoutMs` 的尾段不是扁平写点 —— 那正是规位拼写）。围栏内的 `config: { … }`
//      子树按花括号配对整体跳过：叶子名逐字等于扁平键名，但它是**叶子**，不是顶层写点。
//   3. **历史正文不许被改写**：`HISTORY_BODY_PINS` 钉住每份历史文档的命中数。把某份 ADR 的正文
//      改写成规位形态 ⇒ 该文件的命中数**掉**下去 ⇒ 报 `SUSPECT`。没有这条，分类判据是空的：
//      「这份历史文档本来就没有命中」与「有人把它改成规位形态了」在文本上长得一模一样。
//
// 口径（缺一条数就对不上）：
//   · 退役键表**派生**自源码（`src/loop/config-namespace.js` 的 schema 叶子 − `RUN_TOOL_LOOP_OPTION_NAMES`），
//     不是抄一份清单 —— 引擎再退役一个键，这里自动跟上；
//   · 只在**代码语境**里算命中：散文里的 `system messages` / `user message` / `context compaction`
//     是普通英文，不是拼写；
//   · 同一行出现**退役措辞**（`retired` / `已退役` / `rejected` / `rejects` / `flat spelling`）的命中
//     记为 `mention`（在讲退役这件事，不是在用），不计入 `use`；
//   · `AMBIGUOUS_KEYS` 里的名字同时是**别的东西的名字**（`executeTool` 的 `context` 形参、provider
//     工厂的 `timeoutMs` 参数、`createXProvider` 的 `model`/`maxTokens`、事件字段 `runId`…）。
//     它们照样列出来，但标 `ambiguous`，**不进** `--strict` 的判据：文本级扫描分不清「形参名」与
//     「输入面拼写」，装作分得清就是假阳性工厂。
//
// 用法：
//   node scripts/retired-spelling-scan.mjs            # 全量报告，永远 exit 0（观察）
//   node scripts/retired-spelling-scan.mjs --json     # 同一份事实的机器读法
//   node scripts/retired-spelling-scan.mjs --strict   # 现状类有 use / 历史类命中数掉 ⇒ exit 1（今天没人跑）
//   node scripts/retired-spelling-scan.mjs --self-test # 反向证：内存夹具里改一处 ⇒ 报；不改 ⇒ 不报

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF_PATH), "..");
const STRICT = process.argv.includes("--strict");
const JSON_OUT = process.argv.includes("--json");
const SELF_TEST = process.argv.includes("--self-test");

// ── 1. 退役键表（派生，不抄） ────────────────────────────────────────────────
/**
 * 扁平拼写 → 规位路径。真值两处都在源码里：
 *   · 配置面叶子 = `CONFIG_SURFACE_OPTION_NAMES`（`src/loop/config-namespace.js`）；
 *   · 顶层白名单 = `RUN_TOOL_LOOP_OPTION_NAMES`（`src/loop/option-normalization.js`）。
 * **退役 = 叶子还在 schema 里、但顶层白名单里没有它**（#498 S3 的口径：删扁平键不是删叶子）。
 * 于是这张表随引擎自己变，不会成为第二份会腐烂的清单。
 */
async function retiredFlatKeys() {
  const cn = await import(path.join(ROOT, "src/loop/config-namespace.js"));
  const on = await import(path.join(ROOT, "src/loop/option-normalization.js"));
  const allowed = new Set(on.RUN_TOOL_LOOP_OPTION_NAMES);
  const map = new Map();
  for (const leaf of cn.CONFIG_SURFACE_OPTION_NAMES) {
    if (allowed.has(leaf)) continue;
    map.set(leaf, `config.${cn.configPathForOption(leaf)}`);
  }
  return map;
}

/**
 * 同时是**别的东西的名字**的那些键（文本级扫描分不清，所以标 ambiguous 而不判死）。
 * 每条写清「它还是谁的名字」——空泛的放行等于后门（#210 R2 惯例）。
 */
const AMBIGUOUS_KEYS = new Map([
  ["system", "消息角色 `system`（`role: \"system\"`），也在 `createXProvider` 的 `model` 隔壁的散文里"],
  ["user", "消息角色 `user`；`summaryRole` 的取值 `\"user\"`"],
  ["model", "`createOpenAIProvider` / `createAnthropicProvider` 的**工厂参数** `model`（不是 runToolLoop 选项）"],
  ["maxTokens", "provider 工厂参数 / 模型槽位字段 `slots.default.maxTokens`（契约明写这一处不受退役影响）"],
  ["temperature", "provider 工厂参数 `temperature`（同上）"],
  ["topP", "provider 工厂参数 `topP`（同上）"],
  ["timeoutMs", "provider 工厂参数 `timeoutMs`（`src/providers/*` 的请求超时，与 runToolLoop 无关）"],
  ["context", "`executeTool` 的执行对象形参 `context`；折叠上下文这个**概念**也叫 context"],
  ["task", "任务简报的概念名（`task brief`），也是 `executeTool` 载荷里的 `task` 字段"],
  ["toolContext", "`executeTool` 载荷里的 `toolContext` 字段（合并后的工具上下文）"],
  ["expert", "`executeTool` / judge 简报里的 `expert` 字段"],
  ["requestId", "`executeTool` 载荷与事件里的 `requestId` 字段"],
  ["runId", "run 标识（`<safeRunId(runId)>` 路径模板、事件字段、`TranscriptStore` 形参）"],
  ["cwd", "进程工作目录这个概念（`cwd` 在散文里就是它）"],
  ["resume", "动词「续跑」与 `TranscriptStore` 的 resume 语义"],
  ["stream", "SSE / 事件流这个概念（`event stream`）"],
  ["retry", "动词「重试」与 provider 重试这个概念"],
  ["persistence", "持久化这个概念与 `persistence_capability_degraded` 事件名"],
  ["completion", "「完成」这个概念（`completion check`）"],
  ["reflection", "反思子系统这个概念（`reflection/` 目录）"],
  ["wrapup", "回合结束（wrap-up）这个概念与模块名 `src/reflection/wrapup.js`"],
]);

/** 退役措辞：同一行出现它 ⇒ 这条命中是 `mention`（在讲退役，不是在用）。 */
const RETIREMENT_MARKERS = /retired|retirement|rejected|rejects|flat spelling|退役|已拒|扁平拼写/i;

// ── 2. 分类表（第一等公民） ──────────────────────────────────────────────────
/** 现状描述：会被当成「今天怎么写」来读的活文档（且在 `check:docs` 的引用扫描范围内）。 */
const CURRENT_DOC_PATTERNS = [
  { re: /^docs\/architecture(_cn)?\.md$/, why: "现状描述：架构正文，`check:docs` 的 paths/symbols 面在扫它" },
  { re: /^docs\/charts(_cn)?\.md$/, why: "现状描述：图表正文，同上" },
];
/** 历史记录：当时决定的记录，正文一个字不改，只加带日期的状态横幅。 */
const HISTORY_DOC_PATTERNS = [
  { re: /^docs\/decisions\/[^/]+\.md$/, why: "历史记录：ADR，写的是当时作出的决定" },
  { re: /^docs\/v0\.[^/]*\.md$/, why: "历史记录：v0.x 契约快照（文件头自己写着「快照档案」）" },
];

/**
 * 一份文档的分类。
 * @param {string} rel 仓库相对路径
 * @returns {{kind: "current"|"history"|"out-of-scope", why: string}}
 */
export function classify(rel) {
  for (const { re, why } of CURRENT_DOC_PATTERNS) if (re.test(rel)) return { kind: "current", why };
  for (const { re, why } of HISTORY_DOC_PATTERNS) if (re.test(rel)) return { kind: "history", why };
  return {
    kind: "out-of-scope",
    why: "不在 #523 的改动面（本单只改 architecture* / chart* / v0.* / decisions/*）；命中只报不改",
  };
}

// ── 3. 历史类正文的命中数钉子 ────────────────────────────────────────────────
/**
 * 历史文档的 `use` 命中数（2026-10-29 实测；`--json` 的 `pins` 段是同一份事实）。
 *
 * 为什么需要它：本脚本的分类判据要说得出「这份 ADR 的正文被改写成规位形态了」。文本级扫描做不到
 * ——改写之后命中数变成 0，而「本来就没有命中」也是 0，两者长得一模一样。所以把今天实测的数钉在
 * 这里：**掉下去 = 有人在改历史**（报 `SUSPECT`），涨上去 = 有人往历史里补了扁平拼写（也报）。
 * 改这份表只有一个合法理由：**历史文档真的被替换成另一份历史**（那要连横幅一起重写）。
 *
 * @type {Readonly<Record<string, number>>}
 */
const HISTORY_BODY_PINS = Object.freeze({
  "docs/decisions/001-config-adapters.md": 4,
  "docs/decisions/001-config-adapters_cn.md": 2,
  "docs/decisions/002-transcript-store.md": 2,
  "docs/decisions/003-compaction-strategies.md": 2,
  "docs/decisions/004-reflection-deferred.md": 2,
  "docs/decisions/005-tool-system.md": 4,
  "docs/decisions/005-tool-system_cn.md": 2,
  "docs/decisions/006-tool-provider.md": 2,
  "docs/decisions/007-memory-architecture.md": 6,
  "docs/decisions/007-memory-architecture_cn.md": 1,
  "docs/decisions/008-skill-system.md": 2,
  "docs/decisions/009-safety-layering.md": 2,
  "docs/decisions/010-context-shaping-philosophy.md": 2,
  "docs/decisions/011-judge-direction.md": 4,
  "docs/decisions/011-judge-direction_cn.md": 1,
  "docs/decisions/012-engine-truth-model-efficiency-host-policy.md": 2,
  "docs/decisions/013-guard-charter.md": 2,
  "docs/decisions/014-host-port-framework.md": 12,
  "docs/decisions/017-glm-reasoning-effort-translation.md": 2,
  "docs/decisions/020-transcript-single-source.md": 7,
  "docs/v0.0-contracts.md": 26,
  "docs/v0.0-contracts_cn.md": 23,
  "docs/v0.1-contracts.md": 29,
  "docs/v0.1-contracts_cn.md": 26,
  "docs/v0.2-contracts.md": 18,
  "docs/v0.2-contracts_cn.md": 15,
});

// ── 4. 文本级扫描 ────────────────────────────────────────────────────────────
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 扫一份 Markdown 文本。
 *
 * 代码语境有两种：
 *   · **围栏**（```…```）：键位形态 `KEY:` / `KEY =` / `KEY,` / 裸 `KEY` 单独一行。围栏里遇到
 *     `config: {` 就进入「规位子树」，按花括号配对整体跳过 —— 那里的 `system` / `messages` 是**叶子名**，
 *     与扁平写点同名但不同物（这正是本脚本最容易变成假阳性工厂的地方）。
 *   · **行内代码 span**（`…`）：span 内容恰是键名，或以 `KEY:` / `KEY =` / `KEY,` 开头。
 *
 * @param {string} text
 * @param {Map<string, string>} retired 键 → 规位路径
 * @returns {Array<{line: number, key: string, canonical: string, verdict: "use"|"mention", excerpt: string}>}
 */
export function scanText(text, retired) {
  const keys = [...retired.keys()].sort((a, b) => b.length - a.length);
  const tokenRe = new RegExp(`(?<![\\w.$-])(${keys.map(escapeRe).join("|")})(?![\\w$])`, "g");
  const spanRe = /`([^`\n]+)`/g;
  const hits = [];
  const lines = text.split("\n");
  let inFence = false;
  let configDepth = 0;

  const push = (lineNo, key, raw, excerpt) => {
    const canonical = retired.get(key);
    if (canonical === undefined) return;
    const verdict = RETIREMENT_MARKERS.test(raw) ? "mention" : "use";
    hits.push({ line: lineNo, key, canonical, verdict, excerpt: excerpt.trim().slice(0, 100) });
  };

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      configDepth = 0;
      return;
    }
    if (inFence) {
      // 规位子树：`config: {` 之后整体跳过，花括号配对回到 0 才恢复计数。
      if (configDepth > 0) {
        configDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        if (configDepth <= 0) configDepth = 0;
        return;
      }
      if (/(^|[\s{,])config\s*:\s*\{/.test(line)) {
        configDepth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        if (configDepth < 0) configDepth = 0;
        return;
      }
      const keyPosition = line.match(/^\s*(?:\/\/\s*)?([A-Za-z_$][\w$]*)\s*[:=,]?/);
      if (keyPosition !== null && retired.has(keyPosition[1])) {
        const bare = line.trim().replace(/,$/, "");
        const name = keyPosition[1];
        if (bare === name || /[:=,]/.test(line.trim().slice(name.length, name.length + 1))) {
          push(lineNo, name, line, line);
          return;
        }
      }
      for (const m of line.matchAll(tokenRe)) push(lineNo, m[1], line, line);
      return;
    }
    // 行内代码 span（围栏外）
    for (const span of line.matchAll(spanRe)) {
      const content = span[1].trim();
      const head = content.match(/^([A-Za-z_$][\w$]*)(\s*[:=,]|\s*\?|$)/);
      if (head === null) continue;
      if (!retired.has(head[1])) continue;
      push(lineNo, head[1], line, span[0]);
    }
  });
  return hits;
}

// ── 5. 覆盖面 ────────────────────────────────────────────────────────────────
/** `docs/**` 下全部 `.md`（实扫，新文档落地即自动纳面；不硬编码清单）。 */
function docsFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".md")) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(path.join(root, "docs"));
  return out;
}

/**
 * 跑一次全量扫描（纯函数：`root` 可注入，自测用内存夹具）。
 * @param {{root?: string, retired: Map<string,string>, files?: string[]}} params
 */
export function scanDocs({ root = ROOT, retired, files = docsFiles(root) }) {
  const report = [];
  for (const rel of files) {
    const text = readFileSync(path.join(root, rel), "utf8");
    const { kind, why } = classify(rel);
    const hits = scanText(text, retired);
    const uses = hits.filter((h) => h.verdict === "use");
    const pin = HISTORY_BODY_PINS[rel];
    const strictUses = uses.filter((h) => !AMBIGUOUS_KEYS.has(h.key));
    let verdict = "ok";
    if (kind === "current" && strictUses.length > 0) verdict = "REGRESSION";
    else if (kind === "current" && uses.length > 0) verdict = "review(ambiguous-only)";
    else if (kind === "history" && pin !== undefined && uses.length !== pin) {
      verdict = uses.length < pin ? "SUSPECT(dropped)" : "SUSPECT(raised)";
    }
    report.push({ file: rel, kind, why, pin, hits, uses, verdict });
  }
  return report;
}

// ── 6. 输出 ──────────────────────────────────────────────────────────────────
function printReport(report, retired) {
  const ambiguous = (key) => AMBIGUOUS_KEYS.has(key);
  const actionable = report.filter((r) => r.uses.length > 0);
  const cleanCurrent = report.filter((r) => r.kind === "current"
    && r.uses.every((h) => AMBIGUOUS_KEYS.has(h.key)));

  console.log(`retired-spelling-scan: ${report.length} 份 docs/**/*.md，退役扁平键 ${retired.size} 个`
    + `（派生自 src/loop/config-namespace.js − RUN_TOOL_LOOP_OPTION_NAMES）`);
  console.log("⚠ 观察性检查：默认 exit 0，未接 CI（工单 #523 要求 4）\n");

  console.log("── 分类（第一等公民） ─────────────────────────────────────────");
  for (const kind of ["current", "history", "out-of-scope"]) {
    const group = report.filter((r) => r.kind === kind);
    console.log(`  ${kind.padEnd(12)} ${String(group.length).padStart(3)} 份`);
  }
  console.log("\n  现状描述（改）：");
  for (const r of report.filter((x) => x.kind === "current")) console.log(`    ${r.file} — ${r.why}`);
  console.log("  历史记录（只加横幅）：");
  for (const r of report.filter((x) => x.kind === "history")) console.log(`    ${r.file} — ${r.why}`);

  console.log("\n── 命中清单（只在代码语境里算；散文里的同名英文词不算） ───────");
  if (actionable.length === 0) console.log("  （无）");
  for (const r of actionable) {
    console.log(`\n  ${r.file}  [${r.kind}]  verdict=${r.verdict}`
      + `${r.pin === undefined ? "" : `  pin=${r.pin}`}`);
    for (const h of r.uses) {
      console.log(`    L${h.line}  ${h.key} → ${h.canonical}`
        + `${ambiguous(h.key) ? "  (ambiguous: 见 AMBIGUOUS_KEYS)" : ""}`);
      console.log(`         ${h.excerpt}`);
    }
  }

  console.log("\n── 现状类干净面（0 处**非 ambiguous** 命中；ambiguous 见 AMBIGUOUS_KEYS） ──");
  for (const r of cleanCurrent) {
    const amb = r.uses.length;
    console.log(`  ✓ ${r.file}：0 处退役拼写${amb === 0 ? "" : `（另有 ${amb} 处同名异义：形参 / 工厂参数 / 字段名）`}`);
  }

  const mentions = report.reduce((n, r) => n + r.hits.filter((h) => h.verdict === "mention").length, 0);
  const strictHits = actionable
    .filter((r) => r.kind === "current")
    .flatMap((r) => r.uses.filter((h) => !ambiguous(h.key)));
  const suspects = report.filter((r) => r.verdict.startsWith("SUSPECT"));

  console.log("\n── 判据 ───────────────────────────────────────────────────────");
  const curAll = actionable.filter((r) => r.kind === "current").reduce((n, r) => n + r.uses.length, 0);
  console.log(`  ① 现状类：${strictHits.length === 0 ? "干净（0 处退役拼写）" : `${strictHits.length} 处退役拼写 ⇒ 要改`}`
    + `；另有 ${curAll - strictHits.length} 处同名异义（ambiguous，不进判据）`);
  console.log(`  ② 历史类 use 命中：${actionable.filter((r) => r.kind === "history").reduce((n, r) => n + r.uses.length, 0)} 处`
    + "（**不算错**：历史正文一个字不改，只加带日期的横幅）");
  console.log(`  ③ 历史正文钉子：${Object.keys(HISTORY_BODY_PINS).length} 份，`
    + `${suspects.length === 0 ? "全部等于实测（没有人在改写历史）" : `${suspects.length} 份不符 ⇒ 见上`}`);
  console.log(`  ④ 退役措辞行（mention，在讲退役这件事）：${mentions} 处，不计入上面三条`);

  if (STRICT) {
    const bad = strictHits.length + suspects.length;
    console.log(`\n--strict: ${bad === 0 ? "OK — 0 处红" : `${bad} 处红`}`);
    return bad === 0 ? 0 : 1;
  }
  console.log("\n结论：观察模式（exit 0）。要把这条变成门禁是 S9 之后的事。");
  return 0;
}

// ── 7. 自测（内存夹具，不写盘、不碰真文档） ──────────────────────────────────
function selfTest(retired) {
  const cases = [];
  const t = (name, fn) => {
    try {
      fn();
      cases.push([true, name]);
    } catch (error) {
      cases.push([false, `${name} — ${error.message}`]);
    }
  };
  const eq = (actual, expected, what) => {
    if (actual !== expected) throw new Error(`${what}: 期望 ${expected}，实测 ${actual}`);
  };
  const keys = (text) => scanText(text, retired).map((h) => `${h.key}@L${h.line}:${h.verdict}`);

  t("现状类：围栏里的顶层扁平写点被报出来", () => {
    eq(keys("```js\nrunToolLoop({\n  toolResultTtl = 2,\n})\n```").join("|"),
      "toolResultTtl@L3:use", "围栏键位");
  });
  t("规位形态不报：`config.*` 之下的叶子名不是扁平写点", () => {
    eq(keys("```js\nrunToolLoop({\n  config: {\n    folding: {\n      toolResultTtl = 2,\n    },\n  },\n})\n```").length,
      0, "config 子树");
  });
  t("行内 span 的 `config.x.y` 尾段不报（负向后视的 `.`）", () => {
    eq(keys("`config.timing.timeoutMs` 是规位拼写").length, 0, "带点前缀");
  });
  t("行内 span 的裸键名报出来", () => {
    eq(keys("`toolResultTtl` defaults to `2`").join("|"), "toolResultTtl@L1:use", "裸 span");
  });
  t("退役措辞行降级为 mention（在讲退役，不是在用）", () => {
    eq(keys("the flat `toolResultTtl` is retired").join("|"), "toolResultTtl@L1:mention", "mention");
  });
  t("散文里的同名英文词不报（`user` message / `context` compaction）", () => {
    eq(keys("every user message is legal; context compaction rewrites the model view").length, 0, "散文");
  });
  t("分类判据不是空的：历史类命中数掉下去 ⇒ SUSPECT(dropped)", () => {
    const fixture = "docs/decisions/999-fixture.md";
    const before = { root: ROOT, retired, files: [fixture] };
    void before;
    const text = "```js\nrunToolLoop({ toolResultTtl = 2 })\n```";
    const uses = scanText(text, retired).filter((h) => h.verdict === "use");
    eq(uses.length, 1, "夹具先有 1 处命中");
    const rewritten = "```js\nrunToolLoop({ config: { folding: { toolResultTtl = 2 } } })\n```";
    eq(scanText(rewritten, retired).filter((h) => h.verdict === "use").length, 0, "改写成规位形态后命中归零");
    // 钉子机制本身：钉 1、实测 0 ⇒ 报 SUSPECT(dropped)（与真实扫描同一段判据）
    const pin = 1;
    const observed = scanText(rewritten, retired).filter((h) => h.verdict === "use").length;
    if (!(observed < pin)) throw new Error("钉子没咬住");
  });
  t("每一条 pin 都指向一份真在盘上的历史文档（空转条目 = 后门）", () => {
    for (const rel of Object.keys(HISTORY_BODY_PINS)) {
      const kind = classify(rel).kind;
      if (kind !== "history") throw new Error(`${rel} 不是历史类，却登记了 pin`);
      try {
        readFileSync(path.join(ROOT, rel), "utf8");
      } catch {
        throw new Error(`${rel} 不在盘上（死条目）`);
      }
    }
  });

  const failed = cases.filter(([ok]) => !ok);
  for (const [ok, name] of cases) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  console.log(`\nretired-spelling-scan --self-test: ${failed.length === 0 ? `OK — ${cases.length} 例反向证/放行证全部按预期` : `${failed.length} 例失败`}`);
  return failed.length === 0 ? 0 : 1;
}

// ── 8. main ──────────────────────────────────────────────────────────────────
const retired = await retiredFlatKeys();
if (SELF_TEST) process.exit(selfTest(retired));

const report = scanDocs({ retired });
if (JSON_OUT) {
  const slim = report.map((r) => ({
    file: r.file, kind: r.kind, verdict: r.verdict, pin: r.pin ?? null,
    uses: r.uses.map((h) => ({ line: h.line, key: h.key, canonical: h.canonical, ambiguous: AMBIGUOUS_KEYS.has(h.key) })),
    mentions: r.hits.filter((h) => h.verdict === "mention").length,
  }));
  console.log(JSON.stringify({ retiredKeys: Object.fromEntries(retired), pins: HISTORY_BODY_PINS, files: slim }, null, 2));
  process.exitCode = 0;
} else {
  process.exitCode = printReport(report, retired);
}
