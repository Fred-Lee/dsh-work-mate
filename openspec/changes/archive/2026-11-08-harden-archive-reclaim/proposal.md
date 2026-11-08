# 归档收尾健壮性：回收以配置主干为准、合并校验先看远端

## Why

两处实测（SystemOne 变更归档审查 MED-6 与 2026-11-08 全库评审）：

1. **回收必然被拒**：`src/features/archive/service.ts` 的归档回收调
   `worktree.remove({ projectRoot, proposalId })` 不传 `mainBranch`，`manager.remove`
   落回 `'main'`，守卫以"`feature/<id>` 未合入 `main`"拒绝——而本仓库事实主干是
   `lifecycleMainBranch` 配置的分支。`fix-panel-scroll` 已 archived，其 worktree
   `.workmates/fix-panel-scroll` 至今无法回收（`git worktree list` 仍列出）。
2. **远端合并后误判未合并**：`isMergedInto` 是纯本地 `merge-base --is-ancestor`，
   整条归档路径没有一次 `git fetch`。合并发生在远端（GitLab MR / GitHub PR）时，
   本地基线分支是旧的，归档门会假报"未合并"。

两处同属"归档收尾"，一次修完。

## What Changes

- 归档回收与单独释放调 `worktree.remove` 时 SHALL 透传 `this.mainBranch`
  （`merging`/`archiving` 的合并校验本来就透传，只有回收漏了）。
- `isMergedInto` 在比对前 SHALL 对已配置的远端做一次 **best-effort fetch**
  （`git fetch <remote> <branch> <onto>`，失败静默——本地-only 仓库保持现行为）。
- 面板单独释放走同一 `remove` 入口，自动获得两个修复。

## Capabilities

### Modified Capabilities

- `multi-target-worktree`：「按目标清理与回收」补充两条语义——回收守卫的合并确认
  以 `lifecycleMainBranch`（而非字面 `main`）为准；合并确认前 SHALL best-effort
  fetch 远端。

## Impact

- `src/features/archive/service.ts`（回收两处调用补 `mainBranch`）、
  `src/features/worktree/git.ts`（`isMergedInto` fetch）、
  `src/features/worktree/manager.ts`（无需改，`remove` 已有入参）、
  `src/features/worktree/worktree.test.ts`（fetch 行为用例：远端基线领先本地时仍判已合并）。
- 行为变化：归档/释放时多一次 `git fetch`（本地-only 仓库 fetch 失败被吞，无行为变化）。
