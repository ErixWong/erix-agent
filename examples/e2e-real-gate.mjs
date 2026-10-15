// 真上游 e2e 的「闸门 + 配置解析」——工单 docs/tasks/261015-e2e-harness.md（T5）第 2/3/4 项共用。
//
// 为什么单独一个文件：三处消费点（`examples/tool-fact-e2e.test.mjs`、
// `examples/pi-extension/erix-run-e2e.test.mjs`、`scripts/cli-real-smoke.mjs`）必须对
// 「什么时候允许打真上游、模型名从哪来」口径一致。三处各写一份 = 最松的那一份说了算。
//
// 闸门：`ERIX_E2E_REAL=1` 才跑；缺省**一律跳过**——`npm test` 必须离线可重复（AGENTS.md 测试隔离条），
// 真上游不许变成 `npm test` 的硬依赖（同 `examples/exec-demo.test.mjs` 的 LLM_KIT_E2E 先例）。
//
// 缺席原因必须**分类**（工单第 2 项：gate 缺失 / 无配置 / 无 key / 端点不可达要分别说清）：
// 一律报「skipped」会把「机器其实坏了」伪装成「没开闸」。五个 code 见 GAP_CODES，
// `formatSkip()` 把 code 与原因一起进 `t.skip()` 的说明里。
//
// 模型名不硬编码（AGENTS.md §8）：从配置 `slots.default` 读；配置路径可被 `ERIX_E2E_CONFIG` 覆盖。
// 本文件**一个字节也不写**（只读配置、只探端点），所以它自己就满足「不污染 ~/.erix」。
// 零依赖红线：只用 node: 内置 + 相对路径；纯 ESM。

import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

export const REAL_GATE_ENV = "ERIX_E2E_REAL";
export const CONFIG_PATH_ENV = "ERIX_E2E_CONFIG";

/** 缺席原因的稳定代号（进 skip 文案，便于事后 grep 到底是哪一类）。 */
export const GAP_CODES = Object.freeze({
  GATE_MISSING: "gate_missing",
  CONFIG_MISSING: "config_missing",
  CONFIG_UNPARSABLE: "config_unparsable",
  CONFIG_INCOMPLETE: "config_incomplete",
  ENDPOINT_UNREACHABLE: "endpoint_unreachable",
});

/** 真配置槽位里会被摊平进 provider 的键（多余键留着也没人读，反而把无关漂移带进断言）。 */
const PROVIDER_SLOT_KEYS = Object.freeze([
  "endpoint", "baseUrl", "apiKey", "apiKeyEnv", "apiKeyFile", "model",
  "contextWindowTokens", "maxOutputTokens", "maxTokens", "protocol",
  "thinking", "reasoning_effort", "enable_thinking", "thinking_format",
]);

/**
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {string} `ERIX_E2E_CONFIG` 优先，否则 `<home>/.erix/config.json`
 */
export function defaultConfigPath({ env = process.env, home = homedir() } = {}) {
  const override = env[CONFIG_PATH_ENV];
  if (typeof override === "string" && override.trim() !== "") return override;
  return join(home, ".erix", "config.json");
}

/**
 * 只探 TCP 可达性（不发消息、不花模型钱）：DNS 失败 / 拒连 / 超时都在这里露出来。
 * @param {string} endpoint
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export function probeEndpointReachability(endpoint, { timeoutMs = 8_000 } = {}) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      resolve({ ok: false, detail: `端点不是合法 URL（值本身不打印）` });
      return;
    }
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    const socket = connect({ host: url.hostname, port });
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, detail: `${url.hostname}:${port} ${detail}` });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, "TCP 可达"));
    socket.once("timeout", () => finish(false, "TCP 连接超时"));
    socket.once("error", (error) => finish(false, `TCP 失败 code=${error?.code ?? "-"} message=${error?.message ?? ""}`));
  });
}

/**
 * 解析「能不能打真上游」。
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, probe?: boolean, probeTimeoutMs?: number, slot?: string }} [options]
 * @returns {Promise<{
 *   ok: boolean, code?: string, message?: string,
 *   configPath?: string, model?: string, endpoint?: string,
 *   slot?: Record<string, unknown>, gateEnv?: string,
 * }>}
 */
