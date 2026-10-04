# Add Proposal Metrics (Event Log)

## Why

WorkMate 能回答"现在处于哪一态"，但**答不出任何过程问题**：`setStatus` 只改 `status`
和 `updatedAt`（`src/features/proposal/service.ts:184-189`），全仓库没有状态迁移历史、
没有事件流（grep `history` / `transitions` / `events` / `jsonl` 零命中）。于是
"在 reviewing 停了多久""回退过几次""哪道门最常失败""一个提案花了多少 agent 工时"
全部无法回答——SDLC 闭环的第一块地基（测量层）是空的。

## What Changes

1. **提案事件流**（`<DSH home>/workmate/events.jsonl`，append-only JSONL）：每次状态迁移写
   一行 `{at, proposalId, kind, from?, to?, actor, gate?, reason?, detail?}`；
   `kind` 取 `transition` / `gate-failed` / `archived` 等。读取端**容忍撕裂尾行**
   （最后一行解析失败即忽略并计数，不抛错）——事件流损坏绝不影响提案聚合。
2. **actor 归因**：`TransitionOptions` 增加 `actor?: 'agent' | 'panel' | 'system'`；
   工具调用传 `agent`，REST/面板传 `panel`，内部副作用传 `system`。默认 `system`。
3. **门禁失败也留痕**：前置校验与审查门失败时写 `gate-failed` 事件（带 `to`/`gate` 与
   可读 reason）后原样抛出——失败不是噪声，是"哪道门在挡人"的唯一数据源。
4. **度量派生**（`src/features/proposal/metrics.ts`，纯函数）：单提案给出
   time-in-state、周期时间（首条事件→archived）、**返工次数**（backward 迁移）、
   **门禁失败次数与排行**、卡点数、决策数（含 supersedes 率）、审查发现数；
   全局给出按状态的平均停留、周期时间中位数、吞吐（近 7/30 天归档数）、
   门禁失败排行、返工率、agent/panel 触发占比。
5. **交付面**：新工具 `workmate_metrics`（`{id?}`，给 id 出单提案度量，缺省出全局聚合）
   与 `GET /workmate/api/metrics`（供面板后续消费）。**本变更不做 UI**。

## Capabilities

### 新增能力

- `proposal-metrics`：提案事件流（append-only、撕裂尾行容忍）与由它派生的单提案/聚合度量。

### 修改能力

- `proposal-middleware`：状态迁移增加事件留痕与 actor 归因；新增 `workmate_metrics` 工具
  与 `/api/metrics` 端点。

## Impact

- 新增 `src/features/proposal/{events.ts,metrics.ts}` 与其测试。
- 改动：`service.ts`（setStatus 留痕 + actor）、`archive/service.ts`（门禁失败留痕、
  透传 actor）、`index.ts`（工具注册、actor=agent）、`api.ts`（actor=panel、metrics 端点）。
- **数据面**：新增一个 append-only 文件，`proposals.json` 格式与原子写纪律不变；
  事件流只追加、不重写，因此不会与 fail-closed 的聚合存储互相牵连。
- 非目标：度量 UI、跨提案的定时汇总（`ctx.schedule`）、发布/观测环节（`outcomes[]`）、
  结构化追溯链（req↔task↔commit↔test）——都是后续变更。
