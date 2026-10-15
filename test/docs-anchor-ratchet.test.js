// issue #286 T-a：符号锚点与裸行号棘轮的 **测试侧**钉子（与 `scripts/docs-drift-check.mjs --self-test` 分工）
//
// 为什么这里**不**再 spawn 一次 `--self-test`：那一轮要跑 85 轮全量检查（实测 ~39s），而 `npm test`
// 全量本来只要 7s——把文档自测塞进单测门，只会让所有人都想跳过它。反向证（改→红、不改→绿、变异没打上→红）
// 一律留在 `--self-test` 里（工单 #286 的判据也写在那儿）。本文件只钉**四件便宜但会腐烂**的事：
//   ① 基线常量与 AGENTS 中英两侧声称的数必须一字不差（口径文件化之后，两侧不同步等于没写）；
//   ② 棘轮的实测值必须**恰好等于**基线（高于 = 有人新增了裸行号；低于 = 常量该降），并且符号锚点
//      确实在抽到东西——拿一次真实的 `--verbose` 输出问，不拿脚本注释当证据；
//   ③ 覆盖面里**任何一处** `src/**.js:N[-M]` 都不许超过目标文件的真实行数，判据在测试侧另实现一遍
//      （不靠被检脚本自证）；工单点名的 `src/store/notes.js:398-405` 两处越界必须已经指向真身；
//   ④ 反向证不许被整批删掉，豁免条目与「具名字面量成员」那一档必须条条带理由。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const BARE_LINE_RE = /src\/([A-Za-z0-9_./-]+\.js):(\d+)(?:-(\d+))?/g;
const CONTRACT_EN = "docs/host-consumer-contract.md";
const CONTRACT_CN = "docs/host-consumer-contract_cn.md";

/** 覆盖面：与脚本里的 `refScanDocs()` 同一批文档，**故意**在测试侧另写一遍——两边不一致时第 ②③ 条
 *  就会红，等于把「覆盖面悄悄缩水」也钉住（升级指南按目录实扫，新指南落地即自动纳面）。 */
const DOCS = [
  "README.md", "README_cn.md", "AGENTS.md", "AGENTS_cn.md", CONTRACT_EN, CONTRACT_CN,
  ...readdirSync(join(ROOT, "docs")).filter((f) => /^host-upgrade-guide.*\.md$/.test(f)).sort().map((f) => `docs/${f}`),
];

test("#286 棘轮基线常量与 AGENTS 中英两侧声称的数一致（口径文件化不许单边腐烂）", () => {
  const script = read("scripts/docs-drift-check.mjs");
  const baseline = script.match(/^const BARE_LINE_REF_BASELINE = (\d+);/m)?.[1];
  assert.ok(baseline, "脚本里抽不到 `const BARE_LINE_REF_BASELINE = <数字>;`——棘轮常量被删或改了写法");
  assert.equal(Number(baseline), 244, "工单 #286 T-a 的基线是 244；改这个数必须在提交信息里写理由");
  for (const doc of ["AGENTS.md", "AGENTS_cn.md"]) {
    const claims = [...read(doc).matchAll(/BARE_LINE_REF_BASELINE\s*=\s*(\d+)/g)].map((m) => m[1]);
    assert.ok(claims.length >= 1, `${doc} 没写 BARE_LINE_REF_BASELINE——中英成对义务要求两侧都写（工单 R4）`);
    assert.deepEqual([...new Set(claims)], [baseline],
      `${doc} 声称的基线与脚本常量不一致：${claims.join(" / ")} vs ${baseline}`);
  }
});

test("#286 棘轮实测值恰好等于基线，符号锚点确实在抽东西（拿 --verbose 的真实输出问）", () => {
  const out = execFileSync(process.execPath, [join(ROOT, "scripts", "docs-drift-check.mjs"), "--verbose"], { encoding: "utf8" });
  const m = out.match(/⇒ 棘轮口径实测 \*\*(\d+)\*\* vs 基线 (\d+)/);
  assert.ok(m, `--verbose 里没有棘轮那条 note——覆盖面或输出被改坏：\n${out.slice(0, 500)}`);
  assert.equal(m[1], m[2], `实测 ${m[1]} ≠ 基线 ${m[2]}：多了就是有人新增裸行号，少了请把基线常量降下来（只减不增）`);
  const anchor = out.match(/symbol-anchor: 覆盖面 (\d+) 份文档里「符号 \+ 文件」锚点 (\d+) 处/);
  assert.ok(anchor, "符号锚点的覆盖面 note 不见了——提取器或覆盖面被改坏");
  assert.equal(Number(anchor[1]), DOCS.length, `覆盖面份数与测试侧另写的那份不一致：脚本 ${anchor[1]} vs 测试 ${DOCS.length}`);
  assert.ok(Number(anchor[2]) > 0, "符号锚点抽到 0 处 = 检查面在空跑");
});

