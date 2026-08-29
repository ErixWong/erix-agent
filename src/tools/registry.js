import { KitError } from "../providers/errors.js";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function clone(value) {
  return structuredClone(value);
}

function normalizeSchema(schema) {
  const result = clone(schema);
  if (result.inputSchema === undefined && result.input_schema !== undefined) {
    result.inputSchema = result.input_schema;
    delete result.input_schema;
  }
  return result;
}

function isType(value, type) {
  if (type === undefined) return true;
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

function validationError(schema, input) {
  const inputSchema = schema?.inputSchema ?? {};
  if (inputSchema.type && !isType(input, inputSchema.type)) {
    return `Tool ${schema.name} input must be of type ${inputSchema.type}`;
  }

  const value = inputSchema.type === "object" && input && typeof input === "object"
    ? input
    : input;
  for (const required of inputSchema.required ?? []) {
    if (value === null || typeof value !== "object" || !hasOwn(value, required)
      || value[required] === undefined) {
      return `Tool ${schema.name} input is missing required field "${required}"`;
    }
  }

  if (value === null || typeof value !== "object") return null;
  for (const [name, propertySchema] of Object.entries(inputSchema.properties ?? {})) {
    if (!hasOwn(value, name) || value[name] === undefined) continue;
    const property = value[name];
    if (!isType(property, propertySchema?.type)) {
      return `Tool ${schema.name} field "${name}" must be of type ${propertySchema.type}`;
    }
    if (Number.isFinite(propertySchema?.maxLength)
      && typeof property === "string"
      && property.length > propertySchema.maxLength) {
      return `Tool ${schema.name} field "${name}" exceeds maxLength ${propertySchema.maxLength}`;
    }
  }
  return null;
}

function validMaxLength(value) {
  return Number.isFinite(value) && value >= 0;
}

function mergePropertyConstraints(base = {}, overlay = {}) {
  const result = { ...base };
  if (base.type === undefined && overlay.type !== undefined) result.type = overlay.type;
  if (validMaxLength(overlay.maxLength)) {
    if (!validMaxLength(base.maxLength)) {
      result.maxLength = overlay.maxLength;
    } else {
      result.maxLength = Math.min(base.maxLength, overlay.maxLength);
    }
  }
  return result;
}

function mergeInputSchema(base = {}, overlay = {}) {
  const result = { ...base };
  const baseProperties = base.properties && typeof base.properties === "object"
    ? base.properties
    : {};
  const overlayProperties = overlay.properties && typeof overlay.properties === "object"
    ? overlay.properties
    : {};
  const properties = { ...baseProperties };
  for (const [name, property] of Object.entries(overlayProperties)) {
    if (hasOwn(baseProperties, name)) {
      properties[name] = mergePropertyConstraints(baseProperties[name], property);
    }
  }
  if (Object.keys(properties).length > 0) result.properties = properties;

  // Loosening overlays are ignored: the code schema remains the security floor.
  const baseRequired = Array.isArray(base.required) ? base.required : [];
  const overlayRequired = Array.isArray(overlay.required) ? overlay.required : [];
  if (baseRequired.length > 0 || overlayRequired.length > 0) {
    result.required = [...new Set([...baseRequired, ...overlayRequired])];
  }
  if (validMaxLength(overlay.maxLength)) {
    result.maxLength = validMaxLength(base.maxLength)
      ? Math.min(base.maxLength, overlay.maxLength)
      : overlay.maxLength;
  }
  return result;
}

function mergeSchema(base, overlay) {
  const normalizedBase = base ? normalizeSchema(base) : {};
  const normalizedOverlay = normalizeSchema(overlay);
  const result = { ...normalizedBase, name: normalizedOverlay.name };
  if (hasOwn(normalizedOverlay, "description")) {
    result.description = normalizedOverlay.description;
  }
  if (normalizedBase.inputSchema || normalizedOverlay.inputSchema) {
    result.inputSchema = mergeInputSchema(
      normalizedBase.inputSchema ?? {},
      normalizedOverlay.inputSchema ?? {},
    );
  }
  return result;
}

/**
 * Create a code-owned executor registry and provider resolver.
 *
 * @param {{executors:Record<string, Function>, schemas:object[]}} options
 * @returns {{executeTool:Function, resolveTools:Function}}
 */
export function createToolRegistry({ executors, schemas }) {
  const executorMap = executors && typeof executors === "object" ? executors : {};
  const schemaMap = new Map(
    (Array.isArray(schemas) ? schemas : []).map((schema) => [schema.name, normalizeSchema(schema)]),
  );
  let activeSchemaMap = schemaMap;

  async function executeTool(name, input, context) {
    const schema = activeSchemaMap.get(name);
    const executor = hasOwn(executorMap, name) ? executorMap[name] : undefined;
    if (!schema || typeof executor !== "function") {
      return `Unknown tool: ${name}`;
    }
    const error = validationError(schema, input);
    if (error) return error;
    return executor(input, context);
  }

  async function resolveTools(provider, sel) {
    if (typeof provider?.listTools !== "function") {
      throw new TypeError("Tool provider must implement listTools");
    }
    const providedSchemas = await provider.listTools(sel);
    if (!Array.isArray(providedSchemas)) {
      throw new TypeError("Tool provider listTools must return an array");
    }

    const resolved = [];
    for (const provided of providedSchemas) {
      const name = provided?.name;
      if (!hasOwn(executorMap, name) || typeof executorMap[name] !== "function") {
        throw new KitError("tool_unknown_executor", String(name));
      }
      const base = schemaMap.get(name);
      resolved.push(mergeSchema(base, provided));
    }
    activeSchemaMap = new Map(resolved.map((schema) => [schema.name, schema]));
    return resolved;
  }

  return { executeTool, resolveTools };
}
