#!/usr/bin/env node
/**
 * suite-summary-reconcile.mjs — 把 `node --test`（`npm test`）**自己打印的 TAP 汇总行**与入库的期望值对账
 * （issue #301）。
 *
 * 病根（票面原话）：「CI 全绿」的覆盖面今天没有数字可查 —— CI 与本地的 pass/skip 数没有任何机器面对账。
 * 「全绿」是个形容词：它不告诉你跑了多少格、跳过多少格、跳过的那几格为什么可以跳过。一次 `npm test`
 * 的输出里明明有 `# tests / # pass / # fail / # skipped` 四行，但它们只活在日志正文里，**没有任何东西读它们**，
 * 于是「本地 12 条 skip」与「CI 14 条 skip」这种差 2 条的事实，只能靠人肉把两份日志摊开数。
 *
 * 这个脚本做三件事（每一件都能被反向证打红，见 `--self-test`）：
 *   1. **解析**：从一份 `npm test` 的输出（或整份 CI job 日志）里取出 TAP 汇总块，打印成**固定前缀**的一行
 *      `TEST-SUMMARY tests=… pass=… fail=… skipped=… todo=… cancelled=… source=<文件>:<行>` —— 可 grep、
 *      可 diff、可被别的脚本读。
 *   2. **对账**：与 `test/test-suite-baseline.json` 的 `expect` 逐项比，红时**点名差值**：
 *        · `TESTS_DRIFT`      `tests` **不得小于**登记值（棘轮方向与 `check:types` 同构：少一格是**事故**——
 *          那少掉的就是被删/被吞掉的覆盖 ⇒ 红并点名差值；多出来 ⇒ **绿**，另打一行 `TEST-SUMMARY-HINT`
 *          「登记值可抬到 N」。抬值仍是**人**的动作，脚本只提示、不改写）；
 *        · `FAIL_NONZERO`     `fail` 必须等于登记值（登记值恒为 0）；
 *        · `SKIPPED_OVER`     `skipped` **不得高于**登记上限（棘轮方向：跳得更少是绿，跳得更多是红）；
 *        · `TAP_INCONSISTENT` `pass + fail + cancelled + skipped + todo === tests` 不成立 ⇒ 日志被截断或伪造
 *          （读到的不是一份完整汇总：「四行都在」不等于「四行自洽」）。
 *   3. **可查**：`GITHUB_STEP_SUMMARY` 存在时把上面那两行追加进去（CI 跑完在运行页上直接看得到数字，
 *      不必再去下日志包）；这一步**只写那两行**，不写别的。
 *
 * ── 谁是真值（这一条比脚本本身重要）─────────────────────────────────────────────
 *   真值 = **当次 `node --test` 打印的汇总行**（命令现算，随环境变：真模型端点门禁开没开、pi 装载器装没装，
 *   都会改 `skipped`）。登记文件是**期望值 + 上限**，不是「抄一次就永远对」的快照：
 *     · 它不会、也不许被脚本自动改写（**没有 `--sync`**）：抬登记值仍然是**人**的动作——机器自动把实测抄成
 *       登记值，就等于把「这一次恰好跑了多少」永久合法化，而**少用例才是事故**，恰恰是自动抄写最容易盖掉
 *       的那一类（抄一次，「掉了 3 条」就变成「新基线」）。所以机器只提示「可抬到 N」，不改写一格；
 *     · 数字漂了只有两条合法处置：① 有意增删用例 ⇒ 同片改 `expect.tests` + 补一条 `observations`（写清
 *       commit / 环境 / 为什么差）；② 意外漂了 ⇒ 修回去；
 *     · **绝不许为了对上数字去改测试**（加 `skip`、删用例、把断言删成恒真）—— 那是拿覆盖面换绿灯。
 *
 * ── 退出码（本仓惯例：读不出真值就红，不许假绿）─────────────────────────────────
 *   0 = 对账通过（或 `--print` 打印登记值）
 *   1 = 对账红了（上面四条判据任一），逐条点名差值
 *   2 = **读不出真相**：日志读不出 / 日志里没有完整汇总块 / 登记表读不出或形状不对 / 参数不完整。
 *       「没读到」不是「没问题」。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────────
 *   npm test 2>&1 | tee /tmp/test.log && node scripts/suite-summary-reconcile.mjs --log /tmp/test.log
 *   node scripts/suite-summary-reconcile.mjs --log -            # 从 stdin 读（`npm test 2>&1 | … --log -`）
 *   node scripts/suite-summary-reconcile.mjs --log <整份 job 日志> --pick largest
 *        # 整份 CI job 日志里有**多次** `node --test`（Test suite 之外还有单文件步骤），
 *        # 默认 --pick last 会取到最后那一次；读整份日志请显式 --pick largest。
 *   node scripts/suite-summary-reconcile.mjs --print            # 打印登记值 + 已登记的环境观测（不判定）
 *   node scripts/suite-summary-reconcile.mjs --self-test        # 反向证（合成夹具，不落盘、不跑测试）
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 登记表的默认位置（相对仓库根；CI 与本地都读这一份）。 */
export const DEFAULT_REGISTRY = "test/test-suite-baseline.json";

/** 固定前缀：门禁日志靠它被 grep / 被别的脚本读。改这里 = 改所有消费方的解析，报告里要写。 */
export const SUMMARY_PREFIX = "TEST-SUMMARY";
export const EXPECTED_PREFIX = "TEST-SUMMARY-EXPECTED";
export const OBSERVATION_PREFIX = "TEST-SUMMARY-OBSERVATION";
export const VERDICT_PREFIX = "TEST-SUMMARY-VERDICT";
/**
 * spec reporter 汇总的**观测行**前缀（issue #781，#774 的后续）：**只报数、不判定**。
 *
 * 它与判定行的关系（措辞要字面成立，别写成「故意不以 `TEST-SUMMARY` 开头」——`TEST-SUMMARY-SPEC`
 * 本身就以它开头，那是假话）：判定面只认两个后缀 `VERDICT` / `EXPECTED`（上面 `VERDICT_PREFIX` /
 * `EXPECTED_PREFIX`）。观测行的用意是让 `grep '^TEST-SUMMARY-VERDICT'` 的读者**只**看得到真的判定行，
 * 不会把一次「读到 spec 但未判定」读成一次判定——所以它**不带** `VERDICT` / `EXPECTED` 这两个后缀。
 * 这条不是文案偏好：自检里有一格断言「喂 spec 日志时 `^TEST-SUMMARY-VERDICT` 仍只数到未判定那一条」，
 * 把观测行的前缀临时改成 `TEST-SUMMARY-VERDICT` 就会把那一格打红（见 A20 / `formatSpecObservedLine`）。
 */
