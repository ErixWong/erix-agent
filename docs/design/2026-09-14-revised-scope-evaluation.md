# 范围修订独立评估：重跑、取货与结构化 run state

- 日期：2026-09-15
- 对象：Issue #82 最新评论中的“范围修订”（决策 1–4）
- 依据：Issue #82、原始 RFC、上一轮独立评审、ADR-010/012，以及当前代码
- 方法：只做本地代码/文档和 GitHub issue 阅读；本评估没有发起任何模型、relay 或实验脚本调用

## 0. 结论先行

| 决策 | 判断 | 修订后的边界 |
|---|---|---|
| 1. 撤销重跑拦截，改为告知 | **修正：同意撤销硬拦截，不同意把告知当成正确性保证** | 重跑可以执行，但必须返回结构化的 `rerunOf`/首次来源/不可恢复状态；最终是否可交付由宿主或消费者按 provenance 决定。完全相同命令串只能做提示优化，不能做事实判定。 |
| 2. 精确取货 / 摘要取货 | **同意，但精确取货先做，摘要取货只留宿主 opt-in** | 引擎只提供有界、可对账的原文切片；摘要调用属于宿主策略或异步归档 worker。带地址的摘要仍是 `derived`，不能证明值。 |
| 3. 结构化 run state | **同意二分，修正触发和持久化协议** | 确定半由引擎/宿主已声明元数据机械构建；语义半由宿主 hook 触发、版本化替换、带来源且不覆盖确定半。首版应先落确定半。 |
| 4. 机械 vs 语义边界 | **基本同意，收窄“引擎能知道改过文件”等表述** | 引擎能产出协议字段、工件 provenance、轮次和工具足迹；“文件已改”只有在 `writeFile`/artifact 等结构化宿主事实已声明时才是机械事实，不能从任意 shell 文本推断。 |

关键判断是：撤销拦截解决了误伤和意图不可判定，却没有解决“模型忽略告知后把重跑值当原值”的交付风险。ADR-012 已明确 guard 默认关闭、正确性不得依赖提示词；因此必须把残余风险显式转成宿主/消费者契约，而不能用“模型看到了首次值”替代它。

---

## A. 决策 1：撤销拦截，改为告知

### A.1 “无法判断意图”成立到什么程度

**成立，但不能推出“所有保护都不应存在”。** 引擎从命令字符串无法可靠知道以下两种情况的区别：

1. 模型正在合法地生成第二个 UUID、第二个随机样本或新的时间戳；
2. 模型为了回答原问题，重跑同一操作后把新值冒充首次值。

同样，`exec` 的副作用也不能从字符串普遍分类：一个看似重复的命令可能是幂等读操作，也可能再次发送请求、删除资源或写入外部系统。当前 `bin/tools.js` 的 `duplicateCommands` 仍以 `normalizeCommand(command)` 作为 map key（约 577–579、816–847 行），而且只有 `replayable === false` 且能读到自动捕获时才拦截。这已经证明“完全相同命令串”不是足够的身份或意图协议；`bash -lc` 改写也能绕过它。

但撤销拦截不能被表述为“撤销安全责任”。至少应保留一个**不改变执行结果的告知层**：

- 同一 `runId` 内，若本次调用被宿主声明为 `non-replayable`，且存在首次 capture，返回实际的本次结果，同时附 `rerunOf` 指向首次 artifact/note 的 `digest`、`round` 和 locator；
- 首次 capture 失败、缺失或 digest 不匹配时，附 `status: "unrecoverable"`，明确“没有可证明的原值”，而不是给出空指针；
- 首次值如需直接展示，必须经过现有的 credential 脱敏规则；默认应优先返回来源指针和“本次值不是原值”的标注；
- 完全相同命令的 fingerprint 可以减少重复提示，但不能阻止执行，也不能因此把本次输出标为首次值；
- 不同命令包装、不同 toolUseId 或不同参数仍可按每次调用的 replayability 做告知，不应把“未命中相同字符串”当成安全通过。

