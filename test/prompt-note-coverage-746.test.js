// issue #746 —— 覆盖面守卫（照 `test/event-tier-coverage-743.test.js` 的 T12 那条的形状写）。
//
// 为什么需要这一条：#741 在两份架构文档里写的是「**覆盖面就是这两处，不多**」/「Coverage is exactly
// those two entry points — nothing more」。#746 把其余六处接上同一个证据门之后，那句话**自己变成假话**
// ——而文档里的全称话不会自己变红：下一次有人「照着文档」往第八个入口硬写 `note_list`，全绿的门禁
// 一声不响。本条把「覆盖面」这个词钉回**实际覆盖面**：文档必须带限定并逐处列举，源码必须真接了门。
//
// 反证（真红过，改回原措辞再跑）：
//   ① 把 `docs/architecture_cn.md` 那句限定改回「覆盖面就是这两处，不多」⇒ `G1` exit 1；
//   ② 把 `docs/architecture.md` 那句改回 "Coverage is exactly those two entry points" ⇒ `G1` exit 1；
//   ③ 从任一处源码里撤掉证据门（例如把 `aggregate-budget.js` 的 import 删掉）⇒ `G2` exit 1。
//
// 零 LLM、零写盘、不碰真实 `~/.erix`：只读源码与两份文档文本。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const DOC_EN = join(ROOT, "docs", "architecture.md");
const DOC_CN = join(ROOT, "docs", "architecture_cn.md");

/**
 * 证据门**实际**接到的入口（文档必须逐处点名，源码必须真接）。
 * `gate` 是这个入口"接了门"的**源码可检证据**：一个只有接上才会出现的标识符。
 *
 * @type {Array<{ file: string, docNames: string[], gate: string, why: string }>}
 */
const GATED_SITES = [
  {
    file: "src/loop/aggregate-budget.js",
    docNames: ["src/loop/aggregate-budget.js"],
    gate: "noteRecallHint",
    why: "S1 聚合超限桩：文案从 `retrieval.clause` 取",
  },
  {
    file: "src/loop/run-snapshot-executor.js",
    docNames: ["src/loop/run-snapshot-executor.js"],
    gate: "noteRecallHint",
    why: "S2 run snapshot 的逐条超限桩 + 聚合归档桩",
  },
  {
    file: "bin/final-guard.js",
    docNames: ["bin/final-guard.js"],
    gate: "noteRecallHint",
    why: "B2 guard 的 run 状态摘要与打回指针",
  },
  {
    file: "bin/final-guard-support.js",
    docNames: ["bin/final-guard-support.js"],
    gate: "noteRecallHint",
    why: "B3 折叠桩后缀",
  },
  {
    file: "bin/system-prompt.js",
    docNames: ["bin/system-prompt.js"],
    gate: "hasNoteToolSurface",
    why: "B1 的装配点：从**装配后的真工具面**现推 `notes` 事实并递给 `bin/tools.js`",
  },
  {
    file: "bin/tools.js",
    docNames: ["bin/tools.js"],
    gate: "hasNotes ? CLI_TOOLS_SYSTEM_PROMPT_SITUATION_NOTES",
    why: "B1 的系统提示「你的处境」段 / 「具体数值来源」bullet / 归档提示：三处都走 `notes` 分支",
  },
];

/**
 * 低风险档（工单点名「别套整族证据门」）：只要求**条件式措辞 + 不命令调工具**，
 * 因此它的 `gate` 是**反向**的——这一处源码里出现 `note_list` / `note_read` 就该红。
 */
const LOW_RISK_SITE = {
  file: "src/reflection/governor.js",
  docName: "src/reflection/governor.js",
};

function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8");
}

/**
 * 去掉注释后的**代码文本**（行注释与块注释都剥掉）。
 *
 * 为什么：本文件的判据要钉的是「模型可见文本里有没有硬编码的取回指引」，而**解释性注释**里提到
 * `note_list` 是必要的（那里写的正是"为什么这里不再有它"）。把注释算进判据，就会逼作者删掉解释——
 * 与本仓「注释写为什么」的规矩正好相反。
 *
 * ⚠ 这是行级近似（不解析语法）：字符串里若出现 `//` 会被截一半。本判据只数 `note_*` 字面，
 * 现有文件里不存在这种字符串；新增时若踩到，宁可让计数红一次再来这里的表里说明。
 *
 * @param {string} text
 * @returns {string}
 */
function codeOnly(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .map((line) => line.replace(/\/\/.*$/u, ""))
    .join("\n");
}

