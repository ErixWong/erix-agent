// issue #630（S1）——派生实现四条评审缺陷里的 A / B / C：**全部走真装配**
// （`createCliDelegation` + 真 `runToolLoop` + 脚本化假 provider），不喂手写输入。
//
//   A. 后台 `result` 必须带回子的终稿与失败原因：`resultText` / `resultTruncated` /
//      `errorMessage` 三个字段在**同一次终态写**里落盘，`result` 动作把它们交回去。
//      以前后台分支只写 `state/endedAt/termination/verification`，`text` 直接丢弃 ⇒
//      父调 `result` 拿不到答案，只能拿 `tail` 猜。
//   B. 名册的 `cwd` 必须是**实际生效**的目录：宿主端口 `cwdFor` 解析出的值**既写名册、又交给
//      `runChild`**（同一个值）。以前名册只记模型请求里的原值，缺省时键被省略，而子实际在父树里跑。
//   C. 子工具面 ⊆ 父工具面：父 `--tools` 白名单经 `toolAllowlist` 下传，子工具集套同一个
//      `filterToolsByAllowlist`。以前子无条件拿全量（含 `exec`），父收窄权限时子反而扩权。
//
// 全离线：脚本化假 provider（按系统提示分流父/子），临时目录走 `makeTmp`，不碰真实 `~/.erix`。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { runChat } from "../bin/cli.js";
import { createCliDelegation } from "../bin/delegation.js";
import {
  ERROR_MESSAGE_LIMIT,
  RESULT_TEXT_LIMIT,
  createDelegateTool,
} from "../src/tools/delegation/tool.js";
import { readRecord } from "../src/tools/delegation/roster.js";
import { makeTmp } from "./helpers/tmp.js";

/** 子 run 的系统提示前缀（`buildChildSystemPrompt` 的第一句）：按它分流父子脚本。 */
const CHILD_MARKER = "你是 erix 的子 run";

/**
 * 按系统提示分流的脚本化假 provider：父 run 与子 run 共用同一个实例（CLI 的 `buildProvider`
 * 在未指定 model 时就是复用父那个），所以**必须在请求里分流**，不能用一个线性脚本。
 * 每次请求都把 `request.tools` 的**工具名**记下来——那就是「传给子 `runToolLoop` 的工具面」。
 */
