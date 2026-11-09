# 设计：多仓库执行器

## D1 kind 按实例参数化，而不是复制包

**决策**：`KIND` 从模块常量改为从实例配置读出的 id（`kind` 字段，默认 `workmate`，
需匹配 `^[a-z][a-z0-9-]*$`）。

**理由**：宿主 `registry.register` 用 `kind.kind` 作 Map 键（`registry.ts:20-21`），
重复即抛错。复制第二个包会产生两份代码、两套测试、两条升级线，而差异只有一个字符串。

**替代方案**：多包（`workmate-source-a` / `-b`）——否决：维护面翻倍，且健康条目名、
state 前缀、Trigger source 都要跟着改，等于把参数化的工作再做 N 遍。

## D2 派生键必须全部按实例 id 走

`KIND` 当前被用在四处，全部要参数化，否则两个实例会串台：

| 位置 | 用途 | 串台后果 |
| --- | --- | --- |
| `kind.kind` | 宿主注册键 + settings 块键 | 第二个实例注册失败 |
| `health: [HEALTH_ENTRY]` | 健康条目名 | 健康报告冲突或丢报 |
| `STATE_PREFIX` + 游标/Ticket 键 | Source 自己的 KV | 两个实例共用一个游标 → 漏投或重投 |
| Trigger `source` / Thread key 前缀 | 幂等与 Thread 归属 | 两个实例的 Trigger 互相去重 |

**纪律**：所有派生点集中在一处（`kindIdOf(config)`），不散落。state 键保持
字符串类型（宿主 KV 是 SQLite TEXT 列）。

## D3 过滤放在 scanOnce，不放 gate

**决策**：`repo` 过滤在 `scanOnce` 的 ready 列表上做，`evaluateGate` 仍只看依赖。

**理由**：依赖门控是纯函数且语义单一（"前置完成了吗"）；混入"这个仓库归我吗"会让
"依赖等着"与"不归我管"两种等待无法区分。分开后健康摘要可以分别报告
`waitingOnDependency` 与新增的 `skippedByRepo`。

**边界**：被跳过的待办**不推进任何游标**（游标只服务 `inputs.jsonl` 的回答），
所以另一个实例接管时能正常投递。

## D4 WorkMate 侧用集合判定，不用路由猜测

**决策**：`executorRepo?: string` → `executorRepos?: string[]`；`connectable()` 改成
`repos.length === 0 || repos.includes(task.repo)`。

**理由**：WorkMate 不该猜"这个待办该给哪个执行器"。它只需要知道**哪些仓库有执行器**，
用于如实显示可指派性并拒绝越界指派。真正的路由由 Source 实例的 `repos` 配置完成
（D3）——一处配置、一处判定，不会出现"面板说能派、Source 不投"的错位。

**兼容**：`executorRepo` 保留，装配时归一成 `[executorRepo]`。

## D5 多端点聚合的失败隔离

`superagentEndpoints: string[]`，client 对每个端点独立取 health 与 tickets，
一个端点失败只把该端点标记为离线并把它的待办投影成 `unknown`，不影响其他端点。
面板显示"N 个执行器，M 个离线"。

## D6 重启边界（写进 tasks，避免 worker 空转）

Source kind 的注册发生在插件 `apply` 阶段，配置变更需要重新 `apply`。所以：

- **worker 可以改** `kind.ts` / `watch.ts` / `gate.ts` / `service.ts` / `client.ts` 与测试；
- **worker 不能验收**"注册了第二个实例"——那要重启宿主，而重启会杀掉 worker 自己。

因此本变更的 tasks 明确区分「worker 可完成并自证」与「需人工重启后验收」两类，
后者由人在面板点「重新检查」并重启。

## D7 prepare 模板的多仓适配

`prepare` 的 `$PWD` 是 `dirname(ticket.directory)`，即 `executor.directory` 的父级；
`git -C "$PWD"` 要求 PWD 本身是仓库。多仓时每个执行器有独立 `stateDir` 与
`executor.directory`，所以 `prepare` 不需要改——每个执行器各自指向自己的仓库。
**但** `deployment.repository` 与之必须一致，否则 `git ls-remote` 验的是 A 仓而
worktree 建在 B 仓。这条写进接入手册的检查清单。
