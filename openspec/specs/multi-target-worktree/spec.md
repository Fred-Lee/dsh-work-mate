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

`ready→implementing` 的转换 SHALL 先对全部 target 预检：项目已在注册表、根目录存在、
基线分支存在、目标 worktree 路径未被占用、父目录可写。全部通过后 SHALL 逐个创建：
路径 `<root>/.workmates/<proposalId>`、分支 `feature/<proposalId>`（从该 target 的
`baseBranch` 切出）、端口按 `${proposalId}--${project}` 分配、`.env` 端口注入、
`copyFiles` 复制、有 `package.json` 时安装依赖。

任一步失败 SHALL 按逆序回滚已创建的 worktree 并释放对应端口，提案状态 SHALL 保持
`ready`，返回失败的项目与原因。对已存在的 worktree SHALL 幂等复用，不重复创建、
不重复分配端口。

#### Scenario: 两个项目都成功

- **WHEN** 一个提案有两个 target 且预检通过
- **THEN** 两个仓库各出现一条 worktree 与 `feature/<id>` 分支，端口段互不相同，详情逐 target 显示

#### Scenario: 第二个项目失败回滚

- **WHEN** 第一个 target 已建好、第二个的基线分支不存在
- **THEN** 第一个 worktree 被移除、端口被释放，提案仍为 `ready`，错误指出第二个项目

#### Scenario: 重入幂等

- **WHEN** 对已进入 implementing 的提案重复触发实现
- **THEN** 已有 worktree 被复用，不产生第二条 worktree，端口分配不变

### Requirement: 按目标清理与回收

`archived` 转换 SHALL 清理该提案全部 target 的 worktree：先确认对应 `feature/<id>` 已
合并进各自 `baseBranch`，再释放端口、执行 `git worktree remove`；单个 target 清理失败
SHALL 记录 warn 并继续其余 target，不阻断归档。面板 SHALL 允许单独释放某个 target 的
worktree，未合并的 target 释放前 SHALL 要求二次确认。

#### Scenario: 归档后全部回收

- **WHEN** 一个双 target 提案归档成功
- **THEN** 两个仓库的 `git worktree list` 都不再包含该提案，端口表无残留

#### Scenario: 未合并时单独释放

- **WHEN** 用户在面板对一个未合并的 target 点击释放并确认
- **THEN** 该 worktree 被移除、端口释放，提案状态不变，详情标记该 target 无 worktree

### Requirement: 合并校验按目标基线

`merging→archiving` 的合并前置 SHALL 对每个根可解析的 target 校验其 `feature/<id>`
已合并进该 target 的 `baseBranch`，而不是校验单一 `main`。根不可解析的 target SHALL
被跳过并在结果中说明，不阻断其余 target 的校验。

#### Scenario: 一个仓库未合并

- **WHEN** 三个 target 中 homework-server 的 feature 分支尚未合并进其基线
- **THEN** 归档前置失败，错误只指出 homework-server，其余两个 target 的结论保留在结果中

