## Why

Helmsman 的编排结果目前是瞬态的:任务记录和使用计数只存在于 orchestrator 进程的内存 `Map` 里,宿主(host)一重启,全部运行历史就无声消失;仪表盘也只能以 1.5–5 秒的间隔轮询日志。MOVO 平台对这个问题验证过一套更强的契约:持久化、带版本号的执行事件时间线(每个事件落盘一次、可按 cursor 重放)+ 带 cursor 续传的 SSE 推送通道,让用户可以实时跟踪一次在跑的舰队(fleet)任务、网络抖动后重连、以及宿主重启后还能审计当时发生了什么。本次变更把"任意一次运行都可观察、可审计"的能力带给 Helmsman,同时不引入任何基础设施——保持单用户、文件系统存储、核心引擎框架无关。

## What Changes

- 将每个任务的生命周期记录与按 agent 划分的事件时间线持久化到 `HELMSMAN_HOME` 之下(追加式 JSONL + 定期快照),取代内存 `Map`;采用带版本号的事件 schema 和明确的保留/清理(retention/prune)策略。
- 任务列表和任务详情改为从磁盘读取;宿主停止时仍在执行中的任务,重启后可显示其最后已知状态(不再无声丢失)。
- 新增带版本号、基于 cursor 分页的 HTTP 时间线 API(`GET /api/task/:id/events?after=<cursor>`),构建在现有 `helmsman/task-updated` cordis 事件之上,而不是替换它。
- 新增 SSE 端点(`GET /api/task/:id/stream`),按持久化顺序推送事件行并带心跳;ui-dashboard 客户端从轮询切换为 SSE,断线后自动重连并依据 cursor 重新同步。
- 引擎核心保持框架无关:存储是注入式接口(单测仍默认用内存实现);不引入任何新运行时依赖或数据库服务器。
- **BREAKING**(仅内部 API):任务/时间线读取现在要求存储后端已完成初始化;orchestrator 服务负责在启动时装配。

## Capabilities

### New Capabilities
- `execution-history`:任务生命周期记录与按 agent 划分的事件时间线的持久化存储与 cursor 分页检索,含保留/清理与跨宿主重启的"最后已知状态"恢复。
- `execution-streaming`:运行中任务的实时事件服务端推送流,含心跳、客户端重连与按 cursor 重新同步语义。

### Modified Capabilities
<!-- 暂无——openspec/specs/ 中还没有既有 spec;本变更为这些领域建立首批 spec。 -->

## Impact

- `packages/orchestrator`:内存任务/用量 `Map`(见 `core.ts`、`index.ts`、`types.ts`)替换为注入式存储适配器;复用现有 `helmsman/task-updated` 事件作为持久化触发点。
- `packages/ui-dashboard`:REST `api.ts` 新增时间线/cursor 与 SSE 端点;`client/App.tsx` 的轮询逻辑(`useReducer`,1.5 s/5 s 间隔)切换为 SSE + 重新同步。
- 新增存储模块(JSONL 事件日志 + 快照),放在 `packages/orchestrator` 内或独立的小型共享助手;单元测试使用内存适配器。
- 状态存放位置:`~/.helmsman/`(与 worktrees/topologies 一致);不新增服务、不引入数据库、除既有 DSH loopback web 服务器外不新增网络。
- 文档:`docs/ARCHITECTURE.md`(轮询权衡部分)、`docs/USAGE.md`。
