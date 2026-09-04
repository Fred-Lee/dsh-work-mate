# 🚀 Helmsman Workbench (v3) — 定位升级:从"Agent 调度器"到"AI 原生开发工作台"

> v3 相对 v2 的两处根本修正:
> 1. **入口形态**:不再是独立的 `/helmsman-workbench` 网页,而是 **DSH 原生界面(`http://127.0.0.1:3080/`)侧边栏入口 + 界面内可切换面板**。通过 DSH client 的 slot 系统 + 运行时 client 模块加载器实现,**不改 DSH 源码**。
> 2. **UI 底座**:优先复用社区插件 `dsh-better-sidebar`(侧边栏分页 + 文件预览服务),不满足处再自建。研究/PRD/知识/执行视图均为"DSH 界面内的可切换面板"。

---

## 一、新定位

> Helmsman 是一个基于 DSH 的 **AI 原生开发工作台**,覆盖"行业研究 → PRD 沉淀 → 任务拆解 → Agent 执行 → 知识库归因"的产品全生命周期。

**核心理念**:对话驱动开发(Conversation-Driven Development)——你通过自然语言与 DSH/Helmsman 对话,它帮你完成从想法到代码的全链条。

**现有 Helmsman 的角色**:现有的 Agent 并行调度看板(Dashboard + Diff)成为 Workbench 的"执行层(Execution Layer)",在 DSH 界面内作为一个面板呈现。

## 二、四大核心能力

| 层级 | 能力模块 | 对应需求 | 状态 |
|------|----------|---------|------|
| L1 研究层 | Deep Research + 行业信息沉淀 | 对话中 Deep Research 行业信息 | 🆕 需新增 |
| L2 产品层 | PRD 生成 + 里程碑拆解 + 任务分解 | 沉淀 PRD → 拆里程碑 → 具体任务 | 🆕 需新增 |
| L3 执行层 | 多 Agent 并行调度 + Diff 对比合并 | 执行具体编码任务 | ✅ 已有 |
| L4 知识层 | 接入 Tolaria + 项目知识图谱 | 知识库、图谱、基于现有项目分析 | 🆕 需新增 |

## 三、UI 形态:DSH 原生侧边栏入口 + 可切换面板

### 3.1 入口

- DSH 侧边栏底部新增一个 **"🚀 Helmsman"** 动作(注册到 `sidebar.footer.action` 槽位)。
- 点击后在工作区右侧/侧边栏展开一个 **Helmsman 面板组**,顶部一组 Tab 随时切换:

```
┌─ DSH 工作区 ──────────────────────────┬─ Helmsman 面板 ──────┐
│  对话 / 会话                           │  [📚研究] [📋PRD]    │
│                                        │  [⚡执行] [🕸️知识]  │
│                                        │                      │
│                                        │  (当前面板内容)       │
│                                        │                      │
└────────────────────────────────────────┴──────────────────────┘
```

### 3.2 四个可切换面板(内容即 v2 的设计稿)

- **📚 研究笔记(L1)**:Deep Research 会话 + 研究笔记列表/编辑,[💾 保存笔记][📝 生成 PRD 草稿][🔗 关联现有项目]。
- **📋 PRD(L2)**:PRD 编辑 + 里程碑/任务拆解 + 版本历史;底部 [📊 拆解里程碑][📋 生成任务][📎 关联代码仓库][💾 保存]。
- **⚡ 执行看板(L3,已有)**:现 ui-dashboard 的 Agent 调度看板,作为可嵌入视图复用。
- **🕸️ 知识图谱(L4)**:Tolaria 接入 + 图谱总览 + 基于知识库的需求分析(已有资产复用评估)。

> 面板内容与 v2 各设计稿一致,不再重复画;仅把"独立 Wotkbench 页面"改为"DSH 界面内面板"。

### 3.3 用户 4 个"初始界面"能力的落点

| 能力 | 落点 |
|------|------|
| 看之前进行中的工作 | 「⚡ 执行」面板的"进行中工作/最近会话"列表(任务看板 + 历史会话) |
| 基于原有工作做迭代 | 每条历史记录提供"继续 / 复用为我对话上下文"动作 |
| 自定义指令 | a) 复制改造 agent 预设(改研究/PRD 人格、提示词);b) 个人"指令库"存常用 prompt 片段,经侧边栏 `sidebar.footer.action` / `ui-commands` 快捷注入 |
| 把对话上下文总结到 Helmsman | 对话区/面板加「💾 沉淀到 Helmsman」→ 落成研究/PRD 笔记(草稿存本地;确认归档后再存入专属 helmsman Tolaria vault) |

## 四、技术实现路径

### 4.1 扩展底座:为何不改 DSH 源码(已核实)

DSH 原生 client 提供了两套可被插件消费的注入机制:

