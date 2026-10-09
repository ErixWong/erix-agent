import { execFile, spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { createCliTools } from "../bin/tools.js";
import { makeTmp } from "./helpers/tmp.js";

const execFileAsync = promisify(execFile);

async function withTempDir(callback) {
  const directory = await makeTmp("erix-codewrite-");
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function initializeGitRepository(cwd) {
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Erix Codewrite"], { cwd });
  await execFileAsync("git", ["config", "user.email", "codewrite@example.invalid"], { cwd });
}

// issue #186：外部二进制前提显式化。git 不是本包的运行时依赖，slim 镜像与多数 CI 镜像里
// 没有它——缺就 skip 并注明原因，而不是让整条用例变红（红会盖掉真实回归）。
// 被测契约本身（exec 驱动外部可执行：输出捕获 / 空输出 / 参数引号 / 非零退出）不依赖 git，
// 由下面 exec drives an external fixture 那条用夹具脚本永远跑一遍，所以这里的 skip 不会掩盖缺陷。
function probeGit() {
  const probed = spawnSync("git", ["--version"], { stdio: "ignore" });
  if (probed.error?.code === "ENOENT") return { available: false, reason: "PATH 中没有 git（外部二进制缺失）" };
  if (probed.status !== 0) return { available: false, reason: `git --version 退出码 ${probed.status}` };
  return { available: true, reason: "" };
}

const git = probeGit();

test("writeFile writes to an arbitrary path", async () => {
  await withTempDir(async (cwd) => {
    const destination = await makeTmp("erix-codewrite-destination-");
    try {
      const target = join(destination, "nested", "hello.txt");
      const { executeTool } = createCliTools({ cwd });
      assert.equal(
        await executeTool("writeFile", { path: target, content: "你好" }),
        Buffer.byteLength("你好", "utf8"),
      );
      assert.equal(await readFile(target, "utf8"), "你好");
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
});

test("exec runs arbitrary commands", async () => {
  await withTempDir(async (cwd) => {
    const { executeTool } = createCliTools({ cwd });
    assert.equal(await executeTool("exec", { command: "echo hello" }), "hello\n");
    assert.match(await executeTool("exec", { command: "ls /" }), /bin/);
  });
});

test("readFile reads arbitrary files", async () => {
  await withTempDir(async (cwd) => {
    await withTempDir(async (outside) => {
      const target = join(outside, "anywhere.txt");
      await writeFile(target, "outside\n", "utf8");
      const { executeTool } = createCliTools({ cwd });
      assert.equal(await executeTool("readFile", { path: target }), "1: outside");
    });
  });
});

// 真实 git 工作流：exec 驱动 add/commit/log/push 四步（外部二进制存在时才跑，缺失显式 skip）。
test("exec runs git add, commit, and push commands", { skip: git.available ? false : git.reason }, async () => {
  await withTempDir(async (cwd) => {
    await initializeGitRepository(cwd);
    await writeFile(join(cwd, "tracked.txt"), "tracked\n", "utf8");
    const { executeTool } = createCliTools({ cwd });

    assert.equal(await executeTool("exec", { command: "git add tracked.txt" }), "exit 0（无输出）");
    const commitResult = await executeTool(
      "exec",
      { command: 'git commit -m "codewrite commit"' },
    );
    assert.match(commitResult, /codewrite commit/);
    assert.match(await executeTool("exec", { command: "git log --oneline -1" }), /codewrite commit/);

    const pushResult = await executeTool("exec", { command: "git push" });
    assert.match(pushResult, /No configured push destination|没有配置的推送目标|push destination/i);
  });
});

// issue #186：上一条 git 用例在 git 缺失时会被 skip，所以这里自带夹具，把同一套「exec 驱动外部
// 可执行文件」契约常驻跑住：空输出成功 / 带引号参数 / 上一步留下的状态可读 / 失败走 stderr /
// 非零退出且无输出时回 exit N / 二进制缺失时的行为——全部不依赖镜像里装了什么。
test("exec drives an external fixture across add/commit/log/push without any installed binary", async () => {
  await withTempDir(async (cwd) => {
    const fixture = join(cwd, "bin", "git");
    await mkdir(join(cwd, "bin"), { recursive: true });
    await writeFile(fixture, [
      "#!/bin/sh",
      "# 只复现被测契约所需的可观察行为：输出、退出码、参数传递（含引号）、跨命令状态。",
      'case "$1" in',
      "  add) exit 0 ;;",
      '  commit) shift 2; echo "$1" >> .git-log; echo "[fixture master] $1" ;;',
      "  log) cat .git-log ;;",
      '  push) echo "fatal: No configured push destination." >&2; exit 1 ;;',
      "  quietfail) exit 3 ;;",
      "  *) echo \"unexpected fixture call: $*\" >&2; exit 2 ;;",
      "esac",
      "",
    ].join("\n"), "utf8");
    await chmod(fixture, 0o755);
    const { executeTool } = createCliTools({ cwd });
    const command = (text) => executeTool("exec", { command: `PATH="$PWD/bin:$PATH" ${text}` });

    // 成功且无输出 → 固定文案（真 git add 走的就是这条）。
    assert.equal(await command("git add tracked.txt"), "exit 0（无输出）");
    // 带引号的多词参数必须完整递给外部程序，且 stdout 被捕获。
    assert.match(await command('git commit -m "codewrite commit"'), /\[fixture master\] codewrite commit/);
    // 上一步写下的状态，下一条命令读得到（多次 exec 调用共享 cwd）。
    assert.match(await command("git log --oneline -1"), /codewrite commit/);
    // 非零退出但有 stderr → 返回 stderr 原文（真 git push 走的就是这条）。
    assert.match(await command("git push"), /No configured push destination/);
    // 非零退出且无任何输出 → 回 exit N（命令失败）。
    assert.equal(await command("git quietfail"), "exit 3（命令失败）");
    // 二进制缺失：/bin/sh 自己报 not found，不抛异常（测试本身因此不需要 git）。
    assert.match(await command("definitely-not-installed-binary-186"), /not found/);
  });
});
