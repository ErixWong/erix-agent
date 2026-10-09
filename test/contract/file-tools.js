// 文件工具契约测试套件（issue #184；工厂注入风格照 test/contract/transcript-store.js）
//
// 任何 createFileTools 实现（库内置 src/tools/file-tools.js、宿主自己的 fork、
// 宿主包的 CLI 适配层）都必须通过同一组断言。用法：
//
//   import { fileToolsContract } from "erix-agent/contract-tests";
//   import { createFileTools } from "erix-agent/tools";
//   fileToolsContract("erix-agent", { createFileTools });
//
// 契约面（派单 261009-184 的交付物 4）：
//   * executeTool 的两种调用形态（位置 (name, input, context) 与结构化 {name,input,context,signal}）；
//   * allowRead/allowWrite 以**绝对路径**被调用，越界返回「错误：…」文本结果而非抛；
//   * readFile 单次返回不超过 max_bytes（默认 262144）；
//   * vendor 目录默认跳过且结果尾部带排除账，include_vendor=true 可撤销；
//   * 无命中统一「（无命中）」；tree 截断必须带 marker + 剩余计数；
//   * 遍历可被 context.signal 中止。
//
// 实现特有行为（宿主 jail 的具体谓词、CLI 终端回显）由实现方自行补测，不进契约。
// ⚠️ 隔离：每个用例注入临时 cwd（node:test + fs.mkdtemp），不得读写真实 ~/.erix。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 契约文档 docs/host-consumer-contract.md「File tool registration」声明的默认值。
const READ_MAX_BYTES_DEFAULT = 262_144;
const TREE_ENTRY_LIMIT = 500;

async function withDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-file-tools-contract-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * @param {string} label 实现名（测试标题前缀）
 * @param {{ createFileTools: (options: { cwd?: string, allowRead?: Function, allowWrite?: Function })
 *   => { definitions: object[], executeTool: Function } }} deps 待验实现
 */
