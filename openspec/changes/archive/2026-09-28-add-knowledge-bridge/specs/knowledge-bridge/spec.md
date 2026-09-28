## ADDED Requirements

### Requirement: 知识检索工具面

插件 SHALL 注册 `workmate_knowledge_query`（GitNexus CLI：query/context/impact
三个 action，分别映射 `query` / `context` / `impact` 子命令）与
`workmate_knowledge_search`（WeKnora HTTP 检索）。两个工具 SHALL 经子进程 argv
数组或内置 fetch 实现，SHALL 支持超时，任何失败 SHALL 以 `note` 字段返回而不抛栈。
`Config.weknoraBaseUrl` 为空时 `workmate_knowledge_search` SHALL 返回禁用说明；
`Config.gitnexusEnabled` 为 false 时 `workmate_knowledge_query` 同理。

#### Scenario: 对已索引仓库做知识查询

- **WHEN** Agent 在已 `gitnexus analyze` 的项目根上调用 `workmate_knowledge_query`
- **THEN** 返回 CLI 的检索文本输出，可直接被模型阅读

#### Scenario: CLI 缺失或未索引时优雅降级

- **WHEN** 目标机器没有 gitnexus CLI 或项目未索引
- **THEN** 返回值带 `note` 说明失败原因，工具调用本身成功返回

#### Scenario: WeKnora 未配置时明确禁用

- **WHEN** `weknoraBaseUrl` 为空时调用 `workmate_knowledge_search`
- **THEN** 返回禁用说明而不是错误
