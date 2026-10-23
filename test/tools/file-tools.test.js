// src/tools/file-tools.js 的实现侧测试（issue #184）
// 契约面走通用套件 fileToolsContract；这里只补「库自己的口径」：
// 默认无边界（ADR-009 牢笼归宿主）、env 三件套、无 signal 不让出、大文件有界读不回退成整文件读、
// rg/grep 默认正则与真实命令同口径（#184 追加轮 A，含 schema 描述真值）。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile as readFilePromise, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
import { fileToolsContract } from "../contract/file-tools.js";

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
      assert.equal(await executeTool("readFile", { path: join(outside, "notes.txt") }), "1: first\n2: second");
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
// issue #267：`readFile` 的两条「额度事实」必须是复测值、且中英契约文档与源码同源。
// 两条钉的都是**事实本身**而不是措辞：数字没复测就改 → 红；文档退回旧字面 → 红。
// ---------------------------------------------------------------------------

// 样本是**写死的三个真实文件**（工单硬约束：不许用 `find … | head -14` 这类会随仓库新增文件漂移的
// 隐式样本）。测法与工单给的复现命令逐字同口径：`estimateTokens(文件前 200 行)`。
// `measured` 是 2026-10-13 主 agent 与本单各自独立复测的同一个数（下面第一条把它也钉住）。
const READ_TOKEN_SAMPLES = [
  // 2026-10-23 #391 复测（**换了文件**，不是只刷数字）：`bin/guard-metrics.js` 被本单加了交付物计数的
  // 渲染与注释（+607 B / +6 行，前 200 行 = 整个文件），实测 150 → **392** tokens 且成了 CJK 注释密实档
  // （均行 46 B）——它不再是「短而稀疏」那一个。改钉 `src/text/label.js`（573 B / 17 行英文代码，
  // 实测 188 tokens），描述里那一档随之 150 → 190（同位数 ⇒ 对本文件字节数是中性的）。
  { role: "sparse", file: "src/text/label.js", measured: 188 },
  { role: "typical", file: "bin/sessions.js", measured: 2_493 },
  { role: "dense", file: "src/tools/file-tools.js", measured: 4_773 }  // 2026-10-22 #358 复测（本文件前 200 行；本仓自己的文件是密实档，注释一改就漂）,
];

function measureReadWindowTokens(rel) {
  assert.ok(existsSync(join(REPO_ROOT, rel)), `写死的样本文件不在了：${rel}（改名/删除请同步本测试）`);
  return estimateTokens(readFileSync(join(REPO_ROOT, rel), "utf8").split("\n").slice(0, 200).join("\n"));
}

