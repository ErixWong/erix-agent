import { readFile } from "node:fs/promises";

import { resolveApiKey } from "./api-key.js";
import { KitError } from "../providers/errors.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Create a model config provider backed by a JSON file.
 *
 * @param {{path:string}} options
 * @returns {{resolve: (slot?:string) => Promise<object>}}
 */
export function createJsonFileModelConfigProvider({ path } = {}) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("json-file model config path must be a non-empty string");
  }

  return {
    async resolve(slot = "default") {
      const requestedSlot = slot ?? "default";
      const parsed = JSON.parse(await readFile(path, "utf8"));
      const slots = parsed?.slots;
      const config = isRecord(slots) ? slots[requestedSlot] ?? slots.default : undefined;

      if (!isRecord(config)) {
        throw new KitError("unknown", `配置槽位不存在: ${requestedSlot}`);
      }

      const apiKey = await resolveApiKey(config);
      return apiKey === undefined ? { ...config } : { ...config, apiKey };
    },
  };
}
