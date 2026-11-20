// issue #875 第二刀（契约面）：**拿宿主 pi-web 的真代码当参照**，而不是拿我手抄的口径。
//
// 为什么这一刀必须存在：上一单（PR #877）的 `test/examples/erix-run-liveness.test.js` 用的是一张
// **我手抄宿主口径**写出来的假 registry（`createFakeHostRegistry`）。它证明的是「我抄对了」，
// **不是「宿主真按这个判」** —— 复核把这条明确判成**不成立**：「独立 fake registry 仍有与扩展一起
// 复刻错误宿主假设的风险」。我在工单里就抄错过一次（以为宿主对 provider `name` 跑正则，实际
// `validateProvider` 只做 `assertNonEmptyString`；那条 `^[A-Za-z0-9_-]{1,64}$` 是宿主另一处的
// `HOLDER_PATTERN`）。两边错在一起时，那张表和我们的模块会一起绿。
//
// 本文件的判据形状因此换了：**参照物是宿主自己的源码**
// （`fixtures/pi-web-session-liveness-e533d9b3.ts` = `pi-web:lib/session-liveness.ts` 在
// `e533d9b3` 的**逐字拷贝**，捕获点与 sha256 记在同名 `.json` 的 `_meta` 里，由
// `fixtures/capture-pi-web-liveness-875.mjs` 现采现算）。那份文件**零 import**，本机的
// type-stripping（`process.features.typescript === "strip"`）能直接 `import()` 它。
// 产物住在**根 `fixtures/`**而不是 `test/fixtures/`：裸 `node --test` 会把 `test/` 下每个文件当一个
// 测试文件收（实测 `ok 119 - test/fixtures/pi-web-session-liveness-e533d9b3.ts`），那是一格白跑的恒过
// 文件，也正是 `test/static-guards.test.js`「test/ 下不放会被收集执行的支撑文件」那条规矩要挡的那一类。
//
// ⚠ **这里没有假 registry，也不许再造一个**：宿主的 `getRegistry()` 在**模块顶层**跑，
// `import()` 那一刻它自己把注册表挂到 `globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")]`。
// 所以本文件既不自己挂表，也**不许**在 `beforeEach` 里删那个键（删了宿主模块不会重建 —— 它的
// `getRegistry()` 只在装载时跑一次），末尾也不需要清理。每格**自己注册自己释放**（`finally`），
// 于是格与格之间不靠执行顺序成立。
//
// ⚠ skip 面是**文件级闸**：运行时不能直载 `.ts` 时本文件只注册**一条** skip（不是 9 条），
// 支持时 9 格全跑、零 skip。下面 `cell()` 那段写的就是为什么要这样。
//
// 与 `erix-run-liveness.test.js` 的分工：那张表量的是**形状**（含 registry 缺席 / `version !== 1` /
// 宿主抛异常这些**只能造**出来的现场）；本文件量的是**端到端**（我们的模块 × 宿主的真实现）。
// 两张表都要在：只有本文件就盖不住降级路径，只有那张表就是自证。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PI_WEB_LIVENESS_REGISTRY_KEY,
  registerSessionLiveness,
  resolvePiWebLivenessRegistry,
  sessionHasLiveWork,
} from "../../examples/pi-extension/erix-run-liveness.js";

/** 宿主的真模块（逐字拷贝的 fixture；住在根 `fixtures/`，不进 `test/` —— 见上面那段理由）。 */
const FIXTURE_TS = new URL("../../fixtures/pi-web-session-liveness-e533d9b3.ts", import.meta.url);
/** 它的捕获点元数据。 */
const META_JSON = new URL("../../fixtures/pi-web-session-liveness-e533d9b3.json", import.meta.url);

/**
 * 运行时能不能直载 `.ts`。**只允许这一种 skip 理由**（不许拿"环境不便"当理由把契约关掉）：
 * 缺 type-stripping 的运行时（node < 22.18）里 `import()` 那份 `.ts` 会直接语法错，
 * 那是**装载失败**而不是契约破裂，把它判红就是假红。CI 的 node 22 / 24 两侧都支持。
 */
const TS_STRIPPING = Boolean(process.features.typescript);
const SKIP_REASON = `当前运行时 node ${process.version} 不支持 .ts 直载（CI 的 node 22/24 支持）`;

/** 宿主的真模块：装载它的**副作用**就是那张表出现在 globalThis 上。 */
/** @type {any} */
const host = TS_STRIPPING ? await import(FIXTURE_TS.href) : null;

