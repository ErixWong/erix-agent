// issue #735 切片 2 ·**run snapshot 的 `messages` 只交「轮残余」**的常驻用例。
//
// 现场（#734 实测）：`persistRunSnapshot` 每次写快照都把**整段会话正文**复制进载荷，而它每次写都
// 重写一遍「从种子到当前轮」的全文 ⇒ 20 轮真跑里这一格独占载荷的绝大部分（本文件那条字节账用例
// 量到 39 次写共 1.89 MiB；宿主侧 `saveRunSnapshot` 2 MiB 上限的大头就是它）。
//
// 读侧只有一个读者（`src/loop/resume-manager.js` 的旧格式升级路径），而它**只用 `slice(anchor)`
// 那一段**：锚点之前的整段前缀从来没被读过。所以写侧现在把「锚点之前、且账本里本来就有」的那些
// 格子写成 `null` —— **数组长度与绝对下标不动**，于是读侧一行都不用改（它的 `Array.isArray(…) ? … : []`
// 容忍面、它的 `snapshotBody.length > anchor` 条件、它 `slice(anchor)` 的下标空间全部逐字不变）。
//
// ---------------------------------------------------------------------------
// 本片依赖的不变量（写侧 `residueStart = min(本轮起点, persistedTranscriptLength, 正文长度)`）：
//
//   **`residueStart <= 恢复现场的 anchor`** —— 否则被置 null 的那段正是读侧要拿的那段，就是丢信息。
//
// 1. `persistedTranscriptLength` 只在本进程**亲手把一条逻辑消息落盘成功**时才 `+= 1`（写侧两处
//    都带 `if (persisted)` 守卫），而恢复侧的锚点 `countResumeAnchor(records)` 量的是**同一本账**
//    在更晚时刻折出来的逻辑条数（账本只追加、不重写）⇒ 前者 <= 后者。
// 2. 「本轮起点」之前的正文属于上一轮及更早：逐条入账（工单 261021 第二刀）+ #326 的引擎补充行
//    已把它们写进账本 ⇒ 同样 <= 锚点。折叠（compaction）只让**内存**里那段变短，账本不缩 ⇒ 锚点
//    只会更靠后，方向仍是安全的。
// 3. 唯一的反向例外是**恢复自己造出来的内存正文**：升级路径（#424 的跳过守卫）把快照里的崩溃轮
//    正文补进内存却**不入账**，于是 `messages` 比账本长。它排在锚点**之后**，而
//    `persistedTranscriptLength` 恰好没算它 ⇒ `min(本轮起点, 它)` 仍退回锚点，那段残余照旧写出。
//    用例 2 钉的就是这条：旧账本 → resume →（引擎亲笔覆盖写快照）→ 再 resume；把 `min` 里
//    `persistedTranscriptLength` 那一项去掉，第二跳就会丢崩溃轮正文。
// ---------------------------------------------------------------------------
//
// 四格（工单 D）与谁承担：
//   ① 用例 1（旧格式升级路径仍能恢复崩溃轮正文）+ 用例 2（快照被覆盖后二次恢复）；
//   ② 新格式续跑逐字不变 ⇒ 由既有恢复用例全集承担（`npm test`：`loop-resume-*`、
//      `loop-invalid-arguments`、`cross-version-real-e2e` 等）；
//   ③ 用例 3（快照里不再有锚点之前那段前缀：按**非 null 条数**与**独立字节基线**断言，不断言原文）；
//   ④ 用例 4 = 变异「删掉残余」（载荷面）⇒ ① 红、且「只拿掉前缀」⇒ 不红；
//      用例 5 = 变异「写回整段」（**副本引擎**，issue #411 的纪律）⇒ ③ 的两条判据红。
//
// 夹具 `test/fixtures/journal-0.22.0/`：0.22.0 CLI 的真产物，**没有** `kind:"message"` 行、正文挂在
// 轮行上，正是「崩溃轮的正文只在快照里」那种旧格式账本。本文件只读它，一个字都不改。
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
// 变异探针跑在 `src/` 的**副本**上：`mutateEngine()` 造好副本，把路径经 `ERIX_ENGINE_ROOT` 递给
// 子进程（同一份用例文件、坏引擎），于是「红」是真的退出码，不是自说自话。
const ENGINE_ROOT = process.env.ERIX_ENGINE_ROOT ?? REPO_ROOT;
const insideMutationRun = process.env.ERIX_ENGINE_ROOT !== undefined;

