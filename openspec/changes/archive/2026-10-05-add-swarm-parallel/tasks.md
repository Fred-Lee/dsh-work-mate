# Tasks — Add Swarm Parallel

- [x] 1. `plan.ts`：从 tasks.md 派生任务（id/标题/writes 注释）+ 贪心装批 + 冲突对
- [x] 2. `store.ts`：`Proposal.swarmTasks[]`（可 patch）
- [x] 3. `manager.ts`：任务 worktree/分支创建、状态迁移、合并与冲突仲裁
- [x] 4. `orchestrate.ts`：验收谓词扩展（未合并任务阻断，force 跳过）
- [x] 5. `index.ts`：`workmate_swarm_plan` / `workmate_swarm_task`（共 14 个工具）
- [x] 6. 测试：装批规则（相交/未声明/上限）、plan 派生、管理器（真 git：建/合/冲突）、
      验收谓词、工具注册
- [x] 7. 文档：README（并行执行一节）+ AGENTS（槽位/纪律）+ guidance skill 一句话
- [x] 8. 验证：typecheck / test / build / verify（四条门）+ 真机
