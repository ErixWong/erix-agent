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
// ── 三个阶段（`--stage`；`--all` 按序跑）───────────────────────────────────────
//   preflight  **已删除**（#961/#967 之后门禁全删）：`--stage preflight` 只打印一句
//              「preflight 已删除（#961/#967 之后门禁全删）」并 exit 0，不再跑任何前置。
//   publish    脚本**不 fork `npm publish`**（理由见下）。它把「请你自己在终端跑 `npm publish`」
//              与四条注意一次性打出来，然后 exit 3（= 等你发布）。`--publish-cmd <cmd>` 是**显式开关**，
//              默认关：不给就永不 fork。
//   writeback  发布成功之后**先提交回写、再打 tag**（顺序反过来就是 0.30.0 那一幕）。它做两件事：
//              ① 把回写提交掉（`git commit -a`，只提交已跟踪文件的改动）
//              ② 记 `phase=written`（状态文件）
//              旧的第①步 `node scripts/docs-drift-check.mjs --sync`（把发布态那几句写进文档）与旧的第③步
//              「立刻重跑 `npm run check:docs`」随门禁一起删了 ⇒ 文档里的发布态现在**由人改**，
//              这一步只做提交与记账，没有任何机器判据兜着。
//   finalize   清 `src/**/*.d.ts` → 打附注 tag `v<版本>`（指向**切版提交**，不指向回写提交；依据是
//              `git blame` 现读的 `package.json` version 行，先例 `v0.30.0`）→ 先 `git push origin v<版本>`
//              再 `git push origin main`（**先 tag 后 main**，理由见 finalize ④ 注释；`origin` 是双推：
//              GitHub + Gitea）→ 两个 URL 各 `git ls-remote` 现验（不一致就红）。
//              **永不 `--force`**：外面有没有闸门要现验（`gh api repos/<owner>/<repo>/rulesets`），
//              这里不抄它的结论——抄过一次「没有分支保护」，下一版就被远端拒了推送；推失败时
//              finalize ④ 让远端自己那句原文说话。真实危险在 `remote.origin.pushurl`：
//              两条各跑各的（GitHub 在前、Gitea 在后），而 mirror cron
//              `sync-erix-mirror.sh` 是关着的 ⇒ force-push 会改写 GitHub 上
//              **已发布**的历史，还可能只推上一侧、另一侧静默落后，
//              而唯一的探测器是 ⑤ 的 `git ls-remote` 互验——它跑在 push
//              之后。所以非快进必须让 push 自己失败。
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
//   `--dry` 一个字节都不写）。三个相位：`published_unwritten` → `written` → `finalized`。
//   **「publish 成功但回写失败」必须是可恢复状态而不是事故**：writeback 一进门就先把
//   `phase=published_unwritten` + `published=<版本>` 落盘，回写/提交任一红都把它留在盘上；
//   `--all` 重跑时读到这个相位就**从 writeback 续跑**（不再打 publish 操作单），
//   所以既不会重复发布，也不会把「已发布」忘在脑后。
//   **不许发生「tag 打出去了但文档还写着未发布」**：finalize 的顺序闸要求状态文件里
//   `phase=written`（= 回写已提交），并且要求工作树干净（回写没提交就不许打 tag）。
//
// ── 退出码（本仓惯例：读不出真值 / 未判定都不是绿）────────────────────────────────
//   0 = 这一阶段（或 `--all` 走到的阶段）完成了
//   1 = 有闸红了（回写红 / 顺序闸 / 两侧不一致）
//   2 = 未判定或参数不足（`--published` 没给、双推没法互验）
//   3 = **等你发布**（`--all` 的正常停点；发完用 `--stage writeback` 续跑）
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   npm run release:day -- --stage preflight                # 已删除：只打印一句话并 exit 0
//   npm run release:day -- --stage publish
//   npm run release:day -- --stage writeback --version <x.y.z> --published <x.y.z> [--published-date <YYYY-MM-DD>]
//   npm run release:day -- --stage finalize [--version <x.y.z>]
//   npm run release:day -- --all [--hosts …]          # 按序跑；publish 那一步是人工停点
//   npm run release:day -- --all --dry                # 什么都不改、什么都不发、不写盘
//   npm run release:day -- --self-test                # 离线反向证（合成树 / 假 runner，不联网、不装包）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
// 真模型端点闸门的读取与 e2e 那一族共用同一个点（issue #817：旧名 `ERIX_E2E_REAL` 已退役 ⇒ 闸门关着且这一步判红，不是未判定）。
// 告警接到本脚本的 `log()`：发版日那一行必须出现在操作者看得见的输出里，而 `--self-test` 要能离线断到它。
import { readRealGate, retiredGateMessage } from "../examples/e2e-real-gate.mjs";
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

