## Why

Helmsman 需要一个"以任务为中心"的可视化入口:进入开发实施阶段后,多张卡片、多次 fleet 执行、冲突与合并同时发生,散落的文档/对话/产物没有单一视图。change `add-task-workitem-model` 提供了 WorkItem 聚合根与四阶段/DoR-DoD 数据;本变更在此基础上加一个**独立页面**的任务看板 `/helmsman-board`,四列对应该模型,承载 WIP 限制、实时 run 状态(change A SSE)、阶段门与关联跳转。独立页面而非侧边栏 Tab,因为看板需要横向四列与卡片详情并存,侧边栏宽度不足。

## What Changes

- 新增 Web UI 插件(host+client,模式同 ui-dashboard/ui-workbench):挂 `/helmsman-board` 独立页(SPA),并可从 DSH 聊天页/工作台跳入。
- 看板主视图:四列 `需求分析/规格设计/开发实施/验收归档`,按 repo/阶段/无对话等筛选;卡片显示聚合摘要(标题+对话摘要、文档/对话/服务角标、run 状态点)。
- **WIP 限制(默认按 repo)**:第 ③ 列同仓库并发卡片上限可配置(默认 2);超限卡片进入"排队"态置灰。
- 卡片详情抽屉(右滑):关联分区(文档/对话/服务/worktree/runs/产物)展开跳转;**推进门**交互(DoR/DoD 清单勾选→通过则推进并留痕,不通过弹缺口提示)。
- 卡片内 run 面板:SSE 实时 timeline(change A),冲突行跳 diff/merge,审批挂起显示令牌提示(change C),合并后触发"确认影响服务"候选升格。
- 建档入口:聊天消息工具栏"保存为任务"→ 弹窗(标题/来源对话/仓库/项目组/初始阶段,可选跑 PRD preset),自动生成对话摘要存入卡片。
- 列/卡拖拽映射为阶段迁移(受门校验);移动/推进事件写入 WorkItem 生命周期(供审计)。
- 无多用户/账号;保持 loopback 同源;UI 只读调用 + 经既有门控(change C)执行破坏性动作。

## Capabilities

### New Capabilities
- `task-kanban`:独立任务看板页面——四列视图、卡片摘要与角标、repo 级 WIP 限制与排队、卡片详情关联区、推进门交互、建档对话与 run 实时面板。

### Modified Capabilities
<!-- 依赖 task-workitem 能力,但不改其 spec 行为(UI 只消费);此变更新建 UI 层 spec。 -->

## Impact

- 新增 `packages/ui-board`(webServer host + React SPA,可嵌入组件导出,模式同 ui-dashboard);挂 `/helmsman-board`。
- `packages/ui-workbench`:聊天消息工具栏加"保存为任务"入口与建档弹窗;注入 `@helmsman/board` 服务(懒获取)。
- `packages/board`(change `add-task-workitem-model`):提供 `items/list/advance/updateAssociations` 等只读+受控写接口。
- 消费方:change A(run 时间线/SSE)、change C(审批/审计)、change D(产物下载)——各自接口只读/复用,不修改。
- 文档:更新 `docs/USAGE.md`、`docs/ARCHITECTURE.md`、`README.md`(页面入口与插件计数,若并入 bundle 则 13→14)。
- 无账号/权限;不新引入基础设施。
