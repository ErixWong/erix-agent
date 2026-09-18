# ADR-015：上下文卫生引擎化——一个档案、一个通道、一张目录、一排路标

- 状态：**草案**（2026-09-16，待评审）
- 关联：ADR-002（TranscriptStore）、ADR-012（引擎真相/模型效率/宿主策略）、ADR-013（guard 宪章）、
  ADR-014（宿主端口框架——本文替代其 P2 的**模型侧**定位，guard 用法短期保留）、
  issue #57（recall 从 CLI 摘除）、#106（ResourceStore 落地）、#109（错误通道统一）、
  **#115（本设计的实施 issue）**

## 一、背景

### 1.1 实测证据（2026-09-16 野外测试，非推测）

任务：PrintServiceCore（60 个 .cs / 12113 行）静态分析，deepseek-flash，43 轮，折叠 1 次，正常收尾。

- 笔记机制：`note_read` 0 次；`note_take` 仅 1 次（收尾存报告指针）；折叠后 `note_list` 得 0 条，
  模型靠重跑**可重放**命令恢复——笔记/归档均未成为载荷
- auto-capture：0 触发（门槛 exec + 不可重放 + `label=value` 形态，只读分析类任务不踩）
- ResourceStore：归档 40+ 输出**零故障**，但模型侧取回回路断裂（见 1.3）

### 1.2 三家对照

| | pi | touwaka | erix 现状 |
|---|---|---|---|
| 截断层 | 工具层（2000 行/50KB） | 发送层（organizer，存储全量） | 工具层（>4096 归档） |
| 全文存哪 | /tmp 临时文件 | 消息库（transcript = 档案） | ResourceStore 文件 + transcript（**两套**） |
| 恢复通道 | 现成 readFile + 真实路径 | 现成 recall + 精确配方（stub 内嵌可照抄调用） | **不存在** |
| 新造抽象 | 0 | 0 | 端口三件套 + 不透明三元组 |

### 1.3 病根（代码与历史逐条核实）

1. **同一问题两套机制**：fold 原文进 transcript（引擎管）；exec 大输出进 ResourceStore 文件（CLI 管）。
   不一致的根源。
2. **#57 方向对、内容错**：recall 从 CLI 工具面摘除（库完好但模型够不着）；折叠摘要去广告改为宿主注入
   `recoveryHint`——**注入缝留对了**，错的是 CLI 往缝里塞的话。
3. **#106 的 stub 是空头支票**：`bin/tools.js` 归档 stub 引导"请用 ResourceStore 读取"——该工具不存在；
   `display` 恰好是实现为路径，靠巧合兜底。抽象失败靠巧合续命。
4. **#112 去路径化自相矛盾**：run 级提示去了路径，每条 stub 的 `display` 仍是路径；若严格去除，
   模型将**无任何办法**取回全文。
5. **本质**：拿端口去抽象"模型面前的指针"（抽象对象错了，怎么打补丁都漏）。pi/touwaka 证明正确做法是
   **能力整体放在存储之上**，模型词汇表里根本没有"路径"这个概念。

## 二、决策

### 2.1 四组件 + 一契约

- **一个档案**：transcript（经 TranscriptStore 端口）是唯一档案，记录**全量**输出原文；后端可以是
  JSONL 文件也可以是 DB 表。存储差异被端口完整吸收，不漏进模型视野。
- **一个通道**：recall 进引擎**标准工具面**（`createRecallTool` 已是库导出，标配化，宿主可显式关）。
  引擎说"recall(...) 取原文"时**保证兑现**——存储和工具都在引擎手里。
- **一排路标**：内容被藏的**原地**，由引擎生成 stub 内嵌精确调用配方（touwaka 式"可照抄的下一步"，
  如 `recall({ round: 9 }) 取原文`）。
- **一张目录**：notes keys 注入 run-state 块（≤20 条 / ~1KB，pinned → 最近排序，含 auto 来源标记）。
  笔记是**暗藏**的——上下文无任何原地标记，需要 inventory；归档输出是**自标记**的（stub 在原地），
  不需要目录。
- **一份契约**：`recallContract`——任何 TranscriptStore 后端必须保证：
  ① recall 语料覆盖 `record.messages`（含全量输出原文）+ `foldedPayload`；
  ② 原文**字节保真**（guard 核验依赖）；
  ③ 按轮过滤/检索语义一致（范围 + pattern）。

### 2.2 两个机制、两个时机（同构，共用底座）

