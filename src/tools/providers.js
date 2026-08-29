import fs from "node:fs/promises";
import pathModule from "node:path";

function clone(value) {
  return structuredClone(value);
}

function normalizeSchema(schema) {
  const result = { ...schema };
  if (result.inputSchema === undefined && result.input_schema !== undefined) {
    result.inputSchema = result.input_schema;
    delete result.input_schema;
  }
  return result;
}

function schemaList(value) {
  return Array.isArray(value) ? value.map(normalizeSchema) : [];
}

function selectedSet(sets, sel) {
  const name = sel?.set;
  return schemaList(sets?.[name] ?? sets?.default);
}

/**
 * @param {{sets:Record<string, object[]>}} options
 * @returns {{listTools:(sel?:{set?:string})=>Promise<object[]>}}
 */
export function createStaticToolProvider({ sets }) {
  return {
    async listTools(sel) {
      return clone(selectedSet(sets ?? {}, sel));
    },
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function mergeSchemaArrays(left, right) {
  const merged = new Map(left.map((schema) => [schema.name, schema]));
  for (const schema of right) merged.set(schema.name, schema);
  return [...merged.values()];
}

async function readSets(filePath) {
  const info = await fs.stat(filePath);
  if (info.isFile()) {
    const config = await readJson(filePath);
    return config?.sets ?? {};
  }
  if (!info.isDirectory()) return {};

  const preferred = pathModule.join(filePath, "tools.json");
  let files;
  try {
    await fs.stat(preferred);
    files = [preferred];
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    files = (await fs.readdir(filePath))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => pathModule.join(filePath, name));
  }

  const sets = {};
  for (const file of files) {
    const config = await readJson(file);
    for (const [name, schemas] of Object.entries(config?.sets ?? {})) {
      sets[name] = mergeSchemaArrays(sets[name] ?? [], schemaList(schemas));
    }
  }
  return sets;
}

/**
 * @param {{path:string}} options
 * @returns {{listTools:(sel?:{set?:string})=>Promise<object[]>}}
 */
export function createJsonFileToolProvider({ path: filePath }) {
  return {
    async listTools(sel) {
      const sets = await readSets(filePath);
      return clone(selectedSet(sets, sel));
    },
  };
}

function mergeProviderSchema(base, overlay) {
  const result = { ...base, ...overlay, name: overlay.name };
  if (base.description !== undefined && overlay.description === undefined) {
    result.description = base.description;
  }
  if (base.inputSchema || overlay.inputSchema) {
    const baseProperties = base.inputSchema?.properties ?? {};
    const overlayProperties = overlay.inputSchema?.properties ?? {};
    result.inputSchema = {
      ...(base.inputSchema ?? {}),
      ...(overlay.inputSchema ?? {}),
      properties: {
        ...baseProperties,
        ...Object.fromEntries(Object.entries(overlayProperties).map(([name, property]) => [
          name,
          { ...(baseProperties[name] ?? {}), ...property },
        ])),
      },
    };
    if (overlay.inputSchema?.required === undefined && base.inputSchema?.required !== undefined) {
      result.inputSchema.required = [...base.inputSchema.required];
    }
  }
  return normalizeSchema(result);
}

/**
 * @param {{providers:object[]}} options
 * @returns {{listTools:(sel?:{set?:string})=>Promise<object[]>}}
 */
export function createCompositeToolProvider({ providers }) {
  const providerList = Array.isArray(providers) ? providers : [];
  return {
    async listTools(sel) {
      const merged = new Map();
      for (const provider of providerList) {
        if (typeof provider?.listTools !== "function") {
          throw new TypeError("Composite provider entries must implement listTools");
        }
        const schemas = await provider.listTools(sel);
        if (!Array.isArray(schemas)) {
          throw new TypeError("Tool provider listTools must return an array");
        }
        for (const schema of schemas) {
          const normalized = normalizeSchema(schema);
          merged.set(
            normalized.name,
            merged.has(normalized.name)
              ? mergeProviderSchema(merged.get(normalized.name), normalized)
              : normalized,
          );
        }
      }
      return clone([...merged.values()]);
    },
  };
}
