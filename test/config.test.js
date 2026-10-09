import test from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmp } from "./helpers/tmp.js";

import {
  buildCompactionContext,
  defaultConfigPath,
  loadCliConfig,
  normalizeCompactionOption,
} from "../bin/config.js";

const ENV_NAMES = [
  "HOME",
  "XDG_CONFIG_HOME",
  "LLM_KIT_ENDPOINT",
  "LLM_KIT_API_KEY",
  "LLM_KIT_MODEL",
  "ERIX_DEFAULT_MODEL",
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
  const directory = await makeTmp("erix-cli-config-test-");
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

test("loadCliConfig reads the configured model", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, {
      slots: {
        default: {
          endpoint: "https://file.example.invalid",
          apiKey: "file-config-key",
          model: "file-model",
          maxOutputTokens: 4096,
          contextWindowTokens: 32768,
          cacheCapable: true,
        },
      },
    });

    await withEnvironment({}, async () => {
      assert.deepEqual(await loadCliConfig({ configPath }), {
        endpoint: "https://file.example.invalid",
        apiKey: "file-config-key",
        model: "file-model",
        maxOutputTokens: 4096,
        contextWindowTokens: 32768,
        cacheCapable: true,
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
      ERIX_DEFAULT_MODEL: "default-model",
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
      ERIX_DEFAULT_MODEL: "default-model",
    }, async () => {
      assert.deepEqual(await loadCliConfig({
        configPath: join(directory, "missing.json"),
      }), {
        endpoint: "https://env.example.invalid",
        apiKey: "env-key",
        model: "default-model",
        maxOutputTokens: 16384,
        contextWindowTokens: undefined,
      });

    });
  });
});

test("loadCliConfig rejects a missing model with an actionable hint", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, {
      slots: {
        default: {
          endpoint: "https://file.example.invalid",
          apiKey: "file-config-key",
        },
      },
    });

    await withEnvironment({}, async () => {
      await assert.rejects(
        loadCliConfig({ configPath }),
        /slots\.default\.model.*LLM_KIT_MODEL\/ERIX_DEFAULT_MODEL/u,
      );
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
            model: "file-model",
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
          model: "file-model",
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
            model: "file-model",
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
  assert.equal(context.strategy, "fold-statistical");
  assert.equal(context.protectedMessage({ role: "user", content: "task" }), true);
  assert.equal(context.protectedMessage({
    role: "user",
    content: [{ type: "tool_result", content: "result" }],
  }), false);
});

test("buildCompactionContext computes a budget from the context window", () => {
  const context = buildCompactionContext({
    contextWindowTokens: 20000,
    maxOutputTokens: 2000,
  });

  assert.equal(context.budgetTokens, 16000);
  assert.equal(context.strategy, "fold-statistical");
});

test("buildCompactionContext is disabled without a context window", () => {
  assert.equal(
    buildCompactionContext({ maxOutputTokens: 2000 }),
    undefined,
  );
});

test("buildCompactionContext keeps recovery hints optional", () => {
  const context = buildCompactionContext({
    contextWindowTokens: 20000,
    maxOutputTokens: 2000,
  }, 8000, "archive hint");

  assert.equal(context.recoveryHint, "archive hint");
  assert.equal(context.strategy, "fold-statistical");
  assert.equal(
    buildCompactionContext({ maxOutputTokens: 2000 }, undefined),
    undefined,
  );
});

test("loadCliConfig preserves the existing missing endpoint and API key error", async () => {
  await withDirectory(async (directory) => {
    await withEnvironment({}, async () => {
      await assert.rejects(
        loadCliConfig({ configPath: join(directory, "missing.json") }),
        {
          message: "缺少配置：LLM_KIT_ENDPOINT、LLM_KIT_API_KEY、LLM_KIT_MODEL or ERIX_DEFAULT_MODEL or slots.default.model。\n请在配置文件 slots.default.model 设置 model，或设置 LLM_KIT_MODEL/ERIX_DEFAULT_MODEL。",
        },
      );
    });
  });
});

test("buildCompactionContext honours the configured strategy name and defaults to fold-statistical (#167)", () => {
  const base = { contextWindowTokens: 20000, maxOutputTokens: 2000 };
  assert.equal(buildCompactionContext(base).strategy, "fold-statistical");
  assert.equal(buildCompactionContext(base, 8000).strategy, "fold-statistical");
  for (const name of ["sliding-window", "fold-statistical", "fold-llm"]) {
    const withName = { ...base, compaction: name };
    assert.equal(buildCompactionContext(withName).strategy, name);
    assert.equal(buildCompactionContext(withName, 8000).strategy, name);
    assert.equal(buildCompactionContext(withName, 8000, "hint", () => "stub").strategy, name);
    assert.equal(buildCompactionContext(withName, 8000).budgetTokens, 8000);
  }
  assert.throws(
    () => buildCompactionContext({ ...base, compaction: "psyche" }),
    /未知压缩策略[\s\S]*sliding-window \| fold-statistical \| fold-llm/u,
  );
});

test("normalizeCompactionOption validates CLI values and config feeds the strategy name (#167)", async () => {
  assert.equal(normalizeCompactionOption(" fold-llm "), "fold-llm");
  assert.throws(() => normalizeCompactionOption("llm-fold"), { name: "Error" });
  assert.throws(() => normalizeCompactionOption(""), { message: /sliding-window/u });

  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, {
      slots: {
        default: {
          endpoint: "https://file.example.invalid",
          apiKey: "file-config-key",
          model: "file-model",
          contextWindowTokens: 32768,
          compaction: "fold-llm",
        },
      },
    });
    await withEnvironment({}, async () => {
      assert.equal((await loadCliConfig({ configPath })).compaction, "fold-llm");
    });

    const defaultPath = await writeConfig(directory, {
      slots: {
        default: {
          endpoint: "https://file.example.invalid",
          apiKey: "file-config-key",
          model: "file-model",
        },
      },
    });
    await withEnvironment({}, async () => {
      assert.equal((await loadCliConfig({ configPath: defaultPath })).compaction, undefined);
    });

    const badPath = await writeConfig(directory, {
      slots: {
        default: {
          endpoint: "https://file.example.invalid",
          apiKey: "file-config-key",
          model: "file-model",
          compaction: "nope",
        },
      },
    });
    await withEnvironment({}, async () => {
      await assert.rejects(
        loadCliConfig({ configPath: badPath }),
        /未知压缩策略[\s\S]*fold-statistical/u,
      );
    });
  });
});
