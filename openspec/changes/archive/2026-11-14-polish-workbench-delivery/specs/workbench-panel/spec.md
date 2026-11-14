# workbench-panel 变更（delta）

## MODIFIED Requirements

### Requirement: 控制台视图

面板 SHALL 提供「控制台」视图，展示聚合 KPI（活跃提案、返工率、首次通过率、
近 7/30 天归档数、周期时间中位数）、每提案行（状态、当前状态停留、返工次数、
门禁失败次数、未决卡点）与控制带评测（每指标 当前/基线/σ/偏离/档位）。
「活跃提案」SHALL 指未终止提案，与顶栏「N 条提案（含已归档）」的全量口径
SHALL 用标签明确区分，SHALL NOT 同名不同义。控制带样本不足时 SHALL 原样显示
`insufficient-data` 并 SHALL 渲染评测给出的不足说明（门槛与实际样本数），
SHALL NOT 呈现为正常。

#### Scenario: 控制带数据不足如实显示

- **WHEN** 某指标结论为 `insufficient-data`
- **THEN** 控制台在该行显示"数据不足"，并显示基线样本门槛与实际差距，不显示正常态

#### Scenario: 一次请求渲染提案行

- **WHEN** 控制台加载
- **THEN** 每提案行来自聚合度量的 `perProposal`，不逐提案请求

#### Scenario: 两个计数不再同名

- **WHEN** 存在已归档提案
- **THEN** 顶栏显示「N 条提案（含已归档）」，控制台 KPI 显示「活跃提案」，两者可各自追溯口径

### Requirement: 创建提案时的项目与分支选择

新建提案模态 SHALL 在项目多选之后，为每个已勾选项目渲染一个基线分支选择器：选项来自
该项目分支列举接口，默认选中项目 `defaultBranch`（未设置时选当前分支），并允许改选；
每个项目 SHALL 可指定一个 `workspace` 分组与默认分支（注册时或注册后编辑）。模态
SHALL 支持指定一个「主项目」决定 OpenSpec 主目录，默认取勾选的第一个项目；模态 SHALL
预览每个项目的提案分支 `proposal/<id>` 与实现分支 `feature/<id>`。

模态 SHALL 具备对话框语义（`role="dialog"` + `aria-modal` + 可读名称），表单控件
SHALL 与其标签关联。「注册新项目」SHALL 与关联项目多选在视觉上分区，SHALL NOT
把注册输入混排在多选列表内。标题必填的校验 SHALL 在「下一步」时前置执行并就地
提示，SHALL NOT 让用户走完三步后提交静默无响应。

项目未注册、根不可解析或分支列举失败时，模态 SHALL 就地显示原因并允许跳过该项目，
SHALL NOT 静默提交一个缺少分支的目标。提交失败 SHALL 在模态内显示逐项目错误。

#### Scenario: 为两个项目各选分支

- **WHEN** 勾选 internal-homework 与 homework-server，前者默认 main、后者改选 test
- **THEN** 提交后提案两个 target 的 baseBranch 分别为 main 与 test，主项目为 internal-homework

#### Scenario: 分支列举失败可见

- **WHEN** 某项目根不存在导致分支列举失败
- **THEN** 该项目行显示错误，提交被阻止或该项目被显式跳过，不产生半截 target

#### Scenario: 旧流程不破坏

- **WHEN** 用户只选一个项目且不展开分支选择器
- **THEN** 按该项目默认分支创建单目标提案，行为与升级前一致

#### Scenario: 标题缺失停在第一步

- **WHEN** 标题为空时点击「下一步」
- **THEN** 模态就地提示「先填标题」并停留在第 1 步，不进入分支选择

## ADDED Requirements

### Requirement: 提案抽屉交付证据

列表详情抽屉 SHALL 提供「做了什么」段：展示变更动机（openspec `proposal.md` 的
`## Why` 段，经宿主解析为 `why`，随状态载荷可选下发）、每关联项目的标记提交
（短哈希 + 标题）、HEAD 与未提交变更数；提案已归档且带交付清单时 SHALL 展示
每项目 diffStat。证据缺失时 SHALL 如实写「还没有标记提交」一类空态文案，
SHALL NOT 留白或静默省略整段。

#### Scenario: 活跃提案看提交

- **WHEN** 打开一个 implementing 提案的抽屉
- **THEN** 「做了什么」显示该项目标记提交列表（或「还没有标记提交」）与 HEAD 状态

#### Scenario: 归档提案看 diffStat

- **WHEN** 打开一个带交付清单的已归档提案的抽屉
- **THEN** 「做了什么」包含每项目 diffStat 与提交

### Requirement: 隐藏计数口径

看板与列表在「显示已归档」关闭时 SHALL 统计并展示两类被隐藏对象：已归档提案与
已终止提案，文案 SHALL 分开计数（如「已隐藏 N 条（M 条已归档 + K 条已终止）」），
并保留一键全部显示的出口。SHALL NOT 把已终止提案静默剔除而不出现在任何提示里。

#### Scenario: 终止计数可见

- **WHEN** 存在 10 条已归档与 8 条已终止且「显示已归档」关闭
- **THEN** 提示「已隐藏 18 条（10 条已归档 + 8 条已终止）」，点「显示」后全部可见

### Requirement: 提案列表加载失败错误态

提案列表请求失败时，面板 SHALL 在错误横幅带「提案列表加载失败：」前缀与
「重试」按钮，顶栏计数 SHALL 显示「—」而非 0，SHALL NOT 让失败态看起来像
空数据。

#### Scenario: 接口 500

- **WHEN** `/api/proposals` 返回 500
- **THEN** 横幅显示失败原因且可重试，顶栏计数为「—」，重试成功后恢复计数与列表

### Requirement: 列表空态给出口

列表视图为空时 SHALL 区分两种情况：无任何提案时提示创建入口；有提案但被搜索、
状态、项目或归档开关筛掉时，SHALL 提示「没有匹配的提案」并提供「清空筛选」按钮，
SHALL NOT 用同一句文案掩盖筛选原因。

#### Scenario: 筛选到 0 条

- **WHEN** 搜索词与状态筛选叠加后列表为 0 条且提案总数大于 0
- **THEN** 空态显示「没有匹配的提案」与「清空筛选」按钮，点击后恢复完整列表

### Requirement: 事件流可读化

抽屉事件行 SHALL 包含时间（`MM-DD HH:mm`）与 kind 的中文标签；`task-settled` 与
历史 `team-*` 行 SHALL 保持可读，reason/detail 原样保留。

#### Scenario: 事件带时间

- **WHEN** 抽屉加载事件
- **THEN** 每行以时间开头、kind 为中文标签，可直接读出何时发生了什么

### Requirement: 面板可达性

- 任务卡片 SHALL 可键盘聚焦（`tabIndex=0`），焦点内操作按钮可 Enter 触发；
- 「显示已归档」等切换 pill SHALL 输出 `aria-pressed`；
- 输入类控件边框 SHALL 使用强边框变量，浅色主题下与背景对比可辨。

#### Scenario: 键盘走一遍列表卡片

- **WHEN** 用 Tab 聚焦任务卡片
- **THEN** 卡片获得焦点环，Enter 可展开详情按钮
