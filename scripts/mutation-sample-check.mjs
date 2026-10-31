#!/usr/bin/env node
/**
 * 常驻变异样本表的核对器 / 刷表器 / 真跑器（issue #257 T7）。
 *
 * 病根：#257 那张「测试边界真实性」大单的 T1–T6、T8 都已落地，只剩 T7——各刀**手工做过**的变异
 * （`messages` 数组身份、`retryable` 映射、4xx `code` 分类、`state-view` 活引用、`sessionScanPrefix`
 * 哈希式）验完就散了：证据只活在当时的会话里，下一次重构没有任何东西会因此变红。本脚本把那些变异
 * 固化成 `test/mutation-samples.md` 里的一张表，并给出三种模式：
 *
 *   · `--verify <表>`：**验表**。逐条把表里的「真值锚点」拿回真树重算（行号 / 锚点 sha256 / 命中数），
 *     不一致 ⇒ exit 1 并点名。**不改任何文件**。CI 的阻塞门禁 `npm run check:mutation` 跑的就是它。
 *   · `--sync <表>`：**刷表**。第 4/5/6 列（行 / 锚点 sha256 / 命中）与合计行由真树重算重写 ——
 *     这是**唯一合法**的改表方式；手改这三个数字 = 伪造，`--verify` 会当场红。
 *   · `--run <表>`：**真跑**。逐条把变异写进真文件、跑该条的捕获者、要求它**红且红在该报的那条断言上**，
 *     再还原、再跑一遍要求**绿**。这一条是「闸咬得住」的**唯一**机器证据：`--verify` 只证明表与树
 *     对得上，证明不了「改了真值真会红」。`npm run check:mutation:run` 跑的就是它。
 *   · `--self-test`：上面三种模式的**反向证**，全部跑在**内存夹具**上（不落盘、不碰真树）：
 *     改坏一处必须红、不改必须绿、`--sync` 能且只能改派生列、变异没落上也必须判红（#210 R2 惯例）。
 *
 * 为什么要有 `--sync` / `--verify` 双模（照 `scripts/flat-count-inventory.mjs` 的先例）：一张「手写数字」
 * 的表在第一次真值漂移之后就没人敢信了 —— 分不清「表漂了」还是「数算错了」。派生列交给机器重算，
 * 人只写**样本定义**（哪一行、改成什么、谁该红），这样表既能长期维护，又不会退化成注释。
 *
 * 判据为什么这样定（逐条都能被 `--self-test` 打红）：
 *   1. **锚点必须是整行、且在该文件里唯一。** 用「整行相等」而不是子串：行号才是可核对的东西，
 *      子串会随缩进 / 同行注释漂移；唯一性不成立时变异会打偏（改到第一个出现处，而捕获者验的是另一处），
 *      那种样本比没有样本更坏 —— 它会绿得理直气壮。
 *   2. **锚点 sha256 进表。** 手改锚点文本（把真值改宽 / 改窄）会让命中数照样是 1、行号照样对，
 *      只有摘要能抓住。摘要取前 12 位：够区分，又不至于让表难读。
 *   3. **期望红签名必须命中 `not ok` 行。** 只要求「非 0 退出」是不够的：语法错、模块找不到、基线本来
 *      就红，三种都会非 0。所以样本必须写清「该报的那条断言」，本脚本只在**失败行**（`not ok N - …`）
 *      里找它 —— 注意测试名在通过时也会以 `# Subtest:` / `ok N -` 出现，只认 `not ok` 才咬得住。
 *   4. **还原后必须绿。** 这一半是「红归因给变异」的前提：基线本身红的时候，变异后的红什么也不证明。
 *   5. **样本数有下限、id 必须连续。** 让闸变绿最省力的办法是删掉那条咬人的样本；下限挡住「删到 0」，
 *      连续 id 挡住「删中间一条、其余照旧」。
 *   6. **变异没落地 = 失败**（#210 R2）：锚点找不到时 `String.replace` 会**原样返回**，那时捕获者当然
 *      还是绿的 —— 若把它读成「变异被抓住」，整条判据就是恒真的。本脚本把它单独判成
 *      「变异没落地」，与「变异没被抓住」分开点名，因为两者的修法完全不同。
 *
 * 纪律：改动被样本锚定的 `src/` / `bin/` 真值 ⇒ `--verify` 红 ⇒ 跑 `--sync` 刷表（diff 里能看见
 * 行号与摘要变了），**不要手改**。新做过的变异值得常驻时，往表里加一行（id 重排、面写清），
 * 然后 `--sync` + `--run`。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 样本数下限（只许涨）：删一条样本让闸变绿，是这张表最容易的腐化方式。 */
