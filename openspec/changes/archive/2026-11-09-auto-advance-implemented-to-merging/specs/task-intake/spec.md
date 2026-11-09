# task-intake Delta

## ADDED Requirements

### Requirement: 面板读路径只读

面板的任务视图与遗留目录查询 SHALL 只读：这些端点的执行 SHALL NOT 修改提案状态、
SHALL NOT 触发提案状态迁移、SHALL NOT 获取提案写锁。

当某提案的全部待办在任务视图显示为完成时，该提案 SHALL 由独立的低频调度器推进到
「待合并」（判据见 `lifecycle-state-machine` 的「实现完成后的自动推进」），
SHALL NOT 依赖面板轮询来触发。

#### Scenario: 轮询不引发状态变化

- **WHEN** 面板以 5 秒间隔连续请求任务视图与遗留目录 3 分钟
- **THEN** 提案状态保持不变（除非调度器独立推进），请求始终在正常时间内返回

#### Scenario: 完成后自动前进

- **WHEN** 某个提案的全部待办均已显示「已完成」
- **THEN** 在一个扫描周期内该提案出现在看板「待合并」列
