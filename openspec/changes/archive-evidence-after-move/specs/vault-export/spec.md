## MODIFIED Requirements

### Requirement: 项目 wiki 导出到 vault

归档编排读取验收证据（`tasks.md` / `review.md`）时 SHALL 解析 change 目录：
先看活动路径 `changes/<id>/`，不存在时 SHALL 回退到 `changes/archive/<date>-<id>/`，
使归档后的复查与重跑仍能读到证据。编排结果 SHALL 明确报告本次是否由 `force` 跳过门禁（`forced`）。

#### Scenario: 归档后仍读得到证据

- **WHEN** change 目录已位于 `changes/archive/<date>-<id>/`
- **THEN** 编排仍能读到 `tasks.md` 与 `review.md`（审查分级据此执行）

#### Scenario: force 可见

- **WHEN** 调用方以 `reviewGate: false` 或 `tasksGate: false` 运行归档
- **THEN** 返回结果 `forced: true`
