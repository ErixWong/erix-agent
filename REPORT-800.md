# REPORT-800 — erix_run 异步唤醒把活会话判成孤儿（摘键无归属）

> **本轮范围：只有判据 1（摘键要有归属）+ 判据 2（同 sessionId 双实例的顺序守网）。**
> 判据 3（恢复回路）/ 4（`orphaned` 措辞）/ 5（`shutdown` 按实例归属）**未做**，留下一轮 —— 逐条见 `## 未验证`。

## 取证边界

本轮受主会话给定的读取预算约束，实际打开并逐字读过的路径只有这些：

- `examples/pi-extension/erix-run.ts` 的 `:596-665` —— `sessionHandle` 是 **factory 作用域**的局部
  （每次 factory 调用一份，闭包捕获自己那个会话的 `pi` / 唤醒器），而句柄表的键是 `sessionId`。
  两处摘键原文（改前）：
  - `:629`（`session_start` 的 rebind 摘旧键）`if (previous !== undefined && previous !== sessionId) globalSessionHandleRegistry().delete(previous);`
  - `:662`（`session_shutdown`）`if (reason !== "reload" && sessionId !== undefined) { globalSessionHandleRegistry().delete(sessionId); }`
  两处都是**裸键删除**，没有任何「表里这条还是不是我那个句柄」的判定。
- `examples/pi-extension/erix-run-jobs.js` 的 `createSessionHandleRegistry`（改前 `:349-366`，
  `delete: (sessionId) => handles.delete(sessionId)`）与 `jobView`（改前 `:577-629` ——
  **`status.json` 的内容就是这个函数的返回**，所以「出声」必须落在这里才谈得上可检查）。
- `test/examples/erix-run-async.test.js` 的 `:540-600`（`fakeCtx`，已带 `stale` 开关）、
  `:1470-1520`（`loadExtensionModule` / `startSession` / `dispatchAndSettle` 的用法）、
  `:1590-1700`（`#654` 的 orphaned 格 + quit/reload 摘句柄格）。
- **复核结论（与主会话给定的取证一致）**：`#654 缺陷1` 那一格（base 树 `:1597-1612`，主会话给的
  坐标 `:1608` 落在这格内，手工 `sessionHandles.delete(sessionA)` 在 `:1612`）是**手工**删句柄
  模拟会话走了，**从不走**「同 id 双实例 + 旧实例迟到 shutdown」
  这个顺序 ⇒ 本轮新增的那格（`test/examples/erix-run-async.test.js:1731`）是这个形状的**第一份**覆盖。
- **没打开的路径**（本轮按预算明令禁止，也确实不需要）：`scripts/*.mjs`、
  `test/test-suite-baseline.json`、`test/mutation-samples.md`、`test/compat-pin-inventory.md`、
  `test/static-guards.test.js`、`src/**`、`bin/**`、`docs/**`、`CHANGELOG.md`、
  `examples/pi-extension/README.md`。
  ⇒ 没有 `BLOCKED`：本轮的判据（1+2）全部可在扩展面 + 离线单测里取证，引擎侧不需要动。
- 顺带一条形状事实（不是本轮交付，但支撑「为什么 `delivery` 能当反向证的靶子」）：
  `notifySettled` 在 `sessionHandles.get(owner)` 查不到时**根本不调 `notify`**，直接记
  `recordDelivery(job, "orphaned", …)` ⇒ 归属校验一拆，红必然落在 `delivery` 上。

## 基点

`git log --oneline origin/main..HEAD`（现跑，测量点 = `e95fcf0`，即报告第一版已提交之后）：

```
e95fcf0 docs(#800): 交付报告四格（取证边界 / 基点 / 结论 / 未验证）—— 本轮只交判据 1+2
eab6609 fix(#800): erix_run 摘会话句柄要有归属 —— 旧扩展实例迟到的 session_shutdown 不再抹掉活实例的登记
```

`git diff --numstat origin/main..HEAD`（同一次现跑，同一棵树）：

