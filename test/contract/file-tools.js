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

// issue #195：`rg`/`grep` 现在是薄别名，结果尾部挂一行弃用提示。需要**逐字**比对的断言
// 先剥掉那一行（它属于「告警」通道，不属于搜索语义），其余断言照旧看全文。
const DEPRECATION_LINE = /^\[已弃用 (?:rg|grep)：[^\n]*\]$/mu;
const withoutDeprecation = (output) => String(output ?? "")
  .split("\n")
  .filter((line) => !DEPRECATION_LINE.test(line))
  .join("\n");
/** `searchText` 返回 `{content, metadata}`，别名返回字符串；统一取 content 文本。 */
const contentOf = (result) => (result && typeof result === "object" && !Array.isArray(result) ? result.content : result);
/** 取结果里的 metadata（别名/纯字符串结果没有 → undefined）。 */
const metadataOf = (result) => (result && typeof result === "object" && !Array.isArray(result) ? result.metadata : undefined);

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
  test(`${label}: 导出六个文件工具的 definitions（#195 新增 searchText）`, () => {
    const tools = createFileTools({ cwd: process.cwd() });
    assert.deepEqual(
      tools.definitions.map((definition) => definition.name).sort(),
      ["grep", "readFile", "rg", "searchText", "tree", "writeFile"],
    );
    for (const definition of tools.definitions) {
      assert.ok(definition.inputSchema, `${definition.name} 必须有 inputSchema`);
      assert.equal(definition.inputSchema.additionalProperties, false);
    }
  });

  test(`${label}: searchText 的 mode 是必填枚举（无默认值），name_pattern 顶掉 glob`, () => {
    const tools = createFileTools({ cwd: process.cwd() });
    const searchText = tools.definitions.find((definition) => definition.name === "searchText");
    // 「无默认」靠 schema 的 required + enum 落地：漏传 mode 是 schema 错误，不是回落某个模式
    assert.deepEqual(searchText.inputSchema.required, ["pattern", "mode"]);
    assert.deepEqual(searchText.inputSchema.properties.mode.enum, ["literal", "regex"]);
    // R2：只匹配文件名的参数不得顶著 glob 的名字
    assert.ok(searchText.inputSchema.properties.name_pattern, "参数名必须是 name_pattern");
    assert.equal(searchText.inputSchema.properties.glob, undefined, "searchText 不得再接受 glob");
    assert.match(searchText.inputSchema.properties.name_pattern.description, /FILE NAME only/iu);
    assert.match(searchText.inputSchema.properties.name_pattern.description, /never crosses `\/`|never crosses \//iu);
    // 名字不借 CLI 先验 → 能力面偏离必须写进描述（模型只读得到描述与 marker 文本）
    assert.match(searchText.description, /\.gitignore is NOT read/u);
    assert.match(searchText.description, /no -i\/?-B|--type/u);
    assert.match(searchText.description, /pure-Node/iu);
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
      // issue #196 R2：marker 里的字节数改走可读单位（同一文本里不再出现裸字节数），
      // 所以这里钉的是**同一个上限的可读形式**，触顶回报本身不许丢。
      assert.match(capped, /max_bytes=4KB/u, "触顶必须回报（可读单位）");
      assert.doesNotMatch(capped, /(?<![\d.])4096(?!\d)/u, "人类可读值与裸字节数不得同时出现（#196 R2）");

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
        // #196 R1.1：marker 从「只报状态」升级为「给出下一步」，字面量随之变（刻意）。
        // 行号与「共 N 行」的口径不变，新增的是「剩余行数 + readFile 传 offset=N」。
        "1: row 0\n2: row 1\n3: row 2\n4: row 3\n5: row 4\n[共 12 行，剩余 7 行；下一步：readFile 传 offset=5 继续]",
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
      assert.equal(withoutDeprecation(await tools.executeTool("rg", { pattern: "nope-not-here" })), "（无命中）");
      assert.equal(withoutDeprecation(await tools.executeTool("grep", { pattern: "nope-not-here" })), "（无命中）");
      // #195：规范入口同样统一口径，且排除账与截断另有结构化字段（进 transcript、不上 wire）
      assert.equal(contentOf(await tools.executeTool("searchText", { pattern: "nope-not-here", mode: "literal" })), "（无命中）");
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
      assert.equal(withoutDeprecation(await tools.executeTool("rg", { pattern: "a\\.b", is_regex: false })), "（无命中）");
      // 默认正则：「(」是非法正则 → 错误结果而不是抛（此前默认字面量时无命中）
      assert.match(await tools.executeTool("rg", { pattern: "(" }), /^错误：无效正则/u);
      assert.match(await tools.executeTool("rg", { pattern: "(", is_regex: true }), /^错误：无效正则/u);
      // 字面量逃生口下「(」不是元字符，也不是非法模式 → 无命中
      assert.equal(withoutDeprecation(await tools.executeTool("rg", { pattern: "(", is_regex: false })), "（无命中）");
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

  // -------------------------------------------------------------------------
  // issue #195：单一搜索入口 searchText（mode 显式、无先验）+ rg/grep 薄别名
  // -------------------------------------------------------------------------

  test(`${label}: searchText 的 mode 两种各钉一条，非法/缺失一律显式报错而不是回落默认`, async () => {
    await withDirectory(async (cwd) => {
      // 同一份 fixture：`a.b` 按正则同时命中 "a.b" 与 "axb"，按字面量只命中字面 "a.b" 那一行。
      await writeFile(
        path.join(cwd, "code.js"),
        "a.b literal\naxb literal\nfoo|bar pipeline\nfoo alone\nbar alone\n",
        "utf8",
      );
      const tools = createFileTools({ cwd });
      const hits = (result) => contentOf(result)
        .split("\n")
        .filter((line) => line.startsWith("code.js:"))
        .map((line) => line.slice("code.js:".length));

      const asRegex = await tools.executeTool("searchText", { pattern: "a.b", mode: "regex" });
      assert.deepEqual(hits(asRegex), ["1:a.b literal", "2:axb literal"], "mode=regex 按正则：点号是元字符");
      const asLiteral = await tools.executeTool("searchText", { pattern: "a.b", mode: "literal" });
      assert.deepEqual(hits(asLiteral), ["1:a.b literal"], "mode=literal 按字面量：点号不是元字符");
      // 交替写法再钉一次（两种模式的差异不是偶然）：正则 3 行 / 字面量 1 行
      assert.equal(hits(await tools.executeTool("searchText", { pattern: "foo|bar", mode: "regex" })).length, 3);
      assert.equal(hits(await tools.executeTool("searchText", { pattern: "foo|bar", mode: "literal" })).length, 1);

      // 非法 mode：**显式报错**，不得回落任何一个默认（回落就是把歧义留给调用方）
      for (const mode of ["fixed", "LITERAL", "", null, 0, true, ["regex"]]) {
        const output = contentOf(await tools.executeTool("searchText", { pattern: "a.b", mode }));
        assert.match(output, /^错误：/u, `非法 mode ${JSON.stringify(mode)} 必须报错：${output}`);
        assert.match(output, /mode/u);
        assert.doesNotMatch(output, /a\.b literal/u, `非法 mode ${JSON.stringify(mode)} 不得回落成命中结果`);
      }
      // 缺失 mode 同样报错（这就是「无默认」的可断言形式）
      assert.match(contentOf(await tools.executeTool("searchText", { pattern: "a.b" })), /^错误：/u);
      assert.doesNotMatch(contentOf(await tools.executeTool("searchText", { pattern: "a.b" })), /axb/u,
        "不传 mode 不得默默当成正则");
      assert.match(contentOf(await tools.executeTool("searchText", { pattern: "a.b" })), /无默认值/u);
      // 非法正则（mode=regex）仍走 #184 的错误结果口径，不抱
      assert.match(contentOf(await tools.executeTool("searchText", { pattern: "(", mode: "regex" })), /^错误：无效正则/u);
      // mode=literal 下「(」不是元字符也不是非法模式
      assert.equal(contentOf(await tools.executeTool("searchText", { pattern: "(", mode: "literal" })), "（无命中）");
    });
  });

  test(`${label}: name_pattern 只匹配文件名、不跨 /；传 glob 直接报参数错（不静默忽略）`, async () => {
    await withDirectory(async (cwd) => {
      await writeFile(path.join(cwd, "app.js"), "needle app\n", "utf8");
      await mkdir(path.join(cwd, "src", "nested"), { recursive: true });
      await writeFile(path.join(cwd, "src", "nested", "deep.js"), "needle nested\n", "utf8");
      await writeFile(path.join(cwd, "notes.txt"), "needle text\n", "utf8");
      const tools = createFileTools({ cwd });

      const filtered = await tools.executeTool("searchText", { pattern: "needle", mode: "regex", name_pattern: "*.js" });
      assert.match(filtered.content, /app\.js/u);
      assert.match(filtered.content, /nested\/deep\.js/u, "只匹配 basename，所以任意层级的 .js 都能中");
      assert.doesNotMatch(filtered.content, /notes\.txt/u);

      // R2 要钉的就是这个：完整 glob 写法在本实现里**不工作**（名字已经因此改名）
      const globStyle = await tools.executeTool("searchText", { pattern: "needle", mode: "regex", name_pattern: "**/*.js" });
      assert.equal(contentOf(globStyle), "（无命中）", `**/*.js 不跨 /，必须无命中：${contentOf(globStyle)}`);

      // glob 这个键在 searchText 里不存在：报错而不是静默忽略（静默忽略 = 同一个谎的另一面）
      const rejected = await tools.executeTool("searchText", { pattern: "needle", mode: "regex", glob: "*.js" });
      assert.match(contentOf(rejected), /^错误：/u);
      assert.match(contentOf(rejected), /glob/u);
      assert.match(contentOf(rejected), /name_pattern/u, "错误文本必须给出可执行的下一步");

      // grep 别名继续吃 glob（入参形状不变），语义就是 name_pattern
      assert.match(withoutDeprecation(await tools.executeTool("grep", { pattern: "needle", glob: "*.js" })), /app\.js/u);
    });
  });

  test(`${label}: 别名等价性硬判据——同一 fixture 上 searchText(mode:regex)/rg/grep 的命中正文逐字相等`, async () => {
    await withDirectory(async (cwd) => {
      // 造三个样本：一个超宽行（验证行宽上限同口径）、一个普通行、一个多命中文件
      const longLine = `needle ${"y".repeat(800)}`;      // 807 字符 > 500：三家都得截
      const normalLine = `needle ${"z".repeat(290)}`;    // 297 字符 ≤ 500：三家都得整行
      await writeFile(path.join(cwd, "long.txt"), `${longLine}\n`, "utf8");
      await writeFile(path.join(cwd, "normal.txt"), `${normalLine}\nlong.txt more needle tail\n`, "utf8");
      await writeFile(path.join(cwd, "vendor.js"), `needle ${"w".repeat(120)}\n`, "utf8");
      const tools = createFileTools({ cwd });

      // 剥掉三家各自的前缀（searchText/rg = `文件:行号:`，grep = 分组头 + `行号: `），只比命中行正文
      const hitBodies = async (run) => {
        const output = withoutDeprecation(contentOf(await run()));
        const bodies = [];
        for (const line of output.split("\n")) {
          const at = line.indexOf("needle ");
          if (line.trimEnd().endsWith("tail")) continue;
          if (at === -1) continue;
          bodies.push(line.slice(at));
        }
        return bodies;
      };

      const viaSearchText = await hitBodies(() => tools.executeTool("searchText", { pattern: "needle", mode: "regex" }));
      const viaRg = await hitBodies(() => tools.executeTool("rg", { pattern: "needle" }));
      const viaGrep = await hitBodies(() => tools.executeTool("grep", { pattern: "needle" }));

      assert.ok(viaSearchText.length >= 3, `fixture 没造出足够命中：${JSON.stringify(viaSearchText)}`);
      assert.deepEqual(viaRg, viaSearchText, "rg 别名的命中正文必须与 searchText(mode:regex) 逐字相等");
      assert.deepEqual(viaGrep, viaSearchText, "grep 别名的命中正文必须与 searchText(mode:regex) 逐字相等");
      // 具体数也钉住：三家共用的就是 500 + 一个省略号（否则一起缩到 200 也能满足上面的等式）
      assert.equal(viaSearchText[0].length, 501, `超宽行必须按 500 + 省略号截断，实得到 ${viaSearchText[0].length}`);
      assert.ok(viaSearchText[0].endsWith("…"));
      assert.ok(viaSearchText.includes(normalLine), "未触顶的行三家都整行返回");

      // 字面量口径也只在一处：mode=literal 与两个别名的 is_regex=false 逐字同果
      const literalBodies = await hitBodies(() => tools.executeTool("searchText", { pattern: "needle y{20}", mode: "literal" }));
      assert.deepEqual(literalBodies, [], "字面量下 `needle y{20}` 不是重复量词，不命中任何行");

      // 弃用告警只属于别名，不属于规范入口；且不改变命中正文
      const rgOutput = contentOf(await tools.executeTool("rg", { pattern: "needle" }));
      const grepOutput = contentOf(await tools.executeTool("grep", { pattern: "needle" }));
      assert.match(rgOutput, DEPRECATION_LINE, "rg 必须挂弃用提示行");
      assert.match(grepOutput, DEPRECATION_LINE, "grep 必须挂弃用提示行");
      assert.match(rgOutput, /searchText/u, "弃用提示必须点名继任入口");
      assert.doesNotMatch(viaSearchText.join("\n"), /已弃用/u, "searchText 自己不应带弃用告警");
      assert.equal(withoutDeprecation(rgOutput).split("\n").length, contentOf(await tools.executeTool("searchText", { pattern: "needle", mode: "regex" })).split("\n").length,
        "除去弃用行后 rg 与 searchText 的行数必须一致");
      assert.equal(withoutDeprecation(grepOutput).includes("normal.txt"), true);
    });
  });

  test(`${label}: searchText 的跳过账/截断/next_offset 同时走结构化 metadata（模型侧仍读 marker）`, async () => {
    await withDirectory(async (cwd) => {
      await mkdir(path.join(cwd, "node_modules", "x"), { recursive: true });
      await mkdir(path.join(cwd, ".git"), { recursive: true });
      await writeFile(path.join(cwd, "node_modules", "x", "index.js"), "needle vendor\n", "utf8");
      await writeFile(path.join(cwd, ".git", "config.txt"), "needle git\n", "utf8");
      await writeFile(path.join(cwd, "app.js"), "needle app\n", "utf8");
      await writeFile(path.join(cwd, "hits.txt"), `${Array.from({ length: 7 }, (_, i) => `hit ${i}`).join("\n")}\n`, "utf8");
      const tools = createFileTools({ cwd });

      const skipped = await tools.executeTool("searchText", { pattern: "needle", mode: "regex" });
      assert.match(skipped.content, /已跳过/u, "marker 仍是模型侧的通道");
      assert.equal(skipped.metadata.searchSkipped.vendorDirectories, 1);
      assert.equal(skipped.metadata.searchSkipped.hiddenDirectories, 1);
      assert.equal(skipped.metadata.searchHits, 1);
      assert.equal(skipped.metadata.searchTruncated, false);
      assert.equal(skipped.metadata.searchNextOffset, undefined, "未截断就不该给 next_offset");

      const capped = await tools.executeTool("searchText", { pattern: "hit", mode: "literal", max_results: 3 });
      assert.match(capped.content, /max_results=3 截断/u);
      assert.equal(capped.metadata.searchTruncated, true);
      assert.equal(capped.metadata.searchHits, 3);
      assert.equal(capped.metadata.searchNextOffset, 3, "next_offset 必须是可续读的偏移");
      // issue #195（主 agent 验收补漏）：提示词承诺「截断时给出续读 offset」——首查（不传 offset）
      // 被截时也必须给得出，不能只住在不进 wire 的 metadata 里。
      assert.match(capped.content, /offset=3 继续/u, `规范入口首查被截的 marker 必须自带续读 offset：${capped.content}`);
      // 别名输出逐字不变（issue #188）：它们不吃 offset，marker 不得被继任入口带跑。
      const rgCapped = await tools.executeTool("rg", { pattern: "hit", max_results: 3 });
      // #196 R1.3：别名的截断 marker 尾部补了「改用 searchText 传 offset 续读」的出口，
      // 所以不再以 `截断]` 收尾；`offset=\d+ 继续` 那条断言仍守着「别名不吃 offset」。
      assert.match(rgCapped, /max_results=3 截断/u);
      assert.doesNotMatch(rgCapped, /offset=\d+ 继续/u, "别名不吃 offset，marker 里不该出现续读偏移");

      // offset 续读：next_offset 传回去能拿到剩下那批（截断可撤销，ADR-010）
      const next = await tools.executeTool("searchText", { pattern: "hit", mode: "literal", max_results: 3, offset: capped.metadata.searchNextOffset });
      assert.match(next.content, /hit 3/u, `offset 续读必须拿到后半段：${next.content}`);
      assert.equal(next.metadata.searchOffset, 3);
      assert.match(next.content, /offset=6 继续/u, "带 offset 的调用要给出下一个续读偏移");

      // vendor 取回仍可逆：include_vendor/include_hidden 与 marker 里的开关名一致
      const all = await tools.executeTool("searchText", { pattern: "needle", mode: "regex", include_vendor: true, include_hidden: true });
      assert.match(all.content, /needle vendor/u);
      assert.match(all.content, /needle git/u);
      assert.equal(all.metadata.searchSkipped.vendorDirectories, 0);
    });
  });

  // issue #196 R1：三类截断（行数续读 / 字节上限 / 单行超宽 / 搜索命中）都必须给出
  // **可执行的下一步**，而且里面的数字与路径是**本次调用的真值**。
  // 钉「不是模板」的办法：同一条断言跑在两份不同 fixture 上（不同 path / 不同 limit /
  // 不同 max_bytes / 不同 max_results），值必须跟着调用变；模板占位在这里必然过不了。
  // ⚠ 同时钉住「marker 里只许出现本模块的 readFile / searchText」——`exec` 属 CLI 装配层
  //   （bin/tools.js），库不能假设宿主有它（这条相对 issue #196 原文是收紧）。
  test(`${label}: 截断 marker 给得出可执行的下一步，且真值随调用变化（#196 R1）`, async () => {
    await withDirectory(async (cwd) => {
      await writeFile(path.join(cwd, "alpha.txt"), `${Array.from({ length: 12 }, (_, i) => `a ${i}`).join("\n")}\n`, "utf8");
      await writeFile(path.join(cwd, "beta-longer-name.txt"), `${Array.from({ length: 30 }, (_, i) => `b ${i}`).join("\n")}\n`, "utf8");
      await writeFile(path.join(cwd, "big.txt"), `${Array.from({ length: 3_000 }, (_, i) => `line ${i} ${"x".repeat(90)}`).join("\n")}\n`, "utf8");
      // 超宽行的「截断」分支只在跨块扫描时触发（单块内读到 EOF 就直接走行窗口封顶），
      // 所以 fixture 必须超过一个读块（64 KiB）才走得到 readLineTruncated。
      await writeFile(path.join(cwd, "wide-one.txt"), `first\n${"w".repeat(200_000)}\nlast\n`, "utf8");
      await mkdir(path.join(cwd, "sub"), { recursive: true });
      await writeFile(path.join(cwd, "sub", "wide-two.txt"), `p1\np2\n${"z".repeat(200_000)}\nlast\n`, "utf8");
      await writeFile(path.join(cwd, "needles.txt"), `${Array.from({ length: 40 }, (_, i) => `needle ${i}`).join("\n")}\n`, "utf8");
      const tools = createFileTools({ cwd });
      // 一次调用可能同时挂多条 marker（例：超宽行既触行宽也触字节上限），按语义挑那一条比。
      const markerWith = (output, pattern) => String(contentOf(output) ?? "")
        .split("\n")
        .find((line) => pattern.test(line)) ?? "";
      const nextStepCount = (output) => String(contentOf(output) ?? "")
        .split("\n")
        .filter((line) => line.includes("下一步：")).length;
      const offsetOf = (marker) => Number(marker.match(/offset=(\d+)/u)?.[1]);

      // 1) 行数续读（readMoreLines）：总行数与续读 offset 都跟着本次 limit / 文件走
      const rows5 = markerWith(await tools.executeTool("readFile", { path: "alpha.txt", limit: 5 }), /共 \d+ 行/u);
      const rows7 = markerWith(await tools.executeTool("readFile", { path: "beta-longer-name.txt", limit: 7 }), /共 \d+ 行/u);
      assert.match(rows5, /readFile 传 offset=5/u, `出口必须点明工具名与本次 offset：${rows5}`);
      assert.match(rows7, /readFile 传 offset=7/u, rows7);
      assert.match(rows5, /共 12 行/u);
      assert.match(rows7, /共 30 行/u);
      assert.notEqual(rows5, rows7, "两份 fixture 的 marker 逐字相同 → 给的是模板而不是真值");

      // 2) 字节上限（readBytesCap）：offset 必须落在本次返回之后，上限跟着本次 max_bytes
      const cap4 = contentOf(await tools.executeTool("readFile", { path: "big.txt", max_bytes: 4_096 }));
      const cap8 = contentOf(await tools.executeTool("readFile", { path: "big.txt", max_bytes: 8_192 }));
      const cap4Marker = markerWith(cap4, /本次返回已达/u);
      const cap8Marker = markerWith(cap8, /本次返回已达/u);
      assert.match(cap4Marker, /readFile 传 offset=\d+ 继续/u, cap4Marker);
      assert.match(cap4Marker, /max_bytes=4KB/u, "上限必须是本次生效值");
      assert.match(cap8Marker, /max_bytes=8KB/u, cap8Marker);
      assert.ok(offsetOf(cap8Marker) > offsetOf(cap4Marker), "更宽的额度必须给出更靠后的续读 offset（真值随调用变）");
      assert.ok(Buffer.byteLength(cap4, "utf8") <= 4_096, "补长 marker 后仍不得突破 max_bytes");
      assert.ok(Buffer.byteLength(cap8, "utf8") <= 8_192);

      // 3) 单行超宽（readLineTruncated）：行号 + 文件路径 + 该行自己的 0-based offset
      const wideOneRaw = await tools.executeTool("readFile", { path: "wide-one.txt", limit: 2, max_bytes: 4_096 });
      const wideOne = markerWith(wideOneRaw, /单行超过/u);
      const wideTwoRaw = await tools.executeTool("readFile", { path: path.join("sub", "wide-two.txt"), limit: 3, max_bytes: 4_096 });
      const wideTwo = markerWith(wideTwoRaw, /单行超过/u);
      assert.match(wideOne, /wide-one\.txt/u, `必须带本次的文件路径：${wideOne}`);
      assert.match(wideTwo, /wide-two\.txt/u, wideTwo);
      assert.match(wideOne, /第 2 行/u, `必须带被截那行的真实行号：${wideOne}`);
      assert.match(wideTwo, /第 3 行/u, wideTwo);
      assert.equal(offsetOf(wideOne), 1, "给的 offset 必须就是该行行号减 1（readFile 的 0-based 行偏移）");
      assert.equal(offsetOf(wideTwo), 2);
      assert.match(wideOne, /readFile 传 offset=/u, "出口只能是本模块的 readFile");
      assert.ok(Buffer.byteLength(wideOneRaw, "utf8") <= 4_096, "带路径的 marker 仍要守住 max_bytes");
      // 超宽行往往同时触字节上限：两条 marker 各自都得带出口，不许一条哑着（#196 R1.2）
      assert.equal(nextStepCount(wideOneRaw), 2, `触顶 + 超宽两条 marker 都要有下一步：${wideOneRaw.split("\n").slice(-2).join(" / ")}`);

      // 4) 搜索命中截断（searchTruncated）：续读 offset 跟着 max_results 变
      const search3Raw = await tools.executeTool("searchText", { pattern: "needle", mode: "literal", max_results: 3 });
      const search3 = markerWith(search3Raw, /命中过多/u);
      const search5 = markerWith(await tools.executeTool("searchText", { pattern: "needle", mode: "literal", max_results: 5 }), /命中过多/u);
      assert.match(search3, /searchText 传 offset=3 继续/u, search3);
      assert.match(search5, /searchText 传 offset=5 继续/u, search5);
      // 别名不吃 offset → 出口把模型指向规范入口，且不凭空造一个数字 offset（#188 别名口径）
      const aliasCapped = withoutDeprecation(await tools.executeTool("grep", { pattern: "needle", max_results: 4 }));
      assert.match(aliasCapped, /下一步[^\n]*searchText/u, `别名也要有出口，且只能指向 searchText：${aliasCapped}`);
      assert.doesNotMatch(aliasCapped, /offset=\d+/u, "别名不接受 offset，marker 里不该出现数字偏移");

      // 收紧条款：marker 里不得出现本模块没有的工具名（宿主可能根本没装 exec）
      for (const marker of [rows5, rows7, cap4Marker, cap8Marker, wideOne, wideTwo, search3, search5, aliasCapped]) {
        assert.doesNotMatch(marker, /\b(?:exec|sed|awk|cat|head|tail|shell)\b/u, `marker 只能提 readFile / searchText：${marker}`);
      }
    });
  });

  // issue #196 R2：marker 里的字节数必须是可读单位，且**不与裸字节数在同一段结果文本里并存**
  //（两个数说的是同一件事，模型会对不上账）。阈值本身在文档与 metadata 里仍写裸数字。
  test(`${label}: marker 的字节数用可读单位，且不与裸字节数并存（#196 R2）`, async () => {
    await withDirectory(async (cwd) => {
      await writeFile(path.join(cwd, "big.txt"), `${Array.from({ length: 3_000 }, (_, i) => `line ${i} ${"x".repeat(90)}`).join("\n")}\n`, "utf8");
      const tools = createFileTools({ cwd });

      const capped = String(await tools.executeTool("readFile", { path: "big.txt", max_bytes: 4_096 }));
      assert.match(capped, /\d+(?:\.\d+)?(?:B|KB|MB)\b/u, `字节数要写成可读单位：${capped.slice(-200)}`);
      assert.doesNotMatch(capped, /(?<![\d.])4096(?!\d)/u, "可读值与裸字节数不得同时出现");

      // 未扫到 EOF 的那条 marker 同时带文件大小与上限：两边都必须是可读单位
      const notScanned = String(await tools.executeTool("readFile", { path: "big.txt", limit: 1, max_bytes: 1_024 }));
      assert.match(notScanned, /max_bytes=1KB/u, notScanned);
      assert.doesNotMatch(notScanned, /(?<![\d.])1024(?!\d)/u, notScanned);
      assert.match(notScanned, /文件 \d+(?:\.\d+)?(?:KB|MB) > /u, `文件大小也要可读单位：${notScanned}`);
    });
  });
}
