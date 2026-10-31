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
//   ④ 反向证不许被整批删掉，豁免条目与「具名字面量成员」那一档必须条条带理由；
//  ⑤ #286 T-b1a：符号锚点**自带区间**与声明处相交的存量必须为 0，且这条判据是逐处过的（不是抽样）。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const BARE_LINE_RE = /src\/([A-Za-z0-9_./-]+\.js):(\d+)(?:-(\d+))?/g;
const CONTRACT_EN = "docs/host-consumer-contract.md";
const CONTRACT_CN = "docs/host-consumer-contract_cn.md";

/** #286 返工 R2：升级指南的**硬编码清单**（测试侧这一份是第二只眼）。脚本侧按
 *  `^host-upgrade-guide.*\.md$` 实扫、测试侧本来也用同一个 glob——那等于两只眼用同一只眼睛看：
 *  有人把某份指南改名到不匹配该模式，两边**一起**少一份，数字仍然相等，覆盖面静默缩面。
 *  所以这里把当前 22 份逐份点名：改名/新增/删除都会红，并提示「脚本侧下限与这份清单要一起改」。 */
const GUIDE_DOCS_PINNED = [
  "docs/host-upgrade-guide-0.6.0.md",
  "docs/host-upgrade-guide-0.12.0.md",
  "docs/host-upgrade-guide-0.14.0.md",
  "docs/host-upgrade-guide-0.15.0.md",
  "docs/host-upgrade-guide-0.16.0.md",
  "docs/host-upgrade-guide-0.17.0.md",
  "docs/host-upgrade-guide-0.18.0.md",
  "docs/host-upgrade-guide-0.18.0_cn.md",
  "docs/host-upgrade-guide-0.19.0.md",
  "docs/host-upgrade-guide-0.19.0_cn.md",
  "docs/host-upgrade-guide-0.20.0.md",
  "docs/host-upgrade-guide-0.20.0_cn.md",
  "docs/host-upgrade-guide-0.21.0.md",
  "docs/host-upgrade-guide-0.21.0_cn.md",
  "docs/host-upgrade-guide-0.22.0.md",
  "docs/host-upgrade-guide-0.22.0_cn.md",
  "docs/host-upgrade-guide-0.23.0.md",
  "docs/host-upgrade-guide-0.23.0_cn.md",
  "docs/host-upgrade-guide-0.24.0.md",
  "docs/host-upgrade-guide-0.24.0_cn.md",
  "docs/host-upgrade-guide-0.25.0.md",
  "docs/host-upgrade-guide-0.25.0_cn.md",
  "docs/host-upgrade-guide-0.26.0.md",
  "docs/host-upgrade-guide-0.26.0_cn.md",
  "docs/host-upgrade-guide-0.27.0.md",
  "docs/host-upgrade-guide-0.27.0_cn.md",
  "docs/host-upgrade-guide-0.28.0.md",
  "docs/host-upgrade-guide-0.28.0_cn.md",
  "docs/host-upgrade-guide-0.29.0.md",
  "docs/host-upgrade-guide-0.29.0_cn.md",
  "docs/host-upgrade-guide-v030.md",
  "docs/host-upgrade-guide-v030_cn.md",
];

/** 覆盖面里**硬编码点名**的那批文档（工单 261021-03 B1：6 份 → **13** 份）。与脚本侧的
 *  `SYMBOL_DOCS_STATIC` 同一批：两份 README、中英 AGENTS、中英契约、中英架构、中英图表、中英需求对照，
 *  外加 `examples/pi-extension/README.md`。测试侧故意另写一份并逐份点名：脚本侧改名 / 从清单里揉掉一份
 *  而不在这里同步，这一例就红（与下面 `GUIDE_DOCS_PINNED` 同一条理由：两只眼不得用同一只眼睛看）。 */
