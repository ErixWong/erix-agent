#!/usr/bin/env node
// npm-tarball Markdown link closure check. A link to a repository file omitted
// from the tarball is blocking (exit 1); a link whose target is absent from the
// repository is reported as a warning and does not change the exit code.
//
// issue #268（门禁互相投毒）：`npm pack` 会先跑仓内 `prepack` 钩子，而 `prepack` =
// `scripts/build-types.mjs`，它往 `src/` 写约 61 个 `.d.ts` **且不回收**；紧随其后的
// `npm run check:types` 会被 `scripts/type-check-ratchet.mjs` 的陈旧声明守卫（issue #214，
// 正确性前提，不许放宽）硬失败。所以本脚本自己负责收尾：**跑前快照 `src/**/*.d.ts`，
// 结束时（含失败/抛错路径）只删本次 `prepack` 新生成的那些**，跑前就已存在的声明文件一律保留。
//
// 可注入性（可测性要求）：`checkPackLinks({ root, runPack })` 的 `runPack` 缺省就是真
// `npm pack --dry-run --json`（`runNpmPackDryRun`，行为与 #268 之前逐字一致）；测试注入假
// pack，既不必 spawn 真 npm，也能模拟「prepack 留下了生成物」这条真实投毒路径。

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listDeclarationFiles, reclaimGeneratedDeclarations } from "./generated-declarations.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF_PATH), "..");
const SELF_TEST = process.argv.includes("--self-test");

/**
 * 缺省的 pack 执行器：真跑 `npm pack --dry-run --json`（不产出 tarball）。
 *
 * @param {{ cwd?: string }} params
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: Error }} spawnSync 结果
 */
export function runNpmPackDryRun({ cwd = ROOT } = {}) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawnSync(npmCommand, ["pack", "--dry-run", "--json"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
  });
}

/**
 * 回收本次 `prepack` 新生成的声明文件；回收本身的失败**不会**盖住调用方的原始失败
 * （只在原始结果为 0 时才把退出码抬成 1，并另打一行提示）。
 *
 * @returns {{code: number, removed: number, kept: number}} `code` = 0 没什么要收的或全部收干净 / 1 有文件删不掉；
 *   `removed` / `kept` 用于 `.d.ts` 声称对账（见 `checkDeclarationClaims`）
 */
function reclaimDeclarations(root, before) {
  let result;
  try {
    result = reclaimGeneratedDeclarations({ root, before });
  } catch (error) {
    console.error(
      `pack-link-check: 回收 prepack 生成物时出错：${error.message}`
      + "（请手工核对 src/ 下是否有残留 .d.ts，见 issue #268）",
    );
    return { code: 1, removed: 0, kept: 0 };
  }
  if (result.removed.length > 0) {
    console.error(
      `pack-link-check: 已回收本次 prepack 新生成的 ${result.removed.length} 个 src/**/*.d.ts`
      + `（跑前就已存在的 ${result.kept} 个按原样保留——见 issue #268）`,
    );
  }
  for (const failure of result.failed) {
    console.error(
      `pack-link-check: 无法回收 ${failure}；残留的 .d.ts 会让 check:types 的陈旧声明守卫硬失败`,
    );
  }
  return {
    code: result.failed.length > 0 ? 1 : 0,
    removed: result.removed.length,
    kept: result.kept,
  };
}

/**
 * 「装包应列 **N** 个 `.d.ts`」这类**现值声称**的覆盖面（工单 261021-03 任务 A）。
 * 只收「宿主/发版作者会照着看的那四份入口文档」；CHANGELOG 里的那些数字是**历史条目**，不改写也不对账。
 */
const DECLARATION_CLAIM_DOCS = ["README.md", "README_cn.md", "AGENTS.md", "AGENTS_cn.md"];
/**
 * 声明位句式（**只收声称句式，不收叙述句与历史值**）：
 *   · CN「（装包后）应列出 **N** 个 `.d.ts`」
 *   · EN「… should list **N** `.d.ts`」
 * `**` 加粗与换行都允许（两份 AGENTS 的写法就在数字前换行）；反引号包着的 `.d.ts` 必须紧跟数字，
 * 于是「61 个 `.d.ts` 在场 = 0 个错」、「63（0.19.0 时代）」这类历史叙述不会被当成现值声称。
 */
const DECLARATION_CLAIM_PATTERNS = [
  { id: "cn-应列出", re: /应列出\s*(?:\*\*)?(\d+)(?:\*\*)?\s*个\s*`\.d\.ts`/g },
  { id: "en-should-list", re: /should list\s*(?:\*\*)?(\d+)(?:\*\*)?\s*`\.d\.ts`/gi },
];

/**
 * 把文档里的 `.d.ts` 现值声称与**随包声明数**对账（不为了数数再跑一次 tsc：数字来自同一次
 * `npm pack --dry-run --json` 的文件清单）。
 *
 * 三条判据：
 *   ① 每一处声明位的 N 必须等于随包声明数，不等 ⇒ 红，并点名文档与行；
 *   ② 覆盖面里**一处声明都抽不到** ⇒ 红（#164 口径：抽不到真值就报错，别静默空跑）；
 *      四份文档在树里全都不存在（合成测试树）时不适用，只提示不判红。
 *   ③ 随包声明数与回收清点（新生成 + 跑前已在场）不一致 ⇒ 红——两个读法应当同值，对不上说明清点或解析失效。
 *
 * @param {{root: string, packedDeclarationCount: number|null, reclaim?: {removed: number, kept: number}}} params
 * @returns {number} 0 = 通过；1 = 失败
 */
