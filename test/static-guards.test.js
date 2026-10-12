// issue #257 T3：静态守卫。病根是「假配置的形状由测试自己造、断言由同一个人写，于是永远碰不到
// 真形状」——真实事故是把 provider 槽位名写死成 `my-relay`，真机器上没有这个名字，`LLM_KIT_E2E=1`
// 的 4 个真实场景起跑即失败、瞎了约三周（同类：断言里调 0.8.0 已退役的 `store.recall`）。
//
// 三条规则（**取舍口径：宁可窄而真**，每条都同时断言扫描面不退化）：
//   1. examples/ test/ bin/ src/ 里不许出现**字面 provider 槽位名**；名字一律从 fixtures/config-shape.mjs 拿。
//      守卫自己也被这条管住（见「规则 1 自审」）。
//   2. 已退役的适配器/store 方法名不许再被调用（`store.recall` 那一类，出处逐条写死）。
//   3. 命令行旗标：接受集合**从 bin/cli.js 现推**（不手抄清单），凡是挂在 `erix` 命令行上的旗标
//      不在接受集合里就红；「已退役」名单同样从 CHANGELOG 现推，不手抄。
//
// 误报是第 3 条的头号风险（`--help`、npm/tsc/rg/pi 的参数、docs 里的历史叙述都会命中），所以
// 范围收到「只有挂在 erix 命令行上的旗标才算 erix 的旗标」，并在报告里如实写清扫了什么、豁免了什么。
//
// 本文件在 test/ 根：它自己就是测试文件。临时目录走 test/helpers/tmp.js 的 makeTmp（卫生门禁口径）。
// 绝不写真实的 ~/.erix 与 ~/.pi。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { before, describe, it } from "node:test";

import {
  ERIX_CONFIG_SLOT,
  ERIX_SLOT_CORE_KEYS,
  HISTORIC_RELAY_PROVIDER_SLOT,
  MODEL_CONFIG_ENV_NAMES,
  RELAY_ENTRY_KEYS,
  RELAY_PROVIDER_SLOT,
  createFakeConfigHome,
  erixConfigShape,
  fakeHomeEnv,
  relayModelsShape,
  relayProviderEntry,
  upstreamFields,
} from "../fixtures/config-shape.mjs";
import { createScriptedUpstream, jsonResponse } from "../fixtures/upstream.mjs";
import { makeTmp } from "./helpers/tmp.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SELF = relative(ROOT, new URL(import.meta.url).pathname).split("\\").join("/");

const CODE_EXTS = new Set([".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

function* walk(absDir, exts) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) yield* walk(abs, exts);
    else if (entry.isFile() && exts.has(extOf(entry.name))) yield abs;
  }
}

/** 扫描面：目录/文件 → 可扫文件（相对路径同时给出，报错信息好读）。 */
function* listScannable(exts, ...entries) {
  for (const entry of entries) {
    const abs = resolve(ROOT, entry);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      for (const file of walk(abs, exts)) yield { abs: file, rel: relative(ROOT, file).split("\\").join("/") };
    } else if (exts.has(extOf(entry))) {
      yield { abs, rel: entry.split("\\").join("/") };
    }
  }
}

/** 整行注释（含 JSDoc 续行）不算「代码里出现」——文档式注释里提名字是正当的。 */
function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("#");
}

function readLines(abs) {
  return readFileSync(abs, "utf8").split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// 规则 1：字面 provider 槽位名
// ---------------------------------------------------------------------------

/**
 * 受管名字集合：形状 B 的默认槽位名 + 事故里那个写死的名。
 * **形状 A 的 `ERIX_CONFIG_SLOT` 故意不在里面**：它的值是 `default`，在源码里是无处不在的
 * 普通词（JS 关键字、目录名、策略名），按字面量拦会淹死在误报里；形状 A 的槽位也不由命令行
 * 选择，写死它的风险面小得多。这条排除是**有意的窄**，写在这里而不是藏在代码里。
 */
const GUARDED_SLOT_NAMES = Object.freeze([RELAY_PROVIDER_SLOT, HISTORIC_RELAY_PROVIDER_SLOT]);

/** 字面槽位名的三种真会当槽位用的形状：引号字面量、`providers["名"]` 下标、erix 命令行上的槽位参数。 */
function slotLiteralMatchers(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    { re: new RegExp(`["'\`]\\s*${esc}\\s*["'\`]`), via: "引号字面量（含 `providers[\"名\"]` 下标）" },
    { re: new RegExp(`(?:--provider|-p)\\s+${esc}\\b`), via: "命令行里写死槽位名" },
    { re: new RegExp(`\\b${esc}\\b[^\\n]{0,20}?(?:--provider|-p)\\b`), via: "槽位名紧跟 provider 旗标" },
  ];
}

