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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listDeclarationFiles, reclaimGeneratedDeclarations } from "./generated-declarations.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF_PATH), "..");

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
 * @returns {number} 0 = 没什么要收的或全部收干净；1 = 有文件删不掉
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
    return 1;
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
  return result.failed.length > 0 ? 1 : 0;
}

/** 链接闭合判定本身（不含生成物回收）。返回退出码。 */
function evaluatePackLinks({ root, runPack }) {
  let pack;
  try {
    pack = runPack({ cwd: root });
  } catch (error) {
    // 跑不动 pack：原始错误信息原样传出，退出码 1（不换成别的错，也不吞掉）
    console.error(`pack-link-check: failed to run npm pack: ${error.message}`);
    return 1;
  }

  let exitCode = 0;

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
    }
  }

  return exitCode;
}

/**
 * 门禁入口：跑 pack、判定 tarball 内 Markdown 链接闭合，并**无论结果如何**回收
 * 本次 `prepack` 新生成的 `src/` 下 `.d.ts`（issue #268）。
 *
 * 两条不变量：
 *   1. 跑前已存在的 `.d.ts` 一个都不删（可能是有意 `npm run types:build` 留下的）。
 *   2. 原始失败以非零退出码原样传出；回收逻辑既不吞它，也不把它换成别的错。
 *      `runPack` 之外抛出的异常同样照常往外传（回收在 `finally` 里已经跑完）。
 *
 * @param {{ root?: string, runPack?: (params: { cwd: string }) => object }} params
 * @returns {number} 0 = 通过；1 = 失败
 */
export function checkPackLinks({ root = ROOT, runPack = runNpmPackDryRun } = {}) {
  const declarationsBefore = listDeclarationFiles(root);
  let exitCode;
  try {
    exitCode = evaluatePackLinks({ root, runPack });
  } finally {
    // `exitCode === undefined` 只可能是 evaluatePackLinks 抛了错：异常继续往外传，
    // 这里赋的值不会被读到（回收仍然跑完）。
    const cleanupCode = reclaimDeclarations(root, declarationsBefore);
    exitCode = exitCode === undefined ? cleanupCode : exitCode || cleanupCode;
  }
  return exitCode;
}

/** 只有被当作命令直接跑（`node scripts/pack-link-check.mjs`）才执行门禁；被 import 时零副作用。 */
function isCliInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(SELF_PATH);
  } catch {
    return false;
  }
}

if (isCliInvocation()) {
  process.exitCode = checkPackLinks();
}
