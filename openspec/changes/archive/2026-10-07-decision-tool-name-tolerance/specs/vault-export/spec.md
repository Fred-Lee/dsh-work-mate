## MODIFIED Requirements

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
