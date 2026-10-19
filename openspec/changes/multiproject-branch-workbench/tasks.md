# Tasks

## 1. 注册表与项目维度

- [x] 1.1 `ProjectRegistry` 记录扩展为 `{name, root, defaultBranch?, workspace?}`：读取兼容旧两项，写入保留未知字段；`defaultBranch` 缺失时按 `main` → `master` 探测并回填，探测不到不写。<!-- writes: src/features/project/**, src/features/proposal/store.ts -->
- [x] 1.2 新增只读分支列举与校验：`GET /workmate/api/projects/:name/branches` 返回 `current/default/local[]/remote[]`；不存在或未注册返回可读错误与候选。<!-- writes: src/api.ts, src/features/project/** -->
- [x] 1.3 面板注册项目时可选填默认分支与工作区名；未填走探测。<!-- writes: src/client/App.tsx, src/client/api.ts -->

- [x] 1.4 DSH Workspace 候选发现：读取 `ctx.workspaceRegistry`，过滤存在/git 仓库/未注册/路径不重复；只读，不自动导入。<!-- writes: src/features/project/**, src/api.ts -->
- [x] 1.5 面板「导入项目」：候选列表（标题/路径/当前分支/openspec）+ 一键加入注册表（探测默认分支）；服务不可用时隐藏并说明。<!-- writes: src/client/App.tsx, src/client/api.ts -->

## 2. 提案目标矩阵

- [x] 2.1 `ProposalTarget` 类型与 `targets` 持久化；`effectiveTargets(proposal)` 兼容层（旧标量合成单目标），单目标继续回写标量。<!-- writes: src/features/proposal/** -->
- [x] 2.2 创建入口接受 `targets`（`"project:branch,project:branch"` 或结构化）与 `primaryProject`；工具与 REST 共用同一校验；`generateChangeDir` 按 `openspecTargets`（primary|all）落主/副项目。<!-- writes: src/api.ts, src/index.ts, src/config.ts -->

## 3. 多目标 worktree

- [x] 3.1 `WorktreeManager` 按 `(proposalId, project)` 创建：路径 `<root>/.workmates/<id>`、分支 `feature/<id>`、端口键 `${id}--${project}`、`.env` 注入与安装策略保持。<!-- writes: src/features/worktree/** -->
- [x] 3.2 `ready→implementing`：对全部 target 预检（项目/根/基线分支/路径/可写），逐个创建；任一步失败按逆序回滚已建 worktree 与端口，状态不变并返回失败 target。<!-- writes: src/features/archive/service.ts -->
- [x] 3.3 `merging/archiving` 按 target 的 `baseBranch` 校验合并；`archived` 清理全部 target worktree；单目标旧数据路径不变。<!-- writes: src/features/archive/** -->

## 4. 并行隔离

- [x] 4.1 占用派生：从活跃提案的 `effectiveTargets` + worktree 存在性计算 `(project, branch) → proposal`，不新增持久化文件；同项目同名分支即冲突。<!-- writes: src/features/proposal/**, src/features/worktree/** -->
- [x] 4.2 写域冲突：复用 `scopesIntersect` 解析提案声明范围，implementing 前与同项目其它活跃提案求交；声明重叠默认阻断，未声明 warn，可配置。<!-- writes: src/features/swarm/plan.ts, src/features/quality/** -->
- [x] 4.3 基线漂移：记录 `baseCommit`，与基线当前 HEAD 不同即返回 warn（附命令建议），不阻断。<!-- writes: src/features/archive/service.ts, src/features/proposal/** -->

## 5. 面板 A：控件与视觉对齐

- [x] 5.1 引入 `@deepseek-ai/dsh-client-ui-primitives`（peer + client inject + 客户端构建白名单），`pnpm verify:client` 仍绿。<!-- writes: package.json, src/index.ts, scripts/** -->
- [x] 5.2 用共享控件替换手写控件：`Button` / `Pill` / `SegmentedControl` / `Tag` / `StateDot` / `DisclosureRow` / `Modal` / `Tooltip` / `PathLabel`；删除手写 `.wm-btn/.wm-pill/.wm-modal` 及其渐变。<!-- writes: src/client/App.tsx, src/client/styles.ts -->
- [x] 5.3 颜色/圆角/阴影只用 `--dsw-*` 语义令牌；去掉硬编码 `#6366f1/#22d3ee`、emoji logo、`prefers-color-scheme` 分支；补 reduced motion。<!-- writes: src/client/styles.ts -->

## 6. 面板 B：信息架构重构

- [x] 6.1 上下文栏：Workspace / Project / 当前分支下拉 + 占用徽标 + 搜索 + 主按钮；切换项目过滤主区。<!-- writes: src/client/App.tsx, src/client/api.ts -->
- [x] 6.2 项目树：按 workspace 分组，显示当前分支、脏文件、活跃 change、活跃 worktree；窄屏收起为下拉。<!-- writes: src/client/App.tsx, src/client/styles.ts -->
- [x] 6.3 主区列表优先：默认「我的变更」列表（进行中优先），看板为第二视图；筛选（全部/进行中/待批准/已归档）、项目筛选、搜索；已归档默认折叠。<!-- writes: src/client/App.tsx, src/client/api.ts -->
- [x] 6.4 详情抽屉：选中行预取并打开；分段（概览/目标矩阵/任务/审查/事件）+ 固定动作条；去掉行内展开与「加载详情」二次点击；逐 target 展示分支/worktree/端口与释放操作。<!-- writes: src/client/App.tsx, src/client/styles.ts -->
- [x] 6.5 创建三步模态：项目多选 → 每项目基线分支（默认 `defaultBranch`）→ 确认主项目/OpenSpec 归属/`feature/<id>` 预览；错误就地显示在项目行。<!-- writes: src/client/App.tsx, src/client/api.ts -->
- [x] 6.6 反馈与可访问性：首屏 skeleton、Toast、pending/disabled、行语义与 `aria-current`、抽屉焦点与 Escape、命令面板（`/` 或 Cmd+K）。<!-- writes: src/client/App.tsx, src/client/styles.ts -->
- [x] 6.7 响应式：≥1200 三区、900–1200 项目树折叠、<900 单列 + 详情整页；面板根高度与唯一滚动容器契约不被破坏（`fix-panel-scroll`）。<!-- writes: src/client/styles.ts, src/client/App.tsx -->
- [x] 6.8 流水线视图：`方案 → 待确认 → 执行中 → 待合并 → 已归档`，只保留「确认方案」「合并并归档」两个主操作；逐态推进收进详情覆盖操作；`planHash` 失效时提示重新确认。<!-- writes: src/client/App.tsx, src/client/styles.ts -->

## 7. 测试与验证

- [x] 7.1 单测：注册表字段兼容/探测、targets 兼容层、多目标创建与回滚、按 target 合并校验、占用冲突、写域冲突（含未声明 warn）。<!-- writes: src/features/**/*.test.ts, src/api.test.ts -->
- [x] 7.2 客户端测试：上下文栏/项目树/列表筛选/抽屉/创建三步/键盘可达；`pnpm verify:client` 仍绿。<!-- writes: src/client/*.test.tsx -->
- [x] 7.3 门禁：`pnpm typecheck && pnpm test && pnpm build && pnpm verify` 全绿；测试自证门禁不放宽。<!-- writes: package.json -->
- [x] 7.4 真机验收：装进 web profile，建 2–3 项目提案（不同基线分支），走 ready→implementing，截图工作台占用与详情抽屉；第二个并行提案验证冲突提示；浅色/深色各一张。<!-- writes: docs/UI-REVIEW.md -->
- [x] 7.5 UI 验收对照 `docs/UI-REVIEW.md` §6 的 7 条标准，before/after 截图存入 `docs/assets/ui/`。<!-- writes: docs/assets/ui/** -->

## 8. 证据派生与自动推进

- [x] 8.1 `ProposalReadiness` 评估器：工件完整性、OpenSpec validate、`planHash`、审批、团队 run/Task、target 合并状态。<!-- writes: src/features/proposal/**, src/features/quality/** -->
- [x] 8.2 `reconcile(proposalId)`：幂等推进非人工门；不跨 G2/G5；自动转移写 `auto:'evidence'` 与证据快照。<!-- writes: src/features/proposal/**, src/features/proposal/events.ts -->
- [x] 8.3 G2 `planHash`：`REQ+PLAN+TASKS` 规范化哈希；批准记录绑定哈希；工件变化自动退回 reviewing。<!-- writes: src/features/proposal/**, src/features/archive/** -->
- [x] 8.4 G5 合并/归档合并为一次人工批准（默认），配置可恢复两道；批准后协调器合并 target 分支并跑归档编排。<!-- writes: src/features/archive/**, src/config.ts -->
- [x] 8.5 兼容：旧提案按同一评估器推导；`mode=advance` 手动入口保留但不再是 UI 主路径；补迁移测试。<!-- writes: src/features/proposal/**, src/api.test.ts -->
- [x] 8.6 批准门默认改为 `['merging']`：一次批准覆盖合并归档；配置可恢复两道；更新 approval-gate 规格与测试。<!-- writes: src/config.ts, src/features/archive/**, src/features/archive/*.test.ts -->
- [x] 8.7 提案分支降级为可选追溯：移除 reviewing/ready 对 `proposal/<id>` 存在/合并的前置；保留字段与手动分支流程。<!-- writes: src/features/archive/service.ts, src/features/proposal/** -->

## 9. 文档与归档

- [x] 8.1 更新 `AGENTS.md` 的插件契约/数据落盘/里程碑（M31+），说明 `targets` 与旧标量的兼容规则。<!-- writes: AGENTS.md, CLAUDE.md -->
- [ ] 8.2 补齐 `openspec/specs/` 主规格并执行归档编排；归档前跑 `review.md` 审查门。<!-- writes: openspec/** -->
