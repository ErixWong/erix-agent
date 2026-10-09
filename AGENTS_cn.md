# erix-agent — 项目 AGENTS.md

> English version: [AGENTS.md](AGENTS.md)

项目特有规则；共享/全局约定见 `~/projects/AGENTS.md`，并且有意不在此重复。本文件随仓库走（GitHub: ErixWong/erix-agent）。

## 1. 项目定位

**自研无头编码 agent（headless agent）**：零依赖 LLM agent 运行时（双协议流式 + 工具循环 + 压缩 + checkpoint），用于**无人值守、宿主编排**场景（app_container / touwaka 嵌入式底座）。

- 产品形态 = **无头 agent**：`runToolLoop` 单任务生命周期（start/run/stop/resume/event stream），执行（`executeTool`）由宿主注入；**边界止于单个任务生命周期**；多角色编排/仲裁/重试调度由宿主负责，不纳入库中。
- **CLI (`bin/`) 是验证器/调试器，不是重点**：交互式 TUI + `chat` 单次入口（可作为 bench 入口）；能力验证使用 erix-bench 无头 harness（容器驱动 + 判分器，对比 `--agent erix|pi`），而交互式 repl 仅测试人机协作。
- 与 pi 的关系：**pi = 交互式 agent（人在环）；erix = 无头 agent（无人值守、宿主调度）——互补而非竞争**。
- 安全分层（ADR-009）：agent 不内置安全；**使用者负责**（本地 = 信任域；嵌入式容器由宿主隔离）。
- 红线：**零 npm 依赖**（只导入 node: 内置模块 + 相对路径），纯 ESM、Node 22+，绝不提交 key/token。

## 2. 代码结构

```
src/
├── index.js
├── assembly.js    # AssemblyPort 校验（宿主边界）
├── assembly-validators.js  # 端口/选项校验共享实现（内部模块）
├── run-state.js
├── tokens.js
├── loop/          # 编排核心：orchestrator（runToolLoop）、provider-runner、
│                  # run-snapshot-executor、budget、aggregate-budget、termination、
│                  # resume-manager、error-ledger、messages、reflection、task-brief、abort、
│                  # block-helpers、tool-result-ttl
├── compact/       # 上下文压缩：budget、pipeline、sliding-window、fold-statistical、
│                  # fold-llm、anchors、fold-fidelity、enforce-size、helpers
├── config/        # 配置适配器
├── messages/      # 规范消息模型 + OpenAI/Anthropic 转换
├── providers/     # OpenAI/Anthropic 双协议 provider
├── reflection/    # governor、judge、l0、wrapup
├── store/         # file、memory、notes
├── text/          # 共享文本辅助函数（label 归一化）
└── tools/         # registry、providers、notes（可选 erix-agent/tools 子路径）
bin/              # CLI（验证器/调试器）：cli.js（入口/chat）、repl.js（TUI）、tools.js（内置工具 + 提示词）、skills.js、mcp.js、config.js、final-guard-support.js、final-guard.js、guard-metrics.js
test/             # 单元测试（node --test），包含 compact/、providers/、tools/、config/、messages/、contract/、helpers/、fixtures/、integration/ 以及顶层测试文件
fixtures/         # 测试夹具（mock MCP 服务器）——⚠️ mock MCP 服务器不得放在 test/ 下（node --test 会运行 test/ 下的所有文件，可能卡住）
examples/         # 示例（skills/ 示例、演示和基准）
docs/             # 设计文档、ADR 决策记录、研究和任务文档
skills/           # skill 定义
scripts/          # 实验脚本和结果
```

## 3. 开发命令

| 命令 | 用途 |
|---|---|
| `npm test` | 全量测试（`node --test`） |
| `node --check <file>` | 语法安全检查 |
| `npm run check:docs` | 文档漂移检查（`scripts/docs-drift-check.mjs`：版本声明、README 引用的 `files`/`exports` 清单、模块地图、文中路径与命令、从 `src/` 直抽的 14 条关键默认值、中英 README 标题骸架）+ 中英契约标题结构对齐 |
| `npm run check:docs:strict` | 同上，但把告警升级为失败 |
| `npm run check:docs-examples` | 真实执行 `docs/host-consumer-contract.md` 里的 js 围栏（issue #158） |
| `npm run check:pack-links` | 随包 Markdown 的链接闭合检查 |
| `node bin/cli.js ...` | 本地运行 CLI（无需安装） |

