// @ts-check
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeTmp } from "./helpers/tmp.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(TEST_DIR);
const SCRIPT = join(ROOT, "scripts/flat-count-inventory.mjs");
const INVENTORY = join(TEST_DIR, "compat-pin-inventory.md");
const SYNC_COMMAND = "node scripts/flat-count-inventory.mjs . --sync test/compat-pin-inventory.md";

function dataRowsInSection(lines, prefix) {
  const start = lines.findIndex((line) => line.startsWith(prefix));
  assert.notEqual(start, -1, `找不到清点表章节 ${prefix}`);
  const nextHeading = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const end = nextHeading === -1 ? lines.length : nextHeading;
  return lines.flatMap((line, index) => {
    if (index <= start || index >= end || !line.startsWith("| `test/")) return [];
    const cells = line.split("|");
    const file = cells[1]?.trim().replaceAll("`", "");
    const claimed = Number(cells[2]?.trim());
    if (!file || !Number.isInteger(claimed)) return [];
    return [{ index, file, claimed }];
  });
}

function changeClaimedCount(lines, row) {
  const cells = lines[row.index].split("|");
  cells[2] = ` ${row.claimed + 1} `;
  lines[row.index] = cells.join("|");
}

test("inventory mismatch diagnostics include the canonical --sync command", async () => {
  const lines = readFileSync(INVENTORY, "utf8").split("\n");
  const mainRows = dataRowsInSection(lines, "## MIGRATE");
  const appendixRows = dataRowsInSection(lines, "## 附表");
  assert.ok(mainRows.length > 0, "主表需要至少一行才能验证行级不一致");
  assert.ok(appendixRows.length > 1, "附表需要至少两行才能分别验证错值与漏行");

  const mainRow = mainRows[0];
  const appendixWrongRow = appendixRows[0];
  const appendixMissingRow = appendixRows[1];
  changeClaimedCount(lines, mainRow);
  changeClaimedCount(lines, appendixWrongRow);
  lines.splice(appendixMissingRow.index, 1);

  const tempDir = await makeTmp("erix-flat-count-inventory-");
  const fixture = join(tempDir, "compat-pin-inventory.md");
  writeFileSync(fixture, lines.join("\n"), "utf8");
  const result = spawnSync(process.execPath, [SCRIPT, ".", "--verify", fixture], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, `mutated inventory must fail its existing checks:\n${output}`);

  const diagnostics = output.split(/\r?\n/u).filter((line) => line.startsWith("  ✗ "));
  const expected = [
    `主表 ${mainRow.file}：`,
    `附表 ${appendixWrongRow.file}：`,
    "主表合计：",
    "附表合计：",
    `附表漏行 ${appendixMissingRow.file}：`,
  ];
  for (const prefix of expected) {
    const line = diagnostics.find((diagnostic) => diagnostic.includes(prefix));
    assert.ok(line, `缺少判据 ${prefix}：\n${output}`);
    assert.ok(line.includes(SYNC_COMMAND), `判据 ${prefix} 缺少合法更新命令：\n${line}`);
  }
});
