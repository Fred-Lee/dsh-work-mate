## MODIFIED Requirements

### Requirement: 流水线视图与最小人工动作

面板 SHALL 以流水线呈现提案：`方案 → 待确认 → 执行中（待回答/待验收）→ 待合并 → 已归档`，
并显示每个提案当前位置与进度；状态 SHALL 来自服务端证据派生结果，SHALL NOT 由前端本地
推断或要求用户逐态点击。

正常路径 SHALL 只提供两个主操作：「确认方案」（G2）与「合并并归档」（G5）。面板 SHALL NOT
把 `mode=advance` 的逐态推进作为卡片主按钮；手动推进/回退 SHALL 收进「更多」或详情操作，
并标注为覆盖操作。

详情 SHALL 展示证据：工件完整性、`planHash`、Ticket 阶段与目录、审查与测试结论、各 target
的合并状态；方案改动导致 `planHash` 失效时 SHALL 在卡片上提示「需重新确认」。

#### Scenario: 提案完成后自动进入待确认

- **WHEN** 某提案的 OpenSpec 工件齐备并通过 validate
- **THEN** 卡片自动出现在「待确认」列，并显示「确认方案」按钮，无需人工推进

#### Scenario: 执行中不再逐态点击

- **WHEN** 方案已确认、Ticket 正在执行
- **THEN** 卡片显示执行中与待回答/待验收，不出现「推进到 implementing/merging」按钮

#### Scenario: 方案改动提示重确认

- **WHEN** 已确认的提案修改了方案工件
- **THEN** 卡片回到「待确认」并提示「方案已变更，需重新确认」