const { createMemoryTranscriptStore } = await import(
  pathToFileURL(join(ENGINE_ROOT, "src/store/memory.js")).href);
const { foldLedgerMessages } = await import(
  pathToFileURL(join(ENGINE_ROOT, "src/store/message-rows.js")).href);
const { createFakeProvider } = await import(
  pathToFileURL(join(ENGINE_ROOT, "test/helpers/fake-provider.js")).href);
const { runDirect } = await import(
  pathToFileURL(join(ENGINE_ROOT, "test/helpers/run-direct.js")).href);

const FIXTURE_DIR = join(HERE, "fixtures", "journal-0.22.0");
const FIX_RUN_ID = "work-c7d61121-mvi9c4fj-77f54351";
const TOOLS = [{ name: "readFile", inputSchema: { type: "object" } }];
/** 崩溃轮（round 2）assistant 正文里独有的串：截断后的账本里没有，只有快照的残余里有。 */
const CRASH_ROUND_MARKER = "Now read b.txt";
/** 崩溃轮那条**已成型**的工具结果。 */
const RESIDUE_RESULT_ID = "chatcmpl-tool-80778b291064178e";

const fixtureRows = readFileSync(join(FIXTURE_DIR, `${FIX_RUN_ID}.jsonl`), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line));
const fixtureSnapshot = JSON.parse(
  readFileSync(join(FIXTURE_DIR, `${FIX_RUN_ID}.snapshot.json`), "utf8"),
);
/** 崩溃现场：账本只到 round 1 —— 旧格式下 round 2 的正文因崩溃从没落盘，只在快照里。 */
const ledgerRows = fixtureRows.filter((row) => (row.round ?? 0) <= 1);
/** 恢复侧锚点：与读侧同一口径现算（`foldLedgerMessages`），不是抄来的常数。 */
const ANCHOR = foldLedgerMessages(structuredClone(ledgerRows)).length;

const endTurn = (text) => ({ content: [{ type: "text", text }], stopReason: "end_turn" });
const toolTurn = (id, text) => ({
  content: [{ type: "text", text }, { type: "tool_use", id, name: "readFile", input: { path: "c.txt" } }],
  stopReason: "tool_use",
});
const blocksOf = (messages) => (messages ?? [])
  .flatMap((message) => (Array.isArray(message?.content) ? message.content : []));
const resultsFor = (messages, id) => blocksOf(messages)
  .filter((block) => block?.type === "tool_result" && block.tool_use_id === id);
const countMarker = (messages) => JSON.stringify(messages ?? []).split(CRASH_ROUND_MARKER).length - 1;
const bodyCountOf = (messages) => (messages ?? [])
  .filter((message) => message !== null && message !== undefined).length;

/** 把夹具摆成崩溃现场：账本截到 round 1，快照是 0.22.0 亲笔写的那份（整段正文，旧形状）。 */
async function seedFixtureScene(inner, mutate = () => {}) {
  for (const row of ledgerRows) await inner.appendRound(FIX_RUN_ID, structuredClone(row));
  const snapshot = structuredClone(fixtureSnapshot);
  mutate(snapshot, ANCHOR);
  await inner.saveRunSnapshot(FIX_RUN_ID, snapshot);
  return inner;
}

async function resumeOnce(store, script, extra = {}) {
  const provider = createFakeProvider(script);
  try {
    const result = await runDirect({
      provider,
      resume: true,
      store,
      runId: FIX_RUN_ID,
      tools: TOOLS,
      completion: false,
      wrapup: false,
      stallDetection: false,
      maxRounds: 6,
      executeTool: async () => ({ content: "补跑结果" }),
      ...extra,
    });
    return { ok: true, provider, result };
  } catch (error) {
    return {
      ok: false,
      provider,
      error: `${String(error?.code ?? error?.name)}: ${String(error?.message)}`,
    };
  }
}