test("readFile 描述的 token 三档与当场复测一致（#267：旧文案只写 ~2,500，正是中位数，尾巴差 1.8×）", () => {
  const description = FILE_TOOL_DEFINITIONS.find((definition) => definition.name === "readFile").description;
  const claim = description.match(
    /first 200 lines of real source files shipped here: ~([\d,]+) tokens[\s\S]{0,120}?~([\d,]+) on typical source, and ~([\d,]+) where lines/u,
  );
  assert.ok(claim, "描述不再按「sparse / typical / dense 三档」给 token 额度 → 本测试的解析面失效。"
    + "改句式可以，但必须同步本测试，不许让这条断言静默变成永真。");
  const [sparseClaim, typicalClaim, denseClaim] = claim.slice(1).map((v) => Number(v.replace(/,/g, "")));
  const measured = READ_TOKEN_SAMPLES.map((sample) => ({ ...sample, tokens: measureReadWindowTokens(sample.file) }));
  const got = Object.fromEntries(measured.map((m) => [m.role, m.tokens]));

  // 0) 写进描述/源码注释/CHANGELOG 的那三个数本身也不许漂（>10% 就要三处一起改）
  for (const m of measured) {
    assert.ok(Math.abs(m.tokens - m.measured) <= m.measured * 0.1,
      `${m.file} 前 200 行实测 ${m.tokens}，与记录值 ${m.measured} 差超过 10% → 额度事实漂移：`
        + "复测后把描述、src/tools/file-tools.js 的注释、CHANGELOG 的 #267 条目一起改");
  }
  // 1) 三档必须由小到大（把尾巴那一档改成比典型值还小 → 这条与第 3 条同时红）
  assert.ok(sparseClaim < typicalClaim && typicalClaim < denseClaim,
    `描述声称的三档必须由小到大，实测给的是 ${sparseClaim} / ${typicalClaim} / ${denseClaim}`);
  // 2) 每一档都得落进当场测得的那个样本（反向证②：把档位改成 ~100 这类偏小的数，这里必红）
  assert.ok(got.sparse <= sparseClaim * 1.1,
    `稀疏档声称 ~${sparseClaim} tokens，${READ_TOKEN_SAMPLES[0].file} 实测 ${got.sparse}，描述在夸大下限`);
  assert.ok(Math.abs(got.typical - typicalClaim) <= typicalClaim * 0.05,
    `典型档声称 ~${typicalClaim} tokens，${READ_TOKEN_SAMPLES[1].file}（复现样本的中位）实测 ${got.typical}`);
  assert.ok(got.dense <= denseClaim * 1.05,
    `密实档（尾巴上限）声称 ~${denseClaim} tokens，${READ_TOKEN_SAMPLES[2].file} 实测 ${got.dense} —— `
      + "描述又低估了尾巴，这正是 issue #267 要修的那条谎");
  // 3) 「有尾巴」这件事本身必须为真：否则三档是编出来的，旧写法（只报中位数）也就算不出错
  assert.ok(got.dense >= got.typical * 1.5,
    `实测尾巴（${got.dense}）没比典型值（${got.typical}）高到 1.5×，描述里的散布不成立`);
});

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
// issue #271：`readFile` 描述里「一次能装多少行」必须是复测值，而且必须**给换算式**。
// 旧文案 `~3,000-6,000 lines` 是 #264 那批描述留下的、`#267` 的 worker 明确声明「未复测、一字未改」的第二个数。
// 本仓 83 个真实 `.js` 按平均行长折算（口径见 measureReadLineCapacity）。**2026-10-13 首次复测**：装得最少的一档
// 4,387 行、中位 7,290 行、装得最多 9,772 行；**0 个文件低于 3,000、69 个高于 6,000** —— 那句区间整段下移（下限 4,387÷3,000=1.46×、
// 上限 9,772÷6,000=1.63×，而旧上限连实测**中位数** 7,290 都没盖住），代价是模型在该一次
// 要够的时候保守分批（正是 #264 治的那个病的反向表现）。所以这里钉的是「模型一次能要多少」这个事实本身。
//
// 口径：一次能装的行数 = floor(FILE_READ_MAX_BYTES_DEFAULT ÷ 平均行字节数)，平均行字节数 = 文件字节数 ÷ 物理行数
// （wc -l 口径；每行的 `\n` 已经计在字节里，所以**不再另加 1**）。
// ⚠ 与工单给的 4,411 / 7,120 / 9,954 差 <3%：主 agent 先按 `split("\n").length`（末尾空行也被算成一行）求平均、
//   再 `+1` 计换行，等于把换行计了两次；本测试用的是 bytes ÷ 行数这个物理分母。方向与结论不变（两种口径都是低估 2×）。
//
// CJK：**只测了本仓**。2026-10-13 那一刻本仓 CJK 字节占比最高的文件**恰好**就是「装得最少」的那一个（`src/loop/state-view.js`，37%），
// 所以旧句子把两件事并成了一句（`the 4,387 floor IS the most CJK-dense file`）。描述因此只给换算式 + 实测锚点，
// **没有**给「CJK 文件一般装多少行」的区间——那正是 #267 里被实测推翻的 `~4,000` 的错法（没测过的东西不许编区间）。
//
// ⚠ **2026-10-21 复测（工单 261021 那一刀之后）：顶红这两条测试的不是「均行长漂了 ±2%」，是极值的身份换了文件。**
//   `src/loop/resume-manager.js` 被那一刀净加了 62 行中文注释（130 增 / 68 删），平均行字节 48.6 → 61.15、
//   CJK 字节占比 9% → 24%，一次能装的行数从 5,391 掉到 **4,286**，**取代** `src/loop/state-view.js`（4,387 行、
//   37% CJK，自 #271 起一字未动、当场复测 0.00% 漂移）成为「装得最少」那一档；上面那个「floor 就是 CJK 最密那个」
//   的巧合随之成立不起来，描述拆成了**两个各自复测的锚点**（下面角色表里的 `fewest` 与 `densest`）。
//   中位随之从记录值 7,290 换成同口径实测的 **7,243**（`median` 那个锚点文件同步刷成实测值；
//   2026-10-22 起那个锚点文件是 `bin/repl.js`，原先的 `src/loop/termination.js` 被 #386 的 payload 组装
//   撑大 +74%、容量掉出中位带，见角色表里 median 那一行的注释）。
//   全树（`src`/`bin`/`examples` 共 91 个 `*.js`）实测的下界也仍是 resume-manager.js 的 4,286 ⇒ 描述里那句 floor 对全树也为真。
//   ⚠ 代价照 #275 的口径写明：floor 锚点现在钉在一个**本分支正在反复改**的文件上（±2% 只等于 ±7 行 / ±440 字节），
//     后续再动它的注释仍会红在这里——那是「描述里的数必须是实测值」这个决定的固有代价，不是新 bug。
// ---------------------------------------------------------------------------

// 样本是写死的 83 个路径（#271 的工单硬约束：不许 `find … | head -14` 这类随仓库新增文件漂移的隐式样本）。
// #275：清单与盘上**不再逐条对齐**。旧的 `assert.deepEqual(盘上枚举, 本清单)` + `length === 83` 是给全仓加的税：
// 任何人新增一个 `src/*.js` 都会红在本文件上，而本文件测的是 readFile 的额度事实。现在耦合方向是**单向**的：
// 清单里的路径必须仍在盘上（删/改名样本文件 = 测过的数失效，必须红），盘上**多出**文件不算失效——
// 描述里给的是「本仓口径的实测样本」，不是「本仓共有多少个 `.js`」（那个总数对读自己树的宿主也没意义）。
const READ_LINE_CAPACITY_SAMPLE = [
  "src/assembly-validators.js", "src/assembly.js", "src/compact/anchors.js", "src/compact/budget.js",
  "src/compact/enforce-size.js", "src/compact/fold-fidelity.js", "src/compact/fold-llm.js", "src/compact/fold-statistical.js",
  "src/compact/helpers.js", "src/compact/pipeline.js", "src/compact/provider-summarizer.js", "src/compact/sliding-window.js", "src/compact/strategy-resolution.js",
  "src/config/api-key.js", "src/config/env.js", "src/config/json-file.js", "src/config/static.js",
  "src/display/projection.js", "src/index.js", "src/loop/abort.js", "src/loop/aggregate-budget.js",
  "src/loop/block-helpers.js", "src/loop/budget.js", "src/loop/error-ledger.js", "src/loop/judge-record.js",
  "src/loop/messages.js", "src/loop/option-normalization.js", "src/loop/orchestrator.js", "src/loop/provider-runner.js",
  "src/loop/reflection.js", "src/loop/resume-manager.js", "src/loop/run-snapshot-executor.js", "src/loop/state-view.js",
  "src/loop/task-brief.js", "src/loop/termination.js", "src/loop/tool-result-ttl.js", "src/messages/anthropic.js",
  "src/messages/canonical.js", "src/messages/openai-normalization.js", "src/messages/rounds.js", "src/providers/anthropic.js",
  "src/providers/errors.js", "src/providers/http-shared.js", "src/providers/openai.js", "src/providers/payload.js",
  "src/providers/timeout.js", "src/reflection/governor.js", "src/reflection/judge.js", "src/reflection/l0.js",
  "src/reflection/wrapup.js", "src/run-state.js", "src/skills/loader.js", "src/store/append-user-turn.js",
  "src/store/file.js", "src/store/memory.js", "src/store/notes-memory.js", "src/store/notes-port.js",
  "src/store/notes.js", "src/text/label.js", "src/tokens.js", "src/tools/file-tools.js",
  "src/tools/index.js", "src/tools/notes.js", "src/tools/providers.js", "src/tools/registry.js",
  "bin/assembly-root.js", "bin/cli.js", "bin/config.js", "bin/final-guard-support.js",
  "bin/final-guard.js", "bin/guard-metrics.js", "bin/mcp.js", "bin/repl.js",
  "bin/session-scan.js", "bin/sessions.js", "bin/skills.js", "bin/tools.js",
  "examples/exec-demo.js", "examples/memory-benchmark.js", "examples/pi-extension/erix-run-core.js", "examples/pi-extension/erix-run-format.js",
  "examples/pi-extension/erix-run-jobs.js", "examples/pi-extension/erix-run-parent-wake.js",
];

