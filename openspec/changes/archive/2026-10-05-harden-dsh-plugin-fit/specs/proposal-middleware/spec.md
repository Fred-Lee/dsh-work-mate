## MODIFIED Requirements

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

## ADDED Requirements

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
