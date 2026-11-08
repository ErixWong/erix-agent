// issue #735 切片 2 ·**run snapshot 的 `messages` 只交「轮残余」**的常驻用例。
//
// 现场（#734 实测）：`persistRunSnapshot` 每次写快照都把**整段会话正文**复制进载荷，而它每次写都
// 重写一遍「从种子到当前轮」的全文 ⇒ 20 轮真跑里这一格独占载荷的绝大部分（宿主侧 `saveRunSnapshot`
// 2 MiB 上限的大头就是它；量化的字节账在两份契约那张四档表里，同一形状改前 / 改后对量，**取的是
// 最终树现测**：新 run 20 轮 × 8 KiB 结果、39 次写，累计 `2055794`（1.96 MiB）→ `361996`）。本文件
// 的字节账用例（用例 3）只钉「残余远小于同形状的整段基线」这个**关系**，不钓绝对值。
//
// 读侧现在**没有正文读者**（issue #754 裁决 2，2026-11-08）：`src/loop/resume-manager.js` 里那条
// 「旧格式升级路径」曾经是 `snapshot.messages` 的唯一读者，它把 `slice(anchor)` 那一段补进上下文；
// 现在它**正式关掉**——恢复一条正文也不从快照喂，该格只剩一个**只量条数**的探针（用于在恢复告示里
// 出声）。写侧照旧：本轮起点之前、且本进程亲手落过盘的那些格子写成 `null`，**数组长度与绝对下标
// 不动**（宿主侧那些拿 `messages.length` 数槽的读法、以及历史里那些「整段正文」的旧快照都不受影响）。
//
// ---------------------------------------------------------------------------
// 本片**只声明实测到的那一件事**（与 `src/loop/orchestrator.js` 写点注释、两份契约同一口径）：
//
//   写侧 `residueStart = max(0, min(正文长度, 本轮起点, persistedTranscriptLength))`，被置 `null` 的
//   下标全部 < `residueStart`。改判前那句「唯一的读者只切 `slice(anchor)`，而 `anchor >= residueStart`
//   ⇒ 读者永远读不到被省掉的格子」仍然为真，但**前提没了**：那个读者已被 #754 关掉 ⇒ 这一格现在
//   在恢复路径上只剩一个条数探针（它也不看格子内容，只看长度与非 null 计数）。
//
// **这只是一句关于写侧的陈述，从来不是「每一段正文都还在」的承诺。** 三个项各自的括法：
// 1. `persistedTranscriptLength` 只在本进程**亲手把一条逻辑消息落盘成功**时才 `+= 1`（写侧两处
//    都带 `if (persisted)` 守卫），而恢复侧的锚点 `countResumeAnchor(records)` 量的是**同一本账**
//    在更晚时刻折出来的逻辑条数（账本只追加、不重写）⇒ 前者 <= 后者。
// 2. 「本轮起点」之前的正文属于上一轮及更早：逐条入账（工单 261021 第二刀）+ #326 的引擎补充行
//    已把它们写进账本 ⇒ 同样 <= 锚点。折叠（compaction）只让**内存**里那段变短，账本不缩 ⇒ 锚点
//    只会更靠后，方向仍是安全的。
// 3. **已知例外（已随 issue #754 裁决 2 关掉）**：恢复的升级路径（#424 的 `resume_journal_skipped`
//    守卫所在那条）曾把旧快照里的崩溃轮正文补进 `ctx.messages` 却**一条都不入账**；而恢复锚点是一
//    个**标量**（折叠后的逻辑消息条数）、不是「快照哪些下标已入账」的位图 ⇒ 第一跳续跑一入账，第二跳
//    的锚点就从 3 涨到 5（夹具实测），那段只在内存里的正文就落到 `slice(anchor)` 起点之前——**写侧
//    无论怎么写（整段 / 残余）都取不回它**（用例 6 与「写回整段」的副本引擎逐字对账钉过：同一形状，
//    两侧同结果）。⇒ 裁决 2 把它当**不支持的旧档案**处理：不再猜、不再抢，直接不喂 + 出声。
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
// 用例与工单 D 的四格对应（①⑤⑥ 已按 issue #754 裁决 2 翻成「断言弃用」）：
//   ① 用例 1 = 旧格式（pre-261021）档案**不再支持恢复**：一条正文也不喂、恢复从账本重建、
//      恢复告示里明示「丢弃了 N 条」；用例 2（快照被覆盖后二次恢复）钉的是载荷面（新快照只带
//      残余）与「与基点行为逐字相同」；
//   ② 新格式续跑逐字不变 ⇒ 由既有恢复用例全集承担（`npm test`：`loop-resume-*`、
//      `loop-invalid-arguments`、`cross-version-real-e2e` 等）；
//   ③ 用例 3（快照里不再有锚点之前那段前缀：按**非 null 条数**与**独立字节基线**断言，不断言原文）；
//   ④ 用例 4 = 载荷面三种写法（整段 / 删残余 / 前缀置 null）现在交出**同一份上下文**（读者已关）；
//      用例 5 = 变异「写回整段」（**副本引擎**，issue #411 的纪律）⇒ ③ 的两条判据红；
//      用例 6 = 两跳恢复**断言弃用**（与副本引擎逐字对账）；用例 7 = 出声本身：旧格式才出声。
//   本刀的契约文案面守卫另开一文件：`test/docs-no-overclaim-735.test.js`。
//
// 夹具 `test/fixtures/journal-0.22.0/`：0.22.0 CLI 的真产物，**没有** `kind:"message"` 行、正文挂在
// 轮行上，正是「崩溃轮的正文只在快照里」那种旧格式账本。本文件只读它，一个字都不改。
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTmp } from "./helpers/tmp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
// 变异探针跑在 `src/` 的**副本**上：`mutateEngine()` 造好副本，把路径经 `ERIX_ENGINE_ROOT` 递给
// 子进程（同一份用例文件、坏引擎），于是「红」是真的退出码，不是自说自话。
const ENGINE_ROOT = process.env.ERIX_ENGINE_ROOT ?? REPO_ROOT;
const insideMutationRun = process.env.ERIX_ENGINE_ROOT !== undefined;
// issue #774：下面那几条「元用例」自己也要 spawn 一份本文件，必须有一道**不递归**闸门，否则
// 「用另一个 runner 跑整份文件」这一格会无限展开（每层再生一个整份跑的孙子）。
const insideMetaChildRun = process.env.ERIX_735_META_CHILD !== undefined;

