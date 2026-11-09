# Tasks — 多仓库执行器

> 范围声明用行内 `<!-- writes: … -->`（`workmate_plan_drift` 读它）。
> **重启边界**：标 `[需重启]` 的条目只能由人在重启宿主后验收；worker 不得把它当作
> 自己能做到的验收项（change `support-multi-repo-executors` design D6）。

## 阶段 1 — Source 参数化（worker 可完成并自证）

- [x] 1. `packages/superagent-source/src/kind.ts`：`KIND` 常量改为 `DEFAULT_KIND` +
  `kindIdOf(config)`；实例配置新增 `kind`（默认 `workmate`，`^[a-z][a-z0-9-]*$`）
  与 `repos`（绝对路径数组，空 = 不限）；`FIELDS` 补两项
  <!-- writes: packages/superagent-source/src/kind.ts, packages/superagent-source/src/kind.test.ts -->
  > 实现偏差（已核实宿主契约后修正）：① 注册 id 只能由**插件条目** `config.kind` 给
  > （`settings.sources[kind]` 按已注册 kind 存，设置无法决定注册），所以 settings schema 里
  > `kind` 为**可选**、只做一致性校验；`FIELDS` 里用只读 `fact`（真实 id）展示它。
  > ② `repos` 不能用 `rows` 字段（Super-agent 的 FieldSpec `rows` 只编辑记录数组且必须带
  > `columns`，装不下 `string[]`），改为 `text` 字段 + schema 归一（逗号/换行分隔字符串 →
  > 绝对路径数组；JSON/API 直接写数组同样有效）。

- [x] 2. `packages/superagent-source/src/index.ts`：健康条目名、state 键前缀、
  Trigger `source`、Thread key 前缀、`find` 返回值全部按 `kindIdOf` 派生；
  `sources.register` / `context()` 用派生 id
  <!-- writes: packages/superagent-source/src/index.ts, packages/superagent-source/src/index.test.ts -->
  > 实现补充：默认实例新增旧 state 键（`workmate-source:cursor|tickets`）**只读回退**，
  > 避免升级丢已结束 Ticket 的映射导致依赖门控永久等待；实例标题带 id
  > （`WorkMate 待办（workmate-b）`）；`actor.source` 刻意保持 `workmate`（人的身份命名空间
  > 与全局 `policy.allowed` 不变）。

- [x] 3. `packages/superagent-source/src/watch.ts` + `gate.ts`：`GateTask` 增加
  `repo`；`scanOnce` 在 ready 列表上按实例 `repos` 过滤，其余计入 `skippedByRepo`
  并进健康摘要；被跳过的待办不推进游标
  <!-- writes: packages/superagent-source/src/watch.ts, packages/superagent-source/src/gate.ts,
      packages/superagent-source/src/watch.test.ts, packages/superagent-source/src/gate.test.ts -->
  > 实现补充：repo 匹配 = trim + 路径规范化（尾斜杠容忍），**不**按 basename 猜；
  > `validateConfig` 拒绝 `repos` 里的相对路径（相对路径永远匹配不上绝对 `repo`，宁可报错）。

- [x] 4. 单测：两个实例（`workmate` / `workmate-b`）各自注册不冲突、健康条目独立、
  state 键不串台；`repos` 过滤只投命中项且 `skippedByRepo` 计数正确
  <!-- writes: packages/superagent-source/src/index.test.ts, packages/superagent-source/src/watch.test.ts -->
  > 实现补充：另覆盖「默认实例旧 state 键只读回退」「实例标题/instance fact」「非法 id 装载
  > 失败且装错 profile 仍安静」「设置里的 kind 与装载 id 不一致时健康报错」。spec 场景「同一
  > 待办不被两个实例重复投递」用**不相交 repos** 的分区形态表达——`repos` 都为空时两个实例
  > 物理上都会投（空 = 不限），这是配置问题，已在接入手册 §10.6 写进排查表。

## 阶段 2 — WorkMate 侧集合判定

- [x] 5. `src/config.ts`：新增 `executorRepos`（字符串数组，默认 `[]`）与
  `superagentEndpoints`（数组，默认 `[]`）；保留 `executorRepo` / `superagentEndpoint`
  为兼容单值；interface 与 Schemastery schema 两份同步
  <!-- writes: src/config.ts, src/config.test.ts -->

- [x] 6. `src/index.ts`：装配时把 `executorRepo` + `executorRepos` 归一成集合传给
  `TaskServiceImpl`；`superagentEndpoints` 为空时用 `[superagentEndpoint]`
  <!-- writes: src/index.ts -->

