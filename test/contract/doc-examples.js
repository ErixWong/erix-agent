// 契约文档示例可执行性检查 harness（issue #158）。
// 从 docs/host-consumer-contract.md 提取 ```js 围栏，做三层验证：
//   L1 语法：文档约定归一化后包进 (async () => {...})()，用 node:vm 编译（不执行）；
//   L2 链接：把 `from "erix-agent"` 重写为 src/index.js 的 file:// URL，写临时 .mjs
//            动态 import（示例体包进未调用函数，只验证真实符号可链接）；
//   L3 执行：同 L2 但真正执行示例体；对未 import 却引用真实符号/上下文的围栏，
//            前置注入 preamble（真实符号 + 最小 stub），独立子进程 spawnSync 跑，
//            超时 15s 即失败。
// 本文件是 harness（非 .test 后缀，故意不进 package.json files 白名单：宿主不需要）。
//
// 文档约定说明：契约文档用 TS 风格 `prop?,` 标注可选字段（如 `store?,`），这不是
// 合法 JS；本 harness 在三层验证前统一剥离该标记（正则见 stripDocConvention）。
// 另：fence :388 与 fence :1127 含顶层 `import ... from "erix-agent"`，L1 将其改写为
// `const { ... } = await import(...)` 以便 vm.Script 编译。

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const EN_DOC = join(REPO_ROOT, "docs", "host-consumer-contract.md");
export const CN_DOC = join(REPO_ROOT, "docs", "host-consumer-contract_cn.md");
export const INDEX_URL = pathToFileURL(join(REPO_ROOT, "src", "index.js")).href;
export const FAKE_PROVIDER_URL = pathToFileURL(
  join(REPO_ROOT, "test", "helpers", "fake-provider.js"),
).href;

export const EXPECTED_JS_FENCE_COUNT = 7;
export const L3_TIMEOUT_MS = 15000;

/** 提取 markdown 中所有 ```js 围栏 → [{ line, code }]（line 为围栏起始行号，1-based）。 */
export function extractJsFences(filePath) {
  const lines = readFileSync(filePath, "utf8").split("\n");
  const fences = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (current === null && /^\s{0,3}```js\b/.test(line)) {
      current = { line: index + 1, codeLines: [] };
      continue;
    }
    if (current !== null && /^\s{0,3}```\s*$/.test(line)) {
      fences.push({ line: current.line, code: current.codeLines.join("\n"), file: filePath });
      current = null;
      continue;
    }
    if (current !== null) current.codeLines.push(line);
  }
  return fences;
}

/** 剥离 TS 风格可选属性标记 `prop?,` / `prop? }` → `prop,` / `prop }`。 */
export function stripDocConvention(code) {
  return code.replace(/(\b[A-Za-z_$][\w$]*)\?(?=\s*[,}])/g, "$1");
}

function rewriteErixSpecifier(specifier) {
  return specifier === "erix-agent" ? INDEX_URL : specifier;
}

