#!/usr/bin/env node
/**
 * 变异样本真跑器 / 反向证（issue #257 T7；表核对随 #906 撤走）。
 *
 * 病根：#257 那张「测试边界真实性」大单的 T1–T6、T8 都已落地，只剩 T7——各刀**手工做过**的变异
 * （`messages` 数组身份、`retryable` 映射、4xx `code` 分类、`state-view` 活引用、`sessionScanPrefix`
 * 哈希式）验完就散了：证据只活在当时的会话里，下一次重构没有任何东西会因此变红。本脚本把那些变异
 * 固化成 `scripts/mutation-samples.mjs` 里的一份清单（只钉语义），并给出两种模式：
 *
 *   · `--run`：**真跑**。逐条把变异写进真文件、跑该条的捕获者、要求它**红且红在该报的那条断言上**，
 *     再还原、再跑一遍要求**绿**。这一条是「闸咬得住」的**唯一**机器证据，`npm run check:mutation:run`
 *     跑的就是它。
 *   · `--self-test`：上面这条判据的**反向证**，全部跑在**内存夹具**上（不落盘、不碰真树）：
 *     改坏一处必须红、不改必须绿、重复样本红并点名两条编号、变异没落上也必须判红（#210 R2 惯例）。
 *
 * 为什么不再有 `--verify` / `--sync`（#906）：过去这张表把**派生列**（行号 / 锚点 sha256 / 命中数）
 * 也钉成抄件，于是每一次代码漂移都得跑 `--sync` 刷表、否则 `--verify` 红。代价的实证：一次行号漂移
 * （表 764 / 树 765）让 `--verify` 红，而 `--run` 也跟着拒跑（拿漂了的表去真跑 = 把变异打在错地方）
 * ——抄件一漂，真判据直接被自己拖死。清单只留语义、派生列不再钉，代码漂移就**不再要求刷表**：
 * 行号由 `--run` 现读现用，锚点死没死由 `--run` 现场判定。恢复被删的旧表坐标：
 * `git show 27e1cd8b:test/mutation-samples.md`。
 *
 * 判据为什么这样定（逐条都能被 `--self-test` 打红）：
 *   1. **锚点必须是整行、且在该文件里唯一。** 用「整行相等」而不是子串：子串会随缩进 / 同行注释漂移；
 *      唯一性不成立时变异会打偏（改到第一个出现处，而捕获者验的是另一处），那种样本比没有样本更坏。
 *   2. **期望红签名必须命中 `not ok` 行。** 只要求「非 0 退出」是不够的：语法错、模块找不到、基线本来
 *      就红，三种都会非 0。所以样本必须写清「该报的那条断言」，本脚本只在**失败行**（`not ok N - …`）
 *      里找它 —— 注意测试名在通过时也会以 `# Subtest:` / `ok N -` 出现，只认 `not ok` 才咬得住。
 *      （这条**不许退化成「有红就行」**：红了但不是那条断言 = 失败。）
 *   3. **还原后必须绿。** 这一半是「红归因给变异」的前提：基线本身红的时候，变异后的红什么也不证明。
 *   4. **样本数有下限、id 必须连续。** 让闸变绿最省力的办法是删掉那条咬人的样本；下限挡住「删到 0」，
 *      连续 id 挡住「删中间一条、其余照旧」。
 *   5. **变异没落地 = 失败**（#210 R2）：锚点找不到时 `String.replace` 会**原样返回**，那时捕获者当然
 *      还是绿的 —— 若把它读成「变异被抓住」，整条判据就是恒真的。本脚本把它单独判成
 *      「变异没落地」，与「变异没被抓住」分开点名，因为两者的修法完全不同。
 *   6. **（目标文件, 锚点）不许重复**（#646 ④ 的语义、#906 的更硬口径）：并行分支各自重排编号会造出
 *      同一目标文件 + 同一锚点的两条样本（只差编号与措辞）—— 删掉一条，闸的覆盖面一点不减，而
 *      「一条变异咬一条断言」的账面数量虚高。判据直接取 `(file, anchor)` 两个语义字段，不碰行号，
 *      所以这条比原来更硬且不随代码漂移。
 *
 * 纪律：改动被样本锚定的 `src/` / `bin/` 真值 ⇒ 锚点若已死，`--run` 会点名「样本死了」要人判
 * （真值改了就改清单里的锚点，别改 `--run` 的判据）。新做过的变异值得常驻时，往清单里加一条
 * （id 续排、面写清、写清该红在哪条断言上），然后 `--run`。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLES } from "./mutation-samples.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 样本数下限（只许涨）：删一条样本让闸变绿，是这份清单最容易的腐化方式。 */
