# WorkMate DSH 插件技术设计文档

**版本**: 0.2.0（正文仍是 0.1.0-draft 的架构设定；**实现现状见 §0**）
**目标读者**: ZCode 开发团队
**DSH 版本要求**: 实装基线 `0.2.1-alpha.1`（内核 peer 写 `*`，见 AGENTS.md 的升级仪式）
**Node 版本要求**: `>=22.19`

> 入库说明：这是项目的宪法文档，原文照录。实现过程中与本机环境冲突的两处假设
> （dsh-tools 版本线、`@deepseek-ai/dsh-mcp-client` 缺位）及插件形态适配
> （Config 用 interface 而非 Schemastery）已在 `openspec/changes/bootstrap-workmate-plugin/design.md`
> 决策记录中修正，以真机验证为准。

## 0. 实现现状（2026-10-07 复核）

> 本节是**与代码同步的事实快照**；下面 §1 起仍是立项时的架构设定（作为意图文档阅读）。
> 里程碑只列到 5，实际已推进到 **M61**，完整清单见 `AGENTS.md` 的里程碑路线表。

### 0.1 规模与门禁

| 维度 | 现状 |
|---|---|
| 工具 | **20 个**（提案 / 知识 / 过程 / 并行 四组） |
| 入口 | 工具 + `/workmate` 斜杠命令 + REST（`/workmate/api/...`）+ 原生面板（看板 / 控制台 / 知识图谱）+ **📚 Wiki 页签** |
| 能力规格 | **28 个** / **83 条 requirement**（`openspec/specs/`） |
| 已归档变更 | **69 个**，0 活动、0 未勾选 |
| 测试 | **339 个用例 / 39 文件**；四条门禁：契约 + 工具链钉版 + 宿主兼容 + **客户端工厂求值** |

### 0.2 新增的核心能力（超出 §1–§9 的原始设计）

1. **判断层（Decision Layer）**——把"高频、封闭、可验证"的判断抽成节点，概率 + 阈值 + 事件留痕：
   6 个消费节点（模块归类 / 注入判定 / 风险分级 / 检索重排 / 任务完成判定 / 审查归级）。
   provider 可切 `agent`（宿主 LLM，**本机已真机跑通**）/ `rules`（确定性）/ `jev`（占位）。
   **D2 纪律**：只有 `act` 档结论才成为事实，`review` 档交给人；失败必须留诊断（`decision-diagnostics.jsonl`）。
2. **知识面 = 本地 markdown + Obsidian**（WeKnora 已放弃）：GitNexus wiki → 导出 vault
   （`index.md` MOC / `modules/` / `iterations/`（`depends_on`·`sequence`·`touches` 三类边）/ `views.md`（Dataview）/ `changelog.md`），
   **归档后自动回写**；人用 Graph+Dataview 读，AI 读同一批 markdown（`workmate_wiki_search` 返回文件:行号）。
3. **检索三层**：词法（grep 式，优先）→ 本地 Ollama 语义（bge-m3，向量哈希缓存）→ 判断层重排
   （只重排候选、绝不丢结果）。
4. **过程纪律**：审批记录与"写码者不得批准"（`merging`/`archiving` 只能人推进）；风险未判定不得进入
   高风险门；`force` 在返回值里显式标注；异常提案可用 `abandon`（记录 actor 与原因）。
5. **并行载体**：`swarm_plan` 按写作用域装批 + `swarm_task` 起/并分支；未合并任务拦归档（编排只**报告**，不派发执行——D1）。

### 0.3 已知边界（诚实声明）

- `workmate_knowledge_query` 的 **`query`（中文概念）** 需 `GITNEXUS_FTS_CJK_SEGMENTATION=bigram` 重建索引才能命中；
  精确查询走**符号名**（`context`/`impact`）不受影响；中文模糊检索请用 `workmate_wiki_search`。
- 归档图覆盖 60/62 迭代（2 个低于 `act` 阈值 → 按纪律留白）；6 个基础层模块无迭代边（证据不足，属事实）。
- 本机 harness 是源码 `tsx` 运行；host 侧改动需 `pnpm build` + 重启（看门狗 `~/.dsh/harness-restart.sh`）。

---

## 1. 项目概述

### 1.1 目标

