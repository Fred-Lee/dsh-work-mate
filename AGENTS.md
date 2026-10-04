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
pnpm install && pnpm build     # 构建（esbuild host/客户端产物 + dist/types 声明树）
pnpm test                      # vitest
pnpm typecheck                 # host + client 两个 program
pnpm verify                    # 三条门禁：契约 + 工具链钉版 + 宿主兼容
pnpm verify:contract           # patch id / package.json / 入口 name 三处一致
pnpm verify:toolchain          # toolchain.json ↔ package.json 钉版一致
pnpm verify:host-compat        # dsh peer 范围与宿主基线（借宿主自己的判定函数）
pnpm test:toolchain            # 上述门禁脚本自身的用例（node:test）

pnpm exec vitest run src/features/proposal        # 单目录测试
pnpm exec vitest run -t "部分用例名"               # 按用例名过滤
```

装进本机 DSH profile（`link:` 直连源码目录，改完代码必须重新 `pnpm build` 再重启
harness 才生效）：

```bash
DSH=/Users/fredlee/Documents/workspace/deepseek-harness/apps/cli/lib/bin.js
node $DSH plugin --profile web add /Users/fredlee/Documents/workspace/dsh-Helmsman
node $DSH --profile web --dump-config | grep workmate        # 应出现 workmate 条目
node $DSH --profile web --dump-config-schema | grep -A3 workmate  # 应 status: schema
node $DSH web                                                # http://127.0.0.1:3080
```

> 手工等价：profile 的 `dependencies` 加
> `"workmate4dsh": "link:/Users/fredlee/Documents/workspace/dsh-Helmsman"`，
> `dsh.profile.bundles` 追加 `"workmate4dsh"`，然后在 profile 目录 `pnpm install`。
> 本机 pnpm 11 与 profile 的 store v10 不一致时，`pnpm add` 会报
> `ERR_PNPM_UNEXPECTED_STORE`，用 `npx --yes pnpm@10 add ...` 绕过（勿用 pnpm 11 直接
> 重装整个 profile）。

## 插件契约（写代码之前先看这条）

- 具名导出 `name` / `inject` / `Config` / `apply`，**没有 `export default`**。
- `Config` **同时**是 TypeScript interface（契约类型）与运行时 Schemastery schema。
  宿主只认后者：它在 `packages/boot/app-boot/src/config-schema/native.ts` 里按
  `Symbol.for('schemastery')` + `type` + `meta` 做身份检查，缺运行时导出就没有校验、
  没有配置界面。schemastery 的版本必须与 `dsh-tools` 依赖的那条线一致，否则同一个
  program 里两份 `Schema` 类型会让 `z<Config>` 注解报 TS2322。
- `inject` 只写**每个 profile 都提供**的服务（当前只有 `['tools']`）。`webServer` /
  `skills` / `systemPrompt` 一律用 reactive `ctx.inject([...], scope => …)` 惰性装配，
  缺失即少一块能力，**不 park fiber**；不要用一次性 `ctx.get` 探测。
- **dsh 内核 peer 必须是 `*`**：宿主只用 `peerDependencies` 里 `@deepseek-ai/dsh` /
  `@deepseek-ai/dsh-*` 的范围判定兼容性（`plugin-compatibility.ts`，含 prerelease），
  范围不满足就**整包跳过装载**——这是社区插件在 0.2.x 升级后集体失效的原因。
  构建基准线写在 `devDependencies` + `toolchain.json`，由 `pnpm verify:host-compat` 守。
- bundle 必须在 `package.json` 声明 `dsh.bundle.patch`，否则 profile 装载直接抛错
  （单元测试抓不到，只有真装进 profile 才暴露）。
- `cordis.patch.yml` 只写本包条目；引用未安装的插件同样断链。

## 跟随 DSH 升级（升级仪式）

`dsh` 本体换线后按顺序做，任何一步红了都别继续：

1. 装新线内核包（用 pnpm@10 绕过 store 版本不一致）：
   `npx --yes pnpm@10 add -D @deepseek-ai/dsh-tools@<新版本>`
   `npx --yes pnpm@10 add @deepseek-ai/schemastery@<dsh-tools 依赖的同版本>`
2. 改 `toolchain.json`：`profile.dsh` 与新线一致，`require['@deepseek-ai/dsh-tools']`
   与 devDependencies 完全相等（门禁要求逐字相等），`runtime` 记 schemastery 线。
3. `pnpm typecheck && pnpm test`——API 断链在这一步暴露（历史上出现过
   `CallId` → `ToolCallId` 改名）。
4. `pnpm verify`（契约 + 钉版 + 宿主兼容）与 `pnpm build`。
5. 重装进 profile 并核验（**不要**只信单元测试）：
   `node $DSH plugin --profile <p> add <本仓库>`，然后
   `--dump-config | grep workmate` 与 `--dump-config-schema`（workmate 条目应为
   `status: schema`，且没有 workmate 相关 diagnostics）。

运行时不需要跟着换：宿主自己的解析会把 linked importer 声明的 peer 指向**运行中安装
的那份内核**（`profile-resolution/resolver.ts`），所以我们 import 的 `dsh-tools` 就是
宿主那份；devDependency 只服务于类型检查与测试。

## 数据落盘

`$DSH_HOME`（解析顺序：显式注入 → `$DSH_HOME` env → `~/.dsh`；env 名已与宿主
`@deepseek-ai/dsh-home-paths` 核对一致）下：

| 路径 | 内容 |
| --- | --- |
| `workmate/proposals.json` | 提案聚合（单 JSON，可 grep） |

写入必须 **tmp + rename 原子写**；文件损坏 fail-closed——启动期报告、永不覆盖
（board warmUp 教训）。出现事件流时再引入 JSONL 与撕裂尾行容忍。

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

已知环境事实（2026-10-05 复核）：本机 harness 与宿主内核线 **`0.2.1-alpha.1`**
（源码树 `@deepseek-ai/dsh-root 0.2.1-alpha.1`，tag `dsh-v0.2.1-alpha.1`）；
`@deepseek-ai/dsh-tools 0.2.1-alpha.1`（devDependency 钉此线）、
`@deepseek-ai/schemastery 3.18.5-alpha.1`、`@deepseek-ai/cordis 4.0.5-alpha.1`
（共享 store 实装值）。社区侧：`dsh-better-sidebar` 0.24.1+ 已适配，
`dsh-mnemon` / `@linxin666/*` / `@changfenhuang/dsh-annotation` 亦可用；
`dsh-auto-review`、`dsh-mcp-adapter`、`@open-agfs/dsh-agfs`、`dsh-outline`
**暂无兼容 0.2.x 的版本**（peer 停在 0.1.x）；`@deepseek-ai/dsh-mcp-client`
与 `@deepseek-ai/dsh-subagent-claude-code` 需升到 0.2.1-alpha.1。

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
| `docs/DSH-FIT-AUDIT.md` | DSH 适配度评估（P0/P1/P2 清单、证据、落地进度） |
| `openspec/specs/` | 已归档能力规格 |
