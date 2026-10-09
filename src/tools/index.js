export { createToolRegistry } from "./registry.js";
export {
  createStaticToolProvider,
  createJsonFileToolProvider,
  createCompositeToolProvider,
} from "./providers.js";
// 文件工具规范实现（issue #184）：root 与 erix-agent/tools 双导出，CLI 反过来 import 它。
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
