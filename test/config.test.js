import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCompactionContext,
  defaultConfigPath,
  loadCliConfig,
} from "../bin/config.js";

const ENV_NAMES = [
  "HOME",
  "XDG_CONFIG_HOME",
  "LLM_KIT_ENDPOINT",
  "LLM_KIT_API_KEY",
  "LLM_KIT_MODEL",
  "LLM_KIT_MAX_TOKENS",
];

async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(
    ENV_NAMES.map((name) => [name, process.env[name]]),
  );

  try {
    for (const name of ENV_NAMES) {
      const value = values[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await callback();
  } finally {
    for (const name of ENV_NAMES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

async function withDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "erix-cli-config-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeConfig(directory, config) {
  const path = join(directory, "config.json");
  await writeFile(path, `${JSON.stringify(config)}\n`, "utf8");
  return path;
}

test("defaultConfigPath uses XDG_CONFIG_HOME when set", async () => {
  await withDirectory(async (directory) => {
    await withEnvironment({ XDG_CONFIG_HOME: directory }, () => {
      assert.equal(defaultConfigPath(), join(directory, "erix", "config.json"));
    });
  });
});

test("defaultConfigPath falls back to HOME", async () => {
  await withDirectory(async (home) => {
    await withEnvironment({ HOME: home, XDG_CONFIG_HOME: undefined }, () => {
      assert.equal(defaultConfigPath(), join(home, ".erix", "config.json"));
    });
  });
});

test("loadCliConfig reads file values and applies the default model", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, {
      slots: {
        default: {
          endpoint: "https://file.example.invalid",
          apiKey: "file-config-key",
          maxOutputTokens: 4096,
          contextWindowTokens: 32768,
        },
      },
    });

    await withEnvironment({}, async () => {
      assert.deepEqual(await loadCliConfig({ configPath }), {
        endpoint: "https://file.example.invalid",
        apiKey: "file-config-key",
        model: "kimi-for-coding",
        maxOutputTokens: 4096,
        contextWindowTokens: 32768,
      });
    });
  });
});

test("loadCliConfig env overrides endpoint/apiKey/model but not maxOutputTokens", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, {
      slots: {
        default: {
          endpoint: "https://file.example.invalid",
          model: "file-model",
          apiKey: "file-config-key",
          maxOutputTokens: 4096,
          contextWindowTokens: 32768,
        },
      },
    });

    await withEnvironment({
      LLM_KIT_ENDPOINT: " https://env.example.invalid ",
      LLM_KIT_API_KEY: " env-key ",
      LLM_KIT_MODEL: " env-model ",
      LLM_KIT_MAX_TOKENS: "2048",
    }, async () => {
      assert.deepEqual(await loadCliConfig({ configPath }), {
        endpoint: "https://env.example.invalid",
        apiKey: "env-key",
        model: "env-model",
        maxOutputTokens: 4096,
        contextWindowTokens: 32768,
      });
    });
  });
});

test("loadCliConfig treats a missing config file as an empty config", async () => {
  await withDirectory(async (directory) => {
    await withEnvironment({
      LLM_KIT_ENDPOINT: "https://env.example.invalid",
      LLM_KIT_API_KEY: "env-key",
    }, async () => {
      assert.deepEqual(await loadCliConfig({
        configPath: join(directory, "missing.json"),
      }), {
        endpoint: "https://env.example.invalid",
        apiKey: "env-key",
        model: "kimi-for-coding",
        maxOutputTokens: 16384,
        contextWindowTokens: undefined,
      });
    });
  });
});

test("loadCliConfig reads an explicitly supplied config path", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, {
      slots: {
        default: {
          endpoint: "https://explicit.example.invalid",
          model: "explicit-model",
          apiKey: "explicit-key",
        },
      },
    });

    await withEnvironment({}, async () => {
      assert.deepEqual(await loadCliConfig({ configPath }), {
        endpoint: "https://explicit.example.invalid",
        apiKey: "explicit-key",
        model: "explicit-model",
        maxOutputTokens: 16384,
        contextWindowTokens: undefined,
      });
    });
  });
});

