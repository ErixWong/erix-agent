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
// ── 「当前版」从哪来（第二轮修的就是这里：探针自己不许是「宿主版本相关」的）───────────────
// 第一版把「当前版」从**跑它的那棵树**的 `package.json` + CHANGELOG 里推（「高于 package.json 的最高段」），
// 于是它只能在**切版前**的树上工作：宿主一一切到下一版，「高于本版的那一段」就不存在了 ⇒ 探针 exit 2、
// 而 `npm test` 里那条测试同时红（= 本单要消灭的那种「宿主版本相关」的病，长在自己身上）。
// 现在这一维由**三条来源**决定，都不依赖跑它的那棵树恰好停在哪一版：
//   · `--next <x.y.z>` / `--previous <x.y.z>`：**参数给的**（该段必须真的在 `--src` 的 CHANGELOG 里，
//     探针不替你造段 —— 造段 = 第二份发布态回写规则，它会漂移）。
//   · `--src <dir>`：**合成宿主给的** —— 事实（`package.json` 版本、CHANGELOG 段面、tag 面、登记表）
//     全部从这棵树现读；缺省 = 本脚本所在的仓根。
//   · 两者都不给 ⇒ 从 `--src` 现推：`要切的那一版` = **未发布且不低于该树 `package.json`** 的最高段，
//     `上一版` = 该树 CHANGELOG 里**已发布**（带日期且没标未发布，未发布标记与判据 3 同口径：段首行或正文前三行）
//     且低于它的最高段。**推不出来就是未判定 exit 2 并点名代号**（`NO_INFLIGHT_SECTION` /
//     `NO_PREVIOUS_RELEASE`），绝不静默绿：发布当天回写之后、下一次切版之前，树上确实没有「正在切的那一版」，
//     那一刻这条探针就没有可判的东西 —— 那是事实，不是红灯。
//
// ── registry 基线（`versions` 名单）从哪来 ──────────────────────────────
//   · 缺省 = `npm view` 现读（真值；拿不到 = exit 2 点名 `REGISTRY_UNREADABLE`，因为「从未发布」那几段
//     的真值只在 registry：`0.21.0` / `0.24.0` / `0.27.0` 在 CHANGELOG 里有段，在 npm 上没有）。
//   · `--registry-base auto` = 从 `--src` 的 CHANGELOG **机械现推**（已发布 = 带日期且没标未发布，与判据 3
//     同一口径）⇒ 离线可跑、可复现；输出里会写「来源：合成」，**不冒充**真 registry。
//   · `--registry-base <file>` = 一份 `{"latest":…, "versions":[…]}`，读不出 = exit 2。
//   三种来源都要过两道合法性闸：`上一版 ∈ versions`（S1/S2/S3 的「已发布」那一半得有真值）与
//   `要切的那一版 ∉ versions`（已发出去的版本上「切版未发布」不是合法态）。
//
// ── 为什么 S3 是「桩真的被读了」的证 ────────────────────────────────────────────────
// S3 的树里文档声称「已发布 = 要切的那一版」，而基线里没有它；如果 `--registry-json` 没落上，
// 判据就会拿基线的 `latest`（= 上一版）去对账 ⇒ `published-claim` 红 ⇒ S3 不可能 exit 0。
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
//      自测（`--self-test`）例外：那一族合成树的**版本面**由自测自己造（见下一节），不从宿主抄。
//   4. 发布态回写走本仓自己的窄面：在合成树里跑 `node scripts/docs-drift-check.mjs --sync --published <发布行>
//      [--published-date D]` —— 当前版本句、AGENTS 两句、§4 阶段表 current 行、CHANGELOG 段首那一行
//      一次写齐，不手改任何一个字节（手改 = 第二次实现一遍回写规则，它会漂移）。
//   5. tag 面：为「已发布段」（= CHANGELOG 里带日期且没标未发布的段）逐个建附注 tag，tagger date = 该段日期；
//      登记在 `CHANGELOG_DATE_TAG_EXEMPTIONS` 里的版本**错开一天**（否则登记表空转 ⇒ 那条反向证会红，
//      红得与本次探针无关）。要「缺 tag」的态就不建那一个。
//   6. registry 桩：`--registry-json <file>`（issue #703 给 `docs-drift-check.mjs` 加的注入口子），
//      `versions` = 上面那一节的基线（真读 / auto 现推 / 文件），latest 逐态给。
//
// ── `--self-test` 的版本面由**自测自己造**（issue #713：宿主树只当模板）────────────────────────
// 病根（#713 现场）：`--self-test` 原先也走上面第 3 条——把宿主树的 `package.json` / CHANGELOG 段面
// 原样抄进夹具，于是「要切的那一版」仍然**从宿主推**：在「发版回写之后、下一次切版之前」的树上
// （本仓 0.31.0 发布后的常态）根本没有「未发布且不低于 package.json」的段 ⇒ 整批 exit 2，
// 而测试文件的文件头把这 13 例写成「全在机械合成的宿主上跑」。也就是说自证词与实况不符：病没消，
// 只是从「当前版」挪到了「正在切的那一版」（#703 第二轮的缺口 B 换个位置复发）。
// 现在自测先造一棵**合成种子宿主**（`<out>/.selftest-seed`）：
//   · 入库清单与其余文档仍从宿主树机械复制（判据的扫描面必须与真树同形，这一半不能凭空造）；
//   · **版本面**由自测合成：`要切的那一版` = 种子里**已发布段**（带日期且没标未发布）的最高一版，
//     `上一版` = 低于它的最高已发布段；高于它的段整段摘掉（那些是「夹具这一版之后的事」）；
//     `package.json` 置为要切的那一版；段首的「未发布」形状走本仓自己的窄面
//     （`docs-drift-check --sync --published <上一版>`），不手改任何一个字节。
//   · 于是 13 例的落点全部指向**夹具**，宿主树只剩两个用途：当复制的模板、打印读数。
// 为什么「要切的那一版」取「已发布段的最高一版」而不是「再 +1 个补丁号」：那棵树上确实有一份
// 与它自洽的发布面（指南、§4 阶段表、当前版本句、CHANGELOG 段），合成种子只翻它的**发布态**；
// 凭空加一版还得同时造指南，而 `unchanged-surface` 会当场判「当前版本没有一对指南」——那是**第二份
// 发布面规则**，它会漂移（与上面第 4 条同一个理由）。
//
// 只读不改本仓：合成树落在 `.scratch/`（已登记的 scratch 目录类），探针一个字节都不写入库文件。
//
// 用法：
//   node scripts/version-state-probe.mjs                 # 四个态全跑（含 S1 的整趟 --self-test，约 7 分钟）
//   node scripts/version-state-probe.mjs --fast          # 跳过 S1 的整趟自测（只跑逐态判定，秒级）
//   node scripts/version-state-probe.mjs --only S2,S3    # 只跑某几个态
//   node scripts/version-state-probe.mjs --date 2026-11-04 --keep
//   node scripts/version-state-probe.mjs --src <dir>     # 拿另一棵树（合成宿主）当基准，事实从它现读
//   node scripts/version-state-probe.mjs --next 0.32.0 --previous 0.31.0   # 「当前版」由参数决定
//   node scripts/version-state-probe.mjs --registry-base auto            # 离线：registry 基线机械现推
//   node scripts/version-state-probe.mjs --registry-base <file>          # 或给一份 {"latest","versions"}
//   node scripts/version-state-probe.mjs --self-test     # 这件工具自己的反向证（合成宿主上跑，离线，条数自己印）
//                                                       # 版本面由自测自己合成 ⇒ 与宿主停在哪一版无关
//
// 退出码：0 = 四个态都达预期；1 = 有态不达预期（反向证没红也算）；2 = 事实缺位（读不到 / 合成树建不起来 /
// 这一棵树今天没有可判的发布态）——**每一个 exit 2 都带一个代号**（`NO_INFLIGHT_SECTION`、
// `NEXT_SECTION_MISSING`、`NO_PREVIOUS_RELEASE`、`PREVIOUS_NOT_BELOW_NEXT`、`UNKNOWN_STATE`、
// `REGISTRY_UNREADABLE`、`REGISTRY_BASE_UNREADABLE`、`PREVIOUS_NOT_PUBLISHED`、`NEXT_ALREADY_PUBLISHED`、
// `SRC_UNREADABLE`、`TREE_BUILD_FAILED`、`SYNC_FAILED`、`SEED_UNREADABLE`），因为「未判定」必须能被机器分辨，
// 不能只靠读散文。
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_PATH = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const FAST = argv.includes("--fast");
const KEEP = argv.includes("--keep");
const SELF_TEST = argv.includes("--self-test");
const flagValue = (name, dflt = null) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : dflt;
};
const OUT = path.resolve(flagValue("--out", path.join(ROOT, ".scratch", "version-states")));
/** `--src <dir>`：**宿主树**（缺省 = 本脚本所在的仓根）。判据的事实来源是下面的 `SRC`：
 *  非自测时它就是宿主树；自测时它是**合成种子**（issue #713：版本面由自测自己造，宿主只当模板 + 读数）。 */
