# erix-agent — 项目 AGENTS.md（中文版）

> 英文版：[AGENTS.md](AGENTS.md)。本机共享约定：`~/projects/AGENTS.md`。
> **本页是 system prompt 的一部分：每一轮全额重发，上下文折叠也不会动它**（字节预算由
> （当场对账），要么是一个指针——绝不当手抄件。

## 1. 这个项目是什么

- **自研的 headless 编码 agent**：零依赖 LLM 运行时（双协议流式 + 工具循环 + 折叠 + 断点 + 续跑），用来在宿主里
  无人值守地跑（fde-workshop / touwaka）。pi = 交互式（人在环里），erix = headless（宿主调度）：互补，不是竞争。
- **边界就是一个任务生命周期**——`runToolLoop`，`executeTool` 由宿主注入。多角色仲裁、重试调度、编排是宿主的活，
  库不吸收。
- **`bin/` 是验证器/调试器，不是契约面。** 对 `bin/` 的**新增**依赖必须先升进 `src/`。现存唯一一笔借款：`exec`
  （只在 `bin/tools.js`）被 `examples/pi-extension` 借用。能力基准在独立的 `erix-bench` 仓库里以 headless 方式跑。
- 安全不内建（ADR-009）：用它的人负责；内嵌运行由宿主隔离。
- **红线**：零 npm 依赖（只 import `node:` 内置模块与相对路径）、纯 ESM、Node 22+、绝不提交 token。这条线管的是
  import，不是工具链：`typescript` 与 `@types/node` 是用户授权进来的 devDependencies（issue #213）——只为生成
  声明而存在，`src/` 与 `bin/` 都不 import 它们。
- `package-lock.json` 刻意 gitignore ⇒ 装依赖用 `npm install --include=dev`，**永远不要** `npm ci`。

## 2. 代码结构住在哪里

`README.md` 的「模块地图」就是那棵树。**已经没有闸对账它了**（对账的那批闸随 #967 全删），所以它是手工维护的：
**保持简短，新增模块就在创建它的同一个 PR 里加进去。**
**绝不要把那棵树抄到本页**：手抄在这页的树会一边收费一边静默腐烂。

- 唯一一条属于规则而不是属于地图的结构事实：**mock MCP server 留在 `fixtures/`，绝不放进 `test/`**——
  `node --test` 会跑 `test/` 下的每一个文件，那些 server 会把它挂住。

## 3. 开发命令

- **本仓没有门禁。** 所有 `check:*` npm 脚本、CI 工作流与冷层门禁手册都已删除（issue #961 / #967）：
  一道「在合法改动上变红、修法是重抄一个常量」的判据不承载任何信息。**`npm test` 是唯一的自动判据。**
  `npm run soak` 与 `*-experiment.mjs` / `bench-*.mjs` 是工具不是闸：要量东西的时候才跑。
- 清单归 `package.json`，本节不再复述。
- 开 PR 之前：`find src -name '*.d.ts' -delete && npm test`。声明文件是生成物、就住在源码旁边，
  它在场时 `tsc` 会把 `./x.js` 解析到同目录的声明，查的是声明而不是实现。
- 测试隔离：碰 `~/.erix` 或 `~/.pi` 的测试必须注入 `home` / `cwd`（skills/mcp/config 测试是先例），
  不许污染真实用户配置。
- 类型面规则（issue #213）：`src/**/*.d.ts` 是**生成物、永不入库**；`prepack` 重新生成它们且**只写 stderr**。
  有两种 JSDoc 形状会**静默**把参数退化成 `any` ⇒ `#type-surface`。
- 新增文件首行开 `// @ts-check`（它声明意愿，不是范围开关——范围是入口的 import 图）。
- 引用**另一个仓库**的文件：写成 `<仓名>:<那个仓里的路径>`——例如
  `pi-subagents:src/runs/background/async-execution.js:4`。**不带前缀的路径就是本仓的路径，必须在这里解析得到。**
- **锚点**：指位置优先写符号 + 它的文件（`` `符号`（`路径`） ``），而不是 `路径:123`。
  行号仍须**为真**：指到文件末尾之外、或点名的符号在 `src/` 里已不存在，就是缺陷——
  只是现在没有任何自动判据会告诉你。
- 文档规则（issue #164）：改 `README*.md`、`docs/requirements*.md`、任何默认值或 `files`/`exports` 清单，
  中英成对文档必须在**同一个 PR** 里同步（本页配 `AGENTS.md`）。

## 4. 发版日

三条命令，按这个顺序（`preflight` 那一段随门禁一起删掉了）：

```bash
npm run release:day -- --stage publish       # 打印操作单，exit 3；`npm publish` 由你自己在终端跑
npm run release:day -- --stage writeback --version <x.y.z> --published <x.y.z> [--published-date <YYYY-MM-DD>]
npm run release:day -- --stage finalize      # 给切版打 tag → 双推 → 两侧各验一次
```

