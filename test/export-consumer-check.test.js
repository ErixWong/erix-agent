// issue #406 裁定③ 的配套件测试（也服务 #419③ 那类「import 了却没人调」）。
//
// 分工（与 `scripts/docs-drift-check.mjs` / `test-hygiene-check.mjs` 同一套惯例）：
//   - **反向证**（删掉真消费者 ⇒ 候选 +1、加回来 ⇒ 回到原值；坑 1 有状态 `g` 正则、坑 2 注释进花括号、
//     坑 3 `export *`；以及 #429 修的四条口径：三入口 / 发布面档 / internal-only / 两个读不出真值的漏口）
//     都在 `node scripts/export-consumer-check.mjs --self-test` 里。这里只 spawn 它一次，
//     断言 exit 0——本文件**不**重复那 15 条判据（重复写两份只会让两边一起腐烂）。
//   - 本文件钉的是另外几件便宜但会腐烂的事：
//     ① **第二套实现复算**：真树的**三档**清单（包内 / 发布面 / 自身定义文件内引用），用**另一套机制**
//        （`readdirSync(recursive)` + 按非标识符切 token 数词）重算一遍，与脚本逐名对齐。
//        主 agent 第一版就是「数漏了 23 个」还不自知，所以这条是本文件的主力：脚本静默少报 / 错档时这里红。
//     ② 「清点不判定」这个承诺是**可验证的行为**：有候选也 exit 0；只有「读不出真值」（`export *`、
//        入口缺失、非法导出名、扫描面目录读不出、定义文件里没这个符号）才 exit 2。
//     ③ 卫生：临时目录一律走 `test/helpers/tmp.js` 的 `makeTmp()`（不写 `mkdtemp` 字面量），
//        变异与清点全程只读，仓内源码一个字都不改。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTmp } from "./helpers/tmp.js";
import {
  ExportParseError,
  computeInventory,
  countNameHits,
  parseEntryExports,
  scanImportedButUnused,
} from "../scripts/export-consumer-check.mjs";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));
const SCRIPT = fileURLToPath(new URL("../scripts/export-consumer-check.mjs", import.meta.url));
const IDENT = /^[A-Za-z_$][\w$]*$/;
/** 迷你仓库的扫描面目录：脚本要求它们都在（目录读不出 = 真值读不出，口径漏洞④a）。 */
const MINI_DIRS = ["src", "bin", "examples", "test/contract", "docs", "scripts"];
/** 迷你仓库的默认 `exports`：两条 src 入口（第三入口 `./contract-tests` 只在需要时铺）。 */
const MINI_EXPORTS = { ".": "./src/index.js", "./tools": "./src/tools/index.js" };

function runScript(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT, ...options });
}

/** 在临时目录里铺一棵迷你仓库（只写临时目录，绝不碰仓内文件）。 */
async function miniRepo(files, prefix = "erix-export-consumer-", { exports = MINI_EXPORTS } = {}) {
  const root = await makeTmp(prefix);
  for (const dir of MINI_DIRS) mkdirSync(join(root, dir), { recursive: true });
  if (!files["package.json"]) {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mini", type: "module", exports }));
  }
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

/** 第二套实现之一：`readdirSync(recursive)` 铺平文件树（脚本用的是手写递归，两套不共用）。 */
function flatFiles(root, dir, exts) {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isFile() && exts.some((e) => d.name.endsWith(e)))
    .map((d) => `${dir}/${relative(join(root, dir), join(d.parentPath ?? d.path, d.name))}`)
    .sort();
}

/** 第二套实现之二：按「非标识符字符」切 token 数词（脚本用的是 `matchAll` + 边界断言）。 */
function tokenCount(text, name) {
  let hits = 0;
  for (const token of text.split(/[^\w$]+/u)) if (token === name) hits += 1;
  return hits;
}

