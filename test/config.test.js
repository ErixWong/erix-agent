import test from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmp } from "./helpers/tmp.js";

import {
  COMPACTION_BUDGET_SOURCES,
  COMPACTION_DISABLED_WARNING,
  buildCompactionContext,
  defaultConfigPath,
  loadCliConfig,
  normalizeCompactionOption,
  resetCompactionDisabledWarning,
  resolveCompactionBudget,
} from "../bin/config.js";
import { computeBudget } from "../src/compact/budget.js";

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
  // issue #614：CLI 默认策略是 fold-llm（统计摘要降为降级兜底）。
  assert.equal(context.strategy, "fold-llm");
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
  assert.equal(context.strategy, "fold-llm");
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
  assert.equal(context.strategy, "fold-llm");
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

test("buildCompactionContext honours the configured strategy name and defaults to fold-llm (#167/#614)", () => {
  const base = { contextWindowTokens: 20000, maxOutputTokens: 2000 };
  // issue #614：默认值是 fold-llm；显式名字（含统计摘要）仍然逐字生效。
  assert.equal(buildCompactionContext(base).strategy, "fold-llm");
  assert.equal(buildCompactionContext(base, 8000).strategy, "fold-llm");
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

// ── issue #682：压缩预算做成配置项 + 两处兜底合一 + 缺窗口要出声 ──────────────────────────
test("#682 判据：压缩预算优先级四态各一格（旗标 > 配置叶子 > 窗口派生 > 关闭）", () => {
  assert.deepEqual(COMPACTION_BUDGET_SOURCES, ["flag", "config", "derived", "disabled"]);

  const full = { contextWindowTokens: 20000, maxOutputTokens: 2000, compactBudgetTokens: 7000 };
  // ① 旗标（--compact-budget）赢过配置叶子与窗口派生。
  assert.deepEqual(resolveCompactionBudget(full, 8000), { budgetTokens: 8000, source: "flag" });
  // ② 没有旗标 ⇒ 配置叶子（slots.default.compactBudgetTokens）赢过窗口派生。
  assert.deepEqual(resolveCompactionBudget(full, undefined), { budgetTokens: 7000, source: "config" });
  // ③ 两者都没有 ⇒ 由窗口派生（computeBudget 公式本体未动：20000 - 2000 - max(2000, 2000)）。
  assert.deepEqual(
    resolveCompactionBudget({ contextWindowTokens: 20000, maxOutputTokens: 2000 }, undefined),
    { budgetTokens: 16000, source: "derived" },
  );
  // ④ 没有窗口也没有显式预算 ⇒ 关闭（预算 undefined，语义是「不折叠」）。
  assert.deepEqual(
    resolveCompactionBudget({ maxOutputTokens: 2000 }, undefined),
    { budgetTokens: undefined, source: "disabled" },
  );

  // 来源是**上下文数据**（子 run 记录带得走），四态里前三态在 buildCompactionContext 上可见。
  assert.equal(buildCompactionContext(full, 8000).budgetSource, "flag");
  assert.equal(buildCompactionContext(full, 8000).budgetTokens, 8000);
  assert.equal(buildCompactionContext(full).budgetSource, "config");
  assert.equal(buildCompactionContext(full).budgetTokens, 7000);
  assert.equal(
    buildCompactionContext({ contextWindowTokens: 20000, maxOutputTokens: 2000 }).budgetSource,
    "derived",
  );
  // 配置叶子能救「缺窗口」：有显式预算就不需要窗口，也不算关闭。
  const rescued = buildCompactionContext({ compactBudgetTokens: 5000 });
  assert.equal(rescued.budgetTokens, 5000);
  assert.equal(rescued.budgetSource, "config");
});

test("#682 判据：缺 maxOutputTokens 时两条路径算出同一个预算（两条都真跑到）", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, {
      slots: {
        default: {
          endpoint: "https://budget.example.invalid",
          apiKey: "file-config-key",
          model: "file-model",
          contextWindowTokens: 262144,
          // 刻意不写 maxOutputTokens：缺陷就出在「同一个缺失字段两处各兜各的」。
        },
      },
    });

    await withEnvironment({}, async () => {
      // 路径 1：真的过配置加载器（loader 的 DEFAULT_MAX_OUTPUT_TOKENS 兜底）。
      const loaded = await loadCliConfig({ configPath });
      assert.equal(loaded.maxOutputTokens, 16384);
      const viaLoader = buildCompactionContext(loaded).budgetTokens;

      // 路径 2：直接调 buildCompactionContext（以前这里 `?? 65536` 会算出另一个数）。
      const direct = buildCompactionContext({ contextWindowTokens: 262144 }).budgetTokens;

      assert.equal(viaLoader, direct, "两条路径必须算出同一个预算（#682 的原始缺陷：差 49152 token）");
      assert.equal(viaLoader, computeBudget({ contextWindowTokens: 262144, maxOutputTokens: 16384 }));
      // 反向证：旧侧门（65536）确实会算出另一个数——所以「相等」不是两边都错的巧合。
      assert.notEqual(viaLoader, computeBudget({ contextWindowTokens: 262144, maxOutputTokens: 65536 }));
    });
  });
});

test("#682 判据：非法 slots.default.compactBudgetTokens 在 load 期报错（不是静默忽略）", async () => {
  for (const value of [0, -1, 1.5, "4096", true, {}, []]) {
    await withDirectory(async (directory) => {
      const configPath = await writeConfig(directory, {
        slots: {
          default: {
            endpoint: "https://budget-invalid.example.invalid",
            apiKey: "file-config-key",
            model: "file-model",
            contextWindowTokens: 20000,
            compactBudgetTokens: value,
          },
        },
      });
      await withEnvironment({}, async () => {
        await assert.rejects(
          loadCliConfig({ configPath }),
          /slots\.default\.compactBudgetTokens 必须是正整数/u,
          `非法值 ${JSON.stringify(value)} 必须在 load 期报错`,
        );
      });
    });
  }

  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, {
      slots: {
        default: {
          endpoint: "https://budget-valid.example.invalid",
          apiKey: "file-config-key",
          model: "file-model",
          contextWindowTokens: 20000,
          compactBudgetTokens: 9000,
        },
      },
    });
    await withEnvironment({}, async () => {
      assert.equal((await loadCliConfig({ configPath })).compactBudgetTokens, 9000);
    });
  });
});

test("#682 判据：缺窗口必须打一行 stderr 告警（不是只断言「不折叠」）", () => {
  resetCompactionDisabledWarning();
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    // 语义不变：缺窗口 ⇒ 不折叠（返回 undefined）。
    assert.equal(buildCompactionContext({ maxOutputTokens: 2000 }), undefined);
    // 进程内只打一次（父 run + 每个子 run 共用同一行，不刷屏）。
    assert.equal(buildCompactionContext({ maxOutputTokens: 2000 }), undefined);
  } finally {
    process.stderr.write = originalWrite;
    resetCompactionDisabledWarning();
  }

  assert.deepEqual(writes, [`${COMPACTION_DISABLED_WARNING}\n`], "必须**真的**写一行 stderr");
  assert.match(COMPACTION_DISABLED_WARNING, /不启用自动压缩/u);
  assert.match(COMPACTION_DISABLED_WARNING, /contextWindowTokens/u);
  assert.match(COMPACTION_DISABLED_WARNING, /compactBudgetTokens/u, "告警要告诉用户怎么显式指定预算");
});
