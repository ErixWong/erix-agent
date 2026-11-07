## 取证边界

- 仓库根目录为 `/home/eric/copilot-sbx/rv772`；HEAD 为 detached `cb463b0502fd39f73b40cf435eaa82598827a154`，基点 `762ef52`，`git rev-list --count 762ef52..HEAD` 实测 12 笔提交。初始工作树干净。
- 直接打开了两份 host-consumer contract、`src/loop/orchestrator.js`、`src/loop/resume-manager.js`、`bin/final-guard-support.js`、`scripts/docs-drift-check.mjs`、`test/contract-snapshot-cell-axes-767.test.js`、`test/static-guards.test.js`、`package.json` 和 `docs/maintenance/command-reference.md` 的相关段落。
- 没有打开 `REPORT-772.md` / `REPORT-s1.md`、完整的 CI workflow、完整仓库源码或全部被表引用的测试文件；不把已有报告中的结论当本次证据。未运行 `npm test` 全套或 `--self-test`。
- 所有表格/标记实验只临时改了契约文档；每次之后均执行 `git checkout -- .`，恢复结果由空的 `git status --short` / `git diff` 核实。最终只新增本报告。

## 1. 契约表内容真伪

抽查四格，写轴和恢复侧读轴均与实现相符：

| 格 | 实际代码与契约判断 |
|---|---|
| `messages`（EN `docs/host-consumer-contract.md:2359`；CN `docs/host-consumer-contract_cn.md:1911`） | 写侧 `src/loop/orchestrator.js:2977-2979` 把残余起点前的项变成 `null`，载荷在 `:3029` 写入残余数组，故为 `residue`。恢复侧 `src/loop/resume-manager.js:586-589` 只在账本消息数等于 anchor 且快照正文更长时补读，符合旧格式账本的 `fallback`。 |
| `partialText`（EN `docs/host-consumer-contract.md:2362`；CN `docs/host-consumer-contract_cn.md:1914`） | `src/loop/orchestrator.js:3039` 只在值非 `undefined` 时同时展开 `partialText` / `partialRound`；恢复侧在 `src/loop/resume-manager.js:634-635` 读取，故为条件写入 / `source`。 |
| `toolOutputs`（EN `docs/host-consumer-contract.md:2358`；CN `docs/host-consumer-contract_cn.md:1910`） | 快照写点是 `src/loop/orchestrator.js:3037`，恢复回填在 `src/loop/resume-manager.js:667-672`。终稿 guard 的 `record.toolOutputs` 来源则是轮记录：`bin/final-guard-support.js:218,237-240`；这与表中区分快照副本和轮记录副本一致。 |
| `compactionStats`（EN `docs/host-consumer-contract.md:2366`；CN `docs/host-consumer-contract_cn.md:1918`） | 快照写在 `src/loop/orchestrator.js:3038`，轮记录另写在 `src/loop/orchestrator.js:6160-6162`；恢复侧在 `src/loop/resume-manager.js:346` 从 `deterministic.compactionStats` 取值，并未读取快照格，故该格的 read 轴为 `not-source`。 |

命令：`node --test test/contract-snapshot-cell-axes-767.test.js test/loop-snapshot-write-side-735.test.js`；退出码 **0**（16/16）。本次抽查未发现这四格轴值与运行时代码相反。

## 2. EN/CN 信息对齐

命令：`node --input-type=module`（一次性脚本分别读取标记区、计数并比较行序和轴）；退出码 **0**。实测 EN、CN 各 **15** 条数据行、各 **14** 个不同键名；唯一重复键是拆成盘上格/进程内格的 `persistedTranscriptLength`。两份键名顺序、write 轴及 read 轴（将本地化的 fallback 条件归一化后）均一致。write 轴计数为 `written=10`、`written(conditional)=2`、`residue=1`、`stopped=2`；read 轴为 `source=8`、`fallback=2`、`not-source=5`。

逐格对照了条件句：`pendingToolUse` 的缺席 fallback、`messages` 的旧格式账本条件、`partialText` 的非 `undefined` 条件、`partialRound` 与其同写条件，以及两个 stopped 格和 `compactionStats` 的交接条件，中英文语义相符。自动化的 G5 只比键序及轴值，不比条件/交接散文；这部分是本次人工核对，不是测试保证。

## 3. 标记区豁免实验

- 将 EN 的 begin 标记上移到无关 `Derived values` 的 `retry` 表（`docs/host-consumer-contract.md:2003`）之前、end 仍留在载荷表之后。`npm run check:docs` 退出码 **0**；`node scripts/docs-drift-check.mjs --verbose` 退出码 **0**。verbose 读数从正常树的 **72** 处标记豁免变为 **73**，裸行号唯一键仍为 **82**，棘轮计数从 **6** 降为 **5**（基线 6）：位置扩大确实会多豁免一行号，普通 docs gate 仍报 OK。
- 同一改动下，`node --test test/contract-snapshot-cell-axes-767.test.js` 退出码 **1**：表加载器先读到无关表头，报 `3 !== 7`。因此，这种把标记包住普通三列表的移动不会通过专用契约测试，但 `check:docs` 单独不会拦。
- 删除 EN/CN 两份文档的 begin/end 标记后，`npm run check:docs` 退出码 **1**：裸行号实测 **78**，高于基线 **6**。删除标记会红。

## 4. G4 逐条复核是否够硬

