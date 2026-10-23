// issue #441：把引擎自带的可重试静默相位截止接到 CLI —— 取值关系与「用户能配」的钉子。
//
// 这一格测的是**纯函数**（`bin/provider-timeouts.js`），不跑 run、不碰网络：
//   · idle 开启 ⇒ **两个流式静默相位** = ⌊idle × 3/4⌋，**严格小于** idle 窗口；
//   · `requestTimeoutMs` **不在派生面内**（评审实测退回：它量的是整段生成时间，不是静默——
//     派生会把默认配置下 `[225s, 300s)` 这条以前成功的带变成必死带，见模块头注释第 3 条）；
//   · 显式配置优先、不被隐式改写（≥ idle 时只警告）；
//   · idle 关闭 ⇒ 一律不派生（接线前的装配逐字保留）；
//   · `bin/config.js` 的白名单真的收了这四个键（此前用户写了等于没写），且非法值**报错并点名键**。
// 「静默上游 ⇒ 真的重试」那一层是集成用例，在 test/cli-idle.test.js（同一单的两侧）。
import test from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DERIVED_SILENT_PHASE_FIELDS,
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

test("idle on: only the two stream phases derive; requestTimeoutMs is not in the surface (issue #441)", () => {
  const warnings = [];
  const fields = resolveProviderPhaseTimeouts({
    idleSeconds: 300,
    config: {},
    warn: (line) => warnings.push(line),
  });
  // 派生面 = 两个流式静默相位，**只有这两个**。
  assert.deepEqual(DERIVED_SILENT_PHASE_FIELDS, ["firstByteTimeoutMs", "streamIdleTimeoutMs"]);
  assert.deepEqual(fields, {
    firstByteTimeoutMs: 225_000,
    streamIdleTimeoutMs: 225_000,
  });
  // `requestTimeoutMs` 必须**不在**派生结果里：它是非流式那条「整段生成」的截止，派生成 ⌊idle×3/4⌋
  // 会把默认配置下 `[225s, 300s)` 这条以前**活的**带变成必死带（评审实测：240s 的健康请求接线前
  // `end_turn` / 240.29s，派生后 225.21s 被杀成 `failed`+`timeout`）。非流式截止保持 legacy
  // （`bin/cli.js` 的 `timeoutMs: config.timeout ?? 300_000`），正解是 #433 fix 1「判死后重试」。
  assert.equal("requestTimeoutMs" in fields, false);
  // 绝对上限同样不从 idle 派生（否则 3/4 个窗口会去误杀一直在吐字节的长输出）。
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
  assert.deepEqual(Object.keys(fields).sort(), ["firstByteTimeoutMs", "streamIdleTimeoutMs"]);
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
  // streamTotalTimeoutMs，否则用户要的 600s 天花板会被悄悄降到引擎默认 300s。
  // 非流式那条 `requestTimeoutMs` **不在这里**：它由 `...config` 里的 legacy `timeout` 经引擎的
  // `requestTimeoutMs ?? legacy ?? 120000` 回落到 600s（`bin/cli.js` 的 `timeoutMs` 同源），
  // 所以「用户要的天花板」在两条路径上都不丢——本模块不需要、也不许再主张它。
  assert.deepEqual(fields, {
    firstByteTimeoutMs: 225_000,
    streamIdleTimeoutMs: 225_000,
    streamTotalTimeoutMs: 600_000,
  });
  // legacy `timeout` ≥ idle 不再产生警告：默认配置下 idle 与 legacy `timeout` **都是 300s**，
  // 那条「静默仍可能先被 idle 收尾」的警告会在每一次默认运行里响——噪音，而不是信息。
  // 非流式静默今天仍不可重试这件事写在文档里（契约中英 + 0.24.0 §16），不靠这行警告。
  assert.deepEqual(warnings, []);

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

// 取值校验：这 4 个键是**新键**，没有历史配置包袱 ⇒ 非法值直接报错并点名键，不静默回默认值。
// 现状（校验之前）是「写了可能立刻超时 / 流式里静默不生效」：引擎的 `normalizeDuration` 只认
// 「有限数且 >= 0」，`-1000` / `"abc"` / `true` 一律返 `undefined`（`src/providers/timeout.js`）。
test("bin/config.js rejects invalid phase-timeout values and names the key (issue #441)", async () => {
  const directory = await makeTmp("erix-config-phase-invalid-");
  try {
    for (const [field, value] of [
      ["requestTimeoutMs", -1_000],
      ["firstByteTimeoutMs", "abc"],
      ["streamIdleTimeoutMs", true],
      ["streamTotalTimeoutMs", 1.5],
    ]) {
      const configPath = join(directory, `bad-${field}.json`);
      await writeFile(configPath, JSON.stringify({
        slots: {
          default: {
            endpoint: "https://phase.example.invalid",
            apiKey: "phase-key",
            model: "phase-model",
            [field]: value,
          },
        },
      }), "utf8");
      await assert.rejects(
        () => loadCliConfig({ configPath }),
        (error) => {
          assert.match(error.message, new RegExp(field, "u"), `报错必须点名键 ${field}`);
          assert.match(error.message, /不合法/u);
          return true;
        },
      );
    }

    // `0` 是合法值（引擎里等于「立刻到点」）：校验不许把它当非法，也不许悄悄换成默认值。
    const zeroPath = join(directory, "zero.json");
    await writeFile(zeroPath, JSON.stringify({
      slots: {
        default: {
          endpoint: "https://phase.example.invalid",
          apiKey: "phase-key",
          model: "phase-model",
          firstByteTimeoutMs: 0,
        },
      },
    }), "utf8");
    assert.equal((await loadCliConfig({ configPath: zeroPath })).firstByteTimeoutMs, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
