# task-intake Delta

## ADDED Requirements

### Requirement: 并发写入的分配完整性

同一进程内对待办文件的并发写 SHALL 串行执行：并发新建 SHALL 产出互不相同的
任务 id，并发回答 SHALL 产出连续且不重复的 seq，SHALL NOT 因读改写交错丢失
任何一次写入。id 分派 SHALL NOT 依赖"读到的行数 + 1"在无锁前提下的正确性。

#### Scenario: 同刻并发新建

- **WHEN** 面板与 agent 工具在同一事件循环 tick 内各新建一条待办
- **THEN** 两条记录都落盘且 id 互不相同，Source 为它们派发两张独立 Ticket

#### Scenario: 并发回答 seq 连续

- **WHEN** 对同一条待办并发提交两条回答
- **THEN** `inputs.jsonl` 的两条记录 seq 互不相同且各自单调递增，均被 Source 消费
