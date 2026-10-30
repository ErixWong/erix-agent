// issue #626（C1）—— `delegate` 的 `action="tail"`：父 run 读「子 run 现在在干什么」。
//
// 覆盖（工单清单）：
//   1. **离线端到端**：父 `runToolLoop` 挂 `createDelegateTool`，`runChild` 是**嵌套的真
//      `runToolLoop`**（脚本化假 provider + 真文件 transcript store），跑完 `tail` 断言 rows 里
//      含子 run 的**工具名**与它的**正文片段**；
//   2. `limit` 超上限被夹到 20、`textLimit` 超硬上限被夹到 1000，且 `truncated` 正确；
//   3. 尾部塞一行半截 JSON ⇒ `partial: true`、不抛、前面的好行还在；
//   4. 三种失败**分得开**：名册记录不在 ⇒ `not_found`；记录里没有 `transcriptPath` ⇒
//      `no_transcript_path`（宿主没接 `transcriptPathFor`，**配置缺陷**）；有路径但文件不在/打不开
//      ⇒ `no_transcript`（子还没落盘 / 档案已清理，**正常时序**）。三个理由不许混成一个——真机
//      现场就是把「宿主没接」读成了「子没干活」（#626 C1）；
//   5. **跨进程可读**：手写名册记录 + transcript 文件（完全不经过 `createDelegateTool` 的 owned
//      登记）⇒ `tail` 仍读得到——这条是「tail 不像 cancel」的钉子；
//   6. `tail` 的返回里 `state` / `updatedAt` 与名册一致。
//
// 离线：零网络、零 `~/.erix`、零真实子进程；临时目录一律走 `test/helpers/tmp.js` 的 `makeTmp(...)`。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { listRecords, readRecord, writeRecord } from "../src/tools/delegation/roster.js";
import { TAIL_LIMIT_DEFAULT, TAIL_LIMIT_MAX, TAIL_TEXT_LIMIT_MAX, tailChildTranscript } from "../src/tools/delegation/tail.js";
import { createDelegateTool } from "../src/tools/delegation/tool.js";

/** 一条「消息行」——形状照 `src/loop/orchestrator.js#appendMessageRowToTranscript` 的落盘形态。 */
function messageRow(runId, round, seq, messages) {
  return {
    round,
    roundKey: `${runId}:round:${round}`,
    dedupKey: `${runId}:msg:${round}:${seq}`,
    kind: "message",
    seq,
    messages,
    ts: new Date().toISOString(),
  };
}

/** 把若干行写成一个 transcript 文件（JSONL；最后一行是否带换行由调用方决定）。 */
async function writeTranscript(path, rows, { trailingNewline = true } = {}) {
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(path, trailingNewline ? `${body}\n` : body, "utf8");
  return path;
}

/** 一条「子 run 刚跑完一个工具」的最小 transcript（30 行正文，用来测夹限）。 */
function manyRows(runId, count) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(messageRow(runId, index + 1, 0, [
      { role: "assistant", content: [{ type: "text", text: `row-${index}-${"x".repeat(2000)}` }] },
    ]));
  }
  return rows;
}

// ================================================================ 0. 宿主旋钮 transcriptPathFor（#626 C1 的根因修复）