这是“告知而不误伤”的最小替代。它与“按完全相同命令串拦截”不同：命令相等只影响提示去重，事实来源由 invocation-level capture/digest 决定。

### A.2 告知是否足够

**对交互体验足够，对可信交付不够。** 当前 guard 是 opt-in：`bin/cli.js` 只有显式 `--final-guard` 或环境变量开启时才创建 guard（约 154–160 行）；未注入 `finalGuard` 时，loop 将 verification 初始化为 `{ status: "skipped", reason: "no_final_guard" }`（`src/loop.js` 约 1259–1261 行）。因此一个不诚实或不细心的模型可以：

1. 看到“这是重跑”的 warning；
2. 忽略 warning；
3. 将本次新值写入终稿而不引用首次 artifact；
4. 在 guard 关闭的情况下得到正常的文本输出。

这不是理论上的“小概率模型问题”，而是“正确性依赖模型遵守提示”的反例，直接违反 ADR-012 的承重判定。我的判断是：

- **普通交互、消费者明确接受 best-effort 时：可接受。** 输出必须带机器可读的 `verification: skipped/unverified` 或等价状态，消费者不能把普通文本当成已核验事实。
- **需要事实准确、审计、自动化下游消费时：不可接受。** 宿主必须开启确定性 provenance gate、在下游拒绝 `unverified`，或把可证明的首次值作为结构化结果提供给消费者；不能只依赖模型读 warning。

残余风险的责任归属是：**引擎负责不伪造 provenance 和明确状态；宿主负责执行策略、归档权限和是否启用 gate；最终消费者负责不把 `skipped/unverified/unrecoverable` 当成 verified。** 不能把该责任推给模型。若宿主选择 guard 关闭又把文本直接当事实，风险由宿主/消费者承担，而不是由告知机制“自动化消除”。

### A.3 最小、可测的保护方案

不恢复拦截。新增或规范一个 additive 的 invocation 结果元数据：

```js
{
  replayability: "yes" | "no" | "unknown",
  replayabilitySource: "declared" | "policy" | "heuristic" | "unknown",
  artifact: { archivePath, digest, locator, status },
  rerunOf: {
    firstInvocationId,
    firstRound,
    digest,
    locator,
    status: "captured" | "missing" | "stale" | "unrecoverable"
  } | null
}
```

旧的 `replayable: boolean` 继续读写一段迁移窗口；冲突或缺失只能收紧为 `unknown`，不能放宽为可重放。确定性测试至少断言：

- 同一非重放命令第二次**确实执行**，返回实际第二次结果，但 `rerunOf.digest` 指向首次值；
- 首次归档缺失或 digest 改变时返回 `unrecoverable/stale`，不返回成功形状的空值；
- 首次 capture 的值不会因重跑 warning 被误标为本次值，credential 不进入 warning/stub；
- 不同 shell 包装仍可执行，并带首次来源告知；
- `duplicateCommands` 不再作为正确性 gate；现有“已拦截重复执行”断言应删除或改成“已告知重跑”。

### A.4 直接风险：副作用

撤销拦截的最大遗漏不是随机值，而是**副作用重复发生**。告知无法撤销已经发生的付款、删除、发布、写入或外部 API 调用。若宿主不能接受重复副作用，应在工具/沙盒层按能力或权限拒绝，不应把 CLI 的字符串 heuristics 假装成通用引擎安全机制。这也是 ADR-012 “宿主负责策略”的边界。

---

## B. 决策 2：精确取货 / 摘要取货

### B.1 两种模式的责任与代价

**精确取货应先做；摘要取货不能进入核心 loop 的正确性路径。**

另调一个 LLM 会增加四类成本：

