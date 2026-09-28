# Add Proposal Middleware

## Why

WorkMate 的核心实体是「变更提案」。里程碑二要把它变成 Agent 与人都能操作的工作面：
Agent 经工具创建/查询/归档提案并自动落 OpenSpec 目录，人在 DSH 界面的面板里看到
提案、Git 关联与 OpenSpec 进度（设计文档 §7 里程碑二）。

## What Changes

1. **工具注册**（真机模式：`inject: ['tools']` + `ctx.tools.register(defineTool)`，
   Helmsman orchestrator 验证形态）：`workmate_proposal_create` /
   `workmate_proposal_status` / `workmate_proposal_archive`。
2. **OpenSpec 目录生成**：create 时在项目 `openspec/changes/<id>/` 下生成
   `proposal.md` / `design.md` / `tasks.md` 模板；目录已存在则跳过（永不覆盖）。
3. **Git 关联（pull 模式）**：status 时对关联项目执行 `git log --grep '[proposal:<id>]'
   --fixed-strings` 收集关联提交。不监听宿主 Git 事件——该事件面未经验证，pull 模式
   零宿主 API 依赖且语义等价（design D3）。
4. **REST + SPA**（真机模式：`inject: ['webServer']` + `webServer.register prefix`）：
   `/workmate/api/*` 五个端点 + 提案面板 SPA。
5. **Client 半启用**（真机模式：ui-workbench 的 ModuleLoader CJS bundle）：
   `dsh.client.platform: 'web'`；better-sidebar tab「🛠 WorkMate」挂提案面板。
6. **归档工具 M2 语义**：archive 工具先做纯状态机推进（draft → executing → archived，
   校验 openspec 目录存在）；swarm 并行与 CLI 编排由里程碑四替换（proposal archive
   的完整编排）。

## Capabilities

### 新增能力

- `proposal-middleware`：提案的 Agent 工具面、OpenSpec 目录联动、Git 提交关联、
  REST/SPA 面板与 better-sidebar 挂载。

## Impact

- `src/` 新增 openspec/git/status 聚合与 archive 状态机、http Router、REST 路由；
  新增 `src/client/`（React 面板 + ModuleLoader 入口）。
- `package.json` 增加 `dsh.client` 声明与 react/jsdom 测试 devDeps；`build.mjs`
  增加 client 两个产物（独立 IIFE 页 + ModuleLoader CJS）。
- 插件 `inject` 从 `[]` 变为 `['tools', 'webServer']`——两个服务均有真机验证证据
  （orchestrator 用 tools；四个 Helmsman UI 包用 webServer）。
- 外部依赖：git CLI（项目侧，已在宿主环境）；无新增 npm 运行时依赖（React 打包内联）。