/** ① 的判据：崩溃轮的 assistant 正文与它那条已成型的结果，必须恰 1 份地出现在模型上下文里。 */
function assertCrashRoundBodyFed(provider) {
  assert.equal(provider.requests.length, 1, "恢复必须真的发过一次模型请求");
  const sent = provider.requests[0].messages;
  assert.equal(countMarker(sent), 1,
    `崩溃轮的 assistant 正文必须恰 1 份地喂给模型（实测 ${countMarker(sent)} 份）`);
  assert.equal(resultsFor(sent, RESIDUE_RESULT_ID).length, 1, "崩溃轮那条已成型的结果必须恰 1 份");
}

// ── ① 旧格式升级路径 ─────────────────────────────────────────────────────────

test("#735 切片 2 · ① 旧格式账本（崩溃轮正文只在快照里）：升级路径仍把它喂给模型", async () => {
  assert.equal(ANCHOR, 3, `夹具现场：锚点应是 round 0+1 的 3 条正文（实测 ${ANCHOR}）`);
  assert.ok(fixtureSnapshot.messages.length > ANCHOR,
    "夹具快照必须带着锚点之后的残余（否则本用例的现场不存在）");
  assert.deepEqual(fixtureRows.filter((row) => row.kind === "message"), [],
    "前置：夹具是旧格式账本（没有 0.23.0 的逐条消息行）");

  const resumed = await resumeOnce(
    await seedFixtureScene(createMemoryTranscriptStore()),
    [endTurn("续跑完成"), endTurn("兜底")],
  );
  assert.equal(resumed.ok, true, `续跑必须成功（实测：${String(resumed.error)}）`);
  assertCrashRoundBodyFed(resumed.provider);
});

/**
 * 双崩现场（工单 A 那条链）：旧账本 → resume →（引擎亲笔覆盖写快照）→ 再 resume。
 * 返回可对账的摘要：两次恢复的成败与**喂给模型的上下文**，以及最新快照的正文形状。
 */
async function runDoubleCrashScene(engineRoot) {
  const { runToolLoop } = await import(pathToFileURL(join(engineRoot, "src/loop/orchestrator.js")).href);
  const { createMemoryTranscriptStore: createStore } = await import(
    pathToFileURL(join(engineRoot, "src/store/memory.js")).href);
  const { withSeed } = await import(pathToFileURL(join(ENGINE_ROOT, "test/helpers/run-direct.js")).href);
  const inner = await seedFixtureScene(createStore());
  let snapshotRound = 0;
  let crashed = false;
  const store = {
    ...inner,
    async saveRunSnapshot(runId, snapshot) {
      snapshotRound = Math.max(snapshotRound, Number(snapshot?.round ?? 0));
      return inner.saveRunSnapshot(runId, snapshot);
    },
    async appendRound(runId, record) {
      // 崩在「新一轮的快照已写、正文行未写」那一刻 ⇒ 引擎亲笔那份成为最新快照（latest-only）。
      if (!crashed && snapshotRound > fixtureSnapshot.round && (record?.round ?? 0) > fixtureSnapshot.round) {
        crashed = true;
        throw new Error("simulated crash after the resumed run overwrote the snapshot");
      }
      return inner.appendRound(runId, record);
    },
  };
  const attempt = async (target, script) => {
    const provider = createFakeProvider(script);
    try {
      await runToolLoop(withSeed({
        provider,
        resume: true,
        store: target,
        runId: FIX_RUN_ID,
        tools: TOOLS,
        completion: false,
        wrapup: false,
        stallDetection: false,
        maxRounds: 6,
        executeTool: async () => ({ content: "补跑结果" }),
      }));
      return { ok: true, requests: provider.requests };
    } catch (error) {
      return {
        ok: false,
        error: `${String(error?.code ?? error?.name)}: ${String(error?.message)}`,
        requests: provider.requests,
      };
    }
  };
  const first = await attempt(store, [
    toolTurn("call-after-resume", "续跑后又调一次工具"),
    endTurn("兜底"),
  ]);
  const latest = await inner.loadLatestRunSnapshot(FIX_RUN_ID);
  const second = await attempt(inner, [endTurn("第二次续跑完成"), endTurn("兜底")]);
  return {
    crashed,
    first,
    second,
    latestRound: latest.round,
    latestMessages: latest.messages,
    anchorAfter: foldLedgerMessages(await inner.load(FIX_RUN_ID)).length,
  };
}

