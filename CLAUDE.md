# WorkMate — 项目指南

## 项目定位

WorkMate（`workmate4dsh`）是一个 **DSH 插件 Bundle**，围绕「变更提案」核心实体，
串联需求文档、Git 变更、OpenSpec 归档、GitNexus 知识图谱，实现研发全链路的知识
沉淀与并行迭代。设计原则：寄生而非替代（UI 注入 DSH 原生界面）、复用优先
（swarm 编排 / @快捷指令 / MCP 桥接用社区插件）、自建聚焦（变更提案中间层 +
知识串联逻辑）。

- 完整技术设计：`docs/DESIGN.md`（0.1.0-draft，宪法文档）
- 前身 Helmsman（15 包 monorepo，看板 / 编排 / 拓扑）已完整存档于 `main` 分支；
  本分支 `feat/workmate` 是全新起点，**不迁移**旧代码。

## 常用命令

```bash
pnpm install && pnpm build     # 构建（esbuild host 产物 + d.ts）
pnpm test                      # vitest
pnpm typecheck                 # tsc --noEmit
pnpm verify                    # 四条门禁：契约 + 钉版 + 宿主兼容 + 客户端工厂求值
pnpm verify:contract           # 契约门禁：patch id / package.json / 入口 name 三处一致

pnpm exec vitest run src/features/proposal        # 单目录测试
pnpm exec vitest run -t "部分用例名"               # 按用例名过滤
```

装进本机 DSH profile（web profile 用 `link:` 直连源码目录，改完代码必须重新
`pnpm build` 再重启 harness 才生效）：

```bash
# ~/.dsh/profiles/web/package.json 的 dependencies 加：
#   "workmate4dsh": "link:/Users/fredlee/Documents/workspace/dsh-Helmsman"
# dsh.profile.bundles 加： "workmate4dsh"
cd ~/.dsh/profiles/web && pnpm install
pnpm dsh --profile web --dump-config | grep workmate   # 应出现 workmate 条目
pnpm dsh web                                            # http://127.0.0.1:3080
```

## 插件契约（写代码之前先看这条）

- 具名导出 `name` / `inject` / `Config` / `apply`，**没有 `export default`**。
- `Config` 是 TypeScript interface（真机验证形态，非 Schemastery）。
- **inject 只写已验证存在的服务**：声明了未就绪的服务，fiber 会永久 PENDING。
  M1 自足（`inject = []`）；M2 引入 `tools` 前先惰性 `ctx.get` 探测。
  可选依赖一律惰性 getter，缺失即优雅降级。
- bundle 必须在 `package.json` 声明 `dsh.bundle.patch`，否则 profile 装载直接抛错
  （单元测试抓不到，只有真装进 profile 才暴露）。
- `cordis.patch.yml` 只写本包条目；swarm / MCP 条目等对应社区插件真的装进 profile
  后再追加——引用缺失插件同样断链。

## 数据落盘

`$DSH_HOME`（解析顺序：显式注入 → `$DSH_HOME` env → `~/.dsh`；env 名待与宿主
`dsh-home-paths` 核对）下：

| 路径 | 内容 |
| --- | --- |
| `workmate/proposals.json` | 提案聚合（单 JSON，可 grep） |
| `workmate/events.jsonl` | 过程事件流（append-only：状态迁移 / 门禁失败 / 控制带越界） |
| `workmate/bands.json` | 控制带配置（缺失用内建默认，损坏 fail-closed 报错） |

`proposals.json` 写入必须 **tmp + rename 原子写**；文件损坏 fail-closed——启动期报告、
永不覆盖（board warmUp 教训）。`events.jsonl` 只追加、容忍撕裂尾行；度量由事件流现算。

> 本文件是 `AGENTS.md` 的历史副本，内容可能滞后；契约与纪律以 `AGENTS.md` 为准。

## 里程碑路线（`docs/DESIGN.md` §7）

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M1 | 插件骨架与依赖装配 | ✅ 已归档 `2026-09-28-bootstrap-workmate-plugin` |
| M2 | 变更提案中间层（工具注册、openspec 目录生成、Git 关联、提案面板） | ✅ 已归档 `2026-09-28-add-proposal-middleware` |
| M3 | 知识桥接（GitNexus CLI / WeKnora） | ✅ 已归档 `2026-09-28-add-knowledge-bridge` |
| M4 | 归档编排闭环（openspec archive + gitnexus analyze） | ✅ 已归档 `2026-09-28-add-archive-orchestration` |
| M5 | 知识图谱可视化（SVG 分层视图） | ✅ 已归档 `2026-09-28-add-knowledge-graph-view` |

待办（依赖外部条件）：swarm 并行执行（编排内已留记录性跳过位）、@快捷指令
（`@hucj/dsh-file-mention` 未装）、WeKnora 真机契约核验。

已知环境事实（M3/M4 决策依据）：本机 harness `0.1.7-rc.2`；profile 实装
`dsh-tools 0.1.2-alpha.5`（引入时钉此线）；`@deepseek-ai/dsh-mcp-client` 不存在，
只有社区 `dsh-mcp-adapter`；`dsh-swarm-orchestrator` / `@hucj/dsh-file-mention`
未装。

## 工作流

**OpenSpec 规格驱动开发**（`openspec` CLI 可用）：非平凡变更先在
`openspec/changes/<change-name>/` 写 `proposal.md`（Why / What Changes /
Capabilities / Impact）、`design.md`、`tasks.md`，实现中在 `tasks.md` 打勾，
完成后 `openspec archive`。**先提交 `docs(openspec): ...` 规划提交，再提交
`feat(...)` 实现提交**。

提交信息用 conventional commits + 中文描述，**不要添加 AI 署名**：

```
feat(proposal): 提案创建时同步生成 openspec 目录
fix(store): 修复原子写中断后残留 tmp 文件
```

## 文档索引

| 文档 | 用途 |
| --- | --- |
| `docs/DESIGN.md` | 技术设计文档 0.1.0-draft（架构、模块、里程碑） |
| `docs/DSH-INTEGRATION-NOTES.md` | DSH 宿主集成契约（Origin 围栏、bundle 声明、link 安装、证据等级） |
| `openspec/specs/` | 已归档能力规格 |
