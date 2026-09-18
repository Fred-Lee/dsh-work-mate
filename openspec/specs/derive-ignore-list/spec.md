# derive-ignore-list Specification

## Purpose
TBD - created by archiving change persist-derive-ignores. Update Purpose after archive.
## Requirements
### Requirement: 忽略清单按项目群持久化
系统 SHALL 支持把推导候选按服务对(`from→to`)加入忽略清单,清单 SHALL 按**项目群**持久化于
`HELMSMAN_HOME` 下(`~/.helmsman/derive-ignores.json`,原子 tmp+rename 写),并 SHALL 在宿主重启后仍生效。
忽略清单 SHALL NOT 影响已落库的依赖边、声明文件或任何既有数据。

#### Scenario: 忽略跨会话生效
- **WHEN** 用户忽略某候选后重启宿主,再次推导
- **THEN** 该候选不再出现在结果中

#### Scenario: 忽略不触碰既有数据
- **WHEN** 忽略一条候选
- **THEN** 依赖图、声明文件、拓扑文件均不变(推导本就只读)

### Requirement: 推导与漂移共同尊重忽略清单
推导 SHALL 在候选层应用排除:被忽略的服务对 SHALL NOT 出现在候选结果中,结果 SHALL 回显 `excluded`
计数。漂移核对复用同一推导路径,其「未声明」清单 SHALL 同样不含被忽略的候选。

#### Scenario: 被忽略的候选不回来
- **WHEN** 忽略 `homework-server→oss` 后再次推导
- **THEN** 该候选不在结果中,`excluded` 计数为 1

#### Scenario: 漂移的未声明清单同步干净
- **WHEN** 漂移核对默认推导路径下某候选已被忽略
- **THEN** 该对不出现在漂移的「未声明」组

### Requirement: 可恢复
系统 SHALL 提供恢复动作:逐条恢复被忽略的候选,或一次性全部恢复;恢复后该候选 SHALL 随下次推导重新出现。

#### Scenario: 逐条恢复
- **WHEN** 用户恢复 `homework-server→oss`
- **THEN** 下次推导该候选重新出现

#### Scenario: 全部恢复
- **WHEN** 用户选择恢复全部
- **THEN** 该项目群的忽略清单清空,下次推导不再过滤

### Requirement: 界面呈现
「忽略」 SHALL 落库并即时把候选移出当前清单;结果区 SHALL 显示「已忽略 (N)」的折叠清单(含证据摘要)
供恢复;N 为零或无该能力(旧版服务)时 SHALL NOT 显示该区。

#### Scenario: 忽略后的可见性
- **WHEN** 用户忽略若干候选
- **THEN** 它们立即从候选清单消失,并在「已忽略」区可查、可恢复

