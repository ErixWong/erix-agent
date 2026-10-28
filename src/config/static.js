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
 * Slot names for error messages ("(none)" when the map is empty).
 *
 * @param {Record<string, unknown>} slots
 * @returns {string}
 */
function availableSlots(slots) {
  const names = Object.keys(slots);
  return names.length === 0 ? "(none)" : names.join(", ");
}

/**
 * Create a provider backed by one config or a set of named slot configs.
 *
 * Slot semantics (issue #518) — "no slot named" and "a slot named wrong" are two
 * different requests and must not collapse into the same answer:
 *
 *   - `resolve()` / `resolve(undefined)` / `resolve(null)`: the caller did not name
 *     a slot -> `default`, exactly as before;
 *   - `resolve("name")` where the slot map owns `name`: that slot;
 *   - `resolve("name")` where it does not own `name`: **throws**, naming the slot
 *     and listing the available ones. Before #518 this silently returned
 *     `slots.default`, so a host that misspelled a slot ran a different model and
 *     never found out (the failure #498 item 1 forbids).
 *
 * The lookup is `Object.hasOwn`, never `in` / `slots[name]`: prototype members
 * (`__proto__`, `constructor`) are unknown names and never resolve to a config.
 *
 * @param {object|{slots: Record<string, object>}} configOrSlots
 * @returns {{resolve: (slot?:string|null) => Promise<object>}}
 */
export function createStaticModelConfigProvider(configOrSlots) {
  const slots = asSlots(configOrSlots);

  return {
    async resolve(slot) {
      let requestedSlot;
      if (slot === undefined || slot === null) {
        // Not specified: the default slot, unchanged behavior.
        if (!Object.hasOwn(slots, "default")) {
          throw new Error(
            `No model config for slot "default"; available slots: ${availableSlots(slots)}`,
          );
        }
        requestedSlot = "default";
      } else if (typeof slot !== "string") {
        throw new TypeError(
          `model config slot must be a string, got ${typeof slot};`
          + ` available slots: ${availableSlots(slots)}`,
        );
      } else if (Object.hasOwn(slots, slot)) {
        requestedSlot = slot;
      } else {
        // Explicitly named, explicitly unknown: hard failure, no fallback.
        throw new Error(
          `No model config for slot "${slot}"; available slots: ${availableSlots(slots)}`,
        );
      }

      const config = slots[requestedSlot];
      if (config === undefined) {
        throw new Error(
          `No model config for slot "${requestedSlot}"; available slots: ${availableSlots(slots)}`,
        );
      }

      const apiKey = await resolveApiKey(config);
      return apiKey === undefined ? { ...config } : { ...config, apiKey };
    },
  };
}

/**
 * Wrap one plain model config in the resolver-shaped host contract.
 *
 * @param {object} config
 * @returns {{resolve:(slot?:string|null)=>Promise<object>}}
 */
export function createModelConfigResolver(config) {
  return createStaticModelConfigProvider(config);
}
