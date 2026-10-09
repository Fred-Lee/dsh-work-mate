# 归档门禁加固：force 降权 + 审查者独立身份 + 审查证据可核

## Why

来源：对 dsh-graph（github.com/miuzel/dsh-graph）的调研与代码核实（2026-10-10）。
它的真本事是「图存储 + 状态机硬门 + 独立评审归因 + 测试自证闸门」，而 WorkMate 在
对应位置存在三个**已被代码证实**的洞——这三个洞属于同一类：**门禁靠"约定"而不是靠代码**。

1. **`force` 是一条无审批、无留痕的后门**
   - `workmate_proposal_archive` 的 `force` 参数直接暴露给 agent（`src/index.ts:662-664`）；
   - `force=true` 同时跳过 reviewGate / tasksGate / planDriftGate（`src/features/archive/service.ts:439-441`）；
   - 后果只写进 step 摘要 `disabled by force`（`src/features/archive/orchestrate.ts:452`），
     不写 `approval`、不走「写码者不得批准」门（`assertApproval` 只管**状态**，不管**门**）。
   - 对照组：dsh-graph 的 `ctx.force` 同样能整块跳过判据门（`core/machine.ts:80` + HTTP 无条件透传）
     ——两边的洞是同一形态，本次修我们自己的。

2. **审查报告是自报，身份不参与归档门**
   - `<!-- reviewer: auditor@1.2 shadow -->` 被解析（`src/features/quality/review-parser.ts:69`），
     但用途只有影子模式开关与展示（`src/features/archive/orchestrate.ts:424-447`）；
   - 归档门**不检查** reviewer 是否独立于执行者。dsh-graph 在这一点上是代码强制的
     （reviewer 被裁掉 accept/force/delivered，空输出不记 PASS）。

3. **审查证据不可核**
   - `review.md` 模板要求确认项引用 `file:line` / GitNexus 查询结论，
     但没有解析器验证引用格式与文件存在性；
   - 于是"确认项"可以是模型凭印象写的，归档门照样放行。

另有一项「能力已有、只差打开」：`planDriftGate`（`src/config.ts:190`）默认关闭，本机 profile 未启用。

## 来源 / Provenance

- source: `review-finding`
- sourceRef: `https://github.com/miuzel/dsh-graph`

### intent 形状

- **Problem**：三个归档门禁的强制执行点都有"合法绕行"或"缺校验"：`force` 可由 agent 直呼且无审批留痕；
  审查者身份只用于展示；审查证据无机器校验。
- **Proposed outcome**：`force` 回归"人类的显式决策"（agent 无权，人类执行必留痕且状态可见）；
  审查者身份成为归档门的输入（`off|warn|block` 可配）；审查证据引用可机检（`off|warn|block` 可配）。
- **Affected users and systems**：agent 的 `workmate_proposal_archive` 工具行为（`force` 对 agent 失效）；
  WorkMate 面板/API 的人工归档路径（可继续 `force`，但留痕）；`proposal.status` 投影新增字段。
- **Constraints**：不重启 harness（只构建与测试）；不改变八态生命周期语义；不新增运行时依赖；
  向后兼容——现有 `Config` 不写新键时行为与今天一致（两个新门默认 `warn`）；`force` 对 agent 关闭是
  **行为收紧**，需在文档/技能说明中显式写出，并提供 `allowAgentForceArchive` 一次性豁免开关
  （与既有 `allowAgentApproval` 同一风格）。
- **Open questions**：审查者身份与"执行者集合"的比对在缺少 attempt 实体时只能做身份推断
  （见 design D2 的诚实边界）；是否需要引入一等 attempt 身份实体，另开提案评估。

## What Changes

- **`Config.allowAgentForceArchive`（默认 `false`）**：agent actor 调 `force=true` 被拒；
  人类/面板路径不受限，但每次 `force` 归档必写一条 `approval` 事件（`gate: 'force-archive'`，
  记下被跳过的门清单与理由）。
- **`OrchestrationResult.forced` 真正赋值**：类型里早有该字段（`orchestrate.ts:46-49` 注释声称
  "Reported so '编排自报失败' 和 '归档已完成' 不能静默矛盾"），但代码从未写入——补齐，
  并让 `workmate_proposal_status` 暴露 `forcedArchive`。
- **`Config.reviewerIndependence`（`off | warn | block`，默认 `warn`）**：归档门的审查检查新增
  "审查者身份"子判定——非影子模式下 `reviewer` 必须存在；与"执行者集合"（携带
  `[proposal:<id>]` 提交的 author 集合）比对；**确认同一身份**在 `block` 下阻断，
  **无法判定**在任何模式下只记 `warn`（诚实边界，见 design D2）。
- **`Config.reviewEvidenceGate`（`off | warn | block`，默认 `warn`）+ 新模块 `src/features/quality/citations.ts`**：
  解析 review.md 里的 `file:line` / `path#Lnn` 引用，校验路径存在（相对项目根）且行号在范围内；
  GitNexus 查询类结论**不做机器校验**，只标注 `not-machine-checkable`（不假装能验）。
- **文档与配置指引**：`planDriftGate` 的开启方式写进 `AGENTS.md` 与流程 skill；
  `force` 语义变化写进 `PROPOSAL_FLOW_SKILL` 与 README。

## Impact

- 影响文件：`src/config.ts`、`src/index.ts`（工具 schema 与接线）、`src/features/archive/service.ts`、
  `src/features/archive/orchestrate.ts`、`src/features/quality/*`、`src/features/proposal/status.ts`、
  `src/features/guidance/content.ts`、`AGENTS.md`、`README.md`。
- 规格：新增 capability `archive-gates`（见 `specs/`）。
- 兼容性：**行为收紧一处**——agent 不能再自行 `force` 归档；需要人工归档时由用户在面板批准
  （路径已存在）。两个新门默认 `warn`，不改变既有归档放行结果。
- 范围外（明确不做）：不做 PK 多路 attempt（dsh-graph 自己 host 侧 `lanes` 零命中，是空壳，
  且与 swarm 语义重叠）；不把 `proposals.json` 从聚合真源改成事件派生
  （事件先行倒置审计未完成，风险收益比不划算，另开提案）。
