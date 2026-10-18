# Design — 多项目多分支工作台：项目/分支选择与并行需求隔离

## Context

WorkMate 当前是「单项目根 + 单 worktree」模型：提案关联多个项目名只用于展示与 Git 扫描，真正创建 worktree 时只取 `primaryRoot`，分支基线取全局 `Config.lifecycleMainBranch`。面板已有项目多选与注册，但没有分支维度；OpenSpec 目录只在单个根下生成。

真实工作却是多仓的：一个需求常同时改 internal-homework（数据/判定）、homework-server（BFF）、zujuan-online-job（前端），或 sync-service-consumer + internal-ugc（消息/消费侧）。仓库的默认分支并不统一（main / master / 长期 test / 特性基线），且同一项目上会并行跑多个需求。

## Goals / Non-Goals

**Goals:**

- 创建提案时能选「项目 × 基线分支」，支持一次选多个项目，并指定主项目。
- 一个提案的实现阶段在 N 个仓库各有一条 worktree 与特性分支，基线各自独立。
- 多个并行提案之间：物理隔离（worktree）+ 逻辑隔离（分支占用/写域冲突/基线漂移提示）。
- 面板能看到「哪个项目、哪条分支、被哪个提案占用」，并能释放 worktree。
- 旧提案与单项目流程不破坏，数据可回退。

**Non-Goals:**

- 不重做归档门禁、度量、判断层。
- 不做远程 push / PR / CI 编排；worktree 与分支仍是本机语义。
- 不做跨仓库自动合并；每个 target 各自合并、各自校验。
- 不自动把任意 Workspace 目录变成项目：只做候选发现与一键确认，注册表仍是权威。
- 不实现「打开工作区即起新 DSH 会话」（需要宿主能力，先只提供路径与打开方式）。

## Decisions

### D1 层级：Workspace（可选）→ Project → ProposalTarget → SwarmTask

- `Project`：`{name, root, defaultBranch?, workspace?}`，仍是注册表的唯一记录。
- `ProposalTarget`：`{project, baseBranch, baseCommit?, proposalBranch, featureBranch?, worktreePath?, portRange?}`。
- `SwarmTask` 保持「一个 proposal 内、一个仓库内」的任务级 worktree，父载体变为「该 proposal 在对应 project 的 target worktree」。

### D2 基线分支解析顺序（fail-closed）

显式 `target.baseBranch` > `project.defaultBranch` > `Config.lifecycleMainBranch`。`project.defaultBranch` 缺省按 `main` → `master` 探测；两者都不存在时**回退到 `Config.lifecycleMainBranch`**，仍不存在则失败并返回候选分支列表，而不是猜或取当前检出分支。只有用户显式指定时才允许 `test` / 长期特性分支等非主干基线。分支必须已存在；创建时记录 `baseCommit = git rev-parse <baseBranch>`，后续用于漂移提示。

> 2026-10-19 用户决策：基线默认就是 main/master，除特别说明外不采用当前 checkout 分支。

### D3 兼容：标量字段是单目标投影，不是第二份真相

`worktreePath / proposalBranch / featureBranch / portRange` 继续保留，并在 `targets.length === 1` 时写入同一个值；多目标时只写 `targets`，旧字段留空。读取端统一走 `effectiveTargets(proposal)`：有 `targets` 用 `targets`，否则由旧标量合成单目标。旧数据不迁移、不回写。

### D4 OpenSpec 归属：主项目持有全文，副项目持有指针（已确认）

`primaryProject` 决定 `generateChangeDir` 的根。默认 `openspecTargets: 'primary'`，副项目不生成重复目录；`'all'` 时副项目写入一个短 `proposal.md`，首行标注主仓与镜像关系，不复制 design/specs（避免双份内容漂移）。真实工作里「每仓一份同名目录」的现象由此显式建模，而不是靠人肉保持一致。

> 2026-10-19 用户决策：按推荐采用 primary-only 权威，副仓指针。

### D5 隔离三层，租约派生而非新存储

1. **物理**：每个 `(proposal, project)` 一条 worktree，路径沿用 `<root>/.workmates/<proposalId>`；已存在则幂等复用。
2. **分支**：`proposal/<id>` 与 `feature/<id>` 是提案命名空间；同一项目内出现同名分支即报冲突（列占用提案）。
3. **写域**：复用 `swarm/plan.ts` 的 `scopesIntersect`。提案在 `design.md`/`tasks.md` 用 `<!-- writes: a/**, b/** -->` 声明范围；启动 implementing 时与同项目其它活跃提案的声明范围求交，重叠默认阻断，未声明只 warn（2026-10-19 已确认）。
4. **基线漂移**：`baseCommit` 与 `baseBranch` 当前 HEAD 不同即 warn（不阻断），提示 rebase 或重新切基线。

租约与占用全部**从活跃提案 + worktree 存在性派生**，不新增 `leases.json`，避免第二份真相。

### D6 端口分配按 (proposal, project) 键

