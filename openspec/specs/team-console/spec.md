# team-console Specification

## Purpose
TBD - created by archiving change autonomous-agent-team. Update Purpose after archive.
## Requirements
### Requirement: 团队看板

面板 SHALL 提供团队视图：按角色列出 Task 与状态（planned/dispatched/running/done/failed/
blocked）、当前 worker 会话、所属项目与分支、最后活动时间。视图 SHALL 能一眼区分
「进行中 / 待我回答 / 失败 / 已完成」，并 SHALL 提供进入对应提案详情与工件的能力。

#### Scenario: 一屏看到阻塞

- **WHEN** 某个 Task 处于 blocked 且有未回答 question
- **THEN** 团队看板高亮该 Task 与待答问题，不需要展开详情才能发现

### Requirement: DAG 视图

团队视图 SHALL 提供依赖 DAG：节点为 Task，边为 `depends_on`，并标出当前波次、关键路径与
阻塞节点。DAG SHALL 与 `TASKS.json` 同源，修改任务后 SHALL 同步更新。

#### Scenario: 波次可视化

- **WHEN** 前后端 Task 在第二波次并行、集成测试在第三波次
- **THEN** DAG 显示三层波次与依赖边，运行中的节点有状态标记

### Requirement: 收件箱

团队视图 SHALL 提供收件箱：列出 `question` / `escalation` / 失败重试耗尽等需要人处理的
消息，支持就地回答/拒绝并记录理由。回答后 SHALL 恢复对应 Task 或按策略终止。

#### Scenario: 就地回答

- **WHEN** 用户在收件箱回答一个 question
- **THEN** 消息标记已处理，相关 Task 从 blocked 恢复，事件流记录回答者与时间

### Requirement: 运行时间线与证据

团队视图 SHALL 提供运行时间线（dispatch/done/gate/decision 事件）与证据面板：六份团队
工件可按 Markdown 渲染，文件/commit 可跳转。时间线与证据 SHALL 从事件流与工件读取，
SHALL NOT 另存一份展示状态。

#### Scenario: 回放一次 Run

- **WHEN** 用户打开一个已结束 Run
- **THEN** 时间线按序展示派发、回执、门禁与失败，证据面板可打开 TEST/REVIEW/SUMMARY

### Requirement: 面板契约

团队视图 SHALL 复用工作台既有的上下文栏、项目树与详情容器，SHALL NOT 新建第二套导航；
SHALL 渲染在面板唯一的纵向滚动容器内，遵守 `fix-panel-scroll` 的高度契约；窄屏 SHALL
使用单列与返回式详情。

#### Scenario: 窄屏可用

- **WHEN** 面板宽度小于 900px
- **THEN** 团队视图单列展示，DAG 可横向滚动或折叠，详情以整页返回方式打开

