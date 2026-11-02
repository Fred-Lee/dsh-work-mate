# Design — 移除团队执行器

## Context

`src/features/team/` 是 `autonomous-agent-team` 时期留下的派发实现：Runner 起
DSH 子代理，按 `TASKS.json` 的 DAG 分波次派发，用 roster 的角色 → preset / 模型映射，
把结果写进 `team-runs.json` 与 `SUMMARY.md`。

`adopt-superagent-openspec-source` 把执行交给了 Super-agent 之后，它被降级成
`taskExecutor=team` 的回退线：默认关闭、派发工具直接抛错、面板团队视图只读。
真机验收从未跑过它，只在引擎级演练里验过 worktree 回收。

它重复的正是 Super-agent 已经做得更好的一层（并发、重试、会话、提问），留下来意味着
每次改任务层都要同时维护两套派发与两套状态机。

## Goals / Non-Goals

**Goals**

- 删除派发实现与它的全部接线（工具 6 个、REST 4 条、面板 1 个视图、配置 7 项）。
- 保留与执行无关的治理能力：`TASKS.json` 作为任务单一事实源、`TEST.md` /
  `TEAM-REVIEW.md` 作为归档证据、写域冲突检查。
- 删除后插件仍能在所有 profile 里激活（没有新的必需服务）。

**Non-Goals**

- 不改 Super-agent 侧任何代码。
- 不迁移历史 `team-runs.json`（保留文件，不再加载）。
- 不重建多角色协作。若将来需要，走 `TASKS.json` role → Source `meta` →
  `executor.prepare`，而不是在 WorkMate 里再起一套。

## Decisions

### D1: 整个目录删除，不是"注释掉"

保留半套实现（比如只删 Runner 留 roster）会让"角色"这个概念悬空：没有任何代码消费它，
却还在配置里存在。要么完整保留，要么完整删除。选删除：默认关闭 + 真机未用 + 重复
Super-agent 三层语义，三条都指向删除。

**备选**：只删派发、留 `tasks.ts` 的 DAG/写域/波次规划。否决：没有执行器就没有波次，
`planTeamWaves` 只剩测试在用；而写域冲突已经由 `writeConflictGate` 与 `swarm` 覆盖。

### D2: `taskExecutor` 配置一并删除

删除团队后它只剩一个取值。留一个永远等于 `superagent` 的枚举，是给未来的自己留歧义。
`GET /api/config` 仍返回 `taskExecutor` 常量（客户端已读，删接口会让旧面板拿不到值），
但不再可配。

**备选**：保留配置并只允许 `superagent`。否决：Schemastery 的枚举校验会在旧 profile
写 `team` 时拒绝整条配置，反而不如直接删掉这个键——旧值成为未知键，被忽略而不是报错
（实测 Schemastery 对未知键是**保留并透传**，不会阻断）。

### D3: `teamEvidenceGate` 保留，语义收窄到工件

它在 `merging→archiving` 前检查 `TEST.md` / `TEAM-REVIEW.md` 的段头，这条规则与谁执行
无关——Super-agent 的 worker 同样应当留下测试与审查证据。但现在的实现会读
`teamRuns` 来判断"这是不是 team-managed change"；Run 没了以后，判据改为
"该变更目录里有没有 `TASKS.json`"。

**备选**：连门一起删。否决：那会让"有 TASKS.json 却没有任何测试证据"的变更静默归档，
这是把有用的治理能力当成执行器的陪葬。

### D4: 事件流保留 `team-*` 的历史可读性

`events.jsonl` 是 append-only 事实流，已有 `team-dispatch` / `team-settled` / `team-run`
行。删掉这三个 kind 会让旧事件变成"非法行"（读取端忽略并计数），指标失真。
所以：**保留读取**，**停止生产**。任务层自己的事件从 `kind: 'team-settled'` 改为
`kind: 'task-settled'`（新增一个 kind）。

### D5: 面板团队视图整段删除

`TeamView` 在 superagent 模式下已经是只读投影，删掉它不损失任何操作——回答与重试都在
任务视图。`team-waves.ts` 只被它使用，一并删除。

## Risks / Trade-offs

- **回退路径变窄**：`taskExecutor=team` 不再可用。若 Super-agent 整体不可用，现在只有
  "面板记录 + 等恢复"，没有"另一套执行器顶上"。→ 缓解：这正是本变更的取舍；回退定义
  从「换执行器」变成「停用子包 + 改回面板记录」，在接入手册里写明。
- **旧 profile 配置报错风险**：如果 Schemastery 对未知键是**拒绝**而不是透传，旧
  profile 里的 `taskExecutor: team` 会让 workmate 整条配置校验失败。→ 已实测本仓库的
  Schemastery 对未知键透传（`{"a":"1","removedKey":"y"}`），不阻断；同时在升级说明里
  写"建议删除这些键"。
- **`team-runs.json` 残留**：不再加载但文件还在磁盘上。→ 有意保留：它是回滚证据，删除
  由用户手工决定。
- **`TASKS.json` 的 role 字段失去消费者**：任务卡片仍显示 role 标签，但没有人用它派发。
  → 保留字段（人工阅读有用），文档标明"仅展示"。

## Migration

1. 删 `src/features/team/` 与接线。
2. 旧 profile 的 `cordis.patch.yml` 里若有 `taskExecutor` / `teamAutoPlan` /
   `teamReadonlyPreset` / `teamWorkspacePreset` / `teamRequireRolePresets` /
   `teamRoleModels`，建议删除（不删也能装载，值被忽略）。
3. `workmate/team-runs.json` 保留不动；需要清理时手工删除。
4. 回滚：从 git 恢复该目录与接线（本变更只有一个提交，`git revert` 可完整还原）。

## Open Questions

1. `TASKS.json` 的 role 字段是否还需要写进 `tasks.json`？当前保留为展示字段；如果确认
   永远不会有消费者，下一期从 schema 里去掉。
2. 是否把 `teamEvidenceGate` 改名为 `taskEvidenceGate`？改名会让旧配置静默失效，
   本期不改名，只在描述里说明它现在按工件判断。
