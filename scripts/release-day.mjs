#!/usr/bin/env node
// @ts-check
// release-day.mjs — issue #689：把发版日收敛成**一条命令**，但保留人工那一半。
//
// 病根（issue #686 复盘，0.30.0 发布当天两件事都是**人工串步骤**漏掉的）：
//   ① 发布后**发布态回写**没做——文档里还写着「未发布 / latest 0.29.0」，而 registry 已经是 0.30.0；
//   ② 升级指南写着「16 个导出已在 0.30 删除」，而运行时全还在（已由 #687 / #688 修掉）。
// 人工面写在 `AGENTS.md` §4「Pre-release checklist」与「Release verification loop」——流程本身是对的，
// 但它是六条命令加一堆坑备注，靠人记顺序。这一页把顺序、闸门、回写、tag、双推、双侧现验、续跑都机器化，
// 只把**必须人做**的那一步（`npm publish` 的 device-flow 扫码）留在人手里。
//
// ── 四个阶段（`--stage`；`--all` 按序跑）────────────────────────────────────────
//   preflight  AGENTS §4 的前置清单，按顺序跑，**任一红就停在那一步并点名第几步**：
//                1 `npm run check:changelog`           本版 CHANGELOG 覆盖了碰到公开面的合并号（issue #691）
//                2 `[Unreleased]` 漏搬（**本脚本内联判据，不 spawn**，issue #715）——三态，见下面那一节
//                3 `npm run check:docs`                 文档漂移 + 中英同步
//                4 `npm run check:docs:strict`          同上，告警也阻塞
//                5 `ERIX_E2E_REAL=1 npm run check:release:real`   真上游；**闸门关着 ⇒ 未判定**
//                6 `npm run check:release`              离线：tarball / 装好的包 / TS 宿主 / 假上游 CLI
//                7 `npm run check:host-consumers -- --hosts …`   宿主侧探针；**没给目录或目录不在 ⇒ 未判定**
//              未判定（not-judged）**不是绿**：`ERIX_E2E_REAL` 缺失时那一族一步都不跑，脚本明说「未判定」，
//              整体 exit 2（不是 0）。目录不存在按探针自己的口径（`HOST_DIR_MISSING` / `HOST_DIR_NOT_DIR`）判未判定。
//              第 2 步同样会答「未判定」（exit 2）：**还没切版**时它判不了「搬没搬」，那时整趟 preflight 就是
//              未判定——先切版（bump `package.json` + 开节 + 把标题行插到条目之前），再跑 preflight。
//   publish    脚本**不 fork `npm publish`**（理由见下）。preflight 全绿后它把「请你自己在终端跑 `npm publish`」
//              与四条注意一次性打出来，然后 exit 3（= 等你发布）。`--publish-cmd <cmd>` 是**显式开关**，
//              默认关：不给就永不 fork。
//   writeback  发布成功之后**先回写发布态、再打 tag**（顺序反过来就是 0.30.0 那一幕）。它做三件事：
//              ① `node scripts/docs-drift-check.mjs --sync --published <版本>`（只改发布态那几句）
//              ② 把回写提交掉（`git commit -a`，只提交已跟踪文件的改动）
//              ③ **立刻重跑 `npm run check:docs`** 证明回写自洽
//   finalize   清 `src/**/*.d.ts` → 打附注 tag `v<版本>`（指向**切版提交**，不指向回写提交；依据是
//              `git blame` 现读的 `package.json` version 行，先例 `v0.30.0`）→ `git push origin main` 与
//              `git push origin v<版本>`（`origin` 是双推：GitHub + Gitea）→ 两个 URL 各 `git ls-remote` 现验
//              （不一致就红）→ 再跑一遍 `check:docs` / `check:docs:strict`。**永不 `--force`**：main 有分支
//              保护，禁 force-push；非快进就让 push 自己失败。
//
// ── 为什么脚本不自己 publish（照 AGENTS §4 的坑写死）──────────────────────────────
//   · npm 12 在 `~/.npm-global/bin/npm`，被 `/usr/bin/npm`（10.x）遮蔽 ⇒ 必须绝对路径，否则 404/401 PUT
//     会把人引到错的一层去诊断；
//   · `npm publish` **每次都要独立的 device-flow 认证**（`npm login` 过也一样）；
//   · 非 TTY 下认证 URL 会被打码成 `***` ⇒ 只有用户自己的终端能给出真 URL；
//   · **不能按 ENTER**：无桌面时 `xdg-open` 失败会直接把 npm 弄死（exit 3）；不按 ENTER，npm 会继续轮询；
//   · 成功行 `+ erix-agent@<ver>` 之后 registry 还可能滞后约 2 分钟（PUT 202）。
//   把这几条塞进一个后台 fork 里，就是把「人必须在场」的那一步伪装成自动化——所以 publish 阶段的产物是
//   **一张给人看的操作单**，不是一个子进程。
//
// ── 状态机与失败纪律（`$RUNNER_TEMP`/临时目录里的状态文件，**不入库**）───────────────
//   状态文件 = `erix-release-day-state.json`（`--state <file>` 或 `RELEASE_DAY_STATE` 可覆盖；
//   `--dry` 一个字节都不写）。四个相位：`preflight_ok` → `published_unwritten` → `written` → `finalized`。
//   **「publish 成功但回写失败」必须是可恢复状态而不是事故**：writeback 一进门就先把
//   `phase=published_unwritten` + `published=<版本>` 落盘，回写/提交/`check:docs` 任一红都把它留在盘上；
//   `--all` 重跑时读到这个相位就**从 writeback 续跑**（不再走 preflight、也不再打 publish 操作单），
//   所以既不会重复发布，也不会把「已发布」忘在脑后。
//   **不许发生「tag 打出去了但文档还写着未发布」**：finalize 的顺序闸要求状态文件里
//   `phase=written`（= 回写已提交且 `check:docs` 绿），并且要求工作树干净（回写没提交就不许打 tag）。
//
// ── 退出码（本仓惯例：读不出真值 / 未判定都不是绿）────────────────────────────────
//   0 = 这一阶段（或 `--all` 走到的阶段）完成了
//   1 = 有闸红了（preflight 某步红 / 回写红 / 顺序闸 / 两侧不一致）
//   2 = 未判定或参数不足（preflight 有未判定的步骤、`--published` 没给、双推没法互验）
//   3 = preflight 全绿、**等你发布**（`--all` 的正常停点；发完用 `--stage writeback` 续跑）
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   npm run release:day -- --stage preflight [--hosts <宿主仓目录> …]
//   npm run release:day -- --stage publish
//   npm run release:day -- --stage writeback --version <x.y.z> --published <x.y.z> [--published-date <YYYY-MM-DD>]
//   npm run release:day -- --stage finalize [--version <x.y.z>]
//   npm run release:day -- --all [--hosts …]          # 按序跑；publish 那一步是人工停点
//   npm run release:day -- --all --dry                # 什么都不改、什么都不发、不写盘
//   npm run release:day -- --self-test                # 离线反向证（合成树 / 假 runner，不联网、不装包）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
// issue #731 N4/N3：CHANGELOG 的「版本节标题 / 段首日期 / bullet」三条口径是**共享**的，不是各抄一份。
// 日期正则此前是两侧字面拷贝，标题正则已经分叉（这里 `^##\s*\[`，`docs-drift-check` 那边字面单空格）
// ⇒ `##  [0.31.0]`（双空格）两个读者两个答案。口径与理由住在 `scripts/changelog-heading.mjs` 里。
import {
  CHANGELOG_DATED_HEADING_SUFFIX,
  CHANGELOG_UNRELEASED_HEADING,
  changelogHeadingIsDated,
  changelogVersionHeadingRe,
  isChangelogBulletLine,
  matchChangelogVersionHeading,
} from "./changelog-heading.mjs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS_SYNC_SCRIPT = "scripts/docs-drift-check.mjs";

/** 退出码（报告、自测、CI 共用一份）。 */
export const EXIT = Object.freeze({ OK: 0, RED: 1, NOT_JUDGED: 2, AWAITING_PUBLISH: 3 });

/** 一步的裁决：`pass` / `fail` / `not-judged`（未判定 ≠ 绿）。 */
export const VERDICT = Object.freeze({ PASS: "pass", FAIL: "fail", NOT_JUDGED: "not-judged" });

/** 阶段顺序（`--all` 按这个顺序走）。 */
export const STAGES = Object.freeze(["preflight", "publish", "writeback", "finalize"]);

/** 状态文件的四个相位（顺序即纪律；`published_unwritten` 是「已发布、未回写」的可恢复态）。 */
export const PHASE = Object.freeze({
  PREFLIGHT_OK: "preflight_ok",
  PREFLIGHT_NOT_JUDGED: "preflight_not_judged",
  PUBLISHED_UNWRITTEN: "published_unwritten",
  WRITTEN: "written",
  FINALIZED: "finalized",
});

/**
 * preflight 的七步（AGENTS §4 的前置清单，顺序即清单顺序）。两种步骤形状：
 *   · `argv`   —— spawn 一个子进程跑 npm script；
 *   · `probe`  —— **内联判据**（`PREFLIGHT_PROBES` 里的函数，只读文件、不 spawn），issue #715 的漏搬格就是它。
 * `gate` 非空 ⇒ 这一步可能是「未判定」：
 *   · `ERIX_E2E_REAL` —— 环境变量闸门关着时真上游那一族**一步都不跑**；
 *   · `hosts`         —— 没给 `--hosts` 或给的目录都不在时，探针自己也是「未判定」。
 * `probe` 步骤自己也会答「未判定」（读不出搬运事实时），口径与本文件其余 gate 一致：未判定不是绿。
 *
 * 第 1 步是 issue #691 的 CHANGELOG 覆盖闸：它读的是本版段 × 上一个 tag 以来的 first-parent 合并，
 * 与「发出去的这一版到底改了什么」直接相关，所以排在最前（最便宜，且它红了后面那一族没必要跑）。
 * 第 2 步（issue #715）是同一主题的另一半——`[Unreleased]` 里的条目到底搬进本版段没有——所以紧跟其后。
 */
export const PREFLIGHT_STEPS = Object.freeze([
  { id: "changelog", label: "check:changelog", argv: ["npm", "run", "check:changelog"] },
  // issue #715：这一格是**内联判据**（`probe` 非空 ⇒ 走 `PREFLIGHT_PROBES`，不 spawn 子进程）。它读的是
  // 两棵树里的文件（`package.json` + `CHANGELOG.md`），最便宜，而且与第 1 步同一主题，所以紧跟其后。
  // `docCommand`：这一格在两份 AGENTS 的 §4 清单里打印的那一列命令。内联判据步骤**没有 `argv`**，
  // 那一列就无从推导，所以必须显式声明——`reconcilePreflightChecklist` 拿它逐格对账中英两份清单，
  // 新加一步（无论 spawn 还是 probe）忘了声明就当场红（issue #731 T7）。
  {
    id: "changelog-unreleased",
    label: "CHANGELOG [Unreleased] 漏搬（内联判据）",
    probe: "unreleasedCarry",
    docCommand: "CHANGELOG [Unreleased] carry",
  },
  { id: "docs", label: "check:docs", argv: ["npm", "run", "check:docs"] },
  { id: "docs-strict", label: "check:docs:strict", argv: ["npm", "run", "check:docs:strict"] },
  {
    id: "release-real",
    label: "ERIX_E2E_REAL=1 check:release:real",
    argv: ["npm", "run", "check:release:real"],
    env: { ERIX_E2E_REAL: "1" },
    gate: "ERIX_E2E_REAL",
  },
  { id: "release", label: "check:release", argv: ["npm", "run", "check:release"] },
  { id: "host-consumers", label: "check:host-consumers -- --hosts …", argv: ["npm", "run", "check:host-consumers"], gate: "hosts" },
]);

/**
 * AGENTS §4 前置清单那一行的形状：`#   [i/N] <命令列>····<说明>`（在 ```bash 围栏里，`#` 是注释符）。
 * 命令列与说明之间用**两个以上空格**对齐分隔——两份 AGENTS 的这七行都这么排。
 */
const PREFLIGHT_CHECKLIST_ROW_RE = /^#\s+\[(\d+)\/(\d+)\]\s+(.+)$/u;

/**
 * 这一步在**两份 AGENTS 清单里必须出现的那一列命令**——唯一来源是这一步自己的定义，不是文档抄件。
 *
 * 推导规则（全机械，不引入第二份名单）：
 *   · `env` 里的键值对写成 `K=V` 前缀（第 5 步 ⇒ `ERIX_E2E_REAL=1 check:release:real`）；
 *   · 有 `argv` 的 spawn 步骤取 npm script 名（`argv[2]`）；`gate: "hosts"` 的补上 ` -- --hosts …`；
 *   · 内联判据步骤（没有 `argv`）只能显式声明 `docCommand`——**没有默认值**，缺了就红（fail-closed）。
 *
 * @param {{id: string, argv?: string[], env?: Record<string, string>, gate?: string, docCommand?: string}} step
 * @returns {string|null} 期望的那一列；`null` = 这一步无法推导（缺 `docCommand`），由调用方判红
 */
export function preflightDocCommand(step) {
  const prefix = step.env ? Object.entries(step.env).map(([k, v]) => `${k}=${v}`).join(" ") : "";
  const base = step.argv ? step.argv[2] : step.docCommand;
  if (!base) return null;
  const suffix = step.gate === "hosts" ? " -- --hosts …" : "";
  return `${prefix ? `${prefix} ` : ""}${base}${suffix}`;
}

/**
 * issue #731 T7：**中英两份 AGENTS 的手工清单 × `PREFLIGHT_STEPS` 的对账**（返回问题清单，空 = 一致）。
 *
 * 病根：AGENTS §4 那七行 `[1/7]…[7/7]` 是人手维护的，而运行期打印的 `[i/N]` 由 `PREFLIGHT_STEPS.length`
 * 现算——**运行期那一侧有人钉（`test/release-day.test.js` 认 `[2/7]`），文档这一侧没有**，于是「文档说 7 步、
 * 实际 8 步」可以一路绿着进主干。这一格把文档那一侧也接上同一个真值：
 *   · 行数必须等于 `PREFLIGHT_STEPS.length`（加一步而文档没加行 ⇒ 红；删一行 ⇒ 红）；
 *   · 每行的分子必须是 `1..N` 连续（不许跳号）、分母必须等于步数（`[2/8]` 这种漂了的分母当场红）；
 *   · 每行的**命令列**必须逐字等于 `preflightDocCommand(step)`（改名 ⇒ 红；换顺序 ⇒ 红）；
 *   · 一个 `[i/N]` 行都找不到 ⇒ 也红（清单被删/形状改了不算绿，那是「读不出」）。
 * 中英两份都要扫：两侧的命令列是**同一份英文命令**（清单在 CN 文档里也不翻译命令），所以同一套期望值复用。
 *
 * @param {string} docText 一份文档的全文
 * @param {{steps?: Array<object>, doc?: string}} [options] `steps` 只给自测用（模拟「主干加了一步」）
 * @returns {string[]} 问题清单（人读；空数组 = 对得上）
 */
export function reconcilePreflightChecklist(docText, { steps = PREFLIGHT_STEPS, doc = "AGENTS" } = {}) {
  const rows = [];
  String(docText).split("\n").forEach((line, i) => {
    const m = PREFLIGHT_CHECKLIST_ROW_RE.exec(line);
    if (!m) return;
    rows.push({
      line: i + 1,
      ordinal: Number(m[1]),
      total: Number(m[2]),
      command: m[3].split(/\s{2,}/u)[0].trim(),
    });
  });
  if (!rows.length) {
    return [`${doc}: 找不到任何 \`#   [i/N] <命令>\` 形状的 preflight 清单行——`
      + "清单被删了或换了形状（对账失去对象），这不算绿"];
  }
  const problems = [];
  if (rows.length !== steps.length) {
    problems.push(`${doc}: 清单列了 ${rows.length} 步，而 PREFLIGHT_STEPS 有 ${steps.length} 步——`
      + `第 ${Math.min(rows.length, steps.length) + 1} 边缺一行（加/删一步要同时改中英两份文档）`);
  }
  rows.forEach((row, index) => {
    if (row.ordinal !== index + 1) {
      problems.push(`${doc}:${row.line} 的序号是 [${row.ordinal}/...]，按行序应为 [${index + 1}/...]（不许跳号或换顺序）`);
    }
    if (row.total !== steps.length) {
      problems.push(`${doc}:${row.line} 的分母是 /${row.total}，而 PREFLIGHT_STEPS.length = ${steps.length}`
        + "（分母由步数现算，抄来的那个数一漂就没人管）");
    }
    const step = steps[index];
    if (!step) {
      problems.push(`${doc}:${row.line} 多出一步（第 ${index + 1} 步在 PREFLIGHT_STEPS 里不存在）：${row.command}`);
      return;
    }
    const expected = preflightDocCommand(step);
    if (expected === null) {
      problems.push(`${doc}: 第 ${index + 1} 步（id=${step.id}）既没有 argv 也没有 docCommand ⇒ `
        + "AGENTS 清单那一列无从推导（内联判据步骤必须显式声明 docCommand）");
      return;
    }
    if (row.command !== expected) {
      problems.push(`${doc}:${row.line} 的命令列是 ${JSON.stringify(row.command)}，`
        + `而 PREFLIGHT_STEPS 第 ${index + 1} 步（id=${step.id}）要求 ${JSON.stringify(expected)}`);
    }
  });
  return problems;
}

/** publish 阶段的操作单（照 AGENTS §4 的坑逐条写死；每一条都是踩过的）。 */
export const PUBLISH_NOTES = Object.freeze([
  "npm 12 在 `~/.npm-global/bin/npm`，被 `/usr/bin/npm`（10.x）遮蔽——**必须用绝对路径**调它，否则 404/401 PUT 会把人引到错的一层",
  "`npm publish` **每次都要独立的 device-flow 认证**（`npm login` 过也一样）；非 TTY 下 URL 会被打码成 `***`，所以必须在你自己的终端里跑",
  "**不要按 ENTER**：无桌面时 `xdg-open` 失败会直接把 npm 弄死（exit 3）；不按 ENTER，npm 会继续轮询认证状态",
  "成功行是 `+ erix-agent@<ver>`；之后 registry 可能滞后约 2 分钟（PUT 202），别急着判失败（`npm view erix-agent version --prefer-online`）",
]);

