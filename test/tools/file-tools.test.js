// src/tools/file-tools.js 的实现侧测试（issue #184）
// 契约面走通用套件 fileToolsContract；这里只补「库自己的口径」：
// 默认无边界（ADR-009 牢笼归宿主）、env 三件套、无 signal 不让出、大文件有界读不回退成整文件读、
// rg/grep 默认正则与真实命令同口径（#184 追加轮 A，含 schema 描述真值）。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile as readFilePromise, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers";
import { fileURLToPath } from "node:url";
import { makeTmp } from "../helpers/tmp.js";

import {
  createFileTools,
  resolveFileReadMaxBytes,
  formatSize,
  toolMarker,
  FILE_READ_MAX_BYTES_DEFAULT,
  FILE_TOOL_DEFINITIONS,
} from "../../src/tools/file-tools.js";
import { estimateTokens } from "../../src/tokens.js";
import { fileToolsContract, withoutTokenEstimate, TOKEN_ESTIMATE_LINE } from "../contract/file-tools.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

async function withDirectory(callback) {
  const directory = await makeTmp("erix-file-tools-");
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
      assert.equal(withoutTokenEstimate(await executeTool("readFile", { path: join(outside, "notes.txt") })), "1: first\n2: second");
      assert.match(await executeTool("tree", { path: outside, depth: 1 }), /notes\.txt/u);
      assert.equal(await executeTool("writeFile", { path: join(outside, "w.txt"), content: "ok" }), 2);
    });
  });
});

test("rg 默认与真实命令一致：正则默认，is_regex=false 才等价 rg --fixed-strings（#184 追加轮 A）", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "s.txt"), "a.b\naxb\nfoo|bar\n", "utf8");
    const { executeTool, definitions } = createFileTools({ cwd });
    const hits = (output) => output.split("\n").filter((line) => line.startsWith("s.txt:"));

    // 默认（不传 is_regex）= 正则，与 `rg` 二进制自己的默认一致
    assert.deepEqual(hits(await executeTool("rg", { pattern: "a.b" })), ["s.txt:1:a.b", "s.txt:2:axb"]);
    // 显式 is_regex=true 与默认逐字一致 → 默认值真的就是 true
    assert.equal(await executeTool("rg", { pattern: "a.b", is_regex: true }), await executeTool("rg", { pattern: "a.b" }));
    // 逃生口 is_regex=false 才收窄到字面量（= rg --fixed-strings / grep -F）
    assert.deepEqual(hits(await executeTool("rg", { pattern: "a.b", is_regex: false })), ["s.txt:1:a.b"]);
    assert.deepEqual(hits(await executeTool("rg", { pattern: "foo|bar", is_regex: false })), ["s.txt:3:foo|bar"]);

    // 默认口径靠 schema 描述落地：正则默认 + 真实旗标名 + 与真实命令的能力差异
    const rg = definitions.find((definition) => definition.name === "rg");
    assert.match(rg.description, /regular expression/u);
    assert.match(rg.description, /--fixed-strings/u);
    assert.match(rg.description, /\.gitignore is NOT read/u);
    assert.match(rg.inputSchema.properties.is_regex.description, /Default true/u);
    const grep = definitions.find((definition) => definition.name === "grep");
    assert.match(grep.description, /grep -E/u);
    assert.match(grep.description, /grep -F/u);
    assert.match(grep.inputSchema.properties.is_regex.description, /Default true/u);

    // 行宽上限也靠描述落地（#184 追加轮 A 收口第三条）：两个工具都写明上限、都写明它是本实现的
    // 输出预算而不是真实命令的行为，且两边描述同口径。
    for (const definition of [rg, grep]) {
      assert.match(definition.description, /whole up to 500 characters/u, `${definition.name} 描述必须写明行宽上限`);
      assert.match(definition.description, /this implementation's own output budget/u, `${definition.name} 必须说明上限是本实现的默认值`);
      assert.match(definition.description, /never truncates lines/u, `${definition.name} 必须说明真实命令不截行`);
    }

    // grep 默认未动：同库两个搜索工具默认相反正是本轮要修掉的反常，现在两边都是正则
    assert.match(await executeTool("grep", { pattern: "a.b" }), /2: axb/u);
  });
});

test("grep 命中行截断上限是 500 字符，rg 共用同一个数（#184 追加轮 A：200 会把正常代码行截成半行；收口第三条抹平 rg 不截行）", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "long.txt"), `needle ${"y".repeat(800)}\n`, "utf8");
    await writeFile(join(cwd, "normal.txt"), `needle ${"z".repeat(400)}\n`, "utf8"); // 407 字符：旧上限下只剩 200
    const { executeTool } = createFileTools({ cwd });

    const hit = (await executeTool("grep", { pattern: "needle", path: cwd, glob: "long.txt" }))
      .split("\n").find((line) => line.startsWith("1: "));
    assert.equal(hit.length, 3 + 500 + 1, `必须按 500 字符截断（+3 前缀 +1 省略号），实得到 ${hit.length}`);
    assert.ok(hit.endsWith("…"), "截断必须留省略号尾巴");

    const normal = await executeTool("grep", { pattern: "needle", path: cwd, glob: "normal.txt" });
    assert.ok(normal.includes(`1: needle ${"z".repeat(400)}`), "407 字符的行在新上限下必须完整返回");
    assert.doesNotMatch(normal, /…/u);

    // rg 现在与 grep 共用同一个上限（#184 追加轮 A 收口第三条）：807 字符的行也得截到 500 + `…`
    const rgHit = (await executeTool("rg", { pattern: "needle", path: cwd }))
      .split("\n").find((line) => line.startsWith("long.txt:1:"));
    assert.equal(
      rgHit.length,
      "long.txt:1:".length + 500 + 1,
      `rg 必须按同一个 500 上限截断（+11 前缀 +1 省略号），实得到 ${rgHit.length}`,
    );
    assert.ok(rgHit.endsWith("…"), "rg 截断也必须留省略号尾巴");
    assert.doesNotMatch(
      await executeTool("rg", { pattern: "needle", path: join(cwd, "normal.txt") }),
      /…/u,
      "rg：407 字符的行在新上限下必须完整返回、不得带省略号",
    );
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

// ── edit（issue #191）：库自己的口径 ───────────────────────────────────────────
// 契约面（形状容忍 / 精确匹配 / 对原文匹配 / BOM+CRLF / 边界谓词）在 fileToolsContract 里；
// 这里只钉本实现的输出预算与护栏：结果首行摘要、短 diff、截断 marker、体积与条数上限、
// 以及「任何失败都是错误结果而不是 throw」。

test("edit 返回短 unified diff：首行摘要 + @@ 段 + 3 行上下文 + 首个变更行（#191）", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "a.txt"), Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n", "utf8");
    const { executeTool } = createFileTools({ cwd });

    const output = await executeTool("edit", { path: "a.txt", edits: [{ oldText: "l10", newText: "TEN" }] });
    const [header, ...rest] = output.split("\n");
    assert.match(header, /^已编辑 a\.txt，替换 1 处，首个变更行 10，写入 \d+ 字节$/u, header);
    assert.deepEqual(rest.slice(0, 2), ["--- a/a.txt", "+++ b/a.txt"], "diff 要有文件头，模型才知道改的是哪份");
    assert.match(rest[2], /^@@ -\d+,7 \+\d+,7 @@$/u, `3 行上下文的 hunk 头：${rest[2]}`);
    const changed = rest.slice(2).filter((line) => line.startsWith("-") || line.startsWith("+"));
    assert.deepEqual(changed, ["-l10", "+TEN"], "变更行只有这两条（文件头 --- / +++ 不算）");
    const context = rest.filter((line) => line.startsWith(" ") && line.trim() !== "");
    assert.equal(context.length, 6, `变更两侧各 3 行上下文，实际 ${context.length}：${output}`);
    // diff 是「不必回读就能自证」的最小凭证：一次单行替换不该回显整份文件
    // 1 处单行变更 = 摘要 1 行 + 文件头 2 行 + hunk 头 1 行 + 上下文 6 行 + 变更 2 行 = 12 行；
    // 20 行的文件若整份回显会是 20+ 行，所以这个上限只可能钉住「短 diff」而不是「整文件」。
    assert.ok(output.split("\n").length < 15, `diff 必须短：${output.split("\n").length} 行`);
  });
});

test("edit 的多个相邻变更归并进同一个 hunk，远离的分成多段（#191）", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "a.txt"), Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join("\n") + "\n", "utf8");
    const { executeTool } = createFileTools({ cwd });

    const near = await executeTool("edit", { path: "a.txt", edits: [
      { oldText: "l5", newText: "A" },
      { oldText: "l7", newText: "B" },
    ] });
    assert.equal((near.match(/^@@ /gmu) ?? []).length, 1, "上下文相接的两处必须归并，别把同一行回显两遍");
    assert.match(near, /首个变更行 5/u);

    const far = await executeTool("edit", { path: "a.txt", edits: [
      { oldText: "A", newText: "l5" },
      { oldText: "l30", newText: "C" },
    ] });
    assert.equal((far.match(/^@@ /gmu) ?? []).length, 2, "隔得远的两处各成一个 hunk");
  });
});