const HOST_SRC = path.resolve(flagValue("--src", ROOT));
/** 事实来源树（全脚本只读它）。自测时在下面被换成合成种子。 */
let SRC = HOST_SRC;
/** `--registry-base <file|auto>`：registry `versions` 名单的来源（缺省 = `npm view` 现读）。 */
const REGISTRY_BASE = flagValue("--registry-base", "");
const GIT_ID = {
  GIT_AUTHOR_NAME: "version-state-probe", GIT_AUTHOR_EMAIL: "probe@invalid",
  GIT_COMMITTER_NAME: "version-state-probe", GIT_COMMITTER_EMAIL: "probe@invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00 +0800", GIT_COMMITTER_DATE: "2026-01-01T00:00:00 +0800",
};

/** 「未发布」标记：与 `docs-drift-check.mjs` 判据 3 的 `UNPUBLISHED_MARK_RE` 同一形状（不抄判据，只对齐口径）。 */
const UNPUBLISHED_MARK_RE = /未发布|unpublished/i;
/** exit 2 一律带代号：「未判定」要能被机器分辨，不能只靠读散文（测试钉的就是代号本身）。 */
const fail = (msg, code = "FACT_UNREADABLE") => {
  console.error(`version-state-probe: ${code}: ${msg}`);
  process.exit(2);
};
/** 推不出事实而 exit 2 时，**先把已读到的事实印出来**再报代号（「未判定」也必须带着读数走）。 */
const failFacts = (msg, code) => { printAttemptFacts(); return fail(msg, code); };

// ── 参数闸：先于一切事实读取 ──────────────────────────────────────────────────────
// 顺序本身就是判据：`--only` 写错态名是**调用方的错**，它必须永远报得出，哪怕这棵树今天连事实都读不出
// （否则「切版前 vs 切版后」又把这条测试变成两种答案 —— 第一轮就踩过这个坑）。
/** @typedef {{id:string,title:string,published:string|null,date:boolean,omitTags:string[],stubLatest:string,expectCode:number,mustName?:string,runSelfTest?:boolean}} State */
/** 四个态的**形状**（`published` / `stubLatest` 里的 `PREV` / `NEXT` 是占位，逐态在 STATES 里换成真版本）。
 *  名字写死在这里 = 反向证有合法名单可列，所以名单不另发明一份。 */
