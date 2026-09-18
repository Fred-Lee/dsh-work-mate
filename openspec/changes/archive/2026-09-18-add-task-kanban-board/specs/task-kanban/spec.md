## ADDED Requirements

### Requirement: 独立看板页面与四列布局
系统 SHALL 提供一个独立页面(SPA,挂 `/helmsman-board`,与既有 ui-dashboard/ui-workbench 同模式),将 WorkItem 按四个阶段渲染为四列:`需求分析`、`规格设计`、`开发实施`、`验收归档`。每张卡片 SHALL 显示:标题、对话摘要(2–4 行内截断)、关键角标(文档数/对话数/关联服务数)、run 状态点(在跑/排队/已合并/完成);每列头 SHALL 显示该列卡片数与第 ③ 列的 WIP 占用(`在跑/上限`)。

#### Scenario: 卡片按阶段落列
- **WHEN** 用户打开 `/helmsman-board`
- **THEN** 四列自上而下展示,每张卡片出现在其当前阶段列,列头数字与卡片一致

#### Scenario: 摘要与角标一目了然
- **WHEN** 卡片存在关联文档、对话与在跑 run
- **THEN** 卡片直接展示摘要文本与文档/对话/服务计数、绿色"在跑"状态点,无需展开即可浏览

### Requirement: 筛选
看板 SHALL 支持按仓库(projectGroup/baseRepo)、阶段、以及"仅看含/不含对话摘要"等维度筛选;筛选状态 SHALL 保留在 URL query 中以便分享/刷新不变。

#### Scenario: 按仓库聚焦
- **WHEN** 用户在筛选器选择某仓库
- **THEN** 看板只显示该仓库的卡片,列计数随之更新

### Requirement: 开发列冲突域 WIP 呈现与排队
看板 SHALL 依据 board 的冲突域策略(change `task-workitem` 的 WIP 能力)呈现第 ③ 列:卡片进入开发列时 SHALL 展示其冲突域标签(`仓库:模块` 或 `仓库:*`),列内 SHALL 按冲突域分组并显示各域在跑/上限;被拒绝进入的卡片 SHALL 显示排队原因(含冲突域键),同一仓库内不同模块的卡片 SHALL 可同时并行进入开发列。

#### Scenario: 同仓库不同模块并行呈现
- **WHEN** repo `R` 的两张卡片分别声明 `module=a` 与 `module=b` 并均在开发列
- **THEN** 看板显示两个不同冲突域标签,两者都在跑,不被彼此计数

#### Scenario: 同冲突域超限显示排队
- **WHEN** repo `R` 模块 `a` 已达上限,第 2 张声明 `a` 的卡片尝试进入开发列被 board 拒绝
- **THEN** 该卡片在看板上显示排队态与原因"冲突域 R:a 已达上限",卡片停留在原列

### Requirement: 卡片详情与关联跳转
点击卡片 SHALL 打开右侧详情抽屉:展示阶段、DoR/DoD 推进门、各关联分区(文档/对话/服务/worktree/runs/产物)。点击关联对象 SHALL 打开对应工具(文档→draft/Tolaria、run→run 面板/既有 diff 视图、产物→下载端点),且均为只读消费、不在本页复制内容。

#### Scenario: 从卡片跳到 diff
- **WHEN** 用户点击卡片内某 run 的冲突文件
- **THEN** 在既有 diff/merge 界面(ui-diff 或 /helmsman-diff)打开该冲突,卡片详情保持未改动

### Requirement: 推进门交互
详情抽屉底部 SHALL 显示当前阶段的前进门清单(如进入 `开发实施` 需"spec 已定稿";进入 `验收归档` 需"≥1 run 已 merge + 审计在案"),未满足项 SHALL 置灰并给出跳转补全入口;全部满足后按钮可用,提交后 SHALL 调用 board 的推进接口并实时刷新列;服务端拒绝(如 WIP)时 SHALL 显示缺口/原因提示。

