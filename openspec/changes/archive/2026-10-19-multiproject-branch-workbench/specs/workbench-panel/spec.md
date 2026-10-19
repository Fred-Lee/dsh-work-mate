## ADDED Requirements

### Requirement: 创建提案时的项目与分支选择

新建提案模态 SHALL 在项目多选之后，为每个已勾选项目渲染一个基线分支选择器：选项来自
该项目分支列举接口，默认选中项目 `defaultBranch`（未设置时选当前分支），并允许改选；
每个项目 SHALL 可指定一个 `workspace` 分组与默认分支（注册时或注册后编辑）。模态
SHALL 支持指定一个「主项目」决定 OpenSpec 主目录，默认取勾选的第一个项目；模态 SHALL
预览每个项目的提案分支 `proposal/<id>` 与实现分支 `feature/<id>`。

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

面板 SHALL 以「当前项目与分支」为常驻上下文：顶部上下文栏 SHALL 提供 Workspace / Project / 当前分支三个选择器、占用徽标、搜索与主操作；切换项目 SHALL 过滤主区内容。主区 SHALL 默认以列表呈现「我的变更」（进行中优先），看板 SHALL 作为可切换视图；已归档条目 SHALL 默认折叠在筛选之后，SHALL NOT 默认占据看板主版面。

选中一条变更 SHALL 直接打开详情抽屉或详情页，SHALL NOT 要求第二次点击「加载详情」；详情 SHALL 按目标矩阵展示项目/基线分支/特性分支/worktree/端口，并提供常驻动作条。创建提案 SHALL 在一次模态内完成「项目多选 → 每项目基线分支 → 主项目与 OpenSpec 归属确认」，错误 SHALL 就地显示在对应项目行。

面板控件 SHALL 复用宿主 `ui-primitives`（Button / Pill / SegmentedControl / Tag / StateDot / DisclosureRow / Modal / Tooltip / PathLabel 等），SHALL NOT 手写第二套同类控件；颜色、圆角、阴影 SHALL 使用 `--dsw-*` 语义令牌，SHALL NOT 硬编码主题色或写 `prefers-color-scheme` 分支。首屏 SHALL 有 skeleton；操作成功/失败 SHALL 有 Toast；列表行 SHALL 可键盘聚焦并以 `aria-current` 标记选中；详情抽屉 SHALL 处理焦点进入与 Escape 返回；动画 SHALL 尊重 reduced motion。

#### Scenario: 三秒回答当前上下文

- **WHEN** 用户打开面板
- **THEN** 不展开任何卡片即可看到当前项目、当前分支、进行中变更数量、待批准数量与 worktree 占用数

#### Scenario: 一次点击进入详情

- **WHEN** 用户点击列表中的一条变更
- **THEN** 详情抽屉直接打开并展示目标矩阵，无需再点「加载详情」

#### Scenario: 归档不占主版面

- **WHEN** 已归档提案多于进行中提案
- **THEN** 默认列表与看板只突出进行中项，归档项折叠在「已归档」筛选后或折叠区内

#### Scenario: 控件与主题一致

- **WHEN** 在浅色与深色主题下打开面板
- **THEN** 按钮、标签、模态、圆角与阴影均随宿主主题变化，不出现硬编码颜色；reduced motion 下无位移动画

#### Scenario: 键盘完成主流程

- **WHEN** 用户只用键盘
- **THEN** 可切换视图与筛选、打开详情、在创建模态中完成项目与分支选择并提交


### Requirement: 流水线视图与最小人工动作

面板 SHALL 以流水线呈现提案：`方案 → 待确认 → 执行中（开发/审查/测试）→ 待合并 → 已归档`，
并显示每个提案当前位置与进度；状态 SHALL 来自服务端证据派生结果，SHALL NOT 由前端本地
推断或要求用户逐态点击。

正常路径 SHALL 只提供两个主操作：「确认方案」（G2）与「合并并归档」（G5）。面板 SHALL NOT
把 `mode=advance` 的逐态推进作为卡片主按钮；手动推进/回退 SHALL 收进「更多」或详情操作，
并标注为覆盖操作。

详情 SHALL 展示证据：工件完整性、`planHash`、团队 Task 状态、审查与测试结论、各 target
的合并状态；方案改动导致 `planHash` 失效时 SHALL 在卡片上提示「需重新确认」。

#### Scenario: 提案完成后自动进入待确认

- **WHEN** 某提案的 OpenSpec 工件齐备并通过 validate
- **THEN** 卡片自动出现在「待确认」列，并显示「确认方案」按钮，无需人工推进

#### Scenario: 执行中不再逐态点击

- **WHEN** 方案已确认、团队 run 正在执行
- **THEN** 卡片显示执行中与开发/审查/测试进度，不出现「推进到 implementing/merging」按钮

#### Scenario: 方案改动提示重确认

- **WHEN** 已确认的提案修改了方案工件
- **THEN** 卡片回到「待确认」并提示「方案已变更，需重新确认」
