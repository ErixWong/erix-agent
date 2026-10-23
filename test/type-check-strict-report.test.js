// 覆盖 scripts/type-check-ratchet.mjs 的 **strict 观测点**（issue #416：`--strict-report` /
// `npm run check:types:strict`）。
//
// 为什么需要这一格（本单的「反向证」在测试侧的落点）：#416 的整个价值是「只观测、不判定」——
// 于是它**天生**不会被任何门禁拦住：观测接错了（比如忘了加 `--strict`、或干脆把 1690 写成常量）
// 也照样 exit 0、照样一片绿。这里用三条断言把「观测接的是真值」钉住：
//   ① 真跑一次 `--strict-report --verbose`：exit 0、总数**严格大于**棘轮基线（同一棵树上真接上
//      `--strict` 就是 1690 对 116 的量级差；没接上就只剩 116，这条立刻红），并且**按文件之和 =
//      按错误码之和 = 总数**（分布被截断/重复计数也红）。变异「把 `--strict` 从观测路径删掉」
//      会让它红，而不是静默变绿。
//   ② 结构性守卫：`TSC_ARGS` 里**不许**出现 `--strict`（那是棘轮口径，加进去等于把 116/152 的
//      判定直接换成 1690/1877），`--strict` 只许出现在观测路径的数组副本 `STRICT_ONLY_ARGS` 里。
//   ③ 文档中英成对：两份 AGENTS 的命令表都得有这一行，且各自写明「只观测 / observation only」与
//      「非 strict 才是棘轮量的那个数」。为什么这条要写在这里：`docs-drift-check` 的 `paths` 规则
//      只校「文档引用的命令存在」，**没有**开发命令表的中英成对断言——实测只删掉中文那一行，
//      `check:docs --strict` 仍 exit 0（既存盲区，本单不修那道门禁，只给这一行补一道锁）。
//
// 口径：`--strict-report` 的退出码恒为 0，所以这里**不**断言「它有错就红」；它只在脚本自己跑不成
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
    `strict 总数 ${total} 不大于棘轮基线 ${baseline}：这条观测**没接上 --strict**（真接上就是同一棵树上 1690 对 116 的量级差；`
    + "只剩 116 说明 `--strict` 被删了，或者观测已经把结果写成常量）",
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
  for (const marker of ["入口：src/index.js", "typescript@", "@types/node@", "复现：node node_modules/typescript/bin/tsc", "不判定"]) {
    assert.ok(out.includes(marker), `输出里缺口径说明「${marker}」——CI 日志里这一行就不自解释了`);
  }
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