/**
 * 规则 1 的豁免：必须点名到**具体文件**、写**为什么**，且这轮**真的命中**（不留僵尸豁免）。
 */
const SLOT_NAME_EXEMPTIONS = Object.freeze([
  // 本轮实测：0 条。合并 PR #261 之前确实一个都没有；合并后 T4 的新增文案里出现过一次
  // （消息字符串里写死了事故名），已按本规则的口径改成从 fixtures/config-shape.mjs 的常量拿，
  // **没有开豁免**——那个文件正是事故现场，整文件放行等于把规则从最该管的地方撤走。
  // 表留着是为了「下次真需要豁免时必须点名文件 + 写理由」，下面的僵尸检查会保证
  // 它不会慢慢长成一堆整类放行。
]);

/**
 * 规则 3 的「已知不是 erix 旗标」豁免：同样只按**确切文件名**放行，逐条带理由，不允许 glob/目录。
 * 只收一类：提案 / 评审意见文档——它们写的是「建议加这个旗标」，不是「erix 接受这个旗标」。
 */
const EXEMPT_UNKNOWN_FILES = Object.freeze([
  {
    file: "docs/suggestions/comment-on-179.md",
    reason: "提案/评审意见文档：出现处是「An optional `--root-only` flag makes…」（建议加，不是已实现）；该旗标在 bin/cli.js 与 CHANGELOG 里都不存在",
  },
]);

// ---------------------------------------------------------------------------
// 规则 2：已退役的适配器 / store 方法名
// ---------------------------------------------------------------------------

/**
 * 每条都写清「退役于哪个 issue/版本口径」与出处符号（**不写行号**）。出处都是仓内可查的文本：
 * CHANGELOG 的退役条目、README/契约里写明的「recall 适配器已在 0.8.0 契约中退役」。
 */
const RETIRED_ADAPTER_METHODS = Object.freeze([
  {
    method: "recall",
    source: "CHANGELOG「退役 recall 工具与 bounded-recall 协议（issue #36）」+ README/docs/host-consumer-contract.md（recall 适配器已在 0.8.0 契约中退役）",
  },
  {
    method: "boundedRecall",
    source: "CHANGELOG 同一条：「宿主如依赖 `boundedRecall` 公共导出或 recall 工具需改造为 note 工作流」（issue #36）",
  },
  {
    method: "recordAutoCapture",
    source: "CHANGELOG「删除 `recordAutoCapture()`（issue #67 PR 3，ADR-016 收尾）」",
  },
  {
    method: "captureToolExecution",
    source: "CHANGELOG「auto-capture 退役：`bin/auto-capture.js` 删除」+ ADR-016（可重放概念退役，见 test/capture-honesty.test.js 头注）",
  },
]);

/**
 * 现役 memory store 的 API（事故里「有 recall 没有」的那一份名单，抄自 CHANGELOG 的 #257 条目）。
 * 用途只有两个：① 证明本规则的匹配器**不会误报现役名**；② 名单本身要能在 src/ 里查到，
 * 免得这份「反误报样本」自己腐化成编造。
 */
const CURRENT_STORE_API = Object.freeze([
  "appendRound", "load", "markRunState", "saveRunState", "saveRunSnapshot", "loadLatestRunSnapshot",
  "saveCheckpoint", "appendCheckpoint", "loadLatestCheckpoint", "loadRunState", "loadRunStateStatus",
]);

