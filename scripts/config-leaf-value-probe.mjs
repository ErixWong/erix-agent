#!/usr/bin/env node
// config-leaf-value-probe.mjs — 配置叶子「值类型 / 值域」现状探针（issue #586；零依赖，仅 node: 内置）
//
// 病根（#586 的原文）：`CONFIG_NAMESPACE_SCHEMA`（`src/loop/config-namespace.js`）只描述**形状与归属**
// ——哪个叶存在、属 `init` 还是 `call`（`CONFIG_LEAF_BINDING`）——**不校值的类型/范围**。于是宿主写
// `config.run.maxRounds = "8"` 这类，要么一路带到使用点才炸，要么被上游的数值转换悄悄接受。
//
// 本脚本**只测不改**：对 `CONFIG_NAMESPACE_SCHEMA` 里的**每一个叶子**喂一张固定的错值矩阵，
// 把「今天的实际结局」记成一张表。它不修任何接受面（#586 的边界：每加一条类型校验都是收窄 ⇒ 要记
// Breaking，得有破坏预算才能做；裁定归维护者）。
//
// 三个结局的判据都是**实测**的，不是愿望：
//   · `G` gate —— 在 `config` 名称/形状闸口被拒（`assertConfigNamespace`，值规则 `CONFIG_LEAF_VALUE_RULES` 也在这一层）；
//   · `V` semantic —— 在语义相被拒（`assertSemanticOptionValues`，`src/assembly-validators.js`）；
//   · `S` startup —— 进了 run，但**第一发请求之前**就抛（引擎的取值校验，或取值校验漏掉之后的崩溃）；
//   · `U` use —— **第一发请求之后**才抛（真·带到使用点）；
//   · `A` accepted+live —— 没抛，且这次 run 的可观察指纹与基线**不同**（错值真的生效了）；
//   · `·` accepted+inert —— 没抛，且指纹与基线**逐字相同**（本场景里「配了等于没配」）；
//   · `H` hung —— 超过单格上限还没结束（今天不存在，留着是为了「探针自己坏了」不会静默）。
//
// 「拒在哪一层」由**栈帧**给出（第一个落在 `src/` 的帧的**文件名 + 函数名**，不含行号：行号会被
// 无关重构撞红，函数名只在语义变化时动）；「生效在哪」由**指纹差异的第一个路径**给出
// （`requests[0].temperature` 这种）——两者都是量出来的，不是手抄的。
//
// 用法（在仓库根跑）：
//   node scripts/config-leaf-value-probe.mjs                  # 打印摘要 + 叶子账 + 结局计数（人读视图）
//   node scripts/config-leaf-value-probe.mjs --json           # 同一份事实的机器读法
//   node scripts/config-leaf-value-probe.mjs --sync   <en> <cn>   # 机器刷表（两张文档一起重写）
//   node scripts/config-leaf-value-probe.mjs --verify <en> <cn>   # 验表（不改文件；不一致 ⇒ exit 1）
//
// 纪律（沿用 `test/compat-pin-inventory.md` / `scripts/flat-count-inventory.mjs` 的口径）：
//   · **表是量出来的，不是写出来的**：`--sync` 是改表唯一合法的姿势，**手改数字算伪造**；
//   · `--verify` 是 CI 阻塞门禁 `npm run check:config-leaf-values` 跑的那条；
//   · 探针自己先证「同一份输入两次跑出同一张表」（`assertDeterministic`）：指纹不稳的话，
//     `A` / `·` 的判定就是噪声，表再好看也是假的 —— 这一条让「探针坏了」变成 exit 2，而不是一张漂亮的红表。
//
// 边界（如实披露，别把这张表读成它没有的东西）：
//   · 只走**直连路线**（`runToolLoop({ config })`）。装配口 `policy.config` 过的是**同一道**
//     展开闸口（`expandConfigNamespace` 只有一份），所以闸口那几格的结局同源；差异只在 `via` 标签，
//     那一条由 #496 的测试钉住，不在本表重复。
//   · 场景是**一次两轮 run**（1 次工具调用 + 1 次 end_turn，无 store、无折叠触发）。所以 `·` 只回答
//     「**本场景里**没观察到差异」，不回答「这个值永远没有影响」——深分支（折叠、续跑、持久化、
//     judge、强制收尾）里的结局需要各自的场景，见文档 §6 的残留风险。
//   · 错值矩阵是**固定 8 个**（字符串数字 / 枚举式字符串 / 负数 / 小数 / 布尔 / null / 数组 / 对象），
//     逐叶相同。它不假装「每个叶子的正确类型是什么」——矩阵里每个格子只是「宿主可能写出来的某个值」，
//     结局由引擎自己说。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runToolLoop } from "../src/loop/orchestrator.js";
import {
  CONFIG_LEAF_BINDING,
  CONFIG_LEAF_BINDING_VALUES,
  CONFIG_LEAF_VALUE_RULE_PATHS,
  CONFIG_NAMESPACE_SCHEMA,
  configSchemaSelfCheck,
} from "../src/loop/config-namespace.js";
import { RUN_TOOL_LOOP_OPTION_NAMES } from "../src/loop/option-normalization.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "../test/helpers/fake-provider.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CELL_TIMEOUT_MS = 10_000;

