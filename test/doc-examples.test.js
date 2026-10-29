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
  codeSkeleton,
  compileLevel1,
  describeFailure,
  extractJsFences,
  runLevel2,
  runLevel3,
} from "./doc-examples.js";

const targets = DOC_TARGETS.map((target) => ({
  ...target,
  enFences: extractJsFences(target.en).map((fence, index) => ({ ...fence, index })),
  cnFences: extractJsFences(target.cn).map((fence, index) => ({ ...fence, index })),
}));

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
