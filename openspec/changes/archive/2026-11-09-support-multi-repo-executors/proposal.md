# 提案：多仓库执行器——Source 实例参数化 + 按仓库路由

## Why

微服务场景下待办天然分散在多个仓库，但当前装配只能服务一个：

1. **一种 kind 只能有一个实例**。`packages/superagent-source/src/kind.ts:33` 的
   `KIND = 'workmate'` 是模块级常量；宿主 `registry.ts:21` 对重复 kind 直接抛
   `Source kind already registered`。装第二个实例立即失败。
2. **扫描不按仓库过滤**。`watch.ts:108` 的 `scanOnce` 只看 `assigned`/`abandoned`/
   `dependsOn`，不看 `repo`；`gate.ts` 的 `GateTask` 也没有 `repo` 字段。所以唯一的
   执行器会收到**所有仓库**的待办。
3. **可指派判定是死的**。`task/service.ts:350` 的 `connectable()` 依赖
   `deps.executorRepo`，而 `src/index.ts` 从未传过这个参数——它恒为 `undefined`，
   于是恒返回 `true`。面板对所有仓库都显示"可指派"，但执行器的
   `deployment.repository` 是单值，只有路径匹配的那条能真跑，其余静默卡在
   "已投递·待接受"。
4. **跨仓提案没有落点**。`Proposal.targets` 支持多仓，`onImplementing`
   （`index.ts:204`）会为每个 target 建待办；但这些待办进同一个 Source、同一个执行器，
   只有一个仓库能被服务。

实测证据（2026-11-09，本机）：唯一待办 `repo` 为
`/Users/fredlee/Documents/workspace/dsh-Helmsman`，执行器 `repository` 同值，端到端跑通；
`connectable` 对任意 `repo` 均返回 true（代码级确认，非推断）。

## What Changes

- **Source kind 参数化**：`KIND` 由常量改为可配置（默认 `workmate`，可设
  `workmate-<suffix>`），使同一进程可注册多个实例；健康条目名、state 键前缀、
  Trigger `source`、Thread key 前缀一并按实例 id 派生，互不串台。
- **按仓库过滤**：Source 实例新增 `repos` 配置（绝对路径数组，空 = 不限制）；
  `scanOnce` 只投递 `repo` 命中的待办，其余计入新的 `skippedByRepo` 计数并写进健康摘要。
- **可指派判定诚实化**：WorkMate 侧新增 `executorRepos`（数组，替代单值
  `executorRepo`）；`connectable()` 按它判定，不匹配时面板显示
  「未接入执行器（仓库 X）」且拒绝指派——不再假装可投。
- **多端点投影**：`superagentEndpoint` 之外支持 `superagentEndpoints`（端点列表）；
  面板聚合多个执行器的健康与 Ticket 投影，任一离线只影响它自己服务的那批待办。
- **跨仓提案**：一个提案的多个 target 待办按 `repo` 路由到各自执行器；归档门的
  合并校验与回收本来就逐 target（`service.ts` 已按 target 遍历），无需改动。

## Capabilities

### Modified Capabilities

- `superagent-source`：「作为独立 Source bundle 安装」补充多实例共存语义；
  「待办到一个 Thread 的映射与幂等 Trigger」补充按仓库过滤；
  「健康、事实与查找」补充按实例隔离的健康条目。
- `task-intake`：「执行器与仓库一对一」改写为「执行器与仓库集合」——一个执行器
  服务一组仓库，面板据实显示可指派性。

## Impact

- **子包** `packages/superagent-source/`：`kind.ts`（KIND 参数化 + `repos` 字段）、
  `watch.ts`（过滤与计数）、`gate.ts`（`GateTask` 加 `repo`）、`index.ts`（按实例
  id 派生键名与健康条目）、`environment.ts`（环境变量前缀不变，值按实例）。
- **WorkMate 主包**：`src/config.ts`（`executorRepos` / `superagentEndpoints`）、
  `src/index.ts`（装配多端点与 `executorRepos`）、
  `src/features/task/service.ts`（`connectable` 改数组判定 + 面板提示）、
  `src/features/superagent/client.ts`（多端点聚合）、
  `src/client/TasksView.tsx`（未接入提示）。
- **兼容**：`executorRepo`（单值）保留为 `executorRepos` 长度为 1 的特例；
  `superagentEndpoint` 同理。旧配置不改也能跑。
- **不需要改**：归档门、合并校验、回收、判断层——它们已按 target / repo 维度工作。
- **重启边界**：Source kind 的注册发生在插件 apply 阶段，**改完必须重启宿主**。
  这条会写进 tasks.md，避免 worker 在"改完看不到效果"里反复试。

## 非目标

- 不做"一个执行器跨仓干活"（一个 worker 同时改多个仓库）。一个 Ticket 仍绑定一个
  仓库，跨仓由多条待办 + 多个执行器承担。
- 不做动态增删执行器而不重启（宿主插件模型的限制，见上）。
- 不改 Super-agent 原型的 executor 语义（`deployment.repository` 保持单值）。
