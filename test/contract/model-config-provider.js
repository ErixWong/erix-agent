// ModelConfigProvider 契约测试套件（ADR-001）
// 用法同 transcript-store.js。setup 负责把"default 槽 + 一个具名槽（带 apiKeyEnv 间接引用）"
// 配置好，并返回期望值的提供者。

import test from "node:test";
import assert from "node:assert/strict";

/**
 * @param {string} label 实现名
 * @param {() => Promise<{
 *   provider: object,
 *   slot: string,
 *   expect: {defaultModel: string, slotModel: string, materializedKey: string},
 * }>} setup
 *   setup 需保证：provider 有 default 槽（model=expect.defaultModel）与 expect.slot 槽
 *   （model=expect.slotModel，且该槽经间接引用可物化出 expect.materializedKey）。
 * @param {{mode:"throws", name:string, available:string[]}|{mode:"single-config", name:string}} unknownSlot
 *   **必填**（issue #518）。两种适配器形态对「未知槽名」的正确答案**不同**，不许用一条断言
 *   盖住两种语义（那正是 #518 之前那条假承诺的来源）：
 *   - `{mode:"throws", name, available}`：provider 是**槽位图**形态（`static` / `json-file`）。
 *     显式给出图里没有的槽名 ⇒ 启动期抛，错误点名该槽名并列出 `available` 里的槽位。
 *     **不许回落 default**（#518：宿主写错槽位 ⇒ 跑的是另一个模型，且永远不知道）。
 *   - `{mode:"single-config", name}`：provider 是**单配置**形态（`env`），槽名不选任何东西
 *     ⇒ 任何槽名都返回同一份配置。这是**形态差异**，不是「未知回落 default」。
 */
export function modelConfigProviderContract(label, setup, unknownSlot) {
  if (
    unknownSlot === null
    || typeof unknownSlot !== "object"
    || (unknownSlot.mode !== "throws" && unknownSlot.mode !== "single-config")
    || typeof unknownSlot.name !== "string"
  ) {
    throw new TypeError(
      `${label}: modelConfigProviderContract 的第三参 unknownSlot 必须显式声明形态——`
      + `{mode:"throws", name, available}（槽位图）或 {mode:"single-config", name}（单配置），`
      + `见 docs/host-consumer-contract.md 的「契约测试套件」一节（issue #518）`,
    );
  }

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

  // issue #518：两条按**形态**分开的用例，各自只钉自己那条腿。
  if (unknownSlot.mode === "throws") {
    test(`${label}: resolve(未知槽名) 抛错，并点名该槽名与可用槽位（槽位图形态，issue #518）`, async () => {
      const { provider } = await setup();
      await assert.rejects(
        provider.resolve(unknownSlot.name),
        (error) => {
          const message = String(error?.message ?? "");
          assert.ok(
            message.includes(unknownSlot.name),
            `错误没有点名槽名 "${unknownSlot.name}"：${message}`,
          );
          for (const available of unknownSlot.available) {
            assert.ok(
              message.includes(available),
              `错误没有列出可用槽位 "${available}"：${message}`,
            );
          }
          return true;
        },
        `显式未知槽名 "${unknownSlot.name}" 必须抛（#518 之前它会静默回落 default）`,
      );
    });
  } else {
    test(`${label}: resolve(任意槽名) 返回同一份配置（单配置形态——形态差异，不是「未知回落默认」）`, async () => {
      const { provider, expect } = await setup();
      // 单配置形态没有槽可选：名字选不中任何东西，也就没有「写错」可言。
      assert.equal((await provider.resolve(unknownSlot.name)).model, expect.defaultModel);
      assert.equal(expect.slotModel, expect.defaultModel);
    });
  }

  test(`${label}: apiKey 间接引用物化（ADR-001 一等公民）`, async () => {
    const { provider, slot, expect } = await setup();
    assert.equal((await provider.resolve(slot)).apiKey, expect.materializedKey);
  });
}
