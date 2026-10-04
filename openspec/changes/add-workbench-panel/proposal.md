# Add Workbench Panel (left rail + control room)

## Why

两个问题叠在一起：

1. **位置错**：WorkMate 现在只是右侧 dock 的一个 tab（`dsh-better-sidebar` 的
   `workmate:proposals`），而中央被对话占满——用户的原话是"想把 DSH 打造为工作台，
   而不是对话界面"。宿主的原生工作台模型其实已经存在：**`main`（keyed 中央面板，
   "Central panel selected by sidebar entry id"）+ `sidebar.panellist`（左栏图标，
   "Each list id addresses the matching main panel"）**，`plugins` / `schedules` /
   `mnemon` 都是这么进驻的。WorkMate 没走这条路。
2. **看不到全局**：`workmate_metrics` / `workmate_bands` 只有 agent 能看（工具）与
   REST 能读，没有给人看的聚合视图——"跨提案的控制室"正是社区调研里最该补的一块。

## What Changes

1. **注册原生工作台面板**（零硬依赖，仍走惰性 `ctx.inject(['slots'], …)`）：
   `main` 槽 `key: 'workmate'` 承载现有面板；`sidebar.panellist` 槽 `id: 'workmate'`
   给左栏一个图标，点它中央即切到 WorkMate。better-sidebar 的 tab 注册**保留**——
   两条路并存，任一侧缺服务都能用。
2. **面板新增「控制台」视图**（第三个 pill：提案 / 控制台 / 图谱）：
   - 顶部 KPI：提案总数、返工率、首次通过率、近 7/30 天归档数、周期时间中位数；
   - 提案行：状态、当前状态停留、返工次数、门禁失败次数、未决卡点、是否已归档；
   - 控制带：每指标 当前/基线/σ/偏离/档位（`insufficient-data` 如实显示，不伪装成正常）。
3. **度量投影补一列 per-proposal 行**：`aggregateMetrics` 增加 `perProposal[]`
   （控制台一次请求就能渲染，避免 N+1 次 `?id=` 调用）。

## Capabilities

### 新增能力

- `workbench-panel`：WorkMate 的原生 `main` 面板与 `sidebar.panellist` 图标（含控制台视图）。

### 修改能力

- `proposal-metrics`：聚合度量增加 `perProposal` 行投影。

## Impact

- 改动：`src/client/index.tsx`（两处注册）、`src/client/slot-types.ts`（槽位常量与 key）、
  新增 `src/client/PanelIcon.tsx`、`src/client/App.tsx`（控制台视图）、`src/client/api.ts`
  与 `types.ts`（两个只读接口）；服务端 `src/features/proposal/metrics.ts` 增 `perProposal`。
- **不做**：把主对话搬进右栏（宿主事实 A：右栏只在中央为对话时可见，做不到而不改宿主）；
  浮动聊天窗（`shell.overlay` 路线单独评估）。
