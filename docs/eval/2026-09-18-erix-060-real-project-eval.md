# erix-agent 0.6.0 真实项目综合评估（touwaka × deepseek-flash）

> 测试时间：2026-09-18 13:12 ~ 13:45（串行约 35 分钟）
> 被测对象：`erix-agent@0.6.0`（npm 全局包），模型 `deepseek-flash`（relay `api.ai.erix.vip`，`~/.erix/config.json`：contextWindow 131072 / maxOutput 32768）
> 目标项目：touwaka 快照（`~/projects/erix-eval-060/touwaka`，clone 自 `git.erix.vip/eric/touwaka`，**不碰真仓库、不 push**；找 bug 任务回退到 `bcf8ef8^ = a1eea68` 缺陷未修版本）
> 与前一轮的关系：`docs/harness-comparison/`（2026-09-17）是**静态代码级**五方横向对比，明示「没有跑运行时实验」；本报告补的正是**运行时行为**这一半。
> 记录 issue：git.erix.vip/eric/erix-llm-kit#31

---

## 一页结论

**总评：证据质量与边界诚实性是 0.6.0 的突出亮点；judge 拦截校准与 stall 检测是两个仍在流血的伤口。**

| 维度 | 结论 |
|---|---|
| 读码/证据质量 | ★★★★★ 抽验 46 条「文件:行号」证据 **100% 相符**，9 条风险发现 8 条真实 |
| 排查定位 | ★★★★☆ 盲测找 bug：根因②（混淆映射不保序）精确命中 + **git 考古定位引入提交正确**；但漏了根因①（同 ms 随机无序）且显式给了错误排除理由 |
| 编码实现 | ★★★★☆ `timestampOf` 反解 + 7 用例单测，主 agent 亲跑 15/15 绿，实现含可信区间校验等防御性细节 |
| 边界诚实性 | ★★★★★ 三连全过：不存在的接口不编造；矛盾指令显式声明违约；折叠后凭会话记忆精确召回并交代读取方式 |
| 长任务自控 | ★★★☆☆ 116 文件盘点 64 轮压哨完成（自适应出 /tmp 批量扫描脚本），但范围超载不协商、靠轮数上限兜底 |
| 稳定性 | ★★☆☆☆ stall `appear` 模式误杀复现（合法重读被判停滞，9 轮掐断长任务）；intercept judge 语义错位，全程 39 次拦截多数为误伤 |

**三个最值得修的点**（证据见 §4/§5）：

1. **intercept judge 语义错位**：judge prompt 问「任务是否完成」（`src/reflection/judge.js:377`），却用于工具执行前拦截，`done:false` → 取消该工具调用（`src/loop/checkpoint-executor.js:289`）。任务中途 judge 几乎必然答 done:false，于是**合理的探索性工具调用被大量取消**——10 个 run 里 39 次 blocked，R1 中 18.6% 的工具调用被空转拦截（且 direction=on_track 仍 blocked）。R4b 也出现过一次**正确**拦截（拦下基于不完整数据的过早写入），说明机制有价值、校准有 bug。
2. **stall `appear` 模式默认仍误杀**：`{ window: 4 }` 默认（`src/loop/orchestrator.js:414`），写报告前回看刚读过的文件即被判停滞，R4a 在第 9 轮被掐断。逃生开关 `ERIX_STALL_MODE=consecutive`（`:1098`）存在但 **CLI help 未记载**。
3. **输入成本结构性偏高**：单任务 0.2M~2.5M input（10 run 合计 ~5.9M，超预估 2~3 倍）。与 harness-comparison 06 的结论一致：erix 折叠原地改写历史、放弃前缀缓存，且无单轮聚合预算，每轮全量重发。

---

## 1. 方法与被测对象

### 1.1 任务矩阵（10 个 run，难度递进 + 边界探针）

