// issue #689 的**发版日命令**测试：`scripts/release-day.mjs` 的整链路钉子。
//
// 分工（与 `test/host-consumer-probe.test.js` / `test/guide-removal-gate.test.js` 同一套惯例）：
//   - **反向证**（preflight 某步红就停在那一步并点名、闸门关着的真上游与不在的 `--hosts` 目录判「未判定」、
//     回写失败留下「已发布、未回写」的状态且重跑从 writeback 续、没回写就 finalize 必须红、两侧 ls-remote
//     不一致必须红、`--dry` 一个字节都不写、`--sync` 只动发布态那几句）都在
//     `node scripts/release-day.mjs --self-test` 里（合成树 + 假 runner，全离线）。这里只 spawn 它一次并断言
//     exit 0——本文件**不**重复那些判据（写两份只会让两边一起腐烂）。
//   - 本文件钉的是**命令行这一层**：参数闸、阶段顺序闸、以及「不该动盘的时候真的没动盘」。
//   - 卫生：状态文件一律指进 `test/helpers/tmp.js` 的 `makeTmp()`，绝不碰 `$RUNNER_TEMP` 里的真状态；
//     仓内源码全程只读（finalize 那条用例走的是「顺序闸先红」，所以连 `git tag` 都不会执行）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTmp } from "./helpers/tmp.js";
// issue #731 T7：中英 AGENTS 的手工清单要与**脚本自己的**步骤表对账，所以真值从脚本现读（不抄）。
import { PREFLIGHT_STEPS, preflightDocCommand, reconcilePreflightChecklist } from "../scripts/release-day.mjs";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));
const SCRIPT = fileURLToPath(new URL("../scripts/release-day.mjs", import.meta.url));

function runScript(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT, ...options });
}

test("--help：四个阶段与退出码都写清，exit 0", () => {
  const result = runScript(["--help"]);
  assert.equal(result.status, 0, `--help 必须 exit 0：\n${result.stdout}\n${result.stderr}`);
  for (const stage of ["preflight", "publish", "writeback", "finalize"]) {
    assert.match(result.stdout, new RegExp(`--stage ${stage}`, "u"), `--help 要点名 ${stage} 阶段`);
  }
  assert.match(result.stdout, /3 preflight 全绿、等你发布/u, "退出码 3 = 等人工发布，必须写清（否则会被读成失败）");
});

test("参数闸：什么都不给 ⇒ exit 2 并打用法（不是 0，也不是 1）", () => {
  const result = runScript([]);
  assert.equal(result.status, 2, `无参数必须 exit 2（参数不足 = 未判定）：\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /--stage|--all|--self-test/u, "要说清合法的入口");
});

test("顺序闸：没有 preflight 状态就直接 publish ⇒ 红，且不起任何子进程", async () => {
  const dir = await makeTmp("erix-release-day-test-");
  const stateFile = join(dir, "state.json");
  const result = runScript(["--stage", "publish", "--state", stateFile], {
    env: { ...process.env, RELEASE_DAY_STATE: stateFile },
  });
  assert.equal(result.status, 1, `没有 preflight 状态时 publish 必须红：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /顺序闸/u, "红的原因要点名顺序闸（不是含糊的「失败了」）");
  assert.match(result.stdout, /--stage preflight/u, "要说清先跑哪一步");
});

