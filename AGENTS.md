# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

Helmsman 是一套 **DeepSeek Harness (DSH) 第三方插件**组成的 monorepo：在一个看板上并行指挥
Claude Code / Codex / Pi / oh-my-pi 等多个编码 Agent，各自在独立 git worktree 中执行同一任务，
自动收集 diff、标注冲突、按 Agent/文件择优合并回主仓库。

- 15 个插件包 + `@helmsman/bundle`（16 个 workspace 包），全部是标准 DSH 插件（纯 ESM）。
- **零第三方运行时依赖**是硬约束（React 除外，由 UI 包打包时内联）。不要为省事引入 npm 运行时依赖。

## 常用命令

```bash
pnpm install && pnpm build     # 全仓构建（esbuild host 产物 + React client + d.ts）
pnpm test                      # vitest 全量（42 文件 / 632 用例，~4s）
pnpm typecheck                 # 全部包 tsc --noEmit

# 单个测试：vitest 跑在仓库根，用路径或 -t 过滤
pnpm exec vitest run packages/board/src
pnpm exec vitest run packages/board/src/model.test.ts
pnpm exec vitest run -t "部分用例名"

# 单包构建（构建失败时先跑这个，比全仓快）
pnpm --filter @helmsman/board build

# 工具链版本治理（toolchain.json 是唯一权威清单）
pnpm verify:toolchain                                          # = --structural，CI 跑的就是它
node scripts/check-toolchain.mjs --live --profile web          # 比对本机已装 profile
node scripts/check-toolchain.mjs --generate-compat             # 重新生成 docs/COMPATIBILITY.md
```

装进本机 DSH profile 并启动（在仓库根执行；profile 目录自身是 pnpm workspace，故需要 `-w`）：

```bash
dsh plugin --profile web add -w ./packages/<pkg>       # 单个包
dsh plugin --profile web add -w ./packages/bundle      # 一次装齐 15 个
dsh --profile web --dump-config | grep helmsman        # 应看到 15 个 helmsman-* 条目
dsh web                                                # http://127.0.0.1:3080/helmsman-dashboard/
```

## 插件契约（写任何包之前先看这条）

每个包都遵循同一形态，**没有任何 `export default`**，全部具名导出：

```ts
export const name = '@helmsman/<pkg>'   // 诊断显示名
export const inject = ['tools', ...]    // 硬依赖：服务未就绪则 fiber 永久 PENDING
export function apply(ctx: Context, config) { /* 挂载点 */ }
```

- 注册服务用 `ctx.provide('<name>', value)`，跨插件获取用 `ctx.get('<name>')`。
- **可选依赖绝不能写进 `inject`**，也不能在 `apply` 期立即 `ctx.get` —— 后者会因服务尚未
  ACTIVE 拿到 `undefined`。一律传**惰性 getter**，运行时再解析，缺失即优雅降级。
  `helmsman.artifacts` / `helmsman.board` / `vws` / `sessionQuery` 都是这么接的。
- 非 cordis 管理的资源必须包 `ctx.effect(() => disposer)`。
- `cordis.patch.yml` 里的 `- insert:` 行是插件树挂载点；`packages/bundle/cordis.patch.yml`
  聚合全部 15 行。

## 服务拓扑

```
helmsman.worktree   ──inject──▶ orchestrator
helmsman.topology       (自足)
helmsman.orchestrator ─inject─▶ adapter-{claude,codex,pi,oh-my-pi}
helmsman.artifacts | helmsman.board | helmsman.knowledge   (自足，被惰性 ctx.get)
webServer (DSH 内置) ─inject──▶ ui-dashboard / ui-diff / ui-workbench / ui-board
```

UI 插件经 `ctx.webServer.register({kind:'prefix'})` 挂载同源 REST + 静态 SPA，**不使用**
`dsh.client` module roster（那是社区插件 `dsh-Visual-Workflow` 验证过的第三方 UI 模式）。

## 两层「任务」模型（最容易搞混的地方）

```
WorkItem (board 拥有，~/.helmsman/board/items.json)
  ├ stage: 需求分析 → 规格设计 → 开发实施 → 验收归档（仅允许 +1 推进，带门校验）
  ├ 关联集: docs / conversations / runs / services / artifacts —— 全部存【引用 + label 快照】
  └ runs[] ──只读引用──▶ orchestrator 的 taskId
```

run 的状态/时间线**不复制**进卡片，需要时经只读 `RunStatusReader` 查 orchestrator 的落盘时间线。
破坏这个分层（比如把 run 状态冗余进 board 存储）是本项目最忌讳的设计退化。

## 数据落盘

全部在 `$HELMSMAN_HOME`（默认 `~/.helmsman/`）下：

| 路径 | 内容 |
| --- | --- |
| `history/tasks/<taskId>.jsonl` | 追加式事件时间线（每行 `{v,seq,ts,taskId,kind,agent?,payload}`，`seq` 即 SSE cursor） |
| `history/tasks.json` | 任务摘要快照（tmp+rename 原子写） |
| `board/items.json` + `board/events.jsonl` | WorkItem 聚合根 + 阶段迁移事件 |
| `topologies/<group>.json` | 项目拓扑（组名 URI 编码，CJK 安全） |
| `artifacts/` | sha256 内容寻址产物注册表 |
| `vault/` | Tolaria 知识库（仅用户显式「归档」的定稿） |
| `workbench/` | 生成草稿（未归档，纯本地） |
| `audit/audit.jsonl` | 敏感操作审计日志 |
| `policy.json` | 敏感操作确认策略 |