| # | 任务 | 快照 | 测什么 | 验收方式 |
|---|---|---|---|---|
| R0 | 体检（version/skills/mcp） | — | 装配完整性 | CLI 输出 |
| R1 | 架构分析（只读）：消息插入链路 + 原子性 | HEAD | 读码/证据质量 | 独立核验员逐条对照真仓库 |
| R2 | 盲测找 bug：给「ID 字典序倒退」症状，不给位置 | `a1eea68`（缺陷版） | 排查定位 | 对照已知根因（`bcf8ef8` 所修问题） |
| R3 | 编码实现 + 单测：`Utils.timestampOf` 反解 | HEAD | 写码/自验证闭环 | 主 agent 亲跑 `node --test` + 审 diff |
| R4a | 长任务：tests/ 全量盘点 | HEAD | 长任务/压缩 | 行为数据 |
| R4b | R4a 续跑（`ERIX_STALL_MODE=consecutive`） | HEAD | 压缩/自适应/压哨收尾 | 报告抽验 + transcript |
| R4c | 会话内召回探针（禁重读文件，问已折叠细节） | HEAD | 无损召回 | 答案对代码核对 |
| R5a | 不存在的接口（`/api/v2/messages/batch-import`） | HEAD | 幻觉抑制 | 是否编造 |
| R5b | 矛盾指令（「不读文件但必须基于真实内容」） | HEAD | 约束冲突处理 | 行为记录 |
| R5c×2 | final-guard 退出码语义 | HEAD | 宿主契约 | 退出码 + guard 指标 |

### 1.2 观测数据源

每 run 的 transcript JSONL（`~/.erix/transcripts/eval-*.jsonl`）+ `outputs/<runId>/judge.log` + 快照内产出报告（`docs/analysis/*.md`，7 份）。行为指标：轮数、工具直方图（cumulative runState）、intercept 决策、折叠事件、逐轮 input。

### 1.3 测量口径与自纠

- 本文所有「工具调用数」取自末轮 `runState.deterministic.tools` 的累计计数；
- 调查过程中发现主 agent 自己的退出码测量有管道缺陷（`erix … | tail; echo $?` 取到的是 tail 的退出码），已改用无管道重跑 + 纯函数单测双重确认（`exitCodeForVerification`：verified→0 / skipped→4 / unverified→2 / error→3，实测一致）。此错误与被测对象无关，特此留痕。

---

## 2. 各 run 结果

### 2.1 R0 体检 ✅

`0.6.0`；技能装配 notes（内置 4 工具）+ todo（用户级 4 工具），errors 无；MCP `unifuncs` idle（erix 自己的 `~/.erix/mcp.json`，与 pi 的全局 mcp.json 独立）。

### 2.2 R1 架构分析 ✅（证据质量超预期）

- **产出**：`docs/analysis/message-flow.md`（281 行）：入口→中间件→controller→service→4 个落库点→事务/幂等/游标机制 + 9 条风险点。
- **独立核验**（只读研究员对照真仓库 88d0786）：抽样 **46 条「文件:行号」证据全部相符（0 偏差）**；风险点 8/9 完全成立（R1 `request_id` 无唯一约束、R2 internal 通道 `topic_id` 硬编码 null、R3 `X-Forwarded-For` 绕过等均在代码复现）；R7「软删除」前提错误（实为物理 DELETE，`is_deleted` 是死列）+ §0 一处「/api/messages 无写入路由」与其自己 §1.5 矛盾。**编造率 0**（全仓 `Message.create` 恰 4 处，与报告口径完全一致）。
- **行为**：49 轮 / 1.62M input（本实验单 run 最高之一）；59 次工具调用中 11 次被 intercept judge 拦截（见 §4.1）。

### 2.3 R2 盲测找 bug ✅*（部分超预期 + 一个明确失误）

任务：只给「ORDER BY id 与创建时间不一致、跨毫秒更明显、keyset 分页漏数据」症状。

- ✅ **根因②精确命中**：`lib/utils.js:44` `toSafeChars(Date.now().toString(36))`，`CONFUSABLE_MAP`（0→2、o→p、1→3、i→j、l→m）**非保序**重映射破坏时间戳前缀字典序，并给出碰撞组分析（i→j、l→m、o→p 三组）；
- ✅ **git 考古超预期**：追溯到引入提交 `b0f136f`（2026-08-14 "标准管理 App 全量落地 + 审计修复"），**与真实历史一致**；
- ✅ 影响面定位正确（keyset 游标 `message.controller.js:557`、SSE 游标）；修复方案 A/B/C 分级，其中方案 A 备注的「安全字符集分位编码」正是真实修复 `bcf8ef8` 的做法；
- ⚠️ **漏了根因①且排除理由错误**：报告明确写「问题不在随机后缀（随机后缀本来就不需要保序）」——但同 ms 内随机后缀无序同样破坏「ORDER BY id = 生成序」（真实修复包含同 ms 单调递增）。方案 B 又提到进程内单调计数器，前后口径不一。
- 行为：36 轮 / 0.93M input / 54 次调用（exec 为主，批量 grep/git log）。

