import { resolveApiKey } from "./api-key.js";

function asSlots(configOrSlots) {
  if (
    configOrSlots
    && typeof configOrSlots === "object"
    && configOrSlots.slots
    && typeof configOrSlots.slots === "object"
    && !Array.isArray(configOrSlots.slots)
  ) {
    return configOrSlots.slots;
  }
  return { default: configOrSlots };
}

/**
 * Create a provider backed by one config or a set of named slot configs.
 *
 * @param {object|{slots: Record<string, object>}} configOrSlots
 * @returns {{resolve: (slot?:string) => Promise<object>}}
 */
export function createStaticModelConfigProvider(configOrSlots) {
  const slots = asSlots(configOrSlots);

  return {
    async resolve(slot = "default") {
      const config = slots[slot] ?? slots.default;
      if (config === undefined) {
        throw new Error(`No model config for slot "${slot}"`);
      }

      const apiKey = await resolveApiKey(config);
      return apiKey === undefined ? { ...config } : { ...config, apiKey };
    },
  };
}
