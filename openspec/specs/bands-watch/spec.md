# bands-watch Specification

## Purpose
TBD - created by archiving change add-bands-watch. Update Purpose after archive.
## Requirements
### Requirement: 控制带的确定性对外入口

实现 SHALL 提供共享的控制带执行器，使 `workmate_bands` 工具与 REST 使用同一口径评测、
留痕（`band-breach` 事件）与回流（`apply` 时创建 `metric-regression` 草稿提案）；
`POST /workmate/api/bands` SHALL 接受 `{apply?, windowDays?}`，`GET` SHALL 保持只读
且 SHALL NOT 创建提案或写事件。

#### Scenario: GET 只读

- **WHEN** 调用 `GET /workmate/api/bands`
- **THEN** 返回评测结果，事件流与提案集合都不变

#### Scenario: POST 带 apply 回流

- **WHEN** 存在 propose 档越界且调用 `POST /workmate/api/bands {apply:true}`
- **THEN** 事件流多出 `band-breach`，且新建一个 `metric-regression` 草稿提案

### Requirement: 可调度脚本

仓库 SHALL 提供 `scripts/bands-watch.mjs`：拉取 `GET /workmate/api/bands`，按 `--fail-on`
（默认 `propose`）返回退出码 `0`（未达阈值）/`1`（达阈值）/`2`（调用失败），`--apply` 时
SHALL 追加一次 `POST`；其摘要渲染与退出码判定 SHALL 是可直接单测的纯函数。

#### Scenario: 越界时退出码为 1

- **WHEN** 评测结果里存在 `propose` 档且 `--fail-on propose`
- **THEN** 脚本退出码为 1，并把越界指标打印出来

#### Scenario: 调用失败退出码为 2

- **WHEN** 目标地址不可达
- **THEN** 退出码为 2，错误信息可读

