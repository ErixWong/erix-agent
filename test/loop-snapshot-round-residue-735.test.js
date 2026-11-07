// issue #735 切片 2 ·**run snapshot 的 `messages` 只交「轮残余」**的常驻用例。
//
// 现场（#734 实测）：`persistRunSnapshot` 每次写快照都把**整段会话正文**复制进载荷，而它每次写都
// 重写一遍「从种子到当前轮」的全文 ⇒ 20 轮真跑里这一格独占载荷的绝大部分（宿主侧 `saveRunSnapshot`
// 2 MiB 上限的大头就是它；量化的字节账在两份契约那张四档表里，同一形状改前 / 改后对量，**取的是
// 最终树现测**：新 run 20 轮 × 8 KiB 结果、39 次写，累计 `2055794`（1.96 MiB）→ `361996`）。本文件
// 的字节账用例（用例 3）只钉「残余远小于同形状的整段基线」这个**关系**，不钓绝对值。
//
// 读侧只有一个读者（`src/loop/resume-manager.js` 的旧格式升级路径），而它**只消费 `slice(anchor)`
// 那一段**：那之前的前缀从来没被读过。所以写侧现在把「本轮起点之前、且本进程亲手落过盘」的那些
// 格子写成 `null` —— **数组长度与绝对下标不动**，于是读侧一行都不用改（它的 `Array.isArray(…) ? … : []`
// 容忍面、它的 `snapshotBody.length > anchor` 条件、它 `slice(anchor)` 的下标空间全部逐字不变）。
//
// ---------------------------------------------------------------------------
// 本片**只声明实测到的那一件事**（与 `src/loop/orchestrator.js` 写点注释、两份契约同一口径）：
//
//   写侧 `residueStart = max(0, min(正文长度, 本轮起点, persistedTranscriptLength))`，被置 `null` 的
//   下标全部 < `residueStart`；唯一的读者只切 `slice(anchor)`，而 `anchor >= residueStart`
//   ⇒ **读者永远读不到被省掉的格子**。
//
// **这是一句关于读者的陈述，不是「每一段正文都还在」的承诺。** 三个项各自的括法：
// 1. `persistedTranscriptLength` 只在本进程**亲手把一条逻辑消息落盘成功**时才 `+= 1`（写侧两处
//    都带 `if (persisted)` 守卫），而恢复侧的锚点 `countResumeAnchor(records)` 量的是**同一本账**
//    在更晚时刻折出来的逻辑条数（账本只追加、不重写）⇒ 前者 <= 后者。
// 2. 「本轮起点」之前的正文属于上一轮及更早：逐条入账（工单 261021 第二刀）+ #326 的引擎补充行
//    已把它们写进账本 ⇒ 同样 <= 锚点。折叠（compaction）只让**内存**里那段变短，账本不缩 ⇒ 锚点
//    只会更靠后，方向仍是安全的。
// 3. **已知例外（不是本片引入，归 issue #754）**：恢复的升级路径（#424 的 `resume_journal_skipped`
//    守卫）会把旧快照里的崩溃轮正文补进 `ctx.messages` 却**一条都不入账**；而读侧的 `anchor` 是一
//    个**标量**（折叠后的逻辑消息条数）、不是「快照哪些下标已入账」的位图 ⇒ 第一跳续跑一入账，第二跳
//    的锚点就从 3 涨到 5（夹具实测），那段只在内存里的正文就落到 `slice(anchor)` 起点之前。**写侧
//    无论怎么写（整段 / 残余）都取不回它** ⇒ 用例 6 与「写回整段」的副本引擎逐字对账，把这件事钉成
//    「同一缺陷、两侧同结果」，而不是本片引入的损失。
//
// ⚠ **已被推翻并当场撤回的旧不变量（照着它改就是走回头路）**：本节曾声称 `residueStart` 还要再
//   `min` 上「本次恢复的锚点」（`resumeTranscriptAnchor`，`91951fe`），理由写的是「锚点之前每一格
//   **按构造**就在账本里 ⇒ 否则被置 null 的那段就是读侧要拿的那段，就是丢信息」。并排探针（主干
//   `bea46bb` 写整段 vs 本支写残余，同一套两跳现场）交出**逐字相同**的第二跳 ⇒ 那段旧正文在两种
//   写法下**同样取不到**：封顶既不换来正确性，又让恢复过的 run 的前缀收益没了（后缀无上界）
//   ⇒ `6d98ac7` 把它仍回了写侧。契约里那句大话现在由 `test/docs-no-overclaim-735.test.js` 钉住
//   （把「按构造不会丢信息」这类跨恢复承诺写回任一仹契约 ⇒ 当场红）。
// ---------------------------------------------------------------------------
//
// 用例与工单 D 的四格对应：
//   ① 用例 1（旧格式升级路径仍能恢复崩溃轮正文）。用例 2（快照被覆盖后二次恢复）**不再**声称
//      「第二跳的正文保住了」：它钉的是载荷面（新快照只带残余）与「与基点行为逐字相同」，
//      跨恢复取不回旧正文这件事归 #754（用例 6）；
//   ② 新格式续跑逐字不变 ⇒ 由既有恢复用例全集承担（`npm test`：`loop-resume-*`、
//      `loop-invalid-arguments`、`cross-version-real-e2e` 等）；
//   ③ 用例 3（快照里不再有锚点之前那段前缀：按**非 null 条数**与**独立字节基线**断言，不断言原文）；
//   ④ 用例 4 = 变异「删掉残余」（载荷面）⇒ ① 红、且「只拿掉前缀」⇒ 不红；
//      用例 5 = 变异「写回整段」（**副本引擎**，issue #411 的纪律）⇒ ③ 的两条判据红；
//      用例 6 = 两跳恢复记录**当前行为**（与副本引擎逐字对账；#754 落地后翻成断言正确行为）。
//   本刀的契约文案面守卫另开一文件：`test/docs-no-overclaim-735.test.js`。
//
// 夹具 `test/fixtures/journal-0.22.0/`：0.22.0 CLI 的真产物，**没有** `kind:"message"` 行、正文挂在
// 轮行上，正是「崩溃轮的正文只在快照里」那种旧格式账本。本文件只读它，一个字都不改。
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTmp } from "./helpers/tmp.js";

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
const { RESUME_NOTICE_TAG, RESUME_NOTICE_LEGACY_SNAPSHOT_DROPPED_HEADER } = await import(
  pathToFileURL(join(ENGINE_ROOT, "src/loop/resume-notice.js")).href);

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
const rangeOf = (from, to) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
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

