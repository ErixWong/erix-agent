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
//
// 自测（issue #374）：`node scripts/test-hygiene-check.mjs --self-test` 用**内存里的假文件集合**
//   （不落盘、不碰 test/ 真实文件）把上面三条规则的每条反向证固化成用例：该红的红、该绿的绿。
//   为什么需要它：#209 把守卫升级成阻塞之后，「守卫到底还拦不拦得住」只能靠人肉往 test/ 里插一行再删掉
//   —— 那既是手工活，又会因为插进去的那行先命中别的规则而误判。自测把这些形状钉在脚本里，并按 #210 R2
//   的口径：**变异没落上也算失败**（靶串不在假文件里 ⇒ 这一例判红，不许静默变绿）。自测与真树扫描共用
//   同一个纯函数 `checkRecords()`，所以「自测绿」证明的是**这条守卫的规则表**没被改坏，而不是「今天 test/
//   恰好干净」；反过来，改坏规则表（例如只扫 `mkdtemp(`、漏掉 `mkdtempSync`）会让自测红，而真树扫描
//   照样绿——这正是自测要补的那半个证明。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
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

/**
 * 纯函数：给定**内存里的文件记录集合**（`{ rel, text }`），返回裁决结果。
 * 真树扫描（`scanTree`）与 `--self-test` 都走这一条路径——所以自测绿证明的是规则表本身没被改坏，
 * 而不是「今天 test/ 恰好干净」（见文件头「自测」一段）。
 */
