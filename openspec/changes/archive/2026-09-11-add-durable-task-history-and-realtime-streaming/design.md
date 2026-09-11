## 背景(Context)

编排器(`packages/orchestrator/src/core.ts`)是一个框架无关的引擎,把所有任务记录、各 agent 的运行状态/日志、abort 句柄与用量计数都保存在内存 `Map` 中(`tasks`、`running`、`aborts`、`usage`、`failures`,约第 45–51 行)。它已经通过 `notify()`/`touch()` → `onTaskUpdated` 汇聚了所有变更,插件入口(`packages/orchestrator/src/index.ts`)把它接到 `helmsman/task-updated` cordis 事件上。仪表盘宿主(`packages/ui-dashboard/src/index.ts`)在 DSH 的 `webServer` 上注册了一个前缀路由,并委托给纯 `createApiRouter` 工厂(`src/api.ts`);其 SPA(`client/App.tsx`)每 1.5 秒(执行中)/5 秒(空闲)轮询 `api/state`,并按需请求 `api/task/:id/log`。今天没有任何持久化:重启 = 历史丢失。所有状态都位于 `~/.helmsman/` 下(可用 `HELMSMAN_HOME` 覆盖)。

约束:零一等方运行时依赖、核心引擎框架无关且可单测是项目明确规则;UI 宿主是纯 Node `http` 处理器(无 express);`docs/ARCHITECTURE.md` 已把"以后再加 SSE 端点、不动核心"列为被接受的取舍。

## 目标 / 非目标(Goals / Non-Goals)

**目标:**
- 每条任务生命周期记录与事件在宿主重启后仍然存在,以追加方式存储在既有 `HELMSMAN_HOME` 布局下。
- 只读观察方(仪表盘)可通过 SSE 通道实时跟进一次运行,重连后不丢事件、不重复。
- 持久化/流式都是注入式接口;引擎单元测试继续跑在内存后端上。
- 无新增运行时依赖、无数据库服务器、无账号/鉴权(保持单用户 loopback 模型不变)。

**非目标:**
- 对被打断的任务**继续/恢复执行**——被打断任务只报告最后已知状态。
- 跨进程、跨机器的观察(假定单宿主、单订阅者)。
- 替换 git worktree/merge 机制或 `helmsman/task-updated` 事件(流式是对它的补充)。
- 任务列表/详情/日志之外的历史视图(不做分析报表)。

## 决策(Decisions)

### D1. 存储 = 每任务一个追加式 JSONL + 一个摘要快照文件
每个任务对应 `~/.helmsman/history/tasks/<taskId>.jsonl`,每行一条事件,均为带任务内单调递增 `seq` 的 JSON 对象。任务生命周期摘要统一 upsert 到单个 `~/.helmsman/history/tasks.json` 快照文件,使任务列表一次读取即可加载。

- **理由**:追加式 JSONL 崩溃安全(读到撕裂的尾行直接忽略),暂时不需要 schema 迁移机制,`seq` 直接提供 cursor 语义。快照文件让"重启后列出所有任务"无需扫描全部日志。
- **考虑过的替代**:SQLite 提供查询与索引,但会是本项目第一个原生运行时依赖,违背零依赖规则;每次变更重写单个 `history.json` 最简单,但每次写入是 O(全部历史)且不崩溃安全。故选 JSONL + 快照。

### D2. 持久化挂在既有单一变更汇聚点上触发
`OrchestratorCore` 增加可选 `history` 接口。所有原本调用 `notify()`/`touch()` 的地方,经由该接口(a)upsert 任务生命周期快照,(b)追加一条 `state` 事件;agent 日志行在从适配器流入时追加 `log` 事件。引擎内不散落新的调用点。

- **理由**:`notify` 已经是 UI 侧消费方获知变更的唯一汇聚点;复用它意味着任何路径都不可能因"忘了调用新 API"而绕过持久化。
- **考虑过的替代**:在每个状态迁移处显式 `history.append`——事件种类更精确,但容易漏路径;为可维护性否决。

