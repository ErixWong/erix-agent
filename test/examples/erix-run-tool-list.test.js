// issue #312(b)：工具清单单一来源（宿主侧生成 + 双向装配期断言）。
//
// 这个文件钉的是四条判据里源码自己看不出来的那几条：
//   C2 双向都真红 —— 短语表留着名字而注册面删了 ⇒ 红；注册面加了名字而短语表没有 ⇒ 红。
//       变异走 `buildCliToolsSystemPrompt({ names })` 注入，不动源码（同 C2 手工 `cp` 变异互为佐证）。
//   C3 note_* 红点被处理 —— 选的是 (i)：四个 note_* 由宿主补进清单，`note_forget` 必须可见。
//   C4 兜底不再静默 —— 「有 createCliTools、无 buildCliToolsSystemPrompt」必须走生成路径（列全），
//       「两者都没有」必须显式抛错；都不许退成旧的六件套名单。
//   R4 兜底文案自身的快照 —— 以前没有 golden，这里补一份（宿主文案没有 cli-golden 钉着）。
//
// 全离线：真 lib（src/index.js + bin/tools.js）+ 内存 notes store，不触网、不碰 ~/.erix。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as binTools from "../../bin/tools.js";
import * as libIndex from "../../src/index.js";
import * as core from "../../examples/pi-extension/erix-run-core.js";

const REAL_LIB = { binTools };

/** 真注册面 + 真 note_* 装配（与 `createInnerTools` 拼给 runToolLoop 的那个数组同构）。 */
function realTools({ todo = false, notes = true } = {}) {
  const cli = binTools.createCliTools({ cwd: "/nonexistent-cwd", todo });
  if (!notes) return cli.tools;
  const notesAssembler = libIndex.createBuiltinNotesTools({
    runId: "312b-tool-list",
    notesStore: libIndex.createMemoryNotesStore(),
  });
  return [...cli.tools, ...notesAssembler.definitions];
}

test("R2 清单行由注册面生成：注册面与短语表两侧逐名对齐（不是文本扫描）", () => {
  const registered = binTools.cliToolDefinitions().map((schema) => schema.name);
  assert.deepEqual(
    Object.keys(binTools.CLI_TOOL_PROMPT_PHRASES),
    registered,
    "短语表的 key 必须与注册面的 name 同序同集合：任何一侧多动一个名字都该在这里红",
  );
  // 清单行里每个工具名都真在注册面上（反向亦然），且 todo=false 只是少拼一段，不是名单变了样。
  for (const todo of [true, false]) {
    const prompt = binTools.buildCliToolsSystemPrompt({ todo });
    const listLine = prompt.match(/可用工具：[^\n]*。/u)?.[0] ?? "";
    for (const name of binTools.cliToolDefinitions({ todo }).map((schema) => schema.name)) {
      assert.ok(listLine.includes(name), `todo=${todo}：注册面上的 ${name} 必须出现在清单行里`);
    }
    const expectedTodoNames = todo ? [...binTools.TODO_TOOL_NAMES] : [];
    const unexpectedTodoNames = todo === false ? [...binTools.TODO_TOOL_NAMES] : [];
    for (const name of expectedTodoNames) {
      assert.ok(listLine.includes(name), `todo=${todo} 应当带上 ${name}`);
    }
    for (const name of unexpectedTodoNames) {
      assert.doesNotMatch(listLine, new RegExp(name, "u"), `todo=false 不得带出 ${name}`);
    }
  }
});

test("C2② 短语表留着 searchText 而注册面删掉 ⇒ build 期抛错（提示词 ⊄ 注册面）", () => {
  const names = binTools.cliToolDefinitions().map((s) => s.name).filter((n) => n !== "searchText");
  assert.throws(
    () => binTools.buildCliToolsSystemPrompt({ names }),
    /短语表里有注册面没有的名字[\s\S]*searchText/u,
    "删了工具却留着文案，正是旧世界静默的那一侧",
  );
});

test("C2① 注册面摘掉 edit（短语表同步删掉才不报陈旧）⇒ 清单里没有 edit；短语表不删就红", () => {
  const names = binTools.cliToolDefinitions().map((s) => s.name).filter((n) => n !== "edit");
  const phrases = { ...binTools.CLI_TOOL_PROMPT_PHRASES };
  delete phrases.edit;
  const prompt = binTools.buildCliToolsSystemPrompt({ names, phrases, fullNames: names });
  const listLine = prompt.match(/可用工具：[^\n]*。/u)?.[0] ?? "";
  assert.doesNotMatch(listLine, /\bedit\b/u, "注册面没有 edit，清单行就不许凭空写它");
  assert.throws(
    () => binTools.buildCliToolsSystemPrompt({ names }),
    /短语表里有注册面没有的名字[\s\S]*edit/u,
    "只删注册面、不删文案 ⇒ 必须红（这就是旧「删掉 edit 不会有测试变红」的补票）",
  );
});

test("注册面新增工具而短语表没有文案 ⇒ build 期抛错（注册面 ⊄ 提示词，拒绝静默漏列）", () => {
  const names = [...binTools.cliToolDefinitions().map((s) => s.name), "brandNewTool"];
  assert.throws(
    () => binTools.buildCliToolsSystemPrompt({ names, fullNames: names }),
    /注册面上的工具没有清单文案[\s\S]*brandNewTool/u,
  );
});