test("edit 的 diff 有段数与行数预算，超了带 marker 与剩余计数（#191）", async () => {
  await withDirectory(async (cwd) => {
    // 行名补零到 3 位：否则 "l1" 会同时命中 l1/l10/l100，测试就变成在测唯一性了
    const lines = Array.from({ length: 400 }, (_, i) => `l${String(i + 1).padStart(3, "0")}`);
    await writeFile(join(cwd, "a.txt"), lines.join("\n") + "\n", "utf8");
    const { executeTool } = createFileTools({ cwd });

    // 20 处分散变更：段数超过 EDIT_DIFF_MAX_CHUNKS(8) 就必须截断并回报剩余
    const output = await executeTool("edit", { path: "a.txt", edits: Array.from({ length: 20 }, (_, i) => ({
      oldText: `l${String(i * 20 + 1).padStart(3, "0")}`, newText: `X${i}`,
    })) });
    assert.equal((output.match(/^@@ /gmu) ?? []).length, 8, `段数上限 8：${output.slice(0, 200)}`);
    assert.match(output, /\[diff 已截断：另有 12 处变更未显示/u, output.split("\n").at(-1));
    assert.match(output, /readFile/u, "截断 marker 要给取回路径（ADR-010：去噪必须可撤销）");
    // 截断只砍 diff 回显，不砍实际写入：20 处都得真的落盘
    const content = await readFilePromise(join(cwd, "a.txt"), "utf8");
    for (let i = 0; i < 20; i += 1) assert.ok(content.includes(`X${i}`), `第 ${i} 处必须真的写进去`);

    // 行数预算：三段各 80/90 行的变更合起来超过 EDIT_DIFF_MAX_LINES(200)。
    // 换一个干净文件做：上面那 20 处已经改过 a.txt，精确匹配的世界里没有"大概还是原文"。
    await writeFile(join(cwd, "b.txt"), lines.join("\n") + "\n", "utf8");
    const block = (from, to) => lines.slice(from - 1, to).join("\n");
    const three = await executeTool("edit", { path: "b.txt", edits: [
      { oldText: block(1, 80), newText: "B1" },
      { oldText: block(120, 200), newText: Array.from({ length: 90 }, (_, i) => `n${i}`).join("\n") },
      { oldText: block(300, 380), newText: "B3" },
    ] });
    assert.match(three, /^已编辑 b\.txt，替换 3 处，首个变更行 1/u, three.slice(0, 160));
    assert.match(three, /\[diff 已截断：另有 \d+ 处变更未显示，diff 行数上限 200 已达/u, three.split("\n").at(-1));
    const written = await readFilePromise(join(cwd, "b.txt"), "utf8");
    assert.ok(written.includes("B3"), "行数截断同样不许影响实际写入");
  });
});

test("edit 有整文件载入上限与单次条数上限，超限给下一步而不是抛（#191）", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "big.txt"), "x".repeat(5 * 1024 * 1024), "utf8");
    await writeFile(join(cwd, "small.txt"), "solo\n", "utf8");
    const { executeTool } = createFileTools({ cwd });

    const tooBig = await executeTool("edit", { path: "big.txt", edits: [{ oldText: "xxx", newText: "yyy" }] });
    assert.match(String(tooBig), /^错误：/u);
    assert.match(String(tooBig), /超过 edit 的整文件载入上限 4194304 字节/u);
    assert.match(String(tooBig), /writeFile/u, "超限要给出下一步（分段确认 / 整写）");

    const tooMany = await executeTool("edit", { path: "small.txt", edits: Array.from({ length: 65 }, (_, i) => ({
      oldText: `nope${i}`, newText: "x",
    })) });
    assert.match(String(tooMany), /^错误：/u);
    assert.match(String(tooMany), /超过单次上限 64 条/u);
  });
});

test("edit 对二进制、目录、不存在的目标一律返回错误结果并给下一步（#191）", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "bin.dat"), Buffer.from([0x61, 0x00, 0x62]));
    const { executeTool } = createFileTools({ cwd });

    assert.match(String(await executeTool("edit", { path: "bin.dat", edits: [{ oldText: "a", newText: "b" }] })),
      /含 NUL 字节/u);
    assert.match(String(await executeTool("edit", { path: "ghost.txt", edits: [{ oldText: "a", newText: "b" }] })),
      /^错误：edit 读不到 ghost\.txt（ENOENT）/u);
    assert.match(String(await executeTool("edit", { path: "ghost.txt", edits: [{ oldText: "a", newText: "b" }] })),
      /新建请用 writeFile/u);
    assert.match(String(await executeTool("edit", { path: ".", edits: [{ oldText: "a", newText: "b" }] })),
      /EISDIR/u);
    assert.match(String(await executeTool("edit", { edits: [{ oldText: "a", newText: "b" }] })),
      /^错误：edit 的 path 必须是非空字符串/u);
    assert.match(String(await executeTool("edit", { path: "ghost.txt", edits: [] })),
      /edits 是空数组/u);
  });
});

test("edit 混合行尾：写回统一成 CRLF，不做逐行保留（口径已写进描述与契约，#191）", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "mixed.txt"), "a\nb\r\nc\r\n", "utf8");
    const { executeTool } = createFileTools({ cwd });

    const output = await executeTool("edit", { path: "mixed.txt", edits: [{ oldText: "a", newText: "A" }] });
    assert.match(output, /^已编辑/u);
    assert.match(output, /CRLF 行尾已保留/u, "结果要自报行尾被统一过，不当隐藏行为");
    assert.equal(await readFilePromise(join(cwd, "mixed.txt"), "utf8"), "A\r\nb\r\nc\r\n");
  });
});

// issue #196 R2：字节数人类可读。单位标签按 issue 规格写 KB/MB，基数是 1024。
test("formatSize：边界表（<1KB / 整 KB / 跨 MB / 跨 GB / 跨 TB / 非整除 / 舍入晋级 / 非法值）", () => {
  const cases = [
    [0, "0B"],                                  // 零不是「0KB」
    [1, "1B"],
    [512, "512B"],                               // <1024 原样带 B
    [1023, "1023B"],                             // 边界内侧仍走 B
    [1024, "1KB"],                               // 整 KB 无空格
    [2048, "2KB"],
    [3072, "3KB"],                               // 3 × 1024 整除
    [1536, "2KB"],                               // 非整除 → 按 KB 四舍五入（1.5 → 2）
    [1535, "1KB"],                               // 1.499KB → 舍到 1KB（四舍五入按整数比）
    [1025, "1KB"],                               // 刚过 1KB 不写成 1025B 的 KB 版
    [262_144, "256KB"],                          // readFile 的默认上限（可读形式）
    [1_048_575, "1.0MB"],                        // 1024KB 进位 → 晋级 MB，不产出「1024KB」
    [1_048_576, "1.0MB"],                        // 恰好 1MB → 一位小数
    [1_572_864, "1.5MB"],                        // 跨 MB 保留一位小数
    [2_621_440, "2.5MB"],
    [4_194_304, "4.0MB"],                        // max_bytes 硬顶 4MiB 的可读形式
    // 追加轮 R6：GB / TB 两档。判据与 MB 同规则（一位小数 + **渲染后**到 1024 就晋级上一档），
    // 所以边界内侧留在 MB、进位的那个数换档——「1024.0MB」与「953674.3MB」都是没单位等于没单位。
    [1_072_693_248, "1023.0MB"],                 // 1023MB：GB 档边界内侧
    [1_073_741_823, "1.0GB"],                    // 1024MB 差 1 字节 → 进位晋级 GB，不产出 1024.0MB
    [1_073_741_824, "1.0GB"],                    // 恰好 1GB
    [1_610_612_736, "1.5GB"],                    // 跨 GB 保留一位小数
    [1_099_511_627_776, "1.0TB"],                // 恰好 1TB（1024GB → 晋级）
    [1_649_267_441_664, "1.5TB"],
    [1_000_000_000_000, "931.3GB"],              // 1e12：修复前是 953674.3MB（六位数单位）
    [-5, "0B"],                                  // 非法值不 producing 负数
    [Number.NaN, "0B"],
    [Number.POSITIVE_INFINITY, "0B"],
  ];
  for (const [bytes, expected] of cases) {
    assert.equal(formatSize(bytes), expected, `formatSize(${bytes})`);
  }
  // 结果里绝不会出现空格分隔的单位，也不会同时给两份数（模型对账只用一个数）
  for (const [bytes] of cases) {
    assert.doesNotMatch(formatSize(bytes), /\s/u, `formatSize(${bytes}) 单位不得带空格`);
  }
  // 档位齐全且互不重叠：每一档都得真的能出现（写死到 MB 的旧实现给不出 GB/TB → 这条会红）
  const units = new Set(cases.map(([, rendered]) => rendered.replace(/^[\d.]+/u, "")));
  for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
    assert.ok(units.has(unit), `边界表里没有 ${unit} 档的样本 → 该档没被测到`);
  }
  // 真值随调用变化：不同上限必须给不同可读值（模板占位过不了这条）
  assert.notEqual(formatSize(4_096), formatSize(8_192));
  assert.equal(formatSize(FILE_READ_MAX_BYTES_DEFAULT), "256KB");
});

