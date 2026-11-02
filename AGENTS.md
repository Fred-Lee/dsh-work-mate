# WorkMate — 项目指南

## 项目定位

WorkMate（`workmate4dsh`）是一个 **DSH 插件 Bundle**，围绕「变更提案」核心实体，
串联需求文档、Git 变更、OpenSpec 归档、GitNexus 知识图谱，实现研发全链路的知识
沉淀与并行迭代。设计原则：寄生而非替代（UI 注入 DSH 原生界面）、复用优先
（swarm 编排 / @快捷指令 / MCP 桥接用社区插件）、自建聚焦（变更提案中间层 +
知识串联逻辑）。

- 完整技术设计：`docs/DESIGN.md`（0.1.0-draft，宪法文档）
- 前身 Helmsman（15 包 monorepo，看板 / 编排 / 拓扑）的存档线原在 `main`。
  **2026-10-12 起 WorkMate 单包线接管 `main`**（fast-forward 合并）；旧存档线留在 tag
  `archive/helmsman-main`（`16bb983`）。日常开发仍在 `feat/workmate`，两条分支同源，
  `main` 只做里程碑收敛点。

## 常用命令

```bash
pnpm install && pnpm build     # 构建（esbuild host/客户端产物 + dist/types 声明树）
pnpm test                      # vitest
pnpm typecheck                 # host + client 两个 program
pnpm verify                    # 五条门禁：契约 + 工具链钉版 + 宿主兼容 + 客户端工厂求值 + 测试自证
pnpm verify:contract           # patch id / package.json / 入口 name 三处一致
pnpm verify:toolchain          # toolchain.json ↔ package.json 钉版一致
pnpm verify:host-compat        # dsh peer 范围与宿主基线（借宿主自己的判定函数）
pnpm verify:built              # 加载 dist/index.js（真实模块求值）并断言宿主工具面（20 个工具，不含已删的 team_*）
pnpm verify:client             # 在 VM 里真求值 dist/client/client.js：load 次数 / id / apply /
                               # inject / external 白名单（**默认拒绝**）——补"单测抓不到、
                               # 只有真机才暴露"那道门；它只管装载契约，不证明 UI 渲染对
pnpm verify:test               # 测试自证：仓库里每个 *.test.ts(x) 都必须真的被执行、0 skip / 0 todo；
                               # 全集由仓库独立发现（不复用 include，否则改窄 include 会自己发绿灯）。
                               # 它管"跑没跑"，**不管"测得对不对"**
pnpm test:toolchain            # 上述门禁脚本自身的用例（node:test）

pnpm exec vitest run src/features/proposal        # 单目录测试
pnpm exec vitest run -t "部分用例名"               # 按用例名过滤
```

装进本机 DSH profile（`link:` 直连源码目录，改完代码必须重新 `pnpm build` 才生效）。
若 profile 里是 live 条目（`include:workmate`），可用 plugin manager 对
`include:workmate` 先禁用再启用触发热重载，无需重启宿主；客户端需刷新页面。
全量重启仍用于宿主内核/依赖变更：

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
- bundle 必须在 `package.json` 声明 `dsh.bundle.patch`，否则 profile 装载直接抛错。
  客户端构建产物的同类失效由 `pnpm verify:client` 兜住（在 VM 里真求值
  `dist/client/client.js`，断言 load 恰好一次 / id == 包名 / 导出 `apply` /
  `inject` 是字符串数组 / external 只在白名单内且**默认拒绝**）——它替代不了真机，
  但把"装载契约"从真机前移到了门禁。
- `cordis.patch.yml` 只写本包条目；引用未安装的插件同样断链。
- **客户端面板根必须自带高度与滚动契约**（2026-10-08 `fix-panel-scroll`）：宿主 `main` 槽是
  `display:flex; flex-direction:column; overflow:hidden` 的确定高度列——面板根要 `height:100%` +
  纵向 flex，并提供**唯一**滚动子层（`min-height:0` + `overflow-y:auto`）。只靠文档流的面板在宿主内
  会被祖先**静默裁剪**（内容在、无滚动条、滚不到）；jsdom 没有布局引擎，这类缺陷单测测不出，
  必须真机截图验收。

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
| `workmate/events.jsonl` | 过程事件流（append-only：状态迁移 / 门禁失败 / 控制带越界） |
| `workmate/bands.json` | 控制带配置（缺失用内建默认，损坏 fail-closed 报错） |
| `workmate/decision-cache.json` | 判断缓存（同题复用；损坏 fail-open，仅性能层） |