- 测试隔离规则：涉及 `~/.erix` 或 `~/.pi` 的测试必须注入 `home`/`cwd` 参数（skills/mcp/config 测试提供了先例），以免污染真实用户配置。
- 文档规则（issue #164）：改 `README*.md`、`docs/requirements*.md`、任何默认值或 `files`/`exports` 清单时，必须保证 `npm run check:docs` 绿。该检查直接从 `package.json` 与 `src/` 取真值，因此文档无法静默漂移；「当前版本」声明的规范写法写在 `scripts/docs-drift-check.mjs` 顶部注释里。中英文文档成对同步（见 `AGENTS_cn.md` 对应小节）。

## 4. npm 发布指南（已根据 2026-08 政策验证）

### 前置条件（`package.json`）
- 必须移除 `private`（否则 403）；使用 node 脚本编辑 JSON，不要用 sed 删除一行（否则尾部逗号会破坏 JSON）。
- `files`: `["src", "bin", "skills", "README.md", "CHANGELOG.md", "docs/host-consumer-contract.md", "test/contract", "LICENSE"]` — 发布前使用 `npm publish --dry-run` 检查 tarball。
- `repository.url` 使用 `git+https://...` 格式（或运行 `npm pkg fix`）。
- 当前版本：`0.18.0`；版本变更使用 `npm version <x.y.z> --no-git-tag-version`（功能完整的首发版本不要使用 0.0.0）。

### npm 2026 政策变化（TOTP 停止 + bypass token 限制）
- ❌ 不再支持新的 TOTP 注册（`enable-2fa` 返回 404）。
- ❌ bypass-2FA granular tokens 从 2026-08 起失去直接发布权限。
- ✅ **唯一途径（`npm@12`）**：
  ```bash
  npm i -g npm@12                    # 升级（系统 npm 10 不支持新流程）
  npm login --auth-type=web          # 浏览器 OAuth + passkey
  npm publish                        # device flow：终端打印认证 URL
  ```
- **发布交互（已在 2026-09 验证）**：即使已执行 `npm login`，`npm publish` 仍会触发**一次独立的 device flow 认证**（EOTP；每次发布都要重新认证，而不是由登录覆盖）——终端会打印 `https://www.npmjs.com/auth/cli/<id>`；将其复制到浏览器，在手机上使用相机扫描/确认 passkey，然后命令行自动继续。
- ⚠️ **预发布版本必须显式指定 `--tag`**（由 npm12 强制）：`npm publish --tag latest`；否则会报告 `You must specify a tag when publishing a prerelease version`。
- ⚠️ 在非 TTY 环境（脚本/管道）中，认证 URL 会被掩码为 `***`——**用户必须在自己的终端运行**；在 agent 侧，使用 Python pty 方案为用户捕获真实 URL（见陷阱 4）。
- ⚠️ **不要在 "Press ENTER to open in the browser..." 提示处按 ENTER**（已在 2026-09 验证）：没有浏览器时，按 ENTER 会触发 `xdg-open` 失败并终止 npm（`command failed`，code 3）。如果不按 ENTER，npm 会继续轮询认证状态并正常完成。

### 发布验证闭环
```bash
npm publish --dry-run        # 看 tarball 内容
npm publish                  # 发布（web 认证）
npm view erix-agent version  # 确认 registry
npm unlink -g <旧包名>        # 清本地 link 残留（否则 i -g 报文件冲突）
npm i -g erix-agent          # 全局安装正式包
erix --version && erix chat "..."   # 端到端验证（复用 ~/.erix/config.json）
```

### 踩坑速记
1. 使用 node 脚本编辑 `package.json`；编辑后通过 `node -e "JSON.parse(...)"` 验证。
2. 发布前解除本地 link（`@erix/llm-kit` 是历史遗留）。
3. npm 政策变化很快（TOTP/bypass 已于 2026 年转变）——遇到 403/EOTP 时，先查看官方 changelog。
4. 对于无浏览器 + 非 TTY 的认证流程（已于 2026-09 验证，在没有桌面环境的机器上）：用 Python pty 包装 npm（`pty.fork()` + `select` 读取输出），使用 `setsid nohup` 完全脱离进程组，防止 bash 工具清理它；在脚本中使用正则将 `https://www.npmjs.com/(login|auth/cli)/[0-9a-f-]+` 提取到文件，然后读取 URL 并交给用户在浏览器中操作；**不要自动按 ENTER**（见上文）。登录成功会将 token 写入 `~/.npmrc`；发布成功由日志行 `+ erix-agent@<ver>` 标记；参考实现 `/tmp/npm-pty-login5.py`。