| 成本 | 具体风险 |
|---|---|
| token/费用 | 每次摘要都消耗输入和输出额度；原文范围越大，输入成本越接近一次额外折叠。 |
| 延迟 | 取货从一次本地 I/O 变成网络调用；模型超时会阻塞恢复，甚至和主循环的终止预算竞争。 |
| 漂移 | 同一范围在不同模型、提示词或版本下可能得到不同“决定/进展”；摘要也可能漏掉否定、条件和 superseded 决策。 |
| 可用性/安全 | provider 不可用、摘要输入包含 prompt injection、跨权限读取或摘要泄漏凭据，都会把一个效率功能变成新故障面。 |

按照 ADR-012，语义摘要是**宿主策略**：宿主知道场景、profile、权限、预算和是否允许额外模型调用。可以由宿主按需调用，也可以交给异步 archive worker；不应由 `src/loop.js` 在折叠或 recall 中暗调另一个模型。引擎只提供确定性精确切片和 provenance。

### B.2 带地址的摘要仍不是真相

**“带地址”是必要条件，不是充分条件。** 摘要可能引用了正确轮次，却仍然：

- 把一次尝试写成最终决定；
- 把旧决定当成当前决定；
- 把两个 artifact 的值合并；
- 漏掉“不可重放”或失败状态；
- 给出与地址内容不一致的自然语言结论。

摘要响应必须显式标为 derived，而不是只给一个模型自报的 `confidence`。建议最小形状如下：

```js
{
  kind: "summary",
  status: "ok" | "truncated" | "stale" | "unrecoverable" | "error",
  text: "...",
  derived: true,
  source: {
    runId,
    fromRound,
    toRound,
    sourceVersion,
    digests: ["..."]
  },
  claims: [{
    text: "...",
    sourceRefs: [{ round, messageIndex, blockIndex, digest }],
    trust: "derived"
  }],
  prohibited: ["non_replayable_value", "verified_provenance"]
}
```

`confidence` 可以作为排序/调试字段，但不能提升 trust。对不可重放值，摘要必须只返回指针、状态和“请精确取货”的请求；禁止把摘要文本写入 `value`、`replayable`、`verified` 或其它不可重放值字段。最终 guard/消费者若需要证明值，必须重新核对 Tier 0/artifact 的 digest；摘要地址本身也必须先验证范围、版本和权限。

### B.3 精确取货的切片、游标和失败语义

现有 `store.recall(runId, fromRound, toRound, pattern)` 返回一个字符串，`src/tools/recall.js` 再做输出截断；这适合兼容旧 host，但不满足“源头有界”。新接口应采用对象参数，兼容旧位置参数一段时间：

```js
await store.recall({
  runId,
  fromRound,       // inclusive
  toRound,         // inclusive
  limit,           // item/record 上限
  cursor,          // opaque continuation token
  maxBytes,        // response hard upper bound
  artifactRef      // optional exact artifact/locator
});
```

切片的推荐优先级：

1. **寻址单位：** 轮次范围 + `messageIndex` + `blockIndex`；工具结果/工件另带 artifact locator。不能只按任意字符 offset，因为字符边界会切断结构和 Unicode。
2. **硬上限：** store 侧以记录/消息/block 为输出单位，用 `limit` 和 `maxBytes` 在读取源头限制；适配器可再用 token 上限保护模型上下文，但不能先读完整范围再截断。
3. **完整性：** 尽量返回完整 item；单 item 超过剩余预算时返回 `item_too_large`/`truncated` 和可继续的 cursor，不静默切成没有 provenance 的半句。
4. **游标：** 不透明、由 store 生成；绑定 `runId`、范围、排序、权限/租约和 `sourceVersion`。参数变化或版本变化返回 `cursor_mismatch`/`stale`，不能从错误位置继续。

建议状态至少区分：

```text
ok          当前切片完整；
empty       范围存在但没有匹配项；
truncated   达到 limit/maxBytes，带 nextCursor；
unrecoverable 目标轮次/工件缺失、损坏或无法证明原值；
stale       digest、cursor、sourceVersion 或权限已失效；
error       I/O、权限、参数或后端错误。
```

