import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createJsonFileModelConfigProvider } from "../../src/config/json-file.js";
import { KitError } from "../../src/providers/errors.js";
import { modelConfigProviderContract } from "../contract/model-config-provider.js";
import { makeTmp } from "../helpers/tmp.js";

const KEY_ENV = `ERIX_JSON_CONTRACT_KEY_${process.pid}`;

async function withConfig(config, callback) {
  const directory = await makeTmp("erix-llm-kit-config-");
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
  const directory = await makeTmp("erix-json-contract-");
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
}, {
  // issue #518: json-file is a slot map — an explicit unknown name must throw.
  mode: "throws",
  name: "no-such-slot",
  available: ["default", "fold"],
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

// ---- issue #518：「没写槽位」与「槽位写错」是两个请求，不许塌成同一个答案 ----

// 正向钉：省略槽位仍然走 default（行为一字不变）。这一格存在，是为了让「显式未知必须抛」
// 不能被一刀切扩成「全都抛」。
test("json-file: 省略槽位 ⇒ default（issue #518，行为不变）", async () => {
  await withConfig({
    slots: {
      default: { model: "default-model" },
      fold: { model: "fold-model" },
    },
  }, async (path) => {
    const provider = createJsonFileModelConfigProvider({ path });
    assert.equal((await provider.resolve()).model, "default-model");
    assert.equal((await provider.resolve(undefined)).model, "default-model");
    assert.equal((await provider.resolve(null)).model, "default-model");
  });
});

// 反向钉：显式给了一个不存在的槽位必须抛，且错误里点名槽位 + 列出可用槽位。
// #518 之前这里静默回落 default ⇒ 宿主写错槽位、跑的是另一个模型，且永远不知道。
test("json-file: 显式未知槽位 ⇒ 抛 KitError 并点名槽位与可用槽位（issue #518）", async () => {
  await withConfig({
    slots: {
      default: { model: "default-model" },
      fold: { model: "fold-model" },
    },
  }, async (path) => {
    const provider = createJsonFileModelConfigProvider({ path });
    await assert.rejects(
      provider.resolve("misstyped"),
      (error) => {
        assert.equal(error instanceof KitError, true);
        assert.equal(error.code, "unknown");
        assert.match(error.message, /配置槽位不存在: misstyped/);
        assert.match(error.message, /可用槽位: default, fold/);
        return true;
      },
    );
    // 非字符串的槽位名同样是「显式但写错」，不许悄悄折成 default。
    await assert.rejects(
      provider.resolve(42),
      (error) => error instanceof KitError && /配置槽位不存在: 42/.test(error.message),
    );
  });
});

test("json-file: 请求的槽位与 default 都不存在时抛 KitError（可用槽位一并点名）", async () => {
  await withConfig({ slots: { fold: { model: "fold-model" } } }, async (path) => {
    const provider = createJsonFileModelConfigProvider({ path });
    await assert.rejects(
      provider.resolve("missing"),
      (error) => error instanceof KitError
        && error.code === "unknown"
        && error.message === "配置槽位不存在: missing（可用槽位: fold）",
    );
  });
});

// `Object.hasOwn` 守卫在 #518 语义下的重述：原型属性名是「未知槽位」
//（以前回落 default，现在与其他未知名字一样硬失败），永远不会解析成 `Object.prototype` 的成员。
test("json-file: 原型属性名是未知槽位，不会解析成配置对象", async () => {
  await withConfig({
    slots: { default: { model: "default-model" } },
  }, async (path) => {
    const provider = createJsonFileModelConfigProvider({ path });
    for (const name of ["__proto__", "constructor"]) {
      await assert.rejects(
        provider.resolve(name),
        (error) => error instanceof KitError
          && error.message.includes(`配置槽位不存在: ${name}`)
          && /可用槽位: default/.test(error.message),
      );
    }
  });
});
