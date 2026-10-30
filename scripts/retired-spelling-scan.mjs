#!/usr/bin/env node
// retired-spelling-scan.mjs — 硬门：**活文档**里还有谁按**已退役的扁平拼写**叙述 `runToolLoop` 的输入
// （工单 #523 的脚本；#560 把它从「观察」接成卡门的门禁，并删掉了「某张工单没管到」那类豁免）。
//
// 病根：引擎 0.28 起**当场拒**顶层扁平配置键（`timeoutMs` / `toolResultTtl` / `initialMessages` …），
// 而文档里仍有一批按扁平拼写叙述输入形态。宿主从架构文档或 ADR 抄写法，会抄到一个已被拒的形态。
//
// **扫描面 = 入库的 `docs/**/*.md` + 两份根 README**（#560 定了「清单只取 `git ls-files`」，#572 把
// 根 README 补进面内）：README 是宿主与模型读到的**第一个**文件，它的快速开始示例被照抄就执行——
// #560 的面只装 `docs/`，于是 #572 之前 `README.md:95` / `README_cn.md:67` 那段示例里的四个退役扁平名
// （`system` / `initialUserMessage` / `maxRounds` / `runId`）一次都没被这道门看过。扩面**不靠启发式**：
// 两份根文档按「根文档」这一档登记命中数钉子（`ROOT_DOC_BODY_PINS`），总数变了就红；面本身仍是
// **显式** pathspec（`SCAN_PATHSPECS` = `docs` + 两份根 README），**不是** `.`——
// 扫描面不许偷偷变成「整个仓库」。
//
// **清单只取 `git ls-files`**（#560 的缺陷修复，扩面后不变）：`docs/tasks/` 与
// `docs/delivery/` 是**故意不入库**的本地档案（`.gitignore` 两条目录规则；AGENTS 明写持久交付证据放
// PR/issue 评论、不放仓库树）。从前这里用 `readdirSync` **走文件系统**，于是同一份仓库内容在开发树
// （有本地档案 ⇒ 那批文件按「未登记路径 ⇒ 照扫」被算红 ⇒ `--strict` exit 1）与干净克隆（exit 0）里
// 给出两个答案，而 CI 跑的是克隆 ⇒ 那批红永远见不到，门对开发者只剩噪音。「未登记照扫」这条规则本身
// 是对的（未知分类不是免检），**错在把不入库的文件喂给它**。
// 于是清单必须与 git 同源：`git` 不可用 / 不在仓库内 / 仓库顶层不是本脚本所在目录 / 清单为空 ⇒
// **显式报错 exit 2**，**绝不**静默退回文件系统遍历（静默退回等于把「两个答案」留在原地，只是更难发现）。
//
// **它是门**：`npm run check:docs-spelling`（= `--strict`）在 `.github/workflows/ci.yml` 里阻塞，紧跟
// `check:docs:strict`；`node scripts/retired-spelling-scan.mjs --self-test` 是同一道门的反向证，单独一步
// 阻塞。默认模式（不带 flag）仍然只打报告、exit 0 —— 那是给人读的视图，门禁跑的是 `--strict`。
//
// **`--json` 的退出码与文本分支同源同判**（#575 A）：从前 `--json` 打完判词就 `process.exitCode = 0`，
// 于是 `--strict --json` 在红面上恒假绿（`--strict` 只对文本分支生效）——任何人拿 `--json` 做机器判定
// 都会把红当绿。现在「哪些判词算红」只有一份（`gateVerdicts()`），「红数 → 退出码」也只有一份
// （`gateExitCode()`），两条输出分支都只读它们；`--json` 的输出里带
// `gate.{strict,gating,mode,red,counts,exitCode,wouldExitCode}`，所以机器读的那份**不可能**与进程
// 真实退出码不一致（自测里有反向证）。
//
// 三条判据（每条都能被反向证打红，见报告）：
//   1. **分类**（`classify()`，纯路径，第一等公民）：
//        · **现状描述**（current，该迁移）：`docs/architecture*` / `docs/charts*` / `docs/requirements*` /
//          `docs/testing*` / `docs/maintenance-policy*` / `docs/soak.md` —— 它们教的是「今天怎么写」；
//        · **历史记录**（history，正文一字不改，只加日期横幅）：`docs/decisions/*`、`docs/v0.*`、
//          `docs/design/*`、`docs/research/*`、`docs/harness-comparison/*`、`docs/suggestions/*`、
//          `docs/issue-469-*`、`docs/tasks/*`、`docs/host-upgrade-guide-*` —— 写的是当时发生的事
//          （版本化升级指南的迁移前后对照表**必须**点名扁平拼写，那是它的内容）；
//        · **契约**（contract，正文是退役拼写的**定义处**）：`docs/host-consumer-contract*` —— #523 的
//          口径本来就是「扫非契约文档」；契约命名空间表里 `config.run` 那一行的 `maxRounds` 是**叶子名**，
//          不是扁平写点。
//        · **根文档**（rootdoc，`README.md` / `README_cn.md`，#572）：按 contract 那一档处理——正文里的
//          同名命中**不是漂移**（它讲默认值、列选项名、给端口形状），一个词都不许“改干净”，所以靠
//          命中数钉子（`ROOT_DOC_BODY_PINS`）看守。它的快速开始示例是**唯一**被逐字执行的段落，
//          那一截必须写成规位形态（已改）；钉子只是把“谁再往 README 里补一句扁平拼写”变成红。
//        · **未登记 ⇒ 按现状描述扫**：未知分类不是免检，宁可多红一句。临时改动范围（「本单只改 …」）
//          **不是**分类理由，那条理由已按 #560 从本文件删掉。
//      分类错 = 改错文件，所以分类表不在别处隐式决定。
//   2. **命中**：退役键名出现在**代码语境**里（围栏内的键位、行内代码 span），且**不在** `config.*`
//      之下（`config.timing.timeoutMs` 的尾段不是扁平写点 —— 那正是规位拼写）。围栏内的 `config: { … }`
//      子树按花括号配对整体跳过：叶子名逐字等于扁平键名，但它是**叶子**，不是顶层写点。
//   3. **非现状类的正文不许被改写**：`HISTORY_BODY_PINS` / `CONTRACT_BODY_PINS` / `ROOT_DOC_BODY_PINS`
//      钉住每份历史/契约/根文档的命中数。把某份 ADR 的正文改写成规位形态 ⇒ 命中数**掉** ⇒ `SUSPECT(dropped)`；往历史里
//      补一句扁平拼写 ⇒ 命中数**涨** ⇒ `SUSPECT(raised)`；新入历史/契约/根文档类却忘了钉 ⇒ `UNPINNED`。
//      没有这条，分类判据是空的：「这份历史文档本来就没有命中」与「有人把它改成规位形态了」在文本上
//      长得一模一样。钉子只许登记**入库**文件：指向一份不在 `git ls-files` 清单里的文件 = **死条目**
//      （`DEAD-PIN`，同样红），因为那份文件在干净克隆里根本不在面上，钉子在那里是空转的。
//
// 口径（缺一条数就对不上）：
//   · 退役键表**派生**自源码（`src/loop/config-namespace.js` 的 schema 叶子 − `RUN_TOOL_LOOP_OPTION_NAMES`），
//     不是抄一份清单 —— 引擎再退役一个键，这里自动跟上；
//   · 只在**代码语境**里算命中：散文里的 `system messages` / `user message` / `context compaction`
//     是普通英文，不是拼写；
//   · 同一行出现**退役措辞**（`retired` / `已退役` / `rejected` / `rejects` / `flat spelling`）的命中
//     记为 `mention`（在讲退役这件事，不是在用），不计入 `use`；
//   · `AMBIGUOUS_KEYS` 里的名字同时是**别的东西的名字**（`executeTool` 的 `context` 形参、provider
//     工厂的 `timeoutMs` 参数、`createXProvider` 的 `model`/`maxTokens`、事件字段 `runId`…）。
//     它们照样列出来，但标 `ambiguous`，**不进** `--strict` 的判据：文本级扫描分不清「形参名」与
//     「输入面拼写」，装作分得清就是假阳性工厂。
//
// 用法：
//   node scripts/retired-spelling-scan.mjs            # 全量报告，exit 0（人读视图）
//   node scripts/retired-spelling-scan.mjs --json     # 同一份事实的机器读法（含 `gate` 段：红数 + 退出码）
//   node scripts/retired-spelling-scan.mjs --strict   # 门禁：现状类有 use / 历史契约根文档类钉子不符 ⇒ exit 1；
//                                                     # 清单拿不到（git 不可用 / 不在仓库内 / 空清单）⇒ exit 2
//   node scripts/retired-spelling-scan.mjs --strict --json  # 同一道门，机器读法：红数 > 0 ⇒ 非 0（#575 A）
//   node scripts/retired-spelling-scan.mjs --self-test # 反向证：内存夹具里改一处 ⇒ 报；不改 ⇒ 不报

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF_PATH), "..");
// 旗标**不在模块顶层解析**（#575 A）：`runCli({ argv })` 每次运行自己解析，自测才能在同一进程里
// 分别跑「带 `--strict`」与「不带 `--strict`」两条路（顶层常量会让自测只能证其中一条）。

// ── 1. 退役键表（派生，不抄） ────────────────────────────────────────────────
/**
 * 扁平拼写 → 规位路径。真值两处都在源码里：
 *   · 配置面叶子 = `CONFIG_SURFACE_OPTION_NAMES`（`src/loop/config-namespace.js`）；
 *   · 顶层白名单 = `RUN_TOOL_LOOP_OPTION_NAMES`（`src/loop/option-normalization.js`）。
 * **退役 = 叶子还在 schema 里、但顶层白名单里没有它**（#498 S3 的口径：删扁平键不是删叶子）。
 * 于是这张表随引擎自己变，不会成为第二份会腐烂的清单。
 */
async function retiredFlatKeys() {
  const cn = await import(path.join(ROOT, "src/loop/config-namespace.js"));
  const on = await import(path.join(ROOT, "src/loop/option-normalization.js"));
  const allowed = new Set(on.RUN_TOOL_LOOP_OPTION_NAMES);
  const map = new Map();
  for (const leaf of cn.CONFIG_SURFACE_OPTION_NAMES) {
    if (allowed.has(leaf)) continue;
    map.set(leaf, `config.${cn.configPathForOption(leaf)}`);
  }
  return map;
}

/**
 * 同时是**别的东西的名字**的那些键（文本级扫描分不清，所以标 ambiguous 而不判死）。
 * 每条写清「它还是谁的名字」——空泛的放行等于后门（#210 R2 惯例）。
 */
const AMBIGUOUS_KEYS = new Map([
  ["system", "消息角色 `system`（`role: \"system\"`），也在 `createXProvider` 的 `model` 隔壁的散文里"],
  ["user", "消息角色 `user`；`summaryRole` 的取值 `\"user\"`"],
  ["model", "`createOpenAIProvider` / `createAnthropicProvider` 的**工厂参数** `model`（不是 runToolLoop 选项）"],
  ["maxTokens", "provider 工厂参数 / 模型槽位字段 `slots.default.maxTokens`（契约明写这一处不受退役影响）"],
  ["temperature", "provider 工厂参数 `temperature`（同上）"],
  ["topP", "provider 工厂参数 `topP`（同上）"],
  ["timeoutMs", "provider 工厂参数 `timeoutMs`（`src/providers/*` 的请求超时，与 runToolLoop 无关）"],
  ["context", "`executeTool` 的执行对象形参 `context`；折叠上下文这个**概念**也叫 context"],
  ["task", "任务简报的概念名（`task brief`），也是 `executeTool` 载荷里的 `task` 字段"],
  ["toolContext", "`executeTool` 载荷里的 `toolContext` 字段（合并后的工具上下文）"],
  ["expert", "`executeTool` / judge 简报里的 `expert` 字段"],
  ["requestId", "`executeTool` 载荷与事件里的 `requestId` 字段"],
  ["runId", "run 标识（`<safeRunId(runId)>` 路径模板、事件字段、`TranscriptStore` 形参）"],
  ["cwd", "进程工作目录这个概念（`cwd` 在散文里就是它）"],
  ["resume", "动词「续跑」与 `TranscriptStore` 的 resume 语义"],
  ["stream", "SSE / 事件流这个概念（`event stream`）"],
  ["retry", "动词「重试」与 provider 重试这个概念"],
  ["persistence", "持久化这个概念与 `persistence_capability_degraded` 事件名"],
  ["completion", "「完成」这个概念（`completion check`）"],
  ["reflection", "反思子系统这个概念（`reflection/` 目录）"],
  ["wrapup", "回合结束（wrap-up）这个概念与模块名 `src/reflection/wrapup.js`"],
]);

