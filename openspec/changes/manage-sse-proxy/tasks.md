# Tasks — Manage SSE Proxy

- [x] 1. `scripts/gitnexus-sse-proxy.mjs`：`/healthz` + EADDRINUSE 复用语义 + 仅回环监听
- [x] 2. `sse-proxy.ts`：`probeSseProxy()` / `ensureSseProxy()`（复用 / 不一致拒绝 / detached 启动 + 轮询）
- [x] 3. 配置：`gitnexusSseProxyEnabled` / `...Port` / `...Upstream`
- [x] 4. 接入 `workmate_wiki_generate` 与 `POST /api/wiki`，回传 `sseProxy.status`
- [x] 5. `package.json` 的 `files` 加入该脚本
- [x] 6. 测试：禁用不动作、启动后健康、二次调用复用、upstream 不一致拒绝
- [x] 7. 文档：README（§0.9 说明代理托管 + 配置表）+ AGENTS 里程碑
- [x] 8. 验证：typecheck / test / build / verify + 真机
