# 提案：Ticket 全部完成时自动推进到 merging

## Why

实测 2026-11-09：`support-multi-repo-executors` 的 worker 已完成全部实现（分支
`workmate/multi-repo-executors-dbb91f8184ad` @ `5d86018`，732 测试全绿，已推送），
任务板上它的待办是「已完成 / `completed`」，但提案状态**永远停在 `implementing`**。

根因（`src/features/archive/service.ts:639-647`）：`reconcile()` 的自动推进链只覆盖
`draft → proposing → reviewing → ready`，到 `ready` 就返回；`implementing` 根本没有
后继分支。而且 `reconcile` 只在被显式调用时跑（`POST /api/proposals/:id/reconcile`），
没有任何定时或事件触发。

后果：每完成一个提案，人都要手动点两次「推进」（先 `merging`，再等 G5）才能继续，
而面板显示「实现中」会让人以为 worker 还在跑——正是本次实测暴露的 UI 与事实不符。

## What Changes

- **完成判据落到执行事实**：一个提案在 `implementing` 时，若它关联的**全部待办都已
  到达 done 列**（Ticket 终态为 `completed`/`merged`/`dropped`），则视为"实现完成"。
  `attention`（等人）、`working`（在跑）、`todo`（未指派）都不算完成。
- **自动推进**：观察到上述条件时，系统（`actor: 'system'`）推进 `implementing → merging`。
  这一步不是人工门（G5 在 `merging → archiving`），所以可以自动。
- **触发点**：放在 `TaskService.board()` 观察到 Ticket 之后（它本来就每 5 秒轮询、
  已经在读 Ticket 与任务表），通过注入的回调请求推进；不新增定时器。
- **幂等与静默**：推进失败（如 wiki 关联未完成）只记 notes，不阻断面板；重复观察不重复推进。
- **不做**：不自动跨过 G5（`merging → archiving` 仍是人），不自动合并。

## Capabilities

### Modified Capabilities

- `lifecycle-state-machine`：「八态生命周期状态机」补充 `implementing → merging` 的
  自动推进判据（Ticket 全部终态），并说明它不是人工门。
- `task-intake`：「面板四列与状态唯一来源」补充"完成即推进"的语义：面板显示完成
  与提案状态推进基于同一份 Ticket 事实，不出现"卡片已完成但提案还在实现中"。

## Impact

- `src/features/task/service.ts`（board 观察后触发推进回调）、
  `src/index.ts`（装配回调 → `archive.reconcile` 或直接 `transition`）、
  `src/features/archive/service.ts`（reconcile 增加 `implementing` 分支，判据由调用方给）。
- 行为变化：worker 完成后提案自动进 `merging`，人在面板看到「待合并」而不是「实现中」。
- 不改变 G5：`merging → archiving` 仍需要人在面板点并填理由。
