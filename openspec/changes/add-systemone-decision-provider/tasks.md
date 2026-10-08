# Tasks

> 范围声明用行内 `<!-- writes: … -->`（swarm 装批 + `workmate_plan_drift` 都读它）。
> 本变更**不写** `.claude/**`、不新增运行时依赖。

- [x] 1. 规格增量：`specs/decision-layer/spec.md` —— provider 要求从"`jev`（接口占位，未配置即不可用）"改为"`jev`（TypeSafe System One 客户端，baseUrl 可配：云 Jev 或本机 Ollama）"；补一条"certainty SHALL 取选项概率（choice 取 `max(probabilities)`、noul 取 `max(noul, 1-noul)`），SHALL NOT 使用 `confidence`"的要求与场景 <!-- writes: openspec/changes/add-systemone-decision-provider/specs/** -->
- [x] 2. 配置面：新增 `decisionSystemoneUrl`（默认 `http://127.0.0.1:11434`）、`decisionSystemoneModel`（默认空 = 不可用）、`decisionSystemoneKeepAlive`（默认 `60s`）；interface 与运行时 Schemastery schema **两份同步**，否则没有校验与配置界面 <!-- writes: src/config.ts -->
- [x] 3. provider 实现 `src/features/decision/systemone.ts`：题目 → SystemOne 请求（choice / noul 两题型；state 超限即返回无结论，不静默截断）；响应 → `DecisionAnswer`（概率最大项、枚举外即"无结论"）；`AbortSignal` + 超时；非 2xx / 非法 JSON / 缺字段 → 返回 `undefined` 并写诊断留痕 <!-- writes: src/features/decision/systemone.ts -->
- [x] 4. 接线：`src/index.ts:134` 的 providers 数组加入 `jev` 实例（顺序 `jev → agent → rules`）；回归确认 `src/index.ts:138` 白名单不会把 `jev` 吞成 `agent` <!-- writes: src/index.ts -->
- [x] 5. 单测 `systemone.test.ts`：choice/noul 映射、枚举外答案、非 2xx、超时/abort、缺字段与非法 JSON；并断言"模型 provider 的回答进缓存、`rules` 的不进" <!-- writes: src/features/decision/systemone.test.ts -->
- [x] 6. 真机验收（`nimble`，本机 Ollama）：7 个节点各跑一次并记录 `choice`/`certainty`/`latencyMs`；对同一批题目与 `agent` 做分歧对比；把"验了什么 / 用什么方式（单测 or 真机）/ 明确没验什么"写进 review.md <!-- writes: openspec/changes/add-systemone-decision-provider/review.md -->
  <!-- 验收结论（可证伪）：7/7 节点真机有量测，两次独立运行 choice 与概率逐位一致；经出货 DecisionService 复核动作为 act×3 / review×2 / abstain×2。D2 反事实：改用 confidence 会让 risk-tier 与 search-rerank 静默降档（review→abstain）。D9 边界：60000B→200、65000B→400（8283 tokens>8192）、65536B→413（64 KiB）。issue：出厂默认 timeoutMs=20000 压不住冷启动（实测 TTFB 18.6–23.5 s，卸载模型后实测 20020 ms 静默降级）→ HIGH-1；超时/取消不覆盖 body 读取（实测挂起到 undici 默认 bodyTimeout 301387 ms）→ MED-1。未验：云 Jev 端点、真机 harness 以 provider=jev 装配、阈值校准、wiki 模块页（modules: 0）。 -->
  <!-- 已就绪的验收载体（已用，见第 6 项结论）：`scripts/systemone-acceptance.mjs [baseUrl] [model]` 把 7 个节点的真实题目逐个打给本机 System One 并打印 choice/certainty/latencyMs。此前的"权重未落地"阻塞已解除：`nimble` 权重已在位（8.63 GiB 磁盘 / 9.04 GiB 常驻）。 -->
- [x] 7. 文档：`README.md` 5.9 的 Jev 接入说明补"本机 Ollama 的 `/v1/systemone` 亦可用（无需 key）"；把 `clef-flash` 的机器约束（权重 11.5 GiB vs Metal 工作集上限 11.8 GiB）写进运维提示，避免下一个使用者重踩 <!-- writes: README.md -->
- [ ] 8. 落地后重导出项目 wiki：`workmate_wiki_export`，让 `index.md`/`changelog.md` 与迭代笔记反映最终状态；若届时已能产出 GitNexus 模块页（当前 `modules: 0`），顺带确认迭代笔记能链接到受影响模块 <!-- 无仓库内写入：产物落在 vault -->

- [x] 9. **前置**：主干可配 —— 新增 `Config.lifecycleMainBranch`（默认 `'main'`，本机配 `'feat/workmate'`），替换 `src/features/archive/service.ts:327`/`:353` 的 `'main'` 字面量，并把它透传给 `worktree.create`（`WorktreeManager` 已支持 `mainBranch` 入参，`manager.ts:142` 默认值不变） <!-- writes: src/config.ts, src/features/archive/service.ts, src/index.ts -->（与第 2/4 项同文件，**不得并行**）

## 验收命令（每步都跑，不以退出码判定）

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm verify
pnpm exec vitest run src/features/decision
```

## 完成标记纪律

`[x]` 只表示"这一步被认为完成了"，不等于验收通过。第 6 项必须给出可证伪的结论（哪些节点实测过、哪些只有单测、哪些没验）。
