// pi 加载自证：用 pi 自己的扩展装载器（jiti + 虚拟模块）加载 examples/pi-extension/erix-run.ts，
// 断言它作为 pi 扩展被接受、erix_run 注册成功、参数 schema 正确，并且 execute() 在装配期失败
// （cwd 不存在）时返回的是 isError 结果而不是抛错——即「不崩 pi」。
//
// 找不到已安装的 pi（@earendil-works/pi-coding-agent）时整文件跳过：本仓零依赖，
// 不能为了这条断言引入 npm 依赖。查找顺序：
//   PI_CODING_AGENT_ROOT → 常见全局安装路径 → import.meta.resolve("@earendil-works/pi-coding-agent")

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STRATEGY_NAMES } from "../../examples/pi-extension/erix-run-core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(here, "..", "..", "examples", "pi-extension", "erix-run.ts");

function findPiCodingAgentRoot() {
  const candidates = [];
  if (process.env.PI_CODING_AGENT_ROOT) {
    candidates.push(process.env.PI_CODING_AGENT_ROOT);
  }
  const globalRoots = [
    path.join(homedir(), ".npm-global/lib/node_modules"),
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
  ];
  for (const root of globalRoots) {
    candidates.push(path.join(root, "@earendil-works/pi-coding-agent"));
    candidates.push(path.join(root, "@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent"));
  }
  const hit = candidates.find((candidate) => existsSync(path.join(candidate, "dist/core/extensions/loader.js")));
  if (hit !== undefined) return hit;
  try {
    const resolved = import.meta.resolve("@earendil-works/pi-coding-agent");
    if (typeof resolved === "string" && resolved.startsWith("file:")) {
      const file = fileURLToPath(resolved);
      const root = path.resolve(path.dirname(file), "..", "..", "..");
      if (existsSync(path.join(root, "dist/core/extensions/loader.js"))) return root;
    }
  } catch {
    // 裸包名不可解析：由调用方跳过
  }
  return undefined;
}

const piRoot = findPiCodingAgentRoot();

test("pi 装载器能加载 erix-run.ts 并注册 erix_run（离线，不触网）", {
  skip: piRoot === undefined ? "找不到已安装的 @earendil-works/pi-coding-agent（设 PI_CODING_AGENT_ROOT 指向安装目录）" : false,
}, async () => {
  const loader = await import(new URL("dist/core/extensions/loader.js", `file://${piRoot}/`).href);
  const runtime = loader.createExtensionRuntime();
  const loaded = await loader.loadExtensions([extensionPath], process.cwd(), undefined, runtime);

  assert.deepEqual(loaded.errors ?? [], [], "扩展装载阶段不能有错误（jiti 转译 / 依赖解析都在这一步暴露）");
  assert.equal(loaded.extensions?.length, 1);
  const tools = loaded.extensions[0].tools;
  const names = tools instanceof Map ? [...tools.keys()] : Object.keys(tools ?? {});
  assert.deepEqual(names, ["erix_run"]);

  const entry = tools instanceof Map ? tools.get("erix_run") : tools.erix_run;
  const definition = entry?.definition ?? entry;
  assert.equal(definition.name, "erix_run");
  assert.equal(typeof definition.execute, "function");
  assert.equal(definition.executionMode, "sequential", "内层 run 是重活，必须串行");
  assert.equal(definition.annotations?.readOnlyHint, false);
  assert.equal(definition.annotations?.destructiveHint, true);

  const schema = definition.parameters;
  assert.equal(schema.type, "object");
  assert.deepEqual([...schema.required].sort(), ["cwd", "task"]);
  assert.deepEqual(schema.properties.strategy.enum, [...STRATEGY_NAMES]);
  assert.equal(schema.properties.maxRounds.minimum, 1);
  assert.equal(typeof schema.properties.timeoutMs.maximum, "number");
  assert.equal(typeof definition.outputSchema, "object", "结构化结果要有 outputSchema");

  // execute() 的失败路径：参数不合法时返回 isError 结果（docs：failure that still carries data 用 isError，别抛）
  const updates = [];
  const result = await definition.execute(
    "tc-1",
    { task: "做点什么", cwd: path.join(tmpdir(), "no-such-dir-erix-run-pi") },
    new AbortController().signal,
    (partial) => updates.push(partial),
    { signal: undefined, cwd: process.cwd(), mode: "print", hasUI: false },
  );

  assert.equal(result.isError, true);
  assert.ok(Array.isArray(result.content) && result.content[0]?.type === "text");
  assert.match(result.content[0].text, /cwd 不存在/u);
  assert.equal(result.structuredContent?.ok, false);
  assert.equal(result.structuredContent?.error?.code, "bad_cwd");
  assert.equal(result.structuredContent?.termination?.reason, "failed");
  assert.deepEqual(result.structuredContent?.usage, { input_tokens: 0, output_tokens: 0 });
  assert.ok(updates.length >= 1, "进度通道（onUpdate）至少要收到终局播报");
  assert.equal("usage" in result, false, "没有真实模型用量时不编造 usage");

  // 目录形态（~/.pi/agent/extensions/erix-run/ 的装法）：入口是 index.ts，只能注册一次
  const dirRuntime = loader.createExtensionRuntime();
  const loadedDir = await loader.loadExtensions(
    [path.join(extensionPath, "..")],
    process.cwd(),
    undefined,
    dirRuntime,
  );
  assert.deepEqual(loadedDir.errors ?? [], []);
  assert.equal(loadedDir.extensions?.length, 1, "整个目录只能被当成一条扩展加载");
  const dirTools = loadedDir.extensions[0].tools;
  const dirNames = dirTools instanceof Map ? [...dirTools.keys()] : Object.keys(dirTools ?? {});
  assert.deepEqual(dirNames, ["erix_run"], "index.ts 入口不得把 erix_run 注册两次");
});
