// 覆盖 scripts/type-check-ratchet.mjs 的 **strict 棘轮**（issue #417：把 #416 的观测点升级成门禁）。
//
// 为什么需要这一格：`--strict` 那一档在 #416 是「只观测、不判定」，于是它**天生**不会被任何门禁拦住——
// 观测接错了（忘了加 `--strict`、把报告写成常量）也照样 exit 0。本单把它改成棘轮，判定也进了退出码，
// 于是这里要钉两件事，缺一不可：
//   ① **接的是真值**：真跑一次 `--strict --verbose`，总数**严格大于**非 strict 棘轮的基线（同一棵树上真接上
//      `--strict`，总数就从三位数跳到四位数；没接上就只剩基线那个数），并且「按文件之和 = 按错误码之和 = 总数」。
//   ② **真的会红**（票面判据 ④ 的反向证，**基线相对**）：在一棵**临时树副本**里，往覆盖面已包含的文件塞
//      `max(1, 基线 − 实测 + 1)` 处**新**的 strict 错 ⇒ exit 1、输出里点名那个文件与「超出 N 个」（N =
//      注入后实测 − 基线），判据的目标是**注入后的实测总数严格大于基线**，不是「恰好基线 + 1」。
//      为什么注入处数必须由基线算：仓库规定的流程是「先降债、再单独一笔提交把基线常量调下来」，那个中间态里
//      实测本来就低于基线，写死 1 处注入根本跨不过基线 ⇒ 反向证会在一个完全合法的树上变红（issue #653）。
//      两个档（包根档与 `--with-tools` 档）共用同一个 helper，各跑一遍。
//      另有一条**证伪这条反向证自己**的用例：把副本里的基线临时抬高（模拟「实测低于基线」的中间态），
//      反向证仍必须红在「超出 1 个」——于是它不再依赖「当前树恰好贴基线」。
//      为什么在临时副本里做：
//      `npm test` **不许写 tracked 源码**（本仓只有 `check:mutation:run` 写），副本 = 拷 `scripts/` + `src/` +
//      `package.json` 再软链 `node_modules`，跑完即删（`makeTmp` 的 `after()` 清理）。
//   ③ **两档各自有基线**：包根入口与 `--with-tools` 并集各跑一次，输出里打印的基线必须等于脚本里对应的常量
//      （#214 的教训：两档分两次测就会悄悄漂开一格），且两档都在绿的一侧（实测 ≤ 基线）。
//   ④ **文档不再说「只观测」**：中英两份 AGENTS 的命令表都得写明它是棘轮、会阻塞，并且**都不许抄那两个数**
//      （本用例直接把常量里的数字串拿去 AGENTS 里搜——抄进去就红，这条是「不许把数字抄进指令面」的机器化）。
//   ⑤ **接线**：`package.json` 的 `check:types:strict` 传的是 `--strict`，CI 那一步没有 `continue-on-error`，
//      且**两档都有 CI 步骤**（包根档与 `--with-tools` 档）——没有那一步，工具档的基线常量漂了也看不见
//      （issue #653：`grep with-tools .github/workflows/ci.yml` 曾经一处都没有）。
//
// 口径边界（别把这一格读成比它更硬的东西）：
//   · 它**不**断言某个具体的 strict 总数（那个数随代码与树而变，钉死就是制造新的谎言）；它钉的是
//     「接的是真值 / 判定真的会红 / 两档各自有基线 / 文档与接线没退回只观测」这几层形状。
//   · 「红」的那一侧只在临时副本里验（每档各一次，外加抬高基线那一次的证伪），**不是**对真树的持续断言——
//     真树上新增错由门禁自己拦。
// tsc 是 devDependency，没装时这两格跳过并点名原因（不假装通过）；纯文本形状的几格不依赖 tsc，照跑。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTmp } from "./helpers/tmp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RATCHET_REL = "scripts/type-check-ratchet.mjs";
const RATCHET = path.join(ROOT, RATCHET_REL);
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const tscMissing = existsSync(TSC)
  ? false
  : "typescript 未安装（devDependency，先 `npm install --include=dev`）：strict 棘轮无法测量，跳过而不是假装通过";

