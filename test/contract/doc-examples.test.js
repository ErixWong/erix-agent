// 契约文档示例可执行性检查（issue #158）的 node:test 入口。
// 覆盖 docs/host-consumer-contract.md 的全部 js 围栏（L1 语法 / L2 链接 / L3 执行），
// 并锁定 CN 版（host-consumer-contract_cn.md）js 围栏与 EN 的代码骨架一致
// （代码不翻译；注释允许本地化，CN 版的中文注释是既有状态）。
// 执行细节见 ./doc-examples.js。

import test from "node:test";
import assert from "node:assert/strict";
import {
  CN_DOC,
  EN_DOC,
  EXPECTED_JS_FENCE_COUNT,
  codeSkeleton,
  compileLevel1,
  describeFailure,
  extractJsFences,
  runLevel2,
  runLevel3,
} from "./doc-examples.js";

const enFences = extractJsFences(EN_DOC).map((fence, index) => ({ ...fence, index }));
const cnFences = extractJsFences(CN_DOC).map((fence, index) => ({ ...fence, index }));

test(`EN 契约文档恰好扫到 ${EXPECTED_JS_FENCE_COUNT} 个 js 围栏（文档增删必须同步本测试）`, () => {
  assert.equal(
    enFences.length,
    EXPECTED_JS_FENCE_COUNT,
    `${EN_DOC} 扫到 ${enFences.length} 个 js 围栏（位于行 ${enFences.map((f) => f.line).join(", ")}），`
      + `期望 ${EXPECTED_JS_FENCE_COUNT} 个：文档示例增删未同步 test/contract/doc-examples.js 的 preamble 配置`,
  );
});

test("CN 契约文档 js 围栏数量与 EN 一致", () => {
  assert.equal(
    cnFences.length,
    enFences.length,
    `${CN_DOC} 扫到 ${cnFences.length} 个 js 围栏，${EN_DOC} 扫到 ${enFences.length} 个`,
  );
});

test("CN 契约文档 js 围栏代码骨架与 EN 逐行一致（代码不翻译，注释可本地化）", () => {
  assert.equal(cnFences.length, enFences.length, "围栏数量不一致，先修数量断言");
  const problems = [];
  for (const en of enFences) {
    const cn = cnFences[en.index];
    const enSkeleton = codeSkeleton(en.code).split("\n");
    const cnSkeleton = codeSkeleton(cn.code).split("\n");
    if (enSkeleton.join("\n") === cnSkeleton.join("\n")) continue;
    const firstDiff = enSkeleton.findIndex((line, lineIndex) => cnSkeleton[lineIndex] !== line);
    problems.push(
      `第 ${en.index + 1} 个围栏：EN ${EN_DOC}:${en.line} vs CN ${CN_DOC}:${cn.line}`
        + `（首个差异在第 ${Math.max(firstDiff, 0) + 1} 行代码）\n`
        + `  EN: ${enSkeleton[Math.max(firstDiff, 0)] ?? "<CN 更短>"}\n`
        + `  CN: ${cnSkeleton[Math.max(firstDiff, 0)] ?? "<EN 更短>"}`,
    );
  }
  assert.equal(problems.length, 0, `CN/EN 代码骨架漂移：\n${problems.join("\n")}`);
});

for (const fence of enFences) {
  const label = `#${fence.index + 1} @ ${fence.line}`;

  test(`L1 语法 [${label}]：围栏可编译为 async IIFE`, () => {
    try {
      compileLevel1(fence);
    } catch (error) {
      assert.fail(describeFailure(fence, "L1", `${error?.stack ?? error}`));
    }
  });

  test(`L2 链接 [${label}]：erix-agent 导入与真实符号可链接`, async () => {
    const result = await runLevel2(fence);
    assert.ok(result.ok, describeFailure(fence, "L2", result.stderr));
  });

  test(`L3 执行 [${label}]：示例体在注入上下文下真实跑通`, () => {
    const result = runLevel3(fence);
    assert.ok(
      result.ok,
      describeFailure(fence, "L3", `--- 子进程 stdout ---\n${result.stdout}\n--- 子进程 stderr ---\n${result.stderr}`),
    );
  });
}