/** 退役措辞：同一行出现它 ⇒ 这条命中是 `mention`（在讲退役，不是在用）。 */
const RETIREMENT_MARKERS = /retired|retirement|rejected|rejects|flat spelling|退役|已拒|扁平拼写/i;

// ── 2. 分类表（第一等公民，纯路径） ──────────────────────────────────────────
/** 现状描述：会被当成「今天怎么写」来读的活文档（且在 `check:docs` 的引用扫描范围内）。 */
const CURRENT_DOC_PATTERNS = [
  { re: /^docs\/architecture(_cn)?\.md$/, why: "现状描述：架构正文，`check:docs` 的 paths/symbols 面在扫它" },
  { re: /^docs\/charts(_cn)?\.md$/, why: "现状描述：图表正文，同上" },
  { re: /^docs\/requirements(_cn)?\.md$/, why: "现状描述：需求正文，写的是当前交付面与当前输入契约" },
  { re: /^docs\/testing(_cn)?\.md$/, why: "现状描述：测试布局与覆盖正文" },
  { re: /^docs\/maintenance-policy(_cn)?\.md$/, why: "现状描述：维护策略正文" },
  { re: /^docs\/soak\.md$/, why: "现状描述：soak 操作手册，教宿主怎么把参数传给引擎" },
];
/** 历史记录：当时决定的记录，正文一个字不改，只加带日期的状态横幅；命中数由钉子看守。 */
const HISTORY_DOC_PATTERNS = [
  { re: /^docs\/decisions\/[^/]+\.md$/, why: "历史记录：ADR，写的是当时作出的决定" },
  { re: /^docs\/v0\.[^/]*\.md$/, why: "历史记录：v0.x 契约快照（文件头自己写着「快照档案」）" },
  { re: /^docs\/design\/[^/]+\.md$/, why: "历史记录：带日期的设计档案（当时的设计稿，不是今天的 API 描述）" },
  { re: /^docs\/research\/[^/]+\.md$/, why: "历史记录：带日期的研究/实验档案" },
  { re: /^docs\/harness-comparison\/[^/]+\.md$/, why: "历史记录：一次对照分析的存档" },
  { re: /^docs\/suggestions\/[^/]+\.md$/, why: "历史记录：一次性建议稿" },
  { re: /^docs\/issue-469-[^/]+\.md$/, why: "历史记录：issue #469 的分析/修复计划档案" },
  { re: /^docs\/tasks\/[^/]+\.md$/, why: "历史记录：任务工作目录（实验记录、交接稿）" },
  { re: /^docs\/host-upgrade-guide-[^/]+\.md$/, why: "历史记录：版本化升级指南，写的是该版本当时怎么迁（迁移前后对照表要点名扁平拼写）" },
];
/** 契约：退役拼写的定义处。它点名扁平拼写是它的职责，不是漂移。 */
const CONTRACT_DOC_PATTERNS = [
  { re: /^docs\/host-consumer-contract(_cn)?\.md$/, why: "契约：退役拼写的定义处与命名空间叶子表的真值（#523 的口径是「扫非契约文档」）" },
];
/**
 * 根文档：随包、且是宿主与模型读到的**第一个**文件（#572）。
 *
 * 为什么按 contract 那一档（非现状）而不是 current：README 正文里那批同名命中不是漂移——
 * `maxRounds` defaults to `8`、`toolResultTtl` 默认值表、`session: { id, resume?, initialMessages? }`
 * 这些句子是它在**讲默认值/讲端口形状**，而且其中若干句是 `check:docs` 的逐字锚点（#572 红线：
 * 一个字都不许改）。所以正文不要求“改干净”，只要**不许被静默改写**——那正是命中数钉子干的事。
 * 真正必须写成规位形态的是它的快速开始示例（已按 #572 改并实跑过）。
 *
 * 它与 contract 的差别只在名字：钉子表叫 `ROOT_DOC_BODY_PINS`，报错文案说“根文档”，不把 contract
 * 的名字硬套到 README 上。
 */
const ROOT_DOC_PATTERNS = [
  { re: /^README(_cn)?\.md$/, why: "根文档：随包 README（宿主与模型的第一个文件），快速开始示例会被逐字执行" },
];

/**
 * 一份文档的分类（纯路径，不看内容）。
 *
 * **未登记路径 = 现状描述**：未知分类不是免检。历史上这里有一个 `out-of-scope` 类，理由是「不在
 * #523 的改动面」—— 一张工单的临时改动范围被永久写进门，那些文件里的旧写法既不报也不改，`--strict`
 * 因此假绿。`#560` 把它删了，方向反过来：既不在历史清单、也不在契约清单里的 `docs/**.md` 照扫不误。
 *
 * @param {string} rel 仓库相对路径
 * @returns {{kind: "current"|"history"|"contract"|"rootdoc", why: string}}
 */
export function classify(rel) {
  for (const { re, why } of CURRENT_DOC_PATTERNS) if (re.test(rel)) return { kind: "current", why };
  for (const { re, why } of HISTORY_DOC_PATTERNS) if (re.test(rel)) return { kind: "history", why };
  for (const { re, why } of CONTRACT_DOC_PATTERNS) if (re.test(rel)) return { kind: "contract", why };
  for (const { re, why } of ROOT_DOC_PATTERNS) if (re.test(rel)) return { kind: "rootdoc", why };
  return {
    kind: "current",
    why: "未登记路径 ⇒ 按现状描述扫（未知分类不是免检：宁可多红一句）",
  };
}

// ── 3. 非现状类正文的命中数钉子 ──────────────────────────────────────────
/**
 * 历史/契约文档的 `use` 命中数（本树上实测）。
 *
 * 这份事实在 `--json` 输出里**只有一处**：逐文件的 `files[].pin`（每份文件自己那一格）。
 * 从前还有一个聚合的 `pins` 段，但它只装了本表这一档（`pins: HISTORY_BODY_PINS`），于是 #575 加了
 * contract 档、#572 加了 rootdoc 档之后，机器读者很容易把那个字段读成「全部钉子」——实际另两档
 * 一份都不在里面。**重复一份只带来漂移面**，所以 #577 A 把它删了：`files[].pin` 已经是完整事实。
 * 别再加回来（自测里有反向证：`pins` 段一旦重新出现就红）。
 *
 * 为什么需要它：本脚本的分类判据要说得出「这份 ADR 的正文被改写成规位形态了」。文本级扫描做不到
 * ——改写之后命中数变成 0，而「本来就没有命中」也是 0，两者长得一模一样。所以把实测的数钉在这里：
 * **掉下去 = 有人在改历史**（`SUSPECT(dropped)`），**涨上去 = 有人往历史里补了扁平拼写**（`SUSPECT(raised)`），
 * 而**有命中却没登记** = 新入历史类却忘了钉（`UNPINNED`，同样红）。
 * 改这份表只有一个合法理由：**历史文档真的被替换成另一份历史**（那要连横幅一起重写）。
 *
 * 零命中的历史文件故意不登记：它们本来就没东西可丢，而一旦被补进扁平拼写就会命中 > 0 ⇒ `UNPINNED`。
 *
 * @type {Readonly<Record<string, number>>}
 */
const HISTORY_BODY_PINS = Object.freeze({
  "docs/decisions/001-config-adapters.md": 4,
  "docs/decisions/001-config-adapters_cn.md": 2,
  "docs/decisions/002-transcript-store.md": 2,
  "docs/decisions/003-compaction-strategies.md": 2,
  "docs/decisions/004-reflection-deferred.md": 2,
  "docs/decisions/005-tool-system.md": 4,
  "docs/decisions/005-tool-system_cn.md": 2,
  "docs/decisions/006-tool-provider.md": 2,
  "docs/decisions/007-memory-architecture.md": 6,
  "docs/decisions/007-memory-architecture_cn.md": 1,
  "docs/decisions/008-skill-system.md": 2,
  "docs/decisions/009-safety-layering.md": 2,
  "docs/decisions/010-context-shaping-philosophy.md": 2,
  "docs/decisions/011-judge-direction.md": 4,
  "docs/decisions/011-judge-direction_cn.md": 1,
  "docs/decisions/012-engine-truth-model-efficiency-host-policy.md": 2,
  "docs/decisions/013-guard-charter.md": 2,
  "docs/decisions/014-host-port-framework.md": 12,
  "docs/decisions/017-glm-reasoning-effort-translation.md": 2,
  "docs/decisions/020-transcript-single-source.md": 7,
  "docs/design/2026-09-14-bounded-recall-api.md": 3,
  "docs/design/2026-09-14-revised-scope-evaluation.md": 7,
  "docs/design/2026-09-15-release-0.5.0-review.md": 1,
  "docs/design/2026-09-17-context-memory-improvement-plan.md": 4,
  "docs/design/2026-10-08-architecture-review.md": 9,
  // issue #598: 3 → 4。新增的配置叶子 `config.continuity.handoff` 把 `handoff` 带进了退役键表（退役 =
  // 叶子还在 schema、顶层白名单没有它），而这份**对比文档**里的 `handoff` 说的是 **pi 自己的**
  // `examples/extensions/handoff.ts` 扩展（「生成交接 prompt 开新 session」），与 runToolLoop 的选项面
  // 毫无关系。钉子比的是**全部**命中数（`ambiguous` 只影响 `--strict` 的违规判据，不影响钉子），所以表
  // 得跟着实测抬这一格——值取自扫描器自己报的 `uses=4`，不是手算。只抬这一份：`handoff` 在跟踪文档里
  // 就出现在这一份。
  "docs/harness-comparison/01-pi-agent.md": 4,
  "docs/harness-comparison/02-touwaka.md": 2,
  "docs/harness-comparison/03-codex.md": 2,
  "docs/harness-comparison/04-hermes-agent.md": 2,
  "docs/harness-comparison/05-erix-llm-kit.md": 5,
  "docs/harness-comparison/06-cross-comparison.md": 3,
  "docs/harness-comparison/07-takeaways-and-open-questions.md": 2,
  "docs/host-upgrade-guide-0.12.0.md": 1,
  "docs/host-upgrade-guide-0.14.0.md": 19,
  "docs/host-upgrade-guide-0.15.0.md": 9,
  "docs/host-upgrade-guide-0.17.0.md": 4,
  "docs/host-upgrade-guide-0.18.0.md": 8,
  "docs/host-upgrade-guide-0.18.0_cn.md": 8,
  "docs/host-upgrade-guide-0.20.0.md": 5,
  "docs/host-upgrade-guide-0.20.0_cn.md": 5,
  "docs/host-upgrade-guide-0.21.0.md": 5,
  "docs/host-upgrade-guide-0.21.0_cn.md": 6,
  "docs/host-upgrade-guide-0.22.0.md": 2,
  "docs/host-upgrade-guide-0.22.0_cn.md": 2,
  "docs/host-upgrade-guide-0.23.0.md": 1,
  "docs/host-upgrade-guide-0.23.0_cn.md": 1,
  "docs/host-upgrade-guide-0.24.0.md": 37,
  "docs/host-upgrade-guide-0.24.0_cn.md": 34,
  "docs/host-upgrade-guide-0.26.0.md": 3,
  "docs/host-upgrade-guide-0.26.0_cn.md": 3,
  "docs/host-upgrade-guide-0.27.0.md": 37,
  "docs/host-upgrade-guide-0.27.0_cn.md": 35,
  "docs/host-upgrade-guide-0.28.0.md": 74,
  "docs/host-upgrade-guide-0.28.0_cn.md": 73,
  "docs/host-upgrade-guide-0.6.0.md": 12,
  "docs/host-upgrade-guide-v030.md": 49,
  "docs/host-upgrade-guide-v030_cn.md": 49,
  "docs/issue-469-470-analysis.md": 4,
  "docs/issue-469-470-fix-plan.md": 9,
  "docs/research/2026-09-13-notes-why.md": 15,
  "docs/research/2026-09-26-strategy-variance-and-cache-economics.md": 2,
  "docs/research/2026-10-13-pi-subagents-async-attribution.md": 3,
  "docs/suggestions/00-README.md": 1,
  "docs/suggestions/01-test-tmpdir.md": 1,
  "docs/suggestions/05-pi-1x-refresh.md": 1,
  "docs/tasks/261026-c469.md": 1,
  "docs/v0.0-contracts.md": 26,
  "docs/v0.0-contracts_cn.md": 23,
  "docs/v0.1-contracts.md": 29,
  "docs/v0.1-contracts_cn.md": 26,
  "docs/v0.2-contracts.md": 18,
  "docs/v0.2-contracts_cn.md": 15,
});