#### Scenario: 拖拽触发门校验
- **WHEN** 用户把卡片从 `开发实施` 拖到 `验收归档` 而其 run 均未 merge
- **THEN** 卡片不被移动,弹出缺口列表("需 ≥1 run 已 merge"),用户可点击缺口跳转执行 merge 后重试

### Requirement: 建档入口(对话 → 卡片)
系统 SHALL 在聊天消息工具栏提供"保存为任务":弹窗含标题、自动带出的来源对话、仓库/项目组(解析自会话上下文)、初始阶段(默认 `需求分析`)与可选"用 PRD/研究预设先生成文档"开关;确认后 SHALL 通过 board 创建 WorkItem 并自动生成对话摘要。创建成功 SHALL 提供"打开卡片"动作。

#### Scenario: 从会话一键建档
- **WHEN** 用户在对话消息上点"保存为任务"并填写标题确认
- **THEN** 生成一张处于 `需求分析` 的卡片,自动关联该 DSH 会话并带摘要;弹窗出现"打开卡片"

### Requirement: run 实时面板与状态消费
卡片内每个 run 的展开区 SHALL 通过事件流(change A SSE,带 cursor 续传)实时显示时间线:agent 启动、日志行、重试/退避、审批挂起(含"待审批令牌"提示,消费 change C)、冲突标注(可跳 diff)。run 到达终态后 SHALL 停流显示结果;已 merge 的 run SHALL 允许一键把"影响服务"候选升格为卡片关联。

#### Scenario: 开发列实时跟跑
- **WHEN** 卡片处于 `开发实施` 且有 run 在跑
- **THEN** 页面经 SSE 实时刷新该 run 的时间线,断线后自动重连并续传,无需手动刷新

#### Scenario: 合并后确认影响服务
- **WHEN** 某 run 已 merge,系统按 diff × topology 给出影响服务候选
- **THEN** 用户在卡片内勾选确认后,候选写入卡片 `affectedServices[]` 并更新角标

### Requirement: 冲突裁决与合并由用户决定
系统 SHALL NOT 自动裁决**真实冲突**。当补丁无法干净应用(即 git 冲突)时,系统 SHALL 如实将该文件标注为冲突并把用户引导到 diff 对比界面(unified/split/side-by-side),由用户逐文件选择采纳方案(某 agent 方案 / 手动编辑并保留待决定),且 SHALL NOT 在用户裁决前写入该文件。可干净应用的未冲突变更(含多 agent 对同一文件的不重叠改动)SHALL 允许默认合并。冲突标注 SHALL 以"实际应用失败"为准,而非"某文件被多个 agent 改过"的文件级启发式。任何"择优/最佳"表述 SHALL 指"由用户比较后选定",绝不指系统替用户裁决。

#### Scenario: 真实冲突文件交给用户裁决
- **WHEN** 两个 agent 的改动在同一文件同区域重叠,补丁无法干净应用
- **THEN** 该文件如实显示冲突标记,用户可对比 diff 后选择某个 agent 方案或"手动编辑(暂保留全部,合并时再决定)",系统不做自动选取

#### Scenario: 未裁决的冲突不写入
- **WHEN** 存在未完成裁决的真实冲突文件时用户点击"合并所选"
- **THEN** 该文件不被自动并入,系统提示先裁决(或跳过该文件),基础仓库不被部分自动写入

#### Scenario: 不重叠的多 agent 改动默认合并
- **WHEN** 两个 agent 修改同一文件但 hunk 不重叠、`git apply` 可干净应用
- **THEN** 该文件按默认合并纳入,不要求用户逐文件裁决;仅当实际应用失败的文件才进入冲突提示流程

### Requirement: 阶段迁移留痕
通过看板发起的每个阶段迁移 SHALL 调用 board 的迁移接口并产生生命周期事件(供 change C 审计呈现);看板不得绕过接口直接改写阶段。

#### Scenario: 迁移可见于审计
- **WHEN** 用户在看板上把卡片推进到 `验收归档`
- **THEN** board 记录该迁移事件,审计视图可查询到 from/to/时间/触发者
