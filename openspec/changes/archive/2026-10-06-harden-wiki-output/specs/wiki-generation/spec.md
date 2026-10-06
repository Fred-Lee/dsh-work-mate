## MODIFIED Requirements

### Requirement: 项目 wiki 生成

实现 SHALL 提供按项目生成 wiki 的入口（工具与 REST），调用 GitNexus 的 wiki 生成能力，
并把产物目录（`<项目>/.gitnexus/wiki/`，含 `index.html`）与 CLI 摘要回传；
当 GitNexus 桥被配置关闭时 SHALL 返回禁用说明而非报错。

实现 SHALL 在生成结束后核验产物：SHALL 回传已写出的页面数 `pages` 与阅读器是否存在
`complete`；当 CLI 未失败但产物不完整时，SHALL 在 `note` 中明确说明"生成中断"及已写出页数，
SHALL NOT 让调用方把半份产物当成完整 wiki。

#### Scenario: 生成并回传产物路径

- **WHEN** 对已索引项目调用 wiki 生成
- **THEN** 返回 `wikiDir` 与 `indexHtml` 绝对路径，并附带 CLI 输出摘要

#### Scenario: 半份产物被标出

- **WHEN** 生成过程中断（例如 LLM 端点熔断）导致缺少 index.html
- **THEN** 结果 `complete` 为 false，`pages` 为已写出页数，且 `note` 说明生成中断

#### Scenario: LLM 未配置时给出可执行说明

- **WHEN** GitNexus 缺少 provider/key 而生成失败
- **THEN** 返回的 `note` 包含失败原因与配置指引，SHALL NOT 抛未处理异常