test("真树：三档清单能被第二套实现复算出来（脚本少报 / 错档时这里红）", () => {
  const result = runScript(["--json"]);
  assert.equal(result.status, 0, `脚本应 exit 0（只是清点）：${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.gate, false, "本工具不得自封门禁");
  assert.ok(payload.total >= 120, `导出名总数只有 ${payload.total} 个——入口解析大概率失效了`);
  assert.equal(new Set(payload.names.map((n) => n.name)).size, payload.total, "导出名必须去重");
  const ENTRIES = payload.entries;   // 入口清单以脚本从 package.json 现读的那份为准
  assert.ok(ENTRIES.length >= 3, `入口只有 ${ENTRIES.length} 个——package.json 的 exports 里今天有三个代码子路径`);
  for (const row of payload.names) {
    assert.match(row.name, IDENT, `导出名 ${JSON.stringify(row.name)} 不是合法标识符（注释/解构混进来了？）`);
    assert.ok(ENTRIES.some((e) => row.entries.includes(e)), `${row.name} 没挂在任何入口上`);
  }
  // 口径漏洞①：**每个**入口声明了几个名字，清点里就必须有几个（少扫一个入口 = 这里红）。
  for (const entry of ENTRIES) {
    const declared = parseEntryExports(readFileSync(join(ROOT, entry), "utf8"), entry).names.length;
    const counted = payload.names.filter((n) => n.entries.includes(entry)).length;
    assert.ok(declared > 0, `${entry} 一个名字都没解析出来——入口清单里多了一个空入口？`);
    assert.equal(counted, declared, `${entry} 声明了 ${declared} 个名字，清点里只有 ${counted} 个——这个入口被漏扫了`);
  }
  // 第二套实现：名字表用脚本的（解析由 --self-test 的坑 2/坑 3 用例看守），**三档判定**独立重算。
  const records = [
    ...["src", "bin", "examples"].flatMap((d) => flatFiles(ROOT, d, [".js", ".mjs", ".cjs"])),
    ...flatFiles(ROOT, "test", [".js", ".mjs", ".cjs"]),
    ...flatFiles(ROOT, "docs", [".md"]),
    ...flatFiles(ROOT, "scripts", [".js", ".mjs", ".cjs"]),
  ].map((rel) => ({ rel, text: readFileSync(join(ROOT, rel), "utf8") }));
  const entryMasked = new Map(ENTRIES.map((entry) => {
    const { maskedText } = parseEntryExports(readFileSync(join(ROOT, entry), "utf8"), entry);
    return [entry, maskedText];
  }));
  const defText = new Map(records.map((r) => [r.rel, r.text]));
  const independent = { package: [], publish: [], internal: [], zero: [] };
  for (const row of payload.names) {
    let pkg = 0;
    let publish = 0;
    for (const record of records) {
      if (record.rel === row.def) continue;
      const text = entryMasked.has(record.rel) ? entryMasked.get(record.rel) : record.text;
      const hits = tokenCount(text, row.name);
      if (hits === 0) continue;
      if (record.rel.startsWith("src/") || record.rel.startsWith("bin/")) pkg += hits;
      else if (record.rel.startsWith("examples/") || record.rel.startsWith("test/contract/")) publish += hits;
    }
    const internal = Math.max(tokenCount(defText.get(row.def) ?? "", row.name) - 1, 0);
    if (pkg > 0) independent.package.push(row.name);
    if (pkg === 0 && publish > 0) independent.publish.push(row.name);   // 档位表只列「包内零命中」的那些
    if (pkg === 0 && publish === 0 && internal > 0) independent.internal.push(row.name);
    if (pkg === 0 && publish === 0 && internal === 0) independent.zero.push(row.name);
  }
  const sorted = (list) => [...list].sort();
  assert.deepEqual(
    sorted(independent.zero),
    sorted(payload.candidates.map((c) => c.name)),
    "第二套实现算出的「真·零引用」清单与脚本不一致——脚本在静默少报/多报，清点不是真值",
  );
  assert.deepEqual(
    sorted(independent.publish),
    sorted(payload.publishConsumers.map((c) => c.name)),
    "发布面消费者档与第二套实现不一致（`examples/` `test/contract/` 是发布面，不是「零消费者」）",
  );
  assert.deepEqual(
    sorted(independent.internal),
    sorted(payload.internalOnly.map((c) => c.name)),
    "internal-only 档与第二套实现不一致（定义文件内除声明外还被引用，不得混进「零引用」）",
  );
  // 分档计数必须自洽：四档 + 兜底 = 总数
  const t = payload.tiers;
  assert.equal(
    t["package-consumed"] + t["publish-only"] + t["publish+internal"] + t["internal-only"] + t["zero-reference"]
      + t["outside-corpus"] + t["internal-unknown"] + t["definition-missing"] + t["definition-symbol-missing"],
    payload.total,
    `分档计数加起来不等于总数：${JSON.stringify(t)} vs ${payload.total}`,
  );
  // 清点必须给得出来源与复现命令（要能直接贴进 issue）
  assert.ok(payload.criteria.length >= 5, "口径说明不能空");
  assert.ok(payload.reproduce.some((c) => c.includes("scripts/export-consumer-check.mjs")), "复现命令必须给全");
});

test("清点不判定：有零消费者候选也 exit 0，报告写明「不参与任何门禁判定」", async () => {
  const root = await miniRepo({
    "src/index.js": 'export { orphan, used } from "./mod.js";\n',
    "src/tools/index.js": 'export { used } from "../mod.js";\n',
    "src/mod.js": "export const orphan = 1;\nexport const used = 2;\n",
    "src/consumer.js": 'import { used } from "./mod.js";\nconsole.log(used);\n',
  });
  const result = runScript(["--root", root]);
  assert.equal(result.status, 0, `零消费者不是错误，必须 exit 0：${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /不参与任何门禁判定/u);
  assert.match(result.stdout, /零消费者（包内 \+ 发布面都零命中）：1 \/ 2/u, "应当且仅当 orphan 是候选");
  assert.match(result.stdout, /\| `orphan` \| `src\/mod\.js` \| 0 \| 0 \|/u, "表里要有 名字/定义文件/自身测试数/文档提及数");
  assert.match(result.stdout, /node scripts\/export-consumer-check\.mjs/u, "逐字复现命令要印出来");
});

test("读不出真值就红：`export *` 必须点名「不展开」并 exit 2（不许静默漏）", async () => {
  const root = await miniRepo({
    "src/index.js": 'export { used } from "./mod.js";\nexport * from "./mod.js";\n',
    "src/tools/index.js": 'export { used } from "../mod.js";\n',
    "src/mod.js": "export const used = 1;\n",
    "src/consumer.js": 'import { used } from "./mod.js";\nconsole.log(used);\n',
  });
  const result = runScript(["--root", root, "--json"]);
  assert.equal(result.status, 2, "`export *` 未展开 ⇒ 清点不完整 ⇒ exit 2");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.incomplete, true);
  assert.equal(payload.exportStars.length, 1);
  assert.ok(
    payload.errors.some((e) => e.code === "EXPORT_STAR_UNEXPANDED" && e.message.includes("本工具不展开 `export *`，已发现 1 处")),
    `错误信息要照口径写明「不展开 export *，已发现 N 处」：${JSON.stringify(payload.errors)}`,
  );
});