test("delegate transcriptPathFor: 创建记录时一次写就把 transcriptPath 落盘；不给则字段缺省（向后兼容）", async () => {
  const dir = await makeTmp("delegate-txpathfor-626-");

  // ① 给了旋钮：queued 记录里就带着它（runChild 里读到的那一眼就是「创建即写入」的判据）
  /** @type {*} */
  let seenInChild;
  const withKnob = createDelegateTool({
    rosterDir: dir,
    transcriptPathFor: (runId) => `/somewhere/${runId}.jsonl`,
    runChild: async ({ runId }) => {
      seenInChild = readRecord(dir, runId);
      return { text: "ok", termination: "end_turn" };
    },
  });
  const ran = await withKnob.execute({ action: "run", task: "t" }, { runId: "parent-x" });
  assert.equal(ran.ok, true);
  assert.equal(seenInChild.transcriptPath, `/somewhere/${ran.runId}.jsonl`, "runChild 起手时字段就必须在");
  // 终态写回不丢 opaque 字段（finishRun 保留 previous）
  assert.equal(readRecord(dir, ran.runId).transcriptPath, `/somewhere/${ran.runId}.jsonl`);

  // ② 不给旋钮：字段照旧缺省（旧宿主一字不改也不会破），tail 则报 no_transcript_path
  const without = createDelegateTool({
    rosterDir: dir,
    runChild: async () => ({ text: "ok", termination: "end_turn" }),
  });
  const plain = await without.execute({ action: "run", task: "t" }, { runId: "parent-y" });
  assert.equal(readRecord(dir, plain.runId).transcriptPath, undefined, "没接旋钮就不许凭空造一个路径");
  const tail = await without.execute({ action: "tail", runId: plain.runId });
  assert.equal(tail.reason, "no_transcript_path", "没接旋钮的宿主应该看到配置缺陷，不是「子没干活」");

  // ③ 形状拒绝：非函数 / 返回非非空字符串（宿主 bug 当场抛，不留「租约已拿、记录没建」的孤儿）
  assert.throws(
    () => createDelegateTool({ rosterDir: dir, runChild: async () => ({ text: "x" }), transcriptPathFor: "/tmp/x.jsonl" }),
    /transcriptPathFor 必须是函数/u,
  );
  const badValue = createDelegateTool({
    rosterDir: dir,
    transcriptPathFor: () => "",
    runChild: async () => ({ text: "x" }),
  });
  await assert.rejects(
    () => badValue.execute({ action: "run", task: "t" }, { runId: "parent-z" }),
    /transcriptPathFor\(.+\) 必须返回非空字符串/u,
  );
  // 抛之前没建记录、也没拿租约（否则后续派生会被空租约卡住）
  assert.deepEqual(listRecords(dir).records.filter((record) => record.runId.startsWith("sub-")).length, 2);
});

// ================================================================ 1. 真嵌套 e2e：tail 看得见子 run 的工具与正文

