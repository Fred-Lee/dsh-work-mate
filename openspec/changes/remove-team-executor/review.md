## 确认项

- 每一条 team-* requirement 都对应本变更的删除动作：team-orchestration 10 条、team-console 5 条、
  agent-team-roles 3 条全部归档为 REMOVED；team-evidence 保留 2 条、移除 2 条，与 proposal 的
  「Modified Capabilities」一致。
- 消费者枚举已核对：`src/index.ts`（store/runner/tools/startup recovery）、`src/api.ts`（4 条路由
  + 3 个依赖）、`src/client/{App,api,styles,team-waves}`、`src/config.ts`（7 项）、
  `src/features/archive/{service,orchestrate}`、`src/features/proposal/{readiness,events}`、
  `src/features/task/service.ts`（事件 kind）、`src/features/guidance`（runtime skill）——
  全部列在 proposal 的 Impact 里。
- 归档门 `teamEvidenceGate` 的判据从「Run 存在」改为「`TASKS.json` 存在」，与
  `adopt-superagent-openspec-source` 的「有 TASKS.json 的变更必须有 TEST.md/TEAM-REVIEW.md」
  一致，没有引入新语义。
- 回滚计划完整：本变更只有一次代码提交，`git revert` 即可还原；`team-runs.json` 不删除，
  保留为回滚证据。
- 旧的 `workmate_team_*` 工具移除后，`docs/TEAM-SETUP.md` 一并删除，AGENTS.md 与 README 的
  团队章节改述为「已移除，执行走 Super-agent」，不留"文档说能用、代码里没有"的错位。

## 疑问项

- `TASKS.json` 的 `role` 字段失去派发消费者，是否保留？本设计保留为展示字段，理由写在
  design 的 Open Questions 第 1 条，需要所有者确认下一期是否从 schema 去掉。
- `teamEvidenceGate` 是否改名 `taskEvidenceGate`？本期不改名以免旧配置静默失效，需要所有者确认。

## 建议补充项

- 建议在 `Config` 里对已删除的 7 个键各留一行注释（`// removed in remove-team-executor`），
  让将来读代码的人知道它们曾经存在、为什么消失，而不是以为从来就有。
- 建议把 `team-runs.json` 的残留写进接入手册的排查表：升级后如果看到该文件，说明曾是团队
  模式，可以手工删除，不影响装载。

## CRITICAL 问题

- [x] CRIT-1 删除 `src/features/team/` 后 `src/features/archive/orchestrate.ts` 仍 import
  `parseTeamSummary`，`src/features/archive/service.ts` 仍 import `checkTeamEvidence` 与
  `TeamRunStore`：必须同步改写这两处，否则整个插件编译失败。
- [x] CRIT-2 `src/features/proposal/readiness.ts` 的 `teamRun` 输入与 `src/api.ts` 的
  `readiness` 传参必须一起删，否则 `y` 类型不匹配。
- [x] CRIT-3 `src/client/App.tsx` 的 `TeamView` 与 `'team'` 视图成员、`getPanelConfig` 的
  返回值类型必须一起改，否则客户端 typecheck 失败。
- [x] CRIT-4 删除派发后 `src/features/task/service.ts` 仍以 `kind: 'team-settled'` 写事件；
  必须改成 `task-settled` 并在 `events.ts` 的 kind 白名单里新增，否则任务事件全部被判为非法行。
