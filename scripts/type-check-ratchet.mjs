#!/usr/bin/env node
// type-check-ratchet.mjs — `--checkJs` 错误数**棘轮**门禁（issue #214；零运行时依赖，仅 node: 内置 + 相对路径）
//
// 干什么：
//   跑 `tsc --noEmit --allowJs --checkJs …src/index.js`，统计**错误总数**与**涉及文件数**，与下面写死的
//   基线常量比较，然后：
//     · 超过基线 → **exit 1**（新增的 `--checkJs` 错误被拦下，这就是本门禁唯一的存在理由）
//     · 等于基线 → exit 0
//     · 低于基线 → **仍 exit 0**，并打印「基线可下调至 N」提示（改基线是一次独立的人工动作，见下）
//   本单**不追求清零**（issue #214 的非目标），只把 200+ 个存量错误从「没人知道的债」变成「只减不增的棘轮」。
//
// 与 #213 的两个门禁的分工（别混）：
//   · `types:build` / `check:types-build` = 「**还能不能产出随包 `.d.ts`**」（tsc exit 0 + 公共符号在不在），
//     它跑的是 `--declaration --emitDeclarationOnly`、**不带 `--checkJs`**，对类型质量零评判。
//   · `check:types`（本脚本）= 「**存量 `--checkJs` 错误有没有变多**」。它不产出任何东西，也不要求 0 错。
//
// 为什么基线是脚本里的常量而不是 tsconfig：本仓**没有 tsconfig.json**（CLI 显式给出输入文件时 tsc 根本
//   不读 tsconfig，见 `scripts/build-types.mjs` 里同款实测注释），而且基线必须随代码走、每次改动都可 review。
//   为什么**只卡总数**不卡「涉及文件数」：文件数会随「顺手清了某个文件的错」而**下降**，那是好事；把文件数
//   也设成门禁会挡住我们想要的方向，所以它只作为**报告信息**打印。
//
// 读输出前必读的三条口径，否则会把「没检查」当成「干净」：
//   1. 只编 `src/index.js` **并不能**限制范围——tsc 会顺着 import 把整张依赖图拉进来（issue #214 正文与本地
//      实测都是这件事）。所以准入规则里的 `// @ts-check` 只是**声明这份文件愿意被检查**，真正的范围是 import 图。
//   2. ⚠ **反过来，`src/index.js` 也不是全部**：`erix-agent/tools` 那条公共入口有**两个文件不在包根的 import
//      图里**（`src/tools/file-tools.js`、`src/skills/loader.js`），它们的新错默认**卡不住**。见下面的
//      `--with-tools` 与 `BASELINE_WITH_TOOLS`（实测两入口并集 = 261 个 / 31 文件，比单入口多 43 个）。
//   3. ⚠ **`src/**/*.d.ts` 生成物在场时，本检查会静默变成空跑**（实测，见下面的「陈旧声明守卫」）：#213 的
//      `types:build` 把声明**生成到 `src/` 里**，而 tsc 解析 `./x.js` 时**优先命中同目录的 `x.d.ts`**，于是
//      被检查的是声明而不是实现——60 个 `.d.ts` 在场时同一条命令报 **0 个错**（`--skipLibCheck` 跳过声明文件），
//      去掉 `--skipLibCheck` 则报 **87 个错且全部落在 `.d.ts` 上**。两个都不是我们要量的数，而
//      「0 < 基线」在这里是**假绿**，所以守卫直接变红而不是放行。
//   · 另：未装 `@types/node` 时错误数会**变多**（`TS2580`/`TS2307` 一类「缺 node 类型」），不是变干净；本门禁
//     **必须在装了 devDependencies 的环境里跑**（`tsc` 取不到时下面直接给指路报错，不堆栈）。
//
// 用法：
//   npm run check:types                       # 默认：包根入口 src/index.js，基线 217
//   npm run check:types -- --with-tools       # 连 erix-agent/tools 入口一起卡，基线 261
//   node scripts/type-check-ratchet.mjs --verbose                   # 额外打印每文件、每错误码分布
//   node scripts/type-check-ratchet.mjs --show-errors 20            # 额外打印前 20 条错误定位（定位新错用）
//   node scripts/type-check-ratchet.mjs --baseline                  # 只打印基线常量与复现命令
//   node scripts/type-check-ratchet.mjs --print-count               # 只打印实测错误总数（脚本化下调基线用）
//   node scripts/type-check-ratchet.mjs --ignore-stale-declarations # 明知 src/ 下有 .d.ts 生成物仍强行跑

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