test("delegate tail e2e: 真嵌套子 run 跑完后，tail 的 rows 含子 run 的工具名与正文片段", async () => {
  const dir = await makeTmp("delegate-tail-617-");
  const transcripts = await makeTmp("delegate-tail-617-tx-");
  /** @type {string|null} */
  let childRunId = null;

  /**
   * 宿主装配的 runChild：**嵌套的真 runToolLoop** + 真文件 transcript store。
   * 名册里的 `transcriptPath` 是**宿主事实**（库不猜路径），所以宿主用工厂旋钮 `transcriptPathFor`
   * 登记它——#626 C1 之后这是**唯一**正路（手写 `writeRecord` 补字段就是上一轮那个「单测自己
   * 造路径、真装配零覆盖」的坑）。
   */
  async function runChildNestedLoop({ task, parentRunId, runId, signal }) {
    // 反向证：runChild 被调起来的时候，queued 记录**已经**带着 transcriptPath（创建即写入，
    // 不是「先建记录再补写第二遍」——那种写法在这里会读到 undefined）。
    const previous = readRecord(dir, runId);
    assert.ok(previous !== null, "queued 记录必须已经在册");
    assert.equal(
      previous.transcriptPath,
      join(transcripts, `${runId}.jsonl`),
      "transcriptPath 必须在创建记录的那一次写里就落盘（父立刻 tail 也读得到）",
    );
    childRunId = runId;
    try {
      const child = await runDirect({
        provider: createFakeProvider([
          {
            content: [{ type: "tool_use", id: "c1", name: "childProbe", input: { query: "needle" } }],
            stopReason: "tool_use",
          },
          { content: [{ type: "text", text: `child-final:${task}` }], stopReason: "end_turn" },
        ]),
        executeTool: async () => ({ ok: true, content: "child tool output body" }),
        tools: [{ name: "childProbe", description: "probe", inputSchema: { type: "object", properties: {} } }],
        store: createFileTranscriptStore({ dir: transcripts }),
        maxRounds: 3,
        completion: false,
        signal,
        config: { run: { runId, ...(parentRunId === undefined ? {} : { parentRunId }) } },
        seed: task,
      });
      return { text: child.finalText, termination: child.termination?.reason, verification: child.verification };
    } catch (error) {
      if (error?.termination?.reason !== undefined) {
        return { text: error.finalText ?? "", termination: error.termination.reason };
      }
      throw error;
    }
  }

  const delegate = createDelegateTool({
    runChild: runChildNestedLoop,
    rosterDir: dir,
    transcriptPathFor: (runId) => join(transcripts, `${runId}.jsonl`),
  });
  await runDirect({
    provider: createFakeProvider([
      {
        content: [{
          type: "tool_use",
          id: "d1",
          name: "delegate",
          input: { action: "run", task: "probe the child", background: false },
        }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "parent done" }], stopReason: "end_turn" },
    ]),
    executeTool: ({ name, input, context }) => (name === "delegate" ? delegate.execute(input, context) : "ok"),
    tools: [delegate.definition],
    maxRounds: 4,
    completion: false,
    config: { run: { runId: "delegate-tail-parent" } },
    seed: "delegate once",
  });

  assert.equal(typeof childRunId, "string", "runChild 必须被调用过");
  const tail = await delegate.execute({ action: "tail", runId: childRunId });
  assert.equal(tail.ok, true);
  assert.equal(tail.runId, childRunId);
  assert.equal(tail.state, "completed");
  assert.ok(Array.isArray(tail.rows) && tail.rows.length > 0, "tail 必须给出 rows");

  // ① 「子在跑哪个工具」——这是本切片存在的理由
  const toolRow = tail.rows.find((row) => row.kind === "tool_use");
  assert.ok(toolRow, `rows 里必须有 tool_use 行：${JSON.stringify(tail.rows)}`);
  assert.equal(toolRow.tool, "childProbe");
  assert.equal(toolRow.role, "assistant");
  assert.match(String(toolRow.argsDigest), /needle/);

  // ② 「正文片段」
  const texts = tail.rows.map((row) => String(row.text ?? ""));
  assert.ok(
    texts.some((text) => text.includes("child-final:probe the child")),
    `rows 里必须有子 run 的正文片段：${JSON.stringify(texts)}`,
  );
  assert.ok(texts.some((text) => text.includes("child tool output body")), "工具结果正文也必须在尾读里");
  // 行的形状是工单钉死的那一份（不给的字段不写，但 seq/kind/text 恒在）
  for (const row of tail.rows) {
    assert.equal(typeof row.seq, "number");
    assert.equal(typeof row.kind, "string");
    assert.equal(typeof row.text, "string");
  }
});

// ================================================================ 2. 夹限：20 行 / 1000 字符

test("delegate tail: limit 超上限夹到 20、textLimit 超硬上限夹到 1000，truncated 正确", async () => {
  const dir = await makeTmp("delegate-tail-clamp-");
  const runId = "clamp-run";
  const transcriptPath = await writeTranscript(join(dir, `${runId}.jsonl`), manyRows(runId, 30));

  const clamped = await tailChildTranscript({ transcriptPath, limit: 999, textLimit: 99999 });
  assert.equal(clamped.ok, true);
  assert.equal(clamped.rows.length, TAIL_LIMIT_MAX, `limit 必须夹到 ${TAIL_LIMIT_MAX}`);
  assert.equal(clamped.truncated, true, "还有更早的行没给 ⇒ truncated");
  for (const row of clamped.rows) {
    assert.ok(row.text.length <= TAIL_TEXT_LIMIT_MAX, `每行正文必须夹到 ${TAIL_TEXT_LIMIT_MAX}，实测 ${row.text.length}`);
  }
  assert.equal(clamped.rows[clamped.rows.length - 1].text.length, TAIL_TEXT_LIMIT_MAX, "2000 字符的正文必须被夹到硬上限");
  // 只回**最近**的行：最后一行是 row-29
  assert.match(clamped.rows[clamped.rows.length - 1].text, /^row-29-/);
  // seq 是本次返回里的行号（1 起、单调）
  assert.deepEqual(clamped.rows.map((row) => row.seq), Array.from({ length: TAIL_LIMIT_MAX }, (_, index) => index + 1));

  const defaults = await tailChildTranscript({ transcriptPath });
  assert.equal(defaults.rows.length, TAIL_LIMIT_DEFAULT, "缺省行数");
  assert.equal(defaults.truncated, true);
  for (const row of defaults.rows) assert.ok(row.text.length <= 300, "缺省每行 300 字符");

  // 合法范围内的 limit 原样生效，且文件读完了就没有 truncated
  const small = await tailChildTranscript({ transcriptPath, limit: 3 });
  assert.equal(small.rows.length, 3);
  assert.equal(small.truncated, true);
});

