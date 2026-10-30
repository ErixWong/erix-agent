#!/usr/bin/env node
// 发版前真机清单：把五条真上游 e2e + 装后 CLI 真机冒烟串成**一条**命令（工单 261021-13 / #619）。
//
//   ERIX_E2E_REAL=1 npm run check:release:real
//
// 为什么要有：0.23.0 是在「文档审计没跑 + 四条真上游 e2e 没跑」的状态下发出去的。每一条单独看
// 都是「记得手动跑就绿、忘了就红」的东西，而**记性不是机制**。这条命令把那六条按固定顺序串起来、
// 逐条点名、红就汇总 ⇒ 「忘了跑」从一件没有痕迹的事变成一个能看见的缺口：发布前跑一条命令。
//
// 与既有命令的关系（**不是**替代，是叠加）：
// - `npm run check:release`：离线、不打模型，管 tarball 形状 / 装后导入 / TS 宿主 / CLI 假上游；
// - `npm run check:cli-real`：真上游，但只管装后 CLI 那一条（= 本清单第 ⑤ 条）；
// - `npm run check:docs`：文档事实（版本声明、命令存在性、中英成对……）；
// - 本条：真上游全景（库层工具事实 / 崩溃续跑 / 跨版本读窗口 / pi extension / 装后 CLI /
//   默认压缩策略 `fold-llm`）。
//
// 闸门（与 `examples/e2e-real-gate.mjs` 同一口径，绝不另造一套）：
// - `ERIX_E2E_REAL` 不是 `1` ⇒ **一步都不跑**、exit 0、打分类原因。真上游不许变成任何默认门禁
//   的硬依赖（AGENTS.md 测试隔离条）；CI 里这条命令的闸门是关着的，它自证的是装置没坏，
//   不是上游可用。
// - 闸门开着、但配置/凭据/端点不可用 ⇒ **exit 1**。这是本脚本唯一一处比 `check:cli-real` 更严
//   的地方，理由是命令的用途：那边是「有就顺手验一下」，这边是**发版前的必跑项**——操作者已经
//   声明「我要打真上游了」，此时「跳过」等于「发版清单根本没跑」，报成绿就是 PR #289 阻断 1 的
//   镜像错误（那边是「闸门说 ok 其实跑不起来」，这边是「跳过冒充通过」）。
// - 子进程里若出现 `[gate_missing]` / `[config_*]` / `[api_key_*]` / `[endpoint_unreachable]`
//   这类**闸门/配置类** skip，同样判该条红：本脚本的预检说 ok 而子进程说不可用 ⇒ 两处口径打架，
//   那是装置坏了，不是「这条不需要跑」。别的 skip（例：跨版本那条的「旧 CLI 0.22.0 不可用」）
//   不判红，但在汇总里**点名**——不许静默。
//
// 隔离：本脚本**一个字节也不写**（不建临时目录、不写 `~/.erix`、不写 `~/.npmrc`）。每条子命令
// 自带隔离（`--dir` 临时目录 / 假 `HOME` / 真配置只读 + 前后哈希对账），把隔离留在消费点是刻意的
// 「谁落盘谁负责」：这里再包一层假 `HOME` 会让子命令读不到真配置，等于用隔离换假绿。
// 子进程环境照 `scripts/cli-real-smoke.mjs` 的 `childEnv()`：清掉 `npm_config_*` 这条外泄通道，
// 但**保留**代理变量——子命令要打真端点，删代理会造出「端点不可达」的假红（那边的清理只服务离线 npm）。
//
// 零依赖红线：只用 `node:` 内置 + 仓内相对路径；纯 ESM。

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GAP_CODES, REAL_GATE_ENV, formatSkip, printableEndpoint, resolveRealUpstream,
} from "../examples/e2e-real-gate.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** 每条子命令的硬超时（超时算红、继续下一条；真上游的用例自身超时是 20 分钟，这里留 15 分钟余量）。 */
const STEP_TIMEOUT_MS = 900_000;

