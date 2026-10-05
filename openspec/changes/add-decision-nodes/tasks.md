# Tasks — Add Decision Nodes

- [x] 1. `risk-tier`：`Proposal.risk` + `workmate_assess_risk` 工具 + `highRiskExtraGates` 叠加人工批准门
- [x] 2. `review-severity`：审查门对未打标签发现分级（上限 `reviewGradeMax`，仅 act 采信）
- [x] 3. `injection-risk`：创建时判定并自动置 `untrusted`（仅 act）+ decision 事件
- [x] 4. `task-satisfied`：归档时判定已勾选任务，写进 manifest，`taskJudgementGate` 可阻断
- [x] 5. 测试：风险门叠加、审查分级改变阻断、注入自动置位、任务判定记录与可选阻断、
      判断层未启用时逐字不变
- [x] 6. 文档：README（四个节点）+ guidance + AGENTS 里程碑
- [x] 7. 验证：typecheck / test / build / verify + 真机
