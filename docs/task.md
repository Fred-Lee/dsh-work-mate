# Helmsman Workbench — 任务清单 (task.md)

> 依据:`docs/design.md`。任务按"先解锁可行性 → 逐模块 → 集成"组织。每个任务给出**依赖 / 输出 / 验收**。优先级:P0(阻塞后继)· P1(主线)· P2(增强)。

## Phase 0 — 设计期 Spike(先解锁可行性,再开发)

| ID | 任务 | 依赖 | 输出/验收 |
|----|------|------|----------|
| T0.1 | 验证"程序化以某 preset 起会话 + 流式捕获 + 落库"的精确 API | 无 | 读到 `session`/`agent-presets/session.ts`/`jobs`/`workflow` 的调用法;最小 spike 能起一个预设会话并拿到输出 |
| T0.2 | 验证"预设目录运行时被 roster 发现"的路径 | 无 | 读到 `discovery.ts`(`SHIPPED_PRESET_ROOT`/trusted root);确认自定义复制到 user root 免重编译 |
| T0.3 | 确认 DSH 是否已有内置搜索工具 | 无 | 检索 harness tool registry / `dsh-tools`;若缺,定搜索 adapter 兜底(§design 8/G3) |
| T0.4 | 确认第三方 client bundle 的 boot 登记字段 | 无 | 读一个社区 UI 插件(如 better-sidebar)的 `package.json`/入口;明确 ui-workbench client half 怎么登记 boot 行 |
| T0.5 | 拍板 Tolaria vault 笔记格式(frontmatter 字段) | 无 | 与 Tolaria 约定 frontmatter 键(见 §design 5);本地能增/查一篇笔记 |

> 产物:T0.1-T0.5 结论回填 `docs/design.md` 的 §8。

## Phase 1 — @helmsman/presets(P1)

| ID | 任务 | 依赖 | 输出/验收 |
|----|------|------|----------|
| T1.1 | 建包骨架:纯 ESM、具名导出、cordis 契约(inject/apply) | 无 | `pnpm build` 通过 |
| T1.2 | 定义 4 个预设目录(`helmsman-research`/`-prd`/`-decompose`/`-require-analyze`),含 `agent.cordis.yml` | T0.2 | 目录被 roster 发现;`agent-presets` 能列出 |
| T1.3 | 注册 `autoAddToRoster` / preset 注入(shipped root) | T1.2 | 装包后 `dsh --profile web --dump-config` 可见预设 |
| T1.4 | 注册工具 `helmsman_research` | T0.1,T1.2 | headless 调用能起会话、落研究 markdown 草稿 |
| T1.5 | 注册工具 `helmsman_generate_prd` / `helmsman_decompose` | T1.4 | 生成 PRD 草稿 / 结构化任务 JSON |
| T1.6 | 注册工具 `helmsman_require_analyze` | T0.3,T1.4 | 需求分析返回"复用/待建/建议" |
| T1.7 | 搜索工具接入(resolve DSH 已有搜索;缺则 adapter 兜底) | T0.3 | Deep Research 可搜索;缺搜索时明确降级 |
| T1.8 | 单测:预设发现、工具入参校验、降级分支 | 各 | `pnpm test` 对应用例绿 |

## Phase 2 — @helmsman/knowledge-tolaria(P1)

| ID | 任务 | 依赖 | 输出/验收 |
|----|------|------|----------|
| T2.1 | 建包骨架 + `provide('helmsman.knowledge-tolaria')` | 无 | build 通过,可被注入 |
| T2.2 | vault 读写:`archiveNote()` 写 markdown,`listVault()` 列元数据 | T0.5 | 增/列一篇笔记 |
| T2.3 | 检索:`searchNotes()`(文件名+frontmatter+正文) | T2.2 | 关键词命中 |
| T2.4 | 图谱:`buildGraph(scope)` — 消费 memory-topology(服务/API/依赖)+ vault(文档/PRD),合并成节点/边 | T2.2 | 给定 scope 输出 GraphData |
| T2.5 | 可选增强:配置了 tolaria MCP 时用 `search_notes` 提升检索(绝不硬依赖) | T2.3 | MCP 可用则增强,不可用则回退本地 |
| T2.6 | 首装 `~/.helmsman/vault` `git init` + vault 路径配置 | T2.2 | 没 vault 时自动建目录 |
| T2.7 | 安全:仅定稿归档;vault 挂 remote 时 push 前提示 | T2.6 | 不 ext 出未确认内容 |
| T2.8 | 单测:vault 读写/检索/图谱/降级 | 各 | 用例绿 |

