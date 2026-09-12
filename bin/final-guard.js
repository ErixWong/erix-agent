import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { safeRunId } from "../src/store/file.js";
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

function notesRoot(notesDir) {
  return path.resolve(notesDir ?? process.env.ERIX_NOTES_DIR
    ?? path.join(homedir(), ".erix", "notes"));
}

async function readNoteRecords(runDirectory) {
  let entries;
  try {
    entries = await readdir(runDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { records: [], warnings: [] };
    throw error;
  }
  const records = [];
  const warnings = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(runDirectory, entry.name);
    try {
      records.push(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      warnings.push(`${filePath}: ${error?.message ?? String(error)}`);
    }
  }
  return { records, warnings };
}

function artifactReferences(records) {
  const references = [];
  const seen = new Set();
  for (const record of records) {
    for (const version of record?.versions ?? []) {
      const reference = version?.artifactRef;
      if (!reference || typeof reference !== "object" || Array.isArray(reference)) continue;
      const identity = `${reference.archivePath}\n${reference.digest ?? ""}\n${
        JSON.stringify(reference.locator ?? {})
      }\n${version?.provenance?.source ?? ""}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      references.push({
        ...reference,
        __trustedAutoSource: version?.provenance?.source === "auto",
      });
    }
  }
  return references;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== ""
    && !relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative);
}

async function readArtifact(reference, archiveDir) {
  if (typeof archiveDir !== "string" || archiveDir.length === 0) {
    throw new Error("缺少本 run 归档根目录");
  }
  const resolvedRoot = path.resolve(archiveDir);
  const resolvedPath = path.resolve(reference.archivePath);
  if (!isWithin(resolvedRoot, resolvedPath)) {
    throw new Error("artifactRef 不在本 run 归档根目录内");
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
  if (reference.truncated === true) {
    throw new Error("归档已截断，不可用于核验");
  }
  if (reference.replayable === true) {
    throw new Error("可重放 artifact 不可用于 provenance 核验");
  }
  if (typeof reference.digest !== "string" || !/^[a-f0-9]{64}$/iu.test(reference.digest)) {
    throw new Error("artifactRef 缺少有效 digest");
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

async function inspectRun({ runId, notesDir, archiveDir }) {
  const directory = path.join(notesRoot(notesDir), "run", safeRunId(runId));
  const loaded = await readNoteRecords(directory);
  const references = artifactReferences(loaded.records);
  const values = [];
  const warnings = [...loaded.warnings];
  for (const reference of references) {
    if (reference.__trustedAutoSource !== true) {
      warnings.push(`${reference.archivePath ?? "artifactRef"}: provenance.source 不是 capture 签发的 auto`);
      continue;
    }
    try {
      const output = await readArtifact(reference, archiveDir);
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
      warnings.push(`${reference.archivePath}: ${error?.message ?? String(error)}`);
    }
  }
  return { references, values, warnings };
}

/**
 * Build the deterministic CLI-side provenance gate for one run.
 *
 * The gate only reads notes and sidecar artifacts. It never invokes a model or
 * writes to the library transcript.
 */
export function createFinalGuard({
  runId,
  notesDir,
  archiveDir,
  onWarning = (message) => console.warn(warningMessage(message)),
} = {}) {
  return async function finalGuard({ finalText } = {}) {
    const inspected = await inspectRun({
      runId: runId ?? process.env.ERIX_RUN_ID ?? "",
      notesDir,
      archiveDir,
    });
    if (inspected.warnings.length > 0) {
      for (const warning of inspected.warnings) onWarning(warning);
    }
    if (inspected.references.length === 0) {
      return { action: "accept" };
    }
    if (inspected.values.length === 0) {
      return {
        action: "revise",
        message: "本 run 的 artifactRef 未通过归档根目录、digest、截断或可重放性核验；请读取可信归档或明确说明不可恢复，不得把该值当作已核验事实。",
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
