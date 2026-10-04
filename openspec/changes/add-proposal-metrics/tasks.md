# Tasks — Add Proposal Metrics (Event Log)

- [x] 1. `src/features/proposal/events.ts`：`ProposalEvent` 类型、`EventLog`
      （append/read/list，撕裂尾行容忍 + `skippedLines` 计数、`paths()`、可注入 homeRoot）
- [x] 2. `ProposalServiceImpl.setStatus(id, status, meta?)` 追加 `transition` 事件（含 actor）；
      `ProposalService` 接口同步扩展；`addDecision/block/unblock` 可选留痕（本变更不做）
- [x] 3. `LifecycleServiceImpl`：透传 `actor`；前置校验与审查门失败时写 `gate-failed`
      事件后原样抛出；归档成功写 `archived` 事件
- [x] 4. `src/features/proposal/metrics.ts`：`proposalMetrics` / `aggregateMetrics` 纯函数
      （口径见 design D5）
- [x] 5. `index.ts`：接线 EventLog（`workmateHome` 同目录）、actor=`agent`、注册
      `workmate_metrics` 工具（第 11 个工具）
- [x] 6. `api.ts`：actor=`panel`；`GET /workmate/api/metrics?id=` 端点
- [x] 7. 测试：events（追加/读取/撕裂尾行/损坏行）、metrics（口径逐条）、
      service（迁移留痕、actor）、archive（门禁失败留痕）、api（metrics 端点）、
      index（工具数 10→11 与 metrics 工具存在）
- [x] 8. 文档：README 工具表 + REST 表 + 数据落盘表（新增 `events.jsonl`）、AGENTS.md 数据落盘段
- [x] 9. 全量验证：`pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm verify` /
      `openspec validate --strict`，并真机核验（重启后 `workmate_metrics` 可调用、
      `events.jsonl` 有事件）