WorkMate 是一个 DSH 插件 Bundle，围绕「变更提案」这一核心实体，串联需求文档、Git 变更、OpenSpec 归档、GitNexus 知识图谱，实现研发全链路的知识沉淀与并行迭代。

### 1.2 核心能力

- **变更提案管理**：创建、查看、归档提案，关联项目与 Git 提交
- **知识桥接**：通过 MCP 接入 GitNexus，通过 HTTP 接入 WeKnora
- **并行编排**：复用 `dsh-swarm-orchestrator` 驱动多任务并行执行
- **归档闭环**：变更完成后自动触发 OpenSpec 归档与 GitNexus 索引重建

### 1.3 设计原则

- **寄生而非替代**：UI 全部注入 DSH 原生界面，不另起 Web 应用
- **复用优先**：@快捷指令、Git 面板、并行编排、MCP 桥接均使用社区验证插件
- **自建聚焦**：只实现「变更提案中间层」和「知识串联逻辑」

## 2. 系统架构

### 2.1 整体分层

```
┌─────────────────────────────────────────────────────────────┐
│                    Client 半（浏览器）                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ 提案面板 Tab │  │ 知识图谱 Tab │  │ @快捷指令（依赖第三方）│  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                    Host 半（Node.js）                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ 提案服务     │  │ 知识桥接服务 │  │ 归档编排服务         │  │
│  │ proposal.ts │  │ knowledge.ts│  │ archive.ts          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                    复用插件层                                │
│  dsh-swarm-orchestrator │ @deepseek-ai/dsh-mcp-client       │
│  @hucj/dsh-file-mention │ 其他社区插件                       │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Host 半与 Client 半通信

Host 与 Client 通过 DSH 的 RPC 机制通信，契约定义在 `shared/contracts/` 中。Host 半注册工具和服务，Client 半通过注入的 API 调用。

**禁止跨边界 import**：Host 半代码不能 import Client 半模块，反之亦然。只能通过契约类型和 RPC 通信。

## 3. 核心模块设计

### 3.1 Host 半模块

#### 3.1.1 插件入口（`src/index.ts`）

遵循 DSH 命名空间插件形态，导出 `name`、`inject`、`Config`、`apply` 四个具名导出：

```typescript
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config'

export const name = 'workmate'
export const inject = ['tools', 'git', 'session']
export const Config = { /* Schemastery schema */ }

export function apply(ctx: Context, config: Config) {
  // 注册提案服务
  // 注册知识桥接服务
  // 注册归档编排服务
}
```

**关键约束**：`name` 必须与 `cordis.patch.yml` 中的 `id` 和 `package.json` 中的 `dsh.bundle` 指向一致。

#### 3.1.2 提案服务（`src/features/proposal/`）

**数据模型**：

```typescript
interface Proposal {
  id: string              // 如 "batch-grading-v2"
  title: string           // "批量批改 v2.1"
  status: 'draft' | 'executing' | 'archived'
  projects: string[]      // 关联项目标识
  commits: string[]       // 关联的 Git commit hash
  openspecChangeId: string // OpenSpec change ID
  createdAt: string
  updatedAt: string
}
```

**持久化**：存储于 `$DSH_HOME/workmate/proposals.json`，零外部依赖，可 grep。

**工具注册**：

| 工具名 | 参数 | 作用 |
|--------|------|------|
| `workmate_proposal_create` | `{ id, title, projects }` | 创建提案，同时在 `openspec/changes/` 下生成标准目录 |
| `workmate_proposal_status` | `{ id }` | 返回提案详情 + Git 变更 + OpenSpec 状态 |
| `workmate_proposal_archive` | `{ id }` | 触发归档编排 |

**Git 关联逻辑**：监听 DSH 的 Git 事件，解析提交信息中的 `[proposal:<id>]` 标记，自动关联。

#### 3.1.3 知识桥接服务（`src/features/knowledge-bridge/`）

**GitNexus MCP 接入**：不自己实现 MCP 客户端，而是通过 `cordis.patch.yml` 配置官方 MCP 客户端插件：

```yaml
- id: mcp-gitnexus
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: gitnexus
    transport: stdio
    command: npx
    args: ['-y', 'gitnexus@latest', 'mcp']
