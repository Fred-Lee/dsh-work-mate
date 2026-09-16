## Why

看板第 ③ 列"开发实施"目前只能**读** run(`api/item/:id/runs`、`api/run/:taskId/events`)——看板上设计稿里写的
"卡片 [发起执行]"从未实现。用户拍板:把"观察窗"升级为"操作台的一角"(仅加"发起",不复制执行看板的
全套操作以免维护两份)。

## What Changes

- 看板第 ③ 列卡片在 `repoScope.projectGroup` 与至少一个**已安装**的 agent(本仓为 claude/codex)
  时,渲染「▶ 发起执行」按钮 + "agent 选择"下拉,默认「按场景自适应」。
  自适应规则(spec 里的"按场景"语义;非自动行为——发起前用户可改):
  - 任务含子任务/拆分要素 → claude(擅长计划/拆解)
  - 任务明确多个并行可独立完成的工作 → codex
  - 简单/单步任务 → 选择当前**最快**已装 agent
- 弹出"发起"对话框,预填:卡片标题(可改)+ 卡片已有的 `summary` 作 prompt 骨架(可改)、「级联注入拓扑」
  复选框默认勾上(为「复杂任务拆分用 claude、并行执行用 codex」提供必要上下文);超时秒数、agent 重新选择不出现(走"高级"折叠)。
- 提交调用既有 `runParallelTask` 工具,直接经宿主的 orchestra 启动;**不复制**执行看板的状态机、
  审批、生命周期管理。
- 起跑后:卡片"原地不动",卡片内的 run 面板(经 SSE)+ 卡片 `runs[]` 接入新 run;run 实时滚动
  复用 change A(持久化历史+游标续传);WIP 仅拦"进第 ③ 列",不拦"列内追加 run"(spec 已锁定)。
- 取消/重试/审批/合并等**仍在执行看板**完成——看板"发起"是入口,不做第二份操作面板。
- 服务发现:已安装 agent 列表取自 `OrchestratorService.checkAgents()` 已有返回值,无需新增服务端点。

## Capabilities

### New Capabilities
- `card-start-run`:看板第 ③ 列卡片的"发起执行"能力——agent 智能选择、级联开关、按任务类型预填摘要、提交后 run 自动挂回卡片,操作其余职责仍在执行看板。

### Modified Capabilities
<!-- 无:既有 runParallelTask/exec-time/cancel/approval 行为不变;WIP 不变(只拦"进列",不拦"列内追加")。 -->

## Impact

- `packages/ui-board`:第 ③ 列卡片增「发起执行」入口(按钮 + 对话框);agent 选择下拉与默认
  推荐(按场景规则);接既有 `runParallelTask` 工具;按 `repoScope.projectGroup` 解析
  项目群拓扑;按 `agentId` 校验已装;单测
- `packages/orchestrator`:无需新代码(工具已存在);仅在配置上确认 `repoGroupId` 可解析
- 文档:`docs/USAGE.md`(看板列起发的流程与边界)、`docs/ARCHITECTURE.md`(看板是发起入口、
  执行看板承担其余操作)
