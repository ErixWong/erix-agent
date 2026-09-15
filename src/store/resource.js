/**
 * @typedef {string|Uint8Array} Resource
 * @typedef {{locator:unknown,digest:string,display:string}} ResourceReference
 * @typedef {{
 *   put:(resource:Resource)=>Promise<ResourceReference>,
 *   get:(locator:unknown)=>Promise<Resource>
 * }} ResourceStore
 */

/**
 * Validate and normalize a ResourceStore boundary. The wrapper also rejects
 * malformed put references before they can enter a transcript or fold stub.
 *
 * @param {ResourceStore} store
 * @returns {ResourceStore}
 */
export function validateResourceStore(store) {
  if (!store || typeof store !== "object" || typeof store.put !== "function"
    || typeof store.get !== "function") {
    throw new TypeError("resource store must provide put and get methods");
  }
  return {
    async put(resource) {
      const reference = await store.put(resource);
      if (!reference || typeof reference !== "object"
        || reference.locator === undefined || reference.locator === null
        || typeof reference.digest !== "string" || reference.digest.length === 0
        || typeof reference.display !== "string" || reference.display.length === 0) {
        throw new TypeError(
          "resource store put must return { locator, digest, display }",
        );
      }
      return reference;
    },
    get(locator) {
      return store.get(locator);
    },
  };
}
