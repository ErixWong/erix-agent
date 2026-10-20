// issue #168 T2：会话发现层改成**无状态现扫现算**——`-c`/`-r` 的候选列表直接从 transcripts 目录的
// **文件名**算出来，不再有 `sessions.json` / `session-meta.json` 这两个可腐化的状态文件。
//
// 为什么可以现扫（实测口径见 issue #168）：真实 `~/.erix` 下 510 个 json / 414 个 transcript 相关
// 文件，全量 `readdir + stat` 只要 **29.7 ms**，扫描本身完全够便宜。
//
// 为什么还能按目录筛选（这条是「退役索引不必牺牲能力」的关键，issue #168 第二条回帖实测）：
// sessionId 的前两段就是 `<目录名>-<sha256(目录绝对路径) 前 8 位>`，派生式出自
// `bin/repl.js` 的 `defaultSessionId` 与 `src/tools/notes.js` 的 `currentScopeRef`（两处同式）。
// 于是 `cwd` 可从 transcript 文件名重算，`session-meta.json` 里那个 `cwd` 字段是冗余状态。
// 这条派生式自此是**行为契约**（`-c` 的「按本目录」语义依赖它），由 `test/sessions.test.js`
// 的哈希契约用例钉住；本模块是它的**唯一实现**，`bin/repl.js` 反过来 import 这里。
//
// 扫描不可见 ≠ 不可恢复（务必与文档/错误提示一致）：只有形如
// `<目录名>-<哈希 8 位>` 或 `<目录名>-<哈希 8 位>-<随机后缀>` 的 id 才对本目录可见。
// 其它形状的 id（用户自取的 `--session my-run`、被 `safeRunId` 哈希成 `run-h-*` 的名字——
// 包括**目录名含非 `[A-Za-z0-9._-]` 字符**的目录）在 `-c`/`-r` 里看不见，
// 但**仍然可用 `--session <完整 id>` 精确恢复**（那条路径只认 `store.load` 非空）。
import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const FIRST_USER_TEXT_MAX = 80;
// picker 预览的读取上限：只读文件头部，绝不为「一行预览」把整个 transcript 读进内存。
const PREVIEW_READ_BYTES = 64 * 1024;
const TRANSCRIPT_SUFFIX = ".jsonl";

/** transcripts 目录的默认位置（CLI 的 `--dir` 覆盖它）。 */
export function defaultTranscriptsDir(home = homedir()) {
  return path.join(String(home), ".erix", "transcripts");
}

/**
 * 会话 id 的**目录前缀**（行为契约）：`<basename || "root">-<sha256(绝对路径) 的 hex 前 8 位>`。
 * 哈希输入就是 `path.resolve` 后的目录原串——与 `src/tools/notes.js` 的 `currentScopeRef` 同式。
 */
export function sessionScanPrefix(cwd) {
  const normalizedCwd = path.resolve(String(cwd));
  const baseName = path.basename(normalizedCwd) || "root";
  const hash8 = createHash("sha256").update(normalizedCwd).digest("hex").slice(0, 8);
  return `${baseName}-${hash8}`;
}

/**
 * 该 sessionId 是否属于 `cwd` 的扫描集——即 `*-<sha256(cwd)[:8]}-*` 的**精确形式**：
 * 派生 id 恒以 `<目录名>-<哈希 8 位>` 开头，所以这里锚定开头而不是在任意位置找哈希
 * （任意位置匹配会让「另一个 basename 结尾恰好等于本目录哈希」的目录混进来）。
 */
export function belongsToCwd(sessionId, cwd) {
  const prefix = sessionScanPrefix(cwd);
  return sessionId === prefix || sessionId.startsWith(`${prefix}-`);
}

/**
 * 现扫本目录可续跑的会话，按 mtime **降序**。
 *
 * - 目录不存在 / 不可读 → `[]`（不是错误：首次使用就是这个状态）；
 * - 空目录 → `[]`；
 * - 只认 `*.jsonl`（`.state.json` / `.snapshot.json` / `.checkpoint.json` / `judge.log` 等天然排除）；
 * - 名字不对本目录形状的 id 不可见（见文件头「扫描不可见 ≠ 不可恢复」）；
 * - **0 字节 transcript 跳过**：`store.load` 也返回空，选它等于选了一个不可续跑的会话。
 *
 * @returns {Promise<Array<{sessionId: string, transcriptPath: string, updatedAt: string, size: number}>>}
 */
export async function scanSessions({ home = homedir(), cwd = process.cwd(), transcriptsDir } = {}) {
  const dir = String(transcriptsDir ?? defaultTranscriptsDir(home));
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(TRANSCRIPT_SUFFIX)) continue;
    const sessionId = entry.name.slice(0, -TRANSCRIPT_SUFFIX.length);
    if (sessionId === "" || !belongsToCwd(sessionId, cwd)) continue;
    const transcriptPath = path.join(dir, entry.name);
    let info;
    try {
      info = await stat(transcriptPath);
    } catch {
      continue; // 扫到被并发改掉/删掉的文件：跳过，不让整个列表失败
    }
    if (info.size === 0) continue;
    candidates.push({
      sessionId,
      transcriptPath,
      updatedAt: info.mtime.toISOString(),
      size: info.size,
    });
  }
  candidates.sort((a, b) => (
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
  ));
  return candidates;
}

