// issue #703 —— 发布态探针（`scripts/version-state-probe.mjs`）与 registry 事实注入口子的反向证。
//
// 为什么这条要进 `npm test`：探针本体是**门禁的工具**，它自己坏了没人会发现——而它坏法恰好是
// 「静默全绿」（合成树没建成、桩没落上、断言写歪）。本文件钉七件事：
//   A. 探针自己的 `--self-test` 全绿并报条数：那 13 例全在**机械合成的宿主**上跑（切版前 / 切版后未发布 /
//      发布回写后），并且钉住「切版前与切版后两棵宿主给出同一份读数」——**这一条就是「探针不再从宿主推
//      当前版」的机器证据**（第二轮的缺口 B：第一版拿宿主当基准，宿主一切到下一版就有 2/4 条红）。
//   B. **宿主实跑**（缺省 `--src` = 跑它的那棵树）：要么给出判定、要么给出**带代号的 exit 2 且先印事实读数**
//      ——「静默什么都不判」不许存在（`npm run check:version-states` 在两种宿主上的合法答案只有这两种）。
//   C. `--only` 写一个不存在的态 ⇒ exit 2 并列出合法态名（**事实缺位不当绿**，也不静默跑全部；
//      而且它**先于一切事实读取**，所以在连「正在切哪一版」都推不出的树上也照样报得出）。
//   D. `--registry-json` 指向读不出的文件 ⇒ `docs-drift-check` **exit 2**，不是「跳过 registry」。
//   E. `--registry-json` 给一个假的 latest ⇒ 判定**非零**且点名 `published-claim`——
//      证的是「判据读的是这个桩」。退出码只断言「非零」：`latest` 那一版有没有 tag 取决于本机 tag 面
//      （CI 的浅检出可能一枚都没有），有则 exit 1（红）、没有则 `TAG_MISSING` 抬成 exit 2；两条都算「桩被读了」。
//   F. 静态守卫：探针源码的**代码行**里不许出现任何宿主版本号字面量（`9.9.9` 那个哨兵除外）——
//      这正是第二轮被抓到的病：把「当前版」焊成宿主那一版，换版即失效。
//   G. `npm run check:version-states` 这条 script 接的就是这个探针（接线钉子：改接别处必须同时改本文件）。
//
// 隔离：合成树/桩写在 `makeTmp()` 的临时目录里（卫生门禁口径），不写仓库、不碰 `.scratch/`、零真实 LLM；
// A/B 走 `--registry-base auto|<file>` ⇒ **不联网**（缺省那条 `npm view` 只在人敲的命令上跑）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeTmp } from "./helpers/tmp.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PROBE = join(ROOT, "scripts", "version-state-probe.mjs");
const DRIFT = join(ROOT, "scripts", "docs-drift-check.mjs");

const runNode = (script, args, opts = {}) => spawnSync(process.execPath, [script, ...args], {
  encoding: "utf8", timeout: opts.timeout ?? 600000, cwd: opts.cwd ?? ROOT,
});

/** 「未判定」的合法代号全集（探针的每一个 exit 2 都带代号；B 用它把「带原因的未判定」与「红/静默」分开）。 */
const NOT_JUDGED_CODES = [
  "NO_INFLIGHT_SECTION", "NO_PREVIOUS_RELEASE", "NEXT_SECTION_MISSING", "PREVIOUS_NOT_BELOW_NEXT",
  "SRC_UNREADABLE", "REGISTRY_UNREADABLE", "REGISTRY_BASE_UNREADABLE", "PREVIOUS_NOT_PUBLISHED",
  "NEXT_ALREADY_PUBLISHED",
];

