# workbench-panel Delta

## ADDED Requirements

### Requirement: 看板列与状态标签的对照可查

面板的看板 SHALL 把八态映射到固定五列（方案 / 待确认 / 执行中 / 待合并 / 已归档），
该映射 SHALL 在随包的文档（README）中有对照表，SHALL NOT 要求读者查源码才能建立映射。
每个列头 SHALL 通过 `title` 说明它覆盖哪些状态。

`reviewing` SHALL 落在「待确认」列（G2 等待人确认方案），`merging` 与 `archiving`
SHALL 落在「待合并」列（G5 等待人放行），`ready` 与 `implementing` SHALL 落在「执行中」。

#### Scenario: 等待人确认的提案一眼可见

- **WHEN** 一个提案处于 `reviewing`
- **THEN** 它出现在「待确认」列而非「方案」列

#### Scenario: 列与状态的对应可查

- **WHEN** 读者想知道「方案」列包含哪些状态
- **THEN** README 的对照表能查到，且面板列头的 title 也写明

### Requirement: 门禁理由的收集范围

面板 SHALL 仅在进入受 G5 门禁的状态（`merging` / `archiving`）时收集批准理由并写入
审批记录；G2 的方案确认（`reviewing → ready`）SHALL NOT 要求输入理由——`planHash`
即为确认凭据。文档 SHALL 按此区分表述，SHALL NOT 把两者混为一句。

#### Scenario: G2 确认不需要理由

- **WHEN** 人在面板点「确认方案」
- **THEN** 无需输入任何文本即完成确认，审批记录带 planHash 而不带 rationale

#### Scenario: G5 放行要求理由

- **WHEN** 人在面板点「推进到 待合并」
- **THEN** 面板提示输入批准理由，并写入审批记录与事件流