// ─────────────────────────────── 基础设施 ───────────────────────────────

/** 默认依赖：`run` 把输出直接透到终端（长门禁要能看见进度），`capture` 抓 stdout 给 git 管道用。 */
function defaultDeps() {
  return {
    /** @type {(argv: string[], opts?: {cwd?: string, env?: Record<string,string>}) => {status: number}} */
    run: (argv, opts = {}) => {
      const result = spawnSync(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "inherit", "inherit"],
      });
      return { status: result.status ?? 1 };
    },
    /** @type {(argv: string[], opts?: {cwd?: string, env?: Record<string,string>}) => {status: number, stdout: string, stderr: string}} */
    capture: (argv, opts = {}) => {
      const result = spawnSync(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    log: (line = "") => console.log(line),
    env: process.env,
  };
}

const nowIso = (deps) => (typeof deps.now === "function" ? deps.now() : new Date().toISOString());

/** 状态文件路径：`--state` > `RELEASE_DAY_STATE` > `$RUNNER_TEMP` / `os.tmpdir()`（**不入库**）。 */
export function stateFilePath({ stateFile = null, env = process.env } = {}) {
  if (stateFile) return path.resolve(stateFile);
  if (env.RELEASE_DAY_STATE) return path.resolve(env.RELEASE_DAY_STATE);
  const dir = env.RUNNER_TEMP || env.TMPDIR || os.tmpdir();
  return path.join(dir, "erix-release-day-state.json");
}

/** @returns {any|null} 读不出（没有 / 坏 JSON）⇒ null：**没有状态就是「什么都没做」**。 */
function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeState(file, state) {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** 读 `package.json` 的版本（回写与 tag 的唯一版本真值）。 */
function pkgVersion(root) {
  const text = readFileSync(path.join(root, "package.json"), "utf8");
  const version = JSON.parse(text).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`package.json 的 version 不是 x.y.z：${JSON.stringify(version)}`);
  }
  return version;
}

/** 递归列出 `src/**\/*.d.ts`（生成物，finalize 前必须清掉：残留会让 `check:types` 假绿）。 */
function generatedDeclarations(root) {
  const src = path.join(root, "src");
  if (!existsSync(src)) return [];
  return readdirSync(src, { recursive: true })
    .filter((rel) => String(rel).endsWith(".d.ts"))
    .map((rel) => path.join(src, String(rel)));
}

/** 一个 argv 的人类可读形态（报错时点名用；env 前缀也算进去）。 */
function cmdline(argv, env = {}) {
  const prefix = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ");
  return `${prefix ? `${prefix} ` : ""}${argv.join(" ")}`;
}

// ────────────────── preflight 的内联判据：`[Unreleased]` 漏搬（issue #715） ──────────────────
//
// 病根（本单开单时现验，可当事实）：`## [Unreleased]` 里的条目**没有任何机制**把它搬进下一个版本节，
// 也没有任何机制提醒：
//   · `release:day --stage writeback` 的 `--sync` **只重写已存在的版本标题那一行**；那一版**没有段**时
//     「CHANGELOG 一个字节未动」并记一笔 note，**绝不造段**（`scripts/docs-drift-check.mjs:502-508`）；
//   · `--stage finalize` 只清 `src/**/*.d.ts` + 打 tag；
//   · `check:changelog` 对 `[Unreleased]` **全程隐形**：`SECTION_HEADING = /^##\s*\[(\d+\.\d+\.\d+)\]/u`
//     （`scripts/changelog-coverage-check.mjs:139`），注释自陈「跳过 `[Unreleased]`」，本版 = 第一个数字段；
//     而且它比对的是**合并主题里的 PR 号**（`git log --first-parent --merges --pretty=%H%x1f%s` 取号）；
//   · `check:docs` 同样只认数字段（`changelogSections()` 的 `/^## \[(\d+\.\d+\.\d+)\]/`），
//     现跑全份输出里 `grep -c Unreleased` = 0；
//   · `guide-coverage`（`scripts/docs-drift-check.mjs:6541`）只兜「版本号升了而段没开」；
//   · 配对地板（`test/static-guards.test.js` 的 `CHANGELOG_PAIR_FLOOR`）只兜「新版本节被开成空节」：
//     条目留在原地时判据面**就是** `[Unreleased]`，1 对 = 地板 ⇒ 绿。
// 所以这一格只判**一种形态**：`package.json` 那一版的版本节**已经开了**（切版做完了），而条目**还停在**
// `## [Unreleased]`。三态（「未判定」不是绿，与本文件其余 gate 同口径）：
//   ① 红（exit 1）    版本节已开（且还是未发布形态）＋ `[Unreleased]` 里仍有 bullet ⇒ 判词点名条数、逐条给
//                     前 60 字，并给出**可执行动作**：按 4963293 的形状把 `## [<版本>]` 那一行放到
//                     `## [Unreleased]` 与条目之间（正文一字不动，`[Unreleased]` 留空）；
//   ② 未判定（exit 2）三种「读不出这一版的搬运事实」：
//                     (a) `package.json` 那一版**还没有版本节** ⇒ 还没切版，先开节再搬运；
//                     (b) 那一版**已有版本节、但段首带发布日期** ⇒ 那是**已发布**的一版，`[Unreleased]` 里那些
//                         条目属于下一版 ⇒ 还没切版。**这一条就是「不许做成 `[Unreleased]` 非空即红」的落点**：
//                         preflight 可能跑在切版之前，那时 `[Unreleased]` 里本来就该有待入账条目；
//                     (c) `package.json` 版本 / `CHANGELOG.md` 读不出；
//   ③ 绿（exit 0）    版本节已开 且 `[Unreleased]` 为空。
//
// **不新写一个 CHANGELOG 解析器**：扫描面复用 `test/static-guards.test.js` 的 `CHANGELOG_VERSION_HEADING`
// + `resolveChangelogScanSurface` 的口径（顶部节 = `## [Unreleased]`，其下到下一个 `## ` 为止；bullet =
// 行首 `- `；顶部节被改名 ⇒ 红并点名「找不到版本节」，不许静默绿），段首「带不带发布日期」复用
// `docs-drift-check.mjs` 的 `changelogSections()` 那一条正则。版本号从 `package.json` 现读，**不写死**。

/** 顶部版本节标题（唯一来源：`scripts/changelog-heading.mjs`；`test/static-guards.test.js` 读同一份）。 */
export const UNRELEASED_HEADING = CHANGELOG_UNRELEASED_HEADING;

/** 判词里每条 bullet 的前若干字（issue #715 的判据要求：逐条列前 60 字）。 */
const BULLET_PREVIEW = 60;

/**
 * 段首那一行「带发布日期」的口径——与 `docs-drift-check.mjs` 的 `changelogSections()` **同一条正则**
 * （issue #731 N4：那一侧历史上是**字面拷贝**而非 import；现在两侧都从 `scripts/changelog-heading.mjs`
 * 现读，抄件的入口被封掉——字面回到调用方就让自测 ⑯c 红，别在注释里再抄一遍正则。）
 */
const DATED_HEADING_SUFFIX = CHANGELOG_DATED_HEADING_SUFFIX;

/** 一条 bullet 的前 `BULLET_PREVIEW` 字（超长才加省略号）。 */
function bulletPreview(text) {
  const flat = String(text).trim();
  return flat.length > BULLET_PREVIEW ? `${flat.slice(0, BULLET_PREVIEW)}…` : flat;
}

/** 一条内联判据的返回值（`verdict` 是 `VERDICT` 之一；`lines` 是给人看的动作与证据）。 */
function finding(verdict, why, lines = []) {
  return { verdict, why, lines };
}

/**
 * issue #715：`[Unreleased]` 里的条目**搬进本版段了没有**。只读两棵树里的文件，不写盘、不 spawn。
 *
 * @param {{root?: string}} [options]
 * @returns {{verdict: string, why: string, lines: string[]}}
 */