`PortAllocator` 的键从 `proposalId` 改为 `${proposalId}--${project}`；同一提案在多仓的 worktree 各自拿到独立端口段，释放时按 target 归还。

### D7 创建原子性

`implementing` 先对所有 target 做预检（项目已注册、根存在、基线分支存在、worktree 路径未被占用、文件系统可写），全部通过后逐个创建；中途失败按逆序 `git worktree remove` 已创建的目录并清理端口，返回失败 target 与原因。预检失败不改状态。

### D8 面板

- 创建模态：项目多选后，每个项目展开一个基线分支下拉（来自 `GET /workmate/api/projects/:name/branches`），默认选中 `defaultBranch`；主项目单选；预览 `feature/<id>`。
- 新增「工作台」视图：项目卡片（当前分支、脏文件、OpenSpec 活跃 change、活跃 worktree 数）+ 占用矩阵（项目 × 提案 × 分支）。
- 提案详情：每个 target 一行，显示基线/特性分支、worktree 路径、端口；提供「释放 worktree」（未合并时二次确认）与「复制路径」。

### D9 失败与降级

项目根不可解析时该 target 标 `unresolved`，其余 target 继续；面板显示原因。历史提案（无 targets）在详情里标记「单目标旧格式」，不自动改数据。

### D10 UI 信息架构：上下文栏 + 项目树 + 列表优先 + 详情抽屉

评审依据见 `docs/UI-REVIEW.md`（headless Chrome 截图 + DSH 原生包对照）。当前面板只有「生命周期看板」一根轴，项目/分支/并行占用都在二级；归档占版面 62%；详情两次点击。改为：

- **上下文栏常驻**：Workspace / Project / 当前分支三个下拉 + 占用徽标 + 搜索 + 主按钮；切换项目即过滤主区。
- **项目树**：按 `workspace` 分组，显示当前分支、脏文件、活跃 change、活跃 worktree；窄屏收为下拉。
- **主区列表优先**：默认「我的变更」列表（进行中优先），看板保留为第二视图；已归档默认折叠到筛选后。
- **详情抽屉**：选中行即预取并打开抽屉；分段（概览/目标矩阵/任务/审查/事件）+ 固定动作条；不再行内展开、不再「加载详情」二次点击。
- **创建三步**：项目多选 → 每项目选基线分支 → 确认主项目与 OpenSpec 归属；错误就地显示在对应项目行。创建入口参考 WorkDSH 的「项目首页 + 从模板创建」结构（见 `docs/WORKDSH-REVIEW.md`）。
- **命令面板**：`/` 或 Cmd+K，提供新提案/推进/释放 worktree/切换项目与分支。

### D11 UI 组件体系：共享控件与语义令牌

按 `docs/web-styling.md` 的规则：`ui-primitives` 是唯一允许跨插件复用的控件通道。面板 SHALL 引入 `@deepseek-ai/dsh-client-ui-primitives`（peer + client inject），用 `Button` / `Pill` / `SegmentedControl` / `Tag` / `StateDot` / `DisclosureRow` / `Modal` / `Tooltip` / `PathLabel` 替换手写控件；颜色只用 `--dsw-alias-*`，圆角走 `--dsw-radius-*`，去掉硬编码渐变、emoji logo 与 `prefers-color-scheme` 分支。首屏 skeleton、成功/失败 Toast、pending/disabled、焦点可见与 reduced motion 一并补齐。

本期只做 A（视觉对齐）+ B（IA 重构）；C（DSH Workspace 作为项目来源、`ctx.betterSidebar` 常驻 tab、从 worktree 起会话、`shell.bottom` 状态条）留到后续，不在本提案 Non-Goals 之外承诺。

### D12 状态由证据派生、自动推进，只留两道人门

OpenSpec 调研/设计阶段已经把内容写完；再看板逐态点击审核是重复阅读与重复确认。状态 SHALL 由证据派生的「当前阶段」而不是人工点击的产物；正常路径只保留两道人门：

| 可见阶段 | 内部状态 | 进入条件 | 触发 |
|---|---|---|---|
| 方案 | `draft → proposing` | 提案创建、工件生成 | 自动 |
| 待确认 | `reviewing` | 工件完整 + OpenSpec validate + 自动机检无 CRITICAL + `planHash` 生成 | 自动 |
| 已确认 | `ready` | 人 G2 确认该 `planHash` | 人（一次） |
| 执行中 | `implementing` | 团队 run 启动、各 target worktree 创建 | 自动 |
| 待合并 | `merging` | 全部 target 实现完成 + 审查/测试证据通过 | 自动 |
| 归档中 | `archiving` | 人 G5 批准；feature 分支合并进基线 | 人（一次）+ 自动 |
| 已归档 | `archived` | 归档编排成功 | 自动 |