/**
 * **文件级闸**（为什么不是逐格 `{ skip }`）：缺 type-stripping 的环境里，9 格各自 skip 会凭空多出
 * **9 条** skip。全量实测过：本机基线 skip = 13，登记上限 `maxSkipped: 18`，13 + 9 = 22 ⇒
 * `check:test-summary` 报 `SKIPPED_OVER` —— 那不是掉了覆盖，却是一道靠环保险的门。
 * 所以闸放在**文件级**，两条路径的读数都是实测的：
 *   · 支持直载 ⇒ 注册下面全部 9 格，`# skipped 0`；
 *   · 不支持 ⇒ **一格也不注册**，只注册**一条**带上面那句理由的 skip ⇒ `# skipped 1`。
 * 注意这不是把契约“偷变成绿”：那一条仍然带着跳过理由挂在那里，而 `# fail` 两侧都是 0。
 *
 * @param {string} name 格名（一律带 `#875 契约` 前缀）
 * @param {() => void} fn 格子本体
 */
const cell = (name, fn) => {
  if (TS_STRIPPING) test(name, fn);
};
if (!TS_STRIPPING) {
  test("#875 契约（整文件）：9 格需要直载 fixtures/pi-web-session-liveness-e533d9b3.ts",
    { skip: SKIP_REASON }, () => {});
}

/** 装载一次就挂上的那张表（**宿主自己挂的**，本文件一个字都没往里写）。 */
const hostRegistry = () => globalThis[Symbol.for(PI_WEB_LIVENESS_REGISTRY_KEY)];

/**
 * 把**真表**的 `register` 临时包一层，只为数「这一条到底敲到宿主门了没有」。
 * 这不是假 registry：被包的实现是宿主自己的实现，包完仍由它校验、簿记、返回 release；
 * `finally` 里必须还原（不还原就是把计数漏给下一格）。
 *
 * @param {{register: Function}} registry
 */
function countRegisterCalls(registry) {
  const real = registry.register;
  /** @type {unknown[]} */
  const seen = [];
  registry.register = (provider) => {
    seen.push(provider);
    return real.call(registry, provider);
  };
  return { seen, restore: () => { registry.register = real; } };
}

cell("#875 契约 格0：参照物自身的身份 —— fixture 字节 == `_meta.sourceSha256`，键与 version 与宿主导出逐字相同", () => {
  const meta = JSON.parse(readFileSync(META_JSON, "utf8"))._meta;
  const bytes = readFileSync(FIXTURE_TS);
  const measured = createHash("sha256").update(bytes).digest("hex");
  assert.equal(measured, meta.sourceSha256,
    `fixture 的字节与登记的 sha256 对不上（拷贝被改过？重跑 fixtures/capture-pi-web-liveness-875.mjs 看是谁改的）：`
    + `实测 ${measured} ≠ 登记 ${meta.sourceSha256}`);
  // 捕获点的形状：完整 40 位 sha，且与产物文件名里那个短 sha 前缀同源（文件名↔账本不许各说各话）。
  assert.match(meta.baseSha, /^[0-9a-f]{40}$/, `baseSha 不是完整 sha：${meta.baseSha}`);
  assert.match(FIXTURE_TS.pathname, new RegExp(`pi-web-session-liveness-${meta.baseSha.slice(0, 8)}\\.ts$`),
    `产物文件名里的短 sha 与 _meta.baseSha 不是同一个捕获点：${FIXTURE_TS.pathname}`);
  assert.equal(meta.sourcePath, "lib/session-liveness.ts");
  assert.match(meta.sourceRepo, /pi-web/, `sourceRepo 不是实测的 remote：${meta.sourceRepo}`);
  assert.match(meta.nodeVersion, /^v\d+/, `nodeVersion 不像实测值：${meta.nodeVersion}`);
  assert.notEqual(Number.isNaN(Date.parse(meta.capturedAt)), true, `capturedAt 不是时间戳：${meta.capturedAt}`);
  // **键与版本逐字对账**：我们手抄的那串键名，与宿主自己导出的常量必须是同一个字符串；
  // 表也必须是宿主在模块顶层自己挂的那一张（version 从表上读，不是我们自己写的）。
  assert.equal(PI_WEB_LIVENESS_REGISTRY_KEY, host.SESSION_LIVENESS_REGISTRY_KEY,
    "我们抄的注册表键 ≠ 宿主导出的键 —— 差一个字就是另开一张表，两端各说各话");
  const registry = hostRegistry();
  assert.equal(registry?.version, 1, "表上的 version 不是 1（宿主的协议版本变了，本仓的校验口径要重读）");
  assert.equal(resolvePiWebLivenessRegistry(), registry,
    "我们的读口没认宿挂在 globalThis 上的那张真表（认错了就等于永远注册不进宿主看得见的那张表）");
});

