import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { candidateLines, captureToolExecution } from "./auto-capture.js";
import { looksLikeCredential } from "../skills/notes/credential-patterns.mjs";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TREE_ENTRIES = 500;
const OUTPUT_LIMIT = 4096;
// 尾部保留比例（截断时）：结局（报错 / exit / 汇总）留在尾部可见
const TRUNCATE_TAIL_SHARE = 0.25;
const ARCHIVE_THRESHOLD = 800;
const MAX_ARCHIVE_BYTES = 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const INSTALL_EXEC_TIMEOUT_MS = 300_000; // 安装/编译类命令（apt/pip/make 等）给更长时间
const EXEC_MAX_BUFFER = 1024 * 1024;

// 安装/编译/下载类命令前缀（benchmark 实测 apt-get install 频繁超时）
const INSTALL_COMMAND_PATTERN = /^(?:sudo\s+)?(?:apt-get|apt|pip\d?|pip3|npm|yarn|pnpm|make|cmake|gcc|g\+\+|cc|configure|bash\s+.*\.sh|curl|wget)\b/;

// These commands can produce a different value on every execution. Keep this
// list explicit so the archive policy can grow without changing capture logic.
export const NON_REPLAYABLE_COMMAND_PATTERNS = Object.freeze([
  /\/dev\/urandom\b/iu,
  /\$RANDOM\b/iu,
  /\bopenssl\s+rand\b/iu,
  /\buuidgen\b/iu,
  /\bdate\s+[^;&|]*\+%s%N\b/iu,
  /\bmktemp\b/iu,
  /\bshuf\b/iu,
  /\bhead\s+-c\s+\S+\s+\/dev\/urandom\b/iu,
]);