test("#735 切片 2 · 双崩现场（resume → 覆盖写快照 → 再 resume）：新快照只带残余，且行为与「写回整段」逐字相同", async (t) => {
  const scene = await runDoubleCrashScene(ENGINE_ROOT);
  assert.ok(scene.crashed, "前置：第二跳必须真的崩在「新快照已写、正文行未写」那一刻");
  assert.ok(scene.latestRound > fixtureSnapshot.round,
    `前置：引擎必须已覆盖写过新的一轮（实测 round=${scene.latestRound}）`);
  // ③ 在这个现场也成立：锚点之前（旧格式账本里那 `ANCHOR` 条）被置 null，非 null 只剩本轮残余。
  const messages = scene.latestMessages ?? [];
  assert.ok(messages.length > fixtureSnapshot.messages.length,
    `索引空间必须仍是「整段正文」那个长度（读侧的绝对下标才不动）：实测 ${messages.length}`);
  assert.ok(messages.slice(0, ANCHOR).every((message) => message === null),
    `锚点之前那 ${ANCHOR} 格必须是 null（它们本来就在账本里，读侧不会要）`);
  assert.ok(bodyCountOf(messages) > 0 && bodyCountOf(messages) <= messages.length - ANCHOR,
    `覆盖写的新快照只带锚点之后的残余（非 null ${bodyCountOf(messages)} 条 / 全长 ${messages.length} 格）`);

  // 行为对账：与「写回整段」的基点写法（副本引擎）比，两次恢复的成败与**喂给模型的上下文**必须逐字相同。
  // 这个现场在基点上本来就以 `invalid_messages` 收场（#424 那一族的既有限制，非本片引入）——
  // 本片要的正是「一模一样」，所以这里不写「必须成功」，而是与副本引擎的实测输出逐字对账。
  if (insideMutationRun) {
    t.skip("变异子进程里不再递归跑对账");
    return;
  }
  const wholeRoot = mutateEngine("double-crash-baseline",
    "messages: snapshotTranscriptResidue,",
    "messages: cloneState(transcriptForSnapshot),");
  try {
    const baseline = await runDoubleCrashScene(wholeRoot);
    assert.deepEqual(
      { first: scene.first, second: scene.second },
      { first: baseline.first, second: baseline.second },
      "两次恢复的成败与上下文必须与「写回整段」逐字相同（新格式续跑行为不变）",
    );
    assert.equal(scene.latestMessages.length, baseline.latestMessages.length,
      "残余化不许改数组长度（读侧的绝对下标空间就是它的契约）");
  } finally {
    rmSync(wholeRoot, { recursive: true, force: true });
  }
});

// ── ③ 前缀不再落盘 ───────────────────────────────────────────────────────────

/** 每轮都调一次工具的真跑脚本（正文与工具输出都够长，让「整段正文」这条曲线可见）。 */
function roundScript(rounds) {
  const script = [];
  for (let index = 0; index < rounds; index += 1) {
    script.push({
      content: [
        { type: "text", text: `第 ${index + 1} 轮正文，长到能让整段正文随轮数线性变胖：${"R".repeat(400)}` },
        { type: "tool_use", id: `c-${index}`, name: "readFile", input: { path: `f${index}.txt` } },
      ],
      stopReason: "tool_use",
    });
  }
  script.push(endTurn("读完了"), endTurn("读完了"), endTurn("读完了"));
  return script;
}

