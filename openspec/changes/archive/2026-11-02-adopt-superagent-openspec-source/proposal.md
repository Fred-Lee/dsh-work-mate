# 把 WorkMate 的待办做成 Super-agent 的原生 Source

## Why

上一版方案把"任务面板"做成一个独立系统：它自己存任务、自己算状态、通过 HTTP 把 Trigger
推进 Super-agent，再通过代理把 Ticket 状态读回来，并靠手写 profile 行避免整包被自动启用。
这条路在技术上是能跑的，但它站在 Super-agent 的**外面**，于是必须自己解决四个它已经解决
过的问题：状态归属、状态投影、跨进程授权、装载与启停。

Super-agent 已经把这件事抽象好了：一个 **Source** 就是"某个外部世界里的事件流"。它自己
持有读取位置、定义什么算一个事件、把事件翻译成 Thread 与 Channel 地址、提供有界上下文
读取、注册执行环境变量、声明策略与健康。GitHub 与飞书就是这么接进来的。**一个本地待办板
和它们没有本质区别：它同样是一个外部世界的事件流。**

所以正确的形态不是"给 WorkMate 加一个桥"，而是**让待办板成为一个真正的 Source**：
- 待办由人写进一个外部存储（WorkMate 的任务文件），Source 读它；
- Source 把每条可执行的待办变成一个 Trigger，剩下的交给 Super-agent 的 Eval / Ticket /
  Assignment / Effects / Outbox；
- 执行事实（阶段、提问、结果）由 Source 的 Channel 写回任务文件，面板读同一条记录；
- 没有任何第二条状态机，没有跨进程 HTTP 触发，也没有"记得别把包加进 bundles"的接线。

WorkMate 自己只保留 Super-agent 没有、也不该有的东西：OpenSpec 工件校验、`planHash` 与
人工批准、写域/漂移/审查独立性/归档产物核验、多 target worktree 与知识沉淀。

## What Changes

- **新增一个独立的 Source bundle 包** `packages/superagent-source`（包名
  `workmate-superagent-source`，导出 `./source-watch`），装进 Super-agent 的 profile 后由
  插件管理器**自动启用**——不再需要手写 profile 行，也不存在"整包被误启用"的问题。
- **完整实现 SourceKind 契约**，而不是只实现最小子集：必填的
  `kind`/`title`/`description`/`schema`/`fields`/`health`，以及可选的 `scope`、`channel`、
  `threadContext`、`find`、`repliesTo`、`policy`、`environment`、`facts`。
  Super-agent 自己的 GitHub / 飞书 Source 用到的能力，待办板都用上。
- **任务存储拆成三个单写者文件**：`tasks.json`（人写的意图，只有面板写）、
  `inputs.jsonl`（人后续的回答，只有面板追加）、`tasks.jsonl`（Source 追加的**送达记录**，
  只有 Source 写）。append-only 的 JSONL 天然容忍撕裂尾行；每个文件只有一个写者，
  不需要跨进程锁。
- **依赖等待放进 Source**：`dependsOn` 未满足的待办不产生 Trigger。这符合 Super-agent
  自己的原则——"需要等待的条件属于 Source，Eval 不反过来依赖 Source"。
- **任务事实通过执行环境变量交给 worker**：`DSH_SUPERAGENT_WORKMATE_TASK` /
  `_ACCEPTANCE` / `_PRIORITY` / `_BASE_BRANCH` / `_PORTS` / `_COPY`（可选 `_PROPOSAL`）
  由 Source 注册，而不是让 WorkMate 把一整段任务描述塞进 prompt。
- **面板只做人的写侧与治理视图**：新建待办、指派、回答、停止，以及提案/门禁/归档；
  执行阶段与提问**从 Super-agent 读取**，不镜像、不缓存为第二份真相。
- **BREAKING**：`workmate_team_run` / `workmate_team_plan(start=true)` 默认不再派发
  worker。**后续变更（2026-11-02）**：团队执行器已随 `remove-team-executor` 整层删除，
  `taskExecutor` 配置不再存在；这里保留为当时的实现事实。
