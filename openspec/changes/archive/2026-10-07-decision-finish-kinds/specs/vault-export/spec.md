## MODIFIED Requirements

### Requirement: 项目 wiki 导出到 vault

判断层 SHALL 依据宿主 `FinishReason.kind` 判定终态：`stop` / `tool-calls` / `max-tokens`
视为正常结束，`aborted` / `error` 视为失败；失败时 SHALL 保留结构化 `failure` 原文并写入诊断文件。
诊断记录 SHALL 可序列化（不得出现 `[object Object]`）。

#### Scenario: 正常结束不被误判

- **WHEN** 模型发出 `finish:{kind:'tool-calls'}` 且此前有工具调用增量
- **THEN** 返回该答案，不记录失败

#### Scenario: 失败保留原文

- **WHEN** 适配器以 `{kind:'error', failure:{...}}` 结束
- **THEN** 诊断记录含 `finishKind: 'error'` 与结构化 `finishFailure`