const { createMemoryTranscriptStore } = await import(
  pathToFileURL(join(ENGINE_ROOT, "src/store/memory.js")).href);
const { foldLedgerMessages } = await import(
  pathToFileURL(join(ENGINE_ROOT, "src/store/message-rows.js")).href);
// issue #754（裁决 2）：弃用说明的文案钉在引擎导出的常量上（与 `test/loop-resume-notice.test.js` 同口径）。
const { RESUME_NOTICE_LEGACY_DEPRECATION, RESUME_NOTICE_TAG } = await import(
  pathToFileURL(join(ENGINE_ROOT, "src/loop/resume-notice.js")).href);
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
const rangeOf = (from, to) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
const bodyCountOf = (messages) => (messages ?? [])
  .filter((message) => message !== null && message !== undefined).length;
/** 递给模型的那条恢复告示的正文（没有 ⇒ 空串）。 */
const noticeTextOf = (messages) => (messages ?? [])
  .filter((message) => JSON.stringify(message ?? "").includes(RESUME_NOTICE_TAG))
  .map((message) => (message?.content ?? []).map((block) => String(block?.text ?? "")).join(""))
  .join("\n");
/** 账本里那些 `…:control:resume-notice:<fp>` 行的原文（宿主可见的那一面）。 */
const noticeRowTexts = async (store) => (await store.load(FIX_RUN_ID))
  .filter((record) => String(record?.dedupKey ?? "").includes(":control:resume-notice:"))
  .map((record) => JSON.stringify(record?.messages ?? ""));
/** 两次真跑之间必然不同的只有引擎自己造的两件瞬时量：调用身份键 `erix.toolCallKey`（逐次随机）与
 * 执行耗时 `erix.durationMs`（实测 1 vs 4 ms）。逐字对账前把它们归一（先例：
 * `test/loop-host-steer-turn-753.test.js:56` 用的是同一条 `toolCallKey` 正则）。 */
const withoutNonce = (value) => JSON.parse(JSON.stringify(value)
  .replace(/"toolCallKey":"[^"]*"/gu, '"toolCallKey":"<key>"')
  .replace(/"durationMs":\d+/gu, '"durationMs":0'));

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

/** #754 裁决 2 的判据：那条「只在快照里」的崩溃轮正文（连同它那一轮的结果）一条也进不了上下文。 */
function assertLegacyBodyNotFed(provider) {
  assert.equal(provider.requests.length, 1,
    "恢复必须真的发出一次模型请求（0 次 = 引擎在请求之前就静默中止，判据 2 不许）");
  const sent = provider.requests[0].messages;
  assert.equal(countMarker(sent), 0,
    `崩溃轮那段只在快照里的正文必须一条也不喂（实测 ${countMarker(sent)} 份）`);
  assert.equal(resultsFor(sent, RESIDUE_RESULT_ID).length, 0,
    "同源同去留：那一轮那条已成型的结果也不喂（喂了就是孤儿 tool_result ⇒ invalid_messages）");
}