### D3. 事件 schema 从第一天就带版本号
每条持久化事件携带 `{ v: 1, seq, ts, taskId, kind, agent?, payload }`。`kind` 覆盖 `task-state`、`agent-log`、`agent-attempt`、`run-start`、`run-end`。`seq` 任务内单调递增。REST 查询用 `?after=<seq>`;结果为空表示"没有更新的"。

- **理由**:MOVO 的版本化执行协议(`ExecutionEventV3`、`after_cursor`)是验证过的模式;带 `v` 字段让旧日志能与未来的 schema 升级共存,清理后旧 cursor 读取能返回显式 `history-pruned` 信号。

### D4. SSE 端点先从持久化存储重放,再实时跟踪
`GET api/task/:id/stream?after=<seq>` 先订阅该任务的实时订阅者集合(期间把进来的事件缓冲起来),再从存储中重放 `seq` 之后的事件,合并任何 `seq` 大于重放终点的事件,最后持续实时下发。每 15 秒发一个心跳空行;任务进入终态或客户端断开时关闭。

- **理由**:因为事件是**先持久化再发布**(D2),断线的客户端什么都不会漏:只要记住 cursor,重连 = 重放 + 跟踪。先订阅后重放并用一个小内存缓冲,可消除"读到最后一条持久化 seq"与"挂上实时流"之间的竞态。
- **考虑过的替代**:纯实时通道(重连期间丢事件);或客户端两步走"先 REST 拉缺失、再重开流"(把对账逻辑推到客户端,且两步之间有缺口)。均否决。

### D5. 客户端用带手动 cursor 的 EventSource,并回退到既有轮询
ui-dashboard 的 SPA 为每个活动任务用一条 EventSource 替代日志/状态轮询:打开时上报最后 `seq`;收到消息就推进 `lastSeq`;出错则关闭并按退避策略重连。现有 1.5/5 秒的 `api/state` 轮询仅保留为粗粒度安全网,同时用来发现新任务 id 以订阅。

- **理由**:同源(SPA 与 REST 共用 DSH loopback web 服务器),EventSource 是原生能力且自带缓冲解析;手动重连(而非依赖 EventSource 内建重连)是为了携带 cursor。
- **考虑过的替代**:WebSocket——一旦有了 cursor 续传就不需要;保持传输简单。用原生 fetch-stream 读取器——这里没有额外收益,反而代码更多。

### D6. 保留默认值与清理
保留策略进入 orchestrator 插件配置(`retention`):保留最近 N 个任务记录与事件日志,并按每任务事件行数上限(如每任务最近 2 000 行,更早的删掉)做水平清理。清理只触碰 `~/.helmsman/history/`,绝不碰 worktree/基础仓库。

## 风险 / 取舍(Risks / Trade-offs)

- [长时间舰队运行导致磁盘膨胀] → 保留策略(D6)带默认水平上限,在任务完成与插件启动时执行清理。
- [DSH webServer 对 SSE 是否缓冲未知] → 心跳 + 真实 profile 冒烟验证;若宿主缓冲,则在处理器上加 `X-Accel-Buffering: no` 之类的头(记录进 ARCHITECTURE)。
- [cursor 越过清理边界(`history-pruned`)的体验] → API 返回显式信号 + 仪表盘显示"历史早于该 cursor 已被清理"横幅,对齐 MOVO 的恢复体验。
- [注入式历史带来的引擎复杂度] → 接口默认内存实现;既有测试不动;新增测试单独覆盖 `JsonlHistoryStore`。
- [多 agent 并发下的事件顺序] → 按追加时间排序、每条事件带 `agent`;消费者把交错视为设计内属性(MOVO 同样如此)。

## 迁移计划(Migration Plan)

无数据迁移(此前没有持久化)。上线顺序:先加存储与接口(默认内存)→ 插件装配里启用 JSONL 存储 → 加 REST/SSE 端点 → 切换 SPA。每步可独立发布;回滚 = 保留轮询客户端 + 内存默认(行为与今天完全一致)。

## 开放问题(Open Questions)

- `dsh-webServer` 的前缀处理器是否已为长连接 SSE 设置合适的 `Connection: keep-alive`——在首次 profile 冒烟测试中经验性确认(缓解措施见"风险")。
