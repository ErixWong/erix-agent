# REPORT-769-r8（工单 #769 R8：CI 唯一红 `docs-drift-check --self-test`——符号锚点下限常量陈旧）

树：`/home/eric/wt-769w8`，开工 HEAD `727af80`，`git status --porcelain` 开工时为空，`node_modules` 是软链。
提交三笔（**没 push、没开 PR**）：

| commit | 内容 | diff |
| --- | --- | --- |
| `10466f8` | 本报告的取证边界 + 两半写法 | — |
| `8c780f5` | **半 A**：`SYMBOL_ANCHOR_MIN_UNIQUE` 242 → 243（+ 四处现值声称同批抬） | `/tmp/769w9-m1.diff`（74 行，5 个文件） |
| `2ff0687` | **半 B**：把两例前提数字与现测的耦合钉成注释（断言一字未松） | `/tmp/769w9-m2.diff`（30 行，只动 `scripts/docs-drift-check.mjs`） |

没碰：`src/`、`test/test-suite-baseline.json`、`test/static-guards.test.js`、`scripts/retired-spelling-scan.mjs`、
`/home/eric/wt-769e4`、`/home/eric/copilot-sbx/*`、主仓。

## 取证边界

每条指回一条我在**这棵树**上真跑过的命令，抄的是现报原文。

1. **根因在场（现测 243 > 下限 242）** —— `node scripts/docs-drift-check.mjs --verbose`（开工时，退出码 0）：

   ```
   ✓ symbol-anchor: 实测 243 组 > 下限 242 组——符号锚点在变多（好方向），请把 SYMBOL_ANCHOR_MIN_UNIQUE 升到 243，否则下限就在空转
   ```

   同轮分母 note：`✓ symbol-anchor: 覆盖面 51 份文档里「符号 + 文件」锚点 814 处（唯一 (符号, 文件) 243 组：…）`。

2. **为什么常量停在 242 会让那两例红（不是断言太严）** —— 两例的 label 与 `expect` **本来就是从常量现算的**：
   `grep -n "SYMBOL_ANCHOR_MIN_UNIQUE" scripts/docs-drift-check.mjs` 命中 `:9162/:9170/:9174/:9175`（半 A 前）都是
   `SYMBOL_ANCHOR_MIN_UNIQUE - 1` / `…` / `… + 1` 的插值，脚本里**没有第二处**字面量 `241`/`242`
   （`grep -n "24[12]" scripts/docs-drift-check.mjs` 只命中常量那一行）。
   于是常量 = 242 而现测 = 243 时：
   - 「退化」那例：退化完是 242 组（第 3 条实测）**等于**下限 242 ⇒ `groups.size < minUnique` 不成立 ⇒ 那条红根本不出现 ⇒ 该例「未达预期」；
   - 「另一侧」那例：变异把常量抬到 243 = 现测 ⇒ 也不红 ⇒ 该例「未达预期」。
   ⇒ 半 A 抬常量到 243 之后，两例的前提数字**自动跟着现测走**（242 < 243 / 升到 244、实测仍是 243），断言方向一字未动。

3. **退化后的唯一组数 = 242（量的，不是算的）** —— 我照该例 overlay 的**同一条** `String.replace`（CN
   `` `defaultSleep`（`src/loop/abort.js:16`） `` / EN `` `defaultSleep` (`src/loop/abort.js:16`) ``，
   `grep -c` 各命中 1 处 ⇒ 靶子在场）手工落到两份契约上再跑 `--verbose`：

   ```
   唯一 (符号, 文件) 242 组
   ```

   抬常量之后再落一次刀跑 `node scripts/docs-drift-check.mjs`（半 B 前置校验，期望非 0）：

   ```
   docs-drift-check: 失败 — 1 处漂移
     ✗ symbol-anchor: 覆盖面里唯一 (符号, 文件) 只剩 242 组，低于下限 **243** 组——符号锚点在**退化成裸行号**：把 `SYM`（`path:N`） 改成不带括号/链接的裸 `path:N`，裸行号棘轮的计数一字不变（它的唯一键里没有文档行号），只有这条下限会红（#286 T-a 返工 R1）。要么把符号锚点补回来，要么在提交信息里写明**新增**了什么并把常量升到 242
   ```

   红条数 `grep -cE "^  ✗"` = **1** ⇒ 「只有符号下限这一条红」成立；该例三条 `expect` 逐条对这段现报验过：
   我拿脚本里那三个正则（用 `CONST = 243` 展开）跑 `re.test(现报文本)`，输出
   `MATCH 例1 expect[0] / MATCH 例1 expect[1] / MATCH 例1 expect[2]`。
   跑完 `git checkout -- docs/host-consumer-contract_cn.md docs/host-consumer-contract.md` 复原。

