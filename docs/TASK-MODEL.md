# 任务工作项模型（Task WorkItem）

> 本文对应变更 `add-task-workitem-model`。它描述 Helmsman 里的「一次任务」如何在
> orchestrator 的 run 之上多出一层**跨阶段聚合根**（WorkItem），以及宿主（`@helmsman/ui-workbench`）
> 如何从一段对话建立任务卡片。相关实现：`packages/board`（纯 Service）、
> `packages/ui-workbench`（建档通道 + 摘要）、`packages/ui-board`（看板页面）。
> 文中标注「借鉴」的形状来自 `docs/DSH-INTEGRATION-NOTES.md` 的 B 级条目（未在本机验证过的
> 外部经验），落地时按本文的验证方式逐条升级为 A 级。

## 1. 为什么需要第二层

改动前，「一次任务」= orchestrator 的一次 fleet 执行：一个 `taskId` = 一次 run（多 agent 并行 +
diff + merge）。但一次真实的工作远不止一次 run：

- 一次对话产出一个想法 → 需求；随后有 PRD/spec 草稿、worktree/分支、多轮 DSH/claude/codex 对话、
  被改动的服务清单、可交付产物；
- 同一条需求常常**重试多次** run，或先跑一个 agent 探路再并行两个；
- 这些资产散落在 drafts、Tolaria vault、worktree 注册表、run 日志、topology 各处，**彼此没有绑定**。

因此引入 `WorkItem` 作为跨阶段聚合根，把这些对象以**引用关系**收拢起来，作为看板与所有按任务视图的地基。

## 2. 两级结构：WorkItem ⇄ runs（引用，不是包含）

```
WorkItem（跨阶段聚合根，board 拥有）
  │  runs[]: RunRef{ taskId, startedAt, terminal? }        ← 只存引用
  ▼
orchestrator run（taskId 语义不变，orchestrator 拥有）
  └─ 生命周期落盘于 ~/.helmsman/history/tasks/<taskId>.jsonl（change A）
```

| 关系 | 说明 |
|---|---|
| 一个 WorkItem | 拥有 **0..n** 个 run 引用 |
| 一个 run | 只属于 **1** 个 WorkItem（`runs[]` 里出现一次） |
| run 状态 | board **不复制**，需要时经注入的只读 `RunStatusReader` 向 orchestrator 查询 |

关键点：**`taskId` 语义不变**。旧代码/旧 REST/旧 agent 工具全部照旧；change A 已落盘的 run 时间线
就是 run 状态的唯一真相，board 只是引用它。因此这一层是纯新增，回滚 = 移除 `packages/board` 与
`~/.helmsman/board/` 目录。

## 3. 四阶段与 DoR/DoD

阶段是**有序枚举 + 单步推进**（每次只允许 +1，`allowSkip` 默认 false），拒绝跳级推进并返回缺口清单：

| # | 阶段（内部值） | 展示名 | 进入该阶段的门（DoR） | 离开该阶段的门（DoD） |
|---|---|---|---|---|
| 1 | `requirements` | 需求分析 | 卡片已创建；标题 + 摘要可读 | 需求结论已成型（可关联 PRD/研究草稿） |
| 2 | `spec` | 规格设计 | — | 存在**已定稿** spec/draft（`specFinalized: true`） |
| 3 | `dev` | 开发实施 | 已定稿 spec（缺则拒绝并返回「缺少已定稿 spec」）；已声明或回退开发作用域 `scope.module`；冲突域 WIP 未超限 | 至少一个 run 已 merge（该 run 出现在 `runs[]` 且终态为已合并） |
| 4 | `done` | 验收归档 | 至少一个 run 已 merge，**且**存在对应 merge 审计记录（change C 的 audit JSONL） | 卡片归档 |

- 门数据（如 `specFinalized`）持久在卡片上，由推进方提交；服务侧校验后放行并**写入迁移事件**。
- 可选 `GateProbe` 注入用于外部裁决（如向 orchestrator/audit 查询「是否存在已 merge 且审计在案的 run」）。
  board 不硬依赖 orchestrator/audit：探针未配置时返回「未知」并提示配置，而不是伪造成通过或失败。
- 每次成功推进追加一条**版本化生命周期事件**（from/to/触发者/时间/相关 run 或审批引用）到
  `~/.helmsman/board/events.jsonl`，供审计（change C）消费。

## 4. 关联集：引用 + label 快照

每类关联存 `{ type, refId, label?, at }`：

| type | refId 用谁的自有 id | label 快照 | 内容去哪取 |
|---|---|---|---|
| `doc` | workbench draft id 或 Tolaria note 相对路径 | 标题/文件名 | drafts 目录 / vault |
| `conversation` | DSH `sessionId`（`claude`/`codex` 则为 transcript 路径） | 卡片标题或会话标题 | 会话日志（`~/.dsh` 侧），**卡片不复制正文** |
| `worktree` | worktree 路径 / 分支命名空间 | 分支名 | worktree 注册表 |
| `run` | orchestrator `taskId` | — | change A 的 run 时间线 |
| `service` | topology 里的服务/模块 id | 服务名 | memory-topology（diff 文件 × 模块的**半自动**映射，人工确认） |
| `artifact` | artifact 的 sha256（change D） | 文件名 | `helmsman.artifacts` 注册表 |