const MIN_SAMPLES = 8;

/** 期望红签名的最短长度：比这更短的串（含空串）等于没有断言。 */
const MIN_SIGNATURE_LENGTH = 4;

/** 合计行的形状：`**合计 8 条样本 / 4 个目标文件 / 5 个捕获者**`（数字由 `--sync` 重算）。 */
const SUMMARY_RE = /\*\*合计 (\d+) 条样本 \/ (\d+) 个目标文件 \/ (\d+) 个捕获者\*\*/u;

/** 数据行的形状：`| M1 | …`。只认这个前缀，表头 / 分隔行 / 散文一律不碰。 */
const ROW_RE = /^\|\s*M\d+\s*\|/u;

const USAGE = [
  "用法：",
  "  node scripts/mutation-sample-check.mjs --verify <表>       # 验表（CI 阻塞；不改文件）",
  "  node scripts/mutation-sample-check.mjs --sync   <表>       # 刷表（唯一合法的改表方式）",
  "  node scripts/mutation-sample-check.mjs --run    <表>       # 真跑：逐条变异 → 红 → 还原 → 绿",
  "  node scripts/mutation-sample-check.mjs --self-test         # 三种模式的反向证（内存夹具）",
].join("\n");

// ─────────────────────────────── 表 ↔ 文本 ───────────────────────────────

/** 拆一行表格：`\|` 是单元格内的字面 `|`（锚点里的 `||` 全靠它），其余 `|` 是分隔符。 */
function splitCells(line) {
  const cells = [];
  let cur = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** 单元格 → 值：剥掉一层反引号（代码列都写成 `` `…` ``），不剥别的。 */
function cellValue(cell) {
  if (cell.startsWith("`") && cell.endsWith("`") && cell.length >= 2) return cell.slice(1, -1);
  return cell;
}

/** 值 → 单元格：`|` 转义 + 反引号包裹。派生列（数字 / 摘要）不需要反引号，由 `renderRow` 决定。 */
function codeCell(value) {
  return "`" + String(value).replace(/\|/g, "\\|") + "`";
}

function plainCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

/** 一行数据 → 行对象。列序固定：见 `test/mutation-samples.md` 的表头。 */
function parseRow(line) {
  const cells = splitCells(line);
  if (cells.length !== 10) {
    throw new Error(`表格列数不对（${cells.length} 列，应为 10 列）：${line}`);
  }
  return {
    id: cellValue(cells[0]),
    face: cellValue(cells[1]),
    file: cellValue(cells[2]),
    line: Number(cellValue(cells[3])),
    sha: cellValue(cells[4]),
    hits: Number(cellValue(cells[5])),
    anchor: cellValue(cells[6]),
    mutation: cellValue(cells[7]),
    catcher: cellValue(cells[8]),
    signature: cellValue(cells[9]),
  };
}

function renderRow(row) {
  return `| ${[
    plainCell(row.id),
    plainCell(row.face),
    codeCell(row.file),
    plainCell(row.line),
    codeCell(row.sha),
    plainCell(row.hits),
    codeCell(row.anchor),
    codeCell(row.mutation),
    codeCell(row.catcher),
    codeCell(row.signature),
  ].join(" | ")} |`;
}

function parseTable(text) {
  const rows = [];
  let summary = null;
  for (const line of text.split("\n")) {
    if (ROW_RE.test(line)) rows.push(parseRow(line));
    const m = line.match(SUMMARY_RE);
    if (m) summary = { count: Number(m[1]), files: Number(m[2]), catchers: Number(m[3]) };
  }
  return { rows, summary };
}

// ─────────────────────────────── 真值派生 ───────────────────────────────

function anchorSha(anchor) {
  return createHash("sha256").update(anchor, "utf8").digest("hex").slice(0, 12);
}

/** 锚点在文件里的**整行**命中位置（1 基行号）。整行相等，见文件头判据 1。 */
function lineHits(text, anchor) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (line === anchor) out.push(i + 1);
  });
  return out;
}

