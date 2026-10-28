// @ts-check
// release-check.mjs — 发版前那条手工验证：「打包 → 装起发布包 → 再用它」（issue #257 T5）
//
// 干什么：按顺序跑五步，每一步都只吃**上一步真实产出的产物**，任一步失败立刻退出非 0 并打清是
// 第几步（失败还带已完成步骤的耗时表，便于定位）。它是 `npm run check:release` 的实现。
//
//   1. 打包   `npm pack --pack-destination <临时目录>`（触发仓内 `prepack` 生成 `src/**/*.d.ts`），
//             断言 tarball 里声明文件数 > 0、当前版本的中英升级指南都在、`files` 里列的
//             `test/contract/*` 一个不少、且没有任何 `files` 白名单之外的杂物；Markdown 链接闭合
//             **不在这里重写一遍**，直接复用 `scripts/pack-link-check.mjs`（`check:pack-links`）。
//   2. 装     tarball 装进一次性临时项目（`npm i <tgz>`，`--offline` + 一次性 cache/userconfig），
//             断言消费者视角 `import("erix-agent")` 拿到 `runToolLoop`、
//             `import("erix-agent/tools")` 拿到 `createFileTools`，两者都是 function。
//   3. 跑     用**装好的包**跑随包的 `test/contract/` 契约套件（`erix-agent/contract-tests`），
//             这正是文档给消费者的自跑路径。
//   4. 编译   在临时项目里写一个**真 TypeScript 宿主**（assemblyPort + runToolLoop +
//             createOpenAIProvider + createFileTools 并用其返回字段），`tsc --strict --skipLibCheck`
//             必须退 0；再把「未知 option 键」那份单独编译一次，**必须报 TS2353**——证明类型面
//             真的在拦东西，不是 `any`。额外把正向宿主 emit 出来真跑一遍（发布 JS 可被消费）。
//   5. 冒烟   用装好的包起真子进程：`erix --version` 必须等于 `package.json` 版本；一次 `erix chat`
//             打**本地假上游**（`fixtures/upstream.mjs`，绑 `127.0.0.1:0`）；再加一条
//             `--session <不存在的 id>`。退出码按 `bin/cli.js` 的帮助承诺断言：**当前默认不开
//             `--final-guard` 的一次成功 chat 退 4（核验 skipped）**，会话不存在退 1。
//
// 离线纪律：模型端点是本地假上游；`npm` 一律带 `--offline` + 一次性 `--cache`/`--userconfig`，
// 子进程 `HOME` 指到临时假 HOME（`fixtures/config-shape.mjs` 写真配置，端点键名是 `endpoint`）；
// 代理环境变量（含 `NODE_USE_ENV_PROXY`）进出保存并清理。真实 `~/.erix` 与 `~/.npmrc` 前后对账。
//
// 清理纪律：临时目录一律 `mkdtemp(join(tmpdir(), "erix-release-check-"))`，`finally` + `exit`
// 钩子双保险删除；`prepack` 在仓库里生成的 `src/**/*.d.ts` 也照样清掉（残留会让 `check:types` 假绿）。
//
// 零依赖：只用 `node:` 内置 + 仓内相对路径（`typescript` / `@types/node` 是**本仓** devDependencies，
// 从 `ROOT/node_modules` 取绝对路径，绝不在临时项目里再装一遍）。

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { createScriptedUpstream, jsonResponse } from "../fixtures/upstream.mjs";
import { fakeHomeEnv, upstreamFields, writeConfigHome } from "../fixtures/config-shape.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const TSC_ENTRY = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const PACKAGE_VERSION = String(PACKAGE_JSON.version);

/** 宿主可能带进来的代理类变量：进出都要保存并清掉（`NODE_USE_ENV_PROXY` 会把 `127.0.0.1` 也送给代理）。 */
const PROXY_VARS = [
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY",
];

/** `bin/cli.js` 帮助里承诺的退出码（`check:docs` 系守着的对外契约，不是本脚本自创的期望）。 */
const EXIT_USAGE = 1;
const EXIT_NOT_VERIFIED = 4;

/** tsc 编译宿主程序用的固定旗标（工单口径：`--strict --skipLibCheck`）。 */
const TSC_COMMON_ARGS = [
  "--strict",
  "--skipLibCheck",
  "--target", "es2022",
  "--module", "nodenext",
  "--moduleResolution", "nodenext",
];

/** tarball 里一律不许出现的杂物形态（`files` 白名单之外的漏网之鱼，加上这些点名拦截）。 */
const JUNK_PATTERNS = [
  { re: /(^|\/)node_modules\//u, why: "依赖被卷进包（本包零运行时依赖）" },
  { re: /(^|\/)\.git\//u, why: "版本库元数据" },
  { re: /\.test\.js$/u, why: "仓内测试文件（只有 test/contract/* 随包发布）" },
  { re: /\.tgz$/u, why: "嵌套 tarball" },
  { re: /\.map$/u, why: "source map（本包不产 source map）" },
  { re: /\.tsbuildinfo$/u, why: "tsc 增量缓存" },
  { re: /(^|\/)(WORK-ORDER|REPORT)-/u, why: "工单/报告文档" },
  { re: /(^|\/)\.DS_Store$/u, why: "编辑器杂物" },
  { re: /(^|\/)tsconfig.*\.json$/u, why: "仓内 tsconfig（宿主各自带）" },
];

const stepTimings = [];
const notes = [];

/** 临时目录与仓库现场（跑完必须原样还回去）。 */
let tmpRoot = "";
let realHome = "";
const savedProxyValues = new Map();
/** @type {string[]} */ let declarationBefore = [];
let erixDirBefore = "";
let npmrcBefore = "";

class ReleaseCheckError extends Error {}

function fail(message) {
  throw new ReleaseCheckError(message);
}

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------

/**
 * 跑一个子进程，收干 stdout/stderr。`okExitCodes` 之外的一律由调用方自己判定，
 * 这里只负责把输出与退出码原样交出去（超时视为失败，避免卡死整条命令）。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string | undefined>, timeoutMs?: number, label?: string}} [options]
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: /** @type {NodeJS.ProcessEnv} */ (options.env ?? process.env),
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    shell: process.platform === "win32",
  });
  const label = options.label ?? `${command} ${args.join(" ")}`;
  if (result.error) {
    fail(`${label} 起不来：${result.error.message}`);
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status === null) {
    fail(`${label} 被 ${result.signal ?? "超时"} 终止\nstdout(tail)=${stdout.slice(-600)}\nstderr(tail)=${stderr.slice(-600)}`);
  }
  return { status: /** @type {number} */ (result.status), stdout, stderr, label };
}