## 5. Git 与远程

- **两个仓库、一份代码、双推**：`origin` 从 GitHub 拉取（工作流真相源），推送时**同时推** GitHub 和 Gitea —— `git push origin <ref>` 会更新两边。
  - `origin` fetch = `ErixWong/erix-agent`（GitHub）
  - `origin` push URL = GitHub **+** `git.erix.vip/eric/erix-llm-kit`（Gitea）
- **GitHub** = 开发工作流真相源：issue、PR、评审都在这里。Gitea 的 issue/PR 区是冻结的历史归档，**不新开、不回复**。
- **Gitea** = 仅代码镜像（同一份提交，双推跟随）。
- **`sync-erix-mirror.sh` cron 已停用（2026-10-03）**：镜像 cron 已证实会反复同步错误版本；双推是唯一同步机制。若某次推送在其中一个 URL 失败，该侧会静默落后 —— 推送后请核对两边。
- 提交流程：分支 `feat-YYMMDD-NN-<描述>` → PR 合并到 main（大改动）；小改动/文档可直接推送。
- 提交信息：conventional commits + 中文摘要
- 历史注记：2026-09-30 前 GitHub 为真相源，当日某会话把角色翻转为 Gitea（提交 `2ee65ce`，加镜像 cron + 双推 URL）；2026-10-03 翻回：GitHub 重新作为工作流真相源，cron 停用，两仓靠双推保持一致。旧的「Gitea 优先」描述误导过后续会话 —— 本段与 `AGENTS.md` 需同步维护。

## 6. 本地运行数据（不提交到仓库）

```
~/.erix/
├── config.json        # LLM 配置（endpoint/model/apiKey/maxOutputTokens/contextWindowTokens）
├── mcp.json           # MCP server 注册（标准格式，可复用 ~/.config/mcp/mcp.json）
├── <session>.json     # 会话历史（id 按 cwd 派生）
├── transcripts/
│   ├── <runId>.jsonl          # 逐轮记录（含 judge 决策字段）
│   └── outputs/<runId>/       # 该 run 的全部产物归档：工具捕获、报告、judge.log
│       └── judge.log          # judge 决策 JSONL（默认写这里；--judge-log / ERIX_JUDGE_LOG 可覆盖）
├── skills/            # 用户级 skill（自描述协议）
└── todos/             # 任务清单（按 cwd 隔离）
```

- **judge 日志有固定归属**：`transcripts/outputs/<runId>/judge.log`，与 transcript/工具捕获同目录同生命周期；监督者排查 judge 行为直接看这里，不再依赖 `/tmp` 重定向。
- **judge.log 记录形状（#165，additive）**：每条决策记录带 `runId` + 被评决策发生时 run 实际使用的 `model`（judge 走另一个 evaluator 模型时再带 `judgeModel`；探不到就缺省字段，绝不写占位值），且每个 run 的末条是一条 `run_outcome` 汇总记录（`termination` + `verification`）——追加而非回写。per-model 校准指标（blocked 率 / 误拦率 / extend ROI）就是把这两类记录按 `runId` join。

## 7. 本地运行环境事实

- Relay：`api.ai.erix.vip/v1`；模型必须由用户配置（`contextWindow 262144`、`maxOutputTokens 65536` → 自动压缩预算 ~170k）。`erix_run` 读的就是同一份 `slots.default`，不跟随 pi 当前模型。
- 工具执行/验证：erix 工作使用 `node bin/cli.js chat`（本仓库），监督者监视 `/tmp/erix-*-log.txt` 以获取逐步输出。
- erix 编码任务红线：每个文件只读一次（按 offset/limit 分段），长任务先用 `todo_add` 拆解，汇报前作出验证声明。

## 8. 模型与成本纪律

- 禁止硬编码模型名称；始终从用户配置读取，或使用用户明确提供的模型。
- 模型不可用时立即失败；绝不替换模型或回退到其他模型。
- 任何批量实验开始前，必须报告模型、调用次数和基于历史平均值的成本/时长估算，并取得用户确认。
- 尊重用户对供应商和配额的选择；用户更换模型通常是出于成本或配额原因，因此不得悄悄切回原模型。
