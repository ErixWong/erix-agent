// issue #689 的**发版日命令**测试：`scripts/release-day.mjs` 的整链路钉子。
//
// 分工（与 `test/host-consumer-probe.test.js` / `test/guide-removal-gate.test.js` 同一套惯例）：
//   - **反向证**（preflight 某步红就停在那一步并点名、闸门关着的真上游与不在的 `--hosts` 目录判「未判定」、
//     回写失败留下「已发布、未回写」的状态且重跑从 writeback 续、没回写就 finalize 必须红、两侧 ls-remote
//     不一致必须红、`--dry` 一个字节都不写、`--sync` 只动发布态那几句）都在
//     `node scripts/release-day.mjs --self-test` 里（合成树 + 假 runner，全离线）。这里只 spawn 它一次并断言
//     exit 0——本文件**不**重复那些判据（写两份只会让两边一起腐烂）。
//   - 本文件钉的是**命令行这一层**：参数闸、阶段顺序闸、以及「不该动盘的时候真的没动盘」。
//   - 卫生：状态文件一律指进 `test/helpers/tmp.js` 的 `makeTmp()`，绝不碰 `$RUNNER_TEMP` 里的真状态；
//     仓内源码全程只读（finalize 那条用例走的是「顺序闸先红」，所以连 `git tag` 都不会执行）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTmp } from "./helpers/tmp.js";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));
const SCRIPT = fileURLToPath(new URL("../scripts/release-day.mjs", import.meta.url));

function runScript(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT, ...options });
}

test("--help：四个阶段与退出码都写清，exit 0", () => {
  const result = runScript(["--help"]);
  assert.equal(result.status, 0, `--help 必须 exit 0：\n${result.stdout}\n${result.stderr}`);
  for (const stage of ["preflight", "publish", "writeback", "finalize"]) {
    assert.match(result.stdout, new RegExp(`--stage ${stage}`, "u"), `--help 要点名 ${stage} 阶段`);
  }
  assert.match(result.stdout, /3 preflight 全绿、等你发布/u, "退出码 3 = 等人工发布，必须写清（否则会被读成失败）");
});

test("参数闸：什么都不给 ⇒ exit 2 并打用法（不是 0，也不是 1）", () => {
  const result = runScript([]);
  assert.equal(result.status, 2, `无参数必须 exit 2（参数不足 = 未判定）：\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /--stage|--all|--self-test/u, "要说清合法的入口");
});

test("顺序闸：没有 preflight 状态就直接 publish ⇒ 红，且不起任何子进程", async () => {
  const dir = await makeTmp("erix-release-day-test-");
  const stateFile = join(dir, "state.json");
  const result = runScript(["--stage", "publish", "--state", stateFile], {
    env: { ...process.env, RELEASE_DAY_STATE: stateFile },
  });
  assert.equal(result.status, 1, `没有 preflight 状态时 publish 必须红：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /顺序闸/u, "红的原因要点名顺序闸（不是含糊的「失败了」）");
  assert.match(result.stdout, /--stage preflight/u, "要说清先跑哪一步");
});

test("writeback 不给 --published ⇒ exit 2、不写状态文件、不跑 --sync", async () => {
  const dir = await makeTmp("erix-release-day-test-");
  const stateFile = join(dir, "state.json");
  const result = runScript(["--stage", "writeback", "--state", stateFile, "--version", "0.30.0"], {
    env: { ...process.env, RELEASE_DAY_STATE: stateFile },
  });
  assert.equal(result.status, 2, `缺 --published 必须 exit 2：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /--published/u, "要说清缺的是哪个真值");
  assert.equal(existsSync(stateFile), false, "真值缺位时不许留下状态文件（那会被 --all 当成「已发布」）");
});

test("顺序闸：没有「已发布 + 已回写」的状态就 finalize ⇒ 红（不许没发布就打 tag）", async () => {
  const dir = await makeTmp("erix-release-day-test-");
  const stateFile = join(dir, "state.json");
  const result = runScript(["--stage", "finalize", "--state", stateFile], {
    env: { ...process.env, RELEASE_DAY_STATE: stateFile },
  });
  assert.equal(result.status, 1, `没有状态文件时 finalize 必须红：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /顺序闸/u, "红的原因要点名顺序闸");
  assert.match(result.stdout, /phase=written/u, "要说清缺的是哪个相位");
  assert.equal(existsSync(stateFile), false, "finalize 红了不许写状态文件");
});

test("--self-test：离线反向证 exit 0", () => {
  const result = runScript(["--self-test"]);
  assert.equal(result.status, 0, `--self-test 必须绿：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /release-day --self-test: OK/u);
});

test("npm script、中英 AGENTS 与 CI 三处接线（成对，且说明里不抄判据条数）", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["release:day"], "node scripts/release-day.mjs", "npm script 必须指向这个脚本");
  for (const doc of ["AGENTS.md", "AGENTS_cn.md"]) {
    const rows = readFileSync(join(ROOT, doc), "utf8")
      .split("\n").filter((line) => line.startsWith("| `npm run release:day` |"));
    assert.equal(rows.length, 1, `${doc} 的「开发命令」表里要有且只有一行 \`npm run release:day\`（中英成对）`);
    assert.match(rows[0], /scripts\/release-day\.mjs/u, `${doc} 那一行要点名脚本（check:docs 会核这个路径存在）`);
    assert.match(rows[0], /--stage/u, `${doc} 那一行要写清阶段口径`);
    assert.match(rows[0], /--sync/u, `${doc} 那一行要写清回写面是 --sync（窄面纪律的落点）`);
    assert.doesNotMatch(rows[0], /\d+\s*条判据/u, `${doc} 那一行不许抄判据条数（条数由命令自己打印）`);
  }
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /name: Release-day command self-test\n\s+run: node scripts\/release-day\.mjs --self-test/u,
    "CI 要有这一步阻塞自测（issue #689 的接线要求）");
});
