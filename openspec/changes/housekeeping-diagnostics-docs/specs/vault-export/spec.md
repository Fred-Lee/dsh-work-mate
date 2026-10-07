## MODIFIED Requirements

### Requirement: 项目 wiki 导出到 vault

判断层的诊断记录 SHALL 区分"适配器未产生任何流块"（`chunksSeen === 0`，记为
`empty stream (no chunk at all)`）与"产生了块但没有工具调用"（记为
`no tool-call emitted (model answered in text?)`），SHALL 记录 `chunksSeen` 字段。

#### Scenario: 空流可辨认

- **WHEN** 适配器返回的流里没有任何块
- **THEN** 诊断记录 `chunksSeen: 0` 且 failure 为 `empty stream (no chunk at all)`