1. **Slot 槽位系统**(`@deepseek-ai/dsh-client-ui-slots`):插件 `SlotCore.register({name, ...}, component)` 往声明好的槽位注入 React 组件。已声明可占槽位含 `sidebar.footer.action`(list)、`sidebar.workspaces`、`sidebar.settings`、`sidebar.brand.*`。
2. **运行时 client 模块加载器**(`client/modules/src/client/{manifest,system}.ts`):client 在**运行时**通过 `<script …?rev=…>` 加载插件产出的 closure-factory bundle(`__ModuleLoader__.load({id, factory})`,依赖经模块表解析)。`tsdown.client.ts` 预设负责把 client half 打成该格式。

**结论**:第三方插件的"client half"无需编进 DSH 构建产物,装上即注入 DSH 界面。这正是 v2 §4.1"DSH 侧边栏顶层应用"的正规实现途径。

### 4.2 复用优先:面板底座用 `dsh-better-sidebar`

- 安装:`dsh plugin --profile web add dsh-better-sidebar@latest`(若 pnpm 11 拦截 node-pty 构建脚本,需 `pnpm approve-builds --all` 后重装,再硬刷新浏览器)。
- 下游插件通过 `inject = ['betterSidebar']` 使用:
  ```ts
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'helmsman:workbench',
    title: '🚀 Helmsman',
    component: ({ scope }) => <WorkbenchPanel sessionId={scope.sessionId} />,
  }))
  ```
- 类型合并用 `import type {} from 'dsh-better-sidebar'`。
- 若 `dsh-better-sidebar` 不足以承载"多面板切换 + 跨面板共享状态",再回退到自建(基于原生 slot 或自注册 panel 槽位)。

### 4.3 插件拆解(更新版)

| 序号 | 插件 | 类型 | 功能 | 层级 |
|------|------|------|------|------|
| 1 | `@helmsman/worktree` | Service | Git Worktree 管理 | L3 |
| 2 | `@helmsman/memory-topology` | Service | 项目拓扑记忆 | L3+L4 |
| 3 | `@helmsman/orchestrator` | Service | Agent 调度引擎 | L3 |
| 4 | `@helmsman/adapter-*` | Adapter | 4 个 Agent 适配器 | L3 |
| 5 | `@helmsman/ui-dashboard` | UI | 执行看板(重构为可嵌入视图模块) | L3 |
| 6 | `@helmsman/ui-diff` | UI | Diff 对比(重构为可嵌入视图模块) | L3 |
| **7** | **`@helmsman/presets`** | **Agent 预设** | **研究 / PRD / 拆解 / 需求分析 4 个 agent 预设 + 注册 `helmsman_*` 生成工具** | **L1+L2+L4 新增** |
| **8** | **`@helmsman/ui-workbench`** | **UI(双 bundle)** | **DSH 侧边栏入口 + 可切换面板外壳 + 生成触发 endpoint** | **L1+L2+L3+L4 新增** |
| **9** | **`@helmsman/knowledge-tolaria`** | **Service** | **Tolaria 专属 vault 归档门面(仅定稿)+ 检索 + 知识图谱数据** | **L4 新增** |
| 10 | `@helmsman/bundle` | Bundle | 组合包 | 全部 |

> 说明:
> - **生成机制 = DSH Agent 预设模式**:L1 研究 / L2 PRD / 拆解 / 需求分析各是一个 agent preset(`@helmsman/presets` ship 研究/prd/decompose/require-analyze),由 ui-workbench host 起**一次性新会话**组合预设执行;Deep Research **复用 DSH 已有搜索工具**;会话用 **profile 当前模型**。headless 亦可经注册的 `helmsman_research / helmsman_generate_prd / helmsman_decompose / helmsman_require_analyze` 工具显式触发。前端纯展示。
> - **「自定义指令」范围 = 两者**:a) 复制改造 agent 预设(改人格/提示词);b) 个人"指令库"存常用 prompt 片段一键注入。
> - **ui-dashboard / ui-diff 重构为可嵌入视图模块**(按最佳实践、接受再造成本),由 ui-workbench 面板直接渲染,而非 iframe。
> - 复用的第三方:`dsh-better-sidebar`(面板底座)、`dsh-virtual-workspace`、`dsh-memory-manager`+`dsh-memory-palace`、DSH 已有搜索工具。
> - **知识型内容分区**:中间/草稿(研究草稿 / PRD 草稿 / 设计草稿)留在 Helmsman 本地;仅**确认归档**的定稿由 `knowledge-tolaria` 推入 Tolaria 专属 `helmsman` vault。草稿不改动已归档知识,避免双写与误归档。

### 4.4 数据存储

**中间/草稿内容 → Helmsman 本地 `~/.helmsman/`(未归档,不吐给 Tolaria)**
- 沿用 `topologies/`(项目群拓扑)、`worktrees/`(任务 worktree)。
- 新增 `notes/`(研究笔记 **markdown 草稿**)、`prds/`(PRD 草稿 + 版本历史)、`tasks/`(里程碑/任务 **结构化 JSON**:依赖、负责人、状态、AI建议)。文档类用 markdown,任务/里程碑用结构化 JSON(便于版本对比与关系查询)。
- L2 实体:PRD(草稿 + 版本历史)、里程碑、任务、依赖、负责人、状态、AI建议。任务→执行层映射契约由 ui-workbench host 组装成 `run_parallel` 入参。

