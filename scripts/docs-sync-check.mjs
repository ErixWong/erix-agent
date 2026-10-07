#!/usr/bin/env node
// docs-sync-check.mjs — 中英《宿主消费者契约》标题结构对齐检查（issue #98；零依赖，仅 node: 内置）
//
// 比对 docs/host-consumer-contract.md（英文真相版）与 docs/host-consumer-contract_cn.md
// （中文同步版）的标题清单：
//   1. 按 (层级, 序号) 结构对齐两侧标题：标题总数不齐、某级数量不齐、逐位层级序列不齐 → 告警；
//   2. 逐对标题比对锚点信息（issue #N / ADR-0NN / 版本号 x.y.z）：一侧有一侧无 → 告警。
//
// 配套约定：中文文件头部维护一行「> 同步基线：host-consumer-contract.md @ <日期>」注记，
// 每次翻译补齐后更新该日期（见 CN 文件首段）。本脚本只告警该约定存在，不解析日期。
//
// 用法：
//   node scripts/docs-sync-check.mjs            # 只告警，永远 exit 0（可挂 CI / pre-commit 不阻塞）
//   node scripts/docs-sync-check.mjs --strict   # 有差异时 exit 1（可选开关，默认关）

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EN_FILE = "docs/host-consumer-contract.md";
const CN_FILE = "docs/host-consumer-contract_cn.md";
const STRICT = process.argv.includes("--strict");

function headingsOf(relPath) {
  return readFileSync(path.join(ROOT, relPath), "utf8")
    .split("\n")
    .reduce((acc, line, i) => {
      const m = line.match(/^(#{1,6})\s+(.*)/);
      if (m) acc.push({ line: i + 1, level: m[1].length, title: m[2].trim() });
      return acc;
    }, []);
}

function anchorsOf(title) {
  return [
    ...(title.match(/issue\s+#\d+/gi) || []),
    ...(title.match(/ADR-\d+/gi) || []),
    ...(title.match(/\b\d+\.\d+(?:\.\d+)?\b/g) || []),
  ]
    .map((a) => a.toLowerCase().replace(/\s+/g, ""))
    .sort();
}

const en = headingsOf(EN_FILE);
const cn = headingsOf(CN_FILE);
const warnings = [];
const levelSeq = (hs) => hs.map((h) => h.level).join(",");

if (en.length !== cn.length) {
  warnings.push(`标题总数不齐：EN ${en.length} vs CN ${cn.length}`);
  const [side, longer] = en.length > cn.length ? ["EN", en, cn] : ["CN", cn, en];
  for (const h of longer.slice(Math.min(en.length, cn.length))) {
    warnings.push(`${side} 多出整节：h${h.level}「${h.title}」(L${h.line})`);
  }
}
if (levelSeq(en) !== levelSeq(cn)) {
  warnings.push(
    `逐位层级序列不齐：\n    EN ${levelSeq(en)}\n    CN ${levelSeq(cn)}`,
  );
}
for (const level of new Set([...en.map((h) => h.level), ...cn.map((h) => h.level)])) {
  const ne = en.filter((h) => h.level === level).length;
  const nc = cn.filter((h) => h.level === level).length;
  if (ne !== nc) warnings.push(`h${level} 数量不齐：EN ${ne} vs CN ${nc}`);
}

for (let i = 0; i < Math.min(en.length, cn.length); i++) {
  const e = en[i];
  const c = cn[i];
  const tag = `#${i + 1}（EN L${e.line} / CN L${c.line}）`;
  if (e.level !== c.level) {
    warnings.push(`${tag} 层级不齐：EN h${e.level}「${e.title}」 vs CN h${c.level}「${c.title}」`);
  }
  const ea = anchorsOf(e.title).join("|");
  const ca = anchorsOf(c.title).join("|");
  if (ea !== ca) {
    warnings.push(`${tag} 锚点不齐：EN[${ea || "无"}] vs CN[${ca || "无"}] —「${e.title}」/「${c.title}」`);
  }
}

if (warnings.length === 0) {
  console.log(`docs-sync-check: OK — 中英契约标题结构对齐（${en.length} 节，锚点齐全）`);
  process.exit(0);
}
console.log(`docs-sync-check: ${warnings.length} 处差异（只告警${STRICT ? "；--strict 生效，exit 1" : "，exit 0 不阻塞"}）：`);
for (const w of warnings) console.log(`  ⚠ ${w}`);
process.exit(STRICT ? 1 : 0);