test("writeback 不给 --published ⇒ exit 2、不写状态文件、不跑 --sync", async () => {
  const dir = await makeTmp("erix-release-day-test-");
  const stateFile = join(dir, "state.json");
  const result = runScript(["--stage", "writeback", "--state", stateFile, "--version", "0.30.0"], {
    env: { ...process.env, RELEASE_DAY_STATE: stateFile },
  });
  assert.equal(result.status, 2, `缺 --published 必须 exit 2：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /--published/u, "要说清缺的是哪个真值");
  assert.equal(existsSync(stateFile), false, "真值缺位时不许留下状态文件（那会被 --all 当成「已发布」）");
});

test("顺序闸：没有「已发布 + 已回写」的状态就 finalize ⇒ 红（不许没发布就打 tag）", async () => {
  const dir = await makeTmp("erix-release-day-test-");
  const stateFile = join(dir, "state.json");
  const result = runScript(["--stage", "finalize", "--state", stateFile], {
    env: { ...process.env, RELEASE_DAY_STATE: stateFile },
  });
  assert.equal(result.status, 1, `没有状态文件时 finalize 必须红：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /顺序闸/u, "红的原因要点名顺序闸");
  assert.match(result.stdout, /phase=written/u, "要说清缺的是哪个相位");
  assert.equal(existsSync(stateFile), false, "finalize 红了不许写状态文件");
});

test("--self-test：离线反向证 exit 0", () => {
  const result = runScript(["--self-test"]);
  assert.equal(result.status, 0, `--self-test 必须绿：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /release-day --self-test: OK/u);
});

test("preflight 第 2 步（issue #715）：`[Unreleased]` 漏搬三态——红 exit 1 / 未判定 exit 2 / 绿 exit 0（真 CLI）", async () => {
  // 合成树：`npm run <script>` 全部替成 `node -e 0 --`（`--` 之后是 npm 追加的 `--hosts …`，不 `--` 的话
  // `node` 会把它当自己的选项而 exit 9）。第 2 步读的是 `package.json` + `CHANGELOG.md`，
  // 其余四步在合成树上没有意义；真值面只有第 2 步，其余门禁在 `--self-test` 里另有反向证）。
  const dir = await makeTmp("erix-release-day-715-");
  const tree = join(dir, "tree");
  mkdirSync(tree, { recursive: true });
  const scripts = {
    "check:changelog": "node -e 0 --",
    "check:release:real": "node -e 0 --",
    "check:release": "node -e 0 --",
    "check:host-consumers": "node -e 0 --",
  };
  writeFileSync(join(tree, "package.json"),
    `${JSON.stringify({ name: "erix-agent", version: "0.31.0", scripts }, null, 2)}\n`, "utf8");
  const heading = "## [0.31.0]（未发布 / unpublished）";
  const redChangelog = ["# Changelog", "", "## [Unreleased]", "",
    "- **A stranded entry nobody carried (issue #900).** It belongs in the 0.31.0 section.",
    "- 第二条停在 `[Unreleased]` 里的中文条目，用来验判词逐条点名。",
    "", heading, "", "### Breaking", "", "- older", ""].join("\n");
  const run = (changelog, extra = []) => {
    writeFileSync(join(tree, "CHANGELOG.md"), changelog, "utf8");
    return runScript(["--stage", "preflight", "--root", tree, "--state", join(dir, "state.json"), ...extra], {
      env: { ...process.env, ERIX_E2E_REAL: "1", RELEASE_DAY_STATE: join(dir, "state.json") },
    });
  };

  // ① 红：版本节已开（未发布形态）+ 条目还停在 `[Unreleased]`
  const red = run(redChangelog, ["--hosts", tree]);
  assert.equal(red.status, 1, `漏搬形态必须 exit 1：\n${red.stdout}\n${red.stderr}`);
  assert.match(red.stdout, /\[2\/5\][^\n]*\*\*红\*\*/u, "红要落在第 2 步上（不是第 1 步、也不是笼统一句失败）");
  assert.match(red.stdout, /2 条未入账条目停在/u, "判词要点名条数");
  assert.match(red.stdout, /4963293/u, "判词要自带可执行动作（4963293 的形状）");
  assert.match(red.stdout, /停在这一步/u, "红了就停，后面的前置不跑");

  // ② 未判定：本版还没有版本节（还没切版）⇒ exit 2，不是绿也不是红
  const notJudged = run(redChangelog.replace(`${heading}\n\n`, ""), ["--hosts", tree]);
  assert.equal(notJudged.status, 2, `还没切版必须 exit 2：\n${notJudged.stdout}\n${notJudged.stderr}`);
  assert.match(notJudged.stdout, /\[2\/5\][^\n]*\*\*未判定\*\*/u, "未判定要落在第 2 步上");
  assert.match(notJudged.stdout, /还没切版/u, "读数要说清「还没切版」");

  // ③ 绿：版本节已开 且 `[Unreleased]` 为空 ⇒ 整趟 preflight 全绿 exit 0
  const green = run(["# Changelog", "", "## [Unreleased]", "", heading, "", "- older", ""].join("\n"), ["--hosts", tree]);
  assert.equal(green.status, 0, `版本节已开 + \`[Unreleased]\` 空必须 exit 0：\n${green.stdout}\n${green.stderr}`);
  assert.match(green.stdout, /\[2\/5\][^\n]*→ 绿/u, "第 2 步要报绿");
});