cell("#875 契约 格1：真注册 —— 我们的模块注册得上，宿主自己问得出这一条", () => {
  const lease = registerSessionLiveness({ sessionId: "contract-A", isActive: () => true });
  try {
    assert.equal(lease.registered, true, "宿主的表在场、参数合法 ⇒ 必须注册得上（注册不上就是整条通道没接上）");
    assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-A" }), true,
      "宿主按它自己的真实现问自己 ⇒ 必须说这个会话活着");
    // 对照组：不是「表里只要有任何一条，宿主就说所有会话都活着」。
    assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-A-typo" }), false,
      "换一个 sessionId 就应当问不出活性（问得出 ⇒ 这一格绿得没有意义）");
  } finally {
    lease.release();
  }
  assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-A" }), false,
    "release 之后宿主问不出活性（放不掉 lease 的会话永不回收）");
});

cell("#875 契约 格2（核心）：我们的 sessionHasLiveWork 被宿主的真实现消费，并随 job 状态转假", () => {
  /** 真 Map 当 job 表；`isActive` 是**我们的**判据（不是随手写的布尔）。 */
  const jobs = new Map([["r-875-2", { ownerSessionId: "contract-A", status: "running" }]]);
  const lease = registerSessionLiveness({
    sessionId: "contract-A",
    isActive: () => sessionHasLiveWork(jobs, "contract-A"),
  });
  try {
    assert.equal(lease.registered, true);
    assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-A" }), true,
      "有一条 running 的 job ⇒ 宿主的真实现必须问出 true（这就是「我们的判据被宿主消费」那一端）");
    jobs.set("r-875-2", { ownerSessionId: "contract-A", status: "completed" });
    assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-A" }), false,
      "同一条 job 结算完、且不欠投递重试 ⇒ 宿主的真实现必须问出 false（判据只会说 true 就是永不回收）");
  } finally {
    lease.release();
  }
});

cell("#875 契约 格3：notifyRetry 那段窗口宿主也算活（复核 C 条：run 跑完、通知还没投出去）", () => {
  const jobs = new Map([["r-875-3", { ownerSessionId: "contract-A", status: "completed", notifyRetry: {} }]]);
  const lease = registerSessionLiveness({
    sessionId: "contract-A",
    isActive: () => sessionHasLiveWork(jobs, "contract-A"),
  });
  try {
    assert.equal(lease.registered, true);
    assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-A" }), true,
      "completed 但投递重试还欠着 ⇒ 宿主必须仍说它活（这段窗口只有 5/10/30 秒，回收掉就等于把刚跑完的终局退回 orphaned）");
    // 对照组：定时器已清（`notifyRetry` 变 undefined）⇒ 必须放开，否则这个会话永生。
    jobs.get("r-875-3").notifyRetry = undefined;
    assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-A" }), false,
      "notifyRetry 清掉之后宿主必须问出 false（判据漏掉这一段就是这格红）");
  } finally {
    lease.release();
  }
});

cell("#875 契约 格4：release 生效且幂等 —— 释放后宿主问不出活性，再放一次不抛", () => {
  const lease = registerSessionLiveness({ sessionId: "contract-release", isActive: () => true });
  assert.equal(lease.registered, true);
  assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-release" }), true);
  assert.doesNotThrow(() => lease.release(), "第一次释放不许抛");
  assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-release" }), false,
    "宿主的簿记真的摘掉了这一条（`Symbol(name)` 键 + `disposed` 一次性开关）");
  assert.doesNotThrow(() => lease.release(), "第二次释放也必须安静（宿主的 release 是幂等的）");
  assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-release" }), false,
    "重复释放不许把别家的 lease 一起放掉（放成 true 就是幂等开关失效）");
});

cell("#875 契约 格5：多会话隔离 —— A 有活、B 注册了但无活，宿主各自答对", () => {
  const jobs = new Map([
    ["r-a", { ownerSessionId: "contract-A", status: "running" }],
    ["r-b", { ownerSessionId: "contract-B", status: "completed" }],
  ]);
  const a = registerSessionLiveness({ sessionId: "contract-A", isActive: () => sessionHasLiveWork(jobs, "contract-A") });
  const b = registerSessionLiveness({ sessionId: "contract-B", isActive: () => sessionHasLiveWork(jobs, "contract-B") });
  try {
    assert.equal(a.registered && b.registered, true, "两条注册都得成功（否则隔离这格是拿「只有一条在场」冒充）");
    assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-B" }), false,
      "B 名下只有结算完的 job ⇒ 不许被 A 的活挡下来（拿「进程里有活」当判据，所有会话都永生）");
    assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-A" }), true);
    assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-C" }), false,
      "压根没注册的会话也必须问出 false");
  } finally {
    a.release();
    b.release();
  }
});

