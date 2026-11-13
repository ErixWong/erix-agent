// @ts-check
// 真模型端点闸门的**离线自测**（issue #817：改名 `ERIX_E2E_REAL` → `ERIX_E2E_MODEL`，旧名已退役）。
//
// 为什么这一份必须存在、且**始终跑不联网**：旧名退役后最怕的不是它失效，而是**失效得没有声音**——
// 环境里还写着 `ERIX_E2E_REAL=1` 的人如果拿到一个 skip，看上去就和「闸门关着所以没跑」一模一样，
// 而那正是这一族最坏的失败形状（「没跑成」被当成绿）。所以退役要有一格**离线**反向证：
//   ① 只设旧名 ⇒ 闸门**不开**且标出 `retired`，值为空串或 `"0"` 不算设过（那是主动关）；
//   ② 真解析入口给的是 `gate_retired` 而**不是** `gate_missing` ⇒ 消费点现有的红分支接得住它；
//   ③ 新名在场时旧名**不参与**判定也不绊人（两个都设 = 真的在跑，不该被没清干净的变量红掉）；
//   ④ 都没设 ⇒ `gate_missing`，而教人的那一句写的是**新名**；红文里两个名字都要出现。
//
// 全部离线：配置写在临时目录、`probe: false`（不建 TCP 连接）、一个模型请求也不发 ⇒ 进默认 `npm test`。
// 零依赖红线：只用 `node:` 内置 + 仓内相对路径；纯 ESM。

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONFIG_PATH_ENV,
  GAP_CODES,
  REAL_GATE_ENV,
  RETIRED_GATE_ENV,
  formatSkip,
  readRealGate,
  assertGateNotRetired,
  resolveRealUpstream,
  retiredGateMessage,
} from "./e2e-real-gate.mjs";

/** 名字表本身（改名的话这一格先红，防止「只改了消费点、闸门常量还是旧名」那种半片改名）。 */
test("闸门名字表：新名 ERIX_E2E_MODEL、退役名 ERIX_E2E_REAL、红文点名两名且不拿版本号承接（#817）", () => {
  assert.equal(REAL_GATE_ENV, "ERIX_E2E_MODEL");
  assert.equal(RETIRED_GATE_ENV, "ERIX_E2E_REAL");
  assert.equal(CONFIG_PATH_ENV, "ERIX_E2E_CONFIG");
  const message = retiredGateMessage("1");
  assert.match(message, /ERIX_E2E_REAL/u, "红文必须点名被退役的旧名，否则人不知道改哪一处");
  assert.match(message, /ERIX_E2E_MODEL/u, "红文必须点名该改用谁，否则人只能去翻代码");
  assert.match(message, /判红而不是 skip/u, "红文要说清为什么是红不是跳过（这是这一族的失败形状）");
  // 本仓红线：退役时机挂事实（消费者命中数），不许挂未发布版本号或里程碑。
  assert.doesNotMatch(message, /\b0\.\d+\.\d+\b/u, `红文里不许出现版本号：${message}`);
});

/** 只设旧名：不开闸但标出 retired（值上的两种「主动关」不算设过）。 */
test("只设退役名 ERIX_E2E_REAL ⇒ 闸门不开且标 retired=true；空串与 \"0\" 不算设过（#817）", () => {
  const set = readRealGate({ env: { [RETIRED_GATE_ENV]: "1" } });
  assert.equal(set.open, false, "旧名已退役：不许再开闸");
  assert.equal(set.retired, true, "旧名必须被认出来——认不出来就退化成静默 skip");

  const junk = readRealGate({ env: { [RETIRED_GATE_ENV]: "yes" } });
  assert.equal(junk.retired, true, "旧名设成任意非空值都算「还写着」，一样要红（值不是 1 不代表人改完了）");

  for (const off of ["", "0"]) {
    const closed = readRealGate({ env: { [RETIRED_GATE_ENV]: off } });
    assert.equal(closed.retired, false, `旧名值为 ${JSON.stringify(off)} 是主动关掉，不该红`);
    assert.equal(closed.open, false);
  }

  const neither = readRealGate({ env: {} });
  assert.equal(neither.open, false, "什么都没设 ⇒ 闸门关着（默认离线可重复）");
  assert.equal(neither.retired, false);
});