export const SPEC_OBSERVED_PREFIX = "TEST-SUMMARY-SPEC";
/** 棘轮提示行（绿且实测**高于**登记值时打一行；不是判定，也不是错误）。 */
export const HINT_PREFIX = "TEST-SUMMARY-HINT";

/** 退出码（与文件头三档同源，别在别处再抄一份）。 */
export const EXIT = Object.freeze({ OK: 0, RED: 1, UNREADABLE: 2 });

/** 判据码（报告、`--json`、自测共用一份）。 */
export const CODES = Object.freeze({
  /** `tests` **小于**登记值（掉用例）；大于不是错——那是 `TEST-SUMMARY-HINT` 提示抬值。 */
  TESTS_DRIFT: "TESTS_DRIFT",
  FAIL_NONZERO: "FAIL_NONZERO",
  SKIPPED_OVER: "SKIPPED_OVER",
  TAP_INCONSISTENT: "TAP_INCONSISTENT",
  /**
   * 日志读不出 TAP 汇总，但形状认得出来是 **spec reporter** 的汇总（`ℹ tests …`）。
   *
   * issue #774：Node 24 把 `node --test` 的**默认 reporter 换成了 spec**，于是同一棵树在两种 runner
   * 下交回两种形状。本判据只读 TAP，所以 spec 日志一律**未判定**（`EXIT.UNREADABLE`）：既不许当绿
   * （读不到就当没问题是最危险的假绿），也**不许报成回归**（拿 spec 的 `ℹ tests` 去比 TAP 登记值，
   * runner 一换就满地 `TESTS_DRIFT`，那是判据自己的形状问题，不是用例掉了）。
   */
  NOT_TAP_LOG: "NOT_TAP_LOG",
});

/** 汇总块里认的键。顺序就是 node --test 的打印顺序（识别时不依赖顺序，只用来拼夹具）。 */
const SUMMARY_KEYS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];

/** 一行 TAP 汇总：`# tests 3265`。CI 日志每行带 `2026-…Z ` 时间戳前缀，所以只锚行尾。 */
const SUMMARY_LINE_RE = /(?:^|\s)#\s*(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/u;

/**
 * 一行 **spec reporter** 汇总：`ℹ tests 3265`（issue #774：Node 24 起 `node --test` 的默认形状）。
 *
 * 只用来把「读不出 TAP」这件事**说清楚**（未判定的原因 + 怎么重跑），**不参与判定**。
 */
const SPEC_SUMMARY_LINE_RE = /(?:^|\s)\u2139\s*(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/u;

/** ANSI 颜色（CI 日志的步骤头里有；TAP 正文没有，剥掉更稳）。 */
const ANSI_RE = /\u001b\[[0-9;]*m/gu;

/**
 * 从一份日志正文里取出**所有**完整的 TAP 汇总块。
 *
 * 「完整」= 同一段连续行里同时出现 tests / pass / fail / skipped 四个键。缺一个都不算（截断的日志
 * 常常只剩前两行，那种「读到了」正是最危险的假绿）。
 *
 * @param {string} text 日志正文（`npm test` 输出，或整份 CI job 日志）
 * @returns {{line: number, values: Record<string, number>}[]} 按出现顺序排列；`line` 是 1-based 起始行
 */
export function parseSummaries(text) {
  return parseSummaryRuns(text, SUMMARY_LINE_RE);
}

/**
 * 认出 **spec reporter** 形状的汇总块（`ℹ tests …`）。
 *
 * issue #774：判据只认 TAP，但「读不出」有三种完全不同的原因（日志被截断 / 根本不是测试输出 /
 * runner 的默认 reporter 不是 TAP），把它们混成一句 `NO_SUMMARY` 就会让人去查错方向。
 *
 * @param {string} text
 * @returns {{line: number, values: Record<string, number>}[]}
 */
export function parseSpecSummaries(text) {
  return parseSummaryRuns(text, SPEC_SUMMARY_LINE_RE);
}

/** 按行尾键值对把日志切成「一段一段」，只留四键齐全的段（TAP 与 spec 共用，只差那一行的前缀）。 */
function parseSummaryRuns(text, lineRe) {
  const lines = String(text).replace(ANSI_RE, "").split("\n");
  const runs = [];
  let current = null;
  for (const [index, raw] of lines.entries()) {
    const match = lineRe.exec(raw);
    if (!match) {
      if (current) {
        runs.push(current);
        current = null;
      }
      continue;
    }
    const [, key, digits] = match;
    if (!current) current = { line: index + 1, values: {} };
    // 同一个键在一段里出现两次 ⇒ 这一段不是一份汇总（宁可拆成两段，也不静默覆盖）。
    if (Object.hasOwn(current.values, key)) {
      runs.push(current);
      current = { line: index + 1, values: {} };
    }
    current.values[key] = Number(digits);
  }
  if (current) runs.push(current);
  return runs.filter(
    (run) => ["tests", "pass", "fail", "skipped"].every((key) => Object.hasOwn(run.values, key)),
  );
}

/**
 * 从多个汇总块里挑一个。
 *
 * · `last`（默认）：取最后一段。**tee 出来的 `npm test` 输出里只有一段**，所以这是门禁那条路的正解。
 * · `first`：取第一段（给「日志开头就是目标步骤」的形状）。
 * · `largest`：取 `tests` 最大的一段。**读整份 CI job 日志时用这个**：那份日志里除了 Test suite 还有
 *   单文件 `node --test` 步骤（`check:docs-examples` 等），它们的汇总块又小又晚。
 *
 * @param {{line: number, values: Record<string, number>}[]} summaries
 * @param {"last"|"first"|"largest"} pick
 * @returns {{line: number, values: Record<string, number>}|null}
 */
export function pickSummary(summaries, pick = "last") {
  if (!summaries.length) return null;
  if (pick === "first") return summaries[0];
  if (pick === "largest") {
    return summaries.reduce((best, cur) => (cur.values.tests > best.values.tests ? cur : best));
  }
  return summaries[summaries.length - 1];
}

/**
 * 校验登记表形状。形状不对 = 读不出真相（exit 2），**不许**退回默认值假装对账过。
 *
 * @param {unknown} raw
 * @returns {{ok: true, expect: {tests: number, fail: number, maxSkipped: number}, observations: object[], truth: string}
 *          | {ok: false, problems: string[]}}
 */
export function validateRegistry(raw) {
  const problems = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, problems: ["登记表不是 JSON 对象"] };
  }
  const expect = raw.expect;
  if (expect === null || typeof expect !== "object" || Array.isArray(expect)) {
    return { ok: false, problems: ["登记表缺 `expect` 对象（tests / fail / maxSkipped）"] };
  }
  for (const key of ["tests", "fail", "maxSkipped"]) {
    const value = expect[key];
    if (!Number.isInteger(value) || value < 0) problems.push(`\`expect.${key}\` 不是非负整数（实际 ${JSON.stringify(value)}）`);
  }
  if (Number.isInteger(expect.tests) && expect.tests === 0) problems.push("`expect.tests` 为 0：空汇总不可能是一份真的全量套件");
  if (typeof raw.truth !== "string" || raw.truth.trim() === "") {
    problems.push("缺 `truth` 说明句——「谁是真值」必须写进登记表，否则下一位读者会把登记值当实测");
  }
  const observations = raw.observations;
  if (!Array.isArray(observations)) problems.push("缺 `observations` 数组（登记值是从哪个环境量出来的）");
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    expect: { tests: expect.tests, fail: expect.fail, maxSkipped: expect.maxSkipped },
    observations,
    truth: raw.truth,
  };
}

