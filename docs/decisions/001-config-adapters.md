# ADR-001：LLM 配置走 ModelConfigProvider 适配器，内置 json-file

- 状态：已决策（2026-08-29）
- 背景：两个消费方的 LLM 配置来源完全不同——app_container 存 `system_settings` 表
  （只写不读的 key + `pi_models` 表的窗口元信息 + env 兜底）；touwaka 存 MySQL 模型表 + expert 配置。
  库不可能也不应该规定存储。

## 决策

库定义 `ModelConfigProvider` 接口（`resolve(slot?) → ModelConfig`），内置三种实现：

| 适配器 | 用途 |
|---|---|
| `static` | 测试/调用方直接传对象 |
| `env` | 纯环境变量（`LLM_KIT_PROTOCOL/ENDPOINT/MODEL/API_KEY/…`） |
| `json-file` | **最简单可用形态**：一个 JSON 文件描述全部槽位 |

json-file 形态示例：

```json
{
  "slots": {
    "default": { "protocol": "anthropic", "endpoint": "https://…", "model": "claude-…",
                 "apiKeyFile": "/home/eric/.config/mcp/creds/llm.key",
                 "contextWindowTokens": 200000, "maxOutputTokens": 8192 },
    "fold":    { "protocol": "openai", "endpoint": "https://…", "model": "qwen-flash",
                 "apiKeyEnv": "FOLD_API_KEY" }
  }
}
```

**apiKey 三级间接引用（一等公民）**：`apiKey`（直给）→ `apiKeyEnv`（环境变量名）→
`apiKeyFile`（600 凭据文件，对齐平台 `~/.config/mcp/creds/` 约定）。
凭据文件引用使配置 JSON 本身可以入库/入仓而不含密钥。

**slot（按任务的可选模型槽位）**：`resolve("fold")` 拿不到就回落 `"default"`。
这对应 app_container pi-agent-runtime.md §8.7 预留的"将来按任务轻量扩展"——
库第一天就把槽位机制做出来，项目侧配置可以永远只用 default。

## 理由

- 文件系统是最低公分母：任何项目（包括脚本、worker、本地调试）都能用，零基础设施。
- DB 适配器（app_container 的 system_settings 包装、touwaka 的模型服务包装）留在项目侧，
  实现同一个接口即可，库里不出现任何 DB 依赖。
- v1 不做缓存/热 reload：`resolve()` 每次读文件（一次小文件读，成本可忽略）；
  调用方要缓存自己包一层。简单且永远正确。

## 后果

- 项目侧接入 = 写一个 30 行的 provider 包装。
- 将来加远程配置（如 Consul/etcd）只需新适配器，不动接口。
