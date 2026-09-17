# 08 · erix 运行时实测（电池任务）——改进验证与回归

> 2026-09-17。补 01–07 静态对比的运行时缺口：用一个真实任务跑 erix（main，含 ADR-015/016），
> 验证本轮各项改进是否起作用，并回收优化点。codex / hermes 已完成接线验证
> （codex 0.154.0 + relay responses API；hermes venv + relay；均见 §4），运行时对比留后续。

## 1. 任务设计

沙箱 `/tmp/erix-battery`：`gen.sh`（205 行 filler + `TARGET=gold-4173` + 55 行 filler，
约 7KB 输出）+ `fill{1,2,3}.sh`（各 ~42KB 垃圾输出，用于推上下文）。单轮 prompt 驱动：
跑 gen.sh 记住 TARGET → 跑 3 个 fill → 只回答三行（值 / 来源 / 有无重跑 gen.sh）。
配置：`--final-guard --compact-budget 24000 --max-rounds 16`，模型 deepseek-flash（relay）。

## 2. 第一次运行：暴露 1 个 guard 误杀回归（已修，#124）

**时间线**：round 1 gen.sh（7.3KB 归档）→ rounds 3–5 三个 fill（42KB×3 全量入 toolOutputs）
→ round 7 模型给出**完全正确且诚实**的终稿（值对、来源真实、主动 `recall pattern=TARGET`
取回）→ **guard revise** → 模型恐慌绕路 8 轮（rg 翻 transcript 目录 160KB、python 解析
自己的 jsonl）→ 第二版终稿仍 unverified。总计 16 轮 / 220k input tokens。

**根因链**（两个独立缺陷叠加）：

1. **CJK 终止符缺失（误杀主因）**：attribution 值正则 `[^\s,，。；;（）()\]}]+` 漏了
   中文右引号。模型写 `「TARGET=gold-4173」`（中文排版常态），被抽成 `gold-4173」`
   → 与捕获值 `gold-4173` 不等 → 判"伪造"。judge 全程未参与（reflection off，
   judge.log 为空）——打回的是确定性正则代码，不是任何 LLM 的输出纪律问题。
2. **capturePointer 借用已退役语法**：revise 消息写"请读取 来源=归档:transcript:round=1:a3b735ea"。
   ADR-016 删了「来源=」要求，但指针还在用这个形态——模型按旧语义去文件系统找
   `a3b735ea` 这个 digest 字符串（它不是文件），白绕 8 轮。

**修复**（PR #124，736/0）：值终止符补 `」』】〉》"'、`；capturePointer 改为可执行配方
`归档输出 transcript:round=1:a3b735ea（用 recall({ pattern: "关键词" }) 取回原文核实）`；
revise 文案同步；3 条真实事故样本回归测试。

## 3. 第二次运行：全链路 verified

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 轮数 | 16 | **8** |
| input tokens | 220,944 | **59,295** |
| verdict | unverified（误杀） | **verified** |

## 4. 本轮改进逐项验证结论

| 改进 | 结论 | 证据 |
|---|---|---|
| 输出卫生（ADR-015） | ✅ 起作用 | 42KB×3 输出全量入 `toolOutputs`（字节保真），模型可见侧截 4096，上下文稳定 ~14k tokens——**折叠从未需要触发**（`--compact-budget 24000` 未被打穿是卫生机制在正确工作，不是 bug） |
| bounded recall | ✅ 起作用 | 两次运行模型都自主 `recall pattern=TARGET` 取回早期精确值 |
| ADR-016（重跑退役） | ✅ 起作用 | 无重跑警示、无 replayable 噪音；两次运行模型都没重跑 gen.sh，终稿如实报告 |
| 显式 notes | ✅ 可用 | 第一次运行模型用 note_read 交叉核对值 |
| guard fail-closed | ✅ 方向正确 | 没有静默放过可疑终稿；但误杀暴露解析器宽容度问题（已修） |
| judge.log | ✅ 符合预期 | reflection off 时为空，无噪音 |

## 5. 遗留优化点（未修）

1. **revise 后的行为风暴**：guard 打回后模型倾向"自证清白"式大绕路。指针改为 recall
   配方后应显著缓解（第二次运行未触发 revise，无对照），但值得再观测；必要时可考虑
   revise 注入时附带候选捕获值摘要，压缩模型的探索空间。
2. **`NO_TOOL_ROUNDS` 计数待复核**：第一次运行 rounds 8–10 疑似连续无工具轮但未触发
   强制收尾（transcript 的 `toolUses` 字段未持久化，无法离线确认）——需带日志复跑验证。
3. **成本纪律**：误杀放大成本 ~4×（220k vs 59k）。guard 的假阳性不止是体验问题，
   是直接的成本问题。
4. **对照面**：codex（namespace tool 需 `[features] multi_agent=false`；relay 仅 glm 系
   走通 responses API）与 hermes（64k 窗口硬下限、compression 0.75 地板）的运行时对比
   待做；接线结论已足够指导 relay 侧适配。

## 6. 接线事实存档

- codex：npm 包二进制为 musl 动态链接（本机无 loader，segfault）→ 用官方 release
  `codex-x86_64-unknown-linux-musl.tar.gz`（static-pie）装到 `~/.local/lib/codex`；
  0.154.0 仅支持 `wire_api = "responses"`；relay 侧 deepseek 不认 `developer` role、
  gpt 系 responses 路由 404，`glm-5.3-flash-awq` 全链路通；多代理 namespace tool 需关闭。
- hermes：`pip install -e` 到 `~/.venvs/hermes`；`--query` 一次性模式可用；
  上下文窗口 <64k 直接拒绝启动。
