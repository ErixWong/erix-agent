import { readFile } from "node:fs/promises";

import { resolveApiKey } from "./api-key.js";
import { KitError } from "../providers/errors.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
 * Create a model config provider backed by a JSON file.
 *
 * Slot semantics (issue #518) — "no slot named" and "a slot named wrong" are two
 * different requests and must not collapse into the same answer:
 *
 *   - `resolve()` / `resolve(undefined)` / `resolve(null)`: the caller did not name
 *     a slot -> `default`, exactly as before;
 *   - `resolve("name")` where `slots` owns `name`: that slot;
 *   - `resolve("name")` where it does not own `name`: **throws**, naming the slot
 *     and listing the available ones. Before #518 this silently returned
 *     `slots.default`, so a host that misspelled a slot ran a different model and
 *     never found out (the failure #498 item 1 forbids).
 *
 * The lookup is `Object.hasOwn`, never `in` / `slots[name]`: prototype members
 * (`__proto__`, `constructor`) are unknown names and never resolve to a config.
 *
 * @param {{path:string}} options
 * @returns {{resolve: (slot?:string|null) => Promise<object>}}
 */
export function createJsonFileModelConfigProvider({ path } = {}) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("json-file model config path must be a non-empty string");
  }

  return {
    async resolve(slot) {
      const requestedSlot = slot === undefined || slot === null ? "default" : slot;
      const parsed = JSON.parse(await readFile(path, "utf8"));
      const slots = parsed?.slots;
      if (!isRecord(slots)) {
        throw new KitError("unknown", `配置槽位不存在: ${requestedSlot}`);
      }

      if (typeof requestedSlot !== "string") {
        throw new KitError(
          "unknown",
          `配置槽位不存在: ${String(requestedSlot)}（可用槽位: ${availableSlots(slots)}）`,
        );
      }
      if (!Object.hasOwn(slots, requestedSlot)) {
        // Explicitly named, explicitly unknown: hard failure, no fallback.
        throw new KitError(
          "unknown",
          `配置槽位不存在: ${requestedSlot}（可用槽位: ${availableSlots(slots)}）`,
        );
      }

      const config = slots[requestedSlot];
      if (!isRecord(config)) {
        throw new KitError("unknown", `配置槽位不存在: ${requestedSlot}`);
      }

      const apiKey = await resolveApiKey(config);
      return apiKey === undefined ? { ...config } : { ...config, apiKey };
    },
  };
}