`""` 不能同时表示“空结果、权限拒绝、文件损坏和不可恢复”。现有 `src/tools/recall.js` 的 `recallText` 会 catch 后回退 `store.load`，迁移时应保留旧行为给旧 store，但新适配器必须让错误状态可辨识，避免一个失败的 bounded recall 退化成全量读。

---

## C. 决策 3：结构化 run state（确定半 + 语义半）

### C.1 谁触发、何时触发、预算是否现实

**确定半：** 每次成功折叠后由引擎构建，或由宿主提供结构化工具/artifact 元数据后由引擎合并。它不需要模型。

**语义半：** 由宿主显式 hook 触发最稳妥。折叠完成是自然触发点，但“每次折叠一次调用”不应成为核心默认；宿主可以按“每 N 轮、每个阶段、任务结束”选择。若在请求路径同步调用，必须有独立超时、固定输入上限和失败即保留旧状态的规则；更推荐异步 archive worker。引擎可发出 `state_candidate`/`fold_completed` 事件，但不自行选择模型或调用 provider。

`≤300 token` 对四个短字段（计划、已完成、下一步、决定/理由）作为**输出硬顶**是现实的；对任意长 coding 会话的完整叙事不是现实的。应把 300 视为响应预算而非质量保证：超限返回 `truncated`，禁止自动重试膨胀成本；输入只带本次 delta、上一份 state 和有限确定性证据，不要把整个 transcript 送给摘要器。

### C.2 schema 草案

建议新增一个独立于现有 `markRunState(runId, state: string)` 的结构化存储对象，不要把字符串状态接口悄悄改成对象：

```js
{
  schemaVersion: 1,
  runId: "run-...",
  stateVersion: 17,
  asOfRound: 42,
  covered: { fromRound: 0, toRound: 42 },
  foldedThrough: 36,

  deterministic: {
    tools: [
      { name: "readFile", count: 8, lastRound: 41 }
    ],
    artifacts: [
      {
        id: "001-exec.txt",
        round: 12,
        locator: { lineStart: 1, lineEnd: 20 },
        digest: "...",
        status: "archived" | "truncated" | "missing" | "stale",
        replayability: "yes" | "no" | "unknown",
        source: "declared" | "policy" | "heuristic" | "unknown"
      }
    ],
    declaredValues: [
      { name: "testStatus", value: "passed", round: 40, sourceRef: "..." }
    ],
    budget: { contextTokens: 131072, lastEstimate: 84000 },
    verification: { status: "verified" | "unverified" | "skipped" | "error" }
  },

  hostFacts: {
    modifiedFiles: [
      { path: "src/x.js", status: "changed", sourceRef: "artifact-or-tool-use" }
    ],
    todos: [
      { id: "task-1", status: "in_progress", sourceRef: "host-todo-store" }
    ]
  },

  semantic: {
    status: "absent" | "pending" | "ok" | "truncated" | "conflict" | "error" | "stale",
    trust: "derived",
    source: {
      kind: "host" | "llm",
      generatedAt: "...",
      inputStateVersion: 16,
      sourceRefs: ["round:37-42"]
    },
    plan: "...",
    completed: "...",
    next: "...",
    decisions: [
      { text: "...", sourceRefs: ["round:39"], trust: "derived" }
    ]
  }
}
```

其中 `hostFacts` 不是引擎从 shell 输出猜出来的事实；没有宿主结构化来源就留空。`declaredValues` 只能放工具/宿主明确声明的值，不能把 semantic 文本复制进去。

### C.3 注入位置与前缀缓存

首选**折叠块内的替换式注入**：

```text
[run state · deterministic · v1]
{有限 JSON 或稳定的机器字段}
[run state · semantic · derived]
计划：...
已完成：...
下一步：...
决定：...
来源：round 39；仅作导航，不是事实证明
```