/** 从脚本源码里抽一个 `const NAME = <数字>;` 常量（抽不到就红——常量被删或改了写法，本守卫会静默失效）。 */
function constant(name) {
  const m = read(RATCHET_REL).match(new RegExp(`^const ${name} = (\\d+);`, "m"));
  assert.ok(m, `抽不到 \`const ${name} = <数字>;\`——strict 棘轮的基线常量被删或改了写法`);
  return Number(m[1]);
}

/**
 * 跑一次棘轮脚本。
 *
 * @param {string[]} args 传给脚本的参数
 * @param {string} [cwd] 工作目录（临时副本里跑反向证时用）
 * @param {string} [script] 脚本路径（临时副本里用它自己那份副本）
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runRatchet(args, cwd = ROOT, script = RATCHET) {
  const run = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/** 从 `--strict --verbose` 的输出里抽「strict 实测：N 个错误 / M 个文件」那一行。 */
function strictHead(out) {
  const head = out.match(/strict 实测：(\d+) 个错误 \/ (\d+) 个文件/);
  assert.ok(head, `输出里没有「strict 实测：N 个错误 / M 个文件」那一行——报告行被删或改了措辞：\n${out.slice(0, 800)}`);
  return { total: Number(head[1]), files: Number(head[2]) };
}

/** 两个分布之和都必须等于总数（截断 / 重复计数 / 少打印一类都会红）。 */
function assertDistributionSums(out, total, files) {
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
}

/** 从 `--strict` 的红输出里抽「实测 N 个 strict 错误」里的 N（判定用的总数）。 */
function strictTotalOf(text) {
  const m = text.match(/实测 (\d+) 个 strict 错误/);
  assert.ok(m, `输出里没有「实测 N 个 strict 错误」——报告行被删或改了措辞：\n${text.slice(0, 800)}`);
  return Number(m[1]);
}

/**
 * 从**任意一份**棘轮脚本（含临时副本）里抽一个 `const NAME = <数字>;` 常量。
 * 反向证用的是副本自己那一份：副本里的基线可以被临时抬高，真树的常量则一字不动。
 *
 * @param {string} script 脚本绝对路径
 * @param {string} name 常量名
 * @returns {number}
 */
function constantIn(script, name) {
  const m = readFileSync(script, "utf8").match(new RegExp(`^const ${name} = (\\d+);`, "m"));
  assert.ok(m, `副本里抽不到 \`const ${name} = <数字>;\`——反向证用的基线常量被删或改了写法`);
  return Number(m[1]);
}

/**
 * 把**副本**里的基线常量改成 `value`（模拟「实测低于基线」的中间态；真树上的常量一字不动）。
 *
 * @param {string} script 脚本绝对路径
 * @param {string} name 常量名
 * @param {number} value 新值
 * @returns {void}
 */
function setConstantIn(script, name, value) {
  const src = readFileSync(script, "utf8");
  const re = new RegExp(`^const ${name} = \\d+;`, "m");
  assert.match(src, re, `副本里抽不到 \`const ${name} = <数字>;\`——反向证用的基线常量被删或改了写法`);
  writeFileSync(script, src.replace(re, `const ${name} = ${value};`));
}

/**
 * 造一棵棘轮能跑的临时树副本：脚本（ROOT 由它自己的位置推出）+ 依赖图（`src/`）+ `package.json`（版本自述），
 * `node_modules` 软链回真树（tsc 与 @types 是 devDependency，副本里没必要再装一份）。
 *
 * @param {string} prefix 临时目录前缀
 * @returns {Promise<{dir: string, script: string}>}
 */
async function makeRatchetTree(prefix) {
  const dir = await makeTmp(prefix);
  for (const rel of ["scripts", "src", "package.json"]) {
    cpSync(path.join(ROOT, rel), path.join(dir, rel), { recursive: true });
  }
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return { dir, script: path.join(dir, RATCHET_REL) };
}

