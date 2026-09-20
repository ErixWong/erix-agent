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
├── loop.js        # 薄转发垫片（runToolLoop 本体在 loop/）
├── assembly.js    # AssemblyPort 校验（宿主边界）
├── run-state.js
├── tokens.js
├── loop/          # 编排核心：orchestrator（runToolLoop）、provider-runner、
│                  # checkpoint-executor、budget、aggregate-budget、termination、
│                  # resume-manager、error-ledger、messages、reflection、task-brief、abort、
│                  # tool-result-ttl
├── compact/       # 上下文压缩：budget、sliding-window、fold-statistical、
│                  # fold-llm、anchors、fold-fidelity、enforce-size
├── config/        # 配置适配器
├── messages/      # 规范消息模型 + OpenAI/Anthropic 转换
├── providers/     # OpenAI/Anthropic 双协议 provider
├── reflection/    # governor、judge、l0、wrapup
├── store/         # file、memory、notes
└── tools/         # registry、providers（可选 erix-agent/tools 子路径）
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
| `node bin/cli.js ...` | 本地运行 CLI（无需安装） |

- 测试隔离规则：涉及 `~/.erix` 或 `~/.pi` 的测试必须注入 `home`/`cwd` 参数（skills/mcp/config 测试提供了先例），以免污染真实用户配置。

## 4. npm 发布指南（已根据 2026-08 政策验证）

### 前置条件（`package.json`）
- 必须移除 `private`（否则 403）；使用 node 脚本编辑 JSON，不要用 sed 删除一行（否则尾部逗号会破坏 JSON）。
- `files`: `["src", "bin", "skills", "README.md", "CHANGELOG.md", "docs/host-consumer-contract.md", "test/contract", "LICENSE"]` — 发布前使用 `npm publish --dry-run` 检查 tarball。
- `repository.url` 使用 `git+https://...` 格式（或运行 `npm pkg fix`）。
- 当前版本：`0.8.0`；版本变更使用 `npm version <x.y.z> --no-git-tag-version`（功能完整的首发版本不要使用 0.0.0）。

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

- **origin** = 自托管 Gitea（`git.erix.vip/eric/erix-llm-kit`，归档备份）
- **github** = `ErixWong/erix-agent`（主远程，公开）
- 提交流程：分支 `feat-YYMMDD-NN-<描述>` → PR 合并到 main（大改动）；小改动/文档可直接推送。
- 提交信息：conventional commits + 中文摘要

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

## 7. 本地运行环境事实

- Relay：`api.ai.erix.vip/v1`；模型必须由用户配置（`contextWindow 131072`、`maxOutputTokens 32768` → 自动压缩预算 ~85k）。
- 工具执行/验证：erix 工作使用 `node bin/cli.js chat`（本仓库），监督者监视 `/tmp/erix-*-log.txt` 以获取逐步输出。
- erix 编码任务红线：每个文件只读一次（按 offset/limit 分段），长任务先用 `todo_add` 拆解，汇报前作出验证声明。

## 8. 模型与成本纪律

- 禁止硬编码模型名称；始终从用户配置读取，或使用用户明确提供的模型。
- 模型不可用时立即失败；绝不替换模型或回退到其他模型。
- 任何批量实验开始前，必须报告模型、调用次数和基于历史平均值的成本/时长估算，并取得用户确认。
- 尊重用户对供应商和配额的选择；用户更换模型通常是出于成本或配额原因，因此不得悄悄切回原模型。