/**
 * 契约正文的命中数钉子（同上，但契约类）。契约本身就是退役拼写的**定义处**：它逐条点名「扁平
 * `toolResultTtl` → `config.folding.toolResultTtl`」，并把 `config.run` 一行的叶子名列表原样列出来。
 * 这些命中不是漂移，所以既不报错也不许被「改干净」；钉子只负责让“改写正文”这件事必须过门。
 *
 * issue #571 片2：契约中英的 `createAgent` 一节按新行为重写（四种形状 + `signal` 裁定 + 一次到位的
 * 扁平名判词 + feeder 裁定），正文因此多引了几处扁平名 ⇒ 钉子由扫描器自己的 `uses=` 报出来后再抬：
 *
 *     ✗ docs/host-consumer-contract.md  [contract]  verdict=SUSPECT(raised)  pin=452  uses=456
 *     ✗ docs/host-consumer-contract_cn.md  [contract]  verdict=SUSPECT(raised)  pin=562  uses=564
 *
 * 452 → 456 / 562 → 564（只增不减的方向：契约正文只会在讲退役拼写时多提它们，不会“改干净”）。
 *
 * @type {Readonly<Record<string, number>>}
 */
const CONTRACT_BODY_PINS = Object.freeze({
  // 456 → 440（issue #617 P0，2026-10-30）：`config.run` 叶子表那一行补了 `parentRunId` 并写明
  // 「flat spelling is rejected」——整行命中**退役措辞行**判据（mention），行内 16 个叶子 span 从
  // uses 转入 mentions。数取自扫描器自己报的 `uses=440`。
  "docs/host-consumer-contract.md": 440,
  // 565（片A，切版前补 #569/#568 文档）：CN 契约新增「折叠触发比例与会话续接块」一节，其中 provider 回调的
  // 真实键名 `runId`（`({runId, state, previous}) → {text, version}`）是一次同名异义命中——契约必须写出这个键名，
  // 所以**不为了躲钉子而改写成模糊说法**，按判据把钉子登记成扫描器报的值。EN 侧同一句已把 `context` 写成全路径
  // （`config.folding.context` 的 `.` 前缀被排除），因此 EN 钉子 456 不动。
  // 565 → 549（issue #617 P0，2026-10-30）：同一片的 CN 行（措辞换成「扁平拼写当场被拒」，同样落
  // mention 判据），行内 16 个叶子 span 从 uses 转入 mentions。数取自扫描器自己报的 `uses=549`。
  "docs/host-consumer-contract_cn.md": 549,
});

/**
 * 根文档（随包 README）的命中数钉子（#572）。
 *
 * 与 `HISTORY_BODY_PINS` / `CONTRACT_BODY_PINS` 同一套机制、同一份判据（`verdictFor()`），只是名字
 * 贴合“根文档”这件事。数**由扫描器自己报出来**（报告里每份文件那行 `uses=N`）再登记，不手抄：
 * 手抄的数会在下一次无关联的改写里静默偏一格，而钉子只在“等于”时绿，偏一格就是红——那时谁也说不清
 * 是真回归还是抄错了。
 *
 * 登记两个文件（中英各一）：漏登一份就是 `UNPINNED`（有命中却没钉），写错路径就是 `DEAD-PIN`，
 * 两条都在红集合里。
 *
 * @type {Readonly<Record<string, number>>}
 */
const ROOT_DOC_BODY_PINS = Object.freeze({
  "README.md": 77,
  "README_cn.md": 62,
});

/** 分类 → 钉子表。现状类没有钉子（它必须为 0）。 */
const PIN_TABLES = Object.freeze({
  history: HISTORY_BODY_PINS,
  contract: CONTRACT_BODY_PINS,
  rootdoc: ROOT_DOC_BODY_PINS,
});

/**
 * 钉子与**扫描面同源**的判据（#560）。
 *
 * 钉子从“依赖巧合被跟踪”改成“与清单同源”：登记一份不在 `git ls-files` 清单里的文件就是**死条目**
 * —— 它在开发树上也许读得到，但在干净克隆里根本不在面上，钉子在那里永远空转；而一旦这份文件被跟踪，
 * 它又会在两个树里给出不同的数。两种情况都不许静默，所以这里把它们逐条点名（`--strict` 计入红数）。
 *
 * 另一个方向：钉子挂错表（历史类的钉子写进契约表，或反过来）也点名 —— 那样 `verdictFor()` 会用错的
 * 规则去判，同样是“没在看它该看的东西”。
 *
 * @param {"history"|"contract"} kind 钉子表对应的分类
 * @param {Readonly<Record<string, number>>} table 钉子表
 * @param {readonly string[]} manifest 入库文件清单（`gitTrackedScanSurface()` 的返回值）
 * @returns {Array<{file: string, why: string}>} 空数组 = 每条钉子都指向一份入库的非现状类文档
 */
export function pinEntryProblems(kind, table, manifest) {
  const tracked = new Set(manifest);
  const problems = [];
  for (const rel of Object.keys(table)) {
    const actual = classify(rel).kind;
    if (actual !== kind) {
      problems.push({ file: rel, why: `登记在 ${kind} 的钉子里，实测分类是 ${actual}（钉子挂错了表）` });
      continue;
    }
    if (!tracked.has(rel)) {
      problems.push({ file: rel, why: "不在 `git ls-files` 清单里（不入库的文件不许登记命中数钉子 ⇒ 死条目）" });
    }
  }
  return problems;
}

/** 全部钉子表里的死条目（钉子与扫描面不同源 ⇒ 红）。 */
export function deadPinEntries(manifest) {
  return Object.entries(PIN_TABLES).flatMap(([kind, table]) => pinEntryProblems(kind, table, manifest));
}

/**
 * `--json` 输出里**钉子事实只有一份**（#577 A）：逐文件的 `files[].pin`。
 *
 * 病根：从前 `runCli()` 里还写死了一个聚合段 `pins: HISTORY_BODY_PINS`。它只装**一档**（72 份历史文档），
 * 而 #575 之后有 contract 档（2 份）、#572 之后有 rootdoc 档（2 份）——那些钉子只住在 `files[].pin` 里。
 * 于是一个叫 `pins` 的字段**看起来**是全部钉子、实际只装三档里的一档：扩面越多，这个误读越贵。
 * 修法是删掉重复（不是补全它）：`files[].pin` 已经是完整事实，两份副本只会漂。
 *
 * 本函数是那条判据：它**只看** `files[].pin`（三档逐条对账 + 非空 pin 数 = 三档合计），并把任何
 * 重新出现的 `pins` 段判成红——包括 #577 之前那个只装 history 档的形状。自测拿真实 `--json` 输出跑
 * 它（必须 0 条），再拿四种变异跑（必须非 0），所以「变不出来」也算失败（#210 R2）。
 *
 * @param {{files?: Array<{file: string, kind: string, pin?: number|null}>}} payload `--json` 的输出
 * @returns {string[]} 空数组 = 钉子事实齐全且只有一份
 */
function pinFactProblems(payload) {
  const problems = [];
  if (payload !== null && typeof payload === "object"
    && Object.prototype.hasOwnProperty.call(payload, "pins")) {
    problems.push("`pins` 段又回来了：那是钉子事实的第二份副本（#577 A 删的就是它，扩面后它只装一档）");
  }
  const files = Array.isArray(payload?.files) ? payload.files : [];
  if (files.length === 0) {
    problems.push("`files` 是空的：钉子事实没有地方装");
    return problems;
  }
  const byFile = new Map(files.map((entry) => [entry.file, entry]));
  for (const [kind, table] of Object.entries(PIN_TABLES)) {
    for (const [rel, count] of Object.entries(table)) {
      const entry = byFile.get(rel);
      if (entry === undefined) {
        problems.push(`${rel} 不在 files[] 里（${kind} 档的钉子没被报出来）`);
        continue;
      }
      if (entry.kind !== kind) problems.push(`${rel} 的分类报成 ${entry.kind}，钉子在 ${kind} 档`);
      if (entry.pin !== count) {
        problems.push(`${rel} 的 files[].pin=${entry.pin === null || entry.pin === undefined ? "（未登记）" : entry.pin}`
          + ` ≠ 钉子表的 ${count}`);
      }
    }
  }
  const pinned = files.filter((entry) => entry.pin !== null && entry.pin !== undefined).length;
  const expected = Object.values(PIN_TABLES).reduce((n, table) => n + Object.keys(table).length, 0);
  if (pinned !== expected) {
    problems.push(`files[].pin 非空的条目 ${pinned} 份 ≠ 三档钉子合计 ${expected} 份`
      + "（少的那几份就是被漏掉的一档）");
  }
  return problems;
}

// ── 4. 文本级扫描 ────────────────────────────────────────────────────────────
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 扫一份 Markdown 文本。
 *
 * 代码语境有两种：
 *   · **围栏**（```…```）：键位形态 `KEY:` / `KEY =` / `KEY,` / 裸 `KEY` 单独一行。围栏里遇到
 *     `config: {` 就进入「规位子树」，按花括号配对整体跳过 —— 那里的 `system` / `messages` 是**叶子名**，
 *     与扁平写点同名但不同物（这正是本脚本最容易变成假阳性工厂的地方）。
 *   · **行内代码 span**（`…`）：span 内容恰是键名，或以 `KEY:` / `KEY =` / `KEY,` 开头。
 *
 * @param {string} text
 * @param {Map<string, string>} retired 键 → 规位路径
 * @returns {Array<{line: number, key: string, canonical: string, verdict: "use"|"mention", excerpt: string}>}
 */
