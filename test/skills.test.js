import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSkillTools,
  discoverSkills,
  loadSkill,
  loadAllSkills,
  skillDirectories,
  warnBuiltinToolConflicts,
} from "../bin/skills.js";
import * as cliSkills from "../bin/skills.js";
import * as librarySkills from "../src/skills/loader.js";

import { skillsLoaderContract } from "./contract/skills-loader.js";

// 契约套件跑规范实现（宿主从 `erix-agent/tools` 拿到的就是这一份）。
// CLI 装配层（bin/skills.js）不重复跑整套契约：它的契约**故意多一件**——必须替调用方把
// 内置目录补上，「不传 bundledDir 时内置根缺席」那一条对它天然不成立。
// CLI 自己的口径由本文件末尾的「CLI 薄装配层」对照段钉住（发现顺序、默认内置目录、re-export 同一函数引用）。
skillsLoaderContract("src/skills/loader", {
  discoverSkills: librarySkills.discoverSkills,
  loadSkill: librarySkills.loadSkill,
  buildSkillTools: librarySkills.buildSkillTools,
});


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

// ---------------------------------------------------------------------------
// CLI 薄装配层（bin/skills.js）对照段（issue #197）
//
// 契约套件跑的是规范实现 `src/skills/loader.js`（宿主从 `erix-agent/tools` 拿到的那一份）。
// CLI 层比库**多一件义务**：它必须替 `bin/cli.js` / `bin/repl.js` 把内置技能目录补上，
// 所以这里单独钉住三件事，证明「搬进 src/ + 参数化」没有改动 CLI 的对外行为：
//   1. 默认内置目录仍是 `<package>/skills`，且发现顺序是 用户全局 → 项目本地 → 内置；
//   2. 校验失败形状不变（不阻塞、`errors[]` 可枚举、形状 `{skillId, dir, error}`）；
//   3. `buildSkillTools` 产出的仍是库的 `ToolSchema`（input 校验由 createToolRegistry 真实执行）。
// 另加两条「实现没有偷偷复刻一份」的守卫：re-export 必须是同一函数引用，
// 且显式 `bundledDir` 必须能穿透 CLI 包装器（宿主/测试注入通道）。
// ---------------------------------------------------------------------------

test("库 loader 不引入任何自身层级推断（源码形状守卫，issue #197）", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/skills/loader.js", import.meta.url)),
    "utf8",
  );
  // 只查代码：本文件的注释里本来就要提 `import.meta.url`（解释为什么要参数化）。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  for (const forbidden of ["import.meta", "new URL(", "BUNDLED_SKILLS_DIRECTORY"]) {
    assert.ok(
      !code.includes(forbidden),
      `src/skills/loader.js 的代码里不应出现 ${forbidden}：内置技能目录必须由 bundledDir 参数决定，库内猜层级会在宿主安装形态下静默算歪`,
    );
  }
  assert.match(code, /function bundledRoot\(bundledDir\)/);
});

test("同一个库 loader 喂两个不同 bundledDir，发现结果必须跟着变（不传则内置根缺席）", async () => {
  await withDirectory(async (sandbox) => {
    const home = join(sandbox, "home");
    const cwd = join(sandbox, "cwd");
    const bundledA = join(sandbox, "a", "skills");
    const bundledB = join(sandbox, "deep", "nested", "b", "skills");
    await writeSkill(bundledA, "alpha", v1Definition("alpha", "alpha_tool"));
    await writeSkill(bundledB, "beta", v1Definition("beta", "beta_tool"));

    // CLI 包装器同样必须把 bundledDir 透传给库（显式传值时覆盖 CLI 默认）。
    for (const [name, impl] of [["bin/skills.js", cliSkills], ["src/skills/loader.js", librarySkills]]) {
      assert.deepEqual(
        impl.discoverSkills({ home, cwd, bundledDir: bundledA }).map((skill) => skill.id),
        ["alpha"],
        `${name} 必须按传入的 bundledDir 发现`,
      );
      assert.deepEqual(
        impl.discoverSkills({ home, cwd, bundledDir: bundledB }).map((skill) => skill.id),
        ["beta"],
        `${name} 的内置目录必须是参数，而不是自身层级的函数`,
      );
    }

    // 库侧：不传 = 内置根完全不参与（这一条正是「猜层级」的负控制点）。
    await mkdir(join(home, ".erix", "skills"), { recursive: true });
    await mkdir(join(cwd, ".erix", "skills"), { recursive: true });
    assert.deepEqual(
      librarySkills.skillDirectories({ home, cwd }),
      [join(home, ".erix", "skills"), join(cwd, ".erix", "skills")],
      "不传 bundledDir 时内置根必须逗都不来",
    );
    assert.deepEqual(
      librarySkills.skillDirectories({ home, cwd, bundledDir: bundledA }),
      [join(home, ".erix", "skills"), join(cwd, ".erix", "skills"), bundledA],
      "传了 bundledDir 就追加在末尾（CLI 历史的发现顺序）",
    );
  });
});

