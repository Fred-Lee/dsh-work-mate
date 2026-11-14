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

### Requirement: 面板根节点高度契约与滚动

WorkMate 面板注册在宿主的 `main`（中央面板）槽，因此其根节点 SHALL 填满该列的确定高度
（`height: 100%`），SHALL 采用纵向 flex 布局，并 SHALL 提供一个**唯一**的纵向滚动容器
（`min-height: 0` + `overflow-y: auto`）；面板头部（导航与「＋ 新提案」）SHALL 位于滚动容器
之外以保持常驻可见；`GraphView` / `ConsoleView` / 看板三视图 SHALL 全部渲染在该滚动容器内。

面板根 SHALL NOT 依赖宿主提供滚动容器：宿主中央列是 `overflow: hidden`，面板自身不滚时
超长内容会被祖先静默裁剪。该契约 SHALL NOT 破坏独立页（`/workmate/`）：其模板不含 CSS，
`height: 100%` 在无高度祖先下退化为 `auto`，页面 SHALL 仍由文档流滚动。

#### Scenario: 超长卡片可滚动到底

- **WHEN** 某提案卡片的展开详情（卡点 / 决策日志）使内容高度超过面板可用高度
- **THEN** 面板内容区出现纵向滚动条，可滚动到卡片底部的边框与操作按钮，内容不被裁剪

#### Scenario: 页头保持可见

- **WHEN** 内容区已滚动到最底部
- **THEN** 头部（视图切换「看板 / 控制台 / 知识图谱」与「＋ 新提案」）仍在原位置可见

#### Scenario: 三视图共用同一滚动容器

- **WHEN** 依次切换到看板、控制台、知识图谱视图
- **THEN** 每个视图都渲染在同一滚动容器内，且各自可纵向滚动

#### Scenario: 独立页不被破坏

- **WHEN** 直接访问独立页 `/workmate/`（无高度祖先）
- **THEN** 面板根取内容高度、不塌陷，滚动仍由文档流承担，且不出现被裁剪的内容

#### Scenario: 弹窗路径不引入滚动层

- **WHEN** 面板打开新建提案弹窗（`.wm-modal`）或聊天入口的固定弹窗（`.wm-modal-fixed`）
- **THEN** 这两个路径不渲染面板内容滚动层，弹窗行为与修复前一致

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

### Requirement: 工作台占用视图

面板 SHALL 提供一个工作台视图，按项目列出：当前分支、脏文件数、活跃 OpenSpec change、
活跃提案及其 target 的基线/特性分支、worktree 路径与端口、基线漂移 warn。视图 SHALL
同时提供占用矩阵（项目 × 提案 × 分支），并允许对单个 target 执行「释放 worktree」
（未合并时二次确认）与「复制路径」。

提案详情 SHALL 逐 target 展示基线分支、特性分支、worktree 路径、端口与合并状态；
根不可解析的 target SHALL 显示 unresolved 与原因，其余 target 不受影响。

该视图 SHALL 渲染在面板既有的唯一纵向滚动容器内，不得破坏 `fix-panel-scroll` 确立的
「根 `height:100%` + 唯一滚动子层」契约；独立页 `/workmate/` 的文档流滚动 SHALL 保持。

#### Scenario: 并行提案可辨

- **WHEN** 同一项目上存在两个进行中的提案
- **THEN** 工作台该项目行显示两条占用（提案 id、分支、worktree、端口），一眼可区分

#### Scenario: 释放一个 target

- **WHEN** 用户对某个 target 点击「释放 worktree」并确认
- **THEN** 该 worktree 被移除、端口释放，其余 target 与提案状态不变

#### Scenario: 滚动契约不回退

- **WHEN** 工作台视图内容超过面板可用高度
- **THEN** 内容区出现纵向滚动条并可滚到底，面板头部保持常驻

### Requirement: 工作台信息架构与共享控件

面板 SHALL 以「当前项目与分支」为常驻上下文：顶部上下文栏 SHALL 提供 Workspace / Project / 当前分支三个选择器、占用徽标、搜索与主操作；切换项目 SHALL 过滤主区内容。主区 SHALL 默认呈现「任务」视图（`task-intake`）；「提案」列表 SHALL 作为并列页签保留，并在切换后维持既有的进行中优先、已归档折叠行为。

选中一条任务 SHALL 直接打开任务抽屉；选中一条提案 SHALL 直接打开提案详情抽屉或详情页，SHALL NOT 要求第二次点击「加载详情」；详情 SHALL 按目标矩阵展示项目/基线分支/特性分支/worktree/端口，并提供常驻动作条。创建提案 SHALL 在一次模态内完成「项目多选 → 每项目基线分支 → 主项目与 OpenSpec 归属确认」，错误 SHALL 就地显示在对应项目行。创建待办 SHALL 使用 `task-intake` 的结构化表单。

面板控件 SHALL 复用宿主 `ui-primitives`（Button / Pill / SegmentedControl / Tag / StateDot / DisclosureRow / Modal / Tooltip / PathLabel 等），SHALL NOT 手写第二套同类控件；颜色、圆角、阴影 SHALL 使用 `--dsw-*` 语义令牌，SHALL NOT 硬编码主题色或写 `prefers-color-scheme` 分支。首屏 SHALL 有 skeleton；操作成功/失败 SHALL 有 Toast；列表行 SHALL 可键盘聚焦并以 `aria-current` 标记选中；详情抽屉 SHALL 处理焦点进入与 Escape 返回；动画 SHALL 尊重 reduced motion。