test("读不出真值就红：入口读不到时 exit 2，而不是静默报 0 个导出名", async () => {
  const root = await miniRepo({
    "src/mod.js": "export const used = 1;\n",
    "bin/cli.js": 'import { used } from "../src/mod.js";\nconsole.log(used);\n',
  });
  const result = runScript(["--root", root, "--json"]);
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.errors.some((e) => e.code === "ENTRY_MISSING"), "必须点名 ENTRY_MISSING");
  assert.equal(payload.total, 0, "此时 0 是假数，但已经被 incomplete 标住了");
});

test("读不出真值就红：定义文件读不到时 exit 2（`from` 指到不存在的文件）", async () => {
  const root = await miniRepo({
    "src/index.js": 'export { ghost } from "./nope.js";\n',
    "src/tools/index.js": 'export { ghost } from "../nope.js";\n',
  });
  const result = runScript(["--root", root, "--json"]);
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.errors.some((e) => e.code === "DEFINITION_MISSING"), "必须点名 DEFINITION_MISSING");
});

// #429 口径漏洞④：两个「读不出真值却给 exit 0」的漏口。三态：修前该形状会静默绿（这里用 exit 2 钉住），
// 修后红得可区分，而无关形状（干净迷你仓库）不受影响——三个断言写在同一例里，不扩散成一片新测试。
test("读不出真值就红：扫描面目录不存在 / 定义文件里没这个符号，各有可区分的分类码且 exit 2", async () => {
  const files = {
    "src/index.js": 'export { used } from "./mod.js";\n',
    "src/tools/index.js": 'export { used } from "../mod.js";\n',
    "src/mod.js": "export const used = 1;\n",
    "src/consumer.js": 'import { used } from "./mod.js";\nconsole.log(used);\n',
  };
  // 无关形状：同一棵树但扫描面完整、符号都在 ⇒ exit 0，两个新码一个都不出现（修完不许误伤）。
  const clean = await miniRepo(files, "erix-export-consumer-clean-");
  const cleanResult = runScript(["--root", clean, "--json"]);
  assert.equal(cleanResult.status, 0, `干净的迷你仓库必须 exit 0：${cleanResult.stdout}${cleanResult.stderr}`);
  const cleanPayload = JSON.parse(cleanResult.stdout);
  for (const code of ["CORPUS_DIR_UNREADABLE", "DEFINITION_SYMBOL_MISSING"]) {
    assert.ok(!cleanPayload.errors.some((e) => e.code === code), `干净树不该出现 ${code}`);
  }

  // (a) 扫描面目录被删掉：以前静默跳过、总数照算 ⇒ exit 0 假绿。
  const missingDir = await miniRepo(files, "erix-export-consumer-nodir-");
  rmSync(join(missingDir, "examples"), { recursive: true, force: true });
  const dirResult = runScript(["--root", missingDir, "--json"]);
  assert.equal(dirResult.status, 2, "扫描面目录读不出 ⇒ 清点不完整 ⇒ exit 2");
  const dirPayload = JSON.parse(dirResult.stdout);
  assert.equal(dirPayload.incomplete, true);
  assert.ok(
    dirPayload.errors.some((e) => e.code === "CORPUS_DIR_UNREADABLE" && e.message.includes("examples/")),
    `必须点名 CORPUS_DIR_UNREADABLE 并指出是哪个目录：${JSON.stringify(dirPayload.errors)}`,
  );

  // (b) 定义文件在、但里面找不到该符号：以前照样计入总数 ⇒ exit 0 假绿。
  const ghostSymbol = await miniRepo({
    ...files,
    "src/mod.js": "export const other = 1;\n",   // used 的声明没了
  }, "erix-export-consumer-ghost-");
  const ghostResult = runScript(["--root", ghostSymbol, "--json"]);
  assert.equal(ghostResult.status, 2, "定义文件里找不到该符号 ⇒ 清点不完整 ⇒ exit 2");
  const ghostPayload = JSON.parse(ghostResult.stdout);
  assert.equal(ghostPayload.incomplete, true);
  assert.ok(
    ghostPayload.errors.some((e) => e.code === "DEFINITION_SYMBOL_MISSING" && e.message.includes("used")),
    `必须点名 DEFINITION_SYMBOL_MISSING（与 DEFINITION_MISSING 可区分）：${JSON.stringify(ghostPayload.errors)}`,
  );
  assert.ok(
    !ghostPayload.errors.some((e) => e.code === "DEFINITION_MISSING"),
    "定义文件是存在的，不得报成 DEFINITION_MISSING——两个码必须可区分",
  );
});

