# 写入竞态加固：任务分配与提案存储串行化

## Why

2026-11-08 全库评审（对抗 pass）证实两类丢更新/撞号竞态：

1. **任务 id/seq 撞号**：`TaskService` 的 create（`tasks.length + 1`）、reply
   （`maxInputSeq() + 1`）、ensureImplementationTasks（`length + created + 1`）都是
   无锁读增。面板与 agent 工具并发时产生重复 id/seq——Source 的确定性 Trigger id
   `workmate:<taskId>:<attempt>` 会把两条不同待办折叠成同一张 Ticket，人的回答贴错行。
2. **提案聚合丢更新**：`ProposalServiceImpl` 全部方法都是裸 load→mutate→save
   （tmp+rename 只保证单次写原子，不保证读改写事务）。REST 请求、agent 工具、
   board 投影的 `cacheObservedTickets` 并发时，后写覆盖先写（决策/审批/卡点丢失）。

## What Changes

- `TaskService` 的全部写方法（create / assign / stop / reopen / reply /
  ensureImplementationTasks）SHALL 经同一把进程内互斥串行执行。
- `ProposalServiceImpl` 的全部聚合写方法（upsert / patchFields / setStatus /
  addDecision / addApproval）SHALL 经同一把进程内互斥串行执行。
- 互斥是进程内的（单宿主进程）；跨进程并发不在本变更范围（面板与 Source 分属
  两个进程，但两者写的是**不同文件**，天然无竞争）。

## Capabilities

### Modified Capabilities

- `task-intake`：新建待办与回答的 id/seq 分配补充并发语义。
- `proposal-middleware`：提案聚合的读改写补充串行化语义。

## Impact

- `src/features/task/service.ts`、`src/features/proposal/service.ts` 各加一个
  promise-chain 互斥；方法内部逻辑不变（无嵌套调用，无死锁面）。
- 行为变化仅在不并发时不可观察。
