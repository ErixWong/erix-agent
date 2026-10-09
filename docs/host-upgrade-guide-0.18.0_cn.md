# 宿主升级指南：0.18.0

0.18.0 没有任何删除：签名没改、工具没少、存储格式没动。但它对**所有**宿主都不是无感的
——有三种宿主习惯会坏：钉住 judge 的写工具集合、断言文件工具的名字清单、逐字匹配工具输出
文本。每种坏法下面都给了一条自查；三者都不沾，就直接升。

新符号一律从 **`erix-agent/tools` 子路径**进来，包根没有。如果你写的是
`import { createFileTools } from "erix-agent"`，这条导入拿不到符号（见第 6 节）。

## 1. 变更一览

| 变更 | 会打断这样的宿主 | 章节 |
| --- | --- | --- |
| `writeToolNames` 默认值现在是 `["writeFile", "edit"]`（issue #191） | 依赖默认值，**或**自己传了列表却指望 `edit` 被并进来 | 2 |
| `createFileTools().definitions` 从 6 项变 7 项（issue #195 的 `searchText`、issue #191 的 `edit`） | 断言工具名清单或它的长度 | 3 |
| `rg` / `grep` 在**每次**结果尾部挂一行弃用提示（issue #195，节奏按 #188 分级） | 逐字匹配别名输出、数它的行数、或把「最后一行」当数据 | 4 |
| 截断 marker 文案与人类可读字节单位属 **Experimental**（issue #196） | 解析 marker 文本或断言它的逐字措辞 | 5 |
| 文件工具与技能包 loader 只从 `erix-agent/tools` 导出（issue #184 / #197） | 从包根导入它们 | 6 |

## 2. `writeToolNames`：默认值多了一项

judge 判断「自上次评估以来是否发生过写」看的就是 `writeToolNames` 里的工具名。0.18.0
之前这个集合是 `["writeFile"]`，所以 `edit` 对它不可见——一个只做了编辑的 run 会被判成
「没写过」。默认值现在是两个名字，单一真值是 `src/reflection/judge.js` 里的
`DEFAULT_WRITE_TOOL_NAMES`。

**显式传是整体替换，不是并入。** 你自己传 `writeToolNames` 就逐字用你那个数组，`edit`
**不会**被加进去。今天钉 `["writeFile"]` 的宿主升完仍然带着 0.17 的那个盲区，而且症状是
静默的（守卫不再触发，而不是报错）。

```js
// 那个默认常量是模块级的：它不在公开导出面上，所以没法 import 进来做比对。
// 想要新行为，就把两个名字自己写出来。
const judge = createReflectionJudge({ /* … */ writeToolNames: ["writeFile", "edit"] });
```

自查——先找出所有钉这个选项的地方，再逐个调用点决定：

```bash
grep -rn "writeToolNames" src/ bin/ your-host/   # 每一处显式列表都是一个决策点
```

自查——默认值**不可导入**，所以模块外部拿不到它、没法直接断言；把它钉在你自己的测试里：

```bash
node -e "import('erix-agent').then((m) =>
  console.log(Object.keys(m).filter((k) => /write.?tool/i.test(k))));"   # → []
```

真正能抓住这次回归的是行为自查：跑一个**唯一**的写操作是 `edit` 的会话，然后回看你自己的
judge 记录——它必须显示发生过写。0.17 用默认列表时它显示没有；升级后如果你显式传了
`["writeFile"]`，它照样显示没有。

依赖默认值的什么都不用做。自己传列表的，把 `"edit"` 加进去，除非你能说清为什么不加。

## 3. `definitions` 从六项变成七项

```
readFile / searchText / rg / grep / tree / edit / writeFile
```

`searchText`（issue #195）和 `edit`（issue #191）都在 0.18.0 落地，所以还拿着 0.17
六名单元的宿主一次过期两处。权威断言在 `test/contract/file-tools.js` 的
`fileToolsContract`——把它跑在你自己的注册上，别信手抄的清单。

自查——把你实际安装的包真正暴露的名字打出来：

```bash
node -e "import('erix-agent/tools').then((m) => {
  const names = m.createFileTools({ cwd: process.cwd() }).definitions.map((d) => d.name).sort();
  console.log(names.length, names.join(','));
  // 期望：7  edit,grep,readFile,rg,searchText,tree,writeFile
});"
```

凡是按项数索引的东西都要一起改：registry fixture、快照里的「N 个工具」断言、权限/白名单
表、副作用分类器。**`edit` 是写**：它的 `path` 参数必须和写操作归到一类，不能算读（见
[host-consumer-contract_cn.md](host-consumer-contract_cn.md) 的「文件编辑工具 `edit`」一节）。

## 4. `rg` / `grep` 现在每次结果都以弃用提示收尾

这一行是**每次调用**都挂，不是只有截断时才挂。在一个完全无命中的运行上实测：

```
（无命中）
[已跳过 1 个二进制文件]
[已弃用 rg：它是 searchText 的薄别名，请改用 searchText with mode="regex"；rg 将在后续 major 版本移除]
```

`grep` 的尾行是 `…请改用 searchText with mode="regex" and name_pattern；grep 将在后续
major 版本移除]`。

