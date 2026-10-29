// 文档示例可执行性检查（issue #158）的 node:test 入口。
// 覆盖 `DOC_TARGETS` 里每一份目标文档的全部 js 围栏（L1 语法 / L2 链接 / L3 执行），
// 并锁定每份文档 CN 版 js 围栏与 EN 的代码骨架一致（代码不翻译；注释允许本地化）。
//
// issue #576：目标表从「只有两份契约文档」扩到「两份契约文档 + 两份根 README」，
// 而且**每个目标自带围栏数期望**（不再共用一个 `EXPECTED_JS_FENCE_COUNT` 语义）。
// 文件头那句「目标表必须覆盖 …」的守卫格是这张表的反向证：把某条目标摘掉
// （例如 `DOC_TARGETS = []`，或只删 README 那条），它立刻变红——否则「README 面进了
// harness」只是报告里的一句自述。
//
// 执行细节见 ./doc-examples.js。

import test from "node:test";
import assert from "node:assert/strict";
import {
  CN_DOC,
  DOC_TARGETS,
  EN_DOC,
  README_CN_DOC,
  README_DOC,
  README_DRIFT_HINT,
  README_FENCE_PREAMBLES,
  README_FENCE_STEPS,
  buildLevel3Env,
  codeSkeleton,
  compileLevel1,
  describeFailure,
  extractJsFences,
  isInheritedEngineKnob,
  runLevel2,
  runLevel3,
} from "./doc-examples.js";

const targets = DOC_TARGETS.map((target) => ({
  ...target,
  enFences: extractJsFences(target.en).map((fence, index) => ({ ...fence, index })),
  cnFences: extractJsFences(target.cn).map((fence, index) => ({ ...fence, index })),
}));

// #582 收尾（主 agent）：那 6 格断的是 `stderr.includes(README_DRIFT_HINT)` —— 拿常量自己比自己。
// 把常量掏成空串时 `includes("")` 恒真 ⇒ 60/60 全绿（主 agent 实测），诊断价值可以被人一句话改掉而无人报警。
// 所以这里钉住**文案自身的字面要件**：两种可能都在、方向词齐、给出该看哪个数。
test("README_DRIFT_HINT 自身必须点名两种可能与该看的计数（不许被掏空或改成无意义短语）", () => {
  assert.ok(README_DRIFT_HINT.length > 40, `提示语过短（${README_DRIFT_HINT.length} 字符），已不像一条可执行的排查指引`);
  for (const needle of ["两种可能", "示例接线", "引擎默认值漂移", "provider.requests.length", "README_FENCE_STEPS"]) {
    assert.ok(README_DRIFT_HINT.includes(needle), `提示语缺少要件 ${JSON.stringify(needle)}：${README_DRIFT_HINT}`);
  }
  // 方向必须说「不一致」而不是「增加」：epilogue 那条断言两个方向都会触发（主 agent 实测少一步也红）
  assert.ok(!/轮数增加/.test(README_DRIFT_HINT), "措辞只说「增加」会在『少要几轮』那条路径上误导人");
});

test("目标表必须覆盖两份契约文档与两份根 README（摘掉目标 ⇒ 本格必须红）", () => {
  assert.deepEqual(
    DOC_TARGETS.map((target) => target.name).sort(),
    ["README", "host-consumer-contract"],
    `DOC_TARGETS 现在只覆盖 ${JSON.stringify(DOC_TARGETS.map((target) => target.name))}：`
      + "两份契约文档与两份根 README 的 js 围栏都必须进这套三层验证（issue #576）",
  );
  const covered = new Set(DOC_TARGETS.flatMap((target) => [target.en, target.cn]));
  for (const doc of [EN_DOC, CN_DOC, README_DOC, README_CN_DOC]) {
    assert.ok(covered.has(doc), `${doc} 不在 DOC_TARGETS 的扫描面里：它的 js 围栏没人执行`);
  }
  for (const target of DOC_TARGETS) {
    assert.equal(
      target.preambles.length,
      target.expectedFences,
      `${target.name}: preamble 表 ${target.preambles.length} 条，围栏数期望 ${target.expectedFences} 条`,
    );
    // 「执行」不许退化成「空跑一遍语法」：每格都得有完成性断言。
    for (const [index, preamble] of target.preambles.entries()) {
      assert.ok(
        typeof preamble.epilogue === "string" && preamble.epilogue.trim() !== "",
        `${target.name} 第 ${index + 1} 个围栏的 preamble 没有 epilogue：L3 会变成「跑完就算过」`,
      );
    }
  }
});