export function checkDeclarationClaims({ root, packedDeclarationCount, reclaim }) {
  if (packedDeclarationCount === null || packedDeclarationCount === undefined) return 0;   // pack 自己就失败了，那边已经报过
  const present = DECLARATION_CLAIM_DOCS.filter((rel) => existsSync(path.join(root, rel)));
  if (!present.length) {
    console.log("pack-link-check: 树里没有 README/AGENTS 四份入口文档，.d.ts 声称对账不适用（合成测试树）");
    return 0;
  }
  let failed = false;
  let claims = 0;
  for (const rel of present) {
    const source = readFileSync(path.join(root, rel), "utf8");
    for (const { id, re } of DECLARATION_CLAIM_PATTERNS) {
      re.lastIndex = 0;
      for (const m of source.matchAll(re)) {
        claims += 1;
        const claimed = Number(m[1]);
        const line = source.slice(0, m.index).split("\n").length;
        if (claimed !== packedDeclarationCount) {
          failed = true;
          console.error(
            `pack-link-check: ${rel}:${line} 声称「装包应列 ${claimed} 个 .d.ts」（句式 ${id}），` 
            + `但同一次 npm pack 的清单里有 ${packedDeclarationCount} 个 src/**/*.d.ts——` 
            + "这个数由本门禁与包内容对账，不许手抄：把文档改成实测值（历史值要写成历史值）。",
          );
        }
      }
    }
  }
  if (!claims) {
    console.error(
      `pack-link-check: 覆盖面（${present.join(", ")}）里一句「装包应列 N 个 .d.ts」的声明位都没抽到——` 
      + "对账在空跑：要么句式被改写了（同步改本脚本的 DECLARATION_CLAIM_PATTERNS），要么声称被删了（把它加回来）。",
    );
    failed = true;
  }
  if (reclaim) {
    const inventoried = reclaim.removed + reclaim.kept;
    if (inventoried !== packedDeclarationCount) {
      console.error(
        `pack-link-check: 随包声明数 ${packedDeclarationCount} 与 src/ 下的实物清点 ${inventoried}` 
        + `（本次新生成 ${reclaim.removed} + 跑前已在场 ${reclaim.kept}）对不上——` 
        + "两个读法应该同值，对不上说明包清单解析或清点逻辑失效，本门禁的真值不可信。",
      );
      failed = true;
    }
  }
  if (!failed) {
    console.log(
      `pack-link-check: OK — .d.ts 声称对账：${claims} 处声明位全部等于随包声明数 ${packedDeclarationCount}` 
      + `（覆盖面 ${present.length} 份入口文档；数字取自 npm pack 清单，未额外跑 tsc）`,
    );
  }
  return failed ? 1 : 0;
}


// ── test/contract/ 发布面对账（issue #505） ────────────────────────────────────────────
//
// `test/contract/` 是**发布面契约套件**目录：`package.json` 的 `files` 把它**逐个列举**
// （`"test/contract/assembly-port.js"` 这样一条条写），**不收目录**。于是有一个静默失败面：
// 目录里新增一个 `.js` 却忘了同步进 `files` ⇒ 它根本不进 tarball，宿主装完少跑一条契约证明，
// 而 `check:release` 第 4 步照绿（它只反方向断言「`files` 里的 `test/contract/*` 都在包里」），
// 没有任何门禁会红。本段把三个方向都变成机器判据：
//
//   判据 1（红）：`test/contract/` 下**存在的**、非 `*.test.js` 的 `.js`，不在 tarball 清单里
//                 也没登记豁免 ⇒ 红并点名文件（= 忘了加进 `files`）。
//   判据 2（红）：`files` 里列的 `test/contract/...` 在磁盘上不存在 ⇒ 红并点名（死条目 / 历史残留）。
//   判据 3（不红但必须打印）：`test/contract/*.test.js` 在磁盘上有、包里没有——**有意为之**：
//                 它们是 `node --test` 套件，由 `npm test` / `npm run check:docs-examples` 在仓库内跑，
//                 宿主不需要。逐个点名并写明「谁跑它 / 为什么不随包」，免得后来人又当成漏包。
//
// 豁免登记表（`CONTRACT_PUBLISH_EXEMPTIONS`）：判据 1 需要一个「有意不发布」的出口，但它**不是放宽**——
// 登记表自己也被看守（空转即红）：登记的文件不在磁盘上 / 已经随包了 / `why` 为空 / `path` 不是
// `test/contract/` 下的具体文件 / 条数超过上限 ⇒ 全部红。上限是**双向**的：现值 1，第二份 harness
// 不搬走就想加豁免 ⇒ 红并提示「先问该不该放进发布面目录」（豁免表不许慢慢长成后门）。
//
// 本条判据与既有两道判据一样**只读已经拿到的 pack 清单**：不额外跑 pack、不跑 tsc、不联网。

const CONTRACT_DIR = "test/contract";
const CONTRACT_TEST_SUFFIX = ".test.js";

/**
 * 「有意不随包发布」的登记表。每条的 `why` 必须同时写清**谁在用它**与**为什么不发布**——
 * 只写「宿主不需要」是不够的（那是结论，不是理由）。
 *
 * 当前唯一一条：`test/contract/doc-examples.js` 是**文档示例三层验证 harness**（issue #158），
 * 唯一使用者是 `test/contract/doc-examples.test.js`（`npm run check:docs-examples`），发布入口
 * `test/contract/index.js` 不引用它 ⇒ 宿主拿不到也不需要它；而 `*.test.js` 本来就不随包发布，
 * 故它也不发布。**正解是搬家**（`test/contract/` 是宿主契约套件目录，harness 放错了目录），
 * 但搬家牵动 `check:docs-examples` 与 #498 S8 的迁移面 ⇒ 本单先用登记表转绿，搬家留给 S8。
 */