为什么是引用而不是副本：

- **避免漂移**——文档/对话内容仍在原位演进，卡片不该存一份会过期的拷贝；
- **可离线存、可校验存在性**——`refId` 是对象自有 id；目标被删除时 resolve 返回「目标不存在」，
  看板显示悬空徽标，卡片本身仍可编辑；
- **label 快照是为了渲染性能**——看板首屏不必为每个引用做一次 IO；点击跳转时才经宿主服务解析真实对象。

关联增删同样追加事件（`associate` / `disassociate`）。可选的 `ExistenceProbe` 会在写入前校验目标存在，
不存在则拒绝（返回明确的「目标不存在」）且不改动关联集。

## 5. 冲突域 WIP：仓库 × 模块，而不是仓库

推进到 `开发实施` 时必须知道「这次改动落在哪」，否则无法判断能不能并行：

- 卡片可声明 `scope.module`（候选来自 spec/关联文档/topology 的自动建议，用户可改）；
- **未声明则回退整仓域**，并在推进时给出提示；
- 冲突域键 = `仓库 × 作用域`：声明了模块用 `repo:module`，否则用 `repo:*`；
- 上限默认 **`module:1`**、整仓回退 **`repo:*:2`**（可配置）；
- **同仓库不同模块互不计数、可并行**——这正是用户明确要求的场景（一个仓库并行跑不同需求/模块）；
- 达到上限的推进被拒绝，并返回**排队原因**（含冲突域键），供任意客户端展示。

真正的风险不是「同一仓库并行」，而是**同一变更面在 merge 阶段冲突**（change A 已把冲突标注做兜底）。
所以取「声明式模块作用域」这个最小粒度：进 dev 时声明一次即可，既表达并行、又不放过同域竞争。
被否决的替代方案：纯 repo 上限（过粗，阻塞无关并行）、运行时按 diff 实际重叠文件动态预测
（精确但需在 run 期间持续扫描，复杂度高）。

## 6. 摘要契约：model / manual / fallback

`summary: { text, generatedBy: 'model' | 'manual' | 'fallback', source?, at }`。

| generatedBy | 何时 | 文本来源 |
|---|---|---|
| `manual` | 用户改写/建档时自带 `summary` | 用户原文（保留最后编辑时间） |
| `model` | 宿主生成成功 | 模型基于该对话最近消息输出的 **2–4 行中文**（去列表符号、裁到 4 行） |
| `fallback` | 模型/生成通道不可用或生成失败 | 该对话最近消息的**前 ~200 字**（含「用户:」「助手:」前缀） |

三条硬约束（host 侧实现见 `packages/ui-workbench/src/intake.ts`）：

1. **生成在宿主，storage 在 board**：board 保持纯数据层、模型无关、可单测；摘要需要 LLM，
   放在已有 agent 通道的宿主最自然。
2. **隔离且 fail-open**：摘要生成跑在与建档不同的调用路径上（`helmsman.generator.summarize`，
   不写草稿、不注册产物、不套人格、90s 上限）；**任何失败都只降级摘要，绝不丢卡**。
3. **摘要不替代原会话**：卡片始终保留 `sessionId` 引用，摘要只是快速浏览入口，可重新生成。

摘要内容属于本机单用户目录（`~/.helmsman/`），与对话同信任边界；文档不承诺对摘要做脱敏。

## 7. 存储布局与恢复

```
~/.helmsman/board/
├── items.json     # 全部卡片（含 schemaVersion），tmp + rename 原子写
└── events.jsonl   # 生命周期事件：create/update/advance/associate/disassociate
```

- **启动**：读 `items.json`；若损坏 → 报显式错误并**保留原文件**（不静默重建），待用户处理。
- **状态以 `items.json` 为准**；`events.jsonl` 供审计/重放（change C），**不做自动回放恢复**，避免幂等复杂度。
- 每行事件含 `{ v, ts, type, payload }`；提供 `queryEvents()` 只读查询。
- 写失败（目录不可写）时报错且不破坏既有文件。
- 单写者假设（loopback 单用户）+ 写前内存态更新序列化；必要时文件锁留待后续。

单文件原子写而非「每卡片一个文件」（目录散乱）或 SQLite（引入依赖）——重启后卡片、阶段、关联与迁移事件完整可读。

## 8. 与 runs / artifacts / audit 的关系

