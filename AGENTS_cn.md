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

`find src -name '*.js' -not -name '*.d.ts' | wc -l`）。**绝不要把那棵树抄到本页**：手抄在这页的树会一边每轮
收费一边静默腐烂。

- 唯一一条属于规则而不是属于地图的结构事实：**mock MCP server 留在 `fixtures/`，绝不放进 `test/`**——
  `node --test` 会跑 `test/` 下的每一个文件，那些 server 会把它挂住。

## 3. 开发命令

本仓**没有门禁**：所有 `check:*` npm 脚本与 CI 工作流都已删除（#961/#967）。**唯一的自动判据是 `npm test`**。


清单归 `package.json`，本节不再复述。每道闸判什么、改它所管的东西之前先读哪个锚点，都在

- **CI 只在 `workflow_dispatch` 上跑**：`main` 的门禁由 ruleset 承担（现值用
  `gh api repos/<owner>/<repo>/rulesets` 现查；今天它要求走 PR、且没有配任何 status check），所以唯一自动门禁是
  发版前必跑的 `npm run release:day -- --stage preflight`。**没有事件触发的步骤是仪表盘，不是闸；一条判据若只在
  CI 里跑，它就是哪儿都没跑**（issue #908 R2）。工作流只留干净检出 / 第二个 node 大版本才证得动的东西；秒级的
  `ci.yml` 留了哪些步骤、撤走的每一步去了哪 ⇒ `#ci`。恢复自动触发 ⇒ 先读 `#ci`，并按 ruleset 现值决定要不要配
  `required_status_checks`。`npm run soak` 仍然留在 CI 之外。
  `node_modules` 的闸在裸克隆里以 `Cannot find module 'typescript'` 失败，含义是**这道闸没能跑**，
  永远不是回归 ⇒ `#gate-reproducibility`。
- 测试隔离：碰 `~/.erix` 或 `~/.pi` 的测试必须注入 `home` / `cwd`（skills/mcp/config 测试是先例），否则它会污染真实
  用户配置。
- 类型面规则（issue #213）：`src/**/*.d.ts` 是**生成物、永不入库**；`prepack` 重新生成它们且**只能往 stderr 打日志**。
  有两种 JSDoc 形状会**静默**把参数退化成 `any` ⇒ `#type-surface`。
  所以这个数只减不增；逐文件承载量与是否宿主可及都由 `--verbose` 打印。`--with-tools` 把并集扩到 `./tools`，
  `--strict`、对着脚本里它自己那对基线，它阻塞，且**两档在同一笔提交里一起降**。⚠ **跑棘轮之前先删掉生成物**
  （`find src -name '*.d.ts' -delete`）：生成物在场时 `tsc` 会把 `./x.js` 解析到同目录的声明，查的是声明而不是实现。
- **量数纪律**（issue #653，对本文提到的每一道棘轮和每一张派生表都成立）：派生数与基线**只在最终树上取**；基点落后
  `main` 就先 rebase 再取数；降下的债与它对应的基线 / 派生表更新**在同一个 PR 里**一起进。
- 新增文件首行开 `// @ts-check`（它声明意愿，不是范围开关——范围是入口的 import 图）。
- 文档规则（issue #164）：改 `README*.md`、`docs/requirements*.md`、任何默认值或 `files`/`exports` 清单，必须保持
  中英成对文档必须同步（本页配 `AGENTS.md`）。
- 引用**另一个仓库**的文件：写成 `<仓名>:<那个仓里的路径>`——例如
  `EXTERNAL_REPO_PREFIXES` 里登记过（没登记的名字红，登记了却没人引用也红）。**不带前缀的路径就是本仓内的路径，
  必须在这里解析得到。**
- **锚点**：指位置优先写符号 + 它的文件（`` `符号`（`路径`） ``），而不是 `路径:123`。
  （三条锚点地板已随 #908 拆除，测量日志 `docs/maintenance/symbol-anchor-ledger*.md` 已删除）。
  但行号仍须**为真**：指到文件末尾之外、或点名的符号在 `src/` 里已不存在，照旧红。
  加锚点或搬锚点之前先读 `#docs-anchors`。

## 4. 发版日

四条命令，按这个顺序。下面四行清单与 `scripts/release-day.mjs` 里的 `PREFLIGHT_STEPS` 逐行对账；每一步判什么
写在 `#release-day`：

```bash
npm run release:day -- --stage preflight --hosts <host repo dirs>
#   [2/4] CHANGELOG [Unreleased] carry              还停在 `## [Unreleased]` 下的条目
npm run release:day -- --stage publish       # 打印操作单，exit 3；`npm publish` 由你自己在终端跑
npm run release:day -- --stage writeback --version <x.y.z> --published <x.y.z> [--published-date <YYYY-MM-DD>]
npm run release:day -- --stage finalize      # 给切版打 tag → 双推 → 两侧各验一次 → 文档闸
```

  `writeback` 永远不许跳过。
- **宿主消费者那一步答的是覆盖度，不是否决权**：本仓就是上游，所以宿主 import 了一个被标记待删的名字，
  意思是「升级指南必须写清拿什么替换」，而不是「所以把那个名字留着」。
- npm 12 在 `~/.npm-global/bin/npm`，而 `PATH` 里 `/usr/bin/npm`（10.x）盖住它 ⇒ 用绝对路径调它。
- 认证是 device flow（`npm login --auth-type=web`），而且**每一次 publish 都各自认证一次**。非 TTY 下 URL 会被打成
  `***`，所以**抓到它的那条消息里就要交给用户**（几分钟就过期）；**不要在「Press ENTER to open in the browser」
  上按 ENTER**——没有浏览器时会触发 `xdg-open`，失败并杀掉 npm（code 3），让它继续轮询。预发布版本必须显式带
  `--tag`。
- publish 会烧掉那个版本号；`+ erix-agent@<ver>` 那一行不等于可用（registry 有延迟）⇒ 先轮询
  `npm view erix-agent version --prefer-online`，再用 `--prefer-online` 安装，然后跑
  `erix --version && erix chat "…"`。
- 当前版本：`package.json` 写 `0.34.0`；npm 的 `dist-tags.latest` 是 `0.34.0`。
  `npm version <x.y.z> --no-git-tag-version`。
- `package.json` 那一面：去掉 `private`、`repository.url` 用 `git+https://…` 形态、`files` 是一份很长的显式
  白名单（读 `package.json`，别抄）；用 `npm publish --dry-run` 看产物 ⇒
- **打 tag 之前有两步是人工的**（锚点只覆盖有人登记过的维度）：① 手工走一遍**默认值**、**数字**与**名称集合**
  就把里面每个短 sha 的 first-parent diff 读一遍 ⇒ `#unattributed-merges`。

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
