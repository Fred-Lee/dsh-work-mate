# wiki-generation Specification

## Purpose
TBD - created by archiving change add-wiki-generation. Update Purpose after archive.
## Requirements
### Requirement: 项目 wiki 生成

实现 SHALL 提供按项目生成 wiki 的入口（工具与 REST），调用 GitNexus 的 wiki 生成能力，
并把产物目录（`<项目>/.gitnexus/wiki/`，含 `index.html`）与 CLI 摘要回传；
当 GitNexus 桥被配置关闭时 SHALL 返回禁用说明而非报错。

实现 SHALL 解析并回传 CLI 自身的结论：是否为"已是最新"、模式、CLI 报告的页数与耗时，
以及本次调用的实测耗时；当 CLI 报告"已是最新"时，实现 SHALL 视为成功
（SHALL NOT 因产物未被重写而标记为陈旧或失败），并 SHALL 说明"未重新生成、可用 --force 强制"。

#### Scenario: 已是最新时说明清楚

- **WHEN** CLI 输出 `Wiki is already up to date.`
- **THEN** 结果为成功、`upToDate` 为 true，文本说明本轮未重新生成并提示 `--force`

#### Scenario: 真正生成时给出模式与耗时

- **WHEN** CLI 输出 `Mode: full` 与 `Pages: N`
- **THEN** 结果含 `mode`、`reportedPages` 与实测耗时，文本写明"已生成 / 更新（CLI 模式：full）"

### Requirement: 索引新鲜度如实报告

实现 SHALL 在生成前（未被要求先重跑 analyze 时）以只读方式探测索引新鲜度，
并把 `stale` 如实写入结果；SHALL NOT 在调用方未要求时自动执行全量重索引。

#### Scenario: 索引过期时提示而不擅自重跑

- **WHEN** 索引落后于当前提交且调用方未要求 analyze
- **THEN** 结果含 `stale: true`，且未执行 analyze

#### Scenario: 显式要求先重建

- **WHEN** 调用方传入 `analyze: true`
- **THEN** 先执行 gitnexus analyze 再生成 wiki，结果标记已重建