test("readFile 的 marker 不带裸字节数，且长路径下仍守住 max_bytes（#196 R2 预算侧）", async () => {
  await withDirectory(async (cwd) => {
    const deep = join(cwd, "a-very-long-directory-name-for-marker-budget-probing", "nested");
    await mkdir(deep, { recursive: true });
    const longName = `${"wide".repeat(30)}.txt`;
    await writeFile(join(deep, longName), `${"q".repeat(200_000)}\nlast\n`, "utf8");
    const { executeTool } = createFileTools({ cwd });
    const output = await executeTool("readFile", { path: join("a-very-long-directory-name-for-marker-budget-probing", "nested", longName), limit: 2, max_bytes: 4_096 });
    assert.ok(Buffer.byteLength(output, "utf8") <= 4_096, `marker 变长后仍不得突破上限：${Buffer.byteLength(output, "utf8")}`);
    assert.match(output, /单行超过/u);
    assert.doesNotMatch(output, /(?<![\d.])4096(?!\d)/u);
  });
});

// ---------------------------------------------------------------------------
// issue #267（**剩下一半**）：中英契约文档引用的 readMoreLines marker 字面必须与源码产出同源。
//
// ⚠ 2026-11-17 issue #628：本段原本还有一格「描述的 token 三档与当场复测一致」（把 `~190` /
//   `~2,493` / `~4,773` 三个**写死真实文件**的复测值钉在描述上，密实档的锚点是
//   `src/tools/file-tools.js` **自己**——改这段注释就会改掉它自己声称的数，自指）。
//   描述去数字化之后那三个数已不在模型可见面上，那一格连同 `READ_TOKEN_SAMPLES` 与
//   `measureReadWindowTokens` 一并删除；token 额度现在由估算器公式推出，对账判据见下面
//   「#628 守卫 2」。契约文档那格与 token 数字无关（它钉的是 marker 字面），原样保留。
// ---------------------------------------------------------------------------

// #264 把 marker 加了 `（文件 …）` 段，但两份契约文档当时禁改、停在旧字面（CHANGELOG 的 #264 条目
// 已写明「待另单同步」）。`check:docs` 不钉这条字面量（它钉的是 NEXT_STEP_CLAUSE 与 formatSize 档位），
// 所以这里补上「文档说的 == 源码产出的」：文档用占位符，实例化后必须逐字等于 toolMarker 的产出。
// 反向证①：任一侧改回旧字面 → 该侧当场红。
const CONTRACT_DOCS = ["docs/host-consumer-contract.md", "docs/host-consumer-contract_cn.md"];

test("中英契约文档引用的 readMoreLines marker 字面与源码产出同源（#267）", () => {
  const produced = toolMarker("readMoreLines", { total: 12, offset: 5, size: 74 });
  assert.equal(produced, "[共 12 行（文件 74B），剩余 7 行；下一步：readFile 传 offset=5 继续]",
    "源码真值变了：test/contract/file-tools.js 的字面断言与两份契约文档必须跟着改（本条先红提醒三处同源）");
  const counts = [];
  for (const doc of CONTRACT_DOCS) {
    const text = readFileSync(join(REPO_ROOT, doc), "utf8");
    const claimed = [...text.matchAll(/\[共 N 行[^\]]*\]/gu)].map((m) => m[0]);
    assert.ok(claimed.length > 0,
      `${doc}: 找不到「[共 N 行 …」的 marker 字面（被删或改了占位写法 → 本检查面失效，请同步本测试）`);
    for (const literal of claimed) {
      const instantiated = literal
        .replace("N 行", "12 行")
        .replace("<size>", formatSize(74))
        .replace("M 行", "7 行")
        .replace("offset=K", "offset=5");
      assert.equal(instantiated, produced, `${doc}: 文档字面与 toolMarker 产出不同源（占位符语义也在这条里钉住）`);
      assert.doesNotMatch(literal, /(?<![\d.])\d+B/u,
        `${doc}: marker 字面里不得出现裸字节数（#196 R2：同一结果不并排两份数）`);
    }
    counts.push(claimed.length);
  }
  assert.equal(counts[0], counts[1], `中英引用处数不齐：EN ${counts[0]} vs CN ${counts[1]}（marker 字面必须成对同步）`);
});

// ---------------------------------------------------------------------------
// issue #628（2026-11-17）：模型可见的 `readFile` 描述**去数字化**，守卫同步换成两条稳定判据。
//
// 本段原本是什么（四格统计断言 + 它们的数据结构，全部已删）：
//   · #267 的「描述 token 三档 vs 三个写死样本」+ `READ_TOKEN_SAMPLES` / `measureReadWindowTokens`；
//   · #271 的「描述声称 vs 83 条写死样本的实测中位 ±2%」与「vs 五个角色文件 ±2% / ±1%」
//     + `READ_LINE_CAPACITY_SAMPLE` / `READ_LINE_CAPACITY_ROLES`（含 #271 → #609 的十七次复测台账）；
//   · #453 / #537 / #543 的「描述里的 floor == 全树真最小值（向下取整到 50 行）」+ `assertTierTight`
//     及其「比 ±50 形态更严」的反向证——解析面是 `fewest ≥ N lines` 那句档位承诺，承诺已删；
//   · #275 的「全仓扫描只留单调性质」——它守的是「描述里 floor / CJK 最密那两句有没有被新文件推翻」。
//   那十七次复测的逐条旧值→新值是**历史**，没有搬到这里：见
//   `git log --oneline -- test/tools/file-tools.test.js` 与 CHANGELOG 的 #271/#275/#453/#537/#543/#609。
//
// 为什么整组删而不是换样本（裁决原文在 issue #628 最后一条评论）：只要描述里钉着「从本仓源码
// 统计出来的数」，任何一次**与 readFile 无关**的注释改动都可能要求改一句**模型可见**的文案。
// 实证（不是理论）：#609 给 `src/loop/budget.js` 加 29 行中文注释 ⇒ 样本中位 6,056 → 6,007 ⇒
// 「描述声称的 median 6,157」越过 ±2% ⇒ 修截断标记的人被迫去改 readFile 的描述；#267 的密实档
// 锚点更是**本文件自己**（自指）。换样本只是把漂移源挪个地方，所以这里只留不会漂的东西。
//
// 现在这三格钉的是什么：
//   守卫 1 描述里不许再出现**任何**仓内实测数字（数字白名单 + 禁用形状，两面都是「不在名单里就红」）；
//   守卫 2 描述里的 token 区间必须等于 `estimateTokens()` **现算**出来的区间（双向：偏大偏小都红）；
//   守卫 3 机制事实必须在场（`max_bytes` 默认值、预算按字节、换算式、`offset`/`limit` 语义、marker）。
// 一字未动的是**行为**判据：下面 `#506` 的分片续读四条不变量（不超字节 / 无 U+FFFD / 续读不重不漏 /
// 超宽行有显式出口）与它的反向证；字节上限与 offset/limit 语义另由 `test/contract/file-tools.js` 钉着。
// ---------------------------------------------------------------------------

/** readFile 面向模型的描述——三格 #628 判据共同的被测面。 */
function readFileDescription() {
  const definition = FILE_TOOL_DEFINITIONS.find((item) => item.name === "readFile");
  assert.ok(definition, "FILE_TOOL_DEFINITIONS 里找不到 readFile（本文件三格 #628 判据的被测面失效）");
  return definition.description;
}

/**
 * 描述里**允许**出现的数字，逐个注明出处。允许的理由只有一个：它是**机制事实**
 * （默认值 / 单位 / 估算器常数 / 由估算器公式推出的量），不是「从本仓某些文件测出来的数」。
 * 白名单是守卫 1 的 catch-all：任何没在这里挂号的数字都红，包括那些还没进
 * `READ_DESC_MEASURED_FIGURES` 的新统计量——不必每漂移一次就来补一条禁用项。
 */
