## MODIFIED Requirements

### Requirement: 归档可回退

提案生命周期 SHALL 全程可逆：`start`（draft→executing）↔ `stop`（executing→draft）、
`archive`（executing→archived，编排）↔ `reopen`（archived→executing，目录搬回）。
`stop` SHALL 只做状态回退（openspec 目录不动）；对非 executing 提案的 stop SHALL
被拒绝；对非 archived 提案的 reopen SHALL 被拒绝。归档编排 SHALL 对每个根可解析的
关联项目逐一执行 openspec archive。Agent 工具 `workmate_proposal_archive` SHALL
提供 `mode` 参数（archive/start/reopen/stop）覆盖全部四个流转方向，旧布尔 `start`
参数保持兼容。

#### Scenario: 执行中退回提案

- **WHEN** 对 executing 提案调用 stop（REST 或工具 mode=stop）
- **THEN** 状态回到 draft，openspec change 目录保持原位可继续编辑

#### Scenario: 四向流转工具面

- **WHEN** Agent 分别以 mode=start/archive/reopen/stop 调用工具
- **THEN** 四种流转各自生效；非法方向（如 draft 直接 archive）返回可读错误且状态不变

#### Scenario: 归档发现问题后回退

- **WHEN** 对 archived 提案调用 reopen
- **THEN** 状态回到 executing、各项目 change 目录从 archive/ 搬回 changes/ 可继续编辑
