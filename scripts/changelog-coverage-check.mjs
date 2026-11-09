#!/usr/bin/env node
// @ts-check
// changelog-coverage-check.mjs — issue #691：**碰到公开面的 first-parent 合并，必须在本版 CHANGELOG 段里被点名**。
//
// 病根（issue #686 复盘查实）：`CHANGELOG.md` 的既有门禁只查「已有条目是否中英成对」，**不查「该不该有一条」**。
// 于是 0.30.0 这一段在发布时只点名了 9 个号，而 `v0.29.0..v0.30.0` 之间有 53 个合并碰到了公开面——
// 其中 5 个被写到、48 个一个号都没有。复盘时人工「主题式阅读」只找出 4 条，机械实测是 48 条：这个差本身
// 就是本闸存在的理由（人脑读主题会漏，路径类别不会）。
//
// ── 判据（方向只查一边）────────────────────────────────────────────────────
//   `碰到公开面的合并号 ⊆ 本版 CHANGELOG 号 ∪ 豁免登记`
//
//   为什么不查反向：CHANGELOG 里写历史 issue 号是合法的（散文引用），反向会把它们判成假红——0.30.0 段就
//   引用了区间外的 `#109` / `#464`。所以**只问「该有的有没有」**，不问「有的该不该有」。
//
// ── 「行为可见」怎么判（路径类别，不靠人脑）────────────────────────────────────
//   一个合并的 first-parent diff（`git diff --name-only <merge>^1 <merge>`）碰到 `PUBLIC_SURFACE_RULES`
//   里任何一条 ⇒ 必须被本版 CHANGELOG 段点名。只碰别的东西（`test/` / 非公开 `docs/` / `scripts/` /
//   `delivery/` / `AGENTS*` / `.github/` / `examples/` …）⇒ **类别豁免**，不逐条登记：类别规则写在本文件里，
//   加一条类别是一次代码改动 + 一次自测，不是往白名单里塞一行。
//   只有「类别规则判成豁免、但确实行为可见」这种**反向**情形才逐条登记（`COVERAGE_EXEMPTIONS`，必须带 why）。
//
// ── 登记表纪律（与 `CONTRACT_PUBLISH_EXEMPTIONS` / `KNOWN_NOT_REMOVED` 同一口径）─────────
//   · 空 `why` ⇒ 红（没有理由的登记就是下一任读者的免检通道）；
//   · 空转条目 ⇒ 红（那个号本版已经写到、或者区间里根本没这个号 ⇒ 这条账不存在，登记必须删掉，#210 R2）；
//   · 条数与 `COVERAGE_EXEMPTION_MAX` **双向**对账（多了少了都红）；
//   · 同一个号登记两次 / 登记表形状坏掉 ⇒ 红。
//   登记表**不是**「差集整批塞进白名单」的通道：本版（#691）的 48 条是**补齐成条目**的，登记表是空的。
//
// ── 区间与段从哪来（不手抄）─────────────────────────────────────────────────
//   · 本版 = CHANGELOG 里**最新的那个版本段**（跳过 `[Unreleased]`）；可用 `--version` 指定；
//   · 区间 = 版本序上比本版小的**最大 tag** `..` 本版的 tag（没有 tag ⇒ `HEAD`，即未发布版本）；
//   · 段 = 同一个 `CHANGELOG.md` 里 `## [<本版>]` 到下一个 `## ` 之间。
//   任一端解析不出来 ⇒ **exit 2**，不静默绿（区间无 tag / CHANGELOG 段读不到 / git 不可用都属于这一类）。
//
// ── 退出码（本仓惯例：读不出真值就红，不许假绿）───────────────────────────────
//   0 = 绿（缺项 0，登记表纪律全过）
//   1 = 判据红（`MISSING_COVERAGE` / 登记表五条，逐条点名）
//   2 = 读不出真值（`GIT_UNAVAILABLE` / `RANGE_UNRESOLVED` / `CHANGELOG_UNREADABLE` /
//       `SECTION_UNREADABLE` / `MERGE_LIST_UNREADABLE` / `NO_VERSION_SECTION`）
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node scripts/changelog-coverage-check.mjs                     # 本版（最新段）对最新 tag
//   node scripts/changelog-coverage-check.mjs --version 0.30.0    # 指定版本段（区间按版本序自动取）
//   node scripts/changelog-coverage-check.mjs --from v0.29.0 --to v0.30.0 --version 0.30.0
//   node scripts/changelog-coverage-check.mjs --json              # 机器面（CI 之外的消费点用）
//   node scripts/changelog-coverage-check.mjs --self-test         # 反向证（os.tmpdir() 里自建合成 git 仓）
//
// `--self-test` **不依赖本仓历史**：它自己造 tag、造分支、造 merge（#302 的合成树夹具惯例）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 本闸的判据码（报告、红项、自测共用一份，别在别处再抄一遍）。 */
export const GATE_CODES = Object.freeze({
  MISSING_COVERAGE: "MISSING_COVERAGE",
  EXEMPTION_NO_WHY: "EXEMPTION_NO_WHY",
  EXEMPTION_IDLE: "EXEMPTION_IDLE",
  EXEMPTION_DUPLICATE: "EXEMPTION_DUPLICATE",
  EXEMPTION_MALFORMED: "EXEMPTION_MALFORMED",
  EXEMPTION_COUNT_DRIFT: "EXEMPTION_COUNT_DRIFT",
  GIT_UNAVAILABLE: "GIT_UNAVAILABLE",
  RANGE_UNRESOLVED: "RANGE_UNRESOLVED",
  CHANGELOG_UNREADABLE: "CHANGELOG_UNREADABLE",
  NO_VERSION_SECTION: "NO_VERSION_SECTION",
  SECTION_UNREADABLE: "SECTION_UNREADABLE",
  MERGE_LIST_UNREADABLE: "MERGE_LIST_UNREADABLE",
});

/**
 * 公开面：**碰到就算行为可见**。顺序即点名顺序。
 *
 * 口径来自 issue #691 的定稿（「碰到公开面的合并必须进本版 CHANGELOG」）：`src/` `bin/` `package.json`
 * 三样随包暴露，加上公开文档集（两份 README、契约、需求、**本版**升级指南）。
 * `package.json` 整份算公开面（不细分 `scripts` / `exports`）：路径类别判据要机械、要能被下一任读者一眼复核；
 * 「这个键宿主管不管得着」是人的判断，一旦写进判据就会变成逐条豁免的借口。
 */
