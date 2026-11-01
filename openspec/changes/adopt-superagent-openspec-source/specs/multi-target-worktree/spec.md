# multi-target-worktree Delta

## MODIFIED Requirements

### Requirement: 按目标原子创建 worktree

`ready→implementing` 的转换 SHALL 先对全部 target 预检：项目已在注册表、根目录存在、
基线分支存在、目标 worktree 路径未被占用、父目录可写。全部通过后 SHALL 逐个创建：
路径 `<root>/.workmates/<proposalId>`、分支 `feature/<proposalId>`（从该 target 的
`baseBranch` 切出）、端口按 `${proposalId}--${project}` 分配、`.env` 端口注入、
`copyFiles` 复制、有 `package.json` 时安装依赖。

任一步失败 SHALL 按逆序回滚已创建的 worktree 并释放对应端口，提案状态 SHALL 保持
`ready`，返回失败的项目与原因。对已存在的 worktree SHALL 幂等复用，不重复创建、
不重复分配端口。

`taskExecutor = 'superagent'` 时该要求 SHALL NOT 适用：目录由 Super-agent 的
`prepare` 创建，WorkMate SHALL 只预检项目根与基线分支、分配端口（键
`${proposalId}--${project}--${taskId}`）并把规划事实写入任务；SHALL NOT 自行执行
`git worktree add`。target 的 `featureBranch` 与 `baseCommit` SHALL 在观察到 Ticket 后
由其投影回写（见 `worktree-plan`）。

#### Scenario: 两个项目都成功

- **WHEN** 一个提案有两个 target 且预检通过（回退执行器）
- **THEN** 两个仓库各出现一条 worktree 与 `feature/<id>` 分支，端口段互不相同，详情逐 target 显示

#### Scenario: 第二个项目失败回滚

- **WHEN** 第一个 target 已建好、第二个的基线分支不存在（回退执行器）
- **THEN** 第一个 worktree 被移除、端口被释放，提案仍为 `ready`，错误指出第二个项目

#### Scenario: 重入幂等

- **WHEN** 对已进入 implementing 的提案重复触发实现（回退执行器）
- **THEN** 已有 worktree 被复用，不产生第二条 worktree，端口分配不变

#### Scenario: superagent 模式只预检

- **WHEN** `taskExecutor=superagent` 且提案进入 implementing
- **THEN** 只校验项目根与基线分支、分配端口并写任务，不产生任何 worktree

### Requirement: 按目标清理与回收

`archived` 转换 SHALL 清理该提案全部 target 的 worktree：先确认对应 `feature/<id>` 已
合并进各自 `baseBranch`，再释放端口、执行 `git worktree remove`；单个 target 清理失败
SHALL 记录 warn 并继续其余 target，不阻断归档。面板 SHALL 允许单独释放某个 target 的
worktree，未合并的 target 释放前 SHALL 要求二次确认。

`taskExecutor = 'superagent'` 时，清理 SHALL 以 Ticket 投影的 `directory` 与
`workmate/<Ticket 短名>` 分支为准，且新增前置「对应 Ticket 已结束」；端口键 SHALL 为
`${proposalId}--${project}--${taskId}`。Super-agent SHALL NOT 负责删除目录，
因此已结束但仍存在的目录 SHALL 在面板可见并可手动回收（见 `worktree-plan`）。

#### Scenario: 归档后全部回收

- **WHEN** 一个双 target 提案归档成功（回退执行器）
- **THEN** 两个仓库的 `git worktree list` 都不再包含该提案，端口表无残留

#### Scenario: 未合并时单独释放

- **WHEN** 用户在面板对一个未合并的 target 点击释放并确认
- **THEN** 该 worktree 被移除、端口释放，提案状态不变，详情标记该 target 无 worktree

#### Scenario: superagent 模式按 Ticket 回收

- **WHEN** `taskExecutor=superagent` 且某 target 的 Ticket 已结束、分支已合并
- **THEN** 该 target 的目录被移除、端口被释放；仍在执行的 Ticket 对应的目录不被删除
