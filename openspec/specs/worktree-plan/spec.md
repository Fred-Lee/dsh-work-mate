# worktree-plan Specification

## Purpose
TBD - created by archiving change adopt-superagent-openspec-source. Update Purpose after archive.
## Requirements
### Requirement: 规划与创建的所有权分离

WorkMate SHALL 负责 worktree 的**规划事实**：目标仓库、基线分支、分支名、端口段、任务 ID。
这些事实 SHALL 写入 `tasks.json`（或由 target 派生），并 SHALL 由 Source 注册为执行环境变量。

目录 SHALL 由 Super-agent 创建：其 `executor.directory`（执行根）SHALL 配置为
`<repo>/.workmates`，使 Ticket 目录落在 `<repo>/.workmates/<ticket short name>`；
（`executor.directory` 是单个绝对路径，且只能由面板修改，`src/policy.ts:91-97`、
`src/app/settings.ts:45`；这也决定了"一实例一仓库"）。
SHALL NOT 由 WorkMate 在 `ready→implementing` 时抢先创建，否则 Super-agent 会因
"目录已存在即视为已准备好"而跳过 `prepare`，worker 得到的目录就没有它自己的初始化。

WorkMate SHALL NOT 声称自己拥有 worker 的 cwd；它 SHALL 只读取 Ticket 投影里的
顶层字段 `directory`（`src/app/views/records.ts:129`；空值会被省略）来定位目录。

#### Scenario: 两侧不再各自建一份

- **WHEN** 一个提案进入 implementing 并产生 Ticket
- **THEN** 磁盘上只有一个 worktree，位于 `<repo>/.workmates/<short name>`；
  WorkMate 不再写第二条

#### Scenario: 目录已存在时 prepare 不跑

- **WHEN** WorkMate 抢先创建了目录
- **THEN** Super-agent 判定"已准备好"并跳过 prepare，连 `verifyDirectory` 的凭据配置检查
  也一并跳过，worker 缺少初始化 —— 这是被禁止的路径

### Requirement: 分支命名与 PR 归属

分支名 SHALL 以 Super-agent 的 Ticket 短名结尾，使它的 PR 归属规则
（"分支最后一段等于 Ticket 短名"）成立。推荐格式 `workmate/$DSH_SUPERAGENT_NAME`。
`feature/<proposalId>` SHALL NOT 继续用于 superagent 模式：它无法绑定 PR，且同仓多目标会撞名。

`prepare` 命令 SHALL 使用 `$DSH_SUPERAGENT_NAME` 生成分支，SHALL NOT 依赖 WorkMate 预知
Ticket 短名（短名在 Eval 接受后才产生）。

WorkMate 的回收逻辑 SHALL 从 Ticket 投影的 `directory` 末段推导分支名
（`workmate/<末段>`），SHALL NOT 假设分支等于 `feature/<proposalId>`。

#### Scenario: PR 自动绑定（需 GitHub Source）

- **WHEN** worker 以 `workmate/<ticket 短名>` 推分支，并**以智能体账号**从
  `deployment.repository` 的 head 仓库开出 PR，且该仓库有启用中的 GitHub Source 在轮询
- **THEN** Super-agent 把该 PR 绑定到 Ticket 并跟踪其合并结束

#### Scenario: 没有 GitHub Source 时不绑定

- **WHEN** 只启用 `workmate` 来源、没有 GitHub Source
- **THEN** 不产生任何 PR 绑定；Ticket 只能靠 `ready` 报告结束，合并与归档仍由 WorkMate 负责

#### Scenario: 同仓两个目标不撞名

- **WHEN** 同一仓库上有两个 target 各自的 Ticket
- **THEN** 两条 Ticket 短名不同，分支与目录都不同

### Requirement: 端口按 Ticket 分配与注入

端口段 SHALL 按**任务**分配，键为 `${proposalId}--${project}--${taskId}`（无提案时为
`${repo}--${taskId}`），写入 `ports.json`；同一任务的 `attempt` 复用同一段。
分配结果 SHALL 写入任务记录并由 Source 注册为 `DSH_SUPERAGENT_WORKMATE_PORTS`。

`prepare` 命令 SHALL 把端口追加到 worktree 的 `.env`（`WORKMATE_PORT` 取首段，
`WORKMATE_PORTS` 为逗号列表），SHALL NOT 覆盖文件已有内容。

端口释放 SHALL 在 worktree 回收成功后执行；回收失败 SHALL 保留分配，避免"目录还在但端口已放"。

#### Scenario: 并发两个任务不撞端口

- **WHEN** 同一仓库上两个任务同时执行
- **THEN** 各自的端口段互不重叠，`.env` 中各有一组

#### Scenario: 重试复用端口

- **WHEN** 同一任务重试
- **THEN** 端口段不变，`.env` 不被重复覆盖

