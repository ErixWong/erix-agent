// issue #394：结清尾部悬空 `tool_use` 的**共享实现**（`src/loop/pending-tool-result.js`）。
//
// 本文件钉两类事实：
//   ① 结构判据（静态）：造「`is_error` 收尾 `tool_result`」的构造点全仓只有一处、配对判据只有
//      一份（R1 的 grep 判据 + R5 的「两个注入点共用同一实现」）；
//   ② 行为（R5）：兄弟洞正面、入账形状、默认关的退出码面。
// 三条注入点的行为锚在别处：#394 的强制收尾在 `test/loop-forced-final-pending-tool-use.test.js`，
// 中途扩轮 / guard 补跑桥在 `test/loop-guard-extend.test.js`。
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SHARED = "src/loop/pending-tool-result.js";

/** `src/` 下全部 `.js`（相对路径，正斜杠）。 */
function srcFiles(dir = "src", acc = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) srcFiles(rel, acc);
    else if (name.endsWith(".js")) acc.push(rel);
  }
  return acc;
}

const files = srcFiles().sort();
const textOf = (rel) => readFileSync(join(ROOT, rel), "utf8");

test("#394 R1 结构判据：造「is_error 收尾 tool_result」的构造点全仓只有一处（共享实现）", () => {
  // 正文常量的**定义**只有一处（`export const`，不是再导出）。
  const definitions = files.filter((rel) => (
    /export const PENDING_TOOL_RESULT_TEXT\s*=/u.test(textOf(rel))
  ));
  assert.deepEqual(definitions, [SHARED],
    "`PENDING_TOOL_RESULT_TEXT` 的定义点必须唯一（第二份正文就是第二份事实）");

  // 构造点：`buildToolResultFact({ … PENDING_TOOL_RESULT_TEXT … })`。块内没有嵌套花括号，
  // 所以这个正则正好圈住「用那条正文造结果块」的那一个调用，不会误伤普通结果构造。
  const construction = /buildToolResultFact\(\{(?:[^{}]*)PENDING_TOOL_RESULT_TEXT(?:[^{}]*)\}\)/gu;
  const sites = [];
  for (const rel of files) {
    const hits = [...textOf(rel).matchAll(construction)];
    for (let index = 0; index < hits.length; index += 1) sites.push(rel);
  }
  assert.deepEqual(sites, [SHARED],
    `「造 is_error 收尾 tool_result」的构造点必须全仓唯一，实测 ${JSON.stringify(sites)}`);
});
