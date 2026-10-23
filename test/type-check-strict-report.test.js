// 覆盖 scripts/type-check-ratchet.mjs 的 **strict 观测点**（issue #416：`--strict-report` /
// `npm run check:types:strict`）。
//
// 为什么需要这一格（本单的「反向证」在测试侧的落点）：#416 的整个价值是「只观测、不判定」——
// 于是它**天生**不会被任何门禁拦住：观测接错了（比如忘了加 `--strict`、或者干脆把报告写成常量）
// 也照样 exit 0、照样一片绿。这里用四条断言把「观测接的是真值」钉住：
//   ① 真跑一次 `--strict-report --verbose`：exit 0、总数**严格大于**棘轮基线（同一棵树上真接上
//      `--strict`，总数就从三位数跳到四位数；没接上就只剩基线那个数，这条立刻红），并且**按文件
//      之和 = 按错误码之和 = 总数**（分布被截断/重复计数也红）。变异「把 `--strict` 从观测路径
//      删掉」会让它红，而不是静默变绿。
//   ② 结构性守卫：`TSC_ARGS` 里**不许**出现 `--strict`（那是棘轮口径，加进去等于把棘轮的判定
//      直接换成 strict 口径），`--strict` 只许出现在观测路径的数组副本 `STRICT_ONLY_ARGS` 里。
//   ③ 文档中英成对：两份 AGENTS 的命令表都得有这一行，且各自写明「只观测 / observation only」与
//      「非 strict 才是棘轮量的那个数」。为什么这条要写在这里：`docs-drift-check` 的 `paths` 规则
//      只校「文档引用的命令存在」，**没有**开发命令表的中英成对断言——实测只删掉中文那一行，
//      `check:docs --strict` 仍 exit 0（既存盲区，本单不修那道门禁，只给这一行补一道锁）。
//   ④ 「报告是当次运行的插值」的推导链（专门补 ① 的盲区）：`strict 实测：${strictTotal} …` 必须是
//      模板插值，`strictTotal` 必须由 `strictParsed.errors.length` 赋值，`strictParsed` 必须来自当次
//      `strictRun` 的 stdout+stderr，`strictRun` 必须是 `runTsc(STRICT_ONLY_ARGS)`；头部那对版本号也
//      钉到 `node_modules` 里的真值上。另堵两种常量形状：写死的 `strict 实测：<数字>` / `TS<码>×<数>`，
//      以及在打印报告之前就 `process.exit(0)`（把推导链变成死代码）。
//
// 口径边界（别把这一格读成比它更硬的东西）：
//   · **① 挡不住「整段 strict 报告被写成常量」**（评审变异 M3，实测：把报告换成一份自洽的常量，
//     ① 的两条形状判据和两个分布求和照样全绿）。它钉的是「strict 档确实是 strict 档、分布自洽」
//     这一层，**不是**「打印出来的数字逐字等于本次 stdout 解析出来的数字」。
//   · 那个更强的说法要在测试里再跑一次 tsc（~5 s，而且得在测试里再复制一份 tsc 参数清单，两边一漂
//     就变成新的谎言）——代价比收益大，所以本单选「收窄口径 + 补 ④ 这条零成本的推导链」，不选再跑一遍。
//   · strict 那个数**不是门禁、不钉、会漂**（随代码与树而变），所以这里只断言「大于基线」这类形状
//     判据，**不断言具体数字**，注释里也不拿它当常数引用。
//
// 口径：`--strict-report` 在干净树上 exit 0，所以这里**不**断言「它有错就红」；它只在脚本自己跑不成
// （tsc 缺失 / `.d.ts` 残留 / tsc 非 0 退出却零解析）时才非 0。tsc 是 devDependency，没装时这一格
// 跳过并点名原因（不假装通过）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RATCHET = path.join(ROOT, "scripts", "type-check-ratchet.mjs");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const tscMissing = existsSync(TSC)
  ? false
  : "typescript 未安装（devDependency，先 `npm install --include=dev`）：strict 观测点无法测量，跳过而不是假装通过";

