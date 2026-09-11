# ⚓ Helmsman — 基于 DeepSeek Harness 的 Agent 舰队指挥中心

Helmsman 是一套构建在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
「一切皆插件」架构上的 ADE（Agent Development Environment）：在一个看板上同时指挥
**Claude Code、Codex、Pi、oh-my-pi** 等多个 AI 编程 Agent，在独立的 **Git Worktree**
中并行执行同一任务，自动收集 diff、标注冲突，并支持按 Agent / 按文件择优合并回主仓库。

```
┌────────────────────────────────────────────────────────────────────┐
│  dsh web (127.0.0.1:3080)                                          │
│   ├─ DSH 聊天页 侧边栏 🚀 Helmsman → 工作台抽屉                     │
│   │    [📚研究] [📋PRD] [⚡执行] [🕸️知识]                          │
│   ├─ /helmsman-dashboard/   执行看板（任务编排、Agent 卡片、配置）  │
│   ├─ /helmsman-diff/        多 Agent Diff 对比 + 合并               │
│   └─ /helmsman-workbench/   工作台独立页（同抽屉内容）              │
│                                                                    │
│  cordis 插件树（@helmsman/bundle 一次装入）                         │
│   worktree ──▶ orchestrator ◀── adapter-{claude,codex,pi,oh-my-pi}  │
│   memory-topology ──┘        │                                     │
│   knowledge-tolaria（vault/检索/图谱）                              │
│   artifacts（产物注册表：草稿/笔记/拓扑/任务包 下载交付）           │
│   presets（研究/PRD/拆解/需求分析 预设 + 生成工具）                 │
│   ui-workbench（DSH client bundle：侧边栏入口 + 抽屉面板）          │
└────────────────────────────────────────────────────────────────────┘
```

## 交付物

| 插件                                                                | 类型            | 说明                                                                                                                                                   |
| ------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@helmsman/worktree`](packages/worktree)                          | Service         | Worktree 调度：创建/清理/收集 diff/patch 合并，惰性集成`dsh-virtual-workspace`                                                                       |
| [`@helmsman/memory-topology`](packages/memory-topology)            | Service + Tools | 项目拓扑记忆（PRD §3.2 数据模型），Maven 父 POM / REST API 扫描，docker-compose / K8s / OpenAPI 导入，YAML 导出，最佳努力镜像到`dsh-memory-manager` |
| [`@helmsman/knowledge-tolaria`](packages/knowledge-tolaria)        | Service         | **L4 知识层**：Tolaria vault 归档门面（仅定稿）+ 全文检索 + 项目知识图谱（消费 topology）                                                          |
| [`@helmsman/artifacts`](packages/artifacts)                        | Service         | 产物交付注册表：sha256 内容寻址（同内容去重）+ 原子清单 + CJK 安全下载头；宿主经 `ctx.get` 懒取                                                  |
| [`@helmsman/board`](packages/board)                                | Service         | **任务工作项层**：跨四阶段聚合根（需求→规格→开发→归档），引用式关联（文档/对话/run/服务/产物），DoR/DoD 门与冲突域 WIP；`~/.helmsman/board` 持久化 |
| [`@helmsman/orchestrator`](packages/orchestrator)                  | Service + Tools | 多 Agent 并行调度引擎：限流退避重试、断路器、取消、冲突标注、合并/放弃，`helmsman_run_parallel` 等 4 个工具                                          |
| `@helmsman/adapter-claude` / `-codex` / `-pi` / `-oh-my-pi` | Agent Adapter   | 非交互 CLI 执行（无 shell、argv 数组、超时/取消、流式日志），命令与参数可配置                                                                          |
| [`@helmsman/presets`](packages/presets)                            | Agent 预设 + Tools | **L1/L2 生成**：研究 / PRD / 拆解 / 需求分析 4 个 agent 预设（同步进 DSH roster）+ `helmsman_research` 等 4 个生成工具（走 `helmsman.generator` 引擎） |
| [`@helmsman/ui-dashboard`](packages/ui-dashboard)                  | Web UI          | 主控面板 React SPA（PRD 第 4 章规范全量实现；同时导出可嵌入视图模块 `./client/embed`）                                                                  |
| [`@helmsman/ui-diff`](packages/ui-diff)                            | Web UI          | 多 Agent Diff 对比：split / unified / side-by-side、冲突标注与方案选择、行级评论、合并（同样可嵌入）                                                    |
| [`@helmsman/ui-workbench`](packages/ui-workbench)                  | Web UI + DSH client | **工作台**：DSH 网页侧边栏「🚀 Helmsman」入口 + 右侧抽屉（研究/PRD/执行/知识/交付物 5 面板）+ 生成/草稿/归档/指令库 REST；DSH client bundle 注入 `shell.overlay` |
| [`@helmsman/ui-board`](packages/ui-board)                          | Web UI          | **任务看板**（独立页 `/helmsman-board/`）：四列卡片 + 摘要与角标、URL 状态筛选、冲突域 WIP 与排队、详情抽屉（关联跳转 + 推进门）、run 实时面板（冲突只标注并跳 diff，不代裁决） |
| [`@helmsman/bundle`](packages/bundle)                              | Bundle          | 一条命令装入全部 15 个插件                                                                                                                              |

文档：[架构说明](docs/ARCHITECTURE.md) · [UI 规范符合性矩阵](docs/UI-COMPLIANCE.md) ·
[安全审计报告](docs/SECURITY-AUDIT.md) · [使用手册](docs/USAGE.md) ·
[分发与发布指南](docs/DISTRIBUTION.md)

## 快速开始

前置：Node `^22.19 || >=24`、pnpm ≥10、可运行的 dsh CLI（`deepseek-harness` 仓库 `apps/cli`）。

```bash
# 1) 构建（各插件 esbuild 打包 + 类型检查）
pnpm install && pnpm build

