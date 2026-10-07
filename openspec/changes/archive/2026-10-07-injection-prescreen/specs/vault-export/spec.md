## MODIFIED Requirements

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
