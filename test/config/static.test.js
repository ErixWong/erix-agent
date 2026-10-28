import test from "node:test";
import assert from "node:assert/strict";

import { createStaticModelConfigProvider } from "../../src/config/static.js";
import { modelConfigProviderContract } from "../contract/model-config-provider.js";

const KEY_ENV = `ERIX_STATIC_CONTRACT_KEY_${process.pid}`;
process.env[KEY_ENV] = "static-contract-secret";

modelConfigProviderContract("static", async () => ({
  provider: createStaticModelConfigProvider({
    slots: {
      default: { protocol: "anthropic", endpoint: "https://example.invalid", model: "default-model" },
      audit: { protocol: "openai", endpoint: "https://example.invalid", model: "audit-model", apiKeyEnv: KEY_ENV },
    },
  }),
  slot: "audit",
  expect: { defaultModel: "default-model", slotModel: "audit-model", materializedKey: "static-contract-secret" },
}), {
  // issue #518: static is a slot map — an explicit unknown name must throw.
  mode: "throws",
  name: "no-such-slot",
  available: ["default", "audit"],
});

// ---- issue #518: "no slot named" and "a slot named wrong" are different requests ----

// Positive pin: omitting the slot still lands on `default`. This case exists so that
// "explicit unknown throws" can never be widened into "everything throws".
test("static provider: an omitted slot resolves the default slot (issue #518, unchanged)", async () => {
  const provider = createStaticModelConfigProvider({
    slots: {
      default: { model: "default-model" },
      audit: { model: "audit-model" },
    },
  });
  assert.equal((await provider.resolve()).model, "default-model");
  assert.equal((await provider.resolve(undefined)).model, "default-model");
  assert.equal((await provider.resolve(null)).model, "default-model");
});

// Negative pin: an explicit name the slot map does not own throws — it must not fall
// back to `default` (that was #518: the host got a different model and no error).
test("static provider: an explicit unknown slot throws, naming the slot and the available slots (issue #518)", async () => {
  const provider = createStaticModelConfigProvider({
    slots: {
      default: { model: "default-model" },
      audit: { model: "audit-model" },
    },
  });
  await assert.rejects(
    provider.resolve("audti"),
    (error) => {
      assert.match(String(error?.message), /"audti"/);
      assert.match(String(error?.message), /available slots: default, audit/);
      return true;
    },
  );
  // A non-string name is an explicit (and wrong) request too, never a silent `default`.
  await assert.rejects(
    provider.resolve(42),
    (error) => error instanceof TypeError && /must be a string/.test(String(error?.message)),
  );
});

// `Object.hasOwn` guard, restated under #518 semantics: prototype members are unknown
// names (they used to fall back to `default`; now they are the same hard error as any
// other name the map does not own) and never resolve to an `Object.prototype` member.
test("static provider: prototype property names are unknown slots, never a config", async () => {
  const provider = createStaticModelConfigProvider({
    slots: { default: { model: "default-model" } },
  });
  for (const name of ["__proto__", "constructor"]) {
    await assert.rejects(
      provider.resolve(name),
      (error) => {
        assert.match(String(error?.message), new RegExp(`"${name}"`));
        assert.match(String(error?.message), /available slots: default/);
        return true;
      },
    );
  }
});