```
177	0	REPORT-800.md
51	1	examples/pi-extension/erix-run-jobs.js
11	2	examples/pi-extension/erix-run.ts
70	0	test/examples/erix-run-async.test.js
```

- **两行都非空** ✓。本轮起点 = HEAD = `f405264`（= `origin/main`；当时 `git status --porcelain` 0 行、
  `git diff --numstat origin/main..HEAD` 为空 ⇒ 基点核对过：工作树与主干逐字一致，上一轮确实一个字节都没写下）。
- ⚠ **测量点是 `e95fcf0`**：把上面两块抄进本文件的那一笔（以及之后回填的那一笔）**只动
  `REPORT-800.md`**，不动代码。抄进来会让 REPORT-800.md 那一行的行数再变一次 —— 那是自指，
  不是造假：标测量点就是为了下一个读者能自己复现（`git log --oneline origin/main..e95fcf0` 与
  `git diff --numstat origin/main..e95fcf0` 逐字可得上面两块）。
- 代码那一笔（`eab6609`）的 numstat（同一命令现跑，当时只有一笔）：
  `50 0 REPORT-800.md` / `51 1 examples/pi-extension/erix-run-jobs.js` / `11 2 examples/pi-extension/erix-run.ts` / `70 0 test/examples/erix-run-async.test.js`。

## 结论

### 改了什么（判据 1）

| 位置 | 改动 |
|---|---|
| `examples/pi-extension/erix-run-jobs.js:390-400` | `createSessionHandleRegistry()` 新增 **`release(sessionId, handle)`**：只有 `handles.get(sessionId) === handle` 才删；不匹配 ⇒ **保留**（不删）+ 计数，返回 `{released, reason}`，`reason ∈ "released" \| "held-by-other-instance" \| "absent" \| "no-session-id"`。裸 `delete` 保留原样（测试与「不认领归属」的调用方仍可用） |
| `examples/pi-extension/erix-run-jobs.js:352-362`（声明）+ `:402`（读取面） | 计数真值源 `refusedReleases`（`Map<sessionId, number>`，挂在注册表实例上 ⇒ `globalSessionHandleRegistry()` 那一份是 `Symbol.for` 挂 globalThis 的，`/reload` 之后仍在）+ 读取面 `releaseRefusals(sessionId)`（恒在场，没挡过是 `0`，不返回 `undefined`） |
| `examples/pi-extension/erix-run-jobs.js:829`（`recordDelivery`） | 每次投递记账时把该 owner 的计数**抄进 job**（`job.handleReleaseRefusals`）—— 不抄的话只读 `status.json` 的会话永远看不见 |
| `examples/pi-extension/erix-run-jobs.js:655-661`（`jobView`） | 新增具名字段 **`handleReleaseRefusals: job.handleReleaseRefusals ?? 0`**（恒在场，没挡过是 `0`）⇒ 同一个 `jobView` 同时喂 `action:"status"` / `action:"result"` / `status.json` 三处，不存在第二份拼装 |
| `examples/pi-extension/erix-run.ts:631`（rebind 摘旧键）、`:671`（`session_shutdown`） | 两处裸 `delete(...)` 改成 **`release(..., sessionHandle)`** |

`shutdown` 的语义**没动**（`erix-run.ts:657` 的 `asyncRuntime().shutdown(sessionId)` 仍按 owner 清）——
那是判据 5 的兄弟洞，本轮明令不做。

### 判据 1 的现场（摘键要有归属 + 不匹配要出声）

- 归属匹配时**照旧摘**：新格第 ⑥ 步 `b.handlers.get("session_shutdown")({reason:"quit"})` 之后
  `assert.equal(sessionHandles.has(owner), false)` 绿 ⇒ 没有修成「谁也摘不掉」，`#654` 的
  orphaned 语义（owner 真走了 ⇒ 之后的 job 记 orphaned）不退。
- 不匹配时**保留**：`assert.equal(sessionHandles.get(owner), handleB)` 绿 —— 逐字比对的是**句柄对象身份**，
  不是「表里还有个句柄就行」（那会把「已被接管」读成「还是我那个」，正是本轮拆掉的缺陷）。