export const PUBLIC_SURFACE_RULES = Object.freeze([
  { id: "src", label: "`src/`", match: (rel) => rel.startsWith("src/") },
  { id: "bin", label: "`bin/`", match: (rel) => rel.startsWith("bin/") },
  { id: "package", label: "`package.json`", match: (rel) => rel === "package.json" },
  { id: "readme", label: "README", match: (rel) => rel === "README.md" || rel === "README_cn.md" },
  {
    id: "contract",
    label: "契约",
    match: (rel) => rel === "docs/host-consumer-contract.md" || rel === "docs/host-consumer-contract_cn.md",
  },
  {
    id: "requirements",
    label: "需求",
    match: (rel) => rel === "docs/requirements.md" || rel === "docs/requirements_cn.md",
  },
  {
    // 「**本版**升级指南」：只有被发布的那一版的指南算公开面。历史指南的措辞随事实更新（#690 就是那样），
    // 那不是新行为；把它们也算进来只会让「改一句历史措辞」变成必须开 CHANGELOG 条目。
    id: "guide",
    label: "本版升级指南",
    match: (rel, version) => version !== null
      && (rel === `docs/host-upgrade-guide-${version}.md` || rel === `docs/host-upgrade-guide-${version}_cn.md`),
  },
]);

/**
 * 类别豁免的**说明**（不是登记表，只是给报告用的可读分类；判据是「没命中任何 `PUBLIC_SURFACE_RULES`」）。
 * 报告里逐类计数，好让人看见「53 个里 19 个只碰这些」是怎么来的。
 */
export const EXEMPT_CATEGORIES = Object.freeze([
  { id: "test", label: "`test/`", match: (rel) => rel.startsWith("test/") },
  { id: "scripts", label: "`scripts/`", match: (rel) => rel.startsWith("scripts/") },
  { id: "delivery", label: "`delivery/`", match: (rel) => rel.startsWith("delivery/") },
  { id: "agents", label: "`AGENTS*`", match: (rel) => rel === "AGENTS.md" || rel === "AGENTS_cn.md" },
  { id: "ci", label: "`.github/`", match: (rel) => rel.startsWith(".github/") },
  { id: "examples", label: "`examples/`", match: (rel) => rel.startsWith("examples/") },
  { id: "fixtures", label: "`fixtures/`", match: (rel) => rel.startsWith("fixtures/") },
  { id: "skills", label: "`skills/`", match: (rel) => rel.startsWith("skills/") },
  { id: "changelog", label: "`CHANGELOG.md`", match: (rel) => rel === "CHANGELOG.md" },
  { id: "internal-docs", label: "非公开 `docs/`", match: (rel) => rel.startsWith("docs/") },
]);

/**
 * **反向豁免登记表**：类别规则判成「只碰测试/内部面」、但那条改动确实行为可见时，才在这里逐条登记。
 *
 * 纪律（由 `EXEMPTION_*` 五条判据看守）：每条必须带 `why`；空转即红；条数与 `COVERAGE_EXEMPTION_MAX`
 * 双向对账。今天它是**空的**——0.30.0 那 48 条是补齐成条目（issue #691），不是靠豁免过关。
 */
export const COVERAGE_EXEMPTIONS = Object.freeze(
  /** @type {ReadonlyArray<{issue: number, why: string}>} */ ([]),
);

/** 登记表条数上限（双向对账：多了少了都红）。空表 ⇒ 0。 */
export const COVERAGE_EXEMPTION_MAX = 0;

/** CHANGELOG 里的段标题：`## [1.2.3] - 2026-01-01…` / `## [1.2.3] — 截至本提交尚未发布`。 */
const SECTION_HEADING = /^##\s*\[(\d+\.\d+\.\d+)\]/u;

/** 圈码 / 带圈数字（`①`…`⑳`、`㉑`…、`❶`…）：它们是**子项标记**，不是数字的一部分。 */
const CIRCLED_MARKERS = /[\u2460-\u24FF\u2776-\u2793\u3251-\u325F]/gu;

/**
 * 一段文本里的 issue 号（去重、升序）。
 *
 * `#398③` 必须归一到 `398`：`③` 是子项标记，不是第二个号。抽号前先把圈码换成空格，于是 `#398③` 读成
 * `#398 `——**归一在这里发生，不在调用点**（`LC_ALL=C` 的 grep 在别的 locale 下会把 `[0-9]` 连圈码一起吃掉，
 * 那类事故不值得在每一处调用点各防一遍）。
 */