// ── ① 旧格式（pre-261021）档案不再支持恢复（issue #754 裁决 2）────────────────────

test("#754 裁决 2 · ① 旧格式档案（崩溃轮正文只在快照里）不再支持恢复：一条也不喂、从账本重建、告示明示共 N 条", async () => {
  assert.equal(ANCHOR, 3, `夹具现场：锚点应是 round 0+1 的 3 条正文（实测 ${ANCHOR}）`);
  assert.ok(fixtureSnapshot.messages.length > ANCHOR,
    "夹具快照必须带着锚点之后的残余（否则本用例的现场不存在）");
  assert.deepEqual(fixtureRows.filter((row) => row.kind === "message"), [],
    "前置：夹具是旧格式账本（没有 0.23.0 的逐条消息行）");

  const store = await seedFixtureScene(createMemoryTranscriptStore());
  const resumed = await resumeOnce(store, [endTurn("续跑完成"), endTurn("兜底")]);
  // 弃用结局 = **明示降级为从账本重建**（判据 1：既不是 `invalid_messages`，也不是中途悬挂的 tool_use）。
  assert.equal(resumed.ok, true,
    `旧格式恢复必须给出明示的、可观察的结局（实测：${String(resumed.error)}）`);
  assertLegacyBodyNotFed(resumed.provider);
  // 禁止静默（判据 2）：丢正文必须**抵达模型** —— 告示里带弃用句与实测条数（夹具：快照 5 格 - 锚点 3）。
  const notice = noticeTextOf(resumed.provider.requests[0].messages);
  assert.ok(notice.includes(RESUME_NOTICE_LEGACY_DEPRECATION),
    `递给模型的上下文末尾必须带弃用说明，实测：${notice.slice(0, 200)}`);
  assert.match(notice, /共 2 条，该格式已不再支持恢复/u,
    `条数必须是实测的那一个（5 - 3 = 2），实测：${notice.slice(0, 200)}`);
  // 同一句也在宿主可见的账本里（`…:control:resume-notice:<fp>` 行）。
  const rows = await noticeRowTexts(store);
  assert.equal(rows.length, 1, `本次恢复必须恰写一条 resume-notice 控制行（实测 ${rows.length}）`);
  assert.ok(rows[0].includes(RESUME_NOTICE_LEGACY_DEPRECATION), "入账的那条同样必须带弃用句");
});