```

GitNexus 提供 `query`、`context`、`impact`、`detect_changes` 等工具，注册后以 `mcp__gitnexus__query` 形式暴露给模型。

**WeKnora 桥接**：若 WeKnora 无 MCP server，在 Host 半实现 HTTP 客户端，注册 `workmate_knowledge_search` 工具，内部调用 WeKnora REST API，返回 Top-3 相关片段。

#### 3.1.4 归档编排服务（`src/features/archive/`）

**归档流程**：

```
提案归档触发
    ↓
从 OpenSpec tasks.md 生成 swarm 任务 DAG
    ↓
调用 swarm_dispatch 并行执行
    ↓
等待所有任务完成
    ↓
执行 openspec archive <id> --yes
    ↓
执行 gitnexus analyze --embeddings
    ↓
更新提案状态为 archived
```

**OpenSpec 归档命令**：参考社区验证的 workflow：

```bash
openspec archive <change-id> --yes
openspec validate --strict
```

**Swarm 集成**：从提案的 `tasks.md` 解析任务列表，转换为 `swarm_dispatch` 的 `tasks[]` 参数格式。每个 task 声明 `writes` 字段限制文件范围，避免并发冲突。

### 3.2 Client 半模块

#### 3.2.1 插件入口（`src/client/index.tsx`）

Client 半通过 `dsh.client` 声明，在 DSH 的 slot 系统中注册 UI 组件。遵循与 Host 半相同的契约，通过 RPC 调用 Host 服务。

#### 3.2.2 提案面板（`src/client/features/proposal-panel/`）

**注入位置**：DSH 主区域 Tab 或对话流上方状态条。

**UI 结构**：

```
┌─────────────────────────────────────┐
│ 提案：批量批改 v2.1         [归档]  │
│ 状态：● 执行中                       │
├─────────────────────────────────────┤
│ 关联项目                             │
│  · 作业模块-core          [查看图谱] │
├─────────────────────────────────────┤
│ Git 变更                             │
│  · feat: 批量批改接口     [查看 diff] │
├─────────────────────────────────────┤
│ OpenSpec                             │
│  ○ 提案中 → ● 执行中 → ○ 已归档      │
└─────────────────────────────────────┘
```

**数据来源**：通过 RPC 调用 `workmate_proposal_status` 获取完整数据。

#### 3.2.3 知识图谱（`src/client/features/knowledge-graph/`）

**注入位置**：右侧 Sidebar 标签页（参考 Codingns4DSH 的 Git 面板模式）。

**技术选型**：`@antv/g6` 或 `cytoscape.js`。

**数据源**：Host 半聚合 OpenSpec `changes/` 目录、GitNexus MCP 返回、提案关联数据，通过 RPC 推送。

**节点类型**：需求节点、项目节点、Git 提交节点。边类型：`需求—[涉及]→项目`、`项目—[Git提交]→提交记录`。

#### 3.2.4 @快捷指令

**直接依赖** `@hucj/dsh-file-mention`，不自己实现。该插件在输入框输入 `@` 时弹出工作区文件菜单，支持 git 驱动过滤、目录引用、实时过滤。

## 4. 配置定义

### 4.1 插件配置（`Config` 对象）

使用 Schemastery 定义，在 `apply(ctx, config)` 中接收：

```typescript
const Config = Schema.object({
  workmateHome: Schema.string().default('workmate'),
  maxConcurrent: Schema.number().default(3),      // swarm 并发上限
  gitnexusEnabled: Schema.boolean().default(true),
  weknoraBaseUrl: Schema.string().default(''),
  openspecRoot: Schema.string().default('openspec'),
})
```

### 4.2 profile 配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: workmate
      name: '@your-org/workmate4dsh'
      config:
        maxConcurrent: 3
        openspecRoot: 'openspec'
    - id: swarm
      require: dsh-swarm-orchestrator
      config:
        maxTotalConcurrentAgents: 3
    - id: mcp-gitnexus
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: gitnexus
        transport: stdio
        command: npx
        args: ['-y', 'gitnexus@latest', 'mcp']
```

### 4.3 package.json 声明

```json
{
  "name": "@your-org/workmate4dsh",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-tools": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-invariants": "^0.1.1-rc.2"
  }
}
```

## 5. 依赖清单

### 5.1 DSH 官方依赖

