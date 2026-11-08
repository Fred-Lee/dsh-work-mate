# multi-target-worktree Delta

## MODIFIED Requirements

### Requirement: 按目标清理与回收

`archived` 转换 SHALL 回收该提案全部 target 的 worktree/Ticket 目录：先确认对应实现分支
已合并进各自 `baseBranch` 且该 Ticket 已结束，再释放端口、执行 `git worktree remove`；
单个 target 回收失败 SHALL 记录 warn 并继续其余 target，不阻断归档。面板 SHALL 允许
单独释放某个 target 的目录，未合并的 target 释放前 SHALL 要求二次确认。

合并确认与回收守卫 SHALL 以调用方解析出的主干（`lifecycleMainBranch`）为准，
SHALL NOT 依赖回收器内部的字面 `'main'` 兜底；比对前 SHALL 对 `origin` 做
best-effort `git fetch <origin> <branch> <onto>`，fetch 失败（本地-only 仓库、离线）
SHALL 静默继续本地比对，SHALL NOT 使校验失败。

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

#### Scenario: 远端已合并而本地基线落后

- **WHEN** 实现分支的合并发生在远端（MR/PR），本地基线分支尚未拉取
- **THEN** 回收与合并校验仍判「已合并」（fetch 把远端基线取回后比对），目录正常回收

#### Scenario: 本地-only 仓库不受影响

- **WHEN** 仓库没有 `origin` 远端或当前离线
- **THEN** fetch 静默失败，校验按本地引用进行，行为与引入 fetch 之前一致
