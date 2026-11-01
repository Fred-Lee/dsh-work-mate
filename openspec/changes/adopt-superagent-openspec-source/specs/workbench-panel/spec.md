# workbench-panel Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