- `writeback` 回写发布态；`finalize` 只在发布态已落盘且工作树干净时才打 tag。**`writeback` 永远不许跳过。**
- npm 12 在 `~/.npm-global/bin/npm`，而 `PATH` 里 `/usr/bin/npm`（10.x）盖住它 ⇒ 用绝对路径调它。
- 认证是设备流（`npm login --auth-type=web`），**每次发布都要重新认证**。非 TTY 下 URL 会被打码成 `***`，
  所以要在**捕获它的同一条消息里**把它发出来（几分钟就过期）；在 "Press ENTER to open in the browser" 处
  **绝不要按 ENTER**——没有浏览器时它会触发 `xdg-open`，失败并把 npm 杀掉（code 3），让它继续轮询。
  预发布版本要显式给 `--tag`。
- 发布**烧掉版本号**；`+ erix-agent@<ver>` 这行不代表可用（registry 有延迟）⇒ 轮询
  `npm view erix-agent version --prefer-online`，再用 `--prefer-online` 安装并跑 `erix --version && erix chat "…"`。
- 当前版本：`package.json` 是 `0.34.0`；npm 的 `dist-tags.latest` 是 `0.34.0`。用
  `npm version <x.y.z> --no-git-tag-version`。
- `package.json` 的对外面：`private` 不出现、`repository.url` 是 `git+https://…` 形态、`files` 是一长串显式白名单
  （读 `package.json`，绝不复述它）；用 `npm publish --dry-run` 看实际面。
- **打 tag 之前两趟人肉过**：① 把声称的**默认值**、**数字**与**名字集合**在两份 README、两份 AGENTS 与两份契约
  文档之间逐条走一遍；② 读本版 CHANGELOG 段里每一条 merge 的 first-parent diff。这两趟现在都没有任何自动判据。

## 5. Git 与远端

- **一条代码线，双推**：`origin` 从 `ErixWong/erix-agent`（GitHub）fetch，push 到 GitHub **加** Gitea
  （`git.erix.vip/eric/erix-llm-kit`）；`git push origin <ref>` 两边一起更新。这一对推送得你自己做——
  `sync-erix-mirror.sh` 那个 cron 是关着的且必须保持关，某个 push URL 失败时那一侧会静默落后：
  **推完两侧各验一次**。
- **`main` 上被拒的推送是远端的回答，不是权限问题**：先读远端怎么说（`GH013` / “required status checks are
  expected”说的是**正在推的那个 sha** 上检查没跑过），再现查规则（`gh api repos/<owner>/<repo>/rulesets`）——规则状态
  一律现验、不许抄到页面上；没读到远端原文之前，不要断定「被拒」等于什么。永不 `--force`：上面两条 push URL
  各跑各的，被拒的推送可能让镜像跑在 GitHub 前面——决定下一步前先把两侧都回读一遍。
- **GitHub 是工作流的真值**：issue、PR、评审都在那里。Gitea 只是代码镜像（没有 Actions 流水线；它的 issue/PR 区
  是一份冻结的历史归档——不要在那边开单或回帖）。
- 贡献流程：从 `feat-YYMMDD-NN-<描述>` / `fix-YYMMDD-NN-<描述>` 开分支 → **一律 PR 进 `main`**——活的 ruleset
  （`main-require-pr`）会用 `GH013` 拒绝直推，而 `origin` 的两个 push URL 是**独立执行**的，于是被 GitHub 拒的那次
  仍可能落到 Gitea 镜像上，两侧就此分叉。所以：推分支 → 开 PR → 合并 → 回读两个 URL 的 `refs/heads/main`。
  提交信息：conventional commits + 中文摘要。

## 6. 运行时数据与本机环境

- 运行时写出来的一切都住在 `~/.erix/`，**永不入库**（LLM 配置、MCP 注册表、会话历史、transcript、用户级 skills、
  按 cwd 隔离的待办清单）⇒ 那份树形图在 `#local-runtime-data`。
- **judge 决策有固定的家**：`~/.erix/transcripts/outputs/<runId>/judge.log`，与 transcript、工具捕获同目录同生命周期
  ——要看 judge 行为就去那里，别靠 `/tmp` 重定向。
- 模型配置来自 `~/.erix/config.json` 的 `default` 槽（relay `api.ai.erix.vip/v1`）——`erix_run` 扩展读的就是同一个
  文件，它不跟着 pi 的当前模型走。
- 本地调试用本仓的 CLI（`node bin/cli.js chat`）。
- agent 在本仓干活时：**读之前先估读预算，并一次装进来**，汇报之前先给验证声明。

## 7. 模型与成本纪律

- 绝不硬编码模型名：从用户配置里读，或者用用户明确点名的那个。
- 模型不可用就直接失败；不要替换，也不要悄悄回落到别的模型。
- 任何批量实验之前，先报模型、调用次数与基于历史均值的成本/耗时估计，并拿到用户确认。