// ── 基线（棘轮的「只减不增」就钉在这两个数上）────────────────────────────────────
// 来源：issue #214（`--checkJs` 棘轮）。
// 实测日期：2026-10-10。首次实测在基点 `836aaa2`（#213 的 JSDoc 修复已在树上）；rebase 到 `origin/main` = `f6a8392`
// 之后**复测过**（#224/#225 只新增测试、`src/` 零改动）：同一条命令的输出与旧树 `diff` **逐字相同**，仍是 218 / 29。
// 实测环境：`typescript@5.9.3` + `@types/node@22.20.5`（都是 devDependency）、Node 22、Linux。
// 复现命令（逐字，在仓库根目录）：
//   node node_modules/typescript/bin/tsc --noEmit --allowJs --checkJs --target es2023 \
//     --module nodenext --moduleResolution nodenext --skipLibCheck src/index.js
// 实测：**218 个错 / 29 个文件**。分布 181×TS2339、14×TS2353、7×TS2345、5×TS2741、3×TS2322、2×TS2554、
//   2×TS2698、2×TS2739、1×TS2538、1×TS2722。最集中：src/providers/openai.js 46、src/providers/anthropic.js 45、
//   src/store/notes.js 27、src/loop/orchestrator.js 18、src/run-state.js 10。
// 其中**宿主可见公共面**（从 `src/index.d.ts` / `src/tools/index.d.ts` 沿类型引用可达的 40 个文件，
//   与「从两个入口沿 `export … from` 可达」的集合大小一致）里落了 **190 / 218 个**；余下 28 个在 9 个
//   纯实现内部文件里（`run-snapshot-executor` 8、`compact/pipeline` 5、`error-ledger` 3、`providers/timeout` 3、
//   `provider-runner` 2、`tool-result-ttl` 2、`http-shared` 2、`payload` 2、`termination` 1）——宿主点不到名，
//   还债优先级排在 190 那批之后。
// ⚠ **为什么不是抄 issue 正文里的 226**：226 已在本仓复现过——把 #213 之前的树（`bc3ad02`）用
//   `git archive bc3ad02 | tar -x -C <空目录>` 取出来（不动工作树），同一对 tsc/@types 跑同一条命令 =
//   **226 个 / 29 个文件**，与 issue 逐字一致；#213 的 JSDoc 修复把它带到 **218**（`orchestrator` 21→18、
//   3×TS1131 与 TS8024/TS1003 消失、TS2739 1→2）。所以下面的数是**当前树**的实测值，不是抄来的。
// 下调基线的规矩：把常量改成 `npm run check:types` 打印的「可下调至 N」，**单独一次提交**，提交信息里带上
//   是哪个文件减了多少错——棘轮的全部价值在「这个数只会变小」，别把它当噪声随手调回去。
// 下调记录：**218 → 217**（issue #177 刀 1，2026-10-10）——`src/loop/orchestrator.js` **18 → 17**（减 1）：
//   选项规范化外提后给 `resumeRunSnapshot` 补了一行 `@type`（纯注释），消除一处
//   `Property 'round' does not exist on type 'never'`（TS2339）——那个变量的值只经 setter 由
//   `restoreResume` 赋值，控制流分析看不见。新增的 `src/loop/option-normalization.js`（首行 `// @ts-check`）
//   自身贡献 **0** 个错。`--with-tools` 一档的 261 未重测，故不动。
const BASELINE_ROOT = 217;

// `--with-tools` 的基线：把第二个公共入口 `src/tools/index.js` 也喂给 tsc 后的并集。
// 复现命令（逐字）：
//   node node_modules/typescript/bin/tsc --noEmit --allowJs --checkJs --target es2023 \
//     --module nodenext --moduleResolution nodenext --skipLibCheck src/index.js src/tools/index.js
// 实测：**261 个错 / 31 个文件** = 单入口的 218 个，加上只有 `./tools` 才拉进来的
//   `src/tools/file-tools.js` 27 个与 `src/skills/loader.js` 16 个（两个都是宿主直接可见的导出实现，
//   `createFileTools` / `discoverSkills` 那一族）。为什么默认不带它：#214 正文给的口径就是 `src/index.js`，
//   默认值必须与规格逐字一致；但它**是**真实盲区，所以这里留一条可随时收紧的通道（收紧=把默认入口加上并
//   把基线换成 261，属 #214 之后的收紧动作，不要拿它当「反正卡不住」的理由）。
const BASELINE_WITH_TOOLS = 261;

