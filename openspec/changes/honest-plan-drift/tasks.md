# Tasks — plan-drift 诚实化

- [x] 1. `computeDrift` 增加 `ignoredPrefixes` 选项与 `excluded` 字段；前缀相等双向判定；`excluded` 不计入 `missing`、不影响 `driftRatio` <!-- writes: src/features/proposal/artifacts.ts -->

- [x] 2. 编排层：`collectProjectDrift` 把计划目录前缀传入；`plan-drift` 步骤在有未触及声明时产出 `warn`（不阻断）；`StepResult.status` 新增 `'warn'` <!-- writes: src/features/archive/orchestrate.ts -->

- [x] 3. 用例：warn 步骤不阻断且点名未触及声明、计划目录声明不算 missing、前缀相等的声明也算 excluded、`excluded` 不计入 `missing` <!-- writes: src/features/archive/drift.test.ts, src/features/proposal/artifacts.test.ts -->

- [x] 4. 文档：`AGENTS.md` 归档门禁表写明 plan-drift 只拦"改了没声明"，"声明了没改"是 warn <!-- writes: AGENTS.md -->

- [x] 5. 收口：`pnpm typecheck && pnpm test && pnpm build && pnpm verify`；三份提案的 `workmate_plan_drift` 复跑确认 `missing` 里不再出现计划目录与示意值；把结论写进 `review.md` <!-- writes: openspec/changes/honest-plan-drift/review.md -->
