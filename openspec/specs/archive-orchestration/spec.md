# archive-orchestration Specification

## Purpose
TBD - created by archiving change add-archive-orchestration. Update Purpose after archive.
## Requirements
### Requirement: 归档编排流水线

带可解析 `projectRoot` 的归档 SHALL 执行编排流水线：任务快照 → swarm 并行执行
（未接入时记录性跳过）→ `openspec archive <id> --yes` → `gitnexus analyze --force`
→ 提案状态置 `archived`。每一步 SHALL 产出 step 记录（动作、状态、输出摘要）；
任一步骤失败 SHALL 终止流水线且提案状态保持不变。无 projectRoot 的归档 SHALL
保留 M2 纯状态机语义。

#### Scenario: 完整归档闭环

- **WHEN** 对状态为 executing、openspec 目录存在的提案触发归档
- **THEN** 项目侧 `openspec/changes/archive/` 出现该 change 目录、提案状态为
  `archived`、结果含全部 step 记录

#### Scenario: CLI 失败不污染状态

- **WHEN** `openspec archive` 执行失败（如目录被占用）
- **THEN** 后续步骤跳过、提案仍是 `executing`、结果带失败 step 的错误摘要

#### Scenario: swarm 缺席时的记录性跳过

- **WHEN** swarm 编排插件不在宿主中
- **THEN** 编排在任务快照后插入一条 `skipped` 的 swarm step 并继续后续步骤