- 不放 system：每次 state 改变会破坏 system 前缀缓存，也容易把 derived 文本误看成最高优先级规则。
- 不只放工具结果：工具结果会随下一轮视图和折叠消失，resume 后没有稳定位置。
- 不逐轮追加：使用一个固定 marker、固定字段顺序、替换旧 state；保留上限由 schema 控制。当前 statistical fold 已有单段摘要合并/替换逻辑（`src/compact/fold-statistical.js` 的 `prependSummary`），可沿用其“不膨胀”原则。

确定半应在语义半前面，并携带 `trust: "observed"`/`sourceRef`；语义半只能使用 `trust: "derived"`。前缀缓存的取舍是：折叠时替换 state 会使从 state 之后的 token 重新计算，但比把每次变化放入 system 或逐轮 append 更可控；稳定 system、工具 schema 和未变化的近期消息仍可保留缓存。

### C.4 防漂移、防说谎和冲突优先级

优先级固定为：

1. 可从 transcript/artifact 对账的确定性字段；
2. 宿主明确声明且带 sourceRef 的 host fact；
3. `semantic` 的 derived 文本。

语义半不得覆盖确定半。若摘要声称“测试已通过”，而确定半记录 `is_error` 或没有对应 verification/artifact，则保留语义文本但将整个 semantic state 标为 `conflict`，注入时显示“不可信/冲突”，不能静默选择其中一个。至少需要：

- 每条语义决定/计划带 sourceRefs；
- `inputStateVersion` 与当前 `stateVersion` 不一致时标记 stale，不覆盖新状态；
- JSON schema 校验、字段/字符/token 硬顶；
- 禁止 semantic 输出写入 `value`、`replayability`、`verification.status: verified`；
- 摘要器失败时保留上一份 semantic state 或 `error`，不清空确定半。

### C.5 resume、重入和膨胀

现有 loop 已将 `foldedPayload`、`foldedRoundRange` 和 `navigationRecord` 随 round record 持久化（`src/loop.js` 约 2636–2652 行），但 file/memory store 的 `loadRunState` 当前只是 `{ runId, state: string, ts }`。因此应新增 `saveRunState/loadRunState` 的对象协议，或将版本化 state 放入 checkpoint；不要重载原有字符串 `markRunState`。

幂等要求：

- key 为 `(runId, stateVersion)`，相同版本重入是 upsert/no-op；
- 语义 hook 的幂等 key 为 `(runId, inputStateVersion, covered.toRound)`；
- resume 先加载最新 state，只有覆盖范围前进才触发新语义任务；
- transcript 只保留当前 state 指针，旧版本按有限审计 retention 保存，不把每次 state 作为新的 user 文本追加；
- fold summary、navigation 和 run state 都采用“替换当前版本”，而不是合并无限历史；
- legacy transcript 没有 state 时按 `absent` 继续运行，不阻塞 resume。

---

## D. 决策 4：能力边界——机械 vs 语义

### D.1 判断

**同意“引擎只能承担机械部分”，但“机械”必须按来源定义。** 可确定性抽取的例子包括：

- `roundFrom/roundTo`、`foldedThrough`；
- tool name、toolUseId、调用次数、`is_error`；
- artifact id、archive path、locator、digest、truncated/status；
- 宿主已经放进结构化 metadata 的 `replayability`、policy/source；
- 成功调用 `writeFile` 的目标路径（“调用了写文件”），但不是“业务决策是什么”；
- transcript 中显式声明的协议字段或显式 user constraint 的原文指针。

这些是协议事实或来源索引，不是引擎理解了自然语言。引擎不能仅凭 `exec` 的输出可靠抽取“哪句是决定”“为什么选择方案 B”“当前计划”或泛化的 nonce/value。`modifiedFiles` 也只有在工具 metadata、artifact manifest 或宿主 diff 已声明时才可列入确定半。

### D.2 `boundedNavigationRecord` 是否过线

**已达到“机械部分”的合格基线，但还不是完整的 retrieval contract。** 当前实现已经有实质优点：

- 轮次范围；
- 最多 10 个 artifact、JSON 约 400 字符；
- id、locator、digest、`archived/truncated`；
- 去重、截断标记；
- 不把 artifact 内容或 credential 放进导航记录；
- statistical fold 与 sliding-window fallback 已统一生成。

