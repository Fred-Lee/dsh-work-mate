# project-registry Specification

## Purpose
TBD - created by archiving change add-multi-project-reopen-git-visibility. Update Purpose after archive.
## Requirements
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

提案生命周期 SHALL 全程可逆：`start`（draft→executing）↔ `stop`（executing→draft）、
`archive`（executing→archived，编排）↔ `reopen`（archived→executing，目录搬回）。
`stop` SHALL 只做状态回退（openspec 目录不动）；对非 executing 提案的 stop SHALL
被拒绝；对非 archived 提案的 reopen SHALL 被拒绝。归档编排 SHALL 对每个根可解析的
关联项目逐一执行 openspec archive。Agent 工具 `workmate_proposal_archive` SHALL
提供 `mode` 参数（archive/start/reopen/stop）覆盖全部四个流转方向，旧布尔 `start`
参数保持兼容。

#### Scenario: 执行中退回提案

- **WHEN** 对 executing 提案调用 stop（REST 或工具 mode=stop）
- **THEN** 状态回到 draft，openspec change 目录保持原位可继续编辑

#### Scenario: 四向流转工具面

- **WHEN** Agent 分别以 mode=start/archive/reopen/stop 调用工具
- **THEN** 四种流转各自生效；非法方向（如 draft 直接 archive）返回可读错误且状态不变

#### Scenario: 归档发现问题后回退

- **WHEN** 对 archived 提案调用 reopen
- **THEN** 状态回到 executing、各项目 change 目录从 archive/ 搬回 changes/ 可继续编辑

