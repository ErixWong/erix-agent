// issue #441：把引擎自带的可重试静默相位截止接到 CLI —— 取值关系与「用户能配」的钉子。
//
// 这一格测的是**纯函数**（`bin/provider-timeouts.js`），不跑 run、不碰网络：
//   · idle 开启 ⇒ 三个静默相位截止 = ⌊idle × 3/4⌋，**严格小于** idle 窗口；
//   · 显式配置优先、不被隐式改写（≥ idle 时只警告）；
//   · idle 关闭 ⇒ 一律不派生（接线前的装配逐字保留）；
//   · `bin/config.js` 的白名单真的收了这四个键（此前用户写了等于没写）。
// 「静默上游 ⇒ 真的重试」那一层是集成用例，在 test/cli-idle.test.js（同一单的两侧）。
import test from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  PROVIDER_PHASE_TIMEOUT_FIELDS,
  SILENT_PHASE_BUDGET_DENOMINATOR,
  SILENT_PHASE_BUDGET_NUMERATOR,
  resolveProviderPhaseTimeouts,
  silentPhaseTimeoutMs,
} from "../bin/provider-timeouts.js";
import { loadCliConfig } from "../bin/config.js";
import { makeTmp } from "./helpers/tmp.js";

test("silentPhaseTimeoutMs is ⌊idle × 3/4⌋ and strictly below the idle window (issue #441)", () => {
  assert.equal(SILENT_PHASE_BUDGET_NUMERATOR, 3);
  assert.equal(SILENT_PHASE_BUDGET_DENOMINATOR, 4);
  assert.equal(silentPhaseTimeoutMs(300), 225_000);
  assert.equal(silentPhaseTimeoutMs(4), 3_000);
  assert.equal(silentPhaseTimeoutMs(2), 1_500);
  // 小窗口也不能退化成 0（0 在引擎里等于「立刻到点」）。
  assert.equal(silentPhaseTimeoutMs(1), 750);
  // 不变式：**严格小于** idle 窗口。相等就等于 idle 先响（它的计时起点更早）⇒ 回到不可重试的 abort。
  for (const seconds of [1, 2, 3, 4, 7, 60, 300, 3600]) {
    assert.ok(
      silentPhaseTimeoutMs(seconds) < seconds * 1000,
      `${seconds}s 窗口的静默预算必须严格小于窗口`,
    );
  }
  // idle 未启用（含 0 / 非正整数）⇒ 不派生。
  for (const value of [0, -1, 1.5, "300", undefined, null]) {
    assert.equal(silentPhaseTimeoutMs(value), undefined);
  }
});

test("idle on: three silence deadlines derive from the budget, streamTotal does not (issue #441)", () => {
  const warnings = [];
  const fields = resolveProviderPhaseTimeouts({
    idleSeconds: 300,
    config: {},
    warn: (line) => warnings.push(line),
  });
  assert.deepEqual(fields, {
    requestTimeoutMs: 225_000,
    firstByteTimeoutMs: 225_000,
    streamIdleTimeoutMs: 225_000,
  });
  // 绝对上限不从 idle 派生（否则 3/4 个窗口会去误杀一直在吐字节的长输出）。
  assert.equal("streamTotalTimeoutMs" in fields, false);
  assert.deepEqual(warnings, []);
});

test("idle off: nothing is derived at all — the pre-#441 assembly stays byte-for-byte (issue #441)", () => {
  const warnings = [];
  const fields = resolveProviderPhaseTimeouts({
    idleSeconds: 0,
    // 显式配置照旧由 `...config` 透传（本模块不重复主张）；派生值一个都不许有。
    config: { firstByteTimeoutMs: 5_000, timeout: 600_000 },
    warn: (line) => warnings.push(line),
  });
  assert.deepEqual(fields, {});
  assert.deepEqual(warnings, []);
});

test("explicit phase config wins verbatim; a value ≥ the idle window only warns (issue #441)", () => {
  const warnings = [];
  const fields = resolveProviderPhaseTimeouts({
    idleSeconds: 10,
    config: { firstByteTimeoutMs: 1_000, streamIdleTimeoutMs: 90_000 },
    warn: (line) => warnings.push(line),
  });
  // 显式值原样使用：小值不放大、超窗值**不缩**（口径与 ERIX_EXEC_TIMEOUT_MS 一致：只警告不改值）。
  assert.equal(fields.firstByteTimeoutMs, 1_000);
  assert.equal(fields.streamIdleTimeoutMs, 90_000);
  assert.equal(fields.requestTimeoutMs, 7_500);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /streamIdleTimeoutMs=90000ms ≥ --idle-timeout 10s/u);
  assert.match(warnings[0], /不改值/u);
});

test("an explicit legacy timeout keeps its absolute ceiling under the phase model (issue #441)", () => {
  const warnings = [];
  const fields = resolveProviderPhaseTimeouts({
    idleSeconds: 300,
    config: { timeout: 600_000 },
    warn: (line) => warnings.push(line),
  });
  // 相位模型一开，legacy 那条绝对截止就失效（引擎的 hasExplicitPhase 判据）⇒ 必须显式透传成
  // requestTimeoutMs + streamTotalTimeoutMs，否则用户要的 600s 天花板会被悄悄降到引擎默认 300s。
  assert.equal(fields.requestTimeoutMs, 600_000);
  assert.equal(fields.streamTotalTimeoutMs, 600_000);
  assert.equal(fields.firstByteTimeoutMs, 225_000);
  assert.equal(fields.streamIdleTimeoutMs, 225_000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /timeout=600000ms ≥ --idle-timeout 300s/u);

  // 显式 `0` 也算显式（引擎的 normalizeDuration 认 `>= 0`，0 = 立刻到点）：不许被派生值悄悄换掉。
  const zero = resolveProviderPhaseTimeouts({
    idleSeconds: 300,
    config: { firstByteTimeoutMs: 0 },
    warn: () => {},
  });
  assert.equal(zero.firstByteTimeoutMs, 0);
  assert.equal(zero.streamIdleTimeoutMs, 225_000);

  // 显式 streamTotalTimeoutMs 自己优先于 legacy timeout。
  const both = resolveProviderPhaseTimeouts({
    idleSeconds: 300,
    config: { timeout: 600_000, streamTotalTimeoutMs: 900_000 },
    warn: () => {},
  });
  assert.equal(both.streamTotalTimeoutMs, 900_000);
});

test("bin/config.js forwards the four phase keys from the config file (issue #441)", async () => {
  const directory = await makeTmp("erix-config-phase-timeouts-");
  try {
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      slots: {
        default: {
          endpoint: "https://phase.example.invalid",
          apiKey: "phase-key",
          model: "phase-model",
          requestTimeoutMs: 11_000,
          firstByteTimeoutMs: 22_000,
          streamIdleTimeoutMs: 33_000,
          streamTotalTimeoutMs: 44_000,
        },
      },
    }), "utf8");
    const config = await loadCliConfig({ configPath });
    for (const field of PROVIDER_PHASE_TIMEOUT_FIELDS) {
      assert.equal(typeof config[field], "number", `${field} 必须被白名单透传`);
    }
    assert.equal(config.requestTimeoutMs, 11_000);
    assert.equal(config.firstByteTimeoutMs, 22_000);
    assert.equal(config.streamIdleTimeoutMs, 33_000);
    assert.equal(config.streamTotalTimeoutMs, 44_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
