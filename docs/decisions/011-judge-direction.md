# ADR-011：judge 方向评估（direction 软提示）——机制设计 + benchmark 实证

- 状态：已决策（2026-09-06）
- 相关：PR #28（透明劫持）、PR #29（judge 观测 + stall 软纠正 + direction 软提示）、Issue #27
- 实证：db-wal-recovery reward=1（88s/11轮，历史 run1 reward=0/721s）；circuit-fibsqrt run3（11 次拦截全记录）

## 背景：judge 只判交付物，抓不住方向漂移

透明劫持（PR #28）的 judge 在每次工具中途审计时，判断依据只有：任务目标、最近 12 轮时间线（工具调用+输出）、写过的文件、最近错误。它被要求"若方向错误 done 必须为 false"，但 **11 次拦截（circuit-fibsqrt run3）全是"交付物/验证输出"类**：

```
"gates.txt 文件内容不完整且格式错误"        ← 交付物
"gen2.py 在 emit 函数中语法错误崩溃"        ← 交付物
"输出恒为 32767 而非预期值"                 ← 交付物（验证输出）
```

而模型的**方向**确实错了（run3 深陷 isqrt digit-by-digit 40+ 轮反复调试同一实现细节），judge 却从未指出。原因：
- 时间线只有"工具动作 + 输出"，无"意图/计划"层——`exec python3 dbg_isqrt.py` 看起来像在合理推进
- "方向"是长程概念，单次审计只看最近 12 轮
- judge 无领域知识判断设计路线

## 决策 1：方向作为软提示层，永不硬拦

**代价结构决定**：方向误判代价 > 交付物误判。
- 交付物拦错：模型换个动作，无损
- 方向纠正错（告诉模型"方法错"但其实对）：模型放弃正确路径——run1 成功路径若被误判就毁

→ **违反"宁可漏判不可误杀"**。因此 direction 设计为：
- judge 输出扩展 `{"direction":"on_track"|"uncertain"|"off_track","directionReason":"..."}`
- direction **永不参与 stop/拦截/termination 判定**
- done:true + off_track → **执行原工具**（不拦），tool_result/独立消息附方向提示让模型自己考虑换路线
- done:false（交付物硬拦）语义完全不变

## 决策 2：提示不污染事实链

方向提示若拼进 tool_result.content，会被 buildTimeline 当真实工具输出 → 污染后续 judge 判断。修复：**独立 user text 消息**注入（模型可见，但不进 tool_use/tool_result 配对）。blocked/放行/resume 三路径都 flush，限 2 条/轮 + 200 字符防膨胀。

## 决策 3：judge-log 观测 + 脱敏（审计完整性）

- 每次 judge 决策（round/intercept/degraded）emit onJudge + 可选 --judge-log JSONL 落盘（默认不写）
- 脱敏：不落原始工具输入（token/密钥风险）；reason/evidence 复述凭据也内容级隐藏（CREDENTIAL_PATTERN：sk-/JWT/Bearer/ghp_/AWS/stripe/npm/Google 等）
- degraded 事件带 error 分类（parse/error/timeout）+ tool 信息

## 决策 4：stall 防空转软纠正（同源重构）

第一性原理：**空转只能相对任务目标定义**——签名重复≠空转（合法重跑验证命令/分段读文件都是重复签名）。机械检测（stall）无任务语义却做最高处置（throw 杀停）→ 误杀毁灭性（一次冗余重读报废整个任务，实测 circuit-fibsqrt run2 3 轮被杀）。

- stall 命中不再 throw：nudge 软纠正（"疑似重复调用，若无新目的请推进"）≤2 次
- 连续 3 次仍命中 → 正常 stop value:"stall" truncated:true（保留终稿，不丢）
- stallStreak 只在 stalled 累积、不同签名出现才清零（窗口清空不误清零）
- stallDetection:false 优先于 ERIX_STALL_MODE（显式关闭不被 env 重开）

## 实证（db-wal-recovery，direction 首验）

**reward=1（88s, 11轮）** vs 历史 run1 reward=0（721s 卡 apt/网络空转）。

judge.log 完整审计链（3 条全落盘可查）：
```
#1 intercept blocked + direction=off_track
   reason: 模型仅执行侦察操作（tree/ls/xxd/which），尚未修复 WAL，关键产物缺失
#2 intercept executed + direction=on_track
   reason: 已修复 WAL（XOR 0x42 解密 + checkpoint 合并 11 条）+ recovered.json 验证通过
#3 round judge_done + direction=on_track
   reason: 端到端验证通过
```

**direction 首验价值**：#1 off_track 在模型纯侦察阶段介入 → 提示后模型 round 4 起直接进入实际修复，不再空转。历史 run1 模型在 apt/网络侦察上耗 721s（无此机制）。

| 机制 | 证据 |
|---|---|
| direction off_track | #1 触发，模型转向（侦察→修复） |
| 透明劫持 blocked | #1 拦截无进展动作 |
| judge_done | #3 验证通过才收尾 |
| judge-log | 3 条决策全落盘（含 direction/脱敏） |
| stall 软纠正 | 0 误杀，11 轮干净完成 |
| 效率 | 88s vs 历史 721s（8 倍） |

## 诚实归因与边界

- reward 提升有模型运气成分（本次直接选了解密路线）——**但 direction 拦截贡献可观察**（#1 提示在纯侦察阶段介入引导转向）
- judge 判断质量高：正确区分"侦察阶段(off_track)"vs"修复推进(on_track)"vs"完成(judge_done)"
- **能力边界**：judge 拦得住"提交错误产物/侦察空转"，拦不住"模型能力不足"（circuit-fibsqrt run3 拦 11 次但模型始终没实现对——方向提示让模型换路线，但换的路线仍超出 flash 能力）
- judge 判断依赖验证输出——模型**自测幻觉**（输出错误常数 727447837 却 reasoning 写 "expected OK"）时 judge 的拦截是最后防线，但无法替代模型验证能力

## 后续

- 宿主持久化：touwaka #1116 / app_container #71（judge 决策链存宿主侧）
- judge 叙事链（每轮 reason/evidence 累积）供复盘——store 已含 record.judge
- harness 结果目录 run 序号已隔离（不覆盖历史），artifacts docker cp 误导问题已在 run3 后消除
