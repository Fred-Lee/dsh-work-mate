## MODIFIED Requirements

### Requirement: Vault 词法检索

使用模型重排时，实现 SHALL 为**每一次**重排尝试写入一条 `decision` 事件
（含 `node: 'search-rerank'`、`action`、`choice`、`certainty`、`provider`），
在模型弃权或调用失败时 SHALL 记录 `action: 'abstain'`。
实现 SHALL NOT 让"是否调用了重排、选中了第几位"只能靠输出顺序猜测。

#### Scenario: 重排被观测

- **WHEN** 启用重排并执行一次语义检索
- **THEN** 事件流出现 `search-rerank` 记录；选中首位时 `choice` 为 `"1"` 且命中顺序不变
