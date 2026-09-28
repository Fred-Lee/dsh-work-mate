# proposal-middleware Specification

## Purpose
TBD - created by archiving change add-proposal-middleware. Update Purpose after archive.
## Requirements
### Requirement: Agent 提案工具

插件 SHALL 经 `ctx.tools.register` 注册三个工具：`workmate_proposal_create`
（创建提案并落 `proposals.json`，能解析项目根时同步生成 `openspec/changes/<id>/`
三件套模板）、`workmate_proposal_status`（返回提案详情、关联 Git 提交与 OpenSpec
状态）、`workmate_proposal_archive`（推进提案状态）。工具 SHALL 经宿主 `tools`
服务注册（模块级 `inject` 声明），参数校验失败 SHALL 返回可读错误而非抛栈。

#### Scenario: Agent 创建提案后 openspec 目录自动生成

- **WHEN** Agent 携带有效 `projectRoot` 调用 `workmate_proposal_create`
- **THEN** `proposals.json` 新增一条 draft 提案，且 `<projectRoot>/openspec/changes/<id>/`
  出现 `proposal.md`、`design.md`、`tasks.md`

#### Scenario: 已存在的 change 目录永不被覆盖

- **WHEN** `openspec/changes/<id>/` 已存在时再次创建同 id 提案
- **THEN** 现有目录内容保持不变，工具返回 `openspecDir: 'existing'`

#### Scenario: 无法解析项目根时提案仍可创建

- **WHEN** 未传 `projectRoot` 且 `Config.projectRoot` 为空
- **THEN** 提案照常落库，返回值带 `note` 说明项目侧动作（目录生成、Git 扫描）被跳过

### Requirement: Git 提交关联（pull 模式）

`workmate_proposal_status` SHALL 以 `git log --fixed-strings --grep '[proposal:<id>]'
--all` 在关联项目根上收集提交（hash、短 hash、标题）；仓库不可用 SHALL 降级为空列表
加 `gitNote`，不得使 status 失败。子进程 SHALL 使用 argv 数组且无 shell。

#### Scenario: 含提案标记的提交被聚合展示

- **WHEN** 项目中存在提交信息含 `[proposal:batch-grading-v2]` 的提交且 id 关联该项目
- **THEN** status 返回的 `commits` 数组包含该提交

#### Scenario: 非仓库目录优雅降级

- **WHEN** `projectRoot` 不是 git 仓库
- **THEN** `commits` 为空且 `gitNote` 说明原因，status 整体正常返回

### Requirement: 归档状态机

提案状态 SHALL 只在 `draft → executing → archived` 路径上推进；`draft` 直接归档
SHALL 被拒绝；能解析 projectRoot 且 `openspec/changes/<id>/` 缺失时归档 SHALL 被
拒绝（除非 `force: true`）。M2 阶段归档不做外部编排（swarm / CLI），该语义由
里程碑四在工具背后替换，工具签名不变。

#### Scenario: draft 不能直接归档

- **WHEN** 对 draft 提案调用 `workmate_proposal_archive`
- **THEN** 返回错误说明须先推进到 executing，提案状态不变

#### Scenario: 正常两步归档

- **WHEN** 提案先推进到 executing 再归档，且 openspec change 目录存在（或 force）
- **THEN** 状态变为 `archived`，`updatedAt` 更新

### Requirement: REST API 与提案面板

插件 SHALL 经 `webServer.register` 在 `/workmate/` 前缀挂载：`GET
/workmate/api/proposals`、`POST /workmate/api/proposals`、`GET
/workmate/api/proposals/:id`、`POST /workmate/api/proposals/:id/archive`、`GET
/workmate/api/graph`（M5 数据），以及静态 SPA。提案面板 SHALL 可在独立页
`/workmate/` 打开，并 SHALL 以 better-sidebar tab（「🛠 WorkMate」）寄生于 DSH
右侧栏——同一 React 组件两个出口（IIFE 独立页 / ModuleLoader 客户端模块）。

#### Scenario: 面板创建提案全链路

- **WHEN** 在面板输入 id 与标题提交创建
- **THEN** 列表出现新提案（draft），再次 GET 可读出同一条

#### Scenario: better-sidebar 寄生

- **WHEN** DSH web 界面右侧栏 `+` 菜单展开
- **THEN** 出现「🛠 WorkMate」tab，点开后渲染提案面板

#### Scenario: 静态资源遍历保护

- **WHEN** 请求 `/workmate/../package.json` 等越界路径
- **THEN** 返回 404，不泄露文件内容