const argv = process.argv.slice(2);
const WITH_TOOLS = argv.includes("--with-tools");
const VERBOSE = argv.includes("--verbose");
const PRINT_ONLY = argv.includes("--print-count");
const IGNORE_STALE = argv.includes("--ignore-stale-declarations");
const SHOW_ERRORS = (() => {
  const i = argv.indexOf("--show-errors");
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : 0;
})();

// 与 issue #214 正文口径逐字一致的 tsc 参数（输入文件是唯一的入口；依赖图由它自己拉）。
const ENTRIES = WITH_TOOLS ? ["src/index.js", "src/tools/index.js"] : ["src/index.js"];
const BASELINE = WITH_TOOLS ? BASELINE_WITH_TOOLS : BASELINE_ROOT;
const TSC_ARGS = [
  "--noEmit",
  "--allowJs",
  "--checkJs",
  "--target",
  "es2023",
  "--module",
  "nodenext",
  "--moduleResolution",
  "nodenext",
  "--skipLibCheck",
  ...ENTRIES,
];
const MODE = WITH_TOOLS ? "含 ./tools 入口" : "包根入口";

if (argv.includes("--baseline")) {
  console.log(
    `check:types: 基线 = ${BASELINE} 个 --checkJs 错误（${MODE}；issue #214，2026-10-10 实测）\n`
    + `  两档基线：包根入口 ${BASELINE_ROOT}（默认）/ 含 ./tools 入口 ${BASELINE_WITH_TOOLS}（加 --with-tools）\n`
    + `  复现命令：node node_modules/typescript/bin/tsc ${TSC_ARGS.join(" ")}`,
  );
  process.exit(0);
}

function resolveTsc() {
  const candidates = [
    path.join(ROOT, "node_modules", "typescript", "bin", "tsc"),
    path.join(ROOT, "node_modules", "typescript", "tsc.js"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const tscPath = resolveTsc();
if (!tscPath) {
  // 清晰报错而不是堆栈：tsc 是 devDependency，没装（或 npm 跳过了 dev 安装）是这个门禁最常见的红法。
  // 口径与 scripts/build-types.mjs 一致（#213 实测：`NODE_ENV=production` 时 `npm install` 会静默跳过 devDependencies）。
  console.error(
    "check:types: 找不到 TypeScript 编译器（tsc），无法跑 --checkJs 棘轮。\n"
    + "  tsc 是 devDependency（运行时零依赖红线只约束 import，dev 工具链不进包，见 issue #213），\n"
    + "  先在本仓库根目录装依赖再重跑：\n"
    + `    ${npmCommand} install --include=dev\n`
    + "  ⚠ 环境里 `NODE_ENV=production` 时 `npm install` 会**默认跳过 devDependencies**（实测 npm 10.9.8：\n"
    + "    `npm install` 报「up to date, audited 1 package」而 tsc 并不存在），必须显式 `--include=dev`。\n"
    + `  期望路径：${path.join(ROOT, "node_modules", "typescript", "bin", "tsc")}`,
  );
  process.exit(1);
}

// ── 陈旧声明守卫：`src/**/*.d.ts` 在场时 `--checkJs` 量的不是实现 ──────────────────
// 仓库**提交了 0 个** `.d.ts`（`git ls-files '*.d.ts'` 为空），且 `.gitignore` 写了 `src/**/*.d.ts`，
// 所以在场的一定是 #213 生成器（`types:build` / `prepack`）的产物，不是人写的类型 —— 可以直接判定并清掉。
function declarationScan(dir, acc = { n: 0, sample: [] }) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) declarationScan(abs, acc);
    else if (name.endsWith(".d.ts")) {
      acc.n += 1;
      if (acc.sample.length < 3) acc.sample.push(path.relative(ROOT, abs).replaceAll("\\", "/"));
    }
  }
  return acc;
}

