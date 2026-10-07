## MODIFIED Requirements

### Requirement: 项目 wiki 导出到 vault

归档编排在提案进入 `archived` 之后 SHALL 调用可选钩子 `onArchived`（当
`Config.wikiVaultAutoExport` 为真且配置了 `wikiVaultPath` 时由调用方接线），
并把结果记为 `vault-export` 步骤。钩子失败 SHALL NOT 使归档失败，
SHALL 记录该步骤为 `failed` 且说明"不影响归档"。

#### Scenario: 归档即同步

- **WHEN** 配置了 vault 且归档成功
- **THEN** 出现 `vault-export: ok` 步骤，摘要包含导出规模

#### Scenario: 导出失败不毁归档

- **WHEN** 钩子抛错（例如 vault 不可写）
- **THEN** 编排仍 `ok: true`，仅 `vault-export` 步骤为 `failed`
