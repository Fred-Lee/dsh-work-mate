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
  没有在真实 swarm 任务上跑一遍 verify）。**此条已在"第二次真机复核"中关闭**——
  已在真实 merged 任务上跑通，并因此抓出两个缺陷（见下）。
- **没验**：`verify` 后重新 `merge` 同一任务（记录会留旧）——目前没有守卫，
  可能的后续改进是"重新合并时清空 verification"。这是一个**已知缺口**，不是假设。
- **没验**：面板渲染（见"建议补充项"）。
- **部分已验 → 已验**（见下"第二次真机复核"）：真机 action 路由——`action=verify` 在重启后
  不再是 `unknown action`，而是进入真实分支并按前置守卫拒绝 `planned` 任务；
  随后在 `harden-test-integrity` 的真实 `merged` 任务上把 `verify` 端到端跑通。

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

## 第二次真机复核：端到端跑通，并暴露两个真实缺陷（2026-10-10 09:33 之后）

上一节把"真实 `merged` 任务上的端到端 verify"列为未验。本轮补上了：
`harden-test-integrity` 的 `t1` 走完 `plan → start → merge → verify`，
并把负对照逐条打中（未合并即 verify 被拒；`merge` 成功；署名 = 提交作者时判 `same-as-author`）。
**端到端一跑通就抓出两处实现错误**，配置修复（判断层 provider）后的这次真机曝光是它们唯一的来源：

- **缺陷 1（功能空转）**：`workmate_swarm_task action=verify` 在生产配置下**永远**返回
  `undetermined`。链路：工具层已算出 `root`（explicit → `Config.projectRoot` → 项目注册表）
  并把它传给 `start` / `merge`，**唯独 `verify` 没传**；`SwarmManager.verify` 只读
  `deps.repoRoot`，而那是 `resolved.projectRoot !== '' ? … : undefined`，`Config.projectRoot`
  默认 `''` 且本机 profile 未设 → 恒 `undefined` → 作者集合恒空 → 恒 `undetermined`。
  这直接命中 design.md 的**风险 1**（"开启门禁后所有任务都拦"）。
  对照：归档审查门不受影响，它走 `collectExecutorIdentities(target.root, …)`，root 由编排层现算。
- **缺陷 2（门禁与规格不符）**：`swarmReviewRequired` 的 `unverified` 过滤只认
  `undefined` 与 `same-as-author`，**漏了 `undetermined`**——而 `specs/swarm-verification/spec.md`
  与 design D3 都明写"`undetermined` SHALL 视同未核验（阻断）"。
  后一个缺陷会**掩盖**前一个：门禁开着时，配置错导致的 `undetermined` 会静默放行，
  恰好与 D3 的理由（"无 git 事实通常意味着配置没接上，放行等于门禁静默失效"）相反。

### 修复内容

- `src/features/swarm/manager.ts`：`verify` 的入参增 `projectRoot?: string`；
  `taskAuthors(explicitRoot?, signal?)` 优先用显式 root，回退 `deps.repoRoot`；
  空串显式 root 视为未提供（不当作 cwd）。
- `src/index.ts`：`action=verify` 传 `projectRoot: root`（与 `start` / `merge` 对称）；
  `undetermined` 也返回 `warning`（此前只对 `same-as-author` 提示）。
- `src/features/archive/orchestrate.ts`：`unverified` filter 纳入 `undetermined`，
  失败摘要对它单独措辞"独立性无法判定：取不到仓库作者事实"。

### 本轮新增用例（可证伪）

- `src/features/swarm/manager.test.ts` +2：无 `deps.repoRoot` 但传显式 `projectRoot` 时
  `t → same-as-author`、`auditor@2 → independent`；显式 root 为空串时仍判 `undetermined`。
- `src/features/archive/orchestrate.test.ts` +1 段：门禁开启时 `undetermined` 的核验记录
  也拦归档，摘要含"无法判定"。
- `src/index.test.ts` +2：**工具层**接线回归——同一仓库同一提交，经
  `workmate_swarm_task` 走 `verify`，无名作者判 `same-as-author` 并带 warning、
  他人判 `independent`；非 git 目录判 `undetermined` 并带 warning。
  做了反向对照：把 `projectRoot: root` 那行从 `src/index.ts` 去掉后，该用例
  报 `expected 'undetermined' to be 'same-as-author'` —— 证明这条用例真的是为这个缺陷立的，
  不是跟着实现写的。

### 仍然没验什么（更新）

- **没验**：`verify` 后重新 `merge` 同一任务（记录会留旧），守卫仍缺。
- **没验**：面板渲染 `swarmTasks[].verification`。
- **没验**：`swarmReviewRequired: true` 下的**完整归档跑通**（本仓库没有已归档的
  swarm 提案；门禁语义只在 `orchestrate.test.ts` 的编排级用例里验过）。
  修复后的真机复验需要重新 `pnpm build` + 重启 harness —— 本轮交付的是代码与用例，
  真机复验在重启后进行。