export function probeUnreleasedCarry({ root = DEFAULT_ROOT } = {}) {
  let version;
  try {
    version = pkgVersion(root);
  } catch (error) {
    return finding(VERDICT.NOT_JUDGED,
      `package.json 的版本读不出（${error && error.message ? error.message : error}）——没有版本真值就判不了「搬没搬」`);
  }
  let text = null;
  try {
    text = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  } catch {
    text = null;
  }
  if (text === null) {
    return finding(VERDICT.NOT_JUDGED, "CHANGELOG.md 读不出——`[Unreleased]` 与版本节的相对位置无从判");
  }
  const lines = text.split("\n").map((line) => line.replace(/\r$/u, ""));
  const isSectionHeading = (line) => /^## /u.test(line);
  const sectionEnd = (start) => {
    for (let i = start + 1; i < lines.length; i += 1) if (isSectionHeading(lines[i])) return i;
    return lines.length;
  };

  const top = lines.findIndex((line) => /^## \[/u.test(line));
  if (top === -1 || !lines[top].startsWith(UNRELEASED_HEADING)) {
    return finding(
      VERDICT.FAIL,
      `找不到版本节 ${JSON.stringify(UNRELEASED_HEADING)}——顶部第一个版本标题是 ${top === -1 ? "（没有）" : JSON.stringify(lines[top])}`,
      [
        `动作：在版本标题最上面补一行 \`${UNRELEASED_HEADING}\`（发布时把 \`[Unreleased]\` 改名成 \`## [<版本>] - <日期>\` 的**同一步**就得补新的；先例 4963293）。`,
        "     没有这一节，条目就没有「还没入账」的容器，本步也判不了——所以它不静默绿（`test/static-guards.test.js` 的规则 8 对同一形态也是红）。",
      ],
    );
  }

  const topTo = sectionEnd(top);
  /** @type {Array<{line: number, text: string}>} */
  const bullets = [];
  // bullet 的行级口径 = 共享谓词（issue #731 N3：`test/static-guards.test.js` 的三处同一份）。
  for (let i = top + 1; i < topTo; i += 1) if (isChangelogBulletLine(lines[i])) bullets.push({ line: i + 1, text: lines[i] });

  // **标题口径 = 共享的那一条**（`##` + 恰好一个空格 + `[`）。此前这里是 `^##\s*\[<版本>\]`（容忍多空格），
  // 而 `docs-drift-check.mjs` 的字面单空格 ⇒ `##  [0.31.0]（未发布）` 两边给不同答案（issue #731 N4）。
  // 现在歪缩进的标题在**这一格**也算「还没有本版的版本节」⇒ 走下面的 (a)「还没切版」未判定，
  // 判词给出「插入 `## [<版本>]（未发布 / unpublished）`」的动作；这与 `check:docs` 那一侧的读数一致。
  const sectionAt = lines.findIndex((line) => changelogVersionHeadingRe(version).test(line));
  const sectionHeading = sectionAt === -1 ? null : lines[sectionAt];
  const suffix = sectionHeading === null
    ? ""
    : (matchChangelogVersionHeading(sectionHeading)?.suffix ?? "");
  const dated = changelogHeadingIsDated(suffix);

  // (a) 还没切版：package.json 那一版在 CHANGELOG 里没有段
  if (sectionAt === -1) {
    return finding(VERDICT.NOT_JUDGED, `还没切版：CHANGELOG 里没有 ${version} 的版本节`, [
      `动作：① 在 \`${UNRELEASED_HEADING}\`（第 ${top + 1} 行）与它的内容之间插入一行 \`## [${version}]（未发布 / unpublished）\`（形状见 4963293：只加这一行，正文一字不动）；`,
      `     ② 条目跟着标题行一起下移，\`${UNRELEASED_HEADING}\` 留空；③ 切完再跑本步。`,
      `     现状：\`${UNRELEASED_HEADING}\` 里 ${bullets.length} 条待入账条目。`,
    ]);
  }

  // ③ 绿：版本节已开 且 `[Unreleased]` 为空
  if (bullets.length === 0) {
    return finding(VERDICT.PASS,
      `${version} 的版本节在第 ${sectionAt + 1} 行，\`${UNRELEASED_HEADING}\` 里 0 条待入账条目`);
  }

  // (b) 版本节已开、但段首带发布日期 ⇒ 那一版已经发布，`[Unreleased]` 里这些条目属于下一版。
  //
  // ⚠ **这一格只是消费者，等价前提住在另一道闸**（issue #731 N2）：本格把「段首带发布日期」当成
  //   「那一版已发布」，这条等价**不在这里成立**，它成立在 `check:docs` 的那一半——
  //   `scripts/docs-drift-check.mjs` §17b（issue #697 判据 1）：「正在准备的那一段（版本序最高的版本段）
  //   标了未发布就不许带发布日期 ⇒ 红」。那道闸在，「带日期的段」与「在飞的段」才是两个不相交的集合。
  //   后果要写死：那条不变量哪天被放宽（例如允许未发布段带日期、或把「最高段」的口径改掉），
  //   本格就会把**带日期的在飞段永远判成未判定**——未判定不是绿，但也不再有人红，等于这一格静默失效。
  //   所以：动 §17b 之前先动这里（自测 ⑯d 会当场指出这条依赖已经断）。
  if (dated) {
    return finding(
      VERDICT.NOT_JUDGED,
      `还没切版：${version} 的版本节（第 ${sectionAt + 1} 行）段首带发布日期 ⇒ 那是已发布的一版，`
        + `\`${UNRELEASED_HEADING}\` 里 ${bullets.length} 条属于下一版`,
      [
        `动作：把 \`package.json\` 的 version 升到下一版，再在 \`${UNRELEASED_HEADING}\` 与条目之间插入 \`## [<新版本>]（未发布 / unpublished）\`（形状见 4963293）；切完再跑本步。`,
        "     这一条不是「`[Unreleased]` 非空即红」：preflight 可能跑在切版之前，那时 `[Unreleased]` 里本来就该有待入账条目。",
        "     凭什么「带发布日期」就等于「已发布」：`check:docs` 的 §17b（issue #697 判据 1）钉着"
        + "「正在准备的那一段标了未发布就不许带发布日期 ⇒ 红」——本格**消费**那条不变量，自己不复述它；"
        + "它一旦被放宽，这一格会把带日期的在飞段永远判成未判定（自测 ⑯d 钉住这条依赖）。",
      ],
    );
  }

  // ① 红：版本节已开（未发布形态）＋ 条目还停在 `[Unreleased]`
  return finding(
    VERDICT.FAIL,
    `${bullets.length} 条未入账条目停在 \`${UNRELEASED_HEADING}\`（第 ${top + 1} 行），`
      + `而 ${version} 的版本节已经开了（第 ${sectionAt + 1} 行：${String(sectionHeading).trim()}）`,
    [
      `动作：按 4963293 的形状，把 \`## [${version}]\` 那一行放到 \`${UNRELEASED_HEADING}\` 与条目之间——`
        + `第 ${sectionAt + 1} 行那一行挪上来（没有就新建 \`## [${version}]（未发布 / unpublished）\`），`
        + `正文一字不动，\`${UNRELEASED_HEADING}\` 留空。`,
      "     既有防线都不看这一形态：`check:changelog` 只认数字段（且比对的是合并主题里的 PR 号）、"
        + "`guide-coverage` 只兜「版本号升了而段没开」、配对地板只兜「新版本节被开成空节」。",
      `     待入账条目（前 ${BULLET_PREVIEW} 字）：`,
      ...bullets.map((bullet, i) => `       ${String(i + 1).padStart(2, " ")}. 第 ${bullet.line} 行 ${bulletPreview(bullet.text)}`),
    ],
  );
}

/** 内联判据表（`PREFLIGHT_STEPS` 里 `probe` 非空的步骤走这里；只读、不 spawn）。 */
const PREFLIGHT_PROBES = Object.freeze({ unreleasedCarry: probeUnreleasedCarry });

// ─────────────────────────────── preflight ───────────────────────────────

/**
 * 跑 AGENTS §4 的前置清单。**任一红 ⇒ 停在那一步并点名第几步**；未判定的步骤收集起来，整体判未判定。
 *
 * @param {{root?: string, hosts?: string[], deps?: ReturnType<typeof defaultDeps>, dry?: boolean}} [options]
 * @returns {{verdict: string, steps: Array<{id: string, verdict: string, exitCode?: number, why?: string}>,
 *            failedAt?: number, failedId?: string}}
 */
export function runPreflight({ root = DEFAULT_ROOT, hosts = [], deps = defaultDeps(), dry = false } = {}) {
  const { run, log, env } = deps;
  /** @type {Array<{id: string, verdict: string, exitCode?: number, why?: string}>} */
  const steps = [];
  const total = PREFLIGHT_STEPS.length;
  if (dry) log("preflight（--dry：只读门禁照跑，脚本自己不写盘、不发、不打 tag）");
  for (const [index, step] of PREFLIGHT_STEPS.entries()) {
    const n = index + 1;
    const head = `[${n}/${total}] ${step.label}`;
    let argv = step.argv ? step.argv.slice() : [];
    const stepEnv = { ...env, ...(step.env ?? {}) };
    if (step.probe) {
      // 内联判据（issue #715）：只读文件、不 spawn；三态与本文件其余 gate 同口径。
      const found = PREFLIGHT_PROBES[step.probe]({ root });
      if (found.verdict === VERDICT.FAIL) {
        log(`${head} → **红**（exit ${EXIT.RED}）：${found.why}`);
        for (const line of found.lines) log(`     ${line}`);
        log(`${head} → 停在这一步，后面的前置不跑`);
        steps.push({ id: step.id, verdict: VERDICT.FAIL, exitCode: EXIT.RED, why: found.why });
        return { verdict: VERDICT.FAIL, steps, failedAt: n, failedId: step.id };
      }
      if (found.verdict === VERDICT.NOT_JUDGED) {
        log(`${head} → **未判定**（${found.why}）`);
        for (const line of found.lines) log(`     ${line}`);
        steps.push({ id: step.id, verdict: VERDICT.NOT_JUDGED, why: found.why });
        continue;
      }
      log(`${head} → 绿（${found.why}）`);
      steps.push({ id: step.id, verdict: VERDICT.PASS, why: found.why });
      continue;
    }
    if (step.gate === "ERIX_E2E_REAL" && !env.ERIX_E2E_REAL) {
      const why = "ERIX_E2E_REAL 未开：真上游那一族在闸门关着时一步都不跑";
      log(`${head} → **未判定**（${why}）`);
      log("     要人开闸才有判定：`ERIX_E2E_REAL=1 npm run check:release:real`（它自己会点名红在第几步）");
      steps.push({ id: step.id, verdict: VERDICT.NOT_JUDGED, why });
      continue;
    }
    if (step.gate === "hosts") {
      const usable = hosts.filter((dir) => {
        try { return statSync(dir).isDirectory(); } catch { return false; }
      });
      const missing = hosts.filter((dir) => !usable.includes(dir));
      if (!hosts.length) {
        const why = "没给 --hosts：探针不给目录时只打印口径并 exit 0，那是「未判定」不是绿";
        log(`${head} → **未判定**（${why}）`);
        log("     宿主侧那一半：`npm run check:host-consumers -- --hosts <宿主仓目录> …`");
        steps.push({ id: step.id, verdict: VERDICT.NOT_JUDGED, why });
        continue;
      }
      if (!usable.length) {
        const why = `--hosts 给的目录都不存在 / 不是目录（${missing.join(", ")}）——探针口径 HOST_DIR_MISSING / HOST_DIR_NOT_DIR，未判定不是绿`;
        log(`${head} → **未判定**（${why}）`);
        steps.push({ id: step.id, verdict: VERDICT.NOT_JUDGED, why });
        continue;
      }
      if (missing.length) log(`     ⚠ ${missing.join(", ")} 不存在 / 不是目录（探针按 HOST_DIR_MISSING 分类，只判剩下的）`);
      argv = [...step.argv, "--", ...usable.flatMap((dir) => ["--hosts", dir])];
    }
    log(`${head} → 跑：${cmdline(argv, step.env ?? {})}`);
    const result = run(argv, { cwd: root, env: stepEnv });
    if (result.status !== 0) {
      log(`${head} → **红**（exit ${result.status}）——停在这一步，后面的前置不跑`);
      steps.push({ id: step.id, verdict: VERDICT.FAIL, exitCode: result.status });
      return { verdict: VERDICT.FAIL, steps, failedAt: n, failedId: step.id };
    }
    log(`${head} → 绿`);
    steps.push({ id: step.id, verdict: VERDICT.PASS });
  }
  const unjudged = steps.filter((s) => s.verdict === VERDICT.NOT_JUDGED);
  if (unjudged.length) {
    log(`preflight → **未判定**（${unjudged.length} 步没跑：${unjudged.map((s) => s.id).join(", ")}）——`
      + "发布前置没有全绿，这不是通过（未判定不是绿）");
    return { verdict: VERDICT.NOT_JUDGED, steps };
  }
  log(`preflight → 全绿（${steps.length} 步）`);
  return { verdict: VERDICT.PASS, steps };
}

/**
 * 某一步判「未判定」时**人该做的那一件事**（`--all` 的结语与 preflight 的收尾读它，issue #731 N1）。
 *
 * 为什么必须逐步登记而不是一句话写死：未判定有**两种**，动作互为反面——
 *   · `open-gate`：闸门关着 ⇒ 那一步**一步都没跑**，人开个开关（环境变量 / `--hosts`）就有判定；
 *   · `cut-version`：这一格读的是树上的**事实**（`package.json` + `CHANGELOG.md`），**没有任何开关能造出判定**，
 *     缺的那件事只有人做得到：**切版**。第 2 步（`changelog-unreleased`，issue #715）就是这一类。
 * 把两类压成一句「把闸开起来再发（`ERIX_E2E_REAL=1` / `--hosts …`）」就是 N1 记的那笔谎：
 * 第 2 步未判定时照着做的人会原地打转（没有这样一个闸可开）。逐格那两行动作本来就打出来了，
 * 所以这是「结语与实况不符」，不是「人无从得知」——修它就要修结语本身。
 *
 * 新加一步**必须**在这里登记，否则 `--self-test` 里那条覆盖钉子当场红（不许出现「未判定但没动作」的步骤）。
 */
export const UNJUDGED_ACTIONS = Object.freeze({
  "changelog-unreleased": {
    kind: "cut-version",
    action: "**先切版**（bump `package.json` 到要发的那一版 + 开 `## [<版本>]（未发布 / unpublished）`，"
      + "把标题行插到条目之前），再重跑本命令——这一格**没有闸可开**",
  },
  "release-real": { kind: "open-gate", action: "把闸开起来再发（`ERIX_E2E_REAL=1 npm run check:release:real`）" },
  "host-consumers": { kind: "open-gate", action: "把宿主仓目录带上再发（`--hosts <宿主仓目录> …`）" },
});

/**
 * preflight 未判定时 `--all` 的结语（**按未判定的步骤 id 分叉**；issue #731 N1）。
 *
 * 头一句只说「这一趟缺的是哪一种动作」：只要含 `cut-version` 那一类，头一句就是**先切版**，
 * 绝不出现「把闸开起来再发」——因为那一类没有闸可开；全是 `open-gate` 时才说开闸。
 *
 * @param {Array<{id: string, verdict?: string}>} steps `runPreflight` 返回的 steps（含未判定的那些）
 * @returns {{head: string, lines: string[]}} 一行头 + 逐格动作（缺登记的动作时那一行自己承认没登记）
 */
export function unjudgedConclusion(steps = []) {
  const unjudged = steps.filter((step) => step.verdict === VERDICT.NOT_JUDGED);
  const ids = unjudged.map((step) => step.id);
  const entries = unjudged.map((step) => ({ id: step.id, ...UNJUDGED_ACTIONS[step.id] }));
  const needsVersionCut = entries.some((entry) => entry.kind === "cut-version");
  const needsGate = entries.some((entry) => entry.kind === "open-gate");
  const head = `--all → preflight **未判定**（不是绿；没跑的格子：${ids.join(", ") || "（空）"}）——`
    + (needsVersionCut && needsGate ? "先补事实（切版）**并把**闸开起来，两件事都做完再发"
      : needsVersionCut ? "这一类**没有闸可开**：先把版切了再发"
        : needsGate ? "把闸开起来再发"
          // 未判定却一个格子都没列出来 ⇒ 结构变了，宁可说不清，也不许回到那句会被误读成「开闸就行」的旧文案
          : "缺的那一步没有登记动作（见下面逐格）");
  const lines = entries.map((entry) => `     · ${entry.id}：${entry.action
    ?? "（UNJUDGED_ACTIONS 里没有这一格 ⇒ 结语给不出动作，请补登记，别照旧文案猜）"}`);
  return { head, lines };
}

// ─────────────────────────────── publish ───────────────────────────────

/**
 * publish 阶段：**默认只打印操作单**（脚本不 fork `npm publish`，理由见文件头）。
 * `--publish-cmd` 是显式开关（默认关）；`--dry` 下即使给了也不跑。
 *
 * @param {{root?: string, version: string, deps?: ReturnType<typeof defaultDeps>,
 *          publishCmd?: string|null, dry?: boolean}} options
 * @returns {number} EXIT.AWAITING_PUBLISH（等你发布）/ EXIT.OK（`--publish-cmd` 跑绿）/ EXIT.RED
 */
export function runPublish({ root = DEFAULT_ROOT, version, deps = defaultDeps(), publishCmd = null, dry = false } = {}) {
  const { run, log, env } = deps;
  log("");
  log(`publish —— 版本 ${version}。脚本**不自己 publish**：那一步必须你在自己的终端里做（device-flow 扫码）。`);
  for (const [i, note] of PUBLISH_NOTES.entries()) log(`  ${i + 1}. ${note}`);
  log("");
  log("  请在你的终端里跑（绝对路径，不要用 PATH 里的 10.x）：");
  log(`    cd ${root} && ~/.npm-global/bin/npm publish`);
  log("  （预发布版本要显式 `--tag`：`npm publish --tag latest`；否则 npm12 报 `You must specify a tag …`）");
  log("");
  log("  发完之后**先回写再打 tag**，用这一条续跑（它不会重复发布）：");
  log(`    npm run release:day -- --stage writeback --version ${version} --published ${version}`);
  if (publishCmd && !dry) {
    log("");
    log(`--publish-cmd 显式开关已开：跑 \`${publishCmd}\``);
    const result = run(["bash", "-lc", publishCmd], { cwd: root, env });
    if (result.status !== 0) {
      log(`publish → 红（\`--publish-cmd\` exit ${result.status}）——发布没成功，别往下走`);
      return EXIT.RED;
    }
    log("publish → 绿（`--publish-cmd`）");
    return EXIT.OK;
  }
  if (publishCmd && dry) log("--dry：`--publish-cmd` 给了也不跑（什么都不发）");
  log("publish → **等你发布**（exit 3：发完用 `--stage writeback` 续跑）");
  return EXIT.AWAITING_PUBLISH;
}

// ─────────────────────────────── writeback ───────────────────────────────

/**
 * 回写阶段（本单的核心纪律）：**发布成功之后必须先回写发布态、再打 tag**。
 * ① `docs-drift-check --sync`（只改发布态那几句）→ ② 提交 → ③ 立刻重跑 `check:docs` 证明回写自洽。
 * 一进门先把 `phase=published_unwritten` 落盘：回写失败时这一笔就是 `--all` 的续跑坐标。
 *
 * @param {{root?: string, version?: string, published?: string|null, publishedDate?: string|null,
 *          deps?: ReturnType<typeof defaultDeps>,
 *          stateFile?: string, dry?: boolean, commit?: boolean}} [options]
 * @returns {number} EXIT.OK / EXIT.RED / EXIT.NOT_JUDGED
 */
export function runWriteback({
  root = DEFAULT_ROOT,
  version = null,
  published = null,
  publishedDate = null,
  deps = defaultDeps(),
  stateFile = stateFilePath({ env: deps.env }),
  dry = false,
  commit = true,
} = {}) {
  const { run, capture, log, env } = deps;
  const currentVersion = version ?? pkgVersion(root);
  if (!published) {
    log("writeback: 缺 `--published <x.y.z>`——「已发布与否」没有真值（CI 上没有 registry，离线自测不许联网）；"
      + "回写哪一边都是猜，所以这一步不做。发布成功之后请给 `--published <版本>`。");
    return EXIT.NOT_JUDGED;
  }
  if (published !== currentVersion) {
    log(`writeback: \`--published ${published}\` 与本仓版本 ${currentVersion} 不一致——发版日回写是「刚发布的这一版」，`
      + "两者必须相等（发布行滞后于本仓版本的中间态由 `--sync` 自己判，不在这里猜）");
    return EXIT.RED;
  }

  // 回写前工作树必须干净：`git commit -a` 只该提交回写自己动过的已跟踪文件。脏树上跑会把别人的改动一起
  // 提交进「发布态回写」那个提交里——那正是「这一步到底改了什么」说不清的起点。
  if (!dry) {
    const pre = capture(["git", "status", "--porcelain"], { cwd: root, env });
    if (pre.status !== 0) {
      log(`writeback: 读不出 \`git status --porcelain\`（exit ${pre.status}）——不知道工作树干净不干净就不回写`);
      return EXIT.RED;
    }
    if (pre.stdout.trim()) {
      log("writeback → **红**：回写前工作树必须干净（回写只提交它自己改的那几份文档）——当前有未提交的改动：");
      for (const line of pre.stdout.trim().split("\n").slice(0, 10)) log(`      ${line}`);
      log("      先提交 / 收好它们，再跑 `--stage writeback`（`--no-commit` 可以让回写只写盘不提交）。");
      return EXIT.RED;
    }
  }

  const previous = readState(stateFile) ?? {};
  const base = {
    schema: 1,
    version: currentVersion,
    published,
    updatedAt: nowIso(deps),
    preflight: previous.version === currentVersion ? previous.preflight ?? null : null,
  };
  if (!dry) {
    writeState(stateFile, { ...base, phase: PHASE.PUBLISHED_UNWRITTEN, writeback: { ok: false, why: "进行中" } });
    log(`状态：已发布 ${published}、**未回写** → 记进 ${stateFile}`);
    log("      （回写失败也不会丢；`--all` 重跑会从这个相位续跑，不会重复发布）");
  }

  const syncArgv = ["node", DOCS_SYNC_SCRIPT, "--sync", "--published", published, "--version", currentVersion];
  // issue #697：段首日期与「未发布」标记是同一步写的两半。发版当天不传 `--published-date` ⇒ 回写自己取
  // 当天 UTC+8（真值只有一个来源：`docs-drift-check --sync` 的缺省值）；跨零点的发版作业 / 补写才显式给。
  if (publishedDate) syncArgv.push("--published-date", publishedDate);
  log(`writeback ① 回写发布态：${syncArgv.join(" ")}`);
  if (dry) {
    log("writeback（--dry）：不跑回写、不提交、不重跑 check:docs——一个字节都不写");
    return EXIT.OK;
  }
  const sync = run(syncArgv, { cwd: root, env });
  if (sync.status !== 0) {
    log(`writeback ① → **红**（exit ${sync.status}）——发布态没回写成功`);
    writeState(stateFile, { ...base, phase: PHASE.PUBLISHED_UNWRITTEN, writeback: { ok: false, why: `--sync exit ${sync.status}` } });
    log(`      状态留在盘上（${stateFile}）：**已发布、未回写**。修好后重跑 \`npm run release:day -- --all\` 会从这里续。`);
    return EXIT.RED;
  }

  // ② 提交回写（只提交已跟踪文件的改动：回写只改既有文档，不新建文件）
  const status = capture(["git", "status", "--porcelain"], { cwd: root, env });
  if (status.status !== 0) {
    log(`writeback ② → 红：读不出 \`git status --porcelain\`（exit ${status.status}）——不知道要提交什么就不提交`);
    return EXIT.RED;
  }
  const dirty = status.stdout.trim();
  let committed = false;
  if (!dirty) {
    log("writeback ② 回写后工作树没有改动（文档本来就是发布态）——跳过提交");
  } else if (!commit) {
    log("writeback ② `--no-commit`：改动留在工作树里，请自己提交后再 `--stage finalize`");
  } else {
    log(`writeback ② 提交回写：\`git commit -a -m "docs: release-day writeback — v${currentVersion} 发布态回写"\``);
    const commitResult = run(
      ["git", "commit", "-a", "-m", `docs(#689): release-day writeback — v${currentVersion} 发布态回写`],
      { cwd: root, env },
    );
    if (commitResult.status !== 0) {
      log(`writeback ② → **红**（exit ${commitResult.status}）——回写没提交成功`);
      writeState(stateFile, { ...base, phase: PHASE.PUBLISHED_UNWRITTEN, writeback: { ok: false, why: `commit exit ${commitResult.status}` } });
      return EXIT.RED;
    }
    committed = true;
  }

  // ③ 回写之后**立刻**重跑 check:docs 证明回写自洽。
  //    issue #697：回写发生在**打 tag 之前**，所以此刻 `check:docs` 会把「registry 说已发布、tag 还没打」
  //    判成 **exit 2 未判定（TAG_MISSING）**——那不是红（若判红，writeback 会被自己刚做的那件事判死）。
  //    所以这里分三种结果：exit 0 = 自洽；exit 2 且**每一处未判定都是 TAG_MISSING** = 未判定（tag 打完
  //    finalize 会再对一次）；其余（含 exit 2 但带别的读不出、以及 exit 1）= 红。
  log("writeback ③ 回写自洽证明：`npm run check:docs`");
  const docs = capture(["npm", "run", "check:docs"], { cwd: root, env });
  if (docs.status === 2) {
    const codes = [...String(docs.stdout ?? "").matchAll(/^docs-drift-check: 未判定 (\S+) — /gmu)].map((m) => m[1]);
    const onlyTagMissing = codes.length > 0 && codes.every((code) => code === "TAG_MISSING");
    if (!onlyTagMissing) {
      log(`writeback ③ → **红**（exit 2，但未判定的原因不止 TAG_MISSING：${codes.join(", ") || "一处未判定标记都没读到"}）`
        + "——「读不出真值」里只有「tag 还没打」这一种能在 writeback 阶段放过");
      writeState(stateFile, { ...base, phase: PHASE.PUBLISHED_UNWRITTEN, writeback: { ok: false, why: `check:docs exit 2 (${codes.join(",") || "unreadable"})` } });
      return EXIT.RED;
    }
    log(`writeback ③ → **未判定**（exit 2 / ${codes.join(", ")}）：回写已写入，但「段首日期 ↔ tag 日期」这一半`
      + "现在没有真值——tag 是 finalize 才打的，打完再跑 `check:docs` 会自己对；其余门禁全绿");
  } else if (docs.status !== 0) {
    log(`writeback ③ → **红**（exit ${docs.status}）——回写写进去了，但 check:docs 不绿（见上）`);
    writeState(stateFile, { ...base, phase: PHASE.PUBLISHED_UNWRITTEN, writeback: { ok: false, why: `check:docs exit ${docs.status}` } });
    log("      状态仍是「已发布、未回写」：**不许**往下打 tag（tag 出去了而文档没自洽就是 0.30.0 那一幕）");
    return EXIT.RED;
  }
  writeState(stateFile, { ...base, phase: PHASE.WRITTEN, writeback: { ok: true, why: null } });
  log(`writeback → 绿：发布态已回写、${committed ? "已提交" : "无需提交"}、check:docs 自洽`
    + `（状态 ${stateFile}：phase=${PHASE.WRITTEN}）`);
  return EXIT.OK;
}

// ─────────────────────────────── finalize ───────────────────────────────

/**
 * 收尾：清生成声明 → 打附注 tag（指向**切版提交**）→ 双推 → 两侧 `git ls-remote` 现验 → 再跑文档门禁。
 *
 * @param {{root?: string, version?: string, deps?: ReturnType<typeof defaultDeps>, stateFile?: string,
 *          dry?: boolean, tagTarget?: string|null}} [options]
 * @returns {number} EXIT.OK / EXIT.RED / EXIT.NOT_JUDGED
 */
export function runFinalize({
  root = DEFAULT_ROOT,
  version = null,
  deps = defaultDeps(),
  stateFile = stateFilePath({ env: deps.env }),
  dry = false,
  tagTarget = null,
} = {}) {
  const { run, capture, log, env } = deps;
  const currentVersion = version ?? pkgVersion(root);
  const state = readState(stateFile);

  // ── 顺序闸：没有「已发布 + 已回写」的事实就不许打 tag ──
  if (!state || state.version !== currentVersion || state.phase !== PHASE.WRITTEN) {
    log("finalize → **红**（顺序闸）：要求状态文件里 `phase=written`（= 已发布 + 已回写 + check:docs 绿），实测 "
      + `${state ? `version=${state.version ?? "—"} / phase=${state.phase ?? "—"}` : `没有状态文件（${stateFile}）`}`);
    log("      tag 打出去了而文档还写着未发布，正是 0.30.0 那一幕：先 `--stage writeback --version <v> --published <v>`。");
    return EXIT.RED;
  }

  const branch = capture(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, env });
  if (branch.status !== 0 || branch.stdout.trim() !== "main") {
    log(`finalize → **红**：发版在 \`main\` 上做（当前分支 \`${branch.stdout.trim() || "?"}\`）——`
      + "双推推的是 `origin main`，在别的分支上打 tag 会推错东西");
    return EXIT.RED;
  }
  const clean = capture(["git", "status", "--porcelain"], { cwd: root, env });
  if (clean.status !== 0) {
    log(`finalize → 红：读不出 \`git status --porcelain\`（exit ${clean.status}）`);
    return EXIT.RED;
  }
  if (clean.stdout.trim()) {
    log("finalize → **红**：工作树不干净（回写还没提交？）——先把回写提交掉，tag 才不会指向一棵没写进历史的树：");
    for (const line of clean.stdout.trim().split("\n").slice(0, 10)) log(`      ${line}`);
    return EXIT.RED;
  }

  // ── ① 清 `src/**/*.d.ts`（生成物；残留会让 check:types 假绿） ──
  const declarations = generatedDeclarations(root);
  if (dry) {
    log(`finalize ① （--dry）会清掉 ${declarations.length} 个 src/**/*.d.ts`);
  } else {
    for (const file of declarations) unlinkSync(file);
    log(`finalize ① 清掉 ${declarations.length} 个 src/**/*.d.ts`);
  }

  // ── ② tag 目标 = 切版提交（`package.json` version 行最后一次被改动的提交；不指向回写提交） ──
  const tag = `v${currentVersion}`;
  let target = tagTarget;
  if (!target) {
    const pkgText = readFileSync(path.join(root, "package.json"), "utf8");
    const versionLine = pkgText.split("\n").findIndex((line) => /^\s*"version"\s*:/.test(line)) + 1;
    if (versionLine < 1) {
      log("finalize ② → 红：`package.json` 里找不到 `\"version\":` 那一行，tag 目标无从确定");
      return EXIT.RED;
    }
    const blame = capture(["git", "blame", "--porcelain", "-L", `${versionLine},${versionLine}`, "--", "package.json"], { cwd: root, env });
    if (blame.status !== 0) {
      log(`finalize ② → 红：\`git blame\` 读不出（exit ${blame.status}）`);
      return EXIT.RED;
    }
    target = blame.stdout.split("\n")[0].split(" ")[0];
    log(`finalize ② tag 目标 = ${target}（\`package.json\` version 行最后一次被改动的提交 = **切版提交**，\`git blame\` 现读）`);
    log("     不指向回写提交：发布出去的那棵树是切版提交，回写只改文档（先例 `v0.30.0`）");
  } else {
    log(`finalize ② tag 目标 = ${target}（\`--tag-target\` 显式给的；下面三条判据照样核）`);
  }
  {
    const atTarget = capture(["git", "show", `${target}:package.json`], { cwd: root, env });
    if (atTarget.status !== 0) {
      log(`finalize ② → 红：\`git show ${target}:package.json\` 读不出（exit ${atTarget.status}）`);
      return EXIT.RED;
    }
    let targetVersion = null;
    try { targetVersion = JSON.parse(atTarget.stdout).version; } catch { targetVersion = null; }
    if (targetVersion !== currentVersion) {
      log(`finalize ② → 红：${target} 那棵树的 package.json 版本是 ${targetVersion ?? "（读不出）"}，不是 ${currentVersion}`);
      return EXIT.RED;
    }
    const ancestor = capture(["git", "merge-base", "--is-ancestor", target, "HEAD"], { cwd: root, env });
    if (ancestor.status !== 0) {
      log(`finalize ② → 红：${target} 不是 HEAD 的祖先——tag 不许指向一棵不在 main 历史上的树`);
      return EXIT.RED;
    }
    // 「产出这次发布的那棵树」的机器判据：运行时面（src / bin / package.json / skills）与 HEAD 逐字相同。
    // 回写只动文档，所以文档面的差异是**预期的**；运行时面有差异说明 tag 指错了树。
    // 先例 `v0.30.0` 的 tag 指向发布分支的合并提交（1e3a277 → 2fe4424），两者在 src/bin/package.json 上逐字相同。
    const surface = capture(["git", "diff", "--quiet", target, "HEAD", "--", "src", "bin", "package.json", "skills"], { cwd: root, env });
    if (surface.status !== 0) {
      log(`finalize ② → 红：${target} 与 HEAD 的运行时面（src / bin / package.json / skills）不一致——`
        + "那不是产出这次发布的那棵树（回写只该动文档面）");
      return EXIT.RED;
    }
    log("     运行时面校验：tag 目标与 HEAD 在 src / bin / package.json / skills 上逐字相同（回写只动文档面）");
  }
  const headSha = capture(["git", "rev-parse", "HEAD"], { cwd: root, env }).stdout.trim();

  // ── ③ 打附注 tag（已存在且指向同一提交 ⇒ 幂等跳过；指向别处 ⇒ 红） ──
  if (dry) {
    log(`finalize ③ （--dry）会打附注 tag \`${tag}\` → ${target}`);
  } else {
    const existing = capture(["git", "rev-parse", "-q", "--verify", `refs/tags/${tag}`], { cwd: root, env });
    if (existing.status === 0) {
      const pointsAt = capture(["git", "rev-list", "-n", "1", tag], { cwd: root, env }).stdout.trim();
      if (pointsAt !== target) {
        log(`finalize ③ → 红：tag \`${tag}\` 已存在且指向 ${pointsAt}，不是切版提交 ${target}`);
        return EXIT.RED;
      }
      log(`finalize ③ tag \`${tag}\` 已存在且指向 ${target}——不重复打`);
    } else {
      const tagged = run(
        ["git", "tag", "-a", tag, "-m",
          `erix-agent ${currentVersion}：本 tag 指向产出 erix-agent@${currentVersion} tarball 的那棵树`
          + `（${target}，即 package.json version 行的切版提交；不指向回写提交——回写只动文档面）。`
          + "发布态回写在 tag 之前已完成，check:docs 自洽。", target],
        { cwd: root, env },
      );
      if (tagged.status !== 0) {
        log(`finalize ③ → 红：\`git tag\` exit ${tagged.status}`);
        return EXIT.RED;
      }
      log(`finalize ③ 附注 tag \`${tag}\` → ${target}`);
    }
  }

  // ── ④ 双推（`origin` = GitHub + Gitea；永不 --force：main 有分支保护） ──
  if (dry) {
    log(`finalize ④ （--dry）会推 \`origin main\` 与 \`origin ${tag}\`（不 force）`);
  } else {
    for (const ref of ["main", tag]) {
      log(`finalize ④ \`git push origin ${ref}\`（双推：GitHub + Gitea；不 force）`);
      const pushed = run(["git", "push", "origin", ref], { cwd: root, env });
      if (pushed.status !== 0) {
        log(`finalize ④ → **红**：\`git push origin ${ref}\` exit ${pushed.status}`
          + "（非快进就让 push 自己失败——main 有分支保护，脚本不许 force）");
        return EXIT.RED;
      }
    }
  }

  // ── ⑤ 两侧现验：两个远端 URL 各 `git ls-remote` 一次，不一致就红 ──
  const urls = remoteUrls(capture, { cwd: root, env });
  /** @type {Array<{url: string, main: string|null, tag: string|null}>} */
  const seen = [];
  if (dry) {
    log(`finalize ⑤ （--dry）会对 ${urls.length} 个远端 URL 各 \`git ls-remote\` 一次：${urls.join(" , ")}`);
  } else {
    if (urls.length < 2) {
      log(`finalize ⑤ → **未判定**：只有 ${urls.length} 个远端 URL（${urls.join(" , ") || "—"}）——`
        + "双推没法互验，未判定不是绿");
      return EXIT.NOT_JUDGED;
    }
    for (const url of urls) {
      const listed = capture(["git", "ls-remote", url, "refs/heads/main", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: root, env });
      if (listed.status !== 0) {
        log(`finalize ⑤ → **红**：\`git ls-remote ${url}\` exit ${listed.status}——这一侧没验成，不能当绿`);
        return EXIT.RED;
      }
      const refs = new Map();
      for (const line of listed.stdout.trim().split("\n").filter(Boolean)) {
        const [sha, ref] = line.split(/\s+/);
        refs.set(ref, sha);
      }
      seen.push({ url, main: refs.get("refs/heads/main") ?? null, tag: refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null });
    }
    const mismatched = [];
    for (const side of seen) {
      if (side.main !== headSha) mismatched.push(`${side.url} 的 refs/heads/main 是 ${side.main ?? "（没有）"}，本地 HEAD 是 ${headSha}`);
      if (side.tag !== target) mismatched.push(`${side.url} 的 refs/tags/${tag} 是 ${side.tag ?? "（没有）"}，tag 目标 ${target}`);
    }
    if (mismatched.length) {
      log(`finalize ⑤ → **红**：两侧现验不一致（${mismatched.length} 处）`);
      for (const line of mismatched) log(`      ✗ ${line}`);
      return EXIT.RED;
    }
    log(`finalize ⑤ 两侧现验一致（${seen.length} 个 URL）：main=${headSha} / ${tag}=${target}`);
    for (const side of seen) log(`      ✓ ${side.url}`);
  }

  // ── ⑥ 再跑一遍文档门禁（tag 之后，文档仍然自洽） ──
  if (dry) {
    log("finalize ⑥ （--dry）会再跑 `check:docs` / `check:docs:strict`");
    log("finalize（--dry）：什么都没写、什么都没发、什么都没推");
    return EXIT.OK;
  }
  for (const argv of [["npm", "run", "check:docs"], ["npm", "run", "check:docs:strict"]]) {
    log(`finalize ⑥ ${cmdline(argv)}`);
    const result = run(argv, { cwd: root, env });
    if (result.status !== 0) {
      log(`finalize ⑥ → **红**（exit ${result.status}）——tag 与双推已经完成，但文档门禁不绿；这是要人接手的状态`);
      return EXIT.RED;
    }
  }

  writeState(stateFile, {
    ...state,
    phase: PHASE.FINALIZED,
    updatedAt: nowIso(deps),
    finalize: { tag, tagTarget: target, head: headSha, remotes: seen.map((side) => side.url) },
  });
  log(`finalize → 绿：tag \`${tag}\` → ${target}，双推两侧一致，文档门禁再跑一遍仍绿`);
  return EXIT.OK;
}

