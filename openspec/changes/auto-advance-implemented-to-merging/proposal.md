# 提案：实现完成时自动推进到 merging（低频调度器版）

## Why

前一次尝试（已回滚，`92031da` → `f9503d6`）把推进逻辑放进了 `TaskService.board()`，
导致**宿主 HTTP 完全卡死**：主线程 100% 卡在 `v8::MicrotaskQueue::RunMicrotasks`，
3080 无响应、`SIGTERM` 无效（进程 U 状态），只能 `kill -9`。

根因（真机事故 2026-11-09）：
1. `board()` 是**高频读路径**——面板每 5 秒轮询 `/api/tasks`；
2. `index.ts` 的 `leftover()` / `reclaim()`（`/api/worktrees/leftover`）**也调 `board()`**，
   而面板同时请求这两个端点 → `board()` 并发执行；
3. 我加的 `onProposalImplemented` 在每个 `board()` 里都会调 `transition`，
   而 `transition` 本身要拿提案写锁；并发 `board()` + 反复 transition 形成
   微任务无限链。

需求本身仍然成立：worker 干完后提案卡在 `implementing`，面板显示「实现中」而事实
已完成。所以重做，但换实现方式。

## What Changes

- **推进移出所有读路径**：`board()` / `leftover()` / `reclaim()` SHALL NOT 触发任何写操作。
- **独立低频调度器**：新增一个每 60 秒（可配）跑一次的「推进扫描」，只做一件事：
  找出「全部待办已完成但提案仍在 implementing」的提案，逐个推进到 `merging`。
- **持久化"已推进"标记**：用提案记录上的一个新字段（`autoAdvancedAt`）记录系统已为
  该提案做过自动推进，避免重复尝试；重启后不丢。
- **串行**：扫描自身单飞（上一次未结束就跳过本轮），不与面板并发抢锁。
- **失败隔离**：单个提案推进失败只记事件与 notes，不影响其他提案，也不影响扫描继续。

## Capabilities

### Modified Capabilities

- `lifecycle-state-machine`：「八态生命周期状态机」补充 `implementing → merging` 的自动
  推进判据与**触发方式约束**（SHALL NOT 由请求路径触发）。
- `task-intake`：「面板四列与状态唯一来源」补充完成态与提案状态同源，且面板读路径
  SHALL NOT 产生写副作用。

## Impact

- 新增 `src/features/task/advance-scan.ts`（纯判据 + 扫描器）、
  `src/index.ts`（启动调度器，随插件 dispose 停止）、
  `src/features/proposal/{store,service}.ts`（新字段 `autoAdvancedAt` 与 patch 白名单）。
- 回滚 `board()` 里的推进调用（已在上次回滚中移除，本变更不重新引入）。
- **不做**：不跨 G5（`merging → archiving` 仍是人），不自动合并。

## 事故教训（写进验收要求）

上次事故的关键不是逻辑错，而是**没有任何测试覆盖"高频读路径 + 并发 + 写操作"的组合**。
本变更的验收必须包含：连续 N 次并发 `board()` 与推进扫描交错执行，断言不死锁、
不重复推进。
