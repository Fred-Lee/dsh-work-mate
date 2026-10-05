# Tasks — Add Approval Records

- [x] 1. `store.ts`：`ApprovalRecord` 与 `Proposal.approvals[]`
- [x] 2. `service.ts`：`addApproval`（含 rationale/commit）+ 用例
- [x] 3. `events.ts`：`approval` 事件类型（gate/actor/decision/rationale）
- [x] 4. `config.ts`：`approvalsRequired`（默认 `['merging','archiving']`）与
      `allowAgentApproval`（默认 false）+ schemastery 字段
- [x] 5. `archive/service.ts`：推进到受控状态时判 actor（agent 拒、human/system 过），
      通过后写审批记录 + `approval` 事件；`force` 不影响该门
- [x] 6. `api.ts`：`transition`/`advance` 接受 `rationale`；详情返回 `approvals` +
      `pendingApproval`
- [x] 7. `index.ts`：`workmate_proposal_archive` 增加 `rationale` 入参（人工批准场景经
      REST 时也能带理由）
- [x] 8. 客户端：卡片/详情显示「等待人工批准」徽标
- [x] 9. 测试：agent 被拒（含文案）、human/system 通过、审批记录与事件留痕、rationale、
      config 逃生阀、REST payload、客户端徽标
- [x] 10. 文档：README（配置表 + 行为变化）、AGENTS.md、guidance skill（"需要人工批准时
      请用户点面板，不要绕过"）、metrics perProposal 审批计数
- [x] 11. 验证：typecheck / test / build / verify（四条门）+ 真机