/** 反向证注入的目标文件：由 `src/store/notes.js` 引进来、`// @ts-check` 在场、两个档的依赖图都覆盖它。 */
const VICTIM = "src/store/notes-memory.js";

/**
 * 生成 `count` 行「只在 `--strict` 下报错」的探针（隐式 any 参数 = TS7006）：每行**恰好**贡献 1 个 strict 错。
 * 名字带序号，免得两行重名把「+1」变成别的差额。
 *
 * @param {number} count 行数
 * @returns {string}
 */
function probeLines(count) {
  return `${Array.from({ length: count }, (_, i) => `const zzzStrictProbe${i + 1} = (x) => x;`).join("\n")}\n`;
}

/**
 * 反向证（**基线相对**，issue #653）：往覆盖面里的文件注入 `max(1, 基线 − 实测 + 1)` 处新 strict 错，
 * 断言**注入后的实测总数严格大于基线** ⇒ exit 1 且点名注入的文件与超出额；还原 ⇒ 回到注入前的总数。
 *
 * 注入处数由基线算而不是写死 1，是因为仓库规定的流程是「先降债、再单独一笔提交把基线常量调下来」——
 * 那个中间态里实测低于基线，写死 1 处注入跨不过基线，反向证就会在一个完全合法的树上变红。
 *
 * @param {{dir: string, script: string, args: string[], baselineName: string, tier: string}} opts
 *   副本、副本里的脚本、该档的参数、该档的基线常量名、用于报错的档名
 * @returns {{baseline: number, beforeTotal: number, injections: number, afterTotal: number}}
 */
function assertReverseProofBites({ dir, script, args, baselineName, tier }) {
  const baseline = constantIn(script, baselineName);
  const victimPath = path.join(dir, VICTIM);
  const original = readFileSync(victimPath, "utf8");

  const before = runRatchet([...args, "--print-count"], dir, script);
  assert.equal(before.status, 0, `${tier}：副本基线没跑绿（副本不干净，后面那条红就不可归因）：\n${before.stderr}`);
  const beforeTotal = Number(before.stdout.trim());
  assert.ok(Number.isFinite(beforeTotal), `${tier}：--print-count 打印的不是一个数：${JSON.stringify(before.stdout)}`);

  const injections = Math.max(1, baseline - beforeTotal + 1);
  writeFileSync(victimPath, original + probeLines(injections));

  const red = runRatchet(args, dir, script);
  assert.equal(red.status, 1, `${tier}：注入 ${injections} 处新 strict 错之后必须 exit 1，实际 ${red.status}：\n${red.stdout}${red.stderr}`);
  const afterTotal = strictTotalOf(red.stderr);
  // 判据的目标写成「严格大于基线」——不是「恰好基线 + 1」：注入处数由基线算，超出额随基线走。
  assert.ok(
    afterTotal > baseline,
    `${tier}：注入 ${injections} 处之后实测 ${afterTotal} 必须**严格大于**基线 ${baseline}（判据是「严格大于」，不是「恰好基线 + 1」）`,
  );
  assert.equal(afterTotal, beforeTotal + injections, `${tier}：注入 ${injections} 处应恰好加 ${injections} 个错（before ${beforeTotal} → after ${afterTotal}）`);
  assert.match(
    red.stderr,
    new RegExp(`超出 ${afterTotal - baseline} 个`),
    `${tier}：红的信息里没写「超出 ${afterTotal - baseline} 个」——判定没算差额：\n${red.stderr}`,
  );
  assert.ok(
    red.stderr.includes(VICTIM),
    `${tier}：红的信息里没点名注入的文件 ${VICTIM}（票面判据 ④ 要「点名」）：\n${red.stderr}`,
  );

  writeFileSync(victimPath, original);
  const green = runRatchet([...args, "--print-count"], dir, script);
  assert.equal(green.status, 0, `${tier}：还原之后必须回到绿，实际 ${green.status}：\n${green.stderr}`);
  assert.equal(Number(green.stdout.trim()), beforeTotal, `${tier}：还原之后的实测总数与注入前不一致——副本没被真的还原`);

  return { baseline, beforeTotal, injections, afterTotal };
}

