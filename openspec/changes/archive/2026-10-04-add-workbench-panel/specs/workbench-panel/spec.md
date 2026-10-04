## ADDED Requirements

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
