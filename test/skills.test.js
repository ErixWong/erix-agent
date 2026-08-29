import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSkillTools,
  discoverSkills,
  loadSkill,
  loadAllSkills,
  skillDirectories,
} from "../bin/skills.js";

async function withDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "erix-skills-test-"));
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
        assert.deepEqual(skillDirectories({ home, cwd }), [globalSkills]);
      });

      await mkdir(projectSkills, { recursive: true });
      assert.deepEqual(skillDirectories({ home, cwd }), [globalSkills, projectSkills]);
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
      builtinNames: ["readFile", "rg", "tree"],
    });
    assert.deepEqual(result.tools, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /工具名冲突：readFile/);
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
    const result = await buildSkillTools({ cwd, builtinNames: [] });
    assert.equal(result.errors.length, 0);
    assert.equal(await result.executeTool("echo", { value: "hello" }), "hello");
    assert.equal(directory.endsWith("echo-skill"), true);
  });
});

test("buildSkillTools returns a friendly result for an unknown tool", async () => {
  await withDirectory(async (cwd) => {
    const skillsDirectory = join(cwd, ".erix", "skills");
    await writeSkill(skillsDirectory, "known", v1Definition("known"));
    const result = await buildSkillTools({ cwd });
    assert.equal(await result.executeTool("missing", {}), "Unknown tool: missing");
  });
});
