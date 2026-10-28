// issue #521（#495 A2 前置刀）：共享夹具 `test/helpers/run-direct.js` 自己的格子。
//
// 这个文件只钉四件事，**每条都要能咬人**：
//   F. 夹具的翻译本身：扁平 `initialUserMessage` ⇒ `config.input.initialUserMessage`，
//      并且**并进同一个 `config` 容器**（不是新建第二个键）。
//   E. 等价性：走夹具的 run 与**宿主直接写新家**（`config.input.initialUserMessage`）的 run，
//      provider 收到的消息逐字相同。这条是「改的是写侧拼写、不是行为」的机器证据——少了它，
//      夹具可以靠悄悄改语义把测试弄绿。删键之后「对照组」不能再写扁平拼写（那已是被拒的旧拼写），
//      所以对照组换成新家的**原生写法**；强度不降：夹具的产物仍必须与宿主的规位写法逐字同效，
//      并且（同一格）**混进扁平键就会被引擎当场拒**——于是 F1 的「摘掉扁平键」不是装饰。
//   G. 重复容器守卫：`test/` 里每一处 `runDirect(` / `runToolLoop(` 的实参对象字面量，
//      **同一层不许出现两个 `config`（或两个 `capabilities`）键**。后者静默胜，是这次迁移的头号雷。
//   C. 收敛钉：已经 import 夹具的文件里，**不许再有任何** `runToolLoop({ … initialUserMessage: … })`
//      写点——种子只许从夹具这一个口子进。这条防的是「迁移了一半，剩下的又悄悄长回去」。
//
// 零真实 LLM（fake provider）、不写盘、不碰真实 `~/.erix`。

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { runDirect, withSeed } from "./helpers/run-direct.js";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const HELPER = resolve(TEST_ROOT, "helpers/run-direct.js");

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

// ================================================================ F. 翻译本身

test("F1 扁平 initialUserMessage ⇒ 并进 config.input.initialUserMessage，且扁平键被删掉", () => {
  const out = withSeed({ provider: "p", initialUserMessage: "go" });
  assert.equal("initialUserMessage" in out, false, "夹具必须把扁平键摘掉——否则引擎仍会看到旧拼写，删键那天这里就红");
  assert.deepEqual(out.config, { input: { initialUserMessage: "go" } });
  assert.equal(out.provider, "p", "其余选项逐字透传，夹具不替调用方补默认值");
});

test("F2 已有 config 容器时并进同一个键：`config` 的 own key 恰好一个，兄弟分组不丢", () => {
  const out = withSeed({ config: { run: { maxRounds: 2 }, input: { system: "S" } }, initialUserMessage: "go" });
  const configKeys = Object.keys(out).filter((key) => key === "config");
  assert.deepEqual(configKeys, ["config"], "同一层出现两个 config 键是后者静默胜——这正是朴素替换会造出来的形状");
  assert.deepEqual(out.config, {
    run: { maxRounds: 2 },
    input: { system: "S", initialUserMessage: "go" },
  });
});

test("F3 seed 是夹具自己的规范拼写，赢过旧拼写；undefined 逐字等于「没给种子」", () => {
  assert.deepEqual(withSeed({ seed: "new", initialUserMessage: "old" }).config, { input: { initialUserMessage: "new" } });
  const none = withSeed({ initialUserMessage: undefined, provider: "p" });
  assert.equal("config" in none, false, "没给种子时不许凭空造一个 config 容器（那会改掉「config 未给」的形状）");
  assert.equal("initialUserMessage" in none, false);
});

test("F4 形状拒绝格不被夹具吃掉：非对象 config / 非对象 config.input 原样透传", () => {
  // 这三格测的是「config 必须是对象」这条拒绝；夹具若硬并种子，名称闸口会先抛、文案换人。
  for (const bad of [null, [], "nested"]) {
    const out = withSeed({ config: bad, initialUserMessage: "go" });
    assert.equal(out.config, bad, `config: ${JSON.stringify(bad)} 必须原样透传`);
  }
  const badInput = withSeed({ config: { input: "nope" }, initialUserMessage: "go" });
  assert.deepEqual(badInput.config, { input: "nope" }, "config.input 非对象时同理");
});

// ================================================================ E. 等价性（行为面）

