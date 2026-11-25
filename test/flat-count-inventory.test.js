// @ts-check
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeTmp } from "./helpers/tmp.js";
import { FLAT_WRITE_ALLOWLIST } from "../scripts/compat-pin-allowlist.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(TEST_DIR);
const SCRIPT = join(ROOT, "scripts/flat-count-inventory.mjs");

// 白名单判据用 `--verify <allowlist.mjs>` 跑：把给定的清单写成临时清单模块，让脚本按它核对真仓树。
// 台账（test/compat-pin-inventory.md）已在 #907 删除，判据换成白名单，于是这里的夹具也是清单形状。
async function runVerify(allowlist) {
  const tempDir = await makeTmp("erix-flat-count-allowlist-");
  const fixture = join(tempDir, "compat-pin-allowlist.mjs");
  writeFileSync(fixture, `export const FLAT_WRITE_ALLOWLIST = Object.freeze(${JSON.stringify(allowlist)});\n`, "utf8");
  const result = spawnSync(process.execPath, [SCRIPT, ".", "--verify", fixture], { cwd: ROOT, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

test("an out-of-list file with flat writes fails --verify and names the file", async () => {
  assert.ok(FLAT_WRITE_ALLOWLIST.length > 0, "白名单需要至少一条才能验证「清单外 ⇒ 红」");
  const target = FLAT_WRITE_ALLOWLIST[0].file;
  const { status, output } = await runVerify(FLAT_WRITE_ALLOWLIST.filter((e) => e.file !== target));
  assert.equal(status, 1, `清单外文件出现扁平写点必须让 --verify 失败：\n${output}`);
  assert.ok(output.includes("✗"), `判据必须报红：\n${output}`);
  assert.ok(output.includes(target), `判据必须点名文件 ${target}：\n${output}`);
});

test("a listed file whose flat-write count changed does not fail --verify (#907 behavior change)", async () => {
  const { status, output } = await runVerify(FLAT_WRITE_ALLOWLIST);
  assert.equal(status, 0, `清单内文件的点数如何变化都不应让 --verify 变红（相对旧台账的有意行为改变）：\n${output}`);
});

test("a whitelist entry pointing at a removed file fails --verify and names it", async () => {
  const ghost = "test/__allowlist_ghost_removed_907__.test.js";
  const { status, output } = await runVerify([...FLAT_WRITE_ALLOWLIST, { file: ghost, surfaces: ["data"] }]);
  assert.equal(status, 1, `清单条目指向已不存在的文件必须让 --verify 失败：\n${output}`);
  assert.ok(output.includes(ghost), `判据必须点名幽灵条目 ${ghost}：\n${output}`);
});