- **BREAKING**：`ready→implementing` 不再创建 worktree。目录改由 Super-agent 的
  `executor.prepare` 在首次 launch 时创建（`<repo>/.workmates/<Ticket 短名>`），
  分支改为 `workmate/<Ticket 短名>`；WorkMate 只保留规划（基线/端口）与回收。
- **准入方式改变**：待办走 explicit 准入——把 `workmate:<createdBy>` 加入来源的
  `policy.allowed` 即可，**不需要写接受规则**；前提是 Trigger 为
  `human: true` + `addressed: 'mention'` + `actor.source='workmate'`。
- **团队控制台降为只读投影**：执行态改读 Ticket，不在团队视图里回答/重试。
  **后续变更（2026-11-02）**：团队视图随 `remove-team-executor` 一并删除。

## 落地顺序与最小切片

先做一个可回退的纵向切片，再横向铺开：

1. **切片 A（只读投影）**：子包骨架 + 任务文件 + kind + 扫描器，`interactive=false`；
   面板仍可建待办、读 Ticket 阶段。价值：证明"文件 → Thread → 阶段"这条链路成立，
   且不产生任何工单。
2. **切片 B（投递）**：打开 `interactive=true`，验证 explicit 准入、去重、回答直通、
   Channel 回写。价值：一条真实待办能跑完。
3. **切片 C（worktree 归属）**：关闭旧 `ready→implementing` 建目录，改由 prepare 创建，
   验证分支命名、端口注入、回收前置。
4. **切片 D（降级与清理）**：团队工具默认关闭、团队视图只读、回滚脚本。

每个切片都必须能单独回退；A/B 不需要 C 就能验证，C 失败不影响 A/B 的观察。

**切片跨仓库。** 子包本身在本仓库实现，但"能不能真的跑起来"取决于把它装进 Super-agent
的 profile。因此每个切片结束都要用 `scripts/verify-source-install.mjs` 核验一次安装事实
（包已装、bundle 已启用、patch 只有一条、来源出现在 `--dump-config`），而不是等到最后。
任务 25 负责写出这个检查，任务 27 的收口门禁会跑它。

## 成功判据

- 一条真实待办从面板创建到 Ticket 结束，全程**没有人手动调用派发工具**；
- 同一待办重复扫描**不产生第二张 Ticket**；
- 面板显示阶段与 Super-agent 自己的 Execution 页**一致**（交叉核对，不靠自述）；
- 人在面板回答后，worker 在**下一步**读到，且不产生新 Ticket；
- 归档时能回收 `workmate/<短名>` 的目录与端口，`git worktree list` 无残留；
- ~~回滚到 `taskExecutor=team` 后旧团队路径仍能跑通~~（团队路径已于 2026-11-02 删除，
  回滚改为「停用子包 bundle + 跑回滚脚本」两件事）；
- `scripts/verify-source-install.mjs` 在三种状态下都给出正确答案：正常安装、包已装但
  bundle 未启用、包未安装。

## 停止条件

出现以下任一情形时暂停实施并重新评审，不要"带着问题往前走"：

- 子包装进 profile 后无法自动启用，或需要手改 bundles（说明独立 bundle 的假设不成立）；
- `prepare` 无法把目录建到 `<repo>/.workmates`（说明执行根的单路径假设不成立）；
- explicit 没有被识别（`actor.source` 或 allowed 缺失），退化为 inferred 后被规则拦截
  （说明 Strength 判定与文档不一致）；
- 面板读到的阶段与 Execution 页长期不一致（说明投影表有漏项）。

## Capabilities

### New Capabilities

- `superagent-source`：`workmate` SourceKind 的完整契约——任务文件、Trigger 形状、
  依赖门控、Channel 回写、有界上下文、执行环境变量、策略与健康。
- `task-intake`：人的写侧——三份单写者文件、面板的新建/指派/回答/停止/重开、状态展示的唯一来源、
  离线与空态、面板滚动与窄屏契约。