function tail(text, limit = 900) {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

/**
 * **异步**跑子进程：第 5 步的假上游 HTTP 服务就跑在本进程里，`spawnSync` 会把事件循环
 * 堵死——CLI 的请求永远没人应答，60s 后被超时杀掉。所以跟假上游打交道的子进程一律走这条。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string | undefined>, timeoutMs?: number, label?: string}} [options]
 * @returns {Promise<{status: number, stdout: string, stderr: string, label: string}>}
 */
function runAsync(command, args, options = {}) {
  const label = options.label ?? `${command} ${args.join(" ")}`;
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: /** @type {NodeJS.ProcessEnv} */ (options.env ?? process.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(new ReleaseCheckError(`${label} 起不来：${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === null) {
        rejectPromise(new ReleaseCheckError(
          `${label} 被 ${signal ?? "超时"} 终止（${timeoutMs}ms 硬超时）`
          + `\nstdout(tail)=${tail(stdout)}\nstderr(tail)=${tail(stderr)}`,
        ));
        return;
      }
      resolvePromise({ status: code, stdout, stderr, label });
    });
  });
}

/**
 * 子进程统一环境：清代理 + 清 npm 自己的配置外泄通道；给了 `home` 就同时把 HOME 换到假 HOME。
 *
 * @param {{home?: string, extra?: Record<string, string | undefined>}} [options]
 */
function childEnv({ home, extra } = {}) {
  /** @type {Record<string, string | undefined>} */
  const base = { ...process.env };
  for (const name of PROXY_VARS) delete base[name];
  // `npm run` 会把宿主 npm 的配置以 `npm_config_*` 喷进子进程；子 npm 会全吃。
  // 实测的实例：Node 24 带的 npm 11 会因此报 `EALLOWSCRIPTS —— --allow-scripts is not
  // allowed in project-scoped installs`（第 2 步的临时项目安装）。一次性 --userconfig/--cache
  // 本来就是要子 npm 从零开始配，所以这些变量一律清掉。
  for (const name of Object.keys(base)) {
    if (/^npm_config_/u.test(name)) delete base[name];
  }
  const env = home ? fakeHomeEnv(base, { home }) : base;
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = String(value);
  }
  return env;
}

// ---------------------------------------------------------------------------
// tarball 读取（tar + gzip 都在 node: 内置里，不引第三方）
// ---------------------------------------------------------------------------

/** @param {Buffer} block @param {number} offset @param {number} length */
function cstr(block, offset, length) {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
}

/** @param {string} text pax `path=…\n` 记录里取 path */
function paxPath(text) {
  for (const line of text.split("\n")) {
    const match = /^ *\d+ path=(.*)$/u.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * 列出 tarball 内的文件路径（去掉 npm 的 `package/` 前缀）。
 * 支持 ustar 的 `prefix` 字段、GNU 长名（typeflag `L`）与 pax 扩展头（`x`/`X`）。
 *
 * @param {string} tarballPath
 * @returns {string[]}
 */
function listTarball(tarballPath) {
  const buffer = gunzipSync(readFileSync(tarballPath));
  /** @type {string[]} */
  const names = [];
  let offset = 0;
  /** @type {string | null} */
  let longName = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const nameField = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    const sizeField = cstr(header, 124, 12).trim();
    const size = Number.parseInt(sizeField, 8);
    // ustar 头部：typeflag 在第 156 字节（0=常规文件、5=目录、L=GNU 长名、x/X=pax 扩展头）。
    const typeFlag = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    offset += 512;
    const dataOffset = offset;
    offset += Math.max(0, Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512);
    if (typeFlag === "L") {
      longName = buffer.subarray(dataOffset, dataOffset + size).toString("utf8").replace(/\0+$/u, "");
      continue;
    }
    if (typeFlag === "x" || typeFlag === "X") {
      const pax = paxPath(buffer.subarray(dataOffset, dataOffset + size).toString("utf8"));
      if (pax !== undefined) longName = pax;
      continue;
    }
    if (typeFlag !== "0" && typeFlag !== "7") continue;
    const name = longName ?? (prefix ? `${prefix}/${nameField}` : nameField);
    longName = null;
    names.push(name.replaceAll("\\", "/"));
  }
  return names
    .map((name) => name.replace(/^\.?\//u, ""))
    .filter((name) => name === "package" || name.startsWith("package/"))
    .map((name) => (name === "package" ? "" : name.slice("package/".length)))
    .filter(Boolean)
    .sort();
}

/** tarball 路径是否被 `files` 白名单解释得了（目录条目覆盖其下全部；其余按精确路径）。 */
function isCoveredByFiles(relativePath, fileEntries) {
  // package.json 是 npm 强制随包的，不在 `files` 里也会出现。
  if (relativePath === "package.json") return true;
  return fileEntries.some((entry) =>
    relativePath === entry || relativePath.startsWith(`${entry.replace(/\/+$/u, "")}/`));
}

// ---------------------------------------------------------------------------
// 现场快照 / 还原（真实 HOME 不许被污染，prepack 的生成物不许留下）
// ---------------------------------------------------------------------------

/** @param {string} dir */
function snapshotDir(dir) {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return `MISSING:${dir}`;
    const entries = readdirSync(dir).sort();
    return `${dir}:${stat.mtimeMs}:${entries.join(",")}`;
  } catch {
    return `MISSING:${dir}`;
  }
}

function hashFileIfExists(filePath) {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return `MISSING:${filePath}`;
  }
}

/** 递归列出 `src` 下的 `.d.ts`（生成物，跑完必须清）。 */
function listGeneratedDeclarations() {
  /** @type {string[]} */
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith(".d.ts")) out.push(abs);
    }
  };
  const srcDir = join(ROOT, "src");
  if (existsSync(srcDir)) walk(srcDir);
  return out.sort();
}

function cleanup() {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  // prepack 生成的声明：只删「跑之前不存在、现在出现了」的那些；跑之前就有的一律不动。
  const after = listGeneratedDeclarations();
  const generated = after.filter((abs) => !declarationBefore.includes(abs));
  for (const abs of generated) rmSync(abs, { force: true });
  if (generated.length > 0) {
    notes.push(`prepack 生成并清理的 src/**/*.d.ts：${generated.length} 个（跑前已存在且未动的：${after.length - generated.length} 个）`);
  }
}

function verifyNoRealHomePollution() {
  const problems = [];
  if (snapshotDir(join(realHome, ".erix")) !== erixDirBefore) {
    problems.push(`真实 ${join(realHome, ".erix")} 的目录形状/时间戳变了`);
  }
  if (hashFileIfExists(join(realHome, ".npmrc")) !== npmrcBefore) {
    problems.push(`真实 ${join(realHome, ".npmrc")} 内容变了`);
  }
  if (problems.length > 0) fail(`污染了真实用户配置：\n  ${problems.join("\n  ")}`);
  notes.push(`真实 ~/.erix 与 ~/.npmrc 前后一致（${snapshotDir(join(realHome, ".erix"))}｜npmrc=${npmrcBefore.slice(0, 12)}…）`);
}

// ---------------------------------------------------------------------------
// 第 1 步：打包
// ---------------------------------------------------------------------------

function stepPack({ packDir, npmEnv }) {
  const pack = run(npmCommand, [
    "pack",
    `--pack-destination=${packDir}`,
    `--userconfig=${join(tmpRoot, "npmrc")}`,
    `--cache=${join(tmpRoot, "npm-cache")}`,
    "--no-audit",
    "--no-fund",
  ], { cwd: ROOT, env: npmEnv, label: "npm pack", timeoutMs: 180_000 });
  if (pack.status !== 0) {
    fail(`npm pack 退出码 ${pack.status}\nstderr=${tail(pack.stderr)}`);
  }
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    fail(`打包目录里应有且只有 1 个 tarball，实际 ${tarballs.length}：${tarballs.join(", ")}`);
  }
  const tarballName = tarballs[0];
  const tarballPath = join(packDir, tarballName);
  const packed = listTarball(tarballPath);
  if (packed.length === 0) fail(`tarball 里一个文件也没有（${tarballName}）`);

  const problems = [];

  // (a) 声明文件：`prepack` 没跑/生成器坏了，这里就是 0。
  const declarations = packed.filter((name) => name.endsWith(".d.ts"));
  if (declarations.length === 0) {
    problems.push(`tarball 里 .d.ts 数为 0（期望 > 0；prepack 生成器没跑或没随包）`);
  }

  // (b) 当前版本的中英升级指南：从 package.json 版本推，不焊死 0.19。
  const guides = [
    `docs/host-upgrade-guide-${PACKAGE_VERSION}.md`,
    `docs/host-upgrade-guide-${PACKAGE_VERSION}_cn.md`,
  ];
  for (const guide of guides) {
    if (!packed.includes(guide)) problems.push(`缺少随包文档 ${guide}`);
  }

  // (c) `files` 里列的 test/contract/* 必须全在（消费者自跑契约套件靠它们）。
  const contractEntries = PACKAGE_JSON.files.filter((entry) => entry.startsWith("test/contract/"));
  const missingContract = contractEntries.filter((entry) => !packed.includes(entry));
  if (missingContract.length > 0) {
    problems.push(`随包契约套件缺文件：${missingContract.join(", ")}`);
  }

  // (d) 杂物：白名单解释不了的路径 + 点名拦截的形态。
  const fileEntries = PACKAGE_JSON.files.map((entry) => entry.replace(/^\.\//u, "").replace(/\/+$/u, ""));
  const uncovered = packed.filter((name) => !isCoveredByFiles(name, fileEntries));
  const junk = packed.filter((name) => JUNK_PATTERNS.some((pattern) => pattern.re.test(name)));
  if (uncovered.length > 0) {
    problems.push(
      `tarball 里有 ${uncovered.length} 个 package.json 的 files 白名单解释不了的路径：`
      + `${uncovered.slice(0, 10).join(", ")}${uncovered.length > 10 ? " …" : ""}`,
    );
  }
  if (junk.length > 0) {
    const explained = junk.map((name) => {
      const pattern = JUNK_PATTERNS.find((candidate) => candidate.re.test(name));
      return `${name}（${pattern ? pattern.why : "命中杂物名单"}）`;
    });
    problems.push(`tarball 里有杂物：${explained.join(", ")}`);
  }

  if (problems.length > 0) fail(`tarball 断言失败：\n  ${problems.join("\n  ")}`);

  // (e) Markdown 链接闭合：**复用**现成的 check:pack-links，不在这里重写它的断言。
  const linkCheck = run(process.execPath, [join(ROOT, "scripts", "pack-link-check.mjs")], {
    cwd: ROOT,
    env: npmEnv,
    label: "复用 scripts/pack-link-check.mjs",
    timeoutMs: 180_000,
  });
  if (linkCheck.status !== 0) {
    fail(`check:pack-links（随包 Markdown 链接闭合）失败，退出码 ${linkCheck.status}\n${tail(linkCheck.stderr || linkCheck.stdout)}`);
  }

  notes.push(`tarball=${tarballName}（${statSync(tarballPath).size} 字节，${packed.length} 个文件，其中 .d.ts ${declarations.length} 个；契约套件 ${contractEntries.length} 个文件全在）`);
  return { tarballPath, tarballName, packed, declarationCount: declarations.length };
}

// ---------------------------------------------------------------------------
// 第 2 步：装
// ---------------------------------------------------------------------------

function stepInstall({ hostDir, tarballPath, npmEnv }) {
  const install = run(npmCommand, [
    "install",
    tarballPath,
    // 工单口径要 `--prefer-online`；`--offline` 是「不打真网络」的硬保证：装的是本地 tarball、
    // 且本包零运行时依赖，所以任何 registry 请求都是多余的——真出现网络需求这里就会红。
    "--prefer-online",
    "--offline",
    "--no-audit",
    "--no-fund",
    `--userconfig=${join(tmpRoot, "npmrc")}`,
    `--cache=${join(tmpRoot, "npm-cache")}`,
  ], { cwd: hostDir, env: npmEnv, label: "npm install <tarball>", timeoutMs: 180_000 });
  if (install.status !== 0) {
    fail(`安装发布包失败，退出码 ${install.status}\nstderr=${tail(install.stderr)}\nstdout=${tail(install.stdout)}`);
  }
  if (!existsSync(join(hostDir, "node_modules", "erix-agent", "package.json"))) {
    fail("安装后 node_modules/erix-agent/package.json 不存在");
  }
  if (!existsSync(join(hostDir, "node_modules", ".bin", process.platform === "win32" ? "erix.cmd" : "erix"))) {
    fail("安装后 node_modules/.bin/erix 不存在（bin 接线断了）");
  }

  // 入口接线：`types` / `exports.*.types` / `exports.*.default` 声明的目标必须在**装好的包**里真存在。
  // 这里必须是断言而不是「靠 tsc 报错」：TS 优先走 `exports` 的 `types` 条件，所以顶层 `types`
  // 写错时 tsc 一个错都不报（完全绿）；反过来 types 指向不存在的文件时，tsc 会静默解析到 JS
  // ——都是 README 里点名过的坑，只有直接对账清单才能接住。
  const installedRoot = join(hostDir, "node_modules", "erix-agent");
  const installedManifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
  /** @type {Array<{entry: string, kind: string, target: string}>} */
  const declaredTargets = [];
  if (typeof installedManifest.types === "string") {
    declaredTargets.push({ entry: "types", kind: "types", target: installedManifest.types });
  }
  for (const [subpath, condition] of Object.entries(installedManifest.exports ?? {})) {
    if (typeof condition === "string") {
      declaredTargets.push({ entry: `exports[${JSON.stringify(subpath)}]`, kind: "default", target: condition });
      continue;
    }
    for (const [conditionName, target] of Object.entries(condition ?? {})) {
      if (typeof target === "string") {
        declaredTargets.push({ entry: `exports[${JSON.stringify(subpath)}]`, kind: conditionName, target });
      }
    }
  }
  const dangling = declaredTargets.filter(({ target }) => {
    const normalized = target.replace(/^\.\//u, "");
    return !existsSync(join(installedRoot, normalized));
  });
  if (dangling.length > 0) {
    fail(`装好的包里入口接线指到不存在的文件：${dangling.map(({ entry, kind, target }) => `${entry}.${kind} → ${target}`).join("；")}`);
  }
  notes.push(`入口接线对账：${declaredTargets.length} 个声明目标全部存在（types / exports 的 types+default）`);

  writeFileSync(join(hostDir, "probe-imports.mjs"), PROBE_SOURCE, "utf8");
  const probe = run(process.execPath, ["probe-imports.mjs"], {
    cwd: hostDir,
    env: childEnv({ home: join(tmpRoot, "home") }),
    label: "消费者 import 探针",
  });
  if (probe.status !== 0) {
    fail(`消费者视角 import 断言失败，退出码 ${probe.status}\n${tail(probe.stdout)}\n${tail(probe.stderr)}`);
  }
  notes.push(`import 探针：${tail(probe.stdout, 200)}`);
  return { installedVersion: JSON.parse(readFileSync(join(hostDir, "node_modules", "erix-agent", "package.json"), "utf8")).version };
}

const PROBE_SOURCE = `import assert from "node:assert/strict";

const root = await import("erix-agent");
const tools = await import("erix-agent/tools");

const expected = [
  ["erix-agent.runToolLoop", root.runToolLoop],
  ["erix-agent/tools.createFileTools", tools.createFileTools],
];
for (const [name, value] of expected) {
  assert.equal(typeof value, "function", name + " 不是 function（实际 " + typeof value + "）");
  console.log(name + ": function");
}
`;

// ---------------------------------------------------------------------------
// 第 3 步：跑随包契约测试（用装好的包）
// ---------------------------------------------------------------------------

function stepContractTests({ hostDir, storeBase }) {
  mkdirSync(storeBase, { recursive: true });
  writeFileSync(join(hostDir, "contract-selftest.test.mjs"), CONTRACT_SELFTEST_SOURCE, "utf8");
  const result = run(process.execPath, ["--test-reporter=tap", "--test", "contract-selftest.test.mjs"], {
    cwd: hostDir,
    env: childEnv({ home: join(tmpRoot, "home"), extra: { ERIX_RELEASE_CHECK_STORE_BASE: storeBase } }),
    label: "随包契约套件（node --test）",
    timeoutMs: 180_000,
  });
  const counts = {
    tests: pickCount(result.stdout, "tests"),
    pass: pickCount(result.stdout, "pass"),
    fail: pickCount(result.stdout, "fail"),
    skipped: pickCount(result.stdout, "skipped"),
  };
  if (result.status !== 0) {
    const failures = result.stdout.split("\n").filter((line) => line.trim().startsWith("not ok")).slice(0, 12);
    fail(`随包契约套件失败，退出码 ${result.status}（计数 ${JSON.stringify(counts)}）\n${failures.join("\n")}\n${tail(result.stderr)}`);
  }
  if (counts.tests === undefined || counts.tests === 0) {
    fail(`随包契约套件一条也没跑（计数 ${JSON.stringify(counts)}）\nstdout=${tail(result.stdout, 1500)}\nstderr=${tail(result.stderr)}`);
  }
  notes.push(`随包契约套件：tests=${counts.tests} pass=${counts.pass} fail=${counts.fail} skipped=${counts.skipped}`);
  return counts;
}

function pickCount(output, marker) {
  const match = new RegExp(`^# ${marker}:? (\\d+)$`, "mu").exec(output);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

const CONTRACT_SELFTEST_SOURCE = `// 由 scripts/release-check.mjs 生成：消费者视角跑随包契约套件（erix-agent/contract-tests）。
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assemblyPortContract,
  engineApiContract,
  executeToolContract,
  executeToolMigrationContract,
  fileToolsContract,
  modelConfigProviderContract,
  notesStoreCasContract,
  notesStoreContract,
  skillsLoaderContract,
  terminationPayloadContract,
  transcriptStoreContract,
} from "erix-agent/contract-tests";
import {
  createAssemblyPort,
  createBuiltinNotesTools,
  createFileNotesStore,
  createFileTranscriptStore,
  createMemoryTranscriptStore,
  createStaticModelConfigProvider,
} from "erix-agent";
import { buildSkillTools, createFileTools, discoverSkills, loadSkill } from "erix-agent/tools";

const installed = JSON.parse(
  readFileSync(new URL("node_modules/erix-agent/package.json", import.meta.url), "utf8"),
);
const label = "erix-agent@" + installed.version + " (installed)";

// 契约套件要的是「每次一个干净 store」，所以每次工厂调用都换一个全新目录（在临时根里）。
const storeBase = process.env.ERIX_RELEASE_CHECK_STORE_BASE;
if (!storeBase) throw new Error("ERIX_RELEASE_CHECK_STORE_BASE 未设置（应由 release-check.mjs 注入）");
let seq = 0;
const freshDir = () => mkdtempSync(join(storeBase, "store-" + seq++ + "-"));

engineApiContract(label, async () => await import("erix-agent"));
terminationPayloadContract(label, async () => await import("erix-agent"));
fileToolsContract(label + " ./tools", { createFileTools });
executeToolContract(label + " executeTool", () => async () => "release-check result");
executeToolMigrationContract(label + " executeTool (migration)", () => async () => "release-check result");
transcriptStoreContract(label + " memory TranscriptStore", async () => createMemoryTranscriptStore());
transcriptStoreContract(label + " file TranscriptStore", async () => createFileTranscriptStore({ dir: freshDir() }));
notesStoreContract(label + " file NotesStore", async () => createFileNotesStore({ dir: freshDir() }));
notesStoreCasContract(label + " file NotesStore", async () => createFileNotesStore({ dir: freshDir() }));
skillsLoaderContract(label + " ./tools skills", { discoverSkills, loadSkill, buildSkillTools });
// modelConfigProvider 契约要一个带 default 槽 + 另一个可间接取到 key 的槽。
const KEY_ENV = "ERIX_RELEASE_CHECK_STATIC_KEY";
process.env[KEY_ENV] = "release-check-secret";
modelConfigProviderContract(label + " static model config provider", async () => ({
  provider: createStaticModelConfigProvider({
    slots: {
      default: { protocol: "anthropic", endpoint: "https://example.invalid", model: "default-model" },
      audit: { protocol: "openai", endpoint: "https://example.invalid", model: "audit-model", apiKeyEnv: KEY_ENV },
    },
  }),
  slot: "audit",
  expect: { defaultModel: "default-model", slotModel: "audit-model", materializedKey: "release-check-secret" },
}), {
  // issue #518: the third argument is mandatory. A static provider is a slot map, so an
  // explicit unknown slot name must throw (naming it and listing the available slots).
  mode: "throws",
  name: "no-such-slot",
  available: ["default", "audit"],
});
assemblyPortContract(label + " createAssemblyPort", () => ({
  modelConfig: createStaticModelConfigProvider({ model: "release-check-model" }),
  provider: {
    async chat() {
      return { content: [{ type: "text", text: "assembled" }], stopReason: "end_turn" };
    },
  },
  tools: {
    definitions: [],
    async executeTool() {
      return "unused";
    },
  },
  store: createMemoryTranscriptStore(),
  session: { id: "release-check-assembly" },
}));

test(label + " 公共面可取用", () => {
  if (typeof createBuiltinNotesTools !== "function") {
    throw new Error("createBuiltinNotesTools 不在公共面上");
  }
});
`;

// ---------------------------------------------------------------------------
// 第 4 步：真 TypeScript 宿主
// ---------------------------------------------------------------------------

function stepTypeScriptHost({ hostDir }) {
  if (!existsSync(TSC_ENTRY)) {
    fail(`找不到本仓 devDependency 里的 typescript（${relative(ROOT, TSC_ENTRY)}）；先 \`npm install --include=dev\``);
  }
  const typeRoots = join(ROOT, "node_modules", "@types");
  if (!existsSync(join(typeRoots, "node"))) {
    fail(`找不到本仓 devDependency 里的 @types/node（${relative(ROOT, typeRoots)}）`);
  }
  const hostTs = join(hostDir, "host.ts");
  const hostBadTs = join(hostDir, "host-bad-option-key.ts");
  writeFileSync(hostTs, TS_HOST_SOURCE, "utf8");
  writeFileSync(hostBadTs, TS_HOST_BAD_SOURCE, "utf8");

  const tscEnv = childEnv();
  const compile = (file, extraArgs, label) => run(process.execPath, [
    TSC_ENTRY,
    file,
    ...TSC_COMMON_ARGS,
    ...extraArgs,
    // `--typeRoots` 是列表型选项，不吃 `=` 形式，必须分开传。
    "--typeRoots", typeRoots,
    "--types", "node",
  ], { cwd: hostDir, env: tscEnv, label, timeoutMs: 180_000 });

  // (a) 正向宿主：类型面必须能吃下真调用。
  const positive = compile(hostTs, ["--noEmit"], "tsc 正向宿主");
  if (positive.status !== 0) {
    fail(`真 TypeScript 宿主在 --strict 下编译不过（退出码 ${positive.status}）\n${tail(positive.stdout)}\n${tail(positive.stderr)}`);
  }

  // (b) 反向自证：未知 option 键**必须**被拦，且必须是 TS2353（多余属性检查）。
  //     这条断言的意义是「类型面真的在工作」：如果 runToolLoop 的选项退化成 any，这里会编译通过。
  const negative = compile(hostBadTs, ["--noEmit"], "tsc 未知 option 键（期望 TS2353）");
  const negativeOutput = `${negative.stdout}\n${negative.stderr}`;
  if (negative.status === 0) {
    fail("传未知 option 键的那次编译**通过了**：类型面没在拦多余键（退化成 any 了？）");
  }
  if (!negativeOutput.includes("TS2353")) {
    fail(`传未知 option 键的编译失败了，但**不是** TS2353（期望多余属性检查）：\n${tail(negativeOutput)}`);
  }

  // (c) 额外（工单口径之外）：把正向宿主 emit 出来**真跑一遍**，证明发布出去的 JS 能被消费。
  const emit = compile(hostTs, ["--outDir", "dist-host"], "tsc emit 正向宿主");
  if (emit.status !== 0) {
    fail(`正向宿主 emit 失败（退出码 ${emit.status}）\n${tail(emit.stdout)}\n${tail(emit.stderr)}`);
  }
  const compiledEntry = join(hostDir, "dist-host", "host.js");
  if (!existsSync(compiledEntry)) {
    fail(`emit 之后找不到 ${relative(hostDir, compiledEntry)}`);
  }
  const hostRun = run(process.execPath, [compiledEntry], {
    cwd: hostDir,
    env: childEnv({ home: join(tmpRoot, "home") }),
    label: "编译产物运行（真 TS 宿主）",
  });
  if (hostRun.status !== 0) {
    fail(`编译产物运行失败（退出码 ${hostRun.status}）\nstdout=${tail(hostRun.stdout)}\nstderr=${tail(hostRun.stderr)}`);
  }
  if (!hostRun.stdout.includes("release-check-final-answer")) {
    fail(`编译产物的输出里没有模型终稿文本：${tail(hostRun.stdout)}`);
  }
  notes.push(`tsc --strict：正向 exit 0｜未知 option 键报 TS2353｜编译产物运行输出：${tail(hostRun.stdout, 220)}`);
}

const TS_HOST_SOURCE = `// 由 scripts/release-check.mjs 生成：真 TypeScript 宿主（编译期断言的对象）。
import {
  createAssemblyPort,
  createMemoryTranscriptStore,
  createOpenAIProvider,
  createStaticModelConfigProvider,
  runToolLoop,
} from "erix-agent";
import { createFileTools } from "erix-agent/tools";

const stubChat = async () => ({
  content: [{ type: "text", text: "release-check-final-answer 任务已完成" }],
  stopReason: "end_turn",
});

// createOpenAIProvider 带 fetchImpl 桩：构造它不发请求，真网络也不会被碰到。
const openAiProvider = createOpenAIProvider({
  endpoint: "http://127.0.0.1:4321/v1",
  apiKey: "release-check-key",
  model: "release-check-model",
  fetchImpl: async () => new Response("{}", { status: 200 }),
});

const fileTools = createFileTools({ cwd: process.cwd() });
const toolNames: string[] = fileTools.definitions.map((definition) => definition.name);
const fileToolCount: number = fileTools.definitions.length;
const fileToolExecutorType: string = typeof fileTools.executeTool;

const assemblyPort = createAssemblyPort({
  modelConfig: createStaticModelConfigProvider({ model: "release-check-model" }),
  provider: { chat: stubChat },
  tools: {
    definitions: fileTools.definitions,
    executeTool: async () => "release-check-tool-result",
  },
  store: createMemoryTranscriptStore(),
  session: { id: "release-check-host" },
});

const result = await runToolLoop({
  assemblyPort,
  provider: { chat: stubChat },
  executeTool: async (toolCall) => "ran:" + String(toolCall.name),
  // issue #497 复审 R3: the type surface must match the real group names. This host uses three
  // real groups (run / tuning / metadata); a fake group name (timeouts / reflection / retry, the
  // three that used to sit in the JSDoc) makes tsc --strict report TS2353 here, so "the published
  // type surface disagrees with the code" no longer needs someone to read the .d.ts.
  // #530: reflection 退役扁平写法（家 config.run.reflection）——本模板是**真宿主夹具**：
  // 只改拼写，断言与类型面自证一字未改。
  config: {
    run: { maxRounds: 2, reflection: false },
    tuning: { temperature: 0 },
    metadata: { requestId: "release-check-host" },
  },
});

console.log(
  [
    "finalText=" + result.finalText,
    "rounds=" + result.rounds,
    "termination=" + result.termination.reason,
    "verification=" + result.verification.status,
    "inputTokens=" + result.usage.input_tokens,
    "fileToolCount=" + fileToolCount,
    "toolNames=" + toolNames.join(","),
    "fileToolExecutorType=" + fileToolExecutorType,
    "providerModel=" + String(openAiProvider.model),
  ].join(" "),
);
`;

const TS_HOST_BAD_SOURCE = `// 由 scripts/release-check.mjs 生成：反向自证——未知 option 键必须被类型面拦住（TS2353）。
import { createMemoryTranscriptStore, runToolLoop } from "erix-agent";

await runToolLoop({
  provider: { chat: async () => ({}) },
  executeTool: async () => "ok",
  store: createMemoryTranscriptStore(),
  // #546: 本样本是**故意坏**的：只保留 `thisOptionKeyDoesNotExistInRunToolLoopOptions` 这一个
  // 坏点。其余拼写必须是当前**合法**写法，否则「红的原因」不再是我埋的那一个（#498 S3 A21
  // 已退役扁平 `maxRounds`，它的家是 `config.run.maxRounds`）——旧写法让样本变成「双坏」，
  // 而断言只要求「编译失败」，所以一直绿。
  thisOptionKeyDoesNotExistInRunToolLoopOptions: 1,
  config: { run: { maxRounds: 1, reflection: false } },
});
`;

// ---------------------------------------------------------------------------
// 第 5 步：CLI 冒烟（装好的包 + 本地假上游）
// ---------------------------------------------------------------------------

const CHAT_MARKER = "T5-RELEASE-CHECK-HELLO";

async function stepCliSmoke({ hostDir, projectDir }) {
  const upstream = createScriptedUpstream({
    script: [
      jsonResponse({
        choices: [{
          message: { role: "assistant", content: `探针回复 ${CHAT_MARKER} 任务已完成` },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    ],
  });
  try {
    const baseUrl = await upstream.listen();
    const home = join(tmpRoot, "home");
    writeConfigHome({
      dir: home,
      erix: { ...upstreamFields(baseUrl).erixSlot, apiKey: "release-check-key", model: "release-check-model" },
    });
    const env = childEnv({ home });
    const binPath = join(hostDir, "node_modules", ".bin", process.platform === "win32" ? "erix.cmd" : "erix");

    // (a) `erix --version` 必须等于 package.json 版本（发版最容易出错的一位）。
    const version = await runAsync(binPath, ["--version"], { cwd: projectDir, env, label: "erix --version" });
    if (version.status !== 0) {
      fail(`erix --version 退出码 ${version.status}\nstdout=${tail(version.stdout)}\nstderr=${tail(version.stderr)}`);
    }
    if (version.stdout.trim() !== PACKAGE_VERSION) {
      fail(`erix --version 打的是 ${JSON.stringify(version.stdout.trim())}，期望等于 package.json 的 ${PACKAGE_VERSION}`);
    }

    // (b) 一次真 `erix chat`：端点是本地假上游。**当前承诺的退出码是 4**（默认不开
    //     `--final-guard` → 核验 skipped），不是失败；见 `bin/cli.js` 帮助里的退出码段。
    const chat = await runAsync(binPath, [
      "chat", "工单 T5 冒烟：只回一句话，不要调工具",
      "--max-rounds", "3",
      "--reflection", "off",
    ], { cwd: projectDir, env, label: "erix chat", timeoutMs: 60_000 });
    if (chat.status !== EXIT_NOT_VERIFIED) {
      fail(`erix chat 退出码 ${chat.status}，期望 ${EXIT_NOT_VERIFIED}（默认不开 --final-guard → 核验 skipped）\nstdout=${tail(chat.stdout)}\nstderr=${tail(chat.stderr)}`);
    }
    if (!chat.stdout.includes(CHAT_MARKER)) {
      fail(`erix chat 的 stdout 里没有假上游回的文本（${CHAT_MARKER}）——它可能根本没打上假端点\nstdout=${tail(chat.stdout)}`);
    }
    if (!chat.stdout.includes("guard=off")) {
      fail(`erix chat 的 stdout 里缺少 guard 状态行（期望 guard=off）\nstdout=${tail(chat.stdout)}`);
    }
    if (upstream.requestCount === 0) {
      fail("假上游一个请求也没收到：这次 chat 根本没打本地端点（离线断言不成立）");
    }

    // (c) `--session <不存在的 id>` 退 1（issue #168 的行为承诺）。
    const missingSession = await runAsync(binPath, [
      "chat", "工单 T5 冒烟：这条不该跑起来",
      "--session", "t5-release-check-missing-session",
      "--reflection", "off",
    ], { cwd: projectDir, env, label: "erix chat --session <不存在>" });
    if (missingSession.status !== EXIT_USAGE) {
      fail(`erix chat --session <不存在的 id> 退出码 ${missingSession.status}，期望 ${EXIT_USAGE}\nstdout=${tail(missingSession.stdout)}\nstderr=${tail(missingSession.stderr)}`);
    }

    notes.push(`CLI 冒烟：erix --version=${version.stdout.trim()}｜chat 退 ${chat.status}（skipped 承诺）并真的打了假上游 ${upstream.requestCount} 个请求｜--session 不存在退 ${missingSession.status}`);
  } finally {
    upstream.close();
  }
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

// 步骤之间的传递全部走 ctx（上一步的产物喂给下一步），所以任何一步单独红都能立刻看出是哪一步。
const STEPS = [
  {
    title: "打包（npm pack + tarball 断言 + 复用 check:pack-links）",
    run: (ctx) => { ctx.pack = stepPack(ctx); },
  },
  {
    title: "装（tarball 装进一次性临时项目 + 消费者 import）",
    run: (ctx) => {
      ctx.installed = stepInstall({
        hostDir: ctx.hostDir,
        tarballPath: ctx.pack.tarballPath,
        npmEnv: ctx.npmEnv,
      });
    },
  },
  {
    title: "跑随包契约测试（node --test 用装好的包）",
    run: (ctx) => { ctx.contracts = stepContractTests(ctx); },
  },
  {
    title: "真 TypeScript 宿主（tsc --strict + TS2353 反向自证 + 编译产物运行）",
    run: (ctx) => { stepTypeScriptHost(ctx); },
  },
  {
    title: "CLI 冒烟（装好的 erix + 本地假上游）",
    run: (ctx) => stepCliSmoke(ctx),
  },
];

function printTimings(prefix) {
  for (const timing of stepTimings) {
    console.log(`${prefix}[${timing.index}/${STEPS.length}] ${timing.title} → ${timing.status} (${timing.seconds}s)`);
  }
}

async function main() {
  realHome = process.env.HOME ?? process.env.USERPROFILE ?? "";
  for (const name of PROXY_VARS) {
    savedProxyValues.set(name, process.env[name]);
    delete process.env[name];
  }
  declarationBefore = listGeneratedDeclarations();
  erixDirBefore = snapshotDir(join(realHome, ".erix"));
  npmrcBefore = hashFileIfExists(join(realHome, ".npmrc"));

  // 临时目录一律走 os.tmpdir()（尊重 TMPDIR），前缀点名本命令，便于事后排查残留。
  tmpRoot = mkdtempSync(join(tmpdir(), "erix-release-check-"));
  const packDir = join(tmpRoot, "pack");
  const hostDir = join(tmpRoot, "host-project");
  const storeBase = join(tmpRoot, "stores");
  const projectDir = join(tmpRoot, "cli-project");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(hostDir, { recursive: true });
  mkdirSync(join(tmpRoot, "home"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(tmpRoot, "npmrc"), "# release-check 专用空 userconfig（不读真实 ~/.npmrc）\n", "utf8");
  writeFileSync(join(hostDir, "package.json"), `${JSON.stringify({
    name: "erix-release-check-host",
    version: "1.0.0",
    private: true,
    type: "module",
  }, null, 2)}\n`, "utf8");

  /** @type {any} */
  const context = {
    packDir,
    hostDir,
    storeBase,
    projectDir,
    npmEnv: childEnv({ home: join(tmpRoot, "home") }),
  };

  console.log(`release-check: erix-agent ${PACKAGE_VERSION}（临时根 ${tmpRoot}）`);
  for (let index = 0; index < STEPS.length; index += 1) {
    const step = STEPS[index];
    const startedAt = Date.now();
    try {
      await step.run(context);
      stepTimings.push({ index: index + 1, title: step.title, status: "ok", seconds: elapsedSeconds(startedAt) });
      console.log(`release-check: 第 ${index + 1}/${STEPS.length} 步 ok — ${step.title}（${elapsedSeconds(startedAt)}s）`);
    } catch (error) {
      const seconds = elapsedSeconds(startedAt);
      stepTimings.push({ index: index + 1, title: step.title, status: "FAIL", seconds });
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nrelease-check: 第 ${index + 1}/${STEPS.length} 步 FAIL — ${step.title}（${seconds}s）`);
      console.error(`release-check: 失败原因：${message}`);
      printTimings("release-check:   ");
      throw error;
    }
  }

  verifyNoRealHomePollution();
  console.log("release-check: 实测明细");
  for (const note of notes) console.log(`  - ${note}`);
  const total = Math.round(stepTimings.reduce((sum, timing) => sum + timing.seconds, 0) * 10) / 10;
  console.log(`release-check: OK — 五步全绿，累计 ${total}s（墙钟 ${elapsedSeconds(STARTED_AT)}s）`);
}

function elapsedSeconds(startedAt) {
  return Math.round(((Date.now() - startedAt) / 1000) * 10) / 10;
}

const STARTED_AT = Date.now();

process.on("exit", () => {
  try {
    cleanup();
  } catch {
    // 清理失败不许盖掉真正的失败原因
  }
  for (const [name, value] of savedProxyValues) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

try {
  await main();
} catch {
  process.exitCode = 1;
}
