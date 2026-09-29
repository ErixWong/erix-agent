// issue #75：CLI 会话发现层。sessions 索引（~/.erix/sessions.json）是缓存不是真相：
// resume 判定仍以「显式 session id + store.load 非空」为准（bin/cli.js runChatWithNotes），
// 本模块一行不改那条路径。索引丢失/损坏时用 readdir transcripts 目录重建
//（只认 *.jsonl，排除 .state.json/.checkpoint.json；safeRunId 哈希文件名 run-h-*
// 不可往返，跳过）。所有写入失败静默——缓存性质，不影响主流程。

import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";

import { safeRunId } from "../src/store/file.js";

export const FIRST_USER_TEXT_MAX = 80;
// 索引条目上限：防 unbounded 增长；重建时也只保留最近的一批
const INDEX_ENTRY_LIMIT = 500;
// 重建时从每个 transcript 头扫的行数上限（firstUserText 通常在很前面）
const REBUILD_SCAN_LINES = 200;

export function truncateFirstUserText(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > FIRST_USER_TEXT_MAX
    ? `${value.slice(0, FIRST_USER_TEXT_MAX)}…`
    : value;
}

export function sessionsIndexPath(home) {
  return path.join(String(home), ".erix", "sessions.json");
}

// 读取索引；文件缺失或损坏时返回 rebuilt=true（此时 entries 来自 rebuild）。
export async function readSessionsIndex({ home, transcriptsDir }) {
  try {
    const raw = await readFile(sessionsIndexPath(home), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new TypeError("sessions index must be an array");
    return { entries: sanitizeEntries(parsed), rebuilt: false };
  } catch {
    const entries = await rebuildSessionsIndex({ home, transcriptsDir });
    return { entries, rebuilt: true };
  }
}

function sanitizeEntries(list) {
  return list
    .filter((entry) => (
      entry
      && typeof entry.sessionId === "string"
      && entry.sessionId.length > 0
    ))
    .map((entry) => ({
      sessionId: entry.sessionId,
      ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
      updatedAt: normalizeTimestamp(entry.updatedAt),
      ...(typeof entry.firstUserText === "string" && entry.firstUserText.length > 0
        ? { firstUserText: entry.firstUserText }
        : {}),
    }));
}

function normalizeTimestamp(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date(0).toISOString();
}

// readdir transcripts 目录派生索引。只认 *.jsonl；跳过 run-h-*（safeRunId 哈希，
// 无法还原原始 session id）；cwd 无法从 transcript 可靠恢复，故重建条目不含 cwd。
export async function rebuildSessionsIndex({ home, transcriptsDir }) {
  let files;
  try {
    files = await readdir(String(transcriptsDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = files
    .filter((file) => file.isFile())
    .map((file) => file.name)
    .filter((name) => name.endsWith(".jsonl"))
    .filter((name) => {
      const sessionId = name.slice(0, -".jsonl".length);
      // 可往返才收录：哈希化文件名无法恢复用户原始 session id
      return safeRunId(sessionId) === sessionId;
    });

  const entries = [];
  for (const name of candidates) {
    const filePath = path.join(String(transcriptsDir), name);
    try {
      const info = await stat(filePath);
      const sessionId = name.slice(0, -".jsonl".length);
      entries.push({
        sessionId,
        updatedAt: info.mtime.toISOString(),
        ...(await extractFirstUserText(filePath)),
      });
    } catch {
      // 单个文件读失败（竞态删除等）不影响整体重建
    }
  }
  entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  await writeIndex(home, entries.slice(0, INDEX_ENTRY_LIMIT));
  return entries.slice(0, INDEX_ENTRY_LIMIT);
}

async function extractFirstUserText(filePath) {
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let scanned = 0;
    let result = {};
    for await (const line of rl) {
      scanned += 1;
      if (scanned > REBUILD_SCAN_LINES) break;
      const text = firstUserTextOfRecord(line);
      if (text !== undefined) {
        result = { firstUserText: text };
        break;
      }
    }
    rl.close();
    return result;
  } catch {
    return {};
  }
}

function firstUserTextOfRecord(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  const messages = record?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (message?.role !== "user") continue;
    for (const block of message.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
        return truncateFirstUserText(block.text);
      }
    }
  }
  return undefined;
}

async function writeIndex(home, entries) {
  const target = sessionsIndexPath(home);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(
      temporary,
      `${JSON.stringify(entries, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, target);
  } catch {
    // 写入失败静默：索引是缓存，不影响主流程；残留 tmp 尽力清理，失败也静默
    try {
      await unlink(temporary);
    } catch {
      // ignore
    }
  }
}

// chat / repl 每次运行 upsert（同 sessionId 覆盖）。写入失败静默。
export async function upsertSessionIndex({ home, sessionId, cwd, firstUserText }) {
  if (typeof sessionId !== "string" || sessionId.trim() === "") return;
  let entries = [];
  try {
    const parsed = JSON.parse(await readFile(sessionsIndexPath(home), "utf8"));
    if (Array.isArray(parsed)) entries = sanitizeEntries(parsed);
  } catch {
    entries = [];
  }
  const next = {
    sessionId,
    ...(typeof cwd === "string" ? { cwd } : {}),
    updatedAt: new Date().toISOString(),
    ...(typeof firstUserText === "string" && firstUserText.length > 0
      ? { firstUserText }
      : {}),
  };
  entries = [next, ...entries.filter((entry) => entry.sessionId !== sessionId)];
  entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  await writeIndex(home, entries.slice(0, INDEX_ENTRY_LIMIT));
}

// chat/repl 运行记录入口：prompt 截断为 firstUserText。静默、绝不抛出。
export async function recordChatSession({ home, sessionId, cwd, prompt }) {
  if (typeof prompt !== "string" || prompt.trim() === "") return;
  try {
    await upsertSessionIndex({
      home,
      sessionId,
      cwd: typeof cwd === "string" ? path.resolve(cwd) : cwd,
      firstUserText: truncateFirstUserText(prompt),
    });
  } catch {
    // 静默：缓存性质
  }
}

// -c/--continue：索引中当前 cwd 最近一条；索引缺失/损坏时内部 rebuild。
// 无可续会话返回 null（调用方报清晰错误，不静默新建）。
export async function resolveContinueSessionId({ home, cwd, transcriptsDir }) {
  const { entries } = await readSessionsIndex({ home, transcriptsDir });
  const normalized = path.resolve(String(cwd));
  const match = entries
    .filter((entry) => entry.cwd === normalized)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  return match?.sessionId ?? null;
}

class SessionSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionSelectionError";
    this.showHelp = true;
  }
}

// -c / -r 到 { session, sessionExplicit } 的解析。取消（picker Esc/Ctrl+C）返回 { cancelled: true }。
// 语义等价用户手动 --session <id>：sessionExplicit=true，走既有 resume 判定。
export async function resolveChatSessionSelection(
  options,
  { home = homedir(), cwd = process.cwd(), input = process.stdin, output = process.stderr } = {},
) {
  const fallback = {
    session: options.session,
    sessionExplicit: options.sessionExplicit === true,
  };
  if (options.continueSession !== true && options.resumePicker !== true) {
    return fallback;
  }

  const transcriptsDir = options.dir ?? path.join(home, ".erix", "transcripts");
  if (options.continueSession === true) {
    const sessionId = await resolveContinueSessionId({ home, cwd, transcriptsDir });
    if (sessionId === null) {
      throw new SessionSelectionError("没有可接续的会话（当前目录下没有历史会话记录）");
    }
    return { session: sessionId, sessionExplicit: true };
  }

  // -r：交互式 picker
  if (input.isTTY !== true) {
    throw new SessionSelectionError("非交互终端不支持 -r 会话选择，请改用 -c/--continue 或 --session <id>");
  }
  const { entries } = await readSessionsIndex({ home, transcriptsDir });
  if (entries.length === 0) {
    throw new SessionSelectionError("没有可接续的会话（当前目录下没有历史会话记录）");
  }
  const picked = await pickSession({ sessions: entries, input, output });
  if (picked === null) return { cancelled: true };
  return { session: picked, sessionExplicit: true };
}

function formatTimestamp(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "----/--/--";
  const date = new Date(time);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatRow(entry, selected) {
  const cursor = selected ? "❯" : " ";
  const cwdLabel = entry.cwd ? path.basename(entry.cwd) : "（未知目录）";
  const preview = entry.firstUserText ?? "";
  return `${cursor} ${formatTimestamp(entry.updatedAt)}  ${cwdLabel}  ${preview}`;
}

// 零依赖交互式 picker：readline emitKeypressEvents + raw mode。
// 方向键移动，Enter 选中，Esc/Ctrl+C 取消（resolve null）。
export async function pickSession({ sessions, input = process.stdin, output = process.stderr }) {
  const list = [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  if (list.length === 0) return null;

  return new Promise((resolve) => {
    let selected = 0;
    let renderedRows = 0;
    let settled = false;

    const cleanup = () => {
      input.off("keypress", onKeypress);
      if (typeof input.setRawMode === "function") input.setRawMode(false);
      output.write("\x1b[?25h\n"); // 恢复光标
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const render = () => {
      if (renderedRows > 0) {
        output.write(`\x1b[${renderedRows}A`);
      }
      output.write("\x1b[?25l");
      output.write("选择要接续的会话（↑/↓ 移动，Enter 选中，Esc 取消）：\n");
      const rows = list.map((entry, index) => formatRow(entry, index === selected));
      output.write(`${rows.join("\n")}\n`);
      renderedRows = rows.length + 1;
    };

    const onKeypress = (_chunk, key = {}) => {
      if (key.name === "up") {
        selected = (selected - 1 + list.length) % list.length;
        render();
      } else if (key.name === "down") {
        selected = (selected + 1) % list.length;
        render();
      } else if (key.name === "return") {
        finish(list[selected]?.sessionId ?? null);
      } else if (key.name === "escape" || (key.ctrl === true && key.name === "c")) {
        finish(null);
      }
    };

    if (typeof input.setRawMode === "function") input.setRawMode(true);
    emitKeypressEvents(input);
    input.on("keypress", onKeypress);
    render();
  });
}