/** 新名在场：真的在跑，就不该被一个没清干净的旧名绊住。 */
test("新名在场时旧名不参与判定也不绊人（两个都设 = 闸门开着）", () => {
  const both = readRealGate({ env: { [REAL_GATE_ENV]: "1", [RETIRED_GATE_ENV]: "1" } });
  assert.equal(both.open, true, "两个都设时新名必须开闸");
  assert.equal(both.retired, false, "已经在跑的 run 不该被一个没清干净的变量判红");
});

/** 真解析入口：旧名 ⇒ `gate_retired`（不是 `gate_missing`）⇒ 消费点现有的红分支接得住。 */
test("resolveRealUpstream：旧名给 gate_retired（会被消费点的红分支接住），没开闸才给 gate_missing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "erix-gate-name-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".erix"), { recursive: true });
  const configPath = join(dir, ".erix", "config.json");
  await writeFile(configPath, JSON.stringify({
    slots: { default: { endpoint: "http://127.0.0.1:9/v1", model: "gate-name-selftest", apiKey: "selftest-key" } },
  }, null, 2), "utf8");

  // ① 只设旧名：不许 ok:true（退役了），也不许 code 是 gate_missing（那是 skip 的分类）。
  const retired = await resolveRealUpstream({
    env: { [RETIRED_GATE_ENV]: "1", [CONFIG_PATH_ENV]: configPath },
    probe: false,
  });
  assert.equal(retired.ok, false, "旧名不许再把真跑打开");
  assert.equal(retired.code, GAP_CODES.GATE_RETIRED,
    `必须是 gate_retired——写成 gate_missing 就会被当成「闸门关着」而 skip 掉：${formatSkip(retired)}`);
  const red = formatSkip(retired);
  assert.match(red, /ERIX_E2E_REAL/u, `判红文案要点名旧名：${red}`);
  assert.match(red, /ERIX_E2E_MODEL/u, `判红文案要点名新名：${red}`);

  // ② 新名开闸：同一份配置走新名必须真的通（配置可用 ⇒ ok:true）。
  const fresh = await resolveRealUpstream({ env: { [REAL_GATE_ENV]: "1", [CONFIG_PATH_ENV]: configPath }, probe: false });
  assert.equal(fresh.ok, true, `新名开闸后必须走到配置解析，实测：${formatSkip(fresh)}`);
  assert.equal(fresh.gateEnv, `${REAL_GATE_ENV}=1`, "gateEnv 只可能写新名");

  // ③ 都没开：分类是 gate_missing，而**教人的那一句写的是新名**，并顺带告知旧名已退役。
  const closed = await resolveRealUpstream({ env: {}, probe: false });
  assert.equal(closed.code, GAP_CODES.GATE_MISSING);
  const skip = formatSkip(closed);
  assert.match(skip, new RegExp(`跑法：${REAL_GATE_ENV}=1 node --test <file>`, "u"),
    `跳过文案必须给新名的跑法，实测：${skip}`);
  assert.match(skip, /已退役/u, `跳过文案要顺带说明旧名不会再开闸，实测：${skip}`);

  // ④ 消费点那颗钉子本身：判据必须认**代号**（第一版补丁查 `.retired`，而失败结果只带 `code`，
  //    结果 4 个真跑套件照旧 skip、exit 0——那一格就是这么发现的）。
  assert.throws(() => assertGateNotRetired(retired), /ERIX_E2E_REAL.*已退役/u,
    "命中退役名必须抛（⇒ 判红），否则消费点的无条件 skip 会把它显示成「没开闸」");
  assert.doesNotThrow(() => assertGateNotRetired(closed), "闸门真的关着时不许抛——那一路就该是 skip");
  assert.doesNotThrow(() => assertGateNotRetired({ ok: true }), "闸门开着更不该抛");
});
