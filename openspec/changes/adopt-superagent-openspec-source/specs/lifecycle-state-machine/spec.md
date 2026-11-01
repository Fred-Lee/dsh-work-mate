# lifecycle-state-machine Delta

## MODIFIED Requirements

### Requirement: 八态生命周期状态机

提案 SHALL 遵循 `draft → proposing → reviewing → ready → implementing → merging
→ archiving → archived` 八态生命周期：`transition(id, to)` SHALL 拒绝非相邻转移
（不跳步），前进转移 SHALL 校验前置条件（proposing：提案文件存在；reviewing：方案工件
完整、OpenSpec validate 通过、自动机检无 CRITICAL 并生成 `planHash`；ready：人已确认该 `planHash`；
implementing：方案已批准且已写入实现待办（`taskExecutor=team` 时为团队 run 已启动且每个
target 的 worktree 已创建）；merging：每个 target 的实现完成且审查/测试证据通过；
archiving：人已批准合并归档且每个 target 的实现分支已合并进其基线分支；archived：归档编排
成功），相邻回退 SHALL 允许（全程可逆）。除 G2（reviewing→ready）与 G5（merging→archiving）
外，其余前进转移 SHALL 由证据自动推进，SHALL NOT 要求人工逐态点击。旧四态记录 SHALL 经
normalize 迁移。单目标旧提案 SHALL 继续把「基线分支」视为 `Config.lifecycleMainBranch`，
行为与升级前一致。REST SHALL 提供 `POST /:id/advance` 与 `POST /:id/transition`；工具
`workmate_proposal_archive` 的 mode SHALL 接受目标状态名，但正常路径 SHALL 由
`reconcile` 自动推进。

`taskExecutor = 'superagent'` 时，`implementing` 的前置 SHALL NOT 包含"每个 target 的
worktree 已创建"：目录由 Super-agent 的 `prepare` 在首次 launch 时创建（见 `worktree-plan`），
WorkMate 在该转换时 SHALL 只写实现待办与规划事实。

`taskExecutor = 'superagent'` 时，"实现完成"SHALL 定义为：该 target 的 Ticket 已结束，
或该 target 从未产生过 Ticket（待办未被接受/被忽略/只读模式）。`dropped` 终态 SHALL
视为完成（无需合并）。**从未产生 Ticket 的 target SHALL 在归档前置中被跳过，SHALL NOT
因 `featureBranch` 为空而永久阻塞**；若所有 target 都在此列，`merging` SHALL NOT 自动
推进，而 SHALL 在面板提示"没有产生可合并的实现，先处理被忽略的待办"。

#### Scenario: 跳步被拒

- **WHEN** 从 proposing 直接 transition 到 implementing
- **THEN** 400 并提示相邻合法目标

#### Scenario: 自动机检阻断

- **WHEN** G2 前的自动机检在 `REQ.md` / `PLAN.md` / `TASKS.json` 中发现 CRITICAL 问题
- **THEN** 提案停在 reviewing，不生成可确认的 `planHash`，并列出问题与文件行号

#### Scenario: 方案未确认不执行

- **WHEN** `planHash` 尚未被人确认时尝试进入 implementing
- **THEN** 转换被拒并保持 ready，提示需先完成 G2 方案确认

#### Scenario: superagent 模式不要求 worktree 已建

- **WHEN** `taskExecutor=superagent` 且方案已批准，进入 implementing
- **THEN** 转换成功，只写入待办与规划事实；此时磁盘上可以还没有 worktree

#### Scenario: 旧提案语义不变

- **WHEN** 对一个只有旧标量字段、没有 targets 的提案走完整生命周期
- **THEN** 所有前置按单目标 + `lifecycleMainBranch` 校验，结果与升级前一致

### Requirement: worktree 生命周期自动管理

`ready→implementing` 的转换 SHALL 为提案的**每个 target** 自动创建 worktree 并完成
四件事（串行锁下 `git worktree add`、端口注入 .env、copyFiles 配置复制、包管理器安装
——无 package.json 跳过）：路径 `<root>/.workmates/<proposalId>`、分支
`feature/<proposalId>` 从该 target 的 `baseBranch` 切出，`featureBranch/worktreePath/
portRange` SHALL 记录到对应 target；单目标时 SHALL 同时写入旧标量字段。任一 target
创建失败 SHALL 回滚已创建项并保持 `ready`。

`archived` 转换 SHALL 自动清理该提案全部 target（合并确认 → 释放端口 →
`git worktree remove`），单个 target 清理失败记为 warn 且不阻断其余 target。端口分配
SHALL 保证并发创建互不冲突（BASE_PORT + 空闲 index * portStep），键 SHALL 为
`${proposalId}--${project}`，创建段 SHALL 串行化。

**该要求只在 `taskExecutor = 'team'`（回退执行器）时适用。** `taskExecutor = 'superagent'`
时：`ready→implementing` SHALL NOT 创建 worktree，端口键 SHALL 为
`${proposalId}--${project}--${taskId}`，分支 SHALL 为 `workmate/<Ticket 短名>`，
目录 SHALL 由 Super-agent 的 `prepare` 创建；详见 `worktree-plan`。

#### Scenario: 并发创建端口互斥

- **WHEN** 同项目依次创建 3 个提案的 worktree（回退执行器）
- **THEN** 三份端口段互不相同且被记录

#### Scenario: 被忽略的待办不阻塞归档

- **WHEN** `taskExecutor=superagent`、某 target 的待办被 Eval 忽略、从未产生 Ticket
- **THEN** 该 target 在归档前置中被跳过，提案仍可进入 archiving；面板同时显示"该 target
  没有实现产出"并指向被忽略的待办

#### Scenario: superagent 模式不建目录

- **WHEN** `taskExecutor=superagent` 且提案进入 implementing
- **THEN** WorkMate 不创建 worktree，只记录规划事实与端口段