- 不匹配时**出声**：`jobView(job).handleReleaseRefusals === 1` 绿，且 `status.json` 上同一个键也是 `1`
  （同一份 `jobView` 投影，不是两处拼装）。

### 判据 2 的现场（同 sessionId 双实例的顺序 —— 本缺陷唯一有效守网）

新增 `test/examples/erix-run-async.test.js:1731`
`#800 判据1+2：同一个 sessionId 两个实例 ⇒ 旧实例迟到的 quit 不许抹掉活实例的句柄（活实例结算仍 sent）`。
形状：**A(`id=S`) 的 `session_start` → B(`id=S`) 的 `session_start`（接管，两个不同的 `sessionHandle` 对象，
`assert.notEqual(handleB, handleA)` 钉住）→ A **后发** `session_shutdown({reason:"quit"})` → 由**活实例 B**
派一张真异步 job 并结算**（离线：`HOME` 指空临时目录 ⇒ `config_missing` 当场终局，走的是**真的**
settle → `notifySettled` → `notify` 链，不是手搓的假 settle）。断言顺序是载荷：`delivery` 在前、
句柄身份在后（注释里写明了理由）。

```
$ node --test test/examples/erix-run-async.test.js
# tests 60
# pass 60
# fail 0
（同一棵树改动前用 `git stash` 现测对照：# tests 59 / # pass 59 / # fail 0 ⇒ 净增 1 格，就是这一格）
```

### 反向证现场（拆掉归属校验 ⇒ 必须红在 `delivery`）

人工变异落在真锚点上（`erix-run-jobs.js:394` 那一行，逐字整行替换）：

```
-      if (handle !== undefined && handle !== null && current !== handle) {
+      if (false) { // MUTANT: 拆掉归属校验            ⇒ 等价于退回裸 delete(sessionId)
```

```
$ node --test test/examples/erix-run-async.test.js
# Subtest: \#800 判据1+2：同一个 sessionId 两个实例 ⇒ 旧实例迟到的 quit 不许抹掉活实例的句柄（活实例结算仍 sent）
not ok 49 - \#800 判据1+2：同一个 sessionId 两个实例 ⇒ ...
  error: |-
    摘键要有归属：A 迟到的 quit 不许抹掉 B 的登记，抹掉了这条就是 orphaned（现场那三条全空重试）
    'orphaned' !== 'sent'
  code: 'ERR_ASSERTION'
  expected: 'sent'
  actual: 'orphaned'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/eric/wt-800/test/examples/erix-run-async.test.js:1757:12)
# tests 60
# pass 59
# fail 1
```

- **红在 `delivery`**：栈顶 `erix-run-async.test.js:1757` = `assert.equal(jobView(job).delivery, "sent", …)`
  那一行（不是文案断言、不是身份断言）。`fail 1` 且**只有**这一格红。
- 还原：`git checkout examples/pi-extension/erix-run-jobs.js` ⇒ 同一命令回到 `# tests 60 / # pass 60 / # fail 0`。
- 另一次同变异的早先一跑（断言顺序调整之前）也是 `expected: 'sent' / actual: 'orphaned'`，
  两次结果一致。

### 门禁逐条退出码（本轮按指示只跑这四类，串行，无 `npm test` 并发）

