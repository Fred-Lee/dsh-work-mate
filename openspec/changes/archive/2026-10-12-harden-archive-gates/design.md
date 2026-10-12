# Design — 归档门禁加固

<!-- files: src/config.ts, src/index.ts, src/features/archive/service.ts, src/features/archive/orchestrate.ts, src/features/quality/citations.ts, src/features/proposal/status.ts, src/features/guidance/content.ts -->

调研依据（代码事实，2026-10-10 只读核实）：
- `src/index.ts:662-664`：`force` 是 agent 可见的工具参数。
- `src/features/archive/service.ts:439-441`：`force` 一次跳过三道门。
- `src/features/archive/service.ts:211-266`：`assertApproval` 只按**状态**（`merging`/`archiving`）分离，与门禁是否被 `force` 跳过无关。
- `src/features/archive/orchestrate.ts:46-49`：`forced?: boolean` 声明了却从未赋值（文档与代码不一致）。
- `src/features/quality/review-parser.ts:69,89-94`：reviewer 身份被解析，仅用于影子开关。
- `src/features/archive/orchestrate.ts:424,446`：reviewer 只出现在 step 摘要里。

## D1 `force` 的降权方式：复用 `assertApproval` 的 actor 分离，而不是新增机制

`force` 的语义是"**人类决定跳过审查门**"。所以它不该是 agent 的参数，而该是
"人跨过一道门"的一个特例。实现上不引入新概念：

- `ArchiveOptions.force` 保持不变（面板/API 仍可传）；
- `runArchive` 在 `force===true` 时调用一个新的私有 `assertForceAllowed(options)`：
  - `options.actor !== 'agent'` → 通过（人类/system 编排）；
  - `actor === 'agent'` 且 `deps.allowAgentForceArchive === true` → 通过（显式豁免配置，默认关闭）；
  - 否则抛 `InvalidTransitionError`，并 `recordGateFailure(gate: 'force-archive')` 留痕。
- 通过后无条件 `recordApproval`（`gate: 'force-archive'`），把**被跳过的门清单**写进
  `Proposal.approvals[]`（复用现有结构 `{ gate, actor, decision, rationale?, commit? }`；
  门清单写进 `rationale`，避免改 store 形状）。

**替代方案与取舍**：不采用"从工具 schema 里删掉 force"——`workmate_proposal_archive` 的
`force` 是合法的人工运维入口（面板走同一个 service）。删参数会让面板也没法强制归档。
也不采用"agent 调 force 时要求二次确认"——WorkMate 没有交互式中断点，
拒绝 + 让用户去面板点批准才是这套体系里已有的路径。

## D2 审查者独立性：只能做**身份比对**，不能做"事实判定"

诚实边界（必须先说清）：WorkMate 没有一等 attempt/执行者实体。能做的是：

- **执行者集合**：携带 `[proposal:<id>]` 标记提交的 author 集合（`git log --format=%an|%ae`）
  ∪ 提案的 `swarmTasks[].branch` 的 tip 提交 author（同样来自 git）；
- **审查者身份**：`<!-- reviewer: X -->` 的自报字符串；
- **判定**：
  - `reviewer` 缺失 + 非影子 → `verdict: 'missing'`；
  - `reviewer` 命中执行者集合（大小写不敏感的子串/等值匹配）→ `verdict: 'same-as-author'`；
  - 两者都能取到且不命中 → `verdict: 'independent'`；
  - git 不可用 / 无提交 → `verdict: 'undetermined'`。

`Config.reviewerIndependence` 的档位语义：

| 档位 | `missing` / `same-as-author` | `undetermined` |
| --- | --- | --- |
| `off` | 不检查 | 不检查 |
| `warn`（默认） | 记 `warn` step，不阻断 | 记 `warn` step，不阻断 |
| `block` | `failed` step，阻断归档 | **只记 `warn`**（无法判定不等于有罪，宁可放过不冤杀） |

这是**刻意的非对称**：`block` 只对"能确证"的情形生效。若要把 `undetermined` 也阻断，
前提是先引入执行者身份实体（另开提案）。

## D3 审查证据引用校验：机器只验"引用可解析且文件存在"

新模块 `src/features/quality/citations.ts`，纯函数 + 一个文件系统探针：

- 抽取行内引用：`` `path/to/file.ts:123` ``、`` `path/to/file.ts:12-30` ``、`path#L42`、
  `path/to/file.ts`（无行号也算引用，校验存在性）；只解析反引号包裹的 token，避免把
  自然语言里的斜杠当路径；
- 每个引用的判定：`ok`（存在 + 行号在范围内）/ `file-missing` / `line-out-of-range` / `unparsable-line`；
- 探针只在**归档时**运行（不是每次 status），因为要读盘；
- `Config.reviewEvidenceGate`：`off` 不跑；`warn`（默认）记 step；`block` 在
  存在 `file-missing` 时阻断（行号越界只 warn——文件演进很快，越界常是陈旧而非造假）；
- GitNexus 类结论（含 `impact(`/`context(`/`query(`/`gitnexus` 字样的条目）**跳过机器校验**，
  在 step 摘要里报 `not-machine-checkable` 计数。**不假装能验**。

## D4 把 `forced` 补齐：让"跳过门禁归档"这件事在状态里可见

- `orchestrateArchive` 在 `options.reviewGate === false || options.tasksGate === false`
  时返回 `forced: true`（与类型注释一致）；
- `runArchive` 成功后把 `forced` 一并返回；
- `proposal.status` 暴露 `forcedArchive`：从**事件流**里查最近一条 `approval(gate:'force-archive')`
  （不新增存储字段），保证"谁跳的、跳了哪些门"可从既有工件回答。

## D5 默认值取舍

| 键 | 默认 | 理由 |
| --- | --- | --- |
| `allowAgentForceArchive` | `false` | 行为收紧是本次目的；豁免开关存在即可 |
| `reviewerIndependence` | `warn` | 现有提案的 review.md 未必带 reviewer 头，默认 block 会立刻卡死既有流程 |
| `reviewEvidenceGate` | `warn` | 同上：先让引用问题显形，再按项目升为 block |
| `planDriftGate` | 保持 `false` | 只补文档与配置指引，不改默认行为 |

## 风险与回滚

- 风险 1：`force` 对 agent 关闭后，某些自动化流程会失败。缓解：错误文案直接给面板路径
  与 `allowAgentForceArchive` 开关；事件流留 `gate-failed(force-archive)`。
- 风险 2：引用校验误判（比如引用的是生成物目录、被 gitignore 的路径）。缓解：默认 `warn`；
  `block` 只对 `file-missing` 生效；引用解析只认反引号 token。
- 回滚：把两个新门设回 `off`、`allowAgentForceArchive` 设 `true`，行为即回到今天。
