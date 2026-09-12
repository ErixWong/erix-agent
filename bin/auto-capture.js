import { createHash } from "node:crypto";

import { note_read, note_take } from "../skills/notes/skill.mjs";

const LABEL_PATTERN = /^\s*([^:=\s][^:=]{0,80}?)\s*[:=]\s*(.*?)\s*$/u;
const CREDENTIAL_LABEL_PATTERN =
  /(?:token|key|secret|password|passwd|bearer|authorization|cookie|credential|private|api[_-]?key|access[_-]?key|refresh[_-]?token)/iu;
const CREDENTIAL_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/iu,
  /-----BEGIN\s+[A-Z ]+(?:PRIVATE KEY|CERTIFICATE)-----/u,
  /\b(?:eyJ[A-Za-z0-9_-]{8,}\.){2}[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}\b/iu,
  /\bnpm_[A-Za-z0-9]{20,}\b/iu,
  /https?:\/\/[^\s/]+(?::[^\s/@]+)?@[^\s]+/iu,
  /https?:\/\/[^\s?#]+[?&](?:token|key|secret|password|access_token|api_key)=/iu,
];
const HIGH_ENTROPY_MIN_LENGTH = 32;

function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

export function looksLikeCredential(label, value) {
  if (label && CREDENTIAL_LABEL_PATTERN.test(label)) return true;
  const text = `${label}\n${value}`;
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (
    value.length >= HIGH_ENTROPY_MIN_LENGTH
    && /^[A-Za-z0-9+/=_-]+$/u.test(value)
    && shannonEntropy(value) >= 3.5
  ) {
    return true;
  }
  return false;
}

export function normalizedLabel(label) {
  return label
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replaceAll(/[\s-]+/gu, "_")
    .replaceAll(/[^\p{L}\p{N}_]+/gu, "")
    .slice(0, 128);
}

export function candidateLines(output) {
  const labelled = [];
  const unlabelled = [];
  const lines = output.replaceAll(/\r\n|\r/gu, "\n").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.length > 256) continue;
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
  };
}

async function candidateKey(label, reference, toolUseId) {
  if (label) return label;
  return `auto:${String(toolUseId ?? "unknown")}:${reference.digest.slice(0, 8)}`;
}

async function keyForCandidate(key, reference) {
  const existing = JSON.parse(await note_read({ key }));
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
      const key = await keyForCandidate(baseKey, reference);
      if (key === null) continue;
      const provenance = {
        source: "auto",
        toolUseId: toolUseId ?? null,
        round: round ?? null,
        ts: new Date(clock()).toISOString(),
        verified: false,
        ...(key !== baseKey ? { supersededCandidate: true } : {}),
      };
      const saved = JSON.parse(await note_take({
        key,
        artifactRef: reference,
        tags: ["value"],
        pinned: true,
        provenance,
      }));
      if (saved.status === "saved" || saved.status === "updated") captured += 1;
    }
    return { status: "captured", count: captured };
  } catch (error) {
    console.error(`auto_capture failed: ${error?.message ?? String(error)}`);
    return { status: "failed" };
  }
}