`proposals.json` 写入必须 **tmp + rename 原子写**；文件损坏 fail-closed——启动期报告、
永不覆盖（board warmUp 教训）。`events.jsonl` 是**只追加**的 JSONL：只增不改，读取端
容忍撕裂尾行与非法行（忽略并计数，绝不抛错）；事件流损坏不得影响聚合读写。
度量一律由事件流**现算**（`src/features/proposal/metrics.ts` 纯函数），不落第二份真相。

## 团队执行器已移除（2026-11-02，`remove-team-executor`）

`src/features/team/` 整个目录、6 个 `workmate_team_*` 工具、4 条 `/api/team/*` REST、
面板「团队」视图、7 个 `team*` 配置项与 `taskExecutor` 全部删除。理由：它重复了
Super-agent 已经做得更好的一层（并发、重试、会话、提问），且默认关闭、真机从未跑过。

保留下来的是与执行无关的治理能力：

- `TASKS.json` 仍是任务单一事实源，待办从它派生；
- `teamEvidenceGate` 保留但判据收窄为「变更目录里有没有 `TASKS.json`」——有任务就必须有
  `TEST.md` / `TEAM-REVIEW.md`。审查者独立性只按工件署名与提交作者比较，不再看 Dispatch 会话；
- `events.jsonl` 里历史的 `team-*` 行继续可读（append-only 事实流），但不再产生新的
  `team-run`；任务层事件改用 `kind: 'task-settled'`。

回退从「三件事」变「两件事」：① 停用 `workmate-superagent-source` bundle；
② `node scripts/rollback-superagent.mjs` 清理 worktree / 分支 / 端口。
`workmate/team-runs.json` 若还在磁盘上，说明曾是团队模式，可以手工删除，不影响装载。

## Super-agent 执行层（2026-11-01，`adopt-superagent-openspec-source`）

**执行交给 Super-agent，WorkMate 保留治理与知识**。待办板是一个真正的
`SourceKind`（包 `packages/superagent-source`，包名 `workmate-superagent-source`），
独立安装进 Super-agent 的 profile，装即启用；根包**不要**装进 Super-agent 的 profile。

- **定位**：面板建待办 → Source 扫描成 Trigger → Super-agent 的 Eval/Ticket → worker；
  提案、OpenSpec、G2、写域机检、归档门、知识桥接仍在 WorkMate，作用于 `ready` 之后；
- **唯一执行器**：`superagent`（`taskExecutor` 配置项已在 `remove-team-executor` 删除）。
  不建 Run、`ready→implementing` 只校验基线分支存在，**不预建 worktree**；
  回退只能停用子包 bundle + 跑回滚脚本；
- **三份文件、三个单写者**：`tasks.json`（面板写，原子 + fail-closed）、
  `inputs.jsonl`（面板追加）、`tasks.jsonl`（Source 追加）。执行阶段一律读 Ticket 投影，
  **不镜像**到第四份文件；
- **worktree 所有权**：WorkMate 规划（目标仓库/基线/分支名/端口段/任务 ID），
  Super-agent 的 `executor.prepare` 在 `<repo>/.workmates` 下创建目录；
  面板只从 Ticket 投影的顶层 `directory` 读取，归档时回收；
- **准入走 explicit**：Trigger `actor = { source: 'workmate', id: 'workmate:<createdBy>' }`、
  `human: true`、`addressed: 'mention'`；部署方把该身份加入来源 `workmate` 的
  `policy.allowed` 即可，**不需要接受规则**（explicit 绕过 `assessmentOutcome`）；
- **回滚三件事，缺一泄漏**：① `taskExecutor=team`；② 停用子包 bundle；
  ③ `node scripts/rollback-superagent.mjs`（不依赖执行器在线，三级定位目录，
  端口找不到时明确输出"可能泄漏"）；
- **面板**：默认视图是任务四列（待办/执行中/需要我/已完成），另有活动视图（历史 + 搜索）；
  `GET /api/config` 仍返回常量 `taskExecutor: 'superagent'` 给旧客户端读取；
- **接入手册**：`docs/SUPERAGENT-INTEGRATION.md`（安装、准入两步、prepare 模板、回滚、
  排查表）；安装自检 `node scripts/verify-source-install.mjs --profile <dir>`；
  无 GitHub 凭据时的引擎级演练 `pnpm verify:drill`（真实 `Engine` + 真实门禁 + 真实
  Source/Channel/prepare/reclaim + 真实 git，只缺 DSH worker 执行与 PR 绑定）。

