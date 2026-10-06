## ADDED Requirements

### Requirement: 项目 wiki 生成

实现 SHALL 提供按项目生成 wiki 的入口（工具与 REST），调用 GitNexus 的 wiki 生成能力，
并把产物目录（`<项目>/.gitnexus/wiki/`，含 `index.html`）与 CLI 摘要回传；
当 GitNexus 桥被配置关闭时 SHALL 返回禁用说明而非报错。

#### Scenario: 生成并回传产物路径

- **WHEN** 对已索引项目调用 wiki 生成
- **THEN** 返回 `wikiDir` 与 `indexHtml` 绝对路径，并附带 CLI 输出摘要

#### Scenario: LLM 未配置时给出可执行说明

- **WHEN** GitNexus 缺少 provider/key 而生成失败
- **THEN** 返回的 `note` 包含失败原因与配置指引，SHALL NOT 抛未处理异常

### Requirement: 索引新鲜度如实报告

实现 SHALL 在生成前（未被要求先重跑 analyze 时）以只读方式探测索引新鲜度，
并把 `stale` 如实写入结果；SHALL NOT 在调用方未要求时自动执行全量重索引。

#### Scenario: 索引过期时提示而不擅自重跑

- **WHEN** 索引落后于当前提交且调用方未要求 analyze
- **THEN** 结果含 `stale: true`，且未执行 analyze

#### Scenario: 显式要求先重建

- **WHEN** 调用方传入 `analyze: true`
- **THEN** 先执行 gitnexus analyze 再生成 wiki，结果标记已重建
