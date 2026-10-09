# Design — swarm 任务独立核验

<!-- files: src/features/swarm/manager.ts, src/features/archive/orchestrate.ts, src/features/archive/service.ts, src/index.ts, src/config.ts, AGENTS.md, src/features/guidance/content.ts -->

## D1 记录挂在任务上，不新增存储层

`SwarmTaskRecord` 已经有 `status` / `branch` / `commit` / `note`，核验记录作为同一可选字段
`verification` 落上去（`proposals.json` 里顺手可见，面板与 `workmate_proposal_status` 无需改结构）。
重新 `plan` 时保留既有 `verification`——重规划不该抹掉已做过的核验；但**重新合并**会把
记录留旧，所以 `verify` 的时间戳参与"看过哪一版"的判断（`commit` 与 `at` 都在）。
替代方案（单独一张 verification 表）在本规模下是过度设计。

## D2 独立性判定复用审查门的同一份纯函数

`judgeReviewerIndependence`（A 提案新增）已经在处理"自报身份 vs git 身份集合"，
这里**不再写第二套**：`SwarmManager.verify` 读 `repoRoot()` 的提交 author 集合，
把 `reviewer` 与它比对，得到 `independent | same-as-author | undetermined`。

差异只在"读哪个身份集合"：审查门读的是**携带 `[proposal:<id>]` 标记的全部提交**的 author；
swarm 核验读的是**该仓库最近提交**的 author（任务分支的提交在合并后已进入同一仓库）。
这是刻意的宽口径：swarm 任务的提交不一定带提案标记（任务分支上常常没有），
按标记过滤会把执行者集合查成空集，反而让判定退化。宽口径的代价是"可能与提案无关的
作者也被算进执行者集合"——但那条错误的方向是**更严格**（更容易判 `same-as-author`），
不会放过真正的自评。

## D3 `undetermined` 在 swarm 门里阻断，与审查门相反

审查门（`reviewerIndependence`）对 `undetermined` 只 warn，理由是"无法判定不等于有罪"。
swarm 门（`swarmReviewRequired`）对 `undetermined` 视同**未核验**（阻断）。这条不对称
是刻意的，两个理由：

1. **前提不同**。审查门是既有关卡，历史上大量 `review.md` 没有 reviewer 头，
   默认阻断会立刻卡死既有流程；`swarmReviewRequired` 是默认关闭的新关卡，
   开启它的人明确表达了"我要每个任务都被独立核过"。
2. **语义不同**。"没有 git 事实"在 swarm 场景里通常意味着**配置没写好**
   （`repoRoot` 没接上），而不是"历史数据缺失"——这时放行等于让门禁静默失效。

如果将来把 `repoRoot` 变成必然可得，这条不对称可以取消。

## D4 未合并不得核验：合并是前提，不是替代

`verify` 对 `status !== 'merged'` 直接抛错（`独立核验只对已合并的任务有意义`）。
理由：核验的对象是"合进实现分支的那份产出"；对一个还在跑的 worktree 出核验结论，
到了合并时已经不成立。这也让门禁的语义干净——归档时只可能有 `merged` 的任务，
门禁只需检查"有没有核验记录"，不需要处理"核验的是哪一版"。

## D5 门禁的失败信息要可操作

`failed` 摘要逐任务点名并区分两种原因：`t2(未核验)` 与
`t1(核验者 X 与提交作者同一身份)`，并在末尾给出两条出路：先
`workmate_swarm_task action=verify`，或显式关掉 `Config.swarmReviewRequired`。
不写"swarm 检查失败"这种不可行动的话。

## 风险与回滚

- 风险 1：`repoRoot` 在无 `Config.projectRoot` 时未接上 → 一律 `undetermined` → 开启门禁后
  所有任务都拦。缓解：门禁默认关闭；错误信息说明原因；`swarm.verify` 的返回值里带 `note`。
- 风险 2：宽口径执行者集合可能误判 `same-as-author`。缓解：判定的方向偏严格，
  且 `same-as-author` 只影响开启门禁的提案；返回体带 `warning` 供调用方判断。
- 回滚：把 `Config.swarmReviewRequired` 设回 `false`，行为与今天一致；
  `verification` 字段只是数据，不影响任何既有逻辑。
