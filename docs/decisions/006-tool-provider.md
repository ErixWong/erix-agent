# ADR-006：ToolProvider 分层——定义可插拔（json/db），执行器永远在代码

- 状态：已决策（2026-08-29）
- 背景：用户提出工具定义也走 provider——json 层从磁盘加载、db 层从数据库加载，
  通过配置决定来源。诉求成立：app_container 的审计/开发 agent 工具面不同
  （现在是代码里两个 frozen 数组），touwaka 的 expert 各有工具配置（本就在 DB），
  "改工具面不改代码"是真实需求。**但有一个必须先堵住的洞**。

## 关键修正：schema 是数据，执行器是代码

工具 = 定义（name/description/input_schema）+ 执行体（函数）。定义可以来自任何地方，
**执行体只能是进程内注册的函数**——否则"往 DB 插一条记录就获得新执行能力"，
等于把 app_container 的白名单安全边界改成数据可写，红线直接破。

因此分层语义是：

> **执行器注册表定义"能力宇宙"（代码，code review 过）；
> ToolProvider 只做"选择与配置"（数据）——决定暴露哪些、描述/参数覆盖。**

DB 里没有对应执行器的工具名 → 启动即报错（fail closed），不是运行时才发现。

## 决策

### 接口

```js
/**
 * @typedef {Object} ToolProvider
 * @property {(sel?: { set?: string }) => Promise<ToolSchema[]>} listTools
 * // set：工具集名称（如 app_container 的 "audit" / "dev"），缺省返回默认集
 */

// 执行器注册表（代码侧，能力宇宙）
createToolRegistry({
  executors: { [name]: (input, ctx) => Promise<string> },
  schemas: ToolSchema[],            // 代码内基准定义（description 的权威版本）
}) => {
  executeTool,                      // 直接喂给 runToolLoop
  resolveTools: (provider, sel) => Promise<ToolSchema[]>,  // 与 provider 求交+覆盖
}
```

`resolveTools` 语义：provider 返回的每个 schema **必须**命中注册表里的执行器，
否则抛 `tool_unknown_executor`（fail closed）；provider 可覆盖 description 与
input_schema 的参数约束（如调小 maxLength），但不能改名换义。

### 内置 ToolProvider

| 适配器 | 形态 | 用途 |
|---|---|---|
| `static` | 代码数组（= 两项目现状） | 默认；schema 变更走 code review |
| `json-file` | `dir/tools.json` 或 `dir/*.json`，含工具集定义 | 磁盘可调工具面，文件可入库走评审 |
| `composite` | 多 provider 按优先级合并 | 代码基准 + DB 覆盖层 |

DB 适配器在项目侧（touwaka 的 expert 工具配置、app_container 未来的设置页工具管理），
实现同一接口。

### 与 loop 的衔接

`runToolLoop` 接受 `tools` + `executeTool` 的现状不变；新增便利入口：
传 `registry` + `toolProvider` + `set` 时内部先 `resolveTools` 再进循环。
循环在调用执行器**前**按 schema 校验入参（required/type/maxLength 的零依赖最小校验），
校验失败直接回 tool_result 错误，不碰执行器（app_container 现有行为的下沉）。

## 理由

- "宇宙在代码、选择在数据"同时满足：工具面可运营化配置（不用发版调 description/开关）
  与安全红线（能力不可经数据新增）。
- json-file 放仓库 = 工具定义变更可评审；DB 层留给真正的运营诉求（按 expert/任务类型开关），
  两层职责天然分开，composite 支持叠加。
- fail closed 的求交语义让配置错误在启动时爆炸，而不是 LLM 调到一半才发现。

## 后果

- v0.2 随 tools 子路径一起落地（registry 是 executeTool 的生产者，与 ADR-005 第二层同包）。
- 项目侧迁移：app_container 把 `PI_TOOL_SCHEMAS`/`PI_DEV_TOOL_SCHEMAS` 变成 static provider +
  registry 注册；touwaka 的 toolManager 包一层 DB ToolProvider。
- 文档需写明：**永远不要实现"从数据注册执行器"的 adapter**（如 DB 存 JS 代码 eval）——
  那是 RCE 即服务。
