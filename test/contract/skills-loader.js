// 技能包 loader 契约测试套件（issue #197；工厂注入风格照 test/contract/file-tools.js）
//
// 任何技能包 loader 实现（库内置 src/skills/loader.js、CLI 的装配层 bin/skills.js、
// 宿主自己的 fork）都必须通过同一组断言。用法：
//
//   import { skillsLoaderContract } from "erix-agent/contract-tests";
//   import { discoverSkills, loadSkill, buildSkillTools } from "erix-agent/tools";
//   skillsLoaderContract("my-host-loader", { discoverSkills, loadSkill, buildSkillTools });
//
// 契约面（派单 261009-197 的交付物 4）：
//   * **内置目录由参数决定**：同一个 loader 喂两个不同 `bundledDir`，发现结果必须跟着变；
//     不传 `bundledDir` 时内置根必须**完全不参与**发现（库不得按自身文件层级猜路径）；
//   * 发现顺序：内置 < 用户全局（`<home>/.erix/skills`）< 项目本地（`<cwd>/.erix/skills`），
//     同名后者覆盖前者；`skillsDir` 是单目录覆盖，一旦给出就只看它；
//   * 校验失败**不阻塞、可枚举**：一个坏技能不阻止同根好技能装配，`errors[]` 每项形状是
//     `{skillId, dir, error}`（`error` 是字符串），整体跳过该技能而不是部分生效；
//   * 与内置工具同名 → 记一条「工具名冲突：…」错误并整体跳过该 skill（不静默覆盖内置）；
//   * `buildSkillTools` 产出的 `tools` 就是库的 `ToolSchema` 形态：直接被
//     `createToolRegistry` 消费，因此 input 校验（type / required / 字段类型）必须真的生效，
//     未知工具返回 `Unknown tool: <name>` 文本而不是抛。
//
// 实现特有行为（CLI 终端回显、告警文案）由实现方自行补测，不进契约。
// ⚠️ 隔离：每个用例注入临时 home/cwd/bundledDir（node:test + fs.mkdtemp），不得读写真实 ~/.erix。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function withDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-skills-loader-contract-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** 在某个技能根下写一个技能目录（`<root>/<id>/skill.mjs`）。 */
async function writeSkill(root, id, source) {
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "skill.mjs"), source, "utf8");
  return directory;
}

/** schema_version 1 的最小自描述技能（entrypoint 就是 skill.mjs 自己）。 */
function v1Definition(id, toolName = "echo") {
  return `export function getSkillDefinition() {
  return {
    schema_version: 1,
    skill: { id: ${JSON.stringify(id)}, entrypoint: "skill.mjs" },
    tools: [{ name: ${JSON.stringify(toolName)}, description: "contract tool", inputSchema: { type: "object" } }]
  };
}
export function ${toolName}() { return ${JSON.stringify(id)}; }
`;
}

/**
 * @param {string} label 实现名（测试标题前缀）
 * @param {{
 *   discoverSkills: (options: { home?: string, cwd?: string, skillsDir?: string, bundledDir?: string })
 *     => Array<{ id: string, dir: string }> & { errors?: object[] },
 *   loadSkill: (dir: string) => Promise<{ skillId: string, entrypoint: string, tools: object[] }>,
 *   buildSkillTools: (options: { home?: string, cwd?: string, skillsDir?: string, bundledDir?: string,
 *     excludeSkillIds?: string[], builtinNames?: string[] })
 *     => Promise<{ tools: object[], executeTool: Function, errors: object[] }>,
 * }} deps 待验实现
 */