cell("#875 契约 格6：sessionFile 这个匹配维度真的递到了宿主（宿主按 sessionId ∪ sessionFile 找）", () => {
  const lease = registerSessionLiveness({
    sessionId: "contract-F",
    sessionFile: "/tmp/f-875.jsonl",
    isActive: () => true,
  });
  try {
    assert.equal(lease.registered, true);
    assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "someone-else", sessionFile: "/tmp/f-875.jsonl" }), true,
      "宿主只拿 sessionFile 来问（sessionId 对不上）也必须问得到这一条 —— 注册时丢了那个键这里就是 false");
    assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-F" }), true,
      "按 sessionId 问同样要得到 true（两个维度是并集，不是二选一）");
    assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "someone-else", sessionFile: "/tmp/nope-875.jsonl" }), false,
      "两个维度都不相干的会话不许被这一条挡下来");
  } finally {
    lease.release();
  }
});

cell("#875 契约 格7：坏参数被我们的前置校验挡在门外（真宿主的 validateProvider 对这两种会 throw）", () => {
  // 反证在前：先证明**宿主真会抛** —— 否则「我们挡住了」这半句毫无分量，本层就成了凭空拦截。
  assert.throws(
    () => host.registerSessionLivenessProvider({ name: "probe-875", sessionId: "", isActive: () => true }),
    /sessionId must be a non-empty string/,
    "宿主对空 sessionId 不抛了？口径变了就得重读 pi-web:lib/session-liveness.ts 并重采 fixture",
  );
  assert.throws(
    () => host.registerSessionLivenessProvider({ name: "probe-875", sessionId: "contract-boom", isActive: "nope" }),
    /isActive must be a function/,
    "宿主对非函数 isActive 不抛了？同上：口径变了要重读并重采",
  );
  // 然后是我们的那一半：同样的入参，我们返回 `registered:false` 且**不抛**，而且一次也没敲宿主的门。
  const counter = countRegisterCalls(hostRegistry());
  try {
    const cases = [
      ["空 sessionId", { sessionId: "", isActive: () => true }],
      ["缺 sessionId", { isActive: () => true }],
      ["isActive 非函数", { sessionId: "contract-bad", isActive: "nope" }],
    ];
    for (const [label, options] of cases) {
      let lease;
      assert.doesNotThrow(() => {
        lease = registerSessionLiveness(/** @type {any} */ (options));
      }, `${label}：不许把宿主的异常打给调用方`);
      assert.equal(lease.registered, false, `${label}：必须挡在本层`);
      assert.doesNotThrow(() => lease.release(), `${label}：release 仍要可用`);
    }
    assert.deepEqual(counter.seen, [],
      `坏参数一次也没该敲宿主的门，实测敲了 ${counter.seen.length} 次（拿「宿主会抛」当降级路径，就是把异常打给用户）`);
    // 对照组：计数器不是恒绿的死表 —— 合法参数必须被数到一次。
    const ok = registerSessionLiveness({ sessionId: "contract-counted", isActive: () => false });
    assert.equal(counter.seen.length, 1, "计数器没数到这次合法注册 ⇒ 上面那条「零次」是假的");
    ok.release();
  } finally {
    counter.restore();
  }
});

cell("#875 契约 格8：宿主的 provider 抛错 ⇒ fail-safe 保留会话（我们依赖的兜底，钉住它真在）", () => {
  const errors = [];
  const realError = console.error;
  console.error = (...args) => { errors.push(args.map((a) => String(a)).join(" ")); };
  /** @type {(() => void) | undefined} */
  let release;
  let active;
  try {
    // 这一格刻意**绕过我们的模块**，直接调宿主导出的注册口：要钉的是宿主那段兜底本身。
    release = host.registerSessionLivenessProvider({
      name: "probe-875-boom",
      sessionId: "contract-boom",
      isActive() { throw new Error("boom"); },
    });
    active = host.hasActiveSessionLivenessProvider({ sessionId: "contract-boom" });
  } finally {
    console.error = realError;
    release?.();
  }
  assert.equal(active, true,
    "provider 抛错时宿主必须返回 true（保留会话）—— 变成 false 就意味着「判据报错」被当成「没有活」，后台 run 又被回收");
  assert.ok(errors.length >= 1, `宿主没记一条失败日志 ⇒ 这个 true 不是从 catch 分支来的，这格在验别的东西：${JSON.stringify(errors)}`);
  assert.match(errors.join("\n"), /preserving the session/,
    `宿主的兜底文案变了（重采 fixture 后请重读这一格的措辞）：${JSON.stringify(errors[0])}`);
  assert.equal(host.hasActiveSessionLivenessProvider({ sessionId: "contract-boom" }), false,
    "release 之后那条抛错的 provider 必须已不在表里（否则整个文件的后续格子会被它的 true 污染）");
});
