# ADR-021：符号锚点声称链该住在哪一页——评估与搬家方案（issue #644 ③）

> **状态：提案（2026-10-31）。** 本文只做评估并钉下搬家清单，**不搬家**：搬家会改变锚点覆盖面覆盖哪些
> 文档、也会改变那条只增不减的地板怎么分桶，所以它该单独一张单、单独一套反向证，并在**合并后的树上**
> 自己量一遍。

- 关联：issue #642（指令面扫描器 `scripts/agents-directive-scan.mjs`）、issue #644 ① / ②（扫描器自己的
  反向证与 `--sync`）、issue #286 T-a（符号锚点 + 裸行号棘轮）、issue #302（合成树夹具）、issue #164 / #274（文档门）
- 依据：`scripts/docs-drift-check.mjs`（锚点覆盖面 `refScanDocs()`、地板 `SYMBOL_ANCHOR_MIN_UNIQUE`、
  覆盖面下限 `REF_SCAN_DOCS_MINIMUM`、棘轮 `BARE_LINE_REF_BASELINE`）、
  `scripts/agents-directive-scan.mjs`（`DEBT_CEILINGS`）、`scripts/retired-spelling-scan.mjs`
  （`HISTORY_DOC_PATTERNS` + `HISTORY_BODY_PINS`）、`test/docs-anchor-ratchet.test.js`（测试侧的钉子）

## 1. 这条链是什么

`AGENTS.md` 与 `AGENTS_cn.md` 各用一条 bullet 描述 `symbols` 锚点。那条 bullet 先给出只增不减地板的
**当前值**，紧接着在同一句话里挂了一串流水账：每一次抬高它的合并各占一项——「again to N when issue #X's
section landed as an EN/CN pair」那种，每项点名那次契约新节引了哪些符号。

这串账有两个性质，正是本文要处理的：

1. **它是历史，不是现状。** 每一项说的都是**那次合并当时**为真（`measured N groups` 量的是**那棵树**）。
   它对今天的读者不构成任何行动依据。
2. **它住在每次会话都注入的那一页上。** `AGENTS.md` / `AGENTS_cn.md` 是模型不查证就照着执行的一页——
   这正是 issue #642 要给它上闸的理由。

## 2. 它到底占多少（实测）

**只**把链段删掉（中英各一段；「当前值」那一句与两份文件其余部分一律不动）再跑门禁，读数如下：

| 读数 | 今天 | 只删链段之后 |
|---|---|---|
| `AGENTS.md` A 类（工单状态句） | 20 | **8** |
| `AGENTS.md` B 类（会过期的实测抄件） | 24 | **20** |
| `AGENTS_cn.md` A 类 | 4 | **1** |
| `AGENTS_cn.md` B 类 | 29 | **21** |
| `AGENTS.md` 被例外放行的命中 | 11 | 7 |
| `AGENTS_cn.md` 被例外放行的命中 | 38 | 13 |
| `symbols` 唯一 (符号, 文件) 组 | 191 | **186** |
| `symbols` 处数 | 637 | **535** |
| 其中 `AGENTS.md` / `AGENTS_cn.md` | 51 / 51 | **0 / 0** |
| 裸行号棘轮（`BARE_LINE_REF_BASELINE`） | 80 | 80 |

也就是说：这条链占了 A 类的 **20 里 12 条 + 4 里 3 条**、B 类的 **24 里 4 条 + 29 里 8 条**——指令面 77 处
非例外命中里的 27 处——并且它**就是**两份 AGENTS 的符号锚点全部。它一处裸坐标都没有（棘轮一动不动），
因为它引的是符号锚点，或者带登记前缀的外仓路径。

这就是 issue #642 点名的病，用数说话：**一份「服务周期 = 每次合并」的债，住在「今天为真」的那一页上。**
它今天已经收过两次费：`DEBT_CEILINGS` 的 A 类上限从 18 抬到 20（#642 自己的残留条目里记着）。

## 3. 决定

**把链搬去 `docs/`；指令面只留当前值 + 一条复现命令。** 具体到 `AGENTS.md` / `AGENTS_cn.md` 留成这个形状：

> … 因此 `symbols` 自带一条**只增不减的下限** `SYMBOL_ANCHOR_MIN_UNIQUE = 191`：掉下去就是红——那正是
> 被抓住的退化，不是棘轮上升——超过它会换来一句「该抬地板了」。两个数都从脚本自身文本读回，这正是
> `--self-test` 能证明它们真的是锁的原因。现值：`node scripts/docs-drift-check.mjs --verbose`。

这个切法有两条理由，不是「页面短一点」而已：

- 当前值**本来就是门禁持有的常量**，所以 `gate-owned-constant` 例外会把它与 `scripts/docs-drift-check.mjs`
  **当场对账**：抄件一旦与常量现值漂开就不再放行、直接变红。这是指令面上的数字能拿到的最强形态。
- 复现命令取代那本流水账：要历史的人去 `docs/`（以及 `git log`），要今天的数的人跑一条命令。

## 4. 搬家清单（下一张单按序执行）

0. **先在合并后的树上量。** 本文所有数都来自挂着 issue #644 的那棵树；分支上的读数合并后一律作废
   （163 当过低地板就是这么来的）。
