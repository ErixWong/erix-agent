// AssemblyPort 契约测试套件（ADR-014 §2.4）
// 宿主一次性交出组合根；本套件锁定必填适配器、事件出口和启动校验。

import test from "node:test";
import assert from "node:assert/strict";

import { createAssemblyPort } from "../../src/assembly.js";
import { runToolLoop } from "../../src/loop.js";

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
      completion: false,
      wrapup: false,
      maxRounds: 1,
    });
    assert.equal(result.finalText, "assembled");
    assert.equal(result.termination.reason, "end_turn");
  });

  test(`${label}: emit 接收事件类型与完整 payload`, async () => {
    const port = await resolvePort(createPort);
    const events = [];
    const result = await runToolLoop({
      assemblyPort: { ...port, emit: (type, payload) => events.push({ type, payload }) },
      completion: false,
      wrapup: false,
      maxRounds: 1,
    });
    assert.equal(result.termination.reason, "end_turn");
    assert.ok(events.some(({ type, payload }) => (
      type === "round_start" && payload.type === "round_start"
    )));
  });

  test(`${label}: 显式细粒度 provider 覆盖端口 provider`, async () => {
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
      completion: false,
      wrapup: false,
      maxRounds: 1,
    });
    assert.equal(result.finalText, "explicit");
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
        completion: false,
        wrapup: false,
        maxRounds: 1,
      }),
      (error) => error instanceof TypeError && /provider\.chat/u.test(error.message),
    );
  });
}
