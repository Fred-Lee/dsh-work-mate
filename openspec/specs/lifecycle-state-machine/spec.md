# lifecycle-state-machine Specification

## Purpose
TBD - created by archiving change add-lifecycle-worktree-wiki. Update Purpose after archive.
## Requirements
### Requirement: 八态生命周期状态机

提案 SHALL 遵循 `draft → proposing → reviewing → ready → implementing → merging
→ archiving → archived` 八态生命周期：`transition(id, to)` SHALL 拒绝非相邻转移
（不跳步），前进转移 SHALL 校验前置条件（proposing：提案文件存在；reviewing：方案工件
完整、OpenSpec validate 通过、自动机检无 CRITICAL 并生成 `planHash`；ready：人已确认该 `planHash`；
implementing：每个 target 的基线分支存在且已写入实现待办——目录由 Super-agent 的
`prepare` 创建，WorkMate SHALL NOT 预建；merging：每个 target 的实现完成且审查/测试
证据通过；archiving：人已批准合并归档且每个 target 的实现分支已合并进其基线分支；
archived：归档编排成功），相邻回退 SHALL 允许（全程可逆）。
除 G2（reviewing→ready）与 G5（merging→archiving）外，其余前进转移 SHALL 由证据自动
推进，SHALL NOT 要求人工逐态点击。旧四态记录 SHALL 经 normalize 迁移。单目标旧提案
SHALL 继续把「基线分支」视为 `Config.lifecycleMainBranch`，行为与升级前一致。REST
SHALL 提供 `POST /:id/advance` 与 `POST /:id/transition`；工具
`workmate_proposal_archive` 的 mode SHALL 接受目标状态名，但正常路径 SHALL 由
`reconcile` 自动推进。

#### Scenario: 跳步被拒

- **WHEN** 从 proposing 直接 transition 到 implementing
- **THEN** 400 并提示相邻合法目标

#### Scenario: 自动机检阻断

- **WHEN** G2 前的自动机检在 `REQ.md` / `PLAN.md` / `TASKS.json` 中发现 CRITICAL 问题
- **THEN** 提案停在 reviewing，不生成可确认的 `planHash`，并列出问题与文件行号

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

#### Scenario: 并发创建端口互斥

- **WHEN** 同项目依次创建 3 个提案的 worktree
- **THEN** 三份端口段互不相同且被记录

#### Scenario: 多目标端口互斥

- **WHEN** 一个提案在两个项目各建一条 worktree
- **THEN** 两条 worktree 的端口段互不相同，且分别记录在各自 target 上

#### Scenario: 归档后回收

- **WHEN** 提案进入 archived
- **THEN** 各关联仓库的 `git worktree list` 都不再含该提案的 worktree，端口表中对应条目被释放

### Requirement: WeKnora Wiki 关联

tasks.md 任务 SHALL 可声明 `<!-- wiki: true; type: technical|business|both -->`；
Agent 经 `workmate_wiki_link` 登记 WeKnora 页面引用（url/pageType/version/commit/
taskId），pageType SHALL ∈ concept|synthesis|entity。implementing→merging 的
前置校验 SHALL 确认每个声明 wiki 的任务已有引用且类型覆盖
（technical→concept|synthesis；business→entity|concept）。归档编排 SHALL 生成
`wiki.md`（按技术方案/业务规则分组）与 `commits.md` 写入 change 目录。
WeKnora 服务不可用时 SHALL 记录警告；`weknoraWikiRequired=false` 且未配置
知识库时 SHALL 跳过关联检查。

#### Scenario: 类型覆盖校验

- **WHEN** 任务声明 wiki_type: technical 但只登记了 entity 页面
- **THEN** merging 转换被拒并列出缺失类型

#### Scenario: 归档留痕

- **WHEN** 提案完成归档
- **THEN** `changes/archive/<date>-<id>/` 内出现 wiki.md 与 commits.md

### Requirement: 证据派生与自动推进

插件 SHALL 提供 `ProposalReadiness` 评估器与 `reconcile(proposalId)`：前者读取方案工件
完整性、OpenSpec validate 结果、`planHash`、审批记录、各 target 的 Ticket 投影与分支
合并状态，输出当前可进入的状态；后者 SHALL 幂等推进到该状态，SHALL NOT 跨过未批准
的人工门。自动推进 SHALL 记录 `auto: 'evidence'` 与证据快照到事件流；手动
`advance`/`transition` SHALL 保留为覆盖/回退入口。

`planHash` SHALL 由方案工件规范化计算：OpenSpec 的 `proposal.md/design.md/tasks.md/specs/**`；
若已生成 `TASKS.json`，一并纳入。G2 批准后任一纳入文件变化 SHALL 使批准失效并把提案
退回 `reviewing`。`proposalBranch` SHALL 为可选追溯字段，SHALL NOT 作为 reviewing/ready
的必需前置。G5 默认一次批准覆盖合并与归档；配置可恢复 merging/archiving 两道人工批准。

#### Scenario: 工件齐备自动进入待确认

- **WHEN** `proposal/design/tasks/specs` 完整且 `openspec validate` 通过
- **THEN** 提案自动从 proposing 进入 reviewing，并生成 `planHash`，无需人工点击

#### Scenario: 方案改动使批准失效

- **WHEN** 已通过 G2 的提案修改了 `PLAN.md` 或 `TASKS.json`
- **THEN** `planHash` 不再匹配，提案自动退回 reviewing，需重新确认

