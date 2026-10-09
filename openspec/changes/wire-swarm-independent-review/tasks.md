# Tasks — swarm 任务独立核验

> 范围声明用行内 HTML 注释 `writes:`（swarm 装批 + `workmate_plan_drift` 都读它）；写法照任务行末尾的样子抄。
> 本变更不新增依赖。

- [x] 1. 规格增量 `specs/swarm-verification/spec.md`：核验记录的形状与三条硬规则（未合并不得核验、核验必须署名、独立性由 git 事实派生）；门禁语义（默认关；开启后每个已合并任务须有非 `same-as-author` 的核验记录；`undetermined` 视同未核验）<!-- writes: openspec/changes/wire-swarm-independent-review/specs/** -->

- [x] 2. 记录类型与 `verify`：`SwarmVerification` + `SwarmTaskRecord.verification`；`SwarmManager.verify`（未合并拒绝 / 空 reviewer 拒绝 / 读 `repoRoot` 提交 author / 复用 `judgeReviewerIndependence` / 写回）；`plan` 重规划时保留既有核验记录 <!-- writes: src/features/swarm/manager.ts -->

- [x] 3. 工具面：`workmate_swarm_task` 新增 `action=verify` 与 `reviewer` / `verdict` / `evidence` 参数；缺参明确报错；`same-as-author` 时返回 `warning`；`SwarmManager` 构造处接 `repoRoot`（无 `Config.projectRoot` 则 `undefined` → `undetermined`）<!-- writes: src/index.ts -->

- [x] 4. 配置面：`Config.swarmReviewRequired`（默认 `false`），interface 与运行时 schema 两份同步，并同步 `CONFIG_DEFAULTS` 与 `src/config.test.ts` 的默认值断言 <!-- writes: src/config.ts, src/config.test.ts -->

- [x] 5. 归档门：`orchestrateArchive` 的 swarm 步骤在 `swarmReviewRequired` 为 true 时，对已合并任务检查核验记录与独立性；失败时逐任务点名（未核验 / 同一身份）并给出两条出路；`service.ts` 与 `src/index.ts` 透传该配置 <!-- writes: src/features/archive/orchestrate.ts, src/features/archive/service.ts -->

- [x] 6. 单测：`src/features/swarm/manager.test.ts` 增 6 条（未合并拒绝 / 未署名拒绝 / 独立核验记录与证据 / 自评判 `same-as-author` / 无 repoRoot 判 `undetermined` / 重规划保留记录）；`src/features/archive/orchestrate.test.ts` 增 1 条覆盖门禁四态（默认放行 / 未核验拦 / 自评拦 / 全核验放行并计数）<!-- writes: src/features/swarm/manager.test.ts, src/features/archive/orchestrate.test.ts -->

- [x] 7. 文档：`AGENTS.md` 归档门禁表补一行 `swarmReviewRequired`；流程 skill 的「并行执行（swarm）」小节写明 merge 之后要 verify，以及门禁默认关闭<!-- writes: AGENTS.md, src/features/guidance/content.ts -->

- [x] 8. 收口：`pnpm typecheck && pnpm test && pnpm build && pnpm verify`（`verify` 现含测试自证门）；把"验了什么 / 明确没验什么"写进 `review.md`（未验：真实多 agent 协作下场的人工核验流程，只做了单测与编排级 fake 数据）<!-- writes: openspec/changes/wire-swarm-independent-review/review.md -->

## 验收命令（每步都跑，不以退出码判定）

```bash
pnpm typecheck && pnpm exec vitest run src/features/swarm src/features/archive
pnpm test && pnpm build && pnpm verify
```

## 完成标记纪律

`[x]` 只表示"这一步被认为完成了"。第 8 项必须给出可证伪结论：新增用例数、基线对照
（本轮开工前 40 文件 / 348 用例）、以及明确未覆盖的分支。
