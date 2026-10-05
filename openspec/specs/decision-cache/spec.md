# decision-cache Specification

## Purpose
TBD - created by archiving change add-decision-cache. Update Purpose after archive.
## Requirements
### Requirement: 判断缓存

实现 SHALL 为判断结果提供缓存：键 SHALL 由 `node`、`state`、`question`、选项集合、
provider、model 与采样数共同决定；读取失败或文件损坏 SHALL 视为空缓存并继续判断
（fail-open）；写入 SHALL 采用原子写并 SHALL 遵守 `Config.decisionCacheMax` 上限；
仅模型 provider（`agent` / `jev`）的回答 SHALL 被缓存，确定性 provider SHALL NOT 被缓存。

#### Scenario: 同题复用

- **WHEN** 同一题目（state/选项/provider/model 均未变）再次被问到
- **THEN** 直接复用上次结论且 outcome 标记 `cached: true`，不再调用模型

#### Scenario: state 变化必须重判

- **WHEN** 题目文本变化（新的决策或新的 diff）
- **THEN** 缓存不命中，照常调用 provider

#### Scenario: 缓存损坏不影响判断

- **WHEN** 缓存文件内容无法解析
- **THEN** 视为空缓存继续判断，判断结果不受影响

#### Scenario: 关闭开关即直连

- **WHEN** `Config.decisionCacheEnabled` 为 false
- **THEN** 每次都调用 provider，不写也不读缓存