/** 用给定那棵树里的引擎跑同一套真跑；抓它亲笔写下的每条快照载荷（+ 收口后的账本正文）。 */
async function captureWithEngine(engineRoot, rounds = 6) {
  const { runToolLoop } = await import(pathToFileURL(join(engineRoot, "src/loop/orchestrator.js")).href);
  const { createMemoryTranscriptStore: createStore } = await import(
    pathToFileURL(join(engineRoot, "src/store/memory.js")).href);
  const { withSeed } = await import(pathToFileURL(join(ENGINE_ROOT, "test/helpers/run-direct.js")).href);
  const store = createStore();
  const payloads = [];
  const save = store.saveRunSnapshot.bind(store);
  store.saveRunSnapshot = async (runId, snapshot) => {
    payloads.push(structuredClone(snapshot));
    return save(runId, snapshot);
  };
  await runToolLoop(withSeed({
    provider: createFakeProvider(roundScript(rounds)),
    tools: [TOOLS[0]],
    executeTool: async () => ({ content: "O".repeat(2048) }),
    store,
    runId: "round-residue-735",
    maxRounds: rounds + 2,
    completion: false,
    wrapup: false,
    stallDetection: false,
    initialUserMessage: "依次读文件",
  }));
  assert.ok(payloads.length >= rounds, `必须真的每轮都写过快照（实测 ${payloads.length} 次）`);
  return {
    payloads,
    transcript: foldLedgerMessages(await store.load("round-residue-735")).map((entry) => entry.message),
  };
}

const messagesBytes = (payloads) => payloads
  .reduce((sum, payload) => sum + JSON.stringify(payload.messages).length, 0);

test("#735 切片 2 · ③ 快照里不再有锚点之前那段前缀（非 null 条数 + 独立字节基线）", async () => {
  const { payloads, transcript } = await captureWithEngine(ENGINE_ROOT, 6);
  assert.ok(transcript.length >= 6, `账本里必须已攒出多条正文（实测 ${transcript.length}）`);
  // 独立基线：同一时刻「整段正文」那份该写多少字节 = 账本折出来的前缀（不是拿本片的输出自己比自己）。
  const wholeBytes = payloads.reduce(
    (sum, payload) => sum + JSON.stringify(transcript.slice(0, payload.messages.length)).length,
    0,
  );
  for (const payload of payloads) {
    const messages = payload.messages;
    assert.ok(Array.isArray(messages),
      "`messages` 必须仍是数组（读侧 `Array.isArray(snapshot.messages) ? … : []` 的容忍面不许动）");
    assert.ok(bodyCountOf(messages) <= 3,
      `一条快照最多带本轮残余（实测非 null ${bodyCountOf(messages)} 条 / 全长 ${messages.length} 格）`);
  }
  assert.ok(messagesBytes(payloads) * 2 < wholeBytes,
    `载荷的正文位必须远小于整段基线：残余 ${messagesBytes(payloads)} B vs 整段 ${wholeBytes} B`);
  assert.ok(payloads.at(-1).messages.some((message) => message === null),
    "后段快照必须真的有空槽（前缀被置 null，索引空间保留）");
});

// ── ④b 变异「删掉残余」（载荷面）：① 必须红；「只拿掉前缀」必须不红 ──────────────

test("#735 切片 2 · ④b 变异「删掉残余」⇒ ① 红；只拿掉锚点之前的前缀 ⇒ 逐字不变", async () => {
  // 变异一：把读侧真正要的那段 `slice(anchor)` 从快照正文里删掉。
  const dropped = await seedFixtureScene(createMemoryTranscriptStore(), (snapshot, anchor) => {
    snapshot.messages = snapshot.messages.slice(0, anchor);
  });
  const mutated = await resumeOnce(dropped, [endTurn("续跑完成"), endTurn("兜底")]);
  assert.equal(mutated.ok, false, `删掉残余必须红（实测 ok=${mutated.ok}）`);
  assert.match(mutated.error, /invalid_messages/u, `实测错误：${String(mutated.error)}`);
  assert.match(mutated.error, /tool_result has no matching assistant tool_use/u,
    "红的原因必须是崩溃轮的 assistant 正文没了（判据在 `src/messages/rounds.js`）");
  assert.equal(mutated.provider.requests.length, 0, "红在第一次模型请求之前：0 次请求");

  // 变异二（同一现场的对照组）：**只**把锚点之前的前缀置 null ⇒ 恢复必须逐字不变。
  const elided = await seedFixtureScene(createMemoryTranscriptStore(), (snapshot, anchor) => {
    snapshot.messages = snapshot.messages.map((message, index) => (index < anchor ? null : message));
  });
  const stillGreen = await resumeOnce(elided, [endTurn("续跑完成"), endTurn("兜底")]);
  assert.equal(stillGreen.ok, true, `前缀置 null 不得改变恢复（实测：${String(stillGreen.error)}）`);
  assertCrashRoundBodyFed(stillGreen.provider);
  const baseline = await resumeOnce(
    await seedFixtureScene(createMemoryTranscriptStore()),
    [endTurn("续跑完成"), endTurn("兜底")],
  );
  assert.deepEqual(stillGreen.provider.requests[0].messages, baseline.provider.requests[0].messages,
    "前缀置 null 之后喂给模型的上下文必须与整段基线**逐字**相同（前缀是死重的正面证明）");
});

