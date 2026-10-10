# Review — swarm 任务独立核验

## 确认项

- **记录落位**：`SwarmTaskRecord.verification`（`src/features/swarm/manager.ts`）含
  reviewer / verdict / evidence? / independence / note / at；重规划保留（有用例断言
  `replanned.tasks[0].verification.reviewer === 'auditor@2'`）。
- **三条硬规则都有用例**：① 未合并不得核验（`status: running` → 抛错，措辞含
  "先 merge 再 verify"）；② 必须署名（`'  '` → 抛错）；③ 独立性由 git 派生，不由调用方声明。
- **独立性判定复用同一纯函数**：`judgeReviewerIndependence`（与 A 提案共用），
  实测 `reviewer: 't'`（仓库提交作者为 `t <t@t>`）→ `same-as-author`；
  `reviewer: 'auditor@2'` → `independent`；未接 `repoRoot` → `undetermined`。
- **归档门四态实测**（`src/features/archive/orchestrate.test.ts`）：
  默认关 → swarm 步骤 `ok`（不因缺核验失败）；开启 → 未核验任务被点名
  `t2(未核验)`；自评 → 摘要含"同一身份"；全核验 → 步骤 `ok` 且摘要含
  "2 个有独立核验记录"。测试断言改为只看 swarm 步骤，避免被审查门（缺 review.md）
  抢先失败而失真。
- **配置两份同步**：`src/config.ts` interface + 运行时 schema + `CONFIG_DEFAULTS` +
  `src/config.test.ts` 默认值断言，四处在同一次提交里改齐（`pnpm exec vitest run src/config.test.ts` 8/8）。

## 疑问项

- **宽口径执行者集合**：任务分支的提交在合并后与提案提交共处同一仓库，因此 swarm 核验读的是
  "仓库最近提交的 author"而不是"带 `[proposal:<id>]` 的提交"。这会**偏严格**
  （可能把无关作者也算进执行者集合，更容易判 `same-as-author`），不会放过自评。
  设计 D2 记录了取舍。
- **`undetermined` 在 swarm 门里阻断，与审查门相反**（design D3）：审查门是既有关卡、
  历史数据没有 reviewer 头，所以默认 warn；`swarmReviewRequired` 默认关闭、开启者明确要求
  "每个任务都被独立核过"，且"无 git 事实"通常意味着配置没接上，此时放行等于门禁静默失效。

## 建议补充项

- 若将来把 `Config.projectRoot` 变成必然可得，D3 的不对称可以取消。
- 面板目前没有渲染 `swarmTasks[].verification`（数据已在 `proposal.swarmTasks` 里，
  `workmate_proposal_status` 会返回）。加一列是纯前端改动，留给后续提案。

## CRITICAL 问题

无。

## 明确没验什么

- **没验**：真实多 agent 协作场景下的人工核验流程（本变更只做了单测 + 编排级 fake 数据；
  没有在真实 swarm 任务上跑一遍 verify）。
- **没验**：`verify` 后重新 `merge` 同一任务（记录会留旧）——目前没有守卫，
  可能的后续改进是"重新合并时清空 verification"。这是一个**已知缺口**，不是假设。
- **没验**：面板渲染（见"建议补充项"）。
- **部分已验**：真机 action 路由（见下"重启后复核"）——`action=verify` 在重启后
  不再是 `unknown action`，而是进入真实分支并按前置守卫拒绝 `planned` 任务。
  真正"在一个已 merge 的真实 swarm 任务上跑一遍 verify"仍未做（本仓库当前
  没有处于 `merged` 的 swarm 任务记录）。

## 审查者与独立性（诚实声明）

本文件由写代码的同一个 agent 写成 —— 按本提案自己新增的判据，这是 `same-as-author`（自评），
不是独立审查。独立结论见 `openspec/changes/wire-swarm-independent-review/review.md` 之外的
人工复核记录；本轮由用户裁决。

<!-- reviewer: wire-swarm-independent-review-author -->

## 重启后复核（真机，2026-10-10 08:04 之后）

- **旧 bundle 的失败留痕（修复前后的对照证据）**：
  重启前 `workmate_swarm_task action=verify ...` 返回
  `Error: unknown action 'verify' — valid: start, merge` —— 证明当时跑的是旧 `dist/`。
- **重启后同一调用进入真实分支**：`task 't1' is planned — 独立核验只对已合并的任务有意义
  （先 merge 再 verify）`。这一次不再是路由不存在，而是本变更自己写的**合并前置守卫**
  在起作用（先在 `harden-test-integrity` 上试 `t1`，再在 7 批任务计划上复试，
  两次都是该守卫拦下）。
- **仍未做**：真实 `merged` 任务上的端到端 verify（本仓库无已合并 swarm 任务）；
  改为把独立性判定表（`independent` / `same-as-author` / `missing` / `undetermined`
  四态）与"未合并即拒绝 / 空 reviewer 即拒绝"放进 `manager.test.ts`（20 条）与
  `orchestrate.test.ts` 的 swarm 门四态用例。
- 五道门禁实跑全绿：`typecheck` ✓、`test` 43/43 文件 388/388 ✓、`verify` 五门 ✓、`build` ✓。