/** 带符号的差值（`+1` / `-2` / `±0`），红文案里点名用。 */
export function signed(delta) {
  if (delta === 0) return "±0";
  return delta > 0 ? `+${delta}` : String(delta);
}

/**
 * 对账：一份汇总 vs 登记值。
 *
 * @param {Record<string, number>} values
 * @param {{tests: number, fail: number, maxSkipped: number}} expect
 * @returns {{code: string, message: string}[]} 空数组 = 绿（`tests` 高于登记值也是绿：那走 `ratchetHints`）
 */
export function reconcile(values, expect) {
  const reds = [];
  const tests = values.tests;
  const pass = values.pass;
  const fail = values.fail;
  const skipped = values.skipped;
  const todo = values.todo ?? 0;
  const cancelled = values.cancelled ?? 0;

  const accounted = pass + fail + cancelled + skipped + todo;
  if (accounted !== tests) {
    reds.push({
      code: CODES.TAP_INCONSISTENT,
      message: `汇总行自相矛盾：pass ${pass} + fail ${fail} + cancelled ${cancelled} + skipped ${skipped} + todo ${todo}`
        + ` = ${accounted} ≠ tests ${tests}——日志被截断或伪造，读到的不是一份完整汇总`,
    });
  }
  if (tests < expect.tests) {
    reds.push({
      code: CODES.TESTS_DRIFT,
      message: `tests ${tests} < 登记值 ${expect.tests}（${signed(tests - expect.tests)}）`
        + "——少的那些用例就是掉了覆盖（被删、被吞、或某个文件整份没跑）：先修回去；"
        + "确实是有意删的，就同片把 test/test-suite-baseline.json 的 expect.tests 降到实测值并补一条 observations",
    });
  }
  if (fail !== expect.fail) {
    reds.push({
      code: CODES.FAIL_NONZERO,
      message: `fail ${fail} ≠ 登记值 ${expect.fail}（${signed(fail - expect.fail)}）——红用例不许被登记成「正常」`,
    });
  }
  if (skipped > expect.maxSkipped) {
    reds.push({
      code: CODES.SKIPPED_OVER,
      message: `skipped ${skipped} > 登记上限 ${expect.maxSkipped}（+${skipped - expect.maxSkipped}）`
        + "——多出来的 skip 要么补上理由并抬上限，要么把用例修回真跑",
    });
  }
  return reds;
}

/** `TEST-SUMMARY …` 那一行的正文（固定顺序、固定空格，便于 grep / awk）。 */
export function formatSummaryLine(values, source) {
  const todo = values.todo ?? 0;
  const cancelled = values.cancelled ?? 0;
  return `${SUMMARY_PREFIX} tests=${values.tests} pass=${values.pass} fail=${values.fail}`
    + ` skipped=${values.skipped} todo=${todo} cancelled=${cancelled} source=${source}`;
}

/** 登记值那一行。 */
export function formatExpectedLine(expect, registryPath) {
  return `${EXPECTED_PREFIX} tests=${expect.tests} fail=${expect.fail} maxSkipped=${expect.maxSkipped} registry=${registryPath}`;
}

/**
 * spec reporter 汇总的**观测行**（issue #781）：把读到的数字报出来，**不参与判定**——它不喂给
 * `reconcile`、不拿它比登记值、也不改退出码（spec 日志仍是 `EXIT.UNREADABLE`，判不了就是判不了）。
 *
 * 前缀为何是 `TEST-SUMMARY-SPEC` 而不占用判定后缀 `VERDICT` / `EXPECTED`：见 `SPEC_OBSERVED_PREFIX` 的
 * 措辞纪律。数字与 `formatSummaryLine` 用同样的 `tests=… pass=… fail=… skipped=…` 拼法，但**少了**
 * `todo` / `cancelled` 与判定语义——这一格只回答「spec 那一侧现读到多少」，不回答「对不对得上登记值」。
 *
 * @param {Record<string, number>} values spec 汇总值
 * @param {string} source `<日志路径>:<行号>`
 * @returns {string}
 */
export function formatSpecObservedLine(values, source) {
  return `${SPEC_OBSERVED_PREFIX} tests=${values.tests} pass=${values.pass} fail=${values.fail}`
    + ` skipped=${values.skipped} source=${source}`;
}

/**
 * 棘轮提示：实测 `tests` **高于**登记值时给一行「登记值可抬到 N」（照 `check:types` 的「基线可下调至 N」句式）。
 *
 * 降/抬都是**人**的动作：本脚本只提示，不改写登记表（没有 `--sync`）。没有东西可提示 ⇒ 空数组。
 *
 * @param {Record<string, number>} values
 * @param {{tests: number, fail: number, maxSkipped: number}} expect
 * @returns {string[]}
 */
export function ratchetHints(values, expect) {
  if (values.tests <= expect.tests) return [];
  return [
    `${HINT_PREFIX} 登记值可抬到 ${values.tests}（当前登记值 ${expect.tests}，本次实测 ${values.tests}，`
      + `${signed(values.tests - expect.tests)}）——多出来的用例不是事故，抬登记值仍是人的动作：`
      + "本脚本只提示，不改写 test/test-suite-baseline.json（没有 --sync）",
  ];
}

/** 一条环境观测（历史事实，不参与判定）。 */
export function formatObservationLine(observation) {
  const keys = ["tests", "pass", "fail", "skipped", "todo", "cancelled"];
  const numbers = keys
    .filter((key) => Number.isInteger(observation[key]))
    .map((key) => `${key}=${observation[key]}`)
    .join(" ");
  const meta = ["env", "node", "commit", "run"]
    .filter((key) => observation[key] !== undefined)
    .map((key) => `${key}=${observation[key]}`)
    .join(" ");
  return `${OBSERVATION_PREFIX} ${meta} ${numbers}`.replace(/\s+/gu, " ").trimEnd();
}

