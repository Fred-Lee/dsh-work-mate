# task-intake Delta

## ADDED Requirements

### Requirement: 面板完成态与提案状态同源

面板任务卡的完成态与提案状态 SHALL 基于同一份 Ticket 事实：当某提案的全部待办
在任务视图显示为完成时，该提案 SHALL NOT 长期停留在「实现中」——系统 SHALL 自动
推进到「待合并」（判据见 `lifecycle-state-machine` 的「实现完成后自动推进到 merging」）。

面板 SHALL 在自动推进受阻时（Wiki 关联未完成等）把原因显示在 notes，SHALL NOT
让卡片与提案状态长时期互相矛盾而无任何提示。

#### Scenario: 卡片完成即提案前进

- **WHEN** 任务视图里某提案的待办全部显示「已完成」
- **THEN** 该提案在看板里进入「待合并」列，不出现"卡片已完成、提案实现中"的矛盾

#### Scenario: 受阻有提示

- **WHEN** 全部待办完成但提案无法推进（如 Wiki 未登记）
- **THEN** 面板显示具体阻塞原因，用户知道下一步做什么