const CONTRACT_PUBLISH_EXEMPTIONS = Object.freeze([
  Object.freeze({
    path: "test/contract/doc-examples.js",
    why: "文档示例三层验证 harness（issue #158）：唯一使用者是 test/contract/doc-examples.test.js"
      + "（npm run check:docs-examples），发布入口 test/contract/index.js 不引用它 ⇒ 宿主不需要、"
      + "装完也用不到；而 *.test.js 本来就不随包发布，所以它也不发布。正解是搬出发布面目录"
      + "（test/contract/ 是宿主契约套件目录），搬家牵动 check:docs-examples 与 #498 S8，留给 S8",
  }),
]);
/** 登记表条数上限（现值 1，实测）。双向：多了红、少了也要么删条目要么降上限（见 `--self-test`）。 */
const CONTRACT_PUBLISH_EXEMPTION_MAX = 1;

/**
 * 判据三口的**纯函数核心**：只吃已经拿到的四份事实（`files` 数组、磁盘上的文件/目录、tarball 清单、
 * 豁免登记表），不读盘、不跑 pack、不打印——于是 `--self-test` 能在内存夹具上做反向证，
 * 而真门禁只负责把事实凑齐再把结果打出来。
 *
 * @param {{files: unknown, diskFiles?: string[], diskDirs?: string[], packedPaths?: Set<string>|string[],
 *          exemptions?: Array<{path: string, why?: string}>, maxExemptions?: number,
 *          scriptCommands?: Record<string, string>}} params
 * @returns {{applicable: boolean, errors: string[], testFileLines: string[], exemptionLines: string[], summary: string|null}}
 */
export function evaluateContractSurface({
  files,
  diskFiles = [],
  diskDirs = [],
  packedPaths = [],
  exemptions = [],
  maxExemptions = CONTRACT_PUBLISH_EXEMPTION_MAX,
  scriptCommands = {},
} = {}) {
  const empty = { applicable: false, errors: [], testFileLines: [], exemptionLines: [], summary: null };
  if (!Array.isArray(files)) return empty;   // 没有 `files` 字段的树（合成夹具 / 非本仓）不适用，不判红

  const packed = packedPaths instanceof Set ? packedPaths : new Set(packedPaths ?? []);
  const diskSet = new Set(diskFiles ?? []);
  const dirSet = new Set(diskDirs ?? []);
  const entries = files.filter(
    (entry) => typeof entry === "string" && (entry === CONTRACT_DIR || entry.startsWith(`${CONTRACT_DIR}/`)),
  );
  const errors = [];

  // ── 登记表自证（空转即红） ───────────────────────────────────────────────
  const exemptPaths = new Set();
  if (!Array.isArray(exemptions)) {
    errors.push("CONTRACT_PUBLISH_EXEMPTIONS 不是数组——判据 1 的豁免出口被改坏了（#505）");
  } else {
    if (exemptions.length > maxExemptions) {
      errors.push(
        `CONTRACT_PUBLISH_EXEMPTIONS 有 ${exemptions.length} 条，上限 ${maxExemptions} 条——`
        + "第二份「有意不发布」的东西出现了：先问「该不该放进发布面目录」（test/contract/ 是宿主契约套件目录），"
        + "正解通常是搬出去，而不是往豁免表里再加一条；确需放宽请同时改 CONTRACT_PUBLISH_EXEMPTION_MAX 并说明理由",
      );
    } else if (exemptions.length < maxExemptions) {
      errors.push(
        `CONTRACT_PUBLISH_EXEMPTIONS 只剩 ${exemptions.length} 条，而上限（= 期望值）是 ${maxExemptions} 条——`
        + "条目被删掉了就把 CONTRACT_PUBLISH_EXEMPTION_MAX 一起降下来：不许留余量（余量就是下一个人悄悄塞一条的空间）",
      );
    }
    for (const exemption of exemptions) {
      const exemptPath = exemption?.path;
      if (typeof exemptPath !== "string" || !exemptPath.startsWith(`${CONTRACT_DIR}/`) || exemptPath.endsWith("/")) {
        errors.push(
          `豁免登记项 ${JSON.stringify(exemptPath)} 不是 ${CONTRACT_DIR}/ 下的具体文件路径——`
          + "豁免只收「发布面目录里的单个文件」，目录 / 目录前缀 / 别的目录都不收",
        );
        continue;
      }
      if (exemptPaths.has(exemptPath)) errors.push(`豁免登记项重复：${exemptPath}（同一文件登记两次）`);
      exemptPaths.add(exemptPath);
      if (typeof exemption.why !== "string" || exemption.why.trim() === "") {
        errors.push(
          `豁免登记项 ${exemptPath} 的 why 为空——必须写清「谁在用它」与「为什么不发布」，`
          + "只写结论（如「宿主不需要」）等于没有理由",
        );
      }
      if (!diskSet.has(exemptPath) && !dirSet.has(exemptPath)) {
        errors.push(
          `豁免登记项 ${exemptPath} 在磁盘上不存在——空转条目：文件被删/被改名了，`
          + "登记表必须跟着清掉（否则判据 1 对它永久失效）",
        );
      }
      if (packed.has(exemptPath)) {
        errors.push(
          `豁免登记项 ${exemptPath} 已经出现在 tarball 清单里——它其实随包了，条目过期；`
          + "要么把它从 files 里删掉，要么把这条豁免删掉（两个说法不能同时成立）",
        );
      }
    }
  }

  // ── 判据 1（红）：磁盘上非 *.test.js 的 .js 必须随包 ───────────────────────
  const diskJs = [...diskSet].filter(
    (rel) => rel.startsWith(`${CONTRACT_DIR}/`) && rel.endsWith(".js"),
  ).sort();
  const contractTestFiles = diskJs.filter((rel) => rel.endsWith(CONTRACT_TEST_SUFFIX));
  const contractSourceFiles = diskJs.filter((rel) => !rel.endsWith(CONTRACT_TEST_SUFFIX));
  for (const rel of contractSourceFiles) {
    if (packed.has(rel) || exemptPaths.has(rel)) continue;
    errors.push(
      `${rel} 在磁盘上、却不在 npm tarball 清单里（也没登记豁免）——`
      + "files 对 test/contract/ 是逐个列举、不收目录，新加的 .js 必须同步进 files；"
      + "否则它静默不打包，宿主装完少跑一条契约证明，而 check:release 第 4 步照绿",
    );
  }

  // ── 判据 2（红）：files 里列的 test/contract/... 必须在磁盘上 ───────────────
  for (const entry of entries) {
    if (diskSet.has(entry) || dirSet.has(entry)) continue;
    errors.push(
      `files 里列的 ${entry} 在磁盘上不存在——死条目（历史残留）：`
      + "删掉这条，或把文件补回来（留着它只会让 files 清单继续骗人）",
    );
  }

  // ── 判据 3（不红但必须打印）：*.test.js 有意不随包 ─────────────────────────
  const runnerOf = (rel) => {
    const hits = Object.entries(scriptCommands ?? {})
      .filter(([, command]) => typeof command === "string" && command.includes(rel))
      .map(([name]) => `npm run ${name}`);
    return hits.length ? hits.join(" / ") : "npm test（node --test 自动发现 *.test.js）";
  };
  const testFileLines = contractTestFiles.map((rel) => {
    const shipped = packed.has(rel);
    return `${rel}：${shipped ? "**已在包里**（反常：测试套件不该发布）" : "不随包发布"}——`
      + `node --test 套件，由 ${runnerOf(rel)} 在仓库内跑；宿主不需要它。`
      + "npm pack 清单里 *.test.js 的数量是 0，这是有意为之，不是漏包";
  });
  const exemptionLines = [...exemptPaths].sort().map((rel) => {
    const why = exemptions.find((item) => item?.path === rel)?.why ?? "";
    return `${rel}：已登记豁免（不随包）——${why}`;
  });

  const packedContractCount = [...packed].filter(
    (rel) => rel === CONTRACT_DIR || rel.startsWith(`${CONTRACT_DIR}/`),
  ).length;
  const summary = errors.length
    ? null
    : `test/contract/ 发布面对账：磁盘 ${diskJs.length} 个 .js（非测试 ${contractSourceFiles.length} / 测试 ${contractTestFiles.length}）`
      + `，tarball 里 ${CONTRACT_DIR}/ 条目 ${packedContractCount} 个，files 里 ${entries.length} 条无一死条目；`
      + `${contractTestFiles.length} 个 *.test.js 与 ${exemptPaths.size} 个已登记豁免不随包（逐条见上）`;

  return { applicable: true, errors, testFileLines, exemptionLines, summary };
}

