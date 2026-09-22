import path from "node:path";

import {
  buildCaptureStub,
  collectTranscriptCaptures,
  inspectRun,
  readCaptureManifests,
} from "./final-guard-support.js";
import { normalizedLabel } from "../src/tools/credential-patterns.js";

export { buildCaptureStub };
function warningMessage(message) {
  return `finalGuard warning: ${message}`;
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
  return `[本 run 状态] 已折叠 ${countFoldedOutputs(foldedPayload)} 条早期输出；其中 ${archivedOutputs} 条输出已归档。需要精确值时先用 note_list 查找，再用 note_read 读取；若未记录且无法确定性重算，请省略对应 findings 声明。${captureIndex(transcriptCaptures.length > 0 ? transcriptCaptures : legacyManifests.map((manifest) => ({ display: manifest.display ?? manifest.archivePath, command: manifest.command })))}`;
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
  // ADR-016：capture 无自动笔记 key；指针必须指向可执行的 note-first 动作，
  // 不借用来源文本让模型去文件系统盲目搜索。
  const target = capture?.display
    ?? (capture?.archivePath ? path.basename(String(capture.archivePath)) : "");
  if (!target) return "没有可执行取回指针；若未记录且无法确定性重算，请省略对应 findings 声明";
  return `归档输出 ${target}（先用 note_list 查找，再用 note_read 读取；若未记录且无法确定性重算，请省略对应 findings 声明）`;
}
/**
 * Build the deterministic CLI-side provenance gate for one run.
 *
 * 2026-09-17 裁定（用户）：终稿关键值声明的唯一权威载体 = 结束协议信封的
 * `findings` 字段（label→精确值）。guard 只做 findings ↔ 归档捕获值的字符串
 * 相等比对，**不解析终稿散文**——正则从自由文本里猜值边界已被实证不可靠
 * （「TARGET=gold-4173」被抽成 gold-4173」导致诚实终稿被误杀）。
 */
export function createFinalGuard({
  archiveDir,
  onWarning = (message) => console.warn(warningMessage(message)),
  runId,
  store,
} = {}) {
  return async function finalGuard({
    findings,
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

    const revise = (message) => ({ action: "revise", message });

    // 归档里有可核验值、终稿却没声明任何 findings：这是模型没走声明流程，
    // 不是"本任务没有可核验值"（后者在前面 no_extractable_candidates 已拦），
    // 打回一次逼它声明；仍不声明则由 guard 重试上限兜底 → unverified。
    const declarations = normalizeDeclarations(findings);
    if (declarations.length === 0) {
      const labels = [...knownLabels.keys()].slice(0, 10).join("、");
      return revise(
        `终稿信封没有声明 findings 关键值，但本 run 的归档输出里有 ${inspected.captures.length} 条可核验捕获值（可用 label：${labels}）。请在结束信封的 findings 中声明结论用到的值（label→精确值，逐字取自归档原文）；guard 只读 findings，不解析终稿散文——若结论确实不依赖任何归档值，本次运行在重试耗尽后将以 unverified 收尾（fail-closed）。${capturePointer(inspected.captures[0])}`,
      );
    }
    for (const { label, value } of declarations) {
      const captures = knownLabels.get(label) ?? [];
      if (captures.length === 0) {
        // 未知 label ≠ 伪造：归档里从未出现该 label，无法核验也无法证伪
        //（实测：模型把"重跑次数=0"这类派生结论塞进 findings 会被误打回，引发绕路风暴）。
        // 警告并忽略该条，继续核验其余声明。
        onWarning(`终稿 findings 声明了归档中不存在的 label「${label}」（无法核验，已跳过该条）`);
        continue;
      }
      const matched = captures.filter((capture) => capture.value === value);
      if (matched.length === 0) {
        const observed = [...new Set(captures.map((capture) => capture.value))].slice(0, 5);
        return revise(
          `终稿 findings 声明的 ${label}=${value} 与归档捕获值不符（捕获值：${observed.join(" | ")}）。${capturePointer(captures[0])}；不得重跑命令；若确认无法恢复，请明确说明不可恢复。`,
        );
      }
    }
    return { action: "accept" };
  };
}

function normalizeDeclarations(findings) {
  if (findings === undefined || findings === null
    || typeof findings !== "object" || Array.isArray(findings)) {
    return [];
  }
  const declarations = [];
  for (const [key, item] of Object.entries(findings)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (!["string", "number", "boolean"].includes(typeof item)) continue;
    const label = normalizedLabel(key);
    if (label.length === 0) continue;
    declarations.push({ label, value: String(item) });
  }
  return declarations;
}

export const finalGuard = createFinalGuard;