4. **另一半同理（变异目标 = 现测 + 1 = 244）** —— 临时把常量摆到 244 跑 `node scripts/docs-drift-check.mjs`（期望非 0），现报：

   ```
   docs-drift-check: 失败 — 1 处漂移
     ✗ symbol-anchor: 覆盖面里唯一 (符号, 文件) 只剩 243 组，低于下限 **244** 组——符号锚点在**退化成裸行号**：…
   ```

   同样 `^  ✗` 计数 = **1**；该例 `expect[0]` 对这段现报 `MATCH 例2 expect[0]`。随后把常量改回 243（`git diff --stat` 确认只剩注释改动）。

5. **243 不是从 242 上加出来的** —— `git show 4f9b908:scripts/docs-drift-check.mjs | grep -n "^const SYMBOL_ANCHOR_MIN_UNIQUE"` 现报
   `2610:const SYMBOL_ANCHOR_MIN_UNIQUE = 242;`（`4f9b908` = `Merge pull request #793 …`）⇒ 242 是主干值，243 是扫描器在本树现报（第 1 条）。

6. **常量一改必须同批改的现值声称** —— `grep -rn 'SYMBOL_ANCHOR_MIN_UNIQUE = 24[0-9]' --include="*.md" --include="*.mjs" --include="*.js" .`（改前）命中
   `AGENTS.md:131`、`AGENTS_cn.md:113`、`docs/maintenance/command-reference.md:69`、`docs/maintenance/command-reference_cn.md:55` 各一处 242。
   `test/static-guards.test.js:1355` 的 `CLAIMED_VALUE_CONSTANTS` 拿脚本真值校声称面，`CLAIMED_VALUE_DOC_RULES` 要求两份 AGENTS **各至少一处**且**逐处等于真值、中英同值**
   ⇒ 不动这两处闸 4 必红，所以半 A 同批把四处抬到 243。`REVIEW-772.md:45`（238）、`docs/decisions/021-*`（191）是历史记述，**不动**。

7. **改注释不会挪动任何被锚定的行号** —— `grep -rn "docs-drift-check\.mjs:[0-9]" docs/ test/ | wc -l` ⇒ **0**；
   裸行号棘轮只扫 `src/` 前缀（`BARE_LINE_RE`）。用例条数没动：`MIN_SELF_TEST_CASES = 99` 是下限，
   本轮 `--self-test` 现报 `SELF_TEST_CASES.length` = **223**（与 CI 那条 `3/224` 同分母：失败行印的是 `SELF_TEST_CASES.length + 1`，`+1` 是对照组，见 `scripts/docs-drift-check.mjs:10398`）⇒ 我没增也没删用例。

8. **半 A 生效的直接证据** —— `node scripts/docs-drift-check.mjs --verbose | grep -c "请把 SYMBOL_ANCHOR_MIN_UNIQUE 升到 243"` ⇒ **0**（抬之前该 grep 命中 1）；
   同一轮 `--verbose` 退出码 **0**，尾行 `docs-drift-check: OK — … 共 126 项对齐 package.json 0.31.0 与源码`。
   抬前/抬后两轮 `--verbose` 全文 `diff` 只有一处差异（就是那条 note 消失），所以「127 → 126 项」是那条 note 本身被计入，不是有一项检查悄悄不跑了：

   ```
   62d61
   <   ✓ symbol-anchor: 实测 243 组 > 下限 242 组——符号锚点在变多（好方向），请把 SYMBOL_ANCHOR_MIN_UNIQUE 升到 243，否则下限就在空转
   ```

## 做了什么

**半 A**（`8c780f5`，`/tmp/769w9-m1.diff`）
- `scripts/docs-drift-check.mjs`：`const SYMBOL_ANCHOR_MIN_UNIQUE = 243;` —— **仍是单独一行，形状一字不变、无尾注**
  （自测 `symbolAnchorMinUnique()` 用 `^const SYMBOL_ANCHOR_MIN_UNIQUE = (\d+);` 从脚本自身文本读，`static-guards` 的 `extractConstValue` 用同形读真值；
  半 A 后 `grep -n "^const SYMBOL_ANCHOR_MIN_UNIQUE" scripts/docs-drift-check.mjs` 现报 `2618:const SYMBOL_ANCHOR_MIN_UNIQUE = 243;`）。
- 解释写进**上面那个注释块**，常量行本身不动：该文件 `git show 8c780f5 -- scripts/docs-drift-check.mjs` 的增删计数 = **+9 / -1**，
  其中 `+1/-1` 就是常量那一行（242→243），剩下 **8 行全是注释**。注释内容：本树 `--verbose` 现报逐字、
  「不在旧值上做加法：242 是主干 `4f9b908` 的值 / 243 是扫描器在本树现报」、同批抬的四处现值声称清单、
  以及「为什么只做一半会让自测那例看不见红」（第 2 条）。
- 四处现值声称同批抬：`AGENTS.md`、`AGENTS_cn.md`、`docs/maintenance/command-reference.md`、`docs/maintenance/command-reference_cn.md`。

**半 B**（`2ff0687`，`/tmp/769w9-m2.diff`，只动 `scripts/docs-drift-check.mjs`）
- 两例的**断言一字未动**：`label` 表达式、`overlay`、`expect` 三条、无 `expectFiles` 变化、用例条数不变；
  **没有** `expect`→`expectGreen`、没删例、没加 skip、没改成「任意红」。
