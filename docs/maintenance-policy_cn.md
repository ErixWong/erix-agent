# 维护策略（内部决策，不对外发布）

> English version: [maintenance-policy.md](maintenance-policy.md)

## 技术替代触发条件

1. **需要集成第三个非 OpenAI 兼容的原生协议（Gemini native / Bedrock / Azure）时**，迁移到 AI SDK 作为底座。

## 季度审查（止损阈值）

如果连续 6-12 个月 `app_container` 仍是唯一消费方，且没有启动新的无头用例
→ 收缩为 `app_container` 私有 package，停止维护公共 npm package（将版本管理和 contract-tests 移交给 app_container）。