export function scanText(text, retired) {
  const keys = [...retired.keys()].sort((a, b) => b.length - a.length);
  const tokenRe = new RegExp(`(?<![\\w.$-])(${keys.map(escapeRe).join("|")})(?![\\w$])`, "g");
  const spanRe = /`([^`\n]+)`/g;
  const hits = [];
  const lines = text.split("\n");
  let inFence = false;
  let configDepth = 0;

  const push = (lineNo, key, raw, excerpt) => {
    const canonical = retired.get(key);
    if (canonical === undefined) return;
    const verdict = RETIREMENT_MARKERS.test(raw) ? "mention" : "use";
    hits.push({ line: lineNo, key, canonical, verdict, excerpt: excerpt.trim().slice(0, 100) });
  };

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      configDepth = 0;
      return;
    }
    if (inFence) {
      // 规位子树：`config: {` 之后整体跳过，花括号配对回到 0 才恢复计数。
      if (configDepth > 0) {
        configDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        if (configDepth <= 0) configDepth = 0;
        return;
      }
      if (/(^|[\s{,])config\s*:\s*\{/.test(line)) {
        configDepth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        if (configDepth < 0) configDepth = 0;
        return;
      }
      const keyPosition = line.match(/^\s*(?:\/\/\s*)?([A-Za-z_$][\w$]*)\s*[:=,]?/);
      if (keyPosition !== null && retired.has(keyPosition[1])) {
        const bare = line.trim().replace(/,$/, "");
        const name = keyPosition[1];
        if (bare === name || /[:=,]/.test(line.trim().slice(name.length, name.length + 1))) {
          push(lineNo, name, line, line);
          return;
        }
      }
      for (const m of line.matchAll(tokenRe)) push(lineNo, m[1], line, line);
      return;
    }
    // 行内代码 span（围栏外）
    for (const span of line.matchAll(spanRe)) {
      const content = span[1].trim();
      const head = content.match(/^([A-Za-z_$][\w$]*)(\s*[:=,]|\s*\?|$)/);
      if (head === null) continue;
      if (!retired.has(head[1])) continue;
      push(lineNo, head[1], line, span[0]);
    }
  });
  return hits;
}

// ── 5. 覆盖面（只取**入库**文件，清单 = `git ls-files`） ──────────────────
/**
 * 默认执行器：跑一次 git，返回 stdout。`root` 必须是仓库顶层（调用方先验过）。
 * @param {string[]} args
 * @param {string} root
 * @returns {string}
 */
function defaultGit(args, root) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

const MANIFEST_REFUSAL = "拒绝退回文件系统遍历：那会把不入库的文件喂给判据，让门在开发树与干净克隆里给出两个答案（#560）";

/** 把任意异常折成一行可读的原因（`execFileSync` 的 stderr 可能是 Buffer）。 */
function errorLine(error) {
  if (error?.code === "ENOENT") return "找不到 git 可执行文件";
  const raw = error?.stderr === undefined || error?.stderr === null ? error?.message : error.stderr;
  return String(raw ?? error).trim().split("\n").filter(Boolean)[0] ?? String(error);
}

/**
 * 扫描面的**显式** pathspec（#572）：`docs/` 加两份根 README。
 *
 * 为什么单独列而不是直接写 `.`：那会把面变成**整个仓库**（`examples/`、`fixtures/`、`test/` 全进来），
 * 每份新加的文件都会变成新命中与新红，而工单的改动面只有“根文档”。路径清单就在这里，多一份都得
 * 改这一行（不是隐式地“扫到啥算啥”）。
 *
 * @type {readonly string[]}
 */
export const ROOT_DOC_TARGETS = Object.freeze(["README.md", "README_cn.md"]);

/** 扫描面的完整 pathspec：`docs/` + `ROOT_DOC_TARGETS`（仍是**显式**列表，不是 `.`）。 */
export const SCAN_PATHSPECS = Object.freeze(["docs", ...ROOT_DOC_TARGETS]);

/**
 * 扫描面上**入库**的 `.md` 清单（#560：只取 `git ls-files`，不再走文件系统；#572：面从 `docs/` 扩到
 * `docs/` + 两份根 README）。
 *
 * 名字从 `gitTrackedDocs()` 改成 `gitTrackedScanSurface()`：它不再只装 `docs/`，叫旧名会让人以为
 * “面就是 docs”。面本身仍是**显式** pathspec（`SCAN_PATHSPECS`），**不是**整个仓库。
 *
 * 缺陷现场：这里是 `readdirSync` 递归遍历。`docs/tasks/` 与 `docs/delivery/` 是故意不入库的本地档案
 * （`.gitignore` 两条目录规则），于是**同一份仓库内容**在开发树与干净克隆里扫出两个答案 —— 主树
 * `--strict` exit 1（那批未入库文件按「未登记路径 ⇒ 照扫」被算红），克隆 exit 0，而 CI 跑的是克隆。
 * 「未登记照扫」本身是对的（未知分类不是免检），错在把不入库的文件喂给它。
 *
 * 所以：`git` 不可用 / 不在仓库内 / 仓库顶层不是本脚本所在目录 / 清单为空 ⇒ **抛错**，由 `main` 显式
 * 报错并 exit 2。**没有**文件系统回退分支：静默回退等于把「两个答案」留在原地，只是更难发现。
 *
 * `docs/tasks/*.md` 里**被跟踪**的那几份（`261026-*`）照扫不变；它们与其它历史类文档的命中数钉子
 * 也因此与清单同源（`deadPinEntries()`）。两份根 README 同理：钉子在、文件不在清单里 ⇒ `DEAD-PIN`。
 *
 * @param {string} [root] 仓库顶层（默认 = 本脚本所在仓库）
 * @param {{exec?: (args: string[], root: string) => string}} [io] 执行器（自测注入；生产走 git）
 * @returns {string[]} 仓库相对路径，已去重排序
 */
export function gitTrackedScanSurface(root = ROOT, { exec = defaultGit } = {}) {
  const refuse = (detail) => new Error(`扫描清单只取 \`git ls-files\`，但${detail}。${MANIFEST_REFUSAL}`);

  let top;
  try {
    top = exec(["rev-parse", "--show-toplevel"], root).trim();
  } catch (error) {
    throw refuse(`${root} 不在 git 仓库内或 git 不可用（${errorLine(error)}）`);
  }
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch (error) {
    throw refuse(`${root} 读不到（${errorLine(error)}）`);
  }
  let topReal = null;
  try {
    topReal = top === "" ? null : realpathSync(top);
  } catch {
    topReal = null; // 顶层目录不在盘上 ⇒ 同样不可信（下面统一点名）
  }
  if (topReal === null || topReal !== rootReal) {
    throw refuse(`git 认的仓库顶层是 ${top === "" ? "（空）" : top}，不是本脚本所在的 ${root}`
      + "（不在仓库内 ⇒ 清单不可信）");
  }

  let raw;
  try {
    raw = exec(["ls-files", "-z", "--cached", "--full-name", "--", ...SCAN_PATHSPECS], root);
  } catch (error) {
    throw refuse(`\`git ls-files\` 失败（${errorLine(error)}）`);
  }
  const files = [...new Set(raw.split("\0")
    .filter((rel) => rel.endsWith(".md"))
    .map((rel) => rel.split(path.sep).join("/")))].sort();
  if (files.length === 0) {
    throw refuse("清单是空的（0 份入库 .md ⇒ 这道门会假绿）");
  }
  return files;
}

/**
 * 一份文件的判定（纯函数：分类 + 命中数 + 钉子 → verdict）。
 *
 * `#560` 的失败方向：只有 `current` 类能「干净地」有 0 命中；历史/契约/根文档类一旦有命中就必须**钉得上**
 * （`UNPINNED` = 新入这一类却忘了钉，与 `SUSPECT` 一样红）。未知路径已经被 `classify()` 归到
 * `current`，所以不存在「没分类 ⇒ 放行」这条路。
 *
 * @param {{kind: "current"|"history"|"contract"|"rootdoc", uses: number, strictUses: number, pin?: number}} input
 * @returns {"ok"|"REGRESSION"|"review(ambiguous-only)"|"UNPINNED"|"SUSPECT(dropped)"|"SUSPECT(raised)"}
 */
export function verdictFor({ kind, uses, strictUses, pin }) {
  if (kind === "current") {
    if (strictUses > 0) return "REGRESSION";
    return uses > 0 ? "review(ambiguous-only)" : "ok";
  }
  if (pin === undefined) return uses > 0 ? "UNPINNED" : "ok";
  return uses < pin ? "SUSPECT(dropped)" : uses > pin ? "SUSPECT(raised)" : "ok";
}

/**
 * 跑一次全量扫描（纯函数：`root` 可注入，自测用内存夹具）。
 *
 * `files` 默认 = `gitTrackedScanSurface(root)`：**默认面就是入库文件面**，没有“顺手扫一下盘上还有啥”的路。
 * 清单点名的文件读不到 ⇒ 直接抛错点名该文件（`git ls-files --cached` 会把「已 staged 删除」的文件
 * 也列出来；那种情况必须显式报，不能让它变成一道安静的 skip）。
 *
 * @param {{root?: string, retired: Map<string,string>, files?: string[]}} params
 */
export function scanDocs({ root = ROOT, retired, files = gitTrackedScanSurface(root) }) {
  const report = [];
  for (const rel of files) {
    let text;
    try {
      text = readFileSync(path.join(root, rel), "utf8");
    } catch (error) {
      throw new Error(`清单里的 ${rel} 读不到（${errorLine(error)}）：`
        + "`git ls-files` 列出的入库文件必须在盘上，否则扫描面与实际内容不符");
    }
    const { kind, why } = classify(rel);
    const hits = scanText(text, retired);
    const uses = hits.filter((h) => h.verdict === "use");
    const pinTable = PIN_TABLES[kind];
    const pin = pinTable === undefined ? undefined : pinTable[rel];
    const strictUses = uses.filter((h) => !AMBIGUOUS_KEYS.has(h.key));
    const verdict = verdictFor({ kind, uses: uses.length, strictUses: strictUses.length, pin });
    report.push({ file: rel, kind, why, pin, hits, uses, verdict });
  }
  return report;
}

// ── 6. 门禁判据（「哪些判词算红」的**唯一**一份定义，#575 A） ───────────────
/**
 * 把一次扫描折成「红数」与逐类明细。**文本分支与 `--json` 分支都只读这里**。
 *
 * 病根（#575 A）：`--json` 分支从前自己 `process.exitCode = 0` —— 判词打完了，红数却从未参与任何判定，
 * 于是 `--strict --json` 在有红的面子上恒 exit 0。假绿不是「少了一个 if」，而是「同一套判据写了两遍、
 * 其中一遍没写全」。所以红集合只在这里定义一次，两条输出分支（含 JSON 里的 `gate.red`）都只能读它。
 *
 * 红集合（四条，少一条就是假绿）：
 *   · `currentUses`：现状类的 `use` 命中（`REGRESSION`）；`AMBIGUOUS_KEYS` 里的同名异义**不算**
 *     （文本级扫描分不清形参名与输入面拼写，`review(ambiguous-only)` 因此不红）；
 *   · `suspect`：`SUSPECT(dropped)` / `SUSPECT(raised)`（历史/契约正文钉子不符）；
 *   · `unpinned`：历史/契约类有命中却没登记钉子（新入历史类却忘了钉）；
 *   · `deadPins`：钉子指向不在 `git ls-files` 清单里的文件（空转条目）。
 * `ok` / `review(ambiguous-only)` 不在集合里。
 *
 * @param {{report: Array<{kind: string, verdict: string, uses: Array<{key: string}>}>, deadPins?: Array<{file: string, why: string}>}} input
 * @returns {{currentUses: Array<object>, suspect: Array<object>, unpinned: Array<object>,
 *   deadPins: Array<{file: string, why: string}>, red: number,
 *   counts: {regression: number, suspect: number, unpinned: number, deadPins: number}}}
 */
export function gateVerdicts({ report, deadPins = [] }) {
  const currentUses = report
    .filter((r) => r.kind === "current")
    .flatMap((r) => r.uses.filter((h) => !AMBIGUOUS_KEYS.has(h.key)));
  const suspect = report.filter((r) => r.verdict.startsWith("SUSPECT"));
  const unpinned = report.filter((r) => r.verdict === "UNPINNED");
  const counts = {
    regression: currentUses.length,
    suspect: suspect.length,
    unpinned: unpinned.length,
    deadPins: deadPins.length,
  };
  return {
    currentUses,
    suspect,
    unpinned,
    deadPins,
    counts,
    red: counts.regression + counts.suspect + counts.unpinned + counts.deadPins,
  };
}

/**
 * 红数 → 退出码。**唯一**一处把 `--strict` 应用上去的地方（文本分支与 `--json` 分支共用）。
 *
 * · `--strict`（= 门禁，`npm run check:docs-spelling`）：红数 0 ⇒ 0，否则 1。`SUSPECT` 因此是**只在
 *   门禁下**才算红的判词 —— 这条规则（`#563` 起的既有语义）只在这里兑现，别处不许再判一次。
 * · 不带 `--strict`（报告模式）：**恒 0**。那是既有语义：默认视图是给人读的报告，门禁跑的是
 *   `--strict`。所以 `--json` 把红数（**事实**）与 `gating: false`（**不判**）**都**打出来 ——
 *   不判 ≠ 没红，机器读的那份不许把前者写成后者。
 * · 清单拿不到（git 不可用 / 不在仓库内 / 空清单）不走这里：那条路 exit 2，在 `runCli` 里。
 *
 * @param {ReturnType<typeof gateVerdicts>} gate
 * @param {{strict: boolean}} options
 * @returns {0|1}
 */
export function gateExitCode(gate, { strict }) {
  if (!strict) return 0;
  return gate.red === 0 ? 0 : 1;
}

// ── 7. 输出（两条分支都只读 `gate`，不自己算红） ─────────────────────────
/**
 * 人读视图。返回值 = 退出码（由 `gateExitCode` 给；本函数不自己拼红数）。
 *
 * @param {Array<object>} report `scanDocs()` 的返回
 * @param {Map<string, string>} retired 退役键 → 规位路径
 * @param {{manifest: string[], gate: ReturnType<typeof gateVerdicts>, strict: boolean}} context
 * @returns {0|1}
 */
function printReport(report, retired, { manifest, gate, strict }) {
  const ambiguous = (key) => AMBIGUOUS_KEYS.has(key);
  const actionable = report.filter((r) => r.uses.length > 0);
  const cleanCurrent = report.filter((r) => r.kind === "current"
    && r.uses.every((h) => AMBIGUOUS_KEYS.has(h.key)));

  console.log(`retired-spelling-scan: ${report.length} 份**入库**活文档（清单 = \`git ls-files\`；`
    + `面 = \`docs/\` + 两份根 README，#572），`
    + `退役扁平键 ${retired.size} 个（派生自 src/loop/config-namespace.js − RUN_TOOL_LOOP_OPTION_NAMES）`);
  console.log("门禁：`npm run check:docs-spelling`（= --strict）在 CI 里阻塞，紧跟 `check:docs:strict`"
    + "（#560）；默认模式只打报告\n");

  console.log("── 扫描面（#560：只取入库文件，与开发树里未入库的本地档案无关；#572 补上根 README） ──────");
  console.log(`  清单来源：\`git ls-files --cached --full-name -- ${SCAN_PATHSPECS.join(" ")}\`（${manifest.length} 份 .md）`);
  console.log("  面是**显式** pathspec（docs/ + README.md + README_cn.md），**不是** `.`：扫描面不许偷偷变成整个仓库");
  console.log("  `docs/tasks/` 与 `docs/delivery/` 是故意不入库的本地档案（.gitignore）⇒ 不进面；"
    + "盘上有也不扫，所以主树与干净克隆给同一个答案");
  console.log("  git 不可用 / 不在仓库内 / 清单为空 ⇒ 显式报错 exit 2（不回退文件系统遍历）\n");

  console.log("── 分类（第一等公民，纯路径） ──────────────────────────────────");
  for (const kind of ["current", "history", "contract", "rootdoc"]) {
    const group = report.filter((r) => r.kind === kind);
    console.log(`  ${kind.padEnd(12)} ${String(group.length).padStart(3)} 份`);
  }
  const unregistered = report.filter((r) => r.kind === "current" && r.why.startsWith("未登记路径"));
  console.log(`  未登记路径按现状描述扫（未知分类不是免检）：${unregistered.length} 份`);
  console.log("\n  现状描述（改）：");
  for (const r of report.filter((x) => x.kind === "current")) console.log(`    ${r.file} — ${r.why}`);
  console.log("  历史记录（正文一字不改，只加横幅）：");
  for (const r of report.filter((x) => x.kind === "history")) console.log(`    ${r.file} — ${r.why}`);
  console.log("  契约（退役拼写的定义处，正文同样不改）：");
  for (const r of report.filter((x) => x.kind === "contract")) console.log(`    ${r.file} — ${r.why}`);
  console.log("  根文档（随包 README；示例必须可执行，其余同名命中靠钉子看守）：");
  for (const r of report.filter((x) => x.kind === "rootdoc")) console.log(`    ${r.file} — ${r.why}`);

  console.log("\n── 命中清单（只在代码语境里算；散文里的同名英文词不算） ───────");
  if (actionable.length === 0) console.log("  （无）");
  for (const r of actionable) {
    console.log(`\n  ${r.file}  [${r.kind}]  verdict=${r.verdict}`
      + `${r.pin === undefined ? "" : `  pin=${r.pin}`}`);
    for (const h of r.uses) {
      console.log(`    L${h.line}  ${h.key} → ${h.canonical}`
        + `${ambiguous(h.key) ? "  (ambiguous: 见 AMBIGUOUS_KEYS)" : ""}`);
      console.log(`         ${h.excerpt}`);
    }
  }

  console.log("\n── 现状类干净面（0 处**非 ambiguous** 命中；ambiguous 见 AMBIGUOUS_KEYS） ──");
  for (const r of cleanCurrent) {
    const amb = r.uses.length;
    console.log(`  ✓ ${r.file}：0 处退役拼写${amb === 0 ? "" : `（另有 ${amb} 处同名异义：形参 / 工厂参数 / 字段名）`}`);
  }

  const mentions = report.reduce((n, r) => n + r.hits.filter((h) => h.verdict === "mention").length, 0);
  // 红集合**不在这里算**（#575 A）：它来自 `gateVerdicts()`，与 `--json` 分支是同一份。
  const strictHits = gate.currentUses;
  const pinProblems = gate.suspect;
  const unpinned = gate.unpinned;
  const deadPins = gate.deadPins;

  // 钉子不符的文件必须**点名**：掉到 0 命中的文件不会出现在上面的命中清单里，
  // 所以「见上」必须真的指得到东西（门禁的红要能一眼看出是哪份文档）。
  if (pinProblems.length > 0 || unpinned.length > 0 || deadPins.length > 0) {
    console.log("\n── 钉子不符（正文被改写 / 新入历史类却没钉 / 钉子不在扫描面上） ────");
    for (const r of [...pinProblems, ...unpinned]) {
      console.log(`  ✗ ${r.file}  [${r.kind}]  verdict=${r.verdict}`
        + `  pin=${r.pin === undefined ? "（未登记）" : r.pin}  uses=${r.uses.length}`);
    }
    for (const p of deadPins) console.log(`  ✗ ${p.file}  DEAD-PIN  ${p.why}`);
  }

  console.log("\n── 判据 ───────────────────────────────────────────────────────");
  const curAll = actionable.filter((r) => r.kind === "current").reduce((n, r) => n + r.uses.length, 0);
  console.log(`  ① 现状类：${strictHits.length === 0 ? "干净（0 处退役拼写）" : `${strictHits.length} 处退役拼写 ⇒ 要改`}`
    + `；另有 ${curAll - strictHits.length} 处同名异义（ambiguous，不进判据）`);
  console.log(`  ② 历史/契约/根文档类 use 命中：${
    actionable.filter((r) => r.kind !== "current").reduce((n, r) => n + r.uses.length, 0)} 处`
    + "（**不算错**：那是当时的写法/契约的定义/README 在讲默认值，正文一个字不改；根文档的示例已在 #572 改对）");
  console.log(`  ③ 历史/契约/根文档正文钉子：${Object.keys(HISTORY_BODY_PINS).length}`
    + ` + ${Object.keys(CONTRACT_BODY_PINS).length} + ${Object.keys(ROOT_DOC_BODY_PINS).length} 份，`
    + `${pinProblems.length === 0 ? "全部等于实测（没有人在改写历史/契约/根文档）" : `${pinProblems.length} 份不符 ⇒ 见上`}`);
  console.log(`  ④ 有命中却没钉（新入历史/契约/根文档类忘了钉）：${unpinned.length} 份`
    + `${unpinned.length === 0 ? "" : ` ⇒ ${unpinned.map((r) => r.file).join(", ")}`}`);
  console.log(`  ⑤ 钉子与扫描面同源（每条钉子都得是一份入库文件）：${deadPins.length === 0 ? "全部在 `git ls-files` 清单里" : `${deadPins.length} 条死条目 ⇒ ${deadPins.map((p) => p.file).join(", ")}`}`);
  console.log(`  ⑥ 退役措辞行（mention，在讲退役这件事）：${mentions} 处，不计入上面五条`);

  if (strict) {
    console.log(`\n--strict: ${gate.red === 0 ? "OK — 0 处红" : `${gate.red} 处红`}`);
    return gateExitCode(gate, { strict });
  }
  console.log("\n结论：报告模式（exit 0）。门禁跑的是 `--strict`（`npm run check:docs-spelling`）。");
  return gateExitCode(gate, { strict });
}

// ── 8. 自测（内存夹具 / 临时树，不写盘到真文档） ───────────────────────────────
//
// 用例**先登记、后执行**（`t()` 只入队），执行阶段逐个 `await`：`#575 A` 的反向证要调 `runCli()` 自己
// 跑一遍真实路径（含 `--json` 分支的退出码），而那是异步的。同步用例照旧——`await` 一个同步返回值无害。
async function selfTest(retired, manifest) {
  const pending = [];
  const t = (name, fn) => pending.push([name, fn]);
  const eq = (actual, expected, what) => {
    if (actual !== expected) throw new Error(`${what}: 期望 ${expected}，实测 ${actual}`);
  };
  const keys = (text) => scanText(text, retired).map((h) => `${h.key}@L${h.line}:${h.verdict}`);

  t("现状类：围栏里的顶层扁平写点被报出来", () => {
    eq(keys("```js\nrunToolLoop({\n  toolResultTtl = 2,\n})\n```").join("|"),
      "toolResultTtl@L3:use", "围栏键位");
  });
  t("规位形态不报：`config.*` 之下的叶子名不是扁平写点", () => {
    eq(keys("```js\nrunToolLoop({\n  config: {\n    folding: {\n      toolResultTtl = 2,\n    },\n  },\n})\n```").length,
      0, "config 子树");
  });
  t("行内 span 的 `config.x.y` 尾段不报（负向后视的 `.`）", () => {
    eq(keys("`config.timing.timeoutMs` 是规位拼写").length, 0, "带点前缀");
  });
  t("行内 span 的裸键名报出来", () => {
    eq(keys("`toolResultTtl` defaults to `2`").join("|"), "toolResultTtl@L1:use", "裸 span");
  });
  t("退役措辞行降级为 mention（在讲退役，不是在用）", () => {
    eq(keys("the flat `toolResultTtl` is retired").join("|"), "toolResultTtl@L1:mention", "mention");
  });
  t("散文里的同名英文词不报（`user` message / `context` compaction）", () => {
    eq(keys("every user message is legal; context compaction rewrites the model view").length, 0, "散文");
  });
  t("分类判据不是空的：历史类命中数掉下去 ⇒ SUSPECT(dropped)", () => {
    const text = "```js\nrunToolLoop({ toolResultTtl = 2 })\n```";
    const uses = scanText(text, retired).filter((h) => h.verdict === "use");
    eq(uses.length, 1, "夹具先有 1 处命中");
    const rewritten = "```js\nrunToolLoop({ config: { folding: { toolResultTtl = 2 } } })\n```";
    eq(scanText(rewritten, retired).filter((h) => h.verdict === "use").length, 0, "改写成规位形态后命中归零");
    // 钉子机制本身：钉 1、实测 0 ⇒ 报 SUSPECT(dropped)（与真实扫描同一段判据）
    eq(verdictFor({ kind: "history", uses: 0, strictUses: 0, pin: 1 }), "SUSPECT(dropped)", "钉子没咬住");
  });
  t("每一条 pin 都与扫描面同源：既在盘上、又在 `git ls-files` 清单里（空转条目 = 后门）", () => {
    eq(deadPinEntries(manifest).length, 0,
      `真实树上的死条目（${deadPinEntries(manifest).map((p) => `${p.file}: ${p.why}`).join(" / ")}）`);
    for (const table of Object.values(PIN_TABLES)) {
      for (const rel of Object.keys(table)) {
        try {
          readFileSync(path.join(ROOT, rel), "utf8");
        } catch {
          throw new Error(`${rel} 不在盘上（死条目）`);
        }
      }
    }
  });
  t("死条目必须报错：钉子登记到一份不在清单里的文件 ⇒ 点名它（不入库的文件不许登记命中数）", () => {
    const pinned = Object.keys(HISTORY_BODY_PINS)[0];
    const mutated = manifest.filter((rel) => rel !== pinned);
    if (mutated.length === manifest.length) throw new Error(`变异没落上：${pinned} 不在清单里`);
    const dead = deadPinEntries(mutated);
    eq(dead.length, 1, "去掉一份钉住的文档后的死条目数");
    eq(dead[0].file, pinned, "死条目必须点名文件");
    if (!/git ls-files/.test(dead[0].why)) throw new Error(`死条目的理由没说清是清单问题：${dead[0].why}`);
    // 反向：钉子登记到一份本就不入库的路径 ⇒ 同样点名（这就是本单的病根形态）
    const untrackedPin = pinEntryProblems("history", { "docs/tasks/zzz-never-committed.md": 3 }, manifest);
    eq(untrackedPin.length, 1, "未入库路径的钉子数");
    eq(untrackedPin[0].file, "docs/tasks/zzz-never-committed.md", "未入库钉子的点名");
    // 另一个方向：钉子挂错表也要点名（否则用错规则去判）
    const wrongTable = pinEntryProblems("contract", { "docs/architecture.md": 2 }, manifest);
    eq(wrongTable.length, 1, "挂错表的钉子数");
    if (!/history|current/.test(wrongTable[0].why)) throw new Error(`挂错表没说清实测分类：${wrongTable[0].why}`);
    // 改回去（真实钉子表 + 真实清单）⇒ 绿
    eq(deadPinEntries(manifest).length, 0, "改回来之后必须绿");
  });
  t("清单只取 `git ls-files`：盘上有、但没入库的文件不进扫描面；面也**不是**整个仓库", () => {
    // 独立推导一次（不调本文件的函数，pathspec 也**逐字重写一遍**）：同一棵树里 git 说了算，
    // 文件系统说了不算。扫描面扩宽（#572）时这里不跟着改 ⇒ 本格红，而“面偷偷变成整个仓库”也红。
    const raw = execFileSync("git", ["ls-files", "--", "docs", "README.md", "README_cn.md"],
      { cwd: ROOT, encoding: "utf8" });
    const independent = raw.split("\n").filter((rel) => rel.endsWith(".md")).sort();
    eq(manifest.join("|"), independent.join("|"), "gitTrackedScanSurface() 与 `git ls-files` 的入库 .md 清单");
    if (manifest.length === 0) throw new Error("清单是空的：这道门会假绿");
    // 两份根 README 必须真的在面上（否则 #572 的扩面就只是注释里的话）。
    for (const rel of ROOT_DOC_TARGETS) {
      if (!manifest.includes(rel)) throw new Error(`根文档 ${rel} 不在扫描面上（#572 的扩面没生效）`);
      eq(classify(rel).kind, "rootdoc", `${rel} 的分类`);
    }
    // 面**不是**整个仓库：全仓 .md 里至少有 test/ 与 examples/ 的文档，而它们不在面上。
    const allMd = execFileSync("git", ["ls-files", "--", "."], { cwd: ROOT, encoding: "utf8" })
      .split("\n").filter((rel) => rel.endsWith(".md"));
    if (!(allMd.length > manifest.length)) {
      throw new Error(`扫描面（${manifest.length} 份）不小于全仓 .md（${allMd.length} 份）：面已经不是显式 pathspec 了`);
    }
    const leaked = manifest.filter((rel) => rel.startsWith("test/") || rel.startsWith("examples/")
      || rel.startsWith("fixtures/") || rel.startsWith("skills/"));
    eq(leaked.length, 0, `扫描面漏成了整个仓库：${leaked.join(", ")}`);
    // 盘上有、但 git 没跟踪的（含被 gitignore 的本地档案）一个都不许在面上。
    // 干净克隆里这个集合是空的（那时本条只剩上面的同源断言）；开发树里它非空 —— 那正是缺陷现场。
    const ignored = execFileSync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", "docs"],
      { cwd: ROOT, encoding: "utf8" }).split("\0").filter((rel) => rel.endsWith(".md"));
    const onSurface = ignored.filter((rel) => manifest.includes(rel));
    eq(onSurface.length, 0, `未入库文件进了扫描面：${onSurface.join(", ")}`);
    // 默认扫描面 === 清单（不是“盘上还有啥”）：
    const surface = scanDocs({ retired }).map((r) => r.file);
    eq(surface.join("|"), manifest.join("|"), "默认扫描面与 `git ls-files` 清单");
  });
  t("清单拿不到就报错退出：git 不可用 / 不在仓库内 / 空清单，都不许退回文件系统遍历", () => {
    const boom = () => {
      const error = new Error("spawnSync git ENOENT");
      error.code = "ENOENT";
      throw error;
    };
    const cases = [
      ["git 不在 PATH", { exec: boom }, /不在 git 仓库内|找不到 git/],
      ["仓库顶层不是本脚本所在目录", { exec: (args) => (args[0] === "rev-parse" ? "/somewhere/else\n" : "") }, /不是本脚本所在的/],
      ["`git ls-files` 失败", { exec: (args) => {
        if (args[0] === "rev-parse") return `${ROOT}\n`;
        throw new Error("fatal: bad pathspec");
      } }, /git ls-files/],
      ["空清单", { exec: (args) => (args[0] === "rev-parse" ? `${ROOT}\n` : "") }, /清单是空的/],
    ];
    for (const [what, io, expected] of cases) {
      let thrown = null;
      try {
        gitTrackedScanSurface(ROOT, io);
      } catch (error) {
        thrown = error;
      }
      if (thrown === null) throw new Error(`${what}：没报错（静默退回文件系统遍历了）`);
      if (!expected.test(thrown.message)) throw new Error(`${what}：报错没说清原因（${thrown.message}）`);
      if (!/拒绝退回文件系统遍历/.test(thrown.message)) throw new Error(`${what}：报错没声明“不回退”（${thrown.message}）`);
    }
    // 放行证：真 git 在真仓库里跑得通（否则上面四条只是“永远有话说”）
    if (gitTrackedScanSurface(ROOT).length === 0) throw new Error("真仓库里清单是空的：判据失效");
  });
  t("未登记路径按现状描述扫（未知分类不是免检）", () => {
    for (const rel of ["docs/zzz-unknown.md", "docs/nested/zzz-unknown_cn.md", "docs/design-not.md"]) {
      eq(classify(rel).kind, "current", `${rel} 的分类`);
    }
  });
  t("分类清单按路径，且 EN/CN 两侧都盖到", () => {
    const expected = [
      ["docs/architecture.md", "current"], ["docs/architecture_cn.md", "current"],
      ["docs/charts.md", "current"], ["docs/charts_cn.md", "current"],
      ["docs/requirements.md", "current"], ["docs/requirements_cn.md", "current"],
      ["docs/testing.md", "current"], ["docs/testing_cn.md", "current"],
      ["docs/maintenance-policy.md", "current"], ["docs/maintenance-policy_cn.md", "current"],
      ["docs/soak.md", "current"],
      ["docs/decisions/001-config-adapters_cn.md", "history"],
      ["docs/v0.2-contracts_cn.md", "history"],
      ["docs/design/2026-10-08-architecture-review.md", "history"],
      ["docs/research/2026-10-13-pi-subagents-async-attribution.md", "history"],
      ["docs/harness-comparison/06-cross-comparison.md", "history"],
      ["docs/suggestions/01-test-tmpdir.md", "history"],
      ["docs/issue-469-470-analysis.md", "history"],
      ["docs/tasks/261026-c469.md", "history"],
      ["docs/host-upgrade-guide-0.28.0.md", "history"],
      ["docs/host-upgrade-guide-0.28.0_cn.md", "history"],
      ["docs/host-consumer-contract.md", "contract"],
      ["docs/host-consumer-contract_cn.md", "contract"],
    ];
    for (const [rel, kind] of expected) eq(classify(rel).kind, kind, rel);
  });
  t("未知分类没有退路：拿一份未登记路径的真文本跑，判定仍按现状类算", () => {
    eq(verdictFor({ kind: classify("docs/zzz-unknown.md").kind, uses: 1, strictUses: 1 }), "REGRESSION", "未登记 + 1 处 use");
    eq(verdictFor({ kind: "history", uses: 1, strictUses: 1 }), "UNPINNED", "历史类有命中却没钉");
    eq(verdictFor({ kind: "contract", uses: 449, strictUses: 1, pin: 448 }), "SUSPECT(raised)", "契约钉子抬了");
    eq(verdictFor({ kind: "current", uses: 2, strictUses: 0 }), "review(ambiguous-only)", "只剩同名异义");
  });

  // ── #575 A 的反向证：造一棵**有红的面**，让真实 CLI 路径（含 `--json` 分支）自己说退出码 ──
  //
  // 树是从**真实入库面**复制出来的（125 份 docs，钉子逐条对得上），所以「干净面」不是靠放宽判据
  // 造出来的；git 用注入的假执行器（真 git 已被上面两例证过），盘上的文件是真的（`readFileSync`
  // 走真路径、`scanDocs` 走真判据）。**不碰真文档**：所有变异都落在临时树的副本上。
  const makeTree = () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "erix-spelling-fixture-")));
    for (const rel of manifest) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      copyFileSync(path.join(ROOT, rel), abs);
    }
    const exec = (args) => {
      if (args[0] === "rev-parse") return `${dir}\n`;
      if (args[0] === "ls-files") return manifest.map((rel) => `${rel}\0`).join("");
      throw new Error(`夹具 git 不认识这个子命令：${args.join(" ")}`);
    };
    return { dir, io: { exec } };
  };
  /** 跑一次真实 `runCli()`，把两条输出流收进内存（自测自己的报告不许被 JSON 淹没）。 */
  const runCaptured = async (argv, tree) => {
    const saved = { log: console.log, error: console.error };
    const out = [];
    const err = [];
    console.log = (...args) => out.push(args.map((a) => String(a)).join(" "));
    console.error = (...args) => err.push(args.map((a) => String(a)).join(" "));
    try {
      const code = await runCli({ argv, root: tree.dir, io: tree.io });
      return { code, stdout: out.join("\n"), stderr: err.join("\n") };
    } finally {
      console.log = saved.log;
      console.error = saved.error;
    }
  };
  const withTree = async (fn) => {
    const tree = makeTree();
    try {
      return await fn(tree);
    } finally {
      rmSync(tree.dir, { recursive: true, force: true });
    }
  };

  t("退出码与文本分支同源（#575 A）：`--strict --json` 在有红的面子上非 0，`--json` 单独跑仍是报告语义",
    () => withTree(async (tree) => {
      // 放行证先跑：干净面上两路必须都绿，否则下面的「非 0」可能只是恒非 0
      const clean = await runCaptured(["--strict", "--json"], tree);
      eq(clean.code, 0, "干净面 `--strict --json` 的退出码");
      const cleanPayload = JSON.parse(clean.stdout);
      eq(cleanPayload.gate.red, 0, "干净面的红数");
      eq(cleanPayload.gate.exitCode, 0, "干净面 JSON 自报的退出码");
      eq(cleanPayload.gate.wouldExitCode, 0, "干净面下「门禁会怎么答」也是 0（否则就是恒非 0）");

      // 造红：现状类文档末尾塞一句旧写法（就是工单 #575 复现的那一处）
      const soak = path.join(tree.dir, "docs/soak.md");
      writeFileSync(soak, `${readFileSync(soak, "utf8")}\n\`\`\`js\nrunToolLoop({ toolResultTtl = 2 })\n\`\`\`\n`);

      const strictJson = await runCaptured(["--strict", "--json"], tree);
      const payload = JSON.parse(strictJson.stdout);
      // 变异必须真的落上（#210 R2）：面不红 ⇒ 下面「非 0」证不到任何东西
      if (payload.gate.red === 0) throw new Error("夹具没变红：反向证失去靶子（变异没落上）");
      eq(payload.gate.counts.regression, 1, "红数里 REGRESSION 的条数");
      eq(strictJson.code, 1, "`--strict --json` 在有红的面子上的退出码");
      eq(payload.gate.exitCode, strictJson.code, "JSON 自报的退出码必须等于真实退出码（否则机器读到的是假话）");
      eq(payload.gate.gating, true, "门禁模式必须自报 gating=true");
      // 正题：红数 > 0 ⇒ 非 0 —— 这就是 #575 A 从前恒假绿的那一格。
      // `exitCode`（这一次运行）与 `wouldExitCode`（同一份红数在门禁下）都必须非 0。
      if (!(payload.gate.red > 0 && strictJson.code !== 0)) throw new Error("红数 > 0 而退出码是 0：假绿还在");
      eq(payload.gate.wouldExitCode, 1, "红面下「门禁会怎么答」的退出码");
      if (!/处红/.test(strictJson.stderr)) throw new Error(`红面下 stderr 没点名红数：${JSON.stringify(strictJson.stderr)}`);

      // 旗标顺序不许改变判定（工单复现里两种顺序都假绿过）
      eq((await runCaptured(["--json", "--strict"], tree)).code, 1, "`--json --strict` 的退出码");

      // 不带 `--strict`：既有语义不变（报告模式 exit 0），但红数照样报出来——不判 ≠ 没红
      const jsonOnly = await runCaptured(["--json"], tree);
      const jsonOnlyPayload = JSON.parse(jsonOnly.stdout);
      eq(jsonOnly.code, 0, "`--json` 单独跑的退出码（报告模式，既有语义）");
      eq(jsonOnlyPayload.gate.red, payload.gate.red, "报告模式与门禁模式的红数必须是同一份事实");
      eq(jsonOnlyPayload.gate.gating, false, "报告模式必须自报 gating=false（不许把不判写成没红）");
      eq(jsonOnlyPayload.gate.exitCode, jsonOnly.code, "报告模式 JSON 自报的退出码");
      // 「红数 > 0 ⇒ 非 0」在报告模式下也成立——只是落在 `wouldExitCode` 上（`exitCode` 是既有语义的 0）：
      // 两个字段同源于 `gateExitCode()`，所以没有第三种可能。
      eq(jsonOnlyPayload.gate.wouldExitCode, 1, "报告模式下的「门禁会怎么答」");
      eq(jsonOnlyPayload.gate.wouldExitCode, payload.gate.wouldExitCode,
        "同一棵树、同一份红数：两种模式给出的门禁判词必须相同");

      // 文本分支与 JSON 分支**同源同判**：同一棵树 ⇒ 同一个红数、同一个退出码
      const textStrict = await runCaptured(["--strict"], tree);
      eq(textStrict.code, strictJson.code, "文本分支与 `--json` 分支的退出码必须相同");
      if (!textStrict.stdout.includes(`${payload.gate.red} 处红`)) {
        throw new Error(`文本分支没报出同一个红数（期望 ${payload.gate.red} 处红）：`
          + JSON.stringify(textStrict.stdout.slice(-120)));
      }
    }));

  t("`--strict` 把 SUSPECT 抬成红（既有规则不变）：只掉历史钉子时门禁非 0、报告模式仍 0",
    () => withTree(async (tree) => {
      // 靶子：一份**有钉子**的历史文档被清空（= 有人把历史改写没了）⇒ SUSPECT(dropped)，与现状类无关
      const target = Object.keys(HISTORY_BODY_PINS)[0];
      writeFileSync(path.join(tree.dir, target), "# 空\n");
      const gate = await runCaptured(["--strict", "--json"], tree);
      const payload = JSON.parse(gate.stdout);
      eq(payload.gate.counts.suspect, 1, "SUSPECT 的条数");
      eq(payload.gate.counts.regression, 0, "这一格不该有现状类回归（否则证的不是「SUSPECT 抬红」）");
      eq(gate.code, 1, "`--strict` 下 SUSPECT 必须算红");
      const report = await runCaptured(["--json"], tree);
      eq(report.code, 0, "不带 `--strict` 时 SUSPECT 不算红（既有语义）");
      eq(JSON.parse(report.stdout).gate.counts.suspect, 1, "报告模式仍要把 SUSPECT 报出来（不判 ≠ 没红）");
    }));

  t("DEAD-PIN 也在同一份红集合里：钉子指向清单外文件 ⇒ `--strict --json` 非 0（两路同判）",
    () => withTree(async (tree) => {
      // 钉子表指向的某份文件**不在**清单里：这是 #560 定的「空转条目」，它本身就该红
      const victim = Object.keys(HISTORY_BODY_PINS)[0];
      const trimmed = manifest.filter((rel) => rel !== victim);
      const exec = (args) => {
        if (args[0] === "rev-parse") return `${tree.dir}\n`;
        if (args[0] === "ls-files") return trimmed.map((rel) => `${rel}\0`).join("");
        throw new Error(`夹具 git 不认识这个子命令：${args.join(" ")}`);
      };
      const gate = await runCaptured(["--strict", "--json"], { dir: tree.dir, io: { exec } });
      const payload = JSON.parse(gate.stdout);
      eq(payload.gate.counts.deadPins, 1, "死条目数");
      eq(payload.deadPins.length, 1, "JSON 的 deadPins 段");
      eq(gate.code, 1, "死条目在门禁下必须算红（`--json` 也不许把它吃掉）");
      const report = await runCaptured(["--json"], { dir: tree.dir, io: { exec } });
      eq(report.code, 0, "不带 `--strict` 时死条目不算红（既有语义）");
      eq(JSON.parse(report.stdout).gate.counts.deadPins, 1, "报告模式仍要把死条目报出来");
    }));

  // ── #572 的反向证：扫描面从 `docs/` 扩到「docs + 两份根 README」 ─────────────────
  //
  // 三格：① 往 README 里塞一句旧写法 ⇒ `--strict` 与 `--strict --json` 都红，还原 ⇒ 两路都绿；
  // ② 根文档的钉子对不上（正文被换掉 ⇒ 命中掉下去）⇒ SUSPECT(dropped) ⇒ 红；
  // ③ 根文档的钉子指向清单外（README 不在 `git ls-files` 里）⇒ DEAD-PIN ⇒ 红。
  // 三格都在临时树副本上做（不碰真文档），且都先跑一遍放行证。
  t("根文档扩面的反向证（#572）：README 里塞一句旧写法 ⇒ `--strict` 与 `--strict --json` 都红，还原 ⇒ 都绿",
    () => withTree(async (tree) => {
      // 放行证先跑：干净面上两路必须绿，否则下面的「非 0」可能只是恒非 0
      eq((await runCaptured(["--strict"], tree)).code, 0, "干净面 `--strict` 的退出码");
      const cleanJson = await runCaptured(["--strict", "--json"], tree);
      eq(cleanJson.code, 0, "干净面 `--strict --json` 的退出码");
      eq(JSON.parse(cleanJson.stdout).gate.red, 0, "干净面的红数");

      // 造红：往根文档里补一句**扁平拼写**（就是 #572 修的同一类形状）。
      // 选 README.md 而不是 `docs/`：这一格证的正是「面已经装进根文档了」——面没扩的话它恒绿。
      const readme = path.join(tree.dir, "README.md");
      const polluted = `${readFileSync(readme, "utf8")}\n\`\`\`js\nrunToolLoop({ maxRounds: 16 })\n\`\`\`\n`;
      writeFileSync(readme, polluted);

      const redText = await runCaptured(["--strict"], tree);
      const redJson = await runCaptured(["--strict", "--json"], tree);
      const payload = JSON.parse(redJson.stdout);
      // 变异必须真的落上（#210 R2）：面不红 ⇒ 下面两条退出码证不到任何东西
      if (payload.gate.red === 0) throw new Error("夹具没变红：根文档扩面的反向证失去靶子");
      eq(redText.code, 1, "根文档有旧写法时 `--strict` 的退出码");
      eq(redJson.code, 1, "根文档有旧写法时 `--strict --json` 的退出码（#575 A：两路同判）");
      eq(redJson.code, redText.code, "两条输出分支的退出码必须相同");
      eq(payload.gate.counts.suspect, 1, "根文档的钉子被抬了一格 ⇒ SUSPECT 一条");
      const hit = payload.files.find((f) => f.file === "README.md");
      eq(hit?.kind, "rootdoc", "README.md 的分类");
      if (!hit.uses.some((u) => u.key === "maxRounds")) {
        throw new Error(`README.md 里新塞的 maxRounds 没被报出来：${JSON.stringify(hit.uses.map((u) => u.key))}`);
      }
      if (!redText.stdout.includes("README.md")) {
        throw new Error("文本分支没点名 README.md：根文档的红看不见是哪份文件");
      }

      // 还原 ⇒ 两路都绿（不是“塞进去就永远红”）。
      writeFileSync(readme, readFileSync(readme, "utf8")
        .replace("\n```js\nrunToolLoop({ maxRounds: 16 })\n```\n", ""));
      eq((await runCaptured(["--strict"], tree)).code, 0, "还原后 `--strict` 的退出码");
      eq((await runCaptured(["--strict", "--json"], tree)).code, 0, "还原后 `--strict --json` 的退出码");
    }));

  t("根文档的钉子对不上 ⇒ 红（#572）：正文被换掉 ⇒ 命中掉下去 ⇒ SUSPECT(dropped)，门禁非 0、报告模式仍 0",
    () => withTree(async (tree) => {
      const readme = path.join(tree.dir, "README.md");
      writeFileSync(readme, "# README\n\n（正文被换掉了）\n");
      const gate = await runCaptured(["--strict", "--json"], tree);
      const payload = JSON.parse(gate.stdout);
      eq(payload.gate.counts.suspect, 1, "SUSPECT 的条数");
      eq(payload.gate.counts.regression, 0, "这一格不该有现状类回归（否则证的不是「钉子对不上」）");
      const entry = payload.files.find((f) => f.file === "README.md");
      eq(entry?.verdict, "SUSPECT(dropped)", "README.md 的判词");
      eq(entry?.pin, ROOT_DOC_BODY_PINS["README.md"], "钉子值必须原样报出来（好让人看出差多少）");
      eq(gate.code, 1, "钉子对不上时 `--strict --json` 必须非 0");
      eq((await runCaptured(["--strict"], tree)).code, 1, "文本分支同判");
      eq((await runCaptured(["--json"], tree)).code, 0, "报告模式仍 0（既有语义）");
    }));

  t("根文档的钉子指向清单外 ⇒ DEAD-PIN（#572）：README 不在 `git ls-files` 清单里 ⇒ `--strict` 非 0",
    () => withTree(async (tree) => {
      const trimmed = manifest.filter((rel) => !ROOT_DOC_TARGETS.includes(rel));
      if (trimmed.length === manifest.length) throw new Error("变异没落上：根文档本来就不在清单里");
      const exec = (args) => {
        if (args[0] === "rev-parse") return `${tree.dir}\n`;
        if (args[0] === "ls-files") return trimmed.map((rel) => `${rel}\0`).join("");
        throw new Error(`夹具 git 不认识这个子命令：${args.join(" ")}`);
      };
      const gate = await runCaptured(["--strict", "--json"], { dir: tree.dir, io: { exec } });
      const payload = JSON.parse(gate.stdout);
      eq(payload.gate.counts.deadPins, ROOT_DOC_TARGETS.length, "根文档的死条目数（中英各一条）");
      eq(payload.deadPins.map((p) => p.file).sort().join("|"), [...ROOT_DOC_TARGETS].sort().join("|"),
        "死条目必须点名两份根文档");
      for (const p of payload.deadPins) {
        if (!/git ls-files/.test(p.why)) throw new Error(`死条目没说清是清单问题：${p.why}`);
      }
      eq(gate.code, 1, "根文档的钉子是死条目时门禁必须红");
      // 文本分支必须走**同一份变异清单**（否则证的是另一个面，不是两路同判）
      eq((await runCaptured(["--strict"], { dir: tree.dir, io: { exec } })).code, 1, "文本分支同判");
      eq((await runCaptured(["--json"], { dir: tree.dir, io: { exec } })).code, 0, "报告模式仍 0（既有语义）");
    }));

  // ── #577 A 的反向证：`--json` 里的钉子事实**只有一份** ────────────────────────
  //
  // 病根：从前 `runCli()` 里写死 `pins: HISTORY_BODY_PINS` —— 那个字段只装三档里的历史一档，而名字
  // 看上去像“全部钉子”。本格四件事：① 干净面上真实 `--json` 输出必须让 `pinFactProblems()` 返回 0 条；
  // ② 三档**各自**都得真有带 pin 的条目（否则“三档都齐”是空话）；③ 把 #577 之前那个只装一档的 `pins`
  // 段塞回去 ⇒ 必须红；④ 把 contract/rootdoc 两档从 `files[].pin` 里掏空、或改一格值、或删一份带钉
  // 子的文件 ⇒ 必须红。“变不出来”也算失败（#210 R2）。
  t("`--json` 只带一份钉子事实（#577 A）：三档都在 `files[].pin` 里，只装一档的 `pins` 段回来了就红",
    () => withTree(async (tree) => {
      const clean = await runCaptured(["--strict", "--json"], tree);
      eq(clean.code, 0, "干净面 `--strict --json` 的退出码");
      const payload = JSON.parse(clean.stdout);
      const problems = pinFactProblems(payload);
      eq(problems.length, 0, `干净面的钉子事实（${problems.join(" / ")}）`);

      // 放行证：三档**各自**都有条目落在 `files[].pin` 上（空表也算“齐”的话本格就证不到东西）
      for (const [kind, table] of Object.entries(PIN_TABLES)) {
        const expected = Object.keys(table).length;
        if (expected === 0) throw new Error(`${kind} 档的钉子表是空的：这一格证不到“三档都齐”`);
        eq(payload.files.filter((f) => f.kind === kind && f.pin !== null && f.pin !== undefined).length,
          expected, `${kind} 档在 files[] 里带 pin 的条目数`);
      }
      // 且**不是**只装一档：三档合计远大于任何单独一档（否则“三档”退化成同一份事实）
      const total = Object.values(PIN_TABLES).reduce((n, table) => n + Object.keys(table).length, 0);
      if (!(total > Object.keys(HISTORY_BODY_PINS).length)) {
        throw new Error("三档合计不大于 history 一档：这一格已经退化成 #577 之前的形状");
      }

      // 反向证①：把 #577 之前那个字段原样塞回去（只装 history 档）⇒ 必须红
      const legacy = { ...payload, pins: HISTORY_BODY_PINS };
      if (pinFactProblems(legacy).length === 0) {
        throw new Error("`pins: HISTORY_BODY_PINS` 塞回去了却没红：反向证是空的");
      }
      // 反向证②：把 contract / rootdoc 两档从 `files[].pin` 里掏空（只留 history 档）⇒ 必须红
      const onlyHistory = {
        ...payload,
        files: payload.files.map((f) => (f.kind === "history" ? f : { ...f, pin: null })),
      };
      const emptied = pinFactProblems(onlyHistory);
      if (emptied.length === 0) throw new Error("contract/rootdoc 两档被掏空却没红：扩面后仍会被读成全部钉子");
      if (!emptied.some((p) => /≠ 三档钉子合计/.test(p))) {
        throw new Error(`掏空两档没报出“条目数对不上”：${emptied.join(" / ")}`);
      }
      // 反向证③：只改一格钉子值 ⇒ 必须点名那份文件（不是“总数对了就算”）
      const skewed = {
        ...payload,
        files: payload.files.map((f) => (f.file === "README.md" ? { ...f, pin: (f.pin ?? 0) + 1 } : f)),
      };
      const skewProblems = pinFactProblems(skewed);
      if (!skewProblems.some((p) => p.includes("README.md"))) {
        throw new Error(`改了一格钉子值却没点名 README.md：${skewProblems.join(" / ")}`);
      }
      // 反向证④：把一份带钉子的文件从 files[] 里删掉 ⇒ 必须红（总数会少一份，且那份文件点不到）
      const dropped = { ...payload, files: payload.files.filter((f) => f.file !== "README_cn.md") };
      if (pinFactProblems(dropped).length === 0) throw new Error("删掉一份带钉子的文件却没红");

      // 报告模式（不带 `--strict`）是同一份事实：钉子只跟扫描结果有关，与门禁开关无关
      const report = JSON.parse((await runCaptured(["--json"], tree)).stdout);
      eq(pinFactProblems(report).length, 0, "报告模式的钉子事实");
      eq(Object.prototype.hasOwnProperty.call(report, "pins"), false, "报告模式也不许带 `pins` 段");
    }));

  t("红集合是纯函数，且「红数 → 退出码」只有一份（门禁/报告两种模式逐格对账）", () => {
    const report = [
      { file: "docs/soak.md", kind: "current", verdict: "REGRESSION", uses: [{ key: "toolResultTtl" }] },
      { file: "docs/architecture.md", kind: "current", verdict: "review(ambiguous-only)", uses: [{ key: "timeoutMs" }] },
      { file: "docs/decisions/x.md", kind: "history", verdict: "SUSPECT(dropped)", uses: [] },
      { file: "docs/design/y.md", kind: "history", verdict: "UNPINNED", uses: [{ key: "maxTokens" }] },
      { file: "docs/charts.md", kind: "current", verdict: "ok", uses: [] },
    ];
    const deadPins = [{ file: "docs/zzz.md", why: "夹具" }];
    const gate = gateVerdicts({ report, deadPins });
    eq(gate.counts.regression, 1, "REGRESSION 条数");
    eq(gate.counts.suspect, 1, "SUSPECT 条数");
    eq(gate.counts.unpinned, 1, "UNPINNED 条数");
    eq(gate.counts.deadPins, 1, "DEAD-PIN 条数");
    eq(gate.red, 4, "红数（ambiguous-only 与 ok 都不进集合）");
    eq(gateExitCode(gate, { strict: true }), 1, "门禁模式：红数 > 0 ⇒ 1");
    eq(gateExitCode(gate, { strict: false }), 0, "报告模式：恒 0（既有语义）");
    const clean = gateVerdicts({ report: [{ file: "docs/charts.md", kind: "current", verdict: "ok", uses: [] }] });
    eq(clean.red, 0, "干净面的红数");
    eq(gateExitCode(clean, { strict: true }), 0, "门禁模式：红数 0 ⇒ 0");
    eq(gateExitCode(clean, { strict: false }), 0, "报告模式：恒 0");
  });

  const cases = [];
  for (const [name, fn] of pending) {
    try {
      await fn();
      cases.push([true, name]);
    } catch (error) {
      cases.push([false, `${name} — ${error.message}`]);
    }
  }

  const failed = cases.filter(([ok]) => !ok);
  for (const [ok, name] of cases) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  console.log(`\nretired-spelling-scan --self-test: ${failed.length === 0 ? `OK — ${cases.length} 例反向证/放行证全部按预期` : `${failed.length} 例失败`}`);
  return failed.length === 0 ? 0 : 1;
}