export function fileToolsContract(label, { createFileTools }) {
  test(`${label}: 导出五个文件工具的 definitions`, () => {
    const tools = createFileTools({ cwd: process.cwd() });
    assert.deepEqual(
      tools.definitions.map((definition) => definition.name).sort(),
      ["grep", "readFile", "rg", "tree", "writeFile"],
    );
    for (const definition of tools.definitions) {
      assert.ok(definition.inputSchema, `${definition.name} 必须有 inputSchema`);
      assert.equal(definition.inputSchema.additionalProperties, false);
    }
  });

  test(`${label}: executeTool 两种调用形态都可用`, async () => {
    await withDirectory(async (cwd) => {
      await writeFile(path.join(cwd, "a.txt"), "hello\nworld\n", "utf8");
      const tools = createFileTools({ cwd });

      const positional = await tools.executeTool("readFile", { path: "a.txt" }, {});
      assert.equal(positional, "1: hello\n2: world");

      const structured = await tools.executeTool({
        id: "toolu_1",
        name: "readFile",
        input: { path: "a.txt", offset: 1 },
        context: { round: 2 },
      });
      assert.equal(structured, "2: world");
    });
  });

  test(`${label}: allowRead/allowWrite 以绝对路径被调用`, async () => {
    await withDirectory(async (cwd) => {
      await writeFile(path.join(cwd, "a.txt"), "hello\n", "utf8");
      const reads = [];
      const writes = [];
      const tools = createFileTools({
        cwd,
        allowRead: (target) => {
          reads.push(target);
          return true;
        },
        allowWrite: (target) => {
          writes.push(target);
          return true;
        },
      });

      await tools.executeTool("readFile", { path: "a.txt" });
      await tools.executeTool("tree", { path: "." });
      await tools.executeTool("writeFile", { path: "sub/b.txt", content: "x" });

      assert.ok(reads.length >= 2, `allowRead 必须被调用（实际 ${reads.length} 次）`);
      assert.ok(writes.length >= 1, `allowWrite 必须被调用（实际 ${writes.length} 次）`);
      for (const target of [...reads, ...writes]) {
        assert.ok(path.isAbsolute(target), `谓词必须收到绝对路径，实际收到 ${target}`);
      }
      assert.ok(reads.includes(path.join(cwd, "a.txt")), "readFile 的解析结果必须原样喂给 allowRead");
      assert.ok(writes.includes(path.resolve(cwd, "sub/b.txt")));
    });
  });

  test(`${label}: 遍历中逐条判定 allowRead（宿主在 executeTool 外包一层做不到）`, async () => {
    await withDirectory(async (cwd) => {
      await mkdir(path.join(cwd, "private"), { recursive: true });
      await writeFile(path.join(cwd, "keep.txt"), "needle keep\n", "utf8");
      await writeFile(path.join(cwd, "private", "hidden.txt"), "needle private\n", "utf8");
      const tools = createFileTools({
        cwd,
        allowRead: (target) => !target.includes(`${path.sep}private`),
      });

      const output = await tools.executeTool("grep", { pattern: "needle" });
      assert.match(output, /keep\.txt/u);
      assert.doesNotMatch(output, /needle private/u);
      assert.match(output, /宿主边界拒绝/u, "越界条目必须计入排除账");

      const tree = await tools.executeTool("tree", { path: "." });
      assert.doesNotMatch(tree, /hidden\.txt/u);
    });
  });

  test(`${label}: 越界读/写返回错误结果而非抛`, async () => {
    await withDirectory(async (cwd) => {
      await writeFile(path.join(cwd, "secret.txt"), "top secret\n", "utf8");
      const tools = createFileTools({ cwd, allowRead: () => false, allowWrite: () => false });

      const read = await tools.executeTool("readFile", { path: "secret.txt" });
      assert.match(read, /^错误：/u);

      const written = await tools.executeTool("writeFile", { path: "out.txt", content: "x" });
      assert.match(String(written), /^错误：/u);
      assert.equal(existsSync(path.join(cwd, "out.txt")), false, "allowWrite false 不得落盘");

      const search = await tools.executeTool("rg", { pattern: "secret" });
      assert.match(search, /^错误：/u);
      const tree = await tools.executeTool("tree", { path: "." });
      assert.match(tree, /^错误：/u);
    });
  });

  test(`${label}: readFile 单次返回不超过 max_bytes`, async () => {
    await withDirectory(async (cwd) => {
      const lines = Array.from({ length: 3_000 }, (_, index) => `line ${index} ${"x".repeat(90)}`);
      await writeFile(path.join(cwd, "big.txt"), `${lines.join("\n")}\n`, "utf8");
      const tools = createFileTools({ cwd });

      const capped = await tools.executeTool("readFile", { path: "big.txt", max_bytes: 4_096 });
      assert.ok(
        Buffer.byteLength(capped, "utf8") <= 4_096,
        `显式 max_bytes 必须封顶：${Buffer.byteLength(capped, "utf8")} > 4096`,
      );
      assert.match(capped, /^1: line 0 /u, "行号格式保持不变");
      assert.match(capped, /max_bytes=4096/u, "触顶必须回报");

      const defaulted = await tools.executeTool("readFile", { path: "big.txt", limit: 10_000 });
      assert.ok(
        Buffer.byteLength(defaulted, "utf8") <= READ_MAX_BYTES_DEFAULT,
        `默认上限必须封顶：${Buffer.byteLength(defaulted, "utf8")} > ${READ_MAX_BYTES_DEFAULT}`,
      );

      const offset = await tools.executeTool("readFile", { path: "big.txt", offset: 1_000, limit: 3 });
      assert.match(offset, /^1001: line 1000 /u, "offset 仍是行偏移");
    });
  });

  test(`${label}: readFile 小文件行为与历史一致（行号 + 共 N 行 marker）`, async () => {
    await withDirectory(async (cwd) => {
      const lines = Array.from({ length: 12 }, (_, index) => `row ${index}`);
      await writeFile(path.join(cwd, "small.txt"), `${lines.join("\n")}\n`, "utf8");
      const tools = createFileTools({ cwd });

      const first = await tools.executeTool("readFile", { path: "small.txt", limit: 5 });
      assert.equal(
        first,
        "1: row 0\n2: row 1\n3: row 2\n4: row 3\n5: row 4\n[共 12 行，offset=5 继续]",
      );
      assert.equal(await tools.executeTool("readFile", { path: "small.txt" }), lines
        .map((line, index) => `${index + 1}: ${line}`)
        .join("\n"));
    });
  });

  test(`${label}: vendor 目录默认被跳且结果带排除账，include_vendor 可撤销`, async () => {
    await withDirectory(async (cwd) => {
      await mkdir(path.join(cwd, "node_modules", "x"), { recursive: true });
      await mkdir(path.join(cwd, ".git"), { recursive: true });
      await writeFile(path.join(cwd, "node_modules", "x", "index.js"), "needle vendor\n", "utf8");
      await writeFile(path.join(cwd, ".git", "config.txt"), "needle git\n", "utf8");
      await writeFile(path.join(cwd, "app.js"), "needle app\n", "utf8");
      const tools = createFileTools({ cwd });

      for (const name of ["rg", "grep"]) {
        const skipped = await tools.executeTool(name, { pattern: "needle" });
        assert.doesNotMatch(skipped, /needle vendor/u, `${name} 默认必须跳 node_modules`);
        assert.doesNotMatch(skipped, /needle git/u, `${name} 默认必须跳 .git`);
        assert.match(skipped, /needle app/u);
        assert.match(skipped, /已跳过/u, `${name} 必须回报排除账`);
        assert.match(skipped, /2 个目录/u, `排除账必须带目录计数：${skipped}`);
        assert.match(skipped, /include_vendor=true/u, "排除账必须给出撤销开关名");

        const withVendor = await tools.executeTool(name, {
          pattern: "needle",
          include_vendor: true,
          include_hidden: true,
        });
        assert.match(withVendor, /node_modules\/x\/index\.js/u, `${name} include_vendor=true 必须搜到 vendor`);
        assert.match(withVendor, /needle vendor/u);
        assert.doesNotMatch(withVendor, /已跳过/u, "全量搜索后排除账应清空");
      }

      const treeDefault = await tools.executeTool("tree", { path: "." });
      const listing = (output) => output.split("\n").map((line) => line.trim());
      assert.ok(
        !listing(treeDefault).some((line) => line.startsWith("node_modules")),
        `tree 默认不得列出 vendor：${treeDefault}`,
      );
      assert.ok(!listing(treeDefault).some((line) => line.startsWith(".git")));
      assert.ok(listing(treeDefault).some((line) => line === "app.js"));
      const treeVendor = await tools.executeTool("tree", { path: ".", include_vendor: true, include_hidden: true });
      assert.ok(
        listing(treeVendor).some((line) => line.startsWith("node_modules")),
        `tree include_vendor=true 必须列出 vendor：${treeVendor}`,
      );
    });
  });

  test(`${label}: 无命中统一（无命中），不返回空串`, async () => {
    await withDirectory(async (cwd) => {
      await writeFile(path.join(cwd, "a.txt"), "alpha\n", "utf8");
      const tools = createFileTools({ cwd });
      assert.equal(await tools.executeTool("rg", { pattern: "nope-not-here" }), "（无命中）");
      assert.equal(await tools.executeTool("grep", { pattern: "nope-not-here" }), "（无命中）");
    });
  });

  test(`${label}: tree 截断带 marker 与剩余计数`, async () => {
    await withDirectory(async (cwd) => {
      await Promise.all(Array.from({ length: TREE_ENTRY_LIMIT + 40 }, async (_, index) => {
        await writeFile(path.join(cwd, `file-${String(index).padStart(4, "0")}.txt`), "x\n", "utf8");
      }));
      const tools = createFileTools({ cwd });

      const listed = await tools.executeTool("tree", { path: "." });
      const entries = listed.split("\n").filter((line) => line.trim().endsWith(".txt"));
      assert.ok(entries.length <= TREE_ENTRY_LIMIT, `条目数不得超过 ${TREE_ENTRY_LIMIT}`);
      assert.match(listed, /未列出/u, "条目上限截断必须带 marker");
      assert.match(listed, /500/u, "marker 必须点出上限");

      await mkdir(path.join(cwd, "deep", "deeper", "deepest"), { recursive: true });
      await writeFile(path.join(cwd, "deep", "deeper", "deepest", "bottom.txt"), "x\n", "utf8");
      const depthCapped = await tools.executeTool("tree", { path: "deep", depth: 2 });
      assert.match(depthCapped, /未展开/u, "depth 截断必须带 marker");
      assert.match(depthCapped, /depth=2/u);
      assert.match(depthCapped, /传 depth=4/u, "marker 必须给出可执行的下一步");
    });
  });

  test(`${label}: context.signal 可中止遍历（结构化形态的顶层 signal 同样生效）`, async () => {
    await withDirectory(async (cwd) => {
      await Promise.all(Array.from({ length: 200 }, async (_, index) => {
        await writeFile(path.join(cwd, `f${index}.txt`), "needle\n", "utf8");
      }));
      const tools = createFileTools({ cwd });
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        tools.executeTool("rg", { pattern: "needle" }, { signal: controller.signal }),
        (error) => error?.name === "AbortError",
      );
      await assert.rejects(
        tools.executeTool({
          id: "toolu_abort",
          name: "tree",
          input: { path: "." },
          signal: controller.signal,
        }),
        (error) => error?.name === "AbortError",
      );
    });
  });

  test(`${label}: 搜索上限新旧两种参数名都收`, async () => {
    await withDirectory(async (cwd) => {
      const lines = Array.from({ length: 260 }, (_, index) => `hit ${index}`);
      await writeFile(path.join(cwd, "hits.txt"), `${lines.join("\n")}\n`, "utf8");
      const tools = createFileTools({ cwd });

      for (const key of ["max_results", "maxResults"]) {
        const capped = await tools.executeTool("rg", { pattern: "hit", [key]: 3 });
        assert.equal(capped.split("\n").filter((line) => /:hit /.test(line)).length, 3);
        assert.match(capped, /max_results=3 截断/u, "截断必须有 marker");
      }
      const hardCapped = await tools.executeTool("grep", { pattern: "hit", max_results: 9_999 });
      assert.match(hardCapped, /max_results=200 截断/u, "硬上限 200 必须钳住");
    });
  });

  test(`${label}: rg 默认字面量、is_regex=true 走正则、无效正则返回错误结果`, async () => {
    await withDirectory(async (cwd) => {
      await writeFile(path.join(cwd, "code.js"), "a.b literal\n", "utf8");
      const tools = createFileTools({ cwd });

      assert.match(await tools.executeTool("rg", { pattern: "a.b" }), /1:a\.b/u);
      // 字面量模式不会把 `\.` 当转义：搜索的是含反斜杠的原文，本行不匹配 → 证明两种模式真的分叉
      assert.equal(
        await tools.executeTool("rg", { pattern: "a\\.b" }),
        "（无命中）",
      );
      assert.match(
        await tools.executeTool("rg", { pattern: "a\\.b", is_regex: true }),
        /1:a\.b/u,
      );
      // 默认字面量：「(」不是正则元字符，转义后是合法模式 → 无命中而不是抛/无效正则
      assert.equal(await tools.executeTool("rg", { pattern: "(" }), "（无命中）");
      assert.match(await tools.executeTool("rg", { pattern: "(", is_regex: true }), /^错误：无效正则/u);
      assert.match(await tools.executeTool("grep", { pattern: "(" }), /^错误：无效正则/u);
      // grep 的正则默认值保持不变（is_regex 默认 true）
      assert.match(await tools.executeTool("grep", { pattern: "a.b" }), /1: a\.b literal/u);
    });
  });

  test(`${label}: writeFile 建父目录并返回字节数，readFile/tree 不越界即抛的路径保持抛错`, async () => {
    await withDirectory(async (cwd) => {
      const tools = createFileTools({ cwd });
      const bytes = await tools.executeTool("writeFile", { path: "nested/deep/中文.txt", content: "你好" });
      assert.equal(bytes, Buffer.byteLength("你好", "utf8"));
      assert.equal(await readFile(path.join(cwd, "nested", "deep", "中文.txt"), "utf8"), "你好");
      await assert.rejects(tools.executeTool("readFile", { path: "missing.txt" }));
    });
  });
}