for (const target of targets) {
  const label = target.name;

  test(`[${label}] EN 恰好扫到 ${target.expectedFences} 个 js 围栏（文档增删必须同步本测试）`, () => {
    assert.equal(
      target.enFences.length,
      target.expectedFences,
      `${target.en} 扫到 ${target.enFences.length} 个 js 围栏`
        + `（位于行 ${target.enFences.map((fence) => fence.line).join(", ")}），`
        + `期望 ${target.expectedFences} 个：文档示例增删未同步 test/doc-examples.js 的 DOC_TARGETS / preamble 配置`,
    );
  });

  test(`[${label}] CN js 围栏数量与 EN 一致`, () => {
    assert.equal(
      target.cnFences.length,
      target.enFences.length,
      `${target.cn} 扫到 ${target.cnFences.length} 个 js 围栏，${target.en} 扫到 ${target.enFences.length} 个`,
    );
  });

  test(`[${label}] CN js 围栏代码骨架与 EN 逐行一致（代码不翻译，注释可本地化）`, () => {
    assert.equal(target.cnFences.length, target.enFences.length, "围栏数量不一致，先修数量断言");
    const problems = [];
    for (const en of target.enFences) {
      const cn = target.cnFences[en.index];
      const enSkeleton = codeSkeleton(en.code).split("\n");
      const cnSkeleton = codeSkeleton(cn.code).split("\n");
      if (enSkeleton.join("\n") === cnSkeleton.join("\n")) continue;
      const firstDiff = enSkeleton.findIndex((line, lineIndex) => cnSkeleton[lineIndex] !== line);
      problems.push(
        `第 ${en.index + 1} 个围栏：EN ${target.en}:${en.line} vs CN ${target.cn}:${cn.line}`
          + `（首个差异在第 ${Math.max(firstDiff, 0) + 1} 行代码）\n`
          + `  EN: ${enSkeleton[Math.max(firstDiff, 0)] ?? "<CN 更短>"}\n`
          + `  CN: ${cnSkeleton[Math.max(firstDiff, 0)] ?? "<EN 更短>"}`,
      );
    }
    assert.equal(problems.length, 0, `CN/EN 代码骨架漂移：\n${problems.join("\n")}`);
  });

  for (const fence of target.enFences) {
    const fenceLabel = `${label} #${fence.index + 1} @ ${fence.line}`;

    test(`L1 语法 [${fenceLabel}]：围栏可编译为 async IIFE`, () => {
      try {
        compileLevel1(fence);
      } catch (error) {
        assert.fail(describeFailure(fence, "L1", `${error?.stack ?? error}`));
      }
    });

    test(`L2 链接 [${fenceLabel}]：erix-agent 导入与真实符号可链接`, async () => {
      const result = await runLevel2(fence);
      assert.ok(result.ok, describeFailure(fence, "L2", result.stderr));
    });

    test(`L3 执行 [${fenceLabel}]：示例体在注入上下文下真实跑通`, async () => {
      const result = await runLevel3(fence);
      assert.ok(
        result.ok,
        describeFailure(fence, "L3", `--- 子进程 stdout ---\n${result.stdout}\n--- 子进程 stderr ---\n${result.stderr}`),
      );
    });
  }
}

// ---------------------------------------------------------------------------
// issue #582 的反向证：README 三格的「假设几步」是**显式常量**（`README_FENCE_STEPS`），
// 而且失败文案里那句「两种可能」（`README_DRIFT_HINT`）必须真的在**失败路径**上——
// 不是报告里的一句自述、也不是源码里没人走的死字符串。
//
// 做法：把同一格 preamble 里烘焙的 `const __STEPS__ = N;` 改掉再跑一遍（`runLevel3` 的
// `preamble` 注入点就是为这件事开的）。两个方向都必须红，且红字里必须逐字出现那句话：
//   · 改小 ⇒ 脚本先耗尽（原来只会吐 `Fake provider script exhausted`，正是本单的病根）；
//   · 改大 ⇒ epilogue 的 `requests.length !== __STEPS__` 断言。
// 「变异没落上也算失败」（#210 R2）：`withSteps` 自己断言替换真的落上了。
// ---------------------------------------------------------------------------
const README_TARGET = targets.find((target) => target.name === "README");