// 描述点名的五个角色文件（fewest / densest / median / most + 本工具自己的源码）。
// `recorded` 是最后一次按本测试自己的口径（`measureReadLineCapacity`）在本棵树上实测的值；下面第一条把它也钉住（漂了就要三处一起改）。
// 2026-10-21：`fewest` 从 `src/loop/state-view.js` 换成 `src/loop/resume-manager.js`（极值身份换了文件，见上面的 ⚠ 注），
// 为了不把「floor 与 CJK 最密是同一个文件」当成免费前提，state-view.js 不再删掉而是另挂 `densest` 角色继续钉住。
const READ_LINE_CAPACITY_ROLES = [
  // 2026-10-21 按本测试口径复测后更新的 floor 锚点（本分支新加入的中文注释把它顶成了本仓最宽行的那一个）。
  // 2026-10-22 按本测试自己的口径**再复测**（issue #386 切片 3 给 `src/loop/resume-manager.js` 加了
  // guard 补跑配额的恢复：22,014 → 23,104 字节 / 360 → 370 行，均行字节 61.15 → 62.44，容量 4,286 → 4,198
  // ——漂移 -2.05%，刚好越过 ±2% ⇒ 记录值必须按实测同步；**容差常量一个都没动**）。
  // 2026-10-23 第五刷（issue #401）：`src/loop/resume-manager.js` 加了 resume 侧的折叠免疫
  // （宿主没折时再折一次 `store.load()` 的返回值，+844 字节 / +10 行），均行字节 62.44 → **63.02**，
  // 容量 4,198 → **4,159**（−0.93%，容差常量一个都没动）；描述里的 floor 与均行字节随之同步
  // （4,198 → **4,159**、62.4 → **63.0**，同位数 ⇒ 对本文件字节中性，所以 `self` 那一行不用再刷）。
  // 2026-10-23 第六刷（issue #404）：同一个文件又加了「复活赛告示」的准入与拼装调用
  // （+425 字节 / +6 行，均行字节 63.02 → **63.14**），容量 4,159 → **4,151**（−0.19%，仍在 ±2% 内，
  // 但只剩 0.22% 的字节余量 ⇒ 按本测试自己的口径复测并同步记录值，**容差常量一个都没动**）；
  // 描述里的 floor 与均行字节随之同步（4,159 → **4,151**、63.0 → **63.1**、CJK 占比 25% → **26%**），
  // 三处都是同位数替换 ⇒ 对本文件字节中性。`self` 那一行也一并按实测复测（见下）。
  // 2026-10-23 第七刷（issue #424）：同一个文件又加了「升级路径守卫」的交接字段与注释
  // （+1,055 字节 / +9 行，均行字节 63.14 → **64.3747**），容量 4,151 → **4,072**（−1.90%，仍在 ±2% 内，
  // 但均行字节本身越过 ±1% ⇒ 描述里的 floor / 均行字节 / CJK 占比一起按实测同步：4,151 → **4,072**、
  // 63.1 → **64.4**、26% → **27%**，三处都是同位数替换 ⇒ 对本文件字节中性，`self` 那一行不用再刷）；
  // 记录值按本测试自己的口径复测，**容差常量一个都没动**。
  { role: "fewest", file: "src/loop/resume-manager.js", recorded: { bytes: 25_428, lines: 395, bytesPerLine: 64.3747, capacity: 4_072, cjkShare: 0.2666 } },
  // CJK 字节占比最高的那一个（2026-10-13 到今一字未动，所以四个数仍与 #271 的原始记录逐字相同）。
  { role: "densest", file: "src/loop/state-view.js", recorded: { bytes: 2_629, lines: 44, bytesPerLine: 59.75, capacity: 4_387, cjkShare: 0.3731 } },
  // median 这一行 2026-10-22 换了**文件**（不是只刷数字）：issue #386 切片 1 给
  // `src/loop/termination.js` 加了 finalGuard payload 的组装与四个上限常量（+8,638 B / +163 行，
  // 字节 +74%），它的容量从 7,227 掉到 6,255，已经不再是样本中位（实测中位 7,225）——
  // 再把它当 median 锚点，描述里那句「median 7,243」就成了谎话。改钉 `bin/repl.js`
  // （29,279 B / 809 行 ⇒ 7,243 行，与样本中位差 0.25%，且分母比 provider-summarizer.js 大 7 倍，
  // ±2% 的抖动额度从 ±2 行变成 ±16 行）。描述里的 `median 7,243 (36.3)` 因此**一个字都不用改**。
  // 2026-10-23 第三刷（#391 改了 `bin/repl.js`：`--require-deliverable` + `loopOptions.deliverables` +
  // `loopOptions.cwd`，+1,872 B / +30 行 ⇒ 7,243 → **7,009**，-3.2% 已超出 ±2%）：角色文件仍是
  // `bin/repl.js`（与当场样本中位 7,117 差 1.5%，仍在 ±2% 内），但记录值与描述里的
  // `median 7,009 (37.4)` 一起刷新（同位数改动 ⇒ 字节中性）。
  // 2026-10-23 第四刷（#391 R2 又改了 `bin/repl.js`：`--require-deliverable [<path>]` 的可选值解析 +
  // 帮助文本，+2,603 B / +44 行 ⇒ 7,009 → 6,812，-4.3% 已**掉出**样本中位 7,117 的 ±2% 带）：
  // 这次**换文件**——`median` 改钉 `src/tools/registry.js`（6,250 B / 170 行 ⇒ 7,130，与样本中位差
  // 0.18%，分母够大：±2% 的额度是 ±142 行）。`bin/repl.js` 不再占任何角色（它仍在样本清单里，
  // 只是不再是「最接近中位」的那一个）。描述里的 `median 7,009 (37.4)` → `median 7,130 (36.8)`
  // 是**同位数替换**（对本文件字节数中性，所以这一行不因描述改动而再刷）。
  // 历史：2026-10-21 从 #271 的记录值（11,471 B / 319 行 → 7,290）刷成同口径实测值（11,643 / 321 / 36.271）。
  // 2026-10-23 第五刷（issue #406 B2-a，**换文件**）：`src/index.js` 也是本样本的一员，本单给它加了
  // 三条包根导出与它们的注释（4,407 B / 120 行 ⇒ 5,125 B / 127 行，均行 36.73 → 40.35），容量
  // 7,138 → **6,496**——刚好从样本中位的**上方**跨到下方，把中位那个元素从 `src/config/api-key.js`
  // （7,117）顶成了 `src/tools/notes.js`（**6,952**，实测中位恰好就是它）。所以这一行改钉
  // `src/tools/notes.js`（29,901 B / 793 行 ⇒ 37.7062 B/line ⇒ 6,952，与样本中位差 0.00%，
  // 分母够大：±2% 的额度是 ±139 行），描述里的 `median 7,130 (36.8)` → `median 6,952 (37.7)`
  // 是**同位数替换**（对本文件字节数中性，所以 `self` 那一行不用再刷）。
  // 上一任 `src/tools/registry.js`（7,130）仍在样本清单里，只是不再是「最接近中位」的那一个。
  // 2026-10-24 第八刷（issue #439，与 main 上 #406 B2-a 的第五刷**合流后是同一条结论**）：
  // `src/loop/error-ledger.js` 也是本样本的一员，本单给 `capError` 加了「保留 `error.phase`」的归一化与
  // 注释（4,248 B / 119 行 ⇒ 6,727 B / 158 行，均行字节 35.70 → 42.58；含评审退回项给 `error.phase`
  // 的 getter 兜底），它的容量 7,343 → 6,157 掉到中位以下 ⇒ **样本中位从 7,117 变成 6,952**
  // （−2.3%，越过 ±2%）。两支独立走到同一个落点，合并后**一字不差**（所以不再刷第二遍）：
  // ① `median` 角色钉 `src/tools/notes.js`（29,901 B / 793 行 ⇒ 37.7062 B/line ⇒ 6,952 行，与当场样本
  //    中位**完全相等**，且分母够大：±2% 的额度是 ±139 行）；② 描述里的 `median 7,130 (36.8)` →
  //    `median 6,952 (37.7)` 是**同位数替换**（对本文件字节数中性 ⇒ `self` 那一行不用再刷）；
  // ③ `src/tools/registry.js`（容量 7,130 未变）不再占任何角色。**容差常量一个都没动。**
  // 这次换文件把「中位锚点紧贴样本中位」的脆弱性清掉了：`error-ledger.js` 现在离中位还有 795 行的
  // 余量，再改它不会一步越过 ±2%（#439 的注释因此可以写全）。
  { role: "median", file: "src/tools/notes.js", recorded: { bytes: 29_901, lines: 793, bytesPerLine: 37.7062, capacity: 6_952, cjkShare: 0.1301 } },
  // 2026-10-23 #391：`most` 也**换了文件**——`bin/guard-metrics.js` 从 456 B / 17 行长到 1,063 B / 23 行
  // （均行 26.8 → 46.2），容量 9,772 → 5,671，已经不是「一次装得最多」那一个。样本里现在最大的是
  // `src/messages/openai-normalization.js`（5,496 B / 201 行 ⇒ 27.34 B/line ⇒ 9,587 行），描述里那一档随之
  // `most 9,772 (26.8)` → `most 9,587 (27.3)`（同位数 ⇒ 对本文件字节数中性）。
  // 2026-10-23 第七刷（issue #409）：`most` 又**换了文件**——`src/messages/openai-normalization.js` 这一刀把
  // 引数解析换成共享入口 `parseToolArguments`（`src/messages/tool-arguments.js`），从 5,496 B / 201 行
  // 长到 6,232 B / 207 行（均行 27.34 → 30.11），容量 9,587 → 8,707，已不是「一次装得最多」那一个。
  // 样本里现在最大的是 `src/loop/abort.js`（1,031 B / 37 行 ⇒ 27.86 B/line ⇒ 9,407 行），描述里那一档随之
  // `most 9,587 (27.3)` → `most 9,407 (27.9)`（同位数 ⇒ 对本文件字节数中性）。
  { role: "most", file: "src/loop/abort.js", recorded: { bytes: 1_031, lines: 37, bytesPerLine: 27.8649, capacity: 9_407, cjkShare: 0 } },
  // self 这一行在 PR #291 返工（必修 4）里重测过：`classifyFileToolResult` 的 JSDoc 改成按 `kind`
  // 关联的判别联合（工单明说改它的 JSDoc 是允许的，生成的 `.d.ts` 里 `kind:"bytes"` 那一支的
  // `bytes` 必须是 `number`），而本行原本记录的 89,537 字节与当时 1,718 行已经被此前几个单
  // 顶到 ±2% 限的内侧只剩 11 字节——任何一次注释改动都会报「事实漂移」。按本测试自己给的
  // 口径（`measureReadLineCapacity`）复测后更新；那次只刷了记录值，描述里点名的 `5,029` 仍在 ±1% 容差内。
  // 2026-10-21 又刷了一次，原因就是上面那条 ⚠ 里那一刀改了 `readFile` 的描述本身（描述就在这个文件里）：
  // 现在描述里那句「this tool's own source fits 4,938」与本行记录的是**同一个实测值**（不再是旧记录值 5,029）。
  // 2026-10-22 再刷一次：issue #215/#222 改了本文件的 `tree` 根标签与排除账 marker（+3.9% 字节、+56 行），
  // 自指锚点当场红（这正是它该做的事）；描述里的自身容量 `4,966` 随之实测为 `4,938` 并已同步。
  // 2026-10-22 第三刷：issue #219/#221 给搜索根加了存在性判定、把弃用提示的 mode 改成按入参生成
  // （+3.9% 字节、+59 行），自指锚点同样当场红；描述里的自身容量 `4,938` 随之实测为 `4,896` 并已同步。
  // ⚠ 自指：改本文件的任何注释与描述都会挪动这一行的字节数——改完先跑本测试再定数字（同一位数的数字改动是字节中性的）。
    // 2026-10-22 第四刷（rebase 到已含 #219/#221 的 main 之后重测）：issue #358 给读侧加了
  // `[参数校正：…]` / `[已到末尾：…]`、`normalizeIntegerWithReport` 与中文路径文案。描述里那句
  // 「this tool's own source fits」随之 4,896 → 4,857（同位数改动 ⇒ 字节中性，所以复测在此之前做完即可）。
  // 2026-10-22 第五刷（issue #386 切片 3）：本单只改了上面 `fewest` 那一行的记录值与本文件的两条注释、
  // 外加 `readFile` 描述里的两个数（floor 4,286 → 4,198、本工具自身容量 4,857 → 4,844），自指锚点照旧
  // 当场红、按同口径复测后同步。
  // 2026-10-23（issue #404）：描述里的 floor / 均行字节 / 自身容量三处数字同步（同位数 ⇒ 字节中性），
  // 记录值按本测试口径复测：107,620 → **107,772** 字节 / 1,989 → **1,991** 行 / 容量 4,844 → **4,842**。
  { role: "self", file: "src/tools/file-tools.js", recorded: { bytes: 107_772, lines: 1_991, bytesPerLine: 54.1296, capacity: 4_842, cjkShare: 0.2683 } },
];

