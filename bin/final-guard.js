import path from "node:path";

import {
  archiveSourceTarget,
  buildCaptureStub,
  inspectRun,
  readCaptureManifests,
} from "./final-guard-support.js";

export { buildCaptureStub };
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
function countFoldedOutputs(foldedPayload) {
  if (!Array.isArray(foldedPayload)) return 0;
  return foldedPayload.reduce((total, message) => {
    if (!Array.isArray(message?.content)) return total;
    return total + message.content.filter((block) => block?.type === "tool_result").length;
  }, 0);
}
function boundedCommandSummary(command) {
  const text = String(command ?? "exec")
    .replaceAll(/\r\n|\r|\n/gu, " ")
    .replaceAll(
      /(\b[\p{L}\p{N}_-]{1,80}\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gu,
      "$1<值>",
    )
    .replaceAll(/\s+/gu, " ")
    .trim();
  return text.slice(0, 100);
}

function archiveDisplay(manifest, resourceStore) {
  if (resourceStore !== undefined) {
    return manifest?.display ?? manifest?.artifactId ?? "ResourceStore 中的归档资源";
  }
  if (typeof manifest?.display === "string" && manifest.display.length > 0) {
    return manifest.display;
  }
  if (typeof manifest?.archivePath === "string") return path.basename(manifest.archivePath);
  return manifest?.artifactId;
}
function archiveIndex(manifests, resourceStore) {
  const entries = manifests
    .map(({ manifest }) => manifest)
    .filter((manifest) => manifest?.replayable === false)
    .sort((left, right) => (
      String(archiveDisplay(left, resourceStore))
      .localeCompare(String(archiveDisplay(right, resourceStore)))
    ));
  const visible = entries.slice(0, 10).map((manifest) => (
    `${archiveDisplay(manifest, resourceStore)} ← ${boundedCommandSummary(manifest.command)} [不可重放]`
  ));
  const remaining = entries.length - visible.length;
  if (remaining > 0) visible.push(`另有 ${remaining} 条归档`);
  return visible.length === 0
    ? ""
    : `\n归档目录视图（最多 10 条）：\n${visible.join("\n")}`;
}
export async function buildCaptureRecoveryHint({ archiveDir, foldedPayload, resourceStore } = {}) {
  const loaded = await readCaptureManifests(archiveDir);
  const nonReplayableCaptures = loaded.manifests.filter(({ manifest }) => (
    manifest?.replayable === false
  )).length;
  const archiveReference = resourceStore === undefined
    ? typeof archiveDir === "string" && archiveDir.length > 0 ? `${path.resolve(archiveDir)}/<n>-exec.txt` : "明确的归档文件"
    : "ResourceStore 中的 opaque locator";
  return `[本 run 状态] 已折叠 ${countFoldedOutputs(foldedPayload)} 条早期输出；其中 ${nonReplayableCaptures} 条为不可重放捕获（重跑会得到不同值）。需要时用 note_list → note_read 取回，或读取归档 ${archiveReference}。${archiveIndex(loaded.manifests, resourceStore)}`;
}
function sameArtifact(left, right) {
  return Boolean(
    left
      && right
      && left.replayable === false
      && right.replayable === false
      && left.archivePath === right.archivePath
      && left.digest === right.digest
      && left.locator?.lineStart === right.locator?.lineStart
      && left.locator?.lineEnd === right.locator?.lineEnd,
  );
}
async function sourceMatchesCapture(source, capture, { notesStore, runId } = {}) {
  if (source.kind === "note_read") {
    if (source.target !== capture.key || !notesStore) return source.target === capture.key;
    const record = await notesStore.read({
      scope: "run",
      scopeRef: runId,
      key: source.target,
    });
    return record?.state !== "revoked"
      && sameArtifact(record?.current?.artifactRef, capture.artifact);
  }
  if (source.kind !== "归档") return false;
  const archivePath = String(capture.archivePath ?? "");
  const display = String(capture.display ?? "");
  const artifactId = String(capture.artifact?.artifactId ?? "");
  const target = String(source.target ?? "");
  return target === archiveSourceTarget(capture)
    || target === archivePath
    || target === display
    || target === artifactId
    || target === path.basename(archivePath)
    || archivePath.endsWith(`/${target}`);
}

function capturePointer(capture, resourceStore) {
  const pointers = [];
  if (capture?.key) pointers.push(`note_read key=${capture.key}`);
  if (resourceStore !== undefined) {
    pointers.push(`来源=归档:${archiveSourceTarget(capture)}`);
  }
  else if (capture?.display) pointers.push(`归档 ${capture.display}`);
  else if (capture?.archivePath) pointers.push(`归档 ${capture.archivePath}`);
  return pointers.join(" / ") || "可信归档";
}
function archiveSourceHint(resourceStore) {
  return resourceStore === undefined
    ? "来源=归档:<文件名>"
    : "来源=归档:resource:<display>";
}

/**
 * Build the deterministic CLI-side provenance gate for one run.
 * Only explicit attributions to labels captured in this run are compared.
 */
export function createFinalGuard({
  archiveDir,
  onWarning = (message) => console.warn(warningMessage(message)),
  runState,
  resourceStore,
  notesStore,
  runId,
} = {}) {
  return async function finalGuard({
    finalText,
    rerunDetected = runState?.rerunDetected === true,
  } = {}) {
    const inspected = await inspectRun({ archiveDir, resourceStore });
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
        const pointer = captures[0] ? capturePointer(captures[0], resourceStore) : "可信归档";
        return revise(
          `终稿中的 ${attribution.label}=${attribution.value} 未对应本 run 的任何捕获值。请读取 ${pointer} 核实原始值，不得重跑命令；若确认无法恢复，请明确说明不可恢复。`,
        );
      }
      if (matching.some((capture) => capture.first)) continue;
      let cited;
      for (const capture of matching) {
        for (const source of sources) {
          if (await sourceMatchesCapture(source, capture, { notesStore, runId })) {
            cited = capture;
            break;
          }
        }
        if (cited) break;
      }
      if (!cited) {
        return revise(
          `终稿中的 ${attribution.label}=${attribution.value} 是后续重跑捕获值，但没有来源指向对应 artifact。请补充来源=note_read:<key> 或 ${archiveSourceHint(resourceStore)}，或改用首次捕获值；不得把重跑值当作原值。`,
        );
      }
    }

    let rerunCited = false;
    for (const capture of inspected.captures) {
      if (capture.first || !String(finalText ?? "").includes(capture.value)) continue;
      let cited = false;
      for (const attribution of attributions) {
        if (attribution.label !== capture.label || attribution.value !== capture.value) continue;
        for (const source of sources) {
          if (await sourceMatchesCapture(source, capture, { notesStore, runId })) {
            cited = true;
            break;
          }
        }
        if (cited) break;
      }
      if (!cited) {
        return revise(
          `终稿包含后续捕获值 ${capture.value} 但没有可验证来源（${capturePointer(capture, resourceStore)}）。请补充来源=note_read:<key> 或 ${archiveSourceHint(resourceStore)}，或改用首次捕获值；不得重跑命令。`,
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
