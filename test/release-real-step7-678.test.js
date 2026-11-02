// issue #678：`npm run check:release:real` 的第 7 步 `cli-real-smoke` 必须进清单汇总。
//
// 病根（票面原话：只看 `tests=?` 会误判成「跑过但不知道证了什么」）：第 7 步跑的是
// `scripts/cli-real-smoke.mjs`，它打的不是 `node --test` 的 TAP，于是清单里的 `parseTapSummary()`
// 一个字段也取不到 ⇒ 汇总里只剩 `tests=? pass=? fail=? skip=?`。`?` 本身是对的（取不到不许写 0），
// 但它把「C1–C8 全跑全过」与「一条都没跑」压成同一个符号。
//
// 本文件五组牙（全部离线、不依赖真上游）：
//   A. **行契约**（`scripts/smoke-summary-line.mjs`）：生产/消费共用的那一行的形状与不变量。
//      `pass` 由 `checks - fail` 推（不许两处各传一个数）、`fail > checks` 抛、失败 id 压成 `C4`、
//      `dry` 自报、半行/自相矛盾的行**读不回来**（⇒ 消费方写 `?`，绝不补 0）。
//   B. **展示**（`release-real-check.mjs#summaryLine`）：TAP 步骤一字不变；声明了会报汇总的步骤
//      读不到就写 `cli_real=?`（不省略）；绿的写 `cli_real=8/8/0`、红的点名 `failed=C4,C7`、
//      `--dry` 写 `dry=true`、脚本自身抛了写 `status=error`。
//   C. **生产端真跑一次**（`node scripts/cli-real-smoke.mjs --dry` + 本地 TCP 假端点）：只跑 C8 ⇒
//      自报 `checks=1`（这一格同时证明计数**不是**写死的 8），`dry=true`，退出码 0，
//      行首没有 `[check:cli-real]` 前缀（要能 `grep '^RELEASE-REAL-SMOKE'`），假 HOME 一个字节没被写。
//   D. **闸门关着仍无副作用**（`node scripts/release-real-check.mjs`，`ERIX_E2E_REAL` 未设）：exit 0、
//      一步都不跑、不出现 `=== [i/N]` 步骤横幅、也不出现汇总行（没跑过就没有可汇总的东西）。
//   E. **反向证：冒烟的结果变了，清单汇总必须跟着变**（issue #678 评论 id 6577783318 点名要求的那一格）。
//      变异打在**真脚本的副本**上（不碰真树，同 `agents-directive-scan --self-test` 的先例）：往副本的
//      `--dry` 分支真注入一条必红检查 ⇒ 副本自己报 `checks=2 pass=1 fail=1 failed=C9`，清单汇总必须从
//      `cli_real=1/1/0` 变成 `cli_real=2/1/1 failed=C9`。**变异没落上算失败**（#210 R2 口径）：靶串不在
//      源文件里、或替换后文本没变 ⇒ 本格直接红，不许静默变绿（下面还单独证一次「靶串不存在会被抓住」）。
//
// 反向证（本文件为什么不是恒绿）：B 组对「`?` 变成 `0`」「`failed=` 丢失」「`dry` 丢失」逐条断言；
// C 组对「写死 8」直接打红（`--dry` 时 `checks` 必须是 1）；D 组对「闸门关着还跑步骤」打红；
// E 组对「汇总没跟着冒烟的结果变」打红。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SMOKE_PREFIX, checkCode, formatSmokeLine, parseSmokeLine,
} from "../scripts/smoke-summary-line.mjs";
import { parseTapSummary, summaryLine } from "../scripts/release-real-check.mjs";
import { makeTmp } from "./helpers/tmp.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SMOKE_SCRIPT = join(ROOT, "scripts", "cli-real-smoke.mjs");
const CHECKLIST_SCRIPT = join(ROOT, "scripts", "release-real-check.mjs");

/** 一行汇总里所有 `key=value` 拆成对象（只给断言用，解析逻辑本身由 `parseSmokeLine` 负责）。 */
function fieldsOf(line) {
  const out = {};
  for (const token of line.split(/\s+/u).slice(1)) {
    const at = token.indexOf("=");
    if (at > 0) out[token.slice(0, at)] = token.slice(at + 1);
  }
  return out;
}

