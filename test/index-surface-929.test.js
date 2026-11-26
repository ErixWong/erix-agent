// issue #929：从包入口摘掉「配置间接层」5 个导出，留「连接链」3 个。本文件钉两格判据：
//   ① 反向格：src/index.js 不再导出那 5 个名字（逐名点名，且逐个断言独立成条，改一个红一个）；
//   ② 正向格：那 3 个仍然导出、且能真的连上——一条离线格用假 fetchImpl 走
//      `loadModelSlot → createProviderForSlot → chat` 全链（假上游收得到请求、返回被收下）。
//
// 模块没删（src/config/{static,json-file,api-key}.js、src/loop/config-namespace.js 仍在原地），
// 摘的只是包入口的可达性；`package.json` 的 exports 只有 `.` / `./tools` / `./contract-tests`，
// 从 `.` 摘掉即等于包外不可达。
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import * as index from "../src/index.js";
import { makeTmp } from "./helpers/tmp.js";

// 从入口摘掉的 5 个名字（逐名点名：一个 name 一条断言，不合并）。
const DROPPED = [
  "CONFIG_LEAF_BINDING",
  "createStaticModelConfigProvider",
  "createModelConfigResolver",
  "createJsonFileModelConfigProvider",
  "resolveApiKey",
];

// 仍然保留的「连接链」3 个。
const KEPT = ["createOpenAIProvider", "loadModelSlot", "createProviderForSlot"];

test(`#929 反向格：包入口不再导出这 ${DROPPED.length} 个配置间接层名字`, () => {
  for (const name of DROPPED) {
    assert.equal(
      name in index,
      false,
      `${name} 已随 #929 从包入口摘掉，不应再出现在 src/index.js 的导出面上`,
    );
    assert.equal(index[name], undefined, `${name} 的导出值应为 undefined`);
  }
});

test("#929 正向格：连接链 3 个名字仍在入口导出且可调用", () => {
  for (const name of KEPT) {
    assert.equal(typeof index[name], "function", `${name} 必须仍从 src/index.js 导出为函数`);
  }
});

test("#929 正向格：loadModelSlot → createProviderForSlot → chat 全链（离线假 fetchImpl）", async () => {
  const dir = await makeTmp("erix-929-chain-");
  try {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      slots: {
        default: {
          protocol: "openai",
          endpoint: "https://relay.example.invalid/v1",
          model: "chain-model",
          apiKey: "sk-chain-not-secret",
          contextWindowTokens: 128_000,
          maxOutputTokens: 2_048,
        },
      },
    }), "utf8");

    // 1) loadModelSlot：从路径取 slot 定义（收路径参数，不写死 ~/.erix）。
    const loaded = await index.loadModelSlot({ configPath, env: {}, home: "/nonexistent-home" });
    assert.equal(loaded.slot.model, "chain-model");
    assert.equal(loaded.slot.endpoint, "https://relay.example.invalid/v1");
    assert.equal(loaded.slot.apiKey, "sk-chain-not-secret");

    // 2) createProviderForSlot：slot → provider（真 createOpenAIProvider 实例）。
    //    假 fetchImpl 塞进 slot：createProviderForSlot 会把整个 slot 摊平给 createOpenAIProvider，
    //    fetchImpl 随之落到传输层（issue #652 的注入口），于是整条链离线可跑。
    const requests = [];
    const provider = index.createProviderForSlot({
      ...loaded.slot,
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), body: JSON.parse(String(options?.body ?? "{}")) });
        return {
          status: 200,
          async text() {
            return JSON.stringify({
              choices: [{ message: { content: "chain-ok", role: "assistant" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 3, completion_tokens: 2 },
            });
          },
        };
      },
    });
    assert.equal(typeof provider.chat, "function");

    // 3) chat：真的走到假上游、请求体带上了配置里的模型名、返回被收下。
    const result = await provider.chat({
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    });
    assert.equal(requests.length, 1, "假 fetchImpl 必须真被调用一次");
    assert.ok(requests[0].url.endsWith("/chat/completions"), `请求应落在 chat/completions，实际：${requests[0].url}`);
    assert.equal(requests[0].body.model, "chain-model", "请求体模型名必须来自配置");
    assert.equal(result.content?.find((block) => block.type === "text")?.text, "chain-ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
