# Tasks — Fail Fast Wiki Credentials

- [x] 1. 凭据解析链加入钥匙串（`resolveGitnexusApiKey` / `withResolvedApiKey`），来源只报名字
- [x] 2. `Config.gitnexusApiKeyKeychainService` + 装配（`setGitnexusKeychainService`）
- [x] 3. `gitnexusWiki()` 预检：无凭据不启动 CLI，给出可执行说明
- [x] 4. `inspectWiki(startedAt)` 陈旧产物守卫（`staleArtifacts`）
- [x] 5. 命令/工具输出改为一行判决（✅ 成功 / ❌ 未完成 + 警告行）
- [x] 6. 测试：钥匙串优先级与不回显、无凭据不 spawn、陈旧产物不冒充成功、判决文本
- [x] 7. 文档：README 配置表 + 排障 + 常驻系统提示；AGENTS 里程碑
- [x] 8. 验证：真机用钥匙串取 key 跑通 CLI；typecheck / test / build / verify
