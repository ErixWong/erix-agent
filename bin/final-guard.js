import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { autoCaptureKey, candidateLines } from "./auto-capture.js";

const SOURCE_PATTERN =
  /来源\s*(?:=|:|：)\s*(note_read|归档)\s*[:：]\s*([^\s,，。；;）)\]}]+)/giu;

function warningMessage(message) {
  return `finalGuard warning: ${message}`;
}

function escapeRegex(value) {
  return String(value).replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function explicitAttributions(text, knownLabels) {
  const attributions = [];
  for (const label of knownLabels) {
    const pattern = new RegExp(
      `(?:^|[^\\p{L}\\p{N}_])${escapeRegex(label)}(?![\\p{L}\\p{N}_])\\s*`
        + `(?:(?:=|:|：)|(?:的\\s*)?(?:值\\s*(?:已[^是为]{0,20})?(?:是|为)|是|为))\\s*`
        + `([^\\s,，。；;（）()\\]}]+)`,
      "giu",
    );
    for (const match of String(text ?? "").matchAll(pattern)) {
      attributions.push({ label, value: match[1].trim() });
    }
  }
  return attributions;
}

function sourceReferences(text) {
  return [...String(text ?? "").matchAll(SOURCE_PATTERN)].map((match) => ({
    kind: match[1].toLowerCase(),
    target: match[2],
  }));
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
  const captures = [];
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
      captures.push(...candidates.map((candidate) => ({
        ...candidate,
        archivePath: reference.archivePath,
        artifact: reference,
        round: reference.round ?? null,
        key: autoCaptureKey(reference.command, reference),
      })));
    } catch (error) {
      warnings.push(`${reference.archivePath ?? manifestPath}: ${error?.message ?? String(error)}`);
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

function countFoldedOutputs(foldedPayload) {
  if (!Array.isArray(foldedPayload)) return 0;
  return foldedPayload.reduce((total, message) => {
    if (!Array.isArray(message?.content)) return total;
    return total + message.content.filter((block) => block?.type === "tool_result").length;
  }, 0);
}

export async function buildCaptureRecoveryHint({ archiveDir, foldedPayload } = {}) {
  const loaded = await readCaptureManifests(archiveDir);
  const nonReplayableCaptures = loaded.manifests.filter(({ manifest }) => (
    manifest?.replayable === false
  )).length;
  const archiveReference = typeof archiveDir === "string" && archiveDir.length > 0
    ? `${path.resolve(archiveDir)}/<n>-exec.txt`
    : "明确的归档文件";
  return `[本 run 状态] 已折叠 ${countFoldedOutputs(foldedPayload)} 条早期输出；其中 ${nonReplayableCaptures} 条为不可重放捕获（重跑会得到不同值）。需要时用 note_list → note_read 取回，或读取归档 ${archiveReference}。`;
}

function sourceMatchesCapture(source, capture) {
  if (source.kind === "note_read") return source.target === capture.key;
  if (source.kind !== "归档") return false;
  const archivePath = String(capture.archivePath ?? "");
  const target = String(source.target ?? "");
  return target === archivePath
    || target === path.basename(archivePath)
    || archivePath.endsWith(`/${target}`);
}

function capturePointer(capture) {
  const pointers = [];
  if (capture?.key) pointers.push(`note_read key=${capture.key}`);
  if (capture?.archivePath) pointers.push(`归档 ${capture.archivePath}`);
  return pointers.join(" / ") || "可信归档";
}

/**
 * Build the deterministic CLI-side provenance gate for one run.
 * Only explicit attributions to labels captured in this run are compared.
 */
export function createFinalGuard({
  archiveDir,
  onWarning = (message) => console.warn(warningMessage(message)),
  runState,
} = {}) {
  return async function finalGuard({
    finalText,
    rerunDetected = runState?.rerunDetected === true,
  } = {}) {
    const inspected = await inspectRun({ archiveDir });
    for (const warning of inspected.warnings) onWarning(warning);
    if (inspected.references.length === 0) {
      return { action: "skip", reason: "no_capture_manifest" };
    }
    if (inspected.captures.length === 0 && inspected.readableArtifacts > 0) {
      return { action: "skip", reason: "no_extractable_candidates" };
    }
    if (inspected.captures.length === 0) {
      return {
        action: "revise",
        message: "本 run 的 capture manifest 未通过归档根目录、digest、截断或可重放性核验；请读取可信归档或明确说明不可恢复，不得把该值当作已核验事实。",
      };
    }

    const knownLabels = new Map();
    for (const capture of inspected.captures) {
      const captures = knownLabels.get(capture.label) ?? [];
      captures.push(capture);
      knownLabels.set(capture.label, captures);
    }

    const attributions = explicitAttributions(finalText, knownLabels.keys());
    const sources = sourceReferences(finalText);
    const revise = (message) => ({ action: "revise", message });

    for (const attribution of attributions) {
      const captures = knownLabels.get(attribution.label) ?? [];
      const matching = captures.filter((capture) => capture.value === attribution.value);
      if (matching.length === 0) {
        const pointer = captures[0] ? capturePointer(captures[0]) : "可信归档";
        return revise(
          `终稿中的 ${attribution.label}=${attribution.value} 未对应本 run 的任何捕获值。请读取 ${pointer} 核实原始值，不得重跑命令；若确认无法恢复，请明确说明不可恢复。`,
        );
      }
      if (matching.some((capture) => capture.first)) continue;
      const cited = matching.find((capture) => (
        sources.some((source) => sourceMatchesCapture(source, capture))
      ));
      if (!cited) {
        return revise(
          `终稿中的 ${attribution.label}=${attribution.value} 是后续重跑捕获值，但没有来源指向对应 artifact。请补充来源=note_read:<key> 或来源=归档:<文件名>，或改用首次捕获值；不得把重跑值当作原值。`,
        );
      }
    }

    let rerunCited = false;
    for (const capture of inspected.captures) {
      if (capture.first || !String(finalText ?? "").includes(capture.value)) continue;
      const cited = attributions.some((attribution) => (
        attribution.label === capture.label
        && attribution.value === capture.value
        && sources.some((source) => sourceMatchesCapture(source, capture))
      ));
      if (!cited) {
        return revise(
          `终稿包含后续捕获值 ${capture.value} 但没有可验证来源（${capturePointer(capture)}）。请补充来源=note_read:<key> 或来源=归档:<文件名>，或改用首次捕获值；不得重跑命令。`,
        );
      }
      rerunCited = true;
    }

    if (attributions.length === 0 && !rerunCited) {
      onWarning(
        rerunDetected
          ? "终稿没有显式来源归属；本 run 检测到重跑，无法核对终稿中的值，跳过核验"
          : "终稿没有与 capture manifest 同 label 的显式归属，跳过核验",
      );
      return { action: "skip", reason: "no_comparable_label" };
    }
    return rerunCited ? { action: "accept", rerunCited: true } : { action: "accept" };
  };
}

export const finalGuard = createFinalGuard;
