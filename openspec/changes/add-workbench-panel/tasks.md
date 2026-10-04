# Tasks — Add Workbench Panel

- [x] 1. `metrics.ts`：`AggregateMetrics.perProposal[]`（含 title/status/停留/周期/返工/
      门禁失败/未决卡点）+ 用例
- [x] 2. `src/client/slot-types.ts`：`MAIN_PANEL` / `SIDEBAR_PANELLIST` 常量、
      `key` 注册字段、图标 props 面
- [x] 3. `src/client/PanelIcon.tsx`：左栏图标组件（遵循 `{size, active}`）
- [x] 4. `src/client/index.tsx`：`main` 面板 + `sidebar.panellist` 注册（惰性、保留 tab）
- [x] 5. `src/client/types.ts` + `api.ts`：度量/控制带只读接口
- [x] 6. `src/client/App.tsx`：第三个视图「控制台」（KPI + 提案行 + 控制带）
- [x] 7. 测试：entry（两条新注册、且无 betterSidebar 时仍在）、app（控制台渲染 KPI 与
      insufficient-data 文案）、metrics（perProposal）
- [x] 8. 文档：README（UI 章节 + 工具/REST 已有）、AGENTS.md（槽位注册纪律一句）
- [x] 9. 验证：typecheck / test / build / verify（四条门）+ 真机 `--dump-config`
