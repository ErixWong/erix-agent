// 槽位 → provider 构造件（issue #406 B2-a 的 C-a）：`src/config/slot-provider.js` 的单测。
//
// 三条要钉的事实：
//   1. 默认路径解析（显式 > `ERIX_CONFIG_PATH` > `XDG_CONFIG_HOME` > `~/.erix/config.json`，含 `~` 展开）；
//   2. 必填字段校验的**错误码与文案**（`config_missing` / `config_invalid`，文案里点名缺哪几个字段）；
//   3. 摊平桥接（`maxTokens` 回落 `maxOutputTokens`、未知字段惰性）+ M7（`warn` 真的接进注入口）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CONFIG_PATH_ENV,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  createProviderForSlot,
  loadModelSlot,
} from "../../src/config/slot-provider.js";
import { makeTmp } from "../helpers/tmp.js";

const SLOT = {
  endpoint: "https://slot.example.invalid/v1",
  model: "slot-model",
  apiKey: "slot-secret",
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
};

/**
 * 写一份 config.json（`{slots:{default:…}}`）并返回目录与文件路径。
 *
 * @param {Record<string, unknown>} slots
 * @returns {Promise<{dir:string, file:string}>}
 */
async function writeConfig(slots) {
  const dir = await makeTmp("erix-slot-provider-");
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ slots }), "utf8");
  return { dir, file };
}

/**
 * 接住真出门请求的最小 fetch 桩（provider 的 `fetchImpl` 在构造时求值）。
 *
 * @param {Array<Record<string, any>>} sink
 * @returns {typeof fetch}
 */
function captureFetch(sink) {
  return /** @type {any} */ (async (url, options) => {
    sink.push({ url: String(url), body: JSON.parse(String(options?.body ?? "{}")) });
    return {
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      },
    };
  });
}

