# ADR-008：erix skill 系统——脚本自描述协议（touwaka 机制简化版）

- 状态：已决策（2026-08-29）
- 背景：erix CLI 的工具是写死的（bin/tools.js 内置 readFile/rg/tree + jail）。
  用户实际使用中（"看看这是什么项目"）暴露需求：**工具应是可扩展的**。
  参考 touwaka 的既有机制：不依赖外部清单（skills.md），而是**调用 skill 脚本自身导出的
  函数，让脚本自己说自己有多少 tools**（自描述协议）。
- touwaka 机制要点（已读源码确认）：
  - skill = 目录 + entrypoint 脚本（node/python 双运行时）
  - 脚本导出 `getSkillDefinition()`（v1）或 `getTools()`（legacy）
  - 宿主跑脚本拿 SkillDefinition（schema_version/skill/tools），校验后注册
  - 工具调用时按 script_path/entrypoint 子进程执行（firejail 沙箱）
  - 校验规则：schema_version、skill.id、entrypoint/script_path 相对路径不逃逸
    skill root、tools 数组、name 唯一

## 决策：三层设计

### 第一层：协议（脚本自描述）

- 每个 skill = 一个目录：`<技能目录>/<skill-id>/skill.mjs`
- entrypoint 默认 `skill.mjs`，导出 `getSkillDefinition()`，返回：

```json
{
  "schema_version": 1,
  "skill": { "id": "<skill-id>", "runtime": "node", "entrypoint": "skill.mjs" },
  "tools": [ /* 库的 ToolSchema 数组：name/description/inputSchema */ ]
}
```

- **宿主不维护清单**——import 脚本调 `getSkillDefinition()`，脚本自报（touwaka 核心）
- 兼容 `getTools()`（返回 ToolSchema 数组，schema_version 记 0/legacy）

### 第二层：发现与加载

- 技能目录两个：`~/.erix/skills/`（个人全局）+ `<cwd>/.erix/skills/`（项目局部）
- 只扫描存在的一级子目录；同名 skill 项目优先（个人被项目覆盖）
- 校验参考 touwaka validateSkillDefinition：schema_version、skill.id 非空、
  tools 数组、name 唯一、entrypoint 相对路径不逃逸 skill root
- 工具名与内置工具（readFile/rg/tree）冲突 → 报错并跳过该 skill（不静默覆盖）

### 第三层：执行与安全

- **in-process import**（node 动态 import）：skill 是用户自己的脚本，个人 CLI
  信任域内，无需子进程隔离。touwaka 的子进程/firejail 是多租户沙箱需求，
  erix 单用户场景暂不需要——列为后续增强
- 工具入参校验走 `createToolRegistry`（name 分发 + inputSchema 校验 + 未知工具
  友好返回）
- **安全边界不内嵌 agent**（ADR-009）：skill 工具与内置工具一样不套 jail、不限
  路径命令——安全由运行环境提供（用户机器=信任域；嵌入容器/沙盒场景由宿主隔离）。
  库的 createJail/file-tools 保留为参考实现，供需要自建沙盒的调用方取用
- 结果截断沿用 onToolResult（OUTPUT_LIMIT）

## 命令面

- `erix skills`：列出发现结果（两个目录、每个 skill 的 id/工具数/校验错误）
- repl 内 `/skills`：显示当前已加载的 skill 工具
- 加载失败（校验错/import 错）不阻塞 CLI 启动，在 `erix skills`/`/skills` 里
  显式报出

## 理由

- "脚本自描述"与 ADR-005 的"契约在库、执行在调用方"不冲突：skill 的 tools
  定义格式就是库的 ToolSchema，skill 脚本是"调用方侧的工具包"
- 不维护清单 = 加技能只放目录、不加任何登记文件，符合 touwaka 已验证的模式
- in-process 简化：零子进程协议（省 describe/execute 两套 JSON 通道），
  调试直接，个人场景安全边界可接受

## 后果

- 后续增强（按需）：子进程隔离执行、python runtime、skill 依赖声明、
  skill 市场/模板目录
- skill 示例入库：examples/skills/（如 getTime、git 状态查询）
- 文档：README 增"技能"小节，讲协议与目录约定
