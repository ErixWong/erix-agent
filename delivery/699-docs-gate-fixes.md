# #699（主）+ #702（顺带）：文档闸四格误报修复 + 发布面约定

- 分支：`feat-261103-09-docs-gate-fixes-699`
- 基点：main `dc5783f`（已含 #697 的段首日期闸）
- 版本面：本版仍 `0.30.0`；`0.31.0` 只作为**合成切版树**出现在 `/tmp/b699/` 下的副本里（不提交、不改 `package.json`）
- 纪律：每格一次 commit；每格的实测数据当场追加进本文件

## 取证边界

打开过（读 / 跑）的绝对路径：

| 路径 | 用途 |
|---|---|
| `/home/eric/projects/worktrees/erix-699/scripts/docs-drift-check.mjs` | ①②③④ 四格的判据与自测都在这一个文件里 |
| `/home/eric/projects/worktrees/erix-699/scripts/release-day.mjs` | ④ 的窄面反向证（`--sync` 的逐字节比对夹具 `SYNC_FIXTURE`） |
| `/home/eric/projects/worktrees/erix-699/docs/requirements.md` | ④ 的阶段表 `current` 行（`v0.9.0–v0.30.0 — current`） |
| `/home/eric/projects/worktrees/erix-699/docs/requirements_cn.md` | ④ 的中文侧同一行 |
| `/home/eric/projects/worktrees/erix-699/docs/host-upgrade-guide-0.30.0.md` / `_cn.md` | #690 自测靶子（当前版指南 §4 的 bullet 形状） |
| `/home/eric/projects/worktrees/erix-699/docs/host-upgrade-guide-0.31.0.md` / `_cn.md` | 合成 0.31 树上的当前版指南（§4 是**散文**形状，与 0.30 的 bullet 形状不同） |
| `/home/eric/projects/worktrees/erix-699/CHANGELOG.md` | 0.31.0 段（纯删除 + 勘误 + 发版流程，零加法句）与 0.30.0 段（有变更证据） |
| `/home/eric/projects/worktrees/erix-699/AGENTS.md` / `AGENTS_cn.md` | #702 的落点（中英成对） |
| `/home/eric/projects/worktrees/erix-699/scripts/changelog-coverage-check.mjs` | #702 要写进约定面的那三条事实（`issueNumbersIn()` / 段侧取号 / 裁决比较 / `unattributed` note） |
| `/tmp/b699/selftest-before.log` | 真树 0.30 改前基线：198 例全绿（不重测） |
| `/tmp/b699/selftest-cut031-before.log` | 合成 0.31 树改前基线：**54/199 例未达预期**（不重测） |
| `/tmp/b699/selftest-cut031g-before.log` | 同一棵合成树的 git 版（50/199），用来分辨「哪些失败来自树不是 git 仓」 |
| `/tmp/b699/docs-cut031-before.log` / `docs-strict-before.log` | `check:docs` 在切版树上 exit 2 / 真树 exit 0 的改前记录 |

没有打不开的路径。`/home/eric/projects/erix-llm-kit` 未被读写（工单禁）。

## 四格改前 / 改后

（逐格在下面「① …」「② …」小节里填，每格对应一个 commit）

## 改前 / 改后 `--self-test` 条数

| 树 | 改前 | 改后 |
|---|---|---|
| 真树（`package.json` = 0.30.0） | 198/198 绿（`/tmp/b699/selftest-before.log`） | 待填 |
| 合成切版树（`package.json` = 0.31.0） | **54/199 未达预期**（`/tmp/b699/selftest-cut031-before.log`） | 待填 |

## 三态反向证

（待填）

## 改动了哪些既有期望（逐条理由）

（待填）

## #702：约定落在 AGENTS 哪几句

（待填）

## 未验证项

（待填）

## ① `unchanged-surface` 的零归属误报（`collectUnchangedSurfaceErrors`）

**改前**（`scripts/docs-drift-check.mjs`，`declared.namesSeen > 0 && declared.anyMember === 0` 那一支）：

```
fail("unchanged-surface: CHANGELOG 的 ${PKG_VERSION} 段里有 N 处反引号字段名，但一格也没解析出来——
      六格的成员判据（或真值提取器）坏了，本判据正在空跑");
return done();          // 直接收口，指南一侧一格都不判
```

- 0.31.0 是**纯删除版**：段里 70 处反引号全是**已经从导出面消失**的导出名（`estimateMessagesTokens` /
  `setNotesClock` / `NOTE_VALUE_MAX_CHARS` …）。六格量的是「这一版还在的输入面 / 诊断字段 / 磁盘格式 /
  事件 / 默认值 / 终局载荷」，退役导出名按定义进不了六格 ⇒ `anyMember === 0` 恒真 ⇒
  `check:docs` 在 0.31 上**永远 exit 2**（切版树与「切版 + 已补 §4」树都实测过，`/tmp/b699/docs-cut031-before.log`）。

**改后**：

```
notes.push("unchanged-surface: CHANGELOG <v> 段里有 N 处反引号字段名，但一处也没落进六格
           （各格真值规模：diagnostics=N / disk=N / …）——这是「本版只有删除 / 勘误 / 发版流程」的
           合法形状：那些名字已从导出面消失，按定义不属于六格，所以不判红；
           真值集本身抽不出来（提取器坏了）由上面那条「抽不到成员真值」判红（#699 ①）");
```

- **判据一格没删**：`cell.truth()` 返回 null 的那条 `fail("抽不到「X」格的成员真值…")` 原样保留（它在
  零归属分支**之前**跑，所以「提取器坏了」仍然 exit 2）。修的是误报条件，不是判据。
- 「本判据正在空跑」这句话只留在真值集为空的那条 fail 里；零归属的说明里**不出现**它。
- 零归属分支不再 `return done()`：指南一侧照样逐格判（§4 找不到 / 该格缺席 / 写着不变 / 声明变更不点名
  四条都还在跑），只是这一版六格都没有变更证据 ⇒ 按既有的「② 反向」放行。
- 打印里带**每格真值规模**，读者能当场看见「六格都在、只是这一版没动它们」——这是它降级成说明后仍然
  可核对的证据面。