test("G1 覆盖面表述：两份架构文档都必须带限定并逐处点名实际入口（改回全称话就红）", () => {
  const en = readFileSync(DOC_EN, "utf8");
  const cn = readFileSync(DOC_CN, "utf8");

  // ① 全称话退役：#741 那句「不多 / nothing more」若被改回去，本节就与源码打架。
  assert.equal(
    /覆盖面就是这两处/u.test(cn),
    false,
    "cn：覆盖面早已不止 #741 那两处，全称话必须换成带 #746 的限定表述",
  );
  // ⚠ 只禁**作陈述用的**全称话：本段后来引用旧措辞时是带引号的（`“coverage is exactly …”`），
  // 那是历史引用不是主张。所以判据盯的是 markdown 里**未加引号**的那一形（`**Coverage is exactly …`）。
  assert.equal(
    /\*\*Coverage is exactly those\s*\n?\s*two entry points/iu.test(en),
    false,
    "en: the #741 universal claim is back as an assertion; it must name the #746 coverage instead",
  );
  assert.equal(
    /\*\*覆盖面就是这两处/u.test(cn),
    false,
    "cn: 加粗的#741 全称话又回来了（它现在只是历史引用，不该再作主张）",
  );

  // ② 必须点名 #746，并给出「只有这些」的限定（不是含糊的「更多处」）。
  assert.match(cn, /覆盖面到 issue #746 为止是下面这些入口，且只有这些/u, "cn：限定表述本体不在");
  assert.match(en, /Coverage, as of issue\s*\n?\s*#746, is exactly the entry points listed below/u, "en: qualifier missing");

  // ③ 逐处点名：文档漏列任一真接了门的入口 ⇒ 红（这正是「照着文档写漏第八处」的形状）。
  for (const site of GATED_SITES) {
    for (const name of site.docNames) {
      assert.ok(cn.includes(`\`${name}\``), `cn：覆盖面表述漏点名 ${name}（${site.why}）`);
      assert.ok(en.includes(`\`${name}\``), `en: coverage statement omits ${name} (${site.why})`);
    }
  }
  assert.ok(cn.includes(`\`${LOW_RISK_SITE.file}\``), "cn：低风险档也必须点名，并写明它**不**套门");
  assert.ok(en.includes(`\`${LOW_RISK_SITE.file}\``), "en: the low-risk tier must be named too");
  assert.match(cn, /不套整族证据门/u, "cn：低风险档「不套门」这个差别本身要被写下来，否则下一个人会补上");
  assert.match(en, /does \*\*not\*\*\s*\n?\s*get\s*\n?\s*the whole-family evidence gate/u, "en: low-risk distinction missing");

  // ④ 证据口径也要在文档里（`bin/` 侧看**装配事实**而不是 `--no-notes` 旗标——这条是今晚的新发现）。
  assert.match(cn, /装配后的真工具面/u);
  assert.match(en, /\*\*assembled\*\* tool surface/u);
});

test("G2 每处真接了门：源码里必须有该入口「接上证据门」的唯一标识符", () => {
  for (const site of GATED_SITES) {
    const source = read(site.file);
    assert.ok(
      source.includes(site.gate),
      `${site.file} 里找不到「${site.gate}」⇒ ${site.why} 这条门被撤了（文档那句限定随即成假话）`,
    );
  }
});

test("G3 低风险档反向钉：governor 里不许再出现 note_list / note_read 的硬编码指引", () => {
  const source = codeOnly(read(LOW_RISK_SITE.file));
  assert.equal(
    /note_(list|read)/u.test(source),
    false,
    "S3 是低风险档：工单只要求条件式措辞。这一句里出现 `note_list` / `note_read` 就等于又回到无条件指引",
  );
});

test("G4 唯一豁免：只读工具白名单那句是能力陈述（#195），豁免表不许悄悄变宽", () => {
  // 计数口径 = **代码文本**里的 `note_*` 字面（见 `codeOnly`：解释性注释不算，否则等于逼作者删掉为什么）。
  // 每个数字都是一处**已知**的合法出现：工具名常量（#195 的只读白名单、#741 的整族名单）、
  // 证据门给出的那句指引本体、或工具自身的名字面。多一个数字 ⇒ 新写了一条硬编码指引；
  // 少一个 ⇒ 取回指引本体被删。两种都必须先改两份文档的覆盖面表述，再改这张表，并在 CHANGELOG 说一句。
  const EXPECTED = new Map([
    // #195 的只读工具白名单里那两个名字：能力陈述，不是取回指令（工单点名不在范围内）。
    ["src/loop/run-snapshot-executor.js", 2],
    ["src/loop/aggregate-budget.js", 0],
    ["src/reflection/governor.js", 0],
    // 门本体：整族名单 + 那句 note-first 指引，各一处。
    ["src/loop/note-prompt-hint.js", 2],
    ["src/loop/tool-result-ttl.js", 9],
    ["src/loop/orchestrator.js", 0],
    // `bin/tools.js`：工具清单行的短语表（描述工具本身）+ 有笔记面那一份处境段与数值 bullet。
    ["bin/tools.js", 10],
    ["bin/system-prompt.js", 0],
    ["bin/final-guard.js", 0],
    ["bin/final-guard-support.js", 0],
  ]);
  for (const [file, expected] of EXPECTED) {
    const hits = (codeOnly(read(file)).match(/note_(take|list|read|forget)/gu) ?? []).length;
    assert.equal(
      hits,
      expected,
      `${file}：代码里 note_* 字面 ${hits} 次，登记值 ${expected} —— 多了就是有人又硬写了一条取回指引，`
      + "少了就是指引本体被删；两种都要先改两份文档的覆盖面表述，再改这张表（并在 CHANGELOG 说一句）",
    );
  }
});

test("G5 依赖方向：`src/` 永远不许为了 `bin/` 的成立而 import `bin/`", () => {
  for (const site of GATED_SITES) {
    if (!site.file.startsWith("src/")) continue;
    const source = read(site.file);
    assert.equal(
      /from\s+["'][^"']*\/bin\/|require\(["'][^"']*\/bin\//u.test(source),
      false,
      `${site.file}（src/）import 了 bin/ —— AGENTS.md §1 的依赖方向被反了`,
    );
  }
});
