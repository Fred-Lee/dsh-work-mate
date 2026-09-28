# Add Knowledge Bridge

## Why

里程碑三：把 GitNexus 代码知识图谱与 WeKnora 文档检索接进 Agent 工具面，让 Agent
能回答「这套流程怎么走的」「相关文档怎么说」（设计文档 §7 里程碑三）。

## What Changes

1. **GitNexus CLI 桥接**（design D5 修正）：设计文档假设的 `@deepseek-ai/dsh-mcp-client`
   在本机生态不存在（profile 只有版本不兼容的 `dsh-mcp-adapter`），而本机 GitNexus
   CLI 原生提供 `query` / `context` / `impact` / `detect-changes` / `analyze`
   子命令——直接 `execFile('gitnexus', …)`（argv 数组、cwd=projectRoot、超时），
   比引入 MCP 客户端插件链路更短、可测。工具返回 CLI 文本输出（模型可读）。
2. **WeKnora HTTP 客户端**：`Config.weknoraBaseUrl` 非空时启用 `workmate_knowledge_search`
   的文档检索分支；POST JSON + 超时 + 非 2xx 降级为错误信息，不抛栈。默认空 = 禁用。
3. **工具注册**：`workmate_knowledge_query`（GitNexus：query/context/impact 三个
   action）、`workmate_knowledge_search`（WeKnora 检索，禁用时返回说明）。两个工具
   都要求 projectRoot 可解析——知识检索永远是项目侧动作。

## Capabilities

### 新增能力

- `knowledge-bridge`：GitNexus CLI 与 WeKnora HTTP 的统一检索工具面。

## Impact

- `src/features/knowledge-bridge/` 新增 gitnexus.ts / weknora.ts；
  `src/index.ts` 注册两个工具；无新增 npm 依赖（子进程 + 内置 fetch）。
- 外部依赖：本机 `gitnexus` CLI（已在 PATH，实测子命令齐全）与目标仓库已索引；
  WeKnora 可选。
