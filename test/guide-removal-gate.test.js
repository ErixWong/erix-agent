// issue #687：升级指南声称「已删除 / 已不存在」的导出名，必须在**发布物运行时导出面**上真的不存在；
// 反向（运行时仍导出、而指南称已删）也红。
//
// 病根（issue #687 的原话）：0.30.0 指南写着「16 exported names are removed」、§3 写着
// `createAnthropicProvider` 在 0.30.0 已不存在，而已发布的 `erix-agent@0.30.0` 一个都没删——解包后
// `import` 一次，两个入口把 16 个名字全都还给了消费者。既有三把闸（`check:exports:deprecated` /
// `check:host-consumers` / `check:docs` 的 `bundle-table`）都只在**文档与登记**这一侧对账，没有一条把
// 「指南说了什么」与「装好的包真的导出什么」放在一起比 ⇒ 这一态可以一路绿到发布之后。
//
// 本文件钉住的四件事（全部离线、不装包、不联网）：
//   A. 名集是**读**出来的（`scripts/bundle-guide-table.mjs` 是唯一读法，不抄名单），中英任一份声明即算声明，
//      入口取并集；入口列写法不认识时两个入口都查（不许猜）。
//   B. **同一跑的两态**：真树运行时面 + 真登记表 ⇒ 绿并打印「已知未删除 N 条」；登记表清空 ⇒ 同一跑
//      逐名红出来（红数 = 现算仍导出名数，**不是**写死的 16——#688 真删之后这两个数一起归零，本文件
//      不该因此变红）。
//   C. **登记表自己也被看守**：空 `why` 红、空转条目红（指南不再声称 / 运行时已经不再导出）、
//      条数与现算红名数双向漂移红、形状坏掉 / 重名红（`CONTRACT_PUBLISH_EXEMPTIONS` 同口径）。
//   D. **读不出 ≠ 绿**：指南缺一份、表解析不出名集（分类原因点名 CHANGELOG 段）、运行时面缺入口 ⇒ exit 2。
//
// 反向证在 `scripts/guide-removal-gate.mjs --self-test`（合成夹具 + 真指南只读）：变异没落上算失败
// （#210 R2 口径），登记表清空 / 空 why / 空转条目 / 表坏掉各有自己那一枪。本文件另跑一次那条 CLI，
// 断言它真的 exit 0 且打出自己的判据条数——「自测存在」与「自测跑得过」不是同一件事。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ENTRY_LABELS,
  ENTRY_ORDER,
  GATE_CODES,
  KNOWN_NOT_REMOVED,
  evaluateGuideRemoval,
  readRemovalClaims,
  verifyGuideRemoval,
} from "../scripts/guide-removal-gate.mjs";
import { makeTmp } from "./helpers/tmp.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "guide-removal-gate.mjs");

/** 真指南读出来的名集（惰性：只在第一次用到时读盘）。 */
let cachedClaims = null;
function realClaims() {
  cachedClaims ??= readRemovalClaims();
  return cachedClaims;
}

/** 真树的运行时导出面（两个入口的 own keys；与 `check:release` 装包探针写的 JSON 同形）。 */
async function sourceSurface() {
  const root = await import("../src/index.js");
  const tools = await import("../src/tools/index.js");
  return { root: Object.keys(root).sort(), tools: Object.keys(tools).sort() };
}

/** 指南声称「已删除」、而给定运行时面**仍然导出**的名字（按指南行登记的入口判）。 */
function stillExportedIn(claims, surface) {
  const out = new Map();
  for (const claim of claims.values()) {
    const hit = claim.entries.filter((entry) => surface[entry].includes(claim.name));
    if (hit.length > 0) out.set(claim.name, hit);
  }
  return out;
}

/** 合成运行时面：把名集里每个名字放回它声称的入口（= 「一个都没删」的世界）。 */
function stillThereSurface(claims) {
  const surface = { root: [], tools: [] };
  for (const claim of claims.values()) for (const entry of claim.entries) surface[entry].push(claim.name);
  return surface;
}

