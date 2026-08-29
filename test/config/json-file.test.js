import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonFileModelConfigProvider } from "../../src/config/json-file.js";
import { KitError } from "../../src/providers/errors.js";
import { modelConfigProviderContract } from "../contract/model-config-provider.js";

const KEY_ENV = `ERIX_JSON_CONTRACT_KEY_${process.pid}`;

async function withConfig(config, callback) {
  const directory = await mkdtemp(join(tmpdir(), "erix-llm-kit-config-"));
  const path = join(directory, "models.json");
  try {
    await writeFile(path, JSON.stringify(config), "utf8");
    return await callback(path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

modelConfigProviderContract("json-file", async () => {
  process.env[KEY_ENV] = "json-contract-secret";
  // json-file 每次 resolve 重读文件：目录须活过整个契约套件，进程退出后由 OS 清理
  const directory = await mkdtemp(join(tmpdir(), "erix-json-contract-"));
  const path = join(directory, "models.json");
  await writeFile(path, JSON.stringify({
    slots: {
      default: { protocol: "anthropic", endpoint: "https://example.invalid", model: "default-model" },
      fold: { protocol: "openai", endpoint: "https://example.invalid", model: "fold-model", apiKeyEnv: KEY_ENV },
    },
  }), "utf8");
  return {
    provider: createJsonFileModelConfigProvider({ path }),
    slot: "fold",
    expect: { defaultModel: "default-model", slotModel: "fold-model", materializedKey: "json-contract-secret" },
  };
});

// ---- 实现特有行为 ----

test("json-file: apiKeyFile 物化且每次 resolve 重读文件", async () => {
  await withConfig({
    slots: {
      default: { protocol: "openai", model: "file-model", apiKeyFile: "placeholder" },
    },
  }, async (path, directory) => {
    const keyPath = join(directory, "secret.key");
    await writeFile(keyPath, "first-secret\n", "utf8");
    const config = JSON.parse(await readFile(path, "utf8"));
    config.slots.default.apiKeyFile = keyPath;
    await writeFile(path, JSON.stringify(config), "utf8");

    const provider = createJsonFileModelConfigProvider({ path });
    assert.equal((await provider.resolve()).apiKey, "first-secret");

    await writeFile(keyPath, "second-secret\n", "utf8");
    assert.equal((await provider.resolve()).apiKey, "second-secret");
  });
});

test("json-file: 请求的槽位与 default 都不存在时抛 KitError", async () => {
  await withConfig({ slots: { fold: { model: "fold-model" } } }, async (path) => {
    const provider = createJsonFileModelConfigProvider({ path });
    await assert.rejects(
      provider.resolve("missing"),
      (error) => error instanceof KitError
        && error.code === "unknown"
        && error.message === "配置槽位不存在: missing",
    );
  });
});
