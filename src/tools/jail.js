import fs from "node:fs";
import path from "node:path";

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative));
}

function realpathWithMissing(absolutePath) {
  let current = absolutePath;
  const missing = [];

  while (true) {
    try {
      const existing = fs.realpathSync(current);
      return path.join(existing, ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export class JailError extends Error {
  /**
   * @param {string} [code]
   * @param {string} [message]
   */
  constructor(code = "jail_violation", message = code) {
    super(message);
    this.name = "JailError";
    this.code = code;
  }
}

/**
 * Create a filesystem path jail.
 *
 * @param {{root:string, writable?:string[], maskedPaths?:string[]}} options
 * @returns {{
 *   resolve:(p:string)=>string,
 *   resolveForWrite:(p:string)=>string,
 *   assertReadable:(p:string)=>string
 * }}
 */
export function createJail({ root, writable = [], maskedPaths = [] }) {
  const rootPath = fs.realpathSync(path.resolve(root));

  const resolve = (value) => {
    const lexicalPath = path.resolve(rootPath, value);
    const resolvedPath = realpathWithMissing(lexicalPath);
    if (!isWithin(rootPath, resolvedPath)) {
      throw new JailError(
        "path_escapes_root",
        `Path escapes jail root: ${value}`,
      );
    }
    return resolvedPath;
  };

  const writableRoots = (Array.isArray(writable) ? writable : [])
    .map((entry) => resolve(entry));
  const maskedRoots = (Array.isArray(maskedPaths) ? maskedPaths : [])
    .map((entry) => resolve(entry));

  const resolveForWrite = (value) => {
    const resolvedPath = resolve(value);
    if (!writableRoots.some((writableRoot) => isWithin(writableRoot, resolvedPath))) {
      throw new JailError(
        "path_not_writable",
        `Path is not writable: ${value}`,
      );
    }
    return resolvedPath;
  };

  const assertReadable = (value) => {
    const resolvedPath = resolve(value);
    if (maskedRoots.some((maskedRoot) => isWithin(maskedRoot, resolvedPath))) {
      throw new JailError(
        "path_masked",
        `Path is masked: ${value}`,
      );
    }
    return resolvedPath;
  };

  return { resolve, resolveForWrite, assertReadable };
}