const READ_DESC_ALLOWED_FIGURES = new Map([
  ["0", "`offset` 的默认值与 `0-based` 的 0（语义事实）"],
  ["1", "结果行号是 `1-based` 的 1（语义事实）"],
  ["200", "`limit` 默认行数，以及 `offset=200` 那句续读示例（默认值事实）"],
  ["8", "`UTF-8` 这个名字里的 8（编码名，不是测量值）"],
  ["262144", "`max_bytes` 默认字节数——`scripts/docs-drift-check.mjs` 拿它当真值锚点，**不许改值**"],
  ["256", "同一个默认值的可读写法 `256KB`（同一个事实的第二种拼写）"],
  ["3", "「一个 CJK 字符 3 个 UTF-8 字节」（UTF-8 编码事实）"],
  ["3.5", "估算器常数 `charsPerToken = 3.5`（`src/tokens.js`）"],
  ["1.5", "估算器常数 `cjkTokensPerChar = 1.5`（`src/tokens.js`）"],
  ["1.15", "估算器常数 `margin = 1.15`（`src/tokens.js`，是余量系数，不是「误差 ≤ 15%」的保证）"],
  ["3.04", "ASCII 的字节 / token 折算率：由 `estimateTokens` 现算（守卫 2 双向对账）"],
  ["1.74", "纯汉字的字节 / token 折算率：同上"],
  ["86000", "一次读满 256 KiB 的 ASCII token 下界：由 `estimateTokens` 现算（守卫 2 对账）"],
  ["151000", "一次读满 256 KiB 的纯汉字 token 上界：同上"],
  ["1000", "`limit=1000` 那个「一次要够」的示例参数"],
]);

/**
 * #628 从描述里删掉的**仓内实测数字**（历史清单，逐个注明它当初是谁）。
 * 它是守卫 1 的点名面：`READ_DESC_ALLOWED_FIGURES` 已经会拦住它们，这一张的作用是把报错
 * 说清——「这个数字是 #628 删掉的实测值」比「这个数字没挂号」有用得多。
 * 清单本身可被改坏：把任何一个塞回描述，这里当场点名红。
 */
const READ_DESC_MEASURED_FIGURES = new Map([
  ["3850", "#271/#769 的 `fewest ≥ 3,850 lines` 档位"],
  ["3903", "#453/#537 的全树实测最小值（`measured minimum 3,903`）"],
  ["3900", "#537 的 floor 档位（向下取整到 50）"],
  ["6007", "#609 复测后的 `median 6,007 (43.6)` 档"],
  ["6157", "#769 R3 的 `median 6,157 (42.6)` 档"],
  ["9407", "#271 的 `most 9,407 (27.9)` 档"],
  ["4384", "CJK 锚点 `src/loop/state-view.js` 的行数容量"],
  ["4577", "`this tool's own source fits`（本文件自己，#628 前的倒数第二版）"],
  ["4531", "`this tool's own source fits`（本文件自己，#628 前的最后一版）"],
  ["190", "#267 的稀疏档 token（`src/text/label.js` 前 200 行）"],
  ["2493", "#267 的典型档 token（`bin/sessions.js`）"],
  ["4773", "#267 的密实档 token（**本文件自己**：自指锚点）"],
  ["2500", "旧文案的「~2,500 典型值」（#267 修的正是拿中位数冒充上限）"],
  ["4750", "旧文案的「~4,750 尾巴」"],
  ["83", "本仓 `.js` 文件总数（#275 已删过一次，别让它回来）"],
  ["3000", "#264 旧文案的下界（`~3,000-6,000 lines`，没人复测过）"],
  ["6000", "#264 旧文案的上界（同上）"],
]);

/** 描述里不许再出现的句式（**形状**，与具体数字无关）：命中即红。 */
const READ_DESC_BANNED_SHAPES = [
  [/\bfewest\b/u, "`fewest` 档位词（#271 的全树最小值承诺）"],
  [/\bmedian\b/u, "`median`（#271 的样本中位）"],
  [/\bmost\s+[\d,]/u, "`most <数字>`（#271 的样本最大值；英文 `at most max_bytes` 不带数字，不算命中）"],
  [/measured minimum/u, "`measured minimum N`（#543 已把它请出承诺，#628 整段删除）"],
  [/rounded down to (?:the nearest|a multiple of) 50/u, "「向下取整到 50 行」的档位换算式（档位本身已删）"],
  [/whole-tree minimum/u, "「全树最小值」那类全称承诺（要枚举全树才成立，新增文件就能推翻）"],
  [/fixed sample/u, "「固定样本」口径（#453 / PR #454 的免责声明；样本口径整组已删）"],
  [/[\d,]+% of its bytes are CJK/u, "某个文件的 CJK 字节占比（#271 的 `densest` 锚点）"],
  [/[\d,]+ `?\.js`? files\b/u, "「本仓有多少个 `.js`」（#275 删过一轮）"],
  [/not one of the [\d,]+ falls below/u, "「N 个文件从不下穿某档」（#275 删过）"],
  [/[\d,]+ of them take over/u, "「多少个文件超过某档」（#275 删过）"],
  [/~3,000-6,000/u, "未复测的旧区间 `~3,000-6,000 lines`（#271 要修的正是它）"],
  [/short and sparse/u, "#267 的「稀疏 / 典型 / 密实」三档叙事（token 那三档样本已删）"],
];

/**
 * 反向证用的**旧句子原文**（从改动前的描述里逐字抄下来）。每条都是一次真实的历史形态：
 * 把它接回描述，守卫 1 的两面（数字 + 形状）必须咬。判据失效（正则写坏、白名单被清空）时，
 * 这些句子会重新变成合法文案 ⇒ 本测试当场红。
 */
const READ_DESC_LEGACY_SENTENCES = [
  " Measured that way on this repo's own `.js` sources under `src/`, `bin/` and `examples/` "
    + "\u2014 fewest \u2265 3,850 lines (68.0 bytes/line, the widest lines; the whole-tree minimum rounded "
    + "down to the nearest 50, so no file in those three trees reads fewer than 3,850 lines), "
    + "median 6,007 (43.6), most 9,407 (27.9). The floor is a whole-tree minimum rounded down to "
    + "a multiple of 50; median and most come from a fixed sample of those sources.",
  " The most CJK-dense file in that fixed sample (`src/loop/state-view.js`, 37% of its bytes are "
    + "CJK) fits 4,384 and this tool's own source fits 4,531; measured minimum 3,903.",
  " Token budget: ~190 tokens where lines are short and sparse, ~2,500 on typical source, "
    + "and ~4,773 where lines are wide.",
  " the 83 `.js` files shipped here; not one of the 83 falls below 3,000, and 69 of them take over "
    + "6,000; the old copy said ~3,000-6,000 lines.",
];

/** 抽出描述里的数字：`{ raw, value }`，`value` 去掉千分位逗号，小数按字面比（`3.50` ≠ `3.5`）。 */
function extractDescriptionFigures(text) {
  return [...text.matchAll(/(?<![\d.])(\d[\d,]*(?:\.\d+)?)(?![\d])/gu)].map((match) => ({
    raw: match[1],
    value: match[1].replace(/,/gu, ""),
  }));
}

test("readFile 描述里没有仓内实测数字（#628 守卫 1：数字白名单 + 禁用形状 + 自带反向证）", () => {
  const description = readFileDescription();
  const figures = extractDescriptionFigures(description);
  assert.ok(figures.length > 0, "描述里一个数字都抽不出来：抽取正则坏了（白名单会退化成永真）");
  // ① 点名面：#628 删掉的那些实测数字不许回来（回来就报出它当初是谁，而不是只说「不合法」）。
  const resurrected = figures.filter((figure) => READ_DESC_MEASURED_FIGURES.has(figure.value));
  assert.deepEqual(resurrected.map((figure) => `${figure.raw}（${READ_DESC_MEASURED_FIGURES.get(figure.value)}）`), [],
    "模型可见的 readFile 描述里又出现了 #628 删掉的**仓内实测数字**：这类数字是从本仓源码统计出来的，"
    + "任何一次与 readFile 无关的注释改动都能让它过期（#628 的整条裁决）。要留它就得同时给出"
    + "「它为什么不随源码 churn 漂」的理由，并在这里挂号——那正是守卫 2 那种由公式推出的量。");
  // ② catch-all：不在白名单里的数字（含未来新增的统计量）一律红。
  for (const figure of figures) {
    assert.ok(READ_DESC_ALLOWED_FIGURES.has(figure.value),
      `描述里的数字 ${figure.raw} 没有挂号：模型可见面只许出现机制事实（默认值 / 单位 / 估算器常数 / `
        + `由估算器推出的量）。如果它是对某个文件量出来的，按 #628 删掉；如果它真是机制事实，`
        + `在 READ_DESC_ALLOWED_FIGURES 里写清出处再进来`);
  }
  // ③ 形状面：即便数字换了个值，旧句式本身也不许回来。
  for (const [shape, why] of READ_DESC_BANNED_SHAPES) {
    assert.doesNotMatch(description, shape, `描述里又出现了「${why}」这个形状：#628 之后模型可见面不再给这种量`);
  }
  // ④ 白名单不许躺着「描述里根本没有」的数字：那等于给未来的漂移留了个空门。
  const present = new Set(figures.map((figure) => figure.value));
  assert.deepEqual([...READ_DESC_ALLOWED_FIGURES.keys()].filter((key) => !present.has(key)), [],
    "白名单里有描述里根本不存在的数字：要么它在等一个已删的数字回来（那就删掉这条挂号），"
    + "要么某个机制常数被改了（先确认真值，再改这里与 `src/tools/file-tools.js`）");
  // ⑤ 反向证 A：把四段**旧句子原文**接回描述，数字面必须每次都被咬。
  for (const legacy of READ_DESC_LEGACY_SENTENCES) {
    const polluted = extractDescriptionFigures(description + legacy);
    const bitten = polluted.filter((figure) => READ_DESC_MEASURED_FIGURES.has(figure.value)
      || !READ_DESC_ALLOWED_FIGURES.has(figure.value));
    assert.ok(bitten.length > 0, `旧句子接回描述后没人咬（判据①的数字面失效）：${legacy.slice(0, 60)}…`);
  }
  // ⑥ 反向证 B：禁用形状一条都不许是死正则——每条都要能在某段旧句子上真的命中。
  const deadShapes = READ_DESC_BANNED_SHAPES
    .filter(([shape]) => !READ_DESC_LEGACY_SENTENCES.some((legacy) => shape.test(legacy)))
    .map(([, why]) => why);
  assert.deepEqual(deadShapes, [], "禁用形状里这些正则连旧句子都咬不到（清单被改坏 / 正则写错）："
    + deadShapes.join("、"));
});

