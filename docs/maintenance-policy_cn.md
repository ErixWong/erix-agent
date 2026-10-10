# 维护策略（内部决策，不对外发布）

> English version: [maintenance-policy.md](maintenance-policy.md)

## 文档修订约定

- **活文档**（architecture.md、testing.md、charts.md、README 等）描述「现在」——行为变更时更新到最新状态；
- **带日期的快照文档**（docs/design/<日期>-*.md、docs/tasks/、docs/research/、评审/会议记录）是时点历史——**不许改写**，变更只在对应 ADR 末尾追加修订记录（如 ADR-007 §issue #55）。

## 技术替代触发条件

1. **需要集成第三个非 OpenAI 兼容的原生协议（Gemini native / Bedrock / Azure）时**，迁移到 AI SDK 作为底座。

### 修订注（2026-10-10，issue #189）——把规则 1 里的「第三种协议」定义清楚

上面的规则 1 **原文一字未改**；本注只钉住它没定义清楚的那个词（「第三个非 OpenAI 兼容的原生协议」），并记录一次裁定，避免后人重新探一遍。

- **计入什么**：计数单位是**非 OpenAI 系厂商**且需要自己的适配器的原生协议。已交付的两种是 OpenAI 兼容的 `chat/completions` 与 Anthropic 的 `messages`；触发器是下一种（第三种），且它必须来自 **OpenAI 系以外的厂商**——规则 1 已列的三个名字（Gemini native / Bedrock / Azure）是**例示而非穷举**。
- **不计入什么**：OpenAI 系自己多一个 API 形状。**OpenAI Responses（`/v1/responses`）已裁定为范围外，明确不构成触发器**（issue #189，maintainer 2026-10-10 定案原话：「不需要考虑 response api 吧，没有刚需」）。按字面读，规则 1 会把它吞进来——Responses 不是 `chat/completions` 兼容协议，看上去恰好就是「第三种协议」——但计入它从来不是本意，本注关的就是这个字面读数。
- **为什么**：reasoning item 跨轮携带本质是**宿主**的多轮编排，它在库边界的另一侧（`AGENTS_cn.md` §1（对应英文 `AGENTS.md` §1）：「**边界止于单个任务生命周期**」），也与 `docs/requirements.md` §2 那条「不要成为“mini pi”」的非目标一致。这是**范围决定，不是能力缺失**——该端点在我们 relay 上确实进了 API 层（issue #189 实测：`/v1/responses` 返回网关 401，对照组 `/responses` 与 `/bogus` 都是 200 + 同一份前端 HTML），宿主真要 OpenAI reasoning 模型的跨轮 reasoning item，走它自己的 relay / 适配器。
- **对计数器的影响**：Responses 永不进入这个账，AI SDK 迁移的触发条件仍由**第一个非 OpenAI 系厂商**的原生协议决定。

对应的范围条目已同时写进 `docs/requirements.md` §2「非目标（永远不做）」。

## 季度审查（止损阈值）

如果连续 6-12 个月 `app_container` 仍是唯一消费方，且没有启动新的无头用例
→ 收缩为 `app_container` 私有 package，停止维护公共 npm package（将版本管理和 contract-tests 移交给 app_container）。