```
        存储视图（transcript，全量）
              ↑ recall 取回
        上下文视图（stub / 摘要）
              ↑
   ┌──────────┴──────────┐
输出卫生：单条太大 → 即时 stub    fold：累积太满 → 压缩旧轮
（尺寸维度，记录当下）         （时间维度，事后批量）
```

两者共用：transcript 存全量 / 上下文放压缩视图 / recall 取回。**fold 因此减负**：#106 加的资源物化
逻辑可拆（大输出已在档案里，fold 无需特殊照顾）。

### 2.3 退役与保留

- **退役（本次全量执行，不留过渡态）**：
  - ResourceStore 的**输出档案角色整体退役**：exec 大输出交全量给引擎（transcript `toolOutputs` 归档 +
    recall 取回），CLI 不再二次截断/二次归档；双档案不一致从根源消除；
  - CLI 手写的 `buildCaptureStub` / `buildCaptureRecoveryHint`（换引擎生成）；
  - #112 的"去路径化"方向——模型可见文本（stub/rerun 提示/系统提示词/guard 消息）零路径、
    零 ResourceStore 词汇，泄漏不再需要打补丁。
- **Phase 4b（并入 #109 第 2 步；端口最终删除见 2026-09-17 收尾）**：ResourceStore 仅存的 **capture 证据角色**（非重放 exec 的
  capture manifest，provenance gate 专用）——它与 auto-capture/guard 是同一子系统，证据源迁移到
  transcript 与吞错修复一并做，避免同一处代码改两遍。
- **保留**：
  - fold（强化，见 2.2）；
  - notes（独立机制，与档案无关）；
  - exec 专属语义（replayable 判定、凭据过滤）留在工具层，警告文本与引擎 stub 自然拼接；
  - **#57 的 `recoveryHint`/`stubFor` 注入缝**——宿主仍可覆盖引擎默认（如无 recall 的极简宿主）。

### 2.4 备选方案（否决理由）

| 备选 | 否决理由 |
|---|---|
| 加 `resource_read` 工具 | 又一个专门工具；pi 证明现成工具足够；不解决双档案不一致 |
| 引擎生成 pi 式路径提示 | 引擎不知道模型工具面（红线：工具由宿主注入）；只对 CLI 成立，headless 宿主可能无 readFile |
| 保留 ResourceStore、修 stub 提示 | 双档案、双通道的不一致仍在；#112 打补丁史证明修不完 |

### 2.5 与 ADR-012/013 的关系

引擎生成的 stub/配方/目录全部是**引擎已知事实**（说出口必兑现——存储与工具都在引擎手里），属
"环境事实陈述"，非行为诱导：模型该知道自己存过什么、怎么取回。符合 ADR-013 的"信息补充而非强制"。

## 三、实施（分步，每步独立可验收；详见 #115）

1. ✅ **recall 标配化**：引擎默认注册（opt-out 旗子）+ 撕票显式报错 + 宿主同名工具让位
2. ✅ **输出卫生进引擎**：超限输出 → 档案 + stub；checkpoint/resume 字节保真；四路 recall 语料覆盖
3. ✅ **notes 目录注入**：semantic 槽位扩容（220→1200 字符多行渲染）+ CLI 目录 provider
4. ✅ **退役清理 4a**：ResourceStore 输出档案角色退役（exec 交全量、模型可见文本零路径）
5. ✅ **退役清理 4b**：capture 证据源迁移至 transcript（#109 第 2 步）
6. ✅ **端口删除（2026-09-17 收尾）**：`resourceStore` 选项、`validateResourceStore`、
   `createFileResourceStore`、fold 的 `materializeFoldResources`、`resourceStoreContract`
   全部删除——折叠原文由 transcript 承载，引擎侧不再有第二个档案

> 实施记录（2026-09-16）：库侧 `recallContract` 独立契约测试与 touwaka adapter 对拍待补
> （4b 时一并做，覆盖同一条 store 接口面）；本表状态以 #115 验收清单为准。

验收（#115 清单）：契约双实现全绿；touwaka adapter 过契约；resume 无原文泄漏；模型词汇表无路径；
命令密集型任务野外复测回填数据（recall 使用率 + auto-capture 触发率）。

## 四、影响面

- ADR-014 P2 的**模型侧**定位被本文替代；guard 用法短期保留，长期随 ResourceStore 退役
- #109 第 2 步（auto-capture 修复）与本设计**正交**，照常先行
- 实施完成后回填 #111（0.6.0 发布门）破坏面清单