const READ_LINE_CAPACITY_DIRS = ["src", "bin", "examples"];
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// 角色按**名字**取，不按 `ROLES[0]` 取：2026-10-21 之后 floor 与 CJK 最密落在两个不同文件上，
// 靠下标把两件事当成一个文件就是本次红的根因（`ROLES[0]` 同时被当作了 floor 与 densest 的锚点）。
function roleFile(role) {
  const entry = READ_LINE_CAPACITY_ROLES.find((item) => item.role === role);
  assert.ok(entry, `角色清单里没有 ${role}（本测试的锚点口径失效，请同步本测试）`);
  return entry.file;
}

// 口径就写在这里：平均行字节数 = 文件字节数 ÷ 物理行数（每行的 \n 已含在字节里，不再 +1）。
function measureReadLineCapacity(rel) {
  const abs = join(REPO_ROOT, rel);
  assert.ok(existsSync(abs), `写死的样本文件不在了：${rel}（改名/删除请同步本测试与 readFile 描述里的数）`);
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

// 全仓扫描（src/bin/examples 下的 `*.js`）。#275 后它**不再与写死清单逐条对齐**，
// 只用来跑单调性质与信息性输出（见下面那条「加一个文件不该红」的测试）。
function listShippedSourceFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && entry.name.endsWith(".js")) found.push(rel);
    }
  };
  for (const dir of READ_LINE_CAPACITY_DIRS) walk(dir);
  return found.sort();
}

