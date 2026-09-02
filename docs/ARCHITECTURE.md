# Helmsman 架构说明

## 1. 在 DSH 插件体系中的位置

Helmsman 是一组**标准第三方 DSH 插件**（纯 ESM，`dsh.bundle.patch` → `cordis.patch.yml`），
通过 `dsh plugin --profile <p> add ./packages/<pkg>` 装入 profile，由 loader 按
`insert` 行挂进 cordis 插件树。每个插件遵循 DSH 契约：

```ts
export const name = '@helmsman/<pkg>'       // 诊断显示
export const inject = ['tools', ...]        // 硬依赖：服务未就绪则 fiber PENDING
export function apply(ctx: Context, config) // 挂载点
```

服务注册用 `ctx.provide('<name>', value)`（点号名合法），跨插件获取用
`ctx.get('<name>')`（可选依赖**必须延迟到运行时解析**，见 §4 竞态）。
非 cordis 管理的资源一律包 `ctx.effect(() => disposer)`。
本套插件没有任何 `export default`，全部具名导出。

## 2. 服务拓扑

```
helmsman.worktree   (provide) ←─ inject ── orchestrator
helmsman.topology   (provide, 自足)           │
helmsman.orchestrator (provide) ←─ inject ── adapter-{claude,codex,pi,oh-my-pi}
webServer (DSH 内置) ←─ inject ── ui-dashboard, ui-diff
```

- **worktree**：`git worktree add -b helmsman/<taskId>-<agent>`，记录 baseSha；
  diff = `git diff --binary <baseSha>`（`--intent-to-add` 让未跟踪文件可见）；
  合并 = 工作区 diff 生成 patch → 主仓库 `git apply`（stdin）→ `git commit`；
  冲突时 apply 失败、主仓库原状不动，返回 conflictFiles。
  惰性集成社区插件 `vws`（dsh-virtual-workspace）：每次创建/删除时
  `ctx.get('vws')`，失败不阻塞。
- **memory-topology**：`~/.helmsman/topologies/<group>.json`（组名 URI 编码，
  CJK 安全）；`normalizeTopology` 在读写两侧做形状清洗，坏文件降级为 null。
  扫描器零依赖：Maven 用轻量标签匹配（含 `${property}` 解析、dependencyManagement、
  modules、parent 链接推导）；REST 扫描支持 Spring / NestJS / Express 三类注解
  与路由，带深度/文件数/大小上限与 realpath 符号链接逃逸检查。
- **orchestrator**：框架无关的 `OrchestratorCore`（单测覆盖），插件入口只做
  cordis 装配 + 4 个 agent 工具注册。任务状态机与 PRD §4.2 一致；
  限流(429)按 2s/8s/32s 指数退避重试（默认 3 次），认证失效不重试，
  连续 5 次失败触发 30s 断路器；`helmsman/task-updated` 事件经 `ctx.emit` 广播。
- **UI 插件**：host 半区经 `ctx.webServer.register({kind:'prefix'})` 挂载
  `/helmsman-dashboard` 与 `/helmsman-diff`，同源 REST API + 静态 SPA
  （esbuild 打包 React 18 为 IIFE，零运行时 npm 依赖）。这是社区插件
  `dsh-Visual-Workflow` 验证过的第三方 UI 模式，不依赖 `dsh.client`
  module roster（后者需要 web-app bundle 深度配合）。

## 3. 数据流

```
Dashboard (React, 单向数据流 useReducer)
  │ 1.5s/5s 轮询 GET /api/state          ← 降级：失败保留上次数据
  ▼
dashboard host (Router + REST façade) ──进程内──▶ orchestrator / topology
  ▼                                          │
orchestrator.runParallelTask()                │ helmsman/task-updated 事件
  ├ worktree.createWorktree × N agent         ▼
  ├ adapter.execute（spawn CLI，流式日志）     UI 卡片状态机渲染
  ├ worktree.getDiff → 冲突文件标注
  └ mergeTask → git apply patch → commit
```

## 4. 已知设计权衡

- **轮询 vs SSE**：v1 用 1.5s/5s 自适应轮询（活跃任务快、空闲慢），
  与 Visual-Workflow 的 600ms 轮询同思路；`helmsman/task-updated` 事件已就绪，
  后续可加 SSE 端点而不动核心。
- **可选依赖竞态**：orchestrator 对 topology 是可选依赖，不能 `inject`（否则
  未装 topology 时永久 PENDING），而 `ctx.get` 在 apply 期立即解析会因服务
  未 ACTIVE 拿到 undefined——因此传入**惰性 getter**，运行时再解析。
- **拓扑提示注入（cascade）**：v1 把下游依赖图作为提示词上下文注入每个 agent
  （不改执行顺序）；服务级级联编排（按拓扑序逐服务执行）留作后续，
  `topology.cascadeOrder()` 已提供拓扑序计算。
- **合并语义**：patch 式合并（`git apply`）而非分支 `git merge`，这样即使 agent
  未在 worktree 内提交也能合并；代价是冲突处理是「整批失败」（原子），
  冲突文件由 UI 选择采纳某个 Agent 后按 agent+file 维度重试。
- **用量统计**：估算 tokens = chars/4，仅用于看板展示，非计费口径。

## 5. 目录结构

```
packages/
  worktree/          git worktree 服务（diffparse / service / git）
  memory-topology/   拓扑存储 + 扫描器 + 导入导出 + 3 个 agent 工具
  orchestrator/      core.ts（引擎）+ index.ts（cordis 装配 + 工具）
  adapter-*/         每个适配器独立（spawn 循环 + 参数模板 + README）
  ui-dashboard/      src/*.ts(host) + src/client/*(React SPA + CSS 变量双主题)
  ui-diff/           同上 + 统一 diff 解析/冲突 UI/合并栏
  bundle/            cordis.patch.yml 聚合 9 行 insert
scripts/build-package.mjs   共享 esbuild 配置（packages:external）
```

## 6. 测试

- 单测：`packages/*/src/*.test.ts`，`pnpm test`（vitest，56 用例）。
- 关键集成：真实 `git init` 的 worktree 创建→diff→合并→冲突→清理全链路。
- 真实 profile 冒烟：`--dump-config` 核对 9 行 insert；`dsh web` 启动后 curl
  `/helmsman-dashboard/api/state`；以假 agent 脚本走完 执行→聚合→合并→主仓库
  commit 的 E2E（记录见 git history 与 docs/USAGE.md §验证）。
