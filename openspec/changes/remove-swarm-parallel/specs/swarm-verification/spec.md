## REMOVED Requirements

### Requirement: 核验记录挂在任务上且可追溯

**Reason**: 核验记录属于团队执行器的 Dispatch 模型，已随 `remove-team-executor` 移除；独立审查的证据改为 `TEAM-REVIEW.md` 工件（`team-evidence`）。

**Migration**: 见 `team-evidence` 的「独立审查与测试证据」；审查证据写在变更目录的 `TEAM-REVIEW.md`，合并状态由归档门按 git 事实校验。

### Requirement: 未合并的任务不得核验

**Reason**: 该规则的前置（任务级分支与合并状态）已不存在。

**Migration**: 见 `team-evidence` 的「独立审查与测试证据」；审查证据写在变更目录的 `TEAM-REVIEW.md`，合并状态由归档门按 git 事实校验。

### Requirement: 独立性由 git 事实派生，不由调用方声明

**Reason**: 独立性判定保留但改由归档门完成：`TEAM-REVIEW.md` 的 reviewer 署名与标记提交作者比较（见 `team-evidence` 的「独立审查与测试证据」）。

**Migration**: 见 `team-evidence` 的「独立审查与测试证据」；审查证据写在变更目录的 `TEAM-REVIEW.md`，合并状态由归档门按 git 事实校验。

### Requirement: 可选归档门要求逐任务独立核验

**Reason**: `swarmReviewRequired` 配置项一并删除；逐任务核验没有对应实体。

**Migration**: 见 `team-evidence` 的「独立审查与测试证据」；审查证据写在变更目录的 `TEAM-REVIEW.md`，合并状态由归档门按 git 事实校验。
