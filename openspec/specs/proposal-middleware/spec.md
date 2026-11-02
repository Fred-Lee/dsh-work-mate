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
拒绝（除非 `force: true`）。M2 阶段归档不做外部编排（CLI），该语义由
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
/workmate/api/proposals/:id`、`POST /workmate/api/proposals/:id/advance`、`POST
/workmate/api/proposals/:id/transition`、`POST /workmate/api/proposals/:id/archive`、
`GET /workmate/api/graph`（M5 数据），以及静态 SPA。客户端 SHALL NOT 调用未注册的端点。
提案面板 SHALL 可在独立页 `/workmate/` 打开，并 SHALL 以 better-sidebar tab
（「🛠 WorkMate」）寄生于 DSH 右侧栏——同一 React 组件两个出口（IIFE 独立页 /
ModuleLoader 客户端模块）。

状态详情 SHALL 返回 `lifecycle: { status, hint, prev?, next? }`（由八态链派生，客户端
SHALL NOT 自己复制状态顺序），面板 SHALL 据此提供「回退到 <prev>」「推进到 <next>」
两类流转按钮，并 SHALL 在 `archiving` 状态提供「完成归档」。

`POST /:id/archive` SHALL 接受 `{ force?: boolean }` 并且 agent 工具
`workmate_proposal_archive` SHALL 接受同名参数：`force: true` SHALL 只跳过**审查门**
（`review.md` 缺失或存在未解决 CRITICAL 时继续），SHALL NOT 跳过 openspec archive、
gitnexus 步骤，也 SHALL NOT 放宽"仅 archiving 可归档"的前置。

#### Scenario: 面板创建提案全链路

- **WHEN** 在面板输入 id 与标题提交创建
- **THEN** 列表出现新提案（draft），再次 GET 可读出同一条

#### Scenario: 面板推进与回退

- **WHEN** 展开一张 draft 卡片并点击「推进」
- **THEN** 状态变为 proposing 且按钮随之更新为新的 prev/next

#### Scenario: 审查门缺失时强制归档

- **WHEN** 提案处于 archiving 且目标项目缺 `review.md`，调用 `archive` 带 `force: true`
- **THEN** 编排继续执行 openspec archive 与 gitnexus 步骤（步骤日志标记 review-gate 被跳过）

#### Scenario: better-sidebar 寄生

- **WHEN** DSH web 界面右侧栏 `+` 菜单展开
- **THEN** 出现「🛠 WorkMate」tab，点开后渲染提案面板

#### Scenario: 静态资源遍历保护

- **WHEN** 请求 `/workmate/../package.json` 等越界路径
- **THEN** 返回 404，不泄露文件内容

### Requirement: 归档回退搬回目录

`archived → archiving` 的相邻回退 SHALL 对每个根可解析的关联项目把
`changes/archive/<date>-<id>/` 搬回 `changes/<id>/`（`openspec archive` 无反向命令）。
搬回结果 SHALL 以 `reopen-dir` 步骤随转换结果返回；单个项目搬回失败 SHALL NOT 阻断状态
回退（状态字段优先），也 SHALL NOT 抛出。

#### Scenario: 回退后目录回到 changes/

- **WHEN** 对 archived 提案调用 `transition(to: 'archiving')`
- **THEN** 各项目 `changes/archive/*-<id>/` 回到 `changes/<id>/`，返回步骤含 `reopen-dir: ok`

#### Scenario: 已存在活动目录时不覆盖

- **WHEN** `changes/<id>/` 已经存在
- **THEN** `reopen-dir` 步骤标记 skipped 并说明原因，状态照常回退

### Requirement: 工具取消与并发元数据

长任务工具 SHALL 声明 `timeoutMs` 并把宿主传入的 `exec.signal` 转发到其拥有的子进程
（git、包管理器、openspec CLI、gitnexus）与 HTTP 请求，使调用方可协作取消；
只读工具 SHALL 声明 `isConcurrencySafe: () => true`，写工具 SHALL 保持默认独占。

#### Scenario: 中断传导到子进程

- **WHEN** 归档编排执行期间调用方中断（signal abort）
- **THEN** 正在运行的 CLI 子进程被终止，工具以 aborted 错误收敛而不是继续跑完

#### Scenario: 只读工具可并行

- **WHEN** 同一轮内并发调用 `workmate_proposal_status` 与 `workmate_knowledge_search`
- **THEN** 两者被判为可并行，互不串行阻塞

### Requirement: 看板化提案视图

提案视图 SHALL 呈现为三列看板（提案中 / 执行中 / 已归档），列头展示计数，卡片
SHALL 按状态落列并展示标题、id 与 OpenSpec 进度；点击卡片 SHALL 展开详情
（Git 关联提交、openspec 状态、推进/归档动作）。创建 SHALL 经「＋ 新提案」模态；
整套样式 SHALL 用 CSS 变量实现深色自适应（`prefers-color-scheme`）。

#### Scenario: 状态一眼可读

- **WHEN** 存在不同状态的提案打开面板
- **THEN** 三列并列、每列计数正确、卡片落在对应列且带状态色条与进度条

#### Scenario: 深色环境可读

- **WHEN** 系统（或宿主外壳）处于深色模式
- **THEN** 面板使用深色变量渲染，无白底刺眼或文字不可读

### Requirement: 对话动作行「转为提案」入口

client half SHALL 在 `conversation.chat.assistant-actions`（session 作用域 slot）
注册「🚀 转为提案」动作：点击弹出小表单（标题必填、项目根可选），提交经
`POST /workmate/api/proposals` 创建（id 缺省自动生成），成功后 SHALL 提供
「打开面板」直达链接；slot 注册 SHALL 保持 `ctx.inject(['slots'], …)` 局部作用域，
`slots` 服务缺席时 client half 其余部分 SHALL 不受影响。

#### Scenario: 头脑风暴后一键转入开发流程

- **WHEN** 用户在 AI 回复的动作行点击「🚀 转为提案」并填写标题提交
- **THEN** 提案创建成功，点击「打开面板」直达 WorkMate 看板并能看到新提案

#### Scenario: slots 缺席不拖垮界面

- **WHEN** 宿主 client 环境没有 slots 注册表
- **THEN** better-sidebar tab 仍然注册成功，仅对话动作行入口缺席

### Requirement: 孤儿提案的终止出口

实现 SHALL 提供工具入口 `workmate_proposal_abandon`（`id` 与非空 `reason`），
该入口 SHALL 以 `actor: 'agent'` 写入 `transition` 事件；面板与 REST 入口 SHALL 以 `actor: 'human'` 记账。
实现 SHALL NOT 把 agent 的终止动作记为 human。

#### Scenario: 归属不造假

- **WHEN** agent 通过工具终止一个提案
- **THEN** 事件的 `actor` 为 `agent`；同理由面板终止时为 `human`