// ================================================================ 3. 半截尾行：partial、不抛、前面的好行还在

test("delegate tail: 尾部一行半截 JSON ⇒ partial:true、不抛、前面的好行还在", async () => {
  const dir = await makeTmp("delegate-tail-partial-");
  const runId = "partial-run";
  const rows = [
    messageRow(runId, 1, 0, [{ role: "assistant", content: [{ type: "text", text: "good-row-1" }] }]),
    messageRow(runId, 2, 0, [{ role: "assistant", content: [{ type: "text", text: "good-row-2" }] }]),
  ];
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  // 第三行是写盘进行中的半截（没有换行收尾、JSON 不完整）
  const transcriptPath = join(dir, `${runId}.jsonl`);
  await writeFile(transcriptPath, `${body}\n{"round":3,"kind":"message","seq":0,"messages":[{"role":"assist`, "utf8");

  const tail = await tailChildTranscript({ transcriptPath });
  assert.equal(tail.ok, true, "半截尾行不许把整次尾读打成失败");
  assert.equal(tail.partial, true, "尾部有解析不了的行 ⇒ partial");
  const texts = tail.rows.map((row) => row.text);
  assert.ok(texts.includes("good-row-1"), `前面的好行不许丢：${JSON.stringify(texts)}`);
  assert.ok(texts.includes("good-row-2"));
});

// ================================================================ 4a. 字段缺（配置缺陷）vs 记录不在

test("delegate tail: 名册记录缺 transcriptPath ⇒ no_transcript_path（宿主没接）；记录不在 ⇒ not_found", async () => {
  const dir = await makeTmp("delegate-tail-no-path-617-");
  const delegate = createDelegateTool({ runChild: async () => ({ text: "x" }), rosterDir: dir });

  // ① 名册记录不存在（压根没这个子 run）
  const notFound = await delegate.execute({ action: "tail", runId: "sub-does-not-exist" });
  assert.deepEqual(notFound, { ok: false, reason: "not_found", runId: "sub-does-not-exist" });

  // ② 记录在，但里面连 transcriptPath 都没有（宿主没落这个字段）⇒ **配置缺陷**，不是「子没干活」
  writeRecord(dir, { runId: "sub-no-path", state: "running", updatedAt: 1_000 });
  const noPath = await delegate.execute({ action: "tail", runId: "sub-no-path" });
  assert.equal(noPath.ok, false);
  assert.equal(noPath.reason, "no_transcript_path");
  assert.notEqual(noPath.reason, "not_found", "记录在就是记录在，不许报成没有这个子 run");
  assert.notEqual(noPath.reason, "no_transcript", "宿主没登记 ≠ 子还没落盘：两个理由不许混");
  // 失败时名册的 state / updatedAt 照旧带上（父靠它判断这条记录本身新不新）
  assert.equal(noPath.state, "running");
  assert.equal(noPath.updatedAt, 1_000);

  // ③ 直接调模块时同一套理由：路径缺 ⇒ no_transcript_path
  assert.deepEqual(
    await tailChildTranscript({}),
    { ok: false, reason: "no_transcript_path", transcriptPath: undefined },
  );
  assert.deepEqual(
    await tailChildTranscript({ transcriptPath: "" }),
    { ok: false, reason: "no_transcript_path", transcriptPath: "" },
  );
});

// ================================================================ 4b. 文件缺（正常时序）

