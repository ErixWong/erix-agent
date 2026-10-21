# 夹具：0.22.0 写的真实账本（跨版本 e2e 的「老账本」）

> **只读夹具，不要重生成。** 这份账本是 **erix-agent 0.22.0 的 CLI 真实产出的原始字节**
> （一字未改、未裁剪、未重排、未脱敏改写）。它不是手写样本：`test/fixtures/message-journal-golden.json`
> 那类手写/合成夹具证明的是「折叠层认这个形状」，这里要证明的是「0.22.0 **真的**写成这个形状」。
> 重生成会让 `examples/cross-version-real-e2e.test.mjs` 的 L1–L3 失去意义（那三条钉的正是
> 这一份产物的形状），也会让「夹具 = 某个确定的历史产物」这个前提消失。
>
> 唯一允许的改动是**同步更新本 README 的说明**；账本与三份侧档的字节不许动
> （`git diff --stat test/fixtures/journal-0.22.0/*.json*` 必须为空）。

## 怎么来的（可复现）

| 项 | 值 |
| --- | --- |
| 产品版本 | `erix-agent@0.22.0`（`npm pack erix-agent@0.22.0` 解包到临时目录，`node package/bin/cli.js --version` → `0.22.0`） |
| 产出时间（UTC） | 2026-10-21T15:18:55Z – 15:19:07Z（4 行，见每行 `ts`） |
| runId | `work-c7d61121-mvi9c4fj-77f54351`（0.22.0 自己生成：`<cwd 目录名>-<sha256(cwd)[:8]>-<随机>`；文件名就是安全 id，`safeRunId(id) === id`） |
| 模型 | 真上游（`slots.default`，模型名见账本各轮 `response.usage`；夹具里**不含**端点、凭据、密钥） |
| 工具调用 | **2 次** `readFile`（`a.txt` → `b.txt`，顺序执行，两个 `tool_use` / `tool_result` 配对齐全） |
| 轮数 | 4 行 = 种子行 `…:engine:round:0:seed` + 轮 1/2/3；`termination=end_turn`、`truncated=false`、无 `.corrupt.*` |

跑法（cwd 是临时工作目录，里面只有两个文件）：

```bash
# 1) 取旧 CLI（不要装到全局，避免把开发机的全局 CLI 换版本）
mkdir -p /tmp/xv022 && cd /tmp/xv022 && npm pack erix-agent@0.22.0 && tar xzf erix-agent-0.22.0.tgz

# 2) 工作目录（文件名与内容即夹具里的 token 来源；runId 前缀 work- 就是它的目录名）
mkdir -p /tmp/xv022/work /tmp/xv022/transcripts
printf 'FIXTURE-ALPHA-7f3c9d21\n第二行：没有关键字\n' > /tmp/xv022/work/a.txt
printf 'FIXTURE-BETA-4a8e15c0\n'                         > /tmp/xv022/work/b.txt

# 3) 用 0.22.0 的 CLI 跑一个「需要 ≥1 次工具」的小任务
#    不带 --session：0.22.0 里 --session 是**续跑入口**，新会话会被它挡掉（exit 1）。
cd /tmp/xv022/work && node /tmp/pack022/package/bin/cli.js chat \
  "请用 readFile 依次读取 a.txt 与 b.txt，然后用一句话同时报出 a.txt 里的 token 与 b.txt 的内容。" \
  --config ~/.erix/config.json --dir /tmp/xv022/transcripts \
  --max-rounds 6 --reflection off --no-notes --no-todo

# 4) 把 --dir 里的产物原样拷进本目录（4 份，见下）
cp /tmp/xv022/transcripts/work-*.jsonl /tmp/xv022/transcripts/work-*.state.json \
   /tmp/xv022/transcripts/work-*.status.json /tmp/xv022/transcripts/work-*.snapshot.json \
   <repo>/test/fixtures/journal-0.22.0/
```

`--dir` 下当时还有 `outputs/<runId>/judge.log`（`--reflection off` 的空壳归档）：与账本形状无关，未收进夹具。

## 目录内容

| 文件 | 字节 | 作用 |
| --- | --- | --- |
| `work-c7d61121-mvi9c4fj-77f54351.jsonl` | 8495 | 账本本体，4 行，**0.22.0 形状**（见下） |
| `…state.json` | 989 | 0.22.0 的 run state 侧档（`asOfRound=3`、`termination.reason=end_turn`） |
| `…status.json` | 97 | 终态侧档（`status=succeeded`） |
| `…snapshot.json` | 2603 | 0.22.0 的 run snapshot（**跨版本续跑时故意不用它**：`S6` 那条断言把快照拿掉再续跑，验「正文来源 = 账本」） |

## 形状要点（本夹具要钉住的东西）

- **没有** `kind:"message"` 行 —— 0.23.0 才有的「一条消息一落盘」形状在这里不存在；
- **没有** `:msg:<round>:<seq>` 键；
- 正文挂在轮行上：`dedupKey` 形如 `<runId>:engine:round:<n>`（种子行是 `…:engine:round:0:seed`），
  行自带非空 `messages`（assistant 的 `reasoning`/`text`/`tool_use` 与 user 的 `tool_result` 都在里面）；
- 轮行还带 0.22.0 的元数据（`response` / `runState` / `textPreview` / `toolUses` / `summary` / `l0facts`），
  末轮多一个 `wrapup`（收尾轮才写）；
- 工具**真的执行过**：`tool_use.id` 与 `tool_result.tool_use_id` 一一配对，结果里带着
  `a.txt` 的 token `FIXTURE-ALPHA-7f3c9d21` 与 `b.txt` 的内容 `FIXTURE-BETA-4a8e15c0`
  （`examples/cross-version-real-e2e.test.mjs` 的 S5 拿前者当「续跑终稿里必须出现」的判据，
  且续跑前会把 `a.txt` 删掉 ⇒ 模型能说出来只能是从账本历史里看到的）。

## 卫生（已逐项检查，改动前请重跑这几条）

- 无凭据：`grep -riE 'sk-[A-Za-z0-9]{6,}|api[_-]?key|authorization|bearer' .` 无命中；
- 无绝对路径：`grep -rE '/(home|Users|tmp|root)/' .` 无命中（工具入参是相对路径 `a.txt`/`b.txt`）；
- 无端点：`grep -r 'ai\.erix\.vip' .` 无命中；
- 内容全是合成的 `FIXTURE-ALPHA-*` / `FIXTURE-BETA-*` token 与一句中文说明，没有任何真实业务数据。
