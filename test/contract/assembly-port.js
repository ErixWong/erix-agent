// AssemblyPort 契约测试套件（ADR-014 §2.4）
// 宿主一次性交出组合根；本套件锁定必填适配器、事件出口和启动校验。

import test from "node:test";
import assert from "node:assert/strict";

import { assemblyPortOptions, createAssemblyPort } from "../../src/assembly.js";
import { runToolLoop } from "../../src/loop/orchestrator.js";

async function resolvePort(createPort) {
  const port = await createPort();
  if (!port || typeof port !== "object" || Array.isArray(port)) {
    throw new TypeError("assemblyPortContract factory must return an object");
  }
  return port;
}

export function assemblyPortContract(label, createPort) {
  test(`${label}: 组合端口可启动并完成一次 loop`, async () => {
    const port = await resolvePort(createPort);
    const result = await runToolLoop({
      assemblyPort: port,
      // #498 S3 A21: `maxRounds` retired its flat spelling; its home is `config.run.maxRounds`.
      config: { input: { wrapup: false }, run: { maxRounds: 1, completion: false } },
    });
    assert.equal(result.finalText, "assembled");
    assert.equal(result.termination.reason, "end_turn");
  });

  test(`${label}: emit 接收事件类型与完整 payload`, async () => {
    const port = await resolvePort(createPort);
    const events = [];
    const result = await runToolLoop({
      assemblyPort: { ...port, emit: (type, payload) => events.push({ type, payload }) },
      // #498 S3 A21: `maxRounds` retired its flat spelling; its home is `config.run.maxRounds`.
      config: { input: { wrapup: false }, run: { maxRounds: 1, completion: false } },
    });
    assert.equal(result.termination.reason, "end_turn");
    assert.ok(events.some(({ type, payload }) => (
      type === "round_start" && payload.type === "round_start"
    )));
  });

  // issue #498 第 1 条：覆盖通道收窄**只**作用于 `assemblyPortOptions` 的 `overrides` 参数。
  // 直连路线（`runToolLoop({ assemblyPort, provider })`）的合并规则一字未动——那一条是 #177
  // 搬出来的「后写者胜」，它的收窄是另一刀（见契约里 0.28.0 的版本口径）。
  test(`${label}: 直连路线的显式 provider 仍覆盖端口 provider（覆盖通道收窄只作用于 overrides）`, async () => {
    const port = await resolvePort(createPort);
    const result = await runToolLoop({
      assemblyPort: port,
      provider: {
        async chat() {
          return {
            content: [{ type: "text", text: "explicit" }],
            stopReason: "end_turn",
          };
        },
      },
      // #498 S3 A21: `maxRounds` retired its flat spelling; its home is `config.run.maxRounds`.
      config: { input: { wrapup: false }, run: { maxRounds: 1, completion: false } },
    });
    assert.equal(result.finalText, "explicit");
  });

  // issue #498 第 1 条：`assemblyPortOptions` 的 `overrides` 里再给一个端口已经产出的键
  // ⇒ 启动期抛（点名键名 + 两个来源），不再静默取胜者。
  test(`${label}: 调用期覆盖端口已有的键在启动期被拒绝（issue #498）`, async () => {
    const port = await resolvePort(createPort);
    await assert.rejects(
      assemblyPortOptions(port, {
        provider: {
          async chat() {
            return { content: [{ type: "text", text: "override" }], stopReason: "end_turn" };
          },
        },
      }),
      (error) => error instanceof TypeError
        && error.message === 'assembly port option override conflicts with the port: "provider"'
          + " comes from port.provider (construction) and overrides.provider (call);"
          + " pass it in one place only",
    );
  });

  test(`${label}: 缺少 provider 方法在启动时被拒绝`, async () => {
    const port = await resolvePort(createPort);
    const invalid = { ...port, provider: {} };
    assert.throws(
      () => createAssemblyPort(invalid),
      (error) => error instanceof TypeError && /provider\.chat/u.test(error.message),
    );
    await assert.rejects(
      runToolLoop({
        assemblyPort: invalid,
        // #498 S3 A21: `maxRounds` retired its flat spelling; its home is `config.run.maxRounds`.
        config: { input: { wrapup: false }, run: { maxRounds: 1, completion: false } },
      }),
      (error) => error instanceof TypeError && /provider\.chat/u.test(error.message),
    );
  });
}
