# lifecycle-state-machine Delta

## ADDED Requirements

### Requirement: 实现完成后的自动推进

系统 SHALL 在提案处于 `implementing` 且其关联的**全部**待办都已到达 done 列
（Ticket 终态为 `completed` / `merged` / `dropped`）时，以 `actor: 'system'` 自动推进
`implementing → merging`，并在事件流记录判据快照。该推进 SHALL NOT 视为人工门——
G5（`merging → archiving`）仍是人的决定。

以下任一情形 SHALL NOT 触发自动推进：存在任一待办在 `attention` / `working` / `todo`
列；存在终态为 `closed` 或 `stopped` 的 Ticket；该提案没有任何待办。

自动推进失败（如 Wiki 关联未完成、基线分支缺失）SHALL 静默记录原因而不阻断面板，
且 SHALL NOT 改变提案状态。

#### Scenario: 全部完成自动进 merging

- **WHEN** 提案在 `implementing`，其唯一待办的 Ticket 以 `completed` 结束
- **THEN** 提案自动变为 `merging`，事件流有一条 `actor: system` 的迁移记录，
  面板显示「待合并」而不是「实现中」

#### Scenario: 还有待办在跑不推进

- **WHEN** 提案有三条待办，两条 `completed`、一条仍在 `working`
- **THEN** 提案保持 `implementing`

#### Scenario: 关闭未合并不推进

- **WHEN** 某待办的 Ticket 以 `closed`（PR 关闭未合并）结束
- **THEN** 提案保持 `implementing`，等人处理

#### Scenario: 自动推进受阻时如实报告

- **WHEN** 全部待办完成但 Wiki 关联未登记
- **THEN** 提案保持 `implementing`，面板 notes 显示阻塞原因