test("A. 探针自己的 --self-test：合成宿主上 13 例全绿并报条数（切版前后两棵宿主同一份读数）", { timeout: 900000 }, async () => {
  const out = await makeTmp("version-states-selftest-");
  const r = runNode(PROBE, ["--self-test", "--out", out], { timeout: 900000 });
  const body = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, `--self-test 应当全绿，实测 exit ${r.status}：\n${body.slice(-6000)}`);
  // 条数由命令自己打印；这里是**地板**（少一格 = 有一例被删/被跳过 ⇒ 红）。现测 13 例。
  const m = /--self-test: OK — (\d+) 例反向证/u.exec(body);
  assert.ok(m, `末行应当是「OK — N 例反向证」，实测末行：${body.trim().split("\n").slice(-3).join(" / ")}`);
  assert.ok(Number(m[1]) >= 13, `例数地板 13，实测 ${m[1]}：有一格被删或没跑到`);
  assert.match(body, /合成宿主：切版前 \/ 切版后未发布 \/ 发布回写后/u, body.slice(-3000));
  // 三态与每一条反向证都必须在输出里**逐条点名**（不许「exit 0 就算绿」）。
  for (const line of [
    "✓ exit 0（绿）", "✓ exit 1（红）", "✓ exit 2（未判定）",
    "✓ 点名 TAG_MISSING", "✓ 点名 published-claim", "✓ 点名 NO_INFLIGHT_SECTION",
    "✓ 点名 NEXT_ALREADY_PUBLISHED", "✓ 点名 NEXT_SECTION_MISSING", "✓ 点名 PREVIOUS_NOT_BELOW_NEXT",
    "✓ 点名 UNKNOWN_STATE", "✓ 点名 SRC_UNREADABLE", "✓ 点名 PREVIOUS_NOT_PUBLISHED",
    "✓ 点名 REGISTRY_BASE_UNREADABLE",
  ]) {
    assert.ok(body.includes(line), `自测输出里缺这一格：${line}\n${body.slice(-3000)}`);
  }
  assert.doesNotMatch(body, /^\s*✗/u, `自测输出里有 ✗ 却仍 exit 0：\n${body.slice(-3000)}`);
  // 「两棵宿主同一份读数」这一例自己得在（它是缺口 B 的正证）。
  assert.match(body, /与上面同一份读数/u, body.slice(-6000));
});

test("B. 宿主实跑（缺省 --src）：要么判定、要么带代号的 exit 2 且先印事实读数（不许静默）", { timeout: 600000 }, async () => {
  const out = await makeTmp("version-states-host-");
  const r = runNode(PROBE, ["--fast", "--only", "S3,contradiction", "--registry-base", "auto", "--out", out]);
  const body = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const codeNamed = /version-state-probe: ([A-Z_]+):/u.exec(body);
  if (r.status === 0) {
    // 判定：三态里两态按预期（S3 绿 + 矛盾态红并点名 published-claim）。
    assert.match(body, /✓ exit 0（绿）/u, body.slice(-4000));
    assert.match(body, /✓ exit 1（红）/u, body.slice(-4000));
    assert.match(body, /✓ 点名 published-claim/u, body.slice(-4000));
    assert.match(body, /registry 基线：合成/u, body.slice(-4000));   // 注入的基线要说清来源，不冒充真 registry
    return;
  }
  assert.equal(r.status, 2, `宿主实跑只能是「判定（0）」或「带原因的未判定（2）」，实测 exit ${r.status}：\n${body.slice(-4000)}`);
  assert.ok(codeNamed, `exit 2 必须带代号（version-state-probe: <代号>: …），实测：\n${body.slice(-4000)}`);
  assert.ok(NOT_JUDGED_CODES.includes(codeNamed[1]),
    `exit 2 的代号必须是「未判定」那一族（${NOT_JUDGED_CODES.join("/")}），实测 ${codeNamed[1]}：\n${body.slice(-4000)}`);
  // 「未判定」也要把已读到的事实印出来 ⇒ 结构上不可能「静默什么都不判」。
  assert.match(body, /事实来源树 --src=/u, body.slice(-4000));
});

