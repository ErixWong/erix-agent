import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmp } from "./helpers/tmp.js";

import {
  buildSkillTools,
  discoverSkills,
  loadSkill,
  loadAllSkills,
  skillDirectories,
  warnBuiltinToolConflicts,
} from "../bin/skills.js";

async function withDirectory(callback) {
  const directory = await makeTmp("erix-skills-test-");
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withEnvironment(values, callback) {
  const names = ["HOME"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) {
      const value = values[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

async function writeSkill(skillsDirectory, id, source) {
  const directory = join(skillsDirectory, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "skill.mjs"), source, "utf8");
  return directory;
}

function v1Definition(id, toolName = "echo", entrypoint = "skill.mjs") {
  return `export function getSkillDefinition() {
    return {
      schema_version: 1,
      skill: { id: ${JSON.stringify(id)}, entrypoint: ${JSON.stringify(entrypoint)} },
      tools: [{
        name: ${JSON.stringify(toolName)},
        description: "test tool",
        inputSchema: { type: "object" }
      }]
    };
  }
  export function ${toolName}() { return "ok"; }
  `;
}

test("skillDirectories returns only existing global and project directories", async () => {
  await withDirectory(async (home) => {
    await withDirectory(async (cwd) => {
      const globalSkills = join(home, ".erix", "skills");
      const projectSkills = join(cwd, ".erix", "skills");
      await mkdir(globalSkills, { recursive: true });

      await withEnvironment({ HOME: home }, () => {
        assert.deepEqual(skillDirectories({ home, cwd }), [
          globalSkills,
          join(process.cwd(), "skills"),
        ]);
      });

      await mkdir(projectSkills, { recursive: true });
      assert.deepEqual(skillDirectories({ home, cwd }), [
        globalSkills,
        projectSkills,
        join(process.cwd(), "skills"),
      ]);
    });
  });
});

test("discoverSkills gives the project directory priority for duplicate ids", async () => {
  await withDirectory(async (home) => {
    await withDirectory(async (cwd) => {
      const globalSkills = join(home, ".erix", "skills");
      const projectSkills = join(cwd, ".erix", "skills");
      await writeSkill(globalSkills, "shared", "");
      await writeSkill(globalSkills, "globalOnly", "");
      await writeSkill(projectSkills, "shared", "");
      await writeSkill(projectSkills, "projectOnly", "");

      const discovered = discoverSkills({ home, cwd });
      assert.equal(discovered.length, 3);
      assert.equal(
        discovered.find((skill) => skill.id === "shared").dir,
        join(projectSkills, "shared"),
      );
      assert.deepEqual(
        discovered.map((skill) => skill.id).sort(),
        ["globalOnly", "projectOnly", "shared"],
      );
    });
  });
});

// issue #186：原来用 chmod(unreadable, 0o000) 造「不可扫的根」——root 持有 DAC_OVERRIDE，
// stat/readdir 照样成功，于是「单根出错被隔离」这条分支在 root 下根本没被执行到（1 !== 1 只是症状）。
// 换成与 uid 无关的失败源：技能根路径的**父段是一个普通文件**（`<文件>/skills`），
// statSync/readdirSync 必然 ENOTDIR，root 与非 root 走同一条路径。
// 两个走过的弯路（均不适用于本实现，写下来免得下次重试）：
//   · 根路径处直接放普通文件 → discoverSkills 的 isDirectory() 返回 false → `continue`，不记错误，用例会变成空跑；
//   · 指向不存在路径的 symlink → statSync 抛 ENOENT，同样被当作「根不存在」吞掉，不记错误。
test("discoverSkills isolates a skill root scan error", async () => {
  await withDirectory(async (cwd) => {
    const blocker = join(cwd, "skill-root-blocked-by-file");
    await writeFile(blocker, "not a directory", "utf8");
    const unscannable = join(blocker, "skills");

    const discovered = discoverSkills({ cwd, skillsDir: unscannable });
    assert.deepEqual([...discovered], []);
    assert.equal(discovered.errors.length, 1);
    assert.equal(discovered.errors[0].dir, unscannable);
    // 钉住失败源本身：必须是 ENOTDIR（环境无关），不能靠权限位碰运。
    assert.match(discovered.errors[0].error, /ENOTDIR/u);
  });
});

test("loadSkill loads a valid SkillDefinition v1", async () => {
  await withDirectory(async (skillsDirectory) => {
    const directory = await writeSkill(skillsDirectory, "clock", v1Definition("clock"));
    assert.deepEqual(await loadSkill(directory), {
      skillId: "clock",
      entrypoint: "skill.mjs",
      tools: [{
        name: "echo",
        description: "test tool",
        inputSchema: { type: "object" },
      }],
    });
  });
});

test("loadSkill and buildSkillTools use the declared custom entrypoint", async () => {
  await withDirectory(async (skillsDirectory) => {
    const directory = await writeSkill(skillsDirectory, "custom-entry", `
      export function getSkillDefinition() {
        return {
          schema_version: 1,
          skill: { id: "custom-entry", entrypoint: "custom.mjs" },
          tools: [{ name: "echo", inputSchema: { type: "object" } }]
        };
      }
    `);
    await writeFile(join(directory, "custom.mjs"), `
      export async function echo() { return "custom-entrypoint"; }
    `, "utf8");

    assert.equal((await loadSkill(directory)).entrypoint, "custom.mjs");
    const result = await buildSkillTools({ cwd: skillsDirectory, skillsDir: "." });
    assert.equal(await result.executeTool("echo", {}), "custom-entrypoint");
  });
});

test("loadSkill supports the legacy getTools export", async () => {
  await withDirectory(async (skillsDirectory) => {
    const directory = await writeSkill(skillsDirectory, "legacy", `
      export function getTools() {
        return [{ name: "legacyTool", inputSchema: { type: "object" } }];
      }
      export function legacyTool() { return "legacy"; }
    `);
    assert.deepEqual(await loadSkill(directory), {
      skillId: "legacy",
      entrypoint: "skill.mjs",
      tools: [{ name: "legacyTool", inputSchema: { type: "object" } }],
    });
  });
});

test("loadSkill rejects an entrypoint escaping the skill root", async () => {
  await withDirectory(async (skillsDirectory) => {
    const directory = await writeSkill(
      skillsDirectory,
      "escape",
      v1Definition("escape", "echo", "../outside.mjs"),
    );
    await assert.rejects(loadSkill(directory), /entrypoint 逃逸技能目录/);
  });
});

test("loadSkill rejects empty tools", async () => {
  await withDirectory(async (skillsDirectory) => {
    const directory = await writeSkill(skillsDirectory, "empty", `
      export function getSkillDefinition() {
        return {
          schema_version: 1,
          skill: { id: "empty", entrypoint: "skill.mjs" },
          tools: []
        };
      }
    `);
    await assert.rejects(loadSkill(directory), /tools 不能为空/);
  });
});

test("loadSkill rejects duplicate tool names", async () => {
  await withDirectory(async (skillsDirectory) => {
    const directory = await writeSkill(skillsDirectory, "duplicate", `
      export function getSkillDefinition() {
        return {
          schema_version: 1,
          skill: { id: "duplicate", entrypoint: "skill.mjs" },
          tools: [
            { name: "same", inputSchema: { type: "object" } },
            { name: "same", inputSchema: { type: "object" } }
          ]
        };
      }
    `);
    await assert.rejects(loadSkill(directory), /工具名称重复：same/);
  });
});

test("loadSkill rejects a tool without inputSchema", async () => {
  await withDirectory(async (skillsDirectory) => {
    const directory = await writeSkill(skillsDirectory, "missing-schema", `
      export function getSkillDefinition() {
        return {
          schema_version: 1,
          skill: { id: "missing-schema", entrypoint: "skill.mjs" },
          tools: [{ name: "missingSchema" }]
        };
      }
    `);
    await assert.rejects(loadSkill(directory), /inputSchema 必须存在/);
  });
});

test("loadSkill rejects a module without a descriptor export", async () => {
  await withDirectory(async (skillsDirectory) => {
    const directory = await writeSkill(skillsDirectory, "no-descriptor", `
      export function unrelated() { return "no"; }
    `);
    await assert.rejects(loadSkill(directory), /必须导出 getSkillDefinition\(\) 或 getTools\(\)/);
  });
});

test("loadAllSkills keeps valid skills when another skill fails", async () => {
  await withDirectory(async (cwd) => {
    const skillsDirectory = join(cwd, ".erix", "skills");
    await writeSkill(skillsDirectory, "valid", v1Definition("valid"));
    await writeSkill(skillsDirectory, "invalid", `
      export function getSkillDefinition() {
        return { schema_version: 1, skill: { id: "invalid", entrypoint: "../bad.mjs" }, tools: [] };
      }
    `);

    const result = await loadAllSkills({ home: cwd, cwd });
    // issue #61：bundled notes skill 已退役，loadAllSkills 不再带回 bundled notes。
    assert.deepEqual(result.skills.map((skill) => skill.skillId), ["valid"]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].skillId, "invalid");
  });
});

test("buildSkillTools reports conflicts with built-in tools", async () => {
  await withDirectory(async (cwd) => {
    const skillsDirectory = join(cwd, ".erix", "skills");
    await writeSkill(skillsDirectory, "conflict", v1Definition("conflict", "readFile"));
    const result = await buildSkillTools({
      home: cwd,
      cwd,
      skillsDir: skillsDirectory,
      builtinNames: ["readFile", "rg", "tree"],
    });
    assert.deepEqual(result.tools, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /工具名冲突：readFile/);
  });
});

test("warnBuiltinToolConflicts 合并同名冲突为一次性告警（issue #65）", async () => {
  await withDirectory(async (cwd) => {
    const skillsDirectory = join(cwd, ".erix", "skills");
    await writeSkill(skillsDirectory, "todo", v1Definition("todo", "todo_add"));
    await writeSkill(skillsDirectory, "conflict2", v1Definition("conflict2", "readFile"));
    const result = await buildSkillTools({
      home: cwd,
      cwd,
      skillsDir: skillsDirectory,
      builtinNames: ["readFile", "todo_add"],
    });
    assert.equal(result.errors.length, 2);

    const warnings = [];
    warnBuiltinToolConflicts(result.errors, { warn: (msg) => warnings.push(msg) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /已采用内置实现/);
    assert.match(warnings[0], /todo（todo_add）/);
    assert.match(warnings[0], /conflict2（readFile）/);

    // 无冲突时静默；非数组输入也不抛错
    warnBuiltinToolConflicts([], { warn: (msg) => warnings.push(msg) });
    warnBuiltinToolConflicts(undefined, { warn: (msg) => warnings.push(msg) });
    assert.equal(warnings.length, 1);
  });
});

test("buildSkillTools executes an exported skill function", async () => {
  await withDirectory(async (cwd) => {
    const skillsDirectory = join(cwd, ".erix", "skills");
    const directory = await writeSkill(skillsDirectory, "echo-skill", `
      export function getSkillDefinition() {
        return {
          schema_version: 1,
          skill: { id: "echo-skill", entrypoint: "skill.mjs" },
          tools: [{
            name: "echo",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"]
            }
          }]
        };
      }
      export async function echo({ value }) { return value; }
    `);
    const result = await buildSkillTools({ cwd, home: cwd, builtinNames: [] });
    assert.equal(result.errors.length, 0);
    assert.equal(await result.executeTool("echo", { value: "hello" }), "hello");
    assert.equal(directory.endsWith("echo-skill"), true);
  });
});

// notes 的 scope 注入与 __erix 强制覆盖由 createBuiltinNotesTools 工厂负责
// （见 test/tools/notes.test.js）；buildSkillTools 不再对 notes skill 做特判。

test("buildSkillTools excludes only notes when requested", async () => {
  await withDirectory(async (cwd) => {
    const skillsDirectory = join(cwd, ".erix", "skills");
    await writeSkill(skillsDirectory, "notes", `
      export function getSkillDefinition() {
        return {
          schema_version: 1,
          skill: { id: "notes", entrypoint: "skill.mjs" },
          tools: [{ name: "note_take", inputSchema: { type: "object" } }]
        };
      }
      export function note_take() { return "notes"; }
    `);
    await writeSkill(skillsDirectory, "other", `
      export function getSkillDefinition() {
        return {
          schema_version: 1,
          skill: { id: "other", entrypoint: "skill.mjs" },
          tools: [{ name: "other_tool", inputSchema: { type: "object" } }]
        };
      }
      export function other_tool() { return "other"; }
    `);
    const result = await buildSkillTools({
      cwd,
      skillsDir: skillsDirectory,
      excludeSkillIds: ["notes"],
    });
    assert.deepEqual(result.tools.map((tool) => tool.name), ["other_tool"]);
    assert.equal(await result.executeTool("other_tool", {}), "other");
    assert.equal(await result.executeTool("note_take", {}), "Unknown tool: note_take");
  });
});

test("buildSkillTools returns a friendly result for an unknown tool", async () => {
  await withDirectory(async (cwd) => {
    const skillsDirectory = join(cwd, ".erix", "skills");
    await writeSkill(skillsDirectory, "known", v1Definition("known"));
    const result = await buildSkillTools({ cwd, home: cwd });
    assert.equal(await result.executeTool("missing", {}), "Unknown tool: missing");
  });
});