function assertClose(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * tolerance,
    `${label}：实测/基准 ${expected}，另一次 ${actual}，差 ${(Math.abs(actual - expected) / Math.abs(expected) * 100).toFixed(2)}%`
    + ` 超出 ±${(tolerance * 100).toFixed(1)}% → 事实漂移：复测后把 readFile 描述、本测试的记录值、CHANGELOG 的 #271 条目一起改`);
}

test("readFile 行数容量的五个角色锚点未漂移，样本清单仍盘上可寻（#271：数不许静默过期；#275：不再与全树钉死）", () => {
  // #275：旧的 `length === 83` 与 `deepEqual(盘上枚举, 本清单)` 已删（那是给全仓加的税）。
  // 剩下的耦合是**单向包含**：样本文件被删/改名就当场红，盘上新增多出文件不红。
  const onDisk = new Set(listShippedSourceFiles());
  const missing = READ_LINE_CAPACITY_SAMPLE.filter((rel) => !onDisk.has(rel));
  assert.deepEqual(missing, [],
    `写死的样本文件在盘上找不到了：${missing.join(", ")} → 按 measureReadLineCapacity 的口径复测后，`
    + "把 readFile 描述、本清单、CHANGELOG 的 #271 条目一起改（新增文件不会走到这条：盘上多出东西不算失效）");
  for (const { file, recorded } of READ_LINE_CAPACITY_ROLES) {
    const got = measureReadLineCapacity(file);
    assertClose(got.bytes, recorded.bytes, 0.02, `${file} 字节数（#271 记录值）`);
    assertClose(got.lines, recorded.lines, 0.02, `${file} 行数（#271 记录值）`);
    assertClose(got.capacity, recorded.capacity, 0.02, `${file} 一次能装的行数（#271 记录值）`);
    assert.ok(Math.abs(got.cjkShare - recorded.cjkShare) <= 0.02,
      `${file} 的 CJK 字节占比从 ${(recorded.cjkShare * 100).toFixed(1)}% 变成 ${(got.cjkShare * 100).toFixed(1)}%`
      + " → 描述里 CJK 那半句（含 37% 这个数）要重测");
  }
  // 描述里「floor 那个文件」与「CJK 最密那个文件」这两句话的四个前提（2026-10-21 起它们是**两个**文件，
  // 所以两条断言各自钉自己的角色；口径仍是**写死清单**而不是全树枚举：新增文件不会把这两个极值拉下马（那正是 #275 要的）；
  //   全树上的单调性质另有一条不断言条数的测试在 `readFile 行容量：全仓扫描只留单调性质` 里看。
  const rows = READ_LINE_CAPACITY_SAMPLE.map(measureReadLineCapacity);
  const densest = rows.reduce((a, b) => (b.cjkShare > a.cjkShare ? b : a));
  const fewest = rows.reduce((a, b) => (b.capacity < a.capacity ? b : a));
  assert.equal(densest.rel, roleFile("densest"),
    `CJK 最密的文件已不是 ${roleFile("densest")}（现在是 ${densest.rel}，占比 ${(densest.cjkShare * 100).toFixed(1)}%）`);
  assert.equal(fewest.rel, roleFile("fewest"),
    `「一次装得最少」的文件已不是 ${roleFile("fewest")}（现在是 ${fewest.rel}，${fewest.capacity} 行）→ floor 数字要重测`);
  // 反向证：两个极值如果重新落到同一个文件上，上面两条仍会绿，而描述里那句「两个锚点」就成了谎话 —— 这里再钉一句。
  assert.notEqual(densest.rel, fewest.rel,
    "CJK 最密与装得最少又回到了同一个文件（现在两个角色钉的都是它）：描述里的「两个各自复测的锚点」要重新审视，"
    + "并把两个角色与句子一起改回一句话（本条故意不许静默默过）");
});