export async function resolveRealUpstream({
  env = process.env,
  home = homedir(),
  probe = true,
  probeTimeoutMs = 8_000,
  slot: slotName = "default",
} = {}) {
  if (env[REAL_GATE_ENV] !== "1") {
    return {
      ok: false,
      code: GAP_CODES.GATE_MISSING,
      message: `${REAL_GATE_ENV} 未设为 1（当前 ${JSON.stringify(env[REAL_GATE_ENV] ?? null)}）——真机门禁默认跳过，`
        + `跑法：ERIX_E2E_REAL=1 node --test <file>`,
    };
  }
  const configPath = defaultConfigPath({ env, home });
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      code: GAP_CODES.CONFIG_MISSING,
      message: `配置文件读不到：${configPath}（code=${error?.code ?? "-"}）。`
        + `真机门禁需要一份带 endpoint/apiKey/model 的槽位配置，或用 ${CONFIG_PATH_ENV} 指到别的路径。`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      code: GAP_CODES.CONFIG_UNPARSABLE,
      message: `配置文件不是合法 JSON：${configPath}（${error?.message ?? ""}）——不是「没配」，是「配坏了」`,
    };
  }
  const slot = parsed?.slots?.[slotName];
  if (slot === undefined || slot === null || typeof slot !== "object") {
    return {
      ok: false,
      code: GAP_CODES.CONFIG_INCOMPLETE,
      message: `配置里没有 slots.${slotName} 槽位：${configPath}（有的槽位：${Object.keys(parsed?.slots ?? {}).join(",") || "无"}）`,
    };
  }
  const endpoint = typeof slot.endpoint === "string" ? slot.endpoint
    : (typeof slot.baseUrl === "string" ? slot.baseUrl : "");
  const apiKeyPresent = typeof slot.apiKey === "string" && slot.apiKey.trim() !== ""
    || typeof slot.apiKeyFile === "string" && slot.apiKeyFile.trim() !== ""
    || typeof slot.apiKeyEnv === "string" && slot.apiKeyEnv.trim() !== ""
    || typeof env[typeof slot.apiKeyEnv === "string" ? slot.apiKeyEnv : ""] === "string";
  const missing = [
    ...(endpoint === "" ? ["endpoint"] : []),
    ...(apiKeyPresent ? [] : ["apiKey/apiKeyEnv/apiKeyFile"]),
    ...(typeof slot.model === "string" && slot.model.trim() !== "" ? [] : ["model"]),
  ];
  if (missing.length > 0) {
    return {
      ok: false,
      code: GAP_CODES.CONFIG_INCOMPLETE,
      message: `slots.${slotName} 缺必需字段 ${missing.join(", ")}（配置 ${configPath}；凭据值不打印）`,
    };
  }
  if (probe) {
    const probeResult = await probeEndpointReachability(endpoint, { timeoutMs: probeTimeoutMs });
    if (!probeResult.ok) {
      return {
        ok: false,
        code: GAP_CODES.ENDPOINT_UNREACHABLE,
        message: `端点不可达：${probeResult.detail}（配置 ${configPath}，模型 ${slot.model}）——`
          + `这条是网络/服务端问题，不是断言失败`,
      };
    }
  }
  const providerSlot = Object.fromEntries(
    Object.entries(slot).filter(([key]) => PROVIDER_SLOT_KEYS.includes(key)),
  );
  return {
    ok: true,
    configPath,
    model: slot.model,
    endpoint,
    slot: providerSlot,
    gateEnv: `${REAL_GATE_ENV}=1`,
  };
}

/** 把 resolveRealUpstream 的落空结果压成一行 skip 说明（分类信息必须留在里面）。 */
export function formatSkip(gap) {
  return `[${gap?.code ?? "unknown"}] ${gap?.message ?? "未知原因"}`;
}

/** 断言/日志里给端点用的可打印形态（去掉 query/fragment，不带凭据）。 */
export function printableEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "（非法 URL，值不打印）";
  }
}

/** 临时目录前缀（三处消费点共用一种前缀，便于事后清残留）。 */
export const TMP_PREFIX = {
  toolFact: "erix-tool-fact-e2e-",
  erixRun: "erix-run-e2e-",
  cliReal: "erix-cli-real-",
};

export { tmpdir };