| 包 | 用途 |
|----|------|
| `@deepseek-ai/cordis` | 插件运行时类型 |
| `@deepseek-ai/dsh-tools` | 工具注册 API |
| `@deepseek-ai/dsh-mcp-client` | MCP 桥接 |

### 5.2 社区插件依赖

| 插件 | 用途 | 安装方式 |
|------|------|----------|
| `dsh-swarm-orchestrator` | 并行任务编排 | `dsh plugin --profile web add` |
| `@hucj/dsh-file-mention` | @快捷指令 | `dsh plugin --profile web add` |

### 5.3 外部工具依赖

| 工具 | 用途 | 要求 |
|------|------|------|
| GitNexus | 代码知识图谱 | Node >= 18，目标仓库已 `gitnexus analyze` |
| OpenSpec | 提案管理 | 项目根目录有 `openspec/` 目录 |
| WeKnora | 知识检索（可选） | 提供 REST API 端点 |

## 6. 关键风险与规避

| 风险 | 规避措施 |
|------|----------|
| DSH 版本兼容性 | 安装期和运行期均检查 `@deepseek-ai/*` 版本范围 |
| loader id 错位 | `cordis.patch.yml` 的 id、`package.json` 的 `dsh.bundle`、Host 半导出的 `name` 三处一致，CI 中加入静态检查 |
| MCP 工具名冲突 | `serverName` 在存活实例中唯一，DSH 自动加 `mcp__<server>__` 前缀 |
| Swarm 并发过高 | WorkMate 配置覆盖 `maxTotalConcurrentAgents: 3` |
| Context 注入质量 | 生成 Task Brief 前对检索结果做 LLM 二次过滤，保留 Top-3 |

## 7. 里程碑与验收

### 里程碑一：插件骨架与依赖装配

**交付**：插件在 DSH `web` profile 中加载，依赖插件就位。

**验收**：`dsh --profile web --dump-config` 显示 WorkMate 层；`dsh web` 终端出现加载日志。

### 里程碑二：变更提案中间层

**交付**：提案面板可创建、查看、归档，串联 Git 变更和 OpenSpec 状态。

**验收**：Agent 调用 `workmate_proposal_create` 后提案出现在面板；`openspec/changes/` 下目录自动生成。

### 里程碑三：知识桥接与 MCP 集成

**交付**：Agent 可调用 `mcp__gitnexus__query` 和 `workmate_knowledge_search`；`@` 菜单可用。

**验收**：向 Agent 发「查一下评分流程」，Agent 调用 GitNexus MCP 工具返回结果。

### 里程碑四：并行编排接入与归档闭环

**交付**：归档触发 swarm 并行执行，完成后 OpenSpec 归档 + GitNexus 索引重建。

**验收**：提案归档时 swarm 看板显示并行任务状态；归档完成后 `openspec/changes/archive/` 出现目录，`gitnexus analyze` 执行成功。

### 里程碑五（可选）：知识图谱可视化

**交付**：右侧 Sidebar 展示「需求 ↔ 项目 ↔ Git 提交」关系图。

**验收**：知识图谱展示至少 3 层关联。

> **里程碑现状**：本节只写了立项时的 5 个里程碑。实际路线已到 **M61**，逐条状态
> （含每次变更的归档名）见 `AGENTS.md` §里程碑路线，此处不再复制以免漂移。

## 8. 开发规范

### 8.1 代码组织

- Host 半和 Client 半严格分离，通过 `shared/contracts/` 定义 RPC 契约
- 使用 TypeScript 严格模式，`tsconfig.json` 中开启 `strict: true`
- 每个 feature 目录自包含：类型、逻辑、测试

### 8.2 测试要求

- Host 半逻辑单元测试覆盖核心路径（提案 CRUD、归档编排）
- 契约测试验证 Host ↔ Client RPC 一致性
- 集成测试验证 MCP 工具注册和调用

### 8.3 发布流程

```bash
pnpm build          # 编译 Host + Client
pnpm typecheck      # 类型检查
pnpm test           # 运行测试
pnpm pack           # 生成 tarball
dsh plugin --profile web add ./workmate4dsh-0.1.0.tgz
```

### 8.4 参考实现

- 骨架与分层：`dsh-plugin-framework`（FSD 结构）
- 多引擎驱动：Codingns4DSH 的 Agent 适配器模式
- Swarm 集成：`dsh-swarm-orchestrator` 的 `swarm_dispatch` 工具用法
- OpenSpec 归档：Accesserty/UI-Kit 的 `openspec-archive.md` workflow

