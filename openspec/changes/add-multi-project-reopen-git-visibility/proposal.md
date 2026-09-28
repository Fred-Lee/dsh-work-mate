# Add Multi-Project, Reopen and Git Visibility

## Why

真机演示的四条反馈：
1. **归档不可逆**——归档后发现有问题无法回退；openspec CLI 也没有恢复命令。
2. **多项目关联不可配置**——微服务变更需要一张提案关联多个项目同步改，但 UI 没有
   任何配置入口；host 的 `projects: string[]` 字段成了死数据。
3. **关联项目的 Git 不可观测**——看不到每个项目的分支、HEAD、脏状态，worktree
   场景（Helmsman 血统的核心场景）完全不可见。
4. **对话入口弹层样式异常**——弹层渲染在 `.wm-root` 之外，CSS 变量全部丢失；
   触发按钮本身也从未注入过样式（只有弹层内部才注入）。

## What Changes

1. **项目注册表**（问题 2）：`$DSH_HOME/workmate/projects.json`（`[{name, root}]`，
   原子写）+ `ctx.provide('workmate.projects')` + REST（GET/POST/DELETE
   `/api/projects`）。提案 `projects` 关联项目名，项目根由注册表解析。
2. **归档可回退**（问题 1）：`ArchiveServiceImpl.reopen`——`archived → executing`，
   并对每个关联项目把 `openspec/changes/archive/<date>-<id>/` 搬回
   `openspec/changes/<id>/`（搬不回或目录不存在则记入 step，状态照样回退）。
   REST `POST /api/proposals/:id/reopen` + 看板已归档卡片「重新打开」按钮。
3. **Git 可观测**（问题 3）：`getGitInfo(root)`——分支、HEAD 短 hash、脏文件数、
   是否 linked worktree（`git-dir ≠ git-common-dir`）。提案详情对每个关联项目
   返回 `git` 信息块与其关联提交；看板卡片详情按项目分组展示。
4. **编排多项目化**（问题 2/3 的联动）：归档/重开编排对注册表能解析出根的每个
   关联项目逐一执行（openspec archive / 目录搬回）；显式 `projectRoot` 参数仍然
   最高优先（向后兼容）。
5. **对话弹层修复**（问题 4）：弹层根节点套 `.wm-root` 恢复变量作用域；触发按钮
   挂载时注入一次样式（`useEffect`）；创建模态支持勾选已注册项目 + 内联注册新项目。
6. **工具**：`workmate_proposal_status` 返回多项目聚合；`workmate_proposal_create`
   的 `projects` 参数语义变为「项目注册表中的名字」（不存在的名字返回警告并接受）。

## Capabilities

### 新增能力

- `project-registry`：多项目注册表与按项目聚合的可观测/编排面。

### 修改能力

- `archive-orchestration`：新增 reopen 反向编排；多项目逐一执行。
- `proposal-middleware`：详情聚合多项目 Git 可观测；对话入口样式修复。

## Impact

- host：新增 `src/features/project/registry.ts`、`git.ts` 的 `getGitInfo`、
  `service.ts` 的 `reopen`、编排多项目循环、4 个 REST 端点。
- client：创建模态项目选择器、卡片详情项目分组、重新打开按钮、弹层作用域修复。
- 兼容：已有提案的 `projects: string[]` 不变；单 `projectRoot` 参数路径全部保留。
