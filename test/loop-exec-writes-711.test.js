// @ts-check
// issue #711：exec 写的两面 —— **计数面** `execWriteCount` 与**盲区面** `fileWritesBlindToExec`（甲），
// 以及把 exec 的目标并进 `fileWrites` 台账（乙）。
//
// 现场（issue 正文实测）：26 个 run 里 6 个（23%）全程 0 次写工具 —— 模型在 shell 里用
// `cat > f <<'EOF'` 干活。台账只看写工具 ⇒ 那些 run 的 `fileWrites` 是**空集**，于是
// 裸 `--require-deliverable`（「台账里每条都还在盘上吗」）空洞为真，final guard 也拿不到产物。
//
// 本文件的格子按**口径**分组，不按实现顺序：
//   · P 组：解析器的口径（什么是写形态、什么解析得出来、什么必须放弃）。它是台账的唯一读入口，
//     所以这一组就是「台账会写成什么样」的直接证明；
//   · K 组：payload 两个加法键的**形状**（探不到就不写，绝不写 false）；
//   · L 组：跑起来的 run 里台账与两个键的**端到端**样子（判据 1–4）；
//   · R 组：resume 与非 resume 的**同口径**（判据 5）—— 同一个 run 从账本重建，台账必须逐字相等。
//
// 刻意的写法：
//   1. L 组的 `executeTool` 用**真 shell** 跑命令，「文件在盘上」是磁盘事实而不是测试自己写的；
//   2. 断言一律用 `deepEqual` 比整份台账 —— 「少了几条」正是这个 issue 的病灶，只查「有没有某条」
//      检不出它；
//   3. 全部格子走 `config.*` / `capabilities.*` 规位拼写，不碰已退役的扁平顶层键。
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { buildFinalGuardPayload } from "../src/loop/termination.js";
import {
  EXEC_TOOL_NAME,
  EXEC_WRITE_VIA,
  parseExecCommandWrites,
  scanExecWrites,
} from "../src/loop/exec-writes.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { makeTmp } from "./helpers/tmp.js";

const toolUse = (id, name, input) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});
const text = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });

/** 真跑一遍命令：让「文件真的落到磁盘」成为磁盘事实，而不是测试自己替模型写的。 */
const shellTool = (cwd) => async (call) => {
  execFileSync("/bin/sh", ["-c", call.input.command], { cwd, stdio: "ignore" });
  return "ok";
};

/** 只解析，不跑：P 组的表格用它（`cwd` 固定，路径可预测）。 */
const CWD = "/work/proj";

/**
 * 跑一个「只调 exec」的 run，把 guard 的 payload 与终局交回来。
 *
 * @param {string[]} commands 每轮一条 exec 命令（最后自动补一条收尾正文轮）
 * @param {{cwd?: string, resumeFrom?: {runId: string, rounds: any[]}}} [options]
 */
async function runExecOnly(commands, options = {}) {
  const dir = options.cwd ?? await makeTmp("erix-exec-writes-");
  /** @type {any} */
  let payload;
  const store = createMemoryTranscriptStore();
  const script = [...commands.map((command, index) => toolUse(`x${index + 1}`, EXEC_TOOL_NAME, { command })), text("done")];
  const result = await runToolLoop({
    provider: createFakeProvider(script),
    store,
    executeTool: shellTool(dir),
    config: {
      input: { initialUserMessage: "write the files", wrapup: false },
      run: {
        cwd: dir,
        maxRounds: commands.length + 2,
        completion: false,
        reflection: false,
        ...(options.resumeFrom ? { runId: options.resumeFrom.runId, resume: true } : {}),
      },
    },
    capabilities: {
      hooks: {
        finalGuard: async (value) => {
          payload = value;
          return { action: "accept" };
        },
      },
    },
  });
  return { dir, payload, result, store };
}

// ── P 组：解析器口径 ─────────────────────────────────────────────────────────────────
test("#711 P1 写形态四种都认：heredoc / 重定向 / tee / sed -i，目标解析成绝对路径", () => {
  assert.deepEqual(parseExecCommandWrites("cat > out.txt <<'EOF'\nbody with > inside\nEOF", { cwd: CWD }), {
    hasWriteForm: true,
    targets: [{ path: `${CWD}/out.txt`, via: EXEC_WRITE_VIA.heredoc }],
    unresolvedWriteCount: 0,
  });
  assert.deepEqual(parseExecCommandWrites("cat <<'EOF' > out.txt\nbody\nEOF", { cwd: CWD }), {
    hasWriteForm: true,
    targets: [{ path: `${CWD}/out.txt`, via: EXEC_WRITE_VIA.heredoc }],
    unresolvedWriteCount: 0,
  });
  assert.deepEqual(parseExecCommandWrites("echo x >> log.txt", { cwd: CWD }), {
    hasWriteForm: true,
    targets: [{ path: `${CWD}/log.txt`, via: EXEC_WRITE_VIA.redirect }],
    unresolvedWriteCount: 0,
  });
  assert.deepEqual(parseExecCommandWrites("printf x | tee -a report.md", { cwd: CWD }), {
    hasWriteForm: true,
    targets: [{ path: `${CWD}/report.md`, via: EXEC_WRITE_VIA.tee }],
    unresolvedWriteCount: 0,
  });
  assert.deepEqual(parseExecCommandWrites("sed -i 's/a/b/' notes.md", { cwd: CWD }), {
    hasWriteForm: true,
    targets: [{ path: `${CWD}/notes.md`, via: EXEC_WRITE_VIA.sedI }],
    unresolvedWriteCount: 0,
  });
});

