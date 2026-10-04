## MODIFIED Requirements

### Requirement: 派生度量

实现 SHALL 由事件流与提案记录**现算**（SHALL NOT 落盘第二份真相）出单提案度量与全局
聚合度量，至少包含：各状态停留时长、周期时间、返工次数（backward 迁移数）、**首次通过率**
（无回退到达 merging+）、门禁失败次数与排行、吞吐（近 7/30 天 `to=archived` 迁移数）、
actor 占比；聚合结果 SHALL 另含 `perProposal[]` 行投影（提案 id、标题、状态、是否已归档、
当前状态停留、周期时间、返工次数、门禁失败次数、未决卡点数、决策数），使控制台一次请求
即可渲染；并 SHALL 经 `workmate_metrics` 工具（`{id?}`：有 id 出单提案、缺省出全局）与
`GET /workmate/api/metrics` 暴露。

#### Scenario: 单提案度量

- **WHEN** 调用 `workmate_metrics` 传 `id`
- **THEN** 返回该提案的停留时长、是否已归档与周期时间、返工次数、门禁失败明细

#### Scenario: 全局聚合含每提案行

- **WHEN** 调用 `workmate_metrics` 不带参数
- **THEN** 返回提案总数、按状态停留均值、周期时间中位数、近 7/30 天归档数、
  门禁失败排行、actor 占比，以及 `perProposal[]` 行投影
