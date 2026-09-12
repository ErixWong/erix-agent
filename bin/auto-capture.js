import { createHash } from "node:crypto";

import { note_read, recordAutoCapture } from "../skills/notes/skill.mjs";
import {
  looksLikeCredential,
  normalizedLabel,
} from "../skills/notes/credential-patterns.mjs";

const LABEL_PATTERN = /^\s*([^:=\s][^:=]{0,80}?)\s*[:=]\s*(.*?)\s*$/u;
export function candidateLines(output) {
  const labelled = [];
  const unlabelled = [];
  const lines = output.replaceAll(/\r\n|\r/gu, "\n").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.length > 256) continue;
    const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//iu.test(line);
    const looksLikeBase64 = line.length >= 24
      && /^[A-Za-z0-9+/]+={0,2}$/u.test(line);
    if (looksLikeUrl || looksLikeBase64) {
      unlabelled.push({ label: "", value: line });
      continue;
    }
    const match = LABEL_PATTERN.exec(line);
    if (match) {
      const label = normalizedLabel(match[1]);
      const value = match[2].trim();
      if (label && value) labelled.push({ label, value });
      continue;
    }
    // Unlabelled values must be opaque single-line tokens; prose is uncertain
    // and is deliberately excluded rather than persisted.
    if (!/\s/u.test(line)) unlabelled.push({ label: "", value: line });
  }
  return [...labelled, ...unlabelled];
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function artifactReference(artifact) {
  if (
    !artifact
    || artifact.replayable !== false
    || typeof artifact.archivePath !== "string"
    || typeof artifact.digest !== "string"
    || !artifact.locator
    || typeof artifact.locator !== "object"
  ) {
    return null;
  }
  return {
    artifactId: artifact.artifactId ?? artifact.archivePath,
    archivePath: artifact.archivePath,
    digest: artifact.digest,
    locator: artifact.locator,
    ...(artifact.truncated === true ? { truncated: true } : { truncated: false }),
    ...(Number.isSafeInteger(artifact.originalBytes)
      ? { originalBytes: artifact.originalBytes }
      : {}),
  };
}

async function candidateKey(label, reference, toolUseId) {
  if (label) return label;
  return `auto:${String(toolUseId ?? "unknown")}:${reference.digest.slice(0, 8)}`;
}

async function keyForCandidate(key, reference, notesScope) {
  const existing = JSON.parse(await note_read({ key, __erix: notesScope }));
  if (
    (existing.status === "found" || existing.status === "unverified")
    && existing.artifactRef?.digest === reference.digest
  ) {
    return null;
  }
  if (existing.status === "found" || existing.status === "unverified") {
    return `${key}:candidate:${reference.digest.slice(0, 8)}`;
  }
  return key;
}

/**
 * Capture only references to trusted sidecar artifacts. Any failure is
 * intentionally isolated from the tool loop.
 */
export async function captureToolExecution({
  name,
  result,
  metadata,
  toolUseId,
  round,
  clock = () => Date.now(),
  notesScope,
} = {}) {
  try {
    if (name !== "exec" || metadata?.replayable !== false) return { status: "skipped" };
    const reference = artifactReference(metadata.artifact);
    const output = typeof metadata.fullOutput === "string"
      ? metadata.fullOutput
      : typeof result === "string" ? result : null;
    if (!reference || output === null || digest(output) !== reference.digest) {
      return { status: "skipped" };
    }

    let captured = 0;
    const seen = new Set();
    for (const candidate of candidateLines(output)) {
      if (captured >= 3 || seen.has(`${candidate.label}\n${candidate.value}`)) continue;
      seen.add(`${candidate.label}\n${candidate.value}`);
      if (looksLikeCredential(candidate.label, candidate.value)) continue;

      const baseKey = await candidateKey(candidate.label, reference, toolUseId);
      const key = await keyForCandidate(baseKey, reference, notesScope);
      if (key === null) continue;
      const provenance = {
        source: "auto",
        toolUseId: toolUseId ?? null,
        round: round ?? null,
        ts: new Date(clock()).toISOString(),
        verified: false,
        ...(key !== baseKey ? { supersededCandidate: true } : {}),
      };
      const saved = JSON.parse(await recordAutoCapture({
        key,
        artifactRef: reference,
        tags: ["value"],
        pinned: true,
        provenance,
        __erix: notesScope,
      }));
      if (saved.status === "saved" || saved.status === "updated") captured += 1;
    }
    return { status: "captured", count: captured };
  } catch (error) {
    console.error(`auto_capture failed: ${error?.message ?? String(error)}`);
    return { status: "failed" };
  }
}
