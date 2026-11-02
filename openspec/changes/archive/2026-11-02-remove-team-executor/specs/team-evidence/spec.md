## MODIFIED Requirements

### Requirement: 六份团队工件

提案目录 SHALL 维护三份与执行无关的协作工件：`TASKS.json`（DAG 任务）、`TEST.md`
（集成测试证据）、`TEAM-REVIEW.md`（审查记录）。`REQ.md` / `PLAN.md` / `SUMMARY.md`
SHALL NOT 再由插件生成或校验——`REQ.md` / `PLAN.md` 的职责由 OpenSpec 的
`proposal.md` / `design.md` 承担。

`TASKS.json` SHALL 是任务与依赖的唯一事实源；任务面板的待办 SHALL 从它派生，不得在
别处维护第二份任务清单。`TEST.md` 与 `TEAM-REVIEW.md` SHALL NOT 由执行它们的同一会话
代写。

#### Scenario: 任务清单单一来源

- **WHEN** 用户修改 `TASKS.json` 后重新扫描
- **THEN** 待办列表与依赖关系随之更新，不保留旧的并行任务

#### Scenario: 缺失证据阻断归档

- **WHEN** 有 `TASKS.json` 的变更在归档前缺少 `TEST.md` 或 `TEAM-REVIEW.md`
- **THEN** `teamEvidenceGate`（默认 `block`）拒绝归档并列出缺失文件

### Requirement: 独立审查与测试证据

`TEAM-REVIEW.md` SHALL 包含 severity、文件:行、问题、状态（open/fixed/accepted）；
`TEST.md` SHALL 包含测试场景、实际执行的命令、结果与失败复现。两者 SHALL 引用真实存在
的文件与命令输出；缺失证据 SHALL 阻断对应门禁。

独立性判定 SHALL 只依据工件本身（审查者署名与提交作者是否相同），SHALL NOT 依赖
Dispatch 的 `sessionId`——后者随团队执行器一并移除。无法判定时 SHALL 按
`reviewerIndependence` 的配置降级（默认 `warn`），SHALL NOT 静默通过。

`TEAM-REVIEW.md` / `TEST.md` SHALL 接入现有 `review-gate` 与 `reviewEvidenceGate`：
未解决的 CRITICAL 或证据文件不存在即失败；行号越界只 warn。

#### Scenario: 审查者与实现者同身份

- **WHEN** `TEAM-REVIEW.md` 署名与标记提交的作者相同
- **THEN** 按 `reviewerIndependence=block` 拒绝归档，标记 `same-as-author`

#### Scenario: 测试证据不可核

- **WHEN** `TEST.md` 引用的脚本或输出文件不存在
- **THEN** `reviewEvidenceGate` 失败并列出缺失引用，不以「已执行」文字代替证据

## REMOVED Requirements

### Requirement: 结算汇总与归档映射

**Reason**: `SUMMARY.md` 是 Run 的结算产物，随 Run 移除；归档 manifest 的 `team` 段
不再生成。

**Migration**: 归档 manifest 只保留项目、分支、提交、测试与审查结论；需要汇总时读
事件流。

### Requirement: 集成测试写域允许清单

**Reason**: 该清单约束的是 `integration-tester` 角色，角色系统已移除。

**Migration**: 写域冲突检查仍由 `swarm` 的 `writes` 声明与 `writeConflictGate` 覆盖。
