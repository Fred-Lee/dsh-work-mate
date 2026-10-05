# Add Swarm Parallel (task worktrees + merge arbitration)

## Why

`docs/DESIGN.md` §9 早已定下并行执行的载体决策，但一直停在"记录性跳过位"：

> 一个项目内多任务并行采用**每任务一个 worktree + 独立分支**…物理隔离不解决逻辑冲突——
> 沿用 Helmsman 三层纪律：`writes` 声明防踩踏、冲突域（仓库:模块）排队、patch 式
> `git apply` 合并 + 按 agent/file 裁决重试。

现在 WorkMate 只有**提案级** worktree（`ready→implementing` 时创建）。提案内部的多个任务
仍然串行，且没有任何机制阻止两个任务改同一个文件。"能并行"是 SDLC 闭环里提升吞吐的
最主要手段（playbook 的 Build 阶段：`Each parallel task gets its own worktree`），而
DSH 侧的并行 agent 已经存在（子代理 / Agent Teams），缺的只是**git 隔离与合并纪律**。

## What Changes

1. **计划器**（`src/features/swarm/plan.ts`，纯函数）：从 `tasks.md` 派生任务
   （id / 标题 / `<!-- writes: a/**, b/** -->` 声明），按 `writes` 相交即**不得同批**的
   规则装批（`maxParallel`，默认 3），并输出冲突对清单。
2. **任务级 worktree**（`src/features/swarm/manager.ts`）：每任务一个
   `<root>/.workmates/<proposal>--<task>` + 分支 `feature/<proposal>--<task>`（基于提案的
   implementation 分支），复用现有 `WorktreeManager` 的串行 gate 与端口分配；记录落在
   提案的 `swarmTasks[]`（状态 `planned|running|merged|failed`）。
3. **合并仲裁**：把任务分支合回提案的 implementation 分支（在提案 worktree 里执行
   `git merge --no-ff`）；冲突时 `git merge --abort` 并把冲突文件列表交回，任务标
   `failed` 且带 note——**由 agent/人裁决后重试**，插件不猜。
4. **验收闭环**：归档编排的验收谓词扩展——存在未 `merged` 的 swarm 任务时失败并列出
   它们（`force` 同样可跳过）。
5. **工具**：`workmate_swarm_plan {id, maxParallel?, projectRoot?}` 与
   `workmate_swarm_task {id, action: start|merge, taskId, projectRoot?}`；
   任务状态随 `workmate_proposal_status` 的提案记录返回。

## Capabilities

### 新增能力

- `swarm-parallel`：任务级 worktree 并行载体、writes 防踩踏装批与合并仲裁。

## Impact

- 新增 `src/features/swarm/{plan.ts,manager.ts}` 与测试；`store.ts` 增 `swarmTasks[]`
  （可 patch）；`orchestrate.ts` 验收谓词扩展；`index.ts` 两个新工具（共 14 个）；
  client 提案详情显示任务状态。
- **不做**：自己拉起并行 agent（DSH 侧已有子代理 / Agent Teams；插件负责 git 隔离与
  合并纪律，工作谁做由调用方决定）。不做自动冲突解（那是裁决，不是机械操作）。
