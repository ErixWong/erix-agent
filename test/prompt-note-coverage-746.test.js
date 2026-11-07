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

// 反向守卫要读**装配后**的那段文本，所以现取 CLI 提示词的装配函数（bin -> src 的方向合法）。
// 第 3 轮另取 `buildChildSystemPrompt`：子 run 的那一份是同一位点的子侧，探针不能只看父侧。
const cliPromptModule = await import("../bin/system-prompt.js");
const childModule = await import("../bin/delegation.js");
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
  {
    // 评审必修 2（第 2 轮）+ 第 3 轮必修①：子的提示词以前恒按「有笔记」装配，而子的折叠桩早已现推。
    // `gate` 取的是「builder 自己从名单现推」那一句：把它改回「拿缺省值当存在」就找不到它了。
    file: "bin/delegation.js",
    docNames: ["bin/delegation.js"],
    gate: "notesOnToolNames(surfaceNames)",
    why: "子 run 的系统提示（清单行 + 处境段 + 归档提示同一份名单现推）与子的折叠桩 / 恢复提示：同一个事实源",
  },
];

/**
 * 改判登记表里**每一条的理由**（第 3 轮：评审拓「理由未被契约锁定」——文件名在文档里不算登记）。
 * `cn` / `en` 是必须逐字出现在对应那份文档里的短句；两边都只取**自包含**的那一截，
 * 以免 markdown 换行把锛拆开。改措辞就同步改这里，不是删断言。
 */
const CAPABILITY_STATEMENT_REASONS = [
  { site: "bin/system-prompt.js（CLI 系统提示 + 归档提示）", cn: "那一层根本没有账本可拿", en: "there is no ledger to consult" },
  {
    site: "bin/system-prompt.js（理由②：条件式工作流不是存在断言）",
    cn: "条件式工作流",
    en: "conditional workflow",
  },
  {
    site: "bin/system-prompt.js（理由④：缺省文案被逐字节 golden 钉住）",
    cn: "逐字节 golden",
    en: "byte-for-byte by goldens",
  },
  { site: "src/loop/run-snapshot-executor.js（#195 白名单）", cn: "不是一条取回指令", en: "a capability statement, not a retrieval instruction" },
  { site: "src/reflection/governor.js（低风险档）", cn: "它不命令调用任何工具", en: "it never commands a tool call" },
  { site: "examples/pi-extension/erix-run-core.js（宿主同位点）", cn: "尚未接工具面门", en: "is not yet on the tool-surface gate" },
];

/**
 * **刻意只接工具面门、不接账本证据门**的位点（第 2 轮的改判登记，逐条带理由）。
 * 它们不是「暂时没做」：接了证据门反而会说出新的谎。文档两份都必须逐条点名并给出理由。
 */
