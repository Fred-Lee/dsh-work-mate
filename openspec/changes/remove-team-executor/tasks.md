# 任务：移除团队执行器

- [ ] 1. 删除派发实现 `src/features/team/**`（runner / coordinator / tools / store /
  prepare / summary / roster / presets / models / tasks / evidence / completeness /
  inbox / artifacts / auto-plan / host-dispatcher / events / prompts + 全部测试）
  <!-- writes: src/features/team/ -->

- [ ] 2. 插件接线 `src/index.ts`：移除 `TeamRunStore` / `TeamRunner` / `autoPlanTeamRun` /
  `registerTeamTools` / subagents 注入 / 团队模式的启动恢复扫描 / 相关依赖注入；
  归档与 API 不再收到 `teamRuns`
  <!-- writes: src/index.ts -->

- [ ] 3. REST `src/api.ts`：删除 `/api/team/runs*` 四条路由与 `teamRuns` / `teamAutoPlan` /
  `teamAnswer` 依赖；`readiness` 不再传 `teamRun`
  <!-- writes: src/api.ts, src/api.test.ts -->

- [ ] 4. 配置 `src/config.ts`：删除 `taskExecutor` / `teamAutoPlan` /
  `teamReadonlyPreset` / `teamWorkspacePreset` / `teamRequireRolePresets` /
  `teamRoleModels`；保留 `teamEvidenceGate`（语义改为按 `TASKS.json` 判断）。
  每个删除位留一行 `// removed in remove-team-executor` 注释
  <!-- writes: src/config.ts, src/config.test.ts -->

- [ ] 5. 归档侧 `src/features/archive/service.ts` + `orchestrate.ts`：
  去掉 `createTarget` 分支（superagent 是唯一执行器）、去掉 `teamRuns` 依赖、
  把 `checkTeamEvidence` 改为按 `TASKS.json` 判断、去掉 manifest 的 `team` 段与
  `SUMMARY.md` 映射
  <!-- writes: src/features/archive/service.ts, src/features/archive/orchestrate.ts,
      src/features/archive/orchestrate.test.ts, src/features/archive/team-gate.test.ts -->

- [ ] 6. 提案侧 `src/features/proposal/readiness.ts` 去掉 `teamRun` 检查；
  `src/features/proposal/events.ts` 保留 `team-*` 的历史读取、新增 `task-settled`
  kind 并让 `src/features/task/service.ts` 使用它
  <!-- writes: src/features/proposal/readiness.ts, src/features/proposal/readiness.test.ts,
      src/features/proposal/events.ts, src/features/task/service.ts -->

- [ ] 7. 面板 `src/client/App.tsx` + `api.ts` + `styles.ts`：删除 `TeamView` 与 `'team'`
  视图成员、团队 API 客户端函数与 wm-team 样式；`getPanelConfig` 只返回
  `taskExecutor: 'superagent'`
  <!-- writes: src/client/App.tsx, src/client/api.ts, src/client/styles.ts,
      src/client/team-waves.ts, src/client/team-waves.test.ts, src/client/app.test.tsx -->

- [ ] 8. guidance `src/features/guidance/index.ts` + `content.ts`：删除
  `workmate-team-run` runtime skill 与对应 flow 段落
  <!-- writes: src/features/guidance/index.ts, src/features/guidance/content.ts,
      src/features/guidance/guidance.test.ts -->

- [ ] 9. 归档测试收敛：`multitarget.test.ts` / `trunk.test.ts` 删除依赖
  `taskExecutor: 'team'` 的 worktree 创建用例，保留 superagent 路径与基线校验的用例
  <!-- writes: src/features/archive/multitarget.test.ts, src/features/archive/trunk.test.ts -->

- [ ] 10. 文档：`AGENTS.md` 团队章节改为「已移除」、`README.md` 去掉团队视图与工具、
  删除 `docs/TEAM-SETUP.md`、`docs/SUPERAGENT-INTEGRATION.md` 回滚从三件事改两件事、
  `docs/SUPERAGENT-ACCEPTANCE.md` 去掉团队条目
  <!-- writes: AGENTS.md, README.md, docs/TEAM-SETUP.md,
      docs/SUPERAGENT-INTEGRATION.md, docs/SUPERAGENT-ACCEPTANCE.md -->

- [ ] 11. 门禁：`pnpm typecheck && pnpm test && pnpm build && pnpm verify`；
  `pnpm test:toolchain`；确认 `pnpm verify:built` 的工具面不再含 6 个团队工具
  <!-- writes: （无源码写域；仅运行命令与记录） -->
