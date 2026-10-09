#!/usr/bin/env node
// issue #199：测试临时目录卫生的机器守卫——把上游派单的「验收 grep」变成会阻塞的命令。
// 零依赖，只用 node: 内置。退出码非 0 即失败（npm run check:tests）。
//
// 规则 A：test/** 里没有任何 fs 调用的**第一个参数**是 `/tmp` 字面量。
//   覆盖三种形态（上一单 #185 用过的三条 grep）：
//     1) join("/tmp"        —— join/path.join 以 /tmp 字面量作首参
//     2) 裸 "<fs 调用>("+"/tmp —— 常见 fs/promises 函数直接吃 /tmp 字面量
//     3) mkdtemp("/tmp      —— mkdtemp / mkdtempSync 直接吃 /tmp 字面量
//   惰性字面量不归管：出现在对象字面量、断言期望值、第二个及以后参数里的 "/tmp/…"
//   （如 cwd: "/tmp/project"）不落盘，是 #185 确认保留的口径，本守卫不误伤。
//
// 规则 B：test/** 里除 test/helpers/tmp.js 之外，不得出现裸
//   `mkdtemp(join(tmpdir(`——即验收 grep `mkdtemp\(\s*(await\s+)?join\(\s*tmpdir\(\)`
//   的原样机器化。此类调用不建父目录，TMPDIR 指向未预建路径时成片 ENOENT，必须走 makeTmp。
//
// 口径说明（规则 B 的边界）：字面读「除 tmp.js 外不得出现裸 mkdtemp(」会把
// `mkdtemp(path.join(tmpdir(), …))` 与 `mkdtempSync(...)` 等历史形态一并卷入（约 21 处，
// 含打包发布的 test/contract/*），超出本单「38 处」范围，且动 test/contract/* 与
// npm files 白名单纠缠。故规则 B 硬拦的是验收 grep 形态；其余 mkdtemp( 直接调用点
// 打印为提示（不阻塞），留给后续单收口。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_DIR = join(ROOT, "test");
const EXEMPT_MKDTEMP = "test/helpers/tmp.js";
const EXTS = new Set([".js", ".mjs", ".cjs"]);

const FS_FIRST_ARG_CALL =
  /\b(?:fs\.)?(?:readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|createReadStream|createWriteStream|mkdir|mkdirSync|mkdtemp|mkdtempSync|readdir|readdirSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|chmod|chmodSync|chown|chownSync|stat|statSync|lstat|lstatSync|access|accessSync|open|openSync|realpath|realpathSync|rename|renameSync|truncate|truncateSync|symlink|symlinkSync|link|linkSync|cp|mv|watch|watchFile|existsSync)\(\s*['"`]\/tmp\b/;

const RULES = [
  { id: "join-tmp-literal", re: /\bjoin\(\s*['"`]\/tmp\b/, why: 'join(...) 首参是 "/tmp" 字面量，应走 makeTmp/os.tmpdir()' },
  { id: "fs-arg-tmp-literal", re: FS_FIRST_ARG_CALL, why: 'fs 调用首参是 "/tmp" 字面量，应走 makeTmp/os.tmpdir()' },
  { id: "mkdtemp-tmp-literal", re: /\bmkdtemp(?:Sync)?\(\s*['"`]\/tmp\b/, why: 'mkdtemp 首参是 "/tmp" 字面量，应走 makeTmp' },
  { id: "bare-mkdtemp-tmpdir", re: /mkdtemp\(\s*(?:await\s+)?join\(\s*tmpdir\(/, why: "裸 mkdtemp(join(tmpdir(…) 不建父目录，TMPDIR 未预建时 ENOENT，应走 makeTmp", exempt: EXEMPT_MKDTEMP },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(name.slice(name.lastIndexOf(".")))) out.push(p);
  }
  return out;
}

const files = walk(TEST_DIR).sort();
const violations = [];
let legacyMkdtemp = 0;
for (const abs of files) {
  const rel = relative(ROOT, abs).split("\\").join("/");
  const lines = readFileSync(abs, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.exempt && rel === rule.exempt) continue;
      if (rule.re.test(line)) {
        violations.push(`FAIL ${rule.id}: ${rel}:${i + 1}: ${line.trim()}  — ${rule.why}`);
      }
    }
    // 提示项：规则 B 边界之外的 mkdtemp( 直接调用（path.join 前缀 / fs.mkdtemp 等历史形态）。
    if (rel !== EXEMPT_MKDTEMP && /\bmkdtemp\(/.test(line) && !/mkdtemp\(\s*(?:await\s+)?join\(\s*tmpdir\(/.test(line)) {
      legacyMkdtemp += 1;
    }
  });
}

for (const v of violations) console.error(v);
if (violations.length) {
  console.error(`test-hygiene-check: 失败 — ${violations.length} 处违规（扫描 ${files.length} 个文件）`);
  process.exit(1);
}
const note = legacyMkdtemp
  ? `；提示：另有 ${legacyMkdtemp} 处 mkdtemp(path.join(tmpdir(…) 等历史形态（超出本单 38 处口径，未阻塞，留后续单收口）`
  : "";
console.log(`test-hygiene-check: OK — 扫描 test/** ${files.length} 个文件，/tmp 字面量首参与裸 mkdtemp(join(tmpdir( 均为 0${note}`);
