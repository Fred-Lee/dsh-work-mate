# Tasks — Add Archive Orchestration

- [x] 1. `src/features/archive/orchestrate.ts`：五步流水线（tasks 快照 / swarm
      记录性跳过 / openspec archive / gitnexus analyze / 状态落位），失败即停
- [x] 2. `src/features/archive/service.ts`：archive 接编排引擎（成功才置 archived，
      失败返回 step 日志且状态不变）
- [x] 3. `src/index.ts`：编排注入与工具语义升级（签名不变）
- [x] 4. 单测：任务解析（含大写 [X]）、假 CLI 流水线全绿 / 失败即停、服务层编排
      成败两路
- [x] 5. 真机冒烟：见最终验证记录
