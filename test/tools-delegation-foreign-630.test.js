// issue #630（S2）——D 组的五条判据 + F / G / I：**全部走真装配**（真的 `createDelegateTool` /
// 真的 `createCliDelegation` / 真的名册目录 / 真的 `process.kill(pid, 0)` 谓词），不喂手写谓词。
//
// 现场（真机复现，本文件的存在理由）：进程 A 派发一个后台子 run（名册 `state=queued`、`pid` 是 A 的
// 真实存活进程号）→ **进程 B 只调一次 `status`** → 返回 `interrupted`，且盘上的记录被改写。根因两条：
//   1. `reconcileFirst()` 只传 `ownedRunIds` + `now`，没传 `isProcessAlive` ⇒「活态 + 不在本进程 owned」
//      直接落到「无人认领 ⇒ interrupted」那一支；
//   2. 名册目录缺省是共享的 `~/.erix/delegation/` ⇒ 两个并发 CLI 会话就会互踩。
//
// 覆盖：
//   D-1 跨实例（模拟两个进程）：A 派发、B 调 `status` ⇒ 记录仍是 `running`、进 `foreignOwned`、盘上未被改写；
//   D-2 谓词说「死」（真进程：spawn 一个、等它退出、拿它真实的 pid）⇒ `interrupted`，`endedAt` == 原 `updatedAt`；
//   D-3 没有谓词 ⇒ 记录不动，出现在 `unverified` 桶里（fail-safe：宁可留脏记录，不许谎报活子死了）；
//   D-4 `queued → running` 真的被写（`runChild` 被调用的那一刻名册就已经是 `running`）；
//   D-5 `result` 对卡在活态的死记录先重算 ⇒ 返回终态而不是 `still_running`（真正活着的子语义不变）；
//   F   父的显式压缩预算下传给子（用引擎自己的 `invalid_budget` 报错文本当**精确值探针**）；
//   G   名册读取校形状：`state:"weird"` / `updatedAt:"123"` / 缺 `updatedAt` ⇒ 点名 corrupt，不当正常记录；
//   I   完成去重键带分隔符：两组「曾经会碰撞」的 (runId, endedAt) 现在不同。
//
// 离线：零网络、零 `~/.erix`；临时目录一律走 `test/helpers/tmp.js` 的 `makeTmp(...)`。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createCliDelegation, isProcessAlive } from "../bin/delegation.js";
import { completionMarkerKey } from "../src/tools/delegation/notify.js";
import { listRecords, readRecord, writeRecord } from "../src/tools/delegation/roster.js";
import { createDelegateTool } from "../src/tools/delegation/tool.js";
import { makeTmp } from "./helpers/tmp.js";

/** 永不应答的 `runChild`：让名册停在活态（`running`），用来测「别的进程看见的是什么」。 */
const neverSettles = () => new Promise(() => {});

/**
 * 真死掉的 pid：spawn 一个马上退出的 node 子进程，等它**真的**退出（`close` 事件）后返回它的 pid。
 * 之后 `process.kill(pid, 0)` 必然抛 `ESRCH`（进程已回收）——这就是 D-2 / D-3 / D-5 需要的「谓词说死」
 * 的真实来源，不用手写 `() => false`。
 *
 * @returns {Promise<number>}
 */
function spawnExitedPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid;
    child.once("error", reject);
    child.once("close", () => resolve(pid));
  });
}