/** 把一格 README preamble 里烘焙的 `const __STEPS__ = N;` 换成 `steps`（模拟「显式常量改错」）。 */
function withSteps(preamble, steps) {
  const stubs = preamble.stubs.replace(/const __STEPS__ = \d+;/, `const __STEPS__ = ${steps};`);
  assert.notEqual(
    stubs,
    preamble.stubs,
    "变异没落上：stubs 里没有 `const __STEPS__ = N;` 这一行（步数不再是显式常量，反向证就变成空转）",
  );
  return { ...preamble, stubs };
}

test("README 的步数假设是显式常量，且逐格烘进 preamble（issue #582）", () => {
  assert.ok(README_TARGET, "DOC_TARGETS 里没有 README 目标：下面两格反向证会跑在 undefined 上");
  assert.equal(
    README_FENCE_STEPS.length,
    README_FENCE_PREAMBLES.length,
    `README_FENCE_STEPS 有 ${README_FENCE_STEPS.length} 条，README_FENCE_PREAMBLES 有 ${README_FENCE_PREAMBLES.length} 条`
      + "：每格都得有一条「假设几步」，多一条少一条都是第二份真相",
  );
  for (const [index, steps] of README_FENCE_STEPS.entries()) {
    assert.ok(
      Number.isInteger(steps) && steps >= 1,
      `README_FENCE_STEPS[${index}] = ${String(steps)}：必须是正整数（0 步的脚本只会立刻耗尽）`,
    );
    assert.ok(
      README_FENCE_PREAMBLES[index].stubs.includes(`const __STEPS__ = ${steps};`),
      `README 第 ${index + 1} 格的 stubs 没有按 README_FENCE_STEPS[${index}] = ${steps} 备步`
        + "：常量与 preamble 脱钩了，改常量不会再改变这一格的行为",
    );
  }
});

for (const fence of README_TARGET.enFences) {
  const steps = README_FENCE_STEPS[fence.index];
  const fenceLabel = `README #${fence.index + 1} @ ${fence.line}`;

  test(`反向证 [${fenceLabel}]：步数常量改小一格（${steps} → ${steps - 1}）⇒ 该格必须红，且红字点名两种可能`, async () => {
    const result = await runLevel3(fence, {
      preamble: withSteps(README_TARGET.preambles[fence.index], steps - 1),
    });
    assert.equal(
      result.ok,
      false,
      `脚本只备 ${steps - 1} 步、而这一格实际要 ${steps} 步，却仍然绿：README_FENCE_STEPS 是装饰品`,
    );
    assert.ok(
      result.stderr.includes(README_DRIFT_HINT),
      `红字里没有「两种可能」那句（issue #582 的判据），实际 stderr：\n${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes(`实际已发起 ${steps} 次`),
      `红字没点名实际请求次数（该是 ${steps} 次），排查时还是得自己数：\n${result.stderr}`,
    );
  });

  test(`反向证 [${fenceLabel}]：步数常量改大一步（${steps} → ${steps + 1}）⇒ 该格也必须红`, async () => {
    const result = await runLevel3(fence, {
      preamble: withSteps(README_TARGET.preambles[fence.index], steps + 1),
    });
    assert.equal(
      result.ok,
      false,
      `脚本多备一步（${steps + 1}）而这一格实际只要 ${steps} 步，却仍然绿：`
        + "epilogue 的步数断言没落在真实失败路径上，常量只在一个方向上有意义",
    );
    assert.ok(
      result.stderr.includes(README_DRIFT_HINT),
      `红字里没有「两种可能」那句（issue #582 的判据），实际 stderr：\n${result.stderr}`,
    );
  });
}

