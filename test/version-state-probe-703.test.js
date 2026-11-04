// issue #703 —— 发布态探针（`scripts/version-state-probe.mjs`）与 registry 事实注入口子的反向证。
//
// 为什么这条要进 `npm test`：探针本体是**门禁的工具**，它自己坏了没人会发现——而它坏法恰好是
// 「静默全绿」（合成树没建成、桩没落上、断言写歪）。本文件钉四件事：
//   A. **S3 + 矛盾态**跑通（`--fast`，秒级）：S3 只能在全绿的条件下 exit 0，而真 registry 现在只到
//      上一版 ⇒ 「桩被读到」这件事被这一格钉住；矛盾态必须红并点名 `published-claim`，
//      否则「注入没落上」就会长成绿（#210 R2 的「变异不落上算失败」）。
//   B. `--only` 写一个不存在的态 ⇒ exit 2 并列出合法态名（**事实缺位不当绿**，也不静默跑全部）。
//   C. `--registry-json` 指向读不出的文件 ⇒ `docs-drift-check` **exit 2**，不是「跳过 registry」。
//   D. `--registry-json` 给一个假的 latest ⇒ 判定**非零**且点名 `published-claim`——
//      证的是「判据读的是这个桩」（真 registry 现在与文档一致，所以这一刀只有桩落上才会红）。
//      退出码只断言「非零」：`latest` 那一版有没有 tag 取决于本机 tag 面（CI 的浅检出可能一枚都没有），
//      有则 exit 1（红）、没有则 `TAG_MISSING` 抬成 exit 2；两条都算「桩被读了」。
//
// 隔离：合成树写在 `makeTmp()` 的临时目录里（卫生门禁口径），不写仓库、不碰 `.scratch/`、零真实 LLM。
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

test("A. 探针：S3（发布完成）绿 + 矛盾态红并点名 published-claim", { timeout: 600000 }, async () => {
  const out = await makeTmp("version-states-");
  const r = runNode(PROBE, ["--fast", "--only", "S3,contradiction", "--out", out]);
  const body = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, `探针应当两个态都达预期，实测 exit ${r.status}：\n${body.slice(-4000)}`);
  assert.match(body, /S3：发布完成/u, body.slice(-2000));
  assert.match(body, /✓ exit 0（绿）/u, body.slice(-2000));
  assert.match(body, /✓ exit 1（红）/u, body.slice(-2000));
  assert.match(body, /✓ 点名 published-claim/u, body.slice(-2000));
  // S3 的「tagger date = 段首日期」是 #697 的日期↔tag 那一半，落了才算发布完成态成立。
  assert.match(body, /tagger date = /u, body.slice(-2000));
});

test("B. 探针：--only 写错态名 ⇒ exit 2 并列出合法态名（不许静默跑全部）", () => {
  const r = runNode(PROBE, ["--fast", "--only", "S9"]);
  const body = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 2, body.slice(-2000));
  assert.match(body, /没有一个已知态/u, body.slice(-2000));
  assert.match(body, /S1\/S2\/S3\/contradiction/u, body.slice(-2000));
});

test("C. --registry-json 读不出 ⇒ docs-drift-check exit 2（注入的假真值不许当「跳过」）", async () => {
  const dir = await makeTmp("registry-stub-");
  const r = runNode(DRIFT, ["--strict", "--registry-json", join(dir, "not-there.json")]);
  const body = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 2, body.slice(-2000));
  assert.match(body, /--registry-json .*读不出 \/ 解析不了/u, body.slice(-2000));
  assert.match(body, /exit 2（不是跳过）/u, body.slice(-2000));
});

test("D. --registry-json 给假的 latest ⇒ 判定非零并点名 published-claim（桩真的被读）", async () => {
  const dir = await makeTmp("registry-stub-");
  const stub = join(dir, "stale.json");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  // `latest` 选一个「**没有对应 CHANGELOG 段、也没有同名 tag**」的补丁号（0.29.9）：
  // 否则 `TAG_MISSING` 会把这一格从 exit 1 抬成 exit 2（而 exit 2 的分支不印 errors），红的就不是
  // 「发布行说诌」这一条了。versions 里多放两版，是为了让 #697 的日期↔tag 与登记表
  // （`CHANGELOG_DATE_TAG_EXEMPTIONS` 里的 0.19.0 / 0.25.0）不跟着空转 ⇒ 这一刀只测一个判据。
  // 真 registry 现在与文档那句一致（都是 pkg.version）⇒ 只有「判据读了桩」才会红。
  const stale = "0.29.9";
  await writeFile(stub, `${JSON.stringify(
    { latest: stale, versions: ["0.19.0", "0.25.0", stale, pkg.version] }, null, 2)}\n`, "utf8");
  const r = runNode(DRIFT, ["--strict", "--registry-json", stub], { cwd: ROOT });
  const body = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.notEqual(r.status, 0, `桩里的 latest=${stale} 与文档的发布行（${pkg.version}）打架 ⇒ 不许绿，实测 exit ${r.status}`);
  assert.match(body, /published-claim: .*说发布行（`dist-tags\.latest`）是 .*，registry 实测是 0\.29\.9/su, body.slice(-4000));
});