const stale = declarationScan(path.join(ROOT, "src"));
if (stale.n > 0) {
  const msg =
    `发现 src/ 下有 ${stale.n} 个 .d.ts 生成物（例：${stale.sample.join("、")}）——它们是 #213 的 `
    + "`types:build`/`prepack` 产物（仓库提交了 0 个 `.d.ts`，所以存在即可判定为生成物）。\n"
    + "  它们会让本门禁**静默量错东西**：tsc 解析 `./x.js` 时优先命中同目录的 `x.d.ts`，于是被检查的是声明而不是实现。\n"
    + "  实测（2026-10-10，同一棵工作树、同一条命令）：`.d.ts` 不在场 = **218 个错**；60 个 `.d.ts` 在场 = **0 个错**\n"
    + "    （`--skipLibCheck` 直接跳过声明文件）；再把 `--skipLibCheck` 去掉 = **87 个错且全落在 `.d.ts` 上**。\n"
    + "    三种读法里只有第一种是要卡的数，「0 个错」是**假绿**。\n"
    + "  清掉再生成（生成物不入库、随时可重建）：`find src -name '*.d.ts' -delete`\n"
    + "    （PowerShell：`Get-ChildItem src -Recurse -Filter *.d.ts | Remove-Item`）\n"
    + "  确需带着生成物跑（例如刚 `npm pack` 完的目录）：加 `--ignore-stale-declarations`，但那样的数字**不能**用来下调基线。";
  if (!IGNORE_STALE) {
    console.error(`check:types: 失败 — ${msg}`);
    process.exit(1);
  }
  console.error(`check:types: ⚠ ${msg}\n  （--ignore-stale-declarations 生效：继续跑）`);
}