test("#711 P2 只读命令与 /dev/* 都不进台账（判据 2）：rg / ls / > /dev/null / 2>/dev/null", () => {
  for (const command of ["rg foo", "ls -la", "cat a > /dev/null", "cmd 2>/dev/null", "cmd 2>&1", "grep -r \"a > b\" src"]) {
    const parsed = parseExecCommandWrites(command, { cwd: CWD });
    assert.deepEqual(parsed.targets, [], `只读/丢弃设备不该产生目标：${command}`);
  }
  // `/dev/stdout`、`/dev/stderr` 与整条 `/dev/` 前缀一起排除（issue 判据 2「一律排除」）。
  for (const command of ["cat a > /dev/stdout", "cat a > /dev/stderr", "cat a > /dev/something"]) {
    assert.deepEqual(parseExecCommandWrites(command, { cwd: CWD }).targets, [], command);
  }
});

test("#711 P3 设备丢弃连写形态都不算（阻断③）：/dev/* ⇒ hasWriteForm 假、不计数、不举旗", () => {
  // 写到设备是**看得见的丢弃**，不是盲区 ⇒ 既不进台账、也不计数、不举旗（与模块头部注释一致）。
  for (const command of ["cat a > /dev/null", "cmd 2>/dev/null", "cat a > /dev/stdout", "cat a > /dev/stderr"]) {
    const parsed = parseExecCommandWrites(command, { cwd: CWD });
    assert.equal(parsed.hasWriteForm, false, `写到设备不算写形态：${command}`);
    assert.equal(parsed.unresolvedWriteCount, 0, `写到设备不举盲区旗 ⇒ 未解析计数必为 0：${command}`);
    assert.deepEqual(parsed.targets, [], command);
  }
  // 只读的 exec 不计数 —— 它没有写形态。
  assert.equal(parseExecCommandWrites("rg foo", { cwd: CWD }).hasWriteForm, false);
  assert.equal(parseExecCommandWrites("ls -la", { cwd: CWD }).hasWriteForm, false);
  // /dev/* 整段都是只读 ⇒ scan 的计数面与未解析面都是 0（判据 4：三键都不出现的前提）。
  const scanned = scanExecWrites([
    { role: "assistant", content: [{ type: "tool_use", id: "1", name: "exec", input: { command: "cat a > /dev/null" } }] },
  ], { cwd: CWD });
  assert.deepEqual({ writeFormCount: scanned.writeFormCount, unresolvedWriteCount: scanned.unresolvedWriteCount },
    { writeFormCount: 0, unresolvedWriteCount: 0 });
  // 一条命令里几个写形态只算**一条**（口径是「命令条数」，不是「写了几次」）。
  assert.deepEqual(scanExecWrites([
    { role: "assistant", content: [{ type: "tool_use", id: "1", name: "exec", input: { command: "echo a > a.txt && echo b > b.txt" } }] },
  ], { cwd: CWD }).writeFormCount, 1);
});

test("#711 P4 解析不出目标就只计数：变量 / 命令替换 / 通配符 / 花括号（判据 4）", () => {
  const uncertain = [
    'echo hi > "$OUT"',
    "echo hi > $OUT",
    "cat > $(pick.sh)",
    "echo hi > *.txt",
    "echo hi > file{1,2}.txt",
    'sed -i \'s/a/b\' "$F"',
  ];
  for (const command of uncertain) {
    const parsed = parseExecCommandWrites(command, { cwd: CWD });
    assert.equal(parsed.hasWriteForm, true, `有写形态就必须计数：${command}`);
    assert.deepEqual(parsed.targets, [], `解析不出目标就不许猜：${command}`);
  }
});

