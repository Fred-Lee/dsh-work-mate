# 把错位的需求迁回它们真正的能力规格

## Why

审计发现：本会话大量变更（判断层、审批门、面板、提案终止…）的 spec delta 都打在了
**`vault-export`** 上——因为归档校验要求 delta 指向**已存在**的规格目录，而当时只有它现成。
结果 `vault-export` 里堆了 9 条需求，其中 6 条与"导出 wiki 到 vault"毫无关系：

| 需求 | 真正归属 |
|---|---|
| 注入判定在所有创建入口生效 | `decision-nodes` |
| 风险未判定不得通过高风险门 | `approval-gate` |
| Wiki 面板 / 面板长动作的可见反馈 / 面板动作不随详情失败消失 | `workbench-panel` |
| 孤儿提案的终止出口 | `proposal-middleware` |
| Vault 词法检索 | `vault-search`（新增能力规格） |

规格库是"能力的事实来源"，错位会让"某能力有哪些约束"查不到，也会让未来的 delta 继续堆在错误的地方。

## What Changes

- 上述 6 条需求**逐字迁移**到对应能力规格（内容零改动）；
- `vault-export` 只保留 3 条真正相关的：项目 wiki 导出到 vault / Vault 视图笔记 / （词法检索迁出后由 `vault-search` 承载）；
- 新增能力规格目录 `vault-search`。

## Impact

- 纯规格库整理：`openspec/specs/**` 归属变化，**无代码改动**、无行为变化。
