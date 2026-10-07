## MODIFIED Requirements

### Requirement: 项目 wiki 导出到 vault

判断层向宿主发起模型调用时，用户消息的 `content` SHALL 使用内容块数组
（`[{ type: 'text', text }]`，宿主 `TextBlock` 形态），SHALL NOT 传裸字符串——
宿主请求装配与部分适配器会对内容调用 `.some()`。

#### Scenario: 调用形态正确

- **WHEN** 判断层发起一次带工具调用的请求
- **THEN** `messages[0].content` 是数组且首块 `type === 'text'`，适配器不再抛
  `content.some is not a function`
