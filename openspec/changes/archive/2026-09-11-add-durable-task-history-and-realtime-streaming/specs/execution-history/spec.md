## ADDED Requirements

### Requirement: 持久化任务生命周期记录
系统 SHALL 将每个编排任务的生命周期记录——任务 id、参与的 agents、基础仓库与 worktree 引用、状态迁移、各 agent 的尝试次数、冲突文件集合与时间戳——持久化到 `HELMSMAN_HOME` 下的 Helmsman 状态目录,使记录在宿主重启后仍然存在。持久化 SHALL 是追加安全的:进程崩溃或写入一半时,绝不能破坏此前已写入的记录。

#### Scenario: 已完成的任务在重启后仍可读取
- **WHEN** 某舰队任务到达终态(已合并或已放弃)
- **THEN** 完整生命周期记录已持久化落盘;宿主重启后,任务列表与详情仍展示该终态及其时间戳与结果

#### Scenario: 被打断的任务不会无声丢失
- **WHEN** 宿主在某任务执行中途停止(终态记录尚未写入)
- **THEN** 重启后该任务以其最后已知状态呈现,并注明"未完成",而不是从列表消失

#### Scenario: 写入一半不会破坏历史
- **WHEN** 进程在追加某条事件时崩溃
- **THEN** 此前已持久化的记录仍可正常读取,被截断的尾部被忽略,不影响任务列表其余部分

### Requirement: 带 cursor 分页的持久化事件时间线
系统 SHALL 将每条执行事件(agent 启动、日志行、尝试/重试、失败、状态变更)以追加顺序写入该任务的持久化时间线,并为每条事件分配一个任务内单调递增的 cursor。查询 API SHALL 支持从任意 cursor 向后读取(`after`),只返回 cursor 更大的事件,使客户端可以向前翻页并在不重复的情况下重新同步。

#### Scenario: 长运行任务向前翻页
- **WHEN** 客户端用落后最新 N 条的 cursor 请求事件
- **THEN** 响应精确返回该 cursor 之后的事件,保持原始顺序,每条都带 cursor 值供下一次请求使用

#### Scenario: cursor 已是最新时无新事件
- **WHEN** 客户端请求的 cursor 等于最新事件的 cursor
- **THEN** 响应为空且不报错

### Requirement: 保留与清理(Retention and pruning)
系统 SHALL 依据可配置的保留策略保存任务记录与事件时间线(默认保留近期运行、清理更早的事件文件),且清理 MUST 只删除 Helmsman 自己的记录,绝不触碰基础仓库的成果。被清理的历史 MUST NOT 让持有旧 cursor 的客户端报错——旧 cursor 读取应返回明确的 `history-pruned` 信号。

#### Scenario: 清理只删除旧事件文件
- **WHEN** 保留策略作用于早于配置期限的运行
- **THEN** 仅 Helmsman 自己持有的事件/日志文件被删除,git worktree 与基础仓库产物不受影响

#### Scenario: 清理后的旧 cursor
- **WHEN** 客户端从早于保留期限的 cursor 续传
- **THEN** API 返回明确的 `history-pruned` 信号,而不是静默返回不完整数据

### Requirement: 测试默认使用内存后端
存储后端 SHALL 是注入式接口,编排核心在使用内存后端构建时(单测默认)MUST 保持正常工作,使引擎测试不触碰文件系统。

#### Scenario: 引擎测试不写状态目录
- **WHEN** 单测用内存存储适配器构建 orchestrator
- **THEN** 任务执行、重试与合并路径行为一致,且不会向 `HELMSMAN_HOME` 写入任何文件