/** `-c`：本目录 mtime 最新的一条；无可续会话返回 null。 */
export async function resolveContinueSessionId({ home, cwd, transcriptsDir } = {}) {
  const [newest] = await scanSessions({ home, cwd, transcriptsDir });
  return newest?.sessionId ?? null;
}

export function truncateFirstUserText(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > FIRST_USER_TEXT_MAX
    ? `${value.slice(0, FIRST_USER_TEXT_MAX)}…`
    : value;
}

/**
 * issue #326（wo-D）：**引擎自写文本的标记**（#323 已有的 `meta.source`）。
 * 与 `src/reflection/judge.js` 的 `renderConversation` 排除同一口径：两边不一致就会分裂出
 * 「judge 看不到的」与「用户看不到的」两套正文。引擎自写的控制文本**仍必须留在模型上下文里**
 * （契约明说宿主不得删），只是不能当会话正文展示。
 */
export const ENGINE_NOTE_SOURCE = "judge-control";

/** 这一条消息是引擎自说自话吗（judge nudge / extend / guard-revise / forced-final 指令）。 */
export function isEngineNoteMessage(message) {
  return message?.meta?.source === ENGINE_NOTE_SOURCE;
}

/**
 * 这一行记录贡献了哪些消息。
 * `messages` 缺失 / `null` / 不是数组一律当「这一行没有正文」——#326 的 `:fold:` / `:ttl:`
 * 事实行本来就是 `messages: []`，老 transcript 里还有整个字段都没写的行，两者都不能抛。
 */
export function messagesOfRecord(record) {
  return Array.isArray(record?.messages) ? record.messages : [];
}

/** 若干部记录展平成消息（行为不变的那部分：不过滤任何内容）。 */
export function messagesOfRecords(records) {
  if (!Array.isArray(records)) return [];
  return records.flatMap((record) => messagesOfRecord(record));
}

/**
 * 「会话正文」口径的消息：剔掉引擎自说自话。
 * ⚠ **行数 ≠ 轮数 ≠ 消息数**（#326 之后一个轮可以对应多行）：按轮渲染的投影要按 `round`
 * 聚合、按 `dedupKey` 去重（契约里的口径）；要「多少条消息」的宿主用本函数，别用 `records.length`。
 */
export function conversationMessages(records) {
  return messagesOfRecords(records).filter((message) => !isEngineNoteMessage(message));
}

function firstUserTextOfRecord(record) {
  for (const message of messagesOfRecord(record)) {
    // 引擎注入的控制文本在账本里就是 `role: "user"`（契约：投影保留底层角色）⇒
    // 不跳过的话 picker 会把「【Judge 评审意见】…」当成会话标题。
    if (message?.role !== "user" || isEngineNoteMessage(message)) continue;
    for (const block of message.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
        return truncateFirstUserText(block.text);
      }
    }
  }
  return undefined;
}

/**
 * picker 行预览：从 transcript 头部（上限 64 KiB）里找**第一条真实用户文本**。
 * 只用于展示，**任何失败都返回空串**——预览缺一行不是错误，不值得让选择器打不开。
 *
 * issue #326（wo-D）：改造前只看第一行 JSON。三类引擎事实行会插在任意一轮后面，
 * 而事实行的 `messages` 是空数组 ⇒ 「第一行不是正文」从不可能变成常见，picker 因此整片空条目
 * （实测：首行是 `:fold:` 行时预览 = 空串）。现在逐行扫到窗口末尾，跳过事实行与引擎自说自话。
 * 被 64 KiB 切断的**尾行不猜**（与改造前「首行没读完就不显示」同口径），半行 JSON 也不会被误读。
 */
export async function readFirstUserText(transcriptPath) {
  let handle;
  try {
    handle = await open(String(transcriptPath), "r");
    const buffer = Buffer.alloc(PREVIEW_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PREVIEW_READ_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    // 只有「读满了窗口」才说明尾行可能被切了一半 ⇒ 丢掉尾行不猜；
    // 没读满 = 拿到的是整个文件，缺个结尾换行不算截断（改造前的判据就是这个）。
    if (bytesRead >= PREVIEW_READ_BYTES && !text.endsWith("\n")) lines.pop();
    for (const line of lines) {
      if (line.trim() === "") continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // 坏行跳过（改造前是直接给空串，一个好行都不再看）
      }
      const preview = firstUserTextOfRecord(record);
      if (preview !== undefined) return preview;
    }
    return "";
  } catch {
    return "";
  } finally {
    await handle?.close?.().catch(() => {});
  }
}
