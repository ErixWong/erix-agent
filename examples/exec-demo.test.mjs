// e2e：exec-demo 打真实 relay（需 LLM_KIT_E2E=1，缺省 skip）
// 验收锚点（issue #1 / docs/testing.md §1）：轮数≥2、transcript 含 exec 的 tool_result、finalText 非空
//
// 本文件另含**不联网**用例（始终跑）：
// ① 断言输出预算 maxOutputTokens 确实传到了 provider 构造参数上（issue #245 第 3 件）；
// ② 断言 provider / model 的配置解析（工单 E2EPROV：provider 槽位名与模型名都不许写死）。
// 它们只把 HOME 指向临时目录里的假 models.json，并把 fetch 关掉，真发了请求就会红；
// 真实的 ~/.pi/agent/models.json 只在 LLM_KIT_E2E=1 的「真实环境」用例里被读。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEMO_MODEL_PREFERENCES,
  createProviderFromConfig,
  loadRelayConfig,
  runExecDemo,
} from "./exec-demo.js";

const E2E = process.env.LLM_KIT_E2E === "1";

/** 配置解析的全部入口；用例进出都要清理，避免宿主环境变量决定用例结论 */
const RELAY_ENV_KEYS = ["LLM_KIT_RELAY_PROVIDER", "LLM_KIT_RELAY_URL", "LLM_KIT_MODEL"];

/** 造一个 models.json 里的 provider 条目；模型 id 逐个建，便于测「偏好表 ∩ 模型列表」 */
function fakeProviderEntry({
  baseUrl = "https://relay.invalid/v1",
  apiKey = "sk-fake-not-secret",
  modelIds = ["kimi-for-coding"],
  maxTokens,
  contextWindow = 200_000,
} = {}) {
  return { baseUrl, apiKey, models: modelIds.map((id) => ({ id, maxTokens, contextWindow })) };
}

/**
 * 把 HOME 指向一个只装了 `.pi/agent/models.json` 的临时目录（providers 由用例给定），
 * 同时清掉解析入口环境变量、把 globalThis.fetch 关掉：真发了请求就会红。
 * 用例内部可以自己再设 LLM_KIT_* —— 退出时一律还原。
 */
