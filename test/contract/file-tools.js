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
//   * rg/grep 都默认按**正则**匹配（与真实 `rg` / `grep` 命令的默认一致，issue #184 追加轮 A），
//     is_regex=false 是字面量逃生口（等价 `rg --fixed-strings` / `grep -F`），无效正则一律返回错误结果而非抛；
//   * 无命中统一「（无命中）」；tree 截断必须带 marker + 剩余计数；
//   * rg 与 grep 共用**同一个**命中行宽上限（500 字符 + `…`）：同一份长行 fixture 上两边命中行
//     必须逐字相等（#184 追加轮 A 收口：此前只有 grep 截行，两个搜索工具口径相反）；
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

  test(`${label}: rg 默认正则（与真实 rg 一致）、is_regex=false 走字面量、无效正则返回错误结果`, async () => {
    await withDirectory(async (cwd) => {
      // 同一份 fixture 上并排钉住两种模式：`a.b` 按正则同时命中 "a.b" 与 "axb"，
      // 按字面量只命中含字面 "a.b" 的那一行；`foo|bar` 同理（正则 3 行 vs 字面量 1 行）。
      const fixture = "a.b literal\naxb literal\nfoo|bar pipeline\nfoo alone\nbar alone\n";
      await writeFile(path.join(cwd, "code.js"), fixture, "utf8");
      const tools = createFileTools({ cwd });
      const hits = (output) => output.split("\n").filter((line) => line.startsWith("code.js:")).length;

      // 默认（不传 is_regex）= 正则，与 ripgrep 的真实默认、以及本库 grep 的默认同口径
      const defaultRegex = await tools.executeTool("rg", { pattern: "a.b" });
      assert.match(defaultRegex, /code\.js:1:a\.b literal/u);
      assert.match(defaultRegex, /code\.js:2:axb literal/u, "默认必须是正则：a.b 也得命中 axb");
      // 同一份 fixture、同一个模式，is_regex=false 按字面量：不得命中 axb
      const literal = await tools.executeTool("rg", { pattern: "a.b", is_regex: false });
      assert.match(literal, /code\.js:1:a\.b literal/u);
      assert.doesNotMatch(literal, /axb/u, "is_regex=false 必须按字面量：点号不是元字符");
      // 交替写法再钉一次：正则 3 行 vs 字面量 1 行
      assert.equal(hits(await tools.executeTool("rg", { pattern: "foo|bar" })), 3, "默认正则：foo|bar 命中三行");
      const literalAlternation = await tools.executeTool("rg", { pattern: "foo|bar", is_regex: false });
      assert.equal(hits(literalAlternation), 1, "is_regex=false：只命中含字面 foo|bar 的那一行");
      assert.match(literalAlternation, /code\.js:3:foo\|bar pipeline/u);
      // 正则里 `\.` 是转义：默认（正则）下命中真点号那行；字面量下搜的是含反斜杠的原文 → 无命中
      assert.match(await tools.executeTool("rg", { pattern: "a\\.b" }), /code\.js:1:a\.b literal/u);
      assert.equal(await tools.executeTool("rg", { pattern: "a\\.b", is_regex: false }), "（无命中）");
      // 默认正则：「(」是非法正则 → 错误结果而不是抛（此前默认字面量时无命中）
      assert.match(await tools.executeTool("rg", { pattern: "(" }), /^错误：无效正则/u);
      assert.match(await tools.executeTool("rg", { pattern: "(", is_regex: true }), /^错误：无效正则/u);
      // 字面量逃生口下「(」不是元字符，也不是非法模式 → 无命中
      assert.equal(await tools.executeTool("rg", { pattern: "(", is_regex: false }), "（无命中）");
      assert.match(await tools.executeTool("grep", { pattern: "(" }), /^错误：无效正则/u);
      // grep 的正则默认值与本轮前一致（is_regex 默认 true），且字面量逃生口（grep -F）照用
      const grepRegex = await tools.executeTool("grep", { pattern: "a.b" });
      assert.match(grepRegex, /1: a\.b literal/u);
      assert.match(grepRegex, /2: axb literal/u, "grep 默认仍是正则");
      const grepLiteral = await tools.executeTool("grep", { pattern: "a.b", is_regex: false });
      assert.match(grepLiteral, /1: a\.b literal/u);
      assert.doesNotMatch(grepLiteral, /axb/u, "grep is_regex=false = grep -F：点号不是元字符");
    });
  });

  test(`${label}: rg 与 grep 共用同一个命中行宽上限（同一份长行 fixture 上两边命中行必须一模一样）`, async () => {
    await withDirectory(async (cwd) => {
      // 本轮真正要钉的不变式只有一个：**两个搜索工具必须是同一个数**。
      // 历史缺陷：`grep` 截行、`rg` 不截，同一个库里两个搜索工具口径相反（与刚修掉的
      // 「两个工具默认值相反」同形状）。真实 `rg` / `grep` 命令**都不截行**（已实测 807 字符的
      // 命中行逐字节原样输出），所以这里的截断是**本实现自己的输出预算**（一个 minified
      // 超长行——一行几百 KB——能独自把一次工具调用撑爆），不是对真实命令行为的声明。
      const longLine = `needle ${"y".repeat(800)}`; //   807 字符：> 上限，两边都得截
      const normalLine = `needle ${"z".repeat(290)}`; // 297 字符：≤ 上限，两边都得整行返回
      await writeFile(path.join(cwd, "long.txt"), `${longLine}\n`, "utf8");
      await writeFile(path.join(cwd, "normal.txt"), `${normalLine}\n`, "utf8");
      const tools = createFileTools({ cwd });

      // 剥掉各工具自己的前缀（rg = `文件:行号:`，grep = `行号: `），只比命中行正文
      const hitBody = async (name, file) => {
        const output = await tools.executeTool(name, { pattern: "needle", path: path.join(cwd, file) });
        const line = output.split("\n").find((entry) => entry.includes("needle "));
        assert.ok(line !== undefined, `${name} 必须命中那一行：${output}`);
        return line.slice(line.indexOf("needle "));
      };

      const rgLong = await hitBody("rg", "long.txt");
      const grepLong = await hitBody("grep", "long.txt");
      // ← 不变式本体：同一份长行上两边正文逐字相等（长度自然相等）
      assert.equal(rgLong, grepLong, "rg 与 grep 的命中行必须一模一样（行宽上限口径唯一）");
      assert.equal(rgLong.length, grepLong.length, "rg 与 grep 的命中行长度必须相等");
      // 具体数也钉住（否则两边一起缩到 200 也能满足上面的等式）：500 正文 + 1 个省略号
      assert.equal(rgLong.length, 501, `rg 必须按 500 + 省略号截断，实得到 ${rgLong.length}`);
      assert.equal(grepLong.length, 501, `grep 必须按 500 + 省略号截断，实得到 ${grepLong.length}`);
      assert.ok(rgLong.endsWith("…") && grepLong.endsWith("…"), "截断必须留省略号尾巴");

      const rgNormal = await hitBody("rg", "normal.txt");
      const grepNormal = await hitBody("grep", "normal.txt");
      assert.equal(rgNormal, grepNormal, "未触顶的行两边都得整行返回");
      assert.equal(rgNormal, normalLine, "297 字符的命中行不得被截断");
      assert.doesNotMatch(`${rgNormal}${grepNormal}`, /…/u, "未触顶的行不得带省略号");
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