/**
 * 纯函数形态的对账（自测直接调它，不 spawn 子进程、不落盘）。
 *
 * @param {{logText: string, registry: unknown, pick?: string, source?: string}} input
 * @returns {{exit: number, lines: string[], reds: {code: string, message: string}[], hints: string[], summary: object|null}}
 */
export function runReconcile({ logText, registry, pick = "last", source = "<memory>" }) {
  const validated = validateRegistry(registry);
  if (!validated.ok) {
    return {
      exit: EXIT.UNREADABLE,
      lines: [`${VERDICT_PREFIX} unreadable codes=REGISTRY_INVALID`, ...validated.problems.map((p) => `  · ${p}`)],
      reds: [],
      summary: null,
    };
  }
  const summaries = parseSummaries(logText);
  const summary = pickSummary(summaries, pick);
  if (!summary) {
    // issue #774：读不出 TAP 时要把**原因**报出来。Node 24 起 `node --test` 的默认 reporter 是 spec，
    // 那份日志里有完整的数字、却没有本判据认的形状 ⇒ 报「未判定 / 日志不是 TAP」，exit 2。
    const spec = pickSummary(parseSpecSummaries(logText), pick);
    return {
      exit: EXIT.UNREADABLE,
      lines: spec
        ? [
          `${VERDICT_PREFIX} unreadable codes=NO_SUMMARY,${CODES.NOT_TAP_LOG}`,
          "  · **日志不是 TAP**：认出的是 **spec reporter** 的汇总（`ℹ tests …`）——Node 24 起 `node --test` 的默认就是 spec，"
            + "而本判据只读 TAP 的 `# tests` / `# pass` / `# fail` / `# skipped`",
          `  · **未判定 ≠ 绿，也 ≠ 回归**：spec 那一侧现读到 tests=${spec.values.tests} pass=${spec.values.pass}`
            + ` fail=${spec.values.fail} skipped=${spec.values.skipped}（source=${source}:${spec.line}），`
            + "但拿它去比 TAP 登记值只会把「runner 换了默认 reporter」"
            + "误报成掉用例 / 红用例",
          "  · 重跑要钉住形状：`npm test`（本仓已钉 `--test-reporter=tap`）或 `node --test --test-reporter=tap …`，再把那份日志喂给本脚本",
          // #781：在这条「未判定」的路上**额外**多报一行「只报数、不判定」的观测行——把 spec 那一侧
          // 现读到的数字单列成可 grep 的一格。它是**观测**，不是判定：不改退出码（仍 exit 2），也不拿
          // 这些数字去比登记值。放在数组末尾，免得挪动 lines[0]/lines[1]（$GITHUB_STEP_SUMMARY 取这两格）。
          formatSpecObservedLine(spec.values, `${source}:${spec.line}`),
        ]
        : [
          `${VERDICT_PREFIX} unreadable codes=NO_SUMMARY`,
          "  · 日志里没有完整的 TAP 汇总块（需要同时出现 # tests / # pass / # fail / # skipped），"
            + "也没认出 spec reporter 的 `ℹ tests …`——「没读到」不是「没问题」，先确认这份日志真的是 npm test 的输出",
        ],
      reds: [],
      summary: null,
    };
  }
  const reds = reconcile(summary.values, validated.expect);
  // 提示只在**绿**的时候出现：红的时候该看的是红（抬值提示与一条真红并排只会分散注意力）。
  const hints = reds.length ? [] : ratchetHints(summary.values, validated.expect);
  const lines = [
    formatSummaryLine(summary.values, `${source}:${summary.line}`),
    formatExpectedLine(validated.expect, DEFAULT_REGISTRY),
    reds.length
      ? `${VERDICT_PREFIX} red codes=${reds.map((red) => red.code).join(",")}`
      : `${VERDICT_PREFIX} ok`,
    ...reds.map((red) => `  ✗ ${red.code}: ${red.message}`),
    ...hints,
  ];
  return { exit: reds.length ? EXIT.RED : EXIT.OK, lines, reds, hints, summary };
}

// ─────────────────────────────── 自测 ───────────────────────────────

/** 造一份最小 TAP 日志（`preamble` 用来模拟「前面还有别的输出」）。 */
function tapLog(values, { preamble = ["TAP version 13", "ok 1 - 假用例"] } = {}) {
  const body = SUMMARY_KEYS.filter((key) => values[key] !== undefined).map((key) => `# ${key} ${values[key]}`);
  return [...preamble, ...body, "# duration_ms 1.0", ""].join("\n");
}

const GOOD = { tests: 3265, suites: 11, pass: 3253, fail: 0, cancelled: 0, skipped: 12, todo: 0 };

/**
 * 造一份 **spec reporter** 的汇总（issue #774：Node 24 起 `node --test` 不指定 reporter 时交回的就是这份）。
 *
 * 数字与 `tapLog(GOOD)` 逐字相同，只差行首那个 `ℹ` —— A17 / A19 两例靠这个对照把「红方向是形状、
 * 不是数字」钉住。
 */
function specLog(values) {
  const body = SUMMARY_KEYS.filter((key) => values[key] !== undefined).map((key) => `\u2139 ${key} ${values[key]}`);
  return ["✔ 假用例 (1.0ms)", ...body, "\u2139 duration_ms 1.0", ""].join("\n");
}

/** 一份形状正确的登记表（与真登记表同形状，但数字由夹具给定）。 */
function registryOf(expect, observations = []) {
  return {
    schemaVersion: 1,
    truth: "夹具：真值 = 当次 node --test 的汇总行；本对象只是期望值",
    expect,
    observations,
  };
}

const REAL_REGISTRY_PATH = `${ROOT}${DEFAULT_REGISTRY}`;

/**
 * 用例表。每条至少要有 `expectExit`；`expectLines` 是必须命中的正则（**不许匹配空串**，自测开头会查）。
 *
 * 约定：`log` 是夹具正文；`registry` 缺省用「登记值 = 夹具的绿值」；`mutate` 形状的用例要求替换真的落上
 * （#210 R2：变异没落上 = 这一例没真的跑起来 ⇒ 判失败）。
 */