// ── 1. 错值矩阵（固定、逐叶相同） ─────────────────────────────────────────────
/**
 * 8 个「宿主可能写出来」的错值。每个都是 `make()`：`[]` / `{}` 必须每格新造一个，否则引擎侧的
 * 就地改写会串到下一格去（那是探针自己造的假象）。
 *
 * `descCn` / `descEn` 只用于文档 §1 的那句话——**从这张表派生**，不另写一份值清单：散文说 `3.7`、
 * 矩阵喂 `0.5` 这种漂移，正是本表最不该有的谎言。
 *
 * ⚠ 小数那一格刻意是 `0.5`（不是 `3.7`）：`3.7` 与 `1000.5` 落在 `config.timing.*` 的
 * **治理阈值**附近（剩余预算 < 2×单轮耗时会触发收尾提示），一台忙机器上同一格会在 `A` 与 `·`
 * 之间抖动——实测 8 次里 2 次不同。`0.5` 把 `remainingMs` 直接压到负值，判定不再依赖机器负载
 * （实测 20 次 + 8 路并发同值），于是这两行才是可复现的证据而不是掷骰子。
 *
 * @type {ReadonlyArray<{label: string, make: () => unknown, descCn: string, descEn: string}>}
 */
const VALUE_MATRIX = Object.freeze([
  { label: '"8"', make: () => "8", descCn: "字符串数字", descEn: "numeric string" },
  { label: '"bogus"', make: () => "bogus", descCn: "枚举式字符串", descEn: "enum-ish string" },
  { label: "-1", make: () => -1, descCn: "负数", descEn: "negative" },
  { label: "0.5", make: () => 0.5, descCn: "小数（小于一）", descEn: "fraction (below one)" },
  { label: "true", make: () => true, descCn: "布尔", descEn: "boolean" },
  { label: "null", make: () => null, descCn: "null", descEn: "null" },
  { label: "[]", make: () => [], descCn: "数组", descEn: "array" },
  { label: "{}", make: () => ({}), descCn: "对象", descEn: "object" },
]);