function checkRecords(records) {
  const violations = [];
  const usedExemptions = [];
  for (const { rel, text } of records) {
    const lines = text.split("\n");
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
  return { violations, usedExemptions, fileCount: records.length };
}

/** 真树：walk test/**、读成记录，交给 checkRecords（与自测同一条裁决路径）。 */
function scanTree() {
  return checkRecords(walk(TEST_DIR).sort().map((abs) => ({
    rel: relative(ROOT, abs).split("\\").join("/"),
    text: readFileSync(abs, "utf8"),
  })));
}

// ─────────────────────────────── --self-test（issue #374） ───────────────────────────────
// 假文件集合：基线是一份**干净**的假测试文件（只有 makeTmp）。每条用例靠**字符串变异**把它变成要考
// 的形状，或者直接给一份别的假文件。变异打不上（靶串 / 靶文件不在假文件里）按 #210 R2 判**失败**。
// 下限只许涨不许降：工单 #374 的下限是 6 格（①…⑥），这里是当前实测值。
const MIN_SELF_TEST_CASES = 13;

const FAKE_TEST_FILE = "test/zz-selftest-fake.test.js";
const FAKE_HELPER_FILE = EXEMPT_FILE;   // test/helpers/tmp.js —— 规则 B 的唯一豁免文件
const FAKE_LINE = '  const dir = await makeTmp("zz-");';   // 所有变异都打在这一枪上（第 5 行）

function fakeTestFile() {
  return [
    'import { test } from "node:test";',
    'import { makeTmp } from "./helpers/tmp.js";',
    "",
    'test("fake case", async () => {',
    FAKE_LINE,
    "  console.log(dir);",
    "});",
    "",
  ].join("\n");
}

/** 把变异落到假文件集合上；返回 { records, missed }，`missed` 非 null 就是「变异没落上」。 */
function applyMutation(records, mutate) {
  const next = records.map((r) => ({ ...r }));
  const target = next.find((r) => r.rel === mutate.rel);
  if (!target) return { records: next, missed: `${mutate.rel} 不在假文件集合里` };
  const before = target.text;
  // 函数式替换：靶串/替换串里的 `$&` 之类不当特殊语法，变异只按字面发生。
  target.text = before.replace(mutate.from, () => mutate.to);
  if (target.text === before) {
    return { records: next, missed: `${mutate.rel} 里找不到靶串 ${JSON.stringify(mutate.from)}` };
  }
  return { records: next, missed: null };
}

const SELF_TEST_CASES = [
  {
    label: "① mkdtempSync(join(tmpdir(), …)) ⇒ 红（规则 B 的 Sync 变体）",
    files: [{ rel: FAKE_TEST_FILE, text: fakeTestFile() }],
    mutate: { rel: FAKE_TEST_FILE, from: FAKE_LINE, to: '  const dir = mkdtempSync(join(tmpdir(), "zz-"));' },
    expect: [/^FAIL bare-mkdtemp: test\/zz-selftest-fake\.test\.js:5: const dir = mkdtempSync\(join\(tmpdir/u],
    expectCount: 1,
  },
  {
    label: "② 非 Sync 的 mkdtemp( ⇒ 红（旧 hint 漏的那一格）",
    files: [{ rel: FAKE_TEST_FILE, text: fakeTestFile() }],
    mutate: { rel: FAKE_TEST_FILE, from: FAKE_LINE, to: '  const dir = mkdtemp(join(tmpdir(), "zz-"));' },
    expect: [/^FAIL bare-mkdtemp: test\/zz-selftest-fake\.test\.js:5: const dir = mkdtemp\(join\(tmpdir/u],
    expectCount: 1,
  },
  {
    label: "②b fs.mkdtemp( 前缀变体 ⇒ 红（同一个规则，别让它从缝里漏过去）",
    files: [{ rel: FAKE_TEST_FILE, text: fakeTestFile() }],
    mutate: { rel: FAKE_TEST_FILE, from: FAKE_LINE, to: '  const dir = fs.mkdtemp(join(tmpdir(), "zz-"));' },
    expect: [/^FAIL bare-mkdtemp: test\/zz-selftest-fake\.test\.js:5: const dir = fs\.mkdtemp\(join/u],
    expectCount: 1,
  },
  {
    label: "③ makeTmp(…) ⇒ 绿（唯一正解；基线假文件本身就是这个形状）",
    files: [{ rel: FAKE_TEST_FILE, text: fakeTestFile() }],
    expectGreen: true,
  },
  {
    label: "④a 豁免注释 `// test-hygiene-exempt: <理由>` 紧邻上一行 ⇒ 绿，且守卫把豁免与理由一起记下来",
    files: [{ rel: FAKE_TEST_FILE, text: fakeTestFile() }],
    mutate: {
      rel: FAKE_TEST_FILE,
      from: FAKE_LINE,
      to: '  // test-hygiene-exempt: 文件级生命周期需要目录留在 cwd 下\n  const dir = mkdtempSync(join(tmpdir(), "zz-"));',
    },
    expectGreen: true,
    expectExemptions: [/^test\/zz-selftest-fake\.test\.js:6: 文件级生命周期需要目录留在 cwd 下$/u],
  },
  {
    label: "④b 豁免注释缺理由（只写标记）⇒ 红且点名行号，调用点也不放行",
    files: [{ rel: FAKE_TEST_FILE, text: fakeTestFile() }],
    mutate: {
      rel: FAKE_TEST_FILE,
      from: FAKE_LINE,
      to: '  // test-hygiene-exempt:\n  const dir = mkdtempSync(join(tmpdir(), "zz-"));',
    },
    expect: [
      /^FAIL empty-exemption: test\/zz-selftest-fake\.test\.js:5: 豁免注释没写理由/u,
      /^FAIL bare-mkdtemp: test\/zz-selftest-fake\.test\.js:6: /u,
    ],
    expectCount: 2,
  },
  {
    label: "⑤ helper 自己（test/helpers/tmp.js）⇒ 不计数（豁免文件不是「规则失效」）",
    files: [{ rel: FAKE_HELPER_FILE, text: 'const probe = await mkdtemp(join(base, "erix-probe-"));\n' }],
    expectGreen: true,
  },
  {
    label: "⑤ 对照：同一段 mkdtemp 文本换个文件名（test/zz-selftest-other.test.js）⇒ 必须红——证明 ⑤ 的绿来自豁免文件，不是整条规则失效",
    files: [{ rel: "test/zz-selftest-other.test.js", text: 'const probe = await mkdtemp(join(base, "erix-probe-"));\n' }],
    expect: [/^FAIL bare-mkdtemp: test\/zz-selftest-other\.test\.js:1: /u],
    expectCount: 1,
  },
  {
    label: "⑥ 变异器空转证：靶串（mkdtempSync 调用）不在假文件里 ⇒ 自测判「变异没落上」，不许假绿（#210 R2）",
    files: [{ rel: FAKE_TEST_FILE, text: fakeTestFile() }],
    mutate: { rel: FAKE_TEST_FILE, from: 'mkdtempSync(join(tmpdir(), "zz-"))', to: "makeTmp()" },
    expectMutateMiss: true,
  },
  {
    label: "A1 join(\"/tmp\", …) ⇒ 红（规则 A：join 首参是 /tmp 字面量）",
    files: [{ rel: FAKE_TEST_FILE, text: 'const p = join("/tmp", "zz");\n' }],
    expect: [/^FAIL join-tmp-literal: test\/zz-selftest-fake\.test\.js:1: /u],
    expectCount: 1,
  },
  {
    label: "A2 readFileSync(\"/tmp/…\") ⇒ 红（规则 A：fs 调用首参是 /tmp 字面量）",
    files: [{ rel: FAKE_TEST_FILE, text: 'readFileSync("/tmp/zz");\n' }],
    expect: [/^FAIL fs-arg-tmp-literal: test\/zz-selftest-fake\.test\.js:1: /u],
    expectCount: 1,
  },
  {
    label: "A3 mkdtempSync(\"/tmp/…\") ⇒ 三条规则各点一次名（fs-arg-tmp-literal + mkdtemp-tmp-literal + bare-mkdtemp：规则重叠时一条也不许被另一条吃掉）",
    files: [{ rel: FAKE_TEST_FILE, text: 'const dir = mkdtempSync("/tmp/zz-");\n' }],
    expect: [
      /^FAIL fs-arg-tmp-literal: test\/zz-selftest-fake\.test\.js:1: /u,
      /^FAIL mkdtemp-tmp-literal: test\/zz-selftest-fake\.test\.js:1: /u,
      /^FAIL bare-mkdtemp: test\/zz-selftest-fake\.test\.js:1: /u,
    ],
    expectCount: 3,
  },
  {
    label: "A4 惰性字面量不归管（放行证）：对象字面量里的 \"/tmp/project\" 与第二参数里的 \"/tmp\" ⇒ 必须绿（#185 确认保留的口径，不误伤）",
    files: [{ rel: FAKE_TEST_FILE, text: 'const opts = { cwd: "/tmp/project" };\nreadFileSync(file, "/tmp/zz");\n' }],
    expectGreen: true,
  },
];

function runSelfTest() {
  const failures = [];
  const passed = [];

  // 期望自己也要被看守（与 docs-drift-check #279 同一课）：能匹配空串的期望等于没有断言；
  // 既不是放行证、又没写 expect / expectExemptions / expectMutateMiss 的一例 = 整例被跳过；
  // 用例数低于下限 = 有用例被删。三刀都在跑变异**之前**报，免得「先全绿了再看」。
  if (SELF_TEST_CASES.length < MIN_SELF_TEST_CASES) {
    failures.push(`用例数被削：现在 ${SELF_TEST_CASES.length} 例，下限 ${MIN_SELF_TEST_CASES} 例——删用例 / 整例跳过不算修好`);
  }
  for (const [i, c] of SELF_TEST_CASES.entries()) {
    const who = c.label ?? `第 ${i + 1} 例`;
    for (const re of c.expect ?? []) {
      if (re.test("")) failures.push(`${who}：期望被削弱——正则 ${re} 连空串都匹配，等于没有断言（不许拿「永真」糊过这一例）`);
    }
    if (!c.expectGreen && !c.expectMutateMiss && !(c.expect ?? []).length && !(c.expectExemptions ?? []).length) {
      failures.push(`${who}：期望被削弱——既不是放行证（expectGreen / expectMutateMiss）也没写 expect / expectExemptions，等于整例被跳过`);
    }
  }

  for (const c of SELF_TEST_CASES) {
    const who = c.label;
    const { records, missed } = c.mutate
      ? applyMutation(c.files, c.mutate)
      : { records: c.files.map((r) => ({ ...r })), missed: null };
    if (missed) {
      // #210 R2：变异没落上 = 这一例没真的跑起来。要它「打不上」的那一例（⑥）等的就是这里。
      if (c.expectMutateMiss) {
        passed.push(`${who} → 变异确实没落上（${missed}），「变异器空转也算失败」这条判据在生效`);
      } else {
        failures.push(`${who}：变异没落上——${missed}（反向证自身失效：用例里的靶串已与假文件脱节）`);
      }
      continue;
    }
    if (c.expectMutateMiss) {
      failures.push(`${who}：这一例要的就是「变异打不上」，结果打上了——靶子已存在于假文件，换一个不存在的靶子`);
      continue;
    }
    const { violations, usedExemptions } = checkRecords(records);
    if (c.expectGreen) {
      if (violations.length) {
        failures.push(`${who}：本该绿，实测 ${violations.length} 处红：\n      ${violations.join("\n      ")}`);
      } else {
        passed.push(`${who} → 0 处违规（${records.length} 份假文件）`);
      }
      continue;
    }
    const missedExpect = (c.expect ?? []).filter((re) => !violations.some((v) => re.test(v)));
    const missedExemption = (c.expectExemptions ?? []).filter((re) => !usedExemptions.some((e) => re.test(e)));
    if (!violations.length) {
      failures.push(`${who}：改了但没红（规则表被改坏 / 这一格已失守）`);
      continue;
    }
    if (c.expectCount !== undefined && violations.length !== c.expectCount) {
      failures.push(`${who}：红了 ${violations.length} 处，期望 ${c.expectCount} 处：\n      ${violations.join("\n      ")}`);
      continue;
    }
    if (missedExpect.length || missedExemption.length) {
      failures.push(`${who}：红了，但报的不是该报的形状（未命中 ${[...missedExpect, ...missedExemption].map(String).join(" ; ")}）`
        + `\n      实测：${violations.join("\n      ")}`);
      continue;
    }
    passed.push(`${who} → ${violations.length} 处红（已点名）`);
  }

  console.log("test-hygiene-check --self-test：内存假文件集合上的反向证（改坏 → 红、干净 → 绿、豁免 → 绿；变异没落上也算失败）");
  for (const p of passed) console.log(`  ✓ ${p}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (failures.length) {
    console.log(`test-hygiene-check --self-test: 失败 — ${failures.length} 处未达预期（共 ${SELF_TEST_CASES.length} 例）`);
    process.exit(1);
  }
  console.log(`test-hygiene-check --self-test: OK — ${SELF_TEST_CASES.length} 例反向证/放行证全部按预期（内存假文件集合，不落盘、不碰 test/ 真实文件）`);
}

if (SELF_TEST) {
  runSelfTest();
  process.exit(0);   // 自测只跑内存假文件集合，不扫描 test/ 真树、不写盘
}

const { violations, usedExemptions, fileCount } = scanTree();
for (const v of violations) console.error(v);
if (violations.length) {
  console.error(`test-hygiene-check: 失败 — ${violations.length} 处违规（扫描 ${fileCount} 个文件）`);
  process.exit(1);
}
const exemptNote = usedExemptions.length
  ? `；显式豁免 ${usedExemptions.length} 处：\n${usedExemptions.map((e) => `  - ${e}`).join("\n")}`
  : "；无显式豁免";
console.log(
  `test-hygiene-check: OK — 扫描 test/** ${fileCount} 个文件，`
  + `/tmp 字面量首参与任何 mkdtemp 直接调用均为 0（临时目录一律走 test/helpers/tmp.js 的 makeTmp）${exemptNote}`,
);