/**
 * 256 KiB 的**两个极端**，用 `src/tokens.js` 的估算器现算（本单硬约束：不许改估算器，也不许
 * 把这些数抄成常量）。纯汉字样本按「一个汉字 3 个 UTF-8 字节」取整到整字 ⇒ 262,143 字节，
 * 比 256 KiB 少 1 字节（0.0004%，远在 2% 容差之内；下面的自洽判据用的是同一个字节数）。
 */
const READ_CAP_TOKEN_EXTREMES = (() => {
  const measure = (text) => {
    const bytes = Buffer.byteLength(text, "utf8");
    const tokens = estimateTokens(text);
    return { bytes, tokens, bytesPerToken: bytes / tokens };
  };
  return {
    ascii: measure("a".repeat(FILE_READ_MAX_BYTES_DEFAULT)),
    cjk: measure("\u4e2d".repeat(Math.floor(FILE_READ_MAX_BYTES_DEFAULT / 3))),
  };
})();

/** 双向对账：偏大与偏小都红（容差是「允许四舍五入」，不是「允许漂移」）。 */
function assertCloseFigure(claim, computed, tolerance, label) {
  const drift = Math.abs(claim - computed) / computed;
  assert.ok(drift <= tolerance,
    `${label}：描述写 ${claim}，现算 ${computed.toFixed(2)}，偏 ${(drift * 100).toFixed(2)}% > 容差 ${(tolerance * 100).toFixed(0)}%`);
  return drift;
}

test("readFile 描述的 token 区间 == 估算器现算的区间（#628 守卫 2：估算器改了而文案没跟就红，双向）", () => {
  const description = readFileDescription();
  const divisors = description.match(
    /tokens \u2248 bytes \u00f7 ([\d.]+) for ASCII source and \u2248 bytes \u00f7 ([\d.]+) for text that is nothing but Chinese characters/u,
  );
  assert.ok(divisors, "描述不再按「\u2248 bytes \u00f7 N（ASCII）/ \u2248 bytes \u00f7 N（纯汉字）」给折算率 "
    + "\u2192 本测试的解析面失效（同步本测试，不许让断言静默变成永真）");
  const bounds = description.match(
    /costs ~([\d,]+) tokens of ASCII up to ~([\d,]+) tokens of pure Chinese characters/u,
  );
  assert.ok(bounds, "描述不再按「~N tokens（ASCII）… ~M tokens（纯汉字）」给一次读满 256 KiB 的区间 "
    + "\u2192 解析面失效（同上）");
  const [asciiDivisorClaim, cjkDivisorClaim] = divisors.slice(1).map(Number);
  const [lowClaim, highClaim] = bounds.slice(1).map((value) => Number(value.replace(/,/gu, "")));
  const ascii = READ_CAP_TOKEN_EXTREMES.ascii;
  const cjk = READ_CAP_TOKEN_EXTREMES.cjk;
  // 0) 样本前提：汉字必须真是 3 字节/字（否则「字节 ÷ 折算率」这套算式与描述那句话一起失效）。
  assert.equal(Buffer.byteLength("\u4e2d", "utf8"), 3,
    "「\u4e2d」不再是 3 个 UTF-8 字节：描述里「3 UTF-8 bytes per character」与下面的换算都要重谈");
  assert.ok(cjk.bytes >= FILE_READ_MAX_BYTES_DEFAULT - 4,
    `纯汉字样本只有 ${cjk.bytes} 字节，离 256 KiB 太远（取整逻辑坏了）`);
  // 1) 两个折算率必须等于 `estimateTokens` 现算的「字节 / token」（实测口径：ASCII 3.0434、纯汉字 1.7391）。
  assertCloseFigure(asciiDivisorClaim, ascii.bytesPerToken, 0.05, "ASCII 的字节 / token 折算率");
  assertCloseFigure(cjkDivisorClaim, cjk.bytesPerToken, 0.05, "纯汉字的字节 / token 折算率");
  // 2) 区间上下界必须等于现算的「256 KiB 换算成 token」（ASCII 86,134 / 纯汉字 150,733；双向）。
  assertCloseFigure(lowClaim, ascii.tokens, 0.02, "一次读满 256 KiB 的 ASCII token 下界");
  assertCloseFigure(highClaim, cjk.tokens, 0.02, "一次读满 256 KiB 的纯汉字 token 上界");
  // 3) 文案自己那套算式必须自洽——模型真会拿它算：256 KiB ÷ 它给的折算率 ≈ 它给的区间。
  assertCloseFigure(lowClaim, Math.round(FILE_READ_MAX_BYTES_DEFAULT / asciiDivisorClaim), 0.02,
    "描述内部自洽（下界 vs 它自己给的 ASCII 折算率）");
  assertCloseFigure(highClaim, Math.round(FILE_READ_MAX_BYTES_DEFAULT / cjkDivisorClaim), 0.02,
    "描述内部自洽（上界 vs 它自己给的纯汉字折算率）");
  // 4) #267 的结论留在**公式**里：ASCII → 纯汉字这段跨度必须 ≥1.5×（典型值不是上限）。
  assert.ok(highClaim >= lowClaim * 1.5,
    `描述的区间跨度只剩 ${(highClaim / lowClaim).toFixed(2)}\u00d7：#267 修的正是「拿典型值冒充上限」`);
  assert.ok(cjk.tokens >= ascii.tokens * 1.5,
    `估算器给的跨度只剩 ${(cjk.tokens / ascii.tokens).toFixed(2)}\u00d7：估算器改了，描述的区间口径要重谈`);
  // 5) 反向证：把上界改偏 ±5% 都必须红（正向对照同时在场，否则「恒抛」也会骗过这三条）。
  assert.doesNotThrow(() => assertCloseFigure(highClaim, cjk.tokens, 0.02, "正向对照"),
    "正向对照就红：说明解析出的上界与现算值本来就不一致（判据在红，不是反向证在红）");
  assert.throws(() => assertCloseFigure(Math.round(highClaim * 1.05), cjk.tokens, 0.02, "反向证：偏大 5%"),
    /偏 /u, "上界偏大 5% 没被判红：容差被放宽了，还是估算器改了而文案没跟？");
  assert.throws(() => assertCloseFigure(Math.round(highClaim * 0.95), cjk.tokens, 0.02, "反向证：偏小 5%"),
    /偏 /u, "上界偏小 5% 没被判红：双向对账退成了单向（只许低估），描述可以随便往小里写");
  console.log("#628 token range (estimator-derived, not measured):", JSON.stringify({
    capBytes: FILE_READ_MAX_BYTES_DEFAULT,
    ascii: { bytes: ascii.bytes, tokens: ascii.tokens, bytesPerToken: Number(ascii.bytesPerToken.toFixed(4)) },
    cjk: { bytes: cjk.bytes, tokens: cjk.tokens, bytesPerToken: Number(cjk.bytesPerToken.toFixed(4)) },
    claimed: { low: lowClaim, high: highClaim, asciiDivisor: asciiDivisorClaim, cjkDivisor: cjkDivisorClaim },
  }));
});