- [x] 7. `src/features/task/service.ts`：`connectable()` 改集合判定
  （`repos.length === 0 || repos.includes(task.repo)`）；不匹配时错误信息点明仓库与
  已接入集合；`TaskCard` 增加 `unservedRepo` 供面板提示
  <!-- writes: src/features/task/service.ts, src/features/task/task.test.ts -->

- [x] 8. `src/features/superagent/client.ts`：支持多端点——每端点独立取 health 与
  tickets，失败只影响自身；聚合结果带 `endpoints: [{endpoint, online, reason?}]`
  <!-- writes: src/features/superagent/client.ts, src/features/task/task.test.ts -->
  > 实现偏差：单个端点离线时**无法逐卡归因**到该端点（主包没有 repo→endpoint 映射），
  > 因此卡片保持原投影、离线原因进 `board.endpoints` 与 `notes`，不伪造 `unknown`
  > （spec 要求「显示离线原因而非空白」已满足）。`health` 单值保留（取首端点）给旧客户端。

- [x] 9. `src/client/TasksView.tsx`：卡片显示「未接入执行器（仓库 X）」并禁用指派；
  顶部显示「N 个执行器，M 个离线」
  <!-- writes: src/client/TasksView.tsx, src/client/tasks-view.test.tsx -->

## 阶段 3 — 文档与验收

- [x] 10. 文档：`docs/SUPERAGENT-INTEGRATION.md` 增「多仓库部署」一节（每仓一个
  实例：stateDir / executor.directory / deployment.repository / source.repos 四处
  必须一致）；`AGENTS.md` 执行层一节补多实例要点
  <!-- writes: docs/SUPERAGENT-INTEGRATION.md, AGENTS.md -->
  > 已落地为接入手册 §10（含两种部署形态、kind 来源、四处一致检查清单、WorkMate 侧
  > `executorRepos` / `superagentEndpoints`、重启边界、多仓排查表）。
  > 面板 Before/After 对照见 `openspec/changes/support-multi-repo-executors/evidence/`
  > （构建产物 + 固定夹具渲染，**不是**真机验收；限制写在 evidence/README.md）。

- [x] 11. 门禁：`pnpm typecheck && pnpm test && pnpm build && pnpm verify`；
  `pnpm test:toolchain`；`pnpm verify:built` 工具面不变（18）
  <!-- writes: （无源码写域；仅运行命令与记录） -->

- [x] 12. **[需重启] 真机验收（已执行 2026-11-09）**：配第二个实例（`kind: workmate-b`、
  `repos: [<第二仓库绝对路径>]`、独立 stateDir 与 executor.directory），重启宿主；
  在两个仓库各建一条待办，确认：面板分别显示可指派、
  两条各进自己的执行器、健康条目独立、归档门逐 target 校验。
  **本项不由 worker 验收**——重启会终止 worker 自身。
  <!-- writes: （无仓库内写入：面板与 profile 操作，证据写 review.md） -->
  > **已验收（2026-11-09，同一进程多实例形态）**：
  > 建第二仓库 `wm-second-repo`，profile 加 `- insert:` 条目装载 `kind: workmate-b`；
  > 两实例共用 `tasks.json`，`repos` 分别指向各自仓库。
  > 证据：① 两实例同时注册成功（无 `already registered`）；
  > ② 健康摘要 `workmate`="投递 3，跳过 1 条（非本实例仓库）"、
  > `workmate-b`="投递 1，跳过 3 条（非本实例仓库）"；
  > ③ 两仓各生成一条 Ticket，**worktree 分别建在各自的 `.workmates/`**；
  > ④ 健康条目独立、时间戳各自更新。
  > 未在本轮验的：每仓一进程的标准形态（要两个 profile/进程，本机成本高），
  > 其差异仅在 kind 不需唯一，不改变分流判据。
  > 原记录：未验收（worker 无法重启宿主）。注意验收要区分两种形态（见接入手册 §10.1）：
  > ① **标准多仓** = 每个仓库一个 Super-agent 部署（各自 profile/进程、独立 stateDir /
  > deployment.repository / executor.directory），各自 Source 用默认 `kind: workmate` 即可——
  > 这一步验证的是 `repos` 过滤、面板 `executorRepos` 可指派性与多端点聚合；
  > ② **同进程双实例** = 在同一个 profile 里加第二条 entry `config.kind: workmate-b`，
  > 验证 kind 注册不冲突、健康条目/state 键互不串台。该形态共享同一执行器，只用于验证
  > 实例隔离语义，**不是**跨仓执行形态。