export function skillsLoaderContract(label, { discoverSkills, loadSkill, buildSkillTools }) {
  test(`${label}: 内置技能目录由 bundledDir 参数决定（换目录，发现结果必须跟着换）`, async () => {
    await withDirectory(async (sandbox) => {
      const home = path.join(sandbox, "home");
      const cwd = path.join(sandbox, "cwd");
      const bundledA = path.join(sandbox, "nested", "deeper", "pkg-A", "skills");
      const bundledB = path.join(sandbox, "elsewhere", "pkg-B", "skills");
      await writeSkill(bundledA, "alpha", v1Definition("alpha", "alpha_tool"));
      await writeSkill(bundledB, "beta", v1Definition("beta", "beta_tool"));

      const viaA = discoverSkills({ home, cwd, bundledDir: bundledA });
      assert.deepEqual(viaA.map((skill) => skill.id), ["alpha"]);
      assert.equal(viaA[0].dir, path.join(bundledA, "alpha"));

      const viaB = discoverSkills({ home, cwd, bundledDir: bundledB });
      assert.deepEqual(viaB.map((skill) => skill.id), ["beta"]);
      assert.equal(viaB[0].dir, path.join(bundledB, "beta"));

      // 装配面也要跟着目录走：schema 与执行函数必须是新目录里那一份。
      const built = await buildSkillTools({ home, cwd, bundledDir: bundledB });
      assert.deepEqual(built.tools.map((tool) => tool.name), ["beta_tool"]);
      assert.equal(built.errors.length, 0);
      assert.equal(await built.executeTool("beta_tool", {}), "beta");

      // 换一个层级深度（不在 loader 自身父级链上的深层路径）也必须能发现：
      // 「按 import.meta.url 猜层级」的实现在这一步会静默拿到空结果。
      const deep = path.join(sandbox, "x", "y", "z", "skills");
      await writeSkill(deep, "gamma", v1Definition("gamma", "gamma_tool"));
      assert.deepEqual(
        discoverSkills({ home, cwd, bundledDir: deep }).map((skill) => skill.id),
        ["gamma"],
      );
    });
  });

  test(`${label}: 不传 bundledDir 时内置根完全不参与发现（库不猜自身文件层级）`, async () => {
    await withDirectory(async (sandbox) => {
      const home = path.join(sandbox, "home");
      const cwd = path.join(sandbox, "cwd");
      await writeSkill(path.join(home, ".erix", "skills"), "userSkill", v1Definition("userSkill", "user_tool"));
      await writeSkill(path.join(cwd, ".erix", "skills"), "projectSkill", v1Definition("projectSkill", "project_tool"));

      const discovered = discoverSkills({ home, cwd });
      assert.deepEqual(
        discovered.map((skill) => skill.id).sort(),
        ["projectSkill", "userSkill"],
      );
      for (const skill of discovered) {
        assert.ok(
          skill.dir.startsWith(home) || skill.dir.startsWith(cwd),
          `不传 bundledDir 时不得出现 home/cwd 之外的技能目录，实际拿到 ${skill.dir}`,
        );
      }

      const built = await buildSkillTools({ home, cwd });
      assert.deepEqual(built.tools.map((tool) => tool.name), ["user_tool", "project_tool"]);
      assert.equal(built.errors.length, 0);
    });
  });

  test(`${label}: 发现顺序 内置 < 用户全局 < 项目本地（同名后者覆盖）`, async () => {
    await withDirectory(async (sandbox) => {
      const home = path.join(sandbox, "home");
      const cwd = path.join(sandbox, "cwd");
      const bundled = path.join(sandbox, "pkg", "skills");
      const globalSkills = path.join(home, ".erix", "skills");
      const projectSkills = path.join(cwd, ".erix", "skills");
      for (const [root, ids] of [
        [bundled, ["shared", "bundledOnly"]],
        [globalSkills, ["shared", "globalOnly"]],
        [projectSkills, ["shared", "projectOnly"]],
      ]) {
        for (const id of ids) await writeSkill(root, id, v1Definition(id));
      }

      const discovered = discoverSkills({ home, cwd, bundledDir: bundled });
      const byId = new Map(discovered.map((skill) => [skill.id, skill.dir]));
      assert.deepEqual(
        discovered.map((skill) => skill.id).slice().sort(),
        ["bundledOnly", "globalOnly", "projectOnly", "shared"],
      );
      assert.equal(byId.get("shared"), path.join(projectSkills, "shared"));
      assert.equal(byId.get("bundledOnly"), path.join(bundled, "bundledOnly"));

      // 全局覆盖内置：项目侧去掉同名后，胜者必须是全局那一份。
      await rm(path.join(projectSkills, "shared"), { recursive: true, force: true });
      const globalWins = discoverSkills({ home, cwd, bundledDir: bundled });
      assert.equal(
        globalWins.find((skill) => skill.id === "shared").dir,
        path.join(globalSkills, "shared"),
      );
    });
  });

  test(`${label}: skillsDir 是单目录覆盖，给出后内置/全局/项目三根都不参与`, async () => {
    await withDirectory(async (sandbox) => {
      // skillsDir 按 cwd 解析（CLI `--skills-dir` 的历史口径），所以让 cwd 就是沙箱根。
      const cwd = sandbox;
      const home = path.join(sandbox, "home");
      const bundled = path.join(sandbox, "pkg", "skills");
      await writeSkill(bundled, "bundledOnly", v1Definition("bundledOnly"));
      await writeSkill(path.join(home, ".erix", "skills"), "globalOnly", v1Definition("globalOnly"));
      await writeSkill(path.join(cwd, ".erix", "skills"), "projectOnly", v1Definition("projectOnly"));
      await writeSkill(path.join(sandbox, "explicit", "skills"), "overrideOnly", v1Definition("overrideOnly"));

      assert.deepEqual(
        discoverSkills({ home, cwd, skillsDir: "explicit/skills", bundledDir: bundled })
          .map((skill) => skill.id),
        ["overrideOnly"],
        "给出 skillsDir 时只能看它（内置/全局/项目三根全部退出）",
      );
      // 绝对形态同样只看它。
      assert.deepEqual(
        discoverSkills({ home, cwd, skillsDir: path.join(sandbox, "explicit", "skills"), bundledDir: bundled })
          .map((skill) => skill.id),
        ["overrideOnly"],
      );
    });
  });

  test(`${label}: 校验失败不阻塞、可枚举，且整体跳过该技能`, async () => {
    await withDirectory(async (sandbox) => {
      const cwd = path.join(sandbox, "cwd");
      const skillsRoot = path.join(cwd, ".erix", "skills");
      const badDirectory = await writeSkill(skillsRoot, "bad", `
        export function getSkillDefinition() {
          return {
            schema_version: 1,
            skill: { id: "bad", entrypoint: "../escape.mjs" },
            tools: [{ name: "neverRuns", inputSchema: { type: "object" } }]
          };
        }
      `);
      await writeSkill(skillsRoot, "good", v1Definition("good", "good_tool"));

      const built = await buildSkillTools({ home: cwd, cwd, bundledDir: path.join(sandbox, "none") });
      assert.deepEqual(built.tools.map((tool) => tool.name), ["good_tool"]);
      assert.equal(built.errors.length, 1);
      const [failure] = built.errors;
      assert.deepEqual(Object.keys(failure).sort(), ["dir", "error", "skillId"]);
      assert.equal(failure.skillId, "bad");
      assert.equal(failure.dir, badDirectory);
      assert.equal(typeof failure.error, "string");
      assert.match(failure.error, /entrypoint 逃逸技能目录/);
      // 被跳过的技能不得留下半个执行器。
      assert.equal(await built.executeTool("neverRuns", {}), "Unknown tool: neverRuns");
    });
  });

  test(`${label}: loadSkill 的校验形状（四种坏形状各自报错，不静默通过）`, async () => {
    await withDirectory(async (sandbox) => {
      const cases = [
        ["empty-tools", /tools 不能为空/, `
          export function getSkillDefinition() {
            return { schema_version: 1, skill: { id: "empty-tools", entrypoint: "skill.mjs" }, tools: [] };
          }
        `],
        ["dup-name", /工具名称重复：same/, `
          export function getSkillDefinition() {
            return {
              schema_version: 1,
              skill: { id: "dup-name", entrypoint: "skill.mjs" },
              tools: [{ name: "same", inputSchema: { type: "object" } }, { name: "same", inputSchema: { type: "object" } }]
            };
          }
        `],
        ["missing-schema", /inputSchema 必须存在/, `
          export function getSkillDefinition() {
            return {
              schema_version: 1,
              skill: { id: "missing-schema", entrypoint: "skill.mjs" },
              tools: [{ name: "noSchema" }]
            };
          }
        `],
        ["no-descriptor", /必须导出 getSkillDefinition\(\) 或 getTools\(\)/, `
          export function unrelated() { return "no"; }
        `],
      ];
      for (const [id, expected, source] of cases) {
        const directory = await writeSkill(path.join(sandbox, "skills"), id, source);
        await assert.rejects(loadSkill(directory), expected, `${id} 必须被拒`);
      }

      // legacy getTools() 形态仍受支持，且 skillId 回落成目录名。
      const legacy = await writeSkill(path.join(sandbox, "skills"), "legacy-id", `
        export function getTools() { return [{ name: "legacyTool", inputSchema: { type: "object" } }]; }
        export function legacyTool() { return "legacy"; }
      `);
      assert.deepEqual(await loadSkill(legacy), {
        skillId: "legacy-id",
        entrypoint: "skill.mjs",
        tools: [{ name: "legacyTool", inputSchema: { type: "object" } }],
      });
    });
  });

  test(`${label}: buildSkillTools 产出的就是库 ToolSchema（被 createToolRegistry 真实校验）`, async () => {
    await withDirectory(async (sandbox) => {
      const cwd = path.join(sandbox, "cwd");
      const skillsRoot = path.join(cwd, ".erix", "skills");
      await writeSkill(skillsRoot, "echo", `
        export function getSkillDefinition() {
          return {
            schema_version: 1,
            skill: { id: "echo", entrypoint: "skill.mjs" },
            tools: [{
              name: "echo",
              description: "echo the value",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"]
              }
            }]
          };
        }
        export async function echo({ value }) { return \`echo:\${value}\`; }
      `);

      const built = await buildSkillTools({ home: cwd, cwd });
      assert.equal(built.errors.length, 0);
      assert.equal(built.tools.length, 1);
      const [schema] = built.tools;
      assert.equal(schema.name, "echo");
      assert.equal(schema.description, "echo the value");
      assert.equal(schema.inputSchema.type, "object");
      assert.deepEqual(schema.inputSchema.required, ["value"]);

      // ToolSchema 生效的证据：input 校验真的由库的 registry 跑（缺 required / 类型不符），
      // 未知工具返回文本结果而不是抛。
      assert.equal(await built.executeTool("echo", { value: "hi" }), "echo:hi");
      assert.match(
        await built.executeTool("echo", {}),
        /Tool echo input is missing required field "value"/,
      );
      assert.match(
        await built.executeTool("echo", { value: 7 }),
        /Tool echo field "value" must be of type string/,
      );
      assert.equal(await built.executeTool("missing", {}), "Unknown tool: missing");
    });
  });

  test(`${label}: 与内置工具同名 → 记冲突错误并整体跳过（不静默覆盖内置）`, async () => {
    await withDirectory(async (sandbox) => {
      const cwd = path.join(sandbox, "cwd");
      const skillsRoot = path.join(cwd, ".erix", "skills");
      await writeSkill(skillsRoot, "conflict", `
        export function getSkillDefinition() {
          return {
            schema_version: 1,
            skill: { id: "conflict", entrypoint: "skill.mjs" },
            tools: [
              { name: "readFile", inputSchema: { type: "object" } },
              { name: "kept_tool", inputSchema: { type: "object" } }
            ]
          };
        }
        export function readFile() { return "skill"; }
        export function kept_tool() { return "kept"; }
      `);

      const built = await buildSkillTools({ home: cwd, cwd, builtinNames: ["readFile"] });
      assert.deepEqual(built.tools, [], "冲突技能必须整体跳过，不能只丢掉冲突的那一个");
      assert.equal(built.errors.length, 1);
      assert.match(built.errors[0].error, /^工具名冲突：readFile$/);
      assert.equal(built.errors[0].skillId, "conflict");
      assert.equal(await built.executeTool("kept_tool", {}), "Unknown tool: kept_tool");
    });
  });

  test(`${label}: excludeSkillIds 只排除点名的技能`, async () => {
    await withDirectory(async (sandbox) => {
      const cwd = path.join(sandbox, "cwd");
      const skillsRoot = path.join(cwd, ".erix", "skills");
      await writeSkill(skillsRoot, "notes", `
        export function getSkillDefinition() {
          return {
            schema_version: 1,
            skill: { id: "notes", entrypoint: "skill.mjs" },
            tools: [{ name: "note_take", inputSchema: { type: "object" } }]
          };
        }
        export function note_take() { return "notes"; }
      `);
      await writeSkill(skillsRoot, "other", v1Definition("other", "other_tool"));

      const built = await buildSkillTools({
        home: cwd,
        cwd,
        excludeSkillIds: ["notes"],
        builtinNames: ["note_take"],
      });
      assert.deepEqual(built.tools.map((tool) => tool.name), ["other_tool"]);
      assert.equal(built.errors.length, 0);
      assert.equal(await built.executeTool("other_tool", {}), "other");
    });
  });
}
