# vault-export Specification

## Purpose
TBD - created by archiving change export-wiki-to-vault. Update Purpose after archive.
## Requirements
### Requirement: 项目 wiki 导出到 vault

归档编排的 `swarm` 步骤 SHALL 如实报告本提案的任务级并行使用情况：
无 swarm 任务时 SHALL 说明"未使用任务级并行"并指出派发执行由调用方负责（设计 D1）；
全部已合并时 SHALL 报告数量与分支；存在未合并任务（force 放行）时 SHALL 列出任务、状态与分支。
该步骤 SHALL NOT 用"未接线"之类措辞掩盖事实，且 SHALL NOT 因此步骤自行派发任务执行。

#### Scenario: 未使用并行时说清楚

- **WHEN** 提案没有 swarm 任务
- **THEN** 该步骤状态为 ok，摘要说明未使用任务级并行与 D1

#### Scenario: 已合并则列出分支

- **WHEN** 提案的 swarm 任务全部 merged
- **THEN** 摘要给出数量与各任务分支

### Requirement: Vault 视图笔记

「触及模块」边的标注 SHALL 描述**证据类型**（来自代码路径 / 来自散文 token / 来自向量相似 /
来自判断层归类），SHALL NOT 用实现细节（如"slug 包含 vs token 重叠"）冒充证据强度。
看起来像路径或文件名的证据 SHALL 标为路径证据，即使匹配是通过 slug token 完成的。

#### Scenario: 代码路径算路径证据

- **WHEN** Impact 段给出 `src/.../HomeworkManagementService.java` 并被 token 匹配到模块
- **THEN** 该边标注为「路径命中」，而不是「token 命中」

### Requirement: Vault 词法检索

判断层的单次采样输出预算 SHALL 由 `Config.decisionMaxTokens` 控制（默认 1024），
SHALL 足以覆盖推理块与工具调用两部分；实现 SHALL NOT 使用会让推理型模型在发出工具调用前
就耗尽预算的固定小值。

#### Scenario: 推理不吞掉答案

- **WHEN** 模型在回答前产生大量推理块
- **THEN** 只要总输出未超预算，工具调用仍能发出；若仍以 `max-tokens` 结束，
  诊断 SHALL 记录该终态以供识别

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