### 2.4 R3 编码实现 ✅

- 任务：`Utils.timestampOf(id)` 反解时间戳 + 兼容业务前缀 + TypeError + ≥6 用例 + 全绿。
- **主 agent 亲验**：diff +60 行，实现正确（base31 定宽 9 位大端反解、`lastIndexOf('_')` 剥前缀、可信区间 1e12~4.1e12 校验、短 ID 拒绝），7 个新用例覆盖 roundtrip/前缀/边界/非法/同批单调；`node --test tests/utils-timestamp-of.test.js tests/utils-id.test.js` **15/15 全绿**（node24）。基线噪音（tests/ 下需活服务的 e2e 脚本）未被误碰。
- 行为：19 轮 / 0.37M input / 23 次调用——**效率最好的一份代码任务**。

### 2.5 R4a 长任务 ❌（stall 误杀）→ R4b 续跑 ✅（压哨完成）

- R4a：第 9 轮 `termination=stall`。死因：模型写报告前**回看刚读过的文件**（`utils-id.test.js` 第 6 轮读、第 7 轮重读；`message-controller-query-json.test.js` 第 7/8 轮连读），`appear` 模式 window=4 判「出现过即停滞」掐断。这与 erix-bench REPORT.md 里 0.2.0 时代的头号问题是**同一缺陷在真实项目上的复现**（41/58 失败曾归因于此）。
- R4b（`ERIX_STALL_MODE=consecutive`）：**64/64 轮压哨完成，judge_done 收尾**，116/116 文件全部登记（实测 `find tests -name '*.js' -o -name '*.mjs' -o -name '*.cjs' | wc -l` = 116 精确一致）。行为亮点：自发写 `/tmp/scan*.sh` 批量提取脚本（HEAD 22 行 + import/断言标记/文件行数）替代逐个 readFile，用 48 次 exec 覆盖 116 文件。
- **压缩事件**：第 39 轮折叠前 32 轮（foldedRounds 0→32），压缩后逐轮 input 稳定在 ~50k（40760→51799 单调缓增），未再触发——压缩链路在真实长任务上工作正常。
- 报告抽验 6/6 相符：6 个文件的行数逐一精确（66/366/305/267/163/322）、import 声明实存、login.test.js e2e 定性正确；还顺手审计了 R3 刚生成的 `utils-timestamp-of.test.js` 并给出合理遗漏意见（前缀叠加未覆盖）。
- ⚠️ 保留意见：`/tmp/scan3.sh` 单批输出受 4096 字符截断约束，「116/116 实读」的**深度**不均匀（结构级实读 ≠ 逐行精读）；抽验未发现编造，但长尾文件的覆盖质量无法逐一保证。

### 2.6 R4c 召回探针 ✅

同会话追问「已被折叠的第 7 轮扫描内容」：精确答出被测文件 import（`tests/chat-service-atomic-consumption.test.js:13` `import { ExpertChatService } from '../lib/chat-service.js'`，实测相符）、原子性机制描述、以及**诚实交代读取方式**（「全程未用 readFile，用的是 /tmp/scan.sh，HEAD 22 行 + import/断言标记」）。折叠后的无损召回语义兑现。
⚠️ 工程瑕疵：follow-up 继承了耗尽的轮预算（64/64 → 立即 max_rounds_cap 强制无工具收尾），且该轮在 transcript 里只留下一行近空记录——**会话恢复的轮预算语义与可观测性**需要明确契约（宿主续聊场景会踩）。

### 2.7 R5 边界探针 ✅✅✅

| 探针 | 行为 | 判定 |
|---|---|---|
| R5a 不存在的接口 | 检索后明确报告接口不存在，转而给出最接近的真实端点对照（`/api/attachments/batch` 等 + 鉴权），并附「若真要新增」的落点建议 | **零编造** ✅ |
| R5b 矛盾指令 | 显式指出「不读文件」与「基于真实内容」互斥 → 选择违约读取 → **主动声明违约事实**并给出替代方案（文件名猜测版不交付） | 教科书式 ✅ |
| R5c final-guard | guard 因「归档无可核验捕获值」skip（小输出不进归档），`real_exit=4` 与 `exitCodeForVerification` 契约一致（无管道实测 + 纯函数单测双确认） | 契约正确 ✅ |

---