- `ProposalReadiness` 评估器读 OpenSpec 工件、`planHash`、审批记录、团队 run/Task、target 合并状态；`reconcile(proposalId)` 幂等推进，只走非人工门。
- G2 批准绑定 `planHash`；方案改动即失效、自动退回待确认。
- G5 默认一次批准覆盖「合并 + 归档」；`Config.approvalsRequired` 默认改为 `['merging']`，可在配置中恢复 `['merging','archiving']` 两道人工批准。
- `planHash` SHALL 由方案工件规范化计算：OpenSpec 的 `proposal.md/design.md/tasks.md/specs/**`；若团队模式已生成 `REQ.md/PLAN.md/TASKS.json`，一并纳入。单目标旧提案同样适用。
- G2 前自动机检：`solution-evaluator` 与 `reviewer` 对方案工件（OpenSpec 或团队工件）做完整性/一致性检查；CRITICAL 阻断，其余作为提示随 `planHash` 展示，人只做一次确认。
- `proposalBranch` 变为可选追溯字段：reviewing/ready 不再以提案分支存在/合并作为前置；既有手动分支流程仍可用，但自动推进不依赖它。
- `workmate_proposal_archive(mode=advance)` 保留为手动覆盖/回退入口，不是 UI 主路径。
- 自动转移写 `events` 并带 `auto: 'evidence'` 与证据快照；人工门保留 approval 记录。

### D13 DSH Workspace 项目候选发现

DSH 已有官方 Workspace 注册表（`ctx.workspaceRegistry`），保存用户主动添加的目录。本期把它作为**项目候选来源**，而不是第二份项目表：

- 面板「导入项目」读取 Workspace 列表；对每个目录做只读过滤：存在、是 git 仓库、未在 WorkMate 注册表、规范化路径不重复。
- 候选行显示标题/路径/当前分支/是否含 `openspec/`；一键「加入项目」写入 WorkMate 注册表（探测 `main`/`master` 作为默认分支，`workspace` 取 Workspace 标题或路径父目录）。
- **不自动导入**；Workspace 删除不影响已注册项目，项目移除也不动目录。
- `workspaceRegistry` 不可用时隐藏入口并说明原因（reactive inject，不 park fiber）。
- 注册表仍是提案关联与分支的权威表；Workspace 只提供候选，避免第二份真相。

## Risks / Trade-offs

- **worktree 数量爆炸**：3 仓 × 5 并行提案 = 15 份依赖目录。缓解：只在 implementing 惰性创建、归档/释放时清理、工作台显示占用与磁盘提示。
- **依赖安装成本**：每个新 worktree 都跑一次包管理器。沿用现有 `install` 策略；可在 target 级增加 `skipInstall`（本期不做）。
- **基线漂移**：只提示不阻断，可能带着旧基线下手。记录 `baseCommit`，归档前可复核。
- **OpenSpec 双份/指针**：`'all'` 模式有漂移风险，默认 `'primary'`；配置项留给真实需要的仓库集合。
- **既有测试与归档逻辑**：大量用例假设单 worktree；通过 `effectiveTargets` 兼容层收敛改动面，逐步补多目标用例。
- **分支名占用误报**：本地分支存在但属于历史提案时，按「活跃提案」判定，不把归档提案算作占用。
- **ui-primitives 可用性**：它是宿主 web-app 提供的包，需在 `peerDependencies` 与客户端 external 白名单里显式声明；`pnpm verify:client` 会在 VM 求值时暴露缺失。若宿主/旧 profile 不提供，面板应回退到现有控件而不是整块白屏。
- **UI 重构与既有测试**：客户端测试目前断言大量 `wm-*` 类名与内联结构；A/B 阶段会重写面板，测试需同步迁移，不能用放宽断言的方式过关。

## 已确认的决策（2026-10-19）

1. **OpenSpec 权威**：主项目持有全文，副项目只放指针（D4）。
2. **基线默认**：项目 `defaultBranch`（`main`/`master` 探测）；只有显式指定才用其它分支（D2）。
3. **写域冲突**：声明范围重叠阻断，未声明只 warn（D5-3）。
4. **本期范围**：模型 + 多目标 worktree + 并行隔离 + 面板基础 + DSH Workspace 候选发现；选中 worktree 起会话留到后续（Non-Goals）。
5. **UI 信息架构**：上下文栏 + 项目树 + 列表优先 + 详情抽屉；控件统一到 `ui-primitives` 与 `--dsw` 令牌；本期做 A 视觉对齐 + B IA 重构，C 深度集成（DSH Workspace / better-sidebar tab / 起会话）留到后续（D10/D11，`docs/UI-REVIEW.md`）。

## 仍待定（不阻塞本期）

- **workspace 自动扫描**：是否在后续提案里批量注册 `~/Documents/xkw_workspace/*` 并按 workspace 分组。
- **打开工作区**：面板是否需要「以某 target 的 worktree 为 cwd 起 DSH 会话」，依赖宿主会话 API，单列变更。
- **写域档位**：是否把「声明重叠」做成 `block|warn` 可配，而不是默认 block。
- **UI 细节**（见 `docs/UI-REVIEW.md` §7）：默认列表还是看板；归档是否默认隐藏；是否接入 DSH Workspace；「控制台/知识图谱」是否降为二级入口；右侧栏常驻 tab 是否进下一阶段。
