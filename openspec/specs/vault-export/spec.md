# vault-export Specification

## Purpose
TBD - created by archiving change export-wiki-to-vault. Update Purpose after archive.
## Requirements
### Requirement: 项目 wiki 导出到 vault

归档编排读取验收证据（`tasks.md` / `review.md`）时 SHALL 解析 change 目录：
先看活动路径 `changes/<id>/`，不存在时 SHALL 回退到 `changes/archive/<date>-<id>/`，
使归档后的复查与重跑仍能读到证据。编排结果 SHALL 明确报告本次是否由 `force` 跳过门禁（`forced`）。

#### Scenario: 归档后仍读得到证据

- **WHEN** change 目录已位于 `changes/archive/<date>-<id>/`
- **THEN** 编排仍能读到 `tasks.md` 与 `review.md`（审查分级据此执行）

#### Scenario: force 可见

- **WHEN** 调用方以 `reviewGate: false` 或 `tasksGate: false` 运行归档
- **THEN** 返回结果 `forced: true`

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

判断层开启时，代理人在风险尚未判定前 SHALL NOT 推进到受 `Config.highRiskExtraGates` 保护的状态；
被拒绝时 SHALL 给出可操作提示（先调用 `workmate_assess_risk`），并 SHALL 记录一条 `gate-failed`
事件（gate 名为 `risk-unassessed`）。人类操作者与判断层关闭的情形 SHALL 不受影响。

#### Scenario: 未判风险被挡

- **WHEN** 判断层开启、highRiskExtraGates 含 implementing、提案无 risk，且由 agent 推进
- **THEN** 抛出含"必须先判定风险"的错误，并记录 gate-failed 事件

#### Scenario: 判断层关闭时不变

- **WHEN** 判断层关闭
- **THEN** 该守卫不生效，行为与之前一致

