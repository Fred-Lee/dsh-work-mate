# Tasks — 决策缓存命中必须过形状校验

- [ ] 1. 规格增量：`decision-layer` 补"缓存命中 SHALL 过形状校验（choice ∈ options、
  certainty ∈ [0,1]），失效按未命中重算并留诊断" <!-- writes: openspec/changes/validate-decision-cache/specs/** -->
- [ ] 2. `DecisionService` 命中路径校验 + 诊断 <!-- writes: src/features/decision/service.ts -->
- [ ] 3. 用例：缓存注入枚举外 choice → 重算；certainty 越界 → 重算 <!-- writes: src/features/decision/service.test.ts -->
- [ ] 4. 门禁全绿后归档
