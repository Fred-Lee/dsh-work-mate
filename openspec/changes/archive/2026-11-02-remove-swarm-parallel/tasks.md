# 任务：移除 swarm 任务级并行载体

- [x] 1. 迁移公共函数 `src/features/proposal/writes.ts`：把 `scopesIntersect` 从
  `swarm/plan.ts` 搬进来（10 行纯函数，子树重叠判断），保持 `writeConflictGate` 行为不变
  <!-- writes: src/features/proposal/writes.ts, src/features/proposal/writes.test.ts -->

- [x] 2. 删除 `src/features/swarm/`（manager / plan 与两个测试文件）
  <!-- writes: src/features/swarm/ -->

- [x] 3. 插件接线 `src/index.ts`：移除 `SwarmManager` 构造与注入、
  `workmate_swarm_plan` / `workmate_swarm_task` 两个工具、`parseSwarmTasks` 导入、
  `swarmRoot` 辅助函数、`swarmReviewRequired` 传参
  <!-- writes: src/index.ts, src/index.test.ts -->

- [x] 4. 配置 `src/config.ts`：删除 `maxConcurrent` 与 `swarmReviewRequired`，
  各留一行 `// removed in remove-swarm-parallel` 注释
  <!-- writes: src/config.ts, src/config.test.ts -->

- [x] 5. 归档侧 `src/features/archive/orchestrate.ts` + `service.ts`：
  删除 `swarm` 步骤与 `runSwarmTasks` 钩子、`tasks` 门里的 `swarmTasks` 判断、
  `swarmReviewRequired` 依赖与传参
  <!-- writes: src/features/archive/orchestrate.ts, src/features/archive/service.ts,
      src/features/archive/orchestrate.test.ts -->

- [x] 6. 提案数据 `src/features/proposal/{store,service}.ts`：删除 `swarmTasks` 字段与
  写入白名单项（历史值不清洗，读取端忽略）
  <!-- writes: src/features/proposal/store.ts, src/features/proposal/service.ts,
      src/features/proposal/store.test.ts, src/features/proposal/service.test.ts -->

- [x] 7. 客户端 `src/client/types.ts` + `App.tsx`：删除 `SwarmTaskRecord` 类型与详情里的
  swarm 任务区块
  <!-- writes: src/client/types.ts, src/client/App.tsx, src/client/app.test.tsx -->

- [x] 8. worktree `src/features/worktree/manager.ts`：删除 `create` / `createTarget`
  及只服务它们的 `copyFiles` / `packageManager` 依赖；保留 `remove` / `ports` /
  `allocationFor` / `worktreePath`
  <!-- writes: src/features/worktree/manager.ts, src/features/worktree/worktree.test.ts -->

- [x] 9. guidance `src/features/guidance/content.ts`：删除「并行执行（swarm）」一节，
  在任务流一节补一句"并发靠多条待办 + Super-agent 的 maxWorkers"
  <!-- writes: src/features/guidance/content.ts, src/features/guidance/guidance.test.ts -->

- [x] 10. 文档：`AGENTS.md` 的 swarm 段改为已移除、`README.md` 5.7 节、
  `docs/DESIGN.md` 的 M14 行
  <!-- writes: AGENTS.md, README.md, docs/DESIGN.md -->

- [x] 11. 门禁：`pnpm typecheck && pnpm test && pnpm build && pnpm verify`；
  `pnpm test:toolchain`；确认 `pnpm verify:built` 的工具面从 20 降到 18
  <!-- writes: （无源码写域；仅运行命令与记录） -->