export function issueNumbersIn(text) {
  const normalized = String(text).replace(CIRCLED_MARKERS, " ");
  const out = new Set();
  for (const m of normalized.matchAll(/#(\d{1,6})(?!\d)/gu)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/** 一个路径命中哪条公开面规则（`null` = 不命中 ⇒ 归类别豁免）。 */
export function publicSurfaceOf(rel, version) {
  for (const rule of PUBLIC_SURFACE_RULES) {
    if (rule.match(rel, version)) return rule;
  }
  return null;
}

/** 类别豁免的可读分类（只用于报告；判据仍是「没命中公开面」）。 */
export function exemptCategoryOf(rel) {
  for (const cat of EXEMPT_CATEGORIES) if (cat.match(rel)) return cat;
  return { id: "other", label: "其它" };
}

/** 版本比较（`1.10.0` > `1.9.0`；逐段数字比，不用字符串比）。 */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// ─────────────────────────────── git 读面 ───────────────────────────────

/**
 * 跑一条 git 命令。**不抛**：读不出就返回 `{ ok: false, stderr }`，让调用点按「读不出 ⇒ exit 2」处置
 * （本仓惯例：读不出永远不等于绿）。
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ok: boolean, stdout: string, stderr: string}}
 */
export function gitRead(cwd, args) {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = /** @type {{stdout?: unknown, stderr?: unknown, message?: string}} */ (err);
    return {
      ok: false,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" && e.stderr.trim() ? e.stderr : String(e.message ?? err),
    };
  }
}

/** 所有 `vX.Y.Z` tag → 版本列表（升序）。读不出返 `null`（不是空数组：空数组会被当成「没有 tag」而静默）。 */
export function tagVersions(cwd) {
  const res = gitRead(cwd, ["tag", "--list", "v*"]);
  if (!res.ok) return null;
  const out = [];
  for (const line of res.stdout.split("\n")) {
    const m = line.trim().match(/^v(\d+\.\d+\.\d+)$/u);
    if (m) out.push(m[1]);
  }
  return out.sort(compareVersions);
}

/**
 * 解析区间：`from`（版本序上比 `version` 小的最大 tag）`..` `to`（`v<version>` tag，没有就用 `HEAD`）。
 *
 * @param {{cwd: string, version: string, from?: string|null, to?: string|null}} options
 * @returns {{ok: true, from: string, to: string, targetRef: string, tags: string[], notes: string[]}
 *          | {ok: false, code: string, message: string}}
 */
export function resolveRange({ cwd, version, from = null, to = null }) {
  const notes = [];
  const tags = tagVersions(cwd);
  if (tags === null) {
    return { ok: false, code: GATE_CODES.GIT_UNAVAILABLE, message: "`git tag --list` 跑不起来（不是 git 仓，或 git 不在 PATH 上）" };
  }
  const targetTag = tags.includes(version) ? `v${version}` : null;
  const targetRef = to ?? targetTag ?? "HEAD";
  if (!targetTag && !to) {
    notes.push(`v${version} 没有 tag ⇒ 本版按未发布处理，区间上端取 HEAD`);
  }
  let fromRef = from;
  if (!fromRef) {
    const lower = tags.filter((t) => compareVersions(t, version) < 0);
    if (!lower.length) {
      return {
        ok: false,
        code: GATE_CODES.RANGE_UNRESOLVED,
        message: `没有比 ${version} 更小的 tag（现有 tag：${tags.length ? tags.join(", ") : "无"}）——`
          + "区间一端解析不出来，这一版就没有「上一版」可比；读不出不等于绿",
      };
    }
    fromRef = `v${lower.at(-1)}`;
  }
  // 两端都得真的解析成提交，否则 `git log <from>..<to>` 会静默返回空（空 = 「这一版没有合并」= 假绿）。
  for (const ref of [fromRef, targetRef]) {
    const check = gitRead(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (!check.ok) {
      return {
        ok: false,
        code: GATE_CODES.RANGE_UNRESOLVED,
        message: `区间端点 ${ref} 解析不出提交（${check.stderr.split("\n")[0]}）——读不出区间就不许判绿`,
      };
    }
  }
  return { ok: true, from: fromRef, to: targetRef, targetRef, tags, notes };
}

/**
 * 区间内的 first-parent 合并（`{sha, subject, files, publicFiles, numbers}`）。
 * 读不出 ⇒ `null`（调用点 exit 2）。
 */
export function readMerges(cwd, from, to, version) {
  const log = gitRead(cwd, ["log", "--first-parent", "--merges", `${from}..${to}`, "--pretty=%H%x1f%s"]);
  if (!log.ok) return null;
  /** @type {Array<{sha: string, short: string, subject: string, numbers: number[], files: string[], publicFiles: string[]}>} */
  const merges = [];
  for (const line of log.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [sha, ...rest] = line.split("\x1f");
    const subject = rest.join("\x1f");
    const diff = gitRead(cwd, ["diff", "--name-only", `${sha}^1`, sha]);
    if (!diff.ok) return null;                       // 拿不到某个合并的 diff ⇒ 那个合并的「碰没碰公开面」无从判
    const files = diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    const publicFiles = files.filter((rel) => publicSurfaceOf(rel, version) !== null);
    merges.push({ sha, short: sha.slice(0, 7), subject, numbers: issueNumbersIn(subject), files, publicFiles });
  }
  return merges;
}

// ─────────────────────────────── CHANGELOG 读面 ───────────────────────────────

/**
 * 解析 `CHANGELOG.md` 的版本段（跳过 `[Unreleased]`）。
 * @param {string} text
 * @returns {Array<{version: string, line: number, heading: string, body: string}>|null}
 */
export function changelogSections(text) {
  const lines = text.split("\n");
  /** @type {Array<{version: string, line: number, heading: string, body: string}>} */
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s/u.test(line)) {
      const m = line.match(SECTION_HEADING);
      cur = m ? { version: m[1], line: i + 1, heading: line, body: "" } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (cur) cur.body += `${line}\n`;
  }
  return out.length ? out : null;
}

/** 本版 = 最新的版本段（`CHANGELOG.md` 的第一段）。 */
export function latestVersion(sections) {
  return sections.length ? sections[0].version : null;
}

// ─────────────────────────────── 裁决 ───────────────────────────────

/**
 * 纯函数裁决：`merges` × 本版段号集 × 登记表。
 *
 * @param {{merges: Array<{sha: string, short: string, subject: string, numbers: number[], publicFiles: string[], files: string[]}>,
 *          sectionNumbers: Set<number>, exemptions: unknown, exemptionMax: number, version: string}} input
 */
export function evaluateCoverage({ merges, sectionNumbers, exemptions, exemptionMax, version }) {
  /** @type {Array<{code: string, message: string}>} */
  const reds = [];
  const notes = [];

  /** number → 第一次碰到的那个合并（点名用）。 */
  const publicByNumber = new Map();
  /** 碰到公开面、但主题里一个 issue 号都没有的合并（本闸无法归因，只打印不判红）。 */
  const unattributed = [];
  let publicMerges = 0;
  const exemptCats = new Map();
  for (const merge of merges) {
    if (!merge.publicFiles.length) {
      for (const rel of merge.files) {
        const cat = exemptCategoryOf(rel);
        exemptCats.set(cat.id, (exemptCats.get(cat.id) ?? 0) + 1);
      }
      continue;
    }
    publicMerges += 1;
    if (!merge.numbers.length) unattributed.push(merge.short);
    for (const n of merge.numbers) {
      if (!publicByNumber.has(n)) publicByNumber.set(n, merge);
    }
  }
  if (!merges.length) {
    notes.push("区间内 first-parent 合并为 0 个——本闸没有可判的对象（这一行不是绿，它是「没有对象」）");
  }

  // 登记表形状与纪律
  if (!Array.isArray(exemptions)) {
    reds.push({ code: GATE_CODES.EXEMPTION_MALFORMED, message: "COVERAGE_EXEMPTIONS 不是数组（登记表形状坏掉 ⇒ 判红，不许静默空转）" });
  }
  const rows = Array.isArray(exemptions) ? exemptions : [];
  const seen = new Set();
  const exemptSet = new Set();
  for (const [index, row] of rows.entries()) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      reds.push({ code: GATE_CODES.EXEMPTION_MALFORMED, message: `COVERAGE_EXEMPTIONS[${index}] 不是 {issue, why} 对象` });
      continue;
    }
    const rec = /** @type {{issue?: unknown, why?: unknown}} */ (row);
    const issue = typeof rec.issue === "number" && Number.isInteger(rec.issue) ? rec.issue : null;
    if (issue === null) {
      reds.push({ code: GATE_CODES.EXEMPTION_MALFORMED, message: `COVERAGE_EXEMPTIONS[${index}] 的 issue 不是整数（${JSON.stringify(rec.issue)}）` });
      continue;
    }
    if (seen.has(issue)) {
      reds.push({ code: GATE_CODES.EXEMPTION_DUPLICATE, message: `#${issue} 在 COVERAGE_EXEMPTIONS 里登记了两次` });
      continue;
    }
    seen.add(issue);
    const why = typeof rec.why === "string" ? rec.why.trim() : "";
    if (!why) {
      reds.push({ code: GATE_CODES.EXEMPTION_NO_WHY, message: `#${issue} 的登记没有 why（空理由不是理由）` });
      continue;
    }
    if (sectionNumbers.has(issue)) {
      reds.push({
        code: GATE_CODES.EXEMPTION_IDLE,
        message: `#${issue} 已经写在 ${version} 段里了，登记条目空转——这条账不存在，必须删掉（#210 R2）`,
      });
      continue;
    }
    if (!publicByNumber.has(issue)) {
      reds.push({
        code: GATE_CODES.EXEMPTION_IDLE,
        message: `#${issue} 在本区间里没有「碰到公开面」的合并（要么没合并过，要么只碰了类别豁免的路径）——`
          + "登记条目空转（#210 R2）",
      });
      continue;
    }
    exemptSet.add(issue);
  }
  if (rows.length !== exemptionMax) {
    reds.push({
      code: GATE_CODES.EXEMPTION_COUNT_DRIFT,
      message: `COVERAGE_EXEMPTIONS 有 ${rows.length} 条，COVERAGE_EXEMPTION_MAX 是 ${exemptionMax}`
        + "（条数双向对账：多了少了都红）",
    });
  }

  /** @type {Array<{issue: number, merge: {sha: string, short: string, subject: string, publicFiles: string[]}}>} */
  const missing = [];
  let covered = 0;
  for (const [issue, merge] of [...publicByNumber.entries()].sort((a, b) => a[0] - b[0])) {
    if (sectionNumbers.has(issue)) { covered += 1; continue; }
    if (exemptSet.has(issue)) continue;
    missing.push({ issue, merge });
  }
  for (const { issue, merge } of missing) {
    reds.push({
      code: GATE_CODES.MISSING_COVERAGE,
      message: `#${issue} 的合并 ${merge.short} 碰到了公开面（${merge.publicFiles.slice(0, 3).join(", ")}`
        + `${merge.publicFiles.length > 3 ? " …" : ""}），而 ${version} 段里没有它`,
    });
  }

  const exemptTotal = [...exemptSet].length;
  notes.push(`区间合并 ${merges.length} 个，其中碰到公开面 ${publicMerges} 个（类别豁免 ${merges.length - publicMerges} 个：`
    + `${[...exemptCats.entries()].map(([id, n]) => `${id}=${n}`).join(" ") || "无"}）`);
  notes.push(`公开面合并号 ${publicByNumber.size} 个：命中 ${covered} / 登记豁免 ${exemptTotal} / 缺项 ${missing.length}`);
  if (unattributed.length) {
    // 已知盲区：本闸靠合并主题里的 issue 号归因，主题里没有号的合并归不到任何条目上。
    // 只打印、不判红（要求它「必须被某条条目点名」是做不到的），但绝不静默。
    notes.push(`碰到公开面但主题里没有 issue 号的合并 ${unattributed.length} 个（本闸无法归因，只打印）：`
      + `${unattributed.join(", ")}`);
  }
  const status = reds.length ? 1 : 0;
  return { status, reds, notes, missing, covered, exemptTotal, publicMerges, unattributed, publicNumbers: [...publicByNumber.keys()] };
}