/** 匹配器：只认「方法调用」这一种形状（`.name(`），单词本身不算——注释、散文、工具名都不算。 */
function retiredCallHits(line, method) {
  return new RegExp(`\\.${method}\\s*\\(`, "g").test(line) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 规则 3：命令行旗标
// ---------------------------------------------------------------------------

/** 接受集合：bin/cli.js 文本里出现的长旗标（解析表 + `--help` 文案都在里面，宁松不紧）。 */
function parseAcceptedFlags() {
  const src = readFileSync(resolve(ROOT, "bin/cli.js"), "utf8");
  return new Set([...src.matchAll(/--+[A-Za-z][A-Za-z0-9-]{1,}/g)].map((m) => m[0]));
}

/**
 * 「已退役」名单**从 CHANGELOG 现推**，不手抄：要求**退役动词与反引号旗标相邻**（同一小句内，
 * 中间不超过 12 个非句读字符），而不是「整行提过退役就算」——CHANGELOG 的条目常常一整段写在
 * 一行里，按整行算会把别家工具的旗标也算成 erix 退役旗标（实测：tsc 的 `--checkJs` 就在一条
 * 写了「待退役选项」的长行里）。再要求它当前不在接受集合里（在就说明没退役）。
 * 这样新增退役条目不需要改守卫，也抄不出假名字。实测口径下推出的唯一条目是 `--notes-ledger`
 * （CHANGELOG：「移除 `--notes-ledger`、`ERIX_NOTES_LEDGER` …」，issue #74）。
 * ⚠ 这里曾写成 `` `(^[A-Za-z]…)` ``：那个 `^` 是**锚点**而不是字面量，正则永远碰不到，
 * 名单静默恒空——下面那条非空断言就是为了让这种死法当天变红。
 */
function deriveRetiredFlags(accepted) {
  const changelog = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8");
  const out = [];
  for (const line of changelog.split(/\r?\n/)) {
    if (!/退役|删除|移除/.test(line)) continue;
    // 两种词序都认：「移除 `--x`」与「`--x` 已删除」
    const re = /(?:移除|退役|删除|去掉)[^。；，\n]{0,12}?`(--[A-Za-z][A-Za-z0-9-]{1,})`|`(--[A-Za-z][A-Za-z0-9-]{1,})`[^。；，\n]{0,12}?(?:被|已)?(?:移除|退役|删除)/g;
    for (const m of line.matchAll(re)) {
      const flag = m[1] ?? m[2];
      if (!accepted.has(flag) && !out.some((e) => e.flag === flag)) {
        out.push({ flag, evidence: line.trim().slice(0, 120) });
      }
    }
  }
  return out;
}

/**
 * 哪些行算「erix 的命令行」。这是本条规则的全部收窄口径，写死在这里：
 *   - 文档（.md）：整行必须出现 `erix` 这个命令词（`erix chat …` / `` `erix --config` ``）。
 *     别家 CLI（npm/tsc/rg/node/pi/gh）的旗标行没有这个词，**结构上就不可能**被误报。
 *   - examples 代码：只有把旗标真的传给被调程序的那行才算——需要出现 argv/args/spawn/execFile/
 *     push("…--…") 之类的 argv 上下文，**或**该行同时提到 erix。
 * 代价如实写进报告：不挂在 erix 命令行上的 erix 旗标（例如只在散文里提一句）本规则看不见。
 */
const ERIX_COMMAND_RE = /(^|[\s`$>"'|])erix(\s|$|[`"'])/i;
const ARGV_CONTEXT_RE = /\b(argv|args|spawnSync|spawn\(|execFile|execFileSync|runCli|command|push)\b/;

/**
 * 否定句里的旗标**不是**「声称 erix 接受这个旗标」。实测误报就是这一类：
 * `README_cn.md` 与 `docs/host-upgrade-guide-0.19.0*.md` 都写着「**没有 `--resume` 这个旗标**」
 * （英文版「there is **no `--resume` flag**」），同一行里又出现 `erix chat -r`，所以光靠
 * 「整行要有 erix 词」拦不住——不拦就得给整个 README_cn.md 开豁免，那太贵。
 * 口径：只看旗标**前 24 个字符**，去掉 markdown 强调符/引号/空白后，必须以否定词收尾
 * （中文：没有/不存在/并非/不是/不再有/不含/无；英文整词：no/not/never/without）。
 * 故意只往回看、不往后看：「用 --x 而不是 --y」这类句子中后面的 --y 才是真实意图的反面，
 * 而它前面没有否定词→依旧计红，方向是**偏严**。
 */
const NEGATION_TAIL_RE = /(?:没有|不存在|并非|不是|不再有|不含|无|(?:^|[\s,，。;；:!?])(?:no|not|never|without))\s*$/u;

function isNegatedMention(line, flagStart) {
  // 只抹 markdown 强调符与引号（**没有 ` → 没有），空白要留着当英文否定词的词界
  const window = line.slice(Math.max(0, flagStart - 24), flagStart).replace(/[*_`"]/g, "");
  return NEGATION_TAIL_RE.test(window);
}

/** 测试用：拿「整行 + 旗标」直接问口径（下标自己找，免得用例里写死位置）。 */
function negationProbe(line, flag) {
  const at = line.indexOf(flag);
  return at >= 0 && isNegatedMention(line, at);
}

function flagMentions({ rel, abs }, accepted, retired) {
  const mentioned = [];
  const unknown = [];
  const isDoc = extOf(rel) === ".md";
  readLines(abs).forEach((line, index) => {
    if (isCommentLine(line)) return;
    const erixLine = ERIX_COMMAND_RE.test(line);
    if (!erixLine && !(isDoc || !isDoc)) return;
    if (!isDoc && !erixLine && !ARGV_CONTEXT_RE.test(line)) return;
    if (isDoc && !erixLine) return;
    for (const m of line.matchAll(/(^|[\s"'`=])((?:--)[A-Za-z][A-Za-z0-9-]{1,})/g)) {
      const flag = m[2];
      if (isNegatedMention(line, m.index + m[1].length)) {
        mentioned.push({ flag, rel, line: index + 1, status: "negated" });
        continue;
      }
      if (accepted.has(flag)) { mentioned.push({ flag, rel, line: index + 1, status: "accepted" }); continue; }
      if (retired.some((e) => e.flag === flag)) {
        // 退役旗标**只在文档里豁免**：docs / README 提历史叙述是正当的；examples/ 的 erix 命令行上
        // 再出现退役旗标就是「示例没跟上」，那正是本规则要抓的东西（工单反向证 3）。
        if (isDoc) {
          mentioned.push({ flag, rel, line: index + 1, status: "retired" });
          continue;
        }
        mentioned.push({ flag, rel, line: index + 1, status: "unknown" });
        unknown.push({ flag, rel, line: index + 1, text: line.trim().slice(0, 160), retiredInDocs: true });
        continue;
      }
      if (EXEMPT_UNKNOWN_FILES.some((e) => e.file === rel)) {
        mentioned.push({ flag, rel, line: index + 1, status: "exempted" });
        continue;
      }
      mentioned.push({ flag, rel, line: index + 1, status: "unknown" });
      unknown.push({ flag, rel, line: index + 1, text: line.trim().slice(0, 160) });
    }
  });
  return { mentioned, unknown };
}

