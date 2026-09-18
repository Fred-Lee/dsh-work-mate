## Why

Helmsman 里"一次任务"今天只是 orchestrator 的一次 fleet 执行(一个 `taskId` = 一次 run:多 agent 并行 + diff + merge),它既不是跨阶段的"工作项",也从不关联周边产物。一次对话可能产出一个想法,随后有 PRD/spec 文档、worktree/分支、多轮 claude/codex/DSH 对话记录、被改动的服务列表、可交付 artifact——这些目前散落在 drafts、Tolaria vault、worktree 注册表、run 日志、topology 各处,彼此没有绑定。本次变更引入**任务工作项(WorkItem)聚合根**:一个跨阶段卡片,把上述关联全部收拢成可引用的关系集,作为后续看板(change `add-task-kanban-board`)与所有按任务视图的地基。纯数据/服务层,不含看板 UI。

## What Changes

- 新增 `WorkItem` 模型(两级结构,不改变现有 `taskId` 语义):WorkItem(跨阶段聚合根)⇄ `runs[]`(引用 orchestrator 的 TaskRecord,一次卡片可挂多次执行)。
- 卡片固定四个阶段:① `需求分析` ② `规格设计` ③ `开发实施` ④ `验收归档`;阶段迁移产生版本化生命周期事件(供 change C 审计留痕、change A 持久化)。
- 关联集(全部存**引用**而非副本):`docs[]`(draft/Tolaria note 路径或 id)、`conversations[]`(type: `dsh|claude|codex`,含会话 id/transcript 路径与**自动生成的摘要**)、`worktrees[]`/分支命名空间、`runs[]`、`affectedServices[]`(diff 文件 × topology 模块半自动映射,人工确认)、`artifacts[]`(change D 产物 id)。
- 对话摘要:建档或关联对话时,基于该对话最近消息自动生成 2–4 行摘要存到卡片(`summary`,可编辑),用于快速浏览;来源标注、可重新生成。
- 阶段 DoR/DoD:卡片携带按阶段的"就绪/完成"清单数据(是否已定稿 PRD、是否有 spec、是否至少一个 run 已 merge、是否已归档),由推进方提交,服务侧校验后放行并写入事件。
- 新 Service 插件 `@helmsman/board`(纯 Service,无 webServer):`items` CRUD + 阶段推进 + 关联增删 + 事件流 + REST 由宿主暴露;状态存 `~/.helmsman/board/items.json`(原子写)。
- **BREAKING**:无。新增能力,现有 orchestrator/worktree/topology 接口不变,仅新增可选引用关系。

## Capabilities

### New Capabilities
- `task-workitem`:任务工作项聚合根——生命周期、四阶段与迁移事件、关联集(文档/对话/会话摘要/worktree/runs/服务/产物)、DoR/DoD 校验与存储。

### Modified Capabilities
<!-- 暂无。 -->

## Impact

- 新增 `packages/board` 插件(`~/.helmsman/board/items.json`,原子写 + 生命周期事件)。
- `packages/orchestrator`:只读消费已有 TaskRecord/事件(change A 落盘后可按 run 回放),不修改其状态机。
- `packages/memory-topology`:提供"diff 文件 → 服务/模块"映射的只读助手(半自动候选),不新开扫描器。
- `packages/knowledge-tolaria` / ui-workbench drafts:提供按 id/路径解析 note/draft 的门面(只读,用于 docs 关联展示)。
- `packages/artifacts`(change D):卡片产物引用复用其 `resolve`。
- 文档:新增 `docs/TASK-MODEL.md`(概念+关联 schema+四阶段 DoR/DoD),更新 `docs/USAGE.md`、`docs/ARCHITECTURE.md`。
- 无多用户/账号/权限;沿用单用户 loopback + `HELMSMAN_HOME`。
