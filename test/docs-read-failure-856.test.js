// issue #856：**读失败不许变成绿**。
//
// 病：`fileRecord()` 原来把 EACCES / EMFILE / EISDIR 与 ENOENT 一起 `catch { return null; }`，
// 下游十来处 `if (!rec) continue;` 于是静默少扫一份文档 ⇒ 计数型判据（bare-lines 棘轮、符号锚点面、
// cell-axes）的**实测数往下掉** ⇒ 「实测 > 基线」这类红凭空消失 ⇒ **红树被判绿**。
//
// 本文件钉三格：读不出 ⇒ exit 2 且点名 / 同一条件两遍一致 / 不注入时仍绿。
//
// ⚠ 没钉的那一半（如实写）：`ENOENT` 仍走原来那条「锚点是死的」路径——这一半**没有**测试，
// 因为要造「扫描面里的文档不存在」就得改 `PATH_DOCS` 常量或改工作树里的文件。行为上它是
// 按构造不变的（本单只在「非 ENOENT」这一支加了分支，`fileRecord` 的 catch 语义一字未动），
// 但「按构造不变」不是证据，所以不写一格假装它被钉住了。
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = path.join(ROOT, "scripts", "docs-drift-check.mjs");

/** 跑一次 docs-drift-check（离线：不读 registry，免得联网与否改变结论）。 */
function runCheck(env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CHECK, "--offline"], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

test("#856 ① 存在但读不出的文档 ⇒ exit 2 并点名（读不出既不是绿也不是红）", async () => {
  const { code, out } = await runCheck({ ERIX_DOCS_FAULT_READ: "docs/architecture.md" });
  assert.equal(code, 2, `读失败必须是 exit 2（未判定），实测 ${code}：\n${out.slice(-2000)}`);
  assert.match(out, /读不出 — 1 处真值缺位/u, `必须打出「读不出」清单：\n${out.slice(-2000)}`);
  assert.match(out, /docs\/architecture\.md: 读失败（EACCES）/u, "必须点名是哪份文档读不出");
  assert.doesNotMatch(out, /docs-drift-check: OK/u, "读不出时绝不许打 OK 那一行");
});

test("#856 ② 同一棵树、同一条件跑两遍判定必须一致（不许一次绿一次未判定）", async () => {
  const first = await runCheck({ ERIX_DOCS_FAULT_READ: "docs/architecture.md" });
  const second = await runCheck({ ERIX_DOCS_FAULT_READ: "docs/architecture.md" });
  assert.equal(first.code, second.code, `两遍退出码必须一致：${first.code} vs ${second.code}`);
  assert.equal(first.code, 2);
});

test("#856 ③ 不注入时仍是绿（新分支不许把正常树判成未判定）", async () => {
  const { code, out } = await runCheck();
  assert.equal(code, 0, `正常树必须 exit 0，实测 ${code}：\n${out.slice(-2000)}`);
  assert.doesNotMatch(out, /读不出/u);
});
