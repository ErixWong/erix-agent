// issue #75 引入、issue #168 T2 退役索引：CLI 会话发现层，现在**只剩选择路由 + picker**。
//
// 这里不再有任何持久状态：候选列表来自 `bin/session-scan.js` 的现扫现算（文件名里的目录哈希段
// 提供「按本目录」筛选，mtime 提供「最近」），`~/.erix/sessions.json` 与
// `~/.erix/session-meta.json` 自此**停读停写**（用户磁盘上已存在的这两个文件不主动删，
// 是惰性遗留文件，README 里写明可安全删除）。
//
// 退役同时消掉三类实测腐化（口径见 issue #168 实测表）：
// 1. LLM 调用失败的会话也被记进索引 → 被当成「可续跑的会话」；
// 2. transcript 被删而索引还在 → `-c` 静默选中幽灵会话继续跑，预览还停在旧值；
// 3. `session-meta.json` 丢失 → 重建出的条目永久无 cwd，`-c` 的按目录语义永久丢失。
// 三者都源于「有一份可以落后的状态」；没有状态就没有这类 bug。
//
// resume 判定仍以「显式 session id + store.load 非空」为准（bin/cli.js runChatWithNotes），
// 那条路径本模块一行不改。
import { homedir } from "node:os";
import { emitKeypressEvents } from "node:readline";

import {
  defaultTranscriptsDir,
  readFirstUserText,
  resolveContinueSessionId,
  scanSessions,
} from "./session-scan.js";

// picker 一次最多列出的条数：预览要逐个读 transcript 头部，给读取量一个上界；
// 超出的都是更旧的会话，需要时用 `--session <完整 id>` 精确恢复。
export const PICKER_LIMIT = 50;

class SessionSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionSelectionError";
    this.showHelp = true;
  }
}

// -c / -r 到 { session, sessionExplicit } 的解析。取消（picker Esc/Ctrl+C）返回 { cancelled: true }。
// 语义等价用户手动 --session <id>：sessionExplicit=true，走既有 resume 判定（并受 M1 的
// 「不存在就报错」约束——候选本来就来自扫描，正常不会踩到）。
export async function resolveChatSessionSelection(
  options,
  { home = homedir(), cwd = process.cwd(), input = process.stdin, output = process.stderr } = {},
) {
  if (options.continueSession !== true && options.resumePicker !== true) {
    return {
      session: options.session,
      sessionExplicit: options.sessionExplicit === true,
    };
  }

  const transcriptsDir = options.dir ?? defaultTranscriptsDir(home);
  if (options.continueSession === true) {
    const sessionId = await resolveContinueSessionId({ cwd, transcriptsDir });
    if (sessionId === null) {
      throw new SessionSelectionError(
        `没有可接续的会话：${cwd} 这个目录下没有非空 transcript。`
        + `\n可 --session <完整 id> 精确恢复（transcript 文件名去掉 .jsonl 就是 id；`
        + `目录名含空格/中文等不安全字符时文件名会被哈希成 run-h-*，那种 id 只能在 ${transcriptsDir} 里翻），`
        + `或不带 -c 直接新建会话。`,
      );
    }
    return { session: sessionId, sessionExplicit: true };
  }

  // -r：交互式 picker（列表与 -c 同源，同样是「本目录」的）
  if (input.isTTY !== true) {
    throw new SessionSelectionError("非交互终端不支持 -r 会话选择，请改用 -c/--continue 或 --session <id>");
  }
  const sessions = (await scanSessions({ cwd, transcriptsDir })).slice(0, PICKER_LIMIT);
  if (sessions.length === 0) {
    throw new SessionSelectionError(
      `没有可接续的会话：${cwd} 这个目录下没有非空 transcript（非规范 id 请改用 --session <完整 id>）。`,
    );
  }
  // 预览逐个补：读不到就是空串，不给 picker 添失败面
  for (const entry of sessions) {
    entry.firstUserText = await readFirstUserText(entry.transcriptPath);
  }
  const picked = await pickSession({ sessions, input, output });
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
  // 列表已按目录筛过，再列目录名没有信息量；列完整 id——选中后照抄就能 --session <完整 id>
  return `${cursor} ${formatTimestamp(entry.updatedAt)}  ${entry.sessionId}  ${entry.firstUserText ?? ""}`;
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