/** 红的时候回放的现场行数（够看到第一个 `not ok` 与它的 `error:` 段，又不至于刷屏）。 */
const TAIL_LINES = 40;

/**
 * 清单本体。`argv` 直接喂 `process.execPath`，所以每条都是「人手会敲的那条命令」的逐字形态
 * （不在这里拼 shell 字符串、不重实现任何断言）。
 *
 * 顺序是刻意的：先库层（便宜、失败信息最细），再恢复/跨版本（贵、慢），最后装后 CLI（最贵，
 * 要 `npm pack` + 装包）。前面红了也不跳过后面的——一次跑完知道**全部**缺口，比逐条重跑省时省钱。
 */
const STEPS = [
  {
    id: "tool-fact",
    label: "库层工具事实契约面（examples/tool-fact-e2e.test.mjs）",
    argv: ["--test", "examples/tool-fact-e2e.test.mjs"],
  },
  {
    id: "resume-real",
    label: "真上游崩溃/续跑（examples/resume-real-e2e.test.mjs）",
    argv: ["--test", "examples/resume-real-e2e.test.mjs"],
  },
  {
    id: "cross-version",
    label: "跨版本读窗口（examples/cross-version-real-e2e.test.mjs）",
    argv: ["--test", "examples/cross-version-real-e2e.test.mjs"],
  },
  {
    id: "erix-run",
    label: "pi extension erix_run（examples/pi-extension/erix-run-e2e.test.mjs）",
    argv: ["--test", "examples/pi-extension/erix-run-e2e.test.mjs"],
  },
  {
    id: "cli-real",
    label: "装后 CLI 真机冒烟（scripts/cli-real-smoke.mjs）",
    argv: ["scripts/cli-real-smoke.mjs"],
  },
  {
    // issue #619：前面五条没有一条碰**压缩**，而 #611（摘要器提示词加「## 教训与坑」）与 #614
    // （CLI 默认策略从 `fold-statistical` 换成 `fold-llm`）改的正是这条路径——#614 之后默认路径在
    // 真机上零覆盖。这一条补的就是那格空白：历史由测试预置（折叠必然发生）、真模型只跑 1 轮，
    // 断言全落在引擎不变量上（块在不在 / 语义分节 / 摘要器被调了几次 / 机械锚点保没保住 TOK 标记 /
    // 摘要器超时降不降级），不测模型行为 ⇒ 一条 ~20 s，与前面五条同形（闸门关着 ⇒ skip + exit 0）。
    id: "fold-default",
    label: "默认压缩策略 fold-llm 真机（#619）（examples/fold-default-real-e2e.mjs）",
    argv: ["--test", "examples/fold-default-real-e2e.mjs"],
  },
];

const log = (line = "") => process.stdout.write(`${line}\n`);

/** 子进程环境：清 `npm_config_*` 外泄通道，其余（含代理、`ERIX_E2E_*`）原样继承。 */
function childEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^npm_config_/u.test(name)) delete env[name];
  }
  // 预检已经证明闸门是开的；显式写一遍，免得将来有人把预检改成「用别的变量判定」而子进程悄悄跳过。
  env[REAL_GATE_ENV] = "1";
  return env;
}

/**
 * 从 TAP 输出里取 `# tests / # pass / # fail / # skipped`。
 *
 * 不是每条都产 TAP（第 ⑤ 条 `cli-real-smoke.mjs` 打的是自己的日志行），所以取不到的字段一律
 * `undefined`——**不许**用 0 冒充，否则「没摘要」会被读成「零失败」。
 *
 * @param {string} text
 * @returns {{ tests?: number, pass?: number, fail?: number, skipped?: number }}
 */
export function parseTapSummary(text) {
  const pick = (label) => {
    const found = text.match(new RegExp(`^# ${label} (\\d+)$`, "mu"));
    return found ? Number(found[1]) : undefined;
  };
  const summary = {};
  for (const key of ["tests", "pass", "fail", "skipped"]) {
    const value = pick(key);
    if (value !== undefined) summary[key] = value;
  }
  return summary;
}

