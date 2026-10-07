# Tasks — Close the Unassessed-Risk Gate Bypass

- [x] 1. assertApproval 前置守卫（风险未判 + agent + 受门状态 → 拒绝）
- [x] 2. gate-failed 事件记录（gate=risk-unassessed）
- [x] 3. index.ts 传 riskGateEnabled = decisionEnabled
- [x] 4. 用例：未判风险被拒；判断层关闭时行为不变
