## ADDED Requirements

### Requirement: 注入判定在所有创建入口生效

创建提案的**任何**入口（工具与 REST）SHALL 在启用判断层时执行 `injection-risk` 判定，
SHALL 写入对应的 `decision` 事件，并 SHALL 在判定为 `risky`（或调用方声明 provenance）时
把 `provenance.untrusted` 落到提案记录上。入口之间 SHALL NOT 存在"有判定/无判定"的行为差异。

#### Scenario: 工具入口同样受保护

- **WHEN** 通过 `workmate_proposal_create` 创建带可疑外部文本的提案且判断层已启用
- **THEN** 产生 `injection-risk` 判定与 `decision` 事件；判定为 `risky` 时提案带 `untrusted` 标记
