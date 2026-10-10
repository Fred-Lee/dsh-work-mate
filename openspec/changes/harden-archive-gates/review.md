# Review — 归档门禁加固

## 确认项

- **force 对 agent 被拒**：`src/features/archive/gates.test.ts` 断言
  `runArchive(force, actor=agent)` 抛错、状态停留在 `archiving`、无 approval 记录；
  错误信息同时含"面板"与 `allowAgentForceArchive`（两条独立断言）。
- **拒绝留痕**：`events.listFor('p1')` 中出现一条 `kind: 'gate-failed'` 且
  `gate === 'force-archive'`。
- **人类 force 通过且留痕**：`actor=human, force=true` → `outcome.forced === true`，
  approval 记录 `forcedGates === ['review-gate','tasks']`（`plan-drift` 只在配置开启时才列，
  这是刻意的，用例里也如此断言），`rationale` 含调用方理由 + `force 跳过：…`。
- **豁免开关生效**：`allowAgentForceArchive: true` 时 agent 可 force，仍写
  `forcedGates`（"豁免不等于不留痕"）。
- **未 force 时不动既有语义**：`outcome.forced === undefined`，且没有 `forcedGates` 记录。
- **`forced` 真正赋值**：`orchestrateArchive` 在 `reviewGate === false || tasksGate === false`
  时返回 `forced: true`（此前只声明不赋值）；`service.ts` 同时按 `options.force` 兜底。
- **审查者独立性四态**：`reviewer-independence.test.ts` 覆盖
  `independent` / `same-as-author`（含 email 与 email local-part 匹配、大小写不敏感）/
  `missing`（含 shadow 措辞）/ `undetermined`（无 git 事实时不匹配任何人）。
- **编排层三档实测**（`orchestrate.test.ts`）：`warn` 下独立审查者 → ok；
  `block` 下自评（reviewer=fred，执行者含 fred@example.com）→ `failed` 且摘要含邮箱；
  `block` 但**无 git 事实** → 只 `skipped`（warn），归档继续；
  `off` → 根本不产生 `review-independent` 步骤。
- **真实 git 身份采集**：`collects executor identities from the marker commits` 用例在临时
  仓库里 `git commit -m 'feat: seed [proposal:p1]'`（author=fred），不注入
  `executorIdentities`，归档门仍判出"同一身份"→ `failed`。这条覆盖了 D2 的完整链路。
- **引用机检**：`citations.test.ts` 覆盖 `file:line` / `file:12-30` / `file#L42` /
  裸路径 / 行号越界 / 文件缺失 / 反引号命令不算引用 / GitNexus 结论标 `notMachineCheckable` /
  去重；`fileSystemProbe` 用例断言能拒绝 `../../etc/hosts` 逃逸。
  编排层实测：`real.ts:2`（warn）→ ok；`does-not-exist.ts:3`（block）→ failed；
  `real.ts:999`（block）→ 归档仍 ok、步骤 `skipped` 且摘要含"行号越界 1"；
  `` `impact(ArchiveGate)` `` → 归档 ok 且摘要含"不可机检 1 条"。
- **面板路径不被误伤**：`src/api.test.ts` 用真实 router 实测 `POST /api/proposals/p1/archive`
  （`force: true`，actor=human）不抛错，且**失败时不会**留下 `forcedArchive` 记录
  （"决定没被执行就不算发生过"）。
- **顺带修掉的真实缺陷**：`WorktreeManager.create` 原先无条件 append `.workmates/` 到
  `.gitignore`，重复 create 会累积重复行（本仓库已实际出现重复块）——改为先读后写，
  回归用例断言 create 两次后该行仍只有一条。

## 疑问项

- **force 的语义变化是行为收紧**：agent 从此不能自行 force 归档。这是本次目的，
  但会打断"全自动流程里用 force 兜底"的用法。出路有三条且都已落地/文档化：
  面板点强制归档、`allowAgentForceArchive: true`、`approvalsRequired: []`（那条会放弃分离，不推荐）。
- **默认档位是 `warn` 而不是 `block`**：现有提案的 review.md 未必带 reviewer 头，
  默认 block 会立刻卡死既有流程。要升级为强制，改配置即可（`AGENTS.md` 归档门禁表已写）。

## 建议补充项

- `executorIdentities` 目前只取"带提案标记的提交 author"。若某提案的提交没有标记
  （历史提案），会退化成 `undetermined` → 在 `block` 档只 warn。这是**刻意的**保守方向，
  但意味着 `block` 档对老提案的保护弱于对新提案。彻底解决需要一等 attempt/执行者实体，
  另开提案。
- 面板没有渲染 `forcedArchive`（status 里已有数据）。加一列是纯前端改动。

## CRITICAL 问题

无。

## 明确没验什么

- **部分已验**：新 bundle **确认已装载**（见下"重启后复核"：本变更新增的两个工具面
  —— `workmate_swarm_task action=verify`、`workmate_plan_drift` 的 `excluded` 字段
  —— 在重启后都活着，而它们与归档门出自同一份 `dist/index.js`）。
  仍**没验**的是浏览器点到 `/workmate/api/...` 那一段：面板「强制归档」按钮的后端路径
  由 `src/api.test.ts` 的真实 router 覆盖，但没有真机点击实测。
- **没验**：GitNexus 查询结论的正确性（本变更只标注"不可机检"，从设计上就不试图验证它）。
- **没验**：`block` 档下多目标（多项目）混合情形的交互（一个项目独立、另一个自评）；
  相关的 per-target 循环分支由单目标用例覆盖，组合未单独测。
- **没验**：`console`/控制台视图的渲染变化（本变更未改客户端代码）。

## 审查者与独立性（诚实声明）

本文件由写代码的同一个 agent 写成 —— 按本提案自己新增的判据，这是 `same-as-author`（自评），
不是独立审查。`<!-- reviewer: ... -->` 的值如实写作实现者身份，不假造一个独立名字。

<!-- reviewer: harden-archive-gates-author -->

## 重启后复核（真机，2026-10-10 08:04 之后）

用户重启 harness（新实例 PID 74355）后，本变更新增的两个工具面**在真机上首次被调用**：

- `workmate_swarm_task action=verify`：重启前报 `unknown action 'verify' — valid: start, merge`
  （旧 bundle）；重启后进入真实分支 —— 对 `planned` 任务如实拒绝
  （`task 't1' is planned — 独立核验只对已合并的任务有意义`），对不存在的任务报
  `unknown swarm task`。**action 路由与合并前置守卫都在真机上生效**。
- `workmate_plan_drift`：重启后返回体新增 `excluded` 字段，四份提案的 `missing` 全部清空。
- 归档编排的其余门（审查者独立性 / 引用机检 / swarm 逐任务核验 / plan-drift）
  与上述共享同一份 `dist/index.js` 与同一次 `orchestrateArchive` 管线，
  由 `orchestrate.test.ts`（23 条，含四条门禁的正/反分支）覆盖。
- 五道门禁实跑：`typecheck` ✓、`test` 43/43 文件 388/388 ✓、`verify` 五门全绿
  （`[test-integrity] ok — 43 个测试文件全部执行，388 条通过，0 skip / 0 todo`）、`build` ✓。