| 邻居 | 关系 | 方向 |
|---|---|---|
| orchestrator run（change A 落盘） | `runs[]` 引用 `taskId`；run 状态只读消费 | board → orchestrator（只读） |
| artifacts（change D） | 卡片用 `artifact` 关联引用产物 id；归档流程把 note 登记为 artifact | board ↔ artifacts（只读引用） |
| audit（change C） | 阶段迁移/关联事件写入 `board/events.jsonl`；`done` 门要求存在 merge 审计记录 | board → audit（门校验查询） |
| worktree | `worktree` 关联记路径/分支 | board → worktree 注册表（只读） |
| memory-topology | `service` 关联的候选来自 topology 的 diff→模块映射 | board → topology（只读） |
| ui-workbench | **建档通道**：对话 → 卡片（读会话 + 生成摘要） | workbench → board |
| ui-board | 看板页面（`/helmsman-board`）：列/阶段/卡片详情，推进经 board 接口 | ui-board → board |

数据不双写：run 状态在 orchestrator，卡片状态在 board，产物字节在 artifacts；任何一边都不复制另一边的正文。

## 9. 宿主建档通道（`@helmsman/ui-workbench`）

「从这段对话建一张卡」在宿主侧实现（task 5.2）：

```
POST /helmsman-workbench/api/task-from-conversation
  { title, sessionId?, repo?, projectGroup?, stage?, summary? }
→ { ok, id, stage, summary, associations, item, context, warnings }

GET  /helmsman-workbench/api/sessions?limit=20
→ { sessions: [{ id, title, createdAt?, live? }], available: boolean }
```

建档顺序（每一步都可降级）：

1. **读来源对话的最近消息**——只用宿主已有缝隙：`ctx.get('sessions')`（活会话 `seq`/`eventAt`，与
   generator 同一通道）优先，其次 `ctx.get('sessionQuery').readSession`（可读已结束会话）；
   读不到 → 空上下文，**不阻塞建档**（只取真人消息，工具结果消息被过滤）。
2. **确定仓库标识**——board 要求 `repoScope.baseRepo` 或 `projectGroup` 至少一个（冲突域 WIP 以
   `仓库 × 模块` 计数）。请求体给了就用；只给 `sessionId` 时回退用该会话的 `cwd` 作 `baseRepo`
   （DSH 会话的工作目录通常就是目标仓库）；都拿不到 → 明确的 400（`invalid repo`），
   而不是让 board 抛内部错误。
3. **生成摘要**——`ctx.get('helmsman.generator').summarize(...)`（本包实现的通道，见 §6）；
   失败 → `fallback`。
4. **`ctx.get('helmsman.board').create(...)`**——带 `title/repoScope/stage/summary`；
   插件未安装 → 返回明确错误「未安装 @helmsman/board 插件」，而不是 `TypeError`。
5. **补齐关联与摘要**——`create` 不接受 `associations`，因此关联由 `associate()` 落库；
   若 board 忽略了 `summary` 再按能力 `setSummary()` 回写（重复引用不重复添加，幂等）；
   回写失败只记 `warnings`（卡片已在）。返回的 `item` 以 board 返回的卡片快照为准。
6. **返回**卡片 id 与阶段，调用方据此打开卡片。

`getRecentSessions` 是给「选择会话」用的门面：缝隙不可用 → `{ sessions: [], available: false }`
（UI 显示提示，而不是报错）；标题尽力而为（`sessionTitle` 快照 → 首条用户消息 → 会话 id）。

**运行时依赖**：`helmsman.board`、`sessionQuery`、`sessionTitle` 全部是**可选**依赖，宿主每次请求用
`ctx.get` 惰性解析（与 `ArtifactRegisterLike` / `KnowledgeLike` 同一约定），未装即降级。

## 10. 借鉴的形状（B 级，来自 DSH-INTEGRATION-NOTES.md）

以下形状取自 DSH-Work-Buddy（MIT）的生产代码，**尚未在本机 Helmsman 验证**，本模型按「可用即用、
缺省降级」接入，落地验证方式写在后：

| 借鉴点 | 本模型的落点 | 验证方式 |
|---|---|---|
| 会话/工作区绑定序列：`prepare-session`（写 per-task `AGENTS.md`/`MEMORY.md`）→ 幂等 `workspace.create({path})` → `session.create({workspaceId})` → 快照 `{sessionId, v:1}` | `conversation` 关联不只存 `sessionId`，还带工作区绑定字段 | 建档时快照写入后重启宿主，卡片仍能解析到同一会话 |
| per-task 目录即 cwd + per-task 记忆（人格与长期记忆分离） | 解释「这个任务当时被怎么指挥的」靠的是关联集，而不是对话正文 | 归档 manifest 与关联集字段对齐后再验证 |
| 归档 manifest 形状 `{taskId, title, startedAt, endedAt, …, files[], conversation[]}` | `artifacts[]` + 归档联动的字段参考 | change D 交付后按 manifest 实读一次 |

边界：只借鉴形状与序列，不引入其代码；其内置 harness（rc.7）与本项目目标版本不在同一条发布线，
不可用于验证（见 `docs/DSH-INTEGRATION-NOTES.md` §C）。
