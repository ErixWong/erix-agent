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
// 一律报「skipped」会把「机器其实坏了」伪装成「没开闸」。缺席代号见 GAP_CODES，
// `formatSkip()` 把 code 与原因一起进 `t.skip()` 的说明里。凭据类缺席单独占三个代号
// （引用缺失 / 变量未设 / 文件读不到 / 值为空），因为「配置文件里有 apiKeyEnv 这个名字」
// 与「真的拿得到 key」是两件事——把它们混成一条就会把真机测试放行成 fail（PR #289 阻断 1）。
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
  /** 槽位里 `apiKey` / `apiKeyEnv` / `apiKeyFile` 三种引用一个都没有。 */
  API_KEY_MISSING: "api_key_missing",
  /** `apiKeyEnv` 在场，但它点名的环境变量没设（或为空）。 */
  API_KEY_ENV_UNSET: "api_key_env_unset",
  /** `apiKeyFile` 在场，但那个路径读不到（不存在 / 是目录 / 权限）。 */
  API_KEY_FILE_UNREADABLE: "api_key_file_unreadable",
  /** 引用在场、也读到了东西，但值是空串/全空白/非字符串——等于没有凭据。 */
  API_KEY_EMPTY: "api_key_empty",
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
 * 把槽位里的**凭据引用**解成**实际值**并验证非空（PR #289 阻断 1）。
 *
 * 修前只判「变量名/路径字符串在场」就放行 → 变量没设、文件不存在、文件为空这三种情况下
 * 闸门说 ok，测试起跑后死在 provider 里（**fail 而不是 skip**，最坏的门禁形态）。
 * 取值顺序与 `src/config/api-key.js#resolveApiKey` 一致（`apiKey` → `apiKeyEnv` → `apiKeyFile`），
 * 这里不 import 那份而自己写，是因为那份的口径是「抛 TypeError / 返回 undefined」，
 * 本文件要的却是**分类后的 skip 原因**（并且必须同步读，闸门不能因为探凭据而挂起）。
 * 空白一律去掉后判定（key 文件常带尾随换行）；值本身**永不进消息**（skip 文案会被贴进报告）。
 *
 * @param {Record<string, unknown>} slot
 * @param {{ env: NodeJS.ProcessEnv, configPath: string }} options
 * @returns {{ ok: true, apiKey: string } | { ok: false, code: string, message: string }}
 */
function resolveSlotCredential(slot, { env, configPath }) {
  const ref = (key) => (typeof slot[key] === "string" && slot[key].trim() !== "");
  const unusable = (key) => slot[key] !== undefined && slot[key] !== null && typeof slot[key] !== "string";
  const where = `配置 ${configPath} 的槽位凭据引用（apiKey / apiKeyEnv / apiKeyFile 三选一）`;

  if (slot.apiKey !== undefined && slot.apiKey !== null) {
    if (unusable("apiKey")) {
      return { ok: false, code: GAP_CODES.API_KEY_EMPTY, message: `apiKey 不是字符串（是 ${typeof slot.apiKey}），等于没有凭据：${where}` };
    }
    const value = String(slot.apiKey).trim();
    if (value === "") {
      return { ok: false, code: GAP_CODES.API_KEY_EMPTY, message: `apiKey 是空串/全空白：${where}` };
    }
    return { ok: true, apiKey: value };
  }
  if (ref("apiKeyEnv")) {
    const name = String(slot.apiKeyEnv).trim();
    const value = env[name];
    if (value === undefined || String(value).trim() === "") {
      return {
        ok: false,
        code: GAP_CODES.API_KEY_ENV_UNSET,
        message: `${where} 指向环境变量 ${JSON.stringify(name)}，但该变量${value === undefined ? "未设置" : "存在但为空串/全空白"}`
          + " ⇒ 引用在场不等于凭据在场，判 skip（不是断言失败）",
      };
    }
    return { ok: true, apiKey: String(value).trim() };
  }
  if (ref("apiKeyFile")) {
    const keyPath = String(slot.apiKeyFile).trim();
    let raw;
    try {
      raw = readFileSync(keyPath, "utf8");
    } catch (error) {
      return {
        ok: false,
        code: GAP_CODES.API_KEY_FILE_UNREADABLE,
        message: `${where} 指向文件 ${keyPath}，但读不到（code=${error?.code ?? "-"}）`
          + " ⇒ 文件不存在/不是普通文件/无权限，判 skip（不是断言失败）",
      };
    }
    const value = raw.trim();
    if (value === "") {
      return {
        ok: false,
        code: GAP_CODES.API_KEY_EMPTY,
        message: `凭据文件存在但内容为空（去空白后长度 0）：${keyPath} ⇒ 判 skip（不是断言失败）`,
      };
    }
    return { ok: true, apiKey: value };
  }
  if (unusable("apiKeyEnv") || unusable("apiKeyFile")) {
    return { ok: false, code: GAP_CODES.API_KEY_EMPTY, message: `凭据引用字段不是字符串（apiKeyEnv=${typeof slot.apiKeyEnv} apiKeyFile=${typeof slot.apiKeyFile}），等于没有凭据：${where}` };
  }
  return {
    ok: false,
    code: GAP_CODES.API_KEY_MISSING,
    message: `配置里没有任何凭据引用（apiKey / apiKeyEnv / apiKeyFile 三个都没有）：${configPath}`
      + " ⇒ 判 skip（不是断言失败）",
  };
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
 *   configPath?: string, model?: string, endpoint?: string, apiKey?: string,
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
  // model / endpoint 的在场性先查（不涉凭据）；凭据走下面 resolveSlotCredential（要解析到实际值）。
  const missing = [
    ...(endpoint === "" ? ["endpoint"] : []),
    ...(typeof slot.model === "string" && slot.model.trim() !== "" ? [] : ["model"]),
  ];
  if (missing.length > 0) {
    return {
      ok: false,
      code: GAP_CODES.CONFIG_INCOMPLETE,
      message: `slots.${slotName} 缺必需字段 ${missing.join(", ")}（配置 ${configPath}；凭据值不打印）`,
    };
  }
  // 凭据必须**解到实际值**才能算在场（PR #289 阻断 1）。「只有引用名」不是凭据：
  // 拿引用名去喂 `createOpenAIProvider`（它只认 `apiKey`）会在测试里直接抛错，把 skip 做成 fail。
  // 探端点之前先解凭据：无凭据的机器不该为一个跑不起来的 run 去建立 TCP 连接。
  const credential = resolveSlotCredential(slot, { env, configPath });
  if (!credential.ok) {
    return { ok: false, code: credential.code, message: credential.message, configPath };
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
  // 引用形式在闸门里已经解掉：返出的 slot 只带**解析后的真值**（消费点直接喂 provider 即可，
  // 不需要再自己认 apiKeyEnv/apiKeyFile；也不允许它们泄到下游变成「传到 provider 的是变量名」）。
  delete providerSlot.apiKeyEnv;
  delete providerSlot.apiKeyFile;
  providerSlot.apiKey = credential.apiKey;
  return {
    ok: true,
    configPath,
    model: slot.model,
    endpoint,
    apiKey: credential.apiKey,
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

/** 临时目录前缀（各消费点共用一种前缀，便于事后清残留）。 */
export const TMP_PREFIX = {
  toolFact: "erix-tool-fact-e2e-",
  erixRun: "erix-run-e2e-",
  cliReal: "erix-cli-real-",
  resumeReal: "erix-resume-real-e2e-",
};

export { tmpdir };
