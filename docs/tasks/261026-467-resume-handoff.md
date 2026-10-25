# #467 收尾 + 待投递的指针评论（恢复运行第五段，2026-10-26）

上一段（第四段）崩在 `judge_done`——正是 #467 那条停机路径，**本段先勘验、不再重发有副作用的调用**。
预算只剩 2 轮，本段只落这份交接；下面 5 条评论**已核过「盘上/线上都还没发」**，草稿见 §3，下一段一条 `gh api` 即可投递。

## 1. 勘验事实（本段全部当场重测，不引上一段的账）

| 声称 | 实测 | 结果 |
|---|---|---|
| #467 修法在主干 | `git log --oneline origin/main -3` | ✅ `origin/main = b75ae6ba`（PR **#472** merged=true）；工作树 `src/loop/termination.js` 白名单 = `["max_rounds_cap","stall","continuation_exhausted","judge_done"]` |
| 发版了吗 | `npm view erix-agent version` | ❌ **0.25.0** = 修法之前 ⇒ 现网仍会踩（**本段就是标本**：上一段停机 reason=`judge_done`） |
| 当前分支回归 | `npm test`（本段跑，log 在 `/tmp/npm-test-resume.log`） | ✅ 2228 tests / **2217 pass / 0 fail / 11 skip**（分支 `fix-261026-12-onfold-summary` @ `abd6bcba`） |
| 工作区 | `git status` | 干净；分支与 origin 同步；`test/tmp-repro-467*.test.js` 等临时件已不在盘上（`test/tmp-probe.test.js` 是既有的已跟踪文件） |
| issue 面 | `gh api issues/{n}` | #467 **closed**（2 条评论，末条＝第四段的 scope 终局）；#473 / #475 / #476 均 open；#462 closed；#464 / #465 / #469 / #470 open |
| PR 面 | `gh api pulls/{n}` | #472 **merged**；#468 **merged**；#471 / #474 **open**（base=main）；#477 **open**（base=`fix-261026-11-foldedfacts-trim`，stacked on #474） |
| 待投递评论是否已发 | `gh api issues/{n}/comments` | ❌ 都没发：#470 两条旧评（无 #474/#477 指针）、#462 四条（无「放宽那一格已兑现」）、#469 两条（无四条裁决）、#464 三条 / #465 一条（无「修复在 #471 等合并」这句状态） |

## 2. #467 的 scope 终局（口径，供回答用）

1. **问题成立**，且是**枚举漏项**而非「收尾没写」：`judge` 是 `isEndTurn` 轮的后置调用 ⇒ 模型先结束回合、引擎才问评审；`done:true` 拿走的是**第二次机会**。
2. **判据是「没被调用」而不是「没写」**：`hasFinalDraft()` 的三项里后两项与 `isEndTurn` 同式恒真 ⇒ 它在该路只等价于「正文非空吗」，恰好是想要的判据，但白名单把这条路挡在门外。
3. **落地面小**：一行白名单 + 注释 + 4 格测试（`test/loop-judge-done-forced-final.test.js`）+ 契约中英各一处 + 门禁锚点 130→132。收尾那一发 `tools: []` ⇒ 结构上开不出新轮，`rounds`/reason 不变、`forcedFinal` 一次性，逃生阀 `ERIX_NO_FORCED_FINAL=1`。
4. **触发面真实但窄**：真机同库 90 次 `judge_done` 里 **6 次**（≈6.7%）终局零正文；成本上界由 `hasFinalDraft()` 兜（90 次里挡掉 84 次）。
5. **未做且不该本单做**（已拆单）：B1 `end_turn`/`no_tool` 同一个洞 → **#475**；B2 收尾仍空正文 / 固定文案需 #323 marker → **#476**；B3 评审在空正文上判 `done:true` → **#473**。流式面不改。
6. **别混计**：这一行只修 payload 面，且把 6 次「空」变「非空一段话」⇒ 橡皮章 guard（`accept` 建在 `finalText` 非空上，契约 `S6a`）的假 `verified` 面**变大**，宿主验收必须读 `termination.forcedFinal`。
7. **闭环边界**：`origin/main` 起闭环；**npm 0.25.0 未含 ⇒ 现网未闭环**（本段标本为证）。

## 3. 待投递评论草稿（下一段直接发；数字都来自 §1/§4 实测）

- **#470（不 close，只挂指针）**：交付说明 + 指针 —— A1/B/C + 判据①② 在 PR **#474**（open，base `main`）；P1/P3（`onFoldSummary` 强制投递 + `context.maxFoldedFactsBytes` 旋钮）+ README/升级指南在 PR **#477**（open，base = #474 分支）。两个 PR 都**未合并发版**，故本单先挂指针不 close。
- **#462（closed 追加一句）**：「放宽那一格已兑现」——`0f695092` 上读侧对真实落盘形状（`buildFoldedFacts()` 的**平铺对象**）返回 `undefined` ⇒ 该格对真实账本永不触发；`6b12c269` 起读侧收平铺对象，同一输入返回 `origin:"strategy"`（`src/compact/resume-fold-trim.js:137`）。不留这句，网上的旧结论会一直误导人。
- **#469**：对我提的四条给裁决（①内部摘要调用关思考 ②输入上限/输出预算/容器上限同源 ③输入增量（依赖 #462）④三态失败不许静默）+ P4 排期。**这是要回答的一条，不是要写码的一条**；本站在 #469 之前故意不选 fold-llm。
- **#464 / #465（各一句）**：修复在 PR **#471**（open，base `main` `f489398e`，HEAD `36e7bd0d`），**等合并**——别让人以为还在做。

## 4. 数字更正（引用前必须改）

- ✅ 可引用：`test/loop-on-fold-summary.test.js` **8 格**（①投递 ②无替代物不调用 ③投递失败 ③rejected 不重试 ④assembly 形状校验 ④直接入口 ⑤旋钮夹断 ⑤非法值回默认）；`test/compact/folded-facts.test.js` **7 格**（#470-1/3/4/B/C + #462 两格，其一即「只有 `foldedFacts` 也按水位线裁正文，来源标 `strategy`」）；`test/loop-folded-facts-sliding-resume.test.js` **2 格**（判据①②+端到端）；`test/loop-resume-summary-history.test.js` **2 格**；`test/loop-judge-done-forced-final.test.js` **4 格**。全量 2217 pass / 0 fail。
- ⚠️ **「替代物 732 B」本仓查无出处**：`grep -rn 732 docs/tasks CHANGELOG docs/tasks/wip-470/npm-test.log` 只命中无关的 `duration_ms` 与用例编号。**引用前重测**（用 `buildFoldedFacts()` 的 `bytes` 字段，`src/compact/fold-summary-journal.js:198`；上界 `FOLDED_FACTS_MAX_BYTES`，测试只断言「≤ 上限」不锁具体值），或改引 #470 票面的 **849 字节**真机机械索引。