1. 建 `docs/symbol-anchor-claim-chain.md` + `docs/symbol-anchor-claim-chain_cn.md`，把链**逐字**搬过去，
   中英两侧项数与顺序一致。切掉链段的地方把句子语法补完整（`… `SYMBOL_ANCHOR_MIN_UNIQUE = 191`：
   掉下去就是红`）。
2. **别让地板掉下去**——这一步决定「搬家」到底是搬家还是删除：
   - 把**两份**新文档加进 `scripts/docs-drift-check.mjs` 的 `SYMBOL_DOCS_STATIC`；
   - `REF_SCAN_DOCS_MINIMUM` 加 2（今天是 13 份点名 + 32 份实扫指南 = 45）；
   - 如果 `test/docs-anchor-ratchet.test.js` 里那份点名清单枚举了静态文档，同步改。
3. **在拼写门里把新的一对归成历史类。** `docs/**` 里没有模式认领的路径按**现状类**扫，而这条链引了退役
   扁平拼写——那样会以 `REGRESSION` 红。给这一对加一条 `HISTORY_DOC_PATTERNS`，并在 `HISTORY_BODY_PINS`
   里按 `node scripts/retired-spelling-scan.mjs` 的**现读**记钉子（绝不手数）。
4. **决定 `paths` 面。** 把这一对也加进 `PATH_DOCS` 才是自洽的选择（符号锚点被校的文档，它的普通路径引用
   也该被校）；代价是那个面多两份文档，且可能翻出链里既有的死路径——改掉它们，别豁免。
5. **上限用 `--sync` 重新推，绝不上手改**（issue #644 ②）：搬完之后四格应落在 §2 那组数附近
   （`AGENTS.md` A 8 / B 20、`AGENTS_cn.md` A 1 / B 21）——但要**重测**，让 `--sync` 写进去，再跑 `--verify`。
6. **证明地板没掉。** `SYMBOL_ANCHOR_MIN_UNIQUE` 必须停在合并树上的值或上升。掉下去**不是**「地板定高了」：
   它意味着目的地不在锚点覆盖面里（第 2 步漏了）或者搬运时丢了锚点（第 1 步）。修搬家，**永远不降地板**。
7. 必须重跑并贴出的门禁：`check:docs`、`check:docs:strict`、`check:docs-spelling`、
   `check:agents-directives`（`--strict` **和** `--verify`）、`node scripts/docs-drift-check.mjs --self-test`、
   `node scripts/retired-spelling-scan.mjs --self-test`、`npm test`。

## 5. 地板为什么不该掉——一段话说完

`SYMBOL_ANCHOR_MIN_UNIQUE` 数的是**整个锚点覆盖面里唯一的 (符号, 文件) 对**，而这个覆盖面本来就装着
`docs/**` 形态的文档（契约中英、架构 / 图表 / 需求对照中英、每一份升级指南）。所以搬家**没有删掉任何一对**：
那一对只是不再被 `AGENTS.md` 引、改成被新文档引，而计数是集合的并。这个数唯一会动的理由是**目的地不在
覆盖面里**——§2 量的正是这件事：链落在面外时 191 → 186 组（−5）、637 → 535 处（−102），因为那 5 对只有
AGENTS 引过。第 2 步做完，同样的 191 对 / 637 处还在，只是分桶变了。**搬完之后掉数 = 搬家丢了锚点，不是
地板定高了。**

## 6. 怎么复现 §2 的数

读数来自一棵一次性克隆的树：只把两段链切掉，别的一个字不动。链段由它自己带的标记界定：

```bash
git clone --no-hardlinks . /tmp/probe-644 && cd /tmp/probe-644
python3 - <<'PY'
en = open("AGENTS.md", encoding="utf-8").read()
i = en.index("(groups measured today:")
j = en.index("CN 94 → 96)):") + len("CN 94 → 96)):")
open("AGENTS.md", "w", encoding="utf-8").write(en[:i] + ":" + en[j:])
cn = open("AGENTS_cn.md", encoding="utf-8").read()
k = cn.index("（**现值** **191 组**")
end = cn.index("`--verbose` 可复核）", k) + len("`--verbose` 可复核）")
open("AGENTS_cn.md", "w", encoding="utf-8").write(cn[:k] + "（现值由脚本自身文本读回，`--verbose` 可复核）" + cn[end:])
PY
node scripts/docs-drift-check.mjs --verbose | grep -E "symbol-anchor:|bare-lines:"
node scripts/agents-directive-scan.mjs | sed -n '/射程三类/,/A = 工单/p'
```

在那棵克隆里 `docs-drift-check` 会把地板报成被违反（186 < 191）——那条红**就是**这次测量：它是「目的地留在
面外」时搬家要付的代价。

## 7. 本记录不管的事

- 搬家本身（本票只评估；搬家会动 `SYMBOL_ANCHOR_MIN_UNIQUE` 的分桶与覆盖面，需要自己的一套反向证）。
- 指令面剩下的债（搬完还活着的 A 8 / 4 与 B 20 / 21 是普通的状态句与实测抄件，靠改写清，不靠搬家）。
- 现在去动 `SYMBOL_ANCHOR_MIN_UNIQUE`、`REF_SCAN_DOCS_MINIMUM` 或 `BARE_LINE_REF_BASELINE` 里的任何一个。