/** 从磁盘凑齐判据三口要的事实（`package.json` 的 `files`/`scripts` + `test/contract/` 的实物）。 */
function readContractSurfaceFacts(root) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;   // 读不到 package.json（合成测试树）：不适用
  }
  const absContractDir = path.join(root, CONTRACT_DIR);
  const diskFiles = [];
  const diskDirs = [];
  const walk = (absDir, relDir) => {
    let dirents;
    try {
      dirents = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${relDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        diskDirs.push(rel);
        walk(path.join(absDir, dirent.name), rel);
      } else if (dirent.isFile()) {
        diskFiles.push(rel);
      }
    }
  };
  if (existsSync(absContractDir)) {
    diskDirs.push(CONTRACT_DIR);
    walk(absContractDir, CONTRACT_DIR);
  }
  return { manifest, diskFiles, diskDirs };
}

/**
 * 判据三口的**门禁出口**：凑事实 → 跑纯函数核心 → 打印。返回 0/1（1 = 有红）。
 *
 * `root` 里没有可读的 `package.json` 时判为「不适用」并打印一行（合成测试树不判红，
 * 与 `checkDeclarationClaims` 对缺文档的处理同口径）。
 *
 * @param {{root?: string, packedPaths?: Set<string>, exemptions?: Array<{path: string, why?: string}>,
 *          maxExemptions?: number}} params
 * @returns {number} 0 = 通过（或不适用）；1 = 失败
 */
export function checkContractPublishSurface({
  root = ROOT,
  packedPaths = new Set(),
  exemptions = CONTRACT_PUBLISH_EXEMPTIONS,
  maxExemptions = CONTRACT_PUBLISH_EXEMPTION_MAX,
} = {}) {
  const facts = readContractSurfaceFacts(root);
  if (!facts) {
    console.log(
      "pack-link-check: 树里没有可读的 package.json，test/contract/ 发布面对账不适用（合成测试树）",
    );
    return 0;
  }
  const verdict = evaluateContractSurface({
    files: facts.manifest.files,
    diskFiles: facts.diskFiles,
    diskDirs: facts.diskDirs,
    packedPaths,
    exemptions,
    maxExemptions,
    scriptCommands: facts.manifest.scripts ?? {},
  });
  if (!verdict.applicable) {
    console.log(
      `pack-link-check: package.json 没有 files 数组，${CONTRACT_DIR}/ 发布面对账不适用`,
    );
    return 0;
  }
  if (verdict.errors.length > 0) {
    console.error(
      `pack-link-check: ${verdict.errors.length} 处 test/contract/ 发布面问题（issue #505）：`,
    );
    for (const error of verdict.errors) console.error(`  ${error}`);
    return 1;
  }
  console.log(`pack-link-check: OK — ${verdict.summary}`);
  for (const line of verdict.testFileLines) console.log(`  · ${line}`);
  for (const line of verdict.exemptionLines) console.log(`  · ${line}`);
  return 0;
}

