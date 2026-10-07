# vault-export Specification

## Purpose
TBD - created by archiving change export-wiki-to-vault. Update Purpose after archive.
## Requirements
### Requirement: 项目 wiki 导出到 vault

`classify` 诊断中的 `pathMatched` SHALL 使用与迭代笔记渲染**完全相同**的路径判据
（模块 slug 包含或 slug token 重合），SHALL NOT 只统计 slug 包含——两处口径不一致会虚高
向量/判断层的贡献，使"补了几条边"无法核对。

#### Scenario: 口径一致

- **WHEN** 某迭代的 `touches` 里是代码路径（`.../HomeworkManagementService.java`）并由 token 命中模块
- **THEN** 该迭代计入 `pathMatched`，且不出现在 `vectorMatched` / `llmMatched` 里

### Requirement: Vault 视图笔记

「触及模块」边的标注 SHALL 描述**证据类型**（来自代码路径 / 来自散文 token / 来自向量相似 /
来自判断层归类），SHALL NOT 用实现细节（如"slug 包含 vs token 重叠"）冒充证据强度。
看起来像路径或文件名的证据 SHALL 标为路径证据，即使匹配是通过 slug token 完成的。

#### Scenario: 代码路径算路径证据

- **WHEN** Impact 段给出 `src/.../HomeworkManagementService.java` 并被 token 匹配到模块
- **THEN** 该边标注为「路径命中」，而不是「token 命中」

