import { existsSync } from "node:fs";
import path from "node:path";

import {
  buildCaptureStub,
  collectTranscriptCaptures,
  inspectRun,
  readCaptureManifests,
} from "./final-guard-support.js";
import { normalizedLabel } from "../src/text/label.js";

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

/**
 * issue #386 切片 2：CLI 侧**默认关闭**的交付物判据（`--require-deliverable`）。
 *
 * 判据只有一条，但它是**磁盘事实**而不是模型的嘴：「本 run 用写工具声明过的每个路径，
 * 收尾时都必须真的在盘上」。它读 `fileWrites`（原始 `tool_use.input[pathKey]`，见 issue #388），
 * 不读 `filesWritten`——后者是 40 码点摘要，拿去 `existsSync()` 会把长路径的 run 系统性误杀。
 *
 * 为什么默认关闭：CLI 的退出码承诺（`check:release` / `check:cli-real` 冒烟）以
 * 「成功 + 无 `--final-guard` ⇒ exit 4」为准；一条默认开启的判据会把「正常收尾但没写文件」
 * 的 run 判成 `unverified`（exit 2），那是**另一个**产品承诺，必须是宿主的显式选择。
 *
 * @param {{exists?: (path: string) => boolean}} [options] `exists` 只为测试注入
 * @returns {{name: string, check: (facts: object) => true|{ok:false, detail:string}}[]}
 */
export function createDeliverableChecks({ exists = existsSync } = {}) {
  return [{
    name: "files_written_exist",
    check: (facts) => {
      const writes = Array.isArray(facts?.fileWrites) ? facts.fileWrites : [];
      const missing = writes.filter((write) => (
        typeof write?.path !== "string" || !exists(write.path)
      ));
      if (missing.length === 0) return true;
      return {
        ok: false,
        detail: `这些声明写入的文件不在盘上：${missing.map((write) => write?.path ?? "<无路径>").join(", ")}`,
      };
    },
  }];
}

/**
 * issue #391：**命名**交付物判据（`--require-deliverable <path>` / `deliverablePaths`）。
 *
 * 与上面那条（`createDeliverableChecks`）的语义**必须分开**，这不是重复而是两个不同的问题：
 *
 *   · 布尔那条问「**你说过要写的东西**还在盘上吗」——它读 `fileWrites`，模型**什么都不声明**时
 *     集合是空的、`every()` 恒真 ⇒ 一次工具都没调的 run 也能拿到 `verified`（#391 回帖的实测）。
 *     它是「没撒谎」的判据，不是「做了事」的判据。
 *   · 命名这条问「**这次任务要求的这些文件**在盘上吗」——它不读模型说了什么，只读宿主声明的清单
 *     ⇒ 模型一次工具都没调时照样判 `ok:false`。要「必须交付 report.md」，只能靠这一条。
 *
 * 相对路径按**判据收到的 `facts.cwd`** 解析（不是进程 cwd）：引擎把宿主传给 `runToolLoop({ cwd })`
 * 的那个值原样放进 payload，**自己不 join、不 `chdir`、也不检查它存在**（#391 的原始症状就是
 * 宿主没接线 ⇒ 判据拿到 `undefined`）。绝对路径不需要 `cwd`。
 *
 * @param {string[]} paths 宿主声明的交付物路径（已去过重，条数上限见 `DELIVERABLES_LIMIT`）
 * @param {{exists?: (path: string) => boolean}} [options] `exists` 只为测试注入
 * @returns {{name: string, check: (facts: object) => true|{ok:false, detail:string}}[]}
 */
export function createNamedDeliverableChecks(paths, { exists = existsSync } = {}) {
  return (Array.isArray(paths) ? paths : []).map((declared) => ({
    name: declared,
    check: (facts) => {
      const cwd = typeof facts?.cwd === "string" && facts.cwd !== "" ? facts.cwd : undefined;
      let target = declared;
      if (!path.isAbsolute(declared)) {
        if (cwd === undefined) {
          // fail-closed：相对路径 + 没有 cwd ⇒ 无从解析。这正是 #391 报的原始症状，不许当通过。
          return {
            ok: false,
            detail: `交付物 ${declared} 是相对路径，但宿主没把 cwd 交给 runToolLoop`
              + "（引擎不补、不 chdir）——接线见 docs/host-upgrade-guide-0.24.0.md §9",
          };
        }
        target = path.resolve(cwd, declared);
      }
      if (exists(target)) return true;
      return { ok: false, detail: `交付物不在盘上：${target}` };
    },
  }));
}

/**
 * `deliverables` 的条数上限，**真值在引擎**（`src/loop/deliverables.js` 的 `DELIVERABLES_LIMIT`）。
 * 这里只转出去给宿主侧做**前置**校验：条数超限要让宿主拿到 `bad_params`（可读、可改），
 * 而不是到引擎才吃一个 `TypeError`（那是引擎内部错误，宿主看不出是自己多写了一条）。
 * `test/cli.test.js` 与 `test/examples/erix-run-core.test.js` 都拿它与引擎常量逐字对账。
 */
export { DELIVERABLES_LIMIT } from "../src/loop/deliverables.js";

export const finalGuard = createFinalGuard;
