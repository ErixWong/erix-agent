#!/usr/bin/env node
// version-state-probe.mjs — issue #703：把「当前版本的三个合法发布态」做成**可复跑**的探针
//
// 工单要的东西：`docs-drift-check --self-test` 里「当前版本」这一维过去只能靠**改 package.json** 模拟，
// 于是「切版了但没发布 / 发布了但没打 tag / 发布完成」这三个**都合法**的态在自测里一个都跑不出来，
// 而 CI 的阻断项恰好是那个自测。本脚本不往自测里塞用例（一条自测例子的成本 = 整趟 198 例），
// 而是把三态做成一条独立命令：**机械合成树 → 逐态跑真判据 → 断言退出码与点名的代号**。
//
// ── 三个态（同一棵合成树，只差「发布态回写 + tag 面 + registry 桩」三个事实）────────────────
//   S1 切版未发布   package.json = 下一版 / 发布行 = 上一版 / 段首 = `## [下一版]（未发布 / unpublished）`（**无日期**）
//                   registry latest = 上一版，tag 面**没有** v下一版         ⇒ `--self-test` 与 `--strict` 都必须 **exit 0**
//   S2 已发布未打 tag 发布行 = 下一版 / 段首带日期 / registry latest = 下一版，**没有** v下一版
//                                                          ⇒ 判定 **exit 2** 且点名 `TAG_MISSING`（未判定 ≠ 红，#697 ③）
//   S3 发布完成     同 S2，但**有**附注 tag `v下一版`，tagger date = 段首那一天
//                                                          ⇒ **exit 0**
//   矛盾态（反向证） 文档说「已发布 = 下一版」而 registry 桩说 latest 还是上一版
//                                                          ⇒ **exit 1** 且点名 `published-claim`
//                                                            （这一条是 #210 R2 的「变异不落上算失败」：
//                                                             三态如果全绿而矛盾态不红，说明注入根本没生效）
//
// ── 为什么 S3 是「桩真的被读了」的证 ────────────────────────────────────────────────
// 真 registry 现在只到 `0.30.0`。S3 的树里文档声称「已发布 = 0.31.0」，如果 `--registry-json` 没落上，
// 判据就会拿真 registry 的 `0.30.0` 去对账 ⇒ `published-claim` 红 ⇒ S3 不可能 exit 0。
// 所以「S3 = 0」这一条同时证了两件事：桩被读到 + 判据读的是桩而不是网络。
//
// ── 合成树的配方（**机械**，不许人肉 cp -a；人肉配方两次得出过不可比的读数）───────────────
//   1. `git -C <本仓> ls-files -z` 的**入库清单**逐文件复制到 `.scratch/version-states/<state>/`（保留 mode）；
//      ⇒ 判据的扫描面（它自己就是 `git ls-files` 取清单）与真树同形。
//   2. `git init` + `git add -A` + 一次 commit（固定身份与日期）——**不复用本仓的 `.git`**：
//      本仓是 worktree，`.git` 是个指针文件，`cp -a` 之后合成树的 `git ls-files` / `for-each-ref` 仍然读
//      **原 worktree 的 index 与 refs**：tag 面失控（实测凭空多出 `v0.31.0`，而 S1 要求「无 tag」），
//      且本仓 index 里每多一个新文件、合成树磁盘上就少一个 ⇒ `read()` ENOENT 直接崩
//      （实测 `/tmp/p703/S1-selftest-fixed.log`）。独立小仓 ⇒ 磁盘与 index 自洽，tag 随便建删都不碰主仓。
//   3. `package.json` 的 version 置为下一版（**这一维唯一要模拟的事实**）。
//   4. 发布态回写走本仓自己的窄面：在合成树里跑 `node scripts/docs-drift-check.mjs --sync --published <发布行>
//      [--published-date D]` —— 当前版本句、AGENTS 两句、§4 阶段表 current 行、CHANGELOG 段首那一行
//      一次写齐，不手改任何一个字节（手改 = 第二次实现一遍回写规则，它会漂移）。
//   5. tag 面：为「已发布段」（= CHANGELOG 里带日期且没标未发布的段）逐个建附注 tag，tagger date = 该段日期；
//      登记在 `CHANGELOG_DATE_TAG_EXEMPTIONS` 里的版本**错开一天**（否则登记表空转 ⇒ 那条反向证会红，
//      红得与本次探针无关）。要「缺 tag」的态就不建那一个。
//   6. registry 桩：`--registry-json <file>`（issue #703 给 `docs-drift-check.mjs` 加的注入口子），
//      `versions` 从合成树的 CHANGELOG 现派生（与自测的 `selfTestRegistry` 同一规则），latest 逐态给。
//
// 只读不改本仓：合成树落在 `.scratch/`（已登记的 scratch 目录类），探针一个字节都不写入库文件。
//
// 用法：
//   node scripts/version-state-probe.mjs                 # 四个态全跑（含 S1 的整趟 --self-test，约 7 分钟）
//   node scripts/version-state-probe.mjs --fast          # 跳过 S1 的整趟自测（只跑逐态判定，秒级）
//   node scripts/version-state-probe.mjs --only S2,S3    # 只跑某几个态
//   node scripts/version-state-probe.mjs --date 2026-11-04 --keep
//
// 退出码：0 = 四个态都达预期；1 = 有态不达预期（反向证没红也算）；2 = 事实缺位（读不到 / 合成树建不起来）。
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const FAST = argv.includes("--fast");
const KEEP = argv.includes("--keep");
const flagValue = (name, dflt = null) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : dflt;
};
const OUT = path.resolve(flagValue("--out", path.join(ROOT, ".scratch", "version-states")));
const GIT_ID = {
  GIT_AUTHOR_NAME: "version-state-probe", GIT_AUTHOR_EMAIL: "probe@invalid",
  GIT_COMMITTER_NAME: "version-state-probe", GIT_COMMITTER_EMAIL: "probe@invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00 +0800", GIT_COMMITTER_DATE: "2026-01-01T00:00:00 +0800",
};