test("坑 2：花括号里的注释不会被当成名字；非法 token 抛 ExportParseError 而不是静默吞", () => {
  const text = [
    "export {",
    "  alpha,",
    "  // issue #220：成功返回形态的判别式",
    "  beta as gamma,",
    "} from \"./mod.js\";",
    "",
  ].join("\n");
  const parsed = parseEntryExports(text, "src/index.js");
  assert.deepEqual(parsed.names.map((n) => n.name), ["alpha", "gamma"], "注释行不许变成导出名");
  assert.deepEqual(parsed.names.map((n) => n.def), ["src/mod.js", "src/mod.js"], "定义处必须是 from 指的文件");
  for (const row of parsed.names) assert.match(row.name, IDENT);

  assert.throws(
    () => parseEntryExports('export { alpha, "beta" } from "./mod.js";\n', "src/index.js"),
    (err) => err instanceof ExportParseError && err.code === "EXPORT_PARSE_ERROR",
    "不匹配标识符就必须抛错（静默吞掉 = 少报一个导出 = 清点假绿）",
  );
});

test("坑 1：countNameHits 无状态；`extractL0` 不被 `extractL0Facts` 的命中顶替", () => {
  const text = "const extractL0Facts = 1;\nconst a = extractL0;\nconst b = extractL0;\n";
  assert.equal(countNameHits(text, "extractL0"), 2, "两次出现都要数到（有状态实现在第二次会数漏）");
  assert.equal(countNameHits(text, "extractL0"), 2, "连打第二次必须同值——`g` + `.test()` 那种实现在这里会变 1");
  assert.equal(countNameHits(text, "extractL0Facts"), 1, "标识符边界：不能把 extractL0 的命中算给 extractL0Facts");
  assert.equal(countNameHits(text, "$"), 0);
});