/** 链接闭合判定本身（不含生成物回收）。另外把**随包声明数**一并报给调用方，
 *  它就是「装包应列 N 个 `.d.ts`」这类声称的真值（取自同一次 pack 清单，零额外成本）。 */
function evaluatePackLinks({ root, runPack }) {
  let pack;
  try {
    pack = runPack({ cwd: root });
  } catch (error) {
    // 跑不动 pack：原始错误信息原样传出，退出码 1（不换成别的错，也不吞掉）
    console.error(`pack-link-check: failed to run npm pack: ${error.message}`);
    return { exitCode: 1, packedDeclarationCount: null };
  }

  let exitCode = 0;
  let packedDeclarationCount = null;

  if (pack.error) {
    console.error(`pack-link-check: failed to run npm pack: ${pack.error.message}`);
    exitCode = 1;
  } else if (pack.status !== 0) {
    console.error(`pack-link-check: npm pack failed (exit ${pack.status})`);
    const stderr = (pack.stderr ?? "").trim();
    if (stderr) console.error(stderr);
    exitCode = 1;
  } else {
    let packInfo;
    try {
      packInfo = JSON.parse(pack.stdout ?? "");
    } catch (error) {
      console.error(`pack-link-check: could not parse npm pack JSON: ${error.message}`);
      exitCode = 1;
    }

    const listedFiles = packInfo?.[0]?.files;
    if (exitCode !== 1 && !Array.isArray(listedFiles)) {
      console.error("pack-link-check: npm pack JSON did not include a files array");
      exitCode = 1;
    }

    if (exitCode !== 1) {
      const packedPaths = new Set(
        listedFiles.map(({ path: filePath }) =>
          path.posix.normalize(filePath.replaceAll("\\", "/").replace(/^package\//, "")),
        ),
      );
      // 随包声明数 = tarball 清单里 `src/**/*.d.ts` 的条目数。它是「装包应列 N 个」这句话的真值，
      // 不靠「本次回收了多少」——后者取决于跑前树里有没有别人留下的生成物（同一个仓库两种树形会给出 0 与 69）。
      packedDeclarationCount = [...packedPaths].filter(
        (filePath) => filePath.startsWith("src/") && filePath.endsWith(".d.ts"),
      ).length;
      const markdownPaths = [...packedPaths].filter((filePath) =>
        filePath.toLowerCase().endsWith(".md"),
      );
      const deadLinks = [];
      const missingTargets = [];
      const linkPattern = /\]\(\s*(?:<([^>\r\n]*)>|((?:\\.|[^)\s])+))(?:\s+[^)]*)?\s*\)/g;

      const isPacked = (targetPath) => {
        if (packedPaths.has(targetPath)) return true;
        const prefix = `${targetPath.replace(/\/+$/, "")}/`;
        return [...packedPaths].some((filePath) => filePath.startsWith(prefix));
      };

      for (const markdownPath of markdownPaths) {
        const source = readFileSync(path.join(root, markdownPath), "utf8");
        linkPattern.lastIndex = 0;
        for (const match of source.matchAll(linkPattern)) {
          let target = (match[1] ?? match[2]).replaceAll("\\ ", " ").trim();
          if (!target || target.startsWith("#") || /^(?:https?:\/\/|mailto:)/i.test(target)) {
            continue;
          }
          if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;

          target = target.split(/[?#]/, 1)[0];
          if (!target) continue;
          try {
            target = decodeURIComponent(target);
          } catch {
            // Keep malformed percent sequences as literal path characters.
          }

          const repositoryPath = path.posix.normalize(
            target.startsWith("/")
              ? target.replace(/^\/+/, "")
              : path.posix.join(path.posix.dirname(markdownPath), target),
          );
          const absolutePath = path.resolve(root, repositoryPath);
          const relativePath = path.relative(root, absolutePath);
          if (
            relativePath === ".." ||
            relativePath.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativePath)
          ) {
            continue;
          }

          const line = source.slice(0, match.index).split("\n").length;
          if (!existsSync(absolutePath)) {
            missingTargets.push(
              `${markdownPath}:${line} → target absent from repository: ${target}`,
            );
            continue;
          }

          if (!isPacked(repositoryPath)) {
            deadLinks.push(`${markdownPath}:${line} → dead link ${match[1] ?? match[2]}`);
          }
        }
      }

      if (deadLinks.length > 0) {
        console.error(`pack-link-check: ${deadLinks.length} dead link(s) target files omitted from the npm tarball:`);
        for (const deadLink of deadLinks) console.error(`  ${deadLink}`);
        exitCode = 1;
      } else {
        console.log(
          `pack-link-check: OK — ${markdownPaths.length} packaged Markdown files have no links to omitted repository files`,
        );
      }

      if (missingTargets.length > 0) {
        console.warn(
          `pack-link-check: warn — ${missingTargets.length} link target(s) absent from the repository:`,
        );
        for (const missingTarget of missingTargets) console.warn(`  ${missingTarget}`);
        console.warn(
          "pack-link-check: 这类目标在仓库中不存在，请确认是有意为之还是链接写错。",
        );
      }

      // test/contract/ 发布面对账（issue #505）：红只影响退出码，不掩盖上面已报过的错。
      if (checkContractPublishSurface({ root, packedPaths }) !== 0) exitCode = 1;
    }
  }

  return { exitCode, packedDeclarationCount };
}

