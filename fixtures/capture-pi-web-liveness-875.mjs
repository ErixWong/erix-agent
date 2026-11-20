// @ts-check
// issue #875 第二刀（契约参照物）：本脚本是生成
//   `test/fixtures/pi-web-session-liveness-e533d9b3.ts`（宿主源文件的**逐字拷贝**）
//   `test/fixtures/pi-web-session-liveness-e533d9b3.json`（捕获点元数据 `_meta`）
// 的**捕获脚本**。它存在的唯一理由：`test/examples/pi-web-liveness-contract.test.js` 的判据是
// 「我们的模块 × 宿主的**真代码**」，而那份真代码住在**另一个仓**里 —— 没有捕获点与 sha256，
// 参照物就退化成「一份来路不明的拷贝」，与上一单那份手抄假 registry 一样不可独立验真。
//
// 为什么放在根 `fixtures/`（不是 `test/fixtures/`）：静态守卫 `test/static-guards.test.js`
// 「test/ 下不再放会被 node --test 当测试执行的支撑文件」规定 `test/` 下的非测试支撑脚本一律搬根
// `fixtures/`（裸 `node --test` 会把 test/ 下的支撑文件白跑一遍）。产物才进 `test/fixtures/`。
//
// 为什么必须**钉死捕获点**：参照物一旦能悄悄漂，「端到端」就成了「端到端地跟着漂」。所以脚本开头
// **硬校验**运行环境，跑不对就直接退出：
//   1) `git -C <repo> rev-parse HEAD` 必须**等于**常量 `BASE_SHA`（完整 sha，防「在别的 commit 上
//      拷了一份却登记成 e533d9b」）；
//   2) `git -C <repo> status --porcelain` 必须**空**（脏树不许捕获：源文件本身可能就被改过）；
//   3) 源文件必须存在且可读。
// 判据自检（注释记录，不另设测试）：把 `BASE_SHA` 改成别的 sha 去跑 ⇒ 必须 exit 1 并打印实测 HEAD。
//
// 与 `capture-loop-runstate-inject-872.mjs` 的差别只在**源**：那一单从**本仓**的 base worktree 里
// 现跑现取一份请求体摘要，本单从**宿主仓**的检出里取一个字节的源码。硬校验的形状是同一套。
//
// 纯 ESM、零 npm 依赖（只用 `node:` 内建）；`// @ts-check`。
//
// 重新生成方法（在宿主仓那个 commit 的干净检出里跑，产物写回**本仓**的 test/fixtures/）：
//   node fixtures/capture-pi-web-liveness-875.mjs
//   # 宿主检出不在默认位置时：PI_WEB_REPO=/path/to/pi-web node fixtures/capture-pi-web-liveness-875.mjs

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 捕获点（宿主 `pi-web` 的完整 sha，写死；勿改成动态取值，否则失去「钉死」的意义）。 */
const BASE_SHA = "e533d9b3975f8a74b378d5007c92fdf4d15d3fba";
/** 宿主仓里被捕获的那份源码（相对宿主仓根）。 */
const SOURCE_PATH = "lib/session-liveness.ts";
/** 产物名（`<名>.ts` 是逐字拷贝，`<名>.json` 是 `_meta`）。 */
const OUT_TS = "pi-web-session-liveness-e533d9b3.ts";
const OUT_JSON = "pi-web-session-liveness-e533d9b3.json";
/** 默认宿主检出位置（工单口径：`~/projects/github/pi-web`，可用 `PI_WEB_REPO` 覆盖）。 */
const DEFAULT_REPO = join(homedir(), "projects/github/pi-web");

/** 跑一条 git 子命令（**只读**：rev-parse / status / remote get-url），返回去掉首尾空白的 stdout。 */
function git(...args) {
  return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
}

/**
 * 打印原因并以 1 退出（工单要求：任一硬校验不过就 exit(1) 并说明）。
 * @returns {never}
 */
function fail(reason) {
  process.stdout.write(`捕获中止：${reason}\n`);
  process.exit(1);
}

const REPO = process.env.PI_WEB_REPO ?? DEFAULT_REPO;