/** 轮询到谓词为真（后台收尾是异步的）；超时按失败处理。 */
async function waitFor(predicate, { timeoutMs = 5_000, stepMs = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时：条件一直不成立");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** 名册文件的逐字节快照（「盘上未被改写」的判据必须看字节，不能只看读回来的对象）。 */
function rawRecord(rosterDir, runId) {
  return readFileSync(join(rosterDir, `${runId}.json`), "utf8");
}

// ── D-1：跨实例（模拟两个进程）───────────────────────────────────────────────────────
test("真装配（#630 S2 D-1）：A 派发后 B 调 status ⇒ 记录仍是 running、进 foreignOwned、盘上未被改写", async () => {
  const rosterDir = await makeTmp("erix-delegation-630-d1-");
  // 两个工具实例指向**同一个**名册目录 = 两个进程共用 `~/.erix/delegation/` 的最小复现。
  const a = createDelegateTool({ runChild: neverSettles, rosterDir, isProcessAlive });
  const b = createDelegateTool({ runChild: neverSettles, rosterDir, isProcessAlive });

  const started = await a.execute({ action: "run", task: "后台跑着", background: true }, { runId: "parent-a" });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.state, "running", "D-1 前置：派发后名册就是 running（D-4 的另一半）");
  const before = rawRecord(rosterDir, started.runId);

  // B 只调一次 status —— 这正是真机缺陷的触发动作（缺陷：返回 interrupted，并把 A 的记录改写掉）。
  const status = await b.execute({ action: "status", runId: started.runId }, { runId: "parent-b" });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.record.state, "running", "别的进程养着的活子不许被本进程判死");
  assert.equal(status.record.endedAt, undefined, "没有结束，就不许有 endedAt");
  assert.equal(rawRecord(rosterDir, started.runId), before, "盘上记录必须逐字节未被改写（D 的核心判据）");

  // B 的 list：这条进 foreignOwned（点名让宿主看见），interrupted / unverified 都是空。
  const listed = await b.execute({ action: "list" }, { runId: "parent-b" });
  assert.deepEqual(listed.interrupted, [], "活着的记录不许进 interrupted");
  assert.deepEqual(listed.unverified, [], "有谓词、且谓词说活 ⇒ 不是 unverified");
  assert.deepEqual(listed.foreignOwned.map((entry) => entry.runId), [started.runId]);
  assert.equal(listed.foreignOwned[0].pid, process.pid, "pid 是 A 这个真实进程号");
  assert.match(listed.foreignOwned[0].reason, /另一宿主/u);

  // A 自己的 status 也不许自我误伤（ownedRunIds 那一支）。
  const own = await a.execute({ action: "status", runId: started.runId }, { runId: "parent-a" });
  assert.equal(own.record.state, "running");
  await a.execute({ action: "cancel", runId: started.runId });
});

// ── D-2：谓词说「死」⇒ interrupted，endedAt == 原 updatedAt ───────────────────────────
test("真装配（#630 S2 D-2）：谓词说死（真退出的 pid）⇒ interrupted，endedAt == 原 updatedAt", async () => {
  const rosterDir = await makeTmp("erix-delegation-630-d2-");
  const deadPid = await spawnExitedPid();
  assert.equal(isProcessAlive(deadPid), false, `刚退出的 pid ${deadPid} 必须被判死（真 process.kill）`);

  const runId = "sub-dead-630";
  const written = writeRecord(rosterDir, { runId, state: "running", updatedAt: 1_700_000_000_000, pid: deadPid });
  const a = createDelegateTool({ runChild: neverSettles, rosterDir, isProcessAlive });

  const status = await a.execute({ action: "status", runId });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.record.state, "interrupted", "谓词说死 ⇒ 照旧判 interrupted（既有正确语义）");
  assert.equal(status.record.endedAt, written.updatedAt, "endedAt 取**原记录的 updatedAt**，不是 now");
  assert.ok(status.record.updatedAt > written.updatedAt, "updatedAt 照常前移到重算时刻");

  const listed = await a.execute({ action: "list" });
  // 幂等：上面那次 `status` 已经把它改成终态，所以再重算一次不会再产生新的 `interrupted`。
  assert.deepEqual(listed.interrupted, [], "终态记录不再参与重算（幂等）");
  assert.equal(listed.records.find((record) => record.runId === runId).state, "interrupted");
  assert.deepEqual(listed.foreignOwned, []);
  assert.deepEqual(listed.unverified, []);
});

// ── D-3：没有谓词 ⇒ fail-safe（记录不动、进 unverified）────────────────────────────────
test("真装配（#630 S2 D-3）：没有谓词 ⇒ 带 pid 的活态记录不动，出现在 unverified 桶", async () => {
  const rosterDir = await makeTmp("erix-delegation-630-d3-");
  // 两条：一条 pid 已死（真退出）、一条 pid 活着（本进程）。没有谓词 ⇒ 两条都**不许**被判死。
  const deadPid = await spawnExitedPid();
  writeRecord(rosterDir, { runId: "sub-dead-630", state: "running", updatedAt: 1_700_000_000_000, pid: deadPid });
  writeRecord(rosterDir, { runId: "sub-live-630", state: "queued", updatedAt: 1_700_000_000_001, pid: process.pid });
  const beforeDead = rawRecord(rosterDir, "sub-dead-630");
  const beforeLive = rawRecord(rosterDir, "sub-live-630");

  // 不传 `isProcessAlive`：这就是「宿主没接谓词」的形状。
  const a = createDelegateTool({ runChild: neverSettles, rosterDir });
  const listed = await a.execute({ action: "list" });

  assert.deepEqual(listed.interrupted, [], "没有谓词就没有陈旧清理：宁可留脏记录，也不许谎报别人家的活子是死的");
  assert.deepEqual(listed.foreignOwned, []);
  assert.deepEqual(
    listed.unverified.map((entry) => [entry.runId, entry.pid]).sort(),
    [["sub-dead-630", deadPid], ["sub-live-630", process.pid]].sort(),
    "两条都进 unverified（带 runId / pid / updatedAt 供宿主自己处置）",
  );
  for (const entry of listed.unverified) {
    assert.equal(typeof entry.updatedAt, "number");
    assert.match(entry.reason, /isProcessAlive/u, "理由里要点名缺的是哪个端口");
  }
  assert.equal(rawRecord(rosterDir, "sub-dead-630"), beforeDead, "记录一个字节都不动");
  assert.equal(rawRecord(rosterDir, "sub-live-630"), beforeLive);
  // 记录本身照旧读得到（库不删、不改名、不就地修）。
  assert.equal(readRecord(rosterDir, "sub-dead-630").state, "running");
});

