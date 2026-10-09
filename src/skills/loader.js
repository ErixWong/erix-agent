// 技能包（skill package）发现 + 校验 + 装配的规范实现（issue #197，从 `bin/skills.js` 搬入）。
//
// 分层规矩（#184 确立）：凡可被 import 的实现住在 `src/`，`bin/` 只做装配与呈现。
// ADR-008 把技能定位为「用户自己的脚本、in-process 动态 import」，且技能工具定义用的就是
// 本库的 `ToolSchema`——所以 loader 属于**机制**而非 CLI 政策。公开导出并入既有的
// `erix-agent/tools` 子路径（`src/tools/index.js` 转出），**不新增 `./skills` 子路径**：
// 打包面不扩，宿主本来就读 `./tools`。CLI 的 `erix skills` 与 repl `/skills` 经
// `bin/skills.js`（薄装配 + re-export）走进来，行为逐字不变。
//
// ⚠ 内置技能目录必须由调用方显式传 `bundledDir`——**库内一律不猜路径**。
// 搬走的那份实现原先写的是 `path.resolve(new URL("../skills/", import.meta.url))`：同一个
// 相对层级在 `bin/` 里恰好命中 `<pkg>/skills`，换到 `src/skills/` 就变味，宿主从 npm 包
// 装出来的层级又是另一套；歪掉的症状是「内置技能静默发现不到」而不是报错，最难查。
// 因此这里不留任何 `import.meta.url` 派生的默认值：
//   · CLI 侧（`bin/skills.js`）显式传自己的 `../skills`；
//   · 宿主传自己那一份；不传（`undefined`/`null`/空串）= 内置根完全不参与发现。
// 反证断言见 `test/skills.test.js`（同一 loader 喂两个不同 `bundledDir`、不传时内置根缺席）
// 与 `test/contract/skills-loader.js`（内置目录由参数决定）。

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createToolRegistry } from "../tools/registry.js";

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

/** `bundledDir` 未给（undefined/null/空串）时返回 undefined：内置根不参与发现。 */
function bundledRoot(bundledDir) {
  if (bundledDir === undefined || bundledDir === null || bundledDir === "") return undefined;
  return normalizeRoot(bundledDir);
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
  return normalized;
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

async function importSkillModule(root, entrypoint = DEFAULT_ENTRYPOINT) {
  const validatedEntrypoint = assertEntrypoint(root, entrypoint);
  const modulePath = path.join(root, validatedEntrypoint);
  if (!existsSync(modulePath)) {
    throw new Error(`技能入口文件不存在：${validatedEntrypoint}`);
  }
  return import(pathToFileURL(modulePath).href);
}

async function loadSkillWithModule(dir) {
  const root = normalizeRoot(dir);
  const descriptorModule = await importSkillModule(root);

  if (typeof descriptorModule.getSkillDefinition === "function") {
    const definition = await descriptorModule.getSkillDefinition();
    const loaded = validateDefinition(definition, root);
    const skillModule = loaded.entrypoint === DEFAULT_ENTRYPOINT
      ? descriptorModule
      : await importSkillModule(root, loaded.entrypoint);
    return { ...loaded, module: skillModule };
  }

  if (typeof descriptorModule.getTools === "function") {
    const tools = validateTools(await descriptorModule.getTools());
    return {
      skillId: path.basename(root),
      entrypoint: DEFAULT_ENTRYPOINT,
      tools,
      module: descriptorModule,
    };
  }

  throw new Error("技能模块必须导出 getSkillDefinition() 或 getTools()");
}

/**
 * Return the existing global and project skill directories.
 *
 * `skillsDir` is an explicit single-directory override used by the CLI.
 * `bundledDir` is the caller-owned bundled skill root (see the file header); it
 * is appended last and is skipped entirely when not supplied.
 */
export function skillDirectories({
  home = homedir(),
  cwd = process.cwd(),
  skillsDir,
  bundledDir,
} = {}) {
  const bundled = bundledRoot(bundledDir);
  const candidates = skillsDir === undefined
    ? [
      path.join(normalizeRoot(home), ".erix", "skills"),
      path.join(normalizeRoot(cwd), ".erix", "skills"),
      ...(bundled ? [bundled] : []),
    ]
    : [path.resolve(normalizeRoot(cwd), String(skillsDir))];

  return [...new Set(candidates.map(normalizeRoot))].filter(isDirectory);
}

/**
 * Discover first-level skill directories. Project entries replace global
 * entries with the same directory id, and global entries replace bundled ones.
 *
 * `bundledDir` (caller-owned, see the file header) is scanned **first**, so a
 * bundled skill always loses a same-id contest with a user or project skill —
 * the historical CLI precedence.
 */
export function discoverSkills({ home, cwd, skillsDir, bundledDir } = {}) {
  const bundled = bundledRoot(bundledDir);
  const discovered = new Map();
  const errors = [];
  const candidates = skillsDir === undefined
    ? [
      ...(bundled ? [bundled] : []),
      path.join(normalizeRoot(home ?? homedir()), ".erix", "skills"),
      path.join(normalizeRoot(cwd ?? process.cwd()), ".erix", "skills"),
    ]
    : [path.resolve(normalizeRoot(cwd ?? process.cwd()), String(skillsDir))];

  for (const directory of [...new Set(candidates.map(normalizeRoot))]) {
    let entries;
    try {
      if (!isDirectory(directory)) continue;
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      errors.push({
        skillId: path.basename(directory),
        dir: directory,
        error: errorMessage(error),
      });
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        discovered.set(entry.name, {
          dir: path.join(directory, entry.name),
          id: entry.name,
        });
      }
    }
  }
  const result = [...discovered.values()];
  Object.defineProperty(result, "errors", {
    value: errors,
    enumerable: false,
  });
  return result;
}

