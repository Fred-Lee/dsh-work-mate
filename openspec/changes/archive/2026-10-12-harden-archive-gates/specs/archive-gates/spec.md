# archive-gates Specification

## Purpose

归档编排的三道门（审查门 / 任务门 / 计划漂移门）此前允许 `force` 一次性跳过且不留审批痕迹，
审查报告的身份与证据也没有机器校验。本 capability 规定这三处的强制语义：`force` 是
**人类的显式决策**而不是 agent 的参数；审查者的独立性可判定、可配档；审查证据的引用可机检。

## ADDED Requirements

### Requirement: force 是人类的显式决策

`force` 归档 SHALL 只由非 `agent` 的 actor 执行；`actor` 为 `agent` 时 SHALL 被拒绝，
除非 `Config.allowAgentForceArchive` 为 true。被拒绝时 SHALL 记录一条
`gate-failed(force-archive)` 事件，错误信息 SHALL 写明在哪个人工入口可以完成同样的动作。
通过时 SHALL 无条件记录一条 `approval(gate: "force-archive")`，其 `rationale` SHALL 列出
本次被 `force` 跳过的门。

#### Scenario: agent 不能自行跳过审查门

- **WHEN** agent 调用 `workmate_proposal_archive`（mode=archive, force=true）且 `allowAgentForceArchive` 为 false
- **THEN** 调用被拒且状态不变，事件流出现 `gate-failed`（gate 为 `force-archive`），
  错误信息含面板批准提示

#### Scenario: 人类 force 归档留痕

- **WHEN** 面板/API（actor=human）带 force 归档成功
- **THEN** 提案 `approvals` 多一条 `gate: "force-archive"` 的记录，且其 rationale 列出被跳过的门

#### Scenario: 显式豁免后 agent 放行

- **WHEN** `allowAgentForceArchive` 为 true，agent 带 force 归档
- **THEN** 允许执行，仍然留下 `approval(gate: "force-archive")` 记录

### Requirement: 跳过门禁归档在结果与状态里可见

编排结果 SHALL 在 `reviewGate` 或 `tasksGate` 被 `force` 跳过时把 `forced` 置为 true
（该字段此前只声明不使用）。提案状态投影 SHALL 暴露最近一次 `force-archive` 审批
（时间、actor、rationale），使"这次归档跳过了哪些门、谁决定的"可从既有工件回答。

#### Scenario: 结果对象如实标注

- **WHEN** 归档编排以 reviewGate=false 运行
- **THEN** 返回的 `OrchestrationResult.forced` 为 true，且 review-gate 步骤为 skipped

#### Scenario: 状态投影暴露强制归档

- **WHEN** 提案曾以 force 归档
- **THEN** `workmate_proposal_status` 返回 `forcedArchive`（含 at / actor / rationale）

### Requirement: 审查者独立性可判定且档位语义非对称

归档门 SHALL 依据 `Config.reviewerIndependence`（`off` | `warn` | `block`）判定审查者
身份：`reviewer` 缺失（非影子报告）判为 `missing`；`reviewer` 命中执行者身份集合判为
`same-as-author`；能取到双方且不命中判为 `independent`；缺少 git 事实判为 `undetermined`。
在 `block` 档，`missing` 与 `same-as-author` SHALL 阻断归档并产出 failed 步骤；
`undetermined` SHALL NOT 阻断（只记 warn）——无法判定不等于有罪。
`off` 档 SHALL 不做任何判定。

#### Scenario: block 档拦截同一身份自评

- **WHEN** reviewerIndependence=block，review.md 的 reviewer 与执行者身份集合中的某一项相同
- **THEN** 归档失败，步骤 `review-independent` 为 failed 并写明身份

#### Scenario: block 档不因无法判定而阻断

- **WHEN** reviewerIndependence=block 且 git 事实缺失
- **THEN** 产出 warn 步骤，归档继续

#### Scenario: warn 档只报告

- **WHEN** reviewerIndependence=warn 且 reviewer 缺失
- **THEN** 归档照常，步骤 `review-independent` 为 ok/skipped 并写明 missing

### Requirement: 审查证据引用可机检

归档门 SHALL 依据 `Config.reviewEvidenceGate`（`off` | `warn` | `block`）校验 review.md 中
反引号包裹的路径引用：文件不存在判 `file-missing`、行号超出文件行数判 `line-out-of-range`。
`block` 档 SHALL 仅在出现 `file-missing` 时阻断；`line-out-of-range` SHALL 只记 warn。
带 GitNexus 查询语义的条目（`impact(` / `context(` / `query(` / `gitnexus`）SHALL NOT 做
机器校验，只 SHALL 在步骤摘要中标注为不可机检。

#### Scenario: block 档拦截不存在的引用

- **WHEN** reviewEvidenceGate=block，review.md 引用 `src/does-not-exist.ts:12`
- **THEN** 归档失败，步骤 `review-evidence` 为 failed 并列出该引用

#### Scenario: 行号越界不阻断

- **WHEN** reviewEvidenceGate=block，引用文件存在但行号超出范围
- **THEN** 步骤记为 warn，归档继续

#### Scenario: GitNexus 结论不被假装校验

- **WHEN** review.md 含 `` `impact(SymbolName)` `` 类结论
- **THEN** 步骤摘要报出不可机检条目数，且不因它失败