/** 一条红项的「名字 @ 指南文件:行 @ 入口」三格是否都在。 */
function namesAllThree(red, claim, entry) {
  return red.detail.includes(red.name)
    && claim.files.some((file) => red.detail.includes(`${file.file}:${file.line}`))
    && red.detail.includes(ENTRY_LABELS[entry]);
}

test("#687 A：名集是读出来的（中英两份，入口按指南行；任一份声明即算声明）", (t) => {
  const { claims, errors, notes } = realClaims();
  assert.deepEqual(errors, [], "真指南必须读得出名集（错误集合为空）");
  assert.ok(claims.size > 0, "名集不能是空的：空集会让正向断言恒绿，那正是本闸要修的病");
  for (const claim of claims.values()) {
    assert.ok(claim.entries.length > 0, `\`${claim.name}\` 没有解析出入口`);
    for (const entry of claim.entries) assert.ok(ENTRY_ORDER.includes(entry), `\`${claim.name}\` 的入口 ${entry} 不是合法入口`);
    assert.ok(claim.files.length > 0, `\`${claim.name}\` 没有来源行（报错要点名 指南文件:行）`);
    for (const file of claim.files) assert.match(file.file, /^docs\/host-upgrade-guide-.*\.md$/u);
  }
  // 中英两份都要有这一行（任一份声明即算声明，但两份都声明才是今天的事实）。
  for (const claim of claims.values()) {
    const files = new Set(claim.files.map((file) => file.file));
    assert.equal(files.size, 2, `\`${claim.name}\` 只在一份指南里出现：${[...files].join(", ")}`);
  }
  assert.deepEqual(
    [...claims.keys()].sort(),
    KNOWN_NOT_REMOVED.map((row) => row.name).sort(),
    "登记表的名字集合必须与指南声称的名集逐字相同（双向漂移由下面两条用例钉住）",
  );
  t.diagnostic(`名集 ${claims.size} 个名字，读取提示 ${notes.length} 条`);
});

test("#687 B：同一跑的两态——真登记表 ⇒ 绿（打印已知未删除 N 条）；清空登记表 ⇒ 逐名红", async (t) => {
  const { claims } = realClaims();
  const surface = await sourceSurface();
  const stillExported = stillExportedIn(claims, surface);

  // 今天的事实：登记表条数 = 现算仍导出名数（少一条 ⇒ 下面 cleared 会多一条红；多一条 ⇒ 真登记表会红 G3）。
  assert.equal(
    KNOWN_NOT_REMOVED.length,
    stillExported.size,
    "登记表条数必须等于「指南说删了、运行时还在导出」的现算名数——这就是那条双向对账",
  );

  // 态一：真登记表 ⇒ 绿。
  const registered = evaluateGuideRemoval({ claims, runtime: surface, registry: KNOWN_NOT_REMOVED });
  assert.deepEqual(registered.errors, [], "运行时面与名集都读得出，不该有读取错误");
  assert.deepEqual(registered.reds.map((red) => `${red.code}:${red.name}`), [], "真登记表必须全兜住");
  assert.equal(registered.known.length, stillExported.size, "已知未删除条数必须等于现算仍导出名数");

  // 态二：清空登记表 ⇒ 同一跑逐名红（红数 = 现算仍导出名数，不是写死的数字）。
  const cleared = evaluateGuideRemoval({ claims, runtime: surface, registry: [] });
  assert.equal(cleared.reds.length, stillExported.size, "清空登记表后必须逐名红出来");
  assert.ok(cleared.reds.every((red) => red.code === GATE_CODES.STILL_EXPORTED), "清空后的红必须都是 STILL_EXPORTED");
  for (const red of cleared.reds) {
    const claim = claims.get(red.name);
    assert.ok(claim, `红项 \`${red.name}\` 不在名集里`);
    const entry = red.entries[0];
    assert.ok(namesAllThree(red, claim, entry), `红项要点名「名字 @ 指南文件:行 @ 入口」：${red.detail}`);
  }
  t.diagnostic(
    `登记 ${KNOWN_NOT_REMOVED.length} 条 ⇒ 绿（已知未删除 ${registered.known.length} 条，N=${registered.known.length}）；`
    + `清空登记表 ⇒ 红 ${cleared.reds.length} 处`,
  );
});