const MIN_SAMPLES = 8;

/** 期望红签名的最短长度：比这更短的串（含空串）等于没有断言。 */
const MIN_SIGNATURE_LENGTH = 4;

const USAGE = [
  "用法：",
  "  node scripts/mutation-sample-check.mjs --run        # 真跑：逐条变异 → 红在该报的断言上 → 还原 → 绿",
  "  node scripts/mutation-sample-check.mjs --self-test  # 判据的反向证（内存夹具，不落盘、不碰真树）",
].join("\n");

// ─────────────────────────────── 真值命中 ───────────────────────────────

/** 锚点在文件里的**整行**命中位置（1 基行号）。整行相等，见文件头判据 1。 */
function lineHits(text, anchor) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (line === anchor) out.push(i + 1);
  });
  return out;
}

// ─────────────────────────────── 重复样本 ───────────────────────────────

/**
 * 重复样本：**同一目标文件 + 同一锚点**（#646 ④，#906 改取语义字段）。
 *
 * 合并两支持平行分支时最容易长出这种东西：两边各自重排编号，并集里就出现 `M1 ≡ M9` —— 同锚点，
 * 只差编号与措辞。它让「一条变异咬一条断言」的账面数量虚高，而两条样本咬的是同一条断言（删掉一条，
 * 闸的覆盖面一点不减）。判据只取清单里的两个语义字段 `file` + `anchor`（#906：不再回树查行号，
 * 所以既更硬、又不随代码漂移）。
 */
