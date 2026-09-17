import path from "node:path";

import {
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
  // 值终止符：空白/常见括号外，还含 CJK 右引号、右书名号、顿号——
  // 实测「TARGET=gold-4173」被抽成 gold-4173」导致诚实终稿被误杀（guard 误报）。
  const attributions = [];
  for (const label of knownLabels) {
    const pattern = new RegExp(
      `(?:^|[^\\p{L}\\p{N}_])${escapeRegex(label)}(?![\\p{L}\\p{N}_])\\s*`
        + `(?:(?:=|:|：)|(?:的\\s*)?(?:值\\s*(?:已[^是为]{0,20})?(?:是|为)|是|为))\\s*`
        + `([^\\s,，。；;（）()\\]}"'」』】〉》、]+)`,
      "giu",
    );
    for (const match of String(text ?? "").matchAll(pattern)) {
      attributions.push({ label, value: match[1].trim() });
    }
  }
  return attributions;
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
    .map(({ manifest }) => manifest);
  const archivedOutputs = transcriptCaptures.length > 0
    ? new Set(transcriptCaptures.map((capture) => capture.artifact?.digest)).size
    : legacyManifests.length;
  return `[本 run 状态] 已折叠 ${countFoldedOutputs(foldedPayload)} 条早期输出；其中 ${archivedOutputs} 条输出已归档。需要精确值时用 note_list → note_read 取回，或 recall({ pattern: "关键词" }) 取回原文。${captureIndex(transcriptCaptures.length > 0 ? transcriptCaptures : legacyManifests.map((manifest) => ({ display: manifest.display ?? manifest.archivePath, command: manifest.command })))}`;
}
function countFoldedOutputs(foldedPayload) {
  if (!Array.isArray(foldedPayload)) return 0;
  return foldedPayload.reduce((total, message) => {
    if (!Array.isArray(message?.content)) return total;
    return total + message.content.filter((block) => block?.type === "tool_result").length;
  }, 0);
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
  const visible = entries.slice(0, 10).map((capture) => captureDisplayName(capture));
  const remaining = entries.length - visible.length;
  if (remaining > 0) visible.push(`另有 ${remaining} 条捕获`);
  return visible.length === 0
    ? ""
    : `\n捕获目录视图（最多 10 条）：\n${visible.join("\n")}`;
}
function capturePointer(capture) {
  // ADR-016：capture 无自动笔记 key；指针必须指向可执行的取回动作（recall 配方），
  // 不借用已退役的「来源=」语法（实测中模型会去文件系统找 digest 字符串，白绕 8 轮）。
  const target = capture?.display
    ?? (capture?.archivePath ? path.basename(String(capture.archivePath)) : "");
  if (!target) return "可信捕获";
  return `归档输出 ${target}（用 recall({ pattern: "关键词" }) 取回原文核实）`;
}
/**
 * Build the deterministic CLI-side provenance gate for one run.
 * Only explicit attributions to labels captured in this run are compared.
 */
export function createFinalGuard({
  archiveDir,
  onWarning = (message) => console.warn(warningMessage(message)),
  runId,
  store,
} = {}) {
  return async function finalGuard({
    finalText,
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
    const revise = (message) => ({ action: "revise", message });

    for (const attribution of attributions) {
      const captures = knownLabels.get(attribution.label) ?? [];
      const matching = captures.filter((capture) => capture.value === attribution.value);
      if (matching.length === 0) {
        const pointer = captures[0] ? capturePointer(captures[0]) : "可信归档";
        return revise(
          `终稿中的 ${attribution.label}=${attribution.value} 未对应本 run 的任何归档捕获值。${pointer}；不得重跑命令；若确认无法恢复，请明确说明不可恢复。`,
        );
      }
    }

    if (attributions.length === 0) {
      onWarning("终稿没有与归档输出同 label 的显式归属，跳过核验");
      return { action: "skip", reason: "no_comparable_label" };
    }
    return { action: "accept" };
  };
}

export const finalGuard = createFinalGuard;
