# Design — Add Proposal Metrics (Event Log)

## D1 为什么是独立的 append-only JSONL，而不是往 proposals.json 里塞 history

- **写入模式不同**：`proposals.json` 是"读-改-写整文件"（原子 tmp+rename，fail-closed）；
  事件是纯追加。混在一起会让每次迁移都要重写整个聚合文件，且一旦文件损坏就同时丢掉
  状态与历史。
- **损坏隔离**：事件行解析失败只影响那一行（丢一条历史），聚合文件损坏仍按既有纪律
  fail-closed 报错。两者互不牵连。
- **AGENTS.md 早已留话**："出现事件流时再引入 JSONL 与撕裂尾行容忍"——本变更正是那个
  时刻。撕裂尾行是崩溃时最常见的形态（append 到一半），读取端必须容忍：逐行解析，
  最后一行失败即忽略并计入 `skippedLines`，其余行照常返回。

## D2 事件是真相，度量是派生（不落盘、不加缓存）

`metrics.ts` 是纯函数：`proposalMetrics(proposal, events)` 与
`aggregateMetrics(proposals, events)`，输入是聚合记录 + 事件列表，输出是数字。
不引入"度量快照文件"，避免出现第二份真相；量级上（一个提案十几条事件、单机几十个提案）
每次现算足够快。将来真的慢了，再引入按 `events.jsonl` 字节偏移的增量缓存。

## D3 actor 从调用点注进来，不从环境猜

`TransitionOptions.actor` 由三个入口显式传：agent 工具（`index.ts`）= `agent`、
REST/面板（`api.ts`）= `human`、编排内部副作用 = `system`（缺省）。这样"agent 推的 vs
人点的"可以直接统计——这正是闭环度量里最容易缺失、又最有解释力的一维
（Anthropic playbook 的「who asked for what, what the agent produced, and who approved it」）。
（不引入会话/用户身份解析：宿主身份是另一个待决问题，本变更不碰。）

## D4 门禁失败必须留痕，而且不改控制流

前置校验失败目前是"抛异常 → 状态不变"。改成"写一条 `gate-failed` 事件 → 原样抛出"：
- 事件里放 `to`（目标状态）与 `gate`（`proposal-file` / `proposal-branch` /
  `branch-merged` / `project-root` / `wiki-coverage` / `feature-branch`）以及可读 reason。
- 控制流与错误类型完全不变（`InvalidTransitionError` 照旧），因此既有测试与面板报错
  行为不受影响。
- 审查门（归档编排的 `review-gate` 步骤）失败同样记一条，`detail` 带步骤摘要。

## D5 度量指标的定义（先定口径，再写代码）

| 指标 | 口径 |
|---|---|
| time-in-state | 用该提案相邻事件的时间差切分；当前状态算到"现在" |
| cycle time | 该提案第一条事件 → `kind=archived` 的时间差；未归档不计入中位数 |
| rework（返工） | 该提案 `to` 序号小于 `from` 序号的 `transition` 条数 |
| firstPass（首次通过） | `rework === 0` 且当前状态序号 ≥ `merging`（[P1]「share of changes that merge from the first implementation pass」） |
| gate failures | `kind=gate-failed` 计数，按 `gate` 分组排行 |
| blocker/decision | 取提案记录里的 `blockers[]` / `decisions[]` 长度；supersedes 率 = 带
  `supersedes` 的决策占比 |
| throughput | 近 7 / 30 天 `to=archived` 的迁移事件数 |
| 人工等待 | `reviewing` / `merging` 的停留时长即"等待人工"（这两态的出口都依赖人合分支），不另设事件类型 |
| actor share | `transition` 事件按 `actor` 分组占比 |

明确不引入的：LOC/复杂度这类需要 diff 与静态分析的指标（留给 GitNexus 桥）、
以及任何需要外部系统（CI/APM）的指标。

## D6 非目标与后续钩子

- **不做 UI**：本变更只把数据面与工具/端点做出来；面板"度量"视图单独一个变更。
- **不做定时汇总**：`ctx.schedule` 的周期性 rollup 等到有多提案真实数据后再评估。
- **不动八态**：发布/观测仍计划用 `archived` 之后的 `outcomes[]` 承接（后续变更）。
