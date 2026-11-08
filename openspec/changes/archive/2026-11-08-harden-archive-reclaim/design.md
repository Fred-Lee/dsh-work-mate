# 归档收尾健壮性：回收以配置主干为准、合并校验先看远端

## D1 回收守卫以配置主干为准

`worktree.remove` 的合并守卫以调用方传入的主干为准；归档编排与面板单独释放
SHALL 透传 `lifecycleMainBranch` 解析出的主干，SHALL NOT 依赖 `remove` 内部的
字面 `'main'` 兜底。理由：`fix-panel-scroll` 实测——主干配置为非 `main` 分支时，
已归档提案的 worktree 永远不满足守卫，目录滞留。

## D2 合并确认前 best-effort fetch

`isMergedInto` SHALL 在 `merge-base` 比对前对仓库的 `origin` 执行一次
`git fetch <origin> <branch> <onto>`；fetch 失败（本地-only 仓库、离线、无该远端）
SHALL 静默继续本地比对，SHALL NOT 使校验失败。理由：合并发生在远端
（GitLab MR / GitHub PR）时本地基线落后，纯本地比对会假报"未合并"。

fetch 的对象 SHALL 限于本次比对的两个引用（不做全量 fetch），避免在大仓库上
拖慢归档。fetch 造成的远端跟踪引用更新是常规 git 行为，不视为副作用。

## D3 行为不变量

- 本地-only 仓库（无 `origin` 远端）：行为与现状逐字节一致（fetch 失败被吞）。
- 已在本地合并的分支：fetch 前后结论一致。
- 守卫拒绝时仍保留端口分配（现状语义，不随本变更改变）。