仍缺：

1. `runId`、`schemaVersion`、`stateVersion/sourceVersion`，无法绑定 cursor 或判断旧导航是否陈旧；
2. `toolUseId`、artifact kind、产生轮次/message/block 位置和 replayability source，不能稳定关联 invocation；
3. `missing/stale/unauthorized/error/unrecoverable` 状态；当前没有 artifact 时通常只是“不生成 record”；
4. 非连续 protected round 被压成一个 min/max 范围，范围中可能含未折叠轮次；
5. 400 字符截断没有 continuation cursor，`truncated` 只能说明目录不完整；
6. digest 目前只是字符串切片和搬运，导航层没有声明“必须由 store/artifact 校验”的不变量；
7. 它仍是地址元数据，不是决策/约束语义索引，也没有接通新对象式 bounded recall。

所以它可以作为 P0/P1 的兼容输入，不应被宣传成已经完成“精确取货”。

---

## E. 遗漏与风险（对抗性检查）

四项决策合在一起仍未覆盖以下失败模式：

| 场景 | 失败方式 | 所需防线 |
|---|---|---|
| 重跑带副作用 | 取消拦截后，重复发布/删除/写入已经发生；warning 无法撤销副作用 | 宿主按 tool capability、权限和沙盒策略拒绝危险操作；engine 只记录 provenance。 |
| guard 关闭且模型冒充 | 模型忽略 warning，把第二次随机值写进终稿；CLI 仍输出普通文本 | 结构化 `verification`/`provenanceStatus` 进入宿主结果；消费者拒绝 `unverified`，或 host-side deterministic gate。 |
| replayability/归档声明错误 | 宿主误标 `yes`、archive 被截断/删除、digest 不匹配；精确取货拿到“看似有内容”的错误历史 | `unknown`/冲突收紧处理；artifact 状态和 digest 必须可验证；`unrecoverable/stale` 不能返回空成功。 |
| 摘要引用错误地址 | 摘要声称“决定在 round 10”，实际是 round 12 的 superseded 内容 | 地址逐条校验；摘要只能 derived；交付事实必须回到 artifact/transcript。 |
| 语义 state 竞态 | fold 后异步摘要落后于 resume，新摘要覆盖新决定；同一版本重复注入 | `inputStateVersion`、幂等 key、单调版本、冲突/stale 状态和 upsert。 |
| 确定半本身超预算 | artifact 很多、导航和工具足迹挤掉近期任务；为省 token 又截掉唯一地址 | 每个字段硬顶和降级顺序；至少保留 run/version、状态、地址、失败态；超限显式 `truncated`。 |
| legacy recall 静默降级 | 新 bounded store 错误被 `src/tools/recall.js` catch 后回退全量 `load`，内存/延迟超预算 | 新对象协议源头限流；错误状态可辨识；旧接口仅作为明确兼容适配器。 |
| retention/权限变化 | pointer 仍在 summary，artifact 已 GC 或调用者无权读；模型将地址当存在证明 | `missing/stale/unauthorized` 状态、租约/版本绑定和宿主权限策略。 |
| 多 consumer 视图冲突 | 模型看到摘要，guard/judge/resume worker 看到不同版本；同一“state”被当成单一真相 | 分离 archive truth、model view、verification view；各 consumer 使用 sourceVersion。 |
| secret 泄漏 | 首次值、stub 或语义摘要把 token/凭据带进 prompt、日志或 issue | capture/stub/summary 统一脱敏；默认只传 pointer；禁止把摘要值写入事实字段。 |

### E.1 对宿主契约的影响

