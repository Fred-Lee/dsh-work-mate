## REMOVED Requirements

### Requirement: Run / Task / Dispatch 模型

**Reason**: 团队执行器被移除（change `remove-team-executor`）。执行由 Super-agent 的
Ticket/Assignment 承担，WorkMate 不再维护第二套派发状态机。

**Migration**: 待办改走任务面板（`workmate/team-runs.json` 不再读写；已落盘的旧文件
保留在磁盘上不删除，仅不再加载）。派发相关配置与工具一并移除。

### Requirement: 依赖 DAG 与波次

**Reason**: 依赖等待属于 Source。`adopt-superagent-openspec-source` 之后，`TASKS.json`
的 `dependsOn` 由 Source 在扫描时门控（未满足前置的待办不产生 Trigger），波次概念随
Run 一起消失。

**Migration**: `dependsOn` 继续写在 `tasks.json` 的任务记录里，由 Source 的
`gate.ts` 读取；需要并行度的场景由 Super-agent 的 `executor.maxWorkers` 控制。

### Requirement: 门禁与自主推进

**Reason**: G1（工件完整性）保留在归档侧；G2（`planHash` 人工批准）保留在提案侧。
「Run 内自主推进」不再存在，因为不再有 Run。

**Migration**: 方案门与归档门的行为不变，见 `lifecycle-state-machine`。

### Requirement: 收件箱与升级

**Reason**: 提问与回答改由 Super-agent 的 `person/answer` 阶段 + Channel 回写承担，
`workmate_team_inbox` / `workmate_team_answer` 工具被移除。

**Migration**: 面板「需要我」列显示 `person/*` 阶段并支持原地回答。

### Requirement: 失败、重试与终态

**Reason**: 重试语义改由 `Ticket.retryTicket` 承担（仅在 blocked/failed 且其后无人
发言时可重试），比 `maxAttempts` 更准。

**Migration**: 任务面板的「重试」按钮代理 `POST /orchestrator/api/tickets/:id/retry`。

### Requirement: 预算与停止

**Reason**: 预算（并发 / 时长 / tokens / Dispatch 数）属于 Super-agent 的
`executor.maxWorkers` 与宿主会话；WorkMate 不再重复计数。

**Migration**: 需要限制时改 Super-agent 的 `executor` 设置。

### Requirement: G2 批准即启动，不重复评估

**Reason**: G2 批准后改为写实现待办（`assigned=true`），由 Source 下一轮扫描投递；
不存在「Run 启动」这一步。

**Migration**: 见 `adopt-superagent-openspec-source` 的 G2 交接任务。

### Requirement: 团队入口按工件判断

**Reason**: `workmate_team_plan` 的 G1 模板检查随工具移除。

**Migration**: 工件完整性仍由归档门的 `review-gate` / `teamEvidenceGate` 检查。

### Requirement: G5 拒绝回流

**Reason**: `rejectMerge(category=plan|implementation)` 是团队 Run 的语义。提案侧
保留合并与归档的相邻回退，但没有「退回给某个 Run 重做」的动作。

**Migration**: 需要修改时把提案退回 `implementing`，重新走待办与 G2。

### Requirement: 默认限额

**Reason**: 限额属于 Super-agent 的 executor 设置。

**Migration**: 见「预算与停止」。
