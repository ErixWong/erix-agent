import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateResourceStore } from "./resource.js";

function resourceBytes(resource) {
  if (typeof resource === "string") {
    return { bytes: Buffer.from(resource, "utf8"), kind: "text" };
  }
  if (resource instanceof Uint8Array) {
    return { bytes: Buffer.from(resource), kind: "bytes" };
  }
  throw new TypeError("resource must be a string or Uint8Array");
}

function digestFor(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function resourceError(message, code = "RESOURCE_NOT_FOUND") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function locatorId(locator) {
  if (!locator || typeof locator !== "object" || Array.isArray(locator)
    || typeof locator.id !== "string" || !/^resource-[0-9a-f-]+$/u.test(locator.id)) {
    throw resourceError("unknown resource locator");
  }
  return locator.id;
}

/**
 * Create the built-in filesystem ResourceStore.
 *
 * The locator is an opaque object to library consumers. Only this adapter
 * interprets it; `display` is the host-facing rendering string.
 *
 * @param {{dir:string}} options
 * @returns {{put:(resource:string|Uint8Array)=>Promise<{locator:object,digest:string,display:string}>,get:(locator:object)=>Promise<string|Uint8Array>}}
 */
export function createFileResourceStore({ dir } = {}) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new TypeError("resource store dir must be a non-empty string");
  }

  const pathsFor = (id) => ({
    data: join(dir, `${id}.bin`),
    metadata: join(dir, `${id}.json`),
  });

  return validateResourceStore({
    async put(resource) {
      const { bytes, kind } = resourceBytes(resource);
      const id = `resource-${randomUUID()}`;
      const { data, metadata } = pathsFor(id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const digest = digestFor(bytes);
      const temporary = `${data}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, data);
      await writeFile(
        metadata,
        `${JSON.stringify({ kind, digest })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      return {
        locator: { id },
        digest,
        display: `resource:${id}`,
      };
    },

    async get(locator) {
      const id = locatorId(locator);
      const { data, metadata } = pathsFor(id);
      let descriptor;
      try {
        descriptor = JSON.parse(await readFile(metadata, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") throw resourceError(`resource not found: ${id}`);
        throw error;
      }
      let bytes;
      try {
        bytes = await readFile(data);
      } catch (error) {
        if (error?.code === "ENOENT") throw resourceError(`resource not found: ${id}`);
        throw error;
      }
      if (digestFor(bytes) !== descriptor.digest) {
        throw resourceError(`resource digest mismatch: ${id}`, "RESOURCE_INTEGRITY_ERROR");
      }
      return descriptor.kind === "text" ? bytes.toString("utf8") : new Uint8Array(bytes);
    },
  });
}
