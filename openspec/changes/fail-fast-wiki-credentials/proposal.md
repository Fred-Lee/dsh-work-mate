# Fail Fast on Missing Wiki Credentials (and never trust stale artifacts)

## Why

用户重启 harness 后执行 `/workmate wiki`，得到一段**自相矛盾**的输出：

```
代理：started | 语言：chinese
✅ complete=true | pages=47
阅读器：…/index.html
gitnexus wiki failed: Command failed: gitnexus wiki … --lang chinese
（产物：47 个页面，complete=true）
```

复现后根因有两个，都是我们的问题：

1. **harness 环境里没有 key**：该进程既无 `ESP_XKW_KEY` 也无 `GITNEXUS_API_KEY`
   （从没有 source 过新 `.zshrc` 的终端/IDE 启动），于是子进程 `gitnexus wiki` 立刻
   以 `No LLM API key found` 退出（实测 exit=1，几毫秒内）。
2. **我们把上一次运行的产物当成本次成功**：`inspectWiki()` 只数磁盘上的文件，
   而那份 47 页的 wiki 是**更早一次成功运行**留下的 → 于是"失败"与"✅ complete"同时出现。

## What Changes

1. **凭据解析链**（`gitnexus-credentials.ts`）：`GITNEXUS_API_KEY` → `Config.gitnexusApiKeyFromEnv`
   → **macOS 钥匙串**（`Config.gitnexusApiKeyKeychainService`，`security find-generic-password`）
   → `~/.gitnexus/config.json`。钥匙串这一环让"harness 从哪个 shell 启动"不再重要。
2. **预检 fail-fast**：`gitnexusWiki()` 在 spawn 之前解析凭据；没有凭据就**不启动 CLI**，
   直接返回可执行的说明（配钥匙串 / export / 临时写 config）。
3. **陈旧产物守卫**：`inspectWiki(wikiDir, startedAt)` 只在 `index.html` 的 mtime
   ≥ 本次开始时间时才认为"本次产出"；否则标记 `staleArtifacts: true`、`pages: 0`、`complete: false`，
   并说明"目录里是上一次的产物"。
4. **判决清晰**：命令与工具输出以**一行判决**开头 —— `✅ 成功` / `❌ 未完成`，
   附仓库来源、代理状态、语言、页数、阅读器路径；警告（CLI 退出非 0 但产物完整）单独成行。

## Capabilities

### 修改的能力

- `wiki-generation` / `api-key-env`：凭据解析链 + 预检 + 陈旧产物判定 + 判决输出。

## Impact

- 改动：`gitnexus-credentials.ts`、`gitnexus.ts`、`command/definition.ts`、`config.ts`、
  `index.ts`/`api.ts`（凭据来源回传含 keychain）、README 配置表与排障、AGENTS 里程碑。
- 默认行为：未配置钥匙串服务时与之前一致（env → config.json）；配置后即使 harness 环境干净也能生成。
