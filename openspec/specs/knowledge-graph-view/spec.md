# knowledge-graph-view Specification

## Purpose
TBD - created by archiving change add-knowledge-graph-view. Update Purpose after archive.
## Requirements
### Requirement: 知识图谱分层视图

面板 SHALL 提供「提案 | 知识图谱」视图切换；图谱视图 SHALL 以
`GET /workmate/api/graph` 为数据源渲染 SVG 分层图——提案节点、项目节点、Git 提交
节点分三列，边 SHALL 标注关系（涉及 / 提交）。数据为空时 SHALL 显示引导文案；
REST 失败 SHALL 显示内联错误。零新增运行时依赖（自绘 SVG）。

#### Scenario: 三层关联渲染

- **WHEN** 存在关联了项目且有 Git 关联提交的提案并带 projectRoot 打开图谱视图
- **THEN** 三列节点可见，提案—项目边标注「涉及」，项目—提交边标注「提交」

#### Scenario: 空数据引导

- **WHEN** 没有任何提案时切换到图谱视图
- **THEN** 显示引导文案而不是空白或报错