test("readFile 描述给换算式 + 本仓复测行数容量（#271：旧 `~3,000-6,000 lines` 上限低估 1.6×）", () => {
  const description = FILE_TOOL_DEFINITIONS.find((definition) => definition.name === "readFile").description;
  assert.doesNotMatch(description, /~3,000-6,000/u, "未复测的旧区间 `~3,000-6,000 lines` 又回来了（issue #271 要修的正是它）");
  assert.match(description, /max_bytes ÷ average bytes per line/u,
    "字节额度必须给**换算式**（#271 期望修法 1：给公式而不是区间）");
  assert.match(description, /far more than a single `limit` will ask for/u,
    "「字节上限远大于一次 limit 会要的量」这条行为指导必须在场（#264/#271 共同要治的保守分批）");

  const tiers = description.match(
    /fewest ([\d,]+) lines \(([\d.]+) bytes\/line[^)]*\), median ([\d,]+) \(([\d.]+)\), most ([\d,]+) \(([\d.]+)\)/u,
  );
  assert.ok(tiers, "描述不再按「fewest / median / most + 各自 bytes/line」给行数容量 → 本测试的解析面失效。"
    + "改句式可以，但必须同步本测试，不许让这条断言静默变成永真。");
  const [fewestClaim, fewestBplClaim, medianClaim, medianBplClaim, mostClaim, mostBplClaim] = tiers.slice(1)
    .map((value) => Number(value.replace(/,/g, "")));
  // #275：模型可见面**不再声称文件条数**。旧句式「Measured that way on the 83 `.js` files shipped here …
  // not one of the 83 falls below 3,000, and 69 of them take over 6,000」里那三个总量（83 / 0 of 83 / 69 of 83）
  // 随仓库演化必然过期，对读自己树的宿主也没有意义；写在那里就等于给全仓加一道与 readFile 无关的税。
  // 下面三条反向证让「有人又把总量写回描述」当场红。
  assert.doesNotMatch(description, /\b[\d,]+ `?\.js`? files\b/u,
    "描述又开头声称「本仓有多少个 `.js`」（#271 旧文案的 the 83 `.js` files）：本仓文件总数不是 readFile 的事实，别写回模型可见面");
  assert.doesNotMatch(description, /not one of the [\d,]+ falls below/u,
    "描述又给了「N 个文件从不下穿某一档」这种依赖全仓条数的总量（#275 已删，要回去就连带把统计根子钉回来）");
  assert.doesNotMatch(description, /[\d,]+ of them take over/u,
    "描述又给了「多少个文件一次能装超过某一档」这种依赖全仓条数的总量（#275 已删，同上）");
  // 2026-10-21：floor 与「CJK 最密」落在两个不同文件上，句子拆成了**两个各自复测的锚点**，解析面跟着拆。
  // 断言只多不少：捕获位从 4 个变成 7 个（floor 文件 + 它的 CJK 占比、densest 文件 + 它的占比 + 它的容量、本工具自身容量）。
  const cjk = description.match(
    /the ([\d,]+) floor is itself a CJK-heavy file \(`([^`]+)`, (\d+)% of its bytes are CJK\), while the most CJK-dense file in that sample \(`([^`]+)`, (\d+)%\) fits ([\d,]+) and this tool's own source fits ([\d,]+)/u,
  );
  assert.ok(cjk, "描述不再按「floor 那个文件 + 它的 CJK 占比 / CJK 最密那个文件 + 它的占比与容量 / 本工具自身源码容量」给出两个 CJK 锚点"
    + " → 解析面失效（同步本测试，不许让这条断言静默变成永真）");
  const floorRepeatClaim = Number(cjk[1].replace(/,/g, ""));
  const floorFileClaim = cjk[2];
  const floorCjkPercentClaim = Number(cjk[3]);
  const densestFileClaim = cjk[4];
  const cjkPercentClaim = Number(cjk[5]);
  const densestCapacityClaim = Number(cjk[6].replace(/,/g, ""));
  const selfCapacityClaim = Number(cjk[7].replace(/,/g, ""));
  // 旧句子把两件事当成一件（`the 4,387 floor IS the most CJK-dense file`），2026-10-21 的复测已推翻它；
  // 写回来就红（否则两个锚点会重新只在同一个文件上被钉住，floor 一换文件就又静默过期）。
  assert.doesNotMatch(description, /floor IS the most CJK-dense/u,
    "描述又把「floor 恰好就是 CJK 最密那一个」写回来了：2026-10-21 实测 floor 是 `src/loop/resume-manager.js`（CJK 24%）、"
    + "CJK 最密是 `src/loop/state-view.js`（37%），两个锚点必须各自复测各自说");

  // 当场复测（写死路径，同一口径）
  const rows = READ_LINE_CAPACITY_SAMPLE.map(measureReadLineCapacity);
  const byRole = Object.fromEntries(READ_LINE_CAPACITY_ROLES.map(({ role, file }) => [role, measureReadLineCapacity(file)]));
  const caps = rows.map((row) => row.capacity).sort((a, b) => a - b);
  const measuredFewest = caps[0];
  const measuredMost = caps[caps.length - 1];
  const measuredMedian = caps.length % 2 === 1
    ? caps[(caps.length - 1) / 2]
    : (caps[caps.length / 2 - 1] + caps[caps.length / 2]) / 2;

  // 1) 声称的三个档位必须由小到大，且与当场实测同档（旧文案 3,000 / — / 6,000 在这里必红）
  assert.ok(fewestClaim < medianClaim && medianClaim < mostClaim,
    `描述声称的档位必须由小到大，实际是 ${fewestClaim} / ${medianClaim} / ${mostClaim}`);
  assert.equal(floorRepeatClaim, fewestClaim, "同一句里 floor 出现两次却不同值");
  assert.equal(floorFileClaim, roleFile("fewest"), "描述点名的 floor 文件与 `fewest` 角色清单不齐");
  assertClose(fewestClaim, measuredFewest, 0.02, "描述声称的「一次最少装多少行」");
  assertClose(medianClaim, measuredMedian, 0.02, "描述声称的中位行数容量");
  assertClose(mostClaim, measuredMost, 0.01, "描述声称的「一次最多装多少行」");
  // 1b) #275：三个档位还必须逐个对上**那 4 个锚点文件**的当场实测（不靠全树分布也算得出同一个结论）。
  //     这就是「把声称数字改坏就红」的反向证（本单实跑）：上限 9,772 改成 6,000 → 红「档位必须由小到大」；
  //     改成不打乱大小的 8,000 → 红 ±1% 容差那条（「实测/基准 9772，另一次 8000，差 18.13%」）；要让 1b) 也喂饱，
  //     只能把那个数字改回 9,772 本身（它的 bytes/line 与 2) 的自洽也只允许这一个值）。
  assertClose(fewestClaim, byRole.fewest.capacity, 0.02, `描述声称的 fewest 档 == ${byRole.fewest.rel} 当场实测`);
  assertClose(medianClaim, byRole.median.capacity, 0.02, `描述声称的 median 档 == ${byRole.median.rel} 当场实测`);
  assertClose(mostClaim, byRole.most.capacity, 0.01, `描述声称的 most 档 == ${byRole.most.rel} 当场实测`);

  // 2) 每档配的 bytes/line 必须真是那个文件的均行字节，且与声称行数在公式下自洽
  assertClose(fewestBplClaim, byRole.fewest.bytesPerLine, 0.01, "fewest 档声称的平均行字节");
  assertClose(medianBplClaim, byRole.median.bytesPerLine, 0.01, "median 档声称的平均行字节");
  assertClose(mostBplClaim, byRole.most.bytesPerLine, 0.01, "most 档声称的平均行字节");
  for (const [label, lines, bpl] of [["fewest", fewestClaim, fewestBplClaim], ["median", medianClaim, medianBplClaim], ["most", mostClaim, mostBplClaim]]) {
    assertClose(lines, Math.floor(FILE_READ_MAX_BYTES_DEFAULT / bpl), 0.05, `描述内部自洽（${label}：行数应等于 max_bytes ÷ 它自己给的 bytes/line）`);
  }

  // 3) #275：描述里不再有「样本数 / 多少个高于某档」这两个总量，于是那一段历史声称（#264 旧文案
  //    `~3,000-6,000 lines`）以**测试内常量**留档：实测中位必须仍盖过旧上限、实测下界必须仍远高于它的一半，
  //    否则「保守分批」那个旧口径重新成立，描述的整段换算要重谈。这个事实不依赖任何文件条数。
  const LEGACY_UNMEASURED_CEILING = 6_000; // #264 旧文案的上限（当时没人复测）
  const LEGACY_UNMEASURED_FLOOR = 3_000;   // #264 旧文案的下界
  assert.ok(LEGACY_UNMEASURED_FLOOR < measuredFewest,
    `旧下界 ${LEGACY_UNMEASURED_FLOOR} 重新变得可信（实测下界只有 ${measuredFewest}）→ #271 的结论要重测`);
  assert.ok(measuredMedian > LEGACY_UNMEASURED_CEILING,
    `实测中位行数容量 ${measuredMedian} 没有超过 ${LEGACY_UNMEASURED_CEILING}：旧上限重新成立了，描述与本测试的口径都要重谈`);
  assert.ok(rows.every((row) => row.capacity >= measuredFewest && row.capacity <= measuredMost),
    "清单内的极值不自洽（重算逻辑被改坏）");

  // 4) CJK：本仓实测支持「CJK 让行数按比例下降」这句话；但描述不许给没测过的 CJK 区间。
  //    2026-10-21 起这一节钉**两个**锚点：CJK 最密那个文件（身份 + 占比 + 它的容量）与 floor 那个文件自己的占比。
  const densest = rows.reduce((a, b) => (b.cjkShare > a.cjkShare ? b : a));
  assert.equal(densestFileClaim, densest.rel, "描述点名的「CJK 最密那个文件」已不是样本里当场实测最密的那一个");
  assert.equal(densestFileClaim, roleFile("densest"), "描述点名的 CJK 锚点文件与 `densest` 角色清单不齐");
  assertClose(cjkPercentClaim, densest.cjkShare * 100, 0.05, "描述声称的 CJK 字节占比");
  assertClose(densestCapacityClaim, byRole.densest.capacity, 0.01, "描述声称的「CJK 最密那个文件一次能装多少行」");
  assertClose(floorCjkPercentClaim, byRole.fewest.cjkShare * 100, 0.05, "描述声称的 floor 文件的 CJK 字节占比");
  assertClose(selfCapacityClaim, byRole.self.capacity, 0.01, "描述声称的「本工具自己的源码一次能装多少行」");
  assert.ok(byRole.self.capacity < measuredMedian,
    `描述说 CJK 会按比例压低行数，但 ${byRole.self.rel}（CJK ${(byRole.self.cjkShare * 100).toFixed(1)}%）实测 ${byRole.self.capacity} 行，不低于中位 ${measuredMedian}`);
  assert.doesNotMatch(description, /~[\d,]+ lines[^.]*CJK|CJK[^.]*~[\d,]+ lines/u,
    "描述给 CJK 编了一个行数区间——本仓只测过上面那一个 CJK 锚点，没测过的东西写「按公式自行折算」（#267 的 `~4,000` 教训）");
});

