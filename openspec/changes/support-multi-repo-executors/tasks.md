# Tasks — 多仓库执行器

> 范围声明用行内 `<!-- writes: … -->`（`workmate_plan_drift` 读它）。
> **重启边界**：标 `[需重启]` 的条目只能由人在重启宿主后验收；worker 不得把它当作
> 自己能做到的验收项（change `support-multi-repo-executors` design D6）。

## 阶段 1 — Source 参数化（worker 可完成并自证）

- [ ] 1. `packages/superagent-source/src/kind.ts`：`KIND` 常量改为 `DEFAULT_KIND` +
  `kindIdOf(config)`；实例配置新增 `kind`（默认 `workmate`，`^[a-z][a-z0-9-]*$`）
  与 `repos`（绝对路径数组，空 = 不限）；`FIELDS` 补两项
  <!-- writes: packages/superagent-source/src/kind.ts, packages/superagent-source/src/kind.test.ts -->

- [ ] 2. `packages/superagent-source/src/index.ts`：健康条目名、state 键前缀、
  Trigger `source`、Thread key 前缀、`find` 返回值全部按 `kindIdOf` 派生；
  `sources.register` / `context()` 用派生 id
  <!-- writes: packages/superagent-source/src/index.ts, packages/superagent-source/src/index.test.ts -->

- [ ] 3. `packages/superagent-source/src/watch.ts` + `gate.ts`：`GateTask` 增加
  `repo`；`scanOnce` 在 ready 列表上按实例 `repos` 过滤，其余计入 `skippedByRepo`
  并进健康摘要；被跳过的待办不推进游标
  <!-- writes: packages/superagent-source/src/watch.ts, packages/superagent-source/src/gate.ts,
      packages/superagent-source/src/watch.test.ts, packages/superagent-source/src/gate.test.ts -->

- [ ] 4. 单测：两个实例（`workmate` / `workmate-b`）各自注册不冲突、健康条目独立、
  state 键不串台；`repos` 过滤只投命中项且 `skippedByRepo` 计数正确
  <!-- writes: packages/superagent-source/src/index.test.ts, packages/superagent-source/src/watch.test.ts -->

## 阶段 2 — WorkMate 侧集合判定

- [ ] 5. `src/config.ts`：新增 `executorRepos`（字符串数组，默认 `[]`）与
  `superagentEndpoints`（数组，默认 `[]`）；保留 `executorRepo` / `superagentEndpoint`
  为兼容单值；interface 与 Schemastery schema 两份同步
  <!-- writes: src/config.ts, src/config.test.ts -->

- [ ] 6. `src/index.ts`：装配时把 `executorRepo` + `executorRepos` 归一成集合传给
  `TaskServiceImpl`；`superagentEndpoints` 为空时用 `[superagentEndpoint]`
  <!-- writes: src/index.ts -->

- [ ] 7. `src/features/task/service.ts`：`connectable()` 改集合判定
  （`repos.length === 0 || repos.includes(task.repo)`）；不匹配时错误信息点明仓库与
  已接入集合；`TaskCard` 增加 `unservedRepo` 供面板提示
  <!-- writes: src/features/task/service.ts, src/features/task/task.test.ts -->

- [ ] 8. `src/features/superagent/client.ts`：支持多端点——每端点独立取 health 与
  tickets，失败只影响自身；聚合结果带 `endpoints: [{endpoint, online, reason?}]`
  <!-- writes: src/features/superagent/client.ts, src/features/task/task.test.ts -->

- [ ] 9. `src/client/TasksView.tsx`：卡片显示「未接入执行器（仓库 X）」并禁用指派；
  顶部显示「N 个执行器，M 个离线」
  <!-- writes: src/client/TasksView.tsx, src/client/tasks-view.test.tsx -->

## 阶段 3 — 文档与验收

- [ ] 10. 文档：`docs/SUPERAGENT-INTEGRATION.md` 增「多仓库部署」一节（每仓一个
  实例：stateDir / executor.directory / deployment.repository / source.repos 四处
  必须一致）；`AGENTS.md` 执行层一节补多实例要点
  <!-- writes: docs/SUPERAGENT-INTEGRATION.md, AGENTS.md -->

- [ ] 11. 门禁：`pnpm typecheck && pnpm test && pnpm build && pnpm verify`；
  `pnpm test:toolchain`；`pnpm verify:built` 工具面不变（18）
  <!-- writes: （无源码写域；仅运行命令与记录） -->

- [ ] 12. **[需重启] 真机验收（人执行）**：配第二个实例（`kind: workmate-b`、
  `repos: [<第二仓库绝对路径>]`、独立 stateDir 与 executor.directory），重启宿主；
  在两个仓库各建一条待办，确认：面板分别显示可指派、
  两条各进自己的执行器、健康条目独立、归档门逐 target 校验。
  **本项不由 worker 验收**——重启会终止 worker 自身。
  <!-- writes: （无仓库内写入：面板与 profile 操作，证据写 review.md） -->
