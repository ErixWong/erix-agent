import { createHash } from "node:crypto";

import {
  MAX_CONTENT_LENGTH,
  recordAutoCapture,
} from "../skills/notes/skill.mjs";
import {
  looksLikeCredential,
  normalizedLabel,
} from "../skills/notes/credential-patterns.mjs";

const AUTO_CAPTURE_MAX_CHARS = 1000;
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

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 24);
}

function artifactReference(artifact) {
  if (
    !artifact
    || artifact.replayable !== false
    || (typeof artifact.archivePath !== "string"
      && (artifact.locator === undefined || artifact.locator === null))
    || typeof artifact.digest !== "string"
    || !artifact.locator
    || typeof artifact.locator !== "object"
  ) {
    return null;
  }
  return {
    artifactId: artifact.artifactId
      ?? (artifact.archivePath === undefined && typeof artifact.digest === "string"
        ? `resource:${artifact.digest}`
        : artifact.archivePath),
    ...(typeof artifact.archivePath === "string" ? { archivePath: artifact.archivePath } : {}),
    ...(typeof artifact.display === "string" ? { display: artifact.display } : {}),
    digest: artifact.digest,
    locator: artifact.locator,
    round: artifact.round ?? null,
    status: artifact.status ?? (artifact.truncated === true ? "truncated" : "ok"),
    ...(artifact.truncated === true ? { truncated: true } : { truncated: false }),
    ...(Number.isSafeInteger(artifact.originalBytes)
      ? { originalBytes: artifact.originalBytes }
      : {}),
    replayable: false,
  };
}

export function autoCaptureKey(command, reference) {
  const normalizedCommand = typeof command === "string"
    ? command.replaceAll(/\r\n?/gu, "\n").trim()
    : "";
  return `auto-${digest(JSON.stringify({
    command: normalizedCommand,
    artifact: normalizedCommand
      ? undefined
      : {
          archivePath: reference.archivePath,
          display: reference.display,
          digest: reference.digest,
          locator: reference.locator,
        },
  }))}`;
}

/**
 * Capture exactly one bounded note for each non-replayable exec. The archive
 * reference remains the source of truth; the optional content is only a
 * bounded excerpt for discovery.
 */
export async function captureToolExecution({
  name,
  input,
  command,
  result,
  metadata,
  toolUseId,
  round,
  clock = () => Date.now(),
  notesScope,
} = {}) {
  try {
    if (name !== "exec" || metadata?.replayable !== false) return { status: "found", count: 0 };
    const reference = artifactReference(metadata.artifact);
    const output = typeof metadata.fullOutput === "string"
      ? metadata.fullOutput
      : typeof result === "string" ? result : null;
    if (!reference || output === null) return { status: "found", count: 0 };
    const actualDigest = createHash("sha256").update(output, "utf8").digest("hex");
    if (actualDigest !== reference.digest) return { status: "found", count: 0 };

    const hasCredential = output
      .replaceAll(/\r\n|\r/gu, "\n")
      .split("\n")
      .some((line) => {
        const assignment = LABEL_PATTERN.exec(line);
        if (assignment) {
          const label = normalizedLabel(assignment[1]);
          const value = assignment[2].trim();
          if (looksLikeCredential(label, value)) return true;
        }
        return looksLikeCredential("", line);
      });
    const key = autoCaptureKey(command ?? input?.command ?? metadata?.command, reference);
    const provenance = {
      source: "auto",
      toolUseId: toolUseId ?? null,
      round: round ?? null,
      ts: new Date(clock()).toISOString(),
      verified: false,
    };
    const saved = JSON.parse(await recordAutoCapture({
      key,
      ...(hasCredential
        ? {}
        : { content: output.slice(0, Math.min(AUTO_CAPTURE_MAX_CHARS, MAX_CONTENT_LENGTH)) }),
      artifactRef: reference,
      tags: ["value", "auto"],
      relevance: 0.8,
      pinned: true,
      provenance,
      __erix: notesScope,
    }));
    return {
      status: saved.status === "found" ? "found" : saved.status,
      count: saved.status === "found" ? 1 : 0,
      key,
    };
  } catch (error) {
    console.error(`auto_capture failed: ${error?.message ?? String(error)}`);
    return { status: "invalid", count: 0 };
  }
}
