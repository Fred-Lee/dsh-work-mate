# task-intake Delta

## MODIFIED Requirements

### Requirement: 执行器与仓库一对一

一个 Super-agent 实例 SHALL 只服务一个仓库；多仓库 SHALL 由多个实例承担，
每个实例服务一个仓库。

面板 SHALL 按待办的 `repo` 与**已接入执行器的仓库集合**决定是否可投递：
`repo` 在该集合内时才 SHALL 显示可指派；不在时 SHALL 显示
「未接入执行器（仓库 X）」、列出已接入集合，且 SHALL NOT 写入 `assigned=true`。

已接入集合来自 `Config.executorRepos`（数组）；`Config.executorRepo`（单值）SHALL 保留
为长度 1 的特例。集合为空时面板 SHALL 视为「未配置限制」，一律允许指派——这与旧行为
一致，避免未配置的部署突然全被拒绝。

多执行器时面板 SHALL 聚合各端点的健康与 Ticket 投影：单个端点离线 SHALL 只影响它
服务的那批待办，SHALL NOT 让整块任务视图变成离线。

面板 SHALL NOT 通过修改 prepare 命令或环境变量来让一个实例跨仓库执行。

#### Scenario: 非主仓任务不假装排队

- **WHEN** 提案有 `a`、`b` 两个 target，而执行器只接入了 `a`
- **THEN** `b` 的任务显示「未接入执行器（仓库 b）」且不可指派；`a` 的任务正常投递

#### Scenario: 同仓任务可指派

- **WHEN** 待办的 `repo` 属于已接入集合
- **THEN** 卡片提供指派动作，指派后写入 `assigned=true`

#### Scenario: 一个端点离线不影响其他

- **WHEN** 配置了两个执行器端点，其中一个不可达
- **THEN** 面板显示「2 个执行器，1 个离线」，可达端点服务的待办仍正常投影，
  不可达端点的那批显示离线原因而非空白

#### Scenario: 未配置集合时保持旧行为

- **WHEN** `executorRepos` 与 `executorRepo` 都未配置
- **THEN** 所有待办均可指派（与引入本要求之前一致）