const CASES = [
  {
    id: "A1",
    label: "登记值对得上 ⇒ exit 0，并打印固定前缀的 TEST-SUMMARY 行",
    log: tapLog(GOOD),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 0,
    expectLines: [/^TEST-SUMMARY tests=3265 pass=3253 fail=0 skipped=12 todo=0 cancelled=0 source=<memory>:\d+$/u, /^TEST-SUMMARY-VERDICT ok$/u],
  },
  {
    id: "A2",
    label: "tests 比登记值多 1 ⇒ 绿，并打一行「登记值可抬到 N」（抬值仍是人的动作）",
    log: tapLog({ ...GOOD, tests: 3266, pass: 3254 }),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 0,
    expectLines: [
      /^TEST-SUMMARY-VERDICT ok$/u,
      /^TEST-SUMMARY-HINT 登记值可抬到 3266（当前登记值 3265，本次实测 3266，\+1）/u,
    ],
    // 绿归绿，但「多出来」不许被当成漂：它不是 TESTS_DRIFT（少才是）。
    rejectLines: [/✗ TESTS_DRIFT/u],
  },
  {
    id: "A3",
    label: "tests 比登记值少 1 ⇒ 红并点名 -1（少掉的那一格就是掉了覆盖：这是本判据唯一的红方向）",
    log: tapLog({ ...GOOD, tests: 3264, pass: 3252 }),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 1,
    expectLines: [/^TEST-SUMMARY-VERDICT red codes=TESTS_DRIFT$/u, /✗ TESTS_DRIFT: tests 3264 < 登记值 3265（-1）/u],
    rejectLines: [/^TEST-SUMMARY-HINT/u],
  },
  {
    id: "A4",
    label: "skipped 超过登记上限 ⇒ exit 1，点名 SKIPPED_OVER 与 +1",
    log: tapLog({ ...GOOD, pass: 3252, skipped: 13 }),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 1,
    expectLines: [/^TEST-SUMMARY-VERDICT red codes=SKIPPED_OVER$/u, /✗ SKIPPED_OVER: skipped 13 > 登记上限 12（\+1）/u],
  },
  {
    id: "A5",
    label: "skipped 低于登记上限 ⇒ 绿（棘轮方向：跳得更少不许红）",
    log: tapLog({ ...GOOD, pass: 3254, skipped: 11 }),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 0,
    expectLines: [/^TEST-SUMMARY-VERDICT ok$/u],
  },
  {
    id: "A6",
    label: "fail 非 0 ⇒ exit 1，点名 FAIL_NONZERO（红用例不许被登记成正常）",
    log: tapLog({ ...GOOD, pass: 3252, fail: 1 }),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 1,
    expectLines: [/^TEST-SUMMARY-VERDICT red codes=FAIL_NONZERO$/u, /✗ FAIL_NONZERO: fail 1 ≠ 登记值 0（\+1）/u],
  },
  {
    id: "A7",
    label: "日志里没有完整汇总块（截断）⇒ exit 2，点名 NO_SUMMARY（不许假绿）",
    log: "TAP version 13\nok 1 - 假用例\n# tests 3265\n# pass 3253\n",
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 2,
    expectLines: [/^TEST-SUMMARY-VERDICT unreadable codes=NO_SUMMARY$/u],
  },
  {
    id: "A8",
    label: "两段汇总（先小后大，模拟整份 job 日志）⇒ 默认 --pick last 取最后一段",
    log: `${tapLog(GOOD, { preamble: ["TAP version 13"] })}\n${tapLog({ tests: 63, suites: 0, pass: 63, fail: 0, cancelled: 0, skipped: 0, todo: 0 })}`,
    registry: registryOf({ tests: 63, fail: 0, maxSkipped: 0 }),
    expectExit: 0,
    expectLines: [/^TEST-SUMMARY tests=63 pass=63 fail=0 skipped=0/u],
  },
  {
    id: "A9",
    label: "同一份日志用 --pick largest ⇒ 取 tests 最大的那段（整份 CI job 日志的正确读法）",
    log: `${tapLog(GOOD, { preamble: ["TAP version 13"] })}\n${tapLog({ tests: 63, suites: 0, pass: 63, fail: 0, cancelled: 0, skipped: 0, todo: 0 })}`,
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    pick: "largest",
    expectExit: 0,
    expectLines: [/^TEST-SUMMARY tests=3265 pass=3253 fail=0 skipped=12/u],
  },
  {
    id: "A10",
    label: "把登记值改高（3265 → 3266）⇒ 同一份日志由绿转红并点名 -1（证明登记表真的被读、不是装饰）",
    log: tapLog(GOOD),
    registry: registryOf({ tests: 3266, fail: 0, maxSkipped: 12 }),
    expectExit: 1,
    expectLines: [/✗ TESTS_DRIFT: tests 3265 < 登记值 3266（-1）/u],
  },
  {
    id: "A11",
    label: "登记表形状不对（缺 expect.maxSkipped）⇒ exit 2，点名 REGISTRY_INVALID",
    log: tapLog(GOOD),
    registry: registryOf({ tests: 3265, fail: 0 }),
    expectExit: 2,
    expectLines: [/^TEST-SUMMARY-VERDICT unreadable codes=REGISTRY_INVALID$/u, /expect\.maxSkipped/u],
  },
  {
    id: "A12",
    label: "汇总行自相矛盾（pass+fail+cancelled+skipped+todo ≠ tests）⇒ exit 1，点名 TAP_INCONSISTENT",
    log: tapLog({ ...GOOD, pass: 3250 }),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 1,
    expectLines: [/^TEST-SUMMARY-VERDICT red codes=TAP_INCONSISTENT$/u, /✗ TAP_INCONSISTENT: 汇总行自相矛盾/u],
  },
  {
    id: "A13",
    label: "变异必须真的落上（#210 R2）：把夹具里的 tests/pass 各 -1，换不到就判这一例失败",
    log: tapLog(GOOD),
    mutate: [
      { from: "# tests 3265", to: "# tests 3264" },
      { from: "# pass 3253", to: "# pass 3252" },
    ],
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 1,
    expectLines: [/✗ TESTS_DRIFT: tests 3264 < 登记值 3265（-1）/u],
  },
  {
    id: "A14",
    label: "CI 日志形态（每行带 ISO 时间戳前缀）⇒ 照样解析出来",
    log: tapLog(GOOD)
      .split("\n")
      .map((line) => (line ? `2026-10-31T10:31:42.8334714Z ${line}` : line))
      .join("\n"),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 0,
    expectLines: [/^TEST-SUMMARY tests=3265 pass=3253 fail=0 skipped=12/u],
  },
  {
    id: "A15",
    label: "tests 比登记值多 3（skipped 正好贴上限）⇒ 仍绿，提示里的 N 是本次实测值而不是登记值",
    log: tapLog({ ...GOOD, tests: 3268, pass: 3256 }),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 0,
    expectLines: [/^TEST-SUMMARY-HINT 登记值可抬到 3268（当前登记值 3265，本次实测 3268，\+3）/u],
  },
  {
    id: "A16",
    label: "tests 多但 fail = 1 ⇒ 仍是红，且不打抬值提示（提示不许盖过一条真红）",
    log: tapLog({ ...GOOD, tests: 3266, pass: 3253, fail: 1 }),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 1,
    expectLines: [/^TEST-SUMMARY-VERDICT red codes=FAIL_NONZERO$/u, /✗ FAIL_NONZERO: fail 1 ≠ 登记值 0（\+1）/u],
    rejectLines: [/^TEST-SUMMARY-HINT/u],
  },
  {
    id: "A17",
    label: "Node 24 的默认 reporter（spec）日志 ⇒ exit 2 报「未判定 / 日志不是 TAP」，**不许报成回归**（issue #774）",
    log: specLog(GOOD),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 2,
    expectLines: [
      /^TEST-SUMMARY-VERDICT unreadable codes=NO_SUMMARY,NOT_TAP_LOG$/u,
      /日志不是 TAP/u,
      /未判定 ≠ 绿，也 ≠ 回归/u,
      /--test-reporter=tap/u,
    ],
    // 形状读不出时，一个回归码都不许发（拿 spec 数字去比 TAP 登记值 = runner 一换就满地假红）。
    rejectLines: [/✗ TESTS_DRIFT/u, /✗ FAIL_NONZERO/u, /✗ SKIPPED_OVER/u, /^TEST-SUMMARY-HINT/u, /^TEST-SUMMARY-VERDICT ok$/u],
  },
  {
    id: "A18",
    label: "spec 日志的数字与登记值逐字对得上 ⇒ 仍是 exit 2 未判定（不许「数字对得上就算绿」）",
    log: specLog(GOOD),
    registry: registryOf({ tests: GOOD.tests, fail: GOOD.fail, maxSkipped: GOOD.skipped }),
    expectExit: 2,
    expectLines: [/^TEST-SUMMARY-VERDICT unreadable codes=NO_SUMMARY,NOT_TAP_LOG$/u, /tests=3265 pass=3253 fail=0 skipped=12/u],
    rejectLines: [/^TEST-SUMMARY tests=/u, /^TEST-SUMMARY-VERDICT ok$/u],
  },
  {
    id: "A19",
    label: "同一批数字、只把 `ℹ` 换成 `#` ⇒ 立刻可判（证明 A17 判的是形状，不是那些数）",
    log: specLog(GOOD),
    mutate: SUMMARY_KEYS.map((key) => ({ from: `\u2139 ${key} ${GOOD[key]}`, to: `# ${key} ${GOOD[key]}` })),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 0,
    expectLines: [/^TEST-SUMMARY tests=3265 pass=3253 fail=0 skipped=12/u, /^TEST-SUMMARY-VERDICT ok$/u],
    rejectLines: [/NOT_TAP_LOG/u],
  },
  {
    id: "A20",
    label: "spec 日志 ⇒ 额外多一行「只报数、不判定」的 TEST-SUMMARY-SPEC 观测行，且 ^TEST-SUMMARY-VERDICT 仍只有未判定那一条（#781：观测行不得占用判定后缀）",
    log: specLog(GOOD),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 2,
    expectLines: [
      /^TEST-SUMMARY-SPEC tests=3265 pass=3253 fail=0 skipped=12 source=<memory>:\d+$/u,
      /^TEST-SUMMARY-VERDICT unreadable codes=NO_SUMMARY,NOT_TAP_LOG$/u,
    ],
    // 「判定行只有一条」的可验写法：拒绝任何**不是**「未判定 NO_SUMMARY,NOT_TAP_LOG」的 ^TEST-SUMMARY-VERDICT 行。
    // 把 SPEC_OBSERVED_PREFIX 临时改成 TEST-SUMMARY-VERDICT ⇒ 观测行变成第二条判定行 ⇒ 这一格红（反向证：
    // 它真的在管前缀，不是恒绿）。
    rejectLines: [/^TEST-SUMMARY-VERDICT (?!unreadable codes=NO_SUMMARY,NOT_TAP_LOG$)/u],
  },
  {
    id: "A21",
    label: "真 TAP 日志 ⇒ 不出现 TEST-SUMMARY-SPEC 观测行（它只属于「读不出 TAP」那条路，#781）",
    log: tapLog(GOOD),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 0,
    expectLines: [/^TEST-SUMMARY-VERDICT ok$/u],
    rejectLines: [/^TEST-SUMMARY-SPEC/u],
  },
  {
    id: "A22",
    label: "反向证专格：spec 日志的「^TEST-SUMMARY-VERDICT 只有一条」单独拿 rejectLines 顶住——把观测前缀改成 TEST-SUMMARY-VERDICT 时，红就红在这一格（证它真在管前缀、不是恒绿，#781）",
    log: specLog(GOOD),
    registry: registryOf({ tests: 3265, fail: 0, maxSkipped: 12 }),
    expectExit: 2,
    // 只要求「未判定」判定行在（保证这一例真的走 spec 路径；该行由 VERDICT_PREFIX 拼，与观测前缀无关，
    // 所以改观测前缀时 expectLines 仍绿），对「第二条判定行」用 rejectLines 拒绝。
    expectLines: [/^TEST-SUMMARY-VERDICT unreadable codes=NO_SUMMARY,NOT_TAP_LOG$/u],
    rejectLines: [/^TEST-SUMMARY-VERDICT (?!unreadable codes=NO_SUMMARY,NOT_TAP_LOG$)/u],
  },
];

