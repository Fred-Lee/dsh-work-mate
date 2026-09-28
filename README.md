# WorkMate — 围绕「变更提案」的 DSH 插件 Bundle

WorkMate 构建在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
「一切皆插件」架构上，以**变更提案**为核心实体，串联研发全链路：

- **变更提案管理**：创建、查看、归档提案，关联项目与 Git 提交
- **知识桥接**：GitNexus（MCP）+ WeKnora（HTTP），需求 ↔ 项目 ↔ 提交的知识沉淀
- **并行编排**：复用 `dsh-swarm-orchestrator` 驱动多任务并行执行
- **归档闭环**：OpenSpec 归档 + GitNexus 索引重建一键触发

设计原则：**寄生而非替代**（UI 注入 DSH 原生界面）、**复用优先**、**自建聚焦**
（只做变更提案中间层与知识串联逻辑）。

> 前身 Helmsman（Agent 舰队指挥中心，15 插件包 monorepo）已完整存档于本仓库的
> `main` 分支；当前 `feat/workmate` 分支是按新设计另起的全新实现。

## 快速开始

```bash
pnpm install && pnpm build && pnpm test
```

装进 DSH（profile link 方式，见 `AGENTS.md`）：

```bash
# ~/.dsh/profiles/web/package.json:
#   dependencies: { "workmate4dsh": "link:<本仓库绝对路径>" }
#   dsh.profile.bundles: [..., "workmate4dsh"]
pnpm dsh web   # http://127.0.0.1:3080
```

## 仓库布局

```
src/
├── index.ts                    # 插件入口（name / inject / Config / apply）
├── config.ts                   # 配置 interface + 默认值
└── features/
    └── proposal/               # 提案服务（store：原子写；service：领域逻辑）
scripts/
├── build.mjs                   # esbuild host 打包（npm 依赖 external）
└── check-contract.mjs          # 契约门禁（三处 name 一致）
docs/
├── DESIGN.md                   # 技术设计文档（宪法）
└── DSH-INTEGRATION-NOTES.md    # DSH 宿主集成契约笔记
openspec/                       # OpenSpec 规格驱动开发
```

## 开发

```bash
pnpm build            # 构建
pnpm typecheck        # 类型检查（strict）
pnpm test             # vitest
pnpm verify:contract  # bundle 契约门禁
```

路线图与当前进度见 `AGENTS.md`「里程碑路线」。

## License

MIT