/**
 * 门禁入口：跑 pack、判定 tarball 内 Markdown 链接闭合，并**无论结果如何**回收
 * 本次 `prepack` 新生成的 `src/` 下 `.d.ts`（issue #268）；回收之后再做
 * 「文档声称的随包声明数 == 随包清单里的声明数」对账（工单 261021-03 任务 A）。
 *
 * 三条不变量：
 *   1. 跑前已存在的 `.d.ts` 一个都不删（可能是有意 `npm run types:build` 留下的）。
 *   2. 原始失败以非零退出码原样传出；回收逻辑既不吞它，也不把它换成别的错。
 *      `runPack` 之外抛出的异常同样照常往外传（回收在 `finally` 里已经跑完）。
 *   3. 声称对账挂在回收之后：它只读已经拿到的 pack 清单与回收清点，**不会为了数数再跑一次 tsc**。
 *
 * @param {{ root?: string, runPack?: (params: { cwd: string }) => object }} params
 * @returns {number} 0 = 通过；1 = 失败
 */
export function checkPackLinks({ root = ROOT, runPack = runNpmPackDryRun } = {}) {
  const declarationsBefore = listDeclarationFiles(root);
  let exitCode;
  let packedDeclarationCount = null;
  let reclaim = undefined;
  try {
    const evaluated = evaluatePackLinks({ root, runPack });
    exitCode = evaluated.exitCode;
    packedDeclarationCount = evaluated.packedDeclarationCount;
  } finally {
    // `exitCode === undefined` 只可能是 evaluatePackLinks 抛了错：异常继续往外传，
    // 这里赋的值不会被读到（回收仍然跑完）。
    reclaim = reclaimDeclarations(root, declarationsBefore);
    exitCode = exitCode === undefined ? reclaim.code : exitCode || reclaim.code;
  }
  // 对账的失败同样以 1 传出，但不会掩盖上面已经报过的错（两条判据各自打各自的那行）。
  return exitCode || checkDeclarationClaims({ root, packedDeclarationCount, reclaim });
}

// ────────────────────────── --self-test（issue #505） ──────────────────────────
//
// 反向证口径与 `test-hygiene-check --self-test` / `docs-drift-check --self-test` 同族：同一套判据
// 跑在**内存夹具**上（不落盘、不跑 npm pack、不联网）—— 改坏 ⇒ 红、干净 ⇒ 绿、登记表空转 ⇒ 红，
// **变异没落上也算红**（#210 R2 的约定）。最后一例跑在**本仓真树**上（packed 取 `files` 条目），
// 用它证明真登记表没有空转条目——它只读 `package.json` 与 `test/contract/` 的实物，不跑 pack。

const MIN_SELF_TEST_CASES = 15;

/** 基准夹具：形状对齐真树（`files` 逐个列举 `test/contract/*.js`，`doc-examples.js` 登记豁免、不在 `files` 里）。 */
function contractFixture(overrides = {}) {
  return {
    files: [
      "src",
      "bin",
      "test/contract/assembly-port.js",
      "test/contract/index.js",
      "test/helpers/tmp.js",
    ],
    diskFiles: [
      "test/contract/assembly-port.js",
      "test/contract/assembly-port.test.js",
      "test/contract/doc-examples.js",
      "test/contract/doc-examples.test.js",
      "test/contract/index.js",
    ],
    diskDirs: ["test/contract"],
    packedPaths: new Set([
      "src/index.js",
      "test/contract/assembly-port.js",
      "test/contract/index.js",
      "test/helpers/tmp.js",
    ]),
    exemptions: [
      {
        path: "test/contract/doc-examples.js",
        why: "夹具：只被 doc-examples.test.js 用，宿主不需要，所以不发布",
      },
    ],
    maxExemptions: 1,
    scriptCommands: {
      test: "node --test",
      "check:docs-examples": "node --test test/contract/doc-examples.test.js",
    },
    ...overrides,
  };
}

/** 变异：从数组里删掉一项。靶子不在 ⇒ 抛错（**变异没落上也算红**）。 */
function withoutItem(list, target) {
  const next = [...list];
  const index = next.indexOf(target);
  if (index < 0) {
    throw new Error(`变异没落上：${JSON.stringify(target)} 不在 ${JSON.stringify(list)} 里`);
  }
  next.splice(index, 1);
  return next;
}

/** 变异：往集合里添一项（靶子已在集合里 ⇒ 抛错：变异等于没做）。 */
function withPacked(packed, item) {
  if (packed.has(item)) throw new Error(`变异没落上：${item} 已在 tarball 清单里`);
  const next = new Set(packed);
  next.add(item);
  return next;
}

