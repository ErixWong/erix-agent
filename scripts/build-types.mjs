#!/usr/bin/env node
// build-types.mjs — 发布用 `.d.ts` 声明的生成器与断言式门禁（issue #213；零运行时依赖，仅 node: 内置）
//
// 干什么：
//   1. 用 devDependency `typescript` 跑 `tsc --declaration --emitDeclarationOnly`，把声明**生成到
//      `src/**/*.d.ts`**（`package.json` 的 `files` 已含 `src`，所以生成物自动进包，白名单不用改）。
//   2. `--check` 模式（`npm run check:types-build`）额外断言四件事，然后**清理生成物**保持工作树干净：
//      tsc exit 0 / 生成的 `.d.ts` 文件数 > 0 / `src/index.d.ts` 含 `runToolLoop` /
//      `src/tools/index.d.ts` 含 `createFileTools`。**只防「某天产不出声明」，不做类型质量评判**
//      （质量抽查在 #213 R4 与宿主消费侧；`--checkJs` 是另一张单）。
//
// 为什么生成到 `src/` 而不是临时目录：声明必须落在 `files` 白名单覆盖的位置才进得了 tarball，
// 而 `prepack` 钩子（发布期触发、消费者从 registry 安装时不触发）就是在这里调本脚本的。
// 生成物**不入库**（`.gitignore` 里有 `src/**/*.d.ts`），避免生成物与源码漂移。
//
// 为什么 `@types/node` 也是 devDependency：`AbortSignal`/`fetch`/`node:` 内置模块的类型来自它；
// 运行时零依赖红线只约束 `src/`、`bin/` 的 import（`node:` 内置 + 相对路径），dev 工具链不进包。
//
// 用法：
//   node scripts/build-types.mjs             # 生成并保留（prepack / 本地查看声明用）
//   node scripts/build-types.mjs --check     # 生成 + 断言 + 清理（CI 门禁）
//   node scripts/build-types.mjs --keep      # --check 之后仍保留生成物
//   node scripts/build-types.mjs --verbose   # 打印 tsc 命令行与生成物清单

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const KEEP = argv.includes("--keep");
const VERBOSE = argv.includes("--verbose");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

// 声明入口：包根 + `./tools` 子路径（与 `exports` 的 types 键一一对应）。
// `./contract-tests` 没有声明（它指向 `test/contract/index.js`，不在 src/ 的依赖图里），
// 所以 `exports["./contract-tests"]` 刻意不带 `types` 键。
const ENTRIES = ["src/index.js", "src/tools/index.js"];

// 与 issue #213 spike 实测口径逐字一致（tsc 5.9.3 + @types/node@22 → exit 0、0 错）。
// 注意：CLI 显式给出输入文件时 tsc **不读** tsconfig.json，所以本仓不需要、也没有 tsconfig。
const TSC_FLAGS = [
  "--declaration",
  "--emitDeclarationOnly",
  "--allowJs",
  "--target",
  "es2023",
  "--module",
  "nodenext",
  "--moduleResolution",
  "nodenext",
  "--skipLibCheck",
];

// 断言面：入口声明里必须出现的公共符号（少了它就是「类型面缩水」，门禁必须红）。
const REQUIRED_SYMBOLS = [
  ["src/index.d.ts", "runToolLoop"],
  ["src/index.d.ts", "createAssemblyPort"],
  ["src/tools/index.d.ts", "createFileTools"],
];

const failures = [];
const fail = (msg) => failures.push(msg);
// ⚠ 所有进度信息一律走 **stderr**：本脚本被 `prepack` 钩子调用，而 lifecycle 脚本继承 npm 的
// stdout —— `npm pack --dry-run --json`（scripts/pack-link-check.mjs 依赖它）会把 stdout 当纯 JSON
// 解析，往 stdout 打一行进度就会让那个门禁变成「could not parse npm pack JSON」（实测）。
const log = (msg) => console.error(msg);

function dtsFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const rel = path.join(dir, name);
    if (statSync(rel).isDirectory()) dtsFiles(rel, acc);
    else if (rel.endsWith(".d.ts")) acc.push(rel);
  }
  return acc;
}