// 第 1 格的「脚本先耗尽」是**另一条**失败路径（#582 的两个文案点各有一条）：
// 把脚本砍到只剩工具轮（1 步），第 2 次请求就在主循环里耗尽 ⇒ 进程非 0、stderr 里是 stubs 的
// 那句重抛，而不是 epilogue 的计数断言。这条独立钉住，免得只证到其中一条就说两条都活着。
test("反向证 [README #1 @ 66]：脚本砍到只剩工具轮（1 步）⇒ 主循环耗尽路径也必须红且带两种可能", async () => {
  const fence = README_TARGET.enFences[0];
  const result = await runLevel3(fence, { preamble: withSteps(README_TARGET.preambles[0], 1) });
  assert.equal(result.ok, false, "脚本只剩 1 步（工具轮）却仍然绿：第 2 次请求没被拦住");
  assert.ok(
    result.stderr.includes("假上游脚本耗尽"),
    `没走到 stubs 的耗尽重抛（红字里应该有「假上游脚本耗尽」）：\n${result.stderr}`,
  );
  assert.ok(
    result.stderr.includes(README_DRIFT_HINT),
    `耗尽路径的红字里没有「两种可能」那句（issue #582 的判据），实际 stderr：\n${result.stderr}`,
  );
});

// ---------------------------------------------------------------------------
// issue #583：L3 子进程的环境是**按规则构造**的，不是 `{ ...process.env }` 摊平。
//
// 病根是 #582 的另一半：次数被钉成「恰好等于」之后，任何会改轮数的宿主旋钮都能把守卫变红，
// 而红字长得和「引擎默认值漂移」一模一样。下面两格分工：
//   · 第 1 格是**纯函数**格：剥除规则本身（剥什么 / 留什么 / 不改入参 / 不是逐条清单）；
//   · 第 2 格是**行为**格：把宿主的引擎旋钮真的塞进 `process.env` 再跑 README 第 1 格，
//     必须仍然量到默认引擎的 `README_FENCE_STEPS[0]` 次请求（= 绿）。
// 第 2 格就是「变不出来即失败」（#210 R2）的反向证靶子：把 `buildLevel3Env` 掏成
// `{ ...inherited, ERIX_DOC_EXAMPLE_TMP: tmpDir }`（= 恢复成 `{ ...process.env }` 的语义），
// 或把 `runLevel3` 的 env 改回 `{ ...process.env }`，这一格当场红（实测 7 → 4 次请求）。
// ---------------------------------------------------------------------------
test("L3 环境构造：剥继承来的引擎旋钮、留 harness 的 ERIX_DOC_EXAMPLE_* 与执行必需变量（issue #583）", () => {
  const inherited = {
    // 执行必需 / 非引擎变量：一律保留
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
    LANG: "C.UTF-8",
    TZ: "UTC",
    NODE_OPTIONS: "--no-warnings",
    // `:604` 那格的示例体把 process.env.LLM_API_KEY 递给 createOpenAIProvider ⇒ 不许剥
    LLM_API_KEY: "host-llm-key",
    // 宿主的引擎旋钮：一律剥掉
    ERIX_NO_REFLECTION: "1",
    ERIX_JUDGE_MODEL: "whatever",
    ERIX_JUDGE_INTERVAL: "1",
    ERIX_REFLECTION: "off",
    ERIX_NO_ROUND_JUDGE: "1",
    ERIX_NOTES_DIR: "/host/notes",
    ERIX_SOME_FUTURE_KNOB_NOT_IN_ANY_LIST: "1",
    // harness 自己的命名空间：保留（TMP 由 harness 覆盖）
    ERIX_DOC_EXAMPLE_TMP: "/host/should-be-overridden",
    ERIX_DOC_EXAMPLE_KEY: "host-doc-example-key",
  };
  const env = buildLevel3Env({ inherited, tmpDir: "/harness/tmp" });

  const leaked = Object.keys(env).filter(isInheritedEngineKnob);
  assert.deepEqual(
    leaked,
    [],
    `继承面里的引擎旋钮没剥掉：${JSON.stringify(leaked)} —— L3 量到的就不是「默认引擎」了，`
      + "宿主 shell 里的旋钮会把 #582 的「恰好几步」变成假红（issue #583 的病根）",
  );
  for (const key of ["ERIX_NO_REFLECTION", "ERIX_JUDGE_MODEL", "ERIX_REFLECTION", "ERIX_NOTES_DIR"]) {
    assert.ok(!(key in env), `${key} 还在 L3 子进程的环境里：它会影响轮数 / 落盘位置，必须剥掉`);
  }
  // 剥错的另一半：把 harness 自己的命名空间也剥掉，围栏读不到临时目录会以另一种方式假红。
  assert.equal(env.ERIX_DOC_EXAMPLE_KEY, "host-doc-example-key", "ERIX_DOC_EXAMPLE_* 是 harness 自己的命名空间，不许剥");
  assert.equal(env.ERIX_DOC_EXAMPLE_TMP, "/harness/tmp", "ERIX_DOC_EXAMPLE_TMP 必须被 harness 的 makeTmp 目录覆盖");
  for (const key of ["PATH", "HOME", "LANG", "TZ", "NODE_OPTIONS", "LLM_API_KEY"]) {
    assert.equal(env[key], inherited[key], `执行必需 / 非引擎变量 ${key} 被剥掉了：子进程会以别的方式失败`);
  }
  assert.equal(inherited.ERIX_NO_REFLECTION, "1", "buildLevel3Env 改了传入的环境对象：它必须造新对象");
  // 规则本身是**前缀**而不是逐条清单：清单漏一个新旋钮就悄悄退化成本单的病根。
  assert.equal(isInheritedEngineKnob("ERIX_SOME_FUTURE_KNOB_NOT_IN_ANY_LIST"), true,
    "剥除规则退化成逐条清单了：以后新增的引擎旋钮会重新溜进 L3 子进程（issue #583）");
  assert.equal(isInheritedEngineKnob("ERIX_DOC_EXAMPLE_FUTURE"), false, "harness 自己的命名空间不许被当成引擎旋钮");
  assert.equal(isInheritedEngineKnob("PATH"), false, "非 ERIX_ 命名空间的变量不归这条规则管");
  // 生产路径（默认 process.env）同样必须满足「一个引擎旋钮都不留」。
  const ambient = buildLevel3Env({ tmpDir: "/harness/tmp" });
  assert.deepEqual(
    Object.keys(ambient).filter(isInheritedEngineKnob),
    [],
    "默认（process.env）路径上仍有引擎旋钮漏进 L3 子进程",
  );
});