- 加的是**注释**（可校：`git show 2ff0687 -- scripts/docs-drift-check.mjs` = **+12 / -0**，且 12 行增文全部以 `//` 开头——`git show 2ff0687 | grep '^+' | grep -v '^+++' | grep -v '^+ *//'` 零命中 ⇒ 零行代码改动）：把「前提数字从常量现算 ⇔ 常量必须等于现测」这层耦合钉在两例上方，引第 1/3 条的现报数（243、242、棘轮 6 vs 6），
  并写明常量陈旧的两种伤法各由哪一例抱住、以及「这两例红在数字上是叫你去量，不是叫你把断言改松」。
- 变异目标因此就是工单要的**现测 + 1 = 244**，label 现报（自测里逐字，见闸 3）：
  `#286 返工 R1 的另一侧：把 SYMBOL_ANCHOR_MIN_UNIQUE 升到 244（实测仍是 243）⇒ 必须红…`。

## 闸（现报原文）

1. `node --check scripts/docs-drift-check.mjs` ⇒ **exit 0**（半 A 后、半 B 后各跑一次，都 0）。

2. `node scripts/docs-drift-check.mjs --verbose` ⇒ **exit 0**，且「请把 SYMBOL_ANCHOR_MIN_UNIQUE 升到 243」**不再出现**
   （`grep -c` ⇒ `0`，见第 8 条）；尾行：
   `docs-drift-check: OK — 版本/默认值/清单（含中英逐处对账）/模块地图/路径/中英骨架共 126 项对齐 package.json 0.31.0 与源码`

3. `node scripts/docs-drift-check.mjs --self-test`（第 1 轮，改动全部落定之后）⇒ 最后一行逐字：

   ```
   docs-drift-check --self-test: OK — 223 例反向证/放行证全部按预期，对照组绿
   ```

   全文 `grep -n "未达预期\|✗"` ⇒ **零命中**（没有失败行）。工单说的「224 例」是 CI 那条失败行的分母
   `SELF_TEST_CASES.length + 1`（`+1` 是对照组），本轮 = 223 + 对照组 ⇒ **无一条未达预期**。CI 那三条红的本轮现报：

   ```
   ✓ #286 T-b1a 区间相交的放行证：删掉 `max_rounds_cap`（termination.js:115）的区间（只留符号 + 文件）⇒ 本判据不适用，必须 0 错 → 仍然 0 错（放行分支有效，不是恒绿）
   ✓ #286 返工 R1：把中英契约的 `defaultSleep`（`src/loop/abort.js:16`）一起退化成裸行号 ⇒ 棘轮一字不变，只有符号下限红（242 < 243） → 1 处红（已点名）
   ✓ #286 返工 R1 的另一侧：把 SYMBOL_ANCHOR_MIN_UNIQUE 升到 244（实测仍是 243）⇒ 必须红，证明这个数是读出来的、不是装饰 → 1 处红（已点名）
   ```

   第 2 轮（工作树 = 三笔 commit 全落定后重跑，用来把 exit 码钉死）：见下面「第 2 轮」。

4. 其余闸：

   ```
   npm run check:docs          → exit 0；docs-drift-check: OK … 126 项 …  /  docs-sync-check: OK — 中英契约标题结构对齐（117 节，锚点齐全）
   npm run check:docs:strict   → exit 0；docs-drift-check: OK … 126 项 …
   node --test test/static-guards.test.js → # tests 58 / # pass 58 / # fail 0 / # skipped 0
   npm run check:docs-spelling → exit 0；--strict: OK — 0 处红
   ```

   全量 `npm test` **没跑**（按工单归主会话复跑）。

## 未验证

- **第 2 轮 `--self-test` 的 exit 码**：第 1 轮我用 `nohup` 后台跑，stdout 拿到了 OK 行与「零条 ✗」，但**没接住退出码**。
  第 2 轮带 `EXIT=$?` 重跑中/已跑，现报以那一份为准；代码面证据：`runSelfTest()` 里唯一的非 0 出口是
  `failures.length` 分支的 `process.exit(1)`（`scripts/docs-drift-check.mjs:10396-10401`），而本轮零条失败 ⇒ 走 `process.exit(0)`。
- 抬常量后 `docs/maintenance/symbol-anchor-ledger{,_cn}.md` **没有加这次的抬底记录**（工单只要求解释写进脚本注释；ledger 是中英成对 + 有命中数钉子的历史文档，
  在「`--self-test` 最多 2 轮」的预算里动它收益低风险高）。⇒ 历史沿革目前只住在脚本注释里，要不要补 ledger 请主会话定。
- CI 环境（node 22 干净检出、无 tag）没本地复放：自测里 `#697（干净检出）：tag 面读不出 ⇒ 日期↔tag 这一半跳过` 一例按夹具跑，本机 tag 面差异不影响它，但 CI 结果仍以 CI 为准。
- 全量 `npm test`、以及 `test/test-suite-baseline.json` 的 3762/3749/13 读数是否受本切片影响：**没跑**（本切片不动测试数，也不动该文件）。