- **`recoveryHint`**：继续接受现有 string/function 形状；新增 run state 不应要求宿主把 JSON 拼进 hint。hint 只做可丢弃导航，缺失不能改变真相。
- **`onAfterFold`**：当前 hook 在折叠结果产生后调用，返回值不参与 loop；不要改变其返回/错误语义来承载异步摘要。可新增 `onRunState`/`onStateCandidate`，或在 payload 中 additive 地提供 deterministic state。
- **`verification` / `finalGuard`**：guard 关闭时现有 `skipped` 兼容语义保留，但宿主结果必须能区分“未核验”和“已核验”。新增 provenance 字段不能让旧消费者误以为 verified。
- **`artifacts`**：现有 artifact 的 digest/locator/status 是基础；需补 invocation identity、replayability source、失效状态和首次/重跑关系。导航记录仍只放地址。
- **store/checkpoint**：`markRunState(string)` 保持不变，新增对象式 `saveRunState/loadRunState` 或 checkpoint 字段。file/memory 两个实现和 host adapter 都要双读 legacy。
- **notes**：继续作为 pull-only 效率/审计辅助；不要把语义 run state 的唯一副本放进 `note_take` 的 current/superseded 链，那里有 run scope 和条数/生命周期语义。

迁移采用 additive schema：旧 `foldedPayload`、`foldedRoundRange`、旧 summary、旧 boolean replayability 和位置参数 recall 都可读；新实现双读旧记录并可双写旧字段；feature flag 关闭时旧 host 仍可工作。至少保留一个版本窗口后，才考虑删除拦截实现或改变默认暴露的工具 schema。任何新增字段都不能让旧 reader 失效。

### E.2 成本估算

语义半的调用次数约等于**成功触发语义更新的折叠次数**，不是原始轮数。设长会话有 `R` 轮，每次折叠平均推进 `F` 轮，初始已有 `K` 轮可保留，则：

```text
calls ≈ ceil(max(0, R - K) / F)
semantic_output_tokens <= 300 * calls
cost = input_tokens * input_rate + output_tokens * output_rate
```

仅作 token 量级估算（没有指定模型和价格，不硬编码美元）：

- 120 轮、平均每次折叠推进 8 轮：约 15 次调用，输出上限 4,500 token；
- 500 轮、同样推进 8 轮：约 62–63 次调用，输出上限约 18,600–18,900 token；
- 若每次只输入 1,200 token 的“上一 state + 本次 delta”，500 轮示例还会增加约 75,000 token 输入；若把折叠原文送入摘要器，成本和延迟会显著放大。

这还没有计入超时重试、失败重算和并发 host 的排队。故首版必须：只传 bounded delta、每个 state 版本最多一次调用、无自动重试膨胀、语义半失败不阻塞确定半。任何模型 pilot 需另行报告模型、调用数和历史成本估计；本评估没有发起此类调用。

---

## F. 正确的落地排序与验收

### F.1 P0：先冻结重跑与 provenance 契约

**做：** 永久放弃“按完全相同命令串拦截”作为正确性机制；保留无阻断告知、首次 artifact 指针和结构化 `rerunOf`。保留现有 heuristic 只作为 host fallback，并将 unknown/冲突显式化。

**验收：**

- deterministic tool fixture 证明第二次调用执行且带首次 digest/round/locator；
- 缺 archive、stale digest、truncated archive 分别返回可辨识状态；
- guard 关闭时最终结果明确是 skipped/unverified，不被测试当作 verified；
- 不同 shell 包装和合法第二次生成均不被阻断；
- 无 credential 进入告知、stub 或结构化 state。

**回滚点：** 保留旧 boolean 字段和旧读取逻辑；通过 feature flag 回到旧提示输出，但不恢复拦截为默认正确性机制。

### F.2 P1：实现精确取货（先于任何摘要）

**做：** 新增对象式 bounded recall；file/memory store 源头支持 `limit/cursor/maxBytes` 和明确状态；现有位置参数保持适配。补齐 navigation 的 version/source/status 字段，但不做语义索引。

**验收：**