## 9. WorkDSH 基础设施复用与参考

> 证据等级（沿用 `docs/DSH-INTEGRATION-NOTES.md` 惯例）：
> **[W-已核]** = 2026-09-29 对 github.com/techflag/workdsh 公开文档逐篇核对
> （README、docs/architecture.en.md、docs/user-guide.en.md、docs/plugin-ecosystem.en.md、
> docs/README.en.md）；**[W-待确认]** = 仅见于需求侧描述、公开文档中不存在。
> WorkDSH 定位为 WorkBuddy 式通用桌面工作台，与 WorkMate（研发编排层）产品定位不重叠。

### 9.1 项目 / 专家 / 技能的组织模型

**WorkDSH 的设计**：[W-已核] README 确认「Experts save role and capability settings」
「skills carry callable instructions and resources」「Projects bring instructions, plans,
tasks, material, and capability settings together」。**专家→Preset→Session 三层模型
[W-待确认]**：全部五篇公开文档中均无 Preset/Session 概念（逐篇核对为空）。相邻旁证：
WorkBuddy 原作的会话绑定序列（prepare-session → workspace.create → session.create）在
`DSH-INTEGRATION-NOTES.md` §B 有记录，且 Helmsman 时期实测其标识符在自己代码里 0 命中。

**复用决策**：借鉴思想，不移植模型。Proposal ≠ 专家——专家是静态能力描述，Proposal
是带状态机的动态工作单，硬套三层会把 WorkBuddy 序列踩过的坑重踩一遍。Proposal 的
真实对位是「Session 级执行实例」；有价值的启发是给编排任务补**能力组装维度**
（Preset 的职责：模型 / 工具 / 技能 / 连接器的组合描述）。

**落地方式**：不新增实体层。在 `src/features/archive/orchestrate.ts` 已预留的
`runSwarmTasks(tasks, root)` 接口上扩展 per-task 执行配置：

```ts
// 未来 swarm 接入时的接口演进（现为记录性跳过）：
interface SwarmTaskConfig {
  title: string
  writes: string[]                 // 文件范围（已有）
  agent?: 'claude' | 'codex' | …   // 能力组装：执行引擎
  skills?: string[]                // 能力组装：携带的技能
  done?: string[]                  // 幂等验收谓词：文件存在 / 命令通过（见 9.2）
}
runSwarmTasks(tasks: SwarmTaskConfig[], root: string): Promise<string>
```

**并行执行载体的 Git 决策**（2026-09-29 补充）：一个项目内多任务并行采用
**每任务一个 worktree + 独立分支**，不是纯分支。理由：git 单工作目录只能检出
一个分支，多任务并行必须多目录；worktree 共享对象库（秒级检出、磁盘只付工作区
差异）且 git 原生阻止同一分支被两个 worktree 同时检出（防呆）。物理隔离不解决
逻辑冲突——沿用 Helmsman 三层纪律：`writes` 声明防踩踏、冲突域（仓库:模块）排队、
patch 式 `git apply` 合并 + 按 agent/file 裁决重试。编排生命周期：提案进入执行中
→ 按任务建 `<项目根>/.worktrees/<proposal-id>-<task>/` 与独立分支 → swarm 并行
→ 合并回项目主分支 → 归档编排对主分支执行 → 清理 worktree。项目注册表的
root 指向 worktree 已真机兼容（`svc-billing-wt` 场景）。

**对现有设计文档的修改建议**：§3.1.4 归档编排的「Swarm 集成」段补一句——每个 task
除 `writes` 外可声明能力组装（agent/skills）与验收谓词，来源仍是 tasks.md 的
结构化解析。

### 9.2 多 Agent 执行与协同的边界处理

**WorkDSH 的设计**：「writeScopes 不是锁」「能力授权与数据写入两维度」的论述
**[W-待确认]**——在 WorkDSH 公开文档中不存在（README / architecture / user-guide /
plugin-ecosystem 四篇逐条核对为空），该观点不能作为「WorkDSH 已验证基础设施」引用。
但观点本身与本仓两条既有实践同构：swarm task 的 `writes` 字段声明、Helmsman 看板的
冲突域 WIP（`仓库:模块` 粒度）+ 原子合并（patch 式 `git apply`，冲突整批失败）。

