// 文档示例可执行性检查 harness（issue #158，issue #576 把两份根 README 纳入同一套三层验证）。
// 从「目标文档」提取 ```js 围栏，做三层验证：
//   目标文档 = 两份契约文档（docs/host-consumer-contract{,_cn}.md）+ 两份根 README
//   （README.md / README_cn.md，issue #576：README 的快速开始从前只被拼写扫描看过一眼，
//   从来没有被执行过）。每个目标自带**自己的**围栏数期望与 preamble 表——不再共用一个
//   `EXPECTED_JS_FENCE_COUNT` 语义（`DOC_TARGETS`，摘掉目标由 test 入口的守卫格变红）。
//   L1 语法：文档约定归一化后包进 (async () => {...})()，用 node:vm 编译（不执行）；
//   L2 链接：把 `from "erix-agent"` 重写为 src/index.js 的 file:// URL、
//            `from "erix-agent/contract-tests"` 重写为 test/contract/index.js 的
//            file:// URL（两个说明符与 package.json exports 一一对应），写临时 .mjs
//            动态 import（示例体包进未调用函数，只验证真实符号可链接）；
//   L3 执行：同 L2 但真正执行示例体；对未 import 却引用真实符号/上下文的围栏，
//            前置注入 preamble（真实符号 + 最小 stub），独立子进程 spawnSync 跑，
//            超时 15s 即失败。L3 **必须离线**：preamble 只用假 provider
//            （test/helpers/fake-provider.js）或 fetchImpl 脚本桩，不碰网络、不读 `~/.erix`
//            ——README 的「最小工具循环」那格就是靠后者真跑完「工具轮 + 收尾轮」（外加默认
//            开启的每轮 judge），并断言脚本化上游被逐条消耗。
// 本文件是 harness（非 .test 后缀，故意不进 package.json files 白名单：宿主不需要）。
//
// 文档约定说明：契约文档用 TS 风格 `prop?,` 标注可选字段（如 `store?,`），这不是
// 合法 JS；本 harness 在三层验证前统一剥离该标记（正则见 stripDocConvention）。
// 另：部分围栏自带顶层 `import ... from "erix-agent"`（含 "erix-agent/tools"），L1 会将其
// 改写为 `const { ... } = await import(...)` 以便 vm.Script 编译。

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as vm from "node:vm";

import { makeTmp } from "./helpers/tmp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
export const EN_DOC = join(REPO_ROOT, "docs", "host-consumer-contract.md");
export const CN_DOC = join(REPO_ROOT, "docs", "host-consumer-contract_cn.md");
// issue #576：两份根 README 是宿主/模型读到的第一个文件，它们的 js 围栏进同一套三层验证。
export const README_DOC = join(REPO_ROOT, "README.md");
export const README_CN_DOC = join(REPO_ROOT, "README_cn.md");
export const INDEX_URL = pathToFileURL(join(REPO_ROOT, "src", "index.js")).href;
// 契约套件的发布形态就是 package.json exports["./contract-tests"]；文档里「宿主注入
// 自己的实现跑契约套件」的示例必须按宿主看到的那个说明符导入，所以该说明符也要能被三层验证解析。
export const CONTRACT_TESTS_URL = pathToFileURL(
  join(REPO_ROOT, "test", "contract", "index.js"),
).href;
// issue #191：`createFileTools` 的宿主入口是 `erix-agent/tools` 子路径（包根不导出它），
// 所以文档里「宿主注册文件工具」的示例必须按这个说明符导入；三层验证也要能解析它，
// 否则示例只能写成 text 围栏（那就没人验证它跑得通）。
export const TOOLS_URL = pathToFileURL(join(REPO_ROOT, "src", "tools", "index.js")).href;
export const FAKE_PROVIDER_URL = pathToFileURL(
  join(REPO_ROOT, "test", "helpers", "fake-provider.js"),
).href;

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
  if (specifier === "erix-agent") return INDEX_URL;
  if (specifier === "erix-agent/contract-tests") return CONTRACT_TESTS_URL;
  if (specifier === "erix-agent/tools") return TOOLS_URL;
  return specifier;
}