export async function loadSkill(dir) {
  const loaded = await loadSkillWithModule(dir);
  return {
    skillId: loaded.skillId,
    entrypoint: loaded.entrypoint,
    tools: loaded.tools,
  };
}

export async function loadAllSkills({ home, cwd, skillsDir, bundledDir } = {}) {
  const skills = [];
  const errors = [];
  const discovered = discoverSkills({ home, cwd, skillsDir, bundledDir });
  errors.push(...(discovered.errors ?? []));
  for (const candidate of discovered) {
    try {
      const loaded = await loadSkill(candidate.dir);
      skills.push({
        skillId: loaded.skillId,
        entrypoint: loaded.entrypoint,
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

/**
 * 同名冲突一次性告警（issue #65）：builtin 优先，skill 版本被 buildSkillTools 以
 * 「工具名冲突」错误跳过。chat/repl 装配路径各调用一次，多个冲突合并为一行。
 */
export function warnBuiltinToolConflicts(errors, { warn = (msg) => console.error(msg) } = {}) {
  const conflicts = (Array.isArray(errors) ? errors : []).filter((item) => (
    item && typeof item.error === "string" && item.error.startsWith("工具名冲突：")
  ));
  if (conflicts.length === 0) return;
  const details = conflicts
    .map((item) => `${item.skillId}（${item.error.slice("工具名冲突：".length)}）`)
    .join("；");
  warn(`提示：skill 工具与内置工具同名，已采用内置实现，skill 版本已忽略：${details}`);
}

export async function buildSkillTools({
  home,
  cwd,
  skillsDir,
  bundledDir,
  excludeSkillIds = [],
  builtinNames = [],
} = {}) {
  const loaded = await loadAllSkills({ home, cwd, skillsDir, bundledDir });
  const errors = [...loaded.errors];
  const builtinNameSet = new Set(
    builtinNames instanceof Set
      ? builtinNames
      : Array.isArray(builtinNames) ? builtinNames : [],
  );
  const usedNames = new Set(builtinNameSet);
  const schemas = [];
  const executors = {};
  const excludedSkills = new Set(excludeSkillIds);

  for (const skill of loaded.skills) {
    if (excludedSkills.has(skill.skillId)) continue;
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
      skillModule = await importSkillModule(skill.dir, skill.entrypoint);
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
      executors[tool.name] = (input, context) => skillModule[tool.name](input, context);
    }
  }

  const registry = createToolRegistry({ executors, schemas });
  return {
    tools: schemas,
    executeTool: registry.executeTool,
    errors,
  };
}