test("readFile 描述只给机制事实：字节上限 / 换算式 / offset 与 limit 语义 / marker 续读（#628 守卫 3）", () => {
  const description = readFileDescription();
  assert.match(description, /at most `max_bytes` UTF-8 bytes \(default 262144 = 256KB\)/u,
    "字节硬上限与默认值必须在场：262144 同时是 `scripts/docs-drift-check.mjs` 的真值锚点，**不许改值**");
  assert.match(description, /the budget is counted in BYTES/u,
    "必须写明预算按 **UTF-8 字节** 计（#628 明确排除「把字节上限换成 token 上限」：字节是确定边界，估算值不是）");
  assert.match(description, /max_bytes \u00f7 average bytes per line/u,
    "行数容量要给**换算式**（#271 的期望修法：给公式，而不是给一个会过期的区间）");
  assert.match(description, /`wc -c` \u00f7 `wc -l`/u,
    "换算式要给宿主**在自己的树上**能现算的口径");
  assert.match(description, /`offset` is a \*\*0-based\*\* line index/u,
    "`offset` 必须是 **0-based 行号**（行是寻址单位，不许换成 token）");
  assert.match(description, /`limit` is a \*\*line count\*\*, default 200/u,
    "`limit` 必须是**行数**、默认 200（同上）");
  assert.match(description, /a marker that carries the exact `offset` to continue from/u,
    "续读指引必须在场：marker 给出可续读的行偏移（#506/#609 那条「静默截断」的病就靠它闭环）");
  assert.match(description, /far more than a single `limit` will ask for/u,
    "「字节上限远大于一次 `limit` 会要的量」这条行为指导必须在场（#264/#271 共同要治的保守分批）");
  assert.match(description, /in one call/u, "「一次要够」的口径必须在场（#264 的反向病：保守分批）");
  assert.match(description, /heuristic estimate, not a real tokenizer/u,
    "token 区间必须自报是**引擎启发式估值**：它是推出来的，不是真实 tokenizer，也不是实测（#628）");
  assert.doesNotMatch(description, /~3,000-6,000/u,
    "未复测的旧区间 `~3,000-6,000 lines` 又回来了（#271 要修的正是它）");
});

// ---------------------------------------------------------------------------
// 下面三件是 `#506` **行为判据**的样本前提（不是统计断言，#628 保留）。
// 原来它们与 83 条写死样本、五角色表放在一起；那张表已随 #628 删除，这里只留下 #506 真正需要的：
//   · `CJK_DENSE_READ_ANCHOR`：原 `densest` 角色的那个文件。#506 要测的是「CJK 密的文件经过
//     readFile 截断路径会不会丢内容 / 会不会劈坏多字节字符」，所以要一个真的 CJK 密的样本，
//     而不是「当场排名最密的那一个」（相对量：任何人在 `src/**` 写中文注释都能换人 ⇒ 与改动无关的红，
//     #497 实测过）。所以钉**密度下界** + 行为，不钉排名。
//   · `measureReadLineCapacity`：口径是「平均行字节 = 文件字节 ÷ 物理行数（`wc -l` 口径，
//     每行的 `\n` 已计在字节里，不再 +1）」。#506 只用它的 `cjkShare`；`capacity` 不再被断言。
// ---------------------------------------------------------------------------

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// issue #506：CJK 密度的**被测性质**是「存在一个密度 ≥ 阈值的样本 + 它在截断路径上行为正确」，
// **不是**「谁最密」。阈值 0.35 是 #506 定下的（#628 一个字没动）：跌破它就换锚点，别放宽下界。
const CJK_DENSE_SAMPLE_FLOOR = 0.35;

/** #506 截断路径行为判据的 CJK 密样本（自 #271 起一字未动；换它要连带重测密度前提）。 */
const CJK_DENSE_READ_ANCHOR = "src/loop/state-view.js";

function measureReadLineCapacity(rel) {
  const abs = join(REPO_ROOT, rel);
  assert.ok(existsSync(abs), `样本文件不在了：${rel}（改名/删除请同步 #506 那条行为判据的锚点）`);
  const content = readFileSync(abs, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  const newlines = (content.match(/\n/gu) ?? []).length;
  const lines = content.endsWith("\n") ? newlines : newlines + 1;
  const bytesPerLine = bytes / lines;
  let cjkBytes = 0;
  for (const char of content) {
    if (CJK_CHAR.test(char)) cjkBytes += Buffer.byteLength(char, "utf8");
  }
  return {
    rel,
    bytes,
    lines,
    bytesPerLine,
    cjkShare: bytes === 0 ? 0 : cjkBytes / bytes,
    capacity: Math.floor(FILE_READ_MAX_BYTES_DEFAULT / bytesPerLine),
  };
}

// ---------------------------------------------------------------------------
// issue #506：CJK 密样本在 readFile **截断路径**上的行为判据。
//
// 为什么必须是行为判据：描述里那句「CJK 按 3 字节/字计，所以行数按字节折」是 readFile 的**行为承诺**，
// 而在此之前它旁边只有一条「谁最密」的相对量断言（换人即红，与被测行为无关）。这一格钉性质本身：
//   ① 每次返回都不超 `max_bytes`（CJK 按 3 字节计入，不是按字符数）；
//   ② 截断不劈坏多字节字符（结果里不许出现 U+FFFD）；
//   ③ 按 marker 给的 `offset` 续读能拼回原文（行号不重不漏、正文逐字节相等）—— 截断不丢内容；
//   ④ 超宽行走「单行超过 max_bytes」那条显式路径（marker 带行号与重读 offset），而不是静默丢行。
// 判据本体提成 `assertChunkedReadFaithful`，下面那条反向证把**坏的分片**喂给它，证明它真的会红。
// ---------------------------------------------------------------------------

/** 按 marker 给的 offset 分片读完一个文件（续读只认 `readFile 传 offset=N 继续`，与模型的用法同源）。 */
async function readFileInChunks(executeTool, path, maxBytes, { limit = 1_000, maxRounds = 200 } = {}) {
  const chunks = [];
  let offset = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const text = await executeTool("readFile", { path, offset, limit, max_bytes: maxBytes });
    chunks.push({ offset, text });
    const next = text.match(/readFile 传 offset=(\d+) 继续/u);
    if (next === null) return chunks;
    const nextOffset = Number(next[1]);
    assert.ok(nextOffset > offset,
      `续读 offset 没有前进（${offset} → ${nextOffset}）：marker 与行窗口口径对不上，模型照抄就会死循环`);
    offset = nextOffset;
  }
  assert.fail(`分片读了 ${maxRounds} 轮还没读完：续读口径坏了（本测试的分片循环上限就是判据）`);
}

/**
 * 分片续读的**判据本体**（提出来是为了能反向证：坏分片喂进来必须红）。
 * @param {{ original: string, chunks: Array<{ offset: number, text: string }>, maxBytes: number, label: string }} input
 */
function assertChunkedReadFaithful({ original, chunks, maxBytes, label }) {
  assert.ok(chunks.length > 0, `${label}：一次都没读到`);
  /** @type {Map<number, string>} */
  const got = new Map();
  /** @type {Set<number>} 走「单行超过」显式路径的行号（它们的正文按设计就是前缀） */
  const overWide = new Set();
  for (const chunk of chunks) {
    const bytes = Buffer.byteLength(chunk.text, "utf8");
    assert.ok(bytes <= maxBytes,
      `${label}：offset=${chunk.offset} 这一次返回 ${bytes} 字节 > max_bytes=${maxBytes}`
      + "（预算按 UTF-8 字节计，CJK 一字 3 字节 —— 按字符数算就会在这里越界）");
    assert.ok(!chunk.text.includes("\uFFFD"),
      `${label}：offset=${chunk.offset} 的结果里出现 U+FFFD ⇒ 截断劈坏了一个多字节字符（CJK 三字节被切成两半）`);
    for (const line of chunk.text.split("\n")) {
      const numbered = line.match(/^(\d+): (.*)$/u);
      if (numbered === null) {
        if (line === "") continue;
        assert.match(line, /^\[.*\]$/u,
          `${label}：结果里有一行既不是「行号: 正文」也不是 marker：${JSON.stringify(line)}`);
        if (/单行超过 max_bytes/u.test(line)) {
          const lineNo = Number(line.match(/首条第 (\d+) 行/u)?.[1] ?? 0);
          assert.ok(lineNo > 0,
            `${label}：超宽行的 marker 没带被截断的行号 ⇒ 模型没有可执行的取回出口：${line}`);
          assert.match(line, /readFile 传 offset=\d+, limit=1/u,
            `${label}：超宽行 marker 没给「重读这一行」的 offset/limit：${line}`);
          overWide.add(lineNo);
        }
        continue;
      }
      const lineNo = Number(numbered[1]);
      assert.ok(!got.has(lineNo), `${label}：第 ${lineNo} 行被返回了两次（续读 offset 口径漂了）`);
      got.set(lineNo, numbered[2]);
    }
  }
  const originalLines = original.endsWith("\n") ? original.slice(0, -1).split("\n") : original.split("\n");
  const missing = originalLines
    .map((_, index) => index + 1)
    .filter((lineNo) => !got.has(lineNo) && !overWide.has(lineNo));
  assert.deepEqual(missing, [],
    `${label}：分片续读漏了这些行（截断静默丢内容）：${missing.slice(0, 10).join(", ")}`);
  const mismatched = [...got.keys()]
    .filter((lineNo) => !overWide.has(lineNo) && got.get(lineNo) !== originalLines[lineNo - 1])
    .sort((a, b) => a - b)
    .slice(0, 3);
  assert.deepEqual(mismatched, [],
    `${label}：这些行的正文与原文逐字节不等（截断改写了正文，而不是原样返回）：${mismatched.join(", ")}`);
}