// ── 2. 场景（一次两轮 run） ──────────────────────────────────────────────────
/** 两轮：第一轮要一个工具调用，第二轮 end_turn。后面几步是「万一错值改了终止判定」的余量。 */
const SCENARIO_SCRIPT = Object.freeze([
  { content: [{ type: "tool_use", id: "call-1", name: "echo", input: { text: "ping" } }], stopReason: "tool_use" },
  { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ...Array.from({ length: 6 }, () => ({ content: [{ type: "text", text: "done" }], stopReason: "end_turn" })),
]);

const SCENARIO_BASE_CONFIG = Object.freeze({
  input: { initialUserMessage: "go", wrapup: false },
  run: { completion: false },
});

/**
 * 跑一次场景，返回 `{ error, requestCount, fingerprint }`。
 *
 * 指纹只装**确定性**的部分：发给 provider 的请求体、事件流、结果骨架。易变字段（工具调用键、
 * 耗时）在 {@link normalize} 里折成占位符，于是「同输入两次跑出同一张表」是探针自己先证过的。
 *
 * @param {Record<string, unknown>} extraConfig 叠加在基线 `config` 上的组
 * @returns {Promise<{error: Error|null, hung: boolean, requestCount: number, fingerprint: unknown}>}
 */
async function runScenario(extraConfig) {
  const provider = createFakeProvider(SCENARIO_SCRIPT.map((step) => structuredClone(step)));
  const events = [];
  const toolCalls = [];
  // 场景基线**逐格新造**，并把错值**并进同一个组**（不是整组替换）：`{ ...base, input: { …错值 } }`
  // 会把基线的 `initialUserMessage` / `wrapup` 一起抹掉，于是「改了哪个旋钮」就说不清了。
  const config = structuredClone(SCENARIO_BASE_CONFIG);
  for (const [group, bag] of Object.entries(extraConfig)) {
    config[group] = { ...(config[group] ?? {}), ...bag };
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("__HUNG__"), CELL_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    const run = runToolLoop({
      provider,
      // 工具上下文是 `config.metadata.*` / `config.run.cwd` 唯一的落地处，不记下来这几行就永远是 `·`。
      executeTool: async (call) => {
        toolCalls.push({ name: call?.name, input: call?.input, context: call?.context });
        return "tool-output";
      },
      store: createMemoryTranscriptStore(),
      tools: [{ name: "echo", inputSchema: { type: "object" } }],
      config,
      onEvent: (event) => events.push(event),
    });
    const outcome = await Promise.race([run, timeout]);
    if (outcome === "__HUNG__") {
      return { error: null, hung: true, requestCount: provider.requests.length, fingerprint: null };
    }
    return {
      error: null,
      hung: false,
      requestCount: provider.requests.length,
      fingerprint: normalize({
        requests: provider.requests,
        toolCalls,
        events,
        result: {
          finalText: outcome.finalText,
          rounds: outcome.rounds,
          truncated: outcome.truncated,
          termination: outcome.termination,
          verification: outcome.verification?.status ?? null,
        },
      }),
    };
  } catch (error) {
    return { error, hung: false, requestCount: provider.requests.length, fingerprint: null };
  } finally {
    clearTimeout(timer);
  }
}

/** 指纹里折成占位符的字段：它们每次跑都会变，留着就是把噪声当信号。 */
const VOLATILE_KEYS = Object.freeze(new Set([
  "toolCallKey",
  "durationMs",
  "elapsedMs",
  "startedAt",
  "finishedAt",
  "timestamp",
  "generatedAt",
]));

/**
 * 把指纹里的易变字段折成占位符（递归，数组按下标）。
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function normalize(value) {
  // 函数不是数据：工具上下文里带着几个闭包（`reportPersistenceFailure` 之类），它们每次跑都是新的
  // 引用，逐字比会恒不相等 —— 那会让「每一格都 live」，把表变成噪声。折成占位符是口径，不是豁免。
  if (typeof value === "function") return "<function>";
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value === null || typeof value !== "object") return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = VOLATILE_KEYS.has(key) ? "<volatile>" : normalize(item);
  }
  return out;
}

/**
 * 两个指纹的**第一个**差异路径（`requests[0].temperature`），值折成短串。
 *
 * 只回答「哪里开始不一样」：这就是「错值生效在哪一层」的机器证据。没有差异返回 null。
 *
 * @param {unknown} left
 * @param {unknown} right
 * @param {string} [at]
 * @returns {{path: string, baseline: string, cell: string}|null}
 */
function firstDiff(left, right, at = "") {
  if (Object.is(left, right)) return null;
  const leftIsObject = left !== null && typeof left === "object";
  const rightIsObject = right !== null && typeof right === "object";
  if (!leftIsObject || !rightIsObject || Array.isArray(left) !== Array.isArray(right)) {
    return { path: at === "" ? "(root)" : at, baseline: brief(left), cell: brief(right) };
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  for (const key of new Set([...leftKeys, ...rightKeys])) {
    const next = Array.isArray(left) ? `${at}[${key}]` : at === "" ? key : `${at}.${key}`;
    const found = firstDiff(left[key], right[key], next);
    if (found !== null) return found;
  }
  return null;
}

/** 值 → 一行短串（差异描述用；长对象只留形状）。 */
function brief(value) {
  if (value === undefined) return "(absent)";
  const text = JSON.stringify(value) ?? String(value);
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}

// ── 3. 逐格结局 ──────────────────────────────────────────────────────────────
/**
 * 结局代码 → 判据（中英各一份，文档图例、计数表与默认摘要共用这一份，不另写第二份字符串）。
 *
 * @type {Readonly<Record<string, {cn: string, en: string}>>}
 */
export const VERDICT_LEGEND = Object.freeze({
  G: {
    cn: "gate：`config` 名称/形状闸口当场拒（值规则 `CONFIG_LEAF_VALUE_RULES` 也在这一层）",
    en: "gate: refused on the spot by the `config` name/shape gate (the value rules `CONFIG_LEAF_VALUE_RULES` live here too)",
  },
  V: {
    cn: "semantic：语义相拒（`assertSemanticOptionValues`）",
    en: "semantic: refused by the semantic phase (`assertSemanticOptionValues`)",
  },
  S: {
    cn: "startup：进了 run，第一发请求之前就抛，且**判词点名了这个叶子**（引擎的取值校验）",
    en: "startup: the run started, it threw before the first request, and **the verdict names this leaf** (an engine value check)",
  },
  C: {
    cn: "crash：进了 run，第一发请求之前就炸，但**判词不点名这个叶子**（引擎内部错误，宿主读不出该怎么改）",
    en: "crash: the run started, it blew up before the first request, but **the verdict does not name this leaf** (an engine-internal error the host cannot act on)",
  },
  U: {
    cn: "use：第一发请求之后才抛（真·带到使用点）",
    en: "use: threw only after the first request (genuinely carried to a use point)",
  },
  A: {
    cn: "accepted+live：没抛，且本次 run 的指纹与基线不同（错值真的生效了）",
    en: "accepted+live: nothing threw, and this run's fingerprint differs from the baseline (the wrong value really took effect)",
  },
  "·": {
    cn: "accepted+inert：没抛，且指纹与基线逐字相同（本场景里配了等于没配）",
    en: "accepted+inert: nothing threw, and the fingerprint is byte-identical to the baseline (configured but inert in this scenario)",
  },
  H: {
    cn: "hung：超过单格上限未结束",
    en: "hung: did not finish within the per-cell limit",
  },
});

/**
 * 栈里第一个 `src/` 帧 → `{ file, fn }`（不含行号：行号会被无关重构撞红）。
 *
 * @param {unknown} error
 * @returns {{file: string, fn: string}|null}
 */
function errorLayer(error) {
  const lines = String(/** @type {any} */ (error)?.stack ?? "").split("\n").slice(1);
  for (const line of lines) {
    const match = line.match(/\(?((?:file:\/\/)?[^()]*?\/src\/[^():]+\.js):\d+:\d+\)?$/);
    if (match === null) continue;
    const file = match[1].replace(/^file:\/\//, "").replace(`${ROOT}${path.sep}`, "");
    const fn = line.match(/^\s*at (?:async )?([^\s(]+) \(/)?.[1] ?? "(anonymous)";
    return { file, fn };
  }
  return null;
}

/**
 * 一格（叶子 × 错值）的实测结局。
 *
 * @param {string} leafPath `"<group>.<leaf>"`
 * @param {{label: string, make: () => unknown}} probe
 * @param {unknown} baseline 基线指纹
 * @returns {Promise<{leaf: string, value: string, code: string, layer: string, detail: string}>}
 */
async function probeCell(leafPath, probe, baseline) {
  const [group, leaf] = leafPath.split(".");
  const outcome = await runScenario({ [group]: { [leaf]: probe.make() } });
  if (outcome.hung) {
    return { leaf: leafPath, value: probe.label, code: "H", layer: "—", detail: `> ${CELL_TIMEOUT_MS} ms` };
  }
  if (outcome.error !== null) {
    const layer = errorLayer(outcome.error);
    const where = layer === null ? "(no src frame)" : `${path.basename(layer.file)} ${layer.fn}`;
    const file = layer?.file ?? "";
    const message = outcome.error?.message ?? "";
    const code = file.endsWith("src/loop/config-namespace.js")
      ? "G"
      : file.endsWith("src/assembly-validators.js")
        ? "V"
        : outcome.requestCount > 0
          ? "U"
          : namesLeaf(message, leafPath) ? "S" : "C";
    const name = outcome.error?.name ?? "Error";
    return {
      leaf: leafPath,
      value: probe.label,
      code,
      layer: where,
      detail: `${name}: ${outcome.error?.message ?? ""}`,
    };
  }
  const diff = firstDiff(baseline, outcome.fingerprint);
  if (diff === null) {
    return { leaf: leafPath, value: probe.label, code: "·", layer: "—", detail: "—" };
  }
  return {
    leaf: leafPath,
    value: probe.label,
    code: "A",
    layer: diff.path,
    detail: `${diff.path}: ${diff.baseline} → ${diff.cell}`,
  };
}

// ── 4. 叶子账（实测，不抄任何数字） ──────────────────────────────────────────
/**
 * 从 schema + 绑定表**现推**叶子账：总数、`init` / `call` 归属、分组、今天已有值规则的叶子。
 *
 * 自检不过就抛（exit 2）：一张建在坏 schema 上的表，比没有表更糟。
 *
 * @returns {{
 *   leaves: string[],
 *   bindings: Record<string, string>,
 *   groups: Array<{name: string, leaves: string[]}>,
 *   counts: {total: number, init: number, call: number},
 *   valueRules: string[],
 * }}
 */
export function leafAccount() {
  const problems = configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES);
  if (problems.length > 0) {
    throw new Error(`configSchemaSelfCheck 不绿，探针拒绝出表：\n  ${problems.join("\n  ")}`);
  }
  const groups = Object.keys(CONFIG_NAMESPACE_SCHEMA).map((name) => ({
    name,
    leaves: [...CONFIG_NAMESPACE_SCHEMA[name]],
  }));
  const leaves = groups.flatMap((group) => group.leaves.map((leaf) => `${group.name}.${leaf}`));
  const bindings = {};
  for (const leafPath of leaves) {
    const binding = CONFIG_LEAF_BINDING[leafPath];
    if (!CONFIG_LEAF_BINDING_VALUES.includes(binding)) {
      throw new Error(`叶子 ${leafPath} 没有合法绑定（实测 ${JSON.stringify(binding)}）——探针拒绝出表`);
    }
    bindings[leafPath] = binding;
  }
  const deadBindings = Object.keys(CONFIG_LEAF_BINDING).filter((leafPath) => !leaves.includes(leafPath));
  if (deadBindings.length > 0) {
    throw new Error(`CONFIG_LEAF_BINDING 里有死条目（不是 schema 叶子）：${deadBindings.join(", ")}`);
  }
  return {
    leaves,
    bindings,
    groups,
    counts: {
      total: leaves.length,
      init: leaves.filter((leafPath) => bindings[leafPath] === "init").length,
      call: leaves.filter((leafPath) => bindings[leafPath] === "call").length,
    },
    valueRules: Object.keys(CONFIG_LEAF_VALUE_RULE_PATHS),
  };
}

// ── 5. 确定性自证 ────────────────────────────────────────────────────────────
/**
 * 同一份输入连跑三次，指纹必须逐字相同；否则 `A` / `·` 的判定是噪声。
 *
 * 这是探针自己的门：不稳定 ⇒ exit 2，而不是把噪声写成一张漂亮的表。
 *
 * @returns {Promise<void>}
 */
async function assertDeterministic() {
  const runs = [];
  for (let index = 0; index < 3; index += 1) {
    const outcome = await runScenario({});
    if (outcome.error !== null) {
      throw new Error(`基线场景自己就抛了：${outcome.error?.message ?? outcome.error}`);
    }
    runs.push(JSON.stringify(outcome.fingerprint));
  }
  if (new Set(runs).size !== 1) {
    throw new Error("基线场景三次跑的指纹不一致——指纹里还有易变字段，A / · 的判定会是噪声");
  }
}

// ── 6. 全表 ──────────────────────────────────────────────────────────────────
/**
 * 跑完整张表：叶子账 + 基线 + 逐格结局 + 计数。
 *
 * @returns {Promise<ReturnType<typeof leafAccount> & {
 *   matrix: string[],
 *   rows: Array<Record<string, {code: string, layer: string, detail: string}>>,
 *   cells: Array<{leaf: string, value: string, code: string, layer: string, detail: string}>,
 *   tally: Record<string, number>,
 * }>}
 */
export async function buildTable() {
  const account = leafAccount();
  await assertDeterministic();
  const baselineOutcome = await runScenario({});
  if (baselineOutcome.error !== null) {
    throw new Error(`基线场景抛了：${baselineOutcome.error?.message ?? baselineOutcome.error}`);
  }
  const baseline = baselineOutcome.fingerprint;
  const cells = [];
  const rows = [];
  for (const leafPath of account.leaves) {
    /** @type {Record<string, {code: string, layer: string, detail: string}>} */
    const row = {};
    for (const probe of VALUE_MATRIX) {
      const cell = await probeCell(leafPath, probe, baseline);
      cells.push(cell);
      row[probe.label] = { code: cell.code, layer: cell.layer, detail: cell.detail };
    }
    rows.push(row);
  }
  const tally = {};
  for (const code of Object.keys(VERDICT_LEGEND)) tally[code] = 0;
  for (const cell of cells) tally[cell.code] = (tally[cell.code] ?? 0) + 1;
  return { ...account, matrix: VALUE_MATRIX.map((probe) => probe.label), rows, cells, tally };
}

// ── 7. 文档渲染 ──────────────────────────────────────────────────────────────
const DOC_EN = "docs/config-leaf-value-status.md";
const DOC_CN = "docs/config-leaf-value-status_cn.md";

/** 两个文档路径（`--sync` / `--verify` 的默认值，也是文档头里那两条命令的名字）。 */
export const DOC_PATHS = Object.freeze({ en: DOC_EN, cn: DOC_CN });

/**
 * 渲染一份文档（中英共用同一个数据源，只有散文不同）。
 *
 * ⚠ 表格单元格里的判词**不加反引号**：`retired-spelling-scan.mjs` 把「行内 span 以退役键名开头」
 * 记成扁平拼写命中，而判词里就有 `maxRounds must be …` 这种形态。写成纯文本它就不是代码语境，
 * 写成反引号反而会让这道硬门红——所以判词一栏一律裸文本。
 *
 * @param {"en"|"cn"} lang
 * @param {Awaited<ReturnType<typeof buildTable>>} table
 * @returns {string}
 */
export function renderDoc(lang, table) {
  const cn = lang === "cn";
  const t = (zh, en) => (cn ? zh : en);
  const lines = [];
  const push = (...items) => lines.push(...items);

  push(
    t("# 配置叶子的「值类型 / 值域」现状表（issue #586）",
      "# Config leaf value-type / value-range status table (issue #586)"),
    "",
    t("> ⚠ **本表由探针生成，手改数字算伪造。** 生成器：`scripts/config-leaf-value-probe.mjs`",
      "> ⚠ **This table is generated by a probe; hand-editing a number is fabrication.** Generator: `scripts/config-leaf-value-probe.mjs`"),
    t(`> 复现（一条命令重出全表）：\`node scripts/config-leaf-value-probe.mjs\`；`,
      `> Reproduce (one command, whole table): \`node scripts/config-leaf-value-probe.mjs\`;`),
    t(`> 刷表（唯一合法姿势）：\`node scripts/config-leaf-value-probe.mjs --sync ${DOC_EN} ${DOC_CN}\`；`,
      `> Re-sync (the only legitimate way): \`node scripts/config-leaf-value-probe.mjs --sync ${DOC_EN} ${DOC_CN}\`;`),
    t(`> 验表（CI 阻塞步 \`npm run check:config-leaf-values\`）：\`node scripts/config-leaf-value-probe.mjs --verify ${DOC_EN} ${DOC_CN}\`。`,
      `> Verify (blocking CI step \`npm run check:config-leaf-values\`): \`node scripts/config-leaf-value-probe.mjs --verify ${DOC_EN} ${DOC_CN}\`.`),
    "",
  );

  // §1 口径
  push(
    t("## 1. 探针口径（这张表到底测了什么）", "## 1. Probe protocol (what this table actually measures)"),
    "",
    t(`**错值矩阵**：每个叶子逐字喂同一组 ${VALUE_MATRIX.length} 个值 —— ${VALUE_MATRIX.map((probe) => `\`${probe.label}\`（${probe.descCn}）`).join("、")}。矩阵不假装知道「每个叶子的正确类型是什么」：每个格子只是「宿主可能写出来的一个值」，结局由引擎自己说。`,
      `**Wrong-value matrix**: every leaf gets the same ${VALUE_MATRIX.length} values — ${VALUE_MATRIX.map((probe) => `\`${probe.label}\` (${probe.descEn})`).join(", ")}. The matrix does not pretend to know each leaf's correct type: a cell is just "a value a host might write", and the engine gives the verdict.`),
    "",
    t("⚠ 矩阵里**有些格子对某些叶子本来就是合法类型**（`true` 对布尔叶子、`{}` 对对象叶子、`\"8\"` / `\"bogus\"` 对字符串叶子、`[]` 对消息列表）。它们是**对照组**：证明探针不是把所有值都判红，读表时别把「合法值被接受」读成漏校验。",
      "⚠ **Some cells are legitimately typed for some leaves** (`true` for a boolean leaf, `{}` for an object leaf, `\"8\"` / `\"bogus\"` for a string leaf, `[]` for a message list). They are **controls**: proof that the probe does not redden everything. Do not read \"a legal value was accepted\" as a missing check."),
    "",
    t("**场景**：一次两轮 run（第一轮 1 次工具调用，第二轮 end_turn），带一个内存 store（`createMemoryTranscriptStore`，不落盘），不触发折叠、不触发 judge。跑一次直连路线 `runToolLoop({ config })`，把 provider 收到的请求体、工具调用上下文、事件流与结果骨架做成**指纹**；指纹里易变的字段（工具调用键、耗时、闭包）折成占位符。",
      "**Scenario**: one two-round run (round 1 makes one tool call, round 2 ends with end_turn) with an in-memory store (`createMemoryTranscriptStore`, nothing touches the disk); folding and judge are never triggered. A direct-route `runToolLoop({ config })` is run once, and the provider's request bodies, the tool-call context, the event stream and the result skeleton become a **fingerprint**; volatile fields (tool-call keys, durations, closures) are folded into placeholders."),
    "",
    t("**八种结局**（代码 → 判据）：", "**Eight verdicts** (code → criterion):"),
    "",
  );
  for (const [code, text] of Object.entries(VERDICT_LEGEND)) {
    push(`- \`${code}\` — ${t(text.cn, text.en)}`);
  }
  push(
    "",
    t("「拒在哪一层」由**栈帧**给出：第一个落在 `src/` 的帧，取**文件名 + 函数名**（不取行号——行号会被无关重构撞红，函数名只在语义变化时动）。「生效在哪」由**指纹差异的第一个路径**给出（`requests[0].temperature` 这种），所以「悄悄接受」不是形容词，是一个具体位置加一对值。",
      "\"Which layer rejected it\" comes from the **stack frame**: the first frame inside `src/`, reduced to **file name + function name** (no line numbers — those go red on unrelated refactors, while function names only move when semantics do). \"Where it took effect\" comes from the **first differing path** in the fingerprint (e.g. `requests[0].temperature`), so \"silently accepted\" is not an adjective: it is a concrete location plus a pair of values."),
    "",
    t("**边界（别把这张表读成它没有的东西）**：只测直连路线（装配口 `policy.config` 过的是**同一道**展开闸口，差异只在 `via` 标签，那条由 #496 的测试钉住）；`·` 只回答「**本场景里**没观察到差异」，不回答「这个值永远没有影响」——折叠、续跑、持久化、judge、强制收尾这些深分支各有各的触发条件，本表不覆盖。",
      "**Boundaries (do not read more into this table than it says)**: direct route only (the assembly port's `policy.config` goes through the **same** expansion gate; only the `via` tag differs, and #496's tests pin that); `·` answers \"no observable difference **in this scenario**\", never \"this value can never matter\" — folding, resume, persistence, judge and the final guard are deep branches with their own triggers and are not covered here."),
    "",
  );

  // §2 叶子账
  push(
    t("## 2. 叶子账（实测，不抄任何数字）", "## 2. Leaf account (measured, no number copied)"),
    "",
    t(`**实测 ${table.counts.total} 叶 = ${table.counts.init} init / ${table.counts.call} call**，分 ${table.groups.length} 组；今天**已有值规则**的叶子 ${table.valueRules.length} / ${table.counts.total}：${table.valueRules.map((leafPath) => `\`config.${leafPath}\``).join("、")}。`,
      `**Measured: ${table.counts.total} leaves = ${table.counts.init} init / ${table.counts.call} call**, in ${table.groups.length} groups; **${table.valueRules.length} of ${table.counts.total}** leaves carry a value rule today: ${table.valueRules.map((leafPath) => `\`config.${leafPath}\``).join(", ")}.`),
    "",
    t("| 分组 | 叶数 | 叶子 |", "| group | leaves | names |"),
    "| --- | --- | --- |",
  );
  for (const group of table.groups) {
    // 叶子写成 `<group>.<leaf>`（不带反引号前缀的裸叶名会被 `retired-spelling-scan.mjs` 记成
    // 扁平拼写命中——它分不清「表里列了一个叶子」与「宿主照着写了扁平键」，而这里正是前者）。
    push(`| \`${group.name}\` | ${group.leaves.length} | ${group.leaves.map((leaf) => `\`${group.name}.${leaf}\``).join(" ")} |`);
  }
  push(
    `| **${t("合计", "total")}** | **${table.counts.total}** | **${table.counts.init} init / ${table.counts.call} call** |`,
    "",
    t("⚠ 两件事别混进来：① `init` / `call` 这一列是 **#571 片1** 的产物（`CONFIG_LEAF_BINDING`），本单只把它当一列读出来，一个绑定都没新增或改动；② **「键名不存在」那道闸口**（#571 片1 已落地）**不是本单的产物**——表里 `G` 那几格是**值规则**（`CONFIG_LEAF_VALUE_RULES`，今天只有 `config.run.stream`（#538）与 `config.continuity.handoff`（#598）两条），键名闸口管的是「这个键存不存在」，本表测的是「这个值合不合法」。",
      "⚠ Two things must not be mixed in here: ① the `init` / `call` column is **#571 slice 1**'s product (`CONFIG_LEAF_BINDING`); this slice only reads it as a column and adds or changes no binding; ② the **\"this key does not exist\" gate** (shipped in #571 slice 1) **is not this slice's product** — the `G` cells in the table are **value rules** (`CONFIG_LEAF_VALUE_RULES`: today only `config.run.stream` (#538) and `config.continuity.handoff` (#598)), while the name gate answers \"does this key exist\" and this table answers \"is this value legal\"."),
    "",
    t("本单**零行为变更**：`src/` 一个字节都没动，接受面没有收窄也没有放宽（裁定归维护者，见 §6）。",
      "**Zero behaviour change** in this slice: not one byte of `src/` moved, and the accepted surface is neither narrowed nor widened (the ruling belongs to the maintainer, see §6)."),
    "",
  );

  // §3 矩阵
  push(
    t("## 3. 现状矩阵（叶 × 错值）", "## 3. Status matrix (leaf × wrong value)"),
    "",
    t("行 = 叶子（`init` / `call` 归属来自 `CONFIG_LEAF_BINDING`），列 = 喂进去的错值，格 = 结局代码（图例见 §1）。",
      "Rows = leaves (`init` / `call` comes from `CONFIG_LEAF_BINDING`), columns = the wrong value fed in, cells = the verdict code (legend in §1)."),
    "",
    `| ${t("叶子", "leaf")} | ${t("绑定", "binding")} | ${table.matrix.map((label) => `\`${label}\``).join(" | ")} |`,
    `| --- | --- | ${table.matrix.map(() => "---").join(" | ")} |`,
  );
  table.leaves.forEach((leafPath, index) => {
    const row = table.rows[index];
    push(`| \`config.${leafPath}\` | ${table.bindings[leafPath]} | ${table.matrix.map((label) => row[label].code).join(" | ")} |`);
  });
  push("");

  // §4 计数
  push(
    t("## 4. 结局计数（逐格实测）", "## 4. Verdict counts (per cell)"),
    "",
    `| ${t("代码", "code")} | ${t("格数", "cells")} | ${t("判据", "criterion")} |`,
    "| --- | --- | --- |",
  );
  for (const [code, text] of Object.entries(VERDICT_LEGEND)) {
    push(`| \`${code}\` | ${table.tally[code] ?? 0} | ${t(text.cn, text.en)} |`);
  }
  push(`| **${t("合计", "total")}** | **${table.cells.length}** | ${table.leaves.length} × ${table.matrix.length} |`, "");

  // §5 逐格明细
  const interesting = table.cells.filter((cell) => cell.code !== "·");
  push(
    t("## 5. 逐格明细（非 inert 的每一格：拒在哪层 / 判词原文 / 生效在哪）",
      "## 5. Per-cell detail (every non-inert cell: layer / verbatim verdict / where it took effect)"),
    "",
    t(`共 ${interesting.length} 格（其余 ${table.cells.length - interesting.length} 格是 \`·\`，即本场景无可观察差异，不列）。判词是引擎的原话，逐字未改。`,
      `${interesting.length} cells (the other ${table.cells.length - interesting.length} are \`·\`: no observable difference in this scenario, not listed). Verdicts are the engine's own words, verbatim.`),
    "",
    `| ${t("叶子", "leaf")} | ${t("错值", "value")} | ${t("结局", "code")} | ${t("层 / 生效路径", "layer / effect path")} | ${t("判词原文 / 可观察差异", "verbatim verdict / observable diff")} |`,
    "| --- | --- | --- | --- | --- |",
  );
  for (const cell of interesting) {
    push(
      `| \`config.${cell.leaf}\` | \`${cell.value}\` | ${cell.code} | ${cell.layer} | ${cell.detail.replace(/\|/g, "\\|")} |`,
    );
  }
  push("");

  // §6 裁定建议
  push(
    t("## 6. 裁定建议（本单不收窄任何接受面）", "## 6. Ruling suggestions (this slice narrows nothing)"),
    "",
    t("**本单一个字都没改行为。** 下面只是按这张表排出的候选，供维护者裁定「哪一条值得进下一个 breaking 版本」——每条收窄都是**收窄接受面** ⇒ 要记 Breaking，得有破坏预算才能做。",
      "**This slice changes no behaviour at all.** What follows is only a ranking of candidates derived from this table, for the maintainer to rule on which one earns a breaking budget — every narrowing **shrinks the accepted surface**, so it must be booked as Breaking."),
    "",
  );
  for (const item of candidateRanking(table, lang)) {
    push(`- ${item}`);
  }
  push("");

  // §7 残留风险
  push(
    t("## 7. 残留风险 / 这张表不覆盖的东西", "## 7. Residual risks / what this table does not cover"),
    "",
    t("- **场景面**：一次两轮 run。折叠、续跑（`config.run.resume`）、持久化（`config.run.persistence`）、judge（`config.run.reflection`）、强制收尾（`config.guard.*`）与续接块（`config.continuity.handoff`）的深分支没有被触发，`·` 在这些叶子上只说明「本场景没走到」；",
      "- **Scenario coverage**: one two-round run. The deep branches of folding, resume (`config.run.resume`), persistence (`config.run.persistence`), judge (`config.run.reflection`), the final guard (`config.guard.*`) and the continuity block (`config.continuity.handoff`) are never triggered, so `·` on those leaves only means \"this scenario did not reach it\";"),
    t("- **路线面**：只测直连路线。装配口 `policy.config` 与它共用同一道展开闸口（`expandConfigNamespace`），但那条路线上的 `via` 标签与构造期抛错次序不在本表内；",
      "- **Route coverage**: direct route only. The assembly port's `policy.config` shares the same expansion gate (`expandConfigNamespace`), but its `via` tag and construction-time ordering are outside this table;"),
    t("- **矩阵面**：8 个错值不是「全部错值」。每个叶子都可能有这张矩阵没喂到的错型（比如 `NaN`、形状对但语义错的对象）；",
      "- **Matrix coverage**: 8 wrong values are not \"all wrong values\". Every leaf may have wrong shapes this matrix never feeds (e.g. `NaN`, or a correctly-shaped but semantically wrong object);"),
    t("- **时间面（`config.timing.*`）**：小数那一格是 `0.5` 不是 `3.7` —— `3.7` / `1000.5` 落在治理层的「剩余预算 < 2×单轮耗时 ⇒ 收尾提示」阈值附近，同一格在一台忙机器上会在 `A` 与 `·` 之间抖动（实测 8 次里 2 次不同）；`0.5` 把剩余预算直接压成负值，判定不再依赖机器负载（实测 20 次 + 8 路并发同值）。读表时把这两行当「阈值附近的抖动被消掉了」，不是「时间叶子已经测全了」；",
      "- **Time (`config.timing.*`)**: the fraction cell is `0.5`, not `3.7` — `3.7` / `1000.5` sit near the governor's \"remaining budget < 2× one round's cost ⇒ wrap-up nudge\" threshold, so on a loaded machine the same cell flips between `A` and `·` (measured: 2 of 8 runs disagreed); `0.5` drives the remaining budget negative, so the verdict no longer depends on machine load (measured: 20 sequential runs plus 8 concurrent ones, all identical). Read those two rows as \"the jitter near the threshold was removed\", not as \"the time leaves are fully covered\";"),
    t("- **判词稳定性**：明细表记的是**今天的**判词原文。引擎改一句话就会让 `--verify` 红——那是**设计如此**（表是量出来的），刷表姿势是 `--sync`，不是手改。",
      "- **Verdict stability**: the detail table records **today's** verbatim verdicts. Changing one engine sentence turns `--verify` red — that is **by design** (the table is measured); the way to refresh it is `--sync`, never a hand edit."),
    "",
  );

  return `${lines.join("\n")}\n`;
}

