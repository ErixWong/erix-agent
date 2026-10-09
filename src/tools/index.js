export { createToolRegistry } from "./registry.js";
export {
  createStaticToolProvider,
  createJsonFileToolProvider,
  createCompositeToolProvider,
} from "./providers.js";
// 文件工具规范实现（issue #184）：**只从 `erix-agent/tools` 子路径导出**，不在包根
// （ADR-005 第二层：「不属于主导出」；实测 `src/index.js` 不转出 `createFileTools`），CLI 反过来 import 它。
export {
  createFileTools,
  resolveFileReadMaxBytes,
  truncateDisplayText,
  FILE_TOOL_DEFINITIONS,
  FILE_READ_MAX_BYTES_DEFAULT,
  MAX_FILE_BYTES,
  MAX_TREE_ENTRIES,
  GREP_MAX_RESULTS_HARD_CAP,
} from "./file-tools.js";
// 技能包 loader（issue #197）：机制进库，公开导出并入本子路径（**不新增 `./skills` 子路径**，
// 打包面不扩）。内置技能目录由调用方显式传 `bundledDir`，库内不猜路径；CLI 的
// `bin/skills.js` 只做装配（注入 `<package>/skills`）与 re-export。
export {
  skillDirectories,
  discoverSkills,
  loadSkill,
  loadAllSkills,
  buildSkillTools,
  warnBuiltinToolConflicts,
} from "../skills/loader.js";
export {
  createBuiltinNotesTools,
  completeRun,
  note_forget,
  note_list,
  note_read,
  note_take,
  resolveNotesDir,
  setNotesClock,
  MAX_CONTENT_LENGTH,
  NOTE_VALUE_MAX_CHARS,
} from "./notes.js";