## 多项目 target（2026-10-19，`multiproject-branch-workbench`）

`Proposal.targets: ProposalTarget[]` 是多仓/多基线提案的权威形状；旧字段
`projects`/`featureBranch`/`worktreePath`/`portRange` 只做兼容投影：

- `effectiveTargets()`：无 `targets` 时按第一个 project + 标量字段生成 legacy target；
- `ready→implementing` 为每个 target 建 worktree：路径 `<root>/.workmates/<proposalId>`、
  分支 `feature/<proposalId>`、端口键 `${proposalId}--${project}`，失败整体回滚；
  **这一条只适用于 `taskExecutor=team`**——`superagent` 模式下目录由 Super-agent 的
  `prepare` 创建（分支 `workmate/<Ticket 短名>`、端口键
  `${proposalId}--${project}--${taskId}`），见上一节；
- `archiving` 逐 target 校验 `featureBranch → baseBranch` 已合并，归档后逐 target 回收；
- 面板的详情抽屉按 target 展示 base/feature/worktree/端口；`/api/isolation` 暴露分支占用，
  `/api/isolation/writes` 暴露声明写域冲突，`/api/isolation/drift` 暴露基线漂移；
- 兼容规则：新代码读 `effectiveTargets`，不再假设单标量；写回时多 target 不写标量投影；
  `openspecTargets=all` 时 change 目录会在每个 target 生成（默认只主项目）。

## 里程碑路线（`docs/DESIGN.md` §7）

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M1 | 插件骨架与依赖装配 | ✅ 已归档 `2026-09-28-bootstrap-workmate-plugin` |
| M2 | 变更提案中间层（工具注册、openspec 目录生成、Git 关联、提案面板） | ✅ 已归档 `2026-09-28-add-proposal-middleware` |
| M3 | 知识桥接（GitNexus CLI / WeKnora） | ✅ 已归档 `2026-09-28-add-knowledge-bridge` |
| M4 | 归档编排闭环（openspec archive + gitnexus analyze） | ✅ 已归档 `2026-09-28-add-archive-orchestration` |
| M5 | 知识图谱可视化（SVG 分层视图） | ✅ 已归档 `2026-09-28-add-knowledge-graph-view` |
| M6 | 过程度量（提案事件流 + 派生度量 + `workmate_metrics`） | ✅ 已归档 `2026-10-04-add-proposal-metrics` |
| M7 | 反馈回流与控制带（来源/provenance + `workmate_bands` + 3σ 回流） | ✅ 已归档 `2026-10-04-add-feedback-loop` |
| M8 | 客户端工厂求值门禁（`pnpm verify:client`） | ✅ 已归档 `2026-10-04-add-client-factory-gate` |
| M9 | 原生工作台面板与控制台视图（`main` + `sidebar.panellist`） | ✅ 已归档 `2026-10-04-add-workbench-panel` |
| M10 | 审批记录与人工批准门（写码者不得批准） | ✅ 已归档 `2026-10-05-add-approval-records` |
| M11 | 分级审查 tally 与影子期（`reviewBlockingSeverities`） | ✅ 已归档 `2026-10-05-add-review-tally` |
| M12 | 控制带的确定性对外入口（`POST /api/bands` + `scripts/bands-watch.mjs`） | ✅ 已归档 `2026-10-05-add-bands-watch` |
| M13 | 规格库补齐（9 个历史变更归档同步） | ✅ `chore(openspec)` 提交 |
| M14 | 任务级并行载体（swarm：writes 装批 + 合并仲裁 + 归档门） | ✅ 已归档 `2026-10-05-add-swarm-parallel` |
| M15 | 工件账本与计划漂移（声明 vs 实际 + sha256 + 可选漂移门） | ✅ 已归档 `2026-10-05-add-artifact-ledger` |
| M16 | 判断层（agent/rules provider + 阈值动作 + decision 事件；Jev 接口占位） | ✅ 已归档 `2026-10-05-add-decision-layer` |
| M17 | 判断层四个消费节点（风险分级 / 审查归级 / 注入判定 / 任务判定） | ✅ 已归档 `2026-10-05-add-decision-nodes` |
| M18 | 判断缓存（同题复用 + `cached` 留痕 + 上限淘汰 + fail-open） | ✅ 已归档 `2026-10-06-add-decision-cache` |
| M19 | 项目 wiki 生成（`gitnexus wiki` 桥接 + 工具/REST + 索引新鲜度探针） | ✅ 已归档 `2026-10-06-add-wiki-generation` |
| M20 | wiki 产物完整性核验（`pages`/`complete`，半份产物必须被标出） | ✅ 已归档 `2026-10-06-harden-wiki-output` |
| M21 | SSE 归一代理的按需托管（健康探测 + 复用 + 不一致拒绝，无游离进程） | ✅ 已归档 `2026-10-06-manage-sse-proxy` |
| M22 | 网关 key 环境变量注入（`ESP_XKW_KEY` → 子进程 `GITNEXUS_API_KEY` + 来源探测不回显） | ✅ 已归档 `2026-10-06-inject-api-key-env` |
| M23 | `/workmate` 斜杠命令（help / status 只读 / wiki 确定性生成，不经过模型） | ✅ 已归档 `2026-10-06-add-workmate-command` |
| M24 | 项目隐式解析（会话 cwd / 项目名 / 相对路径；命令与工具都可省略路径） | ✅ 已归档 `2026-10-06-resolve-project-implicitly` |
| M25 | 凭据 fail-fast + 钥匙串解析链 + 陈旧产物守卫 + 一行判决 | ✅ 已归档 `2026-10-06-fail-fast-wiki-credentials` |
| M26 | 结果说明（CLI 摘要解析 / up-to-date 语义 / 耗时与结束提示） | ✅ 已归档 `2026-10-07-clarify-wiki-outcome` |
| M27 | 导出到 Obsidian/Tolaria vault（index/模块/迭代依赖 front-matter + 可选 git commit） | ✅ 已归档 `2026-10-07-export-wiki-to-vault` |
| M28 | 从 OpenSpec 归档派生迭代（日期/摘要/touches/派生血缘，声明与推导分开标注） | ✅ 已归档 `2026-10-07-derive-iterations-from-archive` |
| M29 | vault 视图笔记 + touches 增强（front-matter/裸路径/判断层归类）+ `workmate_wiki_search` | ✅ 已归档 `2026-10-07-vault-views-search` |
| M30 | 本地 Ollama 嵌入的语义检索（词法优先、语义兜底；向量哈希缓存，零新依赖） | ✅ 已归档 `2026-10-07-semantic-vault-search` |