const NAMED_DOCS_PINNED = [
  "README.md", "README_cn.md", "AGENTS.md", "AGENTS_cn.md", CONTRACT_EN, CONTRACT_CN,
  "docs/architecture.md", "docs/architecture_cn.md",
  "docs/charts.md", "docs/charts_cn.md",
  "docs/requirements.md", "docs/requirements_cn.md",
  "examples/pi-extension/README.md",
];

/** 覆盖面：与脚本里的 `refScanDocs()` 同一批文档，**故意**在测试侧另写一遍——两边不一致时第 ②③ 条
 *  就会红，等于把「覆盖面悄悄缩水」也钉住（升级指南按目录实扫，新指南落地即自动纳面）。 */
const DOCS = [
  ...NAMED_DOCS_PINNED,
  ...readdirSync(join(ROOT, "docs")).filter((f) => /^host-upgrade-guide.*\.md$/.test(f)).sort().map((f) => `docs/${f}`),
];

test("#286 覆盖面（返工 R2 + 工单 261021-03 B1 + 261021-12 + 261022-17 + docs-261031-01）：脚本侧实扫的指南清单必须等于测试侧硬编码的那 32 份，且下限常量 = 13 份点名 + 32 份指南 = 45", () => {
  const discovered = readdirSync(join(ROOT, "docs")).filter((f) => /^host-upgrade-guide.*\.md$/.test(f))
    .map((f) => `docs/${f}`).sort();   // 与清单同形状（都带 docs/ 前缀），免得比出假差集
  const missing = GUIDE_DOCS_PINNED.filter((f) => !discovered.includes(f));
  const extra = discovered.filter((f) => !GUIDE_DOCS_PINNED.includes(f));
  assert.deepEqual(missing, [], "这些指南不见了（改名或移走 = 覆盖面静默缩面）：" + missing.join(", ")
    + "\n  脚本侧靠 `^host-upgrade-guide.*\\.md$` 实扫发现不到新名字，必须同时改：脚本里的 REF_SCAN_DOCS_MINIMUM 与本文件的 GUIDE_DOCS_PINNED");
  assert.deepEqual(extra, [], "多出一份没登记进测试侧清单的指南：" + extra.join(", ")
    + "\n  新增指南请把名字补进 test/docs-anchor-ratchet.test.js 的 GUIDE_DOCS_PINNED，并把脚本侧 REF_SCAN_DOCS_MINIMUM 升上去");
  const script = read("scripts/docs-drift-check.mjs");
  const minimum = Number(script.match(/^const REF_SCAN_DOCS_MINIMUM = (\d+);/m)?.[1] ?? NaN);
  assert.equal(minimum, 45, "覆盖面下限常量被改了：应为 13 份点名文档 + 32 份指南 = 45"
    + "（13 份 = README×2 + AGENTS×2 + 契约×2 + 架构×2 + 图表×2 + 需求对照×2 + erix_run README，工单 261021-03 B1 由 6 抬到 13；新增一份就抬一次）");
  assert.equal(NAMED_DOCS_PINNED.length + GUIDE_DOCS_PINNED.length, minimum, "测试侧清单份数与脚本侧下限不一致（两处必须同步）");
  // 点名那一批还要与脚本里的 `SYMBOL_DOCS_STATIC` 逐份对得上：只比份数的话，「揉掉架构、换成另一份」
  // 这种等量交换两边仍然相等 ⇒ 静默换面（与指南改名同一条病，只是形状不同）。
  const staticBlock = script.slice(
    script.indexOf("const SYMBOL_DOCS_STATIC = ["),
    script.indexOf("];", script.indexOf("const SYMBOL_DOCS_STATIC = [")),
  );
  assert.ok(staticBlock.length > 20, "抽不到脚本侧的 `const SYMBOL_DOCS_STATIC = [...]`——点名清单被挪走了");
  const constToRel = { README_EN: "README.md", README_CN: "README_cn.md", AGENTS_EN: "AGENTS.md", AGENTS_CN: "AGENTS_cn.md", CONTRACT_EN, CONTRACT_CN, ARCH_EN: "docs/architecture.md", ARCH_CN: "docs/architecture_cn.md", CHARTS_EN: "docs/charts.md", CHARTS_CN: "docs/charts_cn.md", REQ_EN: "docs/requirements.md", REQ_CN: "docs/requirements_cn.md", PI_EXT_README: "examples/pi-extension/README.md" };
  const scriptNamed = [...staticBlock.matchAll(/\b([A-Z][A-Z0-9_]+)\b/g)].map((m) => constToRel[m[1]]).filter(Boolean);
  assert.deepEqual([...new Set(scriptNamed)].sort(), [...NAMED_DOCS_PINNED].sort(),
    `脚本侧 SYMBOL_DOCS_STATIC 点名的文档与本文件的 NAMED_DOCS_PINNED 不一致（脚本 ${scriptNamed.join(", ")}）`
    + "\n  两边不一致 = 覆盖面被**等量换面**（揉掉一份又补一份，份数不变而检查面已经不同）");
  for (const rel of NAMED_DOCS_PINNED) assert.ok(existsSync(join(ROOT, rel)), `点名的活文档不见了：${rel}（改名 = 检查面静默缩面，与指南改名同一条病）`);
});