test("#506 CJK 密样本在 readFile 截断路径上行为正确（分片续读零丢失 / 预算按 UTF-8 字节计 / 不劈坏多字节字符）", async () => {
  const anchor = CJK_DENSE_READ_ANCHOR; // #628：钉**名字**而不是「当场排名最密那一个」（见上面锚点注）
  const measured = measureReadLineCapacity(anchor);
  // ① 前提：这个样本必须真的 CJK 密 —— 否则下面测的是一个普通文件。
  assert.ok(measured.cjkShare >= CJK_DENSE_SAMPLE_FLOOR,
    `${anchor} 不再 CJK 密（${(measured.cjkShare * 100).toFixed(1)}%）⇒ 换锚点，不要靠放宽下界让它变绿`);
  // ② 描述里那句「3 UTF-8 bytes per character」是**行为**：样本里真的有多字节字符，且它们确实是 3 字节。
  const source = readFileSync(join(REPO_ROOT, anchor), "utf8");
  const cjkChars = [...source].filter((char) => CJK_CHAR.test(char));
  assert.ok(cjkChars.length > 0, `${anchor} 里没有 CJK 字符：本判据测不到多字节截断`);
  assert.ok(cjkChars.every((char) => Buffer.byteLength(char, "utf8") === 3),
    "样本里出现了非 3 字节的 CJK 字符：描述里「3 UTF-8 bytes per character」要么改，要么换样本");
  // ③ 行为：小预算分片续读（1024 是 readFile 允许的下限），四件事一起判。
  const maxBytes = 1_024;
  const { executeTool } = createFileTools({ cwd: REPO_ROOT });
  const chunks = await readFileInChunks(executeTool, anchor, maxBytes);
  assert.ok(chunks.length > 1,
    `${anchor} 一次就读完了（${chunks.length} 片）：预算没有真的截断，这条判据没测到截断路径`);
  assertChunkedReadFaithful({ original: source, chunks, maxBytes, label: `${anchor} 分片续读` });
});

// ---------------------------------------------------------------------------
// issue #506 反向证：上面那条判据**真的会红**。三类坏分片喂给同一个谓词，每类都必须点名自己的病。
// （不做「改坏 src 再跑一遍」那种一次性手工变异：本仓的规矩是判据要能自我证伪。
//  先例曾是 `assertTierTight` 那条「比 #537 的 ±50 形态更严」的测试（#628 随档位承诺一起删），
//  现在的同族先例是本文件上面 #628 守卫 1 的⑤⑥与守卫 2 的⑤。手工变异另跑一次，结论写进交付/CHANGELOG。）
// ---------------------------------------------------------------------------
test("#506 反向证：坏分片喂给同一谓词必须红（超预算 / 劈坏多字节字符 / 静默漏行）", () => {
  const original = "第一行中文注释\n第二行也是中文\n";
  const label = "反向证样本";
  const good = [
    { offset: 0, text: "1: 第一行中文注释\n[本次返回已达 max_bytes=1KB 上限，共 2 行；下一步：readFile 传 offset=1 继续]" },
    { offset: 1, text: "2: 第二行也是中文" },
  ];
  // 正向对照：先把「合法分片必须绿」钉住，否则下面三条反向证会因为「谓词恒抛」而假绿。
  assert.doesNotThrow(() => assertChunkedReadFaithful({ original, chunks: good, maxBytes: 1_024, label }),
    "正向对照不通过：谓词把一份合法分片判红了（先修谓词，否则下面三条反向证没有意义）");
  // ① 超预算：CJK 按字节算，按字符数算的实现会放过这份 1,203 字节的返回。
  const overBudget = [{ offset: 0, text: `1: ${"中".repeat(400)}` }];
  assert.throws(() => assertChunkedReadFaithful({ original, chunks: overBudget, maxBytes: 1_024, label }), /字节 > max_bytes/u,
    "超预算的分片没被判红：max_bytes 若按字符数算，CJK 密文件会一次吐出 3 倍字节");
  // ② 劈坏多字节字符：截断落在 CJK 三字节中间 ⇒ 解码成 U+FFFD。
  const mangled = [
    { offset: 0, text: "1: 第一行中\uFFFD\n" },
    { offset: 1, text: "2: 第二行也是中文" },
  ];
  assert.throws(() => assertChunkedReadFaithful({ original, chunks: mangled, maxBytes: 1_024, label }), /劈坏/u,
    "劈坏多字节字符的分片没被判红：这正是「CJK 按 3 字节截断」最容易出的错");
  // ③ 静默漏行：marker 说 offset=2（越过末尾）而第 2 行从没返回过 ⇒ 续读口径漂了，内容静默丢失。
  const dropped = [
    { offset: 0, text: "1: 第一行中文注释\n[本次返回已达 max_bytes=1KB 上限，共 2 行；下一步：readFile 传 offset=2 继续]" },
  ];
  assert.throws(() => assertChunkedReadFaithful({ original, chunks: dropped, maxBytes: 1_024, label }), /漏了这些行/u,
    "静默漏行的分片没被判红：这正是「截断静默丢内容」那条谎");
});

// ---------------------------------------------------------------------------
// issue #867（里程碑 1）：readFile 返回文本的**最后一行**是一个 **token 估值行**。
//
// 形状：`[本次返回约 12,400 token（引擎启发式估值，非真实 tokenizer）]`。
// 口径（与 `src/tools/file-tools.js` 的 `readTokenEstimateLine` 同源，写死的）：数的是
// **除这一行自己以外**的完整返回文本（正文行 + 行号 + 换行 + 全部 marker）。不把估值行算进去的
// 理由是**自指**：加上这行，数就变大；数变大又改变这行自己的长度（数字多一位 ⇒ 字节多一），
// 再算又要变 ⇒ 没有不动点。所以四格判据里对账的是**逐字相等**，不是「±2%」。
//
// 四格各管一面，互相不兑岗：
//   ① 逐字对账：报出的数 === `estimateTokens(剥掉估值行的返回文本)`（用仓内真文件）。
//   ② 确定性：同一输入连调两次（两个独立实例）逐字相同。
//   ③ 其余输出一字不动：固定夹具的正文行 / 行号 / marker 部分与**改动前**逐字节相同
//     （下面三份 GOLDEN 是在基点 `6e3ba30e` 上跑同一夹具抄下来的，不是本次实现现算的）。
//   ④ 存在性（反向证落点）：只钉「最后一行以 `[本次返回约` 开头、以 `]` 结尾、且全返回只有一行」
//     ——把实现里那一行删掉，本格必红（不靠别的断言顺带兜住）。
// ---------------------------------------------------------------------------

/** 固定夹具（③ 的 GOLDEN 就是这三份文件在基点实现上的输出）。 */
const EST_GOLDEN_MIXED = [
  "first ascii line",
  "第二行 含中文 with mixed text",
  "third line\twith tab and  spaces",
  "",
  "fifth line",
  "第六行 结束",
];
const EST_GOLDEN_ROWS = Array.from({ length: 12 }, (_, index) => `row ${index}`);
const EST_GOLDEN_BIG = Array.from({ length: 40 }, (_, index) => `row-${index} ${"y".repeat(20)}`);

/**
 * 改动前（基点 `6e3ba30e`）同一夹具的逐字输出——**本切片不许其余输出一字不动**的对照真值。
 * 拄自：`git stash` 掉实现改动后跑 `createFileTools({cwd}).executeTool("readFile", input)`。
 */
const READ_OUTPUT_GOLDEN = [
  { label: "整份读完（无 marker）", input: { path: "mixed.txt" },
    output: "1: first ascii line\n2: 第二行 含中文 with mixed text\n3: third line\twith tab and  spaces\n4: \n5: fifth line\n6: 第六行 结束" },
  { label: "续读 marker", input: { path: "rows.txt", limit: 5 },
    output: "1: row 0\n2: row 1\n3: row 2\n4: row 3\n5: row 4\n[共 12 行（文件 74B），剩余 7 行；下一步：readFile 传 offset=5 继续]" },
  { label: "行窗口（offset 不是 0）", input: { path: "mixed.txt", offset: 1, limit: 3 },
    output: "2: 第二行 含中文 with mixed text\n3: third line\twith tab and  spaces\n4: \n[共 6 行（文件 114B），剩余 2 行；下一步：readFile 传 offset=4 继续]" },
  { label: "参数校正 marker + 续读 marker", input: { path: "mixed.txt", offset: -3, limit: 2 },
    output: "1: first ascii line\n2: 第二行 含中文 with mixed text\n[参数校正：offset=-3 是负数，已按 0 处理；下一步：重传 readFile 并传整数 offset]\n[共 6 行（文件 114B），剩余 4 行；下一步：readFile 传 offset=2 继续]" },
  { label: "字节触顶 marker", input: { path: "big.txt", max_bytes: 1_024 },
    output: "1: row-0 yyyyyyyyyyyyyyyyyyyy\n2: row-1 yyyyyyyyyyyyyyyyyyyy\n3: row-2 yyyyyyyyyyyyyyyyyyyy\n4: row-3 yyyyyyyyyyyyyyyyyyyy\n5: row-4 yyyyyyyyyyyyyyyyyyyy\n6: row-5 yyyyyyyyyyyyyyyyyyyy\n7: row-6 yyyyyyyyyyyyyyyyyyyy\n8: row-7 yyyyyyyyyyyyyyyyyyyy\n9: row-8 yyyyyyyyyyyyyyyyyyyy\n10: row-9 yyyyyyyyyyyyyyyyyyyy\n11: row-10 yyyyyyyyyyyyyyyyyyyy\n12: row-11 yyyyyyyyyyyyyyyyyyyy\n13: row-12 yyyyyyyyyyyyyyyyyyyy\n14: row-13 yyyyyyyyyyyyyyyyyyyy\n15: row-14 yyyyyyyyyyyyyyyyyyyy\n16: row-15 yyyyyyyyyyyyyyyyyyyy\n[本次返回已达 max_bytes=1KB 上限，共 40 行；下一步：readFile 传 offset=16 继续]" },
];

