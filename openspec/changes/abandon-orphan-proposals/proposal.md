# Give Orphaned Proposals a Way Out

## Why

真机截图暴露两个死角：

1. **`dl-demo`（`projects: []`）推不动**：没有关联项目 → 没有可推进分支；
2. **`lc-demo`（项目根 `/tmp/wm-lc-…` 已删除）卡片上连按钮都没有**：详情加载失败 → `lifecycle` 为空
   → 整排动作不渲染。用户看到的是"没有出路"，也不知道为什么。

同时注册表里 5 个项目全指向已删除的 `/tmp` 目录（测试残留）。

## What Changes

1. **A：动作不再随详情一起消失**。归档只依赖提案状态 → 「完成归档 / 强制归档」移出详情条件；
   详情加载失败时在卡片上显示**原因**与「重新加载」（此前静默隐藏）。
2. **B：新增「终止（abandon）」**。不跑归档编排、不要求项目存在、**必须填写原因**；
   置为终态并写 `abandonedAt` / `abandonedReason` 与一条 `transition` 事件（`actor: human`，
   `reason: abandoned: …`）→ 孤儿提案与放弃的变更有了正当出口，不再永远挂在看板上。
3. **D：清理残留**（已执行）：移除 2 个孤儿提案与 5 个目录已不存在的项目注册。

## Impact

- 服务端：`store.ts`（两个字段）、`service.ts`（`abandon` + PATCHABLE + 接口）、`api.ts`（`POST /api/proposals/:id/abandon`）；
- 客户端：`App.tsx`（终止按钮 + 详情失败可见 + 归档按钮移出详情条件）、`api.ts`（`abandonProposal`）；
- 用例：终止置终态/写原因/事件留痕；必须给原因；重复终止被拒。
