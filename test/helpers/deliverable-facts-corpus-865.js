// issue #865（#862 修法 B）判据 4「老路径逐字不变」用的**不命中语料**（一份定义，两处读）。
//
// 为什么单独一个模块而不是写在测试文件里：判据 4 的形式是「**同一组**消息在 `origin/main` 与在
// HEAD 上，`roundDeliverableFacts` 的既有键逐字相同」。要机器核这句话，base 树必须吃**同一份**
// 语料——语料抄两遍（测试里一份、取数脚本里一份）就等于把对照的公共边丢掉了：抄歪一处，
// 「逐字相同」当场变成恒真断言，而它是这单唯一拦「顺手改坏老路径」的那道闸。
//
// base 侧取数（在 base worktree 里跑，把语料与它的 base 读数一并打印）：
//   node -e "const m=await import('./test/helpers/deliverable-facts-corpus-865.js'); …"
// 取回的数字作为 fixture 写进 `test/judge-deliverable-textualized-865.test.js`（fixture 是**量**的，
// 不是抄的：那文件的 A5 尾部有一条反向锚——base 读数里**不许**出现 `textualizedBlocks`，于是
// 「有人把改动后的读数抄成 fixture」当场红，手改也一样红）。
//
// 语料的选法（不是随手凑十条）：每一条都对着 `roundDeliverableFacts` 的一个既有分支或一条口径，
// 所以「逐字相同」这句话真的覆盖到那条分支，而不是只在文本块上原地打转：
//   · 中英两种正常交付（`deliverableBlocks` / `deliverableChars` / `latestDeliverable` 三格同时非零）；
//   · 多个正文块（`latestDeliverable` 取最新一条，`roundStart` 切点也各量一次）；
//   · 带 `reasoning`（自述那一格的计数与字符数）；
//   · 只有 user 正文（角色口径：user 正文不是该轮交付物）；
//   · 空白正文（`trim() === ""` 的跳过口径）；
//   · 只有 `tool_use` / `tool_result`（`other` 分支）；
//   · 图片与 `raw` 块（`other` 的另外两种形状）；
//   · **在代码块里引用标记**的正常交付（#865 的「不误伤」面：它按 base 口径本来就是交付物）。
// 全部十条都**不命中**「文本化工具调用」判据（含最后那条：标记在 ``` 围栏里，`stripCode` 先剥），
// 所以它们的 `textualizedBlocks` 恒为 0——这正是判据 4 要的「不命中的 run」。

/** 一条消息序列 + 它的名字；`facts` 的取数按 `roundStart` 0 与 1 各来一次。 */
export const DELIVERABLE_FACTS_CORPUS_865 = [
  {
    name: "cjk_delivery",
    messages: [{ role: "assistant", content: [{ type: "text", text: "交付：实现了 X，3824 测试全绿。" }] }],
  },
  {
    name: "ascii_delivery",
    messages: [{ role: "assistant", content: [{ type: "text", text: "Done. Added the flag and ran the suite." }] }],
  },
  {
    name: "multi_text_blocks",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] },
      { role: "assistant", content: [{ type: "text", text: "第三段" }] },
    ],
  },
  {
    name: "with_reasoning",
    messages: [
      { role: "assistant", content: [
        { type: "reasoning", text: "先想一下再写" },
        { type: "text", text: "正文" },
      ] },
    ],
  },
  {
    name: "user_task_only",
    messages: [{ role: "user", content: [{ type: "text", text: "把 X 实现掉" }] }],
  },
  {
    name: "blank_text",
    messages: [{ role: "assistant", content: [{ type: "text", text: "   \n\t " }] }],
  },
  {
    name: "tool_blocks",
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "ls" } }] },
    ],
  },
  {
    // 台账写法：标记写在 ``` 围栏**里**（本仓的文档与 CHANGELOG 就是这么写的）⇒ 不是泄漏。
    name: "marker_in_fence",
    messages: [{ role: "assistant", content: [
      { type: "text", text: "台账里记着：\n```\n<｜｜DSML｜｜ calls>\n```\n以上。" },
    ] }],
  },
  {
    name: "tool_result_round",
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "工具结果已核对，交付完成。" }] },
    ],
  },
  {
    name: "image_and_raw",
    messages: [
      { role: "user", content: [{ type: "image", mediaType: "image/png" }, { type: "text", text: "任务" }] },
      { role: "assistant", content: [{ type: "raw", protocol: "x" }, { type: "text", text: "结论" }] },
    ],
  },
];
