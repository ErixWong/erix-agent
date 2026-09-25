# 维护策略（内部决策，不对外发布）

> English version: [maintenance-policy.md](maintenance-policy.md)

## 文档修订约定

- **活文档**（architecture.md、testing.md、charts.md、README 等）描述「现在」——行为变更时更新到最新状态；
- **带日期的快照文档**（docs/design/<日期>-*.md、docs/tasks/、docs/research/、评审/会议记录）是时点历史——**不许改写**，变更只在对应 ADR 末尾追加修订记录（如 ADR-007 §issue #55）。

## 技术替代触发条件

1. **需要集成第三个非 OpenAI 兼容的原生协议（Gemini native / Bedrock / Azure）时**，迁移到 AI SDK 作为底座。

## 季度审查（止损阈值）

如果连续 6-12 个月 `app_container` 仍是唯一消费方，且没有启动新的无头用例
→ 收缩为 `app_container` 私有 package，停止维护公共 npm package（将版本管理和 contract-tests 移交给 app_container）。