// —— 硬校验 1：HEAD 必须**等于**捕获点 ——
if (!existsSync(REPO)) fail(`宿主检出不存在：${REPO}（用 PI_WEB_REPO=<path> 指到 pi-web 的检出）`);
const measuredSha = git("rev-parse", "HEAD");
if (measuredSha !== BASE_SHA) {
  fail(
    `宿主检出的 HEAD 不是捕获点：${REPO}\n`
    + `  实测 rev-parse HEAD = ${measuredSha}\n`
    + `  工单钉死的 BASE_SHA = ${BASE_SHA}\n`
    + `  请先在宿主检出里跑 \`git checkout --detach ${BASE_SHA}\`，再跑本脚本（脏树也要先清干净）。`,
  );
}
// —— 硬校验 2：脏树不许捕获（源文件本身可能就被改过）——
const porcelain = git("status", "--porcelain");
if (porcelain !== "") {
  fail(
    `宿主检出有未提交改动，捕获点不可信（源文件可能正是被改过的那份）：${REPO}\n`
    + `  git status --porcelain：\n${porcelain.split("\n").map((line) => `  ${line}`).join("\n")}`,
  );
}
// —— 硬校验 3：源文件存在且可读 ——
const sourceAbs = join(REPO, SOURCE_PATH);
let sourceBytes;
try {
  sourceBytes = readFileSync(sourceAbs);
} catch (error) {
  fail(`宿主源文件读不出来：${sourceAbs}\n  ${/** @type {Error} */ (error).message}`);
}
if (sourceBytes.length === 0) fail(`宿主源文件是空的（不像真源码）：${sourceAbs}`);
const sourceRepo = git("remote", "get-url", "origin");

// —— 产物 1：**逐字**拷贝。一个字节都不许改写（不加注释、不格式化、不动行尾）：本文件的职责是搬运，
//    参照物一旦被"顺手整理"过，「宿主的真代码」这个身份就没了。
const outTsUrl = new URL(`../test/fixtures/${OUT_TS}`, import.meta.url);
writeFileSync(outTsUrl, sourceBytes);
// —— sha256 是**对拷出来的产物**现算的（不是对源文件算）：判据消费的是产物，登记产物才自证。
const copiedBytes = readFileSync(outTsUrl);
const sourceSha256 = createHash("sha256").update(copiedBytes).digest("hex");
if (copiedBytes.length !== sourceBytes.length || !copiedBytes.equals(sourceBytes)) {
  fail(`产物与源文件不逐字相等（拷贝被改写了？）：${outTsUrl.pathname}`);
}

// —— 产物 2：`_meta` ——
const capturedAt = new Date().toISOString();
const meta = {
  _meta: {
    sourceRepo,
    sourcePath: SOURCE_PATH,
    // 记录的是**实测**的 rev-parse 结果（不是 `BASE_SHA` 常量回显）：证明捕获点真落在这个 commit 上。
    baseSha: measuredSha,
    capturedAt,
    nodeVersion: process.version,
    sourceSha256,
    regenerate: "node fixtures/capture-pi-web-liveness-875.mjs（宿主检出不在默认位置时：PI_WEB_REPO=/path/to/pi-web node fixtures/capture-pi-web-liveness-875.mjs）；脚本硬校验宿主 HEAD==e533d9b3975f8a74b378d5007c92fdf4d15d3fba 且 git status --porcelain 为空，否则 exit 1。产物 .ts 必须逐字拷贝，一个字节都不许改。",
    note: "这份 .ts 是宿主**开发检出**（`pi-web:lib/session-liveness.ts`）的源码，不是线上安装的 @agegr/pi-web 0.13.0 里那份：本捕获点多一套 `SESSION_LIVENESS_LEASE_TTL_MS` 的「选中页租约」（`holdSessionLivenessLease` + `globalThis[Symbol.for(\"@agegr/pi-web/session-liveness-leases/v2\")]`）。已实测两版的差别（0.13.0 一侧读的是本机已装包的编译产物 `.next/server/chunks/6429.js`）：那套租约**不在** 0.13.0 里，而 0.13.0 的 registry 上另有一个本捕获点没有的 `list()` 方法 —— 两版是**分叉**，不是简单的谁新谁旧。**本仓依赖的三件事两版逐条一致**（这就是敢拿这份当参照的理由）：① 注册表键 `Symbol.for(\"@agegr/pi-web/session-liveness/v1\")` 且 `version === 1`；② `register(provider)` 返回**幂等**的 `release`（宿主侧 `disposed` 一次性开关）；③ `hasActiveProvider({sessionId, sessionFile})` 按 `sessionId ∪ sessionFile` 匹配、provider 的 `isActive` 抛错时 **fail-safe 返回 true**（保留会话）。捕获脚本对宿主检出**只读**（只跑 rev-parse / status / remote get-url 与读那一个文件）。",
  },
};
const outJsonUrl = new URL(`../test/fixtures/${OUT_JSON}`, import.meta.url);
writeFileSync(outJsonUrl, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

process.stdout.write(
  `已写出 ${outTsUrl.pathname}\n`
  + `已写出 ${outJsonUrl.pathname}\n`
  + `baseSha=${measuredSha} capturedAt=${capturedAt} sourceSha256=${sourceSha256}\n`,
);
