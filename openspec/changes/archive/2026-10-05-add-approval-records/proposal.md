# Add Approval Records (separation of duties)

## Why

playbook 把"写码者不得批准自己写的代码"当作一条硬边界：

> 「Separation of duties is preserved, because **the agent that wrote the code has no way
> to approve it**.」（[P1] Deploy / CI-CD）
> 「Every approval is **logged with the signals and reasoning** behind it.」（[P2] Test）
> 「any decision is **attributable and auditable after the fact**.」（[P2] Governance）

WorkMate 现在没有这一层：任何能调工具的东西（agent 自己）都能一路把提案推到
`archived`，事件流里只留一句 `actor: agent`，没有"谁批准了哪一道门、凭什么"。而
`actor` 归因（M6）已经把 agent 与人在面板上的动作分开了——缺的只是把它变成一道门。

## What Changes

1. **审批记录**（`Proposal.approvals[]`）：`{gate, actor, decision: approve|reject,
   rationale?, at, commit?}`；`commit` 记批准覆盖的实现分支 HEAD（能取到 git 时），
   让"批准的是哪一版"可查。
2. **人工批准门**（`Config.approvalsRequired`，默认 `['merging', 'archiving']`）：
   推进到这些状态时，`actor` 必须是 `human`（面板/REST）或 `system`（插件内部编排）；
   **agent 工具调用被拒**，错误信息写明"请在面板点推进，或调整 approvalsRequired"。
   逃生阀 `Config.allowAgentApproval`（默认 false）——显式打开即明确放弃这条分离。
3. **留痕到事件流**：每次批准写一条 `kind: 'approval'` 事件（gate / actor / decision /
   rationale），与 `transition` 事件一起构成审计链。
4. **可见性**：`workmate_proposal_status` 与 `GET /api/proposals/:id` 返回
   `approvals[]` 与 `pendingApproval`（该状态是否正等待人工批准 + 为什么），面板在
   卡片上显示"等待人工批准"徽标。
5. **REST 可带理由**：`POST /api/proposals/:id/transition` 与 `/advance` 接受
   `{rationale}`，写进审批记录（面板后续可加输入框；v1 允许留空）。

## Capabilities

### 新增能力

- `approval-gate`：人工批准门、审批记录与审批事件。

### 修改能力

- `proposal-metrics`：事件流事件类型增加 `approval`；聚合的每提案行增加审批计数。

## Impact

- 改动：`store.ts` / `service.ts`（审批记录读写）、`archive/service.ts`（门禁判定与留痕）、
  `events.ts`（`approval` 事件）、`config.ts`（两个新配置）、`index.ts`（工具入参
  `rationale`）、`api.ts`（REST rationale 与 payload）、客户端（徽标）。
- **行为变化（重要）**：默认情况下 **agent 不能再自己把提案推进到 merging / archiving**——
  这是本变更的目的；要恢复全自动，把 `approvalsRequired` 设为 `[]` 或把
  `allowAgentApproval` 设为 `true`（README 与 skill 都会写明）。