/** 用例数下限：删用例 / 整例跳过不算修好（与 test-hygiene-check 同一课）。 */
const MIN_SELF_TEST_CASES = 22;

/**
 * 接线自检：**真树**上的三件事（不落盘、只读）。
 *
 * 为什么把它放进 `--self-test`：判据再对，只要有人把 CI 那一步删了，「CI 的数字」就又回到没人读的状态——
 * 而那是**本单的病根本身**。所以「Test suite 的日志真的落成文件」「对账步骤真的在」「自测步骤真的在」
 * 也要被反向证咬住（删任何一条 ⇒ 这里红）。
 *
 * @returns {string[]} 问题列表（空 = 绿）
 */
export function checkWiring(root = ROOT) {
  const problems = [];
  let ci;
  try {
    ci = readFileSync(`${root}/.github/workflows/ci.yml`, "utf8");
  } catch (error) {
    return [`读不到 .github/workflows/ci.yml：${error.message}`];
  }
  const stepBlocks = ci.split(/\n\s*- name:/u).slice(1);
  // 步骤名**归一后整行相等**才认（去掉尾部括号注释；前缀匹配会让 `… reconcile self-test` 冒充
  // `… reconcile`：删掉对账那一步时，前者会把它顶掉，红是红了但报的不是该报的那一条）。
  const stepName = (block) => block.split("\n")[0].trim().replace(/\s*\([^)]*\)\s*$/u, "");
  const stepOf = (name) => stepBlocks.find((block) => stepName(block) === name);

  const testStep = stepOf("Test suite");
  if (!testStep) {
    problems.push("ci.yml 里没有 `Test suite` 那一步——`npm test` 的汇总不会进任何地方");
  } else {
    if (!/npm test/u.test(testStep)) problems.push("`Test suite` 那一步不再跑 `npm test`");
    if (!/pipefail/u.test(testStep)) {
      problems.push("`Test suite` 那一步没有 `set -o pipefail`——`| tee` 会吃掉 `node --test` 的非 0 退出码（红变绿）");
    }
    if (!/tee/u.test(testStep) || !/RUNNER_TEMP/u.test(testStep)) {
      problems.push("`Test suite` 那一步没有把输出 tee 到 `$RUNNER_TEMP` 下的文件——对账步骤读不到日志");
    }
  }
  const reconcileStep = stepOf("Test suite summary reconcile");
  if (!reconcileStep) {
    problems.push("ci.yml 里没有 `Test suite summary reconcile` 那一步——数字还是没人对账");
  } else {
    if (!/check:test-summary/u.test(reconcileStep)) {
      problems.push("对账步骤没跑 `npm run check:test-summary`——登记表与判据就没人读");
    }
    if (!/--log/u.test(reconcileStep)) problems.push("对账步骤没传 `--log`（没给日志 = 读不出真相）");
    if (/--self-test/u.test(reconcileStep)) problems.push("对账步骤误把 `--self-test` 当门禁——自测只证判据还拦得住，不对账今天的日志");
  }
  if (!stepOf("Test suite summary reconcile self-test")) {
    problems.push("ci.yml 里没有 `Test suite summary reconcile self-test` 那一步——判据被改坏时没人发现");
  }
  // `npm run check:test-summary` 这个名字必须真的指向本脚本（否则 CI 那一步在跑空气）。
  try {
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
    if (pkg.scripts?.["check:test-summary"] !== "node scripts/suite-summary-reconcile.mjs") {
      problems.push("package.json 的 `check:test-summary` 没指向 scripts/suite-summary-reconcile.mjs");
    }
  } catch (error) {
    problems.push(`读不到 package.json：${error.message}`);
  }
  try {
    const registry = JSON.parse(readFileSync(`${root}/${DEFAULT_REGISTRY}`, "utf8"));
    const validated = validateRegistry(registry);
    if (!validated.ok) problems.push(`${DEFAULT_REGISTRY} 形状不对：${validated.problems.join("；")}`);
  } catch (error) {
    problems.push(`读不到 ${DEFAULT_REGISTRY}：${error.message}`);
  }
  return problems;
}

