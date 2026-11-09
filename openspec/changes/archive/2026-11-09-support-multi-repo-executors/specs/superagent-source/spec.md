# superagent-source Delta

## MODIFIED Requirements

### Requirement: 作为独立 Source bundle 安装

SourceKind SHALL 位于独立包 `workmate-superagent-source`，该包 SHALL 声明
`dsh.bundle.patch` 并在自身的 `cordis.patch.yml` 中只声明一条 entry。

该包 SHALL NOT 依赖 `@deepseek-ai/dsh-superagent`；与 Super-agent 之间 SHALL 只有运行期的
`ctx.orchestrator` 服务契约。

同一进程 SHALL 能注册多个本来源实例：实例 id 由配置的 `kind` 决定（默认 `workmate`，
SHALL 匹配 `^[a-z][a-z0-9-]*$`）。宿主对重复 kind SHALL NOT 被触发——部署方为每个实例
配置不同的 `kind`。所有按实例派生的标识（注册键、健康条目名、state 键前缀、
Trigger `source`、Thread key 前缀）SHALL 全部来自该实例 id，SHALL NOT 共用常量，
否则两个实例会互相去重、互相覆盖健康报告或共享游标。

#### Scenario: 两个实例共存

- **WHEN** 同一 profile 配置 `kind: workmate` 与 `kind: workmate-b` 两个实例
- **THEN** 两者都注册成功，各自报告独立健康条目，互不抛 `Source kind already registered`

#### Scenario: 状态与幂等不串台

- **WHEN** 两个实例同时扫描同一个 `taskFile`
- **THEN** 各自的游标与待办→Ticket 映射独立，同一待办不会被两个实例重复投递

### Requirement: 待办到一个 Thread 的映射与幂等 Trigger

每条可执行的待办 SHALL 映射为一个 Thread，Trigger SHALL 幂等。

实例配置 `repos`（绝对路径数组）非空时，扫描 SHALL 只投递 `repo` 命中的待办，
其余 SHALL 计入 `skippedByRepo` 并写进健康摘要；被跳过的待办 SHALL NOT 推进任何游标，
以便另一个实例接管时能正常投递。`repos` 为空时 SHALL 不限制仓库。

#### Scenario: 只投自己负责的仓库

- **WHEN** 实例 `repos` 为 `[/srv/a]`，任务表里有一条 `repo=/srv/b` 的已指派待办
- **THEN** 该待办不被投递，健康摘要的 `skippedByRepo` 为 1，另一个 `repos=[/srv/b]`
  的实例能正常投递它

### Requirement: 健康、事实与查找

健康条目、facts 与 `find` 的结果 SHALL 按实例隔离：健康条目的名称 SHALL 由实例 id
派生，`find` 返回的 Thread key SHALL 带该实例的前缀。

#### Scenario: 健康报告互不覆盖

- **WHEN** 实例 A 报告 `error`、实例 B 报告 `ready`
- **THEN** 两个状态分别可见，管理页 SHALL NOT 只显示其中一个