test("#687 B2：合成「一个都没删」的世界也走同一条判据（不依赖真树今天的导出面）", () => {
  const { claims } = realClaims();
  const surface = stillThereSurface(claims);
  const registered = evaluateGuideRemoval({ claims, runtime: surface, registry: KNOWN_NOT_REMOVED });
  const cleared = evaluateGuideRemoval({ claims, runtime: surface, registry: [] });
  assert.equal(registered.reds.length, 0);
  assert.equal(registered.known.length, KNOWN_NOT_REMOVED.length);
  assert.equal(cleared.reds.length, claims.size);
});

test("#687 C：登记表自己也被看守（空 why / 空转条目 / 双向漂移 / 形状坏掉）", () => {
  const { claims } = realClaims();
  const surface = stillThereSurface(claims);
  const firstName = [...claims.keys()][0];

  // 空 why ⇒ 红。
  const blankWhy = KNOWN_NOT_REMOVED.map((row) => (row.name === firstName ? { ...row, why: "  " } : row));
  const blank = evaluateGuideRemoval({ claims, runtime: surface, registry: blankWhy });
  assert.ok(blank.reds.some((red) => red.code === GATE_CODES.REGISTRY_NO_WHY && red.name === firstName));

  // 少一条 ⇒ 那一条红 G1（正向断言）；多一条 ⇒ 那一条红 G3（空转条目）。
  const short = evaluateGuideRemoval({ claims, runtime: surface, registry: KNOWN_NOT_REMOVED.filter((row) => row.name !== firstName) });
  assert.deepEqual(short.reds.map((red) => `${red.code}:${red.name}`), [`${GATE_CODES.STILL_EXPORTED}:${firstName}`]);
  const ghost = { name: "guideRemovalGateGhost", why: "自测：指南两份都没有声称删除这个名字" };
  const long = evaluateGuideRemoval({ claims, runtime: surface, registry: [...KNOWN_NOT_REMOVED, ghost] });
  assert.deepEqual(long.reds.map((red) => `${red.code}:${red.name}`), [`${GATE_CODES.REGISTRY_IDLE}:${ghost.name}`]);

  // 删除真的发生了、登记还在 ⇒ 红 G3（这条账已还清，必须删）。
  const firstClaim = claims.get(firstName);
  const entry = firstClaim.entries[0];
  const deleted = { root: [...surface.root], tools: [...surface.tools] };
  deleted[entry] = deleted[entry].filter((name) => name !== firstName);
  const afterDelete = evaluateGuideRemoval({ claims, runtime: deleted, registry: KNOWN_NOT_REMOVED });
  assert.ok(afterDelete.reds.some((red) => red.code === GATE_CODES.REGISTRY_IDLE && red.name === firstName));
  assert.ok(afterDelete.known.every((row) => row.name !== firstName));

  // 形状坏掉 / 重名 ⇒ 红（不许静默）。
  const malformed = evaluateGuideRemoval({ claims, runtime: surface, registry: /** @type {any} */ ({}) });
  assert.ok(malformed.reds.some((red) => red.code === GATE_CODES.REGISTRY_MALFORMED));
  const duplicated = evaluateGuideRemoval({
    claims,
    runtime: surface,
    registry: [...KNOWN_NOT_REMOVED, { name: firstName, why: "自测：故意重复" }],
  });
  assert.ok(duplicated.reds.some((red) => red.code === GATE_CODES.REGISTRY_DUPLICATE && red.name === firstName));
});

