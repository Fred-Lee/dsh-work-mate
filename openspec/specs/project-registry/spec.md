# project-registry Specification

## Purpose
TBD - created by archiving change add-multi-project-reopen-git-visibility. Update Purpose after archive.
## Requirements
### Requirement: 项目注册表与多项目关联

插件 SHALL 维护项目注册表（`$DSH_HOME/workmate/projects.json`，
`[{name, root, defaultBranch?, workspace?}]`，原子写），经
`ctx.provide('workmate.projects')` 与 REST（`GET`/`POST`/`DELETE
/workmate/api/projects`）暴露。读取端 SHALL 兼容只有 `{name, root}` 的旧记录，并在
写回时保留未知字段。提案 SHALL 可关联多个项目（名字解析到注册表根）；创建提案的模态
SHALL 支持勾选已注册项目、为每个勾选项目选择基线分支，并内联注册新项目；提案详情
SHALL 按关联项目逐一聚合 Git 信息与关联提交。名字不在注册表的关联 SHALL 被接受并在
详情中标记「未解析根」。

#### Scenario: 一张提案关联多个微服务项目

- **WHEN** 注册三个项目后在创建模态勾选其中两个、分别选择基线分支并提交
- **THEN** 提案 `targets` 含两个项目及各自基线分支，`projects` 含这两个名字，详情分别显示两个项目的分支与提交

#### Scenario: 注册表 CRUD

- **WHEN** 通过 REST 注册/列举/移除项目
- **THEN** `projects.json` 原子更新且读取端一致

#### Scenario: 旧注册表可读

- **WHEN** `projects.json` 中只有 `[{name, root}]` 两项
- **THEN** 注册表正常列出，`defaultBranch` 按探测或未设置处理，写入新项目时不丢旧字段

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

### Requirement: 项目默认分支

每个注册项目 SHALL 可记录 `defaultBranch`。未显式提供时，插件 SHALL 依次探测 `main`
与 `master`，命中则作为该项目的默认分支；两者都不存在时 SHALL 保持未设置，并在分支
列举中暴露 `current` 供创建流程回退。默认分支 SHALL 只作为创建提案时的默认值，SHALL
NOT 强制改变仓库当前检出分支。

#### Scenario: 探测到 master

- **WHEN** 注册一个只有 `master` 分支的仓库且未填默认分支
- **THEN** 该项目 `defaultBranch` 为 `master`，创建模态默认选中它

#### Scenario: 探测不到不猜测

- **WHEN** 仓库既没有 `main` 也没有 `master`
- **THEN** `defaultBranch` 保持未设置，创建模态不预选分支并要求用户选择

### Requirement: 工作区分组

注册项目 SHALL 可带可选 `workspace` 名称，用于把同一根目录下的多个仓库（例如
`~/Documents/xkw_workspace` 下的服务群）在面板中分组展示。`workspace` SHALL 只是展示
与筛选维度，SHALL NOT 参与路径解析或权限判断。未设置 `workspace` 的项目 SHALL 归入
默认分组，不隐藏。

#### Scenario: 按工作区分组展示

- **WHEN** 注册 internal-homework、homework-server 并都标注 `workspace=xkw`
- **THEN** 面板项目列表把它们归入 xkw 分组，另一未标注项目仍在默认分组

### Requirement: 项目分支列举

插件 SHALL 提供只读分支列举：`GET /workmate/api/projects/:name/branches` 返回
`{current, default, local[], remote[]}`；项目未注册或根不可解析时 SHALL 返回可读错误
与可用候选，而不是空列表。该接口 SHALL NOT 修改仓库状态（不 fetch、不 checkout）。

#### Scenario: 列出一个仓库的分支

- **WHEN** 对已注册项目请求分支列表
- **THEN** 返回当前分支、默认分支与本地/远程分支名列表

#### Scenario: 未注册项目

- **WHEN** 请求一个不在注册表的项目名
- **THEN** 返回错误并列出已注册项目名，不执行任何 git 写操作

### Requirement: DSH Workspace 项目候选发现

插件 SHALL 在宿主提供 `ctx.workspaceRegistry` 时读取已注册的 Workspace 目录，并只读过滤出可加入的项目候选：目录存在、是 git 仓库、尚未在 WorkMate 项目注册表、规范化路径不重复。候选 SHALL 显示标题、路径、当前分支与是否含 `openspec/`。

插件 SHALL NOT 自动把 Workspace 目录写入项目注册表；加入 SHALL 由用户一键确认，写入时探测 `main`/`master` 作为默认分支，`workspace` 取 Workspace 标题或路径父目录。宿主未提供 Workspace 服务时，入口 SHALL 隐藏并给出说明，SHALL NOT 影响现有注册表读写。

#### Scenario: 从 Workspace 导入一个仓库

- **WHEN** 用户打开「导入项目」，看到一个已注册 Workspace 下的 git 仓库
- **THEN** 候选行显示路径/当前分支/openspec 标记，点「加入」后写入注册表并出现在项目树

#### Scenario: 重复路径不重复导入

- **WHEN** 同一目录已通过手填路径注册
- **THEN** 该 Workspace 候选标记为已注册，不出现「加入」动作

#### Scenario: 非 git 目录被过滤

- **WHEN** Workspace 列表包含一个普通文档目录
- **THEN** 它不作为项目候选出现（或标记不可用），不会被自动加入注册表

