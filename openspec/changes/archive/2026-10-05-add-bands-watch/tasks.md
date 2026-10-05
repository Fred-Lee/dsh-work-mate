# Tasks — Add Bands Watch

- [x] 1. `bands.ts`：`runBandsCheck`（评测 + 留痕 + 可选开提案）
- [x] 2. `index.ts`：`workmate_bands` 改用共享执行器
- [x] 3. `api.ts`：`POST /api/bands`（apply/windowDays），GET 保持只读
- [x] 4. `scripts/bands-watch.mjs` + 用例（摘要渲染、退出码、fetch 桩）
- [x] 5. 测试：REST POST 留痕与开提案、GET 只读、脚本函数
- [x] 6. 文档：README「Maintain 回环」+ cron/launchd 示例 + 为什么不用宿主 schedule
- [x] 7. 验证：typecheck / test / build / verify + 真机