test("C. 探针：--only 写错态名 ⇒ exit 2 并列出合法态名（不许静默跑全部）", () => {
  const r = runNode(PROBE, ["--fast", "--only", "S9"]);
  const body = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 2, body.slice(-2000));
  assert.match(body, /不是已知态/u, body.slice(-2000));
  assert.match(body, /S1\/S2\/S3\/contradiction/u, body.slice(-2000));
  assert.match(body, /UNKNOWN_STATE/u, body.slice(-2000));
  assert.match(body, /一个态都不跑/u, body.slice(-2000));
});

test("D. --registry-json 读不出 ⇒ docs-drift-check exit 2（注入的假真值不许当「跳过」）", async () => {
  const dir = await makeTmp("registry-stub-");
  const r = runNode(DRIFT, ["--strict", "--registry-json", join(dir, "not-there.json")]);
  const body = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 2, body.slice(-2000));
  assert.match(body, /--registry-json .*读不出 \/ 解析不了/u, body.slice(-2000));
  assert.match(body, /exit 2（不是跳过）/u, body.slice(-2000));
});

test("E. --registry-json 给假的 latest ⇒ 判定非零并点名 published-claim（桩真的被读）", async () => {
  const dir = await makeTmp("registry-stub-");
  const stub = join(dir, "stale.json");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  // `latest` 选一个「**没有对应 CHANGELOG 段、也没有同名 tag**」的补丁号（0.29.9）：
  // 否则 `TAG_MISSING` 会把这一格从 exit 1 抬成 exit 2（而 exit 2 的分支不印 errors），红的就不是
  // 「发布行说诌」这一条了。versions 里多放两版，是为了让 #697 的日期↔tag 与登记表
  // （`CHANGELOG_DATE_TAG_EXEMPTIONS` 里的 0.19.0 / 0.25.0）不跟着空转 ⇒ 这一刀只测一个判据。
  // 真 registry 现在与文档那句一致（都是发布行那一版）⇒ 只有「判据读了桩」才会红。
  const stale = "0.29.9";
  await writeFile(stub, `${JSON.stringify(
    { latest: stale, versions: ["0.19.0", "0.25.0", stale, pkg.version] }, null, 2)}\n`, "utf8");
  const r = runNode(DRIFT, ["--strict", "--registry-json", stub], { cwd: ROOT });
  const body = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.notEqual(r.status, 0, `桩里的 latest=${stale} 与文档的发布行（${pkg.version}）打架 ⇒ 不许绿，实测 exit ${r.status}`);
  assert.match(body, /published-claim: .*说发布行（`dist-tags\.latest`）是 .*，registry 实测是 0\.29\.9/su, body.slice(-4000));
});

test("F. 静态守卫：探针代码行里不许出现宿主版本号字面量（第二轮的病灶就是它）", () => {
  // 先剔块注释（/** … *\/ 的 JSDoc），再剔行注释；剩下的才是**会执行的字面量**。
  // 剔的时候**保留行数**（拿等量的换行替掉），否则报错里的行号会对不上源码。
  const src = readFileSync(PROBE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => "\n".repeat((block.match(/\n/gu) ?? []).length));
  const offenders = [];
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/u, "");
    for (const m of code.matchAll(/\b\d+\.\d+\.\d+\b/gu)) {
      if (m[0] !== "9.9.9") offenders.push(`第 ${i + 1} 行：${m[0]} —— ${line.trim().slice(0, 90)}`);
    }
  });
  assert.deepEqual(offenders, [], "探针代码里出现了版本号字面量（除哨兵 9.9.9）：「当前版」必须来自 --src / --next / --previous，"
    + "焊死任何一版都会让探针在换版那天失效（第二轮缺口 B 的原病）\n" + offenders.join("\n"));
});

test("G. npm run check:version-states 接的就是这个探针（接线钉子）", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check:version-states"], "node scripts/version-state-probe.mjs");
});