// ---------------------------------------------------------------------------
// 真起 CLI 子进程（环境纪律与 fixtures/config-shape.mjs#fakeHomeEnv 一致）
// ---------------------------------------------------------------------------

/**
 * 异步跑一次 CLI。**不能用 spawnSync**：假上游就在本进程里，同步阻塞事件循环会让它收不到
 * 任何请求（实测：子进程挂到超时 ETIMEDOUT、上游 0 发）。
 */
function runErix(home, args) {
  const env = fakeHomeEnv(process.env, {
    home,
    extra: {
      PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LLM_KIT_RETRY_MAX_WAIT_MS: "1",
    },
  });
  // 代理会把环回请求带走，所以跟 test/cli-process.test.js 一样清掉，并把环回地址排除在外。
  const PROXY_VARS = [
    "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
  ];
  for (const key of PROXY_VARS) delete env[key];
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [resolve(ROOT, "bin/cli.js"), ...args], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolveRun({ status, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ status: null, signal: null, stdout, stderr: `${stderr}\nspawnError=${error.message}` });
    });
  });
}

/** 工单口径是 `README*`：根目录全部 README 开头的 markdown 都扫（`README.md` 与 `README_cn.md`）——
 * 只写死 `README.md` 会把中文那份的整批命令行整段放掉，而它同样会被人复制去跑。 */
function readmeEntries() {
  return readdirSync(ROOT).filter((name) => /^README[^/]*\.md$/i.test(name)).sort();
}

// ---------------------------------------------------------------------------