/** 退出码（报告、自测、CI 共用一份）。 */
export const EXIT = Object.freeze({ OK: 0, RED: 1, NOT_JUDGED: 2, AWAITING_PUBLISH: 3 });

/** 一步的裁决：`pass` / `fail` / `not-judged`（未判定 ≠ 绿）。 */
export const VERDICT = Object.freeze({ PASS: "pass", FAIL: "fail", NOT_JUDGED: "not-judged" });

/** 阶段顺序（`--all` 按这个顺序走）。`preflight` 已随门禁全删（#961/#967）⇒ 只剩三个阶段。 */
export const STAGES = Object.freeze(["publish", "writeback", "finalize"]);

/** 状态文件的三个相位（顺序即纪律；`published_unwritten` 是「已发布、未回写」的可恢复态）。 */
export const PHASE = Object.freeze({
  PUBLISHED_UNWRITTEN: "published_unwritten",
  WRITTEN: "written",
  FINALIZED: "finalized",
});

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

/** 递归列出 `src/**\/*.d.ts`（生成物，finalize 前必须清掉；类型门禁已删，清掉只是为了不把生成物发出去）。 */
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
 * 门禁全删（#961/#967）之后只剩两步：① 提交回写 → ② 记 `phase=written`。
 * 文档里的发布态那几句（旧 ① 的 `docs-drift-check --sync`）与旧 ③ 的重跑 `check:docs` 一起删了，现在由人改。
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
      + "两者必须相等（发布行滞后于本仓版本的中间态现在没有机器判据，不在这里猜）");
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
  };
  if (!dry) {
    writeState(stateFile, { ...base, phase: PHASE.PUBLISHED_UNWRITTEN, writeback: { ok: false, why: "进行中" } });
    log(`状态：已发布 ${published}、**未回写** → 记进 ${stateFile}`);
    log("      （回写失败也不会丢；`--all` 重跑会从这个相位续跑，不会重复发布）");
  }

  if (dry) {
    log("writeback（--dry）：不提交、不写盘——一个字节都不写");
    return EXIT.OK;
  }

  // ① 提交回写（只提交已跟踪文件的改动：回写只改既有文档，不新建文件）
  const status = capture(["git", "status", "--porcelain"], { cwd: root, env });
  if (status.status !== 0) {
    log(`writeback ① → 红：读不出 \`git status --porcelain\`（exit ${status.status}）——不知道要提交什么就不提交`);
    return EXIT.RED;
  }
  const dirty = status.stdout.trim();
  let committed = false;
  if (!dirty) {
    log("writeback ① 回写后工作树没有改动（文档本来就是发布态）——跳过提交");
  } else if (!commit) {
    log("writeback ① `--no-commit`：改动留在工作树里，请自己提交后再 `--stage finalize`");
  } else {
    log(`writeback ① 提交回写：\`git commit -a -m "docs: release-day writeback — v${currentVersion} 发布态回写"\``);
    const commitResult = run(
      ["git", "commit", "-a", "-m", `docs(#689): release-day writeback — v${currentVersion} 发布态回写`],
      { cwd: root, env },
    );
    if (commitResult.status !== 0) {
      log(`writeback ① → **红**（exit ${commitResult.status}）——回写没提交成功`);
      writeState(stateFile, { ...base, phase: PHASE.PUBLISHED_UNWRITTEN, writeback: { ok: false, why: `commit exit ${commitResult.status}` } });
      return EXIT.RED;
    }
    committed = true;
  }

  writeState(stateFile, { ...base, phase: PHASE.WRITTEN, writeback: { ok: true, why: null } });
  log(`writeback → 绿：${committed ? "已提交" : "无需提交"}（状态 ${stateFile}：phase=${PHASE.WRITTEN}）——`
    + "文档里的发布态那几句本来由 `docs-drift-check --sync` 回写，门禁全删之后这一步只做提交与状态记账");
  return EXIT.OK;
}

