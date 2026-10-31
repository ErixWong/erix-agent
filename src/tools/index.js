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
  // issue #220：成功返回形态的判别式（宿主 switch 的 default 靠它在编译期钉死未知形态）
  classifyFileToolResult,
  // issue #375：参数错误的统一出口（`[参数错误：…]`）与它的事实集。四条旧通道在 0.29 上保留，
  // 宿主给自己的工具补参数校验时用这一条，不要自己拼方括号文案。
  paramError,
  paramErrorFacts,
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
// 派生（子 run）簿记件（issue #617 P1a）：名册 / 并发配额租约 / 完成通知去重。
// 纯簿记——不 fork / 不 spawn / 不等子进程，不解释 opaque 字段，进程存活这类外部事实
// 一律由宿主注入谓词。派生工具本身与 CLI 装配是后续刀（P1b / P2），这里只有库面。
export {
  ROSTER_STATES,
  ROSTER_LIVE_STATES,
  writeRecord,
  readRecord,
  listRecords,
  removeRecord,
  reconcile,
} from "./delegation/roster.js";
export {
  acquire,
  release,
  sweep,
  list,
} from "./delegation/capacity.js";
export {
  NOTIFICATION_PREFIX,
  completionMarkerKey,
  markCollected,
  isCollected,
  shouldNotify,
  notificationText,
} from "./delegation/notify.js";
// 派生工具本体（issue #617 P1b）：`delegate` 工具的工厂。仍然零子进程——`runChild` 由宿主注入；
// 终止词汇（TERMINATION_TO_STATE）归库并导出给宿主审；父身份从执行上下文自取，schema 无 parentRunId。
export {
  createDelegateTool,
  TERMINATION_TO_STATE,
  DEFAULT_TERMINATION_STATE,
  DELEGATE_ACTIONS,
  DELEGATE_DEFINITION,
} from "./delegation/tool.js";
