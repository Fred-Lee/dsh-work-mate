# workmate-command Specification

## Purpose
TBD - created by archiving change add-workmate-command. Update Purpose after archive.
## Requirements
### Requirement: `/workmate` 斜杠命令

实现 SHALL 在 `commands` 服务可用时注册名为 `workmate` 的命令，其 handler SHALL 在不经过
模型的前提下执行；命令 SHALL 支持 `help`、`status`、`wiki` 三种输入；
`status` SHALL 只做只读探测（索引新鲜度与 wiki 产物），SHALL NOT 触发模型调用；
`wiki` SHALL 在生成前保证 SSE 归一代理可用、按需重建索引，并按产物事实
（`complete` / `pages`）汇报；产物不完整或无凭据时 SHALL 返回 `kind: "error"` 并给出原因；
`commands` 服务缺失时插件 SHALL 保持 ACTIVE 且其余能力不受影响。

#### Scenario: 帮助

- **WHEN** 输入 `/workmate` 或 `/workmate help`
- **THEN** 返回 `kind: "success"` 且文本含 `wiki` / `status` 用法

#### Scenario: 只读状态

- **WHEN** 输入 `/workmate status <已索引仓库绝对路径>`
- **THEN** 返回索引是否 stale 与 wiki 的 `pages` / `complete`，且不产生 LLM 调用

#### Scenario: 确定性生成

- **WHEN** 输入 `/workmate wiki <路径>`
- **THEN** 先保证代理可用再生成，结果文本含 `index.html` 路径与 `complete`/`pages`

#### Scenario: 半份产物按错误汇报

- **WHEN** 生成结束但缺少 `index.html`
- **THEN** 返回 `kind: "error"`，文本包含已写出页数与重跑提示

#### Scenario: 输入非法

- **WHEN** 路径不存在或子命令未知
- **THEN** 返回 `kind: "error"` 且文本指向 `help`

