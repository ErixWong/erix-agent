// Recall 契约测试套件（ADR-015：一个档案、一个通道）
//
// 测的是「引擎 recall 工具架在 TranscriptStore 之上」的完整承诺——
// 输出卫生的 stub 配方（recall({round:N, pattern:"关键词"})）调用的是工具，
// 不是 store.recall，所以契约以工具行为为准：
//   1. 归档输出（record.toolOutputs）按字节保真可取回，超长输出的尾部必须可命中
//   2. pattern 支持正则交替（stub 配方用 "a|b|c" 形态）
//   3. round 范围与配方里的 round 语义一致，不串轮
//   4. 折叠原文（foldedPayload）在档可取回
//   5. 未命中诚实报"未命中"，不编内容
//   6. store 无 recall 通道时经 load 回退，承诺不降级
//
// 用法（项目侧适配器对拍）：
//   import { recallContract } from "erix-agent/contract-tests";
//   recallContract("touwaka", () => createTouwakaTranscriptStore(...));
//
// 实现特有行为（有界窗口、连接管理）由实现方自行补充测试，不进契约。

import test from "node:test";
import assert from "node:assert/strict";

import { createRecallTool } from "../../src/tools/recall.js";

const TAIL_MARK = "TAIL-5999-6000-END";

function execRecord(round, output, { toolUseId = `tool-${round}` } = {}) {
  return {
    round,
    ts: "2026-09-17T00:00:00.000Z",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "exec", input: { command: "make noise" } }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: output.length > 40 ? output.slice(0, 40) : output,
          replayable: false,
        }],
      },
    ],
    toolOutputs: [{ toolUseId, name: "exec", content: output }],
  };
}

export function recallContract(label, createStore) {
  test(`${label}: recall 归档输出按字节保真可取回（含超长输出尾部）`, async () => {
    const store = await createStore();
    const oversized = `nonce=head-is-here\n${"x".repeat(5000)}\n${TAIL_MARK}\n`;
    await store.appendRound("run-1", execRecord(1, oversized));
    const tool = createRecallTool({ store, runId: "run-1" });

    // stub 只给头部 4096 字符；尾部特征必须经 recall 命中——这是输出卫生的取回承诺
    const result = await tool.execute({ pattern: TAIL_MARK });
    assert.match(result, /TAIL-5999-6000-END/u);
    assert.match(result, /nonce=head-is-here/u);
  });

  test(`${label}: pattern 支持正则交替（stub 配方 "a|b|c" 形态）`, async () => {
    const store = await createStore();
    await store.appendRound("run-1", execRecord(1, "5997\n5998\n5999\n6000\n"));
    const tool = createRecallTool({ store, runId: "run-1" });

    const result = await tool.execute({ pattern: "5998|5999|6000" });
    assert.match(result, /5998/u);
    assert.match(result, /5999/u);
    // 未出现在交替里的行不因此报错即可，不要求缺席
  });

  test(`${label}: round 范围语义与配方一致，不串轮`, async () => {
    const store = await createStore();
    await store.appendRound("run-1", execRecord(1, "round-one-marker\n"));
    await store.appendRound("run-1", execRecord(2, "round-two-marker\n"));
    const tool = createRecallTool({ store, runId: "run-1" });

    const onlyRoundTwo = await tool.execute({ pattern: "round-.*-marker", fromRound: 2, toRound: 2 });
    assert.match(onlyRoundTwo, /round-two-marker/u);
    assert.doesNotMatch(onlyRoundTwo, /round-one-marker/u);

    const onlyRoundOne = await tool.execute({ fromRound: 1, toRound: 1 });
    assert.match(onlyRoundOne, /round-one-marker/u);
    assert.doesNotMatch(onlyRoundOne, /round-two-marker/u);
  });

  test(`${label}: 折叠原文在档可取回`, async () => {
    const store = await createStore();
    await store.appendRound("run-1", {
      round: 1,
      ts: "2026-09-17T00:00:00.000Z",
      folded: true,
      foldedPayload: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "folded-secret=Abc123\n" }] },
      ],
      messages: [{ role: "assistant", content: [{ type: "text", text: "folded" }] }],
    });
    const tool = createRecallTool({ store, runId: "run-1" });
    const result = await tool.execute({ pattern: "folded-secret" });
    assert.match(result, /folded-secret=Abc123/u);
  });

  test(`${label}: 未命中诚实报"未命中"，不编内容`, async () => {
    const store = await createStore();
    await store.appendRound("run-1", execRecord(1, "real-content=1\n"));
    const tool = createRecallTool({ store, runId: "run-1" });

    const miss = await tool.execute({ pattern: "completely-absent-token" });
    assert.doesNotMatch(miss, /real-content/u);
    assert.match(miss, /未命中/u);

    const emptyRun = await createRecallTool({ store, runId: "missing-run" })
      .execute({ pattern: "anything" });
    assert.doesNotMatch(emptyRun, /real-content/u);
  });

  test(`${label}: offset 分页稳定（重复调用取到后续段）`, async () => {
    const store = await createStore();
    const many = Array.from({ length: 12 }, (_, i) => `hit-line-${i}`).join("\n");
    await store.appendRound("run-1", {
      round: 1,
      ts: "2026-09-17T00:00:00.000Z",
      messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
      toolOutputs: [{ toolUseId: "t1", name: "exec", content: many }],
    });
    const tool = createRecallTool({ store, runId: "run-1" });

    const first = await tool.execute({ pattern: "hit-line-\\d+" });
    const second = await tool.execute({ pattern: "hit-line-\\d+", offset: 11 });
    assert.doesNotMatch(first, /hit-line-11/u);
    assert.match(second, /hit-line-11/u);
  });

  test(`${label}: 无参调用返回概览（不抛错、含 round 信息）`, async () => {
    const store = await createStore();
    await store.appendRound("run-1", execRecord(1, "irrelevant\n"));
    const tool = createRecallTool({ store, runId: "run-1" });
    const overview = await tool.execute({});
    assert.match(overview, /round 1/u);
  });

  test(`${label}: store 无 recall 通道时经 load 回退，承诺不降级`, async () => {
    const store = await createStore();
    // 包一层剥掉 recall 通道，模拟最小实现（只有 append/load）
    const bare = {
      appendRound: store.appendRound.bind(store),
      load: store.load.bind(store),
    };
    const oversized = `nonce=alt\n${"y".repeat(5000)}\n${TAIL_MARK}\n`;
    await bare.appendRound("run-1", execRecord(1, oversized));
    const tool = createRecallTool({ store: bare, runId: "run-1" });

    const result = await tool.execute({ pattern: TAIL_MARK });
    assert.match(result, /TAIL-5999-6000-END/u);
    const range = await tool.execute({ fromRound: 1, toRound: 1 });
    assert.match(range, /nonce=alt/u);
  });
}
