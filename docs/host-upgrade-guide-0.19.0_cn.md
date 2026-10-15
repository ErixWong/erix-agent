# 宿主升级指南：0.19.0

0.19.0 没有任何删除：符号没少、签名没改、存储格式没动。但它对宿主**不是无感的**：有
三处能观测到——CLI 的 `--session` 入口、4xx provider 错误携带的 `code` 取值，以及包从此
**带 `.d.ts` 声明**。每种情况下面给一条自查；三者都不沾，就直接升。

三处都不必你在正常路径上改代码，但各需要一个**决定**：一条出路、一个补上的分支（针对以
前读起来是 `unknown` 的取值）、以及看一眼那些一直在、却从没被报出来的类型错误。

## 1. 变更一览

| 变更 | 会打断这样的宿主 | 章节 |
| --- | --- | --- |
| `chat --session <id>` 在该 id 没有非空 transcript 时非零退出（issue #168） | 传一个自己都不确定存在的 id，并把「它替我建了一个」当成成功 | 2 |
| `classifyHttpError` 对 400/422/404/409 给出 `invalid_request` / `not_found` / `conflict`（issue #179） | 拿 `code === "unknown"` 当「请求写错了」这一桶 | 3 |
| 包从此携带 `.` 与 `./tools` 的 `.d.ts`（issue #213，#249 / #253 补全） | 是 TypeScript 宿主：原先退化成 `any` 的位置从此会报真实错误 | 4 |

## 2. `--session <id>` 必须指向一个真实存在的会话

`erix chat --session <id>` 在该 id 没有非空 transcript 时会停下：退出码 `1`，外加一句
带出路的提示。

0.18 的文档原话（取自 `git show v0.18.0:README.md`）：

> - `--session <id>` selects the session; without an explicit chat session,
>   `chat` creates a unique ID derived from the working directory.

同一份 README 同一节还写着：*"resuming still requires a non-empty transcript for the
session."* —— **0.18 从未承诺「报个名字就替你建一个」**：那是没被写下来的行为，而且是个
陷阱——id 打错一个字，你得到一个空会话却以为在续跑：零提示，盘上还多一份 transcript。
这就是它算 minor 而非 major 的依据。

实测，同命令、同 transcript 目录、端点不可达；先跑 0.18 那棵树：

```
$ erix chat "hello" --session typo-session-id --dir ./tr          # 0.18
错误：fetch failed                                                # 半句关于会话的话都没有
$ ls ./tr                                                         # 它真的建了一个
typo-session-id.jsonl  typo-session-id.state.json  typo-session-id.status.json
```

```
$ erix chat "hello" --session typo-session-id --dir ./tr          # 0.19
错误：会话不存在：typo-session-id（./tr 下没有它的非空 transcript）。
可用 erix chat -r 列出本目录可续跑的会话，或 --session <完整 id> 传完整 id；不带 --session 则是新建会话（默认 id 形如 <目录名>-<sha256(目录)[:8]>-<随机后缀>）。
$ echo $?
1
$ ls ./tr
outputs/                                                          # 一份 transcript 都没落
```

两个版本的 CLI 文案都是中文，变的只有结果。退出码 `1` 即文档里那行「用法错误 / 会话不
存在」；`erix --help` 的 `--session`、`-c`、`-r` 三行已按新语义写好。

**出路**（就是那条报错自己说的话，没有一句是发明的）：

| 你想做的事 | 怎么说 |
| --- | --- |
| **新建**一个会话 | 干脆不带 `--session`——派生 id 形如 `<目录名>-<sha256(目录)[:8]>-<随机后缀>` |
| 续**本目录最近一次** | `-c` / `--continue` |
| 在本目录的会话里挑 | `-r`——交互式选择器，**需要 TTY**；**没有 `--resume` 这个旗标**，非交互环境改用 `-c` 或 `--session <完整 id>` |
| 精确续某一个会话 | `--session <完整 id>`——id 就是 transcript 文件名去掉 `.jsonl` |
| 给新会话命名 | `erix repl --session <id>`：照旧正常，在 `repl` 里它是命名旗标 |

关于 `-c`/`-r` 能看见什么的两点：`~/.erix/sessions.json` 与 `~/.erix/session-meta.json`
**已退役**（发现改为现扫 transcripts 目录），留在盘上，可以安全删除。而只有派生形状的 id
会进列表：自取的名字、以及目录名落在 `[A-Za-z0-9._-]` 之外（空格、中文 → 文件名被哈希成
`run-h-*`）的那些，看不见但**仍可用 `--session <完整 id>` 恢复**。

自查——找出所有会送到 CLI 的 id，再问它存不存在：

```bash
grep -rn -- "--session" your-host/ scripts/ Makefile   # 以及每个 id 是从哪来的
test -s "$HOME/.erix/transcripts/<完整 id>.jsonl" && echo 可续跑 || echo "0.19 会 exit 1"
```

