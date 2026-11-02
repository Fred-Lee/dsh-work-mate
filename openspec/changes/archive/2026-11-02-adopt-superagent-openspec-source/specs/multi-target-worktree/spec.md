# multi-target-worktree Delta

## MODIFIED Requirements

### Requirement: 按目标原子创建 worktree

WorkMate SHALL NOT 在提案生命周期里自行创建 worktree：`ready→implementing` 只 SHALL
预检项目根与每个 target 的基线分支、分配任务级端口段（键
`${proposalId}--${project}--${taskId}`）并把规划事实写入待办。目录 SHALL 由 Super-agent
的 `executor.prepare` 在 `<repo>/.workmates` 下创建（见 `worktree-plan`）。

target 的 `featureBranch` 与 `baseCommit` SHALL 在观察到 Ticket 后由其投影回写
（分支名 `workmate/<Ticket 短名>`）；回写 SHALL 幂等，已存在且不同的值 SHALL 视为冲突
并上报而 SHALL NOT 被覆盖。

#### Scenario: 进入 implementing 不产生目录

- **WHEN** 提案进入 implementing
- **THEN** 只校验项目根与基线分支、分配端口并写任务，不产生任何 worktree

#### Scenario: 基线缺失时拒绝转换

- **WHEN** 某 target 的 `baseBranch` 在对应仓库不存在
- **THEN** 转换被拒并保持 `ready`，错误只指出该 target

#### Scenario: 分支回写冲突不静默改写

- **WHEN** 观察到 Ticket 推出的分支名与 target 上已有的 `featureBranch` 不同
- **THEN** 回写记为冲突并上报，已存在的值保持不变

### Requirement: 按目标清理与回收

`archived` 转换 SHALL 回收该提案全部 target 的 worktree/Ticket 目录：先确认对应实现分支
已合并进各自 `baseBranch` 且该 Ticket 已结束，再释放端口、执行 `git worktree remove`；
单个 target 回收失败 SHALL 记录 warn 并继续其余 target，不阻断归档。面板 SHALL 允许
单独释放某个 target 的目录，未合并的 target 释放前 SHALL 要求二次确认。

目录归属 SHALL 以 Ticket 投影的 `directory` 为准（`<repo>/.workmates/workmate-<短名>`），
端口键 SHALL 为 `${proposalId}--${project}--${taskId}`，旧提案级键
`${proposalId}--${project}` 在回收时 SHALL 兜底释放。Super-agent SHALL NOT 负责删除目录，
因此已结束但仍存在的目录 SHALL 在面板可见并可手动回收。

#### Scenario: 归档后全部回收

- **WHEN** 一个双 target 提案归档成功，且两条 Ticket 都已结束、分支都已合并
- **THEN** 两个仓库的 `git worktree list` 都不再包含对应目录，端口表无残留

#### Scenario: 未合并时单独释放

- **WHEN** 用户在面板对一个未合并的 target 点击释放并确认
- **THEN** 该目录被移除、端口释放，提案状态不变，详情标记该 target 无 worktree

#### Scenario: 仍在执行的 Ticket 不被回收

- **WHEN** 某 target 的 Ticket 尚未结束
- **THEN** 该目录不被删除，回收结果说明原因

#### Scenario: 遗留目录可见

- **WHEN** Ticket 已结束但目录仍留在磁盘上
- **THEN** 面板列出该目录并提供手动回收入口
