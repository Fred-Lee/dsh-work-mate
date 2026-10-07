## MODIFIED Requirements

### Requirement: 判断层在所有创建入口生效

判断层解析模型路由时 SHALL 生成**有序候选列表**（精确 id/name 优先，其余按注册顺序），
SHALL 逐个尝试直到某条路由给出答案；单条路由不可用（账号登录要求、传输失败、空流等）
SHALL NOT 导致整个判断失败，且每次失败 SHALL 留下诊断记录。
当所有候选都失败时，实现 SHALL 返回无结论且不抛错。

#### Scenario: 坏路由不拖死判断

- **WHEN** 首选 provider 返回 `ACCOUNT_SIGN_IN_REQUIRED` 而次选 provider 正常
- **THEN** 判断返回次选 provider 的答案（`provider: 'agent'`，含所用模型）

#### Scenario: 精确匹配优先

- **WHEN** 配置的 provider 存在且可用
- **THEN** 只调用该 provider，不尝试其他候选