/**
 * 按「这张表最刺眼的证据」排候选（纯数据推导；三类排序的判据写死在这里，叶子清单由表算出来）。
 *
 * ① 错值**真的生效**（`A`）的叶子——错值一路流到 provider 请求体、工具上下文或事件里；
 * ② 错值炸成**不点名该叶子**的引擎错误（`C` / `U`）的叶子；
 * ③ 8 个错值**全部静默接受**（`·` 满格）的叶子——今天「配了等于没配」。
 *
 * @param {Awaited<ReturnType<typeof buildTable>>} table
 * @param {"en"|"cn"} [lang]
 * @returns {string[]}
 */
function candidateRanking(table, lang = "cn") {
  const cn = lang === "cn";
  const perLeaf = new Map();
  for (const cell of table.cells) {
    const entry = perLeaf.get(cell.leaf) ?? { A: 0, S: 0, C: 0, U: 0, G: 0, V: 0, "·": 0, H: 0 };
    entry[cell.code] += 1;
    perLeaf.set(cell.leaf, entry);
  }
  const pick = (predicate) => [...perLeaf].filter(predicate).map(([leaf]) => leaf);
  const live = pick(([, entry]) => entry.A > 0);
  const crash = pick(([, entry]) => entry.C + entry.U > 0);
  const inert = pick(([, entry]) => entry["·"] === table.matrix.length);
  const list = (leaves) => (leaves.length === 0
    ? (cn ? "（无）" : "(none)")
    : leaves.map((leaf) => `\`config.${leaf}\``).join(cn ? "、" : ", "));
  return [
    cn
      ? `① 错值**真的生效**（\`A\`）的叶子 ${live.length} 个：${list(live)}——收窄它们改的是「宿主写错却照跑」的行为，影响面最大，也最容易在宿主侧炸出「以前能跑」；`
      : `① Leaves where a wrong value **really takes effect** (\`A\`): ${live.length} — ${list(live)}. Narrowing them changes "the host wrote nonsense and it ran anyway", the widest blast radius and the most likely to break a host that used to work;`,
    cn
      ? `② 错值炸成**不点名该叶子**的引擎错误（\`C\` / \`U\`）的叶子 ${crash.length} 个：${list(crash)}——这些今天已经是硬失败，但判词不教宿主怎么改，补类型校验是**把错误提前并点名**，不改变「失败」这个事实；`
      : `② Leaves where a wrong value blows up as an **engine error that does not name the leaf** (\`C\` / \`U\`): ${crash.length} — ${list(crash)}. These already fail hard today, but the verdict does not tell the host what to fix; adding a type check only **moves the failure earlier and names it**, it does not change the fact that it fails;`,
    cn
      ? `③ 8 个错值**全部静默接受**（\`·\` 满格）的叶子 ${inert.length} 个：${list(inert)}——它们最像「配了等于没配」，但 \`·\` 只说明本场景没走到（见 §7），裁定前需要各自的深分支场景。`
      : `③ Leaves where all 8 wrong values are **silently accepted** (all \`·\`): ${inert.length} — ${list(inert)}. They look most like "configured but inert", but \`·\` only says this scenario never reached them (see §7); each needs its own deep-branch scenario before a ruling.`,
  ];
}