写入必须是 **tmp + rename 原子写**；JSONL 读取须容忍撕裂尾行。

## 关键设计权衡（改动前先读 `docs/ARCHITECTURE.md` §4）

- **实时性 = SSE + cursor，轮询仅兜底**：`GET /api/task/:id/stream?after=<seq>`。连接**先订阅**
  （此间事件进内存缓冲）再重放持久化时间线，从根上消除「重放终点 ↔ 实时起点」竞态。客户端
  EventSource 出错后手动带最后 seq 重连。事件总线 `helmsman/task-updated` 仍然照常广播——
  持久化只是挂在该汇聚点上的副作用，不替换事件。
- **合并 = patch 式 `git apply`（stdin），不是分支 `git merge`**：这样 agent 未在 worktree 内
  提交也能合并；代价是冲突处理「整批失败」（原子），冲突文件由 UI 按 agent+file 维度重试。
- **依赖粒度 = 服务级**：`restDependencies` 一对 `(from, to)` 恰好一条边。去重落在**持久化路径**
  （`saveTopology` / `TopologyStore.save` → `mergeDependencyEdge` → `dedupeDependencies`），
  所以配置页 / 导入 / HTTP / 推导确认四条写入路径共享同一不变量且保存幂等。没有明细时用服务级边
  （`method: '*'`、`endpoints: []`）。
- **推导只提议、不落库**：扫描是纯静态离线启发式，结果只经只读入口返回（带 `scannedAt`），
  落库是独立的人工动作 `applyCandidates`。**不允许有第二套审核 UI 或第二条写入路径。**
- **扫描器与核对器只读**：不写声明文件、不改拓扑、不做网络请求、不执行 git 操作。
  扫描器有深度/文件数/大小上限与 realpath 符号链接逃逸检查。

## 代码约定

- **源码 import 带 `.ts` 扩展名**（`./core.ts`），tsconfig 开了 `allowImportingTsExtensions`；
  但 `src/client/**` 的 React 代码用**无扩展名** import（`./App`），由 esbuild 打包。
- 构建分两条路：`scripts/build-package.mjs` 打 host 侧 ESM（`packages: 'external'`，只打包相对
  依赖，npm 依赖留给 profile 的 node_modules）；UI 包额外跑自己的 `build.mjs` 打 React client
  （IIFE，零运行时依赖）。`ui-board` / `ui-workbench` 还额外导出 `./client/embed` ESM 入口给宿主
  client bundle 复用 React。
- `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools` 是 **peer 依赖，永不打包私有副本**。
- 所有子进程（git / agent CLI）用 `execFile`/`spawn` + **argv 数组，无 shell**；非法字符集与
  `rootDir` 越界要显式校验。

## 工作流

**OpenSpec 规格驱动开发**（`openspec` CLI 可用）：非平凡变更先在
`openspec/changes/<change-name>/` 写 `proposal.md`（Why / What Changes / Capabilities / Impact）、
`design.md`、`tasks.md`，再实现并在 `tasks.md` 上打勾，完成后 `openspec archive`。
`openspec/specs/` 是已归档的能力规格。**先提交 `docs(openspec): ...` 规划提交，再提交 `feat(...)`
实现提交**是本仓的既有节奏。

提交信息用 conventional commits + **中文描述**，scope 取包名（去掉 `@helmsman/` 前缀）：

```
feat(ui-board): 看板第三列卡片支持发起执行
fix(topology): 修复网关 URL 配置键的扫描遗漏
```

**不要添加 `Co-Authored-By` 等 AI 署名**（全局已禁用）。

**toolchain.json 是版本治理的唯一权威源**：改它（或改 `docs/WORKBENCH-SETUP.md` /
`docs/DISTRIBUTION.md`）必须同步重跑 `--generate-compat` 并让 `--structural` 通过——
CI 只在这些文件变更时触发，且**只**门禁工具链面。
`@deepseek-ai/dsh-tools` 必须钉在 `0.1.2-alpha.5` 线（升到 rc 线会破坏 `CallId`/`ToolCallId` import）。

## 文档索引

| 文档 | 用途 |
| --- | --- |
| `docs/ARCHITECTURE.md` | 架构权威说明（服务拓扑、数据流、设计权衡 §4） |
| `docs/USAGE.md` | 使用手册（日常工作流、拓扑录入/推导/漂移核对、配置项） |
| `docs/VERIFICATION-GUIDE.md` | 可粘贴复现的验证操作手册（每条带真机实测输出） |
| `docs/TASK-MODEL.md` | WorkItem 模型、四阶段 DoR/DoD、冲突域 WIP |
| `docs/DSH-INTEGRATION-NOTES.md` | 与 DSH 宿主的集成契约与证据等级 |
| `docs/SECURITY-AUDIT.md` | 安全审计（子进程、沙箱、网络外发豁免声明） |
| `docs/DISTRIBUTION.md` | 分发的 4 种方式 |
| `docs/PRD/` | 产品需求文档（PRDv1/v2/v3） |

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **dsh-Helmsman** (4555 symbols, 10714 relationships, 386 execution flows). Use GitNexus graph tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact analysis before editing.** Use `impact({target: "symbolName", direction: "upstream"})` (MCP) or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .` (CLI fallback); report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/dsh-Helmsman/context` | Codebase overview, check index freshness |
| `gitnexus://repo/dsh-Helmsman/clusters` | All functional areas |
| `gitnexus://repo/dsh-Helmsman/processes` | All execution flows |
| `gitnexus://repo/dsh-Helmsman/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