function createRoutingFakeProvider({ parentScript = [], childScript = [] }) {
  const seen = { parent: 0, child: 0 };
  const requests = [];
  const provider = {
    protocol: "fake",
    model: "fake-model",
    requests,
    seen,
    async chat(request) {
      const isChild = JSON.stringify(request ?? {}).includes(CHILD_MARKER);
      const key = isChild ? "child" : "parent";
      const systemText = String(request?.system?.content ?? request?.system ?? "");
      requests.push({
        role: key,
        system: systemText,
        toolNames: (Array.isArray(request?.tools) ? request.tools : []).map((tool) => tool?.name),
      });
      const script = isChild ? childScript : parentScript;
      if (seen[key] >= script.length) {
        throw new Error(`fake provider: ${key} 脚本已用尽（第 ${seen[key] + 1} 次请求）`);
      }
      const step = script[seen[key]];
      seen[key] += 1;
      return { content: step.content ?? [], stopReason: step.stopReason ?? "end_turn" };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
  return provider;
}

/** 空 MCP 配置：`runChat` 默认会去读 `~/.erix/mcp.json` / 当前目录 `.mcp.json`（测试不许碰真家目录）。 */
async function writeEmptyMcpConfig(dir) {
  const configPath = join(dir, "mcp.json");
  await mkdir(dir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  return configPath;
}

/** 轮询到谓词为真（后台收尾是异步的）；超时按失败处理。 */
async function waitFor(predicate, { timeoutMs = 5_000, stepMs = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时：条件一直不成立");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** 从子 run 的系统提示里取「工作目录 X。」——那是 `runChild` 真正拿到的目录。 */
function childCwdFromPrompt(prompt) {
  const m = String(prompt).match(/工作目录\s+(.+?)。/u);
  return m === null ? null : m[1];
}

/** 系统提示里的工具清单行（`可用工具：…。`）——模型看得见的那一面。 */
function toolListLine(prompt) {
  const m = String(prompt).match(/可用工具：[^\n]*/u);
  return m === null ? null : m[0];
}

// ── A ───────────────────────────────────────────────────────────────────────────────
test("真装配（#630 A）：后台子 run 完成后 result 带回子的终稿（与子实际输出逐字相同）", async () => {
  const root = await makeTmp("erix-delegate-630-a-");
  const delegationDir = join(root, "delegation");
  const childText = "子 run 的终稿：pong-630（后台派生）";
  const provider = createRoutingFakeProvider({
    childScript: [{ content: [{ type: "text", text: childText }], stopReason: "end_turn" }],
  });
  const delegation = createCliDelegation({
    buildProvider: () => provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    cwd: root,
    todo: false,
    notesDir: join(root, "notes"),
    rosterDir: delegationDir,
    maxRounds: 4,
    notify: () => {},
    childToolOutput: () => {},
  });

  const ran = await delegation.execute({ action: "run", task: "回答 pong", background: true }, { runId: "parent-630a" });
  assert.equal(ran.ok, true, `后台派生应立刻返回：${JSON.stringify(ran)}`);
  assert.equal(ran.background, true);
  // issue #630 S2（D）：`running` 在调 `runChild` 之前就写进名册了，所以立刻返回的是 `running`
  //（以前是 `queued`，而 `running` 七状态里从未被写入）。
  assert.equal(ran.state, "running", "后台分支立刻返回 running（`queued → running` 已经落盘），终态由名册异步写");

  const result = await waitFor(async () => {
    const r = await delegation.execute({ action: "result", runId: ran.runId }, { runId: "parent-630a" });
    return r.ok === true ? r : null;
  });
  assert.equal(result.state, "completed", `子 run 应正常收尾：${JSON.stringify(result)}`);
  assert.equal(
    result.text,
    childText,
    "result 必须带回子的终稿（缺陷 A：以前后台分支把 text 丢掉了，父只能拿 tail 猜）",
  );
  assert.equal(result.truncated, undefined, "没截断就不许带 truncated 键");
  assert.equal(result.error, undefined, "没抛错就不许带 error 键");

  // 名册里同一次终态写就有这三个字段（不是事后补写第二遍）。
  const record = readRecord(delegationDir, ran.runId);
  assert.equal(record.resultText, childText);
  assert.equal("resultTruncated" in record, false, "未截断 ⇒ 名册里没有 resultTruncated 这个键");
  assert.equal("errorMessage" in record, false, "正常结束 ⇒ 名册里没有 errorMessage 这个键");
  // status 返回整条记录，所以自然也能看到终稿（期望行为，不是副作用）。
  const status = await delegation.execute({ action: "status", runId: ran.runId }, { runId: "parent-630a" });
  assert.equal(status.record.resultText, childText);
});

test("真装配（#630 A）：长终稿截到 4000 字符并带 truncated:true", async () => {
  const root = await makeTmp("erix-delegate-630-a-trunc-");
  const delegationDir = join(root, "delegation");
  const longText = `HEAD-${"x".repeat(RESULT_TEXT_LIMIT)}-TAIL`;
  assert.ok(longText.length > RESULT_TEXT_LIMIT);
  const provider = createRoutingFakeProvider({
    childScript: [{ content: [{ type: "text", text: longText }], stopReason: "end_turn" }],
  });
  const delegation = createCliDelegation({
    buildProvider: () => provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    cwd: root,
    todo: false,
    notesDir: join(root, "notes"),
    rosterDir: delegationDir,
    maxRounds: 4,
    notify: () => {},
    childToolOutput: () => {},
  });

  const ran = await delegation.execute({ action: "run", task: "写长报告", background: true }, { runId: "parent-630at" });
  const result = await waitFor(async () => {
    const r = await delegation.execute({ action: "result", runId: ran.runId }, { runId: "parent-630at" });
    return r.ok === true ? r : null;
  });
  assert.equal(result.state, "completed");
  assert.equal(result.truncated, true, "超上限必须带 truncated:true");
  assert.equal(typeof result.text, "string");
  assert.equal(result.text.length, RESULT_TEXT_LIMIT, `上限必须是 ${RESULT_TEXT_LIMIT} 字符`);
  assert.equal(result.text, longText.slice(0, RESULT_TEXT_LIMIT), "截断必须是前缀，不是随手切");
  assert.equal(result.text.includes("-TAIL"), false, "尾巴必须真被切掉（否则这条测试没证明截断）");
});

test("真装配（#630 A）：子 run 抛错时 result 带回 error 且 state=failed", async () => {
  const root = await makeTmp("erix-delegate-630-a-error-");
  const delegationDir = join(root, "delegation");
  const boom = "宿主 provider 装配失败：630-A";
  const delegation = createCliDelegation({
    // 子 run 的 provider 装配就抛：这是「宿主异常」，`runChild` 不归一成 termination，原样上抛。
    buildProvider: () => { throw new Error(boom); },
    config: { model: "fake-model", maxOutputTokens: 1000 },
    cwd: root,
    todo: false,
    notesDir: join(root, "notes"),
    rosterDir: delegationDir,
    maxRounds: 4,
    notify: () => {},
    childToolOutput: () => {},
  });

  const ran = await delegation.execute({ action: "run", task: "注定失败", background: true }, { runId: "parent-630ae" });
  assert.equal(ran.ok, true, "后台派生本身成功（失败是子的结局，不是父的异常）");
  const result = await waitFor(async () => {
    const r = await delegation.execute({ action: "result", runId: ran.runId }, { runId: "parent-630ae" });
    return r.ok === true ? r : null;
  });
  assert.equal(result.state, "failed", `子抛错 ⇒ 名册 failed：${JSON.stringify(result)}`);
  assert.equal(result.error, boom, "result.error 必须是子抛出的错误文本（缺陷 A 的另一半）");
  assert.ok(result.error.length <= ERROR_MESSAGE_LIMIT, `errorMessage 上限 ${ERROR_MESSAGE_LIMIT} 字符`);
  assert.equal(result.text, undefined, "抛错的子没有终稿 ⇒ 不带 text 键");

  const record = readRecord(delegationDir, ran.runId);
  assert.equal(record.errorMessage, boom);
  assert.equal("resultText" in record, false, "没终稿就不许写 resultText（更不许写成 \"undefined\"）");
});

// ── B ───────────────────────────────────────────────────────────────────────────────
test("真装配（#630 B）：模型不给 cwd ⇒ 名册记父 cwd 的绝对路径，子真的在那个目录里跑", async () => {
  const root = await makeTmp("erix-delegate-630-b-");
  const delegationDir = join(root, "delegation");
  const relativeChildFile = "child-rel-630.txt";
  const provider = createRoutingFakeProvider({
    childScript: [
      {
        content: [{
          type: "tool_use",
          id: "child-630-b-1",
          name: "writeFile",
          input: { path: relativeChildFile, content: "written-by-child-630" },
        }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "写完了" }], stopReason: "end_turn" },
    ],
  });
  const delegation = createCliDelegation({
    buildProvider: () => provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    cwd: root,
    todo: false,
    notesDir: join(root, "notes"),
    rosterDir: delegationDir,
    maxRounds: 4,
    notify: () => {},
    childToolOutput: () => {},
  });

  const ran = await delegation.execute({ action: "run", task: "写一个相对路径文件" }, { runId: "parent-630b" });
  assert.equal(ran.ok, true, `前台派生应成功：${JSON.stringify(ran)}`);

  const record = readRecord(delegationDir, ran.runId);
  assert.equal(record.cwd, root, "模型没给 cwd ⇒ 名册必须记**实际生效**的父 cwd 绝对路径（缺陷 B：以前是 null）");
  assert.equal(record.cwd.includes(".."), false, "名册 cwd 必须是解析后的绝对路径，不是模型原值");

  // 「记录一个、执行另一个」的反证：子 run 收到的 cwd（系统提示里那句）与名册**逐字相同**。
  const childRequest = provider.requests.find((r) => r.role === "child");
  assert.ok(childRequest, "子 run 必须真的发过请求");
  assert.equal(childCwdFromPrompt(childRequest.system), record.cwd, "runChild 收到的 cwd 必须与名册逐字相同");

  // 事实核对：子用相对路径写文件 ⇒ 落在名册说的那个目录里（以前名册 null、文件却落在父树，无从对账）。
  assert.equal(
    await readFile(join(record.cwd, relativeChildFile), "utf8"),
    "written-by-child-630",
    "子 run 的相对路径写入必须落在名册 cwd 下",
  );
});

test("真装配（#630 B）：模型给相对 cwd ⇒ 名册是解析后的绝对路径", async () => {
  const root = await makeTmp("erix-delegate-630-b-rel-");
  const delegationDir = join(root, "delegation");
  const requested = "child-630-rel";
  const provider = createRoutingFakeProvider({
    childScript: [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }],
  });
  const delegation = createCliDelegation({
    buildProvider: () => provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    cwd: root,
    todo: false,
    notesDir: join(root, "notes"),
    rosterDir: delegationDir,
    maxRounds: 4,
    notify: () => {},
    childToolOutput: () => {},
  });

  const ran = await delegation.execute({ action: "run", task: "在相对目录里跑", cwd: requested }, { runId: "parent-630br" });
  assert.equal(ran.ok, true, `前台派生应成功：${JSON.stringify(ran)}`);

  const record = readRecord(delegationDir, ran.runId);
  // CLI 的 `cwdFor` 是 `path.resolve(requested ?? parentCwd)`：相对路径按**进程 cwd** 解析。
  assert.equal(record.cwd, resolve(requested), "名册必须记解析后的绝对路径，不是模型给的原字符串");
  assert.notEqual(record.cwd, requested, "原样字符串就是缺陷 B 的现场");
  const childRequest = provider.requests.find((r) => r.role === "child");
  assert.equal(childCwdFromPrompt(childRequest.system), record.cwd, "runChild 收到的 cwd 必须与名册逐字相同");
});

test("库面（#630 B）：cwdFor 的返回值既写名册又交给 runChild；非空字符串校验照 transcriptPathFor 的风格", async () => {
  const root = await makeTmp("erix-delegate-630-b-lib-");
  const rosterDir = join(root, "roster");
  const seen = [];
  const tool = createDelegateTool({
    rosterDir,
    cwdFor: (requested, runId) => {
      seen.push({ requested, runId });
      return join(root, "resolved-by-host");
    },
    runChild: async (request) => {
      seen.push({ childCwd: request.cwd, runId: request.runId });
      return { text: "ok", termination: "end_turn" };
    },
  });

  const ran = await tool.execute({ action: "run", task: "t" }, { runId: "parent-630bl" });
  assert.equal(ran.ok, true, JSON.stringify(ran));
  const record = readRecord(rosterDir, ran.runId);
  assert.equal(record.cwd, join(root, "resolved-by-host"), "名册记的必须是 cwdFor 的返回值");
  assert.deepEqual(seen[0], { requested: undefined, runId: ran.runId }, "cwdFor 收到模型原值（缺省 undefined）与 runId");
  assert.equal(seen[1].childCwd, record.cwd, "runChild 收到的 cwd 必须与名册逐字相同（不许记录一个、执行另一个）");

  // 空串 / 非字符串 ⇒ 当场 TypeError（消息里带 runId 与实际收到的值），且不落任何记录。
  for (const bad of ["", null, 42]) {
    const badTool = createDelegateTool({
      rosterDir: join(root, "roster-bad"),
      cwdFor: () => bad,
      runChild: async () => ({ text: "never", termination: "end_turn" }),
    });
    await assert.rejects(
      () => badTool.execute({ action: "run", task: "t" }, { runId: "parent-630bad" }),
      (error) => {
        assert.equal(error instanceof TypeError, true, `必须是 TypeError：${error}`);
        assert.match(error.message, /cwdFor/u);
        assert.match(error.message, /parent-630bad|sub-/u, "消息里要点名 runId");
        assert.ok(error.message.includes(JSON.stringify(bad)), `消息里要带实际收到的值：${error.message}`);
        return true;
      },
    );
  }
});

// ── C ───────────────────────────────────────────────────────────────────────────────
test("真装配（#630 C）：父 allowlist 只含 readFile ⇒ 子工具面 ⊆ {readFile}（exec / 写类工具都不在）", async () => {
  const root = await makeTmp("erix-delegate-630-c-");
  const delegationDir = join(root, "delegation");
  const provider = createRoutingFakeProvider({
    childScript: [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }],
  });
  const delegation = createCliDelegation({
    buildProvider: () => provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    cwd: root,
    todo: false,
    notesDir: join(root, "notes"),
    rosterDir: delegationDir,
    maxRounds: 4,
    notify: () => {},
    childToolOutput: () => {},
    toolAllowlist: "readFile",
  });

  const ran = await delegation.execute({ action: "run", task: "只读任务" }, { runId: "parent-630c" });
  assert.equal(ran.ok, true, `前台派生应成功：${JSON.stringify(ran)}`);

  const childRequest = provider.requests.find((r) => r.role === "child");
  assert.ok(childRequest, "子 run 必须真的发过请求");
  // `request.tools` 就是引擎递给 provider 的工具面 = 传给子 `runToolLoop` 的 `tools`。
  assert.deepEqual(
    [...childRequest.toolNames].sort(),
    ["readFile"],
    `子工具面必须 ⊆ 父的白名单（缺陷 C：以前子无条件拿全量，父收窄时子反而扩权）：${JSON.stringify(childRequest.toolNames)}`,
  );
  for (const forbidden of ["exec", "writeFile", "edit", "delegate", "note_take"]) {
    assert.equal(
      childRequest.toolNames.includes(forbidden),
      false,
      `子工具面不许含 ${forbidden}（父没给这个权限）`,
    );
  }
  // 提示词与工具面同一侧：清单行也不许提父没给的 exec。
  const listLine = toolListLine(childRequest.system);
  assert.ok(listLine !== null, "子系统提示必须有工具清单行");
  assert.match(listLine, /readFile/u);
  assert.equal(listLine.includes("exec"), false, `提示词不许说有、工具面没有：${listLine}`);
});

test("真装配（#630 C）：allowlist 缺省 ⇒ 父子都全量（子仍有 exec，行为不变）", async () => {
  const root = await makeTmp("erix-delegate-630-c-default-");
  const delegationDir = join(root, "delegation");
  const provider = createRoutingFakeProvider({
    childScript: [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }],
  });
  const delegation = createCliDelegation({
    buildProvider: () => provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    cwd: root,
    todo: false,
    notesDir: join(root, "notes"),
    rosterDir: delegationDir,
    maxRounds: 4,
    notify: () => {},
    childToolOutput: () => {},
  });

  const ran = await delegation.execute({ action: "run", task: "全量任务" }, { runId: "parent-630cd" });
  assert.equal(ran.ok, true, JSON.stringify(ran));
  const childRequest = provider.requests.find((r) => r.role === "child");
  assert.ok(childRequest.toolNames.includes("exec"), "allowlist 缺省时子工具面照旧是全量");
  assert.equal(childRequest.toolNames.includes("delegate"), false, "v1 不递归：delegate 永不下传");
});

test("真装配（#630 C，CLI 接线）：--tools readFile,delegate ⇒ 子的工具面只剩 readFile", async () => {
  const root = await makeTmp("erix-delegate-630-c-cli-");
  const delegationDir = join(root, "delegation");
  const configPath = await writeEmptyMcpConfig(join(root, "mcp"));
  const provider = createRoutingFakeProvider({
    parentScript: [
      {
        content: [{
          type: "tool_use",
          id: "parent-630c-1",
          name: "delegate",
          input: { action: "run", task: "只读任务" },
        }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "任务已完成：父 run 收尾" }], stopReason: "end_turn" },
    ],
    childScript: [{ content: [{ type: "text", text: "任务已完成：子 run 收尾" }], stopReason: "end_turn" }],
  });

  const result = await runChat({
    prompt: "派生一个只读子任务",
    session: "delegate-630c-parent",
    cwd: root,
    dir: join(root, "transcripts"),
    notesDir: join(root, "notes"),
    skillsDir: join(root, "skills"),
    configPath,
    provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    maxRounds: 4,
    idleTimeout: 0,
    delegate: true,
    delegationDir,
    // 父会话的白名单：delegate 自己要留（否则父调不到派生），readFile 是父允许的全部权限。
    tools: "readFile,delegate",
    toolOutput: () => {},
    idleLog: () => {},
  });
  assert.equal(result.termination?.reason, "end_turn", `父 run 应正常收尾：${JSON.stringify(result.termination)}`);

  const childRequest = provider.requests.find((r) => r.role === "child");
  assert.ok(childRequest, "子 run 必须真的被跑起来（父的 delegate 调用真的下传了）");
  assert.deepEqual(
    [...childRequest.toolNames].sort(),
    ["readFile"],
    `cli.js 必须把 --tools 下传成 toolAllowlist（缺陷 C 的接线面）：${JSON.stringify(childRequest.toolNames)}`,
  );
  assert.equal(childRequest.toolNames.includes("exec"), false, "父只开 readFile ⇒ 子不许有 exec");
  assert.equal(childRequest.toolNames.includes("delegate"), false, "v1 不递归：delegate 永不下传");
  const listLine = toolListLine(childRequest.system);
  assert.ok(listLine !== null);
  assert.equal(listLine.includes("exec"), false, `子提示词的工具清单行不许提 exec：${listLine}`);
});
