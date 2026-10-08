#!/usr/bin/env node
// npm-tarball Markdown link closure check. A link to a repository file omitted
// from the tarball is blocking (exit 1); a link whose target is absent from the
// repository is reported as a warning and does not change the exit code.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const pack = spawnSync(npmCommand, ["pack", "--dry-run", "--json"], {
  cwd: ROOT,
  encoding: "utf8",
  windowsHide: true,
  shell: process.platform === "win32",
});

if (pack.error) {
  console.error(`pack-link-check: failed to run npm pack: ${pack.error.message}`);
  process.exitCode = 1;
} else if (pack.status !== 0) {
  console.error(`pack-link-check: npm pack failed (exit ${pack.status})`);
  if (pack.stderr.trim()) console.error(pack.stderr.trim());
  process.exitCode = 1;
} else {
  let packInfo;
  try {
    packInfo = JSON.parse(pack.stdout);
  } catch (error) {
    console.error(`pack-link-check: could not parse npm pack JSON: ${error.message}`);
    process.exitCode = 1;
  }

  const listedFiles = packInfo?.[0]?.files;
  if (process.exitCode !== 1 && !Array.isArray(listedFiles)) {
    console.error("pack-link-check: npm pack JSON did not include a files array");
    process.exitCode = 1;
  }

  if (process.exitCode !== 1) {
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
      const source = readFileSync(path.join(ROOT, markdownPath), "utf8");
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
        const absolutePath = path.resolve(ROOT, repositoryPath);
        const relativePath = path.relative(ROOT, absolutePath);
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
      process.exitCode = 1;
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