**不够硬，属合并阻断项。** `test/contract-snapshot-cell-axes-767.test.js:557-559,584-586` 的 `G4_KEY_NAME_CHECK` 只对源码原始行做键名词面匹配，不检查该行是否执行了对应读写；注释和无关语义也能匹配。实测把 EN 表 `compactionStats` 写点从 `src/loop/orchestrator.js:3038` 临时改成 `:3015`。源码 `:3015` 实际是注释，讲 `compactionStats` 的 checkpoint 测试读取，不是快照写入；但 `node --test test/contract-snapshot-cell-axes-767.test.js` 仍退出码 **0**（9/9）。这正是“行里提到 key、语义无关”的反例。`scripts/docs-drift-check.mjs:2843-2853` 仅以正则确认 G4 名称、函数形状和断言调用在场，也不能补足语义判断。

## 5. `src/` / `bin/` 范围

命令：`git diff --name-only 762ef52..HEAD`；退出码 **0**，本次树实测 12 个变更文件：`AGENTS.md`、`AGENTS_cn.md`、`CHANGELOG.md`、`REPORT-772.md`、`REPORT-s1.md`、两份 host-consumer contract、两份 maintenance command reference、`scripts/docs-drift-check.mjs`、`test/contract-snapshot-cell-axes-767.test.js`、`test/static-guards.test.js`。命令 `git diff --name-only 762ef52..HEAD -- src bin` 退出码 **0** 且无输出；没有 `src/` 或 `bin/` 运行时文件改动，未发现该切片触碰运行时边界。

## 6. 派生值与本次门禁

- `scripts/docs-drift-check.mjs:2726` 的 `BARE_LINE_REF_BASELINE` 实测仍为 **6**；干净树 verbose 报唯一引用 **82**、标记区豁免 **72**，棘轮实测 **6 vs 6**。
- `test/static-guards.test.js:4451` 的 `CHANGELOG_PAIR_FLOOR` 为 **25**。`node --test test/static-guards.test.js` 退出码 **0**（56/56）；守卫本轮输出中英各 **25** 条、配对 **25**、地板 **25**，删除一条后 **24**，确实穿底；不是 24 或 26。
- `scripts/docs-drift-check.mjs:2589` 的 `SYMBOL_ANCHOR_MIN_UNIQUE` 为 **238**。干净树 `node scripts/docs-drift-check.mjs --verbose` 退出码 **0**，实测唯一锚点组 **238**，闸接受该值。另有一条未同步的说明文字：同文件 `:55` 仍写 `SYMBOL_ANCHOR_MIN_UNIQUE = 235`，见 follow-up。
- 其余本次实跑命令及退出码：`npm run check:docs` **0**；`npm run check:docs:strict` **0**；`npm run check:docs-spelling` **0**；`npm run check:docs-examples` **0**（66/66）；`npm run check:syntax` **0**（493 个跟踪 `.js/.mjs/.cjs` 文件）；`npm run check:agents-directives` **0**；`npm run check:changelog` **0**；基线 snapshot / write-side 测试如第 1 节为 **0**（16/16）。

## 7. 裁决

**必须改后合。**

**Mandatory**

- `test/contract-snapshot-cell-axes-767.test.js:557-559,584-586`：G4 接受 `compactionStats` 写点指向 `src/loop/orchestrator.js:3015` 的无关注释（该变异下测试退出码 0）。加强成验证引用行的实际操作/角色，而非仅验证词面；加入这条变异的反向测试。可跑判据：错误引用必须使 `node --test test/contract-snapshot-cell-axes-767.test.js` 非零；正确引用仍须通过。修复前不可合。

**Follow-up（可另开单）**

- `scripts/docs-drift-check.mjs:2831-2843,2902`：标记豁免只要求标记区内 pipe 开头的行；实际上移 begin 后 `check:docs` 仍退出 0、豁免数增加。专用契约测试拦住了本次普通三列表移动（退出 1），但可让 docs-drift 本身校验标记区恰好包住唯一载荷表。可跑判据：重复上移 begin 的实验时，`npm run check:docs` 本身应退出非零；原始树仍为零。
- `scripts/docs-drift-check.mjs:55,2589`：说明文本 235 与当前闸值/实测 238 冲突。把 235 改成现值或明确标成历史读数。可跑判据：`node scripts/docs-drift-check.mjs --verbose` 仍报唯一组 238、退出 0，且该行不再作为现值声称 235。
- `test/contract-snapshot-cell-axes-767.test.js:45,136,145`：注释、G1 名称和断言消息仍说“10 格/10 个”，但本次实测为 14 个不同键名。更新文字，避免误报覆盖面。可跑判据：targeted snapshot 测试仍通过，测试名称/失败消息明确 14 个唯一键。
- 两份 contract 的表头 `docs/host-consumer-contract.md:2350` / `docs/host-consumer-contract_cn.md:1902` 称“write site”，但 stopped 格引用 `src/loop/orchestrator.js:2997,3004` 是解释缺席的注释而非可执行写点；stopped 轴本身经 G2 与 `loop-snapshot-write-side-735` 测试验证为真。可改表头为“写入位置/停写证据”或为 stopped 格直接引用缺席断言。可跑判据：`node --test test/contract-snapshot-cell-axes-767.test.js test/loop-snapshot-write-side-735.test.js` 仍为 16/16。

## 未验证

- 未运行 `npm test` 全套，也未运行 `node scripts/docs-drift-check.mjs --self-test`；未从头逐条人工审阅全部 14 个不同键的每条引用。当前结论限于四格源码抽查、两轴表解析、专用测试与上述反向实验。
- 未核验完整 CI workflow 是否以所需顺序执行这些门禁；本报告记录的是本机实际命令结果，不是 CI 结果。