const tscRun = spawnSync(process.execPath, [tscPath, ...TSC_ARGS], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (tscRun.error) {
  console.error(`check:types: 启动 tsc 失败：${tscRun.error.message}`);
  process.exit(1);
}

const tscOutput = `${tscRun.stdout ?? ""}\n${tscRun.stderr ?? ""}`;

// 一行错误的形状固定：`<file>(<line>,<col>): error TS<code>: <message>`。
// 只有这一行**算一个错误**；缩进的续行（`  Type '…' is not assignable to …`）是同一条错误的说明，不能重复计数。
const ERROR_LINE = /^(?<file>[^\r\n]+?)\((?<line>\d+),(?<col>\d+)\): error TS(?<code>\d+): (?<msg>.*)$/;
const seen = new Set();
const errors = [];
const unparsed = [];
for (const rawLine of tscOutput.split(/\r?\n/)) {
  const line = rawLine.trimEnd();
  if (!line.trim()) continue;
  const m = ERROR_LINE.exec(line);
  if (!m) {
    // tsc 的自由文本（版本横幅、`Found N errors…` 汇总）留作「一条都没解析出来」时的兜底证据
    if (/error TS\d+:/.test(line)) unparsed.push(line.trim());
    continue;
  }
  const rel = m.groups.file.replaceAll("\\", "/").replace(/^\.\//, "");
  const key = `${rel}:${m.groups.line}:${m.groups.col}:${m.groups.code}`;
  if (seen.has(key)) continue; // stdout/stderr 交错时同一条错误可能重复出现
  seen.add(key);
  errors.push({ file: rel, line: Number(m.groups.line), col: Number(m.groups.col), code: m.groups.code, msg: m.groups.msg });
}

// ⚠ 「没解析到错误」+「tsc 非 0 退出」= 跑都没跑成（参数写错、缺 lib、tsc 自己崩了），
//   此时「0 个错 < 基线」是假的干净，必须变红。
if (errors.length === 0 && tscRun.status !== 0) {
  console.error(
    `check:types: 失败 — tsc 退出码 ${tscRun.status}，但没解析到任何 \`error TS…\` 行（不是「0 个类型错误」，是跑都没跑成）。\n`
    + `  tsc 命令：${process.execPath} ${[tscPath, ...TSC_ARGS].join(" ")}\n`
    + "  tsc 原始输出（末尾 40 行）：\n"
    + tscOutput.trimEnd().split(/\r?\n/).slice(-40).map((l) => `    ${l}`).join("\n"),
  );
  process.exit(1);
}
// ⚠ 「0 个错」而基线 > 0 时同样按**检查面失效**处理：从 218 一步清零不是这一轮会发生的事，
//   而它更可能是「什么都没被检查」（入口没了、`src/` 被清、生成物遮蔽）。真要清零了就显式把基线改成 0，
//   这条守卫会随基线归零自动解除。
if (errors.length === 0 && BASELINE > 0) {
  console.error(
    `check:types: 失败 — 实测 0 个 --checkJs 错误，但基线是 ${BASELINE}：一步清零几乎不可能，`
    + "先怀疑**检查面失效**而不是「债还完了」。\n"
    + "  依次排查：① `src/` 下是否残留 `.d.ts` 生成物（本脚本上面的守卫会先拦，用 `--ignore-stale-declarations` 绕过时会留警告）；\n"
    + "  ② 入口文件是否还在（当前入口：" + ENTRIES.join(", ") + "）；③ tsc 是否被别的工具包了一层、输出形状变了（看下面的告警）。\n"
    + "  确认真的清零了：把本脚本的基线常量改成 0（那时这条守卫自动解除）。",
  );
  process.exit(1);
}
if (unparsed.length) {
  // 形状变了就喊出来：正则失配等于棘轮静默失去检查面（与 `docs-drift-check` 的「检查面失效本身就是漂移」同口径）
  console.error(
    `check:types: ⚠ 有 ${unparsed.length} 行含 \`error TS…\` 但没匹配预期的定位形状，`
    + `它们**没有计入基线比较**（tsc 输出格式变了？请同步本脚本的 ERROR_LINE）：\n`
    + unparsed.slice(0, 10).map((l) => `    ${l}`).join("\n"),
  );
}

const total = errors.length;
const byFile = new Map();
const byCode = new Map();
for (const e of errors) {
  byFile.set(e.file, (byFile.get(e.file) ?? 0) + 1);
  byCode.set(e.code, (byCode.get(e.code) ?? 0) + 1);
}
const files = [...byFile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const codes = [...byCode.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

if (PRINT_ONLY) {
  console.log(String(total));
  process.exit(0);
}

const summary = `${total} 个 --checkJs 错误 / ${files.length} 个文件`;
const detail = () =>
  `\n  每文件：\n${files.map(([f, n]) => `    ${String(n).padStart(4)}  ${f}`).join("\n")}`
  + `\n  每错误码：${codes.map(([c, n]) => `TS${c}×${n}`).join("、")}`;

if (VERBOSE) console.log(`check:types: 实测 ${summary}（${MODE}）${detail()}`);
if (SHOW_ERRORS > 0) {
  console.log(errors.slice(0, SHOW_ERRORS).map((e) => `  ${e.file}(${e.line},${e.col}): TS${e.code}: ${e.msg}`).join("\n"));
}

if (total > BASELINE) {
  // 棘轮变红：存量错误变多了。给「多在哪」而不是只喊数字。
  const top = files.slice(0, 5).map(([f, n]) => `${f} ${n}`).join("、");
  console.error(
    `check:types: 失败 — 实测 ${summary}${detail()}\n`
    + `  基线 ${BASELINE}（issue #214，2026-10-10 实测，${MODE}），**超出 ${total - BASELINE} 个**。\n`
    + `  最多的文件：${top}\n`
    + "  怎么修：\n"
    + "    · 定位新错：`node scripts/type-check-ratchet.mjs --show-errors 40`；或改动前后各跑一次 `--verbose` 对比每文件计数；\n"
    + "    · 首选**减掉它**（补 JSDoc 类型；#213 R4 记录过两种会**静默**把参数退化成 `any` 的 JSDoc 形状）；\n"
    + "    · **不要**为了变绿去调高基线常量，除非这批新增确属「已知债 + 本轮不打算还」并在评审里点名——"
    + `确需上调时把 ${BASELINE} 改成 ${total}，并在提交信息里写清是谁的哪批改动、为什么本轮不还。`,
  );
  process.exit(1);
}

if (total < BASELINE) {
  console.log(
    `check:types: OK — 实测 ${summary}（${MODE}），比基线 ${BASELINE} **少 ${BASELINE - total} 个**。\n`
    + `  基线可下调至 ${total}：改 scripts/type-check-ratchet.mjs 的常量并单独提交（棘轮只减不增，别把这次收益丢掉）。`,
  );
  process.exit(0);
}

console.log(`check:types: OK — 实测 ${summary}（${MODE}），等于基线 ${BASELINE}（issue #214 棘轮：只减不增）。`);
