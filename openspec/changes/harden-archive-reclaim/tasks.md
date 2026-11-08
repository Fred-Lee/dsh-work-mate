# Tasks — 归档收尾健壮性

- [ ] 1. 规格增量：`multi-target-worktree` 的「按目标清理与回收」补两条语义——
  回收守卫以调用方传入的主干为准（SHALL NOT 依赖字面 `'main'` 兜底）；
  合并确认前 SHALL best-effort fetch `origin` 的两个引用，失败静默 <!-- writes: openspec/changes/harden-archive-reclaim/specs/** -->

- [ ] 2. `src/features/archive/service.ts`：归档回收与面板单独释放的
  `worktree.remove` 调用透传 `mainBranch: this.mainBranch` <!-- writes: src/features/archive/service.ts -->

- [ ] 3. `src/features/worktree/git.ts`：`isMergedInto` 比对前 best-effort
  `git fetch origin <branch> <onto>`，失败静默 <!-- writes: src/features/worktree/git.ts -->

- [ ] 4. 用例：远端基线领先本地时（远端已合并、本地基线落后）回收仍判已合并；
  本地-only 仓库行为不变 <!-- writes: src/features/worktree/worktree.test.ts, src/features/archive/reclaim.test.ts -->

- [ ] 5. 门禁：`pnpm typecheck && pnpm test && pnpm build && pnpm verify` 全绿后归档
  <!-- writes: （无源码写域；仅运行命令与记录） -->