/** 由真树重算一条样本的三个派生列（`--sync` 写、`--verify` 对）。 */
function deriveRow(row, files) {
  const text = files.read(row.file);
  if (text === null) return { ...row, line: 0, hits: 0, sha: anchorSha(row.anchor) };
  const hits = lineHits(text, row.anchor);
  return { ...row, line: hits.length === 1 ? hits[0] : 0, hits: hits.length, sha: anchorSha(row.anchor) };
}

function summarize(rows) {
  return {
    count: rows.length,
    files: new Set(rows.map((r) => r.file)).size,
    catchers: new Set(rows.map((r) => r.catcher)).size,
  };
}

// ─────────────────────────────── --verify ───────────────────────────────

/**
 * 验表（纯函数：文件读取与表文本都可注入 —— `--self-test` 直接喂内存夹具）。
 * 返回问题清单，空数组 = 零处不一致。
 */
function verify({ files, tableText, minSamples = MIN_SAMPLES }) {
  let rows;
  let summary;
  try {
    ({ rows, summary } = parseTable(tableText));
  } catch (error) {
    // 表本身读不成（列数不对 / 数字列不是数字）：这是「真值读不到」，必须红而不是崩。
    return [`表读不成：${error.message}`];
  }
  const problems = [];

  if (rows.length < minSamples) {
    problems.push(`样本数被削：现在 ${rows.length} 条，下限 ${minSamples} 条——删样本 / 整条跳过不算修好`);
  }
  const seen = new Set();
  rows.forEach((row, index) => {
    const where = `${row.id}（${row.file}）`;
    if (seen.has(row.id)) problems.push(`${where}：id 重复`);
    seen.add(row.id);
    const expectedId = `M${index + 1}`;
    if (row.id !== expectedId) {
      problems.push(`${where}：id 不连续，第 ${index + 1} 条应为 ${expectedId}——`
        + "删掉中间一条却没重排，那条样本就会静默消失");
    }
    if (!row.face) problems.push(`${where}：面 列为空（这张表存在的理由就是让人知道这条钉的是哪个行为面）`);
    if (!row.anchor) problems.push(`${where}：锚点 列为空`);
    if (!row.mutation) problems.push(`${where}：变异 列为空`);
    if (row.anchor && row.anchor === row.mutation) {
      problems.push(`${where}：变异与锚点逐字相同——空变异不算样本（它永远不会红）`);
    }
    if (row.signature.length < MIN_SIGNATURE_LENGTH) {
      problems.push(`${where}：期望红签名太短（${JSON.stringify(row.signature)}）——`
        + `至少要 ${MIN_SIGNATURE_LENGTH} 个字符，否则「命中了」是巧合`);
    }
    if (files.read(row.catcher) === null) {
      problems.push(`${where}：捕获者 ${row.catcher} 不存在——样本没有闸可咬`);
    }
    const text = files.read(row.file);
    if (text === null) {
      problems.push(`${where}：目标文件不存在`);
      return;
    }
    const hits = lineHits(text, row.anchor);
    if (hits.length === 0) {
      problems.push(`${where}：锚点已不在该文件里（样本死了：真值改了就 --sync，表被手改过就改回来）`);
    } else if (hits.length > 1) {
      problems.push(`${where}：锚点在该文件里出现 ${hits.length} 次（变异会打偏，锚点必须唯一）`);
    } else if (hits[0] !== row.line) {
      problems.push(`${where}：行号 表 ${row.line} / 树 ${hits[0]}（表漂了 ⇒ 跑 --sync，不许手改）`);
    }
    if (row.hits !== hits.length) {
      problems.push(`${where}：命中数 表 ${row.hits} / 树 ${hits.length}`);
    }
    const sha = anchorSha(row.anchor);
    if (row.sha !== sha) {
      problems.push(`${where}：锚点 sha256 表 ${row.sha} / 实算 ${sha}（手改数字 = 伪造；跑 --sync）`);
    }
  });

  const derived = summarize(rows);
  if (!summary) {
    problems.push("合计行缺失或形状变了（应为 `**合计 N 条样本 / N 个目标文件 / N 个捕获者**`）——"
      + "没有合计行，删掉整张表也不会红");
  } else if (summary.count !== derived.count
    || summary.files !== derived.files
    || summary.catchers !== derived.catchers) {
    problems.push(`合计行 表 ${summary.count} 条 / ${summary.files} 个目标文件 / ${summary.catchers} 个捕获者`
      + `，实算 ${derived.count} 条 / ${derived.files} 个目标文件 / ${derived.catchers} 个捕获者（跑 --sync）`);
  }
  return problems;
}

