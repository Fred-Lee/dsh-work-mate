## MODIFIED Requirements

### Requirement: 项目 wiki 导出到 vault

判断层 provider SHALL 将宿主归一化的终态 `finish` 块视为失败信号：当终态原因不属于正常停止
（`stop` / `tool-calls` / `end_turn`）时，SHALL 记录该原因；当整轮未出现 `tool-call-delta` 时，
SHALL 记录"模型以文本作答"这一事实。相关记录 SHALL 追加写入 `<DSH home>/workmate/decision-diagnostics.jsonl`
且 SHALL 失败无副作用（诊断不得影响判断结果）。

#### Scenario: 失败必须可复现定位

- **WHEN** 适配器调用失败或被超时中断
- **THEN** 诊断文件出现一条含 `failure` / `finishReason` / `provider` / `model` 的记录，
  且调用方仍按"无结论"处理（不产生边、不写缓存）