// ---------------------------------------------------------------------------
// issue #275：全仓扫描（src/bin/examples 下的 `*.js`）从「钉死条数」降级为**只断单调性质 + 信息性输出**。
// 它保留的价值是「描述里 floor 4,286 / CJK 最密 37% 那两句有没有被新文件推翻」；它**不再**因为
// 「有人新增了一个普通的 `.js`」而红——旧写法 `assert.deepEqual(盘上枚举, 写死清单)` 正是在这里给全仓加税：
// 红的是一个测 readFile 额度的文件，而改的人往往不知道为什么红。
// 单调性说明：下面两条的阈值都是**松的**（旧文案的 3,000 / 样本条数），普通新增（平均行字节不超过约 87B）
// 不可能会碍它们；只有真的把描述里的声称变成谎话时才会红。
// ---------------------------------------------------------------------------

test("readFile 行数容量：全仓扫描只留单调性质与信息性输出，新增一个文件不得变红（#275）", () => {
  const scanned = listShippedSourceFiles().map(measureReadLineCapacity);
  // 单调性质 1：盘上能找到的文件不少于写死样本（新增只会变大；跌到比样本还少才是真信号）。
  assert.ok(scanned.length >= READ_LINE_CAPACITY_SAMPLE.length,
    `盘上 ${READ_LINE_CAPACITY_DIRS.join("/")} 的 *.js 只剩 ${scanned.length} 个，比 #271 的写死样本（${READ_LINE_CAPACITY_SAMPLE.length}）还少`
    + " → 有样本文件被删除，描述里的档位要重测（新增不会走到这条）");
  // 单调性质 2：全树实测下界仍不得跌进 #264 旧文案那档（阈值取旧下界 3,000 而不是声称的 4,286，就是为了让新增宽容件不红）。
  const fewest = scanned.reduce((a, b) => (b.capacity < a.capacity ? b : a));
  const densest = scanned.reduce((a, b) => (b.cjkShare > a.cjkShare ? b : a));
  assert.ok(fewest.capacity > 3_000,
    `${fewest.rel} 一次只能装 ${fewest.capacity} 行（均行 ${fewest.bytesPerLine.toFixed(1)}B），已跌进旧文案的 3,000 那档`
    + " → 描述里「fewest 4,286」这个 floor 已被新文件推翻，要按 measureReadLineCapacity 重测并改描述");
  // 信息性输出（不断言）：本仓当前分布、极值落在哪两个文件上、描述点名的两个锚点是否仍站得住。
  // ⚠ 全树极值与写死样本极值可以不同（新增文件不进样本清单，那正是 #275 要的），所以这里只报数不断言；
  //   描述里的「in that sample」口径就是那份写死样本，不是全树。
  console.log("#275 read-line capacity sweep:", JSON.stringify({
    scanned: scanned.length,
    pinnedSample: READ_LINE_CAPACITY_SAMPLE.length,
    fewest: { file: fewest.rel, capacity: fewest.capacity, bytesPerLine: Number(fewest.bytesPerLine.toFixed(2)) },
    densest: { file: densest.rel, cjkShare: Number((densest.cjkShare * 100).toFixed(1)) },
    anchorsStillHold: {
      fewestIsThePinnedOne: fewest.rel === roleFile("fewest"),
      densestIsThePinnedOne: densest.rel === roleFile("densest"),
    },
  }));
});