test("#417 strict 棘轮打的是真值：exit 0、总数严格大于非 strict 基线、两个分布之和都等于总数", { skip: tscMissing }, () => {
  const run = runRatchet(["--strict", "--verbose"]);
  assert.equal(run.status, 0, `干净树上 --strict 必须 exit 0（等于或低于基线），实际 ${run.status}：\n${run.stderr}`);

  const out = run.stdout;
  const { total, files } = strictHead(out);
  const nonStrict = constant("BASELINE_ROOT");
  const baseline = constant("BASELINE_STRICT_ROOT");
  assert.ok(
    total > nonStrict,
    `strict 总数 ${total} 不大于非 strict 基线 ${nonStrict}：这条**没接上 --strict**（真接上就是同一棵树上高一个量级的数；`
    + "只剩基线那个数说明 `--strict` 被删了，或者 strict 分支退化成非 strict 那条路）",
  );
  assert.ok(files > 0, `strict 观测到的文件数是 ${files}——一个文件都没参与检查，判定在空跑`);
  assert.ok(
    total <= baseline,
    `实测 ${total} > 基线 ${baseline}，本用例要求干净树在绿的一侧（真超了就下调基线并单独提交，别把这条用例改成断言红）`,
  );

  // 头部口径：入口 / 那一对 tsc 与 @types / 逐字复现命令 / 打印的基线等于常量（常量报告会在这里漂掉）。
  const depVersion = (rel) => JSON.parse(read(`node_modules/${rel}/package.json`)).version;
  for (const marker of [
    "入口：src/index.js",
    `typescript@${depVersion("typescript")}`,
    `@types/node@${depVersion("@types/node")}`,
    "复现：node node_modules/typescript/bin/tsc",
    `基线：${baseline} 个 strict 错误`,
    "BASELINE_STRICT_ROOT",
    "参与退出码",
  ]) {
    assert.ok(out.includes(marker), `输出里缺口径说明「${marker}」——CI 日志里这一行就不自解释了`);
  }
  assertDistributionSums(out, total, files);
});

test("#417 两档各有基线：--with-tools 打的是 BASELINE_STRICT_WITH_TOOLS，且两档都在绿的一侧", { skip: tscMissing }, () => {
  const run = runRatchet(["--strict", "--with-tools", "--print-count"]);
  assert.equal(run.status, 0, `干净树上 --strict --with-tools 必须 exit 0，实际 ${run.status}：\n${run.stderr}`);
  const total = Number(run.stdout.trim());
  assert.ok(Number.isFinite(total), `--strict --with-tools --print-count 打印的不是一个数：${JSON.stringify(run.stdout)}`);
  const baseline = constant("BASELINE_STRICT_WITH_TOOLS");
  const rootBaseline = constant("BASELINE_STRICT_ROOT");
  assert.ok(
    total <= baseline,
    `并集档实测 ${total} > 基线 ${baseline}——两档要么一起降、要么都不动（#214 的教训：只降一档等于把差额推给另一档）`,
  );
  assert.ok(
    baseline > rootBaseline,
    `并集档基线 ${baseline} 不大于包根档 ${rootBaseline}：两个常量可能被抄串了（并集档的入口是包根档的超集）`,
  );
});

