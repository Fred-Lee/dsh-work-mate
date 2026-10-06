# Tasks — Inject API Key From Env

- [x] 1. key 移入钥匙串；`~/.zshrc` 注入 `ESP_XKW_KEY` 并映射 `GITNEXUS_API_KEY`
- [x] 2. `~/.gitnexus/config.json` 删除 `apiKey`
- [x] 3. `execGitnexus` 环境映射（`Config.gitnexusApiKeyFromEnv`，不覆盖已有值）
- [x] 4. `describeGitnexusCredentials()`：只报来源、不回显值
- [x] 5. wiki 工具/REST 回传 `credentials.source`，无凭据时给出可执行提示
- [x] 6. 测试：映射生效/不覆盖、来源优先级、无凭据为 none
- [x] 7. 文档：README 配置表 + 排障；AGENTS 里程碑
- [x] 8. 验证：真实 `resolveLLMConfig()` 取到 env 中的 key；typecheck/test/build/verify
