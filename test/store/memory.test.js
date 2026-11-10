import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { transcriptStoreContract } from "../contract/transcript-store.js";

// memory store：通用行为全部由契约套件覆盖，无实现特有行为需补充
// 内置 memory store 全量实现除快路径探针外的全部可选能力（issue #739：声明出来，
// 于是「把某个可选实现删了」会在这套件的收尾核对里红，而不是被守卫静默跳过）。
transcriptStoreContract("memory", () => createMemoryTranscriptStore(), {
  optionalCapabilities: ["runSnapshot", "runState", "runStateStatus", "rawRows"],
});

// ---- issue #78：deprecated 别名委托 ----

test("memory: deprecated 别名 saveCheckpoint/appendCheckpoint/loadLatestCheckpoint 委托新方法", async () => {
  const store = createMemoryTranscriptStore();
  await store.saveCheckpoint("run-1", { round: 1, status: "pending" });
  await store.appendCheckpoint("run-1", { round: 2, status: "executed" });

  assert.deepEqual(await store.loadLatestCheckpoint("run-1"), { round: 2, status: "executed" });
  assert.deepEqual(await store.loadLatestRunSnapshot("run-1"), { round: 2, status: "executed" });
});

// ---- issue #811：写侧轮号守卫（`round` 不是安全整数 ⇒ `TypeError`，一行都不写）──────────────
// 为什么两个内置 store 各钉一份：守卫的**实现**共用（`src/store/transcript-dedup.js#assertSafeRound`），
// 但守卫**装在哪**是各自对外的写入口——宿主调的是 `store.appendRound`。只钉一侧，另一侧悄悄撤掉
// 守卫就没人红（同一课见上面的去重用例：两个 store 必须抛同一份实现产出的同一形状）。
// 类型是契约的一部分：宿主只把 `TypeError` 映射成 4xx，其它异常一律 5xx。

/** `[现场, 那一行的 round 写法, 错误信息里必须出现的「收到的值与类型」]`。 */
const UNSAFE_ROUNDS = [
  ["驱动把整型列返回成字符串", "2", '"2" (string)'],
  ["小数轮号", 2.5, "2.5 (number)"],
  ["null", null, "null"],
  ["压根没有 `round` 键", undefined, "undefined (the row carries no `round` key at all)"],
];

test("memory: 非安全整数的 round 当场拒收（TypeError，点名入口/哪一行/收到的值与类型）", async () => {
  const store = createMemoryTranscriptStore();
  for (const [label, round, expected] of UNSAFE_ROUNDS) {
    const record = round === undefined
      ? { dedupKey: `k-absent`, messages: [] }
      : { dedupKey: `k-${String(round)}`, round, messages: [] };
    await assert.rejects(
      () => store.appendRound("run-1", record),
      (error) => {
        assert.ok(error instanceof TypeError, `${label}：必须 TypeError（宿主据此映射 4xx），实得 ${String(error)}`);
        assert.match(error.message, /^appendRound: /u, `${label}：必须点名入口，实得 ${error?.message}`);
        assert.match(error.message, /k-absent|k-2|k-2\.5|k-null/u,
          `${label}：必须点名是哪一行（dedupKey），实得 ${error?.message}`);
        assert.ok(error.message.includes(expected),
          `${label}：必须点名收到的值与类型「${expected}」，实得 ${error?.message}`);
        assert.match(error.message, /not a safe integer/u, `${label}：实得 ${error?.message}`);
        return true;
      },
      `${label} 必须被当场拒掉`,
    );
  }
  assert.deepEqual(await store.load("run-1"), [], "被拒的写一行都不留（不是「先进去再被读侧忽略」）");
  // 同一份判据也装在恢复行通道上（恢复行的事件键含轮号）。
  await assert.rejects(
    () => store.appendRecoveryRow("run-1", { dedupKey: "r-1", round: "3", kind: "recovery" }),
    (error) => error instanceof TypeError && /^appendRecoveryRow: /u.test(error.message),
    "appendRecoveryRow 同样拒非整数轮号",
  );
  assert.deepEqual(await store.listRecoveryRows("run-1"), [], "被拒的恢复行也不留");
  // 正向对照：合法轮号照写（守卫只挡不可用的值，不改变任何合法写）。
  await store.appendRound("run-1", { round: 0, dedupKey: "k-zero", messages: [] });
  await store.appendRound("run-1", { round: Number.MAX_SAFE_INTEGER, dedupKey: "k-max", messages: [] });
  assert.equal((await store.load("run-1")).length, 2, "round=0 与最大安全整数都是合法写");
});