# 2) 安装复用的社区插件（PRD 第 1 步，不要重写它们）
dsh plugin --profile web add -w github:KevinWen7415/dsh-virtual-workspace
dsh plugin --profile web add -w https://github.com/MoonlitDropOfBlood/dsh-memory-manager/releases/download/v1.2.0/dsh-memory-manager-1.2.0.tgz
dsh plugin --profile web add -w github:lovezi0/dsh-memory-palace

# 3) 安装 Helmsman 全部插件（在仓库根目录执行；相对路径按调用目录锚定）
for p in worktree memory-topology knowledge-tolaria orchestrator adapter-claude \
         adapter-codex adapter-pi adapter-oh-my-pi presets ui-dashboard ui-diff \
         ui-workbench; do
  dsh plugin --profile web add -w ./packages/$p
done
#   或逐个安装后安装 bundle：dsh plugin --profile web add -w ./packages/bundle

# 4) 验证插件树注册成功
dsh --profile web --dump-config | grep helmsman   # 应看到 15 个 helmsman-* 条目

# 5) 启动
dsh web          # 打开 http://127.0.0.1:3080/helmsman-dashboard/
```

> 注意：`dsh plugin add` 会把参数转发给 pnpm；在本仓库根目录执行时需要 `-w`
> （profile 目录本身是一个 pnpm workspace）。`pi` / `oh-my-pi` 适配器的 CLI 参数
> 模板按常见版本预设，若你的安装版本不同，可在 profile 的 `cordis.patch.yml`
> 用户层覆盖（示例见各适配器 README）。

## 分发给其他人

4 种方式（详见 [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md)）：

1. **克隆源码**：收件人克隆本仓库，`pnpm install && pnpm build` 后
   `dsh plugin add -w ./packages/<pkg>`（团队内协作）。
2. **npm 发布**（正式对外）：`pnpm publish` 各包（含 `@helmsman/bundle`），
   收件人一条命令 `dsh plugin --profile <p> add @helmsman/bundle` 装齐全部插件。
3. **私有 registry**：Verdaccio/Nexus 等，发布命令与 2 相同。
4. **tarball 直发**（无 registry）：`pnpm pack` 出 15 个 tgz 分发给收件人，
   `dsh plugin --profile <p> add file:/path/to/helmsman-*.tgz`。
   该路径已在本机 `helmsman-dist` profile 端到端验证（安装 → dump-config →
   启动 → UI 200）。

> 版本同步：10 个包统一版本号；`@deepseek-ai/cordis` 与可选
> `@deepseek-ai/dsh-tools` 均为 peer 依赖，跟随宿主 harness 实例，
> 不打包私有副本（避免与宿主 dsh-llm 导出漂移）。

## 验证

```bash
pnpm test          # 73 个单元/集成测试（含真实 git worktree 集成测试、vault/图谱、预设工具）
pnpm typecheck     # 全部包 tsc --noEmit 通过
pnpm build         # esbuild host 产物 + React client IIFE/ESM + DSH client bundle + d.ts
```

端到端（真实 harness 已验证）：创建项目群 → 配置服务仓库 → 提交并行任务 →
观察 Agent 卡片状态机（CREATING_WORKTREES → RUNNING → AGGREGATING → COMPLETED /
PARTIAL_FAILED / ALL_FAILED）→ 在 Diff 视图查看对比 → 合并回主仓库。
Workbench 链路（真实模型验证）：侧边栏 🚀 Helmsman → 抽屉 → 研究生成（预设
会话 + DeepSeek 模型，~30s）→ 草稿查看 → ✅ 归档进 Tolaria vault；自定义指令库
一键填入运行。

## 安全要点（详见 [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md)）

- 所有子进程调用（git / agent CLI）使用 `execFile`/`spawn` + **argv 数组，无 shell**；
- worktree id / 分支 / 路径强制字符集校验与 `rootDir` 越界检查；
- 合并 patch 经 stdin 传入，不落临时文件；merge 冲突时主仓库保持原状；
- 扫描器有深度 / 文件数 / 文件大小上限与符号链接逃逸检查；
- 无 `eval`/`Function`、零第三方运行时依赖（社区插件除外）；
- 核心闭环**无网络外发**；唯一外发是 Workbench 生成（Deep Research 等）——
  走 **DSH 原生 agent 会话**，由用户自己配置的模型/密钥发出，与在 DSH 里聊天
  同面，Helmsman 不接触密钥、不新增网络端点（审计 §1.3 豁免声明）；
- 生成引擎有递归分叉闸门（AsyncLocalStorage）+ 单 turn 240s 超时熔断；
- 草稿留在本地 `~/.helmsman/workbench/`，仅用户显式「✅ 归档」的定稿写入
  Tolaria vault（纯本地文件，无网络）。

## 复用策略落实情况（PRD 第二章）

| PRD 要求                                               | 落实                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 直接复用`dsh-virtual-workspace`                      | ✅ worktree 插件惰性解析`vws` 服务，创建的 worktree 注册为命名虚拟工作区（未安装则优雅降级） |
| 直接复用`dsh-memory-manager` + `dsh-memory-palace` | ✅ topology 保存时最佳努力镜像快照到`memoryManager`；palace 按其设计仅经 agent 工具使用      |
| 参考`dsh-Visual-Workflow`                            | ✅ 采用其「webServer prefix 路由挂载自有 GUI API」的第三方 UI 模式与「画布状态轮询」思想       |
| 参考`kalifun/helmsman`                               | ✅ 「任务即会话」卡片式看板与状态机视觉反馈                                                    |