test("#286 覆盖面里没有任何一处裸行号越界（工单点名的 notes.js:398-405 已按真值改掉）", () => {
  const counts = new Map();
  const linesOf = (rel) => {
    if (!counts.has(rel)) {
      let text;
      try { text = read(rel); } catch { counts.set(rel, null); return null; }
      const n = text.split("\n");
      counts.set(rel, n.length > 1 && n[n.length - 1] === "" ? n.length - 1 : n.length);
    }
    return counts.get(rel);
  };
  const offenders = [];
  for (const doc of DOCS) {
    read(doc).split("\n").forEach((line, i) => {
      for (const mm of line.matchAll(BARE_LINE_RE)) {
        const target = `src/${mm[1]}`;
        const hi = Math.max(Number(mm[2]), Number(mm[3] ?? 0));
        const n = linesOf(target);
        if (n === null) continue;   // 示例/外仓路径（src/a/b.js、src/pi/runner.js）由脚本侧的声明式豁免处理
        if (hi > n) offenders.push(`${doc}:${i + 1} → ${target}:${mm[2]}${mm[3] ? `-${mm[3]}` : ""}（该文件只有 ${n} 行）`);
      }
    });
  }
  assert.deepEqual(offenders, [], "这些引用把行号写到了文件末尾之外（#286 的病根形状）：\n  " + offenders.join("\n  "));

  // 工单点名的两处确凿越界：现在必须指向真实存在的位置（`normalizeListRequest` 才是 limit 校验与钳制的真身）
  for (const doc of [CONTRACT_EN, CONTRACT_CN]) {
    const text = read(doc);
    assert.ok(!text.includes("src/store/notes.js:398"), `${doc} 还留着 src/store/notes.js:398-405（该文件只有 383 行）`);
    const hit = text.match(/src\/store\/notes-port\.js:(\d+)-(\d+)/);
    assert.ok(hit, `${doc} 缺少改写后的 limit 校验锚点（真身在 src/store/notes-port.js 的 normalizeListRequest）`);
    assert.ok(Number(hit[2]) <= linesOf("src/store/notes-port.js"), `${doc} 改写后的行号区间仍然越界`);
  }
});

test("#286 反向证不许被整批删掉，豁免条目必须条条带理由（条目 + 就地声明双条件）", () => {
  const script = read("scripts/docs-drift-check.mjs");
  const proofs = [...script.matchAll(/label: "#286 /g)].length;
  assert.ok(proofs >= 10, `--self-test 里带 #286 的反向证只剩 ${proofs} 例（本批交付的是 10 例）——删用例不算修好`);
  assert.ok(/expectMutateMiss: true/.test(script), "「变异没打上」那一例（expectMutateMiss）被删了——变异器空转就没人管了");

  const entries = [...script.matchAll(/target: "(src\/[^"]+)",/g)];
  assert.ok(entries.length >= 4, `裸行号豁免条目少于 4 条（工单口径是 4 处示例/外仓路径）：实测 ${entries.length}`);
  const whys = [...script.matchAll(/target: "src\/[^"]+",[\s\S]{0,400}?why: "([^"]{20,})"/g)];
  assert.equal(whys.length, entries.length, "有裸行号豁免条目没写理由（#286 口径：条目必须带**必填**理由）");
  for (const m of script.matchAll(/target: "src\/[^"]+",\n\s*decl: (\/[^\n]+)/g)) {
    assert.ok(m[1].replace(/^\/|\/,?$/g, "").length > 5, `decl 太短，等于「有句话就算声明」：${m[1]}`);
  }
  // 「具名字面量成员」那一档的点名清单必须逐份带理由（全仓开这一档就等于把「同名字符串」当通行票）。
  const block = script.slice(
    script.indexOf("const SYMBOL_VALUE_MEMBERSHIP = new Map(["),
    script.indexOf("]);", script.indexOf("const SYMBOL_VALUE_MEMBERSHIP = new Map([")),
  );
  assert.ok(block.length > 100, "抽不到 SYMBOL_VALUE_MEMBERSHIP 这一段——弱判据的点名清单被挪走或删了");
  const valueTier = [...block.matchAll(/^\s*\["src\/[^"]+", ".{20,}"\],$/gm)];
  assert.equal(valueTier.length, 4, `「具名字面量成员」一档必须逐份点名 4 个文件并各写理由，实测 ${valueTier.length} 份`);
});
