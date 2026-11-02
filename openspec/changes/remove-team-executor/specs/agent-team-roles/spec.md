## REMOVED Requirements

### Requirement: 角色名册与契约

**Reason**: Super-agent 只有一个 worker preset，没有角色概念；团队执行器已移除
（change `remove-team-executor`）。

**Migration**: 需要不同 preset 时，在 Super-agent 的 `executor` 设置里配置。WorkMate
侧只保留任务级的 `role` 标签用于展示，不作为派发依据。若将来需要多角色协作，应通过
`TASKS.json` 的 role 字段 → Source 的 `meta` → `executor.prepare` 传入，而不是在
WorkMate 里重建角色系统。

### Requirement: 角色权限与写域边界

**Reason**: 写域机检（`FILES:` 报告按 `writes` 校验）随 Dispatch 移除；角色级权限
没有执行器可以约束。

**Migration**: `writes` 声明仍写在 `TASKS.json` 与 `tasks.json` 里，由归档侧的写域
冲突检查（`writeConflictGate`）与 `swarm` 的装批使用，两者都不依赖团队执行器。

### Requirement: 模板与角色装配

**Reason**: 模板装配（`teamTemplate` → 角色列表）随执行器移除。

**Migration**: 无。
