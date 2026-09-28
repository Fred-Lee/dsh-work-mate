# WorkMate DSH 插件技术设计文档

**版本**: 0.1.0-draft
**目标读者**: ZCode 开发团队
**DSH 版本要求**: `>=0.1.5-rc.3 <=0.1.7-rc.2`
**Node 版本要求**: `>=22.19`

> 入库说明：这是项目的宪法文档，原文照录。实现过程中与本机环境冲突的两处假设
> （dsh-tools 版本线、`@deepseek-ai/dsh-mcp-client` 缺位）及插件形态适配
> （Config 用 interface 而非 Schemastery）已在 `openspec/changes/bootstrap-workmate-plugin/design.md`
> 决策记录中修正，以真机验证为准。

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

**文档结束**
