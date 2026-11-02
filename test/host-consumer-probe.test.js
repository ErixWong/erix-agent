// issue #429 的**宿主侧半边**测试：`scripts/host-consumer-probe.mjs` 的钉子。
//
// 分工（与 `test/export-consumer-check.test.js` 同一套惯例）：
//   - **反向证**（多行 import 行号、子路径 / 再导出、六种解析不出名字的形状、注释与字符串涂白、
//     require 解构取属性名、求交两态、目录不存在 / 不是目录的分类原因、以及覆盖判据的三态：命中但指南无
//     条目 ⇒ 红 / 补上条目 ⇒ 绿 / 删掉条目 ⇒ 又红 / 条款格空 ⇒ 仍红 / 指南表读不出 ⇒ 分类原因）都在
//     `node scripts/host-consumer-probe.mjs --self-test` 里。这里只 spawn 它一次并断言 exit 0——
//     本文件**不**重复那些判据（写两份只会让两边一起腐烂）。
//   - 本文件钉的是「真树 + 真宿主目录」这一层的**整链路行为**：读盘 → 现算候选 → 求交 → 点名 → 退出码，
//     以及「没给宿主目录 / 给了不存在的目录 ⇒ 未判定但 exit 0」这条 CI 形态（探针不得变成 CI 对宿主仓的
//     硬依赖）。
//   - 卫生：临时宿主目录一律走 `test/helpers/tmp.js` 的 `makeTmp()`；仓内源码全程只读。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTmp } from "./helpers/tmp.js";
import { currentCandidates } from "../scripts/host-consumer-probe.mjs";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));
const SCRIPT = fileURLToPath(new URL("../scripts/host-consumer-probe.mjs", import.meta.url));

function runScript(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT, ...options });
}

/** 在临时目录里铺一个「宿主仓」：`package.json`（不是本包）+ 一个导入 erix-agent 的文件。 */
async function hostRepo(files, { name = "mini-host", prefix = "erix-host-probe-" } = {}) {
  const root = await makeTmp(prefix);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, type: "module" }));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

test("真宿主目录：命中一个「指南已覆盖」的名字 ⇒ exit 0，并把它列为「已知会被破坏的宿主引用」", async () => {
  const host = await hostRepo({
    "src/adapter.js": [
      'import { createAnthropicProvider, runToolLoop } from "erix-agent";',
      'import { notesStoreContract } from "erix-agent/contract-tests";',
      "",
    ].join("\n"),
  });
  const result = runScript(["--hosts", host]);
  assert.equal(result.status, 0, `命中被指南覆盖时是绿（覆盖判据，不是否决）：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /## 命中（1 处）—— 全部已被 .* 指南覆盖：绿/u, "报告要有「已覆盖」小节");
  assert.match(
    result.stdout,
    new RegExp(`\`createAnthropicProvider\` @ 宿主仓 \`mini-host\` — \`${host}/src/adapter\\.js:1\``, "u"),
    `命中要逐条点名宿主仓 / 文件:行 / 名字：\n${result.stdout}`,
  );
  assert.match(result.stdout, /登记删除版本 0\.30/u, "点名时要带登记的删除版本（宿主据此判断影响面）");
  assert.match(
    result.stdout,
    /↳ 指南条目：`docs\/host-upgrade-guide-0\.30\.0\.md:\d+`[\s\S]*↳ 指南条目：`docs\/host-upgrade-guide-0\.30\.0_cn\.md:\d+`/u,
    `每个命中都要带出中英两份指南的条目行（迁移写法的出处）：\n${result.stdout}`,
  );
  // 宿主契约套件这一类**不进候选**（消费者按定义在宿主仓，仓内零命中是天然的）⇒ 宿主导入它不是删除命中。
  assert.ok(!/`notesStoreContract` @ 宿主仓/u.test(result.stdout), "宿主契约套件不参与删除判据，不得进命中表");
  // 非候选名字（`runToolLoop` 有仓内消费者）不得被点名
  assert.ok(!/`runToolLoop` @ 宿主仓/u.test(result.stdout), "非候选名字不该进命中表");
});

test("真树 × 全候选：每一个零消费者候选都在指南里有一行（覆盖判据在真树上成立）", async () => {
  const { candidates } = currentCandidates();
  assert.ok(candidates.length > 0, "现算候选集为空时这条用例失去意义（先看 check:exports 是不是坏了）");
  const names = candidates.map((row) => row.name);
  const host = await hostRepo({
    "src/all-candidates.js": `import { ${names.join(", ")} } from "erix-agent";\n`,
  });
  const result = runScript(["--hosts", host]);
  assert.equal(result.status, 0, `全部候选都该被指南覆盖：\n${result.stdout}${result.stderr}`);
  for (const name of names) {
    assert.match(result.stdout, new RegExp(`\`${name}\` @ 宿主仓 \`mini-host\``, "u"),
      `候选 \`${name}\` 没被点名（命中表漏了它）：\n${result.stdout}`);
  }
  const guideRows = result.stdout.match(/↳ 指南条目：/gu) ?? [];
  assert.equal(guideRows.length, names.length * 2, `每个名字要带中英两条指南条目（实得 ${guideRows.length} 条）`);
});