test("#286 棘轮基线常量与 AGENTS 中英两侧声称的数一致（口径文件化不许单边腐烂）", () => {
  const script = read("scripts/docs-drift-check.mjs");
  const baseline = script.match(/^const BARE_LINE_REF_BASELINE = (\d+);/m)?.[1];
  assert.ok(baseline, "脚本里抽不到 `const BARE_LINE_REF_BASELINE = <数字>;`——棘轮常量被删或改了写法");
  assert.ok(Number(baseline) <= 244, `棘轮只能降不能抬：工单 #286 T-a 登记的是 244，现在是 ${baseline}——抬上去要在提交信息里写「这次允许变差」的理由`);
  for (const doc of ["AGENTS.md", "AGENTS_cn.md"]) {
    const claims = [...read(doc).matchAll(/BARE_LINE_REF_BASELINE\s*=\s*(\d+)/g)].map((m) => m[1]);
    assert.ok(claims.length >= 1, `${doc} 没写 BARE_LINE_REF_BASELINE——中英成对义务要求两侧都写（工单 R4）`);
    assert.deepEqual([...new Set(claims)], [baseline],
      `${doc} 声称的基线与脚本常量不一致：${claims.join(" / ")} vs ${baseline}`);
  }
});

/** #286 T-b1a R1：符号锚点自带的区间必须与该符号在被引文件里的**声明处相交**。
 *  为什么这条要钉在测试侧：判据本身在 `--self-test` 里有四条反向证，但那些证只证明「判据会红」；
 *  这里要的是另一件事——**存量真的为 0**，且这条判据是**逐处**过的（自带区间数 = 相交 + 不相交，
 *  差一个数就说明有锚点根本没被过问，即抽样）。拿一次真实的 `--verbose` 输出问，不拿注释当证据。 */
test("#286 T-b1a 符号锚点自带区间与声明处相交：--verbose 的 note 必须是「不相交 0 处」且逐处覆盖", () => {
  const out = execFileSync(process.execPath, [join(ROOT, "scripts", "docs-drift-check.mjs"), "--verbose"], { encoding: "utf8" });
  const span = out.match(/symbol-anchor-span: 覆盖面 (\d+) 处符号锚点里自带区间 (\d+) 处：相交 (\d+) 处 \/ 不相交 (\d+) 处/);
  assert.ok(span, `--verbose 里没有「区间相交」那条 note——判据被删或改了措辞（测试侧的匹配也要同步）：\n${out.slice(0, 400)}`);
  assert.equal(Number(span[3]) + Number(span[4]), Number(span[2]),
    `自带区间 ${span[2]} 处 ≠ 相交 ${span[3]} + 不相交 ${span[4]} ⇒ 有锚点没被这条判据过问（那是抽样，不是逐处）`);
  assert.equal(Number(span[4]), 0, `还有 ${span[4]} 处符号锚点的自带区间与声明处不相交（#286 的裸行号漂移）——删区间或把区间改正到声明行`);
  assert.ok(Number(span[2]) > 0, "一处带区间的符号锚点都抽不到 = 提取逻辑被改坏，这条判据在空跑");
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
    // #286 T-c：这一处从「裸行号区间」换成了不带区间的符号锚点（首选修法），所以这里钉的是锚点形状，
    // 不是行号区间——区间越界那条由上面那次全量扫描负责。
    assert.ok(/`normalizeListRequest`\s*[（(]\s*`src\/store\/notes-port\.js`\s*[)）]/.test(text),
      `${doc} 缺少改写后的 limit 校验锚点（真身在 src/store/notes-port.js 的 normalizeListRequest）`);
  }
});