/**
 * #754 裁决 2 之后的判据（旧断言是「恰 1 份地喂进来」）：pre-261021 档案的恢复**一份快照正文也
 * 不喂** ⇒ 那段只在快照里的崩溃轮正文（`CRASH_ROUND_MARKER`）在**每一次**模型请求里都是 0 份。
 */
function assertCrashRoundBodyNotFed(provider, label = "恢复路径") {
  const total = provider.requests.reduce((sum, request) => sum + countMarker(request.messages), 0);
  assert.equal(total, 0,
    `${label}：只存在于快照的崩溃轮正文一份也不许进上下文（实测 ${total} 份）`);
}

/** 从账本里取恢复告示的正文（`:control:resume-notice` 行；它在第一次请求之前就入账）。 */
async function noticeTexts(store) {
  const rows = await store.load(FIX_RUN_ID);
  return rows
    .flatMap((row) => (Array.isArray(row?.messages) ? row.messages : []))
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === "text" && String(block.text).includes(RESUME_NOTICE_TAG))
    .map((block) => String(block.text));
}

// ── ① 旧格式升级路径 ─────────────────────────────────────────────────────────

test("#754 裁决 2 · ① 旧格式账本（崩溃轮正文只在快照里）：该恢复路径已关掉，一份正文也不喂", async () => {
  assert.equal(ANCHOR, 3, `夹具现场：锚点应是 round 0+1 的 3 条正文（实测 ${ANCHOR}）`);
  assert.ok(fixtureSnapshot.messages.length > ANCHOR,
    "夹具快照必须带着锚点之后的残余（否则本用例的现场不存在）");
  assert.deepEqual(fixtureRows.filter((row) => row.kind === "message"), [],
    "前置：夹具是旧格式账本（没有 0.23.0 的逐条消息行）");

  const store = await seedFixtureScene(createMemoryTranscriptStore());
  const resumed = await resumeOnce(store, [endTurn("续跑完成"), endTurn("兜底")]);
  // 关掉之后的**实测形状**（不是「成功」）：崩溃轮那条已成型的结果仍由快照的 `toolResults` 接回
  // （`src/loop/resume-manager.js:660` → `:683`，判据只看账本里有没有那个 id），而带它 `tool_use`
  // 的那条 assistant 现在不再从快照喂进来 ⇒ 孤儿 `tool_result`，被配对校验当场拒掉
  // （`src/messages/rounds.js:118`）。裁决 2 是「pre-261021 不再支持恢复」⇒ 不为变绿而恢复喂正文。
  assert.equal(resumed.ok, false,
    `关掉之后：旧格式恢复不再被喂正文（实测：${String(resumed.error)}）`);
  assert.match(String(resumed.error), /invalid_messages/u, `实测：${String(resumed.error)}`);
  assert.match(String(resumed.error),
    /Invalid message at index 3: user tool_result has no matching assistant tool_use/u,
    `孤儿 tool_result 的实测形状（原样记录，不许为了让旧断言过而恢复喂正文）：${String(resumed.error)}`);
  assert.equal(resumed.provider.requests.length, 0,
    "关掉之后：一次模型请求也没发出 ⇒ 那段旧正文从未进过上下文");
  assertCrashRoundBodyNotFed(resumed.provider);
  assert.equal(resultsFor(resumed.provider.requests.at(-1)?.messages ?? [], RESIDUE_RESULT_ID).length, 0,
    "快照正文那条通道上也不会再出现崩溃轮的结果块");
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
  let armedAfterSnapshot = false;
  const store = {
    ...inner,
    async saveRunSnapshot(runId, snapshot) {
      snapshotRound = Math.max(snapshotRound, Number(snapshot?.round ?? 0));
      const written = await inner.saveRunSnapshot(runId, snapshot);
      if (snapshotRound > fixtureSnapshot.round) armedAfterSnapshot = true;
      return written;
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

test("#754 裁决 2 · 双崩现场在关掉之后不再发生：旧档案第一次恢复就失败，两跳都不喂旧正文", async (t) => {
  const scene = await runDoubleCrashScene(ENGINE_ROOT);
  // 实测（关掉之后）：恢复不再从快照补崩溃轮正文 ⇒ 续跑**复用**崩溃轮的轮号（第 2 轮），引擎亲笔
  // 快照也停在第 2 轮 ⇒ 这个现场那台注入器（判据 `> fixtureSnapshot.round`）永不武装 ⇒ 双崩链不再
  // 发生。快照正文的残余形状由 ③ 的真跑用例钉（写侧未动）。
  assert.equal(scene.crashed, false,
    "关掉之后：双崩注入器不再武装（第一跳在请求前就失败，引擎没机会覆盖写快照）");
  assert.equal(scene.latestRound, fixtureSnapshot.round,
    `引擎亲笔快照仍停在夹具那一轮（实测 round=${scene.latestRound}）`);
  // 实测形状：pre-261021 档案**第一次恢复就失败**（孤儿 `tool_result`，与 ① 同一个形状），第二跳
  // 是同一次失败的重复现场（多一条告示 ⇒ 下标从 3 移到 4）——这就是裁决 2「不再支持恢复」的形状。
  assert.equal(scene.first.ok, false, `第一跳必须失败（实测：${String(scene.first.error)}）`);
  assert.match(String(scene.first.error),
    /Invalid message at index 3: user tool_result has no matching assistant tool_use/u,
    `实测：${String(scene.first.error)}`);
  assert.equal(scene.second.ok, false,
    `第二跳仍以同一形状失败（实测：${String(scene.second.error)}）`);
  assert.match(String(scene.second.error),
    /Invalid message at index 4: user tool_result has no matching assistant tool_use/u,
    `第二跳的实测形状（旧缺陷那条「悬空 tool_use」已不存在）：${String(scene.second.error)}`);
  assertCrashRoundBodyNotFed(scene.first, "双崩第一跳");
  assertCrashRoundBodyNotFed(scene.second, "双崩第二跳");

  // 行为对账：与「写回整段」的基点写法（副本引擎）比，两次恢复的成败与**喂给模型的上下文**必须逐字相同。
  // #754 之后这条对账反而更硬：读侧只在「数条数」时碰一次 `snapshot.messages` ⇒ 写侧写残余还是写
  // 整段都不再改变恢复行为 ⇒ 两棵同结果就是「读侧已不依赖快照正文」的证据。
  if (insideMutationRun) {
    t.skip("变异子进程里不再递归跑对账");
    return;
  }
  const wholeRoot = await mutateEngine("double-crash-baseline",
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

test("#735 切片 2 · ④b 变异「删掉残余」⇒ 失败形状不变但告示不再报 N；只拿掉锚点之前的前缀 ⇒ 逐字不变", async () => {
  // #754 改判后的两个判据（旧写法钉的是「① 少了喂进来的那段正文」，那个读取点已被关掉）：
  //   变异一（把 `slice(anchor)` 那段残余从快照正文里删掉）：恢复的失败形状**不变**（孤儿
  //     `tool_result` 来自快照的 `toolResults`，与正文无关），但**告示不再报「丢了 N 条」**——
  //     读侧对快照正文剩下的唯一读取点就是那次计数，它红才算钉住因果；
  //   变异二（只把锚点之前那段置 null）：与未变异的现场逐字同形（失败形状 + 告示文本），
  //     这才是「null 占位仍被尊重、下标空间不位移」的判据。
  const dropped = await seedFixtureScene(createMemoryTranscriptStore(), (snapshot, anchor) => {
    snapshot.messages = snapshot.messages.slice(0, anchor);
  });
  const mutated = await resumeOnce(dropped, [endTurn("续跑完成"), endTurn("兜底")]);
  assert.equal(mutated.ok, false, `删掉残余后仍须以同一形状失败（实测 ok=${mutated.ok}）`);
  assert.match(mutated.error, /invalid_messages/u, `实测错误：${String(mutated.error)}`);
  assert.match(mutated.error, /tool_result has no matching assistant tool_use/u,
    `失败原因仍是那条孤儿结果（判据在 src/messages/rounds.js:118，与快照正文无关）：${String(mutated.error)}`);
  assert.equal(mutated.provider.requests.length, 0, "红在第一次模型请求之前：0 次请求");
  const droppedNotices = await noticeTexts(dropped);
  assert.equal(droppedNotices.length, 1, `删掉残余后仍恰一条恢复告示（实测 ${droppedNotices.length}）`);
  assert.ok(!droppedNotices[0].includes(RESUME_NOTICE_LEGACY_SNAPSHOT_DROPPED_HEADER),
    `残余被删 ⇒ 数不出条数 ⇒ 告示不再报「丢了 N 条」（否则静默），实测：${droppedNotices[0]}`);

  // 变异二（同一现场的对照组）：**只**把锚点之前的前缀置 null ⇒ 必须与未变异的现场逐字相同。
  const elided = await seedFixtureScene(createMemoryTranscriptStore(), (snapshot, anchor) => {
    snapshot.messages = snapshot.messages.map((message, index) => (index < anchor ? null : message));
  });
  const stillGreen = await resumeOnce(elided, [endTurn("续跑完成"), endTurn("兜底")]);
  const baselineStore = await seedFixtureScene(createMemoryTranscriptStore());
  const baseline = await resumeOnce(baselineStore, [endTurn("续跑完成"), endTurn("兜底")]);
  assert.equal(stillGreen.ok, baseline.ok,
    `前缀置 null 不得改变恢复（实测 ok=${String(stillGreen.ok)} vs ${String(baseline.ok)}）`);
  assert.equal(String(stillGreen.error), String(baseline.error),
    `失败形状必须与未变异现场逐字相同（实测：${String(stillGreen.error)}）`);
  assert.deepEqual(await noticeTexts(elided), await noticeTexts(baselineStore),
    "告示文本必须逐字相同（丢的条数仍按锚点之后的槽位数算，null 占位不位移）");
  assertCrashRoundBodyNotFed(stillGreen.provider, "前缀置 null 的现场");
});

// ── ④a 变异「写回整段」：靶子是 `src/` 的副本（issue #411 的纪律：仓内 `src/` 全程只读）──

async function mutateEngine(label, search, replace) {
  // 临时目录一律走 `makeTmp`（#185/#199：TMPDIR 卫生 + 可写探针；裸 mkdtemp 由 test-hygiene 闸挡）。
  const root = await makeTmp(`snap735-${label}-`);
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
  const mutatedRoot = await mutateEngine("whole",
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

// ── ⑤ 两跳恢复：记录**当前行为**（主干既有缺陷，修法与爆炸半径见 issue #754）────────
//
// 场景：旧格式账本 + 旧快照 → 恢复（引擎亲笔覆盖写新快照）→ 再恢复。要盯的是那段「只在内存里」
// 的旧正文（升级路径从快照补进 `ctx.messages`，却被 #424 的 `resume_journal_skipped` 守卫故意留在
// 账本之外）在第二跳还取不取得到。**实测：取不到，而且与写侧怎么写无关**：
//   · 读侧的 `anchor = countResumeAnchor(records)` 是一个**标量**（折叠后的逻辑消息条数），不是
//     「快照里哪些下标已入账」的位图；第一跳续跑又入账了新消息 ⇒ 第二跳的锚点从 **3 涨到 5**；
//   · 那段旧正文的下标落在**新锚点之前** ⇒ 无论写侧写整段、写残余、还是按锚点封顶，切片都会把它
//     跳过 ⇒ 第二跳 `invalid_messages`、0 次模型请求；
//   · 并排实测（本分支 vs 主干 `bea46bb` 的「写回整段」写法，见下面与副本引擎的逐字对账）两棵
//     **逐字同结果** ⇒ 这是主干既有缺陷，**不是切片 2 引入的损失**。
// **`#754` 落地之后这条要翻成断言正确行为**（第二跳真发出模型请求、旧正文恰 1 份地在上下文里、
// 不出现 `invalid_messages`）——它**不是**「切片 2 的已知损失」，别在下面写成豁免条款。
async function runTwoHopScene(engineRoot) {
  const { runToolLoop } = await import(pathToFileURL(join(engineRoot, "src/loop/orchestrator.js")).href);
  const { createMemoryTranscriptStore: createStore } = await import(
    pathToFileURL(join(engineRoot, "src/store/memory.js")).href);
  const { withSeed } = await import(pathToFileURL(join(ENGINE_ROOT, "test/helpers/run-direct.js")).href);
  const inner = await seedFixtureScene(createStore());
  let snapshotRound = 0;
  let armedAfterSnapshot = false;
  let crashed = false;
  const store = {
    ...inner,
    async saveRunSnapshot(runId, snapshot) {
      snapshotRound = Math.max(snapshotRound, Number(snapshot?.round ?? 0));
      const written = await inner.saveRunSnapshot(runId, snapshot);
      if (snapshotRound > fixtureSnapshot.round) armedAfterSnapshot = true;
      return written;
    },
    async appendRound(runId, record) {
      // 崩在「恢复后的第一份新快照已写、再下一条正文行未落」那一刻 ⇒ 引擎亲笔那份就是最新快照，
      // 而账本里只有 A 集合的结果行；从快照升级补进来的那段旧正文始终只在内存里（#424 守卫）。
      if (!crashed && armedAfterSnapshot) {
        crashed = true;
        throw new Error("simulated crash right after the first post-resume snapshot");
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
    firstOk: first.ok,
    first,
    second,
    latestRound: latest.round,
    latestMessages: latest.messages,
    anchorAfter: foldLedgerMessages(await inner.load(FIX_RUN_ID)).length,
  };
}

test("#754 裁决 2 · 两跳恢复（关掉之后）：旧档案两跳都以孤儿 tool_result 失败、旧正文一份不喂", async (t) => {
  const scene = await runTwoHopScene(ENGINE_ROOT);
  // 前置：双崩注入器（判据 `snapshotRound > fixtureSnapshot.round`）在关掉之后永不武装——旧正文
  // 不再被喂进上下文 ⇒ 第一次恢复就在请求前失败 ⇒ 引擎根本没机会覆盖写快照。
  assert.equal(scene.crashed, false,
    "关掉之后：那条「新快照已写、再下一条正文行未落」的双崩链不再发生");
  assert.equal(scene.latestRound, fixtureSnapshot.round,
    `引擎没有机会覆盖写快照（实测 round=${scene.latestRound}）`);
  assert.equal(scene.first.ok, false,
    `第一跳就失败（旧行为：被注入的落盘崩溃打断，实测：${String(scene.first.error)}）`);
  assert.match(String(scene.first.error),
    /Invalid message at index 3: user tool_result has no matching assistant tool_use/u,
    `实测：${String(scene.first.error)}`);
  assertCrashRoundBodyNotFed(scene.first, "两跳第一跳");
  // 锚点仍会涨（实测 ANCHOR → anchorAfter），但涨的是两次失败各留的那条 `:control:resume-notice` 行，
  // 不再是「喂进内存却没入账的旧正文」 ⇒ #754 的根因那笔账从此不再存在。
  assert.ok(scene.anchorAfter > ANCHOR,
    `锚点只因告示行涨长（实测 ${ANCHOR} → ${scene.anchorAfter}）`);

  // ↓↓↓ 关掉之后的实测行为（旧的四条「当前行为」逐条翻面）。
  assert.equal(scene.second.ok, false,
    `第二跳仍以孤儿 tool_result 失败（旧缺陷的悬空 tool_use 已不存在，实测：${String(scene.second.error)}）`);
  assert.doesNotMatch(String(scene.second.error ?? ""),
    /assistant tool_use has no immediately following user tool_result/u,
    "闸门喂进去的那段旧正文没了 ⇒ 旧的悬空 tool_use 形状不再出现");
  assert.match(String(scene.second.error),
    /Invalid message at index 4: user tool_result has no matching assistant tool_use/u,
    `实测：${String(scene.second.error)}`);
  assert.equal(scene.second.requests.length, 0,
    `第二跳 0 次请求（实测 ${scene.second.requests.length} 次）`);
  assertCrashRoundBodyNotFed(scene.second, "两跳第二跳");
  assert.equal(countMarker(scene.latestMessages), 1,
    `写侧未动：夹具快照仍是原样（实测 ${countMarker(scene.latestMessages)} 份）`);
  // ↑↑↑

  // 与「写回整段」（= 主干写法）逐字对账：同一个第二跳 ⇒ 上面记录的行为不是本片引入的。
  if (insideMutationRun) {
    t.skip("变异子进程里不再递归跑对账");
    return;
  }
  const wholeRoot = await mutateEngine("two-hop-baseline",
    "messages: snapshotTranscriptResidue,",
    "messages: cloneState(transcriptForSnapshot),");
  try {
    const baseline = await runTwoHopScene(wholeRoot);
    assert.deepEqual(scene.second, baseline.second,
      "第二跳的成败与上下文必须与「写回整段」逐字相同（同一缺陷，两侧同结果）");
    assert.equal(scene.anchorAfter, baseline.anchorAfter,
      "两棵的锚点必须同口径（根因在读侧，与写侧写什么无关）");
    assert.equal(baseline.second.error, scene.second.error,
      `与主干写法同一个错（既有缺陷，另开单修读侧）：${String(scene.second.error)}`);
    t.diagnostic(`两跳第二跳两棵同结果（#754 关掉之后：第二跳 ok=${String(scene.second.ok)}、error=${String(scene.second.error ?? "无")}）`);
  } finally {
    rmSync(wholeRoot, { recursive: true, force: true });
  }
});

// ── #754 裁决 2：关掉不许静默 ────────────────────────────────────────────────

test("#754 裁决 2 · 关掉旧格式恢复不许静默：旧账本的恢复告示说出丢了 N 条，新账本一声不出", async () => {
  // N = 被删那个闸门原本会喂的条数（快照里锚点之后那几段正文）。
  const dropped = fixtureSnapshot.messages.slice(ANCHOR)
    .filter((message) => message !== null && message !== undefined).length;
  assert.equal(dropped, 2, `夹具现场：锚点之后应剩 2 条（实测 ${dropped}）`);

  // 旧账本（pre-261021：崩溃轮正文只在快照里）⇒ 必须出声，且把 N 说出来。
  const legacyStore = await seedFixtureScene(createMemoryTranscriptStore());
  await resumeOnce(legacyStore, [endTurn("续跑完成"), endTurn("兜底")]);
  const legacyNotices = await noticeTexts(legacyStore);
  assert.equal(legacyNotices.length, 1, `旧账本恰一条恢复告示（实测 ${legacyNotices.length}）`);
  assert.ok(legacyNotices[0].includes(RESUME_NOTICE_LEGACY_SNAPSHOT_DROPPED_HEADER),
    `旧账本的告示必须说出丢了正文，实测：${legacyNotices[0]}`);
  assert.ok(legacyNotices[0].includes(`（共 ${String(dropped)} 条，该格式已不再支持恢复）`),
    `告示必须带上条数 N，实测：${legacyNotices[0]}`);

  // 新账本（≥ 261021：崩溃轮自己已入账 ⇒ 原条件 `ledgerMessages.length === anchor` 不成立）
  // ⇒ 一份正文也没丢 ⇒ 一声不出。
  const freshStore = await createMemoryTranscriptStore();
  for (const row of [...ledgerRows, ...fixtureRows.filter((row) => row.round === 2)]) {
    await freshStore.appendRound(FIX_RUN_ID, structuredClone(row));
  }
  await freshStore.saveRunSnapshot(FIX_RUN_ID, structuredClone(fixtureSnapshot));
  const freshLedger = (await foldLedgerMessages(await freshStore.load(FIX_RUN_ID)))
    .filter((entry) => entry?.message != null).length;
  assert.ok(freshLedger > ANCHOR,
    `前置：新账本在锚点之后必须有正文（实测 ${freshLedger} > ${ANCHOR}）`);
  const fresh = await resumeOnce(freshStore, [endTurn("新账本续跑完成"), endTurn("兜底")]);
  assert.equal(fresh.ok, true, `新账本恢复必须成功（实测：${String(fresh.error)}）`);
  const freshNotices = await noticeTexts(freshStore);
  assert.equal(freshNotices.length, 1, `新账本恰一条恢复告示（实测 ${freshNotices.length}）`);
  assert.ok(!freshNotices[0].includes(RESUME_NOTICE_LEGACY_SNAPSHOT_DROPPED_HEADER),
    `新账本一声不出（不丢正文却报「丢了 N 条」就是假消息），实测：${freshNotices[0]}`);
});