会被打断的是：比对整段结果字符串的断言、「最后一行就是最后一条命中」的解析、以及按行数算
预算的地方。正确做法是迁到唯一的搜索入口，而不是学着把这行剥掉：

```js
// searchText：mode **必填且无默认值**
{ name: "searchText", input: { pattern: "needle", mode: "literal", name_pattern: "*.js" } }
```

`rg` / `grep` 的名字与入参形状照用（属 Stable 面）：删它们要等 major bump（issue #188
三层分级），所以不必连夜改——但新代码不要再加调用点。注意别名默认 `is_regex=true` 意味着
默认走**正则**，而 `searchText` 拒绝猜（不传 `mode` 就是显式报错）。

## 5. marker 文案与字节单位属 Experimental

截断 marker 这一版改了形态（现在会给出「下一步」，字节数也渲染成 `256KB` / `1.5MB` /
`1.0GB` / `1.5TB`，1024 基数）。这套文案属 **Experimental**：任意 minor 都可能变，marker
文本也在其列。请把断言钉到结构化字段上——搜索工具汇报：

| `metadata` 字段 | 含义 |
| --- | --- |
| `searchHits` / `searchMatchedLines` / `searchFiles` | 本次返回的命中数、命中行数、涉及文件数 |
| `searchLimit` / `searchOffset` | 生效的上限与本次调用的 offset |
| `searchTruncated` | 是否触顶 |
| `searchNextOffset` | 只在截断时出现——原样当 `offset` 传回去即可续读 |
| `searchSkipped.{vendorDirectories,hiddenDirectories,largeFiles,binaryFiles,deniedPaths}` | 跳过账 |

两个限定：

- 这些字段**进 transcript、不上 wire**：模型侧看到的永远只有 marker 文本。你的宿主代码能
  读它们，但别假设模型能读。
- `formatSize()` 与 `toolMarker()` 是 `src/tools/file-tools.js` 的模块级导出，**当前无法从
  npm 包导入**（`exports` 只有 `.` / `./tools` / `./contract-tests`）。想要同样的渲染就自己
  实现——见 [host-consumer-contract_cn.md](host-consumer-contract_cn.md) 里的导出面限定段。

## 6. 导入路径：`erix-agent/tools`，不是包根

```js
// 正确
import { createFileTools, skillDirectories, discoverSkills, loadSkill } from "erix-agent/tools";

// 错误 —— 拿不到符号，它不在包根导出面上
import { createFileTools } from "erix-agent";
```

`package.json` 的 `exports` 恰好映射三个入口：`.`（引擎核心）、`./tools`（可选 tools
库）、`./contract-tests`。`createFileTools` 在 `src/index.js` 里出现 **0** 次，而且这是
设计而不是遗漏：ADR-005 把可选 tools 库挡在主导出之外。`./tools` 子路径承载文件工具
（`createFileTools`、`resolveFileReadMaxBytes`、`truncateDisplayText`、
`FILE_TOOL_DEFINITIONS`、`FILE_READ_MAX_BYTES_DEFAULT`、`MAX_FILE_BYTES`、
`MAX_TREE_ENTRIES`、`GREP_MAX_RESULTS_HARD_CAP`）与技能包 loader（`skillDirectories`、
`discoverSkills`、`loadSkill`、`loadAllSkills`、`buildSkillTools`、
`warnBuiltinToolConflicts`），外加 registry 与 provider 工厂。**没有** `./skills` 子路径。

技能发现还有一个坑：`bundledDir` 是「按意图必须传」的参数。不传就意味着内置技能目录
完全不参与发现——库里不猜任何路径。由调用方传自己那一份（CLI 传的是 `<package>/skills`）。

## 7. 升级自查表

| 如果你的宿主…… | 该做什么 | 用什么验 |
| --- | --- | --- |
| 依赖 judge 默认值 | 什么都不用做——`edit` 已含在默认里 | 只调 `edit` 的 run 必须被记成发生过写 |
| 自己传 `writeToolNames` | 显式加上 `"edit"`，或写清为什么故意不加 | `grep -rn "writeToolNames"` |
| 断言文件工具名字/项数 | 更新成七项清单 | 第 3 节那条 `node -e` |
| 给工具副作用分类 | 把 `edit` 归成写 | 你的分类器针对 `edit` 的用例 |
| 逐字匹配 `rg`/`grep` 输出 | 剥掉尾部 marker，或迁到 `searchText` | 零命中的调用尾部仍有那行弃用提示 |
| 断言 marker 措辞 / 字节文本 | 把断言搬到 `metadata` 字段上 | 第 5 节的字段表 |
| 从包根导入新符号 | 改成 `erix-agent/tools` | `node -e "import('erix-agent').then(m => console.log('createFileTools' in m))"` → `false` |

本系列较早的指南：[0.17.0](host-upgrade-guide-0.17.0.md)、
[0.16.0](host-upgrade-guide-0.16.0.md)、
[0.15.0](host-upgrade-guide-0.15.0.md)、
[0.14.0](host-upgrade-guide-0.14.0.md)。
完整契约正文：[host-consumer-contract_cn.md](host-consumer-contract_cn.md)。