/** 拆出末尾的估值行；最后一行不是估值行就当场红（= 实现里那一行被删/改了字面）。 */
function splitTokenEstimate(output) {
  const lines = String(output).split("\n");
  const line = lines.at(-1) ?? "";
  const match = TOKEN_ESTIMATE_LINE.exec(line);
  assert.ok(match, `最后一行不是估值行（实现里那一行被删掉或改了字面）：${JSON.stringify(line)}`);
  return { body: lines.slice(0, -1).join("\n"), line, digits: match[1], reported: Number(match[1].replace(/,/gu, "")) };
}

test("readFile 报出的 token 数 == estimateTokens(剥掉估值行的返回文本)（#867：逐字相等，不是 ±2%）", async () => {
  const { executeTool } = createFileTools({ cwd: REPO_ROOT });
  for (const input of [
    // 无 marker：只有正文行（含行号与换行）。
    { path: "src/text/label.js" },
    // 带续读 marker：marker 文本也必须算进口径（不止正文）。
    { path: "src/tokens.js", limit: 200 },
    // CJK 密样本 + 触顶 marker：估值行进千分位，且口径跟着换行与中文一起对得上。
    { path: CJK_DENSE_READ_ANCHOR, limit: 3, max_bytes: 1_024 },
  ]) {
    const output = String(await executeTool("readFile", input));
    const { body, digits, reported } = splitTokenEstimate(output);
    assert.ok(body.length > 0, `夹具没给正文：${input.path}`);
    assert.ok(body !== output, "剥掉估值行必须真的剥掉了一行（否则下面的对账是拿自己对自己）");
    assert.equal(reported, estimateTokens(body),
      `${input.path}: 报出的数必须逐字等于对「剥掉估值行的完整返回」现算的估算值（不是容差内，是相等）`);
    // 口径的反向证：把估值行自己也算进去，必然得到**另一个**数 ⇒ 「不含自己」不是凑巧相等。
    assert.notEqual(reported, estimateTokens(output),
      `${input.path}: 含估值行自己的估算值与报出的数相同 ⇒ 自指口径没被这条判据区分开（样本太小或实现变了）`);
    // 千分位分组是确定性的（不跟 locale）：分组后的字面必须等于「从右往左每 3 位一个逗号」。
    assert.equal(digits, groupEveryThree(reported), `${input.path}: 数字分组不是每 3 位一组（换了 locale 就会飘）`);
    if (reported >= 1_000) {
      assert.match(digits, /^\d{1,3}(?:,\d{3})+$/u, `${input.path}: 四位数以上的必须带千分位逗号`);
    }
  }
});

/** 独立实现的分组（测试侧自写，不借实现的那个正则，否则两边一起坏就看不出来）。 */
function groupEveryThree(value) {
  const digits = String(value);
  const head = digits.length % 3;
  const chunks = head === 0 ? [] : [digits.slice(0, head)];
  for (let index = head; index < digits.length; index += 3) chunks.push(digits.slice(index, index + 3));
  return chunks.join(",");
}

test("readFile 的估值行是确定性的：同一输入连调两次逐字相同（#867：不跟 locale / 不跟实例）", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "mixed.txt"), `${EST_GOLDEN_MIXED.join("\n")}\n`, "utf8");
    const inputs = { path: "mixed.txt", limit: 4 };
    // 两个**独立**实例 + 同一实例连调 ⇒ 只要有任何隐藏状态（实例计数、locale、时间）这里就红。
    const first = String(await createFileTools({ cwd }).executeTool("readFile", inputs));
    const second = String(await createFileTools({ cwd }).executeTool("readFile", inputs));
    const third = String(await createFileTools({ cwd }).executeTool("readFile", inputs));
    assert.equal(first, second, "同一个输入两次返回逐字不同 ⇒ 估值行里混进了不稳定因素");
    assert.equal(second, third, "第三次与第二次不同 ⇒ 不是偶发");
    assert.equal(splitTokenEstimate(first).line, splitTokenEstimate(third).line);
  });
});

test("加了估值行之后，正文行 / 行号 / marker 部分逐字节不变（#867：对基点 6e3ba30e 的固定夹具）", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "mixed.txt"), `${EST_GOLDEN_MIXED.join("\n")}\n`, "utf8");
    await writeFile(join(cwd, "rows.txt"), `${EST_GOLDEN_ROWS.join("\n")}\n`, "utf8");
    await writeFile(join(cwd, "big.txt"), `${EST_GOLDEN_BIG.join("\n")}\n`, "utf8");
    await writeFile(join(cwd, "empty.txt"), "", "utf8");
    const { executeTool } = createFileTools({ cwd });

    for (const { label, input, output } of READ_OUTPUT_GOLDEN) {
      // 剥掉末尾估值行之后，剩下的必须与改动前**逐字节**相同（行内容 / 行号 / marker 文本与顺序）。
      assert.equal(withoutTokenEstimate(String(await executeTool("readFile", input))), output,
        `${label}：除了末尾的估值行，其余输出一字不许动（本 GOLDEN 拄自基点 6e3ba30e）`);
    }

    // 空文件：改动前是空串，改动后只剩估值行——**不**多一个前导空行。
    const emptyOutput = String(await executeTool("readFile", { path: "empty.txt" }));
    assert.equal(emptyOutput.split("\n").length, 1, "空正文不得插前置空行");
    assert.equal(withoutTokenEstimate(emptyOutput), "");
    assert.equal(splitTokenEstimate(emptyOutput).reported, 0, "空文本的估值必须是 0（不是 1）");
  });
});

test("估值行永远存在且是最后一行（#867 反向证落点：实现里删掉那一行就红）", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "mixed.txt"), `${EST_GOLDEN_MIXED.join("\n")}\n`, "utf8");
    const { executeTool } = createFileTools({ cwd });

    for (const input of [
      { path: "mixed.txt" },
      { path: "mixed.txt", limit: 2 },
      { path: "mixed.txt", offset: -1, limit: 2 },
      { path: "mixed.txt", offset: 999 },
      { path: "mixed.txt", limit: 0 },
    ]) {
      const output = String(await executeTool("readFile", input));
      const lines = output.split("\n");
      const last = lines.at(-1) ?? "";
      // 存在性判据（反向证就铉在这两行字面上）：实现里不拼那一行 ⇒ 当场红。
      assert.ok(last.startsWith("[本次返回约"), `返回文本的最后一行不是估值行：${JSON.stringify(last)}`);
      assert.ok(last.endsWith(" token（引擎启发式估值，非真实 tokenizer）]"),
        `估值行末尾没有「引擎启发式估值、非真实 tokenizer」的标注：${JSON.stringify(last)}`);
      assert.equal(lines.filter((line) => line.startsWith("[本次返回约")).length, 1,
        `一次返回里出现了多条估值行：${output}`);
      assert.doesNotMatch(last, /undefined|NaN|\{.*\}/u, `估值行里是模板占位而不是真值：${last}`);
      // 位置：估值行与上一个 marker / 正文行之间只隔一个 `\n`，而估值行自己不参与那一段（前一行不得又是估值行）。
      if (lines.length > 1) {
        assert.ok(lines.at(-2).startsWith("[") || /^\d+: /u.test(lines.at(-2)),
          `估值行的前一行不是正文行也不是 marker：${JSON.stringify(lines.at(-2))}`);
      }
    }

    // 模型得知道有这个数：描述里必须提一句（#867，不提任何仓内实测数字）。
    const description = readFileDescription();
    assert.match(description, /ends with one final line carrying an \*\*estimated\*\* token count/u,
      "描述不再告诉模型「返回末尾有一行估值 token 数」⇒ 模型会把这一行当成工具报错或正文");
    assert.match(description, /not a real tokenizer/u, "估值行自己必须被声明为**不是**真实 tokenizer");
  });
});