test("#711 P7 结构读不懂时放弃：正文里的 > 不是重定向、引号里的 > 不是重定向", () => {
  // heredoc 正文整体跳过 —— 正文里的 `>` 是文本。
  assert.deepEqual(parseExecCommandWrites("cat <<'EOF' > out.txt\nfirst\nsecond > nope\nEOF", { cwd: CWD }).targets,
    [{ path: `${CWD}/out.txt`, via: EXEC_WRITE_VIA.heredoc }]);
  // 引号里的 `>` 与注释里的 `>` 都不是重定向。
  assert.equal(parseExecCommandWrites("echo 'a > b'", { cwd: CWD }).hasWriteForm, false);
  assert.equal(parseExecCommandWrites('grep "pattern>" src', { cwd: CWD }).hasWriteForm, false);
  assert.deepEqual(parseExecCommandWrites("cat a > b.txt # note: > inside comment", { cwd: CWD }).targets,
    [{ path: `${CWD}/b.txt`, via: EXEC_WRITE_VIA.redirect }]);
  // 多段命令：每段各自解析，三个目标都记到。
  assert.deepEqual(parseExecCommandWrites("cat f1 > f2 && sed -i 's/x/y/' f3 ; tee f4", { cwd: CWD }).targets, [
    { path: `${CWD}/f2`, via: EXEC_WRITE_VIA.redirect },
    { path: `${CWD}/f3`, via: EXEC_WRITE_VIA.sedI },
    { path: `${CWD}/f4`, via: EXEC_WRITE_VIA.tee },
  ]);
  // 未闭合引号：读不懂 ⇒ 不猜目标（计数仍保守地成立）。
  assert.deepEqual(parseExecCommandWrites("echo 'unclosed > ", { cwd: CWD }).targets, []);
  // heredoc 定界符本身是变量 ⇒ 正文边界找不到 ⇒ 放弃后续扫描；但**已经读出来的** `>` 目标是真的。
  const variableDelimiter = parseExecCommandWrites("cat > out.txt <<$D\nbody\nEOF", { cwd: CWD });
  assert.equal(variableDelimiter.hasWriteForm, true);
  assert.deepEqual(variableDelimiter.targets, [{ path: `${CWD}/out.txt`, via: EXEC_WRITE_VIA.heredoc }]);
});

test("#711 P5 相对路径按 run 的 cwd 绝对化；没有 cwd、或命令里有 cd ⇒ 不猜", () => {
  assert.deepEqual(parseExecCommandWrites("echo x > sub/dir/f.txt", { cwd: CWD }).targets,
    [{ path: `${CWD}/sub/dir/f.txt`, via: EXEC_WRITE_VIA.redirect }]);
  assert.deepEqual(parseExecCommandWrites("echo x > ../up/f.txt", { cwd: CWD }).targets,
    [{ path: "/work/up/f.txt", via: EXEC_WRITE_VIA.redirect }]);
  assert.deepEqual(parseExecCommandWrites("echo x > /abs/path/f.txt", { cwd: CWD }).targets,
    [{ path: "/abs/path/f.txt", via: EXEC_WRITE_VIA.redirect }]);
  // 没有 cwd ⇒ 相对路径无法绝对化 ⇒ 只计数。
  assert.deepEqual(parseExecCommandWrites("echo x > f.txt", {}).targets, []);
  assert.equal(parseExecCommandWrites("echo x > f.txt", {}).hasWriteForm, true);
  // 绝对路径不需要 cwd。
  assert.deepEqual(parseExecCommandWrites("echo x > /abs/f.txt", {}).targets,
    [{ path: "/abs/f.txt", via: EXEC_WRITE_VIA.redirect }]);
  // `cd` 出现过 ⇒ 相对基准不再是 run 的 cwd（现场命令就是 `cd /app && cat > design.py <<EOF`）。
  assert.deepEqual(parseExecCommandWrites("cd /app && cat > design.py <<'EOF'\nbody\nEOF", { cwd: CWD }).targets, []);
  assert.deepEqual(parseExecCommandWrites("(cd /app && cat > design.py)", { cwd: CWD }).targets, []);
});

test("#711 P6 tee / sed -i 的操作数：包装词、选项、脚本与 -- 都不算文件", () => {
  assert.deepEqual(parseExecCommandWrites("printf x | sudo tee /etc/hosts", { cwd: CWD }).targets,
    [{ path: "/etc/hosts", via: EXEC_WRITE_VIA.tee }]);
  assert.deepEqual(parseExecCommandWrites("printf x | tee -a a.txt b.txt", { cwd: CWD }).targets, [
    { path: `${CWD}/a.txt`, via: EXEC_WRITE_VIA.tee },
    { path: `${CWD}/b.txt`, via: EXEC_WRITE_VIA.tee },
  ]);
  // 重定向目标已经认领的词，不再当 tee 的操作数数第二遍。
  assert.deepEqual(parseExecCommandWrites("printf x | tee out.txt > /dev/null", { cwd: CWD }).targets,
    [{ path: `${CWD}/out.txt`, via: EXEC_WRITE_VIA.tee }]);
  // sed：无 `-e` 时第一个非选项参数是脚本，其余才是文件；有 `-e` 时全是文件。
  assert.deepEqual(parseExecCommandWrites("sed -i.bak -e 's/a/b/' one.md two.md", { cwd: CWD }).targets, [
    { path: `${CWD}/one.md`, via: EXEC_WRITE_VIA.sedI },
    { path: `${CWD}/two.md`, via: EXEC_WRITE_VIA.sedI },
  ]);
  assert.deepEqual(parseExecCommandWrites("sed -i 's/a/b/' -- notes.md", { cwd: CWD }).targets,
    [{ path: `${CWD}/notes.md`, via: EXEC_WRITE_VIA.sedI }]);
  // 短选项串里的 `i` 也是就地改（`sed -ni`）。
  assert.deepEqual(parseExecCommandWrites("sed -ni 's/a/b/' notes.md", { cwd: CWD }).targets,
    [{ path: `${CWD}/notes.md`, via: EXEC_WRITE_VIA.sedI }]);
  // 没有 `-i` 的 sed 只是读。
  assert.equal(parseExecCommandWrites("sed -n 's/a/b/p' notes.md", { cwd: CWD }).hasWriteForm, false);
  // 非空 command 的形状：缺 command / 非字符串 ⇒ 什么都不说。
  assert.deepEqual(parseExecCommandWrites(undefined, { cwd: CWD }), { hasWriteForm: false, targets: [], unresolvedWriteCount: 0 });
  assert.deepEqual(parseExecCommandWrites(42, { cwd: CWD }), { hasWriteForm: false, targets: [], unresolvedWriteCount: 0 });
});

