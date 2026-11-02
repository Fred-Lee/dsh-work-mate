# multi-target-worktree Specification

## Purpose
TBD - created by archiving change multiproject-branch-workbench. Update Purpose after archive.
## Requirements
### Requirement: 提案目标矩阵

每个提案 SHALL 可记录 `targets: ProposalTarget[]`，每项包含 `project`、`baseBranch`、
`proposalBranch`，并在 `implementing` 之后补齐 `featureBranch`、`worktreePath`、
`portRange`、`baseCommit`。单目标提案 SHALL 继续把对应值写入旧标量字段
（`worktreePath` / `proposalBranch` / `featureBranch` / `portRange`），使旧读取端与
旧数据不受影响；多目标提案 SHALL 只以 `targets` 为准，旧标量字段留空。

所有读取路径 SHALL 经 `effectiveTargets(proposal)` 取目标列表：`targets` 存在时原样
返回，缺失时由旧标量合成一个「默认目标」（项目取第一个可解析的关联项目，基线取
`Config.lifecycleMainBranch`）。读取端 SHALL NOT 因旧数据而报错或静默丢弃目标。

#### Scenario: 一个需求落在三个仓库

- **WHEN** 创建提案时选择 internal-homework、homework-server、zujuan-online-job 三个项目，并分别指定基线分支
- **THEN** 提案 record 的 `targets` 含三项，各自保留项目、基线分支与提案分支，顺序稳定

#### Scenario: 旧提案仍可读

- **WHEN** 读取一个没有 `targets`、只有 `worktreePath/featureBranch` 的旧提案
- **THEN** `effectiveTargets` 返回一个合成目标，详情与归档流程按单目标运行

#### Scenario: 单目标回写标量

- **WHEN** 提案只有一个 target 且进入 implementing
- **THEN** `targets[0]` 与 `worktreePath/proposalBranch/featureBranch/portRange` 同时被写入且值一致

### Requirement: 基线分支解析与校验

基线分支 SHALL 按「显式指定 > 项目 `defaultBranch` > 项目当前分支 >
`Config.lifecycleMainBranch`」顺序解析。解析结果 SHALL 校验为仓库中已存在的本地或
远程分支；不存在时 SHALL 失败并返回候选分支列表，SHALL NOT 猜测或自动创建分支。
解析成功后 SHALL 记录 `baseCommit = git rev-parse <baseBranch>` 供漂移检查。

#### Scenario: 显式分支优先

- **WHEN** 项目默认分支为 `main`，创建时显式选择 `test`
- **THEN** 该 target 的 `baseBranch` 为 `test`，worktree 从 `test` 切出

#### Scenario: 分支不存在时给候选

- **WHEN** 指定的基线分支在仓库中不存在
- **THEN** 创建失败，错误信息列出该仓库当前可用分支，且不创建任何 worktree

### Requirement: 按目标原子创建 worktree

WorkMate SHALL NOT 在提案生命周期里自行创建 worktree：`ready→implementing` 只 SHALL
预检项目根与每个 target 的基线分支、分配任务级端口段（键
`${proposalId}--${project}--${taskId}`）并把规划事实写入待办。目录 SHALL 由 Super-agent
的 `executor.prepare` 在 `<repo>/.workmates` 下创建（见 `worktree-plan`）。

target 的 `featureBranch` 与 `baseCommit` SHALL 在观察到 Ticket 后由其投影回写
（分支名 `workmate/<Ticket 短名>`）；回写 SHALL 幂等，已存在且不同的值 SHALL 视为冲突
并上报而 SHALL NOT 被覆盖。

#### Scenario: 进入 implementing 不产生目录

- **WHEN** 提案进入 implementing
- **THEN** 只校验项目根与基线分支、分配端口并写任务，不产生任何 worktree

#### Scenario: 基线缺失时拒绝转换

- **WHEN** 某 target 的 `baseBranch` 在对应仓库不存在
- **THEN** 转换被拒并保持 `ready`，错误只指出该 target

#### Scenario: 分支回写冲突不静默改写

- **WHEN** 观察到 Ticket 推出的分支名与 target 上已有的 `featureBranch` 不同
- **THEN** 回写记为冲突并上报，已存在的值保持不变

### Requirement: 按目标清理与回收

`archived` 转换 SHALL 回收该提案全部 target 的 worktree/Ticket 目录：先确认对应实现分支
已合并进各自 `baseBranch` 且该 Ticket 已结束，再释放端口、执行 `git worktree remove`；
单个 target 回收失败 SHALL 记录 warn 并继续其余 target，不阻断归档。面板 SHALL 允许
单独释放某个 target 的目录，未合并的 target 释放前 SHALL 要求二次确认。

目录归属 SHALL 以 Ticket 投影的 `directory` 为准（`<repo>/.workmates/workmate-<短名>`），
端口键 SHALL 为 `${proposalId}--${project}--${taskId}`，旧提案级键
`${proposalId}--${project}` 在回收时 SHALL 兜底释放。Super-agent SHALL NOT 负责删除目录，
因此已结束但仍存在的目录 SHALL 在面板可见并可手动回收。

#### Scenario: 归档后全部回收

- **WHEN** 一个双 target 提案归档成功，且两条 Ticket 都已结束、分支都已合并
- **THEN** 两个仓库的 `git worktree list` 都不再包含对应目录，端口表无残留

#### Scenario: 未合并时单独释放

- **WHEN** 用户在面板对一个未合并的 target 点击释放并确认
- **THEN** 该目录被移除、端口释放，提案状态不变，详情标记该 target 无 worktree

#### Scenario: 仍在执行的 Ticket 不被回收

- **WHEN** 某 target 的 Ticket 尚未结束
- **THEN** 该目录不被删除，回收结果说明原因

#### Scenario: 遗留目录可见

- **WHEN** Ticket 已结束但目录仍留在磁盘上
- **THEN** 面板列出该目录并提供手动回收入口

### Requirement: 合并校验按目标基线

`merging→archiving` 的合并前置 SHALL 对每个根可解析的 target 校验其 `feature/<id>`
已合并进该 target 的 `baseBranch`，而不是校验单一 `main`。根不可解析的 target SHALL
被跳过并在结果中说明，不阻断其余 target 的校验。

#### Scenario: 一个仓库未合并

- **WHEN** 三个 target 中 homework-server 的 feature 分支尚未合并进其基线
- **THEN** 归档前置失败，错误只指出 homework-server，其余两个 target 的结论保留在结果中

