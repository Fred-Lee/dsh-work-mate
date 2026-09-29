# Add Decision Log and Blockers

## Why

Claude Code 会话中 Agent 的两类高频失效：**长思考出不来**（无完成判据、卡点无出口）
与**前后结论矛盾**（决策无持久化、主会话自审自漂移）。WorkMate 的工件链已覆盖大半，
本变更补最后两块：把「方向性选择」物化为决策日志（显式推翻，禁止静默改口），把
「卡住」物化为卡点上报（有限人机往返，替代无限思考）。

## What Changes

1. **决策日志**：提案记录新增 `decisions: DecisionEntry[]`
   （`{ id, decision, rationale, supersedes?, at }`）；`supersedes` 必须指向存在
   的旧条目——显式推翻机制，auditor 据此比对一致性。工具
   `workmate_proposal_decide`、REST `POST /:id/decisions`、面板「决策日志」时间线。
2. **卡点上报**：提案记录新增 `blockers: BlockerEntry[]`
   （`{ id, question, tried?, answer?, status: open|resolved, at, answeredAt? }`）。
   工具 `workmate_proposal_block` / `workmate_proposal_unblock`（含答复）、REST
   两个端点、面板「卡点」小节（open 红色待办，resolved 灰色含答案）。
3. **纪律注入**：目标项目默认配置的 proposal 规则追加「同一方向卡两轮必须上报，
   禁止第三轮盲试」；proposal-auditor 资产的审查清单追加「决策日志一致性比对
   （含 supersedes 链与 GitNexus 事实核对）」。
4. **兼容**：两个数组均为可选字段，旧 proposals.json 读时补空；状态机不变
   （任何状态可决策/卡住）；auditor 等已同步资产遵循「永不覆盖」纪律，更新只
   到达新项目（汇报说明）。

## Capabilities

### 新增能力

- `proposal-quality-gates`（MODIFIED）：决策日志与卡点上报的数据模型、工具面与
  面板展示。

## Impact

- `store.ts` 模型与 normalize；`service.ts` 三个方法；REST 三端点；三个新工具；
  App.tsx 详情区两个小节；assets 两处规则文本。