// ── 9. main ──────────────────────────────────────────────────────────────────
/**
 * 一次 CLI 运行。`root` / `io` 可注入 ⇒ 自测能在**临时树**上把真实路径（清单 → 扫描 → 判据 → 退出码）
 * 整条跑一遍，不碰真文档、也不假造判词。
 *
 * 退出码三档，语义不许混（#560 + #575 A）：
 *   · `0` = 绿（红数为 0；或报告模式——那是给人读的视图，不是门）；
 *   · `1` = **文档红了**（红数 > 0 且 `--strict`）；
 *   · `2` = **门自己坏了**（清单拿不到：git 不可用 / 不在仓库内 / 仓库顶层不是本脚本所在目录 / 空清单）。
 *
 * @param {{argv?: string[], root?: string, io?: {exec?: (args: string[], root: string) => string}}} [options]
 * @returns {Promise<number>} 进程退出码
 */
export async function runCli({ argv = process.argv.slice(2), root = ROOT, io } = {}) {
  const strict = argv.includes("--strict");
  const jsonOut = argv.includes("--json");
  const selfTestMode = argv.includes("--self-test");

  // 清单先算：拿不到就**显式**报错并 exit 2（不是 1 —— 1 是“文档红了”，2 是“门自己坏了”；两者都阻塞）。
  // 这里**没有** catch 后回退到文件系统遍历的分支，那条路已经被 #560 拆掉了。
  let manifest;
  try {
    manifest = gitTrackedScanSurface(root, io);
  } catch (error) {
    console.error(`retired-spelling-scan: ${error.message}`);
    console.error(`  仓库根：${root}`);
    return 2;
  }

  const retired = await retiredFlatKeys();
  if (selfTestMode) return selfTest(retired, manifest);

  const deadPins = deadPinEntries(manifest);
  const report = scanDocs({ root, retired, files: manifest });
  // 判据与退出码**只在这里算一次**（#575 A）：两条输出分支读同一份，谁都不许自己再拼一个 0。
  const gate = gateVerdicts({ report, deadPins });
  const exitCode = gateExitCode(gate, { strict });

  if (jsonOut) {
    const slim = report.map((r) => ({
      file: r.file, kind: r.kind, verdict: r.verdict, pin: r.pin ?? null,
      uses: r.uses.map((h) => ({ line: h.line, key: h.key, canonical: h.canonical, ambiguous: AMBIGUOUS_KEYS.has(h.key) })),
      mentions: r.hits.filter((h) => h.verdict === "mention").length,
    }));
    console.log(JSON.stringify({
      surface: { source: "git ls-files", files: manifest.length },
      // 门禁判词（#575 A）：`red` / `exitCode` 与文本分支同源（`gateVerdicts` / `gateExitCode`），
      // 所以机器读的那份不可能与进程真实退出码不一致。`gating: false`（报告模式）明说「这一跑不判」，
      // 免得 `red > 0` 被读成「门过了」。
      gate: {
        strict,
        gating: strict,
        mode: strict ? "gate" : "report",
        red: gate.red,
        counts: gate.counts,
        exitCode,
        // 「红数 > 0 ⇒ 非 0」这条不变式在**两种模式下都成立**：`exitCode` 是**这一次运行**的退出码
        // （报告模式恒 0，既有语义），`wouldExitCode` 是**同一份红数在门禁下**的退出码（与 `--strict`
        // 那一跑逐字相同）。两个字段都只从 `gateExitCode()` 来，所以谁也不能自己编一个 0。
        wouldExitCode: gateExitCode(gate, { strict: true }),
        exitCodes: { clean: 0, red: 1, manifestUnavailable: 2 },
      },
      retiredKeys: Object.fromEntries(retired),
      // 这里**故意没有**聚合的 `pins` 段（#577 A）：从前它是 `pins: HISTORY_BODY_PINS`，只装三档里的
      // 历史那一档（contract 2 份 / rootdoc 2 份都不在），而名字看上去像“全部钉子”。
      // 钉子事实只从 `files[].pin` 读——那份逐文件的事实本身就是完整的（`null` = 该文件无钉子），
      // 再聚一份只会漂：每多一档，重复那份就多一处会被读错的地方。
      deadPins,
      files: slim,
    }, null, 2));
    // 机器读法失败时也留一句人话在 stderr（stdout 必须保持是纯 JSON，不能被解释成脏数据）。
    if (exitCode !== 0) {
      console.error(`retired-spelling-scan --strict --json: ${gate.red} 处红`
        + `（REGRESSION ${gate.counts.regression} / SUSPECT ${gate.counts.suspect}`
        + ` / UNPINNED ${gate.counts.unpinned} / DEAD-PIN ${gate.counts.deadPins}）`);
    }
    return exitCode;
  }
  return printReport(report, retired, { manifest, gate, strict });
}

// 入口：本文件是 CLI（被 `import` 时也照旧跑一遍，与 #560 之前一致）。退出码走 `process.exitCode`，
// 不用 `process.exit()` —— 后者会跳过 stdout 的冲刷，`--json` 的大段输出可能被截断。
process.exitCode = await runCli();
