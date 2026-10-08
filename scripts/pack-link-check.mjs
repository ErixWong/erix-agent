#!/usr/bin/env node
// Blocking npm-tarball Markdown link closure check. Unlike docs-sync-check.mjs,
// which only warns (exit 0 by default) about EN/CN contract heading alignment,
// this checks every packed Markdown file against npm's actual dry-run file list.
// Links whose targets are already absent from the repository are pre-existing
// broken links, not package omissions, and are left for the final report.

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
          path.isAbsolute(relativePath) ||
          !existsSync(absolutePath)
        ) {
          continue;
        }

        if (!isPacked(repositoryPath)) {
          const line = source.slice(0, match.index).split("\n").length;
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
  }
}