test("库面（#630 S2 D-3）：谓词自己抛错 ⇒ 同样按「无法证明死」处理，进 unverified 且记录不动", async () => {
  const rosterDir = await makeTmp("erix-delegation-630-d3-throw-");
  writeRecord(rosterDir, { runId: "sub-x", state: "running", updatedAt: 1_700_000_000_000, pid: 4242 });
  const before = rawRecord(rosterDir, "sub-x");
  const a = createDelegateTool({
    runChild: neverSettles,
    rosterDir,
    isProcessAlive: () => { throw new Error("谓词坏了 630"); },
  });
  const listed = await a.execute({ action: "list" });
  assert.deepEqual(listed.interrupted, [], "谓词抛错不是判死的理由");
  assert.equal(listed.unverified.length, 1);
  assert.match(listed.unverified[0].reason, /谓词坏了 630/u, "点名谓词的错误");
  assert.equal(rawRecord(rosterDir, "sub-x"), before);
});

// ── D-4：queued → running 真的被写 ────────────────────────────────────────────────────
test("真装配（#630 S2 D-4）：runChild 被调用的那一刻名册已经是 running（updatedAt 前移）", async () => {
  const rosterDir = await makeTmp("erix-delegation-630-d4-");
  /** runChild 里同步读到的状态——「写 running 在调 runChild 之前」的唯一硬证据。 */
  let stateAtChildStart;
  let updatedAtAtChildStart;
  let createdAtAtChildStart;
  const a = createDelegateTool({
    rosterDir,
    clock: () => 1_700_000_000_000, // 固定时钟：`updatedAt` 的前移只能来自「同一毫秒里也要动」的那条规则
    runChild: ({ runId }) => {
      const record = readRecord(rosterDir, runId);
      stateAtChildStart = record?.state;
      updatedAtAtChildStart = record?.updatedAt;
      createdAtAtChildStart = record?.createdAt;
      return neverSettles();
    },
  });

  const started = await a.execute({ action: "run", task: "卡住不回", background: true }, { runId: "parent-d4" });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(stateAtChildStart, "running", "调 runChild 之前就必须把 queued 改成 running（七状态里 running 以前从未被写入）");
  assert.ok(
    updatedAtAtChildStart > createdAtAtChildStart,
    `updatedAt 必须前移（createdAt ${createdAtAtChildStart} / running ${updatedAtAtChildStart}）`,
  );
  // 子 run 起来之后 status 看到的就是 running（不是 queued）。
  const status = await a.execute({ action: "status", runId: started.runId });
  assert.equal(status.record.state, "running");
  assert.equal(status.record.createdAt, createdAtAtChildStart, "queued 那一次写的 createdAt 必须保留");
  await a.execute({ action: "cancel", runId: started.runId });
});

// ── D-5：result 对卡在活态的死记录会先重算 ────────────────────────────────────────────
test("真装配（#630 S2 D-5）：result 先重算 ⇒ 卡在活态的死记录返回终态而不是 still_running", async () => {
  const rosterDir = await makeTmp("erix-delegation-630-d5-");
  const deadPid = await spawnExitedPid();
  writeRecord(rosterDir, {
    runId: "sub-stuck-630",
    state: "running",
    updatedAt: 1_700_000_000_000,
    pid: deadPid,
    termination: undefined,
  });
  const a = createDelegateTool({ runChild: neverSettles, rosterDir, isProcessAlive });

  const result = await a.execute({ action: "result", runId: "sub-stuck-630" });
  assert.equal(result.ok, true, `死记录必须被重算成终态：${JSON.stringify(result)}`);
  assert.equal(result.state, "interrupted", "重算后的终态是 interrupted");
  assert.equal(result.endedAt, 1_700_000_000_000, "endedAt 仍是原 updatedAt（不是 now）");
});

