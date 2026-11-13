// @ts-check
// 真模型端点闸门的**离线自测**（issue #817：改名 `ERIX_E2E_REAL` → `ERIX_E2E_MODEL`，旧名留别名）。
//
// 为什么这一份必须存在、且**始终跑不联网**：判据 4 说的是「旧名仍然生效，但当次必须打一行弃用告警」。
// 一个只在真跑时才露头的别名 = 下一版删不掉的那个别名（静默生效）。所以别名要有一格**离线**反向证：
//   ① 旧名把闸门打开（不打开就会被当成「没开闸 ⇒ skip」，别名的「生效」永远没人看见）；
//   ② 命中旧名的那一次，`DEPRECATED_GATE_WARNING` 那一行逐字打出来（不许只在 debug 级别）；
//   ③ 新名在场时旧名**不参与**判定也不打告警（已经改过名的人不该再被旧名绊一次）；
//   ④ 两个都没开 ⇒ `gate_missing`，而提示文案里出现的是**新名**（跳过时教人的那一句必须是新名）。
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
  DEPRECATED_GATE_WARNING,
  GAP_CODES,
  LEGACY_REAL_GATE_ENV,
  REAL_GATE_ENV,
  formatSkip,
  readRealGate,
  resolveRealUpstream,
} from "./e2e-real-gate.mjs";

/** 名字表本身（改名的话这一格先红，防止「只改了消费点、闸门常量还是旧名」那种半片改名）。 */
test("闸门名字表：新名是 ERIX_E2E_MODEL、旧名是 ERIX_E2E_REAL、告警是判据 4 那一行原文（#817）", () => {
  assert.equal(REAL_GATE_ENV, "ERIX_E2E_MODEL");
  assert.equal(LEGACY_REAL_GATE_ENV, "ERIX_E2E_REAL");
  assert.equal(CONFIG_PATH_ENV, "ERIX_E2E_CONFIG");
  assert.equal(
    DEPRECATED_GATE_WARNING,
    "旧名 ERIX_E2E_REAL 已弃用，将在下一版退役，请改用 ERIX_E2E_MODEL",
    "弃用告警的原文是 issue #817 判据 4 的字面要求，改措辞要连工单一起改",
  );
});

/** 旧名别名：打开闸门 + 逐字打一行告警（告警用注入的 sink 收，不依赖 stderr 的采集方式）。 */
test("旧名 ERIX_E2E_REAL=1 仍是别名：闸门开、legacy 标记在场、当次恰好一行告警（#817 判据 4）", () => {
  /** @type {string[]} */
  const lines = [];
  const gate = readRealGate({ env: { [LEGACY_REAL_GATE_ENV]: "1" }, warn: (line) => lines.push(line) });
  assert.equal(gate.open, true, "旧名必须仍然生效（判据 4：别名不许提前删）");
  assert.equal(gate.legacy, true, "旧名打开的闸门要能被认出来（日志里点名用的是哪一名）");
  assert.deepEqual(lines, [DEPRECATED_GATE_WARNING], "别名命中当次必须且只许打一行弃用告警");
});

/** 新名优先：两个都设 ⇒ 新名说了算，且**不**打告警。 */
test("新名在场时旧名不参与判定也不告警（已改名的人不该被旧名绊第二次）", () => {
  /** @type {string[]} */
  const lines = [];
  const both = readRealGate({
    env: { [REAL_GATE_ENV]: "1", [LEGACY_REAL_GATE_ENV]: "1" },
    warn: (line) => lines.push(line),
  });
  assert.equal(both.open, true);
  assert.equal(both.legacy, false, "两个都设时是新名开的闸，不该标成旧名");
  assert.deepEqual(lines, [], "新名在场时不许打弃用告警");

  const neither = readRealGate({ env: {}, warn: (line) => lines.push(line) });
  assert.equal(neither.open, false, "两个都没设 ⇒ 闸门关着（默认离线可重复）");
  assert.deepEqual(lines, [], "没开闸时也不许凭空打告警");

  // 反向证：旧名设成**非 1** 的任意值都不算开闸（别名只认 `=1`，与 `npm run` 那一族的用法一致）。
  const notOne = readRealGate({ env: { [LEGACY_REAL_GATE_ENV]: "yes" }, warn: (line) => lines.push(line) });
  assert.equal(notOne.open, false, "旧名设成非 1 的值不许把闸门打开");
  assert.deepEqual(lines, [], "旧名设成非 1 ⇒ 那是「没开闸」，不是「用了别名」，不许打告警");
});

/** 真解析路径（`resolveRealUpstream` 的入口）：旧名开闸 ⇒ 结果里带 legacy 标记；没开闸 ⇒ 提示是新名。 */
test("resolveRealUpstream：旧名开闸时 gateEnv 点名旧名；没开闸时跳过文案里是新名", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "erix-gate-name-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".erix"), { recursive: true });
  const configPath = join(dir, ".erix", "config.json");
  await writeFile(configPath, JSON.stringify({
    slots: { default: { endpoint: "http://127.0.0.1:9/v1", model: "gate-name-selftest", apiKey: "selftest-key" } },
  }, null, 2), "utf8");

  // ① 旧名开闸：闸门必须真的开（配置可用 ⇒ ok:true），且这一行是旧名打开的。
  const legacy = await resolveRealUpstream({
    env: { [LEGACY_REAL_GATE_ENV]: "1", [CONFIG_PATH_ENV]: configPath },
    probe: false,
  });
  assert.equal(legacy.ok, true, `旧名开闸后必须走到配置解析，实测：${formatSkip(legacy)}`);
  assert.equal(legacy.gateEnv, `${LEGACY_REAL_GATE_ENV}=1`, "gateEnv 要如实点名是旧名开的闸");
  assert.equal(legacy.legacyGateEnv, true);

  // ② 新名开闸：同一个配置，走新名一样开，且不标 legacy。
  const fresh = await resolveRealUpstream({
    env: { [REAL_GATE_ENV]: "1", [CONFIG_PATH_ENV]: configPath },
    probe: false,
  });
  assert.equal(fresh.ok, true, `新名开闸后必须走到配置解析，实测：${formatSkip(fresh)}`);
  assert.equal(fresh.gateEnv, `${REAL_GATE_ENV}=1`);
  assert.equal(fresh.legacyGateEnv, false);

  // ③ 都没开：分类是 gate_missing，而**教人的那一句写的是新名**。
  const closed = await resolveRealUpstream({ env: {}, probe: false });
  assert.equal(closed.code, GAP_CODES.GATE_MISSING);
  const skip = formatSkip(closed);
  assert.match(skip, new RegExp(`跑法：${REAL_GATE_ENV}=1 node --test <file>`, "u"),
    `跳过文案必须给新名的跑法，实测：${skip}`);
});