- fake store 断言读取本身不超过 `maxBytes`，不是上游全量读取后截断；
- cursor 续取、参数变化拒绝、sourceVersion 变化 stale；
- 缺失轮次/损坏 artifact 为 unrecoverable，权限/I/O 错误不变成 empty；
- 每个 item 带 round/kind/digest/locator，无法从导航直接得到事实值；
- 多次 Memento/fold 注入是替换，不增加正文和游标；
- legacy recall 测试继续通过。

**回滚点：** 关闭新 adapter/feature flag，旧 `recall(runId, from, to, pattern)` 和 `foldedPayload` 继续可读。

### F.3 P2：确定性 run state 与持久化

**做：** 先只实现 deterministic half、固定 marker、版本化 upsert、checkpoint/resume 读取和 hostFacts 的显式来源。不要在此阶段调用 LLM。

**验收：**

- 同一 stateVersion 重入只产生一份当前 state；
- resume 不重复注入、不重复触发 state task；
- artifact、工具足迹、预算、verification 与 transcript 的来源一致；
- 超预算时按固定降级顺序返回 truncated，不能静默丢掉唯一地址；
- legacy store/record 无 state 时仍可运行。

**回滚点：** 不注入 run state，只保留 store 中 additive 的 state 字段；旧 fold summary、`onAfterFold` 和 checkpoint 形状不变。

### F.4 P3：宿主可选语义半

**做：** 提供 `onStateCandidate` 或宿主异步 worker；严格 JSON schema、≤300 token 输出、`derived/conflict/stale/error` 状态和 sourceRefs；默认关闭，不进入 engine 正确性链。

**验收：**

- fake summarizer 返回正常、超长、非法 JSON、旧版本和与确定半冲突五类夹具；
- 超长不重试、不膨胀；非法/冲突只标记 derived/conflict，不覆盖确定半；
- 失败保留确定半，resume 后不重复调用同一 inputStateVersion；
- 删除语义块后，事实来源和精确取货仍可工作；
- 只比较成本/延迟/召回效率，不把“摘要看起来合理”当 correctness 证据。

**回滚点：** 关闭 semantic hook，继续注入 deterministic half；不删除字段、不改变旧 summary。

### F.5 P4：消费者契约与受控评测

**做：** 宿主明确哪些 profile 将 `unverified/unrecoverable` 交人工、重试或失败；决定是否暴露 recall tool。只有确定性测试和 3–5 次可区分 pilot 证明需要时，才考虑模型评测。

**验收：**

- T1：终稿值只能与首次 artifact digest 相符，或明确 unrecoverable；
- T2：决定/理由若来自摘要，必须带 sourceRef 且标 derived；
- T3：显式约束仍在 deterministic/精确取货路径可恢复；
- T4：不可恢复时 fail-closed，不编造；
- profile 的 token、调用数、延迟和 retrieval 状态有独立记录。

**回滚点：** 关闭 semantic profile/recall schema，保留 deterministic archive 与兼容 API。

### F.6 永久放弃或明确后置的内容

- **永久放弃：** 用完全相同命令串拦截来承担正确性；用模型提示/notes 作为事实来源；把 navigation/index 当作真相；从任意 shell 文本自动抽取决定/约束并写入 verified 字段。
- **后置：** 默认开启语义摘要、每轮同步反思、自动删除 notes、跨 run LTM/episode、profile 默认切换。它们必须等 P1–P3 的确定性契约和成本数据稳定后，由宿主单独决策。

## 最终摘要

四项范围修订方向是可行的，但不能按“撤销拦截 = 风险已解决”或“摘要带地址 = 可当真相”落地。正确顺序是：先把重跑变成可审计的非阻断 provenance 事件，再做源头有界精确取货，然后做可恢复、可替换的确定性 run state，最后才允许宿主选择性增加带来源的语义半。当前 `boundedNavigationRecord` 已过机械基线，但缺版本、失效、invocation 关联和 cursor；它是导航，不是取货完成证明。

本评估确认：没有运行 `bin/cli.js chat`、没有运行 `scripts/*experiment*.mjs`、没有发起任何模型或 relay 调用。