**复用决策**：借鉴观点、不新增机制。「writes 不是锁」的正确推论是：文件范围声明防
意外踩踏，防并发逻辑冲突靠**幂等 + 验收谓词**——而 WorkMate 编排已经天然幂等
（已归档 → skipped 的重试语义经真机验证），缺的只是每个任务的「完成判据」。

**落地方式**：在 9.1 的 `SwarmTaskConfig.done` 谓词上落地：swarm 任务完成后编排逐条
核验（文件存在 / 命令退出码 0），不满足则该任务标记未收敛、整批可重试；与 tasks.md
生成逻辑的结合点是 OpenSpec 任务行 → `done` 谓词的映射（`[x]` 勾选即验收声明）。
不引入锁、不引入领域修订框架。

**对现有设计文档的修改建议**：§6 风险表「Swarm 并发过高」行下补一行——「并发写入
冲突：writes 声明仅防意外踩踏，一致性由任务幂等 + done 验收谓词 + 整批重试保证」。

### 9.3 Skill 与 Plugin 的边界划分

**WorkDSH 的设计**：[W-已核] README 明确「A skill usually consists of instructions
and resources containing SKILL.md; it can be installed directly into the local DSH
Skills directory and is not necessarily a plugin」且「WorkDSH's skill manager is a
DSH plugin」——管理技能的软件是 Plugin，Skill 本身是内容。DSH 原生的项目级技能根
`<项目根>/.dsh/skills/<name>/SKILL.md` 已在 Helmsman 笔记（C 级）核对。

**复用决策**：借鉴边界定义，落两类资产：
- **保持 Plugin**：提案状态机、归档编排、知识桥接、REST/UI——一切需要宿主服务、
  状态与子进程纪律的面。归档**编排**绝不能做成 Skill：目录搬回、幂等语义、多项目
  循环都需要宿主上下文，交给 Agent 自由发挥会丢失正确性。
- **新增 Skill 资产**：纯指令性内容。「归档前验收清单」（何时可勾 tasks、提交信息
  如何带 `[proposal:<id>]`）、「知识工具使用指南」（query/context/impact 的选择）
  适合 SKILL.md。

**落地方式**：包内嵌技能目录 + 幂等同步（沿用 Helmsman presets 的纪律：只补缺、
永不覆盖用户目录）：

```
skills/
├── archive-checklist/SKILL.md     # 归档前验收清单（Agent 会话内自查）
└── knowledge-usage/SKILL.md       # 知识工具选择指南
src/skills.ts                      # 同步到 $DSH_HOME/skills/（幂等，Config 开关）
```

**对现有设计文档的修改建议**：§3.1 新增 3.1.5「Skill 资产」小节，写明上述边界与
同步纪律；§1.3 设计原则补一句「流程编排是 Plugin，操作规范是 Skill」。

### 9.4 与 DSH 生态的集成方式

**WorkDSH 的设计**：[W-已核] 连接两个独立目录——SkillHub（Tencent SkillHub API，
捆绑 `@cocofhu/skillhub` 插件）与 dsh-market（第三方插件，位于既有插件页内）；
生态宣言三原则（组合优先 / 清晰声明 / 兼容优先），但明确「There is no online market
page or installer today」。桌面侧用 unmodified 上游 submodule + `upstream.json` 钉
上游版本；功能包由 `workdsh-bundle` 组合。

**复用决策**：
- **不接入 SkillHub / dsh-market**：目录 UI 是工作台职责，与「寄生而非替代」冲突；
  WorkMate 的 bundle 清单（`cordis.patch.yml`）本身就是装配目录。
- **借鉴 `upstream.json` 的钉版治理**：WorkMate 的依赖版本线目前散落在 design 决策
  文档里，应工具化——Helmsman 已验证过同一模式（`toolchain.json` +
  `check-toolchain.mjs --structural`）。
- **不维护自己的插件/Skill 目录**：Skill 资产随包分发（9.3），无独立目录需求。

**落地方式**：

```jsonc
// toolchain.json — 版本治理唯一权威源（移植自 Helmsman 已验证实现）
{
  "require": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-tools": "0.1.2-alpha.5"
  },
  "profile": { "dsh": "0.1.7-rc.2" }
}
```