// ─────────────────────────────── --sync ───────────────────────────────

/**
 * 刷表：只重写派生列（行 / 摘要 / 命中）与合计行的三个数字。
 * **手写列一个字都不碰**（面 / 锚点 / 变异 / 捕获者 / 签名）—— 那是样本定义，不是量出来的东西。
 * 返回新文本，不改文件（写盘由调用方做，内存夹具才测得了）。
 */
function sync({ files, tableText }) {
  const derived = summarize(parseTable(tableText).rows);
  const out = [];
  let touched = 0;
  for (const line of tableText.split("\n")) {
    if (ROW_RE.test(line)) {
      const next = renderRow(deriveRow(parseRow(line), files));
      if (next !== line) touched += 1;
      out.push(next);
      continue;
    }
    if (SUMMARY_RE.test(line)) {
      const next = `**合计 ${derived.count} 条样本 / ${derived.files} 个目标文件 / ${derived.catchers} 个捕获者**`;
      const replaced = line.replace(SUMMARY_RE, next);
      if (replaced !== line) touched += 1;
      out.push(replaced);
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n"), touched };
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
 * 又不必真起进程、真写盘）。
 */
function run({ files, tableText, runTest, minSamples = MIN_SAMPLES, onPass = () => {}, onPending = () => {} }) {
  const tableProblems = verify({ files, tableText, minSamples });
  if (tableProblems.length) {
    return { tableProblems, results: [], problems: [] };
  }
  const { rows } = parseTable(tableText);
  const results = [];
  const problems = [];
  for (const row of rows) {
    const original = files.read(row.file);
    if (original === null) {
      problems.push(`${row.id}：目标文件不存在（验表刚过就没了？）`);
      continue;
    }
    const applied = applyMutation(original, row.anchor, row.mutation);
    if (applied.missed) {
      problems.push(`${row.id}：变异没落地——${applied.missed}（#210 R2：打不上的变异不算通过）`);
      continue;
    }
    let red;
    // `onPending` 把「待还原的文件与内容」交给调用方（真跑时由它挂信号钩子），
    // 这样「裁决逻辑」只此一份：真跑与自测走同一条路径。
    onPending({ file: row.file, text: original });
    try {
      files.write(row.file, applied.text);
      red = runTest(row.catcher);
    } finally {
      files.write(row.file, original);
      onPending(null);
    }
    if (files.read(row.file) !== original) {
      problems.push(`${row.id}：还原失败——${row.file} 的内容与变异前不一致，先停手（后续样本的结果不可信）`);
      break;
    }
    const green = runTest(row.catcher);
    const hit = failingLineFor(red.output ?? "", row.signature);
    if (red.status === 0) {
      problems.push(`${row.id}：变异没被抓住——${row.catcher} 改完真值仍全绿（这条闸已经咬不住这个行为面）`);
      continue;
    }
    if (!hit) {
      problems.push(`${row.id}：红了，但不是该报的那条——输出里没有含 ${JSON.stringify(row.signature)} 的 "not ok" 行`);
      continue;
    }
    if (green.status !== 0) {
      problems.push(`${row.id}：还原后仍红——基线本来就不干净，这条样本的红不能归因给变异`);
      continue;
    }
    results.push({ id: row.id, face: row.face, catcher: row.catcher, hit });
    onPass(results[results.length - 1]);
  }
  return { tableProblems: [], results, problems };
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

/** 真跑一个捕获者：`node --test <file>`，stdout + stderr 一起交回（TAP 与崩溃信息分处两边）。 */
function realRunTest(catcher) {
  const r = spawnSync(process.execPath, ["--test", catcher], { cwd: ROOT, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ─────────────────────────────── 命令行 ───────────────────────────────

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function readTableOrDie(tablePath) {
  try {
    return fs.readFileSync(path.join(ROOT, tablePath), "utf8");
  } catch (error) {
    die(`读不到表 ${tablePath}：${error.message}\n${USAGE}`);
    return "";
  }
}

function mainVerify(tablePath) {
  const tableText = readTableOrDie(tablePath);
  const problems = verify({ files: realFiles(ROOT), tableText });
  const { rows } = parseTable(tableText);
  const derived = summarize(rows);
  console.log(`mutation-sample-check --verify：${tablePath}`);
  console.log(`  ${derived.count} 条样本 / ${derived.files} 个目标文件 / ${derived.catchers} 个捕获者`);
  if (problems.length) {
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log(`mutation-sample-check: 失败 — ${problems.length} 处不一致（派生列由真树重算；刷表跑 --sync）`);
    process.exitCode = 1;
    return;
  }
  console.log("逐条：0 处不一致（行号 / 锚点 sha256 / 命中数 / 捕获者 / 合计行）");
  console.log("复跑：node scripts/mutation-sample-check.mjs --verify " + tablePath);
}

function mainSync(tablePath) {
  const tableText = readTableOrDie(tablePath);
  const files = realFiles(ROOT);
  const { text, touched } = sync({ files, tableText });
  if (text !== tableText) fs.writeFileSync(path.join(ROOT, tablePath), text);
  console.log(`mutation-sample-check --sync：${tablePath}`);
  console.log(`  改动 ${touched} 行（派生列由真树重算；手写列一个字都没碰）`);
  const problems = verify({ files, tableText: text });
  if (problems.length) {
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log("mutation-sample-check: 刷完仍有不一致 —— 上面这些不是派生列能修的（锚点死了 / 捕获者没了 / 变异与锚点相同）");
    process.exitCode = 1;
    return;
  }
  console.log("刷完复验：0 处不一致");
}

function mainRun(tablePath) {
  const tableText = readTableOrDie(tablePath);
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
  const { tableProblems, results, problems } = run({
    files,
    tableText,
    runTest: realRunTest,
    onPending: (next) => {
      pending = next;
    },
    onPass: (r) => console.log(`  ✓ ${r.id} ${r.face}：变异 → 红（${r.hit.trim()}）→ 还原 → 绿`),
  });
  console.log(`mutation-sample-check --run：${tablePath}`);
  if (tableProblems.length) {
    for (const p of tableProblems) console.log(`  ✗ ${p}`);
    console.log("mutation-sample-check --run: 表本身就不一致，先 --sync / 修表再真跑（拿漂了的表去真跑 = 把变异打在错误的行上）");
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
// 内存夹具：一棵假树（一个目标文件 + 一个捕获者）+ 一张按真渲染器生成的假表。
// 每条用例靠**字符串变异**改假表 / 改假树，然后断言 `verify` / `sync` / `run` 的裁决；
// 变异打不上（靶串不在夹具里）按 #210 R2 判**失败**，不许静默变绿。
const MIN_SELF_TEST_CASES = 23;

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

function fakeRows(n = MIN_SAMPLES) {
  return Array.from({ length: n }, (_, i) => {
    const anchor = `const Z${i + 1} = ${i + 1};`;
    return {
      id: `M${i + 1}`,
      face: `自测面 ${i + 1}`,
      file: FAKE_TARGET,
      line: i + 1,
      sha: anchorSha(anchor),
      hits: 1,
      anchor,
      mutation: `const Z${i + 1} = ${i + 1}0;`,
      catcher: FAKE_CATCHER,
      signature: `自测签名 ${i + 1}`,
    };
  });
}

function fakeTable(rows = fakeRows()) {
  const derived = summarize(rows);
  return [
    "# 假表（自测夹具）",
    "",
    "| # | 面 | 目标文件 | 行 | 锚点 sha256[:12] | 命中 | 锚点（单行真值） | 变异（改成） | 捕获者 | 期望红签名 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(renderRow),
    "",
    `**合计 ${derived.count} 条样本 / ${derived.files} 个目标文件 / ${derived.catchers} 个捕获者**`,
    "",
  ].join("\n");
}

/** 把变异落到假表文本上；返回 `{ text, missed }`，`missed` 非 null = 变异没落上。 */
function mutateTable(text, mutate) {
  const next = text.replace(mutate.from, () => mutate.to);
  if (next === text) return { text, missed: `假表里找不到靶串 ${JSON.stringify(mutate.from)}` };
  return { text: next, missed: null };
}

/** 把变异落到假树上（改文件内容 / 删文件 / 加一个文件）。 */
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
    label: "① 干净表 + 干净树 ⇒ 0 处不一致（同时证明 parse ↔ render 回环：假表就是用 renderRow 生成的）",
    expectClean: true,
  },
  {
    label: "② 手改行号 ⇒ 红并点名该条（派生列只能由 --sync 改）",
    mutateTable: { from: "| M3 | 自测面 3 | `src/zz-selftest-target.js` | 3 |", to: "| M3 | 自测面 3 | `src/zz-selftest-target.js` | 9 |" },
    expect: [/^M3（src\/zz-selftest-target\.js）：行号 表 9 \/ 树 3/u],
  },
  {
    label: "③ 手改锚点 sha256 ⇒ 红并点名该条（锚点文本被改宽/改窄时行号与命中数照样对，只有摘要抓得住）",
    mutateTable: { from: `\`${anchorSha("const Z3 = 3;")}\``, to: "`000000000000`" },
    expect: [/：锚点 sha256 表 000000000000 \/ 实算 [0-9a-f]{12}/u],
  },
  {
    label: "④ 锚点已不在树里（真值改名）⇒ 红「样本死了」，不许静默通过",
    mutateTree: { file: FAKE_TARGET, from: "const Z5 = 5;", to: "const Z5 = 55;" },
    expect: [/^M5（src\/zz-selftest-target\.js）：锚点已不在该文件里/u],
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
    mutateTable: {
      from: "| `const Z2 = 2;` | `const Z2 = 20;` |",
      to: "| `const Z2 = 2;` | `const Z2 = 2;` |",
    },
    expect: [/^M2（src\/zz-selftest-target\.js）：变异与锚点逐字相同/u],
  },
  {
    label: "⑨ 期望红签名被削弱（空串）⇒ 红",
    mutateTable: { from: "| `自测签名 4` |", to: "| `` |" },
    expect: [/^M4（src\/zz-selftest-target\.js）：期望红签名太短/u],
  },
  {
    label: "⑩ 删掉最后一条样本（8 → 7）⇒ 两处红：样本数下限 + 合计行（删行也会把合计弄漂）",
    dropRow: "M8",
    expect: [/样本数被削：现在 7 条，下限 8 条/u, /合计行 表 8 条/u],
  },
  {
    label: "⑩b 删一条样本再 --sync 把合计刷对 ⇒ 仍然红在样本数下限（刷表修不了「少了一条」）",
    dropRow: "M8",
    syncFirst: true,
    expect: [/样本数被削：现在 7 条，下限 8 条/u],
  },
  {
    label: "⑪ id 不连续（删了中间一条却没重排）⇒ 红",
    mutateTable: { from: "| M5 | 自测面 5 |", to: "| M55 | 自测面 5 |" },
    expect: [/^M55（src\/zz-selftest-target\.js）：id 不连续，第 5 条应为 M5/u],
  },
  {
    label: "⑫ 合计行被手改 ⇒ 红（没有合计行，删掉整张表也不会红）",
    mutateTable: { from: "**合计 8 条样本 / 1 个目标文件 / 1 个捕获者**", to: "**合计 9 条样本 / 1 个目标文件 / 1 个捕获者**" },
    expect: [/合计行 表 9 条 \/ 1 个目标文件 \/ 1 个捕获者，实算 8 条/u],
  },
  {
    label: "⑬ --sync 只改派生列：手改坏行号 ⇒ 先红，刷完复验必绿，且手写列（变异 / 签名）逐字未动",
    mutateTable: { from: "| M2 | 自测面 2 | `src/zz-selftest-target.js` | 2 |", to: "| M2 | 自测面 2 | `src/zz-selftest-target.js` | 7 |" },
    expectSyncRepairs: true,
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
    label: "⑰ run：红了但红在别的断言上 ⇒ 红「不是该报的那条」（非 0 退出不等于咬住）",
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
    label: "⑲ run 先验表：真值已被改掉（锚点不在）⇒ 红「样本死了」，不许当「变异没落地也就没红」糊过去",
    runTree: { file: FAKE_TARGET, from: "const Z1 = 1;", to: "const Z1 = 100;" },
    runScript: { red: { status: 0, output: "" }, green: { status: 0, output: "" } },
    expect: [/^M1（src\/zz-selftest-target\.js）：锚点已不在该文件里/u],
  },
  {
    label: "⑳ run：整条链对（变异 → 红在该报的断言上 → 还原 → 绿）⇒ 0 处问题、8 条全过",
    runScript: {
      red: { status: 1, output: ALL_SIGNATURE_RED },
      green: { status: 0, output: "" },
    },
    expectRunClean: true,
  },
  {
    label: "㉑ run 先验表：表漂了就不真跑（拿漂了的表去真跑 = 把变异打在错误的行上）",
    runTable: { from: "| M2 | 自测面 2 | `src/zz-selftest-target.js` | 2 |", to: "| M2 | 自测面 2 | `src/zz-selftest-target.js` | 7 |" },
    runScript: { red: { status: 1, output: ALL_SIGNATURE_RED }, green: { status: 0, output: "" } },
    expect: [/行号 表 7 \/ 树 2/u],
  },
  {
    // 表格单元格里写不出裸 `|`（会把整行拆成多列），所以锚点里的 `||` 存成 `\\|\\|`，解析时还原。
    // 这一例只放一条样本（`minSamples: 1`）：它考的是转义回环，不是样本数下限。
    label: "㉒ 锚点里含 `|`（M6 那种 `||`）⇒ 渲染/解析回环后仍是同一个 `||`，验表绿（不转义会把整行拆散）",
    pipeAnchor: true,
    minSamples: 1,
    expectClean: true,
  },
];

function dropRowFromTable(tableText, id) {
  const lines = tableText.split("\n");
  const kept = lines.filter((line) => !new RegExp(`^\\|\\s*${id}\\s*\\|`, "u").test(line));
  return kept.length === lines.length ? { text: tableText, missed: `假表里没有 ${id} 这一行` } : { text: kept.join("\n"), missed: null };
}

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
      || c.expectSyncRepairs
      || c.expectMutationMissed
      || c.expectMutationApplied
      || c.expectRunClean
      || (c.expect ?? []).length > 0;
    if (!hasExpectation) failures.push(`${who}：期望被削弱——既不是放行证也没写 expect，等于整例被跳过`);
  }

  for (const c of SELF_TEST_CASES) {
    const who = c.label;
    let tree = fakeTree();
    let tableText = fakeTable();

    if (c.mutateTable) {
      const m = mutateTable(tableText, c.mutateTable);
      if (m.missed) {
        failures.push(`${who}：变异没落上——${m.missed}（反向证自身失效：靶串已与假表脱节）`);
        continue;
      }
      tableText = m.text;
    }
    if (c.dropRow) {
      const d = dropRowFromTable(tableText, c.dropRow);
      if (d.missed) {
        failures.push(`${who}：变异没落上——${d.missed}`);
        continue;
      }
      tableText = d.text;
    }
    if (c.mutateTree) {
      const m = mutateTree(tree, c.mutateTree);
      if (m.missed) {
        failures.push(`${who}：变异没落上——${m.missed}`);
        continue;
      }
      tree = m.tree;
    }

    if (c.pipeAnchor) {
      tree = new Map([
        [FAKE_TARGET, "if (a === 1 || b === 2) {\n"],
        [FAKE_CATCHER, "// fake\n"],
      ]);
      tableText = [
        "| # | 面 | 目标文件 | 行 | 锚点 sha256[:12] | 命中 | 锚点（单行真值） | 变异（改成） | 捕获者 | 期望红签名 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        renderRow({
          id: "M1",
          face: "含竖线的锚点",
          file: FAKE_TARGET,
          line: 1,
          sha: anchorSha("if (a === 1 || b === 2) {"),
          hits: 1,
          anchor: "if (a === 1 || b === 2) {",
          mutation: "if (a === 1) {",
          catcher: FAKE_CATCHER,
          signature: "含竖线的签名",
        }),
        "",
        "**合计 1 条样本 / 1 个目标文件 / 1 个捕获者**",
        "",
      ].join("\n");
      if (!tableText.includes("\\|\\|")) {
        failures.push(`${who}：渲染器没有转义锚点里的 \`|\` —— 那一行在 markdown 里会被拆成多列`);
        continue;
      }
    }

    const files = memoryFiles(tree);
    if (c.syncFirst) tableText = sync({ files, tableText }).text;
    const problems = verify({ files, tableText, minSamples: c.minSamples ?? MIN_SAMPLES });

    if (c.expectClean) {
      if (problems.length) failures.push(`${who}：本该 0 处不一致，实测 ${problems.length} 处：\n      ${problems.join("\n      ")}`);
      else passed.push(`${who} → 0 处不一致`);
      continue;
    }

    if (c.expectSyncRepairs) {
      // 先确认「手改坏了 ⇒ 红」，再确认「--sync 刷完 ⇒ 绿」，最后确认手写列一个字没动。
      if (!problems.length) {
        failures.push(`${who}：漂了却没红——--sync 就没有存在必要了`);
        continue;
      }
      const before = parseTable(tableText).rows;
      const { text: synced } = sync({ files, tableText });
      const after = parseTable(synced).rows;
      const problemsAfter = verify({ files, tableText: synced });
      const handWritten = ["id", "face", "file", "anchor", "mutation", "catcher", "signature"];
      const handDiff = before
        .flatMap((row, i) => handWritten.filter((k) => row[k] !== after[i]?.[k]).map((k) => `${row.id}.${k}`));
      if (problemsAfter.length) {
        failures.push(`${who}：--sync 之后仍不一致：\n      ${problemsAfter.join("\n      ")}`);
      } else if (handDiff.length) {
        failures.push(`${who}：--sync 动了手写列（${handDiff.join(", ")}）——刷表只许重算派生列`);
      } else {
        passed.push(`${who} → 手改坏 ⇒ 红；--sync ⇒ 绿；手写列逐字未动（${handWritten.length} 列 × ${after.length} 行）`);
      }
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
      let runTableText = tableText;
      if (c.runTable) {
        const m = mutateTable(runTableText, c.runTable);
        if (m.missed) {
          failures.push(`${who}：变异没落上——${m.missed}`);
          continue;
        }
        runTableText = m.text;
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
      const outcome = run({ files: runFiles, tableText: runTableText, runTest });
      const all = [...outcome.tableProblems, ...outcome.problems];
      if (c.expectRunClean) {
        if (all.length) failures.push(`${who}：本该 0 处问题，实测：\n      ${all.join("\n      ")}`);
        else if (outcome.results.length !== 8) failures.push(`${who}：本该 8 条全部通过，实测 ${outcome.results.length} 条`);
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

  console.log("mutation-sample-check --self-test：内存夹具上的反向证（改坏 → 红、干净 → 绿、--sync 只改派生列、变异没落上也算失败）");
  for (const p of passed) console.log(`  ✓ ${p}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (failures.length) {
    console.log(`mutation-sample-check --self-test: 失败 — ${failures.length} 处未达预期（共 ${SELF_TEST_CASES.length} 例）`);
    process.exit(1);
  }
  console.log(`mutation-sample-check --self-test: OK — ${SELF_TEST_CASES.length} 例反向证/放行证全部按预期（内存夹具，不落盘、不碰真树）`);
}

// ─────────────────────────────── 入口 ───────────────────────────────

const argv = process.argv.slice(2);
const mode = argv[0] ?? "";
const tablePath = argv[1] ?? "";

if (mode === "--self-test") {
  runSelfTest();
} else if (mode === "--verify" || mode === "--sync" || mode === "--run") {
  if (!tablePath) die(`缺少表路径（${mode} 后面要跟表文件）\n${USAGE}`);
  if (mode === "--verify") mainVerify(tablePath);
  if (mode === "--sync") mainSync(tablePath);
  if (mode === "--run") mainRun(tablePath);
} else {
  die(USAGE);
}
