import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { autoCaptureKey, candidateLines } from "./auto-capture.js";
import { looksLikeCredential } from "../skills/notes/credential-patterns.mjs";
import { validateResourceStore } from "../src/store/resource.js";

async function reportResourceStoreReadFailure(error, reference, diagnostics) {
  const event = {
    type: "resource_store_error",
    operation: "get",
    phase: "capture_stub",
    fatal: false,
    locator: reference?.locator,
    error: {
      name: String(error?.name ?? "Error"),
      message: String(error?.message ?? error),
    },
  };
  console.error(`ResourceStore get failed during capture_stub: ${event.error.message}`);
  if (typeof diagnostics?.error === "function") await diagnostics.error(event);
}

async function captureStubForResult(block, resourceStore, diagnostics) {
  const reference = block?.artifact && typeof block.artifact === "object"
    ? block.artifact
    : block;
  const archivePath = typeof reference?.archivePath === "string"
    ? reference.archivePath
    : undefined;
  const display = resourceStore === undefined
    ? reference?.display ?? archivePath ?? reference?.artifactId ?? "<resource>"
    : reference?.display ?? "ResourceStore 中的 opaque locator";
  let output = "";
  if (resourceStore !== undefined && archivePath === undefined && reference?.locator !== undefined) {
    try {
      const stored = await resourceStore.get(reference.locator);
      output = typeof stored === "string" ? stored : Buffer.from(stored).toString("utf8");
    } catch (error) {
      await reportResourceStoreReadFailure(error, reference, diagnostics);
    }
  } else if (archivePath) {
    const metadataPath = archivePath.endsWith(".txt")
      ? `${archivePath.slice(0, -".txt".length)}.meta.json`
      : `${archivePath}.meta.json`;
    try {
      const manifest = JSON.parse(await readFile(metadataPath, "utf8"));
      if (manifest?.replayable === false && manifest.archivePath === archivePath) {
        try {
          output = await readFile(archivePath, "utf8");
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      } else if (resourceStore !== undefined && reference?.locator !== undefined) {
        try {
          const stored = await resourceStore.get(reference.locator);
          output = typeof stored === "string" ? stored : Buffer.from(stored).toString("utf8");
        } catch (error) {
          await reportResourceStoreReadFailure(error, reference, diagnostics);
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const safeCandidates = candidateLines(output).filter(({ label, value }) => (
    !looksLikeCredential(label, value)
  ));
  if (safeCandidates.length > 0 && display) {
    const lines = safeCandidates
      .slice(0, 3)
      .map(({ label, value }) => `${label}=${value}`);
    const prefix = "[已折叠] 本命令不可重放；值：";
    const suffix = `；原文：${display}`;
    let result = `${prefix}${lines.join("；")}${suffix}`;
    if (Array.from(result).length > 200) {
      const available = Math.max(0, 200 - Array.from(`${prefix}${suffix}`).length - 1);
      const bounded = Array.from(lines.join("；")).slice(0, available).join("");
      result = `${prefix}${bounded}${suffix}`;
    }
    return Array.from(result).slice(0, 200).join("");
  }
  return `[已折叠] 原文：${display}（不可重放）`.slice(0, 200);
}

export async function buildCaptureStub(message, resourceStore, diagnostics) {
  const results = Array.isArray(message?.content)
    ? message.content.filter((block) => (
      block?.type === "tool_result" && block.replayable === false
    ))
    : [];
  const stubs = [];
  for (const result of results) {
    stubs.push(await captureStubForResult(result, resourceStore, diagnostics));
  }
  return [...new Set(stubs)].join("\n");
}

export function archiveSourceTarget(capture) {
  const display = String(capture?.display ?? "");
  if (capture?.legacy === true) {
    return display || path.basename(String(capture?.archivePath ?? ""));
  }
  if (display) return `resource:${display}`;
  return String(capture?.artifact?.artifactId ?? "");
}

export async function readCaptureManifests(archiveDir) {
  if (typeof archiveDir !== "string" || archiveDir.length === 0) {
    return { manifests: [], warnings: [] };
  }
  const root = path.resolve(archiveDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { manifests: [], warnings: [] };
    throw error;
  }
  const manifests = [];
  const warnings = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (
      (!entry.isFile() && !entry.isSymbolicLink())
      || !entry.name.endsWith(".meta.json")
    ) continue;
    const manifestPath = path.join(root, entry.name);
    try {
      const stat = await lstat(manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("capture manifest 不是普通文件或是符号链接");
      }
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest?.replayable === true) continue;
      manifests.push({ manifest, manifestPath });
    } catch (error) {
      warnings.push(`${manifestPath}: ${error?.message ?? String(error)}`);
      manifests.push({ manifest: null, manifestPath });
    }
  }
  return { manifests, warnings };
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== ""
    && !relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative);
}

async function readArtifact(reference, archiveDir, manifestPath, resourceStore) {
  if (typeof archiveDir !== "string" || archiveDir.length === 0) {
    throw new Error("缺少本 run 归档根目录");
  }
  if (reference?.kind !== "erix.tool-capture" || reference?.schemaVersion !== 1) {
    throw new Error("不是 CLI capture manifest");
  }
  if (reference.truncated !== false) throw new Error("归档已截断，不可用于核验");
  if (reference.replayable !== false) throw new Error("可重放归档不可用于 provenance 核验");
  if (typeof reference.digest !== "string" || !/^[a-f0-9]{64}$/iu.test(reference.digest)) {
    throw new Error("capture manifest 缺少有效 digest");
  }
  if (reference.archivePath !== undefined && (
    !reference.locator
      || !Number.isSafeInteger(reference.locator.lineStart)
      || !Number.isSafeInteger(reference.locator.lineEnd)
      || reference.locator.lineStart < 1
      || reference.locator.lineEnd < reference.locator.lineStart
  )) {
    throw new Error("locator 行范围无效");
  }
  let content;
  if (reference.archivePath === undefined) {
    if (resourceStore === undefined) throw new Error("缺少 ResourceStore，无法读取 opaque locator");
    const stored = await resourceStore.get(reference.locator);
    content = typeof stored === "string" ? stored : Buffer.from(stored).toString("utf8");
  } else {
    const resolvedRoot = path.resolve(archiveDir);
    const resolvedPath = path.resolve(reference.archivePath);
    const expectedPath = manifestPath.slice(0, -".meta.json".length) + ".txt";
    if (resolvedPath !== expectedPath) throw new Error("capture manifest 与同名归档不匹配");
    if (!isWithin(resolvedRoot, resolvedPath)) {
      throw new Error("归档不在本 run 归档根目录内");
    }
    const rootRealPath = await realpath(resolvedRoot);
    const stat = await lstat(resolvedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("归档路径不是普通文件或是符号链接");
    }
    const artifactRealPath = await realpath(resolvedPath);
    if (!isWithin(rootRealPath, artifactRealPath)) {
      throw new Error("归档路径经 realpath 后逃逸本 run 归档根目录");
    }
    content = await readFile(artifactRealPath, "utf8");
  }
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  if (digest !== reference.digest) throw new Error("归档 digest 不匹配");
  if (reference.archivePath === undefined) return content;
  return content
    .replaceAll(/\r\n|\r/gu, "\n")
    .split("\n")
    .slice(reference.locator.lineStart - 1, reference.locator.lineEnd)
    .join("\n");
}

export async function inspectRun({ archiveDir, resourceStore }) {
  const loaded = await readCaptureManifests(archiveDir);
  const captures = [];
  const warnings = [...loaded.warnings];
  let readableArtifacts = 0;
  for (const { manifest: reference, manifestPath } of loaded.manifests) {
    if (!reference) continue;
    try {
      const output = await readArtifact(
        reference,
        archiveDir,
        manifestPath,
        resourceStore === undefined ? undefined : validateResourceStore(resourceStore),
      );
      readableArtifacts += 1;
      const candidates = candidateLines(output);
      if (candidates.length === 0) {
        warnings.push(`${reference.archivePath}: 未抽取到可核验值`);
        continue;
      }
      captures.push(...candidates.map((candidate) => ({
        ...candidate,
        archivePath: reference.archivePath,
        ...(typeof reference.display === "string" ? { display: reference.display } : {}),
        ...(reference.archivePath === undefined ? {} : { legacy: true }),
        artifact: reference,
        round: reference.round ?? null,
        key: autoCaptureKey(reference.command, reference),
      })));
    } catch (error) {
      warnings.push(
        `${reference.archivePath ?? reference.display ?? manifestPath}: ${error?.message ?? String(error)}`,
      );
    }
  }
  const seenLabels = new Set();
  for (const capture of captures) {
    capture.first = !seenLabels.has(capture.label);
    seenLabels.add(capture.label);
  }
  return {
    references: loaded.manifests,
    captures,
    warnings,
    readableArtifacts,
  };
}