test("真装配（#630 S2 D-5 反向证）：真正活着的子，result 仍答 still_running（语义不变）", async () => {
  const rosterDir = await makeTmp("erix-delegation-630-d5-live-");
  const a = createDelegateTool({ runChild: neverSettles, rosterDir, isProcessAlive });
  const b = createDelegateTool({ runChild: neverSettles, rosterDir, isProcessAlive });
  const started = await a.execute({ action: "run", task: "真的在跑", background: true }, { runId: "parent-live" });

  const early = await b.execute({ action: "result", runId: started.runId }, { runId: "parent-b" });
  assert.deepEqual(
    early,
    { ok: false, reason: "still_running", runId: started.runId, state: "running" },
    "重算之后仍然是活态 ⇒ 照旧 still_running（先重算不等于一律判死）",
  );
  await a.execute({ action: "cancel", runId: started.runId });
});

// ── F：父的显式压缩预算下传给子 ───────────────────────────────────────────────────────
test("真装配（#630 S2 F）：父的显式 compactBudget 真的到了子的引擎里（精确值探针）", async () => {
  const root = await makeTmp("erix-delegation-630-f-");
  const provider = {
    protocol: "fake",
    model: "fake-model",
    async chat() {
      return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
  const delegation = createCliDelegation({
    buildProvider: () => provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    cwd: root,
    todo: false,
    notesDir: join(root, "notes"),
    rosterDir: join(root, "delegation"),
    maxRounds: 4,
    notify: () => {},
    childToolOutput: () => {},
    // 探针值：引擎的 `validateBudget`（`src/loop/budget.js`）对非正整数会抛出
    // `budgetTokens must be a positive integer (got <值>)` —— 它把**子 run 引擎实际收到的**预算
    // 逐字打出来，这就是「预算 == 父给的那个数」的精确证据（合法值下这个数没有任何对外可读的出口，
    // 而 `--compact-budget` 本身只收整数，所以这个非整数只可能来自本测试）。
    compactBudget: 1234.5,
  });

  const ran = await delegation.execute({ action: "run", task: "随便干点什么" }, { runId: "parent-630f" });
  assert.equal(ran.ok, false, `非整数预算必须让子引擎当场拒（说明预算真的到了子那一侧）：${JSON.stringify(ran)}`);
  assert.equal(ran.state, "failed");
  assert.match(
    ran.error,
    /budgetTokens must be a positive integer \(got 1234\.5\)/u,
    `子 run 引擎收到的预算必须逐字等于父给的那个值（缺陷 F：以前父的显式预算在子侧被静默丢掉）：${ran.error}`,
  );
});

test("真装配（#630 S2 F 反向证）：不给 compactBudget ⇒ 子侧行为与接线前逐字一致（不炸）", async () => {
  const root = await makeTmp("erix-delegation-630-f-none-");
  const provider = {
    protocol: "fake",
    model: "fake-model",
    async chat() {
      return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
  const delegation = createCliDelegation({
    buildProvider: () => provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    cwd: root,
    todo: false,
    notesDir: join(root, "notes"),
    rosterDir: join(root, "delegation"),
    maxRounds: 4,
    notify: () => {},
    childToolOutput: () => {},
  });
  const ran = await delegation.execute({ action: "run", task: "随便干点什么" }, { runId: "parent-630fn" });
  assert.equal(ran.ok, true, `没给预算 ⇒ 子照旧跑得起来（undefined 分支不许变）：${JSON.stringify(ran)}`);
  assert.equal(ran.state, "completed");
});

// ── G：名册读取要校验形状 ─────────────────────────────────────────────────────────────
test("真装配（#630 S2 G）：state / updatedAt 形状不对 ⇒ 点名 corrupt，不当正常记录", async () => {
  const rosterDir = await makeTmp("erix-delegation-630-g-");
  // 三条坏记录 + 一条好记录：坏的那三条以前都会被当成正常记录（state 任意字符串、
  // updatedAt 是字符串也能进重算/展示）。
  writeFileSync(join(rosterDir, "bad-state.json"), `${JSON.stringify({ runId: "bad-state", state: "weird", updatedAt: 1 })}\n`);
  writeFileSync(join(rosterDir, "bad-updated.json"), `${JSON.stringify({ runId: "bad-updated", state: "running", updatedAt: "123" })}\n`);
  writeFileSync(join(rosterDir, "no-updated.json"), `${JSON.stringify({ runId: "no-updated", state: "running" })}\n`);
  writeRecord(rosterDir, { runId: "good", state: "running", updatedAt: 1_700_000_000_000, pid: process.pid });

  const a = createDelegateTool({ runChild: neverSettles, rosterDir, isProcessAlive });
  const listed = await a.execute({ action: "list" });

  assert.deepEqual(listed.records.map((record) => record.runId), ["good"], "坏记录不得混进正常记录");
  assert.deepEqual(
    listed.corrupt.map((entry) => entry.file).sort(),
    ["bad-state.json", "bad-updated.json", "no-updated.json"],
    "三条都要被点名（不猜、不就地修）",
  );
  const byFile = new Map(listed.corrupt.map((entry) => [entry.file, entry]));
  assert.match(byFile.get("bad-state.json").reason, /state 不在封闭 7 值内/u);
  assert.match(byFile.get("bad-state.json").reason, /"weird"/u, "理由里带实际收到的值");
  assert.match(byFile.get("bad-updated.json").reason, /updatedAt 必须是有限数字/u);
  assert.match(byFile.get("bad-updated.json").reason, /"123"/u);
  assert.match(byFile.get("no-updated.json").reason, /updatedAt 必须是有限数字/u);

  // 坏记录没被改写（库不就地修）：三条都还在盘上，逐字节原样。
  assert.match(rawRecord(rosterDir, "bad-state"), /"weird"/u);
  assert.match(rawRecord(rosterDir, "bad-updated"), /"123"/u);
  // 按 runId 寻址读坏记录 ⇒ 点名报错（与文件名身份不符那一档同一条路）。
  assert.throws(() => readRecord(rosterDir, "bad-state"), /损坏[\s\S]*state 不在封闭 7 值内/u);
  // 直接读库面：同一份事实（list 不是唯一入口）。
  assert.equal(listRecords(rosterDir).corrupt.length, 3);
});

// ── I：通知去重键加分隔符 ─────────────────────────────────────────────────────────────
test("库面（#630 S2 I）：两组曾经会碰撞的 (runId, endedAt) 现在键不同", () => {
  // 旧写法 `${runId}${endedAt}` 下这两组都是 "a123"（靠「时间戳定长 13 位」才不碰撞）。
  const one = { runId: "a", state: "completed", endedAt: 123 };
  const two = { runId: "a1", state: "completed", endedAt: 23 };
  assert.equal(`${one.runId}${one.endedAt}`, `${two.runId}${two.endedAt}`, "反向证：旧键确实会碰撞");
  assert.notEqual(completionMarkerKey(one), completionMarkerKey(two), "新键必须不同（带分隔符）");
  assert.equal(completionMarkerKey(one), "a:123");
  assert.equal(completionMarkerKey(two), "a1:23");
  // 同 runId 不同 endedAt 仍然是两个事件（resume 复用 runId 的那条既有语义不变）。
  assert.notEqual(
    completionMarkerKey({ runId: "a", state: "completed", endedAt: 1 }),
    completionMarkerKey({ runId: "a", state: "completed", endedAt: 2 }),
  );
});

// ── D 的接线面：两个 CLI 装配点都必须真的把谓词与预算交下去 ─────────────────────────────
test("接线（#630 S2 D/F）：bin/cli.js 与 bin/repl.js 的 createCliDelegation 都下传 isProcessAlive 与 compactBudget", async () => {
  // 这条是**接线面**的守卫，不是行为守卫（行为由上面 D-1..D-5 真装配覆盖）：库侧修好了、
  // 装配点忘了传，真机上仍然是「B 一次 status 就把 A 的活子写成死的」——那正是本单的原始缺陷。
  for (const file of ["bin/cli.js", "bin/repl.js"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const call = source.slice(source.indexOf("createCliDelegation({"));
    assert.ok(call.length > 0, `${file} 里找不到 createCliDelegation 装配点`);
    const body = call.slice(0, call.indexOf("\n    })"));
    assert.match(body, /isProcessAlive/u, `${file} 必须把存活谓词下传给 createCliDelegation（D 的接线面）`);
    assert.match(body, /compactBudget/u, `${file} 必须把父的显式压缩预算下传给子（F 的接线面）`);
  }
  // 默认实现就是真谓词：本进程自己的 pid 必须判活（不是恒 true / 恒 false 的桩）。
  assert.equal(isProcessAlive(process.pid), true, "isProcessAlive(自己) 必须是活");
  assert.equal(isProcessAlive(-1), false, "非法 pid 不当作活进程");
});