/** 只替换**恰好一处**（同 `test/static-guards.test.js` 的 `replaceExactlyOnce` 口径：变异没落上就是白证）。 */
function replaceOnce(text, from, to, what) {
  const hits = text.split(from).length - 1;
  assert.equal(hits, 1, `夹具里 ${what} 应当恰好出现一次，实测 ${hits} 次：${JSON.stringify(from.slice(0, 40))}`);
  const out = text.split(from).join(to);
  assert.notEqual(out, text, `变异没落上：${what}`);
  return out;
}

test("AGENTS §4 的 preflight 清单与 PREFLIGHT_STEPS 逐格对账（中英两份都扫；issue #731 T7）", () => {
  // ── 正证：两份文档现读的文本，逐格等于脚本推出来的那一套 ──
  const texts = {};
  for (const doc of ["AGENTS.md", "AGENTS_cn.md"]) {
    const text = readFileSync(join(ROOT, doc), "utf8");
    texts[doc] = text;
    assert.deepEqual(reconcilePreflightChecklist(text, { doc }), [],
      `${doc} §4 的 [i/N] 清单与 PREFLIGHT_STEPS 对不上（真值 = scripts/release-day.mjs 现读，不抄）`);
  }
  // 正证的靶子不能是空的：面必须是 PREFLIGHT_STEPS 的全长（否则「对得上」可以是「两边都没扫到东西」）。
  assert.ok(PREFLIGHT_STEPS.length >= 5,
    `PREFLIGHT_STEPS 只剩 ${PREFLIGHT_STEPS.length} 步：这一格的对账面退化`);
  assert.deepEqual(PREFLIGHT_STEPS.map(preflightDocCommand).filter((c) => c === null), [],
    "有步骤既推不出命令列也没声明 docCommand ⇒ 清单对账对它空转（内联判据步骤必须显式声明）");

  /** 把步骤表写成清单正文（反向证里「文档已经跟上、只有脚本没声明」那种形态要用到）。 */
  const rowsToChecklistRows = (steps, total) => steps
    .map((step, i) => `#   [${i + 1}/${total}] ${preflightDocCommand(step)}                说明`)
    .join("\n");

  // ── 反向证：每格单独关一次 ⇒ 必须红（把文档里的数字改错 / 命令那侧变了而文档没跟上，两个方向都要咬） ──
  const cases = [
    {
      name: "分母抄错（[2/5] → [2/8]）",
      text: replaceOnce(texts["AGENTS.md"], "[2/5]", "[2/8]", "分母"),
      expect: /分母是 \/8/u,
    },
    {
      name: "文档少一行（删掉 [4/5] 那一行）",
      text: replaceOnce(texts["AGENTS.md"], "#   [4/5] check:release ", "#   [4/5] ~~", "第 4 行")
        .replace(/^#   \[4\/5\].*$/mu, ""),
      expect: /清单列了 4 步，而 PREFLIGHT_STEPS 有 5 步/u,
    },
    {
      name: "步骤改名（check:release → check:release-x）",
      text: replaceOnce(texts["AGENTS.md"], "[4/5] check:release ", "[4/5] check:release-x ", "第 4 步命令"),
      expect: /命令列是.*check:release-x.*要求.*check:release/u,
    },
    {
      name: "序号跳号（[3/5] → [9/5]）",
      text: replaceOnce(texts["AGENTS_cn.md"], "[3/5] ERIX_E2E_REAL=1 check:release:real", "[9/5] ERIX_E2E_REAL=1 check:release:real", "第 3 步序号"),
      expect: /按行序应为 \[3\//u,
    },
    {
      name: "命令那侧加了一步，文档没跟上（真值变了 ⇒ 两份文档都得红）",
      steps: [...PREFLIGHT_STEPS, { id: "new-gate", label: "check:new-gate", argv: ["npm", "run", "check:new-gate"] }],
      expect: /PREFLIGHT_STEPS 有 6 步/u,
    },
    {
      name: "新加的内联判据步骤忘了声明 docCommand（那一列无从推导）",
      // 文档那一侧**已经老老实实加了第 8 行**（分母也刷成 /8）——所以这一格不能靠「行数不对」红，
      // 必须红在「脚本没声明这一列该怎么推导」上。
      text: `${rowsToChecklistRows(PREFLIGHT_STEPS, 8)}\n#   [8/8] probe-no-doc                新加的内联判据`,
      steps: [...PREFLIGHT_STEPS, { id: "probe-no-doc", label: "某内联判据", probe: "x" }],
      expect: /既没有 argv 也没有 docCommand/u,
      bothDocs: false,
    },
    {
      name: "整段清单被删（对账失去对象 ⇒ 红，不是「没有差异」）",
      text: texts["AGENTS.md"].replace(/^#   \[\d\/\d+\].*$/gmu, ""),
      expect: /找不到任何/u,
    },
  ];
  for (const c of cases) {
    const docs = c.text ? ["AGENTS.md", "AGENTS_cn.md"] : ["AGENTS.md"];
    for (const doc of docs) {
      // 「命令那侧变了」这一格要**两份都红**；其余格只在被变异的那份上判红。
      if (!c.text && doc !== "AGENTS.md") continue;
      if (c.bothDocs === false && c.text && doc !== "AGENTS.md") continue;
      const mutated = c.text ?? texts[doc];
      const problems = reconcilePreflightChecklist(mutated, { doc, ...(c.steps ? { steps: c.steps } : {}) });
      assert.ok(problems.length > 0, `反向证「${c.name}」没红：${doc} 的问题清单是空的（这一格恒绿）`);
      assert.match(problems.join("\n"), c.expect,
        `反向证「${c.name}」红了，但红因不对（应当点名原因）：\n${problems.join("\n")}`);
    }
    if (c.steps && c.bothDocs !== false) {
      // 「命令那侧变了」：CN 那份也必须红（中英两份都要扫，不许只钉 EN）
      const cn = reconcilePreflightChecklist(texts["AGENTS_cn.md"], { doc: "AGENTS_cn.md", steps: c.steps });
      assert.match(cn.join("\n"), c.expect, `反向证「${c.name}」在 CN 那侧没红：${cn.join(" / ") || "（空）"}`);
    }
  }
});

test("npm script 与 CI 两处接线（指令面的措辞不再由测试钉住）", () => {
  // issue #802：原来还要求两份 AGENTS 的表格行里必须出现 `scripts/release-day.mjs` / `--stage` / `--sync`
  // 且不许出现「N 条判据」。那是措辞警察（文档一改写就红，抓不到行为）。承重的两处 wiring 留着：
  // npm script 真的指向这个脚本，CI 里真的有那一步阻塞自测。
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["release:day"], "node scripts/release-day.mjs", "npm script 必须指向这个脚本");
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /name: Release-day command self-test\n\s+run: node scripts\/release-day\.mjs --self-test/u,
    "CI 要有这一步阻塞自测（issue #689 的接线要求）");
});
