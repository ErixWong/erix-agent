#!/usr/bin/env node
// issue #199 / #209：测试临时目录卫生的机器守卫——把上游派单的「验收 grep」变成会阻塞的命令。
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
// 规则 B（#209 起**阻塞**）：test/** 里除 test/helpers/tmp.js 之外，**任何** mkdtemp 直接调用
//   都是违规——`mkdtemp(...)`、`fs.mkdtemp(...)`、`mkdtempSync(...)` 一并算。
//   唯一正解是 `await makeTmp(prefix)`（test/helpers/tmp.js：尊重 TMPDIR、进程内 memoize 的
//   可写探针、基路径不可写时以具名错误 `TMPDIR_NOT_WRITABLE` 一条根因失败、注册 after() 清理）。
//
//   #209 之前这条规则只硬拦验收 grep 的窄形态 `mkdtemp(join(tmpdir(`，其余 mkdtemp( 调用点
//   只打印成「提示」。注释却声称 `mkdtemp(path.join(tmpdir(…)` 与 `mkdtempSync(...)` 等历史
//   形态「一并卷入」——**注释、实现、实际三者互不相符**（提示数 23 既不等于 mkdtemp( 的 25、
//   也不等于 mkdtempSync( 的 17，且 mkdtempSync 那一格根本没进提示）。#209 把提示清零并升级为
//   失败，注释与实现现在是同一句话：test/** 里不许有 mkdtemp 调用。
//
// 规则 C（豁免）：确实不能走 makeTmp 的调用点，必须**显式注释豁免 + 写明理由**：
//     1) 在调用所在行，或紧邻的上一行，写 `test-hygiene-exempt: <理由>`；
//     2) 理由不能为空（只有标记没有理由 = 违规，免得豁免退化成静音开关）；
//     3) 豁免只对**紧邻的那一行**生效，不是整个文件。
//   为什么要豁免而不是「反正也能改」：makeTmp 的清理是 `after()` 钩子，钩子作用域是注册它的
//   那个上下文——在 `before()` 里注册时目录会在文件还没跑完就被抽掉；个别用例正需要「文件级
//   生命周期」或必须把目录留在 cwd 下，那种场景才写豁免（详见 test/loop-option-normalization.js
//   的模块顶层取目录写法与 docs/testing.md 的说明）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_DIR = join(ROOT, "test");
const EXEMPT_FILE = "test/helpers/tmp.js";
const EXEMPT_TAG = /test-hygiene-exempt:/u;
const EXEMPT_MARKER = /test-hygiene-exempt:\s*(\S.*)$/u;
const EXTS = new Set([".js", ".mjs", ".cjs"]);

const FS_FIRST_ARG_CALL =
  /\b(?:fs\.)?(?:readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|createReadStream|createWriteStream|mkdir|mkdirSync|mkdtemp|mkdtempSync|readdir|readdirSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|chmod|chmodSync|chown|chownSync|stat|statSync|lstat|lstatSync|access|accessSync|open|openSync|realpath|realpathSync|rename|renameSync|truncate|truncateSync|symlink|symlinkSync|link|linkSync|cp|mv|watch|watchFile|existsSync)\(\s*['"`]\/tmp\b/;

// 任何 mkdtemp 直接调用（含 fs. 前缀与 Sync 变体）。`import { mkdtemp } from "node:fs"` 没有
// 左括号，不落进来；注释里的 `mkdtemp` 字样同理。
const ANY_MKDTEMP_CALL = /\b(?:fs\.)?mkdtemp(?:Sync)?\s*\(/u;

const RULES = [
  { id: "join-tmp-literal", re: /\bjoin\(\s*['"`]\/tmp\b/, why: 'join(...) 首参是 "/tmp" 字面量，应走 makeTmp/os.tmpdir()' },
  { id: "fs-arg-tmp-literal", re: FS_FIRST_ARG_CALL, why: 'fs 调用首参是 "/tmp" 字面量，应走 makeTmp/os.tmpdir()' },
  { id: "mkdtemp-tmp-literal", re: /\bmkdtemp(?:Sync)?\(\s*['"`]\/tmp\b/, why: 'mkdtemp 首参是 "/tmp" 字面量，应走 makeTmp' },
  {
    id: "bare-mkdtemp",
    re: ANY_MKDTEMP_CALL,
    why: "裸 mkdtemp 调用（mkdtemp / fs.mkdtemp / mkdtempSync 一视同仁）：不建父目录、没有 TMPDIR 可写探针，应走 await makeTmp(prefix)",
    exempt: EXEMPT_FILE,
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(name.slice(name.lastIndexOf(".")))) out.push(p);
  }
  return out;
}

/** 该行（或紧邻的上一行）是否带合规豁免注释；返回豁免理由或 null。 */
function exemptionFor(lines, index) {
  for (const candidate of [lines[index], lines[index - 1]]) {
    if (candidate === undefined) continue;
    const match = EXEMPT_MARKER.exec(candidate);
    if (match) return match[1].trim();
  }
  return null;
}

const files = walk(TEST_DIR).sort();
const violations = [];
const usedExemptions = [];
for (const abs of files) {
  const rel = relative(ROOT, abs).split("\\").join("/");
  const lines = readFileSync(abs, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.exempt && rel === rule.exempt) continue;
      if (!rule.re.test(line)) continue;
      const reason = exemptionFor(lines, i);
      if (reason) {
        usedExemptions.push(`${rel}:${i + 1}: ${reason}`);
        continue;
      }
      violations.push(`FAIL ${rule.id}: ${rel}:${i + 1}: ${line.trim()}  — ${rule.why}`);
    }
    // 只标了豁免标记却没写理由：豁免退化成静音开关，按违规处理。
    if (EXEMPT_TAG.test(line) && !EXEMPT_MARKER.test(line)) {
      violations.push(`FAIL empty-exemption: ${rel}:${i + 1}: 豁免注释没写理由（格式：test-hygiene-exempt: <理由>）`);
    }
  });
}

for (const v of violations) console.error(v);
if (violations.length) {
  console.error(`test-hygiene-check: 失败 — ${violations.length} 处违规（扫描 ${files.length} 个文件）`);
  process.exit(1);
}
const exemptNote = usedExemptions.length
  ? `；显式豁免 ${usedExemptions.length} 处：\n${usedExemptions.map((e) => `  - ${e}`).join("\n")}`
  : "；无显式豁免";
console.log(
  `test-hygiene-check: OK — 扫描 test/** ${files.length} 个文件，`
  + `/tmp 字面量首参与任何 mkdtemp 直接调用均为 0（临时目录一律走 test/helpers/tmp.js 的 makeTmp）${exemptNote}`,
);