// ── K 组：payload 两个加法键的形状 ───────────────────────────────────────────────────
function payloadFor(extra) {
  return buildFinalGuardPayload({
    finalText: "",
    declaredFindings: undefined,
    messages: [],
    rounds: 0,
    toolSignal: undefined,
    ...extra,
  }, "end_turn", undefined, 1);
}

test("#711 K1 execWriteUnresolvedCount>0 ⇒ 三键都在（计数 / 未解析 / 旗），旗是真", () => {
  const payload = payloadFor({
    execWriteCount: 3,
    execWriteUnresolvedCount: 3,
    fileWrites: [{ path: "a.txt", round: 1, tool: "writeFile" }],
    toolStats: new Map([[EXEC_TOOL_NAME, { calls: 3, failures: 0 }]]),
  });
  assert.equal(payload.execWriteCount, 3);
  assert.equal(payload.execWriteUnresolvedCount, 3);
  assert.equal(payload.fileWritesBlindToExec, true);
});

test("#711 K2 探不到就不写：计数缺席 / 为 0 时三个键都不出现（绝不写 false）", () => {
  for (const extra of [{}, { execWriteCount: 0 }, { execWriteCount: undefined }, { execWriteCount: "2" }, { execWriteCount: -1 },
    { execWriteUnresolvedCount: 0 }, { execWriteUnresolvedCount: "2" }, { execWriteUnresolvedCount: -1 }]) {
    const payload = payloadFor(extra);
    assert.equal("execWriteCount" in payload, false, `不该写 execWriteCount：${JSON.stringify(extra)}`);
    assert.equal("execWriteUnresolvedCount" in payload, false, `不该写 execWriteUnresolvedCount：${JSON.stringify(extra)}`);
    assert.equal("fileWritesBlindToExec" in payload, false, `不该写盲区旗：${JSON.stringify(extra)}`);
  }
});

test("#711 K3 台账里有可解析的 exec 条目（未解析计数为 0）⇒ 计数仍在，盲区旗必须闭", () => {
  const payload = payloadFor({
    execWriteCount: 1,
    execWriteUnresolvedCount: 0,
    fileWrites: [{ path: "/abs/out.txt", round: 1, tool: EXEC_TOOL_NAME, via: "heredoc" }],
    toolStats: new Map([[EXEC_TOOL_NAME, { calls: 1, failures: 0 }]]),
  });
  assert.equal(payload.execWriteCount, 1);
  assert.equal("execWriteUnresolvedCount" in payload, false, "未解析为 0 ⇒ 第三个键也不该出现");
  assert.equal("fileWritesBlindToExec" in payload, false, "未解析计数为 0 ⇒ 盲区已闭，不许继续举旗");
  // 粗旗 fileWritesBlind 也一并闭（台账不再空）—— 两面各判各的，互不覆盖。
  assert.equal("fileWritesBlind" in payload, false);
});

test("#711 K4 分工：粗旗 fileWritesBlind 与细旗 fileWritesBlindToExec 各自独立成立", () => {
  // 只跑过一条**只读** exec：粗旗举（台账空 + 跑过 exec），细旗不举（没有写形态）。
  const readOnly = payloadFor({
    execWriteCount: 0,
    execWriteUnresolvedCount: 0,
    fileWrites: [],
    toolStats: new Map([[EXEC_TOOL_NAME, { calls: 1, failures: 0 }]]),
  });
  assert.equal(readOnly.fileWritesBlind, true);
  assert.equal("fileWritesBlindToExec" in readOnly, false);
  // 台账被裁到只剩 writeFile 条目、但 exec 有未解析目标 ⇒ 细旗举，粗旗不举（台账非空）。
  const trimmed = payloadFor({
    execWriteCount: 2,
    execWriteUnresolvedCount: 2,
    fileWrites: [{ path: "written.txt", round: 1, tool: "writeFile" }],
    toolStats: new Map([[EXEC_TOOL_NAME, { calls: 9, failures: 0 }]]),
  });
  assert.equal(trimmed.fileWritesBlindToExec, true);
  assert.equal("fileWritesBlind" in trimmed, false);
});