**知识面已定型（2026-10-07 用户决策）：本地 markdown + Obsidian，放弃 WeKnora** —— GitNexus wiki → 导出 Obsidian vault（`index.md`/`modules/`/`iterations/`/`views.md`/`changelog.md`），人用 Graph+Dataview 读，AI 读同一批 markdown（`workmate_wiki_search` 返回文件:行号）；语义检索走本地 Ollama（bge-m3），重排走判断层 `search-rerank`。
待办（依赖外部条件）：@快捷指令（`@hucj/dsh-file-mention` 未装）、
`dsh-mcp-client` 的 profile patch 行（库已装但惰性）。~~WeKnora 真机契约核验~~（已放弃）；WeKnora 写路径与 embedding 不再实现。swarm 的任务级载体已落地（M14）：
"谁来执行任务"仍由调用方（子代理 / Agent Teams）决定，插件只负责 git 隔离与合并纪律；
工件账本与 plan-drift 已落地（M15）。判断层（M16）插件默认关闭，但**本机 web profile 已开启**（`cordis.patch.yml` 的 workmate 行：`decisionEnabled=true`、3 次采样、缓存开启）；插件侧默认仍是关闭，
`decisionProvider` 可切 `agent` / `rules` / `jev`（`jev` 仅接口占位，需 TypeSafe key 才有适配器）。

