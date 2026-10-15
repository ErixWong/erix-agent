#!/usr/bin/env node
// issue #187：把 `npm run check`（只是 `node --check src/index.js`，单文件）扩成**全量**语法检查。
// 零依赖，只用 node: 内置。退出码非 0 即失败（npm run check:syntax）。
//
// 覆盖面 = `git ls-files` 里所有跟踪的 `.js` / `.mjs` / `.cjs`（`src/`、`bin/`、`scripts/`、
// `test/`、`examples/`、`fixtures/` 全在内）。逐个子进程 `node --check`：
//   - 为什么逐个 spawn 而不是 `vm.Script`：`vm` 只吃 CommonJS 形状的脚本，`import` /
//     `export` / 顶层 `await` 会直接 SyntaxError（本仓是 `"type": "module"`）；`vm.SourceTextModule`
//     要 `--experimental-vm-modules`。`node --check` 自己会按扩展名与 package.json `type` 选
//     解析模式，且**只解析不执行**，正是这一门要的语义。
//   - 为什么不 `xargs`：错误要**点名文件**并汇总，一条命令红掉不该中断整轮扫描。
// 并发上限 availableParallelism，纯 I/O 型子进程，不改变「全量都查」这个覆盖面。
//
// 未跟踪文件不归管（与 `git ls-files` 口径一致）：CI 拿到的是 checkout 出来的跟踪树，
// 未跟踪文件本来就不在其中。
import { spawn, execFileSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTS = [".js", ".mjs", ".cjs"];

function trackedScripts() {
  let raw;
  try {
    raw = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    console.error(`syntax-check: 无法读取跟踪文件清单（git ls-files 失败：${err?.message ?? err}）`);
    process.exit(1);
  }
  return raw
    .split("\0")
    .filter((p) => p && EXTS.some((e) => p.endsWith(e)))
    .sort();
}

function checkFile(rel) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--check", rel], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (err) => resolve({ rel, code: null, output: String(err?.message ?? err) }));
    child.on("close", (code) => resolve(code === 0 ? null : { rel, code, output: out }));
  });
}

const files = trackedScripts();
const failures = [];
const limit = Math.max(1, Math.min(8, availableParallelism?.() ?? 4));
let cursor = 0;
async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= files.length) return;
    const bad = await checkFile(files[i]);
    if (bad) failures.push(bad);
  }
}
await Promise.all(Array.from({ length: limit }, worker));

failures.sort((a, b) => a.rel.localeCompare(b.rel));
for (const f of failures) {
  const detail = String(f.output ?? "").trim().split("\n").slice(0, 12).join("\n      ");
  console.error(`FAIL syntax: ${f.rel}${f.code === null ? "" : ` (node --check exit ${f.code})`}\n      ${detail}`);
}
if (failures.length) {
  console.error(
    `syntax-check: 失败 — ${failures.length}/${files.length} 个跟踪文件语法不过：${failures.map((f) => f.rel).join(", ")}`,
  );
  process.exit(1);
}
console.log(`syntax-check: OK — 全量 ${files.length} 个跟踪的 .js/.mjs/.cjs 文件 node --check 全过（口径：git ls-files，含 src/ bin/ scripts/ test/ examples/ fixtures/）`);
