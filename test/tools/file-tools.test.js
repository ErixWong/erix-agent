// src/tools/file-tools.js 的实现侧测试（issue #184）
// 契约面走通用套件 fileToolsContract；这里只补「库自己的口径」：
// 默认无边界（ADR-009 牢笼归宿主）、env 三件套、无 signal 不让出、大文件有界读不回退成整文件读。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers";

import {
  createFileTools,
  resolveFileReadMaxBytes,
  FILE_READ_MAX_BYTES_DEFAULT,
} from "../../src/tools/file-tools.js";
import { fileToolsContract } from "../contract/file-tools.js";

async function withDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "erix-file-tools-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

fileToolsContract("src/tools/file-tools", { createFileTools });

test("库默认不做 containment：cwd 之外的路径照样可读可写（ADR-009 牢笼归宿主）", async () => {
  await withDirectory(async (cwd) => {
    await withDirectory(async (outside) => {
      await writeFile(join(outside, "notes.txt"), "first\nsecond\n", "utf8");
      const { executeTool } = createFileTools({ cwd });
      assert.equal(await executeTool("readFile", { path: join(outside, "notes.txt") }), "1: first\n2: second");
      assert.match(await executeTool("tree", { path: outside, depth: 1 }), /notes\.txt/u);
      assert.equal(await executeTool("writeFile", { path: join(outside, "w.txt"), content: "ok" }), 2);
    });
  });
});

test("allowRead/allowWrite 非函数是装配错误，直接 TypeError", () => {
  assert.throws(() => createFileTools({ cwd: process.cwd(), allowRead: true }), TypeError);
  assert.throws(() => createFileTools({ cwd: process.cwd(), allowWrite: "no" }), TypeError);
});

test("ERIX_FILE_READ_MAX_BYTES 三件套：合法生效、非法回退、默认值钳进 [1KiB, 4MiB]", () => {
  const previous = process.env.ERIX_FILE_READ_MAX_BYTES;
  try {
    delete process.env.ERIX_FILE_READ_MAX_BYTES;
    assert.equal(resolveFileReadMaxBytes(), FILE_READ_MAX_BYTES_DEFAULT);
    process.env.ERIX_FILE_READ_MAX_BYTES = "8192";
    assert.equal(resolveFileReadMaxBytes(), 8_192);
    process.env.ERIX_FILE_READ_MAX_BYTES = "not-a-number";
    assert.equal(resolveFileReadMaxBytes(), FILE_READ_MAX_BYTES_DEFAULT);
    process.env.ERIX_FILE_READ_MAX_BYTES = "512";        // 低于下限 → 回退默认
    assert.equal(resolveFileReadMaxBytes(), FILE_READ_MAX_BYTES_DEFAULT);
    process.env.ERIX_FILE_READ_MAX_BYTES = "99999999";   // 高于上限 → 回退默认
    assert.equal(resolveFileReadMaxBytes(), FILE_READ_MAX_BYTES_DEFAULT);
    process.env.ERIX_FILE_READ_MAX_BYTES = "4194304";    // 恰好等于上限 → 生效
    assert.equal(resolveFileReadMaxBytes(), 4 * 1024 * 1024);
  } finally {
    if (previous === undefined) delete process.env.ERIX_FILE_READ_MAX_BYTES;
    else process.env.ERIX_FILE_READ_MAX_BYTES = previous;
  }
});

test("readFile 有界读：超大单行与多行大文件都不再整文件读入（防 RangeError/OOM）", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "one-line.txt"), `${"x".repeat(3 * 1024 * 1024)}\nsecond\n`, "utf8");
    await writeFile(
      join(cwd, "many.txt"),
      `${Array.from({ length: 60_000 }, (_, index) => `line ${index}`).join("\n")}\n`,
      "utf8",
    );
    const { executeTool } = createFileTools({ cwd });

    const singleLine = await executeTool("readFile", { path: "one-line.txt", limit: 2 });
    assert.ok(Buffer.byteLength(singleLine, "utf8") <= FILE_READ_MAX_BYTES_DEFAULT);
    assert.match(singleLine, /单行超过/u, "超长行必须回报");
    assert.match(singleLine, /^1: xxx/u, "超长行仍按行号返回截断后的开头");
    assert.match(singleLine, /offset=\d+ 继续/u, "触顶后必须给出继续读的 offset");

    const next = await executeTool("readFile", { path: "one-line.txt", offset: 1, limit: 1 });
    assert.match(next, /^2: second/u, "截断一行不影响后续行的行号与可达性");

    const many = await executeTool("readFile", { path: "many.txt", limit: 5 });
    assert.match(many, /^1: line 0\b/u);
    assert.match(many, /^5: line 4\b/um);
    assert.ok(Buffer.byteLength(many, "utf8") <= FILE_READ_MAX_BYTES_DEFAULT);

    const deep = await executeTool("readFile", { path: "many.txt", offset: 59_000, limit: 2 });
    assert.match(deep, /^59001: line 59000\b/u);
  });
});

test("无 signal 时遍历不插入让出（非中止路径行为与开销零变化）", async () => {
  await withDirectory(async (cwd) => {
    await Promise.all(Array.from({ length: 300 }, async (_, index) => {
      await writeFile(join(cwd, `f${index}.txt`), "needle\n", "utf8");
    }));
    const { executeTool } = createFileTools({ cwd });

    let yielded = false;
    immediate(() => { yielded = true; });
    await executeTool("rg", { pattern: "needle", max_results: 1 });
    assert.equal(yielded, false, "无 signal 却把遍历让回了事件循环，说明 checkpoint 没做「无 signal 零让出」");
  });
});

test("有 signal 时遍历周期让出，中途可被中止（同步遍历不卡死宿主的中止通道）", async () => {
  await withDirectory(async (cwd) => {
    await Promise.all(Array.from({ length: 400 }, async (_, index) => {
      await writeFile(join(cwd, `d${index}`), "needle\n", "utf8");
    }));
    const { executeTool } = createFileTools({ cwd });
    const controller = new AbortController();
    let yielded = false;
    // 本轮只排了一个 immediate：它必然早于遍历自己的第 32 个条目 checkpoint 跑列，
    // 所以「先让出 → 再查到中止」是确定的，不是计时器竞态。
    immediate(() => {
      yielded = true;
      controller.abort();
    });

    const running = executeTool("rg", { pattern: "needle" }, { signal: controller.signal });
    await assert.rejects(running, (error) => error?.name === "AbortError");
    assert.ok(yielded, "有 signal 时每 32 个条目必须让出一次事件循环");
  });
});