const fail = (msg) => { console.error(`version-state-probe: ${msg}`); process.exit(2); };

// ── 事实：从**本仓**现读，一个版本号都不写死 ────────────────────────────────────────────
const cmpSemver = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); }
  return 0;
};
/** UTC+8 日历日（本仓发版时区，与 `docs-drift-check.mjs` 的 `todayUtc8` 同一算法）。 */
const todayUtc8 = () => new Date((Math.floor(Date.now() / 1000) + 8 * 3600) * 1000).toISOString().slice(0, 10);
/** 日期 +N 天（纯日历算术，不碰时区）。 */
const shiftDay = (date, days) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
};

const pkgVersion = (() => {
  try { return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version; }
  catch (e) { return fail(`读不出 ${ROOT}/package.json 的 version（${/** @type {{message?: string}} */ (e)?.message}）`); }
})();
if (!/^\d+\.\d+\.\d+$/.test(String(pkgVersion))) fail(`package.json 的 version=${pkgVersion} 不是 x.y.z`);

/** CHANGELOG 的版本段：`{version, date|null, unpublished}`（`## [x.y.z]` + 可选 ` - YYYY-MM-DD` + 可选未发布标记）。 */
function changelogSections(text) {
  const out = [];
  for (const m of text.matchAll(/^##\s*\[(\d+\.\d+\.\d+)\]([^\n]*)$/gm)) {
    const rest = m[2] ?? "";
    const date = /(\d{4}-\d{2}-\d{2})/.exec(rest)?.[1] ?? null;
    out.push({ version: m[1], date, unpublished: /未发布|unpublished/i.test(rest) });
  }
  return out;
}
const srcSections = changelogSections(
  (() => {
    try { return readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"); }
    catch (e) { return fail(`读不出 ${ROOT}/CHANGELOG.md（${/** @type {{message?: string}} */ (e)?.message}）`); }
  })());
/** 要切的那一版：CHANGELOG 里**高于 `package.json`** 的最高段（0.31.0）。 */
const nextVersion = srcSections.map((s) => s.version)
  .filter((v) => cmpSemver(v, pkgVersion) > 0).sort(cmpSemver).at(-1);
if (!nextVersion) {
  fail(`本仓 CHANGELOG 里没有高于 package.json（${pkgVersion}）的版本段 ⇒ 「切版未发布」（S1）没有落脚处。`
    + "这一版发布之后，请在下一次切版（CHANGELOG 出现新的更高段）之后再跑本探针。");
}
/** 登记为「历史日期与 tag 不一致」的版本（不写死名单：读 `docs-drift-check.mjs` 里那一处常量）。 */
const exemptVersions = (() => {
  const src = readFileSync(path.join(ROOT, "scripts", "docs-drift-check.mjs"), "utf8");
  const block = /const CHANGELOG_DATE_TAG_EXEMPTIONS = \[([\s\S]*?)\n\];/.exec(src);
  if (!block) fail("读不到 scripts/docs-drift-check.mjs 里的 CHANGELOG_DATE_TAG_EXEMPTIONS ⇒ 探针无法保证登记表不空转");
  return [...block[1].matchAll(/version:\s*"(\d+\.\d+\.\d+)"/g)].map((m) => m[1]);
})();
/** 发布日期：`--sync` 的缺省口径就是「当天 UTC+8」；这里显式传，好让 tag 的 tagger date 能对齐它。 */
const RELEASE_DATE = flagValue("--date", todayUtc8());
if (!/^\d{4}-\d{2}-\d{2}$/.test(RELEASE_DATE)) fail(`--date ${RELEASE_DATE} 不是 YYYY-MM-DD`);

/**
 * registry 的 `versions` 列表：真值是 **npm**，不是 CHANGELOG。
 * 为什么不在这里推：CHANGELOG 里「带日期」与「已发布」不是同一件事——`0.21.0` 与 `0.24.0` 两段都有日期
 * 却**从未发布**（README/AGENTS 里有这三处声称），拿 CHANGELOG 派生 versions 会让桩自己把
 * 「从未发布」说成假话 ⇒ `published-claim` 判红四处，与本次探针要证的东西无关（实测：首轮 S1/S3 各红 4 处）。
 * 取一次现读的真名单当底，逐态只改 `latest`（以及「已发布」那一态多一个下一版）。
 * 取不到 ⇒ 当场 exit 2（探针需要 registry 真值；这与 CI 本来就能联网的口径一致）。
 */
const REGISTRY_PKG = (() => {
  try { return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).name; }
  catch { return "erix-agent"; }
})();
const REAL_REGISTRY = (() => {
  const r = run("npm", ["view", REGISTRY_PKG, "versions", "dist-tags", "--json"], { timeout: 60000 });
  if (r.code !== 0) fail(`读不到 registry（npm view ${REGISTRY_PKG} versions dist-tags）：${r.out.trim().slice(0, 200)}`
    + " ——探针需要一份真的 versions 名单（「从未发布」那几段的真值只在这里）");
  let j;
  try { j = JSON.parse(r.out); } catch (e) { return fail(`registry 返回解不开（${/** @type {{message?: string}} */ (e)?.message}）`); }
  const versions = (Array.isArray(j?.versions) ? j.versions : [j?.versions].filter(Boolean)).filter((v) => typeof v === "string");
  const latest = j?.["dist-tags"]?.latest ?? null;
  if (!latest || !versions.length) fail(`registry 返回里没有 dist-tags.latest / versions（实测 ${r.out.trim().slice(0, 120)}）`);
  return { latest, versions };
})();
if (!REAL_REGISTRY.versions.includes(pkgVersion)) {
  fail(`registry 的 versions 里没有本仓的 ${pkgVersion}——发布态探针的前提不成立（本仓版本要么已发布，要么就是待切的下一版）`);
}
if (REAL_REGISTRY.versions.includes(nextVersion)) {
  fail(`registry 里已经有 ${nextVersion}——这一版已经发出去了，S1「切版未发布」在今天的 registry 上不是合法态；`    + "请把本探针跑在下一次切版与发布之间，或先把下一版改成更高的那个未发版");
}

// ── 合成树 ──────────────────────────────────────────────────────────────────────────
function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", timeout: opts.timeout ?? 120000, ...opts });
  if (r.error) fail(`${cmd} ${cmdArgs.join(" ")} 跑不起来：${r.error.message}`);
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const git = (dir, ...a) => run("git", ["-C", dir, ...a], { env: { ...process.env, ...GIT_ID } });
/** 附注 tag 的 tagger date = 第二个参数（git 认 `GIT_COMMITTER_DATE`，实测与 `%(taggerdate:raw)` 一致）。 */
const gitTagDated = (dir, version, day) => run("git", ["-C", dir, "tag", "-a", "-m", `synthetic ${version}`, `v${version}`, "HEAD"],
  { env: { ...process.env, ...GIT_ID, GIT_COMMITTER_DATE: `${day} 12:00:00 +0800` } });

/** 入库清单（含可执行位）；与判据自己取扫描面的那条命令同源，不另发明一套「什么算入库」。 */
function trackedFiles() {
  const r = run("git", ["-C", ROOT, "ls-files", "-z"]);
  if (r.code !== 0) fail(`git -C ${ROOT} ls-files 失败：${r.out.trim()}`);
  return r.out.split("\0").filter(Boolean);
}

function buildTree(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = trackedFiles();
  for (const rel of files) {
    const src = path.join(ROOT, rel);
    if (!existsSync(src)) continue;         // index 里有、磁盘上没有（半删除态）：合成树不需要
    const dst = path.join(dir, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    try { chmodSync(dst, statSync(src).mode & 0o777); } catch { /* 只读文件系统上无所谓 */ }
  }
  if (!files.length) fail(`git ls-files 返回空清单（${ROOT}）⇒ 合成树会是空树`);
  const init = git(dir, "init", "-q", "--initial-branch=main");
  if (init.code !== 0) fail(`合成树 git init 失败：${init.out.trim()}`);
  git(dir, "add", "-A");
  const commit = git(dir, "commit", "-q", "-m", "version-state-probe: synthetic tree");
  if (commit.code !== 0) fail(`合成树首次 commit 失败：${commit.out.trim()}`);
  return { files: files.length };
}

/** 把 `package.json` 的 version 换成要切的那一版（只动那一行，别重排 JSON）。 */
function setVersion(dir, version) {
  const p = path.join(dir, "package.json");
  const text = readFileSync(p, "utf8");
  const next = text.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
  if (next === text) fail(`${p} 里找不到 "version" 那一行 ⇒ 无法把树切成 ${version}`);
  writeFileSync(p, next, "utf8");
}

/** 发布态回写：走本仓自己的窄面（`--sync`），不手改任何字节。 */
function stampReleaseState(dir, { published, date }) {
  const a = ["scripts/docs-drift-check.mjs", "--sync", "--published", published];
  if (date) a.push("--published-date", date);
  const r = run(process.execPath, a, { cwd: dir, timeout: 300000 });
  if (r.code !== 0) fail(`合成树里的发布态回写没成（exit ${r.code}）：\n${r.out.trim().split("\n").slice(0, 12).join("\n")}`);
  return r.out;
}

/**
 * tag 面：给「已发布段」（带日期、没标未发布）逐个建附注 tag，tagger date = 该段日期；
 * 登记表里的版本错开一天（让 `CHANGELOG_DATE_TAG_EXEMPTIONS` 保持**在用**，不然那条空转反向证会红）。
 * `omit` 里列的版本**不建**（= 「已发布但缺 tag」那一半事实）。
 */
function writeTags(dir, { omit = [] } = {}) {
  const sections = changelogSections(readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"))
    .filter((s) => s.date && !s.unpublished);
  const made = [];
  for (const s of sections) {
    if (omit.includes(s.version)) continue;
    const day = exemptVersions.includes(s.version) ? shiftDay(String(s.date), 1) : s.date;
    const r = gitTagDated(dir, s.version, String(day));
    if (r.code !== 0) fail(`合成树建 tag v${s.version} 失败：${r.out.trim()}`);
    made.push({ version: s.version, day: String(day) });
  }
  return made;
}

/** 树里的事实（**落没落上**的判据就靠它，不靠日志里有没有回显）。 */
function treeFacts(dir) {
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version;
  const sections = changelogSections(readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"));
  const agents = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  const tagsRaw = git(dir, "for-each-ref", "refs/tags", "--format=%(refname:short)%09%(objecttype)%09%(taggerdate:iso8601)").out;
  const tags = new Map();
  for (const line of tagsRaw.split("\n")) {
    const [ref, kind, date] = line.split("\t");
    const m = /^v(\d+\.\d+\.\d+)$/.exec(ref ?? "");
    if (m) tags.set(m[1], { kind, date });
  }
  return {
    pkgVersion: pkg,
    nextSection: sections.find((s) => s.version === nextVersion) ?? null,
    publishedClaims: [...agents.matchAll(/\bdist-tags\.latest\b[^\n]*?`(\d+\.\d+\.\d+)`/g)].map((m) => m[1]),
    tags,
  };
}

// ── 四个态 ──────────────────────────────────────────────────────────────────────────
/** @typedef {{id:string,title:string,published:string|null,date:boolean,omitTags:string[],stubLatest:string,expectCode:number,mustName?:string,runSelfTest?:boolean}} State */
/** @type {State[]} */
const STATES = [
  {
    id: "S1", title: "切版未发布（段首无日期 + 无 tag + registry 还是上一版）",
    published: pkgVersion, date: false, omitTags: [nextVersion], stubLatest: pkgVersion,
    expectCode: 0, runSelfTest: !FAST,
  },
  {
    id: "S2", title: "已发布未打 tag（registry 已到下一版，tag 缺）",
    published: nextVersion, date: true, omitTags: [nextVersion], stubLatest: nextVersion,
    expectCode: 2, mustName: "TAG_MISSING",
  },
  {
    id: "S3", title: "发布完成（tag 在，且 tagger date = 段首日期）",
    published: nextVersion, date: true, omitTags: [], stubLatest: nextVersion,
    expectCode: 0,
  },
  {
    id: "contradiction", title: "矛盾态反向证：文档说已发布 = 下一版，registry 桩说 latest 还是上一版",
    published: nextVersion, date: true, omitTags: [], stubLatest: pkgVersion,
    expectCode: 1, mustName: "published-claim",
  },
];
const ONLY = (flagValue("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const states = ONLY.length ? STATES.filter((s) => ONLY.includes(s.id)) : STATES;
if (!states.length) fail(`--only ${ONLY.join(",")} 里没有一个已知态（可选：${STATES.map((s) => s.id).join("/")}）`);

/** 逐态的 registry 桩内容：底 = 真名单；「已发布」那一侧多一个下一版。 */
function versionsFor(latest) {
  if (latest === REAL_REGISTRY.latest) return [...REAL_REGISTRY.versions];
  if (cmpSemver(latest, REAL_REGISTRY.latest) > 0) {
    return [...REAL_REGISTRY.versions, latest].sort(cmpSemver);
  }
  return [...REAL_REGISTRY.versions].sort(cmpSemver);
}

// ── 开跑 ────────────────────────────────────────────────────────────────────────────
const FIXTURES = path.join(OUT, "fixtures");
mkdirSync(FIXTURES, { recursive: true });
console.log(`version-state-probe（issue #703）：本仓 ${pkgVersion} → 要切的下一版 ${nextVersion}，发布日 ${RELEASE_DATE}`);
console.log(`  registry 实测：latest=${REAL_REGISTRY.latest}，versions ${REAL_REGISTRY.versions.length} 个（桩在这个底上只改 latest / 加下一版）`);
console.log(`  登记表里错开一天的版本：${exemptVersions.join(" / ") || "（无）"}`);
console.log(`  合成树根：${OUT}${FAST ? "  [--fast：跳过 S1 的整趟 --self-test]" : ""}\n`);

const problems = [];
/** 一条断言：落不上就记进 problems（**变异不落上算失败**，不许静默跳过）。 */
function assert(ok, what, detail = "") {
  console.log(`    ${ok ? "✓" : "✗"} ${what}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) problems.push(`${what}${detail ? `（${detail}）` : ""}`);
  return ok;
}

for (const state of states) {
  const dir = path.join(OUT, state.id);
  console.log(`── ${state.id}：${state.title}`);
  const built = buildTree(dir);
  setVersion(dir, nextVersion);
  stampReleaseState(dir, { published: String(state.published), date: state.date ? RELEASE_DATE : null });
  const tags = writeTags(dir, { omit: state.omitTags });

  // registry 桩：versions = 真 registry 的名单（+ 已发布那一态的下一版），latest 逐态给
  const versions = versionsFor(state.stubLatest);
  const stub = { latest: state.stubLatest, versions, note: `version-state-probe ${state.id}（issue #703）` };
  const stubPath = path.join(FIXTURES, `${state.id}.json`);
  writeFileSync(stubPath, `${JSON.stringify(stub, null, 2)}\n`, "utf8");

  // ① 事实落没落上（**先证树，再谈判定**；这一步不绿，后面的退出码就没有意义）
  const facts = treeFacts(dir);
  console.log(`  [落事实] 入库清单 ${built.files} 个文件 · package.json=${facts.pkgVersion} · 发布行声称 ${facts.publishedClaims.join("/") || "（读不到）"} · tag ${[...facts.tags.keys()].length} 枚`);
  assert(facts.pkgVersion === nextVersion, `package.json 是本要切的 ${nextVersion}`, `实测 ${facts.pkgVersion}`);
  assert(Boolean(facts.nextSection), `CHANGELOG 里有 ${nextVersion} 段`);
  if (state.date) {
    assert(facts.nextSection?.date === RELEASE_DATE && !facts.nextSection?.unpublished,
      `段首是「已发布带日期 ${RELEASE_DATE}」形状`, `实测 ${JSON.stringify(facts.nextSection)}`);
  } else {
    assert(facts.nextSection?.date === null && facts.nextSection?.unpublished === true,
      "段首是「未发布且**无日期**」形状（#697 ①）", `实测 ${JSON.stringify(facts.nextSection)}`);
  }
  assert(facts.publishedClaims.length > 0 && facts.publishedClaims.every((v) => v === state.published),
    `AGENTS 的发布行声称 = ${state.published}`, `实测 ${facts.publishedClaims.join("/") || "（读不到）"}`);
  assert(state.omitTags.length === 0 || state.omitTags.every((v) => !facts.tags.has(v)),
    state.omitTags.length ? `tag 面**没有** v${state.omitTags.join(" / v")}` : "tag 面不缺任何已发布段的 tag",
    `实测缺了：${state.omitTags.filter((v) => facts.tags.has(v)).join(",")}`);
  if (state.id === "S3" || state.id === "contradiction") {
    assert(facts.tags.has(nextVersion), `tag 面**有** v${nextVersion}`);
    if (state.id === "S3") {
      assert(String(facts.tags.get(nextVersion)?.date ?? "").slice(0, 10) === RELEASE_DATE,
        `v${nextVersion} 的 tagger date = ${RELEASE_DATE}（#697 的「已发布段日期 ↔ tag 日期」要它相等）`,
        `实测 ${facts.tags.get(nextVersion)?.date}`);
    }
  }
  assert(tags.length > 0, "已发布段的 tag 建出来了（登记表才不会空转）", `实测 ${tags.length} 枚`);

  // ② 判定：跑真判据（不是自测夹具），旗标就是 CI 用的那一套
  const judgeArgs = ["scripts/docs-drift-check.mjs", "--strict", "--registry-json", stubPath];
  console.log(`  [判定] cwd=${dir}\n         $ node ${judgeArgs.join(" ")}`);
  const judged = run(process.execPath, judgeArgs, { cwd: dir, timeout: 900000 });
  const body = judged.out;
  const named = state.mustName ? body.includes(state.mustName) : true;
  assert(judged.code === state.expectCode,
    `exit ${state.expectCode}（${state.expectCode === 0 ? "绿" : state.expectCode === 2 ? "未判定" : "红"}）`,
    `实测 exit ${judged.code}`);
  if (state.mustName) assert(named, `点名 ${state.mustName}`, "输出里找不到那个代号 ⇒ 注入没落上，或红的不是那一条");
  if (state.expectCode === 0 && body.includes("读不出")) {
    assert(false, "绿的那一态里不许混进「读不出」", body.split("\n").filter((l) => l.includes("读不出")).join(" / "));
  }
  if (judged.code !== state.expectCode || !named) {
    console.log(body.split("\n").slice(0, 40).map((l) => `         │ ${l}`).join("\n"));
  }

  // ③ S1 还要跑整趟自测（CI 的阻断项就是它）
  if (state.runSelfTest) {
    const selfArgs = ["scripts/docs-drift-check.mjs", "--self-test", "--registry-json", stubPath];
    console.log(`  [自测] $ node ${selfArgs.join(" ")}   （整趟，约 6 分钟）`);
    const st = run(process.execPath, selfArgs, { cwd: dir, timeout: 1500000 });
    const m = /—\s*(\d+)\s*例反向证/.exec(st.out);
    assert(st.code === 0, "`--self-test` exit 0（切版树上的 CI 阻断项）", `实测 exit ${st.code}`);
    assert(Boolean(m), "自测报了条数（「OK — N 例」）", st.out.trim().split("\n").slice(-1)[0]);
    if (m) console.log(`         → ${st.out.trim().split("\n").slice(-1)[0]}`);
    else console.log(st.out.split("\n").slice(-30).map((l) => `         │ ${l}`).join("\n"));
  }
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
  console.log("");
}

console.log(`registry 桩留在：${FIXTURES}（${states.map((s) => `${s.id}.json latest=${s.stubLatest}`).join("，")}）`);
if (problems.length) {
  console.log(`\nversion-state-probe: 失败 — ${problems.length} 项未达预期`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`version-state-probe: OK — ${states.length} 个发布态（${states.map((s) => s.id).join("/")}）全部达预期，`
  + `含矛盾态反向证${FAST ? "（--fast：S1 的整趟 --self-test 未跑）" : "与 S1 的整趟 --self-test"}`);
process.exit(0);