const CAPABILITY_STATEMENT_SITES = [
  {
    file: "bin/system-prompt.js",
    // 子 run 的那一份是同一位点的子侧（第 3 轮）：同一个定性，只是入口是 `notesOnToolNames`。
    alsoNames: ["bin/tools.js", "bin/delegation.js"],
    reason: "装配发生在 run 开始之前，那一层没有账本可拿",
  },
  { file: "src/loop/run-snapshot-executor.js", alsoNames: [], reason: "#195 的只读白名单是能力面陈述" },
  { file: "src/reflection/governor.js", alsoNames: [], reason: "低风险档：提醒不是存在断言" },
  { file: "examples/pi-extension/erix-run-core.js", alsoNames: [], reason: "宿主同位点，且仍未接工具面门（已知缺陷）" },
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
 * 把空白（含 markdown 硬换行）折叠成单空格，供**散文句子**级的锛比对用。
 *
 * 为什么需要：两份架构文档是 100 列左右 manually wrap 的散文，任何超过一行的句子都会被
 * 换行切成两块；直接 `includes` 会拓在自己的排版上，而不是拓在「这句话有没有被登记」上。
 * 只用于理由 / 说明这类散文；路径与符号名那类锛仍走逐字 `includes`（它们不该被换行切开）。
 *
 * @param {string} text
 * @returns {string}
 */
function flatten(text) {
  return String(text).replace(/\s+/gu, " ").trim();
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
  assert.match(en, /Coverage, as of issue\s*\n?\s*#746 is a registered roster/u, "en: qualifier missing");

  // ③ 逐处点名：文档漏列任一真接了门的入口 ⇒ 红（这正是「照着文档写漏第八处」的形状）。
  for (const site of GATED_SITES) {
    for (const name of site.docNames) {
      assert.ok(cn.includes(`\`${name}\``), `cn：覆盖面表述漏点名 ${name}（${site.why}）`);
      assert.ok(en.includes(`\`${name}\``), `en: coverage statement omits ${name} (${site.why})`);
    }
  }
  assert.ok(cn.includes(`\`${LOW_RISK_SITE.file}\``), "cn：低风险档也必须点名，并写明它**不**套门");
  assert.ok(en.includes(`\`${LOW_RISK_SITE.file}\``), "en: the low-risk tier must be named too");
  assert.match(cn, /低风险档/u, "cn：低风险档这一档本身要被写下来，否则下一个人会把它并进整族门");
  assert.match(en, /low-risk tier/u, "en: the low-risk tier must be named");

  // ④ 证据口径也要在文档里（`bin/` 侧看**装配事实**而不是 `--no-notes` 旗标——这条是今晚的新发现）。
  assert.match(cn, /装配后的真工具面/u);
  assert.match(en, /assembled tool surface/u);
});

test("G1b 改判登记：刻意不接账本证据门的位点必须两份点名（漏一条 ⇒ 红）", () => {
  const en = readFileSync(DOC_EN, "utf8");
  const cn = readFileSync(DOC_CN, "utf8");
  assert.match(cn, /刻意只接工具面门、不接账本证据门的能力陈述/u, "cn：这一类的标题不在，等于把改判说成漏做");
  assert.match(en, /Capability statements[\s\S]{0,80}never on the ledger gate/u, "en: the reclassification heading is missing");
  assert.match(cn, /\*\*工具面门\*\*[\s\S]{0,120}\*\*账本证据门\*\*/u, "cn：两道门的区分必须写下来（否则第 2 轮的改判读起来像偷懒）");
  assert.match(en, /\*\*tool-surface\s*\n?gate\*\*[\s\S]{0,160}\*\*ledger-evidence\s*\n?gate\*\*/u, "en: the two-gate distinction is missing");
  for (const site of CAPABILITY_STATEMENT_SITES) {
    assert.ok(cn.includes(`\`${site.file}\``), `cn：改判清单漏点名 ${site.file}`);
    assert.ok(en.includes(`\`${site.file}\``), `en: the reclassified roster omits ${site.file}`);
    for (const extra of site.alsoNames) {
      assert.ok(cn.includes(`\`${extra}\``) && en.includes(`\`${extra}\``), `改判清单漏点名伴随位点 ${extra}`);
    }
  }
  // 理由必须真的写在文档里（只有文件名 = 下一个人会把它当漏做补上）。
  assert.match(cn, /把「不知道」伪报成「本场没写过」/u);
  assert.match(en, /reports "not known" as "this run recorded nothing"/u);

  // 第 3 轮（评审必修④的另一半）：`reason` 以前只是表里一个没被断言的字符串——文档里没记某条理由
  // 时守卫照旧绿。现在逐条钉：改判依据不在两份文档里 ⇒ 红（措辞可改，但要同改这里）。
  // 比对前先把空白折叠掉：markdown 的硬换行会把锛拆成两行（不比原文，只比「这句话在不在」）。
  const flatCn = flatten(cn);
  const flatEn = flatten(en);
  for (const anchor of CAPABILITY_STATEMENT_REASONS) {
    assert.ok(
      flatCn.includes(flatten(anchor.cn)),
      `cn：改判理由缺失——${anchor.site} 的「${anchor.cn}」不在文档里`,
    );
    assert.ok(
      flatEn.includes(flatten(anchor.en)),
      `en: the registered reason is missing — ${anchor.site}: "${anchor.en}"`,
    );
  }
});

test("G1c 反向守卫：CLI 系统提示 / 归档提示 / 子 run 提示里不许出现**存在断言**（改判的代价由这一条付）", () => {
  // 登记为「能力陈述」的代价是：这一段永远不许说「你已经记过的笔记 / 笔记里有」。
  // 那类句子一旦回来，它就从能力陈述滑成存在断言，而这一位**没有**账本证据 ⇒ 又是一次伪报。
  //
  // ⚠ 探针必须**带 `archiveDir`**（第 3 轮修的缺口）：`buildArchiveNotice` 只在拿到目录时才输出东西，
  // 不传目录 ⇒ 归档提示根本不在被扫的文本里，往归档提示里塞存在断言 ⇒ 守卫照旧绿（第 2 轮就是这样
  // 漏的：评审实测「归档提示的存在断言变异 ⇒ G1c exit 0」）。下面带 `OBSERVED` 那一格就是这一支的
  // 观测自证：探针丢了 archiveDir 或归档提示被删，那一格自己先红。
  const ARCHIVE_DIR = "/tmp/erix-746-archive-probe";
  const EXISTENCE_CLAIM = /(你已记录|你已经记录|已记录的笔记|笔记里有|笔记中已|笔记里存在|已经记下|记录过的笔记|the notes you (recorded|took)|notes contain|your recorded notes|you have already recorded|already recorded notes)/u;
  const probes = [
    // 父侧两份：缺省工具面（笔记在场上）与 `--tools` 滤掉笔记（`tools: []` ⇒ `notesOnToolSurface` 报 false）。
    { name: "CLI 系统提示（有笔记面 + 归档提示）", text: String(cliPromptModule.buildCliSystemPrompt({ cwd: ROOT, archiveDir: ARCHIVE_DIR, agents: false }).systemPrompt ?? ""), archive: true, notes: true },
    { name: "CLI 系统提示（无笔记面 + 归档提示）", text: String(cliPromptModule.buildCliSystemPrompt({ cwd: ROOT, archiveDir: ARCHIVE_DIR, agents: false, tools: [{ name: "readFile" }] }).systemPrompt ?? ""), archive: true, notes: false },
    // 子侧两份（第 3 轮同一把尺）：缺省面与窄名单（窄名单 ⇒ builder 自己从 `toolNames` 推出无笔记）。
    { name: "子 run 提示词（缺省面 + 归档提示）", text: childModule.buildChildSystemPrompt({ cwd: ROOT, archiveDir: ARCHIVE_DIR }), archive: true, notes: true },
    { name: "子 run 提示词（窄名单 + 归档提示）", text: childModule.buildChildSystemPrompt({ cwd: ROOT, archiveDir: ARCHIVE_DIR, toolNames: ["readFile"] }), archive: true, notes: false },
    // 不带归档的那一组也留着：归档提示丢了不能变成「本守卫不再看它」。
    { name: "CLI 系统提示（缺省）", text: String(cliPromptModule.buildCliSystemPrompt({ cwd: ROOT, agents: false }).systemPrompt ?? ""), archive: false, notes: true },
  ];
  for (const probe of probes) {
    assert.equal(
      EXISTENCE_CLAIM.test(probe.text),
      false,
      `${probe.name} 里出现了存在断言（这一位刻意不接账本证据门，于是它没有资格断言「记过什么」）：\n${probe.text.slice(0, 600)}`,
    );
    if (probe.archive) {
      // 观测自证：归档提示本体必须在被扫的文本里（丢了 = 归档那一支重新变成无人看）。
      assert.match(probe.text, /\[工具输出归档\]/u, `${probe.name}：归档提示不在探针文本里 ⇒ archiveDir 没递进来或归档提示被删`);
      assert.ok(
        probe.notes ? /先用 note_list 查找记录/u.test(probe.text) : /本场没装配笔记工具/u.test(probe.text),
        `${probe.name}：归档提示的那一支不在观测范围内（notes=${probe.notes}）`,
      );
    }
    if (probe.notes === false) {
      // 无笔记工具面那一支的附赠判据：一个 `note_*` 都不得出现（第 3 轮的窄名单就靠这一格兑现）。
      assert.equal(/note_/u.test(probe.text), false, `${probe.name}：无笔记工具面却仍在提 note_*：\n${probe.text.slice(0, 400)}`);
    }
  }
  // 自证：这条判据不是恒绿——把存在断言塞进去必须红（中英各一条，防正则退化）。
  assert.ok(
    EXISTENCE_CLAIM.test('需要精确值时先查笔记：本场装配了 note_*，你已记录的笔记里有它的精确值。'),
    "反向守卫自证失败：存在断言的样式根本匹配不到，等于没有守卫",
  );
  assert.ok(
    EXISTENCE_CLAIM.test("Look before you re-read: the notes you recorded carry the exact value."),
    "反向守卫自证失败（英文那一形）：英文存在断言匹配不到，等于只钉了中文",
  );
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
    ["src/loop/note-prompt-hint.js", 4],
    ["src/loop/tool-result-ttl.js", 9],
    ["src/loop/orchestrator.js", 0],
    // `bin/tools.js`：工具清单行的短语表（描述工具本身）+ 有笔记面那一份处境段与数值 bullet。
    ["bin/tools.js", 10],
    ["bin/system-prompt.js", 0],
    // 子 run 提示词的本体（第 3 轮）：处境段 / 清单行 / 归档提示全部走 `bin/tools.js` 的那两份
    // 文案，本文件自己**零**个 `note_*` 字面——多一个就是有人在子侧又硬写了一条取回指引。
    ["bin/delegation.js", 0],
    ["bin/final-guard.js", 0],
    // B3 本文件里**零**个 `note_*` 字面：后缀整句都从 `src/` 的派生器取（口径漂不了）。
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