test("真宿主目录：只导入有消费者的名字 ⇒ exit 0（绿，且不误报）", async () => {
  const host = await hostRepo({
    "src/only-consumed.js": 'import { runToolLoop, createOpenAIProvider } from "erix-agent";\n',
  });
  const result = runScript(["--hosts", host]);
  assert.equal(result.status, 0, `没有命中就该 exit 0：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /## 命中：0 处/u);
  assert.match(result.stdout, /结论：绿/u);
});

test("没给 --hosts ⇒ 未判定但 exit 0（CI 上没有宿主仓检出，探针不得成为硬依赖）", () => {
  const result = runScript([]);
  assert.equal(result.status, 0, `不给宿主目录必须 exit 0：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /未判定/u, "「没给目录」要写成未判定，不许写成绿");
  assert.match(result.stdout, /--hosts/u, "报告要给出怎么判定（复现命令）");
});

test("宿主目录不存在 / 是文件 ⇒ exit 0 + 分类原因（不是静默绿，也不是红）", async () => {
  const missing = runScript(["--hosts", join(ROOT, "no-such-host-dir-429")]);
  assert.equal(missing.status, 0, `目录不存在必须 exit 0：\n${missing.stdout}${missing.stderr}`);
  assert.match(missing.stdout, /\[HOST_DIR_MISSING\]/u, "要打分类原因，不许静默绿");

  const notDir = runScript(["--hosts", join(ROOT, "package.json")]);
  assert.equal(notDir.status, 0, `给的路径是文件必须 exit 0：\n${notDir.stdout}${notDir.stderr}`);
  assert.match(notDir.stdout, /\[HOST_DIR_NOT_DIR\]/u, "要区分「不存在」与「不是目录」");
});

test("--json：同一份事实可机器读（命中带 repo / file / line / name / removalVersion，另带覆盖结论）", async () => {
  const host = await hostRepo({
    "src/adapter.js": 'import { createAnthropicProvider } from "erix-agent";\n',
  });
  const result = runScript(["--hosts", host, "--json"]);
  assert.equal(result.status, 0, `被指南覆盖的命中是绿：${result.stdout}${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.gate, true, "给了宿主目录且扫得到 ⇒ 这一轮是判定形态");
  assert.equal(payload.verdict, "covered", "机器读法要能区分「覆盖」与「未覆盖」");
  assert.equal(payload.guideVersion, "0.30.0", "指南版本要带出来（覆盖判据绑在唯一合法移除边界上）");
  assert.equal(payload.covered.length, 1, `应恰好一个被覆盖的名字：${JSON.stringify(payload.covered)}`);
  assert.equal(payload.covered[0].entries.length, 2, "中英两份指南各一条条目");
  assert.deepEqual(payload.uncovered, [], "没有未覆盖的名字");
  assert.equal(payload.hits.length, 1, `应恰好一条命中：${JSON.stringify(payload.hits)}`);
  const [hit] = payload.hits;
  assert.equal(hit.name, "createAnthropicProvider");
  assert.equal(hit.repo, "mini-host");
  assert.equal(hit.line, 1);
  assert.equal(hit.spec, "erix-agent");
  assert.equal(hit.removalVersion, "0.30", "唯一合法的移除版本是 0.30（账本只记阻塞，不换版本号）");
  assert.ok(payload.candidates.some((row) => row.name === "createAnthropicProvider"), "候选清单要带出来（现算的那份）");
});

test("--self-test：反向证（含覆盖判据三态）exit 0", () => {
  const result = runScript(["--self-test"]);
  assert.equal(result.status, 0, `--self-test 必须绿：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /host-consumer-probe --self-test: OK/u);
});

test("npm script 与中英 AGENTS 各有一行（成对，且写清「给目录才判、CI 不跑」）", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check:host-consumers"], "node scripts/host-consumer-probe.mjs", "npm script 必须指向这个脚本");
  for (const doc of ["AGENTS.md", "AGENTS_cn.md"]) {
    const rows = readFileSync(join(ROOT, doc), "utf8")
      .split("\n").filter((line) => line.startsWith("| `npm run check:host-consumers` |"));
    assert.equal(rows.length, 1, `${doc} 的「开发命令」表里要有且只有一行 \`npm run check:host-consumers\`（中英成对）`);
    assert.match(rows[0], /scripts\/host-consumer-probe\.mjs/u, `${doc} 那一行要点名脚本（check:docs 会核这个路径存在）`);
    assert.match(rows[0], /--hosts/u, `${doc} 那一行必须写清「给了宿主目录才判」`);
    assert.match(rows[0], /CI/u, `${doc} 那一行必须写清 CI 不跑（不能变成宿主仓的硬依赖）`);
    assert.match(rows[0], /computeInventory/u, `${doc} 那一行必须写清候选清单是现算的、不抄第二份名单`);
  }
});