/** 剥掉 `//` 与 `/* *\/` 注释（静态钉子用：注释里写的形状不算代码形状）。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/u, "$1"))
    .join("\n");
}

/** 起一个只接受连接、立刻断开的本地 TCP 服务：闸门探端点只判 TCP 可达，一条消息也不发。 */
async function startFakeEndpoint() {  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ── A. 行契约 ─────────────────────────────────────────────────────────────────

test("#678 行契约：全绿那次是 checks/pass/fail + dry=false + failed=- + status=ok，且能原样读回", () => {
  const line = formatSmokeLine({ id: "cli-real", checks: 8, fail: 0, dry: false, failed: [], status: "ok" });
  assert.equal(line, `${SMOKE_PREFIX} id=cli-real checks=8 pass=8 fail=0 dry=false failed=- status=ok`);
  // 行首就是前缀：`grep '^RELEASE-REAL-SMOKE'` 必须能命中（日志前缀会让它不再是机器可读行）。
  assert.ok(line.startsWith(`${SMOKE_PREFIX} `), "汇总行必须以前缀开头");

  const parsed = parseSmokeLine(`[check:cli-real] 一些日志\n${line}\n`);
  assert.deepEqual(parsed, {
    id: "cli-real", checks: 8, pass: 8, fail: 0, dry: false, failed: [], status: "ok",
  });
});

test("#678 行契约：pass 由 checks - fail 推（不许两处各传一个数），失败 id 压成短码", () => {
  const line = formatSmokeLine({
    checks: 8,
    fail: 2,
    failed: ["C4 装后的 CLI 真跑了 ≥2 次工具（不是空转）", "C7 装好的包投影的每条 toolCalls 带 toolCallKey"],
    status: "fail",
  });
  const fields = fieldsOf(line);
  assert.equal(fields.pass, "6", "pass 必须等于 checks - fail（8 - 2）");
  assert.equal(fields.fail, "2");
  assert.equal(fields.failed, "C4,C7", "失败 id 必须压成 C<n> 短码（完整 id 塞不进一行汇总）");
  assert.equal(fields.status, "fail");
  assert.deepEqual(parseSmokeLine(line).failed, ["C4", "C7"]);
  assert.equal(checkCode("C1 无 --final-guard 的成功 run 退出码是 4（verification=skipped 的承诺）"), "C1");
  // 不是 C<n> 形状的 id 原样返回（宁可长一点，也不许吞成空串）。
  assert.equal(checkCode("CUSTOM-check"), "CUSTOM-check");
});

test("#678 行契约：--dry 自报 dry=true，checks 是实际条数（不是写死的 8）", () => {
  const line = formatSmokeLine({ checks: 1, fail: 0, dry: true, failed: [] });
  const fields = fieldsOf(line);
  assert.equal(fields.dry, "true", "--dry 必须自报（C1–C7 未跑不许读成全过）");
  assert.equal(fields.checks, "1", "只跑了 C8 ⇒ checks=1；这一格同时证明计数不是硬编码的 8");
  assert.notEqual(fields.checks, "8", "--dry 时绝不许报 8/8（那就是把没跑的 C1–C7 冒充成跑过）");
  assert.equal(fields.pass, "1");
  assert.equal(parseSmokeLine(line).dry, true);
});

test("#678 行契约：自相矛盾的行在生产者侧就抛，不许进汇总", () => {
  assert.throws(() => formatSmokeLine({ checks: 2, fail: 3, failed: ["C1", "C2", "C3"] }),
    /fail=3 大于 checks=2/u);
  assert.throws(() => formatSmokeLine({ checks: 2, fail: 1, failed: [] }),
    /与 fail=1 对不上/u, "失败数与失败 id 必须是同一份事实");
  assert.throws(() => formatSmokeLine({ checks: 1, fail: 0, status: "green" }), /status 必须是/u);
  assert.throws(() => formatSmokeLine({ checks: -1 }), /非负安全整数/u);
  // 生产者也不许印出消费者会拒读的组合（两侧同一套不变量：status 与计数不许打架）。
  assert.throws(() => formatSmokeLine({ checks: 1, fail: 1, failed: ["C4"], status: "ok" }),
    /status=ok 却 fail=1/u);
  assert.throws(() => formatSmokeLine({ checks: 1, fail: 0, failed: [], status: "fail" }),
    /status=fail 却 fail=0/u);
});

test("#678 行契约：读不回来的三种形状都返回 undefined（消费方写 ?，绝不补 0）", () => {
  assert.equal(parseSmokeLine(""), undefined);
  assert.equal(parseSmokeLine("完全没有这一行\n# tests 3\n"), undefined);
  // 半行（缺 fail）⇒ 当没读到。
  assert.equal(parseSmokeLine(`${SMOKE_PREFIX} id=cli-real checks=8 pass=8`), undefined);
  // 自相矛盾（pass + fail ≠ checks）⇒ 同样当没读到，不许把 8/8/1 印成「8 条全过还红 1 条」。
  assert.equal(parseSmokeLine(`${SMOKE_PREFIX} id=cli-real checks=8 pass=8 fail=1 dry=false failed=C4 status=fail`),
    undefined);
});

test("#678 行契约（Copilot 阻断点）：声明的七个字段缺一不可、值不合法就读不回来，合法行仍绿", () => {
  // 对照组：合法完整行必须读回来——否则下面那批「读不回来」可能是恒真。
  const legal = `${SMOKE_PREFIX} id=cli-real checks=1 pass=1 fail=0 dry=true failed=- status=ok`;
  assert.deepEqual(parseSmokeLine(legal), {
    id: "cli-real", checks: 1, pass: 1, fail: 0, dry: true, failed: [], status: "ok",
  });
  assert.equal(summaryLine({}, { smoke: parseSmokeLine(legal), expectsSmoke: true }),
    "tests=? pass=? fail=? skip=? cli_real=1/1/0 dry=true");
  // 将来生产者**多**一个字段不该把旧消费者弄瞎（多出来的字段不判死）。
  assert.notEqual(parseSmokeLine(`${legal} extra=1`), undefined, "多出来的未知字段不该让整行读不回来");

  // ① Copilot 独立验收 PR #681 的现场复现行：只有三个计数，dry / failed / status 全缺。
  const copilot = `${SMOKE_PREFIX} id=cli-real checks=1 pass=1 fail=0`;
  assert.equal(parseSmokeLine(copilot), undefined, "缺 dry/failed/status 的半行必须读不回来");
  assert.equal(summaryLine({}, { smoke: parseSmokeLine(copilot), expectsSmoke: true }),
    "tests=? pass=? fail=? skip=? cli_real=?", "半行必须在汇总里写 ?，不许补成 1/1/0 全绿");

  // ② 逐个字段删：缺任一个就够（七格都点名，不靠「碰巧缺的是 checks」）。
  for (const key of ["id", "checks", "pass", "fail", "dry", "failed", "status"]) {
    const line = legal.split(" ").filter((token) => !token.startsWith(`${key}=`)).join(" ");
    assert.notEqual(line, legal, `变异没落上：${key} 没被删掉（那这一格是空断言）`);
    assert.equal(parseSmokeLine(line), undefined, `缺 ${key} 的行必须读不回来`);
    assert.equal(summaryLine({}, { smoke: parseSmokeLine(line), expectsSmoke: true }),
      "tests=? pass=? fail=? skip=? cli_real=?", `缺 ${key} 时汇总必须写 cli_real=?`);
  }

  // ③ 值不合法 / 不自洽：同样一律当「没读到」。每条都先证「变异真的落上了」。
  const red = (body) => `${SMOKE_PREFIX} ${body}`;
  const illegal = [
    ["非法 dry（值不认）", legal.replace("dry=true", "dry=maybe")],
    ["非法 dry（空值）", legal.replace("dry=true", "dry=")],
    ["非法 status（值不认）", legal.replace("status=ok", "status=green")],
    ["非法 status（空值）", legal.replace("status=ok", "status=")],
    ["failed 条数与 fail 不一致", red("id=cli-real checks=3 pass=1 fail=2 dry=false failed=C4 status=fail")],
    ["failed 空洞（C4,,C7）", red("id=cli-real checks=2 pass=0 fail=2 dry=false failed=C4,,C7 status=fail")],
    ["failed 不是 - 却为空", red("id=cli-real checks=1 pass=1 fail=0 dry=false failed= status=ok")],
    ["id 不是 cli-real", legal.replace("id=cli-real", "id=other")],
    ["计数不自洽（pass+fail≠checks）", red("id=cli-real checks=8 pass=8 fail=1 dry=false failed=C4 status=fail")],
    ["status=ok 却有红", red("id=cli-real checks=2 pass=1 fail=1 dry=false failed=C4 status=ok")],
    ["status=fail 却没红", legal.replace("status=ok", "status=fail")],
    ["同一字段写两遍", `${legal} checks=2`],
    ["不是 key=value 的碎片", `${legal} junk`],
  ];
  for (const [name, line] of illegal) {
    assert.notEqual(line, legal, `变异没落上：${name} 的靶串没落上（那这一格是空断言）`);
    assert.equal(parseSmokeLine(line), undefined, `${name} 必须读不回来`);
    assert.equal(summaryLine({}, { smoke: parseSmokeLine(line), expectsSmoke: true }),
      "tests=? pass=? fail=? skip=? cli_real=?", `${name} 时汇总必须写 cli_real=?`);
  }
});

test("#678 行契约（Copilot 第二轮阻断点）：溢出 / 非安全整数的计数必须读不回来（Infinity 不许进汇总）", () => {
  // 夹具自证：这个串真的会变成 Infinity——否则本格证明不了「溢出」这条判据。
  const big = "9".repeat(400);
  assert.equal(Number(big), Infinity, "夹具失效：400 位 9 必须被 Number() 读成 Infinity");
  assert.equal(Number.isSafeInteger(Number(big)), false, "夹具失效：Infinity 必须不是安全整数");

  // Copilot 复现行：checks / pass 都是 400 位 9、fail=0——`Infinity + 0 === Infinity` 恰好绕过
  // 「计数自洽」那条判据，修前会被当成合法计数印成 `Infinity/Infinity/0`。
  const overflow = `${SMOKE_PREFIX} id=cli-real checks=${big} pass=${big} fail=0 dry=false failed=- status=ok`;
  assert.equal(parseSmokeLine(overflow), undefined,
    "400 位数字的自洽行必须读不回来（溢出后 Infinity + 0 === Infinity，自洽判据拦不住）");
  assert.equal(summaryLine({}, { smoke: parseSmokeLine(overflow), expectsSmoke: true }),
    "tests=? pass=? fail=? skip=? cli_real=?", "溢出必须写 cli_real=?，不许印 Infinity/Infinity/0");

  // 边界：MAX_SAFE_INTEGER 之上（含丢精度的那一格）同样当坏行。
  const unsafe = [
    ["Number.MAX_SAFE_INTEGER + 1", "9007199254740992"],
    ["2^53 + 1 的字面串（Number() 会静默丢精度）", "9007199254740993"],
    ["100 位数字", "9".repeat(100)],
  ];
  for (const [name, digits] of unsafe) {
    assert.equal(Number.isSafeInteger(Number(digits)), false,
      `夹具失效：${name} 必须是非安全整数，实际 ${Number(digits)}`);
    const line = `${SMOKE_PREFIX} id=cli-real checks=${digits} pass=${digits} fail=0 dry=false failed=- status=ok`;
    assert.equal(parseSmokeLine(line), undefined, `${name} 必须读不回来`);
    assert.equal(summaryLine({}, { smoke: parseSmokeLine(line), expectsSmoke: true }),
      "tests=? pass=? fail=? skip=? cli_real=?", `${name} 时汇总必须写 cli_real=?`);
  }

  // 边界上的**合法**大整数仍要读得回来：判据是「安全」，不是「小」（否则等于把正常值也拒了）。
  const maxSafe = String(Number.MAX_SAFE_INTEGER);
  const legalBig = `${SMOKE_PREFIX} id=cli-real checks=${maxSafe} pass=${maxSafe} fail=0 dry=false failed=- status=ok`;
  assert.deepEqual(parseSmokeLine(legalBig), {
    id: "cli-real",
    checks: Number.MAX_SAFE_INTEGER,
    pass: Number.MAX_SAFE_INTEGER,
    fail: 0,
    dry: false,
    failed: [],
    status: "ok",
  }, "MAX_SAFE_INTEGER 本身是合法计数，必须读得回来");
  assert.equal(summaryLine({}, { smoke: parseSmokeLine(legalBig), expectsSmoke: true }),
    `tests=? pass=? fail=? skip=? cli_real=${maxSafe}/${maxSafe}/0`);

  // 生产者侧同一套判据：不许印出消费者会拒读的计数（两侧不能各有一套数字规则）。
  assert.throws(() => formatSmokeLine({ checks: 2 ** 53 }), /非负安全整数/u);
  assert.throws(() => formatSmokeLine({ checks: 1, fail: 2 ** 53 }), /非负安全整数/u);
  assert.throws(() => formatSmokeLine({ checks: Infinity }), /非负安全整数/u);
});

test("#678 行契约：多条命中取最后一条（收尾那一条才是真话）", () => {
  const first = formatSmokeLine({ checks: 3, fail: 1, failed: ["C2"], status: "fail" });
  const last = formatSmokeLine({ checks: 8, fail: 0, failed: [] });
  const parsed = parseSmokeLine(`${first}\n中间的日志\n${last}\n`);
  assert.equal(parsed.checks, 8);
  assert.equal(parsed.fail, 0);
});

// ── B. 展示（release-real-check 的汇总行）────────────────────────────────────

test("#678 展示：TAP 步骤的汇总一字不变，也不带 cli_real 那一格", () => {
  const tap = parseTapSummary("# tests 2\n# pass 2\n# fail 0\n# skipped 0\n");
  assert.equal(summaryLine(tap), "tests=2 pass=2 fail=0 skip=0");
  // 没声明会报汇总的步骤，即使传了 smoke 也不印（否则会读成「它报了」）。
  assert.equal(summaryLine(tap, { smoke: parseSmokeLine(formatSmokeLine({ checks: 8 })) }),
    "tests=2 pass=2 fail=0 skip=0");
});

test("#678 展示：非 TAP 步骤取不到 TAP 仍写 ?，第 7 步读不到汇总就写 cli_real=?（不省略、不补 0）", () => {
  assert.equal(summaryLine(parseTapSummary("[check:cli-real] 没有 TAP 行\n")),
    "tests=? pass=? fail=? skip=?");
  assert.equal(summaryLine(parseTapSummary(""), { smoke: undefined, expectsSmoke: true }),
    "tests=? pass=? fail=? skip=? cli_real=?",
    "声明了会报汇总却读不到 ⇒ 必须留一格 ?，不许静默省略、也不许写 0");
  // 有 TAP 的步骤也不会因为「smoke 缺失」而被改形状。
  assert.equal(summaryLine({ tests: 1, pass: 1, fail: 0, skipped: 0 }, { smoke: undefined }),
    "tests=1 pass=1 fail=0 skip=0");
});

test("#678 展示：全绿 / 红 / --dry / 脚本自身抛 四种形状都点得名", () => {
  const green = parseSmokeLine(formatSmokeLine({ checks: 8, fail: 0, failed: [] }));
  assert.equal(summaryLine({}, { smoke: green, expectsSmoke: true }),
    "tests=? pass=? fail=? skip=? cli_real=8/8/0");

  const red = parseSmokeLine(formatSmokeLine({
    checks: 8, fail: 2, failed: ["C4 装后的 CLI 真跑了 ≥2 次工具（不是空转）", "C7 投影"], status: "fail",
  }));
  assert.equal(summaryLine({}, { smoke: red, expectsSmoke: true }),
    "tests=? pass=? fail=? skip=? cli_real=8/6/2 failed=C4,C7",
    "红的时候必须点名是哪几条 C 红了（红数 + 失败 id 都进汇总）");

  const dry = parseSmokeLine(formatSmokeLine({ checks: 1, fail: 0, dry: true, failed: [] }));
  assert.equal(summaryLine({}, { smoke: dry, expectsSmoke: true }),
    "tests=? pass=? fail=? skip=? cli_real=1/1/0 dry=true");

  const errored = parseSmokeLine(formatSmokeLine({ checks: 3, fail: 0, failed: [], status: "error" }));
  assert.equal(summaryLine({}, { smoke: errored, expectsSmoke: true }),
    "tests=? pass=? fail=? skip=? cli_real=3/3/0 status=error",
    "脚本自身抛了 ⇒ status=error：3/3/0 不许读成全绿（可能还有 5 条根本没跑到）");
});

// ── C. 生产端真跑一次（--dry，本地假端点，不打模型、不装包）──────────────────

test("#678 生产端：--dry 真跑一次，自报 checks=1 / dry=true / status=ok，假 HOME 一个字节没被写", async () => {
  const endpoint = await startFakeEndpoint();
  const home = await makeTmp("release-real-678-home-");
  try {
    await mkdir(join(home, ".erix"), { recursive: true });
    const configPath = join(home, ".erix", "config.json");
    await writeFile(configPath, JSON.stringify({
      slots: {
        default: {
          model: "fake-model-678",
          endpoint: `http://127.0.0.1:${endpoint.port}/v1`,
          apiKey: "fake-key-678",
        },
      },
    }, null, 2), "utf8");

    const env = { ...process.env, HOME: home, ERIX_E2E_REAL: "1", ERIX_E2E_CONFIG: configPath };
    const result = spawnSync(process.execPath, [SMOKE_SCRIPT, "--dry"], {
      cwd: ROOT, env, encoding: "utf8", timeout: 120_000,
    });
    assert.equal(result.status, 0, `--dry 应 exit 0，实际 ${result.status}\n${result.stdout}\n${result.stderr}`);

    const lines = result.stdout.split("\n").filter((line) => line.startsWith(SMOKE_PREFIX));
    assert.equal(lines.length, 1, `汇总行必须恰好一行且行首就是前缀，实际 ${lines.length} 行：\n${result.stdout}`);
    const parsed = parseSmokeLine(result.stdout);
    assert.notEqual(parsed, undefined, `汇总行读不回来：\n${result.stdout}`);
    assert.equal(parsed.id, "cli-real");
    assert.equal(parsed.checks, 1, "--dry 只跑 C8 ⇒ checks=1（写死 8 的实现在这里红）");
    assert.equal(parsed.pass, 1);
    assert.equal(parsed.fail, 0);
    assert.equal(parsed.dry, true, "--dry 必须自报 dry=true");
    assert.equal(parsed.status, "ok");
    assert.deepEqual(parsed.failed, []);

    // 消费方拿到它以后，清单里那一格就不再是 ?
    assert.equal(summaryLine(parseTapSummary(result.stdout), { smoke: parsed, expectsSmoke: true }),
      "tests=? pass=? fail=? skip=? cli_real=1/1/0 dry=true");

    // 假 HOME 的污染对账：配置还在、没多出 ~/.npmrc、~/.erix 里只有那一份配置。
    assert.deepEqual((await readdir(join(home, ".erix"))).sort(), ["config.json"]);
    assert.deepEqual((await readdir(home)).sort(), [".erix"]);
    assert.match(await readFile(configPath, "utf8"), /fake-key-678/u);
  } finally {
    await endpoint.close();
  }
});

// ── D. 闸门关着仍无副作用 ────────────────────────────────────────────────────

test("#678 闸门关着：check:release:real 一步都不跑、exit 0、不产汇总行", async () => {
  const env = { ...process.env };
  delete env.ERIX_E2E_REAL; // 缺省形态：真上游不是任何默认门禁的硬依赖
  const result = spawnSync(process.execPath, [CHECKLIST_SCRIPT], {
    cwd: ROOT, env, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(result.status, 0, `闸门关着必须 exit 0，实际 ${result.status}\n${result.stdout}\n${result.stderr}`);
  const out = result.stdout;
  assert.match(out, /\[gate_missing\]/u, "必须打分类原因（闸门缺失）");
  assert.match(out, /一步都没跑/u);
  assert.doesNotMatch(out, /=== \[\d+\/\d+\]/u, "闸门关着不许起跑任何一步");
  assert.ok(!out.includes(SMOKE_PREFIX), "没跑过就没有可汇总的东西：闸门关着时不许出现汇总行");
});

// ── E. 反向证：冒烟的结果变了，清单汇总必须跟着变 ───────────────────

/**
 * **只替换一次**，否则算「变异没落上」（#210 R2 口径：靶串不在 ⇒ 这一例必须红，不许静默变绿）。
 *
 * @param {string} text
 * @param {string} from 靶串（必须恰好出现 1 次）
 * @param {string} to
 * @returns {string}
 */
function mutateOnce(text, from, to) {
  const hits = text.split(from).length - 1;
  assert.equal(hits, 1,
    `变异没落上：靶串在源文件里出现 ${hits} 次（要求恰好 1 次）——变异没落上算失败，`
    + `否则这一格就是空断言：${JSON.stringify(from.slice(0, 80))}`);
  const mutated = text.replace(from, to);
  assert.notEqual(mutated, text, "变异没落上：替换后文本与原来一样");
  return mutated;
}

/** `--dry` 分支里 C8 那一行（唯一靶点：带它上一行的注释才能定位到 DRY 分支，不是正常路径那个）。 */
const DRY_BRANCH_TARGET = "    // 只跑污染对账：不 pack、不装、不打模型（一条请求也不发）。详见 `DRY_RUN` 的注释。\n"
  + "    checkHomePollution(pollutionTarget);\n";
/** 注入一条必红检查（真变异：它会让副本自己报 `checks=2 pass=1 fail=1 failed=C9`）。 */
const DRY_BRANCH_MUTANT = DRY_BRANCH_TARGET
  + "    check(\"C9 变异注入的必红检查\", () => { assert(false, \"变异注入：这条必须红\"); });\n";

/**
 * 把「冒烟脚本 + 它的两个相对依赖 + package.json」复制成一棵最小可跑树。
 * 变异打在这棵树里，**真树一个字节不动**（与 `agents-directive-scan --self-test` 的合成树同一条纪律）。
 *
 * @param {(source: string) => string} [mutate]
 */
async function makeSmokeTree(mutate) {
  const dir = await makeTmp("release-real-678-tree-");
  for (const rel of ["fixtures", "examples", "scripts"]) {
    await mkdir(join(dir, rel), { recursive: true });
  }
  for (const rel of ["scripts/smoke-summary-line.mjs", "fixtures/config-shape.mjs",
    "examples/e2e-real-gate.mjs", "package.json"]) {
    await writeFile(join(dir, rel), await readFile(join(ROOT, rel)));
  }
  const original = await readFile(SMOKE_SCRIPT, "utf8");
  const source = mutate === undefined ? original : mutate(original);
  await writeFile(join(dir, "scripts", "cli-real-smoke.mjs"), source, "utf8");
  return { dir, script: join(dir, "scripts", "cli-real-smoke.mjs"), original, source };
}

/** 在一棵（可能是变异的）冒烟树上跑一次 `--dry`，返回 `{ status, stdout }`。 */
async function runSmokeTree(tree, { home, configPath, port }) {
  const env = { ...process.env, HOME: home, ERIX_E2E_REAL: "1", ERIX_E2E_CONFIG: configPath };
  const result = spawnSync(process.execPath, [tree.script, "--dry"], {
    cwd: tree.dir, env, encoding: "utf8", timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 消费端真路（`runStep` + `main` 用的就是这两步）：读回汇总行 → 拼出汇总格。 */
function checklistCell(stdout) {
  return summaryLine(parseTapSummary(stdout), { smoke: parseSmokeLine(stdout), expectsSmoke: true });
}

test("#678 反向证：把冒烟的结果行改坏（真注入一条必红检查）⇒ 清单汇总的 pass/fail 跟着变", async () => {
  const endpoint = await startFakeEndpoint();
  const home = await makeTmp("release-real-678-mut-home-");
  try {
    await mkdir(join(home, ".erix"), { recursive: true });
    const configPath = join(home, ".erix", "config.json");
    await writeFile(configPath, JSON.stringify({
      slots: {
        default: {
          model: "fake-model-678", endpoint: `http://127.0.0.1:${endpoint.port}/v1`, apiKey: "fake-key-678",
        },
      },
    }, null, 2), "utf8");
    const run = { home, configPath, port: endpoint.port };

    // ① 未变异的副本：全绿，清单汇总里是 1/1/0（先确立对照组）。
    const baselineTree = await makeSmokeTree();
    const baseline = await runSmokeTree(baselineTree, run);
    assert.equal(baseline.status, 0, `对照组副本应 exit 0，实际 ${baseline.status}\n${baseline.stdout}`);
    assert.equal(checklistCell(baseline.stdout), "tests=? pass=? fail=? skip=? cli_real=1/1/0 dry=true",
      `对照组汇总不对：\n${baseline.stdout}`);

    // ② 变异副本：真注入一条必红检查（靶串不在 ⇒ `mutateOnce` 当场红 = 变异没落上算失败）。
    const mutantTree = await makeSmokeTree((source) => mutateOnce(source, DRY_BRANCH_TARGET, DRY_BRANCH_MUTANT));
    assert.notEqual(mutantTree.source, mutantTree.original, "变异没落上：副本源码与真源码一样");
    const mutant = await runSmokeTree(mutantTree, run);
    assert.equal(mutant.status, 1, `变异副本必须 exit 1，实际 ${mutant.status}\n${mutant.stdout}`);

    // ③ 冒烟自己报出来的三个数必须真的变了（否则下一步证明不了「汇总跟着冒烟走」）。
    const mutantSmoke = parseSmokeLine(mutant.stdout);
    assert.notEqual(mutantSmoke, undefined, `变异副本没印出汇总行：\n${mutant.stdout}`);
    assert.deepEqual(
      { checks: mutantSmoke.checks, pass: mutantSmoke.pass, fail: mutantSmoke.fail, failed: mutantSmoke.failed },
      { checks: 2, pass: 1, fail: 1, failed: ["C9"] },
      `变异副本自报的计数不对：\n${mutant.stdout}`,
    );
    assert.notDeepEqual(
      { checks: mutantSmoke.checks, pass: mutantSmoke.pass, fail: mutantSmoke.fail },
      { checks: 1, pass: 1, fail: 0 },
      "变异没落上：冒烟自己报的计数没变（那这一格证明不了汇总会跟着变）",
    );

    // ④ 清单汇总必须跟着变——这就是评论 id 6577783318 要的那一格。
    assert.equal(checklistCell(mutant.stdout), "tests=? pass=? fail=? skip=? cli_real=2/1/1 dry=true failed=C9",
      `汇总没跟着冒烟的结果变：\n${mutant.stdout}`);
    assert.notEqual(checklistCell(mutant.stdout), checklistCell(baseline.stdout),
      "变异前后清单汇总一模一样 ⇒ 汇总根本没读冒烟的结果");
  } finally {
    await endpoint.close();
  }
});

test("#678 反向证：变异没落上（靶串不在源文件里）必须当场红，不许静默变绿", () => {
  assert.throws(() => mutateOnce("这里没有那个靶串", "不存在的靶串", "x"), /变异没落上/u,
    "靶串不在源文件里时必须报错——否则「变异没落上」会被当成绿");
  assert.throws(() => mutateOnce(`${DRY_BRANCH_TARGET}${DRY_BRANCH_TARGET}`, DRY_BRANCH_TARGET, "x"),
    /出现 2 次/u, "靶串出现多次时同样必须报错（替错地方 = 变异没落上）");
});

// ── 静态钉子：上面那些动态断言靠的是脚本里的这两处接线 ───────────────────────

test("#678 生产端接线：check() 自己数条数，汇总行的四个数都取自真实结果", async () => {
  const source = stripComments(await readFile(SMOKE_SCRIPT, "utf8"));
  assert.match(source, /from "\.\/smoke-summary-line\.mjs"/u, "格式必须来自共享契约模块（别在脚本里另写一份）");
  assert.match(source, /function check\([\s\S]{0,200}?checksRun \+= 1;/u,
    "checksRun 必须在 check() 里自增（条数来自实际注册，不许写死）");
  assert.match(source, /checks: checksRun/u, "汇总行的 checks 必须是 checksRun");
  assert.match(source, /fail: failures\.length/u, "汇总行的 fail 必须是 failures.length");
  assert.match(source, /failed: failures/u, "失败 id 必须来自 failures（红时点得名）");
  assert.match(source, /dry: DRY_RUN/u, "dry 必须取自 --dry 的真值");
  assert.doesNotMatch(source, /checks(Run)?\s*[:=]\s*8\b/u, "不许把条数写死成 8（加 C9 时要跟着走）");
  assert.match(source, /if \(!gateOpened\) return;/u, "闸门没开时一条检查都没跑 ⇒ 不印汇总行");
  assert.match(source, /emitSmokeLine\(failures\.length > 0 \? "fail" : "error"\)/u,
    "脚本自身抛了要报 status=error（否则 0/0/0 会读成全绿）");
});

test("#678 消费端接线：第 7 步声明 smoke:true、走 parseSmokeLine、且自报 fail>0 判红", async () => {
  const source = stripComments(await readFile(CHECKLIST_SCRIPT, "utf8"));
  const stepBlock = /id: "cli-real"[\s\S]{0,400}?\}/u.exec(source);
  assert.notEqual(stepBlock, null, "STEPS 里找不到 cli-real 那一步");
  assert.match(stepBlock[0], /smoke: true/u, "cli-real 必须声明 smoke:true（汇总里要留 cli_real= 那一格）");
  assert.match(source, /parseSmokeLine\(output\)/u, "必须从子进程输出里读回汇总行");
  assert.match(source, /smokeSummary\.fail > 0/u, "退出码 0 而自报 fail>0 ⇒ 口径打架，必须判红");
  assert.match(source, /smokeSummary\.failed\.join/u, "红的时候要把失败 id 点进 reason");
  // `?` 语义的针脚：汇总行里取不到的字段不许被 0 顶掉。
  assert.match(source, /summary\[key\] === undefined \? "\?" : summary\[key\]/u,
    "summaryLine 的 ? 语义必须保留（取不到不许写 0）");
  assert.doesNotMatch(source, /summary\[key\] \?\? 0/u, "不许用 ?? 0 把「没摘要」变成「零失败」");
});