test("#687 D：读不出真值 ⇒ exit 2（指南缺失 / 表解析不出 / 运行时面缺入口），读不出永远不等于绿", () => {
  const { claims } = realClaims();
  const surface = stillThereSurface(claims);

  // 指南缺一份：另一份声称了什么无从核对。
  const missing = verifyGuideRemoval({
    runtime: surface,
    registry: KNOWN_NOT_REMOVED,
    read: (abs) => {
      if (abs.endsWith("_cn.md")) {
        const error = /** @type {Error & {code: string}} */ (new Error(`ENOENT: ${abs}`));
        error.code = "ENOENT";
        throw error;
      }
      return "<!-- doc-version: 0.30.0 -->\n# fixture\n";
    },
  });
  assert.equal(missing.status, 2);
  assert.ok(missing.errors.some((error) => error.code === GATE_CODES.GUIDE_MISSING));

  // 表解析不出名集、而 CHANGELOG 同版本段有反引号字段名 ⇒ 分类原因必须点名它。
  const brokenTable = "# fixture\n\n| Name | Entry |\n|---|---|\n| `x` | `.` |\n";
  const unparsed = verifyGuideRemoval({
    runtime: surface,
    registry: [],
    read: (abs) => {
      if (abs.endsWith("CHANGELOG.md")) {
        return "# Changelog\n\n## [0.30.0] - 2026-01-01\n\n### Breaking\n\n- `runToolLoop` drops `maxRounds`.\n";
      }
      return brokenTable;
    },
  });
  assert.equal(unparsed.status, 2);
  const unparsedHit = unparsed.errors.find((error) => error.code === GATE_CODES.TABLE_UNPARSED);
  assert.ok(unparsedHit, "表解析不出名集必须是 TABLE_UNPARSED，不许静默当成空集");
  assert.match(unparsedHit.message, /CHANGELOG\.md/u);
  assert.match(unparsedHit.message, /runToolLoop/u);

  // 运行时面缺入口：缺一个入口 ≠ 那个入口没有导出。
  const noTools = verifyGuideRemoval({ runtime: { root: [] }, registry: [] });
  assert.equal(noTools.status, 2);
  assert.ok(noTools.errors.some((error) => error.code === GATE_CODES.RUNTIME_SURFACE_MISSING));
});

test("#687 E：`--self-test` 真的跑得过（反向证存在 ≠ 反向证通过）", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--self-test"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, `--self-test 必须 exit 0：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /guide-removal-gate --self-test: OK/u);
});

test("#687 F：CLI 单独跑——不给 --runtime ⇒ exit 2；给真值 ⇒ 按名集判绿红", async () => {
  const noTruth = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(noTruth.status, 2, "没有运行时真值时必须 exit 2（不许把「没读到」当成「没导出」）");
  assert.match(noTruth.stderr, /RUNTIME_SURFACE_MISSING/u);

  const { claims } = realClaims();
  const dir = await makeTmp("erix-guide-removal-gate-");

  // 一个都没删的世界 ⇒ 真登记表全兜住 ⇒ exit 0。
  const stillThere = join(dir, "still-there.json");
  writeFileSync(stillThere, JSON.stringify(stillThereSurface(claims)), "utf8");
  const green = spawnSync(process.execPath, [SCRIPT, "--runtime", stillThere], { cwd: ROOT, encoding: "utf8" });
  assert.equal(green.status, 0, `全兜住必须 exit 0：\n${green.stdout}\n${green.stderr}`);
  assert.match(green.stdout, new RegExp(`已知未删除 ${KNOWN_NOT_REMOVED.length} 条（N=${KNOWN_NOT_REMOVED.length}）`, "u"));

  // 删除真的发生了、登记还在 ⇒ 逐名红 G3 ⇒ exit 1（不许因为「运行时没有它」而变绿）。
  const removed = join(dir, "removed.json");
  writeFileSync(removed, JSON.stringify({ root: [], tools: [] }), "utf8");
  const red = spawnSync(process.execPath, [SCRIPT, "--runtime", removed], { cwd: ROOT, encoding: "utf8" });
  assert.equal(red.status, 1, `登记已还清必须 exit 1：\n${red.stdout}\n${red.stderr}`);
  assert.match(red.stderr, /REGISTRY_IDLE/u);
});