`pnpm verify:toolchain` 并入 contract 门禁（`pnpm verify:contract` 同级），CI 只在
该文件变更时触发。

**对现有设计文档的修改建议**：§6 风险表「DSH 版本兼容性」行的规避措施改为
「`toolchain.json` + 结构化校验脚本门禁」；§5.1 依赖表补版本列指向该文件。

### 9.5 交付物工作区（Deliverable Workspace）

**WorkDSH 的设计**：[W-已核] README：「The deliverable workspace previews or edits
supported working copies of documents, spreadsheets, presentations, HTML, and
PDF」，工作流为「File in library ──reference──> Project task ──choose──> Expert /
Skill / Connector」；Alpha 阶段明确警告「Preview, editing, and export fidelity
differ by format」。

**复用决策**：借鉴概念、自建轻量实现、**不复用其组件**。理由：1) 该工作区是桌面
载体（`workdsh-web/`）的功能面，不是可嵌入的 client 模块；2) Alpha 保真度声明；
3) WorkMate 的交付物是**代码变更**，需要的不是文档编辑器而是变更摘要视图。

**落地方式**：归档编排产出 manifest 而非引入工作区组件：

```ts
// orchestrate.ts 归档成功后随 step 产出，落 proposals.json 的归档条目：
interface ArchiveManifest {
  archivedAt: string
  projects: Array<{
    project: string
    commits: string[]          // 归档区间内关联提交（git log 扫描已有）
    diffStat?: string          // git diff --stat <base>..<head> 摘要
    specsUpdated: boolean      // openspec archive 是否更新了主 specs
    reindexed: boolean         // gitnexus analyze 是否成功
  }>
}
```

看板「已归档」列卡片展开后渲染该 manifest（复用现有详情区，无新页面）。

**对现有设计文档的修改建议**：§3.2.2 提案面板补「归档交付物摘要」子视图说明
（数据源 ArchiveManifest，M5+ 排期）。

### 9.6 桌面载体（Desktop Carrier）

**WorkDSH 的设计**：[W-已核，architecture.en.md 证据最足] 「WorkDSH Desktop is an
Electron carrier for one pinned DeepSeek Harness Profile」；内置 Node/Python 运行时；
`deepseek-harness/` 是 unmodified upstream submodule，`upstream.json` 记录唯一上游
版本；`app.asar` 只含 Electron 入口、无第二份 `node_modules`；明确「None is a second
Desktop or a second DSH installation inside Electron」。桌面安装包 2.0.6-alpha.1
为计划发布（README）。

**复用决策**：**不做桌面载体，保持纯插件**；以「可被 WorkDSH Desktop 组合」为兼容
目标。理由：1) 载体是 Profile 级职责，插件做载体直接违反「寄生而非替代」；2) WorkDSH
的组合方式（功能包由运行时 Profile 组合）意味着 DSH 插件天然可进其 Profile，零适配；
3) 自建 Electron 即第二个运行时，违反 WorkDSH 与 Helmsman 共同验证的「不维护修改版
上游」纪律。

**落地方式**：无代码改动。唯一动作是把兼容性验证列入选题：待 WorkDSH 桌面包实际
发布后，在其 pinned Profile 的 DSH 版本内实测 WorkMate 装载（当前 Alpha 未发布，
[W-待确认] 其 Profile 的实际 DSH 版本线）。

**对现有设计文档的修改建议**：§5.3 外部工具依赖表加一行「桌面载体（可选）：
WorkDSH Desktop——纯组合关系，无代码依赖」；§7 里程碑表后补「兼容性目标」一段。

### 9.7 诚实声明（证据边界）

需求描述中的三项设计——「专家→Preset→Session 三层模型」「writeScopes 不是锁 /
Subagent / Agent Team 协作边界」「架构文档讨论授权边界」——经 2026-09-29 对 WorkDSH
公开文档逐篇核对，**均不存在**；本文按「观点价值」而非「WorkDSH 已验证设施」处理，
全部标注 [W-待确认]。Subagent 是 DSH 上游原生能力（`dsh-subagent-fork-in-process` /
`dsh-subagent-spawn-in-process`），与 WorkDSH 无关。若 WorkDSH 后续文档补齐上述设计，
应重新评估 9.1 / 9.2 的结论。

**文档结束**
