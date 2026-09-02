# ⚓ Helmsman — 基于 DeepSeek Harness 的 Agent 舰队指挥中心

Helmsman 是一套构建在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
「一切皆插件」架构上的 ADE（Agent Development Environment）：在一个看板上同时指挥
**Claude Code、Codex、Pi、oh-my-pi** 等多个 AI 编程 Agent，在独立的 **Git Worktree**
中并行执行同一任务，自动收集 diff、标注冲突，并支持按 Agent / 按文件择优合并回主仓库。

```
┌────────────────────────────────────────────────────────────────────┐
│  dsh web (127.0.0.1:3080)                                          │
│   ├─ /helmsman-dashboard/   主控面板（任务编排、Agent 卡片、配置）    │
│   └─ /helmsman-diff/        多 Agent Diff 对比 + 合并               │
│                                                                    │
│  cordis 插件树（@helmsman/bundle 一次装入）                          │
│   worktree ──▶ orchestrator ◀── adapter-{claude,codex,pi,oh-my-pi}  │
│   memory-topology ──┘        │                                     │
│   （可选：dsh-virtual-workspace / dsh-memory-manager 等社区插件复用） │
└────────────────────────────────────────────────────────────────────┘
```

## 交付物

| 插件 | 类型 | 说明 |
|------|------|------|
| [`@helmsman/worktree`](packages/worktree) | Service | Worktree 调度：创建/清理/收集 diff/patch 合并，惰性集成 `dsh-virtual-workspace` |
| [`@helmsman/memory-topology`](packages/memory-topology) | Service + Tools | 项目拓扑记忆（PRD §3.2 数据模型），Maven 父 POM / REST API 扫描，docker-compose / K8s / OpenAPI 导入，YAML 导出，最佳努力镜像到 `dsh-memory-manager` |
| [`@helmsman/orchestrator`](packages/orchestrator) | Service + Tools | 多 Agent 并行调度引擎：限流退避重试、断路器、取消、冲突标注、合并/放弃，`helmsman_run_parallel` 等 4 个工具 |
| `@helmsman/adapter-claude` / `-codex` / `-pi` / `-oh-my-pi` | Agent Adapter | 非交互 CLI 执行（无 shell、argv 数组、超时/取消、流式日志），命令与参数可配置 |
| [`@helmsman/ui-dashboard`](packages/ui-dashboard) | Web UI | 主控面板 React SPA（PRD 第 4 章规范全量实现） |
| [`@helmsman/ui-diff`](packages/ui-diff) | Web UI | 多 Agent Diff 对比：split / unified / side-by-side、冲突标注与方案选择、行级评论、合并 |
| [`@helmsman/bundle`](packages/bundle) | Bundle | 一条命令装入全部 9 个插件 |

文档：[架构说明](docs/ARCHITECTURE.md) · [UI 规范符合性矩阵](docs/UI-COMPLIANCE.md) ·
[安全审计报告](docs/SECURITY-AUDIT.md) · [使用手册](docs/USAGE.md)

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
for p in worktree memory-topology orchestrator adapter-claude adapter-codex \
         adapter-pi adapter-oh-my-pi ui-dashboard ui-diff; do
  dsh plugin --profile web add -w ./packages/$p
done
#   或逐个安装后安装 bundle：dsh plugin --profile web add -w ./packages/bundle

# 4) 验证插件树注册成功
dsh --profile web --dump-config | grep helmsman   # 应看到 9 个 helmsman-* 条目

# 5) 启动
dsh web          # 打开 http://127.0.0.1:3080/helmsman-dashboard/
```

> 注意：`dsh plugin add` 会把参数转发给 pnpm；在本仓库根目录执行时需要 `-w`
> （profile 目录本身是一个 pnpm workspace）。`pi` / `oh-my-pi` 适配器的 CLI 参数
> 模板按常见版本预设，若你的安装版本不同，可在 profile 的 `cordis.patch.yml`
> 用户层覆盖（示例见各适配器 README）。

## 验证

```bash
pnpm test          # 56 个单元/集成测试（含真实 git worktree 集成测试）
pnpm typecheck     # 全部包 tsc --noEmit 通过
pnpm build         # esbuild host 产物 + React client IIFE + d.ts
```

端到端（在真实 harness 上已验证）：创建项目群 → 配置服务仓库 → 提交并行任务 →
观察 Agent 卡片状态机（CREATING_WORKTREES → RUNNING → AGGREGATING → COMPLETED /
PARTIAL_FAILED / ALL_FAILED）→ 在 Diff 视图查看对比 → 合并回主仓库。

## 安全要点（详见 [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md)）

- 所有子进程调用（git / agent CLI）使用 `execFile`/`spawn` + **argv 数组，无 shell**；
- worktree id / 分支 / 路径强制字符集校验与 `rootDir` 越界检查；
- 合并 patch 经 stdin 传入，不落临时文件；merge 冲突时主仓库保持原状；
- 扫描器有深度 / 文件数 / 文件大小上限与符号链接逃逸检查；
- 无 `eval`/`Function`、无网络外发、零第三方运行时依赖（社区插件除外）。

## 复用策略落实情况（PRD 第二章）

| PRD 要求 | 落实 |
|----------|------|
| 直接复用 `dsh-virtual-workspace` | ✅ worktree 插件惰性解析 `vws` 服务，创建的 worktree 注册为命名虚拟工作区（未安装则优雅降级） |
| 直接复用 `dsh-memory-manager` + `dsh-memory-palace` | ✅ topology 保存时最佳努力镜像快照到 `memoryManager`；palace 按其设计仅经 agent 工具使用 |
| 参考 `dsh-Visual-Workflow` | ✅ 采用其「webServer prefix 路由挂载自有 GUI API」的第三方 UI 模式与「画布状态轮询」思想 |
| 参考 `kalifun/helmsman` | ✅ 「任务即会话」卡片式看板与状态机视觉反馈 |
