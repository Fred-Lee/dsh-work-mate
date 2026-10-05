# Tasks — Add Decision Cache

- [x] 1. `cache.ts`：键构造、读（fail-open）、写（原子 + 上限淘汰）
- [x] 2. `service.ts`：命中即复用（标记 cached），未命中调用 provider 后写回
- [x] 3. `config.ts`：`decisionCacheEnabled`（默认 true）/ `decisionCacheMax`（默认 500）
- [x] 4. `events.ts` + `DecisionOutcome`：`cached` 字段
- [x] 5. 测试：命中/未命中/state 变化不复用/换模型不复用/损坏文件 fail-open/关闭开关/上限淘汰
- [x] 6. 文档：README（判断层一节补缓存）+ AGENTS 里程碑
- [x] 7. 验证：typecheck / test / build / verify + 真机
