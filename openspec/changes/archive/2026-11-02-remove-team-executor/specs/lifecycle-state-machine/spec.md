## MODIFIED Requirements

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