const STATE_IDS = ["S1", "S2", "S3", "contradiction"];
const ONLY = (flagValue("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
{
  const unknown = ONLY.filter((s) => !STATE_IDS.includes(s));
  if (unknown.length) {
    fail(`--only 里的 ${unknown.join(", ")} 不是已知态（可选：${STATE_IDS.join("/")}）⇒ 一个态都不跑，`
      + "不许静默退化成「跑全部」（那会把打错的态当成没打）", "UNKNOWN_STATE");
  }
}
if (REGISTRY_BASE && REGISTRY_BASE !== "auto" && !/\.json$/iu.test(REGISTRY_BASE)) {
  fail(`--registry-base ${JSON.stringify(REGISTRY_BASE)} 既不是 auto 也不是 .json 文件路径`, "REGISTRY_BASE_UNREADABLE");
}

// ── 子进程 / git 薄封装（先于事实读取：造合成种子要用它们）──────────────────────────────
function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", timeout: opts.timeout ?? 120000, ...opts });
  if (r.error) fail(`${cmd} ${cmdArgs.join(" ")} 跑不起来：${r.error.message}`, "TREE_BUILD_FAILED");
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const git = (dir, ...a) => run("git", ["-C", dir, ...a], { env: { ...process.env, ...GIT_ID } });
/** 附注 tag 的 tagger date = 第二个参数（git 认 `GIT_COMMITTER_DATE`，实测与 `%(taggerdate:raw)` 一致）。 */
const gitTagDated = (dir, version, day) => run("git", ["-C", dir, "tag", "-a", "-m", `synthetic ${version}`, `v${version}`, "HEAD"],
  { env: { ...process.env, ...GIT_ID, GIT_COMMITTER_DATE: `${day} 12:00:00 +0800` } });

// ── 事实：从 `--src` 那棵树现读，一个版本号都不写死 ──────────────────────────────────
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

// ── `--self-test`：先把**事实来源树**换成自测自己合成的种子（issue #713）────────────────────
// 这一行必须在下面的全部事实读取之前：自测的 13 例全部跑在夹具上，所以「要切的那一版」也得从夹具现推，
// 不许从宿主推（#713 的病就是后者：宿主停在「已发版、未切下一版」时整批 exit 2）。
// 它也必须排在 `cmpSemver` 之后（种子要用它比段面）。
if (SELF_TEST) SRC = buildSelfTestSeed(HOST_SRC);

if (!existsSync(SRC) || !statSync(SRC).isDirectory()) {
  fail(`--src ${SRC} 不是存在的目录 ⇒ 事实来源树没有着落（缺省是本脚本所在的仓根）`, "SRC_UNREADABLE");
}
/** 从来源树读一个文件；读不出 = exit 2（「读不出」从来不等于「没这件事」）。 */
function readSrc(rel, code = "SRC_UNREADABLE") {
  try {
    return readFileSync(path.join(SRC, rel), "utf8");
  } catch (e) {
    return fail(`读不出 ${path.join(SRC, rel)}（${/** @type {{message?: string}} */ (e)?.message}）——它就是本探针的事实来源树（--src）`, code);
  }
}
const srcPkg = (() => {
  try { return JSON.parse(readSrc("package.json")); } catch { return null; }
})();
if (!srcPkg || !/^\d+\.\d+\.\d+$/.test(String(srcPkg?.version))) {
  fail(`${path.join(SRC, "package.json")} 读不出，或它的 version=${srcPkg?.version} 不是 x.y.z`, "SRC_UNREADABLE");
}
/**
 * 来源树自己的版本号：它只当**下界**用（「不低于本仓版本的那些未发布段」）——**它不是「当前版」**。
 * 第一版就是把它当成了基准，于是切版后的树上「高于它的那一段」不存在 ⇒ 探针自己未判定。
 */
const srcPkgVersion = String(srcPkg.version);

/**
 * CHANGELOG 的版本段：`{version, date|null, unpublished(段首标记), marked(与判据 3 同口径的未发布标记：
 * 段首行或正文前三行)}`。「已发布」= `date && !marked`（0.21.0 / 0.24.0 有日期但正文里自标未发布 ⇒ 不算已发布）。
 */
function changelogSections(text) {
  const heads = [...text.matchAll(/^##\s*\[(\d+\.\d+\.\d+)\]([^\n]*)$/gm)];
  return heads.map((m, i) => {
    const rest = m[2] ?? "";
    const date = /(\d{4}-\d{2}-\d{2})/.exec(rest)?.[1] ?? null;
    const headingMark = UNPUBLISHED_MARK_RE.test(rest);
    const body = text.slice((m.index ?? 0) + m[0].length, i + 1 < heads.length ? (heads[i + 1].index ?? text.length) : text.length);
    return {
      version: m[1], date, unpublished: headingMark,
      marked: headingMark || body.split("\n").slice(0, 3).some((l) => UNPUBLISHED_MARK_RE.test(l)),
    };
  });
}
const srcSections = changelogSections(readSrc("CHANGELOG.md", "SRC_UNREADABLE"));
if (!srcSections.length) fail(`${path.join(SRC, "CHANGELOG.md")} 里一个版本段都没有 ⇒ 发布态没有落点`, "SRC_UNREADABLE");
/** 已发布段（带日期且没标未发布）；「发布行必须是真到过的那一版」与 registry 基线共用这一份口径。 */
const srcPublished = () => srcSections.filter((s) => s.date && !s.marked).map((s) => s.version).sort(cmpSemver);

const NEXT_FLAG = flagValue("--next");
const PREV_FLAG = flagValue("--previous");
for (const [name, value] of [["--next", NEXT_FLAG], ["--previous", PREV_FLAG]]) {
  if (value && !/^\d+\.\d+\.\d+$/.test(value)) fail(`${name} ${JSON.stringify(value)} 不是 x.y.z`, "BAD_VERSION");
}
/** 「正在切的那一版」：参数 > 来源树现推（未发布且不低于该树 package.json 的最高段）。 */
const derivedNext = srcSections.filter((s) => s.unpublished && cmpSemver(s.version, srcPkgVersion) >= 0)
  .map((s) => s.version).sort(cmpSemver).at(-1) ?? null;
const nextVersion = NEXT_FLAG || derivedNext;
if (!nextVersion) {
  failFacts(`合成宿主 ${SRC} 的 CHANGELOG 里没有「未发布」且不低于 package.json（${srcPkgVersion}）的版本段 ⇒ 今天没有正在切的那一版，`
    + "S1「切版未发布」没有落点。这是**未判定**、不是红：请在下一次切版之后再跑，或显式给 `--next <x.y.z>`"
    + "（那一版必须真的在该棵树的 CHANGELOG 里）", "NO_INFLIGHT_SECTION");
}
if (!srcSections.some((s) => s.version === nextVersion)) {
  failFacts(`--next ${nextVersion} 在 ${path.join(SRC, "CHANGELOG.md")} 里没有对应的版本段 ⇒ 探针不替你造段`
    + "（造段 = 第二份发布态回写规则，它会漂移）；指到一个真的存在的版本段", "NEXT_SECTION_MISSING");
}
/** 「上一版」（S1 与矛盾态的「已发布」基准）：参数 > 已发布段里低于要切那一版的最高段。 */
const derivedPrevious = srcPublished().filter((v) => cmpSemver(v, nextVersion) < 0).at(-1) ?? null;
const previousVersion = PREV_FLAG || derivedPrevious;
if (!previousVersion) {
  failFacts(`${SRC} 的 CHANGELOG 里没有「已发布（带日期且没标未发布）且低于 ${nextVersion}」的版本段 ⇒ 没有「上一版」这个基准，`
    + "S1 的「发布行还是上一版」与矛盾态都没法称（显式给 --previous <x.y.z> 可以接管这一维）", "NO_PREVIOUS_RELEASE");
}
if (cmpSemver(previousVersion, nextVersion) >= 0) {
  failFacts(`上一版 ${previousVersion} 不低于要切的那一版 ${nextVersion} ⇒ 两个参数矛盾（S1 要的是「已发布 = 上一版、本仓 = 要切的那一版」）`,
    "PREVIOUS_NOT_BELOW_NEXT");
}
/** 这一版在来源树里已经算「已发布」吗（带日期段且没标未发布）——只用于把读数说清，不参与裁决。 */
const nextAlreadyMarkedPublished = srcPublished().includes(nextVersion);

/** 登记为「历史日期与 tag 不一致」的版本（不写死名单：读来源树里 `docs-drift-check.mjs` 那一处常量）。 */
const exemptVersions = (() => {
  const src = readSrc(path.join("scripts", "docs-drift-check.mjs"));
  const block = /const CHANGELOG_DATE_TAG_EXEMPTIONS = \[([\s\S]*?)\n\];/.exec(src);
  if (!block) fail("读不到 scripts/docs-drift-check.mjs 里的 CHANGELOG_DATE_TAG_EXEMPTIONS ⇒ 探针无法保证登记表不空转");
  return [...block[1].matchAll(/version:\s*"(\d+\.\d+\.\d+)"/g)].map((m) => m[1]);
})();
/** 发布日期：`--sync` 的缺省口径就是「当天 UTC+8」；这里显式传，好让 tag 的 tagger date 能对齐它。 */
const RELEASE_DATE = flagValue("--date", todayUtc8());
if (!/^\d{4}-\d{2}-\d{2}$/.test(RELEASE_DATE)) fail(`--date ${RELEASE_DATE} 不是 YYYY-MM-DD`);

/**
 * registry 的 `versions` 名单的三个来源（详见顶部注释）：`npm view`（缺省，真值）/ `--registry-base auto`
 * （机械现推，离线可跑）/ `--registry-base <file>`（注入）。拿不到就是 exit 2 并点名代号，**不是**跳过。
 * 为什么缺省要是真读：CHANGELOG 里「带日期」与「已发布」不是同一件事——`0.21.0` 与 `0.24.0` 两段都有日期
 * 却**从未发布**（README/AGENTS 里有这三处声称），拿 CHANGELOG 派生 versions 会把桩自己把
 * 「从未发布」说成假话 ⇒ `published-claim` 判红四处（实测：首轮 S1/S3 各红 4 处）。所以 `auto` 的口径
 * 必须是「带日期**且没自标未发布**」（= `srcPublished()`，与判据 3 同口径），而不是「带日期」。
 */
const REGISTRY_PKG = typeof srcPkg.name === "string" && srcPkg.name ? srcPkg.name : "erix-agent";
function resolveRegistryBase() {
  if (REGISTRY_BASE === "auto") {
    const versions = srcPublished();
    const latest = [...versions].sort(cmpSemver).at(-1) ?? null;
    if (!latest) fail("--registry-base auto 推不出任何已发布段（该树的 CHANGELOG 里没有「带日期且没标未发布」的段）", "REGISTRY_BASE_UNREADABLE");
    return { latest, versions, source: `合成（从 ${path.join(SRC, "CHANGELOG.md")} 现推：带日期且没标未发布 = 已发布，与判据 3 同一口径；不冒充真 registry）` };
  }
  if (REGISTRY_BASE) {
    const abs = path.resolve(REGISTRY_BASE);
    /** @type {any} */
    let parsed = null;
    try { parsed = JSON.parse(readFileSync(abs, "utf8")); } catch (e) {
      return fail(`--registry-base ${abs} 读不出 / 解析不了（${/** @type {{message?: string}} */ (e)?.message}）`, "REGISTRY_BASE_UNREADABLE");
    }
    const versions = (Array.isArray(parsed?.versions) ? parsed.versions : []).filter((v) => typeof v === "string" && v.length > 0);
    const latest = typeof parsed?.latest === "string" && parsed.latest ? parsed.latest : null;
    if (!latest || !versions.length || !versions.includes(latest)) {
      return fail(`--registry-base ${abs} 形状不对（要 {"latest": "x.y.z", "versions": [...]} 且 latest 必须在 versions 里）——`
        + "形状不对就是读不出，不许当空名单用", "REGISTRY_BASE_UNREADABLE");
    }
    return { latest, versions, source: `注入文件 ${abs}（latest=${latest}，versions ${versions.length} 个）` };
  }
  const r = run("npm", ["view", REGISTRY_PKG, "versions", "dist-tags", "--json"], { timeout: 60000 });
  if (r.code !== 0) fail(`读不到 registry（npm view ${REGISTRY_PKG} versions dist-tags）：${r.out.trim().slice(0, 200)}`
    + " ——探针需要一份真的 versions 名单（「从未发布」那几段的真值只在这里）；离线环境请给 --registry-base auto",
    "REGISTRY_UNREADABLE");
  /** @type {any} */
  let j = null;
  try { j = JSON.parse(r.out); } catch (e) { return fail(`registry 返回解不开（${/** @type {{message?: string}} */ (e)?.message}）`, "REGISTRY_UNREADABLE"); }
  const versions = (Array.isArray(j?.versions) ? j.versions : [j?.versions].filter(Boolean)).filter((v) => typeof v === "string");
  const latest = j?.["dist-tags"]?.latest ?? null;
  if (!latest || !versions.length) fail(`registry 返回里没有 dist-tags.latest / versions（实测 ${r.out.trim().slice(0, 120)}）`, "REGISTRY_UNREADABLE");
  return { latest, versions, source: `npm view ${REGISTRY_PKG}（联网现读）` };
}
const REG = resolveRegistryBase();
if (!REG.versions.includes(previousVersion)) {
  failFacts(`registry 基线（${REG.source}）的 versions 里没有上一版 ${previousVersion} ⇒ S1/S2/S3 的「已发布」那一半没有真值；`
    + "发布行必须是 registry 真到过的那一版", "PREVIOUS_NOT_PUBLISHED");
}
if (REG.versions.includes(nextVersion)) {
  failFacts(`registry 基线（${REG.source}）里已经有 ${nextVersion} ⇒ 这一版已经发出去了，S1「切版未发布」在今天的真值上不是合法态；`
    + "请把本探针跑在下一次切版与发布之间，或用 --next 指到更高的那一版未发布段", "NEXT_ALREADY_PUBLISHED");
}

// ── 合成树 ──────────────────────────────────────────────────────────────────────────
/** 入库清单（含可执行位）；与判据自己取扫描面的那条命令同源，不另发明一套「什么算入库」。
 *  `srcDir` 缺省 = `--src`（宿主树）；造合成种子时显式给宿主树，因为那一刻 `SRC` 还没换过去。 */
function trackedFiles(srcDir = SRC) {
  const r = run("git", ["-C", srcDir, "ls-files", "-z"]);
  if (r.code !== 0) fail(`git -C ${srcDir} ls-files 失败：${r.out.trim()}`, "TREE_BUILD_FAILED");
  return r.out.split("\0").filter(Boolean);
}

/**
 * 机械合成一棵树：从 `srcDir`（缺省 = `--src`）复制入库清单 + 一个只用一次的 `git init` + 一次 commit。
 * **不复用来源树的 `.git`**：本仓是 linked worktree，`.git` 只是一个指针文件，`cp -a` 之后的树继续读
 * **原仓的 index 与 refs** ⇒ tag 面失控，而且 index 里每多一个文件、拷贝里就少一个 ⇒ 读取器直接 ENOENT 砸死
 * （实测 `/tmp/p703/S1-selftest-fixed.log`，见第一轮交付报告的遗留第 6 条）。
 */
function buildTree(dir, srcDir = SRC) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = trackedFiles(srcDir);
  if (!files.length) fail(`git -C ${srcDir} ls-files 返回空清单 ⇒ 合成树会是空树`, "TREE_BUILD_FAILED");
  for (const rel of files) {
    const src = path.join(srcDir, rel);
    if (!existsSync(src)) continue;         // index 里有、磁盘上没有（半删除态）：合成树不需要
    const dst = path.join(dir, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    try { chmodSync(dst, statSync(src).mode & 0o777); } catch { /* 只读文件系统上无所谓 */ }
  }
  const init = git(dir, "init", "-q", "--initial-branch=main");
  if (init.code !== 0) fail(`合成树 git init 失败：${init.out.trim()}`, "TREE_BUILD_FAILED");
  git(dir, "add", "-A");
  const commit = git(dir, "commit", "-q", "-m", "version-state-probe: synthetic tree");
  if (commit.code !== 0) fail(`合成树首次 commit 失败：${commit.out.trim()}`, "TREE_BUILD_FAILED");
  return { files: files.length };
}

/**
 * 合成一棵**宿主**（不是发布态树）：机械配方同上，只把 `package.json` 那一维换成给定版本。
 * 发布态声称句**不在这里**对齐：逐态建树时 `stampReleaseState` 会按本态的真值重写它们；
 * 而「这一版切了没」那一维只看 CHANGELOG 段面 + `package.json`，两者都在本函数里被控制住了。
 * 它是反向证喂进 `--src` 的那棵树（`test/version-state-probe-703.test.js` 靠 `--self-test` 用它们）。
 * @param {string} dir @param {{version?: string|null}} [facts]
 */
function buildHost(dir, { version = null } = {}) {
  const built = buildTree(dir);
  if (version) setVersion(dir, version);
  return built;
}

/**
 * 把 CHANGELOG 里**高于** `version` 的版本段整段摘掉（标题行到下一个 `## ` 标题之前）。
 * 为什么要有这一步（issue #713）：宿主要已经切到下一版（树上多一段更高版本的未发布段），那段会被
 * 「未发布且不低于 package.json」的口径选中 ⇒ 夹具的「要切的那一版」跟着宿主漂，
 * 「两棵宿主同一份读数」就不成立了。摘掉是**合成种子的版本面定义**（夹具的历史止于它自己的当前版），
 * 不是判据放宽：段面之外一个字节不动。
 * @returns {string[]} 被摘掉的版本（供打印；空数组 = 宿主本来就没有更高的段）
 */
function dropSectionsAbove(dir, version) {
  const p = path.join(dir, "CHANGELOG.md");
  const lines = readFileSync(p, "utf8").split("\n");
  const kept = [];
  const dropped = [];
  let dropping = null;
  for (const line of lines) {
    if (/^## /u.test(line)) {
      const head = /^##\s*\[(\d+\.\d+\.\d+)\]/u.exec(line);
      dropping = head && cmpSemver(head[1], version) > 0 ? head[1] : null;
    }
    if (dropping) { if (!dropped.includes(dropping)) dropped.push(dropping); continue; }
    kept.push(line);
  }
  if (dropped.length) writeFileSync(p, kept.join("\n"), "utf8");
  return dropped;
}

/**
 * `--self-test` 的**合成种子**（issue #713）：自测那几棵宿主树全部从这棵种子长出来，而种子的
 * **版本面由本函数合成** ⇒ 「要切的那一版」不再从宿主树推。配方（全部机械，不手改字节）：
 *   1. 入库清单 + 其余文档从宿主树抄（判据的扫描面必须与真树同形，这一半不能凭空造）；
 *   2. `要切的那一版` = 种子里**已发布段**（带日期且没标未发布）的最高一版；`上一版` = 低于它的最高已发布段；
 *      为什么不是「再 +1 个补丁号」：那棵树上确实有一份与它自洽的发布面（指南 / §4 阶段表 / 当前版本句 /
 *      CHANGELOG 段），合成种子只翻它的**发布态**；凭空加一版还得同时造指南，
 *      而 `unchanged-surface` 会当场判「当前版本没有一对指南」——那是**第二份发布面规则**，它会漂移。
 *   3. 高于它的段整段摘掉（它们是「夹具这一版之后的事」，留着就会把「要切的那一版」抬到宿主那一边）；
 *   4. `package.json` 置为要切的那一版；段首「未发布」形状走本仓自己的窄面
 *      （`docs-drift-check --sync --published <上一版>`），不手改任何一个字节。
 * @param {string} hostSrc 宿主树（`--src`，缺省 = 本脚本所在的仓根）
 * @returns {string} 合成种子目录（之后全脚本的 `SRC` 就是它）
 */
function buildSelfTestSeed(hostSrc) {
  const seed = path.join(OUT, ".selftest-seed");
  mkdirSync(OUT, { recursive: true });
  const built = buildTree(seed, hostSrc);
  const sections = changelogSections(readFileSync(path.join(seed, "CHANGELOG.md"), "utf8"));
  const published = sections.filter((s) => s.date && !s.marked).map((s) => s.version).sort(cmpSemver);
  const next = published.at(-1) ?? null;
  if (!next) {
    fail(`宿主树 ${hostSrc} 的 CHANGELOG 里没有任何「已发布（带日期且没标未发布）」的版本段 ⇒ 合成种子没有版本面可造`
      + "（自测要的「上一版」必须是一份真到过的发布段）", "SEED_UNREADABLE");
  }
  const previous = published.filter((v) => cmpSemver(v, next) < 0).at(-1) ?? null;
  if (!previous) {
    fail(`宿主树 ${hostSrc} 的 CHANGELOG 里只有 ${next} 这一个已发布段 ⇒ 合成种子没有「上一版」这个基准`,
      "SEED_UNREADABLE");
  }
  const dropped = dropSectionsAbove(seed, next);
  setVersion(seed, next);
  stampReleaseState(seed, { published: previous, date: null });
  console.log(`  [种子] 合成种子宿主 ${seed}：入库清单 ${built.files} 个文件从宿主树 ${hostSrc} 机械复制，`
    + "**版本面由自测合成**（宿主停在哪一版都不影响）");
  console.log(`         要切的那一版 ${next}（种子里最高的已发布段） · 上一版 ${previous} · `
    + `摘掉高于 ${next} 的段：${dropped.length ? dropped.join(" / ") : "（无）"} · `
    + "段首「未发布」形状走 --sync（不手改字节）");
  return seed;
}

/**
 * 把 `package.json` 的 version 换成给定那一版（只动那一行，别重排 JSON）。
 * **本来就是那一版 ⇒ 合法地零字节**（合成「切版前宿主」时就会碰到）：「没得改」不是「找不到那一行」，
 * 两者必顶分开报，否则反向证会假红。
 */
function setVersion(dir, version) {
  const p = path.join(dir, "package.json");
  const text = readFileSync(p, "utf8");
  const re = /^(\s*"version":\s*")[^"]+(")/m;
  if (!re.test(text)) fail(`${p} 里找不到 "version" 那一行 ⇒ 无法把树切成 ${version}`, "TREE_BUILD_FAILED");
  const next = text.replace(re, `$1${version}$2`);
  if (next !== text) writeFileSync(p, next, "utf8");
  return { changed: next !== text };
}

/** 发布态回写：走本仓自己的窄面（`--sync`），不手改任何字节。 */
function stampReleaseState(dir, { published, date }) {
  const a = ["scripts/docs-drift-check.mjs", "--sync", "--published", published];
  if (date) a.push("--published-date", date);
  const r = run(process.execPath, a, { cwd: dir, timeout: 300000 });
  if (r.code !== 0) fail(`合成树里的发布态回写没成（exit ${r.code}）：\n${r.out.trim().split("\n").slice(0, 12).join("\n")}`, "SYNC_FAILED");
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
/** @type {State[]} */
const STATES = [
  {
    id: "S1", title: "切版未发布（段首无日期 + 无 tag + registry 还是上一版）",
    published: previousVersion, date: false, omitTags: [nextVersion], stubLatest: previousVersion,
    expectCode: 0, runSelfTest: !FAST,
  },
  {
    id: "S2", title: "已发布未打 tag（registry 已到要切的那一版，tag 缺）",
    published: nextVersion, date: true, omitTags: [nextVersion], stubLatest: nextVersion,
    expectCode: 2, mustName: "TAG_MISSING",
  },
  {
    id: "S3", title: "发布完成（tag 在，且 tagger date = 段首日期）",
    published: nextVersion, date: true, omitTags: [], stubLatest: nextVersion,
    expectCode: 0,
  },
  {
    id: "contradiction", title: "矛盾态反向证：文档说已发布 = 要切的那一版，registry 桩说 latest 还是上一版",
    published: nextVersion, date: true, omitTags: [], stubLatest: previousVersion,
    expectCode: 1, mustName: "published-claim",
  },
];
const states = ONLY.length ? STATES.filter((s) => ONLY.includes(s.id)) : STATES;

/** 逐态的 registry 桩内容：底 = 基线名单（真读 / auto 现推 / 注入）；「已发布」那一侧多一个要切的那一版。 */
function versionsFor(latest) {
  if (latest === REG.latest) return [...REG.versions];
  if (cmpSemver(latest, REG.latest) > 0) return [...REG.versions, latest].sort(cmpSemver);
  return [...REG.versions].sort(cmpSemver);
}

const problems = [];
/** 一条断言：落不上就记进 problems（**变异不落上算失败**，不许静默跳过）。 */
function assert(ok, what, detail = "") {
  console.log(`    ${ok ? "✓" : "✗"} ${what}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) problems.push(`${what}${detail ? `（${detail}）` : ""}`);
  return ok;
}
/** 输出里逐条找得到才算数（**硬指名字**，不许「匹配任意一行」）；每一条单独打一行 ✓/✗，少一条就少一行绿。 */
function assertNames(body, needles) {
  for (const needle of needles) assert(body.includes(needle), `点名 ${needle}`, "输出里找不到这个串 ⇒ 该判的那一条没跑到");
  return needles.length;
}

/** 事实读数头：判定要印，**未判定的那条 exit 2 之前也要印** ⇒ 「静默什么都不判」在结构上不可能。 */
function printFactsHeader(mode = "") {
  const nextSection = srcSections.find((s) => s.version === nextVersion) ?? null;
  console.log(`version-state-probe（issue #703）· 事实来源树 --src=${SRC}`
    + (SELF_TEST ? `（**合成种子**：版本面由 --self-test 自己造）· 宿主树 ${HOST_SRC}（只当模板 + 读数）` : "")
    + `（它的 package.json=${srcPkgVersion}：**只当「未发布段的下界」用，不是「当前版」**）`);
  console.log(`  要切的那一版 ${nextVersion}（${NEXT_FLAG ? "参数 --next 给的" : `由 ${path.join(SRC, "CHANGELOG.md")} 现推：未发布且不低于本仓版本的最高段`}）`
    + ` · 上一版 ${previousVersion}（${PREV_FLAG ? "参数 --previous 给的" : "同一棵树现推：已发布段里低于它的最高段"}）`
    + ` · 段面 ${JSON.stringify(nextSection)}`);
  console.log(`  registry 基线：${REG.source}（latest=${REG.latest}，versions ${REG.versions.length} 个 ⇒ 桩只改 latest / 加要切的那一版）`);
  console.log(`  发布日期 ${RELEASE_DATE} · 登记表里错开一天的版本：${exemptVersions.join(" / ") || "（无）"}`);
  console.log(`  合成树根：${OUT}${FAST ? "  [--fast：跳过 S1 的整趟 --self-test]" : ""}${mode ? `  [${mode}]` : ""}\n`);
}
/** 推不出「正在切的那一版 / 上一版」时也要先把读数印出来（配合上面的注释）。 */
function printAttemptFacts() {
  console.log(`version-state-probe（issue #703）· 事实来源树 --src=${SRC}`
    + (SELF_TEST ? `（**合成种子**；宿主树 ${HOST_SRC} 只当模板 + 读数）` : "")
    + `（它的 package.json=${srcPkgVersion}）`);
  console.log(`  CHANGELOG 版本段 ${srcSections.length} 个 · 未发布段 ${JSON.stringify(srcSections.filter((s) => s.unpublished).map((s) => s.version))}`
    + ` · 已发布段（带日期且没标未发布）最高 ${JSON.stringify(srcPublished().at(-1) ?? null)}`);
}

// ── 主流程：逐态建树 → 落事实 → 跑真判据 ────────────────────────────────────────────
function main() {
  printFactsHeader();
  const FIXTURES = path.join(OUT, "fixtures");
  mkdirSync(FIXTURES, { recursive: true });

  for (const state of states) {
    const dir = path.join(OUT, state.id);
    console.log(`── ${state.id}：${state.title}`);
    const built = buildTree(dir);
    setVersion(dir, nextVersion);
    stampReleaseState(dir, { published: String(state.published), date: state.date ? RELEASE_DATE : null });
    const tags = writeTags(dir, { omit: state.omitTags });

    // registry 桩：versions = 基线名单（+ 已发布那一态的下一版），latest 逐态给
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

  const FIXTURES_DIR = path.join(OUT, "fixtures");
  console.log(`registry 桩留在：${FIXTURES_DIR}（${states.map((s) => `${s.id}.json latest=${s.stubLatest}`).join("，")}）`);
  if (problems.length) {
    console.log(`\nversion-state-probe: 失败 — ${problems.length} 项未达预期`);
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log(`version-state-probe: OK — ${states.length} 个发布态（${states.map((s) => s.id).join("/")}）全部达预期，`
    + `含矛盾态反向证${FAST ? "（--fast：S1 的整趟 --self-test 未跑）" : "与 S1 的整趟 --self-test"}`);
  process.exit(0);
}

// ── 这件工具自己的反向证（`--self-test`）：合成宿主喂进来，**不拿跑它的树当基准** ──────────
// 第二轮的病灶就在这里：第一版让测试拿**宿主**当基准，于是探针自己成了「宿主版本相关」的（宿主一切到
// 下一版，2/4 条用例红）。这里三棵宿主全是机械合成的，**两棵「正在切」的宿主（切版前 / 切版后未发布）
// 必须给同一份读数**——那一条就是「探针不再从宿主推」的机器证据。离线（registry 基线走 auto / 注入文件）。
//
// issue #713：三棵宿主本身也不再从宿主树抄版本面——它们从上面那棵**合成种子**（`buildSelfTestSeed()`）
// 长出来，而种子的 `package.json` 版本与 CHANGELOG 段面是自测合成的。宿主树只剩两个用途：当复制的模板、
// 打印读数。最后两例是「夹具真的在承重」的反向证（#210 R2）：把夹具里的在飞段删掉 / 把夹具的
// `package.json` 抬到高于所有段，**该例自己**红并点名落点缺失，同一批里没被变异的那棵仍然绿。
function runSelfTest() {
  printFactsHeader("--self-test：合成宿主上跑，不读跑它的那棵树");
  const HOSTS = path.join(OUT, ".selftest");
  const RUNS = path.join(OUT, ".selftest-run");
  rmSync(RUNS, { recursive: true, force: true });
  mkdirSync(RUNS, { recursive: true });
  /** 三棵宿主（只差「这一版切了没 / 发布态回写了没」两个事实）。 */
  const HOST_PRE = path.join(HOSTS, "pre-cut");        // package.json = 上一版 ⇒ 切版前
  const HOST_POST = path.join(HOSTS, "post-cut");      // package.json = 要切的那一版 + 段首仍未发布 ⇒ 切版后未发布
  const HOST_RELEASED = path.join(HOSTS, "released");  // 再往回写一步：段首带日期 ⇒ 没有「正在切的那一版」了
  console.log("  [宿主] 机械合成三棵（同一份入库清单，只差 package.json / 发布态回写）");
  assert(buildHost(HOST_PRE, { version: previousVersion }).files > 0, `切版前宿主建起来了（package.json=${previousVersion}）`);
  assert(buildHost(HOST_POST, { version: nextVersion }).files > 0, `切版后未发布宿主建起来了（package.json=${nextVersion}）`);
  assert(buildHost(HOST_RELEASED, { version: nextVersion }).files > 0, `发布回写后宿主建起来了（package.json=${nextVersion}）`);
  stampReleaseState(HOST_RELEASED, { published: nextVersion, date: RELEASE_DATE });

  // ── 两棵**变异夹具**（反向证）：变异落在夹具上才算数（#210 R2），变异没落上就是失败 ────────────────
  // 两棵都从同一棵「切版后未发布」宿主（= 种子的形状）出发，只动**一处**：
  //   ① 把「在飞段」整段删掉（夹具里再没有「正在切的那一版」）；
  //   ② 把 `package.json` 抬到高于所有段（在飞段变成了「低于本仓版本」，按定义不算在飞）。
  const seedSections = changelogSections(readFileSync(path.join(HOST_POST, "CHANGELOG.md"), "utf8"));
  const HOST_NO_INFLIGHT = path.join(HOSTS, "no-inflight");
  buildHost(HOST_NO_INFLIGHT, { version: nextVersion });
  const droppedInflight = dropSectionsAbove(HOST_NO_INFLIGHT, previousVersion);
  const stillHasInflight = (dir) => changelogSections(readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"))
    .some((s) => s.version === nextVersion);
  assert(droppedInflight.includes(nextVersion) && !stillHasInflight(HOST_NO_INFLIGHT),
    `变异落上了：夹具里的在飞段 ${nextVersion} 被整段删掉`, `实测摘掉 ${JSON.stringify(droppedInflight)}`);
  assert(stillHasInflight(HOST_POST), `变异**只**落在那一棵上：同一批里的 ${path.relative(OUT, HOST_POST)} 仍然有 ${nextVersion} 段`);
  const [nextMajor] = nextVersion.split(".").map(Number);
  const aboveAll = [nextMajor + 1, 0, 0].join(".");
  const HOST_PKG_ABOVE = path.join(HOSTS, "pkg-above");
  buildHost(HOST_PKG_ABOVE, { version: aboveAll });
  assert(seedSections.every((s) => cmpSemver(s.version, aboveAll) < 0),
    `变异落上了：夹具 package.json 抬到 ${aboveAll}，高于所有段（最高 ${nextVersion}）`,
    `实测段面 ${JSON.stringify(seedSections.map((s) => s.version).slice(0, 3))}`);

  /** 用**真的 CLI**跑一次：被断言的就是外面那个人看到的退出码与输出。 */
  const spawnProbe = (args, timeout = 900000) => run(process.execPath, [PROBE_PATH, ...args], { timeout });
  const stubDir = path.join(RUNS, "stubs");
  mkdirSync(stubDir, { recursive: true });
  /** 写一份 registry 基线桩（形状与 `docs-drift-check --registry-json` 同）。 */
  const writeBase = (name, obj) => {
    const p = path.join(stubDir, `${name}.json`);
    writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
    return p;
  };
  const THREE_STATES = ["--fast", "--only", "S2,S3,contradiction", "--registry-base", "auto"];
  const THREE_STATE_NAMES = [`要切的那一版 ${nextVersion}`, `上一版 ${previousVersion}`, "registry 基线：合成",
    "✓ exit 2（未判定）", "✓ 点名 TAG_MISSING", "✓ exit 0（绿）", "✓ exit 1（红）", "✓ 点名 published-claim"];

  /** @type {Array<{title:string,args:string[],code:number,names:string[]}>} */
  const cases = [
    {
      title: `合成宿主「切版后未发布」（--src=${path.relative(OUT, HOST_POST)}）当基准：S2/S3/矛盾态全达预期`,
      args: [...THREE_STATES, "--src", HOST_POST, "--out", path.join(RUNS, "post")], code: 0, names: THREE_STATE_NAMES,
    },
    {
      title: `合成宿主「切版前」（--src=${path.relative(OUT, HOST_PRE)}）当基准：**与上面同一份读数**（探针不再从宿主推）`,
      args: [...THREE_STATES, "--src", HOST_PRE, "--out", path.join(RUNS, "pre")], code: 0, names: THREE_STATE_NAMES,
    },
    {
      title: "「当前版」由**参数**决定（--next / --previous）：读数与来源树自己的版本无关",
      args: ["--fast", "--only", "contradiction", "--src", HOST_POST, "--next", nextVersion, "--previous", previousVersion,
        "--registry-base", "auto", "--out", path.join(RUNS, "params")],
      code: 0, names: ["参数 --next 给的", "参数 --previous 给的", "✓ 点名 published-claim"],
    },
    {
      title: "发布回写之后的宿主（没有正在切的那一版）⇒ **未判定 exit 2**，且先印事实读数再点名 NO_INFLIGHT_SECTION",
      args: ["--fast", "--only", "S2", "--src", HOST_RELEASED, "--registry-base", "auto", "--out", path.join(RUNS, "released")],
      code: 2, names: ["NO_INFLIGHT_SECTION", "事实来源树 --src=", "--next"],
    },
    {
      title: "同一棵树 + `--next` 指回**上一版**（那一段已发布）⇒ auto 基线立刻说 NEXT_ALREADY_PUBLISHED：参数不许把已发布版硬掰成「正在切」",
      args: ["--fast", "--only", "S2", "--src", HOST_RELEASED, "--next", previousVersion,
        "--registry-base", "auto", "--out", path.join(RUNS, "released-next")],
      code: 2, names: ["NEXT_ALREADY_PUBLISHED", "事实来源树 --src="],
    },
    {
      title: "--registry-base 指向读不出的文件 ⇒ exit 2 点名 REGISTRY_BASE_UNREADABLE（不是「当空名单用」）",
      args: ["--fast", "--only", "S2", "--src", HOST_POST, "--registry-base", path.join(stubDir, "not-there.json"),
        "--out", path.join(RUNS, "bad-base")],
      code: 2, names: ["REGISTRY_BASE_UNREADABLE"],
    },
    {
      title: "--registry-base 里 latest 不在 versions 里 ⇒ exit 2（形状不对 = 读不出，不许猜）",
      args: ["--fast", "--only", "S2", "--src", HOST_POST,
        "--registry-base", writeBase("bad-shape", { latest: "9.9.9", versions: [previousVersion] }),
        "--out", path.join(RUNS, "bad-shape")],
      code: 2, names: ["REGISTRY_BASE_UNREADABLE"],
    },
    {
      title: "--registry-base 的 versions 里**已经有要切的那一版** ⇒ exit 2 点名 NEXT_ALREADY_PUBLISHED（S1 不是合法态）",
      args: ["--fast", "--only", "S2", "--src", HOST_POST,
        "--registry-base", writeBase("has-next", { latest: nextVersion, versions: [previousVersion, nextVersion] }),
        "--out", path.join(RUNS, "has-next")],
      code: 2, names: ["NEXT_ALREADY_PUBLISHED"],
    },
    {
      title: "--registry-base 的 versions 里没有上一版 ⇒ exit 2 点名 PREVIOUS_NOT_PUBLISHED（「已发布」那一半没真值）",
      args: ["--fast", "--only", "S2", "--src", HOST_POST,
        "--registry-base", writeBase("no-prev", { latest: "9.9.9", versions: ["9.9.9", nextVersion] }),
        "--out", path.join(RUNS, "no-prev")],
      code: 2, names: ["PREVIOUS_NOT_PUBLISHED"],
    },
    {
      title: "--only 写错态名 ⇒ exit 2 列出合法态名，**且先于事实读取**（在连事实都推不出的树上也报得出）",
      args: ["--fast", "--only", "S9", "--src", HOST_RELEASED, "--registry-base", "auto", "--out", path.join(RUNS, "bad-only")],
      code: 2, names: ["UNKNOWN_STATE", "S1/S2/S3/contradiction"],
    },
    {
      title: "--next 指向 CHANGELOG 里没有的段 ⇒ exit 2（探针不替你造段）",
      args: ["--fast", "--only", "S2", "--src", HOST_POST, "--next", "9.9.9", "--registry-base", "auto",
        "--out", path.join(RUNS, "bad-next")],
      code: 2, names: ["NEXT_SECTION_MISSING"],
    },
    {
      title: "--previous 不低于 --next ⇒ exit 2 点名 PREVIOUS_NOT_BELOW_NEXT（两个参数自相矛盾）",
      args: ["--fast", "--only", "S2", "--src", HOST_POST, "--next", previousVersion, "--previous", nextVersion,
        "--registry-base", "auto", "--out", path.join(RUNS, "swapped")],
      code: 2, names: ["PREVIOUS_NOT_BELOW_NEXT"],
    },
    {
      title: "--src 指向不存在的目录 ⇒ exit 2 点名 SRC_UNREADABLE（不静默回落到本仓）",
      args: ["--fast", "--only", "S2", "--src", path.join(OUT, ".selftest", "no-such-tree"), "--registry-base", "auto",
        "--out", path.join(RUNS, "bad-src")],
      code: 2, names: ["SRC_UNREADABLE"],
    },
    {
      title: "反向证 ①（#210 R2）：把**夹具里的在飞段**整段删掉 ⇒ 这一例自己红（exit 2 点名 NO_INFLIGHT_SECTION），"
        + "同一批里没被变异的那棵仍然绿（不是整批都报它）",
      args: ["--fast", "--only", "S2", "--src", HOST_NO_INFLIGHT, "--registry-base", "auto",
        "--out", path.join(RUNS, "no-inflight")],
      code: 2, names: ["NO_INFLIGHT_SECTION", "事实来源树 --src=", "--next"],
    },
    {
      title: `反向证 ②（#210 R2）：把夹具 package.json 抬到 ${aboveAll}（高于所有段）⇒ 同样红（NO_INFLIGHT_SECTION），`
        + "且判词里回显的正是那个抬高的版本（= 变异真的落在这棵夹具上）",
      args: ["--fast", "--only", "S2", "--src", HOST_PKG_ABOVE, "--registry-base", "auto",
        "--out", path.join(RUNS, "pkg-above")],
      code: 2, names: ["NO_INFLIGHT_SECTION", `不低于 package.json（${aboveAll}）`],
    },
  ];

  for (const c of cases) {
    console.log(`── 自测例：${c.title}`);
    const r = spawnProbe(c.args);
    const body = r.out;
    assert(r.code === c.code, `exit ${c.code}`, `实测 exit ${r.code}`);
    assertNames(body, c.names);
    if (r.code !== c.code || c.names.some((n) => !body.includes(n))) {
      console.log(body.split("\n").slice(0, 25).map((l) => `         │ ${l}`).join("\n"));
    }
  }
  if (!KEEP) {
    rmSync(HOSTS, { recursive: true, force: true });
    rmSync(RUNS, { recursive: true, force: true });
    rmSync(SRC, { recursive: true, force: true });   // 合成种子（issue #713）：自测自己造的就自己扫干净
  }
  console.log(`\nversion-state-probe --self-test：跑了 ${cases.length} 例（合成宿主：切版前 / 切版后未发布 / 发布回写后；`
    + "夹具的版本面由自测自己合成，宿主树只当模板 + 读数；registry 基线走注入与 auto ⇒ 离线）");
  if (problems.length) {
    console.log(`version-state-probe --self-test: 失败 — ${problems.length} 项未达预期`);
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log(`version-state-probe --self-test: OK — ${cases.length} 例反向证全达预期（含「两棵宿主同一份读数」那条：探针不再从宿主推当前版；`
    + "夹具版本面由自测合成，与宿主停在哪一版无关）");
  process.exit(0);
}

if (SELF_TEST) runSelfTest(); else main();