| 命令 | rc | 现场 |
|---|---|---|
| `node --check examples/pi-extension/erix-run-jobs.js` | 0 | 无输出 |
| `node --check test/examples/erix-run-async.test.js` | 0 | 打印 `SYNTAX-OK` |
| `node --check examples/pi-extension/erix-run.ts`（TS 文件，`node --check` 不适用） | — | 改用 `npx tsc --noEmit ... examples/pi-extension/erix-run.ts`：只有 `TS2307 Cannot find module '@earendil-works/pi-ai' / '@earendil-works/pi-coding-agent' / 'typebox'` 三条（这三个裸包名不在本仓，正是测试装载器用 `module.register` 打桩的原因）⇒ 本轮没有引入新的类型/语法错 |
| `node --test test/examples/erix-run-async.test.js` | 0 | `# tests 60 / # pass 60 / # fail 0` |
| 反向证那一跑（同上，带变异） | 1 | `# tests 60 / # pass 59 / # fail 1`，红在 `delivery`（原文见上一节） |
| 相邻套件 `node --test test/examples/erix-run-{details,pi-load,steer}.test.js examples/pi-extension/erix-run-e2e.test.mjs` | 0 | `# tests 36 / # pass 33 / # fail 0 / # skipped 3`（3 条 skip 是真上游闸门 `ERIX_E2E_REAL` 关着，与本轮无关） |
| `npm run -s check:syntax` | 0 | `syntax-check: OK — 全量 499 个跟踪的 .js/.mjs/.cjs 文件 node --check 全过` |

### 派生登记取值来源

本轮**没有**动任何派生登记表（`test/test-suite-baseline.json`、`test/static-guards.test.js` 地板常量、
`test/compat-pin-inventory.md`、`test/mutation-samples.md`），也**没有**跑取它们的命令 —— 按本轮指示
「登记面本轮不变」。已知会因此留下的账：新增一格 ⇒ `npm test` 的 `# tests` 会比登记值 3768 高
（`suite-summary-reconcile` 的棘轮方向是**多出来算绿 + 打一行 HINT**，不是红），下一轮要在那棵树上现测抬值。

## 未验证

- **判据 3（恢复回路）未做**：`session_start` 重新登记某 owner 后扫该 owner 名下
  `delivery === "orphaned"` 的 job 补投一次（复用 #659 的去重注册表）—— 本轮一行没写 ⇒
  **盘上已经存在的 `orphaned` job 仍然不会被救回**，本轮只保证「不再新造这种 orphaned」。
  现场那三条已经躺在盘上的 `orphaned` 本轮之后仍是 `orphaned`。
- **判据 4（措辞诚实）未做**：`erix-run-jobs.js:178`（`orphaned (owner 会话 <id> 已不在…）`）与
  `examples/pi-extension/README.md:385` 一字未改，仍与同文件 `:872` 那条注释（「会话关了 / **扩展实例换了**」）
  自相矛盾。
- **判据 5（兄弟洞）未做**：`erix-run.ts:657` 的 `asyncRuntime().shutdown(sessionId)` 仍按 **owner**
  清而不按**实例**清 ⇒ 旧实例迟到的 shutdown 仍会连带摘掉活实例名下 job 的看门狗与投递重试定时器
  （症状 `status.json` 永远停在 `running` 仍在）。新那一格里 B 的 job 是在 A 迟到 shutdown **之后**
  才派的，所以本轮那一格**碰不到**这个洞 —— 别把它的绿当成判据 5 的证据。
- **整套 `npm test` 没跑**（本轮明令不跑），所以：本轮**不能**声称全套绿；`# tests` 净增 1 格
  只在那一个文件里现测过（59 → 60）。
- 未跑的门禁（留下一轮，且要先删净 `src/**/*.d.ts`、串行跑）：`check:test-summary -- --log`、
  `check:changelog`、`check:docs`、`check:docs:strict`、`check:agents-directives`、`check:docs-spelling`、
  `check:docs-examples`、`check:pack-links`、`check:inventory`、`check:config-leaf-values`、
  `check:mutation`、`check:mutation:run`、`check:exports:deprecated`、`check:types`（含 `--with-tools`）、
  `check:types:strict`（含 `--with-tools`）、`check:types-build`、`check:release`、
  `node scripts/docs-drift-check.mjs --self-test`。
  **本轮不声称它们绿，也不声称它们红** —— 一次都没跑。
- `CHANGELOG.md` 未写（本轮不做，`check:changelog` 因此没跑）；README 未写。
- 真机 / 真上游（`ERIX_E2E_REAL=1`）没跑；本轮证据全部来自离线单测 + 一次人工变异。
- 本轮**没 push、没开 PR、没动分支/远端**；提交只在 `fix-261109-05-handle-owner-guard` 上。