const TOP_LEVEL_IMPORT_RE = /^import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["'];?\s*$/;

/** 拆出顶层 import 行（重写 erix-agent 说明符）与剩余主体。 */
export function splitImports(code) {
  const imports = [];
  const rest = [];
  for (const line of code.split("\n")) {
    const match = TOP_LEVEL_IMPORT_RE.exec(line.trim());
    if (match) {
      const clause = line.trim().slice("import ".length, line.trim().lastIndexOf("from")).trim();
      imports.push(`import ${clause} from ${JSON.stringify(rewriteErixSpecifier(match[1]))};`);
    } else {
      rest.push(line);
    }
  }
  return { imports, body: rest.join("\n"), hasImports: imports.length > 0 };
}

/** 为 L1 编译准备：顶层 import 改写为 async IIFE 内可编译的 `const {..} = await import(..)`。 */
function toScriptBody(code) {
  const { imports, body, hasImports } = splitImports(code);
  if (!hasImports) return body;
  const converted = imports.map((statement) => {
    const match = /^import (.+) from (".*");$/.exec(statement);
    return `const ${match[1]} = await import(${match[2]});`;
  }).join("\n");
  return `${converted}\n${body}`;
}

/** L1：语法编译（不执行）。失败抛错由调用方包装成报告。 */
export function compileLevel1(fence) {
  const script = stripDocConvention(fence.code);
  const wrapped = `(async () => {\n${toScriptBody(script)}\n})`;
  return new vm.Script(wrapped, { filename: `${filePathFor(fence)}:${fence.line}` });
}

function filePathFor(fence) {
  return fence.file ?? EN_DOC;
}

// ---------------------------------------------------------------------------
// 每个围栏的 preamble（按 EN 文档围栏序号定位；数量漂移由 test 入口先断言）。
// linkImports: L2/L3 顶层注入的真实符号 import（验证导出存在 + 供主体引用）。
// stubs:       L3 执行期注入的最小上下文（纯 node: 内置 + 已注入符号构造）。
// epilogue:    L3 主体执行后的完成性断言（证明示例真的跑到了底）。
// ---------------------------------------------------------------------------
export const FENCE_PREAMBLES = [
  // fence #0（EN :50，executeTool 调用形状签名片段）
  {
    linkImports: [],
    stubs: `
const __calls__ = [];
const executeTool = async (execution) => { __calls__.push(execution?.name ?? "<anonymous>"); return "stub-result"; };
const id = "doc-example-call-1";
const name = "probe_tool";
const input = { probe: true };
const context = {};
const signal = undefined;
`,
    epilogue: `
if (__calls__.length !== 1) throw new Error(\`executeTool stub 应被调用 1 次，实际 \${__calls__.length} 次\`);
`,
  },
  // fence #1（EN :70，provider 请求注入口 defaultHeaders / extraBody，issue #181）
  {
    linkImports: [
      `import { createAnthropicProvider, createOpenAIProvider } from ${JSON.stringify(INDEX_URL)};`,
    ],
    stubs: `
const __requests__ = [];
const endpoint = "https://doc-example.test/v1";
const apiKey = "doc-example-key";
const model = "doc-example-model";
const runId = \`doc-example-injection-\${process.pid}-\${Date.now()}\`;
const sessionId = "doc-example-session";
const fde = "fde-a";
const messages = [{ role: "user", content: [{ type: "text", text: "doc example" }] }];
// provider 的 fetchImpl 默认就是 globalThis.fetch，且默认值在构造时求值：
// stubs 先于示例体执行，因此这里的桩能接住真实出门的请求。
globalThis.fetch = async (url, options) => {
  __requests__.push({ url, options });
  return {
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [{ message: { content: "doc-example done" }, finish_reason: "stop" }],
      });
    },
  };
};
`,
    epilogue: `
if (__requests__.length !== 1) throw new Error(\`provider 应发起 1 次请求，实际 \${__requests__.length} 次\`);
const __options__ = __requests__[0].options ?? {};
const __headers__ = __options__.headers ?? {};
if (__headers__.Authorization !== \`Bearer \${apiKey}\`) throw new Error("引擎自有 Authorization 丢了");
if (__headers__["X-Station-Run-Id"] !== runId) throw new Error("defaultHeaders 未出现在实际请求头");
const __body__ = JSON.parse(__options__.body ?? "{}");
if (__body__.model !== model) throw new Error("extraBody 不得覆盖引擎 model");
if (__body__.user !== \`\${fde}:\${sessionId}\`) throw new Error("extraBody.user 未出现在请求体");
if ("stream" in __body__) throw new Error("非流式调用不得出现 stream 字段");
`,
  },
  // fence #2（EN :118，createAssemblyPort + runToolLoop）
  {
    linkImports: [
      `import { createAssemblyPort, runToolLoop, createMemoryTranscriptStore } from ${JSON.stringify(INDEX_URL)};`,
      `import { createFakeProvider } from ${JSON.stringify(FAKE_PROVIDER_URL)};`,
    ],
    stubs: `
const modelConfig = { async resolve() { return { model: "doc-example-model", contextWindowTokens: 200000, maxOutputTokens: 1024 }; } };
const provider = createFakeProvider([{ content: [{ type: "text", text: "doc-example done" }], stopReason: "end_turn" }]);
const definitions = [];
const executeTool = async () => "unused";
const getToolMetadata = undefined;
const store = createMemoryTranscriptStore();
const id = \`doc-example-assembly-\${process.pid}-\${Date.now()}\`;
const resume = undefined;
const initialMessages = undefined;
const policy = {};
const emit = () => {};
`,
    epilogue: `
if (provider.requests.length < 1) throw new Error("runToolLoop 未发起任何 provider 调用（示例体没跑到底）");
`,
  },
  // fence #3（EN :388，多模型槽位装配 + 预算元数据自检，issue #182）
  // 本围栏自带顶层 import：真文件 provider + 真 openai provider + 真 runToolLoop 全链路
  // 执行，只把磁盘（tmpdir 里的 config.json）与网络（fetch 桩）接桩。
  {
    linkImports: [],
    stubs: `
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir as __osTmpdir } from "node:os";
import { join as __join } from "node:path";
const __slotsDir__ = mkdtempSync(__join(__osTmpdir(), "doc-example-slots-"));
const configPath = __join(__slotsDir__, "config.json");
writeFileSync(configPath, JSON.stringify({ slots: {
  default: {
    protocol: "openai",
    endpoint: "https://doc-gateway.test/v1",
    apiKeyEnv: "ERIX_DOC_EXAMPLE_KEY",
    model: "doc-big-model",
    contextWindowTokens: 200000,
    maxOutputTokens: 8192,
    maxTokens: 2048,
    temperature: 0.2,
  },
  triage: {
    protocol: "openai",
    endpoint: "https://doc-gateway.test/v1",
    apiKeyEnv: "ERIX_DOC_EXAMPLE_KEY",
    model: "doc-small-model",
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    maxTokens: 1024,
    temperature: 0,
  },
} }));
// apiKeyEnv 间接引用在 resolve() 时被物化（ADR-001），桩先于示例体生效。
process.env.ERIX_DOC_EXAMPLE_KEY = "doc-example-key";
const run = { id: \`doc-example-slots-\${process.pid}-\${Date.now()}\`, triage: true, prompt: "doc example task" };
const executeTool = async () => "doc-example-tool-result";
const __requests__ = [];
// provider 在构造时取 globalThis.fetch 作为默认值，桩能接住真实出门的请求。
globalThis.fetch = async (url, options) => {
  __requests__.push({ url, options });
  return {
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [{ message: { content: "doc-example done" }, finish_reason: "stop" }],
      });
    },
  };
};
`,
    epilogue: `
// 「本 run 没发 model_metadata_missing」现在由示例自身的启动前预检把守（issue #173 后
// onEvent 抛错不再是拒 run 的机制；示例改成装配后 abort，abort 真发生则整个 run 抛错）。
// 这里只能看 stub 作用域的量（示例体跑在函数里，局部量不外泄）。
// 这里只能看 stub 作用域的量（示例体跑在函数里，局部量不外泄）。
if (__requests__.length !== 1) throw new Error(\`provider 应发起 1 次请求，实际 \${__requests__.length} 次\`);
const __body__ = JSON.parse(__requests__[0]?.options?.body ?? "{}");
// per-run 选槽真的生效：出门的 model / max_tokens / temperature 全部来自 triage 槽。
if (__body__.model !== "doc-small-model") {
  throw new Error(\`per-run 选槽未生效，实际 model=\${String(__body__.model)}\`);
}
if (__body__.max_tokens !== 1024) {
  throw new Error(\`triage 槽的 maxTokens 未跟着模型走，实际 max_tokens=\${String(__body__.max_tokens)}\`);
}
if (__body__.temperature !== 0) {
  throw new Error(\`triage 槽的 temperature 未跟着模型走，实际 temperature=\${String(__body__.temperature)}\`);
}
if (!String(__requests__[0]?.options?.headers?.Authorization ?? "").startsWith("Bearer doc-example-key")) {
  throw new Error("apiKeyEnv 未在 resolve() 时物化为 Authorization 头");
}
if (!__body__.messages || !Array.isArray(__body__.messages)) throw new Error("请求体缺 messages：循环未真正跑起来");
rmSync(__slotsDir__, { recursive: true, force: true });
`,
  },
  // fence #4（EN :772，store.list 返回 plain array）
  {
    linkImports: [],
    stubs: `
const __listQueries__ = [];
const store = { async list(query) { __listQueries__.push(query); return []; } };
const scopeRef = "doc-example-notes-run";
const limit = 20;
const filters = { state: "active" };
const sort = "relevance";
`,
    epilogue: `
if (__listQueries__.length !== 1) throw new Error(\`store.list 应被调用 1 次，实际 \${__listQueries__.length} 次\`);
if (__listQueries__[0]?.scope !== "run") throw new Error("store.list 查询 scope 应为 \\"run\\"");
`,
  },
  // fence #5（EN :854，createBuiltinNotesTools 接线）
  {
    linkImports: [
      `import { createBuiltinNotesTools } from ${JSON.stringify(INDEX_URL)};`,
    ],
    stubs: `
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir as __osTmpdir } from "node:os";
import { join as __join } from "node:path";
const __notesDir__ = mkdtempSync(__join(__osTmpdir(), "doc-example-notes-"));
const __reportedFailures__ = [];
const __loopOptions__ = [];
const runId = \`doc-example-notes-\${process.pid}-\${Date.now()}\`;
const notesDir = __notesDir__;
const notesStore = undefined;
const hostTools = [];
const notesToolNames = new Set();
const hostExecuteTool = async () => "host-tool-result";
const hostReportCompletionError = (operation, error) => { __reportedFailures__.push({ operation, error }); };
// 本围栏演示的是 notes 接线而非 loop 本身：runToolLoop 用桩捕获 options 并逐条驱动
// tools/executeTool/semanticStateProvider，让 notes 真实写盘（tmpdir notesDir）。
const runToolLoop = async (options) => {
  __loopOptions__.push(options);
  for (const tool of options.tools ?? []) notesToolNames.add(tool.name);
  const drive = async (toolName, toolInput) => options.executeTool({
    id: \`doc-call-\${toolName}\`, name: toolName, input: toolInput,
    context: { reportPersistenceFailure: () => {} }, signal: undefined,
  });
  for (const toolName of ["note_take", "note_list"]) {
    if (!notesToolNames.has(toolName)) throw new Error(\`接线缺少 notes 工具 \${toolName}\`);
    await drive(toolName, { key: "doc-example-key", content: "doc example value", limit: 5 });
  }
  await options.executeTool({ id: "doc-call-host", name: "host_tool", input: {}, context: {}, signal: undefined });
  await options.semanticStateProvider({ state: { stateVersion: 1 }, reportPersistenceFailure: () => {} });
  return { status: "completed" };
};
`,
    epilogue: `
if (__loopOptions__.length !== 1) throw new Error("runToolLoop 桩应恰好被调用 1 次");
const __captured__ = __loopOptions__[0];
if (!Array.isArray(__captured__.tools) || !__captured__.tools.some((tool) => tool.name === "note_take")) {
  throw new Error("示例未把 notes.definitions 接入 tools");
}
if (typeof __captured__.semanticStateProvider !== "function") throw new Error("semanticStateProvider 未接线");
if (__reportedFailures__.length !== 0) {
  throw new Error(\`onRunComplete 报告了失败: \${JSON.stringify(__reportedFailures__.map((f) => f.operation))}\`);
}
if (readdirSync(__notesDir__).length === 0) throw new Error("note_take 未在 tmpdir notesDir 落盘任何记录");
rmSync(__notesDir__, { recursive: true, force: true });
`,
  },
  // fence #6（EN :1127，projectTranscriptForDisplay 展示投影）
  {
    linkImports: [],
    stubs: `
const __storeLoads__ = { count: 0 };
const runId = "doc-example-projection-run";
const store = { async load() {
  __storeLoads__.count += 1;
  return [
    { round: 2, messages: [{ role: "user", content: [{ type: "tool_result", toolCallId: "t1", content: "42" }] }],
      response: { content: [{ type: "text", text: "答案是 42" }], stopReason: "end_turn" },
      ts: "2026-01-01T00:00:02.000Z" },
    { round: 1, messages: [{ role: "user", content: [{ type: "text", text: "帮我算一下" }] }],
      response: { content: [{ type: "text", text: "我来算" },
        { type: "tool_call", id: "t1", name: "calc", input: { expression: "6*7" } }], stopReason: "tool_use" },
      ts: "2026-01-01T00:00:01.000Z" },
  ];
} };
`,
    epilogue: `
if (__storeLoads__.count !== 1) throw new Error(\`store.load 应被调用 1 次，实际 \${__storeLoads__.count} 次\`);
`,
  },
];

// ---------------------------------------------------------------------------
// 临时 .mjs 生成与执行
// ---------------------------------------------------------------------------

function preambleFor(fence) {
  const preamble = FENCE_PREAMBLES[fence.index];
  if (!preamble) throw new Error(`第 ${fence.index} 个围栏没有 preamble 配置`);
  return preamble;
}

/** 组装 L2（只链接）程序源码。 */
export function buildLinkProgram(fence) {
  const { linkImports } = preambleFor(fence);
  const normalized = stripDocConvention(fence.code);
  const { imports, body } = splitImports(normalized);
  return [
    ...linkImports,
    ...imports,
    "// 示例体包进未调用的函数：只验证模块可解析、真实符号可链接",
    "async function __docExampleBody__() {",
    body,
    "}",
    'console.log("__DOC_EXAMPLE_LINK_OK__");',
    "",
  ].join("\n");
}

/** 组装 L3（真实执行）程序源码。 */
export function buildExecProgram(fence) {
  const { linkImports, stubs, epilogue } = preambleFor(fence);
  const normalized = stripDocConvention(fence.code);
  const { imports, body } = splitImports(normalized);
  return [
    ...linkImports,
    ...imports,
    stubs,
    "async function __docExampleMain__() {",
    body,
    "}",
    "await __docExampleMain__();",
    epilogue,
    'console.log("__DOC_EXAMPLE_EXEC_OK__");',
    "",
  ].join("\n");
}

/** L2：动态 import 临时 .mjs（不执行示例体）。返回 { ok, error? }。 */
export async function runLevel2(fence) {
  const source = buildLinkProgram(fence);
  const dir = mkdtempSync(join(tmpdir(), "doc-examples-"));
  const file = join(dir, `link-${fence.line}-${fence.index}.mjs`);
  try {
    writeFileSync(file, source);
    await import(pathToFileURL(file).href);
    return { ok: true };
  } catch (error) {
    return { ok: false, stderr: `${error?.stack ?? error}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** L3：子进程执行临时 .mjs（spawnSync，timeout 15s）。返回 { ok, stdout, stderr }。 */
export function runLevel3(fence) {
  const source = buildExecProgram(fence);
  const dir = mkdtempSync(join(tmpdir(), "doc-examples-"));
  const file = join(dir, `exec-${fence.line}-${fence.index}.mjs`);
  try {
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [file], {
      encoding: "utf8",
      timeout: L3_TIMEOUT_MS,
      cwd: REPO_ROOT,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    let ok = result.status === 0 && stdout.includes("__DOC_EXAMPLE_EXEC_OK__");
    let finalStderr = stderr;
    if (result.error) finalStderr = `${result.error.message}\n${finalStderr}`;
    if (result.signal) finalStderr = `子进程被信号 ${result.signal} 终止（超时上限 ${L3_TIMEOUT_MS}ms）\n${finalStderr}`;
    return { ok, stdout, stderr: finalStderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 统一失败信息：文件路径 + 围栏起始行号 + 前几行预览 + 失败层级 + stderr。 */
export function describeFailure(fence, level, details) {
  const preview = fence.code.split("\n").slice(0, 4)
    .map((line) => `    | ${line}`)
    .join("\n");
  return [
    `[${level}] ${filePathFor(fence)}:${fence.line} 第 ${fence.index + 1} 个 js 围栏校验失败`,
    `代码预览（前 4 行）：`,
    preview,
    details === undefined ? "" : `失败详情：\n${details}`,
  ].filter((part) => part !== "").join("\n");
}

/** 代码骨架：剥离注释与空行差异，用于 CN/EN 一致性（代码不翻译，注释允许本地化）。 */
export function codeSkeleton(code) {
  return code
    .split("\n")
    .map((line) => line.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/, "").trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n");
}
