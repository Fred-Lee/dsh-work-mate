# Helmsman Workbench — 设计文档 (design.md)

> 依据:`docs/PRD/Helmsman-PRDv3.md`(已定稿)。本文是 PRD → task.md 之间的技术桥梁,覆盖模块/接口/数据/安全 + 设计期 spike 项。

## 1. 目标与范围

**目标**:把 Helmsman 从"Agent 调度器"升级为"DSH 界面内的 AI 原生开发工作台"——在 DSH 原生客户端(:3080)侧边栏加入口 + 4 个可切换面板,提供 L1 研究、L2 PRD、L3 执行、L4 知识四层闭环。

**范围内**:
- 新增 3 个插件:`@helmsman/presets`、`@helmsman/ui-workbench`、`@helmsman/knowledge-tolaria`。
- 重构 ui-dashboard / ui-diff 为可嵌入视图模块。
- 复用社区 `dsh-better-sidebar`(面板底座)+ DSH 已有搜索工具。

**范围外(v3 明确留空)**:真正按拓扑序的顺序执行(仅提示词注入+并行)、Deep Research 之外的外发能力、版本历史的 git 级 diff。

## 2. 总体架构

```
┌─ DSH web client(外壳)──────────────────────────────────────────────┐
│  sidebar.footer.action →「🚀 Helmsman」 [ui-workbench client]        │
│  betterSidebar.registerTab(helmsman:workbench) → 4 面板              │
│     [📚研究][📋PRD][⚡执行][🕸️知识]                                  │
└─────────────▲──────────────────────────────────────────────────────┘
              │ 同源 REST(生成/状态/归档/图谱)
┌─────────────┴──────────────────────────────────────────────────────┐
│  ui-workbench host(Node, 同 dsh web 进程)                          │
│   ├─ applyPreset(presetId, input) → 起一次性 DSH 预设会话 → 流式输出 │
│   ├─ orchestrator / memory-topology(L3 执行)                       │
│   └─ knowledge-tolaria(归档/检索/图谱)                             │
│        └─ ~/.helmsman/vault(markdown 笔记, git)                     │
└────────────────────────────────────────────────────────────────────┘
  数据层:~/.helmsman/{topologies,worktrees,notes,prds,tasks}/
```

**关键分层**:
- L1/L2/L4 的"思考"生成 → **DSH agent preset 会话**(DSH 模型 + 工具 + 人格)。
- L3 的"编码执行" → **4 个外部 agent CLI(adapter-\*)**,不变。
- 前端一律纯展示;所有状态经同源 REST。

## 3. DSH 扩展机制(已核实的接入点)

### 3.1 UI 注入(client half)
- **slot 系统**(`@deepseek-ai/dsh-client-ui-slots`):`SlotCore.register({name, ...}, component)`。已声明可用槽位含 `sidebar.footer.action`(list)、`sidebar.workspaces`、`sidebar.settings`、`sidebar.brand.*`。
- **运行时 client 模块加载器**:`BootManifest{id,url,rev}`、`__ModuleLoader__.load({id,factory})`、`tsdown.client.ts` 预设产出 closure-factory bundle。**第三方 client half 无需编进 DSH 构建产物**。
- **结论**:ui-workbench client half 用 `tsdown.client.ts` 预设打成 bundle,注册进 boot(具体登记字段见 §8 spike G1/G2),运行时注入 slot。

### 3.2 面板底座(better-sidebar)
- 下游:`inject = ['betterSidebar']`,`ctx.betterSidebar.registerTab({id, title, component:({scope})=>...})`。
- 类型合并:`import type {} from 'dsh-better-sidebar'`。

### 3.3 Agent 预设
- 预设 = 目录 + `agent.cordis.yml`(人格 `persona` + 工具 + 提示词分节 + skills),**按会话**组合;文件系统发现(shipped/user roots),copy-only 可自定义。
- 会话创建由 session 层决定,`agent-presets` 不负责"何时起会话"。

## 4. 模块设计

### 4.1 `@helmsman/presets`(新增,Agent 预设)
**职责**:定义 4 个预设 + 注册 `helmsman_*` 生成工具(供 headless 显式调用)。