test("loadCliConfig resolves apiKeyFile from the config slot", async () => {
  await withDirectory(async (directory) => {
    const keyPath = join(directory, "api-key");
    await writeFile(keyPath, "file-key\n", "utf8");
    const configPath = await writeConfig(directory, {
      slots: {
        default: {
          endpoint: "https://file-key.example.invalid",
          model: "file-key-model",
          apiKeyFile: keyPath,
        },
      },
    });

    await withEnvironment({}, async () => {
      assert.deepEqual(await loadCliConfig({ configPath }), {
        endpoint: "https://file-key.example.invalid",
        apiKey: "file-key",
        model: "file-key-model",
        maxOutputTokens: 16384,
        contextWindowTokens: undefined,
      });
    });
  });
});

test("loadCliConfig falls back to the default for invalid maxOutputTokens", async () => {
  for (const value of [0, -1, 1.5, "4096", null]) {
    await withDirectory(async (directory) => {
      const configPath = await writeConfig(directory, {
        slots: {
          default: {
            endpoint: "https://invalid-max.example.invalid",
            apiKey: "file-config-key",
            maxOutputTokens: value,
          },
        },
      });

      await withEnvironment({}, async () => {
        const config = await loadCliConfig({ configPath });
        assert.equal(config.maxOutputTokens, 16384);
        assert.equal(config.contextWindowTokens, undefined);
      });
    });
  }
});

test("loadCliConfig parses contextWindowTokens and ignores invalid values", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, {
      slots: {
        default: {
          endpoint: "https://context.example.invalid",
          apiKey: "file-config-key",
          contextWindowTokens: 20000,
        },
      },
    });

    await withEnvironment({}, async () => {
      assert.equal(
        (await loadCliConfig({ configPath })).contextWindowTokens,
        20000,
      );
    });
  });

  for (const value of [0, -1, 1.5, "20000", null]) {
    await withDirectory(async (directory) => {
      const configPath = await writeConfig(directory, {
        slots: {
          default: {
            endpoint: "https://invalid-context.example.invalid",
            apiKey: "file-config-key",
            contextWindowTokens: value,
          },
        },
      });

      await withEnvironment({}, async () => {
        assert.equal(
          (await loadCliConfig({ configPath })).contextWindowTokens,
          undefined,
        );
      });
    });
  }
});

test("buildCompactionContext prioritizes an explicit budget", () => {
  const context = buildCompactionContext({
    contextWindowTokens: 20000,
    maxOutputTokens: 2000,
  }, 8000);

  assert.equal(context.budgetTokens, 8000);
  assert.equal(context.strategy.name, "fold-statistical");
});

test("buildCompactionContext computes a budget from the context window", () => {
  const context = buildCompactionContext({
    contextWindowTokens: 20000,
    maxOutputTokens: 2000,
  });

  assert.equal(context.budgetTokens, 16000);
  assert.equal(context.strategy.name, "fold-statistical");
});

test("buildCompactionContext is disabled without a context window", () => {
  assert.equal(
    buildCompactionContext({ maxOutputTokens: 2000 }),
    undefined,
  );
});

test("loadCliConfig preserves the existing missing endpoint and API key error", async () => {
  await withDirectory(async (directory) => {
    await withEnvironment({}, async () => {
      await assert.rejects(
        loadCliConfig({ configPath: join(directory, "missing.json") }),
        {
          message: "缺少环境变量：LLM_KIT_ENDPOINT、LLM_KIT_API_KEY。\n请先设置，例如：\n  export LLM_KIT_ENDPOINT=\"https://你的 OpenAI 兼容 API 地址\"\n  export LLM_KIT_API_KEY=\"你的 API 密钥\"",
        },
      );
    });
  });
});