test("E1 走夹具的 run 与宿主直接写新家：provider 收到的 messages 逐字相同（且扁平键会当场被拒）", async () => {
  const viaFixture = createFakeProvider(DONE);
  const viaCanonical = createFakeProvider(DONE);
  const base = { executeTool: async () => "ok", completion: false, wrapup: false };
  // 夹具侧照旧写**扁平拼写**（那是夹具级 API，见文件头与 `withSeed` 的 JSDoc）。
  await runDirect({ ...base, provider: viaFixture, initialUserMessage: "同一句话" });
  // 对照组 = 宿主**直接写规位家**（`config.input.initialUserMessage`），不经夹具。
  await runToolLoop({
    ...base,
    provider: viaCanonical,
    config: { input: { initialUserMessage: "同一句话" } },
  });
  assert.deepEqual(
    viaFixture.requests[0].messages,
    viaCanonical.requests[0].messages,
    "种子消息必须逐字相同——夹具只改写侧拼写，不许改引擎看到的东西",
  );

  // 反向（同一格，钉住 F1 不是装饰）：把扁平键**塞回**夹具的产物里，引擎今天当场拒。
  // 也就是说「夹具把扁平键摘掉」是**必需的**，不是形状洁癖——漏摘就再也跑不起来。
  const leaked = { ...withSeed({ seed: "同一句话" }), initialUserMessage: "同一句话", ...base, provider: createFakeProvider(DONE) };
  await assert.rejects(
    () => runToolLoop(leaked),
    (error) => error instanceof TypeError
      && /^unknown runToolLoop option: "initialUserMessage"/.test(error.message),
    "扁平键一旦漏到引擎就会被名称闸口当场拒——夹具必须把它摘掉",
  );
});

test("E2 config.input.initialUserMessage 这条规位路径真的被引擎读（不是「翻了但没人读」）", async () => {
  const provider = createFakeProvider(DONE);
  await runDirect({ provider, executeTool: async () => "ok", completion: false, wrapup: false, seed: "规位路径" });
  const first = provider.requests[0].messages;
  assert.equal(first.length, 1, "只有一条种子消息");
  assert.equal(first[0].role, "user");
  assert.deepEqual(first[0].content, [{ type: "text", text: "规位路径" }]);
});

// ================================================================ 源码扫描：G / C

