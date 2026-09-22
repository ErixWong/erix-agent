import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { normalizedLabel, looksLikeCredential } from "../src/tools/credential-patterns.js";

const LABEL_PATTERN = /^\s*([^:=\s][^:=\s]{0,80}?)\s*=\s*(.*?)\s*$/u;

export function candidateLines(output) {
  const candidates = [];
  for (const rawLine of String(output ?? "").replaceAll(/\r\n|\r/gu, "\n").split("\n")) {
    const match = LABEL_PATTERN.exec(rawLine);
    if (!match) continue;
    const label = normalizedLabel(match[1]);
    const value = match[2].trim();
    if (label && value) candidates.push({ label, value });
  }
  return candidates;
}
async function legacyArchivedOutput(block) {
  // 旧会话兼容：tool_result content 是指针文本，原文在归档文件里
  const artifact = block?.artifact && typeof block.artifact === "object" ? block.artifact : block;
  const archivePath = typeof artifact?.archivePath === "string" ? artifact.archivePath : undefined;
  if (!archivePath) return undefined;
  try {
    return await readFile(archivePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return undefined;
  }
}

async function captureStubForResult(block) {
  let output = blockContentText(block?.content);
  if (block?.artifact !== undefined && output.length === 0) {
    const legacy = await legacyArchivedOutput(block);
    if (typeof legacy === "string") output = legacy;
  } else if (output.length === 0 && block?.archivePath !== undefined) {
    const legacy = await legacyArchivedOutput(block);
    if (typeof legacy === "string") output = legacy;
  }
  const safeCandidates = candidateLines(output).filter(({ label, value }) => (
    !looksLikeCredential(label, value)
  ));
  if (safeCandidates.length > 0) {
    const lines = safeCandidates
      .slice(0, 3)
      .map(({ label, value }) => `${label}=${value}`);
    const prefix = "[已折叠] 值：";
    const suffix = "；后续先 note_list 查找，再 note_read 读取；未记录且无法确定性重算时省略对应 findings 声明";
    let result = `${prefix}${lines.join("；")}${suffix}`;
    if (Array.from(result).length > 200) {
      const available = Math.max(0, 200 - Array.from(`${prefix}${suffix}`).length - 1);
      const bounded = Array.from(lines.join("；")).slice(0, available).join("");
      result = `${prefix}${bounded}${suffix}`;
    }
    return Array.from(result).slice(0, 200).join("");
  }
  return "[已折叠] 后续先 note_list 查找，再 note_read 读取；未记录且无法确定性重算时省略对应 findings 声明".slice(0, 200);
}

export async function buildCaptureStub(message) {
  // ADR-016：折叠值锚点对全部 tool_result 生效（不再区分可重放）
  const results = Array.isArray(message?.content)
    ? message.content.filter((block) => block?.type === "tool_result")
    : [];
  const stubs = [];
  for (const result of results) {
    stubs.push(await captureStubForResult(result));
  }
  return [...new Set(stubs)].join("\n");
}

export function archiveSourceTarget(capture) {
  const display = String(capture?.display ?? "");
  if (capture?.legacy === true) {
    return display || path.basename(String(capture?.archivePath ?? ""));
  }
  return display;
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
  if (reference.truncated !== false) throw new Error("归档已截断，不可用于核验");
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
    throw new Error("opaque locator 引用已随 ResourceStore 退役，无法核验");
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

/**
 * ADR-015 4b：transcript capture 采集器——证据源 = record.toolOutputs（字节保真）。
 * 返回 capture 形状与 legacy manifest 采集一致（label/value/display/round/key/artifact）。
 */
function blockContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => typeof part?.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

export function collectTranscriptCaptures(records) {
  const captures = [];
  const warnings = [];
  let readable = 0;
  for (const record of Array.isArray(records) ? records : []) {
    const outputs = new Map(
      (Array.isArray(record?.toolOutputs) ? record.toolOutputs : [])
        .filter((entry) => typeof entry?.toolUseId === "string" && typeof entry?.content === "string")
        .map((entry) => [entry.toolUseId, entry.content]),
    );
    for (const message of Array.isArray(record?.messages) ? record.messages : []) {
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        // ADR-016：全部 tool_result 都进核验证据面（不再区分可重放/不可重放）
        if (block?.type !== "tool_result") continue;
        const output = outputs.get(block.tool_use_id) ?? blockContentText(block.content);
        readable += 1;
        const candidates = candidateLines(output);
        if (candidates.length === 0) {
          warnings.push(`transcript round=${record.round ?? "?"}: 未抽取到可核验值`);
          continue;
        }
        const round = Number.isSafeInteger(record.round) ? record.round : null;
        const reference = {
          toolUseId: block.tool_use_id,
          round,
          digest: createHash("sha256").update(output, "utf8").digest("hex"),
        };
        const display = `transcript:round=${round ?? "?"}:${reference.digest.slice(0, 8)}`;
        captures.push(...candidates.map((candidate) => ({
          ...candidate,
          display,
          transcript: true,
          artifact: reference,
          round,
        })));
      }
    }
  }
  return { captures, warnings, readable };
}

export async function inspectRun({ archiveDir, store, runId }) {
  const captures = [];
  const warnings = [];
  let readableArtifacts = 0;
  const seenEvidence = new Set();

  // 主证据源：transcript（toolOutputs 字节保真）
  let records = [];
  if (store && typeof store.load === "function") {
    try {
      records = await store.load(runId);
    } catch (error) {
      warnings.push(`transcript 读取失败: ${error?.message ?? String(error)}`);
    }
  }
  const collected = collectTranscriptCaptures(records);
  warnings.push(...collected.warnings);
  readableArtifacts += collected.readable;
  for (const capture of collected.captures) {
    // 证据去重：同一输出（digest+label+value）只入一次
    const evidenceKey = `${capture.artifact?.digest ?? ""}|${capture.label}|${capture.value}`;
    if (seenEvidence.has(evidenceKey)) continue;
    seenEvidence.add(evidenceKey);
    captures.push(capture);
  }

  // 兼容证据源：legacy manifest（旧会话落盘的归档，新会话不再产生）
  const loaded = await readCaptureManifests(archiveDir);
  warnings.push(...loaded.warnings);
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
      for (const candidate of candidates) {
        const evidenceKey = `${reference.digest}|${candidate.label}|${candidate.value}`;
        if (seenEvidence.has(evidenceKey)) continue;
        seenEvidence.add(evidenceKey);
        captures.push({
          ...candidate,
          archivePath: reference.archivePath,
          ...(typeof reference.display === "string" ? { display: reference.display } : {}),
          legacy: true,
          artifact: reference,
          round: reference.round ?? null,
        });
      }
    } catch (error) {
      warnings.push(
        `${reference.archivePath ?? reference.display ?? manifestPath}: ${error?.message ?? String(error)}`,
      );
    }
  }
  return {
    references: loaded.manifests,
    captures,
    warnings,
    readableArtifacts,
  };
}
