## ADDED Requirements

### Requirement: Wiki 面板

客户端 SHALL 提供一个 Wiki 面板，使用户无需命令行即可：把指定项目根的 wiki 导出到 vault，
并按关键词检索 vault；检索结果 SHALL 显示 `文件:行号` 与片段，并 SHALL 允许一键复制该位置。
面板 SHALL 复用插件既有的 `/workmate/api/wiki/*` 端点，SHALL NOT 引入第二套服务端逻辑；
面板 SHALL 在错误时显示服务端返回的状态与正文，不得静默失败。

#### Scenario: 导出

- **WHEN** 在面板填入项目根并点击「导出到 vault」
- **THEN** 显示模块/页/迭代数与归类统计（以及是否已提交）

#### Scenario: 检索

- **WHEN** 输入关键词并选择词法或语义后点击「检索」
- **THEN** 列出命中位置与片段；点击某条复制其 `文件:行号`

### Requirement: 面板长动作的可见反馈

面板发起 `推进` / `完成归档` 时 SHALL 在按钮上显示进行中文案并禁用重复点击；
成功时 SHALL 在提案卡片上显示结果（归档完成，且当编排报告 `forced` 时标注已跳过审查门）；
失败时 SHALL 把服务端返回的错误显示在卡片上，SHALL NOT 只提示在面板其他位置。

#### Scenario: 归档进行中

- **WHEN** 用户点击「完成归档」
- **THEN** 按钮变为「归档中…（编排在跑）」且不可重复点击

#### Scenario: 归档完成可见

- **WHEN** 编排返回成功
- **THEN** 卡片出现「✅ 归档完成」，`forced: true` 时附带「force：已跳过审查门」

#### Scenario: 失败可见

- **WHEN** 服务端返回错误
- **THEN** 卡片出现以 ❌ 开头的错误文案

### Requirement: 面板动作不随详情失败消失

提案卡片上的归档动作 SHALL 仅在提案状态为 `archiving` 时渲染，SHALL NOT 依赖详情接口成功；
详情加载失败时 SHALL 在卡片上显示失败原因并提供「重新加载」。

#### Scenario: 详情失败仍有出路

- **WHEN** 提案的项目根已不存在导致详情加载失败且状态为 archiving
- **THEN** 卡片仍显示「完成归档 / 强制归档」，并显示失败原因