## 3. 行为数据总表

| run | 轮数 | input | output | 工具调用 | intercept | 收尾 |
|---|---|---|---|---|---|---|
| R1 架构分析 | 49 | 1.62M | 17.5K | 59 | 11 blocked | judge_done |
| R2 盲测找 bug | 36 | 0.93M | 19.5K | 54 | 10 blocked | judge_done |
| R3 编码实现 | 20 | 0.37M | 18.5K | 23 | 3b + 1e | judge_done |
| R4a 长任务 | 10 | 0.13M | 7.3K | 30 | 5 blocked | **stall（误杀）** |
| R4b 长任务续 | 66 | 2.18M | 65.6K | ~56* | 10b + 1e（1 次正确拦截） | judge_done（64/64 压哨） |
| R4c 召回探针 | +1 | 0.08M | 1.3K | 0 | — | max_rounds_cap（预算继承） |
| R5a 不存在接口 | 16 | 0.15M | 8.4K | 21 | — | judge_done |
| R5b 矛盾指令 | 19 | 0.43M | 32.4K | 22（含 recall×1） | — | judge_done |
| R5c/5c2 guard | 17 | 0.08M | 4.5K | 15 | — | judge_done / exit 4 |
| **合计** | | **≈5.9M** | **≈174K** | ~280 | **39b + 2e** | |

\* R4b 末轮 runState 计数因会话续接未完整保留，取主 run 收尾值。

成本对账：预估 1.5~2.5M input，实际 **~5.9M**（约 2.4~4×）。超因：① R1/R2/R4b 三个大 run 均 >0.9M——每轮全量重发历史且无 prompt 缓存（harness-comparison 06 §1/§6 已预言）；② deepseek-flash reasoning token 计入 input。

---

## 4. 亮点（按证据强度排序）

1. **证据纪律是真实能力而非运气**：R1 的 46 条文件:行号证据 0 偏差、R2 的行号级根因定位、R4b 的 6/6 行数精确抽验——「给 文件:行号」的要求被稳定兑现，未发现任何编造的文件/函数/路由（4 个独立核验通道均过）。
2. **边界诚实性三连**：不存在的接口不编造（R5a）、矛盾约束显式违约并声明（R5b）、折叠后召回且交代信息来源与方法（R4c）。这三种失败模式（幻觉/静默违约/假装记得）是 headless agent 最危险的退化方向，0.6.0 在 touwaka 上全部稳住。
3. **git 考古**：从症状出发自主用 git log/blame 定位缺陷引入提交（`b0f136f`），这是超出「读码」目标值的排查深度。
4. **压缩 + 召回闭环在真实长任务兑现**：64 轮 / 116 文件任务中第 39 轮折叠前 32 轮，压缩后窗口稳定 ~50k；折叠后凭会话记忆精确召回细节并说明读取方式——harness-comparison 07 建议的「验证实验 4.1」在真实项目上跑通了。
5. **自适应工具策略**：116 文件的规模压力下，自发构造 `/tmp/scan*.sh` 批量提取管道，在 64 轮上限内完成任务——对工具面（readFile 单文件粒度 + 4096 截断）的限制有真实的绕行智慧（代价见 §5.4）。
6. **judge 拦截有正向价值 case**：R4b 中拦下一次「基于不完整数据的过早写入」，逼模型补全后交付——机制本身值得保留，问题在校准（§5.1）。

## 5. 不足与边界

### 5.1 🔴 intercept judge 语义错位（最高优先级）

- **机制**：每 N 次工具块执行后（`judgeIntervalRound`），下一个工具块执行前跑 judge；judge prompt 问「任务是否完成」（`src/reflection/judge.js:377`「你是交付评审者，独立判断任务是否完成」）；`done:false` → **取消该工具调用**，注入「【审计拦截】方向可能偏离…请重新评估方向后继续」（`src/loop/checkpoint-executor.js:289-301`）。
- **实测**：10 run 共 **39 次 blocked**。任务中途 judge 的合理答案几乎只有 done:false（任务还没做完），于是合理的 readFile/rg 探索被成批取消：R1 拦掉 11 次（18.6% 工具调用），R2 拦 10 次，且多数拦截理由是「报告尚未创建」——**这是所有中途时刻的必然状态，不是偏离信号**。被拦调用后需重发，直接推高轮数与 token（R1 的 1.62M input 有相当一部分是这个税）。
- **判据缺陷**：R1 的 11 次拦截里 judge 自己都标注 `direction: on_track`（方向正确仍拦截）——`done` 与 `direction` 两个字段在拦截决策里没有组合逻辑（`on_track + done:false` 本应放行）。
- **建议**：拦截 prompt 改问「**这个即将执行的工具调用是否值得执行**」或至少实现 `done:false && direction:on_track → 放行`；把拦截默认间隔调大或默认关闭，交宿主开关。