// ── L 组：端到端 ─────────────────────────────────────────────────────────────────────
test("#711 判据 1（乙）：只跑一次 heredoc 的 run，台账里有 out.txt 的绝对路径与 exec 来源", async () => {
  const dir = await makeTmp("erix-exec-writes-j1-");
  const { payload } = await runExecOnly(["cat > out.txt <<'EOF'\nbody with > inside\nEOF"], { cwd: dir });
  assert.equal(existsSync(join(dir, "out.txt")), true, "heredoc 没真落到盘上（本格的判据是磁盘事实）");
  assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), "body with > inside\n");
  assert.deepEqual(payload.fileWrites, [
    { path: join(dir, "out.txt"), round: 1, tool: "exec", via: "heredoc" },
  ], `台账必须带上 exec 来源的绝对路径，实测 ${JSON.stringify(payload.fileWrites)}`);
  assert.ok(payload.execWriteCount >= 1, `execWriteCount 必须 >= 1，实测 ${payload.execWriteCount}`);
  // 盲区已被乙补上 ⇒ 旗子必须闭（还举着就是「假装全知」的反面：假装无知）。
  assert.equal("fileWritesBlindToExec" in payload, false);
  // filesWritten（提示用摘要）语义一字不动：exec 不是写工具，摘要里不该出现它。
  assert.deepEqual(payload.filesWritten, [], `filesWritten 不该被 exec 污染，实测 ${JSON.stringify(payload.filesWritten)}`);
});

test("#711 判据 1（甲面）：解析不出目标时 execWriteCount>=1 且 fileWritesBlindToExec===true", async () => {
  const dir = await makeTmp("erix-exec-writes-j1b-");
  const { payload } = await runExecOnly(['cat > "$OUT" <<\'EOF\'\nbody\nEOF'], { cwd: dir });
  assert.deepEqual(payload.fileWrites, [], "目标读不出来就不许猜进台账");
  assert.ok(payload.execWriteCount >= 1, `计数面必须把这条命令数进去，实测 ${payload.execWriteCount}`);
  assert.equal(payload.fileWritesBlindToExec, true, "有写形态而台账里没有 exec 条目 ⇒ 必须老实举旗");
});

test("#711 判据 2：只读 exec 不进台账；/dev/* 一律排除", async () => {
  const dir = await makeTmp("erix-exec-writes-j2-");
  writeFileSync(join(dir, "a"), "seed\n");
  const { payload } = await runExecOnly(["printf x > /dev/null"], { cwd: dir });
  assert.deepEqual(payload.fileWrites, [], `写到 /dev/* 不是写文件，实测 ${JSON.stringify(payload.fileWrites)}`);
  // 判据 4：写到设备是看得见的丢弃 ⇒ 三个键都不出现（既不计数、也不举旗）。
  assert.equal("execWriteCount" in payload, false, `写到设备不该举 execWriteCount：${JSON.stringify(payload)}`);
  assert.equal("execWriteUnresolvedCount" in payload, false, "写到设备不该举 execWriteUnresolvedCount");
  assert.equal("fileWritesBlindToExec" in payload, false, "写到设备不该举 fileWritesBlindToExec");
  // 「什么都没写」的 run：粗旗按 #386 的口径仍举（跑过 exec 且台账空），这是既有语义，不许动。
  assert.equal(payload.fileWritesBlind, true);
});

test("#711 判据 3：tee 与 sed -i 的目标计入台账", async () => {
  const dir = await makeTmp("erix-exec-writes-j3-");
  writeFileSync(join(dir, "notes.md"), "a line\n");
  const { payload } = await runExecOnly([
    "printf hello | tee out.txt",
    "sed -i 's/a/z/' notes.md",
  ], { cwd: dir });
  assert.deepEqual(payload.fileWrites, [
    { path: join(dir, "out.txt"), round: 1, tool: "exec", via: "tee" },
    { path: join(dir, "notes.md"), round: 2, tool: "exec", via: "sed-i" },
  ], `判据 3 要求两条都进台账，实测 ${JSON.stringify(payload.fileWrites)}`);
  assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), "hello");
  assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), "z line\n", "sed -i 是真在改文件");
  assert.equal("fileWritesBlindToExec" in payload, false);
});