async function withFakeHome(providers, fn) {
  const home = await mkdtemp(join(tmpdir(), "exec-demo-home-"));
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(join(home, ".pi/agent/models.json"), JSON.stringify({ providers }), "utf8");
  const saved = {};
  for (const key of ["HOME", ...RELAY_ENV_KEYS]) saved[key] = process.env[key];
  const savedFetch = globalThis.fetch;
  process.env.HOME = home;
  for (const key of RELAY_ENV_KEYS) delete process.env[key];
  globalThis.fetch = () => { throw new Error("不联网用例不应发任何网络请求"); };
  try {
    return await fn();
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}

/** 两个槽位的常见形态：名字随意（真实机器上叫 erixai/inteva），模型各不相同 */
function twoProviderFixture() {
  return {
    alpha: fakeProviderEntry({
      baseUrl: "https://alpha.invalid/v1",
      apiKey: "sk-alpha-not-secret",
      modelIds: ["kimi-for-coding", "glm-5.3-flash-awq"],
    }),
    beta: fakeProviderEntry({
      baseUrl: "https://beta.invalid/v1",
      apiKey: "sk-beta-not-secret",
      modelIds: ["k3", "deepseek-flash"],
    }),
  };
}

/** 断言错误信息里把候选摊开了（槽位名 + baseUrl + 各自模型列表），不是只给一个死名字 */
function assertListsCandidates(message, { names = [], models = [] } = {}) {
  assert.ok(typeof message === "string" && message.length > 0, "必须抛错并给出可选候选");
  for (const name of names) assert.ok(message.includes(name), `错误信息应含候选 provider 名 ${name}：${message}`);
  for (const id of models) assert.ok(message.includes(id), `错误信息应含可用模型 ${id}：${message}`);
  assert.ok(/baseUrl=/.test(message), `错误信息应列出各候选的 baseUrl：${message}`);
}

// ---- 不联网用例（始终跑）----

test("exec-demo：输出预算从 models.json 读出并被夹到 8192（不联网）", async () => {
  for (const c of [
    { maxTokens: 20_000, want: 8192 },   // 高于上限→夹住
    { maxTokens: 2048, want: 2048 },     // 低于上限→原值
    { want: 8192 },                       // 没写 maxTokens→兜底 8192
  ]) {
    await withFakeHome({
      "fake-relay": fakeProviderEntry({ modelIds: ["kimi-for-coding"], maxTokens: c.maxTokens, contextWindow: 200_000 }),
    }, async () => {
      const cfg = await loadRelayConfig();
      assert.equal(cfg.maxOutputTokens, c.want, `models[0].maxTokens=${c.maxTokens} 应得出 ${c.want}`);
      assert.equal(cfg.endpoint, "https://relay.invalid/v1");
      assert.equal(cfg.apiKey, "sk-fake-not-secret");
      assert.equal(cfg.contextWindowTokens, 200_000, "contextWindowTokens 取值来源不变：仍是 models[0].contextWindow");
      assert.ok(typeof cfg.model === "string" && cfg.model.length > 0, "模型名必须来自配置，不得为空");
    });
  }
});

test("exec-demo：maxOutputTokens 真的进了 provider 构造参数（不联网，注入 provider 工厂）", async () => {
  let captured;
  const fakeProvider = { __fake: "provider" };
  const built = await withFakeHome({
    "fake-relay": fakeProviderEntry({ maxTokens: 20_000, contextWindow: 200_000 }),
  }, async () => {
    const cfg = await loadRelayConfig();
    return createProviderFromConfig(cfg, (options) => { captured = options; return fakeProvider; });
  });
  assert.equal(built, fakeProvider, "返回值必须是注入工厂的产物（真实 provider 未被构造）");
  assert.equal(captured.maxOutputTokens, 8192, "输出预算必须显式传给 provider 构造函数（此前算了却未传）");
  assert.equal(captured.endpoint, "https://relay.invalid/v1");
  assert.equal(captured.apiKey, "sk-fake-not-secret");
  assert.ok(typeof captured.model === "string" && captured.model.length > 0, "模型名从配置透传，未硬编码覆盖");
  assert.equal(captured.timeoutMs, 120_000);

  // 轮数上限仍显式存在：不联网跑不了真 loop，故在源码层面钉住它仍被显式写出，
  // 不会退化成库里 runToolLoop 的默认轮数上限。
  const src = await readFile(new URL("./exec-demo.js", import.meta.url), "utf8");
  assert.match(src, /maxRounds: 8,/, "runToolLoop 侧的 maxRounds 上限必须仍显式写出");
});

// ① LLM_KIT_RELAY_PROVIDER：按槽位名命中
test("provider 解析①：LLM_KIT_RELAY_PROVIDER 按名字命中，模型仍从该 provider 的列表里挑（不联网）", async () => {
  await withFakeHome(twoProviderFixture(), async () => {
    process.env.LLM_KIT_RELAY_PROVIDER = "beta";
    const cfg = await loadRelayConfig();
    assert.equal(cfg.provider, "beta");
    assert.equal(cfg.endpoint, "https://beta.invalid/v1");
    assert.equal(cfg.apiKey, "sk-beta-not-secret");
    assert.equal(cfg.model, "k3", "beta 没有偏好表首位的 kimi-for-coding，应退到列表里存在的 k3");

    process.env.LLM_KIT_RELAY_PROVIDER = "alpha";
    const alpha = await loadRelayConfig();
    assert.equal(alpha.endpoint, "https://alpha.invalid/v1");
    assert.equal(alpha.model, "kimi-for-coding", "偏好表按顺序求交：列表里有 kimi-for-coding 就用它");
  });
});

test("provider 解析①b：LLM_KIT_RELAY_PROVIDER 指向不存在的槽位时报错并列候选，不静默换槽位（不联网）", async () => {
  await withFakeHome(twoProviderFixture(), async () => {
    process.env.LLM_KIT_RELAY_PROVIDER = "no-such-slot";
    await assert.rejects(loadRelayConfig(), (error) => {
      assertListsCandidates(error.message, {
        names: ["alpha", "beta", "no-such-slot"],
        models: ["kimi-for-coding", "k3", "glm-5.3-flash-awq", "deepseek-flash"],
      });
      return true;
    });
  });
});

// ② LLM_KIT_RELAY_URL：按 baseUrl 同源匹配，尾部斜杠必须被规范化
test("provider 解析②：LLM_KIT_RELAY_URL 同源匹配命中，含尾部斜杠差异（不联网）", async () => {
  // 配置写 https://alpha.invalid/v1，环境变量多给一个尾斜杠 → 仍必须命中
  await withFakeHome(twoProviderFixture(), async () => {
    process.env.LLM_KIT_RELAY_URL = "https://alpha.invalid/v1/";
    const cfg = await loadRelayConfig();
    assert.equal(cfg.provider, "alpha");
    assert.equal(cfg.endpoint, "https://alpha.invalid/v1");
    assert.equal(cfg.model, "kimi-for-coding");
  });

  // 反向：配置里带尾斜杠，环境变量不带 → 同样命中
  await withFakeHome({
    "slashy": fakeProviderEntry({ baseUrl: "https://slashy.invalid/v1/", modelIds: ["k3"] }),
    "beta": fakeProviderEntry({ baseUrl: "https://beta.invalid/v1", apiKey: "sk-beta-not-secret", modelIds: ["k3"] }),
  }, async () => {
    process.env.LLM_KIT_RELAY_URL = "https://slashy.invalid/v1";
    const cfg = await loadRelayConfig();
    assert.equal(cfg.provider, "slashy");
    assert.equal(cfg.endpoint, "https://slashy.invalid/v1/");
  });

  // 同源做法：环境变量只给 origin，也能命中带路径的 baseUrl
  await withFakeHome(twoProviderFixture(), async () => {
    process.env.LLM_KIT_RELAY_URL = "https://beta.invalid";
    const cfg = await loadRelayConfig();
    assert.equal(cfg.provider, "beta", "同源（origin 相同）应算命中，这是 vision 的成熟做法");
  });
});

// ③ 只设 LLM_KIT_MODEL：凭模型 id 反查 provider
test("provider 解析③：只设 LLM_KIT_MODEL 时按模型列表反查 provider（不联网）", async () => {
  await withFakeHome(twoProviderFixture(), async () => {
    process.env.LLM_KIT_MODEL = "glm-5.3-flash-awq";
    const cfg = await loadRelayConfig();
    assert.equal(cfg.provider, "alpha", "只有 alpha 的 models 列表含该 id");
    assert.equal(cfg.endpoint, "https://alpha.invalid/v1");
    assert.equal(cfg.model, "glm-5.3-flash-awq");
  });
});

test("provider 解析③b：模型 id 无人提供时报错并列候选（不联网）", async () => {
  await withFakeHome(twoProviderFixture(), async () => {
    process.env.LLM_KIT_MODEL = "model-nobody-has";
    await assert.rejects(loadRelayConfig(), (error) => {
      assertListsCandidates(error.message, {
        names: ["alpha", "beta", "model-nobody-has"],
        models: ["kimi-for-coding", "k3"],
      });
      return true;
    });
  });
});

// ④ 只有一个 provider：无提示直接用它
test("provider 解析④：配置里只有一个 provider 时无提示直接用它（不联网）", async () => {
  await withFakeHome({
    "sole-slot": fakeProviderEntry({ baseUrl: "https://sole.invalid/v1", apiKey: "sk-sole-not-secret", modelIds: ["k3", "odd-model"] }),
  }, async () => {
    const cfg = await loadRelayConfig();
    assert.equal(cfg.provider, "sole-slot");
    assert.equal(cfg.endpoint, "https://sole.invalid/v1");
    assert.equal(cfg.apiKey, "sk-sole-not-secret");
    assert.equal(cfg.model, "k3", "偏好表首位不在列表里 → 用列表里存在的那一项");
  });
});

// ⑤ 多 provider 且无任何提示：报错并列出候选
test("provider 解析⑤：多 provider 且无提示时报错，错误信息列出候选名与各自模型列表（不联网）", async () => {
  await withFakeHome(twoProviderFixture(), async () => {
    await assert.rejects(loadRelayConfig(), (error) => {
      assertListsCandidates(error.message, {
        names: ["alpha", "beta"],
        models: ["kimi-for-coding", "glm-5.3-flash-awq", "k3", "deepseek-flash"],
      });
      assert.match(error.message, /LLM_KIT_RELAY_PROVIDER/u, "错误信息要告诉人下一步用哪个环境变量");
      return true;
    });
  });
});

// ⑥ 偏好表与模型列表交集为空：报错，不静默回落
test("model 解析⑥：偏好表与 provider 模型列表交集为空时报错，不静默回落到列表外的名字（不联网）", async () => {
  await withFakeHome({
    "odd-slot": fakeProviderEntry({ baseUrl: "https://odd.invalid/v1", modelIds: ["only-weird-model", "another-one"] }),
  }, async () => {
    await assert.rejects(loadRelayConfig(), (error) => {
      assert.ok(/only-weird-model/.test(error.message) && /another-one/.test(error.message),
        `错误信息应列出可用模型：${error.message}`);
      for (const preference of DEMO_MODEL_PREFERENCES) {
        assert.ok(error.message.includes(preference), `错误信息应说明偏好表内容 ${preference}：${error.message}`);
        assert.ok(!error.message.includes(`model=${preference}`), "不得把偏好表里的名字当成结果");
      }
      assert.match(error.message, /LLM_KIT_MODEL/u, "错误信息要指路 LLM_KIT_MODEL");
      return true;
    });
  });

  // 显式 LLM_KIT_MODEL 优先：即便列表里没有也原样采用（用户指定的模型不静默换）
  await withFakeHome({
    "odd-slot": fakeProviderEntry({ baseUrl: "https://odd.invalid/v1", modelIds: ["only-weird-model"] }),
  }, async () => {
    process.env.LLM_KIT_MODEL = "explicitly-supplied";
    const cfg = await loadRelayConfig();
    assert.equal(cfg.model, "explicitly-supplied");
    assert.equal(cfg.provider, "odd-slot");
  });
});

/** ⑦ 静态断言：源码里不许再出现写死的 provider 槽位名 / 模型名回落 / 凭据字面量 */
function assertNoHardcodedProviderOrModel(src) {
  // 写死的 provider 槽位名（`providers["my-relay"]` 这种字面量下标）是本次腐化的根因
  assert.doesNotMatch(src, /providers\[\s*["'`]/u, "不得用字面量下标取 provider 槽位（providers[\"my-relay\"] 这类）");
  assert.doesNotMatch(src, /["']my-relay["']/u, "my-relay 只是某台机器上的槽位名，不许出现在源码里");
  // 写死的模型名回落（`model: process.env.LLM_KIT_MODEL ?? "kimi-for-coding"`）违反 AGENTS.md §8
  assert.doesNotMatch(src, /model:\s*process\.env\.LLM_KIT_MODEL\s*\?\?\s*["']/u,
    "模型名不许用 ?? \"字面量\" 回落；只能在 provider 的 models 列表里按偏好表求交");
  // 凭据不落本仓库（apiKeyFile 哲学）
  assert.doesNotMatch(src, /["']sk-[A-Za-z0-9-]{4,}["']/u, "不得把 sk- 开头的凭据字面量写进源码");
}

test("exec-demo：源码不写死 provider 槽位名与模型回落（静态断言，始终跑）", async () => {
  const src = await readFile(new URL("./exec-demo.js", import.meta.url), "utf8");
  assertNoHardcodedProviderOrModel(src);
  // 新增的两个解析入口必须在文件头「环境变量」注释里可查到
  for (const key of ["LLM_KIT_RELAY_PROVIDER", "LLM_KIT_RELAY_URL", "LLM_KIT_MODEL"]) {
    assert.ok(src.includes(key), `源码里应能找到配置解析入口 ${key}`);
  }
  assert.ok(Array.isArray(DEMO_MODEL_PREFERENCES) && DEMO_MODEL_PREFERENCES.length > 0,
    "demo 侧模型偏好表必须是显式声明的常量");
});

test("loadRelayConfig：models.json 可读且不含硬编码凭据", { skip: !E2E && "设 LLM_KIT_E2E=1" }, async () => {
  const src = await readFile(new URL("./exec-demo.js", import.meta.url), "utf8");
  assertNoHardcodedProviderOrModel(src);

  // 真实环境：槽位名随用户配置走，解析必须凭提示或单槽位规则，而不是抓一个死名字
  const modelsJson = JSON.parse(await readFile(join(homedir(), ".pi/agent/models.json"), "utf8"));
  const providers = modelsJson.providers ?? {};
  const names = Object.keys(providers);
  assert.ok(names.length >= 1, "真实 models.json 应至少有一个 provider 槽位");
  const saved = {};
  for (const key of RELAY_ENV_KEYS) saved[key] = process.env[key];
  try {
    for (const name of names) {
      process.env.LLM_KIT_RELAY_PROVIDER = name;
      delete process.env.LLM_KIT_RELAY_URL;
      delete process.env.LLM_KIT_MODEL;
      try {
        const cfg = await loadRelayConfig();
        assert.equal(cfg.provider, name);
        assert.ok(cfg.endpoint.startsWith("https://"), `provider ${name} 的 baseUrl 应是 https`);
        assert.ok(cfg.apiKey.length > 0, "apiKey 非空（值本身不打印）");
        assert.ok(cfg.model.length > 0);
        assert.ok((providers[name]?.models ?? []).some((m) => m.id === cfg.model),
          `解析出的模型 ${cfg.model} 必须在 provider ${name} 的 models 列表里`);
      } catch (error) {
        // 唯一合法失败形态：该槽位的模型列表与 demo 偏好无交集（真实环境里常见），
        // 此时必须列出该槽位的可用模型并指路 LLM_KIT_MODEL，而不是拖回一个写死名字。
        const available = (providers[name]?.models ?? []).map((m) => m.id);
        assert.match(error.message, /demo 偏好表/u, `真实槽位 ${name} 只允许「偏好无交集」这一种失败：${error.message}`);
        assert.ok(available.every((id) => error.message.includes(id)),
          `错误信息应列出 ${name} 的可用模型：${error.message}`);
        assert.match(error.message, /LLM_KIT_MODEL/u, "错误信息要指路 LLM_KIT_MODEL");
      }
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ---- 真实 LLM 场景（需 LLM_KIT_E2E=1）----

test("exec-demo：真实 LLM 多轮工具调用", { skip: !E2E && "设 LLM_KIT_E2E=1 才跑真实 relay", timeout: 300_000 }, async () => {
  const { result, store, runId } = await runExecDemo("列出当前目录的文件，告诉我这是一个什么项目");

  assert.ok(result.rounds >= 2, `应至少 2 轮（工具调用 + 终稿），实际 ${result.rounds}`);
  assert.equal(result.truncated, false);
  assert.ok(result.finalText.length > 0, "finalText 非空");

  const transcript = await store.load(runId);
  const toolResults = transcript.flatMap((r) => r.messages)
    .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
    .filter((b) => b.type === "tool_result");
  assert.ok(toolResults.length >= 1, "transcript 应含 tool_result");
  assert.ok(toolResults.every((b) => !b.is_error), `工具调用不应全部出错: ${toolResults[0]?.content}`);

  // 「exec 工具调用足迹存在」用现役 API 表达：直接看已加载 transcript 里的 tool_use 块
  // （recall 适配器已在 0.8.0 契约中退役，memory store 不再提供该方法）
  const calledTools = new Set(
    transcript.flatMap((r) => r.messages)
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .filter((b) => b.type === "tool_use")
      .map((b) => b.name),
  );
  assert.ok(calledTools.has("exec"),
    `transcript 的 tool_use 应含 exec 调用足迹，实际调用：${[...calledTools].join(",") || "（无）"}`);
});

test("exec-demo：小预算强制触发 fold-statistical 压缩", { skip: !E2E && "设 LLM_KIT_E2E=1", timeout: 300_000 }, async () => {
  // 构造一段早期对话历史（真实 user/assistant 文本轮），小预算下首轮即被折叠——
  // 不依赖模型的分轮行为，确定性触发
  const longText = "这是一段早期讨论的上下文占位文本，内容足够长以便超出压缩预算。".repeat(20);
  const { result, store, runId } = await runExecDemo(undefined, {
    compactBudgetTokens: 500, keepRounds: 1,
    initialMessages: [
      { role: "user", content: "项目背景确认：" + longText },
      { role: "assistant", content: "已了解背景。" + longText },
      { role: "user", content: "补充约束：" + longText },
      { role: "assistant", content: "约束已记录。" + longText },
      { role: "user", content: "列出当前目录的文件，简要总结" },
    ],
  });
  assert.ok(result.finalText.length > 0);
  assert.ok(result.compactionStats.length >= 1, "应至少发生一次压缩");
  assert.ok(result.compactionStats[0].compacted, "首次压缩应真实折叠轮次");
  assert.ok(result.compactionStats[0].foldedRounds >= 1);
  const transcript = await store.load(runId);
  const folded = transcript.filter((r) => r.folded);
  assert.ok(folded.length >= 1, "store 应有 folded 记录");
  assert.ok(folded[0].foldedPayload?.length >= 1, "foldedPayload 应含被折叠轮次原文");
});