/** 远端 URL 清单（fetch URL + 全部 push URL，去重）：双推的「两侧」就是它。 */
function remoteUrls(capture, opts) {
  const urls = new Set();
  const fetchUrl = capture(["git", "remote", "get-url", "origin"], opts);
  if (fetchUrl.status === 0 && fetchUrl.stdout.trim()) urls.add(fetchUrl.stdout.trim());
  const pushUrls = capture(["git", "remote", "get-url", "--push", "--all", "origin"], opts);
  if (pushUrls.status === 0) {
    for (const line of pushUrls.stdout.split("\n")) if (line.trim()) urls.add(line.trim());
  }
  return [...urls];
}

// ─────────────────────────────── 编排 ───────────────────────────────

/**
 * `--all`：按 `STAGES` 的顺序走。**先看状态文件**：
 *   · `written`             ⇒ 从 finalize 续（回写已完成，别重复回写）；
 *   · `published_unwritten` ⇒ 从 writeback 续（**不重复发布**，也不再打 publish 操作单）；
 *   · 其它                  ⇒ preflight → publish（人工停点）。
 *
 * @param {{root?: string, hosts?: string[], version?: string|null, published?: string|null,
 *          publishedDate?: string|null,
 *          deps?: ReturnType<typeof defaultDeps>, stateFile?: string, dry?: boolean,
 *          publishCmd?: string|null, commit?: boolean}} [options]
 * @returns {number} 退出码
 */
export function runAll({
  root = DEFAULT_ROOT,
  hosts = [],
  version = null,
  published = null,
  publishedDate = null,
  deps = defaultDeps(),
  stateFile = stateFilePath({ env: deps.env }),
  dry = false,
  publishCmd = null,
  commit = true,
} = {}) {
  const { log } = deps;
  const currentVersion = version ?? pkgVersion(root);
  const state = dry ? null : readState(stateFile);
  if (state && state.version === currentVersion && state.phase === PHASE.FINALIZED) {
    log(`--all：状态文件说 v${currentVersion} 已经 finalize 完（phase=finalized）——不重复打 tag、不重复推、不重复回写`);
    return EXIT.OK;
  }
  if (state && state.version === currentVersion && state.phase === PHASE.WRITTEN) {
    log(`--all：状态文件说 v${currentVersion} 已发布 + 已回写（phase=written）→ 从 **finalize** 续跑`);
    return runFinalize({ root, version: currentVersion, deps, stateFile, dry });
  }
  if (state && state.version === currentVersion && state.phase === PHASE.PUBLISHED_UNWRITTEN) {
    const resumedPublished = published ?? state.published ?? null;
    log(`--all：状态文件说 v${currentVersion} **已发布、未回写**（phase=published_unwritten）→ 从 **writeback** 续跑；`
      + "不重复发布（脚本从不自己发布）");
    const writebackStatus = runWriteback({ root, version: currentVersion, published: resumedPublished, publishedDate, deps, stateFile, dry, commit });
    if (writebackStatus !== EXIT.OK) return writebackStatus;
    return runFinalize({ root, version: currentVersion, deps, stateFile, dry });
  }

  // ── preflight ──
  const preflight = runPreflight({ root, hosts, deps, dry });
  if (!dry) {
    writeState(stateFile, {
      schema: 1,
      version: currentVersion,
      published: null,
      updatedAt: nowIso(deps),
      phase: preflight.verdict === VERDICT.PASS ? PHASE.PREFLIGHT_OK : PHASE.PREFLIGHT_NOT_JUDGED,
      preflight,
    });
  }
  if (preflight.verdict === VERDICT.FAIL) {
    log(`--all → 停在 preflight 第 ${preflight.failedAt} 步（${preflight.failedId}）：红的前置不往下走`);
    return EXIT.RED;
  }
  if (preflight.verdict === VERDICT.NOT_JUDGED) {
    // 结语按**未判定的步骤 id** 分叉（issue #731 N1）：第 2 步（`changelog-unreleased`）判未判定时
    // 没有任何闸可开——必须切版。硬写「把闸开起来再发」在那一格上是空话。
    const conclusion = unjudgedConclusion(preflight.steps);
    log(conclusion.head);
    for (const line of conclusion.lines) log(line);
    return EXIT.NOT_JUDGED;
  }

  // ── publish：人发布（脚本只打操作单）；`--published` 已给 ⇒ 人已经发布过了 ──
  if (published) {
    log(`--all：preflight 全绿，且 \`--published ${published}\` 已给（= 人已经发布过）→ 跳过 publish 操作单，直接 writeback`);
  } else {
    const publishStatus = runPublish({ root, version: currentVersion, deps, publishCmd, dry });
    return publishStatus === EXIT.OK ? EXIT.OK : publishStatus;
  }
  const writebackStatus = runWriteback({ root, version: currentVersion, published, publishedDate, deps, stateFile, dry, commit });
  if (writebackStatus !== EXIT.OK) return writebackStatus;
  return runFinalize({ root, version: currentVersion, deps, stateFile, dry });
}

// ─────────────────────────────── CLI ───────────────────────────────

function parseArgs(argv) {
  const opts = {
    stage: null, all: false, dry: false, selfTest: false, help: false, error: null,
    version: null, published: null, publishedDate: null, hosts: [], publishCmd: null, state: null, root: null,
    tagTarget: null, commit: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[i + 1] ?? null;
    if (arg === "--stage") { opts.stage = next(); i += 1; }
    else if (arg.startsWith("--stage=")) opts.stage = arg.slice("--stage=".length);
    else if (arg === "--all") opts.all = true;
    else if (arg === "--dry") opts.dry = true;
    else if (arg === "--self-test") opts.selfTest = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--version") { opts.version = next(); i += 1; }
    else if (arg.startsWith("--version=")) opts.version = arg.slice("--version=".length);
    else if (arg === "--published") { opts.published = next(); i += 1; }
    else if (arg.startsWith("--published=")) opts.published = arg.slice("--published=".length);
    else if (arg === "--published-date") { opts.publishedDate = next(); i += 1; }
    else if (arg.startsWith("--published-date=")) opts.publishedDate = arg.slice("--published-date=".length);
    else if (arg === "--hosts") {
      for (const part of String(next() ?? "").split(",")) if (part.trim()) opts.hosts.push(part.trim());
      i += 1;
    } else if (arg.startsWith("--hosts=")) {
      for (const part of arg.slice("--hosts=".length).split(",")) if (part.trim()) opts.hosts.push(part.trim());
    } else if (arg === "--publish-cmd") { opts.publishCmd = next(); i += 1; }
    else if (arg.startsWith("--publish-cmd=")) opts.publishCmd = arg.slice("--publish-cmd=".length);
    else if (arg === "--state") { opts.state = next(); i += 1; }
    else if (arg.startsWith("--state=")) opts.state = arg.slice("--state=".length);
    else if (arg === "--root") { opts.root = next(); i += 1; }
    else if (arg.startsWith("--root=")) opts.root = arg.slice("--root=".length);
    else if (arg === "--tag-target") { opts.tagTarget = next(); i += 1; }
    else if (arg.startsWith("--tag-target=")) opts.tagTarget = arg.slice("--tag-target=".length);
    else if (arg === "--no-commit") opts.commit = false;
    else if (!opts.error) opts.error = `不认识的参数 ${JSON.stringify(arg)}`;
  }
  if (opts.stage && !STAGES.includes(opts.stage)) opts.error = `\`--stage ${opts.stage}\` 不认识（合法：${STAGES.join(" / ")}）`;
  if (!opts.stage && !opts.all && !opts.selfTest && !opts.help && !opts.error) {
    opts.error = "要么 `--stage <preflight|publish|writeback|finalize>`，要么 `--all`，要么 `--self-test`";
  }
  return opts;
}