test("#711 判据 4：不确定形态不进台账，但必须计入 execWriteCount", async () => {
  const dir = await makeTmp("erix-exec-writes-j4-");
  const { payload } = await runExecOnly([
    'echo hi > "$OUT"',
    "cat > $(echo picked.txt) <<'EOF'\nbody\nEOF",
    "echo x > *.txt",
  ], { cwd: dir });
  // 三条命令**都**在磁盘上真的写了东西（shell 会展开变量/命令替换/通配符），
  // 但目标值不在引擎眼前 ⇒ 台账一条都不记，计数面必须把它们都数到。
  assert.deepEqual(payload.fileWrites, [], `不确定的目标一条都不许猜，实测 ${JSON.stringify(payload.fileWrites)}`);
  assert.equal(payload.execWriteCount, 3, `三条命令都有写形态 ⇒ 计数面必须数到 3，实测 ${payload.execWriteCount}`);
  assert.equal(payload.execWriteUnresolvedCount, 3, `三条都不进台账 ⇒ 未解析计数也必为 3，实测 ${payload.execWriteUnresolvedCount}`);
  assert.equal(payload.fileWritesBlindToExec, true, "有未解析目标 ⇒ 必须老实举旗");
});

test("#711 台账共用同一个上限与去重：exec 条目与写工具条目同池裁剪，最新一条留下", async () => {
  const dir = await makeTmp("erix-exec-writes-dedup-");
  const { payload } = await runExecOnly([
    "cat > same.txt <<'EOF'\nfirst\nEOF",
    "printf second > same.txt",
  ], { cwd: dir });
  assert.deepEqual(payload.fileWrites, [
    { path: join(dir, "same.txt"), round: 2, tool: "exec", via: "redirect" },
  ], `同一个路径被写两次 ⇒ 只留最新一条（与 #388 的裁剪语义同一条通道），实测 ${JSON.stringify(payload.fileWrites)}`);
  assert.equal(payload.execWriteCount, 2, "裁剪台账不影响计数面");
});

// ── R 组：resume 同口径（判据 5）────────────────────────────────────────────────────
test("#711 判据 5：同一个 run 从账本重建，fileWrites 与非 resume 逐字相等", async () => {
  const dir = await makeTmp("erix-exec-writes-resume-");
  writeFileSync(join(dir, "notes.md"), "a line\n");
  const commands = [
    "cat > out.txt <<'EOF'\nbody\nEOF",
    "printf hello | tee out2.txt",
    "sed -i 's/a/z/' notes.md",
  ];

  // A：一路跑完（不 resume）。
  const plain = await runExecOnly(commands, { cwd: dir });

  // B：同样的轮记录先写进账本，再从账本重建（引擎在 resume 里走的是同一个 recordFileWrites）。
  const runId = "exec-writes-resume-parity";
  const store = createMemoryTranscriptStore();
  let round = 0;
  for (const command of commands) {
    round += 1;
    const id = `x${round}`;
    await store.appendRound(runId, {
      round,
      roundKey: `${runId}:round:${round}`,
      dedupKey: `${runId}:round:${round}`,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id, name: EXEC_TOOL_NAME, input: { command } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
      ],
    });
  }
  assert.equal(await store.loadRunState(runId), undefined, "账本里没有 run-state ⇒ 台账只能从轮记录重建");

  let resumedPayload;
  await runToolLoop({
    provider: createFakeProvider([text("restored")]),
    store,
    executeTool: async () => "unused",
    config: {
      input: { initialUserMessage: "write the files", wrapup: false },
      run: { cwd: dir, runId, resume: true, maxRounds: 1, completion: false, reflection: false },
    },
    capabilities: {
      hooks: {
        finalGuard: async (value) => {
          resumedPayload = value;
          return { action: "accept" };
        },
      },
    },
  });

  assert.ok(Array.isArray(resumedPayload.fileWrites), "resume 的 payload 必须带 fileWrites 键");
  assert.deepEqual(resumedPayload.fileWrites, plain.payload.fileWrites,
    `resume 重建的台账必须与非 resume 逐字相等（重建：${JSON.stringify(resumedPayload.fileWrites)} / 原生：${JSON.stringify(plain.payload.fileWrites)}）`);
  assert.equal(resumedPayload.execWriteCount, plain.payload.execWriteCount,
    "计数面也必须同口径（同一个 recordFileWrites 单点）");
  assert.equal(resumedPayload.execWriteUnresolvedCount, plain.payload.execWriteUnresolvedCount,
    "未解析计数也必须同口径（同一条通道，#388 的教训）");
  assert.deepEqual(resumedPayload.fileWrites.map((entry) => entry.tool), ["exec", "exec", "exec"]);
  assert.equal(existsSync(join(dir, "out.txt")), true);
});

// ── 阻断 ①②③④⑤⑥ 专项：「不猜」口径守全（不确定时如实说自己不确定）──────────────
const targetPaths = (command, cwd = CWD) => parseExecCommandWrites(command, { cwd }).targets.map((t) => t.path);

