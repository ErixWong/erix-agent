// CLI 侧的技能装配层（issue #197）：实现已进库（`src/skills/loader.js`），
// 本文件只做两件事——
//   1. 注入 CLI 自己的内置技能目录（`<package>/skills`，层级在这里算，因为 `bin/` 的层级
//      是 CLI 的事实，不是库的事实）；
//   2. re-export 库符号，让 `bin/cli.js` / `bin/repl.js` / `scripts/` 的 import 零改动。
//
// 库内**不猜**内置目录（见 loader 头部注释）：`bundledDir` 是显式选项，调用方不传就不参与
// 发现。CLI 必须逐字保持历史行为，所以这里把默认值补回 `../skills`。

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSkillTools as libraryBuildSkillTools,
  discoverSkills as libraryDiscoverSkills,
  loadAllSkills as libraryLoadAllSkills,
  skillDirectories as librarySkillDirectories,
} from "../src/skills/loader.js";

export const BUNDLED_SKILLS_DIRECTORY = path.resolve(
  fileURLToPath(new URL("../skills/", import.meta.url)),
);

export {
  loadSkill,
  warnBuiltinToolConflicts,
} from "../src/skills/loader.js";

export function skillDirectories({
  bundledDir = BUNDLED_SKILLS_DIRECTORY,
  ...options
} = {}) {
  return librarySkillDirectories({ ...options, bundledDir });
}

export function discoverSkills({
  bundledDir = BUNDLED_SKILLS_DIRECTORY,
  ...options
} = {}) {
  return libraryDiscoverSkills({ ...options, bundledDir });
}

export function loadAllSkills({
  bundledDir = BUNDLED_SKILLS_DIRECTORY,
  ...options
} = {}) {
  return libraryLoadAllSkills({ ...options, bundledDir });
}

export async function buildSkillTools({
  bundledDir = BUNDLED_SKILLS_DIRECTORY,
  ...options
} = {}) {
  return libraryBuildSkillTools({ ...options, bundledDir });
}
