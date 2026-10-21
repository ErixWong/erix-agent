// pi 加载自证：用 pi 自己的扩展装载器（jiti + 虚拟模块）加载 examples/pi-extension/erix-run.ts，
// 断言它作为 pi 扩展被接受、erix_run 注册成功、参数 schema 正确，并且 execute() 在装配期失败
// （cwd 不存在）时返回的是 isError 结果而不是抛错——即「不崩 pi」。
//
// 找不到已安装的 pi（@earendil-works/pi-coding-agent）时整文件跳过：本仓零依赖，
// 不能为了这条断言引入 npm 依赖。查找顺序：
//   PI_CODING_AGENT_ROOT → 常见全局安装路径 → import.meta.resolve("@earendil-works/pi-coding-agent")

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { makeTmp } from "../helpers/tmp.js";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STRATEGY_NAMES } from "../../examples/pi-extension/erix-run-core.js";
import { SYNC_RESULT_FIELDS } from "../../examples/pi-extension/erix-run-jobs.js";
import { assertMachineReadableResult } from "./plain-data.js";

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
  // #234 R2：同一个工具加 action 参数 ⇒ task/cwd 在 schema 层不再硬 required
  // （否则 action:"status" 这种查询调用会被 schema 拦住）。必填性改由运行时报错守：
  // parseRunParams 在**派工分支**里同步校验，坏参数当场返回 ok:false + error.code。
  assert.equal(schema.required, undefined, "#234 之后参数面全可选（必填性移到运行时）");
  assert.equal(schema.properties.task.type, "string");
  assert.equal(schema.properties.cwd.type, "string");
  assert.deepEqual(schema.properties.strategy.enum, [...STRATEGY_NAMES]);
  assert.equal(schema.properties.maxRounds.minimum, 1);
  assert.equal(typeof schema.properties.timeoutMs.maximum, "number");
  assert.equal(typeof definition.outputSchema, "object", "结构化结果要有 outputSchema");
  // #207：新增的参数面（**maxExtensions 的最低值是 0**，不是 1）
  assert.equal(schema.properties.sessionDir.type, "string");
  assert.equal(schema.properties.transcript.type, "string");
  assert.equal(schema.properties.maxExtensions.minimum, 0, "0 = 关掉扩轮是有效配置，schema 不能卡成正整数");
  assert.equal(schema.properties.maxRoundsCap.minimum, 1);
  assert.equal(schema.properties.extensionStep.minimum, 1);
  // #314：终稿核验开关的参数面。**默认关**写在说明里（模型只有看到这一行才知道要显式开），
  // 代价与超时约束也必须写在模型眼前，不然它会以为开启是免费的。
  assert.equal(schema.properties.finalGuard.type, "boolean");
  assert.equal(schema.properties.finalGuardTimeoutMs.minimum, 200);
  assert.equal(schema.properties.finalGuardTimeoutMs.maximum, 600_000);
  assert.match(schema.properties.finalGuard.description, /默认关/u);
  assert.match(schema.properties.finalGuard.description, /≤2 个模型往返/u);
  assert.match(schema.properties.finalGuardTimeoutMs.description, /只在 finalGuard: true 时有意义/u);
  for (const key of ["sessionDir", "transcript", "maxExtensions", "maxRoundsCap", "extensionStep",
    "finalGuard", "finalGuardTimeoutMs"]) {
    assert.equal(schema.properties[key].description.length > 20, true, `${key} 要给模型看得见的说明`);
  }
  // #234：异步与查询参数面
  assert.equal(schema.properties.async.type, "boolean", "async 必须是布尔（缺省 false = 同步语义）");
  assert.equal(schema.properties.quiet.type, "boolean");
  assert.deepEqual(schema.properties.action.enum, ["status", "result", "list", "cancel"]);
  assert.equal(schema.properties.runId.type, "string");
  for (const key of ["async", "quiet", "action", "runId"]) {
    assert.equal(schema.properties[key].description.length > 20, true, `${key} 要给模型看得见的说明`);
  }
  // #234：outputSchema 仍只描述同步终局面（异步句柄与 action 结果的可机读数据在 details）
  assert.equal("kind" in (definition.outputSchema.properties ?? {}), false,
    "异步面不能把同步终局的 15 个字段（#277 后含 verification/error）改软");
  // —— issue #277 的锚点（主看守，先跑）：把「真值源派生的字段表」与「已发布的 outputSchema 承诺」绑在一起。
  // 方向 = SYNC_RESULT_FIELDS ⊆ schema.properties 的键（schema 是承诺的下限，视图允许额外给运行时事实）：
  //   ① 从 schema 删一个键 → 本锚点红；② 真值源（core 的两个载荷构造器）加一个字段而 schema 不补 → 也红。
  // 为什么必须是**派生值**而不是又一份写死清单：#276 之前两个面都是手抄，#276 只修了异步视图，
  // 本单修的是 schema——只钉一份写死的键清单，下次上游加字段仍然会逐处漏。
  assert.deepEqual(
    [...SYNC_RESULT_FIELDS].sort(),
    [...SYNC_RESULT_FIELDS].filter((field) => field in (definition.outputSchema.properties ?? {})).sort(),
    `这些同步终局字段真值源在返、异步视图在投，而 outputSchema 没声明（按 schema 读的宿主看不见它们）：`
    + SYNC_RESULT_FIELDS
      .filter((field) => !(field in (definition.outputSchema.properties ?? {})))
      .join(","),
  );
  // #207 R4：返回面形状（artifacts 可空，但不允许缺）。
  // #277：下面这份写死清单是上面那条锚点的**镜像**（13 键 → 15 键：补 `verification`、`error`）；
  // 它还能钉住另一个方向——schema 多声明一个真值源不返的键时，锚点不红、它红。
  assert.deepEqual(
    Object.keys(definition.outputSchema.properties).sort(),
    ["aborted", "artifacts", "diagnostics", "error", "extensionCount", "finalText", "maxExtensions",
      "ok", "resumable", "rounds", "termination", "timeout", "truncated", "usage", "verification"],
  );
  assert.equal("artifacts" in definition.outputSchema.properties, true);

  // #277：新补的两键形状——都是 Optional（error 只在抛错路径、verification 在早退路径可以是 undefined），
  // 已有键的必填性一字未动（additive）。
  const outProps = definition.outputSchema.properties;
  const outRequired = definition.outputSchema.required ?? [];
  for (const field of ["verification", "error"]) {
    assert.equal(field in outProps, true, `#277：${field} 必须在 outputSchema 里`);
    assert.equal(outRequired.includes(field), false, `#277：${field} 是 Optional，不能把缺省语义改软`);
  }
  assert.equal(outProps.verification.properties.status.type, "string");
  assert.deepEqual(Object.keys(outProps.error.properties).sort(), ["code", "message", "name", "stage"]);
  for (const field of ["ok", "finalText", "rounds", "truncated", "usage", "termination",
    "timeout", "aborted", "artifacts", "extensionCount", "maxExtensions", "resumable"]) {
    assert.equal(outRequired.includes(field), true, `#277 只许加键：${field} 的必填性不得被改软`);
  }

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
  // #207 R4：装配期失败也要带齐决策事实（字段形状恒成立，未落盘就是 null）
  assert.deepEqual(result.structuredContent?.artifacts, { transcriptPath: null, judgeLogPath: null });
  assert.equal(result.structuredContent?.extensionCount, 0);
  assert.equal(result.structuredContent?.maxExtensions, 0);
  assert.equal(result.structuredContent?.resumable, false);
  assert.ok(updates.length >= 1, "进度通道（onUpdate）至少要收到终局播报");
  assert.equal("usage" in result, false, "没有真实模型用量时不编造 usage");

  // #234 R2：action 面在 pi 装载下也能走（可机读数据在 details，不靠 structuredContent）
  const listed = await definition.execute(
    "tc-list", { action: "list" }, new AbortController().signal, undefined,
    { signal: undefined, cwd: process.cwd(), mode: "print", hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => "t" } },
  );
  assert.notEqual(listed.isError, true, "list 是查询，不是错误");
  assert.equal(listed.details?.kind, "list");
  assert.ok(Array.isArray(listed.details?.jobs), "details 要带可机读的 job 列表");

  const ghost = await definition.execute(
    "tc-status", { action: "status", runId: "no-such-run-234" }, new AbortController().signal, undefined,
    { signal: undefined, cwd: process.cwd(), mode: "print", hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => "t" } },
  );
  assert.equal(ghost.isError, true, "查不存在的 run 要报 isError，别让模型当成查到了");
  assert.equal(ghost.details?.kind, "unknown-run");

  // #234 R1：async:true 但参数非法 → 与同步面**同一个形状**（ok:false + error.code），不是「内部异常」
  const badAsync = await definition.execute(
    "tc-bad-async",
    { task: "t", cwd: path.join(tmpdir(), "no-such-dir-234-async"), async: true },
    new AbortController().signal, undefined,
    { signal: undefined, cwd: process.cwd(), mode: "print", hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => "t" } },
  );
  assert.equal(badAsync.isError, true);
  assert.equal(badAsync.structuredContent?.error?.code, "bad_cwd", "坏参数的异步派工必须退回同步面形状");
  assert.equal(badAsync.details?.crashed, undefined, "参数错不该被当成扩展崩掉");

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