**确认归档内容 → Tolaria 专属 `helmsman` vault(仅定稿推送)**
- 用户新建一个专属 Tolaria vault(如 `~/.helmsman/vault` 或用户指定路径,经 Tolaria `attach_vault` 挂载);`knowledge-tolaria` 只负责**归档定稿 + 检索 + 知识图谱**,不写草稿。
- 触发归档的是**显式动作**:研究笔记「✅ 确认归档」→ `create_note` 写入 vault;「📝 生成 PRD」发布 → 定稿文档写入 vault;设计文档同理。
- 检索(L4 需求分析 / L1 下次研究)→ `search_notes`,**只命中已归档内容**,草稿不参与。
- 好处:草稿与定稿分离,草稿随便改、不污染知识库也不外泄;归档才进 Tolaria,规避"未确认内容被持久化到别处"的双写风险。

> ⚠️ 安全边界:Helmsman 核心闭环(worktree / orchestrator / merge / scan)保持**零网络外发**;L1 Deep Research 为**可选、需显式启用**的能力,仅经 DSH 已有搜索工具外发(需更新 SECURITY-AUDIT);归档到 Tolaria 仅推定稿(若 vault 挂 git remote,推送前需提示)。

## 五、完整数据流

```
DSH 对话 / Helmsman 面板
  → [💾 沉淀上下文] → DSH agent 总结 → 研究笔记草稿(本地)→ [确认归档] → Tolaria vault(L1)
  → [生成 PRD]      → 研究笔记 + 知识库 → PRD(L2)
  → [拆解里程碑]     → PRD + 技术栈 → 里程碑/任务(L2)
  → [生成 Agent 任务] → 任务 + 项目群拓扑 → run_parallel(L3)
  → [执行反馈]        → 代码 & Diff → 知识图谱更新(L4,task-updated 事件)
  → [下一轮研究]      → 检索 L4 → 反向增强 L1
```

## 六、更新后的最终交付物清单

| 交付物 | 类型 | 状态 | 说明 |
|--------|------|------|------|
| worktree / memory-topology / orchestrator / adapter-* | 已有 | ✅ | L3 执行层 |
| ui-dashboard / ui-diff | 已有(重构) | ✅ | L3,重构为可嵌入视图模块 |
| **`@helmsman/presets`** | **Agent 预设** | **🆕** | **研究/PRD/拆解/需求分析预设 + `helmsman_*` 生成工具** |
| **`@helmsman/ui-workbench`** | **UI(双 bundle)** | **🆕** | **DSH 侧边栏入口 + 可切换面板外壳 + 生成 endpoint** |
| **`@helmsman/knowledge-tolaria`** | **Service** | **🆕** | **Tolaria 归档门面 + 检索 + 知识图谱** |
| `@helmsman/bundle` | 组合包 | 更新 | 聚合全部 11 个 Helmsman 插件;复用的 better-sidebar 由 profile 另装 |
| 复用 `dsh-better-sidebar` | 社区 | 新增依赖 | 面板底座 |

## 七、开发步骤(修正版)

1. **装社区插件**:`dsh-virtual-workspace`、`dsh-memory-manager`、`dsh-memory-palace`、`dsh-better-sidebar`。
2. **L3 执行层**:现有 6 插件 + 真实集成,无需重写。
3. **🆕 @helmsman/presets**:定义 4 个 agent 预设(研究/PRD/拆解/需求分析),注入 roster;注册 `helmsman_research / helmsman_generate_prd / helmsman_decompose / helmsman_require_analyze` 工具(供 headless 显式调用);复用 DSH 已有搜索工具。
4. **🆕 ui-workbench(client half)**:用 tsdown.client.ts 预设打 closure-factory bundle;注册 `sidebar.footer.action` 入口 + `betterSidebar.registerTab` 挂 4 面板;host 侧提供生成 endpoint(起一次性预设会话)。
5. **🆕 ui-workbench(host 侧)**:连通 preset/orchestrator/topology/knowledge-tolaria;生成 = 起一次性预设会话,流式取结果落本地(研究/PRD=markdown 草稿,拆解=结构化 JSON)。
6. **🆕 knowledge-tolaria**:本地 vault 文件读写门面(仅归档定稿)+ 检索 + 图谱数据模型(消费 memory-topology 结构化数据)。
7. **重构 ui-dashboard / ui-diff** 为可嵌入视图模块,嵌入 ui-workbench「⚡执行」面板。
8. **组装 bundle、构建、测试、安全审计**(更新 Deep Research 外发豁免)。

## 八、ZCode 执行指令(总结)

1. 安装社区插件(含 `dsh-better-sidebar`)。
2. 实现 L3(已有可复用)。
3. 🆕 实现 ui-workbench(client bundle + host 生成 endpoint + 4 面板外壳)。
4. 🆕 实现 knowledge-tolaria。
5. 组装 bundle、测试验证。

**四面板对应层级**:📚研究=L1 · 📋PRD=L2 · ⚡执行=L3 · 🕸️知识=L4。
**跨层闭环**:L1→L2→L3→L4→(下一轮检索 L4 增强 L1)。
