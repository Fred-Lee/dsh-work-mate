# Bootstrap WorkMate Plugin

## Why

Helmsman 的 15 包体系已在 `main` 完整存档（含全部规格与真机验证结论），产品方向调整为
**WorkMate**：一个围绕「变更提案」核心实体的 DSH 插件 Bundle，串联需求文档、Git 变更、
OpenSpec 归档与 GitNexus 知识图谱，实现研发全链路的知识沉淀与并行迭代。

设计依据：`WorkMate DSH 插件技术设计文档 0.1.0-draft`（寄生而非替代、复用优先、
自建聚焦「变更提案中间层」与「知识串联逻辑」）。

本变更对应设计文档的**里程碑一：插件骨架与依赖装配**——让插件在 DSH `web` profile
中真实加载，为后续提案服务（M2）、知识桥接（M3）、归档编排（M4）打底。

## What Changes

1. **仓库形态切换**：从 Helmsman 多包 monorepo 切换为 WorkMate 单包仓库
   （设计文档 §8.3 以 `pnpm pack` 单包 tarball 发布）。Helmsman 全部代码、规格与文档
   在 `main` 分支完整存档，本分支（`feat/workmate`）上移除，不迁移。
2. **插件骨架**：host 半入口（`name` / `inject` / `Config` / `apply` 具名导出）、
   配置定义（§4.1 五个配置项）、`workmate.proposal` 服务占位（M2 扩展为完整 CRUD）。
3. **bundle 装配**：`package.json` 声明 `dsh.bundle.patch` + `cordis.patch.yml`
   仅含 `workmate` 一行；swarm / MCP 条目待 M3/M4 依赖就位后追加。
4. **构建与测试基建**：esbuild host 打包（npm 依赖 external）、tsc 严格类型检查、
   vitest 最小测试（配置默认值 + 服务挂载冒烟）。
5. **宿主契约知识继承**：保留 `docs/DSH-INTEGRATION-NOTES.md`（Origin 围栏、
   bundle 声明、link 安装方式等真机验证结论），供后续里程碑直接引用。
6. **profile 切换**：本机 `web` profile 移除 15 个 `@helmsman/*` link 条目，
   装载 WorkMate（否则移除 `packages/` 后宿主 link 断链、无法启动）。

## Capabilities

### 新增能力

- `workmate-plugin`：WorkMate 插件的宿主装载契约——bundle 声明、插件树挂载点、
  配置项与服务命名空间（`workmate.proposal` / `workmate.knowledge` / `workmate.archive`）。

## Impact

- **代码**：删除 `packages/`（15 包）、`docs/`（保留 `DSH-INTEGRATION-NOTES.md`）、
  `scripts/`、`toolchain.json`、`openspec/specs/`、`openspec/changes/archive/`；
  重写根 `package.json`、`AGENTS.md`、`README.md`、`.gitignore`、`tsconfig.json`。
- **环境**：`~/.dsh/profiles/web` 移除 helmsman 条目、新增 workmate link 条目。
  回退方式：`git checkout main` 后按 `docs/VERIFICATION-GUIDE.md`（main 存档）重新
  `dsh plugin --profile web add -w ./packages/bundle` 即可完整恢复 Helmsman。
- **不涉及**：`dsh-swarm-orchestrator`、`@hucj/dsh-file-mention`、MCP 桥接（M3/M4 范围）；
  client 半 UI（M2 范围）。