// ---------------------------------------------------------------------------
// #237：真装载器 + 真 `execute()` 下，**每一条返回路径**交出去的 details 都必须可序列化。
// 上面的离线用例测的是形状层（erix-run-format.js）；这一条测的是**接线**：
// execute() 把 outcome 交给 details / structuredContent 的那几行本身。
// 缺陷原文是 pi 在真进程里序列化 details 时抛 `Converting circular structure to JSON`，
// 而活对象 `job`（AbortController / 定时器 / 未结算 promise）就藏在派工返回值里。
// 内层库指到一个不存在的路径 → 后台 run 立刻以 lib_missing 终局（离线、不花模型钱）。
// ---------------------------------------------------------------------------

test("#237：execute() 每条返回路径的 details 都可 JSON 序列化（真装载器 + 真 execute）", {
  skip: piRoot === undefined ? "找不到已安装的 @earendil-works/pi-coding-agent（设 PI_CODING_AGENT_ROOT 指向安装目录）" : false,
}, async () => {
  const previousLib = process.env.ERIX_AGENT_LIB;
  process.env.ERIX_AGENT_LIB = path.join(tmpdir(), "no-such-erix-agent-lib-237");
  try {
    const loader = await import(new URL("dist/core/extensions/loader.js", `file://${piRoot}/`).href);
    const loaded = await loader.loadExtensions([extensionPath], process.cwd(), undefined, loader.createExtensionRuntime());
    assert.deepEqual(loaded.errors ?? [], []);
    const entry = loaded.extensions[0].tools.get("erix_run");
    const definition = entry?.definition ?? entry;

    const work = await makeTmp("erix-run-details-pi-");
    const sess = await makeTmp("erix-run-details-pi-sess-");
    const ctx = {
      signal: undefined, cwd: process.cwd(), mode: "rpc", hasUI: false,
      isIdle: () => true, sessionManager: { getSessionId: () => "t-237" },
    };
    const call = (id, params) => definition.execute(id, params, new AbortController().signal, undefined, ctx);

    const cases = [];
    const started = await call("p-started", {
      task: "t", cwd: work, sessionDir: sess, async: true, timeoutMs: 1_000, maxRounds: 2,
    });
    cases.push(["started(async:true)", started]);
    const runId = started.details?.handle?.runId;
    assert.equal(typeof runId, "string", "派工必须回句柄，details.handle.runId 是可机读的 runId");
    assert.deepEqual(Object.keys(started.details).sort(), ["handle", "kind"], "details 只有 {kind, handle}，没有活对象 job");
    assert.equal("job" in started.details, false, "#237 的原始缺陷就是 details 里混进了 job");

    cases.push(["status", await call("p-status", { action: "status", runId })]);
    cases.push(["cancel", await call("p-cancel", { action: "cancel", runId })]);
    cases.push(["result", await call("p-result", { action: "result", runId })]);
    cases.push(["list", await call("p-list", { action: "list" })]);
    cases.push(["unknown-run", await call("p-ghost", { action: "status", runId: "ghost-237" })]);
    cases.push(["error(bad_params)", await call("p-badparams", { action: "status" })]);
    cases.push(["sync(装配期失败)", await call("p-sync", { task: "t", cwd: path.join(tmpdir(), "no-such-dir-237-sync") })]);

    for (const [label, result] of cases) {
      assertMachineReadableResult(result, `pi execute(): ${label}`);
      // 异步面（句柄与 action 结果）的 details 必须带 kind；同步面的 details 就是 #207 那份
      // 终局载荷（有 outputSchema / structuredContent，本来就没有 kind），别拿异步面的形状卡它。
      if (result.structuredContent === undefined && result.details?.crashed !== true) {
        assert.equal(typeof result.details?.kind, "string", `${label}: details.kind 必须是字符串`);
      }
      assert.equal("job" in (result.details ?? {}), false, `${label}: details 里不许出现 job`);
    }

    // 取消这条 run 之后必须走到终局（后台 run 与扩展同进程，别把它留成 running）
    const settled = await call("p-final", { action: "status", runId });
    assert.equal(settled.details?.view?.status, "aborted", `取消后状态必须是 aborted，实测 ${settled.details?.view?.status}`);
    if (previousLib === undefined) delete process.env.ERIX_AGENT_LIB;
    else process.env.ERIX_AGENT_LIB = previousLib;
  } finally {
    if (previousLib === undefined) delete process.env.ERIX_AGENT_LIB;
    else process.env.ERIX_AGENT_LIB = previousLib;
  }
});