test("loadModelSlot 读 slots.default 并摊平出 {slot, configPath}", async () => {
  const { dir, file } = await writeConfig({ default: SLOT });
  try {
    const loaded = await loadModelSlot({ configPath: file, env: {}, home: "/nonexistent-home" });
    assert.equal(loaded.configPath, file);
    assert.deepEqual(loaded.slot, SLOT);
    assert.equal(loaded.metadataMissing, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("缺预算元数据时如实报告 metadataMissing（不是必填校验，是口径对账）", async () => {
  const { dir, file } = await writeConfig({
    default: { endpoint: SLOT.endpoint, model: SLOT.model, apiKey: SLOT.apiKey },
  });
  try {
    const loaded = await loadModelSlot({ configPath: file, env: {}, home: "/nonexistent-home" });
    assert.deepEqual(loaded.metadataMissing?.missingFields, ["contextWindowTokens", "maxOutputTokens"]);
    assert.equal(loaded.metadataMissing?.source, "config");
    assert.match(String(loaded.metadataMissing?.detail), /compaction and aggregate output budget are disabled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("默认路径：显式 configPath > ERIX_CONFIG_PATH > XDG_CONFIG_HOME > ~/.erix/config.json", async () => {
  const home = await makeTmp("erix-slot-home-");
  const xdg = await makeTmp("erix-slot-xdg-");
  const envDir = await makeTmp("erix-slot-env-");
  const explicitDir = await makeTmp("erix-slot-explicit-");
  try {
    // 四份候选配置的 `model` 各不相同，于是「读到了哪一份」可由返回值反查。
    const writeAt = async (file, model) => {
      await writeFile(file, JSON.stringify({ slots: { default: { ...SLOT, model } } }), "utf8");
    };
    const homeConfig = join(home, ".erix", "config.json");
    const xdgConfig = join(xdg, "erix", "config.json");
    const envConfig = join(envDir, "env-config.json");
    const explicitConfig = join(explicitDir, "explicit-config.json");
    await mkdir(join(home, ".erix"), { recursive: true });
    await mkdir(join(xdg, "erix"), { recursive: true });
    await writeAt(homeConfig, "from-home");
    await writeAt(xdgConfig, "from-xdg");
    await writeAt(envConfig, "from-env");
    await writeAt(explicitConfig, "from-explicit");

    const at = async (options) => (await loadModelSlot({ home, ...options })).slot.model;

    assert.equal(await at({ env: {} }), "from-home");
    assert.equal(await at({ env: { XDG_CONFIG_HOME: xdg } }), "from-xdg");
    assert.equal(
      await at({ env: { XDG_CONFIG_HOME: xdg, [CONFIG_PATH_ENV]: envConfig } }),
      "from-env",
    );
    assert.equal(
      await at({ configPath: explicitConfig, env: { XDG_CONFIG_HOME: xdg, [CONFIG_PATH_ENV]: envConfig } }),
      "from-explicit",
    );
    // `~` 展开：显式路径也能写 `~/…`（宿主配置里常见）。
    assert.equal(await at({ configPath: "~/.erix/config.json", env: {} }), "from-home");
    // 环境变量里的 `~` 同样展开（example 那份只展开显式路径，本文件两处都展开）。
    assert.equal(await at({ env: { [CONFIG_PATH_ENV]: "~/.erix/config.json" } }), "from-home");
  } finally {
    for (const dir of [home, xdg, envDir, explicitDir]) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("配置文件不存在 ⇒ KitError config_missing，文案点名路径与 ERIX_CONFIG_PATH", async () => {
  const home = await makeTmp("erix-slot-missing-");
  try {
    const missing = join(home, ".erix", "config.json");
    await assert.rejects(
      () => loadModelSlot({ env: {}, home }),
      (error) => {
        assert.equal(error?.name, "KitError");
        assert.equal(error?.code, "config_missing");
        assert.equal(error?.retryable, false);
        assert.ok(String(error?.message).includes(missing), `文案应点名路径：${error?.message}`);
        assert.match(String(error?.message), new RegExp(CONFIG_PATH_ENV));
        assert.match(String(error?.message), /slots\.default 提供 endpoint\/model\/apiKey/);
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("必填字段缺失 ⇒ config_invalid 且逐条点名（apiKey 一栏列出三个来源）", async () => {
  const { dir, file } = await writeConfig({ default: { endpoint: "  ", model: "" } });
  try {
    await assert.rejects(
      () => loadModelSlot({ configPath: file, env: {}, home: "/nonexistent-home" }),
      (error) => {
        assert.equal(error?.code, "config_invalid");
        assert.match(String(error?.message), /缺少必填字段 endpoint, model, apiKey\|apiKeyEnv\|apiKeyFile/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("slots.default 不是对象 / 配置不是合法 JSON ⇒ config_invalid（带根因原话）", async () => {
  const dir = await makeTmp("erix-slot-invalid-");
  try {
    // 非对象槽位在 `createJsonFileModelConfigProvider` 那一层就被判掉（`isRecord` 守卫），
    // 本层把它包成同一个 code，宿主只需要认 `config_invalid` 一个名字。
    const notObject = join(dir, "not-object.json");
    await writeFile(notObject, JSON.stringify({ slots: { default: "nope" } }), "utf8");
    await assert.rejects(
      () => loadModelSlot({ configPath: notObject, env: {}, home: "/nonexistent-home" }),
      (error) => {
        assert.equal(error?.code, "config_invalid");
        assert.match(String(error?.message), /模型配置解析失败/);
        assert.match(String(error?.message), /配置槽位不存在: default/);
        return true;
      },
    );

    const brokenJson = join(dir, "broken.json");
    await writeFile(brokenJson, "{\"slots\": ", "utf8");
    await assert.rejects(
      () => loadModelSlot({ configPath: brokenJson, env: {}, home: "/nonexistent-home" }),
      (error) => {
        assert.equal(error?.code, "config_invalid");
        assert.match(String(error?.message), /模型配置解析失败/);
        assert.equal(error?.cause instanceof Error, true);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("modelOverride 覆盖槽位模型名，且不改动调用方传进来的对象", async () => {
  const { dir, file } = await writeConfig({ default: SLOT });
  try {
    const loaded = await loadModelSlot({
      configPath: file,
      modelOverride: "override-model",
      env: {},
      home: "/nonexistent-home",
    });
    assert.equal(loaded.slot.model, "override-model");
    assert.equal(SLOT.model, "slot-model", "槽位对象是快照：覆盖不许写回调用方的对象");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("摊平桥接：maxTokens 回落 maxOutputTokens、未知槽位字段惰性、timeoutMs 缺省 300000", async () => {
  const requests = [];
  const provider = createProviderForSlot({
    ...SLOT,
    fetchImpl: captureFetch(requests),
    somethingHostSpecific: "inert",
  });
  assert.equal(provider.contextWindowTokens, 200_000);
  assert.equal(provider.maxOutputTokens, 4096);
  assert.equal(typeof provider.chat, "function");
  assert.equal(typeof provider.chatStream, "function");

  await provider.chat({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, SLOT.model);
  // 摊平的核心承诺：槽位只有 maxOutputTokens 时，请求体的 max_tokens 跟着它走。
  assert.equal(requests[0].body.max_tokens, 4096);

  // 显式 maxTokens 优先（不新造第二套默认值）。
  const explicit = [];
  const overridden = createProviderForSlot({ ...SLOT, maxTokens: 123, fetchImpl: captureFetch(explicit) });
  await overridden.chat({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  assert.equal(explicit[0].body.max_tokens, 123);

  assert.equal(DEFAULT_PROVIDER_TIMEOUT_MS, 300_000);
  assert.throws(() => createProviderForSlot(null), /slot 必须是对象/);
});

test("M7：warn 一路接进 createRequestInjection（宿主注入口冲突不再是 console 独享）", async () => {
  const warnings = [];
  createProviderForSlot(
    { ...SLOT, extraBody: { model: "host-wins?", stream: true } },
    { warn: (message) => warnings.push(message) },
  );
  assert.equal(warnings.length, 2, `每个冲突字段各一条，实际：${JSON.stringify(warnings)}`);
  for (const message of warnings) {
    assert.match(message, /^Warning: extraBody field "(model|stream)" is engine-owned/);
    // 红线：文案只带字段名，绝不带值（宿主可能把密钥塞进 extraBody）。
    assert.equal(message.includes("host-wins?"), false);
  }
  // 每个 provider 实例每个字段只说一次（同一个 warn 回调不被刷屏）。
  assert.equal(new Set(warnings).size, 2);
});