/**
 * 子进程里出现过的 skip 说明（TAP 的 `ok N - <名字> # SKIP <说明>` 与 `# SKIP <说明>` 两种形态）。
 * @param {string} text
 * @returns {string[]}
 */
export function skipReasons(text) {
  const reasons = [];
  for (const line of text.split("\n")) {
    const found = line.match(/#\s*SKIP\s+(.*)$/u);
    if (found) reasons.push(found[1].trim());
  }
  return reasons;
}

/**
 * 闸门/配置类的 skip（预检说 ok、子进程却说不可用 ⇒ 口径打架）。
 * @param {string[]} reasons
 * @returns {string[]}
 */
export function gateGapSkips(reasons) {
  const codes = Object.values(GAP_CODES);
  return reasons.filter((reason) => codes.some((code) => reason.includes(`[${code}]`)));
}

/** 秒级耗时（一位小数，便于横向比）。 */
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** 回显用：带空白/引号的参数套单引号，免得打印出来的命令看起来敲不通（不影响真正传给子进程的 argv）。 */
const quoteArg = (arg) => (/[\s'"`$\\]/u.test(arg) ? `'${arg.replaceAll("'", "'\\''")}'` : arg);

/**
 * 跑一条。超时用**进程组**杀（`node --test` 自己还会 spawn 子进程，只杀直接子进程会留下孤儿继续烧钱）。
 *
 * @param {{ id: string, label: string, argv: string[] }} step
 * @param {number} index 从 1 开始的序号
 * @param {number} total
 * @returns {Promise<{ id: string, label: string, status: "ok"|"red", reason?: string,
 *   summary: ReturnType<typeof parseTapSummary>, skips: string[], output: string, elapsedMs: number }>}
 */
function runStep(step, index, total) {
  log(`=== [${index}/${total}] ${step.label} ===`);
  log(`    $ node ${step.argv.map(quoteArg).join(" ")}`);
  const startedAt = Date.now();
  return new Promise((settle) => {
    const child = spawn(process.execPath, step.argv, {
      cwd: ROOT,
      env: childEnv(),
      // 独立进程组：超时时整组 SIGKILL，不留还在打真上游的孙进程。
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // 进程组已经没了 ⇒ 退化成杀直接子进程
        }
      }
      child.kill("SIGKILL");
    }, STEP_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      settle({
        ...step,
        status: "red",
        reason: `子进程起不来：${error?.message ?? error}`,
        summary: {},
        skips: [],
        output,
        elapsedMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const summary = parseTapSummary(output);
      const skips = skipReasons(output);
      const elapsedMs = Date.now() - startedAt;
      const gaps = gateGapSkips(skips);
      let status = "ok";
      let reason;
      if (timedOut) {
        status = "red";
        reason = `超时 ${seconds(STEP_TIMEOUT_MS)} 未结束（进程组已 SIGKILL）`;
      } else if (code !== 0) {
        status = "red";
        reason = `退出码 ${code ?? "null"}${signal ? `（signal=${signal}）` : ""}`;
      } else if (gaps.length > 0) {
        status = "red";
        reason = `闸门开着却出现闸门/配置类 skip（预检与子进程口径不一致）：${gaps.join(" ｜ ")}`;
      }
      settle({ ...step, status, reason, summary, skips, output, elapsedMs });
    });
  });
}

/** `tests=2 pass=2 fail=0 skip=0`；取不到的字段写 `?`（不许用 0 冒充）。 */
function summaryLine(summary) {
  const part = (key, label) => `${label}=${summary[key] === undefined ? "?" : summary[key]}`;
  return [
    part("tests", "tests"), part("pass", "pass"), part("fail", "fail"), part("skipped", "skip"),
  ].join(" ");
}

/** 红的时候回放现场尾部（超时的那条常常只有半截 TAP，tail 就是全部证据）。 */
function printTail(output) {
  const lines = output.trimEnd().split("\n");
  const tail = lines.slice(-TAIL_LINES);
  log(`    --- 输出尾部（最后 ${tail.length} 行 / 共 ${lines.length} 行）---`);
  for (const line of tail) log(`    | ${line}`);
  log("    --- 尾部结束 ---");
}

/**
 * 预检：能不能打真上游。返回 `{ proceed: true }` 或 `{ proceed: false, exitCode }`。
 * @returns {Promise<{ proceed: boolean, exitCode?: number }>}
 */
async function preflight() {
  const gate = await resolveRealUpstream({ probeTimeoutMs: 8_000 });
  if (gate.ok) {
    log(`闸门开：model=${gate.model} endpoint=${printableEndpoint(gate.endpoint)} 配置=${gate.configPath}`);
    return { proceed: true };
  }
  log(`SKIP — ${formatSkip(gate)}`);
  if (gate.code === GAP_CODES.GATE_MISSING) {
    // 缺省形态：一步都不跑、exit 0。真上游不是默认门禁的硬依赖。
    log("");
    log(`闸门没开 ⇒ 本清单一步都没跑（exit 0，这**不是**真上游可用的信号）。`);
    log(`发版前请这样跑：${REAL_GATE_ENV}=1 npm run check:release:real`);
    return { proceed: false, exitCode: 0 };
  }
  log("");
  log(`闸门开着（${REAL_GATE_ENV}=1）但真上游不可用 ⇒ 本清单**根本没跑**，按红处理。`);
  log(`理由：发版前的必跑项被「跳过」冒充成「通过」正是这条命令要防的事；先修好上面那条分类原因再跑。`);
  return { proceed: false, exitCode: 1 };
}

async function main() {
  const startedAt = Date.now();
  log("=== 发版前真机清单（npm run check:release:real）===");
  log(`仓库：${ROOT}`);
  log("");
  const gate = await preflight();
  if (!gate.proceed) return gate.exitCode ?? 1;

  const results = [];
  for (const [i, step] of STEPS.entries()) {
    log("");
    const result = await runStep(step, i + 1, STEPS.length);
    results.push(result);
    log(`[${i + 1}/${STEPS.length}] ${result.status.toUpperCase()}  ${summaryLine(result.summary)}  ${seconds(result.elapsedMs)}`
      + (result.reason ? `  — ${result.reason}` : ""));
    if (result.status === "red") printTail(result.output);
  }

  const red = results.filter((result) => result.status === "red");
  const skipped = results.filter((result) => result.status === "ok" && result.skips.length > 0);

  log("");
  log("=== 汇总 ===");
  for (const [i, result] of results.entries()) {
    log(`  [${i + 1}/${STEPS.length}] ${result.status === "ok" ? "ok " : "RED"}  ${summaryLine(result.summary)}`
      + `  ${seconds(result.elapsedMs)}  ${result.label}`);
  }
  for (const result of skipped) {
    log("");
    log(`  ⚠ ${result.label} 里有 ${result.skips.length} 条 skip（不判红，但不许静默）：`);
    for (const reason of result.skips) log(`      · ${reason}`);
  }
  log("");
  log(`总耗时 ${seconds(Date.now() - startedAt)}（${STEPS.length} 条）`);
  if (red.length > 0) {
    log("");
    log(`红：${red.length}/${STEPS.length} 条没通过：`);
    for (const result of red) {
      const at = results.indexOf(result) + 1;
      log(`  · [${at}/${STEPS.length}] ${result.label} — ${result.reason}`);
    }
    log("");
    log("发版前必须全绿（含 `npm run check:docs` / `npm run check:docs:strict` 的文档审计）。");
    return 1;
  }
  log("全绿。");
  return 0;
}

// 直接跑才进 main：导出的解析器（`parseTapSummary` / `skipReasons` / `gateGapSkips`）要能被单独
// 引用而不触发「预检 + 跑六条真上游」——脚本被 import 一次就烧一遍真金是不可接受的副作用。
const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    log(`脚本自身失败：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
