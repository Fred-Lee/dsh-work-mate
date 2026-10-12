# plan-drift Specification

## Purpose
TBD - created by archiving change honest-plan-drift. Update Purpose after archive.
## Requirements
### Requirement: 计划目录内的声明不得算作未触及

`computeDrift` SHALL 接受调用方传入的被忽略前缀；落在其中的声明 SHALL 出现在
`excluded` 字段，SHALL NOT 出现在 `missing`，SHALL NOT 影响 `driftRatio`。
判定 SHALL 在前缀与声明互为覆盖关系时都成立（声明等于前缀本身也算落在其中）。

#### Scenario: 声明自己的 spec 目录不算漂移

- **WHEN** 提案声明 `openspec/changes/p1/specs/**`，而调用方把 `openspec/changes/` 传给 ignoredPrefixes
- **THEN** 该声明出现在 `excluded`，`missing` 中不含它

#### Scenario: 声明恰好等于被忽略的前缀

- **WHEN** 声明是 `openspec/changes/p1`，被忽略前缀也是它
- **THEN** 该声明出现在 `excluded`，`missing` 为空

#### Scenario: 未传被忽略前缀时保持旧行为

- **WHEN** 调用方不传 ignoredPrefixes
- **THEN** `excluded` 为空数组，`missing` 与旧实现一致

### Requirement: 未触及的声明必须被看见，但不得阻断

归档编排在 `planDriftGate` 开启时，SHALL 在有未触及声明时产出一条 step，
其状态 SHALL 为 `warn`（新增状态），摘要 SHALL 点名未触及的声明；
该 step SHALL NOT 使 `orchestration.ok` 变为 false、SHALL NOT 中止归档。
`undeclared` 非空时 SHALL 继续产出 `failed` 并中止。

#### Scenario: 未触及声明产生 warn

- **WHEN** 计划声明 `src/a/**`、提交只触及 `src/b.ts`（已声明），且 planDriftGate 开启
- **THEN** `plan-drift` 步骤状态为 `warn`，摘要含 `src/a/**`，归档继续（`ok` 为 true）

#### Scenario: 改了没声明仍然阻断

- **WHEN** 存在未被任何声明覆盖的改动，且 planDriftGate 开启
- **THEN** `plan-drift` 步骤状态为 `failed`，归档中止

#### Scenario: 只看 failed 的消费者行为不变

- **WHEN** 编排结果中出现 `warn` 步骤
- **THEN** 任何以 `status === 'failed'` 判定的消费方（归档服务、面板）行为与之前一致

