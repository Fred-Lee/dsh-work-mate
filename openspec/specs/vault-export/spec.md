# vault-export Specification

## Purpose
TBD - created by archiving change export-wiki-to-vault. Update Purpose after archive.
## Requirements
### Requirement: 项目 wiki 导出到 vault

归档编排在提案进入 `archived` 之后 SHALL 调用可选钩子 `onArchived`（当
`Config.wikiVaultAutoExport` 为真且配置了 `wikiVaultPath` 时由调用方接线），
并把结果记为 `vault-export` 步骤。钩子失败 SHALL NOT 使归档失败，
SHALL 记录该步骤为 `failed` 且说明"不影响归档"。

#### Scenario: 归档即同步

- **WHEN** 配置了 vault 且归档成功
- **THEN** 出现 `vault-export: ok` 步骤，摘要包含导出规模

#### Scenario: 导出失败不毁归档

- **WHEN** 钩子抛错（例如 vault 不可写）
- **THEN** 编排仍 `ok: true`，仅 `vault-export` 步骤为 `failed`

### Requirement: Vault 视图笔记

「触及模块」边的标注 SHALL 描述**证据类型**（来自代码路径 / 来自散文 token / 来自向量相似 /
来自判断层归类），SHALL NOT 用实现细节（如"slug 包含 vs token 重叠"）冒充证据强度。
看起来像路径或文件名的证据 SHALL 标为路径证据，即使匹配是通过 slug token 完成的。

#### Scenario: 代码路径算路径证据

- **WHEN** Impact 段给出 `src/.../HomeworkManagementService.java` 并被 token 匹配到模块
- **THEN** 该边标注为「路径命中」，而不是「token 命中」

### Requirement: Vault 词法检索

`workmate_knowledge_query` 返回结果 SHALL 把 GitNexus 的索引级告警（如 CJK 分词未开启）**提升到顶层字段**
`warning`；工具描述 SHALL 说明：符号名查询（`context` / `impact`）精确且不受语言影响，
中文模糊检索应使用 `workmate_wiki_search`，且出现 CJK 告警不代表工具失效。

#### Scenario: 中文告警可见

- **WHEN** 以中文概念执行 `query` 且索引未开启 bigram 分词
- **THEN** 返回对象顶层含 `warning`，其内容说明需要 GITNEXUS_FTS_CJK_SEGMENTATION=bigram

### Requirement: 注入判定在所有创建入口生效

创建提案时，实现 SHALL 先用**确定性前置筛**判断文本是否携带指向 agent 的指令特征；
未命中特征时 SHALL 直接判为 `benign` 并 SHALL NOT 调用模型，同时 SHALL 记录一条
`decision` 事件（`provider: 'rules'`）。命中特征时 SHALL 继续走模型判定，并 SHALL 在事件
detail 中记录命中的特征名。前置筛 SHALL NOT 单独把文本判为 `risky`。

#### Scenario: 普通文本不再误报

- **WHEN** notes 是普通业务描述（无指令特征）且判断层开启
- **THEN** 不调用模型、不置 `untrusted`，事件流留下 `provider: rules / choice: benign` 记录

#### Scenario: 明显注入仍被拦

- **WHEN** notes 含 "IGNORE ALL PREVIOUS INSTRUCTIONS" 等特征
- **THEN** 仍调用模型判定，risky 时置 `untrusted`，detail 记录命中的特征名

### Requirement: Wiki 面板

客户端 SHALL 提供一个 Wiki 面板，使用户无需命令行即可：把指定项目根的 wiki 导出到 vault，
并按关键词检索 vault；检索结果 SHALL 显示 `文件:行号` 与片段，并 SHALL 允许一键复制该位置。
面板 SHALL 复用插件既有的 `/workmate/api/wiki/*` 端点，SHALL NOT 引入第二套服务端逻辑；
面板 SHALL 在错误时显示服务端返回的状态与正文，不得静默失败。

#### Scenario: 导出

- **WHEN** 在面板填入项目根并点击「导出到 vault」
- **THEN** 显示模块/页/迭代数与归类统计（以及是否已提交）

#### Scenario: 检索

- **WHEN** 输入关键词并选择词法或语义后点击「检索」
- **THEN** 列出命中位置与片段；点击某条复制其 `文件:行号`

### Requirement: 风险未判定不得通过高风险门

拒绝代理人推进时的错误信息 SHALL 说明两点：判断层停留在 `review` 档时实现不会写入风险
（设计 D2：只有 `act` 档结论成为事实），以及**该守卫只约束 agent，人类可在面板直接推进**。
实现 SHALL NOT 因该守卫把人类操作者也挡在门外。

#### Scenario: review 档时说明出路

- **WHEN** 代理人推进被该守卫拒绝
- **THEN** 错误信息同时包含 "review" 档说明与"人类可直接推进"的提示

#### Scenario: 人类不受限

- **WHEN** 人类操作者推进同一状态
- **THEN** 该守卫不介入（是否放行由配置的批准门决定）

### Requirement: 面板长动作的可见反馈

面板发起 `推进` / `完成归档` 时 SHALL 在按钮上显示进行中文案并禁用重复点击；
成功时 SHALL 在提案卡片上显示结果（归档完成，且当编排报告 `forced` 时标注已跳过审查门）；
失败时 SHALL 把服务端返回的错误显示在卡片上，SHALL NOT 只提示在面板其他位置。

#### Scenario: 归档进行中

- **WHEN** 用户点击「完成归档」
- **THEN** 按钮变为「归档中…（编排在跑）」且不可重复点击

#### Scenario: 归档完成可见

- **WHEN** 编排返回成功
- **THEN** 卡片出现「✅ 归档完成」，`forced: true` 时附带「force：已跳过审查门」

#### Scenario: 失败可见

- **WHEN** 服务端返回错误
- **THEN** 卡片出现以 ❌ 开头的错误文案

### Requirement: 孤儿提案的终止出口

实现 SHALL 提供工具入口 `workmate_proposal_abandon`（`id` 与非空 `reason`），
该入口 SHALL 以 `actor: 'agent'` 写入 `transition` 事件；面板与 REST 入口 SHALL 以 `actor: 'human'` 记账。
实现 SHALL NOT 把 agent 的终止动作记为 human。

#### Scenario: 归属不造假

- **WHEN** agent 通过工具终止一个提案
- **THEN** 事件的 `actor` 为 `agent`；同理由面板终止时为 `human`

### Requirement: 面板动作不随详情失败消失

提案卡片上的归档动作 SHALL 仅在提案状态为 `archiving` 时渲染，SHALL NOT 依赖详情接口成功；
详情加载失败时 SHALL 在卡片上显示失败原因并提供「重新加载」。

#### Scenario: 详情失败仍有出路

- **WHEN** 提案的项目根已不存在导致详情加载失败且状态为 archiving
- **THEN** 卡片仍显示「完成归档 / 强制归档」，并显示失败原因