### Requirement: prepare 模板与失败语义

插件文档 SHALL 给出可直接粘贴的 `executor.prepare` 片段，至少完成：必要时 fetch、
`git worktree add -b "workmate/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "$DSH_SUPERAGENT_WORKMATE_BASE"`、
按 `$DSH_SUPERAGENT_WORKMATE_PORTS` 追加 `.env`、复制 `$DSH_SUPERAGENT_WORKMATE_COPY` 列出的文件、
有 `package.json` 时安装依赖。

`prepare` 失败 SHALL 由 Super-agent 判为 Ticket 失败并保留其输出；WorkMate SHALL NOT
自动重试 `prepare`，SHALL 在面板显示失败原因。

#### Scenario: prepare 失败可见

- **WHEN** `git worktree add` 因基线分支不存在失败
- **THEN** Ticket 进入失败态并带 `prepare` 输出；面板显示原因与"重试"入口

#### Scenario: prepare 幂等

- **WHEN** 同一 Ticket 因重试或人在 Thread 上发言而再次尝试 prepare
- **THEN** 模板检测到分支与目录已存在则复用，不因 `git worktree add -b` 的"分支已存在"
  而失败

### Requirement: 回收前置条件与执行

WorkMate SHALL 在提案 `archiving→archived` 时回收该提案全部 target 的 worktree：
前置 SHALL 为「对应 Ticket 已结束」且「分支已合并进该 target 的 `baseBranch`」；
从未产生 Ticket 的 target SHALL 跳过回收（无目录可收），SHALL NOT 因此失败；
`archived` 成功后 SHALL 删除分支 `workmate/<短名>`（除非它被其他 Ticket 引用）；
两者任一不成立 SHALL 拒绝回收并给出原因。

回收 SHALL 读取 Ticket 投影的 `directory` 作为路径，执行
`git worktree remove --force`，成功后释放端口。单个 target 失败 SHALL 只 warn，
SHALL NOT 阻断其余 target 或归档。

#### Scenario: 有活跃 Ticket 时拒绝

- **WHEN** 某 target 的 Ticket 仍在执行
- **THEN** 回收被拒绝并提示先停止；端口与目录保持不变

#### Scenario: 未合并时拒绝

- **WHEN** 分支尚未合并进基线
- **THEN** 回收被拒绝并指出未合并的分支

#### Scenario: 归档后全部回收

- **WHEN** 所有 target 的 Ticket 已结束且分支已合并
- **THEN** 对应目录被移除、端口释放，`git worktree list` 不再包含它们

### Requirement: 回滚不依赖执行器在线

回滚 SHALL NOT 依赖 Super-agent 的投影：当 Super-agent 已卸载、profile 被删除或端点不可达时，
WorkMate SHALL 仍能定位并清理它创建的目录与端口。

定位规则 SHALL 按以下顺序取第一个可用来源：① 已缓存在任务记录里的 `directory` 与 `ports`
（Source 首次观察到 Ticket 时回写，见 `worktree-plan` 的投影回写）；② 从任务记录推导的
`<repo>/.workmates/workmate-<短名>-<ticketId前12位>`；③ 扫描 `<repo>/.workmates/` 下与
该提案或任务匹配的目录。端口 SHALL 按 `ports.json` 的键查找，键缺失时 SHALL 报告"端口
可能泄漏"而不是静默跳过。

回滚 SHALL 输出一份清单（目录、分支、端口、处理结果），使操作者能核对；
SHALL NOT 只打印一句"完成"。

#### Scenario: 执行器已卸载仍可清理

- **WHEN** Super-agent 的 profile 已删除，面板仍能读到任务记录
- **THEN** 回滚脚本按缓存或命名规则找到目录并清理，输出逐项结果

#### Scenario: 找不到端口时明确告警

- **WHEN** `ports.json` 中没有该任务的键
- **THEN** 回滚输出"端口可能泄漏"并列出任务与提案，不静默通过

### Requirement: 遗留目录可见与手动回收

Super-agent SHALL NOT 在 Ticket 结束后删除目录（唯一的删除发生在 prepare 失败时清理空目录，
`executor/dsh.ts:257`）；因此面板 SHALL 列出"Ticket 已结束但仍存在"的目录
（从 Ticket 投影的 `directory` 判断），并提供手动回收。手动回收 SHALL 要求二次确认，
未合并时给出警告，SHALL NOT 静默删除。

#### Scenario: 结束但未回收

- **WHEN** Ticket 已结束而目录仍在
- **THEN** 面板列出该目录与大小/最后修改时间，并提供"回收"按钮

#### Scenario: 手动回收需确认

- **WHEN** 用户对未合并的遗留目录点击回收
- **THEN** 弹出二次确认并显示分支与基线，确认后才删除