// 宿主的引擎旋钮清单：每一条都是 `src/` 真的会读的（或按前缀规则必须一并剥的）名字。
// 用 `ERIX_NO_REFLECTION=1` 打头是有原因的：它是主 agent 实测能把这套守卫变红的那个（7 → 4 次请求）。
const HOSTILE_ENGINE_ENV = {
  ERIX_NO_REFLECTION: "1",
  ERIX_NO_ROUND_JUDGE: "1",
  ERIX_JUDGE_INTERVAL: "1",
  ERIX_JUDGE_MODEL: "whatever",
  ERIX_REFLECTION: "off",
  ERIX_NO_WRAPUP_INSTRUCTION: "1",
  ERIX_WRAPUP_NORMALIZE: "1",
  ERIX_STALL_MODE: "off",
  ERIX_NO_FORCED_FINAL: "1",
  ERIX_NOTES_DIR: "/nonexistent-doc-example-notes",
};

test(`L3 子进程不继承宿主的引擎旋钮：${Object.keys(HOSTILE_ENGINE_ENV).length} 个旋钮全塞进 process.env，README #1 仍量到默认引擎的 ${README_FENCE_STEPS[0]} 次请求（issue #583）`, async () => {
  const fence = README_TARGET.enFences[0];
  // 逐键快照 → 恢复：只动本格自己塞进去的那几个键，宿主原本的值（如果有）原样还回去。
  const saved = new Map(Object.keys(HOSTILE_ENGINE_ENV).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(HOSTILE_ENGINE_ENV)) process.env[key] = value;
  try {
    const result = await runLevel3(fence);
    assert.ok(
      result.ok,
      describeFailure(fence, "L3", [
        "宿主的引擎旋钮溜进了 L3 子进程：这一格在宿主环境 "
          + `${JSON.stringify(HOSTILE_ENGINE_ENV)} 下必须仍量到「默认引擎」`
          + `（README_FENCE_STEPS[0] = ${README_FENCE_STEPS[0]} 次请求）。`,
        "红成这样说明**剥除规则失效了**（buildLevel3Env 被掏成 `{ ...process.env }`）——",
        "既不是引擎默认值漂移，也不是 README 坏了（issue #583）。",
        `--- 子进程 stdout ---\n${result.stdout}`,
        `--- 子进程 stderr ---\n${result.stderr}`,
      ].join("\n")),
    );
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
