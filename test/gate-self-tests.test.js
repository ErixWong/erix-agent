// @ts-check
/**
 * 闸自己的反向证与几秒级的代码面判据，搬进 `npm test`（issue #908 R2，261126 用户裁决）。
 *
 * 为什么要搬：这棵树的 CI 只有 `workflow_dispatch`（自动触发已被关掉），main 的 ruleset 也不要求
 * 任何 status check ⇒ **「只在 CI 跑」在这棵树上的意思就是「哪儿都不跑」**。下面每一条都是
 * 秒级、且不依赖干净环境的判据：它们在 CI 里当一步，除了等人点按钮以外没有任何作用；搬进
 * 套件之后，每次 `npm test`（本地、worker、派单验收、CI）都跑一遍。
 *
 * 逐条来路（撤掉的 CI 步骤 ↔ 这里，一一对得上，去处也写在 `.github/workflows/ci.yml` 的头注释里）：
 *   · `scripts/syntax-check.mjs`                    ← CI 步骤 `check:syntax`
 *   · `scripts/test-hygiene-check.mjs`（验证态）    ← CI 步骤 `check:tests`
 *   · `scripts/test-hygiene-check.mjs --self-test`  ← CI 步骤 "Test hygiene guard self-test"
 *   · `scripts/mutation-sample-check.mjs --self-test` ← CI 步骤 "Mutation sample check self-test"
 *   · `scripts/pack-link-check.mjs --self-test`     ← CI 步骤 "Pack-link contract publish-surface self-test"
 *   · `scripts/config-leaf-value-probe.mjs --verify` ← CI 步骤 "Config-leaf value status verify"
 *
 * 刻意**不**在这里跑的三件，各自有更强的家：
 *   · `docs-drift-check --self-test` —— 实测 512s（219 例，每例重扫全树），进套件会把 70s 拖成 580s；
 *     它已经在 `npm run docs:pass` 里（周期性 agent pass，`docs/maintenance/doc-review-pass.md`）。
 *   · `check:release` / `check:pack-links` 的**门禁本体** —— 要真 tarball 与真装包，干净环境才可信。
 *   · `guide-removal-gate --self-test` / `release-day --self-test` —— 套件里已有格子 spawn（见
 *     `test/guide-removal-gate.test.js` 与 `test/release-day.test.js`），这里不重复。
 *
 * 断言口径：只断「退出码 0」+「那一行的 `<脚本名> --self-test: OK` 前缀」。脚本自己打印的
 * **例数**（13 / 19 / 18 这类）不抄进来——抄一个数字，就等于给每次加例的人埋一颗「文档改口」的雷。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 跑一条闸，把「没跑成」和「跑成了但判红」分开报：`status === null` 是被信号杀掉或压根没起来，
 * 那种情况说「exit=1」会误导下一任读者。
 *
 * @param {string[]} argv 形如 ["scripts/syntax-check.mjs"] 或带旗标的完整参数
 * @param {string} okLine 输出里必须出现的一行前缀（自述行，不是数字）
 * @returns {void}
 */
function runGate(argv, okLine) {
  const r = spawnSync(process.execPath, argv, {
    cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const tail = out.trimEnd().split("\n").slice(-6).join("\n      ");
  assert.equal(
    r.signal,
    null,
    `${argv.join(" ")} 被信号 ${String(r.signal)} 打断（不是判红，是没跑完）：\n      ${tail}`,
  );
  assert.equal(r.status, 0, `${argv.join(" ")} exit=${String(r.status)}，应当 exit 0：\n      ${tail}`);
  assert.ok(
    out.includes(okLine),
    `${argv.join(" ")} 退出码 0 但没自述「${okLine}」——它跑的是哪条路？：\n      ${tail}`,
  );
}

test("语法闸：全部跟踪的 .js/.mjs/.cjs 过 `node --check`（原 CI 步骤 `check:syntax`）", () => {
  runGate(["scripts/syntax-check.mjs"], "syntax-check: OK");
});

test("测试卫生闸：test/** 里没有裸 mkdtemp 与 /tmp 字面量首参（原 CI 步骤 `check:tests`）", () => {
  runGate(["scripts/test-hygiene-check.mjs"], "test-hygiene-check: OK");
});

test("测试卫生闸的反向证（原 CI 步骤 \"Test hygiene guard self-test\"）", () => {
  runGate(["scripts/test-hygiene-check.mjs", "--self-test"], "test-hygiene-check --self-test: OK");
});

test("变异样本闸的反向证：合成树上咬得住、放行证也放行（原 CI 步骤）", () => {
  runGate(["scripts/mutation-sample-check.mjs", "--self-test"], "mutation-sample-check --self-test: OK");
});

test("随包面闸的反向证：`files`/`exports` 判据自己没坏（原 CI 步骤）", () => {
  runGate(["scripts/pack-link-check.mjs", "--self-test"], "pack-link-check --self-test: OK");
});

test("配置叶现状表与实测一致（原 CI 步骤 `check:config-leaf-values`）", () => {
  runGate([
    "scripts/config-leaf-value-probe.mjs", "--verify",
    "docs/config-leaf-value-status.md", "docs/config-leaf-value-status_cn.md",
  ], "表与实测一致");
});

test("边界：搬进来的这几条不得再回到 CI 当步骤（重复的一次红会盖住真判据）", () => {
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  // 逐行比对而不拼正则：这些命令里全是 `-` 与 `.`，转义集写错一次就拼出非法正则（#908 R2 现场）。
  const runLines = new Set(
    ci.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("run:")).map((l) => l.slice(4).trim()),
  );
  for (const cmd of [
    "npm run check:syntax",
    "npm run check:tests",
    "node scripts/test-hygiene-check.mjs --self-test",
    "node scripts/mutation-sample-check.mjs --self-test",
    "node scripts/pack-link-check.mjs --self-test",
    "npm run check:config-leaf-values",
    "npm run check:changelog",
    "npm run check:inventory",
  ]) {
    assert.ok(
      !runLines.has(cmd),
      `CI 里又有 \`${cmd}\` 这一步了：它现在由本文件（或版本边界）承担，回到 CI 只会多一处红源`,
    );
  }
});