test("#417 反向证（基线相对）：两档各注入 max(1, 基线 − 实测 + 1) 处新 strict 错 ⇒ 红且点名；还原 ⇒ 绿", { skip: tscMissing }, async () => {
  // 两档各跑一遍，共用 `assertReverseProofBites`：只覆盖包根档的话，`--with-tools` 那一档的反向证
  // 从「两档必须同口径」里掉出去（issue #653 的另一半）。
  for (const [tier, args, baselineName] of [
    ["包根档", ["--strict"], "BASELINE_STRICT_ROOT"],
    ["--with-tools 档", ["--strict", "--with-tools"], "BASELINE_STRICT_WITH_TOOLS"],
  ]) {
    const { dir, script } = await makeRatchetTree("erix-strict-ratchet-");
    const result = assertReverseProofBites({ dir, script, args, baselineName, tier });
    // 注入处数**由基线算**：贴基线时是 1，实测低于基线时跟着变大（下面那条用例把这一点单独钉住）。
    assert.ok(
      result.injections >= 1,
      `${tier}：注入处数 ${result.injections} 必须是 max(1, 基线 − 实测 + 1) 的取值（≥ 1）`,
    );
  }
});

test("#653 反向证不靠「树恰好贴基线」：把副本基线临时抬高（实测低于基线的中间态）⇒ 注入处数跟着基线走、仍红在「超出 1 个」", { skip: tscMissing }, async () => {
  // 仓库规定的流程是「先降债、再单独一笔提交把基线常量调下来」——那个中间态里实测**低于**基线。
  // 写死「注入 1 处」的反向证在这种树上根本跨不过基线（注入后仍 ≤ 基线 ⇒ exit 0），于是流程在
  // `npm test` 层面不可执行。本用例把基线临时抬高来复现那个中间态：注入处数必须跟着基线走。
  const { dir, script } = await makeRatchetTree("erix-strict-ratchet-raised-");
  const actual = runRatchet(["--strict", "--print-count"], dir, script);
  assert.equal(actual.status, 0, `副本基线没跑绿：\n${actual.stderr}`);
  const actualTotal = Number(actual.stdout.trim());
  assert.ok(Number.isFinite(actualTotal), `--print-count 打印的不是一个数：${JSON.stringify(actual.stdout)}`);

  const raised = actualTotal + 3;
  setConstantIn(script, "BASELINE_STRICT_ROOT", raised);

  // 先自证这确实是「实测低于基线」的形态：干净副本照样绿，并打印「少 3 个」。
  const clean = runRatchet(["--strict"], dir, script);
  assert.equal(clean.status, 0, `实测低于基线时棘轮必须 exit 0（低于基线是绿 + 可下调提示），实际 ${clean.status}：\n${clean.stderr}`);
  assert.match(
    clean.stdout,
    /少 3 个/,
    `实测低于抬高的基线时没打印「少 3 个」——本用例没造出「实测低于基线」的形态：\n${clean.stdout}`,
  );

  const result = assertReverseProofBites({ dir, script, args: ["--strict"], baselineName: "BASELINE_STRICT_ROOT", tier: "抬高基线的包根档" });
  assert.equal(
    result.injections,
    4,
    `注入处数必须是 max(1, 基线 − 实测 + 1) = ${raised} − ${result.beforeTotal} + 1 = 4；写成写死的 1 处时这条就是 1`,
  );
  assert.equal(result.afterTotal - result.baseline, 1, "抬高基线之后仍应只超出 1 个（注入处数把差额补齐了）");
});