const SELF_TEST_CASES = [
  {
    name: "干净夹具 ⇒ 绿（判据 1/2 都不红，判据 3 打印 2 个 *.test.js + 1 条已登记豁免）",
    build: () => contractFixture(),
    expectGreen: true,
    expectTestFileLines: 2,
    expectExemptionLines: 1,
    expectLines: [
      /assembly-port\.test\.js：不随包发布.*node --test 套件.*npm test/,
      /doc-examples\.test\.js：不随包发布.*npm run check:docs-examples/,
      /doc-examples\.js：已登记豁免（不随包）——夹具/,
    ],
  },
  {
    name: "从 files 里删一条真实存在的 test/contract/*.js ⇒ 判据 1 红并点名该文件",
    // 真实的「忘了加进 files」= 清单与包里都没有它：两边一起删（只改 files 不改 pack 清单是假变异）。
    build: () => {
      const base = contractFixture();
      const packed = new Set(base.packedPaths);
      packed.delete("test/contract/assembly-port.js");
      return contractFixture({
        files: withoutItem(base.files, "test/contract/assembly-port.js"),
        packedPaths: packed,
      });
    },
    expect: [/test\/contract\/assembly-port\.js 在磁盘上、却不在 npm tarball 清单里（也没登记豁免）/],
    expectCount: 1,
  },
  {
    name: "往 files 里加一条不存在的 test/contract/ghost.js ⇒ 判据 2 红并点名（死条目）",
    build: () => contractFixture({ files: [...contractFixture().files, "test/contract/ghost.js"] }),
    expect: [/files 里列的 test\/contract\/ghost\.js 在磁盘上不存在——死条目/],
    expectCount: 1,
  },
  {
    name: "变异没落上也算红：删一个不在 files 里的靶子 ⇒ 夹具构建就该抛错",
    build: () => contractFixture({
      files: withoutItem(contractFixture().files, "test/contract/does-not-exist.js"),
    }),
    expectMutationMiss: true,
  },
  {
    name: "磁盘上新增一个未登记的 harness（test/contract/new-harness.js）⇒ 判据 1 红并点名",
    build: () => contractFixture({
      diskFiles: [...contractFixture().diskFiles, "test/contract/new-harness.js"],
    }),
    expect: [/test\/contract\/new-harness\.js 在磁盘上、却不在 npm tarball 清单里/],
    expectCount: 1,
  },
  {
    name: "登记表空转：登记的文件从磁盘消失 ⇒ 红",
    build: () => contractFixture({
      diskFiles: withoutItem(contractFixture().diskFiles, "test/contract/doc-examples.js"),
    }),
    expect: [/豁免登记项 test\/contract\/doc-examples\.js 在磁盘上不存在——空转条目/],
    expectCount: 1,
  },
  {
    name: "登记表过期：登记的文件已经随包 ⇒ 红（两个说法不能同时成立）",
    build: () => contractFixture({
      packedPaths: withPacked(contractFixture().packedPaths, "test/contract/doc-examples.js"),
    }),
    expect: [/豁免登记项 test\/contract\/doc-examples\.js 已经出现在 tarball 清单里——它其实随包了/],
    expectCount: 1,
  },
  {
    name: "登记表缺理由：why 只有空白 ⇒ 红（「宿主不需要」这种结论不算理由）",
    build: () => contractFixture({
      exemptions: [{ path: "test/contract/doc-examples.js", why: "   " }],
    }),
    expect: [/豁免登记项 test\/contract\/doc-examples\.js 的 why 为空/],
    expectCount: 1,
  },
  {
    name: "登记项 path 写成目录（test/contract/）⇒ 红",
    build: () => contractFixture({
      diskFiles: withoutItem(contractFixture().diskFiles, "test/contract/doc-examples.js"),
      exemptions: [{ path: "test/contract/", why: "x" }],
    }),
    expect: [/豁免登记项 "test\/contract\/" 不是 test\/contract\/ 下的具体文件路径/],
    expectCount: 1,
  },
  {
    name: "登记项 path 在别的目录（test/helpers/tmp.js）⇒ 红",
    build: () => contractFixture({
      diskFiles: withoutItem(contractFixture().diskFiles, "test/contract/doc-examples.js"),
      exemptions: [{ path: "test/helpers/tmp.js", why: "x" }],
    }),
    expect: [/豁免登记项 "test\/helpers\/tmp\.js" 不是 test\/contract\/ 下的具体文件路径/],
    expectCount: 1,
  },
  {
    name: "登记表想长到 2 条（第二份 harness 不搬走就加豁免）⇒ 红并提示「先问该不该放进发布面目录」",
    build: () => contractFixture({
      exemptions: [
        ...contractFixture().exemptions,
        { path: "test/contract/assembly-port.test.js", why: "第二份" },
      ],
    }),
    expect: [/CONTRACT_PUBLISH_EXEMPTIONS 有 2 条，上限 1 条.*先问「该不该放进发布面目录」/],
    expectCount: 1,
  },
  {
    name: "登记表反向：条目删了却没降上限（余量）⇒ 红",
    build: () => contractFixture({
      diskFiles: withoutItem(contractFixture().diskFiles, "test/contract/doc-examples.js"),
      exemptions: [],
      maxExemptions: 1,
    }),
    expect: [/CONTRACT_PUBLISH_EXEMPTIONS 只剩 0 条，而上限（= 期望值）是 1 条/],
    expectCount: 1,
  },
  {
    name: "files 里列目录 test/contract 不算死条目 ⇒ 绿",
    build: () => contractFixture({ files: [...contractFixture().files, "test/contract"] }),
    expectGreen: true,
    expectTestFileLines: 2,
  },
  {
    name: "树里没有 files 数组（合成夹具 / 非本仓）⇒ 不适用，不判红",
    build: () => contractFixture({ files: undefined }),
    expectNotApplicable: true,
  },
  {
    name: "只有 *.test.js 的树 ⇒ 绿，且逐条打印「不随包发布」+ 谁跑它（判据 3 不红）",
    build: () => contractFixture({
      files: ["src"],
      diskFiles: ["test/contract/index.test.js", "test/contract/doc-examples.test.js"],
      packedPaths: new Set(["src/index.js"]),
      exemptions: [],
      maxExemptions: 0,
    }),
    expectGreen: true,
    expectTestFileLines: 2,
    expectLines: [
      /index\.test\.js：不随包发布.*npm test（node --test 自动发现 \*\.test\.js）/,
      /doc-examples\.test\.js：不随包发布.*npm run check:docs-examples/,
    ],
  },
  {
    name: "本仓真树 + 真登记表（packed 取 files 条目，不跑 npm）⇒ 绿：登记表没有空转条目",
    build: () => {
      const facts = readContractSurfaceFacts(ROOT);
      if (!facts) throw new Error(`变异没落上：${ROOT} 下读不到 package.json`);
      return {
        files: facts.manifest.files,
        diskFiles: facts.diskFiles,
        diskDirs: facts.diskDirs,
        packedPaths: new Set(facts.manifest.files),
        exemptions: CONTRACT_PUBLISH_EXEMPTIONS,
        maxExemptions: CONTRACT_PUBLISH_EXEMPTION_MAX,
        scriptCommands: facts.manifest.scripts ?? {},
      };
    },
    expectGreen: true,
    expectTestFileLinesAtLeast: 1,
    expectExemptionLines: 1,
    expectLines: [/不随包发布.*这是有意为之，不是漏包/],
  },
];

