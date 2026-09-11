## 1. 历史存储接口 + 两种实现

- [x] 1.1 在 `packages/orchestrator/src/history/types.ts` 定义 `HistoryStore` 接口与共享事件类型(`ExecutionEvent`,含 `v:1`、`seq`、`ts`、`taskId`、`kind`、`agent?`、`payload`)
- [x] 1.2 在 `packages/orchestrator/src/history/in-memory.ts` 实现 `InMemoryHistoryStore`(每任务事件环 + 任务摘要 map)
- [x] 1.3 在 `packages/orchestrator/src/history/jsonl.ts` 实现 `JsonlHistoryStore`:写 `~/.helmsman/history/tasks/<taskId>.jsonl`(逐行追加、按行原子写、容忍撕裂尾部),并 upsert `~/.helmsman/history/tasks.json`
- [x] 1.4 实现读取 API:`listTasks()`、`getTask(taskId)`、`eventsAfter(taskId, seq)`;`seq >= 最新` 时返回空;命中已清理区间时返回/抛出 `history-pruned`
- [x] 1.5 实现 `prune(opts)`:按保留条数 + 每任务事件行数上限清理,只触碰 `~/.helmsman/history/`
- [x] 1.6 单测 JSONL 存储:追加/读取往返、撕裂尾部恢复、cursor 分页、清理 + 旧 cursor 的 `history-pruned`,全部在临时 `HELMSMAN_HOME` 下

## 2. 把持久化接入编排引擎与插件

- [x] 2.1 给 `OrchestratorCore` 选项加可选 `history: HistoryStore`(默认内存);在 `packages/orchestrator/src/core.ts` 既有 `notify()`/`touch()` 汇聚点内做生命周期快照持久化 + `task-state` 事件追加
- [x] 2.2 在 `packages/orchestrator/src/core.ts` 的 `runAgent` 中,随适配器日志行流入追加持久化 `agent-log` 事件(保留既有 `run.log` 累积逻辑不变)
- [x] 2.3 在类型与 `index.ts` 的 `OrchestratorService` 上暴露 `history.getEvents(taskId, after)` / `history.getTask`(不破坏既有工具输出)
- [x] 2.4 在 `packages/orchestrator/src/index.ts` 的插件 `apply()` 里装配 `JsonlHistoryStore`(`~/.helmsman/history/`),透传 `retention` 配置;插件启动时执行一次 `prune`
- [x] 2.5 确保既有引擎测试原样通过(内存默认)

## 3. REST 时间线 API + SSE 端点

- [x] 3.1 在仪表盘路由(`packages/ui-dashboard/src/api.ts`)加 `GET api/task/:id/events?after=<seq>`,返回有序事件 + 下一个 cursor + `history-pruned` 信号
- [x] 3.2 在 `packages/ui-dashboard/src/api.ts` 加 `GET api/task/:id/stream?after=<seq>` SSE 处理器:先订阅后重放的缓冲(D4)、每 15 秒心跳、终态/断开时关闭
- [x] 3.3 在 `packages/ui-dashboard/src/index.ts` 的前缀处理器里暴露这两条路由(保留 query string;确保 `text/event-stream` 头 + 禁止缓冲 pragma)
- [x] 3.4 路由器单测:用假存储覆盖事件分页与流的重放/心跳/关闭语义(`packages/ui-dashboard/src/api.test.ts`)
- [x] 3.5 为 SPA 增加 `ExecutionEvent` 共享形态的 `event.ts` 客户端类型

## 4. ui-dashboard SPA 切换为带 cursor 续传的 SSE

- [x] 4.1 在 `packages/ui-dashboard/src/client/api.ts` 加 `subscribeTaskStream(taskId, lastSeq)` EventSource 封装(手动退避重连、收到消息推进 cursor)
- [x] 4.2 把 `packages/ui-dashboard/src/client/App.tsx` 中按 agent 的日志轮询与实时状态轮询替换为流;粗粒度 `api/state` 轮询仅保留用于发现新任务 + 作为重连兜底
- [x] 4.3 渲染"重连中/重新同步"指示器;服务端报清理时显示 `history-pruned` 横幅
- [x] 4.4 加一个 React 组件测试覆盖流驱动日志追加与重连路径(jsdom + 假 EventSource)

## 5. 测试 + 文档

- [x] 5.1 编排器集成测试:用 JSONL 存储跑一个任务,用同一存储"重启"core,断言终态与完整事件时间线被重新加载
- [ ] 5.2 真实 profile 冒烟(手动,记录在 commit message):SSE 实时跟踪一次在跑的舰队运行;杀掉重连后无重复;清理后行为仍正确
- [x] 5.3 更新 `docs/ARCHITECTURE.md`(把"轮询取舍、以后加 SSE"改为流式设计 + 存储布局)与 `docs/USAGE.md`(新端点、保留配置)