// ── ④a 变异「写回整段」：靶子是 `src/` 的副本（issue #411 的纪律：仓内 `src/` 全程只读）──

function mutateEngine(label, search, replace) {
  const root = mkdtempSync(join(tmpdir(), `snap735-${label}-`));
  cpSync(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });
  // helper 也要拷：它们 `import "../src/…"`，在副本里才会解析到**被改坏的**那一棵。
  cpSync(join(REPO_ROOT, "test/helpers"), join(root, "test/helpers"), { recursive: true });
  const target = join(root, "src/loop/orchestrator.js");
  const before = readFileSync(target, "utf8");
  assert.ok(before.includes(search), `变异靶点必须存在：${search}`);
  writeFileSync(target, before.replace(search, replace), "utf8");
  assert.ok(readFileSync(target, "utf8").includes(replace), "变异必须真的落进副本");
  return root;
}

test("#735 切片 2 · ④a 变异「写回整段」（副本引擎）⇒ ③ 的两条判据必须红", async (t) => {
  if (insideMutationRun) {
    t.skip("变异子进程里不再递归跑变异");
    return;
  }
  const mutatedRoot = mutateEngine("whole",
    "messages: snapshotTranscriptResidue,",
    "messages: cloneState(transcriptForSnapshot),");
  try {
    // 子进程：同一份用例文件 + 坏引擎 ⇒ ③ 那一条必须当场红（真退出码，不是自说自话）。
    const child = spawnSync(process.execPath, ["--test", "test/loop-snapshot-round-residue-735.test.js"], {
      cwd: REPO_ROOT,
      // `NODE_TEST_CONTEXT` 传下去会让子进程以为自己还在别人的 test run 里（实测警告
      // 「run() is being called recursively within a test file. skipping running files」⇒ 直接 0 退出），
      // 必须**删掉**这个键（留空串也一样）。
      env: { ...Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => key !== "NODE_TEST_CONTEXT")), ERIX_ENGINE_ROOT: mutatedRoot },
      encoding: "utf8",
      timeout: 120_000,
    });
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
    assert.match(output, /^not ok .*③ 快照里不再有锚点之前那段前缀/um,
      `变异体上 ③ 必须红（退出码 ${String(child.status)}）：\n${output.slice(0, 1500)}`);
    assert.notEqual(child.status, 0, "变异体上整个文件必须非零退出");
    // 变异只改载荷大小，不改恢复语义 ⇒ ① 那两条在变异体上仍应绿（否则这条变异测的就不是 ③）。
    assert.match(output, /^ok .*① 旧格式账本/um,
      `变异体不该拆掉 ①（它只把载荷写胖，恢复语义没变）：\n${output.slice(0, 1500)}`);
    assert.match(output, /^ok .*④b 变异「删掉残余」/um, "④b 在变异体上必须照旧绿（它测的是读侧）");
  } finally {
    rmSync(mutatedRoot, { recursive: true, force: true });
  }
  assert.ok(readFileSync(join(ENGINE_ROOT, "src/loop/orchestrator.js"), "utf8")
    .includes("messages: snapshotTranscriptResidue,"),
    "仓内写侧必须仍是轮残余（变异只发生在副本上）");
});
