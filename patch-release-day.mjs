import { readFileSync, writeFileSync } from "node:fs";
const P = "scripts/release-day.mjs";
const lines = readFileSync(P, "utf8").split("\n");
// 1-based accessors
const at = (n) => lines[n - 1];
function expectAt(n, sub) {
  if (!at(n).includes(sub)) throw new Error(`line ${n} expected to contain ${JSON.stringify(sub)} but got: ${JSON.stringify(at(n))}`);
}
// boundary assertions (original 1-based)
expectAt(20, `npm run check:host-consumers`);
expectAt(22, "HOST_DIR_MISSING");
expectAt(163, `id: "host-consumers"`);
expectAt(571, `step.gate === "hosts"`);
expectAt(591, "}");
expectAt(632, `"host-consumers": { kind: "open-gate"`);
expectAt(1854, "// ⑮b");
expectAt(1863, "}");
expectAt(2075, "// ①");
expectAt(2076, "{");
expectAt(2092, "}");
expectAt(2126, "// ②b");
expectAt(2140, "}");
expectAt(2141, "");
expectAt(2147, "result.steps.length === PREFLIGHT_STEPS.length");
expectAt(2150, "check:release:model-e2e");
expectAt(2150, "--hosts");
expectAt(2184, '|| line.includes("check:host-consumers")');

// replacement blocks (0-based start index, inclusive end 1-based)
const drops = new Set();       // line numbers to delete
const repl = new Map();        // startLine(1-based) -> { end, text }
for (const n of [20]) drops.add(n);
for (let n = 571; n <= 591; n++) drops.add(n);
for (const n of [632]) drops.add(n);
for (let n = 2126; n <= 2141; n++) drops.add(n);

repl.set(22, { end: 22, text: "//              整体 exit 2（不是 0）。" });

repl.set(1854, { end: 1863, text: `  // ⑮b 只有闸门类未判定 ⇒ 说开闸，**不**提切版（分叉不是恒说切版）
  {
    const { head, lines } = unjudgedConclusion(un("release-real"));
    expect(/把闸开起来再发/u.test(head) && !/先把版切了/u.test(head),
      \`⑮b 只有闸门类格子未判定 ⇒ 结语是「把闸开起来再发」（head=\${head}）\`,
      \`⑮b 闸门类格子的结语串了切版那一句：\${head}\`);
    expect(/ERIX_E2E_MODEL/u.test(lines.join("\\n")),
      "⑮b 逐格动作点名自己的开关（\`ERIX_E2E_MODEL\`）",
      \`⑮b 逐格动作缺开关名：\${lines.join(" | ")}\`);
  }` });

repl.set(2075, { end: 2092, text: `  // ① preflight 某步红 ⇒ 停在那一步并点名
  {
    const deps = fakeDeps({ override: { "npm run check:changelog": { status: 1 } } });
    // issue #715：\`root\` 用合成树（\`[Unreleased]\` 空 + 本版段已开 ⇒ 第 2 步绿），于是本格不依赖本仓
    // CHANGELOG 当下的状态（本仓 \`[Unreleased]\` 里本来就可能有待入账条目）。
    withPreflightFixture((tree) => {
      const result = runPreflight({ root: tree, hosts: [tree], deps, dry: true });
      expect(result.verdict === VERDICT.FAIL && result.failedAt === 1 && result.failedId === "changelog",
        \`① preflight 第 1 步红 ⇒ 停在第 1 步并点名 changelog（steps=\${result.steps.length}）\`,
        \`① 没停在第 1 步：verdict=\${result.verdict} failedAt=\${result.failedAt} failedId=\${result.failedId}\`);
      expect(!deps.calls.some((line) => line.includes("check:release")),
        "① 红之后的后续步骤一步都没跑（顺序闸：末步 check:release 不该被调到）",
        \`① 红了还在往下跑：\${deps.calls.filter((line) => line.includes("check:release")).join(", ")}\`);
      expect(result.steps.at(-1)?.exitCode === 1, "① 红的那一步带着它的退出码（exit 1）",
        \`① 红的那一步没带退出码：\${JSON.stringify(result.steps.at(-1))}\`);
    });
  }` });

repl.set(2147, { end: 2152, text: `      expect(result.verdict === VERDICT.PASS && result.steps.length === PREFLIGHT_STEPS.length,
        "②c 闸门开 + 每一步都全绿 ⇒ pass（对照组）",
        \`②c 对照组不绿：verdict=\${result.verdict} steps=\${JSON.stringify(result.steps)}\`);
      expect(deps.calls.some((line) => line.includes("check:release:model-e2e")),
        "②c 闸门开着时真模型端点真跑了",
        \`②c 闸门开着却没跑真模型端点：\${deps.calls.join(" | ")}\`);` });

// build output
const out = [];
let i = 1;
while (i <= lines.length) {
  if (repl.has(i)) {
    const { end, text } = repl.get(i);
    out.push(text);
    i = end + 1;
    continue;
  }
  if (drops.has(i)) { i++; continue; }
  // line 163: drop host-consumers step line
  if (i === 163) { i++; continue; }
  // line 2184: strip check:host-consumers from filter
  if (i === 2184) { out.push('        || line.includes("check:release:model-e2e"));'); i++; continue; }
  out.push(lines[i - 1]);
  i++;
}
writeFileSync(P, out.join("\n"), "utf8");
console.log("release-day.mjs rewritten. old", lines.length, "new", out.length);