/**
 * 真门禁：读 CHANGELOG → 解析区间 → 读合并 → 裁决。任一步读不出 ⇒ `status: 2`。
 *
 * @param {{root?: string, version?: string|null, from?: string|null, to?: string|null,
 *          exemptions?: unknown, exemptionMax?: number, changelogText?: string|null}} [options]
 */
export function verifyChangelogCoverage({
  root = DEFAULT_ROOT,
  version = null,
  from = null,
  to = null,
  exemptions = COVERAGE_EXEMPTIONS,
  exemptionMax = COVERAGE_EXEMPTION_MAX,
  changelogText = null,
} = {}) {
  /** @type {Array<{code: string, message: string}>} */
  const errors = [];
  const notes = [];
  const done = (extra) => ({ ...extra, errors, notes });

  let text = changelogText;
  if (text === null) {
    const file = join(root, "CHANGELOG.md");
    if (!existsSync(file)) {
      errors.push({ code: GATE_CODES.CHANGELOG_UNREADABLE, message: `读不到 ${file}` });
      return done({ status: 2, version: null, range: null, verdict: null });
    }
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      errors.push({ code: GATE_CODES.CHANGELOG_UNREADABLE, message: `读不出 CHANGELOG.md：${/** @type {Error} */ (err).message}` });
      return done({ status: 2, version: null, range: null, verdict: null });
    }
  }
  const sections = changelogSections(text);
  if (!sections) {
    errors.push({
      code: GATE_CODES.SECTION_UNREADABLE,
      message: "CHANGELOG.md 里一个 `## [x.y.z]` 版本段都解析不出来——段读不到就没有「这一版写了什么」的真值",
    });
    return done({ status: 2, version: null, range: null, verdict: null });
  }
  const target = version ?? latestVersion(sections);
  const section = sections.find((s) => s.version === target) ?? null;
  if (!section) {
    errors.push({
      code: GATE_CODES.NO_VERSION_SECTION,
      message: `CHANGELOG.md 里没有 ${target} 段（现有段：${sections.map((s) => s.version).join(", ")}）——`
        + "段读不到就不许判绿",
    });
    return done({ status: 2, version: target, range: null, verdict: null });
  }
  const range = resolveRange({ cwd: root, version: target, from, to });
  if (!range.ok) {
    errors.push({ code: range.code, message: range.message });
    return done({ status: 2, version: target, range: null, verdict: null });
  }
  notes.push(...range.notes);
  const merges = readMerges(root, range.from, range.to, target);
  if (merges === null) {
    errors.push({
      code: GATE_CODES.MERGE_LIST_UNREADABLE,
      message: `读不出 ${range.from}..${range.to} 的 first-parent 合并列表（或某个合并的 diff）——读不出就不许判绿`,
    });
    return done({ status: 2, version: target, range, verdict: null });
  }
  const verdict = evaluateCoverage({
    merges,
    sectionNumbers: new Set(issueNumbersIn(section.body)),
    exemptions,
    exemptionMax,
    version: target,
  });
  notes.push(...verdict.notes);
  return done({
    status: verdict.status,
    version: target,
    section,
    range,
    verdict,
    merges,
  });
}

// ─────────────────────────────── 自测 ───────────────────────────────