test("#416 --strict-report 打的是真值：exit 0、总数严格大于棘轮基线、两个分布之和都等于总数", { skip: tscMissing }, () => {
  const run = spawnSync(process.execPath, [RATCHET, "--strict-report", "--verbose"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(
    run.status,
    0,
    `--strict-report 必须 exit 0（只观测、不判定），实际 ${run.status}：\n${run.stdout ?? ""}${run.stderr ?? ""}`,
  );
  const out = run.stdout ?? "";
  const head = out.match(/strict 实测：(\d+) 个错误 \/ (\d+) 个文件/);
  assert.ok(
    head,
    "输出里没有「strict 实测：N 个错误 / M 个文件」那一行——观测行被删或改了措辞（测试侧要同步）：\n"
    + out.slice(0, 800),
  );
  const total = Number(head[1]);
  const files = Number(head[2]);
  const baseline = Number(read("scripts/type-check-ratchet.mjs").match(/^const BASELINE_ROOT = (\d+);/m)?.[1]);
  assert.ok(Number.isFinite(baseline), "抽不到 `const BASELINE_ROOT = <数字>;`——棘轮常量被删或改了写法");
  assert.ok(
    total > baseline,
    `strict 总数 ${total} 不大于棘轮基线 ${baseline}：这条观测**没接上 --strict**（真接上就是同一棵树上比基线高一个量级的数；`
    + "只剩基线那个数说明 `--strict` 被删了，或者观测路径退化成棘轮那条路）",
  );
  assert.ok(files > 0, `strict 观测到的文件数是 ${files}——一个文件都没参与检查，观测在空跑`);

  // 分布完整性：两段都逐项加回去必须等于总数（截断/重复计数/少打印一类都会红）。
  const fileSection = out.split(/每文件[^\n]*：\n/)[1]?.split(/\n\s*每错误码/)[0] ?? "";
  const fileRows = [...fileSection.matchAll(/^\s+(\d+)\s+(\S+)$/gm)];
  assert.equal(fileRows.length, files, `按文件分布打了 ${fileRows.length} 行，但总数行说有 ${files} 个文件`);
  assert.equal(
    fileRows.reduce((acc, r) => acc + Number(r[1]), 0),
    total,
    "按文件分布之和 ≠ 总数——分布被截断或重复计数（--verbose 应当是完整分布）",
  );
  const codeSection = out.split(/每错误码[^\n]*：/)[1] ?? "";
  const codePairs = [...codeSection.matchAll(/TS(\d+)×(\d+)/g)];
  assert.ok(codePairs.length > 0, "按错误码分布一条都抽不到——分布被删或改了形状");
  assert.equal(
    codePairs.reduce((acc, p) => acc + Number(p[2]), 0),
    total,
    "按错误码分布之和 ≠ 总数——分布被截断或重复计数",
  );

  // 口径说明：CI 日志里这一行要自解释（两个入口 / 那一对 tsc 与 @types / 逐字复现命令 / 不判定）。
  // 版本号不写死：直接与 `node_modules` 里的真值比——常量报告会在这里漂掉。
  const depVersion = (rel) => JSON.parse(read(`node_modules/${rel}/package.json`)).version;
  for (const marker of [
    "入口：src/index.js",
    `typescript@${depVersion("typescript")}`,
    `@types/node@${depVersion("@types/node")}`,
    "复现：node node_modules/typescript/bin/tsc",
    "不判定",
  ]) {
    assert.ok(out.includes(marker), `输出里缺口径说明「${marker}」——CI 日志里这一行就不自解释了`);
  }
});

test("#416 观测行是当次 tsc 输出的插值，不是写死的常量（补 ① 的盲区：评审变异 M3）", () => {
  const src = read("scripts/type-check-ratchet.mjs");
  // 推导链，一环一环钉：打印的那一行 ← strictTotal ← strictParsed.errors.length ← parseTscErrors(strictRun 的 stdout+stderr)。
  // 「整段报告被写成常量」的变异会在这条链上断掉（打印行不再是插值，或者插的值不再来自当次解析）。
  const chain = [
    [
      /console\.log\(`strict 实测：\$\{strictTotal\} 个错误 \/ \$\{strictFiles\.length\} 个文件`\);/,
      "`strict 实测：` 那一行不再是 `${strictTotal}` / `${strictFiles.length}` 的模板插值——报告可能已经被写成常量",
    ],
    [
      /const strictTotal = strictParsed\.errors\.length;/,
      "`strictTotal` 不再由 `strictParsed.errors.length` 赋值——总数不是当次解析出来的",
    ],
    [
      /const strictParsed = parseTscErrors\(strictOutput\);/,
      "`strictParsed` 不再来自 `parseTscErrors(strictOutput)`——分布不是当次解析出来的",
    ],
    [
      /const strictOutput = `\$\{strictRun\.stdout \?\? ""\}\\n\$\{strictRun\.stderr \?\? ""\}`;/,
      "`strictOutput` 不再拼自 `strictRun.stdout` / `strictRun.stderr`——报告可能与本次 tsc 输出无关",
    ],
    [
      /const strictRun = runTsc\(STRICT_ONLY_ARGS\);/,
      "`strictRun` 不再是 `runTsc(STRICT_ONLY_ARGS)`——strict 观测可能根本没跑 tsc",
    ],
  ];
  for (const [re, why] of chain) assert.match(src, re, why);
  // 再堵两条最直白的偷懒形状（只在 strict 分支里查：棘轮那边的历史注释本来就带 `TS2339×180` 这类旧账）。
  const blockStart = src.indexOf("if (STRICT_REPORT) {");
  const blockEnd = src.indexOf("\nconst tscRun = runTsc([]);");
  assert.ok(blockStart >= 0 && blockEnd > blockStart, "抽不到 strict 分支的边界——推导链守卫已失效");
  const block = src.slice(blockStart, blockEnd);
  const reportLine = block.indexOf("strict 实测：${strictTotal}");
  assert.ok(reportLine > 0, "strict 分支里没有 `strict 实测：${strictTotal}` 那一行——报告行被删或改成常量");
  // ① 把数字直接写进报告行（`` `strict 实测：1690 …` `` / 写死的 `TS7006×879`）——常量报告必然含字面数字。
  assert.ok(
    !/strict 实测：\d/.test(block),
    "`strict 实测：` 后面跟的是字面数字——总数被写死了，不是当次 tsc 输出的插值",
  );
  assert.ok(
    !/TS\d+×\d+/.test(block),
    "strict 分支里出现了写死的 `TS<码>×<数>`——按错误码分布被写成常量了（真值只能来自 `${c}×${n}` 插值）",
  );
  // ② 提前退出：在打印报告之前就 `process.exit(0)`，把上面那条推导链变成死代码。
  assert.ok(
    !/process\.exit\(0\)/.test(block.slice(0, reportLine)),
    "strict 分支在打印报告之前就 exit 0 了——报告很可能是写死的常量（推导链变成了死代码）",
  );
});

test("#416 棘轮口径没被 strict 污染：TSC_ARGS 里没有 --strict，它只在观测路径的副本里", () => {
  const src = read("scripts/type-check-ratchet.mjs");
  const argsBlock = src.match(/const TSC_ARGS = \[([\s\S]*?)\];/);
  assert.ok(argsBlock, "抽不到 `const TSC_ARGS = [ ... ];`——棘轮口径被改写，本守卫会静默失效");
  assert.ok(
    !/--strict/.test(argsBlock[1]),
    "TSC_ARGS 里出现了 `--strict`：那会把 116/152 的棘轮判定直接变成 strict 口径（issue #416 红线：只加观测、不改判定）",
  );
  assert.match(
    src,
    /const STRICT_ONLY_ARGS = \["--strict"\];/,
    "观测路径的 `const STRICT_ONLY_ARGS = [\"--strict\"];` 不见了——strict 观测可能已经不在量 strict",
  );
  for (const name of ["BASELINE_ROOT", "BASELINE_WITH_TOOLS"]) {
    assert.match(
      src,
      new RegExp(`^const ${name} = \\d+;`, "m"),
      `棘轮基线常量 ${name} 被删或改了写法——「不改判定」这条红线在文本上已经搜不到了`,
    );
  }
});

test("#416 文档中英成对：两份 AGENTS 的命令表都有 check:types:strict 且都写明「只观测 / 非 strict 才是棘轮的数」", () => {
  const rows = {
    "AGENTS.md": { observation: /observation only/i, ratchetIsNonStrict: /ratchet number is the non-strict one/i },
    "AGENTS_cn.md": { observation: /只观测/, ratchetIsNonStrict: /棘轮量的那个数是「非 strict」/ },
  };
  for (const [rel, wants] of Object.entries(rows)) {
    const text = read(rel);
    const row = text.split("\n").find((line) => line.startsWith("| `npm run check:types:strict`"));
    assert.ok(row, `${rel} 的开发命令表里没有 \`npm run check:types:strict\` 那一行——中英成对义务要求两侧都写`);
    assert.match(row, wants.observation, `${rel} 那一行没写明「只观测、不判定」（实际：${row}）`);
    assert.match(
      row,
      wants.ratchetIsNonStrict,
      `${rel} 那一行没写明「非 strict 才是棘轮量的那个数」——漏了这句就会被读成「strict 也在卡门禁」`,
    );
  }
});
