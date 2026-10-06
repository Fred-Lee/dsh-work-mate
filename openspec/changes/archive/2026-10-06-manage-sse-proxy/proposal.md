# Manage the SSE Normalize Proxy (on-demand, reusable, no orphans)

## Why

`gitnexus wiki` 的流式解析器要求 `data: `（冒号后带空格），而某些自建网关（本次实测
`esp.xkw.cn`）输出 `data:{…}`（无空格）→ 所有分片被跳过 → 报
`LLM returned empty streaming response`。上次解决方式是**手工**在
`~/.workmate-tools/` 放一个代理脚本并 `node` 起一个游离进程——用户随即质疑两点：
**"不必起这个进程吧"** 与 **"这个进程有复用吗"**。这两点都成立：

- 手工起的进程**没有任何生命周期归属**：谁起的、跑没跑、下次要不要重起，全靠人记；
- 也没有复用判定：再次运行会撞 `EADDRINUSE`，或者干脆再起一个。

## What Changes

1. **代理脚本进仓库**：`scripts/gitnexus-sse-proxy.mjs`，新增 `GET /healthz`
   （回报 `service`/`pid`/`upstream`），并在 `EADDRINUSE` 时**按复用退出**而不是报错。
2. **按需托管**（`src/features/knowledge-bridge/sse-proxy.ts`）：
   `ensureSseProxy()` 先探 `/healthz` ——
   - 已在运行且 `upstream` 一致 → **复用**（不新起进程）；
   - 已在运行但 `upstream` 不一致 → 拒绝并说明（避免把请求转发到错误网关）；
   - 没在运行 → `spawn(process.execPath, [脚本], {detached, stdio:'ignore'}).unref()`，
     轮询健康检查直到就绪或超时。
   代理**只监听回环**，不暴露到局域网。
3. **接入 wiki 入口**：`workmate_wiki_generate` 与 `POST /api/wiki` 在调用 CLI 前
   `ensureSseProxy()`，结果里回传 `sseProxy.status`（`disabled|reused|started|failed`）；
   代理不可用时**不阻断**（CLI 可能本来就直连），只如实标注。
4. **配置**：`gitnexusSseProxyEnabled`（默认 false）/ `gitnexusSseProxyPort`（8787）/
   `gitnexusSseProxyUpstream`（真实网关的 `…/chat/completions` 地址）。

## Capabilities

### 新增能力

- `sse-proxy`：按需启动 + 健康探测 + 复用的 SSE 前缀归一代理托管。

## Impact

- 新增 `scripts/gitnexus-sse-proxy.mjs`（并加入 `package.json` 的 `files`，保证安装后存在）、
  `src/features/knowledge-bridge/sse-proxy.ts`、配置三项、工具/REST 回传字段。
- **默认关闭**：不配置就与现在完全一致（直连网关）。
- 进程归属清晰：由插件按需保证"在跑"，不再需要人工起游离进程；也不再重复监听同一端口。
