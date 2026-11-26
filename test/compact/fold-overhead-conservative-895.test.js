// issue #895：声明的摘要开销是**同步可达的上界**，且故意保守。
//
// 选择器在摘要还不存在时就要知道开销，只能用同步算得出来的那部分（TTL stub + 字面量 recoveryHint）；
// 生产路径随后跑 `resolveFoldStubs`（含宿主 `stubFor`）与 `resolveFoldRecoveryHint`（解析函数形态），
// 所以宿主给了这两个钩子时**真实摘要 > 声明的上界** ⇒ 选择器略早停手、落点高于 0.65 目标。
//
// 本文件钉的就是这个**方向**（不是精确值）：估 <= 实。方向反了才是缺陷——那意味着声明值不是上界，
// 选择器会以为自己已经达标而停手，实际仍超目标。
import test from "node:test";
import assert from "node:assert/strict";

import { summarizeFoldedPayload } from "../../src/compact/fold-statistical.js";
import { collectTtlFoldStubs } from "../../src/compact/helpers.js";
import { estimateTokens } from "../../src/tokens.js";

/** 造 `rounds` 轮，每轮一条大 tool_result（可被 TTL 折成 stub）。 */
function roundsOf(count, textSize = 1200) {
  return Array.from({ length: count }, (_, index) => ({
    round: index + 1,
    messages: [
      { role: "user", content: `第${index + 1}轮任务` },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: `tu-${index + 1}`, name: "exec", input: { cmd: `step-${index + 1}` } }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: `tu-${index + 1}`,
          content: `输出-${index + 1} ` + "x".repeat(textSize),
        }],
      },
    ],
  }));
}

test("#895 宿主 stubFor + 函数形态 recoveryHint ⇒ 声明的同步上界 <= 真实摘要（方向必须是保守）", async () => {
  const rounds = roundsOf(8);
  const folded = rounds.slice(0, 5);

  // 生产路径：异步解析器会调宿主 stubFor，并把函数形态的 recoveryHint 解出来。
  const hostStub = (message) => `[宿主持久化桩] ${"很长的桩文本".repeat(30)}`;
  const resolvedHint = "宿主解析出来的恢复提示（比函数对象本身长得多）";

  const realText = summarizeFoldedPayload(folded.flatMap((round) => round.messages), {
    from: 1,
    to: folded.length,
    count: folded.length,
    stubs: folded.flatMap((round) => round.messages).map((message) => hostStub(message)),
    recoveryHint: resolvedHint,
  });
  const realTokens = estimateTokens(realText);

  // 选择器侧：只能用同步可达的那部分（TTL stub + 字面量 hint 缺席 ⇒ 空）。
  const declaredText = summarizeFoldedPayload(folded.flatMap((round) => round.messages), {
    from: 1,
    to: folded.length,
    count: folded.length,
    stubs: [...new Set(collectTtlFoldStubs(folded.flatMap((round) => round.messages)))],
    // 函数形态 ⇒ 同步侧拿不到字符串（这正是 #895 说的那条边界）。
    recoveryHint: undefined,
  });
  const declaredTokens = estimateTokens(declaredText);

  assert.ok(
    declaredTokens <= realTokens,
    `声明的同步上界必须 <= 真实摘要（否则选择器会以为自己达标）：declared=${declaredTokens} real=${realTokens}`,
  );
});
