import { readFileSync } from "node:fs";
import { CELL_AXES_ANCHORS, anchorHitLines, anchorGroupKey } from "./scripts/cell-axes-anchors.mjs";
const cache = new Map();
const linesOf = (p) => { if (!cache.has(p)) cache.set(p, readFileSync(p, "utf8").split("\n")); return cache.get(p); };
const want = [
  ["toolOutputs","write",0,"src/loop/orchestrator.js"],
  ["compactionStats","write",0,"src/loop/orchestrator.js"],
  ["pendingToolUses","read",0,"src/loop/resume-manager.js"],
  ["pendingToolUse","read",0,"src/loop/resume-manager.js"],
  ["executedToolIds","read",0,"src/loop/resume-manager.js"],
  ["toolResults","read",0,"src/loop/resume-manager.js"],
  ["persistedTranscriptLength","read",0,"src/loop/resume-manager.js"],
  ["partialText","read",0,"src/loop/resume-manager.js"],
];
for (const [key, axis, row, path] of want) {
  const gk = anchorGroupKey(key, axis, row, path);
  const set = new Set();
  for (const e of CELL_AXES_ANCHORS) {
    if (anchorGroupKey(e.key, e.axis, e.row ?? 0, e.codePath) !== gk) continue;
    const r = anchorHitLines(linesOf(e.codePath), e);
    for (const l of r.hits ?? []) set.add(l);
  }
  console.log(gk, "->", [...set].sort((a,b)=>a-b).join(","));
}