预设目录(每目录一个 `agent.cordis.yml`):
- `helmsman-research`:研究/竞品人格;工具含 DSH 已有搜索工具;多步迭代+归因;输出研究笔记 markdown。
- `helmsman-prd`:产品经理人格;输入研究笔记引用;输出 PRD 结构 markdown。
- `helmsman-decompose`:拆解人格;输入 PRD;输出**结构化任务/里程碑 JSON**。
- `helmsman-require-analyze`:需求分析人格;输入需求 + 查询知识图谱;输出"已有资产复用 + 待新建 + 建议"。

工具注册(defineTool):
- `helmsman_research {prompt, noteId?}` → 起 preset 会话,落研究草稿。
- `helmsman_generate_prd {noteId, projectGroupId?}` → 落 PRD 草稿。
- `helmsman_decompose {prdId}` → 落任务/里程碑结构化 JSON。
- `helmsman_require_analyze {requirement, projectGroupId}` → 返回分析结果。

**搜索依赖**:首版复用 DSH 已有搜索工具(resolve 于运行时;若未装,给出明确降级错误,见 §8 G3)。

### 4.2 `@helmsman/ui-workbench`(新增,双 bundle)
**host(`apply`)**:
- 注册 webServer prefix 路由(续用现有挂载模式),提供同源 REST:
  - `POST /api/generate` `{preset, input}` → 起一次性预设会话,返回 taskId + 流式 SSE 状态。
  - `GET /api/panel/:kind/state` → 各面板状态(研究/PRD 列表、执行任务、图谱)。
  - 归档/检索/图谱走 knowledge-tolaria。
- 连通 `ctx` 侧:`agentPresets`(起会话)、`helmsman.*`(执行)、`knowledgeTolaria`(归档)。
- 依赖声明:`inject = ['agentPresets', 'betterSidebar', ...]`。

**client(`src/client`)**:
- 用 `tsdown.client.ts` 预设打包;`src/client/index.tsx` 内:
  - `SlotCore.register` 注入 `sidebar.footer.action`(id=`helmsman:workbench`, label="🚀 Helmsman")。
  - `ctx.betterSidebar.registerTab({id:'helmsman:workbench', title:'🚀 Helmsman', component})`(作用域窗口)。
  - 渲染 4 面板:研究/PRD(新)、执行(嵌入 ui-dashboard 重构模块)、知识(嵌入 knowledge 图谱视图)。

### 4.3 `@helmsman/knowledge-tolaria`(新增,Service)
**职责**(仅归档定稿 + 检索 + 图谱;不写草稿):
- **vault 读写**:直接读写 `~/.helmsman/vault` 的 markdown 文件(frontmatter + body),对齐 Tolaria 笔记格式;首装 `git init`。
- **检索**:`searchNotes(query)` — 文件名 + frontmatter + 正文匹配;可选:若配置了 tolaria MCP,再用 MCP `search_notes` 增强(绝不硬依赖)。
- **图谱**:`buildGraph(projectGroupId)` — 节点 = 服务/API/依赖(来自 memory-topology)+ 已归档文档/PRD(来自 vault);边 = 依赖/关联,合并输出给前端 `@helmsman/ui-graph`。
- **对外契约**:
  ```ts
  interface KnowledgeTolaria {
    archiveNote(note: { title: string; kind: 'research'|'prd'|'design'; body: string; frontmatter: Record<string, unknown> }): Promise<{ path: string }>
    searchNotes(query: string): Promise<NoteHit[]>
    buildGraph(scope: { projectGroupId?: string }): Promise<GraphData>
    listVault(): Promise<NoteMeta[]>
  }
  ```

### 4.4 重构 ui-dashboard / ui-diff
- **目标**:把两者的 React 视图抽成**可导入的组件库**,同时保留各自独立挂载路径(向后兼容)。
- 做法:新增库入口(如 `@helmsman/ui-dashboard/client` export 视图组件 / `@helmsman/ui-diff/client`),原 IIFE bundle 改为"薄壳 + 复用同一组件";ui-workbench 的执行面板直接 `import { DashboardView }` 渲染。
- 收益:一体外壳、共享 React 状态;成本:改动 client 构建与入口(接受,§6 有测试保障)。

## 5. 数据模型

**本地 `~/.helmsman/`(草稿/中间,结构化)**:
- `notes/*.md` — 研究草稿;frontmatter:`{id,title,keywords,linkedProjects[],createdAt,status:draft|archived,archivedAt}`。
- `prds/*.md` — PRD 正文;`prds/versions.json` — 版本历史(结构化)。
- `tasks/` — 里程碑/任务 **SQLite**(`helmsman.db`):`tasks(id, prdId, milestoneId, title, description, aiSuggestion, deps[], agents[], projectGroupId, status, owner, estimate)`;关系查询用 SQLite。
- 沿用 `topologies/`、`worktrees/`。