export function main(argv = process.argv.slice(2), injected = null) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`release-day: ${opts.error}`);
    console.error("用法：node scripts/release-day.mjs --stage <preflight|publish|writeback|finalize> | --all | --self-test [--dry] [--hosts <dir> …]");
    return EXIT.NOT_JUDGED;
  }
  if (opts.help) {
    console.log("用法：");
    console.log("  node scripts/release-day.mjs --stage preflight [--hosts <宿主仓目录> …]");
    console.log("  node scripts/release-day.mjs --stage publish [--publish-cmd <cmd>]");
    console.log("  node scripts/release-day.mjs --stage writeback --version <x.y.z> --published <x.y.z> [--published-date <YYYY-MM-DD>] [--no-commit]");
    console.log("  node scripts/release-day.mjs --stage finalize [--version <x.y.z>]");
    console.log("  node scripts/release-day.mjs --all [--dry] [--hosts …]");
    console.log("  node scripts/release-day.mjs --self-test");
    console.log("退出码：0 完成 / 1 红 / 2 未判定或参数不足 / 3 preflight 全绿、等你发布");
    return EXIT.OK;
  }
  if (opts.selfTest) return runSelfTest();

  const deps = injected ?? defaultDeps();
  const root = opts.root ? path.resolve(opts.root) : DEFAULT_ROOT;
  const stateFile = stateFilePath({ stateFile: opts.state, env: deps.env });
  const shared = {
    root,
    deps,
    stateFile,
    dry: opts.dry,
    version: opts.version,
    published: opts.published,
    publishedDate: opts.publishedDate,
    hosts: opts.hosts,
    publishCmd: opts.publishCmd,
    tagTarget: opts.tagTarget,
    commit: opts.commit,
  };
  if (opts.all) return runAll(shared);
  if (opts.stage === "preflight") {
    const preflight = runPreflight({ root, hosts: opts.hosts, deps, dry: opts.dry });
    const version = opts.version ?? pkgVersion(root);
    if (!opts.dry) {
      writeState(stateFile, {
        schema: 1,
        version,
        published: null,
        updatedAt: nowIso(deps),
        phase: preflight.verdict === VERDICT.PASS ? PHASE.PREFLIGHT_OK : PHASE.PREFLIGHT_NOT_JUDGED,
        preflight,
      });
      deps.log(`状态：phase=${preflight.verdict === VERDICT.PASS ? PHASE.PREFLIGHT_OK : PHASE.PREFLIGHT_NOT_JUDGED} → ${stateFile}`);
    }
    if (preflight.verdict === VERDICT.PASS) return EXIT.OK;
    return preflight.verdict === VERDICT.FAIL ? EXIT.RED : EXIT.NOT_JUDGED;
  }
  if (opts.stage === "publish") {
    const state = opts.dry ? null : readState(stateFile);
    const version = opts.version ?? pkgVersion(root);
    if (!opts.dry && (!state || state.version !== version || state.phase !== PHASE.PREFLIGHT_OK)) {
      deps.log(`publish → **红**（顺序闸）：要求状态文件里 phase=${PHASE.PREFLIGHT_OK}，实测 `
        + `${state ? `version=${state.version ?? "—"} / phase=${state.phase ?? "—"}` : `没有状态文件（${stateFile}）`}`
        + "——先跑 `--stage preflight`");
      return EXIT.RED;
    }
    return runPublish({ root, version, deps, publishCmd: opts.publishCmd, dry: opts.dry });
  }
  if (opts.stage === "writeback") return runWriteback(shared);
  return runFinalize(shared);
}

// ─────────────────────────────── 自测 ───────────────────────────────

/** 断言：落不上就记一条失败（变异没落上 = 失败，不是跳过；#210 R2 惯例）。 */
function makeChecker() {
  const passed = [];
  const failures = [];
  return {
    passed,
    failures,
    expect(ok, good, bad) { (ok ? passed : failures).push(ok ? good : bad); },
  };
}

/** 合成树：只放 `--sync` 会读 / 会写的那几份（离线、不联网、不碰真实 `~/.erix` 与 `~/.npmrc`）。 */
const SYNC_FIXTURE = Object.freeze({
  "package.json": '{\n  "name": "erix-agent",\n  "version": "0.30.0"\n}\n',
  "README.md": "# fixture\n\nline below against it. Current release: **v0.30.0** (2026-11-03). The complete list follows.\n",
  "README_cn.md": "# 夹具\n\n当前发布版本：**v0.30.0**（2026-11-03；**0.27.0 从未发布**）。下面引用的 `files` 清单以 `package.json` 为权威：\n",
  "AGENTS.md": "- Current version: `package.json` says `0.30.0` (the repo version) and the published line — npm's `dist-tags.latest` — is `0.30.0`; `check:docs` reconciles both live. `0.24.0` was **never published** to the registry.\n",
  "AGENTS_cn.md": "- 当前版本：`package.json` 写 `0.30.0`（本仓版本），发布行——npm 的 `dist-tags.latest`——是 `0.30.0`。`0.24.0` **从未发布**到 registry。\n",
  "docs/requirements.md": "This document was reconciled with the implementation shipped in version 0.30.0. It exists in package version 0.30.0.\n\n| **v0.9.0–v0.30.0 — current** | scope | status |\n",
  "docs/requirements_cn.md": "本文档现已与 0.30.0 版本交付的实现完成对照；下面将分期计划与 package 版本 0.30.0 对齐。\n\n| **v0.9.0–v0.30.0 — 当前** | 范围 | 状态 |\n",
  "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n## [0.31.0]（未发布 / unpublished）\n\n### Breaking\n\n- something\n\n## [0.30.0] - 2026-11-03\n\n- older\n",
});

function writeFixtureTree(root, files = SYNC_FIXTURE) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirp(path.dirname(abs));
    writeFileSync(abs, text, "utf8");
  }
}

function mkdirp(dir) {
  mkdirSync(dir, { recursive: true });
}

/** 目录快照（相对路径 → 字节内容）：`--dry` 的「一个字节都不写」靠它前后对比。 */
function snapshotTree(root) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const rel of readdirSync(root, { recursive: true })) {
    const abs = path.join(root, String(rel));
    if (!statSync(abs).isFile()) continue;
    out.set(String(rel), readFileSync(abs, "utf8"));
  }
  return out;
}

function diffSnapshot(before, after) {
  const changes = [];
  for (const [rel, text] of after) {
    if (!before.has(rel)) changes.push(`+${rel}`);
    else if (before.get(rel) !== text) changes.push(`~${rel}`);
  }
  for (const rel of before.keys()) if (!after.has(rel)) changes.push(`-${rel}`);
  return changes;
}

/**
 * 假 runner：按 argv 前缀回答。`calls` 记下每一次 argv（证「那一步没跑」用）。
 * 默认全部 exit 0；`override` 可以按 `argv.join(" ")` 精确改写某个命令的结果。
 */
function fakeDeps({ override = {}, env = { PATH: "/usr/bin", HOME: "/nonexistent-home", TMPDIR: "/tmp" }, capture = null } = {}) {
  const calls = [];
  const answer = (argv) => {
    const key = argv.join(" ");
    const hit = override[key];
    if (typeof hit === "function") return hit(argv);
    if (hit) return hit;
    return { status: 0, stdout: "", stderr: "" };
  };
  return {
    calls,
    log() {},
    env,
    run(argv) { calls.push(argv.join(" ")); return { status: answer(argv).status }; },
    capture(argv) {
      calls.push(argv.join(" "));
      if (capture) {
        const custom = capture(argv);
        if (custom) return { status: 0, stdout: "", stderr: "", ...custom };
      }
      return { status: 0, stdout: "", stderr: "", ...answer(argv) };
    },
  };
}

/** finalize 的 git 管道假件（HEAD / 切版提交 / 双远端 / ls-remote 都能按参数改）。 */
function gitPlumbing({
  head = "head0000000000000000000000000000000000000",
  cut = "cut00000000000000000000000000000000000000",
  version = "0.31.0",
  status = "",
  branch = "main",
  urls = ["https://github.com/ErixWong/erix-agent.git", "https://git.erix.vip/eric/erix-llm-kit.git"],
  sides = null,
  tagExists = false,
  surfaceDiff = 0,
  targetVersion = null,
} = {}) {
  const sideMap = sides ?? Object.fromEntries(urls.map((url) => [url, { main: head, tag: cut }]));
  return (argv) => {
    const line = argv.join(" ");
    if (line === "git status --porcelain") return { stdout: status };
    if (line === "git rev-parse --abbrev-ref HEAD") return { stdout: `${branch}\n` };
    if (line.startsWith("git blame --porcelain -L ")) return { stdout: `${cut} 1 1 1\n\tauthor x\n` };
    if (line.startsWith("git show ") && line.endsWith(":package.json")) {
      return { stdout: `{\n  "version": "${targetVersion ?? version}"\n}\n` };
    }
    if (line.startsWith("git diff --quiet ")) return { status: surfaceDiff };
    if (line.startsWith("git merge-base --is-ancestor ")) return { status: 0 };
    if (line === "git rev-parse HEAD") return { stdout: `${head}\n` };
    if (line.startsWith("git rev-parse -q --verify refs/tags/")) return tagExists ? { stdout: "tagobject\n" } : { status: 1 };
    if (line.startsWith("git rev-list -n 1 ")) return { stdout: `${cut}\n` };
    if (line === "git remote get-url origin") return { stdout: `${urls[0]}\n` };
    if (line === "git remote get-url --push --all origin") return { stdout: `${urls.join("\n")}\n` };
    if (line.startsWith("git ls-remote ")) {
      const url = argv[2];
      const side = sideMap[url];
      if (!side) return { status: 128 };
      const tag = argv.find((a) => a.startsWith("refs/tags/") && a.endsWith("^{}")) ?? "refs/tags/v";
      const tagRef = tag.replace(/\^\{\}$/, "");
      return { stdout: `${side.main}\trefs/heads/main\n${side.tag}\t${tagRef}\n` };
    }
    return null;
  };
}

