# parallel-isolation Specification

## Purpose
TBD - created by archiving change multiproject-branch-workbench. Update Purpose after archive.
## Requirements
### Requirement: 分支占用从活跃提案派生

插件 SHALL 从所有处于 `draft` 之后、`archived` 之前且未 abandoned 的提案派生分支占用：
`(project, branch) → proposalId`，其中 `branch` 同时覆盖 `proposalBranch` 与
`featureBranch`。同一项目内若两个活跃提案声明同一分支，占用计算 SHALL 返回冲突并列出
占用方。已归档或已终止的提案 SHALL NOT 计入占用。

该占用 SHALL 由提案记录与 worktree 存在性实时计算，SHALL NOT 新增独立的租约数据库或
缓存文件；读取路径失败时 SHALL 降级为「占用未知」而不是伪造空闲。

#### Scenario: 两个并行提案使用不同分支

- **WHEN** 提案 A 与 B 都关联 internal-homework，基线都是 `test`，特性分支分别是 `feature/a`、`feature/b`
- **THEN** 占用表两条记录并存，不报冲突

#### Scenario: 同名特性分支冲突

- **WHEN** 两个活跃提案在同一个项目上都声明 `feature/<id>` 且 id 相同
- **THEN** 占用计算返回冲突，指出两个提案 id，并在 implementing 前置处被拒绝

#### Scenario: 归档提案不再占位

- **WHEN** 提案 A 归档后用户创建分支名相同的提案 B
- **THEN** A 不计入占用，B 可通过校验

### Requirement: 跨提案写域冲突检测

提案 SHALL 可从 `design.md` / `tasks.md` 的 `<!-- writes: a/**, b/** -->` 声明中解析出
按项目归属的写作用域。在 `ready→implementing` 前，插件 SHALL 将本提案每个 target 的
声明范围与同项目其它活跃提案的声明范围求交：
声明范围重叠 SHALL 默认阻断并列出冲突提案与重叠路径；未声明范围 SHALL 只产生 warn，
不阻断。是否把「声明重叠」降为 warn SHALL 可配置。

#### Scenario: 声明重叠被阻断

- **WHEN** 提案 A 声明 `src/main/java/service/**`，并行提案 B 声明 `src/main/java/service/order/**`
- **THEN** B 进入 implementing 被拒绝，错误列出 A 与重叠路径

#### Scenario: 未声明只警告

- **WHEN** 并行提案没有 `writes` 声明
- **THEN** 不阻断，结果里带 warn「未声明写域，无法保证互不影响」

#### Scenario: 不同项目互不干扰

- **WHEN** 两个提案的写域声明相同，但关联的是不同项目
- **THEN** 不视为冲突

### Requirement: 基线漂移提示

每个 target SHALL 记录 `baseCommit`。当基线分支当前 HEAD 与 `baseCommit` 不一致时，
implementing 前置与提案详情 SHALL 返回 warn，说明基线已前进/后退并给出复核命令
（`git log <baseCommit>..<baseBranch>` 与 rebase 建议），SHALL NOT 自动重置或改基线。

#### Scenario: 基线已前进

- **WHEN** target 记录 `baseCommit=abc123`，而 `test` 当前为 `def456`
- **THEN** 详情显示 warn 与差异命令，implementing 仍可继续（除非另有门禁）

### Requirement: 占用矩阵数据

插件 SHALL 提供只读占用数据供面板渲染：按项目列出当前分支、脏文件数、活跃 OpenSpec
change、活跃提案与它们的 target 分支/worktree 状态。数据 SHALL 标明每个条目的来源
（提案 id / worktree 路径），缺失根目录的项目 SHALL 标记为 unresolved 而不是消失。

#### Scenario: 工作台看到并行占用

- **WHEN** 同一项目上有两个活跃提案各有一条 worktree
- **THEN** 占用矩阵该行显示两个提案、两条分支、两条 worktree 路径与端口段