test("C3 选 (i)：note_* 四个名字都进宿主清单，note_forget 可见（散文漏写它正是旧缺陷）", () => {
  const tools = realTools();
  const prompt = core.buildSystemPrompt({ lib: REAL_LIB, cwd: "/nonexistent-cwd", tools });
  const supplement = prompt.match(/本工具面另注册：[^\n]*/u)?.[0] ?? "";
  for (const name of ["note_take", "note_list", "note_read", "note_forget"]) {
    assert.ok(supplement.includes(name), `宿主清单必须登记 ${name}（它真在交给 runToolLoop 的数组里）`);
  }
  // 引擎提示词自己没写 note_forget —— 所以「靠散文兼容」在这里就是靠不住的那条证据。
  assert.doesNotMatch(binTools.CLI_TOOLS_SYSTEM_PROMPT, /note_forget/u);
  // 关掉 notes ⇒ 补行整体消失（而不是留一份写着的白名单）
  const bare = core.buildSystemPrompt({ lib: REAL_LIB, cwd: "/nonexistent-cwd", tools: realTools({ notes: false }) });
  assert.doesNotMatch(bare, /本工具面另注册/u);
});

test("C3 第三条：清单写了未注册的工具 ⇒ 装配期抛错（引擎清单有 todo_* 而 tools 被 --no-todo 滤掉）", () => {
  const ghostLib = {
    binTools: {
      buildCliToolsSystemPrompt: () => binTools.buildCliToolsSystemPrompt({ todo: true }),
      CLI_TOOL_PROMPT_PHRASES: binTools.CLI_TOOL_PROMPT_PHRASES,
    },
  };
  const tools = binTools.createCliTools({ cwd: "/nonexistent-cwd", todo: false }).tools;
  assert.throws(
    () => core.assertToolListMatchesRegistered({
      prompt: binTools.buildCliToolsSystemPrompt({ todo: true }),
      tools,
      universe: Object.keys(binTools.CLI_TOOL_PROMPT_PHRASES),
    }),
    /未注册的工具[\s\S]*todo_add/u,
  );
  // 同一个提示词配 todo=true 的注册面就绿：证明红的是名单，不是断言本身写死了。
  assert.deepEqual(core.assertToolListMatchesRegistered({
    prompt: binTools.buildCliToolsSystemPrompt({ todo: true }),
    tools: binTools.createCliTools({ cwd: "/nonexistent-cwd", todo: true }).tools,
    universe: Object.keys(binTools.CLI_TOOL_PROMPT_PHRASES),
  }), []);
  void ghostLib;
});

test("C4 「有 createCliTools、无 buildCliToolsSystemPrompt」走生成路径：列全 8 个，不退六件套", () => {
  const lib = { binTools: { createCliTools: binTools.createCliTools, CLI_TOOL_PROMPT_PHRASES: binTools.CLI_TOOL_PROMPT_PHRASES } };
  const prompt = core.buildSystemPrompt({ lib, cwd: "/nonexistent-cwd" });
  for (const name of binTools.cliToolDefinitions({ todo: false }).map((s) => s.name)) {
    assert.match(prompt, new RegExp(`(?:^|[^A-Za-z0-9_])${name}(?:[^A-Za-z0-9_]|$)`, "u"), `生成分支必须列出 ${name}`);
  }
  assert.match(prompt, /searchText/u, "旧手抄缺的两个之一");
  assert.match(prompt, /\bedit\b/u, "旧手抄缺的另一个");
  assert.equal(/readFile\/rg\/grep\/tree\/writeFile\/exec/u.test(prompt), false, "旧手抄字符串不得复活");
});

test("C4 拿不到注册面（无 createCliTools、无 buildCliToolsSystemPrompt、无 tools）⇒ 显式失败", async () => {
  await assert.rejects(async () => core.buildSystemPrompt({ lib: { binTools: {} }, cwd: "/nonexistent-cwd" }),
    (error) => error.code === "tool_list_unavailable");
  assert.throws(() => core.buildToolListLine({ tools: [], phrases: {} }),
    (error) => error.code === "tool_list_unavailable");
  // buildLoopOptions 的 system 缺省路径同样不再静默：它现在把真正交给 runToolLoop 的数组递进去。
  const options = core.buildLoopOptions({
    params: { cwd: "/nonexistent-cwd", task: "t", maxRounds: 1, timeoutMs: 1000 },
    slot: { endpoint: "e", model: "m", apiKey: "k", contextWindowTokens: 200_000, maxOutputTokens: 4096 },
    provider: { id: "p" },
    tools: { tools: realTools(), executeTool: async () => "" },
    store: {},
    signal: new AbortController().signal,
    runId: "312b-loopoptions",
  });
  assert.match(options.system, /searchText\b/u, "system 缺省时也必须从实际注册面生成");
  assert.match(options.system, /本工具面另注册：[^\n]*note_forget/u);
});

test("R4 兜底文案自身的快照 golden（以前没有：宿主文案全仓零 golden）", () => {
  const fixtureUrl = new URL("../fixtures/inner-tool-list-golden.json", import.meta.url);
  const expected = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  const actual = {
    // 引擎装配缺席的兜底分支：整段清单由实际注册数组生成。
    generated: core.buildSystemPrompt({
      lib: { binTools: { createCliTools: binTools.createCliTools, CLI_TOOL_PROMPT_PHRASES: binTools.CLI_TOOL_PROMPT_PHRASES } },
      cwd: "/snap",
    }),
    // 主路径（引擎装配在场）＋ 宿主 note_* 补行：钉住 note_forget 真的到了模型眼前。
    withNotes: core.buildSystemPrompt({
      lib: REAL_LIB,
      cwd: "/snap",
      tools: realTools(),
    }).replace(/\/nonexistent-cwd/g, "/snap"),
  };
  assert.deepEqual(actual, expected, "兜底文案变了就一起改 test/fixtures/inner-tool-list-golden.json（写明理由）");
});