test("bin/ 的「import 了却没用」按「import 语句之外零命中」判定", () => {
  const records = [
    {
      rel: "bin/fake.js",
      text: [
        "import { used, unused, renamed as alias } from \"../src/mod.js\";",
        "import * as ns from \"node:fs\";",
        "used();",
        "console.log(alias);",
        "ns.readFileSync;",
        "",
      ].join("\n"),
    },
  ];
  const found = scanImportedButUnused(records);
  assert.deepEqual(found.map((f) => f.name), ["unused"], `只应报 unused：${JSON.stringify(found)}`);
  assert.equal(found[0].file, "bin/fake.js");

  // 真树上这条只是「形状自检」：报出来的每一条都得是 bin/ 里的合法标识符。
  // 不硬编码具体名字——被清理掉是**好事**，不该让测试变红。
  const real = runScript(["--json"]);
  const payload = JSON.parse(real.stdout);
  assert.ok(Array.isArray(payload.importedButUnused));
  for (const item of payload.importedButUnused) {
    assert.ok(item.file.startsWith("bin/"), `${item.file} 不在 bin/ 下`);
    assert.match(item.name, IDENT);
  }
});

test("--self-test：反向证（真树删消费者 +1 / 坑 1 / 坑 2 / 坑 3）exit 0", () => {
  const result = runScript(["--self-test"]);
  assert.equal(result.status, 0, `--self-test 必须绿：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /候选数 原值 \d+ → 变异后 \d+（\+1/u, "真树反向证的三态数要印出来");
  assert.match(result.stdout, /export-consumer-check --self-test: OK/u);
});

test("反向证（磁盘上，临时副本）：删掉一个真消费者 ⇒ 候选 +1；加回来 ⇒ 回到原值", async () => {
  // `--self-test` 的例① 打在**内存记录**上；这一条打在同一棵树的两份**磁盘副本**上（`makeTmp`），
  // 证明的是「读盘 → 清点 → 报告」整条链路的三态，而不是纯函数的三态。仓内源码全程只读。
  const files = {
    "src/index.js": 'export { orphan, used } from "./mod.js";\n',
    "src/tools/index.js": 'export { used } from "../mod.js";\n',
    "src/mod.js": "export const orphan = 1;\nexport const used = 2;\n",
    "src/consumer.js": 'import { used } from "./mod.js";\nconsole.log(used);\n',
  };
  const countCandidates = (root) => {
    const result = runScript(["--root", root, "--json"]);
    assert.equal(result.status, 0, `清点必须 exit 0：${result.stderr}`);
    return JSON.parse(result.stdout).candidates.map((c) => c.name).sort();
  };

  const baseline = await miniRepo(files, "erix-export-consumer-baseline-");
  const original = countCandidates(baseline);
  assert.deepEqual(original, ["orphan"], "基线：只有 orphan 零消费者");

  const mutated = await miniRepo(files, "erix-export-consumer-mutated-");
  const consumerPath = join(mutated, "src/consumer.js");
  const before = readFileSync(consumerPath, "utf8");
  // 整个文件清空：只删 import 行不够——`console.log(used)` 还在，按口径它仍是消费者。
  writeFileSync(consumerPath, "// consumer 暂时空着\n");
  assert.notEqual(readFileSync(consumerPath, "utf8"), before, "变异必须真的落上（#210 R2）");
  const afterDelete = countCandidates(mutated);
  assert.deepEqual(afterDelete, ["orphan", "used"], `删掉唯一那处引用后候选数必须 +1：${JSON.stringify(afterDelete)}`);

  writeFileSync(consumerPath, before);   // 加回来
  assert.deepEqual(countCandidates(mutated), original, "加回来后候选数必须回到原值");
});

test("npm script 与中英 AGENTS 各有一行（成对，且写清「清点、不判定」）", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check:exports"], "node scripts/export-consumer-check.mjs", "npm script 必须指向这个脚本");
  for (const doc of ["AGENTS.md", "AGENTS_cn.md"]) {
    const rows = readFileSync(join(ROOT, doc), "utf8")
      .split("\n").filter((line) => line.startsWith("| `npm run check:exports` |"));
    assert.equal(rows.length, 1, `${doc} 的「开发命令」表里要有且只有一行 \`npm run check:exports\`（中英成对）`);
    assert.match(rows[0], /不判定|no gate, no judgement/u, `${doc} 那一行必须写清「清点、不判定」——这是本票的红线，不是修辞`);
    assert.match(rows[0], /scripts\/export-consumer-check\.mjs/u, `${doc} 那一行要点名脚本（check:docs 会核这个路径存在）`);
    // #429 口径漏洞①：入口是三个，声称句不能还写「两个」。
    assert.match(rows[0], /test\/contract/u, `${doc} 那一行必须写上第三个入口（test/contract/index.js，./contract-tests）`);
    // #429 口径漏洞②③：分档（发布面消费者 / internal-only）也要在声称句里看得见。
    assert.match(rows[0], /internal-only/u, `${doc} 那一行要点名 internal-only 这一档（不是死导出）`);
    assert.match(rows[0], /test\/contract/u, `${doc} 那一行要写清 test/contract/ 是发布面消费者`);
  }
});

test("computeInventory 是纯函数：同一份记录跑两遍结果一致，且不写盘", () => {
  const records = [
    { rel: "src/index.js", text: 'export { a } from "./mod.js";\n' },
    { rel: "src/tools/index.js", text: 'export { b } from "../mod.js";\n' },
    { rel: "test/contract/index.js", text: 'export { a } from "../../src/mod.js";\n' },
    { rel: "src/mod.js", text: "export const a = 1;\nexport const b = 2;\n" },
    { rel: "src/use.js", text: 'import { a } from "./mod.js";\nconsole.log(a);\n' },
  ];
  const first = computeInventory(records);
  const second = computeInventory(records);
  assert.deepEqual(first.candidates.map((c) => c.name), ["b"]);
  assert.deepEqual(second.candidates.map((c) => c.name), first.candidates.map((c) => c.name));
  assert.deepEqual(records.map((r) => r.rel), ["src/index.js", "src/tools/index.js", "test/contract/index.js", "src/mod.js", "src/use.js"], "记录不许被就地改写");
});