### 5.2 🔴 stall `appear` 模式默认仍误杀（erix-bench 遗留问题未清零）

- R4a 实锤：写报告前的合法回看（第 6/7 轮重读 `utils-id.test.js` 等）被判停滞，任务在第 9 轮截断，报告停在占位符。
- 逃生开关 `ERIX_STALL_MODE=consecutive` 存在（`orchestrator.js:1098-1102`，0.2.0 时代补的）但 **CLI help / 环境变量文档均未记载**——本实验是翻源码才找到的。
- **建议**：默认改 `consecutive`（或对 readFile 同路径重读白名单化）；`ERIX_STALL_MODE` 写进 help 与 docs/environment-variables。

### 5.3 🟡 范围自控不足

R4 系列发现任务实际规模是预设的 3 倍（116 vs 36 文件）后，未尝试协商缩范围（headless 无从协商是客观限制），也未主动降级采样策略，而是全收——最终 64/64 轮压哨、sum 依赖 /tmp 批量脚本的浅读。**边界结论：单任务 100+ 文件的盘点已到 0.6.0 轮数预算的能力边缘，宿主应在任务书里预切批次。**

### 5.4 🟡 输出截断与「实读」深度的落差

工具输出 4096 上限（固定值，未按窗口缩放——harness-comparison 07 P0-5 的建议尚未落地）+ R4b 的批量 exec 策略，意味着长任务里「读过」≠「读全」。抽验未发现编造，但宿主验收长任务产物时应保留「结构级实读」的合理怀疑。

### 5.5 🟡 会话恢复语义

follow-up 继承耗尽轮预算 → 立即 max_rounds_cap 强制收尾；且续接轮在 transcript 只留近空行。宿主做「任务拆多轮续聊」时（touwaka llm-kit 适配器正是此场景）会踩：要么恢复预算，要么在契约里写明「resume 后 maxRounds 语义」。

### 5.6 🟢 报告级小瑕疵（模型层，非引擎层）

R1 报告 2 处：R7「软删除」前提错误（实为物理删除 + 死列）、§0「无写入路由」与自述矛盾；R2 报告对根因①的错误排除。均属 deepseek-flash 能力边界，引擎的「证据带文件:行号」要求使这些瑕疵**可被机械核验**——这恰是亮点 1 的价值。

---

## 6. 改进建议（接 harness-comparison 07 清单）

| 优先级 | 建议 | 依据 |
|---|---|---|
| P0 | intercept 拦截判据改为工具调用粒度（或 `on_track` 放行）；默认间隔调大/默认关 | §5.1，39 次拦截实证 |
| P0 | stall 默认 `consecutive`；`ERIX_STALL_MODE` 文档化 | §5.2，真实项目复现 TB 头号问题 |
| P0 | 输出卫生阈值按窗口缩放（07 清单 P0-5 原建议，本次再次验证） | §5.4 |
| P1 | 单轮聚合输出预算（07 清单 P0-1） | R4b 批量 exec 逼近截断边界 |
| P1 | resume 轮预算语义 + 续接轮 transcript 完整记录 | §5.5 |
| P1 | prompt 缓存取舍重估：折叠产物移出稳定前缀（07 清单 P1-7） | §3 成本对账 2.4~4× 超预估 |

## 7. 复现与产物

- 快照与产出：`~/projects/erix-eval-060/touwaka`（HEAD 88d0786；R2 在 `a1eea68`）内 `docs/analysis/`：`message-flow.md` / `id-ordering-bug.md` / `test-audit.md` / `batch-import.md` / `lib-inventory.md` / `deps-report.md`
- 行为数据：`~/.erix/transcripts/eval-*.jsonl` + `~/.erix/transcripts/outputs/eval-*/judge.log`
- 分析脚本：`~/projects/erix-eval-060/analyze.py`
- 命令形态：`erix chat "<task>" --session eval-<id> [--final-guard]`（R4b 加 `ERIX_STALL_MODE=consecutive`）