已知环境事实（2026-10-19 复核）：本机 profile **运行内核线是 `@deepseek-ai/dsh-tools 0.2.1-rc.2`**
（`~/.dsh/profiles/node_modules` 实装），但 rc.2 是 workspace 构建、**未发布到 npm registry**，
所以本仓库 devDependency 仍钉**可构建的 `0.2.1-alpha.1`**；`toolchain.json profile.dsh` 记录运行
基线 rc.2，`require`/devDependencies 记录构建基线 alpha.1，`peer` 保持 `*` 让两条线都能装载。
profile 侧 `@deepseek-ai/schemastery 3.18.5`、`@deepseek-ai/cordis 4.0.5`；本仓库构建用
`schemastery 3.18.5-alpha.1`、`cordis ^4.0.2`（与 alpha.1 线一致）。社区侧：`dsh-better-sidebar` 0.24.1+ 已适配，
`dsh-mnemon` / `@linxin666/*` / `@changfenhuang/dsh-annotation` 亦可用；
`dsh-auto-review`、`dsh-mcp-adapter`、`@open-agfs/dsh-agfs`、`dsh-outline`
**暂无兼容 0.2.x 的版本**（peer 停在 0.1.x）；`@deepseek-ai/dsh-mcp-client`
与 `@deepseek-ai/dsh-subagent-claude-code` 需升到 0.2.1-alpha.1。

## 归档门禁（2026-10-10 加固）

三道归档门（审查门 / 任务门 / 计划漂移门）的强制语义：

| 门 | 键 | 默认 | 说明 |
| --- | --- | --- | --- |
| 跳过门禁的权限 | `allowAgentForceArchive` | `false` | `force` 是**人的决定**：agent 调用会被拒，除非显式打开这个开关 |
| 审查者独立性 | `reviewerIndependence` | `'warn'` | `off`/`warn`/`block`；`block` 下 reviewer 缺失或与标记提交 author 同身份即拦归档；无 git 事实只 warn |
| 审查证据机检 | `reviewEvidenceGate` | `'warn'` | `off`/`warn`/`block`；`block` 下反引号引用指向不存在的文件即拦归档；行号越界只 warn；GitNexus 查询结论标注为不可机检 |
| 计划漂移 | `planDriftGate` | `false` | 只拦**改了没声明**（`undeclared` → failed）；**声明了没改**只产出一条 `warn` 步骤（计划写多了或改在别处，无法从 git 事实区分，不阻断）。提案自己的 `openspec/changes/<id>/` 是计划不是交付物，计入 `excluded` 而不算漂移。想在本机开启：在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 workmate 条目加 `planDriftGate: true` |
| 团队证据 | `teamEvidenceGate` | `'block'` | `off`/`warn`/`block`；有 `TASKS.json` 的变更在归档前必须有 `TEST.md`/`TEAM-REVIEW.md` 及规定段头 |
| swarm 逐任务核验 | `swarmReviewRequired` | `false` | `true` 时每个已合并 swarm 任务都必须有独立核验记录（`workmate_swarm_task action=verify`），自评（`same-as-author`）或取不到 git 事实（`undetermined`）都算未核验 |
| 归档步骤的成败判据 | 无（代码级，不可配） | — | `openspec-archive` 步骤不看退出码，只看**产物事实**：该变更是否真的从 `changes/<id>/` 移入 `changes/archive/<date>-<id>/`。**`openspec archive` 在 delta 解析失败时退出码仍是 0**（只打 `Aborted. No files were changed.`），所以"退出码 0 就报 ok"会让面板显示归档成功而目录原地不动（2026-10-12 四份提案全部命中，人工修 spec 段头才真正归档）。核验不过即 `failed` + `ok=false` + 提案停在 `archiving`，摘要带 CLI 原话与"仍在原地"。无 `specs/` 的变更与幂等重跑都不误伤 |

强制归档（`force`）必留痕：approval 记录的 `forcedGates` 列出被跳过的门，
`workmate_proposal_status` 返回 `forcedArchive`。**被门禁拒了不要改配置绕过**——
请用户在面板点「推进 / 强制归档」，那是设计里的唯一出路。

规约书写提醒（2026-10-12 实测）：`openspec/changes/<id>/specs/<cap>/spec.md` 的段头
**必须是 delta 段头**（`## ADDED Requirements` / `## MODIFIED Requirements` / …）。
写成 `## Requirements` 时 `openspec validate` 会失败、`openspec archive` 会 Aborted，
而它的**退出码仍然是 0**——别把退出码当成功信号。

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
| `docs/SUPERAGENT-INTEGRATION.md` | 子包安装、explicit 准入两步、prepare 模板、回滚与排查表 |
| `docs/SUPERAGENT-ACCEPTANCE.md` | 只能真机验证的项：勾选表与阶段对照 |
| `openspec/specs/` | 已归档能力规格 |

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **dsh-Helmsman** (5429 symbols, 11052 relationships, 311 execution flows). Use GitNexus graph tools to understand code, assess impact, and navigate safely.

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