function resolveTsc() {
  const candidates = [
    path.join(ROOT, "node_modules", "typescript", "bin", "tsc"),
    path.join(ROOT, "node_modules", "typescript", "tsc.js"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const tsc = resolveTsc();
if (!tsc) {
  // 清晰报错而不是堆栈：tsc 是 devDependency，没装（或 npm 跳过了 dev 安装）是这个门禁最常见的红法。
  console.error(
    "check:types-build: 找不到 TypeScript 编译器（tsc）。\n"
    + "  tsc 是 devDependency（issue #213：运行时零依赖红线只约束 import，dev 工具链不进包），\n"
    + "  先在本仓库根目录装依赖再重跑：\n"
    + `    ${npmCommand} install --include=dev\n`
    + "  ⚠ 环境里 `NODE_ENV=production` 时 `npm install` 会**默认跳过 devDependencies**（实测 npm 10.9.8：\n"
    + "    `npm install` 报「up to date, audited 1 package」而 tsc 并不存在），必须显式 `--include=dev`。\n"
    + `  期望路径：${path.join(ROOT, "node_modules", "typescript", "bin", "tsc")}`,
  );
  process.exit(1);
}

const before = new Set(dtsFiles(path.join(ROOT, "src")));
if (VERBOSE) log(`build-types: 生成前已存在的 .d.ts：${before.size} 个`);

const cmd = [tsc, ...TSC_FLAGS, ...ENTRIES];
if (VERBOSE) log(`build-types: ${process.execPath} ${cmd.join(" ")}`);
const tscRun = spawnSync(process.execPath, cmd, { cwd: ROOT, encoding: "utf8" });
const tscOutput = `${tscRun.stdout ?? ""}${tscRun.stderr ?? ""}`.trim();

if (tscRun.error) {
  console.error(`check:types-build: 启动 tsc 失败：${tscRun.error.message}`);
  process.exit(1);
}
if (tscRun.status !== 0) {
  console.error(`check:types-build: tsc 退出码 ${tscRun.status}（期望 0）`);
  if (tscOutput) console.error(tscOutput);
  else console.error("（tsc 无输出）");
  process.exit(1);
}
if (tscOutput) {
  // exit 0 却有输出：一般是 tsc 的非致命信息，打印出来，不改判定
  log(`build-types: tsc 输出（不影响判定）：\n${tscOutput}`);
}

const all = dtsFiles(path.join(ROOT, "src"));
const generated = all.filter((f) => !before.has(f));
if (all.length === 0) {
  fail(`生成的 .d.ts 文件数为 0（期望 > 0）：${ENTRIES.join(", ")} 的声明没落到 src/`);
}
if (all.length > 0 && generated.length === 0) {
  // 生成物全部与「生成前」重合：说明本次 tsc 什么都没写（幂等空跑），断言仍按内容走
  log(`build-types: 提示——src/ 下 ${all.length} 个 .d.ts 在生成前就已存在（--check 不会删它们）`);
}

for (const [rel, symbol] of REQUIRED_SYMBOLS) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) {
    fail(`${rel} 不存在（tsc exit 0 但没落到预期位置）`);
    continue;
  }
  const text = readFileSync(abs, "utf8");
  if (!text.includes(symbol)) {
    fail(`${rel} 里找不到公共符号 ${symbol}（类型面缩水或声明入口写错）`);
  }
}

if (failures.length) {
  console.error(`check:types-build: 失败 — ${failures.length} 项断言不成立`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`  （本次生成 ${generated.length} 个 .d.ts，共 ${all.length} 个在 src/ 下）`);
  // 失败时把生成物清掉，避免把半套生成物留在工作树里迷惑人（--keep 除外）
  if (CHECK && !KEEP) cleanup(generated);
  process.exit(1);
}

function cleanup(files) {
  let removed = 0;
  for (const f of files) {
    rmSync(f, { force: true });
    removed += 1;
  }
  return removed;
}

log(
  `build-types: OK — tsc exit 0，src/ 下 ${all.length} 个 .d.ts（本次生成 ${generated.length} 个）；`
  + `断言 ${REQUIRED_SYMBOLS.map(([f, s]) => `${f}#${s}`).join("、")} 全部命中`
  + (VERBOSE ? `\n  生成物：\n${generated.map((f) => `    ${path.relative(ROOT, f)}`).join("\n")}` : ""),
);

if (CHECK && !KEEP) {
  const removed = cleanup(generated);
  const leftovers = dtsFiles(path.join(ROOT, "src")).length;
  log(
    `check:types-build: OK — 断言全过，已清理 ${removed} 个本次生成物`
    + (leftovers ? `；src/ 下仍留有 ${leftovers} 个**先前**生成的 .d.ts（不是本次产物，本脚本不删别人建的文件；`
      + "它们被 .gitignore 忽略，所以工作树按 git 口径仍是干净的）" : "，工作树保持干净"),
  );
} else if (CHECK) {
  log("check:types-build: OK — 断言全过（--keep：生成物保留在 src/ 下，已被 .gitignore 忽略）");
}