逐个调用点决定：不带旗标（就是新建）、先解析出 id（终端里 `-c` 或 `-r`）、或留着旗标并
按退出码 `1` 处理，而不是假定 `0`。

## 3. 4xx 错误不再一律报 `unknown`

`classifyHttpError`（`src/providers/errors.js`）是包根的公开导出，同一个 `code` 还会经
`termination.errorCode` 到达宿主（issue #176）。本树实测：

| status | 0.18 的 `code` | 0.19 的 `code` | `retryable`（未变） |
| --- | --- | --- | --- |
| 400 | `unknown` | `invalid_request` | `false` |
| 404 | `unknown` | `not_found` | `false` |
| 409 | `unknown` | `conflict` | `false` |
| 422 | `unknown` | `invalid_request` | `false` |
| 401 / 403 | `auth` | `auth` | `false` |
| 408 | `timeout` | `timeout` | `true` |
| 429 | `rate_limited` | `rate_limited` | `true` |
| 500–599 | `server` | `server` | `true` |
| 其余（实测 418） | `unknown` | `unknown` | `false` |

**重试行为一个字没动**：三个新 code 都不可重试——和它们原先顶着 `unknown` 时一样。变
的是分类：把 `code === "unknown"` 当「改请求、别重试」那桶的宿主，这四个 status 从此掉
进 else 分支。

自查，然后改：

```bash
grep -rn '"unknown"' your-host/   # 每一处以前会接住 400 的桶
node -e "import('erix-agent').then((m) =>
  console.log([400, 404, 409, 422].map((s) =>
    s + '→' + m.classifyHttpError(s, 'x').code).join('  ')));"
# 期望：400→invalid_request  404→not_found  409→conflict  422→invalid_request
```

把这三个名字并进「请求本身有问题」那一支。**`unknown` 那一支别删**——它变窄了，没有
消失。

## 4. 随包 `.d.ts`：会看到新类型错误，`--skipLibCheck` 请保持开启

`package.json` 新增顶层 `types`，`exports["."]` 与 `exports["./tools"]` 各加一个 `types`
条件（`default` 目标与 0.18 逐字相同，运行时解析没变）。声明出自 `prepack` 钩子：tarball
里有，干净检出里一个都没有（实测 `npm run types:build` 之后 `src/` 下 **61** 个）。
`exports["./contract-tests"]` **刻意不带** `types`：导入那个子路径报的是「没有声明文件」，
而不是静默解析到 JavaScript。

在一个一次性搭的 TS 宿主上实测（`tsc --strict --module nodenext`，开着 `--skipLibCheck`），
先对着 0.18 那棵树：

| 宿主编译什么 | 0.18 | 0.19 |
| --- | --- | --- |
| `import { runToolLoop } from "erix-agent"` | `TS7016: Could not find a declaration file for module 'erix-agent'` | **0 错** |
| 同一个文件加 `--allowJs` | 0 错——每个符号都是 `any` | 0 错 |
| `runToolLoop({ provider, executeTool, bogusOption: 1 })` | 0 错（静默 `any`） | `TS2353: … 'bogusOption' does not exist in type { … 56 more … }` |

第三行就是这一版的意思：那条错误不是回退——它是一个一直写错、却没有类型能让它显形的
调用点。改调用点（选项名会查，`provider` / `executeTool` 必填），别靠删声明把安静装回去。

**如实写局限。**「宿主层 0 错」（PR #249 / #253）量的是**入口层**——`runToolLoop`、两个
provider 工厂、`createFileTools`——且是在**开着 `--skipLibCheck`** 时量的，不是对整个包
的断言。同一个宿主文件把 `--skipLibCheck` 关掉，实测 **27 个错，每一个都落在包自己的声明
文件里**：`src/skills/loader.d.ts` 14、`src/run-state.d.ts` 7、`src/reflection/wrapup.d.ts`
3、`src/providers/errors.d.ts` 3。这是本版接受的债，宿主侧的答案是**保持开启**。

自查：

```bash
npx tsc --noEmit --skipLibCheck 2>&1 | grep erix-agent              # 你新增的类型错误（如果有）
npx tsc --noEmit --skipLibCheck --listFiles | grep -c 'erix-agent/.*\.d\.ts'
# 0 = 还在对着 `any` 编译：查装的版本与走的子路径
```

## 5. 升级自查清单

- [ ] 每个脚本化的 `chat --session <id>`：id 有保证，或按退出码 `1` 处理；新建不带 `--session`。
- [ ] 已验证新的回答：`erix chat "x" --session definitely-not-there` → exit `1`，无新 transcript。
- [ ] 非 TTY 的自动化走 `-c`（或完整 id），不走 `-r`；没有代码在发明 `--resume`。
- [ ] `code === "unknown"` 的分支旁已列上 `invalid_request` / `not_found` / `conflict`；`unknown` 桶还在。
- [ ] TS 宿主升级前后各编译过一次；每个新错误都被当调用点的问题读过，而不是被压掉。
- [ ] `--skipLibCheck` 仍开着。