test("#711 阻断① 不透明包装（bash/sh/eval/xargs/sudo bash）：载荷里有写形态 ⇒ 只计数+记未解析，绝不提路径", () => {
  for (const command of [
    "bash -c 'echo x > out'",
    "sh -c 'echo x >> out'",
    "eval 'echo x > out'",
    "find . | xargs -I{} sh -c 'echo x > {}'",
    "sudo bash -c 'echo x > out'",
    "env bash -c 'echo x > out'",
  ]) {
    const parsed = parseExecCommandWrites(command, { cwd: CWD });
    assert.equal(parsed.hasWriteForm, true, `不透明包装里的写形态必须计数：${command}`);
    assert.ok(parsed.unresolvedWriteCount >= 1, `载荷读不出目标 ⇒ 必须计入未解析：${command}`);
    assert.ok(!parsed.targets.some((t) => t.path.endsWith("/out")), `绝不从不透明载荷里提路径：${command}`);
  }
});

test("#711 建议 D（判据 6）：不透明载荷按写形态个数计数（下界），不是恒为 1", () => {
  // 两处写 ⇒ 至少计 2（旧实现只给 1，低估了未解析面）。
  const two = parseExecCommandWrites("bash -c 'echo a > a; echo b > b'", { cwd: CWD });
  assert.ok(two.unresolvedWriteCount >= 2, `两处写 ⇒ 未解析计数应 >=2（实测 ${two.unresolvedWriteCount}）`);
  assert.deepEqual(two.targets, [], "载荷里的 a/b 是相对目标，绝不从不透明载荷里提路径");
  // 下界语义的另一面：病态多写载荷被上界 32 卡住（防撑爆），不会无限大。
  const many = parseExecCommandWrites(`bash -c '${"> ".repeat(40)}'`, { cwd: CWD });
  assert.equal(many.unresolvedWriteCount, 32, "病态 40 个 `>` ⇒ 被上界 32 卡住（是下界计数，不是精确目标数）");
});

test("#711 阻断① 判据2：只读的不透明包装不是写（bash -c 'rg foo' ⇒ 不计数）", () => {
  for (const command of ["bash -c 'rg foo'", "sh -c 'ls -la'", "eval 'cat f.txt'", "bash -c 'echo hello'"]) {
    const parsed = parseExecCommandWrites(command, { cwd: CWD });
    assert.equal(parsed.hasWriteForm, false, `只读包装不是写形态，不许计数：${command}`);
    assert.equal(parsed.unresolvedWriteCount, 0, command);
    assert.deepEqual(parsed.targets, [], command);
  }
});

test("#711 阻断① 端到端（判据1）：bash -c 里的写 ⇒ execWriteCount>=1 且举旗，台账里没有 out", async () => {
  const dir = await makeTmp("erix-exec-writes-oppaque-");
  const { payload } = await runExecOnly(["bash -c 'echo x > out'"], { cwd: dir });
  assert.ok(payload.execWriteCount >= 1, `execWriteCount 必须 >= 1，实测 ${payload.execWriteCount}`);
  assert.ok(payload.execWriteUnresolvedCount >= 1, `未解析计数必须 >= 1，实测 ${payload.execWriteUnresolvedCount}`);
  assert.equal(payload.fileWritesBlindToExec, true, "不透明包装的写 ⇒ 必须老实举旗");
  assert.deepEqual(payload.fileWrites, [], `台账里绝不出现从不透明载荷猜出的 out：${JSON.stringify(payload.fileWrites)}`);
});

test("#711 阻断②（判据3）：未闭合引号在重定向目标之后 ⇒ 不记 out.txt，但计数且举旗", () => {
  const parsed = parseExecCommandWrites("echo x > out.txt 'unterminated", { cwd: CWD });
  assert.ok(!parsed.targets.some((t) => t.path.endsWith("/out.txt")), "bash 根本不会执行 ⇒ 连之前的 out.txt 也不记");
  assert.equal(parsed.hasWriteForm, true, "有写形态 ⇒ 计数面成立");
  assert.ok(parsed.unresolvedWriteCount >= 1, "不可执行的命令 ⇒ 计入未解析");
  const payload = payloadFor({
    execWriteCount: 1,
    execWriteUnresolvedCount: 1,
    fileWrites: [],
    toolStats: new Map([[EXEC_TOOL_NAME, { calls: 1, failures: 0 }]]),
  });
  assert.equal(payload.execWriteUnresolvedCount, 1);
  assert.equal(payload.fileWritesBlindToExec, true);
});

test("#711 阻断②：变量定界符的 heredoc 不是不可执行 ⇒ 之前读出的 > 目标仍是真（保守早停，不连坐）", () => {
  // `cat > out.txt <<$D` ：`> out.txt` 在畸形 heredoc **之前**且完整，bash 会真写 out.txt ⇒ 该记。
  const parsed = parseExecCommandWrites("cat > out.txt <<$D\nbody\nEOF", { cwd: CWD });
  assert.ok(parsed.targets.some((t) => t.path.endsWith("/out.txt")), "早停但前缀有效 ⇒ 已读出的真目标不许连坐丢弃");
});

