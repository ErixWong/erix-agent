// src/tools/file-tools.js 的实现侧测试（issue #184）
// 契约面走通用套件 fileToolsContract；这里只补「库自己的口径」：
// 默认无边界（ADR-009 牢笼归宿主）、env 三件套、无 signal 不让出、大文件有界读不回退成整文件读、
// rg/grep 默认正则与真实命令同口径（#184 追加轮 A，含 schema 描述真值）。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile as readFilePromise, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers";
import { makeTmp } from "../helpers/tmp.js";

import {
  createFileTools,
  resolveFileReadMaxBytes,
  formatSize,
  FILE_READ_MAX_BYTES_DEFAULT,
} from "../../src/tools/file-tools.js";
import { fileToolsContract } from "../contract/file-tools.js";

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