// ─────────────────────────────── finalize ───────────────────────────────

/**
 * 收尾：清生成声明 → 打附注 tag（指向**切版提交**）→ 双推 → 两侧 `git ls-remote` 现验。（门禁全删之后不再跑文档门禁。）
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
    log("finalize → **红**（顺序闸）：要求状态文件里 `phase=written`（= 已发布 + 回写已提交），实测 "
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

  // ── ① 清 `src/**/*.d.ts`（生成物；不发出去就行） ──
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
          + "发布态回写与提交在 tag 之前已完成。", target],
        { cwd: root, env },
      );
      if (tagged.status !== 0) {
        log(`finalize ③ → 红：\`git tag\` exit ${tagged.status}`);
        return EXIT.RED;
      }
      log(`finalize ③ 附注 tag \`${tag}\` → ${target}`);
    }
  }

  // ── ④ 双推（`origin` = GitHub + Gitea；永不 --force：拦住它的是这条纪律，不是闸门） ──
  //    **先 tag 后 main**（261112）：远端为写回提交跑 CI 时要读得到本版 tag。tag 不在远端时，
  //    两个符号锚点用例的事实（过去由 `check:docs --verbose` 给出）读不出来、note 根本不打，于是它们红在
  //    「闸门读不出」上而不是红在自己要考的东西上。因果用 `git clone --no-tags` 复现过：同一对用例，
  //    红与绿只差那一个 tag。把顺序换回去 = 每发一版送一次「main 上一片红，红因与改动无关」的窗口。
  //    闸门现状（有没有 ruleset、要哪几条检查）**不抄在这里**：这里抄过一份「没有分支保护」，
  //    下一版就被远端拒了推送。现状要现验：`gh api repos/<owner>/<repo>/rulesets`。
  if (dry) {
    log(`finalize ④ （--dry）会先推 \`origin ${tag}\` 再推 \`origin main\`（不 force）`);
  } else {
    for (const ref of [tag, "main"]) {
      log(`finalize ④ \`git push origin ${ref}\`（双推：GitHub + Gitea；不 force）`);
      const pushed = run(["git", "push", "origin", ref], { cwd: root, env });
      if (pushed.status !== 0) {
        log(`finalize ④ → **红**：\`git push origin ${ref}\` exit ${pushed.status}。`);
        log("      下一步看上面那段远端自己打的原文（它比本脚本知道得多）：非快进就 `git fetch` → rebase →"
          + " 重跑；被仓库规则拒（GH013 / 「required status checks are expected」）则不是「必须走 PR」，"
          + "而是那个 sha 上检查缺席：同一个 sha 的必需检查跑绿之后直推就放行（261112 实测）。");
        log("      别拿 force 兜：两条 push URL 各跑各的（GitHub 在前、Gitea 在后）而 mirror cron 关着，"
          + "force 会改写 GitHub 上**已发布**的历史，还可能只推上一侧、另一侧静默落后（本脚本就是："
          + "GitHub 拒了 main、Gitea 已吃进去），而唯一的探测器是 ⑤ 的 `git ls-remote` 互验——它跑在 push 后。");
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

  if (dry) {
    log("finalize（--dry）：什么都没写、什么都没发、什么都没推");
    return EXIT.OK;
  }

  writeState(stateFile, {
    ...state,
    phase: PHASE.FINALIZED,
    updatedAt: nowIso(deps),
    finalize: { tag, tagTarget: target, head: headSha, remotes: seen.map((side) => side.url) },
  });
  log(`finalize → 绿：tag \`${tag}\` → ${target}，双推两侧一致`);
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
 *   · 其它                  ⇒ publish（人工停点）。
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

  // ── publish：人发布（脚本只打操作单）；`--published` 已给 ⇒ 人已经发布过了 ──
  if (published) {
    log(`--all：\`--published ${published}\` 已给（= 人已经发布过）→ 跳过 publish 操作单，直接 writeback`);
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
  if (opts.stage && opts.stage !== "preflight" && !STAGES.includes(opts.stage)) {
    opts.error = `\`--stage ${opts.stage}\` 不认识（合法：${STAGES.join(" / ")}；\`preflight\` 已随门禁删除，只打印一句话就退出）`;
  }
  if (!opts.stage && !opts.all && !opts.selfTest && !opts.help && !opts.error) {
    opts.error = "要么 `--stage <publish|writeback|finalize>`（`preflight` 已删除），要么 `--all`，要么 `--self-test`";
  }
  return opts;
}

export function main(argv = process.argv.slice(2), injected = null) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`release-day: ${opts.error}`);
    console.error("用法：node scripts/release-day.mjs --stage <publish|writeback|finalize> | --all | --self-test [--dry]");
    return EXIT.NOT_JUDGED;
  }
  if (opts.help) {
    console.log("用法：");
    console.log("  node scripts/release-day.mjs --stage preflight   # 已删除（门禁全删）：只打印一句话并 exit 0");
    console.log("  node scripts/release-day.mjs --stage publish [--publish-cmd <cmd>]");
    console.log("  node scripts/release-day.mjs --stage writeback --version <x.y.z> --published <x.y.z> [--published-date <YYYY-MM-DD>] [--no-commit]");
    console.log("  node scripts/release-day.mjs --stage finalize [--version <x.y.z>]");
    console.log("  node scripts/release-day.mjs --all [--dry] [--hosts …]");
    console.log("  node scripts/release-day.mjs --self-test");
    console.log("退出码：0 完成 / 1 红 / 2 未判定或参数不足 / 3 等你发布");
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
    deps.log("preflight 已删除（#961/#967 之后门禁全删）");
    return EXIT.OK;
  }
  if (opts.stage === "publish") {
    const version = opts.version ?? pkgVersion(root);
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

/** 合成树：回写 / 收尾那一族要读的那几份（离线、不联网、不碰真实 `~/.erix` 与 `~/.npmrc`）。 */
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

function runSelfTest() {
  const checker = makeChecker();
  const { expect } = checker;

  // ③ 回写失败（`git commit` 红）⇒ 整体非零 + 状态文件留下「已发布、未回写」+ `--all` 从 writeback 续
  {
    const tree = mkdtempSync(path.join(os.tmpdir(), "erix-release-day-wb-"));
    const stateFile = path.join(tree, "state.json");
    try {
      writeFixtureTree(tree);
      writeFileSync(path.join(tree, "package.json"), '{\n  "name": "erix-agent",\n  "version": "0.31.0"\n}\n', "utf8");
      const commitArgv = "git commit -a -m docs(#689): release-day writeback — v0.31.0 发布态回写";
      let statusCalls = 0;
      const failing = fakeDeps({
        // 回写前那一遍必须干净（否则走不到提交），回写后那一遍才有改动 ⇒ 提交红
        capture: (argv) => (argv.join(" ") === "git status --porcelain"
          ? { stdout: statusCalls++ === 0 ? "" : " M README.md\n" }
          : null),
        override: { [commitArgv]: { status: 1 } },
      });
      const status = runWriteback({ root: tree, version: "0.31.0", published: "0.31.0", deps: failing, stateFile, dry: false });
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      expect(status === EXIT.RED, "③ 回写提交失败 ⇒ 整体非零", `③ 回写失败时退出码是 ${status}`);
      expect(state.phase === PHASE.PUBLISHED_UNWRITTEN && state.published === "0.31.0",
        `③ 状态文件留下「已发布、未回写」（phase=${state.phase} / published=${state.published}）`,
        `③ 状态文件没留下可续跑的坐标：${JSON.stringify(state)}`);

      // 重跑：`--all` 读到 published_unwritten ⇒ 从 writeback 续，不再打 publish 操作单
      const resumed = fakeDeps({ capture: gitPlumbing({ version: "0.31.0" }) });
      const allStatus = runAll({ root: tree, deps: resumed, stateFile, dry: false, version: "0.31.0" });
      expect(resumed.calls.some((line) => line.startsWith("git tag -a v0.31.0")),
        "③ 续跑真的从 writeback 续到了 finalize（回写已完成 ⇒ 走到打 tag）",
        `③ 续跑没走到 tag：${resumed.calls.join(" | ")}`);
      expect(allStatus !== EXIT.AWAITING_PUBLISH, "③ 续跑不会回到「等你发布」（exit 3）",
        `③ 续跑又停在 publish（exit ${allStatus}）——那就等于要人再发一次`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
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
      expect(okStatus === EXIT.OK, "⑤ 对照组：两侧一致 ⇒ finalize 绿", `⑤ 对照组退出码 ${okStatus}`);
      expect(agreed.calls.includes("git push origin main") && agreed.calls.includes("git push origin v0.31.0"),
        "⑤ 对照组双推了两个 ref（main + tag），且没有 `--force`",
        `⑤ 双推的 argv 不对：${agreed.calls.filter((l) => l.startsWith("git push")).join(" | ")}`);
      expect(!agreed.calls.some((line) => line.startsWith("git push") && line.includes("--force")),
        "⑤ 任何 `git push` 都没带 `--force`（拦它的是脚本这条纪律，不是分支保护）",
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
      const deps = fakeDeps({ env: { PATH: "/usr/bin", HOME: "/nonexistent-home", ERIX_E2E_MODEL: "1" }, capture: gitPlumbing({ version: "0.31.0" }) });
      const status = runAll({ root: tree, deps, stateFile: path.join(tree, "state.json"), dry: true, hosts: [DEFAULT_ROOT] });
      const changes = diffSnapshot(before, snapshotTree(tree));
      expect(changes.length === 0, "⑥ `--all --dry` 前后快照逐字相同（一个字节都不写）", `⑥ --dry 写了：${changes.join(", ")}`);
      expect(!existsSync(path.join(tree, "state.json")), "⑥ `--dry` 不写状态文件", "⑥ --dry 写了状态文件");
      const writes = deps.calls.filter((line) => line.startsWith("git tag") || line.startsWith("git push") || line.startsWith("git commit"));
      expect(writes.length === 0, "⑥ `--dry` 里没有 git tag / git push / git commit", `⑥ --dry 里出现了写操作：${writes.join(" | ")}`);
      expect(status === EXIT.AWAITING_PUBLISH, "⑥ `--all --dry` 停在人工发布那一步（exit 3）", `⑥ --all --dry 的退出码是 ${status}`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

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
      expect(!deps.calls.some((line) => line.startsWith("git commit")), "⑬ 脏树上没跑 git commit（一个字节都没写）",
        `⑬ 脏树上跑了 git commit：${deps.calls.join(" | ")}`);
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
