# Design — Add Workbench Panel

## D1 为什么走 `main` + `sidebar.panellist`，而不是继续做 dock tab

证据（宿主源码）：`ui-layout/src/client/index.ts` 声明 `main` 为 keyed/root 槽，
"Central panel selected by sidebar entry id"；`sidebar.panellist` 的 catalog 写着
"Each list id addresses the matching main panel; the sidebar owns the button"。原生
`ui-plugin-manager`（`key: 'plugins'` + `panellist id: 'plugins'`）与 `ui-schedule`
（`key: 'schedules'`）就是标准写法。这也顺带解释了为什么"中央工作台 + 右栏聊天"
用官方槽位做不到：`RightbarRoot` 的可见性判据是 `activePanelId === null`
（= 中央还是对话），一旦选中自定义面板，整条右列被 hidden。

## D2 保留 better-sidebar tab：能力叠加，不是替换

左栏图标与 dock tab 指向同一个 `ProposalPanel`。用户既有习惯不破：better-sidebar
装了就在右栏也能开；没装也能从左栏进。两条注册各自独立、各自惰性，任一服务缺失都不
影响另一条——与现有"不硬 inject 第三方服务"的纪律一致。

## D3 控制台读一次就够

`GET /api/metrics` 的聚合结果加上 `perProposal[]`：每行是
`{id, title, status, archived, currentStateMs, cycleTimeMs?, reworkCount, gateFailureCount,
openBlockers, decisions}`。控制台据此渲染表格；控制带另调 `GET /api/bands`（它需要
事件流与基线，是另一套口径）。两次请求，不做 N+1。

## D4 控制带在 UI 上不美化

`insufficient-data` 必须原样显示（样本不足不是"正常"）。这是 [P3] 那篇最锋利的
一句"unmeasured autonomy ... is faster entropy"在界面上的落实：宁可显示"数据不够"，
也不要让一个绿点暗示一切安好。
