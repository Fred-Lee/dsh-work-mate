# task-workitem Specification

## Purpose
TBD - created by archiving change add-task-workitem-model. Update Purpose after archive.
## Requirements
### Requirement: WorkItem 聚合根与两级结构
系统 SHALL 提供任务工作项(WorkItem)模型,作为跨阶段的聚合根,与 orchestrator 的 `TaskRecord`(run)解耦:一个 WorkItem 拥有零到多个 `runs[]`(按 id 引用 run),一个 run 只属于一个 WorkItem;现有 `taskId`(run)语义不变。WorkItem SHALL 含:id、标题、摘要(summary)、仓库标识(baseRepo 或 projectGroup)、当前阶段、阶段状态与时间戳。

#### Scenario: 卡片关联多次执行
- **WHEN** 某 WorkItem 下发起第一次 fleet run,随后重试发起第二次
- **THEN** 两次 run 的 id 都作为独立引用存在于该卡片的 `runs[]`,顺序与时间戳可查

#### Scenario: run 生命周期独立于卡片
- **WHEN** 某 run 完成 merge 或 discard
- **THEN** 该 run 在 orchestrator 的状态机与时间线(change A)照常推进,WorkItem 只读引用其结果,不复制 run 数据

### Requirement: 四阶段与迁移事件
WorkItem SHALL 处于且仅处于四个阶段之一:`需求分析`、`规格设计`、`开发实施`、`验收归档`。阶段迁移 SHALL 产生版本化生命周期事件(阶段 from/to、触发者、时间、相关 run/审批引用),事件 SHALL 追加到持久化的事件流(可被 change C 审计消费)。

#### Scenario: 顺序推进阶段
- **WHEN** 调用方对满足当前阶段就绪条件的 WorkItem 提交推进(如从 `需求分析` 到 `规格设计`)
- **THEN** 卡片阶段更新,并追加一条包含 from/to/时间/触发者的迁移事件

#### Scenario: 越级推进被拒
- **WHEN** 调用方尝试把卡片从 `需求分析` 直接推进到 `开发实施`
- **THEN** 推进被拒绝并返回中间缺失阶段提示,卡片阶段不变、不产生迁移事件

### Requirement: 关联集(引用而非副本)
WorkItem SHALL 支持关联以下对象,且 SHALL 存储引用(路径/服务端 id)而非内容副本:`docs[]`(workbench draft 或 Tolaria note 的路径/id)、`conversations[]`(type:`dsh|claude|codex` + 会话 id/transcript 路径)、`worktrees[]`(分支/路径)、`runs[]`、`affectedServices[]`、`artifacts[]`(change D 产物 id)。关联增删 SHALL 追加变更事件并持久化。

#### Scenario: 关联一份 PRD
- **WHEN** 用户把一份已定稿 PRD draft 关联到卡片
- **THEN** 卡片记录该 draft 的路径/id 与关联时间;draft 内容仍在原位,不被复制进卡片存储

#### Scenario: 关联缺失目标不写入
- **WHEN** 用户尝试关联一个不存在的 draft/note/artifact id
- **THEN** 关联被拒绝并返回明确的"目标不存在"错误,卡片关联集不变

### Requirement: 对话摘要
当卡片关联对话(type `dsh|claude|codex`)时,系统 SHALL 生成并保存一段 2–4 行的中文摘要(`summary`)用于快速浏览;摘要 SHALL 基于该对话最近消息自动生成、可由用户编辑、可重新生成,并记录生成来源与时间。对话引用 SHALL 保留原会话 id,摘要不替代原会话内容。

#### Scenario: 建档时自动摘要
- **WHEN** 从某 DSH 会话"保存为任务"建档
- **THEN** 卡片创建后带有一段基于该会话最近消息的摘要,卡片可立即被浏览而不必打开会话

#### Scenario: 摘要被用户改写
- **WHEN** 用户编辑卡片摘要并保存
- **THEN** 卡片摘要更新为新文本,且保留最后编辑时间;重新生成会覆盖为新的自动摘要

### Requirement: DoR/DoD 门数据与推进校验
WorkItem SHALL 携带各阶段定义的门清单数据:进入 `开发实施` 要求 spec 已具备(存在关联的 spec/draft 且标记定稿)、进入 `验收归档` 要求至少一个 run 已 merge、存在对应 merge 审计记录。推进接口 SHALL 在数据层面校验门项,不满足则返回缺口清单并拒绝推进;满足则推进并写入迁移事件。

#### Scenario: 未定稿规格的卡片被拦在开发列外
- **WHEN** 某卡片无已定稿 spec 而尝试推进到 `开发实施`
- **THEN** 推进被拒,返回缺口:"缺少已定稿 spec",并允许调用方补齐后重试

#### Scenario: 未 merge 的卡片不能归档
- **WHEN** 某卡片所有 run 均未 merge 而尝试推进到 `验收归档`
- **THEN** 推进被拒,返回缺口:"至少一个 run 需已 merge 且存在审计记录"

### Requirement: 开发作用域与冲突域 WIP
卡片推进到 `开发实施` 时,SHALL 携带可选的**开发作用域**声明 `scope.module`(可从 spec/关联文档/topology 自动建议,用户可改);未声明时回退为整仓库域。WIP 策略 SHALL 以"冲突域"为计数单位:冲突域键 = `仓库 × 作用域`(声明了 module 用 `repo:module`,否则用 `repo:*`);同仓库内不同 module 的卡片互不计数、可并行,同冲突域的卡片受该域上限约束(默认 `module:1`、整仓回退 `repo:*:2`)。达到上限的推进请求 SHALL 被拒绝并返回排队原因(含冲突域键),供 UI 展示。

#### Scenario: 同仓库不同模块并行
- **WHEN** 仓库 `R` 的卡片 X 声明 `scope.module=a`、卡片 Y 声明 `scope.module=b`,且都尝试进入 `开发实施`
- **THEN** 两者互不计数,可同时进入开发列并行执行

#### Scenario: 同冲突域超限被拒
- **WHEN** 仓库 `R` 模块 `a` 已有 1 张卡在开发(上限 1),又尝试推进第 2 张同样声明 `scope.module=a` 的卡片
- **THEN** 推进被拒,返回冲突域 `R:a` 已达上限的排队原因;卡片可改声明 `module=b` 后重试

#### Scenario: 未声明作用域回退整仓域
- **WHEN** 卡片未声明 `scope.module` 而仓库 `R` 整仓域 `R:*` 已达上限 2
- **THEN** 该卡片被拒并提示"整仓域已满,请补充模块作用域或等待"

### Requirement: 持久化与重启存活
WorkItem 数据 SHALL 持久化于 `HELMSMAN_HOME` 下(`~/.helmsman/board/items.json`,原子 tmp+rename 写),宿主重启后卡片、阶段、关联与迁移事件 SHALL 完整可读。board Service(`@helmsman/board`)SHALL 以插件形式提供读写接口,存储目录不可写时写操作 SHALL 报错且不破坏既有文件。

#### Scenario: 重启后看板还原
- **WHEN** 创建并推进若干卡片后宿主重启
- **THEN** 卡片列表、各自阶段与最近迁移事件均还原,看板可继续操作

#### Scenario: 原子写防损坏
- **WHEN** 写入 `items.json` 中途进程退出
- **THEN** 磁盘上仍保留上一次完整文件,下次启动可正常读取