#### Scenario: 三秒回答当前上下文

- **WHEN** 用户打开面板
- **THEN** 不展开任何卡片即可看到当前项目、当前分支、待办数、待批准数与 worktree 占用数

#### Scenario: 一次点击进入详情

- **WHEN** 用户点击列表中的一条任务或提案
- **THEN** 对应详情抽屉直接打开，无需再点「加载详情」

#### Scenario: 归档不占主版面

- **WHEN** 已归档提案多于进行中提案且用户切到「提案」页签
- **THEN** 默认列表与看板只突出进行中项，归档项折叠在「已归档」筛选后或折叠区内

#### Scenario: 控件与主题一致

- **WHEN** 在浅色与深色主题下打开面板
- **THEN** 按钮、标签、模态、圆角与阴影均随宿主主题变化，不出现硬编码颜色；reduced motion 下无位移动画

#### Scenario: 键盘完成主流程

- **WHEN** 用户只用键盘
- **THEN** 可切换视图与筛选、打开任务或提案详情、在创建模态中完成填写并提交

### Requirement: 流水线视图与最小人工动作

面板 SHALL 以流水线呈现提案：`方案 → 待确认 → 执行中（待回答/待验收）→ 待合并 → 已归档`，
并显示每个提案当前位置与进度；状态 SHALL 来自服务端证据派生结果，SHALL NOT 由前端本地
推断或要求用户逐态点击。

正常路径 SHALL 只提供两个主操作：「确认方案」（G2）与「合并并归档」（G5）。面板 SHALL NOT
把 `mode=advance` 的逐态推进作为卡片主按钮；手动推进/回退 SHALL 收进「更多」或详情操作，
并标注为覆盖操作。

详情 SHALL 展示证据：工件完整性、`planHash`、Ticket 阶段与目录、审查与测试结论、各 target
的合并状态；方案改动导致 `planHash` 失效时 SHALL 在卡片上提示「需重新确认」。

#### Scenario: 提案完成后自动进入待确认

- **WHEN** 某提案的 OpenSpec 工件齐备并通过 validate
- **THEN** 卡片自动出现在「待确认」列，并显示「确认方案」按钮，无需人工推进

#### Scenario: 执行中不再逐态点击

- **WHEN** 方案已确认、Ticket 正在执行
- **THEN** 卡片显示执行中与待回答/待验收，不出现「推进到 implementing/merging」按钮

#### Scenario: 方案改动提示重确认

- **WHEN** 已确认的提案修改了方案工件
- **THEN** 卡片回到「待确认」并提示「方案已变更，需重新确认」

### Requirement: 主视图为任务

面板 SHALL 以「任务」为主视图，视图切集至少包含「任务」与「提案」；「知识图谱」与
「工作台占用」SHALL 保留为并列视图。进入面板时 SHALL 默认落在任务视图。

提案视图 SHALL 保留既有看板、流水线与详情行为，但从主视图降为并列页签，
SHALL NOT 抢占任务视图的首屏位置。

#### Scenario: 打开面板即见任务

- **WHEN** 用户打开面板
- **THEN** 首屏为任务视图，页签中可见「提案」入口

#### Scenario: 提案视图不被删除

- **WHEN** 用户切换到「提案」
- **THEN** 既有看板/流水线/详情抽屉行为保持不变

### Requirement: 看板列与状态标签的对照可查

面板的看板 SHALL 把八态映射到固定五列（方案 / 待确认 / 执行中 / 待合并 / 已归档），
该映射 SHALL 在随包的文档（README）中有对照表，SHALL NOT 要求读者查源码才能建立映射。
每个列头 SHALL 通过 `title` 说明它覆盖哪些状态。

`reviewing` SHALL 落在「待确认」列（G2 等待人确认方案），`merging` 与 `archiving`
SHALL 落在「待合并」列（G5 等待人放行），`ready` 与 `implementing` SHALL 落在「执行中」。

#### Scenario: 等待人确认的提案一眼可见

- **WHEN** 一个提案处于 `reviewing`
- **THEN** 它出现在「待确认」列而非「方案」列

#### Scenario: 列与状态的对应可查

- **WHEN** 读者想知道「方案」列包含哪些状态
- **THEN** README 的对照表能查到，且面板列头的 title 也写明

### Requirement: 门禁理由的收集范围

面板 SHALL 仅在进入受 G5 门禁的状态（`merging` / `archiving`）时收集批准理由并写入
审批记录；G2 的方案确认（`reviewing → ready`）SHALL NOT 要求输入理由——`planHash`
即为确认凭据。文档 SHALL 按此区分表述，SHALL NOT 把两者混为一句。

#### Scenario: G2 确认不需要理由

- **WHEN** 人在面板点「确认方案」
- **THEN** 无需输入任何文本即完成确认，审批记录带 planHash 而不带 rationale

#### Scenario: G5 放行要求理由

- **WHEN** 人在面板点「推进到 待合并」
- **THEN** 面板提示输入批准理由，并写入审批记录与事件流

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
