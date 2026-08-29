import fs from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TREE_ENTRIES = 500;

function normalizeNonNegativeInteger(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function splitLines(text) {
  if (text === "") return [];
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function isMasked(error) {
  return error?.code === "path_masked";
}

function readablePath(jail, value) {
  try {
    jail.assertReadable(value);
  } catch (error) {
    if (isMasked(error)) return null;
    throw error;
  }
  return jail.resolve(value);
}

function normalizeSchema(schema) {
  const result = { ...schema };
  if (result.inputSchema === undefined && result.input_schema !== undefined) {
    result.inputSchema = result.input_schema;
    delete result.input_schema;
  }
  return result;
}

const schemas = [
  {
    name: "readFile",
    description: "Read a text file by line range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "rg",
    description: "Recursively search text files with a regular expression.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        maxResults: { type: "integer" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "tree",
    description: "List a directory tree.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        depth: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "writeFile",
    description: "Write UTF-8 text inside a writable jail subtree.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
].map(normalizeSchema);

/**
 * Create reference filesystem tools constrained by a jail.
 *
 * @param {{resolve:Function, resolveForWrite:Function, assertReadable:Function}} jail
 * @returns {{schemas:object[], executors:Record<string, Function>}}
 */
export function createFileTools(jail) {
  async function readFile({ path: filePath, offset = 0, limit = 200 }) {
    jail.assertReadable(filePath);
    const resolvedPath = jail.resolve(filePath);
    const text = fs.readFileSync(resolvedPath, "utf8");
    const lines = splitLines(text);
    const start = normalizeNonNegativeInteger(offset, 0);
    const count = normalizeNonNegativeInteger(limit, 200);
    const selected = lines
      .slice(start, start + count)
      .map((line, index) => `${start + index + 1}: ${line}`);

    if (start + count < lines.length) {
      selected.push(`[共 ${lines.length} 行，offset=${start + count} 继续]`);
    }
    return selected.join("\n");
  }

  async function rg({ pattern, path: searchPath = ".", maxResults = 50 }) {
    const expression = new RegExp(String(pattern));
    const resultLimit = normalizeNonNegativeInteger(maxResults, 50);
    const resolvedSearchPath = readablePath(jail, searchPath);
    if (resolvedSearchPath === null) return "";
    const displayBase = jail.resolve(".");
    const results = [];
    const visitedDirectories = new Set();

    const displayName = (filePath) => {
      const relative = path.relative(displayBase, filePath);
      return (relative || path.basename(filePath)).split(path.sep).join("/");
    };

    const searchFile = (filePath, stat) => {
      if (results.length >= resultLimit || stat.size > MAX_FILE_BYTES) return;
      const bytes = fs.readFileSync(filePath);
      if (bytes.includes(0)) return;
      const lines = splitLines(bytes.toString("utf8"));
      for (let index = 0; index < lines.length; index += 1) {
        if (!expression.test(lines[index])) continue;
        results.push(`${displayName(filePath)}:${index + 1}:${lines[index]}`);
        if (results.length >= resultLimit) return;
      }
    };

    const visit = (lexicalPath) => {
      if (results.length >= resultLimit) return;
      const currentPath = readablePath(jail, lexicalPath);
      if (currentPath === null) return;
      const stat = fs.statSync(currentPath);
      if (stat.isFile()) {
        searchFile(currentPath, stat);
        return;
      }
      if (!stat.isDirectory() || visitedDirectories.has(currentPath)) return;
      visitedDirectories.add(currentPath);

      const entries = fs.readdirSync(currentPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (results.length >= resultLimit) return;
        visit(path.join(currentPath, entry.name));
      }
    };

    visit(resolvedSearchPath);
    return results.join("\n");
  }

  async function tree({ path: treePath = ".", depth = 3 }) {
    const resolvedTreePath = readablePath(jail, treePath);
    if (resolvedTreePath === null) return "";
    const maxDepth = normalizeNonNegativeInteger(depth, 3);
    const rootStat = fs.statSync(resolvedTreePath);
    const rootLabel = treePath === "." ? "." : path.basename(resolvedTreePath);
    const lines = [rootLabel + (rootStat.isDirectory() ? "/" : "")];
    const visitedDirectories = new Set();
    let entries = 1;

    const visit = (currentPath, currentDepth) => {
      if (entries >= MAX_TREE_ENTRIES || currentDepth >= maxDepth) return;
      if (!fs.statSync(currentPath).isDirectory()) return;
      if (visitedDirectories.has(currentPath)) return;
      visitedDirectories.add(currentPath);

      const children = fs.readdirSync(currentPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (entries >= MAX_TREE_ENTRIES) return;
        const childPath = path.join(currentPath, child.name);
        const readable = readablePath(jail, childPath);
        if (readable === null) continue;
        const childStat = fs.statSync(readable);
        lines.push(`${"  ".repeat(currentDepth + 1)}${child.name}${childStat.isDirectory() ? "/" : ""}`);
        entries += 1;
        if (childStat.isDirectory()) visit(readable, currentDepth + 1);
      }
    };

    if (rootStat.isDirectory()) {
      visit(resolvedTreePath, 0);
    }
    return lines.join("\n");
  }

  async function writeFile({ path: filePath, content }) {
    if (typeof content !== "string") {
      throw new TypeError("writeFile content must be a string");
    }
    const target = jail.resolveForWrite(filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const finalTarget = jail.resolveForWrite(filePath);
    fs.writeFileSync(finalTarget, content, "utf8");
    return Buffer.byteLength(content, "utf8");
  }

  return {
    schemas: schemas.map((schema) => structuredClone(schema)),
    executors: { readFile, rg, tree, writeFile },
  };
}
