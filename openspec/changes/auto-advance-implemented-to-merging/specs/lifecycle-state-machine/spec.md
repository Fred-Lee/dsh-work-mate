# lifecycle-state-machine Delta

## ADDED Requirements

### Requirement: 实现完成后的自动推进

系统 SHALL 在提案处于 `implementing` 且其全部待办均已到达 done 列（Ticket 终态为
`completed` / `merged` / `dropped`）时，以 `actor: 'system'` 推进到 `merging`。

该推进 SHALL 由**独立的低频调度器**触发，SHALL NOT 由任何 HTTP 请求路径触发，
SHALL NOT 在任务板的读路径（`board` / 遗留目录 / 回收查询）中触发。
调度器每轮 SHALL 单飞：上一轮未结束 SHALL 跳过本轮。

推进成功后 SHALL 在提案记录写入持久标记（`autoAdvancedAt`），使同一提案 SHALL NOT
被二次自动推进。推进失败 SHALL 只记录事件与面板提示，SHALL NOT 写入该标记
（下一轮可重试），且 SHALL NOT 阻断其他提案的推进。

以下情形 SHALL NOT 推进：存在待办不在 done 列；存在终态为 `closed` 或 `stopped` 的
Ticket；该提案没有任何待办；提案已有 `autoAdvancedAt`。

#### Scenario: 全部完成自动进 merging

- **WHEN** 提案在 `implementing`，其全部待办的 Ticket 均以 `completed` 结束
- **THEN** 下一轮扫描后提案变为 `merging`，事件流有 `actor: system` 的迁移记录

#### Scenario: 只推进一次

- **WHEN** 同一提案连续被多轮扫描命中
- **THEN** 只在第一轮推进，之后因 `autoAdvancedAt` 已存在而跳过

#### Scenario: 读路径不产生写

- **WHEN** 面板连续轮询任务板与遗留目录查询
- **THEN** 这些请求 SHALL NOT 触发任何提案状态变更，且 SHALL 在合理时间内返回

#### Scenario: 单个失败不影响其他

- **WHEN** 两个提案同时满足条件，其中一个因 Wiki 未登记推进失败
- **THEN** 另一个仍被推进，失败的那个不写标记并留下一轮重试