/**
 * 判词里有没有点名这个叶子（叶子名与 `config.<group>.<leaf>` 两种写法都算）。
 *
 * @param {string} detail
 * @param {string} leafPath
 * @returns {boolean}
 */
function namesLeaf(detail, leafPath) {
  const leaf = leafPath.split(".").at(-1);
  return detail.includes(`config.${leafPath}`) || new RegExp(`(?<![\\w$.])${leaf}(?![\\w$])`).test(detail);
}

// ── 8. CLI ───────────────────────────────────────────────────────────────────
function usage() {
  return [
    "用法 / usage:",
    "  node scripts/config-leaf-value-probe.mjs                        # 人读摘要",
    "  node scripts/config-leaf-value-probe.mjs --json                 # 机器读法",
    `  node scripts/config-leaf-value-probe.mjs --sync   ${DOC_PATHS.en} ${DOC_PATHS.cn}`,
    `  node scripts/config-leaf-value-probe.mjs --verify ${DOC_PATHS.en} ${DOC_PATHS.cn}`,
  ].join("\n");
}

async function main(argv) {
  const [mode, enPath, cnPath] = argv;
  if (mode === "--help" || mode === "-h") {
    console.log(usage());
    return 0;
  }
  if (mode !== undefined && !["--json", "--sync", "--verify"].includes(mode)) {
    console.error(`未知参数：${mode}\n${usage()}`);
    return 2;
  }
  if ((mode === "--sync" || mode === "--verify") && (enPath === undefined || cnPath === undefined)) {
    console.error(`--sync / --verify 需要两个文档路径\n${usage()}`);
    return 2;
  }
  const table = await buildTable();
  if (mode === "--json") {
    console.log(JSON.stringify({
      counts: table.counts,
      groups: table.groups,
      valueRules: table.valueRules,
      matrix: table.matrix,
      tally: table.tally,
      cells: table.cells,
    }, null, 2));
    return 0;
  }
  const rendered = new Map([
    [enPath ?? DOC_PATHS.en, renderDoc("en", table)],
    [cnPath ?? DOC_PATHS.cn, renderDoc("cn", table)],
  ]);
  if (mode === "--sync") {
    for (const [file, text] of rendered) writeFileSync(path.join(ROOT, file), text, "utf8");
    console.log(`✓ 已刷表：${[...rendered.keys()].join(" / ")}`);
    return 0;
  }
  if (mode === "--verify") {
    const problems = [];
    for (const [file, text] of rendered) {
      let actual;
      try {
        actual = readFileSync(path.join(ROOT, file), "utf8");
      } catch (error) {
        problems.push(`${file}: 读不到（${error?.code ?? error}）——先跑 --sync`);
        continue;
      }
      if (actual !== text) problems.push(`${file}: 与实测不一致（表漂了或手改过）——跑 --sync 刷表`);
    }
    if (problems.length > 0) {
      console.error(problems.map((line) => `✗ ${line}`).join("\n"));
      return 1;
    }
    console.log(`✓ 表与实测一致：${[...rendered.keys()].join(" / ")}`);
    return 0;
  }
  // 默认：人读摘要
  console.log(`叶子账：${table.counts.total} 叶 = ${table.counts.init} init / ${table.counts.call} call，`
    + `${table.groups.length} 组；今天有值规则的叶子 ${table.valueRules.length} 个：${table.valueRules.join(", ")}`);
  console.log(`矩阵：${table.leaves.length} 叶 × ${table.matrix.length} 值 = ${table.cells.length} 格`);
  for (const [code, text] of Object.entries(VERDICT_LEGEND)) {
    console.log(`  ${code.padEnd(2)} ${String(table.tally[code] ?? 0).padStart(3)}  ${text.cn}`);
  }
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`✗ 探针自己失败（exit 2）：${error?.stack ?? error}`);
    process.exitCode = 2;
  });
}