## Phase 3 — 重构 ui-dashboard / ui-diff 为可嵌入视图(P1)

| ID | 任务 | 依赖 | 输出/验收 |
|----|------|------|----------|
| T3.1 | 抽出核心 React 视图为可导入组件(库入口,非 IIFE) | 无 | `@helmsman/ui-dashboard/client` 能 `import { DashboardView }` |
| T3.2 | 保留原 IIFE bundle 为"薄壳 + 复用同一组件" | T3.1 | 原挂载路径 `/helmsman-dashboard` 仍可用 |
| T3.3 | 同上处理 ui-diff(`DiffView`) | T3.1 | `/helmsman-diff` 仍可用 |
| T3.4 | 回归保障:现有 59+ 测试 + typecheck 全绿 | T3.1-T3.3 | 重构不破坏行为 |

## Phase 4 — @helmsman/ui-workbench(P1,双 bundle)

| ID | 任务 | 依赖 | 输出/验收 |
|----|------|------|----------|
| T4.1 | client 打包:用 `tsdown.client.ts` 预设打 closure-factory bundle | T0.4 | bundle 能被运行时模块加载 |
| T4.2 | client 注入 `sidebar.footer.action`(id=`helmsman:workbench`) | T4.1 | 侧边栏出现「🚀 Helmsman」入口 |
| T4.3 | 面板外壳:`betterSidebar.registerTab({id:'helmsman:workbench'})`,4 个 Tab 切换 | T4.2 | 点击展开 4 面板(研究/PRD/执行/知识) |
| T4.4 | 执行面板:嵌入 ui-dashboard 重构模块 | T3.1 | 「⚡执行」显示调度看板 |
| T4.5 | 研究/PRD 面板:列表 + 草稿编辑 + 「生成」触发 | T4.1 | 调 `POST /api/generate` |
| T4.6 | 知识面板:图谱视图(调 `buildGraph`) | T2.4 | 图谱渲染 |
| T4.7 | host REST:`POST /api/generate`(起一次性预设会话)+ SSE 流式 | T0.1,T1.x | 生成过程流式回显 |
| T4.8 | host REST:状态/归档/检索 endpoint 接通 | T2.x | 面板数据齐全 |
| T4.9 | 自定义指令:复制改造预设 + 个人指令库(prompt 片段) | T4.5 | 预设可复制;指令库一键注入 |
| T4.10 | client/host 单测 + 集成测试 | 各 | 用例绿 |

## Phase 5 — 集成与交付(P1)

| ID | 任务 | 依赖 | 输出/验收 |
|----|------|------|----------|
| T5.1 | 更新 `@helmsman/bundle` 聚合 11 个插件 | 前阶段 | dump-config 见全部插件 |
| T5.2 | 更新 README/FEATURES/使用手册/扩展要求(DSH 搜索、better-sidebar、presets) | 前阶段 | 文档一致 |
| T5.3 | 更新 SECURITY-AUDIT:Deep Research 可选外在豁免 | 前阶段 | 审计覆盖 |
| T5.4 | E2E 冒烟:装齐 → dump-config → `dsh web` → 侧边栏入口 → 研究→PRD→拆解→执行→归档 全链路 | 前阶段 | 全链路可走通 |
| T5.5 | `pnpm test`(全量)+ `pnpm typecheck` + `pnpm build` 绿 | 前阶段 | 三条绿 |

## 建议执行顺序

1. **Phase 0**(T0.1-T0.5):先跑通 Spike,回填 design。
2. **Phase 1 → Phase 2 → Phase 3**:预设/知识/重构三线,可部分并行(Phase 2 依赖 T0.5,Phase 3 独立)。
3. **Phase 4**:依赖 1/2/3 与 T0.4。
4. **Phase 5**:最后集成、文档、审计、E2E。

## 风险提醒

- T0.1(预设会话 API)与 T0.4(client boot 登记)是**两个最大不确定点**,若在 Phase 0 失败,立即走 design §9 回退(生成改独立循环;ui 注入退纯 better-sidebar)。
- ui-dashboard/ui-diff 重构(Phase 3)靠 T3.4 测试兜底,若回归多,先保独立挂载路径可用。