**Tolaria `~/.helmsman/vault/`(仅归档定稿)**:
- `notes/<id>.md`、`prds/<id>.md`、`designs/<id>.md`(frontmatter + 正文),每篇带 `source: helmsman`、`kind`、`linkedProjects`、`archivedAt`。

**任务→Agent 映射**(ui-workbench host 组装):
```ts
taskToRunParallel(task): {
  prompt: `${task.title}\n${task.description}\nAI建议: ${task.aiSuggestion}`,
  agents: task.agents, projectGroupId: task.projectGroupId,
  cascade: true /* 提示词注入;不顺序执行 */, timeoutSec: task.timeoutSec,
}
```

## 6. 生成流程(一次性会议话)

```
用户点「研究/生成PRD/拆解/需求分析」
 → POST /api/generate {preset, input}
 → ui-workbench host: 起一次性 DSH 预设会话(组合对应 preset)
 → preset 会话执行(DSH 模型 + 工具,profile 当前模型)
 → 流式输出 → SSE 回面板;完成 → 落本地草稿
   · 研究/PRD → markdown 草稿(notes/prds)
   · 拆解 → 结构化 JSON(tasks/SQLite)
 → 用户确认「✅ 确认归档/发布」 → knowledge-tolaria.archiveNote → Tolaria vault
```

## 7. 安全设计

- **核心闭环**(worktree/orchestrator/merge/scan)**零网络外发**(维持现状)。
- **Deep Research 可选、需显式启用**:仅经 DSH 已有搜索工具外发;默认关闭,审计增加该豁免。
- **L1 生成**消耗 profile 当前模型额度(用户可见、可中断)。
- **归档到 Tolaria 仅推定稿**;若 vault 挂 git remote,push 前提示(本地默认不 push)。

## 8. 设计期 spike(写 task.md 前先验证)

| # | 待验证 | 验证方式 | 影响 |
|---|--------|---------|------|
| G1 | 插件程序化"以某 preset 起会话 + 流式捕获 + 落库"的精确 API | 读 `packages/session`/`agent-presets/session.ts` + `jobs`/`workflow` 包,写最小 spike | 决定 §4.1 工具与 §6 流程 |
| G2 | 预设目录运行时被发现路径(shipped vs user root,免重编译) | 读 `agent-presets/discovery.ts`(`SHIPPED_PRESET_ROOT`/trusted root) | 决定 §4.1 预设落点 |
| G3 | DSH 是否已有内置搜索工具 | 检索 harness tool registry / `dsh-tools`;无则定 adapter 兜底 | §4.1 搜索依赖 |
| G4 | 第三方 client bundle 的 boot 登记字段 | 读一个社区 UI 插件(如 better-sidebar)的 `package.json`/入口 | §3.1 §4.2 client 打包 |

## 9. 风险与回退

- **预设会话 API 不可控**(G1 失败) → 回退:生成逻辑做成 `@helmsman/presets` 内的独立 agent 循环服务(仍复用 DSH 模型/工具),代价是少一层原生节流。
- **DSH 无搜索工具且 adapter 难落地**(G3) → Deep Research 暂标"需配置搜索源",面板给明确提示,不影响其余 L2/L4。
- **client 注入不稳**(G4) → 完全走 better-sidebar 已证明路径(最低依赖),自建 slot 注入作为增强。
- **ui-dashboard/ui-diff 重构回归**(§4.4) → 由现有 59+ 测试保障;若风险高,退化为"外壳 iframe + 后续再抽组件"(v3 已接受重构,此只为防节奏失控)。

## 10. 验收要点

- `dsh web` 启动后,:3080 侧边栏出现「🚀 Helmsman」入口,点击展开 4 面板。
- 研究 → 生成研究草稿 → 确认归档 → Tolaria vault 出现 `notes/<id>.md`。
- PRD → 拆解 → 结构化任务可被「⚡执行」面板勾选并行派发到 orchestrator。
- headless:`dsh --profile headless "使用 Helmsman 研究…"` 能触发 `helmsman_research`。
- 安全:核心闭环无外发;Deep Research 需显式启用。
