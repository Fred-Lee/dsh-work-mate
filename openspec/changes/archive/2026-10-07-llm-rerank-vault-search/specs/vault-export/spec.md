## MODIFIED Requirements

### Requirement: Vault 词法检索

在启用 `Config.wikiVaultRerank` 且判断层可用时，语义检索 SHALL 允许用模型对**召回候选**做重排：
模型只在给定候选内选一个最相关者并置顶，SHALL NOT 改变候选集合；
重排结果 SHALL 在说明中标注"首选原第 N 位"。
当模型弃权、越界或调用失败时，实现 SHALL 保持召回顺序，SHALL NOT 丢弃任何命中。

#### Scenario: 模型选中候选

- **WHEN** 重排器返回候选序号 k（0<k<n）
- **THEN** 该候选移到首位，其余保持相对顺序，说明里注明原来位置

#### Scenario: 弃权或异常

- **WHEN** 重排器返回 undefined 或越界序号
- **THEN** 命中顺序与召回结果完全一致，说明中不出现重排字样
