# Inject the Gateway Key from an Environment Variable

## Why

私有网关的 key 之前是**明文写在 `~/.gitnexus/config.json`** 里，而且它还出现在对话记录中。
用户要求：key 不再落在 GitNexus 的配置文件里，改用环境变量，并且变量名用 **`ESP_XKW_KEY`**。

现实约束（源码实测）：**GitNexus 只认 `GITNEXUS_API_KEY` 或 `OPENAI_API_KEY`**，不认
`ESP_XKW_KEY`。所以必须有人做这层映射，且要保证两边都成立：
- 用户手工在终端敲 `gitnexus …`；
- WorkMate 在插件进程里 spawn `gitnexus …`（继承 harness 的环境）。

## What Changes

1. **凭据来源**：key 只存在 macOS 钥匙串（`security add-generic-password -s ESP_XKW_KEY`），
   `~/.zshrc` 里注入 `ESP_XKW_KEY` 并映射 `GITNEXUS_API_KEY`；`~/.gitnexus/config.json`
   中的 `apiKey` 字段**删除**。
2. **插件侧映射**（`execGitnexus` 单一出入口）：`Config.gitnexusApiKeyFromEnv`（默认空）
   指定的环境变量存在、而 `GITNEXUS_API_KEY` 缺失时，**只对子进程**补上
   `GITNEXUS_API_KEY`；已存在则不覆盖（尊重用户显式设置）。
3. **凭据探针**（`describeGitnexusCredentials`）：只用**来源名**回答"这次调用有没有凭据"
   （`GITNEXUS_API_KEY` / `OPENAI_API_KEY` / 配置变量 / `config.json` / 无），
   **绝不回显 key 值**；wiki 工具在无凭据时附一句可执行提示，而不是等 CLI 报空响应。

## Capabilities

### 新增能力

- `api-key-env`：网关 key 的环境变量注入与来源探测（不含明文回显）。

## Impact

- 新增 `gitnexus-credentials.ts`、配置 `gitnexusApiKeyFromEnv`、`execGitnexus` 环境映射、
  wiki 工具回传 `credentials.source`。
- 用户侧：钥匙串 + `~/.zshrc`（已落地并验证 `resolveLLMConfig()` 能取到 key）。
- 不再需要把 key 写进任何仓库文件；`config.json` 只留 provider/baseUrl/model。
