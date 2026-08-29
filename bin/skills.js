import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createToolRegistry } from "../src/tools/registry.js";

const DEFAULT_ENTRYPOINT = "skill.mjs";

function isDirectory(directory) {
  try {
    return statSync(directory).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function errorMessage(error) {
  return error?.message ?? String(error);
}

function normalizeRoot(directory) {
  return path.resolve(String(directory));
}

function assertEntrypoint(root, entrypoint) {
  if (typeof entrypoint !== "string" || entrypoint.trim() === "") {
    throw new Error("技能 entrypoint 必须是非空相对路径");
  }
  if (path.isAbsolute(entrypoint)) {
    throw new Error(`技能 entrypoint 必须是相对路径：${entrypoint}`);
  }

  const normalized = path.normalize(entrypoint);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`技能 entrypoint 逃逸技能目录：${entrypoint}`);
  }

  const entrypointPath = path.resolve(root, normalized);
  if (!existsSync(entrypointPath)) {
    throw new Error(`技能 entrypoint 不存在：${entrypoint}`);
  }
  return entrypoint;
}

function validateTools(tools) {
  if (!Array.isArray(tools)) {
    throw new Error("技能 tools 必须是数组");
  }
  if (tools.length === 0) {
    throw new Error("技能 tools 不能为空");
  }

  const names = new Set();
  for (const [index, tool] of tools.entries()) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      throw new Error(`技能 tools[${index}] 必须是对象`);
    }
    if (typeof tool.name !== "string" || tool.name.trim() === "") {
      throw new Error(`技能 tools[${index}].name 必须是非空字符串`);
    }
    if (names.has(tool.name)) {
      throw new Error(`技能工具名称重复：${tool.name}`);
    }
    names.add(tool.name);

    if (
      !Object.prototype.hasOwnProperty.call(tool, "inputSchema")
      || !tool.inputSchema
      || typeof tool.inputSchema !== "object"
      || Array.isArray(tool.inputSchema)
    ) {
      throw new Error(`技能 tools[${index}].inputSchema 必须存在且为对象`);
    }
    if (tool.description !== undefined && typeof tool.description !== "string") {
      throw new Error(`技能 tools[${index}].description 必须是字符串`);
    }
  }
  return tools;
}

function validateDefinition(definition, root) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new Error("技能定义必须是对象");
  }
  if (definition.schema_version !== 1) {
    throw new Error(`不支持的技能 schema_version：${definition.schema_version}`);
  }
  if (!definition.skill || typeof definition.skill !== "object" || Array.isArray(definition.skill)) {
    throw new Error("技能定义必须包含 skill 对象");
  }

  const skillId = definition.skill.id;
  if (typeof skillId !== "string" || skillId.trim() === "") {
    throw new Error("技能 skill.id 必须是非空字符串");
  }
  const entrypoint = assertEntrypoint(root, definition.skill.entrypoint);
  const tools = validateTools(definition.tools);
  return { skillId, entrypoint, tools };
}

async function importSkillModule(root) {
  const modulePath = path.join(root, DEFAULT_ENTRYPOINT);
  if (!existsSync(modulePath)) {
    throw new Error(`技能入口文件不存在：${DEFAULT_ENTRYPOINT}`);
  }
  return import(pathToFileURL(modulePath).href);
}

async function loadSkillWithModule(dir) {
  const root = normalizeRoot(dir);
  const skillModule = await importSkillModule(root);

  if (typeof skillModule.getSkillDefinition === "function") {
    const definition = await skillModule.getSkillDefinition();
    const loaded = validateDefinition(definition, root);
    return { ...loaded, module: skillModule };
  }

  if (typeof skillModule.getTools === "function") {
    const tools = validateTools(await skillModule.getTools());
    return {
      skillId: path.basename(root),
      entrypoint: DEFAULT_ENTRYPOINT,
      tools,
      module: skillModule,
    };
  }

  throw new Error("技能模块必须导出 getSkillDefinition() 或 getTools()");
}

/**
 * Return the existing global and project skill directories.
 *
 * `skillsDir` is an explicit single-directory override used by the CLI.
 */
export function skillDirectories({
  home = homedir(),
  cwd = process.cwd(),
  skillsDir,
} = {}) {
  const candidates = skillsDir === undefined
    ? [
      path.join(normalizeRoot(home), ".erix", "skills"),
      path.join(normalizeRoot(cwd), ".erix", "skills"),
    ]
    : [path.resolve(normalizeRoot(cwd), String(skillsDir))];

  return [...new Set(candidates.map(normalizeRoot))].filter(isDirectory);
}

/**
 * Discover first-level skill directories. Project entries replace global
 * entries with the same directory id.
 */
export function discoverSkills({ home, cwd, skillsDir } = {}) {
  const discovered = new Map();
  for (const directory of skillDirectories({ home, cwd, skillsDir })) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        discovered.set(entry.name, {
          dir: path.join(directory, entry.name),
          id: entry.name,
        });
      }
    }
  }
  return [...discovered.values()];
}

export async function loadSkill(dir) {
  const loaded = await loadSkillWithModule(dir);
  return {
    skillId: loaded.skillId,
    entrypoint: loaded.entrypoint,
    tools: loaded.tools,
  };
}

export async function loadAllSkills({ home, cwd, skillsDir } = {}) {
  const skills = [];
  const errors = [];
  for (const candidate of discoverSkills({ home, cwd, skillsDir })) {
    try {
      const loaded = await loadSkill(candidate.dir);
      skills.push({
        skillId: loaded.skillId,
        tools: loaded.tools,
        dir: candidate.dir,
      });
    } catch (error) {
      errors.push({
        skillId: candidate.id,
        dir: candidate.dir,
        error: errorMessage(error),
      });
    }
  }
  return { skills, errors };
}

export async function buildSkillTools({
  home,
  cwd,
  skillsDir,
  builtinNames = [],
} = {}) {
  const loaded = await loadAllSkills({ home, cwd, skillsDir });
  const errors = [...loaded.errors];
  const builtinNameSet = new Set(
    builtinNames instanceof Set
      ? builtinNames
      : Array.isArray(builtinNames) ? builtinNames : [],
  );
  const usedNames = new Set(builtinNameSet);
  const schemas = [];
  const executors = {};

  for (const skill of loaded.skills) {
    const conflictNames = skill.tools
      .map((tool) => tool.name)
      .filter((name) => usedNames.has(name));
    if (conflictNames.length > 0) {
      errors.push({
        skillId: skill.skillId,
        dir: skill.dir,
        error: `工具名冲突：${conflictNames.join("、")}`,
      });
      continue;
    }

    let skillModule;
    try {
      skillModule = await importSkillModule(skill.dir);
    } catch (error) {
      errors.push({
        skillId: skill.skillId,
        dir: skill.dir,
        error: errorMessage(error),
      });
      continue;
    }

    const missingExecutors = skill.tools
      .map((tool) => tool.name)
      .filter((name) => typeof skillModule[name] !== "function");
    if (missingExecutors.length > 0) {
      errors.push({
        skillId: skill.skillId,
        dir: skill.dir,
        error: `技能模块缺少工具执行函数：${missingExecutors.join("、")}`,
      });
      continue;
    }

    for (const tool of skill.tools) {
      usedNames.add(tool.name);
      schemas.push(tool);
      executors[tool.name] = (input) => skillModule[tool.name](input);
    }
  }

  const registry = createToolRegistry({ executors, schemas });
  return {
    tools: schemas,
    executeTool: registry.executeTool,
    errors,
  };
}