/** `--self-test` 入口：内存夹具上的反向证；任何一例未达预期就 exit 1。 */
function runSelfTest() {
  const failures = [];
  const passed = [];
  console.log(
    "pack-link-check --self-test：test/contract/ 发布面判据三口的内存反向证"
    + "（改坏 → 红、干净 → 绿、登记表空转 → 红；变异没落上也算失败）",
  );
  if (SELF_TEST_CASES.length < MIN_SELF_TEST_CASES) {
    failures.push(
      `用例数被削：现在 ${SELF_TEST_CASES.length} 例，下限 ${MIN_SELF_TEST_CASES} 例——删用例 / 整例跳过不算修好`,
    );
  }
  for (const [index, testCase] of SELF_TEST_CASES.entries()) {
    const who = `[${index + 1}] ${testCase.name}`;
    let fixture;
    try {
      fixture = testCase.build();
    } catch (error) {
      if (testCase.expectMutationMiss) {
        passed.push(`${who} → 变异没落上（按预期算红）：${error.message}`);
      } else {
        failures.push(`${who}：构建夹具时抛错（变异没落上？）：${error.message}`);
      }
      continue;
    }
    if (testCase.expectMutationMiss) {
      failures.push(`${who}：这一例要的就是「变异打不上」，结果打上了——靶子已存在，换一个不存在的靶子`);
      continue;
    }

    const verdict = evaluateContractSurface(fixture);
    const lines = [...verdict.testFileLines, ...verdict.exemptionLines];

    if (testCase.expectNotApplicable) {
      if (verdict.applicable) {
        failures.push(`${who}：本该判为「不适用」，实测 applicable=true`);
      } else if (verdict.errors.length > 0) {
        failures.push(`${who}：不适用时不该有红：${verdict.errors.join(" ; ")}`);
      } else {
        passed.push(`${who} → 不适用（0 红）`);
      }
      continue;
    }

    if (testCase.expectGreen) {
      if (verdict.errors.length > 0) {
        failures.push(`${who}：本该绿，实测 ${verdict.errors.length} 处红：\n      ${verdict.errors.join("\n      ")}`);
        continue;
      }
      if (testCase.expectTestFileLines !== undefined && verdict.testFileLines.length !== testCase.expectTestFileLines) {
        failures.push(`${who}：判据 3 应打印 ${testCase.expectTestFileLines} 行，实测 ${verdict.testFileLines.length} 行`);
        continue;
      }
      if (testCase.expectTestFileLinesAtLeast !== undefined
        && verdict.testFileLines.length < testCase.expectTestFileLinesAtLeast) {
        failures.push(
          `${who}：判据 3 至少该打印 ${testCase.expectTestFileLinesAtLeast} 行，实测 ${verdict.testFileLines.length} 行`,
        );
        continue;
      }
      if (testCase.expectExemptionLines !== undefined
        && verdict.exemptionLines.length !== testCase.expectExemptionLines) {
        failures.push(
          `${who}：豁免打印应 ${testCase.expectExemptionLines} 行，实测 ${verdict.exemptionLines.length} 行`,
        );
        continue;
      }
      const missedLines = (testCase.expectLines ?? []).filter((re) => !lines.some((line) => re.test(line)));
      if (missedLines.length > 0) {
        failures.push(
          `${who}：绿了，但打印行不是该有的形状（未命中 ${missedLines.map(String).join(" ; ")}）`
          + `\n      实测：${lines.join("\n      ")}`,
        );
        continue;
      }
      passed.push(`${who} → 0 处红（判据 3 打印 ${verdict.testFileLines.length} 行、豁免 ${verdict.exemptionLines.length} 行）`);
      continue;
    }

    if (verdict.errors.length === 0) {
      failures.push(`${who}：改了但没红（判据被改坏 / 这一格已失守）`);
      continue;
    }
    if (testCase.expectCount !== undefined && verdict.errors.length !== testCase.expectCount) {
      failures.push(
        `${who}：红了 ${verdict.errors.length} 处，期望 ${testCase.expectCount} 处：\n      ${verdict.errors.join("\n      ")}`,
      );
      continue;
    }
    const missed = (testCase.expect ?? []).filter((re) => !verdict.errors.some((error) => re.test(error)));
    if (missed.length > 0) {
      failures.push(
        `${who}：红了，但报的不是该报的形状（未命中 ${missed.map(String).join(" ; ")}）`
        + `\n      实测：${verdict.errors.join("\n      ")}`,
      );
      continue;
    }
    passed.push(`${who} → ${verdict.errors.length} 处红（已点名）`);
  }

  for (const line of passed) console.log(`  ✓ ${line}`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  if (failures.length > 0) {
    console.log(`pack-link-check --self-test: 失败 — ${failures.length} 处未达预期（共 ${SELF_TEST_CASES.length} 例）`);
    process.exit(1);
  }
  console.log(
    `pack-link-check --self-test: OK — ${SELF_TEST_CASES.length} 例反向证/放行证全部按预期`
    + "（内存夹具 + 本仓真树；不跑 npm pack、不联网、不写盘）",
  );
}

/** 只有被当作命令直接跑（`node scripts/pack-link-check.mjs`）才执行门禁；被 import 时零副作用。 */
function isCliInvocation() {  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(SELF_PATH);
  } catch {
    return false;
  }
}

if (SELF_TEST) {
  runSelfTest();
  process.exit(0);   // 自测只跑内存夹具 + 本仓实物，不跑 npm pack、不写盘
}

if (isCliInvocation()) {
  process.exitCode = checkPackLinks();
}