test("delegate tail: 有 transcriptPath 但文件不在/打不开 ⇒ no_transcript（子还没落盘）", async () => {
  const dir = await makeTmp("delegate-tail-no-file-617-");
  const delegate = createDelegateTool({ runChild: async () => ({ text: "x" }), rosterDir: dir });
  const gone = join(dir, "gone.jsonl");

  // ① 记录里登记了路径，但文件不在（子 run 还没落第一行 / 档案已清理）
  writeRecord(dir, { runId: "sub-no-transcript", state: "running", updatedAt: 1_000, transcriptPath: gone });
  const noTranscript = await delegate.execute({ action: "tail", runId: "sub-no-transcript" });
  assert.equal(noTranscript.ok, false);
  assert.equal(noTranscript.reason, "no_transcript");
  assert.equal(noTranscript.transcriptPath, gone, "理由里要把那个找不到的路径带出来");
  assert.notEqual(noTranscript.reason, "not_found");
  assert.notEqual(noTranscript.reason, "no_transcript_path", "字段在就不是配置缺陷");

  // ② 直接调模块：文件不在 ⇒ no_transcript（无 detail：那是「不在」，不是「打不开」）
  assert.deepEqual(
    await tailChildTranscript({ transcriptPath: join(dir, "nope.jsonl") }),
    { ok: false, reason: "no_transcript", transcriptPath: join(dir, "nope.jsonl") },
  );

  // ③ 「打不开」（路径是个目录）也归 no_transcript，但带 detail——它与「子还没写」不同类
  const asDirectory = join(dir, "a-directory.jsonl");
  await mkdir(asDirectory, { recursive: true });
  const unreadable = await tailChildTranscript({ transcriptPath: asDirectory });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.reason, "no_transcript");
  assert.equal(typeof unreadable.detail, "string", "打不开时要带 detail，宿主才看得见原因");
});

// ================================================================ 5. 跨进程可读（tail 不像 cancel）

test("delegate tail: 手写名册记录 + transcript（未经 owned 登记）⇒ tail 读得到，cancel 读不到", async () => {
  const dir = await makeTmp("delegate-tail-xproc-");
  const runId = "sub-other-process";
  const transcriptPath = join(dir, `${runId}.jsonl`);
  await writeTranscript(transcriptPath, [
    messageRow(runId, 1, 0, [{ role: "assistant", content: [{ type: "text", text: "another process wrote this" }] }]),
  ]);
  // 「另一个进程」写下的名册记录：本实例从没跑过这个 runId，owned 表里没有它。
  writeRecord(dir, {
    runId,
    parentRunId: "some-other-parent",
    state: "running",
    transcriptPath,
    pid: 999_999,
    createdAt: 5_000,
    updatedAt: 6_000,
  });

  const delegate = createDelegateTool({ runChild: async () => ({ text: "x" }), rosterDir: dir });
  const tail = await delegate.execute({ action: "tail", runId });
  assert.equal(tail.ok, true, "tail 必须能读别的进程养的子（它不看 owned）");
  assert.equal(tail.rows.at(-1).text, "another process wrote this");
  assert.equal(tail.state, "running");

  // 钉子：同一个 runId，cancel 明确拒绝——这就是 tail 与 cancel 的关键差别。
  const cancel = await delegate.execute({ action: "cancel", runId });
  assert.deepEqual(cancel, { ok: false, reason: "not_owned", runId });
});

// ================================================================ 6. state / updatedAt 与名册一致

test("delegate tail: 返回里的 state / updatedAt 逐字等于名册记录", async () => {
  const dir = await makeTmp("delegate-tail-state-");
  const runId = "sub-state";
  const transcriptPath = await writeTranscript(join(dir, `${runId}.jsonl`), [
    messageRow(runId, 1, 0, [{ role: "assistant", content: [{ type: "text", text: "hello" }] }]),
  ]);
  const record = writeRecord(dir, {
    runId,
    state: "timeout",
    transcriptPath,
    createdAt: 7_000,
    updatedAt: 8_000,
    endedAt: 8_000,
  });

  const clock = () => 42_000;
  const delegate = createDelegateTool({ runChild: async () => ({ text: "x" }), rosterDir: dir, clock });
  const tail = await delegate.execute({ action: "tail", runId });
  assert.equal(tail.state, record.state);
  assert.equal(tail.updatedAt, record.updatedAt);
  assert.equal(tail.readAt, 42_000, "readAt 走宿主注入的时钟");
  assert.equal(tail.transcriptPath, transcriptPath);
  // 尾读是一次读：不许改写名册（不 reconcile、不推水位）
  assert.deepEqual(readRecord(dir, runId), record);
});
