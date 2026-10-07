## MODIFIED Requirements

### Requirement: 项目 wiki 导出到 vault

判断层在**未发出调用**时（路由无法解析）SHALL 同样留下诊断记录，包含期望的 provider/model
与宿主实际注册的 provider 列表（id、name、模型数量、首个模型样例）。
provider 匹配 SHALL 依次尝试精确 id/name、包含式匹配，最后回退到首个已注册 provider；
任何回退 SHALL 记录在案，SHALL NOT 静默改用其他 provider。

#### Scenario: 没调用也要留痕

- **WHEN** 配置的 provider 名与宿主注册项不一致
- **THEN** 诊断出现 `failure: 'no route resolved (call not attempted)'` 记录，含真实 provider id 列表；
  且按回退规则仍会尝试调用（若存在任何 provider）

#### Scenario: 零 provider 不崩

- **WHEN** 宿主没有注册任何 provider
- **THEN** 判断返回无结论且不抛错