function duplicatePairs(samples) {
  const byKey = new Map();
  for (const sample of samples) {
    const key = `${sample.file}\u0000${sample.anchor}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ id: sample.id, file: sample.file, anchor: sample.anchor });
  }
  return [...byKey.values()].filter((list) => list.length > 1);
}

/** 重复样本 → 一条红（点名每一条编号；超过两条时全部列出）。 */
function duplicateProblem(list) {
  const ids = list.map((r) => r.id).join(" 与 ");
  return `${ids}：重复样本——同一目标文件 ${list[0].file} + 同一锚点 ${JSON.stringify(list[0].anchor)}`
    + "（重复样本让「一条变异咬一条断言」的账面数量虚高；删掉多余的并重排编号）";
}

// ─────────────────────────────── 清单校验 ───────────────────────────────

/**
 * 校验清单（纯函数：文件读取与清单都可注入 —— `--self-test` 直接喂内存夹具）。
 * 只校验**语义判据**（派生列已不存在，无需对账）：返回问题清单，空数组 = 零处不一致。
 */
function validateSamples({ files, samples, minSamples = MIN_SAMPLES }) {
  const problems = [];

  if (samples.length < minSamples) {
    problems.push(`样本数被削：现在 ${samples.length} 条，下限 ${minSamples} 条——删样本 / 整条跳过不算修好`);
  }
  const seen = new Set();
  samples.forEach((sample, index) => {
    const where = `${sample.id}（${sample.file}）`;
    if (seen.has(sample.id)) problems.push(`${where}：id 重复`);
    seen.add(sample.id);
    const expectedId = `M${index + 1}`;
    if (sample.id !== expectedId) {
      problems.push(`${where}：id 不连续，第 ${index + 1} 条应为 ${expectedId}——`
        + "删掉中间一条却没重排，那条样本就会静默消失");
    }
    if (!sample.face) problems.push(`${where}：面 字段为空（这份清单存在的理由就是让人知道这条钉的是哪个行为面）`);
    if (!sample.anchor) problems.push(`${where}：锚点 字段为空`);
    if (!sample.mutation) problems.push(`${where}：变异 字段为空`);
    if (sample.anchor && sample.anchor === sample.mutation) {
      problems.push(`${where}：变异与锚点逐字相同——空变异不算样本（它永远不会红）`);
    }
    if (sample.signature.length < MIN_SIGNATURE_LENGTH) {
      problems.push(`${where}：期望红签名太短（${JSON.stringify(sample.signature)}）——`
        + `至少要 ${MIN_SIGNATURE_LENGTH} 个字符，否则「命中了」是巧合`);
    }
    if (files.read(sample.catcher) === null) {
      problems.push(`${where}：捕获者 ${sample.catcher} 不存在——样本没有闸可咬`);
    }
    const text = files.read(sample.file);
    if (text === null) {
      problems.push(`${where}：目标文件不存在`);
      return;
    }
    const hits = lineHits(text, sample.anchor);
    if (hits.length === 0) {
      problems.push(`DEAD_SAMPLE ${where}：锚点已不在该文件里（要人判：样本死了 —— 真值改了就改清单里的锚点）`);
    } else if (hits.length > 1) {
      problems.push(`${where}：锚点在该文件里出现 ${hits.length} 次（变异会打偏，锚点必须唯一）`);
    }
  });

  for (const list of duplicatePairs(samples)) problems.push(duplicateProblem(list));
  return problems;
}

// ─────────────────────────────── --run ───────────────────────────────

/**
 * 把一条变异落到文本上。**打不上就是失败**（#210 R2）：返回 `missed` 而不是「没变化，那就当成功」。
 * 用函数式替换，免得变异串里的 `$&` 之类被当成替换语法。
 */
function applyMutation(text, anchor, mutation) {
  const at = text.indexOf(anchor);
  if (at < 0) return { text, missed: `锚点不在文本里：${JSON.stringify(anchor)}` };
  const next = text.slice(0, at) + mutation + text.slice(at + anchor.length);
  if (next === text) return { text, missed: `替换后与原文逐字相同：${JSON.stringify(anchor)}` };
  return { text: next, missed: null };
}

/** 失败行里是否有「该报的那条」：只认 `not ok N - …`，通过时的 `ok N - …` / `# Subtest: …` 不算。 */
function failingLineFor(output, signature) {
  return output
    .split(/\r?\n/u)
    .find((line) => /^not ok \d+ - /u.test(line) && line.includes(signature)) ?? null;
}

/**
 * 逐条真跑（纯逻辑：文件读写与「跑一个捕获者」都可注入 —— 自测靠这个把裁决逻辑整条跑一遍，
 * 又不必真起进程、真写盘）。清单直接收 JS 数组（`scripts/mutation-samples.mjs` 导出的 `SAMPLES`）。
 */
function run({ files, samples, runTest, minSamples = MIN_SAMPLES, onPass = () => {}, onPending = () => {} }) {
  const listProblems = validateSamples({ files, samples, minSamples });
  if (listProblems.length) {
    return { listProblems, results: [], problems: [] };
  }
  const results = [];
  const problems = [];
  for (const sample of samples) {
    const original = files.read(sample.file);
    if (original === null) {
      problems.push(`${sample.id}：目标文件不存在（校验刚过就没了？）`);
      continue;
    }
    const applied = applyMutation(original, sample.anchor, sample.mutation);
    if (applied.missed) {
      problems.push(`${sample.id}：变异没落地——${applied.missed}（#210 R2：打不上的变异不算通过）`);
      continue;
    }
    let red;
    // `onPending` 把「待还原的文件与内容」交给调用方（真跑时由它挂信号钩子），
    // 这样「裁决逻辑」只此一份：真跑与自测走同一条路径。
    onPending({ file: sample.file, text: original });
    try {
      files.write(sample.file, applied.text);
      red = runTest(sample.catcher);
    } finally {
      files.write(sample.file, original);
      onPending(null);
    }
    if (files.read(sample.file) !== original) {
      problems.push(`${sample.id}：还原失败——${sample.file} 的内容与变异前不一致，先停手（后续样本的结果不可信）`);
      break;
    }
    const green = runTest(sample.catcher);
    const hit = failingLineFor(red.output ?? "", sample.signature);
    if (red.status === 0) {
      problems.push(`${sample.id}：变异没被抓住——${sample.catcher} 改完真值仍全绿（这条闸已经咬不住这个行为面）`);
      continue;
    }
    if (!hit) {
      problems.push(`${sample.id}：红了，但不是该报的那条——输出里没有含 ${JSON.stringify(sample.signature)} 的 "not ok" 行`);
      continue;
    }
    if (green.status !== 0) {
      problems.push(`${sample.id}：还原后仍红——基线本来就不干净，这条样本的红不能归因给变异`);
      continue;
    }
    results.push({ id: sample.id, face: sample.face, catcher: sample.catcher, hit });
    onPass(results[results.length - 1]);
  }
  return { listProblems: [], results, problems };
}

// ─────────────────────────────── 文件适配器 ───────────────────────────────

function realFiles(root) {
  return {
    read(rel) {
      try {
        return fs.readFileSync(path.join(root, rel), "utf8");
      } catch {
        return null;
      }
    },
    write(rel, text) {
      fs.writeFileSync(path.join(root, rel), text);
    },
  };
}

function memoryFiles(map) {
  return {
    read(rel) {
      return map.has(rel) ? map.get(rel) : null;
    },
    write(rel, text) {
      map.set(rel, text);
    },
  };
}

/**
 * spawn `node --test` 时**钉死** reporter（issue #774）。
 *
 * Node 24 把 `node --test` 的默认 reporter 换成了 spec，而本脚本只认 `not ok N - <签名>`（通过时的
 * `ok N -` / `# Subtest:` 不算，见文件头判据 2）。实测：同一棵树 `PATH=<node24> npm run check:mutation:run`
 * 会报「28 条样本没按预期咬住（0 条通过）」——不是样本失效，是 reporter 换了形状。
 * 常量单独放一处，自测里的 R1 / R1b 就盯它。
 */
const TEST_SPAWN_ARGS = Object.freeze(["--test", "--test-reporter=tap"]);

/** 真跑一个捕获者：`node --test --test-reporter=tap <file>`，stdout + stderr 一起交回（TAP 与崩溃信息分处两边）。 */
function realRunTest(catcher) {
  const r = spawnSync(process.execPath, [...TEST_SPAWN_ARGS, catcher], { cwd: ROOT, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * R1 的判据：reporter 钉还在吗（只读源码，不跑子进程；issue #774）。
 *
 * @param {string} source 本脚本的源码（真树或变异后的副本）
 * @returns {string[]}
 */
function checkReporterPin(source) {
  const problems = [];
  const decl = /const TEST_SPAWN_ARGS = Object\.freeze\(\[([^\]]*)\]\)/u.exec(source);
  if (!decl) {
    return ["读不到 `const TEST_SPAWN_ARGS = Object.freeze([…])` —— reporter 钉跑哪去了？"];
  }
  if (!/--test-reporter=tap/u.test(decl[1])) {
    problems.push(`spawn 捕获者的 argv 里没有 --test-reporter=tap（现在是：${decl[1].trim()}）`
      + "—— Node 24 的默认 reporter 是 spec，只认 `not ok` 的判据会把每一条样本都误报成「红了但不是该报的那条」");
  }
  if (!/spawnSync\(process\.execPath,\s*\[\s*\.\.\.TEST_SPAWN_ARGS/u.test(source)) {
    problems.push("realRunTest 的 spawn 没有展开 TEST_SPAWN_ARGS —— 钉上常量却没接上，等于没钉");
  }
  return problems;
}

// ─────────────────────────────── 命令行 ───────────────────────────────

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function mainRun() {
  const files = realFiles(ROOT);
  // 真跑会临时改写**真文件**：被信号打断时也要还原，否则下一次 `npm test` 会莫名其妙红。
  let pending = null;
  const restore = (signal) => {
    if (pending) {
      try {
        fs.writeFileSync(path.join(ROOT, pending.file), pending.text);
        process.stderr.write(`\n[${signal}] 已还原 ${pending.file}\n`);
      } catch (error) {
        process.stderr.write(`\n[${signal}] 还原失败 ${pending.file}：${error.message}\n`);
      }
    }
    process.exit(130);
  };
  process.on("SIGINT", () => restore("SIGINT"));
  process.on("SIGTERM", () => restore("SIGTERM"));

  // 裁决逻辑只有一份（`run()`），这里只注入「真跑一个捕获者」「逐条打一行」「把待还原交给信号钩子」。
  const { listProblems, results, problems } = run({
    files,
    samples: SAMPLES,
    runTest: realRunTest,
    onPending: (next) => {
      pending = next;
    },
    onPass: (r) => console.log(`  ✓ ${r.id} ${r.face}：变异 → 红（${r.hit.trim()}）→ 还原 → 绿`),
  });
  console.log("mutation-sample-check --run");
  if (listProblems.length) {
    for (const p of listProblems) console.log(`  ✗ ${p}`);
    console.log("mutation-sample-check --run: 清单本身就不一致，先修样本再真跑（拿锚点已死的清单去真跑 = 把变异打在错地方）");
    process.exitCode = 1;
    return;
  }
  if (problems.length) {
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log(`mutation-sample-check: 失败 — ${problems.length} 条样本没按预期咬住（${results.length} 条通过）`);
    process.exitCode = 1;
    return;
  }
  console.log(`mutation-sample-check: OK — ${results.length} 条样本逐条「变异 → 红在该报的断言上 → 还原 → 绿」`);
}

// ─────────────────────────────── --self-test ───────────────────────────────
// 内存夹具：一棵假树（一个目标文件 + 一个捕获者）+ 一份按真清单形状造的假样本数组。
// 每条用例靠**改清单字段 / 改假树**造坏，然后断言 `validateSamples` / `run` 的裁决；
// 变异打不上（靶 id / 靶串不在夹具里）按 #210 R2 判**失败**，不许静默变绿。
// #906：删掉 verify/sync 的派生列夹具（行号 / sha / 合计行）后，反向证的用例数下穿，地板随之重登。
const MIN_SELF_TEST_CASES = 16;

const FAKE_TARGET = "src/zz-selftest-target.js";
const FAKE_CATCHER = "test/zz-selftest-catcher.test.js";

function fakeTree(n = MIN_SAMPLES) {
  const lines = [];
  for (let i = 1; i <= n; i += 1) lines.push(`const Z${i} = ${i};`);
  return new Map([
    [FAKE_TARGET, `${lines.join("\n")}\n`],
    [FAKE_CATCHER, "// 假捕获者：自测不真起进程\n"],
  ]);
}

function fakeSamples(n = MIN_SAMPLES) {
  return Array.from({ length: n }, (_, i) => ({
    id: `M${i + 1}`,
    face: `自测面 ${i + 1}`,
    file: FAKE_TARGET,
    anchor: `const Z${i + 1} = ${i + 1};`,
    mutation: `const Z${i + 1} = ${i + 1}0;`,
    catcher: FAKE_CATCHER,
    signature: `自测签名 ${i + 1}`,
  }));
}

/** 单条含 `||` 的样本（M6 那种）：验「锚点里的竖线在 JS 清单里逐字命中」，不需要任何转义回环。 */
function pipeFixture() {
  return {
    tree: new Map([
      [FAKE_TARGET, "if (a === 1 || b === 2) {\n"],
      [FAKE_CATCHER, "// fake\n"],
    ]),
    samples: [{
      id: "M1",
      face: "含竖线的锚点",
      file: FAKE_TARGET,
      anchor: "if (a === 1 || b === 2) {",
      mutation: "if (a === 1) {",
      catcher: FAKE_CATCHER,
      signature: "含竖线的签名",
    }],
  };
}

/** 改一条样本的某个字段（靶 id / 靶字段找不到 = 变异没落上）。 */
function mutateSample(samples, mutate) {
  const next = samples.map((s) => ({ ...s }));
  const target = next.find((s) => s.id === mutate.id);
  if (!target) return { samples: next, missed: `清单里没有 ${mutate.id} 这一条` };
  if (!(mutate.field in target)) return { samples: next, missed: `清单条目 ${mutate.id} 没有字段 ${mutate.field}` };
  target[mutate.field] = mutate.to;
  return { samples: next, missed: null };
}

/** 删一条样本（按编号）。 */
function dropSample(samples, id) {
  const kept = samples.filter((s) => s.id !== id);
  return kept.length === samples.length ? { samples: kept, missed: `清单里没有 ${id} 这一条` } : { samples: kept, missed: null };
}

/** 复制一条现有样本、换一个连续的新编号：同目标文件、同锚点 ⇒ 只差编号与措辞（造重复）。 */
function duplicateSample(samples, { fromId, newId }) {
  const next = samples.map((s) => ({ ...s }));
  const src = next.find((s) => s.id === fromId);
  if (!src) return { samples: next, missed: `清单里没有 ${fromId} 这一条` };
  next.push({ ...src, id: newId });
  return { samples: next, missed: null };
}

/** 把变异落到假树上（改文件内容 / 删文件）。 */
function mutateTree(tree, mutate) {
  const next = new Map(tree);
  if (mutate.drop) {
    if (!next.has(mutate.drop)) return { tree: next, missed: `假树里没有 ${mutate.drop}` };
    next.delete(mutate.drop);
    return { tree: next, missed: null };
  }
  const before = next.get(mutate.file);
  if (typeof before !== "string") return { tree: next, missed: `假树里没有 ${mutate.file}` };
  const after = before.replace(mutate.from, () => mutate.to);
  if (after === before) return { tree: next, missed: `${mutate.file} 里找不到靶串 ${JSON.stringify(mutate.from)}` };
  next.set(mutate.file, after);
  return { tree: next, missed: null };
}

/** 自测用的一段「红」输出：把八条假样本的签名全列上（每条样本只关心自己那一行）。 */
const ALL_SIGNATURE_RED = Array.from({ length: MIN_SAMPLES }, (_, i) => `not ok ${i + 1} - 自测签名 ${i + 1}`).join("\n") + "\n";

const SELF_TEST_CASES = [
  {
    label: "① 干净清单 + 干净树 ⇒ 0 处不一致（同时证明清单形状本身就是合法的）",
    expectClean: true,
  },
  {
    label: "④ 锚点已不在树里（真值改名）⇒ 红「样本死了」，不许静默通过",
    mutateTree: { file: FAKE_TARGET, from: "const Z5 = 5;", to: "const Z5 = 55;" },
    expect: [/^DEAD_SAMPLE M5（src\/zz-selftest-target\.js）：锚点已不在该文件里/u],
  },
  {
    label: "⑤ 锚点在树里出现两次 ⇒ 红「变异会打偏」（唯一性是判据，不是巧合）",
    mutateTree: { file: FAKE_TARGET, from: "const Z7 = 7;", to: "const Z7 = 7;\nconst Z7 = 7;" },
    expect: [/^M7（src\/zz-selftest-target\.js）：锚点在该文件里出现 2 次/u],
  },
  {
    label: "⑥ 目标文件不存在 ⇒ 红",
    mutateTree: { drop: FAKE_TARGET },
    expect: [/^M1（src\/zz-selftest-target\.js）：目标文件不存在/u],
  },
  {
    label: "⑦ 捕获者不存在 ⇒ 红（样本没有闸可咬）",
    mutateTree: { drop: FAKE_CATCHER },
    expect: [/^M1（src\/zz-selftest-target\.js）：捕获者 test\/zz-selftest-catcher\.test\.js 不存在/u],
  },
  {
    label: "⑧ 变异与锚点逐字相同（空变异）⇒ 红",
    mutateSample: { id: "M2", field: "mutation", to: "const Z2 = 2;" },
    expect: [/^M2（src\/zz-selftest-target\.js）：变异与锚点逐字相同/u],
  },
  {
    label: "⑨ 期望红签名被削弱（空串）⇒ 红",
    mutateSample: { id: "M4", field: "signature", to: "" },
    expect: [/^M4（src\/zz-selftest-target\.js）：期望红签名太短/u],
  },
  {
    label: "⑩ 删掉最后一条样本（8 → 7）⇒ 红在样本数下限（删样本让闸变绿不算修好）",
    dropSample: "M8",
    expect: [/样本数被削：现在 7 条，下限 8 条/u],
  },
  {
    label: "⑪ id 不连续（改了中间一条却没重排）⇒ 红",
    mutateSample: { id: "M5", field: "id", to: "M55" },
    expect: [/^M55（src\/zz-selftest-target\.js）：id 不连续，第 5 条应为 M5/u],
  },
  {
    label: "⑭ applyMutation：锚点不在 ⇒ missed（变异没落地，不许当成「没变化=成功」；#210 R2）",
    expectMutationMissed: true,
  },
  {
    label: "⑮ applyMutation：锚点在 ⇒ 恰好替换一处，其余字节不动",
    expectMutationApplied: true,
  },
  {
    label: "⑯ run：变异后捕获者仍绿 ⇒ 红「变异没被抓住」",
    runScript: { red: { status: 0, output: "ok 1 - 自测签名 1\n" }, green: { status: 0, output: "ok 1 - 自测签名 1\n" } },
    expect: [/^M1：变异没被抓住/u],
  },
  {
    label: "⑰ run：红了但红在别的断言上 ⇒ 红「不是该报的那条」（非 0 退出不等于咬住；不许退化成「有红就行」）",
    runScript: {
      red: { status: 1, output: "not ok 1 - 别的断言\n" },
      green: { status: 0, output: "" },
    },
    expect: [/^M1：红了，但不是该报的那条/u],
  },
  {
    label: "⑱ run：还原后仍红 ⇒ 红「不能归因给变异」（基线本来就不干净）",
    runScript: {
      red: { status: 1, output: ALL_SIGNATURE_RED },
      green: { status: 1, output: ALL_SIGNATURE_RED },
    },
    expect: [/^M1：还原后仍红/u],
  },
  {
    label: "⑲ run 先验清单：真值已被改掉（锚点不在）⇒ 红「样本死了」，不许当「变异没落地也就没红」糊过去",
    runTree: { file: FAKE_TARGET, from: "const Z1 = 1;", to: "const Z1 = 100;" },
    runScript: { red: { status: 0, output: "" }, green: { status: 0, output: "" } },
    expect: [/^DEAD_SAMPLE M1（src\/zz-selftest-target\.js）：锚点已不在该文件里/u],
  },
  {
    label: "⑳ run 整条链对（变异 → 红在该报的断言上 → 还原 → 绿）⇒ 0 处问题、8 条全过",
    runScript: {
      red: { status: 1, output: ALL_SIGNATURE_RED },
      green: { status: 0, output: "" },
    },
    expectRunClean: true,
  },
  {
    label: "㉑ 锚点里含 `||`（M6 那种）⇒ 在 JS 清单里逐字命中、验清单绿（清单不转义也不拆列，锚点就是真竖线）",
    pipeSample: true,
    minSamples: 1,
    expectClean: true,
  },
  {
    label: "㉒ 重复样本（同一目标文件 + 同一锚点，只差编号）⇒ 红并点名两条编号（#646 ④ / #906 语义口径）",
    duplicateSample: { fromId: "M1", newId: "M9" },
    expect: [/^M1 与 M9：重复样本——同一目标文件 src\/zz-selftest-target\.js \+ 同一锚点/u],
  },
  {
    label: "㉓ 删掉重复样本 ⇒ 绿（反向证的还原半边：重复是红的原因，不是清单的底色）",
    duplicateSample: { fromId: "M3", newId: "M9" },
    dropSample: "M9",
    expectClean: true,
  },
];

function runSelfTest() {
  const failures = [];
  const passed = [];

  // 期望自己也要被看守（与 docs-drift-check / test-hygiene-check 同一课）：能匹配空串的期望等于没有断言；
  // 既不是放行证、也没写任何期望的一例 = 整例被跳过；用例数低于下限 = 有用例被删。
  if (SELF_TEST_CASES.length < MIN_SELF_TEST_CASES) {
    failures.push(`用例数被削：现在 ${SELF_TEST_CASES.length} 例，下限 ${MIN_SELF_TEST_CASES} 例——删用例 / 整例跳过不算修好`);
  }
  for (const [i, c] of SELF_TEST_CASES.entries()) {
    const who = c.label ?? `第 ${i + 1} 例`;
    for (const re of c.expect ?? []) {
      if (re.test("")) failures.push(`${who}：期望被削弱——正则 ${re} 连空串都匹配，等于没有断言`);
    }
    const hasExpectation = c.expectClean
      || c.expectMutationMissed
      || c.expectMutationApplied
      || c.expectRunClean
      || (c.expect ?? []).length > 0;
    if (!hasExpectation) failures.push(`${who}：期望被削弱——既不是放行证也没写 expect，等于整例被跳过`);
  }

  for (const c of SELF_TEST_CASES) {
    const who = c.label;
    let tree;
    let samples;
    if (c.pipeSample) {
      ({ tree, samples } = pipeFixture());
    } else {
      tree = fakeTree();
      samples = fakeSamples();
    }

    if (c.mutateSample) {
      const m = mutateSample(samples, c.mutateSample);
      if (m.missed) {
        failures.push(`${who}：变异没落上——${m.missed}（反向证自身失效：靶已与清单脱节）`);
        continue;
      }
      samples = m.samples;
    }
    if (c.duplicateSample) {
      // 复制一条现有样本、换一个连续的新编号：同目标文件、同锚点 ⇒ 只差编号与措辞。
      // 必须跑在 `dropSample` 之前：㉓「删掉重复 ⇒ 绿」先造出重复，再按编号删掉它。
      const m = duplicateSample(samples, c.duplicateSample);
      if (m.missed) {
        failures.push(`${who}：变异没落上——${m.missed}（反向证自身失效）`);
        continue;
      }
      samples = m.samples;
    }
    if (c.dropSample) {
      const d = dropSample(samples, c.dropSample);
      if (d.missed) {
        failures.push(`${who}：变异没落上——${d.missed}`);
        continue;
      }
      samples = d.samples;
    }
    if (c.mutateTree) {
      const m = mutateTree(tree, c.mutateTree);
      if (m.missed) {
        failures.push(`${who}：变异没落上——${m.missed}（反向证自身失效：靶串已与假树脱节）`);
        continue;
      }
      tree = m.tree;
    }

    const files = memoryFiles(tree);
    const problems = validateSamples({ files, samples, minSamples: c.minSamples ?? MIN_SAMPLES });

    if (c.expectClean) {
      if (problems.length) failures.push(`${who}：本该 0 处不一致，实测 ${problems.length} 处：\n      ${problems.join("\n      ")}`);
      else passed.push(`${who} → 0 处不一致`);
      continue;
    }

    if (c.expectMutationMissed) {
      const applied = applyMutation("a\nb\nc\n", "不存在的一行", "x");
      if (!applied.missed) failures.push(`${who}：锚点不在却报「没落上」为 null——变异没落地会被当成成功`);
      else if (applied.text !== "a\nb\nc\n") failures.push(`${who}：锚点不在却改了文本`);
      else passed.push(`${who} → missed=${JSON.stringify(applied.missed)}`);
      continue;
    }

    if (c.expectMutationApplied) {
      const applied = applyMutation("a\nb\nc\n", "b", "B");
      if (applied.missed) failures.push(`${who}：锚点在却报没落上——${applied.missed}`);
      else if (applied.text !== "a\nB\nc\n") failures.push(`${who}：替换结果不对：${JSON.stringify(applied.text)}`);
      else passed.push(`${who} → 恰好替换一处`);
      continue;
    }

    if (c.runScript) {
      let runSamples = samples;
      if (c.runSample) {
        const m = mutateSample(runSamples, c.runSample);
        if (m.missed) {
          failures.push(`${who}：变异没落上——${m.missed}`);
          continue;
        }
        runSamples = m.samples;
      }
      let runTree = tree;
      if (c.runTree) {
        const m = mutateTree(runTree, c.runTree);
        if (m.missed) {
          failures.push(`${who}：变异没落上——${m.missed}`);
          continue;
        }
        runTree = m.tree;
      }
      const runFiles = memoryFiles(runTree);
      let calls = 0;
      // 奇数发（变异后的那一次）按 runScript.red，偶数发（还原后的那一次）按 runScript.green ——
      // 每条样本两发，八条共十六发。
      const runTest = () => {
        calls += 1;
        return calls % 2 === 1 ? c.runScript.red : c.runScript.green;
      };
      const outcome = run({ files: runFiles, samples: runSamples, runTest });
      const all = [...outcome.listProblems, ...outcome.problems];
      if (c.expectRunClean) {
        if (all.length) failures.push(`${who}：本该 0 处问题，实测：\n      ${all.join("\n      ")}`);
        else if (outcome.results.length !== MIN_SAMPLES) failures.push(`${who}：本该 ${MIN_SAMPLES} 条全部通过，实测 ${outcome.results.length} 条`);
        else passed.push(`${who} → ${outcome.results.length} 条全部按预期咬住`);
        continue;
      }
      const missed = (c.expect ?? []).filter((re) => !all.some((p) => re.test(p)));
      if (!all.length) {
        failures.push(`${who}：改了但没红（裁决逻辑被改坏 / 这一格已失守）`);
        continue;
      }
      if (missed.length) {
        failures.push(`${who}：红了，但报的不是该报的形状（未命中 ${missed.map(String).join(" ; ")}）\n      实测：${all.join("\n      ")}`);
        continue;
      }
      passed.push(`${who} → ${all.length} 处红（已点名）`);
      continue;
    }

    const missed = (c.expect ?? []).filter((re) => !problems.some((p) => re.test(p)));
    if (!problems.length) {
      failures.push(`${who}：改了但没红（判据被改坏 / 这一格已失守）`);
      continue;
    }
    if (missed.length) {
      failures.push(`${who}：红了，但报的不是该报的形状（未命中 ${missed.map(String).join(" ; ")}）\n      实测：${problems.join("\n      ")}`);
      continue;
    }
    passed.push(`${who} → ${problems.length} 处红（已点名）`);
  }

  // issue #774：reporter 钉自己的反向证。真树 ⇒ 绿；把 `tap` 改成 `spec` ⇒ 必须红（#210 R2：变异没落上一律算失败）。
  const ownSource = fs.readFileSync(new URL(import.meta.url), "utf8");
  const pinProblems = checkReporterPin(ownSource);
  if (pinProblems.length) failures.push(`R1（reporter 钉）：${pinProblems.join("；")}`);
  else passed.push("R1（reporter 钉）→ spawn 捕获者钉着 --test-reporter=tap（Node 24 的默认是 spec）");
  const pinMutated = ownSource.replace('"--test-reporter=tap"', '"--test-reporter=spec"');
  if (pinMutated === ownSource) {
    failures.push("R1b（reporter 钉的反向证）：变异没落上——源码里找不到 \"--test-reporter=tap\" 那个字面量");
  } else if (checkReporterPin(pinMutated).length === 0) {
    failures.push("R1b（reporter 钉的反向证）：把 tap 换成 spec 之后判据没红——这一格是常绿的");
  } else {
    passed.push("R1b（reporter 钉的反向证）→ 把 tap 换成 spec 当场红并点名 argv");
  }

  console.log("mutation-sample-check --self-test：内存夹具上的反向证（改坏 → 红、干净 → 绿、重复样本红并点名两条编号、变异没落上也算失败）");
  for (const p of passed) console.log(`  ✓ ${p}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (failures.length) {
    console.log(`mutation-sample-check --self-test: 失败 — ${failures.length} 处未达预期（共 ${SELF_TEST_CASES.length} 例）`);
    process.exit(1);
  }
  console.log(`mutation-sample-check --self-test: OK — ${SELF_TEST_CASES.length} 例反向证/放行证全部按预期（内存夹具，不落盘、不碰真树）`);
}

// ─────────────────────────────── 入口 ───────────────────────────────

const mode = process.argv.slice(2)[0] ?? "";

if (mode === "--self-test") {
  runSelfTest();
} else if (mode === "--run") {
  mainRun();
} else {
  die(USAGE);
}
