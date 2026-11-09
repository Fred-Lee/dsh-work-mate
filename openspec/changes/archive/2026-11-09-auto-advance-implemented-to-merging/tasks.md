# Tasks — 实现完成时自动推进到 merging（低频调度器版）

- [x] 1. 规格增量：`lifecycle-state-machine` 补 `implementing → merging` 自动推进
  （判据 + 触发方式约束：SHALL NOT 由请求路径触发）；`task-intake` 补
  "面板读路径 SHALL NOT 产生写副作用" <!-- writes: openspec/changes/auto-advance-implemented-to-merging/specs/** -->
- [x] 2. `Proposal` 新增 `autoAdvancedAt?: string`，加入 `patchFields` 白名单
  <!-- writes: src/features/proposal/store.ts, src/features/proposal/service.ts -->
- [x] 3. `src/features/task/advance-scan.ts`：纯判据 `implementationComplete` /
  `completedProposals` + 扫描器 `runAdvanceScan`（单飞由调用方保证）
  <!-- writes: src/features/task/advance-scan.ts -->
- [x] 4. `src/index.ts`：启动 60s 调度器（`ctx.effect` 内 clearInterval），
  每轮调 `runAdvanceScan` 并写 `advance-scan` 事件；**不碰 board**
  <!-- writes: src/index.ts -->
- [x] 5. **事故回归用例**（关键）：并发 50×`board()` + 扫描交错 → 不死锁、
  同一提案只推进一次、单提案失败不影响其他；`board()` 单次耗时断言上界
  <!-- writes: src/features/task/advance-scan.test.ts, src/features/task/task.test.ts -->
- [x] 6. 门禁全绿 + 真机验证：连续轮询面板 3 分钟不卡死，worker 完成后提案自动进
  `merging` 且只进一次 <!-- writes: （无源码写域；仅运行命令与记录） -->
