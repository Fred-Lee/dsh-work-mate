# vault-export Specification

## Purpose
TBD - created by archiving change export-wiki-to-vault. Update Purpose after archive.
## Requirements
### Requirement: 项目 wiki 导出到 vault

判断层的诊断记录 SHALL 区分"适配器未产生任何流块"（`chunksSeen === 0`，记为
`empty stream (no chunk at all)`）与"产生了块但没有工具调用"（记为
`no tool-call emitted (model answered in text?)`），SHALL 记录 `chunksSeen` 字段。

#### Scenario: 空流可辨认

- **WHEN** 适配器返回的流里没有任何块
- **THEN** 诊断记录 `chunksSeen: 0` 且 failure 为 `empty stream (no chunk at all)`

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

判断层解析模型答复时 SHALL 以**参数 schema 与选项枚举**为准，SHALL NOT 仅因工具名不同而丢弃
工具调用增量；当出现多个工具名时 SHALL 优先使用约定的 `answer`。
诊断记录 SHALL 包含各块类型计数（`chunkTypes`）与出现过的工具名（`toolNames`），
并 SHALL 把推理块计入内容长度。

#### Scenario: 异名工具调用被采信

- **WHEN** 模型以 `choose_option` 之类的名字发出参数为 `{"choice": "<枚举值>"}` 的工具调用
- **THEN** 该答案被采信，不记为"模型未作答"

#### Scenario: 诊断可辨

- **WHEN** 一轮调用仍无有效答案
- **THEN** 诊断含 chunkTypes 与 toolNames，可区分"只吐推理块"与"用了别的工具名"

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

