# api-key-env Specification

## Purpose
TBD - created by archiving change inject-api-key-env. Update Purpose after archive.
## Requirements
### Requirement: 网关 key 的环境变量注入

实现 SHALL 支持把 `Config.gitnexusApiKeyFromEnv` 指定的环境变量映射为子进程的
`GITNEXUS_API_KEY`，且 SHALL NOT 覆盖子进程环境中已存在的 `GITNEXUS_API_KEY`；
映射 SHALL 只作用于 WorkMate 启动的 `gitnexus` 子进程，SHALL NOT 写入任何配置文件。

#### Scenario: 目标变量存在时补齐

- **WHEN** 环境里有 `ESP_XKW_KEY` 且没有 `GITNEXUS_API_KEY`
- **THEN** 子进程环境中的 `GITNEXUS_API_KEY` 等于 `ESP_XKW_KEY` 的值（仅子进程可见）

#### Scenario: 已显式设置则不覆盖

- **WHEN** 环境中已存在 `GITNEXUS_API_KEY`
- **THEN** 其值保持不变，不做任何替换

### Requirement: 凭据来源探测

实现 SHALL 能在不读出、不回显 key 值的前提下报告当前凭据来源，取值限于
`GITNEXUS_API_KEY` / `OPENAI_API_KEY` / 配置的环境变量名 / `config.json` / `none`；
当来源为 `none` 时，wiki 入口 SHALL 附带可执行的配置提示，SHALL NOT 把"没有凭据"
误报为生成失败的原因。

#### Scenario: 无凭据时提示而非空跑

- **WHEN** 环境与 `config.json` 都没有 key
- **THEN** 结果含 `credentials.source = 'none'` 与配置提示，且不因该提示阻断调用

