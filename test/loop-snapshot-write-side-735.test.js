// issue #735 切片 1 ·**run snapshot 写侧字段面**的常驻用例。
//
// 这一格测的是「引擎往 `saveRunSnapshot` 交的那份 payload 里**有哪些格**」，不是恢复行为。
// 停写零读者字段的动机是写侧去冗余（重复的等值副本 / 全仓无人读的格），而它的**唯一可观察面**
// 就是这里——没有本文件，「停写」这件事与「手滑把格名写错一位」在测试里不可区分。
//
// ⚠ 口径演进（#735 切片 1 当时实跑复核只有 2 格成立，另两格有测试侧真读者；那批读者已在
//   **issue #770** 里换了指纹 ⇒ 四格现在全部停写）：
//   · 已停写（#735）：`toolUse`（它与 `pendingToolUse` 是**两次独立 `cloneState()` 仍同一个源值**，内容等值
//     但不同址；全仓无属性访问面读它）、`ts`（读侧那个 `ts` 是**账本行 / 消息行**的，不是快照这一格）。
//     ⇒ 零读者的证据是**面**而不是名字：恢复侧读快照对象那一层只出现 9 个字段 ——
//     `grep -rnE "resumeRunSnapshot\??\." src/ | wc -l` 量得**按行计 31 处命中**（按匹配个数是 32：
//     `src/loop/resume-manager.js:387` 一行上有两处 ⇒ 口径写清，不摆裸数字），字段穷举则是
//     `grep -rhoE "resumeRunSnapshot\??\.[a-zA-Z]+" src/ | sed 's/.*\.//' | sort -u` 得
//     `executedToolIds` / `messages` / `partialRound` / `partialText` / `pendingToolUse` / `pendingToolUses`
//     / `round` / `toolOutputs` / `toolResults`，里面没停写的这几格。两条都是 **ERE**，且先在
//     一个已知会命中的样本上验过：`printf 'x = resumeRunSnapshot.round;\ny = ctx.resumeRunSnapshot?.messages;\n'`
//     pipe 给 `grep -cE "resumeRunSnapshot\??\."` 答 2，而本文件前一版写的 BRE
//     `grep -c "resumeRunSnapshot\\(?:\\?\\)\."` 只答 1（静默漏掉可选链那一行），src/ 上是 5 行 vs 31 行
//     ——少结果与空结果一样，不验模式就不能当证据。
//   · 已停写（#770）：`status` 与 `compactionStats`。当时挡住它们的 5 处测试侧读者全部改指**权威来源**
//     之后才动写侧：分辨调用点改看载荷自带的引擎事实（成功执行只进 `executedToolIds`，被拒 / 被拦
//     才在结果条目上打 `toolResult.erix.executionStatus`），崩溃夹具与注入失败开关同理；
//     `compactionStats` 的落盘面改读 run-state 的
//     `deterministic.compactionStats` 与轮记录。引擎侧唯一的读者（分类通道对载荷的嗅探）也换成调用点
//     显式声明（`persistClassified(method, status, …)`），入参 `status` 与全仓 7 个调用点一律不动。
//
// ⚠ 本文件**不声称字节往返**语义，除了那一条名字里写明「file store」的用例：过 memory store + 
//   `deepEqual` 的那条证的只是**对象结构等值**（`assert/strict` 的对象比较本来就不看键序）。
//   file store 那条断言的也是较窄的一面：**读旧档不改写盘上字节**（外加对象等值），不是
//   「写出去再读回来逐字节相同」那种往返（读侧根本不写）。键序另由保留格键序对账那条钉。
//
// `persistedTranscriptLength` 与 `messages` 属切片 2（前者有 3 处真读者当截账本夹具的 anchor），
// 本切片原样写出，所以在 PRESENT 里。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createFileTranscriptStore, safeRunId } from "../src/store/file.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { foldLedgerMessages } from "../src/store/message-rows.js";
import { makeTmp } from "./helpers/tmp.js";
import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const READ_FILE_SCHEMA = {
  name: "readFile",
  description: "Read a file",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

const TOOL_BLOCK = { type: "tool_use", id: "call-735", name: "readFile", input: { path: "a.txt" } };

const CRASH_RUN_ID = "snapshot-write-side-735-crash";

/**
 * 抓一次**真实** run 的写侧 payload（不手搓快照）：跑「一轮工具调用 + 一轮收尾」，
 * 把引擎亲自交给 `saveRunSnapshot` 的每一条都记下来。
 */
async function captureWriteSidePayloads() {
  const store = createMemoryTranscriptStore();
  const payloads = [];
  const saveRunSnapshot = store.saveRunSnapshot.bind(store);
  store.saveRunSnapshot = async (runId, snapshot) => {
    payloads.push(structuredClone(snapshot));
    return saveRunSnapshot(runId, snapshot);
  };

  const result = await runDirect({
    provider: createFakeProvider([
      { content: [TOOL_BLOCK], stopReason: "tool_use" },
      { content: [{ type: "text", text: "读完了" }], stopReason: "end_turn" },
      // 收尾确认那一轮还会再要一次响应（不给就会 script exhausted，run 以 failed 收场）。
      { content: [{ type: "text", text: "读完了" }], stopReason: "end_turn", times: 3 },
    ]),
    tools: [READ_FILE_SCHEMA],
    executeTool: async () => ({ content: "a.txt 的内容" }),
    store,
    runId: "snapshot-write-side-735",
    maxRounds: 4,
    initialUserMessage: "读一下 a.txt",
  });

  assert.ok(payloads.length > 0, "引擎必须真的写过 run snapshot（否则下面的字段面断言是空的）");
  assert.equal(result.finalText, "读完了", "run 必须正常收口（否则现场是个 failed 的 run）");
  // issue #735 切片 2：`messages` 只带轮残余 ⇒ 崩溃现场的「已落盘前缀」只能从账本取（新契约）。
  return { payloads, result, transcript: foldLedgerMessages(await store.load("snapshot-write-side-735"))
    .map((entry) => entry.message) };
}

/** 取「带在飞工具调用」那一条：它才是格最全的写侧现场。 */
function fullestPayload(payloads) {
  return payloads.reduce(
    (best, entry) => (Object.keys(entry).length > Object.keys(best).length ? entry : best),
    payloads[0],
  );
}

// ── 判据 1：写侧字段面（缺省格 + 保留格）─────────────────────────────────────────

test("#735 切片 1 + #770：写侧 payload 不再带 toolUse / ts / status / compactionStats 这四格零读者字段", async () => {
  const { payloads } = await captureWriteSidePayloads();
  for (const payload of payloads) {
    // #827 第 5 刀：`partialText` / `partialRound` 也进了停写清单（半截正文只落账本恢复行）。
    for (const stopped of ["toolUse", "ts", "status", "compactionStats",
      "partialText", "partialRound"]) {
      assert.ok(
        !Object.hasOwn(payload, stopped),
        `\`${stopped}\` 已停写，不该出现在写侧 payload 里（实测 keys：${JSON.stringify(Object.keys(payload))}）`,
      );
      assert.equal(payload[stopped], undefined, `\`${stopped}\` 的取值也必须是 undefined`);
    }
  }
});

test("#735 切片 1：有读者的格照旧写出（含与停写的 toolUse 同源的 pendingToolUse）", async () => {
  const { payloads } = await captureWriteSidePayloads();
  const payload = fullestPayload(payloads);

  // `pendingToolUse` 是 `toolUse` 停写后**唯一**留在快照里的在飞调用格：恢复侧
  // （`src/loop/resume-manager.js`）读的就是它 + `pendingToolUses` 的 fallback。
  for (const kept of [
    "round",
    "pendingToolUse",
    "pendingToolUses",
    "messages",
    "persistedTranscriptLength",
    "executedToolIds",
    "toolResults",
    "toolOutputs",
  ]) {
    assert.ok(
      Object.hasOwn(payload, kept),
      `\`${kept}\` 必须继续写出（实测 keys：${JSON.stringify(Object.keys(payload))}）`,
    );
  }

  // `toolUse` 从前与 `pendingToolUse` 是从**同一个源值各自 clone 一份**（两次 `cloneState()` 调用，
  // 内容等值但不同址）：停写的正当理由是「无人读它」，
  // 不是「它没值」。所以 `pendingToolUse` 必须仍是那份带 replay 声明的真值。
  const withPending = payloads.find((entry) => entry.pendingToolUse?.id === TOOL_BLOCK.id);
  assert.ok(withPending, "必须有一条快照带着在飞的 tool_use.id");
  assert.ok(
    withPending.pendingToolUse.replay === "safe" || withPending.pendingToolUse.replay === "unsafe",
    `pendingToolUse 必须带 replay 声明（恢复侧按它决定补跑），实测 ${JSON.stringify(withPending.pendingToolUse.replay)}`,
  );
  assert.equal(
    withPending.pendingToolUses?.some((entry) => entry.id === TOOL_BLOCK.id),
    true,
    "pendingToolUses 也必须带着同一条调用（它才是恢复侧的第一顺位读点）",
  );
});

test("#770：`status` 这格停写之后，调用点仍只靠载荷里的引擎事实分辨（指纹没丢）", async () => {
  const { payloads } = await captureWriteSidePayloads();
  // 格子本身必须彻底不在载荷里——哪怕调用点照旧把状态交了（那是 #178 的入参，不是盘上的格）。
  assert.ok(payloads.every((entry) => !Object.hasOwn(entry, "status")),
    `写侧不得再写出 status 格，实测 ${JSON.stringify(payloads.map((entry) => entry.status))}`);
  // #178 的映射换成引擎事实后必须仍能二分：工具前 = 在飞调用未结清（无已执行 id、无 tool_result），
  // 工具后 = 那条调用进了 `executedToolIds` 并且结果条目与它配对。（`erix.executionStatus` 只写在
  // **被拒 / 被拦 / 被中断**的结果上，成功执行的那一份证据只有 `executedToolIds`。）
  const pre = payloads.filter((entry) => (entry.pendingToolUses?.length ?? 0) > 0
    && (entry.toolResults?.length ?? 0) === 0 && (entry.executedToolIds?.length ?? 0) === 0);
  assert.ok(pre.length > 0, `必须仍有「工具前」调用点（旧 status:"pending"），实测 ${JSON.stringify(payloads.map((entry) => entry.executedToolIds))}`);
  const post = payloads.filter((entry) => (entry.executedToolIds?.length ?? 0) > 0);
  assert.ok(post.length > 0, `必须仍有「工具后」调用点（旧 status:"executed"），实测 ${JSON.stringify(payloads.map((entry) => entry.executedToolIds))}`);
  assert.ok(post.every((entry) => (entry.toolResults ?? []).some((item) =>
    entry.executedToolIds.includes(item.toolUseId))),
    "工具后那几条必须能在 executedToolIds + 与之配对的 toolResults 里看出调用已结清");
});

// ── 历史旧快照兼容 + 新形状可读：停写不等于读侧停止容忍──────────────────────

test("#735 切片 1：带着 toolUse / ts 的**旧**快照过内存 store 仍结构等值读回（对象值面，不是字节面）", async () => {
  const store = createMemoryTranscriptStore();
  // 一份 0.31 之前落盘的旧快照：那 4 格全在，外加恢复侧真正要的格。
  const legacySnapshot = {
    round: 1,
    status: "pending",
    pendingToolUse: { ...TOOL_BLOCK, replay: "unsafe" },
    toolUse: { ...TOOL_BLOCK, replay: "unsafe" },
    pendingToolUses: [{ ...TOOL_BLOCK, replay: "unsafe" }],
    messages: [],
    persistedTranscriptLength: 2,
    executedToolIds: [],
    toolResults: [],
    toolOutputs: [],
    compactionStats: [{ compacted: false, foldedRounds: 0 }],
    ts: "2026-01-01T00:00:00.000Z",
  };
  await store.saveRunSnapshot("legacy-snapshot-735", legacySnapshot);

  const loaded = await store.loadLatestRunSnapshot("legacy-snapshot-735");
  // ⚠ 本例走的是 **memory store + deepEqual** ⇒ 它证的是**对象结构等值**（`assert/strict` 的对象比较
  // 本来就不看键序），不是落盘字节。「读旧档不改写盘上字节」由下面那条 file store 用例钉。
  assert.deepEqual(loaded, legacySnapshot, "store 层对旧快照必须原样透传（不因新写侧形状而删格）");
  // 旧档的那两格还在 ⇒ 任何拿 `snapshot.toolUse` 兜底的宿主/旧读侧继续拿到它们，不被逆期改写。
  assert.deepEqual(loaded.toolUse, { ...TOOL_BLOCK, replay: "unsafe" });
  assert.equal(loaded.ts, "2026-01-01T00:00:00.000Z");
});

test("#735 切片 1：file store 上手写的旧档过读取仍原样保留（读侧不改写盘上字节：那两格不被改也不被删）", async () => {
  // 这一条托的是那句较窄但为真的话：**读旧档不改写盘上字节**——不是「写出→读回逐字节相同」的往返
  // （读侧根本不写）。做法是把手写的**旧形状 JSON** 落在 file store 的快照路径上
  // （模拟 0.31 之前落盘的那堆字节），再让读侧去读它。
  const dir = await makeTmp("snap735-legacy-");
  const store = createFileTranscriptStore({ dir });
  const legacySnapshot = {
    round: 1,
    status: "executed",
    pendingToolUse: { ...TOOL_BLOCK, replay: "unsafe" },
    toolUse: { ...TOOL_BLOCK, replay: "unsafe" },
    pendingToolUses: [{ ...TOOL_BLOCK, replay: "unsafe" }],
    messages: [],
    persistedTranscriptLength: 2,
    executedToolIds: [TOOL_BLOCK.id],
    toolResults: [],
    toolOutputs: [],
    compactionStats: [{ compacted: false, foldedRounds: 0 }],
    ts: "2026-01-01T00:00:00.000Z",
  };
  const raw = `${JSON.stringify(legacySnapshot)}\n`;
  const target = join(dir, `${safeRunId("legacy-file-735")}.snapshot.json`);
  await writeFile(target, raw, "utf8");

  const loaded = await store.loadLatestRunSnapshot("legacy-file-735");
  assert.deepEqual(loaded, legacySnapshot, "旧档过 file store 读取必须原样给出（对象面）");
  assert.ok(loaded.toolUse !== undefined && loaded.ts !== undefined,
    "已停写的两格在**旧档**里必须还在（停写只影响新写，不影响旧档）");
  // 字节面：读侧不许改写盘上的旧档（这条是上面那条 deepEqual 给不了的）。
  assert.equal(await readFile(target, "utf8"), raw, "旧档文件字节必须不被读侧改写");
});

test("#735 切片 1：保留格的**键序**不动（file store 直接 stringify ⇒ 键序是宿主可见的落盘字节）", async () => {
  // 两片在 payload 上的净改动应当是「只删四行」。基点的键序减去停写的 `toolUse` / `ts` /
  // `status` / `compactionStats` 逐位对账；把任何保留格挪个位置就会在这里红。
  const { payloads } = await captureWriteSidePayloads();
  const expectedOrder = [
    "round",
    "pendingToolUse",
    "pendingToolUses",
    "messages",
    "persistedTranscriptLength",
    "executedToolIds",
    "toolResults",
    "toolOutputs",
  ];
  for (const payload of payloads) {
    const keys = Object.keys(payload).filter((key) => key !== "partialText" && key !== "partialRound");
    assert.deepEqual(keys, expectedOrder,
      `写侧键序必须等于「基点键序 minus #735 两格 minus #770 两格」（基点 src/loop/orchestrator.js:2882-2899），实测 ${JSON.stringify(keys)}`);
    assert.ok(!keys.includes("toolUse") && !keys.includes("ts")
      && !keys.includes("status") && !keys.includes("compactionStats"));
  }
});

test("#735 切片 1 + #770：引擎亲笔写下的**新形状**崩溃现场（已无那四格）照样能被 resume 消费", async () => {
  // 不手锤崩溃现场（手锤很容易造出「tool_result 没有配对 tool_use」这类非法上下文）：
  // 拿**引擎自己写下**的那条带在飞调用的快照当现场，它已经是新形状。
  const { payloads, transcript } = await captureWriteSidePayloads();
  // 取**工具前**那条写点：那里在飞调用还没结清（`toolResults` 空），恢复侧只能从
  // `pendingToolUses` / `pendingToolUse` 重建它 —— 正是「已停写的 `toolUse` 不在链路上」的判别面。
  const crash = payloads.find((entry) => (
    (entry.pendingToolUses?.length ?? 0) > 0
    && (entry.toolResults?.length ?? 0) === 0
    && (entry.executedToolIds?.length ?? 0) === 0
  ));
  assert.ok(crash, `现场必须有一条「在飞且未结清」的快照，实测 ${JSON.stringify(payloads.map((entry) => ({
    callSite: (entry.executedToolIds?.length ?? 0) === 0 ? "pre-execution" : "post-execution",
    pending: entry.pendingToolUses?.length ?? 0,
    results: entry.toolResults?.length ?? 0,
  })))}`);
  for (const stopped of ["toolUse", "ts", "status", "compactionStats"]) {
    assert.ok(!Object.hasOwn(crash, stopped), `现场快照应当是新形状（无 \`${stopped}\`）`);
  }

  // 账本截到快照锚点（= 结果已产出、还没落账的崩溃时刻），与
  // `test/loop-invalid-arguments.test.js` 的截账本夹具同一口径。
  const anchor = crash.persistedTranscriptLength;
  assert.ok(Number.isSafeInteger(anchor) && anchor >= 1, `锚点应当已含已落盘正文（实测 ${anchor}）`);
  const store = createMemoryTranscriptStore();
  assert.ok(transcript.length >= anchor,
    `账本必须已经落盘到快照锚点（账本 ${transcript.length} 条 vs 锚点 ${anchor}）`);
  await store.appendRound(CRASH_RUN_ID, { round: 0, messages: structuredClone(transcript.slice(0, 1)) });
  await store.appendRound(CRASH_RUN_ID, { round: 1, messages: structuredClone(transcript.slice(1, anchor)) });
  await store.saveRunSnapshot(CRASH_RUN_ID, { ...crash, persistedTranscriptLength: anchor });

  let replayed = 0;
  const resumed = await runDirect({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "接着跑完了" }], stopReason: "end_turn", times: 3 },
    ]),
    tools: [READ_FILE_SCHEMA],
    executeTool: async () => {
      replayed += 1;
      return { content: "补跑结果" };
    },
    store,
    runId: CRASH_RUN_ID,
    maxRounds: 3,
    resume: true,
    initialUserMessage: "继续",
  });

  assert.ok(resumed, "新形状（无 toolUse / ts）的快照必须照常恢复出一次 run");
  // 默认 `replayPolicy: "always-replay"`：现场那条未结清的调用必须被补跑，
  // 而它能被补跑只可能是因为读的是 `pendingToolUses`（`toolUse` 已经不在这份快照里）。
  assert.ok(replayed > 0, "现场里那条在飞调用必须被恢复侧补跑（证明链路不依赖已停写的 toolUse）");
});