## 6. 2026-10-13 并入 0.19.0 的其他变化 —— **无需改调用点**，但有两处宿主可观测的文案与版式

本版在 2026-10-12 定版但**当时并未发布**；2026-10-13 又落了 16 项改动，**并入同一版而不是另开
0.20.0**。这些改动**没有任何一处需要改调用点**。但其中两处对「逐字钉住字符串或注释」的宿主是
**可观测**的——这一节曾把它们归到“宿主无需任何动作”里，那个说法过于乐观（issue #293，报者
是花时间去定性“不是回归”的宿主）：

- **`readFile` 的续读 marker 文案里新增了文件大小。** `readFile`（`src/tools/file-tools.js`）
  从此回答 `[共 3 行（文件 9B），剩余 K 行；…]`，而此前是 `[共 3 行，剩余 K 行；…]`。语义没变，
  变的是**文案**，而这段文案是发给模型的。若你的宿主逐字钉住这条 marker（`TOOL_RESULT_CONTRACT`
  之外，这几乎只剩的会被宿主逐字钉住的字符串面），那条断言会红——改期望串，不要放宽断言。
- **`runToolLoop` 返回值的 JSDoc typedef 从单行改成多行块**（`runToolLoop`，
  `src/loop/orchestrator.js`）。行为完全一致——九个 `termination.reason` 取值一字未变——但把
  **那段注释本身当机器可读面**做防漂移的宿主（例如从包源码里抠出 `termination:{reason:"end_turn"|…}` 这条
  typedef，与自家常量交叉核对）需要让正则容忍换行与 JSDoc 的前导 `*`。这条值得当作一条规则记下：
  **一段注释只要被当成真值来源引用过（就像 `TOOL_RESULT_CONTRACT` 与契约文档那样），它的版式就属于
  宿主可观测面，而不是内部细节。**

下面列出的那些才是对本节标题所说“无需改调用点”且**同时不被观察到**的改动。

- **`src/index.js` 导出 `createMemoryNotesStore`。** 引擎自带的内存 `NotesStore`，与文件版、CLI 版跑
  在同一份端口语义上（`src/store/notes-port.js`），三者一起过同一套契约测。适用于“笔记只活这一个 run”
  的场景（测试、一次性沙箱、没有可写目录的单发宿主）。
- **`erix_run` 交回完整终稿正文。** 宿主层截断已整体删除：长 `finalText` 与 `artifacts` 路径
  （`transcriptPath`、`judgeLogPath`）完整到手，不再报到一半被切掉。
- **`erix_run` 异步 `action: "result"` 从此真能取到 `finalText`**，异步终局视图也带上了 `diagnostics`
  ——后台 run 在宿主重启之后仍能从盘上回答，不只能靠那个活句柄。
- **`erix_run` 的 `outputSchema` 补上 `verification` 与 `error`（13 键 → 15 键）。** 引擎自己的验证结论
  首次能到模型和宿主手上。请把它读成“**对这份答案的自评**”，而不是“验收”：**只有 `verified` 可当已验证
  事实消费**；`skipped` 是没跑 final guard 的结果，**不是失败**。
- **`erix_run` 的文件读取工具描述带上了实测额度事实**（一条换算式 + 本仓自己复测的行数容量），模型可以自己
  算出“这一轮该读多少行”，不再靠猜；措辞也不再声称本仓有多少个文件。

**采用 `erix_run` 前该知道的两件事**：它**不在 npm tarball 里**（`examples/` 不在 `files` 内），今天能用的
分发方式就是**把 `examples/pi-extension/` 拷到 `~/.pi/agent/extensions/erix-run/`**；它**不独立编号，而是随
本包同一版本号**——因为它跟引擎锁步开发、并且按包名加载那个引擎。安装目录里目前**没有版本痕迹**，所以
“装的是哪一版”今天只能靠文件哈希比对回答。

**给本仓贡献者的一句话**：`node scripts/docs-drift-check.mjs --self-test` **必须在开发树里跑**。在没有那个被
 `.gitignore` 忽略的本机档案目录的检出里，它会有 3 例**已知假红**（它们的期望要点名只存在于开发机上的近邻
文件）——已记录并有意暂不处理，口径见 `AGENTS.md`。

本系列较早的指南：[0.18.0](host-upgrade-guide-0.18.0_cn.md)、
[0.17.0](host-upgrade-guide-0.17.0.md)、
[0.16.0](host-upgrade-guide-0.16.0.md)、
[0.15.0](host-upgrade-guide-0.15.0.md)。
完整契约正文：[host-consumer-contract_cn.md](host-consumer-contract_cn.md)。
