## ADDED Requirements

### Requirement: 任务装批与 writes 防踩踏

实现 SHALL 从提案的 `tasks.md` 派生任务（行内 `<!-- writes: a/**, b/** -->` 声明文件
范围），并按"同一批内任意两任务的 writes 不相交"的规则贪心装批，批大小 SHALL NOT 超过
调用方给出的 `maxParallel`；未声明 writes 的任务 SHALL NOT 参与冲突判定，但 SHALL 在
计划中标记为未声明；计划 SHALL 同时输出相互冲突的任务对。

#### Scenario: 相交的任务被分到不同批

- **WHEN** 任务 A 声明 `src/billing/**`、任务 B 声明 `src/billing/invoice.ts`
- **THEN** A 与 B 不在同一批，且计划里列出该冲突对

#### Scenario: 未声明范围不阻塞并行

- **WHEN** 两个任务都没有 writes 声明
- **THEN** 它们在 `maxParallel` 允许时同批

### Requirement: 任务级 worktree 与状态

实现 SHALL 为每个任务创建独立 worktree（`<root>/.workmates/<proposal>--<task>`）与分支
（`feature/<proposal>--<task>`，基于提案的 implementation 分支），并把
`{id, title, writes, branch, worktreePath, status, portRange?, startedAt?, mergedAt?, commit?, note?}`
持久化到提案的 `swarmTasks[]`；状态 SHALL 只能在
`planned → running → merged|failed`（失败可重试回 running）之间迁移。

#### Scenario: 启动任务分配独立载体

- **WHEN** 对 `planned` 任务调用启动
- **THEN** 记录写入 `branch`/`worktreePath`/`portRange`，状态变为 `running`

#### Scenario: 启动已完成任务被拒

- **WHEN** 对 `merged` 任务再次调用启动
- **THEN** 调用被拒且状态不变

### Requirement: 合并与冲突仲裁

实现 SHALL 在提案 worktree 内把任务分支合并回 implementation 分支（`--no-ff`）；
合并冲突时 SHALL 中止合并、把冲突文件列表与任务 id 返回、并把任务标记为 `failed`
（附 note），SHALL NOT 自动解决冲突；合并成功后状态 SHALL 变为 `merged` 并记录提交。

#### Scenario: 冲突可裁决后重试

- **WHEN** 两个任务改了同一文件的同一区域并先后合并
- **THEN** 第二次合并返回冲突文件列表、任务为 `failed`，工作区回到干净态（可重试）

### Requirement: 归档验收覆盖未合并任务

归档编排的验收谓词 SHALL 在存在状态不为 `merged` 的 swarm 任务时失败，摘要 SHALL 列出
`[taskId] status`；`force` SHALL 仍可跳过该谓词。

#### Scenario: 未合并任务阻断归档

- **WHEN** 提案有一个 `running` 的 swarm 任务并触发归档
- **THEN** 编排失败且摘要含该任务 id 与状态
