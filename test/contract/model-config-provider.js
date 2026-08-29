// ModelConfigProvider 契约测试套件（ADR-001）
// 用法同 transcript-store.js。setup 负责把"default 槽 + 一个具名槽（带 apiKeyEnv 间接引用）"
// 配置好，并返回期望值的提供者。

import test from "node:test";
import assert from "node:assert/strict";

/**
 * @param {string} label 实现名
 * @param {() => Promise<{provider: object, slot: string, expect: {defaultModel: string, slotModel: string, materializedKey: string}}>} setup
 *   setup 需保证：provider 有 default 槽（model=expect.defaultModel）与 expect.slot 槽
 *   （model=expect.slotModel，且该槽经间接引用可物化出 expect.materializedKey）。
 */
export function modelConfigProviderContract(label, setup) {
  test(`${label}: resolve() 返回 default 槽 ModelConfig`, async () => {
    const { provider, expect } = await setup();
    const config = await provider.resolve();
    assert.equal(config.model, expect.defaultModel);
    assert.ok(config.protocol === "openai" || config.protocol === "anthropic");
  });

  test(`${label}: resolve(slot) 返回具名槽`, async () => {
    const { provider, slot, expect } = await setup();
    assert.equal((await provider.resolve(slot)).model, expect.slotModel);
  });

  test(`${label}: resolve(不存在的槽) 回落 default`, async () => {
    const { provider, expect } = await setup();
    assert.equal((await provider.resolve("no-such-slot")).model, expect.defaultModel);
  });

  test(`${label}: apiKey 间接引用物化（ADR-001 一等公民）`, async () => {
    const { provider, slot, expect } = await setup();
    assert.equal((await provider.resolve(slot)).apiKey, expect.materializedKey);
  });
}