describe("静态守卫：真配置形状与退役名（issue #257 T3）", () => {
  let accepted = new Set();
  let retired = [];
  let mentions = [];
  let unknown = [];

  before(() => {
    accepted = parseAcceptedFlags();
    retired = deriveRetiredFlags(accepted);
    for (const file of listScannable(new Set([...CODE_EXTS, ".md"]), "examples", "docs", ...readmeEntries())) {
      const scan = flagMentions(file, accepted, retired);
      mentions.push(...scan.mentioned);
      unknown.push(...scan.unknown);
    }
  });

  // ---- 规则 1 -------------------------------------------------------------

  it("规则 1：examples/ test/ bin/ src/ 里没有字面 provider 槽位名", () => {
    assert.ok(GUARDED_SLOT_NAMES.length >= 2, "受管槽位名少于 2 个，本规则会假绿");
    const offenders = [];
    const hits = [];
    for (const { abs, rel } of listScannable(CODE_EXTS, "examples", "test", "bin", "src")) {
      readLines(abs).forEach((line, index) => {
        if (isCommentLine(line)) return;
        for (const name of GUARDED_SLOT_NAMES) {
          for (const { re, via } of slotLiteralMatchers(name)) {
            if (!re.test(line)) continue;
            hits.push(`${rel}|${name}`);
            if (!SLOT_NAME_EXEMPTIONS.some((e) => e.file === rel)) {
              offenders.push(`${rel}:${index + 1}: 字面槽位名 ${name}（${via}）：${line.trim().slice(0, 140)}`);
            }
          }
        }
      });
    }
    // 扫描面自检：豁免项必须真的被扫到，否则说明口径已经看不见它（规则会假绿）
    const hitSet = new Set(hits);
    for (const entry of SLOT_NAME_EXEMPTIONS) {
      assert.ok(
        GUARDED_SLOT_NAMES.some((n) => hitSet.has(`${entry.file}|${n}`)),
        `豁免表里的 ${entry.file} 这轮一个字面槽位名都没命中——口径退化或豁免该删`,
      );
    }
    assert.deepEqual(
      offenders,
      [],
      "字面 provider 槽位名会让「换一台机器/换一个槽位」的测试直接瞎掉（事故：写死一个机器专属槽位名，瞎了约三周）。"
      + `名字请从 fixtures/config-shape.mjs 的常量拿；确实必须出现这个名字的，进 SLOT_NAME_EXEMPTIONS 并写理由：\n  `
      + offenders.join("\n  "),
    );
  });

  it("规则 1 自审：守卫自己被这条规则管住（名字从构造器拿，源码里不写字面量）", () => {
    const src = readFileSync(resolve(ROOT, SELF), "utf8");
    const codeLines = src.split(/\r?\n/).filter((line) => !isCommentLine(line));
    for (const name of GUARDED_SLOT_NAMES) {
      const inCode = codeLines.filter((line) => line.includes(name)).length;
      assert.equal(inCode, 0, `守卫自己的代码里出现了槽位名 ${name}（${inCode} 行）：它必须只用常量`);
    }
    assert.ok(
      !SLOT_NAME_EXEMPTIONS.some((e) => e.file === SELF),
      "守卫不该给自己开豁免：它一个字面槽位名都不该有",
    );
    // 构造器那边也必须真的把名字藏起来了（只看非注释行：文档里提这个名字是正当的）
    const shapeCode = readFileSync(resolve(ROOT, "fixtures/config-shape.mjs"), "utf8")
      .split(/\r?\n/).filter((line) => !isCommentLine(line)).join("\n");
    for (const name of GUARDED_SLOT_NAMES) {
      assert.ok(
        !new RegExp(`["'\`]${name}["'\`]`).test(shapeCode),
        `构造器的代码里还有 ${name} 的字面量：常量的 join 写法被改掉了，守卫的自审前提失效`,
      );
    }
  });

  // ---- 规则 2 -------------------------------------------------------------

  it("规则 2：没有代码再调已退役的适配器 / store 方法名", () => {
    assert.ok(RETIRED_ADAPTER_METHODS.length >= 1, "退役方法名清单为空，本规则会假绿");
    for (const entry of RETIRED_ADAPTER_METHODS) {
      assert.ok(entry.source.length >= 20, `${entry.method} 的退役出处太短：${entry.source}`);
    }
    const violations = [];
    for (const { abs, rel } of listScannable(CODE_EXTS, "examples", "test", "bin", "src")) {
      readLines(abs).forEach((line, index) => {
        if (isCommentLine(line)) return;
        for (const { method, source } of RETIRED_ADAPTER_METHODS) {
          if (retiredCallHits(line, method)) {
            violations.push(`${rel}:${index + 1}: 仍在调 .${method}()（退役出处：${source}）`);
          }
        }
      });
    }
    assert.deepEqual(
      violations,
      [],
      `已退役的适配器方法名又回到代码里（事故原形：store.recall is not a function，被默认 skip 掩护约三周）：\n  `
      + violations.join("\n  "),
    );
  });

  it("规则 2 的匹配器：现役 API 不误报、退役调用必报，且退役名确实已从 src/ 消失", () => {
    const currentCalls = CURRENT_STORE_API.map((m) => `  const x = await store.${m}(runId);`).join("\n");
    for (const { method } of RETIRED_ADAPTER_METHODS) {
      assert.equal(retiredCallHits(currentCalls, method), 0, `现役 API ${method} 被误判成退役调用`);
    }
    // 现役名单要还能在 src/ 里查到——否则上面那条「不误报」断言是在跟空气比
    const srcText = [...listScannable(CODE_EXTS, "src")].map((f) => readFileSync(f.abs, "utf8")).join("\n");
    for (const name of CURRENT_STORE_API) {
      assert.match(srcText, new RegExp(`${name}\\s*[:(]`), `现役 store API ${name} 在 src/ 里查不到了：名单已过期`);
    }
    for (const { method } of RETIRED_ADAPTER_METHODS) {
      assert.ok(
        !new RegExp(`\\.${method}\\s*\\(`).test(srcText),
        `src/ 里又出现 .${method}()——它没退役（或本表该删这一条），请把出处核对一遍`,
      );
    }
    // 正证：事故那一行必须被抓到（名字用拼接写，否则本文件自己会被规则 2 抓到）
    const accidentLine = `  const r = await store.${"re" + "call"}(runId, undefined, undefined, "exec");`;
    assert.equal(retiredCallHits(accidentLine, "recall"), 1);
  });

  // ---- 规则 3 -------------------------------------------------------------

  it("规则 3 前置：接受集合是从 bin/cli.js 现推的（非空、含关键旗标）", () => {
    assert.ok(accepted.size >= 15, `从 bin/cli.js 只推出 ${accepted.size} 个旗标，口径可能退化`);
    for (const flag of ["--help", "--version", "--config", "--session", "--max-rounds", "--tools"]) {
      assert.ok(accepted.has(flag), `接受集合里没有 ${flag}：解析方式失效，规则 3 不可信`);
    }
    // 否定句口径的对照（本轮实测误报就出在这一类）：说「没有这个旗标」不算声称接受，
    // 而正面写 erix 用这个旗标必须仍算——否则这条豁免会把真问题全放掉。
    assert.equal(
      negationProbe("要看有哪些能续用 `erix chat -r`（需 TTY，**没有 `--resume` 这个旗标**）", "--resume"),
      true,
      "中文否定句没被认出：README_cn.md / docs 的那批「没有 --resume 这个旗标」会变成天天误报",
    );
    assert.equal(negationProbe("there is **no `--resume` flag**, see erix chat -r", "--resume"), true);
    assert.equal(negationProbe("erix chat --resume <id> 续会话", "--resume"), false, "正面用法被否定句口径误放行");
    assert.equal(negationProbe("`erix chat --resume` 已废弃", "--resume"), false, "「已废弃」不在否定词表里，应当仍计工单口径的未知旗标");
  });

  it("规则 3：挂在 erix 命令行上的旗标必须被 bin/cli.js 接受", () => {
    assert.deepEqual(
      unknown.map((u) => `${u.rel}:${u.line} 旗标 ${u.flag}：${u.text}`),
      [],
      "这些旗标出现在 erix 命令行上，却不在 bin/cli.js 的接受集合里：要么旗标已退役/写错（该改用现役名），"
      + "要么文档/示例跑在了实现前面。本规则**没有**手抄白名单，只有从 CHANGELOG 推出的退役名单：\n  "
      + unknown.map((u) => `${u.rel}:${u.line} ${u.flag}`).join("\n  "),
    );
  });

  it("规则 3 的扫描面不是空转（覆盖数掉了说明口径被改窄到看不见东西）", () => {
    if (process.env.ERIX_GUARD_DEBUG === "1") {
      console.log(JSON.stringify({
        acceptedFlags: accepted.size,
        derivedRetiredFlags: retired.map((r) => r.flag),
        mentions: mentions.length,
        unknown: unknown.length,
        byFile: [...new Set(mentions.map((m) => m.rel))].sort(),
      }, null, 1));
    }
    assert.ok(
      mentions.length >= 25,
      `本轮只扫到 ${mentions.length} 次 erix 命令行旗标提及（本单落地时实测见报告）——范围退化会让守卫假绿`,
    );
    // 豁免表健康：每条都有理由、点名到文件、且本轮**真的扇到**（僵尸豁免会放掉以后的真问题）
    for (const entry of EXEMPT_UNKNOWN_FILES) {
      assert.ok(entry.reason.trim().length >= 20, `${entry.file} 的豁免理由太短`);
      assert.ok(existsSync(resolve(ROOT, entry.file)), `豁免指向的文件不存在：${entry.file}`);
      assert.ok(
        mentions.some((m) => m.rel === entry.file && m.status === "exempted"),
        `豁免 ${entry.file} 本轮一条都没扇到：删掉它，别留僵尸豁免`,
      );
    }
    const hitDirs = new Set(mentions.map((m) => m.rel.split("/")[0]));
    // README 这一面不能空转：中文那份同样有人群复制（本轮实测 README_cn.md 有命中）
    for (const name of readmeEntries()) {
      assert.ok(
        mentions.some((m) => m.rel === name),
        `旗标扫描在 ${name} 上零命中（当前命中：${[...hitDirs].join(", ")}）：口径被改窄`,
      );
    }
    for (const want of ["docs"]) {
      assert.ok(hitDirs.has(want), `旗标扫描在 ${want} 上零命中（当前命中：${[...hitDirs].join(", ")}）：口径被改窄`);
    }
  });

  it("规则 3 的退役名单是推导出来的，且每条都真的不被接受", () => {
    const acceptedSrc = readFileSync(resolve(ROOT, "bin/cli.js"), "utf8");
    for (const entry of retired) {
      assert.ok(entry.evidence.length >= 20, `${entry.flag} 的退役证据行太短：${entry.evidence}`);
      assert.ok(!accepted.has(entry.flag), `${entry.flag} 在 bin/cli.js 里还存在，说明它没退役`);
      assert.ok(!acceptedSrc.includes(entry.flag), `${entry.flag} 仍在 bin/cli.js 文本里（含 --help 文案）`);
    }
    // 名单必须非空：CHANGELOG 里现成有「移除 `--notes-ledger`」（issue #74），所以推出 0 条
    // 不是「今天恰好没东西退役」，而是**推导器自己是死的**（实测：本单曾把退役正则写成带 `^`
    // 锚点的形式，命中永远为 0，名单静默恒空而全量依旧绿）。这条断言就是补那个坑。
    assert.ok(
      retired.length >= 1,
      `从 CHANGELOG 推出的退役旗标名单为空（接受集合 ${accepted.size} 个），推导器可能已死：`
      + "核对 deriveRetiredFlags 的动词邻接口径与 CHANGELOG 里的「移除 `--旗标`」写法",
    );
    for (const entry of retired) {
      assert.match(entry.flag, /^--[A-Za-z][A-Za-z0-9-]{1,}$/);
    }
  });

  // ---- 构造器接线（防 (a) 变成死代码 / 防字段名再写反） ---------------------

  it("形状 A（~/.erix/config.json）被 bin/config.js#loadCliConfig 真读出来", async () => {
    const { loadCliConfig } = await import("../bin/config.js");
    const saved = new Map(MODEL_CONFIG_ENV_NAMES.map((n) => [n, process.env[n]]));
    for (const name of MODEL_CONFIG_ENV_NAMES) delete process.env[name];
    const home = await makeTmp("erix-shape-a-");
    try {
      const written = await createFakeConfigHome({
        dir: home,
        erix: {
          endpoint: "https://shape-a.invalid/v1",
          apiKey: "k-shape-a",
          model: "m-shape-a",
          maxOutputTokens: 4096,
          contextWindowTokens: 200_000,
        },
      });
      const config = await loadCliConfig({ configPath: written.configPath });
      assert.equal(config.endpoint, "https://shape-a.invalid/v1");
      assert.equal(config.apiKey, "k-shape-a");
      assert.equal(config.model, "m-shape-a");
      assert.equal(config.maxOutputTokens, 4096);
      assert.equal(config.contextWindowTokens, 200_000);

      // 端点字段写成 baseUrl 就是「假配置形状错」最常见的写法错误：构造器必须先抛，
      // 真读取方也必须读不到端点（而不是静默用别的值）。
      assert.throws(() => erixConfigShape({ baseUrl: "https://x.invalid/v1" }), /未被读取方读取的键/);
      const noEndpoint = erixConfigShape({ apiKey: "k", model: "m" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(written.configPath, JSON.stringify(noEndpoint, null, 2));
      await assert.rejects(() => loadCliConfig({ configPath: written.configPath }), /LLM_KIT_ENDPOINT/);
    } finally {
      for (const [name, value] of saved.entries()) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("形状 B（~/.pi/agent/models.json）被 examples/exec-demo.js#loadRelayConfig 真解析出来", async () => {
    const { loadRelayConfig, DEMO_MODEL_PREFERENCES } = await import("../examples/exec-demo.js");
    const demoModel = DEMO_MODEL_PREFERENCES[0];
    const saved = new Map(MODEL_CONFIG_ENV_NAMES.map((n) => [n, process.env[n]]));
    for (const name of MODEL_CONFIG_ENV_NAMES) delete process.env[name];
    const home = await makeTmp("erix-shape-b-");
    try {
      const written = await createFakeConfigHome({
        dir: home,
        relay: { baseUrl: "https://shape-b.invalid/v1", apiKey: "k-shape-b", modelIds: [demoModel], maxTokens: 9000, contextWindow: 131_072 },
      });
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      const cfg = await loadRelayConfig({});
      assert.equal(cfg.endpoint, "https://shape-b.invalid/v1");
      assert.equal(cfg.apiKey, "k-shape-b");
      assert.equal(cfg.model, demoModel);
      assert.equal(cfg.contextWindowTokens, 131_072);
      // 8192 上限（issue #245）：给了 9000 也必须被夹到 8192
      assert.equal(cfg.maxOutputTokens, 8192);

      // 端点字段写成 endpoint 必须抛（工单单头那条「字段名别写反」的可执行版本）
      assert.throws(() => relayProviderEntry({ endpoint: "https://x.invalid/v1" }), /baseUrl/);
      assert.throws(() => relayModelsShape({ endpoint: "https://x.invalid/v1" }), /baseUrl/);
      assert.deepEqual([...RELAY_ENTRY_KEYS].sort(), ["apiKey", "baseUrl", "models"]);
    } finally {
      for (const [name, value] of saved.entries()) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("upstreamFields 把同一个上游 URL 填进两套**不同**键名，且形状 A 的假 HOME 真能起 CLI", async () => {
    const fields = upstreamFields("http://127.0.0.1:8099");
    assert.deepEqual(fields, { erixSlot: { endpoint: "http://127.0.0.1:8099" }, relayProvider: { baseUrl: "http://127.0.0.1:8099" } });
    assert.throws(() => upstreamFields(""), /上游 baseUrl/);
    assert.ok(ERIX_SLOT_CORE_KEYS.includes("endpoint") && !ERIX_SLOT_CORE_KEYS.includes("baseUrl"));

    const upstream = createScriptedUpstream({
      // 不带 --stream 时走非流式 JSON 回复（与 test/cli-process.test.js 的 replyWithText 同一形状）
      script: [jsonResponse({
        choices: [{ message: { role: "assistant", content: "SHAPE-A-OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      })],
    });
    const url = await upstream.listen();
    const home = await makeTmp("erix-shape-a-cli-");
    try {
      await createFakeConfigHome({
        dir: home,
        erix: { endpoint: url, apiKey: "k", model: "m-cli", maxOutputTokens: 1024 },
      });
      const proc = await runErix(home, ["chat", "hello", "--max-rounds", "3", "--reflection", "off"]);
      await upstream.waitForRequests(1, 2_000);
      const io = `exit=${proc.status} signal=${proc.signal} stdout=${JSON.stringify(String(proc.stdout).slice(-400))} stderr=${JSON.stringify(String(proc.stderr).slice(-400))}`;
      assert.equal(upstream.requestCount, 1, `上游收到 ${upstream.requestCount} 发请求，应为 1（假配置没接上真 CLI）；${io}`);
      assert.match(proc.stdout, /SHAPE-A-OK/, `终稿没进 stdout：${io}`);
    } finally {
      await upstream.close();
    }
  });

  // ---- 交付物 (c) 的防回归 -------------------------------------------------

  it("test/ 下不再放会被 node --test 当测试执行的支撑文件", () => {
    // 实测：裸 node --test 会把 test/ 下**任何**文件当测试文件收集执行（每轮白跑一遍，
    // 谁在里面加一行顶层代码就能挂住整套测试）。支撑文件一律放根 fixtures/。
    const strays = [...listScannable(new Set([".mjs", ".cjs"]), "test")]
      .map((f) => f.rel)
      .filter((rel) => !rel.endsWith(".test.js") && !rel.endsWith(".test.mjs") && !rel.startsWith("test/helpers/"));
    assert.deepEqual(
      strays,
      [],
      `test/ 下有非测试支撑文件（会被 node --test 白跑一遍）：${strays.join(", ")}——请搬到根 fixtures/`
      + "（test/helpers/ 下的辅助模块除外，本用例的清单口径见报告）",
    );
    assert.ok(existsSync(resolve(ROOT, "fixtures/rounds-fixtures.mjs")), "rounds-fixtures 没搬到根 fixtures/");
    assert.ok(!existsSync(resolve(ROOT, "test/fixtures/rounds-fixtures.mjs")), "test/fixtures/rounds-fixtures.mjs 还在原地");
  });
});
