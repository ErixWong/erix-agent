import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { candidateLines } from "./auto-capture.js";
import { normalizedLabel } from "../skills/notes/credential-patterns.mjs";

const ASSIGNMENT_PATTERN =
  /(?:^|[\s\u3000([{'"，。；;：:])([^:=\s][^:=\s]{0,80}?)\s*=\s*([^\s,，。；;）)\]}]+)/gu;
const STRUCTURED_METADATA_LABELS = new Set([
  "lineStart",
  "lineEnd",
  "digest",
  "toolUseId",
  "artifactId",
  "archivePath",
  "locator",
  "round",
  "originalBytes",
  "truncated",
  "replayable",
  "schemaVersion",
  "kind",
].map((label) => normalizedLabel(label)));

function warningMessage(message) {
  return `finalGuard warning: ${message}`;
}

function explicitAssignments(text) {
  const candidates = [];
  for (const match of String(text ?? "").matchAll(ASSIGNMENT_PATTERN)) {
    const label = normalizedLabel(match[1]);
    const value = match[2].trim();
    if (label && value && !STRUCTURED_METADATA_LABELS.has(label)) {
      candidates.push({ label, value });
    }
  }
  return candidates;
}

async function readCaptureManifests(archiveDir) {
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
  for (const entry of entries) {
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

async function readArtifact(reference, archiveDir, manifestPath) {
  if (typeof archiveDir !== "string" || archiveDir.length === 0) {
    throw new Error("缺少本 run 归档根目录");
  }
  if (reference?.kind !== "erix.tool-capture" || reference?.schemaVersion !== 1) {
    throw new Error("不是 CLI capture manifest");
  }
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
  if (reference.truncated !== false) throw new Error("归档已截断，不可用于核验");
  if (reference.replayable !== false) throw new Error("可重放归档不可用于 provenance 核验");
  if (typeof reference.digest !== "string" || !/^[a-f0-9]{64}$/iu.test(reference.digest)) {
    throw new Error("capture manifest 缺少有效 digest");
  }
  if (
    !reference.locator
    || !Number.isSafeInteger(reference.locator.lineStart)
    || !Number.isSafeInteger(reference.locator.lineEnd)
    || reference.locator.lineStart < 1
    || reference.locator.lineEnd < reference.locator.lineStart
  ) {
    throw new Error("locator 行范围无效");
  }
  const content = await readFile(artifactRealPath, "utf8");
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  if (digest !== reference.digest) throw new Error("归档 digest 不匹配");
  return content
    .replaceAll(/\r\n|\r/gu, "\n")
    .split("\n")
    .slice(reference.locator.lineStart - 1, reference.locator.lineEnd)
    .join("\n");
}

async function inspectRun({ archiveDir }) {
  const loaded = await readCaptureManifests(archiveDir);
  const values = [];
  const warnings = [...loaded.warnings];
  let readableArtifacts = 0;
  for (const { manifest: reference, manifestPath } of loaded.manifests) {
    if (!reference) continue;
    try {
      const output = await readArtifact(reference, archiveDir, manifestPath);
      readableArtifacts += 1;
      const candidates = candidateLines(output);
      if (candidates.length === 0) {
        warnings.push(`${reference.archivePath}: 未抽取到可核验值`);
        continue;
      }
      values.push(...candidates.map((candidate) => ({
        ...candidate,
        archivePath: reference.archivePath,
      })));
    } catch (error) {
      warnings.push(`${reference.archivePath ?? manifestPath}: ${error?.message ?? String(error)}`);
    }
  }
  return {
    references: loaded.manifests,
    values,
    warnings,
    readableArtifacts,
  };
}

/**
 * Build the deterministic CLI-side provenance gate for one run.
 * Only explicit label=value assignments are compared.
 */
export function createFinalGuard({
  archiveDir,
  onWarning = (message) => console.warn(warningMessage(message)),
} = {}) {
  return async function finalGuard({ finalText } = {}) {
    const inspected = await inspectRun({ archiveDir });
    for (const warning of inspected.warnings) onWarning(warning);
    if (inspected.references.length === 0) {
      return { action: "skip", reason: "no_capture_manifest" };
    }
    if (inspected.values.length === 0 && inspected.readableArtifacts > 0) {
      return { action: "skip", reason: "no_extractable_candidates" };
    }
    if (inspected.values.length === 0) {
      return {
        action: "revise",
        message: "本 run 的 capture manifest 未通过归档根目录、digest、截断或可重放性核验；请读取可信归档或明确说明不可恢复，不得把该值当作已核验事实。",
      };
    }

    const knownLabels = new Map();
    for (const candidate of inspected.values) {
      const values = knownLabels.get(candidate.label) ?? new Set();
      values.add(candidate.value);
      knownLabels.set(candidate.label, values);
    }

    const finalCandidates = explicitAssignments(finalText);
    const comparable = finalCandidates.filter((candidate) => knownLabels.has(candidate.label));
    if (comparable.length === 0) {
      onWarning("终稿没有与 capture manifest 同 label 的显式 label=value，跳过核验");
      return { action: "skip", reason: "no_comparable_label" };
    }
    for (const candidate of comparable) {
      const knownForLabel = knownLabels.get(candidate.label);
      if (knownForLabel.has(candidate.value)) continue;
      const archivePath = inspected.values.find((item) => item.label === candidate.label)
        ?.archivePath ?? inspected.values[0].archivePath;
      return {
        action: "revise",
        message: `终稿中的 ${candidate.label}=${candidate.value} 未经验证。请先 note_read 精确读取（或读取归档 ${archivePath}）核实原始值；不得重跑命令，不得凭记忆给出；若确认无法恢复，请明确说明不可恢复。`,
      };
    }
    return { action: "accept" };
  };
}

export const finalGuard = createFinalGuard;
