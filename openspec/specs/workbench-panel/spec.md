# workbench-panel Specification

## Purpose
TBD - created by archiving change add-workbench-panel. Update Purpose after archive.
## Requirements
### Requirement: 原生工作台面板注册

客户端半边 SHALL 在 `main` keyed 槽注册 `key: 'workmate'` 的面板，并在
`sidebar.panellist` 注册同 id 的图标条目，使中央面板可由左栏图标切换；两处注册 SHALL
各自惰性（依赖 `slots` 服务），SHALL NOT 因缺少第三方 `betterSidebar` 服务而失效，
且既有 better-sidebar tab 注册 SHALL 保留。

#### Scenario: 有 slots 无 better-sidebar 时仍是工作台面板

- **WHEN** 只提供 `slots` 服务的宿主加载客户端半边
- **THEN** `main`（key=workmate）与 `sidebar.panellist`（id=workmate）各注册一次，
  且不抛错

#### Scenario: 两条路并存

- **WHEN** `slots` 与 `betterSidebar` 同时存在
- **THEN** 除 dock tab 外，工作台面板与左栏图标也注册

### Requirement: 控制台视图

面板 SHALL 提供「控制台」视图，展示聚合 KPI（提案总数、返工率、首次通过率、
近 7/30 天归档数、周期时间中位数）、每提案行（状态、当前状态停留、返工次数、门禁失败
次数、未决卡点）与控制带评测（每指标 当前/基线/σ/偏离/档位）。控制带样本不足时
SHALL 原样显示 `insufficient-data`，SHALL NOT 呈现为正常。

#### Scenario: 控制带数据不足如实显示

- **WHEN** 某指标结论为 `insufficient-data`
- **THEN** 控制台在该行显示"数据不足"，不显示正常态

#### Scenario: 一次请求渲染提案行

- **WHEN** 控制台加载
- **THEN** 每提案行来自聚合度量的 `perProposal`，不逐提案请求

### Requirement: Wiki 面板

客户端 SHALL 提供一个 Wiki 面板，使用户无需命令行即可：把指定项目根的 wiki 导出到 vault，
并按关键词检索 vault；检索结果 SHALL 显示 `文件:行号` 与片段，并 SHALL 允许一键复制该位置。
面板 SHALL 复用插件既有的 `/workmate/api/wiki/*` 端点，SHALL NOT 引入第二套服务端逻辑；
面板 SHALL 在错误时显示服务端返回的状态与正文，不得静默失败。

#### Scenario: 导出

- **WHEN** 在面板填入项目根并点击「导出到 vault」
- **THEN** 显示模块/页/迭代数与归类统计（以及是否已提交）

#### Scenario: 检索

- **WHEN** 输入关键词并选择词法或语义后点击「检索」
- **THEN** 列出命中位置与片段；点击某条复制其 `文件:行号`

### Requirement: 面板长动作的可见反馈

面板发起 `推进` / `完成归档` 时 SHALL 在按钮上显示进行中文案并禁用重复点击；
成功时 SHALL 在提案卡片上显示结果（归档完成，且当编排报告 `forced` 时标注已跳过审查门）；
失败时 SHALL 把服务端返回的错误显示在卡片上，SHALL NOT 只提示在面板其他位置。

#### Scenario: 归档进行中

- **WHEN** 用户点击「完成归档」
- **THEN** 按钮变为「归档中…（编排在跑）」且不可重复点击

#### Scenario: 归档完成可见

- **WHEN** 编排返回成功
- **THEN** 卡片出现「✅ 归档完成」，`forced: true` 时附带「force：已跳过审查门」

#### Scenario: 失败可见

- **WHEN** 服务端返回错误
- **THEN** 卡片出现以 ❌ 开头的错误文案

### Requirement: 面板动作不随详情失败消失

提案卡片上的归档动作 SHALL 仅在提案状态为 `archiving` 时渲染，SHALL NOT 依赖详情接口成功；
详情加载失败时 SHALL 在卡片上显示失败原因并提供「重新加载」。

#### Scenario: 详情失败仍有出路

- **WHEN** 提案的项目根已不存在导致详情加载失败且状态为 archiving
- **THEN** 卡片仍显示「完成归档 / 强制归档」，并显示失败原因