test("#417 判定链：报告行是当次 tsc 输出的插值，判定真的比 STRICT_BASELINE（不是「只打印」）", () => {
  const src = read(RATCHET_REL);
  // 推导链，一环一环钉：打印的那一行 ← strictTotal ← strictParsed.errors.length ← parseTscErrors(strictRun 的 stdout+stderr)。
  const chain = [
    [
      /console\.log\(`strict 实测：\$\{strictTotal\} 个错误 \/ \$\{strictFiles\.length\} 个文件`\);/,
      "`strict 实测：` 那一行不再是 `${strictTotal}` / `${strictFiles.length}` 的模板插值——报告可能已经被写成常量",
    ],
    [/const strictTotal = strictParsed\.errors\.length;/, "`strictTotal` 不再由 `strictParsed.errors.length` 赋值——总数不是当次解析出来的"],
    [/const strictParsed = parseTscErrors\(strictOutput\);/, "`strictParsed` 不再来自 `parseTscErrors(strictOutput)`——分布不是当次解析出来的"],
    [
      /const strictOutput = `\$\{strictRun\.stdout \?\? ""\}\\n\$\{strictRun\.stderr \?\? ""\}`;/,
      "`strictOutput` 不再拼自 `strictRun.stdout` / `strictRun.stderr`——报告可能与本次 tsc 输出无关",
    ],
    [/const strictRun = runTsc\(STRICT_ONLY_ARGS\);/, "`strictRun` 不再是 `runTsc(STRICT_ONLY_ARGS)`——strict 分支可能根本没跑 tsc"],
  ];
  for (const [re, why] of chain) assert.match(src, re, why);

  // 判定本身：必须出现「超过基线 ⇒ 非 0」那一步，且比的是 STRICT_BASELINE（退回「只观测」会在这条上断掉）。
  assert.match(
    src,
    /if \(strictTotal > STRICT_BASELINE\) \{[\s\S]*?process\.exit\(1\);/,
    "strict 分支里没有「超过基线 ⇒ exit 1」那一步——判定退回了 #416 的「只观测」",
  );
  assert.match(
    src,
    /const STRICT_BASELINE = WITH_TOOLS \? BASELINE_STRICT_WITH_TOOLS : BASELINE_STRICT_ROOT;/,
    "`STRICT_BASELINE` 不再是「按档选常量」——两档可能共用了一个数",
  );
  for (const name of ["BASELINE_STRICT_ROOT", "BASELINE_STRICT_WITH_TOOLS"]) {
    assert.match(src, new RegExp(`^const ${name} = \\d+;`, "m"), `strict 基线常量 ${name} 被删或改了写法——两档基线在文本上已经搜不到了`);
  }

  // 只在 strict 分支里查「报告写成常量」的两种偷懒形状（非 strict 那边的历史注释本来就带 `TS2339×180` 这类旧账）。
  const blockStart = src.indexOf("if (STRICT) {");
  const blockEnd = src.indexOf("\nconst tscRun = runTsc([]);");
  assert.ok(blockStart >= 0 && blockEnd > blockStart, "抽不到 strict 分支的边界——推导链守卫已失效");
  const block = src.slice(blockStart, blockEnd);
  assert.ok(!/strict 实测：\d/.test(block), "`strict 实测：` 后面跟的是字面数字——总数被写死了，不是当次 tsc 输出的插值");
  assert.ok(!/TS\d+×\d+/.test(block), "strict 分支里出现了写死的 `TS<码>×<数>`——按错误码分布被写成常量了");
});

test("#417 strict 没污染非 strict 棘轮：TSC_ARGS 里没有 --strict，它只在 STRICT_ONLY_ARGS 这个副本里", () => {
  const src = read(RATCHET_REL);
  const argsBlock = src.match(/const TSC_ARGS = \[([\s\S]*?)\];/);
  assert.ok(argsBlock, "抽不到 `const TSC_ARGS = [ ... ];`——棘轮口径被改写，本守卫会静默失效");
  assert.ok(
    !/--strict/.test(argsBlock[1]),
    "TSC_ARGS 里出现了 `--strict`：那会把非 strict 棘轮的判定直接换成 strict 口径（两条路必须各判各的）",
  );
  assert.match(src, /const STRICT_ONLY_ARGS = \["--strict"\];/, "`const STRICT_ONLY_ARGS = [\"--strict\"];` 不见了——strict 分支可能已经不在量 strict");
  for (const name of ["BASELINE_ROOT", "BASELINE_WITH_TOOLS"]) {
    assert.match(src, new RegExp(`^const ${name} = \\d+;`, "m"), `非 strict 棘轮基线常量 ${name} 被删或改了写法`);
  }
});

test("#417 文档中英成对：两份 AGENTS 都写明它是棘轮 / 会阻塞，且都没把那两个数抄进指令面", () => {
  const rows = {
    "AGENTS.md": { ratchet: /strict ratchet/i, blocks: /it blocks/i, notCopied: /do not copy them here/i },
    "AGENTS_cn.md": { ratchet: /strict 棘轮/, blocks: /阻塞门禁/, notCopied: /本文不抄/ },
  };
  for (const [rel, wants] of Object.entries(rows)) {
    const text = read(rel);
    const row = text.split("\n").find((line) => line.startsWith("| `npm run check:types:strict`"));
    assert.ok(row, `${rel} 的开发命令表里没有 \`npm run check:types:strict\` 那一行——中英成对义务要求两侧都写`);
    assert.match(row, wants.ratchet, `${rel} 那一行没写明它是**棘轮**（实际：${row}）`);
    assert.match(row, wants.blocks, `${rel} 那一行没写明它会**阻塞**——漏了这句就会被读成 #416 的「只观测」`);
    assert.match(row, wants.notCopied, `${rel} 那一行没写明「数字不许抄进本文」——下一个读者会把快照当现值`);
  }
  // 票面原话「别把具体数字抄进 AGENTS」的机器化：常量里的数字串在指令面上一处都不许出现。
  // （这条只咬 strict 的两个常量：非 strict 那对走的是 `BASELINE_ROOT = N` 的现场对账，另一套机制。）
  for (const name of ["BASELINE_STRICT_ROOT", "BASELINE_STRICT_WITH_TOOLS"]) {
    const value = String(constant(name));
    for (const rel of ["AGENTS.md", "AGENTS_cn.md"]) {
      assert.ok(
        !read(rel).includes(value),
        `${rel} 里出现了 strict 基线 ${name} 的现值（${value}）——指令面上不许抄这个数（check:agents-directives 的口径：数字正本住在脚本里）`,
      );
    }
  }
});

test("#417/#653 接线：`check:types:strict` 传的是 `--strict`，CI 那一步不带 continue-on-error，且**两档都有 CI 步骤**", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(
    pkg.scripts["check:types:strict"],
    "node scripts/type-check-ratchet.mjs --strict",
    "`check:types:strict` 没跑 `--strict`（退回 `--strict-report` 也行，但必须是判定那条路；这里钉住主名）",
  );
  const ci = read(".github/workflows/ci.yml");
  const at = ci.indexOf("run: npm run check:types:strict");
  assert.ok(at > 0, "CI 里没有跑 `npm run check:types:strict` 的那一步——棘轮没接线");
  const stepBlock = ci.slice(Math.max(0, at - 1200), at);
  assert.ok(
    !/continue-on-error/.test(stepBlock.split("- name:").pop() ?? ""),
    "CI 那一步仍带 `continue-on-error`——strict 棘轮又退回「红得对但不阻塞」",
  );

  // issue #653：两档都要有 CI 步骤。只跑包根档时，`BASELINE_WITH_TOOLS` 漂了没有任何闸能看见
  // （工单实测过的形态：`grep -c with-tools .github/workflows/ci.yml` 曾经是 0）。
  for (const [cmd, why] of [
    ["npm run check:types -- --with-tools", "非严档的工具档（`BASELINE_WITH_TOOLS`）没有 CI 闸"],
    ["npm run check:types:strict -- --with-tools", "strict 工具档（`BASELINE_STRICT_WITH_TOOLS`）没有 CI 闸"],
  ]) {
    assert.ok(ci.includes(`run: ${cmd}`), `CI 里没有跑 \`${cmd}\` 的那一步——${why}`);
  }
  // 顺序：工具档紧跟它自己那一档之后（基线与步骤必须挨着读，免得两档分家）。
  assert.ok(
    ci.indexOf("run: npm run check:types -- --with-tools") > ci.indexOf("run: npm run check:types\n"),
    "工具档那一步排在非严档之前——两档的顺序应当与非严档/严档一致",
  );
  assert.ok(
    ci.indexOf("run: npm run check:types:strict -- --with-tools") > at,
    "strict 工具档那一步排在 strict 档之前——两档的顺序应当与上面一致",
  );
});
