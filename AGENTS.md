# erix-agent — 项目 AGENTS.md

> 项目特有规则；共享约定见 `~/projects/AGENTS.md`（全局）。本文件随仓库走（GitHub: ErixWong/erix-agent）。

## 1. 项目定位

**自研无头编码 agent（headless agent）**：零依赖 LLM agent 运行时（双协议流式 + 工具循环 + 压缩 + checkpoint），面向**无人值守、宿主调度**场景（app_container / touwaka 嵌入式底座）。

- 产品形态 = **无头 agent**：`runToolLoop` 单任务生命周期（起/跑/停/恢复/事件流），执行（executeTool）由宿主注入；**边界止于单个任务生命周期**，多角色编排/仲裁/重试调度是宿主职责，不吸入库
- **CLI（bin/）是验证器/调试器，不是重点**：交互 TUI + `chat` 单次入口（可作 bench 入口）；能力验证走 erix-bench 无头 harness（容器内驱动 + 判分器，`--agent erix|pi` 对照），交互 repl 只测人机协作
- 与 pi 的关系：**pi = 交互 agent（人在环）；erix = 无头 agent（无人环，宿主调度）——互补不竞争**
- 安全分层（ADR-009）：agent 不内置安全，**谁用谁负责**（本地=信任域；嵌入容器由宿主隔离）
- 红线：**零 npm 依赖**（只 import node: 内置 + 相对路径）、纯 ESM、Node 22+、不提交 key/token

## 2. 代码结构

```
src/          # 引擎：providers(openai/anthropic 双协议) messages compact store config tools loop
bin/          # CLI（验证器/调试器）：cli.js(入口/chat) repl.js(TUI) tools.js(内置工具+提示词) skills.js mcp.js config.js
test/         # 单测（node --test）
fixtures/     # 测试夹具（mock MCP server）——⚠️ 不能放 test/ 下（node --test 会跑 test/ 所有文件导致卡死）
examples/     # 示例（skills/ 入库示例）
docs/         # 设计文档 + ADR（决策记录）
```

## 3. 开发命令

| 命令 | 用途 |
|---|---|
| `npm test` | 全量单测（node --test，当前 236 通过，~1.5s） |
| `node --check <file>` | 语法保底 |
| `node bin/cli.js ...` | 本地跑 CLI（无需安装） |

- 测试隔离约定：涉及 `~/.erix`、`~/.pi` 的测试必须注入 `home`/`cwd` 参数（skills/mcp/config 测试均有先例），避免真实用户配置污染。

## 4. npm 发布指南（2026-08 新政实测）

### 前置（package.json）
- `private` 必须移除（否则 403）；改 JSON 用 node 脚本，别用 sed 删行（尾逗号破坏 JSON）
- `files`: `["src", "bin", "README.md"]`——发布前 `npm publish --dry-run` 看 tarball
- `repository.url` 用 `git+https://...` 格式（或 `npm pkg fix`）
- 版本：`npm version <x.y.z> --no-git-tag-version`（功能完整首版别用 0.0.0）

### npm 2026 新政（TOTP 停止 + bypass token 限制）
- ❌ TOTP 新增已不支持（`enable-2fa` 404）
- ❌ bypass-2FA granular token 2026-08 起失去直接发布权
- ✅ **唯一路径（npm@12）**：
  ```bash
  npm i -g npm@12                    # 升级（系统 npm 10 不支持新流程）
  npm login --auth-type=web          # 浏览器 OAuth + passkey
  npm publish                        # device flow：终端打印认证 URL
  ```
- **publish 交互（2026-09 实测）**：即使已 `npm login`，`npm publish` 仍会触发**一次独立的 device flow 认证**（EOTP，每次发布都要再认证一次，不是登录过就免）——终端打印 `https://www.npmjs.com/auth/cli/<id>` → 复制到浏览器打开 → 手机相机扫 passkey 确认 → 命令行自动继续
- ⚠️ **prerelease 版本必须显式 `--tag`**（npm12 强制）：`npm publish --tag latest`，否则报 `You must specify a tag when publishing a prerelease version`
- ⚠️ 认证 URL 在非 TTY（脚本/管道）下会打码成 `***`——**必须用户在自己终端跑**；agent 侧可用 python pty 方案捞真实 URL 转给用户（见踩坑速记 4）
- ⚠️ **"Press ENTER to open in the browser..." 提示不要按**（2026-09 实测）：无浏览器时按 ENTER 触发 `xdg-open` 失败会直接杀掉 npm（`command failed` code 3）。不按 ENTER 时 npm 会持续轮询认证状态，正常完成

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
1. 改 package.json 用 node 脚本；改完 `node -e "JSON.parse(...)"` 验证
2. 发布前 unlink 本地 link（`@erix/llm-kit` 历史残留）
3. npm 政策变化快（TOTP/bypass 2026 转型）——遇 403/EOTP 先查官方 changelog
4. 无浏览器 + 非 TTY 环境的认证流程（2026-09 实测，本机无桌面）：用 python pty 包装 npm（`pty.fork()` + `select` 读输出），`setsid nohup` 完全脱离进程组防 bash 工具清理；脚本里正则提取 `https://www.npmjs.com/(login|auth/cli)/[0-9a-f-]+` 写文件，agent 读出 URL 转交用户浏览器操作；**不要自动按 ENTER**（见上）。登录成功写 token 进 `~/.npmrc`；发布成功标志为日志行 `+ erix-agent@<ver>`；参考实现 `/tmp/npm-pty-login5.py`

## 5. Git 与远程

- **origin** = 自托管 Gitea（`git.erix.vip/eric/erix-llm-kit`，归档备份）
- **github** = `ErixWong/erix-agent`（主远程，公开）
- 提交流程：分支 `feat-YYMMDD-NN-<描述>` → PR 合并 main（大改动）；小改/文档可直推
- 提交信息：conventional commits + 中文摘要

## 6. 本地运行数据（不进仓库）

```
~/.erix/
├── config.json        # LLM 配置（endpoint/model/apiKey/maxOutputTokens/contextWindowTokens）
├── mcp.json           # MCP server 注册（标准格式，可复用 ~/.config/mcp/mcp.json）
├── <session>.json     # 会话历史（id 按 cwd 派生）
├── skills/            # 用户级 skill（自描述协议）
└── todos/             # 任务清单（按 cwd 隔离）
```

## 7. 本机真实环境事实

- relay：`api.ai.erix.vip/v1`，模型 `kimi-for-coding`（contextWindow 131072、maxOutputTokens 32768 → 自动压缩预算 ~85k）
- 工具执行/验证：erix 干活用 `node bin/cli.js chat`（本仓库），监督者看 `/tmp/erix-*-log.txt` 逐步输出
- erix 编码任务红线：每个文件只读一次（offset/limit 分段）、长任务先 todo_add 拆解、汇报前验证声明