- `worktree-plan`：worktree 的规划与创建分属两侧——WorkMate 出计划（基线、分支名、端口段），
  Super-agent 的 `prepare` 在它自己的 Ticket 目录里创建；分支名以 Ticket 短名结尾以绑定 PR；
  回收前置为「Ticket 已结束 + 已合并」，遗留目录在面板可见并可手动回收。

### Modified Capabilities

- `lifecycle-state-machine`：`ready→implementing` 不建目录、不复制配置、不装依赖；
  `merging/archiving` 的完成判据改用 Ticket 结束与分支合并。
- `multi-target-worktree`：worktree 由 Super-agent 的 `prepare` 创建，WorkMate 只做规划与
  回收；分支名与 `baseCommit` 在观察到 Ticket 后回写。
- `workbench-panel`：主视图改为「任务」；提案看板保留为并列页签。

原计划中的 `team-orchestration` / `team-console` delta 已随 `remove-team-executor`
（2026-11-02）删除——那两个能力不复存在，不能再以"回退执行器"的形式修改。

## Impact

- **新增包**：`packages/superagent-source/`（`package.json` 声明
  `dsh.bundle.patch`，`cordis.patch.yml` 只有一条 entry；运行期依赖只有 `zod ^4`；
  `@deepseek-ai/cordis` 仅作类型 devDependency；**不依赖** `@deepseek-ai/dsh-superagent`）。
- **仓库结构**：新增 `pnpm-workspace.yaml` 把 `packages/*` 纳入构建；根包
  `workmate4dsh` 不变；`scripts/build.mjs` 增加子包构建；`pnpm verify` 覆盖子包的
  `verify:source`（加载产物、断言 kind 字段、断言无 orchestrator 不抛错）。
- **WorkMate 主包**：
  - 新增 `src/features/task/`（三份文件读写、任务服务、端口规划）、
    `src/features/superagent/contract.ts`（结构契约）、`src/features/worktree/reclaim.ts`（回收）；
  - 改 `src/api.ts`（`/api/tasks*`、`/api/superagent/health`、`/api/worktrees/*`）、
    `src/client/{App.tsx,api.ts,types.ts}`（任务主视图）、`src/config.ts`（新键）；
    （`src/features/team/` 已在后续 `remove-team-executor` 中删除）、
    `src/features/archive/service.ts`（`ready→implementing` 不建目录、G2 写待办）、
    `src/index.ts`（启动恢复边界）；
  - 改门禁与构建：`vitest.config.ts`、`tsconfig*.json`、`scripts/build.mjs`、
    `scripts/check-contract.mjs`（逐入口）、新增 `scripts/check-source-bundle.mjs`
    与 `scripts/rollback-superagent.mjs`。
- **不改 Super-agent 源码**；不新增 HTTP `POST /tickets`；不把 `workmate4dsh` 装进
  Super-agent 的 `dsh.profile.bundles`。
- **数据**：新增 `tasks.json` / `inputs.jsonl` / `tasks.jsonl`；`proposals.json` 结构不变
  （`team-runs.json` 随后续 `remove-team-executor` 停用，旧文件可手工删除）；
  `ports.json` 的键从 `${proposalId}--${project}` 改为 `${proposalId}--${project}--${taskId}`
  （旧键在回收时按 target 兜底兼容）。
- **worktree 归属变化**：`ready→implementing` SHALL NOT 再创建 worktree；目录由 Super-agent 的
  `prepare` 在 `<repo>/.workmates` 下创建，WorkMate 只保留规划、端口与回收。
- **文档**：新增 `docs/SUPERAGENT-INTEGRATION.md`（安装与准入）、
  `docs/SUPERAGENT-ACCEPTANCE.md`（真机验收勾选表）、验收证据 `evidence.md`；
  更新 `AGENTS.md`、`README.md`、`docs/TEAM-SETUP.md`（团队路径已降为回退）。
- **非目标**：不改 Super-agent 的 Eval/Policy/Outbox/Effects；不接 IM；不做云端常驻；
  不把 Claude Code / Codex 当作 Ticket 执行器（它们是一次性委派）。
