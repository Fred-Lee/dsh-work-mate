## ADDED Requirements

### Requirement: 提案事件流

每个提案的状态迁移 SHALL 追加写入 `<DSH home>/<workmateHome>/events.jsonl` 的一行
JSON 事件，字段包含 `at`、`proposalId`、`kind`，迁移事件另含 `from`、`to`、`actor`
（`agent` | `panel` | `system`）；文件 SHALL 只追加、SHALL NOT 被重写。读取端 SHALL
容忍撕裂尾行与无法解析的行（忽略并计数，SHALL NOT 抛错），且事件流的任何损坏 SHALL NOT
影响提案聚合（`proposals.json`）的读写纪律。

#### Scenario: 一次前进迁移留痕

- **WHEN** 提案从 draft 迁移到 proposing
- **THEN** `events.jsonl` 追加一条 `{kind: "transition", from: "draft", to: "proposing", actor: …}`

#### Scenario: 撕裂尾行被容忍

- **WHEN** `events.jsonl` 最后一行是写了一半的 JSON
- **THEN** 读取返回其余全部事件，并把该行计入 `skippedLines`，不抛错

### Requirement: 门禁失败留痕且不改控制流

前置校验或归档审查门失败时，实现 SHALL 先追加一条 `kind: "gate-failed"` 事件（含目标
状态 `to`、门名 `gate` 与可读 `reason`）再抛出原有错误；抛出的错误类型与控制流 SHALL
保持与之前一致，状态 SHALL NOT 被修改。

#### Scenario: 前置不满足时既有报错又有事件

- **WHEN** 提案分支未合并进 main 时推进 reviewing→ready
- **THEN** 调用方仍收到原有的 `InvalidTransitionError` 文案，同时 `events.jsonl`
  多出一条 `gate-failed`（`gate: "branch-merged"`）

### Requirement: 派生度量

实现 SHALL 由事件流与提案记录**现算**（SHALL NOT 落盘第二份真相）出单提案度量与全局
聚合度量，至少包含：各状态停留时长、周期时间、返工次数（backward 迁移数）、门禁失败
次数与排行、吞吐（近 7/30 天归档数）、actor 占比；并 SHALL 经 `workmate_metrics` 工具
（`{id?}`：有 id 出单提案、缺省出全局）与 `GET /workmate/api/metrics` 暴露。

#### Scenario: 单提案度量

- **WHEN** 调用 `workmate_metrics` 传 `id`
- **THEN** 返回该提案的停留时长、是否已归档与周期时间、返工次数、门禁失败明细

#### Scenario: 全局聚合

- **WHEN** 调用 `workmate_metrics` 不带参数
- **THEN** 返回提案总数、按状态停留均值、周期时间中位数、近 7/30 天归档数、
  门禁失败排行与 actor 占比
