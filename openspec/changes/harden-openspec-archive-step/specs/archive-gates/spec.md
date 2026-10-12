# archive-gates Specification

## Purpose

归档编排的最后一步 `openspec-archive` 此前只按 CLI 退出码判定成败，而
`openspec archive` 在 delta 解析失败时**退出码仍为 0**，只在 stdout 打
`Aborted. No files were changed.`。后果是编排报 `ok`、提案被置为 `archived`，
而 `changes/<id>/` 原地没动、`specs/` 没有新增能力——面板显示归档成功，实际什么都没归档。
本 capability 补充一条要求：这一步的成败 SHALL 由**产物事实**判定，而不是退出码或 CLI 文案。

## ADDED Requirements

### Requirement: 归档步骤的成败由产物事实判定

`openspec archive` 步骤 SHALL NOT 仅凭子进程退出码判定成功。子进程返回后，
归档编排 SHALL 重新读取 OpenSpec 目录事实，确认该变更已不再位于 `changes/<id>/`
且可在 `changes/archive/<date>-<id>/` 找到；只有该事实成立时 SHALL 记 `ok`。

事实不成立时（典型：CLI 打印 `Aborted. No files were changed.` 并返回退出码 0）：

- 该步骤 SHALL 记为 `failed`，归档编排 SHALL 返回 `ok = false`；
- 提案状态 SHALL 停在 `archiving`，SHALL NOT 被置为 `archived`；
- 步骤摘要 SHALL 同时包含 CLI 的输出（供人判读原因）与产物事实
  （该变更目录仍在原地），使失败可诊断而无需复现。

变更本身没有 `specs/` 目录时归档是合法的，该核验 SHALL NOT 因此判失败：
判据是变更目录的去向，与是否存在规格增量无关。

#### Scenario: delta 解析失败时不报成功

- **WHEN** 某变更的 `specs/*/spec.md` 使用非 delta 段头（如 `## Requirements`），
  编排调起 `openspec archive`，CLI 打印 `Aborted. No files were changed.` 且退出码为 0
- **THEN** `openspec-archive` 步骤为 `failed`，编排返回 `ok = false`，
  提案状态保持 `archiving`，摘要含 CLI 输出与"变更目录仍在原地"的产物事实

#### Scenario: 真正归档成功仍记 ok

- **WHEN** 某变更的规格使用 delta 段头，`openspec archive` 退出码为 0
  且该变更目录确实移入 `changes/archive/<date>-<id>/`
- **THEN** `openspec-archive` 步骤为 `ok`，编排继续执行后续的 GitNexus 重索引与状态推进

#### Scenario: 无规格增量的变更不被误伤

- **WHEN** 某变更没有 `specs/` 目录，`openspec archive` 退出码为 0 且变更目录移入
  `changes/archive/<date>-<id>/`
- **THEN** `openspec-archive` 步骤为 `ok`（判据是目录去向，不是有无 `specs/`）

#### Scenario: 幂等重跑仍然放行

- **WHEN** 某变更已在上一次运行中归档成功，再次对同一提案执行归档编排，
  CLI 因变更不在 `changes/` 下而报错
- **THEN** `openspec-archive` 步骤为 `skipped`（不是 `failed`），归档编排不受影响