test("CLI 默认仍注入 <package>/skills，发现顺序 用户全局 → 项目本地 → 内置", async () => {
  await withDirectory(async (home) => {
    await withDirectory(async (cwd) => {
      const globalSkills = join(home, ".erix", "skills");
      const projectSkills = join(cwd, ".erix", "skills");
      await mkdir(globalSkills, { recursive: true });
      await mkdir(projectSkills, { recursive: true });

      // CLI 的内置目录 = bin/ 的上一级 skills/（层级在 CLI 侧算，issue #197）。
      // 测试文件在 test/、CLI 在 bin/，两者上一级的 skills/ 是同一个仓内路径。
      assert.equal(
        cliSkills.BUNDLED_SKILLS_DIRECTORY,
        path.resolve(import.meta.dirname, "..", "skills"),
        "bin/skills.js 的内置目录必须仍按 bin/ 的层级算（上一层 + skills/）",
      );
      assert.equal(existsSync(cliSkills.BUNDLED_SKILLS_DIRECTORY), true);

      assert.deepEqual(cliSkills.skillDirectories({ home, cwd }), [
        globalSkills,
        projectSkills,
        cliSkills.BUNDLED_SKILLS_DIRECTORY,
      ]);
    });
  });
});

test("CLI 层的校验失败形状与 ToolSchema 形态不变（issue #197 硬判据）", async () => {
  await withDirectory(async (cwd) => {
    const skillsDirectory = join(cwd, ".erix", "skills");
    const badDirectory = await writeSkill(skillsDirectory, "bad", `
      export function getSkillDefinition() {
        return { schema_version: 1, skill: { id: "bad", entrypoint: "missing.mjs" }, tools: [] };
      }
    `);
    await writeSkill(skillsDirectory, "good", `
      export function getSkillDefinition() {
        return {
          schema_version: 1,
          skill: { id: "good", entrypoint: "skill.mjs" },
          tools: [{
            name: "cli_echo",
            description: "cli parity",
            inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
          }]
        };
      }
      export function cli_echo({ value }) { return \`cli:\${value}\`; }
    `);

    const built = await cliSkills.buildSkillTools({ home: cwd, cwd, bundledDir: null });
    assert.deepEqual(built.tools.map((tool) => tool.name), ["cli_echo"]);
    assert.equal(built.errors.length, 1);
    assert.deepEqual(Object.keys(built.errors[0]).sort(), ["dir", "error", "skillId"]);
    assert.equal(built.errors[0].dir, badDirectory);
    assert.match(built.errors[0].error, /entrypoint 不存在/);

    // ToolSchema 形态：input 校验由 createToolRegistry 真实执行，未知工具是文本结果。
    assert.equal(await built.executeTool("cli_echo", { value: "x" }), "cli:x");
    assert.match(await built.executeTool("cli_echo", {}), /missing required field "value"/);
    assert.equal(await built.executeTool("nope", {}), "Unknown tool: nope");
  });
});

test("bin/skills.js 是 re-export 而非第二份实现（issue #197 分层守卫）", async () => {
  assert.equal(cliSkills.loadSkill, librarySkills.loadSkill);
  assert.equal(cliSkills.warnBuiltinToolConflicts, librarySkills.warnBuiltinToolConflicts);
  for (const name of ["skillDirectories", "discoverSkills", "loadAllSkills", "buildSkillTools"]) {
    assert.equal(typeof cliSkills[name], "function", `bin/skills.js 必须继续导出 ${name}`);
    assert.notEqual(cliSkills[name], librarySkills[name], `${name} 需要 CLI 侧注入默认内置目录`);
  }
  // 库的六个符号必须可从公开子路径拿到（宿主不需要知道包里 skills/ 在哪）。
  const toolsSubpath = await import("../src/tools/index.js");
  for (const name of [
    "skillDirectories",
    "discoverSkills",
    "loadSkill",
    "loadAllSkills",
    "buildSkillTools",
    "warnBuiltinToolConflicts",
  ]) {
    assert.equal(toolsSubpath[name], librarySkills[name], `erix-agent/tools 必须转出 ${name}`);
  }
});