/** 合成仓里的 `git`：只用 `node:child_process`，不联网。 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "erix-changelog-cov-"));
  const run = (args) => {
    const res = gitRead(dir, args);
    if (!res.ok) throw new Error(`self-test git ${args.join(" ")} 失败：${res.stderr}`);
    return res.stdout;
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "self-test@example.invalid"]);
  run(["config", "user.name", "changelog-coverage self-test"]);
  run(["config", "commit.gpgsign", "false"]);
  return { dir, run };
}

/** 写一个文件并提交（目录不存在就建）。返回提交 sha。 */
function commitFile(repo, rel, content, message) {
  const full = join(repo.dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  repo.run(["add", "-A"]);
  repo.run(["commit", "-q", "-m", message]);
  return repo.run(["rev-parse", "HEAD"]).trim();
}

/** 在 `main` 上造一个 first-parent 合并：分支 → 提交 → `--no-ff` 合并。返回合并提交 sha。 */
function mergeBranch(repo, { branch, rel, content, mergeMessage, base = "main" }) {
  repo.run(["checkout", "-q", "-b", branch, base]);
  commitFile(repo, rel, content, `${branch}: 改 ${rel}`);
  repo.run(["checkout", "-q", "main"]);
  repo.run(["merge", "--no-ff", "-q", branch, "-m", mergeMessage]);
  return repo.run(["rev-parse", "HEAD"]).trim();
}

/** CHANGELOG 夹具：`## [1.1.0]` 段里放给定条目。 */
function changelogFixture(entries, { version = "1.1.0", heading = null } = {}) {
  const body = entries.length ? entries.map((line) => `- ${line}`).join("\n") : "";
  return [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    heading ?? `## [${version}] - 2026-01-01`,
    "",
    "### Added",
    "",
    body,
    "",
    "## [1.0.0] - 2025-12-01",
    "",
    "### Added",
    "",
    "- 起点（合成夹具）。",
    "",
  ].join("\n");
}

/**
 * 反向证。每一例都断言「变异真的落上了」——落不上算失败（#210 R2）。
 * 全部在 `os.tmpdir()` 里自建的合成 git 仓上跑，**不读本仓历史、不依赖本机 tag 面**。
 */
export function runSelfTest() {
  /** @type {string[]} */
  const passed = [];
  /** @type {string[]} */
  const failures = [];
  const expect = (ok, label, detail) => {
    if (ok) passed.push(label);
    else failures.push(`${label} —— ${detail}`);
  };
  /** @type {Array<{dir: string}>} */
  const repos = [];
  const repo = () => {
    const r = makeRepo();
    repos.push(r);
    return r;
  };

  try {
    // ── 例① 合并碰公开面、CHANGELOG 缺 ⇒ 红并点名（号 + 短 sha + 公开面文件）──
    {
      const r = repo();
      commitFile(r, "src/base.js", "export const base = 1;\n", "base");
      r.run(["tag", "v1.0.0"]);
      const merge = mergeBranch(r, {
        branch: "feat/alpha",
        rel: "src/loop/alpha.js",
        content: "export const alpha = 1;\n",
        mergeMessage: "Merge PR #111: feat: 加 alpha",
      });
      commitFile(r, "CHANGELOG.md", changelogFixture(["一条与本合并无关的条目（issue #999）。"]), "changelog");
      const result = verifyChangelogCoverage({ root: r.dir });
      const hit = result.verdict?.missing.find((m) => m.issue === 111);
      expect(
        result.status === 1 && Boolean(hit) && hit.merge.sha === merge
          && result.verdict.reds.some((red) => red.code === GATE_CODES.MISSING_COVERAGE
            && red.message.includes("#111") && red.message.includes(merge.slice(0, 7))
            && red.message.includes("src/loop/alpha.js")),
        "① 合并碰 `src/` 而本版段没写它 ⇒ 红 MISSING_COVERAGE，点名号 + 短 sha + 公开面文件",
        `① 没按预期：status=${result.status}，missing=${JSON.stringify(result.verdict?.missing?.map((m) => m.issue) ?? null)}`
          + `，reds=${result.verdict?.reds.map((r) => r.code).join(",") ?? "无"}`,
      );
      // 正向：把号补进本版段 ⇒ 缺项消失、绿
      commitFile(r, "CHANGELOG.md", changelogFixture(["一条与本合并无关的条目（issue #999）。", "alpha 上线（issue #111）。"]), "changelog: 补 #111");
      const after = verifyChangelogCoverage({ root: r.dir });
      expect(
        after.status === 0 && after.verdict.missing.length === 0 && after.verdict.covered === 1,
        "①b 把 `#111` 补进本版段 ⇒ 缺项消失、绿（正向那条：判据咬的是段里有没有它）",
        `①b 补号之后仍然不绿：status=${after.status}，covered=${after.verdict?.covered}，`
          + `missing=${JSON.stringify(after.verdict?.missing?.map((m) => m.issue) ?? null)}`,
      );
    }

    // ── 例② 同一条合并改成只碰 `test/` ⇒ 绿（类别豁免生效）──
    {
      const r = repo();
      commitFile(r, "src/base.js", "export const base = 1;\n", "base");
      r.run(["tag", "v1.0.0"]);
      mergeBranch(r, {
        branch: "feat/beta",
        rel: "test/beta.test.js",
        content: "// only a test\n",
        mergeMessage: "Merge PR #222: test: 只动测试",
      });
      commitFile(r, "CHANGELOG.md", changelogFixture([]), "changelog");
      const result = verifyChangelogCoverage({ root: r.dir });
      expect(
        result.status === 0 && result.verdict.publicMerges === 0
          && result.notes.some((n) => n.includes("类别豁免")),
        "② 同一个合并只碰 `test/` ⇒ 绿（类别豁免：路径类别判据，不靠人脑）",
        `② 只碰测试的合并没被判成豁免：status=${result.status}，publicMerges=${result.verdict?.publicMerges}，`
          + `reds=${result.verdict?.reds.map((r) => r.code).join(",") ?? "无"}`,
      );
    }

    // ── 例③ 登记表里挂一条**已补齐**的号 ⇒ 空转红（#210 R2）──
    {
      const r = repo();
      commitFile(r, "src/base.js", "export const base = 1;\n", "base");
      r.run(["tag", "v1.0.0"]);
      mergeBranch(r, {
        branch: "feat/gamma",
        rel: "src/gamma.js",
        content: "export const gamma = 1;\n",
        mergeMessage: "Merge PR #333: feat: gamma",
      });
      commitFile(r, "CHANGELOG.md", changelogFixture(["gamma（issue #333）。"]), "changelog");
      const result = verifyChangelogCoverage({
        root: r.dir,
        exemptions: [{ issue: 333, why: "自测：这条其实已经写进 CHANGELOG 了" }],
        exemptionMax: 1,
      });
      expect(
        result.status === 1 && result.verdict.reds.some((red) => red.code === GATE_CODES.EXEMPTION_IDLE && red.message.includes("#333")),
        "③ 给一个**已经写进本版段**的号登记豁免 ⇒ 红 EXEMPTION_IDLE（空转条目就是后门）",
        `③ 空转条目没红：status=${result.status}，reds=${result.verdict?.reds.map((r) => `${r.code}:${r.message.slice(0, 40)}`).join(" | ") ?? "无"}`,
      );
      // 同一个号，理由为空 ⇒ 红 EXEMPTION_NO_WHY（另一条纪律）
      const blank = verifyChangelogCoverage({
        root: r.dir,
        exemptions: [{ issue: 333, why: "   " }],
        exemptionMax: 1,
      });
      expect(
        blank.status === 1 && blank.verdict.reds.some((red) => red.code === GATE_CODES.EXEMPTION_NO_WHY),
        "④ 登记理由写成空白 ⇒ 红 EXEMPTION_NO_WHY（空理由不是理由）",
        `④ 空 why 没红：reds=${blank.verdict?.reds.map((r) => r.code).join(",") ?? "无"}`,
      );
      // 登记表条数与上限不一致（双向：多一条 / 少一条）⇒ 都红
      const over = verifyChangelogCoverage({
        root: r.dir,
        exemptions: [{ issue: 333, why: "自测" }],
        exemptionMax: 0,
      });
      const under = verifyChangelogCoverage({ root: r.dir, exemptions: [], exemptionMax: 1 });
      expect(
        over.verdict.reds.some((red) => red.code === GATE_CODES.EXEMPTION_COUNT_DRIFT)
          && under.verdict.reds.some((red) => red.code === GATE_CODES.EXEMPTION_COUNT_DRIFT),
        "④b 登记表条数与上限双向漂移（多一条 / 少一条）⇒ 都红 EXEMPTION_COUNT_DRIFT",
        `④b 条数漂移没按预期：over=${over.verdict?.reds.map((r) => r.code).join(",")}，`
          + `under=${under.verdict?.reds.map((r) => r.code).join(",")}`,
      );
      // 反向豁免真的放行：把一个只碰 `test/` 的号登记进来（类别豁免 + 登记都成立时，登记本身空转 ⇒ 红），
      // 所以「放行证」用另一条路：区间里一个碰公开面的号，登记后必须从缺项里消失。
      const r2 = repo();
      commitFile(r2, "src/base.js", "export const base = 1;\n", "base");
      r2.run(["tag", "v1.0.0"]);
      mergeBranch(r2, {
        branch: "feat/delta",
        rel: "src/delta.js",
        content: "export const delta = 1;\n",
        mergeMessage: "Merge PR #444: feat: delta",
      });
      commitFile(r2, "CHANGELOG.md", changelogFixture([]), "changelog");
      const before = verifyChangelogCoverage({ root: r2.dir });
      const exempted = verifyChangelogCoverage({
        root: r2.dir,
        exemptions: [{ issue: 444, why: "自测：这条确实行为可见但刻意不开条目" }],
        exemptionMax: 1,
      });
      expect(
        before.status === 1 && exempted.status === 0 && exempted.verdict.exemptTotal === 1,
        "④c 放行证：给一个真缺项的号登记带 why 的豁免 ⇒ 绿（证明登记分支真的被读到，不是恒红）",
        `④c 放行分支没生效：before=${before.status}，after=${exempted.status}，`
          + `exemptTotal=${exempted.verdict?.exemptTotal}`,
      );
    }

    // ── 例⑤ 区间无 tag / CHANGELOG 段读不到 ⇒ exit 2（不是绿）──
    {
      const noTag = repo();
      commitFile(noTag, "src/base.js", "export const base = 1;\n", "base");
      mergeBranch(noTag, {
        branch: "feat/eps",
        rel: "src/eps.js",
        content: "export const eps = 1;\n",
        mergeMessage: "Merge PR #555: feat: eps",
      });
      commitFile(noTag, "CHANGELOG.md", changelogFixture([]), "changelog");
      const noTagResult = verifyChangelogCoverage({ root: noTag.dir });
      expect(
        noTagResult.status === 2 && noTagResult.errors.some((e) => e.code === GATE_CODES.RANGE_UNRESOLVED),
        "⑤ 区间一端没有 tag ⇒ exit 2 + RANGE_UNRESOLVED（不是绿）",
        `⑤ 没有 tag 却没判读不出：status=${noTagResult.status}，`
          + `errors=${noTagResult.errors.map((e) => e.code).join(",") || "无"}`,
      );
      const noSection = repo();
      commitFile(noSection, "src/base.js", "export const base = 1;\n", "base");
      noSection.run(["tag", "v1.0.0"]);
      mergeBranch(noSection, {
        branch: "feat/zeta",
        rel: "src/zeta.js",
        content: "export const zeta = 1;\n",
        mergeMessage: "Merge PR #666: feat: zeta",
      });
      commitFile(noSection, "CHANGELOG.md", changelogFixture([], { version: "1.0.0" }), "changelog");
      const noSectionResult = verifyChangelogCoverage({ root: noSection.dir, version: "1.1.0" });
      expect(
        noSectionResult.status === 2 && noSectionResult.errors.some((e) => e.code === GATE_CODES.NO_VERSION_SECTION),
        "⑤b 本版段在 CHANGELOG 里读不到 ⇒ exit 2 + NO_VERSION_SECTION（真值缺位不许当绿）",
        `⑤b 段缺失没判读不出：status=${noSectionResult.status}，`
          + `errors=${noSectionResult.errors.map((e) => e.code).join(",") || "无"}`,
      );
      const broken = verifyChangelogCoverage({ root: noSection.dir, changelogText: "# Changelog\n\n没有版本段。\n" });
      expect(
        broken.status === 2 && broken.errors.some((e) => e.code === GATE_CODES.SECTION_UNREADABLE),
        "⑤c CHANGELOG 里一个版本段都解析不出来 ⇒ exit 2 + SECTION_UNREADABLE",
        `⑤c 段解析不出却没判读不出：status=${broken.status}，errors=${broken.errors.map((e) => e.code).join(",") || "无"}`,
      );
      const notARepo = mkdtempSync(join(tmpdir(), "erix-changelog-cov-nogit-"));
      try {
        writeFileSync(join(notARepo, "CHANGELOG.md"), changelogFixture([]), "utf8");
        const noGit = verifyChangelogCoverage({ root: notARepo });
        expect(
          noGit.status === 2 && noGit.errors.some((e) => e.code === GATE_CODES.GIT_UNAVAILABLE),
          "⑤d git 不可用（不是仓）⇒ exit 2 + GIT_UNAVAILABLE（读不出区间就不许绿）",
          `⑤d 非 git 目录没判读不出：status=${noGit.status}，errors=${noGit.errors.map((e) => e.code).join(",") || "无"}`,
        );
      } finally {
        rmSync(notARepo, { recursive: true, force: true });
      }
    }

    // ── 例⑥ `#398③` 归一到 398（写成断言，不只写在注释里）──
    {
      const nums = issueNumbersIn("Merge PR #398③: 子项标记不是第二个号");
      expect(
        nums.length === 1 && nums[0] === 398,
        "⑥ `#398③` 归一到 398（`③` 是子项标记，不是第二个号）",
        `⑥ 归一失败：${JSON.stringify(nums)}`,
      );
      const many = issueNumbersIn("merge #308: 声称链（#286 +8 / #375 +2 / #308 +1）①②③");
      expect(
        JSON.stringify(many) === JSON.stringify([286, 308, 375]),
        "⑥b 多个号 + 裸圈码 `①②③` ⇒ 只抽出真正的号（286/308/375），裸圈码不算号",
        `⑥b 抽号结果不对：${JSON.stringify(many)}`,
      );
      // 端到端：合并主题里是 `#398③`，本版段写 `#398` ⇒ 覆盖成立（绿）
      const r = repo();
      commitFile(r, "src/base.js", "export const base = 1;\n", "base");
      r.run(["tag", "v1.0.0"]);
      mergeBranch(r, {
        branch: "feat/eta",
        rel: "src/eta.js",
        content: "export const eta = 1;\n",
        mergeMessage: "Merge PR #398③: feat: eta",
      });
      commitFile(r, "CHANGELOG.md", changelogFixture(["eta（issue #398）。"]), "changelog");
      const result = verifyChangelogCoverage({ root: r.dir });
      expect(
        result.status === 0 && result.verdict.covered === 1,
        "⑥c 主题写 `#398③`、本版段写 `#398` ⇒ 判成覆盖（归一在抽号里发生，不在比对里）",
        `⑥c 归一没生效：status=${result.status}，missing=${JSON.stringify(result.verdict?.missing?.map((m) => m.issue) ?? null)}`,
      );
    }

    // ── 例⑦ 区间与段是从树里现读的，不是写死的：换 tag / 换段 ⇒ 结论跟着变 ──
    {
      const r = repo();
      commitFile(r, "src/base.js", "export const base = 1;\n", "base");
      r.run(["tag", "v1.0.0"]);
      mergeBranch(r, {
        branch: "feat/theta",
        rel: "src/theta.js",
        content: "export const theta = 1;\n",
        mergeMessage: "Merge PR #777: feat: theta",
      });
      commitFile(r, "CHANGELOG.md", changelogFixture([]), "changelog");
      r.run(["tag", "v1.1.0"]);
      // 现在本版段（1.1.0）已经打了 tag，区间仍是 v1.0.0..v1.1.0 ⇒ 缺 #777
      const tagged = verifyChangelogCoverage({ root: r.dir, version: "1.1.0" });
      // 再补一个 1.2.0 段（未打 tag）⇒ 区间变成 v1.1.0..HEAD，HEAD 上没有新合并 ⇒ 缺项 0
      commitFile(r, "CHANGELOG.md", changelogFixture([]).replace("## [1.1.0] - 2026-01-01", "## [1.2.0] - 2026-01-02\n\n### Added\n\n- 空段。\n\n## [1.1.0] - 2026-01-01"), "changelog: 开 1.2.0 段");
      const newest = verifyChangelogCoverage({ root: r.dir });
      expect(
        tagged.status === 1 && tagged.range?.to === "v1.1.0" && newest.status === 0 && newest.version === "1.2.0",
        "⑦ 区间/段都从树里现读：打 tag 的版本按 tag 判，未打 tag 的最新段按 HEAD 判",
        `⑦ 现读失败：tagged=${tagged.status}/${tagged.range?.to}，newest=${newest.status}/${newest.version}`,
      );
    }

    // ── 例⑧ CI 接线：步骤存在、位置对、checkout 取全历史、npm script 指对本脚本 ──
    {
      const ciText = readFileSync(join(DEFAULT_ROOT, ".github/workflows/ci.yml"), "utf8");
      const pkg = JSON.parse(readFileSync(join(DEFAULT_ROOT, "package.json"), "utf8"));
      const agents = ["AGENTS.md", "AGENTS_cn.md"].map((rel) => readFileSync(join(DEFAULT_ROOT, rel), "utf8"));
      const problems = checkWiring(ciText, pkg, agents);
      expect(problems.length === 0, "⑧ CI/AGENTS/package.json 接线：阻塞步存在且在 `check:test-summary` 之后、`check:docs` 之前，checkout 取全历史", `⑧ 接线有问题：${problems.join(" / ")}`);
      // 变异没落上算失败：把那一行删掉，检查器必须点名；删不掉（文本没变）也算失败。
      const mutated = ciText.replace(/^\s*run: npm run check:changelog\s*$/mu, "");
      const mutationApplied = mutated !== ciText;
      const afterMutation = mutationApplied ? checkWiring(mutated, pkg, agents) : ["变异没落上（ci.yml 里找不到 `run: npm run check:changelog` 那一行）"];
      expect(
        mutationApplied && afterMutation.some((p) => p.includes("check:changelog")),
        "⑧b 把 CI 里那一行删掉 ⇒ 接线检查必须点名（变异没落上算失败）",
        `⑧b 变异后没红：落上=${mutationApplied}，问题=${afterMutation.join(" / ") || "无"}`,
      );
      // 三处 checkout 全去掉（只去掉一处时另两处还在 ⇒ 按份数判的接线检查不会红，这一例就成了空转）。
      const noDepth = ciText.replace(/^\s*fetch-depth: 0\s*$/gmu, "");
      const depthApplied = noDepth !== ciText;
      expect(
        depthApplied && checkWiring(noDepth, pkg, agents).some((p) => p.includes("fetch-depth")),
        "⑧c 去掉 checkout 的 `fetch-depth: 0` ⇒ 接线检查必须点名（浅克隆里没有 tag 与合并史，本闸只能 exit 2）",
        `⑧c 浅克隆没被点名：落上=${depthApplied}，问题=${checkWiring(noDepth, pkg, agents).join(" / ") || "无"}`,
      );
    }
  } finally {
    for (const r of repos) rmSync(r.dir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.log("");
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    console.log(`\nchangelog-coverage-check --self-test: 失败 — ${failures.length} 处未达预期（共 ${passed.length + failures.length} 条判据）`);
    return 1;
  }
  for (const ok of passed) console.log(`  ✓ ${ok}`);
  console.log(`\nchangelog-coverage-check --self-test: OK — ${passed.length} 条判据全部按预期`
    + "（os.tmpdir() 里自建的合成 git 仓，不依赖本仓历史与 tag 面）");
  return 0;
}

/**
 * 接线检查（自测用，也便于下一任读者一眼看见「接线」这个词指哪几处）。
 * 返回问题列表（空 = 接线完整）。
 *
 * @param {string} ciText
 * @param {{scripts?: Record<string, string>}} pkg
 * @param {string[]} agentsTexts
 * @returns {string[]}
 */
export function checkWiring(ciText, pkg, agentsTexts) {
  const problems = [];
  const lines = ciText.split("\n");
  const stepLine = lines.findIndex((line) => /^\s*run:\s*npm run check:changelog\s*$/u.test(line));
  const testSummaryLine = lines.findIndex((line) => /^\s*run:\s*npm run check:test-summary -- --self-test\s*$/u.test(line));
  const docsLine = lines.findIndex((line) => /^\s*run:\s*npm run check:docs\s*$/u.test(line));
  if (stepLine < 0) problems.push("ci.yml 里没有阻塞步 `run: npm run check:changelog`");
  if (testSummaryLine < 0) problems.push("ci.yml 里找不到 `check:test-summary -- --self-test` 那一步（位置判据的锚点）");
  if (docsLine < 0) problems.push("ci.yml 里找不到 `run: npm run check:docs` 那一步（位置判据的锚点）");
  if (stepLine >= 0 && testSummaryLine >= 0 && stepLine < testSummaryLine) {
    problems.push("`check:changelog` 排在了 `check:test-summary` **之前**（接线口径：Test suite / check:test-summary 之后）");
  }
  if (stepLine >= 0 && docsLine >= 0 && stepLine > docsLine) {
    problems.push("`check:changelog` 排在了 `check:docs` **之后**（接线口径：check:docs 之前）");
  }
  // 每个 `actions/checkout` 都要带 `fetch-depth: 0`（issue #802 起 CI 有三个 job、三处 checkout）：
  // 少一处就少一个 job 里的 tag 与合并史，那一族的闸只能 exit 2（未判定）。按「份数」判而不是「至少一处」，
  // 否则新加一个 job 忘了带 depth 时这一格是假绿。
  const checkoutCount = (ciText.match(/uses:\s*actions\/checkout@/g) ?? []).length;
  const depthCount = (ciText.match(/^\s*fetch-depth:\s*0\s*$/gmu) ?? []).length;
  if (checkoutCount === 0) {
    problems.push("ci.yml 里一处 `actions/checkout` 都没有——接线检查失去靶子");
  } else if (depthCount < checkoutCount) {
    problems.push(`checkout 少带了 \`fetch-depth: 0\`（${depthCount} 处 depth / ${checkoutCount} 处 checkout）——`
      + "浅克隆里既没有 tag 也没有合并史，那一 job 里的本闸只能 exit 2");
  }
  const script = pkg.scripts?.["check:changelog"];
  if (typeof script !== "string" || !script.includes("scripts/changelog-coverage-check.mjs")) {
    problems.push(`package.json 的 \`check:changelog\` 没有指向 scripts/changelog-coverage-check.mjs（实测：${JSON.stringify(script)}）`);
  }
  // issue #802：这里原来要求两份 AGENTS 的命令表里必须出现 `npm run check:changelog` 这串字。
  // 那是措辞警察——句子一改写/搬走就红，抓不到行为；而「这一步真的存在」由上面 ci.yml 的那条判据
  // 与 `package.json` 的 script 判据承担（那两处才是承重的接线）。现在只报一处 note，不进 problems。
  const agentsMentioning = agentsTexts.filter((text) => text.includes("npm run check:changelog")).length;
  checkWiring.notes = [`AGENTS 命令表提到 \`npm run check:changelog\` 的份数：${agentsMentioning}/${agentsTexts.length}（不判定，issue #802）`];
  return problems;
}

// ─────────────────────────────── CLI ───────────────────────────────

function parseArgs(argv) {
  const opts = { selfTest: false, json: false, root: DEFAULT_ROOT, version: null, from: null, to: null, help: false, error: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test") opts.selfTest = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--root") { opts.root = resolve(argv[i + 1] ?? ""); i += 1; }
    else if (arg.startsWith("--root=")) opts.root = resolve(arg.slice("--root=".length));
    else if (arg === "--version") { opts.version = argv[i + 1] ?? null; i += 1; }
    else if (arg.startsWith("--version=")) opts.version = arg.slice("--version=".length);
    else if (arg === "--from") { opts.from = argv[i + 1] ?? null; i += 1; }
    else if (arg.startsWith("--from=")) opts.from = arg.slice("--from=".length);
    else if (arg === "--to") { opts.to = argv[i + 1] ?? null; i += 1; }
    else if (arg.startsWith("--to=")) opts.to = arg.slice("--to=".length);
    else {
      console.error(`changelog-coverage-check: 不认识的参数 ${JSON.stringify(arg)}`
        + "（支持 --version <x.y.z> / --from <ref> / --to <ref> / --root <dir> / --json / --self-test / --help）");
      opts.error = true;
    }
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.error) return 2;
  if (opts.help) {
    console.log("用法：node scripts/changelog-coverage-check.mjs [--version <x.y.z>] [--from <ref>] [--to <ref>] [--root <dir>] [--json] [--self-test]");
    console.log("  默认：本版 = CHANGELOG 最新版本段，区间 = 版本序上更小的最大 tag .. 本版 tag（没有 tag 用 HEAD）");
    console.log("  退出码：0 绿 / 1 判据红 / 2 读不出真值（区间、段、git、合并列表）");
    return 0;
  }
  if (opts.selfTest) return runSelfTest();

  const result = verifyChangelogCoverage({ root: opts.root, version: opts.version, from: opts.from, to: opts.to });
  if (opts.json) {
    console.log(JSON.stringify({
      status: result.status,
      version: result.version,
      range: result.range ? { from: result.range.from, to: result.range.to } : null,
      notes: result.notes,
      errors: result.errors,
      reds: result.verdict?.reds ?? [],
      missing: result.verdict?.missing.map((m) => ({ issue: m.issue, sha: m.merge.short, publicFiles: m.merge.publicFiles })) ?? [],
      counts: result.verdict
        ? {
          merges: result.merges.length,
          publicMerges: result.verdict.publicMerges,
          publicNumbers: result.verdict.publicNumbers.length,
          covered: result.verdict.covered,
          exempt: result.verdict.exemptTotal,
          missing: result.verdict.missing.length,
          unattributed: result.verdict.unattributed,
        }
        : null,
    }, null, 2));
    return result.status;
  }

  for (const note of result.notes) console.log(`  · ${note}`);
  for (const error of result.errors) console.error(`  ✗ [${error.code}] ${error.message}`);
  for (const red of result.verdict?.reds ?? []) console.error(`  ✗ ${red.message}`);
  if (result.status === 0) {
    console.log(`changelog-coverage: OK — ${result.version} 段覆盖了区间 ${result.range.from}..${result.range.to} 里`
      + `每一个碰到公开面的合并号（命中 ${result.verdict.covered} / 登记豁免 ${result.verdict.exemptTotal} / 缺项 0）`);
  } else if (result.status === 2) {
    console.error(`changelog-coverage: 读不出真值（${result.errors.map((e) => e.code).join(",") || "unknown"}）——读不出永远不等于绿`);
  } else {
    console.error(`changelog-coverage: 红 ${result.verdict.reds.length} 处（缺项 ${result.verdict.missing.length} 个，见上）`);
  }
  return result.status;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  process.exitCode = main();
}