const TOP_LEVEL_IMPORT_RE = /^import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["'];?$/;
const IMPORT_SPECIFIER_RE = /from\s+["']([^"']+)["']\s*;?$/;

/**
 * 这条 import 语句还没写完吗？（issue #576）
 * 两份根 README 的快速开始用的是多行具名导入（`import {` 换行列符号 `} from "erix-agent";`），
 * 而从前的 `splitImports` 只认单行 —— 于是 README 围栏的 L1 直接炸在
 * `Cannot use import statement outside a module`。判据只有两条：
 *   · 花括号没配平 ⇒ 还没到 `}`；
 *   · `import * as ns` / `import ns` 这种无花括号形态还没见到 `from "…"` ⇒ 下一行是 specifier。
 * 其它形态（例如正文里的 `await import(...)`，它不以 `import` 开头）根本不会进来。
 */
function importNeedsMore(statement) {
  const opens = (statement.match(/\{/g) ?? []).length;
  const closes = (statement.match(/\}/g) ?? []).length;
  if (opens > closes) return true;
  return !/from\s+["'][^"']+["']/.test(statement)
    && /^import\s+(?:\*\s+as\s+\w+|\w+)$/.test(statement);
}

/**
 * 拆出顶层 import 语句（重写 erix-agent 说明符）与剩余主体。
 * 语句可以跨行：从 `import` 那一行起，一直吃到 `from "<specifier>"` 为止，
 * 中间行**不**留在正文里（否则正文会带着半条 import，L1/L2/L3 全炸）。
 */
export function splitImports(code) {
  const imports = [];
  const rest = [];
  const lines = code.split("\n");
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!/^import\b/.test(trimmed)) {
      rest.push(lines[index]);
      index += 1;
      continue;
    }
    let statement = trimmed;
    let end = index;
    while (importNeedsMore(statement) && end + 1 < lines.length) {
      end += 1;
      statement = `${statement} ${lines[end].trim()}`;
    }
    const match = TOP_LEVEL_IMPORT_RE.exec(statement);
    if (!match) {
      // 不是可重写的顶层 import（形状不认识）：原样留在正文里，让 L1 报真正的语法错。
      rest.push(lines[index]);
      index += 1;
      continue;
    }
    const clause = statement.slice("import ".length, statement.lastIndexOf("from")).trim()
      .replace(/\s+/g, " ");
    imports.push(`import ${clause} from ${JSON.stringify(rewriteErixSpecifier(match[1]))};`);
    index = end + 1;
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
// expectStdout: 可选，L3 子进程 stdout 必须包含的字面量（示例自己 console.log 出来的东西；
//              README 快速开始靠它证明 `console.log(result.finalText)` 真的拿到了结果）。
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
const initialMessages = undefined;
const policy = {};
const emit = () => {};
`,
    epilogue: `
if (provider.requests.length < 1) throw new Error("runToolLoop 未发起任何 provider 调用（示例体没跑到底）");
`,
  },
  // fence #3（EN「Factory tool replay declarations and the switch-over checklist」节：
  // 出厂工具不标 replay，宿主自己给 definitions 打标注，issue #139）
  // 本围栏自带顶层 import（erix-agent/tools 子路径）；工厂是纯函数，无需任何桩。
  {
    linkImports: [],
    stubs: ``,
    epilogue: `
const __defs__ = createFileTools({ cwd: process.cwd() }).definitions;
if (__defs__.length !== 7) throw new Error(\`文件工具数量漂移（示例假设 7 个，实际 \${__defs__.length}）\`);
if (__defs__.some((tool) => tool.replay !== undefined)) {
  throw new Error("出厂文件工具已自带 replay 标注——本节「一个都没标」的声称过期，必须同步本小节（issue #139）");
}
if (createFileTools({ cwd: process.cwd() }).definitions[0] === __defs__[0]) {
  throw new Error("definitions 不是每次调用的新副本——宿主打标注会改到共享对象");
}
const __write__ = new Set(["edit", "writeFile"]);
const __safe__ = __defs__.filter((tool) => !__write__.has(tool.name)).map((tool) => tool.name).sort().join(",");
if (__safe__ !== "grep,readFile,rg,searchText,tree") {
  throw new Error(\`只读候选集合漂移：\${__safe__}（本节的表与示例假设的是这五个工具名）\`);
}
`,
  },
  // fence #4（多模型槽位装配 + 预算元数据自检，issue #182）
  // 本围栏自带顶层 import：真文件 provider + 真 openai provider + 真 runToolLoop 全链路
  // 执行，只把磁盘（tmpdir 里的 config.json）与网络（fetch 桩）接桩。
  {
    linkImports: [],
    stubs: `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join as __join } from "node:path";
// 临时目录由 harness 用 makeTmp 建好、经 env 传进来（示例代码里不出现裸 mkdtemp，见 issue #209）。
const __slotsDir__ = __join(process.env.ERIX_DOC_EXAMPLE_TMP, "slots");
mkdirSync(__slotsDir__, { recursive: true });
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
  // fence #5（EN「Unified model-JSON entry point `parseModelJson`」节：ok 收窄与三态失败，issue #307）
  {
    // 示例体自带 `import { parseModelJson } from "erix-agent"`，splitImports 会把它提到模块作用域，
    // 于是 epilogue 里可以直接用同一个符号；不需要 stub。
    linkImports: [],
    stubs: "",
    epilogue: `
{
  const hit = parseModelJson('reasoning {"done":true,"confidence":1} trailing prose');
  if (hit.ok !== true) throw new Error(\`示例输入应当命中，实际 error=\${hit.ok ? "none" : hit.error}\`);
  if (hit.via !== "json") throw new Error(\`via 应是字面量 "json"，实际 \${hit.via}\`);
  if (hit.value?.done !== true || hit.value?.confidence !== 1) throw new Error("value 应是 JSON.parse 的直接产物");
  if (!Array.isArray(hit.candidates) || hit.candidates.length !== 1) throw new Error("candidates 应是按出现顺序的全部候选");
  const miss = parseModelJson('{"a":,}');
  if (miss.ok !== false || miss.error !== "unparsable") throw new Error("坏 JSON 应报 unparsable");
  if ("value" in miss || "via" in miss) throw new Error("失败分支不得带 value / via 键（不是 value: undefined）");
  if (parseModelJson("plain prose").error !== "no_candidate") throw new Error("纯散文应报 no_candidate");
  if (parseModelJson('{"a":1').error !== "no_candidate") throw new Error("未闭合外层不得被补括号修好");
  if (parseModelJson('{"confidence":0.5}', { requireKeys: ["done"] }).error !== "shape_mismatch") {
    throw new Error("requireKeys 不满足应报 shape_mismatch");
  }
  if (parseModelJson('{"confidence":0.5}').ok !== true) throw new Error("requireKeys 省略时不应做形状校验");
  if (parseModelJson('{"outer":{"done":true}', { topOnly: false }).ok !== true) throw new Error("topOnly:false 应把内层残片当候选");
  if (parseModelJson('{"outer":{"done":true}').ok !== false) throw new Error("顶层档不得把未闭合外层的内层残片当候选");
}
`,
  },
  // fence #6（EN「Model-output normalization with an optional fallback」节，issue #406：
  // normalizeModelJson 的 provenance 与「闸门永远判候选的原始字节」这条承重不变量）
  {
    // 示例体自带 `import { normalizeModelJson } from "erix-agent"`，splitImports 会把它提到模块作用域
    // （再在 linkImports 里注一次就是「重复声明」）；示例体自带全部上下文，不碰网络、不碰盘。
    linkImports: [],
    stubs: "",
    // 示例体自己逐条 throw（provenance / 闸门判原始字节 / 截断两档）；跑到这一行就是四条判据全部按预期。
    epilogue: `
if (typeof normalizeModelJson !== "function") throw new Error("normalizeModelJson 没链接上");
`,
  },
  // fence #7（store.list 返回 plain array）
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
  // fence #8（createBuiltinNotesTools 接线）
  {
    linkImports: [
      `import { createBuiltinNotesTools } from ${JSON.stringify(INDEX_URL)};`,
    ],
    stubs: `
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join as __join } from "node:path";
const __notesDir__ = __join(process.env.ERIX_DOC_EXAMPLE_TMP, "notes");
mkdirSync(__notesDir__, { recursive: true });
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
  // fence #9（EN「File edit tool `edit`」节：edit 的写边界与越界错误结果，issue #191）
  {
    linkImports: [],
    stubs: `
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join as __join } from "node:path";
// 示例体里 cwd/expectedPath 是宿主侧的自由标识符：这里给一份真实临时目录 + 真实文件，
// 于是 allowWrite 的等值谓词比对的是**绝对路径真值**，不是桩里的假路径。
const __editDir__ = __join(process.env.ERIX_DOC_EXAMPLE_TMP, "edit");
mkdirSync(__editDir__, { recursive: true });
const cwd = __editDir__;
const expectedPath = __join(__editDir__, "a.js");
writeFileSync(expectedPath, "const a = 1;\\n", "utf8");
`,
    epilogue: `
// 示例体被包进 async 函数，里面的 const 在 epilogue 里看不见 → 只验盘上事实：
// 第 1 条必须真的落盘，第 2 条（allowWrite false）必须**没**落盘。
const __after__ = readFileSync(expectedPath, "utf8");
if (__after__ !== "const a = 2;\\n") {
  throw new Error(\`edit 结果不符：第 1 条要写成 "const a = 2;"、第 2 条越界不得写，实际 \${JSON.stringify(__after__)}\`);
}
// 再用同一条线验一次结果形状：命中时首行是「已编辑 <显示路径>」，其后是 unified 风格 diff。
const __again__ = String(await (await import(${JSON.stringify(TOOLS_URL)})).createFileTools({ cwd })
  .executeTool({ id: "doc-example-edit-3", name: "edit", input: { path: "a.js", edits: [{ oldText: "const a = 2;", newText: "const a = 22;" }] }, context: {} }));
if (!__again__.startsWith("已编辑 a.js")) throw new Error(\`edit 结果首行形态不对：\${__again__.slice(0, 120)}\`);
if (!__again__.includes("--- a/a.js") || !__again__.includes("@@ -")) {
  throw new Error(\`edit 结果必须自带短 diff（文件头 + @@ 段）：\${__again__.slice(0, 200)}\`);
}
// 0 命中是错误结果而不是 throw，且必须给出下一步。
const __miss__ = String(await (await import(${JSON.stringify(TOOLS_URL)})).createFileTools({ cwd })
  .executeTool({ id: "doc-example-edit-4", name: "edit", input: { path: "a.js", edits: [{ oldText: "no such text", newText: "x" }] }, context: {} }));
if (!__miss__.startsWith("错误：") || !__miss__.includes("readFile")) {
  throw new Error(\`0 命中必须是「错误：」开头并给出 readFile 下一步：\${__miss__.slice(0, 160)}\`);
}
rmSync(__editDir__, { recursive: true, force: true });
`,
  },
  // fence #10（projectTranscriptForDisplay 展示投影）
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
  // fence #11（契约套件标准注入用法，issue #183）
  // 两层都真验：L2 靠 `erix-agent/contract-tests` 说明符重写到 test/contract/index.js（证明
  // 发布的子路径入盘）；L3 把示例当宿主那样注册 24 条断言（transcript 16 + notes 7 +
  // notes CAS 子套件 1，issue #183）并真的跑完
  // ——node:test 任何一条红都会把子进程 exitCode 置 1，所以「绿」本身就是「套件能接宿主实现」的证据。
  // 主体里的 `notesDir` 是文档约定变量（宿主自己的 notes 目录），由 stubs 供一个真 tmpdir；
  // 完成性断言挂在 beforeExit（事件循环排空 = 套件跑完）上，核「notes 套件真的写到了注入的实现上」。
  {
    linkImports: [],
    stubs: `
// mkdtempSync 只作为**符号**注入：围栏正文（宿主侧示例代码）自己用它给 notes 根开子目录，
// 那是宿主的目录、不是测试的临时目录，所以不在本仓测试卫生守卫的管辖内（见 issue #209 报告）。
import { mkdirSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join as __join } from "node:path";
const notesDir = __join(process.env.ERIX_DOC_EXAMPLE_TMP, "contract-notes");
mkdirSync(notesDir, { recursive: true });
`,
    epilogue: `
process.on("beforeExit", () => {
  if (readdirSync(notesDir, { recursive: true }).length === 0) {
    throw new Error("注入的 NotesStore 未被写过：契约套件没有真的打到宿主实现上");
  }
  rmSync(notesDir, { recursive: true, force: true });
});
`,
  },
];

// ---------------------------------------------------------------------------
// 根 README 的围栏 preamble（issue #576，按 README.md 的围栏序号定位）。
// 与契约文档那批的差别只有一处：两份 README 的 js 围栏都是**入门示例**，所以
//   · 第 1 格（快速开始的最小工具循环）自带 `createOpenAIProvider`，桩只能接在
//     `globalThis.fetch` 上——provider 构造时取的就是它，于是「脚本化上游」等价于
//     `createFakeProvider` 的 script：脚本被掏空/耗光 ⇒ 下一次请求直接 throw ⇒ 整格红；
//   · 第 2、3 格不构造 provider，直接用 `createFakeProvider`（沿用契约 fence #2 的现成机制），
//     完成性断言就是那句 `provider.requests.length < 1 ⇒ throw`。
// 两格都**不碰网络**（fetch 全被桩接住）、**不读 `~/.erix`**（没有 config 文件、没有 HOME 依赖）。
// ---------------------------------------------------------------------------
export const README_FENCE_PREAMBLES = [
  // README 第 1 格（EN :66，快速开始「最小工具循环」）
  {
    linkImports: [],
    stubs: `
const __requests__ = [];
// 脚本化上游：第 1 步要求调一次 exec 工具，其后都是收尾文本。与 createFakeProvider 的
// script 同义——脚本被掏空（或示例多要一轮）时下面那条 throw 让整格变红，而不是静默空跑。
// 为什么不止两步：maxRounds: 16 让每轮 judge 也走 provider（DEFAULT_REFLECTION_MIN_ROUNDS
// = 16），而 judge 回复不可解析时引擎只会「继续」；再加上 completion 的 maxNoToolRounds = 3，
// 一次默认跑完是「1 工具轮 + 3 无工具轮 + 3 次 judge」。脚本给足 12 步，**仍是有界**的：
// 示例要得多于 12 次请求就是漂移，会在这里 throw。
const __upstream__ = [
  {
    content: "I will inspect the files first.",
    toolCalls: [{ id: "doc-call-1", name: "exec", arguments: JSON.stringify({ command: "ls src" }) }],
    stopReason: "tool_use",
  },
  ...Array.from({ length: 11 }, () => ({ content: "doc-example done", stopReason: "end_turn" })),
];
let __upstreamIndex__ = 0;
// 示例体把 process.env.LLM_API_KEY 递给 createOpenAIProvider；apiKey 在构造时求值。
process.env.LLM_API_KEY = "doc-example-key";
// createOpenAIProvider 的 fetchImpl 默认就是 globalThis.fetch，默认值在构造时求值：
// stubs 先于示例体执行，所以这个桩能接住真实出门的请求（不碰网络）。
globalThis.fetch = async (url, options) => {
  __requests__.push({ url, options });
  if (__upstreamIndex__ >= __upstream__.length) {
    throw new Error("fake upstream script exhausted");
  }
  const step = __upstream__[__upstreamIndex__];
  __upstreamIndex__ += 1;
  return {
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [{
          message: {
            content: step.content,
            ...(step.toolCalls === undefined ? {} : {
              tool_calls: step.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }),
          },
          finish_reason: step.stopReason,
        }],
      });
    },
  };
};
`,
    epilogue: `
// 示例体跑在函数里，局部量（provider / result）不外泄 → 只验「出门的请求」这条盘外事实。
// 请求数不钉死：maxRounds 16 下每轮 judge 也走 provider（见 stubs 里那段说明），
// 钉的是**下界**（工具轮 + 至少一轮回喂）与**有界**（脚本耗尽会 throw，进程非 0）。
if (__requests__.length < 2) {
  throw new Error(\`示例应至少发起 2 次 provider 请求（工具轮 + 回喂轮），实际 \${__requests__.length} 次\`);
}
const __first__ = JSON.parse(__requests__[0]?.options?.body ?? "{}");
if (__first__.model !== "your-model") {
  throw new Error(\`createOpenAIProvider 的 model 没进请求体，实际 model=\${String(__first__.model)}\`);
}
if (!Array.isArray(__first__.tools) || __first__.tools.length !== 1) {
  throw new Error("示例声明的 exec 工具没进请求体（tools 不是 1 条）");
}
if (__first__.tools[0]?.function?.name !== "exec") {
  throw new Error(\`工具名漂移：实际 \${String(__first__.tools[0]?.function?.name)}\`);
}
if (String(__requests__[0]?.options?.headers?.Authorization ?? "") !== "Bearer doc-example-key") {
  throw new Error("示例的 apiKey（process.env.LLM_API_KEY）没有变成 Authorization 头");
}
// executeTool 的返回值必须真的回喂进后续请求：这同时钉住它的**解构签名**
// （写成 (name, input) 之类就拿不到 name/input，拼出来的字符串对不上）。
const __texts__ = [];
const __collect__ = (value) => {
  if (typeof value === "string") __texts__.push(value);
  else if (Array.isArray(value)) value.forEach(__collect__);
  else if (value && typeof value === "object") Object.values(value).forEach(__collect__);
};
for (const __request__ of __requests__) {
  __collect__(JSON.parse(__request__?.options?.body ?? "{}").messages ?? []);
}
if (!__texts__.some((entry) => entry.includes('exec({"command":"ls src"}) -> ok'))) {
  throw new Error("executeTool 的返回值没有回喂进后续 messages（签名或调用链断了）");
}
`,
    // 示例自己 `console.log(result.finalText)`：最后一句来自脚本化上游，证明整条链真的收尾了。
    expectStdout: ["doc-example done"],
  },
  // README 第 2 格（EN :291，AssemblyPort 组合根）
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
const initialMessages = undefined;
const policy = {};
const emit = () => {};
`,
    epilogue: `
if (provider.requests.length < 1) throw new Error("runToolLoop 未发起任何 provider 调用（示例体没跑到底）");
`,
  },
  // README 第 3 格（EN :480，「`runToolLoop` API」节的核心入口一行式）
  {
    linkImports: [
      `import { runToolLoop } from ${JSON.stringify(INDEX_URL)};`,
      `import { createFakeProvider } from ${JSON.stringify(FAKE_PROVIDER_URL)};`,
    ],
    stubs: `
const provider = createFakeProvider([{ content: [{ type: "text", text: "doc-example done" }], stopReason: "end_turn" }]);
const executeTool = async () => "doc-example-tool-result";
const options = {
  config: {
    input: { initialUserMessage: "doc example" },
    run: { runId: \`doc-example-entry-\${process.pid}-\${Date.now()}\` },
  },
};
`,
    epilogue: `
if (provider.requests.length < 1) throw new Error("runToolLoop 未发起任何 provider 调用（示例体没跑到底）");
`,
  },
];

// ---------------------------------------------------------------------------
// 目标文档表（issue #576）：**每个文档自带围栏数期望与 preamble 表**。
// 从前只有一个 `EXPECTED_JS_FENCE_COUNT = 12`（契约 EN），CN 靠「与 EN 同数」间接看守，
// 两份根 README 在 harness 里命中 0 次。现在加一份文档 = 加一条目标；摘掉一条目标
// 由 test 入口的「目标表必须覆盖两份契约文档与两份根 README」守卫格变红（#572 同型刀）。
// `preambles` 按 EN 文档的围栏序号索引；CN 围栏只跑骨架一致性（代码不翻译），
// 所以 CN 的 preamble 表只是同一个引用（EN/CN 共享一套，避免第二份真相）。
// ---------------------------------------------------------------------------
export const DOC_TARGETS = [
  {
    name: "host-consumer-contract",
    en: EN_DOC,
    cn: CN_DOC,
    expectedFences: 12,
    preambles: FENCE_PREAMBLES,
  },
  {
    name: "README",
    en: README_DOC,
    cn: README_CN_DOC,
    expectedFences: 3,
    preambles: README_FENCE_PREAMBLES,
  },
];

/** 文档路径 → 该文档的 preamble 表（EN 与 CN 共享同一份）。 */
const PREAMBLES_BY_DOC = new Map(
  DOC_TARGETS.flatMap((target) => [[target.en, target.preambles], [target.cn, target.preambles]]),
);

// ---------------------------------------------------------------------------
// 临时 .mjs 生成与执行
// ---------------------------------------------------------------------------

function preambleFor(fence) {
  const preambles = PREAMBLES_BY_DOC.get(resolve(filePathFor(fence))) ?? FENCE_PREAMBLES;
  const preamble = preambles[fence.index];
  if (!preamble) {
    throw new Error(`${filePathFor(fence)} 的第 ${fence.index + 1} 个围栏没有 preamble 配置`);
  }
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
  const dir = await makeTmp("doc-examples-");
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
export async function runLevel3(fence) {
  const source = buildExecProgram(fence);
  const dir = await makeTmp("doc-examples-");
  const file = join(dir, `exec-${fence.line}-${fence.index}.mjs`);
  try {
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [file], {
      encoding: "utf8",
      timeout: L3_TIMEOUT_MS,
      cwd: REPO_ROOT,
      // 围栏 preamble 的临时目录一律由 harness 用 makeTmp 建（尊重 TMPDIR + 可写探针），
      // 子进程只拿到路径，自己不再 mkdtemp（issue #209）。
      env: { ...process.env, ERIX_DOC_EXAMPLE_TMP: dir },
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    let ok = result.status === 0 && stdout.includes("__DOC_EXAMPLE_EXEC_OK__");
    let finalStderr = stderr;
    if (result.error) finalStderr = `${result.error.message}\n${finalStderr}`;
    if (result.signal) finalStderr = `子进程被信号 ${result.signal} 终止（超时上限 ${L3_TIMEOUT_MS}ms）\n${finalStderr}`;
    // 可选的 stdout 声称（issue #576）：README 的快速开始自己 `console.log(result.finalText)`，
    // 那一行是示例唯一「真的跑到底并拿到结果」的对外证据——示例体跑在函数里，局部量不外泄，
    // 所以只能从子进程 stdout 上看。缺一句就红，而不是「没打印也算过」。
    const missingStdout = (preambleFor(fence).expectStdout ?? []).filter((needle) => !stdout.includes(needle));
    if (missingStdout.length > 0) {
      ok = false;
      finalStderr = `子进程 stdout 缺少期望输出 ${JSON.stringify(missingStdout)}\n${finalStderr}`;
    }
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
