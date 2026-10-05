# Tasks — Add Artifact Ledger

- [x] 1. `artifacts.ts`：声明集合（writes/files）+ `computeDrift` + 工件账本采集（sha256）
- [x] 2. `orchestrate.ts`：归档成功后逐项目采集 drift 与账本进 manifest
- [x] 3. `config.ts`：`planDriftGate`（默认 false）
- [x] 4. `index.ts`：`workmate_plan_drift`（归档前查询，共 15 个工具）
- [x] 5. 测试：声明解析、漂移数学、账本哈希、漂移门（默认不拦 / 开启后拦 / force 跳过）
- [x] 6. 文档：README（工件账本与漂移一节）+ 面板交付物小节显示漂移
- [x] 7. 验证：typecheck / test / build / verify + 真机
