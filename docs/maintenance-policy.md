# 维护策略（内部决策，不对外）

## 技术替代触发条件

1. **需要接第三家非 OpenAI 兼容的原生协议（Gemini native / Bedrock / Azure）时**，迁到 AI SDK 为底座。

## 季度检视（止损线）

连续 6-12 个月消费方仍只有 `app_container` 一家、且无新增无头场景立项
→ 收缩为 `app_container` 私有 package、停止公共 npm 维护（版本与 contract-tests 移交 app_container）。
