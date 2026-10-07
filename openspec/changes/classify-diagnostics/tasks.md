# Tasks — Classify Diagnostics

- [x] 1. 向量优先归类（阈值 0.55）+ `classify` 统计
- [x] 2. 导出后写聚合 `decision` 事件（含 llmReachable）
- [x] 3. 归档编排分级判断写 `decision` 事件
- [x] 4. `/workmate search --semantic`
- [x] 5. REST `POST /api/wiki/export`、`POST /api/wiki/search`
- [x] 6. 测试：向量优先不花 token、缺判断层如实上报、search 标志解析
- [x] 7. 真机：重跑导出核对 classify 与边数；curl 验证 REST
