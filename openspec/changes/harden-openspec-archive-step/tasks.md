# Tasks — 归档编排的 openspec-archive 步骤核验产物

> 范围声明用行内 HTML 注释 `writes:`（swarm 装批 + `workmate_plan_drift` 都读它）；写法照任务行末尾的样子抄。
> 同一文件出现在多行时**不得并行**（writes 相交）。
> 本变更不新增运行时依赖，不改八态语义，不改门禁默认档位。
> 顺序有依赖：任务 3 的反证用例必须在任务 2 之前跑出红，否则"修复算数"无法证明。

- [ ] 1. 规格增量 `specs/archive-gates/spec.md`：`openspec-archive` 步骤的成败 SHALL 由产物事实判定（变更是否已从 `changes/<id>/` 移入 `changes/archive/<date>-<id>/`），SHALL NOT 仅凭退出码；失败时记 `failed` + `ok=false` + 提案停在 `archiving`，摘要同时含 CLI 输出与产物事实；无 `specs/` 的变更与幂等重跑 SHALL NOT 被误判 <!-- writes: openspec/changes/harden-openspec-archive-step/specs/** -->

- [ ] 2. 核验实现 `src/features/archive/orchestrate.ts`：`openspec-archive` 步骤在 `execCli` 返回后复用 `readChangeState()` 复查产物；`state !== 'archived'` 时记 `failed`、置 `allArchived = false`、`continue` 跳过该 target 的 gitnexus 重索引；摘要拼上 CLI 原话与"变更目录仍在原地"；既有 `catch` 分支（CLI 非 0）语义不变 <!-- writes: src/features/archive/orchestrate.ts -->

- [ ] 3. 反证先行 `src/features/archive/orchestrate.test.ts`：新增反证用例（delta 非法的变更 → 断言 `failed` + `ok=false` + 提案停在 `archiving`），**在任务 2 之前跑一次确认它是红的**；再把既有两处依赖假绿的夹具（`:111` 与 `:591` 的"假装归档但不移动目录"）改成真实夹具或按新语义断言 `failed` <!-- writes: src/features/archive/orchestrate.test.ts -->

- [ ] 4. 正证与幂等 `src/features/archive/orchestrate.test.ts`：正证用例（同一夹具只把段头换成 `## ADDED Requirements` → `ok` + 目录确实移走）、幂等用例（归档成功后重跑 → `skipped` 而非 `failed`）、无 `specs/` 的变更不被误伤 <!-- writes: src/features/archive/orchestrate.test.ts -->

- [ ] 5. 文档：`AGENTS.md` 归档门禁表补一行"归档步骤的成败由产物事实判定（退出码 0 不够）"，与本次新增要求对齐 <!-- writes: AGENTS.md -->

- [ ] 6. 收口：`pnpm typecheck && pnpm test && pnpm build && pnpm verify` 四道门全绿；把反证的红→绿过程、以及"重启前只能给代码级证据"的边界写进 `review.md` <!-- writes: openspec/changes/harden-openspec-archive-step/review.md -->
