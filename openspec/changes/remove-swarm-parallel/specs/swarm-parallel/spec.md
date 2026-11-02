## REMOVED Requirements

### Requirement: 任务装批与 writes 防踩踏

**Reason**: 任务并行执行改由 Super-agent 的 Ticket 承担（change `remove-swarm-parallel`）；WorkMate 不再把 tasks.md 的行装批成 worktree。

**Migration**: 见 `team-evidence` 的「独立审查与测试证据」；审查证据写在变更目录的 `TEAM-REVIEW.md`，合并状态由归档门按 git 事实校验。

### Requirement: 任务级 worktree 与状态

**Reason**: worktree 由 Super-agent 的 `executor.prepare` 创建（`adopt-superagent-openspec-source` design D10b）；WorkMate 只保留规划事实（基线、分支名、端口）与回收。

**Migration**: 见 `team-evidence` 的「独立审查与测试证据」；审查证据写在变更目录的 `TEAM-REVIEW.md`，合并状态由归档门按 git 事实校验。

### Requirement: 合并与冲突仲裁

**Reason**: 合并由 `merging→archiving` 的 git 门判断（`mergeTargets` + `isMergedInto`）；任务级分支的冲突仲裁不再存在，因为没有任务级分支。

**Migration**: 见 `team-evidence` 的「独立审查与测试证据」；审查证据写在变更目录的 `TEAM-REVIEW.md`，合并状态由归档门按 git 事实校验。

### Requirement: 归档验收覆盖未合并任务

**Reason**: 归档的验收判据只看 `tasks.md` 的完成度与目标分支是否已合并，不再看 `swarmTasks`。

**Migration**: 见 `team-evidence` 的「独立审查与测试证据」；审查证据写在变更目录的 `TEAM-REVIEW.md`，合并状态由归档门按 git 事实校验。
