import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  candidateLines,
} from "./auto-capture.js";
import {
  looksLikeCredential,
  normalizedLabel,
} from "../skills/notes/credential-patterns.mjs";

const SOURCE_DECLARATION_PATTERN =
  /原值|首次|一次性|密钥|阈值|时间戳|token|key|value|secret|password/iu;
const LABEL_VALUE_PATTERN =
  /(?:^|[\s\u3000])([^:=\s][^:=]{0,80}?)\s*[:=]\s*([^\s,，。；;）)]+)/gu;

function warningMessage(message) {
  return `finalGuard warning: ${message}`;
}

function valueShape(value) {
  const text = String(value ?? "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text)) {
    return "uuid";
  }
  if (/^\d{8,17}$/u.test(text)) return "timestamp";
  if (/^[0-9a-f]{8,}$/iu.test(text)) return "hex";
  if (
    text.length >= 8
    && /^[A-Za-z0-9+/=-]+$/u.test(text)
    && (/\d/u.test(text) || /[+/=-]/u.test(text))
  ) {
    return "base64";
  }
  return null;
}

function extractLabeledCandidates(text) {
  const candidates = [];
  for (const match of String(text ?? "").matchAll(LABEL_VALUE_PATTERN)) {
    const label = normalizedLabel(match[1]);
    const value = match[2].trim();
    if (label && value) candidates.push({ label, value });
  }
  return candidates;
}

function extractShapedTokens(text, shapes) {
  const candidates = [];
  const seen = new Set();
  const tokenPattern = /[A-Za-z0-9][A-Za-z0-9+/_-]{7,}={0,2}/gu;
  for (const match of String(text ?? "").matchAll(tokenPattern)) {
    const value = match[0];
    if (!/\d|[+/=]/u.test(value)) continue;
    const shape = valueShape(value);
    if (!shape || !shapes.has(shape) || seen.has(value)) continue;
    seen.add(value);
    candidates.push({ label: "", value, shape });
  }
  return candidates;
}

function safeDisplay(value) {
  const text = String(value);
  if (looksLikeCredential("", text) || text.length >= 32) {
    return `${text.slice(0, 4)}…（长度${text.length}）`;
  }
  return text.length > 80 ? `${text.slice(0, 76)}…` : text;
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
    ) {
      continue;
    }
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
  if (
    reference?.kind !== "erix.tool-capture"
    || reference?.schemaVersion !== 1
  ) {
    throw new Error("不是 CLI capture manifest");
  }
  const resolvedRoot = path.resolve(archiveDir);
  const resolvedPath = path.resolve(reference.archivePath);
  const expectedPath = manifestPath.slice(0, -".meta.json".length) + ".txt";
  if (resolvedPath !== expectedPath) {
    throw new Error("capture manifest 与同名归档不匹配");
  }
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
  if (reference.truncated !== false) {
    throw new Error("归档已截断，不可用于核验");
  }
  if (reference.replayable !== false) {
    throw new Error("可重放归档不可用于 provenance 核验");
  }
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
  const lines = content.replaceAll(/\r\n|\r/gu, "\n").split("\n");
  return lines
    .slice(reference.locator.lineStart - 1, reference.locator.lineEnd)
    .join("\n");
}

async function inspectRun({ archiveDir }) {
  const loaded = await readCaptureManifests(archiveDir);
  const references = loaded.manifests;
  const values = [];
  const warnings = [...loaded.warnings];
  for (const { manifest: reference, manifestPath } of references) {
    if (!reference) continue;
    try {
      const output = await readArtifact(reference, archiveDir, manifestPath);
      const candidates = candidateLines(output).filter((candidate) => (
        !looksLikeCredential(candidate.label, candidate.value)
      ));
      if (candidates.length === 0) {
        warnings.push(`${reference.archivePath}: 未抽取到可核验值`);
        continue;
      }
      for (const candidate of candidates) {
        values.push({
          ...candidate,
          shape: valueShape(candidate.value),
          archivePath: reference.archivePath,
        });
      }
    } catch (error) {
      warnings.push(`${reference.archivePath ?? manifestPath}: ${error?.message ?? String(error)}`);
    }
  }
  return { references, values, warnings };
}

/**
 * Build the deterministic CLI-side provenance gate for one run.
 *
 * The gate trusts only CLI capture manifests under archiveDir; model-authored
 * notes are hints, never provenance. Per ADR-009 this protects the integrity
 * boundary inside a host-isolated run, not against a process that can rewrite
 * the archive directory itself. It never invokes a model or writes to the
 * library transcript.
 */
export function createFinalGuard({
  runId,
  notesDir,
  archiveDir,
  onWarning = (message) => console.warn(warningMessage(message)),
} = {}) {
  return async function finalGuard({ finalText } = {}) {
    const inspected = await inspectRun({
      archiveDir,
    });
    void runId;
    void notesDir;
    if (inspected.warnings.length > 0) {
      for (const warning of inspected.warnings) onWarning(warning);
    }
    if (inspected.references.length === 0) {
      return { action: "accept" };
    }
    if (inspected.values.length === 0) {
      return {
        action: "revise",
        message: "本 run 的 capture manifest 未通过归档根目录、digest、截断或可重放性核验；请读取可信归档或明确说明不可恢复，不得把该值当作已核验事实。",
      };
    }

    const text = String(finalText ?? "");
    const knownValues = new Set(inspected.values.map((candidate) => candidate.value));

    const knownLabels = new Map();
    const knownShapes = new Set();
    for (const candidate of inspected.values) {
      if (candidate.label) {
        const values = knownLabels.get(candidate.label) ?? new Set();
        values.add(candidate.value);
        knownLabels.set(candidate.label, values);
      }
      if (candidate.shape) knownShapes.add(candidate.shape);
    }

    const labeled = [
      ...candidateLines(text),
      ...extractLabeledCandidates(text),
    ];
    for (const candidate of labeled) {
      const label = normalizedLabel(candidate.label);
      const knownForLabel = knownLabels.get(label);
      if (!knownForLabel || knownForLabel.has(candidate.value)) continue;
      const shape = valueShape(candidate.value);
      if (
        (shape && knownShapes.has(shape))
        || (!shape && [...knownForLabel].some((value) => valueShape(value) === null))
      ) {
        const archivePath = inspected.values.find((item) => item.label === label)
          ?.archivePath ?? inspected.values[0].archivePath;
        return {
          action: "revise",
          message: `终稿中的值 ${safeDisplay(candidate.value)} 未经验证。请先 note_read 精确读取（或读取归档 ${archivePath}）核实原始值；不得重跑命令，不得凭记忆给出；若确认无法恢复，请明确说明不可恢复。`,
        };
      }
    }

    const shaped = extractShapedTokens(text, knownShapes);
    const unknown = shaped.find((candidate) => !knownValues.has(candidate.value));
    if (!unknown) return { action: "accept" };
    const sourceClaim = SOURCE_DECLARATION_PATTERN.test(text);
    const archivePath = inspected.values[0].archivePath;
    return {
      action: "revise",
      message: `终稿中的值 ${safeDisplay(unknown.value)}${sourceClaim ? "（来源声明未经核验）" : ""}未经验证。请先 note_read 精确读取（或读取归档 ${archivePath}）核实原始值；不得重跑命令，不得凭记忆给出；若确认无法恢复，请明确说明不可恢复。`,
    };
  };
}

export const finalGuard = createFinalGuard;