/**
 * S1：「没有 `--sync`」这条纪律本身的反向证（读本脚本源码，不落盘、不 spawn）。
 *
 * 纪律的写法如果只剩一句注释，下一个想「刷一下登记表」的人只要加三行就能加回来。所以这里直接看源码：
 * 对账那条路上**不许有任何写回登记表的 API**，也不许出现 `--sync` 的参数解析。
 * 唯一的写是 `$GITHUB_STEP_SUMMARY` 的追加（写的是 CI 运行页，不是登记表）。
 *
 * @param {string} scriptPath
 * @returns {string[]} 问题列表（空 = 绿）
 */
export function checkNoSync(scriptPath = SCRIPT_PATH) {
  const problems = [];
  let source;
  try {
    source = readFileSync(scriptPath, "utf8");
  } catch (error) {
    return [`读不到本脚本源码 ${scriptPath}：${error.message}`];
  }
  // API 名拆开拼：否则本函数自己的字面量会把检查结果污染成恒红（自指）。
  const writeApis = ["write" + "FileSync", "write" + "File", "rename" + "Sync", "copy" + "FileSync",
    "rm" + "Sync", "unlink" + "Sync", "truncate" + "Sync", "create" + "WriteStream"];
  for (const api of writeApis) {
    if (source.includes(api)) {
      problems.push(`源码里出现 ${api}——登记表只能人改：对账那条路必须只读（唯一的写是 $GITHUB_STEP_SUMMARY 的追加）`);
    }
  }
  const appendCall = "append" + "FileSync(";
  const appends = source.split(appendCall).length - 1;
  if (appends !== 1) {
    problems.push(`appendFileSync 出现 ${appends} 次，期望恰好 1 次（只许写 $GITHUB_STEP_SUMMARY）`);
  } else if (!source.includes(`${appendCall}stepSummary,`)) {
    problems.push("appendFileSync 的第一个实参不是 stepSummary——写进去的不是 CI 运行页");
  }
  // 有开关就有「刷一下」的诱惑：连解析代码都不许存在。
  const syncFlag = /(?:includes|indexOf|flagValue)\(\s*["'`]--sync["'`]/u;
  if (syncFlag.test(source)) problems.push("源码里出现了 `--sync` 的参数解析——登记值只能人改，脚本不许自动改写");
  return problems;
}

function runSelfTest() {
  const failures = [];
  const passed = [];

  if (CASES.length < MIN_SELF_TEST_CASES) {
    failures.push(`用例数被削：现在 ${CASES.length} 例，下限 ${MIN_SELF_TEST_CASES} 例——删用例不算修好`);
  }
  for (const [index, testCase] of CASES.entries()) {
    const who = `${testCase.id}（${testCase.label}）`;
    for (const re of testCase.expectLines ?? []) {
      if (re.test("")) failures.push(`${who}：期望被削弱——正则 ${re} 连空串都匹配，等于没有断言`);
    }
    if (!testCase.expectLines?.length) failures.push(`${who}：没有 expectLines，等于整例被跳过（第 ${index + 1} 例）`);
  }

  for (const testCase of CASES) {
    const who = `${testCase.id}（${testCase.label}）`;
    let logText = testCase.log;
    if (testCase.mutate) {
      for (const { from, to } of testCase.mutate) {
        if (!logText.includes(from)) {
          failures.push(`${who}：变异没落上——夹具里找不到 ${JSON.stringify(from)}（#210 R2：这一例没真的跑起来）`);
          logText = null;
          break;
        }
        logText = logText.replace(from, to);
      }
      if (logText === null) continue;
    }
    const result = runReconcile({ logText, registry: testCase.registry, pick: testCase.pick ?? "last" });
    if (result.exit !== testCase.expectExit) {
      failures.push(`${who}：退出码 ${result.exit}，期望 ${testCase.expectExit}\n      实测输出：${result.lines.join("\n      ")}`);
      continue;
    }
    const missed = testCase.expectLines.filter((re) => !result.lines.some((line) => re.test(line)));
    if (missed.length) {
      failures.push(`${who}：退出码对，但报的不是该报的形状（未命中 ${missed.map(String).join(" ; ")}）`
        + `\n      实测输出：${result.lines.join("\n      ")}`);
      continue;
    }
    // rejectLines：**不该**出现的行（例如「登记值可抬到 N」不得在红的时候出现）。
    const leaked = (testCase.rejectLines ?? []).filter((re) => result.lines.some((line) => re.test(line)));
    if (leaked.length) {
      failures.push(`${who}：出现不该出现的行（命中 ${leaked.map(String).join(" ; ")}）`
        + `\n      实测输出：${result.lines.join("\n      ")}`);
      continue;
    }
    passed.push(`${who} → exit ${result.exit}${result.reds.length ? `（${result.reds.map((red) => red.code).join(",")}）` : ""}`);
  }

  const wiringProblems = checkWiring();
  if (wiringProblems.length) {
    for (const problem of wiringProblems) failures.push(`W1（ci.yml 接线）：${problem}`);
  } else {
    passed.push("W1（ci.yml 接线）→ Test suite 落文件 + 对账步骤 + 自测步骤 + 登记表形状都在");
  }

  // S1：「没有 `--sync`」这条纪律本身要咬得住 —— 脚本里不许有任何把登记表写回去的路径。
  const syncProblems = checkNoSync();
  if (syncProblems.length) {
    for (const problem of syncProblems) failures.push(`S1（没有 --sync）：${problem}`);
  } else {
    passed.push("S1（没有 --sync）→ 源码里没有写文件 / 没有 --sync 开关：登记值只能人改");
  }

  // `--print` 走真登记表：它必须读得出来、且与 `expect` 三格自洽（形状坏了这里就红）。
  let printed = null;
  try {
    const registry = JSON.parse(readFileSync(REAL_REGISTRY_PATH, "utf8"));
    const validated = validateRegistry(registry);
    if (!validated.ok) {
      failures.push(`P1（真登记表）：形状不对——${validated.problems.join("；")}`);
    } else {
      printed = { expect: validated.expect, observations: validated.observations, truth: validated.truth };
      passed.push(`P1（真登记表）→ expect 三格可读：${formatExpectedLine(printed.expect, DEFAULT_REGISTRY)}`);
    }
  } catch (error) {
    failures.push(`P1（真登记表）：读不出 ${DEFAULT_REGISTRY}——${error.message}`);
  }
  if (printed && !printed.truth.includes("真值")) {
    failures.push("P1（真登记表）：`truth` 没有说明谁是真值（这是本单的硬要求，不是文案偏好）");
  }

  console.log("suite-summary-reconcile --self-test：合成 TAP 夹具 + 合成登记表上的反向证（改错 → 红、对 → 绿、读不到 → exit 2）");
  for (const line of passed) console.log(`  ✓ ${line}`);
  for (const line of failures) console.log(`  ✗ ${line}`);
  if (failures.length) {
    console.log(`suite-summary-reconcile --self-test: 失败 — ${failures.length} 处未达预期（共 ${CASES.length} 例 + 接线/登记表/无 --sync 3 项）`);
    process.exit(1);
  }
  console.log(`suite-summary-reconcile --self-test: OK — ${CASES.length} 例反向证/放行证 + 接线 + 登记表 + 无 --sync 全部按预期（合成夹具，不落盘、不跑测试）`);
}

// ─────────────────────────────── CLI ───────────────────────────────

function usage() {
  return [
    "用法：",
    "  node scripts/suite-summary-reconcile.mjs --log <文件|-> [--pick last|first|largest] [--registry <路径>]",
    "  node scripts/suite-summary-reconcile.mjs --print",
    "  node scripts/suite-summary-reconcile.mjs --self-test",
  ].join("\n");
}

function readStdin() {
  return readFileSync(0, "utf8");
}

function main(argv) {
  if (argv.includes("--self-test")) {
    runSelfTest();
    return EXIT.OK;
  }

  const flagValue = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? null : argv[index + 1] ?? null;
  };

  const registryPath = flagValue("--registry") ?? DEFAULT_REGISTRY;
  // 绝对路径原样读（反向证要拿 /tmp 里一份被改坏的登记表跑，不必动真树）；相对路径一律相对仓库根。
  const registryFile = registryPath.startsWith("/") ? registryPath : `${ROOT}${registryPath}`;
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryFile, "utf8"));
  } catch (error) {
    console.error(`${VERDICT_PREFIX} unreadable codes=REGISTRY_UNREADABLE`);
    console.error(`  · 读不出 ${registryPath}：${error.message}`);
    return EXIT.UNREADABLE;
  }
  const validated = validateRegistry(registry);
  if (!validated.ok) {
    console.error(`${VERDICT_PREFIX} unreadable codes=REGISTRY_INVALID`);
    for (const problem of validated.problems) console.error(`  · ${problem}`);
    return EXIT.UNREADABLE;
  }

  if (argv.includes("--print")) {
    console.log(formatExpectedLine(validated.expect, registryPath));
    console.log(`TEST-SUMMARY-TRUTH ${validated.truth}`);
    for (const observation of validated.observations) console.log(formatObservationLine(observation));
    return EXIT.OK;
  }

  const logPath = flagValue("--log");
  if (!logPath) {
    console.error(usage());
    console.error(`${VERDICT_PREFIX} unreadable codes=NO_LOG_ARG（没给 --log：没有日志就没有可对账的数字）`);
    return EXIT.UNREADABLE;
  }
  let logText;
  try {
    logText = logPath === "-" ? readStdin() : readFileSync(logPath, "utf8");
  } catch (error) {
    console.error(`${VERDICT_PREFIX} unreadable codes=LOG_UNREADABLE`);
    console.error(`  · 读不出 ${logPath}：${error.message}`);
    return EXIT.UNREADABLE;
  }

  const pick = flagValue("--pick") ?? "last";
  if (!["last", "first", "largest"].includes(pick)) {
    console.error(usage());
    console.error(`${VERDICT_PREFIX} unreadable codes=BAD_PICK（--pick ${pick}：只认 last / first / largest）`);
    return EXIT.UNREADABLE;
  }

  const result = runReconcile({ logText, registry, pick, source: logPath });
  for (const line of result.lines) {
    if (result.exit === EXIT.OK) console.log(line);
    else console.error(line);
  }

  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    try {
      const [summaryLine, expectedLine] = result.lines;
      const verdictLine = result.lines.find((line) => line.startsWith(VERDICT_PREFIX));
      const body = ["## Test suite summary (`node --test`)", "", "```text", summaryLine, expectedLine, verdictLine, "```", ""]
        .filter((line) => line !== undefined)
        .join("\n");
      appendFileSync(stepSummary, `${body}\n`);
    } catch (error) {
      // 摘要写不进去**不许**改变判定（判定已经在上面算完了）：只提示，不降级、不假绿。
      console.error(`  · 追加 $GITHUB_STEP_SUMMARY 失败（不影响判定）：${error.message}`);
    }
  }
  return result.exit;
}

if (process.argv[1] && process.argv[1] === SCRIPT_PATH) {
  process.exitCode = main(process.argv.slice(2));
}