test("#754 判据 2 · 出声只在旧格式：账本已带全正文的档案（同一夹具、不截账本）一个字都不多", async () => {
  // 对照组 = **同一份夹具快照**，但账本不截 ⇒ 锚点（现算 6 条）已经 >= 快照的 5 格 ⇒ 没有任何东西被丢。
  const inner = createMemoryTranscriptStore();
  for (const row of fixtureRows) await inner.appendRound(FIX_RUN_ID, structuredClone(row));
  await inner.saveRunSnapshot(FIX_RUN_ID, structuredClone(fixtureSnapshot));
  assert.ok(foldLedgerMessages(structuredClone(fixtureRows)).length >= fixtureSnapshot.messages.length,
    "前置：对照组的账本必须不比快照短（否则这条对照判据空转）");

  const resumed = await resumeOnce(inner, [endTurn("续跑完成"), endTurn("兜底")]);
  assert.equal(resumed.ok, true, `对照组必须照常恢复（实测：${String(resumed.error)}）`);
  assert.equal(resumed.provider.requests.length, 1, "对照组必须真的发出过一次请求");
  const notice = noticeTextOf(resumed.provider.requests[0].messages);
  assert.ok(notice.includes(RESUME_NOTICE_TAG), "对照组照旧是恢复运行 ⇒ 告示本体还在");
  assert.ok(!notice.includes(RESUME_NOTICE_LEGACY_DEPRECATION),
    `一条正文都没丢 ⇒ 不许出现弃用说明，实测：${notice.slice(0, 200)}`);
  const rows = await noticeRowTexts(inner);
  assert.equal(rows.filter((text) => text.includes(RESUME_NOTICE_LEGACY_DEPRECATION)).length, 0,
    "入账的告示同样不许带弃用句");
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
      return { ok: true, requests: withoutNonce(provider.requests) };
    } catch (error) {
      return {
        ok: false,
        error: `${String(error?.code ?? error?.name)}: ${String(error?.message)}`,
        requests: withoutNonce(provider.requests),
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
    store: inner,
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

// ── ④b 载荷面：读者关掉之后，这一格怎么写都不再决定「喂进什么正文」 ──────────────
//
// 改判前这条钉的是「删掉读侧要的那段 ⇒ ① 红」。现在 `snapshot.messages` 在恢复路径上**没有正文读者**
// （issue #754 裁决 2），所以三种载荷形状交给模型的正文**一模一样：一条也没有**（都只剩账本）。
// 唯一还留着的可观察差别是**条数探针**——它只看数组长度与锚点（`resume-manager.js` 的
// `legacySnapshotBodyDropped`），于是：
//   · 整段基线 / 前缀置 null（长度都是 5 > 锚点 3）⇒ 告示里出现「共 2 条」那句弃用说明；
//   · 把 `slice(anchor)` 那段真的截掉（长度变成 3 == 锚点）⇒ 引擎**看不见**丢弃 ⇒ 不出声，而那次
//     恢复以 `invalid_messages` 收场：快照里那条已成型的结果照常从 A 集合接回，而它配对的
//     assistant 哪儿都没有（正文读者已关、条数探针没触发 ⇒ 那一轮的结果也没被同源同去留挡住）。
//     这个形状是**手工造出来的说谎载荷**：引擎写侧从不缩短数组（「长度与绝对下标不动」是写侧契约），
//     所以这里把它当**变异体**钉住，而不是当宿主会遇到的现场。

test("#754 裁决 2 · ④b 载荷面三种写法都不再决定喂入的正文（读者已关）；唯一残留差别是条数探针", async () => {
  const variants = {
    whole: await seedFixtureScene(createMemoryTranscriptStore(), () => {}),
    elided: await seedFixtureScene(createMemoryTranscriptStore(),
      (snapshot, anchor) => { snapshot.messages = snapshot.messages.map((message, index) => (index < anchor ? null : message)); }),
    truncated: await seedFixtureScene(createMemoryTranscriptStore(),
      (snapshot, anchor) => { snapshot.messages = snapshot.messages.slice(0, anchor); }),
  };
  const runs = {};
  for (const [name, store] of Object.entries(variants)) {
    runs[name] = await resumeOnce(store, [endTurn("续跑完成"), endTurn("兜底")]);
  }
  // ① 载荷面不再决定正文：两种「长度仍是 5」的写法交出**逐字相同**的上下文，而且里面一条快照正文都没有。
  assert.equal(runs.whole.ok, true, `整段基线必须恢复成功（实测：${String(runs.whole.error)}）`);
  assert.equal(runs.elided.ok, true, `前缀置 null 必须恢复成功（实测：${String(runs.elided.error)}）`);
  assertLegacyBodyNotFed(runs.whole.provider);
  assertLegacyBodyNotFed(runs.elided.provider);
  assert.deepEqual(withoutNonce(runs.elided.provider.requests[0].messages),
    withoutNonce(runs.whole.provider.requests[0].messages),
    "「整段」与「前缀置 null」两种载荷必须交出逐字相同的上下文（正文读者已关，前缀更是死重）");
  // ② 唯一残留的可观察差别：条数探针（只看数组长度）。
  assert.match(noticeTextOf(runs.whole.provider.requests[0].messages),
    /本次恢复丢弃了 pre-261021 档案中只存在于快照的崩溃轮正文（共 2 条/u,
    "整段基线：探针必须报 2 条（快照 5 格 - 锚点 3）");
  assert.ok(noticeTextOf(runs.elided.provider.requests[0].messages)
    .includes(RESUME_NOTICE_LEGACY_DEPRECATION), "前缀置 null：格子内容不参与计数 ⇒ 同样出声");
  // ③ 变异体：数组长度说谎（短到 == 锚点）⇒ 探针看不见丢弃 ⇒ 不出声，而那次恢复当场红。
  assert.equal(runs.truncated.ok, false, `截短载荷必须红（实测 ok=${runs.truncated.ok}）`);
  assert.match(String(runs.truncated.error), /invalid_messages/u,
    `红在消息校验（A 集合结果没了配对的 assistant）：${String(runs.truncated.error)}`);
  assert.match(String(runs.truncated.error), /tool_result has no matching assistant tool_use/u,
    "红的原因必须是孤儿 tool_result（判据在 `src/messages/rounds.js`）");
  assert.equal(runs.truncated.provider.requests.length, 0, "红在第一次模型请求之前：0 次请求");
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

// ── ④a 的子进程与判定器（issue #774：判定不许依赖 runner 的 Node 版本）───────────
//
// Node 24 把 `node --test` 的**默认 reporter 换成了 spec**（`✖ …` / `ℹ tests …`），而「红在**哪一格**」
// 这件事只有 TAP 的 `not ok N - <名字>` 答得出来。所以两件事必须分开：
//   · **spawn 侧**显式 `--test-reporter=tap`——默认 reporter 是 runner 的属性，不是这条用例的判据；
//   · **判定侧**先验形状：读不到 TAP ⇒ `undetermined`（未判定），**既不判绿**（那是把读不到当通过）
//     **也不判「③ 没红」**（那是把读不到当判据，假红）——与本仓「读不出真值 ⇒ exit 2」同一口径。
// 判定**不许退化成只查退出码**：退出码答不出「红在哪一格」，正是本单的两条反向证之一在钉这件事。
const MUTANT_RED = "③ 快照里不再有锚点之前那段前缀";
/**
 * 变异只改载荷大小、不改恢复语义 ⇒ 这几格在变异体上必须照旧绿（否则 ④a 测的就不是 ③）。
 *
 * ⚠ **合并树现名**（issue #754 裁决 2 把那两条读侧用例从「记录当前行为」翻成「断言弃用」，格名一起改了）：
 * main 侧 #774 登记的是改名前的 `① 旧格式账本` / `④b 变异「删掉残余」`，在本树上已经**一格都找不到**
 * ⇒ 直接抄 main 会让判定器只会打「不该拆掉」的假红（而 #774 那条反向证照样绿，因为它只查 problems 非空）。
 * 第三条是本片自己加的「出声只在旧格式」（原 HEAD 侧的三条 `assert.match(output, …)`，此处改由判定器统一判，
 * 覆盖面一格没少）。名字取**唯一子串**，与 `judgeMutationLog` 的 `ok N - <名>` 匹配口径一致。
 */
const MUTANT_STILL_GREEN = [
  "① 旧格式档案（崩溃轮正文只在快照里）不再支持恢复",
  "④b 载荷面三种写法都不再决定喂入的正文",
  "#754 判据 2 · 出声只在旧格式",
];

/**
 * 纯函数形态的判定（反向证用例直接喂真日志，不靠手工跑一次）。
 *
 * @param {{status: number|undefined|null, stdout?: string, stderr?: string}} child
 * @returns {{verdict: "ok"|"red"|"undetermined", problems: string[], output: string}}
 */
function judgeMutationLog({ status, stdout, stderr }) {
  const output = `${stdout ?? ""}${stderr ?? ""}`;
  if (!/^TAP version 13$/mu.test(output)) {
    return {
      verdict: "undetermined",
      problems: ["子进程没交回 TAP（没有 `TAP version 13` 头）⇒ **未判定**：spec reporter（Node 24 起 "
        + "`node --test` 的默认）只有 `✖ …`，答不出「红在哪一格」——spawn 必须显式 --test-reporter=tap"],
      output,
    };
  }
  const lines = output.split("\n");
  const problems = [];
  if (status === 0) problems.push("变异体上整个文件必须非零退出（实测退出码 0）");
  if (!lines.some((line) => /^not ok \d+ - /u.test(line) && line.includes(MUTANT_RED))) {
    problems.push(`变异体上必须有一行点名「${MUTANT_RED}」的 "not ok N - …"（只查退出码不算判定）`);
  }
  for (const name of MUTANT_STILL_GREEN) {
    if (!lines.some((line) => /^ok \d+ - /u.test(line) && line.includes(name))) {
      problems.push(`变异体不该拆掉「${name}」：它只把载荷写胖，恢复语义没变`);
    }
  }
  return { verdict: problems.length ? "red" : "ok", problems, output };
}

/**
 * 跑本文件的一份子进程，reporter **写死在 argv 里**（issue #774）。
 *
 * @param {{reporter?: "tap"|"spec", engineRoot?: string, runner?: string, metaChild?: boolean}} [options]
 */
function spawnFileUnderTest({ reporter = "tap", engineRoot, runner = process.execPath, metaChild = false } = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env)
    // `NODE_TEST_CONTEXT` 传下去会让子进程以为自己还在别人的 test run 里（实测警告
    // 「run() is being called recursively within a test file. skipping running files」⇒ 直接 0 退出），
    // 必须**删掉**这个键（留空串也一样）。
    .filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  return spawnSync(runner, ["--test", `--test-reporter=${reporter}`, "test/loop-snapshot-round-residue-735.test.js"], {
    cwd: REPO_ROOT,
    env: {
      ...inherited,
      ...(engineRoot ? { ERIX_ENGINE_ROOT: engineRoot } : {}),
      ...(metaChild ? { ERIX_735_META_CHILD: "1" } : {}),
    },
    encoding: "utf8",
    timeout: 120_000,
  });
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
    // reporter 显式给 tap：Node 22 的默认是 TAP、Node 24 的默认是 spec，判定只能跟 argv 走。
    const child = spawnFileUnderTest({ engineRoot: mutatedRoot });
    const verdict = judgeMutationLog(child);
    assert.deepEqual(verdict.problems, [],
      `变异体上 ③ 必须红（退出码 ${String(child.status)}，verdict=${verdict.verdict}）：\n${verdict.output.slice(0, 1500)}`);
    assert.notEqual(child.status, 0, "变异体上整个文件必须非零退出");
  } finally {
    rmSync(mutatedRoot, { recursive: true, force: true });
  }
  assert.ok(readFileSync(join(ENGINE_ROOT, "src/loop/orchestrator.js"), "utf8")
    .includes("messages: snapshotTranscriptResidue,"),
    "仓内写侧必须仍是轮残余（变异只发生在副本上）");
});

// ── ④a 判定器自己的反向证（issue #774；口径同 #210 R2：变异没落上 = 这一例没跑起来）──

test("#774 反向证 · 被变异那一侧改回「不该红」⇒ ④a 必须红，且红在点名 ③ 上", async (t) => {
  if (insideMutationRun) {
    t.skip("变异子进程里不再递归跑变异");
    return;
  }
  // `replace` 与 `search` 同一个串 ⇒ 副本内容与仓内**逐字相同**，这就是「变异没落上」那一刀：
  // 子进程里 ③ 是绿的，判定必须因此**红**，而不是安静地「看起来没问题」。
  const untouchedRoot = await mutateEngine("noop",
    "messages: snapshotTranscriptResidue,",
    "messages: snapshotTranscriptResidue,");
  try {
    const child = spawnFileUnderTest({ engineRoot: untouchedRoot });
    const verdict = judgeMutationLog(child);
    assert.notEqual(verdict.verdict, "ok",
      `引擎没被改坏时 ④a 不许绿（否则它就是常绿闸）：\n${verdict.problems.join("\n")}`);
    assert.match(verdict.problems.join("\n"), new RegExp(MUTANT_RED, "u"),
      `判定必须点名 ③，不许只说「退出码不对」：\n${verdict.problems.join("\n")}`);
    assert.match(verdict.problems.join("\n"), /非零退出/u, "退出码这一维也要一起点名");
  } finally {
    rmSync(untouchedRoot, { recursive: true, force: true });
  }
});

test("#774 反向证 · 子进程 reporter 不是 TAP ⇒ 判「未判定」，既不判绿也不把读不到当红", async (t) => {
  if (insideMutationRun) {
    t.skip("变异子进程里不再递归跑变异");
    return;
  }
  const mutatedRoot = await mutateEngine("specshape",
    "messages: snapshotTranscriptResidue,",
    "messages: cloneState(transcriptForSnapshot),");
  try {
    // 同一份变异体、同一个坏引擎，**只**把 reporter 换成 spec（= Node 24 的默认）。
    const child = spawnFileUnderTest({ engineRoot: mutatedRoot, reporter: "spec" });
    const verdict = judgeMutationLog(child);
    assert.equal(verdict.verdict, "undetermined",
      `spec 日志只能判「未判定」（判绿是假绿，判「③ 没红」是假红）：\n${verdict.problems.join("\n")}`);
    assert.match(verdict.problems.join("\n"), /未判定/u, "必须明说「未判定」");
    assert.match(verdict.problems.join("\n"), /TAP/u, "必须说清缺的是 TAP 形状");
    // 这一格同时钉住「不许退化成只查退出码」：spec 日志里退出码照样非 0，却已经没有 `not ok` 了。
    assert.notEqual(child.status, 0, "夹具前提：变异体在 spec 下退出码同样非 0");
    assert.doesNotMatch(verdict.output, /^not ok /mu, "夹具前提：spec 输出里没有 not ok ⇒ 只看退出码会丢格位");
  } finally {
    rmSync(mutatedRoot, { recursive: true, force: true });
  }
});

// ── runner 版本无关性（issue #774 反向证 ①）──────────────────────────────────

/** 本机上的「另一个 runner」候选：环境变量优先，其次仓内既有约定的 `~/.local/node24/bin/node`。 */
const ALT_RUNNER_CANDIDATES = [
  process.env.ERIX_NODE24,
  join(homedir(), ".local", "node24", "bin", "node"),
].filter((candidate) => typeof candidate === "string" && candidate !== "");

/** 找一个 major >= `minMajor` 的 node 可执行文件；当前这个就够用时直接返回自己。 */
function findNodeMajor(minMajor) {
  if (Number(process.versions.node.split(".")[0]) >= minMajor) return process.execPath;
  for (const candidate of ALT_RUNNER_CANDIDATES) {
    const probe = spawnSync(candidate, ["-v"], { encoding: "utf8" });
    const major = Number(String(probe.stdout ?? "").trim().replace(/^v/u, "").split(".")[0]);
    if (probe.status === 0 && major >= minMajor) return candidate;
  }
  return null;
}

test("#774 反向证 · 整份文件在**当前 runner**上全绿，且默认 reporter 换成 spec 也全绿", async (t) => {
  if (insideMutationRun || insideMetaChildRun) {
    t.skip("元用例的子进程里不再递归跑整份文件");
    return;
  }
  // 这一格不依赖任何外部 runner：把默认 reporter 强制换成 spec（Node 24 的默认形状）再跑整份文件，
  // 仍然必须 exit 0 —— 证明本文件的判定不跟 runner 的默认走。CI 的 node 24 job 上它就是「24 下全绿」。
  const child = spawnFileUnderTest({ reporter: "spec", metaChild: true });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  assert.equal(child.status, 0, `spec 默认形状下整份文件必须 exit 0：\n${output.slice(0, 2000)}`);
  assert.doesNotMatch(output, /^✖ /mu, "spec 形状下也不许有红格");
});

test("#774 反向证 · 手上有 Node 24 runner 时，用它跑整份文件必须全绿", async (t) => {
  if (insideMutationRun || insideMetaChildRun) {
    t.skip("元用例的子进程里不再递归跑整份文件");
    return;
  }
  const runner = findNodeMajor(24);
  if (!runner) {
    t.skip("这台机器上找不到 Node 24 runner（设 ERIX_NODE24=<可执行文件路径>；CI 的 node 24 job 走 process.execPath 那条路）");
    return;
  }
  const child = spawnFileUnderTest({ runner, metaChild: true });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  assert.equal(child.status, 0, `Node 24 runner 上整份文件必须 exit 0：\n${output.slice(0, 2000)}`);
  assert.match(output, /^# fail 0$/mu, "Node 24 runner 上 TAP 汇总必须 `# fail 0`");
  assert.match(output, /^# tests (\d+)$/mu, "必须交回完整的 TAP 汇总块");
  assert.doesNotMatch(output, /^not ok /mu, "Node 24 runner 上一条都不许红");
});

// ── ⑥ 两跳恢复：**断言弃用**（issue #754 裁决 2；改判前这条只「记录当前行为」）──────────
//
// 场景：旧格式账本 + 旧快照 → 第一跳恢复（引擎亲笔覆盖写新快照）→ 注入崩溃 → 第二跳恢复。
// 改判前钉的是「第二跳必坏」（`invalid_messages`、0 次请求，且两棵写侧写法逐字同结果 ⇒ 主干既有缺陷）。
// 裁决 2 把那条唯一的快照正文读者关掉之后，本用例改钉**弃用结局**：
//   · 两跳都**一条正文也不**从快照 `messages` 补（`countMarker(...) === 0`）；
//   · 两跳都从账本重建 ⇒ **这一类现场**（满足旧闸门原触发条件、且快照数组长度没撒谎）不再出现
//     `invalid_messages`，第二跳**真的发出**模型请求。⚠ 不是普适不变式：④b 那个「数组长度说谎」的
//     变异体仍以 `invalid_messages` 收场，写侧契约保证长度不缩，所以它被钉成变异体而不是宿主现场；
//   · 两跳各写一条恢复告示，各自带「共 N 条」的实测条数（第一跳 5-3=2，第二跳 6-5=1）。
// 注入点（`armedAfterSnapshot` ⇒ 下一条 `appendRound` 抛）现在**真的**落在「新快照已写、下一条正文行
// 未落」那个窗口里：正文读者还在时第一跳根本活不到写第二份快照，那个窗口是空的（本文件前一版的
// 「记录当前行为」就是被这一点污染的）。

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
      return { ok: true, requests: withoutNonce(provider.requests) };
    } catch (error) {
      return {
        ok: false,
        error: `${String(error?.code ?? error?.name)}: ${String(error?.message)}`,
        requests: withoutNonce(provider.requests),
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
    store: inner,
    latestRound: latest.round,
    latestMessages: latest.messages,
    anchorAfter: foldLedgerMessages(await inner.load(FIX_RUN_ID)).length,
  };
}

test("#754 裁决 2 · ⑥ 两跳恢复断言弃用：两跳都不从快照 messages 补正文、都从账本重建、各自出声报条数", async (t) => {
  const scene = await runTwoHopScene(ENGINE_ROOT);
  assert.ok(scene.crashed, "前置：必须真的崩在「新快照已写、再下一条正文行未落」那一刻");
  assert.ok(scene.latestRound > fixtureSnapshot.round,
    `前置：引擎必须已覆盖写过新快照（实测 round=${scene.latestRound}）`);
  assert.match(String(scene.first.error), /persistence_failed/u,
    `前置：第一跳必须是被注入的落盘崩溃打断的（而不是在请求之前就地死掉）：${String(scene.first.error)}`);
  // 锚点涨长的那笔账（#754 的根因，读侧现在不再试图补它）：本次现场从 ANCHOR 涨到 anchorAfter。
  assert.ok(scene.anchorAfter > ANCHOR,
    `前置：第二跳的锚点必须已因第一跳的入账而涨长（实测 ${ANCHOR} → ${scene.anchorAfter}）`);

  // ↓↓↓ 弃用行为（#754 裁决 2）。四条都是**断言**，不是记录。
  // 第一跳：真的发出过一次请求（改判前它是活的，但那次请求里带着那段只在内存里的旧正文）。
  assert.equal(scene.first.requests.length, 1,
    `第一跳必须真的发出过一次模型请求（实测 ${scene.first.requests.length}）`);
  assert.equal(countMarker(scene.first.requests[0]?.messages ?? []), 0,
    "第一跳：那段只在快照里的旧正文一条也不许进上下文（改判前这里是 1 份）");
  assert.match(noticeTextOf(scene.first.requests[0]?.messages ?? []),
    /本次恢复丢弃了 pre-261021 档案中只存在于快照的崩溃轮正文（共 2 条/u,
    "第一跳必须出声：告示里带弃用句与实测条数（快照 5 格 - 锚点 3）");
  // 第二跳：**明示降级为从账本重建** —— 既不是 invalid_messages，也不是悬挂的 tool_use。
  assert.equal(scene.second.ok, true,
    `第二跳必须恢复成功（判据 1：弃用结局不许是 invalid_messages）。实测：${String(scene.second.error)}`);
  assert.equal(scene.second.requests.length, 1,
    "第二跳必须真的发出模型请求（改判前是 0 次：请求之前就抛了）");
  assert.equal(countMarker(scene.second.requests[0]?.messages ?? []), 0,
    "第二跳：同样一条正文也不从快照 messages 补");
  assert.match(noticeTextOf(scene.second.requests[0]?.messages ?? []),
    /本次恢复丢弃了 pre-261021 档案中只存在于快照的崩溃轮正文（共 1 条/u,
    "第二跳也必须出声：本次的条数是 6 格 - 锚点 5 = 1");
  assert.equal(countMarker(scene.latestMessages), 0,
    `那段旧正文在新快照里也已被残余规则省掉（实测 ${countMarker(scene.latestMessages)} 份）`);
  const rows = await noticeRowTexts(scene.store);
  assert.equal(rows.filter((text) => text.includes(RESUME_NOTICE_LEGACY_DEPRECATION)).length, 2,
    `两跳各写一条带弃用句的账本告示（实测 ${rows.length} 条告示里匹配 ${rows.filter((t) => t.includes(RESUME_NOTICE_LEGACY_DEPRECATION)).length}）`);
  // ↑↑↑

  // 载荷面无关性：与「写回整段」（= 主干写法）的副本引擎逐字对账 ⇒ 正文读者关掉之后，写侧怎么写
  // 都不影响恢复（这一条比改判前更强：那时两侧同结果的原因是**都失败**）。
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
      "第二跳的成败与上下文必须与「写回整段」逐字相同（正文没有读者 ⇒ 载荷形状不参与）");
    assert.equal(scene.anchorAfter, baseline.anchorAfter,
      "两棵的锚点必须同口径（锚点只看账本，与快照写什么无关）");
    t.diagnostic("两跳第二跳两棵同结果（弃用结局 = 从账本重建 + 出声）："
      + `ok=${scene.second.ok} 请求数=${scene.second.requests.length} `
      + `旧正文份数=${countMarker(scene.second.requests[0]?.messages ?? [])} `
      + `锚点 ${ANCHOR}→${scene.anchorAfter}`);
  } finally {
    rmSync(wholeRoot, { recursive: true, force: true });
  }
});
