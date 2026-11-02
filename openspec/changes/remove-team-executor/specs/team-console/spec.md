## REMOVED Requirements

### Requirement: 团队看板

**Reason**: 面板「团队」视图随执行器移除（change `remove-team-executor`）。任务视图的
四列（需要我 / 进行中 / 待办 / 已完成）已经是唯一的执行视图。

**Migration**: 执行进展看任务视图与活动视图；条目与 Ticket 的对应关系在任务详情里。

### Requirement: DAG 视图

**Reason**: 没有 Run 就没有 DAG 可视化。

**Migration**: 依赖关系体现在任务卡片的进度点与「等待前置」文案；需要原始图时读
`tasks.json` 的 `dependsOn`。

### Requirement: 收件箱

**Reason**: 收件箱由 Super-agent 的 `person/*` 阶段取代。

**Migration**: 见任务视图的「需要我」列。

### Requirement: 运行时间线与证据

**Reason**: Run 时间线随 Run 消失；过程事实改为事件流与 Ticket 投影。

**Migration**: 活动视图按时间倒序展示事件流（见
`docs/design/workmate-task-console-v2-notes.md`）。

### Requirement: 面板契约

**Reason**: 该契约描述团队视图的渲染约束；视图已移除。

**Migration**: 无（面板的通用渲染与滚动约束仍由 `workbench-panel` 覆盖）。
