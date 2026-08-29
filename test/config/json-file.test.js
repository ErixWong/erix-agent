import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJsonFileModelConfigProvider } from "../../src/config/json-file.js";
import { KitError } from "../../src/providers/errors.js";

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

test("resolves a slot, materializes apiKeyEnv, and falls back to default", async () => {
  const envName = `ERIX_JSON_FILE_KEY_${process.pid}`;
  const previous = process.env[envName];
  process.env[envName] = "env-secret";

  try {
    await withConfig({
      slots: {
        default: { protocol: "anthropic", model: "default-model" },
        fold: { protocol: "openai", model: "fold-model", apiKeyEnv: envName },
      },
    }, async (path) => {
      const provider = createJsonFileModelConfigProvider({ path });
      assert.deepEqual(await provider.resolve("fold"), {
        protocol: "openai",
        model: "fold-model",
        apiKeyEnv: envName,
        apiKey: "env-secret",
      });
      assert.deepEqual(await provider.resolve("missing"), {
        protocol: "anthropic",
        model: "default-model",
      });
    });
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test("materializes apiKeyFile and reads the file again on every resolve", async () => {
  await withConfig({
    slots: {
      default: {
        protocol: "openai",
        model: "file-model",
        apiKeyFile: "placeholder",
      },
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

test("throws a KitError when the requested and default slots are absent", async () => {
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
