import path from "node:path";

import {
  archiveSourceTarget,
  buildCaptureStub,
  collectTranscriptCaptures,
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

function captureDisplayName(capture) {
  if (typeof capture?.display === "string" && capture.display.length > 0) {
    return capture.display;
  }
  if (typeof capture?.archivePath === "string") return path.basename(capture.archivePath);
  return capture?.artifact?.artifactId;
}
function captureIndex(captures) {
  const entries = [...captures].sort((left, right) => (
    String(captureDisplayName(left)).localeCompare(String(captureDisplayName(right)))
  ));
  const visible = entries.slice(0, 10).map((capture) => (
    `${captureDisplayName(capture)} ← ${boundedCommandSummary(capture.command)} [不可重放]`
  ));
  const remaining = entries.length - visible.length;
  if (remaining > 0) visible.push(`另有 ${remaining} 条捕获`);
  return visible.length === 0
    ? ""
    : `\n捕获目录视图（最多 10 条）：\n${visible.join("\n")}`;
}
export async function buildCaptureRecoveryHint({ archiveDir, foldedPayload, store, runId } = {}) {
  let records = [];
  if (store && typeof store.load === "function") {
    try {
      records = await store.load(runId);
    } catch {
      records = [];
    }
  }
  const { captures: transcriptCaptures } = collectTranscriptCaptures(records);
  const loaded = await readCaptureManifests(archiveDir);
  const legacyManifests = loaded.manifests
    .map(({ manifest }) => manifest)
    .filter((manifest) => manifest?.replayable === false);
  const nonReplayableCaptures = transcriptCaptures.length > 0
    ? new Set(transcriptCaptures.map((capture) => capture.key)).size
    : legacyManifests.length;
  return `[本 run 状态] 已折叠 ${countFoldedOutputs(foldedPayload)} 条早期输出；其中 ${nonReplayableCaptures} 条为不可重放捕获（重跑会得到不同值）。需要时用 note_list → note_read 取回，或 recall({ pattern: "关键词" }) 取回原文。${captureIndex(transcriptCaptures.length > 0 ? transcriptCaptures : legacyManifests.map((manifest) => ({ display: manifest.display ?? manifest.archivePath, command: manifest.command })))}`;
}
function sameArtifact(left, right) {
  if (!left || !right || left.replayable !== false || right.replayable !== false) return false;
  if (left.digest !== right.digest) return false;
  // transcript 引用（ADR-015 4b）：toolUseId 一致即可确认同源
  if (left.toolUseId !== undefined) return left.toolUseId === right.toolUseId;
  // legacy 引用：归档路径 + locator 行范围
  return left.archivePath === right.archivePath
    && left.locator?.lineStart === right.locator?.lineStart
    && left.locator?.lineEnd === right.locator?.lineEnd;
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
  const digest = String(capture.artifact?.digest ?? "");
  const target = String(source.target ?? "");
  return target === archiveSourceTarget(capture)
    || target === archivePath
    || target === display
    || target === artifactId
    || (digest.length > 0 && (target === digest || (digest.length > 12 && digest.startsWith(target) && target.length >= 8)))
    || (archivePath.length > 0 && (target === path.basename(archivePath) || archivePath.endsWith(`/${target}`)));
}

function capturePointer(capture) {
  const pointers = [];
  if (capture?.key) pointers.push(`note_read key=${capture.key}`);
  if (capture?.display) pointers.push(`来源=归档:${archiveSourceTarget(capture)}`);
  else if (capture?.archivePath) pointers.push(`来源=归档:${path.basename(String(capture.archivePath))}`);
  return pointers.join(" / ") || "可信捕获";
}
function archiveSourceHint() {
  return "来源=归档:transcript:round=<N>:<digest前缀> 或 note_read:<key>";
}

/**
 * Build the deterministic CLI-side provenance gate for one run.
 * Only explicit attributions to labels captured in this run are compared.
 */
export function createFinalGuard({
  archiveDir,
  onWarning = (message) => console.warn(warningMessage(message)),
  runState,
  notesStore,
  runId,
  store,
} = {}) {
  return async function finalGuard({
    finalText,
    rerunDetected = runState?.rerunDetected === true,
  } = {}) {
    const inspected = await inspectRun({ archiveDir, store, runId });
    for (const warning of inspected.warnings) onWarning(warning);
    if (inspected.readableArtifacts === 0) {
      return { action: "skip", reason: "no_capture_evidence" };
    }
    if (inspected.captures.length === 0) {
      return { action: "skip", reason: "no_extractable_candidates" };
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
          `终稿中的 ${attribution.label}=${attribution.value} 是后续重跑捕获值，但没有来源指向对应 artifact。请补充来源=note_read:<key> 或 ${archiveSourceHint()}，或改用首次捕获值；不得把重跑值当作原值。`,
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
          `终稿包含后续捕获值 ${capture.value} 但没有可验证来源（${capturePointer(capture)}）。请补充来源=note_read:<key> 或 ${archiveSourceHint()}，或改用首次捕获值；不得重跑命令。`,
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
