// todo 内置工具单测（issue #65：自 ~/.erix/skills/todo/skill.mjs 内置化）
// 数据文件位置/格式与原 skill 完全一致（~/.erix/todos/<basename>-<hash8>.json），
// 测试通过隔离的临时 HOME 注入，绝不触碰真实 ~/.erix/todos/。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";

import { createCliTools } from "../../bin/tools.js";

function todoDataPath(home, cwd) {
  const base = basename(cwd) || "root";
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return join(home, ".erix", "todos", `${base}-${hash}.json`);
}

async function withIsolatedHome(callback) {
  const home = await mkdtemp(join(tmpdir(), "erix-todo-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "erix-todo-cwd-"));
  const originalHome = process.env.HOME;
  // os.homedir() 在 POSIX 上优先读 $HOME，借此隔离数据目录
  process.env.HOME = home;
  try {
    await callback({ home, cwd });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

test("todo_add/todo_list/todo_done/todo_clear 返回可读字符串并完成数据读写", async () => {
  await withIsolatedHome(async ({ home, cwd }) => {
    const { executeTool } = createCliTools({ cwd });

    assert.match(
      await executeTool("todo_add", { text: "写代码" }),
      /^已添加任务 #1: 写代码$/,
    );
    assert.match(
      await executeTool("todo_add", { text: "写测试" }),
      /^已添加任务 #2: 写测试$/,
    );

    const listed = await executeTool("todo_list", {});
    assert.match(listed, /共 2 条任务/);
    assert.match(listed, /#1 \[pending\] 写代码/);
    assert.match(listed, /#2 \[pending\] 写测试/);

    assert.match(
      await executeTool("todo_done", { id: 1 }),
      /^已将任务 #1 标记为完成：写代码$/,
    );

    const pendingOnly = await executeTool("todo_list", { status: "pending" });
    assert.match(pendingOnly, /#2 \[pending\] 写测试/);
    assert.doesNotMatch(pendingOnly, /#1/);

    assert.match(await executeTool("todo_clear", {}), /^已清空全部任务（共 2 条）$/);
    assert.equal(await executeTool("todo_list", {}), "（无任务）");

    // 数据文件确实落在隔离的临时 HOME 下，且格式为 pretty JSON 数组
    const dataPath = todoDataPath(home, cwd);
    const onDisk = JSON.parse(await readFile(dataPath, "utf8"));
    assert.deepEqual(onDisk, []);
  });
});

test("todo_add 的 id 取现存最大 id + 1（不重复利用已删/已完成 id）", async () => {
  await withIsolatedHome(async ({ cwd }) => {
    const { executeTool } = createCliTools({ cwd });
    await executeTool("todo_add", { text: "a" });
    await executeTool("todo_add", { text: "b" });
    await executeTool("todo_add", { text: "c" });
    await executeTool("todo_done", { id: 3 });
    assert.match(await executeTool("todo_add", { text: "d" }), /^已添加任务 #4: d$/);
  });
});

test("todo_done 对不存在的 id 抛错，todo_add 拒绝空文本", async () => {
  await withIsolatedHome(async ({ cwd }) => {
    const { executeTool } = createCliTools({ cwd });
    await assert.rejects(() => executeTool("todo_done", { id: 99 }), /任务不存在: id=99/);
    await assert.rejects(() => executeTool("todo_add", { text: "  " }), /text/);
  });
});

test("兼容 ~/.erix/todos/ 既有老数据文件（原 skill 格式 fixture）", async () => {
  await withIsolatedHome(async ({ home, cwd }) => {
    // 按原 skill.mjs 的落盘格式构造历史数据（含 done 项、完整四键）
    const legacy = [
      {
        id: 1,
        text: "历史任务 A",
        status: "done",
        createdAt: "2026-09-01T08:00:00.000Z",
      },
      {
        id: 2,
        text: "历史任务 B",
        status: "pending",
        createdAt: "2026-09-20T12:30:00.000Z",
      },
    ];
    const dataPath = todoDataPath(home, cwd);
    await mkdir(join(home, ".erix", "todos"), { recursive: true });
    await writeFile(dataPath, JSON.stringify(legacy, null, 2), "utf8");

    const { executeTool } = createCliTools({ cwd });
    const listed = await executeTool("todo_list", {});
    assert.match(listed, /共 2 条任务/);
    assert.match(listed, /#1 \[done\] 历史任务 A/);
    assert.match(listed, /#2 \[pending\] 历史任务 B/);

    // 继续追加：id 接续历史最大值（2 + 1 = 3），且不破坏既有条目
    assert.match(
      await executeTool("todo_add", { text: "新任务" }),
      /^已添加任务 #3: 新任务$/,
    );
    const persisted = JSON.parse(await readFile(dataPath, "utf8"));
    assert.equal(persisted.length, 3);
    assert.deepEqual(persisted.slice(0, 2), legacy);
    assert.equal(persisted[2].status, "pending");
    assert.equal(persisted[2].text, "新任务");
  });
});

test("损坏的 todo 数据文件按空列表处理，不会崩溃", async () => {
  await withIsolatedHome(async ({ home, cwd }) => {
    const dataPath = todoDataPath(home, cwd);
    await mkdir(join(home, ".erix", "todos"), { recursive: true });
    await writeFile(dataPath, "{ not-json", "utf8");
    const { executeTool } = createCliTools({ cwd });
    assert.equal(await executeTool("todo_list", {}), "（无任务）");
    assert.match(await executeTool("todo_add", { text: "重建" }), /^已添加任务 #1: 重建$/);
  });
});