/** ⑦ `--sync` 的窄面：子进程跑真脚本，对合成树逐字节比对。 */
function selfTestSync(checker) {
  const { expect } = checker;
  const script = path.join(DEFAULT_ROOT, DOCS_SYNC_SCRIPT);
  const runSync = (tree, args) => spawnSync(process.execPath, [script, "--sync", "--root", tree, ...args], { encoding: "utf8" });

  // (a) 9.9.9：发布态句子全部改成 9.9.9，其余字节逐字不动
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-sync-a-"));
    try {
      writeFixtureTree(tree);
      const result = runSync(tree, ["--version", "9.9.9", "--published", "9.9.9"]);
      const expected = {
        ...SYNC_FIXTURE,
        "README.md": SYNC_FIXTURE["README.md"].replace("**v0.30.0**", "**v9.9.9**"),
        "README_cn.md": SYNC_FIXTURE["README_cn.md"].replace("**v0.30.0**", "**v9.9.9**"),
        "AGENTS.md": SYNC_FIXTURE["AGENTS.md"].split("0.30.0").join("9.9.9"),
        "AGENTS_cn.md": SYNC_FIXTURE["AGENTS_cn.md"].split("0.30.0").join("9.9.9"),
        "docs/requirements.md": SYNC_FIXTURE["docs/requirements.md"].split("0.30.0").join("9.9.9"),
        "docs/requirements_cn.md": SYNC_FIXTURE["docs/requirements_cn.md"].split("0.30.0").join("9.9.9"),
      };
      expect(result.status === 0, "⑦a `--sync --published 9.9.9 --version 9.9.9` exit 0",
        `⑦a \`--sync\` 没绿：exit ${result.status}\n${result.stdout}${result.stderr}`);
      const changed = diffSnapshot(new Map(Object.entries(SYNC_FIXTURE)), snapshotTree(tree));
      expect(changed.length === 6, `⑦a 只改了 6 个文件：${changed.join(", ")}`,
        `⑦a 改动面不是 6 个文件（多了或少了都算回写跑到窄面之外）：${changed.join(", ") || "（一个都没改）"}`);
      const mismatched = Object.keys(expected).filter((rel) => readFileSync(path.join(tree, rel), "utf8") !== expected[rel]);
      expect(mismatched.length === 0, "⑦a 每个文件逐字节等于「只换掉发布态那几处」的期望文本（其余字节一字未动）",
        `⑦a 这些文件与期望文本不一致（改到别的句子了）：${mismatched.join(", ")}`);
      const agents = readFileSync(path.join(tree, "AGENTS.md"), "utf8");
      expect(agents.includes("`0.24.0` was **never published**") && agents.includes("`dist-tags.latest` — is `9.9.9`"),
        "⑦a 历史句 `0.24.0 was never published` 逐字保留，发布行改成了 9.9.9",
        "⑦a 历史句被动了或发布行没改：回写跑到窄面之外（或没落到发布行上）");
      const cn = readFileSync(path.join(tree, "README_cn.md"), "utf8");
      expect(cn.includes("**0.27.0 从未发布**"), "⑦a README_cn 的历史句 `0.27.0 从未发布` 逐字保留",
        "⑦a README_cn 的历史句被改了——回写跑到了发布态句子之外");
      const changelog = readFileSync(path.join(tree, "CHANGELOG.md"), "utf8");
      expect(changelog === SYNC_FIXTURE["CHANGELOG.md"], "⑦a CHANGELOG 没有 9.9.9 段 ⇒ 一个字节未动（不造段、不猜标记）",
        "⑦a CHANGELOG 被改了：没有该版本段时回写不许动它");
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // (b) 不给 `--published` ⇒ exit 2 且**一个字节都不写**
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-sync-b-"));
    try {
      writeFixtureTree(tree);
      const before = snapshotTree(tree);
      const result = runSync(tree, []);
      expect(result.status === 2, "⑦b 不给 `--published` ⇒ exit 2（真值缺位就不回写）",
        `⑦b 不给 \`--published\` 时 exit ${result.status}（期望 2）`);
      const changes = diffSnapshot(before, snapshotTree(tree));
      expect(changes.length === 0, "⑦b 不给 `--published` 时 0 字节写入（前后快照逐字相同）",
        `⑦b 不给 \`--published\` 却写了：${changes.join(", ")}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // (c) 发布态与段首标记 + 日期：0.31.0 已发布 ⇒ 段首写成 `## [0.31.0] - <发布日期>`（标记摘掉、日期写上），其余字节不动
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-sync-c-"));
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      const result = runSync(tree, ["--published", "0.31.0", "--published-date", "2026-11-03"]);
      expect(result.status === 0, "⑦c `--sync --version 0.31.0 --published 0.31.0 --published-date 2026-11-03` exit 0",
        `⑦c exit ${result.status}\n${result.stdout}${result.stderr}`);
      const expected = {
        ...SYNC_FIXTURE,
        "package.json": '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n',
        "README.md": SYNC_FIXTURE["README.md"].replace("**v0.30.0**", "**v0.31.0**"),
        "README_cn.md": SYNC_FIXTURE["README_cn.md"].replace("**v0.30.0**", "**v0.31.0**"),
        "AGENTS.md": SYNC_FIXTURE["AGENTS.md"].split("0.30.0").join("0.31.0"),
        "AGENTS_cn.md": SYNC_FIXTURE["AGENTS_cn.md"].split("0.30.0").join("0.31.0"),
        "docs/requirements.md": SYNC_FIXTURE["docs/requirements.md"].split("0.30.0").join("0.31.0"),
        "docs/requirements_cn.md": SYNC_FIXTURE["docs/requirements_cn.md"].split("0.30.0").join("0.31.0"),
        "CHANGELOG.md": SYNC_FIXTURE["CHANGELOG.md"].replace("## [0.31.0]（未发布 / unpublished）", "## [0.31.0] - 2026-11-03"),
      };
      const changelog = readFileSync(path.join(tree, "CHANGELOG.md"), "utf8");
      expect(changelog === expected["CHANGELOG.md"],
        "⑦c CHANGELOG 的 0.31.0 段首**同一行**写成 `## [0.31.0] - 2026-11-03`（标记与日期同一步写），段里其余字节逐字不动",
        `⑦c CHANGELOG 不是「段首那一行重写成发布形状」的期望文本——回写跑到了段首之外：\n${changelog}`);
      const mismatched = Object.keys(expected).filter((rel) => readFileSync(path.join(tree, rel), "utf8") !== expected[rel]);
      expect(mismatched.length === 0, "⑦c 全部文件逐字节等于期望文本（发布态句子换成 0.31.0 + 段首那一行写成发布日期，其余一字未动）",
        `⑦c 这些文件与期望文本不一致：${mismatched.join(", ")}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // (e) 反方向：段首带着日期 + 未发布标记、发布行仍是上一版 ⇒ 段首**只留**版本与标记（日期被拿掉）
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-sync-e-"));
    try {
      const dated = {
        ...SYNC_FIXTURE,
        "CHANGELOG.md": SYNC_FIXTURE["CHANGELOG.md"].replace("## [0.31.0]（未发布 / unpublished）",
          "## [0.31.0] - 2026-11-10（未发布 / unpublished）"),
      };
      writeFixtureTree(tree, dated);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      const before = snapshotTree(tree);
      const result = runSync(tree, ["--version", "0.31.0", "--published", "0.30.0"]);
      expect(result.status === 0, "⑦e 未发布态回写（发布行 0.30.0 < 本仓版本 0.31.0）exit 0",
        `⑦e exit ${result.status}\n${result.stdout}${result.stderr}`);
      const after = snapshotTree(tree);
      expect(after.get("CHANGELOG.md") === dated["CHANGELOG.md"].replace(
        "## [0.31.0] - 2026-11-10（未发布 / unpublished）", "## [0.31.0]（未发布 / unpublished）"),
        "⑦e 未发布段的段首日期被拿掉，只剩 `## [0.31.0]（未发布 / unpublished）`",
        `⑦e 段首不是「只留版本与标记」的形状：\n${after.get("CHANGELOG.md")}`);
      const lineDiff = before.get("CHANGELOG.md").split("\n")
        .filter((line, i) => line !== after.get("CHANGELOG.md").split("\n")[i]);
      expect(lineDiff.length === 1, "⑦e CHANGELOG 逐行比对只有一行变（段首那一行；段里其余字节逐字不动）",
        `⑦e 变了 ${lineDiff.length} 行：${lineDiff.join(" | ")}`);
      expect(before.get("CHANGELOG.md").split("\n").length === after.get("CHANGELOG.md").split("\n").length,
        "⑦e 行数不变（回写不增行不删行，只改段首那一行）",
        "⑦e 行数变了：回写把段首那一行拆成/合并成了多行");
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // (f) 不给 `--published-date` ⇒ 缺省 = **当天 UTC+8**（标记与日期同一步写，日期不是从旧文本里抄的）
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-sync-f-"));
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      const todayBefore = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const result = runSync(tree, ["--published", "0.31.0"]);
      const todayAfter = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const heading = readFileSync(path.join(tree, "CHANGELOG.md"), "utf8").split("\n")
        .find((line) => line.startsWith("## [0.31.0]"));
      const wanted = [`## [0.31.0] - ${todayBefore}`, `## [0.31.0] - ${todayAfter}`];
      expect(result.status === 0 && wanted.includes(heading),
        `⑦f 缺省日期 = 当天 UTC+8（实测段首：${heading}）`,
        `⑦f 缺省日期不是当天 UTC+8：段首 ${JSON.stringify(heading)}（期望 ${wanted.join(" / ")}），exit ${result.status}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // (g) `--published-date` 形状不对 ⇒ exit 2 且一个字节都不写
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-sync-g-"));
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      const before = snapshotTree(tree);
      const result = runSync(tree, ["--published", "0.31.0", "--published-date", "2026/11/03"]);
      const changes = diffSnapshot(before, snapshotTree(tree));
      expect(result.status === 2 && changes.length === 0,
        "⑦g `--published-date 2026/11/03` ⇒ exit 2 且 0 字节写入（日期真值形状不对就不回写）",
        `⑦g exit ${result.status}、改动 ${changes.join(", ") || "（无）"}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // (d) 再跑一次同一组参数 ⇒ 0 字节写入（幂等：回写不许每跑一次就动一次盘）
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-sync-d-"));
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      runSync(tree, ["--published", "0.31.0", "--published-date", "2026-11-03"]);
      const before = snapshotTree(tree);
      const result = runSync(tree, ["--published", "0.31.0", "--published-date", "2026-11-03"]);
      const changes = diffSnapshot(before, snapshotTree(tree));
     expect(result.status === 0 && changes.length === 0, "⑦d 同一组参数重跑 ⇒ exit 0 且 0 字节写入（幂等）",
        `⑦d 幂等被打破：exit ${result.status}，改动 ${changes.join(", ") || "（无）"}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // (h) requirements §4 阶段表的 **current 行**接进写盘面（issue #699 ④）：中英**成对**跟着 package.json 走，
  //     而**窄面**由逐行比对看守——阶段表里只准那一行动，其余行（含上界以外的每一个字节）逐字不动。
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-sync-h-"));
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      const result = runSync(tree, ["--published", "0.31.0", "--published-date", "2026-11-03"]);
      expect(result.status === 0, "⑦h 带阶段表 current 行的树：`--sync --published 0.31.0` exit 0",
        `⑦h exit ${result.status}\n${result.stdout}${result.stderr}`);
      const rows = {};
      for (const [rel, label] of [["docs/requirements.md", "current"], ["docs/requirements_cn.md", "当前"]]) {
        const before = SYNC_FIXTURE[rel].split("\n");
        const after = readFileSync(path.join(tree, rel), "utf8").split("\n");
        const moved = before.map((line, i) => (line === after[i] ? null : i))
          .filter((i) => i !== null && after[i] !== undefined);
        const tableMoved = moved.filter((i) => before[i].startsWith("| "));
        expect(tableMoved.length === 1 && before[tableMoved[0]].includes(`— ${label}`)
            && after[tableMoved[0]] === before[tableMoved[0]].replace("v0.9.0–v0.30.0", "v0.9.0–v0.31.0"),
          `⑦h ${rel} 的阶段表**只有 current 那一行**变了，且只把上界换成 0.31.0（行首下界、其余单元格逐字未动）`,
          `⑦h ${rel} 阶段表动了 ${tableMoved.length} 行（期望恰好 1 行且是 current 行）：`
            + tableMoved.map((i) => `\n  - ${before[i].slice(0, 60)}…\n  + ${(after[i] ?? "（无此行）").slice(0, 60)}…`).join(""));
        rows[rel] = after[tableMoved[0]] ?? "";
      }
      // 中英**成对**：两侧同一行都跟着 package.json 走（只动一边就是漏了一边）
      expect(rows["docs/requirements.md"].includes("v0.9.0–v0.31.0 \u2014 current")
          && rows["docs/requirements_cn.md"].includes("v0.9.0–v0.31.0 \u2014 当前"),
        "⑦h 中英两侧的 current 行**成对**回写到 0.31.0（不是只改一边）",
        `⑦h 两侧不是成对回写：EN=${rows["docs/requirements.md"].slice(0, 40)} / CN=${rows["docs/requirements_cn.md"].slice(0, 40)}`);
      // 窄面的定位面：上下界写成同一个版本号时，换的必须是**上界**
      // （`--sync` 用 `whole.indexOf(captured)` 定位；整行匹配那种写法在这里会换掉下界）
      rmSync(tree, { recursive: true, force: true });
      mkdirp(tree);
      writeFixtureTree(tree, {
        ...SYNC_FIXTURE,
        "docs/requirements.md": SYNC_FIXTURE["docs/requirements.md"]
          .replace("**v0.9.0\u2013v0.30.0 \u2014 current**", "**v0.31.0\u2013v0.31.0 \u2014 current**"),
        "docs/requirements_cn.md": SYNC_FIXTURE["docs/requirements_cn.md"]
          .replace("**v0.9.0\u2013v0.30.0 \u2014 当前**", "**v0.31.0\u2013v0.31.0 \u2014 当前**"),
      });
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.32.0"\n}\n', "utf8");
      const equal = runSync(tree, ["--version", "0.32.0", "--published", "0.32.0", "--published-date", "2026-11-04"]);
      const enRow = readFileSync(path.join(tree, "docs/requirements.md"), "utf8")
        .split("\n").find((line) => line.includes("\u2014 current")) ?? "";
      const cnRow = readFileSync(path.join(tree, "docs/requirements_cn.md"), "utf8")
        .split("\n").find((line) => line.includes("\u2014 当前")) ?? "";
      expect(equal.status === 0 && enRow.includes("**v0.31.0\u2013v0.32.0 \u2014 current**")
          && cnRow.includes("**v0.31.0\u2013v0.32.0 \u2014 当前**"),
        "⑦h 上下界同值（`v0.31.0\u2013v0.31.0`）时只换**上界**⇒ `v0.31.0\u2013v0.32.0`（中英两侧；写反了就是回写跑到下界上）",
        `⑦h 上下界同值时换错了字节：exit ${equal.status}，EN=${enRow.slice(0, 46)} / CN=${cnRow.slice(0, 46)}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // (i) 阶段表里**没有** current 行 ⇒ exit 2 且 0 字节写入：新接进写盘面的声称句读不出，
  //     与其余句子同一口径（「读不出」永远不等于「没这句话」，更不等于绿）
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-sync-i-"));
    try {
      const noRow = {
        ...SYNC_FIXTURE,
        "docs/requirements.md": SYNC_FIXTURE["docs/requirements.md"].replace("\n| **v0.9.0\u2013v0.30.0 \u2014 current** | scope | status |", ""),
        "docs/requirements_cn.md": SYNC_FIXTURE["docs/requirements_cn.md"].replace("\n| **v0.9.0\u2013v0.30.0 \u2014 当前** | 范围 | 状态 |", ""),
      };
      writeFixtureTree(tree, noRow);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      const before = snapshotTree(tree);
      const result = runSync(tree, ["--published", "0.31.0", "--published-date", "2026-11-03"]);
      const changes = diffSnapshot(before, snapshotTree(tree));
      expect(result.status === 2 && changes.length === 0,
        "⑦i 阶段表缺 current 行 ⇒ exit 2 且 0 字节写入（新写盘面也 fail-closed，不许静默跳过那一处）",
        `⑦i exit ${result.status}、改动 ${changes.join(", ") || "（无）"}；输出：${result.stdout}${result.stderr}`);
      expect(/current \u884c/.test(result.stdout) && /docs\/requirements\.md/.test(result.stdout),
        "⑦i 报错点名「阶段表 current 行」与缺它的那份文档（不是笼统一句「读不出」）",
        `⑦i 没点名是哪一处读不出：${result.stdout}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }
}

/**
 * 跑一段「`root` 是合成树」的 preflight（自测用）。issue #715 之后第 2 步读的是 `root` 里的
 * `package.json` + `CHANGELOG.md`，所以 preflight 的自测不能拿本仓当 root：本仓 `[Unreleased]`
 * 里本来就可能有待入账条目（那是正常开发态），拿它当夹具会让自测跟着本仓的内容漂。
 */
function withPreflightFixture(fn) {
  const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-preflight-"));
  try {
    writeFixtureTree(tree);
    return fn(tree);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

/**
 * ⑭ issue #715：`## [Unreleased]` 的漏搬格。三态各一格，外加三条**反向证**（变异不落地 = 失败）。
 *
 * 夹具只写 `package.json` + `CHANGELOG.md`（本格只读这两份）：
 *   · `RED_CHANGELOG` = 切版做完（`## [0.31.0]（未发布 / unpublished）` 已开）但条目**还停在** `[Unreleased]`；
 *   · 其余形态都是**在它上面做变异**得到的，于是「变异真的落了上」本身也是判据。
 */
function selfTestUnreleasedCarry(checker) {
  const { expect } = checker;
  const heading = "## [0.31.0]（未发布 / unpublished）";
  const RED_CHANGELOG = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- **A stranded entry nobody carried (issue #900).** It belongs in the 0.31.0 section.",
    "- 第二条停在 `[Unreleased]` 里的中文条目，用来验判词逐条点名，并且故意写到超过六十个字好看到省略号的位置上。",
    "",
    heading,
    "",
    "### Breaking",
    "",
    "- older",
    "",
  ].join("\n");
  const treeFor = (changelog, version = "0.31.0") => {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-unreleased-"));
    writeFileSync(path.join(tree, "package.json"), `{\n  "name": "erix-agent",\n  "version": "${version}"\n}\n`, "utf8");
    writeFileSync(path.join(tree, "CHANGELOG.md"), changelog, "utf8");
    return tree;
  };
  const probeOn = (changelog, version) => {
    const tree = treeFor(changelog, version);
    try {
      return probeUnreleasedCarry({ root: tree });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  };

  // ⑭a 红：版本节已开（未发布形态）+ 条目还停在 `[Unreleased]`
  {
    const found = probeOn(RED_CHANGELOG);
    expect(found.verdict === VERDICT.FAIL && /2 条未入账条目停在/u.test(found.why),
      `⑭a 版本节已开 + \`[Unreleased]\` 里 2 条 bullet ⇒ 红，并点名「2 条未入账条目停在」（${found.why}）`,
      `⑭a 裁决是 ${found.verdict}（why=${found.why}）——漏搬形态必须红`);
    expect(/4963293/u.test(found.lines.join("\n")) && /## \[0\.31\.0\]/u.test(found.lines.join("\n")),
      "⑭a 判词自带可执行动作：按 4963293 的形状插入 `## [0.31.0]` 标题行（不是只说「不通过」）",
      `⑭a 判词里没有可执行动作：${found.lines.join(" | ")}`);
    const bulletLines = found.lines.filter((line) => /^\s+\d+\. 第 \d+ 行/u.test(line));
    expect(bulletLines.length === 2,
      `⑭a 逐条列出 bullet（2 条，带行号）：${bulletLines.map((l) => l.trim().slice(0, 24)).join(" / ")}`,
      `⑭a 没有逐条列出 bullet：${found.lines.join(" | ")}`);
    expect(bulletLines.some((line) => line.endsWith("…"))
        && bulletLines.every((line) => (line.split(" 行 ")[1] ?? "").length <= 61),
      "⑭a 每条只给前 60 字（超长的加省略号，不把整条贴进判词）",
      `⑭a bullet 预览长度不对：${bulletLines.join(" | ")}`);
    expect(found.lines.join("\n").includes("check:changelog")
        && found.lines.join("\n").includes("guide-coverage")
        && found.lines.join("\n").includes("配对地板"),
      "⑭a 判词点名既有三道防线（免得后人以为它们已经兜住这个形态、重复造闸）",
      `⑭a 判词没写既有防线：${found.lines.join(" | ")}`);
  }

  // ⑭b 反向证 ①：把标题行插到条目之前（= 4963293 的形状）⇒ 转绿（变异真的落了上）
  {
    const mutated = RED_CHANGELOG.replace(`${heading}\n\n`, "")
      .replace("## [Unreleased]\n\n", `## [Unreleased]\n\n${heading}\n\n`);
    expect(mutated !== RED_CHANGELOG, "⑭b 变异真的落了上（标题行从下面搬到了条目之前）",
      "⑭b 变异没落上：两份文本一字相同，这一格什么都没证");
    const found = probeOn(mutated);
    expect(found.verdict === VERDICT.PASS,
      "⑭b 按 4963293 的形状搬运之后 ⇒ 绿（判词给的动作真的能把这格变绿）",
      `⑭b 搬完之后裁决是 ${found.verdict}（why=${found.why}）`);
  }

  // ⑭c 反向证 ②：顶部 `## [Unreleased]` 改名而不补新的 ⇒ 点名「找不到版本节」，不是静默绿
  {
    const mutated = RED_CHANGELOG.replace("## [Unreleased]\n", "## [0.32.0] - 2026-11-05\n");
    expect(mutated !== RED_CHANGELOG, "⑭c 变异真的落了上（顶部 `[Unreleased]` 被改名）",
      "⑭c 变异没落上：这一格什么都没证");
    const found = probeOn(mutated);
    expect(found.verdict === VERDICT.FAIL && /找不到版本节/u.test(found.why),
      "⑭c 顶部 `[Unreleased]` 改名而不补新的 ⇒ 红并点名「找不到版本节」（不许静默绿）",
      `⑭c 裁决是 ${found.verdict}（why=${found.why}）——改名形态必须被点名`);
  }

  // ⑭d 反向证 ③：版本节从有到无 ⇒ 从红变**未判定**（不是变绿）
  {
    const red = probeOn(RED_CHANGELOG);
    const mutated = RED_CHANGELOG.replace(`${heading}\n\n`, "");
    expect(mutated !== RED_CHANGELOG, "⑭d 变异真的落了上（版本节被拿掉）", "⑭d 变异没落上：这一格什么都没证");
    const found = probeOn(mutated);
    expect(red.verdict === VERDICT.FAIL && found.verdict === VERDICT.NOT_JUDGED,
      "⑭d 版本节从有到无 ⇒ 红 → **未判定**（exit 2），不是变绿",
      `⑭d 从红变成了 ${found.verdict}（期望 ${VERDICT.NOT_JUDGED}；变绿就是静默放行）`);
    expect(/还没切版/u.test(found.why) && /动作/u.test(found.lines.join("\n")),
      "⑭d 未判定的读数说清「还没切版」并给出「先开节再搬运」的动作",
      `⑭d 读数没写可执行动作：${found.why} / ${found.lines.join(" | ")}`);
  }

  // ⑭e 假红防线：preflight 跑在切版之前（版本节已带发布日期 = 上一版已发布，`[Unreleased]` 里有下一版的条目）
  {
    const preCut = RED_CHANGELOG.replace(heading, "## [0.31.0] - 2026-11-04");
    expect(preCut !== RED_CHANGELOG, "⑭e 变异真的落了上（段首改成带发布日期的形态）", "⑭e 变异没落上");
    const found = probeOn(preCut);
    expect(found.verdict === VERDICT.NOT_JUDGED,
      "⑭e 切版之前（本版已发布、`[Unreleased]` 有待入账条目）⇒ 未判定，**不是红**（这就是「非空即红」要避的那个假红）",
      `⑭e 切版之前的正常态被判成了 ${found.verdict}（期望 ${VERDICT.NOT_JUDGED}）`);
  }

  // ⑭f 版本号不写死：读的是 `package.json` 现值（这里换成 7.7.7，判词跟着走）
  {
    const other = RED_CHANGELOG.replace(heading, "## [7.7.7]（未发布 / unpublished）");
    const found = probeOn(other, "7.7.7");
    expect(found.verdict === VERDICT.FAIL && /## \[7\.7\.7\]/u.test(found.lines.join("\n")),
      "⑭f 版本号从 `package.json` 现读：7.7.7 的树判词点名 `## [7.7.7]`（不写死 0.31.0）",
      `⑭f 7.7.7 的树裁决是 ${found.verdict}，判词：${found.lines.join(" | ")}`);
  }

  // ⑭g 绿：版本节已开 且 `[Unreleased]` 为空（本仓当下的形态）
  {
    const found = probeOn(["# Changelog", "", "## [Unreleased]", "", heading, "", "- older", ""].join("\n"));
    expect(found.verdict === VERDICT.PASS, "⑭g 版本节已开 + `[Unreleased]` 空 ⇒ 绿（对照组）",
      `⑭g 对照组裁决是 ${found.verdict}（why=${found.why}）`);
  }

  // ⑭h 接线：这一格红 ⇒ preflight 停在第 2 步、后面的前置一步都不跑；未判定 ⇒ 整体 exit 2
  {
    const tree = treeFor(RED_CHANGELOG);
    try {
      const deps = fakeDeps({ env: { PATH: "/usr/bin", HOME: "/nonexistent-home", ERIX_E2E_REAL: "1" } });
      const result = runPreflight({ root: tree, hosts: [tree], deps, dry: true });
      expect(result.verdict === VERDICT.FAIL && result.failedAt === 2 && result.failedId === "changelog-unreleased",
        "⑭h 漏搬格红 ⇒ preflight 停在第 2 步并点名 changelog-unreleased",
        `⑭h 没停在第 2 步：verdict=${result.verdict} failedAt=${result.failedAt} failedId=${result.failedId}`);
      expect(!deps.calls.some((line) => line.includes("check:docs")),
        "⑭h 这一格红了之后 `check:docs` / `check:release` / 宿主探针一步都没跑（它是最便宜的那一格）",
        `⑭h 红了还在往下跑：${deps.calls.join(" | ")}`);

      const notJudgedTree = treeFor(RED_CHANGELOG.replace(`${heading}\n\n`, ""));
      try {
        const okDeps = fakeDeps({ env: { PATH: "/usr/bin", HOME: "/nonexistent-home", ERIX_E2E_REAL: "1" } });
        const overall = runPreflight({ root: notJudgedTree, hosts: [notJudgedTree], deps: okDeps, dry: true });
        expect(overall.verdict === VERDICT.NOT_JUDGED,
          "⑭h 这一格未判定（还没切版）⇒ 整趟 preflight 未判定（exit 2），不是绿",
          `⑭h 未判定的格把整体判成了 ${overall.verdict}`);
      } finally {
        rmSync(notJudgedTree, { recursive: true, force: true });
      }
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }
}

/**
 * ⑮ issue #731 N1：`--all` 在 preflight 未判定时的结语。
 *
 * 旧文案是一句硬写的「把闸开起来再发（`ERIX_E2E_REAL=1` / `--hosts …`）」——对第 5/7 步是对的，
 * 对第 2 步（`changelog-unreleased`）是空话：那一格判未判定是因为**还没切版**，没有任何开关能造出判定。
 * 这一族把「按 id 分叉」钉成判据：含第 2 步 ⇒ 文案是「先切版」且**不许**出现「把闸开起来再发」。
 */
function selfTestUnjudgedConclusion(checker) {
  const { expect } = checker;
  const un = (...ids) => ids.map((id) => ({ id, verdict: VERDICT.NOT_JUDGED }));

  // ⑮a 含 `changelog-unreleased` ⇒ 结语文案是「先切版」，且不出现「把闸开起来再发」
  {
    const { head, lines } = unjudgedConclusion(un("changelog-unreleased"));
    expect(/先切版|先把版切了/u.test(head) && !/把闸开起来再发/u.test(head),
      `⑮a 只有第 2 步未判定 ⇒ 结语是「先切版」而不是「把闸开起来」（head=${head}）`,
      `⑮a 结语还在教人去找一个不存在的闸：${head}`);
    expect(/没有闸可开/u.test(lines.join("\n")),
      "⑮a 逐格动作点名「这一格没有闸可开」（缺的是切版这个事实，不是开关）",
      `⑮a 逐格动作没写清：${lines.join(" | ")}`);
  }

  // ⑮b 只有闸门类未判定 ⇒ 说开闸，**不**提切版（分叉不是恒说切版）
  {
    const { head, lines } = unjudgedConclusion(un("release-real", "host-consumers"));
    expect(/把闸开起来再发/u.test(head) && !/先把版切了/u.test(head),
      `⑮b 只有闸门类格子未判定 ⇒ 结语是「把闸开起来再发」（head=${head}）`,
      `⑮b 闸门类格子的结语串了切版那一句：${head}`);
    expect(/ERIX_E2E_REAL/u.test(lines.join("\n")) && /--hosts/u.test(lines.join("\n")),
      "⑮b 逐格动作各自点名自己的开关（`ERIX_E2E_REAL` 与 `--hosts` 都要点名）",
      `⑮b 逐格动作缺开关名：${lines.join(" | ")}`);
  }

  // ⑮c 两类同时缺 ⇒ 两句都在（不许只报其中一种，也不许合并成一句含糊的「把闸开起来」）
  {
    const { head } = unjudgedConclusion(un("changelog-unreleased", "release-real"));
    expect(/切版/u.test(head) && /闸开起来/u.test(head),
      `⑮c 两类都缺 ⇒ 结语同时点名两件事（head=${head}）`,
      `⑮c 结语漏了一半：${head}`);
  }

  // ⑮d 覆盖钉子：**每个可能答「未判定」的步骤**都必须登记动作（新加一步漏登记 ⇒ 红）
  {
    const missing = PREFLIGHT_STEPS
      .filter((step) => (step.gate || step.probe) && !UNJUDGED_ACTIONS[step.id])
      .map((step) => step.id);
    expect(missing.length === 0,
      `⑮d PREFLIGHT_STEPS 里可能判未判定的步骤（gate/probe 非空）都在 UNJUDGED_ACTIONS 里有动作`
      + `（已登记 ${Object.keys(UNJUDGED_ACTIONS).length} 格）`,
      `⑮d 这些步骤可能答未判定却没登记动作，结语会对它们说不出话：${missing.join(", ")}`);
  }

  // ⑮e 端到端：runAll 跑在「还没切版」的宿主上 ⇒ **打出来的**那句结语就是「先切版」（不是恒绿的函数）
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-unjudged-"));
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      // 0.31.0 的段**不存在**（只有已发布的 0.30.0）⇒ 第 2 步答「还没切版」（未判定），其余格子全绿。
      writeFileSync(path.join(tree, "CHANGELOG.md"),
        "# Changelog\n\n## [Unreleased]\n\n- 一条还停在 `[Unreleased]` 的条目\n\n## [0.30.0] - 2026-11-03\n\n- older\n",
        "utf8");
      const logged = [];
      const deps = {
        ...fakeDeps({ env: { PATH: "/usr/bin", HOME: "/nonexistent-home", ERIX_E2E_REAL: "1" } }),
        log(...args) { logged.push(args.join(" ")); },
      };
      const status = runAll({ root: tree, deps, stateFile: path.join(tree, "state.json"), dry: true, hosts: [tree] });
      const body = logged.join("\n");
      expect(status === EXIT.NOT_JUDGED,
        `⑮e 「还没切版」的宿主上 \`--all\` 未判定（exit 2），实测 exit ${status}`,
        `⑮e 退出码是 ${status}（应当 2）：${body.slice(-400)}`);
      expect(/未判定/u.test(body) && /先切版|先把版切了/u.test(body) && !/把闸开起来再发/u.test(body),
        "⑮e runAll 真把「先切版」那句结语打出来了（结语函数不是死代码）",
        `⑮e 打出来的结语：${body.split("\n").filter((l) => /未判定|切版|闸开起来/u.test(l)).join(" / ") || "（一句都没打）"}`);
      expect(/changelog-unreleased/u.test(body),
        "⑮e 结语逐格点名了是哪一步没跑（不许只说一句总括）",
        `⑮e 没点名步骤 id：${body.slice(-400)}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }
}

/**
 * ⑯ issue #731 N4 / N3 / N2：CHANGELOG 的三条口径收敛到 `scripts/changelog-heading.mjs` 之后，
 * 把**选定的那一侧**钉住，并把「不许再抄一份」钉成机器判据。
 *
 * 为什么这些用例长这样：`release-day.mjs`（preflight 第 2 步）与 `docs-drift-check.mjs`（`check:docs` 的
 * §17 / §17b）读的是同一棵树，此前对同一行给两个答案。用例不证明「哪个更对」，它证明**只有一个答案**，
 * 并且把三个已知不对称（星号 bullet、围栏里的 `- x`、歪缩进标题）钉成显式决定而不是巧合。
 */
function selfTestChangelogCaliber(checker) {
  const { expect } = checker;
  const here = path.dirname(fileURLToPath(import.meta.url));
  /** 读一份脚本源码（跨文件钉子用；读不到就算红，不许静默跳过）。 */
  const readSource = (name) => {
    try {
      return readFileSync(path.join(here, name), "utf8");
    } catch {
      return null;
    }
  };

  // ⑯a **标题口径 = 严格单空格**：`##  [0.31.0]`（两个空格）在两个读者手里都**不是**版本节。
  //    旧行为：这一格用 `^##\s*\[`（容忍），`check:docs` 用字面单空格 ⇒ 同一行两个答案。
  {
    const skewed = "##  [0.31.0]（未发布 / unpublished）";
    expect(matchChangelogVersionHeading(skewed) === null,
      "⑯a 共享谓词把 `##  [x]`（双空格）判成**不是**版本节（严格单空格口径）",
      `⑯a 谓词把歪缩进的标题当成了版本节：${JSON.stringify(matchChangelogVersionHeading(skewed))}`);
    const changelog = ["# Changelog", "", "## [Unreleased]", "", "- 一条还没搬的条目（issue #900）", "", skewed, "", "- older", ""].join("\n");
    const found = probeUnreleasedCarry({
      root: (() => {
        const t = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-caliber-"));
        writeFileSync(path.join(t, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
        writeFileSync(path.join(t, "CHANGELOG.md"), changelog, "utf8");
        return t;
      })(),
    });
    expect(found.verdict === VERDICT.NOT_JUDGED && /还没切版/u.test(found.why),
      `⑯a 只有歪缩进版本节的树 ⇒ 这一格答「还没切版」的**未判定**（不是绿，也不是把歪行当版本节）（why=${found.why}）`,
      `⑯a 裁决是 ${found.verdict}：${found.why}`);
    expect(/插入|补一行/u.test(found.lines.join("\n")),
      "⑯a 判词给出动作（插入正确缩进的版本节），不是只说一句「找不到」",
      `⑯a 没给动作：${found.lines.join(" | ")}`);
  }

  // ⑯b **bullet 口径的两个已知不对称**钉成显式决定：`* 星号` 不算、围栏里的 `- x` 算。
  //    两侧本来一致，但没有钉子；今天有人「顺手放松成也认 `*`」，配对地板与这一格会一起挪而没人察觉。
  {
    expect(isChangelogBulletLine("- 普通条目") && !isChangelogBulletLine("* 星号条目（issue #900）"),
      "⑯b bullet 谓词：行首 `- ` 算，行首 `* ` **不**算（不对称是**选定**的，不是巧合）",
      "⑯b 谓词的星号口径变了 ⇒ 配对地板与 preflight 的读数会一起挪，先来看这条钉子");
    const starOnly = ["# Changelog", "", "## [Unreleased]", "", "* 星号条目（issue #900）", "* 第二条", "",
      "## [0.31.0]（未发布 / unpublished）", "", "- older", ""].join("\n");
    const treeStar = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-star-"));
    try {
      writeFileSync(path.join(treeStar, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      writeFileSync(path.join(treeStar, "CHANGELOG.md"), starOnly, "utf8");
      const found = probeUnreleasedCarry({ root: treeStar });
      expect(found.verdict === VERDICT.PASS,
        "⑯b 顶部只有星号条目 ⇒ 这一格**绿**（「不算 bullet」的已知后果被钉住，改动它必须显式）",
        `⑯b 裁决是 ${found.verdict}：${found.why}`);
    } finally {
      rmSync(treeStar, { recursive: true, force: true });
    }
    const fenced = ["# Changelog", "", "## [Unreleased]", "", "```md", "- 围栏里的示例（issue #900）", "```", "",
      "## [0.31.0]（未发布 / unpublished）", "", "- older", ""].join("\n");
    const treeFenced = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-fence-"));
    try {
      writeFileSync(path.join(treeFenced, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      writeFileSync(path.join(treeFenced, "CHANGELOG.md"), fenced, "utf8");
      const found = probeUnreleasedCarry({ root: treeFenced });
      expect(found.verdict === VERDICT.FAIL && /1 条未入账条目停在/u.test(found.why),
        `⑯b 围栏代码块里的 \`- x\` **算**一条（假红的那一半也被钉住，不许偷偷改）（why=${found.why}）`,
        `⑯b 裁决是 ${found.verdict}：${found.why}`);
    } finally {
      rmSync(treeFenced, { recursive: true, force: true });
    }
  }

  // ⑯c **反抄件钉子**：三个调用方的源码里不再有这三条口径的字面拷贝，且都从共享模块 import。
  //    （只靠注释「复用某某」拦不住下一次复制粘贴；这条一红就说明有人又抄了一份回去。）
  {
    // 被禁的字面要**拼出来**：写成一个整串，这一行自己就含那个字面，钉子会把自己判红。
    const HEADING_TOLERANT = ["^", "##", "\\s*", "\\["].join("");   // 曾经写在 release-day 里的那份（容忍多空格）
    const HEADING_STRICT = ["^", "##", " [(", "\\d"].join("");      // 曾经写在 docs-drift-check 里的那份（字面单空格）
    const DATED_CLASS = ["[-", "—", "]"].join("");                  // 段首日期正则里的那个破折号字符类
    const BULLET_CALL = ["starts", "With", '("- ")'].join("");      // 调用方自己写的 bullet 判断
    /** 各调用方源码里不许再出现的字面（出现 = 有人把口径又抄回调用方）。 */
    const FORBIDDEN = {
      "release-day.mjs": [HEADING_TOLERANT, DATED_CLASS],
      "docs-drift-check.mjs": [HEADING_STRICT, DATED_CLASS],
      "test/static-guards.test.js": [BULLET_CALL],
    };
    const offenders = [];
    for (const [name, needles] of Object.entries(FORBIDDEN)) {
      const file = name.startsWith("test/") ? path.join(here, "..", name) : path.join(here, name);
      let source = null;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        source = null;
      }
      if (source === null) { offenders.push(`${name}（读不到源码 ⇒ 这条钉子无法工作）`); continue; }
      // 注释里复述口径是允许的（而且必要），只判**代码行**；剔除整行注释与 jsdoc 续行。
      const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line)).join("\n");
      if (!source.includes("changelog-heading.mjs")) offenders.push(`${name} 没有 import \`changelog-heading.mjs\``);
      for (const needle of needles) if (code.includes(needle)) offenders.push(`${name}: 代码里又出现了 ${needle}`);
    }
    expect(offenders.length === 0,
      "⑯c 三个调用方（release-day / docs-drift-check / static-guards）都 import 共享口径，且代码里没有字面拷贝"
      + "（标题 / 段首日期 / bullet 三条只住一份）",
      `⑯c 口径又被抄回调用方：${offenders.join(" / ")}`);
    const drift = readSource("docs-drift-check.mjs") ?? "";
    expect(/UNPUBLISHED_MARK_RE/u.test(drift) && /\bs\.dated\b/u.test(drift),
      "⑯c `docs-drift-check.mjs` §17b 那条不变量（未发布段不许带日期）还在 —— 本文件的 dated 分支在**消费**它（issue #731 N2）",
      "⑯c §17b 的「未发布段不许带发布日期」看起来被放宽或改名了：`release-day.mjs` 里「段首带日期 ⇒ 那一版已发布」"
      + "的前提随之失效（它会把带日期的在飞段永远判成未判定），两处必须一起改");
  }

  // ⑯d **N2 端到端**：带日期 + `package.json` 同版 + `[Unreleased]` 非空 ⇒ **未判定**，且判词讲清理由与依赖
  {
    const changelog = ["# Changelog", "", "## [Unreleased]", "", "- 一条下一版的条目（issue #900）", "",
      "## [0.31.0] - 2026-11-04", "", "- 已发布的条目", ""].join("\n");
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-dated-"));
    try {
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      writeFileSync(path.join(tree, "CHANGELOG.md"), changelog, "utf8");
      const found = probeUnreleasedCarry({ root: tree });
      expect(found.verdict === VERDICT.NOT_JUDGED,
        `⑯d 本版节段首带日期（= 已发布）而顶部节非空 ⇒ **未判定**（不是红，也不是绿）（verdict=${found.verdict}）`,
        `⑯d 裁决是 ${found.verdict}：${found.why}`);
      expect(/段首带发布日期/u.test(found.why) && /已发布/u.test(found.why),
        `⑯d 判词说清了「为什么带日期就算已发布」（why=${found.why}）`,
        "⑯d 判词只下了结论没给理由");
      const lines = found.lines.join("\n");
      expect(/#697/u.test(lines) && /§17b/u.test(lines),
        "⑯d 判词点名了这条前提的**出处**（`check:docs` 的 §17b / issue #697）——本格只是消费者（issue #731 N2）",
        `⑯d 判词没交代依赖住在哪：${lines}`);
      expect(/升到下一版/u.test(lines),
        "⑯d 动作是「切下一版」而不是「把这一版的日期删掉」（后者会把已发布段伪装成在飞段）",
        `⑯d 动作不对：${lines}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }
}

function runSelfTest() {
  const checker = makeChecker();
  const { expect } = checker;

  // ① preflight 某步红 ⇒ 停在那一步并点名
  {
    const deps = fakeDeps({ override: { "npm run check:release": { status: 1 } } });
    // issue #715：`root` 用合成树（`[Unreleased]` 空 + 本版段已开 ⇒ 第 2 步绿），于是本格不依赖本仓
    // CHANGELOG 当下的状态（本仓 `[Unreleased]` 里本来就可能有待入账条目）。
    withPreflightFixture((tree) => {
      const result = runPreflight({ root: tree, hosts: [tree], deps, dry: true });
      const releaseAt = PREFLIGHT_STEPS.findIndex((step) => step.id === "release") + 1;
      expect(result.verdict === VERDICT.FAIL && result.failedAt === releaseAt && result.failedId === "release",
        `① preflight 第 ${releaseAt} 步红 ⇒ 停在第 ${releaseAt} 步并点名 release（steps=${result.steps.length}）`,
        `① 没停在第 ${releaseAt} 步：verdict=${result.verdict} failedAt=${result.failedAt} failedId=${result.failedId}`);
      expect(!deps.calls.some((line) => line.includes("check:host-consumers")),
        "① 红之后的最后一步一步都没跑（顺序闸）",
        `① 红了还在往下跑：${deps.calls.filter((line) => line.includes("check:host-consumers")).join(", ")}`);
      expect(result.steps.at(-1)?.exitCode === 1, "① 红的那一步带着它的退出码（exit 1）",
        `① 红的那一步没带退出码：${JSON.stringify(result.steps.at(-1))}`);
    });
  }

  // ② ERIX_E2E_REAL 缺失 ⇒ 未判定，不是绿；那一步一步都没跑
  {
    const deps = fakeDeps();
    withPreflightFixture((tree) => {
      const result = runPreflight({ root: tree, hosts: [tree], deps, dry: true });
      const realStep = result.steps.find((step) => step.id === "release-real");
      expect(realStep?.verdict === VERDICT.NOT_JUDGED, "② 闸门关着 ⇒ release-real 判「未判定」（不是 pass）",
        `② release-real 判成了 ${realStep?.verdict}`);
      expect(result.verdict === VERDICT.NOT_JUDGED, "② 整体判未判定（不是全绿）",
        `② 整体判成了 ${result.verdict}`);
      expect(!deps.calls.some((line) => line.includes("check:release:real")),
        "② 闸门关着时真上游那一族一步都没跑（没跑 ≠ 绿）",
        `② 闸门关着却跑了真上游：${deps.calls.filter((line) => line.includes("check:release:real")).join(", ")}`);
    });
  }

  // ②b `--hosts` 目录不存在 ⇒ 未判定（探针口径）
  {
    const deps = fakeDeps();
    withPreflightFixture((tree) => {
      const result = runPreflight({ root: tree, hosts: ["/nonexistent/erix-host-689"], deps, dry: true });
      const hostStep = result.steps.find((step) => step.id === "host-consumers");
      expect(hostStep?.verdict === VERDICT.NOT_JUDGED && /HOST_DIR_/.test(hostStep?.why ?? ""),
        "②b `--hosts` 目录不存在 ⇒ 未判定，并按探针口径点名（HOST_DIR_MISSING / HOST_DIR_NOT_DIR）",
        `②b 目录不存在时的裁决是 ${hostStep?.verdict}（why=${hostStep?.why}）`);
      expect(result.verdict === VERDICT.NOT_JUDGED, "②b 整体判未判定（不是绿）", `②b 整体判成了 ${result.verdict}`);
      expect(!deps.calls.some((line) => line.includes("check:host-consumers")),
        "②b 目录不存在时探针一步都没跑（未判定不靠 exit 0 的假绿）",
        `②b 目录不存在却跑了探针：${deps.calls.join(", ")}`);
    });
  }

  // ②c 全绿 ⇒ pass（对照组：上面三条不是恒红）
  {
    const deps = fakeDeps({ env: { PATH: "/usr/bin", HOME: "/nonexistent-home", ERIX_E2E_REAL: "1" } });
    withPreflightFixture((tree) => {
      const result = runPreflight({ root: tree, hosts: [tree], deps, dry: true });
      expect(result.verdict === VERDICT.PASS && result.steps.length === PREFLIGHT_STEPS.length,
        "②c 闸门开 + 宿主目录在 + 每一步都全绿 ⇒ pass（对照组）",
        `②c 对照组不绿：verdict=${result.verdict} steps=${JSON.stringify(result.steps)}`);
      expect(deps.calls.some((line) => line.includes("check:release:real")) && deps.calls.some((line) => line.includes("--hosts")),
        "②c 闸门开着时真上游与宿主探针都真跑了",
        `②c 闸门开着却没跑：${deps.calls.join(" | ")}`);
    });
  }

  // ⑭ issue #715：`## [Unreleased]` 的漏搬格（三态 + 三条反向证）
  selfTestUnreleasedCarry(checker);

  // ⑮ issue #731 N1：`--all` 的未判定结语**按步骤 id 分叉**（第 2 步未判定 ⇒ 先切版，不是开闸）
  selfTestUnjudgedConclusion(checker);

  // ⑯ issue #731 N4/N3/N2：CHANGELOG 三条口径（标题 / bullet / 段首日期）在**两个读者**手里必须是同一个答案
  selfTestChangelogCaliber(checker);

  // ③ 回写失败 ⇒ 非零 + 状态文件留下 + 重跑从 writeback 续（不重复发布）
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-wb-"));
    const stateFile = path.join(tree, "state.json");
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      const failing = fakeDeps({ override: { [`node ${DOCS_SYNC_SCRIPT} --sync --published 0.31.0 --version 0.31.0`]: { status: 1 } } });
      const status = runWriteback({ root: tree, version: "0.31.0", published: "0.31.0", deps: failing, stateFile, dry: false });
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      expect(status === EXIT.RED, "③ 回写失败 ⇒ 整体非零", `③ 回写失败时退出码是 ${status}`);
      expect(state.phase === PHASE.PUBLISHED_UNWRITTEN && state.published === "0.31.0",
        `③ 状态文件留下「已发布、未回写」（phase=${state.phase} / published=${state.published}）`,
        `③ 状态文件没留下可续跑的坐标：${JSON.stringify(state)}`);

      // 重跑：`--all` 读到 published_unwritten ⇒ 从 writeback 续，不再走 preflight、不再打 publish 操作单
      const resumed = fakeDeps({ capture: gitPlumbing({ version: "0.31.0" }) });
      const allStatus = runAll({ root: tree, deps: resumed, stateFile, dry: false, version: "0.31.0" });
      const preflightOnly = resumed.calls.filter((line) => line === "npm run check:release"
        || line.includes("check:release:real") || line.includes("check:host-consumers"));
      expect(preflightOnly.length === 0,
        "③ 续跑**没有**重跑 preflight 的发布前置（不重复发布）",
        `③ 续跑又跑了 preflight：${preflightOnly.join(" | ")}`);
      expect(resumed.calls.some((line) => line.includes("--sync --published 0.31.0")),
        "③ 续跑真的从 writeback 起（跑了 --sync）",
        `③ 续跑没跑 --sync：${resumed.calls.join(" | ")}`);
      expect(allStatus !== EXIT.AWAITING_PUBLISH, "③ 续跑不会回到「等你发布」（exit 3）",
        `③ 续跑又停在 publish（exit ${allStatus}）——那就等于要人再发一次`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // ③b issue #697：回写后 check:docs 的 **exit 2 / TAG_MISSING** 是「未判定」不是红——tag 是 finalize
  // 才打的，writeback 自己那次 check:docs 只能得到这个结论。它必须**不**把回写判死（否则发版日永远卡在这里）。
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-wb-tagmissing-"));
    const stateFile = path.join(tree, "state.json");
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      const deps = fakeDeps({
        capture: (argv) => (argv.join(" ") === "npm run check:docs"
          ? { status: 2,
            stdout: "docs-drift-check: 未判定 — 1 处真值缺位（exit 2：未判定既不是绿也不是红）\n"
              + "docs-drift-check: 未判定 TAG_MISSING — changelog-date: registry 说 0.31.0 已发布，但仓库里没有 tag v0.31.0\n" }
          : null),
      });
      const status = runWriteback({ root: tree, version: "0.31.0", published: "0.31.0", deps, stateFile, dry: false, commit: false });
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      expect(status === EXIT.OK, "③b check:docs exit 2 / 仅 TAG_MISSING ⇒ 未判定，回写不判红（exit 0）",
        `③b 回写把「tag 还没打」判成了红：exit ${status}`);
      expect(state.phase === PHASE.WRITTEN,
        `③b 状态进到 written（tag 可以往下打；实测 phase=${state.phase}）`,
        `③b 状态没进 written（${JSON.stringify(state)}）——finalize 会被自己的顺序闸拦住`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // ③c issue #697：exit 2 但**不是** TAG_MISSING（或一处未判定标记都没读到）⇒ 仍然是红——「读不出」
  // 里只有「tag 还没打」这一种能在 writeback 阶段放过，否则 exit 2 就成了万能放行口。
  {
    for (const [name, stdout] of [
      ["别的未判定代码", "docs-drift-check: 未判定 OTHER_UNREADABLE — 某处真值缺位\n"],
      ["没有未判定标记", "docs-drift-check: 读不出 — 1 处真值缺位\n"],
    ]) {
      const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-wb-notjudged-"));
      const stateFile = path.join(tree, "state.json");
      try {
        writeFixtureTree(tree);
        writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
        const deps = fakeDeps({
          capture: (argv) => (argv.join(" ") === "npm run check:docs" ? { status: 2, stdout } : null),
        });
        const status = runWriteback({ root: tree, version: "0.31.0", published: "0.31.0", deps, stateFile, dry: false, commit: false });
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        expect(status === EXIT.RED && state.phase === PHASE.PUBLISHED_UNWRITTEN,
          `③c exit 2 且${name} ⇒ 红、状态留在 published_unwritten（不许拿 exit 2 当放行口）`,
          `③c ${name} 时 exit ${status}、phase=${state.phase}（期望 1 / ${PHASE.PUBLISHED_UNWRITTEN}）`);
      } finally {
        rmSync(tree, { recursive: true, force: true });
      }
    }
  }

  // ④ 顺序闸：没有回写就 finalize ⇒ 红，且一个 git tag / push 都不跑
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-order-"));
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      const deps = fakeDeps({ capture: gitPlumbing({ version: "0.31.0" }) });
      const status = runFinalize({ root: tree, version: "0.31.0", deps, stateFile: path.join(tree, "state.json"), dry: false });
      expect(status === EXIT.RED, "④ 没有回写就直接 finalize ⇒ 红（不许没发布就打 tag）", `④ finalize 的退出码是 ${status}`);
      expect(!deps.calls.some((line) => line.startsWith("git tag") || line.startsWith("git push")),
        "④ 顺序闸红的时候一个 `git tag` / `git push` 都没跑",
        `④ 顺序闸红了却动了 git：${deps.calls.filter((l) => l.startsWith("git tag") || l.startsWith("git push")).join(" | ")}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // ⑤ 两侧 ls-remote 不一致 ⇒ 红（并点名是哪一侧）
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-remote-"));
    const stateFile = path.join(tree, "state.json");
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      writeState(stateFile, { schema: 1, version: "0.31.0", phase: PHASE.WRITTEN, published: "0.31.0", updatedAt: "now" });
      const urls = ["https://github.com/ErixWong/erix-agent.git", "https://git.erix.vip/eric/erix-llm-kit.git"];
      const lagging = gitPlumbing({
        version: "0.31.0",
        urls,
        sides: {
          [urls[0]]: { main: "head0000000000000000000000000000000000000", tag: "cut00000000000000000000000000000000000000" },
          [urls[1]]: { main: "head0000000000000000000000000000000000000", tag: "old00000000000000000000000000000000000000" },
        },
      });
      const deps = fakeDeps({ capture: lagging });
      const status = runFinalize({ root: tree, version: "0.31.0", deps, stateFile, dry: false });
      expect(status === EXIT.RED, "⑤ 两侧 ls-remote 不一致（Gitea 的 tag 落后）⇒ 红", `⑤ 两侧不一致时退出码是 ${status}`);
      expect(deps.calls.filter((line) => line.startsWith("git ls-remote ")).length === 2,
        "⑤ 两个远端 URL 各 `git ls-remote` 了一次",
        `⑤ ls-remote 次数不是 2：${deps.calls.filter((l) => l.startsWith("git ls-remote ")).join(" | ")}`);

      // 对照组：两侧一致 ⇒ 绿
      const agreed = fakeDeps({ capture: gitPlumbing({ version: "0.31.0", urls }) });
      const okStatus = runFinalize({ root: tree, version: "0.31.0", deps: agreed, stateFile, dry: false });
      expect(okStatus === EXIT.OK, "⑤ 对照组：两侧一致 + 文档门禁绿 ⇒ finalize 绿", `⑤ 对照组退出码 ${okStatus}`);
      expect(agreed.calls.includes("git push origin main") && agreed.calls.includes("git push origin v0.31.0"),
        "⑤ 对照组双推了两个 ref（main + tag），且没有 `--force`",
        `⑤ 双推的 argv 不对：${agreed.calls.filter((l) => l.startsWith("git push")).join(" | ")}`);
      expect(!agreed.calls.some((line) => line.startsWith("git push") && line.includes("--force")),
        "⑤ 任何 `git push` 都没带 `--force`（main 有分支保护）",
        `⑤ 出现了 force-push：${agreed.calls.filter((l) => l.includes("--force")).join(" | ")}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // ⑥ `--dry` 一个字节都不写（对合成树前后对比 + 没有状态文件 + 没有任何写操作 argv）
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-dry-"));
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      const before = snapshotTree(tree);
      const deps = fakeDeps({ env: { PATH: "/usr/bin", HOME: "/nonexistent-home", ERIX_E2E_REAL: "1" }, capture: gitPlumbing({ version: "0.31.0" }) });
      const status = runAll({ root: tree, deps, stateFile: path.join(tree, "state.json"), dry: true, hosts: [DEFAULT_ROOT] });
      const changes = diffSnapshot(before, snapshotTree(tree));
      expect(changes.length === 0, "⑥ `--all --dry` 前后快照逐字相同（一个字节都不写）", `⑥ --dry 写了：${changes.join(", ")}`);
      expect(!existsSync(path.join(tree, "state.json")), "⑥ `--dry` 不写状态文件", "⑥ --dry 写了状态文件");
      const writes = deps.calls.filter((line) => line.includes("--sync") || line.startsWith("git tag") || line.startsWith("git push"));
      expect(writes.length === 0, "⑥ `--dry` 里没有 --sync / git tag / git push", `⑥ --dry 里出现了写操作：${writes.join(" | ")}`);
      expect(status === EXIT.AWAITING_PUBLISH, "⑥ `--all --dry` 停在人工发布那一步（exit 3）", `⑥ --all --dry 的退出码是 ${status}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // ⑦ `--sync` 的窄面（子进程 + 逐字节比对）
  selfTestSync(checker);

  // ⑧ 默认不 fork `npm publish`；`--publish-cmd` 是显式开关
  {
    const deps = fakeDeps();
    const status = runPublish({ root: DEFAULT_ROOT, version: "0.31.0", deps, dry: false });
    expect(deps.calls.length === 0 && status === EXIT.AWAITING_PUBLISH,
      "⑧ 默认 publish 阶段一个子进程都不起（只打操作单，exit 3）",
      `⑧ 默认 publish 起了子进程：${deps.calls.join(" | ")}（exit ${status}）`);
    const dryDeps = fakeDeps();
    const dryStatus = runPublish({ root: DEFAULT_ROOT, version: "0.31.0", deps: dryDeps, publishCmd: "echo publish", dry: true });
    expect(dryDeps.calls.length === 0 && dryStatus === EXIT.AWAITING_PUBLISH,
      "⑧ `--dry` 下即使给了 `--publish-cmd` 也不跑（什么都不发）",
      `⑧ --dry 下跑了：${dryDeps.calls.join(" | ")}（exit ${dryStatus}）`);
  }

  // ⑨ 状态文件的版本不匹配 ⇒ finalize 红（别人的状态不许授权这一版的 tag）
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-stale-"));
    const stateFile = path.join(tree, "state.json");
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      writeState(stateFile, { schema: 1, version: "0.30.0", phase: PHASE.WRITTEN, published: "0.30.0", updatedAt: "now" });
      const deps = fakeDeps({ capture: gitPlumbing({ version: "0.31.0" }) });
      const status = runFinalize({ root: tree, version: "0.31.0", deps, stateFile, dry: false });
      expect(status === EXIT.RED, "⑨ 状态文件是上一版（0.30.0）⇒ finalize 红", `⑨ 过期状态却放行了：exit ${status}`);
      expect(!deps.calls.some((line) => line.startsWith("git tag")), "⑨ 过期状态下一个 tag 都没打", `⑨ 打了 tag：${deps.calls.join(" | ")}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // ⑩ 回写没提交（工作树不干净）⇒ finalize 红（tag 不许指向一棵没写进历史的树）
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-dirty-"));
    const stateFile = path.join(tree, "state.json");
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      writeState(stateFile, { schema: 1, version: "0.31.0", phase: PHASE.WRITTEN, published: "0.31.0", updatedAt: "now" });
      const deps = fakeDeps({ capture: gitPlumbing({ version: "0.31.0", status: " M README.md\n" }) });
      const status = runFinalize({ root: tree, version: "0.31.0", deps, stateFile, dry: false });
      expect(status === EXIT.RED, "⑩ 工作树不干净 ⇒ finalize 红（回写没提交就不许打 tag）", `⑩ 脏树却放行了：exit ${status}`);
      expect(!deps.calls.some((line) => line.startsWith("git tag")), "⑩ 脏树下没打 tag", `⑩ 脏树却打了 tag：${deps.calls.join(" | ")}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // ⑬ 回写前工作树脏 ⇒ 红，且不写状态文件（回写提交不许夹带别人的改动）
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-wbdirty-"));
    const stateFile = path.join(tree, "state.json");
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      const deps = fakeDeps({ capture: gitPlumbing({ version: "0.31.0", status: " M README.md\n" }) });
      const status = runWriteback({ root: tree, version: "0.31.0", published: "0.31.0", deps, stateFile, dry: false });
      expect(status === EXIT.RED, "⑬ 回写前工作树脏 ⇒ 红（回写提交不许夹带别人的改动）", `⑬ 脏树上回写放行了：exit ${status}`);
      expect(!deps.calls.some((line) => line.includes("--sync")), "⑬ 脏树上没跑 --sync（一个字节都没写）",
        `⑬ 脏树上跑了 --sync：${deps.calls.join(" | ")}`);
      expect(!existsSync(stateFile), "⑬ 脏树红了不留状态文件（还没发布成功这一笔，不许留）",
        "⑬ 脏树上留了状态文件");
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // ⑫ tag 目标的运行时面与 HEAD 不一致 ⇒ 红（tag 不许指向一棵不是「产出这次发布」的树）
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-surface-"));
    const stateFile = path.join(tree, "state.json");
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      writeState(stateFile, { schema: 1, version: "0.31.0", phase: PHASE.WRITTEN, published: "0.31.0", updatedAt: "now" });
      const deps = fakeDeps({ capture: gitPlumbing({ version: "0.31.0", surfaceDiff: 1 }) });
      const status = runFinalize({ root: tree, version: "0.31.0", deps, stateFile, dry: false });
      expect(status === EXIT.RED, "⑫ 切版提交与 HEAD 的运行时面不一致 ⇒ finalize 红", `⑫ 运行时面不一致却放行了：exit ${status}`);
      expect(!deps.calls.some((line) => line.startsWith("git tag")), "⑫ 运行时面不一致时没打 tag", `⑫ 打了 tag：${deps.calls.join(" | ")}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // ⑪ `--all` 读到 phase=finalized ⇒ 什么都不再做（不重复打 tag / 推 / 回写）
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-done-"));
    const stateFile = path.join(tree, "state.json");
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      writeState(stateFile, { schema: 1, version: "0.31.0", phase: PHASE.FINALIZED, published: "0.31.0", updatedAt: "now" });
      const deps = fakeDeps({ capture: gitPlumbing({ version: "0.31.0" }) });
      const status = runAll({ root: tree, deps, stateFile, dry: false, version: "0.31.0" });
      expect(status === EXIT.OK && deps.calls.length === 0,
        "⑪ 状态文件说已经 finalize 完 ⇒ `--all` 一个子进程都不起（不重复打 tag / 推 / 回写）",
        `⑪ 已经 finalize 完还在动：exit ${status}，argv=${deps.calls.join(" | ") || "（无）"}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  console.log("release-day --self-test：离线反向证（合成树 / 假 runner，不联网、不装包、不碰 ~/.erix 与真实 ~/.npmrc）");
  for (const line of checker.passed) console.log(`  ✓ ${line}`);
  for (const line of checker.failures) console.log(`  ✗ ${line}`);
  if (checker.failures.length) {
    console.log(`\nrelease-day --self-test: 失败 — ${checker.failures.length}/${checker.passed.length + checker.failures.length} 条未达预期`);
    return EXIT.RED;
  }
  console.log(`\nrelease-day --self-test: OK — ${checker.passed.length} 条判据全部按预期（变异没落上也算失败）`);
  return EXIT.OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)) {
  process.exitCode = main();
}
