// #532 / #533：两个**观察脚本**的退出码语义钉子。
//
// 病根（两单同一类）：`scripts/*.mjs` 是观察面，不进任何门禁（`test/static-guards.test.js` 规则 7
// 的注释就写着这一句），于是它们可以「import 期就抛」或「对拍恒红」而全仓照样绿：
//   · #532 `notes-why-experiment.mjs` 的 import 站点指着两个在 notes 瘦身（9fd2277）里被改名/删除的
//     符号 ⇒ `node scripts/notes-why-experiment.mjs` 直接 SyntaxError，一行都没跑；
//   · #533 `normalization-parity.mjs` 的 `accumulator-object-arguments` 一格真红（陈旧参照）。
// 这两件事都不在 `npm test` 的视野里，正是它们能烂掉的原因。
//
// 本文件只钉**退出码与分类**（脚本内部的判据不在这里重复；对拍的具体格子在脚本自己里）：
//   · 对拍脚本 ⇒ 0，且真的把每一格都比过了（打印 `PASS: N/N fixtures compared`）；
//   · 真模型脚本、闸口未开 ⇒ **0** + `[skip]` 分类说明（不是「启动期抛错」伪装成 skip）；
//   · 真模型脚本、闸口开但没有可用模型配置 ⇒ **非 0** + 分类原因（真失败不许报绿）。
//
// 隔离：第三例把 `HOME` / `XDG_CONFIG_HOME` 指到一棵**不存在**的路径上（脚本只读
// `<home>/.erix/config.json`，读到 ENOENT 就当空配置；这一路在 dry-run 返回前不会写任何东西），
// 所以不碰真 `~/.erix`，也不需要临时目录。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 跑一份 `scripts/` 下的脚本，返回退出码与两路输出。
 *
 * @param {string} script `scripts/` 下的文件名
 * @param {Record<string, string>} [env] 覆盖的环境变量（其余继承本进程）
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runScript(script, env = {}) {
  const child = spawnSync(process.execPath, [path.join("scripts", script)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return {
    status: child.status,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}

test("#533: normalization-parity 真跑完并退出 0（每一格都比过，含已登记的 #409 增量）", () => {
  const result = runScript("normalization-parity.mjs");
  assert.equal(result.status, 0,
    `scripts/normalization-parity.mjs 必须退出 0，实测 ${result.status}\n`
    + `${result.stderr.slice(0, 2000)}`);
  // 「跑过」而不是「什么都没做就绿」：10 格逐格点名，且明说其中 1 格带已登记的 #409 增量。
  assert.match(result.stdout, /PASS: 10\/10 fixtures compared/u);
  assert.match(result.stdout, /9 byte-identical, 1 with a documented #409 delta/u);
  assert.match(result.stdout, /accumulator-object-arguments: parity outside the documented #409 delta/u);
});

test("#532: notes-why 闸口未开 ⇒ 退出 0 + [skip] 分类说明（不是启动期抛错）", () => {
  const result = runScript("notes-why-experiment.mjs", { ERIX_E2E_REAL: "" });
  assert.equal(result.status, 0,
    `闸口未开时必须退出 0，实测 ${result.status}\n${result.stderr.slice(0, 2000)}`);
  assert.match(result.stdout, /\[skip\] ERIX_E2E_REAL/u);
  // 反向面：这一路不许出现 import 期的 SyntaxError（#532 的病根形状）。
  assert.doesNotMatch(result.stderr, /SyntaxError/u);
});

test("#532: notes-why 闸口开但无可用模型配置 ⇒ 非 0 + 分类原因（真失败不许报绿）", () => {
  const missingHome = path.join(ROOT, "test", ".no-home-532-533");
  const result = runScript("notes-why-experiment.mjs", {
    ERIX_E2E_REAL: "1",
    HOME: missingHome,
    XDG_CONFIG_HOME: "",
    ERIX_EXPERIMENT_MODEL: "",
  });
  assert.notEqual(result.status, 0,
    "闸口开着又跑不了时必须非 0（一份没跑的实验不许报绿）");
  assert.match(result.stderr, /未找到实验模型/u,
    `非 0 必须带分类原因，实测 stderr：${result.stderr.slice(0, 500)}`);
});
