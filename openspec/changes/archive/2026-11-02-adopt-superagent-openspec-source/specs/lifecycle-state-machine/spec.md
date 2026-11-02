# lifecycle-state-machine Delta

## MODIFIED Requirements

### Requirement: 八态生命周期状态机

提案 SHALL 遵循 `draft → proposing → reviewing → ready → implementing → merging
→ archiving → archived` 八态生命周期：`transition(id, to)` SHALL 拒绝非相邻转移
（不跳步），前进转移 SHALL 校验前置条件（proposing：提案文件存在；reviewing：方案工件
完整、OpenSpec validate 通过、自动机检无 CRITICAL 并生成 `planHash`；ready：人已确认该 `planHash`；
implementing：每个 target 的基线分支存在且已写入实现待办——目录由 Super-agent 的
`prepare` 创建，WorkMate SHALL NOT 预建；merging：每个 target 的实现完成且审查/测试
证据通过；archiving：人已批准合并归档且每个 target 的实现分支已合并进其基线分支；
archived：归档编排成功），相邻回退 SHALL 允许（全程可逆）。除 G2（reviewing→ready）与
G5（merging→archiving）外，其余前进转移 SHALL 由证据自动推进，SHALL NOT 要求人工逐态点击。
旧四态记录 SHALL 经 normalize 迁移。单目标旧提案 SHALL 继续把「基线分支」视为
`Config.lifecycleMainBranch`，行为与升级前一致。REST SHALL 提供 `POST /:id/advance` 与
`POST /:id/transition`；工具 `workmate_proposal_archive` 的 mode SHALL 接受目标状态名，
但正常路径 SHALL 由 `reconcile` 自动推进。

「实现完成」SHALL 定义为：该 target 的 Ticket 已结束，或该 target 从未产生过 Ticket
（待办未被接受/被忽略/只读模式）。`dropped` 终态 SHALL 视为完成（无需合并）。
**从未产生 Ticket 的 target SHALL 在归档前置中被跳过，SHALL NOT 因 `featureBranch`
为空而永久阻塞**；若所有 target 都在此列，`merging` SHALL NOT 自动推进，而 SHALL 在
面板提示"没有产生可合并的实现，先处理被忽略的待办"。

#### Scenario: 跳步被拒

- **WHEN** 从 proposing 直接 transition 到 implementing
- **THEN** 400 并提示相邻合法目标

#### Scenario: 自动机检阻断

- **WHEN** G2 前的自动机检在 `REQ.md` / `PLAN.md` / `TASKS.json` 中发现 CRITICAL 问题
- **THEN** 提案停在 reviewing，不生成可确认的 `planHash`，并列出问题与文件行号

#### Scenario: 方案未确认不执行

- **WHEN** `planHash` 尚未被人确认时尝试进入 implementing
- **THEN** 转换被拒并保持 ready，提示需先完成 G2 方案确认

#### Scenario: 不要求 worktree 已建

- **WHEN** 方案已批准，进入 implementing
- **THEN** 转换成功，只写入待办与规划事实；此时磁盘上可以还没有 worktree

#### Scenario: 旧提案语义不变

- **WHEN** 对一个只有旧标量字段、没有 targets 的提案走完整生命周期
- **THEN** 所有前置按单目标 + `lifecycleMainBranch` 校验，结果与升级前一致

### Requirement: worktree 生命周期自动管理

WorkMate SHALL NOT 在 `ready→implementing` 创建 worktree，也 SHALL NOT 复制配置文件或
安装依赖：目录由 Super-agent 的 `prepare` 在首次 launch 时创建（见 `worktree-plan`）。
该转换 SHALL 只做两件事：校验每个 target 的基线分支存在，以及分配任务级端口段
（键 `${proposalId}--${project}--${taskId}`）并写入实现待办。

`archived` 转换 SHALL 回收该提案全部 target 的 worktree：先确认对应实现分支已合并进
各自 `baseBranch` 且 Ticket 已结束，再释放端口、执行 `git worktree remove`；单个 target
回收失败 SHALL 记为 warn 且不阻断其余 target。端口分配 SHALL 保证并发互不冲突
（BASE_PORT + 空闲 index * portStep）。

#### Scenario: 进入 implementing 不建目录

- **WHEN** 提案进入 implementing
- **THEN** WorkMate 不执行 `git worktree add`，只记录规划事实与端口段

#### Scenario: 归档后回收

- **WHEN** 提案进入 archived 且各 target 的 Ticket 已结束、分支已合并
- **THEN** 各关联仓库的 `git worktree list` 都不再含该 Ticket 的目录，端口表中对应条目被释放