export function isNonReplayableCommand(command) {
  const text = String(command ?? "");
  return NON_REPLAYABLE_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

function declaredReplayability(name, input, declaration) {
  const value = typeof declaration === "function"
    ? declaration({ name, input })
    : declaration && typeof declaration === "object" && !Array.isArray(declaration)
      ? declaration[name]
      : declaration;
  return typeof value === "boolean" ? value : undefined;
}

function policyMatches(nonReplayable, command) {
  if (!nonReplayable || typeof nonReplayable !== "object") return false;
  if (typeof nonReplayable.classify === "function"
    && nonReplayable.classify(command) === true) {
    return true;
  }
  return Array.isArray(nonReplayable.patterns)
    && nonReplayable.patterns.some((pattern) => {
      if (pattern instanceof RegExp) {
        pattern.lastIndex = 0;
        return pattern.test(String(command ?? ""));
      }
      return typeof pattern === "string" && String(command ?? "").includes(pattern);
    });
}

/**
 * Resolve call-level replayability without treating an unmatched command as
 * an audited safe-to-replay operation.
 */
export function resolveReplayability(
  name,
  input,
  { declared, nonReplayable } = {},
) {
  const declaredValue = declaredReplayability(name, input, declared);
  if (declaredValue !== undefined) {
    return {
      replayable: declaredValue,
      replayableSource: "declared",
    };
  }
  const command = input?.command;
  if (policyMatches(nonReplayable, command)) {
    return {
      replayable: false,
      replayableSource: "policy",
    };
  }
  if (name === "exec" && isNonReplayableCommand(command)) {
    return {
      replayable: false,
      replayableSource: "heuristic",
    };
  }
  return {
    // Omit the boolean claim: unknown is neither safe nor unsafe by default.
    replayable: undefined,
    replayableSource: "unknown",
  };
}

// ERIX_EXEC_TIMEOUT_MS overrides the default timeout for foreground commands.
export function getExecTimeoutMs() {
  const configured = Number(process.env.ERIX_EXEC_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_EXEC_TIMEOUT_MS;
}

// 按命令类型选择超时：安装/编译/下载类命令超时更长（默认 300s），其余默认 120s。
export function getCommandTimeoutMs(command) {
  const base = getExecTimeoutMs();
  if (!INSTALL_COMMAND_PATTERN.test(String(command ?? "").trim())) return base;
  // 用户显式设置了全局超时则不放大（尊重显式配置）
  const configured = Number(process.env.ERIX_EXEC_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : INSTALL_EXEC_TIMEOUT_MS;
}

function normalizeNonNegativeInteger(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function splitLines(text) {
  if (text === "") return [];
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function normalizeSchema(schema) {
  const result = { ...schema };
  if (result.inputSchema === undefined && result.input_schema !== undefined) {
    result.inputSchema = result.input_schema;
    delete result.input_schema;
  }
  return result;
}

const schemas = [
  {
    name: "readFile",
    description: "Read a text file by line range.",
    replayable: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "rg",
    description: "Recursively search text files with a regular expression.",
    replayable: true,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        maxResults: { type: "integer" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "tree",
    description: "List a directory tree.",
    replayable: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        depth: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "writeFile",
    description: "Write UTF-8 text to any path.",
    replayable: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "exec",
    description: "Execute any shell command and return its output.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
].map(normalizeSchema);

export const CLI_TOOLS_SYSTEM_PROMPT =
  `可用工具：readFile 读取文本文件（支持行范围），rg 用正则递归搜索文本文件，tree 列出目录树，writeFile 写入 UTF-8 文本，exec 执行 shell 命令并返回输出。

[你的处境]
上下文会被折叠，早期细节你会真的忘记——不是记不清，是没有。
拿到后面还要用的具体值/决定时，立刻 note_take；
需要早期细节而想不起来时，先 note_list 再 note_read，不要猜。
非幂等命令（/dev/urandom、$RANDOM…）重跑会得到不同的值，
不得重跑"恢复"原值，不得凭记忆给值；确实不可恢复就明说不可恢复。
涉及捕获值时，终稿必须显式写出 label=value（或“label 值是 value”）。
首次捕获值可直接使用；后续重跑值必须附来源=note_read:<key> 或来源=归档:<文件名>。

[工具纪律]
- 复杂任务先规划并逐步执行；长任务用 todo 工具记录进度
- 大文件用 readFile 的 offset/limit 分段读取，操作后验证结果
- 具体数值必须来自当前工具返回、note_read 或捕获记录，不得编造
- 不要主动读取密钥、凭据或 .env 文件；只用本次工具返回明确给出的来源
- 任务完成后直接汇报结果，默认使用中文`;

export function buildCliToolsSystemPrompt(resourceStore) {
  // ADR-015：ResourceStore 退出模型视野——所有宿主形态同一份提示词，不提 opaque 工件/路径。
  void resourceStore;
  return CLI_TOOLS_SYSTEM_PROMPT;
}

export function buildArchiveNotice(archiveDir, resourceStore) {
  void resourceStore;
  if (typeof archiveDir !== "string" || archiveDir.length === 0) return "";
  return "\n\n[工具输出归档]\n大输出已由引擎全量归档。需要早期原文时用 recall({ pattern: \"关键词\" }) 取回，捕获值用 note_list/note_read 读取；禁止重跑非幂等命令或凭记忆补值。";
}




function resolveToolPath(root, value) {
  return path.resolve(root, value);
}

function expandHomePath(value) {
  if (value === "~") return homedir();
  if (typeof value === "string" && value.startsWith("~/")) {
    return path.resolve(homedir(), value.slice(2));
  }
  return value;
}

function normalizeToolInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  if (typeof input.path !== "string") return input;
  return { ...input, path: expandHomePath(input.path) };
}

function isBackgroundCommand(command) {
  return command.trim().endsWith("&");
}

function executeExecCommand(input, cwd) {
  const command = input?.command;
  if (typeof command !== "string") {
    return Promise.resolve("错误：命令必须是字符串");
  }

  if (isBackgroundCommand(command)) {
    const child = spawn(
      "/bin/sh",
      ["-c", command],
      { cwd, detached: true, stdio: "ignore" },
    );
    child.unref();
    return Promise.resolve(
      `服务已启动（PID ${child.pid ?? "未知"}）：${truncateDisplayText(command.trim(), 200)}`,
    );
  }

  const timeoutMs = getCommandTimeoutMs(command);
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: timeoutMs, maxBuffer: EXEC_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve("错误：命令输出超过 1MB 上限");
          return;
        }
        if (error?.killed || error?.code === "ETIMEDOUT") {
          resolve(`错误：命令超时（${timeoutMs}ms）被终止`);
          return;
        }

        const output = [stdout, stderr].filter(Boolean).join("");
        if (output) {
          resolve(output);
          return;
        }
        if (error) {
          resolve(`exit ${error.code ?? "未知"}（命令失败）`);
          return;
        }
        resolve("exit 0（无输出）");
      },
    );
  });
}

/**
 * Head+tail truncation for oversized tool output (host layer).
 *
 * 保留开头（命令上下文 / 第一条结果）与结尾（报错、exit 行、汇总），中间省略并标注字符数。
 * 之前的 head-only 截断会把尾部报错信息整段丢掉（issue #32 #2）。本函数不按工具名分支：
 * exec 结果经它截断；readFile 不经过它（自带 offset/limit 的 head+offset 窗口，行为不变）。
 *
 * @param {string} text
 * @param {number} limit 保留的总字符数上限（head + tail）
 * @param {string} omittedNote
 * @returns {string}
 */
export function headTailTruncate(text, limit, omittedNote) {
  if (text.length <= limit) return text;
  const tailLength = Math.max(1, Math.floor(limit * TRUNCATE_TAIL_SHARE));
  const headLength = Math.max(0, limit - tailLength);
  // 不切碎代理对（CJK 之外的 emoji 会占两个 UTF-16 单元）
  const head = text.slice(0, headLength).replace(/[\uD800-\uDBFF]$/u, "");
  const tail = text.slice(text.length - tailLength).replace(/^[\uDC00-\uDFFF]/u, "");
  const omitted = text.length - head.length - tail.length;
  return `${head}\n[${omittedNote(omitted, text.length)}]\n${tail}`;
}

export function truncateResult(result) {
  const text = String(result ?? "");
  if (/\n\[完整输出(?:已归档|归档失败)：[^\n]+\]$/u.test(text)) return text;
  return headTailTruncate(
    text,
    OUTPUT_LIMIT,
    (omitted, total) => `中间省略 ${omitted} 字符，共 ${total} 字符`,
  );
}

const TOOL_INPUT_LIMIT = 120;
const TOOL_RESULT_LIMIT = 200;
const TOOL_EXEC_RESULT_LIMIT = 4096;
const TOOL_FIELD_LIMIT = 80;
const SENSITIVE_INPUT_KEY = /(?:api[-_]?key|private[-_]?key|access[-_]?token|token|secret|password|authorization|credential)/iu;

function truncateDisplayText(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function summarizeToolInput(name, input) {
  if (
    input
    && typeof input === "object"
    && !Array.isArray(input)
    && (name === "exec" || name === "readFile" || name === "writeFile")
  ) {
    const primaryField = name === "exec" ? "command" : "path";
    if (typeof input[primaryField] === "string") {
      return truncateDisplayText(input[primaryField], TOOL_INPUT_LIMIT);
    }
  }

  const serialized = JSON.stringify(input, (key, value) => {
    if (key !== "" && SENSITIVE_INPUT_KEY.test(key)) return "[已隐藏]";
    return typeof value === "string"
      ? truncateDisplayText(value, TOOL_FIELD_LIMIT)
      : value;
  });
  return truncateDisplayText(serialized ?? input, TOOL_INPUT_LIMIT);
}

function summarizeToolResult(name, result) {
  const text = String(result ?? "");
  // exec 输出可能是验证/回归脚本的多行结果，必须完整可见（对齐 exec 内部 4096 截断）
  const limit = name === "exec" ? TOOL_EXEC_RESULT_LIMIT : TOOL_RESULT_LIMIT;
  // exec 日志同用 head+tail：尾部报错/exit 比中段 filler 有价值（issue #32 #2）
  return name === "exec"
    ? headTailTruncate(
      text,
      limit,
      (omitted, total) => `中间省略 ${omitted} 字符，共 ${total} 字符`,
    )
    : truncateDisplayText(text, limit);
}

function metadataWithPrivateOutput(metadata, fullOutput) {
  const result = { ...metadata };
  if (fullOutput !== undefined) {
    Object.defineProperty(result, "fullOutput", {
      value: fullOutput,
      enumerable: false,
      configurable: true,
    });
  }
  return result;
}

export function wrapExecuteTool(
  executeTool,
  {
    output = console.log,
    getToolMetadata,
    capture = captureToolExecution,
    notesScope,
    returnMetadata = false,
  } = {},
) {
  if (typeof executeTool !== "function") {
    throw new TypeError("executeTool must be a function");
  }
  if (typeof output !== "function") {
    throw new TypeError("output must be a function");
  }
  if (getToolMetadata !== undefined && typeof getToolMetadata !== "function") {
    throw new TypeError("getToolMetadata must be a function");
  }
  if (typeof capture !== "function") {
    throw new TypeError("capture must be a function");
  }

  // A one-argument wrapper makes runToolLoop pass its structured execution
  // context (toolUseId/round) while remaining compatible with direct callers.
  return async function wrappedExecuteTool(firstArg, positionalInput, positionalContext) {
    const structured = firstArg
      && typeof firstArg === "object"
      && !Array.isArray(firstArg)
      && typeof firstArg.name === "string";
    const name = structured ? firstArg.name : firstArg;
    const input = structured ? firstArg.input : positionalInput;
    const context = structured
      ? { ...(firstArg.context ?? {}), toolUseId: firstArg.id }
      : positionalContext;
    output(`→ ${name}: ${summarizeToolInput(name, input)}`);
    try {
      const result = await executeTool(name, input, context);
      const metadata = getToolMetadata?.();
      await capture({
        name,
        input,
        result,
        metadata,
        toolUseId: context?.toolUseId,
        round: context?.round,
        notesScope,
      });
      output(`← ${name}: ${summarizeToolResult(name, result)}`);
      if (returnMetadata && typeof getToolMetadata === "function") {
        const metadata = getToolMetadata() ?? {};
        return {
          data: result,
          ...(metadata.replayable === undefined ? {} : { replayable: metadata.replayable }),
          ...(metadata.replayableSource === undefined
            ? {}
            : { replayableSource: metadata.replayableSource }),
          ...(metadata.artifact === undefined ? {} : { artifact: metadata.artifact }),
          ...(metadata.artifactStatus === undefined ? {} : { artifactStatus: metadata.artifactStatus }),
          ...(metadata.rerunOf === undefined ? {} : { rerunOf: metadata.rerunOf }),
        };
      }
      return result;
    } catch (error) {
      output(`← ${name}: ${summarizeToolResult(name, `错误：${error?.message ?? String(error)}`)}`);
      throw error;
    }
  };
}

function archiveGuidance(display, resourceStore) {
  const reader = resourceStore === undefined
    ? "需要原始内容请用 readFile/cat 读取该路径"
    : "需要原始内容请用 ResourceStore 读取";
  const visibleDisplay = resourceStore === undefined
    ? display
    : "ResourceStore 中的 opaque locator";
  return `[完整输出已归档：${visibleDisplay}（${reader}；不要重跑命令，重跑会得到不同的值）]`;
}

function archiveFailureGuidance(archivePath, error, replayable, resourceStore) {
  if (replayable === false) {
    return "[完整输出归档失败：原始输出不可恢复；请勿重跑命令。]";
  }
  const reason = String(error?.message ?? error ?? "未知错误")
    .replaceAll(/\s+/gu, " ")
    .slice(0, 160);
  const visibleDisplay = resourceStore === undefined ? archivePath : "ResourceStore";
  return `[完整输出归档失败：${visibleDisplay}（${reason}）；请勿重跑命令。]`;
}

export function archiveResult(
  archiveDir,
  name,
  result,
  sequence,
  {
    force = false,
    replayable = true,
    replayableSource,
    command,
    context,
    resourceStore,
  } = {},
) {
  const text = String(result ?? "");
  if (!archiveDir || (!force && text.length <= ARCHIVE_THRESHOLD)) return null;

  let archivePath = path.join(
    archiveDir,
    `${String(sequence).padStart(3, "0")}-${name}.txt`,
  );
  let metadataPath = `${archivePath.slice(0, -".txt".length)}.meta.json`;
  const failedArchive = (error) => ({
    text: replayable !== false
      ? `${truncateResult(text)}\n${archiveFailureGuidance(
        archivePath,
        error,
        replayable,
        resourceStore,
      )}`
      : archiveFailureGuidance(archivePath, error, replayable, resourceStore),
    archivePath: undefined,
    artifact: undefined,
  });
  try {
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(text, "utf8");
    let archived = bytes;
    let truncated = false;
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
      const marker = Buffer.from(
        `\n[归档仅保留前 ${MAX_ARCHIVE_BYTES} 字节，原始输出共 ${bytes.byteLength} 字节]`,
        "utf8",
      );
      const prefixBudget = Math.max(0, MAX_ARCHIVE_BYTES - marker.byteLength);
      const characters = Array.from(text);
      let low = 0;
      let high = characters.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(characters.slice(0, middle).join(""), "utf8") <= prefixBudget) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      archived = Buffer.concat([
        Buffer.from(characters.slice(0, low).join(""), "utf8"),
        marker,
      ]);
      truncated = true;
    }
    const archivedText = archived.toString("utf8");
    const digest = createHash("sha256").update(archivedText, "utf8").digest("hex");
    const lineParts = archivedText.split(/\r\n|\r|\n/u);
    const lines = Math.max(
      1,
      lineParts.length - (archivedText.endsWith("\n") || archivedText.endsWith("\r") ? 1 : 0),
    );
    const saveArtifact = (reference, sequenceNumber) => {
      archivePath = path.join(
        archiveDir,
        `${String(sequenceNumber).padStart(3, "0")}-${name}.txt`,
      );
      metadataPath = `${archivePath.slice(0, -".txt".length)}.meta.json`;
      const artifact = {
        ...(resourceStore === undefined ? { archivePath } : {}),
        digest: reference?.digest ?? digest,
        ...(reference ?? { locator: { lineStart: 1, lineEnd: lines } }),
        artifactId: resourceStore === undefined
          ? path.basename(archivePath)
          : `resource:${reference?.digest ?? digest}`,
        round: context?.round ?? null,
        ...(replayable === undefined ? {} : { replayable }),
        ...(replayableSource === undefined ? {} : { replayableSource }),
        truncated,
        status: truncated ? "truncated" : "ok",
        originalBytes: bytes.byteLength,
      };
      const metadata = {
        kind: "erix.tool-capture",
        schemaVersion: 1,
        toolUseId: context?.toolUseId ?? null,
        round: context?.round ?? null,
        command: command ?? null,
        ...(replayable === undefined ? {} : { replayable }),
        ...(replayableSource === undefined ? {} : { replayableSource }),
        artifactId: artifact.artifactId,
        digest: artifact.digest,
        ...(artifact.archivePath === undefined ? {} : { archivePath: artifact.archivePath }),
        locator: artifact.locator,
        ...(artifact.display === undefined ? {} : { display: artifact.display }),
        truncated,
        status: artifact.status,
        originalBytes: bytes.byteLength,
      };
      const created = [];
      try {
        if (resourceStore === undefined) {
          writeFileSync(archivePath, archivedText, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
          created.push(archivePath);
        }
        writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        created.push(metadataPath);
        return {
          text: `${truncateResult(text)}\n${archiveGuidance(
            artifact.display ?? artifact.archivePath,
            resourceStore,
          )}`,
          ...(artifact.archivePath === undefined ? {} : { archivePath: artifact.archivePath }),
          artifact,
          archivedText,
          sequence: sequenceNumber,
        };
      } catch (error) {
        for (const target of created) {
          try {
            unlinkSync(target);
          } catch (cleanupError) {
            if (cleanupError?.code !== "ENOENT") error.cause = cleanupError;
          }
        }
        if (error?.code === "EEXIST") return undefined;
        throw error;
      }
    };
    for (let attempt = 0; attempt < Number.MAX_SAFE_INTEGER; attempt += 1) {
      const sequenceNumber = sequence + attempt;
      if (resourceStore === undefined) {
        const saved = saveArtifact(undefined, sequenceNumber);
        if (saved !== undefined) return saved;
        continue;
      }
      return resourceStore.put(archivedText)
        .then((reference) => {
          const saved = saveArtifact(reference, sequenceNumber);
          if (saved !== undefined) return saved;
          return resourceStore.put(archivedText).then((nextReference) => (
            saveArtifact(nextReference, sequenceNumber + 1)
          ));
        })
        .catch((error) => failedArchive(error));
    }
    throw new Error("archive sequence exhausted");
  } catch (error) {
    return failedArchive(error);
  }
}

function artifactStatus(artifact) {
  if (!artifact || typeof artifact.digest !== "string") return "unrecoverable";
  if (!artifact.archivePath) {
    return artifact.status === "truncated" ? "truncated" : "ok";
  }
  try {
    const contents = readFileSync(artifact.archivePath, "utf8");
    const digest = createHash("sha256").update(contents, "utf8").digest("hex");
    if (digest !== artifact.digest) return "stale";
    return artifact.truncated === true ? "truncated" : "ok";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    return "unrecoverable";
  }
}

function rerunGuidance({ count, firstValue, status }) {
  const displayValue = typeof firstValue === "string" && firstValue.length > 0
    ? firstValue
    : status === "ok" || status === "truncated"
      ? "见首次输出"
      : "不可恢复";
  return `[⚠️ 这是第 ${count} 次执行同一命令，值与首次可能不同；首次执行记录：${displayValue}；早期原文可 recall({ pattern: "关键词" }) 取回；不得把重跑值当作原值。]`;
}

function normalizeCommand(command) {
  return String(command).replaceAll(/\r\n?/gu, "\n").trim();
}

function archiveSequenceFromName(name) {
  const match = String(name).match(/^(\d+)-.+\.(?:txt|meta\.json)$/u);
  if (!match) return undefined;
  const sequence = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

function existingArchiveEntries(archiveDir) {
  try {
    return readdirSync(archiveDir)
      .map((name) => ({ name, sequence: archiveSequenceFromName(name) }))
      .filter((entry) => entry.sequence !== undefined);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
}

function initialArchiveSequence(archiveDir) {
  return existingArchiveEntries(archiveDir)
    .reduce((maximum, entry) => Math.max(maximum, entry.sequence), 0);
}

function artifactFromMetadata(archiveDir, metadata) {
  if (!metadata || typeof metadata !== "object"
    || typeof metadata.artifactId !== "string"
    || typeof metadata.digest !== "string") {
    return undefined;
  }
  return {
    artifactId: metadata.artifactId,
    ...(typeof metadata.archivePath === "string"
      ? { archivePath: metadata.archivePath }
      : {}),
    digest: metadata.digest,
    locator: metadata.locator,
    ...(typeof metadata.display === "string" ? { display: metadata.display } : {}),
    round: metadata.round ?? null,
    ...(metadata.replayable === undefined ? {} : { replayable: metadata.replayable }),
    ...(metadata.replayableSource === undefined
      ? {}
      : { replayableSource: metadata.replayableSource }),
    truncated: metadata.truncated === true,
    status: metadata.status ?? (metadata.truncated === true ? "truncated" : "ok"),
    ...(Number.isSafeInteger(metadata.originalBytes)
      ? { originalBytes: metadata.originalBytes }
      : {}),
  };
}

function hydrateArchiveIndex(archiveDir, duplicateCommands, knownArtifacts) {
  for (const entry of existingArchiveEntries(archiveDir)) {
    if (!entry.name.endsWith(".meta.json")) continue;
    const artifactId = entry.name.slice(0, -".meta.json".length) + ".txt";
    if (knownArtifacts.has(artifactId)) continue;
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(path.join(archiveDir, entry.name), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (typeof metadata.command !== "string") {
      knownArtifacts.add(artifactId);
      continue;
    }
    const artifact = artifactFromMetadata(archiveDir, {
      ...metadata,
      artifactId,
    });
    if (!artifact) {
      knownArtifacts.add(artifactId);
      continue;
    }
    const command = normalizeCommand(metadata.command);
    const state = duplicateCommands.get(command);
    if (state) {
      state.count += 1;
      const currentSequence = archiveSequenceFromName(state.firstArtifact?.artifactId) ?? Number.MAX_SAFE_INTEGER;
      if (entry.sequence < currentSequence) state.firstArtifact = artifact;
    } else {
      duplicateCommands.set(command, { count: 1, firstArtifact: artifact });
    }
    knownArtifacts.add(artifactId);
  }
}

function firstSafeArtifactValue(artifact, status) {
  if (!artifact?.archivePath || !["ok", "truncated"].includes(status)) return undefined;
  try {
    const output = readFileSync(artifact.archivePath, "utf8");
    return candidateLines(output).find(({ label, value }) => (
      !looksLikeCredential(label, value)
    ))?.value;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return undefined;
  }
}

export function createCliTools({
  cwd = process.cwd(),
  archiveDir,
  resourceStore,
  notesScope,
  runState: runStateOption,
  replayable,
  toolReplayability,
  nonReplayable,
} = {}) {
  const root = path.resolve(cwd);
  if (archiveDir !== undefined && typeof archiveDir !== "string") {
    throw new TypeError("archiveDir must be a string");
  }
  if (resourceStore !== undefined
    && (!resourceStore || typeof resourceStore.put !== "function"
      || typeof resourceStore.get !== "function")) {
    throw new TypeError("resourceStore must provide put and get methods");
  }
  const archiveRoot = archiveDir === undefined ? undefined : path.resolve(archiveDir);
  let archiveSequence = archiveRoot === undefined ? 0 : initialArchiveSequence(archiveRoot);
  const duplicateCommands = archiveRoot ? new Map() : undefined;
  const knownArchiveArtifacts = new Set();
  if (archiveRoot) hydrateArchiveIndex(archiveRoot, duplicateCommands, knownArchiveArtifacts);
  let lastToolMetadata;
  const runState = runStateOption && typeof runStateOption === "object"
    ? runStateOption
    : {};
  const declaredOption = toolReplayability ?? replayable;
  const schemaReplayability = Object.fromEntries(
    schemas
      .filter((schema) => typeof schema.replayable === "boolean")
      .map((schema) => [schema.name, schema.replayable]),
  );
  let captureCount = 0;

  async function readFile({ path: filePath, offset = 0, limit = 200 }) {
    const text = readFileSync(resolveToolPath(root, filePath), "utf8");
    const lines = splitLines(text);
    const start = normalizeNonNegativeInteger(offset, 0);
    const count = normalizeNonNegativeInteger(limit, 200);
    const selected = lines
      .slice(start, start + count)
      .map((line, index) => `${start + index + 1}: ${line}`);

    if (start + count < lines.length) {
      selected.push(`[共 ${lines.length} 行，offset=${start + count} 继续]`);
    }
    return selected.join("\n");
  }

  async function rg({ pattern, path: searchPath = ".", maxResults = 50 }) {
    const expression = new RegExp(String(pattern));
    const resultLimit = normalizeNonNegativeInteger(maxResults, 50);
    const resolvedSearchPath = resolveToolPath(root, searchPath);
    const displayBase = root;
    const results = [];
    const visitedDirectories = new Set();

    const displayName = (filePath) => {
      const relative = path.relative(displayBase, filePath);
      return (relative || path.basename(filePath)).split(path.sep).join("/");
    };

    const searchFile = (filePath, stat) => {
      if (results.length >= resultLimit || stat.size > MAX_FILE_BYTES) return;
      const bytes = readFileSync(filePath);
      if (bytes.includes(0)) return;
      const lines = splitLines(bytes.toString("utf8"));
      for (let index = 0; index < lines.length; index += 1) {
        expression.lastIndex = 0;
        if (!expression.test(lines[index])) continue;
        results.push(`${displayName(filePath)}:${index + 1}:${lines[index]}`);
        if (results.length >= resultLimit) return;
      }
    };

    const visit = (currentPath) => {
      if (results.length >= resultLimit) return;
      let stat;
      try {
        stat = statSync(currentPath);
      } catch {
        return; // 无法 stat 的路径（悬空 symlink、权限受限等）直接跳过
      }
      if (stat.isFile()) {
        searchFile(currentPath, stat);
        return;
      }
      if (!stat.isDirectory() || visitedDirectories.has(currentPath)) return;
      visitedDirectories.add(currentPath);

      let entries;
      try {
        entries = readdirSync(currentPath, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name));
      } catch {
        return; // 目录不可读时跳过
      }
      for (const entry of entries) {
        if (results.length >= resultLimit) return;
        if (entry.isSymbolicLink()) continue; // 跳过 symlink，避免跟随到特殊文件/死链
        visit(path.join(currentPath, entry.name));
      }
    };

    visit(resolvedSearchPath);
    return results.join("\n");
  }

  async function tree({ path: treePath = ".", depth = 3 }) {
    const resolvedTreePath = resolveToolPath(root, treePath);
    const maxDepth = normalizeNonNegativeInteger(depth, 3);
    const rootStat = statSync(resolvedTreePath);
    const rootLabel = treePath === "." ? "." : path.basename(resolvedTreePath);
    const lines = [rootLabel + (rootStat.isDirectory() ? "/" : "")];
    const visitedDirectories = new Set();
    let entries = 1;

    const visit = (currentPath, currentDepth) => {
      if (entries >= MAX_TREE_ENTRIES || currentDepth >= maxDepth) return;
      let stat;
      try {
        stat = statSync(currentPath);
      } catch {
        return;
      }
      if (!stat.isDirectory()) return;
      if (visitedDirectories.has(currentPath)) return;
      visitedDirectories.add(currentPath);

      let children;
      try {
        children = readdirSync(currentPath, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name));
      } catch {
        return;
      }
      for (const child of children) {
        if (entries >= MAX_TREE_ENTRIES) return;
        const childPath = path.join(currentPath, child.name);
        let childStat;
        try {
          childStat = statSync(childPath);
        } catch {
          continue; // 无法 stat 的条目（悬空 symlink 等）跳过
        }
        lines.push(`${"  ".repeat(currentDepth + 1)}${child.name}${childStat.isDirectory() ? "/" : ""}`);
        entries += 1;
        if (childStat.isDirectory()) visit(childPath, currentDepth + 1);
      }
    };

    if (rootStat.isDirectory()) {
      visit(resolvedTreePath, 0);
    }
    return lines.join("\n");
  }

  async function writeFile({ path: filePath, content }) {
    if (typeof content !== "string") {
      throw new TypeError("writeFile content must be a string");
    }
    const target = resolveToolPath(root, filePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return Buffer.byteLength(content, "utf8");
  }

  const executors = {
    readFile,
    rg,
    tree,
    writeFile,
    exec: (input) => executeExecCommand(input, root),
  };

  async function executeTool(name, input, context) {
    const executor = executors[name];
    if (typeof executor !== "function") {
      throw new Error(`未知工具：${name}`);
    }
    const normalizedInput = normalizeToolInput(input);
    const command = normalizedInput?.command;
    const replayability = resolveReplayability(name, normalizedInput, {
      declared: ({ name: declaredName, input: declaredInput }) => (
        declaredReplayability(declaredName, declaredInput, declaredOption)
          ?? schemaReplayability[declaredName]
      ),
      nonReplayable,
    });
    const replayableValue = replayability.replayable;
    const replayableSource = replayability.replayableSource;
    lastToolMetadata = {
      name,
      replayable: replayableValue,
      replayableSource,
    };
    let commandState;
    let isFirstCommandExecution = false;
    if (
      duplicateCommands
      && name === "exec"
      && typeof command === "string"
    ) {
      hydrateArchiveIndex(archiveRoot, duplicateCommands, knownArchiveArtifacts);
      const normalizedCommand = normalizeCommand(command);
      commandState = duplicateCommands.get(normalizedCommand);
      if (commandState) {
        commandState.count += 1;
      } else {
        commandState = {
          count: 1,
          firstArtifact: undefined,
        };
        duplicateCommands.set(normalizedCommand, commandState);
        isFirstCommandExecution = true;
      }
    }

    const result = await executor(normalizedInput);
    let returnedResult = result;
    // ADR-015 4a：输出档案角色整体退役给引擎（transcript toolOutputs + recall）。
    // ResourceStore 只保留 capture 证据角色：非重放 exec 才落 capture manifest（guard 核验专用）。
    const shouldArchive = archiveRoot !== undefined
      && name === "exec"
      && replayableValue === false;
    if (shouldArchive) {
      archiveSequence += 1;
      const archived = await archiveResult(archiveRoot, name, result, archiveSequence, {
        force: true,
        replayable: replayableValue,
        replayableSource,
        command,
        context,
        resourceStore,
      });
      if (archived !== null) {
        archiveSequence = Math.max(archiveSequence, archived.sequence ?? archiveSequence);
        lastToolMetadata = metadataWithPrivateOutput({
          name,
          replayable: replayableValue,
          replayableSource,
          artifact: archived.artifact,
          artifactStatus: archived.artifact?.status ?? "unrecoverable",
        }, archived.archivedText ?? String(result ?? ""));
        if (isFirstCommandExecution) commandState.firstArtifact = archived.artifact;
        if (archived.artifact?.artifactId) {
          knownArchiveArtifacts.add(archived.artifact.artifactId);
        }
        if (replayableValue === false && archived.artifact) {
          captureCount += 1;
          runState.captureCount = captureCount;
        }
      }
    }
    if (commandState?.count > 1) {
      const firstArtifact = commandState.firstArtifact;
      const status = artifactStatus(firstArtifact);
      const firstValue = firstSafeArtifactValue(firstArtifact, status)
        ?.split(/\r\n|\r|\n/u)[0]
        ?.replaceAll(/\s+/gu, " ")
        ?.slice(0, 200);
      runState.rerunDetected = true;
      lastToolMetadata = metadataWithPrivateOutput({
        ...lastToolMetadata,
        rerunOf: {
          round: firstArtifact?.round ?? null,
          artifactId: firstArtifact?.artifactId ?? null,
          digest: firstArtifact?.digest ?? null,
          status,
        },
        ...(firstArtifact ? { artifactStatus: lastToolMetadata?.artifactStatus ?? status } : {}),
      }, lastToolMetadata?.fullOutput);
      returnedResult = `${rerunGuidance({
        count: commandState.count,
        firstValue,
        status,
      })}\n${String(returnedResult ?? "")}`;
    }
    return returnedResult;
  }

  return {
    tools: schemas.map((schema) => structuredClone(schema)),
    executeTool,
    getLastToolMetadata: () => lastToolMetadata,
    getRunState: () => ({
      ...runState,
      captureCount,
      rerunDetected: runState.rerunDetected === true,
    }),
    truncateResult,
  };
}
