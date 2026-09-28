## ADDED Requirements

### Requirement: 项目注册表与多项目关联

插件 SHALL 维护项目注册表（`$DSH_HOME/workmate/projects.json`，`[{name, root}]`，
原子写），经 `ctx.provide('workmate.projects')` 与 REST（`GET`/`POST`/`DELETE
/workmate/api/projects`）暴露。提案 SHALL 可关联多个项目（名字解析到注册表根）；
创建提案的模态 SHALL 支持勾选已注册项目并内联注册新项目；提案详情 SHALL 按关联
项目逐一聚合 Git 信息与关联提交。名字不在注册表的关联 SHALL 被接受并在详情中
标记「未解析根」。

#### Scenario: 一张提案关联多个微服务项目

- **WHEN** 注册三个项目后在创建模态勾选其中两个并提交
- **THEN** 提案 `projects` 含这两个名字，详情分别显示两个项目的分支与提交

#### Scenario: 注册表 CRUD

- **WHEN** 通过 REST 注册/列举/移除项目
- **THEN** `projects.json` 原子更新且读取端一致

### Requirement: 关联项目 Git 可观测

提案详情 SHALL 对每个关联项目（根可解析时）返回：当前分支、HEAD 短 hash、脏文件
数、是否 linked worktree，以及该项目的 `[proposal:<id>]` 关联提交。看板卡片详情
SHAL 按项目分组展示这些信息。git 不可用 SHALL 降级为该项目的 note，不影响整体。

#### Scenario: worktree 场景可辨识

- **WHEN** 某关联项目的根是一个 linked worktree
- **THEN** 该项目行显示 worktree 标记与所在分支

### Requirement: 归档可回退

`POST /api/proposals/:id/reopen` 与看板「重新打开」SHALL 把 `archived` 提案回退到
`executing`，并对每个关联项目把 `openspec/changes/archive/<date>-<id>/` 搬回
`openspec/changes/<id>/`（搬回失败或目录不存在 SHALL 记入 step 并继续回退）。
非 archived 提案的 reopen SHALL 被拒绝。归档编排 SHALL 对每个根可解析的关联项目
逐一执行 openspec archive。

#### Scenario: 归档发现问题后回退

- **WHEN** 对 archived 提案调用 reopen
- **THEN** 状态回到 executing、各项目 change 目录从 archive/ 搬回 changes/ 可继续编辑

#### Scenario: 编排失败不阻断回退

- **WHEN** 某项目的 archive 目录不存在（例如当初 force 归档）
- **THEN** 该项目记一条 skipped step，提案状态仍然回退成功