/** 从 `open` 位置的 `(` 起返回配对 `)` 的下标（跳过字符串 / 模板串 / 注释；配不上返 -1）。 */
function matchParen(src, open) {
  let depth = 0;
  for (let index = open; index < src.length; index += 1) {
    const ch = src[index];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (index += 1; index < src.length; index += 1) {
        if (src[index] === "\\") { index += 1; continue; }
        if (src[index] === ch) break;
      }
      continue;
    }
    if (ch === "/" && src[index + 1] === "/") { while (index < src.length && src[index] !== "\n") index += 1; continue; }
    if (ch === "/" && src[index + 1] === "*") {
      index += 2;
      while (index < src.length && !(src[index] === "*" && src[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

/**
 * 一段实参文本里**最外层对象字面量**的顶层键名（`{ a: 1, b: { c: 2 } }` ⇒ `["a", "b"]`）。
 *
 * 只认 `ident:` 形状（含 `"ident":`），`...spread` 与简写属性一律记成 `...`/标识符本身；
 * 深度 0 之外的分隔符不算切点，所以嵌套对象里的同名键**不会**被误报。
 */
function topLevelKeys(argsText) {
  const start = argsText.indexOf("{");
  if (start < 0) return [];
  const keys = [];
  let depth = 0;
  let segmentStart = start + 1;
  const push = (end) => {
    const segment = argsText.slice(segmentStart, end).trim();
    segmentStart = end + 1;
    if (!segment) return;
    const match = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/.exec(segment);
    if (match) keys.push(match[1] ?? match[2] ?? match[3]);
    else if (segment.startsWith("...")) keys.push("...");
  };
  for (let index = start; index < argsText.length; index += 1) {
    const ch = argsText[index];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (index += 1; index < argsText.length; index += 1) {
        if (argsText[index] === "\\") { index += 1; continue; }
        if (argsText[index] === ch) break;
      }
      continue;
    }
    if (ch === "/" && argsText[index + 1] === "/") { while (index < argsText.length && argsText[index] !== "\n") index += 1; continue; }
    if (ch === "/" && argsText[index + 1] === "*") {
      index += 2;
      while (index < argsText.length && !(argsText[index] === "*" && argsText[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      if (depth === 0) { push(index); return keys; }
    } else if (ch === "," && depth === 1) push(index);
  }
  return keys;
}

/** `test/` 下所有 `.js`（`test/contract/` 随包发布，单列；本文件与 helpers 不参与扫描）。 */
function testSources(root = TEST_ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!entry.endsWith(".js")) continue;
      out.push(full);
    }
  };
  walk(root);
  return out.filter((file) => file !== HELPER && !file.includes(`${join(TEST_ROOT, "helpers")}`))
    .map((file) => ({ file, rel: relative(TEST_ROOT, file).replace(/\\/g, "/"), src: readFileSync(file, "utf8") }));
}

/** 所有 `<callee>(` 调用的实参文本（callee ∈ 给定名单）。 */
function callArgs(src, callees) {
  const out = [];
  for (const callee of callees) {
    const pattern = new RegExp(`(?<![\\w.$])${callee}\\s*\\(`, "g");
    let match;
    while ((match = pattern.exec(src)) !== null) {
      const open = match.index + match[0].length - 1;
      const close = matchParen(src, open);
      if (close < 0) continue;
      out.push({ callee, args: src.slice(open, close + 1), at: match.index });
    }
  }
  return out;
}

test("G1 同一对象字面量里不许出现两个 config / 两个 capabilities 键（朴素替换的雷）", () => {
  const offenders = [];
  let scanned = 0;
  for (const { rel, src } of testSources()) {
    for (const { callee, args } of callArgs(src, ["runDirect", "sharedRunDirect", "runToolLoop"])) {
      scanned += 1;
      const keys = topLevelKeys(args);
      for (const container of ["config", "capabilities"]) {
        const hits = keys.filter((key) => key === container).length;
        if (hits > 1) offenders.push(`${rel}: ${callee}(…) 的实参里有 ${hits} 个 \`${container}\` 键`);
      }
    }
  }
  assert.deepEqual(offenders, [], `重复容器键（后者静默胜）：\n${offenders.join("\n")}`);
  assert.equal(scanned > 300, true, `扫描面不许退化（实测 ${scanned} 处调用）——0 处说明扫描器自己坏了，不是「很干净」`);
});

test("C1 夹具的**纯消费者**不许再把种子写给 runToolLoop（种子只许从夹具这一个口子进）", () => {
  // 判据从 import 拼写**派生**，不手抄文件名单：
  //   · 纯消费者 = `import { runDirect } from "…/helpers/run-direct.js"`（照旧写扁平拼写，夹具负责翻译）
  //     ⇒ 该文件里**不许**再有 `runToolLoop({ … initialUserMessage … })`；
  //   · 别名消费者 = `import { runDirect as sharedRunDirect }`（闸口/文案文件：它们要保留裸拼写来钉
  //     「旧名被接受/被拒」的逐字文案，另外自己包一层最小合法集）⇒ 允许，但必须真的在用夹具，
  //     且这个集合不许膨胀（膨胀就等于整条规矩被豁免掉了）。
  // #498 S3 A2b：判据从「文件里出现过这条路径」改成「文件**import 了**夹具」——前者会被任何
  // 提到夹具名字的文件（例如静态守卫里那句报错文案）误判成消费者。
  // 「纯消费者」= 按本名 import 了 `runDirect`（可以顺带 import `withSeed`——A2b 之后有 7 个文件
  // 两种拼写都用：走 `runDirect` 的照旧，走裸 `runToolLoop` 的用 `withSeed` 把种子翻译成规位家）。
  // #498 S3 A2b 把消费者分成三类，判据全部从 import 拼写**派生**，不手抄文件名单：
  //   · 纯消费者（PURE）= 按本名 import 了 `runDirect`（可以顺带 import `withSeed`）⇒ 该文件里
  //     **不许**再有绕过夹具的 `runToolLoop({ … initialUserMessage … })`；
  //   · 别名消费者（ALIASED）= `import { runDirect as sharedRunDirect }`（闸口/文案文件：它们要保留
  //     裸拼写来钉逐字文案，另外自己包一层最小合法集）⇒ 允许，但必须真的在用夹具，且集合不许膨胀；
  //   · 只用翻译器（SEED_ONLY）= 只 import `withSeed`（A2b 之后新增的一类：这些文件必须**保留裸
  //     `runToolLoop`**——它们测的是选项/闸口本身，走 `runDirect` 会把被测入口换掉——但种子必须经
  //     夹具翻译）。这一类同样受「不许绕过夹具」约束，且 import 不许是装饰（必须真的调用 `withSeed(`）。
  //
  // #498 S3 A2b：判据从「文件里出现过这条路径」改成「文件**import 了**夹具」——前者会被任何
  // 提到夹具名字的文件（例如静态守卫里那句报错文案）误判成消费者。
  const PURE = /^import\s+\{[^}]*\brunDirect\b(?!\s+as)[^}]*\}\s+from\s+"[^"]*helpers\/run-direct\.js";$/mu;
  const ALIASED = /^import\s+\{[^}]*\brunDirect\s+as\s+\w+[^}]*\}\s+from\s+"[^"]*helpers\/run-direct\.js";$/mu;
  const IMPORTS_HELPER = /^import\s+\{[^}]*\}\s+from\s+"[^"]*helpers\/run-direct\.js";$/mu;
  const pure = [];
  const aliased = [];
  const seedOnly = [];
  const offenders = [];
  for (const { rel, src } of testSources()) {
    if (!IMPORTS_HELPER.test(src)) continue;
    // 「绕过夹具」= 既没走 `runDirect`，也没用 `withSeed` 把种子翻译成规位家。
    // 唯一合法例外是**反向拒绝钉**：那一格测的就是「引擎拒收扁平拼写」，走夹具会把它翻译掉、
    // 断言变自说自话。例外必须**就地写明理由**（`// @seed-fixture-exempt: <理由>`），
    // 且理由不许为空——这是一条「豁免要留痕」的规矩，不是按文件名开的白名单。
    const seedsToRaw = callArgs(src, ["runToolLoop"])
      .filter(({ args }) => !/^\s*\(\s*withSeed\s*\(/u.test(args))
      .filter(({ args }) => topLevelKeys(args).includes("initialUserMessage"))
      .filter(({ at }) => !/\/\/\s*@seed-fixture-exempt:\s*\S/u.test(src.slice(Math.max(0, at - 400), at)))
      .map(({ callee, args }) => `${rel}: ${callee}(…) 还在绕过夹具（实参 ${args.length} 字符）`);
    if (PURE.test(src)) {
      pure.push(rel);
      offenders.push(...seedsToRaw);
      continue;
    }
    offenders.push(...seedsToRaw);
    if (ALIASED.test(src)) {
      aliased.push(rel);
      assert.equal(
        /sharedRunDirect\(|withSeed\(|\brunDirect\(/.test(src),
        true,
        `${rel} 豁免了裸拼写，却根本没在用夹具——那它凭什么豁免`,
      );
      continue;
    }
    seedOnly.push(rel);
    assert.equal(
      /\bwithSeed\(/u.test(src),
      true,
      `${rel} import 了 withSeed 却一次都没调——那是装饰性 import`,
    );
  }
  assert.deepEqual(offenders, [], `种子写点必须收敛到夹具这一个口子：\n${offenders.join("\n")}`);
  assert.equal(
    pure.length >= 70,
    true,
    `收敛面不许退化（实测 ${pure.length} 个纯消费者文件）；这一条防的是「迁移被回滚了但没人发现」`,
  );
  assert.equal(
    aliased.length <= 12,
    true,
    `别名消费者（闸口/文案文件）不许膨胀到 ${aliased.length} 个：${aliased.join(", ")}`,
  );
  assert.equal(
    seedOnly.length >= 1,
    true,
    `「只用翻译器」这一类不该是空的（实测 ${seedOnly.length} 个）——0 个说明分类逻辑坏了，不是「很干净」`,
  );
});

test("C2 夹具自己的反向证：把规位路径改错，C1/G1 之外的行为格必须红（本格只钉锚点存在）", () => {
  // 反向证本体是一次**手工 mutation**（改 helpers/run-direct.js 里的 `input` → `inputs` 再跑全量），
  // 结果写在交付报告里。这里钉住 mutation 要改的那段源码**还在**——否则那条反向证会静默失效。
  const src = readFileSync(HELPER, "utf8");
  assert.match(
    src,
    /config: \{ \.\.\.base, input: \{ \.\.\.\(input \?\? \{\}\), initialUserMessage: message \} \}/u,
    "反向证的锚点（唯一一处把种子写进 config.input 的表达式）必须还在原位",
  );
});