test("#286 反向证不许被整批删掉，豁免条目必须条条带理由（条目 + 就地声明双条件）", () => {
  const script = read("scripts/docs-drift-check.mjs");
  const proofs = [...script.matchAll(/label: "#286 /g)].length;
  assert.ok(proofs >= 16, `--self-test 里带 #286 的反向证只剩 ${proofs} 例（评审返工后共 17 例）——删用例不算修好`);
  assert.ok(/expectMutateMiss: true/.test(script), "「变异没打上」那一例（expectMutateMiss）被删了——变异器空转就没人管了");

  const entries = [...script.matchAll(/target: "(src\/[^"]+)",/g)];
  assert.ok(entries.length >= 4, `裸行号豁免条目少于 4 条（工单口径是 4 处示例/外仓路径）：实测 ${entries.length}`);
  const whys = [...script.matchAll(/target: "src\/[^"]+",[\s\S]{0,400}?why: "([^"]{20,})"/g)];
  assert.equal(whys.length, entries.length, "有裸行号豁免条目没写理由（#286 口径：条目必须带**必填**理由）");
  for (const m of script.matchAll(/target: "src\/[^"]+",\n\s*decl: (\/[^\n]+)/g)) {
    assert.ok(m[1].replace(/^\/|\/,?$/g, "").length > 5, `decl 太短，等于「有句话就算声明」：${m[1]}`);
  }
  // 评审 R4：「就地声明」必须是 **同一行同时含占位路径与声明词**（AND），且条目自己要有配置校。
  // 这两条是源码形状的反向锁：谁把它们改回 OR / 删掉校，这里就红。
  assert.ok(/if \(!lineText\.includes\(entry\.target\)\)/.test(script),
    "豁免判据少了「引用行必须含占位路径」这一刀（评审 R4：光有 for example 之类的附带措辞就能放行）");
  assert.ok(/entry\.decl\.test\(lineText\)/.test(script), "豁免判据少了声明词那一刀（AND 的另一半）");
  assert.ok(/function bareLineExemptionEntryErrors\(\)/.test(script) && /out\.push\(\.\.\.bareLineExemptionEntryErrors\(\)\)/.test(script),
    "豁免条目的配置校（声明词不许匹配空串 / 不许带 g 标志）被删或没接进 collectBareLineRefErrors");
  // 「具名字面量成员」那一档的点名清单必须逐份带理由（全仓开这一档就等于把「同名字符串」当通行票）。
  const block = script.slice(
    script.indexOf("const SYMBOL_VALUE_MEMBERSHIP = new Map(["),
    script.indexOf("]);", script.indexOf("const SYMBOL_VALUE_MEMBERSHIP = new Map([")),
  );
  assert.ok(block.length > 100, "抽不到 SYMBOL_VALUE_MEMBERSHIP 这一段——弱判据的点名清单被挪走或删了");
  const valueTier = [...block.matchAll(/^\s*\["src\/[^"]+", ".{20,}"\],$/gm)];
  assert.equal(valueTier.length, 4, `「具名字面量成员」一档必须逐份点名 4 个文件并各写理由，实测 ${valueTier.length} 份`);
});