test("#711 阻断 B（判据 4）：未闭合定界符引号的 heredoc 不可执行 ⇒ 不记 out.txt、只计数", () => {
  // `cat > out.txt <<'EOF`（定界符引号没闭合）⇒ heredoc 语法不完整、bash 根本不执行。
  // 与「未闭合引号」同口径：只计数、不记路径。
  const parsed = parseExecCommandWrites("cat > out.txt <<'EOF", { cwd: CWD });
  assert.ok(!parsed.targets.some((t) => t.path.endsWith("/out.txt")),
    "判据 4：命令不可执行 ⇒ 前面的 out.txt 也不进台账");
  assert.equal(parsed.hasWriteForm, true, "有写形态 ⇒ 计数面成立");
  assert.ok(parsed.unresolvedWriteCount >= 1, "判据 4：不可执行 ⇒ 计入未解析");
});

test("#711 阻断④（判据5）：混合命令 known && $OUT ⇒ 已知进台账，未解析一半仍举旗", () => {
  const parsed = parseExecCommandWrites('echo a > known.txt && echo b > "$OUT"', { cwd: CWD });
  assert.ok(parsed.targets.some((t) => t.path.endsWith("/known.txt")), "能解析的那一半必须进台账");
  assert.ok(parsed.unresolvedWriteCount >= 1, "$OUT 解析不出 ⇒ 计入未解析");
  const payload = payloadFor({
    execWriteCount: 1,
    execWriteUnresolvedCount: 1,
    fileWrites: [{ path: `${CWD}/known.txt`, round: 1, tool: EXEC_TOOL_NAME, via: "redirect" }],
    toolStats: new Map([[EXEC_TOOL_NAME, { calls: 1, failures: 0 }]]),
  });
  assert.equal(payload.fileWritesBlindToExec, true, "有未解析的一半 ⇒ 即使台账里有 exec 条目也必须举旗");
});

test("#711 阻断④ 端到端（判据5）：known && $OUT ⇒ 台账含 known.txt 且举旗", async () => {
  const dir = await makeTmp("erix-exec-writes-mixed-");
  const { payload } = await runExecOnly(['echo a > known.txt && echo b > "$OUT"'], { cwd: dir });
  assert.ok(payload.fileWrites.some((e) => e.path === join(dir, "known.txt")),
    `已知的那一半必须进台账，实测 ${JSON.stringify(payload.fileWrites)}`);
  assert.equal(payload.fileWritesBlindToExec, true, "未解析的 $OUT ⇒ 举旗");
});

test("#711 判据6：-- 终止选项、-f 取值选项、附着式都让目标解对", () => {
  assert.ok(targetPaths("tee -- -out.txt").some((p) => p.endsWith("/-out.txt")), "tee -- 后的 -out.txt 是文件名");
  assert.ok(targetPaths("sed -i -f script.sed notes.md").some((p) => p.endsWith("/notes.md")),
    "-f 的值 script.sed 不是目标，notes.md 才是");
  assert.ok(!targetPaths("sed -i -f script.sed notes.md").some((p) => p.endsWith("/script.sed")),
    "判据 3：-f 的值 script.sed 是脚本文件，绝不进台账");
  // 判据 1：`sed -i -- -notes.md` 里 `--` 只终止选项、不提供脚本 ⇒ `-notes.md` 是**脚本**、没有
  // 文件操作数（sed 从 stdin 读）⇒ **不进台账**，但仍是写形态 ⇒ 计数 + 未解析 +1。
  const noFileSed = parseExecCommandWrites("sed -i -- -notes.md", { cwd: CWD });
  assert.equal(noFileSed.hasWriteForm, true, "sed -i 就是写形态，哪怕没有文件操作数也要计数");
  assert.ok(!noFileSed.targets.some((p) => true), "判据 1：`-notes.md` 是脚本不是文件 ⇒ 台账无条目");
  assert.ok(noFileSed.unresolvedWriteCount >= 1, "判据 1：有写、目标不明 ⇒ 未解析计数 +1");
  // 判据 2（对照）：`sed -i 's/a/b/' -- -notes.md` 里脚本是 `'s/a/b/'`，`--` 之后那个 `-notes.md` 才是文件。
  assert.ok(targetPaths("sed -i 's/a/b/' -- -notes.md").some((p) => p.endsWith("/-notes.md")),
    "判据 2：`--` 之后的 -notes.md 是文件名，进台账");
  assert.ok(targetPaths("sed -i -f=script.sed notes.md").some((p) => p.endsWith("/notes.md")), "-f= 附着式：notes.md 是目标");
  assert.ok(targetPaths("sed -i --expression='s/a/b/' f.txt").some((p) => p.endsWith("/f.txt")), "--expression= 附着式：f.txt 是目标");
  assert.ok(targetPaths("tee -a out.txt").some((p) => p.endsWith("/out.txt")), "tee -a 是开关，不取值");
});
