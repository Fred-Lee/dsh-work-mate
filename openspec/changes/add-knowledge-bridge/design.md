# Design — Add Knowledge Bridge

## D1 桥接选型：CLI 直连，不用 MCP（对设计文档 §3.1.3 的修正）

| 项 | 设计文档假设 | 实际（本变更） |
| --- | --- | --- |
| MCP 客户端 | `@deepseek-ai/dsh-mcp-client` 插件 | **不存在**；profile 的 `dsh-mcp-adapter@0.6.3` 与宿主 0.1.7-rc.2 peer 不兼容（真机日志被跳过） |
| GitNexus 接入 | MCP 工具 `mcp__gitnexus__*` | 本机 `gitnexus` CLI 直接 `execFile`（`query`/`context`/`impact`/`detect-changes`/`analyze` 子命令实测在列） |

CLI 直连的代价是放弃宿主 MCP 工具命名空间与权限集成；收益是零插件依赖、可单测
（mock execFile）、失败语义可控。若日后 `dsh-mcp-client` 落地，本模块是唯一替换点。

## D2 超时与降级

CLI 默认 30s 超时（analyze 120s）；WeKnora fetch 默认 10s（AbortSignal）。任何
桥接失败都转化为 `note` 字段返回（含原始错误摘要），绝不抛栈打断 Agent 会话；
`gitnexusEnabled: false` 时直接返回禁用说明。

## D3 WeKnora 接口契约（B 级证据，宽进宽出)

设计文档只说「REST API 端点」。实现为 `POST {base}/api/v1/retrieval/search`，body
`{ query, topK }`，取 `response.data[]` 里 `content`/`contentWith tq` 类字段的
Top-K 片段；字段缺失时原样截断返回前 4000 字符。契约未经真机 WeKnora 验证，标注
B 级（证据等级沿用 DSH-INTEGRATION-NOTES 惯例），接入真实 WeKnora 时修正。
