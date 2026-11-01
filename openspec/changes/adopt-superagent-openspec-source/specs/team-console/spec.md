# team-console Delta

## MODIFIED Requirements

### Requirement: 团队看板

面板 SHALL 提供团队视图：按角色列出 Task 与状态（planned/dispatched/running/done/failed/
blocked）、当前 worker 会话、所属项目与分支、最后活动时间。视图 SHALL 能一眼区分
「进行中 / 待我回答 / 失败 / 已完成」，并 SHALL 提供进入对应提案详情与工件的能力。

`taskExecutor = 'superagent'` 时，该视图 SHALL 只读：Task 的执行态 SHALL 来自 Ticket
投影，SHALL NOT 提供就地派发、回答或重试；视图 SHALL 显示"由 Super-agent 执行"的来源
标注，并把回答入口指向任务视图。`taskExecutor = 'team'`（回退）时，该视图 SHALL 标注
"回退执行器"，并保留原有的派发态。

#### Scenario: 一屏看到阻塞

- **WHEN** 某个 Ticket 处于 `person / answer`
- **THEN** 团队看板高亮该任务与待答问题，并链接到任务视图的回答入口，不在此处直接回答

#### Scenario: 只读不误导

- **WHEN** `taskExecutor` 为 `superagent`
- **THEN** 团队看板不提供派发或重试按钮；任务状态与 Ticket 一致

### Requirement: 收件箱

团队视图 SHALL 提供收件箱：列出 `question` / `escalation` / 失败重试耗尽等需要人处理的
消息，支持就地回答/拒绝并记录理由。回答后 SHALL 恢复对应 Task 或按策略终止。

`taskExecutor = 'superagent'` 时，收件箱 SHALL 只投影 Ticket 的 `attention` 与阻塞原因，
回答入口 SHALL 指向任务视图；SHALL NOT 在团队视图内直接改写 Ticket。
`taskExecutor = 'team'`（回退）时，就地回答 SHALL 保持原有语义。

#### Scenario: 就地回答（回退执行器）

- **WHEN** 回退执行器启用时用户在收件箱回答一个 question
- **THEN** 消息标记已处理，相关 Task 从 blocked 恢复，事件流记录回答者与时间

#### Scenario: 投影型收件箱

- **WHEN** `taskExecutor` 为 `superagent` 且某 Ticket 有未回答的问题
- **THEN** 收件箱列出该问题并提供"去任务视图回答"的入口，不在此处提交回答
