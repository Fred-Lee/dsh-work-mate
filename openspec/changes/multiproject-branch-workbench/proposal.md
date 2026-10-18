# 多项目多分支工作台：项目/分支选择与并行需求隔离

## Why

把 DSH 变成日常开发工作台，而不是只能服务单仓库项目的面板：在 UI 里选择要变更的项目、选择该项目基于的分支，一个需求可以同时落在 2–3 个仓库；多个需求并行时，物理与逻辑上都互不影响。

现状与代码事实（2026-10-18 核实）：

- `ProjectRegistry` 只有 `{name, root}`，没有默认分支/工作区分组；创建模态只能勾项目，不能选分支（`src/client/App.tsx:559`）。
- `Proposal.worktreePath / proposalBranch / featureBranch` 都是标量；`ready→implementing` 只对 `primaryRoot` 建一个 worktree，基线取全局 `Config.lifecycleMainBranch`（默认 `main`）（`src/features/archive/service.ts:412`）。
- `generateChangeDir` 只在单个 `projectRoot` 下生成 change 目录（`src/api.ts:492`）。
- `swarm` 有任务级 worktree + `writes` 装批，但只在一个 proposal/一个仓库内（`src/features/swarm/plan.ts`）。
- 真实工作证据（Claude Code 2026-10-12~17）：4 个高频业务仓库；`fix-wrong-ques-sub-answer-type-expose`、`add-ques-group-sub-correction` 均在 3 个仓库各存一份同名 openspec 目录；发生「切到 test 分支后实现被覆盖」、`fix/20261012` 建分支失败、分支基线关联到远端 main 等事故。

## What Changes

- 项目注册表扩展：`defaultBranch`（缺省自动探测 `main`/`master`）、可选 `workspace` 分组；新增分支列举与校验。
- DSH Workspace 候选发现：读取官方 Workspace 注册表，过滤 git 仓库/openspec 目录，面板「导入项目」一键加入 WorkMate 注册表；不自动导入，注册表仍是权威。
- 提案目标矩阵：`targets: [{project, baseBranch, proposalBranch, featureBranch, worktreePath, portRange}]`；旧标量字段保留并在单目标时继续写入（兼容旧数据、旧测试、旧归档逻辑）。
- 创建入口：REST、`workmate_proposal_create` 工具与面板模态都接受「项目 × 基线分支」；可指定 `primaryProject` 决定 OpenSpec 主目录。
- `implementing`：按 target 逐个创建 worktree（各自分支、端口、`.env`），任一失败则回滚已建目录并报错；`merging/archiving` 按 target 的 `baseBranch` 校验合并。
- 并行隔离：从活跃提案派生分支租约与写域占用（不新增第二份真相文件）；跨提案写域重叠默认阻断；基线 commit 漂移给 warn；面板提供项目×提案占用矩阵。
- 工作台视图：项目卡片（当前分支、脏文件、活跃 worktree）、分支选择器、worktree 释放。
- 证据驱动的自动推进：提案工件齐备即自动进入待确认；G2 确认 `planHash` 后自动进入执行；实现/审查/测试证据齐备后自动进入待合并；正常路径只保留「确认方案」「合并并归档」两道人门，UI 改为流水线视图，不再逐态点击「推进」。
- 面板信息架构重构（`docs/UI-REVIEW.md`）：上下文栏（Workspace/Project/分支/占用）常驻、项目树、列表优先 + 筛选/搜索、详情抽屉与预取、创建三步、命令面板；解决「看板单轴、归档占版面、详情两次点击、无搜索」。
- 控件体系对齐：引入宿主 `@deepseek-ai/dsh-client-ui-primitives`，用 `Button/Pill/SegmentedControl/Tag/StateDot/DisclosureRow/Modal/Tooltip/PathLabel` 替换手写控件；颜色/圆角/阴影只用 `--dsw-*` 语义令牌，去掉硬编码渐变与 emoji。

## Capabilities

### New Capabilities

- `multi-target-worktree`: 一个提案跨多个项目时，每个（项目，基线分支）一条 worktree/分支，含原子创建、端口与配置注入、清理。
- `parallel-isolation`: 多个并行提案之间的分支租约、基线漂移提示与写域冲突检测，以及占用矩阵的可视化数据。

### Modified Capabilities

- `project-registry`: 注册表增加默认分支与工作区分组，新增分支列举接口。
- `lifecycle-state-machine`: worktree 生命周期从「单 worktree」改为「按目标矩阵」，合并校验改为按目标基线分支。
- `workbench-panel`: 创建模态增加分支选择与主项目选择；新增工作台占用视图与释放操作。
- `approval-gate`: 默认批准门从「merging + archiving 两道」改为「merging 一道覆盖合并归档」，配置可恢复两道。

## Impact

- Host 代码：`src/features/project/{registry,implicit-root}.ts`、`src/features/worktree/manager.ts`、`src/features/proposal/{store,service,openspec}.ts`、`src/features/archive/service.ts`、`src/features/swarm/plan.ts`、`src/api.ts`、`src/index.ts`。
- Client：`src/client/{App.tsx,api.ts,styles.ts}`；新增 peer `@deepseek-ai/dsh-client-ui-primitives` 与 client inject（宿主已随 web-app 提供）。
- 数据：`projects.json` 增加字段（向后兼容）；`proposals.json` 增加 `targets`。
- 配置：`lifecycleMainBranch` 降级为「未配置项目默认分支时的兜底」；新增 `openspecTargets`（primary|all，默认 primary）；`approvalsRequired` 默认改为 `["merging"]`。
- 文档：新增 `docs/UI-REVIEW.md` 与 `docs/assets/ui/*`（改造前截图），作为 UI 验收对照。
- 测试：worktree/archive/state-machine/api/panel 的既有用例需扩展；新增多目标、隔离与面板交互用例。
- 真机：`pnpm build` + 重启 harness + 面板截图验收（jsdom 无布局引擎）；浅色/深色各一张。

## 来源 / Provenance

- source: `spec`
- 依据：Claude Code 一周会话分析（`docs/USAGE-ANALYSIS-2026-10-18.md`）
- 待确认问题见 `design.md` 的「Open questions」。
