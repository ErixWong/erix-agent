#!/usr/bin/env node
// generated-declarations.mjs —— `src/**/*.d.ts` **生成物**的清点与回收（issue #268）
//
// 为什么需要它：`prepack` 钩子（`package.json`）会跑 `scripts/build-types.mjs`，把约 61 个 `.d.ts`
// 直接写进 `src/` 且**不回收**。任何在仓内跑 `npm pack` 的门禁（`check:pack-links`、`check:release`）
// 都会把这些生成物留在工作树里；而 `scripts/type-check-ratchet.mjs` 的陈旧声明守卫（issue #214）
// 见到在场的 `.d.ts` 必须硬失败——于是两个门禁互相投毒（issue #268）。
//
// 语义（本模块的全部口径，只有一条）：**只回收「跑之前不存在、跑之后出现」的那些**。
// 跑之前就在场的 `.d.ts` 一律不动 —— 它们可能是开发者有意 `npm run types:build` 留下的，
// 也可能是上一条命令的产物，删别人的文件不是本模块的权限。
//
// 零依赖：只用 `node:` 内置；被 `scripts/*.mjs` 以相对路径 import，不进 npm 包（`files` 白名单没 scripts/）。

import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * 清点 `<root>/src` 下所有 `.d.ts`（递归，**不跟随符号链接**：断链不炸、环不递归）。
 *
 * @param {string} root 仓库根（绝对路径）
 * @returns {string[]} 绝对路径，已排序（同一次跑内两次调用的结果可直接做集合差）
 */
export function listDeclarationFiles(root) {
  const srcDir = path.join(root, "src");
  const found = [];
  if (!existsSync(srcDir)) return found;

  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        continue; // 竞态：清点过程中文件消失，当作不在场
      }
      if (stat.isDirectory()) walk(abs);
      else if (name.endsWith(".d.ts")) found.push(abs);
    }
  };
  walk(srcDir);
  return found.sort();
}

/**
 * 回收「上次清点之后新出现的」`.d.ts`，**保留上次清点时就已存在的那些**。
 *
 * 单个文件删不掉（权限/正被占用）不会抛出：它进 `failed`，由调用方决定退出码——
 * 本模块的失败永远不许盖住调用方自己的原始失败。
 *
 * @param {{ root: string, before: Iterable<string> }} params `before` = 跑前的 `listDeclarationFiles()` 结果
 * @returns {{ removed: string[], failed: string[], kept: number }}
 *   `removed` / `failed` 是相对 `root` 的 posix 路径（给人看的）；`kept` = 跑前已存在、本次没动的数量
 */
export function reclaimGeneratedDeclarations({ root, before }) {
  const seen = new Set(before);
  const after = listDeclarationFiles(root);
  const generated = after.filter((abs) => !seen.has(abs));

  const removed = [];
  const failed = [];
  for (const abs of generated) {
    try {
      rmSync(abs, { force: true });
      removed.push(path.relative(root, abs).split(path.sep).join("/"));
    } catch (error) {
      failed.push(
        `${path.relative(root, abs).split(path.sep).join("/")}（${error.message}）`,
      );
    }
  }

  return { removed, failed, kept: after.length - generated.length };
}
